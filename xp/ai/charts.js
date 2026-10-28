// Figure panels for chat answers (v2.7, 2026-09-18).
//
// The portal draws a panel under an answer from the SAME tool results the model was given. Panels
// are built here, in code, so a chart can never show a number the database did not return, and the
// model is never asked to produce one. Every spec is plain data in client words; public/index.html
// decides how to draw it.
//
//   summary   get_period_summary    headline figures per platform, with coverage and verification
//   compare   compare_periods       this period against the one before, metric by metric
//   chart     get_daily_series      daily bars per platform; days Meta is still counting drawn lighter
//             get_followers_series  follower line per platform; estimated days drawn hollow
//             get_format_breakdown  average views, reach and interactions per post, by format
//             get_posting_pattern   average views, reach and interactions per post, by day of the week
//   ranking   get_top_posts         the ranked posts
//   summary + ranking   get_ad_performance   ads (v2.8): spend, ad views, results, return; campaigns by
//             spend. With a comparison period, a compare panel instead of the summary.
//
// null stays null: a missing bar means "not tracked", as it does in the text (rule 2). Instagram
// first, Facebook second (rule 6). Nothing is ever added across platforms.

const PLATFORMS = ['IG', 'FB'];
const PLATFORM_NAME = { IG: 'Instagram', FB: 'Facebook' };
const MAX_PANELS = 3;

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const num = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s);
const ymd = (s) => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return { y, m, d }; };
const lastDayOf = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
// Postgres round(x, 1) rounds half away from zero; Math.round does not for negatives.
const round1 = (x) => Math.sign(x) * Math.round(Math.abs(x) * 10) / 10;

function dayLabel(s) {
  if (!isDate(s)) return '';
  const { m, d } = ymd(s);
  return `${MON[m - 1]} ${d}`;
}
function weekdayOf(s) {
  if (!isDate(s)) return '';
  const { y, m, d } = ymd(s);
  return WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}
// "August 2026", "Sep 1–18", "Sep 18", "Aug 25 – Sep 7"; the year only where it is needed.
function periodLabel(start, end, withYear = false) {
  if (!isDate(start) || !isDate(end)) return '';
  const a = ymd(start), b = ymd(end);
  const yr = withYear ? `, ${b.y}` : '';
  if (a.y === b.y && a.m === b.m) {
    if (a.d === 1 && b.d === lastDayOf(b.y, b.m)) return `${MONTH[a.m - 1]} ${a.y}`;
    if (a.d === b.d) return `${MON[a.m - 1]} ${a.d}${yr}`;
    return `${MON[a.m - 1]} ${a.d}–${b.d}${yr}`;
  }
  if (a.y === b.y) return `${MON[a.m - 1]} ${a.d} – ${MON[b.m - 1]} ${b.d}${yr}`;
  return `${MON[a.m - 1]} ${a.d}, ${a.y} – ${MON[b.m - 1]} ${b.d}, ${b.y}`;
}

const FORMAT_NAME = {
  REEL: 'Reels', REELS: 'Reels', VIDEO: 'Videos', CAROUSEL: 'Carousels', CAROUSEL_ALBUM: 'Carousels', ALBUM: 'Albums',
  IMAGE: 'Photos', PHOTO: 'Photos', LINK: 'Links', TEXT: 'Text posts', STATUS: 'Text posts', STORY: 'Stories', EVENT: 'Events'
};
const formatName = (f) => {
  const k = String(f || '').toUpperCase();
  if (FORMAT_NAME[k]) return FORMAT_NAME[k];
  if (!k) return 'Other';
  return k.charAt(0) + k.slice(1).toLowerCase().replace(/_/g, ' ');
};
// One post is a Reel, not Reels.
const SINGULAR = { Reels: 'Reel', Videos: 'Video', Carousels: 'Carousel', Albums: 'Album', Photos: 'Photo', Links: 'Link', 'Text posts': 'Text post', Stories: 'Story', Events: 'Event' };
const formatOne = (f) => { const p = formatName(f); return SINGULAR[p] || p; };
const snippet = (s, n = 90) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};
// Links only to Meta's own post pages.
const postUrl = (u) => (typeof u === 'string' && /^https:\/\/([a-z0-9-]+\.)*(instagram\.com|facebook\.com|fb\.watch)\//i.test(u) ? u : null);

// Rows repeated by several calls (one per platform, or with and without a platform filter) keep
// their last copy.
function dedupe(rows, dateKey) {
  const m = new Map();
  for (const r of rows) if (r && isDate(r[dateKey])) m.set(`${r.platform}|${r[dateKey].slice(0, 10)}`, r);
  return [...m.values()].sort((a, b) => (a[dateKey] < b[dateKey] ? -1 : a[dateKey] > b[dateKey] ? 1 : 0));
}

// ---------------------------------------------------------------- summary (get_period_summary)
// Input is chat.publicBundle(): the period summary plus settlement already in client words.
// Views lead, as in Meta's own tools. Facebook's "impressions" column holds page_media_view, which is
// what Meta now calls Views (v2.7.3), so clients see it as Views on both platforms.
const SUMMARY_TILES = {
  IG: [['views', 'Views'], ['reach', 'Reach'], ['profile_views', 'Profile visits'], ['engagements', 'Engagement']],
  FB: [['views', 'Views'], ['reach', 'Reach'], ['page_views', 'Page visits'], ['engagements', 'Engagement']]
};
// An account's views and the days they have a value. Facebook's are stored as impressions (Meta's
// page_media_view) with views null and a 0 day count; the chat tools rename them (v2.7.4), and answers
// stored before that still carry the old name. Instagram has real views and null impressions.
function viewsOf(acc) {
  const dm = (acc && acc.days_by_metric) || {};
  if (acc && (acc.views === null || acc.views === undefined) && acc.impressions !== null && acc.impressions !== undefined) return { value: acc.impressions, days: dm.impressions };
  return { value: acc ? acc.views : null, days: dm.views };
}

function summaryPanel(r) {
  const P = r && r.platforms;
  if (!P) return null;
  const sections = [];
  for (const pl of PLATFORMS) {
    const p = P[pl];
    if (!p) continue;
    const a = p.account || {}, dm = a.days_by_metric || {}, f = p.followers || {};
    const of = num(a.days_in_period);
    const tiles = [];
    const fEnd = num(f.end);
    tiles.push(fEnd === null
      ? { key: 'followers', label: 'Followers', value: null }
      : { key: 'followers', label: 'Followers', value: fEnd, estimated: f.end_is_measured === false,
          net: num(f.net), net_estimated: f.end_is_measured === false || f.start_is_measured === false });
    for (const [key, label] of SUMMARY_TILES[pl]) {
      const vw = key === 'views' ? viewsOf(a) : null;
      const v = num(vw ? vw.value : a[key]), days = num(vw ? vw.days : dm[key]);
      tiles.push(v === null || days === 0 ? { key, label, value: null } : { key, label, value: v, days, of });
    }
    tiles.push({ key: 'posts', label: 'Posts published', value: num(p.posts_published) });
    if (tiles.every((t) => t.value === null)) continue;
    const settle = r.settlement && r.settlement[pl];
    sections.push({
      platform: pl, name: PLATFORM_NAME[pl], tiles,
      note: settle && settle.sentence ? settle.sentence : null,
      note_warn: !!(settle && (settle.days_still_updating > 0 || settle.days_not_verified > 0))
    });
  }
  if (!sections.length) return null;
  const per = r.period || {};
  return { kind: 'summary', title: periodLabel(per.start, per.end), running: r.is_running_period === true, sections };
}

// ---------------------------------------------------------------- compare (compare_periods)
// [delta key, days_by_metric key, label]. Unfollows are left out: for them, up is bad.
const COMPARE_ROWS = {
  IG: [['account.views', 'views', 'Views'], ['account.reach', 'reach', 'Reach'], ['account.profile_views', 'profile_views', 'Profile visits'], ['account.engagements', 'engagements', 'Engagement']],
  FB: [['account.views', 'views', 'Views'], ['account.reach', 'reach', 'Reach'], ['account.page_views', 'page_views', 'Page visits'], ['account.engagements', 'engagements', 'Engagement'], ['account.video_views', 'video_views', 'Video views'], ['account.follows', 'follows', 'New follows']]
};
// Days with a value for a metric of an account block.
const dayCount = (acc, key) => (key === 'views' ? viewsOf(acc).days : (acc.days_by_metric || {})[key]);
const direction = (c, p) => (c === null || p === null ? null : c > p ? 'up' : c < p ? 'down' : 'flat');
function comparePanel(r) {
  if (!r || !r.deltas) return null;
  const cur = r.current || {}, prev = r.previous || {};
  const cs = r.current_summary || {}, ps = r.previous_summary || {};
  const withYear = isDate(cur.start) && isDate(prev.start) && ymd(cur.start).y !== ymd(prev.start).y;
  const curLabel = periodLabel(cur.start, cur.end, withYear), prevLabel = periodLabel(prev.start, prev.end, withYear);
  const sections = [];
  for (const pl of PLATFORMS) {
    const d = r.deltas[pl] || {};
    const cp = (cs.platforms || {})[pl] || {}, pp = (ps.platforms || {})[pl] || {};
    const ca = cp.account || {}, pa = pp.account || {};
    const tiles = [];
    for (const [dk, mk, label] of COMPARE_ROWS[pl]) {
      const x = d[dk] || (dk === 'account.views' ? d['account.impressions'] : undefined);
      if (!x) continue;
      const c = num(x.current), p = num(x.previous);
      if (c === null && p === null) continue;
      tiles.push({
        key: mk, label, current: c, previous: p, change: num(x.change), change_pct: num(x.change_pct), direction: direction(c, p),
        current_days: num(dayCount(ca, mk)), current_of: num(ca.days_in_period),
        previous_days: num(dayCount(pa, mk)), previous_of: num(pa.days_in_period)
      });
    }
    const c = num(cp.posts_published), p = num(pp.posts_published);
    if (c !== null || p !== null) {
      tiles.push({ key: 'posts', label: 'Posts published', current: c, previous: p, direction: direction(c, p),
        change: c !== null && p !== null ? c - p : null, change_pct: c !== null && p ? round1(((c - p) * 100) / p) : null });
    }
    if (tiles.length) sections.push({ platform: pl, name: PLATFORM_NAME[pl], tiles });
  }
  if (!sections.length) return null;
  return {
    kind: 'compare', title: `${curLabel} vs ${prevLabel}`,
    current: { label: curLabel, running: cs.is_running_period === true },
    previous: { label: prevLabel },
    sections
  };
}

// ---------------------------------------------------------------- daily bars (get_daily_series)
const DAILY_SERIES = {
  IG: [['account_views', 'Views'], ['account_reach', 'Reach'], ['profile_views', 'Profile visits'], ['engagements', 'Engagement']],
  FB: [['account_views', 'Views'], ['account_reach', 'Reach'], ['page_views', 'Page visits'], ['engagements', 'Engagement'], ['account_video_views', 'Video views']]
};
// The chart opens on the metric the question names ("daily reach" opens on Reach); otherwise on Views.
function leadWith(series, question) {
  const q = String(question || '').toLowerCase();
  const want = /reach/.test(q) ? 'Reach' : /engag|interaction/.test(q) ? 'Engagement' : /video/.test(q) ? 'Video views'
    : /visit|profile|page view/.test(q) ? /profile/.test(q) ? 'Profile visits' : 'Page visits' : null;
  if (!want) return series;
  const i = series.findIndex((s) => s.label === want);
  return i > 0 ? [series[i], ...series.slice(0, i), ...series.slice(i + 1)] : series;
}

function dailyPanel(rows, args, opts = {}) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const all = dedupe(rows, 'day');
  const sections = [];
  for (const pl of PLATFORMS) {
    const rs = all.filter((x) => x.platform === pl);
    if (!rs.length) continue;
    const series = leadWith(DAILY_SERIES[pl]
      .map(([col, label]) => ({ key: col, label, values: rs.map((x) => num(x[col] ?? (col === 'account_views' ? x.account_impressions : undefined))) }))
      .filter((s) => s.values.some((v) => v !== null)), opts.question);
    if (!series.length) continue;
    sections.push({
      platform: pl, name: PLATFORM_NAME[pl],
      labels: rs.map((x) => dayLabel(x.day)),
      hints: rs.map((x) => `${weekdayOf(x.day)}, ${dayLabel(x.day)}`),
      faded: rs.map((x) => x.is_final === false),
      series
    });
  }
  if (!sections.length) return null;
  const start = isDate(args.start) ? args.start : all[0].day, end = isDate(args.end) ? args.end : all[all.length - 1].day;
  return { kind: 'chart', type: 'bar', title: 'Day by day', subtitle: periodLabel(start, end), faded_note: 'Dimmed bars are days Meta is still counting.', sections };
}

// ---------------------------------------------------------------- followers (get_followers_series)
// Input rows are already in client words (chat.publicFollowerDay): basis is measured | estimated.
function followersPanel(rows, args) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const all = dedupe(rows, 'date');
  const sections = [];
  for (const pl of PLATFORMS) {
    const rs = all.filter((x) => x.platform === pl);
    const values = rs.map((x) => num(x.followers_total));
    if (!values.some((v) => v !== null)) continue;
    sections.push({
      platform: pl, name: PLATFORM_NAME[pl],
      labels: rs.map((x) => dayLabel(x.date)),
      hints: rs.map((x) => `${weekdayOf(x.date)}, ${dayLabel(x.date)}`),
      series: [{ key: 'followers_total', label: 'Followers', values, hollow: rs.map((x) => x.basis === 'estimated') }]
    });
  }
  if (!sections.length) return null;
  const start = isDate(args.start) ? args.start : all[0].date, end = isDate(args.end) ? args.end : all[all.length - 1].date;
  return { kind: 'chart', type: 'line', title: 'Followers', subtitle: periodLabel(start, end), hollow_note: 'Hollow points are estimated, not read from Meta.', sections };
}

// ---------------------------------------------------------------- formats (get_format_breakdown)
const plural = (n, one, many) => `${Number(n).toLocaleString('en-US')} ${n === 1 ? one : many}`;
function formatsPanel(r) {
  const rows = r && Array.isArray(r.formats) ? r.formats : [];
  if (!rows.length) return null;
  const sections = [];
  for (const pl of PLATFORMS) {
    const rs = rows.filter((x) => x.platform === pl);
    if (!rs.length) continue;
    const series = [
      { key: 'avg_views', label: 'Average views per post', values: rs.map((x) => num(x.avg_views)) },
      { key: 'avg_reach', label: 'Average reach per post', values: rs.map((x) => num(x.avg_reach)) },
      { key: 'avg_interactions', label: 'Average interactions per post', values: rs.map((x) => num(x.avg_interactions)) }
    ].filter((s) => s.values.some((v) => v !== null));
    if (!series.length) continue;
    sections.push({
      platform: pl, name: PLATFORM_NAME[pl],
      labels: rs.map((x) => formatName(x.format)),
      notes: rs.map((x) => (num(x.posts) === null ? '' : plural(num(x.posts), 'post', 'posts'))),
      series
    });
  }
  if (!sections.length) return null;
  const per = r.period || {};
  return { kind: 'chart', type: 'bar', title: 'By format', subtitle: periodLabel(per.start, per.end), note: 'Averages over the posts published in this period.', sections };
}

// ---------------------------------------------------------------- posting days (get_posting_pattern)
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0];
function patternPanel(r) {
  const rows = r && Array.isArray(r.by_day_of_week) ? r.by_day_of_week : [];
  if (!rows.length) return null;
  const sections = [];
  for (const pl of PLATFORMS) {
    const byDow = new Map(rows.filter((x) => x.platform === pl).map((x) => [Number(x.dow), x]));
    if (!byDow.size) continue;
    const pick = (k) => DOW_ORDER.map((d) => (byDow.has(d) ? num(byDow.get(d)[k]) : null));
    const series = [
      { key: 'avg_views', label: 'Average views per post', values: pick('avg_views') },
      { key: 'avg_reach', label: 'Average reach per post', values: pick('avg_reach') },
      { key: 'avg_interactions', label: 'Average interactions per post', values: pick('avg_interactions') }
    ].filter((s) => s.values.some((v) => v !== null));
    if (!series.length) continue;
    sections.push({
      platform: pl, name: PLATFORM_NAME[pl],
      labels: DOW_ORDER.map((d) => WEEKDAY[d]),
      notes: DOW_ORDER.map((d) => (byDow.has(d) ? plural(num(byDow.get(d).posts) || 0, 'post', 'posts') : 'no posts')),
      series
    });
  }
  if (!sections.length) return null;
  const per = r.period || {};
  return { kind: 'chart', type: 'bar', title: 'By day of the week', subtitle: periodLabel(per.start, per.end), note: 'A day with only one or two posts is not a pattern yet.', sections };
}

// ---------------------------------------------------------------- top posts (get_top_posts)
const ORDER_LABEL = { reach: 'Reach', views: 'Views', interactions: 'Interactions' };
function rankingPanel(rows, args) {
  if (!Array.isArray(rows) || !rows.length) return null;
  // v2.8.1: get_top_posts ranks by views unless asked. Results stored before 0023 still carry an
  // impressions key: they were ranked by reach, and a Facebook post's views there are video plays
  // (its Meta Views are the impressions). A reopened old chat keeps its reach ranking.
  const legacy = rows.some((p) => p && typeof p === 'object' && 'impressions' in p);
  const order = ORDER_LABEL[args.order] ? args.order : legacy ? 'reach' : 'views';
  const valueOf = (p) => (order === 'views' && legacy && p.platform === 'FB' ? num(p.impressions) : num(p[order]));
  const items = rows
    .map((p) => ({
      platform: p.platform, name: PLATFORM_NAME[p.platform] || p.platform,
      text: snippet(p.caption) || `${formatOne(p.format)} from ${dayLabel(p.published_on)}`,
      format: formatOne(p.format), date: dayLabel(p.published_on), value: valueOf(p), url: postUrl(p.permalink)
    }))
    .filter((i) => i.value !== null)
    .slice(0, 10);
  if (!items.length) return null;
  return { kind: 'ranking', title: `Top posts by ${ORDER_LABEL[order].toLowerCase()}`, subtitle: periodLabel(args.start, args.end), metric: ORDER_LABEL[order], items };
}

// ---------------------------------------------------------------- ads (get_ad_performance, v2.8)
// Input is chat.publicAds(): client words already. Money tiles carry format 'money' and the currency;
// return on ad spend carries 'ratio'. Nothing is drawn when no ad account is connected or nothing was
// spent: the answer says why. Money is never added across currencies (no panel for a mixed period).
// A tile's second line, e.g. "$0.42 each" or "$412.00 in purchases": the portal formats the money.
const sub = (v, cur, suffix) => (num(v) === null ? undefined : { value: num(v), format: 'money', currency: cur, suffix });
function adsTiles(t) {
  const cur = t.currency;
  const tiles = [
    { key: 'spend', label: 'Spent', value: num(t.spend), format: 'money', currency: cur },
    { key: 'ad_views', label: 'Ad views', value: num(t.ad_views), sub: sub(t.cost_per_1000_ad_views, cur, 'per 1,000') },
    { key: 'link_clicks', label: 'Link clicks', value: num(t.link_clicks), sub: sub(t.cost_per_link_click, cur, 'each') }
  ];
  if (num(t.messages_started) > 0) tiles.push({ key: 'messages_started', label: 'Messages', value: num(t.messages_started), sub: sub(t.cost_per_message, cur, 'each') });
  if (num(t.leads) > 0) tiles.push({ key: 'leads', label: 'Leads', value: num(t.leads), sub: sub(t.cost_per_lead, cur, 'each') });
  if (num(t.purchases) > 0) tiles.push({ key: 'purchases', label: 'Purchases', value: num(t.purchases), sub: sub(t.cost_per_purchase, cur, 'each') });
  tiles.push(num(t.return_on_ad_spend) === null
    ? { key: 'return_on_ad_spend', label: 'Return', value: null, empty: 'no purchase value from Meta' }
    : { key: 'return_on_ad_spend', label: 'Return', value: num(t.return_on_ad_spend), format: 'ratio', sub: sub(t.purchase_value, cur, 'in purchases') });
  return tiles.slice(0, 6);
}
const ADS_COMPARE = [['spend', 'Spent', 'money', true], ['ad_views', 'Ad views'], ['link_clicks', 'Link clicks'], ['messages_started', 'Messages'],
  ['leads', 'Leads'], ['purchases', 'Purchases'], ['return_on_ad_spend', 'Return', 'ratio']];
function adsPanels(r, args = {}) {
  if (!r || !r.connected || !r.totals || num(r.totals.spend) === null) return null;
  const t = r.totals, cur = t.currency;
  const per = r.period || {};
  const title = periodLabel(per.start || args.start, per.end || args.end);
  const out = [];
  const notes = [r.still_updating_note, r.time_zone_note].filter(Boolean);
  if (r.changes && r.previous && r.previous.period) {
    const pp = r.previous.period;
    const withYear = isDate(per.start) && isDate(pp.start) && ymd(per.start).y !== ymd(pp.start).y;
    const curLabel = periodLabel(per.start, per.end, withYear), prevLabel = periodLabel(pp.start, pp.end, withYear);
    const tiles = ADS_COMPARE.map(([k, label, format, neutral]) => {
      const x = r.changes[k];
      if (!x || (x.current === null && x.previous === null)) return null;
      if (!format && !num(x.current) && !num(x.previous)) return null;   // a result neither period had
      const c = num(x.current), p = num(x.previous);
      return { key: k, label, current: c, previous: p, change: num(x.change), change_pct: num(x.change_pct), direction: direction(c, p),
        format: format || null, currency: format === 'money' ? cur : undefined, neutral: !!neutral };
    }).filter(Boolean);
    if (tiles.length) out.push({ kind: 'compare', title: `Ads: ${curLabel} vs ${prevLabel}`, current: { label: curLabel }, previous: { label: prevLabel },
      sections: [{ platform: 'ADS', name: 'Ads', tiles }], note: notes.join(' ') || null });
  } else {
    out.push({ kind: 'summary', title, subtitle: 'Ads', sections: [{ platform: 'ADS', name: `Ads · ${cur}`, tiles: adsTiles(t), note: notes.join(' ') || null, note_warn: !!r.still_updating_note }] });
  }
  const camps = (r.campaigns || []).filter((c) => num(c.spend) !== null && c.currency === cur);
  if (camps.length) {
    out.push({
      kind: 'ranking', title: 'Campaigns by spend', subtitle: title, metric: 'Spent', value_format: 'money', currency: cur,
      items: camps.slice(0, 8).map((c) => ({
        platform: 'ADS', name: [c.status, c.objective].filter(Boolean).join(' · '),
        text: snippet(c.name, 80) || 'Campaign',
        format: c.return_on_ad_spend !== null && c.return_on_ad_spend !== undefined ? `${Number(c.return_on_ad_spend).toFixed(2)}× return`
          : c.cost_per_message !== null && c.cost_per_message !== undefined && num(c.messages_started) > 0 ? `${plural(num(c.messages_started), 'message', 'messages')}`
          : num(c.link_clicks) ? plural(num(c.link_clicks), 'link click', 'link clicks') : '',
        date: periodLabel(c.first_day, c.last_day), value: num(c.spend), url: null
      }))
    });
  }
  return out.length ? out : null;
}

// ---------------------------------------------------------------- selection
const BUILDERS = {
  get_ad_performance: adsPanels,
  compare_periods: (r) => comparePanel(r),
  get_daily_series: dailyPanel,
  get_followers_series: followersPanel,
  get_top_posts: rankingPanel,
  get_format_breakdown: (r) => formatsPanel(r),
  get_posting_pattern: (r) => patternPanel(r),
  get_period_summary: (r) => summaryPanel(r)
};
const ROW_TOOLS = new Set(['get_daily_series', 'get_followers_series']);

// toolLog and toolResults are the parallel arrays chat.answer() builds: entry i of each is one call.
function panelsFor(toolLog, toolResults, opts = {}) {
  const picked = new Map();   // tool name -> { args, result, at }: the last call of each tool
  (toolResults || []).forEach((t, i) => {
    if (!t || !BUILDERS[t.name] || t.result === null || t.result === undefined || t.result.error) return;
    const args = ((toolLog || [])[i] || {}).args || {};
    const prev = picked.get(t.name);
    // The same series over the same dates, asked for once per platform, makes one panel.
    if (prev && ROW_TOOLS.has(t.name) && prev.args.start === args.start && prev.args.end === args.end
        && Array.isArray(prev.result) && Array.isArray(t.result)) {
      picked.set(t.name, { args: { start: args.start, end: args.end }, result: [...prev.result, ...t.result], at: i });
      return;
    }
    picked.set(t.name, { args, result: t.result, at: i });
  });
  const built = [];
  for (const [name, e] of [...picked.entries()].sort((a, b) => a[1].at - b[1].at)) {
    try {
      const panel = BUILDERS[name](e.result, e.args, opts);
      for (const p of Array.isArray(panel) ? panel : [panel]) if (p) built.push({ name, panel: p });   // ads build two
    } catch (err) {
      console.warn(`[charts] ${name}: ${err.message}`);
    }
  }
  // The headline panel is the fallback. When the answer has a more specific figure, it goes.
  const specific = built.filter((b) => b.name !== 'get_period_summary');
  return (specific.length ? specific : built).slice(0, MAX_PANELS).map((b) => b.panel);
}

module.exports = { panelsFor, periodLabel, summaryPanel, comparePanel, dailyPanel, followersPanel, formatsPanel, patternPanel, rankingPanel, adsPanels };
