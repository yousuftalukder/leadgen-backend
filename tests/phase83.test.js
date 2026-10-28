#!/usr/bin/env node
/**
 * Phase 83 tests — Edge Meta AI in English or বাংলা.
 *
 * What matters: a question asked in Bangla mode gets the language rule, and
 * nothing else does (an unknown value is English, never an error); both chat
 * routes pass the page's lang through; every Bangla phrase keeps the changing
 * parts {n} and the bold marks <n>…</n> of its English key, so a translated
 * line never loses a date, a figure or a link.
 *
 *   node tests/phase83.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const chat = require(path.join(ROOT, 'xp', 'ai', 'chat.js'));
global.window = {};
require(path.join(ROOT, 'frontend', 'ai', 'i18n-bn.js'));
const BN = global.window.I18N_DICTS.bn;

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('Bangla mode adds the language rule; anything else adds nothing', () => {
    assert.match(chat.languageRule('bn'), /^\nLANGUAGE\. .*Bangla/);
    assert.match(chat.languageRule('bn'), /every figure exactly as the tools return them/);
    for (const l of ['en', undefined, null, '', 'xx', '__proto__', 'constructor']) assert.strictEqual(chat.languageRule(l), '', String(l));
});
test('both chat routes pass the page\'s language to the answer', () => {
    const src = fs.readFileSync(path.join(ROOT, 'xp', 'index.js'), 'utf8');
    assert.strictEqual((src.match(/chat\.answer\(\{[^}]*lang: req\.body\.lang/g) || []).length, 2);
    const c = fs.readFileSync(path.join(ROOT, 'xp', 'ai', 'chat.js'), 'utf8');
    assert.match(c, /systemPrompt\(client, tz, cov\)\) \+ languageRule\(lang\)/);
});
test('the page sends the chosen language with each question', () => {
    const src = fs.readFileSync(path.join(ROOT, 'frontend', 'meta-ai.js'), 'utf8');
    assert.match(src, /JSON\.stringify\(\{ message, clientId: activeClient\.id, conversationId, lang: window\.ELLang \? ELLang\.current\(\) : 'en' \}\)/);
});
test('every Bangla phrase is there and keeps its changing parts and marks', () => {
    const keys = Object.keys(BN);
    assert.ok(keys.length > 250, 'the dictionary has ' + keys.length + ' phrases');
    const marks = s => (s.match(/\{\d+\}|<\/?\d+>/g) || []).sort().join(' ');
    for (const k of keys) {
        assert.ok(typeof BN[k] === 'string' && BN[k].trim(), 'empty: ' + k);
        assert.strictEqual(marks(BN[k]), marks(k), 'marks differ: ' + k);
    }
});
test('the page loads the language before anything is drawn, and names Bangla in its own script', () => {
    const html = fs.readFileSync(path.join(ROOT, 'frontend', 'ai', 'index.html'), 'utf8');
    const head = html.slice(0, html.indexOf('</head>'));
    assert.ok(head.indexOf('<base href="../">') < head.indexOf('src="ai/i18n.js'), 'i18n.js after <base>, in the head');
    assert.match(html, /id="acct-lang" data-no-i18n lang="bn">বাংলা</);
    assert.match(html, /html\.i18n-wait body \{ visibility: hidden; \}/);
});

for (const [name, fn] of tests) {
    try { fn(); passed++; console.log('  ok   ' + name); }
    catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}
console.log(`\n${passed} passed`);
