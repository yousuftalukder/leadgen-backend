/**
 * Phase 90: what the CRM adds around its leads.
 *
 *   Settings        industries, daily outreach goals, the business time zone, where leads without a country are,
 *                   and which tabs a client's page shows, by kind of client (system_settings, no schema)
 *   Today           the Overview's outreach against its goals (calls, emails, prospects found, follow-ups) and the
 *                   client tasks that are due, for today, the next 7 days or this month
 *   History         everything that happened with a lead in one list: the timeline, calls and texts on its number
 *                   (also those from before it was a lead), and every campaign email
 *   The map         a lead's place, looked up from its city once and kept on the lead
 *   Client schema   the fields of the content plan, ad ledger, templates, ad brief and ad plan, so the client page
 *                   draws its forms from the server's own definitions
 *
 * The decisions are plain functions on S (resolveClientTabs, goalProgress, dayBounds, mergeHistory, jitter), so
 * tests/phase90.test.js checks them without a database.
 */
'use strict';
const S = require('./shared');
const { app, logger, supabase } = S;

// ---------------------------------------------------------------------------------------------------
// vocabulary
// ---------------------------------------------------------------------------------------------------
/** Every tab a client's page can show. `always` tabs cannot be hidden: a page needs its overview and details. */
const CLIENT_TABS = [
    { key: 'overview',  label: 'Overview',          always: true, detail: 'Where the work stands: open tasks, what is due, recent activity' },
    { key: 'tasks',     label: 'Task board',        detail: 'To do, doing, waiting, done; checklists, comments, files, due dates' },
    { key: 'content',   label: 'Content plan',      detail: 'Posts by date, with captions, status and links' },
    { key: 'ledger',    label: 'Ad ledger',         detail: 'Products, creatives and every ad run with its results' },
    { key: 'adbrief',   label: 'Ad brief & plan',   detail: 'What the business wants from ads, and the plans for approval' },
    { key: 'templates', label: 'Message templates', detail: 'Saved replies for the business\'s inbox' },
    { key: 'billing',   label: 'Billing',           detail: 'The agreement and invoices' },
    { key: 'reports',   label: 'Reports',           detail: 'Reports filed under this client by the Tools' },
    { key: 'team',      label: 'Team & access',     detail: 'Who on the team works on this client' },
    { key: 'details',   label: 'Details',           always: true, detail: 'Name, brand, what they do, where, notes' }
];
const TAB_KEYS = CLIENT_TABS.map(t => t.key);
/** What a new kind of client shows until the owner says otherwise. */
const DEFAULT_TABS = ['overview', 'tasks', 'content', 'ledger', 'adbrief', 'billing', 'details'];
const DEFAULT_GOALS = { calls: 30, emails: 50, prospects: 20, followups: 10 };
const DEFAULT_INDUSTRIES = ['Appliance repair', 'Roofing', 'Plumbing', 'HVAC', 'Electrical', 'Landscaping', 'Cleaning', 'Pest control',
    'Real estate', 'Restaurant', 'Dental', 'Medical', 'Beauty & salon', 'Fitness', 'Retail', 'Legal', 'Automotive', 'Construction', 'Other'];
const DEFAULT_TZ = 'America/Chicago';

// ---------------------------------------------------------------------------------------------------
// plain functions
// ---------------------------------------------------------------------------------------------------
const kindKey = s => String(s || '').trim().toLowerCase();
/**
 * The tabs a client's page shows: the client's own list if the owner set one, else its kind's (the client's
 * niche), else the default. Unknown keys are dropped, the `always` tabs are kept, and the order is the catalogue's.
 */
function resolveClientTabs(cfg, client) {
    const c = cfg || {};
    const pick = (c.byClient && client && c.byClient[client.id]) || (c.byType && client && c.byType[kindKey(client.niche)]) || c.default || DEFAULT_TABS;
    const want = new Set((Array.isArray(pick) ? pick : DEFAULT_TABS).filter(k => TAB_KEYS.includes(k)));
    for (const t of CLIENT_TABS) if (t.always) want.add(t.key);
    return CLIENT_TABS.filter(t => want.has(t.key)).map(t => t.key);
}
/** A clean client-tabs setting: only known keys, kinds lower-cased, empty kinds dropped. */
function cleanClientTabs(v) {
    const list = a => Array.isArray(a) ? [...new Set(a.filter(k => TAB_KEYS.includes(k)))] : null;
    const out = { default: list(v && v.default) || DEFAULT_TABS, byType: {}, byClient: {} };
    for (const [k, a] of Object.entries((v && v.byType) || {})) { const l = list(a); if (kindKey(k) && l) out.byType[kindKey(k)] = l; }
    for (const [k, a] of Object.entries((v && v.byClient) || {})) { const l = list(a); if (S.UUID_RE.test(k) && l) out.byClient[k] = l; }
    return out;
}
function cleanGoals(v) {
    const out = {};
    for (const k of Object.keys(DEFAULT_GOALS)) { const n = Math.round(Number(v && v[k])); out[k] = Number.isFinite(n) && n >= 0 && n <= 10000 ? n : DEFAULT_GOALS[k]; }
    return out;
}
function cleanIndustries(v) {
    const seen = new Set(), out = [];
    for (const x of Array.isArray(v) ? v : []) { const s = S.cleanIndustry(x); if (s && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); out.push(s); } }
    return out.slice(0, 120);
}
/** How far along each goal is: done, target, percent (capped at 100), and whether it is met. */
function goalProgress(counts, goals) {
    return Object.keys(DEFAULT_GOALS).map(k => {
        const done = Number(counts[k]) || 0, target = Number(goals[k]) || 0;
        return { key: k, done, target, pct: target ? Math.min(100, Math.round(done / target * 100)) : (done ? 100 : 0), met: target ? done >= target : true };
    });
}
/** Minutes the time zone is ahead of UTC at that moment (Chicago in winter: -360). */
function tzOffset(tz, at) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
        .formatToParts(at).filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]));
    return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - at.getTime()) / 60000);
}
/** The day in the business's time zone, as UTC instants: start of today, and the end of the range asked for. */
function dayBounds(tz, range = 'today', now = new Date()) {
    const local = new Date(now.getTime() + tzOffset(tz, now) * 60000);
    const y = local.getUTCFullYear(), m = local.getUTCMonth(), d = local.getUTCDate();
    const at = (yy, mm, dd) => { const guess = new Date(Date.UTC(yy, mm, dd)); return new Date(guess.getTime() - tzOffset(tz, guess) * 60000); };
    const start = at(y, m, d);
    const end = range === 'month' ? at(y, m + 1, 1) : range === '7d' ? at(y, m, d + 7) : at(y, m, d + 1);
    return { start, end, today: `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`, endDay: new Date(end.getTime() - 1 + tzOffset(tz, end) * 60000).toISOString().slice(0, 10) };
}
/**
 * One history for a lead, newest first. Calls and texts already on the timeline (same Twilio id) are not repeated;
 * campaign emails are their own items. Each item: { kind, at, dir, title, body, meta }.
 */
function mergeHistory({ activities = [], calls = [], texts = [], emails = [] }) {
    const seen = new Set(activities.map(a => a.meta && a.meta.sid).filter(Boolean));
    const out = activities.map(a => ({ kind: a.type, at: a.at, id: a.id, actor: a.actor_id || null, body: a.body || null, meta: a.meta || {} }));
    for (const c of calls) {
        if (seen.has(c.sid)) continue;
        out.push({ kind: 'call', at: c.started_at, id: 'call-' + c.id, actor: c.user_id || c.answered_by || null, body: c.transcript || c.note || null,
            meta: { direction: c.direction, minutes: c.duration ? Math.round(c.duration / 6) / 10 : null, outcome: c.voicemail ? 'Voicemail' : c.status === 'completed' ? 'Spoke' : (c.status || '').replace(/-/g, ' '), voicemail: !!c.voicemail, phoneCall: c.id } });
    }
    for (const t of texts) {
        if (seen.has(t.sid)) continue;
        out.push({ kind: 'sms', at: t.at, id: 'sms-' + t.id, actor: t.user_id || null, body: t.body || null, meta: { direction: t.direction, auto: !!t.auto } });
    }
    const onTimeline = new Set(activities.map(a => a.meta && a.meta.emailId).filter(Boolean));
    for (const e of emails) {
        if (onTimeline.has(e.id)) { const a = out.find(x => x.meta && x.meta.emailId === e.id); if (a) Object.assign(a.meta, { opened: e.opened_at, opens: e.opens, status: e.status }); continue; }
        out.push({ kind: 'campaign_email', at: e.sent_at, id: 'mail-' + e.id, actor: e.sent_by || null, body: e.body || null,
            meta: { subject: e.subject, to: e.to_email, status: e.status, error: e.error, opened: e.opened_at, opens: e.opens, campaign: e.campaign_id, step: e.step } });
    }
    return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}
/** A small, steady offset (about ±1.5 km) so leads in one city do not sit on one point. Same lead, same place. */
function jitter(id) {
    let h = 2166136261;
    for (const ch of String(id)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    const a = ((h >>> 0) % 1000) / 1000, b = ((h >>> 10) % 1000) / 1000;
    return { dLat: (a - 0.5) * 0.028, dLng: (b - 0.5) * 0.034 };
}
Object.assign(S, { CLIENT_TABS, resolveClientTabs, cleanClientTabs, cleanGoals, cleanIndustries, goalProgress, dayBounds, tzOffset, mergeHistory, jitter });

// ---------------------------------------------------------------------------------------------------
// settings (system_settings rows holding JSON)
// ---------------------------------------------------------------------------------------------------
const _set = new Map();
async function getSetting(key, fallback) {
    const hit = _set.get(key);
    if (hit && Date.now() - hit.at < 30000) return hit.v;
    let v = fallback;
    try {
        const { data } = await supabase.from('system_settings').select('value').eq('key', key).maybeSingle();
        if (data && data.value != null) v = JSON.parse(data.value);
    } catch (e) { logger.warn('setting_read_failed', { key, message: e.message }); }
    _set.set(key, { v, at: Date.now() });
    return v;
}
async function putSetting(key, value) {
    const { error } = await supabase.from('system_settings').upsert({ key, value: JSON.stringify(value), updated_at: new Date().toISOString() }, { onConflict: 'key' });
    if (error) throw error;
    _set.set(key, { v: value, at: Date.now() });
}
async function crmSettings() {
    const [industries, goals, clientTabs, geo, tz] = await Promise.all([
        getSetting('crm_industries', DEFAULT_INDUSTRIES), getSetting('crm_goals', DEFAULT_GOALS), getSetting('client_tabs', null),
        getSetting('crm_geo', { hint: '' }), getSetting('crm_timezone', DEFAULT_TZ)]);
    return { industries: cleanIndustries(industries).length ? cleanIndustries(industries) : DEFAULT_INDUSTRIES, goals: cleanGoals(goals),
        clientTabs: cleanClientTabs(clientTabs || {}), geo: { hint: String((geo && geo.hint) || '').slice(0, 120) }, timezone: validTz(tz) ? tz : DEFAULT_TZ };
}
function validTz(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } }
Object.assign(S, { getSetting, putSetting, crmSettings });

/** What /api/crm/meta adds: the settings the pages need, and whether the phase-90 SQL has run. */
S.crmMetaExtra = async () => {
    const st = await crmSettings();
    return { industries: st.industries, goals: st.goals, timezone: st.timezone, clientTabs: { catalogue: CLIENT_TABS, ...st.clientTabs },
        p90: await S.p90Ready(), p91: S.p91Ready ? await S.p91Ready() : false, mailbox: S.mailboxState ? await S.mailboxState() : { connected: false } };
};

// ---------------------------------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------------------------------
async function staff(req, res) {
    const ctx = await S.auth(req, res); if (!ctx) return null;
    if (S.staffOnly && !S.staffOnly(ctx, res)) return null;
    return ctx;
}
function fail(res, e, where) {
    if (e && e.statusCode === 400) return res.status(400).json({ error: e.message });
    logger.error(where, { message: e && e.message });
    return res.status(500).json({ error: 'Something went wrong on our side. Try again in a moment.' });
}
const bad = m => Object.assign(new Error(m), { statusCode: 400 });

app.get('/api/admin/crm-settings', async (req, res) => {
    const ctx = await S.requireAdmin(req, res); if (!ctx) return;
    try {
        const st = await crmSettings();
        const { data: kinds } = await supabase.from('clients').select('niche').eq('archived', false).limit(2000);
        res.json({ ...st, catalogue: CLIENT_TABS, clientKinds: [...new Set((kinds || []).map(k => kindKey(k.niche)).filter(Boolean))].sort(), p90: await S.p90Ready() });
    } catch (e) { fail(res, e, 'crm_settings_get'); }
});
app.put('/api/admin/crm-settings', async (req, res) => {
    const ctx = await S.requireAdmin(req, res); if (!ctx) return;
    try {
        const b = req.body || {};
        if (b.industries !== undefined) { const l = cleanIndustries(b.industries); if (!l.length) throw bad('Keep at least one industry.'); await putSetting('crm_industries', l); }
        if (b.goals !== undefined) await putSetting('crm_goals', cleanGoals(b.goals));
        if (b.clientTabs !== undefined) await putSetting('client_tabs', cleanClientTabs(b.clientTabs));
        if (b.geo !== undefined) await putSetting('crm_geo', { hint: String((b.geo && b.geo.hint) || '').trim().slice(0, 120) });
        if (b.timezone !== undefined) { if (!validTz(b.timezone)) throw bad('That time zone is not one I know, e.g. America/Chicago.'); await putSetting('crm_timezone', b.timezone); }
        logger.info('crm_settings', { by: ctx.user.id, keys: Object.keys(b) });
        res.json(await crmSettings());
    } catch (e) { fail(res, e, 'crm_settings_put'); }
});

/** The client page's form definitions, from the server's own validators. */
app.get('/api/crm/client-schema', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    const wb = Object.fromEntries(Object.entries(S.WB_KINDS || {}).map(([k, v]) => [k, { label: v.label, cap: v.cap || null,
        fields: Object.fromEntries(Object.entries(v.fields).map(([fk, f]) => [fk, { t: f.t, label: f.label, list: f.list || null, ref: f.ref || null, req: !!f.req, dflt: f.dflt || null }])) }]));
    res.json({ workbook: wb, ad: S.AD_SCHEMA || null, tabs: CLIENT_TABS, taskStatuses: ['todo', 'doing', 'waiting', 'done'], taskPriorities: ['lowest', 'low', 'medium', 'high', 'highest'] });
});

/** A client's tabs, resolved for this client. */
app.get('/api/crm/client-tabs/:id', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        const c = await S.clientAccess(ctx.user.id, req.params.id, 'viewer');
        if (!c) return res.status(404).json({ error: 'Client not found.' });
        const st = await crmSettings();
        res.json({ tabs: resolveClientTabs(st.clientTabs, c), kind: kindKey(c.niche) || null, canEdit: ['owner', 'admin', 'editor'].includes(c.access) });
    } catch (e) { fail(res, e, 'client_tabs'); }
});

/**
 * Today on the Overview: outreach so far today against the goals (the whole team and each person), and the client
 * tasks and call tasks due by the end of the range (today, 7d or month), overdue ones first.
 */
app.get('/api/crm/today', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        const st = await crmSettings();
        const range = ['today', '7d', 'month'].includes(req.query.range) ? req.query.range : 'today';
        const day = dayBounds(st.timezone, 'today'), rng = dayBounds(st.timezone, range);
        const s0 = day.start.toISOString(), s1 = day.end.toISOString();
        const p90 = await S.p90Ready();
        const [calls, actCalls, acts, crmNew, finderNew, followups, people] = await Promise.all([
            supabase.from('phone_calls').select('id, user_id, sid').eq('direction', 'outbound').gte('started_at', s0).lt('started_at', s1).limit(5000),
            supabase.from('crm_activities').select('actor_id, meta').eq('type', 'call').gte('at', s0).lt('at', s1).limit(5000),
            supabase.from('crm_activities').select('actor_id, type').in('type', ['email_out']).gte('at', s0).lt('at', s1).limit(5000),
            supabase.from('crm_leads').select('created_by').gte('created_at', s0).lt('created_at', s1).limit(5000),
            supabase.from('leads').select('owner_user_id').gte('created_at', s0).lt('created_at', s1).limit(10000),
            supabase.from('crm_tasks').select('owner_id').gte('done_at', s0).lt('done_at', s1).limit(5000),
            supabase.from('app_users').select('id, full_name, email').in('role', ['admin', 'user']).eq('is_active', true)
        ]);
        // A call is counted once: the phone's record, plus any call logged by hand that the phone does not know.
        const phoneSids = new Set((calls.data || []).map(c => c.sid));
        const handCalls = (actCalls.data || []).filter(a => !(a.meta && a.meta.sid && phoneSids.has(a.meta.sid)) && !(a.meta && a.meta.direction === 'inbound'));
        const per = {};
        const bump = (id, k) => { if (!id) return; (per[id] = per[id] || { calls: 0, emails: 0, prospects: 0, followups: 0 })[k]++; };
        (calls.data || []).forEach(c => bump(c.user_id, 'calls')); handCalls.forEach(a => bump(a.actor_id, 'calls'));
        (acts.data || []).forEach(a => bump(a.actor_id, 'emails'));
        (crmNew.data || []).forEach(l => bump(l.created_by, 'prospects')); (finderNew.data || []).forEach(l => bump(l.owner_user_id, 'prospects'));
        (followups.data || []).forEach(t => bump(t.owner_id, 'followups'));
        const total = {
            calls: (calls.data || []).length + handCalls.length,
            emails: (acts.data || []).length,   // a campaign email logs an email_out too, with no person: the team's, nobody's
            prospects: (crmNew.data || []).length + (finderNew.data || []).length,
            followups: (followups.data || []).length
        };
        const team = (people.data || []).map(u => ({ id: u.id, name: u.full_name || (u.email || '').split('@')[0], ...(per[u.id] || { calls: 0, emails: 0, prospects: 0, followups: 0 }) }));

        // Tasks due by the end of the range: every client the caller can open, and the CRM's own call and follow-up tasks.
        const clients = S.openClientsFor ? await S.openClientsFor(ctx).catch(() => []) : [];
        const byId = new Map(clients.map(c => [c.id, c]));
        let ctasks = [];
        if (byId.size) {
            const { data } = await supabase.from('client_tasks').select('id, client_id, title, status, priority, due_date, assignee_user_id, assigned_to_client, labels, completed_at, updated_at')
                .in('client_id', [...byId.keys()]).neq('status', 'done').not('due_date', 'is', null).lte('due_date', rng.endDay).order('due_date', { ascending: true }).limit(300);
            ctasks = (data || []).map(t => ({ ...t, client: { id: t.client_id, name: (byId.get(t.client_id) || {}).name || '' }, overdue: t.due_date < day.today }));
        }
        const crmTaskCols = 'id, lead_id, title, due_at, owner_id' + (p90 ? ', kind' : '');
        const { data: ct } = await supabase.from('crm_tasks').select(crmTaskCols).is('done_at', null).lte('due_at', rng.end.toISOString()).order('due_at', { ascending: true }).limit(300);
        const leadIds = [...new Set((ct || []).map(t => t.lead_id).filter(Boolean))];
        const { data: tl } = leadIds.length ? await supabase.from('crm_leads').select('id, full_name, company, phone, email').in('id', leadIds) : { data: [] };
        const leadById = new Map((tl || []).map(l => [l.id, l]));
        res.json({
            range, timezone: st.timezone, today: day.today, until: rng.endDay,
            goals: goalProgress(total, st.goals), total, team,
            clientTasks: ctasks,
            crmTasks: (ct || []).map(t => ({ ...t, kind: t.kind || (/^call\b/i.test(t.title) ? 'call' : 'todo'), overdue: t.due_at && t.due_at < s0, lead: leadById.get(t.lead_id) || null }))
        });
    } catch (e) { fail(res, e, 'crm_today'); }
});

// ---------------------------------------------------------------------------------------------------
// a lead's whole history
// ---------------------------------------------------------------------------------------------------
S.leadHistory = async (lead, activities) => {
    // The phone's own rule (a 10-digit US number gets its +1), so a call matches the lead however its number was typed.
    const e164 = (S.toE164 && S.toE164(lead.phone)) || (S.normPhone && S.normPhone(lead.phone) ? '+' + S.normPhone(lead.phone) : null);
    const or = (col) => e164 ? `lead_id.eq.${lead.id},${col}.eq.${e164}` : `lead_id.eq.${lead.id}`;
    const [calls, texts, emails] = await Promise.all([
        supabase.from('phone_calls').select('id, sid, direction, status, user_id, answered_by, started_at, duration, voicemail, transcript, note').or(or('contact_number')).order('started_at', { ascending: false }).limit(200),
        supabase.from('phone_messages').select('id, sid, direction, body, auto, user_id, at').or(or('contact_number')).order('at', { ascending: false }).limit(300),
        (await S.p90Ready()) ? supabase.from('crm_emails').select('id, campaign_id, step, to_email, subject, body, status, error, sent_by, sent_at, opened_at, opens').eq('lead_id', lead.id).order('sent_at', { ascending: false }).limit(200) : Promise.resolve({ data: [] })
    ]);
    const items = mergeHistory({ activities, calls: calls.data || [], texts: texts.data || [], emails: emails.data || [] });
    const n = k => items.filter(i => i.kind === k).length;
    return { items, counts: { calls: n('call'), texts: n('sms'), emails: n('email_out') + n('campaign_email'), replies: n('email_in'), notes: n('note'), meetings: n('meeting') } };
};

// ---------------------------------------------------------------------------------------------------
// the map: a lead's place, from its city. OpenStreetMap's Nominatim, one question a second, every answer kept.
// ---------------------------------------------------------------------------------------------------
const _geo = new Map();
const _queue = [];
let _geoBusy = false;
async function geocode(q) {
    if (_geo.has(q)) return _geo.get(q);
    let hit = null;
    try {
        const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(q), { headers: { 'User-Agent': 'EdgeLead-CRM/1.0 (lead map)', 'Accept-Language': 'en' }, signal: AbortSignal.timeout(8000) });
        if (r.ok) { const j = await r.json(); if (j && j[0]) hit = { lat: +j[0].lat, lng: +j[0].lon }; }
    } catch (e) { logger.warn('geocode_failed', { message: e.message }); return undefined; }   // not cached: try again later
    _geo.set(q, hit);
    return hit;
}
/** The questions to ask for a lead, best first: its city and country, then the city near the area the owner set. */
function geoQueries(lead, hint) {
    const city = String(lead.city || '').trim(), cc = String(lead.country || '').trim();
    const qs = [];
    if (city && cc) qs.push(`${city}, ${cc}`);
    if (city && hint) qs.push(`${city}, ${hint}`);
    if (city && !cc && !hint) qs.push(city);
    if (!city && cc) qs.push(cc);
    return [...new Set(qs)];
}
S.geoQueries = geoQueries;
async function drainGeo() {
    if (_geoBusy) return; _geoBusy = true;
    try {
        const { geo } = await crmSettings();
        while (_queue.length) {
            const lead = _queue.shift();
            let hit = null;
            for (const q of geoQueries(lead, geo.hint)) {
                const fresh = !_geo.has(q);
                hit = await geocode(q);
                if (fresh) await new Promise(r => setTimeout(r, 1100));   // Nominatim's rule: one request a second
                if (hit) break;
            }
            if (hit) {
                const j = jitter(lead.id);
                await supabase.from('crm_leads').update({ lat: +(hit.lat + j.dLat).toFixed(6), lng: +(hit.lng + j.dLng).toFixed(6) }).eq('id', lead.id);
            }
        }
    } catch (e) { logger.warn('geocode_drain_failed', { message: e.message }); }
    _geoBusy = false;
}
S.geocodeLater = lead => { if (!lead || !lead.id) return; S.p90Ready().then(ok => { if (!ok) return; _queue.push(lead); drainGeo(); }); };
/** Every lead with a place but no point on the map. Returns how many were queued. */
S.geocodeBackfill = async ({ force = false } = {}) => {
    if (!(await S.p90Ready())) return 0;
    let q = supabase.from('crm_leads').select('id, city, country').limit(2000);
    q = force ? q.or('city.not.is.null,country.not.is.null') : q.is('lat', null).or('city.not.is.null,country.not.is.null');
    const { data } = await q;
    const list = (data || []).filter(l => !_queue.some(x => x.id === l.id));
    _queue.push(...list); drainGeo();
    return list.length;
};
app.post('/api/admin/crm/geocode', async (req, res) => {
    const ctx = await S.requireAdmin(req, res); if (!ctx) return;
    try {
        if (!(await S.p90Ready())) return res.status(409).json({ error: 'Run sql/schema-phase90.sql first: the leads have nowhere to keep their place yet.' });
        if (req.body && req.body.force) _geo.clear();
        const queued = await S.geocodeBackfill({ force: !!(req.body && req.body.force) });
        res.json({ queued, seconds: Math.ceil(queued * 1.2) });
    } catch (e) { fail(res, e, 'crm_geocode'); }
});
