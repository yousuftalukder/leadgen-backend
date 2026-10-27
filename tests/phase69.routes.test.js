#!/usr/bin/env node
/**
 * Phase 69 route tests — the workbook's routes, run against a small in-memory
 * stand-in for Supabase, so the queries they build are exercised and not only
 * the validation under them.
 *
 * What matters: an editor adds, pastes, edits and deletes rows of their client
 * and nothing of another's; a viewer reads and cannot write; a business owner
 * gets nothing; a product deleted leaves the creatives that showed it; a
 * template's pictures go when nothing holds them; ideas come from the client's
 * own content plans only.
 *
 *   node tests/phase69.routes.test.js
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

// ---- people and clients ----
const ED = newId(), VIEW = newId(), OWNER = newId();
const A = newId(), B = newId();
tbl('app_users').push({ id: ED, role: 'user', is_active: true }, { id: VIEW, role: 'user', is_active: true }, { id: OWNER, role: 'client', is_active: true });
tbl('clients').push({ id: A, name: 'Arminabd', owner_user_id: ED, archived: false }, { id: B, name: 'Other shop', owner_user_id: newId(), archived: false });
tbl('client_members').push({ client_id: A, user_id: VIEW, role: 'viewer' }, { client_id: A, user_id: OWNER, role: 'editor' });
const signIn = (token, id, role) => S._authCache.set(S.tokenHash(token), { ctx: { user: { id }, profile: { id, role, is_active: true, paid_until: '2099-01-01T00:00:00Z' } }, t: Date.now() });
signIn('ed', ED, 'user'); signIn('view', VIEW, 'user'); signIn('owner', OWNER, 'client');

async function call(method, route, { as = 'ed', params = {}, body = {}, query: qs = {} } = {}) {
    const h = ROUTES[method + ' ' + route];
    assert.ok(h, 'no route ' + method + ' ' + route);
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await h({ headers: { authorization: 'Bearer ' + as }, params, body, query: qs }, res);
    return res;
}
const W = '/api/clients/:id/workbook';

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('an editor adds a post and reads it back', async () => {
    const r = await call('POST', W + '/:kind', { params: { id: A, kind: 'content' }, body: { planned_on: '2026-10-28', platform: 'Facebook', idea: 'seven sleep balm', client_id: B } });
    assert.strictEqual(r.code, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.row.client_id, A, 'client_id comes from the address, never the body');
    assert.strictEqual(r.body.row.created_by, ED);
    const g = await call('GET', W, { params: { id: A }, query: { parts: 'content' } });
    assert.strictEqual(g.body.content.length, 1);
    assert.strictEqual(g.body.canEdit, true);
});
test('a pasted sheet is added at once, or not at all', async () => {
    const bad = await call('POST', W + '/:kind', { params: { id: A, kind: 'products' }, body: { rows: [{ name: 'Lotion', stock: '3' }, { stock: '2' }] } });
    assert.strictEqual(bad.code, 400);
    assert.match(bad.body.error, /^Row 2: Product name/);
    assert.strictEqual(tbl('client_products').length, 0, 'nothing written when one row is wrong');
    const ok = await call('POST', W + '/:kind', { params: { id: A, kind: 'products' }, body: { rows: [{ name: 'Lotion', stock: '3', price: '1,600' }, { name: 'Tint', stock: '0' }] } });
    assert.strictEqual(ok.code, 201); assert.strictEqual(ok.body.added, 2);
    assert.deepStrictEqual(tbl('client_products').map(p => [p.name, p.stock, p.price]), [['Lotion', 3, 1600], ['Tint', 0, null]]);
});
test('a viewer reads and cannot write', async () => {
    const g = await call('GET', W, { as: 'view', params: { id: A }, query: { parts: 'products' } });
    assert.strictEqual(g.code, 200); assert.strictEqual(g.body.canEdit, false); assert.strictEqual(g.body.products.length, 2);
    const w = await call('POST', W + '/:kind', { as: 'view', params: { id: A, kind: 'products' }, body: { name: 'x' } });
    assert.strictEqual(w.code, 404);
});
test('a business owner gets nothing, even as a member', async () => {
    const g = await call('GET', W, { as: 'owner', params: { id: A }, query: { parts: 'products' } });
    assert.strictEqual(g.code, 403);
});
test('another client\'s workbook is out of reach', async () => {
    const g = await call('GET', W, { params: { id: B }, query: { parts: 'content' } });
    assert.strictEqual(g.code, 404);
    const p = tbl('client_products')[0];
    const e = await call('PATCH', W + '/:kind/:rowId', { params: { id: B, kind: 'products', rowId: p.id }, body: { stock: 9 } });
    assert.strictEqual(e.code, 404);
    assert.strictEqual(tbl('client_products')[0].stock, 3);
});
test('a creative cannot show another client\'s product', async () => {
    const theirs = { id: newId(), client_id: B, name: 'Not ours' };
    tbl('client_products').push(theirs);
    const r = await call('POST', W + '/:kind', { params: { id: A, kind: 'creatives' }, body: { title: 'Reel', product_ids: [theirs.id] } });
    assert.strictEqual(r.code, 400); assert.match(r.body.error, /not on this client/);
});
test('an edit changes only what was sent, and an edit cannot empty a row', async () => {
    const p = tbl('client_products').find(x => x.name === 'Lotion');
    const r = await call('PATCH', W + '/:kind/:rowId', { params: { id: A, kind: 'products', rowId: p.id }, body: { stock: '25' } });
    assert.strictEqual(r.code, 200); assert.strictEqual(r.body.row.stock, 25); assert.strictEqual(r.body.row.price, 1600);
    const post = tbl('client_content_entries')[0];
    const e = await call('PATCH', W + '/:kind/:rowId', { params: { id: A, kind: 'content', rowId: post.id }, body: { planned_on: '', idea: '' } });
    assert.strictEqual(e.code, 400); assert.match(e.body.error, /date or a description/);
});
test('deleting a product takes it off the creatives that showed it', async () => {
    const [lotion, tint] = tbl('client_products').filter(x => x.client_id === A);
    const c = await call('POST', W + '/:kind', { params: { id: A, kind: 'creatives' }, body: { title: 'Combo reel', product_ids: [lotion.id, tint.id] } });
    assert.strictEqual(c.code, 201, JSON.stringify(c.body));
    const d = await call('DELETE', W + '/:kind/:rowId', { params: { id: A, kind: 'products', rowId: tint.id } });
    assert.strictEqual(d.code, 200);
    assert.deepStrictEqual(tbl('client_ad_creatives').find(x => x.id === c.body.row.id).product_ids, [lotion.id]);
});
test('an ad points at the client\'s own creative; a planned one needs only a name and a budget', async () => {
    const cr = tbl('client_ad_creatives')[0];
    const done = await call('POST', W + '/:kind', { params: { id: A, kind: 'ads' }, body: { creative_id: cr.id, spend: '3000', messages: '120', orders: '18', revenue: '22500' } });
    assert.strictEqual(done.code, 201); assert.strictEqual(done.body.row.status, 'done');
    const plan = await call('POST', W + '/:kind', { params: { id: A, kind: 'ads' }, body: { status: 'planned', campaign: 'Black Friday', budget: '5000' } });
    assert.strictEqual(plan.code, 201); assert.strictEqual(plan.body.row.budget, 5000);
    const g = await call('GET', W, { params: { id: A }, query: { parts: 'products,creatives,ads' } });
    assert.deepStrictEqual([g.body.products.length, g.body.creatives.length, g.body.ads.length], [1, 1, 2]);
});
test('a part that does not exist is refused', async () => {
    assert.strictEqual((await call('GET', W, { params: { id: A }, query: { parts: 'content,invoices' } })).code, 400);
    assert.strictEqual((await call('POST', W + '/:kind', { params: { id: A, kind: 'invoices' }, body: {} })).code, 404);
});
test('a template picture is checked by its bytes, and goes when no template holds it', async () => {
    const up = ROUTES['POST /api/clients/:id/template-media'];
    const send = async buf => { const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; await up({ headers: { authorization: 'Bearer ed' }, params: { id: A }, body: buf }, res); return res; };
    const fake = await send(Buffer.from('MZ\x90\0\x03\0\0\0\x04\0\0\0'));
    assert.strictEqual(fake.code, 400);
    const png = await send(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48]));
    assert.strictEqual(png.code, 201, JSON.stringify(png.body));
    assert.ok(png.body.url.startsWith('https://signed/'));
    const t = await call('POST', W + '/:kind', { params: { id: A, kind: 'templates' }, body: { title: 'Price list', media_ids: [png.body.id] } });
    assert.strictEqual(t.code, 201, JSON.stringify(t.body));
    assert.deepStrictEqual(t.body.row.media.map(m => m.id), [png.body.id]);
    const copy = await call('POST', W + '/:kind', { params: { id: A, kind: 'templates' }, body: { title: 'Same picture', media_ids: [png.body.id] } });
    await call('DELETE', W + '/:kind/:rowId', { params: { id: A, kind: 'templates', rowId: t.body.row.id } });
    assert.strictEqual(STORE.size, 1, 'the picture stays while another template holds it');
    await call('DELETE', W + '/:kind/:rowId', { params: { id: A, kind: 'templates', rowId: copy.body.row.id } });
    assert.strictEqual(STORE.size, 0, 'and goes with the last one');
    assert.strictEqual(tbl('client_template_media').length, 0);
});
test('ideas come from this client\'s content plans only', async () => {
    tbl('reports').push(
        { id: newId(), client_id: A, report_type: 'content_plan', created_at: '2026-10-01', platform: 'instagram', target_handle: 'arminabd', ai_json: { reels: [{ hook: 'Ours' }] } },
        { id: newId(), client_id: B, report_type: 'content_plan', created_at: '2026-10-02', ai_json: { reels: [{ hook: 'Theirs' }] } },
        { id: newId(), client_id: A, report_type: 'ig_report', created_at: '2026-10-03', ai_json: { reels: [{ hook: 'Not a plan' }] } });
    const r = await call('GET', '/api/clients/:id/workbook-ideas', { params: { id: A } });
    assert.strictEqual(r.code, 200);
    assert.deepStrictEqual(r.body.plans.flatMap(p => p.briefs.map(b => b.hook)), ['Ours']);
});

(async () => {
    console.log('phase 69 :: the workbook routes');
    for (const [name, fn] of tests) {
        try { await fn(); passed++; console.log('  ok   ' + name); }
        catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
    }
    console.log(`\n${passed} passed`);
    process.exit();
})();
