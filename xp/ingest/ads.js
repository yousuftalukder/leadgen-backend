// Stage E (v2.8.0, 2026-09-18): ad spend, results and return on ad spend from the Meta ad accounts the
// connected Meta login can read. Tables and readers: migration 0022.
//
// syncAds() runs after each scheduled organic sync (09:00 and 21:00 UTC) and from admin → Ads.
//  1. Ad accounts: me/adaccounts for each Meta login behind an ACTIVE connection. An account appears
//     once its owner shares it with that login (or its business); nothing is set up in XPulse.
//  2. Per account, ad-level insights one day at a time (time_increment=1), in the account's own time
//     zone, with Ads Manager's attribution (use_unified_attribution_setting): the trailing 29 days on
//     every sync, 180 days on an account's first sync, in 30-day slices.
//  3. Each ad is matched to a restaurant by the Facebook Page or Instagram account it runs as (its
//     creative). An ad for a Page that is no client's is kept with no restaurant, so it is looked up
//     once, and its figures are never stored. Ads matched later (a new client) are backfilled.
//  4. One row per ad per day. Meta can attribute messages, leads and purchases to a day for up to 28
//     days, so a row stays open, and is re-read on every sync, until the day is 29 days old; then it
//     closes and never changes (0022's guard). Closed rows are never sent again.
//  5. Campaign names, objectives, status and lifetime totals. Reach is kept per campaign over its whole
//     run: people are never added up across days or campaigns.
// Return on ad spend is purchase value / spend, only where Meta recorded purchase value (fn_ad_summary).
// Nothing here estimates revenue.
const { DateTime } = require('luxon');
const { supabase, q, upsertChunked } = require('../db');
const S = require('../security');
const { GraphClient, GraphError } = require('../meta/graph');

const OPEN_DAYS = 29;           // Meta's longest attribution window is 28 days; one day of margin
const FIRST_SYNC_DAYS = 180;
const SLICE_DAYS = 30;
const INSIGHT_FIELDS = [
  'ad_id', 'ad_name', 'adset_id', 'campaign_id', 'campaign_name', 'objective', 'account_currency',
  'spend', 'impressions', 'reach', 'clicks', 'inline_link_clicks', 'actions', 'action_values', 'purchase_roas',
  'date_start', 'date_stop'
].join(',');
const ACCOUNT_FIELDS = 'id,account_id,name,account_status,currency,timezone_name,business{name}';
const AD_FIELDS = 'id,name,campaign_id,adset_id,creative{id,effective_object_story_id,effective_instagram_media_id,object_story_spec,instagram_user_id}';
const CAMPAIGN_FIELDS = 'id,name,objective,effective_status,start_time,stop_time';
const LIFETIME_FIELDS = 'campaign_id,spend,impressions,reach,inline_link_clicks,date_start,date_stop';

// Meta action types behind each figure, most specific first. The first type present is used, so
// overlapping types (omni_purchase already includes purchase) are never added together.
const ACTIONS = {
  post_engagements: ['post_engagement'],
  video_plays: ['video_view'],
  messages_started: ['onsite_conversion.messaging_conversation_started_7d'],
  leads: ['lead', 'onsite_conversion.lead_grouped'],
  purchases: ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase', 'onsite_web_purchase']
};

const nowIso = () => new Date().toISOString();
const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };
const int = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? Math.round(n) : null; };
const money = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };

// A figure from Meta's actions (or action_values). Meta sent the row, so an action type it does not
// list did not happen that day: 0, not unknown.
function firstAction(list, types) {
  if (!Array.isArray(list)) return 0;
  for (const t of types) {
    const a = list.find((x) => x && x.action_type === t);
    if (a) { const v = Number(a.value); return Number.isFinite(v) ? v : null; }
  }
  return 0;
}

// ---------------------------------------------------------------- matching an ad to a restaurant
function pageOf(creative) {
  if (!creative) return null;
  const spec = creative.object_story_spec || {};
  if (spec.page_id) return String(spec.page_id);
  const story = creative.effective_object_story_id ? String(creative.effective_object_story_id) : '';
  return story.includes('_') ? story.split('_')[0] : null;
}
function igOf(creative) {
  if (!creative) return null;
  const spec = creative.object_story_spec || {};
  const ig = creative.instagram_user_id || spec.instagram_user_id;
  return ig ? String(ig) : null;
}
// index: { pages: Map(pageId → clientId), ig: Map(igUserId → clientId) }
function matchAd(pageId, igUserId, index) {
  if (pageId && index.pages.has(pageId)) return { client_id: index.pages.get(pageId), matched_by: 'facebook_page' };
  if (igUserId && index.ig.has(igUserId)) return { client_id: index.ig.get(igUserId), matched_by: 'instagram_account' };
  return { client_id: null, matched_by: null };
}

async function clientIndex() {
  const [assets, clients] = await Promise.all([
    q(supabase.from('xp_meta_assets').select('client_id,platform,asset_id,status'), 'ads assets'),
    q(supabase.from('xp_clients').select('id,meta_page_id,ig_account_id'), 'ads clients')
  ]);
  const pages = new Map(), ig = new Map();
  for (const c of clients) {
    if (c.meta_page_id) pages.set(String(c.meta_page_id), c.id);
    if (c.ig_account_id) ig.set(String(c.ig_account_id), c.id);
  }
  // The attached assets win over the client's own columns.
  for (const a of assets) {
    if (a.status === 'REMOVED' || !a.client_id) continue;
    (a.platform === 'FB' ? pages : ig).set(String(a.asset_id), a.client_id);
  }
  return { pages, ig };
}

// One insights row → one ad_daily_snapshots row.
function snapshotRow(r, ad, acct) {
  return {
    ad_id: String(r.ad_id),
    metric_date: r.date_start,
    client_id: ad.client_id,
    ad_account_id: acct.ad_account_id,
    campaign_id: r.campaign_id ? String(r.campaign_id) : ad.campaign_id || null,
    currency: r.account_currency || acct.currency || 'USD',
    spend: money(r.spend),
    impressions: int(r.impressions),
    reach: int(r.reach),
    clicks: int(r.clicks),
    link_clicks: int(r.inline_link_clicks),
    post_engagements: firstAction(r.actions, ACTIONS.post_engagements),
    video_plays: firstAction(r.actions, ACTIONS.video_plays),
    messages_started: firstAction(r.actions, ACTIONS.messages_started),
    leads: firstAction(r.actions, ACTIONS.leads),
    purchases: firstAction(r.actions, ACTIONS.purchases),
    purchase_value: money(firstAction(r.action_values, ACTIONS.purchases)),
    actions: Array.isArray(r.actions) ? r.actions : [],
    action_values: Array.isArray(r.action_values) ? r.action_values : [],
    raw: r
  };
}

// The trailing window in the account's time zone, as [since, until] slices of at most SLICE_DAYS.
function slices(since, until, size = SLICE_DAYS) {
  const out = [];
  let s = DateTime.fromISO(since);
  const end = DateTime.fromISO(until);
  while (s <= end) {
    const e = DateTime.min(s.plus({ days: size - 1 }), end);
    out.push({ since: s.toISODate(), until: e.toISODate() });
    s = e.plus({ days: 1 });
  }
  return out;
}

// ---------------------------------------------------------------- run record (sync_runs, run_type ADS)
class AdRun {
  constructor(acct, triggeredBy, since, until) {
    Object.assign(this, { acct, triggeredBy, since, until, errors: [], adsSeen: 0, written: 0, id: null, g: null });
  }
  async start() {
    const r = await q(supabase.from('xp_sync_runs').insert({ client_id: this.acct.client_id || null, asset_id: null, run_type: 'ADS', range_start: this.since, range_end: this.until, triggered_by: this.triggeredBy, status: 'RUNNING' }).select('id').single(), 'ads run');
    this.id = r.id;
  }
  err(step, e) {
    const message = (e && e.message) || String(e);
    const same = this.errors.find((x) => x.step === step && x.message === message);
    if (same) { same.count = (same.count || 1) + 1; return; }
    if (this.errors.length < 30) this.errors.push({ step, message, code: e && e.code, subcode: e && e.subcode, at: nowIso() });
    console.error(`[ads ${this.acct.ad_account_id}] ${step}: ${message}`);
  }
  async finish(fatal) {
    const status = fatal ? 'FAILED' : this.errors.length ? 'PARTIAL' : 'OK';
    if (this.id) await q(supabase.from('xp_sync_runs').update({ status, posts_seen: this.adsSeen, snapshots_written: this.written, api_calls: (this.g && this.g.calls) || 0, errors: this.errors, finished_at: nowIso() }).eq('id', this.id), 'ads run upd').catch(() => {});
    return status;
  }
}

// ---------------------------------------------------------------- Meta logins and ad accounts
// One token per Meta login. v2.8.2: the logins connected for ads only (admin → Ads → Connect ad
// accounts, table meta_ad_logins, 0024) come first, then the newest ACTIVE Page connection of each user.
async function metaLogins() {
  const [adLogins, conns] = await Promise.all([
    q(supabase.from('xp_meta_ad_logins').select('id,meta_user_id,name,token_enc,created_at').eq('status', 'ACTIVE').order('created_at', { ascending: false }), 'ads logins').catch(() => []),
    q(supabase.from('xp_meta_connections').select('id,meta_user_id,token_enc,created_at').eq('status', 'ACTIVE').order('created_at', { ascending: false }), 'ads connections')
  ]);
  const seen = new Set(), out = [];
  for (const c of [...adLogins.map((a) => ({ ...a, adsLoginId: a.id })), ...conns]) {
    const key = c.meta_user_id || c.id;
    if (seen.has(key) || !c.token_enc) continue;
    let token = null;
    try { token = S.decrypt(c.token_enc); } catch { token = null; }
    if (!token) continue;
    seen.add(key);
    out.push({ metaUserId: c.meta_user_id || null, token, adsLoginId: c.adsLoginId || null });
  }
  return out;
}

async function discoverAccounts(g, metaUserId) {
  const rows = await g.paginate('me/adaccounts', { fields: ACCOUNT_FIELDS });
  const ts = nowIso();
  const upserts = rows.map((a) => ({
    ad_account_id: String(a.id), name: a.name || null, currency: a.currency || null, timezone_name: a.timezone_name || null,
    account_status: a.account_status === undefined ? null : a.account_status, business_name: (a.business && a.business.name) || null,
    meta_user_id: metaUserId, last_seen_at: ts
  }));
  if (upserts.length) await upsertChunked('xp_meta_ad_accounts', upserts, 'ad_account_id');
  return upserts.map((u) => u.ad_account_id);
}

// ---------------------------------------------------------------- one ad account
async function lookupAds(g, ids) {
  const res = await g.batch(ids.map((id) => ({ key: id, relative_url: `${id}?fields=${encodeURIComponent(AD_FIELDS)}` })));
  return ids.map((id) => {
    const r = res.get(id);
    if (!r || !r.ok) return { id, error: (r && r.error && r.error.message) || 'no response' };
    return { id, body: r.body };
  });
}

async function syncAccount(g, acct, index, { triggeredBy, days }) {
  const tz = acct.timezone_name || 'UTC';
  const today = DateTime.now().setZone(tz).startOf('day');
  const firstSync = !acct.last_synced_at;
  const known = await q(supabase.from('xp_meta_ads').select('ad_id,client_id,page_id,ig_user_id,campaign_id,lookup_error').eq('ad_account_id', acct.ad_account_id), 'ads known');
  const ads = new Map(known.map((a) => [a.ad_id, a]));

  // Ads with no restaurant are matched again, since a client added later may own them. Ads whose
  // creative could not be read are looked up again. Either way the ad's past days were never
  // stored, so the account is read back FIRST_SYNC_DAYS this time.
  const rematched = [];
  for (const a of known) {
    if (a.client_id || a.lookup_error) continue;
    const m = matchAd(a.page_id, a.ig_user_id, index);
    if (m.client_id) { a.client_id = m.client_id; a.matched_by = m.matched_by; rematched.push(a); }
  }
  const retryErrors = [];
  for (const part of chunk(known.filter((a) => a.lookup_error).map((a) => a.ad_id), 50)) {
    for (const res of await lookupAds(g, part).catch(() => [])) {
      if (res.error) continue;
      const b = res.body || {};
      const page = pageOf(b.creative), ig = igOf(b.creative);
      const m = matchAd(page, ig, index);
      const a = Object.assign(ads.get(res.id), { page_id: page, ig_user_id: ig, client_id: m.client_id, matched_by: m.matched_by, lookup_error: null });
      retryErrors.push(a);
      if (m.client_id) rematched.push(a);
    }
  }

  const span = days || (firstSync || rematched.length ? FIRST_SYNC_DAYS : OPEN_DAYS);
  const since = today.minus({ days: span - 1 }).toISODate(), until = today.toISODate();
  const run = new AdRun(acct, triggeredBy, since, until);
  await run.start();
  run.g = g;
  try {
    const changed = [...new Map([...rematched, ...retryErrors].map((a) => [a.ad_id, a])).values()];
    if (changed.length) {
      await upsertChunked('xp_meta_ads', changed.map((a) => ({ ad_id: a.ad_id, ad_account_id: acct.ad_account_id, client_id: a.client_id, matched_by: a.matched_by || null, page_id: a.page_id || null, ig_user_id: a.ig_user_id || null, lookup_error: a.lookup_error || null, updated_at: nowIso() })), 'ad_id');
    }

    // 1. Insights, one day per row per ad.
    const rows = [];
    for (const sl of slices(since, until)) {
      try {
        rows.push(...await g.paginate(`${acct.ad_account_id}/insights`, {
          level: 'ad', time_increment: 1, time_range: JSON.stringify(sl), fields: INSIGHT_FIELDS,
          use_unified_attribution_setting: true, limit: 500
        }));
      } catch (e) {
        if (e instanceof GraphError && (e.isAuth || e.isNotFound)) throw e;   // the whole account is unreadable
        run.err(`insights ${sl.since}..${sl.until}`, e);
      }
    }
    const adIds = [...new Set(rows.map((r) => String(r.ad_id)))];
    run.adsSeen = adIds.length;

    // 2. Ads never seen before: which restaurant? (Earlier lookup failures were retried above.)
    const toLookUp = adIds.filter((id) => !ads.has(id));
    const byId = new Map(rows.map((r) => [String(r.ad_id), r]));
    const newAds = [];
    for (const part of chunk(toLookUp, 50)) {
      for (const res of await lookupAds(g, part)) {
        const seen = byId.get(res.id) || {};
        const base = { ad_id: res.id, ad_account_id: acct.ad_account_id, campaign_id: seen.campaign_id ? String(seen.campaign_id) : null, adset_id: seen.adset_id ? String(seen.adset_id) : null, name: seen.ad_name || null, updated_at: nowIso() };
        if (res.error) {
          run.err('ad lookup', new Error(res.error));
          newAds.push({ ...base, client_id: null, matched_by: null, page_id: null, ig_user_id: null, lookup_error: String(res.error).slice(0, 300) });
          continue;
        }
        const b = res.body || {};
        const page = pageOf(b.creative), ig = igOf(b.creative);
        const m = matchAd(page, ig, index);
        newAds.push({ ...base, name: b.name || base.name, campaign_id: b.campaign_id ? String(b.campaign_id) : base.campaign_id, adset_id: b.adset_id ? String(b.adset_id) : base.adset_id, client_id: m.client_id, matched_by: m.matched_by, page_id: page, ig_user_id: ig, lookup_error: null });
      }
    }
    if (newAds.length) await upsertChunked('xp_meta_ads', newAds, 'ad_id');
    for (const a of newAds) ads.set(a.ad_id, a);

    // 3. Rows for the restaurants' ads, minus days already closed.
    const mine = rows.filter((r) => { const a = ads.get(String(r.ad_id)); return a && a.client_id; });
    const closed = new Set();
    if (mine.length) {
      const finals = await q(supabase.from('xp_ad_daily_snapshots').select('ad_id,metric_date').eq('ad_account_id', acct.ad_account_id).eq('is_final', true).gte('metric_date', since).lte('metric_date', until), 'ads final keys');
      for (const f of finals) closed.add(`${f.ad_id}|${f.metric_date}`);
    }
    const snaps = mine.filter((r) => !closed.has(`${r.ad_id}|${r.date_start}`)).map((r) => snapshotRow(r, ads.get(String(r.ad_id)), acct));
    if (snaps.length) run.written = await upsertChunked('xp_ad_daily_snapshots', snaps, 'ad_id,metric_date');

    // 4. Close the days Meta can no longer change.
    const cutoff = today.minus({ days: OPEN_DAYS }).toISODate();
    await q(supabase.from('xp_ad_daily_snapshots').update({ is_final: true }).eq('ad_account_id', acct.ad_account_id).eq('is_final', false).lte('metric_date', cutoff), 'ads close days');

    // 5. Campaigns of the restaurants' ads seen in this window: names, status, lifetime totals.
    const campaigns = new Map();   // campaign_id → Set(client_id)
    for (const r of mine) {
      const cid = r.campaign_id ? String(r.campaign_id) : null;
      if (!cid) continue;
      if (!campaigns.has(cid)) campaigns.set(cid, new Set());
      campaigns.get(cid).add(ads.get(String(r.ad_id)).client_id);
    }
    if (campaigns.size) await syncCampaigns(g, acct, campaigns, rows, run);

    // 6. An account whose ads ALL belong to one restaurant is that restaurant's. One ad for another
    //    Page (an agency account) and it belongs to none; an ad whose creative could not be read
    //    does not count either way.
    if (!acct.client_id) {
      const all = await q(supabase.from('xp_meta_ads').select('client_id,lookup_error').eq('ad_account_id', acct.ad_account_id), 'ads owners');
      const readable = all.filter((a) => !a.lookup_error);
      const set = new Set(readable.map((a) => a.client_id || null));
      if (readable.length && set.size === 1 && !set.has(null)) {
        await q(supabase.from('xp_meta_ad_accounts').update({ client_id: [...set][0] }).eq('ad_account_id', acct.ad_account_id).is('client_id', null), 'ads account owner');
      }
    }

    await q(supabase.from('xp_meta_ad_accounts').update({ last_synced_at: nowIso(), last_error: run.errors.length ? run.errors[0].message.slice(0, 300) : null }).eq('ad_account_id', acct.ad_account_id), 'ads account synced');
    const status = await run.finish(false);
    return { ad_account: acct.ad_account_id, name: acct.name, status, since, until, ads_seen: run.adsSeen, rows_written: run.written, campaigns: campaigns.size, api_calls: g.calls };
  } catch (e) {
    run.err('account', e);
    await q(supabase.from('xp_meta_ad_accounts').update({ last_error: String(e.message || e).slice(0, 300) }).eq('ad_account_id', acct.ad_account_id), 'ads account error').catch(() => {});
    const status = await run.finish(true);
    return { ad_account: acct.ad_account_id, name: acct.name, status, error: e.message };
  }
}

async function syncCampaigns(g, acct, campaigns, rows, run) {
  const ids = [...campaigns.keys()];
  const info = new Map();
  for (const part of chunk(ids, 50)) {
    const res = await g.batch(part.map((id) => ({ key: id, relative_url: `${id}?fields=${encodeURIComponent(CAMPAIGN_FIELDS)}` })));
    for (const id of part) { const r = res.get(id); if (r && r.ok) info.set(id, r.body || {}); else run.err('campaign lookup', (r && r.error) || new Error('no response')); }
  }
  const lifetime = new Map();
  for (const part of chunk(ids, 50)) {
    try {
      const rs = await g.paginate(`${acct.ad_account_id}/insights`, {
        level: 'campaign', date_preset: 'maximum', fields: LIFETIME_FIELDS,
        filtering: JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: part }]), limit: 100
      });
      for (const r of rs) lifetime.set(String(r.campaign_id), r);
    } catch (e) { run.err('campaign lifetime', e); }
  }
  const nameFromRows = new Map(rows.map((r) => [String(r.campaign_id), r]));
  const ts = nowIso();
  const upserts = ids.map((id) => {
    const i = info.get(id) || {}, l = lifetime.get(id), seen = nameFromRows.get(id) || {};
    const owners = campaigns.get(id);
    const row = {
      campaign_id: id, ad_account_id: acct.ad_account_id,
      client_id: owners.size === 1 ? [...owners][0] : null,   // a campaign for several restaurants belongs to none
      name: i.name || seen.campaign_name || null, objective: i.objective || seen.objective || null,
      status: i.effective_status || null, start_time: i.start_time || null, stop_time: i.stop_time || null, updated_at: ts
    };
    if (l) Object.assign(row, { lifetime_spend: money(l.spend), lifetime_impressions: int(l.impressions), lifetime_reach: int(l.reach), lifetime_link_clicks: int(l.inline_link_clicks), lifetime_from: l.date_start || null, lifetime_to: l.date_stop || null, lifetime_as_of: ts });
    return row;
  });
  await upsertChunked('xp_meta_ad_campaigns', upserts, 'campaign_id');
}

// ---------------------------------------------------------------- entry point
let running = null;
async function syncAds({ triggeredBy = 'manual', days = null } = {}) {
  if (running) return { skipped: 'An ads sync is already running.' };
  running = (async () => {
    const out = { accounts: [], logins: 0, errors: [] };
    const logins = await metaLogins();
    out.logins = logins.length;
    const index = await clientIndex();
    const visible = new Set();
    const clientFor = new Map();
    for (const l of logins) {
      const g = new GraphClient({ token: l.token });
      try {
        const ids = await discoverAccounts(g, l.metaUserId);
        for (const id of ids) { visible.add(id); if (!clientFor.has(id)) clientFor.set(id, g); }
        if (l.adsLoginId) await q(supabase.from('xp_meta_ad_logins').update({ ad_accounts_seen: ids.length, last_error: null, updated_at: nowIso() }).eq('id', l.adsLoginId), 'ads login seen').catch(() => {});
      } catch (e) {
        out.errors.push({ step: 'discover ad accounts', message: e.message, code: e.code });
        if (l.adsLoginId) await q(supabase.from('xp_meta_ad_logins').update({ last_error: String(e.message).slice(0, 300), updated_at: nowIso() }).eq('id', l.adsLoginId), 'ads login error').catch(() => {});
      }
    }
    if (!visible.size) return out;
    const accts = await q(supabase.from('xp_meta_ad_accounts').select('*').in('ad_account_id', [...visible]).eq('is_active', true).order('name'), 'ads accounts');
    for (const acct of accts) {
      const g = clientFor.get(acct.ad_account_id);
      g.calls = 0;
      out.accounts.push(await syncAccount(g, acct, index, { triggeredBy, days }));
    }
    return out;
  })();
  try { return await running; } finally { running = null; }
}

module.exports = { syncAds, snapshotRow, matchAd, pageOf, igOf, firstAction, slices, ACTIONS, OPEN_DAYS, FIRST_SYNC_DAYS };
