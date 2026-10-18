#!/usr/bin/env node
/**
 * Phase 64 offline tests — the instance keeps itself awake, always.
 *
 * What matters: on Render it pings its own public URL with no setting needed;
 * anywhere else (a laptop, this suite) it never pings production; SELF_URL
 * still wins; and the ping no longer waits for a job to be running.
 *
 *   node tests/phase64.test.js
 */
'use strict';
const assert = require('assert');
const Module = require('module');
const path = require('path');
const { execFileSync } = require('child_process');

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

// Child mode: report what this environment resolves the ping URL to, then stop.
if (process.argv[2] === '--resolve') {
    require(path.join(__dirname, '..', 'server.js'));
    process.stdout.write('\nURL=' + require(path.join(__dirname, '..', 'src', 'shared')).SELF_URL + '\n');
    process.exit(0);
}

const resolveIn = env => {
    const clean = { ...process.env, RENDER: '', SELF_URL: '', RENDER_EXTERNAL_URL: '', ...env };
    const out = execFileSync(process.execPath, [__filename, '--resolve'], { env: clean, encoding: 'utf8' });
    return (out.match(/^URL=(.*)$/m) || [])[1];
};

delete process.env.RENDER; delete process.env.SELF_URL; delete process.env.RENDER_EXTERNAL_URL;
require(path.join(__dirname, '..', 'server.js'));
const S = require(path.join(__dirname, '..', 'src', 'shared'));
let passed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; } }

(async () => {
    console.log('phase 64 :: where the ping goes');
    await test('on Render, with nothing set, it pings the production URL', () =>
        assert.strictEqual(resolveIn({ RENDER: 'true' }), 'https://leadgen-backend-1-mgzc.onrender.com'));
    await test('Render\'s own external URL is used when it is there', () =>
        assert.strictEqual(resolveIn({ RENDER: 'true', RENDER_EXTERNAL_URL: 'https://other.onrender.com/' }), 'https://other.onrender.com'));
    await test('SELF_URL wins over everything', () =>
        assert.strictEqual(resolveIn({ RENDER: 'true', SELF_URL: 'https://mine.example.com' }), 'https://mine.example.com'));
    await test('off Render with nothing set, it never pings production', () =>
        assert.strictEqual(resolveIn({}), ''));

    console.log('phase 64 :: when it pings');
    await test('every four minutes, inside the fifteen-minute idle window', () => assert.strictEqual(S.KEEPALIVE_MS, 240000));
    await test('the ping no longer waits for a running job', async () => {
        const src = String(S.keepAwake);
        assert.ok(!/from\('jobs'\)/.test(src), 'keepAwake still asks the jobs table first');
        assert.ok(/\/api\/health/.test(src));
    });
    await test('with no URL it does nothing and does not throw', async () => {
        const real = global.fetch; let called = 0;
        global.fetch = async () => { called++; return { status: 200 }; };
        try { await S.keepAwake(); } finally { global.fetch = real; }
        assert.strictEqual(called, 0);
    });

    console.log(`\n${passed} passed`);
})();
