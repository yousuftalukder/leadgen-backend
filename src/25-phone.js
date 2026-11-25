'use strict';
/**
 * Phase 88: the phone. Calls, texts and voicemail on the business number, inside the CRM.
 *
 *   Browser calls use Twilio's Voice SDK. This server hands out a short access token and answers
 *   Twilio's webhooks with TwiML. Nothing here needs the twilio npm package: the token is a signed
 *   JWT, the webhook check is an HMAC, and texts and usage go over Twilio's REST API.
 *
 *   Incoming call:
 *     open hours (Mon–Sat 8–18, Central): rings every signed-in teammate for 20 s
 *       → no answer: forwards to PHONE_FORWARD_TO for 20 s (when set)
 *       → still nothing: greeting and voicemail (transcribed, emailed)
 *     after hours: greeting and voicemail
 *     missed: an automatic text, once texting is approved (PHONE_SMS_ENABLED=1)
 *   Outgoing call: from the app, showing the business number.
 *
 * Settings (Render environment):
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN               the account
 *   TWILIO_API_KEY, TWILIO_API_SECRET                    an API key, for browser-call tokens
 *   TWILIO_TWIML_APP_SID                                 the TwiML App whose voice URL is /api/phone/voice
 *   PHONE_NUMBER            default +14698194097         the business number
 *   PHONE_FORWARD_TO        optional                     a mobile to try when nobody answers in the app
 *   PHONE_VOICEMAIL_EMAIL   default info@edgehometx.com
 *   PHONE_SMS_ENABLED       1 once A2P 10DLC is approved
 *   PHONE_RECORD            1 to record answered calls (callers hear a short notice)
 *   PHONE_PUBLIC_URL        default this server's Render address, for webhook signatures and callbacks
 */
const crypto = require('crypto');
const S = require('./shared');
const { app, supabase, logger } = S;

const DEFAULT_NUMBER = '+14698194097';
const TZ = 'America/Chicago';
const OPEN = { days: [1, 2, 3, 4, 5, 6], from: 8, to: 18 };        // Mon–Sat, 8 AM–6 PM
const BUSINESS = 'Edge Home Services';
const KINDS = ['homeowner', 'property_manager', 'warranty', 'technician', 'vendor', 'other'];
const TEMPLATES = [
    { key: 'confirm', label: 'Confirm appointment', body: 'Hi, this is Edge Home Services confirming your appointment. Reply YES to confirm or call us at (469) 819-4097 to change it.' },
    { key: 'onway', label: 'Technician on the way', body: 'Hi, this is Edge Home Services. Your technician is on the way and should arrive shortly.' },
    { key: 'report', label: 'Diagnosis done', body: 'Hi, this is Edge Home Services. The diagnosis is done and we have sent the report. Reply here with any questions.' }
];
const MISSED_TEXT = 'Sorry we missed you. We\'ll call you back shortly. Reply here to text us. – Edge Home Services';

/** A setting from the server, with stray spaces, newlines and quotes from pasting removed. */
const env = k => String(process.env[k] || '').trim().replace(/^["']|["']$/g, '').trim();
const cfg = () => ({
    sid: env('TWILIO_ACCOUNT_SID'), token: env('TWILIO_AUTH_TOKEN'),
    key: env('TWILIO_API_KEY'), secret: env('TWILIO_API_SECRET'), appSid: env('TWILIO_TWIML_APP_SID'),
    number: toE164(process.env.PHONE_NUMBER || DEFAULT_NUMBER), forward: process.env.PHONE_FORWARD_TO ? toE164(process.env.PHONE_FORWARD_TO) : null,
    email: process.env.PHONE_VOICEMAIL_EMAIL || 'info@edgehometx.com', sms: process.env.PHONE_SMS_ENABLED === '1', record: process.env.PHONE_RECORD === '1',
    base: String(process.env.PHONE_PUBLIC_URL || 'https://leadgen-backend-1-mgzc.onrender.com').replace(/\/+$/, '')
});
const missingSettings = c => [['TWILIO_ACCOUNT_SID', c.sid], ['TWILIO_AUTH_TOKEN', c.token], ['TWILIO_API_KEY', c.key], ['TWILIO_API_SECRET', c.secret], ['TWILIO_TWIML_APP_SID', c.appSid]].filter(([, v]) => !v).map(([k]) => k);

// ------------------------------------------------------------------ pure helpers (tested)
/** Any way a number is written → E.164. US numbers by default; Bangladeshi local 01… numbers too. */
function toE164(raw) {
    const s = String(raw || '').trim(); if (!s) return null;
    let d = s.replace(/\D/g, ''); if (!d) return null;
    if (s.startsWith('+')) return d.length >= 8 && d.length <= 15 ? '+' + d : null;
    if (d.startsWith('00')) d = d.slice(2);
    else if (d.length === 10) d = '1' + d;                                   // US without the 1
    else if (d.length === 11 && d.startsWith('01')) d = '88' + d;            // Bangladesh local mobile
    return d.length >= 8 && d.length <= 15 ? '+' + d : null;
}
/** (469) 819-4097 for US numbers, the E.164 form otherwise. */
function prettyNumber(e164) {
    const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 || ''); return m ? `(${m[1]}) ${m[2]}-${m[3]}` : (e164 || '');
}
const last10 = n => String(n || '').replace(/\D/g, '').slice(-10);

/** Twilio's request signature: HMAC-SHA1 of the full URL followed by every POST field, sorted by name. */
function twilioSignature(authToken, url, params = {}) {
    const data = url + Object.keys(params).sort().map(k => k + params[k]).join('');
    return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}
function validTwilio(authToken, signature, url, params) {
    if (!authToken || !signature) return false;
    const a = Buffer.from(twilioSignature(authToken, url, params)), b = Buffer.from(String(signature));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** A Twilio access token with a Voice grant: a JWT signed with the API key's secret. */
function voiceToken({ accountSid, apiKey, apiSecret, appSid, identity, ttl = 3600, now = Math.floor(Date.now() / 1000) }) {
    const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
    const head = b64({ typ: 'JWT', alg: 'HS256', cty: 'twilio-fpa;v=1' });
    const body = b64({ jti: `${apiKey}-${now}`, iss: apiKey, sub: accountSid, iat: now, nbf: now, exp: now + ttl,
        grants: { identity, voice: { incoming: { allow: true }, outgoing: { application_sid: appSid } } } });
    const sig = crypto.createHmac('sha256', apiSecret).update(head + '.' + body).digest('base64url');
    return `${head}.${body}.${sig}`;
}

/** Open hours in Central time. */
function isOpen(date = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(date).map(p => [p.type, p.value]));
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday), hour = Number(parts.hour);
    return OPEN.days.includes(day) && hour >= OPEN.from && hour < OPEN.to;
}

const x = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const twiml = inner => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
const SAY = t => `<Say voice="Polly.Joanna">${x(t)}</Say>`;
function voicemailTwiml(base) {
    return twiml(SAY(`Thanks for calling ${BUSINESS}. We can't take your call right now. Please leave your name, number and a short message after the tone, and we'll call you back.`) +
        `<Record maxLength="180" playBeep="true" timeout="6" transcribe="true" transcribeCallback="${base}/api/phone/hook/transcription" recordingStatusCallback="${base}/api/phone/hook/recording" action="${base}/api/phone/hook/bye"/>`);
}
function ringTeamTwiml(base, identities, { record, parentSid, from } = {}) {
    if (!identities.length) return voicemailTwiml(base);
    return twiml((record ? SAY('This call may be recorded.') : '') +
        `<Dial timeout="20" answerOnBridge="true" action="${base}/api/phone/hook/after"${record ? ' record="record-from-answer-dual"' : ''}>` +
        identities.slice(0, 10).map(i => `<Client><Identity>${x(i)}</Identity><Parameter name="pcs" value="${x(parentSid || '')}"/><Parameter name="caller" value="${x(from || '')}"/></Client>`).join('') + `</Dial>`);
}
function outgoingTwiml(base, { callerId, to, record }) {
    return twiml(`<Dial callerId="${x(callerId)}" answerOnBridge="true" action="${base}/api/phone/hook/done"${record ? ' record="record-from-answer-dual"' : ''}>` +
        `<Number statusCallback="${base}/api/phone/hook/status" statusCallbackEvent="answered completed">${x(to)}</Number></Dial>`);
}

/**
 * Conversations, newest first: one per outside number, from calls and texts.
 * contacts: [{ number, name, kind }]   leads: [{ id, full_name, company, phone_norm }]
 */
function phoneThreads(calls, messages, contacts = [], leads = []) {
    const byNum = new Map();
    const touch = (num, item) => {
        if (!num) return;
        const t = byNum.get(num) || { number: num, last: null, unread: 0, missed: 0, voicemail: 0, calls: 0, texts: 0 };
        if (!t.last || new Date(item.at) > new Date(t.last.at)) t.last = item;
        byNum.set(num, t); return t;
    };
    for (const c of calls) {
        const t = touch(c.contact_number, { kind: 'call', at: c.started_at, direction: c.direction, status: c.status, duration: c.duration, voicemail: !!c.voicemail });
        if (!t) continue; t.calls++;
        if (c.direction === 'inbound' && ['no-answer', 'busy', 'canceled', 'failed', 'missed'].includes(c.status) && !c.voicemail) t.missed++;
        if (c.voicemail) t.voicemail++;
        if (c.direction === 'inbound' && !c.read_at && (c.voicemail || c.status !== 'completed')) t.unread++;
    }
    for (const m of messages) {
        const t = touch(m.contact_number, { kind: 'text', at: m.at, direction: m.direction, body: m.body });
        if (!t) continue; t.texts++;
        if (m.direction === 'inbound' && !m.read_at) t.unread++;
    }
    const cByNum = new Map(contacts.map(c => [c.number, c]));
    const lBy10 = new Map(leads.filter(l => l.phone_norm).map(l => [last10(l.phone_norm), l]));
    return [...byNum.values()].map(t => {
        const c = cByNum.get(t.number), l = lBy10.get(last10(t.number));
        return { ...t, name: (c && c.name) || (l && (l.full_name || l.company)) || null, kind: c ? c.kind : null, lead_id: l ? l.id : (c && c.lead_id) || null };
    }).sort((a, b) => new Date(b.last.at) - new Date(a.last.at));
}

Object.assign(S, { toE164, prettyNumber, twilioSignature, validTwilio, voiceToken, isOpen, voicemailTwiml, ringTeamTwiml, outgoingTwiml, phoneThreads, PHONE_KINDS: KINDS });

// ------------------------------------------------------------------ plumbing
const form = (req, res, next) => {
    if (req.body && Object.keys(req.body).length) return next();
    let raw = ''; req.setEncoding && req.setEncoding('utf8');
    req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => { req.body = Object.fromEntries(new URLSearchParams(raw)); next(); });
};
/** Webhooks: only Twilio, proven by its signature over this server's public address. */
function hook(handler) {
    return [form, async (req, res) => {
        const c = cfg();
        const url = c.base + req.originalUrl;
        if (!validTwilio(c.token, req.get('X-Twilio-Signature'), url, req.body || {})) { logger.warn('phone_bad_signature', { path: req.path }); return res.status(403).type('text/plain').send('Forbidden'); }
        try { await handler(req, res, c); }
        catch (e) { logger.error('phone_hook_failed', { path: req.path, message: e.message }); if (!res.headersSent) res.type('text/xml').send(twiml(SAY('Sorry, something went wrong. Please try again.'))); }
    }];
}
const xml = (res, body) => res.type('text/xml').send(body);
function fail(res, e) {
    if (e && (e.statusCode === 400 || e.statusCode === 502)) return res.status(e.statusCode).json({ error: e.message });
    logger.error('phone_failed', { message: e && e.message });
    return res.status(500).json({ error: 'Something went wrong on our side. Try again in a moment.' });
}
async function staff(req, res) {
    const ctx = await S.auth(req, res); if (!ctx) return null;
    if (!S.staffOnly(ctx, res)) return null;
    return ctx;
}
async function twilioApi(c, path, { method = 'GET', form: body } = {}) {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.sid}${path}`, {
        method, headers: { Authorization: 'Basic ' + Buffer.from(c.sid + ':' + c.token).toString('base64'), ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
        body: body ? new URLSearchParams(body).toString() : undefined
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.message || `Twilio answered ${r.status}.`); e.statusCode = r.status >= 500 ? 502 : 400; e.code = j.code; throw e; }
    return j;
}
const identityOf = userId => 'u_' + String(userId).replace(/[^a-zA-Z0-9_-]/g, '');
const userOfIdentity = id => /^client:u_/.test(id || '') ? id.slice(9) : /^u_/.test(id || '') ? id.slice(2) : null;

async function leadFor(number) {
    const d = last10(number); if (d.length < 7) return null;
    const { data } = await supabase.from('crm_leads').select('id, full_name, company, phone_norm').like('phone_norm', '%' + d).limit(1);
    return (data || [])[0] || null;
}
async function saveCall(sid, patch) {
    const { data } = await supabase.from('phone_calls').select('id, lead_id, contact_number, user_id, answered_by').eq('sid', sid).maybeSingle();
    if (data) { await supabase.from('phone_calls').update(patch).eq('id', data.id); return { ...data, ...patch }; }
    const lead = patch.contact_number ? await leadFor(patch.contact_number) : null;
    const row = { sid, ...patch, lead_id: lead ? lead.id : null };
    const { data: ins } = await supabase.from('phone_calls').insert(row).select('id, lead_id, contact_number').maybeSingle();
    return ins || row;
}
async function teamIdentities() {
    const { data } = await supabase.from('app_users').select('id, role, is_active').neq('role', 'client').eq('is_active', true).limit(50);
    return (data || []).map(u => identityOf(u.id));
}
async function textOut(c, to, body, userId) {
    const msg = await twilioApi(c, '/Messages.json', { method: 'POST', form: { From: c.number, To: to, Body: body, StatusCallback: c.base + '/api/phone/hook/sms-status' } });
    const lead = await leadFor(to);
    const { data } = await supabase.from('phone_messages').insert({ sid: msg.sid, direction: 'outbound', contact_number: to, body, status: msg.status, user_id: userId || null, lead_id: lead ? lead.id : null, read_at: new Date().toISOString() }).select('*').single();
    if (lead && S.logActivityExternal) S.logActivityExternal(lead.id, 'sms', body, { direction: 'outbound', sid: msg.sid }, userId);
    return data;
}
async function onMissed(c, call) {
    if (!c.sms || !call || !call.contact_number || !/^\+1/.test(call.contact_number)) return;
    const { data: ct } = await supabase.from('phone_contacts').select('opted_out').eq('number', call.contact_number).maybeSingle();
    if (ct && ct.opted_out) return;
    // One automatic text per number per day.
    const { data: recent } = await supabase.from('phone_messages').select('id').eq('contact_number', call.contact_number).eq('auto', true).gte('at', new Date(Date.now() - 864e5).toISOString()).limit(1);
    if ((recent || []).length) return;
    try { const m = await textOut(c, call.contact_number, MISSED_TEXT, null); await supabase.from('phone_messages').update({ auto: true }).eq('id', m.id); }
    catch (e) { logger.warn('phone_missed_text_failed', { message: e.message }); }
}

// ------------------------------------------------------------------ webhooks (Twilio)
// The TwiML App's voice URL and the number's "A call comes in" URL both point here.
app.post('/api/phone/hook/voice', ...hook(async (req, res, c) => {
    const b = req.body;
    if (/^client:/.test(b.From || '')) {                        // a call from the app
        const to = toE164(b.To);
        if (!to) return xml(res, twiml(SAY('That number is not valid.')));
        await saveCall(b.CallSid, { direction: 'outbound', from_number: c.number, to_number: to, contact_number: to, user_id: userOfIdentity(b.From), status: 'ringing', started_at: new Date().toISOString() });
        return xml(res, outgoingTwiml(c.base, { callerId: c.number, to, record: c.record }));
    }
    const from = toE164(b.From) || b.From || 'unknown';
    await saveCall(b.CallSid, { direction: 'inbound', from_number: from, to_number: c.number, contact_number: toE164(b.From), status: 'ringing', started_at: new Date().toISOString() });
    if (!isOpen()) return xml(res, voicemailTwiml(c.base));
    return xml(res, ringTeamTwiml(c.base, await teamIdentities(), { record: c.record, parentSid: b.CallSid, from }));
}));
// After ringing the team (and then the forward number): answered → done; otherwise the next step.
app.post('/api/phone/hook/after', ...hook(async (req, res, c) => {
    const b = req.body, status = b.DialCallStatus;
    if (status === 'completed' || status === 'answered') {
        const call = await saveCall(b.CallSid, { status: 'completed', duration: Number(b.DialCallDuration) || null, ended_at: new Date().toISOString() });
        if (call && call.lead_id && S.logActivityExternal) S.logActivityExternal(call.lead_id, 'call', null, { minutes: Math.round((Number(b.DialCallDuration) || 0) / 6) / 10, outcome: 'Spoke', sid: b.CallSid, direction: 'inbound' }, call.answered_by || null);
        return xml(res, twiml('<Hangup/>'));
    }
    if (c.forward && !req.query.fw && isOpen()) {
        return xml(res, twiml(`<Dial timeout="20" answerOnBridge="true" callerId="${x(c.number)}" action="${c.base}/api/phone/hook/after?fw=1"><Number>${x(c.forward)}</Number></Dial>`));
    }
    const call = await saveCall(b.CallSid, { status: 'no-answer' });
    onMissed(c, call);
    return xml(res, voicemailTwiml(c.base));
}));
// An outgoing call ended.
app.post('/api/phone/hook/done', ...hook(async (req, res) => {
    const b = req.body;
    const call = await saveCall(b.CallSid, { status: b.DialCallStatus === 'answered' ? 'completed' : (b.DialCallStatus || 'completed'), duration: Number(b.DialCallDuration) || 0, ended_at: new Date().toISOString() });
    if (call && call.lead_id && S.logActivityExternal) {
        const mins = Math.round((Number(b.DialCallDuration) || 0) / 6) / 10;
        S.logActivityExternal(call.lead_id, 'call', null, { minutes: mins, outcome: b.DialCallStatus === 'completed' ? 'Spoke' : 'No answer', sid: b.CallSid, direction: 'outbound' }, call.user_id);
    }
    xml(res, twiml('<Hangup/>'));
}));
app.post('/api/phone/hook/status', ...hook(async (req, res) => {
    const b = req.body;     // the outside leg of an outgoing call: its own sid; we file it on the parent
    const sid = b.ParentCallSid || b.CallSid;
    const patch = { status: b.CallStatus === 'in-progress' ? 'in-progress' : b.CallStatus };
    if (b.CallStatus === 'in-progress') patch.answered_at = new Date().toISOString();
    if (b.CallDuration) patch.duration = Number(b.CallDuration);
    if (b.Price) patch.price = Math.abs(Number(b.Price)) || null;
    await saveCall(sid, patch);
    res.status(204).end();
}));
app.post('/api/phone/hook/recording', ...hook(async (req, res) => {
    const b = req.body;
    await saveCall(b.CallSid, { voicemail: true, status: 'voicemail', recording_sid: b.RecordingSid, recording_url: b.RecordingUrl, duration: Number(b.RecordingDuration) || null });
    res.status(204).end();
}));
app.post('/api/phone/hook/transcription', ...hook(async (req, res, c) => {
    const b = req.body;
    const text = b.TranscriptionStatus === 'completed' ? (b.TranscriptionText || '') : '';
    const call = await saveCall(b.CallSid, { transcript: text || null, voicemail: true, status: 'voicemail', recording_url: b.RecordingUrl || undefined });
    res.status(204).end();
    const from = prettyNumber(call.contact_number || b.From);
    S.sendMail && S.sendMail({ to: c.email, subject: `Voicemail from ${from}`,
        text: `New voicemail on ${prettyNumber(c.number)}.\n\nFrom: ${from}\nAt: ${new Date().toLocaleString('en-US', { timeZone: TZ })} (Central)\n\n` +
              `${text ? 'What they said:\n' + text : 'The transcript was not available; listen in the Phone page of the CRM.'}\n\nListen and call back: https://workspace.edgelead.online/#phone` })
        .catch(e => logger.warn('phone_voicemail_mail_failed', { message: e.message }));
    if (call && call.lead_id && S.logActivityExternal) S.logActivityExternal(call.lead_id, 'call', text || 'Voicemail', { voicemail: true, sid: b.CallSid, direction: 'inbound' }, null);
}));
app.post('/api/phone/hook/bye', ...hook(async (req, res) => xml(res, twiml(SAY('Thank you. Goodbye.') + '<Hangup/>'))));
app.post('/api/phone/hook/sms', ...hook(async (req, res) => {
    const b = req.body, from = toE164(b.From) || b.From, body = String(b.Body || '').slice(0, 2000);
    const media = Array.from({ length: Math.min(10, Number(b.NumMedia) || 0) }, (_, i) => ({ url: b['MediaUrl' + i], type: b['MediaContentType' + i] }));
    const lead = await leadFor(from);
    await supabase.from('phone_messages').upsert({ sid: b.MessageSid, direction: 'inbound', contact_number: from, body, media, status: 'received', lead_id: lead ? lead.id : null }, { onConflict: 'sid', ignoreDuplicates: true });
    // Carriers require STOP and HELP to work. Twilio replies to them itself (Advanced Opt-Out); we remember the opt-out.
    const word = body.trim().toUpperCase();
    if (['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'].includes(word)) await supabase.from('phone_contacts').upsert({ number: from, opted_out: true }, { onConflict: 'number' });
    if (['START', 'UNSTOP', 'YES'].includes(word)) await supabase.from('phone_contacts').update({ opted_out: false }).eq('number', from);
    if (lead && S.logActivityExternal) S.logActivityExternal(lead.id, 'sms', body, { direction: 'inbound', sid: b.MessageSid }, null);
    xml(res, twiml(''));
}));
app.post('/api/phone/hook/sms-status', ...hook(async (req, res) => {
    const b = req.body; await supabase.from('phone_messages').update({ status: b.MessageStatus }).eq('sid', b.MessageSid); res.status(204).end();
}));

// ------------------------------------------------------------------ the app
app.get('/api/phone/config', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    const c = cfg(), missing = missingSettings(c);
    res.json({ ready: !missing.length, missing, number: c.number, pretty: prettyNumber(c.number), sms: c.sms, record: c.record, forward: !!c.forward, open: isOpen(),
               hours: 'Mon–Sat, 8 AM–6 PM Central', templates: TEMPLATES, kinds: KINDS, identity: identityOf(ctx.user.id) });
});
app.get('/api/phone/token', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    const c = cfg(); if (missingSettings(c).length) return res.status(503).json({ error: 'The phone is not set up yet.', code: 'phone_not_set_up' });
    res.json({ token: voiceToken({ accountSid: c.sid, apiKey: c.key, apiSecret: c.secret, appSid: c.appSid, identity: identityOf(ctx.user.id) }), identity: identityOf(ctx.user.id), ttl: 3600 });
});
app.get('/api/phone/inbox', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        const [calls, msgs, contacts] = await Promise.all([
            supabase.from('phone_calls').select('contact_number, direction, status, duration, voicemail, started_at, read_at').order('started_at', { ascending: false }).limit(3000),
            supabase.from('phone_messages').select('contact_number, direction, body, at, read_at').order('at', { ascending: false }).limit(5000),
            supabase.from('phone_contacts').select('number, name, kind, lead_id').limit(5000)
        ]);
        if (calls.error) throw calls.error;
        const nums = [...new Set([...(calls.data || []), ...(msgs.data || [])].map(r => last10(r.contact_number)).filter(d => d.length >= 7))];
        const leads = [];
        for (let i = 0; i < nums.length; i += 150) {
            const { data } = await supabase.from('crm_leads').select('id, full_name, company, phone_norm').or(nums.slice(i, i + 150).map(d => `phone_norm.like.%${d}`).join(',')).limit(500);
            leads.push(...(data || []));
        }
        res.json({ threads: phoneThreads(calls.data || [], msgs.data || [], contacts.data || [], leads) });
    } catch (e) { fail(res, e); }
});
app.get('/api/phone/thread/:number', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        const num = toE164(req.params.number); if (!num) return res.status(400).json({ error: 'That number is not valid.' });
        const [calls, msgs, contact, lead] = await Promise.all([
            supabase.from('phone_calls').select('*').eq('contact_number', num).order('started_at', { ascending: true }).limit(500),
            supabase.from('phone_messages').select('*').eq('contact_number', num).order('at', { ascending: true }).limit(2000),
            supabase.from('phone_contacts').select('*').eq('number', num).maybeSingle(),
            leadFor(num)
        ]);
        const now = new Date().toISOString();
        await Promise.all([supabase.from('phone_calls').update({ read_at: now }).eq('contact_number', num).is('read_at', null),
                           supabase.from('phone_messages').update({ read_at: now }).eq('contact_number', num).is('read_at', null)]);
        res.json({ number: num, pretty: prettyNumber(num), calls: calls.data || [], messages: msgs.data || [], contact: contact.data || null, lead });
    } catch (e) { fail(res, e); }
});
app.post('/api/phone/messages', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    try {
        const c = cfg();
        if (!c.sms) return res.status(409).json({ error: 'Texting starts once the number is approved for business texting (A2P 10DLC).', code: 'sms_not_approved' });
        const to = toE164(req.body && req.body.to), body = String((req.body && req.body.body) || '').trim();
        if (!to) return res.status(400).json({ error: 'That number is not valid.' });
        if (!body || body.length > 1500) return res.status(400).json({ error: 'Write a message of up to 1,500 characters.' });
        const { data: ct } = await supabase.from('phone_contacts').select('opted_out').eq('number', to).maybeSingle();
        if (ct && ct.opted_out) return res.status(409).json({ error: 'This person replied STOP. They can only be texted again after they reply START.' });
        res.json({ message: await textOut(c, to, body, ctx.user.id) });
    } catch (e) { fail(res, e); }
});
// The app says who picked up an incoming call (the ring went to everyone).
app.post('/api/phone/answered', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    const sid = String((req.body && req.body.sid) || '');
    if (!/^CA[0-9a-f]{32}$/i.test(sid)) return res.status(400).json({ error: 'Not a call.' });
    await supabase.from('phone_calls').update({ answered_by: ctx.user.id, answered_at: new Date().toISOString(), status: 'in-progress' }).eq('sid', sid);
    res.json({ ok: true });
});
app.patch('/api/phone/calls/:id', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    const note = String((req.body && req.body.note) || '').slice(0, 2000) || null;
    const { data, error } = await supabase.from('phone_calls').update({ note }).eq('id', req.params.id).select('*').maybeSingle();
    if (error) return fail(res, error);
    res.json({ call: data });
});
app.put('/api/phone/contacts/:number', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    const num = toE164(req.params.number); if (!num) return res.status(400).json({ error: 'That number is not valid.' });
    const b = req.body || {}, kind = KINDS.includes(b.kind) ? b.kind : 'other';
    const row = { number: num, name: String(b.name || '').trim().slice(0, 120) || null, kind, company: String(b.company || '').trim().slice(0, 120) || null, notes: String(b.notes || '').slice(0, 2000) || null, work_order: String(b.work_order || '').trim().slice(0, 40) || null, updated_at: new Date().toISOString(), created_by: ctx.user.id };
    const { data, error } = await supabase.from('phone_contacts').upsert(row, { onConflict: 'number' }).select('*').single();
    if (error) return fail(res, error);
    res.json({ contact: data });
});
// Voicemail and recordings stream through here: Twilio media needs the account's credentials.
app.get('/api/phone/recording/:id', async (req, res) => {
    const ctx = await staff(req, res); if (!ctx) return;
    const c = cfg();
    const { data } = await supabase.from('phone_calls').select('recording_url').eq('id', req.params.id).maybeSingle();
    if (!data || !data.recording_url) return res.status(404).json({ error: 'No recording.' });
    const r = await fetch(data.recording_url + '.mp3', { headers: { Authorization: 'Basic ' + Buffer.from(c.sid + ':' + c.token).toString('base64') } });
    if (!r.ok) return res.status(502).json({ error: 'Twilio did not return the recording.' });
    res.set('Content-Type', 'audio/mpeg'); res.set('Cache-Control', 'private, max-age=3600');
    res.send(Buffer.from(await r.arrayBuffer()));
});

// ------------------------------------------------------------------ admin: check the Twilio settings
/** Each Twilio setting tested against Twilio itself, so a wrong one is named. Never returns a secret. */
async function checkTwilio(c, get = fetch) {
    const out = [], add = (name, ok, note) => out.push({ name, ok, note });
    const raw = k => String(process.env[k] || '');
    for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_API_KEY', 'TWILIO_API_SECRET', 'TWILIO_TWIML_APP_SID'])
        if (raw(k) && raw(k) !== raw(k).trim()) add(k, true, 'Had spaces or a line break around it; the server now ignores them, but tidy it on Render.');
    const shape = [['TWILIO_ACCOUNT_SID', c.sid, /^AC[0-9a-f]{32}$/i, 'should start with AC and be 34 characters'],
        ['TWILIO_API_KEY', c.key, /^SK[0-9a-f]{32}$/i, 'should be the key\'s SID: starts with SK, 34 characters'],
        ['TWILIO_API_SECRET', c.secret, /^[0-9a-z]{32}$/i, 'should be the key\'s secret: 32 letters and numbers, shown once when the key was made'],
        ['TWILIO_TWIML_APP_SID', c.appSid, /^AP[0-9a-f]{32}$/i, 'should start with AP and be 34 characters']];
    for (const [k, v, re, why] of shape) if (!v) add(k, false, 'Missing on the server.'); else if (!re.test(v)) add(k, false, `Does not look right: it ${why}.`);
    if (c.secret && c.token && c.secret === c.token) add('TWILIO_API_SECRET', false, 'Is the same as the Auth Token. It must be the API key\'s own secret.');
    const call = async (user, pass, path) => {
        try { const r = await get(`https://api.twilio.com/2010-04-01/Accounts/${c.sid}${path}`, { headers: { Authorization: 'Basic ' + Buffer.from(user + ':' + pass).toString('base64') } });
              const j = await r.json().catch(() => ({})); return { status: r.status, j }; }
        catch (e) { return { status: 0, j: { message: e.message } }; }
    };
    if (!c.sid) return out;
    const acct = c.token ? await call(c.sid, c.token, '.json') : null;
    const acctOk = acct && acct.status === 200;
    if (acct) add('Account SID + Auth Token', acctOk, acctOk ? `Accepted (${acct.j.type === 'Trial' ? 'trial account' : 'account ' + (acct.j.status || 'ok')}).` : `Twilio refused them: ${acct.j.message || acct.status}. Copy both again from the Twilio console home.`);
    if (c.key && c.secret) {
        const k = await call(c.key, c.secret, '.json');
        add('API key + API secret', k.status === 200, k.status === 200 ? 'Accepted: the secret belongs to this key, in this account.'
            : `Twilio refused them (${k.j.code || k.status}): the secret does not belong to this key${acctOk ? '' : ', or the key is from another account'}. Make a new API key and paste its SID and secret together.`);
        if (acctOk && k.status !== 200) {
            const own = await call(c.sid, c.token, `/Keys/${c.key}.json`);
            if (own.status === 404) add('API key', false, 'This key is not in this Twilio account (or it was deleted). Make the key in the same account as the Account SID, region United States (US1).');
        }
    }
    if (acctOk && c.appSid) {
        const a = await call(c.sid, c.token, `/Applications/${c.appSid}.json`);
        const want = c.base + '/api/phone/hook/voice';
        add('TwiML App', a.status === 200 && a.j.voice_url === want, a.status !== 200 ? 'Not found in this account. Check TWILIO_TWIML_APP_SID.'
            : a.j.voice_url === want ? 'Found, and its Voice URL is right.' : `Found, but its Voice request URL should be ${want}`);
    }
    return out;
}
S.checkTwilio = checkTwilio;
app.post('/api/admin/phone/check', async (req, res) => {
    const ctx = await S.requireAdmin(req, res); if (!ctx) return;
    try { res.json({ checks: await checkTwilio(cfg()) }); } catch (e) { fail(res, e); }
});

// ------------------------------------------------------------------ admin: usage
app.get('/api/admin/phone/usage', async (req, res) => {
    const ctx = await S.requireAdmin(req, res); if (!ctx) return;
    const c = cfg(), missing = missingSettings(c);
    const since = new Date(); since.setUTCDate(1); since.setUTCHours(0, 0, 0, 0);
    try {
        const [calls, msgs, users] = await Promise.all([
            supabase.from('phone_calls').select('direction, status, duration, voicemail, user_id, answered_by, price').gte('started_at', since.toISOString()).limit(20000),
            supabase.from('phone_messages').select('direction, user_id, auto').gte('at', since.toISOString()).limit(50000),
            supabase.from('app_users').select('id, full_name, email').neq('role', 'client')
        ]);
        const C = calls.data || [], M = msgs.data || [];
        const mins = list => Math.round(list.reduce((a, r) => a + (Number(r.duration) || 0), 0) / 60);
        const people = (users.data || []).map(u => {
            const out = C.filter(r => r.direction === 'outbound' && r.user_id === u.id);
            return { id: u.id, name: u.full_name || u.email, callsOut: out.length, minutesOut: mins(out), answered: C.filter(r => r.answered_by === u.id).length, texts: M.filter(m => m.direction === 'outbound' && m.user_id === u.id).length };
        });
        const ours = {
            callsIn: C.filter(r => r.direction === 'inbound').length, callsOut: C.filter(r => r.direction === 'outbound').length,
            minutesIn: mins(C.filter(r => r.direction === 'inbound')), minutesOut: mins(C.filter(r => r.direction === 'outbound')),
            missed: C.filter(r => r.direction === 'inbound' && r.status !== 'completed' && !r.voicemail).length, voicemails: C.filter(r => r.voicemail).length,
            textsIn: M.filter(m => m.direction === 'inbound').length, textsOut: M.filter(m => m.direction === 'outbound').length, autoTexts: M.filter(m => m.auto).length
        };
        let twilio = null, balance = null;
        if (!missing.length) {
            try {
                const [u, bal] = await Promise.all([twilioApi(c, '/Usage/Records/ThisMonth.json?PageSize=200'), twilioApi(c, '/Balance.json').catch(() => null)]);
                const pick = k => (u.usage_records || []).find(r => r.category === k) || {};
                twilio = ['totalprice', 'calls', 'calls-client', 'sms', 'phonenumbers', 'recordings', 'transcriptions'].map(k => ({ category: k, usage: Number(pick(k).usage) || 0, unit: pick(k).usage_unit || '', price: Number(pick(k).price) || 0, currency: pick(k).price_unit || 'usd' }));
                balance = bal ? { amount: Number(bal.balance), currency: bal.currency } : null;
            } catch (e) { twilio = { error: e.message }; }
        }
        res.json({ month: since.toISOString().slice(0, 7), ready: !missing.length, missing, number: prettyNumber(c.number), sms: c.sms, forward: c.forward ? prettyNumber(c.forward) : null,
            hooks: { voice: c.base + '/api/phone/hook/voice', sms: c.base + '/api/phone/hook/sms' }, ours, people, twilio, balance });
    } catch (e) { fail(res, e); }
});
