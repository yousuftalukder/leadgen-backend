#!/usr/bin/env node
/**
 * Phase 94 tests: the Overview as an operations console.
 *
 * What matters: the numbers are right (a call is counted once, whether the phone placed it or it was logged by
 * hand; a meeting once per lead a day; the hour of a call is the lead's own clock), the console sees every lead past
 * the database's 1,000-row page, it is built once for everybody within 20 seconds, Up next is the caller's own
 * Calls → Today, what someone may not open (email campaigns) is not sent to them, and nothing the server writes into
 * the feed can carry HTML.
 *
 * The in-memory database here answers at most 1,000 rows per request, like the real one.
 *
 *   node tests/phase94.test.js
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
        like(c, p) { const re = new RegExp('^' + String(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$'); filters.push(r => re.test(String(get(r, c) || ''))); return q; }, or(expr) { const parts = String(expr).split(',').map(x => { const [c, o, ...v] = x.split('.'); const val = v.join('.'); return r => o === 'eq' ? String(get(r, c)) === val : o === 'is' && val === 'null' ? (get(r, c) ?? null) === null : true; }); filters.push(r => parts.some(f => f(r))); return q; },
        not(c, op2, v) { if (op2 === 'is' && v === null) filters.push(r => get(r, c) != null); if (op2 === 'in') { const vs = String(v).replace(/[()]/g, '').split(','); filters.push(r => !vs.includes(get(r, c))); } return q; },
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

const H = 3600e3, D = 864e5;
const iso = t => new Date(t).toISOString();
async function fresh94(n) { await fresh(n); S.consoleCacheClear(); }
const leadRow = (o = {}) => ({ id: newId(), full_name: 'Person', company: 'Business', phone: '(212) 555-0100', source: 'website', stage: 'new', tags: [], in_pipeline: false,
    call_status: 'not_called', calls_count: 0, emails_count: 0, created_at: iso(Date.now() - 2 * D), updated_at: iso(Date.now() - 2 * D), ...o });

// ---- the numbers ----
test('the business days: the last n, in its own time zone, across a month end', () => {
    assert.deepStrictEqual(S.consoleDayKeys('America/Chicago', 3, new Date('2026-12-01T03:00:00Z')), ['2026-11-28', '2026-11-29', '2026-11-30']);
    assert.deepStrictEqual(S.consoleDayKeys('Asia/Dhaka', 2, new Date('2026-12-01T03:00:00Z')), ['2026-11-30', '2026-12-01']);
});
test('today: a call counts once (the phone or by hand), a meeting once per lead a day; the pipeline, the flow, the badges', () => {
    const now = new Date('2026-11-25T20:00:00Z'), tz = 'America/Chicago', ago = d => iso(now.getTime() - d * D);
    const L = [
        { id: 'L1', stage: 'contacted', in_pipeline: true, stage_at: ago(20), created_at: ago(5) },
        { id: 'L2', stage: 'meeting', in_pipeline: true, value: 1000, currency: 'USD', stage_at: ago(1), created_at: ago(5) },
        { id: 'L3', stage: 'new', created_at: ago(5) },
        { id: 'L4', stage: 'won', value: 500, currency: 'BDT', stage_at: iso(now.getTime() - H), created_at: ago(60), client_id: 'C1' },
        { id: 'L5', stage: 'lost', created_at: ago(60), next_step_at: ago(1) }];
    const calls = [{ direction: 'outbound', sid: 'S1', lead_id: 'L1', started_at: '2026-11-25T15:00:00Z' }, { direction: 'outbound', sid: 'S0', started_at: '2026-11-24T15:00:00Z' },
                   { direction: 'inbound', sid: 'S9', started_at: '2026-11-25T16:00:00Z' }];
    const acts = [
        { type: 'call', lead_id: 'L1', at: '2026-11-25T15:05:00Z', meta: { sid: 'S1', picked: 'owner', outcomeKey: 'interested', direction: 'outbound' } },
        { type: 'call', lead_id: 'L2', at: '2026-11-25T16:00:00Z', meta: { picked: 'front_desk', outcomeKey: 'spoke' } },
        { type: 'call', lead_id: 'L3', at: '2026-11-25T16:30:00Z', meta: { direction: 'inbound' } },
        { type: 'email_out', lead_id: 'L3', at: '2026-11-25T17:00:00Z' }, { type: 'email_out', lead_id: 'L2', at: '2026-11-25T17:01:00Z' },
        { type: 'email_in', lead_id: 'L2', at: '2026-11-25T18:00:00Z' },
        { type: 'meeting', lead_id: 'L1', at: '2026-11-25T18:10:00Z' }, { type: 'stage', lead_id: 'L1', at: '2026-11-25T18:11:00Z', meta: { to: 'meeting' } },
        { type: 'call', lead_id: 'L2', at: ago(3), meta: { outcomeKey: 'meeting', picked: 'owner' } }];
    const o = S.consoleSums({ leads: L, acts, calls, tz, now, since: ago(30) });
    assert.deepStrictEqual([o.today.calls, o.today.conversations, o.today.owners, o.today.emails, o.today.replies], [2, 2, 1, 2, 1]);
    assert.strictEqual(o.spark.calls[12], 1, 'yesterday');
    assert.strictEqual(o.today.meetingsWeek, 2, 'L1 today once, L2 three days ago');
    assert.deepStrictEqual([o.today.wonMonth, o.today.wonMonthValue], [1, 500]);
    assert.deepStrictEqual(o.pipeline.stages.filter(s => s.n).map(s => [s.key, s.n, s.value]), [['contacted', 1, 0], ['meeting', 1, 120000]]);
    assert.deepStrictEqual([o.pipeline.open, o.pipeline.stuck], [2, 1]);
    assert.deepStrictEqual(o.badges, { cold: 1, pipeline: 2, due: 0 });
    assert.deepStrictEqual(o.flow.map(f => f.n), [3, 2, 2, 2, 1, 0]);
});
test('calls by hour: on the lead\'s own clock; the owner picking up is kept apart', () => {
    const now = new Date('2026-11-25T20:00:00Z'), tz = 'America/Chicago';
    const leadsById = new Map([['E', { id: 'E', city: 'Miami, FL' }], ['P', { id: 'P', phone: '(415) 555-0100' }]]);
    const calls = [{ direction: 'outbound', lead_id: 'E', started_at: '2026-11-25T15:30:00Z' }, { direction: 'outbound', lead_id: 'P', started_at: '2026-11-24T19:00:00Z' },
                   { direction: 'outbound', contact_number: '+13125550100', started_at: '2026-11-25T14:00:00Z' }, { direction: 'outbound', lead_id: 'E', started_at: '2026-11-25T08:00:00Z' }];
    const acts = [{ type: 'call', lead_id: 'E', at: '2026-11-25T15:31:00Z', meta: { sid: 'x', picked: 'owner' } }];
    const h = S.heatGrid({ calls, acts, leadsById, tz, now });
    assert.strictEqual(h.days.length, 7); assert.strictEqual(h.days[6], '2026-11-25');
    assert.strictEqual(h.cells[6][h.hours.indexOf(10)], 1, 'Miami: 10 AM Eastern');
    assert.strictEqual(h.cells[5][h.hours.indexOf(11)], 1, 'San Francisco by area code: 11 AM Pacific, yesterday');
    assert.strictEqual(h.cells[6][h.hours.indexOf(8)], 1, 'no lead: the number\'s area code (Chicago)');
    assert.strictEqual(h.cells.flat().reduce((a, b) => a + b, 0), 3, '3 AM in Miami is off the grid');
    assert.strictEqual(h.owners[6][h.hours.indexOf(10)], 1);
});
test('the team: today and the period; on a call only while a call is live (not one stuck for hours)', () => {
    const now = new Date('2026-11-25T20:00:00Z'), tz = 'America/Chicago';
    const users = [{ id: 'T', name: 'Tia' }, { id: 'O', name: 'Owner' }];
    const calls = [{ direction: 'outbound', user_id: 'T', status: 'ringing', sid: 'A', started_at: iso(now - 10 * 60e3), lead_id: 'L9' },
                   { direction: 'outbound', user_id: 'T', status: 'completed', sid: 'B', started_at: iso(now - H) },
                   { direction: 'outbound', user_id: 'O', status: 'in-progress', sid: 'C', started_at: iso(now - 5 * H) }];
    const acts = [{ type: 'call', actor_id: 'T', lead_id: 'L1', at: iso(now - 2 * H), meta: { picked: 'owner', outcomeKey: 'interested' } }, { type: 'email_out', actor_id: 'T', lead_id: 'L1', at: iso(now - H) }];
    const leads = [{ id: 'W', stage: 'won', stage_at: iso(now - H), owner_id: 'O' }];
    const [t, o] = S.teamRows({ users, acts, calls, leads, tz, now, since: iso(now - 30 * D) });
    assert.deepStrictEqual([t.calls, t.talked, t.emails, t.interested, t.pCalls], [3, 1, 1, 1, 4 - 1]);
    assert.ok(t.live && t.live.lead_id === 'L9');
    assert.strictEqual(o.live, null); assert.strictEqual(o.won, 1);
});
test('needs you: replies nobody answered (a campaign email is not an answer), and yes with nothing booked', () => {
    const now = new Date('2026-11-25T20:00:00Z'), ago = d => iso(now.getTime() - d * D);
    const leads = [{ id: 'A', company: 'Alpha', stage: 'replied' }, { id: 'B', company: 'Bravo', stage: 'replied' }, { id: 'C', company: 'Charlie', stage: 'contacted' },
        { id: 'D', company: 'Delta', stage: 'contacted' }, { id: 'E', company: 'Echo', stage: 'won' },
        { id: 'F', company: 'Fox', stage: 'contacted', call_status: 'in_play', last_call_at: ago(1) }, { id: 'G', stage: 'contacted', call_status: 'in_play', next_step_at: ago(-1) }, { id: 'H', stage: 'meeting', call_status: 'in_play' }];
    const acts = [{ lead_id: 'A', type: 'email_in', at: ago(2) }, { lead_id: 'B', type: 'email_in', at: ago(3) }, { lead_id: 'B', type: 'email_out', actor_id: 'T', at: ago(2) },
        { lead_id: 'C', type: 'email_in', at: ago(3) }, { lead_id: 'C', type: 'email_out', actor_id: null, at: ago(2) }, { lead_id: 'D', type: 'email_in', at: ago(20) }, { lead_id: 'E', type: 'email_in', at: ago(1) }];
    const n = S.needsYou({ leads, acts, now });
    assert.deepStrictEqual(n.replies.leads.map(x => x.name), ['Alpha', 'Charlie']);
    assert.deepStrictEqual(n.interested.leads.map(x => x.id), ['F']);
});
test('the feed: one line per thing, newest first, plain text only; bulk moves and imports grouped', () => {
    const people = new Map([['T', 'Tia'], ['O', 'Owner']]);
    const leadsById = new Map([['M', { id: 'M', company: "Murphy's <b>Lawn</b>" }], ['G', { id: 'G', company: 'Gulf Coast HVAC' }]]);
    const t = m => '2026-11-25T15:' + String(m).padStart(2, '0') + ':00Z';
    const acts = [{ id: 1, type: 'call', actor_id: 'T', lead_id: 'M', at: t(39), meta: { sid: 'S1', outcome: 'Interested', outcomeKey: 'interested', picked: 'owner' } },
        { id: 2, type: 'email_out', lead_id: 'G', at: t(36), meta: { campaign: 'c', campaignName: 'HVAC 7-day' } },
        ...[3, 4, 5].map(i => ({ id: i, type: 'stage', actor_id: 'O', lead_id: 'x' + i, at: t(30), meta: { to: 'contacted', bulk: true } }))];
    const calls = [{ id: 'p1', sid: 'S1', direction: 'outbound', status: 'completed', user_id: 'T', lead_id: 'M', started_at: t(38), duration: 60 },
        { id: 'p2', sid: 'S2', direction: 'outbound', status: 'no-answer', user_id: 'T', contact_number: '+12125550100', started_at: t(25) },
        { id: 'p3', direction: 'inbound', status: 'completed', answered_by: 'O', contact_number: '+17135550199', started_at: t(18), duration: 192 },
        { id: 'p4', direction: 'inbound', status: 'voicemail', voicemail: true, contact_number: '+16175550101', started_at: t(12), duration: 41 },
        { id: 'p5', direction: 'inbound', status: 'no-answer', contact_number: '+16175550102', started_at: t(10) },
        { id: 'p6', direction: 'inbound', status: 'ringing', contact_number: '+16175550103', started_at: t(40) }];
    const texts = [{ id: 9, contact_number: '+12145550148', body: '<script>alert(1)</script> call me after 4', at: t(8) }];
    const newLeads = [1, 2, 3, 4, 5].map(i => ({ id: 'n' + i, company: 'R' + i, source: 'website', city: 'Houston', created_at: t(5), created_by: 'O' }));
    const f = S.feedItems({ acts, calls, texts, newLeads, leadsById, people, pretty: n => n, sources: S.CRM_SOURCES, limit: 20 });
    const line = x => x.parts.map(p => (Array.isArray(p) ? p[0] : p)).join('');
    assert.deepStrictEqual(f.map(line), [
        "Tia called Murphy's <b>Lawn</b> · Interested · into the pipeline", 'Campaign HVAC 7-day emailed Gulf Coast HVAC', 'Owner moved 3 leads to Contacted',
        'Tia called +12125550100 · no answer', 'Incoming call from +17135550199 · answered by Owner · 3:12', 'Voicemail from +16175550101 · 0:41',
        'Missed call from +16175550102', 'Text from +12145550148 · “<script>alert(1)</script> call me after 4”', '5 leads added · Website, Houston']);
    assert.deepStrictEqual(f.map(x => x.tone), ['ok', 'cp', 'cp', '', 'ok', 'hot', 'hot', 'hot', 'cp']);
    assert.ok(f.every(x => !('html' in x) && x.parts.every(p => typeof p === 'string' || (Array.isArray(p) && p.length === 1 && typeof p[0] === 'string'))), 'text and bold text only: the page escapes both');
});

// ---- the routes ----
test('the console sees every lead past the 1,000-row page, and sends every part the Overview draws', async () => {
    await fresh94(2500);
    const r = await call('GET', '/api/crm/console', { who: OWNER });
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.badges.cold, 2500);
    for (const k of ['today', 'spark', 'days', 'goals', 'sys', 'upNext', 'feed', 'needs', 'pipeline', 'flow', 'heat', 'jobs', 'departments', 'totals', 'campaigns', 'influencers', 'team'])
        assert.ok(r.body[k] !== undefined, 'has ' + k);
    assert.strictEqual(r.body.upNext.length, 5);
    assert.ok(!('leads' in r.body) && !('leadsById' in r.body), 'the lead list stays on the server');
    assert.ok(JSON.stringify(r.body).length < 60000, 'small: ' + JSON.stringify(r.body).length);
});
test('it is built once for everybody within 20 seconds', async () => {
    await fresh94(3);
    const a = await call('GET', '/api/crm/console', { who: OWNER });
    tbl('crm_leads').push(leadRow());
    const b = await call('GET', '/api/crm/console', { who: TEAM });
    assert.strictEqual(b.body.badges.cold, a.body.badges.cold, 'the same build');
    S.consoleCacheClear();
    assert.strictEqual((await call('GET', '/api/crm/console', { who: TEAM })).body.badges.cold, a.body.badges.cold + 1);
});
test('Up next is the caller\'s own Calls → Today; overdue call-backs are theirs (the owner sees all)', async () => {
    await fresh94(3);
    const [l0, l1] = tbl('crm_leads');
    tbl('crm_tasks').push({ id: newId(), lead_id: l1.id, title: 'Call back', kind: 'call', due_at: iso(Date.now() - H), owner_id: OWNER, done_at: null },
                          { id: newId(), lead_id: l0.id, title: 'Call back', kind: 'call', due_at: iso(Date.now() - H), owner_id: TEAM, done_at: null });
    const t = await call('GET', '/api/crm/console', { who: TEAM });
    assert.strictEqual(t.code, 200, JSON.stringify(t.body));
    assert.strictEqual(t.body.upNext[0].id, l0.id); assert.strictEqual(t.body.upNext[0].task, 'Call back'); assert.ok(t.body.upNext[0].taskAt, 'with when it is due');
    assert.deepStrictEqual(t.body.needs.callbacks.leads.map(x => x.id), [l0.id]);
    const o = await call('GET', '/api/crm/console', { who: OWNER });
    assert.strictEqual(o.body.needs.callbacks.n, 2);
});
test('email campaigns are not sent to someone they are locked for', async () => {
    await fresh94(2);
    tbl('crm_campaigns').push({ id: newId(), name: 'HVAC 7-day', status: 'active', updated_at: iso(Date.now()) });
    assert.strictEqual((await call('GET', '/api/crm/console', { who: TEAM })).body.campaigns, null);
    const o = await call('GET', '/api/crm/console', { who: OWNER });
    assert.deepStrictEqual(o.body.campaigns.map(c => c.name), ['HVAC 7-day']);
});
test('the pulse: today\'s counts, the feed and who is on a call', async () => {
    await fresh94(2);
    const l = tbl('crm_leads')[0];
    tbl('phone_calls').push({ id: newId(), sid: 'CA1', direction: 'outbound', status: 'in-progress', user_id: TEAM, lead_id: l.id, contact_number: '+12125550100', started_at: iso(Date.now() - 60e3), answered_at: iso(Date.now() - 50e3) });
    tbl('crm_activities').push({ id: newId(), type: 'call', actor_id: OWNER, lead_id: l.id, at: iso(Date.now() - 5 * 60e3), meta: { outcome: 'No answer', outcomeKey: 'no_answer', picked: 'none' } });
    const r = await call('GET', '/api/crm/pulse');
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.today.calls, 2, 'the live call and the one logged by hand');
    assert.deepStrictEqual(r.body.live.map(x => [x.id, x.lead]), [[TEAM, l.company]]);
    assert.ok(r.body.feed.some(x => x.parts.some(p => Array.isArray(p) && p[0] === l.company)));
    assert.ok(Array.isArray(r.body.goals) && r.body.goals.find(g => g.key === 'calls').done === 2);
});
test('the menu\'s counts come as three counts, not the lead list', async () => {
    await fresh94(1500);
    const L = tbl('crm_leads');
    L.slice(0, 30).forEach(l => { l.in_pipeline = true; });
    L.slice(30, 35).forEach(l => { l.stage = 'lost'; });
    L.slice(35, 37).forEach(l => { l.stage = 'won'; l.client_id = CLIENT; });
    L.slice(40, 44).forEach(l => { l.next_step_at = iso(Date.now() - H); });
    const r = await call('GET', '/api/crm/badges');
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body, { cold: 1500 - 30 - 5 - 2, pipeline: 30, due: 4 });
});
test('a client sees none of it', async () => {
    await fresh94(1);
    const cid = newId(); tbl('app_users').push({ id: cid, role: 'client', is_active: true, email: 'c@x.test' });
    assert.strictEqual((await call('GET', '/api/crm/console', { who: cid })).code, 403);
    assert.strictEqual((await call('GET', '/api/crm/pulse', { who: cid })).code, 403);
    assert.strictEqual((await call('GET', '/api/crm/badges', { who: cid })).code, 403);
});

(async () => {
    console.log('phase 94 :: the Overview as an operations console');
    for (const [name, fn] of tests) {
        try { await fn(); passed++; console.log('  ok  ' + name); }
        catch (e) { console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).toString().split('\n').slice(0, 4).join('\n       ')); process.exitCode = 1; }
    }
    console.log(`\n${passed} passed${passed === tests.length ? '' : `, ${tests.length - passed} failed`}`);
})();
