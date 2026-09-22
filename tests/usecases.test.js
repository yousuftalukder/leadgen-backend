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
const tbl = t => (DB[t] = DB[t] || []);

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
const stubs = {
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
        GEMINI.requests.push(JSON.parse(opts.body || '{}'));
        const next = GEMINI.script.shift();
        if (!next) return reply(500, 'the test scripted no reply for this turn');
        return reply(200, { candidates: [{ content: { role: 'model', parts: next.parts }, finishReason: 'STOP' }] });
    }
    return reply(404, `the test fake has no answer for ${u}`);
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
test('a lead found by a colleague appears in the client\'s view but not in my own list', async () => {
    // The admin found this one while working on Harbor Cafe. It is theirs in
    // the master list and the client's in the client view.
    const theirs = { id: crypto.randomUUID(), owner_user_id: ADMIN.id, platform: 'instagram', username: 'harborbakery', created_at: new Date().toISOString() };
    tbl('leads').push(theirs);
    await S.linkLeadsToClient(state.C, [theirs.id], 'ig_campaign');
    const view = await call('GET', '/api/leads', { token: 't-emp', query: { client_only: '1', client_id: state.C } });
    assert.ok(view.body.leads.some(l => l.username === 'harborbakery'), 'a colleague\'s find is missing from the client view');
    const mine = await call('GET', '/api/leads', { token: 't-emp' });
    assert.ok(!mine.body.leads.some(l => l.username === 'harborbakery'), 'a colleague\'s lead leaked into my master list');
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

(async () => {
    for (const run of pending) await run();
    console.log('\n' + passed + ' passed');
})();
