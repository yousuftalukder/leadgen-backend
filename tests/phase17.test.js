#!/usr/bin/env node
/**
 * Phase 17 offline tests — the content plan's boost gate.
 *
 * This is the one place in the product where a model's output turns into
 * "spend money on this", so it gets its own file and is tested adversarially.
 *
 *   node tests/phase17.test.js
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

const call = (boost, why, modelWhy) => S.cpBoostCall(boost, why, modelWhy);

console.log('cpBoostCall — money may only follow proof');
test('a proven cell may be recommended for boosting', () => {
    const r = call('worth boosting', 'double_down');
    assert.strictEqual(r.boost, 'worth boosting');
    assert.strictEqual(r.downgraded, false);
});
test('an unproven cell is downgraded no matter how confident the model was', () => {
    const r = call('worth boosting', 'gap');
    assert.strictEqual(r.boost, 'organic only');
    assert.strictEqual(r.downgraded, true);
});
test('the downgrade explains itself rather than silently disagreeing', () => {
    const r = call('worth boosting', 'gap');
    assert.ok(/win it organically/i.test(r.why), r.why);
    // The brief next to it will say "worth boosting"; the page needs to be
    // able to say why the plan disagrees.
    assert.ok(r.why && r.why.length > 20);
});
test('an unknown cell reason is treated as unproven, not as proven', () => {
    for (const why of ['', null, undefined, 'something_else', 'DOUBLE_DOWN', 'doubledown']) {
        const r = call('worth boosting', why);
        assert.strictEqual(r.boost, 'organic only', `"${why}" was treated as proven`);
    }
});
test('organic advice passes through untouched on either kind of cell', () => {
    for (const why of ['gap', 'double_down']) {
        const r = call('organic only', why, 'Too early to spend.');
        assert.strictEqual(r.boost, 'organic only');
        assert.strictEqual(r.downgraded, false);
        assert.strictEqual(r.why, 'Too early to spend.');
    }
});
test('a missing or malformed boost field defaults to organic, never to spend', () => {
    for (const b of [undefined, null, '', 0, false, {}, []]) {
        assert.strictEqual(call(b, 'double_down').boost, 'organic only',
            `"${String(b)}" should not be read as a recommendation to spend`);
    }
});
test('the output is always one of exactly two values', () => {
    const seen = new Set();
    for (const b of ['worth boosting', 'WORTH BOOSTING', 'probably worth it', 'organic only', 'yes', null]) {
        for (const why of ['gap', 'double_down', null]) seen.add(call(b, why).boost);
    }
    assert.deepStrictEqual([...seen].sort(), ['organic only', 'worth boosting']);
});
test('phrasing variants the model might reach for do not smuggle a spend through on a gap', () => {
    for (const b of ['worth boosting', 'Worth Boosting', 'definitely worth boosting', 'worth a boost']) {
        assert.strictEqual(call(b, 'gap').boost, 'organic only', `"${b}" got through on a gap cell`);
    }
});
test('a downgrade never keeps the model\'s justification for spending', () => {
    const r = call('worth boosting', 'gap', 'This will crush it, put £500 behind it.');
    assert.ok(!/£|crush|500/i.test(r.why),
        'the model\'s spending rationale survived the downgrade: ' + r.why);
});

console.log('\n' + passed + ' passed');
