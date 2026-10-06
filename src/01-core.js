/**
 * Core: configuration, observability, secrets at rest, auth and tenancy, Apify keys.
 *
 * Part of the EdgeLead server, split out of server.js (phase 55). The parts load in
 * order from server.js and share one namespace, S: what this part needs from an earlier
 * part is unpacked below; anything else from another part is read as S.name when it runs.
 */
'use strict';
const S = require('./shared');
const ROOT_DIR = require('path').join(__dirname, '..');
Object.assign(S, {
    alertOnce, isEncrypted, encryptSecret, decryptSecret, maskSecret, rateLimit, ensureProfile,
    invalidateAuth, accountState, accountDenial, auth, invalidateEngineAccess, requireAdmin, requireEngine,
    primaryKeyName, getEnginePrimary, setEnginePrimary, isByoOnly, enginePrimaryCredit,
    buildTokenCandidates, saveKeyRow, markKey, reviveStaleKeys, tokenHash, cycleMonth, sendErr,
    classifyKeyError, getWorkingClient, budgetSnapshot, getViews, getPlays, getVideoViews,
    extractBioContacts, extractPosts, shortcodeOf, postTypeOf, tagsOf, tsOf
});
Object.defineProperty(S, 'BOOTED', { get: () => BOOTED, set: (v) => { BOOTED = v; }, enumerable: true });
const express = require('express');
S.express = express;
const cors = require('cors');
const { ApifyClient } = require('apify-client');
S.ApifyClient = ApifyClient;
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
S.crypto = crypto;
const { AsyncLocalStorage } = require('async_hooks');
require('dotenv').config();
// The XpulseAI Owner Assistant, copied under xp/ (phase 31). Its routes are
// mounted at the end of this file, its cron started with the schedulers.
const xp = require('../xp');
S.xp = xp;

// Per-request / per-job context. Lets deep helpers (the Gemini pool) know
// which user a call is for without threading userId through every signature.
const ELS = new AsyncLocalStorage();
S.ELS = ELS;

// ===========================================================================
// OBSERVABILITY
// Structured JSON logs, in-process counters, a bounded error ring buffer and
// an optional webhook for the handful of events that are actually worth
// waking someone up for. No new dependency: everything here is node builtins.
// ===========================================================================
const BOOT_TS   = Date.now();
S.BOOT_TS = BOOT_TS;
const APP_VERSION = process.env.APP_VERSION || 'phase11';
S.APP_VERSION = APP_VERSION;
const LOG_LEVELS  = { debug: 10, info: 20, warn: 30, error: 40 };
const LOG_LEVEL   = LOG_LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || 20;
const SLOW_REQUEST_MS = parseInt(process.env.SLOW_REQUEST_MS || '4000', 10);

const ALERT_WEBHOOK   = (process.env.ALERT_WEBHOOK_URL || '').trim();
S.ALERT_WEBHOOK = ALERT_WEBHOOK;
const ALERT_THROTTLE_MIN = parseInt(process.env.ALERT_THROTTLE_MINUTES || '15', 10);
const RUN_COST_ALERT_USD = parseFloat(process.env.APIFY_RUN_COST_ALERT_USD || '0.75');
S.RUN_COST_ALERT_USD = RUN_COST_ALERT_USD;

const METRICS = {
    http:   { total: 0, errors: 0, slow: 0, byStatus: {} },
    apify:  { runs: 0, failures: 0, emptyRuns: 0, usd: 0, items: 0 },
    gemini: { calls: 0, ok: 0, failed: 0, retries: 0 },
    jobs:   { started: 0, resumed: 0, done: 0, failed: 0, paused: 0, interrupted: 0, cancelled: 0 },
    keys:   { invalid: 0, exhausted: 0, transient: 0, noCreditEvents: 0 }
};
S.METRICS = METRICS;

METRICS.rotation = { readsViaOldKey: 0 };
METRICS.ai = { ok: 0, failed: 0, truncated: 0, promptChars: 0, dropped: 0 };
METRICS.authCache = { hit: 0, miss: 0 };

const RECENT_EVENTS = [];
S.RECENT_EVENTS = RECENT_EVENTS;          // last 100 warn/error lines, for /api/admin/metrics
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
S.logger = logger;

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
S.ENC_KEY = ENC_KEY;

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
S.ENC_KEY_OLD = ENC_KEY_OLD;

function isEncrypted(v) { return typeof v === 'string' && v.startsWith(ENC_PREFIX); }

// Phase 45: in production a missing key no longer means plaintext. Storing a secret then fails with
// a message that says what to set, and the boot check below raises the alarm before anyone tries.
const ENC_REQUIRED = process.env.NODE_ENV === 'production' || !!process.env.RENDER;
S.ENC_REQUIRED = ENC_REQUIRED;
function encryptSecret(plain) {
    if (plain && !ENC_KEY && ENC_REQUIRED && !isEncrypted(plain)) {
        const e = new Error('APP_ENCRYPTION_KEY is not set on the server, so this secret cannot be stored safely. Set it on Render (openssl rand -hex 32) and redeploy.');
        e.statusCode = 503; e.code = 'encryption_key_missing';
        throw e;
    }
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
S.app = app;

// Render terminates TLS at its edge, so without this every request reports the
// proxy's address as req.ip and the per-IP rate limiter degenerates into one
// global bucket — unable to throttle an individual, able to lock out everyone.
app.set('trust proxy', 1);

const ALLOWED = (process.env.ALLOWED_ORIGINS || '*')
    .split(',').map(s => s.trim()).filter(Boolean);
S.ALLOWED = ALLOWED;

app.use(cors({ origin: ALLOWED.includes('*') ? '*' : ALLOWED }));
app.use(express.json({ limit: '2mb' }));

// The pages, served from this process as well as from Netlify. The brief asked
// for the front end to live in the repo AND be reachable from the Render link;
// the first was true from the start, the second was not — the Render root
// answered 404 for every page. Same files, same caching rule as netlify.toml:
// nothing is fingerprinted, so a deploy must reach the browser on its next
// request, and must-revalidate with a zero max-age is what does that.
app.use(express.static(require('path').join(ROOT_DIR, 'frontend'), {
    index: 'index.html',
    dotfiles: 'ignore',
    setHeaders(res, filePath) {
        if (/\.(html|css|js)$/i.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
        if (/\.html$/i.test(filePath)) {
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        }
    }
}));

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
S.bearerId = bearerId;

// Anything that spends money is gated harder than plain reads.
const spendLimit = rateLimit({ windowMs: 60000, max: 6,   key: bearerId });
S.spendLimit = spendLimit;
const readLimit  = rateLimit({ windowMs: 60000, max: 240, key: bearerId });
// Per IP: public routes carry no bearer. Declared here, with the others,
// because every limiter must exist before the first route that names it.
const publicLimit = rateLimit({ windowMs: 60000, max: 30 });
S.publicLimit = publicLimit;
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
S.supabase = supabase;

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const MASTER_ADMIN_EMAIL     = (process.env.MASTER_ADMIN_EMAIL || '').toLowerCase().trim();
S.MASTER_ADMIN_EMAIL = MASTER_ADMIN_EMAIL;
const GEMINI_API_KEY         = process.env.GEMINI_API_KEY || '';
S.GEMINI_API_KEY = GEMINI_API_KEY;
// Default only. The pool discovers what the key can actually call (models.list)
// and prefers the newest flash line; a 404 here is no longer fatal.
const GEMINI_MODEL           = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
S.GEMINI_MODEL = GEMINI_MODEL;
const MAX_COMPETITORS        = parseInt(process.env.MAX_COMPETITORS || '10', 10);
S.MAX_COMPETITORS = MAX_COMPETITORS;
const DEFAULT_POSTS_PER_ACC  = parseInt(process.env.DEFAULT_POSTS_PER_ACCOUNT || '30', 10);
S.DEFAULT_POSTS_PER_ACC = DEFAULT_POSTS_PER_ACC;
const MAX_POSTS_PER_ACC      = parseInt(process.env.MAX_POSTS_PER_ACCOUNT || '100', 10);
S.MAX_POSTS_PER_ACC = MAX_POSTS_PER_ACC;
const ENGINES                = ['leadgen', 'report', 'fb_community', 'fb_page', 'meta_owned', 'content_plan'];
S.ENGINES = ENGINES;
/** Human names for the engines, so the admin panel does not keep its own copy. */
const ENGINE_LABELS = {
    leadgen:      'Lead finder',
    report:       'Reports & competitors',
    fb_community: 'Facebook communities',
    fb_page:      'Facebook Pages',
    meta_owned:   'Meta owner data',
    content_plan: 'Content plan'
};
S.ENGINE_LABELS = ENGINE_LABELS;

// What a self-serve trial account is granted at signup. Everything here is
// still held to the trial quota on top of the grant.
const TRIAL_ENGINES = (process.env.TRIAL_ENGINES || 'report,fb_community,leadgen,meta_owned')
    .split(',').map(s => s.trim()).filter(e => ENGINES.includes(e));
S.TRIAL_ENGINES = TRIAL_ENGINES;

// --- Facebook community engine ---------------------------------------------
// Actor IDs are env-overridable on purpose: Apify's Facebook actors get
// renamed and re-published far more often than the Instagram ones.
const FB_GROUP_POSTS_ACTOR = process.env.FB_GROUP_POSTS_ACTOR || 'apify/facebook-groups-scraper';
S.FB_GROUP_POSTS_ACTOR = FB_GROUP_POSTS_ACTOR;
const FB_SEARCH_ACTOR      = process.env.FB_SEARCH_ACTOR      || 'apify/facebook-search-scraper';
S.FB_SEARCH_ACTOR = FB_SEARCH_ACTOR;
const FB_COMMENTS_ACTOR    = process.env.FB_COMMENTS_ACTOR    || 'apify/facebook-comments-scraper';
S.FB_COMMENTS_ACTOR = FB_COMMENTS_ACTOR;
const FB_MAX_GROUPS        = parseInt(process.env.FB_MAX_GROUPS        || '15', 10);
S.FB_MAX_GROUPS = FB_MAX_GROUPS;
// Groups selected by default when the caller does not say. Kept well under
// FB_MAX_GROUPS so an accidental run cannot eat a whole cycle of credit.
const FB_DEFAULT_GROUPS    = parseInt(process.env.FB_DEFAULT_GROUPS     || '5', 10);
S.FB_DEFAULT_GROUPS = FB_DEFAULT_GROUPS;
const FB_DEFAULT_POSTS     = parseInt(process.env.FB_DEFAULT_POSTS_PER_GROUP || '40', 10);
S.FB_DEFAULT_POSTS = FB_DEFAULT_POSTS;
const FB_MAX_POSTS         = parseInt(process.env.FB_MAX_POSTS_PER_GROUP     || '400', 10);
S.FB_MAX_POSTS = FB_MAX_POSTS;
const FB_DEFAULT_DAYS      = parseInt(process.env.FB_DEFAULT_DAYS_WINDOW     || '60', 10);
S.FB_DEFAULT_DAYS = FB_DEFAULT_DAYS;
const FB_TZ_OFFSET_MINS    = parseInt(process.env.FB_TZ_OFFSET_MINUTES || '360', 10);
S.FB_TZ_OFFSET_MINS = FB_TZ_OFFSET_MINS; // default Asia/Dhaka +6
const COST_PER_1K_FB_POSTS = parseFloat(process.env.COST_PER_1K_FB_POSTS || '3.50');
S.COST_PER_1K_FB_POSTS = COST_PER_1K_FB_POSTS;
const FB_COMMENT_WEIGHT    = parseFloat(process.env.FB_COMMENT_WEIGHT || '3');
S.FB_COMMENT_WEIGHT = FB_COMMENT_WEIGHT;
const FB_SHARE_WEIGHT      = parseFloat(process.env.FB_SHARE_WEIGHT   || '4');
S.FB_SHARE_WEIGHT = FB_SHARE_WEIGHT;

// Rough Apify pricing used for the pre-run estimate only.
const COST_PER_1K_POSTS   = parseFloat(process.env.COST_PER_1K_POSTS   || '2.30');
S.COST_PER_1K_POSTS = COST_PER_1K_POSTS;
const COST_PER_1K_PROFILE = parseFloat(process.env.COST_PER_1K_PROFILE || '2.30');
S.COST_PER_1K_PROFILE = COST_PER_1K_PROFILE;

// Discovery methods asked for 1000 results per call with no cap and no cost
// estimate, so one campaign with five methods selected could fire eight
// ungated thousand-result scrapes against a key the budget system believed it
// was protecting. The limit is now a config value AND the basis of the
// estimate, so the two can never drift apart.
const LEADGEN_RESULTS_LIMIT = parseInt(process.env.LEADGEN_RESULTS_LIMIT || '1000', 10);
S.LEADGEN_RESULTS_LIMIT = LEADGEN_RESULTS_LIMIT;
const LEADGEN_UNIT_USD      = +((LEADGEN_RESULTS_LIMIT / 1000) * COST_PER_1K_POSTS).toFixed(4);
S.LEADGEN_UNIT_USD = LEADGEN_UNIT_USD;

// --- Instagram analysis layer (phase 4) -------------------------------------
const IG_COMMENT_WEIGHT = parseFloat(process.env.IG_COMMENT_WEIGHT || '4');
S.IG_COMMENT_WEIGHT = IG_COMMENT_WEIGHT;

// How long a post keeps accumulating before its numbers mean anything.
// A still image is close to settled inside a day. A reel is not — reels keep
// being served to non-followers for days, so a reel scraped six hours after
// posting is not a weak reel, it is an unfinished one. Averaging it in with
// settled posts is the single biggest source of false "your reels are dying"
// readings, which is why the two windows are separate.
const IG_PROVISIONAL_HOURS      = parseFloat(process.env.IG_PROVISIONAL_HOURS || '24');
S.IG_PROVISIONAL_HOURS = IG_PROVISIONAL_HOURS;
const IG_REEL_PROVISIONAL_HOURS = parseFloat(process.env.IG_REEL_PROVISIONAL_HOURS || '48');
S.IG_REEL_PROVISIONAL_HOURS = IG_REEL_PROVISIONAL_HOURS;

// Instagram timestamps come back in UTC. Local hour-of-day is what a posting
// schedule is actually built on, so shift once, here. Defaults to the same
// offset the FB engine uses so a mixed IG+FB account reads one clock.
const IG_TZ_OFFSET_MINS = parseInt(process.env.IG_TZ_OFFSET_MINUTES || String(FB_TZ_OFFSET_MINS), 10);
S.IG_TZ_OFFSET_MINS = IG_TZ_OFFSET_MINS;

// Below this many posts the score is reported but flagged. Same threshold as
// the FB page score, for the same reason: under ~12 posts a single outlier
// moves the median enough that the index stops meaning anything.
const IG_MIN_CONFIDENT_POSTS = parseInt(process.env.IG_MIN_CONFIDENT_POSTS || '12', 10);
S.IG_MIN_CONFIDENT_POSTS = IG_MIN_CONFIDENT_POSTS;

// v1 score is kept alongside v2 so reports already in the vault stay
// comparable. Set IG_SCORE_V2=false to keep v1 as the headline number.
const IG_SCORE_V2 = String(process.env.IG_SCORE_V2 || 'true') !== 'false';
S.IG_SCORE_V2 = IG_SCORE_V2;

// Which scoring scale a saved report was graded on.
//
// reports.score used to record a number with no note of which formula produced
// it, and /api/set-trend diffs that column across snapshots. Flip IG_SCORE_V2
// — or simply deploy the v2 patch mid-cohort — and the delta the user reads as
// "the account declined 13 points" is entirely an artifact of the change.
// Recording the version makes the series self-describing, so the trend
// endpoint can plot a comparable scale instead of guessing.
const IG_SCORE_VERSION = IG_SCORE_V2 ? 2 : 1;
S.IG_SCORE_VERSION = IG_SCORE_VERSION;

const IG_URL_RE = /https?:\/\/\S+|\b(?:link in bio|linkinbio|bio link|swipe up)\b/i;
S.IG_URL_RE = IG_URL_RE;

// --- Apify run shaping ------------------------------------------------------
// Compute units are billed as RAM(GB) x hours, so memory is a direct cost lever.
// Leaving this unset used to inherit the actor default, which is often 4-8 GB.
const APIFY_MEMORY_MB    = parseInt(process.env.APIFY_MEMORY_MBYTES   || '2048', 10);
S.APIFY_MEMORY_MB = APIFY_MEMORY_MB;
const APIFY_TIMEOUT_SECS = parseInt(process.env.APIFY_RUN_TIMEOUT_SECS || '900', 10);
S.APIFY_TIMEOUT_SECS = APIFY_TIMEOUT_SECS;
// '' keeps the actor's own proxy default. Set to DATACENTER to avoid paying
// residential proxy rates ($8/GB on the free plan) where the target allows it.
const APIFY_PROXY_GROUP  = (process.env.APIFY_PROXY_GROUP || '').trim().toUpperCase();
S.APIFY_PROXY_GROUP = APIFY_PROXY_GROUP;

// --- Budget ledger ----------------------------------------------------------
// Default cycle credit for a key that has no explicit limit of its own.
// Every key row can override this with apify_keys.monthly_credit_usd, so a
// customer on a paid Apify plan is no longer capped at the free-tier number.
const APIFY_CYCLE_CREDIT = parseFloat(process.env.APIFY_MONTHLY_CREDIT_USD || '5');
S.APIFY_CYCLE_CREDIT = APIFY_CYCLE_CREDIT;
// 'off'   - track only
// 'warn'  - track, expose remaining, never block
// 'block' - refuse to start a unit the current key cannot afford (recommended)
const BUDGET_MODE        = (process.env.BUDGET_MODE || 'block').toLowerCase();
S.BUDGET_MODE = BUDGET_MODE;
const BUDGET_RESERVE     = parseFloat(process.env.BUDGET_RESERVE_USD || '0.05');
S.BUDGET_RESERVE = BUDGET_RESERVE;

// --- Job engine -------------------------------------------------------------
// A job mid-actor-call emits no progress tick, so the staleness window must be
// longer than the longest possible single call. The default used to be exactly
// APIFY_RUN_TIMEOUT_SECS, which meant the sweep parked LIVE jobs as resumable
// and then invited the user to start a second copy of one still running.
const JOB_STALE_MINUTES  = Math.max(
    parseInt(process.env.JOB_STALE_MINUTES || '15', 10),
    Math.ceil((APIFY_TIMEOUT_SECS + 300) / 60)
);
S.JOB_STALE_MINUTES = JOB_STALE_MINUTES;
const MAX_ACTIVE_JOBS    = parseInt(process.env.MAX_ACTIVE_JOBS_PER_USER || '2', 10);
S.MAX_ACTIVE_JOBS = MAX_ACTIVE_JOBS;
// An 'exhausted' key is not dead, it is out of credit for this cycle. Retry it
// after this many hours so monthly credit renewal is picked up automatically.
const KEY_REVIVE_HOURS   = parseInt(process.env.KEY_REVIVE_HOURS || '12', 10);

// ===========================================================================
// AUTH + TENANCY
// ===========================================================================

async function ensureProfile(user) {
    const email = (user.email || '').toLowerCase();

    let { data: profile, error: readErr } = await supabase
        .from('app_users').select('*').eq('id', user.id).maybeSingle();
    // Phase 57: a failed read is not "no profile". Treating it as one re-provisioned an existing
    // employee or admin as a trial client, overwriting their role.
    if (readErr) throw Object.assign(new Error('Could not load your account. Try again in a moment.'), { statusCode: 503 });

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
            const { count, error: countErr } = await supabase
                .from('app_users').select('id', { count: 'exact', head: true }).eq('role', 'admin');
            // A failed count is not zero: that made a stranger the admin (phase 57). And with a
            // master admin named, nobody else is ever bootstrapped into the role.
            if (countErr) throw Object.assign(new Error('Could not load your account. Try again in a moment.'), { statusCode: 503 });
            if (!MASTER_ADMIN_EMAIL && count === 0) role = 'admin';
        }

        const row = {
            id: user.id, email, role, is_active: true,
            updated_at: new Date().toISOString()
        };

        if (role === 'client') {
            const days  = await S.trialDaysSetting();
            const start = new Date();
            row.trial_started_at = start.toISOString();
            row.trial_ends_at    = new Date(start.getTime() + days * 86400000).toISOString();
            // A trial spends the shared pool, so it can never fall back to a
            // company key beyond what quota allows. byo_key_only stays false:
            // the point of the trial is that they do not need a key yet.
        }

        // Insert only: a row that appeared meanwhile (another request, another instance) is never overwritten.
        const { data: created, error: insErr } = await supabase.from('app_users').upsert(row, { onConflict: 'id', ignoreDuplicates: true })
            .select().maybeSingle();
        if (!created) {
            const { data: again } = await supabase.from('app_users').select('*').eq('id', user.id).maybeSingle();
            if (again) return again;
            if (insErr) throw Object.assign(new Error('Could not set up your account. Try again in a moment.'), { statusCode: 503 });
        }

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
            await S.ownClientFor({ user, profile }).catch(e => logger.warn('own_client_create_failed', { message: e.message }));
            // The agency hears about a new trial by mail, if mail is set up.
            S.mailNewTrial(email, row.trial_ends_at).catch(e => logger.warn('mail_new_trial_failed', { message: e.message }));
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
S.AUTH_CACHE_MS = AUTH_CACHE_MS;
const _authCache = new Map();
S._authCache = _authCache;

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
    // Phase 52: a login the agency made for a business owner never runs out. The agency is the
    // customer; the owner reaches the app for as long as the agency keeps their business on.
    if (profile.agency_owner === true) return 'paid';

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
/**
 * When an owner login was last used (phase 56), so the Clients hub can tell an
 * invite that was never opened from an owner who uses the app. At most once an
 * hour per login, never awaited: a slow write must not slow a request.
 */
const _seenAt = new Map();
function touchLastSeen(profile) {
    if (!profile || profile.role !== 'client' || !profile.id) return;
    const now = Date.now();
    if (now - (_seenAt.get(profile.id) || 0) < 3600000) return;
    _seenAt.set(profile.id, now);
    Promise.resolve(supabase.from('app_users').update({ last_seen_at: new Date(now).toISOString() }).eq('id', profile.id))
        .then(r => { if (r && r.error) _seenAt.delete(profile.id); }).catch(() => _seenAt.delete(profile.id));
}

/**
 * One profile load per user at a time (phase 57). A new signup's first page fires several
 * requests at once; each used to provision on its own: duplicate businesses and emails.
 */
const _profileInflight = new Map();
function ensureProfileOnce(user) {
    const hit = _profileInflight.get(user.id);
    if (hit) return hit;
    const p = ensureProfile(user).finally(() => _profileInflight.delete(user.id));
    _profileInflight.set(user.id, p);
    return p;
}

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

    let profile;
    try { profile = await ensureProfileOnce(data.user); }
    catch (e) { res.status(e.statusCode || 503).json({ error: e.message || 'Could not load your account.' }); return null; }
    touchLastSeen(profile);
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
        res.status(403).json({ error: `Your account can’t use ${ENGINE_LABELS[engine] || engine} yet. Ask an admin to switch it on in Team & settings → People.`, code: 'no_engine' });
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
S._byoCache = _byoCache;
async function isByoOnly(userId) {
    if (!userId) return false;
    const hit = _byoCache.get(userId);
    if (hit && Date.now() - hit.t < 60000) return hit.v;
    let v = false;
    try {
        const { data, error } = await supabase.from('app_users')
            .select('byo_key_only').eq('id', userId).maybeSingle();
        if (error) throw error;
        v = !!data?.byo_key_only;
    } catch {
        // A failed read keeps the last known answer, and with none assumes own keys only (phase 57):
        // "not own-keys-only" let the person spend the shared pool for a minute.
        v = hit ? hit.v : true;
    }
    _byoCache.set(userId, { v, t: Date.now() });
    return v;
}

/**
 * Cycle credit for an engine primary key. Stored in system_settings so an
 * admin can raise it from the UI without a redeploy, and cached briefly
 * because key resolution happens on every spend.
 */
const _primaryCreditCache = new Map();
S._primaryCreditCache = _primaryCreditCache;
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
S.NoCreditError = NoCreditError;

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
            const spent = await S.cycleUsage(hash);
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

            const spent = await S.cycleUsage(hash);
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
            const remaining = Math.max(0, c.creditUsd - await S.cycleUsage(tokenHash(c.token), month) - BUDGET_RESERVE);
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
