#!/usr/bin/env node
/**
 * Phase 90 offline tests — industry, the pipeline, today, history, the map, client pages and email campaigns.
 *
 * What matters: an industry is tidied and kept; a CSV's Industry column wins over the file's; a client page shows its
 * own tabs, else its kind's, else the default, always with Overview and Details; goals cap at 100%; "today" is the
 * business's day, also across a daylight-saving change; a lead's history has every call and text once; a place is
 * steady per lead; campaign steps are checked, the audience matches only who it should, templates fill in with
 * fallbacks, a step never goes out of the window, and an unsubscribe link works for its lead only.
 *
 *   node tests/phase90.test.js
 */
'use strict';
const assert = require('assert');
const Module = require('module');
const path = require('path');

const chain = () => {
    const p = Promise.resolve({ data: null, error: null, count: 0 });
    const h = new Proxy(function () {}, { get: (_, k) => (k === 'then' ? p.then.bind(p) : k === 'catch' ? p.catch.bind(p) : k === 'finally' ? p.finally.bind(p) : () => h), apply: () => h });
    return h;
};
const routes = [];
const stubs = {
    express: Object.assign(() => {
        const r = m => (p, ...h) => routes.push([m, p, h]);
        return { set() {}, use: r('use'), get: r('get'), post: r('post'), patch: r('patch'), delete: r('delete'), put: r('put'), listen() {} };
    }, { json: () => (_, __, n) => n && n(), raw: () => (_, __, n) => n && n(), static: () => () => {} }),
    cors: () => () => {},
    'apify-client': { ApifyClient: class {} },
    '@supabase/supabase-js': { createClient: () => ({ from: chain, rpc: chain, auth: { getUser: async () => ({ data: null, error: new Error('stub') }) } }) },
    dotenv: { config() {} }
};
const realLoad = Module._load;
Module._load = function (req, ...rest) { return stubs[req] !== undefined ? stubs[req] : realLoad.call(this, req, ...rest); };
process.env.SUPABASE_URL = 'http://stub'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
delete process.env.RENDER;

require(path.join(__dirname, '..', 'server.js'));
const S = require(path.join(__dirname, '..', 'src', 'shared'));

let passed = 0;
const pending = [];
const test = (name, fn) => pending.push([name, fn]);
const refuses = (fn, re) => assert.throws(fn, e => e.statusCode === 400 && re.test(e.message), 'expected a 400 matching ' + re);

console.log('phase 90 :: industry and the pipeline on a lead');
test('an industry is tidied: spaces trimmed, lower case given capitals, a written case kept', () => {
    assert.strictEqual(S.cleanIndustry('  appliance   repair '), 'Appliance Repair');
    assert.strictEqual(S.cleanIndustry('HVAC'), 'HVAC');
    assert.strictEqual(S.cleanIndustry('pest control/termites'), 'Pest Control/Termites');
    assert.strictEqual(S.cleanIndustry(''), null);
});
test('a lead body carries industry and the pipeline switch only when sent', () => {
    const l = S.cleanLeadBody({ full_name: 'Ramil', industry: 'roofing', in_pipeline: true });
    assert.strictEqual(l.industry, 'Roofing'); assert.strictEqual(l.in_pipeline, true);
    const p = S.cleanLeadBody({ stage: 'contacted' }, { partial: true });
    assert.ok(!('industry' in p) && !('in_pipeline' in p));
});
test('a CSV row\'s own Industry column wins; the file\'s industry fills the rest', () => {
    const rows = S.parseCsv('Company,Industry,City\nFix Use,Appliance repair,Bellaire\nCranked Repairs,,N. Houston\n');
    const { leads } = S.csvToLeads(rows, 'other', { industry: 'Plumbing' });
    assert.deepStrictEqual(leads.map(l => l.industry), ['Appliance repair', 'Plumbing'], 'a name typed with capitals is kept as typed');
    assert.strictEqual(leads[0].full_name, 'Fix Use');
});

console.log('phase 90 :: client pages');
const ID = '7412d3f1-a801-4dc0-b048-aa70bfead4ce';
test('a client shows its own tabs, else its kind\'s, else the default; Overview and Details always', () => {
    const cfg = S.cleanClientTabs({ default: ['tasks', 'billing'], byType: { Restaurant: ['content', 'templates'] }, byClient: { [ID]: ['ledger'] } });
    assert.deepStrictEqual(S.resolveClientTabs(cfg, { id: 'x', niche: 'Roofing' }), ['overview', 'tasks', 'billing', 'details']);
    assert.deepStrictEqual(S.resolveClientTabs(cfg, { id: 'x', niche: ' restaurant ' }), ['overview', 'content', 'templates', 'details']);
    assert.deepStrictEqual(S.resolveClientTabs(cfg, { id: ID, niche: 'restaurant' }), ['overview', 'ledger', 'details']);
});
test('unknown tabs and a client id that is not an id are dropped', () => {
    const cfg = S.cleanClientTabs({ default: ['tasks', 'nonsense'], byClient: { 'not-a-uuid': ['tasks'] } });
    assert.deepStrictEqual(cfg.default, ['tasks']); assert.deepStrictEqual(cfg.byClient, {});
    assert.ok(S.resolveClientTabs({}, { id: 'x' }).includes('tasks'), 'nothing set: the default tabs');
});

console.log('phase 90 :: today');
test('goals: done against target, capped at 100%, a goal of zero is met', () => {
    const g = S.goalProgress({ calls: 45, emails: 10, prospects: 0, followups: 2 }, { calls: 30, emails: 50, prospects: 0, followups: 10 });
    const by = Object.fromEntries(g.map(x => [x.key, x]));
    assert.deepStrictEqual([by.calls.pct, by.calls.met], [100, true]);
    assert.deepStrictEqual([by.emails.pct, by.emails.met], [20, false]);
    assert.strictEqual(by.prospects.met, true);
    assert.deepStrictEqual(S.cleanGoals({ calls: -4, emails: '60' }), { calls: 30, emails: 60, prospects: 20, followups: 10 });
});
test('"today" is the business\'s day: 11 PM in Chicago is still that day, not the next UTC one', () => {
    const d = S.dayBounds('America/Chicago', 'today', new Date('2026-11-24T05:00:00Z'));
    assert.strictEqual(d.today, '2026-11-23');
    assert.strictEqual(d.start.toISOString(), '2026-11-23T06:00:00.000Z');
    assert.strictEqual(d.end.toISOString(), '2026-11-24T06:00:00.000Z');
});
test('across the daylight-saving change the day is still midnight to midnight', () => {
    const d = S.dayBounds('America/Chicago', 'today', new Date('2026-03-08T18:00:00Z'));   // the day clocks go forward
    assert.strictEqual(d.start.toISOString(), '2026-03-08T06:00:00.000Z');
    assert.strictEqual(d.end.toISOString(), '2026-03-09T05:00:00.000Z');
    const w = S.dayBounds('America/Chicago', '7d', new Date('2026-11-24T18:00:00Z'));
    assert.strictEqual(w.endDay, '2026-11-30');
});

console.log('phase 90 :: a lead\'s history');
test('a call already on the timeline is not shown twice; calls, texts and campaign emails are merged, newest first', () => {
    const items = S.mergeHistory({
        activities: [{ id: 'a1', type: 'call', at: '2026-11-20T10:00:00Z', meta: { sid: 'CA1' } }, { id: 'a2', type: 'email_out', at: '2026-11-19T10:00:00Z', meta: { emailId: 'm1' } }],
        calls: [{ id: 'c1', sid: 'CA1', direction: 'outbound', started_at: '2026-11-20T10:00:00Z' }, { id: 'c2', sid: 'CA2', direction: 'inbound', status: 'no-answer', voicemail: true, started_at: '2026-11-21T10:00:00Z', transcript: 'Call me' }],
        texts: [{ id: 't1', sid: 'SM1', direction: 'inbound', body: 'ok', at: '2026-11-22T10:00:00Z' }],
        emails: [{ id: 'm1', subject: 'Hi', sent_at: '2026-11-19T10:00:00Z', opened_at: '2026-11-19T12:00:00Z', opens: 2 }, { id: 'm2', subject: 'Again', sent_at: '2026-11-18T10:00:00Z' }]
    });
    assert.deepStrictEqual(items.map(i => i.id), ['sms-t1', 'call-c2', 'a1', 'a2', 'mail-m2']);
    assert.strictEqual(items.find(i => i.id === 'call-c2').meta.outcome, 'Voicemail');
    assert.strictEqual(items.find(i => i.id === 'a2').meta.opens, 2, 'the open count joins the timeline entry');
});

console.log('phase 90 :: the map');
test('a lead\'s place moves a little from its city, the same way every time', () => {
    const a = S.jitter('lead-1'), b = S.jitter('lead-1'), c = S.jitter('lead-2');
    assert.deepStrictEqual(a, b); assert.notDeepStrictEqual(a, c);
    assert.ok(Math.abs(a.dLat) <= 0.014 && Math.abs(a.dLng) <= 0.017);
});
test('the place is asked for with the city and country, then the city near the owner\'s area', () => {
    assert.deepStrictEqual(S.geoQueries({ city: 'Katy', country: null }, 'Houston, TX, USA'), ['Katy, Houston, TX, USA']);
    assert.deepStrictEqual(S.geoQueries({ city: 'Bellaire', country: 'US' }, 'Houston, TX'), ['Bellaire, US', 'Bellaire, Houston, TX']);
    assert.deepStrictEqual(S.geoQueries({ city: '', country: '' }, 'x'), []);
});

console.log('phase 90 :: email campaigns');
test('steps are checked: a kind, a wait of 0 to 90 days, and when starting, a subject and words', () => {
    refuses(() => S.cleanSteps([{ type: 'sms' }]), /pick email, call or task/);
    const s = S.cleanSteps([{ type: 'email', delay: 500, subject: 'Hi', body: 'x' }, { type: 'call', delay: 3 }]);
    assert.strictEqual(s[0].delay, 0); assert.strictEqual(s[1].title, 'Call {{first_name}} at {{company}}');
    refuses(() => S.cleanSteps([{ type: 'email', subject: '', body: 'x' }], { strict: true }), /subject/);
    assert.doesNotThrow(() => S.cleanSteps([{ type: 'email', subject: 'a', body: 'x' }, { type: 'email', thread: true, body: 'y' }], { strict: true }), 'a reply in the thread needs no subject');
    refuses(() => S.cleanSteps(Array.from({ length: 21 }, () => ({ type: 'task' }))), /20 steps/);
});
test('the audience: email needed, never unsubscribed, won and lost only when asked, every filter applies', () => {
    const a = S.cleanAudience({ industries: ['appliance repair'], pipeline: 'out', sources: ['other', 'bogus'] });
    assert.deepStrictEqual(a.sources, ['other']);
    const base = { email: 'a@b.co', source: 'other', industry: 'Appliance Repair', stage: 'new', in_pipeline: false };
    assert.strictEqual(S.matchAudience(base, a), true);
    assert.strictEqual(S.matchAudience({ ...base, email: null }, a), false);
    assert.strictEqual(S.matchAudience({ ...base, unsubscribed: true }, a), false);
    assert.strictEqual(S.matchAudience({ ...base, in_pipeline: true }, a), false);
    assert.strictEqual(S.matchAudience({ ...base, stage: 'won' }, a), false);
    assert.strictEqual(S.matchAudience({ ...base, stage: 'won' }, S.cleanAudience({ stages: ['won'] })), true);
    assert.strictEqual(S.matchAudience({ ...base, industry: 'Roofing' }, a), false);
});
test('templates fill in, use a fallback when a field is empty, and leave an unknown name as written', () => {
    const lead = { full_name: 'Ramil Ortiz', company: 'Fix Use', city: 'Bellaire' };
    assert.strictEqual(S.renderTemplate('Hi {{first_name}}, {{company}} in {{city}}', lead), 'Hi Ramil, Fix Use in Bellaire');
    assert.strictEqual(S.renderTemplate('Hi {{first_name|there}}', { full_name: '-' }), 'Hi there');
    assert.strictEqual(S.renderTemplate('{{industry|local}} {{nope}}', lead), 'local {{nope}}');
    assert.strictEqual(S.renderTemplate('{{ sender_name }}', lead, { name: 'Yousuf' }), 'Yousuf');
});
test('a step never goes out of the window: after hours it waits for the next opening, weekends skipped', () => {
    const w = { from: 9, to: 17, days: [1, 2, 3, 4, 5] }, tz = 'America/Chicago';
    // Friday 9 PM Chicago (Saturday 03:00 UTC) is after hours: the next opening is Monday 9 AM.
    assert.strictEqual(S.nextSendAt(new Date('2026-11-28T03:00:00Z'), 0, w, tz).toISOString(), '2026-11-30T15:00:00.000Z');
    assert.strictEqual(S.nextSendAt(new Date('2026-11-28T18:00:00Z'), 0, w, tz).toISOString(), '2026-11-30T15:00:00.000Z', 'Saturday noon waits for Monday');
});
test('inside the window it goes now; a wait of 2 days from Thursday afternoon lands on Monday morning', () => {
    const w = { from: 9, to: 17, days: [1, 2, 3, 4, 5] }, tz = 'America/Chicago';
    const at = new Date('2026-11-24T16:00:00Z');   // Tuesday 10 AM in Chicago
    assert.strictEqual(S.nextSendAt(at, 0, w, tz).toISOString(), at.toISOString());
    assert.strictEqual(S.nextSendAt(new Date('2026-11-26T22:00:00Z'), 2, w, tz).toISOString(), '2026-11-30T15:00:00.000Z');
    assert.strictEqual(S.nextSendAt(new Date('2026-11-24T12:00:00Z'), 0, w, tz).toISOString(), '2026-11-24T15:00:00.000Z', 'before 9 AM: the same day at 9');
});
test('an unsubscribe link works for its own lead only', () => {
    const tok = S.unsubToken('7ff25d69-b11d-446b-b29e-cbc826cd5840');
    assert.strictEqual(S.readUnsubToken(tok), '7ff25d69-b11d-446b-b29e-cbc826cd5840');
    const other = Buffer.from('0de3b021-2b42-47a6-aff9-b5ad01a94232').toString('base64url') + '.' + tok.split('.')[1];
    assert.strictEqual(S.readUnsubToken(other), null);
    assert.strictEqual(S.readUnsubToken('garbage'), null);
});
test('the daily cap is spread over the window, and an email\'s words are escaped', () => {
    assert.strictEqual(S.perTick(50, { from: 9, to: 17 }), 1);
    assert.strictEqual(S.perTick(2000, { from: 9, to: 17 }), 9);
    const h = S.emailHtml('Hi <b>there</b>\n\nSee https://edgelead.online', { footer: 'f', pixel: null });
    assert.ok(h.includes('&lt;b&gt;there&lt;/b&gt;') && h.includes('<a href="https://edgelead.online">'));
});
test('the campaign routes and the sender are registered', () => {
    for (const [m, p] of [['get', '/api/crm/campaigns'], ['post', '/api/crm/campaigns/:id/enroll'], ['post', '/api/crm/campaigns/audience'], ['get', '/api/public/unsub/:token'], ['get', '/api/crm/today'], ['get', '/api/crm/client-schema'], ['put', '/api/admin/crm-settings'], ['put', '/api/admin/mailbox']])
        assert.ok(routes.find(r => r[0] === m && r[1] === p), m + ' ' + p);
    assert.strictEqual(typeof S.campaignTick, 'function');
});

(async () => {
    for (const [name, fn] of pending) {
        try { await fn(); passed++; console.log('  ok   ' + name); }
        catch (e) { console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n       ')); process.exitCode = 1; }
    }
    console.log(`\n${passed} passed`);
    process.exit();
})();
