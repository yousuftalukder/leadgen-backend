#!/usr/bin/env node
/**
 * Phase 71 tests — email through Resend.
 *
 * Render's free plan blocks outgoing SMTP, so Gmail times out there. With a
 * Resend key saved, every message goes to Resend's HTTPS API instead. What
 * matters: the key is stored sealed and never sent back; a Gmail address can't
 * be the Resend sender; with no sender set, Resend's test sender is used and
 * replies go to the Gmail address; Resend's refusals come back in words a
 * person can act on; and with no key, Gmail is used as before.
 *
 *   node tests/phase71.test.js
 */
'use strict';
const assert = require('assert');
const Module = require('module');
const path = require('path');

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
        upsert(rows) { op = 'upsert'; payload = rows; return q; },
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
        if (op === 'upsert') {
            for (const r of [].concat(payload)) { const cur = rows.find(x => x.key === r.key); if (cur) Object.assign(cur, r); else rows.push({ ...r }); }
            data = [].concat(payload);
        } else if (op === 'insert') {
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
process.env.APP_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.SUPABASE_URL = 'http://stub'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
require(path.join(__dirname, '..', 'server.js'));
const S = require(path.join(__dirname, '..', 'src', 'shared'));

const ADMIN = newId();
tbl('app_users').push({ id: ADMIN, role: 'admin', is_active: true, email: 'admin@agency.test' });
S._authCache.set(S.tokenHash('admin'), { ctx: { user: { id: ADMIN }, profile: { id: ADMIN, role: 'admin', is_active: true } }, t: Date.now() });

const FETCHED = [];
let reply = { status: 200, body: { id: 'msg_1' } };
global.fetch = async (url, opts) => { FETCHED.push({ url, opts, body: JSON.parse(opts.body) }); return { ok: reply.status < 300, status: reply.status, json: async () => reply.body }; };

async function call(method, route, body = {}) {
    const h = ROUTES[method + ' ' + route];
    assert.ok(h, 'no route ' + method + ' ' + route);
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await h({ headers: { authorization: 'Bearer admin' }, params: {}, body, query: {} }, res);
    return res;
}
const save = mail => call('PATCH', '/api/admin/settings', { mail });
const setting = k => (tbl('system_settings').find(r => r.key === k) || {}).value;
const KEY = 're_AbCdEf123456_xyz';

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('the Gmail settings that time out on Render stay as they are', async () => {
    const r = await save({ from: 'yousuf.outreach@gmail.com', fromName: 'EdgeLead', appPassword: 'abcd efgh ijkl mnop' });
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    const m = (await call('GET', '/api/admin/settings')).body.mail;
    assert.strictEqual(m.provider, 'gmail');
    assert.strictEqual(m.hasResendKey, false);
});
test('a key that is not a Resend key is refused', async () => {
    const r = await save({ resendKey: 'sk_live_123' });
    assert.strictEqual(r.code, 400); assert.match(r.body.error, /starts with re_/);
});
test('a Gmail address cannot be the Resend sender', async () => {
    const r = await save({ resendFrom: 'yousuf.outreach@gmail.com' });
    assert.strictEqual(r.code, 400); assert.match(r.body.error, /verified/);
});
test('the key is stored sealed and never sent back', async () => {
    const r = await save({ resendKey: KEY, resendFrom: '' });
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    assert.ok(setting('mail_resend_key') && !String(setting('mail_resend_key')).includes(KEY), 'sealed');
    S.invalidateQuotaCaps();
    const m = (await call('GET', '/api/admin/settings')).body.mail;
    assert.strictEqual(m.provider, 'resend');
    assert.strictEqual(m.hasResendKey, true);
    assert.ok(!JSON.stringify(m).includes(KEY), 'the key is not in what the page gets');
    assert.strictEqual(m.sender, 'onboarding@resend.dev');
});
test('with a key saved, mail goes to Resend: test sender, replies to the Gmail address', async () => {
    FETCHED.length = 0; reply = { status: 200, body: { id: 'msg_1' } };
    const r = await S.sendMail({ to: 'Mate@Agency.test', subject: 'New task\nfor you', text: 'Hello' });
    assert.deepStrictEqual(r, { ok: true, id: 'msg_1', via: 'resend' });
    assert.strictEqual(FETCHED.length, 1);
    const f = FETCHED[0];
    assert.strictEqual(f.url, 'https://api.resend.com/emails');
    assert.strictEqual(f.opts.headers.Authorization, 'Bearer ' + KEY);
    assert.deepStrictEqual(f.body, { from: 'EdgeLead <onboarding@resend.dev>', to: ['mate@agency.test'], subject: 'New task for you', text: 'Hello', reply_to: 'yousuf.outreach@gmail.com' });
});
test('a verified sender is used once saved', async () => {
    await save({ resendFrom: 'hello@arminabd.com' });
    S.invalidateQuotaCaps(); FETCHED.length = 0;
    await S.sendMail({ to: 'a@b.test', subject: 's', text: 't' });
    assert.strictEqual(FETCHED[0].body.from, 'EdgeLead <hello@arminabd.com>');
});
test('Resend refusing an unverified domain says what to do', async () => {
    reply = { status: 403, body: { statusCode: 403, name: 'validation_error', message: 'The arminabd.com domain is not verified.' } };
    const r = await S.sendMail({ to: 'a@b.test', subject: 's', text: 't' });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /not verified\. Verify your domain at resend\.com\/domains/);
});
test('a bad key says so', async () => {
    reply = { status: 401, body: { message: 'API key is invalid' } };
    const r = await S.sendMail({ to: 'a@b.test', subject: 's', text: 't' });
    assert.match(r.error, /refused the API key/);
});
test('the test email reports what Resend said', async () => {
    reply = { status: 200, body: { id: 'msg_test' } };
    const r = await call('POST', '/api/admin/mail/test', {});
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.via, 'resend');
    assert.match(FETCHED.at(-1).body.text, /sent through Resend from hello@arminabd\.com/);
});
test('removing the key goes back to Gmail', async () => {
    await save({ resendKey: '' });
    S.invalidateQuotaCaps();
    const m = (await call('GET', '/api/admin/settings')).body.mail;
    assert.strictEqual(m.provider, 'gmail'); assert.strictEqual(m.hasResendKey, false);
});

(async () => {
    console.log('phase 71 :: email through Resend');
    for (const [name, fn] of tests) {
        try { await fn(); passed++; console.log('  ok   ' + name); }
        catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
    }
    console.log(`\n${passed} passed`);
    process.exit();
})();
