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

// ===========================================================================
// AN IN-MEMORY POSTGREST
// ===========================================================================
const DB = {};
const tbl = t => (t === 'leads_master' ? masterView() : (DB[t] = DB[t] || []));

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
    jobs:      { status: 'queued', progress: 0 }
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

class Query {
    constructor(t) { this.t = t; this.op = 'select'; this.f = []; this.ord = []; this.lim = null; this.rng = null; this.one = null; this.count = null; this.head = false; this.rows = null; this.conflict = null; this.patch = null; }
    select(_cols, o = {}) { if (o.count) this.count = o.count; if (o.head) this.head = true; return this; }
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
        if (this.op === 'delete') { const gone = new Set(this._matched()); DB[this.t] = T.filter(r => !gone.has(r)); return { data: null, error: null }; }
        let m = this._matched();
        for (const [c, asc] of this.ord.slice().reverse()) {
            m.sort((a, b) => ((a[c] > b[c]) - (a[c] < b[c])) * (asc ? 1 : -1));
        }
        const count = m.length;
        if (this.rng) m = m.slice(this.rng[0], this.rng[1] + 1);
        if (this.lim != null) m = m.slice(0, this.lim);
        if (this.head) return { data: null, error: null, count };
        return this._shape(m.map(r => ({ ...r })), count);
    }
    then(res, rej) { let out; try { out = this._exec(); } catch (e) { return Promise.reject(e).then(res, rej); } return Promise.resolve(out).then(res, rej); }
    catch(rej) { return this.then(undefined, rej); }
}

const TOKENS = {};   // bearer token -> auth user
const fakeSupabase = {
    from: t => new Query(t),
    rpc: () => Promise.resolve({ data: true, error: null }),
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
            deleteUser: async () => ({ data: {}, error: null })
        }
    }
};

// ===========================================================================
// AN EXPRESS THAT REMEMBERS ITS ROUTES
// ===========================================================================
const ROUTES = [];
const appStub = { set() {}, use() {}, listen() {} };
for (const m of ['get', 'post', 'patch', 'put', 'delete']) {
    // Express accepts an array of paths for one handler, and server.js uses
    // that for the two CSV exports. One entry per path, so matching stays flat.
    appStub[m] = (p, ...h) => { for (const one of [].concat(p)) ROUTES.push({ m: m.toUpperCase(), p: one, h }); };
}
// Outbound mail is nodemailer over Gmail SMTP. The stub keeps every message
// and the transport options it was built with, so a test can read the
// address, the credentials and the text the server actually sent.
const MAIL = { sent: [], fail: null };
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
    express: Object.assign(() => appStub, { json: () => (_, __, n) => n && n(), static: () => () => {} }),
    cors: () => () => {},
    'apify-client': { ApifyClient: class {} },
    '@supabase/supabase-js': { createClient: () => fakeSupabase },
    dotenv: { config() {} }
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
                { id: 'm1', caption: 'The seasonal menu, start to finish.', media_type: 'VIDEO', media_product_type: 'REELS', timestamp: '2026-08-10T10:00:00+0000', like_count: 300, comments_count: 20, permalink: 'https://instagram.com/p/abc', shortcode: 'abc' },
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

function findRoute(method, p) {
    for (const r of ROUTES) {
        if (r.m !== method) continue;
        const keys = [];
        const re = new RegExp('^' + r.p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
        const m = re.exec(p);
        if (m) return { r, params: Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    return null;
}

/** Call a route the way Express would: middleware in order, stop at the first response. */
async function call(method, p, { token, body, query } = {}) {
    const hit = findRoute(method, p);
    if (!hit) throw new Error(`no route ${method} ${p}`);
    const req = {
        method, path: p, originalUrl: p, url: p, params: hit.params,
        body: body || {}, query: query || {}, ip: '127.0.0.1',
        headers: token ? { authorization: 'Bearer ' + token } : {},
        get(h) { return this.headers[String(h).toLowerCase()]; }
    };
    const res = {
        statusCode: 200, body: null, headers: {}, sent: false,
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; this.sent = true; return this; },
        send(b) { this.body = b; this.sent = true; return this; },
        end() { this.sent = true; }, write() {}, flushHeaders() {}, on() {},
        setHeader(k, v) { this.headers[k] = v; },
        set(k, v) { if (typeof k === 'object') Object.assign(this.headers, k); else this.headers[k] = v; return this; },
        get(k) { return this.headers[k]; },
        type() { return this; },
        redirect(u) { this.statusCode = 302; this.headers.location = u; this.sent = true; }
    };
    for (const fn of hit.r.h) {
        if (res.sent) break;
        let next = false;
        await fn(req, res, () => { next = true; });
        if (!next) break;
    }
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
test('adding the client account to the agency\'s record absorbs its empty own record', async () => {
    const r = await call('POST', `/api/clients/${state.C}/members`, { token: 't-admin', body: { email: CLIENT.email, role: 'editor' } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.absorbed, state.own, 'the empty auto-created record was not absorbed');
    const row = tbl('clients').find(c => c.id === state.own);
    assert.strictEqual(row.archived, true, 'absorbed means archived, never deleted');
});
test('the client account now IS the agency\'s record — its runs go there', async () => {
    const cid = await S.resolveClientId({ body: {} }, ctxOf(CLIENT, 'client'));
    assert.strictEqual(cid, state.C, 'a client run would land in a second, separate record');
});
test('…and it can see the work the agency did', async () => {
    const r = await call('GET', '/api/client/reports', { token: 't-client' });
    assert.strictEqual(r.statusCode, 200);
    assert.ok(r.body.reports.some(x => x.handle === 'harborcafe'), 'the agency\'s report is invisible to the client');
});
test('a record with work in it is never absorbed', async () => {
    // D has a job filed under it now; adding its owner as a member elsewhere must not touch it.
    tbl('jobs').push({ id: crypto.randomUUID(), user_id: EMP.id, client_id: state.D, type: 'ig_report', status: 'done', created_at: new Date().toISOString() });
    const owner = person('bloom@florist.test'); TOKENS['t-bloom'] = owner;
    tbl('app_users').push({ id: owner.id, email: owner.email, role: 'client', is_active: true });
    tbl('clients').push({ id: crypto.randomUUID(), owner_user_id: owner.id, name: 'Bloom own', archived: false, created_at: new Date().toISOString() });
    const own = tbl('clients').find(c => c.owner_user_id === owner.id);
    tbl('reports').push({ id: crypto.randomUUID(), user_id: owner.id, client_id: own.id, report_type: 'ig_report', created_at: new Date().toISOString() });
    const r = await call('POST', `/api/clients/${state.C}/members`, { token: 't-admin', body: { email: owner.email, role: 'editor' } });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.body.absorbed, null, 'a record holding a report was archived');
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
    assert.ok(/fb_community/.test(r.body.error));
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
    const r = await call('GET', `/api/client/report/${state.fbRep.id}`, { token: 't-client' });
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
    const r = await call('GET', `/api/client/report/${state.moRep.id}`, { token: 't-client' });
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
    const r = await call('GET', `/api/client/report/${rep.id}`, { token: 't-client' });
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

section('\nthe content plan, with the model told to overspend');
/** Stored posts for one Instagram handle, varied enough to produce cells. */
function seedPosts(handle, spec) {
    const now = Date.now();
    spec.forEach((p, i) => tbl('posts').push({
        id: crypto.randomUUID(), user_id: EMP.id, client_id: state.C, platform: 'instagram', handle,
        shortcode: `${handle.slice(0, 3)}${i}`, post_url: `https://instagram.com/p/${handle.slice(0, 3)}${i}`,
        post_type: p.type, is_video: p.type === 'reel', carousel_count: p.type === 'carousel' ? 5 : null,
        caption: p.caption, hashtags: ['#boston', '#food'], likes: p.likes, comments: p.comments, views: p.type === 'reel' ? p.likes * 12 : null,
        engagement_raw: p.likes + p.comments, is_sponsored: false, is_provisional: false,
        // One post a day, most recent first, so all of them fall in the current
        // month: the index is computed per handle per month, and a post that
        // drifts into last month is scored against a different median.
        posted_at: new Date(now - (i + 1) * 86400000).toISOString(), scraped_at: new Date(now - 3600000).toISOString(),
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
    const r = await call('GET', `/api/client/report/${state.cpReport}`, { token: 't-client' });
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

(async () => {
    for (const run of pending) await run();
    console.log('\n' + passed + ' passed');
})();
