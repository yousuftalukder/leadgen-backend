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
 * PHASE 4 — Instagram parity:
 *   - igNormalisePost(): derived-feature pass on every post, matching the
 *     Facebook Page engine (intent, opening, length band, flags, aspect
 *     ratio, carousel depth, audio, provisional flagging)
 *   - igIndexPosts(): each post scored against the account's own monthly
 *     median, so growth over the window does not make old posts look bad
 *   - Median-first aggregation throughout. One breakout reel no longer sets
 *     the account's engagement rate, its best posting hour or its "always use
 *     emoji" recommendation.
 *   - Reels get a 48h settle window, stills 24h. A reel scraped six hours
 *     after posting is an unfinished post, not a weak one.
 *   - Score v2: seven bounded pillars with a returned breakdown. scoreV1 is
 *     carried alongside so vault reports stay comparable.
 *   - /api/admin/cost-reality: validates the estimate constants against the
 *     settled usage ledger.
 *   - /api/admin/rotate-encryption-key: re-wraps every secret under a new key.
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
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
require('dotenv').config();

// Per-request / per-job context. Lets deep helpers (the Gemini pool) know
// which user a call is for without threading userId through every signature.
const ELS = new AsyncLocalStorage();

// ===========================================================================
// OBSERVABILITY
// Structured JSON logs, in-process counters, a bounded error ring buffer and
// an optional webhook for the handful of events that are actually worth
// waking someone up for. No new dependency: everything here is node builtins.
// ===========================================================================
const BOOT_TS   = Date.now();
const APP_VERSION = process.env.APP_VERSION || 'phase11';
const LOG_LEVELS  = { debug: 10, info: 20, warn: 30, error: 40 };
const LOG_LEVEL   = LOG_LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || 20;
const SLOW_REQUEST_MS = parseInt(process.env.SLOW_REQUEST_MS || '4000', 10);

const ALERT_WEBHOOK   = (process.env.ALERT_WEBHOOK_URL || '').trim();
const ALERT_THROTTLE_MIN = parseInt(process.env.ALERT_THROTTLE_MINUTES || '15', 10);
const RUN_COST_ALERT_USD = parseFloat(process.env.APIFY_RUN_COST_ALERT_USD || '0.75');

const METRICS = {
    http:   { total: 0, errors: 0, slow: 0, byStatus: {} },
    apify:  { runs: 0, failures: 0, emptyRuns: 0, usd: 0, items: 0 },
    gemini: { calls: 0, ok: 0, failed: 0, retries: 0 },
    jobs:   { started: 0, resumed: 0, done: 0, failed: 0, paused: 0, interrupted: 0, cancelled: 0 },
    keys:   { invalid: 0, exhausted: 0, transient: 0, noCreditEvents: 0 }
};

METRICS.rotation = { readsViaOldKey: 0 };
METRICS.ai = { ok: 0, failed: 0, truncated: 0, promptChars: 0, dropped: 0 };
METRICS.authCache = { hit: 0, miss: 0 };

const RECENT_EVENTS = [];          // last 100 warn/error lines, for /api/admin/metrics
const _alertSent = new Map();

// This grows for the life of the process, and its keys embed truncated error
// messages ('job_failed:' + message.slice(0,40)), so the key space is
// unbounded rather than merely large. Same treatment the auth cache and the
// rate-limit buckets already get.
setInterval(() => {
    const now = Date.now();
    const ttl = Math.max(ALERT_THROTTLE_MIN * 60000 * 4, 3600000);
    for (const [k, t] of _alertSent) if (now - t > ttl) _alertSent.delete(k);
}, 900000).unref?.();

function log(level, event, fields = {}) {
    if ((LOG_LEVELS[level] || 20) < LOG_LEVEL) return;
    const line = { t: new Date().toISOString(), level, event, ...fields };
    const text = JSON.stringify(line);
    if (level === 'error') console.error(text);
    else if (level === 'warn') console.warn(text);
    else console.log(text);
    if (level === 'warn' || level === 'error') {
        RECENT_EVENTS.push(line);
        if (RECENT_EVENTS.length > 100) RECENT_EVENTS.shift();
    }
}
const logger = {
    debug: (e, f) => log('debug', e, f),
    info:  (e, f) => log('info',  e, f),
    warn:  (e, f) => log('warn',  e, f),
    error: (e, f) => log('error', e, f)
};

/**
 * Fire an alert at most once per throttle window per key. Slack-shaped body,
 * which also works for Discord (/slack), Google Chat and most generic hooks.
 */
async function alertOnce(key, text, fields = {}) {
    logger.warn('alert', { alert: key, text, ...fields });
    if (!ALERT_WEBHOOK) return;
    const now = Date.now();
    const last = _alertSent.get(key) || 0;
    if (now - last < ALERT_THROTTLE_MIN * 60000) return;
    _alertSent.set(key, now);
    try {
        await fetch(ALERT_WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: `[edgelead] ${text}` +
                      (Object.keys(fields).length ? `\n\`\`\`${JSON.stringify(fields, null, 1)}\`\`\`` : '')
            })
        });
    } catch (e) { logger.error('alert_webhook_failed', { message: e.message }); }
}

process.on('unhandledRejection', (err) => {
    logger.error('unhandled_rejection', { message: err?.message, stack: (err?.stack || '').slice(0, 800) });
    alertOnce('unhandled_rejection', 'Unhandled promise rejection: ' + (err?.message || 'unknown'));
});
// Set by start() once every route is registered. Until then an exception is a
// boot failure, and the only honest response is to exit non-zero: carrying on
// leaves a process that answers /api/health (registered early) while every
// route after the throw does not exist. That is worse than being down —
// nothing alarms and half the product 404s. Exactly this happened once, with
// exit code 0, and eleven test files reported "ok" having run nothing.
let BOOTED = false;
process.on('uncaughtException', (err) => {
    logger.error('uncaught_exception', { message: err?.message, stack: (err?.stack || '').slice(0, 800), booted: BOOTED });
    alertOnce('uncaught_exception', 'Uncaught exception: ' + (err?.message || 'unknown'));
    if (!BOOTED) {
        // eslint-disable-next-line no-console
        console.error('FATAL during boot: ' + (err?.stack || err?.message || err));
        process.exit(1);
    }
});

// ===========================================================================
// SECRETS AT REST
// Apify tokens are other people's money. The service role key bypasses RLS, so
// a leaked database dump used to hand over every customer's Apify account.
// Tokens are now sealed with AES-256-GCM before they touch the database and
// only ever opened in memory, immediately before an Apify call.
//
// Set APP_ENCRYPTION_KEY to a 64-char hex string (openssl rand -hex 32).
// If it is unset the code still runs and stores plaintext, exactly as before,
// so a missing env var degrades rather than breaks. It shouts about it at boot.
// ===========================================================================
const ENC_PREFIX = 'encv1:';

const ENC_KEY = (() => {
    const raw = (process.env.APP_ENCRYPTION_KEY || '').trim();
    if (!raw) return null;
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
    // Any other string is accepted and stretched, so a passphrase works too.
    return crypto.createHash('sha256').update(raw).digest();
})();

// Add next to ENC_KEY. Unset in normal operation.
// Accepts the same two forms ENC_KEY does — 64-char hex, or any other string
// stretched through sha256. If it only took hex, an installation that set a
// passphrase could never rotate away from it.
const ENC_KEY_OLD = (() => {
    const raw = (process.env.APP_ENCRYPTION_KEY_OLD || '').trim();
    if (!raw) return null;
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
    return crypto.createHash('sha256').update(raw).digest();
})();

function isEncrypted(v) { return typeof v === 'string' && v.startsWith(ENC_PREFIX); }

function encryptSecret(plain) {
    if (!plain || !ENC_KEY || isEncrypted(plain)) return plain;
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
    const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
    return ENC_PREFIX + [iv, c.getAuthTag(), ct].map(b => b.toString('base64')).join(':');
}

function openSealed(stored, key) {
    const [, ivB, tagB, ctB] = String(stored).split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64'));
    d.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ctB, 'base64')), d.final()]).toString('utf8');
}

/**
 * Read a stored secret.
 *
 * Falls back to APP_ENCRYPTION_KEY_OLD when it is set and the current key
 * cannot open the row. Without that fallback the gap between "deploy the new
 * key" and "run the rotation" is a hard outage: every token in the database is
 * sealed under a key the running process refuses to try, so key resolution,
 * /api/actor-status and every run in that window fail. With it, rotation is a
 * background operation.
 *
 * `currentKeyOnly` disables the fallback. rotateEncryptionKey() needs that to
 * tell "already re-wrapped under the new key" apart from "still under the old
 * one" — without it every row would look already-done and nothing would rotate.
 */
function decryptSecret(stored, opts = {}) {
    if (!stored) return stored;
    if (!isEncrypted(stored)) return stored;          // legacy plaintext row
    if (!ENC_KEY && !ENC_KEY_OLD) {
        throw new Error('APP_ENCRYPTION_KEY is missing but encrypted keys exist in the database.');
    }
    if (ENC_KEY) {
        try { return openSealed(stored, ENC_KEY); }
        catch (err) {
            if (opts.currentKeyOnly || !ENC_KEY_OLD) throw err;
        }
    }
    const plain = openSealed(stored, ENC_KEY_OLD);
    METRICS.rotation.readsViaOldKey += 1;
    return plain;
}

/** Never print a whole token. */
function maskSecret(v) {
    const s = String(v || '');
    if (s.length < 12) return '****';
    return s.slice(0, 8) + '...' + s.slice(-4);
}

const app = express();

// Render terminates TLS at its edge, so without this every request reports the
// proxy's address as req.ip and the per-IP rate limiter degenerates into one
// global bucket — unable to throttle an individual, able to lock out everyone.
app.set('trust proxy', 1);

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

// Each limiter counts in its own namespace. They used to share the map by
// bare key, which made every limiter with the same key type ONE bucket: the
// per-request read limit (240/min) and the job-start limit (6/min) both
// keyed by bearer, so any user who had made six API calls in the last minute
// — one page load — was refused their next job start with 429. And every
// IP-keyed limiter shared too, so a dozen share-link opens from one office
// locked the assistant for the whole office. The sweep below is key-agnostic
// and needs no change.
let _limiterSeq = 0;
function rateLimit({ windowMs = 60000, max = 60, key = null } = {}) {
    const ns = `L${_limiterSeq++}:`;
    return (req, res, next) => {
        const id = ns + ((key ? key(req) : null) || req.ip || 'anon');
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
// Per IP: public routes carry no bearer. Declared here, with the others,
// because every limiter must exist before the first route that names it.
const publicLimit = rateLimit({ windowMs: 60000, max: 30 });
app.use('/api/', readLimit);

// Request accounting. Method and path only — request bodies carry Apify tokens
// and must never reach a log line.
app.use((req, res, next) => ELS.run({ userId: null }, () => next()));

app.use((req, res, next) => {
    const t0 = Date.now();
    res.on('finish', () => {
        const ms = Date.now() - t0;
        const bucket = Math.floor(res.statusCode / 100) + 'xx';
        METRICS.http.total += 1;
        METRICS.http.byStatus[bucket] = (METRICS.http.byStatus[bucket] || 0) + 1;
        if (res.statusCode >= 500) {
            METRICS.http.errors += 1;
            logger.error('http_error', { method: req.method, path: req.path, status: res.statusCode, ms });
            alertOnce('http_5xx:' + req.path, `5xx on ${req.method} ${req.path}`, { status: res.statusCode });
        } else if (ms > SLOW_REQUEST_MS) {
            METRICS.http.slow += 1;
            logger.warn('slow_request', { method: req.method, path: req.path, status: res.statusCode, ms });
        }
    });
    next();
});

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
// Default only. The pool discovers what the key can actually call (models.list)
// and prefers the newest flash line; a 404 here is no longer fatal.
const GEMINI_MODEL           = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MAX_COMPETITORS        = parseInt(process.env.MAX_COMPETITORS || '10', 10);
const DEFAULT_POSTS_PER_ACC  = parseInt(process.env.DEFAULT_POSTS_PER_ACCOUNT || '30', 10);
const MAX_POSTS_PER_ACC      = parseInt(process.env.MAX_POSTS_PER_ACCOUNT || '100', 10);
const ENGINES                = ['leadgen', 'report', 'fb_community', 'fb_page', 'meta_owned', 'content_plan'];
/** Human names for the engines, so the admin panel does not keep its own copy. */
const ENGINE_LABELS = {
    leadgen:      'Lead finder',
    report:       'Reports & competitors',
    fb_community: 'Facebook communities',
    fb_page:      'Facebook Pages',
    meta_owned:   'Meta owner data',
    content_plan: 'Content plan'
};

// What a self-serve trial account is granted at signup. Everything here is
// still held to the trial quota on top of the grant.
const TRIAL_ENGINES = (process.env.TRIAL_ENGINES || 'report,fb_community,leadgen,meta_owned')
    .split(',').map(s => s.trim()).filter(e => ENGINES.includes(e));

// --- Facebook community engine ---------------------------------------------
// Actor IDs are env-overridable on purpose: Apify's Facebook actors get
// renamed and re-published far more often than the Instagram ones.
const FB_GROUP_POSTS_ACTOR = process.env.FB_GROUP_POSTS_ACTOR || 'apify/facebook-groups-scraper';
const FB_SEARCH_ACTOR      = process.env.FB_SEARCH_ACTOR      || 'apify/facebook-search-scraper';
const FB_COMMENTS_ACTOR    = process.env.FB_COMMENTS_ACTOR    || 'apify/facebook-comments-scraper';
const FB_MAX_GROUPS        = parseInt(process.env.FB_MAX_GROUPS        || '15', 10);
// Groups selected by default when the caller does not say. Kept well under
// FB_MAX_GROUPS so an accidental run cannot eat a whole cycle of credit.
const FB_DEFAULT_GROUPS    = parseInt(process.env.FB_DEFAULT_GROUPS     || '5', 10);
const FB_DEFAULT_POSTS     = parseInt(process.env.FB_DEFAULT_POSTS_PER_GROUP || '40', 10);
const FB_MAX_POSTS         = parseInt(process.env.FB_MAX_POSTS_PER_GROUP     || '400', 10);
const FB_DEFAULT_DAYS      = parseInt(process.env.FB_DEFAULT_DAYS_WINDOW     || '60', 10);
const FB_TZ_OFFSET_MINS    = parseInt(process.env.FB_TZ_OFFSET_MINUTES || '360', 10); // default Asia/Dhaka +6
const COST_PER_1K_FB_POSTS = parseFloat(process.env.COST_PER_1K_FB_POSTS || '3.50');
const FB_COMMENT_WEIGHT    = parseFloat(process.env.FB_COMMENT_WEIGHT || '3');
const FB_SHARE_WEIGHT      = parseFloat(process.env.FB_SHARE_WEIGHT   || '4');

// Rough Apify pricing used for the pre-run estimate only.
const COST_PER_1K_POSTS   = parseFloat(process.env.COST_PER_1K_POSTS   || '2.30');
const COST_PER_1K_PROFILE = parseFloat(process.env.COST_PER_1K_PROFILE || '2.30');

// Discovery methods asked for 1000 results per call with no cap and no cost
// estimate, so one campaign with five methods selected could fire eight
// ungated thousand-result scrapes against a key the budget system believed it
// was protecting. The limit is now a config value AND the basis of the
// estimate, so the two can never drift apart.
const LEADGEN_RESULTS_LIMIT = parseInt(process.env.LEADGEN_RESULTS_LIMIT || '1000', 10);
const LEADGEN_UNIT_USD      = +((LEADGEN_RESULTS_LIMIT / 1000) * COST_PER_1K_POSTS).toFixed(4);

// --- Instagram analysis layer (phase 4) -------------------------------------
const IG_COMMENT_WEIGHT = parseFloat(process.env.IG_COMMENT_WEIGHT || '4');

// How long a post keeps accumulating before its numbers mean anything.
// A still image is close to settled inside a day. A reel is not — reels keep
// being served to non-followers for days, so a reel scraped six hours after
// posting is not a weak reel, it is an unfinished one. Averaging it in with
// settled posts is the single biggest source of false "your reels are dying"
// readings, which is why the two windows are separate.
const IG_PROVISIONAL_HOURS      = parseFloat(process.env.IG_PROVISIONAL_HOURS || '24');
const IG_REEL_PROVISIONAL_HOURS = parseFloat(process.env.IG_REEL_PROVISIONAL_HOURS || '48');

// Instagram timestamps come back in UTC. Local hour-of-day is what a posting
// schedule is actually built on, so shift once, here. Defaults to the same
// offset the FB engine uses so a mixed IG+FB account reads one clock.
const IG_TZ_OFFSET_MINS = parseInt(process.env.IG_TZ_OFFSET_MINUTES || String(FB_TZ_OFFSET_MINS), 10);

// Below this many posts the score is reported but flagged. Same threshold as
// the FB page score, for the same reason: under ~12 posts a single outlier
// moves the median enough that the index stops meaning anything.
const IG_MIN_CONFIDENT_POSTS = parseInt(process.env.IG_MIN_CONFIDENT_POSTS || '12', 10);

// v1 score is kept alongside v2 so reports already in the vault stay
// comparable. Set IG_SCORE_V2=false to keep v1 as the headline number.
const IG_SCORE_V2 = String(process.env.IG_SCORE_V2 || 'true') !== 'false';

// Which scoring scale a saved report was graded on.
//
// reports.score used to record a number with no note of which formula produced
// it, and /api/set-trend diffs that column across snapshots. Flip IG_SCORE_V2
// — or simply deploy the v2 patch mid-cohort — and the delta the user reads as
// "the account declined 13 points" is entirely an artifact of the change.
// Recording the version makes the series self-describing, so the trend
// endpoint can plot a comparable scale instead of guessing.
const IG_SCORE_VERSION = IG_SCORE_V2 ? 2 : 1;

const IG_URL_RE = /https?:\/\/\S+|\b(?:link in bio|linkinbio|bio link|swipe up)\b/i;

// --- Apify run shaping ------------------------------------------------------
// Compute units are billed as RAM(GB) x hours, so memory is a direct cost lever.
// Leaving this unset used to inherit the actor default, which is often 4-8 GB.
const APIFY_MEMORY_MB    = parseInt(process.env.APIFY_MEMORY_MBYTES   || '2048', 10);
const APIFY_TIMEOUT_SECS = parseInt(process.env.APIFY_RUN_TIMEOUT_SECS || '900', 10);
// '' keeps the actor's own proxy default. Set to DATACENTER to avoid paying
// residential proxy rates ($8/GB on the free plan) where the target allows it.
const APIFY_PROXY_GROUP  = (process.env.APIFY_PROXY_GROUP || '').trim().toUpperCase();

// --- Budget ledger ----------------------------------------------------------
// Default cycle credit for a key that has no explicit limit of its own.
// Every key row can override this with apify_keys.monthly_credit_usd, so a
// customer on a paid Apify plan is no longer capped at the free-tier number.
const APIFY_CYCLE_CREDIT = parseFloat(process.env.APIFY_MONTHLY_CREDIT_USD || '5');
// 'off'   - track only
// 'warn'  - track, expose remaining, never block
// 'block' - refuse to start a unit the current key cannot afford (recommended)
const BUDGET_MODE        = (process.env.BUDGET_MODE || 'block').toLowerCase();
const BUDGET_RESERVE     = parseFloat(process.env.BUDGET_RESERVE_USD || '0.05');

// --- Job engine -------------------------------------------------------------
// A job mid-actor-call emits no progress tick, so the staleness window must be
// longer than the longest possible single call. The default used to be exactly
// APIFY_RUN_TIMEOUT_SECS, which meant the sweep parked LIVE jobs as resumable
// and then invited the user to start a second copy of one still running.
const JOB_STALE_MINUTES  = Math.max(
    parseInt(process.env.JOB_STALE_MINUTES || '15', 10),
    Math.ceil((APIFY_TIMEOUT_SECS + 300) / 60)
);
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
        // Reaching here means nobody provisioned this account, which since
        // phase 13 is the signature of a self-serve signup: an employee gets
        // an app_users row from POST /api/admin/users before they ever log in,
        // so they never take this branch. A self-serve account is a client on
        // a trial, not an employee with no grants.
        //
        // Bootstrap still wins: master admin by env, or the very first user if
        // no admin exists yet.
        let role = 'client';
        if (MASTER_ADMIN_EMAIL && email === MASTER_ADMIN_EMAIL) {
            role = 'admin';
        } else {
            const { count } = await supabase
                .from('app_users').select('id', { count: 'exact', head: true }).eq('role', 'admin');
            if (!count) role = 'admin';
        }

        const row = {
            id: user.id, email, role, is_active: true,
            updated_at: new Date().toISOString()
        };

        if (role === 'client') {
            const days  = await trialDaysSetting();
            const start = new Date();
            row.trial_started_at = start.toISOString();
            row.trial_ends_at    = new Date(start.getTime() + days * 86400000).toISOString();
            // A trial spends the shared pool, so it can never fall back to a
            // company key beyond what quota allows. byo_key_only stays false:
            // the point of the trial is that they do not need a key yet.
        }

        const { data: created } = await supabase.from('app_users').upsert(row)
            .select().maybeSingle();

        profile = created || row;

        if (role === 'admin') {
            for (const e of ENGINES) {
                await supabase.from('user_engine_access')
                    .upsert({ user_id: user.id, engine: e }, { onConflict: 'user_id,engine' });
            }
        } else if (role === 'client') {
            // What a trial can reach. fb_page and content_plan are deliberately
            // absent — those are the paid surface. meta_owned is present even
            // though it is the upsell, because connecting Meta costs no Apify
            // and it is the thing worth showing off.
            for (const e of TRIAL_ENGINES) {
                await supabase.from('user_engine_access')
                    .upsert({ user_id: user.id, engine: e }, { onConflict: 'user_id,engine' });
            }
            // A client account is a business from the first minute, so its
            // record exists before its first run rather than being conjured
            // by one. Everything it does files under this.
            await ownClientFor({ user, profile }).catch(e => logger.warn('own_client_create_failed', { message: e.message }));
        }
        // role 'user' is never minted here: employees are created by an admin.
    } else if (MASTER_ADMIN_EMAIL && email === MASTER_ADMIN_EMAIL && profile.role !== 'admin') {
        await supabase.from('app_users').update({ role: 'admin' }).eq('id', user.id);
        profile.role = 'admin';
    }

    return profile;
}

/**
 * Short-lived resolved-caller cache.
 *
 * auth() is three network round trips: getUser() against GoTrue, then
 * app_users, then user_engine_access on engine routes. A single running job is
 * polled every 2.5s, so an untouched cache costs ~72 round trips per minute
 * per active job and puts GoTrue latency on the critical path of every poll.
 *
 * The TTL is deliberately short. A disabled account or a revoked engine grant
 * takes effect within AUTH_CACHE_MS rather than instantly, and the admin
 * endpoints that change either one call invalidateAuth() so the common case is
 * immediate anyway.
 */
const AUTH_CACHE_MS = parseInt(process.env.AUTH_CACHE_MS || '45000', 10);
const _authCache = new Map();

function invalidateAuth(userId = null) {
    if (!userId) { _authCache.clear(); return; }
    for (const [k, v] of _authCache) if (v.ctx?.user?.id === userId) _authCache.delete(k);
}

setInterval(() => {
    const now = Date.now();
    for (const [k, v] of _authCache) if (now - v.t > AUTH_CACHE_MS) _authCache.delete(k);
}, 60000).unref?.();

/**
 * What an account is right now. Mirrors public.el_account_state() exactly —
 * suspension beats everything, role beats dates, paid beats trial.
 *
 * Two implementations on purpose. This one runs on every authenticated
 * request and reads the profile auth() has already cached, so it costs
 * nothing. The SQL one is what createJob and the admin panel call, because
 * that is where money is committed and a stale cache must not be the thing
 * deciding. If they ever disagree, the SQL one wins and the worst case is up
 * to AUTH_CACHE_MS of grace on a request that spends nothing.
 *
 * Returns: suspended | admin | employee | paid | trial | expired
 */
function accountState(profile) {
    if (!profile) return 'expired';
    if (profile.is_active !== true)  return 'suspended';
    if (profile.role === 'admin')    return 'admin';
    if (profile.role !== 'client')   return 'employee';

    const now = Date.now();
    const paid  = profile.paid_until    ? Date.parse(profile.paid_until)    : 0;
    const trial = profile.trial_ends_at ? Date.parse(profile.trial_ends_at) : 0;
    if (paid  > now) return 'paid';
    if (trial > now) return 'trial';
    return 'expired';
}

/**
 * One place that decides whether an account may be served at all, so the
 * cached and uncached paths through auth() cannot drift apart.
 *
 * 402 rather than 403 for a lapsed account: the client surface needs to tell
 * "your trial ended, here is how to continue" apart from "you may not do this",
 * and it cannot if both arrive as 403.
 */
function accountDenial(profile) {
    const state = accountState(profile);
    // `code` matches what reserveQuota sends for the same states, so a page
    // reads one field whichever door refused it. The front door used to send
    // `state` for expired and nothing machine-readable for suspended, which
    // left a disabled account looking like a network failure.
    if (state === 'suspended') {
        return { status: 403, body: { error: 'Account disabled. Contact your administrator.', code: 'account_suspended', state: 'suspended' } };
    }
    if (state === 'expired') {
        const had = profile?.paid_until || profile?.trial_ends_at;
        return {
            status: 402,
            body: {
                error: had
                    ? 'Your access has ended. Contact us to continue.'
                    : 'This account has no active plan. Contact us to get started.',
                code: 'account_expired',
                state: 'expired',
                ended_at: had || null,
                // So the expired screen can say "you already asked, on <date>"
                // instead of offering the button a second time.
                activation_requested_at: profile?.activation_requested_at || null
            }
        };
    }
    return null;
}

/** Resolves the caller. Returns null and writes the response on failure. */
/**
 * `allowLapsed`: let an EXPIRED account through, still refusing a suspended
 * one. Exactly one route asks for it — the request to continue — because the
 * moment a trial ends is the moment the business model needs the client to be
 * able to say "yes", and the door was locked from the inside.
 */
async function auth(req, res, { allowLapsed = false } = {}) {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) { res.status(401).json({ error: 'Unauthorized' }); return null; }

    const ck = tokenHash(token);
    const hit = _authCache.get(ck);
    if (hit && Date.now() - hit.t < AUTH_CACHE_MS) {
        METRICS.authCache.hit += 1;
        const denyCached = accountDenial(hit.ctx.profile);
        if (denyCached && !(allowLapsed && denyCached.status === 402)) { res.status(denyCached.status).json(denyCached.body); return null; }
        const st0 = ELS.getStore(); if (st0) st0.userId = hit.ctx.user.id;
        return hit.ctx;
    }
    METRICS.authCache.miss += 1;

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
        _authCache.delete(ck);
        res.status(401).json({ error: 'Unauthorized' });
        return null;
    }

    const profile = await ensureProfile(data.user);
    // is_active is explicit on the fallback: accountState() reads it, and an
    // absent flag would otherwise read as suspended and lock out every caller
    // the moment ensureProfile has a bad minute.
    const ctx = { user: data.user, profile: profile || { role: 'user', is_active: true } };
    _authCache.set(ck, { ctx, t: Date.now() });
    const st1 = ELS.getStore(); if (st1) st1.userId = ctx.user.id;

    const denyFresh = profile ? accountDenial(profile) : null;
    if (denyFresh && !(allowLapsed && denyFresh.status === 402)) { res.status(denyFresh.status).json(denyFresh.body); return null; }

    return ctx;
}

/**
 * Engine grants are read on every spend route. Same reasoning as the auth
 * cache, same TTL, invalidated by the admin routes that change them.
 */
const _engineCache = new Map();
function invalidateEngineAccess(userId = null) {
    if (!userId) { _engineCache.clear(); return; }
    for (const k of [..._engineCache.keys()]) if (k.startsWith(userId + ':')) _engineCache.delete(k);
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

    const ek = ctx.user.id + ':' + engine;
    const ehit = _engineCache.get(ek);
    let granted;
    if (ehit && Date.now() - ehit.t < AUTH_CACHE_MS) {
        granted = ehit.v;
    } else {
        const { data } = await supabase.from('user_engine_access')
            .select('id').eq('user_id', ctx.user.id).eq('engine', engine).maybeSingle();
        granted = !!data;
        _engineCache.set(ek, { v: granted, t: Date.now() });
    }

    if (!granted) {
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
        if (!data?.value) return null;
        return decryptSecret(data.value);
    } catch (e) {
        logger.error('engine_primary_read_failed', { engine, message: e.message });
        return null;
    }
}

async function setEnginePrimary(engine, token) {
    const { error } = await supabase.from('system_settings').upsert({
        key: primaryKeyName(engine),
        value: encryptSecret(token),
        updated_at: new Date().toISOString()
    }, { onConflict: 'key' });
    if (error) throw error;
}

/**
 * A user marked byo_key_only never falls back to the engine primary or the
 * shared pool. Their runs spend their own credit or they do not run at all.
 * Cached briefly because this is on the hot path of every key resolution.
 */
const _byoCache = new Map();
async function isByoOnly(userId) {
    if (!userId) return false;
    const hit = _byoCache.get(userId);
    if (hit && Date.now() - hit.t < 60000) return hit.v;
    let v = false;
    try {
        const { data } = await supabase.from('app_users')
            .select('byo_key_only').eq('id', userId).maybeSingle();
        v = !!data?.byo_key_only;
    } catch { v = false; }
    _byoCache.set(userId, { v, t: Date.now() });
    return v;
}

/**
 * Cycle credit for an engine primary key. Stored in system_settings so an
 * admin can raise it from the UI without a redeploy, and cached briefly
 * because key resolution happens on every spend.
 */
const _primaryCreditCache = new Map();
async function enginePrimaryCredit(engine) {
    const hit = _primaryCreditCache.get(engine);
    if (hit && Date.now() - hit.t < 60000) return hit.v;
    let v = APIFY_CYCLE_CREDIT;
    try {
        const { data } = await supabase.from('system_settings')
            .select('value').eq('key', primaryKeyName(engine) + '_credit_usd').maybeSingle();
        const n = parseFloat(data?.value || '');
        if (n > 0) v = n;
    } catch { /* fall back to the default */ }
    _primaryCreditCache.set(engine, { v, t: Date.now() });
    return v;
}

/** Ordered list of candidate tokens to try for this engine + user. */
async function buildTokenCandidates(engine, userId) {
    // reviveStaleKeys() used to run here, which meant a database write on every
    // single key resolution — including every page load, via /api/actor-status.
    // It is on an hourly timer and runs at boot, which is what it was always for.
    const out = [];
    const seen = new Set();
    const push = (token, source, id, creditUsd) => {
        if (!token || seen.has(token)) return;
        seen.add(token);
        out.push({
            token, source,
            id: id || null,
            creditUsd: Number(creditUsd) > 0 ? Number(creditUsd) : APIFY_CYCLE_CREDIT
        });
    };

    const open = (row, source) => {
        try { push(decryptSecret(row.token), source, row.id, row.monthly_credit_usd); }
        catch (e) { logger.error('key_decrypt_failed', { keyId: row.id, message: e.message }); }
    };

    // 1. The user's own keys. Scoped by owner_user_id, so a personal key is
    //    only ever tried for the person who added it — it is never lent to
    //    another account and never enters the shared pool.
    if (userId) {
        const { data: mine } = await supabase.from('apify_keys')
            .select('id, token, engine, status, last_used_at, monthly_credit_usd')
            .eq('owner_user_id', userId)
            .eq('status', 'active')
            .in('engine', [engine, 'any'])
            .order('last_used_at', { ascending: true, nullsFirst: true });
        (mine || []).forEach(k => open(k, 'user_pool'));
    }

    // Bring-your-own-key accounts stop here. No shared credit, ever.
    if (await isByoOnly(userId)) {
        if (!out.length) logger.warn('byo_no_key', { userId, engine });
        return out;
    }

    // 2. The engine primary key — always present, never deleted.
    //    Its limit is configurable per engine so a company card on a paid plan
    //    is not throttled to the free-tier default.
    push(await getEnginePrimary(engine), 'engine_primary', null, await enginePrimaryCredit(engine));

    // 3. Global rotation pool (admin-owned keys only: owner_user_id is null)
    const { data: pool } = await supabase.from('apify_keys')
        .select('id, token, engine, status, last_used_at, monthly_credit_usd')
        .is('owner_user_id', null)
        .eq('status', 'active')
        .in('engine', [engine, 'any'])
        .order('last_used_at', { ascending: true, nullsFirst: true });
    (pool || []).forEach(k => open(k, 'global_pool'));

    // 4. Env fallback
    push(process.env.APIFY_API_KEY || process.env.APIFY_API_TOKEN, 'env', null,
         parseFloat(process.env.APIFY_ENV_CREDIT_USD || '') || APIFY_CYCLE_CREDIT);

    return out;
}

// --- Writing a key -----------------------------------------------------------
// token_hash is the identity of a key now. The old unique index sat on the raw
// token with onConflict:'token', which meant anyone who pasted a token already
// in the table silently rewrote that row — including its owner. Same token, new
// owner, no error. Ownership is checked explicitly here instead.
class KeyConflictError extends Error {
    constructor(message) { super(message); this.name = 'KeyConflictError'; this.code = 'KEY_CONFLICT'; }
}

async function findKeyRowByToken(token) {
    const { data } = await supabase.from('apify_keys')
        .select('*').eq('token_hash', tokenHash(token)).maybeSingle();
    return data || null;
}

/**
 * Insert or update one key row. Refuses to touch a row owned by somebody else
 * unless the caller is an admin.
 */
async function saveKeyRow(token, {
    ownerUserId = null, engine = 'any', label = null, apifyUsername = null,
    status = 'active', requester = null
} = {}) {
    const existing = await findKeyRowByToken(token);

    const patch = {
        owner_user_id:   ownerUserId,
        engine, label,
        apify_username:  apifyUsername,
        token:           encryptSecret(token),
        token_hash:      tokenHash(token),
        status,
        fail_count:      0,
        last_checked_at: new Date().toISOString()
    };

    if (!existing) {
        const { data, error } = await supabase.from('apify_keys')
            .insert([patch]).select('id, engine, label, apify_username, status').single();
        if (error) throw error;
        logger.info('key_added', { keyId: data.id, engine, owner: ownerUserId || 'global' });
        return data;
    }

    const isAdmin = requester?.role === 'admin';
    const isMine  = existing.owner_user_id && requester?.id && existing.owner_user_id === requester.id;

    if (!isAdmin && !isMine) {
        logger.warn('key_claim_refused', {
            keyId: existing.id, by: requester?.id || null,
            existingOwner: existing.owner_user_id || 'global'
        });
        throw new KeyConflictError(
            existing.owner_user_id
                ? 'That Apify key is already registered to another account on this system.'
                : 'That Apify key is already in the shared pool. Ask an administrator.'
        );
    }

    // A non-admin re-saving their own key must not be able to move it.
    if (!isAdmin) patch.owner_user_id = existing.owner_user_id;

    const { data, error } = await supabase.from('apify_keys')
        .update(patch).eq('id', existing.id)
        .select('id, engine, label, apify_username, status').single();
    if (error) throw error;
    logger.info('key_updated', { keyId: existing.id, engine });
    return data;
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
        // 402 Payment Required. Without this, a synchronous handler that runs
        // out of credit answers 500, which is both wrong for the caller and
        // counted as a server error by the request logger — so a user with an
        // empty key generated the same alert as a crash.
        this.statusCode = 402;
        Object.assign(this, detail);
    }
}

/**
 * One error responder for every handler.
 *
 * Errors carrying a statusCode are the expected ones — out of credit, job cap
 * reached, bad input. They are the caller's problem, not ours, and must not be
 * reported as 5xx. Anything without a statusCode is genuinely unexpected and
 * still gets 500 plus the alert.
 */
function sendErr(res, err, fallback = 500) {
    const status = err?.statusCode || fallback;
    const body = { error: err?.message || 'Unexpected error' };
    if (err?.code) body.code = err.code;
    if (status >= 500) logger.error('handler_error', {
        message: err?.message, stack: (err?.stack || '').slice(0, 400)
    });
    res.status(status).json(body);
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
        // This check used to sit below the retry loop, where it was
        // unreachable, so a bring-your-own-key account with no key saved was
        // told "no key configured for this engine" rather than the one thing
        // it needed to know: that it cannot fall back to shared credit.
        throw new NoCreditError(await isByoOnly(userId)
            ? 'This account is set to use its own Apify key only, and no working key is saved. ' +
              'Use "Update key" in the header to add one.'
            : 'No Apify key configured for this engine. Use "Update key" in the header to add one.');
    }

    let lastErr = null;
    const skipped = [];

    for (const c of candidates) {
        const hash = tokenHash(c.token);

        // Budget gate BEFORE spending anything. This is what turns a mid-run
        // blowup into a clean, resumable pause.
        //
        // A key is only PARKED as exhausted when it is genuinely dry. Skipping
        // it because one expensive unit does not fit is not the same thing:
        // a key with $0.60 left can still fund four $0.15 units, and marking it
        // exhausted used to strand that credit for KEY_REVIVE_HOURS.
        if (BUDGET_MODE === 'block' && needUsd > 0) {
            const spent = await cycleUsage(hash);
            const remaining = c.creditUsd - spent - BUDGET_RESERVE;
            if (remaining < needUsd) {
                skipped.push({
                    source: c.source,
                    remaining: +Math.max(0, remaining).toFixed(4),
                    neededUsd: +needUsd.toFixed(4)
                });
                if (remaining <= 0) {
                    await markKey(c.id, { status: 'exhausted', last_checked_at: new Date().toISOString() });
                } else {
                    logger.debug('key_skipped_too_small', {
                        source: c.source, remaining: +remaining.toFixed(4), needUsd: +needUsd.toFixed(4)
                    });
                }
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
                creditUsd: c.creditUsd,
                spentThisCycle: spent,
                remaining: +(c.creditUsd - spent).toFixed(4)
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
            METRICS.keys[kind] = (METRICS.keys[kind] || 0) + 1;
            logger.warn('key_failed', { source: c.source, keyId: c.id, kind, message: err.message });
            if (kind === 'invalid') {
                alertOnce('key_invalid:' + (c.id || c.source),
                    `Apify key rejected as invalid (${c.source}). It will stay disabled until someone rechecks it.`,
                    { engine, source: c.source });
            }
        }
    }

    METRICS.keys.noCreditEvents += 1;
    alertOnce('no_credit:' + engine,
        `No Apify key can cover a ${engine} run`,
        { engine, skipped: skipped.length, lastError: lastErr?.message || null });
    logger.error('no_credit', { engine, userId, skipped, lastError: lastErr?.message || null });

    const detail = skipped.length
        ? ` ${skipped.length} key(s) are out of credit for this cycle.`
        : '';
    throw new NoCreditError(
        `No Apify key can cover this run.${detail} Add or update a key, then resume.`,
        { skipped, lastError: lastErr?.message || null }
    );
}

/**
 * What this user can actually afford right now, without spending anything to
 * find out. Used to warn BEFORE the Run button rather than pausing a job at
 * group six of ten — a pause is recoverable, but it is still a worse
 * experience than being told the truth up front.
 */
async function budgetSnapshot(engine, userId, estimateUsd = 0) {
    try {
        const candidates = await buildTokenCandidates(engine, userId);
        const month = cycleMonth();
        let total = 0, best = 0;
        for (const c of candidates) {
            const remaining = Math.max(0, c.creditUsd - await cycleUsage(tokenHash(c.token), month) - BUDGET_RESERVE);
            total += remaining;
            if (remaining > best) best = remaining;
        }
        return {
            keys: candidates.length,
            totalRemainingUsd: +total.toFixed(4),
            largestKeyRemainingUsd: +best.toFixed(4),
            estimatedUsd: +Number(estimateUsd || 0).toFixed(4),
            // A run is affordable when ONE key can cover it, not when the sum
            // of all keys can. getWorkingClient() walks candidates and needs a
            // single key to clear needUsd; it never splits a call across two.
            // Reporting the sum told users a run would go through and then
            // refused it.
            affordable: !(estimateUsd > 0) || best >= estimateUsd,
            splittable: !(estimateUsd > 0) || total >= estimateUsd,
            willPause: BUDGET_MODE === 'block' && estimateUsd > 0 && best < estimateUsd
        };
    } catch (e) {
        logger.warn('budget_snapshot_failed', { engine, message: e.message });
        return null;
    }
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

/**
 * PHASE 11 — plays vs views.
 * getViews() collapses videoPlayCount and videoViewCount into one number,
 * which is what a grade needs. The audit also wants them apart: "views" is
 * what Instagram counts on autoplay, "plays" is a person who kept watching.
 * A reel with many views and few plays is scrolled past, not watched.
 */
function getPlays(i) {
    const v = i.videoPlayCount ?? i.playCount ?? i.plays ?? null;
    return typeof v === 'number' && v > 0 ? v : 0;
}
function getVideoViews(i) {
    const v = i.videoViewCount ?? i.viewCount ?? i.views ?? null;
    return typeof v === 'number' && v > 0 ? v : 0;
}

/**
 * PHASE 11 — bio contact extraction.
 * The profile scraper returns businessEmail / businessPhoneNumber only for
 * accounts that filled in the business fields. Most small accounts put the
 * email, the phone or a wa.me link straight into the bio or the link field,
 * and those were thrown away. Zero Apify cost: it is already in the payload.
 */
const BIO_EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const BIO_PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/;
const BIO_WA_RE    = /(?:wa\.me|api\.whatsapp\.com\/send|whatsapp\.com\/send)[^\s"'<>]*?(?:\/|phone=)\+?(\d{7,15})/i;

function extractBioContacts(profile = {}) {
    const bio = String(profile.biography || '');
    const links = []
        .concat(profile.externalUrl || [], profile.website || [])
        .concat(Array.isArray(profile.bioLinks) ? profile.bioLinks.map(l => (l && (l.url || l.link)) || l) : [])
        .concat(Array.isArray(profile.externalUrls) ? profile.externalUrls.map(l => (l && (l.url || l.link)) || l) : [])
        .map(x => String(x || '')).filter(Boolean);
    const haystack = [bio, ...links].join('\n');

    const email = profile.businessEmail || profile.biographyEmail || profile.publicEmail || profile.email
        || (haystack.match(BIO_EMAIL_RE) || [null])[0] || null;

    let whatsapp = null;
    for (const l of links) { const m = l.match(BIO_WA_RE); if (m) { whatsapp = '+' + m[1]; break; } }
    if (!whatsapp) { const m = haystack.match(BIO_WA_RE); if (m) whatsapp = '+' + m[1]; }
    if (!whatsapp && /whats\s?app/i.test(bio)) {
        const m = bio.match(BIO_PHONE_RE); if (m) whatsapp = m[0].replace(/[^\d+]/g, '');
    }

    let phone = profile.businessPhoneNumber || profile.publicPhoneNumber || profile.contactPhoneNumber || profile.phone || null;
    if (!phone) {
        const m = bio.match(BIO_PHONE_RE);
        if (m) {
            const digits = m[0].replace(/[^\d+]/g, '');
            if (digits.replace(/\D/g, '').length >= 8) phone = digits;
        }
    }
    if (!phone && whatsapp) phone = whatsapp;

    const website = links.find(l => /^https?:\/\//i.test(l) && !BIO_WA_RE.test(l)) || null;
    const sources = [];
    if (email && !(profile.businessEmail || profile.biographyEmail || profile.publicEmail)) sources.push('email:bio');
    if (phone && !(profile.businessPhoneNumber || profile.publicPhoneNumber || profile.contactPhoneNumber)) sources.push('phone:bio');
    if (whatsapp) sources.push('whatsapp:bio');

    return { email: email ? String(email).toLowerCase() : null, phone, whatsapp, website, sources };
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

/**
 * Total USD committed by one key in the current billing cycle: settled spend
 * plus anything currently reserved by a run in flight.
 *
 * Summed in Postgres via el_cycle_spend() rather than pulled row by row, so a
 * key with thousands of runs behind it does not drag the hot path. The RPC is
 * optional — if the migration has not been applied yet this falls back to the
 * old client-side sum, so deploying the server before the SQL degrades rather
 * than breaks.
 */
let _rpcSpendAvailable = true;
async function cycleUsage(hash, month = cycleMonth()) {
    if (!hash) return 0;

    if (_rpcSpendAvailable) {
        try {
            const { data, error } = await supabase.rpc('el_cycle_spend', {
                p_token_hash: hash, p_cycle_month: month
            });
            if (!error) return Number(data || 0);
            _rpcSpendAvailable = false;
            logger.warn('rpc_cycle_spend_unavailable', { message: error.message });
        } catch (e) {
            _rpcSpendAvailable = false;
            logger.warn('rpc_cycle_spend_unavailable', { message: e.message });
        }
    }

    try {
        const { data } = await supabase
            .from('apify_usage_events')
            .select('usage_usd')
            .eq('token_hash', hash)
            .eq('cycle_month', month);
        return (data || []).reduce((sum, r) => sum + Number(r.usage_usd || 0), 0);
    } catch (e) {
        logger.error('cycle_usage_failed', { message: e.message });
        alertOnce('ledger_unreadable',
            'The usage ledger is unreadable, so cycle spend cannot be checked.',
            { message: e.message });
        // Failing open here would silently disable every budget gate in the
        // app: each key reads as having spent nothing and every affordability
        // check passes. That is acceptable when the operator asked only to
        // track spend. It is the opposite of what BUDGET_MODE=block was set
        // for, so in that mode nothing starts until the ledger is readable.
        if (BUDGET_MODE === 'block') {
            throw new Error('Spend cannot be verified right now, so nothing will be started. Try again shortly.');
        }
        return 0;
    }
}

/**
 * Claim budget BEFORE the actor starts.
 *
 * A reservation is a normal ledger row carrying the estimate, flagged
 * is_reservation. Because cycleUsage() sums reservations too, two runs on the
 * same key — in the same process or in two Render instances — can no longer
 * both pass the budget gate and then discover the overspend afterwards. The
 * row is settled with the real cost the moment the run returns, and deleted if
 * the run never happened.
 *
 * Returns a reservation id, or null when reservations are unavailable (the
 * column does not exist yet). A null reservation degrades to exactly the old
 * record-after-the-fact behaviour rather than blocking the run.
 */
async function reserveUsage(client, { actorId, estimateUsd = 0, jobId = null }) {
    const el = client?.__el;
    if (!el || !(estimateUsd > 0)) return null;
    try {
        const { data, error } = await supabase.from('apify_usage_events').insert([{
            user_id:        el.userId || null,
            key_id:         el.keyId || null,
            token_hash:     el.tokenHash,
            apify_username: el.apifyUsername || null,
            engine:         el.engine || null,
            job_id:         jobId || el.jobId || null,
            actor_id:       actorId,
            usage_usd:      +Number(estimateUsd).toFixed(6),
            items:          0,
            is_reservation: true,
            cycle_month:    cycleMonth()
        }]).select('id').single();
        if (error) throw error;
        el.spentThisCycle = Number(el.spentThisCycle || 0) + Number(estimateUsd);
        el.remaining = +(el.creditUsd - el.spentThisCycle).toFixed(4);
        return data.id;
    } catch (e) {
        logger.warn('reserve_failed', { actorId, message: e.message });
        return null;
    }
}

/** Release a reservation for a run that never billed anything. */
async function releaseUsage(client, reservationId, estimateUsd = 0) {
    if (!reservationId) return;
    try { await supabase.from('apify_usage_events').delete().eq('id', reservationId); }
    catch (e) { logger.warn('release_failed', { message: e.message }); }
    const el = client?.__el;
    if (el) {
        el.spentThisCycle = Math.max(0, Number(el.spentThisCycle || 0) - Number(estimateUsd || 0));
        el.remaining = +(el.creditUsd - el.spentThisCycle).toFixed(4);
    }
}

/**
 * Turn a reservation into a settled row carrying the real usageTotalUsd, or
 * write a fresh row when nothing was reserved.
 */
async function recordUsage(client, { actorId, run, items = 0, jobId = null, reservationId = null, reservedUsd = 0, floorUsd = 0 }) {
    const el = client?.__el;
    if (!el) return 0;

    const reported =
        Number(run?.usageTotalUsd) ||
        Number(run?.usage?.USD) ||
        0;

    // floorUsd is set when the run had not settled at read time, so `reported`
    // is a partial figure. Charging the estimate instead of the partial keeps
    // the budget honest; the real number lands in Apify's own ledger either way.
    const usd = Math.max(reported, Number(floorUsd) || 0);

    const row = {
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
    };

    try {
        if (reservationId) {
            await supabase.from('apify_usage_events')
                .update({ ...row, is_reservation: false }).eq('id', reservationId);
            // The estimate was already counted against the cycle. Swap it for
            // the real number rather than adding on top of it.
            el.spentThisCycle = Math.max(0, Number(el.spentThisCycle || 0) - Number(reservedUsd || 0) + usd);
        } else {
            await supabase.from('apify_usage_events').insert([row]);
            el.spentThisCycle = Number(el.spentThisCycle || 0) + usd;
        }
    } catch (e) {
        logger.error('record_usage_failed', { actorId, message: e.message });
    }

    el.remaining = +(el.creditUsd - el.spentThisCycle).toFixed(4);
    return usd;
}

/** Remaining cycle budget for the key currently bound to this client. */
function clientRemaining(client) {
    const el = client?.__el;
    if (!el) return Infinity;
    const credit = Number(el.creditUsd) > 0 ? Number(el.creditUsd) : APIFY_CYCLE_CREDIT;
    return credit - Number(el.spentThisCycle || 0) - BUDGET_RESERVE;
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

    // Claim the estimate up front so a second run on the same key cannot slip
    // through the gate while this one is still in flight.
    const reservationId = await reserveUsage(client, {
        actorId, estimateUsd: estimate, jobId: opts.jobId
    });

    const t0 = Date.now();
    let run;
    try {
        run = await client.actor(actorId).call(payload, runOpts);
    } catch (err) {
        // Older apify-client builds validate run options strictly. If the
        // options are what it rejected, fall back to a bare call rather than
        // failing the whole job.
        const m = (err.message || '').toLowerCase();
        const optionsRejected = m.includes('expected property') || m.includes('did not match') || m.includes('validation');

        if (!optionsRejected) {
            METRICS.apify.failures += 1;
            logger.error('actor_failed', {
                actorId, jobId: opts.jobId || null,
                key: client?.__el?.apifyUsername || null,
                ms: Date.now() - t0, message: err.message
            });
        }

        if (optionsRejected) {
            logger.warn('actor_options_rejected', { actorId, message: err.message });
            try {
                run = await client.actor(actorId).call(payload);
            } catch (err2) {
                await releaseUsage(client, reservationId, estimate);
                throw err2;
            }
        } else {
            // Nothing ran, so nothing is owed. Hand the credit straight back.
            await releaseUsage(client, reservationId, estimate);
            throw err;
        }
    }

    let rows;
    try {
        const { items } = await client.dataset(run.defaultDatasetId).listItems();
        rows = items || [];
    } catch (err) {
        // The run happened and will be billed even though the dataset read
        // failed, so the reservation is settled rather than released.
        await recordUsage(client, { actorId, run, items: 0, jobId: opts.jobId, reservationId, reservedUsd: estimate });
        throw err;
    }

    // An unfinished run under-reports both ways: the dataset is only partly
    // written, and run.usageTotalUsd is the spend so far rather than the spend
    // this run will end up billing. Settling the reservation at that number
    // understates the cycle and lets the next call through a gate it should
    // have failed. Keep the larger of the two.
    const runStatus = String(run?.status || '').toUpperCase();
    const finished = ['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT', 'TIMED_OUT'].includes(runStatus);
    if (!finished) {
        METRICS.apify.unfinished = (METRICS.apify.unfinished || 0) + 1;
        logger.warn('actor_run_unfinished', {
            actorId, runId: run?.id || null, status: runStatus || 'unknown',
            items: rows.length, jobId: opts.jobId || null,
            note: 'dataset read before the run settled — results and cost are both partial'
        });
        alertOnce('unfinished_run:' + actorId,
            `Apify actor ${actorId} was read while still ${runStatus || 'running'}. ` +
            `Results are partial and the recorded cost is a floor, not the final bill.`,
            { actorId, runId: run?.id || null });
    }

    const usd = await recordUsage(client, {
        actorId, run, items: rows.length, jobId: opts.jobId,
        reservationId, reservedUsd: estimate,
        floorUsd: finished ? 0 : estimate
    });

    METRICS.apify.runs  += 1;
    METRICS.apify.usd   += usd;
    METRICS.apify.items += rows.length;

    logger.info('actor_run', {
        actorId,
        items: rows.length,
        usd: +usd.toFixed(4),
        estimateUsd: estimate ? +estimate.toFixed(4) : 0,
        ms: Date.now() - t0,
        runId: run?.id || null,
        jobId: opts.jobId || null,
        key: client?.__el?.apifyUsername || 'unknown',
        remaining: +Math.max(0, clientRemaining(client)).toFixed(4)
    });

    // A single run costing more than the alert threshold is either a runaway
    // actor or a wrong cost constant. Both are worth knowing about the same day
    // rather than at the end of the month.
    if (usd > RUN_COST_ALERT_USD) {
        alertOnce('expensive_run:' + actorId,
            `One Apify run cost $${usd.toFixed(2)} (threshold $${RUN_COST_ALERT_USD.toFixed(2)})`,
            { actorId, items: rows.length, runId: run?.id || null, key: client?.__el?.apifyUsername });
    }
    // Paying for zero rows is the signature of an actor whose input shape or
    // name changed under us. It used to be completely silent.
    if (rows.length === 0) {
        METRICS.apify.emptyRuns += 1;
        alertOnce('empty_run:' + actorId,
            `Apify actor ${actorId} returned 0 items but charged $${usd.toFixed(4)}. Check the actor id and input shape.`,
            { actorId, runId: run?.id || null });
    }
    // Estimates drive every budget decision. If reality drifts far from the
    // estimate the constants in env are wrong, not the code.
    if (estimate > 0 && usd > estimate * 2 && usd > 0.05) {
        logger.warn('cost_estimate_drift', { actorId, estimateUsd: +estimate.toFixed(4), actualUsd: +usd.toFixed(4) });
        alertOnce('estimate_drift:' + actorId,
            `Apify run cost $${usd.toFixed(3)} against an estimate of $${estimate.toFixed(3)}. The COST_PER_1K_* constants need correcting.`,
            { actorId });
    }

    return { run, items: rows, usd };
}

async function runActor(actorId, input, warningsArray, methodName, client, opts = {}) {
    try {
        logger.info('leadgen_actor', { actorId, method: methodName });
        // An estimate is not optional. Without one callActor skips the budget
        // gate, takes no reservation and can never raise NO_CREDIT — which is
        // why the leadgen engine was the only engine that could overspend a
        // key silently.
        const { items } = await callActor(client, actorId, input, {
            estimateUsd: opts.estimateUsd ?? LEADGEN_UNIT_USD,
            maxItems:    opts.maxItems    ?? LEADGEN_RESULTS_LIMIT,
            jobId:       opts.jobId || null
        });
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

// ---------------------------------------------------------------------------
// FIELD EXTRACTION
// Everything below reads fields the instagram-scraper actor already returns
// and savePosts() was dropping on the floor. Each accessor tries the several
// spellings the actor has shipped over the years and returns null rather than
// guessing, so a schema drift shows up as a missing field in dataQuality
// instead of a plausible-looking wrong number.
// ---------------------------------------------------------------------------

function igCarouselCount(p) {
    if (Array.isArray(p.childPosts)) return p.childPosts.length;
    if (Array.isArray(p.sidecarChildren)) return p.sidecarChildren.length;
    if (Array.isArray(p.edge_sidecar_to_children?.edges)) return p.edge_sidecar_to_children.edges.length;
    return null;
}

function igTaggedUsers(p) {
    const src = p.taggedUsers || p.usertags || p.tagged_users || [];
    if (!Array.isArray(src)) return [];
    return Array.from(new Set(src
        .map(u => (typeof u === 'string' ? u : (u.username || u.user?.username || null)))
        .filter(Boolean)
        .map(s => String(s).toLowerCase())))
        .slice(0, 30);
}

function igAltText(p) {
    return p.alt || p.altText || p.accessibilityCaption || p.accessibility_caption || null;
}

/**
 * Aspect ratio, bucketed.
 *
 * This is not cosmetic. 4:5 occupies roughly 25% more vertical feed space
 * than 1:1 and materially more than 16:9, and feed real estate is the single
 * cheapest engagement lever an account has. An account shipping everything at
 * 1:1 is giving away impressions for free and no other metric in the report
 * would ever surface it.
 */
function igDimensions(p) {
    const w = p.dimensionsWidth ?? p.dimensions?.width ?? p.imageWidth ?? null;
    const h = p.dimensionsHeight ?? p.dimensions?.height ?? p.imageHeight ?? null;
    if (!w || !h) return { width: null, height: null, aspect: null };

    const r = w / h;
    const aspect =
        Math.abs(r - 0.8)   < 0.06 ? '4:5'  :
        Math.abs(r - 1)     < 0.06 ? '1:1'  :
        Math.abs(r - 0.5625)< 0.06 ? '9:16' :
        Math.abs(r - 1.777) < 0.12 ? '16:9' :
        r < 0.8  ? 'tall'   :
        r > 1.2  ? 'wide'   : 'other';

    return { width: w, height: h, aspect };
}

function igIsSponsored(p) {
    return !!(p.isSponsored || p.is_paid_partnership || p.paidPartnership ||
              (Array.isArray(p.sponsorTags) && p.sponsorTags.length) ||
              (Array.isArray(p.coauthorProducers) && p.coauthorProducers.some(c => c?.is_paid_partnership)));
}

function igAudio(p) {
    const m = p.musicInfo || p.music_info || p.audio || null;
    if (!m) return null;
    return {
        title:  m.song_name || m.title || m.audio_title || null,
        artist: m.artist_name || m.artist || null,
        original: m.uses_original_audio ?? m.isOriginalAudio ?? null,
        audioId: m.audio_id || m.id || null
    };
}

function igFirstComment(p) {
    if (typeof p.firstComment === 'string') return p.firstComment;
    if (p.firstComment?.text) return p.firstComment.text;
    const lc = Array.isArray(p.latestComments) ? p.latestComments : [];
    return lc[0]?.text || null;
}

function igCommentsDisabled(p) {
    return p.isCommentsDisabled ?? p.commentsDisabled ?? p.comments_disabled ?? null;
}


// ---------------------------------------------------------------------------
// NORMALISATION
// One post in, one fully-derived row out. This is the IG counterpart of
// fbPageNormalisePost() and it is deliberately the only place that reads the
// raw actor item, so there is exactly one thing to fix when Apify renames a
// field.
// ---------------------------------------------------------------------------
function igNormalisePost(item, handle, userId = null, meta = {}) {
    const sc = shortcodeOf(item);
    if (!sc) return null;

    const caption  = item.caption || item.text || '';
    const d        = tsOf(item);
    const type     = postTypeOf(item);
    const likes    = item.likesCount || 0;
    const comments = item.commentsCount || 0;
    const views    = getViews(item);
    const plays    = getPlays(item);           // phase 11: kept apart from views
    const words    = caption ? caption.split(/\s+/).filter(Boolean).length : 0;

    const { hour, dow } = localParts(d, IG_TZ_OFFSET_MINS);
    const dims = igDimensions(item);

    const ageHours = d ? (Date.now() - d.getTime()) / 3600000 : 9999;
    const settleWindow = (type === 'Reel' || type === 'Video')
        ? IG_REEL_PROVISIONAL_HOURS
        : IG_PROVISIONAL_HOURS;

    const hashtags = tagsOf(caption, '#').slice(0, 40);
    const mentions = tagsOf(caption, '@').slice(0, 40);

    return {
        // --- identity -------------------------------------------------------
        user_id: userId,
        platform: 'instagram',
        handle: (handle || item.ownerUsername || '').toLowerCase(),
        shortcode: sc,
        post_url: item.url || `https://www.instagram.com/p/${sc}/`,
        post_type: type,

        // --- content --------------------------------------------------------
        caption: caption.slice(0, 4000),
        caption_length: caption.length,
        word_count: words,
        hashtags,
        mentions,
        hashtag_count: hashtags.length,
        mention_count: mentions.length,

        // --- metrics --------------------------------------------------------
        likes,
        comments,
        views,
        plays,
        is_video: !!(item.isVideo || item.videoUrl),
        video_duration: item.videoDuration || item.duration || null,
        thumbnail_url: item.displayUrl || item.thumbnailUrl || null,
        media_url: item.videoUrl || item.displayUrl || null,
        location_name: item.locationName || item.location?.name || null,
        posted_at: d ? d.toISOString() : null,

        // --- fields the actor returned and savePosts() used to discard ------
        carousel_count: igCarouselCount(item),
        tagged_users: igTaggedUsers(item),
        alt_text: igAltText(item),
        media_width: dims.width,
        media_height: dims.height,
        aspect_ratio: dims.aspect,
        is_sponsored: igIsSponsored(item),
        audio: igAudio(item),
        comments_disabled: igCommentsDisabled(item),
        first_comment: (igFirstComment(item) || '').slice(0, 1000) || null,

        // --- derived features ----------------------------------------------
        // Comments are weighted because they cost the viewer far more than a
        // like and correlate much harder with reach. Same reasoning as
        // FB_COMMENT_WEIGHT, different constant because the ratios differ.
        engagement_raw: likes + (IG_COMMENT_WEIGHT * comments),
        performance_index: null,        // filled by igIndexPosts()
        hour_local: hour,
        dow_local: dow,
        length_band: lengthBand(words),
        opening_pattern: openingPattern(caption),
        topic_tags: topicTags(caption),
        has_link: IG_URL_RE.test(caption),
        has_question: FB_QUESTION_RE.test(caption),
        has_cta: FB_CTA_RE.test(caption),
        has_offer: FB_OFFER_RE.test(caption),
        has_emoji: FB_EMOJI_RE.test(caption),
        has_alt_text: !!igAltText(item),
        is_carousel: (igCarouselCount(item) || 0) > 1,
        is_provisional: ageHours < settleWindow,
        age_hours: Math.round(ageHours),

        // --- bookkeeping ----------------------------------------------------
        report_id: meta.reportId || null,
        set_id: meta.setId || null,
        scraped_at: new Date().toISOString(),

        // The diagnostic the FB path has had all along and the IG path did
        // not. Costs one line and one small jsonb column, and answers "which
        // fields does this actor version actually return" from production
        // data instead of from a guess.
        raw: { keys: Object.keys(item || {}).slice(0, 60) }
    };
}

/**
 * Index every post against the account's own median for its calendar month.
 *
 * Identical reasoning to fbPageIndexPosts(): an account that tripled its
 * following over the scrape window would otherwise have every older post
 * scored as a failure. Provisional posts are excluded from the baseline
 * where there are enough settled posts to build one without them — they are
 * still indexed, they just do not get to drag the baseline down.
 */
function igIndexPosts(rows) {
    const buckets = {};
    rows.forEach(r => {
        const month = (r.posted_at || '').slice(0, 7) || 'unknown';
        const k = `${r.handle}::${month}`;
        (buckets[k] = buckets[k] || []).push(r);
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
        r.performance_index = +(r.engagement_raw / (baselines[`${r.handle}::${month}`] || 1)).toFixed(3);
    });

    return { rows, baselines, months: Object.keys(baselines).length };
}


// ---------------------------------------------------------------------------
// DISTRIBUTION STATS
// The whole reason this exists: computeAudit() averaged everything, and on
// Instagram one reel that broke containment moves the mean by a multiple
// while moving the median by almost nothing. Reporting both is the only
// honest way to show an account whether its typical post is working.
// ---------------------------------------------------------------------------
function igDistribution(rows) {
    const pick = f => rows.map(f).filter(v => typeof v === 'number' && !isNaN(v));

    const likes = pick(r => r.likes);
    const comments = pick(r => r.comments);
    const views = pick(r => r.views).filter(v => v > 0);
    const eng = pick(r => r.engagement_raw);
    // phase 11: reels that report both numbers. plays/views < 1 means most
    // "views" were autoplay scrolls that never became a watch.
    const both = rows.filter(r => (r.plays || 0) > 0 && (r.views || 0) > 0 && r.plays !== r.views);
    const plays = pick(r => r.plays).filter(v => v > 0);

    const stat = arr => {
        if (!arr.length) return { mean: 0, median: 0, max: 0, min: 0, p90: 0 };
        const s = [...arr].sort((a, b) => a - b);
        return {
            mean: Math.round(arr.reduce((x, y) => x + y, 0) / arr.length),
            median: Math.round(median(arr)),
            min: Math.round(s[0]),
            max: Math.round(s[s.length - 1]),
            p90: Math.round(s[Math.min(s.length - 1, Math.floor(s.length * 0.9))])
        };
    };

    const e = stat(eng);
    return {
        likes: stat(likes),
        comments: stat(comments),
        views: stat(views),
        engagement: e,
        // How far the mean is being pulled by the tail. Above ~1.6 the average
        // is describing the outlier, not the account.
        skew: e.median > 0 ? +(e.mean / e.median).toFixed(2) : null,
        outlierDriven: e.median > 0 && (e.mean / e.median) > 1.6,
        viewsAvailable: views.length > 0,
        plays: stat(plays),
        playback: {
            playsAvailable: plays.length > 0,
            distinguishable: both.length,
            medianPlaysPerView: both.length
                ? +median(both.map(r => r.plays / r.views)).toFixed(2) : null
        }
    };
}


// ---------------------------------------------------------------------------
// AGGREGATION — median-first
//
// These deliberately do NOT reuse leaderboard(), flagCompare() and
// timeHeatmap() from the FB engine, even though the shapes match.
//
// Those three all aggregate performance_index with a mean, and on Instagram
// that reintroduces the exact bug this patch exists to remove. Tested against
// a fixture with one runaway reel, the mean-based helpers reported reels at
// 7.5x baseline, emoji captions at +640% and Saturday at 16.7x — all of them
// one post wearing a costume. The medians for the same data are 1.06x, +6%
// and 1.0x.
//
// So: sort and headline on the median, carry the mean alongside for anyone
// who wants it, and mark a row unreliable when the two disagree badly.
// ---------------------------------------------------------------------------

// Below this, a median is not a median. With two posts it is just the mean
// again, which is how a bucket containing one runaway reel and one dud came
// back claiming a 40x effect. Small buckets are still reported — the post
// count is useful — but they do not get to make a performance claim.
const IG_MIN_BUCKET = 3;

function igAggIndex(group) {
    const idx = group.map(r => r.performance_index || 0);
    const med = +median(idx).toFixed(2);
    const avg = +(idx.reduce((s, v) => s + v, 0) / idx.length).toFixed(2);
    const sparse = group.length < IG_MIN_BUCKET;

    return {
        medIndex: sparse ? null : med,
        avgIndex: sparse ? null : avg,
        sparse,
        // A big gap means one post is carrying the group, so the row should be
        // read as "one post did this", not "this category performs".
        outlierDriven: !sparse && med > 0 && (avg / med) > 1.8,
        note: sparse ? `Only ${group.length} post(s) — not enough to read a pattern` : null
    };
}

function igLeaderboard(rows, dimension, minCount = 2) {
    const agg = {};
    rows.forEach(r => {
        const k = r[dimension] || 'unknown';
        (agg[k] = agg[k] || []).push(r);
    });

    return Object.entries(agg)
        .filter(([, g]) => g.length >= Math.min(minCount, rows.length))
        .map(([key, g]) => ({
            key,
            posts: g.length,
            share: ((g.length / rows.length) * 100).toFixed(1) + '%',
            ...igAggIndex(g),
            medEngagement: Math.round(median(g.map(r => r.engagement_raw))),
            avgEngagement: Math.round(g.reduce((s, r) => s + r.engagement_raw, 0) / g.length),
            medComments: Math.round(median(g.map(r => r.comments)))
        }))
        .sort((x, y) => (y.medIndex ?? -1) - (x.medIndex ?? -1));
}

function igFlagCompare(rows, field, labelOn, labelOff) {
    const on = rows.filter(r => r[field]);
    const off = rows.filter(r => !r[field]);
    if (!on.length || !off.length) return null;

    const onA = igAggIndex(on), offA = igAggIndex(off);
    const side = (g, a, label) => ({
        label, posts: g.length,
        share: +((g.length / rows.length) * 100).toFixed(1),
        medIndex: a.medIndex, avgIndex: a.avgIndex,
        medEngagement: Math.round(median(g.map(r => r.engagement_raw)))
    });

    // Lift computed on medians, so a single breakout post cannot manufacture
    // a "+640% — always use emoji" recommendation out of nothing.
    const lift = (onA.medIndex != null && offA.medIndex != null && offA.medIndex > 0)
        ? +((onA.medIndex / offA.medIndex - 1) * 100).toFixed(1)
        : null;

    return {
        field,
        with: side(on, onA, labelOn),
        without: side(off, offA, labelOff),
        lift,
        reliable: on.length >= 4 && off.length >= 4 && lift != null && !onA.outlierDriven && !offA.outlierDriven,
        note: (onA.sparse || offA.sparse)
            ? 'One side of this split has too few posts to compare.'
            : (onA.outlierDriven || offA.outlierDriven)
            ? 'One post dominates this split — treat the lift as indicative only.'
            : null
    };
}

function igHeatmap(rows) {
    const cells = {};
    rows.forEach(r => {
        if (r.hour_local === null || r.dow_local === null) return;
        const k = `${r.dow_local}:${r.hour_local}`;
        (cells[k] = cells[k] || []).push(r);
    });

    const flat = Object.entries(cells).map(([k, g]) => {
        const [dow, hour] = k.split(':').map(Number);
        return { dow, dowName: DOW_NAMES[dow], hour, posts: g.length, ...igAggIndex(g) };
    });

    const byHour = {}, byDay = {};
    rows.forEach(r => {
        if (r.hour_local !== null) (byHour[r.hour_local] = byHour[r.hour_local] || []).push(r);
        if (r.dow_local !== null) (byDay[r.dow_local] = byDay[r.dow_local] || []).push(r);
    });

    const hourRank = Object.entries(byHour)
        .map(([h, g]) => ({ hour: +h, posts: g.length, ...igAggIndex(g) }))
        .filter(h => h.posts >= IG_MIN_BUCKET)
        .sort((a, b) => (b.medIndex ?? -1) - (a.medIndex ?? -1));

    const dayRank = Object.entries(byDay)
        .map(([d, g]) => ({ dow: +d, dowName: DOW_NAMES[+d], posts: g.length, ...igAggIndex(g) }))
        .filter(d => d.posts >= IG_MIN_BUCKET)
        .sort((a, b) => (b.medIndex ?? -1) - (a.medIndex ?? -1));

    return {
        cells: flat,
        bestHours: hourRank.slice(0, 5),
        worstHours: hourRank.slice(-3).reverse(),
        bestDays: dayRank,
        // Under this many posts a heatmap is decoration, not evidence.
        reliable: rows.length >= 20
    };
}


// ---------------------------------------------------------------------------
// CADENCE — mirrors cadenceStats() on the FB side
// ---------------------------------------------------------------------------
function igCadence(rows) {
    const stamps = rows.map(r => r.posted_at ? new Date(r.posted_at).getTime() : null)
        .filter(Boolean).sort((a, b) => a - b);

    if (stamps.length < 2) {
        return {
            postsPerWeek: rows.length, postsPerMonth: rows.length, spanDays: 1,
            medianGapDays: null, longestGapDays: null, consistency: null,
            activeWeeks: rows.length ? 1 : 0, lastPostDaysAgo: null, silent: false
        };
    }

    const spanDays = Math.max(1, (stamps[stamps.length - 1] - stamps[0]) / 86400000);
    const gaps = [];
    for (let i = 1; i < stamps.length; i++) gaps.push((stamps[i] - stamps[i - 1]) / 86400000);

    const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((s, g) => s + Math.pow(g - mean, 2), 0) / gaps.length);
    const consistency = mean > 0 ? Math.max(0, Math.round(100 - Math.min(100, (sd / mean) * 55))) : null;

    const weeks = new Set(rows.filter(r => r.posted_at).map(r => {
        const d = new Date(r.posted_at);
        const y = d.getUTCFullYear();
        const w = Math.floor((d - new Date(Date.UTC(y, 0, 1))) / (7 * 86400000));
        return `${y}-${w}`;
    }));

    return {
        postsPerWeek: +((rows.length / spanDays) * 7).toFixed(1),
        postsPerMonth: +((rows.length / spanDays) * 30).toFixed(1),
        spanDays: Math.round(spanDays),
        medianGapDays: +median(gaps).toFixed(1),
        longestGapDays: +Math.max(...gaps).toFixed(1),
        consistency,
        activeWeeks: weeks.size,
        lastPostDaysAgo: +((Date.now() - stamps[stamps.length - 1]) / 86400000).toFixed(1),
        silent: (Date.now() - stamps[stamps.length - 1]) / 86400000 > 14
    };
}


// ---------------------------------------------------------------------------
// MOMENTUM — mirrors momentum() on the FB side
// ---------------------------------------------------------------------------
function igMomentum(allRows) {
    const rows = allRows.filter(r => !r.is_provisional);
    const byMonth = {};

    rows.forEach(r => {
        if (!r.posted_at) return;
        const m = r.posted_at.slice(0, 7);
        byMonth[m] = byMonth[m] || { month: m, posts: 0, engagement: 0, likes: 0, comments: 0, views: 0 };
        byMonth[m].posts++;
        byMonth[m].engagement += r.engagement_raw || 0;
        byMonth[m].likes += r.likes || 0;
        byMonth[m].comments += r.comments || 0;
        byMonth[m].views += r.views || 0;
    });

    const thisMonth = new Date().toISOString().slice(0, 7);

    const months = Object.values(byMonth)
        .sort((a, b) => a.month.localeCompare(b.month))
        .map(m => ({
            ...m,
            // Median, not mean. A month containing one breakout post otherwise
            // reads as a spike, and the month after it reads as a collapse.
            medEngagement: Math.round(median(rows.filter(r => r.posted_at?.slice(0, 7) === m.month)
                                                 .map(r => r.engagement_raw))),
            avgEngagement: Math.round(m.engagement / m.posts),
            avgLikes: Math.round(m.likes / m.posts),
            avgComments: +(m.comments / m.posts).toFixed(1),
            avgViews: Math.round(m.views / m.posts),
            partial: m.month === thisMonth
        }));

    // The month in progress is not a data point yet. Comparing three days of
    // September against all of August is how a growing account gets told it
    // is in freefall — and then gets a -5 momentum penalty for it.
    const complete = months.filter(m => !m.partial && m.posts >= 3);

    let direction = null, changePct = null, basis = null;
    if (complete.length >= 2) {
        const prev = complete[complete.length - 2], last = complete[complete.length - 1];
        if (prev.medEngagement > 0) {
            changePct = +(((last.medEngagement - prev.medEngagement) / prev.medEngagement) * 100).toFixed(1);
            direction = changePct > 8 ? 'rising' : changePct < -8 ? 'falling' : 'flat';
            basis = `${prev.month} → ${last.month}, median engagement, complete months only`;
        }
    }

    // Newest third vs oldest third. Steadier than any single month pair, and
    // the fallback when there are not two complete months to compare.
    let halfSplit = null;
    if (rows.length >= 9) {
        const sorted = [...rows].filter(r => r.posted_at)
            .sort((a, b) => new Date(a.posted_at) - new Date(b.posted_at));
        const third = Math.floor(sorted.length / 3);
        const oldMed = median(sorted.slice(0, third).map(r => r.engagement_raw));
        const newMed = median(sorted.slice(-third).map(r => r.engagement_raw));
        halfSplit = {
            oldestThirdMedian: Math.round(oldMed),
            newestThirdMedian: Math.round(newMed),
            changePct: oldMed > 0 ? +(((newMed - oldMed) / oldMed) * 100).toFixed(1) : null
        };
        if (direction === null && halfSplit.changePct != null) {
            changePct = halfSplit.changePct;
            direction = changePct > 8 ? 'rising' : changePct < -8 ? 'falling' : 'flat';
            basis = 'newest third vs oldest third of the window (not enough complete months)';
        }
    }

    return {
        months, direction, changePct, halfSplit, basis,
        partialMonth: months.find(m => m.partial)?.month || null,
        completeMonths: complete.length,
        provisionalExcluded: allRows.length - rows.length
    };
}


// ---------------------------------------------------------------------------
// PROFILE COMPLETENESS
// The IG counterpart of profileCompleteness(). Weighted towards the fields
// that actually convert a profile visit into a contact, because that is what
// a business account is for.
// ---------------------------------------------------------------------------
function igProfileCompleteness(b) {
    const checks = [
        { key: 'name',      label: 'Display name set',           ok: !!b.fullName,                      weight: 6 },
        { key: 'bio',       label: 'Bio written (40+ chars)',    ok: !!(b.bio && b.bio.length > 40),    weight: 16 },
        { key: 'website',   label: 'Link in bio set',            ok: !!b.website,                       weight: 18 },
        { key: 'category',  label: 'Business category set',      ok: !!b.category,                      weight: 10 },
        { key: 'email',     label: 'Contact email published',    ok: !!b.email,                         weight: 12 },
        { key: 'phone',     label: 'Phone number published',     ok: !!b.phone,                         weight: 12 },
        { key: 'city',      label: 'Location set',               ok: !!b.city,                          weight: 8 },
        { key: 'pic',       label: 'Profile photo set',          ok: !!b.profilePic,                    weight: 6 },
        { key: 'business',  label: 'Business / creator account', ok: !!b.isBusiness,                    weight: 12 }
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
// SCORE v2
// Seven bounded pillars plus a bounded momentum adjustment, and the breakdown
// comes back with the score so the page can show where every point went.
// The v1 score was four unbounded-ish terms with no explanation attached,
// which made a grade impossible to argue with or act on.
// ---------------------------------------------------------------------------
function igComputeScore(parts) {
    const { engagementRate, postsPerWeek, consistency, commentRatio,
            viewsPerFollower, completeness, momentumPct, formatSpread,
            sampleSize, viewsAvailable } = parts;

    // 1. Engagement per follower (26). Log-scaled: a 2k account routinely
    //    posts 8% and a 500k account structurally cannot, so a linear scale
    //    just ranks accounts by how small they are.
    const er = engagementRate || 0;
    const engagementPts = Math.min(26, Math.round((Math.log10(1 + er * 12) / Math.log10(13)) * 26));

    // 2. Cadence (16). 3-7 a week is the band where the feed keeps serving
    //    you without the audience tuning out.
    const ppw = postsPerWeek || 0;
    const cadencePts = ppw === 0 ? 0 : ppw < 1 ? 4 : ppw < 2 ? 8 : ppw <= 7 ? 16 : ppw <= 14 ? 12 : 8;

    // 3. Consistency (11) — rhythm, not volume.
    const consistencyPts = Math.round(((consistency ?? 50) / 100) * 11);

    // 4. Conversation (16) — comments per 100 likes. The hardest engagement
    //    to buy and the strongest surviving reach signal.
    const conv = commentRatio || 0;
    const conversationPts = Math.min(16, Math.round((Math.log10(1 + conv) / Math.log10(11)) * 16));

    // 5. Reach (12) — views per follower. Only scored when the actor actually
    //    returned view counts; scoring a zero we never measured would punish
    //    an account for a scrape limitation.
    const vpf = viewsPerFollower || 0;
    const reachPts = !viewsAvailable ? null
        : Math.min(12, Math.round((Math.log10(1 + vpf * 3) / Math.log10(7)) * 12));

    // 6. Format range (7) — reels, carousels and stills do different jobs.
    const formatPts = Math.min(7, (formatSpread || 0) >= 3 ? 7 : (formatSpread || 0) * 3);

    // 7. Profile completeness (12).
    const completenessPts = Math.round(((completeness || 0) / 100) * 12);

    // When views are unavailable the 12 reach points are redistributed rather
    // than lost, so two accounts are not graded on different denominators.
    const measured = engagementPts + cadencePts + consistencyPts + conversationPts +
                     formatPts + completenessPts + (reachPts ?? 0);
    const maxAvailable = 26 + 16 + 11 + 16 + 7 + 12 + (reachPts === null ? 0 : 12);
    let score = Math.round((measured / maxAvailable) * 100);

    const momentumAdj = momentumPct == null ? 0 : Math.max(-5, Math.min(5, Math.round(momentumPct / 10)));
    score = Math.max(0, Math.min(100, score + momentumAdj));

    const grade = score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : score >= 35 ? 'D' : 'F';
    const low = sampleSize > 0 && sampleSize < IG_MIN_CONFIDENT_POSTS;

    const breakdown = [
        { pillar: 'Engagement per follower', points: engagementPts,   max: 26, detail: `${er.toFixed(2)}% per post` },
        { pillar: 'Posting cadence',         points: cadencePts,      max: 16, detail: `${ppw} posts/week` },
        { pillar: 'Consistency',             points: consistencyPts,  max: 11, detail: consistency == null ? 'not enough posts' : `${consistency}/100 rhythm` },
        { pillar: 'Conversation',            points: conversationPts, max: 16, detail: `${conv.toFixed(1)} comments per 100 likes` },
        { pillar: 'Reach',                   points: reachPts ?? 0,   max: 12, detail: reachPts === null ? 'no view counts returned — pillar excluded' : `${vpf.toFixed(2)} views per follower` },
        { pillar: 'Format range',            points: formatPts,       max: 7,  detail: `${formatSpread || 0} formats in use` },
        { pillar: 'Profile completeness',    points: completenessPts, max: 12, detail: `${completeness || 0}% complete` },
        { pillar: 'Momentum adjustment',     points: momentumAdj,     max: 5,  detail: momentumPct == null ? 'no trend data' : `${momentumPct > 0 ? '+' : ''}${momentumPct}% month over month` }
    ];

    return {
        score, grade, breakdown,
        lowConfidence: low,
        sampleSize,
        verdict: low
            ? `Only ${sampleSize} posts in the window — treat this as provisional, not a verdict`
            : score >= 80 ? 'Strong account — the job is protecting what works'
            : score >= 65 ? 'Healthy, with one clear gap to close'
            : score >= 50 ? 'Functional but underperforming its follower count'
            : score >= 35 ? 'Weak — fix the fundamentals before optimising anything'
            : 'Dormant or badly broken'
    };
}


// ---------------------------------------------------------------------------
// EXTRAS
// Everything the scrape now captures, plus the three fields that were being
// written to the posts table and read by nothing: video_duration,
// location_name and mentions.
// ---------------------------------------------------------------------------
function igExtras(rows) {
    const n = rows.length;
    const share = c => n ? +((c / n) * 100).toFixed(1) : 0;

    // --- carousel depth ---------------------------------------------------
    const carousels = rows.filter(r => r.is_carousel);
    const depthBuckets = {};
    carousels.forEach(r => {
        const d = r.carousel_count;
        const k = d >= 8 ? '8+' : d >= 5 ? '5-7' : d >= 3 ? '3-4' : '2';
        (depthBuckets[k] = depthBuckets[k] || []).push(r);
    });

    // --- aspect ratio ------------------------------------------------------
    const aspects = {};
    rows.filter(r => r.aspect_ratio).forEach(r => {
        (aspects[r.aspect_ratio] = aspects[r.aspect_ratio] || []).push(r);
    });

    // --- video duration (saved since day one, analysed until now by nobody)
    const durations = rows.map(r => Number(r.video_duration)).filter(d => d > 0);
    const durBuckets = {};
    rows.filter(r => Number(r.video_duration) > 0).forEach(r => {
        const d = Number(r.video_duration);
        const k = d <= 15 ? '0-15s' : d <= 30 ? '16-30s' : d <= 60 ? '31-60s' : d <= 90 ? '61-90s' : '90s+';
        (durBuckets[k] = durBuckets[k] || []).push(r);
    });

    // --- locations ---------------------------------------------------------
    const locs = {};
    rows.filter(r => r.location_name).forEach(r => {
        (locs[r.location_name] = locs[r.location_name] || []).push(r);
    });

    // --- mentions ----------------------------------------------------------
    const mentionCount = {};
    rows.forEach(r => (r.mentions || []).forEach(m => { mentionCount[m] = (mentionCount[m] || 0) + 1; }));

    // --- audio -------------------------------------------------------------
    const withAudio = rows.filter(r => r.audio?.title);
    const audioCount = {};
    withAudio.forEach(r => {
        const k = r.audio.artist ? `${r.audio.title} — ${r.audio.artist}` : r.audio.title;
        audioCount[k] = (audioCount[k] || 0) + 1;
    });

    // --- tagged users ------------------------------------------------------
    const tagCount = {};
    rows.forEach(r => (r.tagged_users || []).forEach(u => { tagCount[u] = (tagCount[u] || 0) + 1; }));

    const top = (obj, limit = 8) => Object.entries(obj)
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);

    // Median-based for the same reason the leaderboards are: with a mean, a
    // single breakout reel made the 9:16 bucket read 39.98x baseline off two
    // posts, which is a recommendation to shoot everything vertical based on
    // one lucky video.
    const bucketRows = obj => Object.entries(obj)
        .map(([key, group]) => ({
            key,
            posts: group.length,
            share: share(group.length),
            ...igAggIndex(group),
            medEngagement: Math.round(median(group.map(r => r.engagement_raw))),
            avgEngagement: Math.round(group.reduce((s, r) => s + r.engagement_raw, 0) / group.length)
        }))
        .sort((a, b) => (b.medIndex ?? -1) - (a.medIndex ?? -1));

    return {
        carousel: {
            posts: carousels.length,
            share: share(carousels.length),
            avgDepth: carousels.length
                ? +(carousels.reduce((s, r) => s + (r.carousel_count || 0), 0) / carousels.length).toFixed(1)
                : null,
            byDepth: bucketRows(depthBuckets),
            available: rows.some(r => r.carousel_count !== null)
        },
        aspectRatio: {
            byRatio: bucketRows(aspects),
            available: Object.keys(aspects).length > 0,
            // The specific thing worth telling an account about.
            fourFiveShare: share(rows.filter(r => r.aspect_ratio === '4:5').length),
            note: Object.keys(aspects).length
                ? '4:5 takes about 25% more vertical feed space than 1:1. Free impressions if the crop allows it.'
                : 'The actor did not return image dimensions on this run.'
        },
        videoDuration: {
            available: durations.length > 0,
            posts: durations.length,
            medianSeconds: durations.length ? +median(durations).toFixed(1) : null,
            byBand: bucketRows(durBuckets)
        },
        locations: {
            tagged: rows.filter(r => r.location_name).length,
            share: share(rows.filter(r => r.location_name).length),
            top: bucketRows(locs).slice(0, 6)
        },
        mentions: {
            postsWithMentions: rows.filter(r => (r.mentions || []).length).length,
            share: share(rows.filter(r => (r.mentions || []).length).length),
            top: top(mentionCount)
        },
        taggedUsers: {
            available: rows.some(r => (r.tagged_users || []).length),
            postsWithTags: rows.filter(r => (r.tagged_users || []).length).length,
            share: share(rows.filter(r => (r.tagged_users || []).length).length),
            top: top(tagCount)
        },
        audio: {
            available: withAudio.length > 0,
            posts: withAudio.length,
            originalShare: withAudio.length
                ? share(withAudio.filter(r => r.audio.original).length)
                : 0,
            top: top(audioCount, 6)
        },
        altText: {
            // Accessibility, and IG uses alt text for content understanding.
            coverage: share(rows.filter(r => r.has_alt_text).length),
            missing: rows.filter(r => !r.has_alt_text).length
        },
        sponsored: {
            posts: rows.filter(r => r.is_sponsored).length,
            share: share(rows.filter(r => r.is_sponsored).length)
        },
        commentsDisabled: {
            posts: rows.filter(r => r.comments_disabled === true).length,
            available: rows.some(r => r.comments_disabled !== null)
        }
    };
}


/**
 * What the actor actually gave us this run.
 *
 * The honest counterpart to the raw.keys line. Rather than silently rendering
 * an empty section, the report can say "the actor did not return dimensions"
 * — which is a fact about the scrape, not a fact about the account.
 */
function igDataQuality(rows, rawItems) {
    const keySet = new Set();
    (rawItems || []).slice(0, 25).forEach(i => Object.keys(i || {}).forEach(k => keySet.add(k)));

    const optional = [
        { field: 'childPosts',    label: 'Carousel children',   present: rows.some(r => r.carousel_count !== null) },
        { field: 'taggedUsers',   label: 'Tagged users',        present: rows.some(r => (r.tagged_users || []).length) },
        { field: 'alt',           label: 'Alt text',            present: rows.some(r => r.has_alt_text) },
        { field: 'dimensions',    label: 'Image dimensions',    present: rows.some(r => r.aspect_ratio) },
        { field: 'musicInfo',     label: 'Reel audio',          present: rows.some(r => r.audio) },
        { field: 'isSponsored',   label: 'Paid partnership flag', present: rows.some(r => r.is_sponsored) },
        { field: 'latestComments',label: 'First comment',       present: rows.some(r => r.first_comment) },
        { field: 'videoDuration', label: 'Video duration',      present: rows.some(r => Number(r.video_duration) > 0) },
        { field: 'locationName',  label: 'Location',            present: rows.some(r => r.location_name) },
        { field: 'playCount',     label: 'View counts',         present: rows.some(r => r.views > 0) }
    ];

    return {
        actorKeys: Array.from(keySet).sort(),
        fields: optional,
        missing: optional.filter(o => !o.present).map(o => o.label),
        postsSeen: rows.length,
        provisional: rows.filter(r => r.is_provisional).length
    };
}


// ===========================================================================
// SAVE
// ===========================================================================

async function savePosts(userId, handle, posts, meta = {}) {
    const seen = new Set();
    const rows = [];

    for (const p of posts || []) {
        const row = igNormalisePost(p, handle, userId, meta);
        if (!row || seen.has(row.shortcode)) continue;
        seen.add(row.shortcode);

        // The audit-only derived fields are not persisted — they are cheap to
        // recompute and would otherwise need a migration every time one is
        // added. What is persisted is the raw signal the actor charged us for.
        rows.push({
            user_id: row.user_id,
            platform: row.platform,
            handle: row.handle,
            shortcode: row.shortcode,
            post_url: row.post_url,
            post_type: row.post_type,
            caption: row.caption,
            caption_length: row.caption_length,
            hashtags: row.hashtags,
            mentions: row.mentions,
            likes: row.likes,
            comments: row.comments,
            views: row.views,
            is_video: row.is_video,
            video_duration: row.video_duration,
            thumbnail_url: row.thumbnail_url,
            media_url: row.media_url,
            location_name: row.location_name,
            posted_at: row.posted_at,
            report_id: row.report_id,
            set_id: row.set_id,
            client_id: (meta.clientId && UUID_RE.test(String(meta.clientId))) ? meta.clientId : null,   // phase 10
            scraped_at: row.scraped_at,

            // --- phase 4 columns ---------------------------------------------
            carousel_count: row.carousel_count,
            tagged_users: row.tagged_users,
            alt_text: row.alt_text,
            media_width: row.media_width,
            media_height: row.media_height,
            aspect_ratio: row.aspect_ratio,
            is_sponsored: row.is_sponsored,
            audio: row.audio,
            comments_disabled: row.comments_disabled,
            first_comment: row.first_comment,
            engagement_raw: row.engagement_raw,
            hour_local: row.hour_local,
            dow_local: row.dow_local,
            is_provisional: row.is_provisional,
            raw: row.raw
        });
    }

    if (!rows.length) return { saved: 0, failed: 0, error: null };

    // A failure here used to be invisible. computeAudit() works from the
    // in-memory array, so the report rendered perfectly while the posts table
    // stayed empty — which is exactly what happens when schema-phase4.sql was
    // never applied and every upsert errors on an unknown column. The run
    // looked fine and /api/posts silently returned nothing for weeks.
    let saved = 0, failed = 0, firstError = null;
    for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        const { error } = await supabase.from('posts')
            .upsert(chunk, { onConflict: 'user_id,platform,shortcode' });
        if (error) {
            failed += chunk.length;
            firstError = firstError || error.message;
            logger.error('save_posts_failed', { message: error.message, handle, chunk: chunk.length });
        } else {
            saved += chunk.length;
        }
    }

    if (firstError) {
        alertOnce('save_posts_failed',
            'Instagram posts are not being written to the database. The reports still render from memory, ' +
            'but post-level history is not accumulating. Usually a missing migration: ' + firstError,
            { handle });
    }
    return { saved, failed, error: firstError };
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

    const base = {
        handle,
        followers,
        following: profile.followsCount ?? profile.followingCount ?? 0,
        totalPosts: profile.postsCount ?? 0,
        fullName: profile.fullName || null,
        bio: profile.biography || '',
        website: profile.externalUrl || profile.website || null,
        category: profile.businessCategoryName || profile.categoryName || null,
        isBusiness: !!profile.isBusinessAccount,
        isVerified: !!profile.verified || !!profile.isVerified,
        email: extractBioContacts(profile).email,
        phone: extractBioContacts(profile).phone,
        whatsapp: extractBioContacts(profile).whatsapp,
        contactSources: extractBioContacts(profile).sources,
        city: profile.city || profile.cityName || null,
        address: profile.addressStreet || null,
        profilePic: profile.profilePicUrlHD || profile.profilePicUrl || null,
        postsAnalyzed: 0
    };

    // --- normalise + dedupe once ------------------------------------------
    const seen = new Set();
    const rows = [];
    for (const p of posts || []) {
        const r = igNormalisePost(p, handle);
        if (!r || seen.has(r.shortcode)) continue;
        seen.add(r.shortcode);
        rows.push(r);
    }

    base.postsAnalyzed = rows.length;
    const completeness = igProfileCompleteness(base);

    if (!rows.length) {
        const empty = igComputeScore({
            engagementRate: 0, postsPerWeek: 0, consistency: null, commentRatio: 0,
            viewsPerFollower: 0, completeness: completeness.score, momentumPct: null,
            formatSpread: 0, sampleSize: 0, viewsAvailable: false
        });
        return {
            ...base,
            engagementRate: '0.0', viralityScore: '0.0', postsPerWeek: '0.0',
            avgLikes: 0, avgComments: 0, avgViews: 0,
            score: empty.score, grade: empty.grade, scoreV1: 0,
            contentMix: {}, topHashtags: [], postingHours: [], postingDays: [],
            captionInsight: {}, last30Days: {}, consistency: {}, topPosts: [], bottomPosts: [],
            distribution: null, cadence: igCadence([]), momentum: null, heatmap: null,
            scoreBreakdown: empty, completeness, leaderboards: {}, flags: [],
            extras: null, exemplars: {}, provisional: { count: 0, settled: 0 },
            dataQuality: igDataQuality([], posts)
        };
    }

    igIndexPosts(rows);

    // Settled posts drive every rate. A reel three hours old is not a weak
    // reel, and letting it into the averages is how a healthy account gets
    // told its content is collapsing.
    const settled = rows.filter(r => !r.is_provisional);
    const statPool = settled.length >= Math.max(4, Math.ceil(rows.length * 0.4)) ? settled : rows;
    const usingSettledOnly = statPool !== rows;

    const n = statPool.length;
    const likes = statPool.reduce((s, r) => s + r.likes, 0);
    const comments = statPool.reduce((s, r) => s + r.comments, 0);
    const views = statPool.reduce((s, r) => s + r.views, 0);

    const avgLikes = likes / n, avgComments = comments / n, avgViews = views / n;

    // Two engagement rates, and the difference between them is the point.
    //
    // engagementRate is the mean — the number every other tool in this
    // category reports, kept so the benchmark and the vault stay comparable.
    // engagementRateMedian describes the post this account typically ships.
    // On an account with one runaway reel the mean read 19.4% and the median
    // 2.9%; the second number is the one a strategy should be built on, so
    // that is the one the score uses.
    const distribution = igDistribution(statPool);
    const engagementRate = followers > 0 ? (((avgLikes + avgComments) / followers) * 100).toFixed(2) : '0.0';
    const engagementRateMedian = followers > 0
        ? (((distribution.likes.median + distribution.comments.median) / followers) * 100).toFixed(2)
        : '0.0';
    const viralityScore = followers > 0 ? (avgViews / followers).toFixed(2) : '0.0';
    const viralityScoreMedian = followers > 0 ? (distribution.views.median / followers).toFixed(2) : '0.0';

    const cadence = igCadence(rows);
    const mo = igMomentum(rows);
    const heatmap = igHeatmap(rows);

    // --- content mix (kept in the v1 shape so nothing downstream breaks) ---
    const mix = {};
    statPool.forEach(r => {
        mix[r.post_type] = mix[r.post_type] || { count: 0, likes: 0, comments: 0, views: 0, idx: 0 };
        const m = mix[r.post_type];
        m.count++; m.likes += r.likes; m.comments += r.comments; m.views += r.views;
        m.idx += r.performance_index || 0;
    });

    const contentMix = {};
    Object.entries(mix).forEach(([k, v]) => {
        contentMix[k] = {
            count: v.count,
            share: ((v.count / n) * 100).toFixed(1) + '%',
            avgLikes: Math.round(v.likes / v.count),
            avgComments: Math.round(v.comments / v.count),
            avgViews: Math.round(v.views / v.count),
            avgEngagement: Math.round((v.likes + v.comments) / v.count),
            avgIndex: +(v.idx / v.count).toFixed(2)
        };
    });

    // --- hashtags ----------------------------------------------------------
    const tagStat = {};
    statPool.forEach(r => r.hashtags.forEach(t => {
        tagStat[t] = tagStat[t] || { uses: 0, engagement: 0, idx: 0 };
        tagStat[t].uses++;
        tagStat[t].engagement += r.likes + r.comments;
        tagStat[t].idx += r.performance_index || 0;
    }));

    const topHashtags = Object.entries(tagStat)
        .map(([tag, s]) => ({
            tag, uses: s.uses,
            avgEngagement: Math.round(s.engagement / s.uses),
            avgIndex: +(s.idx / s.uses).toFixed(2)
        }))
        .sort((a, b) => b.uses - a.uses || b.avgEngagement - a.avgEngagement)
        .slice(0, 20);

    // --- caption length ----------------------------------------------------
    const capStat = {};
    statPool.forEach(r => {
        const b = bucketCaption(r.caption_length);
        capStat[b] = capStat[b] || { count: 0, engagement: 0 };
        capStat[b].count++; capStat[b].engagement += r.likes + r.comments;
    });
    const captionInsight = {};
    Object.entries(capStat).forEach(([k, v]) => {
        captionInsight[k] = { count: v.count, avgEngagement: Math.round(v.engagement / v.count) };
    });

    // --- posting hours / days, kept in the v1 shape ------------------------
    const hours = {}, days = {};
    statPool.forEach(r => {
        if (r.hour_local !== null) {
            hours[r.hour_local] = hours[r.hour_local] || { count: 0, engagement: 0 };
            hours[r.hour_local].count++; hours[r.hour_local].engagement += r.likes + r.comments;
        }
        if (r.dow_local !== null) {
            const dn = DOW_NAMES[r.dow_local];
            days[dn] = days[dn] || { count: 0, engagement: 0 };
            days[dn].count++; days[dn].engagement += r.likes + r.comments;
        }
    });
    const rank = o => Object.entries(o)
        .map(([k, v]) => ({ key: k, count: v.count, avgEngagement: Math.round(v.engagement / v.count) }))
        .sort((a, b) => b.avgEngagement - a.avgEngagement);

    // --- last 30 days ------------------------------------------------------
    const cutoff = Date.now() - 30 * 86400000;
    const recent = rows.filter(r => r.posted_at && new Date(r.posted_at).getTime() >= cutoff);
    const recentEng = recent.reduce((s, r) => s + r.likes + r.comments, 0);

    // --- leaderboards ------------------------------------------------------
    const leaderboards = {
        format:  igLeaderboard(statPool, 'post_type', 2),
        length:  igLeaderboard(statPool, 'length_band', 2),
        opening: igLeaderboard(statPool, 'opening_pattern', 2),
        aspect:  igLeaderboard(statPool.filter(r => r.aspect_ratio), 'aspect_ratio', 2)
    };

    const topicAgg = {};
    statPool.forEach(r => (r.topic_tags || []).forEach(t => {
        (topicAgg[t] = topicAgg[t] || []).push(r);
    }));
    leaderboards.topic = Object.entries(topicAgg)
        .filter(([, g]) => g.length >= 2)
        .map(([key, g]) => ({
            key, posts: g.length,
            share: ((g.length / n) * 100).toFixed(1) + '%',
            ...igAggIndex(g),
            medEngagement: Math.round(median(g.map(r => r.engagement_raw)))
        }))
        .sort((a, b) => (b.medIndex ?? -1) - (a.medIndex ?? -1))
        .slice(0, 12);

    // --- copy flags --------------------------------------------------------
    const flags = [
        igFlagCompare(statPool, 'has_question', 'Asks a question', 'No question'),
        igFlagCompare(statPool, 'has_cta',      'Has a call to action', 'No CTA'),
        igFlagCompare(statPool, 'has_offer',    'Mentions an offer', 'No offer'),
        igFlagCompare(statPool, 'has_emoji',    'Uses emoji', 'No emoji'),
        igFlagCompare(statPool, 'has_link',     'Points at a link', 'No link'),
        igFlagCompare(statPool, 'is_carousel',  'Carousel', 'Single media'),
        igFlagCompare(statPool, 'has_alt_text', 'Has alt text', 'No alt text')
    ].filter(Boolean);

    // --- posts -------------------------------------------------------------
    const card = r => ({
        url: r.post_url,
        shortcode: r.shortcode,
        likes: r.likes,
        comments: r.comments,
        views: r.views,
        type: r.post_type,
        index: r.performance_index,
        postedAt: r.posted_at,
        caption: (r.caption || '').slice(0, 300),
        thumbnail: r.thumbnail_url,
        aspect: r.aspect_ratio,
        carouselCount: r.carousel_count,
        provisional: r.is_provisional
    });

    const byEngagement = [...statPool].sort((a, b) => b.engagement_raw - a.engagement_raw);
    const topPosts = byEngagement.slice(0, 6).map(card);
    const bottomPosts = byEngagement.slice(-4).reverse().map(card);

    const best = (pred) => {
        const pool = statPool.filter(pred).sort((a, b) => (b.performance_index || 0) - (a.performance_index || 0));
        return pool.length ? card(pool[0]) : null;
    };
    const exemplars = {
        bestOverall: byEngagement.length ? card(byEngagement[0]) : null,
        bestReel: best(r => r.post_type === 'Reel'),
        bestCarousel: best(r => r.is_carousel),
        bestStill: best(r => r.post_type === 'Image'),
        mostCommented: [...statPool].sort((a, b) => b.comments - a.comments)[0]
            ? card([...statPool].sort((a, b) => b.comments - a.comments)[0]) : null
    };

    const extras = igExtras(rows);

    // --- score -------------------------------------------------------------
    const commentRatio = distribution.likes.median > 0
        ? (distribution.comments.median / distribution.likes.median) * 100
        : 0;
    const scoreBreakdown = igComputeScore({
        // Median rates, so the grade describes the account rather than its
        // single best day.
        engagementRate: parseFloat(engagementRateMedian),
        postsPerWeek: cadence.postsPerWeek,
        consistency: cadence.consistency,
        commentRatio,
        viewsPerFollower: parseFloat(viralityScoreMedian),
        completeness: completeness.score,
        momentumPct: mo.changePct,
        formatSpread: Object.keys(mix).length,
        sampleSize: rows.length,
        viewsAvailable: distribution.viewsAvailable
    });

    // v1 score, retained so reports saved before this patch stay comparable
    // against reports saved after it.
    const scoreV1 = Math.round(
        Math.min(40, parseFloat(engagementRate) * 13) +
        Math.min(25, parseFloat(viralityScore) * 12) +
        Math.min(20, cadence.postsPerWeek * 4) +
        Math.min(15, Object.keys(mix).length * 5)
    );

    return {
        ...base,

        // --- v1 surface, unchanged shape -----------------------------------
        engagementRate,
        viralityScore,
        engagementRateMedian,
        viralityScoreMedian,
        postsPerWeek: String(cadence.postsPerWeek),
        score: IG_SCORE_V2 ? scoreBreakdown.score : scoreV1,
        grade: IG_SCORE_V2 ? scoreBreakdown.grade
             : scoreV1 >= 85 ? 'A+' : scoreV1 >= 70 ? 'A' : scoreV1 >= 55 ? 'B' : scoreV1 >= 40 ? 'C' : 'D',
        scoreV1,
        avgLikes: Math.round(avgLikes),
        avgComments: Math.round(avgComments),
        avgViews: Math.round(avgViews),
        contentMix,
        topHashtags,
        postingHours: rank(hours).slice(0, 8),
        postingDays: rank(days),
        captionInsight,
        consistency: {
            postsPerWeek: String(cadence.postsPerWeek),
            longestGapDays: String(cadence.longestGapDays),
            windowDays: String(cadence.spanDays)
        },
        last30Days: {
            posts: recent.length,
            totalEngagement: recentEng,
            avgEngagement: recent.length ? Math.round(recentEng / recent.length) : 0
        },
        topPosts,

        // --- phase 4 ---------------------------------------------------------
        bottomPosts,
        exemplars,
        distribution,
        cadence,
        momentum: mo,
        heatmap,
        scoreBreakdown,
        completeness,
        leaderboards,
        flags,
        extras,
        provisional: {
            count: rows.length - settled.length,
            settled: settled.length,
            total: rows.length,
            excludedFromRates: usingSettledOnly,
            // The posts themselves, not just a count. Telling someone "2 posts
            // were excluded" without saying which is worse than not mentioning
            // it — they cannot check the call.
            posts: rows.filter(r => r.is_provisional)
                       .sort((a, b) => new Date(b.posted_at) - new Date(a.posted_at))
                       .slice(0, 6).map(card),
            note: usingSettledOnly
                ? `${rows.length - settled.length} post(s) newer than the settle window are shown but excluded from rates.`
                : 'Too few settled posts to exclude the new ones — rates include everything.'
        },
        dataQuality: igDataQuality(rows, posts)
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
/**
 * Serialise a payload to fit a character budget WITHOUT slicing the string.
 *
 * The old code did `JSON.stringify(payload).slice(0, 60000)`, which cuts
 * mid-token and hands the model an unterminated string inside an unclosed
 * array inside an unclosed object. It also cut in key order, so on a
 * comparison run the budget was exhausted inside `target` and the rivals and
 * the benchmark were never transmitted at all — while the prompt still asked
 * for competitor insights.
 *
 * This drops whole top-level sections, largest first, in reverse priority
 * order, and records what it dropped inside the document. The output is always
 * valid JSON and the model is always told what is missing.
 */
function budgetedJson(payload, { maxChars = 40000, keep = [] } = {}) {
    let obj = { ...(payload || {}) };
    let out = JSON.stringify(obj);
    if (out.length <= maxChars) return { json: out, dropped: [], chars: out.length };

    const dropped = [];
    // Biggest first, but never touch anything the prompt depends on.
    const candidates = Object.keys(obj)
        .filter(k => !keep.includes(k))
        .map(k => ({ k, size: JSON.stringify(obj[k] || null).length }))
        .sort((a, b) => b.size - a.size);

    for (const c of candidates) {
        if (out.length <= maxChars) break;
        delete obj[c.k];
        dropped.push(c.k);
        obj._omitted = dropped;
        out = JSON.stringify(obj);
    }

    // Everything droppable is gone and it still does not fit. Truncate the
    // arrays inside what is left rather than the string that holds them.
    if (out.length > maxChars) {
        for (const k of Object.keys(obj)) {
            if (Array.isArray(obj[k]) && obj[k].length > 3) obj[k] = obj[k].slice(0, 3);
        }
        obj._omitted = dropped.concat('array-tails');
        out = JSON.stringify(obj);
    }

    METRICS.ai.dropped += dropped.length;
    return { json: out, dropped, chars: out.length };
}

// ---------------------------------------------------------------------------
// GEMINI KEY POOL + MODEL DISCOVERY (phase 9)
//
// Before this, every narrative in the system went through one env key and one
// hard-coded model name. A free-tier 429 on that key stalled every report at
// once, and a retired model name turned into a 404 that was never retried.
//
// Resolution order for a call made on behalf of a user:
//   1. that user's own active gemini_keys rows
//   2. the shared pool (owner_user_id null), least recently used first
//   3. GEMINI_API_KEY from the environment
//
// A 429 puts the key on a short cooldown and the call moves to the next key
// immediately. A model 404 marks that model dead for an hour and moves on.
//
// Model names are not guessed: at first use the pool asks the API which models
// this key can call (models.list) and prefers the newest "flash" line, then
// "flash-lite", then "pro". GEMINI_MODEL, if set, always goes first, and
// GEMINI_MODEL_FALLBACKS is the static safety net if discovery fails.
// ---------------------------------------------------------------------------
const GEMINI_MODEL_FALLBACKS = (process.env.GEMINI_MODEL_FALLBACKS ||
    'gemini-2.5-flash,gemini-2.5-flash-lite,gemini-2.0-flash')
    .split(',').map(s => s.trim()).filter(Boolean);
const GEMINI_DISCOVERY_TTL_MS = 3600000;
const _geminiDiscovered = { models: [], t: 0 };

/** Rank a model id: newer flash first, then flash-lite, then pro. Previews/experimental last. */
function geminiRank(name) {
    const m = String(name).match(/gemini-(\d+(?:\.\d+)?)-(flash-lite|flash|pro)/i);
    if (!m) return null;
    const ver = parseFloat(m[1]);
    const line = m[2].toLowerCase();
    const penalty = /preview|exp|latest|tts|image|audio|live|thinking/i.test(name) ? 1000 : 0;
    const lineScore = line === 'flash' ? 0 : line === 'flash-lite' ? 100 : 200;
    return penalty + lineScore - ver;   // lower is better
}

async function geminiDiscoverModels(key) {
    if (Date.now() - _geminiDiscovered.t < GEMINI_DISCOVERY_TTL_MS) return _geminiDiscovered.models;
    _geminiDiscovered.t = Date.now();
    try {
        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } });
        if (!r.ok) throw new Error('models.list ' + r.status);
        const data = await r.json();
        const names = (data.models || [])
            .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
            .map(m => String(m.name || '').replace(/^models\//, ''))
            .filter(n => geminiRank(n) !== null)
            .sort((a, b) => geminiRank(a) - geminiRank(b));
        _geminiDiscovered.models = names.slice(0, 6);
        logger.info('gemini_models_discovered', { preferred: _geminiDiscovered.models.slice(0, 3) });
    } catch (err) {
        logger.warn('gemini_model_discovery_failed', { message: err.message });
        _geminiDiscovered.models = [];
    }
    return _geminiDiscovered.models;
}

const GEMINI_KEY_COOLDOWN_MS = parseInt(process.env.GEMINI_KEY_COOLDOWN_MS || '90000', 10);
const GEMINI_DEAD_MODEL_MS   = 3600000;

const _geminiDeadModels = new Map();     // model -> ts
const _geminiPool = { rows: [], t: 0 };  // cached gemini_keys rows (decrypted lazily)
const _geminiCoolLocal = new Map();      // key id -> cooldown until (ms); survives a stale pool cache
const GEMINI_POOL_TTL_MS = 60000;

async function geminiModelChain(key) {
    const discovered = key ? await geminiDiscoverModels(key) : [];
    const envFirst = process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : [];
    const chain = [...envFirst, ...discovered, GEMINI_MODEL, ...GEMINI_MODEL_FALLBACKS].filter((m, i, a) => m && a.indexOf(m) === i);
    const now = Date.now();
    const live = chain.filter(m => !(_geminiDeadModels.get(m) && now - _geminiDeadModels.get(m) < GEMINI_DEAD_MODEL_MS));
    return live.length ? live : chain;
}

async function loadGeminiPool(force = false) {
    if (!force && Date.now() - _geminiPool.t < GEMINI_POOL_TTL_MS) return _geminiPool.rows;
    try {
        const { data, error } = await supabase.from('gemini_keys')
            .select('id, owner_user_id, key_enc, status, cooldown_until, last_used_at, fail_count')
            .neq('status', 'invalid')
            .order('last_used_at', { ascending: true, nullsFirst: true });
        if (error) throw error;
        _geminiPool.rows = data || [];
    } catch (err) {
        // Table missing (migration not run) or transient. Env key still works.
        if (!/relation .* does not exist/i.test(err.message || '')) logger.warn('gemini_pool_load_failed', { message: err.message });
        _geminiPool.rows = [];
    }
    _geminiPool.t = Date.now();
    return _geminiPool.rows;
}
function invalidateGeminiPool() { _geminiPool.t = 0; }

/** Is any narrative source configured at all? Sync, from the cached pool. */
function geminiAvailable() {
    return !!GEMINI_API_KEY || _geminiPool.rows.length > 0;
}

/** Ordered candidate keys for a user. Each: { id, key, source }. */
async function geminiCandidates(userId) {
    const rows = await loadGeminiPool();
    const now = Date.now();
    const usable = rows.filter(r => !(r.status === 'cooldown' && r.cooldown_until && new Date(r.cooldown_until).getTime() > now))
                       .filter(r => !(_geminiCoolLocal.get(r.id) > now));
    const own = usable.filter(r => userId && r.owner_user_id === userId);
    const shared = usable.filter(r => !r.owner_user_id);
    const out = [];
    for (const r of [...own, ...shared]) {
        try { out.push({ id: r.id, key: decryptSecret(r.key_enc), source: r.owner_user_id ? 'personal' : 'pool' }); }
        catch (err) { logger.warn('gemini_key_undecryptable', { id: r.id }); }
    }
    if (GEMINI_API_KEY) out.push({ id: null, key: GEMINI_API_KEY, source: 'env' });
    return out;
}

async function geminiMarkKey(id, patch) {
    if (!id) return;
    try { await supabase.from('gemini_keys').update(patch).eq('id', id); } catch (_) {}
    invalidateGeminiPool();
}

function geminiIsThinkingLevelModel(model) { return /gemini-3/i.test(model); }

/**
 * One call to Gemini. Returns a status object, never a bare null.
 *
 *   { ok: true,  data: {...}, reason: 'ok', model, keySource }
 *   { ok: false, data: null,  reason: 'no_key' | 'http_4xx' | 'max_tokens' |
 *                                     'blocked' | 'empty' | 'unparseable' |
 *                                     'network' | 'exhausted' }
 */
async function geminiCallDetailed(prompt, {
    temperature = 0.5,
    maxOutputTokens = parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS || '8192', 10),
    thinkingBudget = parseInt(process.env.GEMINI_THINKING_BUDGET || '2048', 10),
    tag = 'gemini',
    retries = 3,
    userId = null
} = {}) {
    const uid = userId || ELS.getStore()?.userId || null;
    const candidates = await geminiCandidates(uid);
    if (!candidates.length) return { ok: false, data: null, reason: 'no_key' };

    METRICS.gemini.calls += 1;
    METRICS.ai.promptChars += prompt.length;

    const buildBody = (text, model, withThinking) => {
        const generationConfig = { temperature, maxOutputTokens, responseMimeType: 'application/json' };
        if (withThinking) {
            generationConfig.thinkingConfig = geminiIsThinkingLevelModel(model)
                ? { thinkingLevel: 'low' }
                : { thinkingBudget };
        }
        return JSON.stringify({ contents: [{ role: 'user', parts: [{ text }] }], generationConfig });
    };

    let text = prompt;
    let repairUsed = false;
    let keyIdx = 0;
    let withThinking = true;
    const models = await geminiModelChain(candidates[0].key);
    let modelIdx = 0;
    let lastReason = 'exhausted';
    const maxAttempts = retries + candidates.length + models.length;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (keyIdx >= candidates.length) { keyIdx = 0; await new Promise(r => setTimeout(r, Math.min(2000 * Math.pow(2, attempt), 15000))); }
        if (modelIdx >= models.length) break;
        const cand = candidates[keyIdx];
        const model = models[modelIdx];
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

        try {
            const r = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cand.key },
                body: buildBody(text, model, withThinking)
            });

            if (r.status === 429) {
                METRICS.gemini.retries += 1;
                logger.warn('gemini_rate_limited', { tag, model, keySource: cand.source, keyId: cand.id });
                if (cand.id) _geminiCoolLocal.set(cand.id, Date.now() + GEMINI_KEY_COOLDOWN_MS);
                await geminiMarkKey(cand.id, { status: 'cooldown', cooldown_until: new Date(Date.now() + GEMINI_KEY_COOLDOWN_MS).toISOString(), last_error: '429' });
                keyIdx += 1; lastReason = 'exhausted';
                continue;
            }

            if (r.status === 404 || r.status === 400 || r.status === 403 || r.status >= 500) {
                const body = (await r.text()).slice(0, 400);
                const isModelProblem = r.status === 404 || /model|not found|no longer available|not supported/i.test(body);
                const isThinkingProblem = r.status === 400 && /thinking/i.test(body);
                const isKeyProblem = (r.status === 400 || r.status === 403) && /api key|API_KEY|permission|not valid/i.test(body);

                if (isThinkingProblem && withThinking) { withThinking = false; logger.warn('gemini_thinking_config_rejected', { tag, model }); continue; }
                if (isKeyProblem) {
                    logger.warn('gemini_key_invalid', { tag, keySource: cand.source, keyId: cand.id, body });
                    await geminiMarkKey(cand.id, { status: 'invalid', last_error: body.slice(0, 200), fail_count: 99 });
                    keyIdx += 1; lastReason = 'http_' + r.status;
                    continue;
                }
                if (isModelProblem && r.status !== 403) {
                    _geminiDeadModels.set(model, Date.now());
                    logger.warn('gemini_model_unavailable', { tag, model, status: r.status, body });
                    alertOnce('gemini_model:' + model, `Gemini model ${model} is unavailable (${r.status}); falling back.`, { tag });
                    modelIdx += 1; lastReason = 'http_' + r.status;
                    continue;
                }
                if (r.status >= 500) {
                    METRICS.gemini.retries += 1;
                    logger.warn('gemini_retry', { tag, status: r.status, attempt: attempt + 1 });
                    await new Promise(res => setTimeout(res, Math.min(2000 * Math.pow(2, attempt), 15000)));
                    continue;
                }
                METRICS.gemini.failed += 1; METRICS.ai.failed += 1;
                logger.error('gemini_failed', { tag, status: r.status, body });
                return { ok: false, data: null, reason: 'http_' + r.status, detail: body, model };
            }

            if (!r.ok) {
                METRICS.gemini.failed += 1; METRICS.ai.failed += 1;
                const body = (await r.text()).slice(0, 300);
                logger.error('gemini_failed', { tag, status: r.status, body });
                alertOnce('gemini_failed', `Gemini returned ${r.status}. Reports will ship without their narrative layer.`, { tag });
                return { ok: false, data: null, reason: 'http_' + r.status, detail: body, model };
            }

            await geminiMarkKey(cand.id, { last_used_at: new Date().toISOString(), status: 'active', cooldown_until: null });

            const data = await r.json();
            const c0 = data?.candidates?.[0];
            const finish = String(c0?.finishReason || '').toUpperCase();
            const raw = (c0?.content?.parts || []).filter(p => !p.thought).map(x => x.text || '').join('');

            if (finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT' || finish === 'RECITATION') {
                METRICS.gemini.failed += 1; METRICS.ai.failed += 1;
                logger.warn('gemini_blocked', { tag, finishReason: finish });
                return { ok: false, data: null, reason: 'blocked', detail: finish, model };
            }
            if (finish === 'MAX_TOKENS') {
                METRICS.gemini.failed += 1; METRICS.ai.truncated += 1;
                logger.warn('gemini_max_tokens', { tag, model, maxOutputTokens, promptChars: text.length, chars: raw.length });
                alertOnce('gemini_max_tokens', 'Gemini hit its output cap before finishing the JSON. Raise GEMINI_MAX_OUTPUT_TOKENS.', { tag });
                return { ok: false, data: null, reason: 'max_tokens', model };
            }
            if (!raw.trim()) {
                METRICS.gemini.failed += 1; METRICS.ai.failed += 1;
                logger.warn('gemini_empty', { tag, finishReason: finish || 'none' });
                return { ok: false, data: null, reason: 'empty', detail: finish || null, model };
            }

            try {
                const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
                METRICS.gemini.ok += 1; METRICS.ai.ok += 1;
                return { ok: true, data: parsed, reason: 'ok', model, keySource: cand.source };
            } catch (parseErr) {
                if (repairUsed) {
                    METRICS.gemini.failed += 1; METRICS.ai.failed += 1;
                    logger.error('gemini_unparseable', { tag, chars: raw.length, head: raw.slice(0, 200) });
                    return { ok: false, data: null, reason: 'unparseable', model };
                }
                repairUsed = true;
                METRICS.gemini.retries += 1;
                text = prompt +
                    '\n\nYour previous reply was not valid JSON. Reply again with ONLY the JSON object, ' +
                    'no markdown fences, no commentary, and make sure every bracket and quote is closed.';
                continue;
            }
        } catch (err) {
            logger.error('gemini_error', { tag, attempt: attempt + 1, message: err.message });
            lastReason = 'network';
            await new Promise(res => setTimeout(res, Math.min(2000 * Math.pow(2, attempt), 15000)));
        }
    }
    METRICS.gemini.failed += 1; METRICS.ai.failed += 1;
    return { ok: false, data: null, reason: lastReason };
}

/** Back-compat shape: the parsed object, or null. */
async function geminiCall(prompt, opts = {}) {
    const r = await geminiCallDetailed(prompt, opts);
    return r.ok ? r.data : null;
}

/** Human-readable version of a failure reason, for the report and the UI. */
function aiReasonText(reason) {
    switch (reason) {
        case 'ok':          return 'Generated.';
        case 'no_key':      return 'No Gemini API key is configured on this server.';
        case 'max_tokens':  return 'The model ran out of output budget before it finished. Raise GEMINI_MAX_OUTPUT_TOKENS.';
        case 'blocked':     return 'The model declined to answer for this content.';
        case 'empty':       return 'The model returned an empty response.';
        case 'unparseable': return 'The model returned something that was not valid JSON, twice.';
        case 'network':     return 'The strategy service could not be reached.';
        case 'exhausted':   return 'The strategy service was rate limited and did not recover in time.';
        default:
            if (String(reason).startsWith('http_')) return `The strategy service returned ${String(reason).slice(5)}.`;
            return 'The strategy layer could not be generated.';
    }
}

// ---------------------------------------------------------------------------
// AI PAYLOAD PROJECTORS
//
// The render payload and the model payload are two different documents and
// were being treated as one. A single IG audit serialises to 50-90KB, and
// most of that is thumbnail URLs — Instagram CDN links run 600-1500 characters
// each and there are 21 post cards per account. None of it helps the model.
//
// These projectors carry the numbers a strategist would actually reason over
// and drop everything that only exists to be drawn on screen.
// ---------------------------------------------------------------------------

const AI_PROMPT_BUDGET = parseInt(process.env.AI_PROMPT_BUDGET_CHARS || '40000', 10);

/** A post reduced to the parts that carry signal. No media URLs. */
function aiPostCard(p) {
    if (!p) return null;
    return {
        type: p.type || p.postType || null,
        likes: p.likes ?? null,
        comments: p.comments ?? null,
        views: p.views ?? null,
        index: p.index ?? null,
        postedAt: p.postedAt || p.posted_at || null,
        caption: String(p.caption || '').slice(0, 160)
    };
}

function igAiSlim(a) {
    if (!a) return null;
    return {
        handle: a.handle,
        followers: a.followers,
        totalPosts: a.totalPosts,
        category: a.category,
        isBusiness: a.isBusiness,
        isVerified: a.isVerified,
        bio: String(a.bio || '').slice(0, 300),
        postsAnalyzed: a.postsAnalyzed,
        score: a.score,
        grade: a.grade,
        engagementRate: a.engagementRate,
        engagementRateMedian: a.engagementRateMedian,
        viralityScore: a.viralityScore,
        avgLikes: a.avgLikes,
        avgComments: a.avgComments,
        avgViews: a.avgViews,
        postsPerWeek: a.postsPerWeek,
        scorePillars: (a.scoreBreakdown?.breakdown || [])
            .map(b => ({ pillar: b.pillar, points: b.points, max: b.max, detail: b.detail })),
        confidence: a.scoreBreakdown
            ? { lowConfidence: a.scoreBreakdown.lowConfidence, sampleSize: a.scoreBreakdown.sampleSize, verdict: a.scoreBreakdown.verdict }
            : null,
        completeness: a.completeness
            ? { score: a.completeness.score, missing: a.completeness.missing }
            : null,
        contentMix: a.contentMix,
        topHashtags: (a.topHashtags || []).slice(0, 12),
        captionInsight: a.captionInsight,
        cadence: a.cadence ? {
            postsPerWeek: a.cadence.postsPerWeek,
            longestGapDays: a.cadence.longestGapDays,
            consistency: a.cadence.consistency,
            spanDays: a.cadence.spanDays
        } : null,
        momentum: a.momentum,
        last30Days: a.last30Days,
        bestHours: (a.heatmap?.bestHours || []).slice(0, 5),
        worstHours: (a.heatmap?.worstHours || []).slice(0, 3),
        bestDays: (a.heatmap?.bestDays || []).slice(0, 4),
        heatmapReliable: a.heatmap?.reliable ?? null,
        leaderboards: a.leaderboards ? {
            format: (a.leaderboards.format || []).slice(0, 6),
            length: (a.leaderboards.length || []).slice(0, 6),
            opening: (a.leaderboards.opening || []).slice(0, 6),
            topic: (a.leaderboards.topic || []).slice(0, 8)
        } : null,
        copyFlags: a.flags,
        topPosts: (a.topPosts || []).slice(0, 5).map(aiPostCard),
        bottomPosts: (a.bottomPosts || []).slice(0, 3).map(aiPostCard),
        provisionalExcluded: a.provisional
            ? { count: a.provisional.count, excludedFromRates: a.provisional.excludedFromRates }
            : null,
        missingSignals: a.dataQuality?.missing || []
    };
}

function igAiPayload({ target, rivals = [], benchmark = null }) {
    return {
        target: igAiSlim(target),
        rivals: (rivals || []).slice(0, 6).map(igAiSlim),
        benchmark: benchmark ? {
            cohort: benchmark.cohort,
            targetRank: benchmark.targetRank,
            gaps: benchmark.gaps || null,
            leaders: benchmark.leaders || null
        } : null
    };
}

function fbGroupAiSlim(g) {
    if (!g) return null;
    return {
        name: g.name,
        groupId: g.groupId,
        members: g.members ?? null,
        postsAnalyzed: g.postsAnalyzed,
        roomValue: g.roomValue,
        medianComments: g.medianComments,
        medianReactions: g.medianReactions,
        postsPerDay: g.postsPerDay ?? g.cadence?.postsPerDay ?? null,
        demandSignals: g.demandSignals,
        rules: g.rules,
        intents: g.intents,
        categories: g.categories,
        formats: g.formats || g.mediaMix || null,
        bestHours: (g.heatmap?.bestHours || g.bestHours || []).slice(0, 5),
        bestDays: (g.heatmap?.bestDays || g.bestDays || []).slice(0, 4),
        leaderboards: g.leaderboards,
        topDemand: (g.topDemand || g.demand || []).slice(0, 12),
        exemplars: (g.exemplars || []).slice(0, 4).map(aiPostCard)
    };
}

function fbPageAiSlim(p) {
    if (!p) return null;
    return {
        name: p.name,
        pageId: p.pageId,
        category: p.category,
        likes: p.likes ?? null,
        followers: p.followers ?? null,
        postsAnalyzed: p.postsAnalyzed,
        score: p.score,
        grade: p.grade,
        engagementRate: p.engagementRate,
        avgReactions: p.avgReactions,
        avgComments: p.avgComments,
        avgShares: p.avgShares,
        scorePillars: (p.scoreBreakdown?.breakdown || [])
            .map(b => ({ pillar: b.pillar, points: b.points, max: b.max, detail: b.detail })),
        completeness: p.completeness ? { score: p.completeness.score, missing: p.completeness.missing } : null,
        cadence: p.cadence,
        momentum: p.momentum,
        sentiment: p.sentiment || p.reactionSentiment || null,
        bestHours: (p.heatmap?.bestHours || []).slice(0, 5),
        bestDays: (p.heatmap?.bestDays || []).slice(0, 4),
        leaderboards: p.leaderboards,
        copyFlags: p.flags,
        reviews: p.reviews ? { rating: p.reviews.rating, count: p.reviews.count, themes: (p.reviews.themes || []).slice(0, 8) } : null,
        topPosts: (p.topPosts || []).slice(0, 5).map(aiPostCard),
        bottomPosts: (p.bottomPosts || []).slice(0, 3).map(aiPostCard),
        missingSignals: p.dataQuality?.missing || []
    };
}

async function geminiNarrative(payload) {
    if (!geminiAvailable()) {
        return { ai: null, aiStatus: { ok: false, reason: 'no_key', message: aiReasonText('no_key') } };
    }

    const { json, dropped, chars } = budgetedJson(igAiPayload(payload), {
        maxChars: AI_PROMPT_BUDGET,
        keep: ['target', 'benchmark']
    });

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
Ground every claim in the numbers supplied. Never invent a metric that is not in the data.
If the rivals array is empty, return an empty array for competitor_insights rather than guessing.

DATA:
${json}`;

    const r = await geminiCallDetailed(prompt, { temperature: 0.4, tag: 'Gemini IG' });
    logger.info('ai_narrative', { tag: 'ig', ok: r.ok, reason: r.reason, promptChars: chars, dropped });
    return {
        ai: r.data,
        aiStatus: {
            ok: r.ok, reason: r.reason, message: aiReasonText(r.reason),
            promptChars: chars, dropped, model: GEMINI_MODEL,
            generatedAt: new Date().toISOString()
        }
    };
}

// ===========================================================================
// JOB ENGINE
// ===========================================================================

// ===========================================================================
// QUOTA  (phase 13)
//
// Engine access decides whether an account may touch a tool at all. Quota
// decides how much of it they get. The two stay separate on purpose: a trial
// client without the content_plan grant never reaches this layer, and a client
// who has the grant is still held to a ceiling.
//
// Item caps assume a run costs about what a run usually costs. The usd cap is
// the one that actually protects the shared pool, because a runaway actor
// breaks that assumption without exceeding any item count.
// ===========================================================================

/**
 * Job types where one run is one countable item. Leadgen is absent on purpose:
 * a campaign's cost is the leads it writes, which is not known when the job is
 * created, so it is metered at insert time instead. Anything not listed here
 * is still held to the usd cap.
 */
const JOB_QUOTA_METRIC = {
    ig_report:          'ig_report',
    deep_audit:         'ig_report',
    fb_community_audit: 'fb_group_audit',
    fb_discovery:       'fb_group_audit'
};

const LEADGEN_JOB_TYPES = new Set(['leadgen_campaign', 'leadgen_enrich', 'fb_lead_discovery']);

const QUOTA_DEFAULT_KEY = { trial: 'trial_caps', paid: 'client_monthly_caps' };

/**
 * Used only when system_settings holds nothing parseable. Fails closed: an
 * unreadable setting must not read as "no limit", which is exactly the case
 * where the pool gets drained.
 */
const QUOTA_FALLBACK = {
    trial: { ig_report: 1, fb_group_audit: 1, leads: 50,  usd: 2 },
    paid:  { ig_report: 4, fb_group_audit: 4, leads: 500, usd: 25 }
};

/**
 * The counter a state writes to. Trial spend lives in its own bucket so a
 * trial cap and a monthly cap never share a counter, and nothing has to be
 * reset when an account converts.
 */
function quotaPeriod(state) {
    if (state === 'trial') return 'trial';
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Authoritative state, from the database rather than the auth cache. */
async function accountStateDb(userId) {
    const { data, error } = await supabase.rpc('el_account_state', { p_user: userId });
    if (error) {
        logger.error('account_state_unavailable', { message: error.message });
        const err = new Error('Could not verify your account. Try again in a moment.');
        err.statusCode = 503;
        throw err;
    }
    return data || 'expired';
}

const _capsCache = new Map();
function invalidateQuotaCaps() { _capsCache.clear(); }

async function defaultCaps(state) {
    const key = QUOTA_DEFAULT_KEY[state];
    if (!key) return null;                       // admin and employee are uncapped by default
    const hit = _capsCache.get(key);
    if (hit && Date.now() - hit.t < AUTH_CACHE_MS) return hit.v;

    const { data } = await supabase.from('system_settings').select('value').eq('key', key).maybeSingle();
    let v;
    try {
        v = data?.value ? JSON.parse(data.value) : null;
    } catch (e) {
        logger.warn('quota_caps_unparsable', { key, message: e.message });
        v = null;
    }
    if (!v || typeof v !== 'object') v = QUOTA_FALLBACK[state] || QUOTA_FALLBACK.trial;

    _capsCache.set(key, { v, t: Date.now() });
    return v;
}

/** Length of the free trial, in days. Read once per cache window. */
async function trialDaysSetting() {
    const hit = _capsCache.get('trial_days');
    if (hit && Date.now() - hit.t < AUTH_CACHE_MS) return hit.v;

    const { data } = await supabase.from('system_settings')
        .select('value').eq('key', 'trial_days').maybeSingle();
    const n = parseInt(data?.value ?? '', 10);
    const v = Number.isFinite(n) && n > 0 && n <= 365 ? n : 7;

    _capsCache.set('trial_days', { v, t: Date.now() });
    return v;
}

/**
 * null means unlimited. A usage_limits row wins even when its cap is null,
 * which is how one client gets exempted from one metric without being
 * exempted from all of them.
 */
async function effectiveCap(userId, state, metric) {
    const { data } = await supabase.from('usage_limits')
        .select('cap').eq('user_id', userId).eq('metric', metric).maybeSingle();
    if (data) return data.cap === null ? null : Number(data.cap);

    const caps = await defaultCaps(state);
    if (!caps) return null;
    const c = caps[metric];
    return (c === undefined || c === null) ? null : Number(c);
}

async function quotaUsed(userId, period, metric) {
    const { data } = await supabase.from('usage_counters')
        .select('used').eq('user_id', userId).eq('period', period).eq('metric', metric).maybeSingle();
    return Number(data?.used || 0);
}

function quotaError(metric, cap) {
    const label = {
        ig_report:      'Instagram report',
        fb_group_audit: 'group audit',
        leads:          'lead',
        usd:            'usage'
    }[metric] || metric;
    const err = new Error(
        metric === 'usd'
            ? `This would exceed your usage allowance. Contact us to raise it.`
            : `You have used your ${label} allowance (${cap}). Contact us to raise it.`
    );
    err.statusCode = 402;
    // 402 covers both "your account lapsed" and "you hit your allowance", and
    // those are very different things to be told. The code is what lets the
    // client surface tell them apart — without it a client who runs out of
    // leads is shown "your access has ended", which is simply false.
    err.code = 'quota_exceeded';
    err.quotaMetric = metric;
    return err;
}

/**
 * Take quota for a job before it is queued. Everything taken is rolled back if
 * a later metric refuses, so a job that cannot start never leaves a dent in
 * the counters.
 *
 * Returns what was taken, which createJob records on the job so the failure
 * path can hand it back.
 */
async function reserveQuota(userId, type, creditsEstimate) {
    const state = await accountStateDb(userId);
    if (state === 'suspended' || state === 'expired') {
        const err = new Error(
            state === 'suspended'
                ? 'Account disabled. Contact your administrator.'
                : 'Your access has ended. Contact us to continue.'
        );
        err.statusCode = state === 'suspended' ? 403 : 402;
        err.code = state === 'suspended' ? 'account_suspended' : 'account_expired';
        throw err;
    }

    const period  = quotaPeriod(state);
    const wanted  = [];

    const metric = JOB_QUOTA_METRIC[type];
    if (metric) wanted.push({ metric, amount: 1 });

    const usd = Number(creditsEstimate) || 0;
    if (usd > 0) wanted.push({ metric: 'usd', amount: usd });

    // A leadgen run writes its leads later, so there is nothing to take here.
    // Refuse up front anyway when the allowance is already gone, rather than
    // letting a job start, spend on Apify, and then fail to save what it found.
    if (LEADGEN_JOB_TYPES.has(type)) {
        const cap = await effectiveCap(userId, state, 'leads');
        if (cap !== null && await quotaUsed(userId, period, 'leads') >= cap) {
            throw quotaError('leads', cap);
        }
    }

    const taken = [];
    for (const w of wanted) {
        const cap = await effectiveCap(userId, state, w.metric);
        if (cap === null) continue;
        const { error } = await supabase.rpc('el_quota_consume', {
            p_user: userId, p_period: period, p_metric: w.metric, p_amount: w.amount, p_cap: cap
        });
        if (error) {
            for (const back of taken) {
                await supabase.rpc('el_quota_release', {
                    p_user: userId, p_period: period, p_metric: back.metric, p_amount: back.amount
                }).catch(() => {});
            }
            if (String(error.message || '').includes('quota_exceeded')) throw quotaError(w.metric, cap);
            throw error;
        }
        taken.push(w);
    }

    return { period, taken };
}

/**
 * Leads are metered as they are written rather than when the job is queued,
 * because a campaign cannot know how many it will find. Returns how many of
 * `want` may be saved, having already taken that many from the allowance.
 *
 * Deliberately partial: finding 80 leads against 50 of allowance saves 50 and
 * warns, rather than refusing the batch. The scrape is already paid for by
 * then, so throwing away all 80 would waste money that has left the account.
 */
async function takeLeadQuota(userId, want) {
    if (!(want > 0)) return 0;

    const state = await accountStateDb(userId);
    if (state === 'suspended' || state === 'expired') return 0;

    const cap = await effectiveCap(userId, state, 'leads');
    if (cap === null) return want;

    const period = quotaPeriod(state);
    const room   = Math.max(0, cap - await quotaUsed(userId, period, 'leads'));
    const take   = Math.min(want, room);
    if (take <= 0) return 0;

    const { error } = await supabase.rpc('el_quota_consume', {
        p_user: userId, p_period: period, p_metric: 'leads', p_amount: take, p_cap: cap
    });
    if (error) {
        // A concurrent run took the room between the read and the write. Not an
        // error worth failing the job over: save none this pass and let the
        // caller say so.
        if (String(error.message || '').includes('quota_exceeded')) return 0;
        throw error;
    }
    return take;
}

/** Give back lead allowance taken for rows that then failed to save. */
async function refundLeadQuota(userId, amount) {
    if (!(amount > 0)) return;
    try {
        const state = await accountStateDb(userId);
        await supabase.rpc('el_quota_release', {
            p_user: userId, p_period: quotaPeriod(state), p_metric: 'leads', p_amount: amount
        });
    } catch (e) {
        logger.warn('lead_quota_refund_failed', { message: e.message });
    }
}

/** Hand back what a job reserved. Never throws — a failing job is already bad news. */
async function releaseQuota(userId, reservation) {
    if (!reservation || !Array.isArray(reservation.taken)) return;
    for (const t of reservation.taken) {
        try {
            await supabase.rpc('el_quota_release', {
                p_user: userId, p_period: reservation.period, p_metric: t.metric, p_amount: t.amount
            });
        } catch (e) {
            logger.warn('quota_release_failed', { metric: t.metric, message: e.message });
        }
    }
}

async function createJob(userId, type, engine, input, creditsEstimate) {
    // Every job in the product comes through here, which is the only reason a
    // ceiling is worth having: no route can forget to ask.
    const reservation = await reserveQuota(userId, type, creditsEstimate);

    const { data, error } = await supabase.from('jobs').insert([{
        user_id: userId, type, engine,
        // _quota rides on input because the failure path needs to know what to
        // hand back, and the period can roll over between queue and failure.
        input: { ...(input || {}), _quota: reservation },
        client_id: (input && UUID_RE.test(String(input.clientId || ''))) ? input.clientId : null,
        credits_estimate: creditsEstimate || null,
        status: 'queued', progress: 0, log: [],
        completed_units: []
    }]).select().single();

    if (error) {
        await releaseQuota(userId, reservation);
        throw error;
    }
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
let _rpcCheckpointAvailable = true;
async function savePartial(jobId, unit, value) {
    if (!jobId || !unit) return;
    const key = String(unit);

    // Append inside Postgres. The old read-modify-write was safe only because
    // a job processed one unit at a time; the moment two units overlap, or a
    // resumed job races the sweep, the losing write silently drops a completed
    // unit and the user pays to scrape it twice.
    if (_rpcCheckpointAvailable) {
        try {
            const { error } = await supabase.rpc('el_job_checkpoint', {
                p_job_id: jobId, p_unit: key,
                p_value: value === undefined ? null : value
            });
            if (!error) return;
            _rpcCheckpointAvailable = false;
            logger.warn('rpc_checkpoint_unavailable', { message: error.message });
        } catch (e) {
            _rpcCheckpointAvailable = false;
            logger.warn('rpc_checkpoint_unavailable', { message: e.message });
        }
    }

    try {
        const { data } = await supabase.from('jobs')
            .select('completed_units, partials').eq('id', jobId).maybeSingle();
        const done = Array.isArray(data?.completed_units) ? data.completed_units : [];
        const partials = (data?.partials && typeof data.partials === 'object') ? data.partials : {};
        if (!done.includes(key)) done.push(key);
        if (value !== undefined) partials[key] = value;
        await supabase.from('jobs')
            .update({ completed_units: done, partials, updated_at: new Date().toISOString() })
            .eq('id', jobId);
    } catch (e) { logger.error('save_partial_failed', { jobId, message: e.message }); }
}

/** The states a job can be picked back up from. Shared so the resume endpoint
 *  and the claim can never disagree about what is resumable. */
const RESUMABLE_STATUSES = ['paused_no_credit', 'interrupted', 'failed', 'cancelled'];

/**
 * Take exclusive ownership of a job before running it.
 *
 * The status check and the status write used to be two separate statements, so
 * a double-clicked Resume — or the same job resumed on two Render instances —
 * passed the check twice and ran the worker twice against one checkpoint. Both
 * copies then scraped the same pending units and both were billed.
 *
 * One conditional UPDATE is the claim. Whoever flips the row out of the
 * expected set wins; every other caller gets zero rows back and stops. This is
 * the job-level equivalent of what budget reservations already do at the key
 * level.
 */
async function claimJob(jobId, fromStatuses, { resume = false } = {}) {
    const patch = {
        status: 'running',
        error: null,
        cancel_requested: false,
        updated_at: new Date().toISOString()
    };
    if (!resume) patch.progress = 1;

    const { data, error } = await supabase.from('jobs')
        .update(patch)
        .eq('id', jobId)
        .in('status', fromStatuses)
        .select('id')
        .maybeSingle();

    if (error) throw error;
    return !!data;
}

/**
 * How many billable units a job's input describes.
 *
 * Resume needs this to price ONE remaining unit rather than the whole run. The
 * old divisor was `groups.length || competitors.length || 1`, and three job
 * types carry neither key, so it fell through to 1 and demanded the entire job
 * estimate be free on a single key before it would restart a run that was nine
 * tenths paid for.
 */
function jobUnitCount(job) {
    const i = job?.input || {};
    switch (job?.type) {
        case 'ig_report':          return 1 + (Array.isArray(i.rivals) ? i.rivals.length : 0);
        case 'deep_audit':         return 1 + (Array.isArray(i.competitors) ? i.competitors.length : 0);
        case 'fb_community_audit': return Math.max(1, (i.groups || []).length);
        case 'fb_discovery':       return Math.max(1, (i.seeds || []).length || Number(i.maxGroups) || 1);
        case 'fb_page_report':     return i.rival ? 2 : 1;
        case 'fb_verify':          return 1;
        case 'leadgen_campaign':   return Math.max(1, leadgenUnits(i).length);
        case 'leadgen_enrich':     return Math.max(1, Math.ceil((Number(i.batchSize) || 25) / 25));
        default:                   return 1;
    }
}

/**
 * Cooperative cancellation.
 *
 * An Apify run already in flight cannot be recalled, but the unit boundary is
 * where the money is: stopping before group 6 of 10 saves 5 units of credit.
 * Workers check this through the progress callback, so no worker needs to know
 * cancellation exists.
 */
class JobCancelled extends Error {
    constructor() { super('Cancelled'); this.name = 'JobCancelled'; this.code = 'CANCELLED'; }
}

/**
 * One progress tick: cancellation check, log append and progress write.
 *
 * This was three round trips — a select for cancel_requested, then updateJob's
 * select for the log, then the update — on every step of every job. Folding
 * the two reads together also means the cancellation decision and the log line
 * come from the same snapshot, and closes the read-modify-write on `log` that
 * dropped a line whenever two writes overlapped.
 */
async function jobTick(jobId, progress, step) {
    const { data } = await supabase.from('jobs')
        .select('cancel_requested, status, log').eq('id', jobId).maybeSingle();
    if (!data) return;
    if (data.cancel_requested || data.status === 'cancelled') throw new JobCancelled();

    const log = Array.isArray(data.log) ? data.log : [];
    if (step) log.push({ t: new Date().toISOString(), m: step });

    await supabase.from('jobs').update({
        progress,
        current_step: step,
        log: log.slice(-100),
        updated_at: new Date().toISOString()
    }).eq('id', jobId);
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
        let beat = null;
        let row = null;
        try {
            // Claim BEFORE reading the checkpoint. Losing the claim means some
            // other process already owns this job, and the correct action is to
            // do nothing at all rather than run a second copy of it.
            const claimed = opts.claimed === true || await claimJob(
                jobId,
                opts.resume ? RESUMABLE_STATUSES : ['queued'],
                { resume: !!opts.resume }
            );
            if (!claimed) {
                logger.warn('job_claim_lost', { jobId, resume: !!opts.resume });
                return;
            }

            row = (await supabase.from('jobs')
                .select('completed_units, partials, user_id, input').eq('id', jobId).maybeSingle()).data;
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

            const jobT0 = Date.now();
            if (opts.resume) METRICS.jobs.resumed += 1; else METRICS.jobs.started += 1;
            logger.info(opts.resume ? 'job_resumed' : 'job_started',
                { jobId, completedUnits: units.length });

            // The status write moved into claimJob above, where it is atomic.
            // This is only the log line.
            await updateJob(jobId, {},
                opts.resume ? `Resuming, ${units.length} unit(s) already complete` : 'Job started');

            // A unit that is one long actor call emits no progress tick for up
            // to APIFY_RUN_TIMEOUT_SECS. Without a heartbeat, sweepStaleJobs()
            // cannot tell that job apart from one killed by a restart, and it
            // parks a live run as resumable.
            beat = setInterval(() => {
                supabase.from('jobs')
                    .update({ updated_at: new Date().toISOString() })
                    .eq('id', jobId).eq('status', 'running')
                    .then(() => {}, () => {});
            }, 60000);
            beat.unref?.();

            // Every progress tick is also a cancellation checkpoint, which is
            // why workers get this for free without knowing about it.
            const progressFn = (progress, step) => jobTick(jobId, progress, step);

            const result = await ELS.run({ userId: row?.user_id || null }, () => worker(progressFn, ck));

            METRICS.jobs.done += 1;
            logger.info('job_done', { jobId, ms: Date.now() - jobT0, units: units.length });

            await updateJob(jobId, {
                status: 'done', progress: 100,
                result, result_report_id: result?.reportId || null,
                finished_at: new Date().toISOString()
            }, 'Job complete');
            if (row?.input?.scheduleId) scheduleNoteOutcome(row.input.scheduleId, { status: 'done', reportId: result?.reportId || null });
        } catch (err) {
            if (err && err.code === 'CANCELLED') {
                METRICS.jobs.cancelled += 1;
                logger.info('job_cancelled', { jobId });
                await updateJob(jobId, {
                    status: 'cancelled',
                    cancel_requested: false,
                    error: 'Cancelled. Anything already scraped was saved and will be reused if you run this again.',
                    finished_at: new Date().toISOString()
                }, 'Cancelled by the user');
                return;
            }
            if (err && err.code === 'NO_CREDIT') {
                METRICS.jobs.paused += 1;
                logger.warn('job_paused_no_credit', { jobId, message: err.message });
                await updateJob(jobId, {
                    status: 'paused_no_credit',
                    error: err.message
                }, 'Paused: ' + err.message);
                if (row?.input?.scheduleId) scheduleNoteOutcome(row.input.scheduleId, { status: 'paused_no_credit', error: err.message });
                return;
            }
            METRICS.jobs.failed += 1;
            logger.error('job_failed', { jobId, message: err.message, stack: (err.stack || '').slice(0, 600) });
            alertOnce('job_failed:' + (err.message || '').slice(0, 40),
                `A job failed: ${err.message}`, { jobId });
            await updateJob(jobId, {
                status: 'failed', error: err.message,
                finished_at: new Date().toISOString()
            }, 'Failed: ' + err.message);
            // Terminal failure only. paused_no_credit, interrupted and cancelled
            // all return above because they are resumable — handing their quota
            // back would let the resumed run take it a second time.
            await releaseQuota(row?.user_id, row?.input?._quota);
            if (row?.input?.scheduleId) scheduleNoteOutcome(row.input.scheduleId, { status: 'failed', error: err.message });
        } finally {
            if (beat) clearInterval(beat);
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
const AUTO_RESUME = String(process.env.AUTO_RESUME_JOBS || 'true') !== 'false';
const AUTO_RESUME_MAX = parseInt(process.env.AUTO_RESUME_MAX_ATTEMPTS || '2', 10);
const _autoResumeTries = new Map();

// A job id not seen in a day is finished, one way or another. _authCache and
// the rate-limit buckets both get swept; this one never was.
setInterval(() => {
    if (_autoResumeTries.size > 500) _autoResumeTries.clear();
}, 86400000).unref?.();

async function sweepStaleJobs() {
    const cutoff = new Date(Date.now() - JOB_STALE_MINUTES * 60000).toISOString();
    try {
        const { data } = await supabase.from('jobs')
            .select('id, type, user_id, input, completed_units')
            .in('status', ['running', 'queued'])
            .lt('updated_at', cutoff);

        const resumed = [];
        for (const j of (data || [])) {
            const n = Array.isArray(j.completed_units) ? j.completed_units.length : 0;
            // Every job type is registered as of phase 6, so canResume is now
            // true for all of them. The check stays because a job row written
            // by an older build can still carry a type this process does not
            // know, and telling its owner to resume would produce a 400.
            const canResume = !!JOB_WORKERS[j.type];
            await updateJob(j.id, {
                status: 'interrupted',
                error: 'The server restarted while this job was running. ' +
                       (!canResume
                           ? 'This job type cannot be resumed — start a new run.'
                           : n ? `${n} unit(s) were already saved — resume to finish the rest.`
                               : 'Nothing was charged. Resume to start again.')
            }, 'Interrupted by a server restart');

            // Pick it back up without waiting for a human to click Resume.
            //
            // The checkpoint makes this safe: claimJob() is a single
            // conditional UPDATE so only one process can win it, and every
            // completed unit is skipped rather than re-scraped. Leaving the
            // job parked meant a user who closed their laptop came back to a
            // dead run they had to restart by hand.
            if (AUTO_RESUME && canResume) {
                const tries = (_autoResumeTries.get(j.id) || 0) + 1;
                _autoResumeTries.set(j.id, tries);
                if (tries > AUTO_RESUME_MAX) {
                    logger.warn('auto_resume_giving_up', { jobId: j.id, tries });
                    await updateJob(j.id, {}, 'Auto-resume gave up after repeated interruptions — resume manually.');
                    continue;
                }
                try {
                    const factory = JOB_WORKERS[j.type];
                    runJob(j.id, factory(j.user_id, j.input || {}, j.id), { resume: true });
                    resumed.push(j.id);
                } catch (e) {
                    logger.error('auto_resume_failed', { jobId: j.id, message: e.message });
                }
            }
        }
        if (data?.length) {
            METRICS.jobs.interrupted += data.length;
            METRICS.jobs.autoResumed = (METRICS.jobs.autoResumed || 0) + resumed.length;
            logger.warn('jobs_interrupted', {
                count: data.length, ids: data.map(j => j.id), autoResumed: resumed.length
            });
            if (resumed.length < data.length) {
                alertOnce('jobs_interrupted',
                    `${data.length - resumed.length} job(s) were orphaned by a restart and could not be auto-resumed.`);
            }
        }
    } catch (e) { logger.error('sweep_failed', { message: e.message }); }
}

/**
 * Keep the instance awake while work is in flight.
 *
 * Render's free tier spins a web service down on absence of INBOUND HTTP. The
 * job heartbeat writes to Supabase, which is outbound and does not count, so
 * until now the only thing keeping a running job alive was the user's browser
 * polling it. Close the laptop mid-run and the instance slept, the Apify call
 * in flight was billed and produced nothing, and the job sat dead until
 * somebody came back and pressed Resume.
 *
 * One request to our own /api/health is inbound traffic and resets the idle
 * timer. It only fires when there is actually a job running.
 */
const SELF_URL = (process.env.SELF_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
const KEEPALIVE_MS = parseInt(process.env.KEEPALIVE_MS || '240000', 10);

async function keepAwakeIfBusy() {
    if (!SELF_URL) return;
    try {
        const { data } = await supabase.from('jobs')
            .select('id').in('status', ['running', 'queued']).limit(1);
        if (!data?.length) return;
        const r = await fetch(SELF_URL + '/api/health', { method: 'GET' });
        logger.debug('keepalive_ping', { status: r.status, jobs: data.length });
    } catch (e) {
        logger.debug('keepalive_failed', { message: e.message });
    }
}

/**
 * Release reservations left behind by a process that died mid-run.
 *
 * A reservation holds credit against the cycle on purpose — that is what stops
 * two runs double-spending the same key. But if the server is killed between
 * reserving and settling, that hold never clears and the key looks poorer than
 * it is until the month rolls over. Anything older than the maximum possible
 * run is by definition abandoned: the actor cannot still be going.
 */
async function sweepStaleReservations() {
    const cutoff = new Date(Date.now() - (APIFY_TIMEOUT_SECS + 300) * 1000).toISOString();
    try {
        const { data, error } = await supabase.from('apify_usage_events')
            .delete().eq('is_reservation', true).lt('created_at', cutoff)
            .select('id, usage_usd');
        if (error) throw error;
        if (data?.length) {
            const usd = data.reduce((sum, r) => sum + Number(r.usage_usd || 0), 0);
            logger.warn('reservations_released', { count: data.length, usd: +usd.toFixed(4) });
        }
    } catch (e) {
        // A missing is_reservation column means the phase 3 migration has not
        // run yet. Reservations are simply not in use, so there is nothing to
        // sweep and nothing to warn about on every tick.
        logger.debug('reservation_sweep_skipped', { message: e.message });
    }
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

    const persistence = await savePosts(userId, h, posts, meta);
    const audit = computeAudit(h, prof, posts);
    if (audit) audit.persistence = persistence;
    return audit;
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
                main = await auditHandle(await grab(), userId, cleanTarget, limit, { jobId, clientId: input.clientId || null });
                if (!main) throw new Error('Target profile could not be scraped.');
                if (main.persistence?.error) {
                    warnings.push('Posts could not be written to the database, so this run adds nothing to post history. ' +
                                  'The report itself is unaffected.');
                }
                await ck.done(cleanTarget, main);
            }

            const rivalAudits = [];
            for (let i = 0; i < rivals.length; i++) {
                const cached = ck.get(rivals[i]);
                if (cached) { rivalAudits.push(cached); continue; }

                await progress(5 + step * (i + 1), `Auditing rival @${rivals[i]} (${i + 1}/${rivals.length})`);
                try {
                    const a = await auditHandle(await grab(), userId, rivals[i], limit, { jobId, clientId: input.clientId || null });
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
            const { ai, aiStatus } = await geminiNarrative({ target: main, rivals: rivalAudits, benchmark });
            if (!aiStatus.ok) warnings.push(`Strategy layer unavailable: ${aiStatus.message}`);

            const payload = {
                main, rivals: rivalAudits, recommendations, benchmark, ai, aiStatus, warnings,
                scoreVersion: IG_SCORE_VERSION, generatedAt: new Date().toISOString()
            };
            const postsAnalyzed = main.postsAnalyzed + rivalAudits.reduce((s, r) => s + r.postsAnalyzed, 0);

            await progress(96, 'Saving report');
            const { data: saved } = await supabase.from('reports').insert([{
                user_id: userId,
                client_id: input.clientId || null,
                platform: 'instagram',
                // Stable per-worker type. The old 'single'/'compare' collided
                // with deep_audit's 'single', so the two vaults could not be told
                // apart. Legacy rows are backfilled by schema-phase7.sql.
                report_type: 'ig_report',
                target_handle: main.handle,
                competitor_handles: rivalAudits.map(r => r.handle),
                grade: main.grade,
                score: main.score,
                engagement_rate: parseFloat(main.engagementRate),
                posts_analyzed: postsAnalyzed,
                snapshot_date: new Date().toISOString().slice(0, 10),
                credits_estimate: estimate,
                score_version: IG_SCORE_VERSION,
                score_v1: main.scoreV1 ?? null,
                followers_snapshot: main.followers ?? null,
                posts_per_week: parseFloat(main.postsPerWeek) || null,
                cohort_avg_er: benchmark?.cohort?.avgEngagementRate ?? null,
                target_rank: benchmark?.targetRank ?? null,
                ai_summary: ai?.executive_summary || null,
                ai_json: ai || null,
                ai_status: aiStatus,
                report_json: payload
            }]).select('id').maybeSingle();

            // The payload is already in reports.report_json. Storing a second
            // copy in jobs.result doubled the write and shipped ~600KB to the
            // browser on the final poll. reportRef tells /api/job/:id to
            // hydrate it from the vault instead.
            return {
                reportId: saved?.id || null,
                reportRef: saved?.id || null,
                postsAnalyzed,
                aiStatus,
                report: saved?.id ? undefined : payload
            };
        });

registerWorker('deep_audit', (userId, input, jobId) => async (progress, ck) => {

    const cleanTarget  = String(input.target || '');
    const rivals       = Array.isArray(input.competitors) ? input.competitors : [];
    const limit        = input.postsPerAccount || DEFAULT_POSTS_PER_ACC;
    const activeSetId  = input.setId || null;
    const accounts     = rivals.length + 1;
    const estimate     = estimateCredits(accounts, limit);
    const perAccount   = estimateCredits(1, limit);

            const meta = { setId: activeSetId, jobId, clientId: input.clientId || null };
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
                if (main.persistence?.error) {
                    warnings.push('Posts could not be written to the database, so this run adds nothing to post history. ' +
                                  'The report itself is unaffected.');
                }
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
            const { ai, aiStatus } = await geminiNarrative({ target: main, rivals: rivalAudits, benchmark });
            if (!aiStatus.ok) warnings.push(`Strategy layer unavailable: ${aiStatus.message}`);

            const payload = {
                main, rivals: rivalAudits, benchmark, recommendations, ai, aiStatus, warnings,
                scoreVersion: IG_SCORE_VERSION, generatedAt: new Date().toISOString()
            };
            const postsAnalyzed = main.postsAnalyzed + rivalAudits.reduce((s, r) => s + r.postsAnalyzed, 0);

            await progress(96, 'Saving report');
            const { data: saved } = await supabase.from('reports').insert([{
                user_id: userId,
                client_id: input.clientId || null,
                platform: 'instagram',
                report_type: 'deep_audit',
                set_id: activeSetId,
                target_handle: main.handle,
                competitor_handles: rivalAudits.map(r => r.handle),
                grade: main.grade,
                score: main.score,
                engagement_rate: parseFloat(main.engagementRate),
                posts_analyzed: postsAnalyzed,
                snapshot_date: new Date().toISOString().slice(0, 10),
                credits_estimate: estimate,
                score_version: IG_SCORE_VERSION,
                score_v1: main.scoreV1 ?? null,
                followers_snapshot: main.followers ?? null,
                posts_per_week: parseFloat(main.postsPerWeek) || null,
                cohort_avg_er: benchmark?.cohort?.avgEngagementRate ?? null,
                target_rank: benchmark?.targetRank ?? null,
                ai_summary: ai?.executive_summary || null,
                ai_json: ai || null,
                ai_status: aiStatus,
                report_json: payload
            }]).select('id').maybeSingle();

            if (activeSetId) {
                await supabase.from('competitor_sets')
                    .update({ last_run_at: new Date().toISOString() }).eq('id', activeSetId);
            }

            return {
                reportId: saved?.id || null,
                reportRef: saved?.id || null,
                setId: activeSetId,
                postsAnalyzed,
                aiStatus,
                report: saved?.id ? undefined : payload
            };
        });

registerWorker('fb_community_audit', (userId, input, jobId) => async (progress, ck) => {

    const names = Array.isArray(input.groupNames) ? input.groupNames : [];
    const refs = (input.groups || []).map((id, i) => ({
        groupId: String(id),
        url: `https://www.facebook.com/groups/${id}/`,
        rowId: null,
        name: names[i] || String(id)
    }));
    const auditMode      = input.mode === 'individual' ? 'individual' : 'combined';
    const limit          = input.postsPerGroup || FB_DEFAULT_POSTS;
    const window         = input.days || FB_DEFAULT_DAYS;
    const sampleComments = !!input.sampleComments;
    const commentPosts   = sampleComments ? (input.commentSamplePosts ?? 20) : 0;
    const activeSetId    = input.setId || null;
    const niche          = input.niche || null;
    const location       = input.location || null;
    const since          = input.since || null;
    const estimate       = fbEstimateCredits(refs.length, limit, sampleComments, commentPosts);
    const perGroup       = fbEstimateCredits(1, limit, sampleComments, commentPosts);

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
                        limit, days: window, sampleComments, commentPosts, niche, location,
                        source: 'audit', since, jobId
                    });

                    if (!rows.length) {
                        await progress(5 + step * (i + 1), `${meta.name}: no public posts returned — likely private`);
                        const empty = computeGroupAudit(meta, [], []);
                        audits.push(empty);
                        await ck.done(refs[i].groupId, empty);   // the run was billed either way
                        continue;
                    }

                    await fbSavePosts(rows, input.clientId || null);
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

                    const { ai, aiStatus } = await fbNarrative({ mode: 'single', group: a });
                    const payload = { mode: 'individual', group: a, benchmark: null, ai, aiStatus };

                    const { data: saved } = await supabase.from('reports').insert([{
                        user_id: userId,
                        client_id: input.clientId || null,
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
                        credits_estimate: fbEstimateCredits(1, limit, sampleComments, commentPosts),
                        ai_summary: ai?.executive_summary || null,
                        ai_json: ai || null,
                        ai_status: aiStatus,
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
            const { ai, aiStatus } = await fbNarrative({ mode: 'combined', groups: audits, benchmark });

            const payload = { mode: 'combined', groups: audits, benchmark, ai, aiStatus };
            const live = audits.filter(a => a.postsAnalyzed > 0);

            await progress(94, 'Saving report');
            const { data: saved } = await supabase.from('reports').insert([{
                user_id: userId,
                client_id: input.clientId || null,
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
                ai_status: aiStatus,
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
                mode: 'combined', reportId: saved?.id || null, reportRef: saved?.id || null,
                setId: activeSetId, aiStatus,
                postsAnalyzed: totalPosts, demandSignals: totalDemand,
                report: saved?.id ? undefined : payload
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
                    limit, days: window, includeReviews, since, jobId, clientId: input.clientId || null
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
                            limit, days: window, includeReviews, since, jobId, clientId: input.clientId || null
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
            const { ai, aiStatus } = await fbPageNarrative({
                target: main, rival: rivalAudit, benchmark,
                brief: brief ? String(brief).slice(0, 600) : null
            });

            const payload = {
                mode: rivalAudit ? 'versus' : 'single',
                generatedAt: new Date().toISOString(),
                windowDays: window,
                target: main, rival: rivalAudit, benchmark, recommendations, ai, aiStatus,
                brief: brief || null
            };

            const postsAnalyzed = main.postsAnalyzed + (rivalAudit?.postsAnalyzed || 0);

            await progress(95, 'Saving report to the vault');
            const { data: saved } = await supabase.from('reports').insert([{
                user_id: userId,
                client_id: input.clientId || null,
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
                ai_status: aiStatus,
                followers_snapshot: main.followers ?? main.likes ?? null,
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
                reportId: saved?.id || null, reportRef: saved?.id || null,
                setId: activeSetId, aiStatus,
                mode: payload.mode, postsAnalyzed,
                report: saved?.id ? undefined : payload
            };
        });


// ---------------------------------------------------------------------------
// fb_discovery and fb_verify used to pass an inline closure to runJob rather
// than registering a factory, so they could not be rebuilt from jobs.input and
// could never be resumed. The sharper cost was that the discovery closure never
// touched the checkpoint at all — a 12-group run that died at group 11 lost all
// 11 paid units AND could not be picked back up. Both halves are fixed here.
// ---------------------------------------------------------------------------

registerWorker('fb_discovery', (userId, input, jobId) => async (progress, ck) => {
    const {
        location = '', niche = '', keywords = [],
        seeds = [], sampleSize = 40, maxGroups = 12
    } = input;

    const sample = Math.min(parseInt(sampleSize, 10) || 40, 120);
    const cap    = Math.min(parseInt(maxGroups, 10) || 12, FB_MAX_GROUPS);

    const { client } = await getWorkingClient('fb_community', userId, {
        needUsd: fbEstimateCredits(1, sample, false), jobId
    });

    let refs = (seeds || []).map(id => ({
        groupId: id, url: `https://www.facebook.com/groups/${id}/`
    }));

    // The search phase is itself a billable unit and is now checkpointed. It
    // used to be repeated in full on every attempt.
    if (!refs.length) {
        if (ck.isDone('search')) {
            refs = (ck.get('search') || []).slice(0, cap);
            await progress(15, `Reusing ${refs.length} candidate(s) from the earlier search`);
        } else {
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
                    }, { maxItems: 25, estimateUsd: fbEstimateCredits(1, 25, false), jobId });
                    (items || []).forEach(it => {
                        const ref = parseGroupRef(it.url || it.groupUrl || it.link || it.id);
                        if (!ref) return;
                        if (!found.has(ref.groupId)) found.set(ref.groupId, {
                            ...ref,
                            hintName: it.name || it.title || null,
                            hintMembers: firstNum(it.membersCount, it.memberCount)
                        });
                    });
                    await progress(12, `"${q}" returned ${items?.length || 0} candidates`);
                } catch (e) {
                    if (e.code === 'NO_CREDIT' || e.code === 'CANCELLED') throw e;
                    await progress(12, `Search for "${q}" failed: ${e.message}`);
                }
            }
            const all = Array.from(found.values());
            await ck.done('search', all);
            refs = all.slice(0, cap);
        }
    }

    if (!refs.length) {
        throw new Error('No groups found. Facebook group search is the least reliable part of this pipeline — paste group URLs directly on the Discover tab and they will be scored the same way.');
    }

    await progress(20, `Measuring ${refs.length} rooms`);

    const scored = [];
    const step = Math.max(1, Math.floor(70 / refs.length));

    for (let i = 0; i < refs.length; i++) {
        const unit = 'group:' + refs[i].groupId;

        // The whole point of registering this worker: a group already sampled
        // and paid for is replayed from the checkpoint.
        if (ck.isDone(unit)) {
            const saved = ck.get(unit);
            if (saved) scored.push(saved);
            await progress(20 + step * (i + 1), `${refs[i].groupId} already sampled — reused`);
            continue;
        }

        await progress(20 + step * i, `Sampling ${refs[i].groupId} (${i + 1}/${refs.length})`);
        try {
            const { meta, rows, demand } = await fbProcessGroup(client, userId, refs[i], {
                limit: sample, days: 30, sampleComments: false,
                niche, location, source: 'discovery'
            });

            if (meta.privacy === 'private') {
                await ck.done(unit, null);
                await progress(20 + step * (i + 1),
                    `${meta.name} is private — skipped (needs a logged-in session, which we will not do)`);
                continue;
            }

            await fbSavePosts(rows, input.clientId || null);
            await fbSaveDemand(demand);

            const audit = computeGroupAudit(meta, rows, demand);
            await supabase.from('fb_groups').update({
                posts_per_day: audit.postsPerDay,
                median_comments: audit.medianComments,
                unique_poster_ratio: audit.uniquePosterRatio,
                room_value_score: audit.roomValue,
                score_breakdown: audit.roomValueBreakdown,
                last_scraped_at: new Date().toISOString()
            }).eq('user_id', userId).eq('group_id', meta.group_id);

            const entry = {
                groupId: meta.group_id, name: meta.name, url: meta.url,
                memberCount: meta.member_count, privacy: meta.privacy,
                promoAllowed: meta.promo_allowed, approvalRequired: meta.approval_required,
                postsPerDay: audit.postsPerDay, medianComments: audit.medianComments,
                uniquePosters: audit.uniquePosters, uniquePosterRatio: audit.uniquePosterRatio,
                demandSignals: audit.demandSignals, demandRate: audit.demandRate,
                roomValue: audit.roomValue, breakdown: audit.roomValueBreakdown,
                postsSampled: audit.postsAnalyzed
            };
            scored.push(entry);
            await ck.done(unit, entry);
            await progress(20 + step * (i + 1),
                `${meta.name}: Room Value ${audit.roomValue} — ${audit.roomValueBreakdown.verdict}`);
        } catch (e) {
            if (e.code === 'NO_CREDIT' || e.code === 'CANCELLED') throw e;
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

registerWorker('fb_verify', (userId, input, jobId) => async (progress, ck) => {
    const { suggestionId } = input;

    // Read the row here, not in the handler. Closing over a request-scoped
    // object is exactly what stopped this job type from being resumable.
    const { data: sug } = await supabase.from('fb_suggestions')
        .select('*').eq('id', suggestionId).eq('user_id', userId).maybeSingle();
    if (!sug) throw new Error('That suggestion no longer exists.');

    const { client } = await getWorkingClient('fb_community', userId, {
        needUsd: fbEstimateCredits(1, 80, false), jobId
    });

    let rows;
    if (ck.isDone('scrape')) {
        rows = ck.get('scrape') || [];
        await progress(60, 'Reusing the feed already scraped for this check');
    } else {
        await progress(20, `Re-scraping ${sug.group_name}`);
        const ref = { groupId: sug.group_id, url: `https://www.facebook.com/groups/${sug.group_id}/` };
        const r = await fbProcessGroup(client, userId, ref,
            { limit: 80, days: 14, sampleComments: false, source: 'verify' });
        rows = r.rows;
        await fbSavePosts(rows, input.clientId || null);
        await ck.done('scrape', rows);
    }

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
    }).eq('id', sug.id).eq('user_id', userId);

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

// ===========================================================================
// PHASE 4 — OPERATIONS ENDPOINTS
// ===========================================================================

/**
 * The constants a report run is priced on, and which actor each one covers.
 * Adding a constant here is all it takes to bring it under validation.
 */
function costConstants() {
    return [
        { name: 'COST_PER_1K_POSTS',   env: 'COST_PER_1K_POSTS',   value: COST_PER_1K_POSTS,
          actors: ['apify/instagram-scraper'], unit: 'items' },
        { name: 'COST_PER_1K_PROFILE', env: 'COST_PER_1K_PROFILE', value: COST_PER_1K_PROFILE,
          actors: ['apify/instagram-profile-scraper'], unit: 'items' },
        { name: 'COST_PER_1K_FB_POSTS', env: 'COST_PER_1K_FB_POSTS', value: COST_PER_1K_FB_POSTS,
          actors: [FB_GROUP_POSTS_ACTOR, FB_SEARCH_ACTOR, FB_COMMENTS_ACTOR], unit: 'items' }
    ];
}

app.get('/api/admin/cost-reality', async (req, res) => {
    const ctx = await requireAdmin(req, res);
    if (!ctx) return;

    const days = Math.min(365, Math.max(1, parseInt(req.query.days || '90', 10)));
    const since = new Date(Date.now() - days * 86400000).toISOString();

    try {
        // Settled events only. A reservation row still carries the estimate,
        // and validating an estimate against itself would always agree.
        const { data: events, error } = await supabase.from('apify_usage_events')
            .select('actor_id, usage_usd, items, compute_units, created_at')
            .eq('is_reservation', false)
            .gt('usage_usd', 0)
            .gte('created_at', since)
            .limit(20000);

        if (error) throw new Error(error.message);

        const byActor = {};
        (events || []).forEach(e => {
            if (!e.actor_id) return;
            (byActor[e.actor_id] = byActor[e.actor_id] || []).push(e);
        });

        const actorRows = Object.entries(byActor).map(([actorId, evs]) => {
            const withItems = evs.filter(e => (e.items || 0) > 0);
            const perK = withItems.map(e => (Number(e.usage_usd) / e.items) * 1000);
            const totalUsd = evs.reduce((s, e) => s + Number(e.usage_usd || 0), 0);
            const totalItems = evs.reduce((s, e) => s + (e.items || 0), 0);

            return {
                actorId,
                runs: evs.length,
                runsWithItems: withItems.length,
                totalUsd: +totalUsd.toFixed(4),
                totalItems,
                // Median, not mean. One run that timed out after scraping four
                // items would otherwise set the constant for everything.
                medianUsdPer1k: perK.length ? +median(perK).toFixed(3) : null,
                meanUsdPer1k: perK.length ? +(perK.reduce((s, v) => s + v, 0) / perK.length).toFixed(3) : null,
                p90UsdPer1k: perK.length
                    ? +[...perK].sort((a, b) => a - b)[Math.min(perK.length - 1, Math.floor(perK.length * 0.9))].toFixed(3)
                    : null,
                blendedUsdPer1k: totalItems > 0 ? +((totalUsd / totalItems) * 1000).toFixed(3) : null
            };
        });

        const verdicts = costConstants().map(c => {
            const matched = actorRows.filter(a => c.actors.includes(a.actorId));
            const sample = matched.reduce((s, a) => s + a.runsWithItems, 0);
            const observed = matched.length
                ? +median(matched.map(a => a.medianUsdPer1k).filter(v => v != null)).toFixed(3)
                : null;

            const ratio = observed != null && c.value > 0 ? observed / c.value : null;
            const status =
                sample < 10          ? 'insufficient-data' :
                ratio == null        ? 'no-data' :
                ratio > 1.25         ? 'UNDER-ESTIMATING'  :   // runs cost more than we reserve
                ratio < 0.6          ? 'over-estimating'   :   // we reserve far more than we spend
                                       'ok';

            return {
                constant: c.name,
                env: c.env,
                configured: c.value,
                observedUsdPer1k: observed,
                ratio: ratio != null ? +ratio.toFixed(2) : null,
                sampleRuns: sample,
                status,
                // The number to actually put in the env var: the p90, not the
                // median. An estimate that is right half the time is an
                // estimate that pauses half the jobs it prices.
                suggested: matched.length
                    ? +Math.max(...matched.map(a => a.p90UsdPer1k || 0)).toFixed(2)
                    : null,
                note:
                    status === 'insufficient-data' ? `Only ${sample} settled runs with item counts in the last ${days} days — not enough to move a constant on.` :
                    status === 'UNDER-ESTIMATING'  ? 'Runs are costing more than the reservation. This is the direction that causes surprise budget exhaustion mid-job.' :
                    status === 'over-estimating'   ? 'Reserving well above actual. Jobs are being declined for budget they would never have used.' :
                    'Within tolerance.'
            };
        });

        res.json({
            windowDays: days,
            settledEvents: (events || []).length,
            // The whole point of the endpoint, stated plainly.
            summary: verdicts.filter(v => v.status === 'UNDER-ESTIMATING' || v.status === 'over-estimating')
                .map(v => `${v.constant}: configured ${v.configured}, observed ${v.observedUsdPer1k} (${v.ratio}x) — suggest ${v.suggested}`),
            allWithinTolerance: verdicts.every(v => v.status === 'ok' || v.status === 'insufficient-data'),
            constants: verdicts,
            actors: actorRows.sort((a, b) => b.totalUsd - a.totalUsd)
        });
    } catch (e) {
        logger.error('cost_reality_failed', { message: e.message });
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/rotate-encryption-key', async (req, res) => {
    const ctx = await requireAdmin(req, res);
    if (!ctx) return;

    // Master admin only. This one touches every credential in the system.
    if (!MASTER_ADMIN_EMAIL || (ctx.user.email || '').toLowerCase() !== MASTER_ADMIN_EMAIL) {
        return res.status(403).json({ error: 'Key rotation is restricted to the master admin.' });
    }

    const dryRun = req.body?.confirm !== 'rotate';
    try {
        const report = await rotateEncryptionKey({ dryRun });
        res.status(report.error ? 400 : 200).json(report);
    } catch (e) {
        logger.error('rotate_key_failed', { message: e.message });
        res.status(500).json({ error: e.message });
    }
});

// ===========================================================================
// SYSTEM
// ===========================================================================

app.get('/api/health', (req, res) => res.json({
    ok: true,
    ts: new Date().toISOString(),
    version: APP_VERSION,
    uptimeSecs: Math.round((Date.now() - BOOT_TS) / 1000),
    encryptionAtRest: !!ENC_KEY,
    rotationPending: !!ENC_KEY_OLD,
    keepAlive: !!SELF_URL,
    igScoreVersion: IG_SCORE_VERSION,
    instance: INSTANCE_ID,
    instances: METRICS.instances || null,
    scheduler: SCHEDULER_ENABLED,
    ai: { model: GEMINI_MODEL, discovered: _geminiDiscovered.models.slice(0, 3), poolKeys: _geminiPool.rows.length, envKey: !!GEMINI_API_KEY, configured: geminiAvailable(), ok: METRICS.ai.ok, failed: METRICS.ai.failed, truncated: METRICS.ai.truncated },
    // Whether the Meta app credentials are set at all. Booleans and the API
    // version only — no ids, no secret. This was invisible from outside, which
    // made "is Meta connected up?" unanswerable without signing in, and that
    // is the first question anyone asks when the owner assistant says it has
    // no owner numbers. `configured` says the server CAN start an OAuth
    // handshake; it says nothing about whether the Meta app has passed review,
    // which is what decides if anyone outside your dev/tester list can finish one.
    meta: { configured: metaConfigured(), graphVersion: META_GRAPH_VERSION, scopes: META_SCOPES.length },
    budgetMode: BUDGET_MODE
}));

/**
 * Everything you need to answer "is it quietly burning money or quietly
 * broken". Admin only: it exposes spend and key health.
 */
app.get('/api/admin/metrics', async (req, res) => {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        const month = String(req.query.month || cycleMonth());

        const [{ data: jobRows }, { data: usageRows }, { data: keyRows }] = await Promise.all([
            supabase.from('jobs').select('status').limit(2000),
            supabase.from('apify_usage_events')
                .select('engine, usage_usd, apify_username, items, actor_id, is_reservation')
                .eq('cycle_month', month).limit(5000),
            supabase.from('apify_keys')
                .select('status, engine, owner_user_id, apify_username, label, monthly_credit_usd, token_hash')
        ]);

        const jobsByStatus = {};
        (jobRows || []).forEach(j => { jobsByStatus[j.status] = (jobsByStatus[j.status] || 0) + 1; });

        const spendByEngine = {}, spendByKey = {}, runsByActor = {};
        let totalSpend = 0, totalItems = 0, reservedUsd = 0, openReservations = 0;
        (usageRows || []).forEach(u => {
            const usd = Number(u.usage_usd || 0);
            // A reservation is credit claimed by a run still in flight. It is
            // committed against the budget but has not settled, so it is
            // reported separately rather than folded into actual spend.
            if (u.is_reservation) { reservedUsd += usd; openReservations += 1; return; }
            totalSpend += usd;
            totalItems += Number(u.items || 0);
            spendByEngine[u.engine || 'unknown'] = +((spendByEngine[u.engine || 'unknown'] || 0) + usd).toFixed(4);
            spendByKey[u.apify_username || 'unknown'] = +((spendByKey[u.apify_username || 'unknown'] || 0) + usd).toFixed(4);
            const a = runsByActor[u.actor_id || 'unknown'] || { runs: 0, usd: 0, items: 0 };
            a.runs += 1; a.usd = +(a.usd + usd).toFixed(4); a.items += Number(u.items || 0);
            runsByActor[u.actor_id || 'unknown'] = a;
        });

        const keysByStatus = {};
        (keyRows || []).forEach(k => { keysByStatus[k.status] = (keysByStatus[k.status] || 0) + 1; });

        // What each key is allowed to spend against what it has spent. This is
        // the view that answers "are we about to run out" before a job pauses.
        const keyBudgets = [];
        for (const k of (keyRows || [])) {
            const credit = Number(k.monthly_credit_usd) > 0 ? Number(k.monthly_credit_usd) : APIFY_CYCLE_CREDIT;
            const spent = k.token_hash ? await cycleUsage(k.token_hash, month) : 0;
            keyBudgets.push({
                label: k.apify_username || k.label || 'unnamed',
                engine: k.engine, status: k.status,
                scope: k.owner_user_id ? 'personal' : 'shared',
                creditUsd: +credit.toFixed(2),
                spentUsd: +spent.toFixed(4),
                remainingUsd: +Math.max(0, credit - spent).toFixed(4)
            });
        }
        keyBudgets.sort((a, b) => b.remainingUsd - a.remainingUsd);

        // Real cost per 1k rows this cycle. This is the number the estimate
        // constants in env are supposed to approximate — compare them.
        const actualPer1k = totalItems ? +((totalSpend / totalItems) * 1000).toFixed(3) : null;

        res.json({
            ts: new Date().toISOString(),
            version: APP_VERSION,
            uptimeSecs: Math.round((Date.now() - BOOT_TS) / 1000),
            cycle: month,
            config: {
                budgetMode: BUDGET_MODE,
                creditPerKeyUsd: APIFY_CYCLE_CREDIT,
                encryptionAtRest: !!ENC_KEY,
                alertWebhook: !!ALERT_WEBHOOK,
                geminiModel: GEMINI_MODEL,
                memoryMb: APIFY_MEMORY_MB,
                timeoutSecs: APIFY_TIMEOUT_SECS,
                estimateConstants: {
                    COST_PER_1K_POSTS,
                    COST_PER_1K_PROFILE,
                    COST_PER_1K_FB_POSTS
                },
                fbDefaults: {
                    postsPerGroup: FB_DEFAULT_POSTS,
                    groups: FB_DEFAULT_GROUPS,
                    daysWindow: FB_DEFAULT_DAYS
                }
            },
            counters: {
                ...METRICS,
                apify: { ...METRICS.apify, usd: +METRICS.apify.usd.toFixed(4) }
            },
            spend: {
                totalUsd: +totalSpend.toFixed(4),
                totalItems,
                actualCostPer1kItems: actualPer1k,
                reservedUsd: +reservedUsd.toFixed(4),
                openReservations,
                byEngine: spendByEngine,
                byKey: spendByKey,
                byActor: runsByActor
            },
            jobs: jobsByStatus,
            keys: { byStatus: keysByStatus, total: (keyRows || []).length, budgets: keyBudgets },
            recentEvents: RECENT_EVENTS.slice(-40)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ===========================================================================
// SELF-SERVE SIGNUP SUPPORT  (phase 13)
//
// The signup itself happens in the browser against Supabase Auth, because
// that is what sends the confirmation email — and email confirmation is the
// thing standing between a 7-day trial on the shared Apify pool and someone
// farming it with addresses they do not own. The server's part is this
// precheck, plus ensureProfile() minting the account as a trial client on
// first login.
// ===========================================================================

const SIGNUP_MIN_PASSWORD = parseInt(process.env.SIGNUP_MIN_PASSWORD || '10', 10);

/**
 * HaveIBeenPwned range lookup, k-anonymity: SHA-1 the password, send the first
 * five hex characters, match the remaining 35 locally. The password itself
 * never leaves this process and HIBP never learns which hash we wanted.
 *
 * Supabase does this natively, but only on Pro plans, so we do it ourselves.
 *
 * Fails OPEN. A breach checker that takes signup down whenever a third party
 * is slow costs more than the checks it would have caught, and Supabase still
 * enforces minimum length underneath us.
 */
async function isLeakedPassword(password) {
    try {
        const sha1   = crypto.createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
        const prefix = sha1.slice(0, 5);
        const suffix = sha1.slice(5);

        const r = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
            headers: { 'Add-Padding': 'true' },
            signal: AbortSignal.timeout ? AbortSignal.timeout(3500) : undefined
        });
        if (!r.ok) return false;

        for (const line of (await r.text()).split('\n')) {
            const [hash, count] = line.trim().split(':');
            if (hash === suffix && parseInt(count || '0', 10) > 0) return true;
        }
        return false;
    } catch (e) {
        logger.warn('hibp_unavailable', { message: e.message });
        return false;
    }
}

/**
 * Called by the signup page before it hands the password to Supabase.
 *
 * Advisory by nature — anything client-side can be skipped by not being a
 * browser. It is still worth having: it protects everyone who uses the form,
 * and the floor that cannot be bypassed (minimum length) is enforced by
 * Supabase Auth itself.
 *
 * Rate limited hard. This endpoint takes a plaintext password from an
 * unauthenticated caller, so it must not become an oracle to grind against.
 */
app.post('/api/public/signup/password-check',
    rateLimit({ windowMs: 60000, max: 10 }),
    async (req, res) => {
        const password = String(req.body?.password || '');
        if (password.length < SIGNUP_MIN_PASSWORD) {
            return res.json({
                ok: false,
                reason: 'too_short',
                error: `Use at least ${SIGNUP_MIN_PASSWORD} characters.`
            });
        }
        if (await isLeakedPassword(password)) {
            return res.json({
                ok: false,
                reason: 'breached',
                error: 'That password has appeared in a known data breach. Pick a different one.'
            });
        }
        res.json({ ok: true });
    });

/**
 * "I want to keep going." (phase 26)
 *
 * Reachable by a trial client at any time and by a LAPSED client — the one
 * route that is. It records the wish on the account; the admin sees it as
 * "wants to continue", first in the list, with the activation control next
 * to it. Nothing is paid here; money is collected out of band by decision.
 */
app.post('/api/me/request-activation', rateLimit({ windowMs: 60000, max: 5, key: bearerId }), async (req, res) => {
    try {
        const ctx = await auth(req, res, { allowLapsed: true }); if (!ctx) return;
        if (ctx.profile.role !== 'client') return res.status(400).json({ error: 'Only a client account asks to continue.' });
        const note = String(req.body?.note || '').trim().slice(0, 500) || null;
        const now = new Date().toISOString();
        const { error } = await supabase.from('app_users')
            .update({ activation_requested_at: now, activation_note: note, updated_at: now }).eq('id', ctx.user.id);
        if (error) throw error;
        // The auth cache holds the old profile for a minute; the next /api/me
        // must show the request as sent.
        for (const [k, v] of _authCache) if (v.ctx?.user?.id === ctx.user.id) _authCache.delete(k);
        logger.info('activation_requested', { userId: ctx.user.id, state: accountState(ctx.profile) });
        res.json({ success: true, requestedAt: now, email: ctx.user.email || null });
    } catch (err) { sendErr(res, err); }
});

app.get('/api/me', async (req, res) => {
    const ctx = await auth(req, res); if (!ctx) return;
    const { data: access } = await supabase.from('user_engine_access')
        .select('engine').eq('user_id', ctx.user.id);

    const state = accountState(ctx.profile);
    const body = {
        id: ctx.user.id,
        email: ctx.user.email,
        role: ctx.profile.role,
        engines: ctx.profile.role === 'admin' ? ENGINES : (access || []).map(a => a.engine),
        state
    };

    // Only a client needs a window and an allowance on screen. An employee
    // seeing "0 of 50 leads" would just be confusing.
    if (ctx.profile.role === 'admin') {
        // What is waiting for them, so the sidebar can say so without a
        // trip to the admin page.
        const { count } = await supabase.from('app_users').select('id', { count: 'exact', head: true })
            .eq('role', 'client').not('activation_requested_at', 'is', null);
        body.pendingActivations = count || 0;
    }

    if (ctx.profile.role === 'client') {
        const own = await ownClientFor(ctx).catch(() => null);
        body.business = own ? { id: own.id, name: own.name, ig_handle: own.ig_handle || null } : null;
        body.activation_requested_at = ctx.profile.activation_requested_at || null;
        body.trial_ends_at = ctx.profile.trial_ends_at || null;
        body.paid_until    = ctx.profile.paid_until || null;
        body.plan_label    = ctx.profile.plan_label || null;

        if (state === 'trial' || state === 'paid') {
            const period = quotaPeriod(state);
            const { data: rows } = await supabase.from('usage_counters')
                .select('metric, used').eq('user_id', ctx.user.id).eq('period', period);

            const used = Object.fromEntries((rows || []).map(r => [r.metric, Number(r.used)]));
            body.usage = {};
            for (const metric of ['ig_report', 'fb_group_audit', 'leads', 'usd']) {
                const cap = await effectiveCap(ctx.user.id, state, metric);
                body.usage[metric] = {
                    used: used[metric] || 0,
                    cap: cap === null ? null : cap,
                    remaining: cap === null ? null : Math.max(0, cap - (used[metric] || 0))
                };
            }
        }
    }

    res.json(body);
});

/**
 * Connectivity badge. Authenticated, because it discloses the Apify username.
 *
 * This is called on every page load by every user. It used to run a database
 * write and a live round trip to Apify each time, which cost latency on the
 * free tier and — worse — mutated key status as a side effect of somebody
 * merely looking at a page. It is now cached per user + engine, and the
 * expensive path only runs on a miss or when explicitly refreshed.
 */
const _statusCache = new Map();
const STATUS_TTL_MS = parseInt(process.env.ACTOR_STATUS_TTL_MS || '120000', 10);

setInterval(() => {
    const now = Date.now();
    for (const [k, v] of _statusCache) if (now - v.t > STATUS_TTL_MS * 4) _statusCache.delete(k);
}, 600000).unref?.();

app.get('/api/actor-status', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const engine = ENGINES.includes(req.query.engine) ? req.query.engine : 'leadgen';
        const cacheKey = ctx.user.id + ':' + engine;
        const force = req.query.refresh === '1' || req.query.refresh === 'true';

        const hit = _statusCache.get(cacheKey);
        if (!force && hit && Date.now() - hit.t < STATUS_TTL_MS) {
            return res.status(200).json({ ...hit.v, cached: true });
        }

        let payload;
        try {
            const { apifyUsername, candidate, budget } = await getWorkingClient(engine, ctx.user.id);
            payload = {
                active: true, username: apifyUsername, engine,
                source: candidate.source,
                remainingUsd: budget ? +Math.max(0, budget.remaining).toFixed(2) : null
            };
        } catch (err) {
            payload = {
                active: false, engine,
                error: err.code === 'NO_CREDIT' ? 'No credit' : 'Invalid/Expired Key'
            };
        }

        _statusCache.set(cacheKey, { v: payload, t: Date.now() });
        res.status(200).json(payload);
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

        const requester = { id: ctx.user.id, role: ctx.profile.role };

        if (ctx.profile.role === 'admin') {
            // Demote the outgoing primary into the global pool instead of
            // discarding it. Apify credit renews monthly, so a key that is dry
            // today is worth $5 again in a few weeks — throwing it away leaks
            // budget every single rotation.
            const previous = await getEnginePrimary(activeEngine);
            if (previous && previous !== newApiKey) {
                try {
                    await saveKeyRow(previous, {
                        ownerUserId: null,
                        engine: activeEngine,
                        label: `demoted primary (${activeEngine})`,
                        status: 'exhausted',
                        requester
                    });
                } catch (e) { logger.warn('demote_primary_failed', { message: e.message }); }
            }

            await setEnginePrimary(activeEngine, newApiKey);
        } else {
            // Non-admins set their own personal key for that engine. saveKeyRow
            // refuses if that token is already registered to somebody else.
            await saveKeyRow(newApiKey, {
                ownerUserId: ctx.user.id,
                engine: activeEngine,
                label: 'personal',
                apifyUsername: apifyUser.username,
                requester
            });
        }
        _byoCache.delete(ctx.user.id);
        _primaryCreditCache.clear();
        for (const k of [..._statusCache.keys()]) {
            if (k.startsWith(ctx.user.id + ':')) _statusCache.delete(k);
        }

        res.status(200).json({
            success: true,
            message: 'Apify key verified and saved.',
            username: apifyUser.username,
            engine: activeEngine,
            scope: ctx.profile.role === 'admin' ? 'engine_primary' : 'personal'
        });
    } catch (err) {
        if (err.code === 'KEY_CONFLICT') return res.status(409).json({ error: err.message });
        res.status(400).json({ error: 'Key verification failed: ' + err.message });
    }
});

// --- Key pool -------------------------------------------------------------

app.get('/api/apify-keys', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const isAdmin = ctx.profile.role === 'admin';

        let q = supabase.from('apify_keys')
            .select('id, owner_user_id, engine, label, apify_username, status, fail_count, last_used_at, created_at, monthly_credit_usd, token_hash')
            .order('created_at', { ascending: false });

        if (!isAdmin) q = q.eq('owner_user_id', ctx.user.id);

        const { data, error } = await q;
        if (error) throw error;

        const primaries = {};
        for (const e of ENGINES) {
            const v = await getEnginePrimary(e);
            primaries[e] = v
                ? {
                    configured: true,
                    masked: maskSecret(v),
                    creditUsd: await enginePrimaryCredit(e),
                    spentUsd: +(await cycleUsage(tokenHash(v))).toFixed(4)
                  }
                : { configured: false, creditUsd: await enginePrimaryCredit(e) };
        }

        // Live spend per key, so the admin screen shows what is left rather
        // than only what is configured.
        const month = cycleMonth();
        const keys = [];
        for (const k of (data || [])) {
            const credit = Number(k.monthly_credit_usd) > 0 ? Number(k.monthly_credit_usd) : APIFY_CYCLE_CREDIT;
            const spent = k.token_hash ? await cycleUsage(k.token_hash, month) : 0;
            const { token_hash, ...safe } = k;
            keys.push({
                ...safe,
                creditUsd: +credit.toFixed(2),
                spentUsd: +spent.toFixed(4),
                remainingUsd: +Math.max(0, credit - spent).toFixed(4)
            });
        }

        res.json({ keys, primaries, defaultCreditUsd: APIFY_CYCLE_CREDIT, cycleMonth: month });
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

        const data = await saveKeyRow(token, {
            ownerUserId: owner,
            engine: eng,
            label: label || apifyUser.username,
            apifyUsername: apifyUser.username,
            requester: { id: ctx.user.id, role: ctx.profile.role }
        });

        res.json({ success: true, key: data });
    } catch (err) {
        if (err.code === 'KEY_CONFLICT') return res.status(409).json({ error: err.message });
        res.status(400).json({ error: 'Key rejected: ' + err.message });
    }
});

app.post('/api/apify-keys/:id/recheck', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        let q = supabase.from('apify_keys').select('*').eq('id', req.params.id);
        if (ctx.profile.role !== 'admin') q = q.eq('owner_user_id', ctx.user.id);
        const { data: key } = await q.maybeSingle();
        if (!key) return res.status(404).json({ error: 'Key not found' });

        try {
            const u = await new ApifyClient({ token: decryptSecret(key.token) }).user().get();
            await markKey(key.id, { status: 'active', fail_count: 0, apify_username: u.username, last_checked_at: new Date().toISOString() });
            res.json({ success: true, status: 'active', username: u.username });
        } catch (e) {
            await markKey(key.id, { status: 'invalid', last_checked_at: new Date().toISOString() });
            res.json({ success: false, status: 'invalid', error: e.message });
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * Per-key cycle credit.
 *
 * The single global APIFY_MONTHLY_CREDIT_USD capped everybody at the free-tier
 * $5, including a customer paying Apify $49 a month. Raising the env var lifted
 * the ceiling for every key at once, including the free ones, which is the
 * wrong lever. A limit now lives on the key it describes.
 */
app.patch('/api/apify-keys/:id', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const patch = {};

        if (req.body.monthlyCreditUsd !== undefined) {
            const n = parseFloat(req.body.monthlyCreditUsd);
            if (!(n >= 0) || n > 10000) return res.status(400).json({ error: 'Enter a credit limit between 0 and 10000.' });
            patch.monthly_credit_usd = n || null;      // null falls back to the default
        }
        if (req.body.label !== undefined)  patch.label  = String(req.body.label).slice(0, 120) || null;
        if (req.body.status !== undefined && ctx.profile.role === 'admin') {
            if (!['active', 'exhausted', 'invalid'].includes(req.body.status)) {
                return res.status(400).json({ error: 'Unknown status.' });
            }
            patch.status = req.body.status;
            if (req.body.status === 'active') patch.fail_count = 0;
        }
        if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update.' });

        let q = supabase.from('apify_keys').update(patch).eq('id', req.params.id);
        if (ctx.profile.role !== 'admin') q = q.eq('owner_user_id', ctx.user.id);

        const { data, error } = await q
            .select('id, engine, label, apify_username, status, monthly_credit_usd').maybeSingle();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Key not found.' });

        logger.info('key_limit_updated', { keyId: data.id, by: ctx.user.id, patch: Object.keys(patch) });
        res.json({ success: true, key: data });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/** Cycle credit for an engine primary key, which has no row in apify_keys. */
app.patch('/api/admin/engine-credit', async (req, res) => {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        const { engine, monthlyCreditUsd } = req.body;
        if (!ENGINES.includes(engine)) return res.status(400).json({ error: 'Unknown engine.' });
        const n = parseFloat(monthlyCreditUsd);
        if (!(n > 0) || n > 10000) return res.status(400).json({ error: 'Enter a credit limit between 0 and 10000.' });

        await supabase.from('system_settings').upsert({
            key: primaryKeyName(engine) + '_credit_usd',
            value: String(n),
            updated_at: new Date().toISOString()
        }, { onConflict: 'key' });

        _primaryCreditCache.clear();
        res.json({ success: true, engine, monthlyCreditUsd: n });
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

// ===========================================================================
// TRIAL AND PLAN LIMITS (phase 21)
//
// These three settings decide what a trial gets, what a paying client gets,
// and how long a trial lasts. The server has read them from system_settings
// since phase 13 and enforced them on every run — and there has never been a
// way to change them except by writing SQL against production.
//
// That is the same fault as the engine checkboxes: a capability the server
// enforces that no human can reach. It is worse here, because the person who
// most needs to change a trial cap is the person least likely to be holding a
// psql prompt.
// ===========================================================================

/** The metrics a cap can be set on. Anything else is ignored rather than stored. */
const QUOTA_METRICS = [
    { key: 'ig_report',      label: 'Instagram reports',   kind: 'count' },
    { key: 'fb_group_audit', label: 'Group audits',        kind: 'count' },
    { key: 'leads',          label: 'Leads',               kind: 'count' },
    { key: 'usd',            label: 'Apify spend ceiling', kind: 'usd'   }
];

app.get('/api/admin/settings', async (req, res) => {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        const keys = ['trial_days', 'trial_caps', 'client_monthly_caps'];
        const { data } = await supabase.from('system_settings').select('key, value').in('key', keys);
        const raw = Object.fromEntries((data || []).map(r => [r.key, r.value]));

        const parse = (v, fallback) => {
            try { const p = v ? JSON.parse(v) : null; return (p && typeof p === 'object') ? p : fallback; }
            catch { return fallback; }
        };
        const days = parseInt(raw.trial_days ?? '', 10);

        res.json({
            trialDays: Number.isFinite(days) && days > 0 && days <= 365 ? days : 7,
            trialCaps: parse(raw.trial_caps, QUOTA_FALLBACK.trial),
            clientMonthlyCaps: parse(raw.client_monthly_caps, QUOTA_FALLBACK.paid),
            metrics: QUOTA_METRICS,
            fallbacks: QUOTA_FALLBACK,
            // Says out loud when a value is the built-in fallback rather than
            // something anyone chose, so an unset limit does not look decided.
            stored: { trial_days: raw.trial_days != null, trial_caps: raw.trial_caps != null, client_monthly_caps: raw.client_monthly_caps != null }
        });
    } catch (err) { sendErr(res, err); }
});

app.patch('/api/admin/settings', async (req, res) => {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;

        const cleanCaps = obj => {
            if (!obj || typeof obj !== 'object') return null;
            const out = {};
            for (const m of QUOTA_METRICS) {
                const v = obj[m.key];
                if (v === null || v === '') { out[m.key] = null; continue; }   // null = unlimited
                const n = Number(v);
                if (!Number.isFinite(n) || n < 0) continue;                    // junk is dropped, not stored
                out[m.key] = m.kind === 'usd' ? Math.round(n * 100) / 100 : Math.floor(n);
            }
            return Object.keys(out).length ? out : null;
        };

        const writes = [];
        if (req.body.trialDays !== undefined) {
            const d = parseInt(req.body.trialDays, 10);
            if (!Number.isFinite(d) || d < 1 || d > 365) {
                return res.status(400).json({ error: 'Trial length must be between 1 and 365 days.' });
            }
            writes.push({ key: 'trial_days', value: String(d) });
        }
        for (const [field, key] of [['trialCaps', 'trial_caps'], ['clientMonthlyCaps', 'client_monthly_caps']]) {
            if (req.body[field] === undefined) continue;
            const caps = cleanCaps(req.body[field]);
            if (!caps) return res.status(400).json({ error: `No usable values for ${key}.` });
            writes.push({ key, value: JSON.stringify(caps) });
        }
        if (!writes.length) return res.status(400).json({ error: 'Nothing to change.' });

        const now = new Date().toISOString();
        const { error } = await supabase.from('system_settings')
            .upsert(writes.map(w => ({ ...w, updated_at: now })), { onConflict: 'key' });
        if (error) throw error;

        // Caps are cached per process for the auth window. Without this an
        // admin raises a limit, watches nothing change, and raises it again.
        invalidateQuotaCaps();
        logger.info('admin_settings_changed', { userId: ctx.user.id, keys: writes.map(w => w.key) });
        res.json({ success: true, changed: writes.map(w => w.key) });
    } catch (err) { sendErr(res, err); }
});

app.get('/api/admin/users', async (req, res) => {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        const { data: users } = await supabase.from('app_users')
            .select('*').order('created_at', { ascending: false });
        const { data: access } = await supabase.from('user_engine_access').select('user_id, engine');

        const map = {};
        (access || []).forEach(a => { (map[a.user_id] = map[a.user_id] || []).push(a.engine); });

        // state is computed rather than stored, so the admin list can never
        // disagree with what the gate will actually do to that account.
        res.json({
            users: (users || []).map(u => ({
                ...u,
                engines: map[u.id] || [],
                state: accountState(u),
                expires_at: u.paid_until || u.trial_ends_at || null
            })),
            // The grantable engines, sent rather than hardcoded in the page.
            //
            // They WERE hardcoded, and drifted: the admin panel offered four
            // checkboxes while the server had six, so meta_owned and
            // content_plan could not be granted to anyone at all. An admin
            // ticking every box they could see still produced an employee who
            // was refused by requireEngine, with nothing on either screen
            // explaining why. Two lists that must agree, maintained by hand,
            // will always end up like that — so now there is one list.
            allEngines: ENGINES.map(e => ({ key: e, label: ENGINE_LABELS[e] || e }))
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/users', async (req, res) => {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        const { email, password, fullName, role, engines, byoKeyOnly } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

        const { data: created, error: createErr } = await supabase.auth.admin.createUser({
            email, password, email_confirm: true
        });
        if (createErr) throw createErr;

        const newId = created.user.id;
        const newRole = ['admin', 'user', 'client'].includes(role) ? role : 'user';
        const row = {
            id: newId,
            email: email.toLowerCase(),
            full_name: fullName || null,
            role: newRole,
            is_active: true,
            byo_key_only: byoKeyOnly === true
        };

        // An admin can hand out a trial directly — useful for a client who was
        // sold in a meeting rather than through the signup page.
        if (newRole === 'client') {
            const days  = Number.isFinite(parseInt(req.body.trialDays, 10))
                ? parseInt(req.body.trialDays, 10)
                : await trialDaysSetting();
            const start = new Date();
            row.trial_started_at = start.toISOString();
            row.trial_ends_at    = new Date(start.getTime() + days * 86400000).toISOString();
        }

        await supabase.from('app_users').upsert(row);

        for (const e of (engines || []).filter(x => ENGINES.includes(x))) {
            await supabase.from('user_engine_access')
                .upsert({ user_id: newId, engine: e, granted_by: ctx.user.id }, { onConflict: 'user_id,engine' });
        }

        res.json({ success: true, userId: newId });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

// Admin writes below invalidate the auth/engine caches for the affected user,
// so a disabled account or a revoked grant takes effect immediately rather
// than at the end of the cache TTL.
app.patch('/api/admin/users/:id', async (req, res) => {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        _roleCache.delete(String(req.params.id));   // a demoted admin must lose clientAccess now, not in a minute
        // The auth cache holds the old profile for a minute. Without this, a
        // client activated just now keeps seeing "your access has ended" —
        // with a Reload button that changes nothing — until the cache turns.
        for (const [k, v] of _authCache) if (v.ctx?.user?.id === String(req.params.id)) _authCache.delete(k);
        const {
            role, isActive, engines, password, byoKeyOnly,
            paidUntil, planLabel, trialDays
        } = req.body;
        const target = req.params.id;

        const patch = { updated_at: new Date().toISOString() };

        // Was `role === 'admin' ? 'admin' : 'user'`, which quietly promoted a
        // client to employee whenever an admin patched anything else on the
        // same request. Roles are now named explicitly.
        if (role) {
            patch.role = ['admin', 'user', 'client'].includes(role) ? role : 'user';
        }
        if (typeof isActive === 'boolean') patch.is_active = isActive;
        if (typeof byoKeyOnly === 'boolean') { patch.byo_key_only = byoKeyOnly; _byoCache.delete(target); }

        // Manual activation. paid_until is the whole of billing: an admin sets
        // a date, money is collected out of band, and access ends by itself.
        // Passing null revokes without deleting anything.
        if (paidUntil !== undefined) {
            const when = paidUntil ? new Date(paidUntil) : null;
            if (when && isNaN(when.getTime())) {
                return res.status(400).json({ error: 'paidUntil is not a valid date.' });
            }
            patch.paid_until   = when ? when.toISOString() : null;
            // Activating answers the request. Revoking does not re-raise it.
            if (when) { patch.activation_requested_at = null; patch.activation_note = null; }
            patch.activated_by = ctx.user.id;
            patch.activated_at = new Date().toISOString();
        }
        if (planLabel !== undefined) patch.plan_label = planLabel || null;

        // Extending a trial is a separate lever from selling one: it moves the
        // trial window without implying the account ever paid.
        if (trialDays !== undefined) {
            const d = parseInt(trialDays, 10);
            if (!Number.isFinite(d) || d < 0 || d > 365) {
                return res.status(400).json({ error: 'trialDays must be between 0 and 365.' });
            }
            const start = new Date();
            patch.trial_started_at = start.toISOString();
            patch.trial_ends_at    = new Date(start.getTime() + d * 86400000).toISOString();
        }

        await supabase.from('app_users').update(patch).eq('id', target);

        if (password) await supabase.auth.admin.updateUserById(target, { password });

        if (Array.isArray(engines)) {
            await supabase.from('user_engine_access').delete().eq('user_id', target);
            for (const e of engines.filter(x => ENGINES.includes(x))) {
                await supabase.from('user_engine_access')
                    .upsert({ user_id: target, engine: e, granted_by: ctx.user.id }, { onConflict: 'user_id,engine' });
            }
        }
        invalidateAuth(target);
        invalidateEngineAccess(target);
        res.json({ success: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/admin/users/:id', async (req, res) => {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        if (req.params.id === ctx.user.id) return res.status(400).json({ error: 'You cannot delete yourself.' });
        await supabase.auth.admin.deleteUser(req.params.id);
        await supabase.from('app_users').delete().eq('id', req.params.id);
        invalidateAuth(req.params.id);
        invalidateEngineAccess(req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

// ===========================================================================
// STAGE 1 :: DISCOVERY PIPELINE  (checkpointed job)
//
// This ran Apify inside the HTTP request until phase 6. A long run hit the
// proxy timeout while the actor kept billing, and the user got a network error
// with no job, no checkpoint and no cancel. Worse, none of its actor calls
// carried a cost estimate, so callActor() skipped the budget gate, took no
// reservation and could never raise NO_CREDIT — the leadgen engine was the
// only engine that could overspend a key silently.
//
// Each Apify call is now one billable unit, checkpointed with the rows it
// returned. A resumed run replays those rows instead of paying to scrape them
// again — the contract every other engine already had.
// ===========================================================================

/** Map place-search rows to explore/locations URLs. Every id/url key the
 *  search actor has been seen to emit is accepted; nothing is invented. */
function igPlaceUrls(items) {
    const out = [];
    (items || []).forEach(it => {
        if (!it) return;
        const cands = [it, it.location, it.place].filter(Boolean);
        for (const c of cands) {
            const url = String(c.url || c.locationUrl || c.link || '');
            if (/instagram\.com\/explore\/locations\//i.test(url)) { out.push(url.split('?')[0]); return; }
            const id = c.locationId || c.id || c.pk || c.location_id;
            if (id && /^\d{3,}$/.test(String(id))) { out.push(`https://www.instagram.com/explore/locations/${id}/`); return; }
        }
    });
    return [...new Set(out)];
}

function leadgenUnits(input) {
    const {
        location = '', hashtags = [], method3_1_keywords = [],
        competitor_handles = [], method6_keywords = [], selected_methods = []
    } = input || {};

    const units = [];
    if (selected_methods.includes('method_1')   && location)                 units.push({ id: 'm1', kind: 'locations' });
    if (selected_methods.includes('method_3')   && hashtags.length)          units.push({ id: 'm3', kind: 'hashtags' });
    if (selected_methods.includes('method_3_1'))
        method3_1_keywords.forEach(kw => units.push({ id: 'm3_1:' + kw, kind: 'phrase', kw }));
    if (selected_methods.includes('method_4')   && competitor_handles.length) units.push({ id: 'm4', kind: 'tagged' });
    if (selected_methods.includes('method_6'))
        method6_keywords.forEach(kw => units.push({ id: 'm6:' + kw, kind: 'accounts', kw }));
    return units;
}

registerWorker('leadgen_campaign', (userId, input, jobId) => async (progress, ck) => {
    const {
        campaignId, location = '', method1_keywords = [], hashtags = [],
        competitor_handles = [], method6_keywords = []
    } = input;

    const warnings = [];
    const units = leadgenUnits(input);
    if (!units.length) {
        throw new Error('No discovery method selected, or the selected methods have no inputs.');
    }

    // Shape one raw Apify item into the row the save phase writes.
    const shape = (i) => {
        const handle = i.ownerUsername || i.owner?.username || i.username || i.user?.username;
        if (!handle) return null;
        return {
            username: String(handle).toLowerCase().trim().replace('@', ''),
            post_views: getViews(i),
            post_likes: i.likesCount || 0,
            post_comments: i.commentsCount || 0,
            post_timestamp: tsOf(i)?.toISOString() || new Date().toISOString(),
            post_url: i.url || `https://instagram.com/p/${shortcodeOf(i)}`
        };
    };

    const collect = (items, filterKeywords) => {
        const lower = (filterKeywords || []).map(k => String(k).toLowerCase().trim()).filter(Boolean);
        const out = [];
        (items || []).forEach(i => {
            const caption = String(i.caption || i.text || '').toLowerCase();
            if (lower.length && !lower.some(kw => caption.includes(kw))) return;
            const row = shape(i);
            if (row) out.push(row);
        });
        return out;
    };

    const discovered = [];

    for (let i = 0; i < units.length; i++) {
        const u = units[i];
        const pct = 5 + Math.floor(65 * i / units.length);

        // Already paid for on an earlier attempt. Replay, do not re-scrape.
        if (ck.isDone(u.id)) {
            discovered.push(...(ck.get(u.id) || []));
            await progress(pct, `Reusing ${u.id} from the earlier attempt — not re-scraped`);
            continue;
        }

        await progress(pct, `${u.id} (${i + 1} of ${units.length})`);

        // Budget gate per unit. A key that cannot cover ONE unit raises
        // NO_CREDIT, which runJob turns into paused_no_credit with the
        // checkpoint intact — rather than the old behaviour of scraping anyway.
        const { client } = await getWorkingClient('leadgen', userId, {
            needUsd: LEADGEN_UNIT_USD, jobId
        });

        let rows = [];
        try {
            if (u.kind === 'locations') {
                // PHASE 11 — a pasted explore URL still works; a plain place name
                // ("Rangpur", "Gulshan Dhaka") is resolved through the search
                // scraper's place search first. Field names on the search
                // output are read defensively: the actor is verified for
                // searchType 'user' (Method 6) but its place rows have not been
                // checked against live output, so every plausible id/url key
                // is accepted and a miss is reported, not guessed.
                const terms = String(location).split(',').map(c => c.trim()).filter(Boolean);
                const directUrls = terms.filter(loc => loc.includes('instagram.com/explore/locations'));
                const names = terms.filter(loc => !/instagram\.com/i.test(loc));
                if (names.length) {
                    const { items: places } = await callActor(client, 'apify/instagram-search-scraper',
                        { searchQueries: names.slice(0, 3), searchType: 'place' },
                        { estimateUsd: COST_PER_1K_PROFILE / 20, maxItems: 30, jobId });
                    const found = igPlaceUrls(places);
                    if (found.length) {
                        directUrls.push(...found.slice(0, 3 * names.length));
                        warnings.push(`Method 1: "${names.join('", "')}" resolved to ${found.length} location page(s).`);
                    } else {
                        warnings.push(`Method 1: no Instagram location matched "${names.join('", "')}" — paste an explore/locations URL instead.`);
                    }
                }
                if (!directUrls.length) {
                    warnings.push('METHOD 1 SKIPPED: no location could be resolved.');
                } else {
                    const items = await runActor('apify/instagram-scraper',
                        { directUrls: [...new Set(directUrls)], resultsLimit: LEADGEN_RESULTS_LIMIT, scrollWaitSecs: 5, pageTimeoutSecs: 60 },
                        warnings, 'Method 1 (Locations)', client, { jobId });
                    rows = collect(items, method1_keywords);
                }

            } else if (u.kind === 'hashtags') {
                const directUrls = hashtags.map(h => String(h).replace('#', '').trim()).filter(Boolean)
                    .map(tag => `https://www.instagram.com/explore/tags/${tag}/`);
                const items = await runActor('apify/instagram-scraper',
                    { directUrls, resultsLimit: LEADGEN_RESULTS_LIMIT, scrollWaitSecs: 5, pageTimeoutSecs: 60 },
                    warnings, 'Method 3 (Hashtags)', client, { jobId });
                rows = collect(items);

            } else if (u.kind === 'phrase') {
                const items = await runActor('apify/instagram-api-scraper',
                    { query: u.kw, limit: LEADGEN_RESULTS_LIMIT },
                    warnings, `Method 3.1 (${u.kw})`, client, { jobId });
                rows = collect(items);

            } else if (u.kind === 'tagged') {
                const taggedUrls = competitor_handles.map(h => String(h).replace('@', '').trim()).filter(Boolean)
                    .map(handle => `https://www.instagram.com/${handle}/tagged/`);
                const items = await runActor('apify/instagram-scraper',
                    { directUrls: taggedUrls, resultsLimit: LEADGEN_RESULTS_LIMIT, scrollWaitSecs: 5, pageTimeoutSecs: 60 },
                    warnings, 'Method 4 (Competitor Tagged)', client, { jobId });
                rows = collect(items);

            } else if (u.kind === 'accounts') {
                const { items } = await callActor(client, 'apify/instagram-search-scraper',
                    { searchQueries: [u.kw], searchType: 'user' },
                    { estimateUsd: COST_PER_1K_PROFILE / 20, maxItems: 50, jobId });
                rows = (items || []).map(it => {
                    const handle = it.username || it.ownerUsername;
                    if (!handle) return null;
                    return {
                        username: String(handle).toLowerCase().trim().replace('@', ''),
                        post_views: 0, post_likes: 0, post_comments: 0,
                        post_timestamp: new Date().toISOString(),
                        post_url: `https://instagram.com/${handle}`
                    };
                }).filter(Boolean);
                warnings.push(`X-RAY (Method 6): ${rows.length} accounts for "${u.kw}".`);
            }
        } catch (e) {
            // NO_CREDIT and CANCELLED must reach runJob to park the job with
            // its checkpoint. Anything else is one method failing, which is not
            // a reason to throw away the four that worked.
            if (e.code === 'NO_CREDIT' || e.code === 'CANCELLED') throw e;
            warnings.push(`Error (${u.id}): ${e.message}`);
            logger.warn('leadgen_unit_failed', { jobId, unit: u.id, message: e.message });
        }

        discovered.push(...rows);
        await ck.done(u.id, rows);
    }

    // --- save -------------------------------------------------------------
    // Batched. The old loop ran a SELECT and an INSERT per handle — roughly
    // 2000 sequential round trips on a 1000-lead campaign, which was a large
    // part of why this endpoint timed out before Apify was even the problem.
    await progress(75, 'Saving leads');

    const uniqueMap = new Map();
    discovered.forEach(p => {
        if (!p?.username) return;
        // Normalised here, at the one place every discovered handle passes
        // through. Instagram treats handles case-insensitively but the actors
        // do not always agree on case, and since phase 16 the handle is part
        // of a unique key — so "HarborCafe" and "harborcafe" arriving from two
        // methods must not become two leads.
        const key = String(p.username).trim().toLowerCase();
        if (!key) return;
        p.username = key;
        const cur = uniqueMap.get(key);
        if (!cur || (p.post_views || 0) > (cur.post_views || 0)) uniqueMap.set(key, p);
    });
    const posts = Array.from(uniqueMap.values());

    if (!posts.length) {
        await supabase.from('campaigns')
            .update({ total_leads_found: 0 }).eq('id', campaignId).eq('user_id', userId);
        return { campaignId, newUniqueLeads: 0, totalLinked: 0, methodsRun: units.length, warnings };
    }

    const idByUsername = new Map();
    const CHUNK = 200;

    for (let i = 0; i < posts.length; i += CHUNK) {
        const names = posts.slice(i, i + CHUNK).map(p => p.username);
        const { data: existing } = await supabase.from('leads')
            .select('id, username')
            .eq('owner_user_id', userId).eq('platform', 'instagram')
            .in('username', names);
        (existing || []).forEach(l => idByUsername.set(l.username, l.id));
    }

    let missing = posts.filter(p => !idByUsername.has(p.username));

    // The allowance is taken here, before the writes, so two campaigns running
    // together cannot both see room and both use it. Anything not saved is
    // still linked below if the lead already existed — only new rows count.
    const allowedNew = await takeLeadQuota(userId, missing.length);
    if (allowedNew < missing.length) {
        warnings.push(allowedNew === 0
            ? `Lead allowance reached. ${missing.length} new lead(s) were found but not saved.`
            : `Lead allowance reached. Saved ${allowedNew} of ${missing.length} new lead(s) found.`);
        missing = missing.slice(0, allowedNew);
    }

    for (let i = 0; i < missing.length; i += CHUNK) {
        const batch = missing.slice(i, i + CHUNK).map(p => ({
            owner_user_id: userId,
            platform: 'instagram',          // explicit: it is part of the conflict key
            username: p.username,
            profile_url: `https://instagram.com/${p.username}`,
            is_enriched: false
        }));
        // Upsert since phase 16, which added the unique key this conflicts on.
        // The select-then-insert above races: two campaigns both read before
        // either writes, and before that key existed both rows landed.
        const { data: created, error: insErr } = await supabase.from('leads')
            .upsert(batch, { onConflict: 'owner_user_id,platform,username', ignoreDuplicates: false })
            .select('id, username');
        if (insErr) {
            warnings.push(`DB: ${batch.length} lead(s) in one batch failed to save — ${insErr.message}`);
            logger.error('leadgen_lead_insert_failed', { jobId, message: insErr.message });
            // The allowance was taken for these rows before the write. They did
            // not land, so it goes back.
            await refundLeadQuota(userId, batch.length);
            continue;
        }
        (created || []).forEach(l => idByUsername.set(l.username, l.id));
        await progress(
            75 + Math.floor(15 * Math.min(i + CHUNK, missing.length) / Math.max(1, missing.length)),
            `Saved ${Math.min(i + CHUNK, missing.length)} of ${missing.length} new leads`);
    }

    const links = posts
        .filter(p => idByUsername.has(p.username))
        .map(p => ({
            campaign_id: campaignId,
            lead_id: idByUsername.get(p.username),
            user_id: userId,
            top_post_url: p.post_url,
            top_post_views: p.post_views || 0,
            post_likes: p.post_likes || 0,
            post_comments: p.post_comments || 0,
            post_timestamp: new Date(p.post_timestamp).toISOString()
        }));

    let linked = 0;
    for (let i = 0; i < links.length; i += CHUNK) {
        const slice = links.slice(i, i + CHUNK);
        // Upsert, not insert. A resumed run replays this whole phase, and
        // without the phase 6 unique index that duplicated every lead in the
        // Vault and inflated total_leads_found.
        const { error: linkErr } = await supabase.from('campaign_leads')
            .upsert(slice, { onConflict: 'campaign_id,lead_id', ignoreDuplicates: false });
        if (linkErr) {
            warnings.push(`DB: a batch of campaign links failed — ${linkErr.message}`);
            logger.error('leadgen_link_failed', { jobId, message: linkErr.message });
        } else {
            linked += slice.length;
        }
    }

    await progress(95, `Linked ${linked} lead(s) to the campaign`);

    // The campaign knows which client it was filed under; the leads should
    // too, or "for this client, these are the leads" cannot be answered.
    {
        const { data: cmp } = await supabase.from('campaigns').select('client_id').eq('id', campaignId).maybeSingle();
        if (cmp?.client_id) await linkLeadsToClient(cmp.client_id, [...idByUsername.values()], 'ig_campaign', jobId);
    }

    await supabase.from('campaigns')
        .update({ total_leads_found: linked }).eq('id', campaignId).eq('user_id', userId);

    return {
        campaignId,
        newUniqueLeads: missing.length,   // genuinely new leads
        totalLinked: linked,              // rows on this campaign, new or not
        methodsRun: units.length,
        warnings
    };
});

app.post('/api/run-campaign', spendLimit, async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;
        await assertJobSlot(ctx.user.id);

        const {
            campaignName, location, method1_keywords = [], hashtags = [],
            method3_1_keywords = [], competitor_handles = [], method6_keywords = [],
            selected_methods = []
        } = req.body;

        const input = {
            location: location || '',
            method1_keywords, hashtags, method3_1_keywords,
            competitor_handles, method6_keywords, selected_methods
        };

        const units = leadgenUnits(input);
        if (!units.length) {
            return res.status(400).json({
                error: 'Select at least one discovery method and give it something to work with.'
            });
        }

        // The campaign row is created here, not in the worker, so its id is
        // stable across a resume and the worker stays rebuildable from
        // jobs.input alone.
        const { data: newCmp, error: cmpErr } = await supabase.from('campaigns').insert([{
            user_id: ctx.user.id,
            client_id: await resolveClientId(req, ctx),
            name: campaignName || 'Discovery Campaign',
            location: location || null,
            keywords: [...method1_keywords, ...method3_1_keywords],
            selected_methods
        }]).select('id').single();
        if (cmpErr) throw cmpErr;

        const estimate = +(units.length * LEADGEN_UNIT_USD).toFixed(4);

        const job = await createJob(ctx.user.id, 'leadgen_campaign', 'leadgen',
            { clientId: await resolveClientId(req, ctx), ...input, campaignId: newCmp.id }, estimate);

        runJob(job.id, JOB_WORKERS['leadgen_campaign'](ctx.user.id, job.input, job.id));

        res.status(202).json({
            success: true,
            jobId: job.id,
            campaignId: newCmp.id,
            methods: units.length,
            estimatedUsd: estimate,
            budget: await budgetSnapshot('leadgen', ctx.user.id, LEADGEN_UNIT_USD)
        });
    } catch (err) { sendErr(res, err); }
});

// ===========================================================================
// STAGE 2 :: ENRICHMENT  (checkpointed job)
// ===========================================================================

registerWorker('leadgen_enrich', (userId, input, jobId) => async (progress, ck) => {
    const { campaignId, batchSize } = input;
    const size = Math.min(parseInt(batchSize || 25, 10), 100);

    await progress(5, 'Finding leads that still need enriching');

    const { data: linkData, error: linkErr } = await supabase.from('campaign_leads')
        .select('leads(id, username, is_enriched)')
        .eq('campaign_id', campaignId)
        .eq('user_id', userId);
    if (linkErr) throw linkErr;

    const handles = (linkData || []).map(d => d.leads)
        .filter(l => l && l.is_enriched !== true)
        .map(l => l.username)
        .slice(0, size);

    if (!handles.length) {
        return { campaignId, enrichedCount: 0, requested: 0,
                 message: 'All leads on this campaign are already enriched.' };
    }

    // One unit per batch of 25, so a run that pauses for credit resumes at the
    // batch boundary instead of re-scraping profiles already paid for.
    const BATCH = 25;
    const batches = [];
    for (let i = 0; i < handles.length; i += BATCH) batches.push(handles.slice(i, i + BATCH));

    let updated = 0;

    for (let b = 0; b < batches.length; b++) {
        const names = batches[b];
        const unit = 'enrich:' + names[0] + ':' + names.length;
        const pct = 10 + Math.floor(80 * b / batches.length);

        if (ck.isDone(unit)) {
            updated += Number(ck.get(unit) || 0);
            await progress(pct, `Batch ${b + 1} already done — not re-scraped`);
            continue;
        }

        const estimate = +((names.length / 1000) * COST_PER_1K_PROFILE).toFixed(6);
        await progress(pct, `Enriching ${names.length} profile(s), batch ${b + 1} of ${batches.length}`);

        const { client } = await getWorkingClient('leadgen', userId, { needUsd: estimate, jobId });

        const { items: profiles } = await callActor(client, 'apify/instagram-profile-scraper',
            { usernames: names },
            { waitSecs: 25, estimateUsd: estimate, maxItems: names.length, jobId });

        let batchUpdated = 0;
        for (const p of (profiles || [])) {
            const username = String(p.username || p.ownerUsername || '').toLowerCase().trim();
            if (!username) continue;

            const contacts = extractBioContacts(p);
            const { error: updErr } = await supabase.from('leads').update({
                full_name: p.fullName || p.full_name || p.name || null,
                email: contacts.email || p.inputEmail || null,
                phone: contacts.phone || p.phoneNumber || null,
                whatsapp: contacts.whatsapp,
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
            // Scoped to instagram since phase 16: a Facebook page can share a
            // handle with an Instagram account, and enrichment from the IG
            // profile scraper must not overwrite the Facebook lead.
            }).eq('username', username).eq('owner_user_id', userId).eq('platform', 'instagram');

            if (!updErr) batchUpdated++;
        }

        updated += batchUpdated;
        await ck.done(unit, batchUpdated);
    }

    return { campaignId, enrichedCount: updated, requested: handles.length };
});

app.post('/api/enrich-campaign', spendLimit, async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;
        await assertJobSlot(ctx.user.id);

        const { campaignId, batchSize } = req.body;
        if (!campaignId) return res.status(400).json({ error: 'Campaign ID required' });

        // Confirm the campaign is the caller's before spending anything on it.
        // The old handler queried campaign_leads by campaign_id alone, so a
        // caller could spend their own credit scraping another tenant's handles.
        const { data: cmp } = await supabase.from('campaigns')
            .select('id').eq('id', campaignId).eq('user_id', ctx.user.id).maybeSingle();
        if (!cmp) return res.status(404).json({ error: 'Campaign not found.' });

        const size = Math.min(parseInt(batchSize || 25, 10), 100);
        const estimate = +((size / 1000) * COST_PER_1K_PROFILE).toFixed(4);

        const job = await createJob(ctx.user.id, 'leadgen_enrich', 'leadgen',
            { clientId: await resolveClientId(req, ctx), campaignId, batchSize: size }, estimate);

        runJob(job.id, JOB_WORKERS['leadgen_enrich'](ctx.user.id, job.input, job.id));

        res.status(202).json({
            success: true, jobId: job.id, campaignId,
            batchSize: size, estimatedUsd: estimate
        });
    } catch (err) { sendErr(res, err); }
});

// ===========================================================================
// VAULT / HISTORY
// ===========================================================================

app.get('/api/client-history', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;
        // Paged, and the lead columns are named rather than leads(*). The old
        // query shipped every bio the account had ever enriched just to draw a
        // list of campaign names, and grew without bound for the life of the
        // user.
        const limit  = Math.min(parseInt(req.query.limit  || '20', 10), 50);
        const offset = Math.max(parseInt(req.query.offset || '0',  10), 0);

        const { count } = await supabase.from('campaigns')
            .select('id', { count: 'exact', head: true }).eq('user_id', ctx.user.id);

        const { data: campaigns } = await supabase.from('campaigns')
            .select('*, campaign_leads(top_post_views, post_likes, post_comments, post_timestamp, top_post_url, ' +
                    'leads(id, username, full_name, email, phone, followers_count, following_count, posts_count, ' +
                    'bio, website, category, is_business, is_verified, city, address, is_enriched, profile_url))')
            .eq('user_id', ctx.user.id)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        res.status(200).json({
            campaigns,
            paging: { limit, offset, total: count || 0, hasMore: offset + limit < (count || 0) }
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/search-leads', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;
        // PostgREST parses .or() as a DSL: commas separate terms, dots separate
        // column.operator.value. Anything from the user that survives into that
        // string is filter injection — bounded by the owner_user_id AND, but
        // still able to break or redefine the query.
        const query = String(req.query.q || '')
            .toLowerCase().trim()
            .replace(/[@,().\\%*]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 80);
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

// ===========================================================================
// THE MASTER LEAD LIST (phase 20)
//
// Every lead this account has ever collected, across every campaign, every
// client and both platforms — browsable rather than searchable.
//
// /api/search-leads needs a search term and returns 50 rows, which is right
// for "find that florist" and useless for "what have we actually got". This is
// the second question: how many, from where, how many reachable, and give me
// the slice that matches.
//
// SCOPE: owner_user_id only. The list is per-account and is not shared or
// pooled across accounts. Packaging any of it for sale is deliberately NOT
// built here and is not something this endpoint enables — it returns an
// operator their own rows.
// ===========================================================================

/**
 * One CSV cell.
 *
 * Two separate jobs, and skipping either produces a broken file:
 *
 * 1. CSV quoting, for values containing a comma, a quote or a newline. Scraped
 *    bios contain all three routinely.
 * 2. Formula neutralisation. A value starting '=', '+', '-' or '@' is executed
 *    as a formula by Excel, Sheets and LibreOffice on open — so a scraped bio
 *    reading `=HYPERLINK(...)` becomes a live link in the operator's
 *    spreadsheet, and `=cmd|...` is worse. A leading apostrophe makes the cell
 *    literal text, which is what it always was.
 *
 * Every field written here came from a scrape, so none of it is trusted.
 */
function csvCell(v) {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/**
 * Record that these leads were found for this client. (phase 23)
 *
 * Idempotent: a resumed run replays its save phase, and the link must not
 * turn into a duplicate or an error when it does. Never throws — a failed
 * link is a warning on the run, not a reason to lose the leads themselves.
 */
async function linkLeadsToClient(clientId, leadIds, source, jobId = null) {
    const ids = [...new Set((leadIds || []).filter(id => UUID_RE.test(String(id || ''))))];
    if (!clientId || !UUID_RE.test(String(clientId)) || !ids.length) return 0;
    let linked = 0;
    for (let i = 0; i < ids.length; i += 200) {
        const slice = ids.slice(i, i + 200).map(lead_id => ({ client_id: clientId, lead_id, source, job_id: jobId }));
        const { error } = await supabase.from('client_leads').upsert(slice, { onConflict: 'client_id,lead_id', ignoreDuplicates: true });
        if (error) { logger.warn('client_leads_link_failed', { clientId, source, message: error.message }); continue; }
        linked += slice.length;
    }
    return linked;
}

/**
 * The lead ids a client's view is made of, or null when the request is for
 * the caller's own master list. A client_only request the caller cannot
 * read is refused, not silently widened to their own leads.
 */
async function leadScope(req, ctx) {
    if (String(req.query.client_only || '') !== '1') return null;
    const cid = String(req.query.client_id || req.query.clientId || '');
    const c = await clientAccess(ctx.user.id, cid, 'viewer');
    if (!c) { const e = new Error('Client not found.'); e.statusCode = 404; throw e; }
    const { data } = await supabase.from('client_leads').select('lead_id').eq('client_id', c.id);
    return { client: c, ids: (data || []).map(r => r.lead_id) };
}

/**
 * One row per business in a client's view. Two employees finding the same
 * Page for one client produce two lead rows (the key is per owner); the
 * client is asking about the business, not about who found it. The richer
 * row wins — enriched over not, then the most recently seen.
 */
function dedupeLeads(rows) {
    const best = new Map();
    for (const r of (rows || [])) {
        const k = `${r.platform || 'instagram'}:${String(r.username || '').toLowerCase()}`;
        const cur = best.get(k);
        if (!cur) { best.set(k, r); continue; }
        const better = (!!r.is_enriched && !cur.is_enriched) ||
            (!!r.is_enriched === !!cur.is_enriched && String(r.created_at) > String(cur.created_at));
        if (better) best.set(k, r);
    }
    return [...best.values()];
}

/** Shared filter builder, so the CSV is always exactly what is on screen. */
function leadFilters(q, userId, scopeIds = null) {
    // The master list is the caller's own rows. A client's view is the rows
    // linked to that client, whoever found them.
    let s = supabase.from('leads').select('*', { count: 'exact' });
    s = scopeIds ? s.in('id', scopeIds) : s.eq('owner_user_id', userId);

    const platform = String(q.platform || '').toLowerCase();
    if (platform === 'instagram' || platform === 'facebook') s = s.eq('platform', platform);

    if (String(q.enriched || '') === '1') s = s.eq('is_enriched', true);
    if (String(q.business || '') === '1') s = s.eq('is_business', true);
    if (String(q.verified || '') === '1') s = s.eq('is_verified', true);

    // "Reachable" is the only count that matters for outreach, and it is not a
    // column — a lead is reachable if ANY channel is present.
    if (String(q.reachable || '') === '1') {
        s = s.or('email.not.is.null,phone.not.is.null,whatsapp.not.is.null');
    }
    if (String(q.has_email || '') === '1') s = s.not('email', 'is', null);

    const min = parseInt(q.min_followers, 10);
    const max = parseInt(q.max_followers, 10);
    if (Number.isFinite(min)) s = s.gte('followers_count', min);
    if (Number.isFinite(max)) s = s.lte('followers_count', max);

    // Same sanitising as /api/search-leads: anything reaching PostgREST's .or()
    // DSL is filter injection, bounded by the owner AND but still able to
    // redefine the query.
    const clean = v => String(v || '').toLowerCase().replace(/[@,().\\%*]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    const city = clean(q.city);
    if (city) s = s.ilike('city', `%${city}%`);
    const category = clean(q.category);
    if (category) s = s.ilike('category', `%${category}%`);
    const text = clean(q.q);
    if (text) s = s.or(`username.ilike.%${text}%,full_name.ilike.%${text}%,bio.ilike.%${text}%`);

    return s;
}

const LEAD_SORTS = {
    newest:    { col: 'created_at',      asc: false },
    oldest:    { col: 'created_at',      asc: true  },
    followers: { col: 'followers_count', asc: false },
    smallest:  { col: 'followers_count', asc: true  },
    username:  { col: 'username',        asc: true  }
};

app.get('/api/leads', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;

        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const sort = LEAD_SORTS[String(req.query.sort || 'newest')] || LEAD_SORTS.newest;

        const scope = await leadScope(req, ctx);
        if (scope) {
            // A client's list is de-duplicated across the people who found it,
            // and a page cannot be cut before the duplicates are gone — so the
            // whole view is read (capped) and paged here. Per-client sets are
            // hundreds, not hundreds of thousands.
            if (!scope.ids.length) return res.json({ leads: [], page: 1, limit, total: 0, pages: 1, client: { id: scope.client.id, name: scope.client.name } });
            const { data, error } = await leadFilters(req.query, ctx.user.id, scope.ids)
                .order(sort.col, { ascending: sort.asc, nullsFirst: false })
                .range(0, 4999);
            if (error) throw error;
            const rows = dedupeLeads(data);
            return res.json({
                leads: rows.slice((page - 1) * limit, page * limit),
                page, limit, total: rows.length,
                pages: Math.max(1, Math.ceil(rows.length / limit)),
                client: { id: scope.client.id, name: scope.client.name }
            });
        }

        const { data, error, count } = await leadFilters(req.query, ctx.user.id)
            .order(sort.col, { ascending: sort.asc, nullsFirst: false })
            .range((page - 1) * limit, page * limit - 1);
        if (error) throw error;

        res.json({
            leads: data || [],
            page, limit,
            total: count || 0,
            pages: Math.max(1, Math.ceil((count || 0) / limit))
        });
    } catch (err) { sendErr(res, err); }
});

/**
 * The shape of the whole list — what an operator needs before filtering it.
 *
 * Counted with head-only queries rather than by loading rows: the list is
 * meant to grow into six figures and a summary must not get slower as it does.
 */
app.get('/api/leads/summary', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;
        const U = ctx.user.id;

        const scope = await leadScope(req, ctx);
        if (scope) {
            // Counted over the de-duplicated view, so the tiles agree with the
            // list underneath them.
            const { data } = scope.ids.length
                ? await supabase.from('leads').select('*').in('id', scope.ids).range(0, 4999)
                : { data: [] };
            const rows = dedupeLeads(data);
            const has = f => rows.filter(r => r[f] != null && r[f] !== '').length;
            const tally = key => {
                const m = {};
                for (const r of rows) { const v = String(r[key] || '').trim(); if (v) m[v] = (m[v] || 0) + 1; }
                return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, n]) => ({ name, n }));
            };
            return res.json({
                total: rows.length,
                byPlatform: { instagram: rows.filter(r => r.platform !== 'facebook').length, facebook: rows.filter(r => r.platform === 'facebook').length },
                enriched: rows.filter(r => r.is_enriched).length,
                withEmail: has('email'), withPhone: has('phone'),
                reachable: rows.filter(r => r.email || r.phone || r.whatsapp).length,
                topCities: tally('city'), topCategories: tally('category'),
                sampledFrom: rows.length,
                client: { id: scope.client.id, name: scope.client.name },
                note: `Leads found for ${scope.client.name}, by anyone working on it, one row per business.`
            });
        }

        const countOf = fn => fn(supabase.from('leads').select('id', { count: 'exact', head: true }).eq('owner_user_id', U));

        const [all, ig, fb, enriched, withEmail, withPhone, reachable] = await Promise.all([
            countOf(q => q),
            countOf(q => q.eq('platform', 'instagram')),
            countOf(q => q.eq('platform', 'facebook')),
            countOf(q => q.eq('is_enriched', true)),
            countOf(q => q.not('email', 'is', null)),
            countOf(q => q.not('phone', 'is', null)),
            countOf(q => q.or('email.not.is.null,phone.not.is.null,whatsapp.not.is.null'))
        ]);

        // Top cities and categories, for the filter chips. Capped because this
        // is a shortcut to a filter, not an analysis.
        const { data: sample } = await supabase.from('leads')
            .select('city, category').eq('owner_user_id', U)
            .order('created_at', { ascending: false }).limit(2000);
        const tally = (rows, key) => {
            const m = {};
            for (const r of (rows || [])) {
                const v = String(r[key] || '').trim();
                if (v) m[v] = (m[v] || 0) + 1;
            }
            return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 10)
                .map(([name, n]) => ({ name, n }));
        };

        res.json({
            total: all.count || 0,
            byPlatform: { instagram: ig.count || 0, facebook: fb.count || 0 },
            enriched: enriched.count || 0,
            withEmail: withEmail.count || 0,
            withPhone: withPhone.count || 0,
            reachable: reachable.count || 0,
            topCities: tally(sample, 'city'),
            topCategories: tally(sample, 'category'),
            sampledFrom: (sample || []).length,
            note: 'Cities and categories are tallied from the 2,000 most recent leads.'
        });
    } catch (err) { sendErr(res, err); }
});

/** CSV of exactly what the filters select. Both spellings, as with demand-export. */
app.get(['/api/leads/export', '/api/leads/export.csv'], async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;
        const cap = Math.min(Math.max(parseInt(req.query.limit, 10) || 5000, 1), 20000);
        const sort = LEAD_SORTS[String(req.query.sort || 'newest')] || LEAD_SORTS.newest;

        const scope = await leadScope(req, ctx);
        let data;
        if (scope) {
            const r = scope.ids.length
                ? await leadFilters(req.query, ctx.user.id, scope.ids).order(sort.col, { ascending: sort.asc, nullsFirst: false }).range(0, 4999)
                : { data: [], error: null };
            if (r.error) throw r.error;
            data = dedupeLeads(r.data).slice(0, cap);
        } else {
            const r = await leadFilters(req.query, ctx.user.id)
                .order(sort.col, { ascending: sort.asc, nullsFirst: false })
                .range(0, cap - 1);
            if (r.error) throw r.error;
            data = r.data;
        }

        const cols = ['platform', 'username', 'full_name', 'email', 'phone', 'whatsapp', 'website',
            'followers_count', 'following_count', 'posts_count', 'engagement_rate',
            'category', 'city', 'address', 'is_business', 'is_verified', 'is_enriched',
            'profile_url', 'bio', 'created_at'];
        const csv = [cols.join(','), ...(data || []).map(r => cols.map(c => csvCell(r[c])).join(','))].join('\r\n');

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="edgelead-leads-${new Date().toISOString().slice(0, 10)}.csv"`);
        res.send('﻿' + csv);       // BOM, or Excel mangles non-ASCII names
    } catch (err) { sendErr(res, err); }
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
            { clientId: await resolveClientId(req, ctx), target: cleanTarget, rivals, postsPerAccount: limit }, estimate);

        runJob(job.id, JOB_WORKERS['ig_report'](ctx.user.id, job.input, job.id));

        res.status(202).json({
            success: true,
            jobId: job.id,
            accounts,
            postsPerAccount: limit,
            estimatedUsd: estimate
        });
    } catch (err) {
        sendErr(res, err);
    }
});

// ===========================================================================
// REPORT ENGINE :: DEEP AUDIT + COMPETITOR BENCHMARK (async job)
// ===========================================================================

app.get('/api/estimate-credits', async (req, res) => {
    const ctx = await auth(req, res); if (!ctx) return;
    const accounts = Math.min(parseInt(req.query.accounts || '1', 10), MAX_COMPETITORS + 1);
    const posts = Math.min(parseInt(req.query.posts || DEFAULT_POSTS_PER_ACC, 10), MAX_POSTS_PER_ACC);
    const estimatedUsd = estimateCredits(accounts, posts);
    res.json({
        accounts, postsPerAccount: posts,
        totalPosts: accounts * posts,
        estimatedUsd,
        budget: await budgetSnapshot('report', ctx.user.id, estimatedUsd),
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
                client_id: await resolveClientId(req, ctx),
                name: setName || `${cleanTarget} vs ${rivals.length} rivals`,
                target_handle: cleanTarget,
                competitor_handles: rivals,
                posts_per_account: limit
            }]).select('id').maybeSingle();
            activeSetId = set?.id || null;
        }

        const job = await createJob(ctx.user.id, 'deep_audit', 'report',
            { clientId: await resolveClientId(req, ctx), target: cleanTarget, competitors: rivals, postsPerAccount: limit, setId: activeSetId },
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
    } catch (err) { sendErr(res, err); }
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

        if (!RESUMABLE_STATUSES.includes(job.status)) {
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
        const totalUnits = jobUnitCount(job);
        const doneUnits  = (job.completed_units || []).length;
        const leftUnits  = Math.max(0, totalUnits - doneUnits);
        const perUnit    = Number(job.credits_estimate || 0) / totalUnits;
        try {
            await getWorkingClient(job.engine, ctx.user.id, { needUsd: perUnit, jobId: job.id });
        } catch (e) {
            return res.status(402).json({
                error: e.message,
                code: 'NO_CREDIT',
                completed: doneUnits,
                remainingUnits: leftUnits,
                remainingEstimateUsd: +(perUnit * leftUnits).toFixed(4)
            });
        }

        await assertJobSlot(ctx.user.id);

        // Claim here rather than inside runJob, which is fire-and-forget: a
        // second click would otherwise be answered 202 while quietly doing
        // nothing. The claim also clears any stale cancellation flag, which
        // would stop the job the instant it started.
        const claimed = await claimJob(job.id, RESUMABLE_STATUSES, { resume: true });
        if (!claimed) {
            return res.status(409).json({
                error: 'This job is already running. Nothing further was started.'
            });
        }

        runJob(job.id, factory(ctx.user.id, job.input, job.id), { resume: true, claimed: true });

        res.status(202).json({
            success: true,
            jobId: job.id,
            resumedFrom: doneUnits,
            remainingUnits: leftUnits,
            note: 'Already-completed units will be reused, not re-scraped.'
        });
    } catch (err) { sendErr(res, err); }
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
            const remaining = Math.max(0, c.creditUsd - spent);
            total += remaining;
            keys.push({
                source: c.source,
                label: c.source === 'user_pool' ? 'Your key'
                     : c.source === 'engine_primary' ? 'Shared primary'
                     : c.source === 'global_pool' ? 'Shared pool'
                     : 'Server fallback',
                creditUsd:   +Number(c.creditUsd).toFixed(2),
                spentUsd:    +spent.toFixed(4),
                remainingUsd:+remaining.toFixed(4)
            });
        }

        res.json({
            engine, cycleMonth: month,
            creditPerKeyUsd: APIFY_CYCLE_CREDIT,   // default only; see keys[].creditUsd
            keys,
            totalRemainingUsd: +total.toFixed(4),
            reserveUsd: BUDGET_RESERVE,
            mode: BUDGET_MODE
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * Job state.
 *
 * The fields are returned BOTH at the top level and under `job`. The older
 * pages read `.job`, the header helper reads the top level, and that mismatch
 * meant EL.pollJob spun forever on a job it could never see the status of.
 * Serving both shapes fixes it without a flag-day frontend deploy.
 */
app.get('/api/job/:id', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        // Explicit columns. `partials` holds the full computed audit for every
        // finished unit, and select('*') was shipping it — twice, because the
        // payload is doubled for the old and new frontend shapes — on every
        // poll of a running job. Nothing in any page reads it.
        const { data, error } = await supabase.from('jobs')
            .select('id, type, engine, status, progress, current_step, error, log, ' +
                    'result, result_report_id, credits_estimate, completed_units, ' +
                    'cancel_requested, created_at, updated_at, finished_at')
            .eq('id', req.params.id).eq('user_id', ctx.user.id).maybeSingle();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Job not found' });

        // Workers store the payload once, in reports.report_json, and leave a
        // reportRef behind. Hydrate it here so every existing page keeps
        // reading job.result.report exactly as before, without the payload
        // being written to Postgres twice and shipped on the final poll.
        if (data.status === 'done' && data.result?.reportRef && !data.result.report) {
            const { data: rep } = await supabase.from('reports')
                .select('report_json').eq('id', data.result.reportRef)
                .eq('user_id', ctx.user.id).maybeSingle();
            if (rep?.report_json) data.result = { ...data.result, report: rep.report_json };
        }

        const view = {
            ...data,
            completedUnits: (data.completed_units || []).length,
            // Only registered worker types can be rebuilt from jobs.input, so
            // only they can be resumed. Surfacing it means the recovery banner
            // never has to offer a button that answers 400.
            resumable: !!JOB_WORKERS[data.type] && RESUMABLE_STATUSES.includes(data.status)
        };
        res.json({ ...view, job: view });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * Ask a running job to stop at its next unit boundary.
 *
 * The Apify run currently in flight still bills, but every unit after it does
 * not — on a ten-group audit that is most of the cost. The checkpoint is left
 * intact, so a cancelled job's completed units are reused if it is run again.
 */
app.post('/api/job/:id/cancel', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const { data: job } = await supabase.from('jobs')
            .select('id, status, completed_units').eq('id', req.params.id)
            .eq('user_id', ctx.user.id).maybeSingle();
        if (!job) return res.status(404).json({ error: 'Job not found.' });

        if (['done', 'failed', 'cancelled'].includes(job.status)) {
            return res.status(409).json({ error: `This job is already ${job.status}.` });
        }

        if (job.status === 'queued' || job.status === 'paused_no_credit' || job.status === 'interrupted') {
            await updateJob(job.id, {
                status: 'cancelled', cancel_requested: false,
                error: 'Cancelled before it resumed. Nothing further was charged.',
                finished_at: new Date().toISOString()
            }, 'Cancelled by the user');
            return res.json({ success: true, stopped: 'immediately' });
        }

        await updateJob(job.id, { cancel_requested: true }, 'Cancellation requested');
        res.json({
            success: true,
            stopped: 'at the next step',
            note: 'The step already running will finish and be billed. Nothing after it will start.',
            completed: (job.completed_units || []).length
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/jobs', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const { data } = await supabase.from('jobs')
            .select('id, type, engine, status, progress, current_step, error, credits_estimate, created_at, finished_at, cancel_requested, completed_units')
            .eq('user_id', ctx.user.id)
            .order('created_at', { ascending: false })
            .limit(30);
        res.json({
            jobs: (data || []).map(j => ({
                ...j,
                completedUnits: (j.completed_units || []).length,
                resumable: !!JOB_WORKERS[j.type] && RESUMABLE_STATUSES.includes(j.status)
            }))
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===========================================================================
// REPORTS VAULT + TREND COMPARISON
// ===========================================================================

/**
 * The Instagram vault list.
 *
 * This was `select('*')` with no platform filter and no limit — the only vault
 * endpoint that never got the treatment /api/fb/reports did. Two things went
 * wrong. Facebook community and Page reports appeared in the Instagram list,
 * and opening one handed an incompatible payload to renderReportDashboard(),
 * which reads `rep.main` and rendered a blank card. And every full
 * report_json the user had ever generated crossed the wire to draw a list of
 * names and grades.
 *
 * Columns only. Platform filtered. Capped. The payload comes from
 * /api/report/:id on click.
 */
app.get('/api/reports-history', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'report'); if (!ctx) return;
        const limit = Math.min(parseInt(req.query.limit || '100', 10), 200);

        // The platform filter landed in phase 5; the report_type filter did not,
        // so the Audit vault listed Competitor Intel runs and vice versa. Both
        // pages hit this endpoint with no parameters, so both saw everything.
        // Opening a foreign row switched tabs and rendered below the fold,
        // which looked like being bounced to the wrong page.
        //
        // No parameter keeps the old behaviour, so nothing breaks if one page
        // is deployed before the other.
        const type = String(req.query.type || '').trim();

        let q = supabase.from('reports')
            .select('id, platform, report_type, target_handle, competitor_handles, grade, score, ' +
                    'score_version, score_v1, engagement_rate, posts_analyzed, snapshot_date, ' +
                    'created_at, ai_summary, ai_status, set_id, credits_estimate, client_id, user_id')
            .eq('platform', 'instagram');
        q = (await applyReportScope(req, ctx))(q);

        // Legacy rows (pre phase 7) wrote 'single'/'compare' for audits and
        // 'single'/'competitor' for cohorts. set_id is the reliable tell:
        // deep_audit always creates a competitor_set, ig_report never does.
        // The fallback keeps both vaults correct even if the backfill has not
        // run yet; after it runs, only the first term ever matches.
        if (type === 'ig_report') {
            q = q.or('report_type.eq.ig_report,report_type.eq.compare,and(report_type.eq.single,set_id.is.null)');
        } else if (type === 'deep_audit') {
            q = q.or('report_type.eq.deep_audit,report_type.eq.competitor,and(report_type.eq.single,set_id.not.is.null)');
        } else if (type) {
            q = q.eq('report_type', type);
        }

        const { data: reports, error } = await q
            .order('created_at', { ascending: false })
            .limit(limit);
        if (error) throw error;
        res.status(200).json({ reports: reports || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/report/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'report'); if (!ctx) return;
        const { data } = await supabase.from('reports')
            .select('*').eq('id', req.params.id).maybeSingle();
        if (!data || !(await canReadReport(ctx, data))) return res.status(404).json({ error: 'Report not found' });
        res.json({ report: data });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * Re-run the strategy layer against a report that is already in the vault.
 *
 * A run whose narrative failed used to be dead: ai_json was null forever, and
 * the only way to get the strategy layer was to pay Apify to scrape the same
 * accounts again. Everything the model needs is in report_json, so this costs
 * nothing but a Gemini call.
 */
app.post('/api/report/:id/regenerate-narrative', spendLimit, async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;

        const { data: rep } = await supabase.from('reports')
            .select('id, platform, report_type, report_json')
            .eq('id', req.params.id).eq('user_id', ctx.user.id).maybeSingle();
        if (!rep) return res.status(404).json({ error: 'Report not found' });

        const engine = rep.platform === 'instagram' ? 'report'
                     : rep.report_type === 'fb_page' ? 'fb_page'
                     : 'fb_community';
        if (ctx.profile.role !== 'admin') {
            const { data: grant } = await supabase.from('user_engine_access')
                .select('id').eq('user_id', ctx.user.id).eq('engine', engine).maybeSingle();
            if (!grant) return res.status(403).json({ error: `No access to the ${engine} engine.` });
        }

        const rj = rep.report_json || {};
        let out;
        if (rep.platform === 'instagram') {
            if (!rj.main) return res.status(409).json({ error: 'This report has no stored payload to regenerate from.' });
            out = await geminiNarrative({ target: rj.main, rivals: rj.rivals || [], benchmark: rj.benchmark || null });
        } else if (rep.report_type === 'fb_page') {
            if (!rj.target) return res.status(409).json({ error: 'This report has no stored payload to regenerate from.' });
            out = await fbPageNarrative({ target: rj.target, rival: rj.rival || null, benchmark: rj.benchmark || null, brief: rj.brief || null });
        } else if (rj.mode === 'combined') {
            out = await fbNarrative({ mode: 'combined', groups: rj.groups || [], benchmark: rj.benchmark || null });
        } else if (rj.group) {
            out = await fbNarrative({ mode: 'single', group: rj.group });
        } else {
            return res.status(409).json({ error: 'This report shape cannot be regenerated.' });
        }

        const { ai, aiStatus } = out;
        if (!aiStatus.ok) {
            return res.status(502).json({ success: false, aiStatus, error: aiStatus.message });
        }

        const patched = { ...rj, ai, aiStatus };
        const { error } = await supabase.from('reports').update({
            ai_json: ai,
            ai_summary: ai?.executive_summary || null,
            ai_status: aiStatus,
            report_json: patched
        }).eq('id', rep.id).eq('user_id', ctx.user.id);
        if (error) throw error;

        res.json({ success: true, aiStatus, ai });
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

        // report_json is no longer selected here. This endpoint used to pull
        // the entire payload for every snapshot in the set to read four
        // scalars off it; those four are now written onto the report row at
        // insert time.
        const { data: runs } = await supabase.from('reports')
            .select('id, snapshot_date, created_at, score, grade, engagement_rate, target_handle, ' +
                    'score_version, score_v1, followers_snapshot, posts_per_week, cohort_avg_er, target_rank')
            .eq('set_id', req.params.setId).eq('user_id', ctx.user.id)
            .order('created_at', { ascending: true });

        if (!runs || !runs.length) return res.json({ runs: [], delta: null });

        const points = runs.map(r => ({
            reportId: r.id,
            date: r.snapshot_date || r.created_at?.slice(0, 10),
            score: r.score,
            scoreVersion: r.score_version ?? 1,
            scoreV1: r.score_v1 ?? null,
            grade: r.grade,
            engagementRate: r.engagement_rate,
            postsPerWeek: r.posts_per_week ?? null,
            followers: r.followers_snapshot ?? null,
            cohortAvgEngagement: r.cohort_avg_er ?? null,
            rank: r.target_rank ?? null
        }));

        // Scoring-version discontinuity.
        //
        // reports.score holds whichever formula was live when the snapshot was
        // taken. Diffing a v1 snapshot against a v2 one reports the scoring
        // change as an account change — a healthy account reads as "down 13"
        // for reasons that have nothing to do with the account. When the
        // series is mixed, fall back to the v1 score, which every version
        // records, and say so rather than silently plotting two scales.
        const versions = [...new Set(points.map(p => p.scoreVersion))];
        const mixed = versions.length > 1;
        const comparable = mixed && points.every(p => p.scoreV1 != null);

        const scoreOf = p => (mixed && comparable) ? p.scoreV1 : p.score;
        points.forEach(p => { p.comparableScore = scoreOf(p); });

        let delta = null;
        if (points.length > 1) {
            const a = points[points.length - 2], b = points[points.length - 1];
            const days = Math.round((new Date(b.date) - new Date(a.date)) / 86400000);
            delta = {
                from: a.date, to: b.date, days,
                score: (mixed && !comparable) ? null : (scoreOf(b) || 0) - (scoreOf(a) || 0),
                engagementRate: +((b.engagementRate || 0) - (a.engagementRate || 0)).toFixed(2),
                followers: (b.followers || 0) - (a.followers || 0),
                rankChange: (a.rank && b.rank) ? a.rank - b.rank : null
            };
        }

        const scoring = {
            versions,
            mixed,
            comparable,
            basis: (mixed && comparable) ? 'score_v1' : 'score',
            note: !mixed ? null
                : comparable
                    ? 'This set spans a scoring change. The line is plotted on the original v1 scale so the snapshots stay comparable.'
                    : 'This set spans a scoring change and some snapshots predate the comparable score, so the score delta is not shown. Engagement rate, followers and rank are unaffected.'
        };

        res.json({ runs: points, delta, scoring });
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

// (crypto is required once at the top of the file)

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
    if (!p || typeof p !== 'object') return { total: 0, breakdown: null };
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
    // Actors do occasionally emit a null row in the middle of a dataset.
    // Throwing here killed the whole job after the scrape had already billed.
    if (!p || typeof p !== 'object') return { type: 'text', link: null };
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
/**
 * Is this the seller talking, not the buyer? A vendor advert routinely
 * contains "looking for a reliable plumber?" as a hook, which is why the
 * demand patterns alone let ads into the lead feed. Any two vendor cues, or
 * one hard cue (phone number, "our services include"), and the post is not
 * demand — it is competition.
 */
const FB_VENDOR_HARD = [
    /\b(our services? (include|are)|services? (we )?(offer|provide)|we (offer|provide|specialise|specialize|install|repair|deliver)|we are (a|an|the) (team|company|business))\b/i,
    /\b(book (now|today|your)|order now|call (us|now|today)|dm (us|me) for (price|rate|details|order)|inbox (us|me) for)\b/i,
    /(\+?880|\b0?1[3-9]\d{8}\b|\(\d{3}\) ?\d{3}-\d{4}|\b\d{3}[-. ]\d{3}[-. ]\d{4}\b)/,          // phone numbers, BD + US forms
    /(কল করুন|অর্ডার করুন|ইনবক্স করুন|আমাদের সার্ভিস|আমরা দিচ্ছি|হোম ডেলিভারি)/
];
const FB_VENDOR_SOFT = [
    /\b(llc|ltd|inc|co\.|pvt|enterprise|solutions|services)\b/i,
    /\b(free (quote|estimate|consultation)|licensed|insured|years? of experience|satisfaction guaranteed|affordable|best price|special offer|discount)\b/i,
    /\b(whatsapp|contact us|visit (our|us)|website|www\.|http)\b/i,
    /\b(price|rate|tk|৳|\$)\s*\d/i,
    /(\p{Extended_Pictographic}[^\p{Extended_Pictographic}\n]{2,40}){5,}/u   // emoji-bulleted service list
];

function looksLikeVendor(text) {
    const t = String(text || '');
    if (FB_VENDOR_HARD.some(re => re.test(t))) return true;
    return FB_VENDOR_SOFT.filter(re => re.test(t)).length >= 2;
}

function mineDemand(text, ctx = {}) {
    const t = String(text || '');
    if (t.length < 12) return [];

    const hits = FB_DEMAND_PATTERNS.filter(p => p.re.test(t));
    if (!hits.length) return [];
    if (looksLikeVendor(t)) return [];

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
    // Greeting is checked BEFORE location/name. "Hi everyone," satisfies both,
    // and the location rule used to win, quietly filing every greeting-opener
    // under location/name and skewing the opening-pattern leaderboard.
    if (/^(hi|hello|hey|assalamu|salam|dear|friends|guys|everyone)\b/i.test(first)) return 'greeting';
    if (/^[A-Z\u0980-\u09FF][\w\u0980-\u09FF' ]{2,24},/.test(first)) return 'location/name';
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

    const wantComments = !!opts.sampleComments && (opts.commentPosts == null || opts.commentPosts > 0);
    const actorInput = {
        startUrls: [{ url }],
        resultsLimit: limit,
        maxPosts: limit,
        onlyPostsNewerThan
    };
    if (wantComments) {
        actorInput.commentsMode = 'RANKED_THREADED';
        actorInput.maxComments = 10;
        actorInput.scrapeComments = true;
    }

    const { items } = await callActor(client, FB_GROUP_POSTS_ACTOR, actorInput, {
        maxItems: limit,
        jobId: opts.jobId,
        estimateUsd: fbEstimateCredits(1, limit, opts.sampleComments, opts.commentPosts)
    });

    const raw = items || [];
    // What the actor actually returned is the only thing that explains a
    // zero-post room, so it is logged every time, not just on failure.
    logger.info('fb_group_scraped', {
        groupId, count: raw.length, wantComments,
        keys: Object.keys(raw[0] || {}).slice(0, 30)
    });

    return { raw, groupId, url };
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

    const memberCount = firstNum(
        first.groupMembersCount, first.groupMemberCount, first.membersCount, first.memberCount,
        g.memberCount, g.membersCount, g.members, groupRef.hintMembers, 0
    );
    const hasPrivacy = !!(first.groupPrivacy || g.privacy || first.privacy);

    return {
        group_id: groupRef.groupId,
        name: first.groupTitle || first.groupName || g.name || groupRef.hintName || groupRef.name || groupRef.groupId,
        url: groupRef.url,
        member_count: memberCount,
        privacy: privacyRaw.includes('private') || privacyRaw.includes('closed') ? 'private' : 'public',
        privacy_known: hasPrivacy,
        rules_known: !!rulesText,
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
    if (!geminiAvailable()) {
        return { ai: null, aiStatus: { ok: false, reason: 'no_key', message: aiReasonText('no_key') } };
    }

    const slim = payload.mode === 'single'
        ? { mode: 'single', group: fbGroupAiSlim(payload.group) }
        : {
            mode: 'combined',
            groups: (payload.groups || []).slice(0, 15).map(fbGroupAiSlim),
            benchmark: payload.benchmark || null
          };
    const { json, dropped, chars } = budgetedJson(slim, {
        maxChars: AI_PROMPT_BUDGET, keep: ['mode', 'group', 'groups']
    });

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
${json}`;

    const r = await geminiCallDetailed(prompt, { temperature: 0.45, tag: 'Gemini FB' });
    logger.info('ai_narrative', { tag: 'fb_community', ok: r.ok, reason: r.reason, promptChars: chars, dropped });
    return {
        ai: r.data,
        aiStatus: {
            ok: r.ok, reason: r.reason, message: aiReasonText(r.reason),
            promptChars: chars, dropped, model: GEMINI_MODEL,
            generatedAt: new Date().toISOString()
        }
    };
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

    const ai = await geminiCallDetailed(prompt, { temperature: 0.75, maxOutputTokens: 6000, tag: 'Gemini FB' });
    const out = ai.ok ? ai.data : null;
    let drafts = Array.isArray(out?.drafts) ? out.drafts : [];
    const produced = drafts.length;

    // Belt and braces: the compliance gate is enforced in code as well as in
    // the prompt. A model that ignores the instruction must not reach the user.
    if (!promoAllowed) {
        const banned = /\b(dm me|inbox me|message me|contact us|call us|whatsapp|order now|book now|our (service|shop|company|price)|we offer|discount|visit our|price starts|only \d+ ?(tk|৳|\$))\b/i;
        drafts = drafts.filter(d => !banned.test(String(d.draft_text || '')));
    }

    return { drafts, complianceMode: mode, promoAllowed, ai, removed: produced - drafts.length };
}

// ===========================================================================
// FB PERSISTENCE
// ===========================================================================

async function fbUpsertGroup(userId, meta, extra = {}, { preserve = false } = {}) {
    // preserve=true is the scrape path. The posts actor does not return
    // member counts or rules, so a scrape must never overwrite what the user
    // typed in the Edit modal with 0 / null / defaults. ON CONFLICT DO UPDATE
    // only touches the columns supplied, so unknown values are simply omitted.
    const row = {
        user_id: userId,
        group_id: meta.group_id,
        url: meta.url,
        ...extra
    };
    const nameIsId = !meta.name || String(meta.name) === String(meta.group_id);
    if (!preserve || !nameIsId) row.name = meta.name || meta.group_id;
    if (!preserve || (meta.member_count || 0) > 0) row.member_count = meta.member_count || 0;
    if (!preserve || meta.privacy === 'private' || meta.privacy_known) row.privacy = meta.privacy || 'public';
    if (!preserve || meta.rules_known) {
        row.rules_text = meta.rules_text || null;
        row.promo_allowed = meta.promo_allowed !== false;
        row.approval_required = !!meta.approval_required;
    }
    const { data, error } = await supabase.from('fb_groups')
        .upsert(row, { onConflict: 'user_id,group_id' })
        .select('id, group_id, name, url, member_count, room_value_score, promo_allowed, approval_required, privacy, niche, location_label')
        .maybeSingle();
    if (error) console.error('[fbUpsertGroup]', error.message);
    return data;
}

async function fbSavePosts(rows, clientId = null) {
    if (!rows.length) return 0;
    // phase 10: rows are filed under the client the run was started for,
    // so every member of that client can build on them.
    const cid = (clientId && UUID_RE.test(String(clientId))) ? clientId : null;
    let saved = 0;
    for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200).map(r => ({ ...r, client_id: cid }));
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

function fbEstimateCredits(groups, postsPerGroup, sampleComments, commentPosts = null) {
    const posts = groups * postsPerGroup;
    // The comment surcharge applies to the posts whose comments are pulled,
    // not to every post in the run. commentPosts === null keeps the old
    // "all posts" behaviour for callers that have not been told a count.
    const sampled = sampleComments
        ? (commentPosts == null ? postsPerGroup : Math.min(Math.max(commentPosts, 0), postsPerGroup))
        : 0;
    const surcharge = (groups * sampled / 1000) * COST_PER_1K_FB_POSTS * 0.6;
    return +(((posts / 1000) * COST_PER_1K_FB_POSTS) + surcharge).toFixed(4);
}

/**
 * Scrape one group end to end: raw -> normalised -> indexed -> demand mined.
 * Shared by discovery (shallow) and audit (deep).
 */
async function fbProcessGroup(client, userId, groupRef, opts) {
    const { raw } = await fbScrapeGroup(client, groupRef, opts);
    const meta = fbGroupMeta(raw, groupRef);

    const scrapeNote = raw.length
        ? null
        : (meta.privacy === 'private'
            ? 'Group is private — no public posts.'
            : 'Actor returned 0 posts. Check the URL form and that the group is public; see fb_group_scraped in server logs.');

    const groupRow = await fbUpsertGroup(userId, meta, {
        niche: opts.niche || null,
        location_label: opts.location || null,
        source: opts.source || 'manual',
        last_scraped_at: new Date().toISOString(),
        last_scrape_posts: raw.length,
        last_scrape_note: scrapeNote
    }, { preserve: true });

    const rows = raw
        .map(item => fbNormalisePost(item, meta.group_id, groupRow?.id, userId))
        .filter(Boolean);

    fbIndexPosts(rows);

    const now = new Date().toISOString();
    const demand = [];
    const base = r => ({
        user_id: userId,
        group_id: meta.group_id,
        group_name: meta.name,
        source_url: r.post_url,
        posted_at: r.posted_at,
        detected_at: now
    });

    rows.forEach(r => {
        mineDemand(r.content, { engagement: r.engagement_raw, postedAt: r.posted_at }).forEach(d => {
            demand.push({
                ...base(r),
                source_post_id: r.post_id,
                author_hash: r.author_hash,
                engagement: Math.round(r.engagement_raw),
                source_type: 'post',
                ...d
            });
        });
    });

    // Comment mining. Only the top-N posts by engagement, because that is
    // what the surcharge in fbEstimateCredits was charged for. Comments are
    // where "me too, who did you use?" lives — a second demand layer that
    // the post text alone never shows.
    const commentPosts = opts.sampleComments ? (opts.commentPosts ?? 20) : 0;
    if (commentPosts > 0 && rows.length) {
        const byPostId = new Map(raw.map(item => [fbPostId(item), item]));
        const top = [...rows].sort((a, b) => b.engagement_raw - a.engagement_raw).slice(0, commentPosts);
        for (const r of top) {
            const item = byPostId.get(r.post_id);
            const comments = fbCommentsOf(item);
            comments.forEach((c, i) => {
                if (!c.text || c.text.length < 12) return;
                mineDemand(c.text, { engagement: c.likes || 0, postedAt: c.postedAt || r.posted_at }).forEach(d => {
                    demand.push({
                        ...base(r),
                        source_post_id: `${r.post_id}#c${i}`,
                        author_hash: authorHash(c.author || null, meta.group_id),
                        engagement: Math.round(c.likes || 0),
                        source_type: 'comment',
                        ...d
                    });
                });
            });
        }
    }

    return { meta, groupRow, rows, demand };
}

/**
 * Comment payload of one raw group post, normalised to {text, author, likes,
 * postedAt}. The groups actor has shipped comments under several keys over
 * time; every known one is read.
 */
function fbCommentsOf(item) {
    if (!item) return [];
    const arr = [item.comments, item.latestComments, item.topComments, item.commentsList]
        .find(Array.isArray) || [];
    return arr.map(c => {
        if (!c) return null;
        if (typeof c === 'string') return { text: c, author: null, likes: 0, postedAt: null };
        return {
            text: String(c.text || c.message || c.commentText || '').trim(),
            author: c.profileName || c.authorName || c.name || c.author?.name || c.user?.name || null,
            likes: firstNum(c.likesCount, c.likes, c.reactionsCount, 0),
            postedAt: c.date || c.timestamp || c.time || null
        };
    }).filter(Boolean);
}

// ===========================================================================
// FB API :: ESTIMATE
// ===========================================================================

app.get('/api/fb/estimate-credits', async (req, res) => {
    const ctx = await auth(req, res); if (!ctx) return;
    const groups = Math.min(parseInt(req.query.groups || '1', 10), FB_MAX_GROUPS);
    const posts = Math.min(parseInt(req.query.posts || FB_DEFAULT_POSTS, 10), FB_MAX_POSTS);
    const sampleComments = req.query.comments === 'true' || req.query.comments === '1';
    const commentPosts = req.query.cposts != null
        ? Math.min(Math.max(parseInt(req.query.cposts, 10) || 0, 0), 40) : null;
    const estimatedUsd = fbEstimateCredits(groups, posts, sampleComments, commentPosts);
    res.json({
        groups, postsPerGroup: posts,
        totalPosts: groups * posts,
        sampleComments, commentPosts,
        estimatedUsd,
        budget: await budgetSnapshot('fb_community', ctx.user.id, estimatedUsd),
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
            { clientId: await resolveClientId(req, ctx), location, niche, keywords, seeds, sampleSize: sample, maxGroups: cap }, estimate);

        runJob(job.id, JOB_WORKERS['fb_discovery'](ctx.user.id, job.input, job.id));

        res.status(202).json({
            success: true, jobId: job.id,
            candidates: seeds.length || cap,
            estimatedUsd: estimate
        });
    } catch (err) { sendErr(res, err); }
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

/**
 * Add one room by hand.
 *
 * fb-communities.html has always had this form; the endpoint behind it was
 * never written, so "Save room" returned a 404 and the manual path into the
 * product did not work at all. Optionally probes the room so it arrives with a
 * Room Value score instead of an empty one.
 *
 * The rules text matters more than it looks: the advisor's compliance gate
 * reads promo_allowed, and for a hand-added room this is the only place it
 * can be set.
 */
app.post('/api/fb/groups', spendLimit, async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        const {
            url, name, memberCount, location, niche, rulesText,
            promoAllowed = true, approvalRequired = false, probe = false
        } = req.body;

        const ref = parseGroupRef(url);
        if (!ref) return res.status(400).json({ error: 'That is not a Facebook group URL. It should look like facebook.com/groups/…' });
        const probeClientId = await resolveClientId(req, ctx);   // phase 10: probe rows filed under the client

        // Stated rules win over the checkboxes when they contradict them: a
        // group that writes "no promotion" in its rules bans promotion no
        // matter which box was ticked.
        const parsed = rulesText ? parseRules(rulesText) : null;

        const meta = {
            group_id: ref.groupId,
            name: (name && String(name).trim()) || ref.groupId,
            url: ref.url,
            member_count: parseInt(memberCount || '0', 10) || 0,
            privacy: 'unknown',
            rules_text: rulesText ? String(rulesText).slice(0, 4000) : null,
            promo_allowed: parsed ? parsed.promo_allowed : promoAllowed !== false,
            approval_required: parsed ? parsed.approval_required : !!approvalRequired
        };

        const extra = {
            niche: niche || null,
            location_label: location || null,
            source: 'manual'
        };

        const warnings = [];

        if (probe) {
            // A shallow probe: enough posts to score the room, not enough to
            // cost real money.
            const PROBE_POSTS = 25;
            try {
                const { client } = await getWorkingClient('fb_community', ctx.user.id, {
                    needUsd: fbEstimateCredits(1, PROBE_POSTS, false)
                });
                const { rows, demand, meta: scraped } = await fbProcessGroup(
                    client, ctx.user.id, ref,
                    { limit: PROBE_POSTS, days: 30, sampleComments: false, source: 'manual' }
                );

                // What the scrape found beats what was typed in, except where
                // the user deliberately overrode it.
                if (scraped?.name && !name) meta.name = scraped.name;
                if (scraped?.member_count) meta.member_count = scraped.member_count;
                if (scraped?.privacy) meta.privacy = scraped.privacy;

                if (rows?.length) {
                    await fbSavePosts(rows, probeClientId);
                    await fbSaveDemand(demand);
                    // Scored the same way discovery scores a room, so a
                    // hand-added group is directly comparable to a found one.
                    const audit = computeGroupAudit({ ...meta, ...scraped }, rows, demand || []);
                    extra.room_value_score = audit.roomValue;
                    extra.score_breakdown = audit.roomValueBreakdown;
                } else {
                    warnings.push('The probe returned no posts — the group may be private, empty, or blocked. Saved unscored.');
                }
                extra.last_scraped_at = new Date().toISOString();
            } catch (e) {
                if (e.code === 'NO_CREDIT') {
                    warnings.push('Saved, but not probed: no Apify key has credit for it right now.');
                } else {
                    warnings.push('Saved, but the probe failed: ' + e.message);
                }
            }
        }

        const row = await fbUpsertGroup(ctx.user.id, meta, extra);
        if (!row) return res.status(500).json({ error: 'The room could not be saved.' });

        res.json({ success: true, group: row, warnings });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * Edit a saved room's details. Rules text is the field that actually changes
 * behaviour downstream, so it is re-parsed rather than stored blindly.
 */
app.patch('/api/fb/groups/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        const patch = {};

        if (req.body.name !== undefined)           patch.name = String(req.body.name || '').slice(0, 300) || null;
        if (req.body.niche !== undefined)          patch.niche = String(req.body.niche || '').slice(0, 120) || null;
        if (req.body.location_label !== undefined) patch.location_label = String(req.body.location_label || '').slice(0, 200) || null;
        if (req.body.member_count !== undefined)   patch.member_count = parseInt(req.body.member_count, 10) || 0;

        if (req.body.rules_text !== undefined) {
            const text = String(req.body.rules_text || '');
            patch.rules_text = text.slice(0, 4000) || null;
            if (text.trim()) {
                const parsed = parseRules(text);
                patch.promo_allowed = parsed.promo_allowed;
                patch.approval_required = parsed.approval_required;
            }
        }
        // An explicit toggle still wins over the parse when no rules were given.
        if (req.body.promo_allowed !== undefined && !patch.rules_text) {
            patch.promo_allowed = req.body.promo_allowed !== false;
        }
        if (req.body.approval_required !== undefined && !patch.rules_text) {
            patch.approval_required = !!req.body.approval_required;
        }

        if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update.' });

        const { data, error } = await supabase.from('fb_groups')
            .update(patch).eq('id', req.params.id).eq('user_id', ctx.user.id)
            .select('id, group_id, name, url, niche, location_label, member_count, rules_text, promo_allowed, approval_required, room_value_score')
            .maybeSingle();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Room not found.' });

        res.json({ success: true, group: data });
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
            days, postsPerGroup, sampleComments = false, commentSamplePosts,
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
        // How many posts (per room, by engagement) get their comments pulled
        // and mined. 0 with sampleComments=true means "count only".
        const commentPosts = sampleComments
            ? Math.min(Math.max(parseInt(commentSamplePosts ?? 20, 10) || 0, 0), 40)
            : 0;
        const estimate = fbEstimateCredits(refs.length, limit, sampleComments, commentPosts);

        // Re-runnable set, same pattern as competitor_sets
        let activeSetId = setId || null;
        if (!activeSetId && refs.length > 1) {
            const { data: set } = await supabase.from('fb_group_sets').insert([{
                user_id: ctx.user.id,
                client_id: await resolveClientId(req, ctx),
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

        const job = await createJob(ctx.user.id, 'fb_community_audit', 'fb_community', { clientId: await resolveClientId(req, ctx),
            groups: refs.map(r => r.groupId), mode: auditMode,
            days: window, postsPerGroup: limit, sampleComments, commentSamplePosts: commentPosts,
            setId: activeSetId, groupNames: refs.map(r => r.name || r.groupId),
            niche: niche || null, location: location || null, since
        }, estimate);

        runJob(job.id, JOB_WORKERS['fb_community_audit'](ctx.user.id, job.input, job.id));

        res.status(202).json({
            success: true, jobId: job.id, mode: auditMode, setId: activeSetId,
            groups: refs.length, groupNames: refs.map(r => r.name || r.groupId),
            postsPerGroup: limit, days: window, commentSamplePosts: commentPosts,
            estimatedUsd: estimate,
            budget: await budgetSnapshot('fb_community', ctx.user.id, estimate)
        });
    } catch (err) { sendErr(res, err); }
});

// ===========================================================================
// FB API :: REPORTS
// ===========================================================================

app.get('/api/fb/reports', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        let q = supabase.from('reports')
            .select('id, user_id, client_id, target_handle, fb_group_names, fb_group_ids, audit_mode, grade, score, posts_analyzed, snapshot_date, created_at, ai_summary, location_label, niche, set_id, report_type')
            .eq('platform', 'facebook');
        q = (await applyReportScope(req, ctx))(q);
        const { data, error } = await q
            // Page reports share the vault but are a different engine. Without
            // this they showed up in the community list and 404'd on open.
            .neq('report_type', 'fb_page')
            .order('created_at', { ascending: false }).limit(100);
        if (error) throw error;
        res.json({ reports: data || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fb/report/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        const { data } = await supabase.from('reports').select('*')
            .eq('id', req.params.id).maybeSingle();
        if (!data || !(await canReadReport(ctx, data))) return res.status(404).json({ error: 'Report not found' });
        res.json({ report: data });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/** Delete one community report. The vault list has always offered this. */
app.delete('/api/fb/report/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        const { error } = await supabase.from('reports')
            .delete().eq('id', req.params.id).eq('user_id', ctx.user.id)
            .eq('platform', 'facebook').neq('report_type', 'fb_page');
        if (error) throw error;
        res.json({ success: true });
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

        // Free-text search over what the person asked for and the trigger
        // phrase. Sanitised the same way as search-leads: PostgREST's .or()
        // is a DSL, so commas, dots and parens must not survive from input.
        const text = String(req.query.q || '')
            .trim().replace(/[@,().\\%*]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
        if (text) q = q.or(`snippet.ilike.*${text}*,matched_phrase.ilike.*${text}*`);

        // sort=recent → newest post first; anything else → lead score first.
        q = req.query.sort === 'recent'
            ? q.order('posted_at', { ascending: false, nullsFirst: false }).order('lead_score', { ascending: false })
            : q.order('lead_score', { ascending: false }).order('detected_at', { ascending: false });

        const { data, error } = await q
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
// The page asks for '.csv'; the original route had no extension, so the
// export button 404'd. Both spellings are served rather than picking one and
// breaking whichever caller used the other.
app.get(['/api/fb/demand-export', '/api/fb/demand-export.csv'], async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        let q = supabase.from('fb_demand_signals')
            .select('group_name, category, urgency, lead_score, matched_phrase, snippet, source_url, posted_at, status')
            .eq('user_id', ctx.user.id);
        // Same filter set as /api/fb/demand-feed, so the CSV is what is on screen.
        if (req.query.group_id) q = q.eq('group_id', req.query.group_id);
        if (req.query.category) q = q.eq('category', req.query.category);
        if (req.query.urgency)  q = q.eq('urgency', req.query.urgency);
        if (req.query.status)   q = q.eq('status', req.query.status);
        else                    q = q.neq('status', 'dismissed');
        const text = String(req.query.q || '')
            .trim().replace(/[@,().\\%*]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
        if (text) q = q.or(`snippet.ilike.*${text}*,matched_phrase.ilike.*${text}*`);
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

        if (!geminiAvailable()) return res.status(503).json({ error: 'GEMINI_API_KEY is not configured on the server.' });

        // The report is frozen at audit time. The fb_groups row is what the
        // user edits (promo ok / no promo, rules pasted in), so it wins.
        const { data: groupRow } = await supabase.from('fb_groups')
            .select('promo_allowed, approval_required, rules_text, member_count, name')
            .eq('user_id', ctx.user.id).eq('group_id', audit.groupId).maybeSingle();
        if (groupRow) {
            audit.promoAllowed = groupRow.promo_allowed !== false;
            audit.approvalRequired = !!groupRow.approval_required;
            if (groupRow.rules_text) audit.rulesText = groupRow.rules_text;
            if (groupRow.member_count && !audit.memberCount) audit.memberCount = groupRow.member_count;
        }

        const { drafts, complianceMode, promoAllowed, ai, removed } = await fbGenerateDrafts(audit, { count, brief });
        if (!drafts.length) {
            if (ai && !ai.ok) {
                const retryable = ai.reason === 'exhausted' || ai.reason === 'network' || String(ai.reason).startsWith('http_5');
                return res.status(retryable ? 503 : 502).json({
                    error: `Drafts could not be generated: ${aiReasonText(ai.reason)}${retryable ? ' Try again in a minute.' : ''}`,
                    aiStatus: ai
                });
            }
            if (removed > 0) {
                return res.status(422).json({
                    error: `The model produced ${removed} draft(s) but every one contained a pitch, and this room is marked "no promo". Give a value-first brief (what you know, not what you sell), or mark the room "promo ok" on the Communities page if its rules allow it.`,
                    removed, complianceMode
                });
            }
            return res.status(502).json({ error: 'The model returned no drafts. Try again, or reduce the count.' });
        }

        const suggClientId = await resolveClientId(req, ctx);
        const rows = drafts.map(d => ({
            user_id: ctx.user.id,
            client_id: suggClientId,
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
            { clientId: await resolveClientId(req, ctx), suggestionId: sug.id, groupId: sug.group_id }, fbEstimateCredits(1, 60, false));

        runJob(job.id, JOB_WORKERS['fb_verify'](ctx.user.id, job.input, job.id));

        res.status(202).json({ success: true, jobId: job.id });
    } catch (err) { sendErr(res, err); }
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
    if (!geminiAvailable()) {
        return { ai: null, aiStatus: { ok: false, reason: 'no_key', message: aiReasonText('no_key') } };
    }

    const { json, dropped, chars } = budgetedJson({
        target: fbPageAiSlim(payload.target),
        rival: fbPageAiSlim(payload.rival),
        benchmark: payload.benchmark || null,
        brief: payload.brief || null
    }, { maxChars: AI_PROMPT_BUDGET, keep: ['target', 'brief'] });

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
${json}`;

    const r = await geminiCallDetailed(prompt, { temperature: 0.45, tag: 'Gemini FB Page' });
    logger.info('ai_narrative', { tag: 'fb_page', ok: r.ok, reason: r.reason, promptChars: chars, dropped });
    return {
        ai: r.data,
        aiStatus: {
            ok: r.ok, reason: r.reason, message: aiReasonText(r.reason),
            promptChars: chars, dropped, model: GEMINI_MODEL,
            generatedAt: new Date().toISOString()
        }
    };
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

async function fbSavePagePosts(rows, clientId = null) {
    if (!rows.length) return 0;
    const cid = (clientId && UUID_RE.test(String(clientId))) ? clientId : null;   // phase 10
    let saved = 0;
    for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200).map(r => ({ ...r, client_id: cid }));
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
    await fbSavePagePosts(unique, opts.clientId || null);

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
    const estimatedUsd = fbPageEstimateCredits(pages, posts, withReviews);
    res.json({
        pages, postsPerPage: posts, totalPosts: pages * posts, includeReviews: withReviews,
        estimatedUsd,
        budget: await budgetSnapshot('fb_page', ctx.user.id, estimatedUsd),
        note: 'Estimate only. Actual Apify billing depends on the actor and how many posts the page actually returns.'
    });
});

// ===========================================================================
// FB PAGE API :: RUN A REPORT  (async job, poll /api/job/:id)
// ===========================================================================

// ===========================================================================
// FACEBOOK LEAD DISCOVERY  (phase 16)
//
// The Facebook half of lead generation, and it works off Pages rather than
// groups on purpose.
//
// The group pipeline destroys author identity by design — author_hash is a
// one-way HMAC and author_label holds only 'admin' or 'member' — so a group
// post proves demand exists but names nobody reachable. Making it name people
// would mean deleting a privacy control built deliberately, over private
// individuals posting in often-private groups.
//
// A Page is a business publishing its own contact button, which is the direct
// equivalent of the Instagram business profiles the existing methods already
// target. Same shape of data, same defensibility.
// ===========================================================================

/** A Page result from search, reduced to what discovery needs. */
function fbPageSearchRefs(items) {
    const out = new Map();
    for (const it of (items || [])) {
        const ref = parsePageRef(it.url || it.pageUrl || it.link || it.facebookUrl || it.id);
        if (!ref || out.has(ref.pageId)) continue;
        out.set(ref.pageId, {
            ...ref,
            hintName: it.title || it.name || it.pageName || null,
            hintCategory: it.category || it.categoryName || null
        });
    }
    return [...out.values()];
}

/**
 * A scraped Page turned into a lead row.
 *
 * username is the page's vanity where it has one and its numeric id where it
 * does not, because the unique key is (owner, platform, username) and a page
 * without a vanity still has to land somewhere stable.
 */
function fbPageToLead(profile, userId) {
    const handle = String(profile.username || profile.page_id || '')
        .replace(/^https?:\/\/(www\.)?facebook\.com\//i, '')
        .replace(/\/+$/, '')
        .trim()
        .toLowerCase();
    if (!handle) return null;

    return {
        owner_user_id: userId,
        platform: 'facebook',
        platform_id: profile.page_id || null,
        username: handle,
        full_name: profile.name || null,
        email: profile.email || null,
        phone: profile.phone || null,
        website: profile.website || null,
        category: profile.category || null,
        city: profile.city || null,
        address: profile.address || null,
        followers_count: profile.followers || profile.likes || null,
        bio: profile.about ? String(profile.about).slice(0, 2000) : null,
        is_business: true,
        is_verified: !!profile.verified,
        profile_url: profile.url || `https://www.facebook.com/${handle}`,
        // Enriched on arrival: unlike Instagram, one Page scrape returns the
        // profile and its contact details together, so there is no second pass.
        is_enriched: true,
        sources_detected: ['facebook_page']
    };
}

registerWorker('fb_lead_discovery', (userId, input, jobId) => async (progress, ck) => {
    const keywords = (Array.isArray(input.keywords) ? input.keywords : [])
        .map(k => String(k || '').trim()).filter(Boolean).slice(0, 4);
    const location = String(input.location || '').trim();
    const maxPages = Math.min(parseInt(input.maxPages, 10) || 20, 40);
    const warnings = [];

    if (!keywords.length) throw new Error('Give it at least one thing to search for.');

    const queries = [...new Set(
        keywords.flatMap(k => location ? [`${k} ${location}`, k] : [k])
    )].slice(0, 5);

    // ---- 1. find candidate pages -------------------------------------------
    const refs = new Map();
    for (let i = 0; i < queries.length; i++) {
        const q = queries[i];
        const unit = 'fbsearch:' + q;

        if (ck.isDone(unit)) {
            (ck.get(unit) || []).forEach(r => refs.set(r.pageId, r));
            await progress(5 + Math.floor(25 * i / queries.length), `"${q}" already searched — reusing`);
            continue;
        }

        await progress(5 + Math.floor(25 * i / queries.length), `Searching Facebook for "${q}"`);
        const estimate = fbEstimateCredits(1, 25, false);
        const { client } = await getWorkingClient('leadgen', userId, { needUsd: estimate, jobId });

        try {
            const { items } = await callActor(client, FB_SEARCH_ACTOR, {
                search: q, searchType: 'pages', query: q,
                resultsLimit: 25, maxResults: 25
            }, { maxItems: 25, estimateUsd: estimate, jobId });

            const found = fbPageSearchRefs(items);
            found.forEach(r => refs.set(r.pageId, r));
            await ck.done(unit, found);
        } catch (e) {
            if (e.code === 'NO_CREDIT' || e.code === 'CANCELLED') throw e;
            warnings.push(`Search for "${q}" failed: ${e.message}`);
            await ck.done(unit, []);
        }
    }

    if (!refs.size) {
        return { platform: 'facebook', found: 0, saved: 0, warnings: warnings.concat('No pages matched that search.') };
    }

    // ---- 2. drop the ones already on the list -------------------------------
    const candidates = [...refs.values()].slice(0, maxPages);
    const { data: existing } = await supabase.from('leads')
        .select('platform_id')
        .eq('owner_user_id', userId).eq('platform', 'facebook')
        .in('platform_id', candidates.map(c => c.pageId));
    const known = new Set((existing || []).map(e => e.platform_id));
    const fresh = candidates.filter(c => !known.has(c.pageId));

    if (!fresh.length) {
        return { platform: 'facebook', found: candidates.length, saved: 0,
                 warnings: warnings.concat('Every page found is already on your list.') };
    }

    // ---- 3. the allowance, before any of it is scraped ----------------------
    // Taken up front rather than per page: scraping forty pages and then
    // discovering there was room for five spends the difference for nothing.
    const allowed = await takeLeadQuota(userId, fresh.length);
    if (allowed <= 0) {
        return { platform: 'facebook', found: candidates.length, saved: 0,
                 warnings: warnings.concat('Lead allowance reached, so nothing new was collected.') };
    }
    if (allowed < fresh.length) {
        warnings.push(`Lead allowance reached. Collected ${allowed} of the ${fresh.length} new pages found.`);
    }

    const wanted = fresh.slice(0, allowed);
    let refunded = 0;

    // ---- 4. scrape each page, one checkpoint each ---------------------------
    const rows = [];
    for (let i = 0; i < wanted.length; i++) {
        const ref  = wanted[i];
        const unit = 'fbpage:' + ref.pageId;
        const pct  = 35 + Math.floor(55 * i / wanted.length);

        if (ck.isDone(unit)) {
            const saved = ck.get(unit);
            if (saved) rows.push(saved); else refunded += 1;
            await progress(pct, `Page ${i + 1} of ${wanted.length} already collected`);
            continue;
        }

        await progress(pct, `Reading ${ref.hintName || ref.pageId} (${i + 1} of ${wanted.length})`);

        try {
            const { client } = await getWorkingClient('leadgen', userId,
                { needUsd: COST_PER_FB_PAGE_PROFILE, jobId });
            const items = await fbScrapePageProfile(client, ref);
            const lead  = fbPageToLead(fbPageProfile(items, ref), userId);

            if (lead) { rows.push(lead); await ck.done(unit, lead); }
            else      { refunded += 1;  await ck.done(unit, null); }
        } catch (e) {
            if (e.code === 'NO_CREDIT' || e.code === 'CANCELLED') throw e;
            warnings.push(`Could not read ${ref.hintName || ref.pageId}: ${e.message}`);
            refunded += 1;
            await ck.done(unit, null);
        }
    }

    // ---- 5. save ------------------------------------------------------------
    await progress(92, `Saving ${rows.length} business(es)`);
    let saved = 0;

    for (let i = 0; i < rows.length; i += 100) {
        const slice = rows.slice(i, i + 100);
        // Upsert, not insert: phase 16 added the unique key these conflict on,
        // so a re-run or an overlapping search updates rather than duplicating.
        const { error } = await supabase.from('leads')
            .upsert(slice, { onConflict: 'owner_user_id,platform,username', ignoreDuplicates: false });
        if (error) {
            warnings.push(`A batch of ${slice.length} did not save — ${error.message}`);
            logger.error('fb_lead_save_failed', { jobId, message: error.message });
            refunded += slice.length;
        } else {
            saved += slice.length;
        }
    }

    // Facebook leads carried no client at all before phase 23 — a search run
    // for a client left nothing on the row or anywhere else that said so.
    if (input.clientId && saved) {
        const names = rows.map(r => r.username).filter(Boolean);
        const { data: mine } = await supabase.from('leads').select('id')
            .eq('owner_user_id', userId).eq('platform', 'facebook').in('username', names);
        await linkLeadsToClient(input.clientId, (mine || []).map(r => r.id), 'fb_discovery', jobId);
    }

    // Allowance was taken for every page we meant to read. Anything that did
    // not become a saved lead goes back.
    if (refunded > 0) await refundLeadQuota(userId, refunded);

    await progress(100, `Saved ${saved} business(es) from Facebook`);
    return { platform: 'facebook', found: candidates.length, saved, warnings };
});

/**
 * Start a Facebook Page lead search.
 *
 * On the leadgen engine rather than fb_page: this is lead generation that
 * happens to read Pages, so it draws the leadgen key and is gated by the
 * leadgen grant — which is what a trial client already holds.
 */
app.post('/api/fb/find-leads', spendLimit, async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;
        await assertJobSlot(ctx.user.id);

        const keywords = (Array.isArray(req.body?.keywords) ? req.body.keywords : [req.body?.keywords])
            .map(k => String(k || '').trim()).filter(Boolean).slice(0, 4);
        if (!keywords.length) return res.status(400).json({ error: 'Give it at least one thing to search for.' });

        const location = String(req.body?.location || '').trim();
        const maxPages = Math.min(parseInt(req.body?.maxPages, 10) || 20, 40);

        // Search calls plus one profile read each — the same arithmetic the
        // worker will actually perform.
        const estimate = +(
            fbEstimateCredits(Math.min(keywords.length * (location ? 2 : 1), 5), 25, false) +
            maxPages * COST_PER_FB_PAGE_PROFILE
        ).toFixed(4);

        const job = await createJob(ctx.user.id, 'fb_lead_discovery', 'leadgen',
            { clientId: await resolveClientId(req, ctx), keywords, location, maxPages }, estimate);

        runJob(job.id, JOB_WORKERS['fb_lead_discovery'](ctx.user.id, job.input, job.id));

        res.status(202).json({ success: true, jobId: job.id, maxPages, estimatedUsd: estimate });
    } catch (err) { sendErr(res, err); }
});

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
                client_id: await resolveClientId(req, ctx),
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

        const job = await createJob(ctx.user.id, 'fb_page_report', 'fb_page', { clientId: await resolveClientId(req, ctx),
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
            estimatedUsd: estimate,
            budget: await budgetSnapshot('fb_page', ctx.user.id, estimate)
        });
    } catch (err) { sendErr(res, err); }
});

// ===========================================================================
// FB PAGE API :: REPORT VAULT
// ===========================================================================

app.get('/api/fb/page-reports', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_page'); if (!ctx) return;
        let q = supabase.from('reports')
            .select('id, user_id, client_id, target_handle, competitor_handles, fb_page_ids, fb_page_names, audit_mode, grade, score, engagement_rate, posts_analyzed, snapshot_date, created_at, ai_summary, set_id, credits_estimate')
            .eq('platform', 'facebook');
        q = (await applyReportScope(req, ctx))(q);
        const { data, error } = await q
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
            .eq('id', req.params.id).maybeSingle();
        if (!data || !(await canReadReport(ctx, data))) return res.status(404).json({ error: 'Report not found' });
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
// BOOT
// ===========================================================================

/**
 * One-pass migration. Any token still sitting in the database as plaintext is
 * sealed, and token_hash is filled in for rows created before it existed.
 * Idempotent, so it is safe on every boot and a no-op once everything is done.
 */
/** Decrypt with the retiring key. Only used during rotation. */
// ===========================================================================
// TERMINAL HANDLERS
// Registered after every route, which is the only place they work.
// ===========================================================================

/**
 * A JSON 404 for the API surface.
 *
 * Without this a typo'd path fell through to Express's built-in handler, which
 * answers with an HTML page. EL.api() then failed inside JSON.parse and the
 * user saw "Unexpected token <" instead of "no such endpoint".
 */
// ===========================================================================
// PHASE 9 :: CLIENT WORKSPACE
//
// A client is the unit of work. Every report, job, set and suggestion carries
// a nullable client_id. Runs without a client keep the per-user rule that has
// always applied; runs with one land in that client's timeline and are
// visible to every member of that client.
// ===========================================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Return the client row when the user may act on it, else null.
 * need: 'viewer' (owner or any member) | 'editor' (owner or editor member) | 'owner'
 */
/**
 * The caller's account role, cached for the same window as auth itself.
 * clientAccess takes a user id rather than a ctx because half its callers are
 * workers with no request in hand, so the role has to be looked up here.
 */
const _roleCache = new Map();
async function userRole(userId) {
    const hit = _roleCache.get(userId);
    if (hit && Date.now() - hit.t < AUTH_CACHE_MS) return hit.v;
    const { data } = await supabase.from('app_users').select('role').eq('id', userId).maybeSingle();
    const v = data?.role || null;
    _roleCache.set(userId, { v, t: Date.now() });
    return v;
}

async function clientAccess(userId, clientId, need = 'viewer') {
    if (!userId || !clientId || !UUID_RE.test(String(clientId))) return null;
    const { data: c } = await supabase.from('clients').select('*').eq('id', clientId).maybeSingle();
    if (!c) return null;
    if (c.owner_user_id === userId) return { ...c, access: 'owner' };
    // An admin reaches every client. Without this, "admin creates the client
    // and assigns an employee" only worked when the admin happened to be the
    // one who created it — a client an employee made was untouchable by the
    // person whose job is to hand work out. requireEngine already lets admins
    // through every engine; this is the same rule applied to clients.
    if (await userRole(userId) === 'admin') return { ...c, access: 'admin' };
    if (need === 'owner') return null;
    const { data: m } = await supabase.from('client_members')
        .select('role').eq('client_id', clientId).eq('user_id', userId).maybeSingle();
    if (!m) return null;
    if (need === 'editor' && m.role !== 'editor') return null;
    return { ...c, access: m.role };
}

/** Read clientId from a request body, validate it, or throw 403. */
/**
 * The client record a client-role account IS. Owned first; failing that a
 * record an agency has made them an editor of; failing that, created — an
 * account that signs up to see how its business is doing is a business.
 */
async function ownClientFor(ctx) {
    const uid = ctx.user.id;
    const { data: owned } = await supabase.from('clients').select('*')
        .eq('owner_user_id', uid).eq('archived', false)
        .order('created_at', { ascending: true }).limit(1);
    if (owned && owned[0]) return owned[0];

    const { data: mem } = await supabase.from('client_members').select('client_id')
        .eq('user_id', uid).eq('role', 'editor').limit(1);
    if (mem && mem[0]) {
        const { data: c } = await supabase.from('clients').select('*').eq('id', mem[0].client_id).maybeSingle();
        if (c && !c.archived) return c;
    }

    const email = ctx.user.email || ctx.profile?.email || '';
    const name = String(ctx.profile?.full_name || '').trim() || email.split('@')[0] || 'My business';
    const { data: created } = await supabase.from('clients').insert([{
        owner_user_id: uid, name,
        // Explicit, not left to the column default: the lookup above filters
        // on archived = false, and a row that relies on the database to fill
        // that in is a row this function cannot find again anywhere the
        // default is absent. The use-case test caught exactly that.
        archived: false,
        notes: 'Created automatically when this account signed up. Rename it to the business name.'
    }]).select().maybeSingle();
    return created || null;
}

/**
 * Which business a piece of work is for. (phase 22: mandatory)
 *
 * This used to return null when the picker said "None (just me)", and the
 * numbers showed what that meant in practice: 15 of 16 reports and all 27
 * campaigns on the live database were filed under nothing. Work with no
 * client has no timeline, no history, no client who can ever see it, and no
 * way to be found again except by the person who ran it, from memory.
 *
 * So: every run is for a business. A client-role account IS its business and
 * needs to say nothing; everyone else must choose one, and the server refuses
 * rather than trusting the page to have asked.
 */
async function resolveClientId(req, ctx) {
    const raw = req.body?.clientId || req.body?.client_id || req.query?.client_id || null;
    if (!raw) {
        if (ctx.profile?.role === 'client') return (await ownClientFor(ctx))?.id || null;
        const e = new Error('Choose a client first. Every run is filed under a business, and this one has nowhere to go.');
        e.statusCode = 400;
        e.code = 'client_required';
        throw e;
    }
    const c = await clientAccess(ctx.user.id, raw, 'editor');
    if (!c) { const e = new Error('You do not have edit access to that client.'); e.statusCode = 403; throw e; }
    return c.id;
}

/** Scope a reports query: by client (membership) when asked, else by user. */
/**
 * Resolves whose rows the caller may list and returns a function to apply to
 * a query builder — deliberately NOT the builder itself. PostgREST builders
 * are thenables, so returning one from an async function makes `await`
 * execute the query: the caller received `{ data, error }` instead of a
 * builder, and every vault list died with "q.order is not a function".
 */
async function applyReportScope(req, ctx) {
    const cid = req.query?.client_id;
    if (cid) {
        const c = await clientAccess(ctx.user.id, cid, 'viewer');
        if (!c) { const e = new Error('No access to that client.'); e.statusCode = 403; throw e; }
        return q => q.eq('client_id', c.id);
    }
    return q => q.eq('user_id', ctx.user.id);
}

/** May this user open this single report row? */
async function canReadReport(ctx, row) {
    if (!row) return false;
    if (row.user_id === ctx.user.id) return true;
    if (ctx.profile?.role === 'admin') return true;
    if (row.client_id && await clientAccess(ctx.user.id, row.client_id, 'viewer')) return true;
    return false;
}

function cleanClientBody(b = {}) {
    const s = v => (v === undefined || v === null) ? undefined : String(v).trim().slice(0, 300) || null;
    return {
        name: s(b.name), brand: s(b.brand),
        ig_handle: b.ig_handle !== undefined ? (s(b.ig_handle) || '').replace('@', '').toLowerCase() || null : undefined,
        fb_page: s(b.fb_page), fb_page_id: s(b.fb_page_id),
        niche: s(b.niche), location: s(b.location),
        notes: b.notes !== undefined ? String(b.notes || '').slice(0, 4000) || null : undefined,
        archived: typeof b.archived === 'boolean' ? b.archived : undefined
    };
}

app.get('/api/clients', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const includeArchived = String(req.query.archived || '') === '1';
        const { data: owned } = await supabase.from('clients').select('*')
            .eq('owner_user_id', ctx.user.id).order('created_at', { ascending: false });
        const { data: mem } = await supabase.from('client_members').select('client_id, role').eq('user_id', ctx.user.id);
        let shared = [];
        if (mem?.length) {
            const { data } = await supabase.from('clients').select('*').in('id', mem.map(m => m.client_id));
            shared = (data || []).map(c => ({ ...c, access: (mem.find(m => m.client_id === c.id) || {}).role || 'viewer' }));
        }
        let rows = [...(owned || []).map(c => ({ ...c, access: 'owner' })), ...shared];

        // An admin's list is every client, not just theirs: assigning work
        // means seeing the clients other people created. Ownership and
        // membership still label the rows they apply to.
        if (ctx.profile.role === 'admin') {
            const have = new Set(rows.map(r => r.id));
            const { data: all } = await supabase.from('clients').select('*').order('created_at', { ascending: false });
            for (const c of (all || [])) if (!have.has(c.id)) rows.push({ ...c, access: 'admin' });
        }
        if (!includeArchived) rows = rows.filter(c => !c.archived);
        rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

        // Counts per client so the list is a real overview rather than names.
        const ids = rows.map(r => r.id);
        const counts = {};
        if (ids.length) {
            const { data: reps } = await supabase.from('reports').select('client_id, report_type').in('client_id', ids);
            for (const r of (reps || [])) {
                counts[r.client_id] = counts[r.client_id] || { total: 0, byType: {} };
                counts[r.client_id].total += 1;
                counts[r.client_id].byType[r.report_type] = (counts[r.client_id].byType[r.report_type] || 0) + 1;
            }
        }
        // Meta per client, so "is this one connected?" is answered on the row
        // rather than by opening each client and finding the tab.
        const meta = {};
        if (ids.length) {
            const { data: conns } = await supabase.from('meta_connections')
                .select('client_id, status, page_name, ig_username').in('client_id', ids);
            for (const k of (conns || [])) {
                const m = meta[k.client_id] = meta[k.client_id] || { connected: false, pages: 0, active: 0, names: [] };
                m.pages += 1;
                if (k.status === 'active') { m.active += 1; m.connected = true; }
                if (k.page_name && m.names.length < 3) m.names.push(k.page_name);
            }
        }
        res.json({ clients: rows.map(c => ({
            ...c,
            reports: counts[c.id] || { total: 0, byType: {} },
            meta: meta[c.id] || { connected: false, pages: 0, active: 0, names: [] }
        })) });
    } catch (err) { sendErr(res, err); }
});

app.post('/api/clients', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const body = cleanClientBody(req.body);
        if (!body.name) return res.status(400).json({ error: 'Client name is required.' });
        const row = { owner_user_id: ctx.user.id };
        for (const [k, v] of Object.entries(body)) if (v !== undefined) row[k] = v;
        const { data, error } = await supabase.from('clients').insert([row]).select().maybeSingle();
        if (error) throw error;
        res.status(201).json({ client: { ...data, access: 'owner' } });
    } catch (err) { sendErr(res, err); }
});

app.patch('/api/clients/:id', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const c = await clientAccess(ctx.user.id, req.params.id, 'editor');
        if (!c) return res.status(404).json({ error: 'Client not found.' });
        const body = cleanClientBody(req.body);
        const patch = { updated_at: new Date().toISOString() };
        for (const [k, v] of Object.entries(body)) if (v !== undefined) patch[k] = v;
        if (patch.name === null) delete patch.name;
        const { data, error } = await supabase.from('clients').update(patch).eq('id', c.id).select().maybeSingle();
        if (error) throw error;
        res.json({ client: { ...data, access: c.access } });
    } catch (err) { sendErr(res, err); }
});

app.delete('/api/clients/:id', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const c = await clientAccess(ctx.user.id, req.params.id, 'owner');
        if (!c) return res.status(404).json({ error: 'Client not found, or you are not its owner.' });
        // Reports are kept (client_id set null by the FK). Only the workspace goes.
        const { error } = await supabase.from('clients').delete().eq('id', c.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) { sendErr(res, err); }
});

app.get('/api/clients/:id', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const c = await clientAccess(ctx.user.id, req.params.id, 'viewer');
        if (!c) return res.status(404).json({ error: 'Client not found.' });
        const { data: members } = await supabase.from('client_members').select('user_id, role, created_at').eq('client_id', c.id);
        const ids = [c.owner_user_id, ...(members || []).map(m => m.user_id)];
        const { data: users } = await supabase.from('app_users').select('id, email').in('id', ids);
        const email = id => (users || []).find(u => u.id === id)?.email || id;
        const { data: conns } = await supabase.from('meta_connections')
            .select('id, page_id, page_name, ig_user_id, ig_username, status, last_sync_at, last_error, token_expires_at, scopes')
            .eq('client_id', c.id);
        res.json({
            client: c,
            owner: { id: c.owner_user_id, email: email(c.owner_user_id) },
            members: (members || []).map(m => ({ ...m, email: email(m.user_id) })),
            metaConnections: conns || []
        });
    } catch (err) { sendErr(res, err); }
});

app.get('/api/clients/:id/timeline', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const c = await clientAccess(ctx.user.id, req.params.id, 'viewer');
        if (!c) return res.status(404).json({ error: 'Client not found.' });
        const { data: reports } = await supabase.from('reports')
            .select('id, user_id, platform, report_type, target_handle, competitor_handles, fb_group_names, fb_page_names, audit_mode, grade, score, engagement_rate, posts_analyzed, snapshot_date, created_at, ai_summary, credits_estimate, source_report_ids')
            .eq('client_id', c.id).order('created_at', { ascending: false }).limit(300);
        const { data: jobs } = await supabase.from('jobs')
            .select('id, type, engine, status, progress, credits_estimate, created_at, finished_at, error, result_report_id')
            .eq('client_id', c.id).order('created_at', { ascending: false }).limit(50);
        const { data: sugg } = await supabase.from('fb_suggestions')
            .select('id, group_name, format, predicted_band, posted_at, verified_band, created_at')
            .eq('client_id', c.id).order('created_at', { ascending: false }).limit(50);
        res.json({ client: c, reports: reports || [], jobs: jobs || [], suggestions: sugg || [] });
    } catch (err) { sendErr(res, err); }
});

app.post('/api/clients/:id/members', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const c = await clientAccess(ctx.user.id, req.params.id, 'owner');
        if (!c) return res.status(404).json({ error: 'Client not found, or you are not its owner.' });
        const email = String(req.body.email || '').trim().toLowerCase();
        const role = req.body.role === 'viewer' ? 'viewer' : 'editor';
        if (!email) return res.status(400).json({ error: 'Email is required.' });
        const { data: u } = await supabase.from('app_users').select('id, email').eq('email', email).maybeSingle();
        if (!u) return res.status(404).json({ error: 'No EdgeLead account with that email. They need to sign up first.' });
        if (u.id === c.owner_user_id) return res.status(400).json({ error: 'That is the owner.' });
        const { error } = await supabase.from('client_members')
            .upsert([{ client_id: c.id, user_id: u.id, role, added_by: ctx.user.id }], { onConflict: 'client_id,user_id' });
        if (error) throw error;

        // A client-role account already owns a business record of its own,
        // made at signup. If an agency now files them under the agency's
        // record and their own is still empty, keeping both means one
        // business in two places. The empty one is archived — never deleted —
        // so their runs land where the agency is already working.
        let absorbed = null;
        if (role === 'editor' && await userRole(u.id) === 'client') {
            const { data: own } = await supabase.from('clients').select('id, name')
                .eq('owner_user_id', u.id).eq('archived', false);
            for (const o of (own || [])) {
                const [{ count: r }, { count: j }, { count: m }] = await Promise.all([
                    supabase.from('reports').select('id', { count: 'exact', head: true }).eq('client_id', o.id),
                    supabase.from('jobs').select('id', { count: 'exact', head: true }).eq('client_id', o.id),
                    supabase.from('meta_connections').select('id', { count: 'exact', head: true }).eq('client_id', o.id)
                ]);
                if (!(r || 0) && !(j || 0) && !(m || 0)) {
                    await supabase.from('clients').update({ archived: true }).eq('id', o.id);
                    absorbed = o.id;
                    logger.info('client_own_record_absorbed', { userId: u.id, into: c.id, archived: o.id });
                }
            }
        }
        res.json({ success: true, member: { user_id: u.id, email: u.email, role }, absorbed });
    } catch (err) { sendErr(res, err); }
});

app.delete('/api/clients/:id/members/:userId', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const c = await clientAccess(ctx.user.id, req.params.id, 'owner');
        const self = req.params.userId === ctx.user.id;
        if (!c && !self) return res.status(404).json({ error: 'Client not found, or you are not its owner.' });
        const { error } = await supabase.from('client_members').delete()
            .eq('client_id', req.params.id).eq('user_id', req.params.userId);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) { sendErr(res, err); }
});

// ===========================================================================
// PHASE 9 :: GEMINI KEYS (personal + shared pool)
// ===========================================================================

app.get('/api/gemini-keys', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const isAdmin = ctx.profile.role === 'admin';
        let q = supabase.from('gemini_keys')
            .select('id, owner_user_id, label, status, cooldown_until, fail_count, calls_total, last_used_at, last_error, created_at')
            .order('created_at', { ascending: false });
        q = isAdmin ? q : q.eq('owner_user_id', ctx.user.id);
        const { data, error } = await q;
        if (error) throw error;
        res.json({
            keys: (data || []).map(k => ({ ...k, scope: k.owner_user_id ? 'personal' : 'pool' })),
            envConfigured: !!GEMINI_API_KEY,
            envKey: !!GEMINI_API_KEY,
            poolKeys: (data || []).filter(k => !k.owner_user_id && k.status !== 'invalid').length,
            discovered: _geminiDiscovered.models.slice(0, 3),
            model: GEMINI_MODEL,
            fallbacks: GEMINI_MODEL_FALLBACKS,
            deadModels: [..._geminiDeadModels.keys()]
        });
    } catch (err) { sendErr(res, err); }
});

app.post('/api/gemini-keys', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const key = String(req.body.key || req.body.token || '').trim();
        if (!/^AIza[0-9A-Za-z_-]{20,}$/.test(key)) return res.status(400).json({ error: 'That does not look like a Gemini API key (they start with AIza).' });
        const isGlobal = !!req.body.global && ctx.profile.role === 'admin';

        // Verify with one tiny call before storing anything.
        const probe = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1`, { headers: { 'x-goog-api-key': key } });
        if (probe.status === 400 || probe.status === 403) return res.status(400).json({ error: 'Google rejected that key.' });

        const row = {
            owner_user_id: isGlobal ? null : ctx.user.id,
            label: String(req.body.label || '').slice(0, 80) || (isGlobal ? 'pool key' : 'my key'),
            key_enc: encryptSecret(key),
            key_hash: tokenHash(key),
            status: 'active'
        };
        const { data, error } = await supabase.from('gemini_keys').insert([row]).select('id, owner_user_id, label, status, created_at').maybeSingle();
        if (error) {
            if (/duplicate|unique/i.test(error.message)) return res.status(409).json({ error: 'That key is already stored.' });
            throw error;
        }
        invalidateGeminiPool(); await loadGeminiPool(true);
        res.status(201).json({ key: { ...data, scope: data.owner_user_id ? 'personal' : 'pool' } });
    } catch (err) { sendErr(res, err); }
});

app.post('/api/gemini-keys/:id/reset', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        let q = supabase.from('gemini_keys').update({ status: 'active', cooldown_until: null, fail_count: 0, last_error: null }).eq('id', req.params.id);
        if (ctx.profile.role !== 'admin') q = q.eq('owner_user_id', ctx.user.id);
        const { error } = await q;
        if (error) throw error;
        invalidateGeminiPool();
        res.json({ success: true });
    } catch (err) { sendErr(res, err); }
});

app.delete('/api/gemini-keys/:id', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        let q = supabase.from('gemini_keys').delete().eq('id', req.params.id);
        if (ctx.profile.role !== 'admin') q = q.eq('owner_user_id', ctx.user.id);
        const { error } = await q;
        if (error) throw error;
        invalidateGeminiPool(); await loadGeminiPool(true);
        res.json({ success: true });
    } catch (err) { sendErr(res, err); }
});

// ===========================================================================
// PHASE 9 :: META OWNER DATA  (OAuth + Graph API, read-only scopes)
//
// Scraping shows what the public sees. This shows what only the owner sees:
// reach, saves, shares, views, demographics. The two are never blended: every
// number carries a source tag, and competitors are always 'scraped'.
// ===========================================================================

const META_APP_ID        = (process.env.META_APP_ID || '').trim();
const META_APP_SECRET    = (process.env.META_APP_SECRET || '').trim();
const META_GRAPH_VERSION = (process.env.META_GRAPH_VERSION || 'v24.0').trim();
const META_SCOPES        = (process.env.META_SCOPES ||
    'pages_show_list,pages_read_engagement,read_insights,instagram_basic,instagram_manage_insights,business_management')
    .split(',').map(s => s.trim()).filter(Boolean);
const FRONTEND_URL       = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');
const BACKEND_URL_ENV    = (process.env.BACKEND_URL || '').replace(/\/+$/, '');
const META_MEDIA_LIMIT   = parseInt(process.env.META_MEDIA_LIMIT || '50', 10);

function metaConfigured() { return !!(META_APP_ID && META_APP_SECRET); }
function backendBase(req) {
    if (BACKEND_URL_ENV) return BACKEND_URL_ENV;
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
    return `${proto}://${req.get('host')}`;
}
function metaRedirectUri(req) { return `${backendBase(req)}/api/meta/oauth/callback`; }

/** GET against the Graph API. Throws { code, type, message, subcode } on API error. */
async function graphGet(path, params = {}, token) {
    const u = new URL(`https://graph.facebook.com/${META_GRAPH_VERSION}/${String(path).replace(/^\/+/, '')}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    if (token) u.searchParams.set('access_token', token);
    const r = await fetch(u.toString());
    let body = null;
    try { body = await r.json(); } catch (_) { body = null; }
    if (!r.ok || body?.error) {
        const e = new Error(body?.error?.message || `Graph ${r.status}`);
        e.graph = body?.error || { code: r.status };
        e.statusCode = r.status === 401 || body?.error?.code === 190 ? 401 : 502;
        throw e;
    }
    return body;
}

/**
 * Insights with metric-name resilience. Graph renames and retires metrics per
 * version. Ask for the whole list; if it complains, drop the metric it names
 * and try again; finally probe one at a time. Returns { values, unsupported }.
 */
async function graphInsights(path, metrics, params, token) {
    const values = {};
    const unsupported = [];
    let list = metrics.slice();
    for (let i = 0; i < 6 && list.length; i++) {
        try {
            const out = await graphGet(`${path}/insights`, { ...params, metric: list.join(',') }, token);
            for (const m of (out.data || [])) {
                const tv = m.total_value?.value;
                values[m.name] = tv !== undefined ? tv : (m.values || []).map(v => ({ end_time: v.end_time, value: v.value }));
            }
            return { values, unsupported };
        } catch (err) {
            const msg = String(err.message || '');
            const named = list.find(m => new RegExp(`\\b${m}\\b`).test(msg));
            if (named) { unsupported.push(named); list = list.filter(m => m !== named); continue; }
            if (err.statusCode === 401) throw err;
            break;
        }
    }
    // Probe individually for whatever is left.
    for (const m of list) {
        try {
            const out = await graphGet(`${path}/insights`, { ...params, metric: m }, token);
            for (const d of (out.data || [])) {
                const tv = d.total_value?.value;
                values[d.name] = tv !== undefined ? tv : (d.values || []).map(v => ({ end_time: v.end_time, value: v.value }));
            }
        } catch (err) { if (err.statusCode === 401) throw err; unsupported.push(m); }
    }
    return { values, unsupported };
}

function igShortcodeFromPermalink(p) {
    const m = String(p || '').match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
}

app.get('/api/meta/status', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        res.json({ configured: metaConfigured(), scopes: META_SCOPES, graphVersion: META_GRAPH_VERSION, redirectUri: metaRedirectUri(req) });
    } catch (err) { sendErr(res, err); }
});

app.get('/api/meta/oauth/start', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'meta_owned'); if (!ctx) return;
        if (!metaConfigured()) return res.status(503).json({ error: 'META_APP_ID / META_APP_SECRET are not set on the server.' });
        const clientId = req.query.client_id ? (await clientAccess(ctx.user.id, req.query.client_id, 'editor'))?.id || null : null;
        if (req.query.client_id && !clientId) return res.status(403).json({ error: 'No edit access to that client.' });

        const state = crypto.randomBytes(24).toString('hex');
        const { error } = await supabase.from('meta_oauth_states').insert([{
            state, user_id: ctx.user.id, client_id: clientId,
            expires_at: new Date(Date.now() + 15 * 60000).toISOString()
        }]);
        if (error) throw error;

        const u = new URL(`https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`);
        u.searchParams.set('client_id', META_APP_ID);
        u.searchParams.set('redirect_uri', metaRedirectUri(req));
        u.searchParams.set('state', state);
        u.searchParams.set('scope', META_SCOPES.join(','));
        u.searchParams.set('response_type', 'code');
        res.json({ url: u.toString(), redirectUri: metaRedirectUri(req) });
    } catch (err) { sendErr(res, err); }
});

/** Public: Facebook redirects the browser here. State row is the auth. */
app.get('/api/meta/oauth/callback', async (req, res) => {
    const back = (q) => {
        const base = FRONTEND_URL ? `${FRONTEND_URL}/clients.html` : '/clients.html';
        res.redirect(`${base}?${new URLSearchParams(q).toString()}`);
    };
    try {
        const { code, state, error: fbErr, error_description } = req.query;
        if (fbErr) return back({ meta: 'error', message: String(error_description || fbErr).slice(0, 200) });
        if (!code || !state) return back({ meta: 'error', message: 'Missing code or state.' });

        const { data: st } = await supabase.from('meta_oauth_states').select('*').eq('state', String(state)).maybeSingle();
        await supabase.from('meta_oauth_states').delete().eq('state', String(state));
        if (!st || new Date(st.expires_at).getTime() < Date.now()) return back({ meta: 'error', message: 'Login link expired. Try again.' });

        const shortTok = await graphGet('oauth/access_token', {
            client_id: META_APP_ID, client_secret: META_APP_SECRET,
            redirect_uri: metaRedirectUri(req), code: String(code)
        });
        const longTok = await graphGet('oauth/access_token', {
            grant_type: 'fb_exchange_token', client_id: META_APP_ID,
            client_secret: META_APP_SECRET, fb_exchange_token: shortTok.access_token
        });
        const userToken = longTok.access_token;
        const expiresAt = longTok.expires_in ? new Date(Date.now() + longTok.expires_in * 1000).toISOString() : null;

        let granted = [], fbUserId = null;
        try {
            const dbg = await graphGet('debug_token', { input_token: userToken, access_token: `${META_APP_ID}|${META_APP_SECRET}` });
            granted = dbg?.data?.scopes || [];
            // The app-scoped user id. A Data Deletion Request from Meta names
            // the person by this and nothing else; without it the request
            // could not be matched to a single row we hold.
            fbUserId = dbg?.data?.user_id ? String(dbg.data.user_id) : null;
        } catch (_) {}

        const pages = await graphGet('me/accounts', {
            fields: 'id,name,access_token,instagram_business_account{id,username}', limit: 100
        }, userToken);

        let saved = 0;
        for (const p of (pages.data || [])) {
            const row = {
                user_id: st.user_id, client_id: st.client_id,
                page_id: String(p.id), page_name: p.name || null,
                page_token_enc: encryptSecret(p.access_token),
                ig_user_id: p.instagram_business_account?.id || null,
                ig_username: p.instagram_business_account?.username || null,
                user_token_enc: encryptSecret(userToken),
                token_expires_at: expiresAt, scopes: granted,
                fb_user_id: fbUserId,
                status: 'active', last_error: null
            };
            const { error } = await supabase.from('meta_connections').upsert([row], { onConflict: 'user_id,page_id' });
            if (!error) saved += 1;
        }
        // Naming both causes, because they look identical from here and the
        // second one is the usual answer while the Meta app is in Development
        // Mode: the login succeeds, Meta returns an empty Page list, and the
        // person reads "select a Page" and goes hunting through a dialog that
        // never offered them one.
        if (!saved) return back({ meta: 'error', message: 'Login worked but Meta returned no Pages. Either no Page was ticked in the dialog, or this Facebook account has no role on the EdgeLead Meta app yet — while the app is in Development Mode only Admins, Developers and Testers get Pages back.' });
        back({ meta: 'ok', pages: saved, client: st.client_id || '' });
    } catch (err) {
        logger.error('meta_oauth_callback', { message: err.message });
        back({ meta: 'error', message: String(err.message || 'OAuth failed').slice(0, 200) });
    }
});

// ===========================================================================
// META DATA DELETION (phase 24)
//
// When a person removes EdgeLead from their Facebook settings, Meta POSTs a
// signed_request here. The signature is HMAC-SHA256 over the payload with the
// app secret, so only Meta can produce it. The payload names the person by
// app-scoped user id; everything held under that id goes, and the response
// gives Meta a URL and a code the person can use to see that it went.
//
// This is a platform requirement for the app to be used by anyone outside
// its own testers. It is also simply right: the data is theirs.
// ===========================================================================

/** Verify and decode a Meta signed_request. Returns the payload, or null. */
function metaParseSignedRequest(signedRequest, secret) {
    const parts = String(signedRequest || '').split('.');
    if (parts.length !== 2 || !secret) return null;
    const b64 = v => Buffer.from(String(v).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const sig = b64(parts[0]);
    const expected = crypto.createHmac('sha256', secret).update(parts[1]).digest();
    if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;
    try {
        const payload = JSON.parse(b64(parts[1]).toString('utf8'));
        return payload && payload.algorithm && String(payload.algorithm).toUpperCase() === 'HMAC-SHA256' ? payload : null;
    } catch { return null; }
}

/** Everything held for one Facebook user, gone. Returns what was removed. */
async function metaDeleteUserData(fbUserId) {
    const { data: conns } = await supabase.from('meta_connections').select('id').eq('fb_user_id', String(fbUserId));
    const ids = (conns || []).map(c => c.id);
    let reports = 0;
    if (ids.length) {
        // Owner-side reports are built from this person's insights and are
        // theirs to withdraw. Scraped reports are not touched: they were
        // built from public data and name no Facebook user.
        const { count } = await supabase.from('reports').select('id', { count: 'exact', head: true })
            .eq('platform', 'meta').in('meta_connection_id', ids);
        reports = count || 0;
        await supabase.from('reports').delete().eq('platform', 'meta').in('meta_connection_id', ids);
        // media and snapshots cascade from the connection
        await supabase.from('meta_connections').delete().in('id', ids);
    }
    return { connections: ids.length, reports };
}

app.post('/api/meta/data-deletion', publicLimit, async (req, res) => {
    try {
        const payload = metaParseSignedRequest(req.body?.signed_request, META_APP_SECRET);
        if (!payload || !payload.user_id) return res.status(400).json({ error: 'Invalid signed request.' });

        const removed = await metaDeleteUserData(payload.user_id);
        const code = crypto.randomBytes(12).toString('hex');
        await supabase.from('meta_deletion_requests').insert([{
            code, fb_user_id: String(payload.user_id),
            connections: removed.connections, reports: removed.reports
        }]);
        logger.info('meta_data_deletion', { fbUserId: String(payload.user_id), ...removed });

        // Meta expects exactly this shape.
        const base = FRONTEND_URL || `${req.protocol}://${req.get('host')}`;
        res.json({ url: `${base}/data-deletion.html?code=${code}`, confirmation_code: code });
    } catch (err) { sendErr(res, err); }
});

/** Public: the status page looks a confirmation code up here. */
app.get('/api/public/meta/deletion/:code', publicLimit, async (req, res) => {
    try {
        const code = String(req.params.code || '');
        if (!/^[a-f0-9]{24}$/.test(code)) return res.status(404).json({ error: 'No such request.' });
        const { data } = await supabase.from('meta_deletion_requests')
            .select('code, connections, reports, created_at').eq('code', code).maybeSingle();
        if (!data) return res.status(404).json({ error: 'No such request.' });
        res.json({ status: 'complete', ...data });
    } catch (err) { sendErr(res, err); }
});

app.get('/api/meta/connections', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        let q = supabase.from('meta_connections')
            .select('id, user_id, client_id, page_id, page_name, ig_user_id, ig_username, token_expires_at, scopes, status, last_sync_at, last_error, created_at')
            .order('created_at', { ascending: false });
        if (req.query.client_id) {
            const c = await clientAccess(ctx.user.id, req.query.client_id, 'viewer');
            if (!c) return res.status(403).json({ error: 'No access to that client.' });
            q = q.eq('client_id', c.id);
        } else {
            q = q.eq('user_id', ctx.user.id);
        }
        const { data, error } = await q;
        if (error) throw error;
        res.json({ connections: data || [], configured: metaConfigured() });
    } catch (err) { sendErr(res, err); }
});

app.patch('/api/meta/connections/:id', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const { data: conn } = await supabase.from('meta_connections').select('id, user_id').eq('id', req.params.id).maybeSingle();
        if (!conn || conn.user_id !== ctx.user.id) return res.status(404).json({ error: 'Connection not found.' });
        const clientId = req.body.clientId === null ? null : (await clientAccess(ctx.user.id, req.body.clientId, 'editor'))?.id;
        if (req.body.clientId && !clientId) return res.status(403).json({ error: 'No edit access to that client.' });
        const { error } = await supabase.from('meta_connections').update({ client_id: clientId }).eq('id', conn.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) { sendErr(res, err); }
});

/**
 * Turn a Page you manage into a client, in one step. (phase 19)
 *
 * This is how an agency actually onboards: the employee is already a manager
 * on the client's Business Suite, so connecting Meta once hands back every
 * Page they look after. Before this, that list was a dead end — you had to go
 * to the Clients page, retype the business name, the Page and the Instagram
 * handle that Meta had just told us, save, come back, and assign. Four chances
 * to typo a handle that everything downstream keys on.
 *
 * The Page is the source of truth for name, Page id and linked Instagram, so
 * none of it is retyped. Niche and location are the only things Meta cannot
 * tell us, so they are the only things asked for.
 */
app.post('/api/meta/connections/:id/onboard', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const { data: conn } = await supabase.from('meta_connections')
            .select('id, user_id, client_id, page_id, page_name, ig_username').eq('id', req.params.id).maybeSingle();
        if (!conn || conn.user_id !== ctx.user.id) return res.status(404).json({ error: 'Connection not found.' });
        if (conn.client_id) return res.status(409).json({ error: 'This Page is already filed under a client.' });

        const body = cleanClientBody(req.body);
        const row = {
            owner_user_id: ctx.user.id,
            name: body.name || conn.page_name || `Page ${conn.page_id}`,
            fb_page: body.fb_page || conn.page_name || null,
            fb_page_id: conn.page_id,
            ig_handle: body.ig_handle !== undefined ? body.ig_handle : (conn.ig_username || null),
            niche: body.niche ?? null,
            location: body.location ?? null,
            notes: body.notes ?? null
        };
        const { data: client, error } = await supabase.from('clients').insert([row]).select().maybeSingle();
        if (error) throw error;

        // If filing the connection fails, the client row would be left behind
        // looking connected when it is not. Rolling it back is better than a
        // half-onboarded client nobody can explain.
        const { error: linkErr } = await supabase.from('meta_connections')
            .update({ client_id: client.id }).eq('id', conn.id);
        if (linkErr) {
            await supabase.from('clients').delete().eq('id', client.id);
            throw linkErr;
        }

        logger.info('meta_client_onboarded', { userId: ctx.user.id, clientId: client.id, pageId: conn.page_id });
        res.status(201).json({ client: { ...client, access: 'owner' }, connectionId: conn.id });
    } catch (err) { sendErr(res, err); }
});

/**
 * Every Page this employee manages, with the client each is filed under and
 * whether it still needs one. The Clients page asks for exactly this after an
 * OAuth round trip, and building it from /api/meta/connections plus
 * /api/clients meant two calls and a join in the browser.
 */
app.get('/api/meta/inbox', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const [{ data: conns }, { data: owned }, { data: mem }] = await Promise.all([
            supabase.from('meta_connections')
                .select('id, client_id, page_id, page_name, ig_username, status, last_sync_at, token_expires_at')
                .eq('user_id', ctx.user.id).order('created_at', { ascending: false }),
            supabase.from('clients').select('id, name, archived').eq('owner_user_id', ctx.user.id),
            supabase.from('client_members').select('client_id').eq('user_id', ctx.user.id)
        ]);
        const memberIds = (mem || []).map(m => m.client_id);
        let shared = [];
        if (memberIds.length) {
            const { data } = await supabase.from('clients').select('id, name, archived').in('id', memberIds);
            shared = data || [];
        }
        const clients = [...(owned || []), ...shared].filter(c => !c.archived);
        const byId = Object.fromEntries(clients.map(c => [c.id, c.name]));

        const pages = (conns || []).map(c => ({
            connectionId: c.id, pageId: c.page_id, pageName: c.page_name,
            igUsername: c.ig_username, status: c.status,
            lastSyncAt: c.last_sync_at, tokenExpiresAt: c.token_expires_at,
            clientId: c.client_id, clientName: c.client_id ? (byId[c.client_id] || 'a client you cannot see') : null,
            needsClient: !c.client_id
        }));
        res.json({
            pages, clients: clients.map(c => ({ id: c.id, name: c.name })),
            unfiled: pages.filter(p => p.needsClient).length,
            configured: metaConfigured()
        });
    } catch (err) { sendErr(res, err); }
});

app.delete('/api/meta/connections/:id', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const { error } = await supabase.from('meta_connections').delete().eq('id', req.params.id).eq('user_id', ctx.user.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) { sendErr(res, err); }
});

async function metaLoadConnection(userId, id) {
    const { data: conn } = await supabase.from('meta_connections').select('*').eq('id', id).maybeSingle();
    if (!conn) return null;
    if (conn.user_id !== userId) {
        // A member of the client may sync on the owner's behalf.
        if (!conn.client_id || !(await clientAccess(userId, conn.client_id, 'editor'))) return null;
    }
    return conn;
}

app.post('/api/meta/sync', spendLimit, async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'meta_owned'); if (!ctx) return;
        await assertJobSlot(ctx.user.id);
        const conn = await metaLoadConnection(ctx.user.id, req.body.connectionId);
        if (!conn) return res.status(404).json({ error: 'Connection not found.' });
        const days = Math.min(Math.max(parseInt(req.body.days || '28', 10) || 28, 7), 90);
        const job = await createJob(ctx.user.id, 'meta_insights', 'meta_owned',
            { connectionId: conn.id, days, clientId: conn.client_id || null, brief: String(req.body.brief || '').slice(0, 600) || null }, 0);
        runJob(job.id, JOB_WORKERS['meta_insights'](ctx.user.id, job.input, job.id));
        res.status(202).json({ success: true, jobId: job.id, estimatedUsd: 0 });
    } catch (err) { sendErr(res, err); }
});

function seriesSum(arr) { return Array.isArray(arr) ? arr.reduce((s, v) => s + (Number(v.value) || 0), 0) : Number(arr) || 0; }
function seriesLast(arr) { return Array.isArray(arr) && arr.length ? Number(arr[arr.length - 1].value) || 0 : Number(arr) || 0; }

registerWorker('meta_insights', (userId, input, jobId) => async (progress, ck) => {
    const conn = await supabase.from('meta_connections').select('*').eq('id', input.connectionId).maybeSingle().then(r => r.data);
    if (!conn) throw new Error('Connection no longer exists.');
    const pageToken = decryptSecret(conn.page_token_enc);
    const days = input.days || 28;
    const until = Math.floor(Date.now() / 1000);
    const since = until - days * 86400;
    const today = new Date().toISOString().slice(0, 10);
    const gaps = [];
    const warnings = [];

    const fail = async (err) => {
        await supabase.from('meta_connections').update({
            status: err.statusCode === 401 ? 'expired' : 'error',
            last_error: String(err.message || '').slice(0, 300)
        }).eq('id', conn.id);
        throw err;
    };

    try {
        // --- Page account -------------------------------------------------
        await progress(5, `Reading Page insights for ${conn.page_name || conn.page_id}`);
        let page = ck.get('page');
        if (!page) {
            const meta = await graphGet(conn.page_id, { fields: 'id,name,fan_count,followers_count,category,link,about' }, pageToken);
            const ins = await graphInsights(conn.page_id,
                ['page_impressions_unique', 'page_post_engagements', 'page_views_total', 'page_fan_adds_unique', 'page_daily_follows_unique', 'page_media_view'],
                { period: 'day', since, until }, pageToken);
            gaps.push(...ins.unsupported.map(m => `page:${m}`));
            page = {
                id: meta.id, name: meta.name, fans: meta.fan_count ?? null, followers: meta.followers_count ?? null,
                category: meta.category || null, link: meta.link || null,
                series: ins.values,
                totals: Object.fromEntries(Object.entries(ins.values).map(([k, v]) => [k, seriesSum(v)]))
            };
            await supabase.from('meta_snapshots').upsert([{
                connection_id: conn.id, user_id: conn.user_id, snapshot_date: today, level: 'page',
                metrics: { fans: page.fans, followers: page.followers, totals: page.totals, days }
            }], { onConflict: 'connection_id,level,snapshot_date' });
            await ck.done('page', page);
        }

        // --- Page posts ----------------------------------------------------
        await progress(25, 'Reading Page posts');
        let pagePosts = ck.get('page_posts');
        if (!pagePosts) {
            pagePosts = [];
            const out = await graphGet(`${conn.page_id}/posts`, {
                fields: 'id,message,created_time,permalink_url,shares,reactions.summary(total_count),comments.summary(total_count),attachments{media_type}',
                since, until, limit: META_MEDIA_LIMIT
            }, pageToken);
            const items = out.data || [];
            const postMetrics = ['post_impressions_unique', 'post_engaged_users', 'post_clicks', 'post_reactions_by_type_total'];
            let unsupportedPost = null;
            for (let i = 0; i < items.length; i++) {
                const p = items[i];
                let insights = {}, unsupported = [];
                if (!unsupportedPost) {
                    const r = await graphInsights(p.id, postMetrics, {}, pageToken);
                    insights = r.values; unsupported = r.unsupported;
                    if (unsupported.length === postMetrics.length) unsupportedPost = unsupported;
                }
                const row = {
                    connection_id: conn.id, user_id: conn.user_id, platform: 'facebook',
                    media_id: String(p.id), shortcode: null,
                    media_type: p.attachments?.data?.[0]?.media_type || null, product_type: 'page_post',
                    caption: (p.message || '').slice(0, 4000) || null, permalink: p.permalink_url || null,
                    posted_at: p.created_time || null,
                    like_count: p.reactions?.summary?.total_count ?? null,
                    comments_count: p.comments?.summary?.total_count ?? null,
                    insights: { ...Object.fromEntries(Object.entries(insights).map(([k, v]) => [k, Array.isArray(v) ? seriesLast(v) : v])), shares: p.shares?.count ?? null, source: 'insights' }
                };
                pagePosts.push(row);
                if (i % 10 === 9) await progress(25 + Math.round(15 * (i / items.length)), `Page posts ${i + 1}/${items.length}`);
            }
            if (unsupportedPost) gaps.push(...unsupportedPost.map(m => `post:${m}`));
            if (pagePosts.length) await supabase.from('meta_media').upsert(pagePosts, { onConflict: 'connection_id,media_id' });
            await ck.done('page_posts', pagePosts);
        }

        // --- Instagram account --------------------------------------------
        let ig = ck.get('ig');
        let igMedia = ck.get('ig_media');
        if (conn.ig_user_id) {
            await progress(45, `Reading Instagram insights for @${conn.ig_username || conn.ig_user_id}`);
            if (!ig) {
                const meta = await graphGet(conn.ig_user_id, { fields: 'id,username,name,followers_count,follows_count,media_count,biography,website' }, pageToken);
                const day = await graphInsights(conn.ig_user_id,
                    ['reach', 'views', 'accounts_engaged', 'total_interactions', 'profile_views', 'website_clicks', 'follower_count'],
                    { period: 'day', metric_type: 'total_value', since, until }, pageToken);
                gaps.push(...day.unsupported.map(m => `ig:${m}`));
                const demo = {};
                for (const bd of ['age', 'gender', 'city', 'country']) {
                    try {
                        const d = await graphGet(`${conn.ig_user_id}/insights`, { metric: 'follower_demographics', period: 'lifetime', metric_type: 'total_value', breakdown: bd }, pageToken);
                        const res0 = d.data?.[0]?.total_value?.breakdowns?.[0]?.results || [];
                        demo[bd] = res0.map(r => ({ key: (r.dimension_values || []).join(' '), value: r.value })).sort((a, b) => b.value - a.value).slice(0, 12);
                    } catch (err) { if (err.statusCode === 401) throw err; gaps.push(`ig:follower_demographics:${bd}`); }
                }
                ig = {
                    id: meta.id, username: meta.username, name: meta.name || null,
                    followers: meta.followers_count ?? null, following: meta.follows_count ?? null, mediaCount: meta.media_count ?? null,
                    bio: meta.biography || null, website: meta.website || null,
                    totals: Object.fromEntries(Object.entries(day.values).map(([k, v]) => [k, Array.isArray(v) ? seriesSum(v) : v])),
                    series: day.values, demographics: demo
                };
                await supabase.from('meta_snapshots').upsert([{
                    connection_id: conn.id, user_id: conn.user_id, snapshot_date: today, level: 'ig',
                    metrics: { followers: ig.followers, following: ig.following, mediaCount: ig.mediaCount, totals: ig.totals, days, demographics: demo }
                }], { onConflict: 'connection_id,level,snapshot_date' });
                await ck.done('ig', ig);
            }

            await progress(60, 'Reading Instagram media insights');
            if (!igMedia) {
                igMedia = [];
                const out = await graphGet(`${conn.ig_user_id}/media`, {
                    fields: 'id,caption,media_type,media_product_type,timestamp,like_count,comments_count,permalink,shortcode,thumbnail_url,media_url',
                    limit: META_MEDIA_LIMIT
                }, pageToken);
                const items = out.data || [];
                const unsupportedByKind = {};
                for (let i = 0; i < items.length; i++) {
                    const m = items[i];
                    const kind = m.media_product_type === 'REELS' ? 'reel' : (m.media_type === 'CAROUSEL_ALBUM' ? 'carousel' : 'still');
                    const want = kind === 'reel'
                        ? ['reach', 'saved', 'shares', 'views', 'total_interactions', 'ig_reels_avg_watch_time', 'likes', 'comments']
                        : ['reach', 'saved', 'shares', 'views', 'total_interactions', 'likes', 'comments'];
                    const list = want.filter(x => !(unsupportedByKind[kind] || []).includes(x));
                    let insights = {};
                    if (list.length) {
                        const r = await graphInsights(m.id, list, {}, pageToken);
                        insights = Object.fromEntries(Object.entries(r.values).map(([k, v]) => [k, Array.isArray(v) ? seriesLast(v) : v]));
                        if (r.unsupported.length) unsupportedByKind[kind] = [...new Set([...(unsupportedByKind[kind] || []), ...r.unsupported])];
                    }
                    igMedia.push({
                        connection_id: conn.id, user_id: conn.user_id, platform: 'instagram',
                        media_id: String(m.id), shortcode: m.shortcode || igShortcodeFromPermalink(m.permalink),
                        media_type: m.media_type || null, product_type: m.media_product_type || null,
                        caption: (m.caption || '').slice(0, 4000) || null, permalink: m.permalink || null,
                        posted_at: m.timestamp || null, like_count: m.like_count ?? null, comments_count: m.comments_count ?? null,
                        insights: { ...insights, kind, source: 'insights' }
                    });
                    if (i % 10 === 9) await progress(60 + Math.round(25 * (i / items.length)), `Instagram media ${i + 1}/${items.length}`);
                }
                for (const [k, v] of Object.entries(unsupportedByKind)) gaps.push(...v.map(m => `ig_media:${k}:${m}`));
                if (igMedia.length) await supabase.from('meta_media').upsert(igMedia, { onConflict: 'connection_id,media_id' });
                await ck.done('ig_media', igMedia);
            }
        } else {
            warnings.push('This Page has no Instagram professional account linked, so only Page data was read.');
        }

        // --- Summary + narrative -------------------------------------------
        await progress(88, 'Building owner view');
        const byReach = (igMedia || []).filter(m => m.insights?.reach).sort((a, b) => (b.insights.reach || 0) - (a.insights.reach || 0));
        const bySaves = (igMedia || []).filter(m => m.insights?.saved).sort((a, b) => (b.insights.saved || 0) - (a.insights.saved || 0));
        const card = m => ({ id: m.media_id, shortcode: m.shortcode, kind: m.insights?.kind, permalink: m.permalink, postedAt: m.posted_at, caption: (m.caption || '').slice(0, 160), likes: m.like_count, comments: m.comments_count, reach: m.insights?.reach ?? null, saved: m.insights?.saved ?? null, shares: m.insights?.shares ?? null, views: m.insights?.views ?? null, interactions: m.insights?.total_interactions ?? null });
        const kindAgg = {};
        for (const m of (igMedia || [])) {
            const k = m.insights?.kind || 'unknown';
            const a = kindAgg[k] = kindAgg[k] || { n: 0, reach: [], saved: [], shares: [], views: [] };
            a.n += 1;
            for (const f of ['reach', 'saved', 'shares', 'views']) if (typeof m.insights?.[f] === 'number') a[f].push(m.insights[f]);
        }
        const kinds = Object.fromEntries(Object.entries(kindAgg).map(([k, a]) => [k, { n: a.n, medianReach: median(a.reach), medianSaved: median(a.saved), medianShares: median(a.shares), medianViews: median(a.views) }]));

        const summary = {
            page: page ? { name: page.name, fans: page.fans, followers: page.followers, totals: page.totals } : null,
            ig: ig ? { username: ig.username, followers: ig.followers, following: ig.following, mediaCount: ig.mediaCount, totals: ig.totals, demographics: ig.demographics } : null,
            windowDays: days,
            media: { count: (igMedia || []).length, kinds, topByReach: byReach.slice(0, 8).map(card), topBySaves: bySaves.slice(0, 5).map(card) },
            pagePosts: { count: (pagePosts || []).length, top: (pagePosts || []).slice().sort((a, b) => (b.insights?.post_impressions_unique || 0) - (a.insights?.post_impressions_unique || 0)).slice(0, 5).map(p => ({ id: p.media_id, permalink: p.permalink, caption: (p.caption || '').slice(0, 160), impressions: p.insights?.post_impressions_unique ?? null, engaged: p.insights?.post_engaged_users ?? null, reactions: p.like_count, comments: p.comments_count, shares: p.insights?.shares ?? null })) },
            gaps: [...new Set(gaps)],
            sources: { page: 'insights', ig: 'insights', media: 'insights', competitors: 'not available via Meta — use the scraped audit' }
        };

        await progress(92, 'Generating narrative');
        let ai = null, aiStatus = { ok: false, reason: 'no_key' };
        if (geminiAvailable()) {
            const { json } = budgetedJson(summary, { maxChars: 30000, keep: ['ig', 'page', 'gaps'] });
            const prompt =
`You are a social media strategist reading OWNER-SIDE Meta Insights for one account (numbers the public cannot see: reach, saves, shares, views, demographics). Window: last ${days} days.
${input.brief ? `Owner brief: ${input.brief}\n` : ''}
Data (JSON):
${json}

Reply with ONLY a JSON object:
{
 "executive_summary": "3-4 sentences, specific numbers, no fluff",
 "what_is_working": ["...", "..."],
 "what_is_not": ["...", "..."],
 "audience": "1-2 sentences from demographics, or 'not enough data' if empty",
 "saves_and_shares": "what the saved/shared posts have in common; name the post types",
 "next_30_days": ["action 1", "action 2", "action 3", "action 4"],
 "data_gaps": "one sentence on what could not be read (see gaps) and what that means"
}`;
            const r = await geminiCallDetailed(prompt, { temperature: 0.4, tag: 'Gemini Meta', userId });
            aiStatus = { ok: r.ok, reason: r.reason, message: r.ok ? 'Generated.' : aiReasonText(r.reason), model: r.model || null };
            ai = r.ok ? r.data : null;
        } else {
            aiStatus = { ok: false, reason: 'no_key', message: aiReasonText('no_key') };
        }
        if (!aiStatus.ok) warnings.push(`Narrative unavailable: ${aiStatus.message}`);

        await progress(96, 'Saving report');
        const payload = { summary, warnings, ai, aiStatus, generatedAt: new Date().toISOString(), connection: { id: conn.id, pageName: conn.page_name, igUsername: conn.ig_username } };
        const { data: saved } = await supabase.from('reports').insert([{
            user_id: userId,
            client_id: input.clientId || null,
            meta_connection_id: conn.id,
            platform: 'meta',
            report_type: 'meta_owned',
            target_handle: conn.ig_username || conn.page_name || conn.page_id,
            posts_analyzed: (igMedia || []).length + (pagePosts || []).length,
            snapshot_date: today,
            credits_estimate: 0,
            ai_summary: ai?.executive_summary || null,
            ai_json: ai || null,
            ai_status: aiStatus,
            report_json: payload
        }]).select('id').maybeSingle();

        await supabase.from('meta_connections').update({ status: 'active', last_sync_at: new Date().toISOString(), last_error: null }).eq('id', conn.id);
        return { reportId: saved?.id || null, reportRef: saved?.id || null, aiStatus, gaps: summary.gaps };
    } catch (err) {
        if (err.graph || err.statusCode === 401 || err.statusCode === 502) await fail(err);
        throw err;
    }
});

app.get('/api/meta/reports', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'meta_owned'); if (!ctx) return;
        let q = supabase.from('reports')
            .select('id, user_id, client_id, meta_connection_id, target_handle, posts_analyzed, snapshot_date, created_at, ai_summary, ai_status')
            .eq('platform', 'meta').eq('report_type', 'meta_owned');
        q = (await applyReportScope(req, ctx))(q);
        const { data, error } = await q.order('created_at', { ascending: false }).limit(100);
        if (error) throw error;
        res.json({ reports: data || [] });
    } catch (err) { sendErr(res, err); }
});

app.get('/api/meta/report/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'meta_owned'); if (!ctx) return;
        const { data } = await supabase.from('reports').select('*').eq('id', req.params.id).maybeSingle();
        if (!data || !(await canReadReport(ctx, data))) return res.status(404).json({ error: 'Report not found' });
        res.json({ report: data });
    } catch (err) { sendErr(res, err); }
});

// ===========================================================================
// PHASE 19 :: THE MONTHLY OWNER REPORT
//
// The rolling 28-day sync answers "how are we doing". A monthly report answers
// a different question — "what happened in September, versus August" — and it
// is the thing an agency actually sends. That makes the comparison the point,
// not a garnish, so both months are pulled in the same job rather than
// diffed against whatever snapshot happened to be lying around.
//
// Everything here is owner-side Meta Insights. Nothing scraped is mixed in:
// the two are different measurements of different populations and a report
// that blends them is wrong in a way nobody can see.
// ===========================================================================

/** 'YYYY-MM' -> unix-second bounds covering exactly that calendar month, UTC. */
function metaMonthWindow(month) {
    const [y, m] = String(month).split('-').map(Number);
    const start = Date.UTC(y, m - 1, 1) / 1000;
    const end = Date.UTC(y, m, 1) / 1000;      // exclusive: the 1st of the next month
    return { since: start, until: end };
}
function metaPrevMonth(month) {
    const [y, m] = String(month).split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 2, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
/** The last COMPLETE month. A report on a month still running is a report that changes under you. */
function metaDefaultMonth(now = new Date()) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function metaMonthLabel(month) {
    const [y, m] = String(month).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Percentage change, with the cases that matter kept distinct.
 *
 * 0 -> 40 is not "+Infinity%" and not "+0%"; it is "new", and a report that
 * prints either of the other two is lying about the same number.
 */
function pctDelta(now, before) {
    // Number(null) and Number('') are both 0, so coercing first would turn a
    // metric Meta never returned into a 100% collapse — a number the client
    // would ask about and nobody could explain. Absence is checked first and
    // stays absence.
    const num = v => (v === null || v === undefined || v === '' ? NaN : Number(v));
    const a = num(now), b = num(before);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return { pct: null, kind: 'unknown' };
    if (b === 0) return { pct: null, kind: a > 0 ? 'new' : 'flat' };
    const pct = ((a - b) / b) * 100;
    return { pct: Math.round(pct * 10) / 10, kind: Math.abs(pct) < 1 ? 'flat' : (pct > 0 ? 'up' : 'down') };
}

const META_MONTH_METRICS = [
    { key: 'reach',              level: 'ig',   label: 'Accounts reached' },
    { key: 'views',              level: 'ig',   label: 'Views' },
    { key: 'accounts_engaged',   level: 'ig',   label: 'Accounts engaged' },
    { key: 'total_interactions', level: 'ig',   label: 'Interactions' },
    { key: 'profile_views',      level: 'ig',   label: 'Profile visits' },
    { key: 'website_clicks',     level: 'ig',   label: 'Website taps' },
    { key: 'follower_count',     level: 'ig',   label: 'Followers gained' },
    { key: 'page_impressions_unique', level: 'page', label: 'Page reach' },
    { key: 'page_post_engagements',   level: 'page', label: 'Page engagements' },
    { key: 'page_views_total',        level: 'page', label: 'Page views' },
    { key: 'page_fan_adds_unique',    level: 'page', label: 'New Page followers' }
];

/** Owner totals for one window. Used twice per job — this month and last. */
async function metaWindowTotals(conn, pageToken, since, until) {
    const gaps = [];
    const out = { ig: {}, page: {} };

    const pageIns = await graphInsights(conn.page_id,
        META_MONTH_METRICS.filter(m => m.level === 'page').map(m => m.key),
        { period: 'day', since, until }, pageToken);
    gaps.push(...pageIns.unsupported.map(m => `page:${m}`));
    out.page = Object.fromEntries(Object.entries(pageIns.values).map(([k, v]) => [k, seriesSum(v)]));

    if (conn.ig_user_id) {
        const igIns = await graphInsights(conn.ig_user_id,
            META_MONTH_METRICS.filter(m => m.level === 'ig').map(m => m.key),
            { period: 'day', metric_type: 'total_value', since, until }, pageToken);
        gaps.push(...igIns.unsupported.map(m => `ig:${m}`));
        out.ig = Object.fromEntries(Object.entries(igIns.values).map(([k, v]) => [k, Array.isArray(v) ? seriesSum(v) : Number(v) || 0]));
    }
    return { ...out, gaps };
}

registerWorker('meta_monthly', (userId, input, jobId) => async (progress, ck) => {
    const conn = await supabase.from('meta_connections').select('*').eq('id', input.connectionId).maybeSingle().then(r => r.data);
    if (!conn) throw new Error('Connection no longer exists.');
    const pageToken = decryptSecret(conn.page_token_enc);
    const month = input.month;
    const prev = metaPrevMonth(month);
    const win = metaMonthWindow(month);
    const pwin = metaMonthWindow(prev);
    const gaps = [], warnings = [];

    // --- both months' totals ------------------------------------------------
    await progress(8, `Reading ${metaMonthLabel(month)}`);
    let cur = ck.get('cur');
    if (!cur) { cur = await metaWindowTotals(conn, pageToken, win.since, win.until); await ck.done('cur', cur); }
    gaps.push(...cur.gaps);

    await progress(28, `Reading ${metaMonthLabel(prev)} to compare`);
    let before = ck.get('prev');
    if (!before) {
        // A missing previous month is a real state, not a failure: the account
        // may have connected mid-month. The report says so rather than
        // printing deltas against zero as though nothing happened last month.
        try { before = await metaWindowTotals(conn, pageToken, pwin.since, pwin.until); }
        catch (err) {
            if (err.statusCode === 401) throw err;
            before = { ig: {}, page: {}, gaps: [], unavailable: String(err.message || '').slice(0, 200) };
        }
        await ck.done('prev', before);
    }
    if (before.unavailable) warnings.push(`${metaMonthLabel(prev)} could not be read, so this month is reported without a comparison.`);

    // --- profile snapshot ---------------------------------------------------
    await progress(42, 'Reading the account');
    let who = ck.get('who');
    if (!who) {
        const pageMeta = await graphGet(conn.page_id, { fields: 'id,name,fan_count,followers_count,category,link' }, pageToken);
        let ig = null, demographics = {};
        if (conn.ig_user_id) {
            ig = await graphGet(conn.ig_user_id, { fields: 'id,username,name,followers_count,follows_count,media_count' }, pageToken);
            for (const bd of ['age', 'gender', 'city', 'country']) {
                try {
                    const d = await graphGet(`${conn.ig_user_id}/insights`, { metric: 'follower_demographics', period: 'lifetime', metric_type: 'total_value', breakdown: bd }, pageToken);
                    const rows = d.data?.[0]?.total_value?.breakdowns?.[0]?.results || [];
                    demographics[bd] = rows.map(r => ({ key: (r.dimension_values || []).join(' '), value: r.value }))
                        .sort((a, b) => b.value - a.value).slice(0, 10);
                } catch (err) { if (err.statusCode === 401) throw err; gaps.push(`ig:follower_demographics:${bd}`); }
            }
        } else {
            warnings.push('No Instagram professional account is linked to this Page, so the report covers Facebook only.');
        }
        who = { page: pageMeta, ig, demographics };
        await ck.done('who', who);
    }

    // --- the month's posts --------------------------------------------------
    await progress(58, 'Reading the posts published this month');
    let posts = ck.get('posts');
    if (!posts) {
        posts = [];
        if (conn.ig_user_id) {
            // /media has no reliable since/until, so the window is applied here.
            // Stopping at the first post older than the window works because
            // the edge is returned newest-first.
            const out = await graphGet(`${conn.ig_user_id}/media`, {
                fields: 'id,caption,media_type,media_product_type,timestamp,like_count,comments_count,permalink,shortcode',
                limit: META_MEDIA_LIMIT
            }, pageToken);
            const inWindow = (out.data || []).filter(m => {
                const t = Date.parse(m.timestamp || '') / 1000;
                return Number.isFinite(t) && t >= win.since && t < win.until;
            });
            for (let i = 0; i < inWindow.length; i++) {
                const m = inWindow[i];
                const kind = m.media_product_type === 'REELS' ? 'reel' : (m.media_type === 'CAROUSEL_ALBUM' ? 'carousel' : 'still');
                let ins = {};
                try {
                    const r = await graphInsights(m.id, ['reach', 'saved', 'shares', 'views', 'total_interactions'], {}, pageToken);
                    ins = Object.fromEntries(Object.entries(r.values).map(([k, v]) => [k, Array.isArray(v) ? seriesLast(v) : v]));
                } catch (err) { if (err.statusCode === 401) throw err; }
                posts.push({
                    id: m.id, kind, permalink: m.permalink || null, postedAt: m.timestamp || null,
                    caption: (m.caption || '').slice(0, 200) || null,
                    likes: m.like_count ?? null, comments: m.comments_count ?? null,
                    reach: ins.reach ?? null, saved: ins.saved ?? null, shares: ins.shares ?? null,
                    views: ins.views ?? null, interactions: ins.total_interactions ?? null
                });
                if (i % 8 === 7) await progress(58 + Math.round(20 * (i / inWindow.length)), `Posts ${i + 1}/${inWindow.length}`);
            }
        }
        await ck.done('posts', posts);
    }

    // --- the comparison table ----------------------------------------------
    await progress(82, 'Building the month-over-month view');
    const deltas = META_MONTH_METRICS.map(m => {
        const now = cur[m.level]?.[m.key];
        const then = before.unavailable ? null : before[m.level]?.[m.key];
        if (now === undefined) return null;
        const d = then === null || then === undefined ? { pct: null, kind: 'no_baseline' } : pctDelta(now, then);
        return { key: m.key, level: m.level, label: m.label, now: Number(now) || 0, before: then ?? null, ...d };
    }).filter(Boolean);

    const byKind = {};
    for (const p of posts) {
        const a = byKind[p.kind] = byKind[p.kind] || { n: 0, reach: [], saved: [], shares: [], interactions: [] };
        a.n += 1;
        for (const f of ['reach', 'saved', 'shares', 'interactions']) if (typeof p[f] === 'number') a[f].push(p[f]);
    }
    const formats = Object.fromEntries(Object.entries(byKind).map(([k, a]) => [k, {
        n: a.n, medianReach: median(a.reach), medianSaved: median(a.saved),
        medianShares: median(a.shares), medianInteractions: median(a.interactions)
    }]));

    const top = arr => arr.filter(p => typeof p.reach === 'number').sort((a, b) => b.reach - a.reach).slice(0, 5);
    const summary = {
        month, monthLabel: metaMonthLabel(month), prevMonth: prev, prevMonthLabel: metaMonthLabel(prev),
        comparable: !before.unavailable,
        account: {
            pageName: who.page?.name || conn.page_name || null,
            pageFollowers: who.page?.followers_count ?? who.page?.fan_count ?? null,
            igUsername: who.ig?.username || conn.ig_username || null,
            igFollowers: who.ig?.followers_count ?? null,
            igPosts: who.ig?.media_count ?? null
        },
        totals: { current: cur, previous: before.unavailable ? null : { ig: before.ig, page: before.page } },
        deltas,
        posting: { count: posts.length, formats, topByReach: top(posts), topBySaves: posts.filter(p => typeof p.saved === 'number').sort((a, b) => b.saved - a.saved).slice(0, 3) },
        demographics: who.demographics,
        gaps: [...new Set(gaps)],
        warnings,
        sources: { all: 'meta_owner_insights', note: 'Owner-only Meta Insights. Nothing here is scraped and nothing is blended with scraped data.' }
    };

    // --- narrative ----------------------------------------------------------
    await progress(90, 'Writing the month up');
    let ai = null, aiStatus = { ok: false, reason: 'no_key', message: aiReasonText('no_key') };
    if (geminiAvailable()) {
        const { json } = budgetedJson(summary, { maxChars: 28000, keep: ['deltas', 'account', 'posting'] });
        const prompt =
`You are writing the monthly social media report an agency sends its client. The month is ${summary.monthLabel}${summary.comparable ? `, compared against ${summary.prevMonthLabel}` : ' (no previous month is available to compare against)'}.
${input.brief ? `Context from the team: ${input.brief}\n` : ''}
Every number below is owner-side Meta Insights for this account. Rules:
- Never invent a number. Every figure you use must appear in the JSON.
- A metric with kind "new" went from zero — describe it as new, never as a percentage.
- A metric with kind "no_baseline" has no previous month. Do not imply a trend for it.
- Do not recommend ad spend, budgets, audiences or targeting. There is no ad data here.
- Write for the business owner: plain language, no metric jargon, no platform lecture.
${summary.comparable ? '' : '- There is no comparison month. Do not write as if there is.\n'}
Data (JSON):
${json}

Reply with ONLY this JSON:
{
 "headline": "one sentence a client reads first — the month in a line",
 "executive_summary": "3-4 sentences with the numbers that matter",
 "what_moved": ["2-4 lines, each naming a metric and its change"],
 "what_worked": ["2-3 lines about the posts and formats that performed, with numbers"],
 "what_did_not": ["1-3 honest lines; say 'nothing stood out' if that is the truth"],
 "audience": "1-2 sentences from demographics, or 'not enough data'",
 "next_month": ["3-4 concrete actions, each doable by one person with a phone"],
 "caveats": "one sentence on anything missing from the data, or empty string"
}`;
        const r = await geminiCallDetailed(prompt, { temperature: 0.4, maxOutputTokens: 4000, tag: 'Gemini Monthly', userId });
        aiStatus = { ok: r.ok, reason: r.reason, message: r.ok ? 'Generated.' : aiReasonText(r.reason), model: r.model || null };
        ai = r.ok ? r.data : null;
    }
    if (!aiStatus.ok) warnings.push(`Narrative unavailable: ${aiStatus.message}`);

    await progress(96, 'Saving');
    const payload = { ...summary, ai, aiStatus, generatedAt: new Date().toISOString(), connection: { id: conn.id, pageName: conn.page_name, igUsername: conn.ig_username } };
    const { data: saved } = await supabase.from('reports').insert([{
        user_id: userId,
        client_id: input.clientId || conn.client_id || null,
        meta_connection_id: conn.id,
        platform: 'meta',
        report_type: 'meta_monthly',
        target_handle: conn.ig_username || conn.page_name || conn.page_id,
        posts_analyzed: posts.length,
        // The 1st of the month being reported, so the timeline sorts by the
        // month covered rather than the day somebody pressed the button.
        snapshot_date: `${month}-01`,
        credits_estimate: 0,
        ai_summary: ai?.executive_summary || null,
        ai_json: ai || null,
        ai_status: aiStatus,
        report_json: payload
    }]).select('id').maybeSingle();

    return { reportId: saved?.id || null, reportRef: saved?.id || null, month, aiStatus, gaps: summary.gaps };
});

// ===========================================================================
// PHASE 19 :: THE COMPARISON SET
//
// "How do I compare to similar businesses near me" was the one client-facing
// promise that still depended on somebody typing competitor handles into a box
// by hand. This finds them: same niche, same place, similar size.
//
// Size is the part that is easy to get wrong. A 900-follower florist compared
// against a 400,000-follower chain learns nothing except that they are small,
// which they knew. The band below is deliberately narrow and the reason it
// exists is that a comparison outside it is not a comparison.
// ===========================================================================

/** The size band a comparison is meaningful inside: a third to three times. */
function comparableBand(followers) {
    const f = Number(followers) || 0;
    if (f < 200) return { min: 0, max: 3000 };   // too small for a ratio to mean anything
    return { min: Math.round(f / 3), max: Math.round(f * 3) };
}

/** Search phrases for a niche in a place. Ordered: most specific first. */
function competitorQueries(niche, location) {
    const n = String(niche || '').trim();
    const l = String(location || '').trim();
    if (!n) return [];
    const city = l.split(',')[0].trim();
    return [...new Set([
        city ? `${n} ${city}` : null,
        city ? `${city} ${n}` : null,
        l && l !== city ? `${n} ${l}` : null,
        n
    ].filter(Boolean))].slice(0, 3);
}

registerWorker('competitor_discovery', (userId, input, jobId) => async (progress, ck) => {
    const { niche, location, selfHandle, followers } = input;
    const band = comparableBand(followers);
    const warnings = [];

    await progress(8, `Searching for ${niche}${location ? ` in ${location}` : ''}`);
    let candidates = ck.get('candidates');
    if (!candidates) {
        const seen = new Set();
        candidates = [];
        for (const q of competitorQueries(niche, location)) {
            try {
                const estimate = COST_PER_1K_PROFILE / 20;
                const { client } = await getWorkingClient('report', userId, { needUsd: estimate, jobId });
                const { items } = await callActor(client, 'apify/instagram-search-scraper',
                    { searchQueries: [q], searchType: 'user' },
                    { estimateUsd: estimate, maxItems: 40, jobId });
                for (const it of (items || [])) {
                    const h = String(it.username || it.ownerUsername || '').toLowerCase().replace('@', '').trim();
                    if (!h || seen.has(h) || h === String(selfHandle || '').toLowerCase()) continue;
                    seen.add(h);
                    candidates.push({ username: h, foundFor: q });
                }
            } catch (err) { warnings.push(`Search "${q}" failed: ${err.message}`); }
        }
        await ck.done('candidates', candidates);
    }
    if (!candidates.length) {
        return { handles: [], considered: 0, warnings: [...warnings, 'No accounts came back for that niche and location. Try a broader niche word.'] };
    }

    await progress(45, `Checking ${Math.min(candidates.length, 30)} accounts`);
    let profiles = ck.get('profiles');
    if (!profiles) {
        const batch = candidates.slice(0, 30).map(c => c.username);
        const estimate = (batch.length / 1000) * COST_PER_1K_PROFILE;
        const { client } = await getWorkingClient('report', userId, { needUsd: estimate, jobId });
        const { items } = await callActor(client, 'apify/instagram-profile-scraper',
            { usernames: batch },
            { estimateUsd: estimate, maxItems: batch.length, jobId });
        profiles = items || [];
        await ck.done('profiles', profiles);
    }

    await progress(82, 'Picking the comparable ones');
    const scored = profiles.map(p => {
        const h = String(p.username || '').toLowerCase();
        const f = Number(p.followersCount ?? p.followers_count ?? 0) || 0;
        const isBusiness = !!(p.isBusinessAccount ?? p.is_business_account ?? p.businessCategoryName);
        const posts = Number(p.postsCount ?? p.posts_count ?? 0) || 0;
        return {
            username: h, followers: f, posts, isBusiness,
            category: p.businessCategoryName || p.category_name || null,
            private: !!(p.private ?? p.isPrivate),
            inBand: f >= band.min && f <= band.max
        };
    }).filter(p => p.username && !p.private && p.inBand && p.posts >= 6);

    // Closest in size first: the most comparable account is the one most like
    // them, not the biggest one that matched the search.
    const target = Number(followers) || 0;
    scored.sort((a, b) => {
        if (a.isBusiness !== b.isBusiness) return a.isBusiness ? -1 : 1;
        return Math.abs(a.followers - target) - Math.abs(b.followers - target);
    });
    const picked = scored.slice(0, 8);

    if (!picked.length) {
        warnings.push(`Found ${profiles.length} accounts but none were a comparable size (between ${band.min.toLocaleString()} and ${band.max.toLocaleString()} followers).`);
    }

    if (input.clientId && picked.length) {
        await supabase.from('clients').update({
            competitors: picked.map(p => p.username),
            competitors_source: 'discovered',
            competitors_updated_at: new Date().toISOString()
        }).eq('id', input.clientId);
    }

    return {
        handles: picked.map(p => p.username),
        accounts: picked,
        considered: profiles.length,
        band,
        warnings,
        note: 'Discovered from public Instagram search. Review them before using — a search match is not a competitor.'
    };
});

app.post('/api/clients/:id/competitors/discover', spendLimit, async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const c = await clientAccess(ctx.user.id, req.params.id, 'editor');
        if (!c) return res.status(404).json({ error: 'Client not found.' });
        await assertJobSlot(ctx.user.id);

        const { data: client } = await supabase.from('clients')
            .select('id, name, ig_handle, niche, location').eq('id', c.id).maybeSingle();
        const niche = String(req.body.niche || client?.niche || '').trim();
        const location = String(req.body.location || client?.location || '').trim();
        if (!niche) return res.status(400).json({ error: 'This client has no niche set, so there is nothing to search for. Add one first.' });

        // Their own follower count sets the band. Without it every account is
        // "comparable" and the result is a list of whoever ranked highest.
        let followers = Number(req.body.followers) || 0;
        if (!followers && client?.ig_handle) {
            const { data: last } = await supabase.from('reports')
                .select('followers_snapshot').eq('client_id', c.id)
                .not('followers_snapshot', 'is', null)
                .order('created_at', { ascending: false }).limit(1);
            followers = Number(last?.[0]?.followers_snapshot) || 0;
        }

        const job = await createJob(ctx.user.id, 'competitor_discovery', 'report', {
            clientId: c.id, niche, location, followers,
            selfHandle: client?.ig_handle || null
        }, COST_PER_1K_PROFILE / 20);
        runJob(job.id, JOB_WORKERS['competitor_discovery'](ctx.user.id, job.input, job.id));
        res.status(202).json({ success: true, jobId: job.id });
    } catch (err) { sendErr(res, err); }
});

// ===========================================================================
// MERGE (phase 23)
//
// Two records for one business happen honestly: an agency creates one, the
// business later signs itself up and gets its own, and only the empty case
// is absorbed automatically (phase 22) — a record with work in it is never
// touched as a side effect. This is the deliberate act for the rest: every
// row filed under `from` is re-pointed at `into`, members are carried over,
// and `from` is archived. Nothing is deleted.
// ===========================================================================

/** Every table that files rows under a client. Kept in one place so a new table cannot be forgotten by the merge. */
const MERGE_TABLES = [
    'reports', 'jobs', 'campaigns', 'meta_connections', 'meta_oauth_states', 'ai_conversations',
    'content_plan_notes', 'competitor_sets', 'fb_group_sets', 'fb_page_sets', 'fb_suggestions',
    'fb_posts', 'fb_page_posts', 'posts', 'report_shares', 'schedules'
];

app.post('/api/clients/:id/merge', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const into = await clientAccess(ctx.user.id, req.params.id, 'owner');
        const from = await clientAccess(ctx.user.id, req.body?.fromId, 'owner');
        if (!into || !from) return res.status(404).json({ error: 'You must own both clients, or be an admin.' });
        if (into.id === from.id) return res.status(400).json({ error: 'A client cannot be merged into itself.' });
        const dry = String(req.query.dry || req.body?.dry || '') === '1';

        const counts = {};
        for (const t of MERGE_TABLES) {
            const { count } = await supabase.from(t).select('*', { count: 'exact', head: true }).eq('client_id', from.id);
            counts[t] = count || 0;
        }
        const { data: fromLinks } = await supabase.from('client_leads').select('lead_id, source, job_id').eq('client_id', from.id);
        const { data: fromMembers } = await supabase.from('client_members').select('user_id, role').eq('client_id', from.id);
        counts.client_leads = (fromLinks || []).length;
        counts.client_members = (fromMembers || []).length;

        if (dry) return res.json({ dry: true, into: { id: into.id, name: into.name }, from: { id: from.id, name: from.name }, counts });

        for (const t of MERGE_TABLES) {
            if (!counts[t]) continue;
            const { error } = await supabase.from(t).update({ client_id: into.id }).eq('client_id', from.id);
            if (error) throw error;
        }
        // Links and members are keyed by (client, x): upsert into the target,
        // then clear the source, so a lead or a person already on both does not
        // become a conflict.
        if ((fromLinks || []).length) {
            await supabase.from('client_leads').upsert(
                fromLinks.map(l => ({ client_id: into.id, lead_id: l.lead_id, source: l.source || 'merge', job_id: l.job_id })),
                { onConflict: 'client_id,lead_id', ignoreDuplicates: true });
            await supabase.from('client_leads').delete().eq('client_id', from.id);
        }
        if ((fromMembers || []).length) {
            const { data: have } = await supabase.from('client_members').select('user_id').eq('client_id', into.id);
            const had = new Set((have || []).map(m => m.user_id));
            const add = fromMembers.filter(m => !had.has(m.user_id) && m.user_id !== into.owner_user_id)
                .map(m => ({ client_id: into.id, user_id: m.user_id, role: m.role, added_by: ctx.user.id }));
            if (add.length) await supabase.from('client_members').upsert(add, { onConflict: 'client_id,user_id' });
            await supabase.from('client_members').delete().eq('client_id', from.id);
        }
        // The old owner keeps a way in: if they are not the new owner, they
        // become an editor rather than losing the business they created.
        if (from.owner_user_id !== into.owner_user_id) {
            await supabase.from('client_members').upsert(
                [{ client_id: into.id, user_id: from.owner_user_id, role: 'editor', added_by: ctx.user.id }],
                { onConflict: 'client_id,user_id' });
        }
        const stamp = new Date().toISOString().slice(0, 10);
        await supabase.from('clients').update({
            archived: true,
            notes: `${from.notes ? from.notes + '\n\n' : ''}Merged into "${into.name}" (${into.id}) on ${stamp}.`
        }).eq('id', from.id);

        logger.info('client_merged', { userId: ctx.user.id, from: from.id, into: into.id, counts });
        res.json({ success: true, into: { id: into.id, name: into.name }, from: { id: from.id, name: from.name }, counts });
    } catch (err) { sendErr(res, err); }
});

/** The agreed comparison set. Kept on the client so every run uses the same one. */
app.put('/api/clients/:id/competitors', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const c = await clientAccess(ctx.user.id, req.params.id, 'editor');
        if (!c) return res.status(404).json({ error: 'Client not found.' });
        const handles = [...new Set((Array.isArray(req.body.handles) ? req.body.handles : [])
            .map(h => String(h || '').trim().replace(/^@/, '').replace(/\/+$/, '').toLowerCase())
            .filter(h => /^[a-z0-9._]{1,30}$/.test(h)))].slice(0, 12);
        const { error } = await supabase.from('clients').update({
            competitors: handles.length ? handles : null,
            competitors_source: handles.length ? (req.body.source === 'discovered' ? 'discovered' : 'manual') : null,
            competitors_updated_at: handles.length ? new Date().toISOString() : null
        }).eq('id', c.id);
        if (error) throw error;
        res.json({ success: true, handles });
    } catch (err) { sendErr(res, err); }
});

app.post('/api/meta/monthly', spendLimit, async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'meta_owned'); if (!ctx) return;
        await assertJobSlot(ctx.user.id);
        const conn = await metaLoadConnection(ctx.user.id, req.body.connectionId);
        if (!conn) return res.status(404).json({ error: 'Connection not found.' });

        const month = MONTH_RE.test(String(req.body.month || '')) ? String(req.body.month) : metaDefaultMonth();
        // A month that has not finished would produce a report that changes
        // if you ran it again tomorrow. That is not a monthly report.
        if (month >= new Date().toISOString().slice(0, 7)) {
            return res.status(400).json({ error: 'That month has not finished yet. Pick a completed month.' });
        }

        const job = await createJob(ctx.user.id, 'meta_monthly', 'meta_owned', {
            connectionId: conn.id, month,
            clientId: req.body.clientId || conn.client_id || null,
            brief: String(req.body.brief || '').slice(0, 600) || null
        }, 0);
        runJob(job.id, JOB_WORKERS['meta_monthly'](ctx.user.id, job.input, job.id));
        res.status(202).json({ success: true, jobId: job.id, month, estimatedUsd: 0 });
    } catch (err) { sendErr(res, err); }
});

app.get('/api/meta/monthly', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'meta_owned'); if (!ctx) return;
        let q = supabase.from('reports')
            .select('id, user_id, client_id, meta_connection_id, target_handle, posts_analyzed, snapshot_date, created_at, ai_summary, ai_status')
            .eq('report_type', 'meta_monthly');
        q = (await applyReportScope(req, ctx))(q);
        const { data, error } = await q.order('snapshot_date', { ascending: false }).limit(60);
        if (error) throw error;
        res.json({ reports: (data || []).map(r => ({ ...r, month: String(r.snapshot_date || '').slice(0, 7) })) });
    } catch (err) { sendErr(res, err); }
});

// ===========================================================================
// PHASE 10 :: CONTENT PLAN  (derived engine, zero Apify — Instagram + FB Page)
//
// Performance Audit / Competitor Intel / FB Page Report each store the rows
// they scraped. This turns those rows into a plan: which format cells rivals
// win and the target is absent from (gaps), which the target already wins
// (double down), which it posts and loses (stop), and a brief for each.
// Gemini writes only inside the cells the scorecard supplies; the evidence
// and the predicted band are computed.
//
// Phase 10 changes:
//   - rows are read for the selected client AND the caller's own vault, so a
//     teammate's run on a shared client feeds the plan (dedup by post, most
//     recently scraped copy wins). Reads are never blended across clients.
//   - Facebook Pages are a first-class platform (fb_page_posts), with the
//     same cell scoring and their own format set.
//   - freshness is measured and reported; stale data raises a warning and is
//     printed in the "how true is this" panel rather than silently used.
// ===========================================================================

const CP_POSTS_PER_HANDLE = parseInt(process.env.CONTENT_PLAN_POSTS_PER_HANDLE || '120', 10);
const CP_MIN_CELL  = 2;
const CP_MIN_ROWS  = 6;
const CP_STALE_DAYS = parseInt(process.env.CONTENT_PLAN_STALE_DAYS || '45', 10);

const CP_PLATFORMS = {
    instagram: {
        key: 'instagram', label: 'Instagram', unit: 'account', prefix: '@',
        sourceTypes: ['ig_report', 'deep_audit'],
        sourceEngines: 'a Performance Audit or Competitor Intel',
        formats: [
            { key: 'Reel',     plural: 'reels',     label: 'Reels',     defaultCount: 4, conceptHint: 'what the reel shows, shot by shot in 2-3 lines' },
            { key: 'Carousel', plural: 'carousels', label: 'Carousels', defaultCount: 3, conceptHint: 'slide-by-slide outline' },
            { key: 'Still',    plural: 'stills',    label: 'Stills',    defaultCount: 3, conceptHint: 'the single image' }
        ],
        unavailable: 'Competitor reach, saves, shares, impressions and demographics cannot be obtained from any source.'
    },
    facebook: {
        key: 'facebook', label: 'Facebook Page', unit: 'Page', prefix: '',
        sourceTypes: ['fb_page'],
        sourceEngines: 'an FB Page Report',
        formats: [
            { key: 'Video', plural: 'videos', label: 'Videos',     defaultCount: 3, conceptHint: 'what the video shows, shot by shot in 2-3 lines' },
            { key: 'Photo', plural: 'photos', label: 'Photos',     defaultCount: 3, conceptHint: 'the single image' },
            { key: 'Album', plural: 'albums', label: 'Albums',     defaultCount: 2, conceptHint: 'image-by-image outline' },
            { key: 'Link',  plural: 'links',  label: 'Link posts', defaultCount: 1, conceptHint: 'what is linked and how the post frames it' },
            { key: 'Text',  plural: 'texts',  label: 'Text posts', defaultCount: 1, conceptHint: 'the post text, structure only' }
        ],
        unavailable: 'Competitor reach, impressions, clicks and demographics cannot be obtained from any source. Video views are only present when Facebook shows them publicly.'
    }
};
function cpPlatform(p) { return CP_PLATFORMS[p] || CP_PLATFORMS.instagram; }
function cpCounts(platform, raw = {}) {
    const out = {};
    for (const f of cpPlatform(platform).formats) {
        const v = parseInt(raw[f.plural], 10);
        out[f.plural] = Number.isFinite(v) ? Math.min(Math.max(v, 0), 8) : f.defaultCount;
    }
    return out;
}

function cpFormat(r) {
    if (r.post_type === 'Reel' || (r.is_video && r.post_type !== 'Sidecar')) return 'Reel';
    if (r.post_type === 'Sidecar' || (r.carousel_count || 0) > 1) return 'Carousel';
    return 'Still';
}
function cpFbFormat(r) {
    const m = String(r.media_type || '').toLowerCase();
    if (m === 'video') return 'Video';
    if (m === 'album') return 'Album';
    if (m === 'photo') return 'Photo';
    if (m === 'link')  return 'Link';
    return 'Text';                                   // text | poll | unknown
}
/**
 * Whether a brief may carry a "spend money on this" recommendation.
 *
 * The model is told the rule in the prompt; this enforces it, for the same
 * reason the cell gate exists. A why=gap cell is by definition something this
 * account has never won — putting budget behind it is the most expensive kind
 * of wrong advice a plan can give, and it is exactly the advice a confident
 * model will volunteer.
 *
 * Only a why=double_down cell — something already winning organically — can
 * be recommended for boosting. Everything else is downgraded, and the
 * downgrade is recorded so the page can say why rather than silently
 * disagreeing with the brief next to it.
 */
function cpBoostCall(modelBoost, cellWhy, modelWhy) {
    const wants = /worth/i.test(String(modelBoost || ''));
    const may   = cellWhy === 'double_down';

    if (wants && may) {
        return { boost: 'worth boosting', downgraded: false, why: modelWhy || null };
    }
    if (wants && !may) {
        return {
            boost: 'organic only',
            downgraded: true,
            why: 'Not proven for this account yet — win it organically before putting money behind it.'
        };
    }
    return { boost: 'organic only', downgraded: false, why: modelWhy || null };
}

function cpBand(idx) {
    if (idx == null || isNaN(idx)) return 'typical';
    if (idx >= 1.5) return 'top';
    if (idx >= 1.15) return 'above';
    if (idx >= 0.8) return 'typical';
    return 'below';
}
function cpHashtagBand(n) { return n === 0 ? '0' : n <= 5 ? '1-5' : n <= 15 ? '6-15' : '16+'; }
function cpHook(caption) {
    const first = String(caption || '').split(/\r?\n/).map(s => s.trim()).find(Boolean) || '';
    return first.slice(0, 90);
}

/** Instagram row (posts table) -> scorecard feature. */
function cpFeature(r) {
    const caption = r.caption || '';
    const words = caption.split(/\s+/).filter(Boolean).length;
    const tags = topicTags(caption, 3);
    const hashtags = Array.isArray(r.hashtags) ? r.hashtags.length : 0;
    const format = cpFormat(r);
    return {
        ...r,
        format,
        opening: openingPattern(caption),
        lengthBand: lengthBand(words),
        topic: tags[0] || 'general',
        topics: tags,
        hook: cpHook(caption),
        hashtagBand: cpHashtagBand(hashtags),
        hasQuestion: FB_QUESTION_RE.test(caption),
        hasCta: FB_CTA_RE.test(caption),
        hasOffer: FB_OFFER_RE.test(caption),
        hasEmoji: FB_EMOJI_RE.test(caption),
        hasLink: IG_URL_RE.test(caption),
        hasFirstComment: !!r.first_comment,
        audioOriginal: r.audio ? !!(r.audio.original) : null,
        aspect: r.aspect_ratio || null,
        slides: r.carousel_count || null,
        playsRatio: (r.views && r.likes) ? +(r.views / Math.max(1, r.likes)).toFixed(1) : null,
        hour: r.hour_local, dow: r.dow_local
    };
}

/** Facebook Page row (fb_page_posts table) -> the same feature shape. */
function cpFbFeature(r) {
    const caption = r.content || '';
    const words = r.word_count || caption.split(/\s+/).filter(Boolean).length;
    const tags = (Array.isArray(r.topic_tags) && r.topic_tags.length) ? r.topic_tags.slice(0, 3) : topicTags(caption, 3);
    const hashtags = Array.isArray(r.hashtags) ? r.hashtags.length : 0;
    return {
        ...r,
        handle: r.page_id,
        shortcode: r.post_id,
        caption,
        likes: r.reactions_total || 0,
        format: cpFbFormat(r),
        opening: r.opening_pattern || openingPattern(caption),
        lengthBand: r.length_band || lengthBand(words),
        topic: tags[0] || 'general',
        topics: tags,
        hook: cpHook(caption),
        hashtagBand: cpHashtagBand(hashtags),
        hasQuestion: !!r.has_question,
        hasCta: !!r.has_cta,
        hasOffer: !!r.has_offer,
        hasEmoji: !!r.has_emoji,
        hasLink: !!r.has_link,
        hasFirstComment: false,
        audioOriginal: null,
        aspect: null,
        slides: null,
        linkDomain: r.link_domain || null,
        playsRatio: (r.views && r.reactions_total) ? +(r.views / Math.max(1, r.reactions_total)).toFixed(1) : null,
        hour: r.hour_local, dow: r.dow_local
    };
}
function cpCellKey(f) { return `${f.format}|${f.opening}|${f.lengthBand}|${f.topic}`; }

/** Sample-damped median index for a group of features. */
function cpScore(rows) {
    const idx = rows.map(r => r.performance_index).filter(v => typeof v === 'number');
    if (!idx.length) return { n: 0, medianIndex: null, winRate: 0, confidence: 0 };
    const med = median(idx);
    const wins = idx.filter(v => v >= 1.15).length / idx.length;
    const confidence = Math.min(1, idx.length / 6);
    // Shrink toward 1.0 (the account's own median) when the sample is thin.
    const damped = 1 + (med - 1) * confidence;
    return { n: idx.length, medianIndex: +med.toFixed(2), dampedIndex: +damped.toFixed(2), winRate: +wins.toFixed(2), confidence: +confidence.toFixed(2) };
}

function cpGroupBy(rows, keyFn) {
    const m = {};
    for (const r of rows) { const k = keyFn(r); if (k == null) continue; (m[k] = m[k] || []).push(r); }
    return m;
}

function cpLeaderboard(rows, keyFn, label, min = CP_MIN_CELL) {
    return Object.entries(cpGroupBy(rows, keyFn))
        .map(([k, g]) => ({ [label]: k, ...cpScore(g) }))
        .filter(x => x.n >= min)
        .sort((a, b) => (b.dampedIndex || 0) - (a.dampedIndex || 0));
}

function cpExemplars(rows, n = 3) {
    return rows.slice().sort((a, b) => (b.performance_index || 0) - (a.performance_index || 0)).slice(0, n)
        .map(r => ({ handle: r.handle, name: r.displayName || null, url: r.post_url, index: r.performance_index, band: cpBand(r.performance_index), hook: r.hook, likes: r.likes, comments: r.comments, views: r.views, postedAt: r.posted_at, owner: r.owner || null }));
}

const CP_IG_COLS = 'user_id, client_id, handle, shortcode, post_url, post_type, caption, hashtags, likes, comments, views, is_video, video_duration, thumbnail_url, posted_at, carousel_count, aspect_ratio, is_sponsored, audio, first_comment, engagement_raw, hour_local, dow_local, is_provisional, scraped_at';
const CP_FB_COLS = 'user_id, client_id, page_id, post_id, post_url, content, word_count, media_type, link_url, link_domain, reactions_total, comments, shares, views, posted_at, hour_local, dow_local, engagement_raw, performance_index, topic_tags, hashtags, opening_pattern, length_band, has_link, has_question, has_cta, has_offer, has_emoji, is_provisional, scraped_at';

/**
 * Stored posts for one handle: the caller's own rows plus, when a client is
 * selected, rows any teammate filed under that client. The same post scraped
 * twice keeps the most recent copy. Returns the rows and where they came
 * from, so the plan can print its own provenance.
 */
async function cpLoadRows(platform, userId, clientId, handle) {
    const fb = platform === 'facebook';
    const table = fb ? 'fb_page_posts' : 'posts';
    const idKey = fb ? 'post_id' : 'shortcode';
    const base = () => {
        let q = supabase.from(table).select(fb ? CP_FB_COLS : CP_IG_COLS);
        q = fb ? q.eq('page_id', handle) : q.eq('platform', 'instagram').eq('handle', handle);
        return q.order('posted_at', { ascending: false }).limit(CP_POSTS_PER_HANDLE);
    };
    const own = (await base().eq('user_id', userId)).data || [];
    let team = [];
    if (clientId && UUID_RE.test(String(clientId))) {
        team = (await base().eq('client_id', clientId).neq('user_id', userId)).data || [];
    }
    const byId = new Map();
    for (const r of [...own, ...team]) {
        const k = r[idKey]; if (!k) continue;
        const prev = byId.get(k);
        if (!prev || String(r.scraped_at || '') > String(prev.scraped_at || '')) byId.set(k, r);
    }
    const rows = [...byId.values()]
        .filter(r => !(platform === 'instagram' && r.is_sponsored))
        .sort((a, b) => String(b.posted_at || '').localeCompare(String(a.posted_at || '')))
        .slice(0, CP_POSTS_PER_HANDLE);
    const lastScraped = rows.reduce((m, r) => (r.scraped_at && r.scraped_at > m) ? r.scraped_at : m, '') || null;
    const newestPost  = rows.reduce((m, r) => (r.posted_at && r.posted_at > m) ? r.posted_at : m, '') || null;
    const ageDays = lastScraped ? Math.max(0, Math.round((Date.now() - new Date(lastScraped).getTime()) / 86400000)) : null;
    return {
        rows,
        source: { own: own.length, team: team.length, merged: rows.length,
                  lastScrapedAt: lastScraped, newestPostAt: newestPost, ageDays,
                  stale: ageDays == null ? true : ageDays > CP_STALE_DAYS }
    };
}

/** Display names for Facebook page ids (fb_pages is per user; any copy will do). */
async function cpPageNames(pageIds) {
    if (!pageIds.length) return {};
    const { data } = await supabase.from('fb_pages').select('page_id, name, username').in('page_id', pageIds);
    const out = {};
    for (const p of (data || [])) if (p.page_id && !out[p.page_id]) out[p.page_id] = p.name || p.username || p.page_id;
    return out;
}

/**
 * Owner-side metrics for the target from the client's connected Meta account.
 * IG media are keyed by shortcode; Page posts by the post id after the
 * "pageid_" prefix. Everything here carries source:'insights' and is never
 * folded into the scraped index.
 */
async function cpOwnerMap(platform, clientId, target, targetName) {
    if (!clientId || !UUID_RE.test(String(clientId))) return { map: {}, connection: null };
    const { data: conns } = await supabase.from('meta_connections')
        .select('id, page_id, page_name, ig_username, last_sync_at').eq('client_id', clientId).eq('status', 'active');
    let conn = null;
    if (platform === 'instagram') {
        conn = (conns || []).find(c => (c.ig_username || '').toLowerCase() === target) || null;
    } else {
        const want = [String(target).toLowerCase(), String(targetName || '').toLowerCase()].filter(Boolean);
        conn = (conns || []).find(c => want.includes(String(c.page_id || '').toLowerCase()) || want.includes(String(c.page_name || '').toLowerCase())) || null;
    }
    if (!conn) return { map: {}, connection: null };
    const { data: mm } = await supabase.from('meta_media').select('media_id, shortcode, insights').eq('connection_id', conn.id).eq('platform', platform);
    const map = {};
    for (const m of (mm || [])) {
        const ins = m.insights || {};
        if (platform === 'instagram') {
            if (m.shortcode) map[m.shortcode] = { reach: ins.reach ?? null, saved: ins.saved ?? null, shares: ins.shares ?? null, views: ins.views ?? null, interactions: ins.total_interactions ?? null, source: 'insights' };
        } else {
            // Graph ids are "pageid_postid"; scrapers store the numeric post id,
            // sometimes the full pair. Register every form so either matches.
            const mid = String(m.media_id || '');
            const rec = { reach: ins.post_impressions_unique ?? null, engaged: ins.post_engaged_users ?? null, clicks: ins.post_clicks ?? null, shares: ins.shares ?? null, saved: null, views: null, source: 'insights' };
            const keys = new Set([mid, mid.slice(mid.indexOf('_') + 1), mid.split('_').pop()].filter(Boolean));
            for (const k of keys) map[k] = rec;
        }
    }
    return { map, connection: conn };
}

registerWorker('content_plan', (userId, input, jobId) => async (progress, ck) => {
    const platform = input.platform === 'facebook' ? 'facebook' : 'instagram';
    const spec     = cpPlatform(platform);
    const target   = String(input.target || '').toLowerCase();
    const rivals   = (input.rivals || []).map(h => String(h).toLowerCase()).filter(h => h && h !== target);
    const counts   = cpCounts(platform, input.counts || {});
    const clientId = (input.clientId && UUID_RE.test(String(input.clientId))) ? input.clientId : null;
    const featureOf = platform === 'facebook' ? cpFbFeature : cpFeature;

    // --- load --------------------------------------------------------------
    await progress(5, `Loading stored posts for ${spec.prefix}${target}`);
    const tLoad = await cpLoadRows(platform, userId, clientId, target);
    if (tLoad.rows.length < CP_MIN_ROWS) {
        const e = new Error(`Only ${tLoad.rows.length} posts stored for ${spec.prefix}${target}${clientId ? ' under this client or your vault' : ''}. ` +
                            `Run ${spec.sourceEngines} on it first — the content plan is built from those rows and costs nothing extra.`);
        e.statusCode = 422; throw e;
    }
    const rivalLoads = {};
    for (const r of rivals) rivalLoads[r] = await cpLoadRows(platform, userId, clientId, r);
    const missingRivals = rivals.filter(r => rivalLoads[r].rows.length < CP_MIN_ROWS);
    const usedRivals = rivals.filter(r => !missingRivals.includes(r));

    let names = {};
    if (platform === 'facebook') names = await cpPageNames([target, ...rivals]);
    const display = h => platform === 'facebook' ? (names[h] || h) : `@${h}`;

    const freshness = {
        staleAfterDays: CP_STALE_DAYS,
        target: { handle: target, name: display(target), ...tLoad.source },
        rivals: usedRivals.map(r => ({ handle: r, name: display(r), ...rivalLoads[r].source })),
        scope: clientId ? 'client+own' : 'own'
    };

    // --- owner layer -------------------------------------------------------
    await progress(15, 'Attaching owner metrics where available');
    const { map: ownerMap, connection: ownerConnection } = await cpOwnerMap(platform, clientId, target, names[target]);

    // --- features + index --------------------------------------------------
    await progress(25, 'Indexing and classifying');
    const all = [];
    const push = (rows, role) => rows.forEach(r => {
        const f = featureOf(r);
        f.role = role;
        f.displayName = display(f.handle);
        if (role === 'target' && ownerMap[f.shortcode]) f.owner = ownerMap[f.shortcode];
        all.push(f);
    });
    push(tLoad.rows, 'target');
    for (const r of usedRivals) push(rivalLoads[r].rows, 'rival');
    igIndexPosts(all);                                  // keyed on handle + month; page_id stands in for handle on FB
    const settled = all.filter(r => !r.is_provisional);
    const T = settled.filter(r => r.role === 'target');
    const R = settled.filter(r => r.role === 'rival');

    // --- format cells ------------------------------------------------------
    const cellsT = cpGroupBy(T, cpCellKey);
    const cellsR = cpGroupBy(R, cpCellKey);
    const keys = [...new Set([...Object.keys(cellsT), ...Object.keys(cellsR)])];
    const cells = keys.map(k => {
        const [format, opening, lengthBand, topic] = k.split('|');
        const t = cpScore(cellsT[k] || []);
        const r = cpScore(cellsR[k] || []);
        let verdict = 'filler';
        if (t.n === 0 && r.n >= CP_MIN_CELL && (r.dampedIndex || 0) >= 1.15) verdict = 'gap';
        else if (t.n >= CP_MIN_CELL && (t.dampedIndex || 0) >= 1.15) verdict = 'double_down';
        else if (t.n >= CP_MIN_CELL && (t.dampedIndex || 0) < 0.85) verdict = 'stop';
        else if (t.n === 0 && r.n >= CP_MIN_CELL) verdict = 'rival_only';
        return { key: k, format, opening, lengthBand, topic, target: t, rivals: r, verdict,
                 exemplars: cpExemplars([...(cellsR[k] || []), ...(cellsT[k] || [])], 3) };
    });
    const byVerdict = v => cells.filter(c => c.verdict === v).sort((a, b) => ((b.rivals.dampedIndex || b.target.dampedIndex || 0) - (a.rivals.dampedIndex || a.target.dampedIndex || 0)));
    const lists = { gaps: byVerdict('gap').slice(0, 10), doubleDown: byVerdict('double_down').slice(0, 10), stop: byVerdict('stop').slice(0, 10), filler: byVerdict('filler').slice(0, 6) };

    // --- per-format analysis -----------------------------------------------
    await progress(45, `Analysing ${spec.formats.map(f => f.label.toLowerCase()).join(', ')}`);
    const fmtRows = k => ({ target: T.filter(r => r.format === k), rivals: R.filter(r => r.format === k), all: settled.filter(r => r.format === k) });
    const lostRow = r => ({ handle: r.handle, name: r.displayName || null, url: r.post_url, index: r.performance_index, hook: r.hook, likes: r.likes, comments: r.comments, views: r.views });
    const wonLost = rows => ({
        won: cpExemplars(rows.filter(r => cpBand(r.performance_index) === 'top' || cpBand(r.performance_index) === 'above'), 5),
        average: cpExemplars(rows.filter(r => cpBand(r.performance_index) === 'typical'), 3),
        lost: rows.filter(r => cpBand(r.performance_index) === 'below').slice().sort((a, b) => (a.performance_index || 0) - (b.performance_index || 0)).slice(0, 4).map(lostRow)
    });
    const hourKey = r => r.hour == null ? null : `${String(r.hour).padStart(2, '0')}:00`;
    const formats = {};
    for (const f of spec.formats) {
        const g = fmtRows(f.key);
        const block = {
            key: f.key, label: f.label,
            share: { target: T.length ? +(g.target.length / T.length).toFixed(2) : 0, rivals: R.length ? +(g.rivals.length / R.length).toFixed(2) : 0 },
            score: { target: cpScore(g.target), rivals: cpScore(g.rivals) },
            target: wonLost(g.target), rivals: wonLost(g.rivals),
            byHook: cpLeaderboard(g.all, r => r.opening, 'opening'),
            byHour: cpLeaderboard(g.all, hourKey, 'hour'),
            byLength: cpLeaderboard(g.all, r => r.lengthBand, 'band')
        };
        if (platform === 'instagram') {
            if (f.key === 'Reel') {
                block.byAudio = cpLeaderboard(g.all.filter(r => r.audioOriginal !== null), r => r.audioOriginal ? 'original audio' : 'reused audio', 'audio');
                block.byAspect = cpLeaderboard(g.all, r => r.aspect, 'aspect');
                block.playsRatio = { target: median(g.target.map(r => r.playsRatio).filter(v => v)), rivals: median(g.rivals.map(r => r.playsRatio).filter(v => v)) };
            }
            if (f.key === 'Carousel') block.bySlides = cpLeaderboard(g.all, r => r.slides == null ? null : (r.slides <= 3 ? '2-3 slides' : r.slides <= 6 ? '4-6 slides' : '7+ slides'), 'slides');
            if (f.key === 'Still') block.byAspect = cpLeaderboard(g.all, r => r.aspect, 'aspect');
        } else {
            if (f.key === 'Video') block.playsRatio = { target: median(g.target.map(r => r.playsRatio).filter(v => v)), rivals: median(g.rivals.map(r => r.playsRatio).filter(v => v)) };
            if (f.key === 'Link')  block.byDomain = cpLeaderboard(g.all, r => r.linkDomain, 'domain');
        }
        formats[f.plural] = block;
    }

    // --- caption analysis --------------------------------------------------
    const flag = (rows, f, on, off) => {
        const a = cpScore(rows.filter(r => r[f])), b = cpScore(rows.filter(r => !r[f]));
        return { on, off, with: a, without: b, lift: (a.dampedIndex != null && b.dampedIndex != null) ? +(a.dampedIndex - b.dampedIndex).toFixed(2) : null };
    };
    const flags = platform === 'instagram'
        ? ['hasQuestion', 'hasCta', 'hasOffer', 'hasEmoji', 'hasLink', 'hasFirstComment']
        : ['hasQuestion', 'hasCta', 'hasOffer', 'hasEmoji', 'hasLink'];
    const captions = {
        target: flags.map(f => ({ flag: f, ...flag(T, f, 'with', 'without') })),
        rivals: flags.map(f => ({ flag: f, ...flag(R, f, 'with', 'without') })),
        lengthBand: { target: cpLeaderboard(T, r => r.lengthBand, 'band'), rivals: cpLeaderboard(R, r => r.lengthBand, 'band') },
        hashtagBand: { target: cpLeaderboard(T, r => r.hashtagBand, 'band'), rivals: cpLeaderboard(R, r => r.hashtagBand, 'band') },
        opening: { target: cpLeaderboard(T, r => r.opening, 'opening'), rivals: cpLeaderboard(R, r => r.opening, 'opening') },
        topics: { target: cpLeaderboard(T, r => r.topic, 'topic'), rivals: cpLeaderboard(R, r => r.topic, 'topic') }
    };

    // --- owner view --------------------------------------------------------
    const ownerRows = T.filter(r => r.owner);
    const med = (rows, k) => median(rows.map(r => r.owner[k]).filter(v => v != null));
    const ownerRow = r => ({ url: r.post_url, format: r.format, hook: r.hook, reach: r.owner.reach, saved: r.owner.saved, shares: r.owner.shares, engaged: r.owner.engaged ?? null, clicks: r.owner.clicks ?? null, index: r.performance_index });
    const owner = ownerConnection ? {
        connection: ownerConnection.id, matched: ownerRows.length, lastSync: ownerConnection.last_sync_at,
        byFormat: Object.fromEntries(spec.formats.map(f => {
            const g = ownerRows.filter(r => r.format === f.key);
            return [f.key, { n: g.length, medianReach: med(g, 'reach'), medianSaved: med(g, 'saved'), medianShares: med(g, 'shares'), medianEngaged: med(g, 'engaged'), medianClicks: med(g, 'clicks') }];
        })),
        // IG: saves are the strongest owner-side signal. FB Pages have no saves; reach is the ranking metric.
        mostSaved: platform === 'instagram' ? ownerRows.slice().sort((a, b) => (b.owner.saved || 0) - (a.owner.saved || 0)).slice(0, 5).map(ownerRow) : [],
        topReach: ownerRows.slice().sort((a, b) => (b.owner.reach || 0) - (a.owner.reach || 0)).slice(0, 5).map(ownerRow),
        // Where public index and owner reach disagree, the public number is lying.
        hiddenWinners: ownerRows.filter(r => cpBand(r.performance_index) === 'below' && r.owner.reach).sort((a, b) => b.owner.reach - a.owner.reach).slice(0, 3).map(ownerRow)
    } : null;

    // --- provenance --------------------------------------------------------
    const staleNames = [freshness.target, ...freshness.rivals].filter(x => x.stale).map(x => `${x.name} (${x.ageDays == null ? 'unknown age' : x.ageDays + 'd'})`);
    const teamRows = tLoad.source.team + usedRivals.reduce((n, r) => n + rivalLoads[r].source.team, 0);
    const trueness = {
        scraped: platform === 'instagram'
            ? 'Likes, comments, views, captions, timing for every account. Same basis for target and rivals.'
            : 'Reactions, comments, shares, views (when public), post text, timing for every Page. Same basis for target and rivals.',
        insights: owner
            ? `${platform === 'instagram' ? 'Reach, saves, shares, views' : 'Reach, engaged users, clicks, shares'} for ${owner.matched} of ${T.length} target posts via the connected Meta account.`
            : 'Not connected — no owner-side numbers. Connect the client\'s Meta account to add owner metrics.',
        derived: 'Performance index (post vs. own monthly median), bands, cells, win rates and predictions are computed from the scraped numbers.',
        unavailable: spec.unavailable,
        freshness: `Target data last scraped ${tLoad.source.ageDays == null ? 'at an unknown time' : tLoad.source.ageDays + ' day(s) ago'}; ` +
                   `newest target post ${tLoad.source.newestPostAt ? tLoad.source.newestPostAt.slice(0, 10) : 'unknown'}. ` +
                   (staleNames.length ? `Older than ${CP_STALE_DAYS} days: ${staleNames.join(', ')}. Re-run the source audit before acting on those cells.` : `Everything is within ${CP_STALE_DAYS} days.`),
        provenance: clientId
            ? `${teamRows ? teamRows + ' row(s) came from teammates\' runs filed under this client; ' : ''}the rest are from your own vault. Rows from other clients are never read.`
            : 'No client selected — only your own vault was read.'
    };

    // --- briefs ------------------------------------------------------------
    await progress(65, 'Writing briefs');
    const candidates = [...lists.gaps.map(c => ({ ...c, why: 'gap' })), ...lists.doubleDown.map(c => ({ ...c, why: 'double_down' }))];
    const pick = (format, n) => candidates.filter(c => c.format === format).slice(0, Math.max(n, 1) + 2);
    const cellPack = c => ({
        cell: c.key, why: c.why, opening: c.opening, lengthBand: c.lengthBand, topic: c.topic,
        rivalIndex: c.rivals.dampedIndex, targetIndex: c.target.dampedIndex, rivalWinRate: c.rivals.winRate,
        evidence: c.exemplars.map(e => ({ url: e.url, hook: e.hook, index: e.index, handle: e.name || e.handle }))
    });
    const cellSets = {};
    for (const f of spec.formats) cellSets[f.plural] = pick(f.key, counts[f.plural]).map(cellPack);
    const evidence = {
        platform, target: display(target), rivals: usedRivals.map(display), brief: input.brief || null,
        counts,
        ...cellSets,
        stop: lists.stop.slice(0, 5).map(c => ({ cell: c.key, targetIndex: c.target.dampedIndex, n: c.target.n })),
        captionRules: {
            target: captions.target.filter(c => c.lift != null).map(c => ({ flag: c.flag, lift: c.lift })),
            rivals: captions.rivals.filter(c => c.lift != null).map(c => ({ flag: c.flag, lift: c.lift })),
            bestLength: captions.lengthBand.rivals[0]?.band || captions.lengthBand.target[0]?.band || null,
            bestHashtags: captions.hashtagBand.rivals[0]?.band || null
        },
        bestHours: Object.fromEntries(spec.formats.map(f => [f.plural, (formats[f.plural].byHour || []).slice(0, 3)])),
        owner: owner ? { top: (owner.mostSaved.length ? owner.mostSaved : owner.topReach).slice(0, 3), hiddenWinners: owner.hiddenWinners } : null,
        freshnessNote: staleNames.length ? `Data for ${staleNames.join(', ')} is older than ${CP_STALE_DAYS} days.` : null
    };

    let ai = null, aiStatus = { ok: false, reason: 'no_key' };
    if (geminiAvailable()) {
        const { json } = budgetedJson(evidence, { maxChars: 32000, keep: [...spec.formats.map(f => f.plural), 'counts', 'target'] });
        const formatLines = spec.formats.map(f =>
            ` "${f.plural}": [ { "cell": "...", "concept": "${f.conceptHint}", "hook": "first line on screen / first line of the post", "script": ["3-6 beats, each one line, in order — what is said or shown from the hook to the close"], "shot": "what the camera or the image actually shows, in one line, concrete enough to hand to whoever makes it", "caption": "full ${platform === 'instagram' ? 'caption' : 'post text'} in the cell's length band", "evidence": ["url"], "slot": "day + hour if bestHours suggests one", "boost": "worth boosting | organic only", "boost_why": "one line", "why": "one line" } ]`
        ).join(',\n');
        const countLine = spec.formats.map(f => `${counts[f.plural]} ${f.plural}`).join(', ');
        const prompt =
`You are a content strategist. Below is a computed scorecard for ${spec.label} ${spec.unit} ${display(target)} against rivals ${usedRivals.map(display).join(', ') || '(none)'}.
Each "cell" is a content format x opening pattern x caption length x topic. The cell lists are keyed by format: ${spec.formats.map(f => `${f.plural} = ${f.label}`).join(', ')}. Cells marked why=gap are ones rivals win and the target has never used. why=double_down are ones the target already wins.

RULES:
- Write briefs ONLY for the cells given. Do not invent formats, topics or hooks outside them.
- Each brief must name its cell and cite at least one evidence URL from that cell.
- Hooks must follow the cell's opening pattern. Captions must follow the cell's length band.
- Never claim reach, saves, clicks or impressions unless the owner block supplies them.
- If freshnessNote is present, say so once in the summary; do not pretend the data is current.
- Write in the language the evidence hooks are in (English or Bangla as seen).
- "script" is the spoken or written beats in order, and "shot" is what is actually on screen. Both must be makeable by one person with a phone. No crews, no studios, no stock footage, no voice actors, no motion graphics.
- Derive script and shot from the evidence hooks in the cell, not from what usually works on this platform. If a cell's exemplars do not show you what was on screen, say so in "shot" rather than inventing a treatment.
- "boost" may only be "worth boosting" for a why=double_down cell — something this account already wins organically. A why=gap cell is unproven for them, and putting money behind unproven content is how budgets get wasted. Everything else is "organic only".
- Never suggest a budget, a bid, an audience size or a targeting setting. There is no ad data here and you would be guessing.

Scorecard (JSON):
${json}

Reply with ONLY this JSON:
{
 "summary": "3 sentences: the biggest gap, the biggest strength, the one thing to stop",
${formatLines},
 "stop_doing": ["one line per stop cell, with the number"],
 "caption_rules": ["3-5 rules with the lift numbers"]
}
Produce exactly ${countLine} (fewer only if there are not enough cells).`;
        const r = await geminiCallDetailed(prompt, { temperature: 0.55, maxOutputTokens: 12000, tag: 'Gemini Content Plan', userId });
        aiStatus = { ok: r.ok, reason: r.reason, message: r.ok ? 'Generated.' : aiReasonText(r.reason), model: r.model || null };
        ai = r.ok ? r.data : null;
    } else {
        aiStatus = { ok: false, reason: 'no_key', message: aiReasonText('no_key') };
    }

    // Gate: a brief must sit in a cell we handed the model (gap or double
    // down). Anything else is invented and is dropped, the same way the FB
    // advisor drops a pitch in a no-promo room. Predicted band comes from the
    // cell's computed index, never from the model.
    const allowed = Object.fromEntries(candidates.map(c => [c.key, c]));
    let removed = 0;
    const stamp = (list, format) => (Array.isArray(list) ? list : []).flatMap(b => {
        const c = allowed[String(b.cell || '')];
        if (!c || c.format !== format) { removed += 1; return []; }
        const idx = c.target.n >= CP_MIN_CELL ? c.target.dampedIndex : c.rivals.dampedIndex;
        const ev = (Array.isArray(b.evidence) ? b.evidence : []).filter(u => c.exemplars.some(e => e.url === u));

        const call = cpBoostCall(b.boost, c.why, b.boost_why);

        return [{ ...b, evidence: ev.length ? ev : c.exemplars.map(e => e.url),
                  predicted_band: cpBand(idx), predicted_index: idx,
                  boost: call.boost,
                  boost_downgraded: call.downgraded,
                  boost_why: call.why,
                  script: Array.isArray(b.script) ? b.script.slice(0, 8) : [],
                  shot: b.shot || null,
                  sources: { evidence: 'scraped', prediction: 'derived',
                             boost: 'derived', owner: owner ? 'insights' : null } }];
    });
    let briefs = null;
    if (ai) {
        briefs = { summary: ai.summary, stopDoing: ai.stop_doing || [], captionRules: ai.caption_rules || [] };
        for (const f of spec.formats) briefs[f.plural] = stamp(ai[f.plural], f.key);
        briefs.removed = removed;
    }
    if (removed) logger.warn('content_plan_briefs_removed', { jobId, removed });

    await progress(92, 'Saving plan');
    const warnings = [];
    if (missingRivals.length) warnings.push(`Rivals with fewer than ${CP_MIN_ROWS} stored posts were ignored: ${missingRivals.map(display).join(', ')}. Run ${spec.sourceEngines} on them to include them.`);
    if (staleNames.length) warnings.push(`Stored data is older than ${CP_STALE_DAYS} days for: ${staleNames.join(', ')}. The plan reflects that period, not today.`);
    if (!aiStatus.ok) warnings.push(`Briefs unavailable: ${aiStatus.message}. The scorecard below is still complete.`);
    if (briefs?.removed) warnings.push(`${briefs.removed} draft brief(s) named a cell that is not in the evidence and were dropped.`);
    const payload = {
        platform, formatSpec: spec.formats.map(f => ({ key: f.key, plural: f.plural, label: f.label })),
        target, targetName: display(target), rivals: usedRivals, rivalNames: usedRivals.map(display), names, counts,
        sample: { target: T.length, rivals: R.length, provisionalDropped: all.length - settled.length },
        freshness, lists, formats, captions, owner, trueness, briefs, aiStatus, warnings,
        generatedAt: new Date().toISOString()
    };
    const { data: saved, error: saveErr } = await supabase.from('reports').insert([{
        user_id: userId,
        client_id: clientId,
        platform,
        report_type: 'content_plan',
        target_handle: platform === 'facebook' ? display(target) : target,
        competitor_handles: usedRivals.map(display),
        fb_page_ids: platform === 'facebook' ? [target, ...usedRivals] : null,
        fb_page_names: platform === 'facebook' ? [target, ...usedRivals].map(display) : null,
        posts_analyzed: settled.length,
        snapshot_date: new Date().toISOString().slice(0, 10),
        credits_estimate: 0,
        source_report_ids: Array.isArray(input.sourceReportIds) ? input.sourceReportIds.filter(x => UUID_RE.test(String(x))) : [],
        ai_summary: briefs?.summary || null,
        ai_json: briefs || null,
        ai_status: aiStatus,
        report_json: payload
    }]).select('id').maybeSingle();
    if (saveErr) { const e = new Error(`Plan computed but could not be saved: ${saveErr.message}`); e.statusCode = 500; throw e; }
    return { reportId: saved?.id || null, reportRef: saved?.id || null, aiStatus, platform };
});

app.post('/api/content-plan', spendLimit, async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'content_plan'); if (!ctx) return;
        await assertJobSlot(ctx.user.id);
        let platform = req.body.platform === 'facebook' ? 'facebook' : (req.body.platform === 'instagram' ? 'instagram' : null);
        const cleanIg = h => String(h || '').replace('@', '').replace(/\/+$/, '').trim().toLowerCase();
        const cleanFb = h => { const r = parsePageRef(h); return r ? r.pageId : ''; };
        const splitList = v => Array.isArray(v) ? v : String(v || '').split(/[\s,]+/);
        const sourceReportIds = [];
        let rep = null;

        // Start from an existing report: reuse its platform, target and rivals.
        if (req.body.reportId) {
            const { data } = await supabase.from('reports')
                .select('id, user_id, client_id, platform, target_handle, competitor_handles, fb_page_ids, report_type')
                .eq('id', req.body.reportId).maybeSingle();
            rep = data;
            if (!rep || !(await canReadReport(ctx, rep))) return res.status(404).json({ error: 'Source report not found.' });
            if (!platform) platform = rep.report_type === 'fb_page' ? 'facebook' : 'instagram';
            sourceReportIds.push(rep.id);
        }
        if (!platform) platform = 'instagram';
        const clean = platform === 'facebook' ? cleanFb : cleanIg;

        let target = clean(req.body.target);
        let rivals = splitList(req.body.rivals).map(clean).filter(Boolean);
        if (rep) {
            if (platform === 'facebook') {
                const ids = Array.isArray(rep.fb_page_ids) ? rep.fb_page_ids : [];
                target = target || ids[0] || '';
                if (!rivals.length) rivals = ids.slice(1);
            } else {
                target = target || cleanIg(rep.target_handle);
                if (!rivals.length) rivals = (rep.competitor_handles || []).map(cleanIg);
            }
        }
        if (!target) return res.status(400).json({ error: platform === 'facebook' ? 'Target Page URL or slug required.' : 'Target handle required.' });
        rivals = [...new Set(rivals.filter(h => h && h !== target))].slice(0, MAX_COMPETITORS);

        // Counts arrive either as { counts: { reels: 4, ... } } or flat keys (older page build).
        const counts = cpCounts(platform, { ...(req.body || {}), ...(req.body.counts || {}) });
        const clientId = await resolveClientId(req, ctx);

        const job = await createJob(ctx.user.id, 'content_plan', 'content_plan',
            { platform, target, rivals, counts, clientId, sourceReportIds, brief: String(req.body.brief || '').slice(0, 600) || null }, 0);
        runJob(job.id, JOB_WORKERS['content_plan'](ctx.user.id, job.input, job.id));
        res.status(202).json({ success: true, jobId: job.id, estimatedUsd: 0, platform, target, rivals, counts });
    } catch (err) { sendErr(res, err); }
});

app.get('/api/content-plans', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'content_plan'); if (!ctx) return;
        let q = supabase.from('reports')
            .select('id, user_id, client_id, platform, target_handle, competitor_handles, posts_analyzed, snapshot_date, created_at, ai_summary, ai_status, source_report_ids')
            .eq('report_type', 'content_plan');
        q = (await applyReportScope(req, ctx))(q);
        const { data, error } = await q.order('created_at', { ascending: false }).limit(100);
        if (error) throw error;
        res.json({ reports: data || [] });
    } catch (err) { sendErr(res, err); }
});

/**
 * Reports the content plan can be built on: the caller's own IG audits,
 * Competitor Intel and FB Page Reports, plus anything filed under the selected
 * client by a teammate. Each carries platform so the page can pick the right
 * format set.
 */
app.get('/api/content-plan/sources', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'content_plan'); if (!ctx) return;
        let q = supabase.from('reports')
            .select('id, user_id, platform, report_type, target_handle, competitor_handles, fb_page_ids, fb_page_names, created_at, client_id')
            .in('report_type', ['ig_report', 'deep_audit', 'fb_page']);
        const cid = req.query?.client_id;
        if (cid) {
            const c = await clientAccess(ctx.user.id, cid, 'viewer');
            if (!c) return res.status(403).json({ error: 'No access to that client.' });
            q = q.or(`client_id.eq.${c.id},user_id.eq.${ctx.user.id}`);
        } else {
            q = q.eq('user_id', ctx.user.id);
        }
        const { data, error } = await q.order('created_at', { ascending: false }).limit(80);
        if (error) throw error;
        res.json({ sources: (data || []).map(s => ({ ...s, platform: s.report_type === 'fb_page' ? 'facebook' : 'instagram', mine: s.user_id === ctx.user.id })) });
    } catch (err) { sendErr(res, err); }
});

app.get('/api/content-plan/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'content_plan'); if (!ctx) return;
        const { data } = await supabase.from('reports').select('*').eq('id', req.params.id).maybeSingle();
        if (!data || data.report_type !== 'content_plan' || !(await canReadReport(ctx, data))) return res.status(404).json({ error: 'Plan not found' });

        // Notes ship with the plan rather than behind a second request: they
        // are part of reading it, and a page that had to ask twice would
        // routinely render the plan without them.
        const { data: notes } = await supabase.from('content_plan_notes')
            .select('id, cell, body, author_name, created_at, updated_at, user_id')
            .eq('report_id', data.id).order('created_at', { ascending: true }).limit(200);

        res.json({ report: data, notes: notes || [] });
    } catch (err) { sendErr(res, err); }
});

// ---------------------------------------------------------------------------
// MANUAL RESEARCH FINDINGS
//
// A plan knows what was published and how it performed. It does not know what
// a customer said on the phone, that a rival quietly changed their pricing, or
// that the town has a festival in three weeks. Those arrive through a person.
//
// Kept in their own table and rendered as somebody's note, never folded into a
// computed index — the same separation rule 3 applies to scraped and owner
// metrics. A human observation is a third source, not a correction to the
// other two.
// ---------------------------------------------------------------------------

app.post('/api/content-plan/:id/notes', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'content_plan'); if (!ctx) return;
        if (!UUID_RE.test(String(req.params.id))) return res.status(400).json({ error: 'Bad plan id.' });

        const body = String(req.body?.body || '').trim().slice(0, 4000);
        if (!body) return res.status(400).json({ error: 'Write something first.' });

        const { data: plan } = await supabase.from('reports')
            .select('id, user_id, client_id, report_type').eq('id', req.params.id).maybeSingle();
        if (!plan || plan.report_type !== 'content_plan' || !(await canReadReport(ctx, plan))) {
            return res.status(404).json({ error: 'Plan not found' });
        }

        const { data, error } = await supabase.from('content_plan_notes').insert([{
            report_id: plan.id,
            user_id: ctx.user.id,
            client_id: plan.client_id || null,
            cell: req.body?.cell ? String(req.body.cell).slice(0, 200) : null,
            body,
            author_name: ctx.profile?.full_name || ctx.user.email || null
        }]).select().single();
        if (error) throw error;

        res.status(201).json({ success: true, note: data });
    } catch (err) { sendErr(res, err); }
});

app.patch('/api/content-plan/notes/:noteId', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'content_plan'); if (!ctx) return;
        if (!UUID_RE.test(String(req.params.noteId))) return res.status(400).json({ error: 'Bad note id.' });

        const body = String(req.body?.body || '').trim().slice(0, 4000);
        if (!body) return res.status(400).json({ error: 'Write something first.' });

        // Only the author edits, even where a colleague can read the plan.
        // Rewriting somebody else's observation and leaving their name on it
        // is worse than not being able to edit it at all.
        const { data: note } = await supabase.from('content_plan_notes')
            .select('id, user_id').eq('id', req.params.noteId).maybeSingle();
        if (!note) return res.status(404).json({ error: 'Note not found' });
        if (note.user_id !== ctx.user.id && ctx.profile?.role !== 'admin') {
            return res.status(403).json({ error: 'You can only edit your own notes.' });
        }

        const { data, error } = await supabase.from('content_plan_notes')
            .update({ body, updated_at: new Date().toISOString() })
            .eq('id', note.id).select().single();
        if (error) throw error;

        res.json({ success: true, note: data });
    } catch (err) { sendErr(res, err); }
});

app.delete('/api/content-plan/notes/:noteId', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'content_plan'); if (!ctx) return;
        if (!UUID_RE.test(String(req.params.noteId))) return res.status(400).json({ error: 'Bad note id.' });

        const { data: note } = await supabase.from('content_plan_notes')
            .select('id, user_id').eq('id', req.params.noteId).maybeSingle();
        if (!note) return res.status(404).json({ error: 'Note not found' });
        if (note.user_id !== ctx.user.id && ctx.profile?.role !== 'admin') {
            return res.status(403).json({ error: 'You can only delete your own notes.' });
        }

        await supabase.from('content_plan_notes').delete().eq('id', note.id);
        res.json({ success: true });
    } catch (err) { sendErr(res, err); }
});

// ===========================================================================
// PHASE 11 :: SCHEDULED RUNS
//
// A monthly report a human has to remember to click is a report that gets
// forgotten. A schedule is "re-run this job's input every week / month". It
// stores the job's *validated* input verbatim, so no engine needs a second
// validation path, and it runs through the same createJob → runJob engine as
// a click does — same budget gate, same checkpoint, same cancel/resume.
//
// Claiming a due schedule is one compare-and-set UPDATE on next_run_at (the
// job-level pattern claimJob already uses), so a second instance polling the
// same table cannot fire the same schedule twice.
// ===========================================================================

const SCHEDULER_POLL_MS   = parseInt(process.env.SCHEDULER_POLL_MS || '60000', 10);
const SCHEDULER_ENABLED   = String(process.env.SCHEDULER_ENABLED || 'true') !== 'false';
const SCHEDULE_MAX_PER_USER = parseInt(process.env.SCHEDULE_MAX_PER_USER || '25', 10);
/** Job types that are safe to re-run from their stored input alone. */
const SCHEDULABLE_TYPES = {
    ig_report:          'report',
    deep_audit:         'report',
    fb_community_audit: 'fb_community',
    fb_page_report:     'fb_page',
    meta_insights:      'content_plan'
};

/**
 * Next fire time strictly after `from`. Weekly = next `dayOfWeek` at
 * `hourUtc`; monthly = `dayOfMonth` (1–28 so every month has it) at `hourUtc`.
 * Pure, so the test suite can pin it.
 */
function scheduleNextRun(s, from = new Date()) {
    const hour = Math.min(23, Math.max(0, parseInt(s.hour_utc ?? 6, 10) || 0));
    const f = new Date(from.getTime());
    if (s.cadence === 'weekly') {
        const dow = Math.min(6, Math.max(0, parseInt(s.day_of_week ?? 1, 10) || 0));
        const d = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), f.getUTCDate(), hour, 0, 0, 0));
        let delta = (dow - d.getUTCDay() + 7) % 7;
        if (delta === 0 && d.getTime() <= f.getTime()) delta = 7;
        d.setUTCDate(d.getUTCDate() + delta);
        return d;
    }
    // monthly
    const dom = Math.min(28, Math.max(1, parseInt(s.day_of_month ?? 1, 10) || 1));
    let d = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), dom, hour, 0, 0, 0));
    if (d.getTime() <= f.getTime()) d = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth() + 1, dom, hour, 0, 0, 0));
    return d;
}

/**
 * The stored input is what the user validated when they clicked Run, with two
 * exceptions: a frozen window boundary (`since`) has to move with the calendar
 * or every monthly FB report would measure the same month forever, and the
 * schedule id is stamped so the finished job can be linked back.
 */
function scheduleInputForRun(s) {
    const input = { ...(s.input || {}) };
    if (input.days && Number(input.days) > 0) {
        input.since = new Date(Date.now() - Number(input.days) * 86400000).toISOString().slice(0, 10);
    }
    input.scheduleId = s.id;
    input.clientId = s.client_id || null;
    return input;
}

function cleanScheduleBody(b = {}) {
    const out = {};
    if (b.cadence !== undefined) {
        if (!['weekly', 'monthly'].includes(b.cadence)) throw Object.assign(new Error('cadence must be weekly or monthly'), { statusCode: 400 });
        out.cadence = b.cadence;
    }
    if (b.dayOfWeek !== undefined)  out.day_of_week  = Math.min(6, Math.max(0, parseInt(b.dayOfWeek, 10) || 0));
    if (b.dayOfMonth !== undefined) out.day_of_month = Math.min(28, Math.max(1, parseInt(b.dayOfMonth, 10) || 1));
    if (b.hourUtc !== undefined)    out.hour_utc     = Math.min(23, Math.max(0, parseInt(b.hourUtc, 10) || 0));
    if (b.label !== undefined)      out.label        = String(b.label || '').trim().slice(0, 120) || null;
    if (typeof b.paused === 'boolean') out.paused = b.paused;
    return out;
}

async function scheduleCanRead(ctx, row) {
    if (!row) return false;
    if (row.user_id === ctx.user.id) return true;
    if (row.client_id && await clientAccess(ctx.user.id, row.client_id, 'viewer')) return true;
    return false;
}
async function scheduleCanEdit(ctx, row) {
    if (!row) return false;
    if (row.user_id === ctx.user.id) return true;
    if (row.client_id && await clientAccess(ctx.user.id, row.client_id, 'editor')) return true;
    return false;
}

/** Called from runJob when a job carrying input.scheduleId settles. */
async function scheduleNoteOutcome(scheduleId, { status, reportId = null, error = null } = {}) {
    if (!scheduleId || !UUID_RE.test(String(scheduleId))) return;
    try {
        const patch = { last_status: status, updated_at: new Date().toISOString() };
        if (reportId) patch.last_report_id = reportId;
        if (error) patch.last_error = String(error).slice(0, 500);
        else if (status === 'done') patch.last_error = null;
        await supabase.from('schedules').update(patch).eq('id', scheduleId);
    } catch (e) { logger.warn('schedule_note_failed', { scheduleId, message: e.message }); }
}

/**
 * Fire one schedule now. Every guard a click gets, a schedule gets:
 * account still active, engine still granted, job slot free, key can pay.
 * A guard that fails records why on the row and moves on — nothing is queued.
 */
async function fireSchedule(s, { manual = false } = {}) {
    const engine = SCHEDULABLE_TYPES[s.job_type];
    const factory = JOB_WORKERS[s.job_type];
    if (!engine || !factory) {
        await supabase.from('schedules').update({ last_status: 'skipped', last_error: `"${s.job_type}" cannot be scheduled.`, paused: true }).eq('id', s.id);
        return { ok: false, reason: 'unschedulable' };
    }

    const { data: profile } = await supabase.from('app_users').select('id, role, is_active').eq('id', s.user_id).maybeSingle();
    if (!profile || profile.is_active === false) {
        await supabase.from('schedules').update({ last_status: 'skipped', last_error: 'Owner account is disabled.', paused: true }).eq('id', s.id);
        return { ok: false, reason: 'owner_disabled' };
    }
    if (profile.role !== 'admin') {
        const { data: grant } = await supabase.from('user_engine_access').select('id').eq('user_id', s.user_id).eq('engine', engine).maybeSingle();
        if (!grant) {
            await supabase.from('schedules').update({ last_status: 'skipped', last_error: `Owner no longer has the ${engine} engine.`, paused: true }).eq('id', s.id);
            return { ok: false, reason: 'no_engine' };
        }
    }
    if (s.client_id) {
        const access = await clientAccess(s.user_id, s.client_id, 'editor');
        if (!access) {
            await supabase.from('schedules').update({ last_status: 'skipped', last_error: 'Owner lost edit access to the client.', paused: true }).eq('id', s.id);
            return { ok: false, reason: 'no_client' };
        }
    }

    const { count } = await supabase.from('jobs').select('id', { count: 'exact', head: true })
        .eq('user_id', s.user_id).in('status', ['queued', 'running']);
    if ((count || 0) >= MAX_ACTIVE_JOBS) {
        // Not a failure: try again in ten minutes rather than next month.
        await supabase.from('schedules').update({
            last_status: 'deferred', last_error: `${count} job(s) already running; retrying in 10 minutes.`,
            next_run_at: new Date(Date.now() + 600000).toISOString(), updated_at: new Date().toISOString()
        }).eq('id', s.id);
        return { ok: false, reason: 'busy' };
    }

    const input = scheduleInputForRun(s);
    const estimate = Number(s.credits_estimate || 0);
    const perUnit = estimate / Math.max(1, jobUnitCount({ type: s.job_type, input }));
    try {
        await getWorkingClient(engine, s.user_id, { needUsd: perUnit });
    } catch (e) {
        await supabase.from('schedules').update({
            last_status: 'skipped_no_credit', last_error: e.message, updated_at: new Date().toISOString()
        }).eq('id', s.id);
        alertOnce('schedule_no_credit:' + s.id, `Scheduled run "${s.label || s.job_type}" skipped: ${e.message}`, { scheduleId: s.id });
        return { ok: false, reason: 'no_credit' };
    }

    const job = await createJob(s.user_id, s.job_type, engine, input, estimate);
    runJob(job.id, factory(s.user_id, job.input, job.id));
    await supabase.from('schedules').update({
        last_job_id: job.id, last_status: 'started', last_error: null,
        runs: (s.runs || 0) + 1, updated_at: new Date().toISOString()
    }).eq('id', s.id);
    METRICS.jobs.scheduled = (METRICS.jobs.scheduled || 0) + 1;
    logger.info('schedule_fired', { scheduleId: s.id, jobId: job.id, type: s.job_type, manual });
    return { ok: true, jobId: job.id };
}

let _schedulerBusy = false;
async function schedulerTick() {
    if (!SCHEDULER_ENABLED || _schedulerBusy || _shuttingDown) return;
    _schedulerBusy = true;
    try {
        const nowIso = new Date().toISOString();
        const { data: due, error } = await supabase.from('schedules').select('*')
            .eq('paused', false).lte('next_run_at', nowIso)
            .order('next_run_at', { ascending: true }).limit(5);
        if (error) { logger.warn('scheduler_read_failed', { message: error.message }); return; }
        for (const s of (due || [])) {
            // Compare-and-set claim: whoever advances next_run_at owns this fire.
            const next = scheduleNextRun(s, new Date()).toISOString();
            const { data: claimed } = await supabase.from('schedules')
                .update({ next_run_at: next, last_run_at: nowIso, updated_at: nowIso })
                .eq('id', s.id).eq('next_run_at', s.next_run_at)
                .select('id').maybeSingle();
            if (!claimed) continue;
            try { await fireSchedule(s); }
            catch (e) {
                logger.error('schedule_fire_failed', { scheduleId: s.id, message: e.message });
                await supabase.from('schedules').update({ last_status: 'failed', last_error: e.message }).eq('id', s.id);
            }
        }
    } catch (e) {
        logger.error('scheduler_tick_failed', { message: e.message });
    } finally { _schedulerBusy = false; }
}

/** Create a schedule from a job the caller ran (by job id, or the report it produced). */
app.post('/api/schedules', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const { jobId, reportId } = req.body || {};
        let q = supabase.from('jobs').select('id, user_id, type, engine, input, client_id, credits_estimate, status').eq('user_id', ctx.user.id);
        if (jobId && UUID_RE.test(String(jobId))) q = q.eq('id', jobId);
        else if (reportId && UUID_RE.test(String(reportId))) q = q.eq('result_report_id', reportId);
        else return res.status(400).json({ error: 'jobId or reportId required.' });
        const { data: job } = await q.order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (!job) return res.status(404).json({ error: 'That run was not found in your jobs. Only runs you started can be scheduled.' });
        if (!SCHEDULABLE_TYPES[job.type]) return res.status(400).json({ error: `"${job.type}" runs cannot be scheduled.` });

        const { count } = await supabase.from('schedules').select('id', { count: 'exact', head: true }).eq('user_id', ctx.user.id);
        if ((count || 0) >= SCHEDULE_MAX_PER_USER) return res.status(429).json({ error: `You already have ${count} schedules. Delete one first.` });

        const fields = cleanScheduleBody(req.body || {});
        const row = {
            user_id: ctx.user.id,
            client_id: job.client_id || null,
            job_type: job.type, engine: job.engine,
            input: (() => { const i = { ...(job.input || {}) }; delete i.scheduleId; return i; })(),
            credits_estimate: job.credits_estimate || 0,
            cadence: fields.cadence || 'monthly',
            day_of_week: fields.day_of_week ?? 1,
            day_of_month: fields.day_of_month ?? 1,
            hour_utc: fields.hour_utc ?? 6,
            label: fields.label || null,
            source_job_id: job.id,
            paused: false
        };
        row.next_run_at = scheduleNextRun(row).toISOString();
        const { data, error } = await supabase.from('schedules').insert([row]).select().single();
        if (error) throw error;
        res.status(201).json({ success: true, schedule: data });
    } catch (err) { sendErr(res, err); }
});

app.get('/api/schedules', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        let q = supabase.from('schedules').select('*');
        const cid = req.query?.client_id;
        if (cid) {
            const c = await clientAccess(ctx.user.id, cid, 'viewer');
            if (!c) return res.status(403).json({ error: 'No access to that client.' });
            q = q.eq('client_id', c.id);
        } else {
            q = q.eq('user_id', ctx.user.id);
        }
        const { data, error } = await q.order('next_run_at', { ascending: true }).limit(200);
        if (error) throw error;
        res.json({ schedules: (data || []).map(s => ({ ...s, mine: s.user_id === ctx.user.id, input: undefined, summary: scheduleSummary(s) })) });
    } catch (err) { sendErr(res, err); }
});

/** A one-line description of what a schedule re-runs, built from its input. */
function scheduleSummary(s) {
    const i = s.input || {};
    switch (s.job_type) {
        case 'ig_report':          return `IG audit @${i.target}${(i.rivals || []).length ? ' vs ' + i.rivals.map(r => '@' + r).join(', ') : ''}`;
        case 'deep_audit':         return `Competitor Intel @${i.target} vs ${(i.competitors || []).length} rival(s)`;
        case 'fb_community_audit': return `Community audit · ${(i.groupNames || i.groups || []).length} room(s) · ${i.days}d`;
        case 'fb_page_report':     return `FB Page report · ${i.target}${i.rival ? ' vs ' + i.rival : ''} · ${i.days}d`;
        case 'meta_insights':      return `Meta owner sync`;
        default:                   return s.job_type;
    }
}

app.patch('/api/schedules/:id', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const { data: row } = await supabase.from('schedules').select('*').eq('id', req.params.id).maybeSingle();
        if (!row || !(await scheduleCanEdit(ctx, row))) return res.status(404).json({ error: 'Schedule not found.' });
        const patch = cleanScheduleBody(req.body || {});
        const merged = { ...row, ...patch };
        if (patch.cadence || patch.day_of_week !== undefined || patch.day_of_month !== undefined || patch.hour_utc !== undefined || patch.paused === false) {
            patch.next_run_at = scheduleNextRun(merged).toISOString();
        }
        patch.updated_at = new Date().toISOString();
        const { data, error } = await supabase.from('schedules').update(patch).eq('id', row.id).select().single();
        if (error) throw error;
        res.json({ success: true, schedule: { ...data, input: undefined, summary: scheduleSummary(data) } });
    } catch (err) { sendErr(res, err); }
});

app.post('/api/schedules/:id/run-now', spendLimit, async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const { data: row } = await supabase.from('schedules').select('*').eq('id', req.params.id).maybeSingle();
        if (!row || !(await scheduleCanEdit(ctx, row))) return res.status(404).json({ error: 'Schedule not found.' });
        const r = await fireSchedule(row, { manual: true });
        if (!r.ok) {
            const { data: after } = await supabase.from('schedules').select('last_error').eq('id', row.id).maybeSingle();
            return res.status(r.reason === 'no_credit' ? 402 : 409).json({ error: after?.last_error || 'Could not start.', reason: r.reason });
        }
        res.status(202).json({ success: true, jobId: r.jobId });
    } catch (err) { sendErr(res, err); }
});

app.delete('/api/schedules/:id', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const { data: row } = await supabase.from('schedules').select('id, user_id, client_id').eq('id', req.params.id).maybeSingle();
        if (!row || !(await scheduleCanEdit(ctx, row))) return res.status(404).json({ error: 'Schedule not found.' });
        await supabase.from('schedules').delete().eq('id', row.id);
        res.json({ success: true });
    } catch (err) { sendErr(res, err); }
});

// ===========================================================================
// PHASE 11 :: READ-ONLY REPORT SHARE LINKS
//
// A link the client can open beats a PDF attachment. The token is the whole
// secret: 192 random bits, base64url, stored plain (it is not a password —
// anyone holding it can already read the report). Links expire, can be
// revoked, and count views so a freelancer can see whether the client looked.
// The public route returns the report row with ownership fields stripped and
// nothing else — no client list, no vault, no job state.
// ===========================================================================

const SHARE_DEFAULT_DAYS = parseInt(process.env.SHARE_DEFAULT_DAYS || '30', 10);
const SHARE_MAX_DAYS     = parseInt(process.env.SHARE_MAX_DAYS || '365', 10);
// publicLimit is declared beside spendLimit and readLimit near the top of the
// file. It was here once, after routes that use it — a const read before its
// line is a ReferenceError at load, which node --check cannot see.

/** Which page renders which report type. Server is the contract; pages conform. */
const REPORT_PAGE = {
    ig_report: 'ig-report.html', single: 'ig-report.html', compare: 'ig-report.html',
    deep_audit: 'ig-competitors.html', competitor: 'ig-competitors.html',
    fb_page: 'fb-report.html',
    fb_community: 'fb-audit.html', fb_group: 'fb-audit.html',
    content_plan: 'content-plan.html', meta_owned: 'content-plan.html'
};

/**
 * Every share link points at one client-facing page, not at the employee page
 * that happens to render that report type.
 *
 * Sending them to ig-report.html put a client inside the agency's workbench
 * with a read-only bar over it, and shipped every pillar score and rival
 * handle along with the link.
 *
 * REPORT_PAGE above no longer has a caller because of this change. It is kept
 * rather than deleted because it is the only record of which employee page
 * renders which report type, which is what an in-app "open this report" link
 * would need — but nothing reads it today.
 */
function shareUrlFor(row, token) {
    const base = FRONTEND_URL || '';
    return `${base}/share.html?share=${encodeURIComponent(token)}`;
}

function shareToken() { return crypto.randomBytes(24).toString('base64url'); }

// ===========================================================================
// CLIENT REPORT VIEW  (phase 14)
//
// The same report, said differently. Not a subset and not a dumbed-down copy:
// the employee report answers "what is the state of this account and what do I
// do about it", and a business owner is asking something narrower — am I doing
// well, how do I compare to businesses like mine, and what should I change.
//
// Nothing here is scraped or computed fresh. Every number already exists in
// reports.report_json because the employee report needed it; this reads the
// same row and chooses different words.
// ===========================================================================

/**
 * Plain-language readings of each score pillar. IG and FB Page emit the same
 * breakdown shape, so one table covers both.
 *
 * `strong` and `weak` are written to be true at a glance without the number —
 * an owner should be able to skip every figure on the page and still leave
 * knowing what to do.
 */
const CLIENT_PILLARS = {
    'Engagement per follower': {
        strong: 'The people following you actually react to what you post.',
        weak:   'Most of your followers scroll past without reacting.',
        why:    'This is the clearest sign you have the right audience rather than just a large one.'
    },
    'Posting cadence': {
        strong: 'You post often enough to stay in front of people.',
        weak:   'You are not posting often enough to stay visible.',
        why:    'Accounts that go quiet get shown to fewer people, and it takes weeks to recover.'
    },
    'Consistency': {
        strong: 'You post on a steady rhythm rather than in bursts.',
        weak:   'Your posting comes in bursts with long gaps between.',
        why:    'A long silence resets your reach, so five posts in a week then nothing beats nothing then five.'
    },
    'Conversation': {
        strong: 'People comment, not just tap like.',
        weak:   'People tap like but rarely comment.',
        why:    'Comments are worth far more than likes — they are what puts a post in front of new people.'
    },
    'Reach': {
        strong: 'Your posts are being seen well beyond your own followers.',
        weak:   'Your posts are mostly only reaching people who already follow you.',
        why:    'Reaching past your followers is how the account grows without paying for it.'
    },
    'Amplification': {
        strong: 'People share your posts on.',
        weak:   'Your posts are rarely shared.',
        why:    'A share puts you in front of someone who trusts the person sharing.'
    },
    'Format range': {
        strong: 'You use a good mix of post types.',
        weak:   'You lean on one type of post.',
        why:    'Different formats reach different people, and a single format caps how far you go.'
    },
    'Profile completeness': {
        strong: 'Your profile tells a visitor who you are and how to reach you.',
        weak:   'Your profile is missing things a visitor needs to contact you.',
        why:    'Someone who likes a post and visits your profile should never have to search for how to buy.'
    },
    'Momentum adjustment': {
        strong: 'Your numbers are moving in the right direction.',
        weak:   'Your numbers are drifting down month over month.',
        why:    'The direction matters more than the size — a small account climbing beats a bigger one sliding.'
    }
};

function ordinal(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return null;
    const s = ['th', 'st', 'nd', 'rd'], m = v % 100;
    return v + (s[(m - 20) % 10] || s[m] || s[0]);
}

/**
 * How the account sits against the businesses it was compared with. This is
 * the question owners ask first and it is the one the employee report answers
 * least directly, because it buries it in a ranked table of handles.
 */
function clientStanding(row, bench, main) {
    const ranked = Array.isArray(bench.ranked) ? bench.ranked : [];
    const rank   = row.target_rank ?? (ranked.find(r => r.isTarget) || {}).rank ?? null;
    const of     = ranked.length || (bench.cohort && bench.cohort.accounts) || null;

    const yours  = parseFloat(row.engagement_rate ?? main.engagementRate ?? NaN);
    const avg    = parseFloat(row.cohort_avg_er ?? (bench.cohort || {}).avgEngagementRate ?? NaN);
    const haveEr = Number.isFinite(yours) && Number.isFinite(avg);

    let verdict = null;
    if (rank && of) {
        if (rank === 1)       verdict = `You are ahead of every business you were compared with.`;
        else if (rank === of) verdict = `You are behind the other ${of - 1} businesses you were compared with.`;
        else                  verdict = `You come ${ordinal(rank)} out of ${of} businesses like yours.`;
    }

    let gapLine = null;
    if (haveEr) {
        const diff = yours - avg;
        const pct  = Math.abs(diff).toFixed(2);
        gapLine = Math.abs(diff) < 0.05
            ? 'Your engagement is level with the others — no real gap either way.'
            : `For every 100 followers, you get about ${pct} ${diff > 0 ? 'more' : 'fewer'} reactions on a typical post than they do.`;
    }

    return {
        rank, of,
        verdict,
        gap: gapLine,
        yours: haveEr ? +yours.toFixed(2) : null,
        peer_average: haveEr ? +avg.toFixed(2) : null,
        ahead: haveEr ? yours >= avg : null,
        peers: ranked.map(r => ({
            name: r.isTarget ? 'You' : (r.handle ? '@' + r.handle : 'A similar business'),
            position: r.rank,
            is_you: !!r.isTarget
        }))
    };
}

/**
 * Splits the score pillars into what is working and what to change.
 *
 * The thresholds are deliberately wide apart. A pillar sitting mid-range is
 * neither a win nor a problem, and listing it as either would pad the page
 * with things the owner cannot act on.
 */
function clientPillars(breakdown) {
    const working = [], fix = [];
    for (const p of (Array.isArray(breakdown) ? breakdown : [])) {
        const copy = CLIENT_PILLARS[p.pillar];
        if (!copy || !p.max) continue;
        // A pillar that could not be measured is not a failing one.
        if (/not enough|no view counts|no trend/i.test(String(p.detail || ''))) continue;

        const share = Number(p.points) / Number(p.max);
        if (share >= 0.7)      working.push({ title: copy.strong, why: copy.why });
        else if (share <= 0.4) fix.push({ title: copy.weak, why: copy.why });
    }
    return { working, fix };
}

/**
 * A content plan, said to the person who has to make the posts.
 *
 * The employee plan is a scorecard of format x opening x length x topic cells
 * with a damped index on each. An owner does not run cells; they need to know
 * what to film on Tuesday. So the briefs come through with their script and
 * shot intact, and the cell machinery stays behind.
 */
function clientPlanIdeas(j) {
    const spec = Array.isArray(j.formatSpec) ? j.formatSpec : [];
    const out = [];

    for (const f of spec) {
        for (const b of (j.briefs?.[f.plural] || [])) {
            out.push({
                format: f.label || f.plural,
                concept: b.concept || null,
                hook: b.hook || null,
                script: Array.isArray(b.script) ? b.script : [],
                shot: b.shot || null,
                caption: b.caption || null,
                when: b.slot || null,
                // The band, never the index. "Likely to do well" is actionable;
                // "predicted index 1.28" invites an argument about the number.
                outlook: b.predicted_band || null,
                boost: b.boost === 'worth boosting' ? 'Worth putting money behind' : 'Post it organically',
                boost_why: b.boost_why || null
            });
        }
    }
    return out;
}

/**
 * A community audit, said to the business whose customers are in those rooms.
 *
 * Room value scores, unique-poster ratios and admin shares are how an agency
 * decides where to spend an afternoon. An owner wants to know which rooms are
 * worth being in and what people there are asking for.
 */
function clientRooms(row, j) {
    const names = Array.isArray(row.fb_group_names) ? row.fb_group_names : [];
    const rooms = Array.isArray(j.rooms) ? j.rooms : Array.isArray(j.audits) ? j.audits : [];

    if (rooms.length) {
        return rooms.slice(0, 12).map(r => ({
            name: r.name || r.group_name || 'A local group',
            members: r.member_count ?? r.members ?? null,
            // Three bands, because an owner is deciding whether to join, not
            // ranking twelve rooms against each other.
            worth: (r.room_value_score ?? r.roomValue ?? 0) >= 60 ? 'Worth being in'
                 : (r.room_value_score ?? r.roomValue ?? 0) >= 35 ? 'Worth a look'
                 : 'Quiet for you',
            posts_read: r.posts ?? r.postsAnalysed ?? null
        }));
    }
    // Older reports stored only the names.
    return names.slice(0, 12).map(n => ({ name: n, members: null, worth: null, posts_read: null }));
}

function clientReportView(row) {
    if (!row) return null;
    const j     = row.report_json || {};
    const main  = j.main || {};
    const bench = j.benchmark || {};

    const score = row.score ?? main.score ?? null;
    const band  = score === null ? null
                : score >= 80 ? 'strong'
                : score >= 65 ? 'healthy'
                : score >= 50 ? 'mixed'
                : score >= 35 ? 'weak'
                : 'poor';

    const HEADLINE = {
        strong:  'Your account is in good shape.',
        healthy: 'Your account is healthy, with one clear thing to fix.',
        mixed:   'Your account works, but it is underperforming for its size.',
        weak:    'There are some basics to fix before anything else will help.',
        poor:    'The fundamentals need attention first.'
    };

    // A plan and a community audit answer different questions from an audit,
    // so they get their own opening line rather than a score-band verdict.
    const isPlan  = row.report_type === 'content_plan';
    const isRooms = row.report_type === 'fb_community' || row.report_type === 'fb_group';
    const ideas   = isPlan  ? clientPlanIdeas(j)      : [];
    const rooms   = isRooms ? clientRooms(row, j)     : [];

    // A Facebook Page report and the two owner-side Meta reports carry their
    // findings in the narrative, not in an Instagram score breakdown. Until
    // phase 26 they fell through to the Instagram path and came out as an
    // empty page with a generic headline — "check their business report in
    // FB and Instagram" was half-built. The page draws {title, why} points,
    // a headline and a summary; that is what they become.
    const isFb    = row.report_type === 'fb_page';
    const isMeta  = row.report_type === 'meta_owned' || row.report_type === 'meta_monthly';
    const ai      = row.ai_json || j.ai || {};
    const li      = (arr, why) => (Array.isArray(arr) ? arr : []).filter(Boolean).slice(0, 6).map(t => ({ title: String(t), why }));
    const first   = t => String(t || '').split(/(?<=[.!?])\s+/)[0] || null;

    let { working, fix } = (isFb || isMeta)
        ? { working: [], fix: [] }
        : clientPillars(main.scoreBreakdown || main.breakdown || j.breakdown);
    if (isFb) {
        working = li(ai.what_is_working, 'Keep doing this');
        fix     = [...li(ai.what_is_failing, 'What held the Page back'), ...li(ai.quick_wins, 'Quick to do')];
    } else if (row.report_type === 'meta_owned') {
        working = li(ai.what_is_working, 'From your own numbers');
        fix     = [...li(ai.what_is_not, 'What is not landing'), ...li(ai.next_30_days, 'Next 30 days')];
    } else if (row.report_type === 'meta_monthly') {
        working = li(ai.what_worked, 'This month');
        fix     = [...li(ai.what_did_not, 'What did not'), ...li(ai.next_month, 'Next month')];
    }
    const narrativeHeadline = isFb
        ? (ai.state_of_the_page || first(ai.executive_summary) || 'Here is how your Page is doing.')
        : row.report_type === 'meta_monthly'
            ? (ai.headline || `${j.monthLabel || 'The month'} in review.`)
        : isMeta
            ? (first(ai.executive_summary) || 'Here is what your own numbers say.')
        : null;

    // Profile gaps are the cheapest wins on the page and the easiest for an
    // owner to action without help, so they are surfaced separately rather
    // than folded into the completeness pillar.
    const pc      = main.profileCompleteness || main.completeness || {};
    const missing = Array.isArray(pc.checks)
        ? pc.checks.filter(c => !c.ok).map(c => c.label)
        : [];

    const provisional = !!(main.lowConfidence || j.lowConfidence);

    return {
        id: row.id,
        type: row.report_type,
        platform: row.platform,
        handle: row.target_handle,
        date: row.snapshot_date || (row.created_at || '').slice(0, 10),
        posts_looked_at: row.posts_analyzed ?? null,

        headline: isPlan
                    ? (ideas.length ? `${ideas.length} things to post next.` : 'Your content plan.')
                : isRooms
                    ? (rooms.length ? `${rooms.length} local groups where your customers are talking.`
                                    : 'Your community report.')
                : narrativeHeadline
                    ? narrativeHeadline
                : band ? HEADLINE[band] : 'Here is how your account is doing.',
        band: isPlan || isRooms || isMeta ? null : band,

        // Present only on the type they belong to, so a page can render what
        // it is given without knowing the report types.
        ideas,
        rooms,
        // The letter grade is kept because it travels well in conversation;
        // the raw score is not, because a number out of 100 invites an
        // argument about the number instead of the finding.
        grade: row.grade || main.grade || null,

        provisional,
        provisional_note: provisional
            ? 'There were not many recent posts to look at, so treat this as a first read rather than a verdict.'
            : null,

        // A Page report's benchmark and an owner report have no peer table in
        // the Instagram shape; guessing one would put a made-up rank on the page.
        standing: (isFb || isMeta) ? null : clientStanding(row, bench, main),

        // Month-over-month movement, present only on a monthly report.
        movements: row.report_type === 'meta_monthly'
            ? (Array.isArray(j.deltas) ? j.deltas : []).map(d => ({ label: d.label, now: d.now, before: d.before ?? null, pct: d.pct ?? null, kind: d.kind }))
            : [],

        working,
        fix,

        profile: {
            complete_pct: pc.score ?? pc.percent ?? null,
            missing
        },

        summary: ((isFb || isMeta) && ai.executive_summary) || row.ai_summary || null,
        followers: row.followers_snapshot ?? main.followers ?? null,
        posts_per_week: row.posts_per_week ?? null
    };
}


// ===========================================================================
// OWNER ASSISTANT  (phase 15)
//
// A business owner asks a question in their own words and gets an answer
// built from their own data. Two tiers, and the difference between them is
// the whole upsell:
//
//   not connected — everything we could work out from the outside. Real, but
//                   it is what anyone looking at the account could see.
//   Meta connected — reach, saves, demographics, the numbers only the owner
//                   can see. Costs no Apify, which is why it is the thing
//                   worth putting in front of a trial.
//
// The model never writes SQL. It picks from bounded tools, each of which is
// an ordinary scoped query, so the blast radius of a bad model turn is a
// wrong sentence rather than a wrong read.
// ===========================================================================

const ASSISTANT_MAX_ROUNDS = parseInt(process.env.ASSISTANT_MAX_ROUNDS || '6', 10);
const ASSISTANT_HISTORY    = parseInt(process.env.ASSISTANT_HISTORY || '20', 10);

/**
 * One model turn with function calling.
 *
 * Deliberately a sibling of geminiCallDetailed rather than a refactor of it.
 * That one carries a JSON-repair path every report narrative depends on, and
 * the risk of breaking it is not worth the saved lines. This shares everything
 * that matters — the key pool, the cooldowns, the model chain, the dead-model
 * map — and only the loop body differs.
 */
async function geminiToolTurn(contents, functionDeclarations, { systemInstruction, userId, tag = 'assistant' } = {}) {
    const candidates = await geminiCandidates(userId);
    if (!candidates.length) return { ok: false, reason: 'no_key' };

    METRICS.gemini.calls += 1;

    const models = await geminiModelChain(candidates[0].key);
    let keyIdx = 0, modelIdx = 0, withThinking = true;
    const maxAttempts = 3 + candidates.length + models.length;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (keyIdx >= candidates.length) {
            keyIdx = 0;
            await new Promise(r => setTimeout(r, Math.min(2000 * Math.pow(2, attempt), 15000)));
        }
        if (modelIdx >= models.length) break;

        const cand = candidates[keyIdx];
        const model = models[modelIdx];

        const generationConfig = { temperature: 0.2, maxOutputTokens: 2048 };
        if (withThinking) {
            generationConfig.thinkingConfig = geminiIsThinkingLevelModel(model)
                ? { thinkingLevel: 'low' } : { thinkingBudget: 512 };
        }

        const body = {
            contents,
            generationConfig,
            ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
            ...(functionDeclarations?.length ? { tools: [{ functionDeclarations }] } : {})
        };

        try {
            const r = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
                { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cand.key },
                  body: JSON.stringify(body) });

            if (r.status === 429) {
                METRICS.gemini.retries += 1;
                if (cand.id) _geminiCoolLocal.set(cand.id, Date.now() + GEMINI_KEY_COOLDOWN_MS);
                await geminiMarkKey(cand.id, {
                    status: 'cooldown',
                    cooldown_until: new Date(Date.now() + GEMINI_KEY_COOLDOWN_MS).toISOString(),
                    last_error: '429'
                });
                keyIdx += 1; continue;
            }

            if (!r.ok) {
                const text = (await r.text()).slice(0, 400);
                if (r.status === 400 && /thinking/i.test(text) && withThinking) { withThinking = false; continue; }
                if ((r.status === 400 || r.status === 403) && /api key|API_KEY|permission|not valid/i.test(text)) {
                    await geminiMarkKey(cand.id, { status: 'invalid', last_error: text.slice(0, 200), fail_count: 99 });
                    keyIdx += 1; continue;
                }
                if (r.status === 404 || /model|not found|not supported/i.test(text)) {
                    _geminiDeadModels.set(model, Date.now());
                    modelIdx += 1; continue;
                }
                if (r.status >= 500) {
                    METRICS.gemini.retries += 1;
                    await new Promise(res => setTimeout(res, Math.min(2000 * Math.pow(2, attempt), 15000)));
                    continue;
                }
                METRICS.gemini.failed += 1;
                logger.error('assistant_gemini_failed', { tag, status: r.status, body: text });
                return { ok: false, reason: 'http_' + r.status };
            }

            await geminiMarkKey(cand.id, { last_used_at: new Date().toISOString(), status: 'active', cooldown_until: null });

            const json  = await r.json();
            const parts = json?.candidates?.[0]?.content?.parts || [];
            return {
                ok: true,
                parts,
                calls: parts.filter(p => p.functionCall).map(p => p.functionCall),
                text: parts.filter(p => p.text && !p.thought).map(p => p.text).join('').trim(),
                finishReason: json?.candidates?.[0]?.finishReason || null
            };
        } catch (e) {
            logger.warn('assistant_gemini_error', { tag, message: e.message, attempt });
            await new Promise(res => setTimeout(res, Math.min(1500 * Math.pow(2, attempt), 10000)));
        }
    }

    METRICS.gemini.failed += 1;
    return { ok: false, reason: 'exhausted' };
}

/**
 * What the assistant may read. Every tool is scoped to the asking account —
 * the scope is applied here, not passed in by the model, so no argument it
 * invents can widen it.
 */
const ASSISTANT_TOOLS = {
    get_monthly_report: {
        decl: {
            name: 'get_monthly_report',
            description: 'A finished monthly report built from owner-side Meta Insights: this month against last month across reach, engagement, profile visits and followers, plus the posts that performed and who the audience is. Use this for any question about a named month, "last month", "how did we do in September", or when asked to write up or summarise a month. It is the only source with month-over-month numbers — do not assemble a month by hand from other reports.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    month: { type: 'STRING', description: 'The month as YYYY-MM, for example 2026-08. Leave it out for the most recent month available.' }
                }
            }
        },
        run: async (s, a) => {
            let q = supabase.from('reports')
                .select('id, snapshot_date, target_handle, report_json, ai_json')
                .eq('report_type', 'meta_monthly').or(s.reportScope);
            const m = String(a.month || '');
            if (/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) q = q.eq('snapshot_date', `${m}-01`);
            const { data } = await q.order('snapshot_date', { ascending: false }).limit(1);
            const row = (data || [])[0];
            if (!row) {
                return {
                    available: false,
                    note: m ? `No monthly report exists for ${m}.` : 'No monthly report has been produced for this account yet.',
                    how: 'A monthly report needs Meta connected for this account, then one run for the month.'
                };
            }
            const r = row.report_json || {};
            // The whole payload is far more than a turn needs and would crowd
            // out the conversation. What comes back is what a person writing
            // the month up would actually cite.
            return {
                available: true,
                month: r.month, monthLabel: r.monthLabel,
                comparedWith: r.comparable ? r.prevMonthLabel : null,
                account: r.account,
                movements: (r.deltas || []).map(d => ({
                    metric: d.label, value: d.now, previous: d.before,
                    changePct: d.pct, direction: d.kind
                })),
                postsPublished: r.posting?.count ?? null,
                byFormat: r.posting?.formats || null,
                bestPosts: (r.posting?.topByReach || []).map(p => ({
                    kind: p.kind, reach: p.reach, saved: p.saved, shares: p.shares,
                    caption: p.caption, link: p.permalink
                })),
                audience: r.demographics || null,
                narrative: row.ai_json || null,
                missing: r.gaps || [],
                source: 'owner Meta Insights'
            };
        }
    },

    get_my_reports: {
        decl: {
            name: 'get_my_reports',
            description: 'The list of reports that exist for this business, newest first, with their date, type and overall band. Call this first when the user asks anything about how they are doing, so you know what you actually have.',
            parameters: { type: 'OBJECT', properties: {} }
        },
        run: async (s) => {
            const { data } = await supabase.from('reports')
                .select('id, report_type, target_handle, snapshot_date, created_at, grade, score')
                .or(s.reportScope).order('created_at', { ascending: false }).limit(20);
            return (data || []).map(r => ({
                id: r.id, type: r.report_type, handle: r.target_handle,
                date: r.snapshot_date || (r.created_at || '').slice(0, 10),
                grade: r.grade,
                band: r.score >= 80 ? 'strong' : r.score >= 65 ? 'healthy'
                    : r.score >= 50 ? 'mixed' : r.score >= 35 ? 'weak' : 'poor'
            }));
        }
    },

    get_report_detail: {
        decl: {
            name: 'get_report_detail',
            description: 'One report in full: the headline finding, how the business compares to similar businesses, what is working, what to change, and any gaps in their profile. Use the id from get_my_reports. This is the richest source you have — prefer it over guessing.',
            parameters: { type: 'OBJECT', properties: { report_id: { type: 'STRING' } }, required: ['report_id'] }
        },
        run: async (s, a) => {
            if (!UUID_RE.test(String(a.report_id || ''))) return { error: 'bad report id' };
            const { data } = await supabase.from('reports').select('*').eq('id', a.report_id).maybeSingle();
            if (!data) return { error: 'not found' };
            if (data.user_id !== s.userId && !(data.client_id && s.clientIds.includes(data.client_id))) {
                return { error: 'not found' };
            }
            return clientReportView(data);
        }
    },

    get_progress_over_time: {
        decl: {
            name: 'get_progress_over_time',
            description: 'How the overall score and engagement rate have moved across every Instagram report for this business, oldest first. Use for "are we improving", "is it working", "compared to last month".',
            parameters: { type: 'OBJECT', properties: {} }
        },
        run: async (s) => {
            const { data } = await supabase.from('reports')
                .select('snapshot_date, created_at, score, grade, engagement_rate, followers_snapshot, posts_per_week, cohort_avg_er')
                .or(s.reportScope).in('report_type', ['ig_report', 'deep_audit'])
                .order('created_at', { ascending: true }).limit(24);
            return (data || []).map(r => ({
                date: r.snapshot_date || (r.created_at || '').slice(0, 10),
                grade: r.grade,
                engagement_rate: r.engagement_rate,
                peer_average_engagement: r.cohort_avg_er,
                followers: r.followers_snapshot,
                posts_per_week: r.posts_per_week
            }));
        }
    },

    get_best_posts: {
        decl: {
            name: 'get_best_posts',
            description: 'This account\'s own posts from the most recent analysis, ranked by engagement, with format, caption, when it went out and how it did. Use for "what worked", "what should I post more of", "why did that one do well".',
            parameters: { type: 'OBJECT', properties: { limit: { type: 'INTEGER', description: 'default 8, max 20' } } }
        },
        run: async (s, a) => {
            const { data } = await supabase.from('posts')
                .select('caption, post_type, likes, comments, views, posted_at, engagement_raw, hashtags, post_url')
                .eq('user_id', s.userId)
                .order('engagement_raw', { ascending: false })
                .limit(Math.min(parseInt(a.limit, 10) || 8, 20));
            return (data || []).map(p => ({
                format: p.post_type,
                posted_at: p.posted_at,
                caption: String(p.caption || '').slice(0, 220),
                likes: p.likes, comments: p.comments, views: p.views,
                hashtags: (p.hashtags || []).slice(0, 8)
            }));
        }
    },

    get_best_times: {
        decl: {
            name: 'get_best_times',
            description: 'When this account\'s posts do best, by day of week and hour, from its own history. Use for "when should I post".',
            parameters: { type: 'OBJECT', properties: {} }
        },
        run: async (s) => {
            const { data } = await supabase.from('posts')
                .select('hour_local, dow_local, engagement_raw')
                .eq('user_id', s.userId).limit(500);
            if (!data || data.length < 8) return { error: 'not enough posts analysed yet to say anything useful about timing' };
            return timeHeatmap(data);
        }
    },

    get_community_demand: {
        decl: {
            name: 'get_community_demand',
            description: 'Real posts from local Facebook groups where somebody is asking for what this business sells — the request, how urgent it reads, and when it was posted. Authors are anonymous by design. Use for "who needs me right now", "what are people asking for".',
            parameters: { type: 'OBJECT', properties: { limit: { type: 'INTEGER', description: 'default 10, max 25' } } }
        },
        run: async (s, a) => {
            const { data } = await supabase.from('fb_demand_signals')
                .select('snippet, intent, urgency, category, group_name, posted_at, lead_score')
                .eq('user_id', s.userId)
                .order('posted_at', { ascending: false })
                .limit(Math.min(parseInt(a.limit, 10) || 10, 25));
            return (data || []).map(d => ({
                asking_for: String(d.snippet || '').slice(0, 240),
                kind: d.intent, urgency: d.urgency, category: d.category,
                group: d.group_name, posted_at: d.posted_at
            }));
        }
    },

    get_owner_insights: {
        decl: {
            name: 'get_owner_insights',
            description: 'The numbers only the account owner can see, from a connected Meta account: reach, impressions, profile visits, saves and audience demographics. Only available when the business has connected Meta. If it returns not_connected, say plainly that connecting Meta would let you answer that properly — do not guess at these figures from anything else.',
            parameters: { type: 'OBJECT', properties: { days: { type: 'INTEGER', description: 'how far back, default 30' } } }
        },
        run: async (s, a) => {
            if (!s.metaConnected) {
                return { not_connected: true,
                         note: 'This business has not connected Meta, so owner-only numbers are unavailable.' };
            }
            const days  = Math.min(Math.max(parseInt(a.days, 10) || 30, 1), 90);
            const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
            const { data } = await supabase.from('meta_snapshots')
                .select('snapshot_date, level, metrics')
                .eq('user_id', s.userId).gte('snapshot_date', since)
                .order('snapshot_date', { ascending: true }).limit(120);
            if (!data || !data.length) {
                return { connected_but_empty: true,
                         note: 'Meta is connected but no insights have synced yet.' };
            }
            return { days, snapshots: data };
        }
    }
};

function assistantDeclarations() {
    return Object.values(ASSISTANT_TOOLS).map(t => t.decl);
}

/**
 * The voice. Most of this is about what NOT to do: a business owner asking
 * how their Instagram is doing will believe a confident number, so the cost
 * of inventing one is higher than the cost of saying there is no data.
 */
function assistantSystemPrompt(scope) {
    // Two readers, one set of numbers. An owner wants to know what to do on
    // Monday; an operator is building a deliverable and needs the mechanics,
    // the caveats and the wording they can hand on. Writing one prompt for
    // both produces an answer that patronises the operator and overwhelms the
    // owner, so the register splits here and the access rules do not.
    const operator = scope.audience === 'operator';
    const who = scope.client?.name ? `the account "${scope.client.name}"` : 'this business';

    const common = [
        '- Lead with the answer. Put the reasoning after it, only if it helps.',
        '- Numbers are for support, not decoration. One or two that matter beat ten that do not.',
        '- Never invent a figure. If a tool did not return it, say you do not have it and say what would get it.',
        '- Scraped numbers and owner-only Meta numbers are different things and are never averaged, added or compared as if they were the same measurement. If you use both, say which is which.'
    ];

    return [
        operator
            ? `You are EdgeLead's analyst. You work alongside an agency operator who is managing ${who} on behalf of a client. They are a professional: they know the platforms, they are building something they will put their name on.`
            : 'You are EdgeLead\'s assistant. You help the owner of a small business understand their own social media.',
        '',
        'How to answer:',
        operator
            ? '- Talk like a sharp colleague. Be direct, skip the encouragement, do not explain what engagement rate is.'
            : '- Talk like a knowledgeable friend, not a dashboard. Short paragraphs, no bullet-point dumps unless asked for a list.',
        ...common,
        operator
            ? '- When something in the data is weak, ambiguous or too small a sample to act on, say so plainly. They would rather hear it from you than from their client.'
            : '- Never mention tools, reports ids, databases, scraping, Apify, or how any of this is built.',
        operator
            ? '- If they ask for something they can send to a client, write it in the client\'s language: no internal metric names, no tool names, no hedging they would have to strip out.'
            : '',
        '',
        'What you can see:',
        scope.metaConnected
            ? `- ${operator ? 'This account has' : 'This business has'} connected Meta, so you can also see owner-only numbers: reach, saves, profile visits and demographics.`
            : (operator
                ? '- Meta is NOT connected for this account, so there are no owner-only numbers: no reach, saves, impressions, profile visits or demographics. Everything you have is observable from outside. Say which is missing when it matters; do not pitch connecting, they already know.'
                : '- This business has NOT connected Meta. You can only see what is visible from outside the account. If they ask about reach, saves, impressions, profile visits or who their audience is, say plainly that those are owner-only numbers and connecting Meta would let you answer properly. Say it once, naturally, not as a sales pitch every time.'),
        scope.handle ? `- ${operator ? 'The' : 'Their'} Instagram is @${scope.handle}.` : '',
        operator && scope.client?.niche ? `- Niche: ${scope.client.niche}${scope.client.location ? `, in ${scope.client.location}` : ''}.` : '',
        operator && scope.clientId
            ? '- You are scoped to this one client. You cannot see the operator\'s other clients from here, so do not compare against them or refer to them.'
            : '',
        `- Today is ${new Date().toISOString().slice(0, 10)}.`,
        '',
        'If you have no data at all for what they asked, say so in one sentence and suggest the one thing that would fix it.'
    ].filter(Boolean).join('\n');
}

/** Everything a tool needs to stay inside one account, resolved once. */
/**
 * What one assistant conversation is allowed to see.
 *
 * `clientId` narrows the whole thing to a single client. An employee running
 * eight accounts asking "how did last month go" must not get an answer blended
 * across all eight — and the model cannot be trusted to keep them apart on its
 * own, so the narrowing happens here and the tools never receive an account
 * argument at all (tested in phase15).
 *
 * `audience` is who is reading, not what they may read: an owner and an
 * operator get the same numbers and a different register. Access is still
 * decided by scope; this only changes how the answer is written.
 */
async function assistantScope(userId, clientId = null, role = null) {
    const wanted = clientId && UUID_RE.test(String(clientId)) ? String(clientId) : null;

    const [{ data: memberships }, { data: owned }, { data: prof }] = await Promise.all([
        supabase.from('client_members').select('client_id').eq('user_id', userId),
        supabase.from('clients').select('id, name, ig_handle, fb_page, niche, location, competitors').eq('owner_user_id', userId),
        supabase.from('reports').select('target_handle').eq('user_id', userId)
            .order('created_at', { ascending: false }).limit(1)
    ]);

    const clientIds = [...new Set([
        ...(memberships || []).map(m => m.client_id),
        ...(owned || []).map(c => c.id)
    ])].filter(Boolean);

    // A client id the caller has no access to is dropped rather than refused:
    // the request still answers, just over their own data. Refusing would let
    // a stale picker selection break an otherwise valid question.
    const scoped = wanted && clientIds.includes(wanted) ? wanted : null;
    let client = (owned || []).find(c => c.id === scoped) || null;
    if (scoped && !client) {
        const { data } = await supabase.from('clients')
            .select('id, name, ig_handle, fb_page, niche, location, competitors').eq('id', scoped).maybeSingle();
        client = data || null;
    }

    // Meta is checked against the same narrowing. A connection filed under a
    // different client must not make THIS client look connected, or the
    // assistant will confidently offer owner numbers it cannot read.
    let cq = supabase.from('meta_connections').select('id').eq('status', 'active');
    cq = scoped ? cq.eq('client_id', scoped) : cq.eq('user_id', userId);
    const { data: conn } = await cq.limit(1);

    const ors = scoped
        ? [`client_id.eq.${scoped}`]
        : [`user_id.eq.${userId}`, ...(clientIds.length ? [`client_id.in.(${clientIds.join(',')})`] : [])];

    return {
        userId,
        role,
        audience: role === 'client' ? 'owner' : 'operator',
        clientIds,
        clientId: scoped,
        client,
        reportScope: ors.join(','),
        metaConnected: !!(conn && conn.length),
        handle: client?.ig_handle
            || (scoped ? null : (owned || []).find(c => c.ig_handle)?.ig_handle || prof?.[0]?.target_handle)
            || null
    };
}

/**
 * Run one question to an answer.
 *
 * onEvent receives status updates as tools run. Token-level streaming is
 * deliberately not done: it would mean streaming every model turn including
 * the ones that turn out to be tool calls, and the win over "I'm reading your
 * September report" is small.
 */
async function assistantAnswer({ userId, message, conversationId, clientId = null, role = null, onEvent }) {
    const emit = ev => { try { if (onEvent) onEvent(ev); } catch (e) { logger.warn('assistant_emit', { message: e.message }); } };

    const scope = await assistantScope(userId, clientId, role);

    // Thread: reuse if it belongs to this user, otherwise start one.
    let conv = null;
    if (conversationId && UUID_RE.test(String(conversationId))) {
        const { data } = await supabase.from('ai_conversations')
            .select('*').eq('id', conversationId).eq('user_id', userId).maybeSingle();
        conv = data || null;
        // A thread belongs to the client it was started under. Carrying it to
        // a different client would silently re-answer eight turns of history
        // about account A as if they had been about account B.
        if (conv && (conv.client_id || null) !== (scope.clientId || null)) conv = null;
    }
    if (!conv) {
        const { data } = await supabase.from('ai_conversations').insert([{
            user_id: userId,
            client_id: scope.clientId,
            title: String(message || '').slice(0, 80) || 'New conversation'
        }]).select().single();
        conv = data;
    }

    const { data: history } = await supabase.from('ai_messages')
        .select('role, content').eq('conversation_id', conv.id)
        .order('created_at', { ascending: true }).limit(ASSISTANT_HISTORY);

    await supabase.from('ai_messages').insert([{ conversation_id: conv.id, role: 'user', content: message }]);

    const contents = [
        ...(history || []).map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        { role: 'user', parts: [{ text: message }] }
    ];

    const STATUS = {
        get_monthly_report:    'Pulling the monthly numbers',
        get_my_reports:        'Looking at your reports',
        get_report_detail:     'Reading your report',
        get_progress_over_time:'Checking how things have moved',
        get_best_posts:        'Going through your posts',
        get_best_times:        'Working out your best times',
        get_community_demand:  'Checking what people are asking for',
        get_owner_insights:    'Reading your Meta numbers'
    };

    const used = [];
    let answer = '';

    for (let round = 0; round < ASSISTANT_MAX_ROUNDS; round++) {
        const turn = await geminiToolTurn(contents, assistantDeclarations(), {
            systemInstruction: assistantSystemPrompt(scope), userId, tag: 'assistant'
        });

        if (!turn.ok) {
            answer = turn.reason === 'no_key'
                ? 'The assistant is not switched on for this account yet.'
                : 'I could not get an answer together just then. Try asking again in a moment.';
            break;
        }

        if (!turn.calls.length) {
            answer = turn.text || 'I could not put an answer together for that one. Try asking it a different way.';
            break;
        }

        contents.push({ role: 'model', parts: turn.parts });
        emit({ type: 'status', label: [...new Set(turn.calls.map(c => STATUS[c.name] || 'Reading your data'))].join(' · ') });

        // Independent reads, so they go together rather than one after another.
        const settled = await Promise.all(turn.calls.map(async fc => {
            const tool = ASSISTANT_TOOLS[fc.name];
            let result;
            try { result = tool ? await tool.run(scope, fc.args || {}) : { error: 'unknown tool' }; }
            catch (e) { logger.warn('assistant_tool_failed', { tool: fc.name, message: e.message }); result = { error: e.message }; }
            return { fc, result };
        }));

        contents.push({
            role: 'user',
            parts: settled.map(({ fc, result }) => {
                used.push(fc.name);
                return { functionResponse: { name: fc.name, response: { result } } };
            })
        });
    }

    if (!answer) answer = 'That turned into more digging than I could finish. Try narrowing the question.';

    await supabase.from('ai_messages').insert([{
        conversation_id: conv.id, role: 'assistant', content: answer,
        tools: used.length ? used : null
    }]);
    await supabase.from('ai_conversations')
        .update({ updated_at: new Date().toISOString() }).eq('id', conv.id);

    return {
        answer, conversationId: conv.id, used: [...new Set(used)],
        metaConnected: scope.metaConnected,
        clientId: scope.clientId, clientName: scope.client?.name || null
    };
}

/**
 * The client's own reports.
 *
 * Deliberately a separate endpoint rather than a flag on the employee vault.
 * That one selects credits_estimate, set_id, source_report_ids and competitor
 * handles, and the reliable way to keep those off the client surface is for
 * the client surface to have an endpoint that never selects them in the first
 * place — rather than a filter somebody has to remember to apply.
 */
app.get('/api/client/reports', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;

        const [{ data: memberships }, { data: owned }] = await Promise.all([
            supabase.from('client_members').select('client_id').eq('user_id', ctx.user.id),
            supabase.from('clients').select('id').eq('owner_user_id', ctx.user.id)
        ]);
        const clientIds = [...new Set([
            ...(memberships || []).map(m => m.client_id),
            ...(owned || []).map(c => c.id)
        ])].filter(Boolean);

        const ors = [`user_id.eq.${ctx.user.id}`];
        if (clientIds.length) ors.push(`client_id.in.(${clientIds.join(',')})`);

        const { data, error } = await supabase.from('reports')
            .select('id, report_type, platform, target_handle, snapshot_date, created_at, grade, score')
            .or(ors.join(','))
            .order('created_at', { ascending: false })
            .limit(60);
        if (error) throw error;

        // Keyed by reports.report_type — the value the row actually carries.
        // Two of these were job-type names (fb_page_report, fb_community_audit)
        // that no row has ever carried, so a client's Facebook report showed
        // as "Report". The wiring audit now checks this map against every
        // report_type the server writes.
        const TITLES = {
            ig_report:    'Instagram check-up',
            deep_audit:   'Instagram deep dive',
            fb_page:      'Facebook page check-up',
            fb_community: 'Community report',
            fb_group:     'Community report',
            content_plan: 'Content plan',
            meta_owned:   'Owner report',
            meta_monthly: 'Monthly report'
        };

        res.json({
            reports: (data || []).map(r => ({
                id: r.id,
                title: TITLES[r.report_type] || 'Report',
                handle: r.target_handle,
                platform: r.platform,
                date: r.snapshot_date || (r.created_at || '').slice(0, 10),
                grade: r.grade || null,
                // A band, never the raw score. A number out of 100 invites an
                // argument about the number instead of the finding.
                band: r.score === null || r.score === undefined ? null
                    : r.score >= 80 ? 'strong'
                    : r.score >= 65 ? 'healthy'
                    : r.score >= 50 ? 'mixed'
                    : r.score >= 35 ? 'weak' : 'poor'
            }))
        });
    } catch (err) { sendErr(res, err); }
});

/**
 * Ask the assistant.
 *
 * Streams when asked to, because a tool round can take fifteen seconds and a
 * chat that sits silent that long reads as broken. The stream carries status,
 * not tokens — see assistantAnswer.
 *
 * Rate limited by address rather than metered like a job: this spends Gemini,
 * not Apify, and the key pool has its own cooldowns underneath.
 */
app.post('/api/assistant/ask', rateLimit({ windowMs: 60000, max: 12 }), async (req, res) => {
    const ctx = await auth(req, res); if (!ctx) return;

    const message = String(req.body?.message || '').trim().slice(0, 2000);
    if (!message) return res.status(400).json({ error: 'Ask a question first.' });
    const conversationId = req.body?.conversationId || null;
    // EL.api puts the selected client on every body automatically, so an
    // employee's question is scoped by the header picker without the page
    // having to think about it.
    const clientId = req.body?.clientId || null;
    const role = ctx.profile?.role || null;

    if (String(req.query.stream || '') !== '1') {
        try {
            res.json(await assistantAnswer({ userId: ctx.user.id, message, conversationId, clientId, role }));
        } catch (err) { sendErr(res, err); }
        return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Render sits behind a proxy that will otherwise buffer the whole response
    // and deliver it at the end, which defeats the point entirely.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ } };
    const beat = setInterval(() => { try { res.write(': keepalive\n\n'); } catch { /* client gone */ } }, 15000);

    try {
        const out = await assistantAnswer({
            userId: ctx.user.id, message, conversationId, clientId, role,
            onEvent: ev => send('status', ev)
        });
        send('done', out);
    } catch (err) {
        logger.error('assistant_failed', { message: err.message, stack: (err.stack || '').slice(0, 400) });
        send('error', { error: 'Something went wrong answering that. Try again in a moment.' });
    } finally {
        clearInterval(beat);
        res.end();
    }
});

/** This account's threads, newest first. */
app.get('/api/assistant/conversations', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        // Threads follow the selected client. `.is('client_id', null)` rather
        // than leaving the filter off: with no client selected you want your
        // own threads, not a list mixing in every client you manage.
        const cid = String(req.query.client_id || '');
        let q = supabase.from('ai_conversations')
            .select('id, title, client_id, created_at, updated_at')
            .eq('user_id', ctx.user.id);
        q = UUID_RE.test(cid) ? q.eq('client_id', cid) : q.is('client_id', null);
        const { data, error } = await q.order('updated_at', { ascending: false }).limit(40);
        if (error) throw error;
        res.json({ conversations: data || [] });
    } catch (err) { sendErr(res, err); }
});

/** One thread's turns. Ownership is checked on the thread, not the messages. */
app.get('/api/assistant/conversation/:id', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        if (!UUID_RE.test(String(req.params.id))) return res.status(400).json({ error: 'Bad conversation id.' });

        const { data: conv } = await supabase.from('ai_conversations')
            .select('id, title').eq('id', req.params.id).eq('user_id', ctx.user.id).maybeSingle();
        if (!conv) return res.status(404).json({ error: 'Conversation not found.' });

        const { data: messages } = await supabase.from('ai_messages')
            .select('role, content, created_at').eq('conversation_id', conv.id)
            .order('created_at', { ascending: true }).limit(200);

        res.json({ conversation: conv, messages: messages || [] });
    } catch (err) { sendErr(res, err); }
});

/**
 * The client's own leads. /api/search-leads needs a search term and returns
 * the full row including campaign bookkeeping; a client browsing what they
 * found wants neither.
 */
app.get('/api/client/leads', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;

        // Their own draws, plus everything an agency found FOR them under
        // their business record. Before phase 24 this was the first half
        // only, so a client whose agency had just found forty leads for them
        // saw none of them here.
        const own = ctx.profile?.role === 'client' ? await ownClientFor(ctx).catch(() => null) : null;
        const { data: links } = own
            ? await supabase.from('client_leads').select('lead_id').eq('client_id', own.id)
            : { data: [] };
        const linkedIds = (links || []).map(l => l.lead_id);

        const cols = 'id, owner_user_id, username, full_name, email, phone, whatsapp, website, category, city, followers_count, profile_url, is_enriched, platform, created_at';
        const [{ data: mine, error }, { data: forYou }] = await Promise.all([
            supabase.from('leads').select(cols).eq('owner_user_id', ctx.user.id).order('created_at', { ascending: false }).limit(200),
            linkedIds.length
                ? supabase.from('leads').select(cols).in('id', linkedIds).order('created_at', { ascending: false }).limit(400)
                : Promise.resolve({ data: [] })
        ]);
        if (error) throw error;

        const data = dedupeLeads([...(mine || []), ...(forYou || [])])
            .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        const foundForYou = data.filter(l => l.owner_user_id !== ctx.user.id).length;

        res.json({
            yours: data.length - foundForYou,
            foundForYou,
            leads: (data || []).map(l => ({
                foundForYou: l.owner_user_id !== ctx.user.id,
                username: l.username,
                platform: l.platform || 'instagram',
                name: l.full_name || null,
                category: l.category || null,
                city: l.city || null,
                followers: l.followers_count ?? null,
                email: l.email || null,
                phone: l.phone || null,
                whatsapp: l.whatsapp || null,
                website: l.website || null,
                url: l.profile_url || ('https://instagram.com/' + l.username),
                // An un-enriched row is a username and nothing else yet, which
                // is worth saying rather than rendering as a contact with every
                // field blank.
                enriched: !!l.is_enriched
            }))
        });
    } catch (err) { sendErr(res, err); }
});

/**
 * A demand signal, said in owner language.
 *
 * The employee feed shows intent, urgency, lead_score and a matched phrase,
 * which is the right shape for someone deciding where to spend an afternoon.
 * An owner is asking one question — is this worth replying to, and how soon —
 * so the scores collapse into a stance and the jargon goes.
 *
 * The author is not here and cannot be: the group pipeline hashes identity on
 * the way in, one-way. That is deliberate, and the copy says so rather than
 * leaving a blank where a name should be.
 */
const DEMAND_INTENT = {
    recommendation_request: 'Asking for a recommendation',
    question:               'Asking a question',
    buy_sell:               'Looking to buy',
    hiring:                 'Looking to hire',
    event:                  'Planning something',
    offer:                  'Offering something',
    complaint:              'Unhappy with someone else',
    story:                  'Sharing an experience'
};

function clientDemandView(row) {
    if (!row) return null;

    const urgency = String(row.urgency || 'low').toLowerCase();
    return {
        asking_for: String(row.snippet || '').slice(0, 320),
        kind: DEMAND_INTENT[row.intent] || 'Mentioned you might help',
        // Three bands become two words an owner can act on. "Medium" tells
        // nobody anything; "worth a reply today" does.
        stance: urgency === 'high' ? 'Reply today'
              : urgency === 'medium' ? 'Worth a reply'
              : 'Keep an eye on it',
        urgent: urgency === 'high',
        group: row.group_name || null,
        posted_at: row.posted_at || null,
        // Present so the page can say why no name is shown, rather than
        // rendering an empty author line.
        author_shown: false
    };
}

/** What people near this business are asking for. */
app.get('/api/client/demand', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;

        const { data, error } = await supabase.from('fb_demand_signals')
            .select('snippet, intent, urgency, group_name, posted_at, lead_score')
            .eq('user_id', ctx.user.id)
            .order('posted_at', { ascending: false })
            .limit(100);
        if (error) throw error;

        res.json({ demand: (data || []).map(clientDemandView) });
    } catch (err) { sendErr(res, err); }
});

/** One report, said in owner language. Same authorisation rule as the vault. */
app.get('/api/client/report/:id', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        if (!UUID_RE.test(String(req.params.id))) return res.status(400).json({ error: 'Bad report id.' });

        const { data: row } = await supabase.from('reports')
            .select('*').eq('id', req.params.id).maybeSingle();
        if (!row || !(await canReadReport(ctx, row))) {
            return res.status(404).json({ error: 'Report not found.' });
        }
        res.json({ report: clientReportView(row) });
    } catch (err) { sendErr(res, err); }
});

app.post('/api/share', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const { reportId, expiresDays, label } = req.body || {};
        if (!reportId || !UUID_RE.test(String(reportId))) return res.status(400).json({ error: 'reportId required.' });
        const { data: rep } = await supabase.from('reports').select('id, user_id, client_id, report_type, target_handle').eq('id', reportId).maybeSingle();
        if (!rep || !(await canReadReport(ctx, rep))) return res.status(404).json({ error: 'Report not found.' });

        const days = Math.min(SHARE_MAX_DAYS, Math.max(1, parseInt(expiresDays || SHARE_DEFAULT_DAYS, 10) || SHARE_DEFAULT_DAYS));
        const token = shareToken();
        const { data, error } = await supabase.from('report_shares').insert([{
            token, report_id: rep.id, user_id: ctx.user.id, client_id: rep.client_id || null,
            label: String(label || '').trim().slice(0, 120) || null,
            expires_at: new Date(Date.now() + days * 86400000).toISOString()
        }]).select().single();
        if (error) throw error;
        res.status(201).json({ success: true, share: data, url: shareUrlFor(rep, token) });
    } catch (err) { sendErr(res, err); }
});

app.get('/api/shares', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        let q = supabase.from('report_shares').select('*, reports!inner(id, report_type, target_handle, created_at, client_id)');
        const cid = req.query?.client_id;
        const rid = req.query?.report_id;
        if (rid && UUID_RE.test(String(rid))) {
            const { data: rep } = await supabase.from('reports').select('id, user_id, client_id').eq('id', rid).maybeSingle();
            if (!rep || !(await canReadReport(ctx, rep))) return res.status(404).json({ error: 'Report not found.' });
            q = q.eq('report_id', rep.id);
        } else if (cid) {
            const c = await clientAccess(ctx.user.id, cid, 'viewer');
            if (!c) return res.status(403).json({ error: 'No access to that client.' });
            q = q.eq('client_id', c.id);
        } else {
            q = q.eq('user_id', ctx.user.id);
        }
        const { data, error } = await q.order('created_at', { ascending: false }).limit(200);
        if (error) throw error;
        const now = Date.now();
        res.json({ shares: (data || []).map(s => ({
            ...s, mine: s.user_id === ctx.user.id,
            active: !s.revoked_at && new Date(s.expires_at).getTime() > now,
            url: shareUrlFor(s.reports || {}, s.token)
        })) });
    } catch (err) { sendErr(res, err); }
});

app.delete('/api/share/:id', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const { data: s } = await supabase.from('report_shares').select('id, user_id, client_id').eq('id', req.params.id).maybeSingle();
        const may = s && (s.user_id === ctx.user.id || (s.client_id && await clientAccess(ctx.user.id, s.client_id, 'editor')));
        if (!may) return res.status(404).json({ error: 'Share not found.' });
        await supabase.from('report_shares').update({ revoked_at: new Date().toISOString() }).eq('id', s.id);
        res.json({ success: true });
    } catch (err) { sendErr(res, err); }
});

/** PUBLIC. No auth. The token is the credential. */
app.get('/api/public/share/:token', publicLimit, async (req, res) => {
    try {
        const token = String(req.params.token || '');
        if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return res.status(404).json({ error: 'Link not found.' });
        const { data: s } = await supabase.from('report_shares').select('*').eq('token', token).maybeSingle();
        if (!s || s.revoked_at) return res.status(404).json({ error: 'This link has been turned off.' });
        if (new Date(s.expires_at).getTime() < Date.now()) return res.status(410).json({ error: 'This link has expired. Ask for a new one.' });
        const { data: rep } = await supabase.from('reports').select('*').eq('id', s.report_id).maybeSingle();
        if (!rep) return res.status(404).json({ error: 'The report behind this link was deleted.' });
        let client = null;
        if (rep.client_id) {
            const { data: c } = await supabase.from('clients').select('name, brand').eq('id', rep.client_id).maybeSingle();
            client = c || null;
        }
        supabase.from('report_shares').update({ views: (s.views || 0) + 1, last_viewed_at: new Date().toISOString() })
            .eq('id', s.id).then(() => {}, () => {});
        res.set('Cache-Control', 'no-store');
        // The client view, not the employee one.
        //
        // publicReportView only stripped ownership columns — everything else
        // went out: every pillar score, every competitor handle, the whole
        // agency-language report. A share link is the thing an employee hands
        // a client, so it now carries what a client should read, and the
        // internals simply are not in the payload to leak.
        //
        // Types clientReportView cannot translate yet (content plans, community
        // audits) degrade to headline, date and summary rather than falling
        // back to the raw report.
        res.json({
            report: clientReportView(rep),
            client,
            shared: { expiresAt: s.expires_at, label: s.label, page: 'share.html' }
        });
    } catch (err) { sendErr(res, err); }
});

// ===========================================================================
// PHASE 11 :: SINGLE-INSTANCE GUARD
//
// Rate-limit buckets, the auth cache, Gemini cooldowns and the auto-resume
// tracker are per-process Maps. That is fine on one Render instance and wrong
// on two. Rather than silently degrade, every instance heartbeats into
// system_settings and alarms if it sees another live heartbeat. This does not
// make two instances safe; it makes the mistake visible within a minute.
// ===========================================================================

const INSTANCE_ID = crypto.randomBytes(6).toString('hex');
const INSTANCE_BEAT_MS = 30000;
let _multiInstanceSeen = false;

async function instanceHeartbeat() {
    try {
        const now = Date.now();
        await supabase.from('system_settings').upsert({
            key: 'instance_heartbeat:' + INSTANCE_ID,
            value: JSON.stringify({ t: now, version: APP_VERSION, pid: process.pid }),
            updated_at: new Date(now).toISOString()
        }, { onConflict: 'key' });

        const { data } = await supabase.from('system_settings').select('key, value').like('key', 'instance_heartbeat:%');
        const others = (data || []).filter(r => r.key !== 'instance_heartbeat:' + INSTANCE_ID).map(r => {
            try { return { key: r.key, ...(JSON.parse(r.value || '{}')) }; } catch { return { key: r.key, t: 0 }; }
        });
        const live = others.filter(o => now - Number(o.t || 0) < INSTANCE_BEAT_MS * 3);
        const stale = others.filter(o => now - Number(o.t || 0) > 86400000);
        if (stale.length) {
            await supabase.from('system_settings').delete().in('key', stale.map(s => s.key));
        }
        METRICS.instances = { self: INSTANCE_ID, live: 1 + live.length };
        if (live.length && !_multiInstanceSeen) {
            _multiInstanceSeen = true;
            logger.error('multiple_instances', { self: INSTANCE_ID, others: live.map(o => o.key) });
            alertOnce('multiple_instances',
                `${1 + live.length} server instances are running. Rate limits, Gemini cooldowns and cancel/resume state are per-process — scale back to one instance.`,
                { self: INSTANCE_ID, others: live.map(o => o.key) });
        } else if (!live.length) {
            _multiInstanceSeen = false;
        }
    } catch (e) { logger.warn('instance_heartbeat_failed', { message: e.message }); }
}


// Boot: warm the Gemini pool so geminiAvailable() is truthful from the start.
loadGeminiPool(true).then(rows => logger.info('gemini_pool', { keys: rows.length, env: !!GEMINI_API_KEY, model: GEMINI_MODEL }));
setInterval(() => loadGeminiPool(true).catch(() => {}), 300000).unref?.();

app.use('/api', (req, res) => {
    res.status(404).json({
        error: `No such endpoint: ${req.method} ${req.path}`,
        hint: 'Check the path, or the frontend may be newer than the deployed server.'
    });
});

/**
 * The last line. Anything a route threw synchronously, or handed to next(),
 * lands here as JSON instead of a stack trace in an HTML page.
 */
app.use((err, req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    METRICS.http.errors += 1;
    logger.error('unhandled_route_error', {
        method: req.method, path: req.path, status,
        message: err.message, stack: (err.stack || '').slice(0, 600)
    });
    if (res.headersSent) return;
    res.status(status).json({
        error: status >= 500 ? 'Something went wrong on the server.' : (err.message || 'Request failed'),
        // A malformed JSON body is the common 400 here and the caller can fix it.
        detail: status < 500 ? err.message : undefined
    });
});

function decryptWithOldKey(stored) {
    if (!ENC_KEY_OLD) throw new Error('APP_ENCRYPTION_KEY_OLD is not set');
    if (!stored) return stored;
    if (!isEncrypted(stored)) return stored;          // legacy plaintext row
    // Same wire format as decryptSecret(): encv1:<iv>:<tag>:<ct>, base64 each.
    const [, ivB, tagB, ctB] = String(stored).split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', ENC_KEY_OLD, Buffer.from(ivB, 'base64'));
    d.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ctB, 'base64')), d.final()]).toString('utf8');
}

/**
 * Re-wrap every stored secret under the current key.
 *
 * dryRun defaults to true. A rotation that cannot be rehearsed is a rotation
 * nobody runs until the incident, which is the worst possible time to find out
 * one of the rows will not decrypt.
 */
async function rotateEncryptionKey({ dryRun = true } = {}) {
    if (!ENC_KEY)     return { error: 'APP_ENCRYPTION_KEY is not set — nothing to rotate to.' };
    if (!ENC_KEY_OLD) return { error: 'APP_ENCRYPTION_KEY_OLD is not set — nothing to rotate from.' };
    if (ENC_KEY.equals(ENC_KEY_OLD)) return { error: 'Old and new keys are identical.' };

    const report = { dryRun, keys: { total: 0, rotated: 0, failed: 0 },
                     primaries: { total: 0, rotated: 0, failed: 0 }, failures: [] };

    // A secret may be encrypted under the old key, under the new key already
    // (a partial previous run), or sitting in plaintext. Try each in turn and
    // record which path worked, so a resumed rotation is idempotent.
    const recover = (stored, label) => {
        if (!isEncrypted(stored)) return { plain: stored, via: 'plaintext' };
        try { return { plain: decryptSecret(stored, { currentKeyOnly: true }), via: 'already-new' }; } catch (_) {}
        try { return { plain: decryptWithOldKey(stored), via: 'old-key' }; } catch (e) {
            report.failures.push({ item: label, message: e.message });
            return null;
        }
    };

    // --- apify_keys --------------------------------------------------------
    try {
        const { data: rows, error } = await supabase.from('apify_keys').select('id, token, token_hash');
        if (error) throw new Error(error.message);

        for (const row of rows || []) {
            report.keys.total += 1;
            const rec = recover(row.token, `apify_keys:${row.id}`);
            if (!rec) { report.keys.failed += 1; continue; }
            if (rec.via === 'already-new') continue;   // nothing to do

            if (!dryRun) {
                const patch = { token: encryptSecret(rec.plain) };
                if (!row.token_hash) patch.token_hash = tokenHash(rec.plain);
                const { error: upErr } = await supabase.from('apify_keys').update(patch).eq('id', row.id);
                if (upErr) { report.keys.failed += 1; report.failures.push({ item: `apify_keys:${row.id}`, message: upErr.message }); continue; }
            }
            report.keys.rotated += 1;
        }
    } catch (e) {
        report.failures.push({ item: 'apify_keys', message: e.message });
    }

    // --- system_settings primaries ------------------------------------------
    for (const engine of ENGINES) {
        const name = primaryKeyName(engine);
        try {
            const { data } = await supabase.from('system_settings').select('value').eq('key', name).maybeSingle();
            if (!data?.value) continue;
            report.primaries.total += 1;

            const rec = recover(data.value, `system_settings:${name}`);
            if (!rec) { report.primaries.failed += 1; continue; }
            if (rec.via === 'already-new') continue;

            if (!dryRun) {
                await supabase.from('system_settings').upsert({
                    key: name, value: encryptSecret(rec.plain), updated_at: new Date().toISOString()
                }, { onConflict: 'key' });
            }
            report.primaries.rotated += 1;
        } catch (e) {
            report.primaries.failed += 1;
            report.failures.push({ item: `system_settings:${name}`, message: e.message });
        }
    }

    // Any in-process client holds a decrypted token bound to the old row. They
    // are still valid tokens — rotation changes how the token is stored, not
    // the token — so nothing needs invalidating. The BYO cache is cleared
    // anyway so the next request re-reads from the rotated rows.
    if (!dryRun) {
        _byoCache.clear();
        _statusCache.clear();
        logger.info('encryption_key_rotated', {
            keysRotated: report.keys.rotated, primariesRotated: report.primaries.rotated,
            failed: report.keys.failed + report.primaries.failed
        });
    }

    report.ok = report.failures.length === 0;
    report.nextStep = dryRun
        ? (report.ok
            ? 'Dry run clean. Re-POST with { "confirm": "rotate" } to write.'
            : 'Dry run found failures — resolve them before writing. Nothing was changed.')
        : (report.ok
            ? 'Rotation complete. Remove APP_ENCRYPTION_KEY_OLD from the environment and redeploy.'
            : 'Rotation finished with failures. Leave APP_ENCRYPTION_KEY_OLD set until they are resolved — it is the only thing that can still read those rows.');

    return report;
}

async function migrateSecretsAtRest() {
    if (!ENC_KEY) {
        logger.warn('encryption_disabled', {
            note: 'APP_ENCRYPTION_KEY is not set. Apify tokens are stored in plaintext. ' +
                  'Generate one with: openssl rand -hex 32'
        });
        return { encrypted: 0, hashed: 0, skipped: true };
    }

    let encrypted = 0, hashed = 0;

    try {
        const { data: rows } = await supabase.from('apify_keys').select('id, token, token_hash');
        for (const row of rows || []) {
            const patch = {};
            let plain = null;
            try { plain = decryptSecret(row.token, { currentKeyOnly: true }); }
            catch (e) {
                // During a rotation window this is expected: the row is sealed
                // under APP_ENCRYPTION_KEY_OLD and rotateEncryptionKey() owns
                // moving it. decryptSecret() can still read it, so nothing is
                // broken — this migration just has no work to do here.
                if (ENC_KEY_OLD) logger.debug('migrate_skipped_pending_rotation', { keyId: row.id });
                else logger.error('migrate_decrypt_failed', { keyId: row.id, message: e.message });
                continue;
            }

            if (!isEncrypted(row.token)) { patch.token = encryptSecret(plain); encrypted += 1; }
            if (!row.token_hash)         { patch.token_hash = tokenHash(plain); hashed += 1; }
            if (Object.keys(patch).length) await supabase.from('apify_keys').update(patch).eq('id', row.id);
        }
    } catch (e) {
        logger.error('migrate_keys_failed', { message: e.message });
    }

    try {
        for (const engine of ENGINES) {
            const name = primaryKeyName(engine);
            const { data } = await supabase.from('system_settings')
                .select('value').eq('key', name).maybeSingle();
            if (data?.value && !isEncrypted(data.value)) {
                await supabase.from('system_settings').upsert({
                    key: name, value: encryptSecret(data.value), updated_at: new Date().toISOString()
                }, { onConflict: 'key' });
                encrypted += 1;
            }
        }
    } catch (e) {
        logger.error('migrate_primaries_failed', { message: e.message });
    }

    if (encrypted || hashed) logger.info('secrets_migrated', { encrypted, hashed });
    return { encrypted, hashed, skipped: false };
}

/**
 * Confirm at boot that the migrations this build depends on have actually run.
 *
 * Every one of these failures used to be silent at boot and only visible much
 * later as missing data: posts that never persisted, a trend line that could
 * not tell v1 from v2 snapshots, an AI status nobody could read back.
 */
async function schemaProbe() {
    const required = [
        { table: 'posts',   column: 'is_provisional',    migration: 'schema-phase4.sql',
          impact: 'Instagram posts will not be written — reports still render, but post history stops accumulating.' },
        { table: 'reports', column: 'score_version',     migration: 'schema-phase5.sql',
          impact: 'Trend lines cannot tell a scoring change apart from a real change in the account.' },
        { table: 'reports', column: 'ai_status',         migration: 'schema-phase5.sql',
          impact: 'A failed strategy layer will not record why it failed.' },
        { table: 'reports', column: 'followers_snapshot', migration: 'schema-phase5.sql',
          impact: 'Trend snapshots fall back to nulls for followers, cadence and rank.' },
        { table: 'jobs',    column: 'partials',          migration: 'schema-phase1.sql',
          impact: 'Job checkpoints cannot be stored — a paused run will re-scrape and re-charge on resume.' },
        { table: 'reports', column: 'client_id',         migration: 'schema-phase9.sql',
          impact: 'Every report insert will fail — clients, content plans and Meta syncs cannot save.' },
        { table: 'clients', column: 'id',                migration: 'schema-phase9.sql',
          impact: 'Client workspace routes will 500.' },
        { table: 'gemini_keys', column: 'key_enc',       migration: 'schema-phase9.sql',
          impact: 'Only the env Gemini key can be used; no pool, no per-user keys.' },
        { table: 'meta_connections', column: 'page_token_enc', migration: 'schema-phase9.sql',
          impact: 'Meta OAuth callback cannot store a connection.' },
        { table: 'posts',         column: 'client_id', migration: 'schema-phase10.sql',
          impact: 'Instagram post upserts will fail on an unknown column — audits render but post history stops; content plans starve.' },
        { table: 'fb_page_posts', column: 'client_id', migration: 'schema-phase10.sql',
          impact: 'FB Page post upserts will fail — page reports render but the FB content plan has nothing to read.' },
        { table: 'fb_posts',      column: 'client_id', migration: 'schema-phase10.sql',
          impact: 'FB group post upserts will fail — community audits and the demand feed stop accumulating.' },
        { table: 'posts',         column: 'plays',     migration: 'schema-phase11.sql',
          impact: 'Instagram post upserts will fail on an unknown column — audits render but post history stops.' },
        { table: 'leads',         column: 'whatsapp',  migration: 'schema-phase11.sql',
          impact: 'Lead enrichment updates will fail on an unknown column.' },
        { table: 'schedules',     column: 'next_run_at', migration: 'schema-phase11.sql',
          impact: 'Scheduled runs cannot be created or fired.' },
        { table: 'report_shares', column: 'token',     migration: 'schema-phase11.sql',
          impact: 'Report share links cannot be created.' }
    ];

    const missing = [];
    for (const r of required) {
        try {
            const { error } = await supabase.from(r.table).select(r.column).limit(1);
            if (error) missing.push(r);
        } catch (_) { missing.push(r); }
    }

    if (missing.length) {
        missing.forEach(m => logger.error('schema_missing', {
            table: m.table, column: m.column, migration: m.migration, impact: m.impact
        }));
        alertOnce('schema_missing',
            `${missing.length} required column(s) are missing. Run: ` +
            [...new Set(missing.map(m => m.migration))].join(', '),
            { columns: missing.map(m => `${m.table}.${m.column}`) });
    } else {
        logger.info('schema_ok', { checked: required.length });
    }
    return missing;
}

/** A boot-time sanity check. Anything printed here is a deployment mistake. */
function preflight() {
    const problems = [];

    // Phase 4: a half-configured rotation should fail at boot, not on the
    // first request that touches a credential.
    if (ENC_KEY_OLD && ENC_KEY && ENC_KEY_OLD.equals(ENC_KEY)) {
        problems.push('APP_ENCRYPTION_KEY_OLD is identical to APP_ENCRYPTION_KEY.');
    }
    if (ENC_KEY_OLD && !ENC_KEY) {
        problems.push('APP_ENCRYPTION_KEY_OLD is set but APP_ENCRYPTION_KEY is not — nothing to rotate to.');
    }
    if (ENC_KEY_OLD) {
        logger.warn('rotation_mode_active', {
            note: 'APP_ENCRYPTION_KEY_OLD is set. Finish the rotation and unset it — ' +
                  'leaving it in place keeps the retired key live in the environment.'
        });
    }
    if (!process.env.SUPABASE_URL) problems.push('SUPABASE_URL is not set');
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) problems.push('SUPABASE_SERVICE_ROLE_KEY is not set');
    if (!ENC_KEY) problems.push('APP_ENCRYPTION_KEY is not set — Apify tokens will be stored in plaintext');
    if (!geminiAvailable()) problems.push('No Gemini key anywhere (env or pool) — reports will ship without their narrative layer');
    if (!(process.env.META_APP_ID && process.env.META_APP_SECRET)) problems.push('META_APP_ID / META_APP_SECRET not set — Meta owner-data connections are disabled');
    if (!MASTER_ADMIN_EMAIL) problems.push('MASTER_ADMIN_EMAIL is not set — the first user to sign in becomes admin');
    if (!ALERT_WEBHOOK) problems.push('ALERT_WEBHOOK_URL is not set — failures will only appear in the logs');
    if (!SELF_URL) problems.push(
        'Neither SELF_URL nor RENDER_EXTERNAL_URL is set — the instance cannot keep itself awake, ' +
        'so a long job will be interrupted whenever the user closes the tab');
    if (BUDGET_MODE !== 'block') problems.push(`BUDGET_MODE=${BUDGET_MODE} — a run can overspend a key without pausing`);

    // The default run has to fit the default budget. Checking the actual number
    // beats warning on a hard-coded threshold that drifts away from the config.
    const defaultRunUsd = fbEstimateCredits(FB_DEFAULT_GROUPS, FB_DEFAULT_POSTS, false);
    if (defaultRunUsd > APIFY_CYCLE_CREDIT * 0.5) {
        problems.push(
            `A default Facebook audit (${FB_DEFAULT_GROUPS} groups x ${FB_DEFAULT_POSTS} posts) ` +
            `estimates $${defaultRunUsd.toFixed(2)} against a $${APIFY_CYCLE_CREDIT} cycle — ` +
            `fewer than 2 runs per key per month`
        );
    }
    problems.forEach(p => logger.warn('preflight', { problem: p }));
    return problems;
}

const PORT = process.env.PORT || 10000;

async function start() {
    preflight();

    const server = app.listen(PORT, async () => {
        logger.info('boot', {
            port: PORT,
            version: APP_VERSION,
            budgetMode: BUDGET_MODE,
            creditPerKeyUsd: APIFY_CYCLE_CREDIT,
            memoryMb: APIFY_MEMORY_MB,
            timeoutSecs: APIFY_TIMEOUT_SECS,
            proxy: APIFY_PROXY_GROUP || 'actor default',
            geminiModel: GEMINI_MODEL,
            geminiMaxOutputTokens: parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS || '8192', 10),
            aiPromptBudgetChars: AI_PROMPT_BUDGET,
            igScoreVersion: IG_SCORE_VERSION,
            encryptionAtRest: !!ENC_KEY,
            rotationPending: !!ENC_KEY_OLD,
            keepAlive: !!SELF_URL,
            autoResume: AUTO_RESUME,
            alerts: !!ALERT_WEBHOOK,
            instance: INSTANCE_ID,
            scheduler: SCHEDULER_ENABLED
        });

        await schemaProbe();
        await migrateSecretsAtRest();

        // Jobs run in-process. Render's free tier sleeps on idle and restarts on
        // every deploy, so anything still marked running at boot is orphaned.
        await sweepStaleJobs();
        await sweepStaleReservations();
        await reviveStaleKeys();

        setInterval(sweepStaleJobs, Math.max(5, JOB_STALE_MINUTES) * 60000).unref?.();
        setInterval(sweepStaleReservations, Math.max(5, JOB_STALE_MINUTES) * 60000).unref?.();
        setInterval(reviveStaleKeys, 3600000).unref?.();
        if (SELF_URL) setInterval(keepAwakeIfBusy, KEEPALIVE_MS).unref?.();

        // Phase 11: heartbeat first so a second instance is visible at once,
        // then the scheduler, which stays quiet until a schedule is due.
        await instanceHeartbeat();
        setInterval(instanceHeartbeat, INSTANCE_BEAT_MS).unref?.();
        if (SCHEDULER_ENABLED) {
            setTimeout(() => schedulerTick().catch(() => {}), 15000).unref?.();
            setInterval(schedulerTick, Math.max(15000, SCHEDULER_POLL_MS)).unref?.();
        }
        logger.info('phase11_ready', { instance: INSTANCE_ID, scheduler: SCHEDULER_ENABLED, pollMs: SCHEDULER_POLL_MS });
    });

    return server;
}

/**
 * Park in-flight jobs on the way out.
 *
 * sweepStaleJobs() already recovers these, but only after JOB_STALE_MINUTES of
 * a dead heartbeat — during which the UI spins on a job nobody is running.
 * Render sends SIGTERM on every single deploy, so this is the common path, not
 * the exceptional one.
 *
 * Best-effort and time-boxed: the platform SIGKILLs shortly after, and a
 * shutdown that hangs is worse than one that misses a row the sweep would have
 * caught anyway. 'interrupted' is already in RESUMABLE_STATUSES, so these are
 * picked up — and auto-resumed — on the next boot exactly as before.
 */
let _shuttingDown = false;
async function gracefulShutdown(signal, server) {
    if (_shuttingDown) return;
    _shuttingDown = true;
    logger.warn('shutdown_started', { signal });

    try { server?.close(); } catch (_) {}

    // Drop our own heartbeat so the instance that replaces us does not see a
    // fresh row and raise multiple_instances on every deploy. Best-effort;
    // the 90 s staleness window still covers a SIGKILL.
    try {
        await Promise.race([
            supabase.from('system_settings').delete().eq('key', 'instance_heartbeat:' + INSTANCE_ID),
            new Promise(r => setTimeout(r, 1500))
        ]);
    } catch (_) {}

    try {
        await Promise.race([
            supabase.from('jobs')
                .update({
                    status: 'interrupted',
                    error: 'The server restarted while this job was running. ' +
                           'Anything already scraped was saved — resume to finish the rest.',
                    updated_at: new Date().toISOString()
                })
                .in('status', ['running', 'queued']),
            new Promise(r => setTimeout(r, 4000))
        ]);
    } catch (e) {
        logger.error('shutdown_park_failed', { message: e.message });
    }

    logger.warn('shutdown_complete', { signal });
    process.exit(0);
}

if (require.main === module) {
    start().then(server => {
        ['SIGTERM', 'SIGINT'].forEach(sig =>
            process.on(sig, () => gracefulShutdown(sig, server)));
    });
}

// Exported so the test suite can exercise the pure logic without booting a
// server or touching Supabase. Nothing here changes runtime behaviour.
// Every route above is registered. From here an uncaught exception is a
// runtime fault to log and survive, not a boot failure to die on.
BOOTED = true;

module.exports = {
    app, start, JOB_WORKERS, __geminiTest: (prompt, userId) => geminiCallDetailed(prompt, { userId, tag: 'test' }), cpFeature, cpScore, cpBand, geminiRank, graphInsights, clientAccess,
    // secrets
    encryptSecret, decryptSecret, isEncrypted, maskSecret, tokenHash,
    // budget + keys
    classifyKeyError, cycleMonth, clientRemaining, estimateCredits, fbEstimateCredits,
    fbPageEstimateCredits, primaryKeyName, buildBenchmark, ruleRecommendations,
    leadgenUnits,
    // analysis helpers
    median, computeRoomValue, bucketCaption, lengthBand, openingPattern, topicTags,
    categorize, urgencyOf, classifyIntent, mineDemand, parseGroupRef, parsePageRef,
    parseRules, localParts, domainOf, fbReactions, fbMediaType, normaliseReactionBreakdown,
    computePageScore, profileCompleteness, timeHeatmap, leaderboard,
    // ai layer
    budgetedJson, igAiPayload, igAiSlim, fbPageAiSlim, fbGroupAiSlim, aiPostCard, aiReasonText,
    // observability
    METRICS, RECENT_EVENTS, logger, preflight, schemaProbe, migrateSecretsAtRest,
    sweepStaleJobs, sweepStaleReservations, keepAwakeIfBusy,
    // caches
    invalidateAuth, invalidateEngineAccess,
    // phase 11
    scheduleNextRun, scheduleInputForRun, cleanScheduleBody, scheduleSummary, SCHEDULABLE_TYPES,
    shareToken, shareUrlFor, REPORT_PAGE,
    extractBioContacts, getPlays, getVideoViews, igPlaceUrls, igDistribution, igNormalisePost,
    // phase 13
    accountState, accountDenial, quotaPeriod, JOB_QUOTA_METRIC, LEADGEN_JOB_TYPES,
    QUOTA_FALLBACK, TRIAL_ENGINES, quotaError,
    // phase 14
    clientReportView, clientStanding, clientPillars, ordinal, CLIENT_PILLARS,
    clientPlanIdeas, clientRooms,
    // phase 15
    ASSISTANT_TOOLS, assistantDeclarations, assistantSystemPrompt,
    // phase 16
    fbPageToLead, fbPageSearchRefs,
    // phase 14 (client surface, extended)
    clientDemandView, DEMAND_INTENT,
    // phase 17
    cpBoostCall,
    // phase 19
    metaMonthWindow, metaPrevMonth, metaDefaultMonth, metaMonthLabel, pctDelta,
    META_MONTH_METRICS, comparableBand, competitorQueries,
    // phase 20
    csvCell, LEAD_SORTS,
    // phase 22 — reached directly by the use-case test, which drives real
    // handlers over an in-memory database instead of trusting that they wire
    resolveClientId, ownClientFor, createJob, ensureProfile, userRole,
    // phase 23
    linkLeadsToClient, dedupeLeads, MERGE_TABLES,
    // phase 24
    metaParseSignedRequest, metaDeleteUserData,
    // phase 26
    auth
};
