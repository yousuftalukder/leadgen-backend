/**
 * The ad brief and the ad plan (phase 85).
 *
 * Part of the EdgeLead server, split out of server.js (phase 55). The parts load in
 * order from server.js and share one namespace, S: what this part needs from an earlier
 * part is unpacked below; anything else from another part is read as S.name when it runs.
 */
'use strict';
const S = require('./shared');
const {
    UUID_RE, app, auth, clientAccess, missingTable, rateLimit, bearerId, sendErr, staffOnly, supabase
} = S;
Object.assign(S, { cleanBrief, cleanPlan, targetingLines, median, benchmarkPeers, openableClients });

// ===========================================================================
// PHASE 85 :: THE AD BRIEF AND THE AD PLAN
//
// Planning a client's next ad set needs a dozen things that lived on a dozen
// tabs, and some that were not kept at all. GET …/ad-brief puts them on one
// page in a fixed order, so a person (or Claude, reading the page in a
// browser) reads it once:
//
//   the brief      goal, offer, budget, where they sell, how orders come in,
//                  pixel, who buys, what to avoid; and what was seen on the
//                  page and in Meta's Ad Library (client_ad_briefs)
//   the business   what the agency has, what the owner said (phase 84),
//                  products with their margins and stock
//   the audience   followers and engaged people by age, gender and city
//   past ads       each ad set as it was set up (targeting, optimisation,
//                  budget, placements) beside what it cost and returned, and
//                  the last 90 days split by age and gender, region, placement
//   the ledger     ads the team logged by hand, with their verdicts
//   benchmarks     what similar businesses pay, from the agency's own ads:
//                  medians over three or more other businesses, no names
//   gaps           what is missing, in plain words
//
// A plan made from it (client_ad_plans) is a campaign and its ad sets with
// creative ideas and the rules for stopping or scaling. Editors write drafts;
// the client's owner or an admin approves, rejects or marks it launched. It is
// built in Ads Manager by hand: nothing here writes to Meta.
// ===========================================================================
const AD_DAYS = 180;                 // past ad sets and their results
const BENCH_DAYS = 90;
const BENCH_MIN_PEERS = 3;           // fewer businesses than this and a median would point at one of them
const PLAN_CAP = 200;                // plans kept per client

const GOALS = ['messages', 'orders', 'leads', 'calls', 'visits', 'awareness', 'followers'];
const CHANNELS = ['messenger', 'whatsapp', 'instagram_dm', 'website', 'phone', 'walk_in'];
const YES_NO = ['yes', 'no', 'unknown'];
const OBJECTIVES = ['Messages', 'Sales', 'Leads', 'Traffic', 'Awareness', 'Engagement', 'Calls'];
const DESTINATIONS = ['messenger', 'whatsapp', 'instagram_dm', 'website', 'call', 'lead_form', 'none'];
const FORMATS = ['Reel', 'Image', 'Carousel', 'Video', 'Story', 'Influencer reel', 'Live'];
const STATUSES = ['draft', 'approved', 'rejected', 'launched'];

// ---- checking what is typed ------------------------------------------------------------------
// One small schema language for the brief and the plan: each key says what it holds. Anything not
// listed is dropped; anything listed and wrong is refused with its label, so the page can say which.
const t = {
    line: (label, max) => ({ t: 'line', label, max }),
    text: (label, max) => ({ t: 'text', label, max }),
    money: label => ({ t: 'money', label }),
    int: (label, min, max) => ({ t: 'int', label, min, max }),
    date: label => ({ t: 'date', label }),
    url: label => ({ t: 'url', label }),
    oneOf: (label, list) => ({ t: 'enum', label, list }),
    some: (label, list) => ({ t: 'set', label, list }),
    list: (label, max, of) => ({ t: 'list', label, max, of })
};
const BRIEF = {
    goal: t.oneOf('Goal', GOALS),
    offer: t.text('Offer', 600),
    offer_ends: t.date('Offer ends'),
    products_focus: t.text('Products to push', 400),
    monthly_budget: t.money('Monthly ad budget'),
    currency: t.line('Currency', 3),
    sell_areas: t.text('Where they sell or deliver', 400),
    order_channels: t.some('How orders come in', CHANNELS),
    whatsapp: t.line('WhatsApp number', 40),
    website: t.url('Website'),
    pixel: t.oneOf('Meta Pixel on the website', YES_NO),
    catalog: t.oneOf('Product catalog in Meta', YES_NO),
    customer: t.text('Who buys', 800),
    peak_times: t.text('Busy seasons and hours', 400),
    avoid: t.text('What to avoid', 600),
    past_learnings: t.text('What worked and what did not', 1500)
};
const AD_SET = {
    name: t.line('Ad set name', 120),
    budget: t.money('Ad set budget'),
    locations: t.text('Locations', 400),
    radius_km: t.int('Radius (km)', 1, 80),
    age_min: t.int('Youngest age', 13, 65),
    age_max: t.int('Oldest age', 13, 65),
    genders: t.oneOf('Genders', ['all', 'female', 'male']),
    languages: t.line('Languages', 120),
    interests: t.text('Interests and behaviours', 800),
    exclusions: t.text('Exclusions', 400),
    custom_audiences: t.text('Custom and lookalike audiences', 400),
    advantage_audience: t.oneOf('Advantage+ audience', ['on', 'off']),
    placements: t.oneOf('Placements', ['advantage', 'manual']),
    placements_detail: t.text('Which placements', 300),
    optimization: t.line('Optimise for', 120),
    destination: t.oneOf('Where people go', DESTINATIONS),
    schedule: t.line('When it runs', 200),
    bid: t.line('Bid strategy', 120),
    why: t.text('Why this ad set', 1200)
};
const CREATIVE = {
    format: t.oneOf('Format', FORMATS),
    angle: t.line('Angle', 80),
    hook: t.text('Hook (first 3 seconds)', 300),
    copy: t.text('Primary text', 1500),
    headline: t.line('Headline', 120),
    cta: t.line('Button', 60),
    product: t.line('Product shown', 200),
    language: t.oneOf('Language', ['Bangla', 'English', 'Banglish']),
    why: t.text('Why this creative', 600)
};
const PLAN = {
    objective: t.oneOf('Campaign objective', OBJECTIVES),
    budget_type: t.oneOf('Budget type', ['daily', 'lifetime']),
    total_budget: t.money('Campaign budget'),
    currency: t.line('Currency', 3),
    start_on: t.date('Start'),
    end_on: t.date('End'),
    summary: t.text('The plan in short', 2000),
    ad_sets: t.list('Ad sets', 6, AD_SET),
    creatives: t.list('Creative ideas', 8, CREATIVE),
    target_cost: t.money('Target cost per result'),
    stop_rule: t.text('When to stop an ad set', 400),
    scale_rule: t.text('When to scale up', 400),
    check_after: t.line('First check after', 120),
    sources: t.text('What this plan is based on', 1500),
    // Phase 87: the numbers the check-in judges against, the month's forecast, and the Meta campaigns
    // this plan became (so the check-in can tell a planned campaign from the owner's own boost).
    target_cost_per_order: t.money('Target cost per order'),
    max_cpm: t.money('Highest CPM'),
    min_stop_scroll: t.int('Lowest stop-scroll %', 1, 100),
    max_frequency: t.money('Highest 7-day frequency'),
    forecast_spend: t.money('Expected spend this month'),
    forecast_messages: t.int('Expected messages this month', 0, 1000000),
    forecast_order_rate: t.int('Expected chats that become orders (%)', 1, 100),
    forecast_orders: t.int('Expected orders this month', 0, 1000000),
    meta_campaign_ids: t.line('Meta campaign ids', 400)
};

class Bad extends Error {}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function cleanField(spec, v) {
    if (v === undefined || v === null || v === '') return undefined;
    const fail = why => { throw new Bad(`${spec.label}: ${why}`); };
    switch (spec.t) {
        case 'line': case 'text': {
            if (typeof v !== 'string' && typeof v !== 'number') fail('type it as text.');
            let s = String(v);
            s = spec.t === 'line' ? s.replace(/\s+/g, ' ').trim() : s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
            if (s.length > spec.max) fail(`${spec.max} letters at most.`);
            return s || undefined;
        }
        case 'money': {
            const n = Number(typeof v === 'string' ? v.replace(/[,\s৳$]/g, '') : v);
            if (!Number.isFinite(n) || n < 0 || n > 1e10) fail('give an amount.');
            return Math.round(n * 100) / 100;
        }
        case 'int': {
            const n = Number(v);
            if (!Number.isInteger(n) || n < spec.min || n > spec.max) fail(`a whole number from ${spec.min} to ${spec.max}.`);
            return n;
        }
        case 'date': {
            const s = String(v);
            if (!DATE_RE.test(s) || Number.isNaN(Date.parse(s))) fail('a date like 2026-11-30.');
            return s;
        }
        case 'url': {
            const s = String(v).trim();
            if (s.length > 300 || !/^(https?:\/\/)?[^\s/]+\.[^\s]{2,}/i.test(s)) fail('that does not look like a website.');
            return s;
        }
        case 'enum':
            if (!spec.list.includes(v)) fail(`one of ${spec.list.join(', ')}.`);
            return v;
        case 'set': {
            if (!Array.isArray(v)) fail('a list.');
            const out = [...new Set(v)];
            if (out.some(x => !spec.list.includes(x))) fail(`only ${spec.list.join(', ')}.`);
            return out.length ? out : undefined;
        }
        case 'list': {
            if (!Array.isArray(v)) fail('a list.');
            if (v.length > spec.max) fail(`${spec.max} at most.`);
            const out = v.map((x, i) => {
                if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Bad(`${spec.label} ${i + 1}: fill it in.`);
                try { return cleanObject(spec.of, x); } catch (e) { throw new Bad(`${spec.label} ${i + 1}, ${e.message}`); }
            }).filter(x => Object.keys(x).length);
            return out.length ? out : undefined;
        }
    }
    return undefined;
}
function cleanObject(schema, body) {
    const out = {};
    for (const [k, spec] of Object.entries(schema)) {
        if (!Object.prototype.hasOwnProperty.call(body, k)) continue;
        const v = cleanField(spec, body[k]);
        if (v !== undefined) out[k] = v;
    }
    return out;
}
function cleanBrief(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Bad('Send the brief.');
    const b = cleanObject(BRIEF, body);
    if (b.currency) b.currency = b.currency.toUpperCase();
    return b;
}
function cleanPlan(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Bad('Send the plan.');
    const p = cleanObject(PLAN, body);
    if (p.currency) p.currency = p.currency.toUpperCase();
    if (p.start_on && p.end_on && p.end_on < p.start_on) throw new Bad('End: it comes before the start.');
    if (p.max_frequency !== undefined && (p.max_frequency < 1 || p.max_frequency > 20)) throw new Bad('Highest 7-day frequency: from 1 to 20.');
    if (p.meta_campaign_ids !== undefined) {
        const ids = p.meta_campaign_ids.split(/[\s,;]+/).filter(Boolean);
        if (ids.some(x => !/^\d{5,30}$/.test(x))) throw new Bad('Meta campaign ids: the campaign ids from Ads Manager, digits, separated by commas.');
        p.meta_campaign_ids = [...new Set(ids)].join(', ');
    }
    for (const [i, a] of (p.ad_sets || []).entries()) {
        if (a.age_min && a.age_max && a.age_min > a.age_max) throw new Bad(`Ad sets ${i + 1}, Youngest age: it is above the oldest.`);
    }
    return p;
}

// ---- reading what Meta has -------------------------------------------------------------------
const GENDER = { 1: 'men', 2: 'women' };
/** An ad set's targeting as lines a person reads: where, who, interests, audiences, placements. */
function targetingLines(tg) {
    if (!tg || typeof tg !== 'object') return [];
    const out = [];
    const geo = tg.geo_locations || {};
    const places = [
        ...(geo.countries || []),
        ...(geo.regions || []).map(r => r.name),
        ...(geo.cities || []).map(c => `${c.name}${c.radius ? ` +${c.radius} ${c.distance_unit === 'mile' ? 'mi' : 'km'}` : ''}`),
        ...(geo.zips || []).map(z => z.name || z.key),
        ...(geo.custom_locations || []).map(c => `${c.name || c.address_string || `${c.latitude},${c.longitude}`} +${c.radius || '?'} ${c.distance_unit === 'mile' ? 'mi' : 'km'}`)
    ].filter(Boolean);
    if (places.length) out.push(`Where: ${places.join(', ')}`);
    const ex = tg.excluded_geo_locations || {};
    const exPlaces = [...(ex.countries || []), ...(ex.regions || []).map(r => r.name), ...(ex.cities || []).map(c => c.name)].filter(Boolean);
    if (exPlaces.length) out.push(`Not: ${exPlaces.join(', ')}`);
    const g = (tg.genders || []).map(x => GENDER[x]).filter(Boolean);
    out.push(`Who: ${g.length ? g.join(' and ') : 'everyone'}, ${tg.age_min || 18}–${tg.age_max || '65+'}`);
    const names = list => (list || []).map(x => x && x.name).filter(Boolean);
    const flex = (tg.flexible_spec || []).map(spec => Object.values(spec || {}).flatMap(names)).filter(a => a.length);
    if (flex.length) out.push(`Interests: ${flex.map(a => a.join(' or ')).join(' AND ')}`);
    const exc = Object.values(tg.exclusions || {}).flatMap(names);
    if (exc.length) out.push(`Excluding: ${exc.join(', ')}`);
    const ca = names(tg.custom_audiences), xca = names(tg.excluded_custom_audiences);
    if (ca.length) out.push(`Audiences: ${ca.join(', ')}`);
    if (xca.length) out.push(`Excluded audiences: ${xca.join(', ')}`);
    if (tg.targeting_automation && tg.targeting_automation.advantage_audience === 1) out.push('Advantage+ audience: on');
    const plats = tg.publisher_platforms || [];
    if (plats.length) {
        const pos = ['facebook_positions', 'instagram_positions', 'messenger_positions', 'audience_network_positions'].flatMap(k => (tg[k] || []).map(p => `${k.split('_')[0]} ${p}`));
        out.push(`Placements: ${plats.join(', ')}${pos.length ? ` (${pos.join(', ')})` : ''}`);
    } else out.push('Placements: Advantage+ (all)');
    if (tg.locales && tg.locales.length) out.push(`Languages: ${tg.locales.length} chosen`);
    return out;
}

const n0 = v => Number(v) || 0;
const ratio = (a, b) => (b > 0 ? a / b : null);
function figures(t) {
    return {
        spend: Math.round(t.spend * 100) / 100, impressions: t.impressions, link_clicks: t.link_clicks,
        messages: t.messages, leads: t.leads, purchases: t.purchases, purchase_value: Math.round(t.value * 100) / 100,
        cpm: t.impressions ? Math.round(t.spend / t.impressions * 1000 * 100) / 100 : null,
        ctr: t.impressions ? Math.round(t.link_clicks / t.impressions * 10000) / 100 : null,
        cost_per_message: t.messages ? Math.round(t.spend / t.messages * 100) / 100 : null,
        cost_per_lead: t.leads ? Math.round(t.spend / t.leads * 100) / 100 : null,
        cost_per_purchase: t.purchases ? Math.round(t.spend / t.purchases * 100) / 100 : null,
        roas: t.spend && t.value ? Math.round(t.value / t.spend * 100) / 100 : null
    };
}
const zero = () => ({ spend: 0, impressions: 0, link_clicks: 0, messages: 0, leads: 0, purchases: 0, value: 0 });
function add(t, r) {
    t.spend += n0(r.spend); t.impressions += n0(r.impressions); t.link_clicks += n0(r.link_clicks);
    t.messages += n0(r.messages_started); t.leads += n0(r.leads); t.purchases += n0(r.purchases); t.value += n0(r.purchase_value);
    return t;
}
function median(list) {
    const a = list.filter(v => v !== null && v !== undefined && Number.isFinite(v)).sort((x, y) => x - y);
    if (!a.length) return null;
    const m = Math.floor(a.length / 2);
    return Math.round((a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2) * 100) / 100;
}

const STOP = new Set(['shop', 'store', 'the', 'and', 'for', 'with', 'online', 'business', 'service', 'services', 'company', 'local']);
// "sweets" and "sweet" are the same kind of business: a plural s is dropped before comparing
const words = s => String(s || '').toLowerCase().split(/[^a-z0-9ঀ-৿]+/).filter(w => w.length >= 4 && !STOP.has(w))
    .map(w => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
const city = s => String(s || '').toLowerCase().split(/[,|/]/)[0].trim();
/**
 * Which other businesses to compare with, most alike first: the same kind of business in the same
 * city, then the same kind anywhere, then anything in the same city. The first level with enough of
 * them wins. Only the agency's own clients, never the business itself.
 */
function benchmarkPeers(me, others) {
    const mine = new Set(words(me.niche)), here = city(me.location);
    const kind = o => mine.size && words(o.niche).some(w => mine.has(w));
    const same = o => here && city(o.location) === here;
    return [
        { level: 'same kind of business, same city', ids: others.filter(o => kind(o) && same(o)).map(o => o.id) },
        { level: 'same kind of business', ids: others.filter(kind).map(o => o.id) },
        { level: 'same city', ids: others.filter(same).map(o => o.id) }
    ];
}

async function readAll(build, label) {
    const { data, error } = await build;
    if (error) { if (missingTable(error)) return null; throw Object.assign(new Error(`${label}: ${error.message}`), { cause: error }); }
    return data || [];
}

/** The businesses this person can open themself: an admin every one, anyone else their own and those shared with them. */
async function openableClients(ctx) {
    const cols = 'id, name, niche, location, archived';   // the name is for the lessons library (phase 87); benchmarks never show it
    if (ctx.profile.role === 'admin') return readAll(supabase.from('clients').select(cols).limit(5000), 'clients');
    const [own, mem] = await Promise.all([
        readAll(supabase.from('clients').select(cols).eq('owner_user_id', ctx.user.id).limit(5000), 'own clients'),
        readAll(supabase.from('client_members').select('client_id').eq('user_id', ctx.user.id).limit(5000), 'memberships')
    ]);
    const shared = (mem || []).length ? await readAll(supabase.from('clients').select(cols).in('id', mem.map(m => m.client_id)), 'shared clients') : [];
    return [...(own || []), ...(shared || [])];
}

async function benchmarks(c, ctx) {
    // Only businesses this person could open anyway, so a median never reveals another agency's ads.
    const others = ((await openableClients(ctx)) || []).filter(o => o.id !== c.id && !o.archived);
    const since = new Date(Date.now() - BENCH_DAYS * 864e5).toISOString().slice(0, 10);
    for (const { level, ids } of benchmarkPeers(c, others)) {
        if (ids.length < BENCH_MIN_PEERS) continue;
        const rows = await readAll(supabase.from('xp_ad_daily_snapshots')
            .select('client_id, currency, spend, impressions, link_clicks, messages_started, leads, purchases, purchase_value')
            .in('client_id', ids.slice(0, 200)).gte('metric_date', since).limit(50000), 'benchmark ads');
        if (!rows || !rows.length) continue;
        // one currency: the one most of the spend is in
        const byCur = {};
        rows.forEach(r => { byCur[r.currency] = (byCur[r.currency] || 0) + n0(r.spend); });
        const currency = Object.entries(byCur).sort((a, b) => b[1] - a[1])[0][0];
        const per = new Map();
        rows.filter(r => r.currency === currency).forEach(r => add(per.get(r.client_id) || per.set(r.client_id, zero()).get(r.client_id), r));
        const each = [...per.values()].filter(x => x.spend > 0).map(figures);
        if (each.length < BENCH_MIN_PEERS) continue;
        const pick = k => ({ median: median(each.map(x => x[k])), businesses: each.filter(x => x[k] !== null).length });
        return {
            level, businesses: each.length, days: BENCH_DAYS, currency,
            cpm: pick('cpm'), ctr: pick('ctr'), cost_per_message: pick('cost_per_message'),
            cost_per_lead: pick('cost_per_lead'), cost_per_purchase: pick('cost_per_purchase'), roas: pick('roas')
        };
    }
    return null;
}

async function briefClient(req, res, need) {
    const ctx = await auth(req, res); if (!ctx) return null;
    if (!staffOnly(ctx, res)) return null;
    if (!UUID_RE.test(String(req.params.id || ''))) { res.status(404).json({ error: 'Client not found.' }); return null; }
    const c = await clientAccess(ctx.user.id, req.params.id, need);
    if (!c) { res.status(404).json({ error: 'Client not found.' }); return null; }
    return { ctx, c };
}
const migration85 = res => res.status(503).json({
    error: 'The ad brief needs the phase-85 database update. Run sql/schema-phase85.sql in the Supabase SQL editor.',
    code: 'migration_required'
});

// ---- the brief ---------------------------------------------------------------------------------
app.get('/api/clients/:id/ad-brief', async (req, res) => {
    try {
        const got = await briefClient(req, res, 'viewer'); if (!got) return;
        const { ctx, c } = got;
        const since = new Date(Date.now() - AD_DAYS * 864e5).toISOString().slice(0, 10);
        const [briefRows, products, creatives, runs, assets, accounts, campaigns, adsets, adRows, breakdowns] = await Promise.all([
            readAll(supabase.from('client_ad_briefs').select('*').eq('client_id', c.id).limit(1), 'brief'),
            readAll(supabase.from('client_products').select('*').eq('client_id', c.id).order('created_at').limit(500), 'products'),
            readAll(supabase.from('client_ad_creatives').select('*').eq('client_id', c.id).limit(500), 'creatives'),
            readAll(supabase.from('client_ad_runs').select('*').eq('client_id', c.id).order('start_on', { ascending: false }).limit(200), 'runs'),
            readAll(supabase.from('xp_meta_assets').select('id, platform, asset_id, status').eq('client_id', c.id), 'assets'),
            readAll(supabase.from('xp_meta_ad_accounts').select('ad_account_id, name, currency, timezone_name, last_synced_at, last_error').eq('client_id', c.id), 'ad accounts'),
            readAll(supabase.from('xp_meta_ad_campaigns').select('campaign_id, name, objective, status, start_time, stop_time, lifetime_spend').eq('client_id', c.id).order('start_time', { ascending: false }).limit(60), 'campaigns'),
            readAll(supabase.from('xp_meta_ad_sets').select('*').eq('client_id', c.id).order('start_time', { ascending: false }).limit(60), 'ad sets'),
            readAll(supabase.from('xp_meta_ads').select('ad_id, adset_id, campaign_id, name').eq('client_id', c.id).limit(5000), 'ads'),
            readAll(supabase.from('xp_ad_breakdowns').select('*').eq('client_id', c.id).limit(5000), 'breakdowns')
        ]);
        if (briefRows === null) return migration85(res);
        const b = briefRows[0] || {};

        // results per ad set, from the daily rows of its ads
        const adsetOf = new Map((adRows || []).map(a => [a.ad_id, a.adset_id]));
        const daily = (adRows || []).length ? await readAll(supabase.from('xp_ad_daily_snapshots')
            .select('ad_id, metric_date, currency, spend, impressions, link_clicks, messages_started, leads, purchases, purchase_value')
            .eq('client_id', c.id).gte('metric_date', since).limit(50000), 'ad days') : [];
        const perSet = new Map(), total = zero();
        let firstDay = null, lastDay = null;
        for (const r of daily || []) {
            const sid = adsetOf.get(r.ad_id) || 'unknown';
            add(perSet.get(sid) || perSet.set(sid, zero()).get(sid), r);
            add(total, r);
            if (!firstDay || r.metric_date < firstDay) firstDay = r.metric_date;
            if (!lastDay || r.metric_date > lastDay) lastDay = r.metric_date;
        }
        const campaignName = new Map((campaigns || []).map(x => [x.campaign_id, x]));
        const sets = (adsets || []).map(s => ({
            adset_id: s.adset_id, name: s.name, status: s.status,
            campaign: (campaignName.get(s.campaign_id) || {}).name || null, objective: (campaignName.get(s.campaign_id) || {}).objective || null,
            optimization_goal: s.optimization_goal, billing_event: s.billing_event, bid_strategy: s.bid_strategy, bid_amount: s.bid_amount,
            daily_budget: s.daily_budget, lifetime_budget: s.lifetime_budget, currency: s.currency, destination_type: s.destination_type,
            start_time: s.start_time, end_time: s.end_time,
            targeting: targetingLines(s.targeting),
            results: perSet.has(s.adset_id) ? figures(perSet.get(s.adset_id)) : null
        })).sort((x, y) => n0(y.results && y.results.spend) - n0(x.results && x.results.spend));

        // the last 90 days split one way at a time, all ad sets together
        const splits = {};
        for (const r of breakdowns || []) {
            const d = splits[r.dimension] || (splits[r.dimension] = new Map());
            add(d.get(r.segment) || d.set(r.segment, zero()).get(r.segment), r);
        }
        const split = Object.fromEntries(Object.entries(splits).map(([dim, m]) => [dim,
            [...m].map(([segment, x]) => ({ segment, ...figures(x) })).sort((a, z) => z.spend - a.spend).slice(0, 20)]));

        // followers and engaged people, the latest reading of each
        const assetPlat = new Map((assets || []).filter(a => a.status !== 'REMOVED').map(a => [a.id, a.platform]));
        const aud = assetPlat.size ? await readAll(supabase.from('xp_audience_snapshots')
            .select('asset_id, snapshot_date, audience_type, dimension, breakdown').in('asset_id', [...assetPlat.keys()])
            .order('snapshot_date', { ascending: false }).limit(400), 'audience') : [];
        const audience = [], seen = new Set();
        for (const a of aud || []) {
            const key = `${a.asset_id}|${a.audience_type}|${a.dimension}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const entries = Object.entries(a.breakdown || {}).map(([k, v]) => [k, n0(v)]).filter(([, v]) => v > 0);
            const sum = entries.reduce((s, [, v]) => s + v, 0);
            if (!sum) continue;
            audience.push({
                platform: assetPlat.get(a.asset_id) === 'FB' ? 'Facebook' : 'Instagram', type: a.audience_type, dimension: a.dimension, as_of: a.snapshot_date,
                total: sum, top: entries.sort((x, y) => y[1] - x[1]).slice(0, 12).map(([k, v]) => ({ segment: k, count: v, share: Math.round(v / sum * 1000) / 10 }))
            });
        }

        const prods = (products || []).map(p => ({
            name: p.name, category: p.category || null, price: p.price, combo_price: p.combo_price, cost: p.cost, stock: p.stock, in_order: p.in_order,
            margin: p.price != null && p.cost != null ? Math.round((p.price - p.cost) * 100) / 100 : null,
            margin_pct: p.price > 0 && p.cost != null ? Math.round((p.price - p.cost) / p.price * 1000) / 10 : null
        }));
        const crTitle = new Map((creatives || []).map(x => [x.id, x]));
        const ledger = (runs || []).slice(0, 40).map(r => {
            const cr = crTitle.get(r.creative_id) || {};
            const x = add(zero(), { spend: r.spend, impressions: r.impressions, link_clicks: r.clicks, messages_started: r.messages, purchases: r.orders, purchase_value: r.revenue });
            return { status: r.status, start_on: r.start_on, end_on: r.end_on, creative: cr.title || r.campaign || null, format: cr.format || null, angle: cr.angle || null,
                objective: r.objective || null, audience: r.audience || null, budget: r.budget, verdict: r.verdict || null, learned: r.learned || null, results: figures(x) };
        });

        const bench = await benchmarks(c, ctx).catch(() => null);
        const brief = b.brief || {};
        const gaps = [];
        if (!brief.goal) gaps.push('No goal in the brief: messages, orders, leads, calls, visits, awareness or followers.');
        if (!brief.monthly_budget) gaps.push('No monthly ad budget in the brief.');
        if (!brief.sell_areas && !c.location) gaps.push('Where they sell or deliver is not known.');
        if (!brief.order_channels) gaps.push('How orders come in is not known (Messenger, WhatsApp, website…).');
        if (!prods.length) gaps.push('No products in the ad ledger, so margins are unknown.');
        else if (prods.every(p => p.margin === null)) gaps.push('Products have no buying and selling price, so margins are unknown.');
        if (!(accounts || []).length) gaps.push('No Meta ad account is shared with us for this business: past ad sets and their results cannot be read. Ask the owner to share the ad account with the agency.');
        else if (!sets.length) gaps.push('The ad account is shared, but no ad sets for this business have been read yet. The next ads sync reads them (twice a day).');
        if (!audience.length) gaps.push('No follower age, gender or city figures yet: the page is not connected, or Meta has not sent them.');
        if (!b.observations) gaps.push('Nothing noted yet from the page itself or from Meta’s Ad Library (theirs and competitors’ active ads).');
        if (!bench) gaps.push(`No benchmark: fewer than ${BENCH_MIN_PEERS} similar businesses with ads in the last ${BENCH_DAYS} days.`);

        res.json({
            canEdit: ['owner', 'admin', 'editor'].includes(c.access),
            canDecide: ['owner', 'admin'].includes(c.access),
            client: {
                id: c.id, name: c.name, brand: c.brand || null, niche: c.niche || null, location: c.location || null,
                ig_handle: c.ig_handle || null, fb_page: c.fb_page || null, notes: c.notes || null,
                competitors: c.competitors || [], owner_details: c.owner_details || null
            },
            brief, observations: b.observations || '', brief_updated_at: b.updated_at || null,
            products: prods,
            audience,
            ads: {
                accounts: (accounts || []).map(a => ({ name: a.name, currency: a.currency, last_synced_at: a.last_synced_at, last_error: a.last_error })),
                period: firstDay ? { from: firstDay, to: lastDay } : null,
                currency: (accounts && accounts[0] && accounts[0].currency) || null,
                total: (daily || []).length ? figures(total) : null,
                campaigns: (campaigns || []).slice(0, 20),
                ad_sets: sets,
                splits: split,
                splits_days: 90
            },
            ledger,
            benchmarks: bench,
            gaps
        });
    } catch (err) { sendErr(res, err); }
});

app.put('/api/clients/:id/ad-brief', rateLimit({ windowMs: 60000, max: 30, key: bearerId }), async (req, res) => {
    try {
        const got = await briefClient(req, res, 'editor'); if (!got) return;
        const { ctx, c } = got;
        const body = req.body || {};
        const row = { client_id: c.id, updated_by: ctx.user.id, updated_at: new Date().toISOString() };
        if (body.brief !== undefined) row.brief = cleanBrief(body.brief);
        if (body.observations !== undefined) {
            const o = String(body.observations || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
            if (o.length > 6000) return res.status(400).json({ error: 'What was seen: 6000 letters at most.' });
            row.observations = o || null;
        }
        if (!('brief' in row) && !('observations' in row)) return res.status(400).json({ error: 'Nothing to save.' });
        const { error } = await supabase.from('client_ad_briefs').upsert(row, { onConflict: 'client_id' });
        if (error) { if (missingTable(error)) return migration85(res); throw error; }
        res.json({ success: true, brief: row.brief, observations: row.observations, updated_at: row.updated_at });
    } catch (err) {
        if (err instanceof Bad) return res.status(400).json({ error: err.message });
        sendErr(res, err);
    }
});

// ---- plans -----------------------------------------------------------------------------------
app.get('/api/clients/:id/ad-plans', async (req, res) => {
    try {
        const got = await briefClient(req, res, 'viewer'); if (!got) return;
        const rows = await readAll(supabase.from('client_ad_plans').select('*').eq('client_id', got.c.id).order('created_at', { ascending: false }).limit(PLAN_CAP), 'plans');
        if (rows === null) return migration85(res);
        res.json({ plans: rows, canEdit: ['owner', 'admin', 'editor'].includes(got.c.access), canDecide: ['owner', 'admin'].includes(got.c.access) });
    } catch (err) { sendErr(res, err); }
});

app.post('/api/clients/:id/ad-plans', rateLimit({ windowMs: 60000, max: 30, key: bearerId }), async (req, res) => {
    try {
        const got = await briefClient(req, res, 'editor'); if (!got) return;
        const { ctx, c } = got;
        const title = String((req.body || {}).title || '').replace(/\s+/g, ' ').trim();
        if (!title || title.length > 160) return res.status(400).json({ error: 'Give the plan a name (160 letters at most).' });
        const plan = cleanPlan((req.body || {}).plan || {});
        const { count } = await supabase.from('client_ad_plans').select('id', { count: 'exact', head: true }).eq('client_id', c.id);
        if ((count || 0) >= PLAN_CAP) return res.status(400).json({ error: `This client has ${PLAN_CAP} plans. Delete old ones first.` });
        const { data, error } = await supabase.from('client_ad_plans').insert({ client_id: c.id, title, plan, status: 'draft', created_by: ctx.user.id }).select().maybeSingle();
        if (error) { if (missingTable(error)) return migration85(res); throw error; }
        res.status(201).json({ plan: data });
    } catch (err) {
        if (err instanceof Bad) return res.status(400).json({ error: err.message });
        sendErr(res, err);
    }
});

app.patch('/api/clients/:id/ad-plans/:planId', rateLimit({ windowMs: 60000, max: 60, key: bearerId }), async (req, res) => {
    try {
        const got = await briefClient(req, res, 'editor'); if (!got) return;
        const { ctx, c } = got;
        if (!UUID_RE.test(String(req.params.planId || ''))) return res.status(404).json({ error: 'Plan not found.' });
        const { data: row, error: re } = await supabase.from('client_ad_plans').select('*').eq('id', req.params.planId).eq('client_id', c.id).maybeSingle();
        if (re) { if (missingTable(re)) return migration85(res); throw re; }
        if (!row) return res.status(404).json({ error: 'Plan not found.' });
        const b = req.body || {};
        const patch = { updated_at: new Date().toISOString() };
        if (b.title !== undefined) {
            const title = String(b.title || '').replace(/\s+/g, ' ').trim();
            if (!title || title.length > 160) return res.status(400).json({ error: 'Give the plan a name (160 letters at most).' });
            patch.title = title;
        }
        if (b.plan !== undefined) {
            patch.plan = cleanPlan(b.plan);
            // a changed plan is a draft again, unless it is only being marked
            if (row.status !== 'draft' && b.status === undefined) { patch.status = 'draft'; patch.decided_by = null; patch.decided_at = null; }
        }
        if (b.review_note !== undefined) {
            const note = String(b.review_note || '').trim();
            if (note.length > 2000) return res.status(400).json({ error: 'The note: 2000 letters at most.' });
            patch.review_note = note || null;
        }
        if (b.status !== undefined && b.status !== row.status) {
            if (!STATUSES.includes(b.status)) return res.status(400).json({ error: 'That status is not offered.' });
            const deciding = b.status !== 'draft';
            if (deciding && !['owner', 'admin'].includes(c.access)) return res.status(403).json({ error: 'Only the client’s owner or an admin approves, rejects or launches a plan.' });
            if (b.status === 'launched' && row.status !== 'approved') return res.status(400).json({ error: 'Approve the plan before marking it launched.' });
            patch.status = b.status;
            patch.decided_by = deciding ? ctx.user.id : null;
            patch.decided_at = deciding ? new Date().toISOString() : null;
        }
        if (Object.keys(patch).length === 1) return res.status(400).json({ error: 'Nothing to change.' });
        const { data, error } = await supabase.from('client_ad_plans').update(patch).eq('id', row.id).select().maybeSingle();
        if (error) throw error;
        res.json({ plan: data });
    } catch (err) {
        if (err instanceof Bad) return res.status(400).json({ error: err.message });
        sendErr(res, err);
    }
});

app.delete('/api/clients/:id/ad-plans/:planId', async (req, res) => {
    try {
        const got = await briefClient(req, res, 'editor'); if (!got) return;
        if (!UUID_RE.test(String(req.params.planId || ''))) return res.status(404).json({ error: 'Plan not found.' });
        const { data, error } = await supabase.from('client_ad_plans').delete().eq('id', req.params.planId).eq('client_id', got.c.id).select('id');
        if (error) { if (missingTable(error)) return migration85(res); throw error; }
        if (!data || !data.length) return res.status(404).json({ error: 'Plan not found.' });
        res.json({ success: true });
    } catch (err) { sendErr(res, err); }
});
