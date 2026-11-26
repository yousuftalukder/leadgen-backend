#!/usr/bin/env node
/**
 * Phase 95 tests: Front end, publishing blogs and work to the website from the CRM.
 *
 * What matters: the article preview turns Markdown into the few tags it needs and nothing else (no script, no
 * javascript: links, no attribute that breaks out), shows the website's images from the website, and the server
 * points at the live website by default. The publishing routes themselves are tested in phase66.test.js.
 *
 *   node tests/phase95.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---- the page's script, in a sandbox with just enough of the CRM around it ----
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CRM = { api: async () => ({}), esc, ic: () => '', toast() {}, $: () => null, views: {}, mounted: {}, isAdmin: () => true, ago: () => '', render() {}, route: 'overview' };
const sandbox = { window: { CRM }, document: { addEventListener() {}, querySelectorAll: () => [] }, addEventListener() {}, location: { hash: '' }, URL, setTimeout, clearTimeout, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'website.js'), 'utf8'), sandbox);
const md = CRM.siteMd;

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('the page registers itself as #frontend', () => {
    assert.strictEqual(typeof CRM.views.frontend, 'function');
    assert.strictEqual(typeof CRM.mounted.frontend, 'function');
    assert.strictEqual(typeof md, 'function');
});
test('Markdown: headings, paragraphs, lists, quotes, rules, bold, italics, code', () => {
    const h = md('# Title\n\n## Part one\nA line\nthat continues.\n\n- one\n- **two**\n\n1. first\n2. second\n\n> said it\n\n---\n\nSome *italic* and `code`.');
    assert.match(h, /<h2>Title<\/h2>/);
    assert.match(h, /<h2>Part one<\/h2>/);
    assert.match(h, /<p>A line that continues\.<\/p>/);
    assert.match(h, /<ul><li>one<\/li><li><strong>two<\/strong><\/li><\/ul>/);
    assert.match(h, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
    assert.match(h, /<blockquote>said it<\/blockquote>/);
    assert.match(h, /<hr>/);
    assert.match(h, /<em>italic<\/em> and <code>code<\/code>/);
});
test('Markdown: the website\'s images come from the website; links open in a new tab', () => {
    const h = md('![The reel](/uploads/blog/eid/1.jpg)\n\n[Contact us](../contact.html) or [Google](https://google.com)');
    assert.match(h, /<img src="https:\/\/edgelead\.online\/uploads\/blog\/eid\/1\.jpg" alt="The reel" loading="lazy">/);
    assert.match(h, /<a href="https:\/\/edgelead\.online\/contact\.html" target="_blank" rel="noopener">Contact us<\/a>/);
    assert.match(h, /<a href="https:\/\/google\.com" target="_blank" rel="noopener">Google<\/a>/);
});
test('Markdown: nothing runs; no javascript: or data: link, no tag or attribute from the text', () => {
    const cases = [
        '<script>alert(1)</script>',
        '<img src=x onerror=alert(1)>',
        '[click](javascript:alert(1))',
        '[click](JaVaScRiPt:alert(1))',
        '![x](javascript:alert(1))',
        '![x](data:text/html;base64,PHNjcmlwdD4=)',
        '[x](https://a.com"onmouseover="alert(1))',
        '**<b onclick=alert(1)>bold</b>**',
        '## <svg onload=alert(1)>',
        '- <iframe src=//evil>'
    ];
    for (const c of cases) {
        const h = md(c);
        // Only real tags count (escaped text is &lt;…): each must be one the preview makes, with its own attributes only.
        for (const [, tag, attrs] of h.matchAll(/<\/?([a-z0-9]+)([^>]*)>/gi)) {
            assert.ok(['p', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'hr', 'img', 'a', 'strong', 'em', 'code'].includes(tag.toLowerCase()), c + ' → ' + h);
            const names = [...attrs.matchAll(/\s([a-z-]+)="[^"]*"/gi)].map(m => m[1].toLowerCase());
            assert.ok(names.every(n => ['href', 'src', 'alt', 'loading', 'target', 'rel'].includes(n)), c + ' → ' + h);
            assert.strictEqual(attrs.replace(/\s[a-z-]+="[^"]*"/gi, '').trim(), '', c + ' → ' + h);
        }
        assert.ok(!/(href|src)="\s*(javascript|data|vbscript):/i.test(h), c + ' → ' + h);
    }
});

// ---- the server ----
test('the server publishes to the live website address by default', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', '24-website.js'), 'utf8');
    assert.match(src, /process\.env\.SITE_PUBLIC_URL \|\| 'https:\/\/edgelead\.online'/);
});
test('the CRM offers Front end to the owner only, and loads it on first use', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'app.js'), 'utf8');
    assert.match(app, /\['frontend', 'Front end', 'globe', 'Owner'\]/);
    assert.match(app, /const OWNER_ONLY = \['admin', 'frontend'\]/);
    assert.match(app, /OWNER_ONLY\.includes\(route\) && !isAdmin\(\)/);
    assert.match(app, /frontend: 'website'/);
});

(async () => {
    console.log('phase 95 :: Front end, publishing to the website');
    for (const [name, fn] of tests) {
        try { await fn(); passed++; console.log('  ok  ' + name); }
        catch (e) { console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).toString().split('\n').slice(0, 4).join('\n       ')); process.exitCode = 1; }
    }
    console.log(`\n${passed} passed${passed === tests.length ? '' : `, ${tests.length - passed} failed`}`);
})();
