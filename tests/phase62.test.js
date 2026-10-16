#!/usr/bin/env node
/**
 * Phase 62 offline tests — documents on a task.
 *
 * The server decides what a file is from its bytes, not from the name or the
 * browser's header, so the cases that matter are the lies: an executable
 * renamed .pdf, a PDF renamed .docx, a zip that is not an Office file, a
 * "CSV" that is binary. Names are checked for what would break a download
 * header or a path: slashes, control characters, a leading dot, a huge name.
 * The rail's sidebar fix and the task page's attach control are checked in
 * the frontend files they live in.
 *
 *   node tests/phase62.test.js
 */
'use strict';
const assert = require('assert');
const Module = require('module');
const path = require('path');
const fs = require('fs');

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
    }), { json: () => (_, __, n) => n && n(), raw: () => (_, __, n) => n && n(), static: () => () => {} }),
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

const { sniffDocument, cleanFileName } = require(path.join(__dirname, '..', 'src', 'shared'));
const b = (...parts) => Buffer.concat(parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p, 'latin1')));
const PDF = b('%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n');
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]);
const DOCX = b(ZIP, '....[Content_Types].xml....word/document.xml....');
const XLSX = b(ZIP, '....[Content_Types].xml....xl/workbook.xml....');
const OTHERZIP = b(ZIP, '....photos/one.jpg....');
const OLE = b(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), '\0\0\0\0\0\0\0\0');
const CSV = b('name,phone\nRiverside Café,01700000000\n');
const EXE = b('MZ\x90\0\x03\0\0\0\x04\0\0\0');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

console.log('phase 62 :: what a file is, from its bytes');
test('a PDF named .pdf is a pdf', () => assert.strictEqual(sniffDocument(PDF, 'Brief.pdf'), 'pdf'));
test('the extension is not case-sensitive', () => assert.strictEqual(sniffDocument(PDF, 'BRIEF.PDF'), 'pdf'));
test('a Word package named .docx is a docx', () => assert.strictEqual(sniffDocument(DOCX, 'contract.docx'), 'docx'));
test('an Excel package named .xlsx is an xlsx', () => assert.strictEqual(sniffDocument(XLSX, 'calendar.xlsx'), 'xlsx'));
test('an old .doc and an old .xls are accepted by their compound header', () => {
    assert.strictEqual(sniffDocument(OLE, 'old.doc'), 'doc');
    assert.strictEqual(sniffDocument(OLE, 'old.xls'), 'xls');
});
test('plain text named .csv is a csv', () => assert.strictEqual(sniffDocument(CSV, 'leads.csv'), 'csv'));
test('a PDF renamed .docx is refused', () => assert.strictEqual(sniffDocument(PDF, 'trick.docx'), null));
test('a Word package renamed .xlsx is refused', () => assert.strictEqual(sniffDocument(DOCX, 'trick.xlsx'), null));
test('a zip that is not an Office file is refused', () => assert.strictEqual(sniffDocument(OTHERZIP, 'photos.docx'), null));
test('an executable renamed .pdf is refused', () => assert.strictEqual(sniffDocument(EXE, 'invoice.pdf'), null));
test('an executable renamed .csv is refused (binary is not text)', () => assert.strictEqual(sniffDocument(EXE, 'leads.csv'), null));
test('a compound file renamed .pdf is refused', () => assert.strictEqual(sniffDocument(OLE, 'old.pdf'), null));
test('a picture is not a document', () => assert.strictEqual(sniffDocument(PNG, 'photo.png'), null));
test('no extension, no type', () => assert.strictEqual(sniffDocument(PDF, 'brief'), null));
test('an empty or tiny body is refused', () => {
    assert.strictEqual(sniffDocument(Buffer.alloc(0), 'a.pdf'), null);
    assert.strictEqual(sniffDocument(Buffer.from('%PD'), 'a.pdf'), null);
});

console.log('phase 62 :: names that are safe to store and to download under');
test('a plain name is kept', () => assert.strictEqual(cleanFileName('Content plan Nov.xlsx'), 'Content plan Nov.xlsx'));
test('a URI-encoded Bangla name is decoded and kept', () =>
    assert.strictEqual(cleanFileName(encodeURIComponent('কনটেন্ট প্ল্যান.xlsx')), 'কনটেন্ট প্ল্যান.xlsx'));
test('slashes and path tricks become spaces', () => assert.strictEqual(cleanFileName('../../etc/passwd.pdf'), 'etc passwd.pdf'));
test('quotes and control characters are removed', () => assert.strictEqual(cleanFileName('a"b\u0000c\r\n.pdf'), 'a b c .pdf'));
test('a leading dot is dropped', () => assert.strictEqual(cleanFileName('.hidden.pdf'), 'hidden.pdf'));
test('a very long name is cut but keeps its extension', () => {
    const n = cleanFileName('x'.repeat(400) + '.xlsx');
    assert.ok(n.length <= 180, 'length ' + n.length);
    assert.ok(n.endsWith('.xlsx'));
});
test('a broken escape does not throw', () => assert.strictEqual(cleanFileName('100%.pdf'), '100%.pdf'));
test('nothing in, nothing out', () => assert.strictEqual(cleanFileName(''), ''));

console.log('phase 62 :: the schema and the pages agree with the server');
const root = path.join(__dirname, '..');
const sql = fs.readFileSync(path.join(root, 'sql', 'schema-phase62.sql'), 'utf8');
test('the migration creates client_task_files with row level security', () => {
    assert.ok(/create table if not exists public\.client_task_files/.test(sql));
    assert.ok(/client_task_files enable row level security/.test(sql));
    assert.ok(/on delete cascade/.test(sql));
});
const header = fs.readFileSync(path.join(root, 'frontend', 'header.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'frontend', 'app.css'), 'utf8');
test('the rail folds its account controls into one menu, keeping the old ids', () => {
    assert.ok(header.includes('id="el-acct-btn"') && header.includes('id="el-acct-menu"'));
    ['el-key-btn', 'el-ai-btn', 'el-out'].forEach(id => assert.ok(header.includes(`id="${id}"`), id));
});
test('rail links never shrink below their own height', () => assert.ok(/\.el-sidebar \.el-nav > \* \{ flex-shrink: 0; \}/.test(css)));
test('the task page attaches documents through the phase-62 endpoint', () => {
    const pages = ['ui.js', 'client.html', 'owner-hub.js'].map(f => fs.readFileSync(path.join(root, 'frontend', f), 'utf8')).join('\n');
    assert.ok(/\/api\/tasks\/\$\{[^}]+\}\/files/.test(pages), 'no call to /api/tasks/:id/files');
});

console.log(`\n${passed} passed`);
