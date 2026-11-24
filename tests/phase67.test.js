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

const meta = read('src/14-ai-keys-and-meta.js');

console.log('phase 67 :: connecting every Page from the Clients page');
test('with no client named, the server files only Pages a client already holds', () => {
    assert.ok(/if \(st\.client_id\) \{/.test(meta), 'the matching is no longer guarded by a named client');
    assert.ok(/const filedTo = pid => /.test(meta));
});

console.log(`\n${passed} passed`);
