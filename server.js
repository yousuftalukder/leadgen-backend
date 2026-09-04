/**
 * EDGELEAD MASTER BACKEND
 * ---------------------------------------------------------------------------
 * Express 5 + Supabase (service role) + Apify + Gemini
 *
 * Backwards compatible: every endpoint the current index.html and
 * ig-report.html call still exists and still returns the same shape.
 *
 * New in this version:
 *   - Apify key pool with automatic failover (primary-per-engine preserved)
 *   - Master admin: create users, grant per-engine access, per-user keys
 *   - Async job engine (create -> poll) for long competitor runs
 *   - Post-level storage (public.posts) so reports stop being shallow
 *   - Deep audit: content mix, hashtag intel, posting rhythm, 30d trend
 *   - Competitor benchmarking against up to 10 manually supplied handles
 *   - Gemini narrative layer (server-side only, cached into the report row)
 *
 * FACEBOOK COMMUNITY ENGINE (engine key: 'fb_community'):
 *   - Engine 1 Discovery: rank local groups by Room Value, not member count
 *   - Engine 2 Audit: 30/60/90-day scrape, indexed against each room's own
 *     median, sliced by format / intent / time / length / opening pattern.
 *     Runs combined (one comparative report) or individual (one per room) —
 *     the user picks per run.
 *   - Engine 3 Advisor: drafts conditioned on one room's real data, with a
 *     hard-coded compliance gate for groups that ban promotion
 *   - Demand mining: buying intent extracted into a lead feed, author names
 *     hashed rather than stored
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const cors = require('cors');
const { ApifyClient } = require('apify-client');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();

const ALLOWED = (process.env.ALLOWED_ORIGINS || '*')
    .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({ origin: ALLOWED.includes('*') ? '*' : ALLOWED }));
app.use(express.json({ limit: '2mb' }));

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
);

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const MASTER_ADMIN_EMAIL     = (process.env.MASTER_ADMIN_EMAIL || '').toLowerCase().trim();
const GEMINI_API_KEY         = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL           = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const MAX_COMPETITORS        = parseInt(process.env.MAX_COMPETITORS || '10', 10);
const DEFAULT_POSTS_PER_ACC  = parseInt(process.env.DEFAULT_POSTS_PER_ACCOUNT || '30', 10);
const MAX_POSTS_PER_ACC      = parseInt(process.env.MAX_POSTS_PER_ACCOUNT || '100', 10);
const ENGINES                = ['leadgen', 'report', 'fb_community'];

// --- Facebook community engine ---------------------------------------------
// Actor IDs are env-overridable on purpose: Apify's Facebook actors get
// renamed and re-published far more often than the Instagram ones.
const FB_GROUP_POSTS_ACTOR = process.env.FB_GROUP_POSTS_ACTOR || 'apify/facebook-groups-scraper';
const FB_SEARCH_ACTOR      = process.env.FB_SEARCH_ACTOR      || 'apify/facebook-search-scraper';
const FB_COMMENTS_ACTOR    = process.env.FB_COMMENTS_ACTOR    || 'apify/facebook-comments-scraper';
const FB_MAX_GROUPS        = parseInt(process.env.FB_MAX_GROUPS        || '15', 10);
const FB_DEFAULT_POSTS     = parseInt(process.env.FB_DEFAULT_POSTS_PER_GROUP || '120', 10);
const FB_MAX_POSTS         = parseInt(process.env.FB_MAX_POSTS_PER_GROUP     || '400', 10);
const FB_DEFAULT_DAYS      = parseInt(process.env.FB_DEFAULT_DAYS_WINDOW     || '60', 10);
const FB_TZ_OFFSET_MINS    = parseInt(process.env.FB_TZ_OFFSET_MINUTES || '360', 10); // default Asia/Dhaka +6
const COST_PER_1K_FB_POSTS = parseFloat(process.env.COST_PER_1K_FB_POSTS || '3.50');
const FB_COMMENT_WEIGHT    = parseFloat(process.env.FB_COMMENT_WEIGHT || '3');
const FB_SHARE_WEIGHT      = parseFloat(process.env.FB_SHARE_WEIGHT   || '4');

// Rough Apify pricing used for the pre-run estimate only.
const COST_PER_1K_POSTS   = parseFloat(process.env.COST_PER_1K_POSTS   || '2.30');
const COST_PER_1K_PROFILE = parseFloat(process.env.COST_PER_1K_PROFILE || '2.30');

// ===========================================================================
// AUTH + TENANCY
// ===========================================================================

async function ensureProfile(user) {
    const email = (user.email || '').toLowerCase();

    let { data: profile } = await supabase
        .from('app_users').select('*').eq('id', user.id).maybeSingle();

    if (!profile) {
        // Bootstrap: master admin by env, or the very first user if no admin exists.
        let role = 'user';
        if (MASTER_ADMIN_EMAIL && email === MASTER_ADMIN_EMAIL) {
            role = 'admin';
        } else {
            const { count } = await supabase
                .from('app_users').select('id', { count: 'exact', head: true }).eq('role', 'admin');
            if (!count) role = 'admin';
        }

        const { data: created } = await supabase.from('app_users').upsert({
            id: user.id, email, role, is_active: true, updated_at: new Date().toISOString()
        }).select().maybeSingle();

        profile = created || { id: user.id, email, role, is_active: true };

        if (role === 'user') {
            // legacy single-tenant safety: grant nothing, admin must grant.
        } else {
            for (const e of ENGINES) {
                await supabase.from('user_engine_access')
                    .upsert({ user_id: user.id, engine: e }, { onConflict: 'user_id,engine' });
            }
        }
    } else if (MASTER_ADMIN_EMAIL && email === MASTER_ADMIN_EMAIL && profile.role !== 'admin') {
        await supabase.from('app_users').update({ role: 'admin' }).eq('id', user.id);
        profile.role = 'admin';
    }

    return profile;
}

/** Resolves the caller. Returns null and writes the response on failure. */
async function auth(req, res) {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) { res.status(401).json({ error: 'Unauthorized' }); return null; }

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) { res.status(401).json({ error: 'Unauthorized' }); return null; }

    const profile = await ensureProfile(data.user);
    if (profile && profile.is_active === false) {
        res.status(403).json({ error: 'Account disabled. Contact your administrator.' });
        return null;
    }

    return { user: data.user, profile: profile || { role: 'user' } };
}

async function requireAdmin(req, res) {
    const ctx = await auth(req, res);
    if (!ctx) return null;
    if (ctx.profile.role !== 'admin') {
        res.status(403).json({ error: 'Admin access required' });
        return null;
    }
    return ctx;
}

async function requireEngine(req, res, engine) {
    const ctx = await auth(req, res);
    if (!ctx) return null;
    if (ctx.profile.role === 'admin') return ctx;

    const { data } = await supabase.from('user_engine_access')
        .select('id').eq('user_id', ctx.user.id).eq('engine', engine).maybeSingle();

    if (!data) {
        res.status(403).json({ error: `No access to the ${engine} engine. Ask your administrator.` });
        return null;
    }
    return ctx;
}

// ===========================================================================
// APIFY KEY RESOLUTION  (per-user key > engine primary > pool > env)
// ===========================================================================

function primaryKeyName(engine) {
    if (engine === 'report')       return 'report_apify_token';
    if (engine === 'fb_community') return 'fb_apify_token';
    return 'leadgen_apify_token';
}

async function getEnginePrimary(engine) {
    try {
        const { data } = await supabase.from('system_settings')
            .select('value').eq('key', primaryKeyName(engine)).maybeSingle();
        return data?.value || null;
    } catch { return null; }
}

/** Ordered list of candidate tokens to try for this engine + user. */
async function buildTokenCandidates(engine, userId) {
    const out = [];
    const seen = new Set();
    const push = (token, source, id) => {
        if (!token || seen.has(token)) return;
        seen.add(token);
        out.push({ token, source, id: id || null });
    };

    // 1. The user's own keys (they bring their own credits once granted access)
    if (userId) {
        const { data: mine } = await supabase.from('apify_keys')
            .select('id, token, engine, status, last_used_at')
            .eq('owner_user_id', userId)
            .eq('status', 'active')
            .in('engine', [engine, 'any'])
            .order('last_used_at', { ascending: true, nullsFirst: true });
        (mine || []).forEach(k => push(k.token, 'user_pool', k.id));
    }

    // 2. The engine primary key — always present, never deleted
    push(await getEnginePrimary(engine), 'engine_primary');

    // 3. Global rotation pool
    const { data: pool } = await supabase.from('apify_keys')
        .select('id, token, engine, status, last_used_at')
        .is('owner_user_id', null)
        .eq('status', 'active')
        .in('engine', [engine, 'any'])
        .order('last_used_at', { ascending: true, nullsFirst: true });
    (pool || []).forEach(k => push(k.token, 'global_pool', k.id));

    // 4. Env fallback
    push(process.env.APIFY_API_KEY || process.env.APIFY_API_TOKEN, 'env');

    return out;
}

async function markKey(id, patch) {
    if (!id) return;
    try { await supabase.from('apify_keys').update(patch).eq('id', id); } catch {}
}

/**
 * Returns { client, candidate } for the first token that authenticates.
 * Dead / exhausted keys are flagged in the pool so they stop being retried.
 */
async function getWorkingClient(engine, userId) {
    const candidates = await buildTokenCandidates(engine, userId);
    if (!candidates.length) throw new Error('No Apify key configured for this engine.');

    let lastErr = null;
    for (const c of candidates) {
        try {
            const client = new ApifyClient({ token: c.token });
            const u = await client.user().get();
            await markKey(c.id, {
                last_used_at: new Date().toISOString(),
                last_checked_at: new Date().toISOString(),
                apify_username: u.username,
                fail_count: 0
            });
            return { client, candidate: c, apifyUsername: u.username };
        } catch (err) {
            lastErr = err;
            const msg = (err.message || '').toLowerCase();
            const dead = msg.includes('token') || msg.includes('unauthor') || msg.includes('forbidden');
            await markKey(c.id, {
                status: dead ? 'invalid' : 'exhausted',
                last_checked_at: new Date().toISOString()
            });
        }
    }
    throw new Error('All Apify keys failed: ' + (lastErr?.message || 'unknown'));
}

// Legacy helpers kept so nothing else in the file has to change shape.
async function getLeadgenApifyClient(userId) { return (await getWorkingClient('leadgen', userId)).client; }
async function getReportApifyClient(userId)  { return (await getWorkingClient('report',  userId)).client; }

// ===========================================================================
// APIFY EXTRACTION HELPERS
// ===========================================================================

function getViews(i) {
    return i.videoPlayCount || i.playCount || i.videoViewCount || i.viewCount || i.reelsCount || 0;
}

function extractPosts(items) {
    const posts = [];
    (items || []).forEach(item => {
        if (!item) return;
        if (item.ownerUsername || item.shortCode || item.caption) posts.push(item);
        if (Array.isArray(item.topPosts))    posts.push(...item.topPosts);
        if (Array.isArray(item.latestPosts)) posts.push(...item.latestPosts);
        if (Array.isArray(item.posts))       posts.push(...item.posts);
    });
    return posts;
}

function shortcodeOf(p) {
    if (p.shortCode) return p.shortCode;
    if (p.code) return p.code;
    const m = (p.url || '').match(/\/(?:p|reel|tv)\/([^/?#]+)/);
    return m ? m[1] : null;
}

function postTypeOf(p) {
    const pt = (p.productType || '').toLowerCase();
    if (pt === 'clips' || p.isReel) return 'Reel';
    const t = (p.type || '').toLowerCase();
    if (t === 'sidecar' || Array.isArray(p.childPosts) && p.childPosts.length > 1) return 'Carousel';
    if (t === 'video' || p.isVideo) return 'Video';
    if (t === 'image') return 'Image';
    return p.videoUrl ? 'Video' : 'Image';
}

function tagsOf(text, sym) {
    const re = sym === '#' ? /#[\p{L}\p{N}_]+/gu : /@[A-Za-z0-9_.]+/g;
    return Array.from(new Set((text || '').match(re) || [])).map(s => s.slice(1).toLowerCase());
}

function tsOf(p) {
    const raw = p.timestamp || p.takenAt || p.taken_at_timestamp || null;
    if (!raw) return null;
    const d = typeof raw === 'number' ? new Date(raw * (raw > 1e12 ? 1 : 1000)) : new Date(raw);
    return isNaN(d.getTime()) ? null : d;
}

async function runActor(actorId, input, warningsArray, methodName, client) {
    try {
        console.log(`[Apify] ${actorId} :: ${methodName}`);
        const run = await client.actor(actorId).call(input);
        const { items } = await client.dataset(run.defaultDatasetId).listItems();
        const extracted = extractPosts(items || []);
        if (warningsArray) warningsArray.push(`X-RAY (${methodName}): Extracted ${extracted.length} real posts.`);
        return extracted;
    } catch (err) {
        console.error(`[Apify ERROR] ${actorId}:`, err.message);
        if (warningsArray) warningsArray.push(`Error (${methodName}): ${err.message}`);
        return [];
    }
}

// ===========================================================================
// POST PERSISTENCE
// ===========================================================================

async function savePosts(userId, handle, posts, meta = {}) {
    const rows = [];
    const seen = new Set();

    for (const p of posts || []) {
        const sc = shortcodeOf(p);
        if (!sc || seen.has(sc)) continue;
        seen.add(sc);

        const caption = p.caption || p.text || '';
        const d = tsOf(p);

        rows.push({
            user_id: userId,
            platform: 'instagram',
            handle: (handle || p.ownerUsername || '').toLowerCase(),
            shortcode: sc,
            post_url: p.url || `https://www.instagram.com/p/${sc}/`,
            post_type: postTypeOf(p),
            caption: caption.slice(0, 4000),
            caption_length: caption.length,
            hashtags: tagsOf(caption, '#').slice(0, 40),
            mentions: tagsOf(caption, '@').slice(0, 40),
            likes: p.likesCount || 0,
            comments: p.commentsCount || 0,
            views: getViews(p),
            is_video: !!(p.isVideo || p.videoUrl),
            video_duration: p.videoDuration || null,
            thumbnail_url: p.displayUrl || p.thumbnailUrl || null,
            media_url: p.videoUrl || p.displayUrl || null,
            location_name: p.locationName || p.location?.name || null,
            posted_at: d ? d.toISOString() : null,
            report_id: meta.reportId || null,
            set_id: meta.setId || null,
            scraped_at: new Date().toISOString()
        });
    }

    if (!rows.length) return 0;

    for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        const { error } = await supabase.from('posts')
            .upsert(chunk, { onConflict: 'user_id,platform,shortcode' });
        if (error) console.error('[savePosts]', error.message);
    }
    return rows.length;
}

// ===========================================================================
// ANALYTICS ENGINE
// ===========================================================================

function bucketCaption(len) {
    if (len < 100) return 'short (<100)';
    if (len < 300) return 'medium (100-300)';
    if (len < 800) return 'long (300-800)';
    return 'very long (800+)';
}

function computeAudit(handle, profile, posts) {
    const followers = profile.followersCount ?? profile.followers ?? 0;
    const clean = (posts || []).filter(p => shortcodeOf(p));

    const base = {
        handle,
        followers,
        following: profile.followsCount ?? profile.followingCount ?? 0,
        totalPosts: profile.postsCount ?? profile.postsCount ?? 0,
        fullName: profile.fullName || null,
        bio: profile.biography || '',
        website: profile.externalUrl || profile.website || null,
        category: profile.businessCategoryName || profile.categoryName || null,
        isBusiness: !!profile.isBusinessAccount,
        isVerified: !!profile.verified || !!profile.isVerified,
        email: profile.businessEmail || profile.biographyEmail || null,
        phone: profile.businessPhoneNumber || null,
        city: profile.city || profile.cityName || null,
        address: profile.addressStreet || null,
        profilePic: profile.profilePicUrlHD || profile.profilePicUrl || null,
        postsAnalyzed: clean.length
    };

    if (!clean.length) {
        return {
            ...base,
            engagementRate: '0.0', viralityScore: '0.0', postsPerWeek: '0.0',
            avgLikes: 0, avgComments: 0, avgViews: 0, score: 0, grade: 'C',
            contentMix: {}, topHashtags: [], postingHours: {}, postingDays: {},
            captionInsight: {}, last30Days: {}, consistency: {}, topPosts: []
        };
    }

    let likes = 0, comments = 0, views = 0;
    const mix = {}, hours = {}, days = {}, tagStat = {}, capStat = {};
    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const stamps = [];

    clean.forEach(p => {
        const l = p.likesCount || 0, c = p.commentsCount || 0, v = getViews(p);
        likes += l; comments += c; views += v;

        const type = postTypeOf(p);
        mix[type] = mix[type] || { count: 0, likes: 0, comments: 0, views: 0 };
        mix[type].count++; mix[type].likes += l; mix[type].comments += c; mix[type].views += v;

        const cap = p.caption || p.text || '';
        const bucket = bucketCaption(cap.length);
        capStat[bucket] = capStat[bucket] || { count: 0, engagement: 0 };
        capStat[bucket].count++; capStat[bucket].engagement += l + c;

        tagsOf(cap, '#').forEach(t => {
            tagStat[t] = tagStat[t] || { uses: 0, engagement: 0 };
            tagStat[t].uses++; tagStat[t].engagement += l + c;
        });

        const d = tsOf(p);
        if (d) {
            stamps.push(d.getTime());
            const h = d.getUTCHours();
            hours[h] = hours[h] || { count: 0, engagement: 0 };
            hours[h].count++; hours[h].engagement += l + c;
            const dn = dayNames[d.getUTCDay()];
            days[dn] = days[dn] || { count: 0, engagement: 0 };
            days[dn].count++; days[dn].engagement += l + c;
        }
    });

    const n = clean.length;
    const avgLikes = likes / n, avgComments = comments / n, avgViews = views / n;
    const avgInteractions = avgLikes + avgComments;
    const engagementRate = followers > 0 ? ((avgInteractions / followers) * 100).toFixed(2) : '0.0';
    const viralityScore  = followers > 0 ? (avgViews / followers).toFixed(2) : '0.0';

    stamps.sort((a, b) => a - b);
    const daysSpan = stamps.length > 1
        ? Math.max(1, (stamps[stamps.length - 1] - stamps[0]) / 86400000)
        : 1;
    const postsPerWeek = ((n / daysSpan) * 7).toFixed(1);

    let longestGap = 0;
    for (let i = 1; i < stamps.length; i++) {
        longestGap = Math.max(longestGap, (stamps[i] - stamps[i - 1]) / 86400000);
    }

    const cutoff = Date.now() - 30 * 86400000;
    const recent = clean.filter(p => { const d = tsOf(p); return d && d.getTime() >= cutoff; });
    const recentEng = recent.reduce((s, p) => s + (p.likesCount || 0) + (p.commentsCount || 0), 0);

    const contentMix = {};
    Object.entries(mix).forEach(([k, v]) => {
        contentMix[k] = {
            count: v.count,
            share: ((v.count / n) * 100).toFixed(1) + '%',
            avgLikes: Math.round(v.likes / v.count),
            avgComments: Math.round(v.comments / v.count),
            avgViews: Math.round(v.views / v.count),
            avgEngagement: Math.round((v.likes + v.comments) / v.count)
        };
    });

    const topHashtags = Object.entries(tagStat)
        .map(([tag, s]) => ({ tag, uses: s.uses, avgEngagement: Math.round(s.engagement / s.uses) }))
        .sort((a, b) => b.uses - a.uses || b.avgEngagement - a.avgEngagement)
        .slice(0, 15);

    const rank = o => Object.entries(o)
        .map(([k, v]) => ({ key: k, count: v.count, avgEngagement: Math.round(v.engagement / v.count) }))
        .sort((a, b) => b.avgEngagement - a.avgEngagement);

    const captionInsight = {};
    Object.entries(capStat).forEach(([k, v]) => {
        captionInsight[k] = { count: v.count, avgEngagement: Math.round(v.engagement / v.count) };
    });

    // 0-100 composite score
    const erPts   = Math.min(40, parseFloat(engagementRate) * 13);
    const viPts   = Math.min(25, parseFloat(viralityScore) * 12);
    const freqPts = Math.min(20, parseFloat(postsPerWeek) * 4);
    const mixPts  = Math.min(15, (Object.keys(mix).length) * 5);
    const score   = Math.round(erPts + viPts + freqPts + mixPts);

    let grade = 'C';
    if (score >= 85) grade = 'A+';
    else if (score >= 70) grade = 'A';
    else if (score >= 55) grade = 'B';
    else if (score >= 40) grade = 'C';
    else grade = 'D';

    const topPosts = [...clean]
        .sort((a, b) => ((b.likesCount || 0) + (b.commentsCount || 0)) - ((a.likesCount || 0) + (a.commentsCount || 0)))
        .slice(0, 5)
        .map(p => ({
            url: p.url || (shortcodeOf(p) ? `https://www.instagram.com/p/${shortcodeOf(p)}/` : null),
            likes: p.likesCount || 0,
            comments: p.commentsCount || 0,
            views: getViews(p),
            type: postTypeOf(p),
            postedAt: tsOf(p)?.toISOString() || null,
            caption: (p.caption || '').slice(0, 300),
            thumbnail: p.displayUrl || null
        }));

    return {
        ...base,
        engagementRate, viralityScore, postsPerWeek, score, grade,
        avgLikes: Math.round(avgLikes),
        avgComments: Math.round(avgComments),
        avgViews: Math.round(avgViews),
        contentMix, topHashtags,
        postingHours: rank(hours).slice(0, 6),
        postingDays: rank(days),
        captionInsight,
        consistency: {
            postsPerWeek,
            longestGapDays: longestGap.toFixed(1),
            windowDays: daysSpan.toFixed(0)
        },
        last30Days: {
            posts: recent.length,
            totalEngagement: recentEng,
            avgEngagement: recent.length ? Math.round(recentEng / recent.length) : 0
        },
        topPosts
    };
}

function buildBenchmark(main, rivals) {
    const all = [main, ...rivals];
    const avg = k => all.reduce((s, a) => s + parseFloat(a[k] || 0), 0) / all.length;

    const cohort = {
        accounts: all.length,
        avgFollowers: Math.round(all.reduce((s, a) => s + (a.followers || 0), 0) / all.length),
        avgEngagementRate: avg('engagementRate').toFixed(2),
        avgViralityScore: avg('viralityScore').toFixed(2),
        avgPostsPerWeek: avg('postsPerWeek').toFixed(1),
        avgScore: Math.round(avg('score'))
    };

    const ranked = [...all].sort((a, b) => b.score - a.score).map((a, i) => ({
        rank: i + 1, handle: a.handle, score: a.score, grade: a.grade,
        followers: a.followers, engagementRate: a.engagementRate,
        postsPerWeek: a.postsPerWeek, isTarget: a.handle === main.handle
    }));

    const gaps = {
        engagementRate: (parseFloat(main.engagementRate) - parseFloat(cohort.avgEngagementRate)).toFixed(2),
        viralityScore:  (parseFloat(main.viralityScore)  - parseFloat(cohort.avgViralityScore)).toFixed(2),
        postsPerWeek:   (parseFloat(main.postsPerWeek)   - parseFloat(cohort.avgPostsPerWeek)).toFixed(1),
        score:          main.score - cohort.avgScore
    };

    // hashtags the cohort uses that the target does not
    const mine = new Set((main.topHashtags || []).map(h => h.tag));
    const theirs = {};
    rivals.forEach(r => (r.topHashtags || []).forEach(h => {
        if (mine.has(h.tag)) return;
        theirs[h.tag] = theirs[h.tag] || { tag: h.tag, usedBy: 0, avgEngagement: 0 };
        theirs[h.tag].usedBy++;
        theirs[h.tag].avgEngagement = Math.round((theirs[h.tag].avgEngagement + h.avgEngagement) / 2);
    }));

    const hashtagGaps = Object.values(theirs)
        .sort((a, b) => b.usedBy - a.usedBy || b.avgEngagement - a.avgEngagement)
        .slice(0, 15);

    return { cohort, ranked, gaps, hashtagGaps, targetRank: ranked.find(r => r.isTarget)?.rank || null };
}

function ruleRecommendations(a) {
    const out = [];
    if (parseFloat(a.engagementRate) < 1.5)
        out.push('Engagement rate is below the 1.5% healthy band. Close captions with a direct question and shift static posts into multi-slide carousels.');
    if (parseFloat(a.viralityScore) < 0.8)
        out.push('Reel play counts are trailing follower totals. Move to 7-15 second trending Reels to re-enter the Explore distribution.');
    if (parseFloat(a.postsPerWeek) < 3.0)
        out.push(`Posting cadence is ${a.postsPerWeek}/week. Target 4-5 to avoid algorithmic drop-off.`);
    if (parseFloat(a.consistency?.longestGapDays || 0) > 14)
        out.push(`There is a ${a.consistency.longestGapDays}-day silence in the recent window. Gaps that long reset reach.`);
    if (!a.website)
        out.push('No link in bio. Add a tracked landing page — this is the single cheapest conversion fix.');
    if (!out.length)
        out.push('Account health is strong. Hold the current Reel cadence and scale the top-performing formats.');
    return out;
}

// ===========================================================================
// GEMINI NARRATIVE LAYER
// ===========================================================================

async function geminiNarrative(payload) {
    if (!GEMINI_API_KEY) return null;

    const prompt =
`You are a senior social media strategist writing a paid client audit.
Analyse the JSON below and reply with ONLY valid JSON matching this schema:

{
 "executive_summary": "3-4 sentences a business owner would understand",
 "strengths": ["..."],
 "weaknesses": ["..."],
 "competitor_insights": ["what rivals are doing that the target is not"],
 "content_strategy": ["specific formats, hooks and posting slots"],
 "hashtag_strategy": ["..."],
 "action_plan_30_days": [{"week":"Week 1","actions":["..."]}],
 "kpi_targets": {"engagement_rate":"x%","posts_per_week":"n","reels_share":"x%"}
}

No markdown, no commentary outside the JSON.

DATA:
${JSON.stringify(payload).slice(0, 60000)}`;

    try {
        const r = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.4,
                        maxOutputTokens: 4096,
                        responseMimeType: 'application/json'
                    }
                })
            }
        );

        if (!r.ok) { console.error('[Gemini]', r.status, await r.text()); return null; }
        const data = await r.json();
        const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
        const cleaned = text.replace(/```json|```/g, '').trim();
        return JSON.parse(cleaned);
    } catch (err) {
        console.error('[Gemini error]', err.message);
        return null;
    }
}

// ===========================================================================
// JOB ENGINE
// ===========================================================================

async function createJob(userId, type, engine, input, creditsEstimate) {
    const { data, error } = await supabase.from('jobs').insert([{
        user_id: userId, type, engine, input,
        credits_estimate: creditsEstimate || null,
        status: 'queued', progress: 0, log: []
    }]).select().single();
    if (error) throw error;
    return data;
}

async function updateJob(jobId, patch, logLine) {
    const body = { ...patch, updated_at: new Date().toISOString() };
    if (logLine) {
        const { data: cur } = await supabase.from('jobs').select('log').eq('id', jobId).maybeSingle();
        const log = Array.isArray(cur?.log) ? cur.log : [];
        log.push({ t: new Date().toISOString(), m: logLine });
        body.log = log.slice(-100);
    }
    await supabase.from('jobs').update(body).eq('id', jobId);
}

/** Fire-and-forget runner. Never awaited by the request handler. */
function runJob(jobId, worker) {
    (async () => {
        try {
            await updateJob(jobId, { status: 'running', progress: 1 }, 'Job started');
            const result = await worker(
                (progress, step) => updateJob(jobId, { progress, current_step: step }, step)
            );
            await updateJob(jobId, {
                status: 'done', progress: 100,
                result, result_report_id: result?.reportId || null,
                finished_at: new Date().toISOString()
            }, 'Job complete');
        } catch (err) {
            console.error('[Job failed]', jobId, err.message);
            await updateJob(jobId, {
                status: 'failed', error: err.message,
                finished_at: new Date().toISOString()
            }, 'Failed: ' + err.message);
        }
    })();
}

function estimateCredits(accounts, postsPerAccount) {
    const posts = accounts * postsPerAccount;
    return +(((posts / 1000) * COST_PER_1K_POSTS) + ((accounts / 1000) * COST_PER_1K_PROFILE)).toFixed(4);
}

// ===========================================================================
// SHARED: AUDIT ONE HANDLE
// ===========================================================================

async function auditHandle(client, userId, handle, postsLimit, meta = {}) {
    const h = String(handle || '').replace('@', '').replace(/\/+$/, '').trim().toLowerCase();
    if (!h) return null;

    const profileRun = await client.actor('apify/instagram-profile-scraper').call({ usernames: [h] });
    const { items: profiles } = await client.dataset(profileRun.defaultDatasetId).listItems();
    const prof = profiles[0] || {};

    const postRun = await client.actor('apify/instagram-scraper').call({
        directUrls: [`https://www.instagram.com/${h}/`],
        resultsType: 'posts',
        resultsLimit: Math.min(postsLimit || DEFAULT_POSTS_PER_ACC, MAX_POSTS_PER_ACC),
        addParentData: false
    });
    const { items: rawPosts } = await client.dataset(postRun.defaultDatasetId).listItems();
    const posts = extractPosts(rawPosts || []);

    await savePosts(userId, h, posts, meta);
    return computeAudit(h, prof, posts);
}

// ===========================================================================
// SYSTEM / KEY MANAGEMENT ENDPOINTS
// ===========================================================================

app.get('/api/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.get('/api/me', async (req, res) => {
    const ctx = await auth(req, res); if (!ctx) return;
    const { data: access } = await supabase.from('user_engine_access')
        .select('engine').eq('user_id', ctx.user.id);
    res.json({
        id: ctx.user.id,
        email: ctx.user.email,
        role: ctx.profile.role,
        engines: ctx.profile.role === 'admin' ? ENGINES : (access || []).map(a => a.engine)
    });
});

// Actor status — now authenticated (it leaks your Apify username otherwise)
app.get('/api/actor-status', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const engine = ENGINES.includes(req.query.engine) ? req.query.engine : 'leadgen';
        const { apifyUsername, candidate } = await getWorkingClient(engine, ctx.user.id);
        res.status(200).json({ active: true, username: apifyUsername, engine, source: candidate.source });
    } catch (err) {
        res.status(200).json({ active: false, error: 'Invalid/Expired Key' });
    }
});

// Primary per-engine key. Changeable at any time, never deletable.
app.post('/api/update-apify-key', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;

        const { newApiKey, engine } = req.body;
        if (!newApiKey) return res.status(400).json({ error: 'Key required' });
        const activeEngine = ENGINES.includes(engine) ? engine : 'leadgen';

        const apifyUser = await new ApifyClient({ token: newApiKey }).user().get();

        if (ctx.profile.role === 'admin') {
            // Admin updates the shared engine primary
            const { error: dbErr } = await supabase.from('system_settings').upsert({
                key: primaryKeyName(activeEngine),
                value: newApiKey,
                updated_at: new Date().toISOString()
            }, { onConflict: 'key' });
            if (dbErr) throw dbErr;
        } else {
            // Non-admins set their own personal key for that engine
            await supabase.from('apify_keys').upsert({
                owner_user_id: ctx.user.id,
                engine: activeEngine,
                token: newApiKey,
                label: 'personal',
                apify_username: apifyUser.username,
                status: 'active',
                fail_count: 0,
                last_checked_at: new Date().toISOString()
            }, { onConflict: 'token' });
        }

        res.status(200).json({
            success: true,
            message: 'Apify key verified and saved.',
            username: apifyUser.username,
            engine: activeEngine,
            scope: ctx.profile.role === 'admin' ? 'engine_primary' : 'personal'
        });
    } catch (err) {
        res.status(400).json({ error: 'Key verification failed: ' + err.message });
    }
});

// --- Key pool -------------------------------------------------------------

app.get('/api/apify-keys', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const isAdmin = ctx.profile.role === 'admin';

        let q = supabase.from('apify_keys')
            .select('id, owner_user_id, engine, label, apify_username, status, fail_count, last_used_at, created_at')
            .order('created_at', { ascending: false });

        if (!isAdmin) q = q.eq('owner_user_id', ctx.user.id);

        const { data, error } = await q;
        if (error) throw error;

        const primaries = {};
        for (const e of ENGINES) {
            const v = await getEnginePrimary(e);
            primaries[e] = v ? { configured: true, masked: v.slice(0, 10) + '...' } : { configured: false };
        }

        res.json({ keys: data, primaries });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/apify-keys', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const { token, engine, label, global: isGlobal } = req.body;
        if (!token) return res.status(400).json({ error: 'Token required' });

        const eng = ['leadgen', 'report', 'fb_community', 'any'].includes(engine) ? engine : 'any';
        const apifyUser = await new ApifyClient({ token }).user().get();
        const owner = (isGlobal && ctx.profile.role === 'admin') ? null : ctx.user.id;

        const { data, error } = await supabase.from('apify_keys').upsert({
            owner_user_id: owner,
            engine: eng,
            label: label || apifyUser.username,
            token,
            apify_username: apifyUser.username,
            status: 'active',
            fail_count: 0,
            last_checked_at: new Date().toISOString()
        }, { onConflict: 'token' }).select('id, engine, label, apify_username, status').single();

        if (error) throw error;
        res.json({ success: true, key: data });
    } catch (err) { res.status(400).json({ error: 'Key rejected: ' + err.message }); }
});

app.post('/api/apify-keys/:id/recheck', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        let q = supabase.from('apify_keys').select('*').eq('id', req.params.id);
        if (ctx.profile.role !== 'admin') q = q.eq('owner_user_id', ctx.user.id);
        const { data: key } = await q.maybeSingle();
        if (!key) return res.status(404).json({ error: 'Key not found' });

        try {
            const u = await new ApifyClient({ token: key.token }).user().get();
            await markKey(key.id, { status: 'active', fail_count: 0, apify_username: u.username, last_checked_at: new Date().toISOString() });
            res.json({ success: true, status: 'active', username: u.username });
        } catch (e) {
            await markKey(key.id, { status: 'invalid', last_checked_at: new Date().toISOString() });
            res.json({ success: false, status: 'invalid', error: e.message });
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/apify-keys/:id', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        let q = supabase.from('apify_keys').delete().eq('id', req.params.id);
        if (ctx.profile.role !== 'admin') q = q.eq('owner_user_id', ctx.user.id);
        const { error } = await q;
        if (error) throw error;
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===========================================================================
// ADMIN: USER MANAGEMENT
// ===========================================================================

app.get('/api/admin/users', async (req, res) => {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        const { data: users } = await supabase.from('app_users')
            .select('*').order('created_at', { ascending: false });
        const { data: access } = await supabase.from('user_engine_access').select('user_id, engine');

        const map = {};
        (access || []).forEach(a => { (map[a.user_id] = map[a.user_id] || []).push(a.engine); });

        res.json({ users: (users || []).map(u => ({ ...u, engines: map[u.id] || [] })) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/users', async (req, res) => {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        const { email, password, fullName, role, engines } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

        const { data: created, error: createErr } = await supabase.auth.admin.createUser({
            email, password, email_confirm: true
        });
        if (createErr) throw createErr;

        const newId = created.user.id;
        await supabase.from('app_users').upsert({
            id: newId,
            email: email.toLowerCase(),
            full_name: fullName || null,
            role: role === 'admin' ? 'admin' : 'user',
            is_active: true
        });

        for (const e of (engines || []).filter(x => ENGINES.includes(x))) {
            await supabase.from('user_engine_access')
                .upsert({ user_id: newId, engine: e, granted_by: ctx.user.id }, { onConflict: 'user_id,engine' });
        }

        res.json({ success: true, userId: newId });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

app.patch('/api/admin/users/:id', async (req, res) => {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        const { role, isActive, engines, password } = req.body;
        const target = req.params.id;

        const patch = { updated_at: new Date().toISOString() };
        if (role) patch.role = role === 'admin' ? 'admin' : 'user';
        if (typeof isActive === 'boolean') patch.is_active = isActive;
        await supabase.from('app_users').update(patch).eq('id', target);

        if (password) await supabase.auth.admin.updateUserById(target, { password });

        if (Array.isArray(engines)) {
            await supabase.from('user_engine_access').delete().eq('user_id', target);
            for (const e of engines.filter(x => ENGINES.includes(x))) {
                await supabase.from('user_engine_access')
                    .upsert({ user_id: target, engine: e, granted_by: ctx.user.id }, { onConflict: 'user_id,engine' });
            }
        }
        res.json({ success: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/admin/users/:id', async (req, res) => {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        if (req.params.id === ctx.user.id) return res.status(400).json({ error: 'You cannot delete yourself.' });
        await supabase.auth.admin.deleteUser(req.params.id);
        await supabase.from('app_users').delete().eq('id', req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

// ===========================================================================
// STAGE 1 :: DISCOVERY PIPELINE  (unchanged response shape)
// ===========================================================================

app.post('/api/run-campaign', async (req, res) => {
    let warnings = [];
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;
        const user = ctx.user;

        const {
            campaignName, location, method1_keywords = [], hashtags = [],
            method3_1_keywords = [], competitor_handles = [], method6_keywords = [],
            selected_methods = []
        } = req.body;

        const { client } = await getWorkingClient('leadgen', user.id);

        const { data: newCmp, error: cmpErr } = await supabase.from('campaigns').insert([{
            user_id: user.id,
            name: campaignName || 'Discovery Campaign',
            location,
            keywords: [...method1_keywords, ...method3_1_keywords],
            selected_methods
        }]).select().single();
        if (cmpErr) throw cmpErr;

        const activeCampaignId = newCmp.id;
        let rawDiscoveredPosts = [];

        const collect = (posts, filterKeywords) => {
            const lower = (filterKeywords || []).map(k => k.toLowerCase().trim());
            posts.forEach(i => {
                const handle = i.ownerUsername || i.owner?.username || i.username || i.user?.username;
                const caption = (i.caption || i.text || '').toLowerCase();
                if (!handle) return;
                if (lower.length && !lower.some(kw => caption.includes(kw))) return;
                rawDiscoveredPosts.push({
                    username: handle,
                    post_views: getViews(i),
                    post_likes: i.likesCount || 0,
                    post_comments: i.commentsCount || 0,
                    post_timestamp: tsOf(i)?.toISOString() || new Date().toISOString(),
                    post_url: i.url || `https://instagram.com/p/${shortcodeOf(i)}`
                });
            });
        };

        // METHOD 1 :: Location URL feed
        if (selected_methods.includes('method_1') && location) {
            const directUrls = location.split(',').map(c => c.trim())
                .filter(loc => loc.includes('instagram.com/explore/locations'));
            if (directUrls.length) {
                const posts = await runActor('apify/instagram-scraper',
                    { directUrls, resultsLimit: 1000, scrollWaitSecs: 5, pageTimeoutSecs: 60 },
                    warnings, 'Method 1 (Locations)', client);
                collect(posts, method1_keywords);
            } else {
                warnings.push('METHOD 1 SKIPPED: Location requires a direct Instagram explore URL.');
            }
        }

        // METHOD 3 :: Hashtag feed
        if (selected_methods.includes('method_3') && hashtags.length) {
            const directUrls = hashtags.map(h => h.replace('#', '').trim()).filter(Boolean)
                .map(tag => `https://www.instagram.com/explore/tags/${tag}/`);
            const posts = await runActor('apify/instagram-scraper',
                { directUrls, resultsLimit: 1000, scrollWaitSecs: 5, pageTimeoutSecs: 60 },
                warnings, 'Method 3 (Hashtags)', client);
            collect(posts);
        }

        // METHOD 3.1 :: Global phrase search
        if (selected_methods.includes('method_3_1') && method3_1_keywords.length) {
            for (const kw of method3_1_keywords) {
                const posts = await runActor('apify/instagram-api-scraper',
                    { query: kw, limit: 1000 }, warnings, `Method 3.1 (${kw})`, client);
                collect(posts);
            }
        }

        // METHOD 4 :: Competitor tagged feed
        if (selected_methods.includes('method_4') && competitor_handles.length) {
            const taggedUrls = competitor_handles.map(h => h.replace('@', '').trim()).filter(Boolean)
                .map(handle => `https://www.instagram.com/${handle}/tagged/`);
            const posts = await runActor('apify/instagram-scraper',
                { directUrls: taggedUrls, resultsLimit: 1000, scrollWaitSecs: 5, pageTimeoutSecs: 60 },
                warnings, 'Method 4 (Competitor Tagged)', client);
            collect(posts);
        }

        // METHOD 6 :: TopSearch B2B accounts
        if (selected_methods.includes('method_6') && method6_keywords.length) {
            for (const kw of method6_keywords) {
                try {
                    const run = await client.actor('apify/instagram-search-scraper')
                        .call({ searchQueries: [kw], searchType: 'user' });
                    const { items } = await client.dataset(run.defaultDatasetId).listItems();
                    (items || []).forEach(item => {
                        const handle = item.username || item.ownerUsername;
                        if (handle) rawDiscoveredPosts.push({
                            username: handle, post_views: 0, post_likes: 0, post_comments: 0,
                            post_timestamp: new Date().toISOString(),
                            post_url: `https://instagram.com/${handle}`
                        });
                    });
                    warnings.push(`X-RAY (Method 6): Found ${items?.length || 0} accounts for "${kw}".`);
                } catch (e) { warnings.push(`Error (Method 6): ${e.message}`); }
            }
        }

        // Dedupe, keeping the strongest post per handle
        const uniqueMap = new Map();
        rawDiscoveredPosts.forEach(post => {
            const u = post.username.toLowerCase().trim().replace('@', '');
            if (!uniqueMap.has(u) || post.post_views > uniqueMap.get(u).post_views) {
                uniqueMap.set(u, { ...post, username: u });
            }
        });

        let newLeadsSaved = 0;
        for (const post of Array.from(uniqueMap.values())) {
            let leadId = null;

            const { data: existing } = await supabase.from('leads')
                .select('id').eq('username', post.username).eq('owner_user_id', user.id).maybeSingle();

            if (existing) {
                leadId = existing.id;
            } else {
                const { data: newLead, error: insErr } = await supabase.from('leads').insert([{
                    owner_user_id: user.id,
                    username: post.username,
                    profile_url: `https://instagram.com/${post.username}`,
                    is_enriched: false
                }]).select('id').maybeSingle();
                if (insErr) { warnings.push(`DB Alert: Failed to save @${post.username}`); continue; }
                leadId = newLead?.id;
            }

            if (leadId) {
                const { error: linkErr } = await supabase.from('campaign_leads').insert([{
                    campaign_id: activeCampaignId,
                    lead_id: leadId,
                    user_id: user.id,
                    top_post_url: post.post_url,
                    top_post_views: post.post_views || 0,
                    post_likes: post.post_likes || 0,
                    post_comments: post.post_comments || 0,
                    post_timestamp: new Date(post.post_timestamp).toISOString()
                }]);
                if (!linkErr) newLeadsSaved++;
            }
        }

        await supabase.from('campaigns')
            .update({ total_leads_found: newLeadsSaved }).eq('id', activeCampaignId);

        res.status(200).json({ success: true, newUniqueLeads: newLeadsSaved, warnings });
    } catch (err) {
        res.status(500).json({ error: err.message, warnings });
    }
});

// ===========================================================================
// STAGE 2 :: ENRICHMENT
// ===========================================================================

app.post('/api/enrich-campaign', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;
        const user = ctx.user;

        const { campaignId, batchSize } = req.body;
        if (!campaignId) return res.status(400).json({ error: 'Campaign ID required' });

        const { data: linkData, error: linkErr } = await supabase.from('campaign_leads')
            .select('leads(id, username, is_enriched)').eq('campaign_id', campaignId);
        if (linkErr) throw linkErr;

        const handles = (linkData || []).map(d => d.leads)
            .filter(l => l && l.is_enriched !== true)
            .map(l => l.username)
            .slice(0, Math.min(parseInt(batchSize || 25, 10), 100));

        if (!handles.length)
            return res.status(200).json({ success: true, message: 'All leads enriched!', enrichedCount: 0 });

        const { client } = await getWorkingClient('leadgen', user.id);
        const run = await client.actor('apify/instagram-profile-scraper')
            .call({ usernames: handles }, { waitSecs: 25 });
        const { items: profiles } = await client.dataset(run.defaultDatasetId).listItems();

        let updated = 0;
        for (const p of (profiles || [])) {
            const username = (p.username || p.ownerUsername || '').toLowerCase().trim();
            if (!username) continue;

            const { error: updErr } = await supabase.from('leads').update({
                full_name: p.fullName || p.full_name || p.name || null,
                email: p.businessEmail || p.biographyEmail || p.email || p.inputEmail || null,
                phone: p.businessPhoneNumber || p.phone || p.phoneNumber || null,
                followers_count: p.followersCount ?? p.followers ?? 0,
                following_count: p.followsCount ?? null,
                posts_count: p.postsCount ?? null,
                bio: p.biography || null,
                website: p.externalUrl || null,
                category: p.businessCategoryName || null,
                is_business: !!p.isBusinessAccount,
                is_verified: !!p.verified,
                city: p.city || p.cityName || null,
                address: p.addressStreet || null,
                is_enriched: true
            }).eq('username', username).eq('owner_user_id', user.id);

            if (!updErr) updated++;
        }

        res.status(200).json({ success: true, enrichedCount: updated });
    } catch (err) {
        console.error('[Enrich Error]:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ===========================================================================
// VAULT / HISTORY
// ===========================================================================

app.get('/api/client-history', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;
        const { data: campaigns } = await supabase.from('campaigns')
            .select('*, campaign_leads(top_post_views, post_likes, post_comments, post_timestamp, top_post_url, leads(*))')
            .eq('user_id', ctx.user.id)
            .order('created_at', { ascending: false });
        res.status(200).json({ campaigns });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/search-leads', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;
        const query = req.query.q ? req.query.q.toLowerCase().trim().replace('@', '') : '';
        if (!query) return res.status(400).json({ error: 'Query required' });

        const { data: leads, error } = await supabase.from('leads')
            .select('*, campaign_leads(top_post_views, post_likes, post_comments, post_timestamp, top_post_url, campaigns(name))')
            .eq('owner_user_id', ctx.user.id)
            .or(`username.ilike.%${query}%,full_name.ilike.%${query}%,email.ilike.%${query}%`)
            .limit(50);

        if (error) throw error;
        res.status(200).json({ leads });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/campaign/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;
        const { error } = await supabase.from('campaigns')
            .delete().eq('id', req.params.id).eq('user_id', ctx.user.id);
        if (error) throw error;
        res.status(200).json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===========================================================================
// REPORT ENGINE :: LEGACY ENDPOINT (existing ig-report.html keeps working)
// ===========================================================================

app.post('/api/generate-ig-report', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'report'); if (!ctx) return;
        const { target, compareRivals, rival1, rival2, postsLimit } = req.body;

        const cleanTarget = String(target || '').replace('@', '').replace(/\/+$/, '').trim().toLowerCase();
        if (!cleanTarget) return res.status(400).json({ success: false, error: 'Target handle required' });

        const rivals = compareRivals
            ? [...new Set([rival1, rival2]
                .map(h => String(h || '').replace('@', '').replace(/\/+$/, '').trim().toLowerCase())
                .filter(Boolean)
                .filter(h => h !== cleanTarget))]
            : [];

        const limit = Math.min(parseInt(postsLimit || DEFAULT_POSTS_PER_ACC, 10), MAX_POSTS_PER_ACC);
        const accounts = rivals.length + 1;
        const estimate = estimateCredits(accounts, limit);

        // NOTE: intentionally does NOT create a competitor_sets row and does NOT
        // tag posts with a set_id. Saved, re-runnable cohorts and trend tracking
        // stay exclusive to /api/deep-audit (Competitor Intel).
        const job = await createJob(ctx.user.id, 'ig_report', 'report',
            { target: cleanTarget, rivals, postsPerAccount: limit }, estimate);

        runJob(job.id, async (progress) => {
            const { client } = await getWorkingClient('report', ctx.user.id);
            const step = Math.floor(80 / accounts);

            await progress(5, `Auditing target @${cleanTarget}`);
            const main = await auditHandle(client, ctx.user.id, cleanTarget, limit);
            if (!main) throw new Error('Target profile could not be scraped.');

            const rivalAudits = [];
            for (let i = 0; i < rivals.length; i++) {
                await progress(5 + step * (i + 1), `Auditing rival @${rivals[i]} (${i + 1}/${rivals.length})`);
                try {
                    const a = await auditHandle(client, ctx.user.id, rivals[i], limit);
                    if (a) rivalAudits.push(a);
                } catch (e) {
                    console.error('[rival failed]', rivals[i], e.message);
                }
            }

            await progress(88, 'Building benchmark');
            const benchmark = rivalAudits.length ? buildBenchmark(main, rivalAudits) : null;
            const recommendations = ruleRecommendations(main);

            await progress(92, 'Generating AI narrative');
            const ai = await geminiNarrative({ target: main, rivals: rivalAudits, benchmark });

            const payload = { main, rivals: rivalAudits, recommendations, benchmark, ai };
            const postsAnalyzed = main.postsAnalyzed + rivalAudits.reduce((s, r) => s + r.postsAnalyzed, 0);

            await progress(96, 'Saving report');
            const { data: saved } = await supabase.from('reports').insert([{
                user_id: ctx.user.id,
                platform: 'instagram',
                report_type: rivalAudits.length ? 'compare' : 'single',
                target_handle: main.handle,
                competitor_handles: rivalAudits.map(r => r.handle),
                grade: main.grade,
                score: main.score,
                engagement_rate: parseFloat(main.engagementRate),
                posts_analyzed: postsAnalyzed,
                snapshot_date: new Date().toISOString().slice(0, 10),
                credits_estimate: estimate,
                ai_summary: ai?.executive_summary || null,
                ai_json: ai || null,
                report_json: payload
            }]).select('id').maybeSingle();

            return { reportId: saved?.id || null, postsAnalyzed, report: payload };
        });

        res.status(202).json({
            success: true,
            jobId: job.id,
            accounts,
            postsPerAccount: limit,
            estimatedUsd: estimate
        });
    } catch (err) {
        console.error('[IG Report Error]:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ===========================================================================
// REPORT ENGINE :: DEEP AUDIT + COMPETITOR BENCHMARK (async job)
// ===========================================================================

app.get('/api/estimate-credits', async (req, res) => {
    const ctx = await auth(req, res); if (!ctx) return;
    const accounts = Math.min(parseInt(req.query.accounts || '1', 10), MAX_COMPETITORS + 1);
    const posts = Math.min(parseInt(req.query.posts || DEFAULT_POSTS_PER_ACC, 10), MAX_POSTS_PER_ACC);
    res.json({
        accounts, postsPerAccount: posts,
        totalPosts: accounts * posts,
        estimatedUsd: estimateCredits(accounts, posts),
        note: 'Estimate only. Actual Apify billing depends on the actor and result count.'
    });
});

app.post('/api/deep-audit', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'report'); if (!ctx) return;

        const {
            target,
            competitors = [],
            postsPerAccount,
            setName,
            setId
        } = req.body;

        const cleanTarget = String(target || '').replace('@', '').trim().toLowerCase();
        if (!cleanTarget) return res.status(400).json({ error: 'Target handle required' });

        const rivals = [...new Set(
            (competitors || [])
                .map(h => String(h || '').replace('@', '').trim().toLowerCase())
                .filter(Boolean)
                .filter(h => h !== cleanTarget)
        )].slice(0, MAX_COMPETITORS);

        const limit = Math.min(parseInt(postsPerAccount || DEFAULT_POSTS_PER_ACC, 10), MAX_POSTS_PER_ACC);
        const accounts = rivals.length + 1;
        const estimate = estimateCredits(accounts, limit);

        // Reusable benchmark group so the same cohort can be re-run later
        let activeSetId = setId || null;
        if (!activeSetId) {
            const { data: set } = await supabase.from('competitor_sets').insert([{
                user_id: ctx.user.id,
                name: setName || `${cleanTarget} vs ${rivals.length} rivals`,
                target_handle: cleanTarget,
                competitor_handles: rivals,
                posts_per_account: limit
            }]).select('id').maybeSingle();
            activeSetId = set?.id || null;
        }

        const job = await createJob(ctx.user.id, 'deep_audit', 'report',
            { target: cleanTarget, competitors: rivals, postsPerAccount: limit, setId: activeSetId },
            estimate
        );

        runJob(job.id, async (progress) => {
            const { client } = await getWorkingClient('report', ctx.user.id);
            const meta = { setId: activeSetId };
            const step = Math.floor(80 / accounts);

            await progress(5, `Auditing target @${cleanTarget}`);
            const main = await auditHandle(client, ctx.user.id, cleanTarget, limit, meta);
            if (!main) throw new Error('Target profile could not be scraped.');

            const rivalAudits = [];
            for (let i = 0; i < rivals.length; i++) {
                await progress(5 + step * (i + 1), `Auditing competitor @${rivals[i]} (${i + 1}/${rivals.length})`);
                try {
                    const a = await auditHandle(client, ctx.user.id, rivals[i], limit, meta);
                    if (a) rivalAudits.push(a);
                } catch (e) {
                    console.error('[competitor failed]', rivals[i], e.message);
                }
            }

            await progress(88, 'Building benchmark');
            const benchmark = buildBenchmark(main, rivalAudits);
            const recommendations = ruleRecommendations(main);

            await progress(92, 'Generating AI strategy');
            const ai = await geminiNarrative({ target: main, rivals: rivalAudits, benchmark });

            const payload = { main, rivals: rivalAudits, benchmark, recommendations, ai };
            const postsAnalyzed = main.postsAnalyzed + rivalAudits.reduce((s, r) => s + r.postsAnalyzed, 0);

            await progress(96, 'Saving report');
            const { data: saved } = await supabase.from('reports').insert([{
                user_id: ctx.user.id,
                platform: 'instagram',
                report_type: rivalAudits.length ? 'competitor' : 'single',
                set_id: activeSetId,
                target_handle: main.handle,
                competitor_handles: rivalAudits.map(r => r.handle),
                grade: main.grade,
                score: main.score,
                engagement_rate: parseFloat(main.engagementRate),
                posts_analyzed: postsAnalyzed,
                snapshot_date: new Date().toISOString().slice(0, 10),
                credits_estimate: estimate,
                ai_summary: ai?.executive_summary || null,
                ai_json: ai || null,
                report_json: payload
            }]).select('id').maybeSingle();

            if (activeSetId) {
                await supabase.from('competitor_sets')
                    .update({ last_run_at: new Date().toISOString() }).eq('id', activeSetId);
            }

            return { reportId: saved?.id || null, setId: activeSetId, postsAnalyzed, report: payload };
        });

        res.status(202).json({
            success: true,
            jobId: job.id,
            setId: activeSetId,
            accounts,
            postsPerAccount: limit,
            estimatedUsd: estimate
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ===========================================================================
// JOBS
// ===========================================================================

app.get('/api/job/:id', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const { data, error } = await supabase.from('jobs')
            .select('*').eq('id', req.params.id).eq('user_id', ctx.user.id).maybeSingle();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Job not found' });
        res.json({ job: data });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/jobs', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const { data } = await supabase.from('jobs')
            .select('id, type, engine, status, progress, current_step, error, credits_estimate, created_at, finished_at')
            .eq('user_id', ctx.user.id)
            .order('created_at', { ascending: false })
            .limit(30);
        res.json({ jobs: data || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===========================================================================
// REPORTS VAULT + TREND COMPARISON
// ===========================================================================

app.get('/api/reports-history', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'report'); if (!ctx) return;
        const { data: reports, error } = await supabase.from('reports')
            .select('*').eq('user_id', ctx.user.id).order('created_at', { ascending: false });
        if (error) throw error;
        res.status(200).json({ reports });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/report/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'report'); if (!ctx) return;
        const { data } = await supabase.from('reports')
            .select('*').eq('id', req.params.id).eq('user_id', ctx.user.id).maybeSingle();
        if (!data) return res.status(404).json({ error: 'Report not found' });
        res.json({ report: data });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/competitor-sets', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'report'); if (!ctx) return;
        const { data } = await supabase.from('competitor_sets')
            .select('*').eq('user_id', ctx.user.id).order('created_at', { ascending: false });
        res.json({ sets: data || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * Trend comparison across snapshots of the same competitor set.
 * Every point carries its snapshot date so the UI can label the delta window.
 */
app.get('/api/set-trend/:setId', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'report'); if (!ctx) return;

        const { data: runs } = await supabase.from('reports')
            .select('id, snapshot_date, created_at, score, grade, engagement_rate, target_handle, report_json')
            .eq('set_id', req.params.setId).eq('user_id', ctx.user.id)
            .order('created_at', { ascending: true });

        if (!runs || !runs.length) return res.json({ runs: [], delta: null });

        const points = runs.map(r => ({
            reportId: r.id,
            date: r.snapshot_date || r.created_at?.slice(0, 10),
            score: r.score,
            grade: r.grade,
            engagementRate: r.engagement_rate,
            postsPerWeek: r.report_json?.main?.postsPerWeek || null,
            followers: r.report_json?.main?.followers || null,
            cohortAvgEngagement: r.report_json?.benchmark?.cohort?.avgEngagementRate || null,
            rank: r.report_json?.benchmark?.targetRank || null
        }));

        let delta = null;
        if (points.length > 1) {
            const a = points[points.length - 2], b = points[points.length - 1];
            const days = Math.round((new Date(b.date) - new Date(a.date)) / 86400000);
            delta = {
                from: a.date, to: b.date, days,
                score: (b.score || 0) - (a.score || 0),
                engagementRate: +((b.engagementRate || 0) - (a.engagementRate || 0)).toFixed(2),
                followers: (b.followers || 0) - (a.followers || 0),
                rankChange: (a.rank && b.rank) ? a.rank - b.rank : null
            };
        }

        res.json({ runs: points, delta });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/** Raw stored posts for a handle — powers post-level UI tables. */
app.get('/api/posts', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'report'); if (!ctx) return;
        const handle = String(req.query.handle || '').replace('@', '').toLowerCase().trim();
        if (!handle) return res.status(400).json({ error: 'handle required' });

        const { data } = await supabase.from('posts')
            .select('shortcode, post_url, post_type, caption, hashtags, likes, comments, views, posted_at, thumbnail_url')
            .eq('user_id', ctx.user.id).eq('handle', handle)
            .order('posted_at', { ascending: false })
            .limit(Math.min(parseInt(req.query.limit || '100', 10), 500));

        res.json({ handle, posts: data || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===========================================================================
// ===========================================================================
//  FACEBOOK COMMUNITY ENGINE
//  Engine key: 'fb_community'.  Job types: 'fb_discovery' | 'fb_community_audit'
//  | 'fb_verify'.  Reuses jobs, reports, /api/job/:id polling and the Apify
//  key pool verbatim — no parallel infrastructure.
// ===========================================================================
// ===========================================================================

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// IDENTITY HANDLING
// Facebook group members have a far stronger privacy expectation than public
// Instagram business accounts, and several target regions treat storing names
// without a lawful basis as a real problem. We keep the content and hash the
// person. To act on a lead the user clicks through to the live post.
// ---------------------------------------------------------------------------
const FB_HASH_SALT = process.env.FB_HASH_SALT || 'edgelead-fb-default-salt-change-me';

function authorHash(name, groupId) {
    const raw = String(name || 'anonymous').trim().toLowerCase() + '::' + String(groupId || '');
    return crypto.createHmac('sha256', FB_HASH_SALT).update(raw).digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// URL / ID PARSING
// ---------------------------------------------------------------------------
function parseGroupRef(input) {
    const s = String(input || '').trim();
    if (!s) return null;
    const m = s.match(/facebook\.com\/groups\/([^/?#\s]+)/i);
    const id = m ? m[1] : s.replace(/^@/, '').replace(/\/+$/, '');
    if (!id || /\s/.test(id)) return null;
    return { groupId: id, url: `https://www.facebook.com/groups/${id}/` };
}

function fbPostId(p) {
    return String(
        p.postId || p.post_id || p.id || p.legacyId ||
        (p.url || p.postUrl || p.topLevelUrl || '').match(/(?:posts|permalink|multi_permalink)\/(\d+)/)?.[1] ||
        (p.url || '').split('?')[0].replace(/\/+$/, '').split('/').pop() || ''
    ).trim();
}

function fbPostUrl(p, groupId) {
    return p.url || p.postUrl || p.topLevelUrl ||
        (fbPostId(p) ? `https://www.facebook.com/groups/${groupId}/posts/${fbPostId(p)}/` : null);
}

function fbText(p) {
    return String(p.text || p.message || p.content || p.postText || p.caption || '').trim();
}

function fbTimestamp(p) {
    const raw = p.time || p.timestamp || p.date || p.publishedAt || p.postedAt || p.createdAt || null;
    if (!raw) return null;
    const d = typeof raw === 'number'
        ? new Date(raw * (raw > 1e12 ? 1 : 1000))
        : new Date(raw);
    return isNaN(d.getTime()) ? null : d;
}

function firstNum(...vals) {
    for (const v of vals) {
        if (v === null || v === undefined) continue;
        const n = typeof v === 'string' ? parseInt(v.replace(/[^\d]/g, ''), 10) : Number(v);
        if (!isNaN(n)) return n;
    }
    return 0;
}

function fbReactions(p) {
    const b = p.reactions || p.reactionsCount || p.reactionCount || {};
    if (typeof b === 'object' && !Array.isArray(b)) {
        const sum = Object.values(b).reduce((s, v) => s + (Number(v) || 0), 0);
        if (sum > 0) return { total: sum, breakdown: b };
    }
    const total = firstNum(p.likesCount, p.likes, p.reactionsCount, p.reactionCount, b);
    const breakdown = p.reactionsBreakdown || p.reactionsByType || null;
    return { total, breakdown: breakdown || null };
}

function fbMediaType(p) {
    const attach = p.attachments || p.media || [];
    const arr = Array.isArray(attach) ? attach : [attach];
    const link = p.link || p.linkUrl || p.externalUrl ||
        arr.find(a => a && (a.url || a.link) && /^https?:/.test(a.url || a.link))?.url;

    if (p.poll || p.pollOptions || /\bpoll\b/i.test(p.type || '')) return { type: 'poll', link: null };
    if (p.videoUrl || p.video || /video/i.test(p.type || '') || arr.some(a => a && /video/i.test(a.type || ''))) {
        return { type: 'video', link: link || null };
    }
    const imgs = arr.filter(a => a && (/photo|image/i.test(a.type || '') || a.image || a.thumbnail || a.photo));
    if (imgs.length > 1 || (Array.isArray(p.images) && p.images.length > 1)) return { type: 'album', link: link || null };
    if (imgs.length === 1 || p.imageUrl || p.thumbnailUrl || (Array.isArray(p.images) && p.images.length === 1)) {
        return { type: 'photo', link: link || null };
    }
    if (link && !/facebook\.com/i.test(link)) return { type: 'link', link };
    return { type: 'text', link: null };
}

function domainOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

// Local-time bucketing. Facebook returns UTC; local groups behave on local clocks.
function localParts(date, offsetMins = FB_TZ_OFFSET_MINS) {
    if (!date) return { hour: null, dow: null };
    const shifted = new Date(date.getTime() + offsetMins * 60000);
    return { hour: shifted.getUTCHours(), dow: shifted.getUTCDay() };
}

// ---------------------------------------------------------------------------
// INTENT CLASSIFICATION
// Ordered by specificity. First rule that matches wins, so put the
// commercially interesting intents above the generic ones.
// English + Bangla, because the first target markets are bilingual.
// ---------------------------------------------------------------------------
const FB_INTENT_RULES = [
    {
        intent: 'recommendation_request',
        re: [
            /\b(anyone know|any ?one knows?|does anybody|does anyone|can anyone (recommend|suggest)|looking for|in search of|need (a|an|some|someone|help)|where can i (find|get|buy)|who does|any good|recommend(ations?)?|suggest (me|a|any|some)|referrals?)\b/i,
            /(কেউ কি জানেন|কেউ জানেন|খুঁজছি|খুজছি|দরকার|প্রয়োজন|কোথায় পাবো|কোথায় পাব|সাজেস্ট|রেফার|ভালো কোন)/
        ]
    },
    {
        intent: 'hiring',
        re: [/\b(hiring|we are hiring|job (opening|vacancy|post)|vacancy|apply now|cv (to|at)|recruit(ing|ment)|freelancer needed|developer needed)\b/i,
             /(নিয়োগ|চাকরি|লোক নিব|কর্মী নিয়োগ)/]
    },
    {
        intent: 'buy_sell',
        re: [/\b(for sale|selling|sell my|price is|negotiable|brand new|used|fixed price|cod\b|delivery charge|only serious buyer|urgent sale)\b/i,
             /(বিক্রি|বিক্রয়|দাম|মূল্য|নিতে চাইলে)/]
    },
    {
        intent: 'offer',
        re: [/\b(we offer|our service|our shop|contact us|dm me|inbox (me|please)|book now|order now|call now|whatsapp|discount|special offer|limited time|free delivery|visit our)\b/i,
             /(আমাদের|অর্ডার করুন|ইনবক্স|যোগাযোগ|ডিসকাউন্ট|অফার)/]
    },
    {
        intent: 'event',
        re: [/\b(event|meetup|workshop|seminar|webinar|rsvp|join us (on|this)|happening (on|this)|save the date|registration (open|link))\b/i,
             /(ইভেন্ট|আয়োজন|অনুষ্ঠান|রেজিস্ট্রেশন)/]
    },
    {
        intent: 'complaint',
        re: [/\b(worst|scam|scammer|fraud|beware|warning|cheated|ripped off|terrible service|never (go|buy|order)|do not (buy|trust)|avoid this)\b/i,
             /(প্রতারক|প্রতারণা|ঠকাইছে|সাবধান|খারাপ অভিজ্ঞতা)/]
    },
    {
        intent: 'question',
        re: [/\?\s*$/, /^(how|what|where|when|why|which|who|is there|are there|can i|should i|do you|has anyone|anybody)\b/i,
             /(কি|কেন|কিভাবে|কীভাবে)\s*\?/]
    },
    {
        intent: 'story',
        re: [/\b(i (just|finally|recently)|today i|so happy|update:|thank you (all|everyone)|grateful|my experience)\b/i,
             /(ধন্যবাদ|আজকে|অভিজ্ঞতা)/]
    }
];

function classifyIntent(text) {
    const t = String(text || '');
    if (!t) return 'unknown';
    for (const rule of FB_INTENT_RULES) {
        if (rule.re.some(r => r.test(t))) return rule.intent;
    }
    return 'discussion';
}

// ---------------------------------------------------------------------------
// DEMAND MINING
// This is the lead feed. Every match is a person in a specific room saying
// out loud that they want to buy something. Instagram cannot produce this.
// ---------------------------------------------------------------------------
const FB_DEMAND_PATTERNS = [
    { phrase: 'looking for',        re: /\blooking for\b/i,                                weight: 10 },
    { phrase: 'does anyone know',   re: /\b(does |do )?any ?(one|body) (know|have|recommend)\b/i, weight: 10 },
    { phrase: 'can anyone recommend', re: /\bcan any ?(one|body) (recommend|suggest)\b/i,  weight: 10 },
    { phrase: 'recommend a',        re: /\brecommend(ation)?s? (a|an|any|for|me)\b/i,      weight: 9  },
    { phrase: 'need someone who',   re: /\bneed (someone|somebody|a person|a guy|help) (who|that|to|for)?\b/i, weight: 10 },
    { phrase: 'need a',             re: /\bneed (a|an|some)\b/i,                           weight: 7  },
    { phrase: 'where can i get',    re: /\bwhere can i (get|find|buy|order)\b/i,            weight: 9  },
    { phrase: 'suggest me',         re: /\bsuggest (me|a|any|some|good)\b/i,                weight: 8  },
    { phrase: 'any good',           re: /\bany good\b/i,                                   weight: 7  },
    { phrase: 'in search of',       re: /\bin search of\b/i,                               weight: 9  },
    { phrase: 'who can help',       re: /\bwho can (help|do|fix|make|build)\b/i,            weight: 9  },
    { phrase: 'best place for',     re: /\bbest (place|shop|service|option) (for|to|in)\b/i, weight: 8 },
    { phrase: 'is available',       re: /\bis (there )?any(one|body|thing)? available\b/i,  weight: 6  },
    { phrase: 'hiring',             re: /\b(hiring|urgently need|freelancer needed|needed urgently)\b/i, weight: 9 },
    { phrase: 'খুঁজছি',              re: /(খুঁজছি|খুজছি|খুঁজতেছি)/,                            weight: 10 },
    { phrase: 'দরকার',               re: /(দরকার|প্রয়োজন|লাগবে)/,                             weight: 9  },
    { phrase: 'কেউ কি জানেন',        re: /(কেউ (কি )?জানেন|কেউ (কি )?আছেন)/,                  weight: 10 },
    { phrase: 'কোথায় পাবো',          re: /(কোথায় পাবো|কোথায় পাব|কোথায় পাওয়া যাবে)/,          weight: 9  },
    { phrase: 'সাজেস্ট করুন',         re: /(সাজেস্ট|রেফার) ?(করুন|করবেন|দিন)?/,                 weight: 8  }
];

const FB_CATEGORY_MAP = [
    ['home_services', /\b(plumb\w*|electric\w*|carpenter|painter|mason|ac (repair|servicing)|appliance|cleaning service|pest control|mistri|renovat\w*|interior)\b|(মিস্ত্রি|রঙ|প্লাম্বার|ইলেকট্রিশিয়ান)/i],
    ['auto',          /\b(car|bike|motorcycle|mechanic|garage|tyre|tire|servicing|driver|rent a car|cng)\b|(গাড়ি|বাইক|ড্রাইভার)/i],
    ['real_estate',   /\b(flat|apartment|house for rent|to ?let|sublet|land|plot|rent(al)?|room available|hostel|mess)\b|(বাসা|ফ্ল্যাট|ভাড়া|জমি)/i],
    ['food',          /\b(restaurant|cafe|catering|cake|biryani|iftar|homemade|tiffin|bakery|food delivery)\b|(খাবার|রেস্টুরেন্ট|কেক|বিরিয়ানি)/i],
    ['health',        /\b(doctor|clinic|hospital|dentist|physio|therapist|medicine|pharmacy|diagnostic|nurse|caregiver)\b|(ডাক্তার|হাসপাতাল|ঔষধ)/i],
    ['education',     /\b(tutor|coaching|admission|ielts|course|training|teacher|batch|home tuition)\b|(টিউটর|কোচিং|ভর্তি)/i],
    ['tech',          /\b(website|web ?dev|app develop\w*|software|laptop|pc build|it support|hosting|domain|seo|graphic design\w*|logo)\b|(ওয়েবসাইট|সফটওয়্যার|ল্যাপটপ)/i],
    ['beauty',        /\b(salon|parlour|parlor|makeup|bridal|haircut|spa|skincare)\b|(পার্লার|মেকআপ)/i],
    ['events',        /\b(photographer|videographer|decorator|event manage\w*|wedding|birthday party|sound system|stage)\b|(ফটোগ্রাফার|ডেকোরেশন|বিয়ে)/i],
    ['legal_finance', /\b(lawyer|advocate|accountant|tax|audit|insurance|loan|notary|trade licen[cs]e)\b|(উকিল|আইনজীবী|ট্যাক্স)/i],
    ['logistics',     /\b(courier|delivery|shifting|movers|truck|transport|shipping)\b|(কুরিয়ার|ট্রাক|শিফটিং)/i],
    ['jobs',          /\b(job|vacancy|hiring|cv|resume|intern|part ?time|full ?time)\b|(চাকরি|নিয়োগ)/i]
];

function categorize(text) {
    for (const [cat, re] of FB_CATEGORY_MAP) if (re.test(text)) return cat;
    return 'other';
}

const FB_URGENT_HIGH = /\b(urgent(ly)?|asap|immediately|emergency|today|tonight|tomorrow|right now|within (a|an|24|48))\b|(জরুরি|জরুরী|আজকে|এখনই|কালকের মধ্যে)/i;
const FB_URGENT_MED  = /\b(this week|by (friday|saturday|sunday|monday)|soon|next week|within a week)\b|(এই সপ্তাহে|শীঘ্রই)/i;

function urgencyOf(text) {
    if (FB_URGENT_HIGH.test(text)) return 'high';
    if (FB_URGENT_MED.test(text))  return 'medium';
    return 'low';
}

/**
 * Pulls buying intent out of one post. Returns [] for most posts, which is
 * correct — a room where every post is a demand signal is a room of spam.
 */
function mineDemand(text, ctx = {}) {
    const t = String(text || '');
    if (t.length < 12) return [];

    const hits = FB_DEMAND_PATTERNS.filter(p => p.re.test(t));
    if (!hits.length) return [];

    // One signal per post, built from the strongest phrase. Multiple rows for
    // the same post would inflate the feed and double-count the same lead.
    const best = hits.sort((a, b) => b.weight - a.weight)[0];
    const urgency = urgencyOf(t);
    const category = categorize(t);
    const engagement = ctx.engagement || 0;

    const urgencyBoost = urgency === 'high' ? 25 : urgency === 'medium' ? 12 : 0;
    const specificity  = Math.min(15, Math.floor(t.length / 40));
    const heat         = Math.min(20, Math.round(engagement / 3));
    const categoryBoost = category === 'other' ? 0 : 10;
    const recency = ctx.postedAt
        ? Math.max(0, 20 - Math.floor((Date.now() - new Date(ctx.postedAt).getTime()) / 86400000))
        : 0;

    const score = Math.min(100,
        best.weight * 2 + urgencyBoost + specificity + heat + categoryBoost + recency);

    return [{
        matched_phrase: best.phrase,
        snippet: t.slice(0, 600),
        intent: hits.some(h => /hiring/.test(h.phrase)) ? 'hiring' : 'recommendation_request',
        category,
        urgency,
        lead_score: score
    }];
}

// ---------------------------------------------------------------------------
// POST SHAPE ANALYSIS
// ---------------------------------------------------------------------------
function lengthBand(words) {
    if (words < 40)  return 'short (<40w)';
    if (words < 120) return 'medium (40-120w)';
    return 'long (120w+)';
}

function openingPattern(text) {
    const t = String(text || '').trim();
    if (!t) return 'empty';
    const first = t.split(/[\n.!?]/)[0].trim();
    if (/^[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u.test(first)) return 'emoji';
    if (/^(who|what|where|when|why|how|which|is|are|can|does|do|any|has)\b/i.test(first)) return 'question';
    if (/\?$/.test(first)) return 'question';
    if (/^\d/.test(first)) return 'number';
    if (/^[A-Z\u0980-\u09FF][\w\u0980-\u09FF' ]{2,24},/.test(first)) return 'location/name';
    if (/^(hi|hello|hey|assalamu|salam|dear|friends|guys|everyone)\b/i.test(first)) return 'greeting';
    if (first.length < 45 && !/\s/.test(first.slice(-1))) return 'short hook';
    return 'statement';
}

const FB_STOPWORDS = new Set(('a an the and or but if of to in on for with at by from is are was were be been am i you he she it we they my your our their this that these those not no yes do does did have has had will would can could should there here what when where who whom which how why all any some more most other so than too very just about also as into over after before out up down off again once now new please thank thanks help need want get got make made take like know good best hi hello hey dm inbox').split(' '));

function topicTags(text, limit = 6) {
    const words = String(text || '').toLowerCase()
        .replace(/https?:\/\/\S+/g, ' ')
        .match(/[\p{L}][\p{L}\p{N}'-]{2,}/gu) || [];
    const freq = {};
    words.forEach(w => { if (!FB_STOPWORDS.has(w) && w.length > 3) freq[w] = (freq[w] || 0) + 1; });
    return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, limit).map(e => e[0]);
}

// ---------------------------------------------------------------------------
// ROOM VALUE
// A 200k-member group with 4 posts a day is dead. A 6k-member group with 40
// posts a day is where business happens. Member count is a tiebreaker here,
// never a driver.
// ---------------------------------------------------------------------------
function median(nums) {
    const a = nums.filter(n => typeof n === 'number' && !isNaN(n)).sort((x, y) => x - y);
    if (!a.length) return 0;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function computeRoomValue(stats) {
    const {
        postsPerDay = 0, medianComments = 0, uniquePosterRatio = 0,
        promoAllowed = true, approvalRequired = false, memberCount = 0,
        demandRate = 0
    } = stats;

    const sampleSize = stats.sampleSize || 0;

    const liveness  = Math.min(1, postsPerDay / 15);       // 15+/day saturates
    const conversation = Math.min(1, medianComments / 10); // 10+ median comments saturates
    const diversity = Math.max(0, Math.min(1, uniquePosterRatio));
    const demand    = Math.min(1, demandRate * 5);         // 20% of posts asking = saturated

    // Posting permission discounts the value of POSTING into the room. It does
    // not discount the demand feed: a group that bans ads still tells you who
    // wants to buy, and answering a request in-thread is allowed everywhere.
    let permission = promoAllowed ? 1 : 0.75;
    if (approvalRequired) permission *= 0.75;

    const postingValue = (0.28 * liveness) + (0.30 * conversation) + (0.22 * diversity);
    const demandValue  = 0.20 * demand;

    // Confidence damping. Twelve posts is not enough to call a room, and a
    // thin sample scoring 58 next to a thick sample scoring 28 is a lie.
    const confidence = sampleSize === 0 ? 1 : Math.min(1, 0.55 + (sampleSize / 40) * 0.45);

    const sizeTiebreak = memberCount > 0 ? Math.min(5, Math.log10(memberCount)) : 0;
    const raw = (postingValue * permission + demandValue) * 100 * confidence + sizeTiebreak;
    const score = Math.round(Math.min(100, raw));

    return {
        score,
        breakdown: {
            liveness: +liveness.toFixed(2),
            conversation: +conversation.toFixed(2),
            diversity: +diversity.toFixed(2),
            demand: +demand.toFixed(2),
            permission: +permission.toFixed(2),
            confidence: +confidence.toFixed(2),
            sampleSize,
            sizeTiebreak: +sizeTiebreak.toFixed(2),
            lowConfidence: sampleSize > 0 && sampleSize < 15,
            verdict: (sampleSize > 0 && sampleSize < 15)
                   ? `Not enough data (${sampleSize} posts) — treat as provisional`
                   : score >= 70 ? 'Prime room'
                   : score >= 50 ? 'Worth working'
                   : score >= 30 ? 'Marginal'
                   : 'Dead room — skip it'
        }
    };
}

// ---------------------------------------------------------------------------
// RULES PARSING — the compliance gate depends on this being right
// ---------------------------------------------------------------------------
const FB_PROMO_BAN = /\b(no (promo\w*|advertis\w*|selling|sales|business posts?|spam|self ?promo\w*)|promo\w* (is )?not allowed|advertis\w* (is )?(not allowed|prohibited|banned)|do not (advertise|promote|sell)|strictly no (ads|selling|promo\w*))\b|(প্রচার নিষেধ|বিজ্ঞাপন নিষিদ্ধ|প্রমোশন নিষেধ)/i;
const FB_APPROVAL   = /\b(posts? (are|will be|must be) (approved|reviewed)|admin approval|approval (required|queue)|moderated group|all posts? go through)\b|(অনুমোদন|এডমিন অনুমোদন)/i;

function parseRules(rulesText) {
    const t = String(rulesText || '');
    return {
        promo_allowed: !FB_PROMO_BAN.test(t),
        approval_required: FB_APPROVAL.test(t),
        rules_text: t.slice(0, 4000) || null
    };
}

// ===========================================================================
// FB SCRAPE LAYER
// ===========================================================================

/**
 * Pulls posts for one public group. Returns normalised rows, not raw Apify.
 * Private groups are deliberately not supported: they need a logged-in
 * session, which is both a TOS violation and an account-ban risk.
 */
async function fbScrapeGroup(client, groupRef, opts = {}) {
    const { groupId, url } = groupRef;
    const limit = Math.min(opts.limit || FB_DEFAULT_POSTS, FB_MAX_POSTS);
    const days = opts.days || FB_DEFAULT_DAYS;
    const onlyPostsNewerThan = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

    const run = await client.actor(FB_GROUP_POSTS_ACTOR).call({
        startUrls: [{ url }],
        resultsLimit: limit,
        maxPosts: limit,
        onlyPostsNewerThan,
        commentsMode: 'RANKED_THREADED',
        maxComments: opts.sampleComments ? 10 : 0,
        scrapeComments: !!opts.sampleComments
    });

    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    return { raw: items || [], groupId, url };
}

/** Group-level metadata, harvested from whatever the post payload carries. */
function fbGroupMeta(rawItems, groupRef) {
    const first = (rawItems || []).find(i => i && (i.groupTitle || i.groupName || i.group)) || {};
    const g = first.group || {};
    const rules = first.groupRules || g.rules || first.rules || '';
    const rulesText = Array.isArray(rules)
        ? rules.map(r => (typeof r === 'string' ? r : `${r.title || ''} ${r.description || ''}`)).join('\n')
        : String(rules || '');

    const privacyRaw = String(first.groupPrivacy || g.privacy || first.privacy || 'public').toLowerCase();

    return {
        group_id: groupRef.groupId,
        name: first.groupTitle || first.groupName || g.name || groupRef.groupId,
        url: groupRef.url,
        member_count: firstNum(first.groupMembersCount, g.memberCount, first.memberCount, 0),
        privacy: privacyRaw.includes('private') || privacyRaw.includes('closed') ? 'private' : 'public',
        ...parseRules(rulesText)
    };
}

/** Raw Apify item -> the shape fb_posts stores. */
function fbNormalisePost(item, groupId, groupRowId, userId) {
    const postId = fbPostId(item);
    if (!postId) return null;

    const text = fbText(item);
    const d = fbTimestamp(item);
    const { total: reactions, breakdown } = fbReactions(item);
    const comments = firstNum(item.commentsCount, item.comments?.length, item.commentCount);
    const shares = firstNum(item.sharesCount, item.shareCount, item.shares);
    const media = fbMediaType(item);
    const { hour, dow } = localParts(d);
    const words = text ? text.split(/\s+/).length : 0;

    const authorName = item.user?.name || item.author?.name || item.authorName || item.ownerName || null;
    const isAdmin = !!(item.isAdmin || item.authorIsAdmin || /admin|moderator/i.test(item.authorRole || ''));

    const engagement = reactions + (FB_COMMENT_WEIGHT * comments) + (FB_SHARE_WEIGHT * shares);
    const ageHours = d ? (Date.now() - d.getTime()) / 3600000 : 999;

    return {
        user_id: userId,
        group_id: groupId,
        group_row_id: groupRowId || null,
        post_id: postId,
        post_url: fbPostUrl(item, groupId),
        author_hash: authorHash(authorName, groupId),
        author_label: isAdmin ? 'admin' : 'member',
        author_is_admin: isAdmin,
        content: text.slice(0, 6000),
        content_length: text.length,
        media_type: media.type,
        link_url: media.link || null,
        link_domain: media.link ? domainOf(media.link) : null,
        reactions_total: reactions,
        reactions_breakdown: breakdown,
        comments,
        shares,
        posted_at: d ? d.toISOString() : null,
        hour_local: hour,
        dow_local: dow,
        engagement_raw: engagement,
        performance_index: null,          // filled by the normalisation pass
        intent_type: classifyIntent(text),
        topic_tags: topicTags(text),
        opening_pattern: openingPattern(text),
        length_band: lengthBand(words),
        is_provisional: ageHours < 24,    // FB counts are still settling under 24h
        raw: { keys: Object.keys(item || {}).slice(0, 40) }
    };
}

/**
 * NORMALISATION PASS.
 * Raw counts lie because groups differ in size. Everything is indexed against
 * that group's own median for that month, so an index of 3.0 means "three
 * times what this room normally does" and is directly comparable between a
 * 5k group and a 50k group.
 */
function fbIndexPosts(rows) {
    const buckets = {};
    rows.forEach(r => {
        const month = (r.posted_at || '').slice(0, 7) || 'unknown';
        const key = `${r.group_id}::${month}`;
        (buckets[key] = buckets[key] || []).push(r);
    });

    const baselines = {};
    Object.entries(buckets).forEach(([key, group]) => {
        // Provisional posts are excluded from the baseline so half-counted
        // fresh posts cannot drag the median down.
        const settled = group.filter(r => !r.is_provisional);
        const pool = settled.length >= 5 ? settled : group;
        const med = median(pool.map(r => r.engagement_raw));
        baselines[key] = med > 0 ? med : 1;
    });

    rows.forEach(r => {
        const month = (r.posted_at || '').slice(0, 7) || 'unknown';
        const base = baselines[`${r.group_id}::${month}`] || 1;
        r.performance_index = +(r.engagement_raw / base).toFixed(3);
    });

    return { rows, baselines };
}

// ===========================================================================
// FB ANALYSIS LAYER
// ===========================================================================

function leaderboard(rows, dimension, minCount = 2) {
    const agg = {};
    rows.forEach(r => {
        const k = r[dimension] || 'unknown';
        agg[k] = agg[k] || { key: k, count: 0, indexSum: 0, engagementSum: 0, commentSum: 0 };
        agg[k].count++;
        agg[k].indexSum += r.performance_index || 0;
        agg[k].engagementSum += r.engagement_raw || 0;
        agg[k].commentSum += r.comments || 0;
    });

    return Object.values(agg)
        .filter(a => a.count >= Math.min(minCount, rows.length))
        .map(a => ({
            key: a.key,
            posts: a.count,
            share: ((a.count / rows.length) * 100).toFixed(1) + '%',
            avgIndex: +(a.indexSum / a.count).toFixed(2),
            avgEngagement: Math.round(a.engagementSum / a.count),
            avgComments: Math.round(a.commentSum / a.count)
        }))
        .sort((x, y) => y.avgIndex - x.avgIndex);
}

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function timeHeatmap(rows) {
    const cells = {};
    rows.forEach(r => {
        if (r.hour_local === null || r.dow_local === null) return;
        const k = `${r.dow_local}:${r.hour_local}`;
        cells[k] = cells[k] || { dow: r.dow_local, hour: r.hour_local, posts: 0, indexSum: 0 };
        cells[k].posts++;
        cells[k].indexSum += r.performance_index || 0;
    });

    const flat = Object.values(cells).map(c => ({
        dow: c.dow, dowName: DOW_NAMES[c.dow], hour: c.hour,
        posts: c.posts, avgIndex: +(c.indexSum / c.posts).toFixed(2)
    }));

    const byHour = {}, byDay = {};
    rows.forEach(r => {
        if (r.hour_local !== null) {
            byHour[r.hour_local] = byHour[r.hour_local] || { posts: 0, indexSum: 0 };
            byHour[r.hour_local].posts++; byHour[r.hour_local].indexSum += r.performance_index || 0;
        }
        if (r.dow_local !== null) {
            byDay[r.dow_local] = byDay[r.dow_local] || { posts: 0, indexSum: 0 };
            byDay[r.dow_local].posts++; byDay[r.dow_local].indexSum += r.performance_index || 0;
        }
    });

    const hourRank = Object.entries(byHour)
        .map(([h, v]) => ({ hour: +h, posts: v.posts, avgIndex: +(v.indexSum / v.posts).toFixed(2) }))
        .filter(h => h.posts >= 2)
        .sort((a, b) => b.avgIndex - a.avgIndex);

    const dayRank = Object.entries(byDay)
        .map(([d, v]) => ({ dow: +d, dowName: DOW_NAMES[+d], posts: v.posts, avgIndex: +(v.indexSum / v.posts).toFixed(2) }))
        .sort((a, b) => b.avgIndex - a.avgIndex);

    return { cells: flat, bestHours: hourRank.slice(0, 5), worstHours: hourRank.slice(-3).reverse(), bestDays: dayRank };
}

/** Everything the audit knows about one room. */
function computeGroupAudit(groupMeta, rows, demandRows) {
    const posts = rows.length;

    if (!posts) {
        return {
            groupId: groupMeta.group_id,
            name: groupMeta.name,
            url: groupMeta.url,
            memberCount: groupMeta.member_count,
            postsAnalyzed: 0,
            roomValue: 0,
            roomValueBreakdown: { verdict: 'No posts returned — group may be private, empty, or blocked.' },
            formats: [], intents: [], openings: [], lengths: [],
            heatmap: { cells: [], bestHours: [], bestDays: [] },
            topPosts: [], bottomPosts: [], demandKeywords: [], demandSignals: 0,
            whatWorks: ['No public posts were returned for this group. Confirm the group is public and the URL is correct.']
        };
    }

    const stamps = rows.map(r => r.posted_at ? new Date(r.posted_at).getTime() : null).filter(Boolean).sort((a, b) => a - b);
    const spanDays = stamps.length > 1 ? Math.max(1, (stamps[stamps.length - 1] - stamps[0]) / 86400000) : 1;
    const postsPerDay = +(posts / spanDays).toFixed(1);

    const uniquePosters = new Set(rows.map(r => r.author_hash)).size;
    const uniquePosterRatio = +(uniquePosters / posts).toFixed(2);
    const medianComments = median(rows.map(r => r.comments));
    const medianReactions = median(rows.map(r => r.reactions_total));
    const demandRate = posts ? demandRows.length / posts : 0;

    const rv = computeRoomValue({
        postsPerDay, medianComments, uniquePosterRatio,
        promoAllowed: groupMeta.promo_allowed,
        approvalRequired: groupMeta.approval_required,
        memberCount: groupMeta.member_count,
        demandRate,
        sampleSize: posts
    });

    const sorted = [...rows].sort((a, b) => (b.performance_index || 0) - (a.performance_index || 0));
    const slim = r => ({
        postId: r.post_id, url: r.post_url,
        excerpt: (r.content || '').slice(0, 220),
        format: r.media_type, intent: r.intent_type,
        opening: r.opening_pattern, lengthBand: r.length_band,
        reactions: r.reactions_total, comments: r.comments, shares: r.shares,
        index: r.performance_index, postedAt: r.posted_at,
        hour: r.hour_local, dowName: r.dow_local !== null ? DOW_NAMES[r.dow_local] : null,
        byAdmin: r.author_is_admin, provisional: r.is_provisional
    });

    const formats = leaderboard(rows, 'media_type');
    const intents = leaderboard(rows, 'intent_type');
    const openings = leaderboard(rows, 'opening_pattern');
    const lengths = leaderboard(rows, 'length_band');
    const heatmap = timeHeatmap(rows);

    // Demand keywords, from the demand rows only — this is what the room is
    // actively shopping for, not what it happens to talk about.
    const kw = {};
    demandRows.forEach(d => topicTags(d.snippet, 8).forEach(t => { kw[t] = (kw[t] || 0) + 1; }));
    const demandKeywords = Object.entries(kw).sort((a, b) => b[1] - a[1]).slice(0, 20)
        .map(([term, hits]) => ({ term, hits }));

    const demandCategories = {};
    demandRows.forEach(d => { demandCategories[d.category] = (demandCategories[d.category] || 0) + 1; });

    const whatWorks = [];
    if (formats[0]) whatWorks.push(`${formats[0].key} posts run at ${formats[0].avgIndex}x this room's median — the strongest format here across ${formats[0].posts} posts.`);
    if (formats.length > 1) {
        const worst = formats[formats.length - 1];
        whatWorks.push(`${worst.key} posts run at ${worst.avgIndex}x. ${worst.avgIndex < 0.8 ? 'This room suppresses them — avoid.' : 'Usable but not your first choice.'}`);
    }
    if (intents[0]) whatWorks.push(`Posts that ${intents[0].key.replace(/_/g, ' ')} perform at ${intents[0].avgIndex}x. In this room, ${intents[0].key === 'recommendation_request' || intents[0].key === 'question' ? 'asking beats telling.' : 'that is what earns attention.'}`);
    if (heatmap.bestHours[0]) whatWorks.push(`Best posting window is ${String(heatmap.bestHours[0].hour).padStart(2, '0')}:00 local (${heatmap.bestHours[0].avgIndex}x across ${heatmap.bestHours[0].posts} posts)${heatmap.bestDays[0] ? `, strongest on ${heatmap.bestDays[0].dowName}` : ''}.`);
    if (lengths[0]) whatWorks.push(`${lengths[0].key} posts index highest at ${lengths[0].avgIndex}x.`);
    if (!groupMeta.promo_allowed) whatWorks.push('This group bans promotion. Every draft the advisor produces here is locked to value-first or question format.');
    if (groupMeta.approval_required) whatWorks.push('Posts go through an approval queue, so same-day timing is unreliable. Treat the posting-time heatmap as directional only.');
    if (demandRows.length) whatWorks.push(`${demandRows.length} live demand signals found (${((demandRate) * 100).toFixed(1)}% of posts) — this room states what it wants to buy.`);

    return {
        groupId: groupMeta.group_id,
        name: groupMeta.name,
        url: groupMeta.url,
        memberCount: groupMeta.member_count,
        privacy: groupMeta.privacy,
        promoAllowed: groupMeta.promo_allowed,
        approvalRequired: groupMeta.approval_required,
        rulesText: groupMeta.rules_text,
        postsAnalyzed: posts,
        windowDays: Math.round(spanDays),
        postsPerDay,
        uniquePosters,
        uniquePosterRatio,
        medianComments,
        medianReactions,
        adminShare: +((rows.filter(r => r.author_is_admin).length / posts) * 100).toFixed(1),
        provisionalPosts: rows.filter(r => r.is_provisional).length,
        roomValue: rv.score,
        roomValueBreakdown: rv.breakdown,
        formats, intents, openings, lengths, heatmap,
        topPosts: sorted.slice(0, 10).map(slim),
        bottomPosts: sorted.slice(-10).reverse().map(slim),
        demandSignals: demandRows.length,
        demandRate: +(demandRate * 100).toFixed(1),
        demandCategories: Object.entries(demandCategories).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ category: k, count: v })),
        demandKeywords,
        whatWorks,
        // Verbatim winners, used to condition the advisor on THIS room
        exemplars: sorted.filter(r => (r.content || '').length > 60).slice(0, 3).map(r => ({
            text: (r.content || '').slice(0, 700),
            index: r.performance_index, format: r.media_type, intent: r.intent_type
        }))
    };
}

/** Cross-group roll-up for a combined audit. */
function buildCommunityBenchmark(audits) {
    const live = audits.filter(a => a.postsAnalyzed > 0);
    if (!live.length) return null;

    const ranked = [...live].sort((a, b) => b.roomValue - a.roomValue).map((a, i) => ({
        rank: i + 1, groupId: a.groupId, name: a.name, roomValue: a.roomValue,
        members: a.memberCount, postsPerDay: a.postsPerDay, medianComments: a.medianComments,
        demandSignals: a.demandSignals, demandRate: a.demandRate,
        promoAllowed: a.promoAllowed, approvalRequired: a.approvalRequired,
        postsAnalyzed: a.postsAnalyzed,
        lowConfidence: !!a.roomValueBreakdown.lowConfidence,
        verdict: a.roomValueBreakdown.verdict
    }));

    const rollup = (dim) => {
        const agg = {};
        live.forEach(a => (a[dim] || []).forEach(row => {
            agg[row.key] = agg[row.key] || { key: row.key, posts: 0, weighted: 0, rooms: 0 };
            agg[row.key].posts += row.posts;
            agg[row.key].weighted += row.avgIndex * row.posts;
            agg[row.key].rooms++;
        }));
        return Object.values(agg)
            .map(a => ({ key: a.key, posts: a.posts, rooms: a.rooms, avgIndex: +(a.weighted / a.posts).toFixed(2) }))
            .sort((x, y) => y.avgIndex - x.avgIndex);
    };

    const kw = {};
    live.forEach(a => (a.demandKeywords || []).forEach(k => { kw[k.term] = (kw[k.term] || 0) + k.hits; }));

    const cats = {};
    live.forEach(a => (a.demandCategories || []).forEach(c => { cats[c.category] = (cats[c.category] || 0) + c.count; }));

    return {
        rooms: live.length,
        totalPosts: live.reduce((s, a) => s + a.postsAnalyzed, 0),
        totalDemand: live.reduce((s, a) => s + a.demandSignals, 0),
        avgRoomValue: Math.round(live.reduce((s, a) => s + a.roomValue, 0) / live.length),
        totalMembers: live.reduce((s, a) => s + (a.memberCount || 0), 0),
        ranked,
        formats: rollup('formats'),
        intents: rollup('intents'),
        openings: rollup('openings'),
        demandKeywords: Object.entries(kw).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([term, hits]) => ({ term, hits })),
        demandCategories: Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([category, count]) => ({ category, count })),
        bestRoom: ranked[0] || null,
        deadRooms: ranked.filter(r => r.roomValue < 30).map(r => r.name)
    };
}

// ===========================================================================
// FB AI LAYER
// ===========================================================================

async function geminiJSON(prompt, maxTokens = 4096, temperature = 0.5) {
    if (!GEMINI_API_KEY) return null;
    try {
        const r = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    generationConfig: { temperature, maxOutputTokens: maxTokens, responseMimeType: 'application/json' }
                })
            }
        );
        if (!r.ok) { console.error('[Gemini FB]', r.status, await r.text()); return null; }
        const data = await r.json();
        const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
        return JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch (err) {
        console.error('[Gemini FB error]', err.message);
        return null;
    }
}

async function fbNarrative(payload) {
    const prompt =
`You are a local-market community strategist writing a paid client report about Facebook groups.
The client wants to know which rooms are worth their time, what to post in them, and what demand is going unmet.

Reply with ONLY valid JSON matching this schema:
{
 "executive_summary": "3-5 sentences a business owner understands, naming the specific groups",
 "room_verdicts": [{"group":"name","verdict":"work it | test it | skip it","why":"one sentence"}],
 "what_works_here": ["concrete, specific to these rooms, not generic advice"],
 "what_fails_here": ["formats or intents the data shows underperform"],
 "unmet_demand": ["what people are asking for that nobody is answering well"],
 "posting_playbook": [{"room":"name","format":"...","intent":"...","best_time":"...","angle":"..."}],
 "lead_actions": ["how to convert the demand signals into paying work this week"],
 "risks": ["rules, approval queues, or ban risks specific to these groups"],
 "next_30_days": [{"week":"Week 1","actions":["..."]}]
}
Ground every claim in the numbers supplied. Do not invent group names. No markdown outside the JSON.

DATA:
${JSON.stringify(payload).slice(0, 60000)}`;

    return geminiJSON(prompt, 4096, 0.45);
}

/**
 * POST ADVISOR.
 * Conditioned on one specific room's data — its winning format, winning
 * intent, best hour, demand keywords, verbatim exemplars and its rules.
 * Without that conditioning this is just a worse ChatGPT.
 *
 * The compliance gate is a hard constraint, not a suggestion: if the group
 * bans promotion, no draft may pitch. Getting users banned is the single
 * biggest churn risk in this product.
 */
async function fbGenerateDrafts(audit, opts = {}) {
    const count = Math.min(Math.max(parseInt(opts.count || 5, 10), 1), 10);
    const promoAllowed = audit.promoAllowed !== false && !opts.forceValueFirst;
    const mode = promoAllowed ? 'open' : 'value_first';

    const bestFormat = audit.formats?.[0]?.key || 'text';
    const bestIntent = audit.intents?.[0]?.key || 'question';
    const bestHour = audit.heatmap?.bestHours?.[0];
    const bestDay = audit.heatmap?.bestDays?.[0];
    const timeLabel = bestHour
        ? `${String(bestHour.hour).padStart(2, '0')}:00 local${bestDay ? ` on ${bestDay.dowName}` : ''}`
        : 'no reliable window in the data';

    const complianceBlock = promoAllowed
        ? `This group permits commercial posts. Drafts may include a soft offer, but the value must land before the ask.`
        : `HARD CONSTRAINT — THIS GROUP PROHIBITS PROMOTION.
Every draft MUST be value-first or question format. No pitch, no service description, no pricing,
no "DM me", no "contact us", no link to a business page, no call to action that sells anything.
A draft that violates this gets the user banned. If you cannot write a compliant draft, write a
question that surfaces demand instead.`;

    const prompt =
`You write Facebook group posts that fit one specific room. You have that room's real performance data.
Write in the same register as the exemplar posts below — same language mix, same formality, same length.

ROOM: ${audit.name} (${audit.memberCount || 'unknown'} members)
Winning format: ${bestFormat} (${audit.formats?.[0]?.avgIndex || '?'}x room median)
Winning intent: ${bestIntent} (${audit.intents?.[0]?.avgIndex || '?'}x room median)
Winning opening pattern: ${audit.openings?.[0]?.key || 'unknown'}
Winning length: ${audit.lengths?.[0]?.key || 'unknown'}
Best time to post: ${timeLabel}
Underperforming formats: ${(audit.formats || []).slice(-2).map(f => `${f.key} (${f.avgIndex}x)`).join(', ') || 'none identified'}
Live demand keywords: ${(audit.demandKeywords || []).slice(0, 12).map(k => k.term).join(', ') || 'none found'}
Top demand categories: ${(audit.demandCategories || []).slice(0, 4).map(c => c.category).join(', ') || 'none'}
Group rules: ${(audit.rulesText || 'not published').slice(0, 900)}

${complianceBlock}

VERBATIM HIGH-PERFORMING POSTS FROM THIS EXACT ROOM (match this voice):
${(audit.exemplars || []).map((e, i) => `[${i + 1}] (${e.index}x, ${e.format}, ${e.intent})\n${e.text}`).join('\n---\n') || 'None available — write in plain conversational local-group voice.'}

${opts.brief ? `WHAT THE USER SELLS / WANTS TO ACHIEVE: ${String(opts.brief).slice(0, 600)}` : ''}

Produce ${count} drafts. Reply with ONLY valid JSON:
{"drafts":[{
  "draft_text":"the full post, ready to paste",
  "format":"text|photo|album|video|link|poll",
  "intent_type":"question|recommendation_request|story|offer|event|discussion",
  "pattern_used":"the specific pattern from the data this exploits",
  "rationale":"one sentence citing the number it is built on",
  "suggested_time":"e.g. Tuesday 20:00 local",
  "predicted_band":"top|above|typical",
  "predicted_index":1.8
}]}`;

    const out = await geminiJSON(prompt, 6000, 0.75);
    let drafts = Array.isArray(out?.drafts) ? out.drafts : [];

    // Belt and braces: the compliance gate is enforced in code as well as in
    // the prompt. A model that ignores the instruction must not reach the user.
    if (!promoAllowed) {
        const banned = /\b(dm me|inbox me|message me|contact us|call us|whatsapp|order now|book now|our (service|shop|company|price)|we offer|discount|visit our|price starts|only \d+ ?(tk|৳|\$))\b/i;
        drafts = drafts.filter(d => !banned.test(String(d.draft_text || '')));
    }

    return { drafts, complianceMode: mode, promoAllowed };
}

// ===========================================================================
// FB PERSISTENCE
// ===========================================================================

async function fbUpsertGroup(userId, meta, extra = {}) {
    const row = {
        user_id: userId,
        group_id: meta.group_id,
        name: meta.name,
        url: meta.url,
        member_count: meta.member_count || 0,
        privacy: meta.privacy || 'public',
        rules_text: meta.rules_text || null,
        promo_allowed: meta.promo_allowed !== false,
        approval_required: !!meta.approval_required,
        ...extra
    };
    const { data, error } = await supabase.from('fb_groups')
        .upsert(row, { onConflict: 'user_id,group_id' })
        .select('id, group_id, name, url, member_count, room_value_score, promo_allowed, approval_required, privacy, niche, location_label')
        .maybeSingle();
    if (error) console.error('[fbUpsertGroup]', error.message);
    return data;
}

async function fbSavePosts(rows) {
    if (!rows.length) return 0;
    let saved = 0;
    for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        const { error } = await supabase.from('fb_posts')
            .upsert(chunk, { onConflict: 'user_id,group_id,post_id' });
        if (error) console.error('[fbSavePosts]', error.message);
        else saved += chunk.length;
    }
    return saved;
}

async function fbSaveDemand(rows) {
    if (!rows.length) return 0;
    let saved = 0;
    for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        const { error } = await supabase.from('fb_demand_signals')
            .upsert(chunk, { onConflict: 'user_id,group_id,source_post_id,matched_phrase' });
        if (error) console.error('[fbSaveDemand]', error.message);
        else saved += chunk.length;
    }
    return saved;
}

function fbEstimateCredits(groups, postsPerGroup, sampleComments) {
    const posts = groups * postsPerGroup;
    const commentMultiplier = sampleComments ? 1.6 : 1;
    return +(((posts / 1000) * COST_PER_1K_FB_POSTS * commentMultiplier)).toFixed(4);
}

/**
 * Scrape one group end to end: raw -> normalised -> indexed -> demand mined.
 * Shared by discovery (shallow) and audit (deep).
 */
async function fbProcessGroup(client, userId, groupRef, opts) {
    const { raw } = await fbScrapeGroup(client, groupRef, opts);
    const meta = fbGroupMeta(raw, groupRef);

    const groupRow = await fbUpsertGroup(userId, meta, {
        niche: opts.niche || null,
        location_label: opts.location || null,
        source: opts.source || 'manual',
        last_scraped_at: new Date().toISOString()
    });

    const rows = raw
        .map(item => fbNormalisePost(item, meta.group_id, groupRow?.id, userId))
        .filter(Boolean);

    fbIndexPosts(rows);

    const demand = [];
    rows.forEach(r => {
        mineDemand(r.content, { engagement: r.engagement_raw, postedAt: r.posted_at }).forEach(d => {
            demand.push({
                user_id: userId,
                group_id: meta.group_id,
                group_name: meta.name,
                source_post_id: r.post_id,
                source_url: r.post_url,
                author_hash: r.author_hash,
                engagement: Math.round(r.engagement_raw),
                posted_at: r.posted_at,
                detected_at: new Date().toISOString(),
                ...d
            });
        });
    });

    return { meta, groupRow, rows, demand };
}

// ===========================================================================
// FB API :: ESTIMATE
// ===========================================================================

app.get('/api/fb/estimate-credits', async (req, res) => {
    const ctx = await auth(req, res); if (!ctx) return;
    const groups = Math.min(parseInt(req.query.groups || '1', 10), FB_MAX_GROUPS);
    const posts = Math.min(parseInt(req.query.posts || FB_DEFAULT_POSTS, 10), FB_MAX_POSTS);
    const sampleComments = req.query.comments === 'true' || req.query.comments === '1';
    res.json({
        groups, postsPerGroup: posts,
        totalPosts: groups * posts,
        sampleComments,
        estimatedUsd: fbEstimateCredits(groups, posts, sampleComments),
        note: 'Estimate only. Facebook group runs cost more per post than Instagram — comment sampling is the expensive part.'
    });
});

// ===========================================================================
// FB API :: ENGINE 1 — COMMUNITY DISCOVERY
// ===========================================================================

/**
 * Ranked groups for a location + niche. Returns the full list with the top 10
 * flagged, because member count is a vanity metric and the ranking is the
 * product. Discovery does a shallow scrape (enough posts to measure liveness)
 * rather than the full audit pull.
 */
app.post('/api/fb/discover-groups', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;

        const {
            location = '', niche = '', keywords = [],
            sampleSize, maxGroups, groupUrls = []
        } = req.body;

        const seeds = [...new Set(
            (Array.isArray(groupUrls) ? groupUrls : String(groupUrls || '').split(/[\n,]/))
                .map(parseGroupRef).filter(Boolean).map(g => g.groupId)
        )].slice(0, FB_MAX_GROUPS);

        if (!location && !niche && !keywords.length && !seeds.length) {
            return res.status(400).json({ error: 'Give a location, a niche, or paste group URLs.' });
        }

        const sample = Math.min(parseInt(sampleSize || 40, 10), 120);
        const cap = Math.min(parseInt(maxGroups || 12, 10), FB_MAX_GROUPS);
        const estimate = fbEstimateCredits(seeds.length || cap, sample, false);

        const job = await createJob(ctx.user.id, 'fb_discovery', 'fb_community',
            { location, niche, keywords, seeds, sampleSize: sample, maxGroups: cap }, estimate);

        runJob(job.id, async (progress) => {
            const { client } = await getWorkingClient('fb_community', ctx.user.id);
            let refs = seeds.map(id => ({ groupId: id, url: `https://www.facebook.com/groups/${id}/` }));

            // Keyword search first — only when the user did not paste URLs.
            if (!refs.length) {
                await progress(8, `Searching Facebook for "${niche || keywords.join(', ')}" near ${location || 'anywhere'}`);
                const queries = [
                    ...(keywords || []),
                    niche && location ? `${niche} ${location}` : null,
                    location ? `${location} community` : null,
                    location ? `${location} buy sell` : null,
                    niche || null
                ].filter(Boolean).slice(0, 5);

                const found = new Map();
                for (const q of queries) {
                    try {
                        const run = await client.actor(FB_SEARCH_ACTOR).call({
                            search: q, searchType: 'groups', query: q,
                            resultsLimit: 25, maxResults: 25
                        });
                        const { items } = await client.dataset(run.defaultDatasetId).listItems();
                        (items || []).forEach(it => {
                            const ref = parseGroupRef(it.url || it.groupUrl || it.link || it.id);
                            if (!ref) return;
                            if (!found.has(ref.groupId)) {
                                found.set(ref.groupId, { ...ref, hintName: it.name || it.title || null, hintMembers: firstNum(it.membersCount, it.memberCount) });
                            }
                        });
                        await progress(12, `"${q}" returned ${items?.length || 0} candidates`);
                    } catch (e) {
                        await progress(12, `Search for "${q}" failed: ${e.message}`);
                    }
                }
                refs = Array.from(found.values()).slice(0, cap);
            }

            if (!refs.length) {
                throw new Error('No groups found. Facebook group search is the least reliable part of this pipeline — paste group URLs directly on the Discover tab and they will be scored the same way.');
            }

            await progress(20, `Measuring ${refs.length} rooms`);

            const scored = [];
            const step = Math.floor(70 / refs.length);

            for (let i = 0; i < refs.length; i++) {
                await progress(20 + step * i, `Sampling ${refs[i].groupId} (${i + 1}/${refs.length})`);
                try {
                    const { meta, rows, demand } = await fbProcessGroup(client, ctx.user.id, refs[i], {
                        limit: sample, days: 30, sampleComments: false,
                        niche, location, source: 'discovery'
                    });

                    if (meta.privacy === 'private') {
                        await progress(20 + step * i, `${meta.name} is private — skipped (needs a logged-in session, which we will not do)`);
                        continue;
                    }

                    await fbSavePosts(rows);
                    await fbSaveDemand(demand);

                    const audit = computeGroupAudit(meta, rows, demand);
                    await supabase.from('fb_groups').update({
                        posts_per_day: audit.postsPerDay,
                        median_comments: audit.medianComments,
                        unique_poster_ratio: audit.uniquePosterRatio,
                        room_value_score: audit.roomValue,
                        score_breakdown: audit.roomValueBreakdown,
                        last_scraped_at: new Date().toISOString()
                    }).eq('user_id', ctx.user.id).eq('group_id', meta.group_id);

                    scored.push({
                        groupId: meta.group_id, name: meta.name, url: meta.url,
                        memberCount: meta.member_count, privacy: meta.privacy,
                        promoAllowed: meta.promo_allowed, approvalRequired: meta.approval_required,
                        postsPerDay: audit.postsPerDay, medianComments: audit.medianComments,
                        uniquePosters: audit.uniquePosters, uniquePosterRatio: audit.uniquePosterRatio,
                        demandSignals: audit.demandSignals, demandRate: audit.demandRate,
                        roomValue: audit.roomValue, breakdown: audit.roomValueBreakdown,
                        postsSampled: audit.postsAnalyzed
                    });
                    await progress(20 + step * (i + 1), `${meta.name}: Room Value ${audit.roomValue} — ${audit.roomValueBreakdown.verdict}`);
                } catch (e) {
                    await progress(20 + step * (i + 1), `Could not sample ${refs[i].groupId}: ${e.message}`);
                }
            }

            if (!scored.length) throw new Error('Every candidate group failed to scrape. They are most likely private.');

            scored.sort((a, b) => b.roomValue - a.roomValue);
            scored.forEach((g, i) => { g.rank = i + 1; g.isTop10 = i < 10; });

            await progress(96, `Ranked ${scored.length} rooms`);
            return {
                groups: scored,
                top10: scored.slice(0, 10),
                location, niche,
                skipped: refs.length - scored.length
            };
        });

        res.status(202).json({
            success: true, jobId: job.id,
            candidates: seeds.length || cap,
            estimatedUsd: estimate
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/** Manual import — always works, unlike group search. */
app.post('/api/fb/groups/import', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        const { urls = [], niche, location } = req.body;

        const refs = (Array.isArray(urls) ? urls : String(urls || '').split(/[\n,]/))
            .map(parseGroupRef).filter(Boolean);
        if (!refs.length) return res.status(400).json({ error: 'No valid Facebook group URLs found.' });

        const saved = [];
        for (const ref of refs.slice(0, FB_MAX_GROUPS)) {
            const row = await fbUpsertGroup(ctx.user.id, {
                group_id: ref.groupId, name: ref.groupId, url: ref.url,
                member_count: 0, privacy: 'unknown', promo_allowed: true, approval_required: false
            }, { niche: niche || null, location_label: location || null, source: 'manual' });
            if (row) saved.push(row);
        }
        res.json({ success: true, groups: saved, note: 'Imported unscored. Run discovery or an audit to score them.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fb/groups', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        let q = supabase.from('fb_groups').select('*')
            .eq('user_id', ctx.user.id).eq('is_archived', false)
            .order('room_value_score', { ascending: false });
        if (req.query.niche) q = q.eq('niche', req.query.niche);
        if (req.query.location) q = q.ilike('location_label', `%${req.query.location}%`);
        const { data, error } = await q;
        if (error) throw error;
        res.json({ groups: data || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/fb/groups/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        const { error } = await supabase.from('fb_groups')
            .update({ is_archived: true }).eq('id', req.params.id).eq('user_id', ctx.user.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===========================================================================
// FB API :: GROUP SETS  (mirror of competitor_sets)
// ===========================================================================

app.post('/api/fb/group-sets', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        const { name, location, niche, groupIds = [], auditMode, days, postsPerGroup } = req.body;
        if (!groupIds.length) return res.status(400).json({ error: 'Pick at least one group.' });

        // Normalise to facebook group ids so a set re-runs identically whether
        // it was built from row ids on one page or raw ids on another.
        const isUuid = v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v));
        const uuids = groupIds.filter(isUuid);
        let resolved = groupIds.filter(v => !isUuid(v)).map(String);
        if (uuids.length) {
            const { data } = await supabase.from('fb_groups')
                .select('group_id').eq('user_id', ctx.user.id).in('id', uuids);
            resolved = resolved.concat((data || []).map(r => r.group_id));
        }
        const finalIds = [...new Set(resolved)];
        if (!finalIds.length) return res.status(400).json({ error: 'None of those groups resolved.' });

        const { data, error } = await supabase.from('fb_group_sets').insert([{
            user_id: ctx.user.id,
            name: name || `${niche || 'Community'} — ${location || 'set'}`,
            location_label: location || null,
            niche: niche || null,
            group_ids: finalIds.slice(0, FB_MAX_GROUPS),
            audit_mode: auditMode === 'individual' ? 'individual' : 'combined',
            days_window: Math.min(parseInt(days || FB_DEFAULT_DAYS, 10), 90),
            posts_per_group: Math.min(parseInt(postsPerGroup || FB_DEFAULT_POSTS, 10), FB_MAX_POSTS)
        }]).select().maybeSingle();
        if (error) throw error;
        res.json({ success: true, set: data });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fb/group-sets', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        const { data } = await supabase.from('fb_group_sets')
            .select('*').eq('user_id', ctx.user.id).order('created_at', { ascending: false });
        res.json({ sets: data || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/fb/group-sets/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        await supabase.from('fb_group_sets').delete().eq('id', req.params.id).eq('user_id', ctx.user.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===========================================================================
// FB API :: ENGINE 2 — COMMUNITY AUDIT
//
// mode = 'combined'    -> one report covering every selected room, with a
//                         cross-room ranking and a rolled-up playbook
// mode = 'individual'  -> one report per room, run in a single job
//
// The user picks. A combined run answers "which of my rooms deserve the
// effort"; individual runs answer "how do I win in this one room".
// ===========================================================================

app.post('/api/fb/audit-community', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;

        const {
            groupIds = [], groupUrls = [], mode = 'combined',
            days, postsPerGroup, sampleComments = false,
            setId, setName, niche, location
        } = req.body;

        // Resolve selection: saved rows by id, plus any pasted URLs.
        let refs = [];
        if (groupIds.length) {
            const isUuid = v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v));
            const rowIds = groupIds.filter(isUuid);
            const rawIds = groupIds.filter(v => !isUuid(v)).map(String);

            const found = [];
            if (rowIds.length) {
                const { data } = await supabase.from('fb_groups')
                    .select('id, group_id, url, name').eq('user_id', ctx.user.id).in('id', rowIds);
                found.push(...(data || []));
            }
            if (rawIds.length) {
                const { data } = await supabase.from('fb_groups')
                    .select('id, group_id, url, name').eq('user_id', ctx.user.id).in('group_id', rawIds);
                found.push(...(data || []));
                // Ids we have never seen are still auditable — build a ref directly.
                rawIds.filter(id => !found.some(f => f.group_id === id))
                      .forEach(id => found.push({ id: null, group_id: id, url: null, name: id }));
            }
            refs = found.map(r => ({
                groupId: r.group_id,
                url: r.url || `https://www.facebook.com/groups/${r.group_id}/`,
                rowId: r.id, name: r.name
            }));
        }
        (Array.isArray(groupUrls) ? groupUrls : String(groupUrls || '').split(/[\n,]/))
            .map(parseGroupRef).filter(Boolean)
            .forEach(r => { if (!refs.some(x => x.groupId === r.groupId)) refs.push(r); });

        refs = refs.slice(0, FB_MAX_GROUPS);
        if (!refs.length) return res.status(400).json({ error: 'Select at least one group, or paste a group URL.' });

        const auditMode = mode === 'individual' ? 'individual' : 'combined';
        const limit = Math.min(parseInt(postsPerGroup || FB_DEFAULT_POSTS, 10), FB_MAX_POSTS);
        const window = Math.min(parseInt(days || FB_DEFAULT_DAYS, 10), 90);
        const estimate = fbEstimateCredits(refs.length, limit, sampleComments);

        // Re-runnable set, same pattern as competitor_sets
        let activeSetId = setId || null;
        if (!activeSetId && refs.length > 1) {
            const { data: set } = await supabase.from('fb_group_sets').insert([{
                user_id: ctx.user.id,
                name: setName || `${niche || 'Community'} — ${refs.length} rooms`,
                location_label: location || null, niche: niche || null,
                group_ids: refs.map(r => r.groupId),
                audit_mode: auditMode, days_window: window, posts_per_group: limit
            }]).select('id').maybeSingle();
            activeSetId = set?.id || null;
        }

        const job = await createJob(ctx.user.id, 'fb_community_audit', 'fb_community', {
            groups: refs.map(r => r.groupId), mode: auditMode,
            days: window, postsPerGroup: limit, sampleComments, setId: activeSetId
        }, estimate);

        runJob(job.id, async (progress) => {
            const { client } = await getWorkingClient('fb_community', ctx.user.id);
            const step = Math.floor(65 / refs.length);
            const audits = [];
            const allDemand = [];
            let totalPosts = 0;

            for (let i = 0; i < refs.length; i++) {
                await progress(5 + step * i, `Scraping ${refs[i].name || refs[i].groupId} (${i + 1}/${refs.length})`);
                try {
                    const { meta, rows, demand } = await fbProcessGroup(client, ctx.user.id, refs[i], {
                        limit, days: window, sampleComments, niche, location, source: 'audit'
                    });

                    if (!rows.length) {
                        await progress(5 + step * (i + 1), `${meta.name}: no public posts returned — likely private`);
                        audits.push(computeGroupAudit(meta, [], []));
                        continue;
                    }

                    await fbSavePosts(rows);
                    await fbSaveDemand(demand);
                    allDemand.push(...demand);
                    totalPosts += rows.length;

                    const audit = computeGroupAudit(meta, rows, demand);
                    audits.push(audit);

                    await supabase.from('fb_groups').update({
                        posts_per_day: audit.postsPerDay,
                        median_comments: audit.medianComments,
                        unique_poster_ratio: audit.uniquePosterRatio,
                        room_value_score: audit.roomValue,
                        score_breakdown: audit.roomValueBreakdown,
                        last_scraped_at: new Date().toISOString()
                    }).eq('user_id', ctx.user.id).eq('group_id', meta.group_id);

                    await progress(5 + step * (i + 1),
                        `${meta.name}: ${rows.length} posts, ${demand.length} demand signals, Room Value ${audit.roomValue}`);
                } catch (e) {
                    await progress(5 + step * (i + 1), `Failed on ${refs[i].groupId}: ${e.message}`);
                }
            }

            if (!audits.some(a => a.postsAnalyzed > 0)) {
                throw new Error('No public posts returned from any selected group. Public groups only in v1 — private groups need a logged-in session and we will not do that.');
            }

            // ---------- INDIVIDUAL MODE: one report per room ----------
            if (auditMode === 'individual') {
                const reports = [];
                const aiStep = Math.floor(25 / audits.length);

                for (let i = 0; i < audits.length; i++) {
                    const a = audits[i];
                    if (!a.postsAnalyzed) continue;
                    await progress(72 + aiStep * i, `Writing report for ${a.name}`);

                    const ai = await fbNarrative({ mode: 'single', group: a });
                    const payload = { mode: 'individual', group: a, benchmark: null, ai };

                    const { data: saved } = await supabase.from('reports').insert([{
                        user_id: ctx.user.id,
                        platform: 'facebook',
                        report_type: 'fb_group',
                        audit_mode: 'individual',
                        set_id: activeSetId,
                        target_handle: a.name,
                        fb_group_ids: [a.groupId],
                        fb_group_names: [a.name],
                        location_label: location || null,
                        niche: niche || null,
                        grade: a.roomValue >= 70 ? 'A' : a.roomValue >= 50 ? 'B' : a.roomValue >= 30 ? 'C' : 'D',
                        score: a.roomValue,
                        engagement_rate: a.medianComments,
                        posts_analyzed: a.postsAnalyzed,
                        snapshot_date: new Date().toISOString().slice(0, 10),
                        credits_estimate: fbEstimateCredits(1, limit, sampleComments),
                        ai_summary: ai?.executive_summary || null,
                        ai_json: ai || null,
                        report_json: payload
                    }]).select('id').maybeSingle();

                    if (saved?.id) {
                        await supabase.from('fb_posts').update({ report_id: saved.id })
                            .eq('user_id', ctx.user.id).eq('group_id', a.groupId).is('report_id', null);
                        await supabase.from('fb_demand_signals').update({ report_id: saved.id })
                            .eq('user_id', ctx.user.id).eq('group_id', a.groupId).is('report_id', null);
                    }
                    reports.push({ reportId: saved?.id || null, groupId: a.groupId, name: a.name, roomValue: a.roomValue, postsAnalyzed: a.postsAnalyzed, demandSignals: a.demandSignals });
                }

                if (activeSetId) await supabase.from('fb_group_sets').update({ last_run_at: new Date().toISOString() }).eq('id', activeSetId);

                return {
                    mode: 'individual', setId: activeSetId,
                    reports, postsAnalyzed: totalPosts, demandSignals: allDemand.length,
                    reportId: reports[0]?.reportId || null,
                    report: { mode: 'individual', groups: audits, reports }
                };
            }

            // ---------- COMBINED MODE: one comparative report ----------
            await progress(74, 'Ranking rooms against each other');
            const benchmark = buildCommunityBenchmark(audits);

            await progress(84, 'Writing the community strategy');
            const ai = await fbNarrative({ mode: 'combined', groups: audits, benchmark });

            const payload = { mode: 'combined', groups: audits, benchmark, ai };
            const live = audits.filter(a => a.postsAnalyzed > 0);

            await progress(94, 'Saving report');
            const { data: saved } = await supabase.from('reports').insert([{
                user_id: ctx.user.id,
                platform: 'facebook',
                report_type: 'fb_community',
                audit_mode: 'combined',
                set_id: activeSetId,
                target_handle: benchmark?.bestRoom?.name || live[0]?.name || 'Community audit',
                fb_group_ids: live.map(a => a.groupId),
                fb_group_names: live.map(a => a.name),
                location_label: location || null,
                niche: niche || null,
                grade: (benchmark?.avgRoomValue || 0) >= 70 ? 'A' : (benchmark?.avgRoomValue || 0) >= 50 ? 'B' : (benchmark?.avgRoomValue || 0) >= 30 ? 'C' : 'D',
                score: benchmark?.avgRoomValue || 0,
                engagement_rate: live.length ? +(live.reduce((s, a) => s + a.medianComments, 0) / live.length).toFixed(2) : 0,
                posts_analyzed: totalPosts,
                snapshot_date: new Date().toISOString().slice(0, 10),
                credits_estimate: estimate,
                ai_summary: ai?.executive_summary || null,
                ai_json: ai || null,
                report_json: payload
            }]).select('id').maybeSingle();

            if (saved?.id) {
                const ids = live.map(a => a.groupId);
                await supabase.from('fb_posts').update({ report_id: saved.id })
                    .eq('user_id', ctx.user.id).in('group_id', ids).is('report_id', null);
                await supabase.from('fb_demand_signals').update({ report_id: saved.id })
                    .eq('user_id', ctx.user.id).in('group_id', ids).is('report_id', null);
            }
            if (activeSetId) await supabase.from('fb_group_sets').update({ last_run_at: new Date().toISOString() }).eq('id', activeSetId);

            return {
                mode: 'combined', reportId: saved?.id || null, setId: activeSetId,
                postsAnalyzed: totalPosts, demandSignals: allDemand.length, report: payload
            };
        });

        res.status(202).json({
            success: true, jobId: job.id, mode: auditMode, setId: activeSetId,
            groups: refs.length, postsPerGroup: limit, days: window,
            estimatedUsd: estimate
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===========================================================================
// FB API :: REPORTS
// ===========================================================================

app.get('/api/fb/reports', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        const { data, error } = await supabase.from('reports')
            .select('id, target_handle, fb_group_names, fb_group_ids, audit_mode, grade, score, posts_analyzed, snapshot_date, created_at, ai_summary, location_label, niche, set_id')
            .eq('user_id', ctx.user.id).eq('platform', 'facebook')
            .order('created_at', { ascending: false }).limit(100);
        if (error) throw error;
        res.json({ reports: data || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fb/report/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        const { data } = await supabase.from('reports').select('*')
            .eq('id', req.params.id).eq('user_id', ctx.user.id).maybeSingle();
        if (!data) return res.status(404).json({ error: 'Report not found' });
        res.json({ report: data });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fb/set-trend/:setId', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        const { data: runs } = await supabase.from('reports')
            .select('id, snapshot_date, created_at, score, grade, posts_analyzed, report_json')
            .eq('set_id', req.params.setId).eq('user_id', ctx.user.id)
            .eq('platform', 'facebook').order('created_at', { ascending: true });

        if (!runs || !runs.length) return res.json({ runs: [], delta: null });

        const points = runs.map(r => ({
            reportId: r.id,
            date: r.snapshot_date || r.created_at?.slice(0, 10),
            avgRoomValue: r.score,
            grade: r.grade,
            postsAnalyzed: r.posts_analyzed,
            rooms: r.report_json?.benchmark?.rooms || (r.report_json?.groups || []).length,
            demandSignals: r.report_json?.benchmark?.totalDemand ?? null,
            bestRoom: r.report_json?.benchmark?.bestRoom?.name || null
        }));

        let delta = null;
        if (points.length > 1) {
            const a = points[points.length - 2], b = points[points.length - 1];
            delta = {
                from: a.date, to: b.date,
                days: Math.round((new Date(b.date) - new Date(a.date)) / 86400000),
                avgRoomValue: (b.avgRoomValue || 0) - (a.avgRoomValue || 0),
                demandSignals: (b.demandSignals || 0) - (a.demandSignals || 0),
                postsAnalyzed: (b.postsAnalyzed || 0) - (a.postsAnalyzed || 0)
            };
        }
        res.json({ runs: points, delta });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/** Stored posts for one room — powers the post-level table in the report UI. */
app.get('/api/fb/posts', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        const groupId = String(req.query.group_id || '').trim();
        if (!groupId) return res.status(400).json({ error: 'group_id required' });

        let q = supabase.from('fb_posts')
            .select('post_id, post_url, content, media_type, intent_type, opening_pattern, length_band, reactions_total, comments, shares, performance_index, posted_at, hour_local, dow_local, author_is_admin, is_provisional')
            .eq('user_id', ctx.user.id).eq('group_id', groupId);

        if (req.query.sort === 'top') q = q.order('performance_index', { ascending: false, nullsFirst: false });
        else q = q.order('posted_at', { ascending: false });

        const { data } = await q.limit(Math.min(parseInt(req.query.limit || '100', 10), 500));
        res.json({ groupId, posts: data || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===========================================================================
// FB API :: DEMAND FEED  (lead generation)
// ===========================================================================

app.get('/api/fb/demand-feed', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;

        let q = supabase.from('fb_demand_signals').select('*').eq('user_id', ctx.user.id);
        if (req.query.group_id) q = q.eq('group_id', req.query.group_id);
        if (req.query.category)  q = q.eq('category', req.query.category);
        if (req.query.urgency)   q = q.eq('urgency', req.query.urgency);
        if (req.query.status)    q = q.eq('status', req.query.status);
        else                     q = q.neq('status', 'dismissed');
        if (req.query.since)     q = q.gte('posted_at', req.query.since);
        if (req.query.min_score) q = q.gte('lead_score', parseInt(req.query.min_score, 10));

        const { data, error } = await q
            .order('lead_score', { ascending: false })
            .order('detected_at', { ascending: false })
            .limit(Math.min(parseInt(req.query.limit || '200', 10), 500));
        if (error) throw error;

        const rows = data || [];
        const byCategory = {}, byUrgency = {}, byGroup = {};
        rows.forEach(r => {
            byCategory[r.category] = (byCategory[r.category] || 0) + 1;
            byUrgency[r.urgency] = (byUrgency[r.urgency] || 0) + 1;
            byGroup[r.group_name || r.group_id] = (byGroup[r.group_name || r.group_id] || 0) + 1;
        });

        res.json({
            signals: rows,
            summary: {
                total: rows.length,
                hot: rows.filter(r => r.lead_score >= 60).length,
                byCategory: Object.entries(byCategory).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ key: k, count: v })),
                byUrgency, 
                byGroup: Object.entries(byGroup).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ key: k, count: v }))
            }
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/fb/demand/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        const { status, notes } = req.body;
        const patch = {};
        if (status && ['new', 'saved', 'contacted', 'won', 'dismissed'].includes(status)) patch.status = status;
        if (typeof notes === 'string') patch.notes = notes.slice(0, 2000);
        if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update.' });

        const { error } = await supabase.from('fb_demand_signals')
            .update(patch).eq('id', req.params.id).eq('user_id', ctx.user.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/** CSV export of the lead feed. No names — the link is the identity. */
app.get('/api/fb/demand-export', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        let q = supabase.from('fb_demand_signals')
            .select('group_name, category, urgency, lead_score, matched_phrase, snippet, source_url, posted_at, status')
            .eq('user_id', ctx.user.id).neq('status', 'dismissed');
        if (req.query.group_id) q = q.eq('group_id', req.query.group_id);
        const { data } = await q.order('lead_score', { ascending: false }).limit(2000);

        const cell = v => `"${String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
        const header = ['Group', 'Category', 'Urgency', 'Score', 'Trigger phrase', 'What they asked for', 'Post link', 'Posted', 'Status'];
        const csv = [header.join(',')].concat((data || []).map(r => [
            r.group_name, r.category, r.urgency, r.lead_score, r.matched_phrase,
            r.snippet, r.source_url, r.posted_at, r.status
        ].map(cell).join(','))).join('\n');

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="fb-demand-feed.csv"');
        res.send('\uFEFF' + csv);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===========================================================================
// FB API :: ENGINE 3 — POST ADVISOR
// ===========================================================================

app.post('/api/fb/suggest-posts', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        const { reportId, groupId, count = 5, brief } = req.body;
        if (!reportId) return res.status(400).json({ error: 'Run an audit first — drafts are conditioned on a report.' });

        const { data: report } = await supabase.from('reports')
            .select('id, report_json').eq('id', reportId).eq('user_id', ctx.user.id).maybeSingle();
        if (!report?.report_json) return res.status(404).json({ error: 'Report not found.' });

        const rj = report.report_json;
        const pool = rj.mode === 'individual' || rj.mode === 'combined'
            ? (rj.groups || (rj.group ? [rj.group] : []))
            : (rj.group ? [rj.group] : []);

        const audit = groupId ? pool.find(g => g.groupId === groupId) : pool[0];
        if (!audit) return res.status(400).json({ error: 'That group is not in this report.' });
        if (!audit.postsAnalyzed) return res.status(400).json({ error: 'No post data for that room — nothing to condition drafts on.' });

        if (!GEMINI_API_KEY) return res.status(503).json({ error: 'GEMINI_API_KEY is not configured on the server.' });

        const { drafts, complianceMode, promoAllowed } = await fbGenerateDrafts(audit, { count, brief });
        if (!drafts.length) {
            return res.status(502).json({ error: 'No compliant drafts were produced. This group bans promotion — try again with a value-first brief.' });
        }

        const rows = drafts.map(d => ({
            user_id: ctx.user.id,
            group_id: audit.groupId,
            group_name: audit.name,
            report_id: report.id,
            draft_text: String(d.draft_text || '').slice(0, 6000),
            format: d.format || null,
            intent_type: d.intent_type || null,
            rationale: d.rationale || null,
            pattern_used: d.pattern_used || null,
            suggested_time: d.suggested_time || null,
            predicted_band: ['top', 'above', 'typical', 'below'].includes(d.predicted_band) ? d.predicted_band : 'typical',
            predicted_index: Number(d.predicted_index) || null,
            compliance_mode: complianceMode
        }));

        const { data: saved, error } = await supabase.from('fb_suggestions').insert(rows).select();
        if (error) throw error;

        res.json({
            success: true,
            suggestions: saved,
            complianceMode,
            promoAllowed,
            gate: promoAllowed ? null : 'This group prohibits promotion. Every draft is locked to value-first or question format.'
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fb/suggestions', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        let q = supabase.from('fb_suggestions').select('*').eq('user_id', ctx.user.id);
        if (req.query.group_id) q = q.eq('group_id', req.query.group_id);
        if (req.query.report_id) q = q.eq('report_id', req.query.report_id);
        if (req.query.posted === 'true') q = q.eq('posted', true);
        const { data } = await q.order('created_at', { ascending: false }).limit(200);
        res.json({ suggestions: data || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fb/suggestions/:id/mark-posted', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        const { postedUrl } = req.body;
        const { error } = await supabase.from('fb_suggestions').update({
            posted: true,
            posted_at: new Date().toISOString(),
            posted_url: postedUrl || null
        }).eq('id', req.params.id).eq('user_id', ctx.user.id);
        if (error) throw error;
        res.json({ success: true, note: 'Come back in 48 hours and verify it — predicted vs actual is what makes the advisor smarter.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/fb/suggestions/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        await supabase.from('fb_suggestions').delete().eq('id', req.params.id).eq('user_id', ctx.user.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * CLOSING THE LOOP.
 * Re-scrapes the room, finds the posted draft, and records actual vs
 * predicted. Six months of this data is the part competitors cannot copy.
 */
app.post('/api/fb/suggestions/:id/verify', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;

        const { data: sug } = await supabase.from('fb_suggestions').select('*')
            .eq('id', req.params.id).eq('user_id', ctx.user.id).maybeSingle();
        if (!sug) return res.status(404).json({ error: 'Suggestion not found.' });
        if (!sug.posted) return res.status(400).json({ error: 'Mark it as posted first.' });

        const hoursSince = sug.posted_at ? (Date.now() - new Date(sug.posted_at).getTime()) / 3600000 : 999;
        if (hoursSince < 48) {
            return res.status(400).json({
                error: `Too early. Facebook reaction and comment counts are still settling — wait ${Math.ceil(48 - hoursSince)} more hours.`
            });
        }

        const job = await createJob(ctx.user.id, 'fb_verify', 'fb_community',
            { suggestionId: sug.id, groupId: sug.group_id }, fbEstimateCredits(1, 60, false));

        runJob(job.id, async (progress) => {
            const { client } = await getWorkingClient('fb_community', ctx.user.id);
            await progress(20, `Re-scraping ${sug.group_name}`);

            const ref = { groupId: sug.group_id, url: `https://www.facebook.com/groups/${sug.group_id}/` };
            const { rows } = await fbProcessGroup(client, ctx.user.id, ref, { limit: 80, days: 14, sampleComments: false, source: 'verify' });
            await fbSavePosts(rows);

            await progress(70, 'Matching the posted draft');
            const needle = String(sug.draft_text || '').slice(0, 60).toLowerCase().replace(/\s+/g, ' ').trim();
            const match = sug.posted_url
                ? rows.find(r => r.post_url && r.post_url.includes(String(sug.posted_url).split('/').filter(Boolean).pop()))
                : rows.find(r => (r.content || '').toLowerCase().replace(/\s+/g, ' ').includes(needle.slice(0, 40)));

            if (!match) throw new Error('Could not find that post in the recent feed. Paste the exact post URL on the card and try again.');

            await supabase.from('fb_suggestions').update({
                actual_index: match.performance_index,
                verified_at: new Date().toISOString(),
                posted_url: sug.posted_url || match.post_url
            }).eq('id', sug.id);

            const predicted = Number(sug.predicted_index) || null;
            return {
                suggestionId: sug.id,
                predictedIndex: predicted,
                actualIndex: match.performance_index,
                delta: predicted ? +(match.performance_index - predicted).toFixed(2) : null,
                verdict: match.performance_index >= 2 ? 'Top performer in that room'
                       : match.performance_index >= 1.2 ? 'Above the room median'
                       : match.performance_index >= 0.8 ? 'Typical for that room'
                       : 'Below the room median',
                postUrl: match.post_url
            };
        });

        res.status(202).json({ success: true, jobId: job.id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/** Predicted vs actual across everything verified — the advisor's own scorecard. */
app.get('/api/fb/advisor-accuracy', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        const { data } = await supabase.from('fb_suggestions')
            .select('group_name, format, intent_type, predicted_band, predicted_index, actual_index, verified_at')
            .eq('user_id', ctx.user.id).not('actual_index', 'is', null)
            .order('verified_at', { ascending: false }).limit(200);

        const rows = data || [];
        if (!rows.length) return res.json({ verified: 0, rows: [], accuracy: null });

        const withBoth = rows.filter(r => r.predicted_index);
        const mae = withBoth.length
            ? +(withBoth.reduce((s, r) => s + Math.abs(r.actual_index - r.predicted_index), 0) / withBoth.length).toFixed(2)
            : null;
        const bandHit = rows.filter(r => {
            const a = r.actual_index;
            const band = a >= 2 ? 'top' : a >= 1.2 ? 'above' : a >= 0.8 ? 'typical' : 'below';
            return band === r.predicted_band;
        }).length;

        res.json({
            verified: rows.length,
            meanAbsoluteError: mae,
            bandAccuracy: +((bandHit / rows.length) * 100).toFixed(1),
            avgActualIndex: +(rows.reduce((s, r) => s + r.actual_index, 0) / rows.length).toFixed(2),
            rows
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===========================================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Edgelead master engine active on port ${PORT}`));
