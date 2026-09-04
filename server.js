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
 *
 * FACEBOOK PAGE REPORT ENGINE (engine key: 'fb_page'):
 *   - Full business-Page audit: profile completeness, cadence, consistency,
 *     format mix, reaction sentiment, conversation and amplification rates,
 *     timing heatmap, copy patterns, hashtags, links, CTAs, video, momentum
 *   - Every post indexed against that Page's own monthly median, so pages of
 *     wildly different size are directly comparable
 *   - Optional head-to-head against ONE rival Page, with a per-metric winner
 *   - Page Score out of 100 with a visible pillar-by-pillar breakdown
 *   - Reports vault + re-runnable pairs for snapshot-to-snapshot drift
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

// ---------------------------------------------------------------------------
// RATE LIMITING  (in-memory, no extra dependency)
// Per-IP for unauthenticated surface, per-user for job starts. A single user
// should never be able to drain the shared key pool by hammering an endpoint.
// ---------------------------------------------------------------------------
const _buckets = new Map();

function rateLimit({ windowMs = 60000, max = 60, key = null } = {}) {
    return (req, res, next) => {
        const id = (key ? key(req) : null) || req.ip || 'anon';
        const now = Date.now();
        let b = _buckets.get(id);
        if (!b || now > b.reset) { b = { count: 0, reset: now + windowMs }; _buckets.set(id, b); }
        b.count += 1;
        if (b.count > max) {
            res.set('Retry-After', String(Math.ceil((b.reset - now) / 1000)));
            return res.status(429).json({
                error: 'Too many requests. Wait a moment and try again.',
                retryAfterSecs: Math.ceil((b.reset - now) / 1000)
            });
        }
        next();
    };
}

// Keep the map from growing without bound on a long-lived process.
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of _buckets) if (now > v.reset) _buckets.delete(k);
}, 300000).unref?.();

const bearerId = req => (req.headers.authorization || '').slice(-32) || null;

// Anything that spends money is gated harder than plain reads.
const spendLimit = rateLimit({ windowMs: 60000, max: 6,   key: bearerId });
const readLimit  = rateLimit({ windowMs: 60000, max: 240, key: bearerId });
app.use('/api/', readLimit);

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
const GEMINI_MODEL           = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MAX_COMPETITORS        = parseInt(process.env.MAX_COMPETITORS || '10', 10);
const DEFAULT_POSTS_PER_ACC  = parseInt(process.env.DEFAULT_POSTS_PER_ACCOUNT || '30', 10);
const MAX_POSTS_PER_ACC      = parseInt(process.env.MAX_POSTS_PER_ACCOUNT || '100', 10);
const ENGINES                = ['leadgen', 'report', 'fb_community', 'fb_page'];

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

// --- Apify run shaping ------------------------------------------------------
// Compute units are billed as RAM(GB) x hours, so memory is a direct cost lever.
// Leaving this unset used to inherit the actor default, which is often 4-8 GB.
const APIFY_MEMORY_MB    = parseInt(process.env.APIFY_MEMORY_MBYTES   || '2048', 10);
const APIFY_TIMEOUT_SECS = parseInt(process.env.APIFY_RUN_TIMEOUT_SECS || '900', 10);
// '' keeps the actor's own proxy default. Set to DATACENTER to avoid paying
// residential proxy rates ($8/GB on the free plan) where the target allows it.
const APIFY_PROXY_GROUP  = (process.env.APIFY_PROXY_GROUP || '').trim().toUpperCase();

// --- Budget ledger ----------------------------------------------------------
const APIFY_CYCLE_CREDIT = parseFloat(process.env.APIFY_MONTHLY_CREDIT_USD || '5');
// 'off'   - track only
// 'warn'  - track, expose remaining, never block
// 'block' - refuse to start a unit the current key cannot afford (recommended)
const BUDGET_MODE        = (process.env.BUDGET_MODE || 'block').toLowerCase();
const BUDGET_RESERVE     = parseFloat(process.env.BUDGET_RESERVE_USD || '0.05');

// --- Job engine -------------------------------------------------------------
const JOB_STALE_MINUTES  = parseInt(process.env.JOB_STALE_MINUTES || '15', 10);
const MAX_ACTIVE_JOBS    = parseInt(process.env.MAX_ACTIVE_JOBS_PER_USER || '2', 10);
// An 'exhausted' key is not dead, it is out of credit for this cycle. Retry it
// after this many hours so monthly credit renewal is picked up automatically.
const KEY_REVIVE_HOURS   = parseInt(process.env.KEY_REVIVE_HOURS || '12', 10);

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
    if (engine === 'fb_page')      return 'fb_page_apify_token';
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
    await reviveStaleKeys();
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
 * Apify free credit renews every billing cycle, so a key marked 'exhausted' is
 * only temporarily broke. Bring those back after KEY_REVIVE_HOURS. Keys marked
 * 'invalid' failed authentication and are left alone - only a manual recheck
 * revives those.
 */
async function reviveStaleKeys() {
    const cutoff = new Date(Date.now() - KEY_REVIVE_HOURS * 3600000).toISOString();
    try {
        await supabase.from('apify_keys')
            .update({ status: 'active', fail_count: 0 })
            .eq('status', 'exhausted')
            .lt('last_checked_at', cutoff);
    } catch (e) { console.error('[reviveStaleKeys]', e.message); }
}

/** Stable, non-reversible id for a token so usage can be tracked without
 *  storing the secret a second time. */
function tokenHash(token) {
    return require('crypto').createHash('sha256').update(String(token || '')).digest('hex').slice(0, 32);
}

function cycleMonth(d = new Date()) {
    return d.toISOString().slice(0, 7); // YYYY-MM
}

/** Thrown when every candidate key is dry. Distinct from a normal failure so
 *  the job engine can checkpoint and pause instead of dying. */
class NoCreditError extends Error {
    constructor(message, detail = {}) {
        super(message);
        this.name = 'NoCreditError';
        this.code = 'NO_CREDIT';
        Object.assign(this, detail);
    }
}

/**
 * Returns { client, candidate } for the first token that authenticates.
 * Dead / exhausted keys are flagged in the pool so they stop being retried.
 */
/** Classify a key failure so a flaky network does not permanently kill a
 *  perfectly good key. Only real auth rejections mark a key invalid. */
function classifyKeyError(err) {
    const msg = (err?.message || '').toLowerCase();
    const status = err?.statusCode || err?.status || 0;
    if (status === 401 || status === 403 ||
        msg.includes('unauthor') || msg.includes('forbidden') ||
        msg.includes('invalid token') || msg.includes('authentication')) return 'invalid';
    if (status === 402 || msg.includes('credit') || msg.includes('limit exceeded') ||
        msg.includes('usage limit') || msg.includes('quota')) return 'exhausted';
    return 'transient';   // timeout, ECONNRESET, 5xx - do not punish the key
}

/**
 * Returns { client, candidate } for the first token that authenticates AND has
 * enough remaining cycle budget for `needUsd`.
 *
 * The client is tagged with __el so every downstream actor call can attribute
 * its spend back to the exact key that paid for it.
 */
async function getWorkingClient(engine, userId, opts = {}) {
    const needUsd = Number(opts.needUsd || 0);
    const jobId   = opts.jobId || null;

    const candidates = await buildTokenCandidates(engine, userId);
    if (!candidates.length) {
        throw new NoCreditError('No Apify key configured for this engine. Use "Update key" in the header to add one.');
    }

    let lastErr = null;
    const skipped = [];

    for (const c of candidates) {
        const hash = tokenHash(c.token);

        // Budget gate BEFORE spending anything. This is what turns a mid-run
        // blowup into a clean, resumable pause.
        if (BUDGET_MODE === 'block' && needUsd > 0) {
            const spent = await cycleUsage(hash);
            const remaining = APIFY_CYCLE_CREDIT - spent - BUDGET_RESERVE;
            if (remaining < needUsd) {
                skipped.push({ source: c.source, remaining: +remaining.toFixed(4) });
                await markKey(c.id, { status: 'exhausted', last_checked_at: new Date().toISOString() });
                continue;
            }
        }

        try {
            const client = new ApifyClient({ token: c.token });
            const u = await client.user().get();

            await markKey(c.id, {
                last_used_at: new Date().toISOString(),
                last_checked_at: new Date().toISOString(),
                apify_username: u.username,
                status: 'active',
                fail_count: 0
            });

            const spent = await cycleUsage(hash);
            client.__el = {
                keyId: c.id || null,
                source: c.source,
                tokenHash: hash,
                apifyUsername: u.username,
                engine, userId, jobId,
                spentThisCycle: spent,
                remaining: +(APIFY_CYCLE_CREDIT - spent).toFixed(4)
            };

            return { client, candidate: c, apifyUsername: u.username, budget: client.__el };
        } catch (err) {
            lastErr = err;
            const kind = classifyKeyError(err);
            if (kind !== 'transient') {
                await markKey(c.id, { status: kind, last_checked_at: new Date().toISOString() });
            } else {
                await markKey(c.id, { last_checked_at: new Date().toISOString() });
            }
            console.error(`[key ${c.source} -> ${kind}]`, err.message);
        }
    }

    const detail = skipped.length
        ? ` ${skipped.length} key(s) are out of credit for this cycle.`
        : '';
    throw new NoCreditError(
        `No Apify key can cover this run.${detail} Add or update a key, then resume.`,
        { skipped, lastError: lastErr?.message || null }
    );
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

// ===========================================================================
// USAGE LEDGER
// Every actor run reports what it actually cost. Recording that is what turns
// key rotation from reactive (wait for a failure) into predictive (know the
// budget before spending it).
// ===========================================================================

/** Total USD spent by one key in the current billing cycle. */
async function cycleUsage(hash, month = cycleMonth()) {
    if (!hash) return 0;
    try {
        const { data } = await supabase
            .from('apify_usage_events')
            .select('usage_usd')
            .eq('token_hash', hash)
            .eq('cycle_month', month);
        return (data || []).reduce((sum, r) => sum + Number(r.usage_usd || 0), 0);
    } catch (e) {
        console.error('[cycleUsage]', e.message);
        return 0;   // fail open: never block a run because the ledger is down
    }
}

async function recordUsage(client, { actorId, run, items = 0, jobId = null }) {
    const el = client?.__el;
    if (!el) return 0;

    const usd =
        Number(run?.usageTotalUsd) ||
        Number(run?.usage?.USD) ||
        0;

    try {
        await supabase.from('apify_usage_events').insert([{
            user_id:        el.userId || null,
            key_id:         el.keyId || null,
            token_hash:     el.tokenHash,
            apify_username: el.apifyUsername || null,
            engine:         el.engine || null,
            job_id:         jobId || el.jobId || null,
            actor_id:       actorId,
            run_id:         run?.id || null,
            usage_usd:      usd,
            compute_units:  Number(run?.stats?.computeUnits) || null,
            items,
            cycle_month:    cycleMonth()
        }]);
    } catch (e) { console.error('[recordUsage]', e.message); }

    el.spentThisCycle = Number(el.spentThisCycle || 0) + usd;
    el.remaining = +(APIFY_CYCLE_CREDIT - el.spentThisCycle).toFixed(4);
    return usd;
}

/** Remaining cycle budget for the key currently bound to this client. */
function clientRemaining(client) {
    const el = client?.__el;
    if (!el) return Infinity;
    return APIFY_CYCLE_CREDIT - Number(el.spentThisCycle || 0) - BUDGET_RESERVE;
}

/**
 * Single entry point for every Apify actor run.
 *
 *   - pins memory (compute units are RAM x hours, so this is a cost lever)
 *   - pins a wall-clock timeout so a stuck run cannot burn credit forever
 *   - optionally forces a cheaper proxy group
 *   - records real spend to the ledger
 *   - refuses to start when the bound key cannot afford the estimate
 */
async function callActor(client, actorId, input, opts = {}) {
    const estimate = Number(opts.estimateUsd || 0);

    if (BUDGET_MODE === 'block' && estimate > 0 && clientRemaining(client) < estimate) {
        throw new NoCreditError(
            `Key ${client?.__el?.apifyUsername || ''} has about ` +
            `$${Math.max(0, clientRemaining(client)).toFixed(2)} left this cycle, ` +
            `this step needs about $${estimate.toFixed(2)}.`
        );
    }

    const payload = { ...input };
    if (APIFY_PROXY_GROUP && !payload.proxyConfiguration) {
        payload.proxyConfiguration = {
            useApifyProxy: true,
            apifyProxyGroups: [APIFY_PROXY_GROUP]
        };
    }

    const runOpts = {
        memory:  opts.memoryMb   || APIFY_MEMORY_MB,
        timeout: opts.timeoutSecs || APIFY_TIMEOUT_SECS
    };
    if (opts.waitSecs) runOpts.waitSecs = opts.waitSecs;
    if (opts.maxItems) runOpts.maxItems = opts.maxItems;

    let run;
    try {
        run = await client.actor(actorId).call(payload, runOpts);
    } catch (err) {
        // Older apify-client builds validate run options strictly. If the
        // options are what it rejected, fall back to a bare call rather than
        // failing the whole job.
        const m = (err.message || '').toLowerCase();
        if (m.includes('expected property') || m.includes('did not match') || m.includes('validation')) {
            console.warn('[callActor] run options rejected, retrying bare:', err.message);
            run = await client.actor(actorId).call(payload);
        } else {
            throw err;
        }
    }

    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    const rows = items || [];

    const usd = await recordUsage(client, { actorId, run, items: rows.length, jobId: opts.jobId });
    console.log(`[Apify] ${actorId} :: ${rows.length} items :: $${usd.toFixed(4)} :: ` +
                `${client?.__el?.apifyUsername || 'unknown'}`);

    return { run, items: rows, usd };
}

async function runActor(actorId, input, warningsArray, methodName, client) {
    try {
        console.log(`[Apify] ${actorId} :: ${methodName}`);
        const { items } = await callActor(client, actorId, input);
        const extracted = extractPosts(items || []);
        if (warningsArray) warningsArray.push(`X-RAY (${methodName}): Extracted ${extracted.length} real posts.`);
        return extracted;
    } catch (err) {
        if (err.code === 'NO_CREDIT') throw err;      // must bubble up to pause the job
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

/**
 * Single Gemini entry point with backoff.
 *
 * Volume is never the problem here - one report makes one or two calls, far
 * under any free-tier daily cap. The real failure mode is a burst 429 when a
 * job fires several calls back to back, which previously returned null and
 * silently dropped the whole narrative layer.
 */
async function geminiCall(prompt, { temperature = 0.5, maxOutputTokens = 4096, tag = 'gemini', retries = 3 } = {}) {
    if (!GEMINI_API_KEY) return null;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const body = JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature, maxOutputTokens, responseMimeType: 'application/json' }
    });

    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const r = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body
            });

            if (r.status === 429 || r.status >= 500) {
                const waitMs = Math.min(2000 * Math.pow(2, attempt), 15000);
                console.warn(`[${tag}] ${r.status}, retrying in ${waitMs}ms (${attempt + 1}/${retries})`);
                await new Promise(res => setTimeout(res, waitMs));
                continue;
            }

            if (!r.ok) { console.error(`[${tag}]`, r.status, (await r.text()).slice(0, 400)); return null; }

            const data = await r.json();
            const text = data?.candidates?.[0]?.content?.parts?.map(x => x.text).join('') || '';
            if (!text) return null;
            return JSON.parse(text.replace(/```json|```/g, '').trim());
        } catch (err) {
            const waitMs = Math.min(2000 * Math.pow(2, attempt), 15000);
            console.error(`[${tag} error]`, err.message);
            if (attempt === retries - 1) return null;
            await new Promise(res => setTimeout(res, waitMs));
        }
    }
    return null;
}

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

    return geminiCall(prompt, { temperature: 0.4, maxOutputTokens: 4096, tag: 'Gemini IG' });
}

// ===========================================================================
// JOB ENGINE
// ===========================================================================

async function createJob(userId, type, engine, input, creditsEstimate) {
    const { data, error } = await supabase.from('jobs').insert([{
        user_id: userId, type, engine, input,
        credits_estimate: creditsEstimate || null,
        status: 'queued', progress: 0, log: [],
        completed_units: []
    }]).select().single();
    if (error) throw error;
    return data;
}

/** Refuse to queue a fifth thing while four are already spending money. */
async function assertJobSlot(userId) {
    const { count } = await supabase.from('jobs')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .in('status', ['queued', 'running']);
    if ((count || 0) >= MAX_ACTIVE_JOBS) {
        const err = new Error(
            `You already have ${count} job(s) running. Wait for them to finish before starting another.`
        );
        err.statusCode = 429;
        throw err;
    }
}

/**
 * Record a finished unit AND the analysis it produced.
 *
 * Storing the computed result, not just the unit name, is what makes resume
 * actually free. The scraped rows are already in `posts` / `fb_posts`, but the
 * audit object also needs profile-level numbers that are not reconstructable
 * from the post rows alone. Persisting it here means a resumed job never has to
 * re-scrape, and therefore never pays twice.
 */
async function savePartial(jobId, unit, value) {
    if (!jobId || !unit) return;
    try {
        const { data } = await supabase.from('jobs')
            .select('completed_units, partials').eq('id', jobId).maybeSingle();
        const done = Array.isArray(data?.completed_units) ? data.completed_units : [];
        const partials = (data?.partials && typeof data.partials === 'object') ? data.partials : {};
        const key = String(unit);
        if (!done.includes(key)) done.push(key);
        if (value !== undefined) partials[key] = value;
        await supabase.from('jobs')
            .update({ completed_units: done, partials, updated_at: new Date().toISOString() })
            .eq('id', jobId);
    } catch (e) { console.error('[savePartial]', e.message); }
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

/**
 * Fire-and-forget runner. Never awaited by the request handler.
 *
 * The worker receives (progress, ck) where ck is the checkpoint helper:
 *   ck.isDone(unit)  - was this unit already scraped in an earlier attempt?
 *   ck.done(unit)    - record a unit as finished and paid for
 *   ck.units         - the raw completed list
 *
 * When every key runs dry the job does NOT fail. It parks in
 * 'paused_no_credit' with its checkpoint intact, so updating a key and calling
 * /api/job/:id/resume picks up exactly where it stopped and never pays twice
 * for work already in the database.
 */
function runJob(jobId, worker, opts = {}) {
    (async () => {
        try {
            const { data: row } = await supabase.from('jobs')
                .select('completed_units, partials').eq('id', jobId).maybeSingle();
            const units = Array.isArray(row?.completed_units) ? row.completed_units.slice() : [];
            const partials = (row?.partials && typeof row.partials === 'object') ? { ...row.partials } : {};

            const ck = {
                units, partials,
                isDone: u => units.includes(String(u)),
                get:    u => partials[String(u)],
                done: async (u, value) => {
                    const key = String(u);
                    if (!units.includes(key)) units.push(key);
                    if (value !== undefined) partials[key] = value;
                    await savePartial(jobId, key, value);
                }
            };

            await updateJob(jobId,
                { status: 'running', progress: opts.resume ? undefined : 1, error: null },
                opts.resume ? `Resuming, ${units.length} unit(s) already complete` : 'Job started');

            const result = await worker(
                (progress, step) => updateJob(jobId, { progress, current_step: step }, step),
                ck
            );

            await updateJob(jobId, {
                status: 'done', progress: 100,
                result, result_report_id: result?.reportId || null,
                finished_at: new Date().toISOString()
            }, 'Job complete');
        } catch (err) {
            if (err && err.code === 'NO_CREDIT') {
                console.warn('[Job paused: no credit]', jobId, err.message);
                await updateJob(jobId, {
                    status: 'paused_no_credit',
                    error: err.message
                }, 'Paused: ' + err.message);
                return;
            }
            console.error('[Job failed]', jobId, err.message);
            await updateJob(jobId, {
                status: 'failed', error: err.message,
                finished_at: new Date().toISOString()
            }, 'Failed: ' + err.message);
        }
    })();
}

// ---------------------------------------------------------------------------
// WORKER REGISTRY
// Jobs run in-process. Render spins the free tier down on idle and restarts on
// every deploy, so a worker has to be rebuildable from jobs.input alone in
// order for resume to survive a restart.
// ---------------------------------------------------------------------------
const JOB_WORKERS = {};
function registerWorker(type, factory) { JOB_WORKERS[type] = factory; }

/**
 * Anything left 'running' with no heartbeat is orphaned by a restart. Park it
 * so the UI stops spinning and the user can resume it by hand.
 */
async function sweepStaleJobs() {
    const cutoff = new Date(Date.now() - JOB_STALE_MINUTES * 60000).toISOString();
    try {
        const { data } = await supabase.from('jobs')
            .select('id, type, completed_units')
            .in('status', ['running', 'queued'])
            .lt('updated_at', cutoff);

        for (const j of (data || [])) {
            const n = Array.isArray(j.completed_units) ? j.completed_units.length : 0;
            await updateJob(j.id, {
                status: 'interrupted',
                error: 'The server restarted while this job was running. ' +
                       (n ? `${n} unit(s) were already saved — resume to finish the rest.`
                          : 'Nothing was charged. Resume to start again.')
            }, 'Interrupted by a server restart');
        }
        if (data?.length) console.log(`[sweepStaleJobs] parked ${data.length} orphaned job(s)`);
    } catch (e) { console.error('[sweepStaleJobs]', e.message); }
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

    const limit = Math.min(postsLimit || DEFAULT_POSTS_PER_ACC, MAX_POSTS_PER_ACC);

    const { items: profiles } = await callActor(client, 'apify/instagram-profile-scraper',
        { usernames: [h] },
        { estimateUsd: COST_PER_1K_PROFILE / 1000, jobId: meta.jobId });
    const prof = profiles[0] || {};

    const { items: rawPosts } = await callActor(client, 'apify/instagram-scraper', {
        directUrls: [`https://www.instagram.com/${h}/`],
        resultsType: 'posts',
        resultsLimit: limit,
        addParentData: false
    }, { estimateUsd: (limit / 1000) * COST_PER_1K_POSTS, maxItems: limit, jobId: meta.jobId });
    const posts = extractPosts(rawPosts || []);

    await savePosts(userId, h, posts, meta);
    return computeAudit(h, prof, posts);
}

// ===========================================================================
// SYSTEM / KEY MANAGEMENT ENDPOINTS
// ===========================================================================

// ===========================================================================
// JOB WORKERS
// Registered at module scope and rebuildable from jobs.input alone, which
// is what lets /api/job/:id/resume pick a paused job back up after a key
// change or a server restart.
// ===========================================================================

registerWorker('ig_report', (userId, input, jobId) => async (progress, ck) => {

    const cleanTarget  = String(input.target || '');
    const rivals       = Array.isArray(input.rivals) ? input.rivals : [];
    const limit        = input.postsPerAccount || DEFAULT_POSTS_PER_ACC;
    const accounts     = rivals.length + 1;
    const estimate     = estimateCredits(accounts, limit);
    const perAccount   = estimateCredits(1, limit);

            const step = Math.floor(80 / accounts);
            const warnings = [];

            // The key is resolved per account, not once for the whole job. When
            // the current key runs dry mid-run the next account simply picks up
            // the next key in the chain, and the user never notices.
            const grab = () => getWorkingClient('report', userId, { needUsd: perAccount, jobId })
                .then(r => r.client);

            let main = ck.get(cleanTarget);
            if (main) {
                await progress(5, `@${cleanTarget} already analysed — reusing saved data`);
            } else {
                await progress(5, `Auditing target @${cleanTarget}`);
                main = await auditHandle(await grab(), userId, cleanTarget, limit, { jobId });
                if (!main) throw new Error('Target profile could not be scraped.');
                await ck.done(cleanTarget, main);
            }

            const rivalAudits = [];
            for (let i = 0; i < rivals.length; i++) {
                const cached = ck.get(rivals[i]);
                if (cached) { rivalAudits.push(cached); continue; }

                await progress(5 + step * (i + 1), `Auditing rival @${rivals[i]} (${i + 1}/${rivals.length})`);
                try {
                    const a = await auditHandle(await grab(), userId, rivals[i], limit, { jobId });
                    if (a) { rivalAudits.push(a); await ck.done(rivals[i], a); }
                } catch (e) {
                    if (e.code === 'NO_CREDIT') throw e;   // pause cleanly, keep the checkpoint
                    console.error('[rival failed]', rivals[i], e.message);
                    warnings.push(`@${rivals[i]} could not be analysed: ${e.message}`);
                }
            }

            await progress(88, 'Building benchmark');
            const benchmark = rivalAudits.length ? buildBenchmark(main, rivalAudits) : null;
            const recommendations = ruleRecommendations(main);

            await progress(92, 'Generating AI narrative');
            const ai = await geminiNarrative({ target: main, rivals: rivalAudits, benchmark });

            const payload = { main, rivals: rivalAudits, recommendations, benchmark, ai, warnings };
            const postsAnalyzed = main.postsAnalyzed + rivalAudits.reduce((s, r) => s + r.postsAnalyzed, 0);

            await progress(96, 'Saving report');
            const { data: saved } = await supabase.from('reports').insert([{
                user_id: userId,
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

registerWorker('deep_audit', (userId, input, jobId) => async (progress, ck) => {

    const cleanTarget  = String(input.target || '');
    const rivals       = Array.isArray(input.competitors) ? input.competitors : [];
    const limit        = input.postsPerAccount || DEFAULT_POSTS_PER_ACC;
    const activeSetId  = input.setId || null;
    const accounts     = rivals.length + 1;
    const estimate     = estimateCredits(accounts, limit);
    const perAccount   = estimateCredits(1, limit);

            const meta = { setId: activeSetId, jobId };
            const step = Math.floor(80 / accounts);
            const warnings = [];

            const grab = () => getWorkingClient('report', userId, { needUsd: perAccount, jobId })
                .then(r => r.client);

            let main = ck.get(cleanTarget);
            if (main) {
                await progress(5, `@${cleanTarget} already analysed — reusing saved data`);
            } else {
                await progress(5, `Auditing target @${cleanTarget}`);
                main = await auditHandle(await grab(), userId, cleanTarget, limit, meta);
                if (!main) throw new Error('Target profile could not be scraped.');
                await ck.done(cleanTarget, main);
            }

            const rivalAudits = [];
            for (let i = 0; i < rivals.length; i++) {
                const cached = ck.get(rivals[i]);
                if (cached) { rivalAudits.push(cached); continue; }

                await progress(5 + step * (i + 1), `Auditing competitor @${rivals[i]} (${i + 1}/${rivals.length})`);
                try {
                    const a = await auditHandle(await grab(), userId, rivals[i], limit, meta);
                    if (a) { rivalAudits.push(a); await ck.done(rivals[i], a); }
                } catch (e) {
                    if (e.code === 'NO_CREDIT') throw e;
                    console.error('[competitor failed]', rivals[i], e.message);
                    warnings.push(`@${rivals[i]} could not be analysed: ${e.message}`);
                }
            }

            await progress(88, 'Building benchmark');
            const benchmark = buildBenchmark(main, rivalAudits);
            const recommendations = ruleRecommendations(main);

            await progress(92, 'Generating AI strategy');
            const ai = await geminiNarrative({ target: main, rivals: rivalAudits, benchmark });

            const payload = { main, rivals: rivalAudits, benchmark, recommendations, ai, warnings };
            const postsAnalyzed = main.postsAnalyzed + rivalAudits.reduce((s, r) => s + r.postsAnalyzed, 0);

            await progress(96, 'Saving report');
            const { data: saved } = await supabase.from('reports').insert([{
                user_id: userId,
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

registerWorker('fb_community_audit', (userId, input, jobId) => async (progress, ck) => {

    const refs = (input.groups || []).map(id => ({
        groupId: String(id),
        url: `https://www.facebook.com/groups/${id}/`,
        rowId: null,
        name: String(id)
    }));
    const auditMode      = input.mode === 'individual' ? 'individual' : 'combined';
    const limit          = input.postsPerGroup || FB_DEFAULT_POSTS;
    const window         = input.days || FB_DEFAULT_DAYS;
    const sampleComments = !!input.sampleComments;
    const activeSetId    = input.setId || null;
    const niche          = input.niche || null;
    const location       = input.location || null;
    const since          = input.since || null;
    const estimate       = fbEstimateCredits(refs.length, limit, sampleComments);
    const perGroup       = fbEstimateCredits(1, limit, sampleComments);

            const step = Math.floor(65 / refs.length);
            const audits = [];
            const allDemand = [];
            let totalPosts = 0;

            for (let i = 0; i < refs.length; i++) {
                // Already scraped and paid for on an earlier attempt.
                const cached = ck.get(refs[i].groupId);
                if (cached) {
                    audits.push(cached);
                    totalPosts += cached.postsAnalyzed || 0;
                    await progress(5 + step * (i + 1),
                        `${cached.name} already measured — reusing saved data`);
                    continue;
                }

                await progress(5 + step * i, `Scraping ${refs[i].name || refs[i].groupId} (${i + 1}/${refs.length})`);
                try {
                    // Fresh key per group. This is the single most important
                    // change for a $5 budget: one group exhausting a key no
                    // longer kills the whole run.
                    const { client } = await getWorkingClient('fb_community', userId,
                        { needUsd: perGroup, jobId });

                    const { meta, rows, demand } = await fbProcessGroup(client, userId, refs[i], {
                        limit, days: window, sampleComments, niche, location,
                        source: 'audit', since, jobId
                    });

                    if (!rows.length) {
                        await progress(5 + step * (i + 1), `${meta.name}: no public posts returned — likely private`);
                        const empty = computeGroupAudit(meta, [], []);
                        audits.push(empty);
                        await ck.done(refs[i].groupId, empty);   // the run was billed either way
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
                    }).eq('user_id', userId).eq('group_id', meta.group_id);

                    await ck.done(refs[i].groupId, audit);

                    await progress(5 + step * (i + 1),
                        `${meta.name}: ${rows.length} posts, ${demand.length} demand signals, Room Value ${audit.roomValue}`);
                } catch (e) {
                    if (e.code === 'NO_CREDIT') {
                        // Everything measured so far is checkpointed. Park the
                        // job rather than throwing the partial work away.
                        await progress(5 + step * i,
                            `Out of Apify credit after ${audits.length}/${refs.length} rooms. Update a key and resume.`);
                        throw e;
                    }
                    await progress(5 + step * (i + 1), `Failed on ${refs[i].groupId}: ${e.message}`);
                }
            }

            // Demand rows for groups reused from a checkpoint are already in
            // fb_demand_signals rather than in allDemand, so count from the
            // audits instead of from this run's in-memory array.
            const totalDemand = audits.reduce((sum, a) => sum + (a.demandSignals || 0), 0);

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
                        user_id: userId,
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
                            .eq('user_id', userId).eq('group_id', a.groupId).is('report_id', null);
                        await supabase.from('fb_demand_signals').update({ report_id: saved.id })
                            .eq('user_id', userId).eq('group_id', a.groupId).is('report_id', null);
                    }
                    reports.push({ reportId: saved?.id || null, groupId: a.groupId, name: a.name, roomValue: a.roomValue, postsAnalyzed: a.postsAnalyzed, demandSignals: a.demandSignals });
                }

                if (activeSetId) await supabase.from('fb_group_sets').update({ last_run_at: new Date().toISOString() }).eq('id', activeSetId);

                return {
                    mode: 'individual', setId: activeSetId,
                    reports, postsAnalyzed: totalPosts, demandSignals: totalDemand,
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
                user_id: userId,
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
                    .eq('user_id', userId).in('group_id', ids).is('report_id', null);
                await supabase.from('fb_demand_signals').update({ report_id: saved.id })
                    .eq('user_id', userId).in('group_id', ids).is('report_id', null);
            }
            if (activeSetId) await supabase.from('fb_group_sets').update({ last_run_at: new Date().toISOString() }).eq('id', activeSetId);

            return {
                mode: 'combined', reportId: saved?.id || null, setId: activeSetId,
                postsAnalyzed: totalPosts, demandSignals: totalDemand, report: payload
            };
        });

registerWorker('fb_page_report', (userId, input, jobId) => async (progress, ck) => {

    const targetRef      = parsePageRef(input.target);
    const rivalRef       = input.rival ? parsePageRef(input.rival) : null;
    const limit          = input.postsPerPage || FB_PAGE_DEFAULT_POSTS;
    const window         = input.days || FB_PAGE_DEFAULT_DAYS;
    const includeReviews = !!input.includeReviews;
    const activeSetId    = input.setId || null;
    const brief          = input.brief || null;
    const since          = input.since || null;
    const estimate       = fbPageEstimateCredits(rivalRef ? 2 : 1, limit, includeReviews);
    const perPage        = fbPageEstimateCredits(1, limit, includeReviews);

            const grab = () => getWorkingClient('fb_page', userId, { needUsd: perPage, jobId })
                .then(r => r.client);

            let main = ck.get(targetRef.pageId);
            if (main) {
                await progress(6, `${main.name} already analysed — reusing saved data`);
            } else {
                await progress(6, `Reading the Page profile for ${targetRef.pageId}`);
                const r = await fbAuditPage(await grab(), userId, targetRef, {
                    limit, days: window, includeReviews, since, jobId
                });
                main = r.audit;
                if (!main) throw new Error('The target Page could not be read.');
                await ck.done(targetRef.pageId, main);
            }

            await progress(rivalRef ? 42 : 62,
                `${main.name}: ${main.postsAnalyzed} posts analysed, page score ${main.score}`);

            let rivalAudit = null;
            if (rivalRef) {
                rivalAudit = ck.get(rivalRef.pageId) || null;
                if (rivalAudit) {
                    await progress(70, `${rivalAudit.name} already analysed — reusing saved data`);
                } else {
                    await progress(48, `Reading the rival Page ${rivalRef.pageId}`);
                    try {
                        const r = await fbAuditPage(await grab(), userId, rivalRef, {
                            limit, days: window, includeReviews, since, jobId
                        });
                        rivalAudit = r.audit;
                        await ck.done(rivalRef.pageId, rivalAudit);
                        await progress(70, `${rivalAudit.name}: ${rivalAudit.postsAnalyzed} posts analysed, page score ${rivalAudit.score}`);
                    } catch (e) {
                        if (e.code === 'NO_CREDIT') throw e;
                        await progress(70, `Rival failed: ${e.message}. Continuing with a single-page report.`);
                    }
                }
            }

            if (!main.postsAnalyzed && !(rivalAudit && rivalAudit.postsAnalyzed)) {
                throw new Error('No public posts were returned. Public Pages only — confirm the URL points at a Facebook Page rather than a personal profile or a group.');
            }

            await progress(78, 'Building the head-to-head comparison');
            const benchmark = buildPageBenchmark(main, rivalAudit);

            await progress(82, 'Assembling recommendations');
            const recommendations = fbPageRecommendations(main, benchmark);

            await progress(88, 'Writing the AI strategy layer');
            const ai = await fbPageNarrative({
                target: main, rival: rivalAudit, benchmark,
                brief: brief ? String(brief).slice(0, 600) : null
            });

            const payload = {
                mode: rivalAudit ? 'versus' : 'single',
                generatedAt: new Date().toISOString(),
                windowDays: window,
                target: main, rival: rivalAudit, benchmark, recommendations, ai,
                brief: brief || null
            };

            const postsAnalyzed = main.postsAnalyzed + (rivalAudit?.postsAnalyzed || 0);

            await progress(95, 'Saving report to the vault');
            const { data: saved } = await supabase.from('reports').insert([{
                user_id: userId,
                platform: 'facebook',
                report_type: 'fb_page',
                audit_mode: rivalAudit ? 'versus' : 'single',
                set_id: activeSetId,
                target_handle: main.name || main.pageId,
                competitor_handles: rivalAudit ? [rivalAudit.name || rivalAudit.pageId] : [],
                fb_page_ids: rivalAudit ? [main.pageId, rivalAudit.pageId] : [main.pageId],
                fb_page_names: rivalAudit ? [main.name, rivalAudit.name] : [main.name],
                grade: main.grade,
                score: main.score,
                engagement_rate: main.engagementRate,
                posts_analyzed: postsAnalyzed,
                snapshot_date: new Date().toISOString().slice(0, 10),
                credits_estimate: estimate,
                ai_summary: ai?.executive_summary || null,
                ai_json: ai || null,
                report_json: payload
            }]).select('id').maybeSingle();

            if (saved?.id) {
                const ids = rivalAudit ? [main.pageId, rivalAudit.pageId] : [main.pageId];
                await supabase.from('fb_page_posts').update({ report_id: saved.id })
                    .eq('user_id', userId).in('page_id', ids).is('report_id', null);
            }
            if (activeSetId) {
                await supabase.from('fb_page_sets')
                    .update({ last_run_at: new Date().toISOString() }).eq('id', activeSetId);
            }

            return {
                reportId: saved?.id || null, setId: activeSetId,
                mode: payload.mode, postsAnalyzed, report: payload
            };
        });

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
            // Demote the outgoing primary into the global pool instead of
            // discarding it. Apify credit renews monthly, so a key that is dry
            // today is worth $5 again in a few weeks — throwing it away leaks
            // budget every single rotation.
            const previous = await getEnginePrimary(activeEngine);
            if (previous && previous !== newApiKey) {
                try {
                    await supabase.from('apify_keys').upsert({
                        owner_user_id: null,
                        engine: activeEngine,
                        token: previous,
                        label: `demoted primary (${activeEngine})`,
                        status: 'exhausted',
                        fail_count: 0,
                        last_checked_at: new Date().toISOString()
                    }, { onConflict: 'token' });
                } catch (e) { console.error('[demote primary]', e.message); }
            }

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

        const eng = [...ENGINES, 'any'].includes(engine) ? engine : 'any';
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

app.post('/api/run-campaign', spendLimit, async (req, res) => {
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
                    const { items } = await callActor(client, 'apify/instagram-search-scraper',
                        { searchQueries: [kw], searchType: 'user' });
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

app.post('/api/enrich-campaign', spendLimit, async (req, res) => {
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
        const { items: profiles } = await callActor(client, 'apify/instagram-profile-scraper',
            { usernames: handles },
            { waitSecs: 25, estimateUsd: (handles.length / 1000) * COST_PER_1K_PROFILE });

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

app.post('/api/generate-ig-report', spendLimit, async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'report'); if (!ctx) return;
        await assertJobSlot(ctx.user.id);
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

        runJob(job.id, JOB_WORKERS['ig_report'](ctx.user.id, job.input, job.id));

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

app.post('/api/deep-audit', spendLimit, async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'report'); if (!ctx) return;
        await assertJobSlot(ctx.user.id);

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

        runJob(job.id, JOB_WORKERS['deep_audit'](ctx.user.id, job.input, job.id));

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

/**
 * Resume a job that paused for credit or was interrupted by a restart.
 *
 * Units already in `completed_units` are skipped and their saved analysis is
 * reused, so nothing that has already been paid for is scraped a second time.
 */
app.post('/api/job/:id/resume', spendLimit, async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;

        const { data: job } = await supabase.from('jobs')
            .select('*').eq('id', req.params.id).eq('user_id', ctx.user.id).maybeSingle();
        if (!job) return res.status(404).json({ error: 'Job not found.' });

        if (!['paused_no_credit', 'interrupted', 'failed'].includes(job.status)) {
            return res.status(409).json({
                error: `This job is ${job.status} and cannot be resumed.`
            });
        }

        const factory = JOB_WORKERS[job.type];
        if (!factory) {
            return res.status(400).json({
                error: `"${job.type}" jobs cannot be resumed. Start a new run instead.`
            });
        }

        // Confirm there is now a key that can actually pay, so the user gets an
        // immediate answer instead of watching the job pause again.
        const perUnit = Number(job.credits_estimate || 0) /
                        Math.max(1, (job.input?.groups?.length || job.input?.competitors?.length || 1));
        try {
            await getWorkingClient(job.engine, ctx.user.id, { needUsd: perUnit, jobId: job.id });
        } catch (e) {
            return res.status(402).json({
                error: e.message,
                code: 'NO_CREDIT',
                completed: (job.completed_units || []).length
            });
        }

        await assertJobSlot(ctx.user.id);
        runJob(job.id, factory(ctx.user.id, job.input, job.id), { resume: true });

        res.status(202).json({
            success: true,
            jobId: job.id,
            resumedFrom: (job.completed_units || []).length,
            note: 'Already-completed units will be reused, not re-scraped.'
        });
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message });
    }
});

/**
 * What the user actually wants to see before pressing Run: how much of the
 * cycle credit is left on each key they can draw from.
 */
app.get('/api/budget', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const engine = ENGINES.includes(req.query.engine) ? req.query.engine : 'leadgen';

        const candidates = await buildTokenCandidates(engine, ctx.user.id);
        const month = cycleMonth();
        const keys = [];
        let total = 0;

        for (const c of candidates) {
            const hash = tokenHash(c.token);
            const spent = await cycleUsage(hash, month);
            const remaining = Math.max(0, APIFY_CYCLE_CREDIT - spent);
            total += remaining;
            keys.push({
                source: c.source,
                label: c.source === 'user_pool' ? 'Your key'
                     : c.source === 'engine_primary' ? 'Shared primary'
                     : c.source === 'global_pool' ? 'Shared pool'
                     : 'Server fallback',
                spentUsd: +spent.toFixed(4),
                remainingUsd: +remaining.toFixed(4)
            });
        }

        res.json({
            engine, cycleMonth: month,
            creditPerKeyUsd: APIFY_CYCLE_CREDIT,
            keys,
            totalRemainingUsd: +total.toFixed(4),
            mode: BUDGET_MODE
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

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

    // The window boundary is frozen at job creation and passed in. Recomputing
    // it from Date.now() would mean a job paused Monday and resumed Thursday
    // measures its groups over different periods, which silently corrupts every
    // cross-group comparison in the benchmark.
    const onlyPostsNewerThan = opts.since ||
        new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

    const { items } = await callActor(client, FB_GROUP_POSTS_ACTOR, {
        startUrls: [{ url }],
        resultsLimit: limit,
        maxPosts: limit,
        onlyPostsNewerThan,
        commentsMode: 'RANKED_THREADED',
        maxComments: opts.sampleComments ? 10 : 0,
        scrapeComments: !!opts.sampleComments
    }, {
        maxItems: limit,
        jobId: opts.jobId,
        estimateUsd: fbEstimateCredits(1, limit, opts.sampleComments)
    });

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
    return geminiCall(prompt, { temperature, maxOutputTokens: maxTokens, tag: 'Gemini FB' });
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
app.post('/api/fb/discover-groups', spendLimit, async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        await assertJobSlot(ctx.user.id);

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
                        const { items } = await callActor(client, FB_SEARCH_ACTOR, {
                            search: q, searchType: 'groups', query: q,
                            resultsLimit: 25, maxResults: 25
                        }, { maxItems: 25 });
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

app.post('/api/fb/audit-community', spendLimit, async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        await assertJobSlot(ctx.user.id);

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

        // Freeze the window boundary now. A job paused today and resumed next
        // week must measure every room over the same period or the benchmark
        // silently compares unlike things.
        const since = new Date(Date.now() - window * 86400000).toISOString().slice(0, 10);

        const job = await createJob(ctx.user.id, 'fb_community_audit', 'fb_community', {
            groups: refs.map(r => r.groupId), mode: auditMode,
            days: window, postsPerGroup: limit, sampleComments, setId: activeSetId,
            niche: niche || null, location: location || null, since
        }, estimate);

        runJob(job.id, JOB_WORKERS['fb_community_audit'](ctx.user.id, job.input, job.id));

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

app.post('/api/fb/suggest-posts', spendLimit, async (req, res) => {
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
        await assertJobSlot(ctx.user.id);

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
// ===========================================================================
//  FACEBOOK PAGE REPORT ENGINE
//  Engine key: 'fb_page'.  Job type: 'fb_page_report'.
//
//  This is the Facebook mirror of the Instagram deep audit: it reports on a
//  BUSINESS PAGE, not a group. One target page, optionally one rival page,
//  every dimension the public payload will give us — profile completeness,
//  cadence, format mix, reaction sentiment, conversation rate, amplification,
//  timing, copy patterns, hashtags, links, CTAs, video, momentum — each post
//  indexed against that page's OWN median so a 900-follower page and a
//  900k-follower page can be read on the same scale.
//
//  Reuses the existing jobs table, /api/job/:id polling, the reports vault,
//  the Apify key pool and every FB text helper defined above. No parallel
//  infrastructure, no duplicated primitives.
// ===========================================================================
// ===========================================================================

// --- Actors are env-overridable: Apify renames its Facebook actors often ---
const FB_PAGE_DETAILS_ACTOR = process.env.FB_PAGE_DETAILS_ACTOR || 'apify/facebook-pages-scraper';
const FB_PAGE_POSTS_ACTOR   = process.env.FB_PAGE_POSTS_ACTOR   || 'apify/facebook-posts-scraper';
const FB_PAGE_REVIEWS_ACTOR = process.env.FB_PAGE_REVIEWS_ACTOR || 'apify/facebook-reviews-scraper';

const FB_PAGE_DEFAULT_POSTS = parseInt(process.env.FB_PAGE_DEFAULT_POSTS || '50', 10);
const FB_PAGE_MAX_POSTS     = parseInt(process.env.FB_PAGE_MAX_POSTS     || '300', 10);
const FB_PAGE_DEFAULT_DAYS  = parseInt(process.env.FB_PAGE_DEFAULT_DAYS  || '90', 10);
const FB_PAGE_MAX_DAYS      = parseInt(process.env.FB_PAGE_MAX_DAYS      || '365', 10);
const COST_PER_1K_FB_PAGE_POSTS = parseFloat(process.env.COST_PER_1K_FB_PAGE_POSTS || '3.20');
const COST_PER_FB_PAGE_PROFILE  = parseFloat(process.env.COST_PER_FB_PAGE_PROFILE  || '0.004');

// ---------------------------------------------------------------------------
// PAGE REFERENCE PARSING
// Accepts: a full URL, fb.com short form, profile.php?id=, /people/Name/123,
// a bare @handle, or a bare slug. Group URLs are rejected on purpose — this
// engine is Pages only, the group engine already exists.
// ---------------------------------------------------------------------------
function parsePageRef(input) {
    let s = String(input || '').trim();
    if (!s) return null;
    if (/facebook\.com\/groups\//i.test(s)) return null;

    s = s.replace(/^@/, '');

    // profile.php?id=123456
    const pid = s.match(/facebook\.com\/profile\.php\?id=(\d+)/i);
    if (pid) return { pageId: pid[1], url: `https://www.facebook.com/profile.php?id=${pid[1]}`, isNumeric: true };

    // /people/Some-Name/1000123456789
    const people = s.match(/facebook\.com\/people\/[^/]+\/(\d+)/i);
    if (people) return { pageId: people[1], url: `https://www.facebook.com/profile.php?id=${people[1]}`, isNumeric: true };

    // any facebook / fb.com url
    const m = s.match(/(?:facebook\.com|fb\.com|fb\.me)\/(?:pg\/)?([^/?#\s]+)/i);
    let slug = m ? m[1] : s.replace(/^https?:\/\//i, '').replace(/\/+$/, '').split(/[/?#]/)[0];

    slug = String(slug || '').trim();
    if (!slug || /\s/.test(slug)) return null;
    if (/^(pages|pg|profile\.php|people|groups|watch|marketplace|events)$/i.test(slug)) return null;

    return {
        pageId: slug.toLowerCase(),
        url: `https://www.facebook.com/${slug}/`,
        isNumeric: /^\d+$/.test(slug)
    };
}

// ---------------------------------------------------------------------------
// PROFILE NORMALISATION
// Apify's page actors are inconsistent between versions, so every field is
// resolved through a list of aliases rather than a single key.
// ---------------------------------------------------------------------------
function pickFirst(obj, keys, fallback = null) {
    for (const k of keys) {
        const v = k.split('.').reduce((o, part) => (o == null ? o : o[part]), obj);
        if (v !== undefined && v !== null && v !== '') return v;
    }
    return fallback;
}

function fbPageProfile(items, ref) {
    const raw = (items || []).find(i => i && (i.title || i.pageName || i.name || i.likes || i.followers)) || {};

    const hoursRaw = pickFirst(raw, ['openingHours', 'hours', 'businessHours', 'info.hours']);
    const categories = pickFirst(raw, ['categories', 'category', 'pageCategory', 'info.categories'], []);
    const catList = Array.isArray(categories) ? categories.map(String) : [String(categories)].filter(Boolean);

    return {
        page_id: ref.pageId,
        username: pickFirst(raw, ['pageUrl', 'username', 'userName', 'vanity'], ref.pageId),
        name: pickFirst(raw, ['title', 'pageName', 'name', 'pageTitle'], ref.pageId),
        url: pickFirst(raw, ['pageUrl', 'url', 'facebookUrl'], ref.url),
        category: catList[0] || null,
        categories: catList,
        about: String(pickFirst(raw, ['intro', 'about', 'pageIntro', 'description', 'bio', 'info.about'], '') || '').slice(0, 3000),
        likes: firstNum(raw.likes, raw.likesCount, raw.pageLikes, raw.fanCount, 0),
        followers: firstNum(raw.followers, raw.followersCount, raw.pageFollowers, raw.followerCount, 0),
        verified: !!pickFirst(raw, ['isVerified', 'verified', 'isBusinessPageActive'], false),
        website: pickFirst(raw, ['website', 'websites.0', 'info.website']),
        email: pickFirst(raw, ['email', 'emails.0', 'info.email']),
        phone: pickFirst(raw, ['phone', 'phoneNumber', 'contactPhone', 'info.phone']),
        address: pickFirst(raw, ['address', 'addressString', 'streetAddress', 'info.address', 'location.address']),
        city: pickFirst(raw, ['city', 'location.city']),
        country: pickFirst(raw, ['country', 'location.country']),
        rating: (() => { const r = pickFirst(raw, ['rating', 'pageRating', 'overallStarRating', 'ratingOverall']); const n = Number(r); return isNaN(n) ? null : n; })(),
        reviews_count: firstNum(raw.reviewsCount, raw.ratingCount, raw.reviews, 0),
        price_range: pickFirst(raw, ['priceRange', 'price_range', 'info.priceRange']),
        creation_date: pickFirst(raw, ['creationDate', 'pageCreatedDate', 'createdAt', 'foundedDate']),
        profile_pic: pickFirst(raw, ['profilePhoto', 'profilePic', 'profilePictureUrl', 'avatar', 'profilePhotoUrl']),
        cover_photo: pickFirst(raw, ['coverPhoto', 'coverPhotoUrl', 'coverImage']),
        has_hours: !!(hoursRaw && (Array.isArray(hoursRaw) ? hoursRaw.length : Object.keys(hoursRaw || {}).length)),
        hours: hoursRaw || null,
        messenger: pickFirst(raw, ['messenger', 'messengerLink', 'info.messenger']),
        cta: pickFirst(raw, ['pageCta', 'callToAction', 'cta', 'ctaType']),
        ad_status: pickFirst(raw, ['adStatus', 'adLibraryStatus', 'isRunningAds']),
        raw_keys: Object.keys(raw || {}).slice(0, 60)
    };
}

// ---------------------------------------------------------------------------
// POST NORMALISATION
// ---------------------------------------------------------------------------
const FB_CTA_RE = /\b(dm|inbox|message us|contact us|call (us|now)|whatsapp|order now|book now|buy now|shop now|visit|click|link in|sign up|register|apply|call \+?\d|hotline|order koren|অর্ডার|ইনবক্স|যোগাযোগ|কল করুন)\b/i;
const FB_QUESTION_RE = /\?|(^|\s)(who|what|when|where|why|which|how|anyone|any ?one|kobe|kothay|কি|কেন|কিভাবে|কোথায়)\b/i;
const FB_OFFER_RE = /\b(offer|discount|sale|% ?off|free delivery|limited time|combo|deal|bogo|coupon|promo code|ছাড়|অফার|ডিসকাউন্ট)\b/i;
const FB_EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

function fbPageViews(p) {
    return firstNum(p.viewsCount, p.videoViewCount, p.videoPlayCount, p.playCount, p.views, p.viewCount, 0);
}

function normaliseReactionBreakdown(breakdown) {
    if (!breakdown || typeof breakdown !== 'object') return null;
    const out = {};
    Object.entries(breakdown).forEach(([k, v]) => {
        const key = String(k).toLowerCase().replace(/[^a-z]/g, '');
        const n = Number(v);
        if (!isNaN(n) && n > 0) out[key] = (out[key] || 0) + n;
    });
    return Object.keys(out).length ? out : null;
}

function fbPageNormalisePost(item, pageId, pageRowId, userId) {
    const postId = fbPostId(item);
    if (!postId) return null;

    const text = fbText(item);
    const d = fbTimestamp(item);
    const { total: reactions, breakdown } = fbReactions(item);
    const comments = firstNum(item.commentsCount, item.comments?.length, item.commentCount);
    const shares = firstNum(item.sharesCount, item.shareCount, item.shares);
    const views = fbPageViews(item);
    const media = fbMediaType(item);
    const { hour, dow } = localParts(d);
    const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
    const hashtags = tagsOf(text, '#');
    const ageHours = d ? (Date.now() - d.getTime()) / 3600000 : 999;

    const engagement = reactions + (FB_COMMENT_WEIGHT * comments) + (FB_SHARE_WEIGHT * shares);

    return {
        user_id: userId,
        page_id: pageId,
        page_row_id: pageRowId || null,
        post_id: postId,
        post_url: item.url || item.postUrl || item.topLevelUrl || item.link || null,
        content: text.slice(0, 6000),
        content_length: text.length,
        word_count: words,
        media_type: media.type,
        link_url: media.link || null,
        link_domain: media.link ? domainOf(media.link) : null,
        reactions_total: reactions,
        reactions_breakdown: normaliseReactionBreakdown(breakdown),
        comments,
        shares,
        views,
        posted_at: d ? d.toISOString() : null,
        hour_local: hour,
        dow_local: dow,
        engagement_raw: engagement,
        performance_index: null,          // filled by the indexing pass
        intent_type: classifyIntent(text),
        topic_tags: topicTags(text),
        hashtags,
        opening_pattern: openingPattern(text),
        length_band: lengthBand(words),
        has_link: !!media.link,
        has_question: FB_QUESTION_RE.test(text),
        has_cta: FB_CTA_RE.test(text),
        has_offer: FB_OFFER_RE.test(text),
        has_emoji: FB_EMOJI_RE.test(text),
        is_provisional: ageHours < 24,
        raw: { keys: Object.keys(item || {}).slice(0, 40) }
    };
}

/**
 * Index every post against the page's own median for that calendar month.
 * A page that grew 4x over the window would otherwise make every old post
 * look like a failure; monthly baselines remove that drift.
 */
function fbPageIndexPosts(rows) {
    const buckets = {};
    rows.forEach(r => {
        const month = (r.posted_at || '').slice(0, 7) || 'unknown';
        (buckets[`${r.page_id}::${month}`] = buckets[`${r.page_id}::${month}`] || []).push(r);
    });

    const baselines = {};
    Object.entries(buckets).forEach(([key, group]) => {
        const settled = group.filter(r => !r.is_provisional);
        const pool = settled.length >= 4 ? settled : group;
        const med = median(pool.map(r => r.engagement_raw));
        baselines[key] = med > 0 ? med : 1;
    });

    rows.forEach(r => {
        const month = (r.posted_at || '').slice(0, 7) || 'unknown';
        r.performance_index = +(r.engagement_raw / (baselines[`${r.page_id}::${month}`] || 1)).toFixed(3);
    });

    return { rows, baselines };
}

// ---------------------------------------------------------------------------
// BOOLEAN-DIMENSION LEADERBOARD
// "Posts with a question in them" vs "posts without" — a flag comparison, not
// a category comparison, so it needs its own shape.
// ---------------------------------------------------------------------------
function flagCompare(rows, field, labelOn, labelOff) {
    const on = rows.filter(r => r[field]);
    const off = rows.filter(r => !r[field]);
    const avg = arr => arr.length ? +(arr.reduce((s, r) => s + (r.performance_index || 0), 0) / arr.length).toFixed(2) : null;
    const avgE = arr => arr.length ? Math.round(arr.reduce((s, r) => s + (r.engagement_raw || 0), 0) / arr.length) : 0;

    const onIdx = avg(on), offIdx = avg(off);
    return {
        field,
        with: { label: labelOn, posts: on.length, share: rows.length ? +((on.length / rows.length) * 100).toFixed(1) : 0, avgIndex: onIdx, avgEngagement: avgE(on) },
        without: { label: labelOff, posts: off.length, share: rows.length ? +((off.length / rows.length) * 100).toFixed(1) : 0, avgIndex: offIdx, avgEngagement: avgE(off) },
        lift: (onIdx != null && offIdx != null && offIdx > 0) ? +((onIdx / offIdx - 1) * 100).toFixed(1) : null,
        reliable: on.length >= 3 && off.length >= 3
    };
}

// ---------------------------------------------------------------------------
// REACTION SENTIMENT
// Reaction mix is the only free sentiment signal Facebook gives away.
// ---------------------------------------------------------------------------
const POSITIVE_REACTIONS = ['like', 'love', 'care', 'haha', 'wow'];
const NEGATIVE_REACTIONS = ['sad', 'angry'];

function reactionSentiment(rows) {
    const totals = {};
    rows.forEach(r => {
        const b = r.reactions_breakdown;
        if (!b) return;
        Object.entries(b).forEach(([k, v]) => { totals[k] = (totals[k] || 0) + Number(v || 0); });
    });

    const grand = Object.values(totals).reduce((s, v) => s + v, 0);
    if (!grand) return { available: false, note: 'The actor did not return a reaction breakdown for this page.' };

    const pos = POSITIVE_REACTIONS.reduce((s, k) => s + (totals[k] || 0), 0);
    const neg = NEGATIVE_REACTIONS.reduce((s, k) => s + (totals[k] || 0), 0);
    const like = totals.like || 0;

    return {
        available: true,
        totals,
        mix: Object.entries(totals).sort((a, b) => b[1] - a[1])
            .map(([type, count]) => ({ type, count, share: +((count / grand) * 100).toFixed(1) })),
        positiveShare: +((pos / grand) * 100).toFixed(1),
        negativeShare: +((neg / grand) * 100).toFixed(1),
        // Everything beyond a plain Like took deliberate effort from the reader.
        highEffortShare: +(((grand - like) / grand) * 100).toFixed(1),
        grandTotal: grand
    };
}

// ---------------------------------------------------------------------------
// CADENCE + MOMENTUM
// ---------------------------------------------------------------------------
function cadenceStats(rows) {
    const stamps = rows.map(r => r.posted_at ? new Date(r.posted_at).getTime() : null)
        .filter(Boolean).sort((a, b) => a - b);

    if (stamps.length < 2) {
        return { postsPerWeek: rows.length, spanDays: 1, longestGapDays: null, medianGapDays: null,
                 consistency: null, activeWeeks: rows.length ? 1 : 0, lastPostDaysAgo: null, silent: false };
    }

    const spanDays = Math.max(1, (stamps[stamps.length - 1] - stamps[0]) / 86400000);
    const gaps = [];
    for (let i = 1; i < stamps.length; i++) gaps.push((stamps[i] - stamps[i - 1]) / 86400000);

    const medGap = median(gaps);
    const longest = Math.max(...gaps);
    const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((s, g) => s + Math.pow(g - mean, 2), 0) / gaps.length);
    // 100 = perfectly metronomic. Falls as the gaps become erratic.
    const consistency = mean > 0 ? Math.max(0, Math.round(100 - Math.min(100, (sd / mean) * 55))) : null;

    const weeks = new Set(rows.filter(r => r.posted_at)
        .map(r => { const d = new Date(r.posted_at); const y = d.getUTCFullYear();
                    const w = Math.floor((d - new Date(Date.UTC(y, 0, 1))) / (7 * 86400000)); return `${y}-${w}`; }));

    return {
        postsPerWeek: +((rows.length / spanDays) * 7).toFixed(1),
        postsPerMonth: +((rows.length / spanDays) * 30).toFixed(1),
        spanDays: Math.round(spanDays),
        medianGapDays: +medGap.toFixed(1),
        longestGapDays: +longest.toFixed(1),
        consistency,
        activeWeeks: weeks.size,
        lastPostDaysAgo: +((Date.now() - stamps[stamps.length - 1]) / 86400000).toFixed(1),
        silent: (Date.now() - stamps[stamps.length - 1]) / 86400000 > 14
    };
}

/** Month-by-month trajectory: is this page climbing or sliding? */
function momentum(allRows) {
    // Posts under 24h old are still collecting engagement. Leaving them in
    // would make the newest month look like a collapse every single time.
    const rows = allRows.filter(r => !r.is_provisional);
    const byMonth = {};
    rows.forEach(r => {
        if (!r.posted_at) return;
        const m = r.posted_at.slice(0, 7);
        byMonth[m] = byMonth[m] || { month: m, posts: 0, engagement: 0, reactions: 0, comments: 0, shares: 0 };
        byMonth[m].posts++;
        byMonth[m].engagement += r.engagement_raw || 0;
        byMonth[m].reactions += r.reactions_total || 0;
        byMonth[m].comments += r.comments || 0;
        byMonth[m].shares += r.shares || 0;
    });

    const months = Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month)).map(m => ({
        ...m,
        avgEngagement: Math.round(m.engagement / m.posts),
        avgComments: +(m.comments / m.posts).toFixed(1)
    }));

    let direction = null, changePct = null;
    if (months.length >= 2) {
        const prev = months[months.length - 2], last = months[months.length - 1];
        if (prev.avgEngagement > 0) {
            changePct = +(((last.avgEngagement - prev.avgEngagement) / prev.avgEngagement) * 100).toFixed(1);
            direction = changePct > 8 ? 'rising' : changePct < -8 ? 'falling' : 'flat';
        }
    }

    // Newest third vs oldest third — steadier than a single month comparison.
    let halfSplit = null;
    if (rows.length >= 9) {
        const sorted = [...rows].filter(r => r.posted_at).sort((a, b) => new Date(a.posted_at) - new Date(b.posted_at));
        const third = Math.floor(sorted.length / 3);
        const oldAvg = sorted.slice(0, third).reduce((s, r) => s + r.engagement_raw, 0) / third;
        const newAvg = sorted.slice(-third).reduce((s, r) => s + r.engagement_raw, 0) / third;
        halfSplit = {
            oldestThirdAvg: Math.round(oldAvg),
            newestThirdAvg: Math.round(newAvg),
            changePct: oldAvg > 0 ? +(((newAvg - oldAvg) / oldAvg) * 100).toFixed(1) : null
        };
    }

    return { months, direction, changePct, halfSplit };
}

// ---------------------------------------------------------------------------
// PROFILE COMPLETENESS
// Cheap to fix, disproportionately valuable, and almost every local business
// page is missing something here.
// ---------------------------------------------------------------------------
function profileCompleteness(p) {
    const checks = [
        { key: 'name',       label: 'Page name set',            ok: !!p.name,                          weight: 5 },
        { key: 'category',   label: 'Business category set',    ok: !!p.category,                      weight: 10 },
        { key: 'about',      label: 'About / intro written',    ok: !!(p.about && p.about.length > 40), weight: 15 },
        { key: 'website',    label: 'Website linked',           ok: !!p.website,                       weight: 12 },
        { key: 'phone',      label: 'Phone number published',   ok: !!p.phone,                         weight: 12 },
        { key: 'email',      label: 'Email published',          ok: !!p.email,                         weight: 6 },
        { key: 'address',    label: 'Address published',        ok: !!p.address,                       weight: 10 },
        { key: 'hours',      label: 'Opening hours set',        ok: !!p.has_hours,                     weight: 10 },
        { key: 'profile_pic',label: 'Profile photo set',        ok: !!p.profile_pic,                   weight: 5 },
        { key: 'cover',      label: 'Cover photo set',          ok: !!p.cover_photo,                   weight: 5 },
        { key: 'cta',        label: 'Call-to-action button set', ok: !!p.cta,                          weight: 5 },
        { key: 'reviews',    label: 'Reviews enabled and present', ok: (p.reviews_count || 0) > 0,     weight: 5 }
    ];

    const earned = checks.filter(c => c.ok).reduce((s, c) => s + c.weight, 0);
    const total = checks.reduce((s, c) => s + c.weight, 0);

    return {
        score: Math.round((earned / total) * 100),
        checks,
        missing: checks.filter(c => !c.ok).map(c => c.label)
    };
}

// ---------------------------------------------------------------------------
// PAGE SCORE
// Six pillars. Every pillar is bounded, so one dimension cannot carry a page
// that is failing everywhere else — and the breakdown is returned so the
// client can see exactly where the points went.
// ---------------------------------------------------------------------------
function computePageScore(parts) {
    const { engagementRate, postsPerWeek, consistency, conversationRate,
            amplificationRate, completeness, momentumPct, formatSpread, sampleSize } = parts;

    // 1. Engagement per follower (25) — the headline number, log-scaled because
    //    small pages routinely post 8% rates that a 500k page can never reach.
    const er = engagementRate || 0;
    const engagementPts = Math.min(25, Math.round((Math.log10(1 + er * 12) / Math.log10(13)) * 25));

    // 2. Cadence (18) — 3-7 posts a week is the sweet spot for a business page.
    const ppw = postsPerWeek || 0;
    const cadencePts = ppw === 0 ? 0
        : ppw < 1 ? 4
        : ppw < 2 ? 9
        : ppw <= 7 ? 18
        : ppw <= 12 ? 14
        : 10;

    // 3. Consistency (12) — rhythm matters as much as volume.
    const consistencyPts = Math.round(((consistency ?? 50) / 100) * 12);

    // 4. Conversation (18) — comments per 100 reactions. Comments are the
    //    hardest engagement to fake and the strongest reach signal.
    const conv = conversationRate || 0;
    const conversationPts = Math.min(18, Math.round((Math.log10(1 + conv) / Math.log10(26)) * 18));

    // 5. Amplification (12) — shares per 100 reactions.
    const amp = amplificationRate || 0;
    const amplificationPts = Math.min(12, Math.round((Math.log10(1 + amp) / Math.log10(16)) * 12));

    // 6. Profile completeness (10) + format range (5)
    const completenessPts = Math.round(((completeness || 0) / 100) * 10);
    const formatPts = Math.min(5, (formatSpread || 0) >= 3 ? 5 : (formatSpread || 0) * 2);

    let score = engagementPts + cadencePts + consistencyPts + conversationPts +
                amplificationPts + completenessPts + formatPts;

    // Momentum adjusts within ±5, it does not dominate.
    const momentumAdj = momentumPct == null ? 0 : Math.max(-5, Math.min(5, Math.round(momentumPct / 10)));
    score = Math.max(0, Math.min(100, score + momentumAdj));

    const grade = score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : score >= 35 ? 'D' : 'F';

    return {
        score, grade,
        breakdown: [
            { pillar: 'Engagement per follower', points: engagementPts,   max: 25, detail: `${er.toFixed(2)}% per post` },
            { pillar: 'Posting cadence',         points: cadencePts,      max: 18, detail: `${ppw} posts/week` },
            { pillar: 'Consistency',             points: consistencyPts,  max: 12, detail: consistency == null ? 'not enough posts' : `${consistency}/100 rhythm` },
            { pillar: 'Conversation',            points: conversationPts, max: 18, detail: `${conv.toFixed(1)} comments per 100 reactions` },
            { pillar: 'Amplification',           points: amplificationPts,max: 12, detail: `${amp.toFixed(1)} shares per 100 reactions` },
            { pillar: 'Profile completeness',    points: completenessPts, max: 10, detail: `${completeness || 0}% complete` },
            { pillar: 'Format range',            points: formatPts,       max: 5,  detail: `${formatSpread || 0} formats in use` },
            { pillar: 'Momentum adjustment',     points: momentumAdj,     max: 5,  detail: momentumPct == null ? 'no trend data' : `${momentumPct > 0 ? '+' : ''}${momentumPct}% month over month` }
        ],
        lowConfidence: sampleSize > 0 && sampleSize < 12,
        verdict: (sampleSize > 0 && sampleSize < 12)
            ? `Only ${sampleSize} posts in the window — treat this as provisional`
            : score >= 80 ? 'Strong page — protect what is working'
            : score >= 65 ? 'Healthy page with a clear gap to close'
            : score >= 50 ? 'Functional but underperforming'
            : score >= 35 ? 'Weak — the fundamentals need fixing first'
            : 'Dormant or badly broken'
    };
}

// ---------------------------------------------------------------------------
// FULL PAGE AUDIT
// ---------------------------------------------------------------------------
function computePageAudit(profile, rows, extras = {}) {
    const posts = rows.length;
    const completeness = profileCompleteness(profile);

    if (!posts) {
        return {
            pageId: profile.page_id,
            name: profile.name,
            url: profile.url,
            profile,
            completeness,
            postsAnalyzed: 0,
            score: 0, grade: 'F',
            scoreBreakdown: { verdict: 'No public posts returned — the page may be new, restricted, region-locked, or the URL may be wrong.', breakdown: [] },
            formats: [], intents: [], lengths: [], openings: [],
            heatmap: { cells: [], bestHours: [], bestDays: [] },
            topPosts: [], bottomPosts: [], hashtags: [], topics: [], domains: [],
            flags: [], sentiment: { available: false }, cadence: cadenceStats([]), momentum: { months: [] },
            findings: ['No public posts were returned for this page. Confirm the page is public and the URL points at a Page, not a personal profile or a group.']
        };
    }

    const cadence = cadenceStats(rows);
    const mo = momentum(rows);

    const totalReactions = rows.reduce((s, r) => s + (r.reactions_total || 0), 0);
    const totalComments  = rows.reduce((s, r) => s + (r.comments || 0), 0);
    const totalShares    = rows.reduce((s, r) => s + (r.shares || 0), 0);
    const totalViews     = rows.reduce((s, r) => s + (r.views || 0), 0);
    const totalEngagement = totalReactions + totalComments + totalShares;

    const audience = profile.followers || profile.likes || 0;
    const engagementRate = audience ? +((totalEngagement / posts / audience) * 100).toFixed(3) : 0;

    const conversationRate  = totalReactions ? +((totalComments / totalReactions) * 100).toFixed(2) : 0;
    const amplificationRate = totalReactions ? +((totalShares / totalReactions) * 100).toFixed(2) : 0;

    const formats  = leaderboard(rows, 'media_type');
    const intents  = leaderboard(rows, 'intent_type');
    const lengths  = leaderboard(rows, 'length_band');
    const openings = leaderboard(rows, 'opening_pattern');
    const heat     = timeHeatmap(rows);
    const sentiment = reactionSentiment(rows);

    const flags = [
        flagCompare(rows, 'has_question', 'Asks a question', 'No question'),
        flagCompare(rows, 'has_link',     'Contains a link', 'No link'),
        flagCompare(rows, 'has_cta',      'Contains a call to action', 'No call to action'),
        flagCompare(rows, 'has_offer',    'Promotional / offer', 'Not promotional'),
        flagCompare(rows, 'has_emoji',    'Uses emoji', 'No emoji')
    ];

    // Hashtags, topics, outbound domains
    const tally = (list) => {
        const agg = {};
        list.forEach(({ key, index }) => {
            agg[key] = agg[key] || { key, uses: 0, indexSum: 0 };
            agg[key].uses++; agg[key].indexSum += index || 0;
        });
        return Object.values(agg).map(a => ({ key: a.key, uses: a.uses, avgIndex: +(a.indexSum / a.uses).toFixed(2) }));
    };

    const hashtagRows = [];
    const topicRows = [];
    const domainRows = [];
    rows.forEach(r => {
        (r.hashtags || []).forEach(h => hashtagRows.push({ key: h, index: r.performance_index }));
        (r.topic_tags || []).forEach(t => topicRows.push({ key: t, index: r.performance_index }));
        if (r.link_domain) domainRows.push({ key: r.link_domain, index: r.performance_index });
    });

    const hashtags = tally(hashtagRows).sort((a, b) => b.uses - a.uses).slice(0, 25);
    const topics   = tally(topicRows).filter(t => t.uses >= 2).sort((a, b) => b.uses - a.uses).slice(0, 25);
    const domains  = tally(domainRows).sort((a, b) => b.uses - a.uses).slice(0, 12);

    const videos = rows.filter(r => r.media_type === 'video');
    const videoStats = videos.length ? {
        posts: videos.length,
        share: +((videos.length / posts) * 100).toFixed(1),
        avgViews: Math.round(videos.reduce((s, r) => s + (r.views || 0), 0) / videos.length),
        avgIndex: +(videos.reduce((s, r) => s + (r.performance_index || 0), 0) / videos.length).toFixed(2),
        viewToReactionRatio: (() => {
            const v = videos.reduce((s, r) => s + (r.views || 0), 0);
            const rx = videos.reduce((s, r) => s + (r.reactions_total || 0), 0);
            return v && rx ? +(rx / v * 100).toFixed(2) : null;
        })()
    } : null;

    const sorted = [...rows].sort((a, b) => (b.performance_index || 0) - (a.performance_index || 0));
    const slim = r => ({
        postId: r.post_id, url: r.post_url,
        excerpt: (r.content || '').slice(0, 240),
        format: r.media_type, intent: r.intent_type,
        opening: r.opening_pattern, lengthBand: r.length_band,
        reactions: r.reactions_total, comments: r.comments, shares: r.shares, views: r.views,
        index: r.performance_index, postedAt: r.posted_at,
        hour: r.hour_local, dowName: r.dow_local !== null ? DOW_NAMES[r.dow_local] : null,
        hasLink: r.has_link, hasCta: r.has_cta, hasQuestion: r.has_question,
        provisional: r.is_provisional
    });

    const scored = computePageScore({
        engagementRate,
        postsPerWeek: cadence.postsPerWeek,
        consistency: cadence.consistency,
        conversationRate,
        amplificationRate,
        completeness: completeness.score,
        momentumPct: mo.changePct,
        formatSpread: formats.length,
        sampleSize: posts
    });

    // ---- Plain-language findings, each tied to a number in this report ----
    const findings = [];
    if (formats[0]) findings.push(`${formats[0].key} posts run at ${formats[0].avgIndex}x this page's own median across ${formats[0].posts} posts — the strongest format here.`);
    if (formats.length > 1) {
        const worst = formats[formats.length - 1];
        findings.push(`${worst.key} posts run at ${worst.avgIndex}x. ${worst.avgIndex < 0.8 ? 'This audience ignores them — cut or rework them.' : 'Usable, but not the first choice.'}`);
    }
    if (intents[0]) findings.push(`Posts framed as ${String(intents[0].key).replace(/_/g, ' ')} index at ${intents[0].avgIndex}x.`);
    if (heat.bestHours[0]) findings.push(`Best posting window is ${String(heat.bestHours[0].hour).padStart(2, '0')}:00 local (${heat.bestHours[0].avgIndex}x across ${heat.bestHours[0].posts} posts)${heat.bestDays[0] ? `, strongest on ${heat.bestDays[0].dowName}` : ''}.`);
    if (lengths[0]) findings.push(`${lengths[0].key} captions index highest at ${lengths[0].avgIndex}x.`);

    const qFlag = flags.find(f => f.field === 'has_question');
    if (qFlag?.reliable && qFlag.lift != null) findings.push(`Posts that ask a question perform ${qFlag.lift > 0 ? qFlag.lift + '% better' : Math.abs(qFlag.lift) + '% worse'} than posts that do not (${qFlag.with.posts} vs ${qFlag.without.posts} posts).`);
    const lFlag = flags.find(f => f.field === 'has_link');
    if (lFlag?.reliable && lFlag.lift != null && lFlag.lift < -15) findings.push(`Posts containing an outbound link lose ${Math.abs(lFlag.lift)}% against posts without one — the classic link-suppression pattern.`);
    const cFlag = flags.find(f => f.field === 'has_cta');
    if (cFlag?.reliable && cFlag.lift != null) findings.push(`Posts with a call to action index ${cFlag.with.avgIndex}x vs ${cFlag.without.avgIndex}x without one.`);

    if (cadence.silent) findings.push(`The page has not posted for ${cadence.lastPostDaysAgo} days. Everything below describes a page that is currently dormant.`);
    if (cadence.longestGapDays > 14) findings.push(`Longest silence in the window was ${cadence.longestGapDays} days; the median gap between posts is ${cadence.medianGapDays} days.`);
    if (mo.direction) findings.push(`Month over month, average engagement is ${mo.direction}${mo.changePct != null ? ` (${mo.changePct > 0 ? '+' : ''}${mo.changePct}%)` : ''}.`);
    if (sentiment.available) findings.push(`${sentiment.highEffortShare}% of reactions are something other than a plain Like${sentiment.negativeShare > 4 ? `, and ${sentiment.negativeShare}% are angry or sad — check the comments on those posts` : ''}.`);
    if (conversationRate < 2 && totalReactions > 50) findings.push(`Only ${conversationRate} comments per 100 reactions. This audience scrolls and taps but does not talk — the posts are not asking anything of them.`);
    if (amplificationRate > 8) findings.push(`${amplificationRate} shares per 100 reactions is unusually high — this page produces content people forward, which is the cheapest reach there is.`);
    if (completeness.missing.length) findings.push(`Profile is ${completeness.score}% complete. Missing: ${completeness.missing.join(', ')}.`);
    if (videoStats && videoStats.posts >= 3) findings.push(`Video makes up ${videoStats.share}% of posts and indexes at ${videoStats.avgIndex}x${videoStats.avgViews ? `, averaging ${videoStats.avgViews.toLocaleString()} views` : ''}.`);
    if (!audience) findings.push('Follower count was not returned, so the engagement rate could not be calculated per follower. Every index figure is still valid.');

    return {
        pageId: profile.page_id,
        name: profile.name,
        url: profile.url,
        profile,
        completeness,
        postsAnalyzed: posts,
        windowDays: cadence.spanDays,
        followers: profile.followers,
        likes: profile.likes,
        verified: profile.verified,
        category: profile.category,
        rating: profile.rating,
        reviewsCount: profile.reviews_count,
        reviews: extras.reviews || null,

        totals: { reactions: totalReactions, comments: totalComments, shares: totalShares, views: totalViews, engagement: totalEngagement },
        averages: {
            reactions: Math.round(totalReactions / posts),
            comments: +(totalComments / posts).toFixed(1),
            shares: +(totalShares / posts).toFixed(1),
            views: totalViews ? Math.round(totalViews / posts) : 0,
            engagement: Math.round(totalEngagement / posts)
        },
        medians: {
            reactions: median(rows.map(r => r.reactions_total)),
            comments: median(rows.map(r => r.comments)),
            shares: median(rows.map(r => r.shares)),
            engagement: median(rows.map(r => r.engagement_raw))
        },
        engagementRate,
        conversationRate,
        amplificationRate,
        cadence,
        momentum: mo,
        sentiment,
        formats, intents, lengths, openings,
        flags,
        heatmap: heat,
        hashtags, topics, domains,
        video: videoStats,
        topPosts: sorted.slice(0, 10).map(slim),
        bottomPosts: sorted.slice(-10).reverse().map(slim),
        provisionalPosts: rows.filter(r => r.is_provisional).length,
        score: scored.score,
        grade: scored.grade,
        scoreBreakdown: scored,
        findings,
        exemplars: sorted.filter(r => (r.content || '').length > 60).slice(0, 3).map(r => ({
            text: (r.content || '').slice(0, 700), index: r.performance_index,
            format: r.media_type, intent: r.intent_type
        }))
    };
}

// ---------------------------------------------------------------------------
// HEAD TO HEAD
// One rival, every dimension, and an explicit winner per row so the client
// does not have to interpret a table of numbers.
// ---------------------------------------------------------------------------
function buildPageBenchmark(target, rival) {
    if (!rival || !rival.postsAnalyzed) return null;

    const rowsOut = [];
    const cmp = (metric, a, b, higherIsBetter = true, fmt = v => v) => {
        const aa = a == null ? null : Number(a);
        const bb = b == null ? null : Number(b);
        let winner = 'tie';
        if (aa != null && bb != null && aa !== bb) {
            winner = (higherIsBetter ? aa > bb : aa < bb) ? 'target' : 'rival';
        }
        const gapPct = (aa != null && bb != null && bb !== 0) ? +(((aa - bb) / Math.abs(bb)) * 100).toFixed(1) : null;
        rowsOut.push({ metric, target: aa == null ? null : fmt(aa), rival: bb == null ? null : fmt(bb), rawTarget: aa, rawRival: bb, winner, gapPct });
    };

    cmp('Page score',                 target.score,                 rival.score);
    cmp('Followers',                  target.followers,             rival.followers);
    cmp('Posts in window',            target.postsAnalyzed,         rival.postsAnalyzed);
    cmp('Posts per week',             target.cadence.postsPerWeek,  rival.cadence.postsPerWeek);
    cmp('Posting consistency',        target.cadence.consistency,   rival.cadence.consistency);
    cmp('Engagement rate %',          target.engagementRate,        rival.engagementRate);
    cmp('Avg reactions per post',     target.averages.reactions,    rival.averages.reactions);
    cmp('Avg comments per post',      target.averages.comments,     rival.averages.comments);
    cmp('Avg shares per post',        target.averages.shares,       rival.averages.shares);
    cmp('Comments per 100 reactions', target.conversationRate,      rival.conversationRate);
    cmp('Shares per 100 reactions',   target.amplificationRate,     rival.amplificationRate);
    cmp('Profile completeness %',     target.completeness.score,    rival.completeness.score);
    cmp('Longest silence (days)',     target.cadence.longestGapDays, rival.cadence.longestGapDays, false);
    cmp('Days since last post',       target.cadence.lastPostDaysAgo, rival.cadence.lastPostDaysAgo, false);
    if (target.sentiment.available && rival.sentiment.available) {
        cmp('Non-Like reaction share %', target.sentiment.highEffortShare, rival.sentiment.highEffortShare);
    }
    if (target.video && rival.video) {
        cmp('Video share of posts %',  target.video.share,           rival.video.share);
    }

    const wins   = rowsOut.filter(r => r.winner === 'target').length;
    const losses = rowsOut.filter(r => r.winner === 'rival').length;

    // Where the rival does something this page does not
    const formatGaps = (rival.formats || []).filter(rf => {
        const mine = (target.formats || []).find(tf => tf.key === rf.key);
        return rf.avgIndex >= 1.1 && (!mine || mine.posts < 2);
    }).map(rf => ({ format: rf.key, rivalIndex: rf.avgIndex, rivalPosts: rf.posts }));

    const intentGaps = (rival.intents || []).filter(ri => {
        const mine = (target.intents || []).find(ti => ti.key === ri.key);
        return ri.avgIndex >= 1.1 && (!mine || mine.posts < 2);
    }).map(ri => ({ intent: ri.key, rivalIndex: ri.avgIndex, rivalPosts: ri.posts }));

    const rivalHashtags = (rival.hashtags || []).filter(h =>
        !(target.hashtags || []).some(t => t.key === h.key)).slice(0, 12);

    const shareOfVoice = (() => {
        const t = target.totals.engagement, r = rival.totals.engagement;
        const sum = t + r;
        return sum ? { target: +((t / sum) * 100).toFixed(1), rival: +((r / sum) * 100).toFixed(1) } : null;
    })();

    return {
        target: { name: target.name, pageId: target.pageId, score: target.score, grade: target.grade },
        rival:  { name: rival.name,  pageId: rival.pageId,  score: rival.score,  grade: rival.grade },
        rows: rowsOut,
        wins, losses, ties: rowsOut.length - wins - losses,
        verdict: wins > losses
            ? `${target.name} leads on ${wins} of ${rowsOut.length} measures.`
            : wins < losses
                ? `${rival.name} leads on ${losses} of ${rowsOut.length} measures.`
                : 'Evenly matched across the measured dimensions.',
        shareOfVoice,
        formatGaps, intentGaps,
        rivalHashtags,
        rivalTopPosts: (rival.topPosts || []).slice(0, 5),
        biggestGaps: rowsOut.filter(r => r.winner === 'rival' && r.gapPct != null)
            .sort((a, b) => a.gapPct - b.gapPct).slice(0, 5),
        biggestLeads: rowsOut.filter(r => r.winner === 'target' && r.gapPct != null)
            .sort((a, b) => b.gapPct - a.gapPct).slice(0, 5)
    };
}

// ---------------------------------------------------------------------------
// RULE-BASED RECOMMENDATIONS
// These fire with or without Gemini, so the report is never empty.
// ---------------------------------------------------------------------------
function fbPageRecommendations(a, benchmark) {
    const recs = [];
    const push = (priority, title, why, action) => recs.push({ priority, title, why, action });

    if (!a.postsAnalyzed) return recs;

    if (a.cadence.silent) {
        push('critical', 'Restart publishing',
            `Nothing has been posted for ${a.cadence.lastPostDaysAgo} days, so reach has already decayed.`,
            'Publish three posts this week using the strongest format below before optimising anything else.');
    } else if (a.cadence.postsPerWeek < 2) {
        push('high', 'Raise cadence to at least 3 posts a week',
            `Currently ${a.cadence.postsPerWeek} posts per week, with a median gap of ${a.cadence.medianGapDays} days.`,
            'Book two fixed publishing slots a week and fill them from the winning format and intent.');
    } else if (a.cadence.postsPerWeek > 12) {
        push('medium', 'Cut volume and raise the floor',
            `${a.cadence.postsPerWeek} posts a week is diluting the average — high-volume pages usually carry a long tail of dead posts.`,
            'Drop to 5-7 stronger posts a week and reinvest the effort in the top-performing format.');
    }

    if (a.cadence.consistency != null && a.cadence.consistency < 45) {
        push('medium', 'Fix the rhythm, not just the volume',
            `Posting consistency scores ${a.cadence.consistency}/100 — bursts followed by silence.`,
            'Pick fixed days and stick to them. Even three predictable posts beat seven erratic ones.');
    }

    if (a.formats[0] && a.formats.length > 1) {
        const best = a.formats[0], worst = a.formats[a.formats.length - 1];
        if (best.avgIndex >= 1.2) {
            push('high', `Shift the mix toward ${best.key}`,
                `${best.key} indexes at ${best.avgIndex}x across ${best.posts} posts, while ${worst.key} sits at ${worst.avgIndex}x.`,
                `Move roughly half of the ${worst.key} slots to ${best.key} for the next 30 days and re-run this report.`);
        }
    }

    if (a.conversationRate < 2 && a.totals.reactions > 50) {
        push('high', 'Engineer comments deliberately',
            `${a.conversationRate} comments per 100 reactions — the audience taps but does not talk, and comments drive far more reach than reactions.`,
            'End every second post with one specific, answerable question. Reply to every comment within the hour.');
    }

    const q = (a.flags || []).find(f => f.field === 'has_question');
    if (q?.reliable && q.lift != null && q.lift > 15) {
        push('high', 'Ask more questions',
            `Posts with a question already run ${q.lift}% ahead here (${q.with.posts} posts vs ${q.without.posts}).`,
            'Make a question the default closing line unless there is a reason not to.');
    }

    const link = (a.flags || []).find(f => f.field === 'has_link');
    if (link?.reliable && link.lift != null && link.lift < -20) {
        push('medium', 'Stop putting links in the post body',
            `Link posts lose ${Math.abs(link.lift)}% against non-link posts on this page.`,
            'Put the link in the first comment or in the CTA button, and keep the post itself native.');
    }

    if (a.heatmap.bestHours[0]) {
        const h = a.heatmap.bestHours[0];
        const worst = a.heatmap.worstHours?.[0];
        push('medium', `Publish around ${String(h.hour).padStart(2, '0')}:00 local`,
            `That window indexes ${h.avgIndex}x across ${h.posts} posts${worst ? `, against ${worst.avgIndex}x at ${String(worst.hour).padStart(2, '0')}:00` : ''}.`,
            `Schedule the main post of each day for ${String(h.hour).padStart(2, '0')}:00${a.heatmap.bestDays[0] ? `, favouring ${a.heatmap.bestDays[0].dowName}` : ''}.`);
    }

    if (a.completeness.missing.length) {
        push(a.completeness.score < 60 ? 'high' : 'low', 'Complete the page profile',
            `The profile is ${a.completeness.score}% complete; missing ${a.completeness.missing.join(', ')}.`,
            'Fix these in Page Settings today — it takes minutes and it is the cheapest conversion win available.');
    }

    if (a.sentiment.available && a.sentiment.negativeShare > 5) {
        push('high', 'Investigate negative reactions',
            `${a.sentiment.negativeShare}% of reactions are angry or sad.`,
            'Open the highest-reaction posts, read the comments, and answer publicly rather than deleting.');
    }

    if (a.momentum.direction === 'falling') {
        push('high', 'Reverse the slide',
            `Average engagement is down ${Math.abs(a.momentum.changePct)}% month over month.`,
            'Compare the current month against the top posts table below and go back to what worked before the drop.');
    }

    if (benchmark) {
        // Follower count and raw post volume are outcomes, not actions — they
        // make for a useless recommendation, so they stay in the table only.
        const NOT_ACTIONABLE = ['Followers', 'Posts in window', 'Page score'];
        (benchmark.biggestGaps || [])
            .filter(g => !NOT_ACTIONABLE.includes(g.metric))
            .slice(0, 3).forEach(g => {
            push('high', `Close the gap on ${String(g.metric).toLowerCase()}`,
                `${benchmark.rival.name} leads here: ${g.rival} against your ${g.target}.`,
                'Treat this as the single measurable target for the next 30 days.');
        });
        (benchmark.formatGaps || []).slice(0, 2).forEach(g => {
            push('medium', `Test ${g.format} posts`,
                `${benchmark.rival.name} runs ${g.format} at ${g.rivalIndex}x across ${g.rivalPosts} posts and this page barely uses the format.`,
                `Run four ${g.format} posts over the next two weeks and compare.`);
        });
    }

    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    return recs.sort((x, y) => order[x.priority] - order[y.priority]);
}

// ---------------------------------------------------------------------------
// AI NARRATIVE
// ---------------------------------------------------------------------------
async function fbPageNarrative(payload) {
    const prompt =
`You are a social media strategist writing a paid client report about a Facebook business Page.
The reader is the business owner. They want to know how their Page is really doing, what to change,
and — if a rival is included — where they are being beaten.

Reply with ONLY valid JSON matching this schema:
{
 "executive_summary": "4-6 sentences a business owner understands, naming real numbers from the data",
 "state_of_the_page": ["specific observations about health, cadence and audience behaviour"],
 "what_is_working": ["concrete, each citing a number from the data"],
 "what_is_failing": ["concrete, each citing a number from the data"],
 "content_playbook": [{"format":"...","intent":"...","best_time":"...","angle":"...","why":"cites a number"}],
 "competitor_read": ["only if a rival is supplied: where the rival wins and what to copy"],
 "quick_wins": ["things that can be done this week with no budget"],
 "thirty_day_plan": [{"week":"Week 1","actions":["..."]}],
 "risks": ["anything in the data that should worry the owner"],
 "kpis_to_watch": [{"kpi":"...","current":"...","target":"..."}]
}
Ground every claim in the numbers supplied. Never invent a metric that is not in the data.
If a rival is not supplied, return an empty array for competitor_read. No markdown outside the JSON.

DATA:
${JSON.stringify(payload).slice(0, 60000)}`;

    return geminiJSON(prompt, 4096, 0.45);
}

// ---------------------------------------------------------------------------
// SCRAPE + PERSIST
// ---------------------------------------------------------------------------
async function fbScrapePageProfile(client, ref) {
    try {
        const { items } = await callActor(client, FB_PAGE_DETAILS_ACTOR, {
            startUrls: [{ url: ref.url }],
            resultsLimit: 1,
            scrapeAbout: true,
            scrapePosts: false
        }, { maxItems: 1, estimateUsd: COST_PER_FB_PAGE_PROFILE });
        return items || [];
    } catch (err) {
        if (err.code === 'NO_CREDIT') throw err;
        console.error('[fbScrapePageProfile]', ref.pageId, err.message);
        return [];
    }
}

async function fbScrapePagePosts(client, ref, opts = {}) {
    const limit = Math.min(opts.limit || FB_PAGE_DEFAULT_POSTS, FB_PAGE_MAX_POSTS);
    const days  = Math.min(opts.days || FB_PAGE_DEFAULT_DAYS, FB_PAGE_MAX_DAYS);
    const onlyPostsNewerThan = opts.since ||
        new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

    const { items } = await callActor(client, FB_PAGE_POSTS_ACTOR, {
        startUrls: [{ url: ref.url }],
        resultsLimit: limit,
        maxPosts: limit,
        onlyPostsNewerThan,
        scrapeComments: false,
        maxComments: 0
    }, {
        maxItems: limit,
        jobId: opts.jobId,
        estimateUsd: (limit / 1000) * COST_PER_1K_FB_PAGE_POSTS
    });
    return items || [];
}

async function fbScrapePageReviews(client, ref, limit = 30) {
    try {
        const { items } = await callActor(client, FB_PAGE_REVIEWS_ACTOR, {
            startUrls: [{ url: ref.url }],
            resultsLimit: limit,
            maxReviews: limit
        }, { maxItems: limit, estimateUsd: 0.02 });
        const rows = (items || []).map(r => ({
            text: String(r.text || r.review || r.comment || '').slice(0, 600),
            isPositive: r.isRecommended ?? r.recommends ?? (Number(r.rating) >= 4) ?? null,
            rating: Number(r.rating) || null,
            date: r.date || r.time || null
        })).filter(r => r.text || r.rating);

        if (!rows.length) return null;
        const positive = rows.filter(r => r.isPositive === true).length;
        const negative = rows.filter(r => r.isPositive === false).length;
        return {
            sampled: rows.length,
            positive, negative,
            positiveShare: +((positive / rows.length) * 100).toFixed(1),
            recent: rows.slice(0, 12)
        };
    } catch (err) {
        console.error('[fbScrapePageReviews]', ref.pageId, err.message);
        return null;
    }
}

async function fbUpsertPage(userId, profile) {
    const row = {
        user_id: userId,
        page_id: profile.page_id,
        username: profile.username,
        name: profile.name,
        url: profile.url,
        category: profile.category,
        categories: profile.categories || [],
        about: profile.about || null,
        likes: profile.likes || 0,
        followers: profile.followers || 0,
        verified: !!profile.verified,
        website: profile.website || null,
        email: profile.email || null,
        phone: profile.phone || null,
        address: profile.address || null,
        city: profile.city || null,
        country: profile.country || null,
        rating: profile.rating,
        reviews_count: profile.reviews_count || 0,
        price_range: profile.price_range || null,
        creation_date: profile.creation_date ? String(profile.creation_date).slice(0, 60) : null,
        profile_pic: profile.profile_pic || null,
        cover_photo: profile.cover_photo || null,
        has_hours: !!profile.has_hours,
        hours: profile.hours || null,
        cta: profile.cta ? String(profile.cta).slice(0, 120) : null,
        last_scraped_at: new Date().toISOString()
    };
    const { data, error } = await supabase.from('fb_pages')
        .upsert(row, { onConflict: 'user_id,page_id' })
        .select('id, page_id, name, url, followers, likes, page_score, last_scraped_at')
        .maybeSingle();
    if (error) console.error('[fbUpsertPage]', error.message);
    return data;
}

async function fbSavePagePosts(rows) {
    if (!rows.length) return 0;
    let saved = 0;
    for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        const { error } = await supabase.from('fb_page_posts')
            .upsert(chunk, { onConflict: 'user_id,page_id,post_id' });
        if (error) console.error('[fbSavePagePosts]', error.message);
        else saved += chunk.length;
    }
    return saved;
}

function fbPageEstimateCredits(pages, postsPerPage, withReviews) {
    const posts = pages * postsPerPage;
    const reviewCost = withReviews ? pages * 0.02 : 0;
    return +(((posts / 1000) * COST_PER_1K_FB_PAGE_POSTS) + (pages * COST_PER_FB_PAGE_PROFILE) + reviewCost).toFixed(4);
}

/** One page, end to end: profile -> posts -> index -> persist -> audit. */
async function fbAuditPage(client, userId, ref, opts = {}) {
    const profileItems = await fbScrapePageProfile(client, ref);
    const profile = fbPageProfile(profileItems, ref);
    const pageRow = await fbUpsertPage(userId, profile);

    const rawPosts = await fbScrapePagePosts(client, ref, opts);
    const rows = rawPosts
        .map(item => fbPageNormalisePost(item, profile.page_id, pageRow?.id, userId))
        .filter(Boolean);

    // De-duplicate: some actors emit the same post twice across pagination.
    const seen = new Set();
    const unique = rows.filter(r => (seen.has(r.post_id) ? false : (seen.add(r.post_id), true)));

    fbPageIndexPosts(unique);
    await fbSavePagePosts(unique);

    let reviews = null;
    if (opts.includeReviews) reviews = await fbScrapePageReviews(client, ref, 30);

    const audit = computePageAudit(profile, unique, { reviews });

    if (pageRow?.id) {
        await supabase.from('fb_pages').update({
            page_score: audit.score,
            score_breakdown: audit.scoreBreakdown,
            posts_per_week: audit.cadence?.postsPerWeek || 0,
            engagement_rate: audit.engagementRate || 0,
            last_scraped_at: new Date().toISOString()
        }).eq('id', pageRow.id);
    }

    return { audit, rows: unique, pageRow };
}

// ===========================================================================
// FB PAGE API :: ESTIMATE
// ===========================================================================

app.get('/api/fb/page/estimate-credits', async (req, res) => {
    const ctx = await auth(req, res); if (!ctx) return;
    const pages = Math.min(parseInt(req.query.pages || '1', 10), 2);
    const posts = Math.min(parseInt(req.query.posts || FB_PAGE_DEFAULT_POSTS, 10), FB_PAGE_MAX_POSTS);
    const withReviews = req.query.reviews === 'true' || req.query.reviews === '1';
    res.json({
        pages, postsPerPage: posts, totalPosts: pages * posts, includeReviews: withReviews,
        estimatedUsd: fbPageEstimateCredits(pages, posts, withReviews),
        note: 'Estimate only. Actual Apify billing depends on the actor and how many posts the page actually returns.'
    });
});

// ===========================================================================
// FB PAGE API :: RUN A REPORT  (async job, poll /api/job/:id)
// ===========================================================================

app.post('/api/fb/page-report', spendLimit, async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_page'); if (!ctx) return;
        await assertJobSlot(ctx.user.id);

        const {
            target, rival, postsPerPage, days,
            includeReviews = false, setName, setId, brief
        } = req.body;

        const targetRef = parsePageRef(target);
        if (!targetRef) {
            return res.status(400).json({
                error: 'Enter a valid Facebook Page URL or handle. Group URLs are not supported here — use the Community Audit page for groups.'
            });
        }

        const rivalRef = rival ? parsePageRef(rival) : null;
        if (rival && !rivalRef) return res.status(400).json({ error: 'The rival Page URL or handle could not be read.' });
        if (rivalRef && rivalRef.pageId === targetRef.pageId) {
            return res.status(400).json({ error: 'The rival must be a different Page from the target.' });
        }

        const limit = Math.min(parseInt(postsPerPage || FB_PAGE_DEFAULT_POSTS, 10), FB_PAGE_MAX_POSTS);
        const window = Math.min(parseInt(days || FB_PAGE_DEFAULT_DAYS, 10), FB_PAGE_MAX_DAYS);
        const pageCount = rivalRef ? 2 : 1;
        const estimate = fbPageEstimateCredits(pageCount, limit, includeReviews);

        // Re-runnable pair, so the same target+rival can be tracked over time.
        let activeSetId = setId || null;
        if (!activeSetId && setName) {
            const { data: set } = await supabase.from('fb_page_sets').insert([{
                user_id: ctx.user.id,
                name: setName,
                target_page: targetRef.pageId,
                target_url: targetRef.url,
                rival_page: rivalRef?.pageId || null,
                rival_url: rivalRef?.url || null,
                posts_per_page: limit,
                days_window: window
            }]).select('id').maybeSingle();
            activeSetId = set?.id || null;
        }

        const since = new Date(Date.now() - window * 86400000).toISOString().slice(0, 10);

        const job = await createJob(ctx.user.id, 'fb_page_report', 'fb_page', {
            target: targetRef.url, rival: rivalRef?.url || null,
            postsPerPage: limit, days: window, includeReviews, setId: activeSetId,
            brief: brief ? String(brief).slice(0, 600) : null, since
        }, estimate);

        runJob(job.id, JOB_WORKERS['fb_page_report'](ctx.user.id, job.input, job.id));

        res.status(202).json({
            success: true,
            jobId: job.id,
            setId: activeSetId,
            target: targetRef.pageId,
            rival: rivalRef?.pageId || null,
            pages: pageCount,
            postsPerPage: limit,
            days: window,
            estimatedUsd: estimate
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ===========================================================================
// FB PAGE API :: REPORT VAULT
// ===========================================================================

app.get('/api/fb/page-reports', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_page'); if (!ctx) return;
        const { data, error } = await supabase.from('reports')
            .select('id, target_handle, competitor_handles, fb_page_ids, fb_page_names, audit_mode, grade, score, engagement_rate, posts_analyzed, snapshot_date, created_at, ai_summary, set_id, credits_estimate')
            .eq('user_id', ctx.user.id)
            .eq('platform', 'facebook')
            .eq('report_type', 'fb_page')
            .order('created_at', { ascending: false })
            .limit(200);
        if (error) throw error;
        res.json({ reports: data || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fb/page-report/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_page'); if (!ctx) return;
        const { data } = await supabase.from('reports').select('*')
            .eq('id', req.params.id).eq('user_id', ctx.user.id).maybeSingle();
        if (!data) return res.status(404).json({ error: 'Report not found' });
        res.json({ report: data });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/fb/page-report/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_page'); if (!ctx) return;
        const { error } = await supabase.from('reports')
            .delete().eq('id', req.params.id).eq('user_id', ctx.user.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===========================================================================
// FB PAGE API :: SAVED PAIRS + TREND
// ===========================================================================

app.get('/api/fb/page-sets', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_page'); if (!ctx) return;
        const { data } = await supabase.from('fb_page_sets')
            .select('*').eq('user_id', ctx.user.id).order('created_at', { ascending: false });
        res.json({ sets: data || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/fb/page-sets/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_page'); if (!ctx) return;
        const { error } = await supabase.from('fb_page_sets')
            .delete().eq('id', req.params.id).eq('user_id', ctx.user.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/** Snapshot-to-snapshot drift for one saved pair. */
app.get('/api/fb/page-trend/:setId', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_page'); if (!ctx) return;

        const { data: runs } = await supabase.from('reports')
            .select('id, snapshot_date, created_at, score, grade, engagement_rate, posts_analyzed, report_json')
            .eq('set_id', req.params.setId).eq('user_id', ctx.user.id)
            .eq('report_type', 'fb_page')
            .order('created_at', { ascending: true });

        if (!runs || !runs.length) return res.json({ runs: [], delta: null });

        const points = runs.map(r => ({
            reportId: r.id,
            date: r.snapshot_date || r.created_at?.slice(0, 10),
            score: r.score,
            grade: r.grade,
            engagementRate: r.engagement_rate,
            postsAnalyzed: r.posts_analyzed,
            followers: r.report_json?.target?.followers ?? null,
            postsPerWeek: r.report_json?.target?.cadence?.postsPerWeek ?? null,
            conversationRate: r.report_json?.target?.conversationRate ?? null,
            rivalScore: r.report_json?.rival?.score ?? null,
            wins: r.report_json?.benchmark?.wins ?? null
        }));

        let delta = null;
        if (points.length > 1) {
            const a = points[points.length - 2], b = points[points.length - 1];
            delta = {
                from: a.date, to: b.date,
                days: Math.round((new Date(b.date) - new Date(a.date)) / 86400000),
                score: (b.score || 0) - (a.score || 0),
                engagementRate: +((b.engagementRate || 0) - (a.engagementRate || 0)).toFixed(3),
                followers: (b.followers || 0) - (a.followers || 0),
                postsPerWeek: +((b.postsPerWeek || 0) - (a.postsPerWeek || 0)).toFixed(1),
                gapToRival: (b.rivalScore != null && a.rivalScore != null)
                    ? ((b.score || 0) - b.rivalScore) - ((a.score || 0) - a.rivalScore) : null
            };
        }

        res.json({ runs: points, delta });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===========================================================================
// FB PAGE API :: SAVED PAGES + POST-LEVEL DATA
// ===========================================================================

app.get('/api/fb/pages', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_page'); if (!ctx) return;
        const { data } = await supabase.from('fb_pages')
            .select('id, page_id, name, url, category, followers, likes, verified, page_score, engagement_rate, posts_per_week, last_scraped_at')
            .eq('user_id', ctx.user.id)
            .order('last_scraped_at', { ascending: false })
            .limit(200);
        res.json({ pages: data || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fb/page-posts', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_page'); if (!ctx) return;
        const pageId = String(req.query.page_id || '').trim().toLowerCase();
        if (!pageId) return res.status(400).json({ error: 'page_id required' });

        let q = supabase.from('fb_page_posts')
            .select('post_id, post_url, content, media_type, intent_type, opening_pattern, length_band, hashtags, reactions_total, reactions_breakdown, comments, shares, views, performance_index, posted_at, hour_local, dow_local, has_link, has_cta, has_question, is_provisional')
            .eq('user_id', ctx.user.id).eq('page_id', pageId);

        if (req.query.sort === 'top') q = q.order('performance_index', { ascending: false, nullsFirst: false });
        else q = q.order('posted_at', { ascending: false });

        const { data } = await q.limit(Math.min(parseInt(req.query.limit || '100', 10), 500));
        res.json({ pageId, posts: data || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===========================================================================
const PORT = process.env.PORT || 10000;

app.listen(PORT, async () => {
    console.log(`Edgelead master engine active on port ${PORT}`);
    console.log(`[config] budget=${BUDGET_MODE} credit=$${APIFY_CYCLE_CREDIT}/key/cycle ` +
                `memory=${APIFY_MEMORY_MB}MB timeout=${APIFY_TIMEOUT_SECS}s ` +
                `proxy=${APIFY_PROXY_GROUP || 'actor default'} model=${GEMINI_MODEL}`);

    // Jobs run in-process. Render's free tier sleeps on idle and restarts on
    // every deploy, so anything still marked running at boot is orphaned.
    await sweepStaleJobs();
    setInterval(sweepStaleJobs, Math.max(5, JOB_STALE_MINUTES) * 60000).unref?.();
    setInterval(reviveStaleKeys, 3600000).unref?.();
});
