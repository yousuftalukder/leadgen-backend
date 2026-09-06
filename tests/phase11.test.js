#!/usr/bin/env node
/**
 * Phase 11 offline tests. No network, no Supabase, no Apify.
 * Every external module is stubbed through Module._load so server.js loads
 * as a library and only the pure functions are exercised.
 *
 *   node tests/phase11.test.js
 */
'use strict';
const assert = require('assert');
const Module = require('module');
const path = require('path');

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

console.log('scheduleNextRun');
test('monthly: same month if still ahead', () => {
    const d = S.scheduleNextRun({ cadence: 'monthly', day_of_month: 15, hour_utc: 6 }, new Date('2026-09-06T00:00:00Z'));
    assert.strictEqual(d.toISOString(), '2026-09-15T06:00:00.000Z');
});
test('monthly: rolls to next month once passed', () => {
    const d = S.scheduleNextRun({ cadence: 'monthly', day_of_month: 1, hour_utc: 6 }, new Date('2026-09-06T00:00:00Z'));
    assert.strictEqual(d.toISOString(), '2026-10-01T06:00:00.000Z');
});
test('monthly: exactly at fire time moves on (strictly after)', () => {
    const d = S.scheduleNextRun({ cadence: 'monthly', day_of_month: 6, hour_utc: 6 }, new Date('2026-09-06T06:00:00Z'));
    assert.strictEqual(d.toISOString(), '2026-10-06T06:00:00.000Z');
});
test('monthly: December rolls the year', () => {
    const d = S.scheduleNextRun({ cadence: 'monthly', day_of_month: 1, hour_utc: 0 }, new Date('2026-12-15T00:00:00Z'));
    assert.strictEqual(d.toISOString(), '2027-01-01T00:00:00.000Z');
});
test('weekly: next Monday from a Sunday', () => {
    const d = S.scheduleNextRun({ cadence: 'weekly', day_of_week: 1, hour_utc: 9 }, new Date('2026-09-06T12:00:00Z')); // Sunday
    assert.strictEqual(d.toISOString(), '2026-09-07T09:00:00.000Z');
});
test('weekly: same weekday later today fires today', () => {
    const d = S.scheduleNextRun({ cadence: 'weekly', day_of_week: 0, hour_utc: 20 }, new Date('2026-09-06T12:00:00Z'));
    assert.strictEqual(d.toISOString(), '2026-09-06T20:00:00.000Z');
});
test('weekly: same weekday already passed fires next week', () => {
    const d = S.scheduleNextRun({ cadence: 'weekly', day_of_week: 0, hour_utc: 6 }, new Date('2026-09-06T12:00:00Z'));
    assert.strictEqual(d.toISOString(), '2026-09-13T06:00:00.000Z');
});
test('clamps: day_of_month 31 → 28, hour 99 → 23', () => {
    const d = S.scheduleNextRun({ cadence: 'monthly', day_of_month: 31, hour_utc: 99 }, new Date('2026-09-01T00:00:00Z'));
    assert.strictEqual(d.toISOString(), '2026-09-28T23:00:00.000Z');
});

console.log('scheduleInputForRun');
test('recomputes since from days and stamps ids', () => {
    const i = S.scheduleInputForRun({ id: 'sched-1', client_id: 'c-1', input: { days: 30, since: '2020-01-01', target: 'x' } });
    assert.strictEqual(i.scheduleId, 'sched-1');
    assert.strictEqual(i.clientId, 'c-1');
    assert.notStrictEqual(i.since, '2020-01-01');
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(i.since));
    assert.strictEqual(i.target, 'x');
});
test('leaves since alone when there is no window', () => {
    const i = S.scheduleInputForRun({ id: 's', client_id: null, input: { target: 'x' } });
    assert.strictEqual(i.since, undefined);
    assert.strictEqual(i.clientId, null);
});

console.log('cleanScheduleBody');
test('rejects bad cadence', () => { assert.throws(() => S.cleanScheduleBody({ cadence: 'daily' }), /weekly or monthly/); });
test('clamps and trims', () => {
    const b = S.cleanScheduleBody({ dayOfWeek: 9, dayOfMonth: 0, hourUtc: -3, label: '  x  ', paused: true });
    assert.deepStrictEqual(b, { day_of_week: 6, day_of_month: 1, hour_utc: 0, label: 'x', paused: true });
});

console.log('scheduleSummary');
test('ig_report with rivals', () => {
    assert.strictEqual(S.scheduleSummary({ job_type: 'ig_report', input: { target: 'a', rivals: ['b'] } }), 'IG audit @a vs @b');
});

console.log('share links');
test('token is base64url and long enough', () => {
    const t = S.shareToken(); assert.ok(/^[A-Za-z0-9_-]{32}$/.test(t), t);
    assert.notStrictEqual(S.shareToken(), t);
});
test('url picks the page by report_type', () => {
    assert.ok(S.shareUrlFor({ report_type: 'fb_page' }, 'tok').endsWith('/fb-report.html?share=tok'));
    assert.ok(S.shareUrlFor({ report_type: 'deep_audit' }, 'tok').endsWith('/ig-competitors.html?share=tok'));
    assert.ok(S.shareUrlFor({ report_type: 'fb_group' }, 'tok').endsWith('/fb-audit.html?share=tok'));
    assert.ok(S.shareUrlFor({ report_type: 'content_plan' }, 'tok').endsWith('/content-plan.html?share=tok'));
});
test('public view strips ownership fields', () => {
    const v = S.publicReportView({ id: 'r', user_id: 'u', client_id: 'c', set_id: 's', credits_estimate: 1, report_json: { a: 1 } });
    assert.deepStrictEqual(v, { id: 'r', report_json: { a: 1 } });
});

console.log('extractBioContacts');
test('business fields win', () => {
    const c = S.extractBioContacts({ businessEmail: 'A@B.com', businessPhoneNumber: '+8801700000000', biography: 'other@x.com' });
    assert.strictEqual(c.email, 'a@b.com'); assert.strictEqual(c.phone, '+8801700000000'); assert.deepStrictEqual(c.sources, []);
});
test('email and phone mined from bio', () => {
    const c = S.extractBioContacts({ biography: 'Cakes in Rangpur 🎂\nOrder: hello@rangpurcakes.com | 01712-345 678' });
    assert.strictEqual(c.email, 'hello@rangpurcakes.com');
    assert.strictEqual(c.phone, '01712345678');
    assert.ok(c.sources.includes('email:bio') && c.sources.includes('phone:bio'));
});
test('wa.me link becomes whatsapp and phone fallback', () => {
    const c = S.extractBioContacts({ biography: 'DM us', externalUrl: 'https://wa.me/8801712345678?text=hi' });
    assert.strictEqual(c.whatsapp, '+8801712345678');
    assert.strictEqual(c.phone, '+8801712345678');
    assert.strictEqual(c.website, null);
});
test('bioLinks array and a real website', () => {
    const c = S.extractBioContacts({ bioLinks: [{ url: 'https://shop.example.com' }, { url: 'https://api.whatsapp.com/send?phone=8801700000001' }] });
    assert.strictEqual(c.website, 'https://shop.example.com');
    assert.strictEqual(c.whatsapp, '+8801700000001');
});
test('no false phone from short digit runs', () => {
    const c = S.extractBioContacts({ biography: 'est. 2019 · 100% organic · 4.9 stars' });
    assert.strictEqual(c.phone, null); assert.strictEqual(c.email, null);
});

console.log('plays vs views');
test('getPlays / getVideoViews stay apart', () => {
    const i = { videoPlayCount: 900, videoViewCount: 3000 };
    assert.strictEqual(S.getPlays(i), 900); assert.strictEqual(S.getVideoViews(i), 3000);
    assert.strictEqual(S.getPlays({}), 0);
});
test('igNormalisePost carries plays', () => {
    const r = S.igNormalisePost({ shortCode: 'abc', caption: 'x', videoPlayCount: 10, videoViewCount: 40, timestamp: '2026-08-01T00:00:00Z', isVideo: true }, 'h');
    assert.strictEqual(r.plays, 10); assert.ok(r.views > 0);
});
test('igDistribution reports playback ratio', () => {
    const rows = [
        { likes: 1, comments: 0, views: 100, plays: 50, engagement_raw: 1 },
        { likes: 1, comments: 0, views: 200, plays: 40, engagement_raw: 1 },
        { likes: 1, comments: 0, views: 0, plays: 0, engagement_raw: 1 }
    ];
    const d = S.igDistribution(rows);
    assert.strictEqual(d.playback.distinguishable, 2);
    assert.strictEqual(d.playback.playsAvailable, true);
    assert.strictEqual(d.playback.medianPlaysPerView, 0.35);
    assert.strictEqual(d.plays.median, 45);
});

console.log('igPlaceUrls');
test('accepts explore urls, numeric ids, nested location; dedupes; ignores junk', () => {
    const u = S.igPlaceUrls([
        { url: 'https://www.instagram.com/explore/locations/123/rangpur/?x=1' },
        { locationId: '456' },
        { location: { id: '789' } },
        { id: 'not-a-number' },
        { url: 'https://www.instagram.com/explore/locations/123/rangpur/' },
        null
    ]);
    assert.deepStrictEqual(u, [
        'https://www.instagram.com/explore/locations/123/rangpur/',
        'https://www.instagram.com/explore/locations/456/',
        'https://www.instagram.com/explore/locations/789/'
    ]);
});

console.log('SCHEDULABLE_TYPES all have a worker');
test('every schedulable type is registered', () => {
    for (const t of Object.keys(S.SCHEDULABLE_TYPES)) assert.ok(S.JOB_WORKERS[t], t + ' has no worker');
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
process.exit(process.exitCode || 0);
