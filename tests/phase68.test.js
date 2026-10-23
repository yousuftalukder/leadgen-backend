#!/usr/bin/env node
/**
 * Phase 68 offline tests — the team hears about its tasks by email.
 *
 * What matters: the person given a task hears at once; changes reach whoever
 * holds or raised the task, in one email per task per person however many there
 * were; the person who made the change, business owners and disabled logins never
 * get one; the email says what changed in words and links to the task; and the
 * switch turns it all off.
 *
 *   node tests/phase68.test.js
 */
'use strict';
const assert = require('assert');
const Module = require('module');
const path = require('path');
const fs = require('fs');

// ---- a tiny in-memory Supabase: enough for the reads the mailer makes -------
const DB = { app_users: [], client_tasks: [], clients: [] };
function query(table) {
    const filters = [];
    let single = false;
    const run = () => {
        let rows = (DB[table] || []).filter(r => filters.every(f => f(r)));
        return Promise.resolve(single ? { data: rows[0] || null, error: null } : { data: rows, error: null, count: rows.length });
    };
    const q = {
        select: () => q, order: () => q, limit: () => q, not: () => q, neq: () => q,
        eq: (k, v) => { filters.push(r => r[k] === v); return q; },
        in: (k, vs) => { filters.push(r => vs.includes(r[k])); return q; },
        maybeSingle: () => { single = true; return run(); },
        then: (a, b) => run().then(a, b)
    };
    return q;
}
const stubs = {
    express: Object.assign(() => ({
        set() {}, use() {}, get() {}, post() {}, patch() {}, delete() {}, put() {}, listen() {}
    }), { json: () => (_, __, n) => n && n(), raw: () => (_, __, n) => n && n(), static: () => () => {} }),
    cors: () => () => {},
    'apify-client': { ApifyClient: class {} },
    '@supabase/supabase-js': { createClient: () => ({ from: query, rpc: () => Promise.resolve({ data: null, error: null }), auth: { getUser: async () => ({ data: null, error: new Error('stub') }) } }) },
    dotenv: { config() {} }
};
const realLoad = Module._load;
Module._load = function (req, ...rest) { return stubs[req] !== undefined ? stubs[req] : realLoad.call(this, req, ...rest); };
process.env.SUPABASE_URL = 'http://stub'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
process.env.FRONTEND_URL = 'https://edgeleadwork.netlify.app';
delete process.env.TASK_EMAILS;

require(path.join(__dirname, '..', 'server.js'));
const S = require(path.join(__dirname, '..', 'src', 'shared'));
const sent = [];
S.sendMail = async m => { sent.push(m); return { ok: true }; };

const ANA = '11111111-1111-4111-8111-111111111111';     // account lead, raised the task
const BEN = '22222222-2222-4222-8222-222222222222';     // given the task
const OWNER = '33333333-3333-4333-8333-333333333333';   // the business owner
const GONE = '44444444-4444-4444-8444-444444444444';    // a disabled login
const C = 'c0000000-0000-4000-8000-000000000001';
const T = 'a0000000-0000-4000-8000-000000000001';
DB.app_users.push(
    { id: ANA, email: 'ana@edgelead.test', full_name: 'Ana Rahman', role: 'admin', is_active: true },
    { id: BEN, email: 'ben@edgelead.test', full_name: 'Ben Karim', role: 'employee', is_active: true },
    { id: OWNER, email: 'owner@cafe.test', full_name: 'Rafi Owner', role: 'client', is_active: true },
    { id: GONE, email: 'gone@edgelead.test', full_name: 'Old Hand', role: 'employee', is_active: false });
DB.clients.push({ id: C, name: 'Riverside Café' });
const task = { id: T, client_id: C, title: 'November content calendar', status: 'todo', priority: 'medium', due_date: null,
    notes: 'Plan it', checklist: [{ text: 'Draft', done: false }, { text: 'Review', done: false }], assignee_user_id: BEN, created_by: ANA };
DB.client_tasks.push(task);

let passed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; } }
const flushAll = async () => { for (const k of [...S._taskMail.keys()]) await S.flushTaskMail(k); };
const reset = () => { sent.length = 0; for (const q of S._taskMail.values()) clearTimeout(q.timer); S._taskMail.clear(); };

(async () => {
    console.log('phase 68 :: given a task');
    await test('the person given it hears at once, with who gave it and a link that opens it', async () => {
        reset();
        await S.mailTaskAssigned(task, ANA, 'Riverside Café');
        assert.strictEqual(sent.length, 1);
        assert.strictEqual(sent[0].to, 'ben@edgelead.test');
        assert.strictEqual(sent[0].subject, 'New task for you: November content calendar');
        assert.ok(/^Hi Ben,/.test(sent[0].text));
        assert.ok(sent[0].text.includes('Ana Rahman gave you a task for Riverside Café.'));
        assert.ok(sent[0].text.includes(`https://edgeleadwork.netlify.app/workspace.html?client=${C}&tab=tasks&task=${T}`));
    });
    await test('giving yourself a task sends nothing', async () => {
        reset();
        await S.mailTaskAssigned({ ...task, assignee_user_id: ANA }, ANA, 'Riverside Café');
        assert.strictEqual(sent.length, 0);
    });
    await test('a business owner or a disabled login never gets one', async () => {
        reset();
        await S.mailTaskAssigned({ ...task, assignee_user_id: OWNER }, ANA, 'x');
        await S.mailTaskAssigned({ ...task, assignee_user_id: GONE }, ANA, 'x');
        assert.strictEqual(sent.length, 0);
    });

    console.log('phase 68 :: a task changes');
    await test('what changed is said in words, one line each', () => {
        const after = { ...task, status: 'doing', due_date: '2026-11-03', title: 'Nov calendar', priority: 'high', notes: 'Plan it now',
            checklist: [{ text: 'Draft', done: true }, { text: 'Review', done: false }] };
        const lines = S.taskChangeLines(task, after, 'Ana');
        assert.deepStrictEqual(lines, [
            'Ana moved it from To do to In progress.',
            'Ana set the due date to 2026-11-03.',
            'Ana renamed it (was "November content calendar").',
            'Ana changed the priority to high.',
            'Ana edited the description.',
            'Ana updated the checklist (1 of 2 done).'
        ]);
        assert.deepStrictEqual(S.taskChangeLines(task, { ...task }, 'Ana'), [], 'a save with no change says something changed');
    });
    await test('many changes to one task become one email per person, sent after the wait', async () => {
        reset();
        await S.queueTaskMail(task, OWNER, 'Rafi Owner (the client) commented: "Love it"', null);
        await S.queueTaskMail(task, OWNER, 'Rafi Owner (the client) marked it done.', null);
        await S.queueTaskMail(task, OWNER, 'Rafi Owner (the client) commented: "Love it"', null);   // the same line twice is said once
        assert.strictEqual(sent.length, 0, 'it sent before the wait');
        assert.strictEqual(S._taskMail.size, 2, 'both the holder and the person who raised it should be queued');
        await flushAll();
        assert.strictEqual(sent.length, 2);
        assert.deepStrictEqual(sent.map(m => m.to).sort(), ['ana@edgelead.test', 'ben@edgelead.test']);
        const ben = sent.find(m => m.to === 'ben@edgelead.test');
        assert.strictEqual(ben.subject, 'Task updated: November content calendar');
        assert.strictEqual((ben.text.match(/commented/g) || []).length, 1);
        assert.ok(ben.text.includes('marked it done.') && ben.text.includes('Client: Riverside Café'));
    });
    await test('the person who made the change is left out', async () => {
        reset();
        await S.queueTaskMail(task, BEN, 'Ben Karim moved it from To do to Done.', null);
        await flushAll();
        assert.deepStrictEqual(sent.map(m => m.to), ['ana@edgelead.test']);
    });
    await test('a task deleted inside the wait sends nothing', async () => {
        reset();
        const gone = { ...task, id: 'a0000000-0000-4000-8000-000000000099' };
        await S.queueTaskMail(gone, OWNER, 'x', null);
        await flushAll();
        assert.strictEqual(sent.length, 0);
    });
    await test('a comment reads as words: pictures named, spacing folded, kept short', () => {
        assert.strictEqual(S.commentExcerpt('Look  at\nthis ![image](media:12345678-1234-4234-8234-123456789012) ok'), 'Look at this [picture] ok');
        const long = S.commentExcerpt('x'.repeat(400));
        assert.ok(long.length === 280 && long.endsWith('...'));
    });

    console.log('phase 68 :: switched off');
    await test('TASK_EMAILS=off sends nothing at all', async () => {
        reset();
        process.env.TASK_EMAILS = 'off';
        await S.mailTaskAssigned(task, ANA, 'x');
        await S.queueTaskMail(task, OWNER, 'y', null);
        delete process.env.TASK_EMAILS;
        assert.strictEqual(sent.length + S._taskMail.size, 0);
    });

    console.log('phase 68 :: wired where tasks change');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', '13-tasks-and-owner-sign-in.js'), 'utf8');
    await test('making, changing, commenting on, attaching to and ticking off a task all tell people, after answering', () => {
        assert.ok(/afterTaskWrite\(\(\) => mailTaskAssigned\(data, ctx\.user\.id, c\.name\)\)/.test(src), 'create');
        assert.ok(/taskChangeLines\(t, data, by\)/.test(src), 'update');
        assert.ok(/commented: "\$\{commentExcerpt\(body\)\}"/.test(src), 'comment');
        assert.ok(/attached \$\{name\}\./.test(src), 'file');
        assert.ok(/marked it done\./.test(src), 'owner tick');
    });
    const ui = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'ui.js'), 'utf8');
    const ws = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'workspace.html'), 'utf8');
    await test('the link opens the task on its board, once', () => {
        assert.ok(/openTask: qs\.get\('task'\)/.test(ws));
        assert.ok(/if \(opts\.openTask\) \{/.test(ui) && /u\.searchParams\.delete\('task'\)/.test(ui));
    });

    reset();
    console.log(`\n${passed} passed`);
})();
