#!/usr/bin/env node
/**
 * Phase 19 offline tests — the month boundary, the comparison band, and the
 * arithmetic a monthly report is built on.
 *
 * These are the three places phase 19 can be quietly wrong in a way nobody
 * notices until a client is reading it: a month that is off by one, a
 * comparison against an account nothing like theirs, and a percentage that
 * turns "we went from nothing to something" into "+Infinity%".
 *
 *   node tests/phase19.test.js
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

const iso = sec => new Date(sec * 1000).toISOString();

console.log('metaMonthWindow — a month is a month, not thirty days');
test('it starts at midnight UTC on the 1st', () => {
    assert.strictEqual(iso(S.metaMonthWindow('2026-09').since), '2026-09-01T00:00:00.000Z');
});
test('it ends at the 1st of the NEXT month, exclusive', () => {
    // Half-open. If this were the 30th, every post on the last day of the
    // month would fall outside its own report.
    assert.strictEqual(iso(S.metaMonthWindow('2026-09').until), '2026-10-01T00:00:00.000Z');
});
test('a 31-day month is 31 days, not 30', () => {
    const w = S.metaMonthWindow('2026-08');
    assert.strictEqual((w.until - w.since) / 86400, 31);
});
test('February in a leap year is 29 days', () => {
    const w = S.metaMonthWindow('2028-02');
    assert.strictEqual((w.until - w.since) / 86400, 29);
});
test('December rolls into the next year rather than month 13', () => {
    assert.strictEqual(iso(S.metaMonthWindow('2026-12').until), '2027-01-01T00:00:00.000Z');
});

console.log('metaPrevMonth — the month it is compared against');
test('it steps back one month', () => {
    assert.strictEqual(S.metaPrevMonth('2026-09'), '2026-08');
});
test('January steps back to December of the previous year', () => {
    assert.strictEqual(S.metaPrevMonth('2026-01'), '2025-12');
});
test('it keeps the zero padding, because the value is compared as a string', () => {
    assert.strictEqual(S.metaPrevMonth('2026-10'), '2026-09');
    assert.ok(/^\d{4}-\d{2}$/.test(S.metaPrevMonth('2026-02')));
});

console.log('metaDefaultMonth — never a month still running');
test('it is the previous month, not the current one', () => {
    assert.strictEqual(S.metaDefaultMonth(new Date('2026-09-21T10:00:00Z')), '2026-08');
});
test('on the 1st it is still the previous month', () => {
    assert.strictEqual(S.metaDefaultMonth(new Date('2026-09-01T00:00:01Z')), '2026-08');
});
test('in January it is December of the year before', () => {
    assert.strictEqual(S.metaDefaultMonth(new Date('2026-01-14T10:00:00Z')), '2025-12');
});
test('the default is always strictly before the current month', () => {
    for (const d of ['2026-01-31', '2026-03-01', '2026-12-31', '2028-02-29']) {
        const now = new Date(d + 'T12:00:00Z');
        assert.ok(S.metaDefaultMonth(now) < now.toISOString().slice(0, 7), d);
    }
});

console.log('pctDelta — the cases that make a report lie');
test('an ordinary rise is a rounded percentage', () => {
    const d = S.pctDelta(120, 100);
    assert.strictEqual(d.pct, 20);
    assert.strictEqual(d.kind, 'up');
});
test('a fall is negative and marked down', () => {
    const d = S.pctDelta(80, 100);
    assert.strictEqual(d.pct, -20);
    assert.strictEqual(d.kind, 'down');
});
test('growth from zero is "new", never a percentage and never Infinity', () => {
    const d = S.pctDelta(40, 0);
    assert.strictEqual(d.kind, 'new');
    assert.strictEqual(d.pct, null, 'a percentage against a zero baseline is meaningless');
});
test('zero to zero is flat, not new', () => {
    assert.strictEqual(S.pctDelta(0, 0).kind, 'flat');
});
test('a change under one percent reads as flat rather than as movement', () => {
    assert.strictEqual(S.pctDelta(1004, 1000).kind, 'flat');
    assert.strictEqual(S.pctDelta(996, 1000).kind, 'flat');
});
test('a missing number is unknown, not zero', () => {
    for (const [a, b] of [[null, 100], [100, null], [undefined, 5], ['x', 5]]) {
        assert.strictEqual(S.pctDelta(a, b).kind, 'unknown', `${a} vs ${b}`);
    }
});
test('no delta ever comes back as Infinity or NaN', () => {
    const pairs = [[1, 0], [0, 0], [0, 1], [-5, 10], [1e9, 1], [null, null]];
    for (const [a, b] of pairs) {
        const { pct } = S.pctDelta(a, b);
        assert.ok(pct === null || Number.isFinite(pct), `${a} vs ${b} gave ${pct}`);
    }
});

console.log('comparableBand — who it is fair to compare against');
test('the band is a third to three times their size', () => {
    const b = S.comparableBand(9000);
    assert.strictEqual(b.min, 3000);
    assert.strictEqual(b.max, 27000);
});
test('their own size is always inside their own band', () => {
    for (const f of [250, 1000, 9000, 250000]) {
        const b = S.comparableBand(f);
        assert.ok(f >= b.min && f <= b.max, `${f} fell outside its own band`);
    }
});
test('a huge account is excluded from a small one\'s band', () => {
    // The whole point: a 900-follower florist learns nothing from a chain.
    const b = S.comparableBand(900);
    assert.ok(400000 > b.max);
});
test('a tiny account gets an absolute floor, because a ratio means nothing there', () => {
    const b = S.comparableBand(50);
    assert.strictEqual(b.min, 0);
    assert.ok(b.max >= 3000, 'a 50-follower account would otherwise have a band of 17-150');
});
test('a missing follower count does not throw or produce NaN bounds', () => {
    for (const f of [null, undefined, 'x', 0]) {
        const b = S.comparableBand(f);
        assert.ok(Number.isFinite(b.min) && Number.isFinite(b.max), String(f));
    }
});

console.log('competitorQueries — what is actually searched for');
test('the most specific phrase comes first', () => {
    const q = S.competitorQueries('bridal wear', 'Dhaka, Bangladesh');
    assert.ok(/dhaka/i.test(q[0]), q[0]);
});
test('the city is used, not the whole address string', () => {
    const q = S.competitorQueries('coffee', 'Rangpur, Bangladesh');
    assert.ok(q.some(s => s === 'coffee Rangpur' || s === 'Rangpur coffee'), q.join(' | '));
});
test('no niche means nothing to search for', () => {
    assert.deepStrictEqual(S.competitorQueries('', 'Dhaka'), []);
    assert.deepStrictEqual(S.competitorQueries(null, 'Dhaka'), []);
});
test('a niche with no location still searches', () => {
    const q = S.competitorQueries('home solar', '');
    assert.deepStrictEqual(q, ['home solar']);
});
test('it never sends more than three queries, because each one costs', () => {
    const q = S.competitorQueries('a very long niche name', 'City, Region, Country');
    assert.ok(q.length <= 3, `${q.length} queries`);
});
test('duplicates are collapsed rather than searched twice', () => {
    const q = S.competitorQueries('cafe', 'Dhaka');
    assert.strictEqual(new Set(q).size, q.length);
});

console.log('the monthly metric list');
test('every metric declares which level it is read at', () => {
    for (const m of S.META_MONTH_METRICS) {
        assert.ok(m.level === 'ig' || m.level === 'page', `${m.key} has level "${m.level}"`);
    }
});
test('every metric has a label a client could read', () => {
    for (const m of S.META_MONTH_METRICS) {
        assert.ok(m.label && !/_/.test(m.label), `${m.key} would be shown as "${m.label}"`);
    }
});
test('metric keys are unique', () => {
    const keys = S.META_MONTH_METRICS.map(m => m.key);
    assert.strictEqual(new Set(keys).size, keys.length);
});
test('both platforms are covered — a monthly report is not Instagram only', () => {
    const levels = new Set(S.META_MONTH_METRICS.map(m => m.level));
    assert.ok(levels.has('ig') && levels.has('page'));
});

console.log('the assistant prompt splits by audience, not by access');
const owner    = S.assistantSystemPrompt({ audience: 'owner',    metaConnected: true, handle: 'harborcafe' });
const operator = S.assistantSystemPrompt({ audience: 'operator', metaConnected: true, handle: 'harborcafe', client: { name: 'Harbor Cafe', niche: 'coffee' }, clientId: 'c1' });

test('an operator is not told to hide how the product works from themselves', () => {
    assert.ok(/never mention tools/i.test(owner));
    assert.ok(!/never mention tools/i.test(operator), 'the operator prompt inherited the owner gag');
});
test('both are forbidden from inventing figures', () => {
    for (const p of [owner, operator]) assert.ok(/never invent a figure/i.test(p));
});
test('both are forbidden from blending scraped and owner numbers', () => {
    for (const p of [owner, operator]) {
        assert.ok(/never averaged, added or compared/i.test(p), 'the two sources could be mixed silently');
    }
});
test('a scoped operator is told the other clients are out of reach', () => {
    assert.ok(/cannot see the operator's other clients/i.test(operator));
});
test('an unscoped operator is not told about a client that is not there', () => {
    const loose = S.assistantSystemPrompt({ audience: 'operator', metaConnected: false });
    assert.ok(!/cannot see the operator's other clients/i.test(loose));
});
test('an unconnected operator is not given the owner\'s upsell script', () => {
    const p = S.assistantSystemPrompt({ audience: 'operator', metaConnected: false });
    assert.ok(/do not pitch connecting/i.test(p), 'an employee does not need to be sold our own feature');
});
test('an unconnected owner still gets the explanation, once', () => {
    const p = S.assistantSystemPrompt({ audience: 'owner', metaConnected: false });
    assert.ok(/say it once/i.test(p));
});

console.log('the monthly tool the assistant reads it with');
test('it exists and is runnable', () => {
    assert.ok(S.ASSISTANT_TOOLS.get_monthly_report, 'the assistant cannot read a monthly report');
    assert.strictEqual(typeof S.ASSISTANT_TOOLS.get_monthly_report.run, 'function');
});
test('it takes a month and nothing that could widen its scope', () => {
    const props = Object.keys(S.ASSISTANT_TOOLS.get_monthly_report.decl.parameters.properties);
    assert.deepStrictEqual(props, ['month']);
});
test('its description tells the model not to assemble a month by hand', () => {
    const d = S.ASSISTANT_TOOLS.get_monthly_report.decl.description;
    assert.ok(/do not assemble a month by hand/i.test(d));
});
test('it is declared alongside the others, so the model can actually call it', () => {
    assert.ok(S.assistantDeclarations().some(d => d.name === 'get_monthly_report'));
});

console.log('\n' + passed + ' passed');
