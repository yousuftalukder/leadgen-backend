#!/usr/bin/env node
/**
 * USE-CASE TESTS — the workflows a human actually does, end to end.
 *
 * The phase tests check functions. The wiring audit checks that layers join.
 * Neither walks a workflow, and that is where the last three bugs lived: an
 * engine nobody could grant, a limit nobody could change, a role nobody could
 * create. Every one of those was consistent code that failed a person.
 *
 * So these drive the REAL route handlers — auth, clientAccess, the lot — over
 * an in-memory database that understands the PostgREST subset server.js uses.
 * No network, no Supabase, no Apify. What is faked is storage; what is tested
 * is the server's own logic, called the way Express would call it.
 *
 * The workflows:
 *   admin bootstraps → creates a client → assigns an employee
 *   employee sees the client → runs work under it → work lands in its timeline
 *   employee with no client chosen is refused; a stranger cannot see the client
 *   an admin can assign work on a client an employee created
 *   a self-serve client account is its own business from the first login
 *   an agency taking on that client absorbs the empty record; the client sees the work
 *   Meta status is reported on the client row
 *
 *   node tests/usecases.test.js
 */
'use strict';
const assert = require('assert');
const Module = require('module');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
/** server.js and its parts in src/ (phase 55), in load order, as one text. */
const serverSource = () => [path.join(__dirname, '..', 'server.js'), ...fs.readdirSync(path.join(__dirname, '..', 'src')).filter(f => f.endsWith('.js')).sort().map(f => path.join(__dirname, '..', 'src', f))]
    .map(f => fs.readFileSync(f, 'utf8')).join('\n');

// ===========================================================================
// AN IN-MEMORY POSTGREST
// ===========================================================================
const DB = {};
const tbl = t => (t === 'leads_master' ? masterView() : t === 'leads' ? withComputed(DB.leads = DB.leads || []) : t === 'el_client_report_counts' ? reportCountsView() : (DB[t] = DB[t] || []));
/** The phase-54 view: reports grouped by client and type. */
function reportCountsView() {
    const g = new Map();
    for (const r of (DB.reports || [])) {
        if (!r.client_id) continue;
        const k = r.client_id + '|' + r.report_type;
        g.set(k, { client_id: r.client_id, report_type: r.report_type, n: ((g.get(k) || {}).n || 0) + 1 });
    }
    return [...g.values()];
}

/** Generated columns, the way Postgres keeps them current (phase 40: kind_now). */
function withComputed(rows) {
    for (const r of rows) r.kind_now = r.kind_label || r.lead_kind || 'unsure';
    return rows;
}

/**
 * The phase-29 view, computed the way the SQL does: one row per business
 * across every owner — enriched over not, then newest — with `copies`
 * counting how many rows it stands for. Read-only, like the real one.
 */
function masterView() {
    const groups = new Map();
    for (const r of (DB.leads || [])) {
        const k = `${r.platform || 'instagram'}:${String(r.username || '').toLowerCase()}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
    }
    withComputed(DB.leads || []);
    return [...groups.values()].map(g => {
        g.sort((a, b) => ((!!b.is_enriched) - (!!a.is_enriched))
            || (String(b.created_at) > String(a.created_at) ? 1 : String(b.created_at) < String(a.created_at) ? -1 : 0));
        return { ...g[0], copies: g.length };
    });
}

/**
 * Column defaults from the real schema, applied on insert the way Postgres
 * would. Without these the fake is stricter than production — which is
 * useful once (it caught ownClientFor leaning on a default) and noise after.
 * Keep this to defaults that exist in sql/, nothing invented.
 */
const DEFAULTS = {
    clients:   { archived: false },
    app_users: { is_active: true, byo_key_only: false },
    jobs:      { status: 'queued', progress: 0 },
    client_tasks: { status: 'todo', position: 0, assigned_to_client: false, visible_to_client: false }
};

/** The .or() DSL subset server.js uses: eq, in, is.null, not.is.null, ilike. */
function orPredicate(dsl) {
    const terms = []; let depth = 0, start = 0;
    for (let i = 0; i < dsl.length; i++) {
        const ch = dsl[i];
        if (ch === '(') depth++; else if (ch === ')') depth--;
        else if (ch === ',' && !depth) { terms.push(dsl.slice(start, i)); start = i + 1; }
    }
    terms.push(dsl.slice(start));
    const preds = terms.map(t => {
        let m;
        if ((m = /^(\w+)\.eq\.(.*)$/.exec(t))) return r => String(r[m[1]]) === m[2];
        if ((m = /^(\w+)\.in\.\((.*)\)$/.exec(t))) { const set = new Set(m[2].split(',').map(x => x.trim())); return r => set.has(String(r[m[1]])); }
        if ((m = /^(\w+)\.not\.is\.null$/.exec(t))) return r => r[m[1]] != null;
        if ((m = /^(\w+)\.is\.null$/.exec(t))) return r => r[m[1]] == null;
        if ((m = /^(\w+)\.ilike\.(.*)$/.exec(t))) { const n = m[2].replace(/%/g, '').toLowerCase(); return r => String(r[m[1]] || '').toLowerCase().includes(n); }
        throw new Error('or() term not understood by the fake: ' + t);
    });
    return r => preds.some(p => p(r));
}

const EMBED_JOINS = { 'xp_influencer_posts.xp_social_posts': { fk: 'post_id' }, 'xp_clients.xp_meta_assets': { children: 'client_id' } };
class Query {
    constructor(t) { this.t = t; this.op = 'select'; this.f = []; this.ord = []; this.lim = null; this.rng = null; this.one = null; this.count = null; this.head = false; this.rows = null; this.conflict = null; this.patch = null; }
    select(cols, o = {}) {
        if (o.count) this.count = o.count; if (o.head) this.head = true;
        // An embedded parent, 'leads(id, username)', as PostgREST joins it on <parent>_id.
        this.embeds = [...String(cols || '').matchAll(/(\w+)(?:!inner)?\(/g)].map(m => m[1]);
        return this;
    }
    insert(rows) { this.op = 'insert'; this.rows = [].concat(rows); return this; }
    upsert(rows, o = {}) { this.op = 'upsert'; this.rows = [].concat(rows); this.conflict = String(o.onConflict || 'id').split(',').map(s => s.trim()); return this; }
    update(patch) { this.op = 'update'; this.patch = patch; return this; }
    delete() { this.op = 'delete'; return this; }
    eq(c, v) { this.f.push(r => r[c] === v); return this; }
    neq(c, v) { this.f.push(r => r[c] !== v); return this; }
    in(c, arr) { const s = new Set(arr); this.f.push(r => s.has(r[c])); return this; }
    is(c, v) { this.f.push(r => (v === null ? r[c] == null : r[c] === v)); return this; }
    not(c, op, v) { this.f.push(op === 'is' && v === null ? (r => r[c] != null) : (r => r[c] !== v)); return this; }
    gt(c, v) { this.f.push(r => r[c] > v); return this; }
    gte(c, v) { this.f.push(r => r[c] >= v); return this; }
    lt(c, v) { this.f.push(r => r[c] < v); return this; }
    lte(c, v) { this.f.push(r => r[c] <= v); return this; }
    contains(c, arr) { this.f.push(r => Array.isArray(r[c]) && [].concat(arr).every(v => r[c].includes(v))); return this; }
    like(c, pat) { const re = new RegExp('^' + String(pat).split('%').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'); this.f.push(r => re.test(String(r[c] ?? ''))); return this; }
    ilike(c, pat) { const n = String(pat).replace(/%/g, '').toLowerCase(); this.f.push(r => String(r[c] || '').toLowerCase().includes(n)); return this; }
    or(dsl) { this.f.push(orPredicate(dsl)); return this; }
    order(c, o = {}) { this.ord.push([c, o.ascending !== false]); return this; }
    limit(n) { this.lim = n; return this; }
    range(a, b) { this.rng = [a, b]; return this; }
    maybeSingle() { this.one = 'maybe'; return this; }
    single() { this.one = 'one'; return this; }

    _matched() { return tbl(this.t).filter(r => this.f.every(p => p(r))); }
    _shape(rows, count) {
        if (this.one === 'maybe') return { data: rows[0] || null, error: null, count };
        if (this.one === 'one') return rows[0] ? { data: rows[0], error: null, count } : { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned' }, count };
        return { data: rows, error: null, count };
    }
    _exec() {
        const T = tbl(this.t);
        const now = new Date().toISOString();
        const fill = r => ({ id: crypto.randomUUID(), created_at: now, ...(DEFAULTS[this.t] || {}), ...r });
        if (this.op === 'insert') { const out = this.rows.map(fill); out.forEach(r => T.push(r)); return this._shape(out); }
        if (this.op === 'upsert') {
            const out = [];
            for (const r of this.rows) {
                const i = T.findIndex(x => this.conflict.every(k => x[k] === r[k]));
                if (i >= 0) { Object.assign(T[i], r); out.push(T[i]); } else { const n = fill(r); T.push(n); out.push(n); }
            }
            return this._shape(out);
        }
        if (this.op === 'update') { const m = this._matched(); m.forEach(r => Object.assign(r, this.patch)); return this._shape(m); }
        if (this.op === 'delete') { const gone = new Set(this._matched()); DB[this.t] = T.filter(r => !gone.has(r)); return { data: [...gone], error: null }; }   // the deleted rows, as .delete().select() returns them
        let m = this._matched();
        for (const [c, asc] of this.ord.slice().reverse()) {
            m.sort((a, b) => ((a[c] > b[c]) - (a[c] < b[c])) * (asc ? 1 : -1));
        }
        const count = m.length;
        if (this.rng) m = m.slice(this.rng[0], this.rng[1] + 1);
        if (this.lim != null) m = m.slice(0, this.lim);
        if (this.head) return { data: null, error: null, count };
        const embed = r => {
            const o = { ...r };
            for (const e of this.embeds || []) {
                // Joins the name alone cannot tell (phase 46): a creator post's post, a business's accounts.
                const how = EMBED_JOINS[`${this.t}.${e}`];
                if (how && how.children) { o[e] = tbl(e).filter(x => x[how.children] === r.id); continue; }
                const fk = r[how ? how.fk : e.replace(/s$/, '') + '_id']; o[e] = tbl(e).find(x => x.id === fk) || null;
            }
            return o;
        };
        return this._shape(m.map(embed), count);
    }
    then(res, rej) { let out; try { out = this._exec(); } catch (e) { return Promise.reject(e).then(res, rej); } return Promise.resolve(out).then(res, rej); }
    catch(rej) { return this.then(undefined, rej); }
}

const TOKENS = {};   // bearer token -> auth user
// Storage, for the report photos (phase 36): a bucket that remembers uploads.
const STORAGE = { buckets: new Set(), files: {} };
const fakeSupabase = {
    storage: {
        getBucket: async name => ({ data: STORAGE.buckets.has(name) ? { name } : null, error: null }),
        createBucket: async (name, o) => { STORAGE.buckets.add(name); STORAGE.options = { ...(STORAGE.options || {}), [name]: o || {} }; return { data: { name }, error: null }; },
        from: bucket => ({
            upload: async (path, buf, o) => { STORAGE.files[`${bucket}/${path}`] = { bytes: buf.length, type: o && o.contentType }; return { data: { path }, error: null }; },
            // Phase 48: the private task-media bucket hands out signed links, and loses files with their task.
            createSignedUrls: async (paths, secs) => ({ data: paths.map(path => ({ path, signedUrl: STORAGE.files[`${bucket}/${path}`] ? `https://stub.supabase.co/storage/v1/object/sign/${bucket}/${path}?token=t&exp=${secs}` : null, error: null })), error: null }),
            remove: async (paths) => { for (const path of paths) delete STORAGE.files[`${bucket}/${path}`]; return { data: paths, error: null }; },
            getPublicUrl: path => ({ data: { publicUrl: `https://stub.supabase.co/storage/v1/object/public/${bucket}/${path}` } })
        })
    },
    from: t => new Query(t),
    // Database functions a test scripts (phase 45: el_xp_purge); anything else answers true, as before.
    rpc: (name, args) => Promise.resolve(RPC[name] ? RPC[name](args) : { data: true, error: null }),
    auth: {
        getUser: async token => TOKENS[token] ? { data: { user: TOKENS[token] }, error: null } : { data: null, error: { message: 'bad token' } },
        // The admin API the provisioning routes call. A created user gets a
        // bearer token of 't-<email>' so the test can sign in as them next.
        admin: {
            createUser: async ({ email }) => {
                const user = { id: crypto.randomUUID(), email: String(email).toLowerCase() };
                TOKENS['t-' + user.email] = user;
                return { data: { user }, error: null };
            },
            updateUserById: async () => ({ data: {}, error: null }),
            deleteUser: async () => ({ data: {}, error: null }),
            // A one-time sign-in link, as Supabase makes it: nothing is sent.
            generateLink: async ({ type, email, options }) => ({
                data: { properties: { hashed_token: `hash-${type}-${email}`, action_link: `https://stub.supabase.co/auth/v1/verify?token=once-${encodeURIComponent(email)}&type=${type}&redirect_to=${encodeURIComponent((options && options.redirectTo) || '')}` } },
                error: null
            })
        }
    }
};

// ===========================================================================
// AN EXPRESS THAT REMEMBERS ITS ROUTES
// ===========================================================================
const ROUTES = [];
const appStub = { set() {}, listen() {} };
// app.use is recorded too, in order. Express runs middleware and routes
// strictly in registration order, so a route registered after the API's 404
// catch-all is unreachable. The harness once ignored app.use, and 383 checks
// passed while every /api/xp route answered 404 on Render (22 Sep 2026).
appStub.use = (p, ...h) => {
    if (typeof p !== 'string') { h.unshift(p); p = ''; }
    for (const one of [].concat(p)) ROUTES.push({ m: 'USE', p: one, h });
};
for (const m of ['get', 'post', 'patch', 'put', 'delete']) {
    // Express accepts an array of paths for one handler, and server.js uses
    // that for the two CSV exports. One entry per path, so matching stays flat.
    appStub[m] = (p, ...h) => { for (const one of [].concat(p)) ROUTES.push({ m: m.toUpperCase(), p: one, h }); };
}
// Outbound mail is nodemailer over Gmail SMTP. The stub keeps every message
// and the transport options it was built with, so a test can read the
// address, the credentials and the text the server actually sent.
const MAIL = { sent: [], fail: null };
// ---------------------------------------------------------------------------
// A GEMINI SDK THAT SAYS WHAT THE TEST TELLS IT TO (phase 31)
//
// XpulseAI's chat calls Gemini through the @google/genai SDK, streamed. Same
// idea as GEMINI below: the test scripts each turn's parts, and every request
// is kept, so scope is proven by what reached the model.
// ---------------------------------------------------------------------------
const XP = { script: [], requests: [] };
const RPC = {};
const APIFY = { actors: {}, calls: [], datasets: {} };
const stubs = {
    nodemailer: {
        createTransport: (opts) => ({
            sendMail: async (msg) => {
                MAIL.sent.push({ opts, msg });
                if (MAIL.fail) throw new Error(MAIL.fail);
                return { messageId: 'stub-' + MAIL.sent.length };
            }
        })
    },
    // The framework middleware are pass-throughs: the body is already an object,
    // there are no files to serve, and CORS is not what is under test.
    express: Object.assign(() => appStub, { json: () => (_, __, n) => n && n(), raw: () => (_, __, n) => n && n(), static: () => (_, __, n) => n && n() }),
    cors: () => (_, __, n) => n && n(),
    // An Apify that answers from the test's script (phase 40). Actors are
    // functions of their input; every call is kept. A run finds a key only
    // when the test sets APIFY_API_KEY, so nothing else can reach it.
    'apify-client': { ApifyClient: class {
        user() { return { get: async () => ({ username: 'apify-test' }) }; }
        actor(id) { return { call: async (input) => {
            APIFY.calls.push({ id, input });
            const items = (APIFY.actors[id] || (() => []))(input) || [];
            const ds = 'ds-' + APIFY.calls.length;
            APIFY.datasets[ds] = items;
            return { id: 'run-' + APIFY.calls.length, defaultDatasetId: ds, status: 'SUCCEEDED', usageTotalUsd: 0.001 };
        } }; }
        dataset(id) { return { listItems: async () => ({ items: APIFY.datasets[id] || [] }) }; }
    } },
    '@supabase/supabase-js': { createClient: () => fakeSupabase },
    dotenv: { config() {} },
    '@google/genai': { GoogleGenAI: class {
        constructor(opts) {
            const key = opts && opts.apiKey;
            this.models = {
                generateContentStream: async (req) => {
                    XP.requests.push({ ...req, _key: key });
                    let next = XP.script.shift();
                    if (!next) throw new Error('the test scripted no reply for this turn');
                    if (typeof next === 'function') next = next(req);
                    if (next && next.throw) throw new Error(next.throw);
                    const chunks = [].concat(next).map((c, i, all) => ({
                        candidates: [{ content: { role: 'model', parts: c.parts }, finishReason: i === all.length - 1 ? 'STOP' : undefined }],
                        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 }
                    }));
                    return (async function* () { for (const c of chunks) yield c; })();
                }
            };
        }
    } }
};
const realLoad = Module._load;
Module._load = function (req, ...rest) { return stubs[req] !== undefined ? stubs[req] : realLoad.call(this, req, ...rest); };
process.env.SUPABASE_URL = 'http://stub'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
delete process.env.MASTER_ADMIN_EMAIL;      // the first account to sign in bootstraps as admin
// A known app secret, so a Meta signed_request can be forged HERE and only
// here: the deletion callback must accept exactly what this secret signs.
process.env.META_APP_ID = '1234567890'; process.env.META_APP_SECRET = 'test-app-secret';

// ---------------------------------------------------------------------------
// A GEMINI THAT SAYS WHAT THE TEST TELLS IT TO
//
// The assistant is the one engine whose whole flow can be walked without
// spending anything: its only outside call is the model. So the model is a
// script — the test decides what the model "says" each turn — and every
// request body is kept, so the test can read what the server actually sent:
// which system prompt, and which tool results. That last part is the point:
// scope is proven by what reached the model, not by what the code meant to.
// ---------------------------------------------------------------------------
process.env.GEMINI_API_KEY = 'test-gemini-key';
const GEMINI = { script: [], requests: [] };
const FETCHED = [];   // image addresses the server fetched (phase 36)
const WEB = {};       // business websites the review tracker reads (phase 41): url -> { html, status, location }
global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const reply = (status, body) => ({
        status, ok: status >= 200 && status < 300,
        json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
    });
    if (/generativelanguage\.googleapis\.com\/v1beta\/models\?/.test(u)) {
        return reply(200, { models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }] });
    }
    if (/:generateContent$/.test(u)) {
        const body = JSON.parse(opts.body || '{}');
        GEMINI.requests.push(body);
        let next = GEMINI.script.shift();
        if (!next) return reply(500, 'the test scripted no reply for this turn');
        // A scripted reply may be a function of the request, for the engines
        // whose prompt carries computed input the test cannot know in advance
        // — the content plan's cell keys exist only once the scorecard does.
        if (typeof next === 'function') next = next(body);
        return reply(200, { candidates: [{ content: { role: 'model', parts: next.parts }, finishReason: 'STOP' }] });
    }
    if (WEB[u]) {
        const w = WEB[u];
        return { ok: (w.status || 200) < 300, status: w.status || 200, headers: { get: h => (/content-type/i.test(h) ? 'text/html; charset=utf-8' : /location/i.test(h) ? (w.location || null) : null) }, text: async () => w.html || '' };
    }
    if (/cdninstagram\.com\//.test(u)) {
        FETCHED.push(u);
        return { ok: true, status: 200, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => new Uint8Array([255, 216, 255, 224, 0, 16]).buffer };
    }
    if (/graph\.facebook\.com\//.test(u)) {
        // A refused token, for the daily read's expiry path.
        if (GRAPH.fail) return reply(GRAPH.fail.status || 401, { error: { message: GRAPH.fail.message || 'Error validating access token', code: 190 } });
        return reply(200, GRAPH.answer(new URL(u)));
    }
    return reply(404, `the test fake has no answer for ${u}`);
};

// ---------------------------------------------------------------------------
// A GRAPH API WITH ONE ACCOUNT IN IT
//
// Enough of Meta's Graph API for the monthly report to run: Page and
// Instagram insights for two months (chosen by the `since` the server asks
// for), the account, follower demographics, the month's media and each
// post's insights. The numbers are fixed so the report's arithmetic can be
// checked exactly — including the cases that make a report lie: a metric
// that was zero last month ("new", not +Infinity%) and one that barely moved.
// ---------------------------------------------------------------------------
const GRAPH = {
    PAGE: '77001', IG: '17841400000000001',
    AUG_1: Date.UTC(2026, 7, 1) / 1000,
    daily: null,          // { 'YYYY-MM-DD': { reach, … } } — answers per-day total_value reads (phase 30)
    igFollowers: null,    // today's follower count, when a test moves it
    fail: null,           // { status } — every Graph call refused, for the expiry path
    cur:  { page: { page_impressions_unique: 8120, page_post_engagements: 940, page_views_total: 500, page_fan_adds_unique: 40 },
            ig:   { reach: 41820, views: 96400, accounts_engaged: 3180, total_interactions: 5910, profile_views: 1204, website_clicks: 77, follower_count: 412 } },
    prev: { page: { page_impressions_unique: 7000, page_post_engagements: 1120, page_views_total: 480, page_fan_adds_unique: 35 },
            ig:   { reach: 28410, views: 71200, accounts_engaged: 3160, total_interactions: 6430, profile_views: 1309, website_clicks: 90, follower_count: 0 } },
    answer(url) {
        const seg = url.pathname.split('/').filter(Boolean).slice(1);   // drop the version
        const q = url.searchParams;
        const set = Number(q.get('since') || 0) >= GRAPH.AUG_1 ? GRAPH.cur : GRAPH.prev;
        const metrics = String(q.get('metric') || '').split(',').filter(Boolean);
        if (seg[0] === GRAPH.PAGE && seg[1] === 'insights') {
            return { data: metrics.map(name => ({ name, values: [{ end_time: '2026-08-31T07:00:00+0000', value: set.page[name] ?? 0 }] })) };
        }
        if (seg[0] === GRAPH.IG && seg[1] === 'insights' && GRAPH.daily && q.get('metric_type') === 'total_value' && q.get('since')) {
            const day = new Date(Number(q.get('since')) * 1000).toISOString().slice(0, 10);
            const row = GRAPH.daily[day] || {};
            return { data: metrics.map(name => ({ name, total_value: { value: row[name] ?? 0 } })) };
        }
        if (seg[0] === GRAPH.IG && seg[1] === 'insights') {
            if (metrics[0] === 'follower_demographics') {
                const rows = { age: [['25-34', 3900], ['35-44', 2600]], gender: [['F', 5600], ['M', 3400]], city: [['Boston', 4100]], country: [['US', 8800]] }[q.get('breakdown')] || [];
                return { data: [{ total_value: { breakdowns: [{ results: rows.map(([k, v]) => ({ dimension_values: [k], value: v })) }] } }] };
            }
            return { data: metrics.map(name => ({ name, total_value: { value: set.ig[name] ?? 0 } })) };
        }
        if (seg[0] === GRAPH.IG && seg[1] === 'media') {
            return { data: [
                { id: 'm1', caption: 'The seasonal menu, start to finish.', media_type: 'VIDEO', media_product_type: 'REELS', timestamp: '2026-08-10T10:00:00+0000', like_count: 300, comments_count: 20, permalink: 'https://instagram.com/p/abc', shortcode: 'abc', thumbnail_url: 'https://scontent-bos5-1.cdninstagram.com/v/m1-thumb.jpg?oe=x' },
                { id: 'm2', caption: 'July throwback.', media_type: 'IMAGE', media_product_type: 'FEED', timestamp: '2026-07-30T10:00:00+0000', like_count: 90, comments_count: 4, permalink: 'https://instagram.com/p/def', shortcode: 'def' }
            ] };
        }
        if (seg[0] === 'm1' && seg[1] === 'insights') {
            return { data: [['reach', 11240], ['saved', 184], ['shares', 96], ['views', 30000], ['total_interactions', 600]].map(([name, v]) => ({ name, values: [{ value: v }] })) };
        }
        if (seg[0] === GRAPH.PAGE) return { id: GRAPH.PAGE, name: 'Harbor Cafe', fan_count: 4800, followers_count: 4820, category: 'Cafe' };
        if (seg[0] === GRAPH.IG)   return { id: GRAPH.IG, username: 'harborcafe', name: 'Harbor Cafe', followers_count: GRAPH.igFollowers ?? 9240, follows_count: 300, media_count: 120 };
        return { data: [] };
    }
};

const S = require(path.join(__dirname, '..', 'server.js'));

function matchPath(pattern, p) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    const m = re.exec(p);
    return m ? Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) : null;
}

/**
 * Call a route the way Express would: every app.use and every route, in
 * registration order, each handler running until one answers or declines
 * to call next(). A path nothing registered throws; a path only the API's
 * 404 catch-all answers comes back as that 404, as it would in production.
 */
async function call(method, p, { token, body, query, ip } = {}) {
    const req = {
        method, path: p, originalUrl: p, url: p, params: {},
        body: body || {}, query: query || {}, ip: ip || '127.0.0.1',
        headers: token ? { authorization: 'Bearer ' + token } : {},
        get(h) { return this.headers[String(h).toLowerCase()]; }
    };
    const res = {
        statusCode: 200, body: null, headers: {}, sent: false, writes: [], writableEnded: false,
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; this.sent = true; return this; },
        send(b) { this.body = b; this.sent = true; return this; },
        end(b) { if (b !== undefined) this.write(b); this.sent = true; this.writableEnded = true; },
        write(b) { this.writes.push(String(b)); }, flushHeaders() {}, on() {},
        setHeader(k, v) { this.headers[k] = v; },
        set(k, v) { if (typeof k === 'object') Object.assign(this.headers, k); else this.headers[k] = v; return this; },
        get(k) { return this.headers[k]; },
        type() { return this; },
        redirect(u) { this.statusCode = 302; this.headers.location = u; this.sent = true; }
    };
    let matched = false;
    const steps = [];
    for (const r of ROUTES) {
        let params = null;
        if (r.m === 'USE') {
            const prefix = r.p.replace(/\/+$/, '');
            if (prefix && p !== prefix && !p.startsWith(prefix + '/')) continue;
        } else {
            if (r.m !== method) continue;
            params = matchPath(r.p, p);
            if (!params) continue;
            matched = true;
        }
        for (const fn of r.h) if (fn.length !== 4) steps.push({ fn, params });   // error handlers: nothing has thrown
    }
    if (!matched) throw new Error(`no route ${method} ${p}`);
    // Like Express, the rest of the chain runs INSIDE next(): a middleware that
    // wraps next() in a context (the per-request user, phase 44) wraps the route.
    const go = async (i) => {
        if (i >= steps.length || res.sent) return;
        const s = steps[i];
        if (s.params) req.params = s.params;
        let downstream = null;
        await s.fn(req, res, () => { downstream = go(i + 1); return downstream; });
        if (downstream) await downstream;
    };
    await go(0);
    return res;
}

// ===========================================================================
// THE PEOPLE
// ===========================================================================
const person = (email) => ({ id: crypto.randomUUID(), email });
const ADMIN  = person('admin@agency.test');
const EMP    = person('emp@agency.test');
const EMP2   = person('emp2@agency.test');
const CLIENT = person('owner@harborcafe.test');
TOKENS['t-admin'] = ADMIN; TOKENS['t-emp'] = EMP; TOKENS['t-emp2'] = EMP2; TOKENS['t-client'] = CLIENT;

// Employees are provisioned by an admin (POST /api/admin/users talks to the
// Supabase admin API, which the fake does not have), so their rows are seeded
// the way that route would write them.
for (const u of [EMP, EMP2]) {
    tbl('app_users').push({ id: u.id, email: u.email, role: 'user', is_active: true, full_name: null });
    for (const e of ['report', 'leadgen', 'fb_community']) tbl('user_engine_access').push({ user_id: u.id, engine: e });
}
const ctxOf = (u, role) => ({ user: u, profile: { id: u.id, email: u.email, role, is_active: true } });

/** Phase 51: a report reaches the owner only once the team shares it, so share it, then open it as the owner. */
async function ownerOpen(id) {
    const sh = await call('PATCH', `/api/reports/${id}/visibility`, { token: 't-admin', body: { visible: true } });
    if (sh.statusCode !== 200) throw new Error('could not share the report: ' + JSON.stringify(sh.body));
    return call('GET', `/api/client/report/${id}`, { token: 't-client' });
}

let passed = 0;
const pending = [];
function test(name, fn) {
    pending.push(async () => {
        try { await fn(); passed++; console.log('  ok   ' + name); }
        catch (e) { console.log('  FAIL ' + name + '\n       ' + (e.message || e)); process.exitCode = 1; }
    });
}
// Headings are queued too, so they print beside their tests rather than all
// at the top before any test has run.
function section(title) { pending.push(async () => console.log(title)); }
const state = {};

// ===========================================================================
// THE WORKFLOWS — in order, because each one is the next one's precondition
// ===========================================================================
section('an agency starts up');
test('the first account to sign in becomes the admin', async () => {
    const r = await call('GET', '/api/me', { token: 't-admin' });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.role, 'admin');
});
test('the admin creates a client', async () => {
    const r = await call('POST', '/api/clients', { token: 't-admin', body: { name: 'Harbor Cafe', ig_handle: '@HarborCafe', niche: 'coffee', location: 'Boston' } });
    assert.strictEqual(r.statusCode, 201, JSON.stringify(r.body));
    state.C = r.body.client.id;
    assert.strictEqual(r.body.client.ig_handle, 'harborcafe', 'the handle is normalised');
});
test('the admin assigns an employee to it', async () => {
    const r = await call('POST', `/api/clients/${state.C}/members`, { token: 't-admin', body: { email: EMP.email, role: 'editor' } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.member.role, 'editor');
});

section('\nthe employee does the work');
test('the employee sees the client they were assigned', async () => {
    const r = await call('GET', '/api/clients', { token: 't-emp' });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    const c = (r.body.clients || []).find(x => x.id === state.C);
    assert.ok(c, 'the assigned client is not in the employee\'s list');
    assert.strictEqual(c.access, 'editor');
});
test('with no client chosen, a run is refused — not filed under nothing', async () => {
    await assert.rejects(S.resolveClientId({ body: {} }, ctxOf(EMP, 'user')), e => e.statusCode === 400 && e.code === 'client_required');
});
test('…and the real route refuses before it creates anything', async () => {
    const before = tbl('jobs').length;
    const r = await call('POST', '/api/generate-ig-report', { token: 't-emp', body: { target: 'harborcafe', postsLimit: 10 } });
    assert.strictEqual(r.statusCode, 400, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'client_required');
    assert.strictEqual(tbl('jobs').length, before, 'a job row was written for a run that was refused');
});
test('with the client chosen, the run is filed under it', async () => {
    const cid = await S.resolveClientId({ body: { clientId: state.C } }, ctxOf(EMP, 'user'));
    assert.strictEqual(cid, state.C);
    const job = await S.createJob(EMP.id, 'ig_report', 'report', { clientId: cid, target: 'harborcafe' }, 0);
    assert.strictEqual(job.client_id, state.C, 'the job does not carry the client');
    state.job = job.id;
    tbl('reports').push({ id: crypto.randomUUID(), user_id: EMP.id, client_id: state.C, report_type: 'ig_report', platform: 'instagram', target_handle: 'harborcafe', score: 71, created_at: new Date().toISOString() });
});
test('the work appears in the client\'s timeline', async () => {
    const r = await call('GET', `/api/clients/${state.C}/timeline`, { token: 't-emp' });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.ok(r.body.jobs.some(j => j.id === state.job), 'the job is missing from the timeline');
    assert.ok(r.body.reports.some(x => x.client_id === state.C), 'the report is missing from the timeline');
});

section('\nthe walls hold');
test('an employee who was not assigned cannot see the client\'s timeline', async () => {
    const r = await call('GET', `/api/clients/${state.C}/timeline`, { token: 't-emp2' });
    assert.strictEqual(r.statusCode, 404, JSON.stringify(r.body));
});
test('…nor file work under it', async () => {
    await assert.rejects(S.resolveClientId({ body: { clientId: state.C } }, ctxOf(EMP2, 'user')), e => e.statusCode === 403);
});
test('…nor see it in their own list', async () => {
    const r = await call('GET', '/api/clients', { token: 't-emp2' });
    assert.ok(!(r.body.clients || []).some(x => x.id === state.C));
});

section('\nthe admin can hand out work on a client an employee created');
test('an employee creates a client of their own', async () => {
    const r = await call('POST', '/api/clients', { token: 't-emp', body: { name: 'Bloom Florist' } });
    assert.strictEqual(r.statusCode, 201);
    state.D = r.body.client.id;
});
test('the admin sees it, although they neither own it nor were added to it', async () => {
    const r = await call('GET', '/api/clients', { token: 't-admin' });
    const d = (r.body.clients || []).find(x => x.id === state.D);
    assert.ok(d, 'an admin cannot see a client an employee created');
    assert.strictEqual(d.access, 'admin');
});
test('the admin assigns a second employee to it', async () => {
    // Before phase 22 this was a 404: clientAccess had no admin path, so only
    // the owner could assign, and the person whose job is handing out work
    // could not.
    const r = await call('POST', `/api/clients/${state.D}/members`, { token: 't-admin', body: { email: EMP2.email, role: 'editor' } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    const seen = await call('GET', '/api/clients', { token: 't-emp2' });
    assert.ok(seen.body.clients.some(x => x.id === state.D), 'the assignment did not reach the employee');
});

section('\na business signs itself up');
test('a self-serve account is a client on a trial, and is its own business', async () => {
    const r = await call('GET', '/api/me', { token: 't-client' });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.role, 'client');
    assert.ok(r.body.business && r.body.business.id, 'no business record for a client account');
    assert.strictEqual(r.body.business.name, 'owner', 'the name should come from the email until they rename it');
    state.own = r.body.business.id;
    const row = tbl('clients').find(c => c.id === state.own);
    assert.strictEqual(row.owner_user_id, CLIENT.id);
});
test('a client account never has to pick — its work files under itself', async () => {
    const cid = await S.resolveClientId({ body: {} }, ctxOf(CLIENT, 'client'));
    assert.strictEqual(cid, state.own);
});
test('the client is not asked to see the agency\'s work yet — it has none', async () => {
    const r = await call('GET', '/api/client/reports', { token: 't-client' });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.body.reports.length, 0);
});

section('\nthe agency takes that business on');
test('inviting the client account as the owner of the agency\'s record absorbs its empty own record', async () => {
    // Phase 57: a business owner's login is never added as a teammate; the owner invite links it.
    const team = await call('POST', `/api/clients/${state.C}/members`, { token: 't-admin', body: { email: CLIENT.email, role: 'editor' } });
    assert.strictEqual(team.statusCode, 400, 'a business owner was added as a teammate');
    const r = await call('POST', `/api/clients/${state.C}/portal-invite`, { token: 't-admin', body: { email: CLIENT.email } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.absorbed, state.own, 'the empty auto-created record was not absorbed');
    const row = tbl('clients').find(c => c.id === state.own);
    assert.strictEqual(row.archived, true, 'absorbed means archived, never deleted');
});
test('the client account now IS the agency\'s record — its runs go there', async () => {
    const cid = await S.resolveClientId({ body: {} }, ctxOf(CLIENT, 'client'));
    assert.strictEqual(cid, state.C, 'a client run would land in a second, separate record');
});
test('…and it sees the agency\'s reports only once the team shares them (phase 51)', async () => {
    const before = await call('GET', '/api/client/reports', { token: 't-client' });
    assert.strictEqual(before.statusCode, 200);
    const rep = tbl('reports').find(x => x.client_id === state.C && x.target_handle === 'harborcafe');
    assert.ok(rep, 'the agency has a report on this client');
    assert.ok(!before.body.reports.some(x => x.id === rep.id), 'a report reached the owner before the team shared it');
    const hidden = await call('GET', `/api/client/report/${rep.id}`, { token: 't-client' });
    assert.strictEqual(hidden.statusCode, 404, 'and it cannot be opened by id either');
    const viewer = await call('PATCH', `/api/reports/${rep.id}/visibility`, { token: 't-client', body: { visible: true } });
    assert.strictEqual(viewer.statusCode, 403, 'an owner cannot share a report with themselves');
    const sh = await call('PATCH', `/api/reports/${rep.id}/visibility`, { token: 't-emp', body: { visible: true } });
    assert.strictEqual(sh.statusCode, 200, JSON.stringify(sh.body));
    const st = await call('GET', `/api/reports/${rep.id}/visibility`, { token: 't-emp' });
    assert.strictEqual(st.body.visibleToClient, true);
    const after = await call('GET', '/api/client/reports', { token: 't-client' });
    assert.ok(after.body.reports.some(x => x.id === rep.id), 'the shared report is missing for the owner');
});
test('a record with work in it is never absorbed', async () => {
    // D has a job filed under it now; adding its owner as a member elsewhere must not touch it.
    tbl('jobs').push({ id: crypto.randomUUID(), user_id: EMP.id, client_id: state.D, type: 'ig_report', status: 'done', created_at: new Date().toISOString() });
    const owner = person('bloom@florist.test'); TOKENS['t-bloom'] = owner;
    tbl('app_users').push({ id: owner.id, email: owner.email, role: 'client', is_active: true });
    tbl('clients').push({ id: crypto.randomUUID(), owner_user_id: owner.id, name: 'Bloom own', archived: false, created_at: new Date().toISOString() });
    const own = tbl('clients').find(c => c.owner_user_id === owner.id);
    tbl('reports').push({ id: crypto.randomUUID(), user_id: owner.id, client_id: own.id, report_type: 'ig_report', created_at: new Date().toISOString() });
    // Phase 57: owners are linked by the owner invite, which refuses a login whose own business has work in it.
    const r = await call('POST', `/api/clients/${state.C}/portal-invite`, { token: 't-admin', body: { email: owner.email } });
    assert.strictEqual(r.statusCode, 409, JSON.stringify(r.body));
    assert.strictEqual(tbl('clients').find(c => c.id === own.id).archived, false);
});

section('\nthe client row says whether Meta is connected');
test('not connected until it is', async () => {
    const r = await call('GET', '/api/clients', { token: 't-admin' });
    const c = r.body.clients.find(x => x.id === state.C);
    assert.deepStrictEqual(c.meta, { connected: false, pages: 0, active: 0, names: [] });
});
test('connected once a Page is filed under it', async () => {
    tbl('meta_connections').push({ id: crypto.randomUUID(), user_id: EMP.id, client_id: state.C, page_id: '1', page_name: 'Harbor Cafe', status: 'active', created_at: new Date().toISOString() });
    const r = await call('GET', '/api/clients', { token: 't-admin' });
    const c = r.body.clients.find(x => x.id === state.C);
    assert.strictEqual(c.meta.connected, true);
    assert.strictEqual(c.meta.active, 1);
    assert.deepStrictEqual(c.meta.names, ['Harbor Cafe']);
    const d = r.body.clients.find(x => x.id === state.D);
    assert.strictEqual(d.meta.connected, false, 'one client\'s connection leaked onto another');
});
test('an expired connection is a page, not a connection', async () => {
    tbl('meta_connections').push({ id: crypto.randomUUID(), user_id: EMP.id, client_id: state.D, page_id: '2', page_name: 'Bloom', status: 'expired', created_at: new Date().toISOString() });
    const r = await call('GET', '/api/clients', { token: 't-admin' });
    const d = r.body.clients.find(x => x.id === state.D);
    assert.strictEqual(d.meta.connected, false);
    assert.strictEqual(d.meta.pages, 1);
});

// ===========================================================================
// PHASE 23 — leads belong to clients; one business, one record
// ===========================================================================
section('\nfor this client, these are the leads');
test('a lead found for a client is linked to it, and the link is idempotent', async () => {
    const lead = { id: crypto.randomUUID(), owner_user_id: EMP.id, platform: 'instagram', username: 'northendpizza', email: 'hi@nep.test', created_at: new Date().toISOString() };
    tbl('leads').push(lead);
    state.leadC = lead.id;
    assert.strictEqual(await S.linkLeadsToClient(state.C, [lead.id], 'ig_campaign', state.job), 1);
    await S.linkLeadsToClient(state.C, [lead.id], 'ig_campaign', state.job);       // a resumed run replays its save phase
    assert.strictEqual(tbl('client_leads').filter(l => l.lead_id === lead.id).length, 1, 'the replay duplicated the link');
});
test('the client view shows that lead; another client\'s view does not', async () => {
    const other = { id: crypto.randomUUID(), owner_user_id: EMP.id, platform: 'facebook', username: 'bloomflorist', phone: '+1', created_at: new Date().toISOString() };
    tbl('leads').push(other);
    await S.linkLeadsToClient(state.D, [other.id], 'fb_discovery');
    const c = await call('GET', '/api/leads', { token: 't-emp', query: { client_only: '1', client_id: state.C } });
    assert.strictEqual(c.statusCode, 200, JSON.stringify(c.body));
    assert.deepStrictEqual(c.body.leads.map(l => l.username), ['northendpizza']);
    assert.strictEqual(c.body.client.name, 'Harbor Cafe');
    const d = await call('GET', '/api/leads', { token: 't-emp', query: { client_only: '1', client_id: state.D } });
    assert.deepStrictEqual(d.body.leads.map(l => l.username), ['bloomflorist']);
});
test('a lead found by a colleague is in the client\'s view and in the one master list; "mine" stays my own rows', async () => {
    // The admin found this one while working on Harbor Cafe. Since phase 29
    // there is one list for the whole agency, so the employee sees it there
    // too; "mine" is the one view that is only their own rows.
    const theirs = { id: crypto.randomUUID(), owner_user_id: ADMIN.id, platform: 'instagram', username: 'harborbakery', created_at: new Date().toISOString() };
    tbl('leads').push(theirs);
    await S.linkLeadsToClient(state.C, [theirs.id], 'ig_campaign');
    const view = await call('GET', '/api/leads', { token: 't-emp', query: { client_only: '1', client_id: state.C } });
    assert.ok(view.body.leads.some(l => l.username === 'harborbakery'), 'a colleague\'s find is missing from the client view');
    const agency = await call('GET', '/api/leads', { token: 't-emp' });
    assert.strictEqual(agency.body.scope, 'agency');
    assert.ok(agency.body.leads.some(l => l.username === 'harborbakery'), 'a colleague\'s find is missing from the one master list');
    const mine = await call('GET', '/api/leads', { token: 't-emp', query: { mine: '1' } });
    assert.strictEqual(mine.body.scope, 'mine');
    assert.ok(!mine.body.leads.some(l => l.username === 'harborbakery'), 'a colleague\'s lead is in my own rows');
});
test('the same business found twice for one client is one row in its view', async () => {
    const again = { id: crypto.randomUUID(), owner_user_id: ADMIN.id, platform: 'instagram', username: 'northendpizza', is_enriched: true, created_at: new Date(Date.now() + 1000).toISOString() };
    tbl('leads').push(again);
    await S.linkLeadsToClient(state.C, [again.id], 'ig_campaign');
    const view = await call('GET', '/api/leads', { token: 't-emp', query: { client_only: '1', client_id: state.C } });
    const rows = view.body.leads.filter(l => l.username === 'northendpizza');
    assert.strictEqual(rows.length, 1, 'the client view shows the same business twice');
    assert.strictEqual(rows[0].is_enriched, true, 'the richer row should win');
});
test('the summary tiles agree with the list they sit above', async () => {
    const s = await call('GET', '/api/leads/summary', { token: 't-emp', query: { client_only: '1', client_id: state.C } });
    const v = await call('GET', '/api/leads', { token: 't-emp', query: { client_only: '1', client_id: state.C } });
    assert.strictEqual(s.body.total, v.body.total);
    assert.strictEqual(s.body.client.name, 'Harbor Cafe');
});
test('a stranger asking for a client\'s leads is refused, not shown their own', async () => {
    const r = await call('GET', '/api/leads', { token: 't-emp2', query: { client_only: '1', client_id: state.C } });
    assert.strictEqual(r.statusCode, 404, JSON.stringify(r.body));
});
test('the export follows the same scope', async () => {
    const r = await call('GET', '/api/leads/export.csv', { token: 't-emp', query: { client_only: '1', client_id: state.C } });
    assert.strictEqual(r.statusCode, 200);
    assert.ok(String(r.body).includes('northendpizza') && String(r.body).includes('harborbakery'));
    assert.ok(!String(r.body).includes('bloomflorist'), 'another client\'s lead is in this client\'s export');
});

section('\none business, one record');
test('a dry run says what would move and moves nothing', async () => {
    const r = await call('POST', '/api/clients', { token: 't-admin', body: { name: 'Harbor Cafe (old)' } });
    state.E = r.body.client.id;
    tbl('reports').push({ id: crypto.randomUUID(), user_id: ADMIN.id, client_id: state.E, report_type: 'ig_report', created_at: new Date().toISOString() });
    tbl('jobs').push({ id: crypto.randomUUID(), user_id: ADMIN.id, client_id: state.E, type: 'ig_report', status: 'done', created_at: new Date().toISOString() });
    await S.linkLeadsToClient(state.E, [state.leadC], 'ig_campaign');           // already linked to C too — must not conflict
    await call('POST', `/api/clients/${state.E}/members`, { token: 't-admin', body: { email: EMP2.email, role: 'viewer' } });
    const dry = await call('POST', `/api/clients/${state.C}/merge`, { token: 't-admin', body: { fromId: state.E }, query: { dry: '1' } });
    assert.strictEqual(dry.statusCode, 200, JSON.stringify(dry.body));
    assert.strictEqual(dry.body.dry, true);
    assert.strictEqual(dry.body.counts.reports, 1);
    assert.strictEqual(dry.body.counts.jobs, 1);
    assert.strictEqual(dry.body.counts.client_leads, 1);
    assert.strictEqual(dry.body.counts.client_members, 1);
    assert.strictEqual(tbl('reports').filter(x => x.client_id === state.E).length, 1, 'a dry run moved a report');
});
test('the merge re-points everything, carries members over, and archives — never deletes', async () => {
    const before = tbl('reports').filter(x => x.client_id === state.C).length;
    const r = await call('POST', `/api/clients/${state.C}/merge`, { token: 't-admin', body: { fromId: state.E } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.strictEqual(tbl('reports').filter(x => x.client_id === state.E).length, 0);
    assert.strictEqual(tbl('reports').filter(x => x.client_id === state.C).length, before + 1);
    assert.strictEqual(tbl('jobs').filter(x => x.client_id === state.E).length, 0);
    assert.strictEqual(tbl('client_leads').filter(x => x.client_id === state.E).length, 0);
    assert.strictEqual(tbl('client_leads').filter(x => x.client_id === state.C && x.lead_id === state.leadC).length, 1, 'a lead on both became two links or none');
    assert.ok(tbl('client_members').some(m => m.client_id === state.C && m.user_id === EMP2.id), 'the viewer was not carried over');
    const e = tbl('clients').find(c => c.id === state.E);
    assert.strictEqual(e.archived, true);
    assert.ok(/Merged into "Harbor Cafe"/.test(e.notes), 'the archived record does not say where it went');
    assert.ok(tbl('clients').some(c => c.id === state.E), 'the record was deleted');
});
test('an employee cannot merge clients they do not own', async () => {
    const x = await call('POST', '/api/clients', { token: 't-admin', body: { name: 'Not yours' } });
    const r = await call('POST', `/api/clients/${state.D}/merge`, { token: 't-emp', body: { fromId: x.body.client.id } });
    assert.strictEqual(r.statusCode, 404, JSON.stringify(r.body));
});
test('a client cannot be merged into itself', async () => {
    const r = await call('POST', `/api/clients/${state.C}/merge`, { token: 't-admin', body: { fromId: state.C } });
    assert.strictEqual(r.statusCode, 400);
});

section('\nthe account states a client can be in');
test('an expired trial is refused at the door with a code the page can act on', async () => {
    const u = person('expired@x.test'); TOKENS['t-expired'] = u;
    const past = new Date(Date.now() - 20 * 86400000).toISOString();
    tbl('app_users').push({ id: u.id, email: u.email, role: 'client', is_active: true, trial_started_at: past, trial_ends_at: past });
    const r = await call('GET', '/api/me', { token: 't-expired' });
    assert.strictEqual(r.statusCode, 402, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'account_expired');
});
test('a suspended account is refused with a different code, so the page can say why', async () => {
    const u = person('suspended@x.test'); TOKENS['t-susp'] = u;
    tbl('app_users').push({ id: u.id, email: u.email, role: 'user', is_active: false });
    const r = await call('GET', '/api/me', { token: 't-susp' });
    assert.strictEqual(r.statusCode, 403, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'account_suspended');
});
test('a paying client is active until paid_until, and its state says so', async () => {
    const u = person('paid@x.test'); TOKENS['t-paid'] = u;
    const past = new Date(Date.now() - 40 * 86400000).toISOString();
    tbl('app_users').push({ id: u.id, email: u.email, role: 'client', is_active: true, trial_started_at: past, trial_ends_at: past, paid_until: new Date(Date.now() + 30 * 86400000).toISOString() });
    const r = await call('GET', '/api/me', { token: 't-paid' });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.state, 'paid');
});

section('\na report goes out to someone with no account');
test('the employee makes a share link for the client\'s report', async () => {
    const rep = tbl('reports').find(x => x.client_id === state.C && x.target_handle === 'harborcafe');
    const r = await call('POST', '/api/share', { token: 't-emp', body: { reportId: rep.id, label: 'September' } });
    assert.strictEqual(r.statusCode, 201, JSON.stringify(r.body));
    state.share = r.body.share;
    assert.ok(r.body.url.includes(state.share.token));
});
test('anyone with the link can read it — no session', async () => {
    const r = await call('GET', `/api/public/share/${state.share.token}`);
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.ok(r.body.report && r.body.report.id === state.share.report_id);
});
test('a stranger cannot revoke it; the maker can; then the link is dead', async () => {
    const no = await call('DELETE', `/api/share/${state.share.id}`, { token: 't-emp2' });
    assert.ok(no.statusCode === 403 || no.statusCode === 404, 'a stranger revoked someone else\'s share');
    const yes = await call('DELETE', `/api/share/${state.share.id}`, { token: 't-emp' });
    assert.strictEqual(yes.statusCode, 200, JSON.stringify(yes.body));
    const gone = await call('GET', `/api/public/share/${state.share.token}`);
    assert.strictEqual(gone.statusCode, 404);
});

// ===========================================================================
// PHASE 24 — the client sees what was found for them; Meta can ask us to forget
// ===========================================================================
section('\nthe client sees the leads their team found for them');
test('agency finds show up on the client\'s own surface, marked as the team\'s', async () => {
    // CLIENT is an editor of C since the agency took them on. northendpizza
    // and harborbakery were found for C by EMP and ADMIN.
    const r = await call('GET', '/api/client/leads', { token: 't-client' });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    const names = r.body.leads.map(l => l.username);
    assert.ok(names.includes('northendpizza') && names.includes('harborbakery'), 'the team\'s finds are missing: ' + names.join(','));
    assert.ok(r.body.foundForYou >= 2, 'foundForYou should count the team\'s finds');
    assert.ok(r.body.leads.find(l => l.username === 'harborbakery').foundForYou === true);
});
test('…but not another client\'s leads', async () => {
    const r = await call('GET', '/api/client/leads', { token: 't-client' });
    assert.ok(!r.body.leads.some(l => l.username === 'bloomflorist'), 'a lead found for a different client leaked to this one');
});

section('\nMeta asks us to forget someone');
const b64url = v => Buffer.from(v).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function signedRequest(payload, secret = 'test-app-secret') {
    const body = b64url(JSON.stringify({ algorithm: 'HMAC-SHA256', ...payload }));
    const sig = crypto.createHmac('sha256', secret).update(body).digest();
    return b64url(sig) + '.' + body;
}
test('a request signed with the wrong secret is rejected before anything is read', async () => {
    const r = await call('POST', '/api/meta/data-deletion', { body: { signed_request: signedRequest({ user_id: '999' }, 'not-our-secret') } });
    assert.strictEqual(r.statusCode, 400, JSON.stringify(r.body));
});
test('a tampered payload is rejected', async () => {
    const good = signedRequest({ user_id: '999' });
    const [sig] = good.split('.');
    const tampered = sig + '.' + b64url(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: '111' }));
    const r = await call('POST', '/api/meta/data-deletion', { body: { signed_request: tampered } });
    assert.strictEqual(r.statusCode, 400);
});
test('garbage is rejected without throwing', async () => {
    for (const junk of ['', 'a.b.c', 'nodot', null, '..']) {
        const r = await call('POST', '/api/meta/data-deletion', { body: { signed_request: junk } });
        assert.strictEqual(r.statusCode, 400, JSON.stringify(junk));
    }
});
test('a genuine request deletes the person\'s connections and owner-side reports, and nothing else', async () => {
    const fb = '7788990011';
    const conn = { id: crypto.randomUUID(), user_id: EMP.id, client_id: state.C, page_id: '9', page_name: 'Harbor Cafe', fb_user_id: fb, status: 'active', created_at: new Date().toISOString() };
    tbl('meta_connections').push(conn);
    tbl('meta_media').push({ id: crypto.randomUUID(), connection_id: conn.id, user_id: EMP.id, media_id: 'm1' });
    tbl('meta_snapshots').push({ id: crypto.randomUUID(), connection_id: conn.id, user_id: EMP.id, level: 'ig' });
    const ownerRep = { id: crypto.randomUUID(), user_id: EMP.id, client_id: state.C, platform: 'meta', report_type: 'meta_monthly', meta_connection_id: conn.id, created_at: new Date().toISOString() };
    tbl('reports').push(ownerRep);
    const scrapedBefore = tbl('reports').filter(x => x.platform !== 'meta').length;

    const r = await call('POST', '/api/meta/data-deletion', { body: { signed_request: signedRequest({ user_id: fb }) } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.ok(/^[a-f0-9]{24}$/.test(r.body.confirmation_code), 'no confirmation code');
    assert.ok(String(r.body.url).includes('data-deletion.html?code=' + r.body.confirmation_code), 'the status URL does not carry the code');
    state.delCode = r.body.confirmation_code;

    assert.ok(!tbl('meta_connections').some(c => c.id === conn.id), 'the connection survived');
    assert.ok(!tbl('reports').some(x => x.id === ownerRep.id), 'the owner-side report survived');
    assert.strictEqual(tbl('reports').filter(x => x.platform !== 'meta').length, scrapedBefore, 'a scraped report was deleted — those name no Facebook user');
});
test('the status page can look the request up, and nothing else', async () => {
    const ok = await call('GET', `/api/public/meta/deletion/${state.delCode}`);
    assert.strictEqual(ok.statusCode, 200, JSON.stringify(ok.body));
    assert.strictEqual(ok.body.status, 'complete');
    assert.strictEqual(ok.body.connections, 1);
    assert.strictEqual(ok.body.reports, 1);
    const no = await call('GET', '/api/public/meta/deletion/' + 'f'.repeat(24));
    assert.strictEqual(no.statusCode, 404);
    const bad = await call('GET', '/api/public/meta/deletion/not-a-code');
    assert.strictEqual(bad.statusCode, 404);
});
test('a request for someone we hold nothing on still completes, honestly', async () => {
    const r = await call('POST', '/api/meta/data-deletion', { body: { signed_request: signedRequest({ user_id: 'nobody-here' }) } });
    assert.strictEqual(r.statusCode, 200);
    const s = await call('GET', `/api/public/meta/deletion/${r.body.confirmation_code}`);
    assert.strictEqual(s.body.connections, 0);
});

// ===========================================================================
// PHASE 25 — the rows that were "built, never exercised"
// ===========================================================================
section('\nthe admin provisions people and hands out tools');
test('the admin creates an employee with one engine, who can then sign in and sees exactly that', async () => {
    const r = await call('POST', '/api/admin/users', { token: 't-admin', body: { email: 'New.Hire@agency.test', password: 'a-strong-password', fullName: 'New Hire', role: 'user', engines: ['report'] } });
    assert.ok(r.statusCode === 200 || r.statusCode === 201, JSON.stringify(r.body));
    const me = await call('GET', '/api/me', { token: 't-new.hire@agency.test' });
    assert.strictEqual(me.statusCode, 200, JSON.stringify(me.body));
    assert.strictEqual(me.body.role, 'user');
    assert.deepStrictEqual(me.body.engines, ['report']);
    state.hire = me.body.id;
});
test('a grant added later shows up on the next request, and own-key-only sticks', async () => {
    const r = await call('PATCH', `/api/admin/users/${state.hire}`, { token: 't-admin', body: { engines: ['report', 'leadgen'], byoKeyOnly: true } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    const me = await call('GET', '/api/me', { token: 't-new.hire@agency.test' });
    assert.deepStrictEqual([...me.body.engines].sort(), ['leadgen', 'report']);
    assert.strictEqual(tbl('app_users').find(u => u.id === state.hire).byo_key_only, true);
});
test('an engine that is not granted is refused at its route, not hidden in the page', async () => {
    // The new hire has report and leadgen, not fb_community.
    const r = await call('POST', '/api/fb/audit-community', { token: 't-new.hire@agency.test', body: { groupIds: ['1'], clientId: state.C } });
    assert.strictEqual(r.statusCode, 403, JSON.stringify(r.body));
    assert.ok(/Facebook communities/.test(r.body.error) && r.body.code === 'no_engine', r.body.error);
});
test('an employee cannot use the provisioning routes', async () => {
    const r = await call('POST', '/api/admin/users', { token: 't-emp', body: { email: 'x@x.test', password: 'a-strong-password', role: 'admin' } });
    assert.strictEqual(r.statusCode, 403, JSON.stringify(r.body));
});
test('the admin creates a client account directly — the manual-activation path', async () => {
    const r = await call('POST', '/api/admin/users', { token: 't-admin', body: { email: 'walkin@shop.test', password: 'a-strong-password', role: 'client', trialDays: 7 } });
    assert.ok(r.statusCode === 200 || r.statusCode === 201, JSON.stringify(r.body));
    const me = await call('GET', '/api/me', { token: 't-walkin@shop.test' });
    assert.strictEqual(me.statusCode, 200, JSON.stringify(me.body));
    assert.strictEqual(me.body.role, 'client');
    assert.strictEqual(me.body.state, 'trial');
    assert.ok(me.body.usage && me.body.usage.leads, 'a client account must see its allowance');
    state.walkin = me.body.id;
});

section('\nthe admin moves a limit, and it moves');
test('the settings read back with their fallbacks named', async () => {
    const r = await call('GET', '/api/admin/settings', { token: 't-admin' });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.trialDays, 7);
    assert.ok(r.body.metrics.some(m => m.key === 'leads'));
    assert.strictEqual(r.body.stored.trial_caps, false, 'nothing has been stored yet, so this must say fallback');
});
test('a changed trial cap is enforced on the very next request', async () => {
    const before = await call('GET', '/api/me', { token: 't-walkin@shop.test' });
    const was = before.body.usage.leads.cap;
    const r = await call('PATCH', '/api/admin/settings', { token: 't-admin', body: { trialCaps: { ig_report: 1, fb_group_audit: 1, leads: 3, usd: 2 } } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    const after = await call('GET', '/api/me', { token: 't-walkin@shop.test' });
    assert.strictEqual(after.body.usage.leads.cap, 3, `cap was ${was}, set to 3, next request saw ${after.body.usage.leads.cap}`);
    const again = await call('GET', '/api/admin/settings', { token: 't-admin' });
    assert.strictEqual(again.body.stored.trial_caps, true);
});
test('the admin sets the contact email and the ways to pay, and every slot can read them without signing in', async () => {
    const r = await call('PATCH', '/api/admin/settings', { token: 't-admin', body: {
        contactEmail: 'Hello@Agency.test',
        paymentOptions: [
            { label: 'bKash', details: '017 0000 0000 (personal), reference: your business name' },
            { label: 'Bank transfer', details: 'Harbor Bank, account 1234', url: 'https://pay.example.test/edgelead' },
            { label: '', details: '' }                                   // an empty row is dropped, not stored
        ]
    } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    const pub = await call('GET', '/api/public/contact');            // no token at all
    assert.strictEqual(pub.statusCode, 200, JSON.stringify(pub.body));
    assert.strictEqual(pub.body.email, 'hello@agency.test');
    assert.strictEqual(pub.body.paymentOptions.length, 2, 'the empty row should not be kept');
    assert.strictEqual(pub.body.paymentOptions[1].url, 'https://pay.example.test/edgelead');
    const admin = await call('GET', '/api/admin/settings', { token: 't-admin' });
    assert.strictEqual(admin.body.contactEmail, 'hello@agency.test');
});
test('a bad address or a non-http link is refused; clearing is allowed; an employee cannot set them', async () => {
    const bad = await call('PATCH', '/api/admin/settings', { token: 't-admin', body: { contactEmail: 'not an email' } });
    assert.strictEqual(bad.statusCode, 400);
    const badUrl = await call('PATCH', '/api/admin/settings', { token: 't-admin', body: { paymentOptions: [{ label: 'x', details: 'y', url: 'javascript:alert(1)' }] } });
    assert.strictEqual(badUrl.statusCode, 400, 'a javascript: link reached storage');
    const emp = await call('PATCH', '/api/admin/settings', { token: 't-emp', body: { contactEmail: 'me@x.test' } });
    assert.strictEqual(emp.statusCode, 403);
    const clear = await call('PATCH', '/api/admin/settings', { token: 't-admin', body: { contactEmail: '', paymentOptions: [] } });
    assert.strictEqual(clear.statusCode, 200);
    const pub = await call('GET', '/api/public/contact');
    assert.strictEqual(pub.body.email, '');
    assert.deepStrictEqual(pub.body.paymentOptions, []);
    // put them back for the money-moment section below
    await call('PATCH', '/api/admin/settings', { token: 't-admin', body: { contactEmail: 'hello@agency.test', paymentOptions: [{ label: 'bKash', details: '017 0000 0000' }] } });
});
test('a nonsense trial length is refused', async () => {
    for (const bad of [0, -3, 400, 'soon']) {
        const r = await call('PATCH', '/api/admin/settings', { token: 't-admin', body: { trialDays: bad } });
        assert.strictEqual(r.statusCode, 400, `trialDays=${bad} was accepted`);
    }
});
test('an employee cannot change limits', async () => {
    const r = await call('PATCH', '/api/admin/settings', { token: 't-emp', body: { trialDays: 30 } });
    assert.strictEqual(r.statusCode, 403);
});

section('\nan employee onboards a client from Business Suite');
test('a Page the login manages arrives unfiled', async () => {
    const conn = { id: crypto.randomUUID(), user_id: EMP.id, client_id: null, page_id: '55501', page_name: 'Rangpur Solar', ig_username: 'rangpursolar', status: 'active', created_at: new Date().toISOString() };
    tbl('meta_connections').push(conn);
    state.conn = conn.id;
    const r = await call('GET', '/api/meta/inbox', { token: 't-emp' });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    const p = r.body.pages.find(x => x.connectionId === conn.id);
    assert.ok(p && p.needsClient, 'the unfiled Page is not in the inbox');
    assert.strictEqual(r.body.unfiled, 1);
});
test('one step turns the Page into a client, with nothing retyped', async () => {
    const r = await call('POST', `/api/meta/connections/${state.conn}/onboard`, { token: 't-emp', body: { niche: 'home solar', location: 'Rangpur' } });
    assert.strictEqual(r.statusCode, 201, JSON.stringify(r.body));
    const c = r.body.client;
    assert.strictEqual(c.name, 'Rangpur Solar');
    assert.strictEqual(c.ig_handle, 'rangpursolar');
    assert.strictEqual(c.fb_page_id, '55501');
    assert.strictEqual(c.niche, 'home solar');
    state.solar = c.id;
    assert.strictEqual(tbl('meta_connections').find(x => x.id === state.conn).client_id, c.id, 'the connection was not filed under the new client');
    const inbox = await call('GET', '/api/meta/inbox', { token: 't-emp' });
    assert.strictEqual(inbox.body.unfiled, 0);
});
test('it cannot be onboarded twice', async () => {
    const r = await call('POST', `/api/meta/connections/${state.conn}/onboard`, { token: 't-emp', body: {} });
    assert.strictEqual(r.statusCode, 409);
});
test('a colleague cannot onboard a Page from my login', async () => {
    const other = { id: crypto.randomUUID(), user_id: EMP.id, client_id: null, page_id: '55502', page_name: 'Other', status: 'active', created_at: new Date().toISOString() };
    tbl('meta_connections').push(other);
    const r = await call('POST', `/api/meta/connections/${other.id}/onboard`, { token: 't-emp2', body: {} });
    assert.strictEqual(r.statusCode, 404);
});
test('the new client shows as Meta-connected on the list', async () => {
    const r = await call('GET', '/api/clients', { token: 't-emp' });
    const c = r.body.clients.find(x => x.id === state.solar);
    assert.ok(c && c.meta.connected && c.meta.names.includes('Rangpur Solar'));
});

section('\na run is repeated on a schedule, under its client');
test('the employee schedules their own run and it carries the client', async () => {
    const r = await call('POST', '/api/schedules', { token: 't-emp', body: { jobId: state.job, cadence: 'weekly', dayOfWeek: 1, hourUtc: 9, label: 'Weekly audit' } });
    assert.strictEqual(r.statusCode, 201, JSON.stringify(r.body));
    state.sched = r.body.schedule ? r.body.schedule.id : (r.body.id || (r.body.data && r.body.data.id));
    const row = tbl('schedules').find(s => s.id === state.sched);
    assert.ok(row, 'no schedule row');
    assert.strictEqual(row.client_id, state.C, 'the schedule does not carry the client the run was filed under');
});
test('it is listed for its owner and not for a stranger', async () => {
    const mine = await call('GET', '/api/schedules', { token: 't-emp' });
    assert.ok((mine.body.schedules || []).some(s => s.id === state.sched));
    const theirs = await call('GET', '/api/schedules', { token: 't-emp2' });
    assert.ok(!(theirs.body.schedules || []).some(s => s.id === state.sched), 'a stranger can see it');
});
test('a stranger cannot pause it; the owner can; the owner can delete it', async () => {
    const no = await call('PATCH', `/api/schedules/${state.sched}`, { token: 't-emp2', body: { paused: true } });
    assert.ok(no.statusCode === 403 || no.statusCode === 404, JSON.stringify(no.body));
    const yes = await call('PATCH', `/api/schedules/${state.sched}`, { token: 't-emp', body: { paused: true } });
    assert.strictEqual(yes.statusCode, 200, JSON.stringify(yes.body));
    assert.strictEqual(tbl('schedules').find(s => s.id === state.sched).paused, true);
    const del = await call('DELETE', `/api/schedules/${state.sched}`, { token: 't-emp' });
    assert.strictEqual(del.statusCode, 200);
    assert.ok(!tbl('schedules').some(s => s.id === state.sched));
});
test('a run cannot be scheduled by someone who did not start it', async () => {
    const r = await call('POST', '/api/schedules', { token: 't-emp2', body: { jobId: state.job, cadence: 'weekly' } });
    assert.strictEqual(r.statusCode, 404, JSON.stringify(r.body));
});

section('\nthe export never hands a spreadsheet a formula');
test('a scraped bio that starts with = leaves the system neutralised', async () => {
    tbl('leads').push({ id: crypto.randomUUID(), owner_user_id: EMP.id, platform: 'instagram', username: 'evilbio', bio: '=HYPERLINK("http://evil.test","click")', full_name: '+1 tricky', created_at: new Date().toISOString() });
    const r = await call('GET', '/api/leads/export.csv', { token: 't-emp' });
    assert.strictEqual(r.statusCode, 200);
    const csv = String(r.body);
    assert.ok(csv.includes("'=HYPERLINK"), 'the formula was not neutralised');
    assert.ok(csv.includes("'+1 tricky"), 'the + lead was not neutralised');
    for (const line of csv.split(/\r?\n/).slice(1)) {
        for (const cell of line.split(',')) assert.ok(!/^[=+\-@]/.test(cell.replace(/^"/, '')), 'a cell begins with a formula character: ' + cell);
    }
});

section('\nthe money moment: a trial ends and the client asks to continue');
test('a trial client can ask to continue; the admin sees it waiting, with the note', async () => {
    // walkin@shop.test is the trial client the admin created earlier.
    const r = await call('POST', '/api/me/request-activation', { token: 't-walkin@shop.test', body: { note: 'Loved the audit — how much for a year?' } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    const me = await call('GET', '/api/me', { token: 't-walkin@shop.test' });
    assert.ok(me.body.activation_requested_at, 'the client should see their request as sent');
    const adminMe = await call('GET', '/api/me', { token: 't-admin' });
    assert.ok(adminMe.body.pendingActivations >= 1, 'the admin should see something waiting');
    const list = await call('GET', '/api/admin/users', { token: 't-admin' });
    const u = list.body.users.find(x => x.id === state.walkin);
    assert.ok(u && u.activation_requested_at && /how much/.test(u.activation_note), 'the request did not reach the admin list');
});
test('a LAPSED client can still ask — the one door that stays open', async () => {
    const u = person('lapsed@shop.test'); TOKENS['t-lapsed'] = u;
    const past = new Date(Date.now() - 3 * 86400000).toISOString();
    tbl('app_users').push({ id: u.id, email: u.email, role: 'client', is_active: true, trial_started_at: past, trial_ends_at: past });
    const shut = await call('GET', '/api/me', { token: 't-lapsed' });
    assert.strictEqual(shut.statusCode, 402, 'this account should be lapsed');
    assert.strictEqual(shut.body.activation_requested_at, null);
    const ask = await call('POST', '/api/me/request-activation', { token: 't-lapsed', body: {} });
    assert.strictEqual(ask.statusCode, 200, JSON.stringify(ask.body));
    const again = await call('GET', '/api/me', { token: 't-lapsed' });
    assert.strictEqual(again.statusCode, 402);
    assert.ok(again.body.activation_requested_at, 'the expired screen should be able to say the request was sent');
    state.lapsed = u.id;
});
test('the admin activates them, and the very next request is in', async () => {
    const before = (await call('GET', '/api/me', { token: 't-admin' })).body.pendingActivations;
    const until = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const r = await call('PATCH', `/api/admin/users/${state.lapsed}`, { token: 't-admin', body: { paidUntil: until, planLabel: 'Starter — 1 month' } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    const me = await call('GET', '/api/me', { token: 't-lapsed' });
    assert.strictEqual(me.statusCode, 200, 'a just-activated client was still refused: ' + JSON.stringify(me.body));
    assert.strictEqual(me.body.state, 'paid');
    assert.strictEqual(me.body.activation_requested_at, null, 'activation should answer the request');
    const after = (await call('GET', '/api/me', { token: 't-admin' })).body.pendingActivations;
    assert.strictEqual(after, before - 1);
});
test('a suspended account cannot ask; an employee has nothing to ask for', async () => {
    const no = await call('POST', '/api/me/request-activation', { token: 't-susp', body: {} });
    assert.strictEqual(no.statusCode, 403, JSON.stringify(no.body));
    const emp = await call('POST', '/api/me/request-activation', { token: 't-emp', body: {} });
    assert.strictEqual(emp.statusCode, 400);
});

section('\nthe client surface names every kind of report');
test('a Facebook page report and a monthly report are titled, not "Report"', async () => {
    const fbAi = { state_of_the_page: 'Steady, with weekends dark.', executive_summary: 'The Page is steady; weekends are dark.', what_is_working: ['Photos of the counter'], what_is_failing: ['No posting on weekends'], quick_wins: ['Post Saturday mornings'], thirty_day_plan: ['Two weekend posts a week'] };
    state.fbRep = { id: crypto.randomUUID(), user_id: EMP.id, client_id: state.C, platform: 'facebook', report_type: 'fb_page', target_handle: 'harborcafe', ai_json: fbAi, ai_summary: fbAi.executive_summary, report_json: { target: { name: 'Harbor Cafe' }, ai: fbAi, benchmark: {} }, created_at: new Date().toISOString() };
    tbl('reports').push(state.fbRep);
    const moAi = { headline: 'August was the strongest month for reach.', executive_summary: 'Reach rose 47%.', what_moved: ['Reach up 47%'], what_worked: ['Reels'], what_did_not: ['Carousels'], next_month: ['Post eight Reels'], caveats: '' };
    state.moRep = { id: crypto.randomUUID(), user_id: EMP.id, client_id: state.C, platform: 'meta', report_type: 'meta_monthly', target_handle: 'harborcafe', snapshot_date: '2026-08-01', ai_json: moAi, ai_summary: moAi.executive_summary, report_json: { month: '2026-08', monthLabel: 'August 2026', comparable: true, prevMonthLabel: 'July 2026', deltas: [{ label: 'Accounts reached', now: 41820, before: 28410, pct: 47.2, kind: 'up' }], posting: { count: 14 }, ai: moAi }, created_at: new Date().toISOString() };
    tbl('reports').push(state.moRep);
    for (const id of [state.fbRep.id, state.moRep.id]) await call('PATCH', `/api/reports/${id}/visibility`, { token: 't-admin', body: { visible: true } });
    const r = await call('GET', '/api/client/reports', { token: 't-client' });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    const fb = r.body.reports.find(x => x.id === state.fbRep.id);
    const mo = r.body.reports.find(x => x.id === state.moRep.id);
    assert.ok(fb && mo, 'both reports should list for the client');
    assert.strictEqual(fb.title, 'Facebook page check-up');
    assert.strictEqual(mo.title, 'Monthly report');
    assert.ok(!r.body.reports.some(x => x.title === 'Report'), 'a report the client cannot name: ' + JSON.stringify(r.body.reports.filter(x => x.title === 'Report').map(x => x.id)));
});

test('a Facebook page report opens in owner language: a headline, what is working, what to change', async () => {
    const r = await ownerOpen(state.fbRep.id);
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    const v = r.body.report;
    assert.strictEqual(v.headline, 'Steady, with weekends dark.');
    assert.ok(v.working.some(p => p.title === 'Photos of the counter'), JSON.stringify(v.working));
    assert.ok(v.fix.some(p => p.title === 'No posting on weekends') && v.fix.some(p => p.title === 'Post Saturday mornings'), JSON.stringify(v.fix));
    assert.strictEqual(v.standing, null, 'a Page report must not invent a peer ranking');
    assert.strictEqual(v.summary, 'The Page is steady; weekends are dark.');
    for (const pt of [...v.working, ...v.fix]) assert.ok(pt.title && typeof pt.why === 'string', 'the page draws {title, why}: ' + JSON.stringify(pt));
});
test('a monthly report opens with its headline, its movements, and next month', async () => {
    const r = await ownerOpen(state.moRep.id);
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    const v = r.body.report;
    assert.strictEqual(v.headline, 'August was the strongest month for reach.');
    assert.strictEqual(v.band, null, 'an owner report has no scraped score to band');
    assert.ok(v.working.some(p => p.title === 'Reels'));
    assert.ok(v.fix.some(p => p.title === 'Post eight Reels' && p.why === 'Next month'), JSON.stringify(v.fix));
    assert.strictEqual(v.movements.length, 1);
    assert.strictEqual(v.movements[0].label, 'Accounts reached');
    assert.strictEqual(v.movements[0].kind, 'up');
});
test('an Instagram report still comes out the Instagram way — bands, pillars, standing', async () => {
    const rep = tbl('reports').find(x => x.client_id === state.C && x.report_type === 'ig_report');
    const r = await ownerOpen(rep.id);
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.report.band, 'healthy', 'score 71 is the healthy band');
    assert.ok(Array.isArray(r.body.report.working) && Array.isArray(r.body.report.fix));
});

section('\nthe monthly owner report, against a scripted Graph API');
/** Wait for a job the route started in the background to finish. */
async function untilDone(jobId, ms = 8000) {
    const t0 = Date.now();
    for (;;) {
        const j = tbl('jobs').find(x => x.id === jobId);
        if (j && ['done', 'failed', 'paused', 'cancelled'].includes(j.status)) return j;
        if (Date.now() - t0 > ms) return j || { status: 'missing' };
        await new Promise(r => setTimeout(r, 40));
    }
}
test('the run is queued under the client and finishes', async () => {
    tbl('user_engine_access').push({ user_id: EMP.id, engine: 'meta_owned' });
    const old = tbl('jobs').find(j => j.id === state.job); if (old) old.status = 'done';   // free the slot
    state.moConn = { id: crypto.randomUUID(), user_id: EMP.id, client_id: state.C, page_id: GRAPH.PAGE, page_name: 'Harbor Cafe', ig_user_id: GRAPH.IG, ig_username: 'harborcafe', page_token_enc: 'plain-page-token', status: 'active', created_at: new Date().toISOString() };
    tbl('meta_connections').push(state.moConn);
    GEMINI.script = [{ parts: [{ text: JSON.stringify({
        headline: 'August was the strongest month for reach.', executive_summary: 'Reach rose 47% to 41,820.',
        what_moved: ['Reach up 47%'], what_worked: ['Reels'], what_did_not: ['Nothing stood out'],
        audience: 'Mostly 25-34, in Boston.', next_month: ['Post eight Reels'], caveats: ''
    }) }] }];
    const r = await call('POST', '/api/meta/monthly', { token: 't-emp', body: { connectionId: state.moConn.id, month: '2026-08', clientId: state.C } });
    assert.strictEqual(r.statusCode, 202, JSON.stringify(r.body));
    const job = await untilDone(r.body.jobId);
    assert.strictEqual(job.status, 'done', `the job ended ${job.status}: ${job.error || ''}`);
    assert.strictEqual(job.client_id, state.C, 'the monthly run was not filed under the client');
    state.moReport = job.result_report_id;
    assert.ok(state.moReport, 'no report id on the finished job');
});
test('the report carries this month against last, with the arithmetic a client could check', async () => {
    const rep = tbl('reports').find(x => x.id === state.moReport);
    assert.ok(rep, 'no report row');
    assert.strictEqual(rep.report_type, 'meta_monthly');
    assert.strictEqual(rep.client_id, state.C);
    assert.strictEqual(rep.snapshot_date, '2026-08-01', 'sorted by the month reported, not the day it ran');
    const d = Object.fromEntries(rep.report_json.deltas.map(x => [x.key, x]));
    assert.strictEqual(d.reach.now, 41820); assert.strictEqual(d.reach.before, 28410);
    assert.strictEqual(d.reach.pct, 47.2); assert.strictEqual(d.reach.kind, 'up');
    assert.strictEqual(d.follower_count.kind, 'new', 'zero last month must read as new');
    assert.strictEqual(d.follower_count.pct, null, 'never a percentage against zero');
    assert.strictEqual(d.accounts_engaged.kind, 'flat', '3160 to 3180 is not a movement');
    assert.strictEqual(d.total_interactions.kind, 'down');
    assert.strictEqual(d.page_impressions_unique.now, 8120);
    assert.strictEqual(rep.report_json.posting.count, 1, 'only the August post belongs to August');
    assert.strictEqual(rep.report_json.posting.topByReach[0].reach, 11240);
    assert.deepStrictEqual(rep.report_json.demographics.age.map(x => x.key), ['25-34', '35-44']);
    assert.strictEqual(rep.ai_json.headline, 'August was the strongest month for reach.');
    assert.strictEqual(rep.report_json.sources.all, 'meta_owner_insights', 'nothing scraped may be in here');
});
test('a month still running is refused; a stranger cannot use the connection', async () => {
    const cur = new Date().toISOString().slice(0, 7);
    const r = await call('POST', '/api/meta/monthly', { token: 't-emp', body: { connectionId: state.moConn.id, month: cur, clientId: state.C } });
    assert.strictEqual(r.statusCode, 400, JSON.stringify(r.body));
    const s = await call('POST', '/api/meta/monthly', { token: 't-emp2', body: { connectionId: state.moConn.id, month: '2026-08', clientId: state.C } });
    assert.ok(s.statusCode === 403 || s.statusCode === 404, 'a stranger reached another employee\'s connection: ' + s.statusCode);
});
test('the analyst reads the month back with the same numbers', async () => {
    GEMINI.script = [
        { parts: [{ functionCall: { name: 'get_monthly_report', args: { month: '2026-08' } } }] },
        { parts: [{ text: 'In August reach rose 47% to 41,820 accounts.' }] }
    ];
    GEMINI.requests.length = 0;
    const r = await call('POST', '/api/assistant/ask', { token: 't-emp', body: { message: 'How did August go?', clientId: state.C } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.used, ['get_monthly_report']);
    const fr = GEMINI.requests[1].contents.flatMap(c => c.parts || []).find(p => p.functionResponse).functionResponse.response.result;
    assert.strictEqual(fr.available, true);
    const reach = fr.movements.find(m => m.metric === 'Accounts reached');
    assert.strictEqual(reach.changePct, 47.2, 'the assistant must see the same arithmetic the report holds');
});

section('\nphase 34 — the monthly report, as the agency sends it');
test('the owner opens the month as a document: three headline cards, said in words and numbers', async () => {
    const r = await ownerOpen(state.moReport);
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    const m = r.body.report.month;
    assert.ok(m, 'a monthly report must carry its document');
    assert.strictEqual(m.cover.monthLabel, 'August 2026');
    assert.strictEqual(m.cover.prevMonthLabel, 'July 2026');
    assert.strictEqual(m.cover.covers, 'August 1–31, 2026');
    const card = a => m.brief.find(b => b.area === a) || {};
    assert.strictEqual(card('Visibility').big, 'Reach up 47%');
    assert.strictEqual(card('Visibility').line, '41,820 accounts reached in August, up from 28,410 in July.');
    assert.strictEqual(card('Audience').big, '+412 followers');
    assert.strictEqual(card('Audience').line, '412 new Instagram followers in August, against none in July. 9,240 followers in total.',
        'a count that grew from zero must never be given a percentage');
    assert.strictEqual(card('Action').big, 'Website taps down 14%');
    assert.strictEqual(card('Action').tone, 'watch');
    assert.strictEqual(r.body.report.movements.length, m.scorecard.length, 'the old movements list and the scorecard are the same rows');
});
test('the scorecard gives the exact change and a status nobody has to argue about', async () => {
    const r = await ownerOpen(state.moReport);
    const row = k => r.body.report.month.scorecard.find(x => x.key === k) || {};
    assert.strictEqual(row('reach').change, '+13,410 (+47%)');
    assert.deepStrictEqual(row('reach').status, { word: 'Growing', tone: 'jade' });
    assert.strictEqual(row('follower_count').change, 'new this month');
    assert.strictEqual(row('follower_count').status.word, 'New');
    assert.strictEqual(row('accounts_engaged').change, '+20 (+0.6%)', 'under 10% keeps its decimal');
    assert.strictEqual(row('accounts_engaged').status.word, 'Steady');
    assert.strictEqual(row('total_interactions').change, '−520 (−8.1%)');
    assert.strictEqual(row('total_interactions').status.word, 'Steady', 'a fall under 10% is not an alarm');
    assert.strictEqual(row('page_post_engagements').status.word, 'Watch');
    assert.strictEqual(row('page_post_engagements').platform, 'Facebook');
});
test('posts, audience and next steps come out readable, and the audience is never overstated', async () => {
    const r = await ownerOpen(state.moReport);
    const m = r.body.report.month;
    assert.strictEqual(m.posts[0].kind, 'Reel');
    assert.strictEqual(m.posts[0].reach, 11240);
    assert.strictEqual(m.posts[0].link, 'https://instagram.com/p/abc');
    const g = k => m.audience.groups.find(x => x.key === k);
    assert.deepStrictEqual(g('age').rows.map(x => [x.label, x.share]), [['25–34', 60], ['35–44', 40]]);
    assert.deepStrictEqual(g('gender').rows.map(x => x.label), ['Women', 'Men']);
    // Boston is 4,100 of the 9,000 followers Meta could classify, not 100%
    // of the one city it listed.
    assert.strictEqual(g('city').rows[0].share, 45.6);
    assert.strictEqual(g('country').rows[0].label, 'United States');
    assert.strictEqual(m.audience.line, 'The largest group of your followers is aged 25–34 (60%), and more of them live in Boston (45.6%) than anywhere else.');
    assert.deepStrictEqual(m.recommendations.map(x => [x.key, x.action, x.priority]), [['next-0', 'Post eight Reels', null]],
        'an older report keeps its lines, with no priority nobody set');
    assert.ok(/own Meta Insights/.test(m.about.source));
});
test('what the agency did that month: only what the client may see, only that month', async () => {
    const C = state.C;
    tbl('client_tasks').push(
        { id: crypto.randomUUID(), client_id: C, title: 'Filmed the seasonal menu Reel', status: 'done', visible_to_client: true, completed_at: '2026-08-12T10:00:00.000Z', created_at: '2026-08-01T10:00:00.000Z' },
        { id: crypto.randomUUID(), client_id: C, title: 'Chased the unpaid invoice', status: 'done', visible_to_client: false, completed_at: '2026-08-13T10:00:00.000Z', created_at: '2026-08-01T10:00:00.000Z' },
        { id: crypto.randomUUID(), client_id: C, title: 'Planned October', status: 'done', visible_to_client: true, completed_at: '2026-09-03T10:00:00.000Z', created_at: '2026-09-01T10:00:00.000Z' }
    );
    tbl('reports').push({ id: crypto.randomUUID(), user_id: EMP.id, client_id: C, report_type: 'fb_page', platform: 'facebook', target_handle: 'harborcafe', created_at: '2026-08-14T09:00:00.000Z' });
    const lead = () => { const id = crypto.randomUUID(); tbl('leads').push({ id, owner_user_id: EMP.id, username: 'lead' + id.slice(0, 6), platform: 'instagram', created_at: '2026-07-01T00:00:00.000Z' }); return id; };
    tbl('client_leads').push(
        { client_id: C, lead_id: lead(), source: 'ig_campaign', created_at: '2026-08-05T00:00:00.000Z' },
        { client_id: C, lead_id: lead(), source: 'ig_campaign', created_at: '2026-08-21T00:00:00.000Z' },
        { client_id: C, lead_id: lead(), source: 'ig_campaign', created_at: '2026-07-11T00:00:00.000Z' }
    );
    const r = await ownerOpen(state.moReport);
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    const ctx = r.body.report.month.context;
    assert.deepStrictEqual(ctx.work.done.map(t => t.title), ['Filmed the seasonal menu Reel'],
        'an internal task, or one from another month, reached the client\'s report');
    assert.ok(ctx.work.filed.some(f => f.title === 'Facebook page check-up · harborcafe' && f.date === '2026-08-14'), JSON.stringify(ctx.work.filed));
    assert.ok(!ctx.work.filed.some(f => /Monthly report/.test(f.title)), 'the report must not list itself as work done');
    const before = tbl('client_leads').filter(x => x.client_id === C && x.created_at < '2026-09-01').length;
    assert.strictEqual(ctx.leads.thisMonth, 2);
    assert.strictEqual(ctx.leads.toDate, before);
});
test('standing comes from the comparison that existed when the report was built, labelled as such', async () => {
    const C = state.C;
    const bench = (ranked, avg) => ({ benchmark: { ranked, cohort: { avgEngagementRate: avg } } });
    tbl('reports').push(
        { id: crypto.randomUUID(), user_id: EMP.id, client_id: C, report_type: 'deep_audit', platform: 'instagram', target_handle: 'harborcafe', engagement_rate: 3.1, created_at: '2026-08-20T10:00:00.000Z',
          report_json: bench([{ rank: 1, handle: 'ginzahibachi' }, { rank: 2, handle: 'harborcafe', isTarget: true }, { rank: 3, handle: 'fujiyama' }], 2.2) },
        // Built after the monthly report: a report must not change after it is sent.
        { id: crypto.randomUUID(), user_id: EMP.id, client_id: C, report_type: 'deep_audit', platform: 'instagram', target_handle: 'harborcafe', engagement_rate: 4, created_at: '2099-01-01T00:00:00.000Z',
          report_json: bench([{ rank: 1, handle: 'harborcafe', isTarget: true }, { rank: 2, handle: 'ginzahibachi' }], 2) }
    );
    const r = await ownerOpen(state.moReport);
    const s = r.body.report.month.context.standing;
    assert.ok(s, 'no standing in the report');
    assert.strictEqual(s.verdict, 'You come 2nd out of 3 businesses like yours.');
    assert.strictEqual(s.date, '2026-08-20');
    assert.strictEqual(s.title, 'Instagram deep dive');
    assert.deepStrictEqual(s.peers.map(p => p.name), ['@ginzahibachi', 'You', '@fujiyama']);
});
test('a share link carries the same document', async () => {
    const mk = await call('POST', '/api/share', { token: 't-emp', body: { reportId: state.moReport, label: 'August' } });
    assert.strictEqual(mk.statusCode, 201, JSON.stringify(mk.body));
    const r = await call('GET', `/api/public/share/${mk.body.share.token}`);
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    const m = r.body.report.month;
    assert.strictEqual(m.brief[0].big, 'Reach up 47%');
    assert.strictEqual(m.context.standing.verdict, 'You come 2nd out of 3 businesses like yours.');
    assert.deepStrictEqual(m.context.work.done.map(t => t.title), ['Filmed the seasonal menu Reel']);
    assert.ok(!JSON.stringify(r.body).includes('Chased the unpaid invoice'), 'an internal task reached a public link');
});
test('staff see which recommendations are already on the board', async () => {
    const one = await call('GET', `/api/meta/report/${state.moReport}`, { token: 't-emp' });
    assert.strictEqual(one.statusCode, 200, JSON.stringify(one.body));
    assert.ok(one.body.view && one.body.view.tasks, 'the staff page gets the document and the board');
    assert.strictEqual(one.body.view.tasks.canEdit, true);
    assert.deepStrictEqual(one.body.view.tasks.byKey, {});
    const add = await call('POST', `/api/clients/${state.C}/tasks`, { token: 't-emp', body: {
        title: 'Post eight Reels', source: { type: 'recommendation', id: state.moReport, key: 'next-0', label: 'Monthly report · August 2026' } } });
    assert.strictEqual(add.statusCode, 201, JSON.stringify(add.body));
    const two = await call('GET', `/api/meta/report/${state.moReport}`, { token: 't-emp' });
    assert.deepStrictEqual(two.body.view.tasks.byKey['next-0'], { id: add.body.task.id, status: 'todo' });
    const stranger = await call('GET', `/api/meta/report/${state.moReport}`, { token: 't-emp2' });
    assert.ok([403, 404].includes(stranger.statusCode), 'a stranger opened the report: ' + stranger.statusCode);
});
test('an owner is told whether their runs spend their own key, so the portal can hide the team\'s key controls', async () => {
    const me = await call('GET', '/api/me', { token: 't-client' });
    assert.strictEqual(me.statusCode, 200, JSON.stringify(me.body));
    assert.strictEqual(me.body.ownKey, false);
    const staff = await call('GET', '/api/me', { token: 't-emp' });
    assert.strictEqual(staff.body.ownKey, undefined, 'staff always see their key controls; the flag is the owner\'s');
});
test('what the model writes is kept to shape before it is saved', () => {
    const ai = S.cleanMonthlyAi({ recommendations: [
        { action: '  Fix the link in bio  ', why: 'Taps fell 14%', expected: 'An estimated 20 more taps', who: 'client', priority: 'urgent' },
        'Post two Reels a week',
        { why: 'no action given' }
    ] });
    assert.deepStrictEqual(ai.recommendations, [
        { action: 'Fix the link in bio', why: 'Taps fell 14%', expected: 'An estimated 20 more taps', who: 'client', priority: null },
        { action: 'Post two Reels a week', why: null, expected: null, who: null, priority: null }
    ]);
    assert.deepStrictEqual(ai.next_month, ['Fix the link in bio', 'Post two Reels a week'], 'older readers still get their list');
    assert.deepStrictEqual(S.monthRecs(ai).map(x => x.key), ['rec-0', 'rec-1']);
    assert.strictEqual(S.monthChange({ now: 5, before: 0, kind: 'new' }), 'new this month');
    assert.strictEqual(S.monthChange({ now: 90, before: 100, pct: -10, kind: 'down' }), '−10 (−10%)');
    assert.strictEqual(S.monthStatus({ now: 6, before: 3, pct: 100, kind: 'up' }).word, 'Small numbers', 'a doubling of three is not growth');
    assert.strictEqual(S.monthStatus({ now: 60, before: 30, pct: 100, kind: 'up' }).word, 'Growing');
    assert.strictEqual(S.monthlyView({ report_type: 'ig_report' }), null);
});

section('\nphase 35 — Ask AI, a light helper about one client');
test('a question about one client starts from a one-line card, and gets the three new lookups', async () => {
    const staff = await S.assistantScope(EMP.id, state.C, 'user');
    assert.ok(staff.clientId === state.C, 'the staff scope did not narrow to the client');
    assert.ok(/Meta (not )?connected/.test(staff.card) && /\d+ reports?/.test(staff.card) && /\d+ open tasks?/.test(staff.card) && /\d+ leads? found/.test(staff.card), 'card: ' + staff.card);
    assert.ok(S.assistantSystemPrompt(staff).includes('Client card: ' + staff.card));
    const prompt = S.assistantSystemPrompt(staff);
    assert.ok(/what we did for them/.test(prompt) && /what is planned/.test(prompt), 'the staff prompt must aim at what we did, what is planned and the numbers');
    const names = S.assistantDeclarations(staff).map(d => d.name);
    for (const n of ['get_tasks', 'get_leads_summary', 'get_work_log']) assert.ok(names.includes(n), n + ' missing for staff');
    const owner = await S.assistantScope(CLIENT.id, state.C, 'client');
    const ownNames = S.assistantDeclarations(owner).map(d => d.name);
    assert.ok(ownNames.includes('get_tasks') && ownNames.includes('get_leads_summary'));
    assert.ok(!ownNames.includes('get_work_log'), 'the owner was offered the team\'s work log');
    const loose = await S.assistantScope(EMP.id, null, 'user');
    assert.ok(!S.assistantDeclarations(loose).some(d => ['get_tasks', 'get_leads_summary', 'get_work_log'].includes(d.name)), 'client lookups offered with no client chosen');
});
test('tasks come back as counts and a short list, overdue first; the owner sees only what is shown to them', async () => {
    tbl('client_tasks').push(
        { id: crypto.randomUUID(), client_id: state.C, title: 'Chase the unpaid invoice (internal)', notes: 'SECRET-NOTE', status: 'todo', due_date: '2020-01-02', visible_to_client: false, assigned_to_client: false, assignee_user_id: null, created_at: new Date().toISOString() },
        { id: crypto.randomUUID(), client_id: state.C, title: 'Send the menu photos', status: 'waiting', due_date: null, visible_to_client: true, assigned_to_client: true, created_at: new Date().toISOString() }
    );
    const staff = await S.assistantScope(EMP.id, state.C, 'user');
    const t = await S.ASSISTANT_TOOLS.get_tasks.run(staff, {});
    assert.strictEqual(t.openShown[0].title, 'Chase the unpaid invoice (internal)', 'overdue should come first');
    assert.strictEqual(t.openShown[0].overdue, true);
    assert.ok(t.openShown.length <= 10);
    assert.ok(t.openShown.some(x => x.title === 'Send the menu photos' && x.for === 'the client'));
    assert.ok(!JSON.stringify(t).includes('SECRET-NOTE'), 'task notes reached the model');
    const owner = await S.assistantScope(CLIENT.id, state.C, 'client');
    const o = await S.ASSISTANT_TOOLS.get_tasks.run(owner, {});
    assert.ok(!JSON.stringify(o).includes('unpaid invoice'), 'an internal task reached the owner\'s assistant');
    assert.ok(o.openShown.some(x => x.title === 'Send the menu photos'));
});
test('leads come back as totals and names, never contact details', async () => {
    const id1 = crypto.randomUUID(), id2 = crypto.randomUUID();
    tbl('leads').push(
        { id: id1, owner_user_id: EMP.id, username: 'bostonbrides', full_name: 'Boston Brides', platform: 'instagram', email: 'hello@bostonbrides.test', created_at: new Date().toISOString() },
        { id: id2, owner_user_id: EMP.id, username: 'backbaygym', full_name: 'Back Bay Gym', platform: 'facebook', phone: '617-555-0101', created_at: new Date().toISOString() }
    );
    tbl('client_leads').push({ client_id: state.C, lead_id: id1, source: 'ig_campaign', created_at: new Date().toISOString() }, { client_id: state.C, lead_id: id2, source: 'fb_discovery', created_at: new Date().toISOString() });
    const staff = await S.assistantScope(EMP.id, state.C, 'user');
    const l = await S.ASSISTANT_TOOLS.get_leads_summary.run(staff, {});
    assert.ok(l.total >= 2 && l.withEmail >= 1 && l.withPhone >= 1 && l.foundThisMonth >= 2, JSON.stringify(l));
    assert.ok(l.byPlatform.facebook >= 1 && l.bySource.fb_discovery >= 1);
    assert.ok(l.newest.length <= 5 && l.newest.some(x => x.name === 'Back Bay Gym'));
    const raw = JSON.stringify(l);
    assert.ok(!raw.includes('hello@bostonbrides.test') && !raw.includes('617-555-0101'), 'contact details reached the model');
});
test('the work log is the team\'s: delivered reports, runs and schedules; the owner cannot call it', async () => {
    const staff = await S.assistantScope(EMP.id, state.C, 'user');
    const w = await S.ASSISTANT_TOOLS.get_work_log.run(staff, {});
    for (const k of ['delivered', 'runningNow', 'stuck', 'scheduled']) assert.ok(Array.isArray(w[k]), k + ' missing');
    const owner = await S.assistantScope(CLIENT.id, state.C, 'client');
    assert.deepStrictEqual(await S.ASSISTANT_TOOLS.get_work_log.run(owner, {}), { error: 'not available' });
});
test('staff get the gist of a report, not all of it', async () => {
    const staff = await S.assistantScope(EMP.id, state.C, 'user');
    const r = await S.ASSISTANT_TOOLS.get_report_detail.run(staff, { report_id: state.fbRep.id });
    assert.strictEqual(r.headline, 'Steady, with weekends dark.');
    assert.ok(r.working.every(x => typeof x === 'string') && r.working.length <= 3 && r.fix.length <= 3, JSON.stringify(r));
    assert.ok(!('month' in r) && !('band' in r));
    const owner = await S.assistantScope(CLIENT.id, state.C, 'client');
    const o = await S.ASSISTANT_TOOLS.get_report_detail.run(owner, { report_id: state.fbRep.id });
    assert.ok(Array.isArray(o.working) && typeof o.working[0] === 'object', 'the owner keeps the full worded view');
});
test('a staff question stops after three rounds, and the last round must answer with what it has', async () => {
    GEMINI.script = [
        { parts: [{ functionCall: { name: 'get_tasks', args: {} } }] },
        { parts: [{ functionCall: { name: 'get_leads_summary', args: {} } }] },
        { parts: [{ text: 'One task is overdue and 2 leads have a way to reach them.' }] }
    ];
    GEMINI.requests.length = 0;
    const out = await S.assistantAnswer({ userId: EMP.id, message: 'Prep me for a call', clientId: state.C, role: 'user' });
    assert.strictEqual(GEMINI.requests.length, 3, 'expected exactly three model turns');
    assert.strictEqual(GEMINI.requests[0].toolConfig, undefined);
    assert.strictEqual(GEMINI.requests[2].toolConfig.functionCallingConfig.mode, 'NONE', 'the last round could still call a tool');
    assert.strictEqual(out.answer, 'One task is overdue and 2 leads have a way to reach them.');
    assert.deepStrictEqual(out.used, ['get_tasks', 'get_leads_summary']);
    state.askConv = out.conversationId;
});
test('a long thread keeps its latest turns, not its first ones', async () => {
    const base = Date.now() - 3600000;
    for (let i = 0; i < 12; i++) {
        tbl('ai_messages').push({ id: crypto.randomUUID(), conversation_id: state.askConv, role: i % 2 ? 'assistant' : 'user', content: `turn-${i}`, created_at: new Date(base + (i + 10) * 1000).toISOString() });
    }
    GEMINI.script = [{ parts: [{ text: 'Noted.' }] }];
    GEMINI.requests.length = 0;
    await S.assistantAnswer({ userId: EMP.id, message: 'And now?', conversationId: state.askConv, clientId: state.C, role: 'user' });
    const texts = GEMINI.requests[0].contents.flatMap(c => c.parts || []).map(p => p.text).filter(Boolean);
    assert.ok(texts.includes('turn-11'), 'the latest turn was dropped');
    assert.ok(!texts.includes('turn-0'), 'the oldest turn was kept over newer ones');
    assert.ok(texts.length <= 9, 'staff history is eight turns plus the question: ' + texts.length);
});
test('the ask route offers the client lookups to staff with a client chosen', async () => {
    GEMINI.script = [{ parts: [{ text: 'Nothing is waiting on the client.' }] }];
    GEMINI.requests.length = 0;
    const r = await call('POST', '/api/assistant/ask', { token: 't-emp', body: { message: 'What is waiting on the client?', clientId: state.C } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    const names = GEMINI.requests[0].tools[0].functionDeclarations.map(d => d.name);
    assert.ok(names.includes('get_tasks') && names.includes('get_work_log'));
});


section('\nphase 36 — post photos kept, and the report as a document');
const IGC = (sc, extra = {}) => ({ url: `https://www.instagram.com/p/${sc}/`, shortcode: sc, likes: 400, comments: 30, views: 9000, type: 'Reel', index: 1.8, postedAt: '2026-09-02T19:00:00Z', caption: 'Onion volcano at table 6. Wait for the cheer.', thumbnail: `https://scontent.cdninstagram.com/v/${sc}.jpg?oe=expires`, ...extra });
function igMain(handle, extra = {}) {
    const top = [IGC(handle + '1'), IGC(handle + '2', { type: 'Image', index: 1.3 }), IGC(handle + '3')];
    return {
        handle, fullName: handle === 'sakurahibachi.ma' ? 'Sakura Hibachi Grill' : null, followers: 4812, postsAnalyzed: 30,
        engagementRate: '3.10', engagementRateMedian: '2.60', viralityScore: '1.10', postsPerWeek: '3.0', score: 74, grade: 'B+', avgLikes: 180, avgComments: 12,
        cadence: { postsPerWeek: 3.0, postsPerMonth: 13, medianGapDays: 2.4, longestGapDays: 9, lastPostDaysAgo: 2, silent: false },
        contentMix: { Reel: { count: 12, share: '40.0%', avgLikes: 212, avgComments: 14, avgViews: 5420, avgIndex: 1.6 }, Image: { count: 14, share: '46.7%', avgLikes: 88, avgComments: 4, avgViews: 0, avgIndex: 0.6 } },
        scoreBreakdown: { breakdown: [{ pillar: 'Engagement per follower', points: 21, max: 26, detail: '2.60% per post' }, { pillar: 'Conversation', points: 4, max: 16, detail: '6.0 comments per 100 likes' }] },
        flags: [{ with: { label: 'Asks a question' }, lift: 50, reliable: true }, { with: { label: 'Uses emoji' }, lift: 5, reliable: false }],
        topPosts: top, bottomPosts: [IGC(handle + '9', { type: 'Image', index: 0.3, likes: 41, views: null })], exemplars: { bestOverall: top[0] },
        heatmap: { cells: [{ dow: 6, hour: 19, posts: 3, medIndex: 1.7 }, { dow: 1, hour: 10, posts: 2, medIndex: 0.4 }], bestHours: [{ hour: 19, medIndex: 1.7 }], bestDays: [{ dowName: 'Sat', medIndex: 1.5 }], reliable: true },
        momentum: { months: [{ month: '2026-07', posts: 12, medEngagement: 118 }, { month: '2026-08', posts: 13, medEngagement: 131 }], changePct: 14 },
        topHashtags: [{ tag: '#hibachi', uses: 18, avgIndex: 1.3 }], completeness: { checks: [{ label: 'Link in bio', ok: false }, { label: 'Category', ok: true }] },
        ...extra
    };
}
test('a post photo is copied only from Instagram’s own image hosts', async () => {
    FETCHED.length = 0;
    assert.strictEqual(await S.storeMediaImage('http://169.254.169.254/latest/meta-data', 'x'), null, 'fetched a non-Instagram address');
    assert.strictEqual(await S.storeMediaImage('https://evil.example/cdninstagram.com/a.jpg', 'x'), null);
    assert.strictEqual(FETCHED.length, 0, 'nothing should have been fetched: ' + FETCHED.join(', '));
    const url = await S.storeMediaImage('https://scontent-bos5-1.cdninstagram.com/v/abc.jpg?oe=1', 'ig/test/abc');
    assert.ok(url && url.startsWith('https://stub.supabase.co/storage/v1/object/public/report-media/ig/test/abc.jpg'), url);
    assert.ok(STORAGE.buckets.has('report-media'), 'the bucket was not made');
});
test('an audit keeps one copy of each photo it shows, and the card points at it', async () => {
    FETCHED.length = 0;
    const main = igMain('sakurahibachi.ma'), rival = igMain('ginzahibachi.ma');
    const kept = await S.keepAuditImages([main, { ...rival, topPosts: rival.topPosts.slice(0, 2), bottomPosts: [], exemplars: {} }], 'ig/job1');
    assert.strictEqual(kept, 6, 'four of the client’s photos and two of the rival’s');
    assert.strictEqual(FETCHED.length, 6, 'the same photo was fetched twice');
    assert.ok(main.topPosts[0].image.includes('/report-media/ig/job1/sakurahibachi.ma-sakurahibachima1.jpg'), main.topPosts[0].image);
    assert.strictEqual(main.exemplars.bestOverall.image, main.topPosts[0].image, 'the exemplar is the same post and should share the copy');
    assert.ok(main.topPosts[0].thumbnail.includes('cdninstagram'), 'the original address stays');
    assert.ok(rival.topPosts[0].image && !rival.topPosts[2].image);
});
test('the Instagram audit becomes a document: glance, score, formats, posts with photos, timing, plan', async () => {
    const main = igMain('sakurahibachi.ma');
    main.topPosts[0].image = 'https://stub.supabase.co/storage/v1/object/public/report-media/x.jpg';
    const row = { id: crypto.randomUUID(), report_type: 'ig_report', created_at: '2026-09-28T10:00:00Z',
        report_json: { main, rivals: [], generatedAt: '2026-09-28T10:00:00Z' },
        ai_json: { executive_summary: 'Reels beat every rival. Menu photos pull the average down.', strengths: ['Reels at the grill: 1.6× typical'], weaknesses: ['No booking link'], action_plan_30_days: [{ week: 'Week 1', actions: ['Add the booking link'] }], kpi_targets: { engagement_rate: '3.5%', posts_per_week: '4', reels_share: '60%' } } };
    const d = S.reportDoc(row);
    assert.strictEqual(d.cover.title, 'Sakura Hibachi Grill');
    assert.deepStrictEqual(d.cover.receipt[0], ['B+', 'grade']);
    const titles = d.sections.map(x => x.title);
    for (const t of ['At a glance', 'How the score is built', 'What you post, and what works', 'Best and weakest posts', 'When your audience responds', 'Consistency and momentum', 'Hashtags and your profile', 'What is working, what to fix', '30-day plan and targets']) assert.ok(titles.includes(t), 'missing section ' + t + ': ' + titles.join(' | '));
    const glance = d.sections[0];
    assert.strictEqual(glance.blocks.find(b => b.type === 'verdict').text, 'Reels beat every rival.');
    assert.strictEqual(glance.blocks[0].items[0].value, '2.60%', 'the headline rate is the typical post, not the mean');
    const posts = d.sections.find(x => x.title === 'Best and weakest posts').blocks[0].items;
    assert.strictEqual(posts[0].image, main.topPosts[0].image, 'a kept photo must be used');
    assert.strictEqual(posts[1].image, null, 'an expiring Instagram link must never be shown');
    assert.ok(posts[3].weak && posts[3].chip.tone === 'bad');
    const flags = d.sections.find(x => x.title === 'What you post, and what works').blocks.find(b => b.type === 'bars');
    assert.deepStrictEqual(flags.rows.map(r => r.label), ['Asks a question'], 'an unreliable caption lift was shown');
    assert.ok(d.sections.every(x => x.source && x.source.length || x.title === 'How the score is built'), 'every section names its source');
});
test('an audit with no narrative and no heatmap draws only what it has', async () => {
    const main = igMain('kyotogrillhouse', { heatmap: null, momentum: { months: [] } });
    const d = S.reportDoc({ id: 'r', report_type: 'ig_report', created_at: '2026-09-28T10:00:00Z', report_json: { main }, ai_json: null });
    const titles = d.sections.map(x => x.title);
    assert.ok(!titles.includes('When your audience responds') && !titles.includes('Consistency and momentum') && !titles.includes('30-day plan and targets'), titles.join(' | '));
    assert.ok(!d.sections[0].blocks.some(b => b.type === 'verdict'));
});
test('competitor intel ranks everyone on one scale and marks the client', async () => {
    const main = igMain('sakurahibachi.ma'), r1 = igMain('ginzahibachi.ma', { score: 79, grade: 'B+', engagementRate: '2.20', postsPerWeek: '5.1' }), r2 = igMain('fujiyama.worcester', { score: 66, grade: 'C+', engagementRate: '1.80', postsPerWeek: '3.6' });
    const benchmark = S.buildBenchmark(main, [r1, r2]);
    const d = S.reportDoc({ id: 'c', report_type: 'deep_audit', created_at: '2026-09-28T10:00:00Z', report_json: { main, rivals: [r1, r2], benchmark }, ai_json: { competitor_insights: ['Ginza posts daily: volume wins'], content_strategy: ['Two more Reels a week'] } });
    assert.strictEqual(d.cover.title, '@sakurahibachi.ma against 2 rivals');
    assert.deepStrictEqual(d.cover.receipt.slice(0, 3).map(x => x[0]), ['2nd', '1st', '3rd']);
    const board = d.sections[0].blocks[0];
    assert.strictEqual(board.rows[board.highlight][1], '@sakurahibachi.ma (you)');
    assert.strictEqual(d.sections[0].blocks[1].text.startsWith('You come 2nd out of 3'), true, d.sections[0].blocks[1].text);
    assert.ok(d.sections.some(x => x.title === 'Rivals’ best posts' && x.blocks[0].items[0].by === '@ginzahibachi.ma'));
});
test('the owner and a share link get the document; the assistant does not', async () => {
    const main = igMain('harborcafe');
    const row = { id: crypto.randomUUID(), user_id: EMP.id, client_id: state.C, report_type: 'ig_report', platform: 'instagram', target_handle: 'harborcafe', score: 74, created_at: new Date().toISOString(), report_json: { main }, ai_json: { executive_summary: 'Healthy.' } };
    tbl('reports').push(row);
    const r = await ownerOpen(row.id);
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.report.doc.type, 'ig_report');
    const staff = await S.assistantScope(EMP.id, state.C, 'user');
    const detail = await S.ASSISTANT_TOOLS.get_report_detail.run(staff, { report_id: row.id });
    assert.ok(!('doc' in detail));
});


section('\nphase 37 — the Facebook Page report as a document');
function fbPage(name, extra = {}) {
    return { name, pageId: name.toLowerCase().replace(/\W/g, ''), followers: 3104, rating: 4.6, reviewsCount: 212, category: 'Japanese restaurant', postsAnalyzed: 38, grade: 'B', score: 71,
        medians: { engagement: 47 }, conversationRate: 9, amplificationRate: 14, cadence: { postsPerWeek: 3, spanDays: 90, lastPostDaysAgo: 2 },
        completeness: { checks: [{ label: 'Opening hours', ok: false }, { label: 'Website', ok: true }] }, sentiment: { available: true, positiveShare: 81, negativeShare: 6, highEffortShare: 34 },
        formats: [{ key: 'video', posts: 9, avgEngagement: 88, avgIndex: 1.9 }, { key: 'link', posts: 10, avgEngagement: 9, avgIndex: 0.2 }], intents: [{ key: 'event_offer', avgIndex: 2.1 }, { key: 'link_out', avgIndex: 0.2 }],
        video: { posts: 9, share: 24, avgIndex: 1.9, avgViews: 1240 },
        topPosts: [{ format: 'video', excerpt: 'Kids eat free every Tuesday in September. Tag a parent who needs a night off.', reactions: 312, comments: 88, shares: 41, index: 3.1, postedAt: '2026-08-22T18:00:00Z', url: 'https://www.facebook.com/sakura/posts/1' }, { format: 'photo', excerpt: 'Table 6 set a record', reactions: 254, comments: 36, shares: 12, index: 2.4, url: 'https://evil.example/x' }],
        heatmap: { cells: [{ dow: 2, hour: 18, posts: 3, avgIndex: 1.8 }], bestHours: [], bestDays: [] }, momentum: { months: [{ month: '2026-07', posts: 12, medEngagement: 38 }, { month: '2026-08', posts: 13, medEngagement: 44 }] }, ...extra };
}
test('a Facebook Page report becomes a document, and a rival Page is compared row by row', async () => {
    const target = fbPage('Sakura Hibachi Grill'), rival = fbPage('Ginza Hibachi', { followers: 5870, cadence: { postsPerWeek: 5.2 } });
    const benchmark = { verdict: 'Sakura Hibachi Grill leads on 4 of 7 measures.', rows: [{ metric: 'Followers', target: 3104, rival: 5870, winner: 'rival' }, { metric: 'Shares per 100 reactions', target: 14, rival: 6, winner: 'target' }], shareOfVoice: { target: 38, rival: 62 }, formatGaps: [{ format: 'video', rivalIndex: 1.4 }] };
    const row = { id: 'f', report_type: 'fb_page', created_at: '2026-09-28T10:00:00Z',
        report_json: { mode: 'versus', windowDays: 90, target, rival, benchmark, recommendations: [{ priority: 'critical', title: 'Add opening hours', action: 'Add opening hours and email to the Page', why: 'Facebook shows “hours not listed” to every visitor.' }], generatedAt: '2026-09-28T10:00:00Z' },
        ai_json: { executive_summary: 'A well-rated Page whose videos travel. Half its posts are links nobody reacts to.', what_is_working: ['Video: 1.9× typical'], what_is_failing: ['Links: 0.2× typical'], quick_wins: ['Post Tuesday 6 pm'], thirty_day_plan: [{ week: 'Week 1', actions: ['Fill in hours'] }], kpis_to_watch: [{ kpi: 'Median engagement', current: '47', target: '55' }] } };
    const d = S.reportDoc(row);
    assert.strictEqual(d.cover.title, 'Sakura Hibachi Grill');
    assert.deepStrictEqual(d.cover.receipt[1], ['4.6★', '212 reviews']);
    const titles = d.sections.map(x => x.title);
    for (const x of ['At a glance', 'Page health', 'What you post, and what works', 'Best posts', 'Timing and momentum', 'Against Ginza Hibachi', 'Recommendations', 'What is working, what is not', '30-day plan and what we will watch']) assert.ok(titles.includes(x), 'missing ' + x + ': ' + titles.join(' | '));
    const vs = d.sections.find(x => x.title === 'Against Ginza Hibachi');
    assert.strictEqual(vs.lead, 'Sakura Hibachi Grill leads on 4 of 7 measures.');
    const table = vs.blocks[0];
    assert.deepStrictEqual(table.rows.map(r => r[3].chip), ['Ginza Hibachi', 'Sakura Hibachi Grill']);
    const quotes = d.sections.find(x => x.title === 'Best posts').blocks[0].items;
    assert.strictEqual(quotes[0].link, 'https://www.facebook.com/sakura/posts/1');
    assert.strictEqual(quotes[1].link, null, 'a link off Facebook must not be shown');
    const rec = d.sections.find(x => x.title === 'Recommendations').blocks[0].rows[0];
    assert.deepStrictEqual(rec[0], { chip: 'Critical', tone: 'bad' });
    assert.ok(!d.sections.some(x => x.title === 'Against Ginza Hibachi' && false));
});
test('a single-Page report has no rival section, and the owner gets the document', async () => {
    const d = S.fbDoc({ id: 'g', report_type: 'fb_page', created_at: '2026-09-28T10:00:00Z', report_json: { mode: 'single', target: fbPage('Harbor Cafe') }, ai_json: null });
    assert.ok(!d.sections.some(x => /^Against /.test(x.title)));
    const r = await ownerOpen(state.fbRep.id);
    assert.strictEqual(r.body.report.doc && r.body.report.doc.type, 'fb_page');
    assert.strictEqual(r.body.report.headline, 'Steady, with weekends dark.', 'the older owner fields stay for the list and the assistant');
});


section('\nphase 38 — the monthly report with Meta, upgraded, and without Meta');
test('the Meta monthly keeps its best posts’ photos, and never the expiring address', async () => {
    const rep = tbl('reports').find(x => x.id === state.moReport);
    const p = rep.report_json.posting.topByReach[0];
    assert.ok(p.image && p.image.includes('/report-media/meta/'), 'no kept photo: ' + JSON.stringify(p));
    assert.ok(!('thumb' in p), 'the expiring address was saved');
    const r = await ownerOpen(state.moReport);
    assert.strictEqual(r.body.report.month.posts[0].image, p.image);
});
test('Facebook and Instagram side by side, with a sum only where both have the number', async () => {
    const d = k => ({ now: { page_fan_adds_unique: 51, follower_count: 8, page_impressions_unique: 30551, reach: 11884, views: 21787, page_post_engagements: 6830, total_interactions: 1011 }[k] });
    const byKey = Object.fromEntries(['page_fan_adds_unique', 'follower_count', 'page_impressions_unique', 'reach', 'views', 'page_post_engagements', 'total_interactions'].map(k => [k, d(k)]));
    const pf = S.monthPlatforms(byKey, { pageFollowers: 647, igFollowers: 253 });
    const row = l => pf.rows.find(r => r.label === l);
    assert.deepStrictEqual(row('Reach'), { label: 'Reach', fb: 30551, ig: 11884, both: 42435 });
    assert.deepStrictEqual(row('Views'), { label: 'Views', fb: null, ig: 21787, both: null }, 'no Facebook views: no sum');
    assert.ok(!row('Website taps'), 'a row neither platform has is left out');
    assert.strictEqual(S.monthPlatforms({ reach: { now: 5 } }, {}), null, 'one platform only: no side-by-side table');
});
test('the longer view adds up each month of the stored daily numbers', async () => {
    const cid = crypto.randomUUID();
    for (const [day, level, reach, follows] of [['2026-06-03', 'ig', 100, 1], ['2026-06-04', 'ig', 50, 2], ['2026-07-10', 'ig', 300, 4], ['2026-08-01', 'ig', 400, 6], ['2026-08-02', 'page', 900, 9]]) {
        tbl('meta_daily').push({ id: crypto.randomUUID(), connection_id: cid, user_id: EMP.id, day, level, reach, follows });
    }
    const t = await S.monthTrends(cid, '2026-08');
    assert.deepStrictEqual(t.labels, ['Apr', 'May', 'Jun', 'Jul', 'Aug']);
    assert.deepStrictEqual(t.reach.ig, [null, null, 150, 300, 400]);
    assert.deepStrictEqual(t.follows.fb, [null, null, null, null, 9]);
    assert.strictEqual(t.firstMonth, '2026-06');
    assert.strictEqual(await S.monthTrends(crypto.randomUUID(), '2026-08'), null, 'no daily numbers: no trend');
});
test('without Meta, a monthly report is built from the stored public posts, and says what it cannot see', async () => {
    const cl = tbl('clients').find(c => c.id === state.C);
    const handle = String(cl.ig_handle || 'harborcafe').replace(/^@/, '').toLowerCase();
    cl.ig_handle = handle;
    const post = (sc, day, likes, extra = {}) => tbl('posts').push({ id: crypto.randomUUID(), user_id: EMP.id, client_id: state.C, platform: 'instagram', handle, shortcode: sc, post_url: `https://www.instagram.com/p/${sc}/`, post_type: 'Reel', caption: 'Grill night ' + sc, likes, comments: 10, views: likes * 20, thumbnail_url: `https://scontent.cdninstagram.com/v/${sc}.jpg`, posted_at: day, scraped_at: new Date().toISOString(), ...extra });
    post('pm1', '2026-08-05T19:00:00Z', 300); post('pm2', '2026-08-12T19:00:00Z', 120, { post_type: 'Image', views: 0 }); post('pm3', '2026-08-20T19:00:00Z', 200);
    post('pm0', '2026-07-15T19:00:00Z', 90);
    post('rv1', '2026-08-06T19:00:00Z', 9999, { handle: 'ginzahibachi.ma' });   // a rival's post filed under the client: not theirs
    tbl('reports').push({ id: crypto.randomUUID(), user_id: EMP.id, client_id: state.C, report_type: 'ig_report', created_at: '2026-07-25T10:00:00Z', report_json: { main: { handle, followers: 4700 } } },
        { id: crypto.randomUUID(), user_id: EMP.id, client_id: state.C, report_type: 'ig_report', created_at: '2026-08-28T10:00:00Z', report_json: { main: { handle, followers: 4812 } } });
    const bad = await call('POST', '/api/reports/public-monthly', { token: 't-emp', body: { clientId: state.C, month: new Date().toISOString().slice(0, 7) } });
    assert.strictEqual(bad.statusCode, 400, 'a month still running was accepted');
    const owner = await call('POST', '/api/reports/public-monthly', { token: 't-client', body: { clientId: state.C, month: '2026-08' } });
    assert.strictEqual(owner.statusCode, 403, 'an owner started a staff job');
    tbl('jobs').filter(j => j.user_id === EMP.id && ['queued', 'running'].includes(j.status)).forEach(j => { j.status = 'done'; });
    const r = await call('POST', '/api/reports/public-monthly', { token: 't-emp', body: { clientId: state.C, month: '2026-08' } });
    assert.strictEqual(r.statusCode, 202, JSON.stringify(r.body));
    const job = await untilDone(r.body.jobId);
    assert.strictEqual(job.status, 'done', `the job ended ${job.status}: ${job.error || ''}`);
    const rep = tbl('reports').find(x => x.id === job.result_report_id);
    assert.strictEqual(rep.report_type, 'public_monthly');
    assert.strictEqual(rep.report_json.ig.posts, 3, 'a rival’s post was counted as the client’s');
    assert.strictEqual(rep.report_json.ig.prevPosts, 1);
    assert.deepStrictEqual([rep.report_json.ig.followersStart.value, rep.report_json.ig.followers.value], [4700, 4812]);
    assert.ok(rep.report_json.ig.top[0].image && rep.report_json.ig.top[0].image.includes('/report-media/pm/'), 'the top post’s photo was not kept');
    const view = await ownerOpen(rep.id);
    const d = view.body.report.doc;
    assert.strictEqual(d.type, 'public_monthly');
    assert.strictEqual(view.body.report.title, 'Monthly report');
    assert.ok(d.sections[0].blocks.some(b => b.type === 'verdict' && /published 3 posts in August, 2 more than July/.test(b.text)), JSON.stringify(d.sections[0]));
    assert.ok(d.sections.some(s => s.blocks.some(b => b.type === 'missing')), 'the report must say what it cannot see');
    const plan = d.sections.find(s => s.title === 'Plan for next month');
    assert.ok(/Connect Facebook and Instagram/.test(plan.blocks[0].rows[0][0].text), 'connecting Meta comes first');
});

section('\nthe content plan, with the model told to overspend');
/** Stored posts for one Instagram handle, varied enough to produce cells. */
function seedPosts(handle, spec) {
    const now = Date.now();
    // Spread over the part of this month that has passed (UTC), so the posts stay in the
    // current month on any day of it. One a day only worked after the 18th.
    const d0 = new Date(now), monthStart = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), 1);
    const step = Math.min(86400000, Math.max(60000, (now - monthStart) / (spec.length + 2)));
    spec.forEach((p, i) => tbl('posts').push({
        id: crypto.randomUUID(), user_id: EMP.id, client_id: state.C, platform: 'instagram', handle,
        shortcode: `${handle.slice(0, 3)}${i}`, post_url: `https://instagram.com/p/${handle.slice(0, 3)}${i}`,
        post_type: p.type, is_video: p.type === 'reel', carousel_count: p.type === 'carousel' ? 5 : null,
        caption: p.caption, hashtags: ['#boston', '#food'], likes: p.likes, comments: p.comments, views: p.type === 'reel' ? p.likes * 12 : null,
        engagement_raw: p.likes + p.comments, is_sponsored: false, is_provisional: false,
        // One post a day, most recent first, so all of them fall in the current
        // month: the index is computed per handle per month, and a post that
        // drifts into last month is scored against a different median.
        posted_at: new Date(now - (i + 1) * step).toISOString(), scraped_at: new Date(now - 60000).toISOString(),
        hour_local: 9 + (i % 10), dow_local: i % 7, audio: null, first_comment: null, aspect_ratio: null, video_duration: p.type === 'reel' ? 14 : null
    }));
}
test('the run is queued under the client and finishes on stored rows alone — no Apify', async () => {
    tbl('user_engine_access').push({ user_id: EMP.id, engine: 'content_plan' });
    // A cell wins when its posts sit well above the handle's own monthly
    // median, so the winners are a minority: six against twelve filler
    // posts. The target wins with question-led Reels; the rival wins with
    // long how-to Carousels in a cell the target has never used — a gap.
    const twelve = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    seedPosts('harborcafe', [
        ...[1, 2, 3, 4, 5, 6].map(i => ({ type: 'reel', caption: `Ever wondered how we roast batch ${i}? Watch.`, likes: 2000 + i * 10, comments: 120 })),
        ...twelve.map(i => ({ type: 'image', caption: `Morning light on the counter, day ${i}.`, likes: 150, comments: 4 }))
    ]);
    seedPosts('northendpizza', [
        ...[1, 2, 3, 4, 5, 6].map(i => ({ type: 'carousel', caption: `How to pick the right dough, step ${i}: hydration, flour, time, temperature, patience and a hot stone make the difference every single time.`, likes: 3000 + i * 10, comments: 150 })),
        ...twelve.map(i => ({ type: 'image', caption: `Slice of the day ${i}.`, likes: 300, comments: 8 }))
    ]);

    state.cpCells = {};
    GEMINI.script = [(req) => {
        // Read the scorecard the server built, and answer for the cells it named.
        const text = req.contents[0].parts[0].text;
        const start = text.indexOf('Scorecard (JSON):');
        const end = text.indexOf('Reply with ONLY');
        const card = JSON.parse(text.slice(start + 'Scorecard (JSON):'.length, end).trim());
        const brief = (c) => { state.cpCells[c.cell] = c.why; return { cell: c.cell, hook: c.evidence?.[0]?.hook || 'Ever wondered?', script: ['Open on the roaster', 'Cut to the pour', 'End on the cup'], shot: 'Phone on the counter, natural light', boost: 'worth boosting', boost_why: 'It performs, put money behind it.', evidence: [] }; };
        const out = { summary: 'Reels win; carousels are the gap.', stop_doing: ['Stop posting stills at 9am.'], caption_rules: ['Open with a question.'] };
        for (const plural of ['reels', 'carousels', 'stills']) out[plural] = (card[plural] || []).slice(0, 3).map(brief);
        // One invented cell the server never offered. It must be dropped.
        out.reels.push({ cell: 'Reel|invented|short|nothing', hook: 'Made up', script: [], shot: null, boost: 'worth boosting', boost_why: 'Trust me.', evidence: [] });
        return { parts: [{ text: JSON.stringify(out) }] };
    }];

    const r = await call('POST', '/api/content-plan', { token: 't-emp', body: { platform: 'instagram', target: 'harborcafe', rivals: 'northendpizza', clientId: state.C } });
    assert.strictEqual(r.statusCode, 202, JSON.stringify(r.body));
    assert.strictEqual(r.body.estimatedUsd, 0, 'the plan must cost nothing');
    const job = await untilDone(r.body.jobId);
    assert.strictEqual(job.status, 'done', `the job ended ${job.status}: ${job.error || ''}`);
    assert.strictEqual(job.client_id, state.C);
    state.cpReport = job.result_report_id;
    assert.ok(state.cpReport, 'no report id on the finished job');
    assert.ok(Object.keys(state.cpCells).length >= 2, 'the model was offered too few cells to test the gate: ' + JSON.stringify(state.cpCells));
});
test('the boost gate held: every gap was downgraded, every proven cell kept, the invented one dropped', async () => {
    const rep = tbl('reports').find(x => x.id === state.cpReport);
    assert.ok(rep, 'no report row');
    assert.strictEqual(rep.report_type, 'content_plan');
    const rj = rep.report_json || {};
    const briefs = rj.briefs || (rj.plan && rj.plan.briefs);
    assert.ok(briefs, 'no briefs on the report; keys: ' + Object.keys(rj).join(','));
    const all = ['reels', 'carousels', 'stills'].flatMap(k => briefs[k] || []);
    assert.ok(all.length >= 2, 'no briefs survived');
    let gaps = 0, wins = 0;
    for (const b of all) {
        const why = state.cpCells[b.cell];
        assert.ok(why, 'a brief for a cell the model was never offered survived: ' + b.cell);
        if (why === 'gap') { gaps++; assert.strictEqual(b.boost, 'organic only', 'a gap cell kept "worth boosting"'); assert.strictEqual(b.boost_downgraded, true); assert.ok(!/put money/i.test(b.boost_why), 'the model\'s spending rationale survived the downgrade'); }
        else { wins++; assert.strictEqual(b.boost, 'worth boosting', 'a proven cell was downgraded'); }
        assert.strictEqual(b.sources.evidence, 'scraped');
        assert.ok(['strong', 'healthy', 'mixed', 'weak', 'poor'].includes(b.predicted_band) || typeof b.predicted_band === 'string', 'the band comes from the computed index, never the model');
    }
    assert.ok(gaps >= 1, 'no gap cell was offered — the rival\'s carousels should have been one');
    assert.ok(briefs.removed >= 1, 'the invented cell was not dropped');
});
test('the client can read the plan as ideas, in owner language', async () => {
    const r = await ownerOpen(state.cpReport);
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.report.type, 'content_plan');
    assert.ok(/things to post next|content plan/i.test(r.body.report.headline), r.body.report.headline);
    assert.ok(Array.isArray(r.body.report.ideas));
});

section('\nrate limits do not bleed between routes');
test('a page-load\'s worth of reads does not lock the next job start', async () => {
    // readLimit runs on every /api request; spendLimit on job starts. They
    // used to share one bucket per user, so six reads in a minute made the
    // seventh call — the job — a 429. The refusal here must be the client
    // rule (400), never the limiter.
    for (let i = 0; i < 10; i++) await call('GET', '/api/me', { token: 't-emp' });
    const r = await call('POST', '/api/generate-ig-report', { token: 't-emp', body: { target: 'harborcafe' } });
    assert.notStrictEqual(r.statusCode, 429, 'ten reads locked a job start: ' + JSON.stringify(r.body));
    assert.strictEqual(r.statusCode, 400);
    assert.strictEqual(r.body.code, 'client_required');
});
test('public traffic from an address does not lock the assistant for that address', async () => {
    // Every earlier public call in this run came from 127.0.0.1 too. If the
    // IP buckets were shared, this would be a 429 before the model was asked.
    GEMINI.script = [{ parts: [{ text: 'Still here.' }] }];
    const r = await call('POST', '/api/assistant/ask', { token: 't-emp2', body: { message: 'ping' } });
    assert.notStrictEqual(r.statusCode, 429, JSON.stringify(r.body));
});

section('\nthe analyst answers about one client only');
test('a question with a client chosen is answered from that client\'s reports, and the thread is filed under it', async () => {
    GEMINI.script = [
        { parts: [{ functionCall: { name: 'get_my_reports', args: {} } }] },
        { parts: [{ text: 'Harbor Cafe has one Instagram check-up on file, in the healthy band.' }] }
    ];
    GEMINI.requests.length = 0;
    const r = await call('POST', '/api/assistant/ask', { token: 't-emp', body: { message: 'How is this account doing?', clientId: state.C } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.ok(/Harbor Cafe/.test(r.body.answer), r.body.answer);
    assert.strictEqual(r.body.clientId, state.C);
    assert.deepStrictEqual(r.body.used, ['get_my_reports']);
    state.thread = r.body.conversationId;
    const conv = tbl('ai_conversations').find(c => c.id === state.thread);
    assert.ok(conv, 'no conversation row');
    assert.strictEqual(conv.client_id, state.C, 'the thread is not filed under the client');
    assert.strictEqual(tbl('ai_messages').filter(m => m.conversation_id === state.thread).length, 2);
});
test('the tool result the model actually received held only that client\'s reports', async () => {
    assert.strictEqual(GEMINI.requests.length, 2, 'expected a tool round and an answer round');
    const fr = GEMINI.requests[1].contents.flatMap(c => c.parts || []).find(p => p.functionResponse);
    assert.ok(fr, 'no functionResponse went back to the model');
    const rows = fr.functionResponse.response.result;
    assert.ok(Array.isArray(rows) && rows.length >= 1, 'the model saw no reports');
    const foreign = rows.filter(x => x.handle && x.handle !== 'harborcafe');
    assert.strictEqual(foreign.length, 0, 'a report from another client reached the model: ' + JSON.stringify(foreign.map(x => x.handle)));
});
test('the operator prompt names the client and says the others are out of reach', async () => {
    const sys = GEMINI.requests[0].systemInstruction.parts[0].text;
    assert.ok(/cannot see the operator's other clients/i.test(sys), 'the scope was not stated to the model');
    assert.ok(/Harbor Cafe/.test(sys), 'the client is not named');
    assert.ok(/analyst/i.test(sys), 'an employee should get the operator register');
    assert.ok(!/knowledgeable friend/i.test(sys));
});
test('the tools were declared to the model, none of them taking a client argument', async () => {
    const decls = GEMINI.requests[0].tools[0].functionDeclarations;
    assert.ok(decls.some(d => d.name === 'get_monthly_report'));
    for (const d of decls) {
        for (const p of Object.keys(d.parameters.properties || {})) {
            assert.ok(!/client|user|owner|account|scope/i.test(p), `${d.name} exposes "${p}" — the model could widen its own scope`);
        }
    }
});
test('the same thread will not take a turn about a different client', async () => {
    GEMINI.script = [{ parts: [{ text: 'Bloom Florist has nothing on file yet.' }] }];
    const r = await call('POST', '/api/assistant/ask', { token: 't-emp', body: { message: 'And this one?', clientId: state.D, conversationId: state.thread } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.notStrictEqual(r.body.conversationId, state.thread, 'a thread started for one client accepted a turn about another');
    assert.strictEqual(tbl('ai_conversations').find(c => c.id === r.body.conversationId).client_id, state.D);
});
test('threads are listed per client, and none of them leak into the no-client list', async () => {
    const c = await call('GET', '/api/assistant/conversations', { token: 't-emp', query: { client_id: state.C } });
    assert.ok(c.body.conversations.some(x => x.id === state.thread));
    assert.ok(!c.body.conversations.some(x => x.client_id === state.D));
    const none = await call('GET', '/api/assistant/conversations', { token: 't-emp' });
    assert.strictEqual(none.body.conversations.filter(x => x.client_id).length, 0);
});
test('a client account is answered in the owner register, about itself', async () => {
    GEMINI.script = [{ parts: [{ text: 'You are doing well — one check-up on file.' }] }];
    GEMINI.requests.length = 0;
    const r = await call('POST', '/api/assistant/ask', { token: 't-client', body: { message: 'How am I doing?' } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    const sys = GEMINI.requests[0].systemInstruction.parts[0].text;
    assert.ok(/knowledgeable friend/i.test(sys), 'a client should get the owner register');
    assert.ok(!/analyst/i.test(sys));
    assert.ok(/never mention tools/i.test(sys), 'the owner is not told how it is built');
});
test('when the model has nothing to say, the answer says so rather than inventing', async () => {
    GEMINI.script = [];                                    // the fake answers 500
    const r = await call('POST', '/api/assistant/ask', { token: 't-emp', body: { message: 'Anything?', clientId: state.C } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.ok(/could not|try/i.test(r.body.answer), 'a failed model call should read as a failure, not an answer: ' + r.body.answer);
});

// ===========================================================================
// PHASE 29 — one master list for the whole agency; mail from the agency's Gmail
// ===========================================================================
section('\none master list for the whole agency, filed by industry and location');
const ago = n => new Date(Date.now() - n * 1000).toISOString();
test('everything anyone finds lands in one place; the same business is one row', async () => {
    tbl('leads').push(
        { id: crypto.randomUUID(), owner_user_id: EMP.id,    platform: 'instagram', username: 'dhakabakes', industry: 'bakery',    location: 'Dhaka',  email: 'hi@dhakabakes.test', is_enriched: true,  created_at: ago(50) },
        { id: crypto.randomUUID(), owner_user_id: EMP2.id,   platform: 'instagram', username: 'dhakabakes', industry: 'cake shop', location: 'Dhaka',  is_enriched: false, created_at: ago(10) },
        { id: crypto.randomUUID(), owner_user_id: EMP2.id,   platform: 'facebook',  username: 'ctgflorist', industry: null, location: null, category: 'Florist', city: 'Chittagong', phone: '+880', created_at: ago(40) },
        { id: crypto.randomUUID(), owner_user_id: CLIENT.id, platform: 'instagram', username: 'ownerfound', industry: 'cafe supplies', location: 'Sylhet', created_at: ago(30) }
    );
    const all = await call('GET', '/api/leads', { token: 't-admin', query: { q: 'dhakabakes' } });
    assert.strictEqual(all.statusCode, 200, JSON.stringify(all.body));
    assert.strictEqual(all.body.scope, 'agency');
    const rows = all.body.leads.filter(l => l.username === 'dhakabakes');
    assert.strictEqual(rows.length, 1, 'the same business should be one row in the master list');
    assert.strictEqual(rows[0].is_enriched, true, 'the richer row should win');
    assert.strictEqual(rows[0].copies, 2, 'the row should say two people found it');
    assert.strictEqual(rows[0].found_by.email, EMP.email, 'the row should say who found it');
});
test('an employee reads the same one list; "mine" is their own rows', async () => {
    const theirs = await call('GET', '/api/leads', { token: 't-emp2', query: { limit: '200' } });
    const names = theirs.body.leads.map(l => l.username);
    assert.ok(['ownerfound', 'dhakabakes', 'ctgflorist'].every(n => names.includes(n)), names.join(','));
    const mine = await call('GET', '/api/leads', { token: 't-emp2', query: { mine: '1' } });
    assert.strictEqual(mine.body.scope, 'mine');
    assert.ok(mine.body.leads.length >= 2 && mine.body.leads.every(l => l.owner_user_id === EMP2.id), 'mine should be only my rows');
});
test('filed by industry and location — including rows that only know their own category and city', async () => {
    const bakery = await call('GET', '/api/leads', { token: 't-admin', query: { industry: 'bakery' } });
    assert.deepStrictEqual(bakery.body.leads.map(l => l.username), ['dhakabakes']);
    const florist = await call('GET', '/api/leads', { token: 't-admin', query: { industry: 'florist' } });
    assert.deepStrictEqual(florist.body.leads.map(l => l.username), ['ctgflorist'], 'a row with only a category should still be found by industry');
    const ctg = await call('GET', '/api/leads', { token: 't-admin', query: { location: 'chittagong' } });
    assert.deepStrictEqual(ctg.body.leads.map(l => l.username), ['ctgflorist']);
    const dhaka = await call('GET', '/api/leads', { token: 't-admin', query: { location: 'dhaka' } });
    assert.ok(dhaka.body.leads.some(l => l.username === 'dhakabakes'));
});
test('the summary lists the industries and locations, and how many people found them', async () => {
    const s = await call('GET', '/api/leads/summary', { token: 't-admin' });
    assert.strictEqual(s.statusCode, 200, JSON.stringify(s.body));
    assert.strictEqual(s.body.scope, 'agency');
    const ind = s.body.industries.map(x => x.name);
    assert.ok(ind.includes('bakery') && ind.includes('Florist'), ind.join(','));
    assert.ok(s.body.locations.map(x => x.name).includes('Chittagong'));
    assert.ok(s.body.people >= 3, 'at least three people found leads: ' + s.body.people);
    const list = await call('GET', '/api/leads', { token: 't-admin', query: { limit: '200' } });
    assert.strictEqual(s.body.total, list.body.total, 'the tiles must count the list they sit above');
});
test('a client account never sees the agency\'s list, however it asks', async () => {
    const r = await call('GET', '/api/leads', { token: 't-client' });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.scope, 'mine');
    assert.ok(r.body.leads.length >= 1 && r.body.leads.every(l => l.owner_user_id === CLIENT.id), 'a client saw someone else\'s leads');
    const csv = await call('GET', '/api/leads/export.csv', { token: 't-client' });
    assert.ok(!String(csv.body).includes('dhakabakes'), 'the client\'s export carried the agency\'s leads');
});
test('the export carries industry, location and who found it', async () => {
    const r = await call('GET', '/api/leads/export.csv', { token: 't-admin', query: { industry: 'florist' } });
    assert.strictEqual(r.statusCode, 200);
    const [head, ...body] = String(r.body).replace(/^\ufeff/, '').split('\r\n');
    assert.ok(/(^|,)industry,location(,|$)/.test(head) && /found_by/.test(head), head);
    assert.strictEqual(body.length, 1, String(r.body));
    assert.ok(body[0].includes('ctgflorist') && body[0].includes('Florist') && body[0].includes('Chittagong') && body[0].includes(EMP2.email), body[0]);
});

section('\nemail goes out from the agency\'s own Gmail');
const settle = () => new Promise(r => setTimeout(r, 30));
test('the admin saves a Gmail address and an app password; the password never comes back', async () => {
    const r = await call('PATCH', '/api/admin/settings', { token: 't-admin', body: { mail: { from: 'Agency@Gmail.com', appPassword: 'abcd efgh ijkl mnop', fromName: 'Harbor Agency', notifyTo: '' } } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    const g = await call('GET', '/api/admin/settings', { token: 't-admin' });
    assert.strictEqual(g.body.mail.from, 'agency@gmail.com');
    assert.strictEqual(g.body.mail.notifyTo, 'agency@gmail.com', 'notifications default to the sending address');
    assert.strictEqual(g.body.mail.hasPassword, true);
    assert.strictEqual(g.body.mail.configured, true);
    const dump = JSON.stringify(g.body);
    assert.ok(!dump.includes('abcdefghijklmnop') && !dump.includes('abcd efgh'), 'the app password was sent to the browser');
    const emp = await call('PATCH', '/api/admin/settings', { token: 't-emp', body: { mail: { from: 'x@gmail.com' } } });
    assert.strictEqual(emp.statusCode, 403);
    const bad = await call('PATCH', '/api/admin/settings', { token: 't-admin', body: { mail: { appPassword: 'short' } } });
    assert.strictEqual(bad.statusCode, 400);
    const badAddr = await call('PATCH', '/api/admin/settings', { token: 't-admin', body: { mail: { from: 'not an address' } } });
    assert.strictEqual(badAddr.statusCode, 400);
});
test('a test message goes through Gmail with the saved credentials, spaces stripped', async () => {
    MAIL.sent.length = 0;
    const r = await call('POST', '/api/admin/mail/test', { token: 't-admin', body: {} });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.to, 'agency@gmail.com');
    assert.strictEqual(MAIL.sent.length, 1);
    const { opts, msg } = MAIL.sent[0];
    assert.strictEqual(opts.host, 'smtp.gmail.com');
    assert.strictEqual(opts.auth.user, 'agency@gmail.com');
    assert.strictEqual(opts.auth.pass, 'abcdefghijklmnop');
    assert.ok(msg.from.includes('Harbor Agency') && msg.from.includes('agency@gmail.com'), msg.from);
    assert.strictEqual(msg.to, 'agency@gmail.com');
    const emp = await call('POST', '/api/admin/mail/test', { token: 't-emp', body: {} });
    assert.strictEqual(emp.statusCode, 403);
});
test('a new trial and a request to continue reach the agency; an activation reaches the client', async () => {
    MAIL.sent.length = 0;
    const NEWBIE = person('newtrial@shop.test'); TOKENS['t-newbie'] = NEWBIE;
    const me = await call('GET', '/api/me', { token: 't-newbie' });
    assert.strictEqual(me.body.role, 'client');
    await settle();
    let m = MAIL.sent.find(x => /new trial/i.test(x.msg.subject));
    assert.ok(m, 'the agency should hear about a new trial');
    assert.strictEqual(m.msg.to, 'agency@gmail.com');
    assert.ok(m.msg.text.includes('newtrial@shop.test'), m.msg.text);

    const ask = await call('POST', '/api/me/request-activation', { token: 't-newbie', body: { note: 'Monthly, please' } });
    assert.strictEqual(ask.statusCode, 200, JSON.stringify(ask.body));
    await settle();
    m = MAIL.sent.find(x => /wants to continue/i.test(x.msg.subject));
    assert.ok(m, 'the agency should hear a request to continue');
    assert.ok(m.msg.text.includes('newtrial@shop.test') && m.msg.text.includes('Monthly, please'), m.msg.text);

    const act = await call('PATCH', '/api/admin/users/' + NEWBIE.id, { token: 't-admin', body: { paidUntil: '2027-01-31T00:00:00Z', planLabel: 'Starter' } });
    assert.strictEqual(act.statusCode, 200, JSON.stringify(act.body));
    await settle();
    m = MAIL.sent.find(x => x.msg.to === 'newtrial@shop.test');
    assert.ok(m, 'the client should hear that they were activated');
    assert.ok(/active/i.test(m.msg.subject) && m.msg.text.includes('Starter') && m.msg.text.includes('2027-01-31'), m.msg.text);
});
test('when Gmail refuses, the admin sees why and the client\'s request still succeeds', async () => {
    MAIL.fail = '535-5.7.8 Username and Password not accepted';
    MAIL.sent.length = 0;
    const t = await call('POST', '/api/admin/mail/test', { token: 't-admin', body: {} });
    assert.strictEqual(t.statusCode, 502, JSON.stringify(t.body));
    assert.ok(/535/.test(t.body.error), t.body.error);
    const g = await call('GET', '/api/admin/settings', { token: 't-admin' });
    assert.ok(/535/.test(g.body.mail.lastError || ''), 'the last error should be on the admin page');
    const ask = await call('POST', '/api/me/request-activation', { token: 't-newbie', body: {} });
    assert.strictEqual(ask.statusCode, 200, 'a mail failure must not fail the request');
    MAIL.fail = null;
});
test('with no mail set up, nothing is attempted and nothing breaks', async () => {
    const r = await call('PATCH', '/api/admin/settings', { token: 't-admin', body: { mail: { appPassword: '' } } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    const g = await call('GET', '/api/admin/settings', { token: 't-admin' });
    assert.strictEqual(g.body.mail.hasPassword, false);
    assert.strictEqual(g.body.mail.configured, false);
    MAIL.sent.length = 0;
    const t = await call('POST', '/api/admin/mail/test', { token: 't-admin', body: {} });
    assert.strictEqual(t.statusCode, 400);
    const ask = await call('POST', '/api/me/request-activation', { token: 't-newbie', body: {} });
    assert.strictEqual(ask.statusCode, 200);
    await settle();
    assert.strictEqual(MAIL.sent.length, 0, 'nothing should have been attempted');
});

// ===========================================================================
// PHASE 30 — the owner assistant, and the numbers every day
// ===========================================================================
section('\nthe owner assistant reads the Meta its agency connected');
test('a client asking is scoped to its own business, where the agency\'s connection lives', async () => {
    GEMINI.script = [{ parts: [{ text: 'Your reach is up this month.' }] }];
    GEMINI.requests.length = 0;
    const r = await call('POST', '/api/assistant/ask', { token: 't-client', body: { message: 'How is my reach?' } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.clientId, state.C, 'the client should be scoped to its business');
    const sys = GEMINI.requests[0].systemInstruction.parts[0].text;
    assert.ok(/has connected Meta/i.test(sys), 'the connection the agency made should count for the owner: ' + sys.slice(0, 400));
    assert.ok(/knowledgeable friend/i.test(sys), 'still the owner register');
    assert.ok(/synced from Meta every day/i.test(sys), 'the daily numbers should be offered to the model');
    const decls = GEMINI.requests[0].tools[0].functionDeclarations;
    assert.ok(decls.some(x => x.name === 'get_daily_growth'), 'the growth tool should be declared');
    const conv = tbl('ai_conversations').find(c => c.id === r.body.conversationId);
    assert.strictEqual(conv.client_id, state.C, 'the thread should be filed under the business');
});
test('the client sees its threads, filed under its business', async () => {
    const r = await call('GET', '/api/assistant/conversations', { token: 't-client', query: { client_id: state.C } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.ok(r.body.conversations.some(c => c.client_id === state.C), 'the thread just started is missing');
});

section('\nthe numbers every day, and growth from the change between them');
const TODAY = new Date().toISOString().slice(0, 10);
const dd = n => S.shiftDay(TODAY, n);
// An employee with no client at all. EMP2 is a member of Harbor Cafe by now
// (the merge carried its membership across), so it is no stranger to it.
const STRANGER = person('stranger@agency.test'); TOKENS['t-stranger'] = STRANGER;
tbl('app_users').push({ id: STRANGER.id, email: STRANGER.email, role: 'user', is_active: true });
test('the daily read writes today\'s counts and the ended days\' activity, from the Graph API', async () => {
    // Older days, as earlier reads would have left them: 8800 followers a
    // month ago, 9000 a week ago, 9200 four days ago; reach 1000 a day in the
    // week before last, 1200 a day since.
    for (let i = 30; i >= 4; i--) {
        const followers = i === 30 ? 8800 : (i === 7 ? 9000 : (i === 4 ? 9200 : (i > 7 ? 8800 + (30 - i) * 8 : 9100)));
        tbl('meta_daily').push({ id: crypto.randomUUID(), connection_id: state.moConn.id, user_id: EMP.id, level: 'ig', day: dd(-i),
            followers, reach: i > 7 ? 1000 : 1200, profile_views: 40, interactions: 70, created_at: new Date().toISOString() });
    }
    GRAPH.daily = {};
    for (const n of [1, 2, 3]) GRAPH.daily[dd(-n)] = { reach: 1200, views: 3000, accounts_engaged: 100, total_interactions: 70, profile_views: 40, website_clicks: 3, follower_count: 10 + n };
    GRAPH.igFollowers = 9240;

    const r = await S.metaDailySync(state.moConn, { days: 3 });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.ig, true); assert.strictEqual(r.page, true); assert.strictEqual(r.days, 3);
    const today = tbl('meta_daily').find(x => x.connection_id === state.moConn.id && x.level === 'ig' && x.day === TODAY);
    assert.ok(today, 'no row for today');
    assert.strictEqual(today.followers, 9240);
    const y = tbl('meta_daily').find(x => x.connection_id === state.moConn.id && x.level === 'ig' && x.day === dd(-1));
    assert.ok(y, 'no row for yesterday');
    assert.strictEqual(y.reach, 1200);
    assert.strictEqual(y.follows, 11, 'follower_count is the day\'s new follows');
    assert.ok(state.moConn.daily_synced_at, 'the connection should say when it was read');
    assert.strictEqual(state.moConn.daily_error, null);
    const page = tbl('meta_daily').find(x => x.connection_id === state.moConn.id && x.level === 'page' && x.day === TODAY);
    assert.ok(page && page.followers === 4820, 'the Page count should be there too');
});
test('reading again is idempotent: one row per day, the count refreshed', async () => {
    GRAPH.igFollowers = 9241;
    await S.metaDailySync(state.moConn, { days: 3 });
    const rows = tbl('meta_daily').filter(x => x.connection_id === state.moConn.id && x.level === 'ig' && x.day === TODAY);
    assert.strictEqual(rows.length, 1, 'a second read must not add a second row for today');
    assert.strictEqual(rows[0].followers, 9241);
    GRAPH.igFollowers = 9240;
    await S.metaDailySync(state.moConn, { days: 3 });
});
test('the client reads its growth: followers against a week and a month ago, reach this week against last', async () => {
    const r = await call('GET', '/api/client/growth', { token: 't-client' });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.connected, true);
    assert.strictEqual(r.body.level, 'ig');
    assert.strictEqual(r.body.source, 'meta_owner_insights');
    const g = r.body.growth;
    assert.strictEqual(g.followers.now, 9240);
    assert.strictEqual(g.followers.day, 40, 'the latest earlier count was 9200');
    assert.strictEqual(g.followers.week, 240, 'a week ago it was 9000');
    assert.strictEqual(g.followers.month, 440, 'a month ago it was 8800');
    assert.strictEqual(g.reach.now, 8400);
    assert.strictEqual(g.reach.before, 7000);
    assert.strictEqual(g.reach.kind, 'up');
    assert.strictEqual(g.reach.pct, 20);
    assert.ok(g.series.length >= 14 && g.series[g.series.length - 1].day === TODAY);
});
test('the agency reads the same growth for the client; a stranger is refused', async () => {
    const r = await call('GET', '/api/meta/growth', { token: 't-emp', query: { client_id: state.C } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.growth.followers.now, 9240);
    const s = await call('GET', '/api/meta/growth', { token: 't-stranger', query: { client_id: state.C } });
    assert.strictEqual(s.statusCode, 403, JSON.stringify(s.body));
    const byConn = await call('GET', '/api/meta/growth', { token: 't-emp', query: { connection_id: state.moConn.id } });
    assert.strictEqual(byConn.body.growth.followers.week, 240);
});
test('"sync now" reads at once; a stranger has nothing to read', async () => {
    const r = await call('POST', '/api/meta/daily-sync', { token: 't-client', body: {} });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.sync.ok, true);
    assert.strictEqual(r.body.growth.followers.now, 9240);
    const e = await call('POST', '/api/meta/daily-sync', { token: 't-emp', body: { connectionId: state.moConn.id } });
    assert.strictEqual(e.statusCode, 200, JSON.stringify(e.body));
    const s = await call('POST', '/api/meta/daily-sync', { token: 't-stranger', body: { connectionId: state.moConn.id } });
    assert.strictEqual(s.statusCode, 404);
});
test('the assistant answers "am I growing" from the same numbers', async () => {
    GEMINI.script = [
        { parts: [{ functionCall: { name: 'get_daily_growth', args: {} } }] },
        { parts: [{ text: 'Yes — 240 more followers than a week ago, and reach is up a fifth.' }] }
    ];
    GEMINI.requests.length = 0;
    const r = await call('POST', '/api/assistant/ask', { token: 't-client', body: { message: 'Am I growing?' } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.used, ['get_daily_growth']);
    const fr = GEMINI.requests[1].contents.flatMap(c => c.parts || []).find(p => p.functionResponse);
    assert.ok(fr, 'no tool result went back to the model');
    const res = fr.functionResponse.response.result;
    assert.strictEqual(res.followers.now, 9240);
    assert.strictEqual(res.followers.week, 240);
    assert.strictEqual(res.reach.kind, 'up');
    assert.ok(/240/.test(r.body.answer));
});
test('the hourly pass reads only what is due', async () => {
    const before = state.moConn.daily_synced_at;
    await S.metaDailyTick();
    assert.strictEqual(state.moConn.daily_synced_at, before, 'just read — it must not be read again');
    state.moConn.daily_synced_at = new Date(Date.now() - 26 * 3600000).toISOString();
    const t = await S.metaDailyTick();
    assert.ok(t.due >= 1 && t.synced >= 1, JSON.stringify(t));
    assert.ok(Date.now() - Date.parse(state.moConn.daily_synced_at) < 60000, 'the due connection should have been read');
});
test('a refused token marks the connection expired and never throws', async () => {
    GRAPH.fail = { status: 401 };
    const r = await S.metaDailySync(state.moConn, { days: 1 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.expired, true);
    assert.strictEqual(state.moConn.status, 'expired');
    assert.ok(/access token/i.test(state.moConn.daily_error || ''), state.moConn.daily_error);
    GRAPH.fail = null; GRAPH.daily = null; GRAPH.igFollowers = null;
    state.moConn.status = 'active'; state.moConn.daily_error = null;
});

// ===========================================================================
// PHASE 31 — the Owner Assistant is XpulseAI's, copied in whole; EdgeLead's
// connection feeds it. What is tested is the seam: provisioning, access,
// and that the answer really comes from XpulseAI's chat.
// ===========================================================================
const xp = require(path.join(__dirname, '..', 'xp'));
const xpSec = require(path.join(__dirname, '..', 'xp', 'security'));
section('\nthe Owner Assistant (XpulseAI) reads the connection the agency made');
test('provisioning turns the client and its connection into an XpulseAI client, a Page asset and an Instagram asset', async () => {
    const r = await xp.provisionClient(state.C);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.connections, 1);
    assert.strictEqual(r.assets, 2);
    const xc = tbl('xp_clients').find(x => x.id === state.C);
    assert.ok(xc, 'no xp_clients row');
    assert.strictEqual(xc.client_name, 'Harbor Cafe');
    assert.strictEqual(xc.is_active, true);
    assert.strictEqual(xc.timezone, xp.cfg.defaultClientTz);
    const conn = tbl('xp_meta_connections').find(x => x.el_connection_id === state.moConn.id);
    assert.ok(conn, 'the connection was not carried across');
    assert.notStrictEqual(conn.token_enc, 'plain-page-token', 'the token must be sealed with the assistant\'s key');
    assert.strictEqual(xpSec.decrypt(conn.token_enc), 'plain-page-token');
    const fb = tbl('xp_meta_assets').find(x => x.client_id === state.C && x.platform === 'FB');
    const ig = tbl('xp_meta_assets').find(x => x.client_id === state.C && x.platform === 'IG');
    assert.ok(fb && fb.asset_id === GRAPH.PAGE, 'no Page asset');
    assert.strictEqual(xpSec.decrypt(fb.access_token_enc), 'plain-page-token');
    assert.ok(ig && ig.asset_id === GRAPH.IG, 'no Instagram asset');
    assert.strictEqual(ig.username, 'harborcafe');
    assert.strictEqual(ig.linked_asset_id, fb.id, 'the Instagram asset hangs off the Page');
});
test('provisioning again changes nothing: one connection, two assets', async () => {
    const r = await xp.provisionClient(state.C);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(tbl('xp_meta_connections').filter(x => x.client_id === state.C).length, 1);
    assert.strictEqual(tbl('xp_meta_assets').filter(x => x.client_id === state.C).length, 2);
});
// Phase 47: reads are started by the server, not by a button. The tests have no Graph behind the
// warehouse sync, so a recorder stands in for it and says what would have been read, and why.
const XPREAD = { calls: [], ads: 0, hold: 30 };
xp._setHooks({
    sync: (clientId, opts) => { XPREAD.calls.push({ clientId, ...opts }); return new Promise(r => setTimeout(() => r({ client: 'x', status: 'OK' }), XPREAD.hold)); },
    ads: () => { XPREAD.ads += 1; return Promise.resolve({}); }
});
const XPREAD_SYNC = (clientId, opts) => { XPREAD.calls.push({ clientId, ...opts }); return new Promise(r => setTimeout(() => r({ client: 'x', status: 'OK' }), XPREAD.hold)); };
const xpSettle = (ms = 80) => new Promise(r => setTimeout(r, ms));
test('the client sees what the warehouse holds for it; a stranger sees nothing', async () => {
    const r = await call('GET', '/api/xp/status', { token: 't-client' });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.provisioned, true);
    assert.strictEqual(r.body.assets.length, 2);
    // Nothing read yet, so opening the page started the first read: no button to find.
    assert.strictEqual(r.body.phase, 'reading');
    assert.strictEqual(r.body.running, true, 'the first read starts on its own');
    assert.strictEqual(XPREAD.calls.length, 1);
    assert.strictEqual(XPREAD.calls[0].clientId, state.C);
    assert.strictEqual(XPREAD.calls[0].runType, 'BACKFILL');
    await xpSettle();
    assert.strictEqual(XPREAD.ads, 1, 'the ads pass follows a first read');
    const again = await call('GET', '/api/xp/status', { token: 't-client' });
    assert.strictEqual(again.body.running, false);
    assert.strictEqual(XPREAD.calls.length, 1, 'a read that found nothing is not restarted on every poll');
    assert.strictEqual(r.body.schedule.cron, '0 9,21 * * *');
    assert.strictEqual(r.body.model, undefined, "an owner was told which AI model runs the chat (phase 57)");
    const s = await call('GET', '/api/xp/status', { token: 't-stranger', query: { client_id: state.C } });
    assert.strictEqual(s.statusCode, 403, JSON.stringify(s.body));
});

section('\nphase 47: Meta connected, the assistant reads by itself; the team sees who needs them');
test('the phase says where a business stands, in one word the pages switch on', () => {
    const cov = n => ({ assets: [{ account_days: n, post_days: n }] });
    assert.strictEqual(xp.phaseOf({ provisioned: false, assets: [] }), 'not_connected');
    assert.strictEqual(xp.phaseOf({ provisioned: true, assets: [{ status: 'REMOVED' }] }), 'not_connected');
    assert.strictEqual(xp.phaseOf({ provisioned: true, assets: [{ status: 'ACTIVE' }], coverage: cov(0) }), 'reading');
    assert.strictEqual(xp.phaseOf({ provisioned: true, assets: [{ status: 'ACTIVE' }], coverage: cov(12) }), 'ready');
    assert.strictEqual(xp.phaseOf({ provisioned: true, client: { token_status: 'EXPIRED' }, assets: [{ status: 'ACTIVE' }], coverage: cov(12) }), 'reconnect');
    assert.strictEqual(xp.phaseOf({ provisioned: true, assets: [{ status: 'EXPIRED' }], coverage: cov(0) }), 'reconnect');
});
test('filing a Page under a client starts its first read at once', async () => {
    XPREAD.calls.length = 0;
    const r = await call('PATCH', `/api/meta/connections/${state.moConn.id}`, { token: 't-emp', body: { clientId: state.C } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    await xpSettle();
    assert.ok(XPREAD.calls.some(c => c.clientId === state.C && c.runType === 'BACKFILL' && c.triggeredBy === 'filed'), JSON.stringify(XPREAD.calls));
});
test('an owner reads the normal way only; re-reading history or chosen days is the team\'s', async () => {
    XPREAD.calls.length = 0;
    const own = await call('POST', '/api/xp/sync', { token: 't-client', body: { fullBackfill: true, rangeStart: '2026-01-01', rangeEnd: '2026-01-31' } });
    assert.strictEqual(own.statusCode, 202, JSON.stringify(own.body));
    assert.strictEqual(own.body.runType, 'MANUAL');
    assert.ok(!XPREAD.calls[0].fullBackfill && !XPREAD.calls[0].rangeStart, 'an owner cannot re-read the history');
    await xpSettle();
    const full = await call('POST', '/api/xp/sync', { token: 't-emp', body: { clientId: state.C, fullBackfill: true } });
    assert.strictEqual(full.statusCode, 202, JSON.stringify(full.body));
    assert.strictEqual(full.body.runType, 'BACKFILL');
    assert.strictEqual(XPREAD.calls[1].fullBackfill, true);
    const busy = await call('POST', '/api/xp/sync', { token: 't-emp', body: { clientId: state.C } });
    assert.strictEqual(busy.statusCode, 409, 'one read per business at a time');
    await xpSettle();
    // Three reads a minute per person, so the ranges are checked directly and one bad one through the route.
    for (const [a, b] of [['2026-02-10', '2026-02-01'], ['2026-01-01', '2026-06-30'], ['nope', '2026-01-02'], ['2099-01-01', '2099-01-02'], ['2026-02-30', '2026-03-01']]) {
        assert.ok(xp.rangeError(a, b), `${a}..${b} should be refused`);
    }
    assert.strictEqual(xp.rangeError('2026-08-01', '2026-08-31'), null);
    const bad = await call('POST', '/api/xp/sync', { token: 't-admin', body: { clientId: state.C, rangeStart: '2026-02-10', rangeEnd: '2026-02-01' } });
    assert.strictEqual(bad.statusCode, 400, JSON.stringify(bad.body));
    const ok = await call('POST', '/api/xp/sync', { token: 't-admin', body: { clientId: state.C, rangeStart: '2026-08-01', rangeEnd: '2026-08-31' } });
    assert.strictEqual(ok.statusCode, 202, JSON.stringify(ok.body));
    assert.strictEqual(XPREAD.calls[XPREAD.calls.length - 1].rangeStart, '2026-08-01');
    await xpSettle();
    const stranger = await call('POST', '/api/xp/sync', { token: 't-stranger', body: { clientId: state.C, fullBackfill: true } });
    assert.strictEqual(stranger.statusCode, 403);
});
test('the admin sees every business with Meta, with its verdict, its owner login and what to do', async () => {
    const no = await call('GET', '/api/xp/admin/overview', { token: 't-emp' });
    assert.strictEqual(no.statusCode, 403, 'admins only');
    const r = await call('GET', '/api/xp/admin/overview', { token: 't-admin' });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    const row = r.body.rows.find(x => x.clientId === state.C);
    assert.ok(row, 'Harbor Cafe is on the list');
    assert.strictEqual(row.name, 'Harbor Cafe');
    assert.strictEqual(row.assets.length, 2);
    assert.ok(row.connections.some(c => c.page === 'Harbor Cafe' && c.instagram === 'harborcafe'));
    assert.ok(row.owners.some(o => o.email === CLIENT.email), 'the owner\'s portal login is shown: ' + JSON.stringify(row.owners));
    assert.ok(row.issues.some(i => i.code === 'history'), 'history not read yet is flagged: ' + JSON.stringify(row.issues));
    assert.ok(['warn', 'bad'].includes(row.verdict));
    assert.strictEqual(r.body.totals.businesses, r.body.rows.length);
    assert.strictEqual(r.body.schedule.cron, '0 9,21 * * *');
    // A business whose history is read, recently, with no gaps and an owner is simply fine.
    const now = new Date().toISOString();
    tbl('xp_meta_assets').filter(a => a.client_id === state.C).forEach(a => { a.last_full_backfill_at = now; a.last_synced_at = now; });
    const xc = tbl('xp_clients').find(x => x.id === state.C); const was = xc.last_synced_at; xc.last_synced_at = now;
    const conn = tbl('meta_connections').find(c => c.id === state.moConn.id); const exp = conn.token_expires_at; conn.token_expires_at = new Date(Date.now() + 50 * 86400000).toISOString();
    const r2 = await call('GET', '/api/xp/admin/overview', { token: 't-admin' });
    const row2 = r2.body.rows.find(x => x.clientId === state.C);
    assert.strictEqual(row2.verdict, 'ok', JSON.stringify(row2.issues));
    // Meta access about to end is said before it happens.
    conn.token_expires_at = new Date(Date.now() + 3 * 86400000).toISOString();
    const r3 = await call('GET', '/api/xp/admin/overview', { token: 't-admin' });
    assert.ok(r3.body.rows.find(x => x.clientId === state.C).issues.some(i => i.code === 'expiring'));
    tbl('xp_meta_assets').filter(a => a.client_id === state.C).forEach(a => { a.last_full_backfill_at = null; a.last_synced_at = null; });
    xc.last_synced_at = was; conn.token_expires_at = exp;
});
test('after a restart, a business connected but never read is started, once', async () => {
    XPREAD.calls.length = 0;
    xp._setHooks({ sync: XPREAD_SYNC, ads: () => Promise.resolve({}) });
    const out = await xp.catchUp();
    assert.ok(out.some(x => x.clientId === state.C && x.started), JSON.stringify(out));
    await xpSettle();
    const again = await xp.catchUp();
    assert.ok(!again.some(x => x.started), 'the cooldown holds: ' + JSON.stringify(again));
});

section('\nthe Owner Assistant answers, XpulseAI\'s way');
test('a client asking is answered by XpulseAI\'s Owner Assistant, scoped to its own business', async () => {
    XP.script = [{ parts: [{ text: 'Reach is up this week.' }] }];
    XP.requests.length = 0;
    const r = await call('POST', '/api/xp/chat', { token: 't-client', body: { message: 'How is my reach this week?' } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.reply, 'Reach is up this week.');
    assert.ok(r.body.conversationId, 'no conversation id');
    const req = XP.requests[0];
    assert.strictEqual(req.model, xp.cfg.gemini.model);
    const sys = String(req.config.systemInstruction);
    assert.ok(/You are Owner Assistant, powered by XPulse\.inc/.test(sys), 'XpulseAI\'s own persona: ' + sys.slice(0, 200));
    assert.ok(sys.includes('"Harbor Cafe"'), 'the prompt names the business');
    assert.strictEqual(req.contents[req.contents.length - 1].parts[0].text, 'How is my reach this week?');
    const decls = req.config.tools[0].functionDeclarations.map(d => d.name);
    assert.ok(decls.includes('get_period_summary') && decls.includes('get_daily_series') && decls.includes('get_coverage'), decls.join(','));
    assert.ok(!decls.includes('get_ad_performance'), 'the ads tool is offered only when ads are asked about');
    assert.ok(decls.includes('get_agency_work'), 'phase 49: the agency\'s work is a tool');
    assert.strictEqual(decls.length, 18, 'XpulseAI\'s tools, less the two gated ones, plus the agency\'s work: ' + decls.join(','));
    const conv = tbl('xp_ai_conversations').find(c => c.id === r.body.conversationId);
    assert.ok(conv && conv.client_id === state.C, 'the thread is filed under the business');
    assert.deepStrictEqual(tbl('xp_ai_messages').filter(m => m.conversation_id === conv.id).map(m => m.role), ['user', 'assistant']);
    state.xpConv = conv.id;
});
test('a tool round trip: the model asks for the daily series, the warehouse answers, a figure panel comes back', async () => {
    const start = dd(-7), end = dd(-1);
    for (let i = 7; i >= 1; i--) {
        tbl('xp_v_client_day_summary').push({ client_id: state.C, platform: 'IG', day: dd(-i), posts_published: i === 3 ? 1 : 0,
            followers_total: 9240 - i, account_reach: 1000 + i * 50, account_views: 3000 + i * 10, profile_views: 40, engagements: 70, is_final: i > 2 });
    }
    XP.script = [
        { parts: [{ functionCall: { name: 'get_daily_series', args: { start, end } }, thoughtSignature: 'sig-1' }] },
        { parts: [{ text: 'Your best day for reach was a week ago.' }] }
    ];
    XP.requests.length = 0;
    const r = await call('POST', '/api/xp/chat', { token: 't-client', body: { message: 'Which day had the most reach?', conversationId: state.xpConv } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.strictEqual(XP.requests.length, 2, 'one tool round, then the answer');
    const echoed = XP.requests[1].contents.find(c => c.role === 'model' && c.parts.some(p => p.functionCall));
    assert.ok(echoed && echoed.parts[0].thoughtSignature === 'sig-1', 'the model\'s own turn goes back with its thought signature');
    const fr = XP.requests[1].contents.flatMap(c => c.parts || []).find(p => p.functionResponse);
    assert.ok(fr, 'no tool result went back to the model');
    assert.strictEqual(fr.functionResponse.name, 'get_daily_series');
    assert.strictEqual(fr.functionResponse.response.result.length, 7);
    assert.strictEqual(fr.functionResponse.response.result[0].account_reach, 1350, 'the rows come back oldest first');
    assert.deepStrictEqual(r.body.toolCalls.map(t => t.name), ['get_daily_series']);
    assert.strictEqual(r.body.charts.length, 1, JSON.stringify(r.body.charts));
    const panel = r.body.charts[0];
    assert.strictEqual(panel.kind, 'chart');
    assert.strictEqual(panel.title, 'Day by day');
    assert.strictEqual(panel.sections[0].series[0].label, 'Reach', 'the question named reach, so the chart opens on it');
    assert.strictEqual(panel.sections[0].faded.filter(Boolean).length, 2, 'the two days Meta is still counting are drawn lighter');
    assert.ok(Array.isArray(r.body.suggestions));
    const saved = tbl('xp_ai_messages').filter(m => m.conversation_id === state.xpConv && m.role === 'assistant').pop();
    assert.deepStrictEqual(saved.tool_calls, [{ name: 'get_daily_series', args: { start, end } }]);
    assert.strictEqual(saved.tool_results[0].result.length, 7, 'the tool results are kept with the answer, so the panel can be rebuilt');
});
test('the streamed answer arrives as events: status while a tool runs, text as it comes, then done', async () => {
    XP.script = [
        { parts: [{ functionCall: { name: 'get_daily_series', args: { start: dd(-7), end: dd(-1) } } }] },
        { parts: [{ text: 'Reach held ' }, { text: 'steady all week.' }] }
    ];
    const r = await call('POST', '/api/xp/chat/stream', { token: 't-client', body: { message: 'And views?', conversationId: state.xpConv } });
    assert.strictEqual(r.statusCode, 200);
    assert.ok(/text\/event-stream/.test(r.headers['Content-Type']), JSON.stringify(r.headers));
    const events = r.writes.join('').split('\n\n').filter(f => f.startsWith('event: ')).map(f => {
        const [e, d] = f.split('\n');
        return { type: e.slice(7), data: JSON.parse(d.slice(6)) };
    });
    const types = events.map(e => e.type);
    assert.ok(types.includes('status'), 'no status event while the tool ran: ' + types.join(','));
    assert.strictEqual(events.filter(e => e.type === 'delta').map(e => e.data.text).join(''), 'Reach held steady all week.');
    const done = events.find(e => e.type === 'done');
    assert.ok(done, 'no done event: ' + types.join(','));
    assert.strictEqual(done.data.conversationId, state.xpConv);
    assert.strictEqual(done.data.reply, 'Reach held steady all week.');
    assert.strictEqual(done.data.charts.length, 1);
    assert.ok(r.writableEnded, 'the stream must be closed when the answer is done');
});
test('the client\'s threads are its own: listed, opened with the panels rebuilt, renamed, deleted', async () => {
    const list = await call('GET', `/api/xp/chat/${state.C}/conversations`, { token: 't-client' });
    assert.strictEqual(list.statusCode, 200, JSON.stringify(list.body));
    assert.ok(list.body.conversations.some(c => c.id === state.xpConv), 'the thread is not listed');
    const one = await call('GET', `/api/xp/chat/${state.C}/conversations/${state.xpConv}`, { token: 't-client' });
    assert.strictEqual(one.statusCode, 200, JSON.stringify(one.body));
    assert.strictEqual(one.body.messages.length, 6, 'three questions, three answers');
    const withChart = one.body.messages.filter(m => m.role === 'assistant' && m.charts.length);
    assert.strictEqual(withChart.length, 2, 'the two answers that read the daily series get their panel back');
    assert.strictEqual(withChart[0].charts[0].title, 'Day by day');
    const ren = await call('PATCH', `/api/xp/chat/${state.C}/conversations/${state.xpConv}`, { token: 't-client', body: { title: '  Reach\u0000 this week  ' } });
    assert.strictEqual(ren.statusCode, 200, JSON.stringify(ren.body));
    assert.strictEqual(ren.body.title, 'Reach this week');
    const del = await call('DELETE', `/api/xp/chat/${state.C}/conversations/${state.xpConv}`, { token: 't-client' });
    assert.strictEqual(del.statusCode, 200, JSON.stringify(del.body));
    const after = await call('GET', `/api/xp/chat/${state.C}/conversations`, { token: 't-client' });
    assert.ok(!after.body.conversations.some(c => c.id === state.xpConv), 'a deleted thread must not be listed');
    const gone = await call('GET', `/api/xp/chat/${state.C}/conversations/${state.xpConv}`, { token: 't-client' });
    assert.strictEqual(gone.statusCode, 404);
    const left = tbl('xp_ai_messages').filter(m => m.conversation_id === state.xpConv);
    assert.ok(left.length, 'the bare rows stay: the daily limit and cost figures count them');
    assert.ok(left.every(m => m.content == null && m.tool_calls == null && m.tool_results == null), 'a deleted chat kept its words or its data');
    assert.strictEqual(tbl('xp_ai_conversations').find(c => c.id === state.xpConv).title, null, 'a deleted chat kept its title');
});

test('phase 49: asked about the agency, the assistant reads only what is shared with the owner', async () => {
    const chatMod = require(path.join(__dirname, '..', 'xp', 'ai', 'chat'));
    const now = new Date().toISOString();
    tbl('client_tasks').push(
        { id: crypto.randomUUID(), client_id: state.C, title: 'Shared: new menu photos', status: 'doing', priority: 'high', visible_to_client: true, assigned_to_client: false, notes: 'see ![image](media:11111111-2222-4333-8444-555555555555)', created_at: now, updated_at: now },
        { id: crypto.randomUUID(), client_id: state.C, title: 'Your to-do: send the logo', status: 'todo', visible_to_client: true, assigned_to_client: true, created_at: now, updated_at: now },
        { id: crypto.randomUUID(), client_id: state.C, title: 'INTERNAL: chase the invoice', status: 'todo', visible_to_client: false, assigned_to_client: false, created_at: now, updated_at: now });
    const out = await chatMod.TOOLS.get_agency_work.run({ id: state.C });
    const titles = JSON.stringify(out);
    assert.ok(/Shared: new menu photos/.test(titles) && /send the logo/.test(titles), titles);
    assert.ok(!/INTERNAL/.test(titles), 'a task not shared with the owner reached the assistant');
    assert.ok(out.your_todos.some(t => t.title === 'Your to-do: send the logo'));
    assert.ok(out.agency_working_on.some(t => t.title === 'Shared: new menu photos' && t.state === 'in progress' && t.priority === 'high'));
});

section('\nthe walls hold around the Owner Assistant');
test('a stranger is refused, another business\'s threads are not there, staff on the client may read', async () => {
    const s = await call('GET', `/api/xp/chat/${state.C}/conversations`, { token: 't-stranger' });
    assert.strictEqual(s.statusCode, 403, JSON.stringify(s.body));
    const other = await call('GET', `/api/xp/chat/${state.D}/conversations`, { token: 't-client' });
    assert.strictEqual(other.statusCode, 404, 'a client asking about a business that is not its own');
    const staff = await call('GET', `/api/xp/chat/${state.C}/conversations`, { token: 't-emp' });
    assert.strictEqual(staff.statusCode, 200, JSON.stringify(staff.body));
    const ask = await call('POST', '/api/xp/chat', { token: 't-stranger', body: { message: 'Hi', clientId: state.C } });
    assert.strictEqual(ask.statusCode, 403);
    const long = await call('POST', '/api/xp/chat', { token: 't-client', body: { message: 'x'.repeat(2001) } });
    assert.strictEqual(long.statusCode, 400, JSON.stringify(long.body));
});
test('a business with no Meta connection is answered without numbers, and has nothing to read', async () => {
    // Phase 50: the chat works before Meta, but only the agency's work is offered — never a numbers tool.
    XP.script = [{ parts: [{ text: 'Connect Facebook and Instagram and I can answer that.' }] }];
    XP.requests.length = 0;
    const r = await call('POST', '/api/xp/chat', { token: 't-emp', body: { message: 'How is my reach?', clientId: state.D } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(XP.requests[0].config.tools[0].functionDeclarations.map(d => d.name), ['get_agency_work']);
    XP.script.length = 0;
    const s = await call('POST', '/api/xp/sync', { token: 't-emp', body: { clientId: state.D } });
    assert.strictEqual(s.statusCode, 409, JSON.stringify(s.body));
    const st = await call('POST', '/api/xp/sync', { token: 't-stranger', body: { clientId: state.C } });
    assert.strictEqual(st.statusCode, 403);
});
test('the admin sees every asset\'s health and the last runs; an employee does not', async () => {
    const r = await call('GET', '/api/xp/admin/health', { token: 't-admin' });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.ok(r.body.clients.some(c => c.id === state.C), 'the provisioned client is missing');
    assert.strictEqual(r.body.schedule.cron, '0 9,21 * * *');
    const e = await call('GET', '/api/xp/admin/health', { token: 't-emp' });
    assert.strictEqual(e.statusCode, 403);
});

// ===========================================================================
// PHASE 32 — every client has a task board, and the owner a way in
// ===========================================================================
section('\nphase 32: the client\'s task board');
test('a new client\'s board is empty, and lists who can be given work — never a client login', async () => {
    const r = await call('POST', '/api/clients', { token: 't-admin', body: { name: 'Kite Surf School' } });
    assert.strictEqual(r.statusCode, 201, JSON.stringify(r.body));
    state.T = r.body.client.id;
    assert.strictEqual((await call('POST', `/api/clients/${state.T}/members`, { token: 't-admin', body: { email: EMP.email, role: 'editor' } })).statusCode, 200);
    assert.strictEqual((await call('POST', `/api/clients/${state.T}/members`, { token: 't-admin', body: { email: EMP2.email, role: 'viewer' } })).statusCode, 200);
    const b = await call('GET', `/api/clients/${state.T}/tasks`, { token: 't-emp' });
    assert.strictEqual(b.statusCode, 200, JSON.stringify(b.body));
    assert.deepStrictEqual(b.body.tasks, []);
    assert.strictEqual(b.body.canEdit, true);
    assert.deepStrictEqual(b.body.statuses, ['todo', 'doing', 'waiting', 'done']);
    const ids = b.body.people.map(p => p.id);
    assert.ok(ids.includes(ADMIN.id) && ids.includes(EMP.id) && ids.includes(EMP2.id), JSON.stringify(b.body.people));
    assert.ok(!b.body.people.some(p => p.role === 'client'), 'a client login offered as a team assignee');
});
test('an editor adds a task, cleaned; a viewer sees it but cannot change it', async () => {
    const r = await call('POST', `/api/clients/${state.T}/tasks`, { token: 't-emp', body: {
        title: '  Film 2 Reels\u0000 at the   beach ', assignee: EMP.id, dueDate: '2026-10-02',
        labels: ['Content', 'content', 'Reels', ''], checklist: [{ text: 'Shot list' }, { text: '   ' }, { text: 'Edit', done: true }]
    } });
    assert.strictEqual(r.statusCode, 201, JSON.stringify(r.body));
    const t = r.body.task;
    assert.strictEqual(t.title, 'Film 2 Reels at the beach');
    assert.deepStrictEqual(t.labels, ['Content', 'Reels'], 'labels are de-duplicated without regard to case');
    assert.deepStrictEqual(t.checklist, [{ text: 'Shot list', done: false }, { text: 'Edit', done: true }]);
    assert.strictEqual(t.status, 'todo');
    assert.strictEqual(t.assignee.kind, 'person'); assert.strictEqual(t.assignee.id, EMP.id);
    assert.strictEqual(t.visibleToClient, false);
    state.task1 = t.id;
    const v = await call('GET', `/api/clients/${state.T}/tasks`, { token: 't-emp2' });
    assert.strictEqual(v.statusCode, 200);
    assert.strictEqual(v.body.canEdit, false, 'a viewer is told they cannot edit');
    assert.ok(v.body.tasks.some(x => x.id === state.task1), 'a viewer on the client cannot see its board');
    assert.strictEqual((await call('PATCH', `/api/tasks/${state.task1}`, { token: 't-emp2', body: { status: 'doing' } })).statusCode, 404);
    assert.strictEqual((await call('POST', `/api/clients/${state.T}/tasks`, { token: 't-emp2', body: { title: 'x' } })).statusCode, 404);
    assert.strictEqual((await call('DELETE', `/api/tasks/${state.task1}`, { token: 't-emp2' })).statusCode, 404);
});
test('a stranger sees nothing and changes nothing', async () => {
    assert.strictEqual((await call('GET', `/api/clients/${state.T}/tasks`, { token: 't-stranger' })).statusCode, 404);
    assert.strictEqual((await call('PATCH', `/api/tasks/${state.task1}`, { token: 't-stranger', body: { title: 'mine now' } })).statusCode, 404);
    assert.strictEqual((await call('GET', `/api/tasks/${state.task1}/comments`, { token: 't-stranger' })).statusCode, 404);
    assert.strictEqual((await call('POST', `/api/tasks/${state.task1}/comments`, { token: 't-stranger', body: { body: 'hi' } })).statusCode, 404);
    assert.strictEqual(tbl('client_tasks').find(x => x.id === state.task1).title, 'Film 2 Reels at the beach');
});
test('bad input is refused with the reason, and nothing is written', async () => {
    const before = tbl('client_tasks').length;
    const cases = [
        [{ title: '   ' }, /name/],
        [{ title: 'x', status: 'blocked' }, /Status/],
        [{ title: 'x', dueDate: '10/02/2026' }, /due date/i],
        [{ title: 'x', assignee: STRANGER.id }, /cannot open this client/],
        [{ title: 'x', assignee: CLIENT.id }, /cannot open this client/],
        [{ title: 'x', labels: 'Content' }, /list/]
    ];
    for (const [body, why] of cases) {
        const r = await call('POST', `/api/clients/${state.T}/tasks`, { token: 't-emp', body });
        assert.strictEqual(r.statusCode, 400, JSON.stringify(body) + ' → ' + JSON.stringify(r.body));
        assert.ok(why.test(r.body.error), r.body.error);
    }
    assert.strictEqual(tbl('client_tasks').length, before);
});
test('a card moved to Done is stamped and goes to the bottom of Done; moved back, the stamp goes', async () => {
    const a = await call('POST', `/api/clients/${state.T}/tasks`, { token: 't-emp', body: { title: 'Book the drone pilot', status: 'done' } });
    assert.strictEqual(a.statusCode, 201);
    assert.ok(a.body.task.completedAt, 'created in Done without a completion stamp');
    const r = await call('PATCH', `/api/tasks/${state.task1}`, { token: 't-emp', body: { status: 'done' } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.ok(r.body.task.completedAt);
    assert.ok(r.body.task.position > a.body.task.position, 'a card moved into a column goes below what is there');
    const back = await call('PATCH', `/api/tasks/${state.task1}`, { token: 't-emp', body: { status: 'doing' } });
    assert.strictEqual(back.body.task.completedAt, null);
    const ren = await call('PATCH', `/api/tasks/${state.task1}`, { token: 't-emp', body: { title: '' } });
    assert.strictEqual(ren.statusCode, 400, 'a task cannot be renamed to nothing');
});

section('\nphase 32: the owner\'s portal, opened by the agency');
test('only someone who can edit the client invites its owner; a team email is refused', async () => {
    // Phase 53: editors invite too. Someone who cannot edit this client cannot.
    const access = await call('GET', `/api/clients/${state.T}`, { token: 't-emp2' });
    if (access.statusCode !== 200 || !['owner', 'admin', 'editor'].includes(access.body.client.access)) {
        const e = await call('POST', `/api/clients/${state.T}/portal-invite`, { token: 't-emp2', body: { email: 'owner@kitesurf.test' } });
        assert.strictEqual(e.statusCode, 404, 'someone who cannot edit the client invited its owner');
    }
    const team = await call('POST', `/api/clients/${state.T}/portal-invite`, { token: 't-admin', body: { email: EMP.email } });
    assert.strictEqual(team.statusCode, 400);
    assert.ok(/team/.test(team.body.error), team.body.error);
    const bad = await call('POST', `/api/clients/${state.T}/portal-invite`, { token: 't-admin', body: { email: 'not-an-email' } });
    assert.strictEqual(bad.statusCode, 400);
});
test('with no mail set up, the admin gets a one-time link to pass on, and the owner lands in THIS business', async () => {
    MAIL.sent.length = 0;
    const r = await call('POST', `/api/clients/${state.T}/portal-invite`, { token: 't-admin', body: { email: 'Owner@KiteSurf.test', name: 'Lena Park' } });
    assert.strictEqual(r.statusCode, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.created, true);
    assert.strictEqual(r.body.emailed, false);
    // Phase 49: a one-tap sign-in straight into Edge Meta AI; no password is ever set.
    assert.ok(/type=magiclink|\/ai\/#th=/.test(r.body.link || ''), 'no link to pass on: ' + r.body.link);
    assert.ok(/\/ai\//.test(decodeURIComponent(r.body.link)) || !/redirect_to=http/.test(r.body.link), 'the link should land in the app');
    assert.strictEqual(MAIL.sent.length, 0);
    state.ownerT = r.body.owner.id;
    const row = tbl('app_users').find(u => u.id === state.ownerT);
    assert.strictEqual(row.role, 'client');
    assert.strictEqual(row.email, 'owner@kitesurf.test');
    assert.ok(row.trial_ends_at && Date.parse(row.trial_ends_at) > Date.now(), 'an invited owner must not start locked out');
    const me = await call('GET', '/api/me', { token: 't-owner@kitesurf.test' });
    assert.strictEqual(me.statusCode, 200, JSON.stringify(me.body));
    assert.strictEqual(me.body.role, 'client');
    assert.strictEqual(me.body.business.id, state.T, 'the owner landed in a business of their own instead of the agency\'s record');
    assert.ok(!tbl('clients').some(c => c.owner_user_id === state.ownerT && !c.archived), 'an empty duplicate record was made for the owner');
    const d = await call('GET', `/api/clients/${state.T}`, { token: 't-admin' });
    const m = d.body.members.find(x => x.user_id === state.ownerT);
    assert.ok(m && m.accountRole === 'client', 'the client page cannot tell the owner\'s login from the team');
});
test('an existing owner login is linked, but its password link is never handed to the inviter', async () => {
    // Anyone who owns a client could otherwise type another business owner's
    // address and take over their account with the link that came back.
    const SOLO = person('solo@shop.test'); TOKENS['t-solo'] = SOLO;
    const first = await call('GET', '/api/me', { token: 't-solo' });
    assert.strictEqual(first.body.role, 'client');
    const own = first.body.business.id;
    const r = await call('POST', `/api/clients/${state.D}/portal-invite`, { token: 't-emp', body: { email: 'solo@shop.test' } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.created, false);
    assert.strictEqual(r.body.emailed, false);
    assert.strictEqual(r.body.link, null, 'a password link for an existing login came back to the inviter');
    assert.ok(/already has a login/.test(r.body.note), r.body.note);
    assert.strictEqual(r.body.absorbed, own, 'the empty self-serve record should be absorbed');
    const me = await call('GET', '/api/me', { token: 't-solo' });
    assert.strictEqual(me.body.business.id, state.D, 'the owner\'s portal does not show the business that invited them');
});
test('a login that already belongs to another business is not taken, and the other one is not named', async () => {
    const before = tbl('client_members').length;
    const r = await call('POST', `/api/clients/${state.D}/portal-invite`, { token: 't-emp', body: { email: 'owner@kitesurf.test' } });
    assert.strictEqual(r.statusCode, 409, JSON.stringify(r.body));
    assert.ok(!/Kite Surf/.test(r.body.error), 'the refusal names another agency client');
    assert.strictEqual(tbl('client_members').length, before);
    assert.ok(!tbl('client_members').some(m => m.client_id === state.D && m.user_id === state.ownerT));
});
test('inviting again links the same login and, with Gmail set up, sends the link from the agency', async () => {
    const set = await call('PATCH', '/api/admin/settings', { token: 't-admin', body: { mail: { from: 'agency@gmail.com', appPassword: 'abcd efgh ijkl mnop', fromName: 'Harbor Agency' } } });
    assert.strictEqual(set.statusCode, 200, JSON.stringify(set.body));
    MAIL.sent.length = 0;
    const r = await call('POST', `/api/clients/${state.T}/portal-invite`, { token: 't-admin', body: { email: 'owner@kitesurf.test' } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.created, false, 'a second login was made for the same owner');
    assert.strictEqual(r.body.emailed, true);
    assert.strictEqual(r.body.link, null, 'a sent link must not also come back to the page');
    const m = MAIL.sent.find(x => x.msg.to === 'owner@kitesurf.test');
    assert.ok(m, 'no invite mail to the owner');
    assert.ok(/Kite Surf School/.test(m.msg.subject) && /type=magiclink|\/ai\/#th=/.test(m.msg.text) && /code we email you/.test(m.msg.text), m.msg.subject + ' / ' + m.msg.text);
    assert.strictEqual(tbl('app_users').filter(u => u.email === 'owner@kitesurf.test').length, 1);
    await call('PATCH', '/api/admin/settings', { token: 't-admin', body: { mail: { appPassword: '' } } });
});
test('phase 49: an owner signs in with an emailed code — invite-only, one use, five tries, no password', async () => {
    const off = await call('POST', '/api/public/owner-code', { body: { email: 'owner@kitesurf.test' } });
    assert.strictEqual(off.statusCode, 503, 'no mail, no codes: ' + JSON.stringify(off.body));
    assert.strictEqual(off.body.code, 'mail_off');
    await call('PATCH', '/api/admin/settings', { token: 't-admin', body: { mail: { from: 'agency@gmail.com', appPassword: 'abcd efgh ijkl mnop', fromName: 'Harbor Agency' } } });
    MAIL.sent.length = 0;
    // A stranger's address and a team member's get the same answer, and nothing is sent.
    for (const email of ['nobody@nowhere.test', EMP.email]) {
        const r = await call('POST', '/api/public/owner-code', { body: { email } });
        assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
        assert.ok(/If that email has a login/.test(r.body.note));
    }
    assert.strictEqual(MAIL.sent.length, 0, 'a code went to someone who is not an invited owner');
    const r = await call('POST', '/api/public/owner-code', { body: { email: 'Owner@KiteSurf.test' } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    const m = MAIL.sent.find(x => x.msg.to === 'owner@kitesurf.test');
    assert.ok(m, 'no code was emailed');
    const code = (/(\d{6})/.exec(m.msg.subject) || [])[1];
    assert.ok(code, m.msg.subject);
    const row = tbl('owner_login_codes').find(x => x.email === 'owner@kitesurf.test');
    assert.ok(row && !String(JSON.stringify(row)).includes(code), 'the code itself must never be stored');
    const again = await call('POST', '/api/public/owner-code', { body: { email: 'owner@kitesurf.test' } });
    assert.strictEqual(again.statusCode, 200);
    assert.strictEqual(tbl('owner_login_codes').filter(x => x.email === 'owner@kitesurf.test').length, 1, 'a second code within 45 seconds');
    const wrong = await call('POST', '/api/public/owner-verify', { body: { email: 'owner@kitesurf.test', code: code === '000000' ? '111111' : '000000' } });
    assert.strictEqual(wrong.statusCode, 400);
    assert.strictEqual(row.attempts, 1, 'a wrong try is counted');
    const ok = await call('POST', '/api/public/owner-verify', { body: { email: 'owner@kitesurf.test', code } });
    assert.strictEqual(ok.statusCode, 200, JSON.stringify(ok.body));
    assert.strictEqual(ok.body.tokenHash, 'hash-magiclink-owner@kitesurf.test', 'a one-time token for that login, exchanged by the page for a session');
    const reuse = await call('POST', '/api/public/owner-verify', { body: { email: 'owner@kitesurf.test', code } });
    assert.strictEqual(reuse.statusCode, 400, 'a code works once');
    // Five wrong tries end a code, even the right one after them.
    row.used_at = null; row.attempts = 5;
    const late = await call('POST', '/api/public/owner-verify', { body: { email: 'owner@kitesurf.test', code } });
    assert.strictEqual(late.statusCode, 400);
    // An expired code is refused.
    row.attempts = 0; row.expires_at = new Date(Date.now() - 1000).toISOString();
    assert.strictEqual((await call('POST', '/api/public/owner-verify', { body: { email: 'owner@kitesurf.test', code } })).statusCode, 400);
    await call('PATCH', '/api/admin/settings', { token: 't-admin', body: { mail: { appPassword: '' } } });
});
test('phase 50: without Meta, the owner still chats — about the agency\'s work only, and nothing is read for them', async () => {
    assert.ok(!tbl('meta_connections').some(c => c.client_id === state.T && c.status === 'active'), 'this business must have no Meta for the test');
    XP.script = [{ parts: [{ text: 'Your agency is filming three Reels this week.' }] }];
    XP.requests.length = 0;
    const r = await call('POST', '/api/xp/chat', { token: 't-owner@kitesurf.test', body: { message: 'What are you working on for us?' } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.reply, 'Your agency is filming three Reels this week.');
    const req = XP.requests[0];
    const decls = req.config.tools[0].functionDeclarations.map(d => d.name);
    assert.deepStrictEqual(decls, ['get_agency_work'], 'no Meta, no numbers tools: ' + decls.join(','));
    assert.ok(/has NOT connected its Facebook Page and Instagram/.test(String(req.config.systemInstruction)), 'the no-Meta instructions');
    const xc = tbl('xp_clients').find(x => x.id === state.T);
    assert.ok(xc && xc.is_active === false, 'a bare, inactive row: the twice-daily read never tries it');
    const ov = await call('GET', '/api/xp/admin/overview', { token: 't-admin' });
    assert.ok(!ov.body.rows.some(x => x.clientId === state.T), 'a chat-only business is not listed among the Meta connections');
    const st = await call('GET', '/api/xp/status', { token: 't-owner@kitesurf.test' });
    assert.strictEqual(st.body.phase, 'not_connected');
});
section('\nphase 51: the audit\'s security batch');
test('deleting a staff member hands their clients and work to the admin; nothing is lost', async () => {
    const leaver = person('leaver@agency.test'); TOKENS['t-leaver'] = leaver;
    tbl('app_users').push({ id: leaver.id, email: leaver.email, role: 'user', is_active: true });
    const cid = crypto.randomUUID(), now = new Date().toISOString();
    tbl('clients').push({ id: cid, owner_user_id: leaver.id, name: 'Leaver Co', archived: false, created_at: now });
    tbl('schedules').push({ id: crypto.randomUUID(), user_id: leaver.id, client_id: cid, active: true, created_at: now });
    tbl('meta_connections').push({ id: crypto.randomUUID(), user_id: leaver.id, client_id: cid, page_id: 'p-leaver', status: 'active', created_at: now });
    tbl('client_tasks').push({ id: crypto.randomUUID(), client_id: cid, title: 'Theirs', status: 'todo', assignee_user_id: leaver.id, created_at: now, updated_at: now });
    const emp = await call('DELETE', `/api/admin/users/${leaver.id}`, { token: 't-emp' });
    assert.notStrictEqual(emp.statusCode, 200, 'only an admin deletes people');
    const r = await call('DELETE', `/api/admin/users/${leaver.id}`, { token: 't-admin' });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.movedTo, ADMIN.id);
    assert.strictEqual(tbl('clients').find(c => c.id === cid).owner_user_id, ADMIN.id, 'the client went with them');
    assert.ok(tbl('schedules').some(x => x.client_id === cid && x.user_id === ADMIN.id), 'schedule not handed over');
    assert.ok(tbl('meta_connections').some(x => x.page_id === 'p-leaver' && x.user_id === ADMIN.id), 'Meta connection not handed over');
    assert.ok(tbl('client_tasks').some(x => x.title === 'Theirs' && x.assignee_user_id === ADMIN.id), 'task not reassigned');
    assert.ok(r.body.moved.clients >= 1);
});
test('an owner login cannot use the agency\'s routes, even on its own business', async () => {
    const own = state.C;
    for (const [m, path, body] of [
        ['GET', `/api/clients/${own}`], ['GET', `/api/clients/${own}/timeline`], ['PATCH', `/api/clients/${own}`, { notes: 'mine now', archived: true }],
        ['GET', '/api/clients'], ['POST', '/api/clients', { name: 'Sneaky' }], ['GET', `/api/clients/${own}/tasks`],
        ['POST', `/api/clients/${own}/members`, { email: EMP.email, role: 'editor' }]
    ]) {
        const r = await call(m, path, { token: 't-client', body });
        assert.ok([401, 403, 404].includes(r.statusCode), `${m} ${path} answered ${r.statusCode}: ${JSON.stringify(r.body).slice(0, 160)}`);
    }
    assert.notStrictEqual(tbl('clients').find(c => c.id === own).archived, true, 'the owner archived the record');
    // Their own surfaces still work.
    assert.strictEqual((await call('GET', '/api/client/tasks', { token: 't-client' })).statusCode, 200);
    assert.strictEqual((await call('GET', '/api/xp/status', { token: 't-client' })).statusCode, 200);
});
test('guesses sent at the same moment cannot share one count and get past five tries', async () => {
    const row = { id: crypto.randomUUID(), email: 'race@kitesurf.test', user_id: crypto.randomUUID(), code_hash: 'ab'.repeat(32), attempts: 4, expires_at: new Date(Date.now() + 600000).toISOString(), used_at: null, created_at: new Date().toISOString() };
    tbl('owner_login_codes').push(row);
    const tries = await Promise.all(['111111', '222222', '333333'].map((code, i) => call('POST', '/api/public/owner-verify', { body: { email: 'race@kitesurf.test', code }, ip: `10.0.0.${i + 1}` })));
    assert.ok(tries.every(t => [400, 429].includes(t.statusCode)), tries.map(t => t.statusCode).join(','));
    assert.ok(tries.some(t => t.statusCode === 400), 'at least one guess was weighed');
    assert.strictEqual(row.attempts, 5, 'only one of the simultaneous guesses was counted against the last try, and the rest were refused');
});
test('a paid portal is an admin\'s to give', async () => {
    const e = await call('POST', `/api/clients/${state.D}/portal-invite`, { token: 't-emp', body: { email: 'shop@bloom.test', paidUntil: '2027-01-31' } });
    assert.strictEqual(e.statusCode, 403, JSON.stringify(e.body));
    assert.ok(!TOKENS['t-shop@bloom.test'], 'a refused invite still made a login');
    const a = await call('POST', `/api/clients/${state.D}/portal-invite`, { token: 't-admin', body: { email: 'paid@bloom.test', paidUntil: '2027-01-31', planLabel: 'Growth' } });
    assert.strictEqual(a.statusCode, 201, JSON.stringify(a.body));
    const row = tbl('app_users').find(u => u.email === 'paid@bloom.test');
    assert.strictEqual(row.plan_label, 'Growth');
    assert.ok(String(row.paid_until).startsWith('2027-01-31'));
});

section('\nphase 32: what the owner sees of the board');
test('a task for the client is always shown to the client; internal work never is', async () => {
    const c = await call('POST', `/api/clients/${state.T}/tasks`, { token: 't-admin', body: { title: 'Send us your logo files', assignee: 'client', visibleToClient: false, dueDate: '2026-10-01' } });
    assert.strictEqual(c.statusCode, 201, JSON.stringify(c.body));
    assert.strictEqual(c.body.task.assignee.kind, 'client');
    assert.strictEqual(c.body.task.visibleToClient, true, 'the client\'s own to-do was hidden from the client');
    state.clientTask = c.body.task.id;
    const shown = await call('POST', `/api/clients/${state.T}/tasks`, { token: 't-emp', body: { title: 'Design the summer poster', assignee: EMP.id, visibleToClient: true } });
    state.shownTask = shown.body.task.id;
    const hidden = await call('POST', `/api/clients/${state.T}/tasks`, { token: 't-emp', body: { title: 'Chase the late invoice', notes: 'internal' } });
    state.hiddenTask = hidden.body.task.id;
    const off = await call('PATCH', `/api/tasks/${state.clientTask}`, { token: 't-admin', body: { visibleToClient: false } });
    assert.strictEqual(off.body.task.visibleToClient, true, 'the client\'s to-do can be hidden from them by a later edit');

    const o = await call('GET', '/api/client/tasks', { token: 't-owner@kitesurf.test' });
    assert.strictEqual(o.statusCode, 200, JSON.stringify(o.body));
    assert.strictEqual(o.body.business.id, state.T);
    const ids = o.body.tasks.map(t => t.id);
    assert.ok(ids.includes(state.clientTask) && ids.includes(state.shownTask), 'a shared task is missing from the portal');
    assert.ok(!ids.includes(state.hiddenTask) && !ids.includes(state.task1), 'internal work reached the owner\'s portal');
    const mine = o.body.tasks.find(t => t.id === state.clientTask);
    assert.strictEqual(mine.yours, true);
    const dump = JSON.stringify(o.body);
    assert.ok(!dump.includes(EMP.email) && !dump.includes(EMP.id) && !dump.includes('assignee') && !dump.includes('createdBy'), 'the portal list carries the team\'s identities: ' + dump);
});
test('the owner is refused the staff routes, and cannot touch anything but their own to-do', async () => {
    const tok = 't-owner@kitesurf.test';
    const b = await call('GET', `/api/clients/${state.T}/tasks`, { token: tok });
    assert.strictEqual(b.statusCode, 403); assert.strictEqual(b.body.code, 'client_surface');
    assert.strictEqual((await call('PATCH', `/api/tasks/${state.clientTask}`, { token: tok, body: { title: 'x' } })).statusCode, 403);
    assert.strictEqual((await call('POST', `/api/clients/${state.T}/tasks`, { token: tok, body: { title: 'x' } })).statusCode, 403);
    assert.strictEqual((await call('GET', '/api/my-tasks', { token: tok })).statusCode, 403);
    assert.strictEqual((await call('PATCH', `/api/client/tasks/${state.shownTask}`, { token: tok, body: { status: 'done' } })).statusCode, 404, 'shown is not theirs to tick');
    assert.strictEqual((await call('PATCH', `/api/client/tasks/${state.hiddenTask}`, { token: tok, body: { status: 'done' } })).statusCode, 404);
    assert.strictEqual((await call('PATCH', `/api/client/tasks/${state.clientTask}`, { token: tok, body: { status: 'waiting' } })).statusCode, 400);
    assert.strictEqual((await call('GET', '/api/client/tasks', { token: 't-emp' })).statusCode, 400, 'staff read the client\'s board, not the portal list');
});
test('the owner ticks off their to-do, and the team sees it done', async () => {
    const r = await call('PATCH', `/api/client/tasks/${state.clientTask}`, { token: 't-owner@kitesurf.test', body: { status: 'done' } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.task.status, 'done');
    const b = await call('GET', `/api/clients/${state.T}/tasks`, { token: 't-emp' });
    const t = b.body.tasks.find(x => x.id === state.clientTask);
    assert.strictEqual(t.status, 'done'); assert.ok(t.completedAt);
});
test('the team and the owner talk on a shared task; the owner never sees the team\'s addresses', async () => {
    assert.strictEqual((await call('POST', `/api/tasks/${state.clientTask}/comments`, { token: 't-emp', body: { body: 'Thanks, got the logos.' } })).statusCode, 201);
    assert.strictEqual((await call('POST', `/api/tasks/${state.clientTask}/comments`, { token: 't-owner@kitesurf.test', body: { body: 'Great!' } })).statusCode, 201);
    assert.strictEqual((await call('POST', `/api/tasks/${state.hiddenTask}/comments`, { token: 't-owner@kitesurf.test', body: { body: 'peek' } })).statusCode, 404);
    assert.strictEqual((await call('POST', `/api/tasks/${state.clientTask}/comments`, { token: 't-emp', body: { body: '   ' } })).statusCode, 400);
    assert.strictEqual((await call('POST', `/api/tasks/${state.clientTask}/comments`, { token: 't-emp', body: { body: 'x'.repeat(4001) } })).statusCode, 400);
    const o = await call('GET', `/api/tasks/${state.clientTask}/comments`, { token: 't-owner@kitesurf.test' });
    assert.strictEqual(o.statusCode, 200, JSON.stringify(o.body));
    assert.strictEqual(o.body.comments.length, 2);
    const [team, own] = o.body.comments;
    assert.strictEqual(team.author.kind, 'team'); assert.strictEqual(own.author.kind, 'client'); assert.strictEqual(own.mine, true);
    assert.ok(!JSON.stringify(o.body).includes(EMP.email), 'the owner was shown a team member\'s address');
    const s = await call('GET', `/api/tasks/${state.clientTask}/comments`, { token: 't-emp' });
    assert.strictEqual(s.body.comments[0].author.email, EMP.email, 'the team should see who said it');
    const b = await call('GET', `/api/clients/${state.T}/tasks`, { token: 't-emp2' });
    assert.strictEqual(b.body.tasks.find(x => x.id === state.clientTask).comments, 2);
});

section('\nphase 32: tasks from reports, My tasks, and the edges');
test('a recommendation is added to the board once, and only from work filed under this client', async () => {
    const rid = crypto.randomUUID();
    tbl('reports').push({ id: rid, user_id: ADMIN.id, client_id: state.T, report_type: 'meta_monthly', created_at: new Date().toISOString() });
    const body = { title: 'Post 2 Reels a week', source: { type: 'recommendation', id: rid, key: 'rec-2', label: 'Monthly report · Aug 2026' } };
    const a = await call('POST', `/api/clients/${state.T}/tasks`, { token: 't-emp', body });
    assert.strictEqual(a.statusCode, 201, JSON.stringify(a.body));
    assert.strictEqual(a.body.task.source.label, 'Monthly report · Aug 2026');
    const again = await call('POST', `/api/clients/${state.T}/tasks`, { token: 't-admin', body });
    assert.strictEqual(again.statusCode, 200);
    assert.strictEqual(again.body.existing, true);
    assert.strictEqual(again.body.task.id, a.body.task.id);
    const other = tbl('reports').find(r => r.client_id === state.C);
    const x = await call('POST', `/api/clients/${state.T}/tasks`, { token: 't-emp', body: { title: 'y', source: { type: 'report', id: other.id } } });
    assert.strictEqual(x.statusCode, 400, 'a task could point at another client\'s report');
});
test('My tasks: mine on every client, soonest first; a client I was taken off drops out', async () => {
    const d = await call('POST', `/api/clients/${state.D}/tasks`, { token: 't-emp', body: { title: 'Order the spring flyers', assignee: EMP.id, dueDate: '2026-09-30' } });
    assert.strictEqual(d.statusCode, 201, JSON.stringify(d.body));
    const r = await call('GET', '/api/my-tasks', { token: 't-emp' });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    const titles = r.body.tasks.map(t => t.title);
    assert.ok(titles.includes('Order the spring flyers') && titles.includes('Film 2 Reels at the beach'), titles.join(' | '));
    assert.strictEqual(r.body.tasks[0].title, 'Order the spring flyers', 'soonest due date should come first');
    assert.strictEqual(r.body.tasks[0].client.name, 'Bloom Florist');
    assert.ok(!titles.includes('Design the summer poster') || r.body.tasks.every(t => t.assignee && t.assignee.id === EMP.id));
    await call('DELETE', `/api/clients/${state.T}/members/${EMP.id}`, { token: 't-admin' });
    const after = await call('GET', '/api/my-tasks', { token: 't-emp' });
    assert.ok(!after.body.tasks.some(t => t.client.id === state.T), 'tasks on a client I can no longer open are still listed');
    await call('POST', `/api/clients/${state.T}/members`, { token: 't-admin', body: { email: EMP.email, role: 'editor' } });
});
test('an editor deletes a task; a merged client brings its board along', async () => {
    const del = await call('DELETE', `/api/tasks/${state.hiddenTask}`, { token: 't-emp' });
    assert.strictEqual(del.statusCode, 200, JSON.stringify(del.body));
    const b = await call('GET', `/api/clients/${state.T}/tasks`, { token: 't-emp' });
    assert.ok(!b.body.tasks.some(t => t.id === state.hiddenTask));
    const u = await call('POST', '/api/clients', { token: 't-admin', body: { name: 'Kite Surf School (dup)' } });
    const tu = await call('POST', `/api/clients/${u.body.client.id}/tasks`, { token: 't-admin', body: { title: 'Carried across' } });
    const dry = await call('POST', `/api/clients/${state.T}/merge`, { token: 't-admin', body: { fromId: u.body.client.id }, query: { dry: '1' } });
    assert.strictEqual(dry.body.counts.client_tasks, 1, JSON.stringify(dry.body.counts));
    const m = await call('POST', `/api/clients/${state.T}/merge`, { token: 't-admin', body: { fromId: u.body.client.id } });
    assert.strictEqual(m.statusCode, 200, JSON.stringify(m.body));
    assert.strictEqual(tbl('client_tasks').find(t => t.id === tu.body.task.id).client_id, state.T);
});
test('a monthly report is filed only under a client the caller may edit', async () => {
    // Before phase 32 any clientId in the body was trusted.
    const other = await call('POST', '/api/clients', { token: 't-admin', body: { name: 'Not on EMP\'s list' } });
    const before = tbl('jobs').length;
    const r = await call('POST', '/api/meta/monthly', { token: 't-emp', body: { connectionId: state.moConn.id, month: '2026-08', clientId: other.body.client.id } });
    assert.strictEqual(r.statusCode, 403, JSON.stringify(r.body));
    assert.ok(/edit access/.test(r.body.error), r.body.error);
    assert.strictEqual(tbl('jobs').length, before, 'a job was queued for a client the caller cannot edit');
});

section('\nphase 48: a task is an issue — key, priority, pictures in the description');
const PNG_1PX = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
test('a task has a priority, a key, and several labels of anyone\'s choosing', async () => {
    const bad = await call('POST', `/api/clients/${state.C}/tasks`, { token: 't-admin', body: { title: 'Wrong priority', priority: 'urgent' } });
    assert.strictEqual(bad.statusCode, 400, JSON.stringify(bad.body));
    const r = await call('POST', `/api/clients/${state.C}/tasks`, { token: 't-admin', body: { title: 'Fix the link in bio', priority: 'high', labels: ['Profile', 'Quick win', 'quick WIN', 'Setup'] } });
    assert.strictEqual(r.statusCode, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.task.priority, 'high');
    assert.deepStrictEqual(r.body.task.labels, ['Profile', 'Quick win', 'Setup'], 'custom labels, without repeats');
    state.t48 = r.body.task.id;
    const row = tbl('client_tasks').find(t => t.id === state.t48);
    row.task_number = 12;                                   // the database numbers it; the fake does not
    const one = await call('GET', `/api/tasks/${state.t48}`, { token: 't-admin' });
    assert.strictEqual(one.statusCode, 200, JSON.stringify(one.body));
    assert.strictEqual(one.body.task.key, 'HC-12', 'Harbor Cafe → HC, as on a Jira board');
    assert.strictEqual(one.body.task.reporter.email, ADMIN.email, 'who raised it');
    assert.strictEqual(one.body.canEdit, true);
    const upd = await call('PATCH', `/api/tasks/${state.t48}`, { token: 't-admin', body: { priority: 'lowest' } });
    assert.strictEqual(upd.body.task.priority, 'lowest');
    const board = await call('GET', `/api/clients/${state.C}/tasks`, { token: 't-admin' });
    assert.strictEqual(board.body.tasks.find(t => t.id === state.t48).key, 'HC-12', 'the card carries the key');
    const stranger = await call('GET', `/api/tasks/${state.t48}`, { token: 't-stranger' });
    assert.strictEqual(stranger.statusCode, 404);
    const owner = await call('GET', `/api/tasks/${state.t48}`, { token: 't-client' });
    assert.strictEqual(owner.statusCode, 403, 'the staff view is not the owner\'s');
});
test('a pasted picture is checked, kept private, and shown only through a signed link', async () => {
    const notImage = await call('POST', `/api/clients/${state.C}/task-media`, { token: 't-admin', body: Buffer.from('<script>alert(1)</script> padding padding') });
    assert.strictEqual(notImage.statusCode, 400, 'the bytes decide what it is, not the header');
    const stranger = await call('POST', `/api/clients/${state.C}/task-media`, { token: 't-stranger', body: PNG_1PX });
    assert.strictEqual(stranger.statusCode, 404);
    const up = await call('POST', `/api/clients/${state.C}/task-media`, { token: 't-admin', body: PNG_1PX });
    assert.strictEqual(up.statusCode, 201, JSON.stringify(up.body));
    assert.ok(/^!\[image\]\(media:[0-9a-f-]{36}\)$/.test(up.body.token), up.body.token);
    assert.ok(/\/object\/sign\/task-media\//.test(up.body.url), 'a signed link, never a public one: ' + up.body.url);
    assert.strictEqual(STORAGE.options['task-media'].public, false, 'the bucket is private');
    const media = tbl('client_task_media').find(m => m.id === up.body.id);
    assert.ok(media && media.client_id === state.C && media.task_id == null && media.content_type === 'image/png');
    // Saving the description ties the picture to the task, and opening the task hands back a link.
    const notes = `Before and after:\n${up.body.token}\nThe old link 404s.`;
    const r = await call('PATCH', `/api/tasks/${state.t48}`, { token: 't-admin', body: { notes } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.strictEqual(media.task_id, state.t48);
    const one = await call('GET', `/api/tasks/${state.t48}`, { token: 't-admin' });
    assert.strictEqual(one.body.task.notes, notes);
    assert.ok(one.body.media[up.body.id], 'the picture comes back as a link');
    // Another client's task cannot adopt this client's picture.
    const other = await call('POST', '/api/clients', { token: 't-admin', body: { name: 'Other Place' } });
    const ot = await call('POST', `/api/clients/${other.body.client.id}/tasks`, { token: 't-admin', body: { title: 'Steal it', notes: up.body.token } });
    assert.strictEqual(ot.statusCode, 201);
    assert.strictEqual(media.task_id, state.t48, 'still this client\'s');
    const theirs = await call('GET', `/api/tasks/${ot.body.task.id}`, { token: 't-admin' });
    assert.deepStrictEqual(theirs.body.media, {}, 'and no link to it from the other client');
});
test('pictures in comments, and the owner sees the pictures of a task shown to them', async () => {
    const up = await call('POST', `/api/clients/${state.C}/task-media`, { token: 't-admin', body: PNG_1PX });
    const c = await call('POST', `/api/tasks/${state.t48}/comments`, { token: 't-admin', body: { body: `Here it is now ${up.body.token}` } });
    assert.strictEqual(c.statusCode, 201, JSON.stringify(c.body));
    const list = await call('GET', `/api/tasks/${state.t48}/comments`, { token: 't-admin' });
    assert.ok(list.body.media[up.body.id], 'comment pictures come back as links');
    await call('PATCH', `/api/tasks/${state.t48}`, { token: 't-admin', body: { visibleToClient: true } });
    const own = await call('GET', '/api/client/tasks', { token: 't-client' });
    const mine = own.body.tasks.find(t => t.id === state.t48);
    assert.ok(mine, 'shown to the owner');
    assert.strictEqual(mine.priority, 'lowest');
    assert.ok(Object.keys(own.body.media || {}).length >= 1, 'with its pictures');
});
test('deleting a task deletes its pictures, files and all', async () => {
    const paths = tbl('client_task_media').filter(m => m.task_id === state.t48).map(m => m.path);
    assert.ok(paths.length >= 2);
    const r = await call('DELETE', `/api/tasks/${state.t48}`, { token: 't-admin' });
    assert.strictEqual(r.statusCode, 200);
    for (const p of paths) assert.ok(!STORAGE.files[`task-media/${p}`], 'file left behind: ' + p);
});

section('\nphase 33: Ask AI answers an admin about any client');
test('an admin asking about a client they were never added to is answered about that client', async () => {
    // Before phase 33 the assistant's scope counted only owned and member
    // clients, so an admin got their own data back under this client's name.
    assert.ok(!tbl('client_members').some(m => m.client_id === state.D && m.user_id === ADMIN.id), 'the admin should not be a member here');
    GEMINI.script = [{ parts: [{ text: 'Bloom Florist has nothing on file yet.' }] }];
    GEMINI.requests.length = 0;
    const r = await call('POST', '/api/assistant/ask', { token: 't-admin', body: { message: 'How is this client doing?', clientId: state.D } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.clientId, state.D, 'the admin was answered about something else');
    assert.ok(/Bloom Florist/.test(GEMINI.requests[0].systemInstruction.parts[0].text), 'the client is not named to the model');
});
test('…while a stranger naming the same client is answered only about their own data', async () => {
    GEMINI.script = [{ parts: [{ text: 'Nothing on file.' }] }];
    const r = await call('POST', '/api/assistant/ask', { token: 't-stranger', body: { message: 'Tell me about it', clientId: state.D } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.clientId, null, 'a stranger reached a client through the assistant');
});

section('\nphase 39 — the Facebook groups read as a document');
function fbRoom(name, extra = {}) {
    return { groupId: name.toLowerCase().replace(/\W/g, ''), name, memberCount: 18400, postsAnalyzed: 42, windowDays: 14, postsPerDay: 3, uniquePosters: 35, uniquePosterRatio: 0.83, medianComments: 7, adminShare: 4,
        promoAllowed: true, approvalRequired: false, roomValue: 64,
        roomValueBreakdown: { liveness: 0.2, conversation: 0.7, diversity: 0.83, demand: 0.6, permission: 1, confidence: 1, sampleSize: 42, lowConfidence: false, verdict: 'Worth working' },
        formats: [{ key: 'photo', posts: 20, avgIndex: 1.4 }, { key: 'link', posts: 6, avgIndex: 0.5 }], intents: [{ key: 'recommendation_request', posts: 9, avgIndex: 2.2 }], openings: [{ key: 'question', posts: 8, avgIndex: 1.6 }],
        heatmap: { cells: [{ dow: 5, hour: 20, posts: 4, avgIndex: 1.9 }], bestHours: [], bestDays: [] },
        topPosts: [{ excerpt: 'Anyone know a baker who does eggless birthday cakes near Gulshan?', intent: 'recommendation_request', reactions: 41, comments: 63, index: 3.4, postedAt: '2026-09-20T15:00:00Z', url: 'https://www.facebook.com/groups/x/posts/1' }, { excerpt: 'Selling my oven', reactions: 2, comments: 1, index: 0.3, url: 'https://evil.example/y' }],
        demandSignals: 12, demandRate: 28.6, demandCategories: [{ category: 'recommendation', count: 9 }, { category: 'price_inquiry', count: 3 }], demandKeywords: [{ term: 'eggless cake', hits: 5 }], ...extra };
}
test('a groups read becomes a document: groups ranked with our call, demand, what works, rules', async () => {
    const a = fbRoom('Gulshan Foodies'), b = fbRoom('Dhaka Home Bakers', { roomValue: 22, promoAllowed: false, approvalRequired: true, postsAnalyzed: 9, roomValueBreakdown: { lowConfidence: true, verdict: 'Not enough data' } });
    const benchmark = { rooms: 2, avgRoomValue: 43, bestRoom: { groupId: a.groupId, name: a.name }, formats: a.formats, intents: a.intents, openings: a.openings, demandKeywords: a.demandKeywords, demandCategories: [{ category: 'recommendation', count: 18 }, { category: 'price_inquiry', count: 6 }],
        ranked: [{ rank: 1, name: a.name, roomValue: 64, members: 18400, postsPerDay: 3, medianComments: 7, demandSignals: 12 }, { rank: 2, name: b.name, roomValue: 22, members: 18400, postsPerDay: 3, medianComments: 7, demandSignals: 12, lowConfidence: true }] };
    const row = { id: 'c', report_type: 'fb_community', created_at: '2026-09-28T10:00:00Z', niche: 'bakery', location_label: 'Dhaka',
        report_json: { mode: 'combined', groups: [a, b, fbRoom('Empty', { postsAnalyzed: 0 })], benchmark },
        ai_json: { executive_summary: 'Gulshan Foodies is where your buyers ask. Dhaka Home Bakers bans promotion.', room_verdicts: [{ group: 'Gulshan Foodies', verdict: 'work it', why: 'Asks every day' }, { group: 'Dhaka Home Bakers', verdict: 'skip it', why: 'Promotion banned' }],
            unmet_demand: ['Eggless cakes: asked 5 times, answered once'], what_works_here: ['Questions: 1.6× typical'], risks: ['Approval queue: posts wait a day'], lead_actions: ['Reply to cake requests within the hour'], posting_playbook: [{ room: 'Gulshan Foodies', format: 'photo', intent: 'question', best_time: 'Fri 8 pm', angle: 'Show the eggless range' }], next_30_days: [{ week: 'Week 1', actions: ['Join and read the rules'] }] } };
    const d = S.reportDoc(row);
    assert.strictEqual(d.type, 'fb_community');
    assert.strictEqual(d.cover.title, 'Bakery groups in Dhaka');
    assert.deepStrictEqual(d.cover.receipt[3], ['24', 'buying signals'], 'the empty group counts nothing');
    const titles = d.sections.map(x => x.title);
    for (const x of ['At a glance', 'Which groups are worth your time', 'What people are asking to buy', 'What gets a response here', 'Posts that did best', 'When and how to post', 'Group rules and risks', 'Turning this into customers']) assert.ok(titles.includes(x), 'missing ' + x + ': ' + titles.join(' | '));
    const rank = d.sections.find(x => x.title === 'Which groups are worth your time').blocks[0];
    assert.deepStrictEqual(rank.rows.map(r => r[6].chip), ['Work it', 'Skip it']);
    assert.deepStrictEqual(rank.rows[1][5], { text: '22*', tone: 'watch' }, 'a thin sample is marked');
    const cats = d.sections.find(x => x.title === 'What people are asking to buy').blocks[0].blocks[0];
    assert.deepStrictEqual(cats.rows.map(r => r.value), [75, 25]);
    const quotes = d.sections.find(x => x.title === 'Posts that did best').blocks[0].items;
    assert.strictEqual(quotes[0].link, 'https://www.facebook.com/groups/x/posts/1');
    assert.ok(quotes.every(q => q.link === null || /facebook\.com/.test(q.link)), 'a link off Facebook must not be shown');
    const rules = d.sections.find(x => x.title === 'Group rules and risks').blocks[0].rows;
    assert.deepStrictEqual(rules[1].slice(1), [{ chip: 'Banned', tone: 'bad' }, { chip: 'Admin approval', tone: 'watch' }]);
});
test('one group gets its own read: the score explained, no ranking table', async () => {
    const d = S.reportDoc({ id: 's', report_type: 'fb_group', created_at: '2026-09-28T10:00:00Z', report_json: { mode: 'individual', group: fbRoom('Gulshan Foodies') }, ai_json: null });
    assert.strictEqual(d.cover.title, 'Gulshan Foodies');
    const titles = d.sections.map(x => x.title);
    assert.ok(titles.includes('Is this group worth your time') && !titles.includes('Which groups are worth your time'), titles.join(' | '));
    assert.ok(!titles.includes('Group rules and risks'), 'no risks from the AI and one group: nothing to show');
    assert.strictEqual(S.reportDoc({ report_type: 'fb_group', report_json: { group: fbRoom('X', { postsAnalyzed: 0 }) } }), null, 'a group with no posts has no document');
});

section('\nphase 40 — who a lead is, and the pipeline');
const igPost = (owner, sc, caption, extra = {}) => ({ ownerUsername: owner, shortCode: sc, caption, likesCount: 120, commentsCount: 14, timestamp: '2026-09-20T12:00:00Z', url: `https://www.instagram.com/p/${sc}/`, ...extra });
test('a creator reviewing several places reads as an influencer, with the reasons', () => {
    const posts = [
        S.leadPostSignal(igPost('dhakafoodie', 'a1', 'Tried the smash burger here, honest review: 8/10 🍔', { locationId: 'L1', taggedUsers: [{ username: 'burgerhouse' }] }), 'm4', 'burgerhouse'),
        S.leadPostSignal(igPost('dhakafoodie', 'a2', 'খেয়ে দেখলাম, স্বাদ দারুণ। রিভিউ নিচে', { locationId: 'L2' }), 'm4', 'pizzaplace'),
        S.leadPostSignal(igPost('dhakafoodie', 'a3', 'Hidden gem in Banani, must try the ramen', { locationId: 'L3', isSponsored: true }), 'm3')
    ];
    const sig = S.leadSignalsAdd(null, posts);
    assert.strictEqual(sig.posts, 3);
    assert.deepStrictEqual(sig.venues.sort(), ['burgerhouse', 'pizzaplace']);
    const c = S.classifyLead({ username: 'dhakafoodie' }, sig);
    assert.strictEqual(c.kind, 'influencer', JSON.stringify(c));
    assert.strictEqual(c.stage, 'discovery');
    const said = c.reasons.map(r => r.text).join(' | ');
    assert.ok(/paid partnership/.test(said) && /2 different businesses/.test(said), said);
    const regular = S.classifyLead({ username: 'sam' }, S.leadSignalsAdd(null, [S.leadPostSignal(igPost('sam', 'r1', 'dinner with family'), 'm4', 'a'), S.leadPostSignal(igPost('sam', 'r2', 'lunch'), 'm4', 'b')]));
    assert.notStrictEqual(regular.kind, 'influencer', 'someone who just ate at two places was called an influencer');
    assert.ok(S.leadSignalsAdd(sig, posts).posts === 3, 'the same posts were counted twice');
});
test('a restaurant posting its own menu from its own place reads as a business', () => {
    const posts = ['Order now! Home delivery all over Dhaka', 'Our new menu is here, visit us today', 'Weekend offer: 20% off, call us to book']
        .map((cap, i) => S.leadPostSignal(igPost('burgerhouse_dhaka', 'b' + i, cap, { locationId: 'HOME' }), 'm3'));
    const c = S.classifyLead({ username: 'burgerhouse_dhaka' }, S.leadSignalsAdd(null, posts));
    assert.strictEqual(c.kind, 'business', JSON.stringify(c));
    assert.ok(c.reasons.some(r => /same place/.test(r.text)), 'the one-location rule did not fire');
});
test('the profile outweighs the posts, and an ordinary small account is “personal”', () => {
    const creator = S.classifyLead({ username: 'x', is_enriched: true, category: 'Digital creator', bio: 'Food reviews | 📩 for collabs', followers_count: 24000 }, null);
    assert.strictEqual(creator.kind, 'influencer'); assert.strictEqual(creator.stage, 'profile');
    const shop = S.classifyLead({ username: 'y', is_enriched: true, category: 'Restaurant', address: 'House 12, Road 5', followers_count: 3000 }, null);
    assert.strictEqual(shop.kind, 'business');
    const person = S.classifyLead({ username: 'z', is_enriched: true, followers_count: 312 }, null);
    assert.strictEqual(person.kind, 'personal');
});
test('fit: engagement is read against size, and bought-looking followers lose points', () => {
    const sig = { posts: 4, likes: 4 * 900, comments: 4 * 60, lastPostAt: new Date().toISOString(), venues: ['a', 'b'] };
    const good = S.leadFit({ followers_count: 20000, is_enriched: true, email: 'hi@x.test' }, sig, 'influencer', ['m3', 'm4', 'm1']);
    const fake = S.leadFit({ followers_count: 200000, is_enriched: true }, { ...sig, likes: 400, comments: 20 }, 'influencer', ['m3']);
    assert.ok(good.score >= 80, JSON.stringify(good));
    assert.ok(fake.reasons.some(r => /bought followers/.test(r.text)), JSON.stringify(fake));
    assert.ok(good.score > fake.score);
});

test('a real search run sorts what it finds: creators from two tagged tabs, the shop from the hashtag', async () => {
    process.env.APIFY_API_KEY = 'test-apify-key';
    APIFY.actors['apify/instagram-scraper'] = (input) => {
        const out = [];
        for (const u of input.directUrls || []) {
            if (/explore\/tags\/dhakafood/.test(u)) {
                out.push(igPost('burgerhouse_dhaka', 'h1', 'Order now! Home delivery all over Dhaka', { locationId: 'HOME' }),
                         igPost('burgerhouse_dhaka', 'h2', 'Our new menu is here, visit us today', { locationId: 'HOME' }),
                         igPost('burgerhouse_dhaka', 'h3', 'Call us to book a table this weekend', { locationId: 'HOME' }),
                         igPost('rafi.eats', 'h4', 'Tried the new ramen place, honest review 8/10', { locationId: 'L9' }));
            }
            const m = /instagram\.com\/([^/]+)\/tagged/.exec(u);
            if (m) {
                out.push(igPost('rafi.eats', 't-' + m[1], `Must try at @${m[1]}! My favourite burger in town`, { inputUrl: u, locationId: 'V-' + m[1] }),
                         igPost('happy_customer_22', 'c-' + m[1], 'dinner with family', { inputUrl: u, locationId: 'V-' + m[1] }));
            }
        }
        return out;
    };
    tbl('jobs').filter(j => j.user_id === EMP.id && ['queued', 'running'].includes(j.status)).forEach(j => { j.status = 'done'; });
    const r = await call('POST', '/api/run-campaign', { token: 't-emp', body: {
        clientId: state.C, campaignName: 'Dhaka food creators', selected_methods: ['method_3', 'method_4'],
        hashtags: ['dhakafood'], competitor_handles: ['@burgerhouse', '@pizzaplace'] } });
    assert.strictEqual(r.statusCode, 202, JSON.stringify(r.body));
    const job = await untilDone(r.body.jobId);
    assert.strictEqual(job.status, 'done', `${job.status}: ${job.error || ''}`);
    const lead = h => tbl('leads').find(l => l.username === h && l.owner_user_id === EMP.id);
    const rafi = lead('rafi.eats'), shop = lead('burgerhouse_dhaka'), cust = lead('happy_customer_22');
    assert.strictEqual(rafi.lead_kind, 'influencer', JSON.stringify(rafi.kind_reasons));
    assert.deepStrictEqual([...rafi.methods].sort(), ['m3', 'm4']);
    assert.deepStrictEqual([...rafi.signals.venues].sort(), ['burgerhouse', 'pizzaplace']);
    assert.strictEqual(shop.lead_kind, 'business', JSON.stringify(shop.kind_reasons));
    assert.notStrictEqual(cust.lead_kind, 'influencer', 'a customer’s dinner photo was filed as an influencer');
    state.rafi = rafi; state.shop = shop;

    const inf = await call('GET', '/api/leads', { token: 't-admin', query: { kind: 'influencer' } });
    assert.strictEqual(inf.statusCode, 200, JSON.stringify(inf.body));
    assert.ok(inf.body.leads.some(l => l.username === 'rafi.eats') && !inf.body.leads.some(l => l.username === 'burgerhouse_dhaka'));
    const biz = await call('GET', '/api/leads', { token: 't-admin', query: { kind: 'business', sort: 'fit' } });
    assert.ok(biz.body.leads.some(l => l.username === 'burgerhouse_dhaka'));
    const sum = await call('GET', '/api/leads/summary', { token: 't-admin' });
    assert.ok(sum.body.byKind.influencer >= 1 && sum.body.byKind.business >= 1, JSON.stringify(sum.body.byKind));
});
test('filling in profiles reads the lead again, and the profile decides', async () => {
    APIFY.actors['apify/instagram-profile-scraper'] = (input) => input.usernames.map(u => ({
        username: u, fullName: u === 'rafi.eats' ? 'Rafi Ahmed' : 'Burger House',
        followersCount: u === 'rafi.eats' ? 18400 : 5200, followsCount: 400, postsCount: 210,
        biography: u === 'rafi.eats' ? 'Dhaka food reviews · 📩 rafi@eats.test for collabs' : 'Best burgers · Order: 01711-000000',
        businessCategoryName: u === 'rafi.eats' ? 'Digital creator' : (u === 'burgerhouse_dhaka' ? 'Restaurant' : null),
        isBusinessAccount: true
    }));
    tbl('jobs').filter(j => j.user_id === EMP.id && ['queued', 'running'].includes(j.status)).forEach(j => { j.status = 'done'; });
    const campaign = tbl('campaigns').find(c => c.name === 'Dhaka food creators');
    const r = await call('POST', '/api/enrich-campaign', { token: 't-emp', body: { clientId: state.C, campaignId: campaign.id, batchSize: 25 } });
    assert.strictEqual(r.statusCode, 202, JSON.stringify(r.body));
    const job = await untilDone(r.body.jobId);
    assert.strictEqual(job.status, 'done', `${job.status}: ${job.error || ''}`);
    const rafi = tbl('leads').find(l => l.id === state.rafi.id);
    assert.strictEqual(rafi.kind_stage, 'profile');
    assert.strictEqual(rafi.lead_kind, 'influencer');
    assert.ok(rafi.fit_score > 40, JSON.stringify(rafi.fit_reasons));
    assert.ok(rafi.kind_reasons.some(r => /Digital creator/.test(r.text)));
    delete process.env.APIFY_API_KEY;
});
test('a person’s correction wins, and is counted against the rules', async () => {
    const cust = tbl('leads').find(l => l.username === 'happy_customer_22');
    const r = await call('PATCH', `/api/leads/${cust.id}/kind`, { token: 't-emp', body: { kind: 'personal' } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.lead.kind, 'personal');
    assert.strictEqual(tbl('leads').find(l => l.id === cust.id).kind_now, 'personal');
    await call('PATCH', `/api/leads/${state.rafi.id}/kind`, { token: 't-emp', body: { kind: 'influencer' } });
    const acc = await call('GET', '/api/leads/accuracy', { token: 't-emp' });
    assert.strictEqual(acc.body.labeled, 2);
    assert.ok(acc.body.agree >= 1, JSON.stringify(acc.body));
    const owner = await call('PATCH', `/api/leads/${cust.id}/kind`, { token: 't-client', body: { kind: 'business' } });
    assert.ok([403, 404].includes(owner.statusCode), 'a client account relabelled an agency lead');
});
test('an influencer goes into a brand’s pipeline once, filed under the brand, with its history', async () => {
    const add = await call('POST', '/api/leads/pipeline', { token: 't-emp', body: { leadIds: [state.rafi.id], clientId: state.C, note: 'Loves burgers, good fit for the grill night' } });
    assert.strictEqual(add.statusCode, 201, JSON.stringify(add.body));
    const row = add.body.added[0];
    assert.deepStrictEqual([row.kind, row.stage, row.assignedTo], ['influencer', 'found', EMP.id]);
    assert.ok(tbl('client_leads').some(x => x.client_id === state.C && x.lead_id === state.rafi.id), 'the influencer was not filed under the brand');
    const again = await call('POST', '/api/leads/pipeline', { token: 't-emp', body: { leadIds: [state.rafi.id], clientId: state.C } });
    assert.strictEqual(again.body.added.length, 0); assert.strictEqual(again.body.already.length, 1);
    const today = new Date().toISOString().slice(0, 10);
    const mv = await call('PATCH', `/api/leads/pipeline/${row.id}`, { token: 't-emp', body: { stage: 'contacted', followUpOn: today, rate: '৳8,000 per reel' } });
    assert.strictEqual(mv.statusCode, 200, JSON.stringify(mv.body));
    assert.strictEqual(mv.body.row.due, 'today');
    const bad = await call('PATCH', `/api/leads/pipeline/${row.id}`, { token: 't-emp', body: { stage: 'meeting' } });
    assert.strictEqual(bad.statusCode, 400, 'a business stage was accepted for an influencer');
    await call('POST', `/api/leads/pipeline/${row.id}/notes`, { token: 't-emp', body: { body: 'Sent the DM, waiting' } });
    const one = await call('GET', `/api/leads/pipeline/${row.id}`, { token: 't-emp' });
    const said = one.body.notes.map(n => n.body).join(' | ');
    assert.ok(/Moved to Contacted/.test(said) && /Sent the DM/.test(said) && /grill night/.test(said), said);
    const list = await call('GET', '/api/leads/pipeline', { token: 't-emp', query: { client_id: state.C } });
    assert.strictEqual(list.body.rows.length, 1); assert.strictEqual(list.body.dueNow, 1);
    const inList = await call('GET', '/api/leads', { token: 't-emp', query: { client_only: '1', client_id: state.C } });
    assert.strictEqual((inList.body.leads.find(l => l.username === 'rafi.eats').pipeline || [])[0].stageName, 'Contacted');
    const owner = await call('GET', '/api/leads/pipeline', { token: 't-client' });
    assert.strictEqual(owner.statusCode, 403, 'the owner reached the agency pipeline');
    state.pipeRow = row.id;
});
test('a first message is drafted from their own posts, and nothing is sent', async () => {
    GEMINI.script = [{ parts: [{ text: JSON.stringify({ message: 'Hi Rafi, loved your honest take on the smash burger at Burger House…' }) }] }];
    GEMINI.requests.length = 0;
    const r = await call('POST', `/api/leads/pipeline/${state.pipeRow}/draft`, { token: 't-emp', body: {} });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.ok(/Rafi/.test(r.body.message));
    const prompt = GEMINI.requests[0].contents[0].parts[0].text;
    assert.ok(/My favourite burger|honest review/.test(prompt), 'the draft was not given their captions');
    assert.ok(/Harbor|harbor/i.test(prompt), 'the brand was not named to the model');
});
test('a business pitched by the agency, won, becomes a client in one step', async () => {
    const add = await call('POST', '/api/leads/pipeline', { token: 't-emp', body: { leadIds: [state.shop.id] } });
    const row = add.body.added[0];
    assert.deepStrictEqual([row.kind, row.stage, row.clientId], ['business', 'new', null]);
    const won = await call('POST', `/api/leads/pipeline/${row.id}/convert`, { token: 't-emp', body: {} });
    assert.strictEqual(won.statusCode, 201, JSON.stringify(won.body));
    const c = tbl('clients').find(x => x.id === won.body.client.id);
    assert.strictEqual(c.ig_handle, 'burgerhouse_dhaka');
    assert.strictEqual(tbl('lead_pipeline').find(x => x.id === row.id).stage, 'won');
    const inf = await call('POST', `/api/leads/pipeline/${state.pipeRow}/convert`, { token: 't-emp', body: {} });
    assert.strictEqual(inf.statusCode, 400, 'an influencer was turned into a client');
});

section('\nphase 41 — the review tracker');
test('a tagged post is sorted: review, paid review, customer photo, another business', () => {
    const v = 'burgerhouse';
    const c = (caption, extra = {}) => S.classifyTaggedPost({ ownerUsername: 'someone', caption, ...extra }, v).label;
    assert.strictEqual(c('Tried the smash burger at @burgerhouse. Juicy patty, price 450 tk, worth it. 8/10, would recommend!'), 'review');
    assert.strictEqual(c('খেয়ে দেখলাম @burgerhouse এর বার্গার। স্বাদ দারুণ, দাম ৪৫০ টাকা, রেটিং ৮/১০ দিলাম', { productType: 'clips' }), 'review');
    assert.strictEqual(c('Invited by @burgerhouse for their new menu. The taste was great, portion huge, must try! 9/10'), 'review_paid');
    assert.strictEqual(c('dinner with family ❤️'), 'customer');
    assert.strictEqual(S.classifyTaggedPost({ ownerUsername: 'freshbuns_bakery', caption: 'Proud supplier of @burgerhouse buns. Order now!' }, v).label, 'business');
    assert.strictEqual(S.classifyTaggedPost({ ownerUsername: 'burgerhouse', caption: 'Our new menu' }, v).label, 'business', 'the venue tagging itself is not a review');
    assert.strictEqual(c('Weekend vibes at @burgerhouse, loved the place'), 'unclear', 'a half-opinion should go to the model, not be guessed');
});
test('Instagram links, name matching, and a website fetch that cannot reach our own network', async () => {
    assert.strictEqual(S.igHandleFromUrl('https://www.instagram.com/harbor.sushi/?hl=en'), 'harbor.sushi');
    assert.strictEqual(S.igHandleFromUrl('https://instagram.com/p/Cxyz123/'), null);
    assert.ok(S.reviewNameMatch('Harbor Sushi Bar', { username: 'harborsushibar', fullName: 'Harbor Sushi Bar' }) >= 0.75);
    assert.ok(S.reviewNameMatch('Harbor Sushi Bar', { username: 'pizzaplace', fullName: 'Pizza Place' }) < 0.5);
    for (const ip of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '192.168.1.1', '172.20.0.1', '::1']) assert.ok(S.reviewPrivateIp(ip), ip);
    assert.ok(!S.reviewPrivateIp('93.184.216.34'));
    S.__setReviewLookup(async host => [{ address: host === 'evil.test' ? '169.254.169.254' : '93.184.216.34' }]);
    WEB['https://evil.test/'] = { html: '<a href="https://instagram.com/stolen">x</a>' };
    assert.strictEqual(await S.safePublicFetch('https://evil.test/'), null, 'a site resolving to the metadata address was fetched');
    WEB['https://redirector.test/'] = { status: 302, location: 'https://evil.test/' };
    assert.strictEqual(await S.safePublicFetch('https://redirector.test/'), null, 'a redirect onto a private address was followed');
    assert.strictEqual(await S.safePublicFetch('file:///etc/passwd'), null);
});
test('a scan: Maps finds the businesses, their Instagram is matched, tagged posts are read and the reviewers become leads', async () => {
    process.env.APIFY_API_KEY = 'test-apify-key';
    const cl = tbl('clients').find(c => c.id === state.C);
    cl.ig_handle = 'harborcafe';
    WEB['https://harborsushi.test/'] = { html: '<footer><a href="https://www.instagram.com/harbor.sushi/">Instagram</a></footer>' };
    APIFY.actors['compass/crawler-google-places'] = (input) => {
        assert.strictEqual(input.locationQuery, 'Gulshan, Dhaka');
        return [
            { title: 'Pizza Place', categoryName: 'Pizza restaurant', address: 'Road 11', instagrams: ['https://www.instagram.com/pizzaplace/'], totalScore: 4.4, reviewsCount: 812, placeId: 'P1' },
            { title: 'Harbor Sushi', categoryName: 'Sushi restaurant', website: 'https://harborsushi.test/', placeId: 'P2' },
            { title: 'Gulshan Grill House', categoryName: 'Restaurant', placeId: 'P3' },
            { title: 'Tiny Tea Stall', categoryName: 'Tea house', placeId: 'P4' }
        ];
    };
    APIFY.actors['apify/instagram-search-scraper'] = (input) => {
        const q = input.searchQueries[0];
        if (/Grill House/.test(q)) return [{ username: 'gulshangrillhouse', fullName: 'Gulshan Grill House' }, { username: 'grillfan99', fullName: 'Rahim' }];
        return [{ username: 'randomtea', fullName: 'Random' }];
    };
    const tp = (owner, sc, caption, extra = {}) => ({ ownerUsername: owner, shortCode: sc, caption, likesCount: 200, commentsCount: 30, timestamp: new Date(Date.now() - 5 * 86400000).toISOString(), url: `https://www.instagram.com/p/${sc}/`, ...extra });
    APIFY.actors['apify/instagram-scraper'] = (input) => {
        const h = (/instagram\.com\/([^/]+)\/tagged/.exec(input.directUrls[0]) || [])[1];
        const base = [tp('dinerdiary', 'dd-' + h, `Tried @${h} today: juicy, price 650 tk, worth it, 8/10, would recommend`), tp('family_pics_1', 'fp-' + h, 'dinner with family')];
        if (h === 'pizzaplace') base.push(tp('rafi.eats', 're-' + h, `Weekend vibes at @${h}, loved the place`), tp('old', 'old-' + h, 'Tried it, 9/10 must try, great taste', { timestamp: '2025-01-01T00:00:00Z' }));
        if (h === 'harbor.sushi') base.push(tp('rafi.eats', 'rs-' + h, 'Invited by @harbor.sushi, fresh salmon, great service and presentation. 9/10'));
        return base;
    };
    GEMINI.script = [(body) => {
        const items = JSON.parse(/Items \(JSON\):\n([\s\S]*?)\n\nReply/.exec(body.contents[0].parts[0].text)[1]);
        return { parts: [{ text: JSON.stringify({ labels: items.map(x => ({ i: x.i, label: 'review', paid: false })) }) }] };
    }];
    tbl('jobs').filter(j => j.user_id === EMP.id && ['queued', 'running'].includes(j.status)).forEach(j => { j.status = 'done'; });
    const r = await call('POST', '/api/reviews/scan', { token: 't-emp', body: { clientId: state.C, category: 'restaurants', area: 'Gulshan, Dhaka', seed: '@harborcafe', maxBusinesses: 4, days: 90, postsPer: 40 } });
    assert.strictEqual(r.statusCode, 202, JSON.stringify(r.body));
    assert.ok(r.body.estimatedUsd > 0);
    const job = await untilDone(r.body.jobId);
    assert.strictEqual(job.status, 'done', `${job.status}: ${job.error || ''}`);
    const rep = tbl('reports').find(x => x.id === job.result_report_id);
    const j = rep.report_json;
    const handles = j.board.map(b => b.handle).sort();
    assert.deepStrictEqual(handles, ['gulshangrillhouse', 'harbor.sushi', 'harborcafe', 'pizzaplace'], 'the matched businesses: ' + handles.join(','));
    assert.strictEqual(j.board.find(b => b.handle === 'gulshangrillhouse').match, 'likely');
    assert.deepStrictEqual(j.unmatched.map(u => u.name), ['Tiny Tea Stall']);
    const pizza = j.board.find(b => b.handle === 'pizzaplace');
    assert.strictEqual(pizza.reviews, 2, 'the unclear post was sent to the model and counted; the old one was not');
    assert.strictEqual(pizza.customers, 1);
    const sushi = j.board.find(b => b.handle === 'harbor.sushi');
    assert.strictEqual(sushi.paid, 1);
    assert.ok(j.board.find(b => b.handle === 'harborcafe').isClient);
    const rafi = j.reviewers.find(x => x.handle === 'rafi.eats');
    assert.deepStrictEqual(rafi.venues.sort(), ['harbor.sushi', 'pizzaplace']);
    assert.strictEqual(rafi.reviewedClient, false);
    assert.ok(j.missedByClient.some(x => x.handle === 'rafi.eats'));
    const lead = tbl('leads').find(l => l.username === 'dinerdiary' && l.owner_user_id === EMP.id);
    assert.ok(lead && lead.methods.includes('review'), 'a reviewer was not saved as a lead');
    assert.ok(tbl('client_leads').some(x => x.client_id === state.C && x.lead_id === lead.id));
    assert.ok(!tbl('leads').some(l => l.username === 'family_pics_1'), 'a customer photo became a lead');
    const doc = S.reportDoc({ ...rep });
    const titles = doc.sections.map(x => x.title);
    for (const t of ['At a glance', 'Who is being reviewed', 'The creators who review here', 'Businesses we could not read']) assert.ok(titles.includes(t), titles.join(' | '));
    state.reviewReport = rep.id;

    // A second scan of the same place marks only what is new.
    APIFY.actors['apify/instagram-scraper'] = (input) => {
        const h = (/instagram\.com\/([^/]+)\/tagged/.exec(input.directUrls[0]) || [])[1];
        const out = [tp('dinerdiary', 'dd-' + h, `Tried @${h} today: juicy, price 650 tk, worth it, 8/10, would recommend`)];
        if (h === 'harborcafe') out.push(tp('newcritic', 'nc-1', 'Tried @harborcafe: great taste, fair price, must try 9/10'));
        return out;
    };
    tbl('jobs').filter(j2 => j2.user_id === EMP.id && ['queued', 'running'].includes(j2.status)).forEach(j2 => { j2.status = 'done'; });
    const r2 = await call('POST', '/api/reviews/scan', { token: 't-emp', body: { clientId: state.C, category: 'restaurants', area: 'Gulshan, Dhaka', seed: '@harborcafe', maxBusinesses: 4 } });
    const job2 = await untilDone(r2.body.jobId);
    assert.strictEqual(job2.status, 'done', job2.error || '');
    const j2 = tbl('reports').find(x => x.id === job2.result_report_id).report_json;
    assert.ok(j2.hasPrevious);
    assert.strictEqual(j2.board.find(b => b.handle === 'harborcafe').newReviews, 1);
    assert.ok(j2.reviewers.find(x => x.handle === 'newcritic').isNew && !j2.reviewers.find(x => x.handle === 'dinerdiary').isNew);
    const list = await call('GET', '/api/reviews/scans', { token: 't-emp' });
    assert.ok(list.body.scans.length >= 2);
    const owner = await call('POST', '/api/reviews/scan', { token: 't-client', body: { category: 'x', area: 'y' } });
    assert.ok([403].includes(owner.statusCode), 'an owner started a review scan: ' + owner.statusCode);
    delete process.env.APIFY_API_KEY;
});
test('the scan can be repeated monthly, and the owner can open its document', async () => {
    assert.strictEqual(S.SCHEDULABLE_TYPES.review_scan, 'leadgen');
    const v = await ownerOpen(state.reviewReport);
    assert.strictEqual(v.statusCode, 200, JSON.stringify(v.body));
    assert.strictEqual(v.body.report.doc.type, 'review_scan');
});

section('\nphase 42 — the content plan as a calendar the owner approves');
test('briefs land on their own weekday where they name one, never two on a day, never before the start', () => {
    const d = S.cpScheduleDates([{ slot: 'Tue 7pm' }, { slot: 'Friday 20:00' }, { slot: '' }, { slot: 'Tue 7pm' }, {}], '2026-10-07');
    const days = d.map(x => x.plannedOn);
    assert.strictEqual(new Set(days).size, days.length, 'two posts on one day: ' + days.join(','));
    assert.ok(days.every(x => x >= '2026-10-07'), days.join(','));
    assert.strictEqual(new Date(days[1] + 'T00:00:00Z').getUTCDay(), 5, 'the Friday brief was not put on a Friday');
    assert.strictEqual(d[0].time, '19:00');
    assert.deepStrictEqual(S.cpParseSlot('Sat 11am'), { dow: 6, time: '11:00' });
});
test('staff put a plan on the calendar once; the owner sees what waits for them, and nothing about the team', async () => {
    const put = await call('POST', `/api/content-plan/${state.cpReport}/calendar`, { token: 't-emp', body: { start: '2026-10-05' } });
    assert.strictEqual(put.statusCode, 201, JSON.stringify(put.body));
    assert.ok(put.body.added >= 2, JSON.stringify(put.body));
    const again = await call('POST', `/api/content-plan/${state.cpReport}/calendar`, { token: 't-emp', body: { start: '2026-10-05' } });
    assert.strictEqual(again.body.added, 0, 'pressing it twice doubled the calendar');
    const own = await call('GET', '/api/client/content', { token: 't-client' });
    assert.strictEqual(own.statusCode, 200, JSON.stringify(own.body));
    assert.ok(own.body.posts.length >= 2 && own.body.waiting === own.body.posts.length);
    assert.strictEqual(own.body.posts[0].statusName, 'Waiting for your OK');
    for (const k of ['planId', 'report_id', 'created_by', 'taskId', 'clientId', 'decidedBy']) assert.ok(!(k in own.body.posts[0]), `the owner was sent ${k}`);
    state.cpPosts = put.body.posts;
});
test('the owner approves one (it goes on the board), asks for changes on another, and the team sees why', async () => {
    const [a, b] = state.cpPosts;
    const ok = await call('POST', `/api/client/content/${a.id}/decision`, { token: 't-client', body: { decision: 'approve' } });
    assert.strictEqual(ok.statusCode, 200, JSON.stringify(ok.body));
    const row = tbl('content_posts').find(x => x.id === a.id);
    assert.deepStrictEqual([row.status, row.decided_by], ['approved', 'owner']);
    const task = tbl('client_tasks').find(t => t.source_key === 'post:' + a.id);
    assert.ok(task && task.client_id === state.C && /^Make the /.test(task.title), 'the approved post did not become a task');
    const empty = await call('POST', `/api/client/content/${b.id}/decision`, { token: 't-client', body: { decision: 'changes' } });
    assert.strictEqual(empty.statusCode, 400, 'changes were asked for without saying what');
    await call('POST', `/api/client/content/${b.id}/decision`, { token: 't-client', body: { decision: 'changes', note: 'Use our new logo, not the old one' } });
    const cal = await call('GET', `/api/content-plan/${state.cpReport}/calendar`, { token: 't-emp' });
    const seen = cal.body.posts.find(x => x.id === b.id);
    assert.deepStrictEqual([seen.status, seen.ownerNote], ['changes', 'Use our new logo, not the old one']);
    const owner = await call('PATCH', `/api/content-posts/${a.id}`, { token: 't-client', body: { status: 'posted' } });
    assert.strictEqual(owner.statusCode, 403, 'an owner reached the staff route');
});
test('phase 53: the approved post\'s task goes to the plan\'s author, and the board moves the post along', async () => {
    const [a] = state.cpPosts;
    const task = tbl('client_tasks').find(t => t.source_key === 'post:' + a.id);
    const plan = tbl('reports').find(r => r.id === state.cpReport);
    assert.ok(task.assignee_user_id, 'the task to make an approved post went to nobody');
    assert.strictEqual(task.assignee_user_id, plan.user_id, 'the task did not go to whoever made the plan');
    const done = await call('PATCH', `/api/tasks/${task.id}`, { token: 't-emp', body: { status: 'done' } });
    assert.strictEqual(done.statusCode, 200, JSON.stringify(done.body));
    assert.strictEqual(tbl('content_posts').find(x => x.id === a.id).status, 'made', 'done on the board did not mark the post made');
    const back = await call('PATCH', `/api/tasks/${task.id}`, { token: 't-emp', body: { status: 'doing' } });
    assert.strictEqual(back.statusCode, 200);
    assert.strictEqual(tbl('content_posts').find(x => x.id === a.id).status, 'approved', 'reopening the task left the post marked made');
});
test('posted with its link: the task closes, and the monthly report says how the planned posts did', async () => {
    const [a] = state.cpPosts;
    const r = await call('PATCH', `/api/content-posts/${a.id}`, { token: 't-emp', body: { status: 'posted', postedUrl: 'https://www.instagram.com/p/PLAN123/' } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    const row = tbl('content_posts').find(x => x.id === a.id);
    assert.strictEqual(row.shortcode, 'PLAN123');
    assert.strictEqual(tbl('client_tasks').find(t => t.id === row.task_id).status, 'done');
    tbl('posts').push({ id: crypto.randomUUID(), user_id: EMP.id, client_id: state.C, platform: 'instagram', handle: 'harborcafe', shortcode: 'PLAN123', likes: 321, comments: 17, views: 0 });
    const month = String(row.planned_on).slice(0, 7);
    const cp = await S.contentPlanMonth(state.C, month);
    const item = cp.items.find(i => i.url === 'https://www.instagram.com/p/PLAN123/');
    assert.deepStrictEqual([item.likes, item.comments, item.status], [321, 17, 'posted']);
    assert.ok(cp.planned >= 1 && cp.posted === 1);
    const doc = S.reportDoc({ id: 'm', report_type: 'public_monthly', created_at: new Date().toISOString(),
        report_json: { month, monthLabel: 'October 2026', client: { name: 'Harbor Cafe' }, context: {}, contentPlan: cp, plan: [] } });
    const sec = doc.sections.find(x => x.title === 'What we planned, and how it did');
    assert.ok(sec, doc.sections.map(x => x.title).join(' | '));
});

section('\nphase 41b — the review tracker set up fresh each time');
test('step one finds and matches only: several kinds, a rating floor, no name search, nothing read yet', async () => {
    process.env.APIFY_API_KEY = 'test-apify-key';
    const before = APIFY.calls.length;
    APIFY.actors['compass/crawler-google-places'] = (input) => {
        assert.deepStrictEqual(input.searchStringsArray, ['cafés', 'bakeries']);
        return [
            { title: 'Top Cafe', categoryName: 'Cafe', instagrams: ['https://instagram.com/topcafe'], totalScore: 4.6, reviewsCount: 900, placeId: 'A' },
            { title: 'Meh Cafe', categoryName: 'Cafe', instagrams: ['https://instagram.com/mehcafe'], totalScore: 3.1, reviewsCount: 40, placeId: 'B' },
            { title: 'No Link Bakery', categoryName: 'Bakery', totalScore: 4.8, reviewsCount: 300, placeId: 'C' }
        ];
    };
    tbl('jobs').filter(j => j.user_id === ADMIN.id && ['queued', 'running'].includes(j.status)).forEach(j => { j.status = 'done'; });
    const r = await call('POST', '/api/reviews/find', { token: 't-admin', body: { clientId: state.C, categories: ['cafés', 'bakeries'], area: 'Banani, Dhaka', maxBusinesses: 5, minRating: 4, searchNames: false, handles: ['@rivalone'] } });
    assert.strictEqual(r.statusCode, 202, JSON.stringify(r.body));
    const job = await untilDone(r.body.jobId);
    assert.strictEqual(job.status, 'done', job.error || '');
    const names = job.result.places.map(p => p.name);
    assert.ok(names.includes('Top Cafe') && !names.includes('Meh Cafe'), 'the rating floor was not applied: ' + names.join(','));
    assert.ok(job.result.places.some(p => p.handle === 'rivalone' && p.source === 'given'), 'the own list was dropped');
    const bakery = job.result.places.find(p => p.name === 'No Link Bakery');
    assert.deepStrictEqual([bakery.handle, bakery.match], [null, 'none'], 'a name search ran although it was switched off');
    const calls = APIFY.calls.slice(before).map(c => c.id);
    assert.ok(!calls.includes('apify/instagram-scraper'), 'step one read tagged posts');
    assert.ok(!calls.includes('apify/instagram-search-scraper'), 'step one searched names although told not to');
    assert.ok(!tbl('reports').some(x => x.id === job.result_report_id && job.result_report_id), 'step one saved a report');
});
test('step two reads exactly the picked list: Maps is not asked again, and AI can be switched off', async () => {
    const before = APIFY.calls.length;
    APIFY.actors['apify/instagram-scraper'] = (input) => {
        const h = (/instagram\.com\/([^/]+)\/tagged/.exec(input.directUrls[0]) || [])[1];
        const n = h === 'topcafe' ? 1 : 2;
        return [{ ownerUsername: 'nadia.r' + n, shortCode: 'k-' + h, caption: `Tried @${h}: price 300 tk, great taste, 8/10`, likesCount: 50, commentsCount: 5, timestamp: new Date().toISOString() },
                { ownerUsername: 'sam.k' + n, shortCode: 'v-' + h, caption: `Weekend vibes at @${h}, loved it`, likesCount: 10, commentsCount: 1, timestamp: new Date().toISOString() }];
    };
    GEMINI.requests.length = 0;
    tbl('jobs').filter(j => j.user_id === ADMIN.id && ['queued', 'running'].includes(j.status)).forEach(j => { j.status = 'done'; });
    const r = await call('POST', '/api/reviews/scan', { token: 't-admin', body: { clientId: state.C, useMaps: false, category: 'cafés, bakeries', area: 'Banani, Dhaka',
        handles: [{ handle: 'topcafe', name: 'Top Cafe' }, { handle: 'nolinkbakery', name: 'No Link Bakery' }], days: 30, postsPer: 20, useAi: false } });
    assert.strictEqual(r.statusCode, 202, JSON.stringify(r.body));
    const job = await untilDone(r.body.jobId);
    assert.strictEqual(job.status, 'done', job.error || '');
    const ids = APIFY.calls.slice(before).map(c => c.id);
    assert.ok(!ids.includes('compass/crawler-google-places'), 'Maps was asked again for a picked list');
    assert.deepStrictEqual(APIFY.calls.slice(before).filter(c => c.id === 'apify/instagram-scraper').map(c => c.input.resultsLimit), [20, 20]);
    assert.strictEqual(GEMINI.requests.length, 0, 'AI was used although it was switched off');
    const j = tbl('reports').find(x => x.id === job.result_report_id).report_json;
    assert.deepStrictEqual(j.board.map(b => b.handle).sort(), ['nolinkbakery', 'topcafe']);
    assert.strictEqual(j.board.find(b => b.handle === 'topcafe').name, 'Top Cafe');
    assert.strictEqual(j.counts.unclear, 2, 'the unclear posts should stay unclear, not be guessed');
    assert.strictEqual(j.windowDays, 30);
    delete process.env.APIFY_API_KEY;
});

section('\nphase 43 — the content plan the way the agency works');
const nextMonth = (() => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 7); })();
test('a spreadsheet journal comes in whatever its columns are called, and post types are read from words or links', () => {
    assert.strictEqual(S.csType('Reels'), 'video');
    assert.strictEqual(S.csType('IG stories'), 'story');
    assert.strictEqual(S.csType('', 'https://www.instagram.com/reel/abc/'), 'video');
    assert.strictEqual(S.csType('Swipe post'), 'carousel');
    const csv = 'Link,Brand,Format,Hook / Idea,Why it worked,Apps,Topic\n' +
        'https://www.instagram.com/reel/AAA/,@gymbro,Reel,"3 mistakes, and the fix",Myth-busting in 3 beats,"CapCut, Phone",educational; mistakes\n' +
        'https://www.instagram.com/p/BBB/,Sneaker Shop,carousel,Before and after,Swipe payoff,Canva,reviews\n' +
        ',,,,,,\n' +
        ',Tea house,Story,Poll: which one?,Two taps to answer,,generic\n';
    const r = S.csImportRows(csv);
    assert.strictEqual(r.rows.length, 3, JSON.stringify(r));
    assert.deepStrictEqual(Object.keys(r.mapped).sort(), ['hook', 'post_type', 'source_name', 'tags', 'tools', 'url', 'why_worked'].sort());
    assert.strictEqual(r.rows[0].hook, '3 mistakes, and the fix');
    assert.deepStrictEqual(r.rows[0].tools, ['CapCut', 'Phone']);
    assert.deepStrictEqual(r.rows[0].tags, ['educational', 'mistakes']);
    assert.strictEqual(r.rows[0].source_name, 'gymbro');
    assert.strictEqual(r.rows[2].post_type, 'story');
});
test('an idea tagged for the topic, in the type the category needs, ranks first; one already used this month drops', () => {
    const topic = { id: 't', category: 'reviews', title: 'Happy customers', detail: 'customer photos and ratings' };
    const ideas = [
        { id: 'a', post_type: 'static', hook: 'Menu flat lay', tags: ['food'], created_at: '2026-01-01' },
        { id: 'b', post_type: 'story', hook: 'Customer photo wall', tags: ['reviews', 'customers'], created_at: '2026-01-01' },
        { id: 'c', post_type: 'story', hook: 'Customer rating sticker', tags: ['reviews'], created_at: '2026-01-02' }
    ];
    const r = S.csRank(topic, ideas);
    assert.strictEqual(r[0].idea.id, 'b', r.map(x => x.idea.id + ':' + x.score).join(' '));
    assert.strictEqual(r[0].fit, 'good');
    assert.ok(r[r.length - 1].idea.id === 'a');
    const again = S.csRank(topic, ideas, { month: { b: 1 } });
    assert.notStrictEqual(again[0].idea.id, 'b', 'an idea already picked this month still came first');
    assert.deepStrictEqual(S.csToolsFor('video', { tools: ['CapCut'] }), ['CapCut', 'Phone camera']);
});
test('the library is the whole team\'s: add, refuse a second copy of a link, import a sheet, filter; an owner cannot see it', async () => {
    const a = await call('POST', '/api/content-ideas', { token: 't-emp', body: { url: 'https://www.instagram.com/reel/LIB1/', hook: 'Guess the price', whyWorked: 'Comments explode', tags: 'service, price', tools: ['CapCut'] } });
    assert.strictEqual(a.statusCode, 201, JSON.stringify(a.body));
    assert.deepStrictEqual([a.body.idea.postType, a.body.idea.mine], ['video', true]);
    const dup = await call('POST', '/api/content-ideas', { token: 't-admin', body: { url: 'https://www.instagram.com/reel/LIB1/', hook: 'again' } });
    assert.strictEqual(dup.statusCode, 409);
    const csv = 'url,account,type,hook,notes,tags\n' +
        'https://www.instagram.com/p/LIB2/,@skincare,carousel,5 myths about X,Saves come from the last slide,educational\n' +
        'https://www.instagram.com/stories/cafe/1/,@cafe,story,Rate our new drink,Slider sticker gets taps,reviews\n' +
        'https://www.instagram.com/p/LIB3/,@bakery,photo,The one we sell out of,Scarcity,service\n' +
        'https://www.instagram.com/reel/LIB1/,@x,reel,dup,dup,\n';
    const dry = await call('POST', '/api/content-ideas/import', { token: 't-admin', body: { csv, dryRun: true } });
    assert.deepStrictEqual([dry.body.would, dry.body.dupes], [3, 1], JSON.stringify(dry.body));
    assert.ok(!tbl('content_ideas').some(r => r.url === 'https://www.instagram.com/p/LIB2/'), 'a dry run saved rows');
    const imp = await call('POST', '/api/content-ideas/import', { token: 't-admin', body: { csv } });
    assert.strictEqual(imp.statusCode, 201, JSON.stringify(imp.body));
    assert.deepStrictEqual([imp.body.added, imp.body.dupes], [3, 1]);
    const list = await call('GET', '/api/content-ideas', { token: 't-emp', query: { type: 'story' } });
    assert.ok(list.body.ideas.length >= 1 && list.body.ideas.every(i => i.postType === 'story'));
    const q = await call('GET', '/api/content-ideas', { token: 't-emp', query: { q: 'myths' } });
    assert.deepStrictEqual(q.body.ideas.map(i => i.hook), ['5 myths about X']);
    assert.ok(q.body.ideas[0].savedBy, 'the library did not say who saved it');
    const adminsIdea = tbl('content_ideas').find(r => r.url === 'https://www.instagram.com/p/LIB2/');
    const other = await call('DELETE', `/api/content-ideas/${adminsIdea.id}`, { token: 't-emp' });
    assert.strictEqual(other.statusCode, 403, 'a teammate removed someone else\'s idea');
    const owner = await call('GET', '/api/content-ideas', { token: 't-client' });
    assert.strictEqual(owner.statusCode, 403, 'a business owner read the library');
});
test('the audit reads the site and posts, fills the business once, and files topics by category', async () => {
    S.__setReviewLookup(async host => [{ address: host === 'evil.test' ? '169.254.169.254' : '93.184.216.34' }]);
    WEB['https://harbor.test/'] = { html: '<title>Harbor Cafe</title><meta name="description" content="All-day cafe in Gulshan 2."><h1>Harbor</h1><a href="/menu">Menu</a><a href="https://other.test/menu">x</a>' };
    WEB['https://harbor.test/menu'] = { html: '<h2>Breakfast platter</h2><p>650 tk</p><h2>Cold brew</h2><p>320 tk</p>' };
    GEMINI.script = [body => {
        const text = body.contents[0].parts[0].text;
        assert.ok(/Breakfast platter/.test(text) && /Gulshan/.test(text), 'the model was not given the website');
        return { parts: [{ text: JSON.stringify({
            business: { summary: 'An all-day cafe in Gulshan 2.', model: 'Dine-in and takeaway', audience: 'Office crowd', voice: 'Warm',
                offers: [{ name: 'Breakfast platter', price: '650 tk', note: 'Weekend favourite' }, { name: 'Cold brew', price: '320 tk' }], proof: [], differentiators: ['Open at 7am'] },
            topics: [{ category: 'service', title: 'Breakfast platter', why: 'On the website menu', priority: 'high' },
                     { category: 'educational', title: 'How cold brew is made', why: 'Rivals post brewing reels', priority: 'normal' },
                     { category: 'reviews', title: 'Happy customers', why: 'Customers tag them', priority: 'high' },
                     { category: 'generic', title: 'Opening at 7am', why: 'From the website', priority: 'normal' },
                     { category: 'collab', title: 'Office lunch creator', why: 'Local creators', priority: 'low' },
                     { category: 'bogus', title: 'Nope' }]
        }) }] };
    }];
    tbl('jobs').filter(j => j.user_id === ADMIN.id && ['queued', 'running'].includes(j.status)).forEach(j => { j.status = 'done'; });
    const r = await call('POST', `/api/content-strategy/${state.C}/audit`, { token: 't-admin', body: { website: 'harbor.test' } });
    assert.strictEqual(r.statusCode, 202, JSON.stringify(r.body));
    const job = await untilDone(r.body.jobId);
    assert.strictEqual(job.status, 'done', job.error || '');
    const st = await call('GET', `/api/content-strategy/${state.C}`, { token: 't-emp', query: { month: nextMonth } });
    assert.strictEqual(st.statusCode, 200, JSON.stringify(st.body));
    assert.deepStrictEqual(st.body.profile.business.offers.map(o => o.price), ['650 tk', '320 tk']);
    assert.strictEqual(st.body.profile.audit.read.website.pages.length, 2, 'the menu page was not read, or another site was');
    const cats = new Set(st.body.topics.map(t => t.category));
    for (const c of ['service', 'educational', 'reviews', 'generic', 'collab']) assert.ok(cats.has(c), 'no ' + c + ' topic');
    assert.ok(!st.body.topics.some(t => t.title === 'Nope'), 'a topic in no category was kept');
    assert.strictEqual(st.body.topics.filter(t => t.title.toLowerCase() === 'breakfast platter').length, 1, 'the same topic was filed twice');
    assert.ok(st.body.topics.find(t => t.title === 'Cold brew').active, 'an offer was not ticked as a primary topic');
    // A second audit suggests, but does not overwrite what the team corrected.
    await call('PUT', `/api/content-strategy/${state.C}/profile`, { token: 't-emp', body: { business: { ...st.body.profile.business, summary: 'Corrected by the team.' } } });
    GEMINI.script = [{ parts: [{ text: JSON.stringify({ business: { summary: 'Model says something else.', offers: [] }, topics: [] }) }] }];
    const r2 = await call('POST', `/api/content-strategy/${state.C}/audit`, { token: 't-admin', body: { website: 'https://harbor.test/' } });
    await untilDone(r2.body.jobId);
    const prof = tbl('content_profiles').find(p => p.client_id === state.C);
    assert.strictEqual(prof.business.summary, 'Corrected by the team.');
    assert.strictEqual(prof.audit.suggestion.summary, 'Model says something else.');
    const owner = await call('GET', `/api/content-strategy/${state.C}`, { token: 't-client' });
    assert.strictEqual(owner.statusCode, 403, 'an owner read the working plan');
});
test('suggestions come only from each topic\'s own shortlist; an idea the model made up is dropped', async () => {
    let seen = null;
    GEMINI.script = [body => {
        const text = body.contents[0].parts[0].text;
        const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1).replace(/\n\nReply[\s\S]*$/, ''));
        seen = json;
        return { parts: [{ text: JSON.stringify({ topics: json.topics.map(t => ({ topicId: t.topicId, ideas: [
            { ideaId: t.candidates[0].ideaId, fit: 'good', adaptation: `Make it about ${t.title}`, tools: ['Canva'] },
            { ideaId: '00000000-0000-4000-8000-000000000000', fit: 'good', adaptation: 'invented' }] })) }) }] };
    }];
    const r = await call('POST', `/api/content-strategy/${state.C}/suggest`, { token: 't-admin', body: { month: nextMonth } });
    assert.strictEqual(r.statusCode, 202, JSON.stringify(r.body));
    const job = await untilDone(r.body.jobId);
    assert.strictEqual(job.status, 'done', job.error || '');
    assert.ok(seen && seen.topics.every(t => t.candidates.length <= 5));
    assert.ok(job.result.dropped >= 1, 'the invented idea was not counted as dropped');
    const st = await call('GET', `/api/content-strategy/${state.C}`, { token: 't-emp', query: { month: nextMonth } });
    const t = st.body.topics.find(x => x.active && x.ideas.length);
    assert.ok(t, 'no ticked topic had ideas');
    assert.ok(t.ideas.every(i => i.idea && i.idea.id), 'a suggestion pointed at no idea');
    assert.ok(/^Make it about /.test(t.ideas[0].adaptation));
    state.csTopic = t;
});
test('a pick needs the team\'s own note before it is final; final picks go on the calendar for the owner, once', async () => {
    const t = state.csTopic;
    const p = await call('POST', `/api/content-strategy/${state.C}/picks`, { token: 't-emp', body: { month: nextMonth, topicId: t.id, ideaId: t.ideas[0].ideaId } });
    assert.strictEqual(p.statusCode, 201, JSON.stringify(p.body));
    assert.strictEqual(p.body.pick.status, 'draft');
    assert.ok(p.body.pick.tools.length >= 1 && p.body.pick.tools.length <= 3);
    const same = await call('POST', `/api/content-strategy/${state.C}/picks`, { token: 't-emp', body: { month: nextMonth, topicId: t.id, ideaId: t.ideas[0].ideaId } });
    assert.ok(same.body.existed, 'picking twice made two');
    const early = await call('PATCH', `/api/content-picks/${p.body.pick.id}`, { token: 't-emp', body: { status: 'final' } });
    assert.strictEqual(early.statusCode, 400, 'a pick went final with no human note');
    const story = await call('POST', `/api/content-strategy/${state.C}/picks`, { token: 't-emp', body: { month: nextMonth, topicId: t.id, postType: 'story', title: 'Poll: platter or brew?' } });
    assert.strictEqual(story.body.pick.postType, 'story');
    const none = await call('POST', `/api/content-strategy/${state.C}/schedule`, { token: 't-emp', body: { month: nextMonth } });
    assert.strictEqual(none.statusCode, 400);
    assert.ok(/still in draft/.test(none.body.error), none.body.error);
    const fin = await call('PATCH', `/api/content-picks/${p.body.pick.id}`, { token: 't-emp', body: { scriptNote: 'Open on the price tag\nReveal the plate', styleNote: 'Handheld, warm light', status: 'final' } });
    assert.strictEqual(fin.statusCode, 200, JSON.stringify(fin.body));
    const put = await call('POST', `/api/content-strategy/${state.C}/schedule`, { token: 't-emp', body: { month: nextMonth } });
    assert.strictEqual(put.statusCode, 201, JSON.stringify(put.body));
    assert.deepStrictEqual([put.body.added, put.body.drafts], [1, 1]);
    const post = tbl('content_posts').find(x => x.pick_id === p.body.pick.id);
    assert.ok(post && post.report_id === null && post.status === 'idea');
    assert.deepStrictEqual(post.brief.script, ['Open on the price tag', 'Reveal the plate']);
    assert.strictEqual(post.planned_on.slice(0, 7), nextMonth);
    const again = await call('POST', `/api/content-strategy/${state.C}/schedule`, { token: 't-emp', body: { month: nextMonth } });
    assert.strictEqual(tbl('content_posts').filter(x => x.pick_id === p.body.pick.id).length, 1, 'scheduling twice doubled it');
    assert.strictEqual(again.statusCode, 400);
    const cal = await call('GET', `/api/content-strategy/${state.C}/calendar`, { token: 't-emp', query: { month: nextMonth } });
    assert.ok(cal.body.posts.some(x => x.pickId === p.body.pick.id && x.brief.topic === t.title));
    const own = await call('GET', '/api/client/content', { token: 't-client' });
    const mine = own.body.posts.find(x => x.id === post.id);
    assert.ok(mine && mine.statusName === 'Waiting for your OK', 'the owner does not see the post to approve');
    for (const k of ['pickId', 'brief', 'clientId']) assert.ok(!(k in mine), 'the owner was sent ' + k);
    const ok = await call('POST', `/api/client/content/${post.id}/decision`, { token: 't-client', body: { decision: 'approve' } });
    assert.strictEqual(ok.statusCode, 200, JSON.stringify(ok.body));
    const task = tbl('client_tasks').find(x => x.source_key === 'post:' + post.id);
    assert.ok(task && /Tools: /.test(task.notes) && task.source_id === null, 'the approved pick did not become a task with its tools');
    const staff = await call('PATCH', `/api/content-posts/${post.id}`, { token: 't-emp', body: { status: 'made' } });
    assert.strictEqual(staff.statusCode, 200, 'staff could not move a post that came from a pick: ' + JSON.stringify(staff.body));
    const del = await call('DELETE', `/api/content-picks/${p.body.pick.id}`, { token: 't-emp' });
    assert.strictEqual(del.statusCode, 409, 'a pick the owner already approved was deleted');
    const delDraft = await call('DELETE', `/api/content-picks/${story.body.pick.id}`, { token: 't-emp' });
    assert.strictEqual(delDraft.statusCode, 200);
});

section('\nphase 44 — key pools: own keys first, own keys only, and one view of them all');
test('the overview sorts keys into the tiers they are tried in, and says what each person would draw from', () => {
    const now = Date.now();
    const d = S.keyPoolSummary({
        people: [{ id: 'u1', full_name: 'Nadia', role: 'user', byo_key_only: false }, { id: 'u2', full_name: 'Sam', role: 'user', byo_key_only: true }, { id: 'u3', email: 'rafi@x.test', role: 'admin' }],
        apify: [{ id: 'a1', owner_user_id: 'u1', engine: 'any', status: 'active', remainingUsd: 2 }, { id: 'a2', owner_user_id: null, engine: 'leadgen', status: 'active', remainingUsd: 0 },
                { id: 'a3', owner_user_id: null, engine: 'any', status: 'invalid', remainingUsd: 5 }],
        primaries: { leadgen: { configured: true, creditUsd: 5, spentUsd: 5 }, report: { configured: true, creditUsd: 5, spentUsd: 1 } },
        gemini: [{ id: 'g1', owner_user_id: null, status: 'active' }, { id: 'g2', owner_user_id: null, status: 'cooldown', cooldown_until: new Date(now + 60000).toISOString() },
                 { id: 'g3', owner_user_id: 'u2', status: 'invalid' }],
        envApify: false, envGemini: true, now
    });
    assert.deepStrictEqual([d.apify.shared.total, d.apify.shared['out of credit'], d.apify.shared.invalid], [3 - 1, 1, 1]);
    assert.deepStrictEqual([d.gemini.shared.active, d.gemini.shared.cooldown, d.gemini.personal.invalid], [1, 1, 1]);
    const [nadia, sam, rafi] = d.people;
    assert.strictEqual(nadia.apify.next.leadgen, 'own key');
    assert.strictEqual(sam.apify.next.leadgen, 'nothing (own key only)');
    assert.strictEqual(sam.gemini.next, 'nothing (own key only)', 'an own-keys-only person was sent to the shared pool');
    assert.strictEqual(rafi.apify.next.leadgen, 'nothing', 'a spent primary and a spent pool key still counted');
    assert.strictEqual(rafi.apify.next.report, 'company primary');
    assert.strictEqual(rafi.gemini.next, 'shared pool');
    assert.strictEqual(rafi.name, 'rafi');
});
test('a staff member\'s own AI key comes first — Edge Meta AI included — and a rate-limited key hands over mid-answer', async () => {
    const own = await call('POST', '/api/gemini-keys', { token: 't-emp', body: { key: 'AIzaEMPOWNkeyAAAAAAAAAAAAAAAAAA', label: 'mine' } });
    assert.strictEqual(own.statusCode, 201, JSON.stringify(own.body));
    const pool = await call('POST', '/api/gemini-keys', { token: 't-admin', body: { key: 'AIzaSHAREDpoolBBBBBBBBBBBBBBBBB', label: 'pool', global: true } });
    assert.strictEqual(pool.statusCode, 201, JSON.stringify(pool.body));
    state.empKey = own.body.key.id;
    const c = await S.geminiCandidates(EMP.id);
    assert.deepStrictEqual(c.map(x => x.source), ['personal', 'pool', 'env']);
    // The chat is called with no user id; the request's own context says who is asking.
    XP.script = [{ parts: [{ text: 'On your key.' }] }];
    XP.requests.length = 0;
    const r = await call('POST', '/api/xp/chat', { token: 't-emp', body: { clientId: state.C, message: 'How is reach this week?' } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.strictEqual(XP.requests[0]._key, 'AIzaEMPOWNkeyAAAAAAAAAAAAAAAAAA', 'Edge Meta AI did not use the person\'s own key: ' + XP.requests[0]._key);
    XP.script = [{ throw: '429 RESOURCE_EXHAUSTED: quota' }, { parts: [{ text: 'On the pool.' }] }];
    XP.requests.length = 0;
    const r2 = await call('POST', '/api/xp/chat', { token: 't-emp', body: { clientId: state.C, message: 'And views?', conversationId: r.body.conversationId } });
    assert.strictEqual(r2.statusCode, 200, JSON.stringify(r2.body));
    assert.strictEqual(r2.body.reply, 'On the pool.');
    assert.deepStrictEqual(XP.requests.map(x => x._key), ['AIzaEMPOWNkeyAAAAAAAAAAAAAAAAAA', 'AIzaSHAREDpoolBBBBBBBBBBBBBBBBB']);
    await new Promise(r3 => setTimeout(r3, 10));
    assert.strictEqual(tbl('gemini_keys').find(k => k.id === state.empKey).status, 'cooldown', 'the rate-limited key was not rested');
});
test('"own keys only" holds for AI too: no shared pool, no server key, and it says why', async () => {
    const set = await call('PATCH', `/api/admin/users/${EMP.id}`, { token: 't-admin', body: { byoKeyOnly: true } });
    assert.strictEqual(set.statusCode, 200, JSON.stringify(set.body));
    const resting = await S.geminiCandidates(EMP.id);
    assert.strictEqual(resting.length, 0, 'an own-keys-only person reached shared keys: ' + resting.map(x => x.source).join(','));
    assert.ok(resting.byoMissing);
    const r = await S.geminiCallDetailed('{"q":1}', { userId: EMP.id, tag: 'test' });
    assert.deepStrictEqual([r.ok, r.reason], [false, 'no_own_key']);
    assert.ok(/own AI key only/.test(S.aiReasonText('no_own_key')));
    await call('POST', `/api/gemini-keys/${state.empKey}/reset`, { token: 't-admin' });
    assert.deepStrictEqual((await S.geminiCandidates(EMP.id)).map(x => x.source), ['personal'], 'a reset key was still resting');
    const view = await call('GET', '/api/admin/key-pools', { token: 't-admin' });
    assert.strictEqual(view.statusCode, 200, JSON.stringify(view.body));
    const me = view.body.people.find(p => p.id === EMP.id);
    assert.deepStrictEqual([me.ownKeysOnly, me.gemini.keys, me.gemini.next], [true, 1, 'own key']);
    assert.ok(view.body.gemini.shared.total >= 1 && view.body.gemini.env === true);
    assert.ok(!JSON.stringify(view.body).includes('AIza'), 'the overview carried a key');
    const staff = await call('GET', '/api/admin/key-pools', { token: 't-emp' });
    assert.strictEqual(staff.statusCode, 403);
    await call('PATCH', `/api/admin/users/${EMP.id}`, { token: 't-admin', body: { byoKeyOnly: false } });
});

section('\nphase 45 — disconnecting Meta deletes what was read from it, the assistant\'s copy included');
// The fake stands in for el_xp_purge the way the SQL defines it: every xp_ row for the business, or only
// the rows of the named connections' assets while another connection remains.
const PURGED = [];
RPC.el_xp_purge = ({ p_client, p_el_connections }) => {
    PURGED.push({ client: p_client, connections: p_el_connections });
    const conns = tbl('xp_meta_connections').filter(c => c.client_id === p_client && (!p_el_connections || p_el_connections.includes(c.el_connection_id)));
    const full = !p_el_connections || !tbl('xp_meta_connections').some(c => c.client_id === p_client && !conns.includes(c));
    const assets = tbl('xp_meta_assets').filter(a => a.client_id === p_client && (full || conns.some(c => c.id === a.connection_id))).map(a => a.id);
    const drop = (name, pred) => { const rows = tbl(name); for (let i = rows.length - 1; i >= 0; i--) if (pred(rows[i])) rows.splice(i, 1); };
    for (const name of ['xp_meta_posts', 'xp_post_metric_snapshots', 'xp_account_metric_snapshots', 'xp_account_metric_observations', 'xp_audience_snapshots', 'xp_post_comments', 'xp_sync_runs'])
        drop(name, r => assets.includes(r.asset_id) || (full && r.client_id === p_client));
    drop('xp_meta_assets', r => assets.includes(r.id));
    drop('xp_meta_connections', r => conns.includes(r));
    if (full) {
        const chats = tbl('xp_ai_conversations').filter(c => c.client_id === p_client).map(c => c.id);
        drop('xp_ai_messages', m => chats.includes(m.conversation_id));
        drop('xp_ai_conversations', c => c.client_id === p_client);
        drop('xp_clients', c => c.id === p_client);
    }
    return { data: { full, assets: assets.length, connections: conns.length }, error: null };
};
function seedWarehouse(clientId, elConnId, platformId) {
    if (!tbl('xp_clients').some(c => c.id === clientId)) tbl('xp_clients').push({ id: clientId, client_name: 'Biz', is_active: true });
    const xc = { id: crypto.randomUUID(), client_id: clientId, el_connection_id: elConnId, meta_user_id: 'fb-' + platformId };
    tbl('xp_meta_connections').push(xc);
    const asset = { id: crypto.randomUUID(), client_id: clientId, connection_id: xc.id, platform: 'FB', asset_id: platformId, status: 'ACTIVE' };
    tbl('xp_meta_assets').push(asset);
    tbl('xp_meta_posts').push({ id: crypto.randomUUID(), client_id: clientId, asset_id: asset.id, caption: 'Weekend special' });
    tbl('xp_post_comments').push({ id: crypto.randomUUID(), client_id: clientId, asset_id: asset.id, author_name: 'nadia.r', message: 'Looks great' });
    tbl('xp_account_metric_snapshots').push({ id: crypto.randomUUID(), client_id: clientId, asset_id: asset.id, reach: 900, is_final: true });
    return asset;
}
test('Disconnect removes the connection, its owner reports and everything the assistant kept; the next read skips the business', async () => {
    const client = await call('POST', '/api/clients', { token: 't-emp', body: { name: 'Disconnect Diner', igHandle: 'disconnectdiner' } });
    assert.strictEqual(client.statusCode, 201, JSON.stringify(client.body));
    const C = client.body.client.id;
    const conn = { id: crypto.randomUUID(), user_id: EMP.id, client_id: C, page_id: '5501', page_name: 'Disconnect Diner', status: 'active', page_token_enc: 'tok', created_at: new Date().toISOString() };
    tbl('meta_connections').push(conn);
    tbl('reports').push({ id: crypto.randomUUID(), user_id: EMP.id, client_id: C, platform: 'meta', report_type: 'meta_monthly', meta_connection_id: conn.id, created_at: new Date().toISOString() });
    seedWarehouse(C, conn.id, '5501');
    tbl('xp_ai_conversations').push({ id: crypto.randomUUID(), client_id: C, title: 'Reach this week', updated_at: new Date().toISOString() });
    const stranger = await call('DELETE', `/api/meta/connections/${conn.id}`, { token: 't-emp2' });
    assert.strictEqual(stranger.statusCode, 404, 'someone else disconnected it');
    const r = await call('DELETE', `/api/meta/connections/${conn.id}`, { token: 't-emp' });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.deepStrictEqual([r.body.deleted.reports, r.body.deleted.assistant], [1, true]);
    assert.deepStrictEqual(PURGED.pop(), { client: C, connections: null }, 'the last connection did not purge the whole business');
    for (const name of ['xp_clients', 'xp_meta_connections', 'xp_meta_assets', 'xp_meta_posts', 'xp_post_comments', 'xp_account_metric_snapshots', 'xp_ai_conversations'])
        assert.ok(!tbl(name).some(x => (x.client_id || x.id) === C), name + ' kept a row after Disconnect');
    assert.ok(!tbl('reports').some(x => x.meta_connection_id === conn.id), 'the owner report survived Disconnect');
    await xp.provisionAll();
    assert.ok(!tbl('xp_clients').some(x => x.id === C), 'the next read re-created the business');
});
test('one Page of two: only that Page\'s copy goes; Meta\'s deletion request purges the assistant too', async () => {
    const C = state.C;
    const a = { id: crypto.randomUUID(), user_id: EMP.id, client_id: C, page_id: '6601', page_name: 'Page A', fb_user_id: 'fbu-66', status: 'active', created_at: new Date().toISOString() };
    const b = { id: crypto.randomUUID(), user_id: EMP.id, client_id: C, page_id: '6602', page_name: 'Page B', fb_user_id: 'fbu-77', status: 'active', created_at: new Date().toISOString() };
    tbl('meta_connections').push(a, b);
    const assetA = seedWarehouse(C, a.id, '6601'), assetB = seedWarehouse(C, b.id, '6602');
    const out = await S.metaDeleteUserData('fbu-66');
    assert.strictEqual(out.connections, 1);
    assert.deepStrictEqual(PURGED.pop(), { client: C, connections: [a.id] }, 'a partial deletion purged the whole business');
    assert.ok(!tbl('xp_meta_assets').some(x => x.id === assetA.id) && !tbl('xp_post_comments').some(x => x.asset_id === assetA.id), 'Page A\'s copy survived');
    assert.ok(tbl('xp_meta_assets').some(x => x.id === assetB.id) && tbl('xp_meta_posts').some(x => x.asset_id === assetB.id), 'Page B\'s copy was deleted with A\'s');
    // A connection deleted some other way (its client deleted, or before phase 45) is found on the next pass.
    tbl('meta_connections').splice(tbl('meta_connections').findIndex(x => x.id === b.id), 1);
    await xp.purgeOrphans();
    assert.ok(!tbl('xp_meta_assets').some(x => x.id === assetB.id), 'an orphaned copy kept being read');
});
test('chats are deleted after 12 months unused; nothing newer is touched', async () => {
    const old = { id: crypto.randomUUID(), client_id: state.C, title: 'Last year', updated_at: new Date(Date.now() - 400 * 86400000).toISOString() };
    const fresh = { id: crypto.randomUUID(), client_id: state.C, title: 'This week', updated_at: new Date().toISOString() };
    tbl('xp_ai_conversations').push(old, fresh);
    const n = await xp.purgeOldChats();
    assert.ok(n >= 1);
    assert.ok(!tbl('xp_ai_conversations').some(c => c.id === old.id), 'a chat older than 12 months survived');
    assert.ok(tbl('xp_ai_conversations').some(c => c.id === fresh.id), 'a recent chat was deleted');
});
test('the login asks for comment access, and production never falls back to a key in the source', async () => {
    const m = await call('GET', '/api/meta/status', { token: 't-admin' });
    assert.strictEqual(m.statusCode, 200, JSON.stringify(m.body));
    for (const s of ['pages_read_user_content', 'instagram_manage_comments', 'read_insights']) assert.ok(m.body.scopes.includes(s), 'missing scope ' + s);
    const { execFileSync } = require('child_process');
    const run = (env) => { try { return execFileSync(process.execPath, ['-e', "require('./xp/security').encrypt('EAAtoken'); console.log('sealed')"], { cwd: path.join(__dirname, '..'), env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', stdio: 'pipe' }).trim(); } catch (e) { return String(e.stderr || e.message); } };
    assert.ok(/APP_ENCRYPTION_KEY is not set/.test(run({ RENDER: 'true' })), 'production sealed a token with the built-in key');
    assert.strictEqual(run({ RENDER: 'true', APP_ENCRYPTION_KEY: 'a'.repeat(64) }), 'sealed');
    assert.strictEqual(run({}), 'sealed', 'local development lost its fallback');
});

section('\nphase 46 — ads and creator posts switched on in Edge Meta AI');
test('the Facebook login asks for read-only ads access', async () => {
    const m = await call('GET', '/api/meta/status', { token: 't-admin' });
    assert.ok(m.body.scopes.includes('ads_read'), m.body.scopes.join(','));
    assert.ok(!m.body.scopes.some(s => /ads_management|publish/.test(s)), 'the login asks to change ads or publish');
});
test('creator posts: the weekly look runs on EdgeLead\'s Apify keys, shows creators, hides customers, and only staff manage it', async () => {
    process.env.APIFY_API_KEY = 'test-apify-key';
    const ago = d => new Date(Date.now() - d * 86400000).toISOString();
    const reel = (id, owner, extra) => ({ id, shortCode: 'SC' + id, url: `https://www.instagram.com/p/SC${id}/`, ownerUsername: owner, type: 'Video', productType: 'clips', timestamp: ago(3), likesCount: 120, commentsCount: 9, caption: 'At @harborcafe', ...extra });
    APIFY.actors['apify/instagram-scraper'] = (input) => {
        if (input.resultsType === 'mentions') return [
            reel('101', 'foodie.maya', { videoPlayCount: 5400, taggedUsers: [{ username: 'harborcafe' }] }),
            reel('102', 'jo.customer', { videoPlayCount: 60, likesCount: 4, taggedUsers: [{ username: 'harborcafe' }] })
        ];
        if (input.resultsType === 'posts') return [
            reel('103', 'harborcafe', { videoPlayCount: 900 }),
            reel('104', 'chef.rahim', { videoPlayCount: 300, coauthorProducers: [{ username: 'harborcafe' }] })
        ];
        if (input.resultsType === 'details') return input.directUrls.map(u => {
            const name = /instagram\.com\/([^/]+)/.exec(u)[1];
            return { username: name, followersCount: name === 'foodie.maya' ? 48000 : name === 'chef.rahim' ? 700 : 150, fullName: name };
        });
        return [];
    };
    const before = APIFY.calls.length;
    const owner = await call('GET', '/api/xp/creators', { token: 't-client', query: { client_id: state.C } });
    assert.strictEqual(owner.statusCode, 403, 'an owner reached the staff list of creator posts');
    const r = await call('POST', '/api/xp/creators/look', { token: 't-emp', body: { clientId: state.C } });
    assert.strictEqual(r.statusCode, 202, JSON.stringify(r.body));
    let page;
    for (let i = 0; i < 100; i++) {
        page = await call('GET', '/api/xp/creators', { token: 't-emp', query: { client_id: state.C } });
        if (page.body.job && page.body.job.finished_at) break;
        await new Promise(res => setTimeout(res, 20));
    }
    assert.strictEqual(page.statusCode, 200, JSON.stringify(page.body));
    assert.ok(page.body.job.finished_at && !page.body.job.error, JSON.stringify(page.body.job));
    const calls = APIFY.calls.slice(before).map(c => c.input.resultsType);
    assert.ok(calls.includes('mentions') && calls.includes('posts'), 'the look did not read the tagged tab and the grid: ' + calls.join(','));
    assert.ok(tbl('apify_usage_events').some(e => e.actor_id === 'apify/instagram-scraper' && e.engine === 'report'), 'the spend was not recorded in EdgeLead\'s ledger');
    const by = Object.fromEntries(page.body.posts.map(p => [p.creator.username, p]));
    assert.ok(!by['harborcafe'], 'the business\'s own post was counted as a creator post');
    assert.deepStrictEqual([by['foodie.maya'].status, by['chef.rahim'].status, by['jo.customer'].status], ['ACTIVE', 'ACTIVE', 'HIDDEN']);
    assert.ok(by['chef.rahim'].collab, 'a collab was not recognised');
    // Only shown posts reach the owner's answers.
    const infl = require(path.join(__dirname, '..', 'xp', 'social', 'influencers'));
    const own = await infl.forOwner(state.C);
    assert.deepStrictEqual(own.posts.map(p => p.creator).sort(), ['@chef.rahim', '@foodie.maya']);
    const show = await call('PATCH', `/api/xp/creators/${by['jo.customer'].id}`, { token: 't-emp', body: { clientId: state.C, status: 'ACTIVE', costUsd: '40' } });
    assert.strictEqual(show.statusCode, 200, JSON.stringify(show.body));
    assert.strictEqual((await infl.forOwner(state.C)).posts.length, 3, 'a post staff showed did not reach the owner');
    delete process.env.APIFY_API_KEY;
});

section('\nGemini keys in Google\'s 2026 format');
test('a new AQ. key is accepted as pasted, junk is refused, and Google decides the rest', () => {
    assert.strictEqual(S.cleanGeminiKey('  "AQ.Ab8RN6Lx_example-KEY.value1234567890"  '), 'AQ.Ab8RN6Lx_example-KEY.value1234567890');
    assert.strictEqual(S.cleanGeminiKey('GEMINI_API_KEY=AIzaSyA1234567890abcdefghijklmnopq'), 'AIzaSyA1234567890abcdefghijklmnopq');
    assert.strictEqual(S.cleanGeminiKey('hello world'), null);
    assert.strictEqual(S.cleanGeminiKey('short'), null);
});
test('an AQ. key is added to the pool; a key Google refuses mid-call hands over to the next one', async () => {
    const add = await call('POST', '/api/gemini-keys', { token: 't-admin', body: { key: 'AQ.Ab8RN6Lx_newformat-pool.key0123456789', label: 'studio 2 free', global: true } });
    assert.strictEqual(add.statusCode, 201, JSON.stringify(add.body));
    const realFetch = global.fetch;
    let n = 0;
    global.fetch = async (url, opts) => {
        if (/:generateContent$/.test(String(url)) && n++ === 0) return { status: 401, ok: false, text: async () => '{"error":{"message":"API keys are not supported by this API"}}', json: async () => ({}) };
        return realFetch(url, opts);
    };
    GEMINI.script = [{ parts: [{ text: '{"ok":true}' }] }];
    try {
        const r = await S.geminiCallDetailed('{"q":1}', { tag: 'test' });
        assert.ok(r.ok, 'a refused key stopped the call instead of moving on: ' + r.reason);
    } finally { global.fetch = realFetch; }
});

section('\nkeys: what each covers, and one personal Apify key for all of a person\'s work');
test('a staff member saves one Apify key for all their work; the admin page says what every key covers', async () => {
    const r = await call('POST', '/api/update-apify-key', { token: 't-emp', body: { newApiKey: 'apify_api_empAllWork0123456789abcdef', engine: 'any' } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.deepStrictEqual([r.body.engine, r.body.scope], ['any', 'personal']);
    const row = tbl('apify_keys').find(k => k.owner_user_id === EMP.id && k.engine === 'any');
    assert.ok(row, 'the all-work key was not stored as engine "any"');
    const v = await call('GET', '/api/admin/key-pools', { token: 't-admin' });
    assert.strictEqual(v.statusCode, 200, JSON.stringify(v.body));
    assert.deepStrictEqual(v.body.coverage.apify.map(e => e.engine), ['leadgen', 'report', 'fb_community', 'fb_page']);
    assert.ok(v.body.coverage.gemini.length && v.body.coverage.whose.length);
    const me = v.body.people.find(p => p.id === EMP.id);
    assert.ok(Object.values(me.apify.next).every(x => x === 'own key'), 'an all-work key did not cover every engine: ' + JSON.stringify(me.apify.next));
});

section('\nstaff are reminded to add their own keys');
test('/api/me tells a staff member which of their own keys are missing; owners and admins are not asked', async () => {
    const emp2 = await call('GET', '/api/me', { token: 't-emp2' });
    assert.deepStrictEqual(emp2.body.ownKeys, { apify: false, ai: false }, JSON.stringify(emp2.body));
    const emp = await call('GET', '/api/me', { token: 't-emp' });
    assert.strictEqual(emp.body.ownKeys.apify, true, 'a saved personal Apify key was not seen');
    assert.strictEqual((await call('GET', '/api/me', { token: 't-client' })).body.ownKeys, undefined, 'an owner was asked for keys');
    assert.strictEqual((await call('GET', '/api/me', { token: 't-admin' })).body.ownKeys, undefined, 'an admin was asked for personal keys');
});

section('\nphase 52: the owner app, finished');
test('an owner login the agency made never runs out, and a self-serve one still does', async () => {
    const row = tbl('app_users').find(u => u.email === 'owner@kitesurf.test');
    assert.strictEqual(row.agency_owner, true, 'the invite did not mark the login as the agency\'s owner login');
    const past = new Date(Date.now() - 86400000).toISOString();
    row.trial_ends_at = past; row.paid_until = null;
    S.invalidateAuth && S.invalidateAuth();
    const me = await call('GET', '/api/me', { token: 't-owner@kitesurf.test' });
    assert.strictEqual(me.statusCode, 200, 'an agency owner login was locked out when its trial date passed: ' + JSON.stringify(me.body));
    assert.strictEqual(me.body.agency_owner, true);
    assert.strictEqual(S.accountState({ role: 'client', is_active: true, agency_owner: true, trial_ends_at: past }), 'paid');
    assert.strictEqual(S.accountState({ role: 'client', is_active: true, trial_ends_at: past }), 'expired', 'a self-serve trial must still end');
    assert.strictEqual(S.accountState({ role: 'client', is_active: false, agency_owner: true }), 'suspended', 'switching a login off must still win');
    const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema-phase52.sql'), 'utf8');
    assert.ok(/when u\.agency_owner is true\s+then 'paid'/.test(sql), 'the SQL account state must agree with the server');
});
test('staff make a new sign-in link for the owner on their business, and only for that login', async () => {
    const ownerId = tbl('app_users').find(u => u.email === 'owner@kitesurf.test').id;
    await call('PATCH', '/api/admin/settings', { token: 't-admin', body: { mail: { configured: false, from: '', appPassword: '' } } });
    const off = await call('POST', `/api/clients/${state.T}/owner-link`, { token: 't-admin', body: { userId: ownerId } });
    if (!off.body.emailed) {
        // Without Gmail the link comes back to pass on — the owner's way back in when their first link expired.
        assert.ok(/type=magiclink|\/ai\/#th=/.test(off.body.link || ''), 'no link to pass on: ' + JSON.stringify(off.body));
    }
    const set = await call('PATCH', '/api/admin/settings', { token: 't-admin', body: { mail: { from: 'agency@gmail.com', appPassword: 'abcd efgh ijkl mnop', fromName: 'Harbor Agency' } } });
    assert.strictEqual(set.statusCode, 200, JSON.stringify(set.body));
    MAIL.sent.length = 0;
    const r = await call('POST', `/api/clients/${state.T}/owner-link`, { token: 't-admin', body: { userId: ownerId } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    // With Gmail set up the link goes to the owner's inbox, not back to the page.
    assert.strictEqual(r.body.emailed, true);
    assert.strictEqual(r.body.link, null);
    const m = MAIL.sent.find(x => x.msg.to === 'owner@kitesurf.test');
    assert.ok(m && /type=magiclink|\/ai\/#th=/.test(m.msg.text), 'no link was mailed');
    const other = await call('POST', `/api/clients/${state.D}/owner-link`, { token: 't-admin', body: { userId: ownerId } });
    assert.strictEqual(other.statusCode, 404, 'a link was made for a login that is not this business\'s owner');
    const team = await call('POST', `/api/clients/${state.T}/owner-link`, { token: 't-admin', body: { userId: EMP.id } });
    assert.strictEqual(team.statusCode, 404, 'a sign-in link was made for someone on the team');
    const owner = await call('POST', `/api/clients/${state.T}/owner-link`, { token: 't-owner@kitesurf.test', body: { userId: ownerId } });
    assert.ok(owner.statusCode === 403 || owner.statusCode === 404, 'an owner made a sign-in link: ' + owner.statusCode);
});
test('when the agency closes the business, the owner\'s access ends: no made-up business, no code, a clear refusal', async () => {
    const before = tbl('clients').length;
    const T = tbl('clients').find(c => c.id === state.T);
    T.archived = true;
    try {
        S.invalidateAuth && S.invalidateAuth();
        const me = await call('GET', '/api/me', { token: 't-owner@kitesurf.test' });
        assert.strictEqual(me.statusCode, 200, JSON.stringify(me.body));
        assert.strictEqual(me.body.business, null, 'the owner still sees a business');
        assert.strictEqual(tbl('clients').length, before, 'an empty "My business" was made for an agency owner login');
        const g = await call('GET', '/api/client/growth', { token: 't-owner@kitesurf.test' });
        assert.strictEqual(g.statusCode, 403, JSON.stringify(g.body));
        assert.strictEqual(g.body.code, 'no_business');
        const run = await call('POST', '/api/generate-ig-report', { token: 't-owner@kitesurf.test', body: { target: 'kitesurf' } });
        assert.strictEqual(run.statusCode, 403, 'work started for an owner with no business: ' + JSON.stringify(run.body));
        assert.strictEqual(run.body.code, 'no_business');
        MAIL.sent.length = 0;
        const code = await call('POST', '/api/public/owner-code', { body: { email: 'owner@kitesurf.test' }, ip: '10.52.0.1' });
        assert.strictEqual(code.statusCode, 200);
        assert.ok(!MAIL.sent.some(x => x.msg.to === 'owner@kitesurf.test'), 'a sign-in code went to an owner whose business is closed');
        // A self-serve signup with no record still gets one, as before.
        const SELF = person('self@serve.test'); TOKENS['t-self'] = SELF;
        const self = await call('GET', '/api/me', { token: 't-self' });
        assert.ok(self.body.business && self.body.business.id, 'a self-serve signup lost its own business');
    } finally { T.archived = false; S.invalidateAuth && S.invalidateAuth(); }
});
test('each person keeps their own chats: the owner never sees the team\'s, the team keeps the old shared ones', async () => {
    const now = Date.now();
    const mk = (user_id, title, i) => ({ id: crypto.randomUUID(), client_id: state.C, user_id, title, created_at: new Date(now - i * 1000).toISOString(), updated_at: new Date(now - i * 1000).toISOString() });
    const team = mk(EMP.id, 'Team: pricing ideas', 1), legacy = mk(null, 'Before phase 52', 2), mine = mk(CLIENT.id, 'Owner: reach', 3);
    tbl('xp_ai_conversations').push(team, legacy, mine);
    const o = await call('GET', `/api/xp/chat/${state.C}/conversations`, { token: 't-client' });
    assert.strictEqual(o.statusCode, 200, JSON.stringify(o.body));
    const oIds = o.body.conversations.map(c => c.id);
    assert.ok(oIds.includes(mine.id), 'the owner lost their own chat');
    assert.ok(!oIds.includes(team.id) && !oIds.includes(legacy.id), 'the owner sees the team\'s chats');
    const e = await call('GET', `/api/xp/chat/${state.C}/conversations`, { token: 't-emp', query: { client_id: state.C } });
    const eIds = e.body.conversations.map(c => c.id);
    assert.ok(eIds.includes(team.id) && eIds.includes(legacy.id), 'the team lost its chats');
    assert.ok(!eIds.includes(mine.id), 'the team sees the owner\'s chats');
    assert.strictEqual((await call('GET', `/api/xp/chat/${state.C}/conversations/${team.id}`, { token: 't-client' })).statusCode, 404);
    assert.strictEqual((await call('PATCH', `/api/xp/chat/${state.C}/conversations/${mine.id}`, { token: 't-emp', body: { title: 'Mine now' } })).statusCode, 404);
    assert.strictEqual((await call('DELETE', `/api/xp/chat/${state.C}/conversations/${legacy.id}`, { token: 't-client' })).statusCode, 404);
    assert.strictEqual(tbl('xp_ai_conversations').find(c => c.id === mine.id).title, 'Owner: reach');
    // A question in someone else's chat starts a new chat of the asker's own.
    XP.script = [{ parts: [{ text: 'Reach was best on Tuesday.' }] }];
    const r = await call('POST', '/api/xp/chat', { token: 't-client', body: { message: 'Which day had the most reach?', conversationId: team.id } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.notStrictEqual(r.body.conversationId, team.id, 'the owner continued the team\'s chat');
    assert.strictEqual(tbl('xp_ai_conversations').find(c => c.id === r.body.conversationId).user_id, CLIENT.id);
});
test('the owner app: refusals take the whole screen with a way out, the menus sit above the drawer, the shell precaches', () => {
    const FRONT = path.join(__dirname, '..', 'frontend');
    const h = fs.readFileSync(path.join(FRONT, 'header.js'), 'utf8');
    assert.ok(/code === 'no_business'/.test(h) && /blockNoBusiness/.test(h), 'no access-ended screen');
    assert.ok(/data-el-out/.test(h), 'a refusal screen has no Sign out');
    assert.ok(/if \(!app && !EL\.isEmbedded\(\)\) renderShell\(page, null\)/.test(h), 'the staff sidebar is drawn around the app\'s error screen');
    const ai = fs.readFileSync(path.join(FRONT, 'ai', 'index.html'), 'utf8');
    assert.ok(/error_code/.test(ai), 'an expired invite link is not explained in the app');
    assert.ok(/me\.agency_owner && !me\.business/.test(ai));
    const chat = fs.readFileSync(path.join(FRONT, 'meta-ai.js'), 'utf8');
    assert.ok(/EL\.refused\(res\.status, data\)/.test(chat), 'the chat\'s own requests do not handle a lost session');
    const css = fs.readFileSync(path.join(FRONT, 'meta-ai.css'), 'utf8');
    assert.ok(/\.oa-menu \{ position: fixed; z-index: 80;/.test(css), 'a chat\'s menu opens under the drawer');
    const sw = fs.readFileSync(path.join(FRONT, 'sw.js'), 'utf8');
    const shell = JSON.parse(sw.match(/const SHELL = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"'));
    assert.strictEqual(new Set(shell).size, shell.length, 'a duplicate in the shell list makes the whole precache fail');
});

section('\nphase 53: the agency\'s workflow');
test('two people edit one task: the later save is refused with the newer version, never silently over it', async () => {
    const mk = await call('POST', `/api/clients/${state.C}/tasks`, { token: 't-emp', body: { title: 'Shoot the brunch menu' } });
    assert.strictEqual(mk.statusCode, 201, JSON.stringify(mk.body));
    const opened = mk.body.task;
    await new Promise(r => setTimeout(r, 5));
    const first = await call('PATCH', `/api/tasks/${opened.id}`, { token: 't-admin', body: { notes: 'Use the window light', baseUpdatedAt: opened.updatedAt } });
    assert.strictEqual(first.statusCode, 200, JSON.stringify(first.body));
    const second = await call('PATCH', `/api/tasks/${opened.id}`, { token: 't-emp', body: { notes: 'Bring the ring light', baseUpdatedAt: opened.updatedAt } });
    assert.strictEqual(second.statusCode, 409, 'a stale save went through: ' + JSON.stringify(second.body));
    assert.strictEqual(second.body.code, 'task_conflict');
    assert.strictEqual(second.body.task.notes, 'Use the window light', 'the refusal did not hand back the newer version');
    assert.strictEqual(tbl('client_tasks').find(t => t.id === opened.id).notes, 'Use the window light', 'the stale save was written');
    const mine = await call('PATCH', `/api/tasks/${opened.id}`, { token: 't-emp', body: { notes: 'Bring the ring light', baseUpdatedAt: second.body.task.updatedAt } });
    assert.strictEqual(mine.statusCode, 200, 'choosing to save over the newer version did not work');
    const drag = await call('PATCH', `/api/tasks/${opened.id}`, { token: 't-emp', body: { status: 'doing' } });
    assert.strictEqual(drag.statusCode, 200, 'a move on the board (no version sent) was refused');
});
test('archiving a client pauses its schedules and its Meta reads; unarchiving resumes only what archiving paused', async () => {
    const mk = await call('POST', '/api/clients', { token: 't-admin', body: { name: 'Seasonal Kiosk' } });
    const K = mk.body.client.id;
    const now = new Date().toISOString();
    const live = { id: crypto.randomUUID(), user_id: ADMIN.id, client_id: K, job_type: 'ig_report', engine: 'report', input: {}, next_run_at: now, paused: false };
    const mine = { id: crypto.randomUUID(), user_id: ADMIN.id, client_id: K, job_type: 'ig_report', engine: 'report', input: {}, next_run_at: now, paused: true, last_status: 'done' };
    tbl('schedules').push(live, mine);
    tbl('xp_clients').push({ id: K, client_name: 'Seasonal Kiosk', is_active: true });
    tbl('meta_connections').push({ id: crypto.randomUUID(), user_id: ADMIN.id, client_id: K, page_id: 'kiosk-page', status: 'active' });
    const off = await call('PATCH', `/api/clients/${K}`, { token: 't-admin', body: { archived: true } });
    assert.strictEqual(off.statusCode, 200, JSON.stringify(off.body));
    assert.strictEqual(tbl('schedules').find(x => x.id === live.id).paused, true, 'an archived client kept its schedule running');
    assert.strictEqual(tbl('xp_clients').find(x => x.id === K).is_active, false, 'Edge Meta AI kept reading an archived client');
    const on = await call('PATCH', `/api/clients/${K}`, { token: 't-admin', body: { archived: false } });
    assert.strictEqual(on.statusCode, 200);
    assert.strictEqual(tbl('schedules').find(x => x.id === live.id).paused, false, 'unarchiving did not resume the schedule');
    assert.strictEqual(tbl('schedules').find(x => x.id === mine.id).paused, true, 'unarchiving resumed a schedule the team had paused itself');
    assert.strictEqual(tbl('xp_clients').find(x => x.id === K).is_active, true);
});
test('a merge carries the calendar, picks, topics, pipeline and assistant chats', async () => {
    const A = (await call('POST', '/api/clients', { token: 't-admin', body: { name: 'Twin Bakery' } })).body.client.id;
    const B = (await call('POST', '/api/clients', { token: 't-admin', body: { name: 'Twin Bakery (dup)' } })).body.client.id;
    const id = () => crypto.randomUUID();
    const post = { id: id(), client_id: B, status: 'idea', planned_on: '2026-11-02' };
    const pick = { id: id(), client_id: B, status: 'shortlisted' };
    const topic = { id: id(), client_id: B, title: 'Sourdough' };
    const lead = { id: id(), client_id: B, platform: 'instagram', username: 'flourpower', kind: 'influencer', stage: 'new' };
    const chat = { id: id(), client_id: B, title: 'Weekend sales' };
    tbl('content_posts').push(post); tbl('content_picks').push(pick); tbl('content_topics').push(topic);
    tbl('lead_pipeline').push(lead); tbl('xp_ai_conversations').push(chat);
    const dry = await call('POST', `/api/clients/${A}/merge`, { token: 't-admin', body: { fromId: B, dry: '1' } });
    assert.strictEqual(dry.statusCode, 200, JSON.stringify(dry.body));
    for (const t of ['content_posts', 'content_picks', 'content_topics', 'lead_pipeline', 'xp_ai_conversations']) assert.strictEqual(dry.body.counts[t], 1, t + ' is not counted by the merge');
    const r = await call('POST', `/api/clients/${A}/merge`, { token: 't-admin', body: { fromId: B } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    for (const [t, row] of [['content_posts', post], ['content_picks', pick], ['content_topics', topic], ['lead_pipeline', lead], ['xp_ai_conversations', chat]]) {
        assert.strictEqual(tbl(t).find(x => x.id === row.id).client_id, A, t + ' was left on the archived record');
    }
    assert.strictEqual(tbl('clients').find(c => c.id === B).archived, true);
});
test('an editor on the team invites the business owner, and the screens call the team\'s lead "Account lead"', async () => {
    const FRONT = path.join(__dirname, '..', 'frontend');
    const ws = fs.readFileSync(path.join(FRONT, 'workspace.html'), 'utf8');
    assert.ok(/'Account lead'/.test(ws) && !/<h2>Owner portal<\/h2>/.test(ws), 'the two meanings of "Owner" are still mixed');
    assert.ok(/\$\{canEdit\(\) \? `<div class="ws-form">\s*<div class="ws-form two"><div><label for="o-email">/.test(ws), 'editors are not offered the invite');
    const src = serverSource();
    const route = src.slice(src.indexOf("app.post('/api/clients/:id/portal-invite'"), src.indexOf("app.post('/api/clients/:id/portal-invite'") + 900);
    assert.ok(/clientAccess\(ctx\.user\.id, req\.params\.id, 'editor'\)/.test(route), 'the invite still needs the account lead');
});

section('\nphase 54: reliability and speed');
test('the clients list counts reports in the database, past the 1,000-row cap', async () => {
    const mk = await call('POST', '/api/clients', { token: 't-admin', body: { name: 'Busy Studio' } });
    const B = mk.body.client.id;
    for (let i = 0; i < 1203; i++) tbl('reports').push({ id: crypto.randomUUID(), user_id: ADMIN.id, client_id: B, report_type: i % 3 ? 'ig_audit' : 'monthly', created_at: new Date().toISOString() });
    const r = await call('GET', '/api/clients', { token: 't-admin' });
    assert.strictEqual(r.statusCode, 200);
    const row = r.body.clients.find(c => c.id === B);
    assert.strictEqual(row.reports.total, 1203, 'the count stopped short: ' + row.reports.total);
    assert.strictEqual(row.reports.byType.monthly, 401);
    DB.reports = DB.reports.filter(x => x.client_id !== B);
});
test('My tasks still lists only clients the person can open, now in a handful of queries', async () => {
    const r = await call('GET', '/api/my-tasks', { token: 't-emp' });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    for (const t of r.body.tasks) assert.ok(t.client && t.client.name, 'a task came back without its client');
    const foreign = { id: crypto.randomUUID(), client_id: crypto.randomUUID(), title: 'Not yours', status: 'todo', assignee_user_id: EMP.id, created_at: new Date().toISOString() };
    tbl('client_tasks').push(foreign);
    const again = await call('GET', '/api/my-tasks', { token: 't-emp' });
    assert.ok(!again.body.tasks.some(t => t.id === foreign.id), 'a task on a client the person cannot open was listed');
});
test('the twice-daily read is a slot: run once by whoever claims it first, and caught up after the server slept', async () => {
    const X = require(path.join(__dirname, '..', 'xp'));
    assert.deepStrictEqual(X.cronSlots('0 9,21 * * *'), { minute: 0, hours: [9, 21] });
    assert.strictEqual(X.cronSlots('*/5 * * * *'), null, 'an unsupported schedule must fall back to node-cron');
    assert.strictEqual(X.lastSlot('0 9,21 * * *', Date.parse('2026-10-06T10:40:00Z')), '2026-10-06T09:00:00.000Z');
    assert.strictEqual(X.lastSlot('0 9,21 * * *', Date.parse('2026-10-06T08:59:00Z')), '2026-10-05T21:00:00.000Z');
    DB.system_settings = (DB.system_settings || []).filter(r => r.key !== 'xp_cron_last_slot');
    let runs = 0; const run = async () => { runs += 1; return { ok: true }; };
    const late = Date.parse('2026-10-06T10:40:00Z');     // asleep at 09:00, woken at 10:40
    const [a, b] = await Promise.all([X.tickSlot(late, run), X.tickSlot(late, run)]);
    assert.strictEqual(runs, 1, 'the slot ran twice');
    assert.ok(a.ran || b.ran, 'the missed 09:00 read was not caught up');
    const again = await X.tickSlot(late + 5 * 60000, run);
    assert.strictEqual(again.ran, false); assert.strictEqual(runs, 1, 'the same slot ran again five minutes later');
    const evening = await X.tickSlot(Date.parse('2026-10-06T21:03:00Z'), run);
    assert.strictEqual(evening.ran, true); assert.strictEqual(runs, 2);
    assert.strictEqual(await X.claimSlot('2026-10-06T21:00:00.000Z'), false, 'a slot already run was claimed again');
    // Two instances claiming the next slot at the same moment: the database lets exactly one through.
    const both = await Promise.all([X.claimSlot('2026-10-07T09:00:00.000Z'), X.claimSlot('2026-10-07T09:00:00.000Z')]);
    assert.deepStrictEqual(both.filter(Boolean).length, 1, 'two instances both claimed one slot: ' + JSON.stringify(both));
});
test('a shutting-down server parks only its own jobs, never another instance\'s', () => {
    const src = serverSource();
    const at = src.indexOf('async function gracefulShutdown');
    const shut = src.slice(at, src.indexOf('\n}\n', at));
    assert.ok(/\.in\('id', mine\)/.test(shut), 'shutdown still parks every running job in the table');
    assert.ok(S.LOCAL_JOBS instanceof Set);
    assert.ok(/LOCAL_JOBS\.add\(String\(jobId\)\)/.test(src) && /LOCAL_JOBS\.delete\(String\(jobId\)\)/.test(src));
});
test('Gemini calls time out; the pages load pinned CDN builds; the service worker answers a slow network from its cache', () => {
    const src = serverSource();
    assert.ok((src.match(/signal: AbortSignal\.timeout\(GEMINI_TIMEOUT_MS\)/g) || []).length >= 2, 'a Gemini call can still hang for ever');
    const FRONT = path.join(__dirname, '..', 'frontend');
    const pages = fs.readdirSync(FRONT).filter(f => f.endsWith('.html')).map(f => path.join(FRONT, f)).concat([path.join(FRONT, 'ai', 'index.html')]);
    for (const f of pages) {
        const html = fs.readFileSync(f, 'utf8');
        for (const m of html.matchAll(/src="https:\/\/cdn\.jsdelivr\.net\/npm\/([^"]+)"/g)) {
            assert.ok(/@\d+\.\d+\.\d+\//.test(m[1]), `${path.basename(f)} loads an unpinned ${m[1]}`);
        }
    }
    const sw = fs.readFileSync(path.join(FRONT, 'sw.js'), 'utf8');
    assert.ok(/NET_WAIT_MS/.test(sw) && /MAX_ENTRIES/.test(sw) && /u\.search = ''/.test(sw));
});

section('\nphase 56: the Clients hub — trials, stages, who signed in');
test('a trial: the owner is in while it runs, told it ended after, and back the moment it is extended or converted', async () => {
    MAIL.sent.length = 0;
    const mk = await call('POST', '/api/clients', { token: 't-emp', body: { name: 'Sunset Yoga', trialDays: 14 } });
    assert.strictEqual(mk.statusCode, 201, JSON.stringify(mk.body));
    const Y = mk.body.client;
    assert.ok(Y.trial_ends_at && Date.parse(Y.trial_ends_at) > Date.now() + 13 * 86400000, 'the trial was not set for 14 days');
    assert.strictEqual((await call('POST', '/api/clients', { token: 't-emp', body: { name: 'Bad', trialDays: 400 } })).statusCode, 400);
    const inv = await call('POST', `/api/clients/${Y.id}/portal-invite`, { token: 't-emp', body: { email: 'ana@sunsetyoga.test' } });
    assert.ok([200, 201].includes(inv.statusCode), JSON.stringify(inv.body));
    const tok = 't-ana@sunsetyoga.test';
    const during = await call('GET', '/api/me', { token: tok });
    assert.strictEqual(during.body.business && during.body.business.id, Y.id, 'the owner could not open their trial');
    // The trial runs out.
    tbl('clients').find(c => c.id === Y.id).trial_ends_at = new Date(Date.now() - 60000).toISOString();
    S.invalidateAuth();
    const after = await call('GET', '/api/me', { token: tok });
    assert.strictEqual(after.body.business, null, 'an ended trial still opened');
    assert.ok(after.body.trial_ended && after.body.trial_ended.name === 'Sunset Yoga', 'the app is not told the trial ended: ' + JSON.stringify(after.body.trial_ended));
    assert.strictEqual(tbl('clients').filter(c => c.owner_user_id === during.body.id).length, 0, 'a made-up business was created for an owner whose trial ended');
    const g = await call('GET', '/api/client/growth', { token: tok });
    assert.strictEqual(g.body.code, 'no_business');
    // Staff still see and work on it.
    assert.strictEqual((await call('GET', `/api/clients/${Y.id}`, { token: 't-emp' })).statusCode, 200);
    const ext = await call('POST', `/api/clients/${Y.id}/trial`, { token: 't-emp', body: { action: 'extend', days: 7 } });
    assert.strictEqual(ext.statusCode, 200, JSON.stringify(ext.body));
    assert.ok(Date.parse(ext.body.client.trial_ends_at) > Date.now() + 6 * 86400000, 'an ended trial did not restart from today');
    S.invalidateAuth();
    assert.strictEqual((await call('GET', '/api/me', { token: tok })).body.business.id, Y.id, 'extending did not reopen the app');
    const conv = await call('POST', `/api/clients/${Y.id}/trial`, { token: 't-emp', body: { action: 'convert' } });
    assert.strictEqual(conv.statusCode, 200);
    assert.strictEqual(conv.body.client.trial_ends_at, null);
    assert.ok(conv.body.client.converted_at);
    assert.strictEqual((await call('POST', `/api/clients/${Y.id}/trial`, { token: 't-emp', body: { action: 'convert' } })).statusCode, 400, 'a client was converted twice');
    assert.strictEqual((await call('POST', `/api/clients/${Y.id}/trial`, { token: tok, body: { action: 'extend', days: 30 } })).statusCode, 403, 'an owner extended their own trial');
    state.yoga = Y.id;
});
test('the hub: each client has one stage, its owners with when they last signed in, and the next step', async () => {
    const r = await call('GET', '/api/clients', { token: 't-emp' });
    assert.strictEqual(r.statusCode, 200);
    const y = r.body.clients.find(c => c.id === state.yoga);
    assert.ok(y && y.owners && y.owners.length === 1, 'the owner login is not listed: ' + JSON.stringify(y && y.owners));
    assert.strictEqual(y.owners[0].email, 'ana@sunsetyoga.test');
    assert.ok(y.owners[0].lastSeenAt, 'the owner signed in but the hub does not know');
    assert.strictEqual(y.stage, 'onboarding', 'an owner who signed in, without Meta, is still onboarding: ' + y.stage);
    assert.deepStrictEqual(y.next && y.next.key, 'connect');
    assert.ok(y.xp && 'historyRead' in y.xp);
    // A fresh trial with no owner yet.
    const t = await call('POST', '/api/clients', { token: 't-emp', body: { name: 'Pop-up Market', trialDays: 7 } });
    const r2 = await call('GET', '/api/clients', { token: 't-emp' });
    const pm = r2.body.clients.find(c => c.id === t.body.client.id);
    assert.strictEqual(pm.stage, 'trial');
    assert.ok(pm.trial && pm.trial.daysLeft >= 6 && pm.trial.ended === false, JSON.stringify(pm.trial));
    assert.strictEqual(pm.next.key, 'invite');
    // An owner invited who never opened the link.
    const n = await call('POST', '/api/clients', { token: 't-emp', body: { name: 'Quiet Bookshop' } });
    await call('POST', `/api/clients/${n.body.client.id}/portal-invite`, { token: 't-emp', body: { email: 'quiet@bookshop.test' } });
    const r3 = await call('GET', '/api/clients', { token: 't-emp' });
    const qb = r3.body.clients.find(c => c.id === n.body.client.id);
    assert.strictEqual(qb.stage, 'invited');
    assert.strictEqual(qb.owners[0].lastSeenAt, null);
    assert.strictEqual(qb.next.key, 'resend');
});

section('\nphase 57: the full review — security, data, owner app, workspace');
test('an owner\'s assistant sees only the reports the team shared, never the rest of the business\'s research', async () => {
    const secret = { id: crypto.randomUUID(), user_id: EMP.id, client_id: state.C, report_type: 'ig_report', target_handle: 'rival-research', visible_to_client: false, created_at: new Date().toISOString() };
    const shared = { id: crypto.randomUUID(), user_id: EMP.id, client_id: state.C, report_type: 'ig_report', target_handle: 'harborcafe', visible_to_client: true, created_at: new Date().toISOString() };
    tbl('reports').push(secret, shared);
    const owner = await S.assistantScope(CLIENT.id, state.C, 'client');
    const mine = await S.ASSISTANT_TOOLS.get_my_reports.run(owner, {});
    const ids = JSON.stringify(mine);
    assert.ok(!ids.includes(secret.id) && !ids.includes('rival-research'), 'the owner\'s assistant listed a report the team never shared');
    assert.ok(ids.includes(shared.id), 'a shared report is missing for the owner');
    const detail = await S.ASSISTANT_TOOLS.get_report_detail.run(owner, { report_id: secret.id });
    assert.ok(detail && detail.error, 'the owner\'s assistant opened an unshared report');
    const staff = await S.assistantScope(EMP.id, state.C, 'user');
    assert.ok(JSON.stringify(await S.ASSISTANT_TOOLS.get_my_reports.run(staff, {})).includes(secret.id), 'the team lost its own research');
});
test('a merge into a business the assistant never saw moves its chats too, instead of failing halfway', async () => {
    const A = (await call('POST', '/api/clients', { token: 't-admin', body: { name: 'Fresh Target' } })).body.client.id;
    const B = (await call('POST', '/api/clients', { token: 't-admin', body: { name: 'Fresh Target (old)' } })).body.client.id;
    tbl('xp_ai_conversations').push({ id: crypto.randomUUID(), client_id: B, title: 'Old chat' });
    assert.ok(!tbl('xp_clients').some(x => x.id === A));
    const r = await call('POST', `/api/clients/${A}/merge`, { token: 't-admin', body: { fromId: B } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.ok(tbl('xp_clients').some(x => x.id === A), 'the assistant\'s record of the target was not made before its chats moved');
});
test('deleting a teammate hands over the leads inside their campaigns, not just the campaigns', () => {
    const src = serverSource();
    const list = src.slice(src.indexOf('HAND_OVER = ['), src.indexOf('];', src.indexOf('HAND_OVER = [')));
    assert.ok(/\['campaign_leads', 'user_id'\]/.test(list), 'campaign leads cascade away with the login');
});
test('the monthly report reads Instagram posts without a column only Facebook has; the timeline asks for real columns', () => {
    const src = serverSource();
    const ig = src.slice(src.indexOf("pmDedupe((await supabase.from('posts')"), src.indexOf("pmDedupe((await supabase.from('posts')") + 400);
    assert.ok(!/performance_index/.test(ig), 'posts.performance_index does not exist: the monthly report loses every Instagram post');
    assert.ok(!/verified_band/.test(src), 'fb_suggestions.verified_band does not exist');
});
test('a run is not resumed for an archived or deleted client, or by a switched-off account', async () => {
    const mk = await call('POST', '/api/clients', { token: 't-emp', body: { name: 'Closing Shop' } });
    const cid = mk.body.client.id;
    const job = { user_id: EMP.id, client_id: cid, input: { clientId: cid } };
    assert.strictEqual((await S.jobStillAllowed(job)).ok, true);
    tbl('clients').find(c => c.id === cid).archived = true;
    const no = await S.jobStillAllowed(job);
    assert.strictEqual(no.ok, false, 'a run was resumed for an archived client');
    assert.ok(/archived/.test(no.why));
    assert.strictEqual((await S.jobStillAllowed({ ...job, client_id: crypto.randomUUID(), input: {} })).ok, false, 'a run was resumed for a client that no longer exists');
});
test('owners cannot read the raw report rows; staff still can', async () => {
    const rep = tbl('reports').find(r => r.client_id === state.C && r.visible_to_client === true);
    const o = await call('GET', `/api/report/${rep.id}`, { token: 't-client' });
    assert.ok([403, 404].includes(o.statusCode), 'an owner got the raw report row: ' + o.statusCode);
});
test('a teammate is someone on the team: a business owner\'s login is refused, with the way to invite them instead', async () => {
    const r = await call('POST', `/api/clients/${state.C}/members`, { token: 't-admin', body: { email: 'nobody@nowhere.test' } });
    assert.strictEqual(r.statusCode, 404);
    assert.ok(/Team & settings/.test(r.body.error) && !/sign up/i.test(r.body.error), 'the message still sends people to the trial signup: ' + r.body.error);
});
test('extending needs a trial; a self-serve business\'s own login counts as its owner in the hub', async () => {
    const mk = await call('POST', '/api/clients', { token: 't-emp', body: { name: 'Steady Client' } });
    const ext = await call('POST', `/api/clients/${mk.body.client.id}/trial`, { token: 't-emp', body: { action: 'extend', days: 7 } });
    assert.strictEqual(ext.statusCode, 400, 'a regular client was put on a trial by "extend"');
    const SELF2 = person('selfserve2@shop.test'); TOKENS['t-self2'] = SELF2;
    const me = await call('GET', '/api/me', { token: 't-self2' });
    const own = me.body.business.id;
    const r = await call('GET', '/api/clients', { token: 't-admin' });
    const row = r.body.clients.find(c => c.id === own);
    assert.ok(row && row.owners.some(o => o.email === 'selfserve2@shop.test'), 'the self-serve owner is not listed as the owner');
    assert.notStrictEqual(row.next && row.next.key, 'invite', 'a business with its owner already in was told to invite the owner');
});
test('an owner whose trial ended still gets a code, so signing in can tell them; a sign-in link is refused until it is extended', async () => {
    const mk = await call('POST', '/api/clients', { token: 't-emp', body: { name: 'Short Trial', trialDays: 7 } });
    const T = mk.body.client.id;
    await call('POST', `/api/clients/${T}/portal-invite`, { token: 't-emp', body: { email: 'ended@trial.test' } });
    tbl('clients').find(c => c.id === T).trial_ends_at = new Date(Date.now() - 60000).toISOString();
    const set = await call('PATCH', '/api/admin/settings', { token: 't-admin', body: { mail: { from: 'agency@gmail.com', appPassword: 'abcd efgh ijkl mnop', fromName: 'Harbor Agency' } } });
    assert.strictEqual(set.statusCode, 200);
    MAIL.sent.length = 0;
    await call('POST', '/api/public/owner-code', { body: { email: 'ended@trial.test' }, ip: '10.57.0.1' });
    assert.ok(MAIL.sent.some(x => x.msg.to === 'ended@trial.test'), 'an owner whose trial ended could never learn it ended');
    const uid = tbl('app_users').find(u => u.email === 'ended@trial.test').id;
    const link = await call('POST', `/api/clients/${T}/owner-link`, { token: 't-emp', body: { userId: uid } });
    assert.strictEqual(link.statusCode, 400);
    assert.ok(/Extend the trial/.test(link.body.error), link.body.error);
    const g = await call('GET', '/api/client/growth', { token: 't-ended@trial.test' });
    assert.strictEqual(g.body.code, 'no_business');
    assert.ok(g.body.trial && g.body.trial.name === 'Short Trial', 'the refusal does not say the trial ended');
});
test('the pages: sign-out lands on the app, not /ai/ai/; lists that cover every client are not narrowed to the last one opened', () => {
    const FRONT = path.join(__dirname, '..', 'frontend');
    const h = fs.readFileSync(path.join(FRONT, 'header.js'), 'utf8');
    assert.ok(/new URL\(\(EL\._app \|\| EL\.isEmbedded\(\)\) && owner \? 'ai\/' : 'index\.html', document\.baseURI\)/.test(h), 'sign-out resolves against the address, not the base');
    assert.ok(/opts\.scoped === false \? null : EL\.clientId\(\)/.test(h));
    assert.ok(/scoped: false/.test(fs.readFileSync(path.join(FRONT, 'pipeline.html'), 'utf8')), 'the pipeline is still narrowed to the remembered client');
    assert.ok(/scoped: false/.test(fs.readFileSync(path.join(FRONT, 'home.html'), 'utf8')));
    const html = fs.readdirSync(FRONT).filter(f => f.endsWith('.html'));
    for (const f of html) assert.ok(!/cdn\.jsdelivr\.net\/npm\/@supabase/.test(fs.readFileSync(path.join(FRONT, f), 'utf8')), f + ' still loads the sign-in library from the CDN');
    assert.ok(fs.existsSync(path.join(FRONT, 'vendor', 'supabase-js-2.116.0.js')));
});

section('\nphase 59: Websites — one label\'s work across every client');
test('website work: a typed "website" is filed as Website and listed across clients, only where the caller can open the client', async () => {
    const a = await call('POST', `/api/clients/${state.D}/tasks`, { token: 't-emp', body: { title: 'Fix the booking form on the site', labels: ['website', 'Setup'], assignee: EMP.id } });
    assert.strictEqual(a.statusCode, 201, JSON.stringify(a.body));
    assert.deepStrictEqual(a.body.task.labels, ['Website', 'Setup'], 'a typed label was not filed under the known one');
    const priv = await call('POST', '/api/clients', { token: 't-admin', body: { name: 'Admin-only Bakery' } });
    const hidden = await call('POST', `/api/clients/${priv.body.client.id}/tasks`, { token: 't-admin', body: { title: 'New landing page', labels: ['Website'] } });
    assert.strictEqual(hidden.statusCode, 201);
    await call('POST', `/api/clients/${state.D}/tasks`, { token: 't-emp', body: { title: 'Plan October posts', labels: ['Content'] } });

    const r = await call('GET', '/api/tasks', { token: 't-emp', query: { label: 'WEBSITE' } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.label, 'Website');
    const titles = r.body.tasks.map(t => t.title);
    assert.ok(titles.includes('Fix the booking form on the site'), titles.join(' | '));
    assert.ok(!titles.includes('Plan October posts'), 'another label leaked into the website list');
    assert.ok(!titles.includes('New landing page'), 'a client the caller cannot open was listed');
    const t = r.body.tasks.find(x => x.title === 'Fix the booking form on the site');
    assert.strictEqual(t.client.name, 'Bloom Florist'); assert.strictEqual(t.canEdit, true);
    assert.ok(r.body.clients.every(c => c.id && c.name), 'the clients new work can go under');
    assert.ok(!r.body.clients.some(c => c.id === priv.body.client.id));

    const ad = await call('GET', '/api/tasks', { token: 't-admin', query: { label: 'Website' } });
    assert.ok(ad.body.tasks.some(x => x.title === 'New landing page'), 'an admin sees website work on every client');
    tbl('clients').find(c => c.id === priv.body.client.id).archived = true;
    const arch = await call('GET', '/api/tasks', { token: 't-admin', query: { label: 'Website' } });
    assert.ok(!arch.body.tasks.some(x => x.title === 'New landing page'), 'an archived client\'s work is still listed');

    const mine = await call('GET', '/api/my-tasks', { token: 't-emp' });
    assert.ok(mine.body.tasks.some(x => x.title === 'Fix the booking form on the site' && x.labels.includes('Website')), 'website work is not in My tasks');
});
test('website work always has a client: no label, no list; owners and strangers are refused', async () => {
    assert.strictEqual((await call('GET', '/api/tasks', { token: 't-emp' })).statusCode, 400);
    assert.strictEqual((await call('GET', '/api/tasks', { token: 't-owner@kitesurf.test', query: { label: 'Website' } })).statusCode, 403);
    assert.strictEqual((await call('GET', '/api/tasks', { query: { label: 'Website' } })).statusCode, 401);
    // There is no route that makes a task without a client.
    const src = serverSource();
    assert.ok(!/app\.post\('\/api\/tasks'/.test(src), 'a task could be created without a client');
});
test('the pages: Websites is in the menu and in New work; boards and My tasks filter by label', () => {
    const FRONT = path.join(__dirname, '..', 'frontend');
    const h = fs.readFileSync(path.join(FRONT, 'header.js'), 'utf8');
    assert.ok(/href: 'websites\.html',\s+icon: 'globe',\s+label: 'Websites'/.test(h), 'Websites is not in the menu');
    assert.ok(/name: 'Website work'/.test(h), 'Website work is not in New work');
    const ui = fs.readFileSync(path.join(FRONT, 'ui.js'), 'utf8');
    assert.ok(/const LABELS = \['Website'/.test(ui));
    assert.ok(/function labelBar\(/.test(ui) && /hasLabel\(t, label\)/.test(ui), 'the board does not filter by label');
    const mt = fs.readFileSync(path.join(FRONT, 'my-tasks.html'), 'utf8');
    assert.ok(/UI\.labelBar\(/.test(mt) && /UI\.hasLabel\(/.test(mt), 'My tasks does not filter by label');
    const w = fs.readFileSync(path.join(FRONT, 'websites.html'), 'utf8');
    assert.ok(/\/api\/tasks\?label=/.test(w));
    assert.ok(/Which client is it for\?/.test(w), 'new website work does not ask for the client first');
    assert.ok(/labels: \[LABEL\]/.test(w), 'new website work is not labelled Website');
});

section('\nphase 60: packages, the agreement the owner signs, and invoices');
test('packages and invoice details: only an admin sets them; a bad price is refused', async () => {
    assert.strictEqual((await call('PUT', '/api/admin/billing', { token: 't-emp', body: { packages: [] } })).statusCode, 403);
    const bad = await call('PUT', '/api/admin/billing', { token: 't-admin', body: { packages: [{ name: 'Growth', price: -5 }] } });
    assert.strictEqual(bad.statusCode, 400, JSON.stringify(bad.body));
    const r = await call('PUT', '/api/admin/billing', { token: 't-admin', body: {
        packages: [
            { name: 'Social Growth', billing: 'monthly', price: 25000, description: 'Instagram and Facebook, managed', deliverables: '12 posts a month\n4 Reels a month\nMonthly report' },
            { name: 'Website Build', billing: 'one_off', price: 40000, deliverables: ['5-page website', 'Booking form'] }
        ],
        profile: { name: 'Harbor Agency', address: 'Gulshan, Dhaka', terms: 'Fees are paid by the 5th.' }
    } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.packages.length, 2);
    assert.ok(r.body.packages.every(p => p.id), 'a package has no id to pick it by');
    assert.deepStrictEqual(r.body.packages[0].deliverables, ['12 posts a month', '4 Reels a month', 'Monthly report']);
    state.pk = r.body.packages;
    const g = await call('GET', '/api/admin/billing', { token: 't-admin' });
    assert.strictEqual(g.body.profile.name, 'Harbor Agency');
});
test('an agreement is picked from the packages, changed for the client, and goes in the invite email', async () => {
    const items = [{ ...state.pk[0], price: 22000 }, state.pk[1], { name: 'Ad budget management', billing: 'monthly', price: 5000, deliverables: ['Weekly ad check'] }];
    state.adminOnly = (await call('POST', '/api/clients', { token: 't-admin', body: { name: 'Admin-only Tailor' } })).body.client.id;
    assert.strictEqual((await call('PUT', `/api/clients/${state.adminOnly}/agreement`, { token: 't-emp', body: { items } })).statusCode, 404, 'someone not on the client changed its agreement');
    const r = await call('PUT', `/api/clients/${state.D}/agreement`, { token: 't-emp', body: { items, startDate: '2026-11-01', terms: 'Fees are paid by the 5th.' } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    const a = r.body.agreement;
    assert.strictEqual(a.status, 'awaiting'); assert.strictEqual(a.version, 1);
    assert.deepStrictEqual(a.totals, { monthly: 27000, oneOff: 40000 });
    assert.strictEqual(a.items[0].packageId, state.pk[0].id, 'the line forgot which package it came from');
    const same = await call('PUT', `/api/clients/${state.D}/agreement`, { token: 't-emp', body: { items, startDate: '2026-11-01', terms: 'Fees are paid by the 5th.' } });
    assert.strictEqual(same.body.changed, false); assert.strictEqual(same.body.agreement.version, 1);

    MAIL.sent.length = 0;
    const inv = await call('POST', `/api/clients/${state.D}/portal-invite`, { token: 't-emp', body: { email: 'owner@bloom.test', name: 'Rina Akter' } });
    assert.ok([200, 201].includes(inv.statusCode), JSON.stringify(inv.body));
    const mail = MAIL.sent.find(x => x.msg.to === 'owner@bloom.test');
    assert.ok(mail, 'no invite email');
    assert.ok(/Your agreement with us/.test(mail.msg.text) && /৳22,000 a month/.test(mail.msg.text) && /৳40,000 once/.test(mail.msg.text), mail.msg.text);
});
test('the owner signs before anything else: typed name and "I agree"; a changed agreement is signed again', async () => {
    const tok = 't-owner@bloom.test';
    const b = await call('GET', '/api/client/billing', { token: tok });
    assert.strictEqual(b.statusCode, 200, JSON.stringify(b.body));
    assert.strictEqual(b.body.needsSignature, true);
    assert.strictEqual(b.body.agreement.items.length, 3);
    assert.strictEqual((await call('POST', '/api/client/agreement/sign', { token: tok, body: { name: 'Rina Akter' } })).statusCode, 400, 'signed without ticking I agree');
    assert.strictEqual((await call('POST', '/api/client/agreement/sign', { token: tok, body: { name: ' ', agree: true } })).statusCode, 400, 'signed without a name');
    const s = await call('POST', '/api/client/agreement/sign', { token: tok, body: { name: 'Rina Akter', agree: true, version: 1 }, ip: '203.0.113.9' });
    assert.strictEqual(s.statusCode, 200, JSON.stringify(s.body));
    assert.strictEqual(s.body.agreement.status, 'signed');
    const row = tbl('client_agreements').find(x => x.client_id === state.D);
    assert.strictEqual(row.signed_name, 'Rina Akter'); assert.strictEqual(row.signed_ip, '203.0.113.9'); assert.ok(row.signed_at);
    assert.strictEqual((await call('GET', '/api/client/billing', { token: tok })).body.needsSignature, false);

    const items = row.items.slice(0, 2);
    const ch = await call('PUT', `/api/clients/${state.D}/agreement`, { token: 't-emp', body: { items, terms: row.terms, startDate: row.start_date } });
    assert.strictEqual(ch.body.agreement.version, 2); assert.strictEqual(ch.body.agreement.status, 'awaiting');
    assert.strictEqual(ch.body.agreement.signed.name, 'Rina Akter', 'the earlier signature was forgotten');
    const stale = await call('POST', '/api/client/agreement/sign', { token: tok, body: { name: 'Rina Akter', agree: true, version: 1 } });
    assert.strictEqual(stale.statusCode, 409, 'an owner signed a version they were not shown');
    assert.strictEqual((await call('POST', '/api/client/agreement/sign', { token: tok, body: { name: 'Rina Akter', agree: true, version: 2 } })).statusCode, 200);
    assert.strictEqual((await call('GET', '/api/clients/' + state.D + '/agreement', { token: tok })).statusCode, 403, 'an owner read the staff route');
});
test('invoices: made by hand, numbered, shown to the owner, marked paid; void ones are hidden; a paid one is fixed', async () => {
    const tok = 't-owner@bloom.test';
    assert.strictEqual((await call('POST', `/api/clients/${state.D}/invoices`, { token: 't-emp', body: { items: [] } })).statusCode, 400);
    assert.strictEqual((await call('POST', `/api/clients/${state.D}/invoices`, { token: 't-emp', body: { items: [{ text: 'x', qty: 1, price: 1 }], issueDate: '2026-11-05', dueDate: '2026-11-01' } })).statusCode, 400);
    const r = await call('POST', `/api/clients/${state.D}/invoices`, { token: 't-emp', body: {
        items: [{ text: 'Social Growth · November 2026', qty: 1, price: 22000 }, { text: 'Extra Reels', qty: 2, price: 1500 }],
        issueDate: '2026-11-01', dueDate: '2026-11-08', notes: 'Thank you!'
    } });
    assert.strictEqual(r.statusCode, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.invoice.total, 25000);
    const id = r.body.invoice.id;
    tbl('invoices').find(x => x.id === id).invoice_number = 7;             // the database numbers it; the fake does not
    const one = await call('GET', `/api/invoices/${id}`, { token: 't-emp' });
    assert.strictEqual(one.body.invoice.number, 'INV-0007');
    assert.strictEqual(one.body.profile.name, 'Harbor Agency');

    const own = await call('GET', '/api/client/billing', { token: tok });
    assert.ok(own.body.invoices.some(v => v.id === id && v.status === 'unpaid'), 'the owner does not see the invoice');
    assert.strictEqual((await call('GET', `/api/client/invoices/${id}`, { token: tok })).statusCode, 200);
    assert.strictEqual((await call('GET', `/api/client/invoices/${id}`, { token: 't-owner@kitesurf.test' })).statusCode, 404, 'another business read the invoice');
    const hidden = await call('POST', `/api/clients/${state.adminOnly}/invoices`, { token: 't-admin', body: { items: [{ text: 'Setup', qty: 1, price: 900 }] } });
    assert.strictEqual(hidden.statusCode, 201);
    assert.strictEqual((await call('GET', `/api/invoices/${hidden.body.invoice.id}`, { token: 't-emp' })).statusCode, 404, 'someone not on the client read the invoice');
    assert.strictEqual((await call('PATCH', `/api/invoices/${hidden.body.invoice.id}`, { token: 't-emp', body: { status: 'paid' } })).statusCode, 404, 'someone not on the client marked it paid');

    const paid = await call('PATCH', `/api/invoices/${id}`, { token: 't-emp', body: { status: 'paid', paidNote: 'bKash TrxID 8N7A6' } });
    assert.strictEqual(paid.body.invoice.status, 'paid'); assert.ok(paid.body.invoice.paidAt); assert.strictEqual(paid.body.invoice.paidNote, 'bKash TrxID 8N7A6');
    assert.strictEqual((await call('PATCH', `/api/invoices/${id}`, { token: 't-emp', body: { items: [{ text: 'y', qty: 1, price: 1 }] } })).statusCode, 400, 'a paid invoice was changed');

    const v = await call('POST', `/api/clients/${state.D}/invoices`, { token: 't-emp', body: { items: [{ text: 'Mistake', qty: 1, price: 100 }] } });
    await call('PATCH', `/api/invoices/${v.body.invoice.id}`, { token: 't-emp', body: { status: 'void' } });
    const after = await call('GET', '/api/client/billing', { token: tok });
    assert.ok(!after.body.invoices.some(x => x.id === v.body.invoice.id), 'the owner sees a void invoice');

    const all = await call('GET', '/api/billing', { token: 't-emp' });
    assert.strictEqual(all.statusCode, 200, JSON.stringify(all.body));
    const bloom = all.body.clients.find(c => c.id === state.D);
    assert.strictEqual(bloom.agreement.status, 'signed');
    assert.ok(all.body.invoices.some(x => x.id === id && x.client.name === 'Bloom Florist'));
    assert.strictEqual((await call('GET', '/api/billing', { token: tok })).statusCode, 403, 'an owner read the agency’s billing');
});
test('the pages: Billing in the menu, Packages & billing in settings, the owner app signs first and shows invoices', () => {
    const FRONT = path.join(__dirname, '..', 'frontend');
    const read = f => fs.readFileSync(path.join(FRONT, f), 'utf8');
    const h = read('header.js');
    assert.ok(/href: 'billing\.html',\s+icon: 'receipt',\s+label: 'Billing'/.test(h), 'Billing is not in the menu');
    assert.ok(/OWNER_EMBEDS = \[[^\]]*'invoice\.html'/.test(h), 'an owner cannot open an invoice inside the app');
    assert.ok(/data-tab="billing"/.test(read('admin.html')) && /\/api\/admin\/billing/.test(read('admin.html')));
    const hub = read('owner-hub.js');
    assert.ok(/needsSignature && !locked\) openSign\(\)/.test(hub), 'the owner is not asked to sign first');
    assert.ok(/\{ locked: true \}/.test(hub) && /if \(locked\) return;/.test(hub), 'the agreement sheet can be closed unsigned');
    assert.ok(/agree: true, version: a\.version/.test(hub));
    assert.ok(/\/api\/billing'/.test(read('billing.html')) && /window\.print\(\)/.test(read('invoice.html')));
});

section('\nphase 61: pages draw after one trip to the server');
test('the page shell remembers who you are and the clients for the tab, and forgets them when they change', () => {
    const FRONT = path.join(__dirname, '..', 'frontend');
    const read = f => fs.readFileSync(path.join(FRONT, f), 'utf8');
    const h = read('header.js');
    assert.ok(/const remembered = memo\.get\(meKey, ME_FRESH_MS\)/.test(h), 'the page still waits for /api/me before drawing');
    assert.ok(/if \(shape\(fresh\) !== shape\(remembered\)\) location\.reload\(\)/.test(h), 'a changed role or set of tools is not picked up');
    assert.ok(/memo\.clear\(\);\s*try \{ await EL\.supabase\.auth\.signOut\(\)/.test(h), 'signing out leaves the last person’s details in the tab');
    // Every change to a client clears the tab's copy of the list.
    const re = /if \(method !== 'GET' && (\/.*?\/)\.test\(path\)\) EL\.clientsChanged\(\);/.exec(h);
    assert.ok(re, 'changing a client does not clear the remembered list');
    const rx = eval(re[1]);
    for (const p of ['/api/clients', '/api/clients/abc', '/api/clients/abc/merge', '/api/clients/abc/trial']) assert.ok(rx.test(p), p + ' does not clear the list');
    assert.ok(!rx.test('/api/clients/abc/tasks'), 'a task change throws away the client list');
    assert.ok(!/EL\._clients = null;/.test(read('workspace.html') + read('clients.html') + read('ui.js')), 'a page clears the list by hand and misses the tab copy');
    // Home and a client's workspace ask for everything at once.
    assert.ok(/EL\.api\('\/api\/reports-history\?limit=6'[^\n]*\n\s*\]\);/.test(read('home.html')), 'Home asks for its recent reports after everything else');
    assert.ok(/const early = \{\s*timeline: EL\.api/.test(read('workspace.html')), 'the workspace waits for the client before asking for its board');
    assert.ok(/onSaved: saved/.test(read('ui.js')) && /ctx\.onSaved\(r && r\.task\)/.test(read('ui.js')), 'a saved task waits for the whole board to reload');
});

(async () => {
    for (const run of pending) await run();
    console.log('\n' + passed + ' passed');
})();
