#!/usr/bin/env node
/**
 * Phase 84 route tests — Edge Meta AI's settings, as in the Owner Assistant.
 *
 * What matters: the language is kept on the account and only English or
 * Bangla is taken; a phone is a country code and the number, checked the
 * same way the page checks it; an owner's business details reach their own
 * business only, tidied and checked, and the agency's own fields are never
 * touched; /api/me hands all of it back; before the phase-84 SQL a change
 * says what to run.
 *
 *   node tests/phase84.routes.test.js
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
let FAIL = null;   // a column the database does not have yet
function query(table) {
    const filters = [];
    let op = 'select', payload = null, single = false, head = false, wantCount = false, limit = null, orders = [];
    const q = {
        select(_cols, opts = {}) { head = !!opts.head; wantCount = !!opts.count; return q; },
        insert(rows) { op = 'insert'; payload = rows; return q; },
        update(p) { op = 'update'; payload = p; return q; },
        delete() { op = 'delete'; return q; },
        eq(c, v) { filters.push(r => r[c] === v); return q; },
        neq(c, v) { filters.push(r => r[c] !== v); return q; },
        in(c, vs) { filters.push(r => vs.includes(r[c])); return q; },
        not() { return q; },
        is(c, v) { filters.push(r => (r[c] ?? null) === v); return q; },
        order(c, o = {}) { orders.push([c, o.ascending !== false]); return q; },
        limit(n) { limit = n; return q; },
        maybeSingle() { single = true; return q; },
        then(ok, no) { return Promise.resolve().then(run).then(ok, no); }
    };
    function run() {
        if (op === 'update' && FAIL) {
            const col = Object.keys(payload).find(k => FAIL.test(k));
            if (col) return { data: null, error: { code: 'PGRST204', message: `Could not find the '${col}' column` } };
        }
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

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---- the server, with its routes captured ----
const ROUTES = {};
const storage = { from: () => ({ createSignedUrl: async p => ({ data: { signedUrl: 'https://signed/' + p }, error: null }) }) };
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

// ---- people and businesses ----
const OWNER = newId(), OTHER = newId(), STAFF = newId(), MINE = newId(), THEIRS = newId();
tbl('app_users').push(
    { id: OWNER, role: 'client', is_active: true, email: 'owner@shop.test', full_name: 'Rahim', phone: null, avatar_path: null, ui_language: null },
    { id: OTHER, role: 'client', is_active: true, email: 'other@shop.test', full_name: 'Other', phone: null, avatar_path: null, ui_language: null },
    { id: STAFF, role: 'employee', is_active: true, email: 'staff@agency.test', full_name: 'Staff', phone: null, avatar_path: null, ui_language: null });
tbl('clients').push(
    { id: MINE, owner_user_id: OWNER, name: 'Rahim Sweets', niche: 'sweet shop', location: 'Dhaka', notes: 'agency notes', archived: false, created_at: '2026-01-01', owner_details: null },
    { id: THEIRS, owner_user_id: OTHER, name: 'Other Shop', archived: false, created_at: '2026-01-01', owner_details: { phone: '+880 1811000000' } });

const signIn = (token, id) => {
    const row = { ...tbl('app_users').find(u => u.id === id), paid_until: '2099-01-01T00:00:00Z' };
    S._authCache.set(S.tokenHash(token), { ctx: { user: { id, email: row.email }, profile: row }, t: Date.now() });
};
async function call(method, route, { as = 'owner', id = OWNER, body = {} } = {}) {
    signIn(as, id);   // a change empties the auth cache, as it should; sign in again for each call
    const h = ROUTES[method + ' ' + route];
    assert.ok(h, 'no route ' + method + ' ' + route);
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await h({ headers: { authorization: 'Bearer ' + as }, params: {}, body, query: {} }, res);
    return res;
}
const me = () => tbl('app_users').find(u => u.id === OWNER);
const mine = () => tbl('clients').find(c => c.id === MINE);

test('the language is kept on the account, and handed back by /api/me', async () => {
    const r = await call('POST', '/api/me/profile', { body: { ui_language: 'bn' } });
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    assert.strictEqual(me().ui_language, 'bn');
    assert.strictEqual(r.body.ui_language, 'bn');
    assert.strictEqual((await call('GET', '/api/me')).body.ui_language, 'bn');
    assert.strictEqual(me().full_name, 'Rahim', 'the name is left alone');
});
test('only English or Bangla is taken', async () => {
    for (const ui_language of ['xx', '', null, '__proto__', 'constructor', ['bn'], 'BN']) {
        const r = await call('POST', '/api/me/profile', { body: { ui_language } });
        assert.strictEqual(r.code, 400, JSON.stringify(ui_language));
    }
    assert.strictEqual(me().ui_language, 'bn');
    await call('POST', '/api/me/profile', { body: { ui_language: 'en' } });
    assert.strictEqual(me().ui_language, 'en');
});
test('a phone is kept with its country code, and a wrong length says why', async () => {
    for (const [typed, kept] of [['+880 1712-345678', '+880 1712345678'], ['01712 345678', '+880 1712345678'], ['+1 (508) 414-5532', '+1 5084145532']]) {
        const r = await call('POST', '/api/me/profile', { body: { phone: typed } });
        assert.strictEqual(r.code, 200, typed + ' ' + JSON.stringify(r.body));
        assert.strictEqual(me().phone, kept, typed);
    }
    const bad = await call('POST', '/api/me/profile', { body: { phone: '+880 17123' } });
    assert.strictEqual(bad.code, 400);
    assert.match(bad.body.error, /Bangladesh has 10 digits after \+880/);
    const letters = await call('POST', '/api/me/profile', { body: { phone: 'call me' } });
    assert.strictEqual(letters.code, 400);
    assert.strictEqual(me().phone, '+1 5084145532');
});
test('the business details reach the owner\'s own business, tidied', async () => {
    const r = await call('POST', '/api/me/business', { body: { details: {
        phone: '01812 000000', website: ' www.rahimsweets.com ', address: '  12   Lake Road,\n Dhaka ',
        hours: 'Sat–Thu  10–10\nFri  closed', notes: 'Eid orders\n\n\n\nfrom the 20th', name: 'Renamed', niche: 'x', extra: 'y'
    } } });
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    const { updated_at, ...d } = mine().owner_details;
    assert.deepStrictEqual(d, {
        phone: '+880 1812000000', website: 'www.rahimsweets.com', address: '12 Lake Road, Dhaka',
        hours: 'Sat–Thu 10–10\nFri closed', notes: 'Eid orders\n\nfrom the 20th'
    });
    assert.ok(updated_at);
    assert.deepStrictEqual([mine().name, mine().niche, mine().notes], ['Rahim Sweets', 'sweet shop', 'agency notes'], 'the agency\'s fields are untouched');
    assert.deepStrictEqual(tbl('clients').find(c => c.id === THEIRS).owner_details, { phone: '+880 1811000000' }, 'another business is untouched');
});
test('/api/me hands back the business with what the agency has and the owner\'s details', async () => {
    const b = (await call('GET', '/api/me')).body.business;
    assert.deepStrictEqual([b.id, b.name, b.niche, b.location], [MINE, 'Rahim Sweets', 'sweet shop', 'Dhaka']);
    assert.deepStrictEqual(Object.keys(b.details).sort(), ['address', 'hours', 'notes', 'phone', 'website']);
    assert.strictEqual(b.details.website, 'www.rahimsweets.com');
});
test('a wrong phone, a wrong website or too much text is refused, and nothing changes', async () => {
    const before = JSON.stringify(mine().owner_details);
    for (const details of [{ phone: '123' }, { website: 'not a site' }, { notes: 'x'.repeat(1001) }, { address: 'x'.repeat(201) }]) {
        const r = await call('POST', '/api/me/business', { body: { details } });
        assert.strictEqual(r.code, 400, JSON.stringify(details).slice(0, 60));
    }
    for (const body of [{}, { details: 'x' }, { details: ['a'] }]) assert.strictEqual((await call('POST', '/api/me/business', { body })).code, 400);
    assert.strictEqual(JSON.stringify(mine().owner_details), before);
});
test('emptying every field clears the details', async () => {
    const r = await call('POST', '/api/me/business', { body: { details: { phone: '', website: '', address: '', hours: '', notes: ' ' } } });
    assert.strictEqual(r.code, 200);
    assert.strictEqual(mine().owner_details, null);
});
test('only an owner with a business has business details', async () => {
    assert.strictEqual((await call('POST', '/api/me/business', { as: 'staff', id: STAFF, body: { details: { notes: 'x' } } })).code, 403);
    mine().archived = true;
    me().agency_owner = true;
    assert.strictEqual((await call('POST', '/api/me/business', { body: { details: { notes: 'x' } } })).code, 404);
    mine().archived = false;
    delete me().agency_owner;
});
test('before the phase-84 SQL, a change says what to run', async () => {
    FAIL = /owner_details|ui_language/;
    const a = await call('POST', '/api/me/business', { body: { details: { notes: 'x' } } });
    const b = await call('POST', '/api/me/profile', { body: { ui_language: 'bn' } });
    FAIL = null;
    for (const r of [a, b]) {
        assert.strictEqual(r.code, 503);
        assert.match(r.body.error, /schema-phase84\.sql/);
    }
});
test('the page and the server check a phone the same way', () => {
    const P = require(path.join(__dirname, '..', 'frontend', 'phone-codes.js'));
    assert.strictEqual(P.COUNTRIES[0][0], 'BD', 'Bangladesh first');
    assert.deepStrictEqual(P.parse('01712345678'), { iso: 'BD', national: '1712345678' }, 'a number saved before phase 84');
    assert.deepStrictEqual(P.check('BD', '01712-345678'), { ok: true, value: '+880 1712345678' });
    assert.deepStrictEqual(P.check('BD', ''), { ok: true, value: null });
    assert.strictEqual(P.check('BD', '+880').ok, false);
});

(async () => {
    for (const [name, fn] of tests) {
        try { await fn(); passed++; console.log('  ok   ' + name); }
        catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
    }
    console.log(`\n${passed} passed`);
    process.exit();
})();
