#!/usr/bin/env node
/**
 * Phase 15 offline tests — the owner assistant's contract with the model.
 * Same harness as the other phases: no network, no Supabase, no Apify.
 *
 *   node tests/phase15.test.js
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

// The sync runner above reports a pass the moment fn() returns, so an async
// body would be recorded green before its assertions ran. Async cases go
// through here and are awaited before the summary prints.
const pending = [];
function testAsync(name, fn) {
    pending.push(
        Promise.resolve()
            .then(fn)
            .then(() => { passed++; console.log('  ok   ' + name); })
            .catch(e => { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; })
    );
}

const NAMES = Object.keys(S.ASSISTANT_TOOLS);

console.log('tool declarations — the model must be able to parse these');
test('there is at least one tool', () => {
    assert.ok(NAMES.length >= 5, `only ${NAMES.length} tools`);
});
test('every tool declares a name matching its key', () => {
    for (const k of NAMES) assert.strictEqual(S.ASSISTANT_TOOLS[k].decl.name, k);
});
test('every tool is runnable', () => {
    for (const k of NAMES) assert.strictEqual(typeof S.ASSISTANT_TOOLS[k].run, 'function');
});
test('every declaration has an OBJECT parameter schema', () => {
    for (const d of S.assistantDeclarations()) {
        assert.strictEqual(d.parameters.type, 'OBJECT', `${d.name} parameters.type`);
        assert.strictEqual(typeof d.parameters.properties, 'object', `${d.name} properties`);
    }
});
test('every required parameter is actually declared', () => {
    for (const d of S.assistantDeclarations()) {
        for (const r of (d.parameters.required || [])) {
            assert.ok(d.parameters.properties[r], `${d.name} requires "${r}" but never declares it`);
        }
    }
});
test('descriptions are written for a model to choose between, not stubs', () => {
    for (const d of S.assistantDeclarations()) {
        assert.ok(d.description && d.description.length > 60,
            `${d.name} description is too thin for the model to route on`);
    }
});
test('declaration names are unique', () => {
    const names = S.assistantDeclarations().map(d => d.name);
    assert.strictEqual(new Set(names).size, names.length);
});

console.log('scope — a tool must not be able to widen its own reach');
test('no tool takes a user id, client id or scope argument', () => {
    // Scope is resolved server-side by assistantScope and passed in. If a tool
    // accepted an account argument the model could invent one and read across
    // accounts.
    const banned = /(^|_)(user|owner|account|client|scope)(_?id)?$/i;
    for (const d of S.assistantDeclarations()) {
        for (const p of Object.keys(d.parameters.properties || {})) {
            assert.ok(!banned.test(p), `${d.name} accepts "${p}" — scope must never come from the model`);
        }
    }
});
test('the only id a tool accepts is a report id, which is re-checked', () => {
    const idArgs = [];
    for (const d of S.assistantDeclarations()) {
        for (const p of Object.keys(d.parameters.properties || {})) {
            if (/id$/i.test(p)) idArgs.push(d.name + '.' + p);
        }
    }
    assert.deepStrictEqual(idArgs, ['get_report_detail.report_id'], 'unexpected id argument: ' + idArgs.join(', '));
});

console.log('system prompt — what it must and must not license');
const connected    = S.assistantSystemPrompt({ metaConnected: true,  handle: 'harborcafe' });
const notConnected = S.assistantSystemPrompt({ metaConnected: false, handle: 'harborcafe' });

test('it forbids inventing figures', () => {
    assert.ok(/never invent a figure/i.test(connected), 'no instruction against inventing numbers');
});
test('it forbids naming the plumbing', () => {
    assert.ok(/never mention tools/i.test(connected));
    for (const word of ['Apify', 'scraping', 'databases']) {
        assert.ok(connected.includes(word), `the prompt should name ${word} as off-limits`);
    }
});
test('an unconnected account is told owner numbers are unavailable', () => {
    assert.ok(/has NOT connected Meta/i.test(notConnected));
    assert.ok(/owner-only/i.test(notConnected));
});
test('a connected account is not told to pitch connecting', () => {
    assert.ok(!/has NOT connected/i.test(connected));
    assert.ok(/connected Meta/i.test(connected));
});
test('the upsell is capped at once, not every answer', () => {
    assert.ok(/say it once/i.test(notConnected), 'nothing stops it pitching on every turn');
});
test('the handle is passed through when known, and omitted when not', () => {
    assert.ok(connected.includes('@harborcafe'));
    assert.ok(!S.assistantSystemPrompt({ metaConnected: true, handle: null }).includes('@'));
});
test('the prompt carries today, so relative dates resolve', () => {
    assert.ok(new RegExp(new Date().toISOString().slice(0, 10)).test(connected));
});

console.log('the owner-insights tool is the upsell and must behave');
testAsync('it refuses rather than guesses when Meta is not connected', async () => {
    const out = await S.ASSISTANT_TOOLS.get_owner_insights.run({ metaConnected: false, userId: 'u1' }, {});
    assert.strictEqual(out.not_connected, true);
    assert.ok(/unavailable/i.test(out.note));
});
test('its description tells the model not to substitute other numbers', () => {
    const d = S.ASSISTANT_TOOLS.get_owner_insights.decl.description;
    assert.ok(/do not guess/i.test(d), 'nothing stops the model filling the gap from scraped data');
});

Promise.all(pending).then(() => console.log('\n' + passed + ' passed'));
