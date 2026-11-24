#!/usr/bin/env node
/**
 * Phase 89 offline tests — the Tools: who gets in, and what the gate refuses.
 *
 * What matters: a tool opens only when the owner gave it to the person AND it is unlocked; the owner has every tool
 * but still needs it unlocked; giving a teammate tools never takes away the engines they hold for other work; the
 * Facebook switch unlocks both Facebook tools; a business-owner login is refused at the Apify tools' door, and only
 * there; and every Apify engine the server checks belongs to a tool, so it can be given to someone.
 *
 *   node tests/phase89.test.js
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
const pending = [];
const test = (name, fn) => pending.push([name, fn]);
const route = (m, p) => routes.find(r => r[0] === m && r[1] === p);

console.log('phase 89 :: who gets into the Tools');
test('a teammate given Lead Finder sees it, and it opens only once unlocked', () => {
    const off = S.toolAccess('user', ['leadgen'], {});
    const lf = off.find(t => t.key === 'leadfinder');
    assert.deepStrictEqual([lf.assigned, lf.unlocked, lf.open], [true, false, false]);
    const on = S.toolAccess('user', ['leadgen'], { leadfinder: true, reports: true }).find(t => t.key === 'leadfinder');
    assert.strictEqual(on.open, true);
});
test('a tool that is unlocked but not given stays shut', () => {
    const ig = S.toolAccess('user', ['leadgen'], { reports: true }).find(t => t.key === 'reports');
    assert.deepStrictEqual([ig.assigned, ig.open], [false, false]);
});
test('the owner has every tool, and still needs each one unlocked', () => {
    const all = S.toolAccess('admin', [], {});
    assert.ok(all.every(t => t.assigned && !t.open));
    assert.ok(S.toolAccess('admin', [], { leadfinder: true, reports: true, facebook: true }).every(t => t.open));
});
test('the Facebook switch unlocks both Facebook tools', () => {
    const t = S.toolAccess('user', ['fb_page', 'fb_community'], { facebook: true });
    assert.ok(t.find(x => x.key === 'fbpage').open && t.find(x => x.key === 'fbgroups').open);
});
test('a person with no tool engines is given nothing', () => assert.ok(S.toolAccess('user', ['meta_owned', 'content_plan'], { leadfinder: true }).every(t => !t.assigned)));
test('setting a teammate\'s tools replaces only the tool engines', () => {
    assert.deepStrictEqual(S.nextEngines(['meta_owned', 'leadgen', 'report'], ['fbpage']).sort(), ['fb_page', 'meta_owned']);
    assert.deepStrictEqual(S.nextEngines(['content_plan'], []), ['content_plan']);
    assert.deepStrictEqual(S.nextEngines([], ['leadfinder', 'nonsense']), ['leadgen']);
});
test('every Apify engine belongs to a tool, so it can be given', () => {
    const given = new Set(S.TOOL_AREA.flatMap(t => t.engines));
    for (const e of ['leadgen', 'report', 'fb_page', 'fb_community']) assert.ok(given.has(e), e);
});

console.log('phase 89 :: the gate');
const res = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
const runGate = async (path, profile) => {
    const realAuth = S.auth;
    S.auth = async () => profile ? { user: { id: 'u' }, profile } : null;
    const r = res(); let nexted = false;
    try { await S.toolGate({ path }, r, () => { nexted = true; }); } finally { S.auth = realAuth; }
    return { r, nexted };
};
test('a locked tool answers 403 tool_off before anyone is asked who they are', async () => {
    process.env.TOOLS_ENABLED = 'metaai';
    const { r, nexted } = await runGate('/api/run-campaign', { role: 'admin' });
    assert.strictEqual(nexted, false); assert.strictEqual(r.statusCode, 403); assert.strictEqual(r.body.code, 'tool_off');
});
test('an unlocked Apify tool lets the team through and refuses a business-owner login', async () => {
    process.env.TOOLS_ENABLED = 'all';
    assert.strictEqual((await runGate('/api/generate-ig-report', { role: 'user' })).nexted, true);
    const owner = await runGate('/api/fb/page-report', { role: 'client' });
    assert.strictEqual(owner.nexted, false); assert.strictEqual(owner.r.body.code, 'tool_team_only');
});
test('the owner app\'s own routes are not the Apify tools: an owner login still passes there', async () => {
    process.env.TOOLS_ENABLED = 'all';
    assert.strictEqual((await runGate('/api/xp/chat', { role: 'client' })).nexted, true);
    assert.strictEqual((await runGate('/api/crm/leads', { role: 'client' })).nexted, true, 'paths outside the tools are the routes\' own business');
});
test('the Tools routes are registered', () => {
    for (const [m, p] of [['get', '/api/tools/me'], ['get', '/api/tools/jobs'], ['get', '/api/admin/tools/access'], ['put', '/api/admin/tools/access/:id']]) assert.ok(route(m, p), m + ' ' + p);
});

(async () => {
    for (const [name, fn] of pending) {
        try { await fn(); passed++; console.log('  ok   ' + name); }
        catch (e) { console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n       ')); process.exitCode = 1; }
    }
    delete process.env.TOOLS_ENABLED;
    console.log(`\n${passed} passed`);
    process.exit();
})();
