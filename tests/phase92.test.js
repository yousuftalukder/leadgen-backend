#!/usr/bin/env node
/**
 * Phase 92 tests: what a call does to a lead, everywhere; Calls (Home, My numbers, Settings) and the Dialer.
 *
 * What matters: Not interested loses the lead, stops its email and brings it back after the revisit wait; six
 * no-conversation tries in a row rest it, and it comes back with a fresh count; do-not-call is never called,
 * texted or emailed again; a wrong number waits for a new one; Back to the call list never revives a do-not-call;
 * a campaign call step that is due tops Today; reminders follow the caller's own times or the office's; and
 * My numbers counts calls, pick-ups, hours, call-backs made and the best hour correctly.
 *
 *   node tests/phase92.test.js
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
const NOW = at('2026-11-25T17:00:00Z');
const R = S.cleanRules({});

// ---- what an outcome does ----
test('not interested and not a fit rest the lead for 90 days; out of tries rests it for 30; do-not-call and wrong numbers never come back on their own', () => {
    assert.deepStrictEqual(S.dispositionPatch('not_interested', { rules: R, now: NOW }), { call_status: 'closed', last_call_outcome: 'Not interested', callback_at: '2027-02-23T17:00:00.000Z' });
    assert.strictEqual(S.dispositionPatch('not_fit', { rules: R, now: NOW }).callback_at, '2027-02-23T17:00:00.000Z');
    assert.strictEqual(S.dispositionPatch('dnc', { rules: R, now: NOW }).callback_at, null);
    assert.strictEqual(S.dispositionPatch('wrong_number', { rules: R, now: NOW }).callback_at, null);
    const out = S.dispositionPatch('voicemail', { rules: R, now: NOW, attempts: 6 });
    assert.strictEqual(out.call_status, 'closed'); assert.strictEqual(out.callback_at, '2026-12-25T17:00:00.000Z');
    const never = S.cleanRules({ revisit: { notInterested: 0, outOfTries: 0 } });
    assert.strictEqual(S.dispositionPatch('not_interested', { rules: never, now: NOW }).callback_at, null);
    assert.strictEqual(S.dispositionPatch('busy', { rules: never, now: NOW, attempts: 6 }).callback_at, null);
});
test('tries in a row: no-conversation calls back to the last conversation, close or reopening', () => {
    const c = (outcomeKey, extra = {}) => ({ type: 'call', meta: { outcomeKey, ...extra } });
    assert.strictEqual(S.triesInARow([c('no_answer'), c('voicemail'), c('busy')]), 3);
    assert.strictEqual(S.triesInARow([c('no_answer'), c('spoke'), c('no_answer'), c('no_answer')]), 1);
    assert.strictEqual(S.triesInARow([c('no_answer'), c('no_answer', { outOfTries: true }), c('no_answer')]), 1);
    assert.strictEqual(S.triesInARow([c('gatekeeper'), { type: 'system', meta: { reopen: true } }, c('no_answer')]), 1);
    assert.strictEqual(S.triesInARow([{ type: 'call', meta: { outcome: 'No answer' } }, { type: 'call', meta: { direction: 'inbound' } }, c('busy')]), 2);
    assert.strictEqual(S.triesInARow([{ id: 'x', ...c('no_answer') }, c('no_answer')], 'x'), 1);
});
const L = (id, o) => ({ id, company: id, phone: '(212) 555-0100', source: 'website', stage: 'new', tags: [], created_at: '2026-11-01T00:00:00Z', ...o });
test('who is due: a rested lead once its wait is over, a due call task always, never do-not-call, a wrong number or a client', () => {
    const back = L('back', { stage: 'lost', call_status: 'closed', callback_at: '2026-11-25T10:00:00Z' });
    assert.strictEqual(S.dialTab(back), 'closed'); assert.strictEqual(S.isDue(back, R, NOW), true); assert.strictEqual(S.revisitDue(back, NOW), true);
    assert.strictEqual(S.isDue(L('lostByHand', { stage: 'lost' }), R, NOW), false);
    assert.strictEqual(S.isDue(L('resting', { stage: 'lost', call_status: 'closed', callback_at: '2027-01-01T00:00:00Z' }), R, NOW), false);
    assert.strictEqual(S.isDue(L('dnc', { tags: ['Do not call'], callback_at: '2026-11-01T00:00:00Z' }), R, NOW), false);
    assert.strictEqual(S.isDue(L('wrong', { tags: ['Wrong number'], call_status: 'closed', callback_at: '2026-11-01T00:00:00Z' }), R, NOW), false);
    assert.strictEqual(S.isDue(L('client', { client_id: 'c1' }), R, NOW), false);
    assert.strictEqual(S.isDue(L('task', { call_status: 'in_play', in_pipeline: true, task_due: '2026-11-25T16:00:00Z' }), R, NOW), true);
    assert.strictEqual(S.isDue(L('later', { call_status: 'in_play', task_due: '2026-11-25T18:00:00Z' }), R, NOW), false);
});
test('Today: a due call task first (with its title), rested leads after the fresh ones', () => {
    const q = S.dialQueue([L('fresh', { score: 50 }), L('back', { stage: 'lost', call_status: 'closed', callback_at: '2026-11-20T00:00:00Z', last_call_outcome: 'Not interested' }),
        L('task', { call_status: 'in_play', in_pipeline: true, stage: 'proposal', task_due: '2026-11-25T15:00:00Z', task_title: 'Call: day 3 of the HVAC campaign' }),
        L('dnc', { tags: ['Do not call'] })], { now: NOW, rules: R });
    assert.deepStrictEqual(q.rows.map(r => r.id), ['task', 'fresh', 'back']);
    assert.strictEqual(q.rows[0].task, 'Call: day 3 of the HVAC campaign'); assert.strictEqual(q.rows[2].revisit, true);
    assert.strictEqual(q.counts.today, 3); assert.strictEqual(q.counts.closed, 2);
});
test('back to the call list: lost comes back as New (or Contacted in the pipeline); do-not-call and wrong numbers do not', () => {
    assert.deepStrictEqual(S.reopenPatch(L('a', { stage: 'lost', calls_count: 2 }), NOW), { call_status: 'tried', callback_at: NOW.toISOString(), stage: 'new', stage_at: NOW.toISOString(), lost_reason: null });
    assert.strictEqual(S.reopenPatch(L('b', { stage: 'lost', in_pipeline: true }), NOW).stage, 'contacted');
    assert.deepStrictEqual(S.reopenPatch(L('c', { call_status: 'closed' }), NOW), { call_status: 'not_called', callback_at: NOW.toISOString() });
    assert.strictEqual(S.reopenPatch(L('d', { tags: ['Do not call'] }), NOW), null);
    assert.strictEqual(S.reopenPatch(L('e', { tags: ['Wrong number'] }), NOW), null);
});
test('rules and a caller\'s own settings are checked', () => {
    const r = S.cleanRules({ revisit: { notInterested: '120', outOfTries: -3 }, reminders: [60, 7, 15, 15, 0], snooze: 7 });
    assert.deepStrictEqual(r.revisit, { notInterested: 120, outOfTries: 30 });
    assert.deepStrictEqual(r.reminders, [60, 15, 0]); assert.strictEqual(r.snooze, 5);
    assert.deepStrictEqual(S.cleanCallerPrefs({ reminders: [1440, 5, 99], snooze: 10, tone: false }), { reminders: [1440, 5], snooze: 10, tone: false, desktop: true });
    assert.deepStrictEqual(S.cleanCallerPrefs({}), { reminders: null, snooze: null, tone: true, desktop: true });
});
test('my numbers: calls, leads, pick-ups, hours, time on calls, call-backs made, the best hour and the days', () => {
    const lead = { id: 'L1', city: 'Chicago, IL 60601' }, leads = new Map([['L1', lead]]);
    const t = h => `2026-11-24T${String(h).padStart(2, '0')}:10:00Z`;
    const acts = [];
    for (let i = 0; i < 8; i++) acts.push({ id: 'a' + i, lead_id: 'L1', at: t(18), meta: { outcomeKey: i < 3 ? 'interested' : 'no_answer', picked: i < 3 ? 'owner' : 'none', sid: 'CA' + i } });   // noon in Chicago
    acts.push({ id: 'h', lead_id: 'L2', at: t(20), meta: { outcomeKey: 'callback', picked: 'front_desk', minutes: 2 } });   // logged without dialing
    acts.push({ id: 'in', lead_id: 'L1', at: t(20), meta: { direction: 'inbound' } });
    const phoneCalls = [...Array(8)].map((_, i) => ({ sid: 'CA' + i, lead_id: 'L1', duration: 30, started_at: t(18) })).concat([{ sid: 'CAx', lead_id: 'L3', duration: 0, started_at: t(19) }]);
    const s = S.callStats({ phoneCalls, acts, tasks: [{ due_at: '2026-11-24T00:00:00Z', done_at: '2026-11-24T01:00:00Z' }, { due_at: '2026-11-24T02:00:00Z', done_at: null }], leads,
        from: at('2026-11-19T06:00:00Z'), to: at('2026-11-25T17:00:00Z'), tz: 'America/Chicago' });
    assert.strictEqual(s.calls, 10); assert.strictEqual(s.leadsCalled, 3);
    assert.strictEqual(s.outcomes, 9); assert.strictEqual(s.answered, 4); assert.strictEqual(s.owner, 3); assert.strictEqual(s.frontDesk, 1);
    assert.strictEqual(s.hoursWithCalls, 3); assert.strictEqual(s.perHour, 3.3);
    assert.strictEqual(s.seconds, 360); assert.strictEqual(s.avgSeconds, 30); assert.strictEqual(s.noTimer, 1);
    assert.deepStrictEqual([s.callbacksSet, s.callbacksDue, s.callbacksMade, s.interested], [1, 2, 1, 3]);
    assert.deepStrictEqual(s.best, { hour: 12, calls: 8, owner: 3, rate: 3 / 8 });
    assert.strictEqual(s.byDay.length, 7);
    const day = s.byDay.find(d => d.day === '2026-11-24');
    assert.deepStrictEqual([day.owner, day.none, day.front_desk, day.unlogged], [3, 5, 1, 1]);
});

// ---- the routes ----
const OWNER = newId(), TEAM = newId(), LEAD = newId(), LEAD2 = newId(), CAMP = newId();
function seed() {
    DB = {};
    tbl('app_users').push({ id: OWNER, role: 'admin', is_active: true, email: 'o@x.test', full_name: 'Owner' }, { id: TEAM, role: 'user', is_active: true, email: 't@x.test', full_name: 'Tia' });
    tbl('crm_leads').push(
        { id: LEAD, full_name: 'Carter', company: 'One stop auto detailing', phone: '(270) 202-6294', phone_norm: '2702026294', city: 'Bowling Green, KY 42101', source: 'website', industry: 'Services', stage: 'new', tags: [], in_pipeline: false, call_status: 'not_called', calls_count: 0, emails_count: 1, created_at: '2026-11-01T00:00:00Z' },
        { id: LEAD2, full_name: 'B', company: 'Berry Insurance', phone: '(617) 555-0101', phone_norm: '6175550101', source: 'website', industry: 'Insurance', stage: 'new', tags: [], in_pipeline: false, call_status: 'not_called', calls_count: 0, emails_count: 0, created_at: '2026-11-02T00:00:00Z' });
    tbl('crm_campaigns').push({ id: CAMP, name: 'HVAC 7-day' });
    tbl('crm_enrollments').push({ id: newId(), campaign_id: CAMP, lead_id: LEAD, status: 'active', step: 1, next_at: '2026-11-27T15:00:00Z' });
}
async function fresh() { seed(); await S.putSetting('phone_access', null); await S.putSetting('dialer_rules', S.DIALER_DEFAULTS); }
const signIn = (token, id) => { const u = tbl('app_users').find(x => x.id === id); S._authCache.set(S.tokenHash(token), { ctx: { user: { id, email: u.email }, profile: { ...u, paid_until: '2099-01-01T00:00:00Z' } }, t: Date.now() }); };
async function call(method, route, { who = TEAM, params = {}, body = {}, query: qy = {} } = {}) {
    signIn('t-' + who, who);
    const h = ROUTES[method + ' ' + route]; assert.ok(h, 'no route ' + method + ' ' + route);
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await h({ headers: { authorization: 'Bearer t-' + who }, params, body, query: qy, get: () => '' }, res);
    return res;
}
const lead = id => tbl('crm_leads').find(x => x.id === id);
const outcome = (id, outcome, picked, extra = {}) => call('POST', '/api/crm/dialer/outcome', { body: { lead_id: id, outcome, picked, ...extra } });

test('Not interested: Lost with the reason, its email campaign stops, and it comes back in 90 days', async () => {
    await fresh();
    const r = await outcome(LEAD, 'not_interested', 'owner');
    assert.strictEqual(r.code, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.stage, 'lost'); assert.strictEqual(r.body.campaignsStopped, 1);
    const l = lead(LEAD);
    assert.strictEqual(l.stage, 'lost'); assert.strictEqual(l.lost_reason, 'Not interested (on a call)'); assert.strictEqual(l.call_status, 'closed');
    assert.ok(Math.abs(new Date(l.callback_at) - Date.now() - 90 * 864e5) < 60e3);
    const en = tbl('crm_enrollments')[0]; assert.strictEqual(en.status, 'stopped'); assert.match(en.stop_reason, /Not interested/);
    assert.ok(tbl('crm_activities').some(a => a.lead_id === LEAD && a.type === 'stage' && a.meta.to === 'lost'));
});
test('Do not call: tagged, unsubscribed, campaigns stopped; the phone then refuses to call or text it', async () => {
    await fresh();
    assert.strictEqual((await outcome(LEAD, 'dnc', 'owner')).code, 200);
    const l = lead(LEAD);
    assert.ok(l.tags.includes('Do not call')); assert.strictEqual(l.unsubscribed, true); assert.strictEqual(tbl('crm_enrollments')[0].status, 'stopped');
    process.env.TWILIO_AUTH_TOKEN = 'tok'; process.env.PHONE_PUBLIC_URL = 'https://api.test';
    const body = { From: 'client:u_' + OWNER, To: '+12702026294', CallSid: 'CA' + '9'.repeat(32) };
    const res = { out: '', type() { return this; }, send(x) { this.out = x; return this; }, status() { return this; }, json(b) { this.out = JSON.stringify(b); return this; } };
    await ROUTES['POST /api/phone/hook/voice']({ body, originalUrl: '/api/phone/hook/voice', path: '/api/phone/hook/voice', get: () => S.twilioSignature('tok', 'https://api.test/api/phone/hook/voice', body) }, res);
    assert.match(res.out, /asked not to be called/); assert.ok(!/<Dial/.test(res.out));
    process.env.PHONE_SMS_ENABLED = '1';
    const t = await call('POST', '/api/phone/messages', { who: OWNER, body: { to: '(270) 202-6294', body: 'Hi' } });
    delete process.env.PHONE_SMS_ENABLED;
    assert.strictEqual(t.code, 409); assert.strictEqual(t.body.code, 'do_not_call');
});
test('Wrong number: marked; a new number puts it back in the call list', async () => {
    await fresh();
    await outcome(LEAD2, 'wrong_number', 'none');
    assert.ok(lead(LEAD2).tags.includes('Wrong number')); assert.strictEqual(lead(LEAD2).call_status, 'closed');
    const p = await call('PATCH', '/api/crm/leads/:id', { params: { id: LEAD2 }, body: { phone: '(617) 555-0199' } });
    assert.strictEqual(p.code, 200, JSON.stringify(p.body));
    const l = lead(LEAD2);
    assert.ok(!l.tags.includes('Wrong number')); assert.strictEqual(l.call_status, 'tried'); assert.ok(l.callback_at);
    assert.ok(tbl('crm_activities').some(a => a.lead_id === LEAD2 && a.type === 'system' && a.meta.reopen));
});
test('six tries in a row rest the lead for 30 days; back in the list it starts a fresh count', async () => {
    await fresh();
    for (let i = 0; i < 5; i++) tbl('crm_activities').push({ id: newId(), lead_id: LEAD2, type: 'call', meta: { outcomeKey: 'no_answer', picked: 'none' }, at: `2026-11-2${i}T15:00:00Z` });
    const r = await outcome(LEAD2, 'no_answer', 'none');
    assert.strictEqual(r.body.outOfTries, true); assert.strictEqual(lead(LEAD2).call_status, 'closed');
    assert.ok(Math.abs(new Date(lead(LEAD2).callback_at) - Date.now() - 30 * 864e5) < 60e3);
    assert.ok(tbl('crm_activities').some(a => a.lead_id === LEAD2 && a.meta && a.meta.outOfTries));
    const again = await outcome(LEAD2, 'no_answer', 'none');   // back from its rest: try 1 of a new run
    assert.strictEqual(again.body.outOfTries, false); assert.strictEqual(lead(LEAD2).call_status, 'tried');
});
test('Interested on a lead that came back from Lost: Contacted, in the pipeline, the reason cleared', async () => {
    await fresh();
    Object.assign(lead(LEAD), { stage: 'lost', lost_reason: 'Not interested (on a call)', call_status: 'closed', callback_at: '2026-11-01T00:00:00Z' });
    const r = await outcome(LEAD, 'interested', 'owner');
    assert.strictEqual(r.body.stage, 'contacted');
    const l = lead(LEAD); assert.strictEqual(l.in_pipeline, true); assert.strictEqual(l.lost_reason, null); assert.strictEqual(l.call_status, 'in_play');
    assert.strictEqual(tbl('crm_enrollments')[0].status, 'stopped');
});
test('back to the call list from Leads: lost comes back as New; do-not-call is left out and counted', async () => {
    await fresh();
    Object.assign(lead(LEAD), { stage: 'lost', call_status: 'closed', calls_count: 1 });
    lead(LEAD2).tags = ['Do not call'];
    const r = await call('POST', '/api/crm/dialer/reopen', { body: { ids: [LEAD, LEAD2] } });
    assert.deepStrictEqual(r.body, { reopened: 1, dnc: 1, wrong: 0, clients: 0 });
    assert.strictEqual(lead(LEAD).stage, 'new'); assert.strictEqual(lead(LEAD).call_status, 'tried');
    assert.ok(new Date(lead(LEAD).callback_at) <= new Date());
});
test('Calls → Home: a campaign\'s call step that is due tops Today, and each lead carries its campaign', async () => {
    await fresh();
    tbl('crm_tasks').push({ id: newId(), lead_id: LEAD2, title: 'Call: step 2 of HVAC 7-day', kind: 'call', due_at: '2026-11-01T00:00:00Z', done_at: null, owner_id: TEAM });
    const r = await call('GET', '/api/crm/dialer');
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.rows[0].id, LEAD2); assert.strictEqual(r.body.rows[0].task, 'Call: step 2 of HVAC 7-day');
    assert.strictEqual(r.body.rows.find(x => x.id === LEAD).campaign.name, 'HVAC 7-day');
    const list = await call('GET', '/api/crm/leads');
    assert.strictEqual(list.body.leads.find(x => x.id === LEAD).campaign.name, 'HVAC 7-day');
});
test('a callback outcome makes a task the reminders pick up, at the caller\'s own times or the office\'s', async () => {
    await fresh();
    const when = new Date(Date.now() + 3 * 3600e3).toISOString();
    await outcome(LEAD, 'callback', 'front_desk', { callbackAt: when });
    let r = await call('GET', '/api/crm/reminders');
    assert.strictEqual(r.body.reminders.length, 1); assert.strictEqual(r.body.reminders[0].kind, 'call'); assert.strictEqual(r.body.reminders[0].lead.company, 'One stop auto detailing');
    assert.deepStrictEqual(r.body.prefs.reminders, [60, 15, 5]);
    await call('PUT', '/api/crm/caller-prefs', { body: { reminders: [120, 10], snooze: 15, tone: false } });
    r = await call('GET', '/api/crm/reminders');
    assert.deepStrictEqual([r.body.prefs.reminders, r.body.prefs.snooze, r.body.prefs.tone], [[120, 10], 15, false]);
    const mine = await call('GET', '/api/crm/caller-prefs', { who: OWNER });
    assert.deepStrictEqual(mine.body.effective.reminders, [60, 15, 5], 'another caller keeps the office times');
});
test('my numbers: a teammate sees their own; the owner can pick anyone or the whole team', async () => {
    await fresh();
    await outcome(LEAD, 'spoke', 'owner'); await call('POST', '/api/crm/dialer/outcome', { who: OWNER, body: { lead_id: LEAD2, outcome: 'no_answer', picked: 'none' } });
    const mine = await call('GET', '/api/crm/calls/stats', { query: { range: '7d', user: OWNER } });
    assert.strictEqual(mine.code, 200, JSON.stringify(mine.body)); assert.strictEqual(mine.body.person, TEAM); assert.strictEqual(mine.body.stats.calls, 1); assert.deepStrictEqual(mine.body.people, []);
    const team = await call('GET', '/api/crm/calls/stats', { who: OWNER, query: { range: '30d', user: 'all' } });
    assert.strictEqual(team.body.stats.calls, 2); assert.strictEqual(team.body.people.length, 2); assert.strictEqual(team.body.stats.byDay.length, 30);
});

(async () => {
    console.log('phase 92 :: what a call does to a lead, Calls and the Dialer');
    for (const [name, fn] of tests) {
        try { await fn(); passed++; console.log('  ok  ' + name); }
        catch (e) { console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).toString().split('\n').slice(0, 4).join('\n       ')); process.exitCode = 1; }
    }
    console.log(`\n${passed} passed${passed === tests.length ? '' : `, ${tests.length - passed} failed`}`);
})();
