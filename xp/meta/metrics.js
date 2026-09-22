// Metric sets per platform/level + mapping into snapshot columns.
// Names are Graph API v26.0. Legacy names are listed too: insightsResilient() probes the whole set and
// records dead ones in metric_catalog, so a rename on Meta's side degrades one metric, not the sync.

const num = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const first = (m, ...names) => { for (const n of names) if (m[n] !== undefined && m[n] !== null) return m[n]; return null; };

// page_media_view with breakdown=is_from_ads. sync.js stores it per day under
// flat._media_view_by_ads as { "0": organic, "1": paid } — Meta labels each values[] entry with
// is_from_ads "0" / "1" (seen 2026-09-14, scripts/probe-ads-split.js). Other shapes Meta has used
// or documented are accepted too rather than mapped blind:
//   { "true": 12, "false": 1700 } / { "paid": 12, "organic": 1700 }
//   { "is_from_ads=true": 12, ... } / { "is_from_ads": {...} }
//   [ { dimension_values: ["true"], value: 12 }, ... ]    total_value-style list
//   [ { is_from_ads: "1", value: 12 }, ... ]              labelled entries
// Anything it cannot classify leaves both sides null and is logged once per process — null is
// "not read", which is what it is. It never guesses a side. A bare number (what v2.5 stored) is
// unclassifiable on purpose: it was the last bucket to arrive, not a split.
let _adsShapeWarned = false;
function parseAdsSplit(v) {
  const out = { organic: null, paid: null };
  const side = (key) => {
    const k = String(key).toLowerCase().trim();
    if (k === '1' || /(^|[^a-z])(true|paid|ads?)$/.test(k) || /is_from_ads[=:]\s*(true|1)$/.test(k)) return 'paid';
    if (k === '0' || /(^|[^a-z])(false|organic|unpaid|non_?ads?)$/.test(k) || /is_from_ads[=:]\s*(false|0)$/.test(k)) return 'organic';
    return null;
  };
  const add = (which, val) => { const x = num(val); if (x === null) return; out[which] = (out[which] || 0) + x; };
  const walk = (node, depth) => {
    if (node === null || node === undefined || depth > 3) return;
    if (Array.isArray(node)) {
      for (const it of node) {
        if (it && typeof it === 'object' && ('dimension_values' in it || 'dimension_value' in it)) {
          const dv = it.dimension_values || [it.dimension_value];
          const w = side((dv || []).join('|')); if (w) add(w, it.value);
        } else if (it && typeof it === 'object' && 'is_from_ads' in it) {
          const w = side(it.is_from_ads); if (w) add(w, it.value);
        } else walk(it, depth + 1);
      }
      return;
    }
    if (typeof node === 'object') {
      for (const [k, val] of Object.entries(node)) {
        const w = side(k);
        if (w && (typeof val !== 'object' || val === null)) add(w, val);
        else if (w && typeof val === 'object' && val !== null && 'value' in val) add(w, val.value);
        else walk(val, depth + 1);
      }
    }
  };
  walk(v, 0);
  if (out.organic === null && out.paid === null && v !== null && v !== undefined && !_adsShapeWarned) {
    _adsShapeWarned = true;
    console.warn(`[metrics] page_media_view/is_from_ads shape not recognised, split left null: ${JSON.stringify(v).slice(0, 200)}`);
  }
  return out;
}

// ---------------------------------------------------------------- Facebook
const FB = {
  PAGE_FIELDS: 'id,name,username,category,about,website,link,picture{url},followers_count,fan_count,is_verified,verification_status,instagram_business_account{id,username,name,followers_count,follows_count,media_count,profile_picture_url,biography,website}',
  POST_FIELDS: 'id,message,story,permalink_url,created_time,status_type,full_picture,is_published,attachments{media_type,type,url,media{image{src}}}',
  POST_EDGE: 'published_posts',

  // Confirmed dead on this app, v26.0, by metric_catalog on 2026-09-13 — every one of these
  // returned "(#100) The value must be a valid insights metric":
  //   page_impressions, page_impressions_unique, page_fans, page_fan_adds, page_fan_removes,
  //   page_fans_city, page_fans_country, page_fans_gender_age,
  //   post_impressions, post_impressions_unique, post_engaged_users
  // They are removed rather than left in: insightsResilient() retries a rejected set one metric at
  // a time, so eleven dead names cost eleven wasted calls on every asset on every run.
  //
  // Replacements (Meta's own mapping): page_media_view for impressions — with breakdown=is_from_ads
  // for the paid/organic split — and page_total_media_view_unique for reach. page_fans_gender_age
  // has NO replacement; Facebook age/gender demographics are gone.
  ACCOUNT_DAY: [
    'page_media_view', 'page_total_media_view_unique',
    'page_views_total', 'page_post_engagements', 'page_video_views',
    'page_daily_follows', 'page_daily_unfollows',
    'page_actions_post_reactions_total', 'page_follows'
  ],
  POST_LIFETIME: [
    'post_media_view', 'post_total_media_view_unique',
    'post_clicks', 'post_reactions_by_type_total',
    'post_video_views', 'post_video_avg_time_watched'
  ],
  // Current name first, deprecated predecessor second; sync.js takes the first that answers per
  // dimension. page_fans_country / page_fans_city were deprecated 2025-11-15 in favour of
  // page_follows_country / page_follows_city. page_fans_gender_age has no announced replacement.
  // page_fans_country / page_fans_city / page_fans_gender_age all confirmed dead 2026-09-13, so
  // FB audience demographics have been empty. page_follows_* are the named replacements. There is
  // no replacement for age/gender: that breakdown no longer exists for Facebook Pages.
  AUDIENCE: [
    { metric: 'page_follows_country', dimension: 'country' },
    { metric: 'page_follows_city',    dimension: 'city' }
  ],

  // { metric -> value } for ONE day  →  account_metric_snapshots columns
  mapAccountDay(m) {
    const reactions = m.page_actions_post_reactions_total && typeof m.page_actions_post_reactions_total === 'object' ? m.page_actions_post_reactions_total : null;
    const ads = m._media_view_by_ads !== undefined ? parseAdsSplit(m._media_view_by_ads) : { organic: null, paid: null };
    return {
      // page_impressions / page_impressions_unique are dead. Both columns now come from the
      // media-view family. page_total_media_view_unique counts unique viewers of the Page's MEDIA,
      // a smaller group than the retired page_impressions_unique. On this database no stored row
      // ever carried the old name (verified 2026-09-14: 0011-g had found the 90-day backfill
      // horizon, not a Meta changeover), so the stored FB reach series is ONE measurement.
      // See data_conventions REACH_MEDIA_VIEWERS and data_repairs.
      impressions: num(m.page_media_view),
      // C-4: the paid/organic split of the same impressions. Both null on days the breakdown was
      // not read (before 2026-09-12, or when Meta withholds it). Never derived from each other.
      impressions_organic: ads.organic,
      impressions_paid: ads.paid,
      reach: num(m.page_total_media_view_unique),
      page_views: num(m.page_views_total),
      engagements: num(m.page_post_engagements),
      video_views: num(m.page_video_views),
      fan_adds: num(m.page_fan_adds), fan_removes: num(m.page_fan_removes),
      follows_day: num(m.page_daily_follows), unfollows_day: num(m.page_daily_unfollows),
      followers_total: num(m.page_follows), fans_total: num(m.page_fans),
      reactions
    };
  },

  // insights map + object fields → post_metric_snapshots columns
  mapPost(m, obj = {}) {
    const rx = m.post_reactions_by_type_total && typeof m.post_reactions_by_type_total === 'object' ? m.post_reactions_by_type_total : null;
    const reactionsTotal = rx ? Object.values(rx).reduce((a, b) => a + Number(b || 0), 0) : num(obj.reactions?.summary?.total_count);
    return {
      impressions: num(m.post_media_view),
      reach: num(m.post_total_media_view_unique),
      views: num(m.post_video_views),
      likes: num(rx?.like) ?? num(obj.likes?.summary?.total_count),
      comments: num(obj.comments?.summary?.total_count),
      shares: num(obj.shares?.count),
      reactions_total: reactionsTotal, reactions: rx,
      engaged_users: null,   // post_engaged_users dead 2026-09-13, no replacement offered

      clicks: num(m.post_clicks),
      video_views: num(m.post_video_views),
      avg_watch_time_ms: num(m.post_video_avg_time_watched)
    };
  }
};

// ---------------------------------------------------------------- Instagram
const IG = {
  ACCOUNT_FIELDS: 'id,username,name,biography,website,profile_picture_url,followers_count,follows_count,media_count',
  MEDIA_FIELDS: 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count,is_comment_enabled,children{id,media_type,media_url,thumbnail_url}',
  STORY_FIELDS: 'id,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp',

  // period=day time series (supports since/until, 30 days per call)
  // NOTE: `follower_count` is NEW FOLLOWERS ON THAT DAY, not the running total.
  // Meta's naming is misleading; the running total only exists on the profile object
  // (`followers_count`) and is therefore only observable for *today*. See mapAccountDay.
  ACCOUNT_SERIES: ['reach', 'follower_count'],
  // metric_type=total_value, per day (one call per day, batched 50 at a time).
  // `reach` is here only for the day-attribution check in sync.js: it is compared with the series
  // value for the same day and never stored. Without it that check could not run, and a wrong day
  // window went unnoticed from 8 to 18 Sep.
  ACCOUNT_TOTAL: [
    'views', 'profile_views', 'accounts_engaged', 'total_interactions', 'likes', 'comments', 'shares', 'saves',
    'replies', 'profile_links_taps', 'website_clicks', 'follows_and_unfollows', 'impressions', 'reach'
  ],
  ONLINE_FOLLOWERS: 'online_followers',

  MEDIA_LIFETIME: ['views', 'reach', 'likes', 'comments', 'shares', 'saved', 'total_interactions', 'profile_visits', 'follows', 'impressions'],
  REEL_EXTRA: ['ig_reels_avg_watch_time', 'ig_reels_video_view_total', 'plays'],
  STORY_LIFETIME: ['views', 'reach', 'replies', 'navigation', 'shares', 'follows', 'profile_visits', 'total_interactions', 'impressions'],

  AUDIENCE: [
    { metric: 'follower_demographics', type: 'FOLLOWERS', dimension: 'age_gender', breakdown: 'age,gender' },
    { metric: 'follower_demographics', type: 'FOLLOWERS', dimension: 'city', breakdown: 'city' },
    { metric: 'follower_demographics', type: 'FOLLOWERS', dimension: 'country', breakdown: 'country' },
    { metric: 'engaged_audience_demographics', type: 'ENGAGED', dimension: 'age_gender', breakdown: 'age,gender' },
    { metric: 'engaged_audience_demographics', type: 'ENGAGED', dimension: 'country', breakdown: 'country' }
  ],

  mapAccountDay(m) {
    const fu = m.follows_and_unfollows;
    return {
      reach: num(m.reach), views: num(m.views), impressions: num(m.impressions),
      profile_views: num(m.profile_views), accounts_engaged: num(m.accounts_engaged),
      engagements: num(m.total_interactions), likes: num(m.likes), comments: num(m.comments), shares: num(m.shares),
      saves: num(m.saves), replies: num(m.replies), profile_link_taps: num(m.profile_links_taps), website_clicks: num(m.website_clicks),
      follows_day: num(typeof fu === 'object' ? fu?.follows : fu), unfollows_day: num(typeof fu === 'object' ? fu?.unfollows : null),
      // follower_count = followers GAINED on this day. Writing it into followers_total (v2.1 bug)
      // produced a follower chart that plotted 3, 7, 2 … instead of 12,431. The absolute total is
      // filled in by sync.js for today from the profile; historical totals are derived at read time
      // by v_account_daily (followers_total_est), never written back into a frozen row.
      followers_gained_day: num(m.follower_count),
      followers_total: null,
      impressions_organic: null, impressions_paid: null   // Meta offers no split for IG account insights
    };
  },

  mapMedia(m, obj = {}) {
    return {
      views: num(first(m, 'views', 'impressions')), impressions: num(m.impressions), reach: num(m.reach),
      plays: num(first(m, 'ig_reels_video_view_total', 'plays')),
      likes: num(m.likes) ?? num(obj.like_count), comments: num(m.comments) ?? num(obj.comments_count),
      shares: num(m.shares), saves: num(m.saved),
      total_interactions: num(m.total_interactions), profile_visits: num(m.profile_visits), follows: num(m.follows),
      avg_watch_time_ms: num(m.ig_reels_avg_watch_time),
      video_views: num(first(m, 'ig_reels_video_view_total', 'plays', 'views'))
    };
  },

  mapStory(m) {
    return {
      views: num(first(m, 'views', 'impressions')), impressions: num(m.impressions), reach: num(m.reach), shares: num(m.shares),
      follows: num(m.follows), profile_visits: num(m.profile_visits), total_interactions: num(m.total_interactions),
      extra: { replies: num(m.replies), navigation: m.navigation && typeof m.navigation === 'object' ? m.navigation : null }
    };
  }
};

// ---------------------------------------------------------------- column contracts
// Every column on account_metric_snapshots that holds an OBSERVATION (as opposed to identity,
// provenance or the frozen-estimate trio). sync.js uses this list to enforce rule 3 of the
// invariants: a sync never replaces a known value with null. Keep it in step with the table:
// a column added to the schema but missing here silently loses carry-forward protection.
const ACCOUNT_VALUE_COLS = [
  // observed absolute totals
  'followers_total', 'fans_total', 'following_total', 'media_count', 'followers_observed_at',
  // day metrics
  'impressions', 'impressions_organic', 'impressions_paid', 'reach', 'views', 'page_views', 'profile_views', 'engagements',
  'likes', 'comments', 'shares', 'saves', 'replies', 'video_views', 'accounts_engaged',
  'website_clicks', 'profile_link_taps', 'follows_day', 'unfollows_day',
  'fan_adds', 'fan_removes', 'followers_gained_day',
  // structured
  'reactions', 'online_followers'
];

// Insights `total_value` with breakdowns → {"18-24|F": 120}
function breakdownToMap(insight) {
  const out = {};
  const results = insight?.total_value?.breakdowns?.[0]?.results || [];
  for (const r of results) out[(r.dimension_values || []).join('|')] = Number(r.value || 0);
  return out;
}

module.exports = { FB, IG, num, first, breakdownToMap, parseAdsSplit, ACCOUNT_VALUE_COLS };
