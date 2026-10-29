#!/usr/bin/env node
/**
 * Phase 86 tests — reloading Edge Meta AI without bringing zoom back.
 *
 * What matters: an app on the home screen can reach the newest version (the
 * account menu, pulling the chat down on a phone, a bar when the site
 * changed); the page still cannot be zoomed; the service worker and the
 * language file carry new versions, so a phone does not keep old copies.
 *
 *   node tests/phase86.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'frontend');
const html = fs.readFileSync(path.join(ROOT, 'ai', 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
global.window = {};
require(path.join(ROOT, 'ai', 'i18n-bn.js'));
const BN = global.window.I18N_DICTS.bn;

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('zooming stays off', () => {
    assert.match(html, /<meta name="viewport" content="[^"]*maximum-scale=1\.0, user-scalable=no/);
});
test('three ways to the newest version', () => {
    assert.match(html, /id="acct-reload">Reload the app</);
    assert.match(html, /id="ai-update" role="status" hidden/);
    assert.match(html, /id="ai-pull"/);
    assert.match(html, /scroller\.addEventListener\('touchend'/);
    assert.match(html, /addEventListener\('visibilitychange', checkNew\)/);
    assert.match(html, /method: 'HEAD', cache: 'no-store'/, 'the check skips every cache');
});
test('a phone gets the new files, in both languages', () => {
    assert.match(sw, /const VERSION = 'el-shell-v11'/);
    assert.match(sw, /'ai\/i18n\.js\?v=3', 'ai\/i18n-bn\.js\?v=3'/);
    assert.match(html, /src="ai\/i18n\.js\?v=3"/);
    for (const k of ['Reload the app', 'A new version of Edge Meta AI is ready.', 'Reload', 'Pull down to reload', 'Release to reload', 'Reloading…', 'Getting the newest version']) assert.ok(BN[k], k);
});

for (const [name, fn] of tests) {
    try { fn(); passed++; console.log('  ok   ' + name); }
    catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}
console.log(`\n${passed} passed`);
