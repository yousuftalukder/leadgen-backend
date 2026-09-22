// Influencer posts per restaurant (v2.11.0, 0028).
//
// Meta's API never returns a post an influencer owns, even a collab with the restaurant. The restaurant's
// public Instagram shows them, so they are read with Apify:
//   - once a week, the restaurant's tagged tab ("mentions") and its grid ("posts", which carries the collabs),
//     only posts newer than the last look (the first look goes back 90 days);
//   - staff can add any post from its link, and look or refresh at any time;
//   - each influencer post's public numbers are read again while they still move (instagram.refreshDue).
// Who counts as an influencer (showable): a collab; an account with 1,000+ followers or that Instagram calls
// a creator, blogger or critic; a post that reached 1,000+ views; or a creator already shown for that
// restaurant. Anyone else is usually a customer: their post is kept, hidden, until staff show it. Only
// shown (ACTIVE) posts reach the owner's answers and report.
// Every Apify run is logged in apify_runs with what it was for, the restaurant, its results and its cost.
const { DateTime } = require('luxon');
const { supabase, q } = require('../db');
const apify = require('../apify');
const IG = require('./instagram');
const store = require('./store');

const ACTOR = 'apify/instagram-scraper';
const PRICE = 0.0027;                    // per result on Apify's free plan (19 Sep 2026); only used to cap runs
const FIRST_LOOK_DAYS = 90;
const LIMITS = { first: { mentions: 21, grid: 30 }, weekly: { mentions: 12, grid: 12 } };
const PINNED_EXTRA = 3;                  // pinned posts come back whatever their date
const FB_WINDOW_DAYS = 90;               // v2.14.2: the refresh window (instagram.refreshDue); older posts are not read again
const FB_LIMIT_MAX = 60;
const MIN_FOLLOWERS = 1000;
const MIN_VIEWS = 1000;
const CREATOR_CATEGORY = /creator|blog|critic|influenc|public figure|video|reel|photograph|artist/i;
const AUTO_HIDDEN = 'Hidden automatically';
const PROFILE_EVERY_DAYS = 30;
const DISCOVER_EVERY_DAYS = 7;
const SCHEDULE_FLOOR_USD = 0.5;          // scheduled reads stop when the key pool has less than this left
const HOUR = 3600e3, DAY = 24 * HOUR;
const capUsd = (items) => Math.round((items * PRICE * 1.25 + 0.01) * 100) / 100;
const err = (status, message) => Object.assign(new Error(message), { status });

// ---------------------------------------------------------------- Apify runs, logged
// Returns { items, errors }: an error item (a restricted or missing profile or post) is charged like any
// result, so callers note it rather than ask again the next day.
async function tracked(purpose, clientId, input, { maxItems, timeoutSecs = 600 } = {}) {
  const row = await q(supabase.from('xp_apify_runs').insert({ actor: ACTOR, purpose, client_id: clientId || null, status: 'RUNNING' }).select('id').single(), 'apify run start');
  try {
    const r = await apify.pool().runTracked(ACTOR, input, { maxItems, maxTotalChargeUsd: capUsd(maxItems), timeoutSecs });
    const items = r.items.filter((x) => x && !x.error), errors = r.items.filter((x) => x && x.error);
    await q(supabase.from('xp_apify_runs').update({ status: r.status === 'TIMED-OUT' ? 'PARTIAL' : 'OK', run_id: r.runId, key_label: r.key.label, items: items.length,
      cost_usd: r.costUsd, error: errors.length ? `${errors.length} not returned: ${[...new Set(errors.map((x) => x.errorDescription || x.error))].join(', ')}`.slice(0, 500) : null,
      finished_at: new Date().toISOString() }).eq('id', row.id), 'apify run end');
    return { items, errors };
  } catch (e) {
    await supabase.from('xp_apify_runs').update({ status: 'FAILED', error: String(e.message || e).slice(0, 500), run_id: e.runId || null, key_label: e.keyLabel || null,
      cost_usd: e.costUsd ?? null, finished_at: new Date().toISOString() }).eq('id', row.id);
    throw e;
  }
}
// A run the server was killed in the middle of (a deploy, a restart) would stay RUNNING for good.
async function closeInterrupted() {
  await supabase.from('xp_apify_runs').update({ status: 'FAILED', error: 'Interrupted: the server restarted during the run.', finished_at: new Date().toISOString() })
    .eq('status', 'RUNNING').lt('started_at', new Date(Date.now() - 2 * HOUR).toISOString());
}
async function lastRun(clientId, purpose, statuses = ['OK', 'PARTIAL']) {
  let s = supabase.from('xp_apify_runs').select('started_at,status').eq('client_id', clientId).eq('purpose', purpose).order('started_at', { ascending: false }).limit(1);
  if (statuses) s = s.in('status', statuses);
  return (await q(s, 'last run'))[0] || null;
}

// ---------------------------------------------------------------- one job per restaurant at a time
// Staff start a look or a refresh and the page asks how it is going; the daily pass takes the same slot,
// so two runs never read the same restaurant at once. In memory: a restart forgets them (see closeInterrupted).
const jobs = new Map();
const jobOf = (clientId) => jobs.get(clientId) || null;
function startJob(clientId, kind, by, fn) {
  const cur = jobs.get(clientId);
  if (cur && !cur.finished_at) {
    throw err(409, { discover: 'Already looking for new posts for this restaurant.', refresh: 'Already refreshing this restaurant\'s numbers.',
      audit: 'A content audit is already running for this restaurant.' }[cur.kind] || 'Already working on this restaurant.');
  }
  const job = { kind, by: by || null, started_at: new Date().toISOString(), finished_at: null, result: null, error: null };
  jobs.set(clientId, job);
  job.promise = Promise.resolve().then(fn)
    .then((r) => { job.result = r; return r; }, (e) => { job.error = e.message || String(e); console.warn(`[influencers] ${kind}:`, job.error); return null; })
    .finally(() => { job.finished_at = new Date().toISOString(); });
  return job;
}
// finished_ago_s is worked out here: the page must not trust its own computer's clock.
const publicJob = (j) => (j ? { kind: j.kind, by: j.by, started_at: j.started_at, finished_at: j.finished_at, result: j.result, error: j.error,
  finished_ago_s: j.finished_at ? Math.round((Date.now() - Date.parse(j.finished_at)) / 1000) : null } : null);

// ---------------------------------------------------------------- the restaurant's own account
async function restaurantHandle(clientId) {
  const assets = await q(supabase.from('xp_meta_assets').select('username,status').eq('client_id', clientId).eq('platform', 'IG'), 'ig account');
  const a = assets.find((x) => x.status === 'ACTIVE' && x.username) || assets.find((x) => x.username);
  const username = a ? IG.cleanUsername(a.username) : null;
  if (!username) throw err(400, 'This restaurant has no Instagram account connected.');
  const ids = await store.ensureProfiles([{ username }]);
  await q(supabase.from('xp_client_social_profiles').upsert({ client_id: clientId, profile_id: ids.get(username), role: 'SELF', added_by: 'system' },
    { onConflict: 'client_id,profile_id', ignoreDuplicates: true }), 'own profile');
  return { username, profileId: ids.get(username) };
}

// Creators' follower counts (and typical likes), read at most once a month each. username → profile row.
async function creatorProfiles(usernames, clientId, { read = true } = {}) {
  const out = new Map();
  const names = [...new Set(usernames.filter(Boolean))];
  if (!names.length) return out;
  for (const r of await q(supabase.from('xp_social_profiles').select('id,username,full_name,category,followers,verified,profile_pic_path,last_fetched_at,raw').eq('platform', 'IG').in('username', names), 'creators')) out.set(r.username, r);
  const stale = names.filter((u) => !out.get(u)?.last_fetched_at || Date.now() - Date.parse(out.get(u).last_fetched_at) > PROFILE_EVERY_DAYS * DAY);
  if (!read || !stale.length) return out;
  for (let i = 0; i < stale.length; i += 25) {
    const part = stale.slice(i, i + 25);
    const { items, errors } = await tracked('PROFILE', clientId, { directUrls: part.map(IG.profileUrl), resultsType: 'details', resultsLimit: 1 }, { maxItems: part.length });
    const got = new Set();
    for (const it of items) { const p = await store.saveProfile(it).catch((e) => { console.warn('[influencers] profile:', e.message); return null; }); if (p) { out.set(p.username, p); got.add(p.username); } }
    // Not returned (a restricted or private profile): asked again in a month, not every day.
    const why = (u) => { const e = errors.find((x) => IG.cleanUsername(x.inputUrl || x.url || x.username) === u); return (e && (e.errorDescription || e.error)) || 'not returned'; };
    for (const u of part.filter((x) => !got.has(x))) {
      const row = out.get(u);
      if (!row) continue;
      const now = new Date().toISOString();
      await q(supabase.from('xp_social_profiles').update({ last_fetched_at: now, raw: { ...(row.raw || {}), unavailable: why(u), unavailable_at: now } }).eq('id', row.id), 'profile unavailable');
      out.set(u, { ...row, last_fetched_at: now });
    }
  }
  return out;
}

// ---------------------------------------------------------------- finding posts
// v2.14.2 (F-58): the tagged tab is the only read that gives the Facebook part of a reel the creator also shared
// there. So the weekly look reads it back to the oldest shown post with a Facebook part still in the refresh
// window, and those parts stay current each week. The limit covers the posts known since then (hidden
// customers' ones included, since they fill the tab too), plus room for new ones. Null when there are none.
async function facebookWindow(clientId) {
  const cut = DateTime.utc().minus({ days: FB_WINDOW_DAYS }).toISO();
  const rows = await q(supabase.from('xp_influencer_posts').select('status, xp_social_posts!inner(posted_at,raw)').eq('client_id', clientId).gte('xp_social_posts.posted_at', cut), 'facebook window');
  const shared = rows.filter((r) => r.status === 'ACTIVE' && r.social_posts.raw?.fb && r.social_posts.posted_at);
  if (!shared.length) return null;
  const oldest = shared.map((r) => r.social_posts.posted_at).sort()[0];
  const known = rows.filter((r) => r.social_posts.posted_at && r.social_posts.posted_at >= oldest).length;
  return { since: DateTime.fromISO(oldest).toUTC().minus({ days: 1 }).startOf('day'), limit: Math.min(FB_LIMIT_MAX, Math.max(LIMITS.weekly.mentions, known + 6)), posts: shared.length };
}

async function discover(clientId, { by = null, scheduled = false } = {}) {
  const me = await restaurantHandle(clientId);
  const last = await lastRun(clientId, 'DISCOVER');
  const lim = last ? LIMITS.weekly : LIMITS.first;
  const since = last ? DateTime.fromISO(last.started_at).minus({ days: 2 }) : DateTime.utc().minus({ days: FIRST_LOOK_DAYS });
  const fb = last ? await facebookWindow(clientId).catch((e) => { console.warn('[influencers] facebook window:', e.message); return null; }) : null;
  const tagSince = fb && fb.since < since ? fb.since : since, tagLimit = fb && fb.since < since ? fb.limit : lim.mentions;
  const base = { directUrls: [IG.profileUrl(me.username)] };
  const startedAt = new Date().toISOString();
  const reads = await Promise.allSettled([
    tracked('DISCOVER', clientId, { ...base, onlyPostsNewerThan: tagSince.toISODate(), resultsType: 'mentions', resultsLimit: tagLimit }, { maxItems: tagLimit + PINNED_EXTRA }),
    tracked('DISCOVER', clientId, { ...base, onlyPostsNewerThan: since.toISODate(), resultsType: 'posts', resultsLimit: lim.grid }, { maxItems: lim.grid + PINNED_EXTRA })
  ]);
  if (reads.every((r) => r.status === 'rejected')) throw reads[0].reason;
  const items = reads.flatMap((r) => (r.status === 'fulfilled' ? r.value.items : []));
  // Both views of the profile hold only the restaurant's own posts and posts that involve it, so every
  // post another account owns is one about the restaurant.
  const saved = await store.savePosts(items, { thumbs: (p) => p.owner_username !== me.username });
  const theirs = saved.filter((p) => p.owner_username && p.owner_username !== me.username);
  const known = theirs.length
    ? new Set((await q(supabase.from('xp_influencer_posts').select('post_id').eq('client_id', clientId).in('post_id', theirs.map((p) => p.id)), 'known posts')).map((r) => r.post_id))
    : new Set();
  const fresh = theirs.filter((p) => !known.has(p.id));
  const creators = await creatorProfiles(fresh.map((p) => p.owner_username), clientId).catch((e) => { console.warn('[influencers] creators:', e.message); return new Map(); });
  const shownFor = await shownCreators(clientId);
  for (const p of fresh) if (p.collaborators.includes(me.username)) shownFor.add(p.owner_username);
  const rows = fresh.map((p) => {
    const c = creators.get(p.owner_username) || {};
    const views = p.views === null ? null : p.views + (p.raw?.fb?.views || 0);   // as Instagram shows them (F-58)
    const shown = p.collaborators.includes(me.username) || shownFor.has(p.owner_username) || (c.followers ?? 0) >= MIN_FOLLOWERS
      || CREATOR_CATEGORY.test(c.category || '') || (views ?? 0) >= MIN_VIEWS;
    const facts = [c.followers === null || c.followers === undefined ? 'follower count unknown' : `${c.followers.toLocaleString('en-US')} followers`,
      views === null ? null : `${views.toLocaleString('en-US')} views`, 'not a collab'].filter(Boolean).join(', ');
    return {
      client_id: clientId, post_id: p.id, influencer_username: p.owner_username, source: 'AUTO', status: shown ? 'ACTIVE' : 'HIDDEN',
      notes: shown ? null : `${AUTO_HIDDEN}: ${facts}, so probably a customer. Show it to count it.`,
      added_by: scheduled ? 'Weekly check' : by
    };
  });
  if (rows.length) await q(supabase.from('xp_influencer_posts').upsert(rows, { onConflict: 'client_id,post_id', ignoreDuplicates: true }), 'influencer posts add');
  await promoteHidden(clientId);
  return {
    looked_back_to: since.toISODate(), posts_read: saved.length, about_restaurant: theirs.length,
    ...(tagSince < since ? { tagged_tab_back_to: tagSince.toISODate(), facebook_parts_read: saved.filter((p) => p.raw?.fb?.read_at && p.raw.fb.read_at >= startedAt).length } : {}),
    new_shown: rows.filter((r) => r.status === 'ACTIVE').length, new_hidden: rows.filter((r) => r.status === 'HIDDEN').length,
    partial: reads.some((r) => r.status === 'rejected') ? reads.find((r) => r.status === 'rejected').reason.message : null
  };
}

// Creators with a shown post for this restaurant.
async function shownCreators(clientId) {
  return new Set((await q(supabase.from('xp_influencer_posts').select('influencer_username').eq('client_id', clientId).eq('status', 'ACTIVE'), 'shown creators'))
    .map((r) => r.influencer_username).filter(Boolean));
}
// A post hidden automatically is shown once its creator has a shown post for the restaurant. Posts staff
// hid themselves are left alone (a staff change of status clears the automatic note: see update).
async function promoteHidden(clientId) {
  const shown = [...await shownCreators(clientId)];
  if (!shown.length) return 0;
  const rows = await q(supabase.from('xp_influencer_posts').update({ status: 'ACTIVE', notes: null, updated_at: new Date().toISOString() })
    .eq('client_id', clientId).eq('status', 'HIDDEN').eq('source', 'AUTO').like('notes', `${AUTO_HIDDEN}%`).in('influencer_username', shown).select('id'), 'promote hidden');
  return rows.length;
}

// ---------------------------------------------------------------- adding one post from its link
const cleanDate = (d) => {
  if (d === undefined) return undefined;
  if (d === null || d === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d)) || !DateTime.fromISO(String(d)).isValid) throw err(400, 'The visit date must be a date.');
  return String(d);
};
const cleanCost = (c) => {
  if (c === undefined) return undefined;
  if (c === null || c === '') return null;
  const n = Number(String(c).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > 1e6) throw err(400, 'The cost must be an amount in US dollars, like 150 or 150.00.');
  return Math.round(n * 100) / 100;
};
const cleanNotes = (s) => (s === undefined ? undefined : String(s || '').trim().slice(0, 1000) || null);

async function addByLink(clientId, link, { visitDate, costUsd, notes, by } = {}) {
  const l = IG.postLink(link);
  if (!l) throw err(400, 'Paste the link of an Instagram post or reel, like https://www.instagram.com/reel/…');
  const details = { visit_date: cleanDate(visitDate), cost_usd: cleanCost(costUsd), notes: cleanNotes(notes) };
  const me = await restaurantHandle(clientId);
  let post = (await q(supabase.from('xp_social_posts').select(store.POST_COLS).eq('platform', 'IG').eq('short_code', l.shortCode).limit(1), 'post by link'))[0];
  if (!post || !post.thumbnail_path || !post.last_fetched_at || Date.now() - Date.parse(post.last_fetched_at) > 6 * HOUR) {
    const { items } = await tracked('INFLUENCER', clientId, { directUrls: [l.url], resultsType: 'posts', resultsLimit: 1 }, { maxItems: 1 });
    const saved = await store.savePosts(items, { thumbs: () => true });
    post = saved.find((p) => p.short_code === l.shortCode) || saved[0] || post;
  }
  if (!post) throw err(404, 'Instagram did not return that post. Check the link, and that the account is public.');
  if (post.owner_username === me.username) throw err(400, 'That is the restaurant\'s own post. Add the post the influencer published (a collab counts).');
  await creatorProfiles([post.owner_username], clientId).catch((e) => console.warn('[influencers] creator:', e.message));
  const now = new Date().toISOString();
  const existing = (await q(supabase.from('xp_influencer_posts').select('id').eq('client_id', clientId).eq('post_id', post.id), 'influencer post known'))[0];
  const set = Object.fromEntries(Object.entries(details).filter(([, v]) => v !== undefined));
  if (existing) {
    await q(supabase.from('xp_influencer_posts').update({ ...set, status: 'ACTIVE', updated_at: now }).eq('id', existing.id), 'influencer post show');
    return { id: existing.id, already: true };
  }
  const row = await q(supabase.from('xp_influencer_posts').insert({ client_id: clientId, post_id: post.id, influencer_username: post.owner_username, source: 'MANUAL', status: 'ACTIVE',
    added_by: by || null, ...set }).select('id').single(), 'influencer post add');
  return { id: row.id, already: false };
}

async function update(id, clientId, { status, visitDate, costUsd, notes } = {}) {
  const patch = { visit_date: cleanDate(visitDate), cost_usd: cleanCost(costUsd), notes: cleanNotes(notes) };
  if (status !== undefined) {
    if (!['ACTIVE', 'HIDDEN'].includes(status)) throw err(400, 'Unknown status.');
    patch.status = status;
  }
  const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  if (!Object.keys(set).length) throw err(400, 'Nothing to change.');
  // Staff decided: the automatic note goes, so the weekly check never overrules them.
  if (set.status && set.notes === undefined) {
    const cur = (await q(supabase.from('xp_influencer_posts').select('notes').eq('id', id).eq('client_id', clientId), 'influencer post'))[0];
    if (cur && String(cur.notes || '').startsWith(AUTO_HIDDEN)) set.notes = null;
  }
  const rows = await q(supabase.from('xp_influencer_posts').update({ ...set, updated_at: new Date().toISOString() }).eq('id', id).eq('client_id', clientId).select('id'), 'influencer post update');
  if (!rows.length) throw err(404, 'Post not found.');
  return { id };
}
async function remove(id, clientId) {
  const rows = await q(supabase.from('xp_influencer_posts').delete().eq('id', id).eq('client_id', clientId).select('id'), 'influencer post remove');
  if (!rows.length) throw err(404, 'Post not found.');
  return { removed: true };
}

// ---------------------------------------------------------------- reading the numbers again
async function refreshNumbers({ clientId = null, ids = null, force = false } = {}) {
  let s = supabase.from('xp_influencer_posts').select('id,client_id,status, xp_social_posts(id,url,short_code,posted_at,last_fetched_at,owner_username,thumbnail_path,raw)').eq('status', 'ACTIVE');
  if (clientId) s = s.eq('client_id', clientId);
  if (ids) s = s.in('id', ids);
  const due = new Map();   // one read per post, even when two restaurants share it
  for (const r of await q(s, 'influencer posts due')) {
    const p = r.social_posts;
    if (p && p.url && (force || IG.refreshDue(p))) due.set(p.id, p);
  }
  const posts = [...due.values()];
  if (!posts.length) return { due: 0, read: 0, missing: 0 };
  let read = 0, missing = 0;
  for (let i = 0; i < posts.length; i += 50) {
    const part = posts.slice(i, i + 50);
    const { items } = await tracked('INFLUENCER', clientId, { directUrls: part.map((p) => p.url), resultsType: 'posts', resultsLimit: 1 }, { maxItems: part.length });
    const saved = await store.savePosts(items, { thumbs: () => true });
    const got = new Set(saved.map((p) => p.id));
    const gone = part.filter((p) => !got.has(p.id));
    if (gone.length) await store.markMissing(gone);
    read += saved.filter((p) => due.has(p.id)).length;
    missing += gone.length;
  }
  await creatorProfiles(posts.map((p) => p.owner_username), clientId).catch((e) => console.warn('[influencers] creators:', e.message));
  return { due: posts.length, read, missing };
}

// ---------------------------------------------------------------- the daily pass (after the 09:00 and 21:00 syncs)
// Refreshes what is due and gives each restaurant its weekly look. Safe to call twice a day: nothing is
// read twice (the schedule and the weekly check see to that). Stops when the key pool runs low, so staff
// keep some credit for their own looks.
let dailyRunning = false;   // "Run daily sync now" during a pass must not start a second one
async function daily() {
  if (dailyRunning) return { skipped: 'the previous pass is still running' };
  dailyRunning = true;
  try { return await dailyPass(); } finally { dailyRunning = false; }
}
async function dailyPass() {
  await closeInterrupted().catch(() => {});
  let keys;
  try { keys = await apify.pool().checkAll(); } catch (e) { return { skipped: `Apify keys could not be checked: ${e.message}` }; }
  if (!keys.usable) return { skipped: 'no Apify key with credit' };
  if (keys.left_usd < SCHEDULE_FLOOR_USD) return { skipped: `less than $${SCHEDULE_FLOOR_USD.toFixed(2)} of Apify credit left this month` };
  const out = { refresh: null, discover: [] };
  out.refresh = await refreshNumbers().catch((e) => ({ error: e.message }));
  const clients = await q(supabase.from('xp_clients').select('id,client_name, xp_meta_assets(platform,username,status)').eq('is_active', true), 'xp_clients');
  for (const c of clients) {
    if (!(c.meta_assets || []).some((a) => a.platform === 'IG' && a.username && a.status !== 'REMOVED')) continue;
    const [ok, tried] = await Promise.all([lastRun(c.id, 'DISCOVER'), lastRun(c.id, 'DISCOVER', null)]);
    if (ok && Date.now() - Date.parse(ok.started_at) < DISCOVER_EVERY_DAYS * DAY - 6 * HOUR) continue;
    const failedLast = tried && (!ok || Date.parse(tried.started_at) > Date.parse(ok.started_at));
    if (failedLast && Date.now() - Date.parse(tried.started_at) < 20 * HOUR) continue;   // the last look failed today: try tomorrow
    let job;
    try { job = startJob(c.id, 'discover', 'Weekly check', () => discover(c.id, { scheduled: true })); } catch { continue; }   // staff are on it
    await job.promise;
    out.discover.push({ client: c.client_name, ...(job.error ? { error: job.error } : job.result) });
  }
  return out;
}

// ---------------------------------------------------------------- what staff and owners see
async function usualReelViews(clientId) {
  const since = DateTime.utc().minus({ days: 90 }).toISODate();
  const rows = await q(supabase.from('xp_v_posts_with_latest').select('views').eq('client_id', clientId).eq('platform', 'IG').eq('is_deleted', false).eq('is_story', false)
    .eq('media_product_type', 'REELS').gte('publish_date', since).not('views', 'is', null).limit(500), 'usual reel views').catch(() => []);
  const v = rows.map((r) => Number(r.views)).filter(Number.isFinite).sort((a, b) => a - b);
  return v.length >= 3 ? { median: v[Math.floor((v.length - 1) / 2)], reels: v.length } : null;
}
const ratio = (a, b, places = 1) => (a !== null && a !== undefined && b ? Math.round((a / b) * 10 ** places) / 10 ** places : null);

// A post's numbers as Instagram shows them. For a reel the creator also shared to Facebook, Instagram adds the
// Facebook views and likes to its own (F-58): views and likes are those totals, with the two parts beside them.
// Comparisons with the restaurant's own reels (Instagram views from Meta) use the Instagram part, like with like.
function shownNumbers(p) {
  const fb = p.raw?.fb || null;
  const fbViews = fb && Number.isFinite(fb.views) ? fb.views : null, fbLikes = fb && Number.isFinite(fb.likes) ? fb.likes : null;
  const shared = !!fb && ((fbViews || 0) > 0 || (fbLikes || 0) > 0);
  return {
    views: p.views === null ? null : p.views + (shared ? fbViews || 0 : 0),
    likes: p.likes === null ? null : p.likes + (shared ? fbLikes || 0 : 0),
    views_instagram: p.views, likes_instagram: p.likes,
    views_facebook: shared ? fbViews : null, likes_facebook: shared ? fbLikes : null, facebook_read_at: shared ? fb.read_at || null : null
  };
}

// Every influencer post of a restaurant with its creator, numbers, growth and comparisons.
async function listFor(clientId) {
  const rows = await q(supabase.from('xp_influencer_posts').select(`id,influencer_username,source,status,visit_date,cost_usd,notes,added_by,created_at,updated_at, xp_social_posts(${store.POST_COLS})`)
    .eq('client_id', clientId).order('created_at', { ascending: false }).limit(200), 'influencer posts');
  const list = rows.filter((r) => r.social_posts);
  const handle = (await q(supabase.from('xp_meta_assets').select('username').eq('client_id', clientId).eq('platform', 'IG').limit(1), 'ig account'))[0]?.username?.toLowerCase() || null;
  const [creators, usual, snaps] = await Promise.all([
    creatorProfiles(list.map((r) => r.social_posts.owner_username), clientId, { read: false }),
    usualReelViews(clientId),
    list.length ? q(supabase.from('xp_social_post_snapshots').select('post_id,fetched_at,views,likes,comments').in('post_id', list.map((r) => r.social_posts.id)).order('fetched_at').limit(10000), 'snapshots') : []
  ]);
  const posts = list.map((r) => {
    const p = r.social_posts, c = creators.get(p.owner_username) || {}, n = shownNumbers(p);
    const engaged = p.likes !== null && p.comments !== null ? p.likes + p.comments : null;   // Instagram's part; hidden likes: no rate rather than a low one
    const engagedAll = n.likes !== null && p.comments !== null ? n.likes + p.comments : null;
    const series = snaps.filter((s) => s.post_id === p.id).map((s) => ({ at: s.fetched_at, views: s.views, likes: s.likes, comments: s.comments }));
    const cost = r.cost_usd === null || r.cost_usd === undefined ? null : Number(r.cost_usd);
    return {
      id: r.id, status: r.status, source: r.source, added_by: r.added_by, visit_date: r.visit_date, cost_usd: cost, notes: r.notes, created_at: r.created_at,
      collab: !!handle && (p.collaborators || []).includes(handle),
      post: {
        id: p.id, url: p.url, short_code: p.short_code, posted_at: p.posted_at, format: p.format, caption: p.caption, hashtags: p.hashtags, paid_partnership: p.paid_partnership,
        duration_s: p.duration_s === null ? null : Number(p.duration_s), music: p.music, ...n, comments: p.comments,
        likes_hidden: !!p.raw?.likes_hidden, thumbnail_url: store.publicUrl(p.thumbnail_path), first_seen_at: p.first_seen_at, last_fetched_at: p.last_fetched_at,
        missing_since: p.raw?.missing_since || null, comments_sample: (p.raw?.comments || []).slice(0, 5)
      },
      creator: {
        username: p.owner_username, full_name: c.full_name || p.raw?.owner_full_name || null, followers: c.followers ?? null, verified: c.verified ?? null,
        pic_url: store.publicUrl(c.profile_pic_path), typical_likes: c.raw?.typical_likes ?? null, unavailable: c.raw?.unavailable || null
      },
      metrics: {
        engagement_rate_pct: p.views ? ratio(engaged, p.views / 100) : null,
        views_per_follower: c.followers ? ratio(p.views, c.followers, 2) : null,
        vs_usual_reel: usual && p.views !== null && (p.format === 'REEL' || p.format === 'VIDEO') ? ratio(p.views, usual.median) : null,
        vs_creator_likes: c.raw?.typical_likes && p.likes !== null ? ratio(p.likes, c.raw.typical_likes) : null,
        cost_per_1000_views: cost !== null && n.views ? Math.round((cost / n.views) * 1000 * 100) / 100 : null,   // what the cost bought: every view
        cost_per_engagement: cost !== null && engagedAll ? Math.round((cost / engagedAll) * 100) / 100 : null,
        views_since_found: series.length > 1 && series[0].views !== null && p.views !== null ? p.views - series[0].views : null
      },
      series
    };
  });
  return { handle, usual_reel_views: usual, posts };
}

// The staff page: the list, the job in progress and when the restaurant was last looked at.
async function pageFor(clientId) {
  const [data, lastLook] = await Promise.all([listFor(clientId), lastRun(clientId, 'DISCOVER')]);
  const reads = data.posts.filter((x) => x.status === 'ACTIVE').map((x) => x.post.last_fetched_at).filter(Boolean).sort();
  return { ...data, job: publicJob(jobOf(clientId)), last_look_at: lastLook?.started_at || null, last_refresh_at: reads.pop() || null, min_followers: MIN_FOLLOWERS };
}

// For the owner's answers (get_influencer_posts): shown posts only, in the owner's words, no staff notes.
async function forOwner(clientId, { start = null, end = null, tz = 'America/New_York' } = {}) {
  const { usual_reel_views: usual, posts } = await listFor(clientId);
  const from = start ? DateTime.fromISO(start, { zone: tz }).startOf('day') : null;
  const to = end ? DateTime.fromISO(end, { zone: tz }).endOf('day') : null;
  const shown = posts.filter((x) => x.status === 'ACTIVE').filter((x) => {
    const at = x.post.posted_at ? DateTime.fromISO(x.post.posted_at) : null;
    return (!from || (at && at >= from)) && (!to || (at && at <= to));
  }).sort((a, b) => (b.post.views ?? -1) - (a.post.views ?? -1));
  const sum = (k) => { const v = shown.map((x) => x.post[k]).filter((n) => n !== null && n !== undefined); return v.length ? v.reduce((a, b) => a + b, 0) : null; };
  const day = (iso) => (iso ? DateTime.fromISO(iso).setZone(tz).toISODate() : null);
  return {
    period: start || end ? { start, end } : 'all recorded',
    about_these_numbers: 'Public numbers as Instagram shows them on each creator\'s post, read on the date given. When a creator also shared the reel to Facebook, Instagram counts those views and likes too: views and likes are then the totals, split in views_on_instagram and views_on_facebook. views_vs_your_usual_reel compares the Instagram views with your own reels\' Instagram views.',
    your_usual_reel_views: usual ? { median_views: usual.median, based_on_reels: usual.reels, over: 'your reels from the last 90 days' } : null,
    totals: { posts: shown.length, creators: new Set(shown.map((x) => x.creator.username)).size, views: sum('views'), likes: sum('likes'), comments: sum('comments'),
      ...(sum('views_facebook') ? { of_which_views_on_facebook: sum('views_facebook') } : {}) },
    posts: shown.slice(0, 25).map((x) => ({
      creator: `@${x.creator.username}`, creator_name: x.creator.full_name, creator_followers: x.creator.followers, collab_with_you: x.collab,
      posted: day(x.post.posted_at), format: x.post.format, views: x.post.views, likes: x.post.likes_hidden ? 'hidden by the creator' : x.post.likes, comments: x.post.comments,
      ...(x.post.views_facebook !== null || x.post.likes_facebook !== null ? { views_on_instagram: x.post.views_instagram, views_on_facebook: x.post.views_facebook,
        likes_on_facebook: x.post.likes_facebook, also_shared_to_facebook: true } : {}),
      engagement_rate_pct: x.metrics.engagement_rate_pct, views_vs_your_usual_reel: x.metrics.vs_usual_reel, likes_vs_creator_usual: x.metrics.vs_creator_likes,
      views_gained_since_first_read: x.metrics.views_since_found,
      cost_usd: x.cost_usd, cost_per_1000_views: x.metrics.cost_per_1000_views, visit_date: x.visit_date,
      caption_start: x.post.caption ? x.post.caption.slice(0, 140) : null, link: x.post.url, numbers_as_of: day(x.post.last_fetched_at),
      post_no_longer_public_since: day(x.post.missing_since),
      latest_comments: x.post.comments_sample.slice(0, 3).map((c) => c.text.slice(0, 160))
    })),
    ...(shown.length ? {} : { none: start || end ? 'No influencer posts are recorded for this restaurant in this period.' : 'No influencer posts are recorded for this restaurant yet.' })
  };
}

// For the PDF: shown posts published in the period, with their thumbnails.
async function forReport(clientId, start, end, tz = 'America/New_York') {
  const { usual_reel_views: usual, posts } = await listFor(clientId);
  const from = DateTime.fromISO(start, { zone: tz }).startOf('day'), to = DateTime.fromISO(end, { zone: tz }).endOf('day');
  const list = posts.filter((x) => x.status === 'ACTIVE' && x.post.posted_at && DateTime.fromISO(x.post.posted_at) >= from && DateTime.fromISO(x.post.posted_at) <= to)
    .sort((a, b) => (b.post.views ?? -1) - (a.post.views ?? -1));
  return list.length ? { usual, posts: list } : null;
}

// The Apify runs for Workspace → Settings, with this month's spend.
async function recentRuns(limit = 30) {
  const monthStart = DateTime.utc().startOf('month').toISO();
  const [runs, month, clients] = await Promise.all([
    q(supabase.from('xp_apify_runs').select('id,purpose,client_id,key_label,items,cost_usd,status,error,started_at,finished_at').order('started_at', { ascending: false }).limit(limit), 'apify runs'),
    q(supabase.from('xp_apify_runs').select('purpose,items,cost_usd').gte('started_at', monthStart).limit(5000), 'apify month'),
    q(supabase.from('xp_clients').select('id,client_name'), 'xp_clients')
  ]);
  const name = Object.fromEntries(clients.map((c) => [c.id, c.client_name]));
  const by = {};
  for (const r of month) { const b = by[r.purpose] || (by[r.purpose] = { runs: 0, results: 0, cost_usd: 0 }); b.runs++; b.results += r.items || 0; b.cost_usd += Number(r.cost_usd || 0); }
  for (const b of Object.values(by)) b.cost_usd = Math.round(b.cost_usd * 100) / 100;
  return {
    runs: runs.map((r) => ({ ...r, client_name: r.client_id ? name[r.client_id] || null : null })),
    month: { since: monthStart, runs: month.length, results: month.reduce((s, r) => s + (r.items || 0), 0), cost_usd: Math.round(month.reduce((s, r) => s + Number(r.cost_usd || 0), 0) * 100) / 100, by_purpose: by }
  };
}

module.exports = {
  discover, addByLink, update, remove, refreshNumbers, daily, listFor, pageFor, forOwner, forReport, recentRuns, startJob, jobOf, publicJob, restaurantHandle,
  usualReelViews, closeInterrupted, creatorProfiles, promoteHidden, tracked, shownNumbers, facebookWindow, MIN_FOLLOWERS
};
