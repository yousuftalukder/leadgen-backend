// Public Instagram data into the social tables (0028), and copies of its images.
//
// Instagram's image links expire within days, so thumbnails and profile pictures are copied into a
// public storage bucket ("social"): the workspace, the owner's answers and the PDF show the copy. Only
// images from Instagram's own CDN are fetched. Each read of a post's numbers is kept as a snapshot, so
// a post's growth can be drawn.
const { supabase, q } = require('../db');
const IG = require('./instagram');

const BUCKET = process.env.SOCIAL_BUCKET || 'social';
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_IMAGE = 5 * 1024 * 1024;
const CDN_RE = /^https:\/\/[a-z0-9.-]+\.(?:cdninstagram\.com|fbcdn\.net)\//i;

let ensured = false;
async function ensureBucket() {
  if (ensured) return;
  const { data } = await supabase.storage.getBucket(BUCKET);
  if (!data) {
    const { error } = await supabase.storage.createBucket(BUCKET, { public: true, fileSizeLimit: MAX_IMAGE, allowedMimeTypes: Object.keys(IMAGE_TYPES) });
    if (error && !/already exists/i.test(error.message)) throw new Error(`[social] createBucket: ${error.message}`);
  }
  ensured = true;
}
const publicUrl = (path) => (path ? supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl : null);

// Copy one image from Instagram's CDN to <base>.<ext>. Returns the stored path, or null (never throws).
async function copyImage(url, base) {
  if (!CDN_RE.test(String(url || ''))) return null;
  try {
    await ensureBucket();
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'image/*' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_TYPES[type]) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_IMAGE) return null;
    const path = `${base}.${IMAGE_TYPES[type]}`;
    const { error } = await supabase.storage.from(BUCKET).upload(path, buf, { contentType: type, upsert: true });
    if (error) { console.warn('[social] image upload:', error.message); return null; }
    return path;
  } catch (e) {
    console.warn('[social] image copy:', e.message);
    return null;
  }
}

// A profile row for every account that owns a post, so each post points at one. A row already there is
// left alone: its full figures come from a "details" read (saveProfile). username → id.
async function ensureProfiles(owners) {
  const names = [...new Set(owners.map((o) => IG.cleanUsername(o.username)).filter(Boolean))];
  const ids = new Map();
  if (!names.length) return ids;
  const have = await q(supabase.from('xp_social_profiles').select('id,username').eq('platform', 'IG').in('username', names), 'profiles known');
  for (const r of have) ids.set(r.username, r.id);
  const missing = names.filter((u) => !ids.has(u)).map((u) => {
    const o = owners.find((x) => IG.cleanUsername(x.username) === u) || {};
    return { platform: 'IG', username: u, full_name: o.full_name || null, external_id: o.external_id || null };
  });
  if (missing.length) {
    const added = await q(supabase.from('xp_social_profiles').upsert(missing, { onConflict: 'platform,username', ignoreDuplicates: true }).select('id,username'), 'profiles add');
    for (const r of added) ids.set(r.username, r.id);
    const still = names.filter((u) => !ids.has(u));   // added by someone else between the two reads
    if (still.length) for (const r of await q(supabase.from('xp_social_profiles').select('id,username').eq('platform', 'IG').in('username', still), 'profiles known')) ids.set(r.username, r.id);
  }
  return ids;
}

// A creator's typical likes and comments, from the latest posts a "details" read carries: how well a
// post did for that creator, whatever the size of their following.
function typicalOf(item) {
  const posts = (Array.isArray(item.latestPosts) ? item.latestPosts : []).filter((p) => p && !p.isPinned);
  const med = (vals) => { const v = vals.filter((x) => x !== null).sort((a, b) => a - b); return v.length >= 3 ? v[Math.floor((v.length - 1) / 2)] : null; };
  return { typical_likes: med(posts.map((p) => IG.count(p.likesCount))), typical_comments: med(posts.map((p) => IG.count(p.commentsCount))), latest_posts: posts.length };
}

// One "details" result → its social_profiles row (with a copy of the profile picture). Null if unusable.
async function saveProfile(item) {
  const row = IG.mapProfile(item);
  if (!row) return null;
  const now = new Date().toISOString();
  const saved = await q(supabase.from('xp_social_profiles').upsert({ ...row, raw: { ...row.raw, ...typicalOf(item) }, last_fetched_at: now, updated_at: now }, { onConflict: 'platform,username' })
    .select('id,username,full_name,category,followers,verified,profile_pic_path,last_fetched_at,raw').single(), 'profile save');
  const pic = await copyImage(item.profilePicUrlHD || item.profilePicUrl, `ig/profiles/${row.username}`);
  if (pic && pic !== saved.profile_pic_path) {
    await q(supabase.from('xp_social_profiles').update({ profile_pic_path: pic }).eq('id', saved.id), 'profile pic');
    saved.profile_pic_path = pic;
  }
  return saved;
}

const POST_COLS = 'id,external_id,short_code,url,owner_username,owner_profile_id,posted_at,format,caption,hashtags,mentions,collaborators,tagged,paid_partnership,duration_s,music,views,likes,comments,shares,saves,thumbnail_path,first_seen_at,last_fetched_at,raw,ai';

// Posts from a run, upserted by Instagram id with their latest public numbers; a snapshot of those numbers
// for each; and a thumbnail copy for the ones thumbs(row) picks that have none yet. Returns the saved rows.
async function savePosts(items, { thumbs = () => false } = {}) {
  const byId = new Map();
  for (const it of items || []) {
    const row = IG.mapPost(it);
    if (!row) continue;
    const had = byId.get(row.external_id);   // one post can come from two runs: the tagged tab has its Facebook part, the grid not (F-58)
    if (had && had.row.raw.fb && !row.raw.fb) row.raw.fb = had.row.raw.fb;
    byId.set(row.external_id, { it, row });
  }
  const list = [...byId.values()];
  if (!list.length) return [];
  const owners = await ensureProfiles(list.map(({ row }) => ({ username: row.owner_username, full_name: row.raw.owner_full_name, external_id: row.raw.owner_id })));
  // A profile's grid often comes without comment text, while a read of the post itself has it: a read
  // without comments keeps the ones stored before.
  const before = await q(supabase.from('xp_social_posts').select('external_id,raw').eq('platform', 'IG').in('external_id', list.map(({ row }) => row.external_id)), 'posts before');
  const kept = new Map(before.map((b) => [b.external_id, b.raw || {}]));
  const now = new Date().toISOString();
  for (const { row } of list) {
    const old = kept.get(row.external_id) || {};
    if (!row.raw.comments.length && (old.comments || []).length) row.raw.comments = old.comments;
    // The Facebook part of a reel the creator also shared there: from this read when it carries it, else as last read.
    if (row.raw.fb) row.raw.fb = { ...row.raw.fb, read_at: now };
    else if (old.fb) row.raw.fb = old.fb;
  }
  const saved = await q(supabase.from('xp_social_posts')
    .upsert(list.map(({ row }) => ({ ...row, owner_profile_id: owners.get(row.owner_username) || null, last_fetched_at: now })), { onConflict: 'platform,external_id' })
    .select(POST_COLS), 'social posts');
  await q(supabase.from('xp_social_post_snapshots').insert(saved.map((p) => ({ post_id: p.id, fetched_at: now, views: p.views, likes: p.likes, comments: p.comments, shares: p.shares, saves: p.saves }))), 'social snapshots');
  for (const p of saved) {
    if (p.thumbnail_path || !p.short_code || !thumbs(p)) continue;
    const it = byId.get(p.external_id)?.it;
    const path = it ? await copyImage(it.displayUrl, `ig/posts/${p.short_code}`) : null;
    if (path) {
      await q(supabase.from('xp_social_posts').update({ thumbnail_path: path }).eq('id', p.id), 'thumbnail');
      p.thumbnail_path = path;
    }
  }
  return saved;
}

// Posts asked for that Instagram did not return (deleted, archived or made private): their numbers stay as
// last read, marked with the day they went missing, and they wait for their next scheduled read.
async function markMissing(posts) {
  const now = new Date().toISOString();
  for (const p of posts) {
    await q(supabase.from('xp_social_posts').update({ last_fetched_at: now, raw: { ...(p.raw || {}), missing_since: p.raw?.missing_since || now } }).eq('id', p.id), 'post missing');
  }
}

module.exports = { BUCKET, POST_COLS, ensureBucket, publicUrl, copyImage, ensureProfiles, saveProfile, savePosts, markMissing, typicalOf };
