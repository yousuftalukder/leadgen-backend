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
    }), { json: () => (_, __, n) => n && n(), static: () => () => {} }),
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

console.log('the installable client surface');
const FRONT = path.join(__dirname, '..', 'frontend');
test('the manifest is valid, standalone, and starts on the client dashboard', () => {
    const m = JSON.parse(fs.readFileSync(path.join(FRONT, 'manifest.webmanifest'), 'utf8'));
    assert.strictEqual(m.display, 'standalone');
    assert.ok(/^client\.html/.test(m.start_url), m.start_url);
    assert.ok(m.name && m.short_name && m.theme_color && m.background_color);
    assert.ok(m.icons.length >= 3 && m.icons.some(i => i.purpose === 'maskable'), 'a 192, a 512 and a maskable icon');
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (const i of m.icons) {
        const buf = fs.readFileSync(path.join(FRONT, i.src));
        assert.ok(buf.subarray(0, 8).equals(sig), i.src + ' is not a PNG');
    }
    assert.ok(fs.existsSync(path.join(FRONT, 'icons', 'apple-touch-icon.png')));
});
test('the service worker parses, is network-first, and never caches another origin', () => {
    const src = fs.readFileSync(path.join(FRONT, 'sw.js'), 'utf8');
    new vm.Script(src);                                     // throws on a syntax error
    assert.ok(/url\.origin !== self\.location\.origin/.test(src), 'the API and the CDNs must go straight through');
    assert.ok(/fetch\(req\)\.then/.test(src), 'network first, so a deploy reaches the phone');
    assert.ok(/caches\.match\('client\.html'\)/.test(src), 'an offline navigation falls back to the dashboard');
});
test('every client page carries the manifest and the iOS tags', () => {
    for (const p of ['client.html', 'client-assistant.html', 'client-leads.html', 'client-community.html']) {
        const h = fs.readFileSync(path.join(FRONT, p), 'utf8');
        assert.ok(/rel="manifest" href="manifest\.webmanifest"/.test(h), p + ' has no manifest');
        assert.ok(/apple-mobile-web-app-capable/.test(h) && /apple-touch-icon/.test(h), p + ' has no iOS tags');
        assert.ok(/name="theme-color"/.test(h), p + ' has no theme colour');
    }
});
test('header.js catches the install prompt at parse time and installs for clients only', () => {
    const h = fs.readFileSync(path.join(FRONT, 'header.js'), 'utf8');
    const listener = h.indexOf("addEventListener('beforeinstallprompt'");
    const init = h.indexOf('async init(options');
    assert.ok(listener > 0 && listener < init, 'the prompt fires before init runs, so the listener must be registered first');
    assert.ok(/if \(me\.role === 'client'\) \{ registerServiceWorker\(\); mountInstallNudge\(\); \}/.test(h), 'clients only');
    assert.ok(/localStorage\.setItem\('el-install-dismissed'/.test(h), '"not now" is remembered');
    assert.ok(/display-mode: standalone/.test(h), 'an installed app never sees the nudge');
});
test('the worker is never served stale, and the manifest has its own type', () => {
    const n = fs.readFileSync(path.join(FRONT, 'netlify.toml'), 'utf8');
    assert.ok(/for = "\/sw\.js"[\s\S]*?Cache-Control = "no-cache"/.test(n));
    assert.ok(/for = "\/manifest\.webmanifest"[\s\S]*?application\/manifest\+json/.test(n));
});

console.log(`\n${passed} passed`);
