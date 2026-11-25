#!/usr/bin/env node
/**
 * Phase 93 tests: every row past the 1,000-row page, the parts the owner hands out, and managing leads.
 *
 * What matters: the lead list, Calls and the counts see every row, not the first 1,000 the database answers with;
 * a teammate has neither the Dialer nor Email campaigns until the owner unlocks them, and the server refuses both
 * (a call from Calls still goes through, with its lead); the badge counts only what nobody opened; the owner
 * deletes leads in bulk but never a client; bulk stage moves put leads in the pipeline.
 *
 * The in-memory database here answers at most 1,000 rows per request, like the real one.
 *
 *   node tests/phase93.test.js
 */
'use strict';
const assert = require('assert');
const Module = require('module');
const path = require('path');

// ---- an in-memory database, enough of supabase-js's query builder for these routes ----
let DB = {};
const tbl = t => (DB[t] = DB[t] || []);
let seq = 0;
const newId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const get = (r, c) => { const m = /^(\w+)->>(\w+)$/.exec(c); return m ? (r[m[1]] || {})[m[2]] : r[c]; };
function query(table) {
    const filters = [];
    let op = 'select', payload = null, conflict = null, single = false, head = false, wantCount = false, limit = null, orders = [], from = 0, to = null;
    const q = {
        select(_c, opts = {}) { head = !!opts.head; wantCount = !!opts.count; return q; },
        insert(rows) { op = 'insert'; payload = rows; return q; },
        upsert(rows, o = {}) { op = 'upsert'; payload = rows; conflict = String(o.onConflict || 'id').split(','); return q; },
        update(p) { op = 'update'; payload = p; return q; },
        delete() { op = 'delete'; return q; },
        eq(c, v) { filters.push(r => get(r, c) === v); return q; },
        neq(c, v) { filters.push(r => get(r, c) !== v); return q; },
        in(c, vs) { filters.push(r => vs.includes(get(r, c))); return q; },
        gte(c, v) { filters.push(r => String(get(r, c)) >= String(v)); return q; },
        lte(c, v) { filters.push(r => String(get(r, c)) <= String(v)); return q; },
        lt(c, v) { filters.push(r => String(get(r, c)) < String(v)); return q; },
        is(c, v) { filters.push(r => (get(r, c) ?? null) === v); return q; },
        ilike(c, p) { const re = new RegExp('^' + String(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$', 'i'); filters.push(r => re.test(String(get(r, c) || ''))); return q; },
        like(c, p) { const re = new RegExp('^' + String(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$'); filters.push(r => re.test(String(get(r, c) || ''))); return q; }, or() { return q; },
        not(c, op2, v) { if (op2 === 'is' && v === null) filters.push(r => get(r, c) != null); return q; },
        order(c, o = {}) { orders.push([c, o.ascending !== false]); return q; },
        limit(n) { limit = n; return q; },
        range(a, b) { from = a; to = b; return q; },
        maybeSingle() { single = true; return q; },
        single() { single = true; return q; },
        then(ok, no) { return Promise.resolve().then(run).then(ok, no); }
    };
    function run() {
        const rows = tbl(table);
        const hit = rows.filter(r => filters.every(f => f(r)));
        let data;
        if (op === 'insert') { const add = [].concat(payload).map(r => ({ id: r.id || newId(), at: new Date().toISOString(), created_at: new Date().toISOString(), ...r })); rows.push(...add); data = add; }
        else if (op === 'upsert') data = [].concat(payload).map(r => { const old = rows.find(x => conflict.every(k => x[k] === r[k])); if (old) return Object.assign(old, r); const n = { ...r }; rows.push(n); return n; });
        else if (op === 'update') { hit.forEach(r => Object.assign(r, payload)); data = hit; }
        else if (op === 'delete') { DB[table] = rows.filter(r => !hit.includes(r)); data = hit; }
        else {
            data = [...hit];
            for (const [c, asc] of orders.slice().reverse()) data.sort((a, b) => (String(a[c] ?? '') < String(b[c] ?? '') ? -1 : String(a[c] ?? '') > String(b[c] ?? '') ? 1 : 0) * (asc ? 1 : -1));
            if (to != null) data = data.slice(from, to + 1);
            if (limit != null) data = data.slice(0, limit);
            data = data.slice(0, 1000);   // like the database: 1,000 rows per request at most
        }
        if (head) return { data: null, error: null, count: hit.length };
        if (single) return { data: data[0] ? JSON.parse(JSON.stringify(data[0])) : null, error: null };
        return { data: data.map(r => JSON.parse(JSON.stringify(r))), error: null, count: wantCount ? hit.length : null };
    }
    return q;
}

// ---- the server, with its routes captured ----
const ROUTES = {}, USES = [];
const stubs = {
    express: Object.assign(() => {
        const reg = m => (p, ...h) => { ROUTES[m + ' ' + p] = h[h.length - 1]; };
        return { set() {}, use(p, fn) { if (typeof p === 'string' && fn) USES.push([p, fn]); }, listen() {}, get: reg('GET'), post: reg('POST'), patch: reg('PATCH'), delete: reg('DELETE'), put: reg('PUT') };
    }, { json: () => (_, __, n) => n && n(), raw: () => (_, __, n) => n && n(), static: () => () => {} }),
    cors: () => () => {},
    'apify-client': { ApifyClient: class {} },
    '@supabase/supabase-js': { createClient: () => ({ from: query, rpc: () => query('rpc'), storage: {}, auth: { getUser: async () => ({ data: null, error: new Error('stub') }) } }) },
    dotenv: { config() {} }
};
const realLoad = Module._load;
Module._load = function (req, ...rest) { return stubs[req] !== undefined ? stubs[req] : realLoad.call(this, req, ...rest); };
process.env.SUPABASE_URL = 'http://stub'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
process.env.TWILIO_AUTH_TOKEN = 'tok'; process.env.PHONE_PUBLIC_URL = 'https://api.test';
delete process.env.RENDER;
require(path.join(__dirname, '..', 'server.js'));
const S = require(path.join(__dirname, '..', 'src', 'shared'));

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const OWNER = newId(), TEAM = newId(), CLIENT = newId();
function seed(n = 2) {
    DB = {};
    tbl('app_users').push({ id: OWNER, role: 'admin', is_active: true, email: 'o@x.test', full_name: 'Owner' }, { id: TEAM, role: 'user', is_active: true, email: 't@x.test', full_name: 'Tia' });
    for (let i = 0; i < n; i++) tbl('crm_leads').push({ id: newId(), full_name: 'Lead ' + i, company: 'Business ' + i, phone: '(212) 555-' + String(1000 + i).slice(-4), source: 'website', stage: 'new', tags: [], in_pipeline: false,
        call_status: 'not_called', calls_count: 0, emails_count: 0, created_at: new Date(Date.UTC(2026, 0, 1) + i * 60e3).toISOString(), updated_at: new Date(Date.UTC(2026, 0, 1) + i * 60e3).toISOString() });
}
async function fresh(n) { seed(n); await S.putSetting('phone_access', null); await S.putSetting('feature_access', {}); await S.putSetting('dialer_rules', S.DIALER_DEFAULTS); }
const signIn = (token, id) => { const u = tbl('app_users').find(x => x.id === id); S._authCache.set(S.tokenHash(token), { ctx: { user: { id, email: u.email }, profile: { ...u, paid_until: '2099-01-01T00:00:00Z' } }, t: Date.now() }); };
const mkRes = () => ({ code: 200, body: null, out: '', status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, type() { return this; }, send(x) { this.out = x; return this; }, set() { return this; }, end() { return this; } });
async function call(method, route, { who = TEAM, params = {}, body = {}, query: qy = {} } = {}) {
    signIn('t-' + who, who);
    const h = ROUTES[method + ' ' + route]; assert.ok(h, 'no route ' + method + ' ' + route);
    const res = mkRes();
    await h({ headers: { authorization: 'Bearer t-' + who }, params, body, query: qy, get: () => '' }, res);
    return res;
}
async function gate(path, who) {
    signIn('t-' + who, who);
    const g = USES.find(u => u[0] === path); assert.ok(g, 'no gate on ' + path);
    const res = mkRes(); let passedOn = false;
    await g[1]({ headers: { authorization: 'Bearer t-' + who }, params: {}, body: {}, query: {}, get: () => '' }, res, () => { passedOn = true; });
    return { passedOn, res };
}

// ---- past the database's 1,000-row page ----
test('every lead comes back, not just the first 1,000 the database answers with', async () => {
    await fresh(2500);
    const r = await call('GET', '/api/crm/leads');
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.leads.length, 2500);
    assert.strictEqual(new Set(r.body.leads.map(l => l.id)).size, 2500);
    assert.strictEqual(r.body.leads[0].company, 'Business 2499', 'newest change first');
});
test('selectAll pages with the filters, and stops at max', async () => {
    await fresh(2300);
    tbl('crm_leads').slice(0, 1200).forEach(l => { l.stage = 'contacted'; });
    const rows = await S.selectAll('crm_leads', 'id, stage', q => q.eq('stage', 'contacted'));
    assert.strictEqual(rows.length, 1200); assert.ok(rows.every(l => l.stage === 'contacted'));
    assert.strictEqual((await S.selectAll('crm_leads', 'id', q => q, { max: 1500 })).length, 1500);
});
test('Calls → Home sees every lead with a phone too', async () => {
    await fresh(1800);
    const r = await call('GET', '/api/crm/dialer', { query: { tab: 'all' } });
    assert.strictEqual(r.code, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.counts.all, 1800);
});

// ---- who has the Dialer and Email campaigns ----
test('the owner has both; a teammate has neither until the owner unlocks it', () => {
    assert.deepStrictEqual(S.featuresOf({}, { id: OWNER, role: 'admin' }), { dialer: true, campaigns: true });
    assert.deepStrictEqual(S.featuresOf({}, { id: TEAM, role: 'user' }), { dialer: false, campaigns: false });
    assert.deepStrictEqual(S.featuresOf({ [TEAM]: { campaigns: true } }, { id: TEAM, role: 'user' }), { dialer: false, campaigns: true });
    assert.deepStrictEqual(S.cleanFeatures({ dialer: 'yes', campaigns: true, hack: true }), { dialer: false, campaigns: true });
});
test('Email campaigns are refused until unlocked; the CRM tells the page what each person has', async () => {
    await fresh();
    let g = await gate('/api/crm/campaigns', TEAM);
    assert.strictEqual(g.passedOn, false); assert.strictEqual(g.res.code, 403); assert.strictEqual(g.res.body.code, 'feature_locked');
    assert.strictEqual((await gate('/api/crm/templates', TEAM)).passedOn, false);
    assert.strictEqual((await gate('/api/crm/campaigns', OWNER)).passedOn, true);
    const put = await call('PUT', '/api/admin/features/:id', { who: OWNER, params: { id: TEAM }, body: { campaigns: true } });
    assert.strictEqual(put.code, 200, JSON.stringify(put.body)); assert.deepStrictEqual(put.body.has, { dialer: false, campaigns: true });
    assert.strictEqual((await gate('/api/crm/campaigns', TEAM)).passedOn, true);
    const meta = await call('GET', '/api/crm/meta');
    assert.deepStrictEqual(meta.body.features, { dialer: false, campaigns: true });
    assert.strictEqual((await call('PUT', '/api/admin/features/:id', { params: { id: TEAM }, body: { dialer: true } })).code, 403, 'only the owner hands them out');
    const list = await call('GET', '/api/admin/features', { who: OWNER });
    assert.deepStrictEqual(list.body.people.find(p => p.id === TEAM).has, { dialer: false, campaigns: true });
});
test('the Dialer: its calls and texts are refused while locked, the badge stays quiet, the keypad cannot call; Calls still can', async () => {
    await fresh();
    assert.strictEqual((await call('GET', '/api/phone/inbox')).code, 403);
    assert.strictEqual((await call('GET', '/api/phone/thread/:number', { params: { number: '+12125550100' } })).code, 403);
    assert.deepStrictEqual((await call('GET', '/api/phone/unread')).body, { unread: 0, locked: true });
    process.env.TWILIO_AUTH_TOKEN = 'tok'; process.env.PHONE_PUBLIC_URL = 'https://api.test';
    const hook = async body => { const res = mkRes(); const sig = S.twilioSignature('tok', 'https://api.test/api/phone/hook/voice', body);
        await ROUTES['POST /api/phone/hook/voice']({ body, originalUrl: '/api/phone/hook/voice', path: '/api/phone/hook/voice', get: () => sig }, res); return res.out; };
    const lead = tbl('crm_leads')[0];
    assert.match(await hook({ From: 'client:u_' + TEAM, To: '+12125550199', CallSid: 'CA' + '1'.repeat(32) }), /dialer is locked/);
    assert.match(await hook({ From: 'client:u_' + TEAM, To: '+12125550100', CallSid: 'CA' + '2'.repeat(32), LeadId: lead.id }), /<Dial callerId=/, 'a call from Calls carries its lead');
    await call('PUT', '/api/admin/features/:id', { who: OWNER, params: { id: TEAM }, body: { dialer: true } });
    assert.strictEqual((await call('GET', '/api/phone/inbox')).code, 200);
    assert.match(await hook({ From: 'client:u_' + TEAM, To: '+12125550199', CallSid: 'CA' + '3'.repeat(32) }), /<Dial callerId=/);
});
test('the badge counts what nobody has opened: missed calls, voicemail and texts', async () => {
    await fresh();
    tbl('phone_calls').push({ id: newId(), direction: 'inbound', status: 'no-answer', read_at: null }, { id: newId(), direction: 'inbound', status: 'voicemail', read_at: null },
        { id: newId(), direction: 'inbound', status: 'completed', read_at: null }, { id: newId(), direction: 'inbound', status: 'no-answer', read_at: '2026-11-01T00:00:00Z' }, { id: newId(), direction: 'outbound', status: 'no-answer', read_at: null });
    tbl('phone_messages').push({ id: newId(), direction: 'inbound', read_at: null }, { id: newId(), direction: 'outbound', read_at: null });
    assert.deepStrictEqual((await call('GET', '/api/phone/unread', { who: OWNER })).body, { unread: 3 });
});

// ---- managing leads ----
test('the owner deletes leads in bulk; leads that became clients are kept; a teammate cannot', async () => {
    await fresh(4);
    const ids = tbl('crm_leads').map(l => l.id); tbl('crm_leads')[3].client_id = CLIENT;
    assert.strictEqual((await call('POST', '/api/crm/leads/bulk-delete', { body: { ids } })).code, 403);
    const r = await call('POST', '/api/crm/leads/bulk-delete', { who: OWNER, body: { ids: [...ids, 'not-an-id'] } });
    assert.deepStrictEqual(r.body, { deleted: 3, kept: 1 });
    assert.deepStrictEqual(tbl('crm_leads').map(l => l.id), [ids[3]]);
});
test('bulk move to a stage puts the leads in the pipeline and logs it', async () => {
    await fresh(3);
    const ids = tbl('crm_leads').map(l => l.id);
    const r = await call('POST', '/api/crm/leads/bulk', { body: { ids, set: { stage: 'contacted' } } });
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    assert.ok(tbl('crm_leads').every(l => l.stage === 'contacted' && l.in_pipeline === true));
    assert.strictEqual(tbl('crm_activities').filter(a => a.type === 'stage').length, 3);
});

(async () => {
    console.log('phase 93 :: every row, the locked parts, managing leads');
    for (const [name, fn] of tests) {
        try { await fn(); passed++; console.log('  ok  ' + name); }
        catch (e) { console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).toString().split('\n').slice(0, 4).join('\n       ')); process.exitCode = 1; }
    }
    console.log(`\n${passed} passed${passed === tests.length ? '' : `, ${tests.length - passed} failed`}`);
})();
