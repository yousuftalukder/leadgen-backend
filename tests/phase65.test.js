#!/usr/bin/env node
/**
 * Phase 65 offline tests — connecting Facebook through Facebook Login for Business.
 *
 * The EdgeLead Meta app is a Business app, whose login takes a configuration id
 * (made in the App Dashboard) in place of a scope list. What matters: the dialog
 * carries config_id and not scope; the id can be overridden or switched off; and
 * without one the old scope list still goes.
 *
 *   node tests/phase65.test.js
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

if (process.argv[2] === '--resolve') {
    require(path.join(__dirname, '..', 'server.js'));
    process.stdout.write('\nCFG=' + require(path.join(__dirname, '..', 'src', 'shared')).META_CONFIG_ID + '\n');
    process.exit(0);
}
const resolveIn = env => {
    const out = execFileSync(process.execPath, [__filename, '--resolve'], { env: { ...process.env, META_CONFIG_ID: '', ...env }, encoding: 'utf8' });
    return (out.match(/^CFG=(.*)$/m) || [])[1];
};

delete process.env.META_CONFIG_ID;
require(path.join(__dirname, '..', 'server.js'));
const S = require(path.join(__dirname, '..', 'src', 'shared'));
let passed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; } }
const parse = u => new URL(u).searchParams;

console.log('phase 65 :: which configuration');
test('EdgeLead\'s configuration is the default', () => assert.strictEqual(S.META_CONFIG_ID, '1507223484577016'));
test('META_CONFIG_ID overrides it', () => assert.strictEqual(resolveIn({ META_CONFIG_ID: '42' }), '42'));
test('META_CONFIG_ID=none switches back to scopes', () => assert.strictEqual(resolveIn({ META_CONFIG_ID: 'none' }), ''));

console.log('phase 65 :: the dialog Facebook opens');
const cb = 'https://leadgen-backend-1-mgzc.onrender.com/api/meta/oauth/callback';
test('with a configuration it sends config_id and no scope', () => {
    const q = parse(S.metaDialogUrl({ state: 'abc', redirectUri: cb, appId: '111' }));
    assert.strictEqual(q.get('config_id'), '1507223484577016');
    assert.strictEqual(q.get('scope'), null);
    assert.strictEqual(q.get('client_id'), '111');
    assert.strictEqual(q.get('redirect_uri'), cb);
    assert.strictEqual(q.get('state'), 'abc');
    assert.strictEqual(q.get('response_type'), 'code');
});
test('without one it sends the scope list as before', () => {
    const q = parse(S.metaDialogUrl({ state: 'abc', redirectUri: cb, appId: '111', configId: '' }));
    assert.strictEqual(q.get('config_id'), null);
    assert.ok(q.get('scope').split(',').includes('ads_read'));
});
test('it opens on facebook.com at the Graph version the server reads', () =>
    assert.ok(S.metaDialogUrl({ state: 's', redirectUri: cb }).startsWith(`https://www.facebook.com/${S.META_GRAPH_VERSION}/dialog/oauth?`)));
test('the scope list is still read-only', () => {
    for (const s of S.META_SCOPES) assert.ok(!/manage_messages|publish|ads_management|pages_manage_posts/.test(s), s);
});

console.log(`\n${passed} passed`);
