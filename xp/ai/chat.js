// Client chat: Gemini decides which SQL function to call (and with what dates); the backend runs it and
// hands the numbers back; the model narrates. The model never sees raw tables and is told to quote only
// numbers returned by tools. Conversations persist in ai_conversations / ai_messages.
//
// C-1 (2026-09-09): rewired onto the migration 0006 query layer. Before this, chat.js exposed 8 tools
// built on the 0001 views while the 14 functions delivered in 0006 were wired to nothing — the model
// literally could not answer "which format works best" or "when should we post". One number, one
// function, so the chat and the report cannot disagree in front of a client.
//
// C-4 / v2.6 (2026-09-14):
//   * get_period_summary now returns fn_period_bundle — summary + settlement + conventions + paid
//     split in one round trip. Most questions resolve in ONE tool round instead of three or four.
//   * get_settlement and get_paid_split added (17 tools).
//   * Nothing internal reaches the model, so nothing internal can reach the client: settlement
//     statuses are translated here (publicSettlement) into verified / still updating / not verified
//     / earlier method before the model sees them. Convention codes are stripped; only the notes,
//     which are written for clients, are passed through.
//   * Speed: tool calls within a round run in parallel; the three opening reads run in parallel;
//     history is trimmed; the thinking budget is capped (GEMINI_THINKING_BUDGET); the reply streams.
//
// v2.7 (2026-09-18):
//   * Figure panels: charts.panelsFor() turns this answer's tool results into panels the portal draws
//     under the text (headline figures, this-vs-last comparisons, daily bars, followers, rankings).
//     Built from the tool results in code, never from the model.
//   * The answer is figures first and short: headline, the key figures, one analogy, what it means.
//   * Follower days reach the model as measured or estimated. "frozen estimate" came from rule 4 and
//     the FROZEN_ESTIMATE basis, and a client read it in an answer (F-48).
const { DateTime } = require('luxon');
const cfg = require('../config');
const { supabase, q } = require('../db');
const { panelsFor } = require('./charts');
const influencers = require('../social/influencers');

const MAX_ROUNDS = 8;
const OUT_OF_ROUNDS = '__out_of_rounds__';
const HISTORY_KEEP = 12;   // most recent messages handed to the model (plus the first user message)
const rpc = (fn, args, label) => q(supabase.rpc(fn, args), label);

// ---------------------------------------------------------------- C-4: client-facing translation
// The database says settled / unsettled / unobserved / timer_lock / open. The client hears
// verified / not verified / not verified / measured by an earlier method / still updating.
// Translation happens HERE, before the model sees the numbers, so the internal words never exist
// in the model's context and cannot be echoed to a client.
const PLATFORM_NAME = { IG: 'Instagram', FB: 'Facebook' };
function publicSettlement(settle) {
  const out = {};
  for (const [plat, s] of Object.entries(settle || {})) {
    const verified = Number(s.days_settled || 0);
    const updating = Number(s.days_open || 0);
    const notVerified = Number(s.days_unsettled || 0) + Number(s.days_unobserved || 0);
    const earlier = Number(s.days_timer_lock || 0);
    const revised = Number(s.days_drifted || 0);
    const parts = [];
    if (verified) parts.push(`${verified} verified`);
    if (updating) parts.push(`${updating} still updating`);
    if (notVerified) parts.push(`${notVerified} not verified`);
    if (earlier) parts.push(`${earlier} measured by an earlier method`);
    const sentence = parts.length
      ? `${PLATFORM_NAME[plat] || plat} reach, ${s.days_in_period} days: ${parts.join(', ')}` + (revised ? `; Meta has revised ${revised} day(s) since` : '') + '.'
      : `${PLATFORM_NAME[plat] || plat} reach: no days recorded in this period.`;
    out[plat] = {
      days_in_period: Number(s.days_in_period || 0),
      days_verified: verified, days_still_updating: updating, days_not_verified: notVerified,
      days_earlier_method: earlier, days_revised_by_meta: revised,
      reach_verified: Number(s.reach_trusted || 0), reach_total: Number(s.reach_total || 0),
      sentence
    };
  }
  return out;
}
const DAY_STATUS_PUBLIC = { settled: 'verified', open: 'still updating', unsettled: 'not verified', unobserved: 'not verified', timer_lock: 'earlier method' };
// data_conventions rows carry an engineer's code (convention) and a client-worded note. Only the
// note, its span and the platform/family go to the model. The family is an engineer's word too:
// reports printed "Instagram total_value" to clients, so it is named by the figures it covers.
const METRIC_FAMILY_PUBLIC = { reach: 'reach', total_value: 'views, interactions and profile visits', engagements: 'engagement', followers: 'followers' };
function publicConventions(rows) {
  return (rows || []).map((c) => ({ platform: PLATFORM_NAME[c.platform] || c.platform, metric: METRIC_FAMILY_PUBLIC[c.metric_family] || c.metric_family, from: c.effective_from, to: c.effective_to, note: c.note }));
}
// The database marks each follower day MEASURED, LIVE_ESTIMATE or FROZEN_ESTIMATE. The client hears
// measured or estimated, and whether Meta is still counting the day.
function publicFollowerDay(r) {
  const total = r.followers_total === undefined ? null : r.followers_total;
  return {
    platform: r.platform, date: r.metric_date, followers_total: total,
    followers_gained: r.followers_gained === undefined ? null : r.followers_gained,
    basis: total === null ? null : r.basis === 'MEASURED' ? 'measured' : 'estimated',
    still_updating: r.is_final === false
  };
}
// Facebook's account-level "impressions" hold page_media_view, which Meta now calls Views (F-52). The
// chat tools hand them to the model as views, so the retired word cannot reach a client: account
// impressions (and their day count) become views, the paid/organic split impressions_* becomes views_*,
// compare key account.impressions becomes account.views, daily account_impressions becomes account_views.
// Post-level fields keep their names. Instagram's views are already views. Chat tools only: the portal's
// metrics endpoint and the PDF read the database names.
function fbAccountViews(account) {
  if (!account || typeof account !== 'object' || !('impressions' in account)) return account;
  const { impressions, ...rest } = account;
  const out = { ...rest, views: impressions };
  if (account.days_by_metric && 'impressions' in account.days_by_metric) {
    const { impressions: days, ...dm } = account.days_by_metric;
    out.days_by_metric = { ...dm, views: days };
  }
  return out;
}
// The same for Facebook posts' gains in a period (v2.8.1, F-56): content.views_gained holds video plays
// and content.impressions_gained holds Meta's post Views. Views become the post views; the plays stay as
// video_views_gained. Used by the chat and by the report (loadReportData).
function fbContentViews(content) {
  if (!content || typeof content !== 'object' || !('impressions_gained' in content)) return content;
  const { impressions_gained, ...rest } = content;
  return { ...rest, views_gained: impressions_gained };
}
function fbSummaryViews(summary) {
  const fb = summary && summary.platforms && summary.platforms.FB;
  if (!fb || (!fb.account && !fb.content)) return summary;
  return { ...summary, platforms: { ...summary.platforms, FB: { ...fb, account: fbAccountViews(fb.account), content: fbContentViews(fb.content) } } };
}
function fbSplitViews(split) {
  if (!split || !split.FB) return split;
  return { ...split, FB: Object.fromEntries(Object.entries(split.FB).map(([k, v]) => [k.replace(/^impressions_/, 'views_'), v])) };
}
function fbCompareViews(r) {
  if (!r || !r.deltas) return r;
  let fb = r.deltas.FB;
  if (fb) {
    fb = Object.fromEntries(Object.entries(fb).map(([k, v]) => [k === 'account.impressions' ? 'account.views' : k, v]));
    if ('content.impressions_gained' in fb) { fb['content.views_gained'] = fb['content.impressions_gained']; delete fb['content.impressions_gained']; }
  }
  return { ...r, current_summary: fbSummaryViews(r.current_summary), previous_summary: fbSummaryViews(r.previous_summary), deltas: { ...r.deltas, FB: fb } };
}
function fbDailyViews(rows) {
  return (rows || []).map((x) => {
    if (!x || x.platform !== 'FB' || !('account_impressions' in x)) return x;
    const { account_impressions, ...rest } = x;
    return { ...rest, account_views: account_impressions };
  });
}
// v2.8.1 (F-56): a post's views are Meta's Views on both platforms. For a Facebook post the database
// holds them as impressions (post_media_view) and keeps video plays (post_video_views) as views, so
// rows read straight from the views (post search, post history) are renamed here: views ← impressions,
// views_gained ← impressions_gained, and the plays stay as video_views. fn_content_table does the
// same in SQL (0023). Instagram rows are already right.
function postViews(r) {
  if (!r || typeof r !== 'object') return r;
  const { impressions, impressions_gained, ...rest } = r;
  if (r.platform !== 'FB') return rest;
  const out = { ...rest, views: impressions === undefined ? null : impressions, video_views: r.video_views !== undefined ? r.video_views : r.views };
  if ('views_gained' in r || impressions_gained !== undefined) out.views_gained = impressions_gained === undefined ? null : impressions_gained;
  return out;
}

function publicBundle(b) {
  return {
    ...(b.summary || {}),
    settlement: publicSettlement(b.settlement),
    paid_split: b.paid_split || {},
    conventions: publicConventions(b.conventions)
  };
}

// ---------------------------------------------------------------- Stage E (v2.8): ads in client words
// fn_ad_summary / fn_ad_campaigns speak Meta: objectives like OUTCOME_ENGAGEMENT, statuses like
// CAMPAIGN_PAUSED, impressions, roas. The model gets them as an owner would say them.
const AD_OBJECTIVE_PUBLIC = {
  OUTCOME_AWARENESS: 'awareness', OUTCOME_ENGAGEMENT: 'engagement', OUTCOME_TRAFFIC: 'link clicks', OUTCOME_LEADS: 'leads',
  OUTCOME_SALES: 'sales', OUTCOME_APP_PROMOTION: 'app installs', BRAND_AWARENESS: 'awareness', REACH: 'awareness',
  POST_ENGAGEMENT: 'engagement', PAGE_LIKES: 'page likes', EVENT_RESPONSES: 'event responses', LINK_CLICKS: 'link clicks',
  MESSAGES: 'messages', LEAD_GENERATION: 'leads', CONVERSIONS: 'sales', PRODUCT_CATALOG_SALES: 'sales',
  STORE_VISITS: 'store visits', LOCAL_AWARENESS: 'local awareness', VIDEO_VIEWS: 'video views', APP_INSTALLS: 'app installs'
};
const AD_STATUS_PUBLIC = {
  ACTIVE: 'running', PAUSED: 'paused', CAMPAIGN_PAUSED: 'paused', ADSET_PAUSED: 'paused', ARCHIVED: 'ended', DELETED: 'deleted',
  IN_PROCESS: 'starting', WITH_ISSUES: 'needs attention', PENDING_REVIEW: 'in review', DISAPPROVED: 'rejected by Meta',
  PREAPPROVED: 'approved', PENDING_BILLING_INFO: 'waiting for payment details'
};
const adNum = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
function adFigures(t) {
  if (!t) return null;
  return {
    currency: t.currency, spend: adNum(t.spend), ad_views: adNum(t.ad_views), clicks: adNum(t.clicks), link_clicks: adNum(t.link_clicks),
    messages_started: adNum(t.messages_started), leads: adNum(t.leads), purchases: adNum(t.purchases), purchase_value: adNum(t.purchase_value),
    post_engagements: adNum(t.post_engagements), video_plays: adNum(t.video_plays),
    return_on_ad_spend: adNum(t.roas), cost_per_link_click: adNum(t.cost_per_link_click), cost_per_message: adNum(t.cost_per_message),
    cost_per_lead: adNum(t.cost_per_lead), cost_per_purchase: adNum(t.cost_per_purchase), cost_per_1000_ad_views: adNum(t.cost_per_1000_views),
    link_click_rate_pct: adNum(t.link_click_rate_pct), days_with_spend: adNum(t.days_with_spend), days_still_updating: adNum(t.days_still_updating),
    campaigns: adNum(t.campaigns)
  };
}
function publicCampaign(c) {
  const life = c.lifetime || null;
  return {
    name: c.name, objective: AD_OBJECTIVE_PUBLIC[c.objective] || (c.objective ? String(c.objective).toLowerCase().replace(/^outcome_/, '').replace(/_/g, ' ') : null),
    status: AD_STATUS_PUBLIC[c.status] || null, currency: c.currency,
    spend: adNum(c.spend), ad_views: adNum(c.ad_views), link_clicks: adNum(c.link_clicks), messages_started: adNum(c.messages_started),
    leads: adNum(c.leads), purchases: adNum(c.purchases), purchase_value: adNum(c.purchase_value), post_engagements: adNum(c.post_engagements),
    return_on_ad_spend: adNum(c.roas), cost_per_link_click: adNum(c.cost_per_link_click), cost_per_message: adNum(c.cost_per_message),
    first_day: c.first_day, last_day: c.last_day,
    people_reached_whole_run: life ? adNum(life.reach) : null, spend_whole_run: life ? adNum(life.spend) : null,
    whole_run_from: life ? life.from : null, whole_run_to: life ? life.to : null
  };
}
const ROAS_NONE = 'Meta recorded no purchase value for these ads, so return on ad spend cannot be measured. Use the cost per result instead.';
function publicAds(s, campaigns, clientTz) {
  const out = { period: s.period, connected: !!s.connected };
  if (!s.connected) {
    out.note = 'No ad account is connected for this restaurant yet, so ad spend, ad results and return on ad spend are not available. Facebook paid views (from boosts and ads) are still available from the paid/organic split.';
    return out;
  }
  out.ad_figures_from = s.data_from || null;
  const zones = [...new Set((s.ad_accounts || []).map((a) => a.timezone).filter(Boolean))];
  if (zones.some((z) => z !== clientTz)) out.time_zone_note = `Ad days follow the ad account's time zone (${zones.join(', ')}).`;
  const byCur = s.by_currency || [];
  if (!s.totals) {
    if (byCur.length > 1) {
      out.by_currency = byCur.map(adFigures);
      out.note = 'The ads were paid in more than one currency. Each currency is shown on its own; never add them together.';
    } else {
      out.totals = null;
      out.note = 'Meta shows no ad spend for this restaurant in this period.';
    }
  } else {
    out.totals = adFigures(s.totals);
    out.return_on_ad_spend_note = out.totals.return_on_ad_spend === null
      ? ROAS_NONE
      : 'Return on ad spend = the purchase value Meta recorded from these ads, divided by the amount spent.';
    if (out.totals.days_still_updating) out.still_updating_note = 'Meta can still add messages, leads and purchases to the last 28 days, so those can rise a little. Spend, ad views and clicks are complete.';
  }
  out.campaigns = (campaigns || []).map(publicCampaign);
  return out;
}
// Current against previous, worked out here so the model never subtracts (rule 1). Same currency only.
const AD_COMPARE_KEYS = ['spend', 'ad_views', 'link_clicks', 'messages_started', 'leads', 'purchases', 'purchase_value', 'return_on_ad_spend', 'cost_per_link_click', 'cost_per_message'];
const roundTo = (x, places) => { const f = 10 ** places; return (Math.sign(x) * Math.round(Math.abs(x) * f)) / f; };   // half away from zero, as Postgres
function adChanges(cur, prev) {
  if (!cur || !prev || cur.currency !== prev.currency) return null;
  const out = {};
  for (const k of AD_COMPARE_KEYS) {
    const c = cur[k] === undefined ? null : cur[k], p = prev[k] === undefined ? null : prev[k];
    if (c === null && p === null) continue;
    const change = c !== null && p !== null ? roundTo(c - p, 2) : null;
    out[k] = { current: c, previous: p, change, change_pct: change !== null && p ? roundTo(((c - p) * 100) / p, 1) : null };
  }
  return out;
}

// ---------------------------------------------------------------- tools (SQL-backed)
const TOOLS = {
  // ---- period shape -------------------------------------------------------
  get_period_summary: {
    description: 'Headline numbers for a date range, per platform: posts published, content gains (reach, views, likes, comments, shares, saves), account metrics (views, reach, visits, engagement), follower start/end/net with provenance, engagement rate, per-metric coverage, PLUS settlement (how many days of reach are verified / still updating / not verified / earlier method, with a ready-made sentence per platform), the Facebook paid/organic views split, and any conventions in force. One call answers most "how did we do" questions — call this first.',
    parameters: { type: 'OBJECT', properties: { start: { type: 'STRING', description: 'YYYY-MM-DD' }, end: { type: 'STRING', description: 'YYYY-MM-DD' } }, required: ['start', 'end'] },
    run: async (c, a) => { const b = publicBundle(await rpc('fn_period_bundle', { p_client: c.id, p_start: a.start, p_end: a.end }, 'bundle')); return { ...fbSummaryViews(b), paid_split: fbSplitViews(b.paid_split) }; }
  },
  get_settlement: {
    description: 'Whether the reach figures for a period can be trusted yet, day by day: each day is verified (Meta has stopped changing it), still updating, not verified, or measured by an earlier method. Use for "is this final", "can I trust this number", "why did last week change", or when the user asks how sure you are. Per-period totals are already inside get_period_summary; this is the per-day detail.',
    parameters: { type: 'OBJECT', properties: { start: { type: 'STRING' }, end: { type: 'STRING' }, platform: { type: 'STRING', description: 'IG or FB; omit for both' } }, required: ['start', 'end'] },
    run: async (c, a) => {
      const assets = await q(supabase.from('xp_meta_assets').select('id,platform,name').eq('client_id', c.id), 'assets');
      const wanted = assets.filter((x) => !a.platform || x.platform === a.platform);
      const per = await Promise.all(wanted.map(async (x) => {
        const rows = await rpc('fn_reach_settlement', { p_asset: x.id, p_start: a.start, p_end: a.end }, 'settlement');
        return [x.platform, rows.map((r) => ({ date: r.metric_date, reach: r.reach, status: DAY_STATUS_PUBLIC[r.lock_basis] || 'still updating', revised_by_meta_since: r.post_lock_drift !== null && r.post_lock_drift !== undefined ? r.post_lock_drift : null }))];
      }));
      const period = publicSettlement(await rpc('fn_period_settlement', { p_client: c.id, p_start: a.start, p_end: a.end }, 'period settlement'));
      return { period, days: Object.fromEntries(per) };
    }
  },
  get_paid_split: {
    description: 'Facebook views split into organic and paid (boosted posts / ads) for a period, with how many days carry the split and the paid share as a percentage. Instagram has no split — its figures are organic and paid combined, and the tool says so. Use for "how much of that was paid", "did the boost work", "organic vs paid".',
    parameters: { type: 'OBJECT', properties: { start: { type: 'STRING' }, end: { type: 'STRING' } }, required: ['start', 'end'] },
    run: async (c, a) => fbSplitViews(await rpc('fn_paid_split', { p_client: c.id, p_start: a.start, p_end: a.end }, 'paid split'))
  },
  get_ad_performance: {
    description: 'Paid ads for a period, from the restaurant\'s Meta ad accounts (boosted posts and Ads Manager ads): money spent, ad views (how many times the ads were seen), link clicks, messages started, leads, purchases and purchase value, return on ad spend (only when Meta recorded purchase value), cost per result, and each campaign with its objective, status and the people it reached over its whole run. Pass prev_start/prev_end to compare with another period: the changes are worked out for you. Use for "how are my ads doing", "how much did we spend", "ROAS", "return on ad spend", "was the boost worth it", "cost per click", "which campaign worked". If no ad account is connected, it says so.',
    parameters: { type: 'OBJECT', properties: { start: { type: 'STRING' }, end: { type: 'STRING' }, prev_start: { type: 'STRING', description: 'optional comparison period start' }, prev_end: { type: 'STRING', description: 'optional comparison period end' }, limit: { type: 'INTEGER', description: 'campaigns to list, default 10' } }, required: ['start', 'end'] },
    run: async (c, a) => {
      const tz = c.timezone || 'America/New_York';
      const [s, camps] = await Promise.all([
        rpc('fn_ad_summary', { p_client: c.id, p_start: a.start, p_end: a.end }, 'ads'),
        rpc('fn_ad_campaigns', { p_client: c.id, p_start: a.start, p_end: a.end, p_limit: Math.min(a.limit || 10, 25) }, 'ad campaigns')
      ]);
      const out = publicAds(s, camps, tz);
      if (a.prev_start && a.prev_end && out.connected) {
        const prev = publicAds(await rpc('fn_ad_summary', { p_client: c.id, p_start: a.prev_start, p_end: a.prev_end }, 'ads prev'), [], tz);
        out.previous = { period: prev.period, totals: prev.totals || null, note: prev.note || null };
        out.changes = adChanges(out.totals, prev.totals);
      }
      return out;
    }
  },
  compare_periods: {
    description: 'Two periods side by side with absolute and percentage change per metric, per platform. Use for "vs last month", "compared to before", "are we up or down". Prefer this over calling get_period_summary twice — it does the arithmetic in SQL so no figure is computed in your head. If the comparison period is omitted it defaults to the immediately preceding period of equal length.',
    parameters: { type: 'OBJECT', properties: { start: { type: 'STRING' }, end: { type: 'STRING' }, prev_start: { type: 'STRING' }, prev_end: { type: 'STRING' } }, required: ['start', 'end'] },
    run: async (c, a) => fbCompareViews(await rpc('fn_compare_periods', { p_client: c.id, p_start: a.start, p_end: a.end, p_prev_start: a.prev_start || null, p_prev_end: a.prev_end || null }, 'compare'))
  },

  // ---- content ------------------------------------------------------------
  get_content_table: {
    description: 'Every post published in the period with its format, publish date, caption, permalink and lifetime counters as of the period end: views (how many times it was seen, Meta\'s Views on both platforms), reach, interactions, and views/reach gained in the period. Use when asked to list, review or audit the content itself rather than rank it. Order by views, reach, interactions or date.',
    parameters: { type: 'OBJECT', properties: { start: { type: 'STRING' }, end: { type: 'STRING' }, order: { type: 'STRING', description: 'views | reach | interactions | recent — default views' }, limit: { type: 'INTEGER', description: 'default 200' } }, required: ['start', 'end'] },
    run: (c, a) => rpc('fn_content_table', { p_client: c.id, p_start: a.start, p_end: a.end, p_limit: Math.min(a.limit || 200, 200), p_order: a.order === 'date' ? 'recent' : (a.order || 'views') }, 'content')
  },
  get_top_posts: {
    description: 'Posts ranked by a metric within the period — by views unless asked otherwise — with format, publish date, caption, permalink, lifetime views and reach, and views, reach and interactions gained in the period. Use for "best post", "what performed", "top 5".',
    parameters: { type: 'OBJECT', properties: { start: { type: 'STRING' }, end: { type: 'STRING' }, order: { type: 'STRING', description: 'views | reach | interactions — default views' }, platform: { type: 'STRING', description: 'IG or FB; omit for both' }, limit: { type: 'INTEGER', description: 'default 10' } }, required: ['start', 'end'] },
    // Was 20,000 delta rows pulled into Node and aggregated in a Map. fn_top_posts does it in SQL,
    // over the same definition the report uses — which is the point. v2.8.1: views lead (0023 made a
    // post's views Meta's Views on both platforms, and ranking by views real).
    run: (c, a) => rpc('fn_top_posts', { p_client: c.id, p_start: a.start, p_end: a.end, p_limit: Math.min(a.limit || 10, 50), p_order: a.order || 'views', p_platform: a.platform || null }, 'top posts')
  },
  get_format_breakdown: {
    description: 'Performance grouped by content format (reel, carousel, image, video, text) per platform: how many were published, and total and average views, reach and interactions per post (views are Meta\'s Views on both platforms). Use for "what type of content works", "should we post more reels".',
    parameters: { type: 'OBJECT', properties: { start: { type: 'STRING' }, end: { type: 'STRING' } }, required: ['start', 'end'] },
    run: (c, a) => rpc('fn_format_breakdown', { p_client: c.id, p_start: a.start, p_end: a.end }, 'formats')
  },
  get_posting_pattern: {
    description: 'Performance grouped by day of week and hour of day, in the client timezone, with post counts and average views and reach per post. Use for "when should we post", "what is our best day".',
    parameters: { type: 'OBJECT', properties: { start: { type: 'STRING' }, end: { type: 'STRING' } }, required: ['start', 'end'] },
    run: (c, a) => rpc('fn_posting_pattern', { p_client: c.id, p_start: a.start, p_end: a.end }, 'pattern')
  },
  get_stories: {
    description: 'Instagram stories published in the period: count, reach, views, replies, navigation and follow-throughs. Stories are separate from feed posts and are never included in post totals.',
    parameters: { type: 'OBJECT', properties: { start: { type: 'STRING' }, end: { type: 'STRING' } }, required: ['start', 'end'] },
    run: (c, a) => rpc('fn_stories_summary', { p_client: c.id, p_start: a.start, p_end: a.end }, 'stories')
  },
  get_hashtags: {
    description: 'Hashtags used in the period ranked by the reach and interactions of the posts carrying them, with usage counts. Use for "which hashtags work".',
    parameters: { type: 'OBJECT', properties: { start: { type: 'STRING' }, end: { type: 'STRING' }, limit: { type: 'INTEGER' } }, required: ['start', 'end'] },
    run: (c, a) => rpc('fn_hashtag_performance', { p_client: c.id, p_start: a.start, p_end: a.end, p_limit: Math.min(a.limit || 25, 50) }, 'hashtags')
  },

  // ---- audience and conversation -----------------------------------------
  get_audience: {
    description: 'Follower and engaged-audience demographics — age and gender, top cities, top countries — as most recently observed. Demographics are a snapshot of now, not a series, so they cannot be reported "for August".',
    parameters: { type: 'OBJECT', properties: { asof: { type: 'STRING', description: 'YYYY-MM-DD; omit for latest' } } },
    run: (c, a) => rpc('fn_audience', { p_client: c.id, p_asof: a.asof || a.end || null }, 'audience')
  },
  get_comments_digest: {
    description: 'Comments in the period grouped by post, with author, text, like count and sentiment where scored, plus totals and unique commenter counts. Use for "what are people saying", "any negative feedback".',
    parameters: { type: 'OBJECT', properties: { start: { type: 'STRING' }, end: { type: 'STRING' }, limit: { type: 'INTEGER' } }, required: ['start', 'end'] },
    run: (c, a) => rpc('fn_comments_digest', { p_client: c.id, p_start: a.start, p_end: a.end, p_limit: Math.min(a.limit || 25, 100) }, 'comments')
  },

  // ---- series -------------------------------------------------------------
  get_followers_series: {
    description: 'Daily follower totals and daily gains per platform. Each day is marked measured (read from Meta) or estimated (worked out from the days around it), and still_updating while Meta is still counting that day. Never present an estimate as a reading. Use for follower growth and for any follower chart.',
    parameters: { type: 'OBJECT', properties: { start: { type: 'STRING' }, end: { type: 'STRING' } }, required: ['start', 'end'] },
    run: async (c, a) => (await rpc('fn_followers_series', { p_client: c.id, p_start: a.start, p_end: a.end }, 'followers') || []).map(publicFollowerDay)
  },
  get_daily_series: {
    description: 'Per-day rollup: posts published, content gains, account reach/views/profile views/page views, followers. Use for "which day was best", trends and charts. Max 120 days.',
    parameters: { type: 'OBJECT', properties: { start: { type: 'STRING' }, end: { type: 'STRING' }, platform: { type: 'STRING', description: 'IG or FB; omit for both' } }, required: ['start', 'end'] },
    run: async (c, a) => { let s = supabase.from('xp_v_client_day_summary').select('*').eq('client_id', c.id).gte('day', a.start).lte('day', a.end).order('day').limit(240); if (a.platform) s = s.eq('platform', a.platform); return fbDailyViews(await q(s, 'daily')); }
  },
  get_post_history: {
    description: 'One post\'s lifetime counters as observed each day, plus daily gains. Use when asked how a specific post performed over time.',
    parameters: { type: 'OBJECT', properties: { post_id: { type: 'STRING' }, start: { type: 'STRING' }, end: { type: 'STRING' } }, required: ['post_id', 'start', 'end'] },
    run: async (c, a) => (await q(supabase.from('xp_v_post_daily_deltas').select('platform,snapshot_date,reach,views,video_views,likes,comments,shares,saves,impressions,reach_gained,views_gained,impressions_gained,likes_gained,comments_gained,is_final').eq('client_id', c.id).eq('meta_post_id', a.post_id).gte('snapshot_date', a.start).lte('snapshot_date', a.end).order('snapshot_date'), 'history')).map(postViews)
  },
  search_posts: {
    description: 'Find posts by caption text or publish date, with their latest lifetime counters. Use to identify a post the user describes in words before asking for its history.',
    parameters: { type: 'OBJECT', properties: { text: { type: 'STRING' }, start: { type: 'STRING' }, end: { type: 'STRING' }, platform: { type: 'STRING' }, limit: { type: 'INTEGER' } } },
    run: async (c, a) => { let s = supabase.from('xp_v_posts_with_latest').select('meta_post_id,platform,caption,permalink,media_type,media_product_type,publish_date,reach,views,video_views,impressions,likes,comments,shares,saves,latest_snapshot_date').eq('client_id', c.id).eq('is_deleted', false).eq('is_story', false).order('publish_date', { ascending: false }).limit(Math.min(a.limit || 10, 30)); if (a.text) s = s.ilike('caption', `%${a.text}%`); if (a.start) s = s.gte('publish_date', a.start); if (a.end) s = s.lte('publish_date', a.end + 'T23:59:59Z'); if (a.platform) s = s.eq('platform', a.platform); return (await q(s, 'search')).map((p) => postViews({ ...p, caption: (p.caption || '').slice(0, 200) })); }
  },

  // ---- influencers (v2.11.0) --------------------------------------------------
  get_influencer_posts: {
    description: 'Posts that influencers and other creators published about the restaurant on Instagram (collabs, and posts that tag it): each creator\'s @handle and followers, the post\'s views, likes and comments, engagement rate, how its views compare with the restaurant\'s usual reel, views gained since it was first read, the cost per 1,000 views when a cost was recorded, and its latest comments. The numbers are the public ones as Instagram shows them on each creator\'s post (a reel also shared to Facebook includes its Facebook views and likes, split out). Omit start/end for every recorded post, or pass a period for the posts published in it. Use for "how did the influencer do", "which creator brought the most views", "our collabs", "who posted about us".',
    parameters: { type: 'OBJECT', properties: { start: { type: 'STRING', description: 'optional YYYY-MM-DD' }, end: { type: 'STRING', description: 'optional YYYY-MM-DD' } } },
    run: (c, a) => influencers.forOwner(c.id, { start: a.start || null, end: a.end || null, tz: c.timezone || 'America/New_York' })
  },

  // ---- horizons -----------------------------------------------------------
  get_coverage: {
    description: 'What is tracked, from when, to when, and where the gaps are — per asset and per metric. Call this when a question reaches before tracking began or when numbers look incomplete. A summary is already in your instructions; call this only for detail.',
    parameters: { type: 'OBJECT', properties: {} },
    run: (c) => coverage(c.id)
  }
};

// get_coverage is also called automatically once per turn and folded into the system prompt, so the
// model never has to discover the horizons on its own initiative — the old prompt asked it to notice
// that a number looked incomplete, which is not something a model can reliably do.
async function coverage(clientId) {
  const rows = await q(supabase.from('xp_v_data_coverage').select('asset_id,platform,name,status,account_data_from,account_data_to,account_days,post_data_from,post_data_to,post_days,posts_known,last_synced_at').eq('client_id', clientId), 'coverage');
  const health = await q(supabase.from('xp_v_sync_health').select('asset_id,missing_days_30,missing_dates').eq('client_id', clientId), 'health').catch(() => []);
  const h = new Map((health || []).map((x) => [x.asset_id, x]));
  const from = rows.map((r) => r.account_data_from).filter(Boolean).sort()[0] || null;
  return {
    data_available_from: from,
    assets: rows.map((r) => ({ ...r, missing_days_30: h.get(r.asset_id)?.missing_days_30 ?? null, missing_dates: h.get(r.asset_id)?.missing_dates || [] })),
    ads: await adsCoverage(clientId)
  };
}
// Stage E: whether an ad account is connected, and from when ad figures exist. Null if 0022 is missing.
async function adsCoverage(clientId) {
  try {
    const [ads, accts, first] = await Promise.all([
      q(supabase.from('xp_meta_ads').select('ad_account_id').eq('client_id', clientId).limit(1), 'ads cov'),
      q(supabase.from('xp_meta_ad_accounts').select('ad_account_id,last_synced_at').eq('client_id', clientId).eq('is_active', true).limit(1), 'ads cov accts'),
      q(supabase.from('xp_ad_daily_snapshots').select('metric_date').eq('client_id', clientId).order('metric_date').limit(1), 'ads cov first')
    ]);
    return { connected: ads.length > 0 || accts.length > 0, ad_figures_from: first[0] ? first[0].metric_date : null };
  } catch { return null; }
}

function declarations() { return Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, parameters: t.parameters })); }

// ---------------------------------------------------------------- C-2: the answer contract

// Dates are resolved here and handed to the model, rather than asking it to work them out. The old
// prompt spelled out how to compute "Q2" and "last week" in prose; every one of those is a chance to
// be off by a day, and none of it is work a language model should be doing.
function resolvedDates(tz) {
  const now = DateTime.now().setZone(tz);
  const lastMonth = now.minus({ months: 1 });
  const lmStart = lastMonth.startOf('month');
  const lmEnd = lastMonth.endOf('month');
  const sameDaysEnd = DateTime.min(lmStart.plus({ days: now.day - 1 }), lmEnd);
  return {
    today: now.toISODate(),
    todayLong: now.toFormat('cccc, d LLLL yyyy'),
    monthName: now.toFormat('LLLL'),
    mtdStart: now.startOf('month').toISODate(),
    mtdDays: now.day,
    lastMonthName: lastMonth.toFormat('LLLL yyyy'),
    lastMonthStart: lmStart.toISODate(),
    lastMonthEnd: lmEnd.toISODate(),
    sameDaysLastMonthStart: lmStart.toISODate(),
    sameDaysLastMonthEnd: sameDaysEnd.toISODate(),
    last7Start: now.minus({ days: 6 }).toISODate(),
    last30Start: now.minus({ days: 29 }).toISODate()
  };
}

function coverageLines(cov) {
  if (!cov?.assets?.length) return 'No tracked assets found for this client.';
  return cov.assets.map((a) => {
    const bits = [`${a.platform} "${a.name || a.asset_id}"`, `account data ${a.account_data_from || '—'} to ${a.account_data_to || '—'} (${a.account_days || 0} days)`];
    bits.push(a.post_data_from ? `post-level data from ${a.post_data_from} (${a.post_days || 0} days, ${a.posts_known || 0} posts known)` : 'no post-level data yet');
    if (a.missing_days_30) bits.push(`${a.missing_days_30} missing day(s) in the last 30`);
    if (a.status && a.status !== 'ACTIVE') bits.push(`status ${a.status}`);
    return `- ${bits.join(' · ')}`;
  }).join('\n') + (cov.ads ? `\n- Ads: ${cov.ads.connected ? `ad account connected${cov.ads.ad_figures_from ? `, ad figures from ${cov.ads.ad_figures_from}` : ', no ad spend recorded yet'}` : 'no ad account connected yet (matters only for questions about ad spend or return on ad spend; Facebook paid views are available)'}` : '');
}

function systemPrompt(client, tz, cov) {
  const d = resolvedDates(tz);
  return `You are Owner Assistant, powered by XPulse.inc, the analytics assistant for "${client.client_name}". Talk like a sharp human assistant who knows the numbers: direct, precise, no filler. Speak to the owner as "you" and about "your" posts, pages and followers.
Today is ${d.todayLong} in ${tz}.

DATES — already resolved. Use these exact values; do not compute your own.
- today: ${d.today}
- this month so far (RUNNING): ${d.mtdStart} to ${d.today} — ${d.mtdDays} day(s) elapsed
- same days last month: ${d.sameDaysLastMonthStart} to ${d.sameDaysLastMonthEnd}
- last full month (${d.lastMonthName}): ${d.lastMonthStart} to ${d.lastMonthEnd}
- last 7 days: ${d.last7Start} to ${d.today}
- last 30 days: ${d.last30Start} to ${d.today}
For any other period, work from these anchors. A single day is start == end.

WHAT IS TRACKED — read this before saying a number is zero.
${coverageLines(cov)}

RULES — non-negotiable:
1. Every number you state MUST come from a tool result in this conversation. Never estimate, extrapolate, add numbers in your head, or recall figures from memory. To compare two periods, call compare_periods — do not subtract them yourself.
2. A null value means "not tracked", never zero. Say which it is and why, using the coverage above.
3. Every figure carries its coverage. For account metrics the denominator is account.days_by_metric[<metric>] — the days that metric actually HAS A VALUE. Never use days_with_data or account_days_in_period for this: those count rows, and a row exists on days where the metric is null. If the denominator is below the period length, say so in the same breath: "469 views across 2 of the 10 days". If it is zero, the metric was not tracked in this period — say that instead of reporting a total. Never present a partial total as a period total.
4. Every follower figure carries its basis: measured (read from Meta) or estimated (worked out from the days around it). Never present an estimate as a reading. "Estimated" is the only word for it.
5. Undated questions about performance ("how is business", "how are we doing") mean THIS MONTH SO FAR: answer them with compare_periods against the same days last month, and name the period in a few words, e.g. "${d.monthName} so far (${d.mtdDays} days)". A period still running (is_running_period) is not final: end with ONE short note, e.g. "Still running, so these will change." Never two notes.
6. INSTAGRAM FIRST, FACEBOOK SECOND. Always, in every answer covering both — even when Facebook's numbers are larger. Never merge the two platforms into one figure unless explicitly asked, and if you do, label it a combined total.
7. SHAPE — short and to the point, like a person who knows the numbers, not a report.
   a. Answer the question in the first sentence, with the figures that answer it in bold. Then at most two or three short sentences or bullets with the other figures that matter, Instagram first, then Facebook. That is the whole answer: about 40 to 80 words. The figure panel under your answer shows the full set, so do not list every metric.
   b. A simple lookup ("how many followers do we have?") is one sentence: the figure in bold, with its basis and date.
   c. A comparison states both periods' figures and the change. Call something up, down, strong or weak only when a comparison in the tool results shows it; otherwise just give the figures.
   d. No headings or labels ("In plain terms", "What it means", "Summary"), no analogies, no filler, no restating the question, no sign-off. No dramatic or hype words (surging, skyrocketing, plummeting, collapsed, massive, huge, impressive, strong growth, highly effective): state the change with its number instead ("down 47.6%").
   e. When the user asks for more ("more detail", "dive deeper", "why", "break it down"), go one level deeper: per platform, per day, per post or per format as fits, still without filler. Tables are fine then, and longer answers are fine then.
   Thousands separators on every number. No recommendation unless the user asks what to do.
8. When the user refers to an earlier answer ("compare that to…"), reuse the same tool with new dates rather than guessing.
9. If a result carries a "conventions" array with more than one entry for the same platform and metric, the period straddles a change in how the data was recorded. Say so plainly and quote the note — do not present figures from either side of it as directly comparable. A single convention entry is background: mention it only if the user asks why a figure looks different from another tool or an older report.
10. You may call several tools before answering. Prefer one specific tool over several general ones. get_period_summary already contains settlement, the paid split and conventions — do not call get_settlement or get_paid_split for a period you have just summarised unless the user asks for the day-by-day detail.
11. REACH CARRIES ITS VERIFICATION. When any day behind a reach figure is still updating, end with one short note, e.g. "The last few days are still being counted." If rule 5's note is already there, it covers this: never two notes. Never say "final" for a period with any day still updating. When the user asks how sure you are or whether a figure is final, quote the settlement sentence the tool gives you (settlement.<platform>.sentence), e.g. "Instagram reach, 30 days: 18 verified, 9 still updating, 3 measured by an earlier method." The figure panel under a period summary already shows that sentence for each platform.
12. PAID AND ORGANIC. Instagram figures are always organic and paid combined — say so once if the user asks about paid, boosts or ads. Facebook views have an organic/paid split (views_organic / views_paid) from paid_split.FB.split_from; before that date they are combined. Never estimate a paid share for days that have no split. Money spent on ads, what the ads produced and return on ad spend come only from get_ad_performance (rule 16).
13. CLIENT LANGUAGE ONLY. You are speaking to a restaurant owner. Never mention database tables, migrations, sync runs, lock rules, plateaus, settle statuses, timers, API metric names, version numbers, or how the system works internally. The only words for data verification are: verified, still updating, not verified, measured by an earlier method. If asked how you know a number is verified: "Meta has stopped changing it, so we have marked it verified." Nothing more technical than that. Do not use the words "settle", "settling" or "settled" — say "Meta has finished counting" / "Meta is still counting".
14. FIGURES AND CHARTS. The portal draws a figure panel under your answer from the results of get_period_summary, compare_periods, get_daily_series, get_followers_series, get_top_posts, get_format_breakdown, get_posting_pattern and get_ad_performance. When the user asks for a chart, graph or visual, call the tool that holds those numbers. Never draw a chart with text characters, never say you cannot show charts, and do not describe the panel: your words carry the meaning, the panel carries the full set of figures.
15. VIEWS AND REACH LEAD. Views (how many times your content was seen) and reach (how many people saw it) are the headline figures, as in Meta's own app: a performance answer gives views and reach first, then engagement. Facebook views are Meta's Views (how many times the Page's content was seen): never call them impressions. Page views / profile views in the data are visits to the Page or profile: call them page visits and profile visits. Posts too: in any list, table or answer about posts, give each post's views and reach, views first — and views gained next to reach gained when you show gains. A post's views are Meta's Views on both platforms; a Facebook video's video_views are plays, a separate smaller count: call them video plays if you use them at all.
16. ADS AND RETURN ON AD SPEND — only when the user asks about ads, boosts, ad spend, cost per result or return on ad spend. Never call get_ad_performance for any other question. An answer about posts, reach, views, followers, timing or anything else never contains a sentence about ads, spend or the ad account — not even when an earlier answer in the conversation did. For those questions call get_ad_performance; to compare periods pass prev_start/prev_end and quote its changes. Money always carries its currency with two decimals, e.g. "$1,234.50". Ad views are how many times the ads were seen: call them ad views, never impressions. Say return on ad spend as "3.2× return: $412.00 in purchases Meta recorded from $128.75 spent". If return_on_ad_spend is null, say in one sentence that Meta recorded no purchase value for these ads so the return cannot be measured, then give what the money did produce and its cost (cost per link click, per message, per lead). Never estimate revenue, sales or a return that the tool does not give. If connected is false, say once in the conversation that the restaurant's ad account is not connected yet, so spend and return are not available; Facebook paid views from get_paid_split are. Do not repeat it in later answers. Quote a campaign's people_reached_whole_run as reach over its whole run, never as reach for the period. If still_updating_note is present and the answer quotes messages, leads or purchases, add it as the one note (rule 11 still allows only one).
17. INFLUENCERS — only when the user asks about influencers, creators, collabs or posts other people made about the restaurant. Call get_influencer_posts, with start/end when the question names a period. Name each creator by @handle, and give each post's views first, then likes and comments. These are the public numbers on the creator's own post, as of numbers_as_of: never add them to the restaurant's own totals, and never call them the restaurant's views or reach. Quote views_vs_your_usual_reel as "2.4× your usual reel" (the restaurant's typical reel over the last 90 days). When a post has views_on_facebook, the creator also shared it to Facebook and Instagram shows the two together: say so once, as "738 views (464 on Instagram, 274 on Facebook)". Give cost per 1,000 views only when cost_per_1000_views is present. Quote latest_comments briefly, and only when the user asks what people said; if a post's latest_comments is empty, say its comment text is not available yet, never that it had no comments. If the result has "none", say that in one sentence. Never say how the posts were found or collected.`;
}

// ---------------------------------------------------------------- C-3: follow-up suggestions
//
// Generated here, from which tools were actually called — NOT emitted by the model. public/index.html
// has always parsed ||question|| markers out of the reply text, but nothing in the prompt ever told the
// model to produce them, so the chips could never appear. Generating them server-side also means they
// cannot leak into the narrative as stray pipes and cannot be invented for data that does not exist.
const SUGGESTIONS = {
  get_period_summary: (ctx) => (ctx.running
    ? ['How does that compare to the same days last month?', 'Which post is carrying the month so far?', 'Show me Instagram on its own']
    : [`What changed compared to the month before?`, 'Which format performed best?', 'What were people commenting on?']),
  compare_periods: () => ['What drove the change on Facebook?', 'Which posts carried the stronger period?', 'Was it format or timing?'],
  get_top_posts: () => ['What do the top posts have in common?', 'What time of day were they posted?', 'Show me the comments on those posts'],
  get_content_table: () => ['Which format performed best?', 'What was our worst performer and why?', 'How many did we publish vs last month?'],
  get_format_breakdown: () => ['What is the best day and time for that format?', 'How many of those did we publish?', 'Show me the top post in that format'],
  get_posting_pattern: () => ['When is our audience actually online?', 'Show me reach by day for last month', 'Which day of the week is weakest?'],
  get_audience: () => ['Which posts did that group engage with most?', 'How has the audience changed since last month?'],
  get_comments_digest: () => ['Which post got the most comments?', 'Was any of it negative?', 'Who comments most often?'],
  get_hashtags: () => ['Which posts used the best-performing tags?', 'Are we reusing the same tags too often?'],
  get_followers_series: () => ['What happened on the biggest gain day?', 'How does follower growth compare to last month?', 'Did any post drive that?'],
  get_stories: () => ['How do stories compare to feed posts?', 'Which story kept people watching?'],
  get_daily_series: () => ['What was published on the best day?', 'Show the same for last month'],
  get_coverage: () => ['Show me everything from the earliest tracked date', 'What can you tell me about last month instead?'],
  search_posts: () => ['How did that post perform over time?', 'Show me the comments on it'],
  get_post_history: () => ['How does that compare to our average?', 'What else did we publish that week?'],
  get_settlement: () => ['Show me the verified days only', 'When will this month be final?'],
  get_paid_split: () => ['How much did we spend on ads?', 'How did organic reach compare last month?'],
  get_ad_performance: (ctx) => (ctx.adsConnected
    ? ['Which campaign cost the least per result?', 'How does ad spend compare to last month?', 'How much of our Facebook views were paid?']
    : ['How much of our Facebook views were paid?', 'How did Facebook do this month?']),
  get_influencer_posts: () => ['Which creator brought the most views?', 'How do their posts compare with our own reels?', 'What did people say in the comments?']
};

// v2.8: questions about THIS answer's numbers come first — the platform and figure that moved most,
// the best day, the top post by its caption, the campaign that spent most — then the general ones
// above. Each is one a tool can answer, and posts are named by caption so the next answer can find
// them (earlier tool results are not in the model's history). Nothing here is sent unless the answer's
// own results hold it.
const SUG_PLATFORM = { IG: 'Instagram', FB: 'Facebook' };
const SUG_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SUG_DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
const sugNum = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const sugPct = (v) => `${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
const sugDay = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s) ? `${SUG_MON[Number(s.slice(5, 7)) - 1]} ${Number(s.slice(8, 10))}` : null);
const sugMoney = (v, cur) => { try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD' }).format(v); } catch { return `${v.toFixed(2)} ${cur || ''}`.trim(); } };
// A caption as a short quotable name: no hashtags or mentions, no double quotes, cut at a word.
function sugQuote(s, max = 38) {
  const t = String(s || '').replace(/[#@][^\s#@]+/g, '').replace(/["“”]/g, "'").replace(/\s+/g, ' ').trim();
  if (t.length < 4) return null;
  if (t.length <= max) return t;
  const cut = t.slice(0, max); const sp = cut.lastIndexOf(' ');
  return `${(sp > 20 ? cut.slice(0, sp) : cut).replace(/[\s,.;:!-]+$/, '')}…`;
}
const SUG_FORMAT = { REEL: 'Reels', REELS: 'Reels', VIDEO: 'videos', CAROUSEL: 'carousels', CAROUSEL_ALBUM: 'carousels', ALBUM: 'albums', IMAGE: 'photo posts', PHOTO: 'photo posts', LINK: 'link posts', TEXT: 'text posts', STATUS: 'text posts' };
// [delta key, words, plural?]. Views and reach lead (rule 15): a move in them is asked about first.
const SUG_LEAD = [['account.views', 'views', true], ['account.reach', 'reach', false]];
const SUG_MORE = [['account.engagements', 'engagement', false], ['account.profile_views', 'profile visits', true], ['account.page_views', 'page visits', true]];
const SUG_ONE = { REEL: 'Reel', REELS: 'Reel', VIDEO: 'video', CAROUSEL: 'carousel', CAROUSEL_ALBUM: 'carousel', ALBUM: 'album', IMAGE: 'photo', PHOTO: 'photo', LINK: 'link post', TEXT: 'text post', STATUS: 'text post' };
// A post by day and kind ("the Sep 12 Instagram Reel"), which the next answer can find by date; the
// caption only when those are missing.
function sugPost(p) {
  if (!p) return null;
  const day = sugDay(p.published_on || p.publish_date);
  const kind = SUG_ONE[String(p.format || p.media_type || '').toUpperCase()];
  const pl = SUG_PLATFORM[p.platform];
  if (day && kind) return `the ${day} ${pl ? pl + ' ' : ''}${kind}`;
  const q = sugQuote(p.caption);
  return q ? `"${q}"` : null;
}

const SPECIFIC_SUGGESTIONS = {
  compare_periods: (r) => {
    const movesIn = (metrics) => {
      const moves = [];
      for (const pl of ['IG', 'FB']) {
        const d = (r.deltas || {})[pl] || {};
        for (const [k, word, plural] of metrics) {
          const x = d[k] || (k === 'account.views' ? d['account.impressions'] : null);
          const p = x && sugNum(x.change_pct);
          if (p !== null && p !== undefined && Math.abs(p) >= 5) moves.push({ pl, word, plural, p });
        }
      }
      return moves;
    };
    const lead = movesIn(SUG_LEAD), more = movesIn(SUG_MORE);
    const pick = (list, sign) => list.filter((m) => Math.sign(m.p) === sign).sort((a, b) => Math.abs(b.p) - Math.abs(a.p))[0];
    const down = pick(lead, -1) || pick(more, -1);
    const up = pick(lead, 1) || pick(more, 1);
    const out = [];
    if (down) out.push(`Why ${down.plural ? 'are' : 'is'} ${SUG_PLATFORM[down.pl]} ${down.word} down ${sugPct(down.p)}?`);
    if (up) out.push(`What drove the ${sugPct(up.p)} rise in ${SUG_PLATFORM[up.pl]} ${up.word}?`);
    return out;
  },
  get_period_summary: (r) => {
    const out = [];
    for (const pl of ['IG', 'FB']) {
      const top = (((r.platforms || {})[pl] || {}).top_posts || [])[0];
      const name = top && sugPost({ ...top, platform: pl });
      if (name) { out.push(`What made ${name} your top post?`); break; }
    }
    const f = ((r.platforms || {}).IG || {}).followers || {};
    const net = sugNum(f.net);
    if (net !== null && net > 0) out.push(`Which posts brought the ${net.toLocaleString('en-US')} new Instagram followers?`);
    return out;
  },
  get_top_posts: (rows) => {
    const name = sugPost(Array.isArray(rows) ? rows[0] : null);
    if (!name) return [];
    return [`What made ${name} your top post?`, `How did ${name} grow day by day?`, `What are people saying about ${name}?`];
  },
  get_daily_series: (rows) => {
    if (!Array.isArray(rows) || rows.length < 3) return [];
    const out = [];
    for (const pl of ['IG', 'FB']) {
      const rs = rows.filter((x) => x.platform === pl);
      const key = rs.some((x) => sugNum(x.account_views) !== null) ? 'account_views' : rs.some((x) => sugNum(x.account_impressions) !== null) ? 'account_impressions' : 'account_reach';
      const vals = rs.filter((x) => sugNum(x[key]) !== null);
      if (vals.length < 3) continue;
      const best = vals.reduce((a, b) => (sugNum(b[key]) > sugNum(a[key]) ? b : a));
      const worst = vals.reduce((a, b) => (sugNum(b[key]) < sugNum(a[key]) ? b : a));
      const word = key === 'account_reach' ? 'reach' : 'views';
      if (sugDay(best.day)) out.push(`What did we post around ${sugDay(best.day)}, the best ${SUG_PLATFORM[pl]} day for ${word}?`);
      if (sugDay(worst.day) && worst.day !== best.day) out.push(`Why was ${sugDay(worst.day)} the quietest ${SUG_PLATFORM[pl]} day?`);
      break;
    }
    return out;
  },
  get_followers_series: (rows) => {
    const gains = (Array.isArray(rows) ? rows : []).filter((x) => sugNum(x.followers_gained) > 0);
    if (!gains.length) return [];
    const best = gains.reduce((a, b) => (sugNum(b.followers_gained) > sugNum(a.followers_gained) ? b : a));
    return sugDay(best.date) ? [`What brought the ${sugNum(best.followers_gained).toLocaleString('en-US')} new ${SUG_PLATFORM[best.platform] || ''} followers on ${sugDay(best.date)}?`.replace('  ', ' ')] : [];
  },
  get_format_breakdown: (r) => {
    const all = (r && Array.isArray(r.formats) ? r.formats : []).filter((x) => sugNum(x.posts) >= 2);
    const key = all.some((x) => sugNum(x.avg_views) !== null) ? 'avg_views' : 'avg_reach';   // views lead (rule 15)
    const rows = all.filter((x) => sugNum(x[key]) !== null);
    if (!rows.length) return [];
    const best = rows.reduce((a, b) => (sugNum(b[key]) > sugNum(a[key]) ? b : a));
    const name = SUG_FORMAT[String(best.format || '').toUpperCase()] || String(best.format || '').toLowerCase();
    return name ? [`Show me our best ${name} from this period`, `How many ${name} did we post compared with last month?`] : [];
  },
  get_posting_pattern: (r) => {
    const all = (r && Array.isArray(r.by_day_of_week) ? r.by_day_of_week : []).filter((x) => sugNum(x.posts) >= 2);
    const key = all.some((x) => sugNum(x.avg_views) !== null) ? 'avg_views' : 'avg_reach';
    const rows = all.filter((x) => sugNum(x[key]) !== null);
    if (!rows.length) return [];
    const best = rows.reduce((a, b) => (sugNum(b[key]) > sugNum(a[key]) ? b : a));
    const days = SUG_DAYS[Number(best.dow)];
    const day = days && days.replace(/s$/, '');
    return day ? [`Which of our ${day} posts did best?`, `Is ${day}'s lead more than one strong post?`] : [];
  },
  get_influencer_posts: (r) => {
    const top = (r && Array.isArray(r.posts) ? r.posts : []).find((p) => sugNum(p.views) !== null);
    return top ? [`Is ${top.creator}'s post still gaining views?`] : [];
  },
  get_ad_performance: (r) => {
    if (!r || !r.connected) return [];
    const camps = (r.campaigns || []).filter((c) => sugNum(c.spend) > 0);
    const out = [];
    const top = camps[0];
    const q = top && sugQuote(top.name, 34);
    if (q) out.push(`Was "${q}" worth the ${sugMoney(sugNum(top.spend), top.currency)}?`);
    if (camps.filter((c) => sugNum(c.messages_started) > 0).length > 1) out.push('Which campaign brought messages for the least?');
    if (r.totals && r.totals.return_on_ad_spend === null) out.push('What did the ads bring in besides sales?');
    return out;
  }
};

const CROSS_PLATFORM = { IG: 'How did Facebook do over the same period?', FB: 'How did Instagram do over the same period?' };
// v2.7.1: answers are short by design (rule 7), so the first chip is always the way to the detail,
// unless the question was already a request for detail.
const MORE_DETAIL = 'Give me more detail';
const WANTS_DETAIL = /\b(more detail|in detail|dive deeper|go deeper|break (it|that|this) down|elaborate|explain more|tell me more|full breakdown)\b/i;

function suggestionsFor(toolLog, results, historyText, currentMessage) {
  if (!toolLog.length) return [];
  // Last tool wins: it is the one that produced the numbers the user is now looking at. toolLog and
  // results are parallel: entry i of each is one call.
  let at = -1;
  for (let i = toolLog.length - 1; i >= 0; i--) if (SUGGESTIONS[toolLog[i].name]) { at = i; break; }
  if (at < 0) return [];
  const last = toolLog[at];

  const summary = results.find((r) => r.name === 'get_period_summary')?.result;
  const ads = results.find((r) => r.name === 'get_ad_performance')?.result;
  const ctx = { running: summary?.is_running_period === true, adsConnected: !!(ads && ads.connected) };
  const own = results[at] && results[at].name === last.name ? results[at].result : null;
  let specific = [];
  try { if (SPECIFIC_SUGGESTIONS[last.name] && own && !own.error) specific = SPECIFIC_SUGGESTIONS[last.name](own, last.args || {}) || []; }
  catch (e) { console.warn('[chat] suggestions:', e.message); }
  let out = [...specific, ...SUGGESTIONS[last.name](ctx)];

  // If the answer only covered one platform, always offer the other.
  const onlyPlatform = toolLog.map((t) => t.args?.platform).filter(Boolean);
  if (onlyPlatform.length && new Set(onlyPlatform).size === 1 && CROSS_PLATFORM[onlyPlatform[0]]) {
    out.unshift(CROSS_PLATFORM[onlyPlatform[0]]);
  }

  // Never suggest something already asked in this conversation.
  const asked = (historyText || '').toLowerCase();
  out = out.filter((s) => !asked.includes(s.toLowerCase().slice(0, 24)));
  if (!WANTS_DETAIL.test(currentMessage || '')) out.unshift(MORE_DETAIL);

  return [...new Set(out)].slice(0, 3);
}

// ---------------------------------------------------------------- history
function toContents(messages) {
  // Keep the opening question (it usually sets the period) and the most recent HISTORY_KEEP
  // messages. Forty messages of tables and follow-ups was most of the prompt on a long thread.
  if (messages.length > HISTORY_KEEP + 1) messages = [messages[0], ...messages.slice(-HISTORY_KEEP)];
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') pushTurn(out, 'user', m.content || '');
    else if (m.role === 'assistant' && m.content) pushTurn(out, 'model', m.content);
  }
  return out;
}
// A question left unanswered (stopped, timed out, failed) is followed by the next question. Two user
// turns in a row become one turn with two parts, so the history always alternates.
function pushTurn(out, role, text) {
  const last = out[out.length - 1];
  if (last && last.role === role) last.parts.push({ text });
  else out.push({ role, parts: [{ text }] });
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function loadConversation(clientId, conversationId, firstMessage) {
  // Anything that is not a conversation id starts a new conversation instead of failing the query.
  if (typeof conversationId === 'string' && UUID_RE.test(conversationId)) {
    const conv = await q(supabase.from('xp_ai_conversations').select('id,client_id,deleted_at').eq('id', conversationId).maybeSingle(), 'conv');
    if (conv && conv.client_id === clientId && !conv.deleted_at) return { id: conv.id, client_id: conv.client_id };   // a deleted chat is never continued
  }
  return q(supabase.from('xp_ai_conversations').insert({ client_id: clientId, title: (firstMessage || 'Conversation').slice(0, 80) }).select('id,client_id').single(), 'new conv');
}

// ---------------------------------------------------------------- v2.8: ads stay in ads answers
// Tested on real answers: after one question about ads, the model kept calling get_ad_performance on
// unrelated follow-ups and opened each answer with "Your ad account is not connected yet". Rule 16 alone
// did not stop it. So the tool is offered only for a question about ads (or a detail follow-up to an
// ads answer), and an answer that is not about ads is never shown an opening ad-account sentence.
const ADS_TOPIC = /\b(ads?|advert\w*|boost\w*|promot\w*|campaigns?|spend|spent|spending|budget|roas|return on ad\w*|cost per|cpc|cpm|sponsor\w*)\b/i;
const ADS_FOLLOW_UP = /^(why|how come|and |what about|compare|break (it|that|this) down|go deeper|dive deeper|tell me more|explain|more detail|give me more)/i;
function aboutAds(message, history) {
  if (ADS_TOPIC.test(message || '')) return true;
  const prev = [...(history || [])].reverse().find((m) => m.role === 'assistant');
  const prevAds = !!(prev && Array.isArray(prev.tool_calls) && prev.tool_calls.some((t) => t && t.name === 'get_ad_performance'));
  return prevAds && (WANTS_DETAIL.test(message || '') || ADS_FOLLOW_UP.test(String(message || '').trim()));
}
// v2.11.0: influencer posts the same way. Offered only for a question about them (or more detail on an
// influencer answer), so an answer about the restaurant's own posts never drifts into creators' posts.
const INFLUENCER_TOPIC = /\b(influenc\w*|creators?|collab\w*|bloggers?|vloggers?|foodies|tik ?tokers?|ugc|tagged|tagging|tags? us|mention(?:s|ed)? us|shout ?outs?|paid partnerships?|posted about us|posts? about us|talk(?:ing|ed)? about us)\b/i;
function aboutInfluencers(message, history) {
  if (INFLUENCER_TOPIC.test(message || '')) return true;
  const prev = [...(history || [])].reverse().find((m) => m.role === 'assistant');
  const prevInf = !!(prev && Array.isArray(prev.tool_calls) && prev.tool_calls.some((t) => t && t.name === 'get_influencer_posts'));
  return prevInf && (WANTS_DETAIL.test(message || '') || ADS_FOLLOW_UP.test(String(message || '').trim()));
}
const ADS_NOTE = /^\s*[^.!?\n]*\bad account\b[^.!?\n]*\b(?:not|isn't|hasn't been)\s+(?:yet\s+)?(?:connected|linked)\b[^.!?\n]*[.!?]?\s*/i;
const stripAdsNote = (t) => String(t || '').replace(ADS_NOTE, '');
// Holds the stream until its first sentence is complete, drops that sentence if it is the ad-account
// note, then streams the rest as it arrives. Off (a plain pass-through) for questions about ads.
function adsNoteGate(on, out) {
  if (!on) return { push: out, flush() {} };
  let held = '', open = true, trimLead = false;
  const release = () => {
    open = false;
    const t = stripAdsNote(held);
    trimLead = t.length < held.length && !t;   // the note went and nothing followed it yet: skip the blank lines after it
    held = '';
    if (t) out(t);
  };
  return {
    push(t) {
      if (!open && trimLead) { t = t.replace(/^\s+/, ''); if (!t) return; trimLead = false; }
      if (!open) return out(t);
      held += t;
      const end = held.search(/[.!?](?=\s)|\n/);
      if ((end >= 0 && held.length > end + 1) || held.length >= 320) release();
    },
    flush() { if (open) release(); }
  };
}

// ---------------------------------------------------------------- main
//
// answer({ clientId, message, conversationId, onEvent })
//   onEvent, if given, receives { type: 'status', label } while tools run, { type: 'delta', text }
//   as the reply streams, and nothing else — the caller gets the same completed object either way.
//   Labels are client-safe ("Reading September", "Ranking posts") — never tool or table names.
const STATUS_LABEL = {
  get_period_summary: 'Reading the period', compare_periods: 'Comparing periods', get_content_table: 'Listing posts',
  get_top_posts: 'Ranking posts', get_format_breakdown: 'Grouping by format', get_posting_pattern: 'Checking timing',
  get_stories: 'Reading stories', get_hashtags: 'Checking hashtags', get_audience: 'Reading audience',
  get_comments_digest: 'Reading comments', get_followers_series: 'Reading followers', get_daily_series: 'Reading daily figures',
  get_post_history: 'Reading post history', search_posts: 'Finding the post', get_coverage: 'Checking what is tracked',
  get_settlement: 'Checking verification', get_paid_split: 'Splitting paid and organic', get_ad_performance: 'Reading your ads',
  get_influencer_posts: 'Reading influencer posts'
};

function thinkingConfig() {
  // Thinking models spend seconds reasoning before every reply; narrating numbers that a tool
  // already computed does not need it. GEMINI_THINKING_LEVEL ("low" on 3.x) or
  // GEMINI_THINKING_BUDGET (tokens, 2.5-era) caps it; unset = SDK default.
  if (cfg.gemini.thinkingLevel) return { thinkingLevel: cfg.gemini.thinkingLevel };
  const tb = cfg.gemini.thinkingBudget;
  return tb === null || tb === undefined ? null : { thinkingBudget: tb };
}
function modelConfig(base) {
  const tc = thinkingConfig();
  return tc ? { ...base, thinkingConfig: tc } : base;
}

// One streamed model turn. Returns the assembled model content (parts with thought signatures
// intact), the function calls it made, and the text — and pushes text deltas to onDelta as they
// arrive. A part that turns out to be a function call is never streamed as text.
async function streamTurn(ai, contents, config, onDelta) {
  const parts = [];
  let text = '', usage = null, finishReason = null;
  const push = (p) => {
    const last = parts[parts.length - 1];
    if (p.text !== undefined && last && last.text !== undefined && !last.thought && !p.thought && !last.thoughtSignature && !p.thoughtSignature) last.text += p.text;
    else parts.push({ ...p });
  };
  let stream;
  try {
    stream = await ai.models.generateContentStream({ model: cfg.gemini.model, contents, config });
  } catch (e) {
    // A model that rejects thinkingConfig must not take the chat down with it.
    if (config.thinkingConfig && /think/i.test(e.message || '')) {
      console.warn('[chat] thinkingConfig rejected by model, retrying without:', e.message);
      const { thinkingConfig, ...rest } = config;
      return streamTurn(ai, contents, rest, onDelta);
    }
    throw e;
  }
  for await (const chunk of stream) {
    usage = chunk.usageMetadata || usage;
    const cand = chunk.candidates?.[0];
    finishReason = cand?.finishReason || finishReason;
    for (const p of cand?.content?.parts || []) {
      push(p);
      if (p.text && !p.thought) { text += p.text; if (onDelta) onDelta(p.text); }
    }
  }
  const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
  return { content: { role: 'model', parts }, calls, text, usage, finishReason };
}

// v2.7: one controller ends every Gemini call of an answer, when the caller's signal fires (the client
// pressed Stop or closed the page) or when the answer runs past the deadline. Before this a hung stream
// held the request open for good, and a client who left still had the whole answer generated (F-41).
// A cancelled answer throws CHAT_CANCELLED, a late one CHAT_TIMEOUT; neither saves a reply.
const ANSWER_DEADLINE_MS = 120000;
async function answer(opts) {
  const ctl = new AbortController();
  let timedOut = false;
  const outer = opts.signal;
  const onAbort = () => ctl.abort();
  if (outer) { if (outer.aborted) ctl.abort(); else outer.addEventListener('abort', onAbort, { once: true }); }
  const deadline = setTimeout(() => { timedOut = true; ctl.abort(); }, ANSWER_DEADLINE_MS);
  try {
    return await answerOnce({ ...opts, abortSignal: ctl.signal });
  } catch (e) {
    if (ctl.signal.aborted) {
      const err = new Error(timedOut ? 'The answer ran past its deadline.' : 'The client left before the answer finished.');
      err.code = timedOut ? 'CHAT_TIMEOUT' : 'CHAT_CANCELLED';
      err.cause = e;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(deadline);
    if (outer) outer.removeEventListener('abort', onAbort);
  }
}

async function answerOnce({ clientId, message, conversationId, onEvent, abortSignal }) {
  if (!cfg.gemini.apiKey) throw new Error('GEMINI_API_KEY is not configured.');
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey: cfg.gemini.apiKey });
  const emit = (ev) => { try { if (onEvent) onEvent(ev); } catch (e) { console.warn('[chat] onEvent:', e.message); } };

  // The three opening reads do not depend on each other. In series they were ~0.5 s of the wait.
  const [client, conv, cov] = await Promise.all([
    q(supabase.from('xp_clients').select('id,client_name,timezone').eq('id', clientId).single(), 'client'),
    loadConversation(clientId, conversationId, message),
    coverage(clientId).catch((e) => { console.error('[chat] coverage failed:', e.message); return null; })
  ]);
  const tz = client.timezone || 'America/New_York';
  // The latest 40 turns, in order. Ascending + limit kept the OLDEST 40, so a long conversation lost
  // its recent context first.
  const history = (await q(supabase.from('xp_ai_messages').select('role,content,tool_calls').eq('conversation_id', conv.id).order('created_at', { ascending: false }).limit(40), 'history')).reverse();

  await q(supabase.from('xp_ai_messages').insert({ conversation_id: conv.id, role: 'user', content: message }), 'save user');

  const contents = pushTurn(toContents(history), 'user', message);
  const adsQuestion = aboutAds(message, history);
  const influencerQuestion = aboutInfluencers(message, history);
  const offered = declarations().filter((d) => (adsQuestion || d.name !== 'get_ad_performance') && (influencerQuestion || d.name !== 'get_influencer_posts'));
  const config = modelConfig({ systemInstruction: systemPrompt(client, tz, cov), tools: [{ functionDeclarations: offered }], temperature: 0.2, abortSignal });
  const gate = adsNoteGate(!adsQuestion, (t) => emit({ type: 'delta', text: t }));
  const toolLog = [], toolResults = [];
  let text = '';
  // Every Gemini call of the answer is billed: each one re-sends the instructions, the history and the
  // tool results so far, and thinking is billed as output. v2.7.1 sums them all; tokens_in/tokens_out
  // used to hold the last call only, without thinking, which read as about half the real bill.
  const spent = { calls: 0, input: 0, output: 0, thinking: 0, cached: 0 };
  const addUsage = (u) => {
    if (!u) return;
    spent.calls++;
    spent.input += u.promptTokenCount || 0;
    spent.output += u.candidatesTokenCount || 0;
    spent.thinking += u.thoughtsTokenCount || 0;
    spent.cached += u.cachedContentTokenCount || 0;
  };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // Text is streamed to the caller as it arrives. If this turn turns out to be a tool call the
    // model normally emits no text at all; the rare preamble before a call stays on screen, which
    // is harmless ("Let me check September...").
    const turn = await streamTurn(ai, contents, config, gate.push);
    addUsage(turn.usage);
    const calls = turn.calls;

    if (!calls.length) {
      gate.flush();
      text = adsQuestion ? (turn.text || '') : stripAdsNote(turn.text || '');
      if (!text.trim()) {
        const why = turn.finishReason || 'unknown';
        console.error(`[chat] empty completion (finishReason: ${why}) after ${round} tool round(s)`);
        text = `I couldn't compose an answer to that one. Try rephrasing it, or ask about a specific month.`;
        emit({ type: 'delta', text });
      }
      break;
    }

    // Echo the model's OWN content back verbatim — the functionCall parts carry thoughtSignature,
    // which the 3.x thinking models require on the next turn (see v2.4 notes). streamTurn keeps
    // every part as received.
    contents.push(turn.content.parts.length ? turn.content : { role: 'model', parts: calls.map((fc) => ({ functionCall: { name: fc.name, args: fc.args || {} } })) });

    // All calls in a round run at once. They are independent SQL functions; running them one after
    // another was the single largest share of the wait on a multi-tool question.
    emit({ type: 'status', label: [...new Set(calls.map((fc) => STATUS_LABEL[fc.name] || 'Reading the data'))].join(' · ') });
    const settled = await Promise.all(calls.map(async (fc) => {
      const tool = TOOLS[fc.name];
      let result;
      try { result = tool ? await tool.run(client, fc.args || {}) : { error: `unknown tool ${fc.name}` }; }
      catch (e) { result = { error: e.message }; }
      return { fc, result };
    }));
    const responseParts = [];
    for (const { fc, result } of settled) {
      toolLog.push({ name: fc.name, args: fc.args || {} });
      toolResults.push({ name: fc.name, result });
      responseParts.push({ functionResponse: { name: fc.name, response: { result } } });
    }
    contents.push({ role: 'user', parts: responseParts });
    if (round === MAX_ROUNDS - 1) text = OUT_OF_ROUNDS;
  }

  // Ran the rounds out on tool calls. Ask once more with function calling switched off: it must
  // answer from what it already has rather than discard a dozen live queries.
  if (text === OUT_OF_ROUNDS) {
    try {
      const forced = await streamTurn(ai,
        [...contents, { role: 'user', parts: [{ text: 'Answer now from the data you already have. Do not call any more tools.' }] }],
        { ...config, toolConfig: { functionCallingConfig: { mode: 'NONE' } } },
        gate.push);
      gate.flush();
      addUsage(forced.usage);
      text = (adsQuestion ? (forced.text || '') : stripAdsNote(forced.text || '')).trim();
    } catch (e) {
      if (abortSignal && abortSignal.aborted) throw e;   // cancelled or late: answer() reports it
      console.error('[chat] forced answer failed:', e.message);
      text = '';
    }
    if (!text) { text = 'I pulled the numbers but could not compose an answer that time. Ask again and I will go straight to it.'; emit({ type: 'delta', text }); }
  }

  const askedBefore = history.filter((m) => m.role === 'user').map((m) => m.content || '').join(' \n ') + ' \n ' + message;
  const suggestions = suggestionsFor(toolLog, toolResults, askedBefore, message);
  // A panel that cannot be built is left out; it never costs the client the answer.
  let charts = [];
  try { charts = panelsFor(toolLog, toolResults, { question: message }); } catch (e) { console.error('[chat] panels failed:', e.message); }

  await q(supabase.from('xp_ai_messages').insert({ conversation_id: conv.id, role: 'assistant', content: text, tool_calls: toolLog, tool_results: toolResults, model: cfg.gemini.model, tokens_in: spent.input || null, tokens_out: (spent.output + spent.thinking) || null }), 'save assistant');
  await q(supabase.from('xp_ai_conversations').update({ updated_at: new Date().toISOString() }).eq('id', conv.id), 'touch conv').catch(() => {});

  return { conversationId: conv.id, reply: text, response: text, answer: text, suggestions, charts, toolCalls: toolLog, model: cfg.gemini.model, usage: spent };
}

module.exports = { fbSummaryViews, fbContentViews, postViews, fbCompareViews, fbDailyViews, fbSplitViews, answer, TOOLS, systemPrompt, coverage, adsCoverage, suggestionsFor, publicSettlement, publicConventions, publicBundle, publicFollowerDay, publicAds, adChanges, aboutAds, aboutInfluencers, stripAdsNote, adsNoteGate, toContents, pushTurn };
