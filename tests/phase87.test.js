#!/usr/bin/env node
/**
 * Phase 87 offline tests — the CRM and the tools switch.
 *
 * What matters: a lead is refused with a plain message when its email, phone, source, country or value is wrong;
 * a lead is never won without becoming a client; duplicates are caught by email first, then by phone in any
 * format; a CSV with its own column names imports and reports the rows it could not use; the overview counts
 * each department and channel from the activities and puts every number in the right bucket; a switched-off
 * tool's paths are blocked and nothing else is; and an unreadable switch means every tool is off.
 *
 *   node tests/phase87.test.js
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
function test(name, fn) { try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n       ')); process.exitCode = 1; } }
const refuses = (fn, re) => assert.throws(fn, e => e.statusCode === 400 && re.test(e.message), 'expected a 400 matching ' + re);

console.log('phase 87 :: leads');
test('a lead needs a name and a known source', () => {
    refuses(() => S.cleanLeadBody({}), /name/);
    refuses(() => S.cleanLeadBody({ full_name: 'A', source: 'tiktok-dms' }), /source/);
    assert.strictEqual(S.cleanLeadBody({ full_name: '  Nusrat Jahan ' }).source, 'other');
});
test('email, phone, country, value and score are checked and normalised', () => {
    refuses(() => S.cleanLeadBody({ full_name: 'A', email: 'nusrat@' }), /email/);
    refuses(() => S.cleanLeadBody({ full_name: 'A', phone: '12' }), /phone/);
    refuses(() => S.cleanLeadBody({ full_name: 'A', country: 'Bangladesh' }), /two-letter/);
    refuses(() => S.cleanLeadBody({ full_name: 'A', value: 'lots' }), /number/);
    refuses(() => S.cleanLeadBody({ full_name: 'A', score: 140 }), /0 to 100/);
    const l = S.cleanLeadBody({ full_name: 'A', email: ' Nusrat@GlowStudio.com.bd ', phone: '01711-204318', country: 'bd', value: '85,000', currency: 'usd' });
    assert.strictEqual(l.email_norm, 'nusrat@glowstudio.com.bd');
    assert.strictEqual(l.phone_norm, '8801711204318');
    assert.strictEqual(l.country, 'BD');
    assert.strictEqual(l.value, 85000);
    assert.strictEqual(l.currency, 'USD');
});
test('a lead is never won by an edit: only Convert to client wins it', () => {
    refuses(() => S.cleanLeadBody({ stage: 'won' }, { partial: true }), /Convert to client/);
    assert.deepStrictEqual(S.cleanLeadBody({ stage: 'meeting' }, { partial: true }), { stage: 'meeting' });
});
test('an edit only touches the fields it sends', () => {
    assert.deepStrictEqual(S.cleanLeadBody({ next_step: 'Call back' }, { partial: true }), { next_step: 'Call back' });
});
test('duplicates match on email first, then on the same phone written another way', () => {
    const existing = [{ id: 1, email_norm: 'a@b.co', phone_norm: null }, { id: 2, email_norm: null, phone_norm: '8801711204318' }];
    assert.strictEqual(S.findDuplicate(S.cleanLeadBody({ full_name: 'X', email: 'A@B.co' }), existing).id, 1);
    assert.strictEqual(S.findDuplicate(S.cleanLeadBody({ full_name: 'X', phone: '+880 1711 204318' }), existing).id, 2);
    assert.strictEqual(S.findDuplicate(S.cleanLeadBody({ full_name: 'X', phone: '+1 617 555 0142' }), existing), null);
});

console.log('phase 87 :: import');
test('CSV: quotes, commas and line breaks inside quotes, CRLF', () => {
    const rows = S.parseCsv('Name,Company\r\n"Ortiz, Daniel","He said ""hi""\nthen left"\r\n\r\n');
    assert.deepStrictEqual(rows, [['Name', 'Company'], ['Ortiz, Daniel', 'He said "hi"\nthen left']]);
});
test('CSV columns are matched by their usual names; bad rows are reported, not imported', () => {
    const { leads, skipped } = S.csvToLeads(S.parseCsv('Full Name,Business,E-mail,Mobile,Lead source\nLaura Chen,Brightside Dental,laura@brightside.com,+1 401 555 0199,Google Ads\n,Chai Ghar,not-an-email,,\n'), 'seo');
    assert.strictEqual(leads.length, 1);
    assert.strictEqual(leads[0].source, 'ads_google');
    assert.strictEqual(leads[0].company, 'Brightside Dental');
    assert.strictEqual(skipped.length, 1);
    assert.strictEqual(skipped[0].row, 3);
});
test('a CSV with neither a name nor a company column is refused', () => {
    refuses(() => S.csvToLeads([['Email'], ['a@b.co']]), /Name or Company/);
});

console.log('phase 87 :: overview');
test('departments, channels, funnel, team and day buckets add up', () => {
    const since = '2026-11-01T00:00:00Z', until = '2026-11-08T00:00:00Z';
    const leads = [
        { id: 'a', source: 'ads_meta', stage: 'won', value: 50000, currency: 'BDT', owner_id: 'u1', created_at: '2026-11-01T10:00:00Z', stage_at: '2026-11-06T10:00:00Z' },
        { id: 'b', source: 'website', stage: 'meeting', value: 100, currency: 'USD', owner_id: 'u2', created_at: '2026-11-02T10:00:00Z', stage_at: '2026-11-03T10:00:00Z' },
        { id: 'c', source: 'seo', stage: 'lost', value: 999, currency: 'BDT', owner_id: 'u2', created_at: '2026-10-01T10:00:00Z', stage_at: '2026-11-02T10:00:00Z' }
    ];
    const activities = [
        { lead_id: 'a', type: 'email_out', actor_id: 'u1', at: '2026-11-01T11:00:00Z' },
        { lead_id: 'a', type: 'email_in', actor_id: null, at: '2026-11-02T11:00:00Z' },
        { lead_id: 'b', type: 'call', actor_id: 'u2', at: '2026-11-03T09:00:00Z' },
        { lead_id: 'b', type: 'stage', actor_id: 'u2', at: '2026-11-03T10:00:00Z', meta: { to: 'meeting' } },
        { lead_id: 'b', type: 'email_out', actor_id: 'u2', at: '2026-10-20T10:00:00Z' }
    ];
    const o = S.crmOverview({ leads, activities, since, until });
    assert.deepStrictEqual([o.totals.leads, o.totals.sent, o.totals.calls, o.totals.replies, o.totals.meetings, o.totals.won], [2, 1, 1, 1, 1, 1]);
    const mk = o.departments.find(d => d.key === 'marketing');
    assert.strictEqual(mk.won, 1); assert.strictEqual(mk.wonValue, 50000);
    assert.strictEqual(mk.children.find(c => c.key === 'ads_meta').sent, 1);
    const web = o.departments.find(d => d.key === 'website');
    assert.strictEqual(web.pipeline, 100 * 120, 'open value converted to taka');
    assert.strictEqual(o.departments.find(d => d.key === 'seo').pipeline, 0, 'lost leads are not pipeline');
    assert.deepStrictEqual(o.funnel.map(f => f[1]), [2, 2, 2, 2, 1, 1]);
    assert.deepStrictEqual(o.team.u1, { sent: 1, calls: 0, replies: 0, won: 1 });
    assert.strictEqual(o.series.leads.reduce((a, b) => a + b, 0), 2);
    assert.strictEqual(o.series.leads.length, 7);
});

console.log('phase 87 :: tools switch');
test('each tool owns its paths; the CRM, clients and billing are never blocked', () => {
    assert.strictEqual(S.toolForPath('/api/run-campaign'), 'leadfinder');
    assert.strictEqual(S.toolForPath('/api/leads/pipeline/9'), 'leadfinder');
    assert.strictEqual(S.toolForPath('/api/fb/groups'), 'facebook');
    assert.strictEqual(S.toolForPath('/api/xp/creators'), 'metaai');
    assert.strictEqual(S.toolForPath('/api/content-plan/notes'), 'content');
    assert.strictEqual(S.toolForPath('/api/reports-history'), 'reports');
    for (const p of ['/api/crm/leads', '/api/clients/1', '/api/client/billing', '/api/admin/tools', '/api/leadsx', '/api/site/content']) assert.strictEqual(S.toolForPath(p), null, p);
});
test('the switch: unreadable or missing means off; only true turns a tool on', () => {
    assert.ok(Object.values(S.parseToolSwitch(null)).every(v => v === false));
    assert.ok(Object.values(S.parseToolSwitch('{not json')).every(v => v === false));
    const t = S.parseToolSwitch(JSON.stringify({ reports: true, facebook: 'yes', unknown: true }));
    assert.strictEqual(t.reports, true); assert.strictEqual(t.facebook, false); assert.strictEqual(t.unknown, undefined);
});
test('a gate sits in front of the API before any tool route', () => {
    const gate = routes.findIndex(([m, p, h]) => m === 'use' && p === '/api/' && String(h[0]).includes('toolGate'));
    const firstTool = routes.findIndex(([m, p]) => m !== 'use' && S.toolForPath(p));
    assert.ok(gate >= 0, 'the gate is registered'); assert.ok(gate < firstTool, 'the gate comes before the first tool route');
});

console.log('phase 87 :: influencers');
test('handles are cleaned from @names and profile links; locations must be on the map', () => {
    assert.strictEqual(S.cleanInfluencerBody({ handle: 'https://www.instagram.com/mim.styles/' }).handle, 'mim.styles');
    assert.strictEqual(S.cleanInfluencerBody({ handle: '@rakibeats' }).handle, 'rakibeats');
    refuses(() => S.cleanInfluencerBody({ handle: 'x', lat: 95 }), /map/);
    refuses(() => S.cleanInfluencerBody({ handle: 'x', stage: 'married' }), /prospect/);
    refuses(() => S.cleanInfluencerBody({}), /handle/);
});

console.log(`\n${passed} passed`);
