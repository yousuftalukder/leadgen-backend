/**
 * Running a client's ads: economics, the orders log, the decision log and the check-in (phase 87).
 *
 * Part of the EdgeLead server, split out of server.js (phase 55). The parts load in
 * order from server.js and share one namespace, S: what this part needs from an earlier
 * part is unpacked below; anything else from another part is read as S.name when it runs.
 */
'use strict';
const S = require('./shared');
const {
    UUID_RE, app, auth, bearerId, clientAccess, crypto, missingTable, rateLimit, sendErr, staffOnly, supabase
} = S;
Object.assign(S, {
    cleanEconomics, productEconomics, cleanOrder, phoneHash, normalPhone, cleanDecision, figuresOf, chainFor,
    buildCheckin, buildResults, monthWindow
});

// ===========================================================================
// PHASE 87 :: THE WORKSPACE AS THE AD MANAGER'S MEMORY
//
// Ads are reviewed every three days, by a person or by Claude, and whoever
// does it starts with no memory. So the workspace holds what a check-in
// needs (docs/PLAN-AD-OPS.md; the method is .claude/skills/ad-setup/REVIEW.md):
//
//   economics   what an order costs beyond the product (delivery by zone,
//               COD fee, failed parcels, packing), so every product has a
//               break-even ad cost per order and a target of half of it
//   orders      every order with its outcome, where it came from (an ad,
//               organic, a repeat buyer) and whether the buyer is new. Meta
//               counts chats; the business lives on delivered orders
//   decisions   what was changed, why (which step of the chain), the number
//               it should move and when we will know; then the grade and the
//               lesson, tagged by idea so it carries to other clients
//   check-in    GET …/ad-checkin: per ad and ad set, the chain of eight
//               steps with the first broken one flagged, beside the plan's
//               thresholds; stock, spend against the budget, campaigns no plan
//               mentions, account health, decisions due, the whole business
//               day by day, and the month against its forecast
//   results     GET …/results-report: a month for the client, as what we
//               spent, what it sold, and what is next
//
// Nothing here writes to Meta. Order rows are for editors only; the
// check-in and the report show counts and totals, never a buyer.
// ===========================================================================
const LOW_STOCK = 10;                 // as the ad ledger's "Low"
const CHECKIN_DAYS = 3;               // the default period: the last three days
const MAX_SPAN_DAYS = 92;
const LIFE_DAYS = 180;                // an ad's life so far, as far as the sync keeps days
const BUSINESS_DAYS = 30;             // the whole business, day by day
const WEEK = 7;                       // orders are judged weekly
const ORDER_CAP = 20000;              // orders kept per client
const DECISION_CAP = 2000;
const SYNC_STALE_HOURS = 26;          // the sync runs twice a day

const DAY_MS = 864e5;
const isoDay = d => new Date(d).toISOString().slice(0, 10);
const addDays = (day, n) => isoDay(Date.parse(day + 'T00:00:00Z') + n * DAY_MS);
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY_MS);
const r2 = v => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const r1 = v => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const n0 = v => Number(v) || 0;
const has = v => v !== null && v !== undefined && v !== '';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

class Bad extends Error {}
const bad = m => { throw new Bad(m); };

// ---- checking what is typed -------------------------------------------------------------------
function num(v, label, { min = 0, max = 1e10, int = false } = {}) {
    if (!has(v)) return null;
    const n = typeof v === 'number' ? v : Number(String(v).replace(/[,\s৳$]/g, '').replace(/^tk\.?/i, ''));
    if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) bad(`${label}: ${int ? 'a whole number' : 'a number'} from ${min} to ${max}.`);
    return int ? n : Math.round(n * 100) / 100;
}
function line(v, label, max) {
    if (!has(v)) return null;
    if (typeof v !== 'string' && typeof v !== 'number') bad(`${label}: type it as text.`);
    const s = String(v).replace(/\s+/g, ' ').trim();
    if (s.length > max) bad(`${label}: ${max} letters at most.`);
    return s || null;
}
function text(v, label, max) {
    if (!has(v)) return null;
    if (typeof v !== 'string') bad(`${label}: type it as text.`);
    const s = v.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (s.length > max) bad(`${label}: ${max} letters at most.`);
    return s || null;
}
function day(v, label) {
    if (!has(v)) return null;
    const s = String(v).trim();
    if (!DATE_RE.test(s) || isoDay(Date.parse(s + 'T00:00:00Z')) !== s) bad(`${label}: a date like 2026-10-30.`);
    return s;
}
function oneOf(v, label, list) {
    if (!has(v)) return null;
    if (!list.includes(v)) bad(`${label}: one of ${list.join(', ')}.`);
    return v;
}

// ---- economics: what an order costs beyond the product ------------------------------------------
const ECON_DEFAULTS = { delivery_zones: [], cod_fee_pct: 1, fail_rate_pct: 20, fail_loss: 120, packing_cost: 0, notes: null };

/** The economics settings as typed. Every key is optional; what is sent is checked and labelled. */
function cleanEconomics(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) bad('Send the settings.');
    const out = {};
    if (body.delivery_zones !== undefined) {
        const z = body.delivery_zones;
        if (!Array.isArray(z)) bad('Delivery zones: a list.');
        if (z.length > 12) bad('Delivery zones: 12 at most.');
        out.delivery_zones = z.map((x, i) => {
            if (!x || typeof x !== 'object') bad(`Delivery zone ${i + 1}: fill it in.`);
            const name = line(x.name, `Delivery zone ${i + 1}, name`, 60);
            if (!name) bad(`Delivery zone ${i + 1}: give it a name.`);
            return { name, charge: num(x.charge, `${name}, what the customer pays`), courier_cost: num(x.courier_cost, `${name}, what the courier costs`) };
        });
        const names = out.delivery_zones.map(x => x.name.toLowerCase());
        if (new Set(names).size !== names.length) bad('Delivery zones: two have the same name.');
    }
    if (body.cod_fee_pct !== undefined) out.cod_fee_pct = num(body.cod_fee_pct, 'COD fee %', { max: 20 }) ?? ECON_DEFAULTS.cod_fee_pct;
    if (body.fail_rate_pct !== undefined) out.fail_rate_pct = num(body.fail_rate_pct, 'Failed parcels %', { max: 90 }) ?? ECON_DEFAULTS.fail_rate_pct;
    if (body.fail_loss !== undefined) out.fail_loss = num(body.fail_loss, 'Money lost per failed parcel') ?? ECON_DEFAULTS.fail_loss;
    if (body.packing_cost !== undefined) out.packing_cost = num(body.packing_cost, 'Packing cost') ?? ECON_DEFAULTS.packing_cost;
    if (body.notes !== undefined) out.notes = text(body.notes, 'Notes', 2000);
    return out;
}

/**
 * Every product with what an order of it can afford to cost in ads. A combo made of other products
 * takes its buying cost and stock from its parts when it has none of its own. Nothing is invented:
 * a product without a price or a buying cost has no break-even, and says what is missing.
 *
 *   margin            price − buying cost
 *   break-even        margin − COD fee − failed-parcel cost − packing − delivery top-up
 *   failed parcels    (rate ÷ (1 − rate)) × money lost per failed parcel, per delivered order
 *   delivery top-up   the most the business adds to a zone's courier cost beyond what the customer pays
 *   free delivery     break-even − the dearest zone's courier cost
 *   target            half of break-even (the rest is profit and room for error)
 */
function productEconomics(products, econ = {}, { orderRate = null } = {}) {
    const e = { ...ECON_DEFAULTS, ...Object.fromEntries(Object.entries(econ || {}).filter(([, v]) => v !== null && v !== undefined)) };
    const byId = new Map((products || []).map(p => [p.id, p]));
    const zones = Array.isArray(e.delivery_zones) ? e.delivery_zones : [];
    const dearest = zones.length ? Math.max(...zones.map(z => n0(z.courier_cost))) : null;
    const topUp = zones.length ? Math.max(0, ...zones.map(z => (has(z.courier_cost) && has(z.charge) ? n0(z.courier_cost) - n0(z.charge) : 0))) : 0;
    const f = Math.min(0.9, Math.max(0, n0(e.fail_rate_pct) / 100));
    const failCost = f / (1 - f) * n0(e.fail_loss);
    return (products || []).map(p => {
        const parts = (Array.isArray(p.components) ? p.components : []).map(c => ({ ...c, p: byId.get(c.product_id) })).filter(c => c.p && c.p.id !== p.id);
        const combo = parts.length > 0;
        const partCost = combo && parts.every(c => has(c.p.cost)) ? parts.reduce((s, c) => s + n0(c.p.cost) * (n0(c.qty) || 1), 0) : null;
        const cost = has(p.cost) ? Number(p.cost) : partCost;
        const price = has(p.price) ? Number(p.price) : combo && has(p.combo_price) ? Number(p.combo_price) : null;
        const partStock = combo && parts.every(c => has(c.p.stock)) ? Math.min(...parts.map(c => Math.floor(n0(c.p.stock) / (n0(c.qty) || 1)))) : null;
        const stock = combo && partStock !== null ? partStock : has(p.stock) ? Number(p.stock) : null;
        const missing = [];
        if (price === null) missing.push('customer price');
        if (cost === null) missing.push(combo ? 'buying price (of the combo or of every part)' : 'buying price');
        const margin = price !== null && cost !== null ? price - cost : null;
        const cod = price !== null ? price * n0(e.cod_fee_pct) / 100 : null;
        const breakEven = margin !== null ? margin - cod - failCost - n0(e.packing_cost) - topUp : null;
        const freeBreakEven = breakEven !== null && dearest !== null ? breakEven - dearest : null;
        const target = breakEven !== null && breakEven > 0 ? breakEven / 2 : null;
        return {
            id: p.id, name: p.name, combo, parts: parts.map(c => ({ product_id: c.product_id, name: c.p.name, qty: n0(c.qty) || 1 })),
            price: r2(price), cost: r2(cost), cost_from: has(p.cost) ? 'own' : partCost !== null ? 'parts' : null,
            stock, stock_from: combo && partStock !== null ? 'parts' : has(p.stock) ? 'own' : null, in_order: has(p.in_order) ? Number(p.in_order) : null,
            margin: r2(margin), margin_pct: price > 0 && margin !== null ? r1(margin / price * 100) : null,
            cod_fee: r2(cod), failed_parcel_cost: r2(failCost), packing: r2(n0(e.packing_cost)), delivery_top_up: r2(topUp),
            break_even: r2(breakEven), free_delivery_break_even: r2(freeBreakEven),
            target_cost_per_order: r2(target), target_cost_per_message: target !== null && orderRate ? r2(target * orderRate / 100) : null,
            loses_money: breakEven !== null && breakEven <= 0, free_delivery_loses: freeBreakEven !== null && freeBreakEven <= 0,
            missing
        };
    });
}

// ---- orders ---------------------------------------------------------------------------------
const CHANNELS = ['messenger', 'whatsapp', 'instagram_dm', 'website', 'phone', 'walk_in', 'other'];
const SOURCES = ['ad', 'organic', 'repeat', 'unknown'];
const ORDER_STATUS = ['confirmed', 'shipped', 'delivered', 'failed', 'returned', 'cancelled'];
const BUYER = ['new', 'returning'];
const LIVE = s => s !== 'cancelled';                         // an order that was placed and not called off
const SOLD = s => s !== 'cancelled' && s !== 'failed' && s !== 'returned';

/** A phone number as one string of digits, so 01711-000000, +8801711000000 and 8801711000000 are one buyer. */
function normalPhone(v) {
    let d = String(v || '').replace(/\D/g, '');
    if (d.startsWith('00')) d = d.slice(2);
    if (d.length === 13 && d.startsWith('880')) d = '0' + d.slice(3);
    if (d.length === 10 && d.startsWith('1')) d = '0' + d;
    return d.length >= 7 && d.length <= 15 ? d : null;
}
function hashKey() {
    const k = String(process.env.ORDER_HASH_SECRET || process.env.APP_ENCRYPTION_KEY || '').trim();
    return k.length >= 16 ? k : null;
}
/** The buyer as an HMAC of their phone number. Null when there is no number or no secret: the number is never kept. */
function phoneHash(phone, key = hashKey()) {
    const p = normalPhone(phone);
    if (!p || !key) return null;
    return crypto.createHmac('sha256', key).update('order-buyer:' + p).digest('hex').slice(0, 32);
}

/**
 * An order as typed. products: Map(id → product) of this client. A new order gets every field; an edit
 * only the ones sent. The value is the items' total unless it is typed; delivery comes from the zone
 * unless it is typed or free.
 */
function cleanOrder(body, { create = false, products = new Map(), zones = [] } = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) bad('Send the order.');
    const out = {};
    const sent = k => create || body[k] !== undefined;
    if (sent('ordered_on')) out.ordered_on = day(body.ordered_on, 'Order date') || (create ? isoDay(Date.now()) : bad('Order date: a date like 2026-10-30.'));
    if (sent('channel')) out.channel = oneOf(body.channel, 'Came in by', CHANNELS) || 'messenger';
    if (sent('items')) {
        const items = body.items === null || body.items === undefined ? [] : body.items;
        if (!Array.isArray(items)) bad('Items: a list.');
        if (items.length > 30) bad('Items: 30 at most.');
        out.items = items.map((x, i) => {
            if (!x || typeof x !== 'object') bad(`Item ${i + 1}: fill it in.`);
            const id = String(x.product_id || '').toLowerCase();
            if (!UUID_RE.test(id) || !products.has(id)) bad(`Item ${i + 1}: pick one of this client’s products.`);
            const qty = num(x.qty ?? 1, `Item ${i + 1}, quantity`, { min: 1, max: 999, int: true });
            const price = num(x.price, `Item ${i + 1}, price`);
            const p = products.get(id);
            return { product_id: id, qty, price: price ?? (has(p.price) ? Number(p.price) : has(p.combo_price) ? Number(p.combo_price) : null) };
        });
    }
    if (sent('value')) {
        const v = num(body.value, 'Order value');
        out.value = v ?? (out.items ? r2(out.items.reduce((s, x) => s + n0(x.price) * x.qty, 0)) : 0);
    }
    if (sent('free_delivery')) out.free_delivery = body.free_delivery === true || body.free_delivery === 'true' || body.free_delivery === 'yes';
    if (sent('delivery_zone')) out.delivery_zone = line(body.delivery_zone, 'Delivery zone', 60);
    if (sent('delivery_charge')) {
        const c = num(body.delivery_charge, 'Delivery charge');
        const zone = out.delivery_zone && zones.find(z => z.name.toLowerCase() === out.delivery_zone.toLowerCase());
        out.delivery_charge = out.free_delivery ? 0 : c ?? (zone && has(zone.charge) ? Number(zone.charge) : null);
    }
    if (sent('source')) out.source = oneOf(body.source, 'Where it came from', SOURCES) || 'unknown';
    if (sent('ad_id')) {
        const a = has(body.ad_id) ? String(body.ad_id).trim() : '';
        if (a && !/^\d{5,30}$/.test(a)) bad('Ad: the Meta ad id, digits only.');
        out.ad_id = a || null;
    }
    if (sent('status')) out.status = oneOf(body.status, 'Status', ORDER_STATUS) || 'confirmed';
    if (body.status_on !== undefined) out.status_on = day(body.status_on, 'Status date');
    if (sent('buyer_type')) out.buyer_type = oneOf(body.buyer_type, 'Buyer', BUYER);
    if (sent('notes')) out.notes = text(body.notes, 'Notes', 1000);
    if (out.ad_id && out.source && out.source !== 'ad') bad('Ad: only an order from an ad has one. Set “Where it came from” to Ad.');
    if (out.ad_id && !out.source && !create) out.source = 'ad';
    return out;
}

// ---- the decision log ----------------------------------------------------------------------------
const SCOPES = ['account', 'campaign', 'adset', 'ad'];
const OUTCOMES = ['right', 'wrong', 'too_early'];
const IDEA_TYPES = ['opening', 'angle', 'offer', 'audience', 'format', 'budget', 'inbox', 'product', 'other'];
const METRICS = ['cpm', 'stop_scroll', 'watch_through', 'ctr', 'cost_per_message', 'chat_to_order', 'cost_per_order', 'frequency', 'spend', 'orders', 'other'];

function cleanDecision(body, { create = false } = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) bad('Send the decision.');
    const out = {};
    const sent = k => create || body[k] !== undefined;
    if (sent('decided_on')) out.decided_on = day(body.decided_on, 'Date') || (create ? isoDay(Date.now()) : bad('Date: a date like 2026-10-30.'));
    if (sent('scope')) out.scope = oneOf(body.scope, 'What it applies to', SCOPES) || 'account';
    if (sent('scope_id')) {
        const s = has(body.scope_id) ? String(body.scope_id).trim() : '';
        if (s && !/^(act_)?\d{3,30}$/.test(s)) bad('Meta id: digits (an ad, ad set or campaign id).');
        out.scope_id = s || null;
    }
    if (sent('scope_name')) out.scope_name = line(body.scope_name, 'Name', 200);
    if (sent('change')) { out.change = text(body.change, 'What changed', 1000); if (!out.change) bad('What changed: say what was changed.'); }
    if (sent('step')) out.step = has(body.step) ? num(body.step, 'Step of the chain', { min: 1, max: 8, int: true }) : null;
    if (sent('metric')) out.metric = oneOf(body.metric, 'The number it should move', METRICS);
    if (sent('expected')) out.expected = line(body.expected, 'Expected', 300);
    if (sent('check_on')) out.check_on = day(body.check_on, 'When we will know');
    if (body.outcome !== undefined) out.outcome = oneOf(body.outcome, 'Outcome', OUTCOMES);
    if (body.outcome_note !== undefined) out.outcome_note = text(body.outcome_note, 'What happened', 1000);
    if (body.lesson !== undefined) out.lesson = text(body.lesson, 'Lesson', 1000);
    if (body.idea_type !== undefined) out.idea_type = oneOf(body.idea_type, 'Kind of idea', IDEA_TYPES);
    if (body.idea !== undefined) out.idea = line(body.idea, 'The idea', 120);
    if (out.check_on && out.decided_on && out.check_on < out.decided_on) bad('When we will know: it comes before the decision.');
    return out;
}

// ---- figures ------------------------------------------------------------------------------------
const zero = () => ({ spend: 0, impressions: 0, link_clicks: 0, plays: 0, thruplays: 0, thru_known: 0, p100: 0, messages: 0, purchases: 0, purchase_value: 0, orders: 0, delivered: 0, delivered_value: 0, days: 0 });
function addDay(t, r) {
    t.spend += n0(r.spend); t.impressions += n0(r.impressions); t.link_clicks += n0(r.link_clicks);
    t.plays += n0(r.video_plays); t.messages += n0(r.messages_started); t.purchases += n0(r.purchases); t.purchase_value += n0(r.purchase_value);
    if (r.thruplays !== null && r.thruplays !== undefined) { t.thruplays += n0(r.thruplays); t.thru_known += n0(r.video_plays); }
    t.p100 += n0(r.video_p100); t.days += 1;
    return t;
}
function addOrder(t, o) {
    if (!LIVE(o.status)) return t;
    t.orders += 1;
    if (o.status === 'delivered') { t.delivered += 1; t.delivered_value += n0(o.value); }
    return t;
}
const pctOf = (a, b) => (b > 0 ? r1(a / b * 100) : null);
const per = (a, b) => (b > 0 ? r2(a / b) : null);
/** The figures a check-in reads, from summed days (and orders when the client logs them). */
function figuresOf(t, { ordersLogged = false } = {}) {
    const orders = ordersLogged ? t.orders : t.purchases;
    return {
        spend: r2(t.spend), impressions: t.impressions, link_clicks: t.link_clicks, plays: t.plays, thruplays: t.thru_known ? t.thruplays : null,
        messages: t.messages, meta_purchases: t.purchases, meta_purchase_value: r2(t.purchase_value),
        orders: ordersLogged ? t.orders : null, delivered: ordersLogged ? t.delivered : null, delivered_value: ordersLogged ? r2(t.delivered_value) : null,
        orders_from: ordersLogged ? 'log' : 'meta',
        cpm: t.impressions ? r2(t.spend / t.impressions * 1000) : null,
        stop_scroll: t.plays ? pctOf(t.plays, t.impressions) : null,
        watch_through: t.thru_known ? pctOf(t.thruplays, t.thru_known) : null,
        to_the_end: t.plays && t.p100 ? pctOf(t.p100, t.plays) : null,
        ctr: pctOf(t.link_clicks, t.impressions),
        cost_per_message: per(t.spend, t.messages),
        chat_to_order: ordersLogged ? pctOf(t.orders, t.messages) : pctOf(t.purchases, t.messages),
        cost_per_order: orders ? per(t.spend, orders) : null,
        cost_per_delivered: ordersLogged && t.delivered ? per(t.spend, t.delivered) : null
    };
}

// ---- the chain: every 3 days, stop at the first broken step ----------------------------------------
const STEPS = [
    [1, 'Delivering', 'Fix the setting: a rejected ad, a tiny audience, payment or an account limit.'],
    [2, 'Cost to reach (CPM)', 'Broaden the audience, or try new creative. Sale days cost more for everyone.'],
    [3, 'Stop-scroll', 'A new opening for the same video: the first 2 seconds are not stopping people.'],
    [4, 'Watch-through', 'A shorter cut: the middle is slow or the video is too long.'],
    [5, 'Cost per message', 'A clearer offer and button: the promise or the call to action is unclear.'],
    [6, 'Chats → orders', 'The inbox: read 10 chats. Slow replies, price shock, the delivery fee, trust, or the ad and the auto-reply disagree.'],
    [7, 'Cost per order', 'The margin is too low for ads: bundles, or higher-margin products.'],
    [8, 'Fatigue', 'A new version: the same people keep seeing it.']
];
const DEFAULT_STOP_SCROLL = 25;      // REVIEW.md §3: the account's winner
const DEFAULT_MAX_FREQUENCY = 3;     // a week
const MIN_IMPRESSIONS_CPM = 1000;
const MIN_IMPRESSIONS_STOP = 1500;   // REVIEW.md §4
const MIN_PLAYS_WATCH = 300;
const MIN_MESSAGES_ORDERS = 10;

/**
 * One ad's (or ad set's) walk down the chain. Each step is ok, broken, too early (not enough evidence
 * yet) or unknown (no target or no data). The first broken step is what to fix; everything after it
 * is a symptom.
 *   x = { period, week, active, video, frequency }   figures from figuresOf; week for the order steps
 *   t = { max_cpm, normal_cpm, min_stop_scroll, best_watch, cost_per_message, chat_to_order, cost_per_order, max_frequency, orders_known }
 */
function chainFor(x, t) {
    const p = x.period || {}, w = x.week || {};
    const out = [];
    const step = (n, state, value, threshold, why) => out.push({ step: n, name: STEPS[n - 1][1], state, value: value ?? null, threshold: threshold ?? null, why: why || null });
    // 1. delivering
    if (n0(p.spend) > 0) step(1, 'ok', p.spend, null, 'Spending.');
    else if (x.active) step(1, 'broken', 0, null, 'Set to run, but spent nothing in the period.');
    else return { paused: true, steps: [], first: null };
    // 2. CPM
    const maxCpm = t.max_cpm || (t.normal_cpm ? r2(t.normal_cpm * 1.5) : null);
    if (n0(p.impressions) < MIN_IMPRESSIONS_CPM) step(2, 'too_early', p.cpm, maxCpm, `Under ${MIN_IMPRESSIONS_CPM} impressions.`);
    else if (!maxCpm) step(2, 'unknown', p.cpm, null, 'No normal CPM for the account yet, and no limit in the plan.');
    else step(2, p.cpm > maxCpm ? 'broken' : 'ok', p.cpm, maxCpm, t.max_cpm ? 'Against the plan’s highest CPM.' : 'Against 1.5× the account’s CPM over the last 30 days.');
    // 3. stop-scroll (video only)
    const floor = t.min_stop_scroll || DEFAULT_STOP_SCROLL;
    if (!x.video) step(3, 'unknown', null, floor, 'Not a video ad.');
    else if (n0(p.impressions) < MIN_IMPRESSIONS_STOP) step(3, 'too_early', p.stop_scroll, floor, `Under ${MIN_IMPRESSIONS_STOP} impressions.`);
    else step(3, p.stop_scroll < floor ? 'broken' : 'ok', p.stop_scroll, floor, t.min_stop_scroll ? '3-second plays ÷ impressions, against the plan.' : '3-second plays ÷ impressions, against 25% (REVIEW.md).');
    // 4. watch-through (video only)
    const watchFloor = t.best_watch ? r1(t.best_watch * 0.7) : null;
    if (!x.video) step(4, 'unknown', null, watchFloor, 'Not a video ad.');
    else if (p.watch_through === null || p.watch_through === undefined) step(4, 'unknown', null, watchFloor, 'No ThruPlays yet (read from the phase-87 sync on).');
    else if (n0(p.plays) < MIN_PLAYS_WATCH) step(4, 'too_early', p.watch_through, watchFloor, `Under ${MIN_PLAYS_WATCH} plays.`);
    else if (!watchFloor) step(4, 'unknown', p.watch_through, null, 'No other video ad to compare with yet.');
    else step(4, p.watch_through < watchFloor ? 'broken' : 'ok', p.watch_through, watchFloor, 'ThruPlays ÷ 3-second plays, against 70% of the account’s best.');
    // 5. cost per message
    const cpmsg = t.cost_per_message;
    if (!cpmsg) step(5, 'unknown', p.cost_per_message, null, 'No target cost per message in the plan, and no break-even to work one out from.');
    else if (n0(p.spend) < cpmsg * 2) step(5, 'too_early', p.cost_per_message, cpmsg, `Under 2× the target spent (${r2(cpmsg * 2)}).`);
    else step(5, !n0(p.messages) || p.cost_per_message > cpmsg ? 'broken' : 'ok', p.cost_per_message, cpmsg, n0(p.messages) ? 'Spend ÷ messages started.' : 'No messages for 2× the target spent.');
    // 6. chats → orders (a week)
    if (!t.orders_known) step(6, 'unknown', null, t.chat_to_order, 'No orders are logged or created in Messenger for this client.');
    else if (n0(w.messages) < MIN_MESSAGES_ORDERS) step(6, 'too_early', w.chat_to_order, t.chat_to_order, `Under ${MIN_MESSAGES_ORDERS} messages in the last 7 days.`);
    else if (!t.chat_to_order) step(6, 'unknown', w.chat_to_order, null, 'No expected chat → order rate in the plan.');
    else step(6, w.chat_to_order < t.chat_to_order ? 'broken' : 'ok', w.chat_to_order, t.chat_to_order, 'Orders ÷ messages, last 7 days.');
    // 7. cost per order (a week)
    const cpo = t.cost_per_order;
    const ordersW = w.orders_from === 'log' ? n0(w.orders) : n0(w.meta_purchases);
    if (!t.orders_known) step(7, 'unknown', null, cpo, 'No orders to count.');
    else if (!cpo) step(7, 'unknown', w.cost_per_order, null, 'No target cost per order, and no product break-even.');
    else if (n0(w.spend) < cpo * 2) step(7, 'too_early', w.cost_per_order, cpo, `Under 2× the target spent in the last 7 days (${r2(cpo * 2)}).`);
    else step(7, !ordersW || w.cost_per_order > cpo ? 'broken' : 'ok', w.cost_per_order, cpo, ordersW ? 'Spend ÷ orders, last 7 days.' : 'No orders for 2× the target spent.');
    // 8. fatigue
    const maxF = t.max_frequency || DEFAULT_MAX_FREQUENCY;
    if (x.frequency === null || x.frequency === undefined) step(8, 'unknown', null, maxF, 'No 7-day frequency read yet.');
    else step(8, x.frequency > maxF ? 'broken' : 'ok', x.frequency, maxF, 'Average times each person saw it in the last 7 days.');
    const first = out.find(s => s.state === 'broken') || null;
    return { paused: false, steps: out, first: first ? { ...first, next_move: STEPS[first.step - 1][2] } : null };
}

// ---- account health ---------------------------------------------------------------------------------
const ACCOUNT_STATUS = { 1: 'Active', 2: 'Disabled', 3: 'Unpaid balance', 7: 'Under risk review', 8: 'Payment being settled', 9: 'In grace period', 100: 'Closing', 101: 'Closed', 201: 'Active', 202: 'Closed' };
const DISABLE_REASON = { 0: null, 1: 'Ads integrity policy', 2: 'Ads IP review', 3: 'Risk payment', 4: 'Grey account shut down', 5: 'Ads AFC review', 6: 'Business integrity review', 7: 'Permanently closed', 8: 'Unused reseller account', 9: 'Unused account', 10: 'Umbrella ad account', 11: 'Business manager integrity policy', 12: 'Misrepresented ad account', 13: 'AOAB deshare legal entity', 14: 'Ctx thread review', 15: 'Compromised ad account' };

function monthWindow(month) {
    const [y, m] = month.split('-').map(Number);
    const from = `${month}-01`;
    const to = isoDay(Date.UTC(y, m, 0));
    return { from, to, days: Number(to.slice(8)) };
}

/**
 * The check-in, from what was read. Pure, so it can be tested.
 *   d = { today, from, to, client, brief, plans, econ, products, ads, adsets, campaigns, accounts, days, windows,
 *         orders, decisions, runs }
 */
function buildCheckin(d) {
    const { today, from, to } = d;
    const weekFrom = addDays(to, -(WEEK - 1));
    const normalFrom = addDays(to, -29);
    const ordersLogged = (d.orders || []).length > 0;
    const metaOrders = (d.days || []).some(r => n0(r.purchases) > 0);
    const ordersKnown = ordersLogged || metaOrders;

    // the plan: the latest launched one, else the latest approved one
    const plans = (d.plans || []).slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const plan = plans.find(p => p.status === 'launched') || plans.find(p => p.status === 'approved') || null;
    const pp = (plan && plan.plan) || {};

    // what each product can afford
    const forecastRate = has(pp.forecast_order_rate) ? Number(pp.forecast_order_rate) : null;
    const econ = productEconomics(d.products || [], d.econ || {}, { orderRate: forecastRate });
    const targets = econ.map(p => p.target_cost_per_order).filter(v => v !== null).sort((a, b) => a - b);
    const medianTarget = targets.length ? targets[Math.floor((targets.length - 1) / 2)] : null;

    // ad → ad set, campaign; who sold what
    const adInfo = new Map((d.ads || []).map(a => [a.ad_id, a]));
    const setInfo = new Map((d.adsets || []).map(s => [s.adset_id, s]));
    const campInfo = new Map((d.campaigns || []).map(c => [c.campaign_id, c]));
    const ordersByAd = new Map();
    for (const o of d.orders || []) if (o.ad_id) (ordersByAd.get(o.ad_id) || ordersByAd.set(o.ad_id, []).get(o.ad_id)).push(o);

    // sums: per ad and per ad set, for the period, the last 7 days, and the life so far
    const sums = { ad: new Map(), set: new Map() };
    const get = (m, k) => m.get(k) || m.set(k, { period: zero(), week: zero(), life: zero(), normal: zero() }).get(k);
    const total = { period: zero(), week: zero(), normal: zero() };
    const videoAds = new Set();
    for (const r of d.days || []) {
        const a = adInfo.get(r.ad_id) || {};
        const sid = a.adset_id || 'unknown';
        const buckets = [get(sums.ad, r.ad_id), get(sums.set, sid)];
        if (n0(r.video_plays) > 0) videoAds.add(r.ad_id);
        for (const b of buckets) {
            if (r.metric_date <= to) addDay(b.life, r);
            if (r.metric_date >= from && r.metric_date <= to) addDay(b.period, r);
            if (r.metric_date >= weekFrom && r.metric_date <= to) addDay(b.week, r);
            if (r.metric_date >= normalFrom && r.metric_date <= to) addDay(b.normal, r);
        }
        if (r.metric_date >= from && r.metric_date <= to) addDay(total.period, r);
        if (r.metric_date >= weekFrom && r.metric_date <= to) addDay(total.week, r);
        if (r.metric_date >= normalFrom && r.metric_date <= to) addDay(total.normal, r);
    }
    for (const o of d.orders || []) {
        if (!o.ad_id) continue;
        const a = adInfo.get(o.ad_id) || {};
        const buckets = [get(sums.ad, o.ad_id), get(sums.set, a.adset_id || 'unknown')];
        for (const b of buckets) {
            if (o.ordered_on <= to) addOrder(b.life, o);
            if (o.ordered_on >= from && o.ordered_on <= to) addOrder(b.period, o);
            if (o.ordered_on >= weekFrom && o.ordered_on <= to) addOrder(b.week, o);
        }
        if (o.ordered_on >= from && o.ordered_on <= to) addOrder(total.period, o);
        if (o.ordered_on >= weekFrom && o.ordered_on <= to) addOrder(total.week, o);
    }
    const normalCpm = total.normal.impressions >= MIN_IMPRESSIONS_CPM ? total.normal.spend / total.normal.impressions * 1000 : null;
    // the best watch-through of the account's video ads, last 30 days
    const watches = [...sums.ad.entries()].filter(([, s]) => s.normal.thru_known >= MIN_PLAYS_WATCH).map(([, s]) => s.normal.thruplays / s.normal.thru_known * 100);
    const bestWatch = watches.length >= 2 ? Math.max(...watches) : null;

    const T = {
        max_cpm: has(pp.max_cpm) ? Number(pp.max_cpm) : null, normal_cpm: normalCpm,
        min_stop_scroll: has(pp.min_stop_scroll) ? Number(pp.min_stop_scroll) : null, best_watch: bestWatch,
        cost_per_message: has(pp.target_cost) ? Number(pp.target_cost) : (medianTarget !== null && forecastRate ? r2(medianTarget * forecastRate / 100) : null),
        chat_to_order: forecastRate,
        cost_per_order: has(pp.target_cost_per_order) ? Number(pp.target_cost_per_order) : medianTarget,
        max_frequency: has(pp.max_frequency) ? Number(pp.max_frequency) : null,
        orders_known: ordersKnown
    };
    const targetsFrom = {
        cost_per_message: has(pp.target_cost) ? 'plan' : T.cost_per_message !== null ? 'break-even × expected chat → order rate' : null,
        cost_per_order: has(pp.target_cost_per_order) ? 'plan' : T.cost_per_order !== null ? 'half the median product break-even' : null,
        cpm: T.max_cpm ? 'plan' : normalCpm ? '1.5× the account’s CPM, last 30 days' : null,
        stop_scroll: T.min_stop_scroll ? 'plan' : 'REVIEW.md default (25%)',
        frequency: T.max_frequency ? 'plan' : 'REVIEW.md default (3 a week)'
    };

    const windows = new Map((d.windows || []).map(w => [w.ad_id, w]));
    const isActive = (...st) => st.filter(Boolean).every(s => String(s).toUpperCase() === 'ACTIVE') && st.some(Boolean);
    const productName = new Map((d.products || []).map(p => [p.id, p.name]));

    const ads = [...sums.ad.entries()].filter(([, s]) => s.life.days > 0).map(([adId, s]) => {
        const a = adInfo.get(adId) || {}, set = setInfo.get(a.adset_id) || {}, camp = campInfo.get(a.campaign_id || set.campaign_id) || {};
        const win = windows.get(adId);
        const period = figuresOf(s.period, { ordersLogged }), week = figuresOf(s.week, { ordersLogged }), life = figuresOf(s.life, { ordersLogged });
        // An ad's own on/off is not read from Meta, so an ad that spent nothing is taken as paused; a live
        // ad set that spent nothing is what step 1 flags.
        const chain = chainFor({ period, week, active: false, video: videoAds.has(adId), frequency: win ? Number(win.frequency) : null }, T);
        const sold = new Map();
        for (const o of ordersByAd.get(adId) || []) if (LIVE(o.status)) for (const it of o.items || []) sold.set(it.product_id, (sold.get(it.product_id) || 0) + n0(it.qty));
        return {
            ad_id: adId, name: a.name || null, adset_id: a.adset_id || null, adset: set.name || null, campaign_id: a.campaign_id || set.campaign_id || null, campaign: camp.name || null,
            status: set.status || camp.status || null, video: videoAds.has(adId),
            period, week, life, frequency_7d: win ? Number(win.frequency) : null, reach_7d: win ? Number(win.reach) : null,
            paused: chain.paused, chain: chain.steps, first_broken: chain.first,
            sells: [...sold.entries()].map(([pid, q]) => ({ product_id: pid, name: productName.get(pid) || 'Removed product', units: q }))
        };
    }).filter(x => !x.paused || x.life.spend > 0)
        .sort((a, b) => n0(b.period.spend) - n0(a.period.spend) || n0(b.life.spend) - n0(a.life.spend));

    const adsets = [...sums.set.entries()].filter(([sid, s]) => sid !== 'unknown' && s.life.days > 0).map(([sid, s]) => {
        const set = setInfo.get(sid) || {}, camp = campInfo.get(set.campaign_id) || {};
        const mine = ads.filter(a => a.adset_id === sid);
        const freqs = mine.map(a => a.frequency_7d).filter(v => v !== null && Number.isFinite(v));
        const period = figuresOf(s.period, { ordersLogged }), week = figuresOf(s.week, { ordersLogged }), life = figuresOf(s.life, { ordersLogged });
        const chain = chainFor({ period, week, active: isActive(set.status, camp.status), video: mine.some(a => a.video), frequency: freqs.length ? Math.max(...freqs) : null }, T);
        return {
            adset_id: sid, name: set.name || null, campaign: camp.name || null, status: set.status || null,
            daily_budget: set.daily_budget ?? null, lifetime_budget: set.lifetime_budget ?? null,
            period, week, life, highest_frequency_7d: freqs.length ? Math.max(...freqs) : null,
            paused: chain.paused, chain: chain.steps, first_broken: chain.first, ads: mine.length
        };
    }).filter(x => !x.paused || x.life.spend > 0).sort((a, b) => n0(b.period.spend) - n0(a.period.spend));

    // stock: what is left, how fast it sells, and whether an ad sells it
    const soldSince = addDays(to, -13);
    const units = new Map(), adUnits = new Map();
    for (const o of d.orders || []) {
        if (!LIVE(o.status) || o.ordered_on < soldSince || o.ordered_on > to) continue;
        for (const it of o.items || []) {
            units.set(it.product_id, (units.get(it.product_id) || 0) + n0(it.qty));
            if (o.ad_id) adUnits.set(it.product_id, (adUnits.get(it.product_id) || 0) + n0(it.qty));
        }
    }
    const stock = econ.map(p => {
        const perDay = (units.get(p.id) || 0) / 14;
        const daysLeft = p.stock !== null && perDay > 0 ? Math.floor(p.stock / perDay) : null;
        const warning = p.stock === null ? null : p.stock === 0 ? 'out' : p.stock <= LOW_STOCK ? 'low' : daysLeft !== null && daysLeft < 7 ? 'runs_out_soon' : null;
        return { id: p.id, name: p.name, combo: p.combo, stock: p.stock, in_order: p.in_order, sold_14d: units.get(p.id) || 0, sold_by_ads_14d: adUnits.get(p.id) || 0,
            per_day: r1(perDay), days_left: daysLeft, warning };
    }).filter(p => p.warning || p.sold_14d).sort((a, b) => (a.warning ? 0 : 1) - (b.warning ? 0 : 1) || n0(a.days_left ?? 1e9) - n0(b.days_left ?? 1e9));

    // spend this month against the budget
    const month = to.slice(0, 7);
    const mw = monthWindow(month);
    let mtd = 0, mtdMessages = 0, mtdPurchases = 0;
    for (const r of d.days || []) if (r.metric_date >= mw.from && r.metric_date <= to) { mtd += n0(r.spend); mtdMessages += n0(r.messages_started); mtdPurchases += n0(r.purchases); }
    const elapsed = daysBetween(mw.from, to) + 1;
    const budgetMonth = has(d.brief && d.brief.monthly_budget) ? Number(d.brief.monthly_budget) : null;
    const projected = elapsed > 0 ? mtd / elapsed * mw.days : null;
    const budget = {
        month, monthly_budget: budgetMonth, spent: r2(mtd), days_gone: elapsed, days_in_month: mw.days,
        share_spent: budgetMonth ? r1(mtd / budgetMonth * 100) : null, share_of_month: r1(elapsed / mw.days * 100),
        projected: r2(projected), projected_vs_budget: budgetMonth && projected !== null ? r1(projected / budgetMonth * 100) : null,
        state: !budgetMonth ? 'unknown' : projected > budgetMonth * 1.1 ? 'over' : projected < budgetMonth * 0.8 ? 'under' : 'on_track'
    };

    // campaigns in Meta that no plan or ledger row mentions (the owner's own boosts, say)
    const planned = new Set((d.plans || []).flatMap(p => String((p.plan || {}).meta_campaign_ids || '').split(/[\s,;]+/).filter(Boolean)));
    const ledgerNames = [...(d.runs || []).map(r => r.campaign), ...(d.plans || []).map(p => p.title)].map(x => String(x || '').trim().toLowerCase()).filter(Boolean);
    const campSpend = new Map();
    for (const r of d.days || []) if (r.metric_date >= normalFrom && r.metric_date <= to) {
        const cid = r.campaign_id || (adInfo.get(r.ad_id) || {}).campaign_id;
        if (cid) campSpend.set(cid, (campSpend.get(cid) || 0) + n0(r.spend));
    }
    const unplanned = [...campSpend.entries()].filter(([cid, sp]) => sp > 0 && !planned.has(cid)).map(([cid, sp]) => ({ campaign_id: cid, name: (campInfo.get(cid) || {}).name || null, spend_30d: r2(sp), status: (campInfo.get(cid) || {}).status || null }))
        .filter(c => { const n = String(c.name || '').trim().toLowerCase(); return !n || !ledgerNames.some(l => l === n || (l.length >= 6 && (n.includes(l) || l.includes(n)))); })
        .sort((a, b) => b.spend_30d - a.spend_30d);

    // account health
    const now = Date.parse(today + 'T23:59:59Z');
    const health = (d.accounts || []).map(a => {
        const code = a.account_status === null || a.account_status === undefined ? null : Number(a.account_status);
        const stale = !a.last_synced_at || (now - Date.parse(a.last_synced_at)) / 36e5 > SYNC_STALE_HOURS + 24;
        const problems = [];
        if (code !== null && code !== 1 && code !== 201) problems.push(ACCOUNT_STATUS[code] || `Status ${code}`);
        if (a.disable_reason) problems.push(`Reason: ${DISABLE_REASON[a.disable_reason] || a.disable_reason}`);
        if (a.last_error) problems.push(`Last read failed: ${a.last_error}`);
        if (stale) problems.push(a.last_synced_at ? 'Not read for over two days.' : 'Never read.');
        return { name: a.name || a.ad_account_id, status: code === null ? null : ACCOUNT_STATUS[code] || String(code), last_synced_at: a.last_synced_at || null, ok: !problems.length, problems };
    });

    // decisions due for grading
    const due = (d.decisions || []).filter(x => !x.outcome && x.check_on && x.check_on <= today).sort((a, b) => String(a.check_on).localeCompare(String(b.check_on)));
    const open = (d.decisions || []).filter(x => !x.outcome && (!x.check_on || x.check_on > today)).length;

    // the whole business, day by day
    const bizFrom = addDays(to, -(BUSINESS_DAYS - 1));
    const biz = new Map();
    const bday = k => biz.get(k) || biz.set(k, { day: k, orders: 0, ad_orders: 0, delivered: 0, failed: 0, delivered_value: 0, booked_value: 0, spend: 0, messages: 0, meta_purchases: 0 }).get(k);
    for (let k = bizFrom; k <= to; k = addDays(k, 1)) bday(k);
    for (const r of d.days || []) if (r.metric_date >= bizFrom && r.metric_date <= to) { const b = bday(r.metric_date); b.spend += n0(r.spend); b.messages += n0(r.messages_started); b.meta_purchases += n0(r.purchases); }
    for (const o of d.orders || []) {
        if (o.ordered_on < bizFrom || o.ordered_on > to || !LIVE(o.status)) continue;
        const b = bday(o.ordered_on);
        b.orders += 1; if (o.source === 'ad' || o.ad_id) b.ad_orders += 1;
        if (SOLD(o.status)) b.booked_value += n0(o.value);
        if (o.status === 'delivered') { b.delivered += 1; b.delivered_value += n0(o.value); }
        if (o.status === 'failed' || o.status === 'returned') b.failed += 1;
    }
    const bizRow = b => ({ ...b, spend: r2(b.spend), delivered_value: r2(b.delivered_value), booked_value: r2(b.booked_value),
        mer: b.spend > 0 && b.delivered_value ? r2(b.delivered_value / b.spend) : null, cost_per_delivered: per(b.spend, b.delivered), chat_to_order: pctOf(b.ad_orders, b.messages) });
    const daysOut = [...biz.values()].sort((a, b) => a.day.localeCompare(b.day)).map(bizRow);
    const sumBiz = (a, b) => { const s = { orders: 0, ad_orders: 0, delivered: 0, failed: 0, delivered_value: 0, booked_value: 0, spend: 0, messages: 0, meta_purchases: 0 }; daysOut.filter(x => x.day >= a && x.day <= b).forEach(x => Object.keys(s).forEach(k => { s[k] += n0(x[k]); })); return bizRow({ day: null, ...s }); };
    const settled = (d.orders || []).filter(o => ['delivered', 'failed', 'returned'].includes(o.status) && o.ordered_on >= bizFrom && o.ordered_on <= to);
    const business = {
        days: daysOut, period: sumBiz(from, to), last_30: sumBiz(bizFrom, to),
        fail_rate_30: settled.length ? r1(settled.filter(o => o.status !== 'delivered').length / settled.length * 100) : null,
        compare: ordersLogged ? {
            meta_purchases: r2(total.period.purchases), logged_ad_orders: total.period.orders,
            note: Math.abs(total.period.purchases - total.period.orders) > Math.max(2, total.period.orders * 0.3)
                ? 'Meta’s purchase count and the orders logged from ads disagree. Believe the orders log, and check that every order is created in Messenger.' : null
        } : null
    };

    // the month against its forecast
    let mtdOrders = 0, mtdAdOrders = 0;
    for (const o of d.orders || []) if (LIVE(o.status) && o.ordered_on >= mw.from && o.ordered_on <= to) { mtdOrders += 1; if (o.source === 'ad' || o.ad_id) mtdAdOrders += 1; }
    const pace = v => (elapsed > 0 ? r1(v / elapsed * mw.days) : null);
    const fc = (expected, actual) => (has(expected) ? { expected: Number(expected), so_far: r2(actual), pace: pace(actual), expected_by_now: r1(Number(expected) * elapsed / mw.days),
        state: pace(actual) >= Number(expected) * 0.9 ? 'on_track' : 'behind' } : null);
    const forecast = plan && ['forecast_messages', 'forecast_orders', 'forecast_spend', 'forecast_order_rate'].some(k => has(pp[k])) ? {
        month,
        messages: fc(pp.forecast_messages, mtdMessages),
        orders: fc(pp.forecast_orders, ordersLogged ? mtdAdOrders : mtdPurchases),
        spend: fc(pp.forecast_spend, mtd),
        chat_to_order: has(pp.forecast_order_rate) ? { expected: Number(pp.forecast_order_rate), so_far: pctOf(ordersLogged ? mtdAdOrders : mtdPurchases, mtdMessages) } : null,
        orders_from: ordersLogged ? 'log (orders from ads)' : 'Meta purchases'
    } : null;

    // what could not be seen
    const gaps = [];
    if (!(d.accounts || []).length) gaps.push('No Meta ad account is shared with us for this business, so there are no ad figures.');
    if (!ordersLogged) gaps.push(metaOrders ? 'No orders logged here: order figures are Meta’s purchase events only. Log orders in the Orders tab to see delivered orders, failures and repeat buyers.'
        : 'No orders logged and no purchases in Meta: chats → orders and cost per order cannot be judged. Log orders in the Orders tab, or create them in Messenger.');
    if (!plan) gaps.push('No approved or launched ad plan: the thresholds are the defaults from REVIEW.md, and there is no forecast.');
    else {
        if (!has(pp.target_cost)) gaps.push('The plan has no target cost per message.');
        if (!has(pp.target_cost_per_order) && medianTarget === null) gaps.push('No target cost per order: the plan has none, and no product has a break-even.');
        if (!has(pp.forecast_order_rate)) gaps.push('The plan has no expected chat → order rate.');
    }
    const noCost = econ.filter(p => p.missing.length);
    if (noCost.length) gaps.push(`${noCost.length} product${noCost.length === 1 ? ' has' : 's have'} no break-even (missing ${[...new Set(noCost.flatMap(p => p.missing))].join(', ')}).`);
    if (!d.econ) gaps.push('Delivery and costs are not set for this client: COD 1%, 20% failed parcels at 120 each, no packing and no delivery zones are assumed.');
    if (ads.some(a => a.video) && !ads.some(a => a.period.watch_through !== null)) gaps.push('No ThruPlays in the period yet: watch-through is read from the phase-87 sync on.');
    if (!(d.windows || []).length && ads.length) gaps.push('No 7-day frequency read yet: it comes with the next ads sync.');
    if (budgetMonth === null) gaps.push('No monthly ad budget in the brief.');
    gaps.push('Rejected ads and verification warnings are not read from Meta: check Account Quality in Meta Business Suite.');

    return {
        period: { from, to, days: daysBetween(from, to) + 1, week_from: weekFrom },
        plan: plan ? { id: plan.id, title: plan.title, status: plan.status, created_at: plan.created_at } : null,
        targets: { ...T, normal_cpm: r2(normalCpm), best_watch: r1(bestWatch), stop_scroll_default: DEFAULT_STOP_SCROLL, frequency_default: DEFAULT_MAX_FREQUENCY }, targets_from: targetsFrom,
        totals: { period: figuresOf(total.period, { ordersLogged }), week: figuresOf(total.week, { ordersLogged }) },
        ads, adsets,
        broken: ads.filter(a => a.first_broken).map(a => ({ ad_id: a.ad_id, name: a.name, step: a.first_broken.step, step_name: a.first_broken.name, value: a.first_broken.value, threshold: a.first_broken.threshold, next_move: a.first_broken.next_move })),
        economics: econ, stock, budget, unplanned, health,
        decisions_due: due, decisions_open: open,
        business, forecast, gaps,
        steps: STEPS.map(([n, name, move]) => ({ step: n, name, next_move: move }))
    };
}

/**
 * A month for the client: what we spent, what it sold, and what is next. Pure.
 *   d = { month, prev, today, client, days, prevDays, orders, prevOrders, products, plans, decisions, ads }
 */
function buildResults(d) {
    const mw = monthWindow(d.month);
    const ordersLogged = (d.orders || []).length + (d.prevOrders || []).length > 0;
    const sumDays = rows => (rows || []).reduce((t, r) => addDay(t, r), zero());
    const sumOrders = (rows) => {
        const s = { orders: 0, delivered: 0, failed: 0, cancelled: 0, delivered_value: 0, booked_value: 0, from_ads: 0, organic: 0, repeat: 0, new_buyers: 0, returning_buyers: 0 };
        for (const o of rows || []) {
            if (!LIVE(o.status)) { s.cancelled += 1; continue; }
            s.orders += 1;
            if (SOLD(o.status)) s.booked_value += n0(o.value);
            if (o.status === 'delivered') { s.delivered += 1; s.delivered_value += n0(o.value); }
            if (o.status === 'failed' || o.status === 'returned') s.failed += 1;
            if (o.source === 'ad' || o.ad_id) s.from_ads += 1; else if (o.source === 'repeat') s.repeat += 1; else if (o.source === 'organic') s.organic += 1;
            if (o.buyer_type === 'new') s.new_buyers += 1; else if (o.buyer_type === 'returning') s.returning_buyers += 1;
        }
        s.delivered_value = r2(s.delivered_value); s.booked_value = r2(s.booked_value);
        return s;
    };
    const t = sumDays(d.days), pt = sumDays(d.prevDays);
    const o = sumOrders(d.orders), po = sumOrders(d.prevOrders);
    const headline = (ads, ord) => ({
        spend: r2(ads.spend), messages: ads.messages, cost_per_message: per(ads.spend, ads.messages),
        orders: ordersLogged ? ord.orders : ads.purchases, delivered: ordersLogged ? ord.delivered : null, delivered_value: ordersLogged ? ord.delivered_value : r2(ads.purchase_value),
        mer: ads.spend > 0 ? (ordersLogged ? (ord.delivered_value ? r2(ord.delivered_value / ads.spend) : null) : (ads.purchase_value ? r2(ads.purchase_value / ads.spend) : null)) : null,
        cost_per_order: ordersLogged ? per(ads.spend, ord.delivered) : per(ads.spend, ads.purchases),
        chat_to_order: ordersLogged ? pctOf(ord.from_ads, ads.messages) : pctOf(ads.purchases, ads.messages)
    });
    const now = headline(t, o), before = headline(pt, po);
    const change = k => (now[k] !== null && before[k] ? r1((now[k] - before[k]) / before[k] * 100) : null);

    // the ads that sold, best first
    const adName = new Map((d.ads || []).map(a => [a.ad_id, a.name]));
    const byAd = new Map();
    for (const r of d.days || []) { const x = byAd.get(r.ad_id) || byAd.set(r.ad_id, { spend: 0, messages: 0, orders: 0, delivered_value: 0, purchases: 0 }).get(r.ad_id); x.spend += n0(r.spend); x.messages += n0(r.messages_started); x.purchases += n0(r.purchases); }
    for (const x of d.orders || []) if (x.ad_id && LIVE(x.status)) { const y = byAd.get(x.ad_id) || byAd.set(x.ad_id, { spend: 0, messages: 0, orders: 0, delivered_value: 0, purchases: 0 }).get(x.ad_id); y.orders += 1; if (x.status === 'delivered') y.delivered_value += n0(x.value); }
    const topAds = [...byAd.entries()].map(([id, x]) => {
        const orders = ordersLogged ? x.orders : x.purchases;
        return { ad_id: id, name: adName.get(id) || null, spend: r2(x.spend), messages: x.messages, orders, cost_per_message: per(x.spend, x.messages), cost_per_order: per(x.spend, orders) };
    }).filter(x => x.spend > 0 || x.orders).sort((a, b) => b.orders - a.orders || n0(a.cost_per_message ?? 1e9) - n0(b.cost_per_message ?? 1e9)).slice(0, 5);

    const pname = new Map((d.products || []).map(p => [p.id, p.name]));
    const units = new Map();
    for (const x of d.orders || []) if (SOLD(x.status)) for (const it of x.items || []) { const u = units.get(it.product_id) || units.set(it.product_id, { units: 0, value: 0 }).get(it.product_id); u.units += n0(it.qty); u.value += n0(it.qty) * n0(it.price); }
    const topProducts = [...units.entries()].map(([id, u]) => ({ name: pname.get(id) || 'Removed product', units: u.units, value: r2(u.value) })).sort((a, b) => b.units - a.units).slice(0, 5);

    const plans = (d.plans || []).slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const plan = plans.find(p => p.status === 'launched') || plans.find(p => p.status === 'approved') || null;
    const changes = (d.decisions || []).filter(x => x.decided_on >= mw.from && x.decided_on <= mw.to).sort((a, b) => a.decided_on.localeCompare(b.decided_on))
        .map(x => ({ on: x.decided_on, change: x.change, why_step: x.step ? STEPS[x.step - 1][1] : null, expected: x.expected || null, outcome: x.outcome || null, lesson: x.lesson || null }));
    const openChecks = (d.decisions || []).filter(x => !x.outcome && x.check_on).map(x => x.check_on).sort();
    const nextCheck = openChecks.find(x => x >= d.today) || addDays(d.today, CHECKIN_DAYS);

    const words = [];
    if (now.spend) words.push(`We spent ${now.spend} on ads${now.messages ? ` and started ${now.messages} conversations (${now.cost_per_message} each)` : ''}.`);
    if (ordersLogged) {
        if (o.orders) words.push(`${o.orders} orders came in, ${o.from_ads} of them from ads; ${o.delivered} were delivered, worth ${o.delivered_value}.`);
        if (now.mer !== null) words.push(`Every 1 spent on ads came back as ${now.mer} in delivered sales.`);
    } else if (now.orders) words.push(`Meta counted ${now.orders} purchases from the ads.`);
    if (change('cost_per_message') !== null) words.push(`Cost per conversation ${change('cost_per_message') <= 0 ? 'fell' : 'rose'} ${Math.abs(change('cost_per_message'))}% on last month.`);

    return {
        month: d.month, from: mw.from, to: mw.to, client: d.client, orders_from: ordersLogged ? 'log' : 'meta',
        spent_and_sold: now, last_month: before,
        change: { spend: change('spend'), messages: change('messages'), cost_per_message: change('cost_per_message'), orders: change('orders'), delivered_value: change('delivered_value'), mer: change('mer') },
        orders: ordersLogged ? o : null,
        top_ads: topAds, top_products: topProducts,
        whats_next: {
            plan: plan ? { title: plan.title, status: plan.status, summary: (plan.plan || {}).summary || null, objective: (plan.plan || {}).objective || null,
                budget: (plan.plan || {}).total_budget ?? null, budget_type: (plan.plan || {}).budget_type || null } : null,
            next_check: nextCheck
        },
        changes, summary: words
    };
}

// ---- reading -------------------------------------------------------------------------------------
async function readAll(build, label) {
    const { data, error } = await build;
    if (error) { if (missingTable(error)) return null; throw Object.assign(new Error(`${label}: ${error.message}`), { cause: error }); }
    return data || [];
}
const missingColumn = e => !!e && (e.code === 'PGRST204' || e.code === '42703' || /column .* does not exist|could not find the .* column/i.test(String(e.message || '')));
const DAY_COLS = 'ad_id, metric_date, campaign_id, currency, spend, impressions, link_clicks, video_plays, messages_started, purchases, purchase_value';
/** The ad days of a client, with ThruPlays when the phase-87 columns are there. */
async function readDays(clientId, from, to) {
    const build = cols => supabase.from('xp_ad_daily_snapshots').select(cols).eq('client_id', clientId).gte('metric_date', from).lte('metric_date', to).limit(50000);
    let { data, error } = await build(DAY_COLS + ', thruplays, video_p100');
    if (error && missingColumn(error)) ({ data, error } = await build(DAY_COLS));
    if (error) { if (missingTable(error)) return []; throw error; }
    return data || [];
}

async function opsClient(req, res, need) {
    const ctx = await auth(req, res); if (!ctx) return null;
    if (!staffOnly(ctx, res)) return null;
    if (!UUID_RE.test(String(req.params.id || ''))) { res.status(404).json({ error: 'Client not found.' }); return null; }
    const c = await clientAccess(ctx.user.id, req.params.id, need);
    if (!c) { res.status(404).json({ error: need === 'editor' ? 'Client not found, or you cannot edit it.' : 'Client not found.' }); return null; }
    return { ctx, c };
}
const migration87 = res => res.status(503).json({
    error: 'This needs the phase-87 database update. Run sql/schema-phase87.sql in the Supabase SQL editor.',
    code: 'migration_required'
});
const canEdit = c => ['owner', 'admin', 'editor'].includes(c.access);
function fail(res, err) {
    if (err instanceof Bad) return res.status(400).json({ error: err.message });
    if (missingTable(err) || (err && err.cause && missingTable(err.cause))) return migration87(res);
    return sendErr(res, err);
}
const todayIso = () => isoDay(Date.now());

/** The period asked for: ?from=&to=, else the last three days up to today. */
function periodOf(query, today) {
    const to = has(query.to) ? day(query.to, 'To') : today;
    const from = has(query.from) ? day(query.from, 'From') : addDays(to, -(CHECKIN_DAYS - 1));
    if (from > to) bad('From: it comes after To.');
    if (daysBetween(from, to) + 1 > MAX_SPAN_DAYS) bad(`A period of ${MAX_SPAN_DAYS} days at most.`);
    return { from, to };
}

async function economicsOf(clientId) {
    const { data, error } = await supabase.from('client_ad_economics').select('*').eq('client_id', clientId).maybeSingle();
    if (error) { if (missingTable(error)) return { missing: true, row: null }; throw error; }
    return { missing: false, row: data || null };
}
async function productsOf(clientId) {
    return (await readAll(supabase.from('client_products').select('*').eq('client_id', clientId).order('created_at').limit(5000), 'products')) || [];
}

// ---- economics routes ---------------------------------------------------------------------------
app.get('/api/clients/:id/economics', async (req, res) => {
    try {
        const got = await opsClient(req, res, 'viewer'); if (!got) return;
        const { c } = got;
        const [e, products, plans] = await Promise.all([
            economicsOf(c.id), productsOf(c.id),
            readAll(supabase.from('client_ad_plans').select('status, plan, created_at').eq('client_id', c.id).in('status', ['approved', 'launched']).order('created_at', { ascending: false }).limit(20), 'plans')
        ]);
        if (e.missing) return migration87(res);
        const plan = (plans || []).find(p => p.status === 'launched') || (plans || [])[0];
        const rate = plan && has((plan.plan || {}).forecast_order_rate) ? Number(plan.plan.forecast_order_rate) : null;
        res.json({
            canEdit: canEdit(c), set: !!e.row,
            economics: { ...ECON_DEFAULTS, ...(e.row ? Object.fromEntries(Object.entries(e.row).filter(([k]) => k in ECON_DEFAULTS)) : {}) },
            order_rate: rate, products: productEconomics(products, e.row || {}, { orderRate: rate })
        });
    } catch (err) { fail(res, err); }
});

app.put('/api/clients/:id/economics', rateLimit({ windowMs: 60000, max: 30, key: bearerId }), async (req, res) => {
    try {
        const got = await opsClient(req, res, 'editor'); if (!got) return;
        const { ctx, c } = got;
        const row = cleanEconomics(req.body || {});
        if (!Object.keys(row).length) return res.status(400).json({ error: 'Nothing to save.' });
        const { data, error } = await supabase.from('client_ad_economics')
            .upsert({ ...row, client_id: c.id, updated_by: ctx.user.id, updated_at: new Date().toISOString() }, { onConflict: 'client_id' }).select().maybeSingle();
        if (error) throw error;
        res.json({ success: true, economics: data });
    } catch (err) { fail(res, err); }
});

// ---- orders routes ---------------------------------------------------------------------------------
async function orderContext(clientId) {
    const [products, e] = await Promise.all([productsOf(clientId), economicsOf(clientId)]);
    return { products: new Map(products.map(p => [p.id, p])), zones: (e.row && e.row.delivery_zones) || [], list: products, missing: e.missing };
}

/** Whether this buyer ordered before. Phone in, a hash and new/returning out; the number goes no further. */
async function buyerOf(clientId, phone, before, exceptId) {
    if (!has(phone)) return {};
    const h = phoneHash(phone);
    if (!h) return { buyer_hash: null, note: normalPhone(phone) ? 'no_secret' : 'bad_phone' };
    let q = supabase.from('client_orders').select('id, ordered_on, status').eq('client_id', clientId).eq('buyer_hash', h).neq('status', 'cancelled').lte('ordered_on', before).limit(5);
    const { data, error } = await q;
    if (error) throw error;
    const earlier = (data || []).filter(o => o.id !== exceptId);
    return { buyer_hash: h, buyer_type: earlier.length ? 'returning' : 'new' };
}

app.get('/api/clients/:id/orders', async (req, res) => {
    try {
        const got = await opsClient(req, res, 'editor'); if (!got) return;
        const { c } = got;
        const today = todayIso();
        const to = has(req.query.to) ? day(req.query.to, 'To') : today;
        const from = has(req.query.from) ? day(req.query.from, 'From') : addDays(to, -59);
        let q = supabase.from('client_orders').select('*').eq('client_id', c.id).gte('ordered_on', from).lte('ordered_on', to);
        if (has(req.query.status)) q = q.eq('status', oneOf(req.query.status, 'Status', ORDER_STATUS));
        const [orders, ctx2, ads] = await Promise.all([
            readAll(q.order('ordered_on', { ascending: false }).order('created_at', { ascending: false }).limit(2000), 'orders'),
            orderContext(c.id),
            readAll(supabase.from('xp_meta_ads').select('ad_id, name, adset_id, campaign_id').eq('client_id', c.id).limit(2000), 'ads')
        ]);
        if (orders === null || ctx2.missing) return migration87(res);
        // the ads to pick from: those that spent in the last 60 days first
        const recent = await readAll(supabase.from('xp_ad_daily_snapshots').select('ad_id, spend').eq('client_id', c.id).gte('metric_date', addDays(today, -59)).limit(20000), 'recent ads');
        const spent = new Map();
        (recent || []).forEach(r => spent.set(r.ad_id, (spent.get(r.ad_id) || 0) + n0(r.spend)));
        res.json({
            canEdit: true, from, to,
            orders: (orders || []).map(o => ({ ...o, buyer_hash: undefined, known_buyer: !!o.buyer_hash })),
            products: ctx2.list.map(p => ({ id: p.id, name: p.name, price: p.price ?? p.combo_price ?? null, stock: p.stock })),
            zones: ctx2.zones,
            ads: (ads || []).map(a => ({ ad_id: a.ad_id, name: a.name || a.ad_id, spend_60d: r2(spent.get(a.ad_id) || 0) })).sort((a, b) => b.spend_60d - a.spend_60d).slice(0, 300),
            hashing: !!hashKey()
        });
    } catch (err) { fail(res, err); }
});

app.post('/api/clients/:id/orders', rateLimit({ windowMs: 60000, max: 120, key: bearerId }), async (req, res) => {
    try {
        const got = await opsClient(req, res, 'editor'); if (!got) return;
        const { ctx, c } = got;
        const oc = await orderContext(c.id);
        if (oc.missing) return migration87(res);
        const body = req.body || {};
        const row = cleanOrder(body, { create: true, products: oc.products, zones: oc.zones });
        const buyer = await buyerOf(c.id, body.phone, row.ordered_on, null);
        if (buyer.buyer_hash) row.buyer_hash = buyer.buyer_hash;
        if (buyer.buyer_type && !row.buyer_type) row.buyer_type = buyer.buyer_type;
        if (row.buyer_type === 'returning' && row.source === 'unknown') row.source = 'repeat';
        if (row.status !== 'confirmed') row.status_on = row.status_on || row.ordered_on;
        const { count } = await supabase.from('client_orders').select('id', { count: 'exact', head: true }).eq('client_id', c.id);
        if ((count || 0) >= ORDER_CAP) return res.status(400).json({ error: `A client holds ${ORDER_CAP} orders at most.` });
        const now = new Date().toISOString();
        const { data, error } = await supabase.from('client_orders').insert({ ...row, client_id: c.id, created_by: ctx.user.id, created_at: now, updated_at: now }).select().maybeSingle();
        if (error) throw error;
        res.status(201).json({ order: { ...data, buyer_hash: undefined, known_buyer: !!data.buyer_hash }, phone: buyer.note || null });
    } catch (err) { fail(res, err); }
});

app.patch('/api/clients/:id/orders/:orderId', rateLimit({ windowMs: 60000, max: 240, key: bearerId }), async (req, res) => {
    try {
        const got = await opsClient(req, res, 'editor'); if (!got) return;
        const { c } = got;
        if (!UUID_RE.test(String(req.params.orderId || ''))) return res.status(404).json({ error: 'Order not found.' });
        const { data: cur, error: re } = await supabase.from('client_orders').select('*').eq('id', req.params.orderId).eq('client_id', c.id).maybeSingle();
        if (re) throw re;
        if (!cur) return res.status(404).json({ error: 'Order not found.' });
        const oc = await orderContext(c.id);
        const body = req.body || {};
        const patch = cleanOrder(body, { products: oc.products, zones: oc.zones });
        if (patch.items && body.value === undefined) patch.value = r2(patch.items.reduce((s, x) => s + n0(x.price) * x.qty, 0));
        if (has(body.phone)) {
            const buyer = await buyerOf(c.id, body.phone, patch.ordered_on || cur.ordered_on, cur.id);
            if (buyer.buyer_hash) { patch.buyer_hash = buyer.buyer_hash; if (body.buyer_type === undefined) patch.buyer_type = buyer.buyer_type; }
        }
        if (patch.status && patch.status !== cur.status && body.status_on === undefined) patch.status_on = todayIso();
        const after = { ...cur, ...patch };
        if (after.ad_id && after.source !== 'ad') return res.status(400).json({ error: 'Ad: only an order from an ad has one. Set “Where it came from” to Ad.' });
        if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to change.' });
        const { data, error } = await supabase.from('client_orders').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', cur.id).eq('client_id', c.id).select().maybeSingle();
        if (error) throw error;
        res.json({ order: { ...data, buyer_hash: undefined, known_buyer: !!data.buyer_hash } });
    } catch (err) { fail(res, err); }
});

app.delete('/api/clients/:id/orders/:orderId', async (req, res) => {
    try {
        const got = await opsClient(req, res, 'editor'); if (!got) return;
        if (!UUID_RE.test(String(req.params.orderId || ''))) return res.status(404).json({ error: 'Order not found.' });
        const { data, error } = await supabase.from('client_orders').delete().eq('id', req.params.orderId).eq('client_id', got.c.id).select('id');
        if (error) throw error;
        if (!data || !data.length) return res.status(404).json({ error: 'Order not found.' });
        res.json({ success: true });
    } catch (err) { fail(res, err); }
});

// ---- decisions and lessons ---------------------------------------------------------------------------
app.get('/api/clients/:id/ad-decisions', async (req, res) => {
    try {
        const got = await opsClient(req, res, 'viewer'); if (!got) return;
        const rows = await readAll(supabase.from('client_ad_decisions').select('*').eq('client_id', got.c.id).order('decided_on', { ascending: false }).order('created_at', { ascending: false }).limit(500), 'decisions');
        if (rows === null) return migration87(res);
        res.json({ canEdit: canEdit(got.c), decisions: rows, today: todayIso(), steps: STEPS.map(([n, name]) => ({ step: n, name })) });
    } catch (err) { fail(res, err); }
});

app.post('/api/clients/:id/ad-decisions', rateLimit({ windowMs: 60000, max: 60, key: bearerId }), async (req, res) => {
    try {
        const got = await opsClient(req, res, 'editor'); if (!got) return;
        const { ctx, c } = got;
        const row = cleanDecision(req.body || {}, { create: true });
        if (row.outcome) row.graded_on = todayIso();
        const { count, error: ce } = await supabase.from('client_ad_decisions').select('id', { count: 'exact', head: true }).eq('client_id', c.id);
        if (ce) throw ce;
        if ((count || 0) >= DECISION_CAP) return res.status(400).json({ error: `A client holds ${DECISION_CAP} decisions at most.` });
        const now = new Date().toISOString();
        const { data, error } = await supabase.from('client_ad_decisions').insert({ ...row, client_id: c.id, created_by: ctx.user.id, created_at: now, updated_at: now }).select().maybeSingle();
        if (error) throw error;
        res.status(201).json({ decision: data });
    } catch (err) { fail(res, err); }
});

app.patch('/api/clients/:id/ad-decisions/:decisionId', rateLimit({ windowMs: 60000, max: 120, key: bearerId }), async (req, res) => {
    try {
        const got = await opsClient(req, res, 'editor'); if (!got) return;
        const { c } = got;
        if (!UUID_RE.test(String(req.params.decisionId || ''))) return res.status(404).json({ error: 'Decision not found.' });
        const { data: cur, error: re } = await supabase.from('client_ad_decisions').select('*').eq('id', req.params.decisionId).eq('client_id', c.id).maybeSingle();
        if (re) throw re;
        if (!cur) return res.status(404).json({ error: 'Decision not found.' });
        const patch = cleanDecision(req.body || {});
        if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to change.' });
        const after = { ...cur, ...patch };
        if (after.check_on && after.check_on < after.decided_on) return res.status(400).json({ error: 'When we will know: it comes before the decision.' });
        if (patch.outcome !== undefined) patch.graded_on = patch.outcome ? todayIso() : null;
        const { data, error } = await supabase.from('client_ad_decisions').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', cur.id).eq('client_id', c.id).select().maybeSingle();
        if (error) throw error;
        res.json({ decision: data });
    } catch (err) { fail(res, err); }
});

app.delete('/api/clients/:id/ad-decisions/:decisionId', async (req, res) => {
    try {
        const got = await opsClient(req, res, 'editor'); if (!got) return;
        if (!UUID_RE.test(String(req.params.decisionId || ''))) return res.status(404).json({ error: 'Decision not found.' });
        const { data, error } = await supabase.from('client_ad_decisions').delete().eq('id', req.params.decisionId).eq('client_id', got.c.id).select('id');
        if (error) throw error;
        if (!data || !data.length) return res.status(404).json({ error: 'Decision not found.' });
        res.json({ success: true });
    } catch (err) { fail(res, err); }
});

/**
 * The learning library: every graded lesson from the businesses this person can open, newest first,
 * so a new client's plan starts from what worked elsewhere. ?idea_type= narrows it; ?client= puts the
 * same kind of business first.
 */
app.get('/api/ad-lessons', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        const clients = (await S.openableClients(ctx)) || [];
        if (!clients.length) return res.json({ lessons: [] });
        const names = new Map(clients.map(c => [c.id, c]));
        let q = supabase.from('client_ad_decisions').select('id, client_id, decided_on, scope_name, change, step, metric, expected, outcome, outcome_note, lesson, idea_type, idea, graded_on')
            .in('client_id', clients.map(c => c.id).slice(0, 1000)).not('lesson', 'is', null);
        if (has(req.query.idea_type)) q = q.eq('idea_type', oneOf(req.query.idea_type, 'Kind of idea', IDEA_TYPES));
        const rows = await readAll(q.order('decided_on', { ascending: false }).limit(500), 'lessons');
        if (rows === null) return migration87(res);
        let me = null;
        if (UUID_RE.test(String(req.query.client || ''))) me = names.get(String(req.query.client)) || null;
        const kind = me ? new Set(S.benchmarkPeers(me, clients.filter(c => c.id !== me.id))[1].ids) : null;
        const lessons = rows.filter(r => r.lesson).map(r => {
            const cl = names.get(r.client_id) || {};
            return { ...r, client: cl.name || null, niche: cl.niche || null, same_kind: !!(kind && kind.has(r.client_id)), this_client: !!(me && me.id === r.client_id) };
        }).sort((a, b) => (b.same_kind - a.same_kind) || String(b.decided_on).localeCompare(String(a.decided_on)));
        res.json({ lessons, idea_types: IDEA_TYPES });
    } catch (err) { fail(res, err); }
});

// ---- the check-in -------------------------------------------------------------------------------
app.get('/api/clients/:id/ad-checkin', async (req, res) => {
    try {
        const got = await opsClient(req, res, 'viewer'); if (!got) return;
        const { c } = got;
        const today = todayIso();
        const { from, to } = periodOf(req.query || {}, today);
        const lifeFrom = addDays(to, -(LIFE_DAYS - 1));
        const monthFrom = to.slice(0, 7) + '-01';
        const ordersFrom = [addDays(to, -(BUSINESS_DAYS + WEEK)), monthFrom, from].sort()[0];
        const [plans, briefRows, econ, products, ads, adsets, campaigns, accounts, windows, orders, decisions, runs, days] = await Promise.all([
            readAll(supabase.from('client_ad_plans').select('id, title, status, plan, created_at').eq('client_id', c.id).order('created_at', { ascending: false }).limit(200), 'plans'),
            readAll(supabase.from('client_ad_briefs').select('brief').eq('client_id', c.id).limit(1), 'brief'),
            economicsOf(c.id),
            productsOf(c.id),
            readAll(supabase.from('xp_meta_ads').select('ad_id, name, adset_id, campaign_id').eq('client_id', c.id).limit(5000), 'ads'),
            readAll(supabase.from('xp_meta_ad_sets').select('adset_id, name, campaign_id, status, daily_budget, lifetime_budget').eq('client_id', c.id).limit(2000), 'ad sets'),
            readAll(supabase.from('xp_meta_ad_campaigns').select('campaign_id, name, status, objective').eq('client_id', c.id).limit(2000), 'campaigns'),
            readAll(supabase.from('xp_meta_ad_accounts').select('*').eq('client_id', c.id), 'ad accounts'),
            readAll(supabase.from('xp_ad_reach_windows').select('ad_id, adset_id, reach, impressions, frequency, period_from, period_to').eq('client_id', c.id).limit(5000), 'reach windows'),
            readAll(supabase.from('client_orders').select('id, ordered_on, status, value, source, ad_id, items, buyer_type').eq('client_id', c.id).gte('ordered_on', ordersFrom).lte('ordered_on', to).limit(20000), 'orders'),
            readAll(supabase.from('client_ad_decisions').select('*').eq('client_id', c.id).order('decided_on', { ascending: false }).limit(500), 'decisions'),
            readAll(supabase.from('client_ad_runs').select('campaign').eq('client_id', c.id).limit(2000), 'ledger'),
            readDays(c.id, lifeFrom, to)
        ]);
        if (econ.missing || orders === null || decisions === null) return migration87(res);
        const out = buildCheckin({
            today, from, to, client: c, brief: ((briefRows || [])[0] || {}).brief || {}, plans: plans || [], econ: econ.row, products,
            ads: ads || [], adsets: adsets || [], campaigns: campaigns || [], accounts: accounts || [], windows: windows || [],
            days, orders: orders || [], decisions: decisions || [], runs: runs || []
        });
        const brief = ((briefRows || [])[0] || {}).brief || {};
        res.json({ client: { id: c.id, name: c.name }, canEdit: canEdit(c), today, currency: ((accounts || [])[0] || {}).currency || brief.currency || 'BDT', ...out });
    } catch (err) { fail(res, err); }
});

// ---- the month for the client --------------------------------------------------------------------
app.get('/api/clients/:id/results-report', async (req, res) => {
    try {
        const got = await opsClient(req, res, 'viewer'); if (!got) return;
        const { c } = got;
        const today = todayIso();
        const month = has(req.query.month) ? String(req.query.month) : today.slice(0, 7);
        if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'Month: like 2026-10.' });
        const mw = monthWindow(month);
        const [y, m] = month.split('-').map(Number);
        const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
        const pw = monthWindow(prev);
        const [days, prevDays, orders, prevOrders, products, plans, decisions, ads, accounts] = await Promise.all([
            readDays(c.id, mw.from, mw.to), readDays(c.id, pw.from, pw.to),
            readAll(supabase.from('client_orders').select('ordered_on, status, value, source, ad_id, items, buyer_type').eq('client_id', c.id).gte('ordered_on', mw.from).lte('ordered_on', mw.to).limit(20000), 'orders'),
            readAll(supabase.from('client_orders').select('ordered_on, status, value, source, ad_id, items, buyer_type').eq('client_id', c.id).gte('ordered_on', pw.from).lte('ordered_on', pw.to).limit(20000), 'last month orders'),
            productsOf(c.id),
            readAll(supabase.from('client_ad_plans').select('title, status, plan, created_at').eq('client_id', c.id).order('created_at', { ascending: false }).limit(50), 'plans'),
            readAll(supabase.from('client_ad_decisions').select('decided_on, change, step, expected, check_on, outcome, lesson').eq('client_id', c.id).order('decided_on', { ascending: false }).limit(500), 'decisions'),
            readAll(supabase.from('xp_meta_ads').select('ad_id, name').eq('client_id', c.id).limit(5000), 'ads'),
            readAll(supabase.from('xp_meta_ad_accounts').select('currency').eq('client_id', c.id).limit(5), 'accounts')
        ]);
        if (orders === null || decisions === null) return migration87(res);
        const out = buildResults({
            month, today, client: { id: c.id, name: c.name, brand: c.brand || null },
            days, prevDays, orders, prevOrders: prevOrders || [], products, plans: plans || [], decisions, ads: ads || []
        });
        res.json({ ...out, currency: ((accounts || [])[0] || {}).currency || 'BDT' });
    } catch (err) { fail(res, err); }
});
