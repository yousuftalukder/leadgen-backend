#!/usr/bin/env node
/**
 * Phase 85 tests — the ad brief and the ad plan.
 *
 * What matters: the brief page brings the business, its products and margins,
 * its audience, its past ad sets as they were set up beside what they returned,
 * the splits by audience, the team's ledger and benchmarks together for the
 * agency only; benchmarks are medians over three or more businesses the person
 * could open anyway, never the business itself; what is typed is checked and
 * labelled; a plan is a draft until the client's owner or an admin decides;
 * the ads sync reads ad set settings and splits, with budgets out of cents;
 * before the phase-85 SQL the brief says what to run.
 *
 *   node tests/phase85.routes.test.js
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
function query(table) {
    const filters = [];
    let op = 'select', payload = null, conflict = null, single = false, head = false, wantCount = false, limit = null, orders = [], returning = false;
    const q = {
        select(_c, opts = {}) { if (op !== 'select') returning = true; head = !!opts.head; wantCount = !!opts.count; return q; },
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
        not() { return q; },
        order(c, o = {}) { orders.push([c, o.ascending !== false]); return q; },
        limit(n) { limit = n; return q; },
        maybeSingle() { single = true; return q; },
        single() { single = true; return q; },
        then(ok, no) { return Promise.resolve().then(run).then(ok, no); }
    };
    function run() {
        if (MISSING.has(table)) return { data: null, error: { code: '42P01', message: `relation "${table}" does not exist` } };
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
require(path.join(__dirname, '..', 'server.js'));
const S = require(path.join(__dirname, '..', 'src', 'shared'));
const ADS = require(path.join(__dirname, '..', 'xp', 'ingest', 'ads.js'));

// ---- people, businesses, ads ----
const BOSS = newId(), EDITOR = newId(), VIEWER = newId(), OWNER = newId(), OTHER_AGENCY = newId();
const SHOP = newId(), P1 = newId(), P2 = newId(), P3 = newId(), P4 = newId(), FAR = newId();
const today = new Date().toISOString().slice(0, 10);
const daysAgo = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
function seed() {
    DB = {};
    tbl('app_users').push(
        { id: BOSS, role: 'employee', is_active: true, email: 'boss@agency.test' },
        { id: EDITOR, role: 'employee', is_active: true, email: 'ed@agency.test' },
        { id: VIEWER, role: 'employee', is_active: true, email: 'view@agency.test' },
        { id: OWNER, role: 'client', is_active: true, email: 'owner@shop.test' },
        { id: OTHER_AGENCY, role: 'employee', is_active: true, email: 'x@other.test' });
    const cl = (id, owner, name, niche, location) => ({ id, owner_user_id: owner, name, niche, location, archived: false, competitors: [], created_at: '2026-01-01' });
    tbl('clients').push(
        cl(SHOP, BOSS, 'Rahim Sweets', 'sweet shop', 'Dhaka, Bangladesh'),
        cl(P1, BOSS, 'Mithai Ghar', 'sweets and bakery', 'Dhaka'), cl(P2, BOSS, 'Sweet Corner', 'sweets', 'Dhaka'),
        cl(P3, BOSS, 'Rosogolla House', 'sweets', 'dhaka'), cl(P4, BOSS, 'Shoe Hub', 'shoes', 'Dhaka'),
        cl(FAR, OTHER_AGENCY, 'Not Ours Sweets', 'sweets', 'Dhaka'));
    tbl('client_members').push({ client_id: SHOP, user_id: EDITOR, role: 'editor' }, { client_id: SHOP, user_id: VIEWER, role: 'viewer' }, { client_id: SHOP, user_id: OWNER, role: 'editor' });
    tbl('client_products').push({ id: newId(), client_id: SHOP, name: 'Combo box', price: 1200, cost: 700, stock: 40, created_at: '2026-01-02' });
    tbl('xp_meta_assets').push({ id: 'A1', client_id: SHOP, platform: 'IG', asset_id: 'ig1', status: 'ACTIVE' });
    tbl('xp_audience_snapshots').push(
        { asset_id: 'A1', snapshot_date: daysAgo(3), audience_type: 'FOLLOWERS', dimension: 'age_gender', breakdown: { '25-34|F': 600, '18-24|F': 300, '25-34|M': 100 } },
        { asset_id: 'A1', snapshot_date: daysAgo(10), audience_type: 'FOLLOWERS', dimension: 'age_gender', breakdown: { 'old|F': 1 } });
    tbl('xp_meta_ad_accounts').push({ ad_account_id: 'act_1', client_id: SHOP, name: 'Rahim ads', currency: 'BDT', last_synced_at: today });
    tbl('xp_meta_ad_campaigns').push({ campaign_id: 'cmp1', client_id: SHOP, name: 'Eid', objective: 'OUTCOME_ENGAGEMENT', start_time: daysAgo(40) });
    tbl('xp_meta_ad_sets').push({
        adset_id: 'as1', client_id: SHOP, ad_account_id: 'act_1', campaign_id: 'cmp1', name: 'Women Dhaka', status: 'ACTIVE', optimization_goal: 'CONVERSATIONS',
        destination_type: 'MESSENGER', daily_budget: 800, currency: 'BDT', start_time: daysAgo(40),
        targeting: { geo_locations: { cities: [{ name: 'Dhaka', radius: 10, distance_unit: 'kilometer' }] }, genders: [2], age_min: 22, age_max: 40,
            flexible_spec: [{ interests: [{ name: 'Desserts' }, { name: 'Bakery' }] }], publisher_platforms: ['instagram'], instagram_positions: ['reels'] }
    });
    tbl('xp_meta_ads').push({ ad_id: 'ad1', adset_id: 'as1', client_id: SHOP, ad_account_id: 'act_1' }, { ad_id: 'ad2', adset_id: 'as1', client_id: SHOP, ad_account_id: 'act_1' });
    tbl('xp_ad_daily_snapshots').push(
        { ad_id: 'ad1', client_id: SHOP, metric_date: daysAgo(5), currency: 'BDT', spend: 500, impressions: 10000, link_clicks: 100, messages_started: 25, purchases: 2, purchase_value: 2400 },
        { ad_id: 'ad2', client_id: SHOP, metric_date: daysAgo(4), currency: 'BDT', spend: 300, impressions: 5000, link_clicks: 50, messages_started: 15, purchases: 0, purchase_value: 0 },
        // peers: cost per message 10, 20, 30, and an outsider at 1 that must not count
        { ad_id: 'p1', client_id: P1, metric_date: daysAgo(5), currency: 'BDT', spend: 100, impressions: 1000, link_clicks: 10, messages_started: 10 },
        { ad_id: 'p2', client_id: P2, metric_date: daysAgo(5), currency: 'BDT', spend: 200, impressions: 1000, link_clicks: 10, messages_started: 10 },
        { ad_id: 'p3', client_id: P3, metric_date: daysAgo(5), currency: 'BDT', spend: 300, impressions: 1000, link_clicks: 10, messages_started: 10 },
        { ad_id: 'p4', client_id: P4, metric_date: daysAgo(5), currency: 'BDT', spend: 1, impressions: 1000, link_clicks: 10, messages_started: 10 },
        { ad_id: 'f1', client_id: FAR, metric_date: daysAgo(5), currency: 'BDT', spend: 10, impressions: 1000, link_clicks: 10, messages_started: 10 });
    tbl('xp_ad_breakdowns').push(
        { adset_id: 'as1', client_id: SHOP, dimension: 'age_gender', segment: '25-34|female', spend: 400, impressions: 8000, link_clicks: 80, messages_started: 30 },
        { adset_id: 'as1', client_id: SHOP, dimension: 'age_gender', segment: '35-44|female', spend: 400, impressions: 7000, link_clicks: 70, messages_started: 10 });
}

const signIn = (token, id) => {
    const u = tbl('app_users').find(x => x.id === id);
    S._authCache.set(S.tokenHash(token), { ctx: { user: { id, email: u.email }, profile: { ...u, paid_until: '2099-01-01T00:00:00Z' } }, t: Date.now() });
};
async function call(method, route, { who = BOSS, params = {}, body = {} } = {}) {
    signIn('t-' + who, who);
    const h = ROUTES[method + ' ' + route];
    assert.ok(h, 'no route ' + method + ' ' + route);
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await h({ headers: { authorization: 'Bearer t-' + who }, params: { id: SHOP, ...params }, body, query: {} }, res);
    return res;
}

// ---- checking what is typed ----
test('the brief keeps only what it knows, and says which field is wrong', () => {
    const b = S.cleanBrief({ goal: 'messages', monthly_budget: '30,000', currency: 'bdt', order_channels: ['whatsapp', 'whatsapp', 'messenger'], offer: '  Eid   combo ', hack: 'x' });
    assert.deepStrictEqual(b, { goal: 'messages', monthly_budget: 30000, currency: 'BDT', order_channels: ['whatsapp', 'messenger'], offer: 'Eid combo' });
    assert.throws(() => S.cleanBrief({ goal: 'world peace' }), /^Error: Goal: one of/);
    assert.throws(() => S.cleanBrief({ order_channels: ['fax'] }), /How orders come in: only/);
    assert.throws(() => S.cleanBrief({ offer_ends: 'soon' }), /Offer ends: a date/);
    assert.throws(() => S.cleanBrief([]), /Send the brief/);
});
test('a plan is checked down to each ad set, by number', () => {
    const p = S.cleanPlan({ objective: 'Messages', total_budget: '1000', ad_sets: [{ name: 'A', age_min: 22, age_max: 40, genders: 'female' }, {}], creatives: [{ format: 'Reel', hook: 'Hi' }] });
    assert.strictEqual(p.ad_sets.length, 1, 'an empty ad set is dropped');
    assert.strictEqual(p.total_budget, 1000);
    assert.throws(() => S.cleanPlan({ ad_sets: [{ name: 'A' }, { age_min: 70 }] }), /Ad sets 2, Youngest age: a whole number from 13 to 65/);
    assert.throws(() => S.cleanPlan({ ad_sets: [{ age_min: 40, age_max: 20 }] }), /Ad sets 1, Youngest age: it is above the oldest/);
    assert.throws(() => S.cleanPlan({ start_on: '2026-12-10', end_on: '2026-12-01' }), /End: it comes before the start/);
    assert.throws(() => S.cleanPlan({ ad_sets: new Array(7).fill({ name: 'x' }) }), /Ad sets: 6 at most/);
    assert.throws(() => S.cleanPlan({ objective: 'Win' }), /Campaign objective: one of/);
});
test('targeting reads as plain lines', () => {
    const lines = S.targetingLines({ geo_locations: { cities: [{ name: 'Dhaka', radius: 10, distance_unit: 'kilometer' }] }, genders: [2], age_min: 22, age_max: 40,
        flexible_spec: [{ interests: [{ name: 'Desserts' }, { name: 'Bakery' }] }], publisher_platforms: ['instagram'], instagram_positions: ['reels'] });
    assert.deepStrictEqual(lines, ['Where: Dhaka +10 km', 'Who: women, 22–40', 'Interests: Desserts or Bakery', 'Placements: instagram (instagram reels)']);
    assert.deepStrictEqual(S.targetingLines({}), ['Who: everyone, 18–65+', 'Placements: Advantage+ (all)']);
});
test('peers: same kind and city first, then the same kind, then the same city', () => {
    const me = { niche: 'sweet shop', location: 'Dhaka, BD' };
    const lv = S.benchmarkPeers(me, [{ id: 1, niche: 'sweets', location: 'Dhaka' }, { id: 2, niche: 'Sweets & cakes', location: 'Sylhet' }, { id: 3, niche: 'shoes', location: 'dhaka' }]);
    assert.deepStrictEqual(lv.map(l => l.ids), [[1], [1, 2], [1, 3]], '"sweets" is a sweet shop; "shoes" is not');
    assert.strictEqual(S.median([3, 1, 2, null]), 2);
    assert.strictEqual(S.median([1, 2, 3, 4]), 2.5);
});

// ---- the brief page ----
test('the brief brings the business, products, audience, ad sets, splits and gaps together', async () => {
    seed();
    const r = await call('GET', '/api/clients/:id/ad-brief');
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    const b = r.body;
    assert.strictEqual(b.client.name, 'Rahim Sweets');
    assert.deepStrictEqual([b.products[0].margin, b.products[0].margin_pct], [500, 41.7]);
    assert.strictEqual(b.audience.length, 1, 'only the latest reading');
    assert.deepStrictEqual(b.audience[0].top[0], { segment: '25-34|F', count: 600, share: 60 });
    const s = b.ads.ad_sets[0];
    assert.deepStrictEqual([s.name, s.campaign, s.optimization_goal, s.daily_budget], ['Women Dhaka', 'Eid', 'CONVERSATIONS', 800]);
    assert.deepStrictEqual([s.results.spend, s.results.messages, s.results.cost_per_message, s.results.roas], [800, 40, 20, 3]);
    assert.ok(s.targeting.includes('Who: women, 22–40'));
    assert.deepStrictEqual(b.ads.splits.age_gender.map(x => [x.segment, x.cost_per_message]), [['25-34|female', 13.33], ['35-44|female', 40]]);
    assert.ok(b.gaps.some(g => /No goal/.test(g)) && b.gaps.some(g => /Ad Library/.test(g)));
    assert.ok(!b.gaps.some(g => /ad account is shared/.test(g)), 'the account is shared and read');
});
test('benchmarks are medians over businesses this person could open, never the business itself', async () => {
    seed();
    const B = (await call('GET', '/api/clients/:id/ad-brief')).body.benchmarks;
    assert.strictEqual(B.level, 'same kind of business, same city');
    assert.strictEqual(B.businesses, 3, 'P1–P3; not the shoe shop, not another agency’s, not itself');
    assert.strictEqual(B.cost_per_message.median, 20);
    const ed = (await call('GET', '/api/clients/:id/ad-brief', { who: EDITOR })).body;
    assert.strictEqual(ed.benchmarks, null, 'an editor of this one client alone has no peers to compare with');
    assert.ok(ed.gaps.some(g => /No benchmark/.test(g)));
});
test('the owner, and anyone not on the client, get nothing', async () => {
    seed();
    assert.strictEqual((await call('GET', '/api/clients/:id/ad-brief', { who: OWNER })).code, 403);
    assert.strictEqual((await call('GET', '/api/clients/:id/ad-brief', { who: OTHER_AGENCY })).code, 404);
    assert.strictEqual((await call('GET', '/api/clients/:id/ad-plans', { who: OWNER })).code, 403);
});
test('the brief is saved by editors, checked, and read back', async () => {
    seed();
    const r = await call('PUT', '/api/clients/:id/ad-brief', { who: EDITOR, body: { brief: { goal: 'messages', monthly_budget: 30000, sell_areas: 'Dhaka' }, observations: 'WhatsApp button on the page.\n\n\n\nNo active ads.' } });
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    const back = (await call('GET', '/api/clients/:id/ad-brief')).body;
    assert.deepStrictEqual([back.brief.goal, back.brief.monthly_budget, back.observations], ['messages', 30000, 'WhatsApp button on the page.\n\nNo active ads.']);
    assert.ok(!back.gaps.some(g => /No goal|budget/.test(g)));
    assert.strictEqual((await call('PUT', '/api/clients/:id/ad-brief', { who: VIEWER, body: { brief: {} } })).code, 404, 'a viewer cannot');
    const bad = await call('PUT', '/api/clients/:id/ad-brief', { who: EDITOR, body: { brief: { pixel: 'maybe' } } });
    assert.strictEqual(bad.code, 400);
    assert.match(bad.body.error, /Meta Pixel on the website/);
    assert.strictEqual((await call('PUT', '/api/clients/:id/ad-brief', { who: EDITOR, body: {} })).code, 400);
});

// ---- plans ----
test('a plan is a draft until the client’s owner decides; a change makes it a draft again', async () => {
    seed();
    const plan = { objective: 'Messages', budget_type: 'daily', total_budget: 1000, ad_sets: [{ name: 'Women 22–40 Dhaka', locations: 'Dhaka +10 km', age_min: 22, age_max: 40, genders: 'female' }] };
    const made = await call('POST', '/api/clients/:id/ad-plans', { who: EDITOR, body: { title: 'Eid messages', plan } });
    assert.strictEqual(made.code, 201, JSON.stringify(made.body));
    const pid = made.body.plan.id, at = { id: SHOP, planId: pid };
    assert.strictEqual(made.body.plan.status, 'draft');
    const edApprove = await call('PATCH', '/api/clients/:id/ad-plans/:planId', { who: EDITOR, params: at, body: { status: 'approved' } });
    assert.strictEqual(edApprove.code, 403);
    assert.strictEqual((await call('PATCH', '/api/clients/:id/ad-plans/:planId', { params: at, body: { status: 'launched' } })).code, 400, 'not before approval');
    const ok = await call('PATCH', '/api/clients/:id/ad-plans/:planId', { params: at, body: { status: 'approved', review_note: 'Go' } });
    assert.deepStrictEqual([ok.body.plan.status, ok.body.plan.decided_by, ok.body.plan.review_note], ['approved', BOSS, 'Go']);
    const changed = await call('PATCH', '/api/clients/:id/ad-plans/:planId', { who: EDITOR, params: at, body: { plan: { ...plan, total_budget: 1500 } } });
    assert.deepStrictEqual([changed.body.plan.status, changed.body.plan.decided_by], ['draft', null]);
    const list = await call('GET', '/api/clients/:id/ad-plans', { who: VIEWER });
    assert.deepStrictEqual([list.body.plans.length, list.body.canEdit, list.body.canDecide], [1, false, false]);
    assert.strictEqual((await call('DELETE', '/api/clients/:id/ad-plans/:planId', { who: VIEWER, params: at })).code, 404);
    assert.strictEqual((await call('DELETE', '/api/clients/:id/ad-plans/:planId', { who: EDITOR, params: at })).code, 200);
    assert.strictEqual(tbl('client_ad_plans').length, 0);
});
test('a plan without a name, or with a wrong field, is refused with the reason', async () => {
    seed();
    assert.strictEqual((await call('POST', '/api/clients/:id/ad-plans', { body: { title: ' ', plan: {} } })).code, 400);
    const r = await call('POST', '/api/clients/:id/ad-plans', { body: { title: 'X', plan: { ad_sets: [{ destination: 'pigeon' }] } } });
    assert.strictEqual(r.code, 400);
    assert.match(r.body.error, /Ad sets 1, Where people go/);
    assert.strictEqual((await call('PATCH', '/api/clients/:id/ad-plans/:planId', { params: { id: SHOP, planId: 'nope' }, body: { title: 'x' } })).code, 404);
});
test('before the phase-85 SQL, the brief says what to run', async () => {
    seed();
    MISSING.add('client_ad_briefs'); MISSING.add('client_ad_plans');
    const a = await call('GET', '/api/clients/:id/ad-brief');
    const b = await call('POST', '/api/clients/:id/ad-plans', { body: { title: 'X', plan: {} } });
    MISSING.clear();
    for (const r of [a, b]) { assert.strictEqual(r.code, 503); assert.match(r.body.error, /schema-phase85\.sql/); }
});

// ---- the ads sync ----
test('the sync reads each ad set’s settings, budgets out of cents, and replaces its splits', async () => {
    seed();
    tbl('xp_ad_breakdowns').push({ adset_id: 'as9', client_id: SHOP, dimension: 'region', segment: 'Gone', spend: 1, updated_at: '2020-01-01' });
    const calls = [];
    const g = {
        async batch(reqs) { return new Map(reqs.map(r => [r.key, { ok: true, body: { id: r.key, name: 'Set ' + r.key, campaign_id: 'cmp1', effective_status: 'ACTIVE', optimization_goal: 'CONVERSATIONS', daily_budget: '80000', bid_amount: '1500', targeting: { age_min: 20 } } }])); },
        async paginate(p, params) {
            calls.push(params.breakdowns);
            if (params.breakdowns === 'region') return [{ adset_id: 'as9', region: 'Dhaka Division', spend: '120.5', impressions: '3000', inline_link_clicks: '40', actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '6' }] }];
            if (params.breakdowns === 'age,gender') return [{ adset_id: 'as9', age: '25-34', gender: 'female', spend: '50' }, { adset_id: 'someone_else', age: '18-24', gender: 'male', spend: '9' }];
            return [{ adset_id: 'as9', publisher_platform: 'instagram', platform_position: 'reels', spend: '10' }];
        }
    };
    const run = { errors: [], err(step, e) { this.errors.push(step + ': ' + e.message); } };
    await ADS.syncAdSets(g, { ad_account_id: 'act_1', currency: 'BDT', timezone_name: 'Asia/Dhaka' }, new Map([['as9', new Set([SHOP])], ['shared', new Set([SHOP, P1])]]), run);
    assert.deepStrictEqual(run.errors, []);
    const s = tbl('xp_meta_ad_sets').find(x => x.adset_id === 'as9');
    assert.deepStrictEqual([s.daily_budget, s.bid_amount, s.client_id, s.optimization_goal], [800, 15, SHOP, 'CONVERSATIONS']);
    assert.ok(!tbl('xp_meta_ad_sets').some(x => x.adset_id === 'shared'), 'an ad set for two businesses belongs to none');
    assert.deepStrictEqual(calls.sort(), ['age,gender', 'publisher_platform,platform_position', 'region']);
    const mine = tbl('xp_ad_breakdowns').filter(x => x.adset_id === 'as9').map(x => [x.dimension, x.segment, x.spend, x.messages_started]).sort();
    assert.deepStrictEqual(mine, [['age_gender', '25-34|female', 50, 0], ['placement', 'instagram|reels', 10, 0], ['region', 'Dhaka Division', 120.5, 6]], 'the old "Gone" region row is replaced');
    assert.strictEqual(ADS.fromMinor('5000', 'JPY'), 5000);
    assert.strictEqual(ADS.segmentOf('placement', {}), 'unknown|unknown');
});

(async () => {
    for (const [name, fn] of tests) {
        try { await fn(); passed++; console.log('  ok   ' + name); }
        catch (e) { console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); process.exitCode = 1; }
    }
    console.log(`\n${passed} passed`);
    process.exit();
})();
