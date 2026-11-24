#!/usr/bin/env node
/**
 * Phase 30 offline tests — growth from the change between days, and the
 * plumbing that makes the client surface installable.
 *
 * growthFrom is where a client would be quietly misled: a missed day that
 * turns a week's growth into "unknown", a zero baseline that becomes
 * +Infinity%, a comparison of today against itself. Each of those is a case
 * here. The rest checks that the manifest, the worker and the page heads say
 * what a phone needs to hear.
 *
 *   node tests/phase30.test.js
 */
'use strict';
const assert = require('assert');
const Module = require('module');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

// ---- stubs -----------------------------------------------------------------
const chain = () => {
    const p = Promise.resolve({ data: null, error: null, count: 0 });
    const h = new Proxy(function () {}, {
        get: (_, k) => (k === 'then' ? p.then.bind(p) : k === 'catch' ? p.catch.bind(p) : k === 'finally' ? p.finally.bind(p) : () => h),
        apply: () => h
    });
    return h;
};
const stubs = {
    express: Object.assign(() => ({
        set() {}, use() {}, get() {}, post() {}, patch() {}, delete() {}, put() {}, listen() {}
    }), { json: () => (_, __, n) => n && n(), raw: () => (_, __, n) => n && n(), static: () => () => {} }),
    cors: () => () => {},
    'apify-client': { ApifyClient: class {} },
    '@supabase/supabase-js': { createClient: () => ({ from: chain, rpc: chain, auth: { getUser: async () => ({ data: null, error: new Error('stub') }) } }) },
    dotenv: { config() {} }
};
const realLoad = Module._load;
Module._load = function (req, ...rest) { return stubs[req] !== undefined ? stubs[req] : realLoad.call(this, req, ...rest); };
process.env.SUPABASE_URL = 'http://stub'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';

const S = require(path.join(__dirname, '..', 'server.js'));
let passed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; } }

const TODAY = '2026-09-22';
const d = n => S.shiftDay(TODAY, n);

console.log('shiftDay — calendar arithmetic, not 24-hour arithmetic');
test('steps back across a month boundary', () => assert.strictEqual(S.shiftDay('2026-09-01', -1), '2026-08-31'));
test('steps back across a year boundary', () => assert.strictEqual(S.shiftDay('2026-01-01', -1), '2025-12-31'));
test('knows a leap day', () => assert.strictEqual(S.shiftDay('2028-02-28', 1), '2028-02-29'));

console.log('growthFrom — growth is the change between days');
// Thirty ended days and today's count. Followers step up; reach and
// interactions change between the two seven-day windows; visits do not.
const rows = [];
for (let i = 30; i >= 1; i--) {
    rows.push({ day: d(-i), followers: 9000 - i * 10, reach: i > 7 ? 1000 : 1200, profile_views: 50, interactions: i > 7 ? 80 : 60 });
}
rows.push({ day: TODAY, followers: 9240 });          // today's count; its activity is not complete yet

test('nothing yet is said, not computed', () => {
    const g = S.growthFrom([], TODAY);
    assert.strictEqual(g.empty, true);
    assert.strictEqual(g.days, 0);
    assert.strictEqual(g.followers, null);
});
test('followers: today against yesterday, a week ago and a month ago', () => {
    const g = S.growthFrom(rows, TODAY);
    assert.strictEqual(g.followers.now, 9240);
    assert.strictEqual(g.followers.asOf, TODAY);
    assert.strictEqual(g.followers.day, 9240 - 8990);
    assert.strictEqual(g.followers.week, 9240 - 8930);
    assert.strictEqual(g.followers.month, 9240 - 8700);
    assert.strictEqual(g.followers.week_pct, 3.5);
    assert.strictEqual(g.followers.month_pct, 6.2);
});
test('a missed day does not make a week unknown: the latest count on or before that day is used', () => {
    const gappy = rows.filter(r => r.day !== d(-7) && r.day !== d(-8));
    const g = S.growthFrom(gappy, TODAY);
    assert.strictEqual(g.followers.week, 9240 - 8910, 'should fall back to nine days ago');
});
test('today is never compared with itself', () => {
    const g = S.growthFrom([{ day: TODAY, followers: 100 }], TODAY);
    assert.strictEqual(g.followers.day, null);
    assert.strictEqual(g.followers.week, null);
    assert.strictEqual(g.followers.week_pct, null);
});
test('activity: the last seven ended days against the seven before, with a direction word', () => {
    const g = S.growthFrom(rows, TODAY);
    assert.strictEqual(g.reach.now, 7 * 1200);
    assert.strictEqual(g.reach.before, 7 * 1000);
    assert.strictEqual(g.reach.kind, 'up');
    assert.strictEqual(g.reach.pct, 20);
    assert.strictEqual(g.interactions.kind, 'down');
    assert.strictEqual(g.profile_views.kind, 'flat');
});
test('a zero baseline reads as new, never as a percentage', () => {
    const r2 = rows.map(r => ({ ...r, views: r.day >= d(-7) ? 5 : 0 }));
    const g = S.growthFrom(r2, TODAY);
    assert.strictEqual(g.views.kind, 'new');
    assert.strictEqual(g.views.pct, null);
});
test('no baseline at all is null, not zero', () => {
    const g = S.growthFrom([{ day: TODAY, followers: 100 }, { day: d(-1), followers: 99, reach: 10 }], TODAY);
    assert.strictEqual(g.followers.day, 1);
    assert.strictEqual(g.followers.week, null);
    assert.strictEqual(g.reach.now, 10);
    assert.strictEqual(g.reach.before, null);
    assert.strictEqual(g.reach.kind, 'unknown');
});
test('rows with activity but no count do not become the count', () => {
    const g = S.growthFrom([{ day: d(-2), followers: 500 }, { day: d(-1), reach: 30 }], TODAY);
    assert.strictEqual(g.followers.now, 500);
    assert.strictEqual(g.followers.asOf, d(-2));
});
test('the series is the last thirty days, oldest first; a date object is a day too', () => {
    const g = S.growthFrom(rows.map(r => ({ ...r, day: new Date(r.day + 'T00:00:00Z') })), TODAY);
    assert.strictEqual(g.series.length, 30);
    assert.strictEqual(g.series[0].day, d(-29));
    assert.strictEqual(g.series[29].day, TODAY);
    assert.strictEqual(g.since, d(-30));
});

console.log('phase 89 :: what is installable now, and what is gone');
const FRONT = path.join(__dirname, '..', 'frontend');
test('the Phone is the installable app: a valid manifest, standalone, with real icons', () => {
    const m = JSON.parse(fs.readFileSync(path.join(FRONT, 'phone.webmanifest'), 'utf8'));
    assert.strictEqual(m.display, 'standalone');
    assert.ok(m.icons.length && m.icons.every(i => fs.existsSync(path.join(FRONT, i.src.split('?')[0]))));
});
test('the old service worker clears its caches, unregisters and never answers a fetch', () => {
    const src = fs.readFileSync(path.join(FRONT, 'sw.js'), 'utf8');
    new vm.Script(src);
    assert.ok(/registration\.unregister\(\)/.test(src) && /caches\.delete/.test(src));
    assert.ok(!/addEventListener\('fetch'/.test(src));
    assert.ok(/el-phone-/.test(src), 'the Phone app\'s cache is left alone');
});
test('Netlify: the CRM at /, the Tools at /tools, every old page and /crm.html moved to /', () => {
    const n = fs.readFileSync(path.join(FRONT, 'netlify.toml'), 'utf8');
    assert.ok(/from = "\/tools"\s+to = "\/tools\/index\.html"\s+status = 200/.test(n));
    for (const old of ['crm', 'leads', 'admin', 'ig-report', 'fb-report', 'workspace', 'welcome']) {
        assert.ok(new RegExp(`from = "/${old}\\.html"\\s+to = "/"\\s+status = 301`).test(n), old);
    }
    assert.ok(/from = "https:\/\/ai\.edgelead\.online\/\*"\s+to = "https:\/\/workspace\.edgelead\.online\/"\s+status = 301/.test(n));
    assert.ok(/for = "\/sw\.js"[\s\S]*?no-cache/.test(n));
    assert.ok(!/to = "[^"]*crm/.test(n), 'nothing sends people to the CRM by name');
});
test('only the two apps, the Phone and the legal pages are left as pages', () => {
    const pages = fs.readdirSync(FRONT).filter(f => f.endsWith('.html')).sort();
    assert.deepStrictEqual(pages, ['data-deletion.html', 'index.html', 'phone.html', 'privacy.html', 'terms.html']);
    assert.ok(fs.existsSync(path.join(FRONT, 'tools', 'index.html')));
});

console.log(`\n${passed} passed`);
