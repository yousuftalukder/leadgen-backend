#!/usr/bin/env node
/**
 * Phase 91 tests — the dialer, who may use the phone and when, and who was called and emailed.
 *
 * What matters: a lead's own time zone comes from its address, with the area code settling the states that span
 * two zones; hours open and close at the right moment, also across a daylight-saving change; the owner is never
 * locked out, a teammate without the phone or outside the hours is, and until the owner saves anything everyone
 * may call as before; an outcome sets the call status and when to try again, and runs out of tries; Today calls
 * callbacks first, then warm leads, then the best never-called, then retries, with closed businesses last; an
 * outcome is filed on the call the phone already logged, never twice; the voice webhook refuses a teammate who
 * may not call now; and the counts on a lead follow its timeline.
 *
 *   node tests/phase91.test.js
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
        like() { return q; }, or() { return q; },
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
        }
        if (head) return { data: null, error: null, count: hit.length };
        if (single) return { data: data[0] ? JSON.parse(JSON.stringify(data[0])) : null, error: null };
        return { data: data.map(r => JSON.parse(JSON.stringify(r))), error: null, count: wantCount ? hit.length : null };
    }
    return q;
}

// ---- the server, with its routes captured ----
const ROUTES = {};
const stubs = {
    express: Object.assign(() => {
        const reg = m => (p, ...h) => { ROUTES[m + ' ' + p] = h[h.length - 1]; };
        return { set() {}, use() {}, listen() {}, get: reg('GET'), post: reg('POST'), patch: reg('PATCH'), delete: reg('DELETE'), put: reg('PUT') };
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
const at = s => new Date(s);
const H9 = { days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' };

// ---- time zones ----
test('a lead\'s time zone: its address, the area code for split states, the area code alone, its country', () => {
    assert.strictEqual(S.leadTimezone({ city: '112 Thomas Ct, Bowling Green, KY 42101, USA', phone: '(270) 202-6294' }), 'America/Chicago');
    assert.strictEqual(S.leadTimezone({ city: '400 W Market St, Louisville, KY 40202', phone: '(502) 555-0100' }), 'America/New_York');
    assert.strictEqual(S.leadTimezone({ city: '250 Freedom Trl, Boston, MA 02113', phone: '(617) 420-8216' }), 'America/New_York');
    assert.strictEqual(S.leadTimezone({ city: '1 Main St, El Paso, TX 79901', phone: '915-555-0100' }), 'America/Denver');
    assert.strictEqual(S.leadTimezone({ city: 'Phoenix, AZ' }), 'America/Phoenix');
    assert.strictEqual(S.leadTimezone({ city: 'Houston', phone: '713 555 0100' }), 'America/Chicago');
    assert.strictEqual(S.leadTimezone({ phone: '+1 213 555 0100' }), 'America/Los_Angeles');
    assert.strictEqual(S.leadTimezone({ phone: '+1 404 555 0100' }), 'America/New_York');
    assert.strictEqual(S.leadTimezone({ country: 'BD', phone: '+8801712345678' }), 'Asia/Dhaka');
    assert.strictEqual(S.leadTimezone({ timezone: 'Europe/London', city: 'Austin, TX 78701' }), 'Europe/London');
    assert.strictEqual(S.leadTimezone({ city: 'Somewhere' }, 'Asia/Dhaka'), 'Asia/Dhaka');
});
test('hours open and close on the clock of their time zone', () => {
    assert.strictEqual(S.withinHours(H9, 'America/New_York', at('2026-11-25T14:30:00Z')), true);    // Wed 9:30 AM EST
    assert.strictEqual(S.withinHours(H9, 'America/New_York', at('2026-11-25T13:30:00Z')), false);   // 8:30 AM
    assert.strictEqual(S.withinHours(H9, 'America/New_York', at('2026-11-25T22:00:00Z')), false);   // 5:00 PM: closed
    assert.strictEqual(S.withinHours(H9, 'America/Chicago', at('2026-11-25T22:00:00Z')), true);     // 4:00 PM Central
    assert.strictEqual(S.withinHours(H9, 'America/New_York', at('2026-11-28T15:00:00Z')), false);   // Saturday
});
test('the next opening: later today, Monday after a Friday evening, and across the March clock change', () => {
    assert.strictEqual(S.nextOpen(H9, 'America/New_York', at('2026-11-25T13:30:00Z')).toISOString(), '2026-11-25T14:00:00.000Z');
    assert.strictEqual(S.nextOpen(H9, 'America/New_York', at('2026-11-27T23:00:00Z')).toISOString(), '2026-11-30T14:00:00.000Z');
    assert.strictEqual(S.nextOpen(H9, 'America/New_York', at('2026-03-07T23:00:00Z')).toISOString(), '2026-03-09T13:00:00.000Z');   // EDT from 8 March
    assert.strictEqual(S.nextOpen(H9, 'America/New_York', at('2026-11-25T15:00:00Z')), null);
});

// ---- who may use the phone ----
const OWNER = newId(), TEAM = newId(), OTHER = newId();
test('the owner is never locked out; before anything is saved everyone may call', () => {
    assert.strictEqual(S.phoneAccess({ enabled: false, people: {} }, { id: OWNER, role: 'admin' }).allowed, true);
    const open = S.phoneAccess(null, { id: TEAM, role: 'user' });
    assert.strictEqual(open.allowed, true); assert.strictEqual(open.why, 'open');
});
test('a teammate needs the phone, the phone on, and the hours', () => {
    const cfg = { enabled: true, tz: 'America/New_York', hours: H9, people: { [TEAM]: { on: true } } };
    assert.strictEqual(S.phoneAccess(cfg, { id: OTHER, role: 'user' }).why, 'no_access');
    assert.strictEqual(S.phoneAccess({ ...cfg, enabled: false }, { id: TEAM, role: 'user' }).why, 'locked');
    const inn = S.phoneAccess(cfg, { id: TEAM, role: 'user' }, at('2026-11-25T15:00:00Z'));
    assert.strictEqual(inn.allowed, true); assert.strictEqual(inn.closesAt, '2026-11-25T22:00:00.000Z');
    const out = S.phoneAccess(cfg, { id: TEAM, role: 'user' }, at('2026-11-27T23:00:00Z'));
    assert.strictEqual(out.allowed, false); assert.strictEqual(out.why, 'closed'); assert.strictEqual(out.opensAt, '2026-11-30T14:00:00.000Z');
    assert.match(out.text, /^Calling opens Mon 9:00 AM EST\.$/);
    const own = { ...cfg, people: { [TEAM]: { on: true, own: true, hours: { days: [6], from: '10:00', to: '12:00' } } } };
    assert.strictEqual(S.phoneAccess(own, { id: TEAM, role: 'user' }, at('2026-11-28T15:30:00Z')).allowed, true);     // Saturday 10:30 ET, their own hours
    assert.strictEqual(S.phoneAccess(own, { id: TEAM, role: 'user' }, at('2026-11-25T15:00:00Z')).allowed, false);
    assert.strictEqual(S.phoneAccess({ ...cfg, hours: null }, { id: TEAM, role: 'user' }).why, 'any_time');
});
test('phone settings are checked as they are saved', () => {
    const c = S.cleanPhoneAccess({ tz: 'America/Chicago', hours: { days: [5, 1, 1, 9], from: '9:00', to: '17:30' }, people: { [TEAM]: { on: true }, 'not-an-id': { on: true } } });
    assert.deepStrictEqual(c.hours, { days: [1, 5], from: '09:00', to: '17:30' });
    assert.deepStrictEqual(Object.keys(c.people), [TEAM]); assert.strictEqual(c.enabled, true);
    assert.strictEqual(S.cleanPhoneAccess({ anyTime: true }).hours, null);
    assert.throws(() => S.cleanPhoneAccess({ hours: { days: [1], from: '17:00', to: '09:00' } }), /must end after/);
    assert.throws(() => S.cleanPhoneAccess({ hours: { days: [], from: '09:00', to: '17:00' } }), /at least one day/);
    assert.throws(() => S.cleanPhoneAccess({ tz: 'Mars/Base' }), /time zone/);
    assert.deepStrictEqual(S.cleanVoice({ edge: 'singapore' }).edge, 'singapore');
    assert.deepStrictEqual(S.cleanVoice({ edge: 'moon' }).edge, 'roaming');
});

// ---- outcomes and the queue ----
const NOW = at('2026-11-25T17:00:00Z');            // noon in New York, 11 AM in Chicago, 9 AM in Los Angeles
test('an outcome sets the status and when to try again; tries run out; a callback needs its time', () => {
    const R = S.cleanRules({});
    assert.deepStrictEqual(S.dispositionPatch('no_answer', { rules: R, now: NOW }), { call_status: 'tried', last_call_outcome: 'No answer', callback_at: '2026-11-26T17:00:00.000Z' });
    assert.strictEqual(S.dispositionPatch('voicemail', { rules: R, now: NOW }).callback_at, '2026-11-27T17:00:00.000Z');
    const out = S.dispositionPatch('no_answer', { rules: R, now: NOW, attempts: 6 });
    assert.strictEqual(out.call_status, 'closed'); assert.strictEqual(out.callback_at, '2026-12-25T17:00:00.000Z'); assert.match(out.last_call_outcome, /6 tries in a row/);   // phase 92: back after 30 days
    assert.deepStrictEqual(S.dispositionPatch('interested', { rules: R, now: NOW }), { call_status: 'in_play', last_call_outcome: 'Interested', callback_at: null });
    assert.strictEqual(S.dispositionPatch('callback', { rules: R, now: NOW, callbackAt: '2026-11-27T15:00:00Z' }).callback_at, '2026-11-27T15:00:00.000Z');
    assert.throws(() => S.dispositionPatch('callback', { rules: R, now: NOW }), /when to call them back/);
    assert.throws(() => S.dispositionPatch('callback', { rules: R, now: NOW, callbackAt: '2026-11-20T15:00:00Z' }), /has passed/);
    assert.throws(() => S.dispositionPatch('sold-a-car', { rules: R, now: NOW }), /how the call went/);
});
test('call lists and rules are checked; a list keeps its id', () => {
    const r = S.cleanRules({ retry: { no_answer: 6, busy: -1 }, maxAttempts: 99, lists: [{ id: 'hvac-cold', name: ' HVAC cold ', sources: ['website'], pipeline: 'cold', emailed: 'yes', minScore: 140 }, { name: 'Everyone else' }] });
    assert.strictEqual(r.retry.no_answer, 6); assert.strictEqual(r.retry.busy, 2); assert.strictEqual(r.maxAttempts, 6);
    assert.deepStrictEqual(r.lists.map(l => l.id), ['hvac-cold', 'list-2-everyone-else']);
    assert.strictEqual(r.lists[0].name, 'HVAC cold'); assert.strictEqual(r.lists[0].minScore, 100);
    assert.throws(() => S.cleanRules({ lists: [{ name: '' }] }), /needs a name/);
    assert.ok(S.listMatch(r.lists[0], { source: 'website', in_pipeline: false, emails_count: 2, score: 100 }));
    assert.ok(!S.listMatch(r.lists[0], { source: 'website', in_pipeline: false, emails_count: 0, score: 100 }));
    assert.deepStrictEqual(S.listsFor({ lists: [{ id: 'a', people: [] }, { id: 'b', people: [OTHER] }] }, { id: TEAM, role: 'user' }).map(l => l.id), ['a']);
});
const L = (id, o) => ({ id, company: id, phone: '(212) 555-0100', source: 'website', stage: 'new', tags: [], created_at: '2026-11-01T00:00:00Z', ...o });
const leads = () => [
    L('never-good', { score: 80 }), L('never-weak', { score: 20 }),
    L('retry', { call_status: 'tried', calls_count: 2, last_call_at: '2026-11-23T15:00:00Z', callback_at: '2026-11-24T15:00:00Z' }),
    L('callback', { call_status: 'callback', calls_count: 1, callback_at: '2026-11-25T16:00:00Z' }),
    L('later', { call_status: 'tried', calls_count: 1, callback_at: '2026-11-28T16:00:00Z' }),
    L('lost', { stage: 'lost' }),
    L('warm', { in_pipeline: true, last_email_at: '2026-11-23T10:00:00Z', emails_count: 1 }),
    L('west', { phone: '(213) 555-0100', score: 99, created_at: '2026-10-01T00:00:00Z' })
];
test('Today: callbacks, then warm, then the best never called, then retries; counts for every tab', () => {
    const q = S.dialQueue(leads(), { now: NOW, rules: S.cleanRules({}) });
    assert.deepStrictEqual(q.rows.map(r => r.id), ['callback', 'warm', 'west', 'never-good', 'never-weak', 'retry']);
    assert.deepStrictEqual({ today: q.counts.today, not_called: q.counts.not_called, tried: q.counts.tried, callback: q.counts.callback, closed: q.counts.closed, all: q.counts.all },
        { today: 6, not_called: 4, tried: 2, callback: 1, closed: 1, all: 8 });
    assert.strictEqual(q.rows.find(r => r.id === 'west').tz, 'America/Los_Angeles');
});
test('a business that is closed now goes to the end of Today, with when it opens', () => {
    const early = at('2026-11-25T15:00:00Z');       // 10 AM New York, 7 AM Los Angeles
    const q = S.dialQueue(leads(), { now: early, rules: S.cleanRules({}) });
    const west = q.rows.find(r => r.id === 'west');
    assert.strictEqual(q.rows[q.rows.length - 1].id, 'west'); assert.strictEqual(west.openNow, false);
    assert.strictEqual(west.opensAt, '2026-11-25T17:00:00.000Z');
});
test('tabs, search by part of a number, and the trade filter', () => {
    const R = S.cleanRules({});
    assert.deepStrictEqual(S.dialQueue(leads(), { now: NOW, rules: R, tab: 'closed' }).rows.map(r => r.id), ['lost']);
    assert.deepStrictEqual(S.dialQueue(leads(), { now: NOW, rules: R, tab: 'all', q: '213555' }).rows.map(r => r.id), ['west']);
    const withTrade = leads().map(l => l.id === 'retry' ? { ...l, industry: 'HVAC' } : l);
    assert.deepStrictEqual(S.dialQueue(withTrade, { now: NOW, rules: R, tab: 'all', industry: 'hvac' }).rows.map(r => r.id), ['retry']);
});
test('warmth and the outreach counts from a timeline', () => {
    assert.strictEqual(S.warmth({ stage: 'replied' }).key, 'hot');
    assert.strictEqual(S.warmth({ last_email_at: '2026-11-23T00:00:00Z' }, NOW).key, 'warm');
    assert.strictEqual(S.warmth({ last_email_at: '2026-10-01T00:00:00Z' }, NOW).key, 'lukewarm');
    assert.strictEqual(S.warmth({}, NOW).key, 'cold');
    const o = S.outreachFrom([
        { type: 'call', at: '2026-11-24T10:00:00Z', meta: { outcome: 'Interested' } }, { type: 'call', at: '2026-11-20T10:00:00Z', meta: { outcome: 'No answer' } },
        { type: 'call', at: '2026-11-25T10:00:00Z', meta: { direction: 'inbound' } }, { type: 'call', at: '2026-11-25T11:00:00Z', meta: { voicemail: true, direction: 'inbound' } },
        { type: 'email_out', at: '2026-11-18T10:00:00Z', meta: {} }]);
    assert.deepStrictEqual(o, { calls_count: 2, last_call_at: '2026-11-24T10:00:00Z', last_call_outcome: 'Interested', emails_count: 1, last_email_at: '2026-11-18T10:00:00Z' });
});

// ---- the routes ----
const LEAD = newId(), LEAD2 = newId(), SID = 'CA' + 'a'.repeat(32);
function seed() {
    DB = {};
    tbl('app_users').push({ id: OWNER, role: 'admin', is_active: true, email: 'o@x.test', full_name: 'Owner' }, { id: TEAM, role: 'user', is_active: true, email: 't@x.test', full_name: 'Tia' }, { id: OTHER, role: 'user', is_active: true, email: 'r@x.test', full_name: 'Rafi' });
    tbl('crm_leads').push(
        { id: LEAD, full_name: 'Carter', company: 'One stop auto detailing', phone: '(270) 202-6294', city: '112 Thomas Ct, Bowling Green, KY 42101, USA', source: 'website', industry: 'Services', stage: 'new', tags: [], in_pipeline: false, call_status: 'not_called', calls_count: 0, emails_count: 0, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z' },
        { id: LEAD2, full_name: 'B', company: 'Berry Insurance', phone: '(617) 555-0101', source: 'website', industry: 'Insurance', stage: 'new', tags: [], in_pipeline: false, call_status: 'not_called', calls_count: 0, emails_count: 0, created_at: '2026-11-02T00:00:00Z', updated_at: '2026-11-02T00:00:00Z' });
}
/** A clean database, and the owner's phone settings: null = never saved. */
async function fresh(access) { seed(); await S.putSetting('phone_access', access || null); await S.putSetting('dialer_rules', S.DIALER_DEFAULTS); }
const signIn = (token, id) => { const u = tbl('app_users').find(x => x.id === id); S._authCache.set(S.tokenHash(token), { ctx: { user: { id, email: u.email }, profile: { ...u, paid_until: '2099-01-01T00:00:00Z' } }, t: Date.now() }); };
async function call(method, route, { who = TEAM, params = {}, body = {}, query: qy = {} } = {}) {
    signIn('t-' + who, who);
    const h = ROUTES[method + ' ' + route]; assert.ok(h, 'no route ' + method + ' ' + route);
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await h({ headers: { authorization: 'Bearer t-' + who }, params, body, query: qy, get: () => '' }, res);
    return res;
}
const LOCKED_FOR_TEAM = { enabled: true, tz: 'America/New_York', hours: null, people: { [TEAM]: { on: false } } };

test('the routes are there', () => {
    for (const r of ['GET /api/crm/dialer', 'POST /api/crm/dialer/outcome', 'GET /api/admin/phone/settings', 'PUT /api/admin/phone/settings', 'GET /api/admin/dialer', 'PUT /api/admin/dialer']) assert.ok(ROUTES[r], r);
});
test('the dialer lists who to call, with their time zone and the caller\'s day', async () => {
    await fresh(null);
    const r = await call('GET', '/api/crm/dialer');
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.rows.map(x => x.id).sort(), [LEAD, LEAD2].sort());
    assert.strictEqual(r.body.rows.find(x => x.id === LEAD).tz, 'America/Chicago');
    assert.ok(r.body.outcomes.some(o => o.key === 'interested')); assert.ok(r.body.today);
});
test('Interested: filed on the call the phone logged (not twice), in the pipeline, moved to Contacted', async () => {
    await fresh(null);
    tbl('crm_activities').push({ id: newId(), lead_id: LEAD, type: 'call', meta: { sid: SID, minutes: 1.2, outcome: 'Spoke', direction: 'outbound' }, at: '2026-11-25T16:00:00Z' });
    const r = await call('POST', '/api/crm/dialer/outcome', { body: { lead_id: LEAD, sid: SID, picked: 'owner', outcome: 'interested', note: 'Wants a quote' } });
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    const calls = tbl('crm_activities').filter(a => a.lead_id === LEAD && a.type === 'call');
    assert.strictEqual(calls.length, 1); assert.strictEqual(calls[0].meta.outcome, 'Interested'); assert.strictEqual(calls[0].meta.picked, 'owner'); assert.strictEqual(calls[0].meta.minutes, 1.2);
    assert.strictEqual(calls[0].body, 'Wants a quote');
    const l = tbl('crm_leads').find(x => x.id === LEAD);
    assert.strictEqual(l.in_pipeline, true); assert.strictEqual(l.stage, 'contacted'); assert.strictEqual(l.call_status, 'in_play'); assert.strictEqual(l.calls_count, 1);
});
test('a callback makes a call task; an email they asked for makes an email task; open call tasks close', async () => {
    await fresh(null);
    tbl('crm_tasks').push({ id: newId(), lead_id: LEAD, title: 'Call Carter', due_at: '2026-11-25T00:00:00Z', done_at: null });
    const when = new Date(Date.now() + 2 * 864e5).toISOString();
    const r = await call('POST', '/api/crm/dialer/outcome', { body: { lead_id: LEAD, picked: 'front_desk', outcome: 'callback', callbackAt: when, askedEmail: true } });
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    const t = tbl('crm_tasks').filter(x => x.lead_id === LEAD);
    assert.ok(t.find(x => x.title === 'Call Carter').done_at, 'the old call task is done');
    assert.ok(t.some(x => x.kind === 'call' && x.due_at === when && /back/.test(x.title)));
    assert.ok(t.some(x => x.kind === 'email' && /asked/.test(x.title)));
    const l = tbl('crm_leads').find(x => x.id === LEAD);
    assert.strictEqual(l.call_status, 'callback'); assert.strictEqual(l.callback_at, when);
});
test('an outcome that does not fit who picked up is refused; Do not call tags the lead', async () => {
    await fresh(null);
    assert.strictEqual((await call('POST', '/api/crm/dialer/outcome', { body: { lead_id: LEAD, picked: 'none', outcome: 'interested' } })).code, 400);
    const r = await call('POST', '/api/crm/dialer/outcome', { body: { lead_id: LEAD, picked: 'owner', outcome: 'dnc' } });
    assert.strictEqual(r.code, 200);
    const l = tbl('crm_leads').find(x => x.id === LEAD);
    assert.ok(l.tags.includes('Do not call')); assert.strictEqual(l.call_status, 'closed');
    assert.strictEqual(S.dialTab(l), 'closed');
});
test('a teammate without the phone cannot log an outcome; the owner can', async () => {
    await fresh(LOCKED_FOR_TEAM);
    const r = await call('POST', '/api/crm/dialer/outcome', { body: { lead_id: LEAD, picked: 'none', outcome: 'no_answer' } });
    assert.strictEqual(r.code, 403); assert.strictEqual(r.body.code, 'phone_locked');
    assert.strictEqual((await call('POST', '/api/crm/dialer/outcome', { who: OWNER, body: { lead_id: LEAD, picked: 'none', outcome: 'no_answer' } })).code, 200);
});
test('the voice webhook refuses a call from a teammate who may not call now, and lets the owner through', async () => {
    await fresh(LOCKED_FOR_TEAM);
    const hook = async (from, to) => {
        const body = { From: 'client:u_' + from, To: to, CallSid: 'CA' + String(++seq).padStart(32, '0'), LeadId: LEAD };
        const sig = S.twilioSignature('tok', 'https://api.test/api/phone/hook/voice', body);
        const res = { code: 200, out: '', status(c) { this.code = c; return this; }, type() { return this; }, send(x) { this.out = x; return this; }, json(b) { this.out = JSON.stringify(b); return this; }, end() { return this; } };
        await ROUTES['POST /api/phone/hook/voice']({ body, originalUrl: '/api/phone/hook/voice', path: '/api/phone/hook/voice', get: () => sig }, res);
        return res;
    };
    const no = await hook(TEAM, '+12702026294');
    assert.match(no.out, /Calling is closed for you/); assert.ok(!/<Dial/.test(no.out));
    const yes = await hook(OWNER, '+12702026294');
    assert.match(yes.out, /<Dial callerId=/);
    assert.ok(tbl('phone_calls').some(c => c.user_id === OWNER && c.lead_id === LEAD), 'the call is filed on the lead it was made for');
    const test2 = await hook(TEAM, '');
    assert.match(test2.out, /<Pause length="25"\/>/, 'the quality test is a quiet line');
});
test('the owner saves who can call; each person\'s state now comes back', async () => {
    await fresh(null);
    const put = await call('PUT', '/api/admin/phone/settings', { who: OWNER, body: { access: { enabled: true, tz: 'America/New_York', anyTime: true, people: { [TEAM]: { on: true } } }, voice: { edge: 'singapore' } } });
    assert.strictEqual(put.code, 200, JSON.stringify(put.body));
    const r = await call('GET', '/api/admin/phone/settings', { who: OWNER });
    assert.strictEqual(r.body.saved, true); assert.strictEqual(r.body.voice.edge, 'singapore');
    assert.strictEqual(r.body.people.find(p => p.id === TEAM).now.allowed, true);
    assert.strictEqual(r.body.people.find(p => p.id === OTHER).now.why, 'no_access');
    assert.strictEqual((await call('GET', '/api/admin/phone/settings', { who: TEAM })).code, 403);
});
test('logging a call by hand recounts the lead: called once, now Tried with a retry time', async () => {
    await fresh(null);
    const r = await call('POST', '/api/crm/leads/:id/activities', { params: { id: LEAD2 }, body: { type: 'call', body: 'No answer', outcome: 'No answer' } });
    assert.strictEqual(r.code, 201, JSON.stringify(r.body));
    const l = tbl('crm_leads').find(x => x.id === LEAD2);
    assert.strictEqual(l.calls_count, 1); assert.strictEqual(l.call_status, 'tried'); assert.ok(l.callback_at);
    assert.strictEqual(l.last_call_outcome, 'No answer');
});

(async () => {
    console.log('phase 91 :: the dialer, phone access and who was called');
    for (const [name, fn] of tests) {
        try { await fn(); passed++; console.log('  ok  ' + name); }
        catch (e) { console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).toString().split('\n').slice(0, 3).join('\n       ')); process.exitCode = 1; }
    }
    console.log(`\n${passed} passed${passed === tests.length ? '' : `, ${tests.length - passed} failed`}`);
})();
