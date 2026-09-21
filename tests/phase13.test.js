#!/usr/bin/env node
/**
 * Phase 13 offline tests. No network, no Supabase, no Apify.
 * Same harness as phase11.test.js: every external module is stubbed through
 * Module._load so server.js loads as a library and only pure functions run.
 *
 *   node tests/phase13.test.js
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

const FUTURE = new Date(Date.now() + 86400000 * 30).toISOString();
const PAST   = new Date(Date.now() - 86400000 * 30).toISOString();
const client = (extra) => Object.assign({ role: 'client', is_active: true }, extra);

console.log('accountState — precedence');
test('suspension beats an admin role', () => {
    assert.strictEqual(S.accountState({ role: 'admin', is_active: false }), 'suspended');
});
test('suspension beats a paid window', () => {
    assert.strictEqual(S.accountState(client({ is_active: false, paid_until: FUTURE })), 'suspended');
});
test('admin is admin with no dates at all', () => {
    assert.strictEqual(S.accountState({ role: 'admin', is_active: true }), 'admin');
});
test('an employee never expires', () => {
    assert.strictEqual(S.accountState({ role: 'user', is_active: true }), 'employee');
});
test('viewer counts as an employee, not a client', () => {
    assert.strictEqual(S.accountState({ role: 'viewer', is_active: true }), 'employee');
});
test('paid beats trial when both are live', () => {
    assert.strictEqual(S.accountState(client({ paid_until: FUTURE, trial_ends_at: FUTURE })), 'paid');
});
test('a live trial with no paid window is a trial', () => {
    assert.strictEqual(S.accountState(client({ trial_ends_at: FUTURE })), 'trial');
});
test('a lapsed trial is expired', () => {
    assert.strictEqual(S.accountState(client({ trial_ends_at: PAST })), 'expired');
});
test('a lapsed paid window is expired even with a live trial date behind it', () => {
    assert.strictEqual(S.accountState(client({ paid_until: PAST, trial_ends_at: PAST })), 'expired');
});
test('a client with no windows at all is expired', () => {
    assert.strictEqual(S.accountState(client({})), 'expired');
});
test('a missing profile is expired, never admin', () => {
    assert.strictEqual(S.accountState(null), 'expired');
    assert.strictEqual(S.accountState(undefined), 'expired');
});

console.log('accountState — the auth() fallback must not read as suspended');
test("auth()'s ensureProfile fallback stays served", () => {
    // auth() falls back to { role: 'user', is_active: true } when the profile
    // lookup fails. If is_active were ever dropped from that object this goes
    // to 'suspended' and every caller is locked out.
    assert.strictEqual(S.accountState({ role: 'user', is_active: true }), 'employee');
});
test('a profile with is_active absent is suspended, not served', () => {
    assert.strictEqual(S.accountState({ role: 'user' }), 'suspended');
});

console.log('accountDenial');
test('suspended is 403', () => {
    const d = S.accountDenial({ role: 'client', is_active: false });
    assert.strictEqual(d.status, 403);
});
test('expired is 402, so the client surface can tell it from forbidden', () => {
    const d = S.accountDenial(client({ trial_ends_at: PAST }));
    assert.strictEqual(d.status, 402);
    assert.strictEqual(d.body.state, 'expired');
    assert.strictEqual(d.body.ended_at, PAST);
});
test('expired with no history says so differently', () => {
    const d = S.accountDenial(client({}));
    assert.strictEqual(d.status, 402);
    assert.strictEqual(d.body.ended_at, null);
    assert.ok(/no active plan/i.test(d.body.error));
});
test('a live trial is not denied', () => {
    assert.strictEqual(S.accountDenial(client({ trial_ends_at: FUTURE })), null);
});
test('a paid client is not denied', () => {
    assert.strictEqual(S.accountDenial(client({ paid_until: FUTURE })), null);
});
test('an employee is not denied', () => {
    assert.strictEqual(S.accountDenial({ role: 'user', is_active: true }), null);
});

console.log('quotaPeriod');
test('trial spend lives in its own bucket', () => {
    assert.strictEqual(S.quotaPeriod('trial'), 'trial');
});
test('paid spend is bucketed by UTC month', () => {
    const p = S.quotaPeriod('paid');
    assert.ok(/^\d{4}-\d{2}$/.test(p), 'expected YYYY-MM, got ' + p);
    const d = new Date();
    assert.strictEqual(p, `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
});
test('trial and paid never share a counter', () => {
    assert.notStrictEqual(S.quotaPeriod('trial'), S.quotaPeriod('paid'));
});

console.log('quota wiring');
test('leadgen is not item-metered — it is counted at insert time', () => {
    for (const t of S.LEADGEN_JOB_TYPES) {
        assert.strictEqual(S.JOB_QUOTA_METRIC[t], undefined,
            `${t} must not consume an item at queue time`);
    }
});
test('report and audit types are item-metered', () => {
    assert.strictEqual(S.JOB_QUOTA_METRIC.ig_report, 'ig_report');
    assert.strictEqual(S.JOB_QUOTA_METRIC.deep_audit, 'ig_report');
    assert.strictEqual(S.JOB_QUOTA_METRIC.fb_community_audit, 'fb_group_audit');
    assert.strictEqual(S.JOB_QUOTA_METRIC.fb_discovery, 'fb_group_audit');
});
test('the fallback caps fail closed — every metric has a number', () => {
    for (const state of ['trial', 'paid']) {
        for (const metric of ['ig_report', 'fb_group_audit', 'leads', 'usd']) {
            const v = S.QUOTA_FALLBACK[state][metric];
            assert.ok(typeof v === 'number' && v >= 0,
                `QUOTA_FALLBACK.${state}.${metric} must be a number, got ${v}`);
        }
    }
});
test('the trial fallback is tighter than the paid one', () => {
    for (const metric of ['ig_report', 'fb_group_audit', 'leads', 'usd']) {
        assert.ok(S.QUOTA_FALLBACK.trial[metric] <= S.QUOTA_FALLBACK.paid[metric],
            `trial ${metric} must not exceed paid`);
    }
});

console.log('402 must distinguish a hit allowance from a lapsed account');
test('a quota refusal is 402 and carries quota_exceeded', () => {
    const e = S.quotaError('leads', 50);
    assert.strictEqual(e.statusCode, 402);
    assert.strictEqual(e.code, 'quota_exceeded');
    assert.strictEqual(e.quotaMetric, 'leads');
});
test('a quota refusal never claims access has ended', () => {
    // Both cases answer 402. Without the code the client surface shows the
    // lapsed-account screen, telling someone who merely ran out of leads that
    // their account is over.
    for (const m of ['leads', 'ig_report', 'fb_group_audit', 'usd']) {
        const e = S.quotaError(m, 1);
        assert.ok(!/access has ended|no active plan/i.test(e.message), e.message);
        assert.notStrictEqual(e.code, 'account_expired');
    }
});
test('a lapsed account is still a plain 402 with no quota code', () => {
    const d = S.accountDenial(client({ trial_ends_at: PAST }));
    assert.strictEqual(d.status, 402);
    assert.strictEqual(d.body.state, 'expired');
    assert.notStrictEqual(d.body.code, 'quota_exceeded');
});
test('the usd refusal does not quote our Apify cost at the client', () => {
    const e = S.quotaError('usd', 2);
    assert.ok(!/\$|usd|apify/i.test(e.message), e.message);
});

console.log('trial engine grants');
test('a trial cannot reach the paid surface', () => {
    assert.ok(!S.TRIAL_ENGINES.includes('content_plan'));
    assert.ok(!S.TRIAL_ENGINES.includes('fb_page'));
});
test('a trial can reach the things the pitch promises', () => {
    for (const e of ['report', 'fb_community', 'leadgen', 'meta_owned']) {
        assert.ok(S.TRIAL_ENGINES.includes(e), `trial should grant ${e}`);
    }
});

console.log('\n' + passed + ' passed');
