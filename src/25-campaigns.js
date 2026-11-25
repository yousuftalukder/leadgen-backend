/**
 * Phase 90: email campaigns. A campaign is who it is for (an audience of leads by category, industry, stage and
 * pipeline), a list of steps (email, call, task) each a number of days after the one before, and sending rules (the
 * mailbox's window and daily cap). Enrolled leads walk the steps on their own:
 *
 *   email   sent from the connected mailbox inside the sending window, under the daily cap, with an unsubscribe link
 *   call    a call task for the lead's owner, due that day: it is on the Overview and the lead's next step
 *   task    any other to-do for the owner
 *
 * A lead leaves a campaign when it replies or moves on in the pipeline (stop rules), unsubscribes, has no email for
 * an email step, or finishes. Nothing is ever sent while the campaign is paused, the mailbox is not connected, or the
 * phase-90 SQL has not run. The mailbox is SMTP (a Google Workspace app password works); its password is encrypted.
 *
 * Plain functions on S (cleanSteps, cleanAudience, matchAudience, renderTemplate, nextSendAt, unsubToken) are what
 * tests/phase90.test.js checks.
 */
'use strict';
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const S = require('./shared');
const { app, logger, supabase } = S;

const MAX_STEPS = 20;
const PUBLIC_API = String(process.env.PUBLIC_API_URL || process.env.PHONE_PUBLIC_URL || 'https://leadgen-backend-1-mgzc.onrender.com').replace(/\/+$/, '');
const STOP_STAGES = ['replied', 'meeting', 'proposal', 'won', 'lost'];
const DEFAULT_WINDOW = { from: 9, to: 17, days: [1, 2, 3, 4, 5] };   // 9 AM to 5 PM, Monday to Friday, in the business time zone

const bad = m => Object.assign(new Error(m), { statusCode: 400 });
// Phase 93: email campaigns are the owner's to hand out (Admin → Team). Public unsubscribe and open links are elsewhere.
const campaignGate = async (req, res, next) => {
    try {
        const ctx = await S.auth(req, res); if (!ctx) return;
        if (S.needFeature && !(await S.needFeature(ctx, res, 'campaigns'))) return;
        next();
    } catch (e) { next(e); }
};
app.use('/api/crm/campaigns', campaignGate);
app.use('/api/crm/templates', campaignGate);
const str = (v, max) => (v === undefined || v === null) ? null : (String(v).trim().slice(0, max) || null);
const rid = () => crypto.randomBytes(6).toString('hex');

// ---------------------------------------------------------------------------------------------------
// plain functions
// ---------------------------------------------------------------------------------------------------
/** Steps as the builder sends them, checked: an email needs a subject and words, a call or task needs a title. */
function cleanSteps(steps, { strict = false } = {}) {
    if (!Array.isArray(steps)) throw bad('Steps must be a list.');
    if (steps.length > MAX_STEPS) throw bad(`A campaign has ${MAX_STEPS} steps at most.`);
    return steps.map((s, i) => {
        const type = ['email', 'call', 'task'].includes(s && s.type) ? s.type : null;
        if (!type) throw bad(`Step ${i + 1}: pick email, call or task.`);
        const delay = Math.round(Number(s.delay));
        const out = { id: str(s.id, 24) || rid(), type, delay: Number.isFinite(delay) && delay >= 0 && delay <= 90 ? delay : (i ? 2 : 0) };
        if (type === 'email') {
            out.subject = str(s.subject, 300) || '';
            out.body = String(s.body || '').replace(/\r\n/g, '\n').slice(0, 20000);
            out.templateId = S.UUID_RE.test(String(s.templateId || '')) ? s.templateId : null;
            out.thread = s.thread === true;   // send as a reply in the same thread as the email before
            if (strict && (!out.subject && !out.thread)) throw bad(`Step ${i + 1}: the email needs a subject.`);
            if (strict && !out.body.trim()) throw bad(`Step ${i + 1}: the email needs something to say.`);
        } else {
            out.title = str(s.title, 200) || (type === 'call' ? 'Call {{first_name}} at {{company}}' : '');
            if (strict && !out.title) throw bad(`Step ${i + 1}: say what the task is.`);
        }
        return out;
    });
}
/** Who a campaign is for. Empty lists mean "any". */
function cleanAudience(a) {
    a = a || {};
    const list = (v, ok) => [...new Set((Array.isArray(v) ? v : []).map(x => String(x).trim()).filter(x => x && (!ok || ok(x))))].slice(0, 60);
    return {
        sources: list(a.sources, x => S.CRM_SOURCES.some(s => s.key === x)),
        industries: list(a.industries).map(S.cleanIndustry).filter(Boolean),
        stages: list(a.stages, x => S.CRM_STAGES.some(s => s.key === x)),
        pipeline: ['in', 'out'].includes(a.pipeline) ? a.pipeline : 'any',
        owners: list(a.owners, x => S.UUID_RE.test(x)),
        tags: list(a.tags).slice(0, 10)
    };
}
function cleanSettings(v) {
    v = v || {};
    return { stopOnReply: v.stopOnReply !== false, stopOnStage: v.stopOnStage !== false, track: v.track !== false };
}
/** Does a lead belong in the audience? It must have an email, not be unsubscribed, and match every filter set. */
function matchAudience(l, a) {
    if (!l || !l.email_norm && !l.email || l.unsubscribed) return false;
    if (['won', 'lost'].includes(l.stage) && !(a.stages || []).includes(l.stage)) return false;
    if (a.sources.length && !a.sources.includes(l.source)) return false;
    if (a.industries.length && !a.industries.some(i => i.toLowerCase() === String(l.industry || '').toLowerCase())) return false;
    if (a.stages.length && !a.stages.includes(l.stage)) return false;
    if (a.pipeline === 'in' && !l.in_pipeline) return false;
    if (a.pipeline === 'out' && l.in_pipeline) return false;
    if (a.owners.length && !a.owners.includes(l.owner_id)) return false;
    if (a.tags.length && !(l.tags || []).some(t => a.tags.includes(t))) return false;
    return true;
}
/** {{first_name}}, {{company}}, {{city}}, {{industry}}, {{website}}, {{sender_name}}, with a fallback: {{first_name|there}}. */
function renderTemplate(text, lead = {}, sender = {}) {
    const first = String(lead.full_name || '').trim().split(/\s+/)[0] || '';
    const vars = { first_name: /^[-–—.]?$/.test(first) ? '' : first, name: lead.full_name || '', company: lead.company || '', city: lead.city || '', industry: lead.industry || '',
        website: lead.website || '', title: lead.title || '', sender_name: sender.name || '', sender_email: sender.email || '' };
    return String(text || '').replace(/\{\{\s*([a-z_]+)\s*(?:\|([^}]*))?\}\}/gi, (m, k, dflt) => {
        const v = vars[k.toLowerCase()];
        return v ? v : (dflt !== undefined ? dflt.trim() : (k.toLowerCase() in vars ? '' : m));
    });
}
/**
 * When a step may go: `after` plus `delayDays`, moved forward into the sending window (its hours and weekdays, in the
 * business time zone). Calls and tasks are due at the window's opening on that day too, so they land in the work day.
 */
function nextSendAt(after, delayDays, window = DEFAULT_WINDOW, tz = 'America/Chicago') {
    const w = { from: window.from ?? 9, to: window.to ?? 17, days: Array.isArray(window.days) && window.days.length ? window.days : [1, 2, 3, 4, 5] };
    let t = new Date(new Date(after).getTime() + (delayDays || 0) * 864e5);
    for (let i = 0; i < 24 * 14; i++) {
        const off = S.tzOffset(tz, t), local = new Date(t.getTime() + off * 60000);
        const dow = local.getUTCDay(), hour = local.getUTCHours();
        if (w.days.includes(dow) && hour >= w.from && hour < w.to) return t;
        // jump to the next opening: the window's first hour today if before it, else tomorrow's
        const next = new Date(local); next.setUTCMinutes(0, 0, 0);
        if (hour < w.from && w.days.includes(dow)) next.setUTCHours(w.from);
        else { next.setUTCDate(next.getUTCDate() + 1); next.setUTCHours(w.from); }
        t = new Date(next.getTime() - S.tzOffset(tz, next) * 60000);
    }
    return t;
}
const unsubSecret = () => process.env.APP_ENCRYPTION_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || 'edgelead';
/** A link that unsubscribes one lead and cannot be guessed for another. */
function unsubToken(leadId) {
    const sig = crypto.createHmac('sha256', unsubSecret()).update('unsub:' + leadId).digest('base64url').slice(0, 22);
    return Buffer.from(String(leadId)).toString('base64url') + '.' + sig;
}
function readUnsubToken(tok) {
    const [a, sig] = String(tok || '').split('.');
    if (!a || !sig) return null;
    let id; try { id = Buffer.from(a, 'base64url').toString(); } catch { return null; }
    const want = unsubToken(id).split('.')[1];
    return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want)) ? id : null;
}
/** How many emails each tick may send: the daily cap spread over the window's minutes, at least one, at most ten. */
function perTick(cap, window, tickMinutes = 2) {
    const mins = Math.max(60, ((window.to ?? 17) - (window.from ?? 9)) * 60);
    return Math.max(1, Math.min(10, Math.ceil(cap * tickMinutes / mins)));
}
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** A plain-looking HTML email: paragraphs and links from the text, the signature, the footer, the open pixel. */
function emailHtml(text, { footer, pixel }) {
    const body = esc(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').split(/\n{2,}/).map(p => `<p style="margin:0 0 12px">${p.replace(/\n/g, '<br>')}</p>`).join('');
    return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#111">${body}<p style="margin:18px 0 0;font-size:11px;color:#888">${footer}</p>${pixel ? `<img src="${pixel}" width="1" height="1" alt="" style="display:block;border:0">` : ''}</div>`;
}
Object.assign(S, { cleanSteps, cleanAudience, matchAudience, renderTemplate, nextSendAt, unsubToken, readUnsubToken, perTick, emailHtml, cleanCampaignSettings: cleanSettings });

// ---------------------------------------------------------------------------------------------------
// the mailbox
// ---------------------------------------------------------------------------------------------------
async function mailbox() {
    const m = await S.getSetting('crm_mailbox', null);
    return m && typeof m === 'object' ? m : null;
}
function cleanMailbox(b, prev) {
    const bw = b.window || {}, pw = (prev && prev.window) || {};
    const port = Math.round(Number(b.port || (prev && prev.port) || 465));
    const out = {
        host: str(b.host, 120) || (prev && prev.host) || 'smtp.gmail.com', port: [25, 465, 587, 2525].includes(port) ? port : 465,
        user: str(b.user, 200) || (prev && prev.user) || null, fromName: str(b.fromName, 80) || (prev && prev.fromName) || null,
        fromEmail: str(b.fromEmail, 200) || str(b.user, 200) || (prev && prev.fromEmail) || null, replyTo: str(b.replyTo, 200),
        signature: String(b.signature ?? (prev && prev.signature) ?? '').slice(0, 2000), address: str(b.address, 300) || (prev && prev.address) || null,
        dailyCap: Math.max(1, Math.min(2000, Math.round(Number(b.dailyCap ?? (prev && prev.dailyCap) ?? 50)) || 50)),
        window: { from: Math.max(0, Math.min(23, Math.round(Number(bw.from ?? pw.from ?? 9)))), to: Math.max(1, Math.min(24, Math.round(Number(bw.to ?? pw.to ?? 17)))),
            days: (Array.isArray(bw.days) ? bw.days : Array.isArray(pw.days) ? pw.days : [1, 2, 3, 4, 5]).map(Number).filter(d => d >= 0 && d <= 6) },
        paused: b.paused === undefined ? !!(prev && prev.paused) : b.paused === true,
        pass: prev && prev.pass || null
    };
    if (out.window.to <= out.window.from) throw bad('The sending window ends before it starts.');
    if (!out.window.days.length) throw bad('Pick at least one day to send on.');
    if (b.pass) out.pass = S.encryptSecret(String(b.pass).replace(/\s+/g, ''));   // Google shows app passwords with spaces
    if (out.fromEmail && !S.normEmail(out.fromEmail)) throw bad('The from address does not look right.');
    return out;
}
const _tx = { key: null, t: null };
function transport(m) {
    const key = [m.host, m.port, m.user, m.pass].join('|');
    if (_tx.key !== key) _tx.t = nodemailer.createTransport({ host: m.host, port: m.port, secure: m.port === 465, auth: { user: m.user, pass: S.decryptSecret(m.pass) }, pool: true, maxConnections: 1 });
    _tx.key = key; return _tx.t;
}
async function sentToday() {
    const st = await S.crmSettings();
    const day = S.dayBounds(st.timezone, 'today');
    const { count } = await supabase.from('crm_emails').select('id', { count: 'exact', head: true }).eq('status', 'sent').gte('sent_at', day.start.toISOString());
    return count || 0;
}
S.mailboxState = async () => {
    const m = await mailbox();
    if (!m || !m.user || !m.pass) return { connected: false };
    return { connected: true, fromEmail: m.fromEmail, fromName: m.fromName, dailyCap: m.dailyCap, paused: !!m.paused, window: m.window };
};

// ---------------------------------------------------------------------------------------------------
// routes: staff
// ---------------------------------------------------------------------------------------------------
async function staff(req, res) {
    const ctx = await S.auth(req, res); if (!ctx) return null;
    if (S.staffOnly && !S.staffOnly(ctx, res)) return null;
    if (!(await S.p90Ready())) { res.status(409).json({ error: 'Email campaigns need sql/schema-phase90.sql. The owner runs it once in Supabase.', code: 'phase90_sql' }); return null; }
    return ctx;
}
function fail(res, e, where) {
    if (e && (e.statusCode === 400 || e.statusCode === 503)) return res.status(e.statusCode).json({ error: e.message });
    logger.error(where, { message: e && e.message });
    return res.status(500).json({ error: 'Something went wrong on our side. Try again in a moment.' });
}
async function allLeads(cols = 'id, full_name, company, email, email_norm, city, industry, website, title, source, stage, in_pipeline, owner_id, tags, unsubscribed') {
    return S.selectAll('crm_leads', cols, q => q, { max: 20000 });
}

// templates
app.get('/api/crm/templates', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    const { data, error } = await supabase.from('crm_email_templates').select('*').order('updated_at', { ascending: false }).limit(500);
    if (error) return fail(res, error, 'tpl_list');
    res.json({ templates: data || [] });
});
function cleanTemplate(b) {
    const name = str(b.name, 120); if (!name) throw bad('Name the template.');
    return { name, subject: str(b.subject, 300) || '', body: String(b.body || '').slice(0, 20000),
        source: S.CRM_SOURCES.some(s => s.key === b.source) ? b.source : null, industry: S.cleanIndustry(b.industry) };
}
app.post('/api/crm/templates', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        const { data, error } = await supabase.from('crm_email_templates').insert({ ...cleanTemplate(req.body || {}), created_by: ctx.user.id }).select('*').single();
        if (error) throw error; res.status(201).json({ template: data });
    } catch (e) { fail(res, e, 'tpl_create'); }
});
app.patch('/api/crm/templates/:id', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        const { data, error } = await supabase.from('crm_email_templates').update({ ...cleanTemplate(req.body || {}), updated_at: new Date().toISOString() }).eq('id', req.params.id).select('*').maybeSingle();
        if (error) throw error; if (!data) return res.status(404).json({ error: 'Template not found.' });
        res.json({ template: data });
    } catch (e) { fail(res, e, 'tpl_update'); }
});
app.delete('/api/crm/templates/:id', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    const { error } = await supabase.from('crm_email_templates').delete().eq('id', req.params.id);
    if (error) return fail(res, error, 'tpl_delete');
    res.json({ ok: true });
});

// campaigns
async function stats(ids) {
    const out = Object.fromEntries(ids.map(id => [id, { enrolled: 0, active: 0, done: 0, replied: 0, stopped: 0, unsubscribed: 0, failed: 0, sent: 0, opened: 0 }]));
    if (!ids.length) return out;
    const [{ data: en }, { data: em }] = await Promise.all([
        S.selectAll('crm_enrollments', 'id, campaign_id, status', q => q.in('campaign_id', ids)).then(data => ({ data })),
        S.selectAll('crm_emails', 'id, campaign_id, status, opened_at', q => q.in('campaign_id', ids), { max: 200000 }).then(data => ({ data }))]);
    for (const e of en || []) { const s = out[e.campaign_id]; s.enrolled++; if (s[e.status] !== undefined) s[e.status]++; if (e.status === 'bounced') s.failed++; }
    for (const m of em || []) { const s = out[m.campaign_id]; if (m.status === 'sent') s.sent++; if (m.opened_at) s.opened++; }
    return out;
}
app.get('/api/crm/campaigns', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        const { data, error } = await supabase.from('crm_campaigns').select('*').neq('status', 'archived').order('updated_at', { ascending: false }).limit(200);
        if (error) throw error;
        const st = await stats((data || []).map(c => c.id));
        res.json({ campaigns: (data || []).map(c => ({ ...c, stats: st[c.id] })), mailbox: await S.mailboxState(), sentToday: await sentToday() });
    } catch (e) { fail(res, e, 'campaign_list'); }
});
app.get('/api/crm/campaigns/:id', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        const { data: c } = await supabase.from('crm_campaigns').select('*').eq('id', req.params.id).maybeSingle();
        if (!c) return res.status(404).json({ error: 'Campaign not found.' });
        const { data: en } = await supabase.from('crm_enrollments').select('id, lead_id, status, step, next_at, last_at, sent, stop_reason, created_at').eq('campaign_id', c.id).order('created_at', { ascending: false }).limit(1000);
        const ids = (en || []).map(e => e.lead_id);
        const leads = [];
        for (let i = 0; i < ids.length; i += 200) { const { data } = await supabase.from('crm_leads').select('id, full_name, company, email, industry, stage').in('id', ids.slice(i, i + 200)); leads.push(...(data || [])); }
        const byId = new Map(leads.map(l => [l.id, l]));
        const st = await stats([c.id]);
        res.json({ campaign: { ...c, stats: st[c.id] }, enrollments: (en || []).map(e => ({ ...e, lead: byId.get(e.lead_id) || null })) });
    } catch (e) { fail(res, e, 'campaign_get'); }
});
app.post('/api/crm/campaigns', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        const b = req.body || {};
        const name = str(b.name, 120); if (!name) throw bad('Name the campaign.');
        const row = { name, audience: cleanAudience(b.audience), steps: cleanSteps(b.steps || []), settings: cleanSettings(b.settings), created_by: ctx.user.id };
        const { data, error } = await supabase.from('crm_campaigns').insert(row).select('*').single(); if (error) throw error;
        res.status(201).json({ campaign: data });
    } catch (e) { fail(res, e, 'campaign_create'); }
});
app.patch('/api/crm/campaigns/:id', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        const b = req.body || {};
        const { data: c } = await supabase.from('crm_campaigns').select('id, status').eq('id', req.params.id).maybeSingle();
        if (!c) return res.status(404).json({ error: 'Campaign not found.' });
        const patch = { updated_at: new Date().toISOString() };
        if (b.name !== undefined) { patch.name = str(b.name, 120); if (!patch.name) throw bad('Name the campaign.'); }
        if (b.audience !== undefined) patch.audience = cleanAudience(b.audience);
        if (b.steps !== undefined) patch.steps = cleanSteps(b.steps, { strict: c.status === 'active' });
        if (b.settings !== undefined) patch.settings = cleanSettings(b.settings);
        const { data, error } = await supabase.from('crm_campaigns').update(patch).eq('id', c.id).select('*').single(); if (error) throw error;
        res.json({ campaign: data });
    } catch (e) { fail(res, e, 'campaign_update'); }
});
app.post('/api/crm/campaigns/:id/status', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        const to = String(req.body && req.body.status || '');
        if (!['active', 'paused', 'archived', 'draft'].includes(to)) throw bad('Status is active, paused or archived.');
        const { data: c } = await supabase.from('crm_campaigns').select('*').eq('id', req.params.id).maybeSingle();
        if (!c) return res.status(404).json({ error: 'Campaign not found.' });
        if (to === 'active') {
            cleanSteps(c.steps, { strict: true });
            if (!c.steps.length) throw bad('Add at least one step before starting.');
            if (c.steps.some(s => s.type === 'email') && !(await S.mailboxState()).connected) throw bad('Connect the mailbox first: Admin → Email.');
        }
        const patch = { status: to, updated_at: new Date().toISOString(), ...(to === 'active' && !c.activated_at ? { activated_at: new Date().toISOString() } : {}) };
        const { data, error } = await supabase.from('crm_campaigns').update(patch).eq('id', c.id).select('*').single(); if (error) throw error;
        logger.info('campaign_status', { by: ctx.user.id, campaign: c.id, to });
        res.json({ campaign: data });
    } catch (e) { fail(res, e, 'campaign_status'); }
});
app.delete('/api/crm/campaigns/:id', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    const { data: c } = await supabase.from('crm_campaigns').select('id, status').eq('id', req.params.id).maybeSingle();
    if (!c) return res.status(404).json({ error: 'Campaign not found.' });
    const { count } = await supabase.from('crm_emails').select('id', { count: 'exact', head: true }).eq('campaign_id', c.id);
    // A campaign that sent nothing is deleted; one that sent mail is archived, so its history stays on the leads.
    const { error } = count ? await supabase.from('crm_campaigns').update({ status: 'archived', updated_at: new Date().toISOString() }).eq('id', c.id) : await supabase.from('crm_campaigns').delete().eq('id', c.id);
    if (error) return fail(res, error, 'campaign_delete');
    res.json({ ok: true, archived: !!count });
});
/** Who the audience is right now: how many, a sample, and how many are left out and why. */
app.post('/api/crm/campaigns/audience', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        const a = cleanAudience(req.body && req.body.audience);
        const leads = await allLeads();
        const hit = leads.filter(l => matchAudience(l, a));
        const loose = leads.filter(l => matchAudience({ ...l, email: 'x', email_norm: 'x', unsubscribed: false }, a));
        res.json({ count: hit.length, noEmail: loose.filter(l => !l.email_norm && !l.email).length, unsubscribed: loose.filter(l => l.unsubscribed).length,
            sample: hit.slice(0, 12).map(l => ({ id: l.id, full_name: l.full_name, company: l.company, email: l.email, industry: l.industry, city: l.city })) });
    } catch (e) { fail(res, e, 'campaign_audience'); }
});
/** Put leads on a campaign: everyone in its audience, or the leads picked. Leads already on it are left as they are. */
app.post('/api/crm/campaigns/:id/enroll', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        const { data: c } = await supabase.from('crm_campaigns').select('*').eq('id', req.params.id).maybeSingle();
        if (!c) return res.status(404).json({ error: 'Campaign not found.' });
        if (!c.steps.length) throw bad('Add the steps before adding people.');
        const leads = await allLeads();
        const want = Array.isArray(req.body && req.body.leadIds) ? new Set(req.body.leadIds.map(String)) : null;
        const pick = leads.filter(l => (want ? want.has(l.id) : true) && matchAudience(l, want ? cleanAudience({ stages: S.CRM_STAGES.map(s => s.key) }) : cleanAudience(c.audience)));
        const have = await S.selectAll('crm_enrollments', 'id, lead_id', q => q.eq('campaign_id', c.id));
        const on = new Set((have || []).map(h => h.lead_id));
        const fresh = pick.filter(l => !on.has(l.id));
        const box = (await mailbox()) || {};
        const { timezone } = await S.crmSettings();
        const first = nextSendAt(new Date(), c.steps[0].delay || 0, box.window || DEFAULT_WINDOW, timezone).toISOString();
        for (let i = 0; i < fresh.length; i += 500) {
            const { error } = await supabase.from('crm_enrollments').insert(fresh.slice(i, i + 500).map(l => ({ campaign_id: c.id, lead_id: l.id, status: 'active', step: 0, next_at: first, enrolled_by: ctx.user.id })));
            if (error) throw error;
        }
        if (fresh.length) await supabase.from('crm_activities').insert(fresh.map(l => ({ lead_id: l.id, type: 'system', body: `Added to the campaign "${c.name}"`, meta: { campaign: c.id }, actor_id: ctx.user.id })));
        res.json({ added: fresh.length, already: pick.length - fresh.length, skipped: (want ? want.size : leads.length) - pick.length });
    } catch (e) { fail(res, e, 'campaign_enroll'); }
});
app.post('/api/crm/campaigns/:id/enrollments/:eid/stop', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    const { error } = await supabase.from('crm_enrollments').update({ status: 'stopped', stop_reason: 'Stopped by hand', next_at: null }).eq('id', req.params.eid).eq('campaign_id', req.params.id);
    if (error) return fail(res, error, 'enrollment_stop');
    res.json({ ok: true });
});
/** Send one step to yourself, filled in with a real lead's details, to see it as they will. */
app.post('/api/crm/campaigns/:id/test', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        const m = await mailbox(); if (!m || !m.pass) throw bad('Connect the mailbox first: Admin → Email.');
        const { data: c } = await supabase.from('crm_campaigns').select('*').eq('id', req.params.id).maybeSingle();
        if (!c) return res.status(404).json({ error: 'Campaign not found.' });
        const step = (c.steps || []).find(s => s.id === req.body.stepId) || (c.steps || []).find(s => s.type === 'email');
        if (!step || step.type !== 'email') throw bad('There is no email step to send.');
        const { data: lead } = req.body.leadId ? await supabase.from('crm_leads').select('*').eq('id', req.body.leadId).maybeSingle() : { data: null };
        const sample = lead || { full_name: 'Alex Rivera', company: 'Rivera Roofing', city: 'Houston', industry: 'Roofing', website: 'riveraroofing.com' };
        const to = ctx.user.email;
        const sender = { name: m.fromName || '', email: m.fromEmail || m.user };
        const text = renderTemplate(step.body, sample, sender) + (m.signature ? '\n\n' + renderTemplate(m.signature, sample, sender) : '');
        await transport(m).sendMail({ from: m.fromName ? `"${m.fromName}" <${m.fromEmail || m.user}>` : (m.fromEmail || m.user), to, subject: '[Test] ' + renderTemplate(step.subject, sample, sender), text,
            html: emailHtml(text, { footer: 'This is a test of a campaign step. Leads get an unsubscribe link here.', pixel: null }) });
        res.json({ ok: true, to });
    } catch (e) { fail(res, Object.assign(e, { statusCode: e.statusCode || 400 }), 'campaign_test'); }
});

// ---------------------------------------------------------------------------------------------------
// routes: the owner's mailbox settings
// ---------------------------------------------------------------------------------------------------
app.get('/api/admin/mailbox', async (req, res) => {
    const ctx = await S.requireAdmin(req, res); if (!ctx) return;
    const m = await mailbox();
    res.json({ mailbox: m ? { ...m, pass: undefined, hasPass: !!m.pass } : null, state: await S.mailboxState(), sentToday: (await S.p90Ready()) ? await sentToday() : 0, p90: await S.p90Ready() });
});
app.put('/api/admin/mailbox', async (req, res) => {
    const ctx = await S.requireAdmin(req, res); if (!ctx) return;
    try {
        const next = cleanMailbox(req.body || {}, await mailbox());
        if (req.body && req.body.verify !== false && next.user && next.pass) {
            try { await nodemailer.createTransport({ host: next.host, port: next.port, secure: next.port === 465, auth: { user: next.user, pass: S.decryptSecret(next.pass) } }).verify(); }
            catch (e) { throw bad('The mailbox refused the sign-in: ' + e.message + (/gmail|google/i.test(next.host) ? ' For Google Workspace, use an app password (Google account → Security → App passwords).' : '')); }
        }
        await S.putSetting('crm_mailbox', next); _tx.key = null;
        logger.info('mailbox_saved', { by: ctx.user.id, host: next.host, user: next.user });
        res.json({ mailbox: { ...next, pass: undefined, hasPass: !!next.pass }, state: await S.mailboxState() });
    } catch (e) { fail(res, e, 'mailbox_save'); }
});
app.delete('/api/admin/mailbox', async (req, res) => {
    const ctx = await S.requireAdmin(req, res); if (!ctx) return;
    const m = await mailbox();
    await S.putSetting('crm_mailbox', m ? { ...m, pass: null } : null); _tx.key = null;
    res.json({ ok: true });
});

// ---------------------------------------------------------------------------------------------------
// public: unsubscribe and the open pixel
// ---------------------------------------------------------------------------------------------------
async function unsubscribe(leadId) {
    await supabase.from('crm_leads').update({ unsubscribed: true, updated_at: new Date().toISOString() }).eq('id', leadId);
    await supabase.from('crm_enrollments').update({ status: 'unsubscribed', next_at: null, stop_reason: 'Unsubscribed' }).eq('lead_id', leadId).eq('status', 'active');
    await supabase.from('crm_activities').insert({ lead_id: leadId, type: 'system', body: 'Unsubscribed from emails', meta: {} });
}
app.get('/api/public/unsub/:token', async (req, res) => {
    const id = readUnsubToken(req.params.token);
    const page = (t, b) => res.type('html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t}</title><div style="font:16px/1.6 system-ui,sans-serif;max-width:440px;margin:18vh auto;padding:0 20px;color:#222"><h1 style="font-size:22px">${t}</h1><p>${b}</p></div>`);
    if (!id) return page('That link is not right', 'It may have been cut short when it was copied.');
    try { await unsubscribe(id); } catch (e) { logger.warn('unsub_failed', { message: e.message }); }
    page('You are unsubscribed', 'You will not get any more emails from us. Sorry for the bother.');
});
app.post('/api/public/unsub/:token', async (req, res) => {   // one-click unsubscribe (RFC 8058) from the mail app's own button
    const id = readUnsubToken(req.params.token);
    if (id) await unsubscribe(id).catch(() => {});
    res.status(id ? 200 : 400).end();
});
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
app.get('/api/public/o/:id', async (req, res) => {
    res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' }).send(PIXEL);
    const id = String(req.params.id || '').replace(/\.gif$/, '');
    if (!S.UUID_RE.test(id)) return;
    const { data } = await supabase.from('crm_emails').select('id, opens, opened_at').eq('id', id).maybeSingle();
    if (data) await supabase.from('crm_emails').update({ opens: (data.opens || 0) + 1, opened_at: data.opened_at || new Date().toISOString() }).eq('id', id);
});

// ---------------------------------------------------------------------------------------------------
// stopping: a reply, or the lead moved on in the pipeline
// ---------------------------------------------------------------------------------------------------
S.campaignStageChanged = async (leadId, stage) => {
    if (!STOP_STAGES.includes(stage) || !(await S.p90Ready())) return;
    const { data: en } = await supabase.from('crm_enrollments').select('id, campaign_id').eq('lead_id', leadId).eq('status', 'active');
    if (!en || !en.length) return;
    const { data: cs } = await supabase.from('crm_campaigns').select('id, settings').in('id', en.map(e => e.campaign_id));
    const rules = new Map((cs || []).map(c => [c.id, cleanSettings(c.settings)]));
    for (const e of en) {
        const r = rules.get(e.campaign_id) || cleanSettings({});
        if (stage === 'replied' ? r.stopOnReply : r.stopOnStage) {
            await supabase.from('crm_enrollments').update({ status: stage === 'replied' ? 'replied' : 'stopped', next_at: null, stop_reason: stage === 'replied' ? 'Replied' : `Moved to ${stage}` }).eq('id', e.id).eq('status', 'active');
        }
    }
};

// ---------------------------------------------------------------------------------------------------
// the sender: every two minutes, the steps that are due
// ---------------------------------------------------------------------------------------------------
let _ticking = false;
S.campaignTick = async () => {
    if (_ticking || !(await S.p90Ready())) return { skipped: true };
    _ticking = true;
    const done = { sent: 0, tasks: 0, stopped: 0, failed: 0 };
    try {
        const now = new Date();
        const { data: due } = await supabase.from('crm_enrollments').select('id, campaign_id, lead_id, step, next_at, sent').eq('status', 'active').lte('next_at', now.toISOString()).order('next_at').limit(200);
        if (!due || !due.length) return done;
        const { data: cs } = await supabase.from('crm_campaigns').select('*').in('id', [...new Set(due.map(d => d.campaign_id))]).eq('status', 'active');
        const camp = new Map((cs || []).map(c => [c.id, c]));
        const box = await mailbox();
        const boxOk = !!(box && box.user && box.pass && !box.paused);
        const { timezone } = await S.crmSettings();
        const window = (box && box.window) || DEFAULT_WINDOW;
        let budget = boxOk ? Math.min(perTick(box.dailyCap, window), Math.max(0, box.dailyCap - await sentToday())) : 0;
        for (const e of due) {
            const c = camp.get(e.campaign_id); if (!c) continue;   // paused or archived: it waits
            const step = (c.steps || [])[e.step];
            if (!step) { await supabase.from('crm_enrollments').update({ status: 'done', next_at: null }).eq('id', e.id); continue; }
            if (step.type === 'email' && (!boxOk || budget <= 0)) continue;   // the mailbox is off or the day's cap is spent: next tick
            // Claim it: another server instance may be ticking too. Only the one whose update matches the old next_at wins.
            const hold = new Date(now.getTime() + 10 * 60000).toISOString();
            const { data: got } = await supabase.from('crm_enrollments').update({ next_at: hold }).eq('id', e.id).eq('next_at', e.next_at).eq('status', 'active').select('id');
            if (!got || !got.length) continue;
            const { data: lead } = await supabase.from('crm_leads').select('id, full_name, company, email, email_norm, city, industry, website, title, owner_id, unsubscribed, stage').eq('id', e.lead_id).maybeSingle();
            const finish = async (status, reason) => { await supabase.from('crm_enrollments').update({ status, next_at: null, stop_reason: reason }).eq('id', e.id); done.stopped++; };
            if (!lead) { await finish('stopped', 'The lead was deleted'); continue; }
            const set = cleanSettings(c.settings);
            if (set.stopOnStage && STOP_STAGES.includes(lead.stage)) { await finish(lead.stage === 'replied' ? 'replied' : 'stopped', `Moved to ${lead.stage}`); continue; }
            try {
                if (step.type === 'email') {
                    if (lead.unsubscribed) { await finish('unsubscribed', 'Unsubscribed'); continue; }
                    if (!lead.email) { await finish('stopped', 'No email address'); continue; }
                    const sender = { name: box.fromName || '', email: box.fromEmail || box.user };
                    const prevSubject = step.thread ? (((c.steps || []).slice(0, e.step).reverse().find(s => s.type === 'email') || {}).subject || '') : '';
                    const subject = step.thread && prevSubject ? 'Re: ' + renderTemplate(prevSubject, lead, sender) : renderTemplate(step.subject, lead, sender);
                    const text = renderTemplate(step.body, lead, sender) + (box.signature ? '\n\n' + renderTemplate(box.signature, lead, sender) : '');
                    const { data: row } = await supabase.from('crm_emails').insert({ campaign_id: c.id, enrollment_id: e.id, lead_id: lead.id, step: e.step, to_email: lead.email, subject, body: text, status: 'sent' }).select('id').single();
                    const unsub = `${PUBLIC_API}/api/public/unsub/${unsubToken(lead.id)}`;
                    const footer = `${box.address ? esc(box.address) + ' · ' : ''}<a href="${unsub}" style="color:#888">Unsubscribe</a>`;
                    try {
                        const info = await transport(box).sendMail({
                            from: box.fromName ? `"${box.fromName}" <${box.fromEmail || box.user}>` : (box.fromEmail || box.user), to: lead.email, subject,
                            replyTo: box.replyTo || undefined, text: text + `\n\n--\nUnsubscribe: ${unsub}`,
                            html: emailHtml(text, { footer, pixel: set.track ? `${PUBLIC_API}/api/public/o/${row.id}.gif` : null }),
                            headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
                        });
                        await supabase.from('crm_emails').update({ message_id: info && info.messageId || null }).eq('id', row.id);
                        await supabase.from('crm_activities').insert({ lead_id: lead.id, type: 'email_out', body: text.slice(0, 5000), meta: { campaign: c.id, campaignName: c.name, step: e.step, emailId: row.id, subject }, actor_id: null });
                        if (S.refreshOutreach) await S.refreshOutreach(lead.id);   // phase 91: the Leads page shows who was emailed
                        await supabase.from('crm_leads').update({ last_activity_at: new Date().toISOString(), ...(lead.stage === 'new' ? { stage: 'contacted', stage_at: new Date().toISOString() } : {}) }).eq('id', lead.id);
                        budget--; done.sent++;
                    } catch (err) {
                        await supabase.from('crm_emails').update({ status: 'failed', error: String(err.message).slice(0, 300) }).eq('id', row.id);
                        const permanent = /^5\d\d|user unknown|does not exist|no such user|mailbox unavailable/i.test(String(err.responseCode || '') + ' ' + err.message);
                        if (permanent) { await finish('bounced', 'The address bounced: ' + String(err.message).slice(0, 120)); continue; }
                        if (err.code === 'EAUTH') { logger.error('mailbox_auth_failed', { message: err.message }); break; }   // the whole mailbox is refused: stop this tick
                        await supabase.from('crm_enrollments').update({ next_at: new Date(Date.now() + 30 * 60000).toISOString() }).eq('id', e.id);   // try again in half an hour
                        done.failed++; continue;
                    }
                } else {
                    const title = renderTemplate(step.title, lead, {});
                    const dueAt = new Date().toISOString();
                    await supabase.from('crm_tasks').insert({ lead_id: lead.id, title, due_at: dueAt, owner_id: lead.owner_id || c.created_by, created_by: c.created_by, kind: step.type === 'call' ? 'call' : 'todo', enrollment_id: e.id });
                    await supabase.from('crm_leads').update({ next_step: title, next_step_at: dueAt }).eq('id', lead.id);
                    done.tasks++;
                }
                const nextIdx = e.step + 1, next = (c.steps || [])[nextIdx];
                await supabase.from('crm_enrollments').update(next
                    ? { step: nextIdx, last_at: new Date().toISOString(), sent: (e.sent || 0) + (step.type === 'email' ? 1 : 0), next_at: nextSendAt(new Date(), next.delay || 0, window, timezone).toISOString() }
                    : { step: nextIdx, last_at: new Date().toISOString(), sent: (e.sent || 0) + (step.type === 'email' ? 1 : 0), status: 'done', next_at: null }).eq('id', e.id);
            } catch (err) {
                logger.error('campaign_step_failed', { enrollment: e.id, message: err.message });
                await supabase.from('crm_enrollments').update({ next_at: new Date(Date.now() + 30 * 60000).toISOString() }).eq('id', e.id);
                done.failed++;
            }
        }
        if (done.sent || done.tasks || done.failed) logger.info('campaign_tick', done);
        return done;
    } catch (e) { logger.error('campaign_tick_failed', { message: e.message }); return done; }
    finally { _ticking = false; }
};
