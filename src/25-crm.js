/**
 * The CRM (phase 87): EdgeLead's own cold leads, from first touch to client.
 *
 *   Leads       a person and their business, a source, a stage, an owner, a value, a next step
 *   Activities  one timeline per lead: notes, emails out and in, calls, WhatsApp, meetings, stage moves
 *   Tasks       follow-ups with a due time and an owner
 *   Influencers the creator network, on a real map, in any country, with the posts they made for clients
 *   Overview    the numbers by department (website, SEO, marketing and its channels, influencer)
 *
 * And the tools switch: the social media tools (Lead Finder, reports, Facebook, content plan, Edge Meta AI)
 * are off unless an admin turns them on. While a tool is off its API answers 403 and its background work
 * (scheduler, Meta sync, XpulseAI sync) does not run, so nothing spends Apify or Meta calls.
 *
 * Everything that decides something (validation, duplicates, departments, the overview sums, CSV rows,
 * which tool owns a path) is a plain function on S, so tests/phase87.test.js checks it without a database.
 */
'use strict';
const S = require('./shared');
const { app, auth, logger, supabase } = S;

// ---------------------------------------------------------------------------------------------------
// vocabulary
// ---------------------------------------------------------------------------------------------------
const CRM_SOURCES = [
    { key: 'website',    label: 'Website',     dept: 'website' },
    { key: 'seo',        label: 'SEO',         dept: 'seo' },
    { key: 'ads_google', label: 'Google Ads',  dept: 'marketing', path: 'Marketing › Ads › Google' },
    { key: 'ads_meta',   label: 'Meta Ads',    dept: 'marketing', path: 'Marketing › Ads › Meta' },
    { key: 'social',     label: 'Social',      dept: 'marketing', path: 'Marketing › Social' },
    { key: 'email',      label: 'Email',       dept: 'marketing', path: 'Marketing › Email' },
    { key: 'influencer', label: 'Influencer',  dept: 'influencer' },
    { key: 'referral',   label: 'Referral',    dept: 'other' },
    { key: 'other',      label: 'Other',       dept: 'other' }
];
const CRM_DEPTS = [
    { key: 'website', label: 'Website' }, { key: 'seo', label: 'SEO' },
    { key: 'marketing', label: 'Marketing', children: ['ads_google', 'ads_meta', 'social', 'email'] },
    { key: 'influencer', label: 'Influencer' }, { key: 'other', label: 'Referral & other' }
];
const CRM_STAGES = [
    { key: 'new', label: 'New' }, { key: 'contacted', label: 'Contacted' }, { key: 'replied', label: 'Replied' },
    { key: 'meeting', label: 'Meeting' }, { key: 'proposal', label: 'Proposal' }, { key: 'won', label: 'Won' }, { key: 'lost', label: 'Lost' }
];
const CRM_ACTIVITY_TYPES = ['note', 'email_out', 'email_in', 'call', 'whatsapp', 'meeting', 'stage', 'task', 'system', 'sms'];
const LOGGABLE = ['note', 'email_out', 'email_in', 'call', 'whatsapp', 'meeting'];
const CR_STAGES = ['prospect', 'talking', 'partner'];
/** Rough rates into taka for adding mixed currencies on the overview. Shown as "≈". */
const TO_BDT = { BDT: 1, USD: 120, GBP: 152, EUR: 130, CAD: 87, AUD: 79, INR: 1.4 };
const CURRENCIES = Object.keys(TO_BDT);

/** The social media tools, and the API paths each one owns. Anything not listed is always on. */
const TOOLS = [
    { key: 'leadfinder', label: 'Lead Finder (Instagram scraping)', detail: 'Apify runs, lead scoring, creator reviews',
      paths: ['/api/campaign', '/api/enrich-campaign', '/api/run-campaign', '/api/search-leads', '/api/leads', '/api/client-history', '/api/reviews'] },
    { key: 'reports', label: 'Instagram and Facebook reports', detail: 'Competitor reports, audits, monthly reports, schedules, shares',
      paths: ['/api/generate-ig-report', '/api/deep-audit', '/api/competitor-sets', '/api/estimate-credits', '/api/set-trend', '/api/posts',
              '/api/report', '/api/reports-history', '/api/reports', '/api/meta/monthly', '/api/schedules', '/api/share', '/api/shares', '/api/public/share'] },
    { key: 'facebook', label: 'Facebook groups and pages', detail: 'Community scans, demand signals, page reports', paths: ['/api/fb'] },
    { key: 'content', label: 'Content plan and calendar', detail: 'Strategy, ideas, calendar, posts',
      paths: ['/api/content-plan', '/api/content-plans', '/api/content-ideas', '/api/content-picks', '/api/content-posts', '/api/content-strategy', '/api/content-topics', '/api/client/content'] },
    { key: 'metaai', label: 'Edge Meta AI', detail: 'Owner assistant over Meta data, twice-daily sync',
      paths: ['/api/assistant', '/api/xp', '/api/client/demand', '/api/client/leads', '/api/client/report', '/api/client/reports'] }
];

// ---------------------------------------------------------------------------------------------------
// plain functions
// ---------------------------------------------------------------------------------------------------
function bad(message) { const e = new Error(message); e.statusCode = 400; return e; }
const str = (v, max) => (v === undefined || v === null) ? null : (String(v).trim().slice(0, max) || null);

function normEmail(v) {
    const e = String(v || '').trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}
/** Digits only, with a leading country code kept; Bangladeshi local numbers (01…) get 880 in front. */
function normPhone(v) {
    let d = String(v || '').replace(/[^\d+]/g, '');
    if (!d) return null;
    d = d.startsWith('+') ? d.slice(1) : d.startsWith('00') ? d.slice(2) : d;
    if (/^01\d{9}$/.test(d)) d = '88' + d;
    d = d.replace(/\D/g, '');
    return d.length >= 8 && d.length <= 15 ? d : null;
}
function sourceInfo(key) { return CRM_SOURCES.find(s => s.key === key) || null; }
function departmentOf(source) { const s = sourceInfo(source); return s ? s.dept : 'other'; }

/** Phase 90: an industry as people write it, tidied: "  roofing " → "Roofing". Empty is null. */
function cleanIndustry(v) {
    const s = str(v, 60);
    if (!s) return null;
    const t = s.replace(/\s+/g, ' ');
    return t === t.toLowerCase() ? t.replace(/(^|[\s/&-])([a-z])/g, (m, a, c) => a + c.toUpperCase()) : t;
}
/** Validate a lead body. `partial` for edits: only the fields sent are checked and returned. */
function cleanLeadBody(b, { partial = false } = {}) {
    b = b || {};
    const out = {};
    const has = k => Object.prototype.hasOwnProperty.call(b, k);
    if (!partial || has('full_name')) { out.full_name = str(b.full_name, 160); if (!out.full_name) throw bad('Add the person\'s name.'); }
    for (const [k, max] of [['title', 120], ['company', 160], ['website', 300], ['city', 120], ['timezone', 60], ['source_detail', 200], ['next_step', 240], ['lost_reason', 300], ['whatsapp', 40]]) {
        if (has(k)) out[k] = str(b[k], max);
    }
    if (has('email')) {
        const raw = str(b.email, 200);
        if (raw && !normEmail(raw)) throw bad('That email address does not look right.');
        out.email = raw; out.email_norm = normEmail(raw);
    }
    if (has('phone')) {
        const raw = str(b.phone, 40);
        if (raw && !normPhone(raw)) throw bad('That phone number does not look right. Include the country code.');
        out.phone = raw; out.phone_norm = normPhone(raw);
    }
    if (has('country')) { const c = str(b.country, 60); if (c && !/^[A-Za-z]{2}$/.test(c)) throw bad('Country is a two-letter code, like BD or US.'); out.country = c ? c.toUpperCase() : null; }
    if (!partial || has('source')) { const s = b.source || 'other'; if (!sourceInfo(s)) throw bad('Pick a source from the list.'); out.source = s; }
    if (has('stage')) { if (!CRM_STAGES.some(s => s.key === b.stage)) throw bad('Unknown stage.'); out.stage = b.stage; }
    if (has('value')) {
        if (b.value === null || b.value === '') out.value = null;
        else { const v = Number(String(b.value).replace(/[,\s]/g, '')); if (!Number.isFinite(v) || v < 0 || v > 1e12) throw bad('Value must be a number.'); out.value = Math.round(v * 100) / 100; }
    }
    if (has('currency')) { const c = String(b.currency || 'BDT').toUpperCase(); if (!CURRENCIES.includes(c)) throw bad('Currency must be one of ' + CURRENCIES.join(', ') + '.'); out.currency = c; }
    if (has('score')) { const v = Math.round(Number(b.score)); if (!Number.isFinite(v) || v < 0 || v > 100) throw bad('Score is 0 to 100.'); out.score = v; }
    if (has('tags')) out.tags = Array.isArray(b.tags) ? [...new Set(b.tags.map(t => str(t, 40)).filter(Boolean))].slice(0, 20) : [];
    if (has('next_step_at')) { if (!b.next_step_at) out.next_step_at = null; else { const d = new Date(b.next_step_at); if (isNaN(d)) throw bad('Next step date is not a date.'); out.next_step_at = d.toISOString(); } }
    if (has('owner_id')) out.owner_id = b.owner_id || null;
    if (has('unsubscribed')) out.unsubscribed = !!b.unsubscribed;
    // Phase 90: what the business does, and whether it is in the pipeline (both columns arrive with schema-phase90.sql).
    if (has('industry')) out.industry = cleanIndustry(b.industry);
    if (has('in_pipeline')) out.in_pipeline = b.in_pipeline === true;
    if (out.stage === 'won') throw bad('Use Convert to client to win a lead, so the client is created with it.');
    return out;
}

/** Which existing lead (if any) a new one duplicates: same email first, then same phone. */
function findDuplicate(candidate, existing) {
    const e = candidate.email_norm, p = candidate.phone_norm;
    return (e && existing.find(x => x.email_norm === e)) || (p && existing.find(x => x.phone_norm === p)) || null;
}

/** A minimal CSV reader: quotes, escaped quotes, commas and newlines inside quotes, CRLF. */
function parseCsv(text) {
    const rows = []; let row = [], cell = '', q = false;
    const s = String(text || '').replace(/^﻿/, '');
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
        if (c === '"') q = true;
        else if (c === ',') { row.push(cell); cell = ''; }
        else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
        else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(x => String(x).trim() !== ''));
}
const CSV_FIELDS = {
    full_name: ['name', 'full name', 'contact', 'contact name', 'person'], company: ['company', 'business', 'business name', 'organisation', 'organization'],
    email: ['email', 'e-mail', 'email address'], phone: ['phone', 'mobile', 'phone number', 'whatsapp'], website: ['website', 'site', 'url'],
    title: ['title', 'role', 'position', 'job title'], city: ['city', 'town'], country: ['country', 'country code'],
    source: ['source', 'lead source'], value: ['value', 'deal value', 'budget'], next_step: ['next step', 'note', 'notes'],
    industry: ['industry', 'niche', 'trade', 'business type', 'type of business']
};
/** Map CSV rows (first row = headers) to lead bodies; unknown columns are ignored, the source falls back. */
function csvToLeads(rows, fallbackSource = 'other', { useFileSource = true, industry = null } = {}) {
    if (!rows.length) return { leads: [], skipped: [] };
    const head = rows[0].map(h => String(h).trim().toLowerCase());
    const col = {};
    for (const [field, names] of Object.entries(CSV_FIELDS)) { const i = head.findIndex(h => names.includes(h)); if (i >= 0) col[field] = i; }
    if (col.full_name === undefined && col.company === undefined) throw bad('The file needs a Name or Company column.');
    const srcByLabel = Object.fromEntries(CRM_SOURCES.flatMap(s => [[s.key, s.key], [s.label.toLowerCase(), s.key]]));
    const leads = [], skipped = [];
    rows.slice(1).forEach((r, n) => {
        const get = f => col[f] === undefined ? undefined : r[col[f]];
        const body = {};
        for (const f of Object.keys(CSV_FIELDS)) { const v = get(f); if (v !== undefined && String(v).trim() !== '') body[f] = String(v).trim(); }
        if (!body.full_name) body.full_name = body.company;
        // The category chosen for the import wins, unless the file's own Source column was asked for (and the row has one).
        body.source = (useFileSource && srcByLabel[String(body.source || '').toLowerCase()]) || fallbackSource;
        if (!body.industry && industry) body.industry = industry;   // phase 90: the file's industry fills rows without their own
        try { leads.push(cleanLeadBody(body)); } catch (e) { skipped.push({ row: n + 2, reason: e.message }); }
    });
    return { leads, skipped };
}

/** Phase 88: what kind of job a won lead is: the service sold when it was converted, else its source's department. */
const JOB_KINDS = [['website', 'Websites'], ['seo', 'SEO'], ['marketing', 'Marketing & ads'], ['influencer', 'Influencer campaigns']];
function jobKind(lead) {
    const s = String(lead.service || '').toLowerCase();
    if (/web|site|landing|shop|store/.test(s)) return 'website';
    if (/seo|search engine|google business/.test(s)) return 'seo';
    if (/influenc|creator/.test(s)) return 'influencer';
    if (s) return 'marketing';
    const d = departmentOf(lead.source);
    return d === 'website' || d === 'seo' || d === 'influencer' ? d : 'marketing';
}
/** Won jobs by kind: all time and in the period, with their value in taka. */
function jobsWon(leads, since, until = new Date()) {
    const t0 = new Date(since).getTime(), t1 = new Date(until).getTime();
    const out = Object.fromEntries(JOB_KINDS.map(([k, label]) => [k, { key: k, label, count: 0, value: 0, periodCount: 0, periodValue: 0 }]));
    for (const l of leads) {
        if (l.stage !== 'won') continue;
        const j = out[jobKind(l)], v = toBdt(l.value, l.currency), t = new Date(l.stage_at || l.updated_at || l.created_at).getTime();
        j.count++; j.value += v;
        if (t >= t0 && t <= t1) { j.periodCount++; j.periodValue += v; }
    }
    return JOB_KINDS.map(([k]) => out[k]);
}

function toBdt(value, currency) { return (Number(value) || 0) * (TO_BDT[currency] || 1); }

/**
 * The overview numbers, from plain rows:
 *   leads       [{ id, source, stage, value, currency, owner_id, created_at, stage_at }]
 *   activities  [{ lead_id, type, actor_id, at, meta }]      (already limited to the period)
 * Returns totals, a row per department (marketing with its channels), the funnel, the team and day series.
 */
function crmOverview({ leads, activities, since, until = new Date(), buckets = 7 }) {
    const t0 = new Date(since).getTime(), t1 = new Date(until).getTime();
    const inP = d => { const t = new Date(d).getTime(); return t >= t0 && t <= t1; };
    const leadSrc = new Map(leads.map(l => [l.id, l.source]));
    const blank = () => ({ leads: 0, sent: 0, calls: 0, replies: 0, meetings: 0, won: 0, wonValue: 0, pipeline: 0 });
    const bySrc = Object.fromEntries(CRM_SOURCES.map(s => [s.key, blank()]));
    const series = { leads: Array(buckets).fill(0), sent: Array(buckets).fill(0), calls: Array(buckets).fill(0), replies: Array(buckets).fill(0), meetings: Array(buckets).fill(0), won: Array(buckets).fill(0) };
    const bucket = d => Math.min(buckets - 1, Math.max(0, Math.floor((new Date(d).getTime() - t0) / ((t1 - t0) / buckets))));
    for (const l of leads) {
        const m = bySrc[l.source] || bySrc.other;
        if (inP(l.created_at)) { m.leads++; series.leads[bucket(l.created_at)]++; }
        if (l.stage === 'won' && inP(l.stage_at)) { m.won++; m.wonValue += toBdt(l.value, l.currency); series.won[bucket(l.stage_at)]++; }
        if (!['won', 'lost'].includes(l.stage)) m.pipeline += toBdt(l.value, l.currency);
    }
    const team = {};
    for (const a of activities) {
        if (!inP(a.at)) continue;
        const m = bySrc[leadSrc.get(a.lead_id)] || bySrc.other;
        const key = a.type === 'email_out' ? 'sent' : a.type === 'call' ? 'calls' : a.type === 'email_in' ? 'replies'
            : (a.type === 'meeting' || (a.type === 'stage' && a.meta && a.meta.to === 'meeting')) ? 'meetings' : null;
        if (!key) continue;
        m[key]++; series[key][bucket(a.at)]++;
        if (a.actor_id && ['sent', 'calls', 'replies'].includes(key)) { const t = team[a.actor_id] = team[a.actor_id] || { sent: 0, calls: 0, replies: 0, won: 0 }; t[key]++; }
    }
    for (const l of leads) if (l.stage === 'won' && inP(l.stage_at) && l.owner_id) { const t = team[l.owner_id] = team[l.owner_id] || { sent: 0, calls: 0, replies: 0, won: 0 }; t.won++; }
    const sum = keys => keys.reduce((a, k) => { for (const f of Object.keys(a)) a[f] += bySrc[k][f]; return a; }, blank());
    const departments = CRM_DEPTS.map(d => {
        const keys = d.children || CRM_SOURCES.filter(s => s.dept === d.key).map(s => s.key);
        return { key: d.key, label: d.label, ...sum(keys),
                 children: d.children ? d.children.map(k => ({ key: k, label: sourceInfo(k).path.replace('Marketing › ', ''), ...bySrc[k] })) : [] };
    });
    const totals = sum(CRM_SOURCES.map(s => s.key));
    const reached = k => leads.filter(l => inP(l.created_at) && CRM_STAGES.findIndex(s => s.key === l.stage) >= CRM_STAGES.findIndex(s => s.key === k) && l.stage !== 'lost').length;
    const funnel = [['Leads', leads.filter(l => inP(l.created_at)).length], ['Contacted', reached('contacted')], ['Replied', reached('replied')],
                    ['Meeting', reached('meeting')], ['Proposal', reached('proposal')], ['Won', reached('won')]];
    return { totals, departments, funnel, team, series };
}

/** Which tool owns an API path, or null when the path is always on. */
function toolForPath(p) {
    const path = String(p || '').split('?')[0];
    for (const t of TOOLS) for (const pre of t.paths) if (path === pre || path.startsWith(pre + '/')) return t.key;
    return null;
}
/** The stored switch: a JSON object of tool → true. Missing or unreadable means every tool is off. */
function parseToolSwitch(value) {
    let o = {};
    try { o = value ? JSON.parse(value) : {}; } catch { o = {}; }
    return Object.fromEntries(TOOLS.map(t => [t.key, o && o[t.key] === true]));
}

function cleanInfluencerBody(b, { partial = false } = {}) {
    b = b || {}; const out = {}; const has = k => Object.prototype.hasOwnProperty.call(b, k);
    if (!partial || has('handle')) { const h = str(b.handle, 80); if (!h) throw bad('Add the creator\'s handle.'); out.handle = h.replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/\/.*$/, ''); }
    for (const [k, max] of [['name', 120], ['niche', 40], ['rate', 60], ['city', 120], ['bio', 600], ['notes', 2000], ['platform', 20], ['home_area', 120]]) if (has(k)) out[k] = str(b[k], max);
    if (has('country')) { const c = str(b.country, 60); if (c && !/^[A-Za-z]{2}$/.test(c)) throw bad('Country is a two-letter code, like BD or US.'); out.country = c ? c.toUpperCase() : null; }
    if (has('followers')) { const v = b.followers === '' || b.followers === null ? null : Math.round(Number(b.followers)); if (v !== null && (!Number.isFinite(v) || v < 0)) throw bad('Followers must be a number.'); out.followers = v; }
    if (has('engagement')) { const v = b.engagement === '' || b.engagement === null ? null : Number(b.engagement); if (v !== null && (!Number.isFinite(v) || v < 0 || v > 100)) throw bad('Engagement is a percentage.'); out.engagement = v; }
    for (const k of ['lat', 'lng']) if (has(k)) { const v = b[k] === '' || b[k] === null ? null : Number(b[k]); if (v !== null && (!Number.isFinite(v) || (k === 'lat' ? Math.abs(v) > 90 : Math.abs(v) > 180))) throw bad('That location is not on the map.'); out[k] = v; }
    if (has('stage')) { if (!CR_STAGES.includes(b.stage)) throw bad('Stage is prospect, talking or partner.'); out.stage = b.stage; }
    if (has('lead_id')) out.lead_id = b.lead_id || null;
    if (has('platforms')) out.platforms = Array.isArray(b.platforms) ? b.platforms.map(x => str(x, 40)).filter(Boolean).slice(0, 8) : [];
    return out;
}

Object.assign(S, { jobKind: (...a) => jobKind(...a), jobsWon: (...a) => jobsWon(...a) });
Object.assign(S, { CRM_SOURCES, CRM_STAGES, CRM_DEPTS, CRM_TOOLS: TOOLS, normEmail, normPhone, cleanLeadBody, cleanIndustry, findDuplicate, parseCsv, csvToLeads,
    crmOverview, toolForPath, parseToolSwitch, cleanInfluencerBody, departmentOf, toBdt });

// ---------------------------------------------------------------------------------------------------
// the tools switch (read by the gate in 01-core and by the runtime's background work)
// ---------------------------------------------------------------------------------------------------
let toolState = parseToolSwitch(null), toolReadAt = 0;
async function loadToolSwitch() {
    const env = envTools(); if (env) { toolState = env; toolReadAt = Date.now(); return toolState; }
    try {
        const { data } = await supabase.from('system_settings').select('value').eq('key', 'tools_enabled').maybeSingle();
        toolState = parseToolSwitch(data && data.value); toolReadAt = Date.now();
    } catch (e) { logger.warn('tools_switch_read_failed', { message: e.message }); }
    return toolState;
}
/** TOOLS_ENABLED=all (or a comma list of tool keys) in the environment wins over the stored switch. */
function envTools() {
    const v = String(process.env.TOOLS_ENABLED || '').trim();
    if (!v) return null;
    const on = v === 'all' ? TOOLS.map(t => t.key) : v.split(',').map(x => x.trim());
    return Object.fromEntries(TOOLS.map(t => [t.key, on.includes(t.key)]));
}
function toolOn(key) {
    const env = envTools(); if (env) return env[key] === true;
    if (Date.now() - toolReadAt > 30000) { toolReadAt = Date.now(); loadToolSwitch(); }
    return toolState[key] === true;
}
function toolGate(req, res, next) {
    const p = req.path.startsWith('/api') ? req.path : '/api' + req.path;
    const t = toolForPath(p);
    if (!t) return next();
    if (!toolOn(t)) return res.status(403).json({ error: 'This tool is locked. The owner unlocks it in Admin → Tools.', code: 'tool_off', tool: t });
    // Phase 89: the tools are the team's. A business-owner login never reaches them, whatever engines it was given.
    if (p.startsWith('/api/public/') || !['leadfinder', 'reports', 'facebook'].includes(t)) return next();
    return Promise.resolve(S.auth(req, res)).then(ctx => {
        if (!ctx) return;
        if (ctx.profile && ctx.profile.role === 'client') return res.status(403).json({ error: 'The tools are for the EdgeLead team.', code: 'tool_team_only', tool: t });
        next();
    }).catch(next);
}
Object.assign(S, { loadToolSwitch, toolOn, toolGate });

app.get('/api/admin/tools', async (req, res) => {
    const ctx = await S.requireAdmin(req, res); if (!ctx) return;
    await loadToolSwitch();
    res.json({ tools: TOOLS.map(t => ({ key: t.key, label: t.label, detail: t.detail, on: toolState[t.key] })) });
});
app.put('/api/admin/tools', async (req, res) => {
    const ctx = await S.requireAdmin(req, res); if (!ctx) return;
    const want = req.body && req.body.tools || {};
    const next = Object.fromEntries(TOOLS.map(t => [t.key, Object.prototype.hasOwnProperty.call(want, t.key) ? want[t.key] === true : toolState[t.key] === true]));
    const metaChanged = next.metaai !== toolState.metaai || next.reports !== toolState.reports;
    const { error } = await supabase.from('system_settings').upsert({ key: 'tools_enabled', value: JSON.stringify(next), updated_at: new Date().toISOString() });
    if (error) return res.status(500).json({ error: 'Could not save the switch. Try again.' });
    toolState = next; toolReadAt = Date.now();
    logger.info('tools_switch', { by: ctx.user.id, tools: next });
    // Background syncs start at boot, so a change to them restarts the server (Render brings it back in under a minute).
    res.json({ tools: TOOLS.map(t => ({ key: t.key, label: t.label, detail: t.detail, on: next[t.key] })), restarting: metaChanged });
    if (metaChanged && process.env.RENDER) setTimeout(() => { try { S.gracefulShutdown ? S.gracefulShutdown('tools_switch') : process.exit(0); } catch { process.exit(0); } }, 1500).unref?.();
});

// ---------------------------------------------------------------------------------------------------
// phase 89: the Tools area (/tools). The Apify tools, outside the CRM. Two locks decide who gets in:
//   assigned  the owner gives a teammate a tool (its engine grants) and the clients they may run it for
//   unlocked  the tool's switch above is on
// The owner is assigned everything. A tool opens only when both hold.
// ---------------------------------------------------------------------------------------------------
const TOOL_AREA = [
    { key: 'leadfinder', label: 'Lead Finder', detail: 'Find businesses and creators on Instagram and Facebook', engines: ['leadgen'] },
    { key: 'reports', label: 'Instagram report', detail: 'Audit an account against up to two rivals', engines: ['report'] },
    { key: 'fbpage', switch: 'facebook', label: 'Facebook Page report', detail: 'Audit a Page, with one rival', engines: ['fb_page'] },
    { key: 'fbgroups', switch: 'facebook', label: 'Facebook groups', detail: 'Read groups for demand and what works', engines: ['fb_community'] }
];
const TOOL_ENGINES = [...new Set(TOOL_AREA.flatMap(t => t.engines))];
/** What one person sees in the Tools area, from their role, their engines and the switch. Plain, for tests. */
function toolAccess(role, engines, sw) {
    const mine = new Set(engines || []);
    return TOOL_AREA.map(t => {
        const assigned = role === 'admin' || t.engines.every(e => mine.has(e));
        const unlocked = sw[t.switch || t.key] === true;
        return { key: t.key, label: t.label, detail: t.detail, assigned, unlocked, open: assigned && unlocked };
    });
}
/** A person's engines after the owner sets their tools: the tool engines are replaced, the rest kept. */
function nextEngines(current, toolKeys) {
    const keep = (current || []).filter(e => !TOOL_ENGINES.includes(e));
    const add = TOOL_AREA.filter(t => (toolKeys || []).includes(t.key)).flatMap(t => t.engines);
    return [...new Set([...keep, ...add])];
}
async function enginesOf(userId) {
    const { data } = await supabase.from('user_engine_access').select('engine').eq('user_id', userId);
    return (data || []).map(r => r.engine);
}
Object.assign(S, { TOOL_AREA, toolAccess, nextEngines });

app.get('/api/tools/me', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        await loadToolSwitch();
        const role = ctx.profile.role;
        const tools = toolAccess(role, role === 'admin' ? TOOL_ENGINES : await enginesOf(ctx.user.id), toolState);
        let clients = [];
        if (tools.some(t => t.open)) {
            if (role === 'admin') {
                const { data } = await supabase.from('clients').select('id, name, archived').order('name');
                clients = (data || []).filter(c => !c.archived);
            } else {
                const { data: own } = await supabase.from('clients').select('id, name, archived').eq('owner_user_id', ctx.user.id);
                const { data: mem } = await supabase.from('client_members').select('client_id').eq('user_id', ctx.user.id).eq('role', 'editor');
                const ids = (mem || []).map(m => m.client_id);
                const { data: shared } = ids.length ? await supabase.from('clients').select('id, name, archived').in('id', ids) : { data: [] };
                const seen = new Set();
                clients = [...(own || []), ...(shared || [])].filter(c => !c.archived && !seen.has(c.id) && seen.add(c.id)).sort((a, b) => String(a.name).localeCompare(String(b.name)));
            }
        }
        const { data: u } = await supabase.from('app_users').select('full_name, email').eq('id', ctx.user.id).maybeSingle();
        res.json({ me: { id: ctx.user.id, role, name: (u && (u.full_name || (u.email || '').split('@')[0])) || 'You' },
            tools, clients: clients.map(c => ({ id: c.id, name: c.name })) });
    } catch (e) { fail(res, e, 'tools_me'); }
});

app.get('/api/tools/jobs', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        const types = ['leadgen_campaign', 'leadgen_enrich', 'fb_lead_discovery', 'ig_report', 'fb_page_report', 'fb_community_audit'];
        const { data, error } = await supabase.from('jobs').select('id, type, status, progress, current_step, error, input, result, created_at, finished_at')
            .eq('user_id', ctx.user.id).in('type', types).order('created_at', { ascending: false }).limit(30);
        if (error) throw error;
        res.json({ jobs: (data || []).map(j => ({ id: j.id, type: j.type, status: j.status, progress: j.progress, step: j.current_step, error: j.error,
            created_at: j.created_at, finished_at: j.finished_at,
            target: j.input && (j.input.target || j.input.campaignName || (j.input.keywords || []).join(', ') || (j.input.location || '')) || null,
            clientId: j.input && j.input.clientId || null,
            reportId: j.result && (j.result.reportId || j.result.reportRef) || null, campaignId: (j.input && j.input.campaignId) || (j.result && j.result.campaignId) || null })) });
    } catch (e) { fail(res, e, 'tools_jobs'); }
});

app.get('/api/admin/tools/access', async (req, res) => {
    const ctx = await S.requireAdmin(req, res); if (!ctx) return;
    try {
        await loadToolSwitch();
        const [{ data: users }, { data: grants }, { data: clients }, { data: members }] = await Promise.all([
            supabase.from('app_users').select('id, full_name, email, role, is_active').eq('role', 'user'),
            supabase.from('user_engine_access').select('user_id, engine'),
            supabase.from('clients').select('id, name, archived').order('name'),
            supabase.from('client_members').select('client_id, user_id, role')]);
        const eng = {}; (grants || []).forEach(g => (eng[g.user_id] = eng[g.user_id] || []).push(g.engine));
        res.json({
            switches: TOOLS.filter(t => ['leadfinder', 'reports', 'facebook'].includes(t.key)).map(t => ({ key: t.key, label: t.label, detail: t.detail, on: toolState[t.key] === true })),
            background: TOOLS.filter(t => !['leadfinder', 'reports', 'facebook'].includes(t.key)).map(t => ({ key: t.key, label: t.label, on: toolState[t.key] === true })),
            tools: TOOL_AREA.map(t => ({ key: t.key, label: t.label })),
            clients: (clients || []).filter(c => !c.archived).map(c => ({ id: c.id, name: c.name })),
            people: (users || []).map(u => ({ id: u.id, name: u.full_name || (u.email || '').split('@')[0], email: u.email, active: u.is_active,
                tools: toolAccess('user', eng[u.id], toolState).filter(t => t.assigned).map(t => t.key),
                clients: (members || []).filter(m => m.user_id === u.id && m.role === 'editor').map(m => m.client_id) }))
        });
    } catch (e) { fail(res, e, 'tools_access'); }
});

app.put('/api/admin/tools/access/:id', async (req, res) => {
    const ctx = await S.requireAdmin(req, res); if (!ctx) return;
    try {
        const id = String(req.params.id);
        const { data: u } = await supabase.from('app_users').select('id, role').eq('id', id).maybeSingle();
        if (!u || u.role !== 'user') return res.status(400).json({ error: 'Tools are given to teammates.' });
        const b = req.body || {};
        if (Array.isArray(b.tools)) {
            const next = nextEngines(await enginesOf(id), b.tools.map(String));
            await supabase.from('user_engine_access').delete().eq('user_id', id).in('engine', TOOL_ENGINES);
            const add = next.filter(e => TOOL_ENGINES.includes(e));
            if (add.length) await supabase.from('user_engine_access').upsert(add.map(engine => ({ user_id: id, engine, granted_by: ctx.user.id })), { onConflict: 'user_id,engine' });
        }
        if (Array.isArray(b.clients)) {
            const want = [...new Set(b.clients.map(String).filter(x => S.UUID_RE.test(x)))];
            const { data: have } = await supabase.from('client_members').select('client_id, role').eq('user_id', id);
            const drop = (have || []).filter(m => m.role === 'editor' && !want.includes(m.client_id)).map(m => m.client_id);
            if (drop.length) await supabase.from('client_members').delete().eq('user_id', id).in('client_id', drop);
            if (want.length) await supabase.from('client_members').upsert(want.map(client_id => ({ client_id, user_id: id, role: 'editor', added_by: ctx.user.id })), { onConflict: 'client_id,user_id' });
        }
        S.invalidateEngineAccess(id);
        logger.info('tools_access', { by: ctx.user.id, user: id, tools: b.tools, clients: Array.isArray(b.clients) ? b.clients.length : undefined });
        res.json({ ok: true });
    } catch (e) { fail(res, e, 'tools_access_put'); }
});

// ---------------------------------------------------------------------------------------------------
// routes: staff only
// ---------------------------------------------------------------------------------------------------
async function staff(req, res) {
    const ctx = await auth(req, res); if (!ctx) return null;
    if (S.staffOnly && !S.staffOnly(ctx, res)) return null;
    return ctx;
}
function fail(res, e, where) {
    if (e && e.statusCode === 400) return res.status(400).json({ error: e.message });
    logger.error(where, { message: e && e.message });
    return res.status(500).json({ error: 'Something went wrong on our side. Try again in a moment.' });
}
async function logActivity(lead_id, type, body, meta, actor_id) {
    await supabase.from('crm_activities').insert({ lead_id, type, body: body || null, meta: meta || {}, actor_id: actor_id || null });
    await supabase.from('crm_leads').update({ last_activity_at: new Date().toISOString() }).eq('id', lead_id);
}
S.logActivityExternal = (...a) => logActivity(...a).catch(e => logger.warn('crm_activity_failed', { message: e.message }));   // phase 88: the phone files calls and texts on the lead
const LEAD_COLS = 'id, full_name, title, company, website, email, phone, whatsapp, city, country, timezone, source, source_detail, stage, lost_reason, value, currency, score, tags, next_step, next_step_at, last_activity_at, unsubscribed, owner_id, client_id, created_at, updated_at, stage_at';
// Phase 90: industry, the pipeline and the map. Until schema-phase90.sql has run the columns are not there, so every
// lead route asks once a minute whether they are, reads the old columns if not, and drops the new fields from writes.
const P90_COLS = ', industry, in_pipeline, pipeline_at, lat, lng';
const P90_FIELDS = ['industry', 'in_pipeline', 'pipeline_at', 'lat', 'lng'];
let _p90 = { ok: false, at: 0 };
async function p90Ready() {
    if (_p90.ok || Date.now() - _p90.at < 60000) return _p90.ok;
    const { error } = await supabase.from('crm_leads').select('industry, in_pipeline, lat').limit(1);
    _p90 = { ok: !error, at: Date.now() };
    if (error) logger.warn('phase90_sql_missing', { message: error.message });
    return _p90.ok;
}
const leadCols = async () => LEAD_COLS + (await p90Ready() ? P90_COLS : '');
async function p90Body(body) {
    if (await p90Ready()) return body;
    const out = { ...body }; for (const k of P90_FIELDS) delete out[k]; return out;
}
Object.assign(S, { p90Ready, leadCols });

app.get('/api/crm/meta', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    const { data: users } = await supabase.from('app_users').select('id, full_name, email, role').in('role', ['admin', 'user']).eq('is_active', true);
    res.json({ sources: CRM_SOURCES, stages: CRM_STAGES, departments: CRM_DEPTS, currencies: CURRENCIES, me: { id: ctx.user.id, role: ctx.profile.role, tools: toolAccess(ctx.profile.role, ctx.profile.role === 'admin' ? TOOL_ENGINES : await enginesOf(ctx.user.id), toolState) },
        team: (users || []).map(u => ({ id: u.id, name: u.full_name || (u.email || '').split('@')[0], role: u.role, email: u.email })), tools: toolState,
        ...(S.crmMetaExtra ? await S.crmMetaExtra(ctx).catch(e => { logger.warn('crm_meta_extra_failed', { message: e.message }); return {}; }) : {}) });
});

app.get('/api/crm/leads', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        let q = supabase.from('crm_leads').select(await leadCols()).order('updated_at', { ascending: false }).limit(Math.min(2000, parseInt(req.query.limit, 10) || 1000));
        if (req.query.stage) q = q.eq('stage', String(req.query.stage));
        if (req.query.owner) q = q.eq('owner_id', String(req.query.owner));
        if (req.query.source) q = q.in('source', String(req.query.source).split(','));
        if (req.query.pipeline === '1' && await p90Ready()) q = q.eq('in_pipeline', true);
        if (req.query.q) { const s = String(req.query.q).replace(/[%,()]/g, ' ').trim().slice(0, 80); if (s) q = q.or(`full_name.ilike.%${s}%,company.ilike.%${s}%,email.ilike.%${s}%,phone.ilike.%${s}%`); }
        const { data, error } = await q; if (error) throw error;
        res.json({ leads: data || [] });
    } catch (e) { fail(res, e, 'crm_leads_list'); }
});

app.post('/api/crm/leads', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        const ready = await p90Ready();
        const body = await p90Body(cleanLeadBody(req.body));
        if (ready && !body.industry) throw bad('Pick the industry: what the business does, like Roofing or Plumbing.');
        if (body.in_pipeline) body.pipeline_at = new Date().toISOString();
        const or = [body.email_norm && `email_norm.eq.${body.email_norm}`, body.phone_norm && `phone_norm.eq.${body.phone_norm}`].filter(Boolean).join(',');
        if (or) {
            const { data: hits } = await supabase.from('crm_leads').select('id, full_name, company, email_norm, phone_norm').or(or).limit(5);
            const dup = findDuplicate(body, hits || []);
            if (dup) return res.status(409).json({ error: `${dup.full_name}${dup.company ? ' at ' + dup.company : ''} already has this ${dup.email_norm === body.email_norm ? 'email' : 'phone number'}.`, duplicate: dup });
        }
        const row = { ...body, owner_id: body.owner_id || ctx.user.id, created_by: ctx.user.id, stage: body.stage || 'new' };
        const { data, error } = await supabase.from('crm_leads').insert(row).select(await leadCols()).single(); if (error) throw error;
        await logActivity(data.id, 'system', 'Lead created', { source: data.source }, ctx.user.id);
        if (S.geocodeLater && (data.city || data.country)) S.geocodeLater(data);
        res.status(201).json({ lead: data });
    } catch (e) { fail(res, e, 'crm_lead_create'); }
});

app.get('/api/crm/leads/:id', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        const { data: lead, error } = await supabase.from('crm_leads').select(await leadCols()).eq('id', req.params.id).maybeSingle(); if (error) throw error;
        if (!lead) return res.status(404).json({ error: 'That lead was not found. It may have been deleted.' });
        const [acts, tasks, cr, client] = await Promise.all([
            supabase.from('crm_activities').select('id, type, body, meta, actor_id, at').eq('lead_id', lead.id).order('at', { ascending: false }).limit(300),
            supabase.from('crm_tasks').select('id, title, due_at, done_at, owner_id').eq('lead_id', lead.id).order('due_at', { ascending: true }),
            supabase.from('crm_influencers').select('id, handle, name, stage').eq('lead_id', lead.id),
            lead.client_id ? supabase.from('clients').select('id, name, brand').eq('id', lead.client_id).maybeSingle() : Promise.resolve({ data: null })
        ]);
        // Phase 90: the whole history in one place: the timeline, every call and text on the lead's number (also those
        // from before it was a lead), and every campaign email. Calls already on the timeline are not shown twice.
        const history = S.leadHistory ? await S.leadHistory(lead, acts.data || []).catch(e => { logger.warn('lead_history_failed', { message: e.message }); return null; }) : null;
        res.json({ lead, activities: acts.data || [], history, tasks: tasks.data || [], influencers: cr.data || [], client: client.data || null });
    } catch (e) { fail(res, e, 'crm_lead_get'); }
});

app.patch('/api/crm/leads/:id', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        const ready = await p90Ready();
        const body = await p90Body(cleanLeadBody(req.body, { partial: true }));
        const { data: before } = await supabase.from('crm_leads').select('id, stage, owner_id, city, country' + (ready ? ', in_pipeline' : '')).eq('id', req.params.id).maybeSingle();
        if (!before) return res.status(404).json({ error: 'That lead was not found.' });
        if (ready && Object.prototype.hasOwnProperty.call(body, 'industry') && !body.industry) throw bad('A lead keeps an industry. Pick one, or Other.');
        const now = new Date().toISOString();
        const patch = { ...body, updated_at: now };
        if (body.stage && body.stage !== before.stage) patch.stage_at = now;
        // Moving a lead on in the pipeline puts it in the pipeline.
        if (ready && body.stage && body.stage !== 'new' && !before.in_pipeline) patch.in_pipeline = true;
        if (ready && patch.in_pipeline && !before.in_pipeline) patch.pipeline_at = now;
        const { data, error } = await supabase.from('crm_leads').update(patch).eq('id', before.id).select(await leadCols()).single(); if (error) throw error;
        if (body.stage && body.stage !== before.stage) await logActivity(before.id, 'stage', null, { from: before.stage, to: body.stage }, ctx.user.id);
        if (ready && patch.in_pipeline !== undefined && patch.in_pipeline !== !!before.in_pipeline) await logActivity(before.id, 'system', patch.in_pipeline ? 'Added to the pipeline' : 'Taken out of the pipeline', {}, ctx.user.id);
        if (body.stage && body.stage !== before.stage && S.campaignStageChanged) S.campaignStageChanged(before.id, body.stage).catch(() => {});
        if (S.geocodeLater && ((body.city !== undefined && body.city !== before.city) || (body.country !== undefined && body.country !== before.country))) S.geocodeLater(data);
        if (body.owner_id && body.owner_id !== before.owner_id) await logActivity(before.id, 'system', 'Owner changed', { to: body.owner_id }, ctx.user.id);
        res.json({ lead: data });
    } catch (e) { fail(res, e, 'crm_lead_update'); }
});

app.post('/api/crm/leads/bulk', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.slice(0, 500) : [];
        if (!ids.length) throw bad('Select at least one lead.');
        const set = await p90Body(cleanLeadBody(req.body.set || {}, { partial: true }));
        const allowed = Object.fromEntries(Object.entries(set).filter(([k]) => ['stage', 'owner_id', 'tags', 'source', 'industry', 'in_pipeline'].includes(k)));
        if (!Object.keys(allowed).length) throw bad('Nothing to change.');
        if (Object.prototype.hasOwnProperty.call(allowed, 'industry') && !allowed.industry) throw bad('Pick the industry to set.');
        const now = new Date().toISOString();
        if (allowed.in_pipeline === true) allowed.pipeline_at = now;
        if (allowed.stage && allowed.stage !== 'new' && await p90Ready()) { allowed.in_pipeline = true; allowed.pipeline_at = allowed.pipeline_at || now; }
        const { error } = await supabase.from('crm_leads').update({ ...allowed, updated_at: now, ...(allowed.stage ? { stage_at: now } : {}) }).in('id', ids); if (error) throw error;
        if (allowed.stage) await supabase.from('crm_activities').insert(ids.map(id => ({ lead_id: id, type: 'stage', meta: { to: allowed.stage, bulk: true }, actor_id: ctx.user.id })));
        if (allowed.in_pipeline === true && !allowed.stage) await supabase.from('crm_activities').insert(ids.map(id => ({ lead_id: id, type: 'system', body: 'Added to the pipeline', meta: { bulk: true }, actor_id: ctx.user.id })));
        res.json({ updated: ids.length });
    } catch (e) { fail(res, e, 'crm_lead_bulk'); }
});

app.delete('/api/crm/leads/:id', async (req, res) => {
    const ctx = await S.requireAdmin(req, res); if (!ctx) return;
    const { error } = await supabase.from('crm_leads').delete().eq('id', req.params.id);
    if (error) return fail(res, error, 'crm_lead_delete');
    res.json({ deleted: true });
});

app.post('/api/crm/leads/:id/activities', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        const type = String(req.body && req.body.type || 'note');
        if (!LOGGABLE.includes(type)) throw bad('Pick note, email, call, WhatsApp or meeting.');
        const body = str(req.body.body, 5000);
        if (!body && type === 'note') throw bad('Write the note first.');
        const meta = {};
        if (type === 'call') { const m = Math.round(Number(req.body.minutes)); if (Number.isFinite(m) && m >= 0) meta.minutes = m; meta.outcome = str(req.body.outcome, 60); }
        const { data, error } = await supabase.from('crm_activities').insert({ lead_id: req.params.id, type, body, meta, actor_id: ctx.user.id }).select('id, type, body, meta, actor_id, at').single();
        if (error) throw error;
        const lead = { last_activity_at: data.at };
        if (type === 'email_in') { const { data: l } = await supabase.from('crm_leads').select('stage').eq('id', req.params.id).maybeSingle(); if (l && ['new', 'contacted'].includes(l.stage)) { lead.stage = 'replied'; lead.stage_at = data.at; } }
        await supabase.from('crm_leads').update(lead).eq('id', req.params.id);
        if (lead.stage) await logActivity(req.params.id, 'stage', null, { to: 'replied', auto: true }, ctx.user.id);
        if (type === 'email_in' && S.campaignStageChanged) S.campaignStageChanged(req.params.id, 'replied').catch(() => {});   // phase 90: a reply stops its campaigns
        res.status(201).json({ activity: data });
    } catch (e) { fail(res, e, 'crm_activity_create'); }
});

app.post('/api/crm/leads/:id/convert', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        const { data: lead } = await supabase.from('crm_leads').select(LEAD_COLS).eq('id', req.params.id).maybeSingle();
        if (!lead) return res.status(404).json({ error: 'That lead was not found.' });
        if (lead.client_id) return res.status(409).json({ error: 'This lead is already a client.', client_id: lead.client_id });
        const service = str(req.body && req.body.service, 60);
        const value = req.body && req.body.value !== undefined ? cleanLeadBody({ value: req.body.value }, { partial: true }).value : lead.value;
        const { data: client, error } = await supabase.from('clients').insert({
            owner_user_id: ctx.user.id, name: lead.company || lead.full_name, brand: lead.company || null, location: [lead.city, lead.country].filter(Boolean).join(', ') || null,
            notes: [`Won from the CRM on ${new Date().toISOString().slice(0, 10)}.`, `Contact: ${lead.full_name}${lead.title ? ', ' + lead.title : ''}${lead.email ? ' · ' + lead.email : ''}${lead.phone ? ' · ' + lead.phone : ''}.`,
                    service ? `First service: ${service}.` : null, `Source: ${(sourceInfo(lead.source) || {}).path || (sourceInfo(lead.source) || {}).label || lead.source}.`].filter(Boolean).join('\n'),
            converted_at: new Date().toISOString()
        }).select('id, name').single();
        if (error) throw error;
        const now = new Date().toISOString();
        const won = { stage: 'won', stage_at: now, client_id: client.id, value, service: service || null, next_step: null, next_step_at: null, updated_at: now };
        if (await p90Ready()) won.in_pipeline = true;
        const { error: wErr } = await supabase.from('crm_leads').update(won).eq('id', lead.id);
        if (wErr) { delete won.service; delete won.in_pipeline; const { error: e2 } = await supabase.from('crm_leads').update(won).eq('id', lead.id); if (e2) throw e2; }   // before phase 88's SQL there is no service column
        await logActivity(lead.id, 'stage', null, { from: lead.stage, to: 'won' }, ctx.user.id);
        await logActivity(lead.id, 'system', `Became a client: ${client.name}`, { client_id: client.id, service }, ctx.user.id);
        res.json({ client, lead_id: lead.id });
    } catch (e) { fail(res, e, 'crm_convert'); }
});

app.post('/api/crm/leads/import', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        const b = req.body || {};
        const ready = await p90Ready();
        const { leads: parsed, skipped } = csvToLeads(parseCsv(b.csv), sourceInfo(b.source) ? b.source : 'other', { useFileSource: b.useFileSource === true, industry: cleanIndustry(b.industry) });
        if (ready && parsed.some(l => !l.industry)) throw bad('Choose the industry for this file. Rows with their own Industry column keep theirs.');
        const leads = await Promise.all(parsed.map(p90Body));
        const owner = S.UUID_RE && S.UUID_RE.test(String(b.owner_id || '')) ? b.owner_id : ctx.user.id;
        const tag = str(b.tag, 40);
        if (leads.length > 2000) throw bad('Import up to 2,000 rows at a time.');
        const emails = leads.map(l => l.email_norm).filter(Boolean), phones = leads.map(l => l.phone_norm).filter(Boolean);
        const existing = [];
        for (let i = 0; i < emails.length; i += 200) { const { data } = await supabase.from('crm_leads').select('id, full_name, company, email_norm, phone_norm').in('email_norm', emails.slice(i, i + 200)); existing.push(...(data || [])); }
        for (let i = 0; i < phones.length; i += 200) { const { data } = await supabase.from('crm_leads').select('id, full_name, company, email_norm, phone_norm').in('phone_norm', phones.slice(i, i + 200)); existing.push(...(data || [])); }
        const fresh = [], dupes = [];
        for (const l of leads) { const d = findDuplicate(l, existing); if (d) dupes.push({ name: l.full_name, matches: d.full_name }); else { fresh.push(l); existing.push({ ...l, id: 'new' }); } }
        for (let i = 0; i < fresh.length; i += 200) {
            const { error } = await supabase.from('crm_leads').insert(fresh.slice(i, i + 200).map(l => ({ ...l, owner_id: owner, created_by: ctx.user.id, stage: 'new', tags: [...new Set([...(l.tags || []), 'Imported', ...(tag ? [tag] : [])])] })));
            if (error) throw error;
        }
        if (S.geocodeBackfill && fresh.length) S.geocodeBackfill().catch(() => {});
        res.json({ added: fresh.length, duplicates: dupes, skipped });
    } catch (e) { fail(res, e, 'crm_import'); }
});

// tasks
app.get('/api/crm/tasks', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    let q = supabase.from('crm_tasks').select('id, lead_id, title, due_at, done_at, owner_id').is('done_at', null).order('due_at', { ascending: true }).limit(200);
    if (req.query.mine === '1') q = q.eq('owner_id', ctx.user.id);
    const { data, error } = await q; if (error) return fail(res, error, 'crm_tasks');
    res.json({ tasks: data || [] });
});
app.post('/api/crm/tasks', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        const title = str(req.body && req.body.title, 240); if (!title) throw bad('Write what needs doing.');
        const due = req.body.due_at ? new Date(req.body.due_at) : null; if (due && isNaN(due)) throw bad('Due date is not a date.');
        const { data, error } = await supabase.from('crm_tasks').insert({ lead_id: req.body.lead_id || null, title, due_at: due && due.toISOString(), owner_id: req.body.owner_id || ctx.user.id, created_by: ctx.user.id }).select('*').single();
        if (error) throw error;
        if (data.lead_id) await supabase.from('crm_leads').update({ next_step: title, next_step_at: data.due_at }).eq('id', data.lead_id);
        res.status(201).json({ task: data });
    } catch (e) { fail(res, e, 'crm_task_create'); }
});
app.patch('/api/crm/tasks/:id', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    const done = !!(req.body && req.body.done);
    const { data, error } = await supabase.from('crm_tasks').update({ done_at: done ? new Date().toISOString() : null }).eq('id', req.params.id).select('*').single();
    if (error) return fail(res, error, 'crm_task_done');
    if (done && data.lead_id) { await logActivity(data.lead_id, 'task', data.title, { done: true }, ctx.user.id); await supabase.from('crm_leads').update({ next_step: null, next_step_at: null }).eq('id', data.lead_id).eq('next_step', data.title); }
    res.json({ task: data });
});

// overview
app.get('/api/crm/overview', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        const days = [7, 30, 90].includes(parseInt(req.query.days, 10)) ? parseInt(req.query.days, 10) : 30;
        const since = new Date(Date.now() - days * 864e5);
        const [l, a, nx, cr, posts] = await Promise.all([
            supabase.from('crm_leads').select('*').limit(20000),   // '*' so the overview still works before phase 88 adds service
            supabase.from('crm_activities').select('lead_id, type, actor_id, at, meta').gte('at', since.toISOString()).in('type', ['email_out', 'email_in', 'call', 'meeting', 'stage']).limit(50000),
            supabase.from('crm_leads').select('id, full_name, company, next_step, next_step_at, owner_id').not('next_step_at', 'is', null).not('stage', 'in', '(won,lost)').order('next_step_at', { ascending: true }).limit(8),
            supabase.from('crm_influencers').select('id, stage').limit(20000),
            supabase.from('crm_influencer_posts').select('views, posted_at').gte('posted_at', since.toISOString().slice(0, 10)).limit(20000)
        ]);
        if (l.error) throw l.error;
        const o = crmOverview({ leads: l.data || [], activities: a.data || [], since });
        const crs = cr.data || [];
        o.influencers = { total: crs.length, partners: crs.filter(x => x.stage === 'partner').length, talking: crs.filter(x => x.stage === 'talking').length,
                          prospects: crs.filter(x => x.stage === 'prospect').length, posts: (posts.data || []).length, views: (posts.data || []).reduce((s, p) => s + (p.views || 0), 0) };
        o.upNext = nx.data || []; o.days = days;
        o.jobs = jobsWon(l.data || [], since);
        res.json(o);
    } catch (e) { fail(res, e, 'crm_overview'); }
});

// influencers
app.get('/api/crm/influencers', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        const [cr, posts, clients] = await Promise.all([
            supabase.from('crm_influencers').select('*').order('followers', { ascending: false, nullsFirst: false }).limit(5000),
            supabase.from('crm_influencer_posts').select('id, influencer_id, client_id, url, posted_at, views').limit(20000),
            supabase.from('clients').select('id, name, brand, location, lat, lng, country, city').eq('archived', false).limit(2000)
        ]);
        if (cr.error) throw cr.error;
        res.json({ influencers: cr.data || [], posts: posts.data || [], clients: clients.data || [] });
    } catch (e) { fail(res, e, 'crm_influencers'); }
});
app.post('/api/crm/influencers', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        const body = cleanInfluencerBody(req.body);
        const { data, error } = await supabase.from('crm_influencers').insert({ ...body, platform: body.platform || 'instagram', stage: body.stage || 'prospect', created_by: ctx.user.id }).select('*').single();
        if (error) { if (error.code === '23505') throw bad('That creator is already in the network.'); throw error; }
        res.status(201).json({ influencer: data });
    } catch (e) { fail(res, e, 'crm_influencer_create'); }
});
app.patch('/api/crm/influencers/:id', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        const body = cleanInfluencerBody(req.body, { partial: true });
        const { data, error } = await supabase.from('crm_influencers').update({ ...body, updated_at: new Date().toISOString() }).eq('id', req.params.id).select('*').single();
        if (error) throw error;
        res.json({ influencer: data });
    } catch (e) { fail(res, e, 'crm_influencer_update'); }
});
app.post('/api/crm/influencers/:id/posts', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        if (!req.body || !req.body.client_id) throw bad('Pick the client the post was for.');
        const views = req.body.views === undefined || req.body.views === '' ? null : Math.round(Number(req.body.views));
        if (views !== null && (!Number.isFinite(views) || views < 0)) throw bad('Views must be a number.');
        const posted = req.body.posted_at ? new Date(req.body.posted_at) : new Date(); if (isNaN(posted)) throw bad('Posted date is not a date.');
        const { data, error } = await supabase.from('crm_influencer_posts').insert({ influencer_id: req.params.id, client_id: req.body.client_id, url: str(req.body.url, 500), views, posted_at: posted.toISOString().slice(0, 10), created_by: ctx.user.id }).select('*').single();
        if (error) throw error;
        await supabase.from('crm_influencers').update({ stage: 'partner', updated_at: new Date().toISOString() }).eq('id', req.params.id);
        res.status(201).json({ post: data });
    } catch (e) { fail(res, e, 'crm_influencer_post'); }
});
/** Turn a lead into a creator in the network (the lead keeps its own record). */
app.post('/api/crm/leads/:id/influencer', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        const { data: lead } = await supabase.from('crm_leads').select('id, full_name, website, city, country').eq('id', req.params.id).maybeSingle();
        if (!lead) return res.status(404).json({ error: 'That lead was not found.' });
        const body = cleanInfluencerBody({ name: lead.full_name, city: lead.city, country: lead.country, ...req.body, lead_id: lead.id });
        const { data, error } = await supabase.from('crm_influencers').insert({ ...body, platform: body.platform || 'instagram', stage: body.stage || 'talking', created_by: ctx.user.id }).select('*').single();
        if (error) { if (error.code === '23505') throw bad('That creator is already in the network.'); throw error; }
        await logActivity(lead.id, 'system', `Added to the influencer network as @${data.handle}`, { influencer_id: data.id }, ctx.user.id);
        res.status(201).json({ influencer: data });
    } catch (e) { fail(res, e, 'crm_lead_to_influencer'); }
});
/** Pin a client on the map. */
app.patch('/api/crm/clients/:id/location', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        const b = cleanInfluencerBody({ handle: 'x', lat: req.body && req.body.lat, lng: req.body && req.body.lng, city: req.body && req.body.city, country: req.body && req.body.country }, { partial: false });
        const { error } = await supabase.from('clients').update({ lat: b.lat, lng: b.lng, city: b.city || null, country: b.country || null }).eq('id', req.params.id);
        if (error) throw error;
        res.json({ saved: true });
    } catch (e) { fail(res, e, 'crm_client_location'); }
});
