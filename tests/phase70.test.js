#!/usr/bin/env node
/**
 * Phase 70 tests — @mentions in task comments, and who hears about a task.
 *
 * What matters: a mention of someone on the client is kept and emails them at
 * once; a mention of anyone else becomes plain text and emails nobody; a
 * business owner can neither make mentions nor read the tokens; the team sees
 * who can be mentioned; and everyone who has commented on a task follows it,
 * without a mentioned person being told twice.
 *
 *   node tests/phase70.test.js
 */
'use strict';
const assert = require('assert');
const Module = require('module');
const path = require('path');
const fs = require('fs');

// ---- an in-memory database, enough of supabase-js's query builder for these routes ----
const DB = {};
const tbl = t => (DB[t] = DB[t] || []);
let seq = 0;
const newId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
function query(table) {
    const filters = [];
    let op = 'select', payload = null, single = false, head = false, wantCount = false, limit = null, orders = [];
    const q = {
        select(_cols, opts = {}) { if (op === 'select') op = 'select'; head = !!opts.head; wantCount = !!opts.count; return q; },
        insert(rows) { op = 'insert'; payload = rows; return q; },
        update(p) { op = 'update'; payload = p; return q; },
        delete() { op = 'delete'; return q; },
        eq(c, v) { filters.push(r => r[c] === v); return q; },
        in(c, vs) { filters.push(r => vs.includes(r[c])); return q; },
        lt(c, v) { filters.push(r => String(r[c]) < String(v)); return q; },
        is(c, v) { filters.push(r => (r[c] ?? null) === v); return q; },
        contains(c, vs) { filters.push(r => vs.every(v => (r[c] || []).includes(v))); return q; },
        overlaps(c, vs) { filters.push(r => vs.some(v => (r[c] || []).includes(v))); return q; },
        order(c, o = {}) { orders.push([c, o.ascending !== false]); return q; },
        limit(n) { limit = n; return q; },
        maybeSingle() { single = true; return q; },
        then(ok, no) { return Promise.resolve().then(run).then(ok, no); }
    };
    function run() {
        const rows = tbl(table);
        const hit = rows.filter(r => filters.every(f => f(r)));
        let data;
        if (op === 'insert') {
            const add = [].concat(payload).map(r => ({ id: r.id || newId(), ...r }));
            rows.push(...add); data = add;
        } else if (op === 'update') { hit.forEach(r => Object.assign(r, payload)); data = hit; }
        else if (op === 'delete') { DB[table] = rows.filter(r => !hit.includes(r)); data = hit; }
        else {
            data = [...hit];
            for (const [c, asc] of orders.slice().reverse()) data.sort((a, b) => (String(a[c] ?? '') < String(b[c] ?? '') ? -1 : String(a[c] ?? '') > String(b[c] ?? '') ? 1 : 0) * (asc ? 1 : -1));
            if (limit != null) data = data.slice(0, limit);
        }
        if (head) return { data: null, error: null, count: hit.length };
        if (single) return { data: data[0] ? { ...data[0] } : null, error: null };
        return { data: data.map(r => ({ ...r })), error: null, count: wantCount ? hit.length : null };
    }
    return q;
}
const STORE = new Set();
const storage = {
    getBucket: async () => ({ data: { id: 'b' }, error: null }),
    createBucket: async () => ({ error: null }),
    from: () => ({
        upload: async p => { STORE.add(p); return { error: null }; },
        remove: async ps => { ps.forEach(p => STORE.delete(p)); return { error: null }; },
        createSignedUrls: async ps => ({ data: ps.map(p => ({ path: p, signedUrl: 'https://signed/' + p })), error: null })
    })
};

// ---- the server, with its routes captured ----
const ROUTES = {};
const stubs = {
    express: Object.assign(() => {
        const reg = m => (p, ...h) => { ROUTES[m + ' ' + p] = h[h.length - 1]; };
        return { set() {}, use() {}, listen() {}, get: reg('GET'), post: reg('POST'), patch: reg('PATCH'), delete: reg('DELETE'), put: reg('PUT') };
    }, { json: () => (_, __, n) => n && n(), raw: () => (_, __, n) => n && n(), static: () => () => {} }),
    cors: () => () => {},
    'apify-client': { ApifyClient: class {} },
    '@supabase/supabase-js': { createClient: () => ({ from: query, rpc: () => query('rpc'), storage, auth: { getUser: async () => ({ data: null, error: new Error('stub') }) } }) },
    dotenv: { config() {} }
};
const realLoad = Module._load;
Module._load = function (req, ...rest) { return stubs[req] !== undefined ? stubs[req] : realLoad.call(this, req, ...rest); };
process.env.SUPABASE_URL = 'http://stub'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
require(path.join(__dirname, '..', 'server.js'));
const S = require(path.join(__dirname, '..', 'src', 'shared'));

// ---- people, a client and a task ----
const LEAD = newId(), MATE = newId(), OUTSIDER = newId(), OWNER = newId(), C = newId(), T = newId();
tbl('app_users').push(
    { id: LEAD, role: 'user', is_active: true, email: 'lead@agency.test', full_name: 'Yousuf Lead' },
    { id: MATE, role: 'user', is_active: true, email: 'mate@agency.test', full_name: 'Anika Mate' },
    { id: OUTSIDER, role: 'user', is_active: true, email: 'out@agency.test', full_name: 'Not On It' },
    { id: OWNER, role: 'client', is_active: true, email: 'owner@shop.test', full_name: 'Shop Owner' });
tbl('clients').push({ id: C, name: 'Arminabd', owner_user_id: LEAD, archived: false });
tbl('client_members').push({ client_id: C, user_id: MATE, role: 'editor' }, { client_id: C, user_id: OWNER, role: 'editor' });
tbl('client_tasks').push({ id: T, client_id: C, title: 'Film the siang oil reel', status: 'todo', created_by: LEAD, assignee_user_id: null, visible_to_client: true, created_at: '2026-10-27T00:00:00Z', updated_at: '2026-10-27T00:00:00Z' });
const signIn = (token, id, role) => S._authCache.set(S.tokenHash(token), { ctx: { user: { id }, profile: { id, role, is_active: true, paid_until: '2099-01-01T00:00:00Z' } }, t: Date.now() });
signIn('lead', LEAD, 'user'); signIn('mate', MATE, 'user'); signIn('owner', OWNER, 'client');

const SENT = [];
S.sendMail = async m => { SENT.push(m); return { ok: true }; };
const settle = () => new Promise(r => setTimeout(r, 30));
async function call(method, route, { as, params = {}, body = {} } = {}) {
    const h = ROUTES[method + ' ' + route];
    assert.ok(h, 'no route ' + method + ' ' + route);
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await h({ headers: { authorization: 'Bearer ' + as }, params, body, query: {} }, res);
    await settle();
    return res;
}
const POST = (as, body) => call('POST', '/api/tasks/:taskId/comments', { as, params: { taskId: T }, body: { body } });
const GET = as => call('GET', '/api/tasks/:taskId/comments', { as, params: { taskId: T } });
const tok = (name, id) => `@[${name}](user:${id})`;

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('the helpers read, keep and flatten mentions', () => {
    const body = `ping ${tok('Anika Mate', MATE)} and ${tok('Not On It', OUTSIDER)}`;
    assert.deepStrictEqual(S.mentionIds(body), [MATE, OUTSIDER]);
    assert.strictEqual(S.mentionPlain(body), 'ping @Anika Mate and @Not On It');
    assert.strictEqual(S.mentionKeep(body, [MATE]), `ping ${tok('Anika Mate', MATE)} and @Not On It`);
    assert.strictEqual(S.commentExcerpt(body), 'ping @Anika Mate and @Not On It');
});
test('a mention of someone on the client is kept and emails them at once', async () => {
    SENT.length = 0;
    const r = await POST('lead', `${tok('Anika Mate', MATE)} can you film it today?`);
    assert.strictEqual(r.code, 201, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.mentioned, [MATE]);
    assert.ok(r.body.comment.body.startsWith(tok('Anika Mate', MATE)));
    assert.strictEqual(SENT.length, 1);
    assert.strictEqual(SENT[0].to, 'mate@agency.test');
    assert.match(SENT[0].subject, /^Yousuf Lead mentioned you: Film the siang oil reel$/);
    assert.match(SENT[0].text, /"@Anika Mate can you film it today\?"/);
    assert.ok(!SENT[0].text.includes('user:'), 'no token in the email');
});
test('the mentioned person is not queued a second time for the same comment', () => {
    assert.ok(!S._taskMail.has(`${T}:${MATE}`), 'already told at once');
});
test('a mention of someone not on the client becomes plain text and emails nobody', async () => {
    SENT.length = 0;
    const r = await POST('lead', `${tok('Not On It', OUTSIDER)} fyi`);
    assert.deepStrictEqual(r.body.mentioned, []);
    assert.strictEqual(r.body.comment.body, '@Not On It fyi');
    assert.ok(!SENT.some(m => m.to === 'out@agency.test'));
});
test('someone who commented follows the task: the next comment is queued for them', async () => {
    for (const [k, q] of S._taskMail) { clearTimeout(q.timer); S._taskMail.delete(k); }
    await POST('mate', 'Filmed. Uploading now.');
    assert.ok(S._taskMail.has(`${T}:${LEAD}`), 'the creator hears');
    await POST('lead', 'Great, thanks');
    assert.ok(S._taskMail.has(`${T}:${MATE}`), 'Anika commented earlier, so she hears');
    assert.ok(!S._taskMail.has(`${T}:${OWNER}`), 'never the business owner');
    for (const [k, q] of S._taskMail) { clearTimeout(q.timer); S._taskMail.delete(k); }
});
test('a business owner cannot mention: the token is saved as plain text', async () => {
    SENT.length = 0;
    const r = await POST('owner', `${tok('Anika Mate', MATE)} when is it posted?`);
    assert.strictEqual(r.code, 201);
    assert.strictEqual(r.body.comment.body, '@Anika Mate when is it posted?');
    assert.ok(!SENT.some(m => /mentioned you/.test(m.subject)));
});
test('the team reads the tokens and who can be mentioned; the owner reads names only', async () => {
    const team = await GET('mate');
    assert.ok(team.body.comments.some(c => c.body.includes(`(user:${MATE})`)));
    assert.deepStrictEqual(team.body.people.map(p => p.id).sort(), [LEAD, MATE].sort());
    const owner = await GET('owner');
    assert.ok(owner.body.comments.every(c => !c.body.includes('(user:')));
    assert.ok(owner.body.comments.some(c => c.body.startsWith('@Anika Mate')));
    assert.deepStrictEqual(owner.body.people, [], 'an owner is never handed the team list');
});

console.log('phase 70 :: what each kind of work is for (header.js)');
const header = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'header.js'), 'utf8');
test('every kind in New work has a note, and outreach sits apart from client work', () => {
    const kinds = [...header.matchAll(/\{ kind: '(\w+)', group: '([^']+)'/g)].map(m => m[1]);
    assert.deepStrictEqual(kinds, ['meta', 'team', 'tools', 'outreach']);
    for (const k of kinds) assert.ok(new RegExp(`\\n\\s+${k}: `).test(header.slice(header.indexOf('const WORK_NOTE'))), 'note for ' + k);
});
test('the rail has a Clients section and an Outreach section holding Leads and Pipeline', () => {
    const nav = header.slice(header.indexOf('const NAV = ['), header.indexOf('];', header.indexOf('const NAV = [')));
    const at = s => nav.indexOf(s);
    assert.ok(at("{ group: 'Clients' }") < at("'clients.html'"));
    assert.ok(at("{ group: 'Outreach' }") < at("'leads.html'") && at("'leads.html'") < at("'pipeline.html'"));
    assert.ok(at("'schedules.html'") < at("{ group: 'Outreach' }"));
});

(async () => {
    console.log('phase 70 :: mentions and who hears about a task');
    for (const [name, fn] of tests) {
        try { await fn(); passed++; console.log('  ok   ' + name); }
        catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
    }
    console.log(`\n${passed} passed`);
    process.exit();
})();
