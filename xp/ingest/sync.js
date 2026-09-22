// Ingestion engine. Rules (see PLAN §2.1):
//  * every number stored is an ABSOLUTE value observed on a date; deltas are derived in SQL
//  * `raw` is kept on every snapshot row
//  * rows that are already final are filtered out BEFORE writing, so the immutability trigger never fires
//  * a sync_runs row is written per asset; per-step errors are recorded, the run continues
const { DateTime } = require('luxon');
const cfg = require('../config');
const { supabase, q, upsertChunked } = require('../db');
const T = require('../time');
const { GraphClient, GraphError, insightsToMap } = require('../meta/graph');
const { FB, IG, breakdownToMap, ACCOUNT_VALUE_COLS } = require('../meta/metrics');
const { tokenForAsset, upgradeToPageToken } = require('../meta/discovery');

const nowIso = () => new Date().toISOString();
const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };

// ---------------------------------------------------------------- system_config overrides
async function loadSettings() {
  const sc = await q(supabase.from('xp_system_config').select('*').eq('id', 1).maybeSingle(), 'xp_system_config').catch(() => null);
  return {
    version: sc?.meta_api_version || cfg.meta.defaultApiVersion,
    batchSize: sc?.batch_size || cfg.sync.batchSize,
    delayMs: sc?.request_delay_ms ?? cfg.sync.requestDelayMs,
    accountBackfillDays: sc?.account_backfill_days || cfg.sync.accountBackfillDays,
    demographicsEveryDays: sc?.demographics_every_days || cfg.sync.demographicsEveryDays,
    // 0010. The longest a day may stay open before it is locked and labelled. The sync needs it
    // for one reason: every open day must be re-read often enough to collect a second reading,
    // or it reaches the ceiling as 'unobserved' and the lock rests on nothing.
    settleCeilingDays: sc?.settle_ceiling_days ?? 14
  };
}

// ---------------------------------------------------------------- metric catalog bookkeeping
async function recordCatalog(platform, level, live = [], dead = []) {
  const ts = nowIso();
  for (const m of live) {
    await q(supabase.from('xp_metric_catalog').upsert({ platform, level, metric_name: m, is_active: true, is_verified: true, last_verified_at: ts, deprecated_note: null }, { onConflict: 'platform,level,metric_name', ignoreDuplicates: false }), 'catalog live').catch(() => {});
  }
  for (const d of dead) {
    await q(supabase.from('xp_metric_catalog').upsert({ platform, level, metric_name: d.metric, is_active: false, is_verified: true, last_verified_at: ts, deprecated_note: String(d.error).slice(0, 300) }, { onConflict: 'platform,level,metric_name', ignoreDuplicates: false }), 'catalog dead').catch(() => {});
  }
}

// ---------------------------------------------------------------- run context
class Run {
  constructor({ client, asset, runType, triggeredBy, rangeStart, rangeEnd }) {
    Object.assign(this, { client, asset, runType, triggeredBy, rangeStart, rangeEnd, posts_seen: 0, snapshots_written: 0, errors: [], id: null, g: null });
  }
  async start() {
    const r = await q(supabase.from('xp_sync_runs').insert({ client_id: this.client.id, asset_id: this.asset.id, run_type: this.runType, range_start: this.rangeStart || null, range_end: this.rangeEnd || null, triggered_by: this.triggeredBy, status: 'RUNNING' }).select('id').single(), 'xp_sync_runs');
    this.id = r.id;
  }
  err(step, e) {
    const message = e?.message || String(e);
    // One systemic failure (missing scope, deleted page) yields an identical error per post and per
    // comment thread — dozens of lines that bury the single real cause and bloat sync_runs.errors.
    // Collapse duplicates into a count, and hard-cap the array.
    const same = this.errors.find((x) => x.step === step && x.message === message);
    if (same) { same.count = (same.count || 1) + 1; same.last_at = nowIso(); return; }
    if (this.errors.length >= 40) { this.truncated = (this.truncated || 0) + 1; return; }
    const item = { step, message, code: e?.code, subcode: e?.subcode, at: nowIso() };
    if (e?.hint) item.hint = e.hint;
    if (e?.tried) item.tried = e.tried;                     // token-resolution trace (see discovery.resolveAssetToken)
    this.errors.push(item);
    console.error(`[sync ${this.asset.platform} ${this.asset.name}] ${step}: ${message}`);
  }
  async finish(fatal) {
    const status = fatal ? 'FAILED' : this.errors.length ? 'PARTIAL' : 'OK';
    const errors = this.truncated ? [...this.errors, { step: 'truncated', message: `${this.truncated} further error(s) suppressed.` }] : this.errors;
    await q(supabase.from('xp_sync_runs').update({ status, posts_seen: this.posts_seen, snapshots_written: this.snapshots_written, api_calls: this.g?.calls || 0, errors, finished_at: nowIso() }).eq('id', this.id), 'sync_runs upd').catch(() => {});
    return status;
  }
}

// ---------------------------------------------------------------- helpers: final-row filtering
// Scoped to the dates actually being written. The unscoped version pulled every finalized row
// for the asset on every nightly run — 600 posts × 365 days by next spring, for a filter that on
// a LIVE run cannot match anything, because today is never final.
async function finalKeys(table, assetId, keyCols, { dateCol, dates } = {}) {
  let sel = supabase.from(table).select(keyCols.join(',')).eq('asset_id', assetId).eq('is_final', true);
  if (dateCol && dates && dates.length) sel = sel.in(dateCol, [...new Set(dates)]);
  const rows = await q(sel, `${table} finals`);
  return new Set(rows.map((r) => keyCols.map((k) => r[k]).join('|')));
}

// Everything already observed for this asset in the window, per date.
//
// An upsert sends a fixed key set, so a day on which Meta returns nothing for a metric would
// otherwise overwrite a previously observed value with null. That is not hypothetical:
// `follower_count` is only served for the last 30 days, so re-syncing an older open day used to
// erase the gain a previous run had recorded.
//
// The rule is "never replace a known value with an unknown one", and it applies to EVERY value
// column, on every day including today. Carry-forward only ever fills a null — a freshly
// observed number always wins — so it cannot freeze a stale reading in place. It is also what
// makes repeated syncs byte-identical, which idempotency.js checks.
async function existingAccountRows(assetId, start, end) {
  const rows = await q(
    supabase.from('xp_account_metric_snapshots')
      .select(['metric_date', ...ACCOUNT_VALUE_COLS].join(','))
      .eq('asset_id', assetId).gte('metric_date', start).lte('metric_date', end),
    'existing account rows'
  );
  return new Map(rows.map((r) => [String(r.metric_date), r]));
}

// ---------------------------------------------------------------- the follower anchor day
// Meta serves no historical follower total. The only observable total is the profile counter,
// read right now — so the single question that matters is: WHICH DAY does that reading describe?
//
// It describes the insights day that is currently in progress, in the platform's own insights
// timezone (UTC for IG, America/Los_Angeles for FB) — NOT the client's local date. Labelling a
// 00:10 UTC reading as the Dhaka date (already a new day, six hours ahead) attributed it to a UTC
// day that had not started yet, and 0007 then froze that misalignment permanently.
//
// If the sync runs in the first few hours of an insights day, the reading still effectively
// belongs to the day that just closed: nothing has happened yet in the new one, and the day that
// ended is the one an anchor is useful for. `graceHours` is that window.
function anchorDateFor(insightsTz, graceHours = cfg.sync.anchorGraceHours, now = DateTime.now()) {
  const t = now.setZone(insightsTz);
  return (t.hour < graceHours ? t.minus({ days: 1 }) : t).toISODate();
}

// ================================================================ ASSET SYNC
async function syncAsset(client, asset, opts, settings) {
  const run = new Run({ client, asset, runType: opts.runType || 'MANUAL', triggeredBy: opts.triggeredBy || 'system', rangeStart: opts.rangeStart, rangeEnd: opts.rangeEnd });
  await run.start();
  const tz = client.timezone || 'Asia/Dhaka';
  const today = T.todayIn(tz);
  const isIG = asset.platform === 'IG';
  const fullBackfill = !!opts.fullBackfill || !asset.last_full_backfill_at;
  let fatal = null;

  try {
    let token;
    try { token = await tokenForAsset(asset); }
    catch (e) {
      // A token problem is never transient — do not let it look like a Meta outage in the run log.
      e.hint = 'Admin → Reconnect this client (Meta OAuth), or use “Repair token” on this asset.';
      throw e;
    }
    run.g = new GraphClient({ token, version: settings.version, delayMs: settings.delayMs, batchSize: settings.batchSize });
    const g = run.g;
    const ctx = { run, g, client, asset, tz, today, isIG, fullBackfill, settings, opts };

    // Preflight. If the object itself cannot be read, every later step fails identically and
    // floods the run log with dozens of copies of the same error (one per post, per comment thread).
    // Fail once, loudly, with the actual remedy.
    let profile = await step(ctx, 'profile', syncProfile);

    // Self-repair: the most common cause of a failed IG preflight is that the resolved token is a
    // USER token, which cannot read an IG account even when it can read the Page. Ask Meta for the
    // Page's own token, cache it, and try once more before declaring the asset broken.
    if (profile === null) {
      const upgraded = await upgradeToPageToken(asset, token).catch(() => null);
      if (upgraded) {
        run.g = new GraphClient({ token: upgraded, version: settings.version, delayMs: settings.delayMs, batchSize: settings.batchSize });
        ctx.g = run.g;
        run.errors = [];                            // the first failure was ours to fix, not the operator's
        profile = await step(ctx, 'profile', syncProfile);
      }
    }

    if (profile === null) {
      const e = new Error(
        `${asset.platform} object ${asset.asset_id} could not be read with the token this asset resolves to. ` +
        (isIG
          ? `Instagram data is served through the linked Facebook Page token, and that token must carry ` +
            `instagram_basic and instagram_manage_insights. A token granted before those scopes were requested ` +
            `returns "does not exist, cannot be loaded due to missing permissions" for a valid IG account ID. ` +
            `Fix: admin → Reconnect this client and accept every permission in the Meta dialog.`
          : `Fix: admin → Reconnect this client, or check that the page still exists and the user still has a role on it.`)
      );
      e.hint = 'Reconnect via Meta OAuth with the full scope list.';
      e.preflight = true;
      throw e;                                   // caught below → run marked FAILED, remaining steps skipped
    }
    // The object reads again (re-granted through another login, repaired token, …). Say so: an asset left
    // EXPIRED keeps a red badge in the admin and drops out of v_sync_health while it syncs fine.
    if (asset.status === 'EXPIRED') {
      await q(supabase.from('xp_meta_assets').update({ status: 'ACTIVE' }).eq('id', asset.id), 'revive asset').catch(() => {});
    }

    await step(ctx, 'posts', (c) => syncPosts(c, profile));
    await step(ctx, 'post_snapshots', syncPostSnapshots);
    if (isIG) await step(ctx, 'stories', syncStories);
    const accountOk = (await step(ctx, 'account_metrics', (c) => syncAccountMetrics(c, profile))) !== null;
    await step(ctx, 'audience', syncAudience);
    if (cfg.sync.commentsEnabled) await step(ctx, 'comments', syncComments);

    const upd = { last_synced_at: nowIso(), first_synced_at: asset.first_synced_at || nowIso() };
    // A full backfill counts as done only if the account metrics came back. On 18 Sep two first syncs
    // that wrote nothing (bad client timezone) still stamped this, so the missing history looked fetched.
    if (fullBackfill && accountOk) upd.last_full_backfill_at = nowIso();
    await q(supabase.from('xp_meta_assets').update(upd).eq('id', asset.id), 'asset upd');
  } catch (e) {
    fatal = e;
    run.err('fatal', e);
    if ((e instanceof GraphError && e.isAuth) || e.isTokenResolution)
      await q(supabase.from('xp_meta_assets').update({ status: 'EXPIRED' }).eq('id', asset.id), 'expire').catch(() => {});
  }
  const status = await run.finish(fatal);
  return { asset_id: asset.id, platform: asset.platform, name: asset.name, status, posts_seen: run.posts_seen, snapshots_written: run.snapshots_written, api_calls: run.g?.calls || 0, errors: run.errors };
}

async function step(ctx, name, fn) {
  try { return await fn(ctx); }
  catch (e) {
    ctx.run.err(name, e);
    // Only a dead token ends the asset's run. Codes 10 and 200 ("permission") are also what Meta
    // answers for a single unreadable story or post while the token is fine; treating them as fatal
    // skipped the account metrics that come later and marked a healthy asset EXPIRED.
    if (e instanceof GraphError && (e.code === 190 || e.code === 102)) throw e;
    return null;
  }
}

// ---------------------------------------------------------------- 1. profile
async function syncProfile({ g, asset, isIG }) {
  const p = await g.get(asset.asset_id, { fields: isIG ? IG.ACCOUNT_FIELDS : FB.PAGE_FIELDS.replace(/,instagram_business_account\{[^}]*\}/, '') });
  const profile = isIG
    ? { biography: p.biography, website: p.website, picture: p.profile_picture_url, followers_count: p.followers_count, follows_count: p.follows_count, media_count: p.media_count }
    : { about: p.about, website: p.website, link: p.link, picture: p.picture?.data?.url, followers_count: p.followers_count, fan_count: p.fan_count, is_verified: p.is_verified, verification_status: p.verification_status };
  await q(supabase.from('xp_meta_assets').update({ name: p.name || p.username || asset.name, username: p.username || asset.username, category: p.category || asset.category, profile: { ...(asset.profile || {}), ...profile, refreshed_at: nowIso() } }).eq('id', asset.id), 'profile');
  return { ...p, ...profile };
}

// ---------------------------------------------------------------- 2. posts (metadata)
function fbPostRow(ctx, p) {
  const att = p.attachments?.data?.[0];
  return {
    client_id: ctx.client.id, asset_id: ctx.asset.id, platform: 'FB', meta_post_id: p.id,
    media_type: att?.media_type || att?.type || p.status_type || null, media_product_type: p.status_type || null,
    caption: p.message || p.story || null, permalink: p.permalink_url || null,
    media_url: att?.media?.image?.src || p.full_picture || null, thumbnail_url: p.full_picture || null,
    publish_date: p.created_time, is_story: false, raw: p, last_seen_at: nowIso()
  };
}
function igMediaRow(ctx, m, { story = false } = {}) {
  return {
    client_id: ctx.client.id, asset_id: ctx.asset.id, platform: 'IG', meta_post_id: m.id,
    media_type: m.media_type || null, media_product_type: story ? 'STORY' : (m.media_product_type || 'FEED'),
    caption: m.caption || null, permalink: m.permalink || null, media_url: m.media_url || null, thumbnail_url: m.thumbnail_url || m.media_url || null,
    publish_date: m.timestamp, is_story: story, story_expires_at: story ? DateTime.fromISO(m.timestamp).plus({ hours: 24 }).toISO() : null,
    raw: m, last_seen_at: nowIso()
  };
}

async function syncPosts(ctx) {
  const { g, asset, isIG, fullBackfill, run, opts } = ctx;
  // window: full listing on backfill; otherwise recent posts only (new posts + edits), plus the requested range
  let since = null;
  if (!fullBackfill) {
    const s = opts.rangeStart || DateTime.fromISO(asset.last_synced_at || T.daysAgo(30, ctx.tz)).minus({ days: 7 }).toISODate();
    since = T.dayStartUnix(s, 'UTC');
  }
  const items = isIG
    ? await g.paginate(`${asset.asset_id}/media`, { fields: IG.MEDIA_FIELDS, ...(since ? { since } : {}) }, { maxPages: fullBackfill ? 500 : 20 })
    : await g.paginate(`${asset.asset_id}/${FB.POST_EDGE}`, { fields: FB.POST_FIELDS, ...(since ? { since } : {}) }, { maxPages: fullBackfill ? 500 : 20 });
  const rows = items.filter((x) => x.id && (x.timestamp || x.created_time)).map((x) => (isIG ? igMediaRow(ctx, x) : fbPostRow(ctx, x)));
  run.posts_seen += rows.length;
  if (rows.length) await upsertChunked('xp_meta_posts', rows, 'asset_id,meta_post_id');
  ctx.seenPostIds = new Set(rows.map((r) => r.meta_post_id));

  // deleted-post detection: anything in DB inside the listed window that the API no longer returns
  const lower = since ? new Date(since * 1000).toISOString() : null;
  let qq = supabase.from('xp_meta_posts').select('meta_post_id').eq('asset_id', asset.id).eq('is_deleted', false).eq('is_story', false);
  if (lower) qq = qq.gte('publish_date', lower);
  const known = await q(qq, 'known posts');
  const gone = known.map((k) => k.meta_post_id).filter((id) => !ctx.seenPostIds.has(id));
  // Guards against destroying history from a bad listing:
  //  * an empty listing proves nothing (throttle, permission loss, wrong `since`) — never delete from it
  //  * outside a full backfill, refuse to delete more than half the known window
  const trustworthy = rows.length > 0 && (fullBackfill || gone.length < Math.max(5, known.length * 0.5));
  if (gone.length && trustworthy) {
    for (const ids of chunk(gone, 200)) await q(supabase.from('xp_meta_posts').update({ is_deleted: true, deleted_detected_at: nowIso() }).eq('asset_id', asset.id).in('meta_post_id', ids), 'mark deleted');
    ctx.deleted = gone.length;
  } else if (gone.length) {
    ctx.deletion_skipped = gone.length;
    run.err('deleted_posts', new Error(`${gone.length} known post(s) were absent from the listing but deletion was NOT recorded (listing returned ${rows.length} item(s)). Run a full backfill to confirm.`));
  }
}

// ---------------------------------------------------------------- 3. post snapshots (absolute lifetime counters, one row per post per day)
async function syncPostSnapshots(ctx) {
  const { g, asset, isIG, today, run, opts, fullBackfill } = ctx;
  const activeSince = T.daysAgo(cfg.sync.postActiveWindowDays, ctx.tz);
  let sel = supabase.from('xp_v_posts_with_latest').select('meta_post_id,media_type,media_product_type,publish_date,latest_snapshot_date').eq('asset_id', asset.id).eq('is_deleted', false).eq('is_story', false);
  if (opts.rangeStart && opts.rangeEnd && !fullBackfill) sel = sel.gte('publish_date', opts.rangeStart).lte('publish_date', opts.rangeEnd + 'T23:59:59Z');
  const posts = await q(sel.order('publish_date', { ascending: false }).limit(5000), 'posts for snapshot');

  const due = posts.filter((p) => {
    if (fullBackfill || opts.rangeStart) return true;
    if (p.latest_snapshot_date === today) return false;                                  // already read today
    if (p.publish_date >= activeSince) return true;                                      // recent: daily
    if (!p.latest_snapshot_date) return true;
    return DateTime.fromISO(today).diff(DateTime.fromISO(p.latest_snapshot_date), 'days').days >= cfg.sync.postColdRefreshEvery;
  });
  if (!due.length) return;

  // Probe the live metric set once per (level) using the first post of that kind → records dead metrics
  const liveSets = {};
  async function liveFor(kind, sampleId) {
    if (liveSets[kind]) return liveSets[kind];
    const want = isIG ? (kind === 'REEL' ? [...IG.MEDIA_LIFETIME, ...IG.REEL_EXTRA] : IG.MEDIA_LIFETIME) : FB.POST_LIFETIME;
    const r = await g.insightsResilient(sampleId, want);
    await recordCatalog(asset.platform, kind === 'REEL' ? 'REEL' : 'POST', r.live, r.dead);
    liveSets[kind] = r.live;
    return r.live;
  }
  const kindOf = (p) => (isIG && (p.media_product_type === 'REELS' || p.media_type === 'VIDEO' && p.media_product_type !== 'FEED') ? 'REEL' : 'POST');
  for (const k of new Set(due.map(kindOf))) { const sample = due.find((p) => kindOf(p) === k); try { await liveFor(k, sample.meta_post_id); } catch (e) { run.err(`probe ${k}`, e); liveSets[k] = []; } }

  // Batch: insights + object counters
  const reqs = [];
  for (const p of due) {
    const live = liveSets[kindOf(p)] || [];
    if (live.length) reqs.push({ key: `i:${p.meta_post_id}`, relative_url: `${p.meta_post_id}/insights?metric=${live.join(',')}` });
    reqs.push({ key: `o:${p.meta_post_id}`, relative_url: isIG ? `${p.meta_post_id}?fields=like_count,comments_count` : `${p.meta_post_id}?fields=shares,comments.summary(true).limit(0),reactions.summary(true).limit(0),likes.summary(true).limit(0)` });
  }
  const res = await g.batch(reqs);

  const rows = [];
  for (const p of due) {
    const ins = res.get(`i:${p.meta_post_id}`), obj = res.get(`o:${p.meta_post_id}`);
    if (ins && !ins.ok && !(ins.error?.isMetric)) { run.err(`insights ${p.meta_post_id}`, ins.error); }
    let data = ins?.ok ? ins.body?.data || [] : [];
    if (ins && !ins.ok && ins.error?.isMetric) {   // this specific post rejects the set (e.g. old media) → resilient per-post
      try { data = (await g.insightsResilient(p.meta_post_id, liveSets[kindOf(p)] || [])).data; } catch (e) { run.err(`insights ${p.meta_post_id}`, e); }
    }
    const { flat } = insightsToMap(data);
    const o = obj?.ok ? obj.body : {};
    const mapped = isIG ? IG.mapMedia(flat, o) : FB.mapPost(flat, o);
    if (Object.values(mapped).every((v) => v === null || v === undefined)) continue;   // nothing observed → no row
    rows.push({ client_id: ctx.client.id, asset_id: asset.id, meta_post_id: p.meta_post_id, platform: asset.platform, snapshot_date: today,
      ...mapped, raw: { insights: data, object: o }, source: opts.rangeStart ? 'BACKFILL' : 'LIVE', collected_at: nowIso() });
  }
  // Every row written here carries snapshot_date = today, so only today can collide. Today is
  // never final under any finalization lag; the check stays as a belt-and-braces guard, but it is
  // now one indexed lookup instead of a scan of the asset's entire history.
  const finals = await finalKeys('xp_post_metric_snapshots', asset.id, ['meta_post_id', 'snapshot_date'], { dateCol: 'snapshot_date', dates: [today] });
  const writable = rows.filter((r) => !finals.has(`${r.meta_post_id}|${r.snapshot_date}`));
  if (writable.length) run.snapshots_written += await upsertChunked('xp_post_metric_snapshots', writable, 'asset_id,meta_post_id,snapshot_date', 200);
}

// ---------------------------------------------------------------- 4. IG stories (24h — capture every run)
async function syncStories(ctx) {
  const { g, asset, today, run } = ctx;
  const stories = await g.paginate(`${asset.asset_id}/stories`, { fields: IG.STORY_FIELDS }, { maxPages: 5 });
  if (!stories.length) return;
  const rows = stories.map((s) => igMediaRow(ctx, s, { story: true }));
  await upsertChunked('xp_meta_posts', rows, 'asset_id,meta_post_id');
  run.posts_seen += rows.length;
  const probe = await g.insightsResilient(stories[0].id, IG.STORY_LIFETIME);
  await recordCatalog('IG', 'STORY', probe.live, probe.dead);
  if (!probe.live.length) return;
  const res = await g.batch(stories.map((s) => ({ key: s.id, relative_url: `${s.id}/insights?metric=${probe.live.join(',')}` })));
  const out = [];
  for (const s of stories) {
    const r = res.get(s.id); if (!r?.ok) { if (r?.error && !r.error.isMetric) run.err(`story ${s.id}`, r.error); continue; }
    const { flat } = insightsToMap(r.body?.data || []);
    out.push({ client_id: ctx.client.id, asset_id: asset.id, meta_post_id: s.id, platform: 'IG', snapshot_date: today, ...IG.mapStory(flat), raw: { insights: r.body?.data }, source: 'LIVE', collected_at: nowIso() });
  }
  if (out.length) run.snapshots_written += await upsertChunked('xp_post_metric_snapshots', out, 'asset_id,meta_post_id,snapshot_date', 200);
}

// ---------------------------------------------------------------- 5. account metrics (per day, absolute, timezone-correct)
async function syncAccountMetrics(ctx, profile) {
  const { g, asset, isIG, tz, today, run, opts, fullBackfill, settings } = ctx;
  const itz = asset.insights_timezone || (isIG ? T.IG_INSIGHTS_TZ : T.FB_INSIGHTS_TZ);
  let start = opts.rangeStart, end = opts.rangeEnd || today;
  // The lookback must reach at least as far back as the oldest day that can still be open,
  // otherwise a day stops being re-read while it is still waiting for a second reading and
  // hits the ceiling as 'unobserved'. Three days was right under a two-day timer; it is not
  // right under evidence-based locking.
  if (!start) start = fullBackfill
    ? T.daysAgo(settings.accountBackfillDays, tz)
    : T.daysAgo(Math.max(cfg.sync.lookbackDays, settings.settleCeilingDays + 1), tz);
  if (end > today) end = today;
  const days = new Map();   // metric_date -> { flat metrics }
  const put = (d, k, v) => { if (!d) return; const cur = days.get(d) || {}; if (v !== undefined) cur[k] = v; days.set(d, cur); };

  if (!isIG) {
    // FB: period=day time series, ≤ 93 days per call
    const probe = await g.insightsResilient(asset.asset_id, FB.ACCOUNT_DAY, { period: 'day', since: T.dayStartUnix(start, itz), until: T.dayEndUnix(end, itz) + 1 });
    await recordCatalog('FB', 'ACCOUNT', probe.live, probe.dead);
    const windows = T.chunkRange(start, end, 90);
    for (const [ws, we] of windows) {
      const data = (ws === windows[0][0] && we === windows[0][1]) ? probe.data
        : (await g.get(`${asset.asset_id}/insights`, { metric: probe.live.join(','), period: 'day', since: T.dayStartUnix(ws, itz), until: T.dayEndUnix(we, itz) + 1 })).data || [];
      for (const it of data) for (const v of it.values || []) put(T.dateFromEndTime(v.end_time, itz), it.name, v.value);
    }
    // Organic/paid. The unique-reach split (page_impressions_organic_unique / _paid_unique) no longer
    // exists in the API. What Meta offers instead is page_media_view with breakdown=is_from_ads —
    // an IMPRESSIONS split, not a reach split.
    //
    // Shape, seen 2026-09-14 (scripts/probe-ads-split.js): ONE series, and each end_time appears
    // TWICE in values[] — once with is_from_ads: "0" (organic) and once with "1" (paid), the label
    // sitting on the value entry itself, not on the series. v2.5 kept only v.value, so the second
    // entry overwrote the first and a bare paid number was stored. Now the two are kept per day as
    // { "0": organic, "1": paid }; FB.mapAccountDay → parseAdsSplit turns that into
    // impressions_organic / impressions_paid. They sum to page_media_view (1091 + 627 = 1718).
    // Guarded: an unsupported breakdown must never fail the run.
    if (probe.live.includes('page_media_view')) {
      try {
        const r = await g.get(`${asset.asset_id}/insights`, { metric: 'page_media_view', period: 'day', breakdown: 'is_from_ads', since: T.dayStartUnix(start, itz), until: T.dayEndUnix(end, itz) + 1 });
        for (const it of r.data || []) for (const v of it.values || []) {
          const d = T.dateFromEndTime(v.end_time, itz);
          const bucket = v.is_from_ads !== undefined && v.is_from_ads !== null ? String(v.is_from_ads) : 'unlabelled';
          const cur = (days.get(d) || {})._media_view_by_ads;
          put(d, '_media_view_by_ads', { ...(cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {}), [bucket]: v.value });
        }
      } catch (e) { if (!(e instanceof GraphError && e.isMetric)) run.err('page_media_view breakdown', e); }
    }
  } else {
    // IG reach + follower_count: period=day series, 30-day windows (follower_count only last 30 days)
    const probe = await g.insightsResilient(asset.asset_id, IG.ACCOUNT_SERIES, { period: 'day', since: T.dayStartUnix(T.daysAgo(Math.min(29, DateTime.fromISO(today).diff(DateTime.fromISO(start), 'days').days), tz), itz), until: T.dayEndUnix(end, itz) });
    await recordCatalog('IG', 'ACCOUNT', probe.live, probe.dead);

    // Learn the account's insights-day boundary from Meta's own end_time stamps before deciding
    // which calendar day anything belongs to. insights_timezone is NOT updated from this: it also
    // drives anchorDateFor(), and moving the follower anchor is a separate change that needs its
    // own golden check. Detection is used for day attribution and request windows only.
    let stamp = null;
    for (const it of probe.data) { for (const v of it.values || []) if (v.end_time) { stamp = v.end_time; break; } if (stamp) break; }
    const igOffset = stamp ? T.offsetHoursFromEndTime(stamp) : null;
    const igz = stamp ? T.zoneFromOffsetHours(igOffset) : itz;
    if (stamp && igz !== itz) console.log(`[sync] IG ${asset.asset_id}: insights day closes at ${igz} (end_time ${stamp}); asset record says ${itz}. Using ${igz} for day windows.`);

    // Exact per-day windows, taken from the boundary Meta reported for that very day. DST-proof,
    // and the thing that makes total_value ask for the same 24 hours the series measured.
    const igWindows = new Map();
    for (const it of probe.data) for (const v of it.values || []) {
      const d = T.dateFromEndTime(v.end_time, igz);
      put(d, it.name, v.value);
      if (!igWindows.has(d)) igWindows.set(d, T.dayWindowFromEndTime(v.end_time));
    }
    if (probe.live.includes('reach')) {
      for (const [ws, we] of T.chunkRange(start, end, 30)) {
        if (we >= T.daysAgo(29, tz)) continue;   // covered by probe
        try { const r = await g.get(`${asset.asset_id}/insights`, { metric: 'reach', period: 'day', since: T.dayStartUnix(ws, igz), until: T.dayEndUnix(we, igz) });
          for (const it of r.data || []) for (const v of it.values || []) {
            const d = T.dateFromEndTime(v.end_time, igz);
            put(d, it.name, v.value);
            if (!igWindows.has(d)) igWindows.set(d, T.dayWindowFromEndTime(v.end_time));
          } }
        catch (e) { run.err(`ig reach ${ws}`, e); }
      }
    }
    // total_value metrics: one request per day, batched.
    // The window comes from igWindows where the series observed that day, and from the detected
    // zone otherwise. Building it from T.dayStartUnix(d, 'UTC') — which is what this did until
    // 2026-09-09 — asks Meta for a 24h span straddling two insights days on any account whose
    // day does not close at UTC midnight, and Meta answers with the earlier one.
    // Never ask about a day Meta has not started. The client's "today" can be ahead of the insights day
    // (00:00-03:00 in New York is still the previous day on Meta's Pacific clock); such a request comes
    // back as a "metric" error and used to make the whole block look dead for that run (F-7).
    const igToday = T.DateTime.now().setZone(igz).toISODate();
    const lastDay = end > igToday ? igToday : end;
    const endWin = igWindows.get(lastDay) || T.dayWindowInZone(lastDay, igz);
    const tprobe = await g.insightsResilient(asset.asset_id, IG.ACCOUNT_TOTAL, { metric_type: 'total_value', period: 'day', since: endWin.since, until: endWin.until });
    await recordCatalog('IG', 'ACCOUNT', tprobe.live, tprobe.dead);
    if (tprobe.live.length) {
      const dayList = [...T.eachDay(start, lastDay)];
      const res = await g.batch(dayList.map((d) => {
        const w = igWindows.get(d) || T.dayWindowInZone(d, igz);
        return { key: d, relative_url: `${asset.asset_id}/insights?metric=${tprobe.live.join(',')}&metric_type=total_value&period=day&since=${w.since}&until=${w.until}` };
      }));
      for (const d of dayList) {
        const r = res.get(d); if (!r?.ok) { if (r?.error && !r.error.isMetric) run.err(`ig totals ${d}`, r.error); continue; }
        for (const it of r.body?.data || []) {
          if (it.name === 'reach') {
            // Cross-check only — never mapped to a column. mapAccountDay reads m.reach, which
            // stays the series value.
            put(d, '_reach_tv', it.total_value?.value ?? it.value);
          } else if (it.name === 'follows_and_unfollows' && it.total_value?.breakdowns) {
            const b = {}; for (const x of it.total_value.breakdowns[0]?.results || []) b[(x.dimension_values || [])[0]?.toLowerCase()] = Number(x.value || 0);
            put(d, it.name, { follows: b.follower ?? b.follows ?? null, unfollows: b.non_follower ?? b.unfollows ?? null });
          } else put(d, it.name, it.total_value?.value ?? it.value);
        }
        put(d, '_raw', r.body?.data);
      }

      // The invariant. Same metric, same day, two endpoints — they must agree. A mismatch means
      // the windows describe different days, so every total_value column in this run is suspect.
      // Loud on purpose: the run log read "OK, 0 errors" for three months while this was wrong.
      const drift = [];
      for (const [d, m] of days) {
        if (m.reach === null || m.reach === undefined || m._reach_tv === null || m._reach_tv === undefined) continue;
        if (Number(m.reach) !== Number(m._reach_tv)) drift.push(`${d}: series ${m.reach} vs total_value ${m._reach_tv}`);
      }
      if (drift.length) {
        run.err('day-attribution', new Error(
          `IG day windows disagree on ${drift.length} day(s) — total_value metrics in this run may be attributed to the wrong day. ` +
          `Detected insights day: ${igz}. ${drift.slice(0, 3).join(' | ')}`));
      }
    }
    try {   // online followers (last 30 days, hour → count)
      const r = await g.get(`${asset.asset_id}/insights`, { metric: IG.ONLINE_FOLLOWERS, period: 'lifetime', since: T.dayStartUnix(T.daysAgo(Math.min(29, DateTime.fromISO(today).diff(DateTime.fromISO(start), 'days').days), tz), itz), until: T.dayEndUnix(end, itz) });
      for (const it of r.data || []) for (const v of it.values || []) put(T.dateFromEndTime(v.end_time, igz), '_online', v.value);
    } catch (e) { if (!(e instanceof GraphError && e.isMetric)) run.err('online_followers', e); }
  }

  // Build rows.
  //   FB  — page_follows / page_fans ARE absolute totals, one per day, so history is real.
  //   IG  — the API has no historical follower total. `follower_count` is the day's gain and is
  //         mapped to followers_gained_day; the only observable total is today's profile read.
  //         Past IG totals are derived at read time by v_account_daily.followers_total_est.
  const prevRows = await existingAccountRows(asset.id, start, end);
  const observedAt = nowIso();

  // Which day does the profile reading describe? See anchorDateFor().
  let anchor = anchorDateFor(itz);
  const anchorFinals = await finalKeys('xp_account_metric_snapshots', asset.id, ['metric_date'], { dateCol: 'metric_date', dates: [anchor] });
  if (anchorFinals.has(anchor)) {
    // Should not happen: the finalization lag is wider than the anchor offset. If it does, the
    // sync is running very late — refuse to lose the reading, and say so in the run log.
    run.err('anchor', new Error(`Follower anchor day ${anchor} (${itz}) is already finalized; recording today's reading against ${today} instead. The sync ran later than the finalization lag allows.`));
    anchor = today;
  }
  const attachProfile = (mapped) => {
    mapped.followers_total = mapped.followers_total ?? profile?.followers_count ?? null;
    if (!isIG) mapped.fans_total = mapped.fans_total ?? profile?.fan_count ?? null;
    if (isIG) {
      mapped.following_total = mapped.following_total ?? profile?.follows_count ?? null;
      mapped.media_count     = mapped.media_count     ?? profile?.media_count   ?? null;
    }
    if (mapped.followers_total !== null && mapped.followers_total !== undefined) mapped.followers_observed_at = observedAt;
    return mapped;
  };

  // 0010 · the observation log. One row per open day per sync, holding what Meta returned on
  // THIS read — captured before carry-forward, because a carried-over value is not evidence
  // that anything was observed. fn_finalize_snapshots() closes a day when two of these agree,
  // instead of when a timer expires; see migrations/0010_settle_lock.sql.
  const obsRows = [];
  const OBS_COLS = ['reach', 'impressions', 'views', 'engagements', 'profile_views', 'accounts_engaged', 'followers_gained_day'];

  const rows = [];
  for (const [d, m] of days) {
    if (d < start || d > end) continue;
    const mapped = isIG ? IG.mapAccountDay(m) : FB.mapAccountDay(m);
    if (d === anchor) attachProfile(mapped);
    if (isIG && m._online) mapped.online_followers = m._online;

    // Snapshot of this read, taken here and nowhere else: one line later, carry-forward has
    // already filled the nulls and the two are indistinguishable.
    const served = {};
    for (const k of ACCOUNT_VALUE_COLS) if (mapped[k] !== null && mapped[k] !== undefined) served[k] = mapped[k];
    if (Object.keys(served).length) {
      // No observed_at: the column defaults to now() on the database server. The laptop clock
      // was ~57 minutes fast when 0010 shipped, and plateau hours are computed from this field.
      const obs = { client_id: ctx.client.id, asset_id: asset.id, platform: asset.platform, metric_date: d,
        sync_run_id: run.id, observed: served };
      for (const k of OBS_COLS) obs[k] = mapped[k] ?? null;
      obsRows.push(obs);
    }

    // Never replace a known value with an unknown one — every value column, every day.
    // Carry-forward only fills nulls, so a fresh observation still wins.
    const prev = prevRows.get(String(d)) || {};
    for (const k of ACCOUNT_VALUE_COLS) mapped[k] = mapped[k] ?? prev[k] ?? null;
    if (Object.values(mapped).every((v) => v === null || v === undefined)) continue;
    const { _raw, _online, ...flat } = m;
    rows.push({ client_id: ctx.client.id, asset_id: asset.id, platform: asset.platform, metric_date: d, ...mapped, raw: { flat, series_raw: _raw || null }, source: opts.rangeStart ? 'BACKFILL' : 'LIVE', collected_at: nowIso() });
  }
  // The anchor day may fall outside the insights response (no metrics served yet for a day only
  // minutes old, or outside [start,end]). The follower total is the one number we must never drop.
  if (!rows.some((r) => r.metric_date === anchor) && profile?.followers_count !== undefined) {
    const mapped = attachProfile({});
    const prev = prevRows.get(String(anchor)) || {};
    for (const k of ACCOUNT_VALUE_COLS) mapped[k] = mapped[k] ?? prev[k] ?? null;
    rows.push({ client_id: ctx.client.id, asset_id: asset.id, platform: asset.platform, metric_date: anchor, ...mapped, raw: { profile_only: true, anchor_tz: itz }, source: 'LIVE', collected_at: nowIso() });
  }
  // PostgREST rejects a bulk upsert whose objects have different key sets (PGRST102). The
  // profile-only row carries fewer keys than a metrics row, so normalise to the union.
  const allKeys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  for (const r of rows) for (const k of allKeys) if (!(k in r)) r[k] = null;

  const finals = await finalKeys('xp_account_metric_snapshots', asset.id, ['metric_date'], { dateCol: 'metric_date', dates: rows.map((r) => r.metric_date) });
  const writable = rows.filter((r) => !finals.has(String(r.metric_date)));
  if (writable.length) run.snapshots_written += await upsertChunked('xp_account_metric_snapshots', writable, 'asset_id,metric_date', 200);
  ctx.skippedFinal = rows.length - writable.length;

  // 0011 · observations are kept for EVERY day in the lookback, locked or not. Until v2.5 they
  // stopped at lock, which threw away the one thing that can grade the settle rule: whether Meta
  // kept moving a day after we froze it. The snapshot row is still never touched — the guard
  // filtered it out above — this only records that Meta now says something different, so
  // fn_settle_drift() can show it. The lookback is settle_ceiling_days + 1, so this is ~15 rows
  // per asset per run, and a day older than the ceiling stops being read (and logged) on its own.
  // Failure here is recorded and does not stop the run — but it is never swallowed, because a
  // silently empty log would let days lock as 'unobserved' while the run said OK.
  if (obsRows.length) {
    try {
      await q(supabase.from('xp_account_metric_observations').insert(obsRows), 'account observations');
      ctx.observations = obsRows.length;
    } catch (e) {
      run.err('observations', /account_metric_observations/i.test(e.message || '')
        ? new Error(`${e.message} — migration 0010 has not been applied, so no day can lock on evidence.`)
        : e);
    }
  }
}

// ---------------------------------------------------------------- 6. audience demographics (weekly)
async function syncAudience(ctx) {
  const { g, asset, isIG, today, run, settings, fullBackfill } = ctx;
  const last = await q(supabase.from('xp_audience_snapshots').select('snapshot_date').eq('asset_id', asset.id).order('snapshot_date', { ascending: false }).limit(1).maybeSingle(), 'last audience');
  if (!fullBackfill && last && DateTime.fromISO(today).diff(DateTime.fromISO(last.snapshot_date), 'days').days < settings.demographicsEveryDays) return;
  const rows = [], dead = [], live = [];
  if (isIG) {
    for (const a of IG.AUDIENCE) {
      try {
        const r = await g.get(`${asset.asset_id}/insights`, { metric: a.metric, period: 'lifetime', metric_type: 'total_value', timeframe: 'this_month', breakdown: a.breakdown });
        const it = (r.data || [])[0]; if (!it) continue;
        rows.push({ client_id: ctx.client.id, asset_id: asset.id, snapshot_date: today, audience_type: a.type, dimension: a.dimension, breakdown: breakdownToMap(it), raw: it, collected_at: nowIso() });
        live.push(a.metric);
      } catch (e) { if (e instanceof GraphError && e.isMetric) dead.push({ metric: a.metric, error: e.message }); else run.err(`audience ${a.metric}`, e); }
    }
  } else {
    for (const a of FB.AUDIENCE) {
      // FB.AUDIENCE lists the current metric first and its deprecated predecessor after it, for
      // the same dimension. The first one that answers wins; the second would otherwise collide
      // on the (asset, date, type, dimension) key in the same upsert.
      if (rows.some((x) => x.dimension === a.dimension)) continue;
      try {
        const r = await g.get(`${asset.asset_id}/insights`, { metric: a.metric, period: 'day' });
        const it = (r.data || [])[0]; const v = it?.values?.slice(-1)[0]?.value; if (!v || typeof v !== 'object') continue;
        rows.push({ client_id: ctx.client.id, asset_id: asset.id, snapshot_date: today, audience_type: 'FOLLOWERS', dimension: a.dimension, breakdown: v, raw: it, collected_at: nowIso() });
        live.push(a.metric);
      } catch (e) { if (e instanceof GraphError && e.isMetric) dead.push({ metric: a.metric, error: e.message }); else run.err(`audience ${a.metric}`, e); }
    }
  }
  await recordCatalog(asset.platform, 'AUDIENCE', live, dead);
  if (rows.length) run.snapshots_written += await upsertChunked('xp_audience_snapshots', rows, 'asset_id,snapshot_date,audience_type,dimension', 100);
}

// ---------------------------------------------------------------- 7. comments (posts from the last 30 days)
async function syncComments(ctx) {
  const { g, asset, isIG, tz, run } = ctx;
  const since = T.daysAgo(30, tz);
  const posts = await q(supabase.from('xp_meta_posts').select('meta_post_id').eq('asset_id', asset.id).eq('is_deleted', false).eq('is_story', false).gte('publish_date', since).limit(500), 'posts for comments');
  if (!posts.length) return;
  const fields = isIG ? 'id,text,username,from,timestamp,like_count,hidden,replies{id,text,username,from,timestamp,like_count,hidden}' : 'id,message,from,created_time,like_count,is_hidden,parent{id}';
  const res = await g.batch(posts.map((p) => ({ key: p.meta_post_id, relative_url: `${p.meta_post_id}/comments?fields=${fields}&limit=100${isIG ? '' : '&filter=stream'}` })));
  const rows = [];
  const push = (postId, c, parent = null) => rows.push({
    client_id: ctx.client.id, asset_id: asset.id, meta_post_id: postId, comment_id: c.id, parent_comment_id: parent || c.parent?.id || null,
    author_id: c.from?.id || null, author_name: c.from?.name || c.username || c.from?.username || null,
    message: c.text ?? c.message ?? null, like_count: c.like_count ?? null, is_hidden: !!(c.hidden ?? c.is_hidden),
    created_time: c.timestamp || c.created_time || null, raw: c, last_seen_at: nowIso(), is_deleted: false
  });
  for (const p of posts) {
    const r = res.get(p.meta_post_id); if (!r?.ok) { if (r?.error && !/comments/i.test(r.error.message)) run.err(`comments ${p.meta_post_id}`, r.error); continue; }
    for (const c of r.body?.data || []) { push(p.meta_post_id, c); for (const rep of c.replies?.data || []) push(p.meta_post_id, rep, c.id); }
  }
  if (rows.length) await upsertChunked('xp_post_comments', rows, 'comment_id', 300);
  ctx.comments = rows.length;
}

// ================================================================ CLIENT / ALL
// One sync per client at a time. Two runs of the same client read the same open days and race each
// other's upserts against fn_finalize_snapshots(): a day locked between one run's read and its write
// trips the immutability guard and that asset's rows for the run are lost. A second "Sync" click, a
// retried request after a proxy timeout, or a manual sync during the cron all did this.
const runningClients = new Set();

async function syncClient(clientId, opts = {}) {
  if (runningClients.has(clientId)) {
    const e = new Error('A sync for this client is already running. Wait for it to finish, then try again.');
    e.status = 409;
    e.alreadyRunning = true;
    throw e;
  }
  runningClients.add(clientId);
  try { return await syncClientOnce(clientId, opts); }
  finally { runningClients.delete(clientId); }
}

async function syncClientOnce(clientId, opts) {
  const settings = await loadSettings();
  const client = await q(supabase.from('xp_clients').select('id,client_name,timezone,is_active').eq('id', clientId).single(), 'client');
  // EXPIRED is included on purpose: an asset marked expired by a previous run must be retried, otherwise
  // fixing the token would never take effect and the run log would go silent instead of showing the reason.
  // PAUSED and REMOVED are deliberate operator choices and stay out.
  const all = await q(supabase.from('xp_meta_assets').select('*').eq('client_id', clientId).order('platform'), 'assets');
  const assets = all.filter((a) => ['ACTIVE', 'EXPIRED', null, undefined].includes(a.status));
  if (!assets.length) {
    const why = all.length ? `all ${all.length} attached asset(s) are ${[...new Set(all.map((a) => a.status))].join('/')}` : 'no assets attached — connect this client via Meta OAuth';
    return { client: client.client_name, clientId, status: 'FAILED', error: `Nothing to sync: ${why}.`, assets: [] };
  }
  const results = [];
  for (const a of assets) results.push(await syncAsset(client, a, opts, settings));
  const tokenTrouble = results.some((r) => r.errors?.some((e) => e.code === 190 || e.tried || /token/i.test(e.message || '')));
  await q(supabase.from('xp_clients').update({ last_synced_at: nowIso(), token_status: tokenTrouble ? 'EXPIRED' : 'ACTIVE' }).eq('id', clientId), 'client upd').catch(() => {});
  const status = results.every((r) => r.status === 'OK') ? 'OK' : results.every((r) => r.status === 'FAILED') ? 'FAILED' : 'PARTIAL';
  // A manual sync from the admin should leave the database in the same settled state the cron
  // does. syncAll batches this instead, once, after every client.
  if (!opts.skipFinalize) await finalize().catch((e) => console.error('[finalize]', e.message));
  return { client: client.client_name, clientId, status, assets: results };
}

async function syncAll(opts = {}) {
  const clients = await q(supabase.from('xp_clients').select('id,client_name').eq('is_active', true).order('created_at'), 'xp_clients');
  const out = [];
  for (const c of clients) {
    try { out.push(await syncClient(c.id, { ...opts, skipFinalize: true })); }
    catch (e) { out.push({ client: c.client_name, clientId: c.id, status: e.alreadyRunning ? 'SKIPPED' : 'FAILED', error: e.message }); }
  }
  await finalize().catch((e) => console.error('[finalize]', e.message));
  return out;
}

// Close yesterday's rows, then give any closed day that has no measured follower total a
// permanent estimate. Order matters: a row must be final before it can be frozen, and once
// frozen it is never recomputed — that is what makes "what was it on Aug 5" a stable answer.
async function finalize() {
  const finalized = await q(supabase.rpc('fn_finalize_snapshots'), 'finalize');
  let frozen = null;
  try {
    frozen = await q(supabase.rpc('fn_freeze_follower_estimates', { p_client: null, p_force: false }), 'freeze followers');
    const left = (frozen || []).reduce((s, r) => s + Number(r.days_left || 0), 0);
    if (left) console.warn(`[freeze] ${left} closed day(s) still have no settled follower total — see fn_follower_integrity()`);
  } catch (e) {
    // Pre-0007 database, or the freeze pass failed. Not fatal: the series still reads, it just
    // reads a live estimate for unfrozen days instead of a frozen one.
    console.error('[freeze followers]', e.message);
  }
  // 0010. What is still open, and why. Printed every run so "a day is stuck" is visible on the
  // day it starts, not a month later when the number is already frozen wrong.
  let settle = null;
  try {
    settle = await q(supabase.rpc('fn_settle_health'), 'settle health');
    for (const r of settle || []) {
      if (/FELL/.test(r.verdict)) console.warn(`[settle] ${r.platform} ${r.metric_date}: ${r.verdict} (${r.prev_reach} → ${r.last_reach})`);
      else if (r.age_days >= 7) console.warn(`[settle] ${r.platform} ${r.metric_date} open ${r.age_days}d — ${r.verdict}`);
    }
  } catch (e) {
    console.error('[settle health]', e.message);   // pre-0010 database
  }
  return { finalized, frozen, settle };
}

module.exports = { syncAll, syncClient, syncAsset, finalize, recordCatalog };
