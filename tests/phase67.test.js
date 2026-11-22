#!/usr/bin/env node
/**
 * Phase 67 offline tests — one Meta login for every Page, filed by hand.
 *
 * The Clients page's New menu can now connect Facebook without naming a client.
 * What matters: that request carries no client (EL.api would otherwise add the
 * picked one, and the server would file Pages under it), the server's callback
 * leaves unnamed Pages unfiled, and the Clients page still offers the picker.
 *
 *   node tests/phase67.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
let passed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; } }

const clients = read('frontend/clients.html');
const meta = read('src/14-ai-keys-and-meta.js');

console.log('phase 67 :: connecting every Page from the Clients page');
test('the New menu offers it', () => assert.ok(/\['pages', '<b>Connect your Facebook Pages<\/b>/.test(clients)));
test('it asks for the dialog without a client, and without the picked one riding along', () =>
    assert.ok(/EL\.api\('\/api\/meta\/oauth\/start', \{ scoped: false \}\)/.test(clients)));
test('with no client named, the server files only Pages a client already holds', () => {
    assert.ok(/if \(st\.client_id\) \{/.test(meta), 'the matching is no longer guarded by a named client');
    assert.ok(/const filedTo = pid => /.test(meta));
});
test('the unfiled Pages keep their picker and their Make-this-a-client button', () => {
    assert.ok(clients.includes('data-file=') && clients.includes('File under an existing client'));
    assert.ok(clients.includes('data-onboard='));
});
test('the return message counts what still waits', () => assert.ok(/q\.get\('unfiled'\)/.test(clients)));
test('menus open clear of the rail', () => assert.ok(/const floor = window\.scrollX \+ 8 \+/.test(clients)));

console.log(`\n${passed} passed`);
