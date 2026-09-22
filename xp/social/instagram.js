// Instagram as Apify's scraper (apify/instagram-scraper) returns it, mapped onto the social tables (0028).
// Pure functions: no database, no network.
//
// What the scraper gives, checked on real results (19 Sep 2026):
// - resultsType "posts" on a profile: its grid, newest first, INCLUDING collab posts other accounts own
//   (the restaurant is in coauthorProducers). Meta's API never returns those.
// - resultsType "mentions" on a profile: its tagged tab, i.e. other accounts' posts that tag it, collab or not.
// - onlyPostsNewerThan works in both modes; pinned posts come back whatever their date.
// - videoPlayCount is the public "views" of a reel, and equals the Views Meta reports to the owner
//   (146/146, 233/233, 1,164/1,164, 1,635/1,635 on Shaking Seafood's reels), so the two can be compared.
// - v2.14.1 (F-58): a reel the creator also shared to Facebook. Instagram's public numbers then include the
//   Facebook part. The tagged tab returns those totals (videoPlayCount, likesCount) with the split
//   (igPlayCount, fbPlayCount, fbLikeCount); the grid and a read of the post's own link return the Instagram
//   part only (738 = 464 + 274 views and 37 = 35 + 2 likes on @amp_eats's reel, 19 Sep). So views and likes
//   hold the Instagram part, the same from every read, and the Facebook part is kept apart (raw.fb).
// - A count the owner hid (likes) comes back as -1: that is "hidden", not zero.

const USERNAME_RE = /^[a-z0-9._]{1,30}$/;
const SHORTCODE_RE = /^[A-Za-z0-9_-]{5,40}$/;
const RESERVED = new Set(['p', 'reel', 'reels', 'tv', 'stories', 'explore', 'accounts', 'direct', 'about', 'developer', 'legal', 'web']);

// "@Name", "name", "instagram.com/name", "https://www.instagram.com/name/?igsh=…" → "name", else null.
function cleanUsername(input) {
  let s = String(input || '').trim();
  const m = s.match(/^(?:https?:\/\/)?(?:www\.|m\.)?instagram\.com\/([^/?#]+)/i);
  if (m) s = m[1];
  s = s.replace(/^@/, '').toLowerCase();
  return USERNAME_RE.test(s) && !RESERVED.has(s) ? s : null;
}
const profileUrl = (username) => `https://www.instagram.com/${username}/`;

// A post or reel link in any of Instagram's shapes → { shortCode, url } (url in the /p/ form), else null.
function postLink(input) {
  const s = String(input || '').trim();
  const m = s.match(/^(?:https?:\/\/)?(?:www\.|m\.)?instagram\.com\/(?:[a-z0-9._]{1,30}\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,40})/i);
  if (!m || !SHORTCODE_RE.test(m[1])) return null;
  return { shortCode: m[1], url: `https://www.instagram.com/p/${m[1]}/` };
}

// A count as Instagram shows it: a whole number, or null when hidden (-1) or missing.
const count = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) || Number(v) < 0 ? null : Math.round(Number(v)));
const lowerList = (list, max = 60) => [...new Set((Array.isArray(list) ? list : []).map((x) => String(typeof x === 'object' && x ? x.username || '' : x || '').replace(/^[@#]/, '').trim().toLowerCase()).filter(Boolean))].slice(0, max);

function formatOf(item) {
  const type = String(item?.type || '');
  if (type === 'Sidecar') return 'CAROUSEL';
  if (type === 'Video') return item.productType === 'clips' ? 'REEL' : 'VIDEO';
  if (type === 'Image') return 'PHOTO';
  return null;
}

// A post's comments as the scraper gives them (the newest 15 on Apify's free plan): kept short, for
// "what are people saying" and for content work, never shown with more than the text needs.
function commentsOf(item) {
  return (Array.isArray(item?.latestComments) ? item.latestComments : []).slice(0, 15).map((c) => ({
    text: String(c.text || '').slice(0, 500), username: String(c.ownerUsername || '').toLowerCase() || null,
    at: c.timestamp || null, likes: count(c.likesCount)
  })).filter((c) => c.text);
}

// One scraper result → a social_posts row (without ids). Null for an error item or one without an id.
function mapPost(item) {
  if (!item || item.error || !item.id) return null;
  const link = postLink(item.url) || (item.shortCode ? { shortCode: item.shortCode, url: `https://www.instagram.com/p/${item.shortCode}/` } : null);
  const format = formatOf(item);
  const plays = count(item.igPlayCount ?? item.videoPlayCount);   // Instagram's part (F-58)
  const fbViews = count(item.fbPlayCount), fbLikes = count(item.fbLikeCount), likesAll = count(item.likesCount);
  const likes = likesAll !== null && fbLikes !== null ? Math.max(0, likesAll - fbLikes) : likesAll;
  const fb = (fbViews || 0) > 0 || (fbLikes || 0) > 0 ? { views: fbViews, likes: fbLikes } : null;
  const music = item.musicInfo && (item.musicInfo.song_name || item.musicInfo.artist_name)
    ? [item.musicInfo.song_name, item.musicInfo.artist_name].filter(Boolean).join(' — ').slice(0, 200) : null;
  return {
    platform: 'IG',
    external_id: String(item.id),
    short_code: link ? link.shortCode : item.shortCode || null,
    url: link ? link.url : item.url || null,
    owner_username: String(item.ownerUsername || '').toLowerCase() || null,
    posted_at: item.timestamp || null,
    format,
    caption: item.caption ? String(item.caption).slice(0, 5000) : null,
    hashtags: lowerList(item.hashtags),
    mentions: lowerList(item.mentions),
    collaborators: lowerList(item.coauthorProducers, 20),
    tagged: lowerList(item.taggedUsers, 40),
    paid_partnership: typeof item.paidPartnership === 'boolean' ? item.paidPartnership : null,
    duration_s: Number.isFinite(Number(item.videoDuration)) ? Math.round(Number(item.videoDuration) * 10) / 10 : null,
    music,
    views: format === 'REEL' || format === 'VIDEO' ? plays : null,
    likes,
    comments: count(item.commentsCount),
    shares: null,
    saves: null,
    raw: {
      type: item.type || null, product_type: item.productType || null,
      width: count(item.dimensionsWidth), height: count(item.dimensionsHeight), slides: Array.isArray(item.childPosts) ? item.childPosts.length || null : null,
      alt: item.alt ? String(item.alt).slice(0, 500) : null, owner_full_name: item.ownerFullName || null, owner_id: item.ownerId ? String(item.ownerId) : null,
      pinned: item.isPinned === true, likes_hidden: Number(item.likesCount) === -1, comments_off: item.isCommentsDisabled === true,
      comments: commentsOf(item),
      ...(fb ? { fb } : {})   // the Facebook part, when the creator also shared it there (store.savePosts stamps read_at)
    }
  };
}

// One "details" result → a social_profiles row (without ids). Null for an error item.
function mapProfile(item) {
  const username = cleanUsername(item && item.username);
  if (!item || item.error || !username) return null;
  return {
    platform: 'IG',
    username,
    external_id: item.id ? String(item.id) : null,
    full_name: item.fullName ? String(item.fullName).slice(0, 200) : null,
    biography: item.biography ? String(item.biography).slice(0, 1000) : null,
    category: item.businessCategoryName ? String(item.businessCategoryName).slice(0, 100) : null,
    verified: typeof item.verified === 'boolean' ? item.verified : null,
    is_business: typeof item.isBusinessAccount === 'boolean' ? item.isBusinessAccount : null,
    followers: count(item.followersCount),
    following: count(item.followsCount),
    posts_count: count(item.postsCount),
    raw: { external_url: item.externalUrl || null, private: item.private === true }
  };
}

// Whose post is it, and how does it involve the restaurant?
const isCollab = (post, username) => post.owner_username !== username && post.collaborators.includes(username);
const isAbout = (post, username) => post.owner_username !== username
  && (post.collaborators.includes(username) || post.tagged.includes(username) || post.mentions.includes(username));

// When a post's public numbers are read again: daily in its first week, every 3 days to day 30, every
// 14 days to day 90, then never on schedule (they barely move by then). The hours of slack keep a post
// read at 09:05 from missing the next day's 09:00 pass.
const HOUR = 3600e3, DAY = 24 * HOUR;
function refreshDue(post, now = Date.now()) {
  if (!post.posted_at) return false;
  const age = now - Date.parse(post.posted_at);
  const since = post.last_fetched_at ? now - Date.parse(post.last_fetched_at) : Infinity;
  if (age <= 7 * DAY) return since >= 20 * HOUR;
  if (age <= 30 * DAY) return since >= 3 * DAY - 4 * HOUR;
  if (age <= 90 * DAY) return since >= 14 * DAY - 4 * HOUR;
  return false;
}

module.exports = { cleanUsername, profileUrl, postLink, count, formatOf, mapPost, mapProfile, commentsOf, isCollab, isAbout, refreshDue };
