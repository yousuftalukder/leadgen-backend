'use strict';
/**
 * Phase 91: the dialer, who may use the phone and when, and who was called and emailed.
 *
 *   Phone access     The owner gives the phone to teammates (Admin → Phone) and sets the hours it works, in one
 *                    time zone (Eastern by default). Outside them a teammate still opens the Phone and sees
 *                    everything, but cannot call, text or dial. The owner is never locked out. Until the owner
 *                    saves this once, everyone on the team can call at any time, as before phase 91.
 *                    The server decides: the voice webhook refuses a call from someone who may not call now,
 *                    and an incoming call rings only the people who may answer now.
 *   Call lists       The owner names the lists the dialer offers (Admin → Dialer): which categories, industries,
 *                    cold or pipeline, emailed or not, a minimum score, and who sees each list.
 *   The queue        Today = callbacks that are due, then warm leads, then never called (best score first),
 *                    then retries that are due, fewest tries first. Leads whose business is open now (in
 *                    their own time zone) come first. Tabs: Not called, Tried, Spoke, Call back, In play, Closed.
 *   Outcomes         After a call the caller says who picked up and how it went. That sets the lead's call status,
 *                    when to try again (the retry rules), puts interested leads in the pipeline, makes a task for
 *                    a callback or an emailed follow-up, and files it on the call in the lead's history.
 *   Outreach         calls_count, last_call_at, emails_count, last_email_at on each lead, recounted from the
 *                    lead's timeline whenever a call or email is logged (S.refreshOutreach), for the Leads page.
 *
 * Needs sql/schema-phase91.sql for the lead columns. Without it the dialer still lists leads and calls work;
 * outcomes are kept on the timeline only, and the pages say to run the SQL.
 */
const S = require('./shared');
const { app, supabase, logger } = S;

// ------------------------------------------------------------------ time zones (pure, tested)
function validTz(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return !!tz; } catch { return false; } }
/** The wall clock in a time zone: year, month, day, hour, minute and weekday (0 = Sunday). */
function zoned(tz, at = new Date()) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short', hourCycle: 'h23' })
        .formatToParts(at).map(x => [x.type, x.value]));
    return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
/** A wall-clock time in a time zone → the real moment. Right across daylight-saving changes. */
function zonedToUtc(tz, y, m, d, h, mi) {
    const guess = Date.UTC(y, m - 1, d, h, mi);
    const off = at => { const z = zoned(tz, new Date(at)); return Date.UTC(z.y, z.m - 1, z.d, z.h, z.mi) - Math.floor(at / 60000) * 60000; };
    let t = guess - off(guess); const o2 = off(t); if (guess - o2 !== t) t = guess - o2;
    return new Date(t);
}
const hm = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return m ? +m[1] * 60 + +m[2] : null; };
/** Is it inside these hours ({ days: [1..5], from: '09:00', to: '17:00' }) in this time zone? */
function withinHours(hours, tz, now = new Date()) {
    if (!hours) return true;
    const z = zoned(tz, now), t = z.h * 60 + z.mi;
    return (hours.days || []).includes(z.dow) && t >= hm(hours.from) && t < hm(hours.to);
}
/** When these hours next open, or null when open now (or never). */
function nextOpen(hours, tz, now = new Date()) {
    if (!hours || withinHours(hours, tz, now) || !(hours.days || []).length) return null;
    const z = zoned(tz, now), f = hm(hours.from);
    for (let i = 0; i <= 7; i++) {
        const day = new Date(Date.UTC(z.y, z.m - 1, z.d + i));
        if (!hours.days.includes(day.getUTCDay())) continue;
        const at = zonedToUtc(tz, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), Math.floor(f / 60), f % 60);
        if (at > now) return at;
    }
    return null;
}
/** "Mon 9:00 AM EST", "today 9:00 AM EST" or "tomorrow …", as seen in that time zone. */
function whenLabel(at, tz, now = new Date()) {
    if (!at) return '';
    const d = new Date(at), a = zoned(tz, d), b = zoned(tz, now);
    const dayDiff = Math.round((Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(b.y, b.m - 1, b.d)) / 864e5);
    const time = d.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    return (dayDiff === 0 ? 'today' : dayDiff === 1 ? 'tomorrow' : d.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' })) + ' ' + time;
}

// A lead's own time zone: what was set on it; else its state (from the address), using the area code to settle the
// states that span two zones; else the area code; else its country; else the business's time zone.
const E = 'America/New_York', C = 'America/Chicago', M = 'America/Denver', P = 'America/Los_Angeles';
const STATE_TZ = Object.assign({},
    ...'CT DE DC FL GA IN KY ME MD MA MI NH NJ NY NC OH PA RI SC VT VA WV ON QC'.split(' ').map(s => ({ [s]: E })),
    ...'AL AR IL IA KS LA MN MS MO NE ND OK SD TN TX WI MB'.split(' ').map(s => ({ [s]: C })),
    ...'CO MT NM UT WY ID AB'.split(' ').map(s => ({ [s]: M })),
    ...'CA NV OR WA BC'.split(' ').map(s => ({ [s]: P })),
    { AZ: 'America/Phoenix', AK: 'America/Anchorage', HI: 'Pacific/Honolulu', SK: 'America/Regina', NS: 'America/Halifax', NB: 'America/Halifax', PE: 'America/Halifax', NL: 'America/St_Johns' });
const SPLIT = { KY: { 270: C, 364: C }, TN: { 423: E, 865: E }, TX: { 915: M }, IN: { 219: C } };
const AREA_TZ = Object.assign({},
    ...('205 210 214 217 218 219 224 225 228 251 254 256 262 270 281 309 312 314 316 318 319 320 325 331 334 337 346 361 364 402 405 409 414 417 430 432 469 479 501 504 507 ' +
        '512 515 531 534 563 573 580 601 605 608 612 615 618 620 629 630 636 641 651 662 682 701 708 712 713 715 731 737 763 769 773 779 785 806 815 816 817 830 832 847 870 ' +
        '872 901 903 913 918 920 931 936 940 945 952 956 972 979 985 204 431 306 639').split(' ').map(a => ({ [a]: C })),
    ...'303 307 385 406 435 505 575 719 720 801 915 970 208 986 403 587 780 825'.split(' ').map(a => ({ [a]: M })),
    ...'480 520 602 623 928'.split(' ').map(a => ({ [a]: 'America/Phoenix' })),
    ...('206 209 213 253 279 310 323 341 350 360 369 408 415 424 425 442 458 503 509 510 530 541 559 562 564 619 626 628 650 657 661 669 702 707 714 725 747 760 775 805 818 ' +
        '820 831 840 858 909 916 925 949 951 971 604 778 236 250').split(' ').map(a => ({ [a]: P })),
    { 907: 'America/Anchorage', 808: 'Pacific/Honolulu' });
const COUNTRY_TZ = { BD: 'Asia/Dhaka', GB: 'Europe/London', IE: 'Europe/Dublin', AU: 'Australia/Sydney', IN: 'Asia/Kolkata', AE: 'Asia/Dubai', SA: 'Asia/Riyadh',
    MY: 'Asia/Kuala_Lumpur', SG: 'Asia/Singapore', PK: 'Asia/Karachi', NZ: 'Pacific/Auckland', DE: 'Europe/Berlin', FR: 'Europe/Paris', CA: 'America/Toronto', US: E };
/** The two-letter state or province in an address like "112 Thomas Ct, Bowling Green, KY 42101, USA". */
function stateOf(addr) {
    const s = String(addr || '');
    const m = /\b([A-Z]{2})\s+\d{5}(?:-\d{4})?\b/.exec(s) || /,\s*([A-Z]{2})\s*(?:,\s*(?:USA|US|United States|Canada))?\s*$/.exec(s) || /\b([A-Z]{2})\s+[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/.exec(s);
    return m && STATE_TZ[m[1]] ? m[1] : null;
}
/** A North American number's area code, or null. */
function areaCode(phone) {
    const raw = String(phone || ''), d = raw.replace(/\D/g, '');
    if (d.length === 11 && d[0] === '1') return d.slice(1, 4);
    if (d.length === 10 && !raw.trim().startsWith('+')) return d.slice(0, 3);
    return null;
}
function leadTimezone(lead, fallback = C) {
    if (!lead) return fallback;
    if (lead.timezone && validTz(lead.timezone)) return lead.timezone;
    const country = String(lead.country || '').toUpperCase();
    const ac = areaCode(lead.phone), st = stateOf(lead.city);
    if (!country || country === 'US' || country === 'CA') {
        if (st) return (SPLIT[st] && ac && SPLIT[st][ac]) || STATE_TZ[st];
        if (ac) return AREA_TZ[ac] || (country === 'CA' ? COUNTRY_TZ.CA : E);
    }
    return COUNTRY_TZ[country] || fallback;
}

// ------------------------------------------------------------------ phone access (pure, tested)
const DEFAULT_HOURS = { days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' };
function cleanHours(h) {
    if (!h) return null;
    const days = [...new Set((h.days || []).map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    const f = hm(h.from), t = hm(h.to);
    if (!days.length) throw bad('Pick at least one day.');
    if (f == null || t == null || f >= 24 * 60 || t > 24 * 60) throw bad('Hours are written like 09:00 and 17:00.');
    if (f >= t) throw bad('The hours must end after they start, on the same day.');
    const p = n => String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
    return { days, from: p(f), to: p(t) };
}
/** The owner's phone-access settings, checked. `people` is keyed by user id. */
function cleanPhoneAccess(b) {
    b = b || {};
    const tz = b.tz || E;
    if (!validTz(tz)) throw bad('That time zone is not one I know, e.g. America/New_York.');
    const people = {};
    for (const [id, p] of Object.entries(b.people || {})) {
        if (!S.UUID_RE || S.UUID_RE.test(id)) people[id] = { on: p && p.on === true, own: !!(p && p.own && p.hours), hours: p && p.own && p.hours ? cleanHours(p.hours) : null };
    }
    return { enabled: b.enabled !== false, tz, hours: b.anyTime ? null : cleanHours(b.hours || DEFAULT_HOURS), people };
}
/**
 * May this person use the phone now? { allowed, why, text, opensAt, closesAt, tz, hours }.
 *   why: owner · open (never set up: everyone, any time) · any_time · in_hours · locked · no_access · closed
 */
function phoneAccess(cfg, user, now = new Date()) {
    if (!user) return { allowed: false, why: 'no_access', text: 'Sign in to use the phone.' };
    if (user.role === 'admin') return { allowed: true, why: 'owner', text: 'You are the owner: the phone is always on for you.' };
    if (!cfg) return { allowed: true, why: 'open', text: '' };
    if (!cfg.enabled) return { allowed: false, why: 'locked', text: 'The owner has locked calling for the team.' };
    const p = (cfg.people || {})[user.id];
    if (!p || !p.on) return { allowed: false, why: 'no_access', text: 'You have not been given the phone yet. The owner gives it in Admin → Phone.' };
    const hours = p.own && p.hours ? p.hours : cfg.hours, tz = cfg.tz || E;
    if (!hours) return { allowed: true, why: 'any_time', text: '', tz };
    if (withinHours(hours, tz, now)) {
        const z = zoned(tz, now), t = hm(hours.to);
        const closesAt = zonedToUtc(tz, z.y, z.m, z.d, Math.floor(t / 60), t % 60);
        return { allowed: true, why: 'in_hours', tz, hours, closesAt: closesAt.toISOString(), text: 'Calling is open until ' + whenLabel(closesAt, tz, now).replace(/^today /, '') + '.' };
    }
    const at = nextOpen(hours, tz, now);
    return { allowed: false, why: 'closed', tz, hours, opensAt: at ? at.toISOString() : null, text: at ? 'Calling opens ' + whenLabel(at, tz, now) + '.' : 'Calling is closed.' };
}
const EDGES = ['roaming', 'ashburn', 'umatilla', 'dublin', 'frankfurt', 'singapore', 'tokyo', 'sydney', 'sao-paulo'];
function cleanVoice(b) {
    b = b || {};
    const edge = EDGES.includes(b.edge) ? b.edge : 'roaming';
    return { edge, noiseSuppression: b.noiseSuppression !== false };
}

// ------------------------------------------------------------------ call outcomes and the queue (pure, tested)
// What each outcome does, everywhere (phase 92):
//   tried      No answer, voicemail, busy, owner not in: back after the retry time; after the set number of tries in a row
//              the lead closes, and comes back after the out-of-tries wait (30 days) with a fresh count.
//   spoke      Talked, follow up: back after the retry time.
//   callback   At the time set, with a call task (and reminders) for the caller.
//   in_play    Interested, Booked a meeting: into the pipeline (Contacted / Meeting); its email campaigns stop: sales has it.
//   closed     Not interested, Not a fit: the lead is Lost (with the reason), its campaigns stop, and it comes back
//              to the call list after the revisit wait (90 days). A wrong number is marked on the lead and waits for a
//              new number. Do not call: never called, texted or emailed again (tag + unsubscribed).
const PICKED = { owner: 'The owner', front_desk: 'Front desk', someone: 'Someone else', none: 'No one' };
const OUTCOMES = [
    { key: 'no_answer', label: 'No answer', who: ['none'], status: 'tried', retry: 'no_answer' },
    { key: 'voicemail', label: 'Left a voicemail', who: ['none'], status: 'tried', retry: 'voicemail' },
    { key: 'busy', label: 'Busy', who: ['none'], status: 'tried', retry: 'busy' },
    { key: 'gatekeeper', label: 'Owner not in', who: ['front_desk', 'someone'], status: 'tried', retry: 'gatekeeper' },
    { key: 'spoke', label: 'Talked, follow up', who: ['owner', 'front_desk', 'someone'], status: 'spoke', retry: 'spoke' },
    { key: 'callback', label: 'Call back at a set time', who: ['owner', 'front_desk', 'someone'], status: 'callback' },
    { key: 'interested', label: 'Interested', who: ['owner', 'someone'], status: 'in_play', pipeline: true, stopEmail: true },
    { key: 'meeting', label: 'Booked a meeting', who: ['owner', 'someone'], status: 'in_play', pipeline: true, stage: 'meeting', stopEmail: true },
    { key: 'not_interested', label: 'Not interested', who: ['owner', 'front_desk', 'someone'], status: 'closed', lose: true, revisit: 'notInterested', stopEmail: true },
    { key: 'not_fit', label: 'Not a fit for us', who: ['owner', 'front_desk', 'someone'], status: 'closed', lose: true, revisit: 'notInterested', stopEmail: true },
    { key: 'wrong_number', label: 'Wrong or dead number', who: ['none', 'someone'], status: 'closed', wrong: true },
    { key: 'dnc', label: 'Do not call again', who: ['owner', 'front_desk', 'someone', 'none'], status: 'closed', dnc: true, stopEmail: true }
];
const TRIED = OUTCOMES.filter(o => o.status === 'tried').map(o => o.key);
const STATUSES = [['not_called', 'Not called'], ['tried', 'Tried'], ['spoke', 'Spoke'], ['callback', 'Call back'], ['in_play', 'In play'], ['closed', 'Closed']];
const DNC_TAG = 'Do not call', WRONG_TAG = 'Wrong number';
const REMINDER_STEPS = [1440, 120, 60, 30, 15, 10, 5, 0];       // minutes before a callback or a timed to-do
const SNOOZES = [1, 5, 10, 15, 30];
const DEFAULT_RULES = {
    retry: { no_answer: 24, voicemail: 48, busy: 2, gatekeeper: 24, spoke: 72 },
    maxAttempts: 6,
    revisit: { notInterested: 90, outOfTries: 30 },
    localHours: { on: true, days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' },
    reminders: [60, 15, 5], snooze: 5,
    lists: []
};
const RETRY_KEYS = Object.keys(DEFAULT_RULES.retry);
function bad(message) { const e = new Error(message); e.statusCode = 400; return e; }
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
function cleanList(l, i) {
    l = l || {};
    const name = str(l.name, 60); if (!name) throw bad('Every call list needs a name.');
    const id = /^[a-z0-9-]{2,40}$/.test(l.id || '') ? l.id : 'list-' + (i + 1) + '-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24);
    const arr = (v, n) => [...new Set((Array.isArray(v) ? v : []).map(x => str(x, 60)).filter(Boolean))].slice(0, n);
    return { id, name, sources: arr(l.sources, 20), industries: arr(l.industries, 60), pipeline: ['any', 'cold', 'pipeline'].includes(l.pipeline) ? l.pipeline : 'any',
        emailed: ['any', 'yes', 'no'].includes(l.emailed) ? l.emailed : 'any', minScore: Math.max(0, Math.min(100, Math.round(Number(l.minScore) || 0))), people: arr(l.people, 50) };
}
const cleanSteps = (v, d) => Array.isArray(v) ? [...new Set(v.map(Number).filter(x => REMINDER_STEPS.includes(x)))].sort((a, b) => b - a) : d;
const days = (v, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 && n <= 730 ? n : d; };
function cleanRules(b) {
    b = b || {};
    const retry = {};
    for (const k of RETRY_KEYS) { const v = Number((b.retry || {})[k]); retry[k] = Number.isFinite(v) && v >= 0 && v <= 24 * 60 ? Math.round(v * 10) / 10 : DEFAULT_RULES.retry[k]; }
    const max = Math.round(Number(b.maxAttempts)); const lh = b.localHours || {}, rv = b.revisit || {};
    const lists = (Array.isArray(b.lists) ? b.lists : []).slice(0, 30).map(cleanList);
    if (new Set(lists.map(l => l.id)).size !== lists.length) throw bad('Two call lists have the same id. Rename one.');
    return { retry, maxAttempts: Number.isFinite(max) && max >= 1 && max <= 50 ? max : DEFAULT_RULES.maxAttempts,
        revisit: { notInterested: days(rv.notInterested, DEFAULT_RULES.revisit.notInterested), outOfTries: days(rv.outOfTries, DEFAULT_RULES.revisit.outOfTries) },
        localHours: { on: lh.on !== false, ...(cleanHours({ days: lh.days || DEFAULT_RULES.localHours.days, from: lh.from || '09:00', to: lh.to || '17:00' })) },
        reminders: cleanSteps(b.reminders, DEFAULT_RULES.reminders), snooze: SNOOZES.includes(Number(b.snooze)) ? Number(b.snooze) : DEFAULT_RULES.snooze, lists };
}
/** A caller's own settings: their reminder times (else the office's), snooze, the tone and desktop alerts. */
function cleanCallerPrefs(b) {
    b = b || {};
    return { reminders: b.reminders === null || b.reminders === undefined ? null : cleanSteps(b.reminders, null), snooze: SNOOZES.includes(Number(b.snooze)) ? Number(b.snooze) : null,
        tone: b.tone !== false, desktop: b.desktop !== false };
}
const addDays = (now, n) => new Date(now.getTime() + n * 864e5).toISOString();
/** What an outcome does to the lead's call columns: its status, its last outcome and when to come back to it. */
function dispositionPatch(key, { rules = DEFAULT_RULES, now = new Date(), callbackAt = null, attempts = 1 } = {}) {
    const o = OUTCOMES.find(x => x.key === key); if (!o) throw bad('Pick how the call went.');
    const rv = rules.revisit || DEFAULT_RULES.revisit;
    const out = { call_status: o.status, last_call_outcome: o.label, callback_at: null };
    if (o.key === 'callback') {
        const d = new Date(callbackAt);
        if (!callbackAt || isNaN(d)) throw bad('Pick when to call them back.');
        if (d < new Date(now.getTime() - 3600e3)) throw bad('The callback time has passed. Pick a later one.');
        out.callback_at = d.toISOString();
    } else if (o.retry) {
        if (o.status === 'tried' && attempts >= rules.maxAttempts) {
            out.call_status = 'closed'; out.last_call_outcome = `${o.label} (${attempts} tries in a row)`;
            out.callback_at = rv.outOfTries ? addDays(now, rv.outOfTries) : null;
        } else out.callback_at = new Date(now.getTime() + (rules.retry[o.retry] ?? DEFAULT_RULES.retry[o.retry]) * 3600e3).toISOString();
    } else if (o.revisit) out.callback_at = rv[o.revisit] ? addDays(now, rv[o.revisit]) : null;
    return out;
}
/** Calls in a row with no conversation, newest first, back to the last conversation, close or reopening. */
function triesInARow(acts, skipId = null) {
    let n = 0;
    for (const a of acts || []) {
        if (a.id && a.id === skipId) continue;
        const m = a.meta || {};
        if (a.type === 'system' && m.reopen) break;
        if (a.type !== 'call' || m.direction === 'inbound') continue;
        if (m.outOfTries || (m.outcomeKey && !TRIED.includes(m.outcomeKey))) break;
        if (m.outcomeKey ? TRIED.includes(m.outcomeKey) : m.outcome === 'No answer') n++;
    }
    return n;
}
const tagged = (l, t) => (l.tags || []).includes(t);
/** The tab a lead sits in. */
function dialTab(l) {
    if (l.client_id || ['won', 'lost'].includes(l.stage) || tagged(l, DNC_TAG)) return 'closed';
    const s = l.call_status || 'not_called';
    if (s === 'not_called' && l.in_pipeline && ['replied', 'meeting', 'proposal'].includes(l.stage)) return 'in_play';
    return STATUSES.some(x => x[0] === s) ? s : 'not_called';
}
/** Never to be offered: a client, won, do not call, or a number known to be wrong. */
const neverCall = l => !!l.client_id || l.stage === 'won' || tagged(l, DNC_TAG) || tagged(l, WRONG_TAG);
/** Is a closed lead due to be tried again (lost on a call, or out of tries, and its wait is over)? */
const revisitDue = (l, now) => dialTab(l) === 'closed' && !neverCall(l) && !!l.callback_at && new Date(l.callback_at) <= now;
/** Is the lead due a call now? A call task that is due (a callback, a campaign's call step) always counts. */
function isDue(l, rules = DEFAULT_RULES, now = new Date()) {
    if (neverCall(l)) return false;
    if (l.task_due && new Date(l.task_due) <= now) return true;
    const t = dialTab(l);
    if (t === 'closed') return revisitDue(l, now);
    if (t === 'in_play') return false;
    if (l.callback_at) return new Date(l.callback_at) <= now;
    if (t === 'not_called') return true;
    // Called before phase 91 (no try-again time): due once the no-answer wait has passed.
    return !l.last_call_at || new Date(l.last_call_at).getTime() + rules.retry.no_answer * 3600e3 <= now.getTime();
}
/** How warm a lead is, from email and the pipeline. */
function warmth(l, now = new Date()) {
    if (['replied', 'meeting', 'proposal'].includes(l.stage) || l.call_status === 'in_play') return { key: 'hot', label: 'Hot' };
    const e = l.last_email_at ? (now - new Date(l.last_email_at)) / 864e5 : null;
    if (l.in_pipeline || (e != null && e <= 7)) return { key: 'warm', label: 'Warm' };
    if (e != null) return { key: 'lukewarm', label: 'Lukewarm' };
    return { key: 'cold', label: 'Cold' };
}
function listMatch(list, l) {
    if (!list) return true;
    if (list.sources.length && !list.sources.includes(l.source)) return false;
    if (list.industries.length && !list.industries.some(i => i.toLowerCase() === String(l.industry || '').toLowerCase())) return false;
    if (list.pipeline === 'cold' && l.in_pipeline) return false;
    if (list.pipeline === 'pipeline' && !l.in_pipeline) return false;
    if (list.emailed === 'yes' && !(l.emails_count > 0)) return false;
    if (list.emailed === 'no' && l.emails_count > 0) return false;
    if (list.minScore && (Number(l.score) || 0) < list.minScore) return false;
    return true;
}
/** The lists a person may pick: all for the owner, else those open to everyone or naming them. */
const listsFor = (rules, user) => (rules.lists || []).filter(l => user.role === 'admin' || !l.people.length || l.people.includes(user.id));
/**
 * The call queue: counts for every tab, and the rows of one tab in calling order.
 * Today: call tasks and callbacks that are due, then warm leads, then never called (best score first), then retries
 * and revisits; businesses open now (in their own time zone) first.
 * opts: { list, tab, industry, q, rules, now, tzFallback, limit }
 */
function dialQueue(leads, { list = null, tab = 'today', industry = '', q = '', rules = DEFAULT_RULES, now = new Date(), tzFallback = C, limit = 300 } = {}) {
    const qq = String(q || '').toLowerCase().trim(), qd = qq.replace(/\D/g, '');
    const base = leads.filter(l => listMatch(list, l) && (!industry || String(l.industry || '').toLowerCase() === industry.toLowerCase()) &&
        (!qq || [l.company, l.full_name, l.email, l.city, l.website].join(' ').toLowerCase().includes(qq) || (qd.length >= 3 && String(l.phone || '').replace(/\D/g, '').includes(qd))));
    const counts = { today: 0, all: base.length, ...Object.fromEntries(STATUSES.map(s => [s[0], 0])) };
    const tabOf = new Map(), due = new Set();
    for (const l of base) { const t = dialTab(l); tabOf.set(l, t); counts[t]++; if (isDue(l, rules, now)) { due.add(l); counts.today++; } }
    let rows = tab === 'today' ? base.filter(l => due.has(l)) : tab === 'all' ? base : base.filter(l => tabOf.get(l) === tab);
    const lh = rules.localHours;
    const dec = l => {
        const tz = leadTimezone(l, tzFallback), open = !lh || !lh.on || withinHours(lh, tz, now), w = warmth(l, now), t = tabOf.get(l);
        const task = !!(l.task_due && new Date(l.task_due) <= now), revisit = revisitDue(l, now);
        const rank = task || t === 'callback' || (l.callback_at && t === 'spoke') ? 0 : w.key === 'hot' || w.key === 'warm' ? 1 : t === 'not_called' ? 2 : 3;
        return { l, tz, open, w, t, rank, task, revisit, opensAt: open || !lh ? null : nextOpen(lh, tz, now) };
    };
    let D = rows.map(dec);
    const ts = x => (x ? new Date(x).getTime() : 0);
    const when = x => x.task ? ts(x.l.task_due) : ts(x.l.callback_at);
    if (tab === 'today') D.sort((a, b) => (b.open - a.open) || (a.rank - b.rank) || (a.rank === 0 ? when(a) - when(b) : 0) || (a.revisit - b.revisit) ||
        (a.rank === 3 ? ((a.l.calls_count || 0) - (b.l.calls_count || 0)) || (ts(a.l.last_call_at) - ts(b.l.last_call_at)) : 0) || ((Number(b.l.score) || 0) - (Number(a.l.score) || 0)) || (ts(a.l.created_at) - ts(b.l.created_at)));
    else if (tab === 'callback') D.sort((a, b) => ts(a.l.callback_at) - ts(b.l.callback_at));
    else if (tab === 'not_called') D.sort((a, b) => (b.open - a.open) || ((Number(b.l.score) || 0) - (Number(a.l.score) || 0)) || (ts(a.l.created_at) - ts(b.l.created_at)));
    else D.sort((a, b) => ts(b.l.last_call_at || b.l.updated_at) - ts(a.l.last_call_at || a.l.updated_at));
    return {
        counts, total: D.length,
        rows: D.slice(0, limit).map(({ l, tz, open, w, t, opensAt, task, revisit }) => ({ id: l.id, company: l.company, full_name: l.full_name, phone: l.phone, industry: l.industry, source: l.source, score: l.score,
            stage: l.stage, in_pipeline: !!l.in_pipeline, tab: t, due: due.has(l), calls_count: l.calls_count || 0, last_call_at: l.last_call_at || null, last_call_outcome: l.last_call_outcome || null,
            callback_at: l.callback_at || null, emails_count: l.emails_count || 0, last_email_at: l.last_email_at || null, warmth: w.key, tz, openNow: open, opensAt: opensAt ? opensAt.toISOString() : null,
            task: task ? (l.task_title || 'Call task') : null, revisit, dnc: tagged(l, DNC_TAG), wrong: tagged(l, WRONG_TAG), campaign: l.campaign || null }))
    };
}
/** The outreach columns, from a lead's timeline (newest first): calls out and emails sent. */
function outreachFrom(acts) {
    const calls = (acts || []).filter(a => a.type === 'call' && !(a.meta && (a.meta.direction === 'inbound' || a.meta.voicemail)));
    const emails = (acts || []).filter(a => a.type === 'email_out');
    const at = list => list.reduce((m, a) => (!m || a.at > m ? a.at : m), null);
    const lastCall = [...calls].sort((a, b) => (a.at < b.at ? 1 : -1))[0];
    return { calls_count: calls.length, last_call_at: at(calls), last_call_outcome: lastCall ? ((lastCall.meta && lastCall.meta.outcome) || null) : null, emails_count: emails.length, last_email_at: at(emails) };
}
/** Reopening a lead for the call list: back where it was, due now. Not for do-not-call or a wrong number. */
function reopenPatch(l, now = new Date()) {
    if (tagged(l, DNC_TAG)) return null;
    if (tagged(l, WRONG_TAG)) return null;
    const p = { call_status: (l.calls_count || 0) > 0 ? 'tried' : 'not_called', callback_at: now.toISOString() };
    if (l.stage === 'lost') { p.stage = l.in_pipeline ? 'contacted' : 'new'; p.stage_at = now.toISOString(); p.lost_reason = null; }
    return p;
}

Object.assign(S, { zoned, zonedToUtc, withinHours, nextOpen, whenLabel, stateOf, areaCode, leadTimezone, cleanHours, cleanPhoneAccess, phoneAccess, cleanVoice, PHONE_EDGES: EDGES,
    CALL_OUTCOMES: OUTCOMES, CALL_PICKED: PICKED, CALL_STATUSES: STATUSES, DIALER_DEFAULTS: DEFAULT_RULES, cleanRules, dispositionPatch, dialTab, isDue, warmth, listMatch, listsFor, dialQueue, outreachFrom,
    triesInARow, revisitDue, neverCall, reopenPatch, cleanCallerPrefs, DNC_TAG, WRONG_TAG, REMINDER_STEPS });

// ------------------------------------------------------------------ settings
const getSetting = (k, d) => (S.getSetting ? S.getSetting(k, d) : Promise.resolve(d));
const accessSetting = () => getSetting('phone_access', null);
const voiceSetting = async () => cleanVoice(await getSetting('phone_voice', {}));
async function rulesSetting() { try { return cleanRules(await getSetting('dialer_rules', DEFAULT_RULES)); } catch { return cleanRules(DEFAULT_RULES); } }
const _roles = new Map();
async function roleOf(userId) {
    const hit = _roles.get(userId); if (hit && Date.now() - hit.at < 60000) return hit.role;
    const { data } = await supabase.from('app_users').select('role, is_active').eq('id', userId).maybeSingle();
    const role = data && data.is_active !== false ? data.role : null;
    _roles.set(userId, { role, at: Date.now() }); return role;
}
/** The phone module asks this before a call goes out, and before ringing someone. */
S.phoneAccessFor = async (userId, now = new Date()) => {
    const role = await roleOf(userId); if (!role || role === 'client') return { allowed: false, why: 'no_access', text: 'Not on the team.' };
    return phoneAccess(await accessSetting(), { id: userId, role }, now);
};
S.phoneVoice = voiceSetting;

/** Recount a lead's calls and emails from its timeline. Never throws: it runs after the real work is done. */
S.refreshOutreach = async leadId => {
    try {
        if (!leadId || !(await S.p91Ready())) return;
        const [{ data: acts }, { data: lead }] = await Promise.all([
            supabase.from('crm_activities').select('type, at, meta').eq('lead_id', leadId).in('type', ['call', 'email_out']).order('at', { ascending: false }).limit(2000),
            supabase.from('crm_leads').select('call_status, callback_at').eq('id', leadId).maybeSingle()]);
        if (!lead) return;
        const patch = outreachFrom(acts || []);
        if (lead.call_status === 'not_called' && patch.calls_count > 0) {        // dialled without an outcome: a try
            patch.call_status = 'tried';
            if (!lead.callback_at) patch.callback_at = new Date(Date.now() + (await rulesSetting()).retry.no_answer * 3600e3).toISOString();
        }
        await supabase.from('crm_leads').update(patch).eq('id', leadId);
    } catch (e) { logger.warn('outreach_refresh_failed', { lead: leadId, message: e.message }); }
};

// ------------------------------------------------------------------ routes
async function staff(req, res) {
    const ctx = await S.auth(req, res); if (!ctx) return null;
    if (S.staffOnly && !S.staffOnly(ctx, res)) return null;
    return ctx;
}
function fail(res, e, where) {
    if (e && e.statusCode === 400) return res.status(400).json({ error: e.message });
    if (e && e.statusCode === 403) return res.status(403).json({ error: e.message, code: e.code });
    logger.error(where, { message: e && e.message });
    return res.status(500).json({ error: 'Something went wrong on our side. Try again in a moment.' });
}
const QUEUE_COLS = 'id, full_name, company, phone, email, website, city, country, timezone, source, industry, stage, score, tags, owner_id, client_id, in_pipeline, created_at, updated_at';
const Q91 = ', call_status, calls_count, last_call_at, last_call_outcome, callback_at, emails_count, last_email_at';

/** Each lead's active email campaign: { name, step, next_at }. Empty before the phase-90 SQL. */
async function campaignsOf(leadIds) {
    const out = new Map();
    if (!leadIds.length || !(await S.p90Ready())) return out;
    const en = [];
    for (let i = 0; i < leadIds.length; i += 300) {
        const { data } = await supabase.from('crm_enrollments').select('lead_id, campaign_id, step, next_at').eq('status', 'active').in('lead_id', leadIds.slice(i, i + 300));
        en.push(...(data || []));
    }
    if (!en.length) return out;
    const { data: cs } = await supabase.from('crm_campaigns').select('id, name').in('id', [...new Set(en.map(e => e.campaign_id))]);
    const names = new Map((cs || []).map(c => [c.id, c.name]));
    for (const e of en) out.set(e.lead_id, { name: names.get(e.campaign_id) || 'A campaign', step: e.step, next_at: e.next_at });
    return out;
}
S.campaignsOf = campaignsOf;
/** Stop a lead's active campaigns because of a call. */
async function stopCampaigns(leadId, reason) {
    if (!(await S.p90Ready())) return 0;
    const { data } = await supabase.from('crm_enrollments').update({ status: 'stopped', next_at: null, stop_reason: reason }).eq('lead_id', leadId).eq('status', 'active').select('id');
    return (data || []).length;
}
/** Is this number (or lead) one we may not call? */
S.doNotCall = async ({ leadId, number }) => {
    if (leadId && S.UUID_RE.test(leadId)) {
        const { data } = await supabase.from('crm_leads').select('tags').eq('id', leadId).maybeSingle();
        if (data && (data.tags || []).includes(DNC_TAG)) return true;
    }
    const d = String(number || '').replace(/\D/g, '').slice(-10);
    if (d.length < 10) return false;
    const { data } = await supabase.from('crm_leads').select('tags, phone_norm').like('phone_norm', '%' + d).limit(5);
    return (data || []).some(l => (l.tags || []).includes(DNC_TAG));
};
const ownTasks = (q, ctx) => ctx.profile.role === 'admin' ? q : q.or(`owner_id.eq.${ctx.user.id},owner_id.is.null`);

/** Calls → Home: the lists this person may use, the counts per tab and the leads of one tab, in calling order. */
app.get('/api/crm/dialer', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        const [rules, crm, p91, p90] = await Promise.all([rulesSetting(), S.crmSettings ? S.crmSettings() : { timezone: C }, S.p91Ready(), S.p90Ready()]);
        const me = { id: ctx.user.id, role: ctx.profile.role };
        const lists = listsFor(rules, me), list = lists.find(l => l.id === req.query.list) || null;
        const cols = (p90 ? QUEUE_COLS : QUEUE_COLS.replace(', in_pipeline', '').replace(', industry', '')) + (p91 ? Q91 : '');
        const leads = [];
        for (let from = 0; from < 20000; from += 1000) {
            let q = supabase.from('crm_leads').select(cols).not('phone', 'is', null).order('created_at', { ascending: true }).range(from, from + 999);
            if (list && list.sources.length) q = q.in('source', list.sources);
            const { data, error } = await q; if (error) throw error;
            leads.push(...(data || [])); if (!data || data.length < 1000) break;
        }
        // Call tasks that are due (callbacks, a campaign's call step) put their lead at the top of Today.
        const now = new Date();
        const { data: tasks } = await ownTasks(supabase.from('crm_tasks').select('lead_id, title, due_at' + (p90 ? ', kind' : '')).is('done_at', null).lte('due_at', now.toISOString()).not('lead_id', 'is', null).limit(2000), ctx);
        const taskOf = new Map();
        for (const t of tasks || []) if ((t.kind ? t.kind === 'call' : /^call\b/i.test(t.title || '')) && (!taskOf.has(t.lead_id) || t.due_at < taskOf.get(t.lead_id).due_at)) taskOf.set(t.lead_id, t);
        const camp = await campaignsOf(leads.map(l => l.id));
        for (const l of leads) { const t = taskOf.get(l.id); if (t) { l.task_due = t.due_at; l.task_title = t.title; } const c = camp.get(l.id); if (c) l.campaign = c; }
        const tab = ['today', 'all', ...STATUSES.map(s => s[0])].includes(req.query.tab) ? req.query.tab : 'today';
        const queue = dialQueue(leads.filter(l => String(l.phone || '').replace(/\D/g, '').length >= 7), { list, tab, industry: String(req.query.industry || ''), q: String(req.query.q || '').slice(0, 80), rules, tzFallback: crm.timezone, limit: 400, now });
        // The caller's day so far, in the business's day.
        const day = S.dayBounds ? S.dayBounds(crm.timezone, 'today') : { start: new Date(new Date().setHours(0, 0, 0, 0)) };
        const [{ count: placed }, { data: logged }] = await Promise.all([
            supabase.from('phone_calls').select('id', { count: 'exact', head: true }).eq('direction', 'outbound').eq('user_id', ctx.user.id).gte('started_at', day.start.toISOString()),
            supabase.from('crm_activities').select('meta').eq('type', 'call').eq('actor_id', ctx.user.id).gte('at', day.start.toISOString()).limit(2000)]);
        const talks = (logged || []).filter(a => a.meta && ((a.meta.picked && a.meta.picked !== 'none') || a.meta.outcome === 'Spoke')).length;
        const industries = [...new Set(leads.map(l => l.industry).filter(Boolean))].sort((a, b) => a.localeCompare(b));
        res.json({ p91, tab, bizTz: crm.timezone, lists: lists.map(l => ({ id: l.id, name: l.name })), list: list ? list.id : '', industries, ...queue,
            today: { calls: Math.max(placed || 0, (logged || []).length), conversations: talks }, rules: { maxAttempts: rules.maxAttempts, localHours: rules.localHours, revisit: rules.revisit },
            outcomes: OUTCOMES.map(o => ({ key: o.key, label: o.label, who: o.who, status: o.status })), picked: PICKED, statuses: STATUSES });
    } catch (e) { fail(res, e, 'dialer_queue'); }
});

/** After a call: who picked up and how it went. It files the call, then does what the outcome means, everywhere. */
app.post('/api/crm/dialer/outcome', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        const b = req.body || {};
        const access = await S.phoneAccessFor(ctx.user.id);
        if (!access.allowed) throw Object.assign(new Error(access.text || 'Calling is closed for you right now.'), { statusCode: 403, code: 'phone_locked' });
        const o = OUTCOMES.find(x => x.key === b.outcome); if (!o) throw bad('Pick how the call went.');
        const picked = PICKED[b.picked] ? b.picked : (o.who.length === 1 ? o.who[0] : null);
        if (!picked) throw bad('Say who picked up.');
        if (!o.who.includes(picked)) throw bad(`"${o.label}" does not fit "${PICKED[picked]}". Pick again.`);
        const p91 = await S.p91Ready(), p90 = await S.p90Ready();
        const { data: lead } = await supabase.from('crm_leads').select(await S.leadCols()).eq('id', String(b.lead_id || '')).maybeSingle();
        if (!lead) return res.status(404).json({ error: 'That lead was not found.' });
        const rules = await rulesSetting(), now = new Date(), note = str(b.note, 3000) || null;
        const sid = /^CA[0-9a-f]{32}$/i.test(b.sid || '') ? b.sid : null;
        // The call on the timeline: the one the phone filed for this call, else a new one.
        const meta = { outcome: o.label, outcomeKey: o.key, picked, direction: 'outbound', ...(sid ? { sid } : {}), ...(b.askedEmail ? { askedEmail: true } : {}), ...(b.callbackAt && o.key === 'callback' ? { callbackAt: b.callbackAt } : {}) };
        let filed = null;
        if (sid) { const { data } = await supabase.from('crm_activities').select('id, meta, body').eq('lead_id', lead.id).eq('type', 'call').eq('meta->>sid', sid).maybeSingle(); filed = data; }
        // Tries in a row with no conversation, this one included: after the set number the lead rests.
        const { data: past } = await supabase.from('crm_activities').select('id, type, meta, at').eq('lead_id', lead.id).in('type', ['call', 'system']).order('at', { ascending: false }).limit(200);
        const attempts = triesInARow(past || [], filed && filed.id) + 1;
        const cols = p91 ? dispositionPatch(o.key, { rules, now, callbackAt: b.callbackAt, attempts }) : null;
        if (cols && o.status === 'tried' && cols.call_status === 'closed') meta.outOfTries = true;
        if (filed) await supabase.from('crm_activities').update({ meta: { ...(filed.meta || {}), ...meta }, body: note || filed.body, actor_id: ctx.user.id }).eq('id', filed.id);
        else {
            const secs = Math.round(Number(b.seconds)); if (Number.isFinite(secs) && secs > 0) meta.minutes = Math.round(secs / 6) / 10;
            await supabase.from('crm_activities').insert({ lead_id: lead.id, type: 'call', body: note, meta, actor_id: ctx.user.id });
        }
        if (sid) await supabase.from('phone_calls').update({ lead_id: lead.id, ...(note ? { note } : {}) }).eq('sid', sid);

        const patch = { updated_at: now.toISOString(), last_activity_at: now.toISOString(), ...(cols || {}) };
        const tags = new Set(lead.tags || []);
        if (o.dnc) { tags.add(DNC_TAG); patch.unsubscribed = true; }
        if (o.wrong) tags.add(WRONG_TAG);
        if (o.dnc || o.wrong) patch.tags = [...tags];
        // The sales stage follows the call: Interested and Booked a meeting move it on (also out of Lost); Not interested loses it.
        let toStage = null;
        if (o.pipeline) {
            if (p90 && !lead.in_pipeline) { patch.in_pipeline = true; patch.pipeline_at = now.toISOString(); }
            if (o.stage === 'meeting' && ['new', 'contacted', 'replied', 'lost'].includes(lead.stage)) toStage = 'meeting';
            else if (['new', 'lost'].includes(lead.stage)) toStage = 'contacted';
            if (lead.stage === 'lost') patch.lost_reason = null;
        }
        if (o.lose && !lead.client_id && !['won', 'lost'].includes(lead.stage)) { toStage = 'lost'; patch.lost_reason = `${o.label} (on a call)`; }
        if (toStage) { patch.stage = toStage; patch.stage_at = now.toISOString(); }
        await supabase.from('crm_leads').update(patch).eq('id', lead.id);
        if (toStage) await supabase.from('crm_activities').insert({ lead_id: lead.id, type: 'stage', meta: { from: lead.stage, to: toStage, auto: 'call' }, actor_id: ctx.user.id });
        if (patch.in_pipeline) await supabase.from('crm_activities').insert({ lead_id: lead.id, type: 'system', body: 'Added to the pipeline from a call', meta: {}, actor_id: ctx.user.id });
        const stopped = o.stopEmail ? await stopCampaigns(lead.id, `Call: ${o.label}`) : 0;
        if (stopped) await supabase.from('crm_activities').insert({ lead_id: lead.id, type: 'system', body: `Email campaign stopped: ${o.label} on a call`, meta: { campaignsStopped: stopped }, actor_id: ctx.user.id });
        // Open call tasks on this lead are done: this call was it. A callback, or an email they asked for, is a new task.
        await supabase.from('crm_tasks').update({ done_at: now.toISOString() }).eq('lead_id', lead.id).is('done_at', null).ilike('title', 'Call%');
        if (p90) await supabase.from('crm_tasks').update({ done_at: now.toISOString() }).eq('lead_id', lead.id).is('done_at', null).eq('kind', 'call').lte('due_at', new Date(now.getTime() + 864e5).toISOString());
        const name = lead.company || lead.full_name, tasks = [];
        if (o.key === 'callback') tasks.push({ title: `Call ${name} back`, due_at: (cols && cols.callback_at) || new Date(b.callbackAt).toISOString(), ...(p90 ? { kind: 'call' } : {}) });
        if (b.askedEmail) tasks.push({ title: `Email ${name}: they asked on the call`, due_at: now.toISOString(), ...(p90 ? { kind: 'email' } : {}) });
        if (tasks.length) await supabase.from('crm_tasks').insert(tasks.map(t => ({ lead_id: lead.id, owner_id: ctx.user.id, created_by: ctx.user.id, ...t })));
        await S.refreshOutreach(lead.id);
        if (cols) await supabase.from('crm_leads').update({ call_status: cols.call_status, callback_at: cols.callback_at, last_call_outcome: cols.last_call_outcome }).eq('id', lead.id);   // the outcome wins over the recount
        const { data: fresh } = await supabase.from('crm_leads').select(await S.leadCols()).eq('id', lead.id).maybeSingle();
        logger.info('dialer_outcome', { by: ctx.user.id, lead: lead.id, outcome: o.key, picked, stage: toStage, stopped });
        res.json({ lead: fresh, p91, stage: toStage, campaignsStopped: stopped, outOfTries: !!meta.outOfTries });
    } catch (e) { fail(res, e, 'dialer_outcome'); }
});

/** Back to the call list, due now: from Leads (bulk) or the lead record. Not for do-not-call or a wrong number. */
app.post('/api/crm/dialer/reopen', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        if (!(await S.p91Ready())) throw bad('Run the phase-91 SQL first.');
        const ids = (Array.isArray(req.body && req.body.ids) ? req.body.ids : []).map(String).filter(x => S.UUID_RE.test(x)).slice(0, 500);
        if (!ids.length) throw bad('Pick at least one lead.');
        const { data: leads } = await supabase.from('crm_leads').select('id, stage, in_pipeline, tags, calls_count, client_id').in('id', ids);
        const now = new Date(), out = { reopened: 0, dnc: 0, wrong: 0, clients: 0 };
        for (const l of leads || []) {
            if (l.client_id || l.stage === 'won') { out.clients++; continue; }
            const p = reopenPatch(l, now);
            if (!p) { if ((l.tags || []).includes(DNC_TAG)) out.dnc++; else out.wrong++; continue; }
            await supabase.from('crm_leads').update({ ...p, updated_at: now.toISOString() }).eq('id', l.id);
            await supabase.from('crm_activities').insert({ lead_id: l.id, type: 'system', body: 'Back in the call list', meta: { reopen: true }, actor_id: ctx.user.id });
            if (p.stage) await supabase.from('crm_activities').insert({ lead_id: l.id, type: 'stage', meta: { from: l.stage, to: p.stage, auto: 'reopen' }, actor_id: ctx.user.id });
            out.reopened++;
        }
        res.json(out);
    } catch (e) { fail(res, e, 'dialer_reopen'); }
});

// ------------------------------------------------------------------ Calls → My numbers (pure, tested)
const RANGES = { today: 0, '7d': 6, '30d': 29, '90d': 89 };
const ymd = (tz, at) => { const z = zoned(tz, at); return `${z.y}-${String(z.m).padStart(2, '0')}-${String(z.d).padStart(2, '0')}`; };
/**
 * A caller's numbers over a period. phoneCalls: their outbound calls from the app; acts: the calls on lead timelines
 * they logged (an outcome, or by hand); tasks: their callback tasks due in the period; leads: id → lead, for time zones.
 */
function callStats({ phoneCalls = [], acts = [], tasks = [], leads = new Map(), from, to = new Date(), tz = C, tzFallback = C }) {
    const out = acts.filter(a => !(a.meta && a.meta.direction === 'inbound'));
    const hand = out.filter(a => !(a.meta && a.meta.sid));
    const calls = phoneCalls.length + hand.length;
    const disp = out.filter(a => a.meta && a.meta.outcomeKey);
    const by = k => disp.filter(a => a.meta.picked === k).length;
    const outc = k => disp.filter(a => a.meta.outcomeKey === k).length;
    const answered = disp.filter(a => a.meta.picked && a.meta.picked !== 'none').length, owner = by('owner');
    const hours = new Set([...phoneCalls.map(c => c.started_at), ...hand.map(a => a.at)].map(t => { const z = zoned(tz, new Date(t)); return `${ymd(tz, new Date(t))} ${z.h}`; }));
    const timed = phoneCalls.filter(c => Number(c.duration) > 0);
    const seconds = timed.reduce((s, c) => s + Number(c.duration), 0) + hand.reduce((s, a) => s + Math.round((Number(a.meta && a.meta.minutes) || 0) * 60), 0);
    const leadsCalled = new Set([...phoneCalls.map(c => c.lead_id), ...out.map(a => a.lead_id)].filter(Boolean)).size;
    const cbDue = tasks.filter(t => t.due_at <= to.toISOString());
    // When owners pick up, by the hour on their own clock. Hours with fewer than 8 outcomes are not compared.
    const perHour = {};
    for (const a of disp) { const l = leads.get(a.lead_id); const h = zoned(leadTimezone(l, tzFallback), new Date(a.at)).h; const x = perHour[h] = perHour[h] || { calls: 0, owner: 0 }; x.calls++; if (a.meta.picked === 'owner') x.owner++; }
    const best = Object.entries(perHour).filter(([, x]) => x.calls >= 8 && x.owner).map(([h, x]) => ({ hour: +h, calls: x.calls, owner: x.owner, rate: x.owner / x.calls })).sort((a, b) => b.rate - a.rate || b.calls - a.calls)[0] || null;
    // Calls by day, split by who picked up (calls without an outcome are "not logged").
    const byDay = [];
    for (let d = new Date(from); ymd(tz, d) <= ymd(tz, to); d = new Date(d.getTime() + 864e5)) byDay.push({ day: ymd(tz, d), owner: 0, front_desk: 0, someone: 0, none: 0, unlogged: 0 });
    const dayOf = new Map(byDay.map(x => [x.day, x]));
    const loggedSids = new Set(disp.map(a => a.meta.sid).filter(Boolean));
    for (const a of disp) { const x = dayOf.get(ymd(tz, new Date(a.at))); if (x) x[a.meta.picked] = (x[a.meta.picked] || 0) + 1; }
    for (const c of phoneCalls) if (!loggedSids.has(c.sid)) { const x = dayOf.get(ymd(tz, new Date(c.started_at))); if (x) x.unlogged++; }
    const pct = (a, b) => b ? Math.round(a / b * 100) : 0;
    return {
        calls, leadsCalled, perHour: hours.size ? Math.round(calls / hours.size * 10) / 10 : 0, hoursWithCalls: hours.size,
        outcomes: disp.length, answered, answeredPct: pct(answered, disp.length), owner, ownerPct: pct(owner, disp.length), frontDesk: by('front_desk'), someone: by('someone'), noOne: by('none'),
        seconds, avgSeconds: timed.length ? Math.round(timed.reduce((s, c) => s + Number(c.duration), 0) / timed.length) : 0, timedCalls: timed.length,
        callbacksSet: outc('callback'), callbacksDue: cbDue.length, callbacksMade: cbDue.filter(t => t.done_at).length,
        emailsAsked: disp.filter(a => a.meta.askedEmail).length, interested: outc('interested'), meetings: outc('meeting'), meetingsPct: pct(outc('meeting'), owner),
        notInterested: outc('not_interested') + outc('not_fit'), wrongNumbers: outc('wrong_number'), dnc: outc('dnc'), noTimer: disp.filter(a => !a.meta.sid).length,
        byOutcome: OUTCOMES.map(o => ({ key: o.key, label: o.label, n: outc(o.key) })).filter(x => x.n), best, byDay
    };
}
S.callStats = callStats;

app.get('/api/crm/calls/stats', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        const crm = S.crmSettings ? await S.crmSettings() : { timezone: C };
        const tz = crm.timezone, range = Object.prototype.hasOwnProperty.call(RANGES, req.query.range) ? req.query.range : '7d';
        const today = S.dayBounds(tz, 'today'), from = new Date(today.start.getTime() - RANGES[range] * 864e5), to = new Date();
        const isOwner = ctx.profile.role === 'admin';
        const who = isOwner && (req.query.user === 'all' || S.UUID_RE.test(req.query.user || '')) ? req.query.user : ctx.user.id;
        const pc = supabase.from('phone_calls').select('sid, lead_id, duration, started_at, status').eq('direction', 'outbound').gte('started_at', from.toISOString()).limit(20000);
        const ac = supabase.from('crm_activities').select('id, lead_id, meta, at').eq('type', 'call').gte('at', from.toISOString()).limit(20000);
        const tk = supabase.from('crm_tasks').select('due_at, done_at, title' + (await S.p90Ready() ? ', kind' : '')).gte('due_at', from.toISOString()).lte('due_at', to.toISOString()).ilike('title', 'Call%').limit(5000);
        const [{ data: phoneCalls }, { data: acts }, { data: tasks }, { data: users }] = await Promise.all([
            who === 'all' ? pc : pc.eq('user_id', who), who === 'all' ? ac : ac.eq('actor_id', who), who === 'all' ? tk : tk.eq('owner_id', who),
            isOwner ? supabase.from('app_users').select('id, full_name, email').in('role', ['admin', 'user']).eq('is_active', true) : Promise.resolve({ data: [] })]);
        const ids = [...new Set((acts || []).map(a => a.lead_id).filter(Boolean))];
        const leads = new Map();
        for (let i = 0; i < ids.length; i += 300) { const { data } = await supabase.from('crm_leads').select('id, city, country, phone, timezone').in('id', ids.slice(i, i + 300)); (data || []).forEach(l => leads.set(l.id, l)); }
        res.json({ range, from: from.toISOString(), to: to.toISOString(), tz, person: who,
            people: isOwner ? (users || []).map(u => ({ id: u.id, name: u.full_name || (u.email || '').split('@')[0] })) : [],
            stats: callStats({ phoneCalls: phoneCalls || [], acts: acts || [], tasks: tasks || [], leads, from, to, tz, tzFallback: tz }) });
    } catch (e) { fail(res, e, 'call_stats'); }
});

// ------------------------------------------------------------------ the caller's own settings and reminders
const prefsKey = id => 'caller_prefs:' + id;
async function prefsFor(userId) {
    const [own, rules] = await Promise.all([getSetting(prefsKey(userId), {}), rulesSetting()]);
    const p = cleanCallerPrefs(own || {});
    return { own: p, office: { reminders: rules.reminders, snooze: rules.snooze },
        effective: { reminders: p.reminders || rules.reminders, snooze: p.snooze || rules.snooze, tone: p.tone, desktop: p.desktop }, steps: REMINDER_STEPS };
}
app.get('/api/crm/caller-prefs', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try { res.json(await prefsFor(ctx.user.id)); } catch (e) { fail(res, e, 'caller_prefs_get'); }
});
app.put('/api/crm/caller-prefs', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try { await S.putSetting(prefsKey(ctx.user.id), cleanCallerPrefs(req.body || {})); res.json(await prefsFor(ctx.user.id)); } catch (e) { fail(res, e, 'caller_prefs_put'); }
});
/** What to remind this caller about: their open callbacks and to-dos with a time, from two hours ago to a day ahead. */
app.get('/api/crm/reminders', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        const now = Date.now();
        const { data: tasks } = await supabase.from('crm_tasks').select('id, lead_id, title, due_at' + (await S.p90Ready() ? ', kind' : '')).eq('owner_id', ctx.user.id).is('done_at', null)
            .gte('due_at', new Date(now - 2 * 3600e3).toISOString()).lte('due_at', new Date(now + 25 * 3600e3).toISOString()).order('due_at', { ascending: true }).limit(200);
        const ids = [...new Set((tasks || []).map(t => t.lead_id).filter(Boolean))];
        const { data: leads } = ids.length ? await supabase.from('crm_leads').select('id, full_name, company, phone, tags').in('id', ids) : { data: [] };
        const byId = new Map((leads || []).map(l => [l.id, l]));
        res.json({ prefs: (await prefsFor(ctx.user.id)).effective, reminders: (tasks || []).map(t => ({ ...t, kind: t.kind || (/^call\b/i.test(t.title) ? 'call' : 'todo'), lead: byId.get(t.lead_id) || null })) });
    } catch (e) { fail(res, e, 'reminders'); }
});

// ------------------------------------------------------------------ admin
app.get('/api/admin/phone/settings', async (req, res) => {
    const ctx = await S.requireAdmin(req, res); if (!ctx) return;
    try {
        const [raw, voice, { data: users }] = await Promise.all([accessSetting(), voiceSetting(), supabase.from('app_users').select('id, full_name, email, role, is_active').in('role', ['admin', 'user'])]);
        const cfg = raw || null, shown = cfg || { enabled: true, tz: E, hours: DEFAULT_HOURS, people: {} };
        res.json({ saved: !!cfg, access: shown, voice, edges: EDGES, tzs: [E, C, M, P, 'America/Phoenix', 'Asia/Dhaka', 'Europe/London'],
            people: (users || []).filter(u => u.is_active !== false).map(u => ({ id: u.id, name: u.full_name || (u.email || '').split('@')[0], email: u.email, role: u.role,
                now: phoneAccess(cfg, { id: u.id, role: u.role }) })) });
    } catch (e) { fail(res, e, 'phone_settings_get'); }
});
app.put('/api/admin/phone/settings', async (req, res) => {
    const ctx = await S.requireAdmin(req, res); if (!ctx) return;
    try {
        const b = req.body || {};
        if (b.access !== undefined) await S.putSetting('phone_access', cleanPhoneAccess(b.access));
        if (b.voice !== undefined) await S.putSetting('phone_voice', cleanVoice(b.voice));
        _roles.clear();
        logger.info('phone_settings', { by: ctx.user.id, keys: Object.keys(b) });
        res.json({ ok: true });
    } catch (e) { fail(res, e, 'phone_settings_put'); }
});
app.get('/api/admin/dialer', async (req, res) => {
    const ctx = await S.requireAdmin(req, res); if (!ctx) return;
    try { res.json({ rules: await rulesSetting(), defaults: DEFAULT_RULES, outcomes: OUTCOMES, steps: REMINDER_STEPS, p91: await S.p91Ready() }); } catch (e) { fail(res, e, 'dialer_rules_get'); }
});
app.put('/api/admin/dialer', async (req, res) => {
    const ctx = await S.requireAdmin(req, res); if (!ctx) return;
    try { const rules = cleanRules(req.body && req.body.rules); await S.putSetting('dialer_rules', rules); logger.info('dialer_rules', { by: ctx.user.id, lists: rules.lists.length }); res.json({ rules }); }
    catch (e) { fail(res, e, 'dialer_rules_put'); }
});
