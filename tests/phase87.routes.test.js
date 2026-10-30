#!/usr/bin/env node
/**
 * Phase 87 tests — the workspace as the ad manager's memory.
 *
 * What matters: every product's break-even comes from its margin and what an
 * order costs beyond it, and a combo from its parts; nothing is invented when a
 * price is missing. An order keeps no phone number, only a code that tells a
 * returning buyer from a new one, and only editors see order rows. The check-in
 * walks the chain and flags the FIRST broken step, judges with enough evidence
 * only, uses the plan's numbers, and puts the whole business, stock, budget,
 * forecast, unplanned campaigns, account health and decisions due beside it.
 * Decisions are graded and their lessons are shared only across businesses the
 * person can open. The ads sync reads ThruPlays and 7-day windows, and keeps
 * working before the phase-87 SQL. Before it, the new routes say what to run.
 *
 *   node tests/phase87.routes.test.js
 */
'use strict';
const assert = require('assert');
const Module = require('module');
const path = require('path');

// ---- an in-memory database, enough of supabase-js's query builder for these routes ----
let DB = {};
const tbl = t => (DB[t] = DB[t] || []);
let seq = 0;
const newId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const MISSING = new Set();
let FAIL_COL = null;          // a column the database does not have yet (the SQL has not run)
function query(table) {
    const filters = [];
    let op = 'select', payload = null, conflict = null, single = false, head = false, wantCount = false, limit = null, orders = [], cols = '*';
    const q = {
        select(c, opts = {}) { if (op === 'select') cols = c || '*'; head = !!opts.head; wantCount = !!opts.count; return q; },
        insert(rows) { op = 'insert'; payload = rows; return q; },
        upsert(rows, o = {}) { op = 'upsert'; payload = rows; conflict = String(o.onConflict || 'id').split(','); return q; },
        update(p) { op = 'update'; payload = p; return q; },
        delete() { op = 'delete'; return q; },
        eq(c, v) { filters.push(r => r[c] === v); return q; },
        neq(c, v) { filters.push(r => r[c] !== v); return q; },
        in(c, vs) { filters.push(r => vs.includes(r[c])); return q; },
        gte(c, v) { filters.push(r => String(r[c]) >= String(v)); return q; },
        lte(c, v) { filters.push(r => String(r[c]) <= String(v)); return q; },
        lt(c, v) { filters.push(r => String(r[c]) < String(v)); return q; },
        is(c, v) { filters.push(r => (r[c] ?? null) === v); return q; },
        not(c, o, v) { if (o === 'is' && v === null) filters.push(r => (r[c] ?? null) !== null); return q; },
        contains(c, v) { filters.push(r => [].concat(v).every(x => (r[c] || []).includes(x))); return q; },
        overlaps() { return q; },
        order(c, o = {}) { orders.push([c, o.ascending !== false]); return q; },
        limit(n) { limit = n; return q; },
        maybeSingle() { single = true; return q; },
        single() { single = true; return q; },
        then(ok, no) { return Promise.resolve().then(run).then(ok, no); }
    };
    function run() {
        if (MISSING.has(table)) return { data: null, error: { code: '42P01', message: `relation "${table}" does not exist` } };
        if (FAIL_COL && op === 'select' && cols.includes(FAIL_COL)) return { data: null, error: { code: '42703', message: `column ${table}.${FAIL_COL} does not exist` } };
        if (FAIL_COL && (op === 'upsert' || op === 'insert' || op === 'update') && [].concat(payload).some(r => r && FAIL_COL in r)) {
            return { data: null, error: { code: 'PGRST204', message: `Could not find the '${FAIL_COL}' column of '${table}' in the schema cache` } };
        }
        const rows = tbl(table);
        const hit = rows.filter(r => filters.every(f => f(r)));
        let data;
        if (op === 'insert') {
            const add = [].concat(payload).map(r => ({ id: r.id || newId(), created_at: new Date().toISOString(), ...r }));
            rows.push(...add); data = add;
        } else if (op === 'upsert') {
            data = [].concat(payload).map(r => {
                const old = rows.find(x => conflict.every(k => x[k] === r[k]));
                if (old) return Object.assign(old, r);
                const n = { ...r }; rows.push(n); return n;
            });
        } else if (op === 'update') { hit.forEach(r => Object.assign(r, payload)); data = hit; }
        else if (op === 'delete') { DB[table] = rows.filter(r => !hit.includes(r)); data = hit; }
        else {
            data = [...hit];
            if (cols !== '*' && !/[(:*]/.test(cols)) { const keep = cols.split(',').map(x => x.trim()); data = data.map(r => Object.fromEntries(keep.filter(k => k in r).map(k => [k, r[k]]))); }
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
const stubs = {
    express: Object.assign(() => {
        const reg = m => (p, ...h) => { ROUTES[m + ' ' + p] = h[h.length - 1]; };
        return { set() {}, use() {}, listen() {}, get: reg('GET'), post: reg('POST'), patch: reg('PATCH'), delete: reg('DELETE'), put: reg('PUT') };
    }, { json: () => (_, __, n) => n && n(), raw: () => (_, __, n) => n && n(), static: () => () => {} }),
    cors: () => () => {},
    'apify-client': { ApifyClient: class {} },
    '@supabase/supabase-js': { createClient: () => ({ from: query, rpc: () => query('rpc'), storage: {}, auth: { getUser: async () => ({ data: null, error: new Error('stub') }) } }) },
    dotenv: { config() {} }
};
const realLoad = Module._load;
Module._load = function (req, ...rest) { return stubs[req] !== undefined ? stubs[req] : realLoad.call(this, req, ...rest); };
process.env.SUPABASE_URL = 'http://stub'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
process.env.ORDER_HASH_SECRET = 'a-test-secret-of-enough-length';
require(path.join(__dirname, '..', 'server.js'));
const S = require(path.join(__dirname, '..', 'src', 'shared'));
const ADS = require(path.join(__dirname, '..', 'xp', 'ingest', 'ads.js'));

// ---- people, businesses, ads ----
const BOSS = newId(), EDITOR = newId(), VIEWER = newId(), OWNER = newId(), OTHER_AGENCY = newId();
const SHOP = newId(), PEER = newId(), FAR = newId();
const BALM = newId(), SOAP = newId(), COMBO = newId(), NOPRICE = newId(), FARPROD = newId();
const today = new Date().toISOString().slice(0, 10);
const daysAgo = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
function seed() {
    DB = {}; FAIL_COL = null; MISSING.clear();
    tbl('app_users').push(
        { id: BOSS, role: 'employee', is_active: true, email: 'boss@agency.test' },
        { id: EDITOR, role: 'employee', is_active: true, email: 'ed@agency.test' },
        { id: VIEWER, role: 'employee', is_active: true, email: 'view@agency.test' },
        { id: OWNER, role: 'client', is_active: true, email: 'owner@shop.test' },
        { id: OTHER_AGENCY, role: 'employee', is_active: true, email: 'x@other.test' });
    const cl = (id, owner, name, niche) => ({ id, owner_user_id: owner, name, niche, location: 'Dhaka', archived: false, competitors: [], created_at: '2026-01-01' });
    tbl('clients').push(cl(SHOP, BOSS, 'Armin Skin', 'skincare'), cl(PEER, BOSS, 'Glow Care', 'skincare shop'), cl(FAR, OTHER_AGENCY, 'Not Ours', 'skincare'));
    tbl('client_members').push({ client_id: SHOP, user_id: EDITOR, role: 'editor' }, { client_id: SHOP, user_id: VIEWER, role: 'viewer' }, { client_id: SHOP, user_id: OWNER, role: 'editor' });
    tbl('client_products').push(
        { id: BALM, client_id: SHOP, name: 'Balm', price: 1200, cost: 700, stock: 40, components: [], created_at: '2026-01-02' },
        { id: SOAP, client_id: SHOP, name: 'Soap', price: 400, cost: 150, stock: 5, components: [], created_at: '2026-01-03' },
        { id: COMBO, client_id: SHOP, name: 'Balm + 2 soaps', price: 1800, cost: null, stock: null, components: [{ product_id: BALM, qty: 1 }, { product_id: SOAP, qty: 2 }], created_at: '2026-01-04' },
        { id: NOPRICE, client_id: SHOP, name: 'Serum', price: null, cost: 500, stock: 0, components: [], created_at: '2026-01-05' },
        { id: FARPROD, client_id: FAR, name: 'Theirs', price: 10, cost: 5, components: [], created_at: '2026-01-05' });
    tbl('xp_meta_ad_accounts').push({ ad_account_id: 'act_1', client_id: SHOP, name: 'Armin ads', currency: 'BDT', account_status: 1, last_synced_at: new Date().toISOString() });
    tbl('xp_meta_ad_campaigns').push(
        { campaign_id: '2385001201', client_id: SHOP, name: 'Messages Oct', status: 'ACTIVE' },
        { campaign_id: '2385001202', client_id: SHOP, name: 'Boosted post', status: 'ACTIVE' });
    tbl('xp_meta_ad_sets').push(
        { adset_id: '2385002201', client_id: SHOP, campaign_id: '2385001201', name: 'Women 20-40', status: 'ACTIVE', daily_budget: 500 },
        { adset_id: '2385002202', client_id: SHOP, campaign_id: '2385001201', name: 'Silent set', status: 'ACTIVE', daily_budget: 300 });
    tbl('xp_meta_ads').push(
        { ad_id: '2385003301', client_id: SHOP, adset_id: '2385002201', campaign_id: '2385001201', name: 'Price-first cut' },
        { ad_id: '2385003302', client_id: SHOP, adset_id: '2385002201', campaign_id: '2385001201', name: 'Problem-first cut' },
        { ad_id: '2385003303', client_id: SHOP, adset_id: '2385002202', campaign_id: '2385001201', name: 'Old ad' },
        { ad_id: '2385003304', client_id: SHOP, campaign_id: '2385001202', name: 'Owner boost' });
    const d = (ad, n, x) => ({ ad_id: ad, client_id: SHOP, campaign_id: ad === '2385003304' ? '2385001202' : '2385001201', metric_date: daysAgo(n), currency: 'BDT', ...x });
    for (const n of [0, 1, 2]) {
        // stop-scroll 10%: broken at step 3, and its cost per message is high too (a symptom)
        tbl('xp_ad_daily_snapshots').push(d('2385003301', n, { spend: 400, impressions: 4000, link_clicks: 40, video_plays: 400, thruplays: 100, messages_started: 2, purchases: 0 }));
        // healthy: stop-scroll 30%, watch-through 50%, cheap messages
        tbl('xp_ad_daily_snapshots').push(d('2385003302', n, { spend: 400, impressions: 4000, link_clicks: 60, video_plays: 1200, thruplays: 600, messages_started: 20, purchases: 1 }));
    }
    tbl('xp_ad_daily_snapshots').push(d('2385003303', 20, { spend: 300, impressions: 3000, messages_started: 5 }), d('2385003304', 5, { spend: 900, impressions: 9000, messages_started: 3 }));
    tbl('xp_ad_reach_windows').push({ ad_id: '2385003301', client_id: SHOP, ad_account_id: 'act_1', adset_id: '2385002201', reach: 3000, impressions: 12000, frequency: 4, updated_at: '2026-01-01' },
        { ad_id: '2385003302', client_id: SHOP, ad_account_id: 'act_1', adset_id: '2385002201', reach: 6000, impressions: 12000, frequency: 2, updated_at: '2026-01-01' });
    tbl('client_ad_briefs').push({ client_id: SHOP, brief: { monthly_budget: 30000, currency: 'BDT' } });
    tbl('client_ad_plans').push({ id: newId(), client_id: SHOP, status: 'launched', title: 'October messages', created_at: '2026-10-01',
        plan: { target_cost: 40, target_cost_per_order: 300, min_stop_scroll: 20, max_frequency: 3, forecast_order_rate: 20, forecast_messages: 1000, forecast_spend: 30000, forecast_orders: 200, meta_campaign_ids: '2385001201' } });
    tbl('client_ad_runs').push({ id: newId(), client_id: SHOP, campaign: 'Some old ledger run' });
}

const signIn = (token, id) => {
    const u = tbl('app_users').find(x => x.id === id);
    S._authCache.set(S.tokenHash(token), { ctx: { user: { id, email: u.email }, profile: { ...u, paid_until: '2099-01-01T00:00:00Z' } }, t: Date.now() });
};
async function call(method, route, { who = BOSS, params = {}, body = {}, query: qs = {} } = {}) {
    signIn('t-' + who, who);
    const h = ROUTES[method + ' ' + route];
    assert.ok(h, 'no route ' + method + ' ' + route);
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await h({ headers: { authorization: 'Bearer t-' + who }, params: { id: SHOP, ...params }, body, query: qs }, res);
    return res;
}

// ---- what a result is worth ----
test('break-even: margin less COD, failed parcels, packing and delivery top-up; target is half', () => {
    const [balm] = S.productEconomics([{ id: 'b', name: 'Balm', price: 1200, cost: 700 }], {});
    // defaults: COD 1% (12), 20% failed at 120 → 0.25 × 120 = 30 per delivered order, no packing
    assert.deepStrictEqual([balm.margin, balm.cod_fee, balm.failed_parcel_cost, balm.break_even, balm.target_cost_per_order], [500, 12, 30, 458, 229]);
    assert.strictEqual(balm.free_delivery_break_even, null, 'no zones, no free-delivery figure');
    const [z] = S.productEconomics([{ id: 'b', name: 'Balm', price: 1200, cost: 700 }],
        { packing_cost: 20, delivery_zones: [{ name: 'Chattogram', charge: 0, courier_cost: 60 }, { name: 'Dhaka', charge: 70, courier_cost: 70 }, { name: 'Other', charge: 100, courier_cost: 130 }] },
        { orderRate: 20 });
    // top-up: Chattogram 60 (free to the buyer), Other 30 → the most is 60
    assert.deepStrictEqual([z.delivery_top_up, z.break_even, z.free_delivery_break_even, z.target_cost_per_order, z.target_cost_per_message], [60, 378, 248, 189, 37.8]);
    const [cheap] = S.productEconomics([{ id: 'c', name: 'Lip', price: 120, cost: 100 }], {});
    assert.ok(cheap.loses_money && cheap.target_cost_per_order === null, 'a product that cannot pay for ads says so');
});
test('a combo takes its cost and stock from its parts; a missing price is said, never guessed', () => {
    seed();
    const E = S.productEconomics(tbl('client_products').filter(p => p.client_id === SHOP), {});
    const combo = E.find(p => p.id === COMBO);
    assert.deepStrictEqual([combo.combo, combo.cost, combo.cost_from, combo.stock, combo.stock_from], [true, 1000, 'parts', 2, 'parts'], '700 + 2×150; soap 5 ÷ 2 = 2');
    assert.deepStrictEqual(combo.parts.map(x => [x.name, x.qty]), [['Balm', 1], ['Soap', 2]]);
    const serum = E.find(p => p.id === NOPRICE);
    assert.deepStrictEqual([serum.break_even, serum.missing], [null, ['customer price']]);
});
test('the settings are checked, with the field named', () => {
    assert.deepStrictEqual(S.cleanEconomics({ fail_rate_pct: '15', delivery_zones: [{ name: ' Dhaka ', charge: '70', courier_cost: '৳80' }] }),
        { fail_rate_pct: 15, delivery_zones: [{ name: 'Dhaka', charge: 70, courier_cost: 80 }] });
    assert.throws(() => S.cleanEconomics({ fail_rate_pct: 95 }), /Failed parcels %/);
    assert.throws(() => S.cleanEconomics({ delivery_zones: [{ name: 'A' }, { name: 'a' }] }), /same name/);
    assert.throws(() => S.cleanEconomics({ delivery_zones: [{ charge: 5 }] }), /give it a name/);
});

// ---- orders ----
test('a phone number becomes one code whatever its format, and is never kept', () => {
    assert.strictEqual(S.normalPhone('+880 1711-000000'), '01711000000');
    assert.strictEqual(S.normalPhone('8801711000000'), '01711000000');
    assert.strictEqual(S.normalPhone('1711000000'), '01711000000');
    assert.strictEqual(S.normalPhone('12'), null);
    const h = S.phoneHash('01711-000000');
    assert.match(h, /^[0-9a-f]{32}$/);
    assert.strictEqual(S.phoneHash('+8801711000000'), h);
    assert.ok(!h.includes('1711000000'));
    assert.strictEqual(S.phoneHash('01711000000', null), null, 'no secret, no code');
});
test('an order is checked: its products, its value, its delivery and its ad', () => {
    const products = new Map([[BALM, { id: BALM, price: 1200 }], [SOAP, { id: SOAP, price: 400 }]]);
    const zones = [{ name: 'Dhaka', charge: 70, courier_cost: 70 }];
    const o = S.cleanOrder({ items: [{ product_id: BALM, qty: 1 }, { product_id: SOAP, qty: '2', price: 350 }], delivery_zone: 'dhaka', source: 'ad', ad_id: '2385003302' }, { create: true, products, zones });
    assert.deepStrictEqual([o.value, o.delivery_charge, o.status, o.channel, o.ad_id], [1900, 70, 'confirmed', 'messenger', '2385003302']);
    assert.strictEqual(S.cleanOrder({ free_delivery: true, delivery_zone: 'Dhaka' }, { create: true, products, zones }).delivery_charge, 0);
    assert.throws(() => S.cleanOrder({ items: [{ product_id: FARPROD }] }, { create: true, products, zones }), /Item 1: pick one of this client’s products/);
    assert.throws(() => S.cleanOrder({ source: 'organic', ad_id: '2385003302' }, { create: true, products, zones }), /only an order from an ad/);
    assert.throws(() => S.cleanOrder({ ad_id: 'abc', source: 'ad' }, { create: true, products, zones }), /digits only/);
    assert.throws(() => S.cleanOrder({ status: 'lost' }, { create: true, products, zones }), /Status: one of/);
});
test('orders: editors only; the buyer comes back as returning, and the number is nowhere', async () => {
    seed();
    const first = await call('POST', '/api/clients/:id/orders', { who: EDITOR, body: { ordered_on: daysAgo(3), items: [{ product_id: BALM, qty: 1 }], source: 'ad', ad_id: '2385003302', phone: '01711-000000' } });
    assert.strictEqual(first.code, 201, JSON.stringify(first.body));
    assert.deepStrictEqual([first.body.order.buyer_type, first.body.order.buyer_hash, first.body.order.known_buyer], ['new', undefined, true]);
    const again = await call('POST', '/api/clients/:id/orders', { who: EDITOR, body: { ordered_on: daysAgo(1), items: [{ product_id: SOAP, qty: 1 }], phone: '+8801711000000' } });
    assert.deepStrictEqual([again.body.order.buyer_type, again.body.order.source], ['returning', 'repeat'], 'same number, other format; unknown source becomes repeat');
    assert.ok(!JSON.stringify(DB).includes('1711000000'), 'the phone number is stored nowhere');
    assert.strictEqual((await call('GET', '/api/clients/:id/orders', { who: VIEWER })).code, 404, 'a viewer sees no order rows');
    assert.strictEqual((await call('GET', '/api/clients/:id/orders', { who: OWNER })).code, 403);
    const list = await call('GET', '/api/clients/:id/orders', { who: EDITOR });
    assert.strictEqual(list.code, 200, JSON.stringify(list.body));
    assert.strictEqual(list.body.orders.length, 2);
    assert.ok(list.body.orders.every(o => o.buyer_hash === undefined && o.known_buyer));
    assert.strictEqual(list.body.ads[0].ad_id, '2385003301', 'ads that spent most first');
    const at = { id: SHOP, orderId: first.body.order.id };
    const st = await call('PATCH', '/api/clients/:id/orders/:orderId', { who: EDITOR, params: at, body: { status: 'delivered' } });
    assert.deepStrictEqual([st.body.order.status, st.body.order.status_on], ['delivered', today]);
    const bad = await call('PATCH', '/api/clients/:id/orders/:orderId', { who: EDITOR, params: at, body: { source: 'organic' } });
    assert.strictEqual(bad.code, 400, 'an order with an ad cannot become organic without dropping the ad');
    assert.strictEqual((await call('DELETE', '/api/clients/:id/orders/:orderId', { who: VIEWER, params: at })).code, 404);
    assert.strictEqual((await call('DELETE', '/api/clients/:id/orders/:orderId', { who: EDITOR, params: at })).code, 200);
});

// ---- the chain ----
const T = { normal_cpm: 100, min_stop_scroll: 20, best_watch: 50, cost_per_message: 40, chat_to_order: 20, cost_per_order: 300, max_frequency: 3, orders_known: true };
const fig = x => ({ spend: 1200, impressions: 12000, plays: 3600, cpm: 100, stop_scroll: 30, watch_through: 50, messages: 60, cost_per_message: 20, ...x });
test('the chain stops at the first broken step; later ones are symptoms', () => {
    const c = S.chainFor({ period: fig({ stop_scroll: 10, cost_per_message: 200, messages: 6 }), week: fig({ orders_from: 'log', orders: 1, chat_to_order: 2, cost_per_order: 1200 }), active: true, video: true, frequency: 4 }, T);
    assert.strictEqual(c.first.step, 3, 'stop-scroll, not cost per message, chats or fatigue');
    assert.match(c.first.next_move, /opening/);
    assert.deepStrictEqual(c.steps.filter(s => s.state === 'broken').map(s => s.step), [3, 5, 6, 7, 8]);
});
test('too little evidence is “too early”, never broken', () => {
    const c = S.chainFor({ period: fig({ spend: 60, impressions: 900, stop_scroll: 5, messages: 0, cost_per_message: null }), week: fig({ messages: 3, spend: 100 }), active: true, video: true, frequency: 1 }, T);
    assert.strictEqual(c.first, null);
    assert.deepStrictEqual(c.steps.filter(s => s.state === 'too_early').map(s => s.step), [2, 3, 5, 6, 7]);
});
test('a live ad set that spent nothing is broken at step 1; a paused one is not judged', () => {
    assert.strictEqual(S.chainFor({ period: fig({ spend: 0 }), week: fig(), active: true }, T).first.step, 1);
    assert.deepStrictEqual(S.chainFor({ period: fig({ spend: 0 }), week: fig(), active: false }, T), { paused: true, steps: [], first: null });
    const noTarget = S.chainFor({ period: fig(), week: fig(), active: true, video: false, frequency: null }, { orders_known: false });
    assert.deepStrictEqual(noTarget.steps.map(s => s.state), ['ok', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
});

// ---- the check-in ----
test('the check-in flags each ad’s first broken step against the plan’s numbers', async () => {
    seed();
    const r = await call('GET', '/api/clients/:id/ad-checkin', { who: VIEWER });
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    const b = r.body;
    assert.deepStrictEqual([b.period.days, b.plan.title, b.targets.cost_per_message, b.targets.cost_per_order, b.targets_from.cost_per_order], [3, 'October messages', 40, 300, 'plan']);
    const a1 = b.ads.find(a => a.ad_id === '2385003301'), a2 = b.ads.find(a => a.ad_id === '2385003302');
    assert.deepStrictEqual([a1.period.stop_scroll, a1.first_broken.step], [10, 3]);
    assert.deepStrictEqual([a2.period.stop_scroll, a2.period.watch_through, a2.period.cost_per_message], [30, 50, 20]);
    assert.deepStrictEqual([a2.first_broken.step, a2.week.chat_to_order], [6, 5], 'its ads are fine; the inbox turns 5% of chats into orders against 20%');
    assert.strictEqual(a1.frequency_7d, 4);
    assert.ok(b.ads.find(a => a.ad_id === '2385003303').paused, 'an ad that did not run in the period is not judged');
    const silent = b.adsets.find(s => s.adset_id === '2385002202');
    assert.strictEqual(silent.first_broken.step, 1, 'a live ad set that spent nothing in the period');
    assert.deepStrictEqual(b.broken.map(x => [x.ad_id, x.step]).sort(), [['2385003301', 3], ['2385003302', 6]]);
    assert.deepStrictEqual(b.unplanned.map(u => u.name), ['Boosted post'], 'the owner’s boost is in no plan or ledger');
    assert.strictEqual(b.budget.monthly_budget, 30000);
    assert.ok(b.health.every(h => h.ok));
    assert.ok(b.gaps.some(g => /No orders logged here/.test(g)), 'orders are Meta’s until they are logged');
    assert.strictEqual(b.totals.period.orders_from, 'meta');
    const stock = b.stock.map(s => [s.name, s.warning]);
    assert.ok(stock.some(([n, w]) => n === 'Soap' && w === 'low') && stock.some(([n, w]) => n === 'Serum' && w === 'out'));
});
test('with orders logged: chats → orders, MER, cost per delivered order, and Meta disagreeing', async () => {
    seed();
    const o = (n, status, ad, value = 1200) => ({ id: newId(), client_id: SHOP, ordered_on: daysAgo(n), status, value, source: ad ? 'ad' : 'organic', ad_id: ad, items: [{ product_id: BALM, qty: 1, price: value }] });
    tbl('client_orders').push(o(0, 'delivered', '2385003302'), o(1, 'delivered', '2385003302'), o(2, 'failed', '2385003302'), o(2, 'confirmed', null), o(1, 'cancelled', '2385003302'));
    tbl('client_ad_decisions').push({ id: newId(), client_id: SHOP, decided_on: daysAgo(4), change: 'New opening', check_on: daysAgo(1), outcome: null },
        { id: newId(), client_id: SHOP, decided_on: daysAgo(1), change: 'Budget +20%', check_on: daysAgo(-3), outcome: null });
    const b = (await call('GET', '/api/clients/:id/ad-checkin')).body;
    const a2 = b.ads.find(a => a.ad_id === '2385003302');
    assert.deepStrictEqual([a2.period.orders_from, a2.period.orders, a2.period.delivered], ['log', 3, 2], 'the cancelled one does not count');
    assert.strictEqual(b.business.period.orders, 4);
    assert.strictEqual(b.business.period.delivered_value, 2400);
    assert.strictEqual(b.business.period.mer, Math.round(2400 / 2400 * 100) / 100, 'delivered sales ÷ all ad spend');
    assert.strictEqual(b.business.fail_rate_30, 33.3);
    assert.deepStrictEqual(b.decisions_due.map(x => x.change), ['New opening']);
    assert.strictEqual(b.decisions_open, 1);
    assert.ok(!b.gaps.some(g => /No orders logged/.test(g)));
});
test('the period is checked; before the phase-87 SQL the check-in says what to run', async () => {
    seed();
    assert.strictEqual((await call('GET', '/api/clients/:id/ad-checkin', { query: { from: '2026-10-10', to: '2026-10-01' } })).code, 400);
    assert.strictEqual((await call('GET', '/api/clients/:id/ad-checkin', { query: { from: '2026-01-01', to: '2026-10-01' } })).code, 400, '92 days at most');
    MISSING.add('client_orders');
    const r = await call('GET', '/api/clients/:id/ad-checkin');
    assert.strictEqual(r.code, 503);
    assert.match(r.body.error, /schema-phase87\.sql/);
    MISSING.clear(); MISSING.add('client_ad_economics');
    assert.strictEqual((await call('GET', '/api/clients/:id/economics')).code, 503);
    MISSING.clear();
    FAIL_COL = 'thruplays';
    const old = await call('GET', '/api/clients/:id/ad-checkin');
    assert.strictEqual(old.code, 200, 'the days are read without ThruPlays');
    assert.strictEqual(old.body.ads.find(a => a.ad_id === '2385003302').period.watch_through, null);
});
test('the owner and people not on the client get nothing', async () => {
    seed();
    assert.strictEqual((await call('GET', '/api/clients/:id/ad-checkin', { who: OWNER })).code, 403);
    assert.strictEqual((await call('GET', '/api/clients/:id/ad-checkin', { who: OTHER_AGENCY })).code, 404);
    assert.strictEqual((await call('GET', '/api/clients/:id/results-report', { who: OTHER_AGENCY })).code, 404);
});

// ---- economics routes and combos in the workbook ----
test('Delivery & costs is saved by editors and every product gets its break-even', async () => {
    seed();
    assert.strictEqual((await call('PUT', '/api/clients/:id/economics', { who: VIEWER, body: { fail_rate_pct: 10 } })).code, 404);
    const r = await call('PUT', '/api/clients/:id/economics', { who: EDITOR, body: { fail_rate_pct: '0', cod_fee_pct: 0 } });
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    const g = (await call('GET', '/api/clients/:id/economics', { who: VIEWER })).body;
    assert.deepStrictEqual([g.set, g.canEdit, g.order_rate], [true, false, 20]);
    assert.deepStrictEqual(g.products.find(p => p.id === BALM).break_even, 500);
    assert.strictEqual((await call('PUT', '/api/clients/:id/economics', { who: EDITOR, body: {} })).code, 400);
});
test('a combo is made of this client’s products only, never of itself, and loses a deleted part', async () => {
    seed();
    const bad = await call('POST', '/api/clients/:id/workbook/:kind', { who: EDITOR, params: { kind: 'products' }, body: { name: 'X', components: [{ product_id: FARPROD, qty: 1 }] } });
    assert.strictEqual(bad.code, 400);
    const self = await call('PATCH', '/api/clients/:id/workbook/:kind/:rowId', { who: EDITOR, params: { kind: 'products', rowId: COMBO }, body: { components: [{ product_id: COMBO }] } });
    assert.strictEqual(self.code, 400);
    const ok = await call('POST', '/api/clients/:id/workbook/:kind', { who: EDITOR, params: { kind: 'products' }, body: { name: 'Twin balm', components: [{ product_id: BALM, qty: '1' }, { product_id: BALM, qty: 1 }] } });
    assert.strictEqual(ok.code, 201, JSON.stringify(ok.body));
    assert.deepStrictEqual(ok.body.row.components, [{ product_id: BALM, qty: 2 }], 'the same part twice is one line of two');
    assert.strictEqual((await call('DELETE', '/api/clients/:id/workbook/:kind/:rowId', { who: EDITOR, params: { kind: 'products', rowId: SOAP } })).code, 200);
    assert.deepStrictEqual(tbl('client_products').find(p => p.id === COMBO).components, [{ product_id: BALM, qty: 1 }]);
});

// ---- decisions and lessons ----
test('a decision is logged, graded with its lesson, and shared only where the person can see', async () => {
    seed();
    const made = await call('POST', '/api/clients/:id/ad-decisions', { who: EDITOR, body: { scope: 'ad', scope_id: '2385003301', change: 'New problem-first opening', step: 3, metric: 'stop_scroll', expected: '10% → 20%+', check_on: daysAgo(-3) } });
    assert.strictEqual(made.code, 201, JSON.stringify(made.body));
    assert.strictEqual(made.body.decision.decided_on, today);
    const at = { id: SHOP, decisionId: made.body.decision.id };
    const g = await call('PATCH', '/api/clients/:id/ad-decisions/:decisionId', { who: EDITOR, params: at, body: { outcome: 'right', lesson: 'Problem-first openings beat price-first for balms', idea_type: 'opening', idea: 'problem-first' } });
    assert.deepStrictEqual([g.body.decision.outcome, g.body.decision.graded_on], ['right', today]);
    assert.strictEqual((await call('PATCH', '/api/clients/:id/ad-decisions/:decisionId', { who: EDITOR, params: at, body: { check_on: daysAgo(30) } })).code, 400, 'checked before it was made');
    assert.strictEqual((await call('POST', '/api/clients/:id/ad-decisions', { who: EDITOR, body: { change: ' ' } })).code, 400);
    assert.strictEqual((await call('POST', '/api/clients/:id/ad-decisions', { who: VIEWER, body: { change: 'x' } })).code, 404);
    tbl('client_ad_decisions').push({ id: newId(), client_id: FAR, decided_on: today, change: 'secret', lesson: 'Another agency’s lesson', idea_type: 'opening' },
        { id: newId(), client_id: PEER, decided_on: daysAgo(9), change: 'Offer test', lesson: 'Free delivery over 1500 lifted orders', idea_type: 'offer' });
    const L = (await call('GET', '/api/ad-lessons', { query: { client: SHOP } })).body.lessons;
    assert.deepStrictEqual(L.map(x => x.client).sort(), ['Armin Skin', 'Glow Care'], 'never another agency’s');
    assert.ok(L.find(x => x.client === 'Glow Care').same_kind);
    const only = (await call('GET', '/api/ad-lessons', { query: { idea_type: 'offer' } })).body.lessons;
    assert.deepStrictEqual(only.map(x => x.lesson), ['Free delivery over 1500 lifted orders']);
    assert.strictEqual((await call('GET', '/api/ad-lessons', { who: EDITOR })).body.lessons.length, 1, 'an editor of one client sees that client’s');
});

// ---- the month for the client ----
test('the results report: what we spent, what it sold, against last month, and what is next', async () => {
    seed();
    const month = today.slice(0, 7);
    tbl('client_orders').push(
        { id: newId(), client_id: SHOP, ordered_on: today, status: 'delivered', value: 1200, source: 'ad', ad_id: '2385003302', buyer_type: 'new', items: [{ product_id: BALM, qty: 1, price: 1200 }] },
        { id: newId(), client_id: SHOP, ordered_on: today, status: 'failed', value: 400, source: 'organic', buyer_type: 'returning', items: [{ product_id: SOAP, qty: 1, price: 400 }] });
    tbl('client_ad_decisions').push({ id: newId(), client_id: SHOP, decided_on: today, change: 'Paused the price-first cut', step: 3, outcome: 'right', lesson: 'Problem first' });
    const r = await call('GET', '/api/clients/:id/results-report', { who: VIEWER, query: { month } });
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    const R = r.body;
    assert.strictEqual(R.orders_from, 'log');
    assert.deepStrictEqual([R.orders.orders, R.orders.delivered, R.orders.failed, R.orders.from_ads, R.orders.new_buyers, R.orders.returning_buyers], [2, 1, 1, 1, 1, 1]);
    assert.strictEqual(R.spent_and_sold.delivered_value, 1200);
    assert.ok(R.summary.length >= 2);
    assert.strictEqual(R.whats_next.plan.title, 'October messages');
    assert.deepStrictEqual(R.changes.map(x => [x.change, x.why_step, x.outcome]), [['Paused the price-first cut', 'Stop-scroll', 'right']]);
    assert.strictEqual(R.top_ads[0].ad_id, '2385003302');
    assert.strictEqual((await call('GET', '/api/clients/:id/results-report', { query: { month: '2026-13' } })).code, 400);
});
test('the results without logged orders use Meta’s purchases, and say so', () => {
    const R = S.buildResults({ month: '2026-10', today: '2026-10-30', client: { name: 'X' },
        days: [{ ad_id: '1', spend: 1000, messages_started: 50, purchases: 5, purchase_value: 6000 }], prevDays: [{ ad_id: '1', spend: 1000, messages_started: 25 }],
        orders: [], prevOrders: [], products: [], plans: [], decisions: [], ads: [] });
    assert.deepStrictEqual([R.orders_from, R.spent_and_sold.orders, R.spent_and_sold.mer, R.spent_and_sold.cost_per_order, R.change.cost_per_message], ['meta', 5, 6, 200, -50]);
    assert.strictEqual(R.whats_next.next_check, '2026-11-02');
});

// ---- the ads sync ----
test('the sync keeps ThruPlays and plays to the end, and each ad’s 7-day window', async () => {
    seed();
    const row = ADS.snapshotRow({ ad_id: '9', date_start: '2026-10-01', spend: '10', impressions: '100', video_thruplay_watched_actions: [{ action_type: 'video_view', value: '12' }], video_p100_watched_actions: [{ action_type: 'video_view', value: '4' }] }, { client_id: SHOP }, { ad_account_id: 'act_1' });
    assert.deepStrictEqual([row.thruplays, row.video_p100], [12, 4]);
    assert.strictEqual(ADS.snapshotRow({ ad_id: '9', date_start: '2026-10-01' }, { client_id: SHOP }, { ad_account_id: 'act_1' }).thruplays, 0, 'a row Meta sent without plays had none');
    tbl('xp_ad_reach_windows').push({ ad_id: 'gone', client_id: SHOP, ad_account_id: 'act_1', updated_at: '2020-01-01' });
    const g = { async paginate() { return [{ ad_id: '2385003301', adset_id: '2385002201', spend: '1200', impressions: '12000', reach: '3000', frequency: '4.0049', date_start: daysAgo(6), date_stop: today }, { ad_id: '999', frequency: '9' }]; } };
    const ads = new Map([['2385003301', { ad_id: '2385003301', client_id: SHOP, adset_id: '2385002201' }], ['999', { ad_id: '999', client_id: null }]]);
    const run = { errors: [], err(s, e) { this.errors.push(s + ': ' + e.message); } };
    await ADS.syncReachWindows(g, { ad_account_id: 'act_1', timezone_name: 'Asia/Dhaka' }, ads, run);
    assert.deepStrictEqual(run.errors, []);
    const w = tbl('xp_ad_reach_windows');
    assert.deepStrictEqual(w.map(x => [x.ad_id, x.reach, x.frequency]), [['2385003301', 3000, 4]], 'no business, no window; the old one is gone');
});
test('before the phase-87 SQL the sync stores what it can without the new columns', async () => {
    seed();
    FAIL_COL = 'thruplays';
    await ADS.upsertP87('xp_ad_daily_snapshots', [{ ad_id: '2385003301', metric_date: '2026-09-01', spend: 5, thruplays: 3, video_p100: 1 }], 'ad_id,metric_date');
    const r = tbl('xp_ad_daily_snapshots').find(x => x.metric_date === '2026-09-01');
    assert.ok(r && !('thruplays' in r) && !('video_p100' in r) && r.spend === 5);
    FAIL_COL = 'disable_reason';
    await ADS.upsertP87('xp_meta_ad_accounts', [{ ad_account_id: 'act_1', disable_reason: 0, name: 'Renamed' }], 'ad_account_id');
    assert.strictEqual(tbl('xp_meta_ad_accounts')[0].name, 'Renamed');
    FAIL_COL = 'name';
    await assert.rejects(() => ADS.upsertP87('xp_meta_ad_accounts', [{ ad_account_id: 'act_1', name: 'x' }], 'ad_account_id'), 'only the phase-87 columns are dropped');
    FAIL_COL = null;
});
test('the account health panel names what is wrong', () => {
    const b = S.buildCheckin({ today: '2026-10-30', from: '2026-10-28', to: '2026-10-30', accounts: [{ name: 'A', account_status: 3, disable_reason: 3, last_synced_at: '2026-10-01T00:00:00Z' }] });
    assert.deepStrictEqual(b.health[0].problems, ['Unpaid balance', 'Reason: Risk payment', 'Not read for over two days.']);
});

// ---- wiring ----
test('the routes, the pages and the SQL are in place', () => {
    const fs = require('fs');
    for (const r of ['GET /api/clients/:id/ad-checkin', 'GET /api/clients/:id/results-report', 'GET /api/clients/:id/orders', 'POST /api/clients/:id/orders',
        'PATCH /api/clients/:id/orders/:orderId', 'DELETE /api/clients/:id/orders/:orderId', 'GET /api/clients/:id/economics', 'PUT /api/clients/:id/economics',
        'GET /api/clients/:id/ad-decisions', 'POST /api/clients/:id/ad-decisions', 'PATCH /api/clients/:id/ad-decisions/:decisionId',
        'DELETE /api/clients/:id/ad-decisions/:decisionId', 'GET /api/ad-lessons']) assert.ok(ROUTES[r], r);
    const root = path.join(__dirname, '..');
    const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    assert.ok(server.indexOf("require('./src/24-ad-ops')") > server.indexOf("require('./src/23-ad-brief')"));
    assert.ok(server.indexOf("require('./src/25-runtime')") > server.indexOf("require('./src/24-ad-ops')"), 'the runtime stays last');
    const page = fs.readFileSync(path.join(root, 'frontend', 'workspace.html'), 'utf8');
    assert.ok(page.indexOf('<script src="ui.js"></script>') < page.indexOf('<script src="ad-ops.js"></script>'));
    for (const t of ["['checkin', 'Ads check-in']", "['orders', 'Orders']", 'results.html']) assert.ok(page.includes(t), t);
    const sql = fs.readFileSync(path.join(root, 'sql', 'schema-phase87.sql'), 'utf8');
    for (const t of ['client_orders', 'client_ad_decisions', 'client_ad_economics', 'xp_ad_reach_windows', 'add column if not exists thruplays', 'add column if not exists components', 'add column if not exists disable_reason'])
        assert.ok(sql.includes(t), t);
    assert.ok(!/phone\s+text/.test(sql), 'no phone column');
    for (const t of ['client_orders', 'client_ad_decisions']) assert.ok(S.MERGE_TABLES.includes(t), t);
});

(async () => {
    for (const [name, fn] of tests) {
        try { await fn(); passed++; console.log('  ok   ' + name); }
        catch (e) { console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); process.exitCode = 1; }
    }
    console.log(`\n${passed} passed`);
    process.exit();
})();
