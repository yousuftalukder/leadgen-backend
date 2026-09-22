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
    auth: { getUser: async token => TOKENS[token] ? { data: { user: TOKENS[token] }, error: null } : { data: null, error: { message: 'bad token' } } }
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

(async () => {
    for (const run of pending) await run();
    console.log('\n' + passed + ' passed');
})();
