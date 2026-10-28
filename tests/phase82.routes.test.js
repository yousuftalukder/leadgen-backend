#!/usr/bin/env node
/**
 * Phase 82 route tests — a profile of one's own: name, phone, photo.
 *
 * What matters: a person changes only their own name and phone; an empty name
 * and a phone that is not a phone are refused; the photo is checked by its
 * bytes, replaces the old one in storage, and can be removed; /api/me shows all
 * three; before the phase-82 SQL the photo says what to run.
 *
 *   node tests/phase82.routes.test.js
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

// ---- people ----
const OWNER = newId(), OTHER = newId();
tbl('app_users').push(
    { id: OWNER, role: 'client', is_active: true, email: 'owner@shop.test', full_name: 'Old Name', phone: null, avatar_path: null },
    { id: OTHER, role: 'client', is_active: true, email: 'other@shop.test', full_name: 'Other', phone: '017', avatar_path: null });
storage.from = () => ({
    upload: async p => { STORE.add(p); return { error: null }; },
    remove: async ps => { ps.forEach(p => STORE.delete(p)); return { error: null }; },
    createSignedUrl: async p => ({ data: { signedUrl: 'https://signed/' + p }, error: null })
});
// The profile as auth hands it over: the row itself. A row without the phase-82 columns is a database before the SQL.
const signIn = (token, id, cut = false) => {
    const row = { ...tbl('app_users').find(u => u.id === id), paid_until: '2099-01-01T00:00:00Z' };
    if (cut) { delete row.phone; delete row.avatar_path; }
    S._authCache.set(S.tokenHash(token), { ctx: { user: { id, email: row.email }, profile: row }, t: Date.now() });
};
async function call(method, route, { as = 'owner', id = OWNER, cut = false, body = {} } = {}) {
    signIn(as, id, cut);   // a change empties the auth cache, as it should; sign in again for each call
    const h = ROUTES[method + ' ' + route];
    assert.ok(h, 'no route ' + method + ' ' + route);
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await h({ headers: { authorization: 'Bearer ' + as }, params: {}, body, query: {} }, res);
    return res;
}
const me = () => tbl('app_users').find(u => u.id === OWNER);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('name and phone are saved, tidied, on their own row only', async () => {
    const r = await call('POST', '/api/me/profile', { body: { full_name: '  Rahim   Uddin ', phone: ' +880 1711-000000 ' } });
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    assert.deepStrictEqual([me().full_name, me().phone], ['Rahim Uddin', '+880 1711000000']);
    assert.deepStrictEqual([r.body.full_name, r.body.phone], ['Rahim Uddin', '+880 1711000000']);
    const other = tbl('app_users').find(u => u.id === OTHER);
    assert.deepStrictEqual([other.full_name, other.phone], ['Other', '017']);
});
test('one field alone leaves the other; an empty phone clears it', async () => {
    await call('POST', '/api/me/profile', { body: { phone: '' } });
    assert.deepStrictEqual([me().full_name, me().phone], ['Rahim Uddin', null]);
});
test('an empty name, a long name and a phone that is not one are refused', async () => {
    for (const body of [{ full_name: '   ' }, { full_name: 'x'.repeat(81) }, { phone: 'call me maybe' }, { phone: '12' }, {}]) {
        const r = await call('POST', '/api/me/profile', { body });
        assert.strictEqual(r.code, 400, JSON.stringify(body));
    }
    assert.strictEqual(me().full_name, 'Rahim Uddin');
});
test('the email is not something the profile changes', async () => {
    await call('POST', '/api/me/profile', { body: { full_name: 'Rahim Uddin', email: 'new@x.test' } });
    assert.strictEqual(me().email, 'owner@shop.test');
});
test('a photo is checked by its bytes', async () => {
    const r = await call('POST', '/api/me/avatar', { body: Buffer.from('<svg onload=alert(1)>  ') });
    assert.strictEqual(r.code, 400);
    const empty = await call('POST', '/api/me/avatar', { body: {} });
    assert.strictEqual(empty.code, 400);
    assert.strictEqual(STORE.size, 0);
});
test('a photo is stored under the person, and a new one replaces it', async () => {
    const a = await call('POST', '/api/me/avatar', { body: JPEG });
    assert.strictEqual(a.code, 201, JSON.stringify(a.body));
    const first = me().avatar_path;
    assert.match(first, new RegExp('^' + OWNER + '/[0-9a-f-]{36}\.jpg$'));
    assert.strictEqual(a.body.avatar_url, 'https://signed/' + first);
    const b = await call('POST', '/api/me/avatar', { body: PNG });
    assert.strictEqual(b.code, 201);
    assert.match(me().avatar_path, /\.png$/);
    assert.deepStrictEqual([...STORE], [me().avatar_path], 'the old photo is gone from storage');
});
test('/api/me shows the name, phone and a signed photo link', async () => {
    await call('POST', '/api/me/profile', { body: { phone: '01711000000' } });
    const r = await call('GET', '/api/me');
    assert.strictEqual(r.body.full_name, 'Rahim Uddin');
    assert.strictEqual(r.body.phone, '+880 1711000000', 'phase 84: kept with its country code');
    assert.strictEqual(r.body.avatar_url, 'https://signed/' + me().avatar_path);
});
test('the photo can be removed', async () => {
    const r = await call('DELETE', '/api/me/avatar');
    assert.strictEqual(r.code, 200);
    assert.strictEqual(me().avatar_path, null);
    assert.strictEqual(STORE.size, 0);
    const again = await call('GET', '/api/me');
    assert.strictEqual(again.body.avatar_url, null);
});
test('before the phase-82 SQL, a photo says what to run', async () => {
    const r = await call('POST', '/api/me/avatar', { cut: true, body: JPEG });
    assert.strictEqual(r.code, 503);
    assert.strictEqual(r.body.code, 'migration_required');
    assert.match(r.body.error, /schema-phase82\.sql/);
    assert.strictEqual(STORE.size, 0);
});

(async () => {
    console.log('phase 82 :: the profile routes');
    for (const [name, fn] of tests) {
        try { await fn(); passed++; console.log('  ok   ' + name); }
        catch (e) { console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); process.exitCode = 1; }
    }
    console.log(`\n${passed} passed`);
    process.exit();
})();
