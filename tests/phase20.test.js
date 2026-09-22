#!/usr/bin/env node
/**
 * Phase 20 offline tests — the master lead list's export.
 *
 * The CSV is the one place in this product where scraped text leaves the
 * system and is opened by a spreadsheet that will execute it. That makes it a
 * security boundary, not a formatting convenience, so it gets tested as one.
 *
 *   node tests/phase20.test.js
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

const cell = S.csvCell;

/**
 * What the spreadsheet sees in the cell, after CSV quoting is undone.
 *
 * The two treatments compose: a formula value that also contains a comma is
 * neutralised AND quoted, so the raw output starts with '"' and the apostrophe
 * sits inside. Asserting on the raw string tested the wrapper rather than the
 * protection.
 */
function seen(v) {
    const out = cell(v);
    return /^".*"$/s.test(out) ? out.slice(1, -1).replace(/""/g, '"') : out;
}

console.log('csvCell — formula injection, because a spreadsheet executes what it opens');
test('a value starting = is neutralised', () => {
    // Left as-is, Excel runs this on open and the operator's sheet phones home.
    assert.ok(seen('=HYPERLINK("http://evil.test","click")').startsWith("'="), cell('=HYPERLINK("http://evil.test","click")'));
});
test('+ , - and @ are neutralised too, not just =', () => {
    for (const lead of ['+', '-', '@']) {
        assert.ok(seen(lead + 'SUM(A1:A9)').startsWith("'" + lead), `${lead} got through`);
    }
});
test('a leading tab or carriage return is neutralised', () => {
    // Both are treated as formula leads once the sheet trims whitespace.
    for (const lead of ['\t', '\r']) {
        assert.ok(seen(lead + '=1+1').startsWith("'"), JSON.stringify(lead) + ' -> ' + JSON.stringify(cell(lead + '=1+1')));
    }
});
test('the quoting and the neutralising compose rather than cancelling out', () => {
    // The regression this guards: quoting first would put '"' at the front, the
    // formula check would then see '"' and skip, and =1,2 would arrive live.
    const raw = cell('=1,2');
    assert.ok(!/^=/.test(raw), raw);
    assert.strictEqual(seen('=1,2'), "'=1,2");
});
test('an ordinary phone number starting + is still neutralised, and still readable', () => {
    const out = cell('+8801711000000');
    assert.strictEqual(out, "'+8801711000000");
});
test('ordinary text is left completely alone', () => {
    for (const v of ['harborcafe', 'Harbor Cafe', 'hello@x.com'.slice(1), '9240', 'Boston']) {
        assert.strictEqual(cell(v), v, v);
    }
});

console.log('csvCell — CSV structure, because scraped bios contain everything');
test('a comma forces quoting', () => {
    assert.strictEqual(cell('Rangpur, Bangladesh'), '"Rangpur, Bangladesh"');
});
test('a double quote is doubled and the cell quoted', () => {
    assert.strictEqual(cell('the "best" coffee'), '"the ""best"" coffee"');
});
test('a newline inside a bio does not break the row', () => {
    const out = cell('line one\nline two');
    assert.ok(out.startsWith('"') && out.endsWith('"'), out);
    assert.ok(out.includes('\n'), 'the newline should survive inside the quotes');
});
test('a value that is both a formula and comma-laden gets both treatments', () => {
    const out = cell('=CONCAT(A1,B1)');
    assert.ok(out.startsWith('"\'=') || out.startsWith("'="), out);
    // Whichever order, it must not begin with a bare '='.
    assert.ok(!/^=/.test(out), out);
});
test('null and undefined become empty, not the strings "null"/"undefined"', () => {
    assert.strictEqual(cell(null), '');
    assert.strictEqual(cell(undefined), '');
});
test('zero and false survive as values rather than becoming empty', () => {
    assert.strictEqual(cell(0), '0');
    assert.strictEqual(cell(false), 'false');
});
test('no output ever starts with a character a spreadsheet would execute', () => {
    const nasty = ['=1', '+1', '-1', '@x', '\t=1', '\r=1', '=cmd|\' /C calc\'!A0',
                   'ok', '', null, 0, 'a,b', '"q"'];
    for (const v of nasty) {
        const out = cell(v);
        assert.ok(!/^[=+\-@\t\r]/.test(out), `${JSON.stringify(v)} -> ${JSON.stringify(out)}`);
    }
});

console.log('sort whitelist — an ORDER BY must never come from the query string');
test('every declared sort names a real leads column', () => {
    const cols = new Set(['created_at', 'followers_count', 'username', 'engagement_rate', 'city']);
    for (const [k, v] of Object.entries(S.LEAD_SORTS)) {
        assert.ok(cols.has(v.col), `sort "${k}" orders by "${v.col}", which is not a leads column`);
    }
});
test('every sort declares a direction explicitly', () => {
    for (const [k, v] of Object.entries(S.LEAD_SORTS)) {
        assert.strictEqual(typeof v.asc, 'boolean', `sort "${k}" has no explicit direction`);
    }
});
test('there is a default named "newest" for the route to fall back to', () => {
    assert.ok(S.LEAD_SORTS.newest, 'the route falls back to LEAD_SORTS.newest');
    assert.strictEqual(S.LEAD_SORTS.newest.asc, false);
});
test('the whitelist is small and closed — no pass-through key', () => {
    const keys = Object.keys(S.LEAD_SORTS);
    assert.ok(keys.length <= 8, `${keys.length} sorts is more than this list needs`);
    for (const k of keys) assert.ok(/^[a-z]+$/.test(k), `"${k}" is not a plain key`);
});

console.log('\n' + passed + ' passed');
