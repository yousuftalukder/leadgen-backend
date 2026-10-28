#!/usr/bin/env node
/**
 * Phase 69 offline tests — the client's workbook: the content plan, the ad
 * ledger with products and stock, and message templates.
 *
 * What matters: a row is checked field by field on the server, so a page cannot
 * write another client's id, a negative stock, a date that is not a date or a
 * link that is not a link; an empty row is refused; the tool's content plan is
 * turned into ideas without being written anywhere; and rows pasted from a
 * Google Sheet land in the right columns (day-first dates, "Stock out", "1,490").
 *
 *   node tests/phase69.test.js
 */
'use strict';
const assert = require('assert');
const Module = require('module');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

// ---- stubs -----------------------------------------------------------------
const chain = () => {
    const p = Promise.resolve({ data: null, error: null, count: 0 });
    const h = new Proxy(function () {}, {
        get: (_, k) => (k === 'then' ? p.then.bind(p) : k === 'catch' ? p.catch.bind(p) : k === 'finally' ? p.finally.bind(p) : () => h),
        apply: () => h
    });
    return h;
};
const routes = [];
const stubs = {
    express: Object.assign(() => ({
        set() {}, use() {}, listen() {},
        get: p => routes.push('GET ' + p), post: p => routes.push('POST ' + p), patch: p => routes.push('PATCH ' + p),
        delete: p => routes.push('DELETE ' + p), put: p => routes.push('PUT ' + p)
    }), { json: () => (_, __, n) => n && n(), raw: () => (_, __, n) => n && n(), static: () => () => {} }),
    cors: () => () => {},
    'apify-client': { ApifyClient: class {} },
    '@supabase/supabase-js': { createClient: () => ({ from: chain, rpc: chain, auth: { getUser: async () => ({ data: null, error: new Error('stub') }) } }) },
    dotenv: { config() {} }
};
const realLoad = Module._load;
Module._load = function (req, ...rest) { return stubs[req] !== undefined ? stubs[req] : realLoad.call(this, req, ...rest); };
process.env.SUPABASE_URL = 'http://stub'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';

require(path.join(__dirname, '..', 'server.js'));
const S = require(path.join(__dirname, '..', 'src', 'shared'));
let passed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; } }
const refuses = (fn, re) => assert.throws(fn, e => e.statusCode === 400 && (!re || re.test(e.message)), 'expected a 400' + (re ? ' matching ' + re : ''));
const { wbClean, wbIdeas, WB_KINDS } = S;

console.log('phase 69 :: a content plan row');
test('a row from the sheet is kept as typed', () => {
    const r = wbClean('content', { planned_on: '2026-10-28', platform: 'Facebook', post_type: 'Video reel', idea: 'seven sleep balm only product' }, { create: true });
    assert.deepStrictEqual(
        { planned_on: r.planned_on, platform: r.platform, post_type: r.post_type, idea: r.idea, status: r.status, caption: r.caption },
        { planned_on: '2026-10-28', platform: 'Facebook', post_type: 'Video reel', idea: 'seven sleep balm only product', status: 'planned', caption: null });
});
test('a new row starts as planned', () => assert.strictEqual(wbClean('content', { idea: 'x' }, { create: true }).status, 'planned'));
test('an empty row is refused', () => refuses(() => wbClean('content', { platform: 'Facebook' }, { create: true }), /date or a description/));
test('a date that is not a date is refused', () => {
    refuses(() => wbClean('content', { planned_on: '31/10/2026', idea: 'x' }, { create: true }), /date/);
    refuses(() => wbClean('content', { planned_on: '2026-02-30', idea: 'x' }, { create: true }), /date/);
});
test('the status is one of four', () => refuses(() => wbClean('content', { idea: 'x', status: 'published' }, { create: true }), /Status/));
test('an edit cannot blank the status', () => refuses(() => wbClean('content', { status: '' }), /choose one/));
test('a post link must be http(s)', () => {
    refuses(() => wbClean('content', { idea: 'x', posted_url: 'javascript:alert(1)' }, { create: true }), /link/);
    assert.strictEqual(wbClean('content', { idea: 'x', posted_url: 'https://facebook.com/p/1' }, { create: true }).posted_url, 'https://facebook.com/p/1');
});
test('line breaks in a description stay; control characters go', () =>
    assert.strictEqual(wbClean('content', { idea: 'one\r\ntwo\u0007' }, { create: true }).idea, 'one\ntwo'));
test('a description over 4000 characters is refused, not cut', () => refuses(() => wbClean('content', { idea: 'x'.repeat(4001) }, { create: true }), /4000/));
test('an edit returns only the fields sent', () => assert.deepStrictEqual(wbClean('content', { status: 'posted' }), { status: 'posted' }));
test('client_id, created_by and the dates cannot be written', () => {
    const r = wbClean('content', { idea: 'x', client_id: '00000000-0000-0000-0000-000000000000', created_by: 'me', created_at: '2020-01-01', id: 'x' }, { create: true });
    for (const k of ['client_id', 'created_by', 'created_at', 'id']) assert.ok(!(k in r), k);
});

console.log('phase 69 :: products and stock');
test('prices and counts as people type them', () => {
    const r = wbClean('products', { name: 'Cathy Doll Bright Sakura Body Lotion', stock: '3', cost: '392', price: '1,600', combo_price: '৳1250', in_order: '' }, { create: true });
    assert.strictEqual(r.stock, 3); assert.strictEqual(r.cost, 392); assert.strictEqual(r.price, 1600); assert.strictEqual(r.combo_price, 1250); assert.strictEqual(r.in_order, null);
});
test('0 in hand is kept (stock out), empty is "not counted"', () => {
    assert.strictEqual(wbClean('products', { name: 'a', stock: 0 }, { create: true }).stock, 0);
    assert.strictEqual(wbClean('products', { name: 'a', stock: '' }, { create: true }).stock, null);
});
test('a product needs a name', () => refuses(() => wbClean('products', { stock: 4 }, { create: true }), /Product name/));
test('negative or fractional stock is refused', () => {
    refuses(() => wbClean('products', { name: 'a', stock: -1 }, { create: true }), /whole number/);
    refuses(() => wbClean('products', { name: 'a', stock: '2.5' }, { create: true }), /whole number/);
    refuses(() => wbClean('products', { name: 'a', stock: 'Stock out' }, { create: true }), /whole number/);
});
test('prices keep two decimals', () => assert.strictEqual(wbClean('products', { name: 'a', price: '99.999' }, { create: true }).price, 100));
test('a negative price is refused', () => refuses(() => wbClean('products', { name: 'a', price: '-5' }, { create: true }), /amount/));

console.log('phase 69 :: the ad ledger');
const UUID = '6f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f';
test('a creative lists products by id, without repeats', () => {
    const r = wbClean('creatives', { title: 'Reel | Combo 4+6', product_ids: [UUID, UUID.toUpperCase()] }, { create: true });
    assert.deepStrictEqual(r.product_ids, [UUID]);
});
test('a product id that is not an id is refused', () => refuses(() => wbClean('creatives', { title: 'x', product_ids: ['1'] }, { create: true }), /valid id/));
test('a planned ad needs a creative or a campaign name', () => {
    refuses(() => wbClean('ads', { status: 'planned', budget: 500 }, { create: true }), /creative|campaign/);
    assert.strictEqual(wbClean('ads', { status: 'planned', campaign: 'Black Friday', budget: 500 }, { create: true }).budget, 500);
});
test('an ad is done unless said otherwise', () => assert.strictEqual(wbClean('ads', { creative_id: UUID }, { create: true }).status, 'done'));
test('an ad cannot end before it starts', () => refuses(() => wbClean('ads', { creative_id: UUID, start_on: '2026-10-10', end_on: '2026-10-01' }, { create: true }), /end date/));
test('results are whole numbers, spend an amount', () => {
    const r = wbClean('ads', { creative_id: UUID, spend: '1,200.50', messages: '42', orders: '7', revenue: '9800' }, { create: true });
    assert.deepStrictEqual([r.spend, r.messages, r.orders, r.revenue], [1200.5, 42, 7, 9800]);
});
test('the verdict is one of four', () => refuses(() => wbClean('ads', { creative_id: UUID, verdict: 'Great' }, { create: true }), /Verdict/));

console.log('phase 69 :: message templates');
test('a template keeps its line breaks and emoji', () => {
    const r = wbClean('templates', { title: 'Price', body: 'Hi 😊\nPrice: 1250 tk\nDelivery: 60 tk' }, { create: true });
    assert.strictEqual(r.body, 'Hi 😊\nPrice: 1250 tk\nDelivery: 60 tk');
});
test('a template with only pictures is fine; with nothing it is refused', () => {
    assert.deepStrictEqual(wbClean('templates', { title: 'Price list', media_ids: [UUID] }, { create: true }).media_ids, [UUID]);
    refuses(() => wbClean('templates', { title: 'Empty' }, { create: true }), /message|picture/);
});
test('six pictures at most', () => {
    const ids = Array.from({ length: 7 }, (_, i) => `6f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5${i}`);
    refuses(() => wbClean('templates', { title: 't', media_ids: ids }, { create: true }), /6 at most/);
});
test('an unknown kind is a 404', () => assert.throws(() => wbClean('invoices', {}, { create: true }), e => e.statusCode === 404));

console.log('phase 69 :: ideas from the tool\'s content plan');
const plan = {
    id: 'r1', created_at: '2026-10-01T00:00:00Z', platform: 'instagram', target_handle: 'arminabd', ai_summary: 'old summary',
    format_spec: [{ key: 'Reel', plural: 'reels' }, { key: 'Carousel', plural: 'carousels' }],
    ai_json: {
        summary: 'Reels with a product close-up win.',
        reels: [{ hook: 'Siang oil in 10 seconds', concept: 'Close-up pour', caption: 'Shop now', script: ['Pour', { line: 'Show the label' }], why: 'Top 3 posts were close-ups', evidence: ['https://x'] }],
        carousels: [{ concept: 'Before and after' }],
        stopDoing: ['Long captions'], captionRules: [{ text: 'Price in the first line' }]
    }
};
test('every brief becomes an idea with its format', () => {
    const p = wbIdeas(plan);
    assert.strictEqual(p.briefs.length, 2);
    assert.deepStrictEqual(p.briefs.map(b => b.format), ['Reel', 'Carousel']);
    assert.deepStrictEqual(p.briefs[0].script, ['Pour', 'Show the label']);
    assert.strictEqual(p.summary, 'Reels with a product close-up win.');
    assert.deepStrictEqual(p.stopDoing, ['Long captions']);
    assert.deepStrictEqual(p.captionRules, ['Price in the first line']);
});
test('a plan without a format list falls back to reels, carousels, stills', () =>
    assert.strictEqual(wbIdeas({ ...plan, format_spec: null }).briefs.length, 2));
test('a plan with no briefs gives no ideas, not an error', () => assert.deepStrictEqual(wbIdeas({ id: 'r', ai_json: null }).briefs, []));
test('an older plan with its briefs in report_json reads the same', () =>
    assert.strictEqual(wbIdeas({ ...plan, ai_json: null, briefs: plan.ai_json }).briefs.length, 2));

console.log('phase 69 :: rows pasted from a sheet (client-tools.js)');
const sandbox = { window: {}, EL: { esc: v => String(v), icon: () => '' }, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'frontend', 'client-tools.js'), 'utf8'), sandbox);
const T = sandbox.window.Tools;
test('the content sheet from the screenshot maps column by column', () => {
    const text = [
        'Timestamp\tWhich date you want the post\tWhich platform it goes on\twhat type of post\tWrite a short description of the script or the idea or the vision that you want to create the post with',
        '\t27/10/2026\tFacebook\tStatics\tsiang oil',
        '\t28/10/2026\tFacebook\tvedio reel\tseven sleep balm  only product',
        '\t01/11/2026\tFacebook\tvedio reel\tCustomer review, last month sell',
        '\t\t\t\t'
    ].join('\n');
    const m = T.mapSheet('content', T.parseSheet(text));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(m.cols.map(c => c.k))), [null, 'planned_on', 'platform', 'post_type', 'idea']);
    assert.strictEqual(m.items.length, 3);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(m.items[0])), { planned_on: '2026-10-27', platform: 'Facebook', post_type: 'Statics', idea: 'siang oil' });
    assert.strictEqual(m.items[2].planned_on, '2026-11-01');
});
test('the stock sheet from the screenshot maps column by column', () => {
    const text = [
        'SL\tProduct name\tQuantity\tIn Order\tBuying Price\tCustomer Price\tComboo Price',
        '1\tLoreal Paris Elseve Glycolic Gloss Conditioner\t\t\t\t1490\t',
        '3\tCathy Doll Bright Sakura Body Lotion (Glutathione & Vitamin B3)\t3\t\t392\t1600\t1250',
        '4\tChoops Me Fruity Velvet Tint\tStock out\t\t\t320\t',
        '20\t\t\t\t\t\t'
    ].join('\n');
    const m = T.mapSheet('products', T.parseSheet(text));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(m.cols.map(c => c.k))), [null, 'name', 'stock', 'in_order', 'cost', 'price', 'combo_price']);
    assert.strictEqual(m.items.length, 3);
    assert.strictEqual(m.skipped, 1, 'the numbered row with no product is left out');
    assert.strictEqual(m.items[1].combo_price, '1250');
    assert.strictEqual(m.items[2].stock, '0', '"Stock out" is 0');
    // and the server takes what the page sends
    const r = wbClean('products', m.items[1], { create: true });
    assert.deepStrictEqual([r.stock, r.cost, r.price, r.combo_price], [3, 392, 1600, 1250]);
});
test('a CSV with quoted cells and new lines inside a cell', () => {
    const rows = T.parseSheet('Date,Description\n2026-10-30,"offer, sell\nposter"\n');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(rows)), [['Date', 'Description'], ['2026-10-30', 'offer, sell\nposter']]);
});
test('dates are read day first, ISO passes through', () => {
    assert.strictEqual(T.sheetDate('31/10/2026'), '2026-10-31');
    assert.strictEqual(T.sheetDate('1.11.26'), '2026-11-01');
    assert.strictEqual(T.sheetDate('2026-10-27'), '2026-10-27');
});
test('an idea from the tool becomes the start of a typed row', () => {
    const r = T.ideaToRow({ format: 'Reel', hook: 'Hook', concept: 'Concept', script: ['a', 'b'], caption: 'Cap' });
    assert.strictEqual(r.post_type, 'Video reel');
    assert.strictEqual(r.idea, 'Hook\n\nConcept\n\n1. a\n2. b');
    assert.strictEqual(r.caption, 'Cap');
});

console.log('phase 69 :: the schema, the server and the pages agree');
const root = path.join(__dirname, '..');
const sql = fs.readFileSync(path.join(root, 'sql', 'schema-phase69.sql'), 'utf8');
test('every table the server writes is created, with row level security', () => {
    const tables = [...Object.values(WB_KINDS).map(k => k.table), 'client_template_media'];
    for (const t of tables) {
        assert.ok(new RegExp(`create table if not exists public\\.${t} `).test(sql), 'create ' + t);
        assert.ok(new RegExp(`${t}\\s+enable row level security`).test(sql), 'rls ' + t);
    }
});
test('every column the server writes is in the SQL', () => {
    for (const k of Object.values(WB_KINDS)) {
        const block = sql.slice(sql.indexOf(`public.${k.table} (`));
        const body = block.slice(0, block.indexOf(');'));
        // A column a later phase added (phase 78: content_entry_id) is in that phase's SQL instead.
        const later = fs.readdirSync(path.join(root, 'sql')).filter(n => /^schema-phase\d+\.sql$/.test(n) && Number(n.match(/\d+/)[0]) > 69)
            .map(n => fs.readFileSync(path.join(root, 'sql', n), 'utf8')).join('\n');
        for (const col of Object.keys(k.fields)) assert.ok(new RegExp(`\\n\\s+${col}\\s`).test(body)
            || new RegExp(`alter table public\\.${k.table}\\s+add column if not exists ${col}\\s`).test(later), `${k.table}.${col}`);
    }
});
test('a merged client brings its workbook along', () => {
    for (const t of [...Object.values(WB_KINDS).map(k => k.table), 'client_template_media']) assert.ok(S.MERGE_TABLES.includes(t), t);
});
test('the routes are registered before the /api catch-all', () => {
    for (const r of ['GET /api/clients/:id/workbook', 'POST /api/clients/:id/workbook/:kind', 'PATCH /api/clients/:id/workbook/:kind/:rowId',
        'DELETE /api/clients/:id/workbook/:kind/:rowId', 'POST /api/clients/:id/template-media', 'GET /api/clients/:id/workbook-ideas']) assert.ok(routes.includes(r), r);
    const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    assert.ok(server.indexOf("require('./src/22-client-workbook')") < server.indexOf("require('./src/24-runtime')"));
});
const page = fs.readFileSync(path.join(root, 'frontend', 'workspace.html'), 'utf8');
test('the client page loads the tools and has the three tabs', () => {
    assert.ok(page.indexOf('<script src="ui.js"></script>') < page.indexOf('<script src="client-tools.js"></script>'));
    for (const [k, l] of [['content', 'Content plan'], ['ledger', 'Ad ledger'], ['replies', 'Message templates']]) {
        assert.ok(page.includes(`['${k}', '${l}']`), l);
        assert.ok(new RegExp(`${k}: tab\\w+`).test(page), k + ' is drawn');
    }
});

console.log(`\n${passed} passed`);
