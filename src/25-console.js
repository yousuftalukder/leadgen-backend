'use strict';
/**
 * Phase 94: the Overview as an operations console.
 *
 *   GET /api/crm/console   Everything the Overview draws, in one answer: today and the last 14 days, the goals, the
 *                          systems (phone line, mailbox, campaign sender, the map), up next, what needs a person, the
 *                          pipeline, the lead flow, calls by hour, revenue by kind of job, departments, email
 *                          campaigns, the influencer network and the team (who is on a call now).
 *   GET /api/crm/pulse     What changed: the latest activity, today's counts and who is on a call. The page asks
 *                          every 30 seconds, only while the Overview is open and in view.
 *
 * Speed: the part everyone shares is built at most once every 20 seconds (the pulse every 10), whoever asks; only
 * Up next, the overdue call-backs and client tasks are per person. The page never downloads the lead list for it.
 *
 * Pure parts (tested): dayKeys, consoleSums, heatGrid, teamRows, feedItems, needsYou.
 */
const S = require('./shared');
const { app, supabase, logger } = S;

const PERIODS = [7, 30, 90];
const HOURS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
const STUCK_DAYS = 10;
const C = 'America/Chicago';

// ------------------------------------------------------------------ pure parts
const pad = n => String(n).padStart(2, '0');
// A day or an hour never changes inside a quarter of an hour, in any time zone (every offset is a multiple of 15
// minutes), so each is worked out once per quarter hour: thousands of activities cost a few hundred lookups.
const _day = new Map(), _hour = new Map();
function remember(map, key, make) { let v = map.get(key); if (v === undefined) { if (map.size > 50000) map.clear(); v = make(); map.set(key, v); } return v; }
const qh = at => Math.floor(new Date(at).getTime() / 9e5);
const ymd = (tz, at) => remember(_day, tz + '|' + qh(at), () => { const z = S.zoned(tz, new Date(at)); return `${z.y}-${pad(z.m)}-${pad(z.d)}`; });
const hourIn = (tz, at) => remember(_hour, tz + '|' + qh(at), () => S.zoned(tz, new Date(at)).h);
/** The last n days in the business's time zone, oldest first, as YYYY-MM-DD. */
function dayKeys(tz, n, now = new Date()) {
    const z = S.zoned(tz, now), out = [];
    for (let i = n - 1; i >= 0; i--) out.push(new Date(Date.UTC(z.y, z.m - 1, z.d - i)).toISOString().slice(0, 10));
    return out;
}
const meta = a => (a && a.meta) || {};
const isOutCall = a => a.type === 'call' && meta(a).direction !== 'inbound' && !meta(a).voicemail;
const talked = a => isOutCall(a) && !!meta(a).picked && meta(a).picked !== 'none';
const isMeeting = a => a.type === 'meeting' || (a.type === 'stage' && meta(a).to === 'meeting') || (a.type === 'call' && meta(a).outcomeKey === 'meeting');
/** Calls placed: the phone's own record of each outbound call, plus calls logged by hand that the phone does not know. */
const handCalls = acts => acts.filter(a => isOutCall(a) && !meta(a).sid);
const inPipe = (l, p90) => p90 ? !!l.in_pipeline || !!l.client_id : l.stage !== 'new';
const name = l => (l && (l.company || l.full_name)) || 'A lead';

/**
 * The numbers: today, the 14-day lines, the pipeline, the lead flow and the badges, from plain rows.
 *   leads [{ id, stage, stage_at, created_at, value, currency, in_pipeline, client_id, next_step_at, call_status, calls_count, last_call_outcome, … }]
 *   acts  crm_activities in the period (call, email_out, email_in, meeting, stage) with meta and actor_id
 *   calls phone_calls of the last 14 days (direction, started_at, user_id, …)
 */
function consoleSums({ leads = [], acts = [], calls = [], tz = C, now = new Date(), since, p90 = true, p91 = true }) {
    const days = dayKeys(tz, 14, now), today = days[13], idx = new Map(days.map((d, i) => [d, i]));
    const line = () => Array(14).fill(0);
    const spark = { calls: line(), conversations: line(), emails: line(), replies: line(), meetings: line(), won: line() };
    const at = (arr, when) => { const i = idx.get(ymd(tz, when)); if (i != null) arr[i]++; };
    for (const c of calls) if (c.direction === 'outbound') at(spark.calls, c.started_at);
    for (const a of handCalls(acts)) at(spark.calls, a.at);
    const meet = new Set();
    let owners = 0;
    for (const a of acts) {
        if (talked(a)) { at(spark.conversations, a.at); if (meta(a).picked === 'owner' && ymd(tz, a.at) === today) owners++; }
        else if (a.type === 'email_out') at(spark.emails, a.at);
        else if (a.type === 'email_in') at(spark.replies, a.at);
        if (isMeeting(a) && a.lead_id) { const d = ymd(tz, a.at), k = a.lead_id + '|' + d; if (!meet.has(k)) { meet.add(k); const i = idx.get(d); if (i != null) spark.meetings[i]++; } }
    }
    // Meetings this week and last, from the same set (each lead counted once a day).
    const t = new Date(now).getTime(), dayOf = k => new Date(k.split('|')[1] + 'T12:00:00Z').getTime();
    let meetWeek = 0, meetLast = 0;
    for (const k of meet) { const age = (t - dayOf(k)) / 864e5; if (age < 7) meetWeek++; else if (age < 14) meetLast++; }

    const z = S.zoned(tz, now), monthKey = `${z.y}-${pad(z.m)}`;
    let wonMonth = 0, wonMonthValue = 0;
    const stages = S.CRM_STAGES.filter(s => !['won', 'lost'].includes(s.key)).map(s => ({ key: s.key, label: s.label, n: 0, value: 0 }));
    const byStage = new Map(stages.map(s => [s.key, s]));
    let stuck = 0, cold = 0, pipeline = 0, due = 0;
    const stuckBefore = t - STUCK_DAYS * 864e5, tomorrow = S.dayBounds ? S.dayBounds(tz, 'today', now).end.getTime() : t + 864e5;
    for (const l of leads) {
        if (l.stage === 'won' && l.stage_at) { at(spark.won, l.stage_at); if (ymd(tz, l.stage_at).slice(0, 7) === monthKey) { wonMonth++; wonMonthValue += S.toBdt(l.value, l.currency); } }
        const client = !!l.client_id || l.stage === 'won', pipe = !client && l.stage !== 'lost' && inPipe(l, p90);
        if (!client && l.stage !== 'lost') { if (pipe) pipeline++; else cold++; }
        if (l.next_step_at && new Date(l.next_step_at).getTime() < tomorrow && !['won', 'lost'].includes(l.stage)) due++;
        if (!pipe) continue;
        const s = byStage.get(l.stage); if (!s) continue;
        s.n++; s.value += S.toBdt(l.value, l.currency);
        if (l.stage === 'contacted' && new Date(l.stage_at || l.updated_at || l.created_at).getTime() < stuckBefore) stuck++;
    }

    // The lead flow: the leads added in the period, and how far they got.
    const t0 = new Date(since).getTime();
    const cohort = leads.filter(l => new Date(l.created_at).getTime() >= t0);
    const ids = new Set(cohort.map(l => l.id));
    const calledIds = new Set(), talkedIds = new Set();
    for (const a of acts) if (ids.has(a.lead_id) && isOutCall(a)) { calledIds.add(a.lead_id); if (talked(a)) talkedIds.add(a.lead_id); }
    for (const c of calls) if (c.direction === 'outbound' && ids.has(c.lead_id)) calledIds.add(c.lead_id);
    const rank = k => S.CRM_STAGES.findIndex(s => s.key === k);
    const reached = (l, k) => l.stage !== 'lost' && rank(l.stage) >= rank(k);
    const flow = [
        ['added', 'Added', cohort.length],
        ['called', 'Called', cohort.filter(l => calledIds.has(l.id) || (p91 && l.calls_count > 0)).length],
        ['talked', 'Talked', cohort.filter(l => talkedIds.has(l.id) || (p91 && ['spoke', 'callback', 'in_play'].includes(l.call_status))).length],
        ['interested', 'Interested', cohort.filter(l => (p90 && l.in_pipeline) || (p91 && l.call_status === 'in_play') || reached(l, 'replied') || !!l.client_id).length],
        ['meeting', 'Meeting', cohort.filter(l => reached(l, 'meeting')).length],
        ['won', 'Won', cohort.filter(l => l.stage === 'won' || !!l.client_id).length]
    ].map(([key, label, n]) => ({ key, label, n }));

    const sum = a => a.reduce((x, y) => x + y, 0);
    return {
        days, spark,
        today: { calls: spark.calls[13], conversations: spark.conversations[13], owners, emails: spark.emails[13], replies: spark.replies[13],
                 meetingsWeek: meetWeek, meetingsLastWeek: meetLast, wonMonth, wonMonthValue, callsAvg: Math.round(sum(spark.calls.slice(0, 13)) / 13 * 10) / 10 },
        pipeline: { stages, open: sum(stages.map(s => s.n)), value: sum(stages.map(s => s.value)), stuck, stuckDays: STUCK_DAYS },
        flow, badges: { cold, pipeline, due }
    };
}

/**
 * Calls by hour over the last 7 days: rows are the business's days (today last), columns the lead's own clock
 * 8 AM to 7 PM (when they picked up is what matters). owners: the calls where the owner picked up.
 */
function heatGrid({ calls = [], acts = [], leadsById = new Map(), tz = C, now = new Date() }) {
    const days = dayKeys(tz, 7, now), idx = new Map(days.map((d, i) => [d, i]));
    const cells = days.map(() => HOURS.map(() => 0)), owners = days.map(() => HOURS.map(() => 0));
    const tzOf = (leadId, phone) => S.leadTimezone(leadsById.get(leadId) || (phone ? { phone } : null), tz);
    const put = (grid, when, leadId, phone) => {
        const d = idx.get(ymd(tz, when)); if (d == null) return;
        const h = HOURS.indexOf(hourIn(tzOf(leadId, phone), when)); if (h < 0) return;
        grid[d][h]++;
    };
    for (const c of calls) if (c.direction === 'outbound') put(cells, c.started_at, c.lead_id, c.contact_number);
    for (const a of handCalls(acts)) put(cells, a.at, a.lead_id);
    for (const a of acts) if (isOutCall(a) && meta(a).picked === 'owner') put(owners, a.at, a.lead_id);
    const byHour = HOURS.map((_, h) => cells.reduce((s, r) => s + r[h], 0));
    const most = Math.max(0, ...byHour);
    const ownerRate = HOURS.map((_, h) => { const n = cells.reduce((s, r) => s + r[h], 0), o = owners.reduce((s, r) => s + r[h], 0); return n >= 8 ? o / n : null; });
    const bestOwner = ownerRate.reduce((b, r, h) => (r != null && (b == null || r > ownerRate[b]) ? h : b), null);
    return { days, hours: HOURS, cells, owners, busiest: most ? { hour: HOURS[byHour.indexOf(most)], calls: most } : null,
             bestOwner: bestOwner != null && ownerRate[bestOwner] > 0 ? { hour: HOURS[bestOwner], pct: Math.round(ownerRate[bestOwner] * 100) } : null };
}

/**
 * The team: today (calls, talked, emails, interested) and the period (calls, talked, meetings, won), and who is on
 * a call now (a call ringing or in progress that started in the last 3 hours).
 */
function teamRows({ users = [], acts = [], calls = [], leads = [], tz = C, now = new Date(), since }) {
    const today = ymd(tz, now), t0 = new Date(since).getTime(), t = new Date(now).getTime();
    const blank = () => ({ calls: 0, talked: 0, emails: 0, interested: 0, pCalls: 0, pTalked: 0, meetings: 0, won: 0, lastCallAt: null, live: null });
    const per = new Map(users.map(u => [u.id, blank()]));
    const of = id => per.get(id);
    const isToday = w => ymd(tz, w) === today;
    const seen = w => { const x = new Date(w).getTime(); return x >= t0; };
    const last = (r, w) => { if (!r.lastCallAt || w > r.lastCallAt) r.lastCallAt = w; };
    for (const c of calls) {
        if (c.direction === 'outbound') { const r = of(c.user_id); if (r) { if (isToday(c.started_at)) r.calls++; if (seen(c.started_at)) r.pCalls++; last(r, c.started_at); } }
        const who = c.answered_by || (c.direction === 'outbound' ? c.user_id : null);
        if (['ringing', 'in-progress', 'queued', 'initiated'].includes(c.status) && who && t - new Date(c.started_at).getTime() < 3 * 3600e3) {
            const r = of(who); if (r && (!r.live || c.started_at > r.live.since)) r.live = { since: c.answered_at || c.started_at, sid: c.sid, lead_id: c.lead_id || null, number: c.contact_number || null, status: c.status };
        }
    }
    const meetSeen = new Set();
    for (const a of acts) {
        const r = of(a.actor_id); if (!r) continue;
        if (isOutCall(a) && !meta(a).sid) { if (isToday(a.at)) r.calls++; if (seen(a.at)) r.pCalls++; last(r, a.at); }
        if (talked(a)) { if (isToday(a.at)) r.talked++; if (seen(a.at)) r.pTalked++; }
        if (a.type === 'email_out' && isToday(a.at)) r.emails++;
        if (a.type === 'call' && ['interested', 'meeting'].includes(meta(a).outcomeKey) && isToday(a.at)) r.interested++;
        if (isMeeting(a) && seen(a.at) && !meetSeen.has(a.actor_id + a.lead_id)) { meetSeen.add(a.actor_id + a.lead_id); r.meetings++; }
    }
    for (const l of leads) if (l.stage === 'won' && l.stage_at && seen(l.stage_at)) { const r = of(l.owner_id); if (r) r.won++; }
    return users.map(u => ({ id: u.id, name: u.name, ...of(u.id) }));
}

/**
 * What needs a person: replies nobody answered (a person wrote, called or met after), leads that said yes on a
 * call with nothing booked, from plain rows. Each with up to 6 leads to open.
 */
function needsYou({ leads = [], acts = [], now = new Date(), p91 = true }) {
    const byLead = new Map();
    for (const a of acts) { if (!a.lead_id) continue; const x = byLead.get(a.lead_id) || []; x.push(a); byLead.set(a.lead_id, x); }
    const leadById = new Map(leads.map(l => [l.id, l]));
    const t = new Date(now).getTime();
    const replies = [];
    for (const [id, list] of byLead) {
        const ins = list.filter(a => a.type === 'email_in' && t - new Date(a.at).getTime() < 14 * 864e5);
        if (!ins.length) continue;
        const lastIn = ins.reduce((m, a) => (a.at > m ? a.at : m), '');
        const answered = list.some(a => a.at > lastIn && a.actor_id && ['email_out', 'call', 'meeting'].includes(a.type));
        const l = leadById.get(id);
        if (!answered && l && !['won', 'lost'].includes(l.stage)) replies.push({ id, name: name(l), at: lastIn });
    }
    replies.sort((a, b) => (a.at < b.at ? 1 : -1));
    const interested = p91 ? leads.filter(l => (l.call_status === 'in_play' || l.last_call_outcome === 'Interested') && ['new', 'contacted', 'replied'].includes(l.stage) && !l.next_step_at)
        .sort((a, b) => String(b.last_call_at || '').localeCompare(String(a.last_call_at || ''))).map(l => ({ id: l.id, name: name(l), at: l.last_call_at || null })) : [];
    const top = arr => ({ n: arr.length, leads: arr.slice(0, 6) });
    return { replies: top(replies), interested: top(interested) };
}

/**
 * The live activity list, newest first, from plain rows. Each item is { id, at, tone, parts, lead }; parts are
 * plain text and [bold] pieces, so the page never puts server text into HTML unescaped.
 * tone: ok (a conversation, an answered call), cp (campaigns, the pipeline, new leads), hot (a reply, a missed call,
 * a voicemail, a text), '' (no answer and the like).
 */
function feedItems({ acts = [], calls = [], texts = [], newLeads = [], leadsById = new Map(), people = new Map(), pretty = n => n, sources = [], limit = 12 }) {
    const who = id => people.get(id) || 'Someone';
    const lead = id => name(leadsById.get(id));
    const num = (leadId, n) => (leadId && leadsById.get(leadId) ? lead(leadId) : pretty(n) || 'an unknown number');
    const mmss = s => { s = Math.round(Number(s) || 0); return `${Math.floor(s / 60)}:${pad(s % 60)}`; };
    const stage = k => (S.CRM_STAGES.find(s => s.key === k) || { label: k || 'a new stage' }).label;
    const out = [];
    const sidsFiled = new Set(acts.filter(a => a.type === 'call' && meta(a).sid).map(a => meta(a).sid));
    // Stage moves made in bulk arrive as one row per lead: shown as one line.
    const bulk = new Map();
    for (const a of acts) {
        const m = meta(a);
        if (a.type === 'call') {
            if (!isOutCall(a)) continue;
            const ok = talked(a) || ['interested', 'meeting'].includes(m.outcomeKey);
            out.push({ id: 'a' + a.id, at: a.at, tone: ok ? 'ok' : '', lead: a.lead_id,
                parts: [[who(a.actor_id)], ' called ', [lead(a.lead_id)], ' · ' + (m.outcome || 'no outcome yet') + (m.outcomeKey === 'interested' ? ' · into the pipeline' : '')] });
        } else if (a.type === 'email_out') {
            out.push(m.campaign ? { id: 'a' + a.id, at: a.at, tone: 'cp', lead: a.lead_id, parts: ['Campaign ', [m.campaignName || 'a campaign'], ' emailed ', [lead(a.lead_id)]] }
                : { id: 'a' + a.id, at: a.at, tone: 'cp', lead: a.lead_id, parts: [[who(a.actor_id)], ' emailed ', [lead(a.lead_id)]] });
        } else if (a.type === 'email_in') {
            out.push({ id: 'a' + a.id, at: a.at, tone: 'hot', lead: a.lead_id, parts: ['Reply from ', [lead(a.lead_id)]] });
        } else if (a.type === 'meeting') {
            out.push({ id: 'a' + a.id, at: a.at, tone: 'ok', lead: a.lead_id, parts: [[who(a.actor_id)], ' logged a meeting with ', [lead(a.lead_id)]] });
        } else if (a.type === 'stage') {
            if (m.bulk) { const k = [a.actor_id, m.to, String(a.at).slice(0, 16)].join('|'); const b = bulk.get(k); if (b) { b.n++; continue; } bulk.set(k, { a, n: 1 }); continue; }
            out.push({ id: 'a' + a.id, at: a.at, tone: m.to === 'won' ? 'ok' : 'cp', lead: a.lead_id, parts: [[who(a.actor_id)], ' moved ', [lead(a.lead_id)], ' to ' + stage(m.to)] });
        }
    }
    for (const { a, n } of bulk.values()) out.push({ id: 'a' + a.id, at: a.at, tone: 'cp', lead: n === 1 ? a.lead_id : null,
        parts: n === 1 ? [[who(a.actor_id)], ' moved ', [lead(a.lead_id)], ' to ' + stage(meta(a).to)] : [[who(a.actor_id)], ' moved ', [n + ' leads'], ' to ' + stage(meta(a).to)] });
    for (const c of calls) {
        const id = 'c' + (c.id || c.sid), at = c.started_at, l = c.lead_id;
        if (c.direction === 'outbound') {
            if (sidsFiled.has(c.sid) || ['ringing', 'in-progress', 'queued', 'initiated'].includes(c.status)) continue;
            const got = Number(c.duration) > 0 && c.status === 'completed';
            out.push({ id, at, tone: got ? 'ok' : '', lead: l, parts: [[who(c.user_id)], ' called ', [num(l, c.contact_number)], got ? ' · ' + mmss(c.duration) : ' · ' + (c.status === 'busy' ? 'busy' : 'no answer')] });
        } else if (c.voicemail || c.status === 'voicemail') {
            out.push({ id, at, tone: 'hot', lead: l, parts: ['Voicemail from ', [num(l, c.contact_number)], c.duration ? ' · ' + mmss(c.duration) : ''] });
        } else if (c.answered_by) {
            out.push({ id, at, tone: 'ok', lead: l, parts: ['Incoming call from ', [num(l, c.contact_number)], ' · answered by ', [who(c.answered_by)], Number(c.duration) > 0 ? ' · ' + mmss(c.duration) : ''] });
        } else if (!['ringing', 'in-progress', 'queued', 'initiated'].includes(c.status)) {
            out.push({ id, at, tone: 'hot', lead: l, parts: ['Missed call from ', [num(l, c.contact_number)]] });
        }
    }
    for (const x of texts) {
        const body = String(x.body || '').replace(/\s+/g, ' ').trim();
        out.push({ id: 't' + x.id, at: x.at, tone: 'hot', lead: x.lead_id || null, parts: ['Text from ', [num(x.lead_id, x.contact_number)], body ? ' · “' + (body.length > 70 ? body.slice(0, 69) + '…' : body) + '”' : ''] });
    }
    // New leads arrive in batches (an import, the Lead Finder): one line per batch.
    const batches = new Map();
    for (const l of newLeads) { const k = [l.created_by || '', l.source || '', String(l.created_at).slice(0, 16)].join('|'); const b = batches.get(k) || { l, n: 0, cities: new Map() }; b.n++; if (l.city) b.cities.set(l.city, (b.cities.get(l.city) || 0) + 1); batches.set(k, b); }
    for (const { l, n, cities } of batches.values()) {
        const src = (sources.find(s => s.key === l.source) || {}).label || '';
        const city = [...cities.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0])[0];
        out.push({ id: 'l' + l.id, at: l.created_at, tone: 'cp', lead: n === 1 ? l.id : null,
            parts: n === 1 ? ['New lead ', [name(l)], src || city ? ' · ' + [src, city].filter(Boolean).join(', ') : ''] : [[n + ' leads'], ' added', src || city ? ' · ' + [src, city].filter(Boolean).join(', ') : ''] });
    }
    return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
}

Object.assign(S, { consoleDayKeys: dayKeys, consoleSums, heatGrid, teamRows, needsYou, feedItems });

// ------------------------------------------------------------------ reading
async function staff(req, res) {
    const ctx = await S.auth(req, res); if (!ctx) return null;
    if (S.staffOnly && !S.staffOnly(ctx, res)) return null;
    return ctx;
}
function fail(res, e, where) {
    logger.error(where, { message: e && e.message });
    return res.status(500).json({ error: 'Something went wrong on our side. Try again in a moment.' });
}
/** One build at a time per key, kept for ttl ms: everyone who asks in the meantime gets the same answer. */
const _cache = new Map();
function cached(key, ttl, build) {
    const hit = _cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.p;
    const p = build().catch(e => { _cache.delete(key); throw e; });
    _cache.set(key, { at: Date.now(), p });
    return p;
}
S.consoleCacheClear = () => _cache.clear();
const all = (t, c, f, o = {}) => S.selectAll(t, c, f, { max: 50000, ...o });
const safe = p => p.catch(e => { logger.warn('console_read', { message: e && e.message }); return []; });

const LEAD_COLS = 'id, full_name, company, phone, email, website, city, country, timezone, source, industry, stage, score, tags, owner_id, client_id, value, currency, created_at, stage_at, updated_at, next_step_at, created_by';
const P90_COLS = ', in_pipeline';
const P91_COLS = ', call_status, calls_count, last_call_at, last_call_outcome, callback_at, emails_count, last_email_at';

async function people() {
    const { data } = await supabase.from('app_users').select('id, full_name, email, role').in('role', ['admin', 'user']).eq('is_active', true).limit(200);
    return (data || []).map(u => ({ id: u.id, name: u.full_name || (u.email || '').split('@')[0], role: u.role }));
}
const first = n => String(n || '').split(' ')[0];

/** The feed and today's counts: shared, at most every 10 seconds. */
function pulseShared() {
    return cached('pulse', 10000, async () => {
        const crm = await S.crmSettings(), tz = crm.timezone || C, now = new Date();
        const day = S.dayBounds(tz, 'today', now), s0 = day.start.toISOString(), since = new Date(now.getTime() - 36 * 3600e3).toISOString();
        const [acts, calls, texts, newLeads, todayCalls, todayActs, users] = await Promise.all([
            supabase.from('crm_activities').select('id, lead_id, type, actor_id, at, meta').in('type', ['call', 'email_out', 'email_in', 'meeting', 'stage']).gte('at', since).order('at', { ascending: false }).limit(60).then(r => r.data || [], () => []),
            supabase.from('phone_calls').select('id, sid, direction, status, user_id, answered_by, answered_at, lead_id, contact_number, started_at, duration, voicemail').gte('started_at', since).order('started_at', { ascending: false }).limit(40).then(r => r.data || [], () => []),
            supabase.from('phone_messages').select('id, lead_id, contact_number, body, at').eq('direction', 'inbound').gte('at', since).order('at', { ascending: false }).limit(15).then(r => r.data || [], () => []),
            supabase.from('crm_leads').select('id, full_name, company, source, city, created_at, created_by').gte('created_at', since).order('created_at', { ascending: false }).limit(400).then(r => r.data || [], () => []),
            safe(all('phone_calls', 'id, user_id, direction', q => q.eq('direction', 'outbound').gte('started_at', s0))),
            safe(all('crm_activities', 'id, type, actor_id, meta, at, lead_id', q => q.in('type', ['call', 'email_out', 'email_in']).gte('at', s0))),
            people()]);
        const ids = [...new Set([...acts, ...calls, ...texts].map(x => x.lead_id).filter(Boolean))];
        const named = ids.length ? (await supabase.from('crm_leads').select('id, full_name, company').in('id', ids.slice(0, 300))).data || [] : [];
        const leadsById = new Map([...named, ...newLeads].map(l => [l.id, l]));
        const feed = feedItems({ acts, calls, texts, newLeads, leadsById, people: new Map(users.map(u => [u.id, first(u.name)])), pretty: S.prettyNumber || (n => n), sources: S.CRM_SOURCES, limit: 14 });
        const hand = handCalls(todayActs);
        const counts = { calls: todayCalls.length + hand.length, conversations: todayActs.filter(talked).length, owners: todayActs.filter(a => talked(a) && meta(a).picked === 'owner').length,
                         emails: todayActs.filter(a => a.type === 'email_out').length, replies: todayActs.filter(a => a.type === 'email_in').length };
        const perCalls = {};
        for (const c of todayCalls) perCalls[c.user_id] = (perCalls[c.user_id] || 0) + 1;
        for (const a of hand) perCalls[a.actor_id] = (perCalls[a.actor_id] || 0) + 1;
        const live = teamRows({ users, calls: calls.filter(c => ['ringing', 'in-progress', 'queued', 'initiated'].includes(c.status)), tz, now, since: s0 })
            .filter(r => r.live).map(r => ({ id: r.id, since: r.live.since, lead: r.live.lead_id ? name(leadsById.get(r.live.lead_id)) : (S.prettyNumber ? S.prettyNumber(r.live.number) : r.live.number) }));
        return { at: now.toISOString(), tz, feed, counts, perCalls, live };
    });
}

/** Everything else the Overview shows, shared, at most every 20 seconds. */
function consoleShared(days) {
    return cached('console:' + days, 20000, async () => {
        const t0 = Date.now();
        const [crm, p90, p91] = await Promise.all([S.crmSettings(), S.p90Ready(), S.p91Ready ? S.p91Ready() : false]);
        const tz = crm.timezone || C, now = new Date();
        const since = new Date(now.getTime() - days * 864e5), back14 = new Date(S.dayBounds(tz, 'today', now).start.getTime() - 13 * 864e5);
        const actsFrom = since < back14 ? since : back14;
        const cols = LEAD_COLS + (p90 ? P90_COLS : '') + (p91 ? P91_COLS : '');
        const [leads, acts, calls, infl, posts, users, campaigns, mapWaiting] = await Promise.all([
            all('crm_leads', cols + ', service').catch(() => all('crm_leads', cols)),
            safe(all('crm_activities', 'id, lead_id, type, actor_id, at, meta', q => q.gte('at', actsFrom.toISOString()).in('type', ['email_out', 'email_in', 'call', 'meeting', 'stage']))),
            safe(all('phone_calls', 'id, sid, direction, status, user_id, answered_by, answered_at, lead_id, contact_number, started_at, duration', q => q.gte('started_at', back14.toISOString()))),
            safe(all('crm_influencers', 'id, stage')),
            safe(all('crm_influencer_posts', 'views, posted_at', q => q.gte('posted_at', since.toISOString().slice(0, 10)), { order: 'posted_at' })),
            people(),
            p90 ? campaignSummary() : Promise.resolve([]),
            p90 ? supabase.from('crm_leads').select('id', { count: 'exact', head: true }).is('lat', null).not('city', 'is', null).then(r => r.count || 0, () => 0) : Promise.resolve(0)]);
        const leadsById = new Map(leads.map(l => [l.id, l]));
        const sums = consoleSums({ leads, acts, calls, tz, now, since, p90, p91 });
        const ov = S.crmOverview({ leads, activities: acts, since });
        const per = teamRows({ users, acts, calls, leads, tz, now, since });
        return {
            tz, days, p90, p91, users, leads, leadsById,
            body: {
                period: days, tz, ...sums,
                heat: heatGrid({ calls, acts, leadsById, tz, now }),
                jobs: S.jobsWon(leads, since),
                departments: ov.departments, totals: ov.totals,
                influencers: { total: infl.length, partners: infl.filter(x => x.stage === 'partner').length, talking: infl.filter(x => x.stage === 'talking').length,
                               posts: posts.length, views: posts.reduce((s, p) => s + (Number(p.views) || 0), 0) },
                campaigns, mapWaiting,
                team: per,
                needs: needsYou({ leads, acts, now, p91 }),
                builtMs: Date.now() - t0
            }
        };
    });
}

/** The running email campaigns: who is on each, sent, opened, replied. Four small counts each, for at most six. */
async function campaignSummary() {
    const { data: cs } = await supabase.from('crm_campaigns').select('id, name, status, updated_at').eq('status', 'active').order('updated_at', { ascending: false }).limit(6);
    const head = (t, f) => f(supabase.from(t).select('id', { count: 'exact', head: true })).then(r => r.count || 0, () => 0);
    return Promise.all((cs || []).map(async c => {
        const [active, sent, opened, replied] = await Promise.all([
            head('crm_enrollments', q => q.eq('campaign_id', c.id).eq('status', 'active')),
            head('crm_emails', q => q.eq('campaign_id', c.id).eq('status', 'sent')),
            head('crm_emails', q => q.eq('campaign_id', c.id).not('opened_at', 'is', null)),
            head('crm_enrollments', q => q.eq('campaign_id', c.id).eq('status', 'replied'))]);
        return { id: c.id, name: c.name, active, sent, opened, replied };
    }));
}

/** Up next for this person: the first five of Calls → Today, by the same rules. */
async function upNextFor(ctx, shared) {
    const rules = S.dialRules ? await S.dialRules() : S.DIALER_DEFAULTS;
    const now = new Date();
    const own = q => ctx.profile.role === 'admin' ? q : q.or(`owner_id.eq.${ctx.user.id},owner_id.is.null`);
    const { data: tasks } = await own(supabase.from('crm_tasks').select('id, lead_id, title, due_at, owner_id' + (shared.p90 ? ', kind' : '')).is('done_at', null).lte('due_at', now.toISOString()).limit(1000));
    const isCall = t => (t.kind ? t.kind === 'call' : /^call\b/i.test(t.title || ''));
    const taskOf = new Map();
    for (const t of tasks || []) if (t.lead_id && isCall(t) && (!taskOf.has(t.lead_id) || t.due_at < taskOf.get(t.lead_id).due_at)) taskOf.set(t.lead_id, t);
    const leads = [];
    for (const l of shared.leads) {
        if (String(l.phone || '').replace(/\D/g, '').length < 7) continue;
        const t = taskOf.get(l.id);
        leads.push(t ? { ...l, task_due: t.due_at, task_title: t.title } : l);
    }
    const q = S.dialQueue(leads, { tab: 'today', rules, now, tzFallback: shared.tz, limit: 5 });
    const late = (tasks || []).filter(t => isCall(t) && new Date(t.due_at).getTime() < now.getTime() - 15 * 60000).sort((a, b) => (a.due_at < b.due_at ? -1 : 1));
    return {
        upNext: q.rows.map(r => ({ id: r.id, name: r.company || r.full_name, city: (shared.leadsById.get(r.id) || {}).city || null, phone: r.phone, tab: r.tab, task: r.task, taskAt: r.task ? (taskOf.get(r.id) || {}).due_at || null : null, callback_at: r.callback_at,
                                   openNow: r.openNow, opensAt: r.opensAt, tz: r.tz, score: r.score, warmth: r.warmth, calls: r.calls_count, last: r.last_call_outcome, campaign: r.campaign ? r.campaign.name : null })),
        dueToday: q.counts.today,
        callbacks: { n: late.length, oldest: late[0] ? late[0].due_at : null, leads: late.slice(0, 6).map(t => ({ id: t.lead_id, name: name(shared.leadsById.get(t.lead_id)), at: t.due_at })).filter(x => x.id) }
    };
}

async function clientTasksFor(ctx) {
    const crm = await S.crmSettings(), today = S.dayBounds(crm.timezone || C, 'today').today;
    const clients = S.openClientsFor ? await S.openClientsFor(ctx).catch(() => []) : [];
    if (!clients.length) return { n: 0, overdue: 0, tasks: [] };
    const byId = new Map(clients.map(c => [c.id, c.name]));
    const ids = [...byId.keys()].slice(0, 500);
    const open = q => q.in('client_id', ids).neq('status', 'done').not('due_date', 'is', null);
    const [{ data, count }, late] = await Promise.all([
        open(supabase.from('client_tasks').select('id, client_id, title, due_date', { count: 'exact' })).lte('due_date', today).order('due_date', { ascending: true }).limit(6),
        open(supabase.from('client_tasks').select('id', { count: 'exact', head: true })).lt('due_date', today).then(r => r.count || 0, () => 0)]);
    return { n: count || (data || []).length, overdue: late, today,
             tasks: (data || []).map(t => ({ id: t.id, client: { id: t.client_id, name: byId.get(t.client_id) || '' }, title: t.title, due: t.due_date, late: t.due_date < today })) };
}

async function systems(ctx, campaigns) {
    const [mailbox, sentToday, access] = await Promise.all([
        S.mailboxState ? S.mailboxState().catch(() => ({ connected: false })) : { connected: false },
        S.sentToday ? S.sentToday().catch(() => 0) : 0,
        S.phoneAccessFor ? S.phoneAccessFor(ctx.user.id).catch(() => null) : null]);
    const line = S.phoneLine ? S.phoneLine() : { ready: false, number: null };
    const every = 120000, last = S.campaignTickAt || null;
    return {
        phone: { ready: line.ready, number: line.number ? (S.prettyNumber ? S.prettyNumber(line.number) : line.number) : null },
        access: access ? { allowed: access.allowed, why: access.why, text: access.text, opensAt: access.opensAt || null, closesAt: access.closesAt || null, tz: access.tz || null } : null,
        mailbox: { connected: !!mailbox.connected, paused: !!mailbox.paused, cap: mailbox.dailyCap || null, sent: sentToday, left: mailbox.dailyCap ? Math.max(0, mailbox.dailyCap - sentToday) : null },
        sender: { running: campaigns.length, nextAt: last ? new Date(last + every).toISOString() : null, every }
    };
}

// ------------------------------------------------------------------ routes
app.get('/api/crm/console', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        const days = PERIODS.includes(parseInt(req.query.days, 10)) ? parseInt(req.query.days, 10) : 30;
        const [shared, pulse] = await Promise.all([consoleShared(days), pulseShared()]);
        const [mine, ctasks, sys, goals, campaignsOn] = await Promise.all([
            upNextFor(ctx, shared), clientTasksFor(ctx).catch(() => ({ n: 0, overdue: 0, tasks: [] })), systems(ctx, shared.body.campaigns),
            goalsToday(pulse), S.featureOn ? S.featureOn(ctx, 'campaigns') : true]);
        const b = shared.body;
        res.json({
            ...b, at: pulse.at, me: ctx.user.id,
            today: { ...b.today, ...pulse.counts },
            team: b.team.map(r => ({ ...r, calls: pulse.perCalls[r.id] || 0, live: (pulse.live.find(x => x.id === r.id) || null) })),
            feed: pulse.feed, goals, sys: { ...sys, mapWaiting: b.mapWaiting },
            upNext: mine.upNext, dueToday: mine.dueToday,
            needs: { ...b.needs, callbacks: mine.callbacks, clientTasks: ctasks },
            campaigns: campaignsOn ? b.campaigns : null
        });
    } catch (e) { fail(res, e, 'crm_console'); }
});

/** The menu's three counts (cold leads, the pipeline, follow-ups due), as three counts instead of the lead list. */
app.get('/api/crm/badges', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        res.json(await cached('badges', 20000, async () => {
            const [crm, p90] = await Promise.all([S.crmSettings(), S.p90Ready()]);
            const tomorrow = S.dayBounds(crm.timezone || C, 'today').end.toISOString();
            const cnt = f => f(supabase.from('crm_leads').select('id', { count: 'exact', head: true }).not('stage', 'in', '(won,lost)')).then(r => r.count || 0);
            const [pipeline, cold, due] = await Promise.all([
                cnt(q => (p90 ? q.is('client_id', null).eq('in_pipeline', true) : q.is('client_id', null).neq('stage', 'new'))),
                cnt(q => (p90 ? q.is('client_id', null).eq('in_pipeline', false) : q.is('client_id', null).eq('stage', 'new'))),
                cnt(q => q.lt('next_step_at', tomorrow))]);
            return { cold, pipeline, due };
        }));
    } catch (e) { fail(res, e, 'crm_badges'); }
});

app.get('/api/crm/pulse', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        const p = await pulseShared();
        res.json({ at: p.at, feed: p.feed, today: p.counts, perCalls: p.perCalls, live: p.live, goals: await goalsToday(p) });
    } catch (e) { fail(res, e, 'crm_pulse'); }
});

/** The day's goals: calls and emails from the pulse; leads found and follow-ups done counted here. */
async function goalsToday(pulse) {
    return cached('goals', 20000, async () => {
        const crm = await S.crmSettings(), day = S.dayBounds(crm.timezone || C, 'today'), s0 = day.start.toISOString();
        const cnt = (t, f) => f(supabase.from(t).select('id', { count: 'exact', head: true })).then(r => r.count || 0, () => 0);
        const [crmNew, finderNew, followups] = await Promise.all([cnt('crm_leads', q => q.gte('created_at', s0)), cnt('leads', q => q.gte('created_at', s0)), cnt('crm_tasks', q => q.gte('done_at', s0))]);
        return { prospects: crmNew + finderNew, followups, goals: crm.goals };
    }).then(g => S.goalProgress({ calls: pulse.counts.calls, emails: pulse.counts.emails, prospects: g.prospects, followups: g.followups }, g.goals));
}
