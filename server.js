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
const ENGINES                = ['leadgen', 'report'];

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
    return engine === 'report' ? 'report_apify_token' : 'leadgen_apify_token';
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

        const eng = ['leadgen', 'report', 'any'].includes(engine) ? engine : 'any';
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

        const { client } = await getWorkingClient('report', ctx.user.id);
        const limit = Math.min(parseInt(postsLimit || DEFAULT_POSTS_PER_ACC, 10), MAX_POSTS_PER_ACC);

        const main = await auditHandle(client, ctx.user.id, target, limit);
        if (!main) return res.status(400).json({ error: 'Invalid target handle' });

        const rivals = [];
        if (compareRivals) {
            for (const r of [rival1, rival2]) {
                if (!r) continue;
                const a = await auditHandle(client, ctx.user.id, r, limit);
                if (a) rivals.push(a);
            }
        }

        const benchmark = rivals.length ? buildBenchmark(main, rivals) : null;
        const recommendations = ruleRecommendations(main);
        const ai = await geminiNarrative({ target: main, rivals, benchmark });

        const payload = { main, rivals, recommendations, benchmark, ai };

        const { data: saved } = await supabase.from('reports').insert([{
            user_id: ctx.user.id,
            platform: 'instagram',
            report_type: rivals.length ? 'compare' : 'single',
            target_handle: main.handle,
            competitor_handles: rivals.map(r => r.handle),
            grade: main.grade,
            score: main.score,
            engagement_rate: parseFloat(main.engagementRate),
            posts_analyzed: main.postsAnalyzed + rivals.reduce((s, r) => s + r.postsAnalyzed, 0),
            snapshot_date: new Date().toISOString().slice(0, 10),
            ai_summary: ai?.executive_summary || null,
            ai_json: ai || null,
            report_json: payload
        }]).select('id').maybeSingle();

        res.status(200).json({ success: true, reportId: saved?.id || null, report: payload });
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
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Edgelead master engine active on port ${PORT}`));
