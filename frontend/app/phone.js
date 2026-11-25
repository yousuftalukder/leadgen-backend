/**
 * EdgeLead CRM: Calls and the Dialer (phase 88 built the phone; 91 the call list; 92 split it in two).
 *   Calls   (#calls/home|numbers|settings) the sales calling: Home is the call list beside the lead with everything we
 *           know and how each call went; My numbers is the caller's own figures; Settings holds their reminders and
 *           sound. A call outcome changes the lead everywhere: its stage, its email campaigns, when it comes back.
 *   Dialer  (#dialer, and phone.html: the installable app) the phone system on its own: keypad, the calls, texts and
 *           voicemail on the business number, and the sound settings. Not tied to the lead list.
 * Calls ring wherever the CRM or the Dialer app is open, for the people who may use the phone right now. Who may
 * call and when is the owner's (Admin → Phone); the server checks it on every call. While closed, both pages show
 * everything but every call, text and dial control is off. Reminders for callbacks pop up on every page.
 * The CRM (app/app.js) hands in its helpers with ELPhone.init().
 */
window.ELPhone = (function () {
'use strict';
const SDK = 'https://unpkg.com/@twilio/voice-sdk@2.18.5/dist/twilio.min.js';
let H = null;                       // helpers from the CRM: api, toast, esc, initials, teamName, route, arg, openLead, newLead, token, backend, isAdmin
const P = { cfg: null, device: null, state: 'off', call: null, callInfo: null, incoming: [], threads: null, sel: null, thread: null, ibox: 'all', q: '', timer: 0, poll: 0, installEvt: null, info: true,
    ctab: 'home', dtab: 'phone', dq: null, dqf: { list: '', industry: '', tab: 'today', q: '' }, dsel: null, dlead: null, mob: 'list', after: null, quality: null, preflight: null, level: 0,
    stats: null, srange: '7d', suser: '', prefs: null, rem: { list: [], prefs: null } };
const $ = (s, r = document) => r.querySelector(s);
const KIND = { homeowner: 'Homeowner', property_manager: 'Property manager', warranty: 'Warranty company', technician: 'Technician', vendor: 'Vendor', other: 'Other' };
const KIND_VAR = { homeowner: '--s-web', property_manager: '--s-meta', warranty: '--s-google', technician: '--s-seo', vendor: '--s-ref', other: '--s-other' };
const pretty = n => { const m = /^\+?1?(\d{3})(\d{3})(\d{4})$/.exec(String(n || '').replace(/[^\d+]/g, '')); return m ? `(${m[1]}) ${m[2]}-${m[3]}` : (n || ''); };
const e164 = raw => { const s = String(raw || '').trim(); let d = s.replace(/\D/g, ''); if (!d) return null; if (s.startsWith('+')) return d.length >= 8 ? '+' + d : null;
    if (d.startsWith('00')) d = d.slice(2); else if (d.length === 10) d = '1' + d; else if (d.length === 11 && d.startsWith('01')) d = '88' + d; return d.length >= 8 && d.length <= 15 ? '+' + d : null; };
const dur = s => { s = Math.max(0, Math.round(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const when = at => { const d = new Date(at), now = new Date(), y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return now - d < 6 * 864e5 ? d.toLocaleDateString('en-US', { weekday: 'short' }) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
const dayLabel = at => { const d = new Date(at), now = new Date(); if (d.toDateString() === now.toDateString()) return 'Today';
    const y = new Date(now); y.setDate(now.getDate() - 1); if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' }); };
const shortDate = at => new Date(at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const dateTime = at => new Date(at).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const agoDays = at => { const d = Math.floor((Date.now() - new Date(at)) / 864e5); return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d + ' days ago'; };
const I = {
    phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>', in: '<path d="M16 3 10 9M10 4v5h5"/><path d="M5 4h3l2 4-2 1a10 10 0 0 0 5 5l1-2 4 2v3a2 2 0 0 1-2 2A15 15 0 0 1 3 6a2 2 0 0 1 2-2"/>',
    out: '<path d="M14 9l6-6M15 3h5v5"/><path d="M5 4h3l2 4-2 1a10 10 0 0 0 5 5l1-2 4 2v3a2 2 0 0 1-2 2A15 15 0 0 1 3 6a2 2 0 0 1 2-2"/>', missed: '<path d="m15 3 6 6M21 3l-6 6"/><path d="M5 4h3l2 4-2 1a10 10 0 0 0 5 5l1-2 4 2v3a2 2 0 0 1-2 2A15 15 0 0 1 3 6a2 2 0 0 1 2-2"/>',
    vm: '<circle cx="6.5" cy="12" r="3.5"/><circle cx="17.5" cy="12" r="3.5"/><path d="M6.5 15.5h11"/>', msg: '<path d="M4 5h16v11H9l-5 4z"/>', keypad: '<circle cx="6" cy="5" r="1.2"/><circle cx="12" cy="5" r="1.2"/><circle cx="18" cy="5" r="1.2"/><circle cx="6" cy="11" r="1.2"/><circle cx="12" cy="11" r="1.2"/><circle cx="18" cy="11" r="1.2"/><circle cx="6" cy="17" r="1.2"/><circle cx="12" cy="17" r="1.2"/><circle cx="18" cy="17" r="1.2"/><circle cx="12" cy="22" r="1.2"/>',
    mute: '<path d="M9 9v3a3 3 0 0 0 5 2.2M15 9.3V5a3 3 0 0 0-5.7-1.3"/><path d="M19 11a7 7 0 0 1-1.2 3.9M5 11a7 7 0 0 0 11 5.7M12 18v3M3 3l18 18"/>', mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    end: '<path d="M3 15c5-5 13-5 18 0l-2.5 2.5-3.5-1.5v-3a12 12 0 0 0-6 0v3L5.5 17.5z"/>', send: '<path d="M4 12 20 4l-6 16-3-7z"/>', bolt: '<path d="M13 3 5 14h6l-1 7 8-11h-6z"/>', dots: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>', play: '<path d="M7 4v16l13-8z"/>', back: '<path d="M15 5l-7 7 7 7"/>', del: '<path d="M21 5H9l-6 7 6 7h12z"/><path d="m12 9 6 6M18 9l-6 6"/>', plus: '<path d="M12 5v14M5 12h14"/>', search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    install: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 8v6M9 11l3 3 3-3"/>', window: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>', lead: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M19 8v6M16 11h6"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>', lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', next: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    left: '<path d="M15 6l-6 6 6 6"/>', right: '<path d="m9 6 6 6-6 6"/>', list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>', globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>', pin: '<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>', gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
    speaker: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>', wave: '<path d="M3 12h2M7 8v8M11 5v14M15 8v8M19 10v4M21 12h0"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', note: '<path d="M5 4h10l4 4v12H5z"/><path d="M14 4v5h5M8 13h8M8 17h5"/>',
    home: '<path d="M4 11 12 4l8 7v9h-5v-6h-6v6H4z"/>', chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>', bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>', x: '<path d="M6 6l12 12M18 6 6 18"/>', check: '<path d="m5 12 5 5L20 7"/>', ban: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>', redo: '<path d="M20 8a8 8 0 1 0 1 6"/><path d="M20 3v5h-5"/>'
};
const ic = (k, cls = '') => `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true">${I[k] || ''}</svg>`;
const esc = s => H.esc(s);
const store = { get(k, d) { try { const v = localStorage.getItem('elph-' + k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem('elph-' + k, JSON.stringify(v)); } catch {} } };
const LAY = Object.assign({ l: 300, r: 340, lc: false, rc: false, il: 340 }, store.get('layout', {}));
const AUD = Object.assign({ input: 'default', output: 'default', echo: true, noise: true, gain: true }, store.get('audio', {}));
Object.assign(P.dqf, store.get('dqf', {}));
P.srange = store.get('srange', '7d');
const onCalls = () => H && H.route() === 'calls', onDialer = () => H && H.route() === 'dialer';

// The install prompt can fire before the CRM has signed in: keep it from the start.
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); P.installEvt = e; const b = $('[data-ph="install"]'); if (b) b.hidden = false; });
window.addEventListener('appinstalled', () => { P.installEvt = null; H && H.toast('Installed. Open “EdgeLead Dialer” from your home screen, Start menu or dock.'); });
const standalone = () => matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: window-controls-overlay)').matches || navigator.standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// ------------------------------------------------------------------ time zones (the same rules as the server)
function zoned(tz, at = new Date()) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short', hourCycle: 'h23' }).formatToParts(at).map(x => [x.type, x.value]));
    return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
function zonedToUtc(tz, y, m, d, h, mi) {
    const guess = Date.UTC(y, m - 1, d, h, mi), off = at => { const z = zoned(tz, new Date(at)); return Date.UTC(z.y, z.m - 1, z.d, z.h, z.mi) - Math.floor(at / 60000) * 60000; };
    let t = guess - off(guess); const o2 = off(t); if (guess - o2 !== t) t = guess - o2; return new Date(t);
}
const tzTime = (tz, at = new Date()) => { try { return at.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };
const tzName = tz => { try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'long' }).formatToParts(new Date()).find(p => p.type === 'timeZoneName').value.replace(/ (Standard|Daylight) Time$/, '').replace(/^GMT.*/, tz.split('/').pop().replace(/_/g, ' ')); } catch { return tz; } };
const tzShort = tz => { try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date()).find(p => p.type === 'timeZoneName').value; } catch { return ''; } };
const h12 = s => { const [h, m] = String(s || '0:0').split(':').map(Number); return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`; };
const myTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } })();

// ------------------------------------------------------------------ access: who may call now (the server decides; this mirrors it)
const access = () => (P.cfg && P.cfg.access) || { allowed: true, why: 'open' };
const locked = () => !access().allowed;
const lockAttr = () => locked() ? ` disabled title="${esc(access().text || 'Calling is closed for you right now.')}"` : '';
function lockBanner() {
    const a = access();
    if (a.allowed) return a.why === 'in_hours' && a.text ? `<div class="phlock open">${ic('clock')}<span>${esc(a.text)}</span></div>` : '';
    const head = a.why === 'closed' ? 'Calling is closed right now' : a.why === 'locked' ? 'The phone is locked' : 'You do not have the phone yet';
    return `<div class="phlock">${ic('lock')}<div><b>${head}</b><span>${esc(a.text || '')} You can look at everything; calls, texts and the keypad are off until then.</span></div></div>`;
}
let accessTimer = 0;
async function refreshConfig() {
    try {
        const was = JSON.stringify([access().allowed, access().why]);
        P.cfg = await H.api('/api/phone/config');
        if (was !== JSON.stringify([access().allowed, access().why]) && (onCalls() || onDialer())) rerender();
    } catch {}
    planAccessCheck();
}
function planAccessCheck() {
    clearTimeout(accessTimer);
    const a = access(), at = a.allowed ? a.closesAt : a.opensAt;
    const wait = at ? new Date(at) - Date.now() + 2000 : 0;
    accessTimer = setTimeout(refreshConfig, wait > 0 && wait < 6 * 3600e3 ? wait : 5 * 60e3);
}

// ------------------------------------------------------------------ setup
async function init(helpers) {
    H = helpers;
    try { P.cfg = await H.api('/api/phone/config'); } catch { P.cfg = { ready: false, missing: [] }; }
    remStart();
    if (!P.cfg.ready) return;
    planAccessCheck();
    await inbox().catch(() => {}); badge();
    clearInterval(P.poll); P.poll = setInterval(() => inbox().then(() => { badge(); if (onDialer() && P.dtab === 'phone') { drawList(); if (P.sel) refreshThread(); } }).catch(() => {}), 20000);
    startDevice();
}
function loadSdk() {
    if (window.Twilio && window.Twilio.Device) return Promise.resolve();
    return new Promise((ok, no) => { const s = document.createElement('script'); s.src = SDK; s.onload = ok; s.onerror = () => no(new Error('The calling software could not load.')); document.head.appendChild(s); });
}
/** Twilio's library replaces the code its server sent with a generic 53000 and keeps no copy, so read the
 *  server's own error straight off the signaling socket. Only messages of type "error" are kept. */
function sniffSignaling() {
    if (window.__phSniff) return; window.__phSniff = true;
    const WS = window.WebSocket;
    window.WebSocket = function (url, protocols) {
        const ws = protocols === undefined ? new WS(url) : new WS(url, protocols);
        if (/twilio\.com/i.test(String(url))) ws.addEventListener('message', ev => {
            try { const m = JSON.parse(ev.data); if (m && m.type === 'error' && m.payload && m.payload.error) { P.sigErr = m.payload.error; console.warn('phone: Twilio said', m.payload.error); } } catch {}
        });
        return ws;
    };
    window.WebSocket.prototype = WS.prototype;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(k => { window.WebSocket[k] = WS[k]; });
}
/** The best sound the line can carry: Opus first (wideband, falls back to G.711), the nearest Twilio edge (or the
 *  owner's choice, with the nearest as the fallback), and the browser's echo, noise and level control. */
function deviceOptions() {
    const edge = (P.cfg.voice && P.cfg.voice.edge) || 'roaming';
    return { codecPreferences: ['opus', 'pcmu'], edge: edge === 'roaming' ? 'roaming' : [edge, 'roaming'], maxCallSignalingTimeoutMs: 30000,
        enableImprovedSignalingErrorPrecision: true, closeProtection: 'A call is in progress. Leave anyway?', logLevel: 'error', allowIncomingWhileBusy: false };
}
async function applyAudio() {
    const d = P.device; if (!d || !d.audio) return;
    try { await d.audio.setAudioConstraints({ echoCancellation: AUD.echo, noiseSuppression: AUD.noise, autoGainControl: AUD.gain }); } catch (e) { console.warn('phone audio constraints', e); }
    try { if (AUD.input && AUD.input !== 'default' && d.audio.availableInputDevices.has(AUD.input)) await d.audio.setInputDevice(AUD.input); } catch (e) { console.warn('phone mic', e); }
    try { if (d.audio.isOutputSelectionSupported && AUD.output && d.audio.availableOutputDevices.has(AUD.output)) { await d.audio.speakerDevices.set(AUD.output); await d.audio.ringtoneDevices.set(AUD.output); } } catch (e) { console.warn('phone speaker', e); }
}
async function startDevice() {
    try {
        sniffSignaling();
        await loadSdk();
        const { token } = await H.api('/api/phone/token');
        const d = new Twilio.Device(token, deviceOptions());
        P.device = d;
        d.on('registered', () => setState('ready'));
        d.on('unregistered', () => setState('off'));
        d.on('error', err => { setState(P.state === 'ready' ? 'ready' : 'error', why(err)); if (err && err.code !== 31005) H.toast('Phone: ' + why(err), true); });
        d.on('tokenWillExpire', async () => { try { d.updateToken((await H.api('/api/phone/token')).token); } catch {} });
        d.on('incoming', onIncoming);
        if (d.audio) {
            d.audio.on('deviceChange', () => { if ($('#au-in')) drawSoundDevices(); });
            d.audio.on('inputVolume', v => { P.level = v; const m = $('#mic-meter'); if (m) m.style.setProperty('--v', Math.min(100, Math.round(v * 140)) + '%'); });
        }
        await applyAudio();
        await d.register();
    } catch (e) { setState('error', e || P.sigErr ? why(e) : ''); console.warn('phone', why(e), e); }
}
/** Twilio's own reason: a generic 53000 wraps the code Twilio actually sent (originalError). */
function why(err) {
    const t = P.sigErr;
    if (t && (t.code || t.message)) return `Twilio says: ${t.message || 'error'}${t.code ? ` (${t.code})` : ''}`;
    if (!err) return 'The phone could not connect.';
    const o = err.originalError || {}, code = o.code || err.code, msg = o.message || err.description || err.message || 'Calling error';
    return code ? `${msg} (${code})` : msg;
}
function setState(s, reason) { P.state = s; if (s === 'ready') P.reason = ''; else if (reason) P.reason = reason; const w = $('#ph-why'); if (w) w.remove(); const el = $('#ph-state'); if (el) el.outerHTML = stateChip(); }
const stateChip = () => `<span id="ph-state" class="phstate ${P.state}" title="${esc(P.state === 'ready' ? 'Calls ring here' : 'Not connected: calls go to voicemail' + (P.reason ? '. ' + P.reason : ''))}"><i></i>${P.state === 'ready' ? 'Ready' : P.state === 'error' ? 'Offline' : 'Connecting'}</span>${P.state === 'error' && P.reason ? `<small id="ph-why" class="phwhy">${esc(P.reason)}</small>` : ''}`;
async function inbox() { P.threads = (await H.api('/api/phone/inbox')).threads; return P.threads; }
function badge() { const n = unread(); document.querySelectorAll('[data-phbadge]').forEach(b => { b.textContent = n || ''; b.hidden = !n; }); }
const unread = () => (P.threads || []).reduce((a, t) => a + (t.unread || 0), 0);

// ------------------------------------------------------------------ calls
function call(number, name, leadId) {
    const to = e164(number);
    if (!to) return H.toast('That number is not valid.', true);
    if (!P.cfg || !P.cfg.ready) return H.toast('The phone is not set up yet. The owner finishes it in Admin.', true);
    if (locked()) return H.toast(access().text || 'Calling is closed for you right now.', true);
    if (!P.device || P.state !== 'ready') return H.toast('The phone is still connecting. Try again in a moment.', true);
    if (P.call) return H.toast('Finish the current call first.', true);
    wakeAudio();
    const params = { To: to }; if (leadId) params.LeadId = leadId;
    P.device.connect({ params }).then(c => wire(c, { number: to, name: name || nameOf(to), dir: 'out', leadId: leadId || null })).catch(e => H.toast(e.message, true));
}
function wire(c, info) {
    P.call = c; P.callInfo = { ...info, status: info.dir === 'out' ? 'Calling…' : 'Connecting…', start: 0, muted: false, pad: false, sid: null };
    P.quality = null; if (info.leadId) P.after = null;
    bar(); drawCallPane();
    c.on('accept', () => { P.callInfo.start = Date.now(); P.callInfo.status = 'live'; P.callInfo.sid = (c.parameters && c.parameters.CallSid) || null; bar(); drawCallPane(); clearInterval(P.timer); P.timer = setInterval(tick, 1000); });
    c.on('ringing', () => { P.callInfo.status = 'Ringing…'; P.callInfo.sid = (c.parameters && c.parameters.CallSid) || P.callInfo.sid; bar(); drawCallPane(); });
    const end = whyText => {
        clearInterval(P.timer);
        const i = P.callInfo || {}, n = i.number;
        if (i.leadId && i.dir === 'out') P.after = { leadId: i.leadId, name: i.name, sid: i.sid || (c.parameters && c.parameters.CallSid) || null, secs: i.start ? Math.round((Date.now() - i.start) / 1000) : 0, picked: i.start ? '' : 'none', outcome: '', note: (i.note || ''), callbackAt: '', askedEmail: false, connected: !!i.start };
        P.call = null; P.callInfo = null; P.quality = null; bar(); drawCallPane(); afterCard();
        if (whyText) H.toast(whyText);
        setTimeout(() => inbox().then(() => { badge(); if (onDialer() && P.dtab === 'phone') { drawList(); if (P.sel === n) refreshThread(); } }), 2500);
    };
    c.on('disconnect', () => end('Call ended'));
    c.on('cancel', () => end());
    c.on('reject', () => end());
    c.on('error', e => end(why(e)));
    // Twilio's own call-quality warnings: say on screen what is wrong with the sound.
    const WARN = { 'constant-audio-input-level': 'Your microphone sends no sound. Check the mic and that this site may use it.',
        'constant-audio-output-level': 'No sound is arriving from the other side.', 'ice-connectivity-lost': 'The voice connection dropped. Check the network or VPN.',
        'high-packet-loss': 'Poor connection: sound is being lost.', 'high-rtt': 'Slow connection: sound is delayed.', 'low-mos': 'Poor call quality.', 'high-jitter': 'Unsteady connection.' };
    c.on('warning', name => { if (!P.callInfo) return; P.callInfo.warn = WARN[name] || ''; if (P.callInfo.warn) { H.toast(P.callInfo.warn, true); console.warn('phone warning', name); } });
    c.on('warning-cleared', name => { if (P.callInfo && P.callInfo.warn === WARN[name]) P.callInfo.warn = ''; });
    // Live quality, about once a second: MOS 1–4.5 (4+ is as good as a landline).
    c.on('sample', s => { if (!s) return; P.quality = { mos: s.mos, rtt: s.rtt, jitter: s.jitter, loss: s.packetsLostFraction }; const q = $('#cq'); if (q) q.outerHTML = qualityHtml(); const qb = $('#cbq'); if (qb) qb.outerHTML = qualityHtml('cbq'); });
}
function qualityHtml(id = 'cq') {
    const q = P.quality; if (!q || q.mos == null) return `<span id="${id}" class="cq"><i></i><i></i><i></i><i></i><small>Measuring</small></span>`;
    const n = q.mos >= 4.1 ? 4 : q.mos >= 3.7 ? 3 : q.mos >= 3.2 ? 2 : 1, label = ['', 'Poor', 'Fair', 'Good', 'Excellent'][n];
    return `<span id="${id}" class="cq q${n}" title="Sound quality ${q.mos.toFixed(1)} of 4.5 · delay ${Math.round(q.rtt || 0)} ms · jitter ${Math.round(q.jitter || 0)} ms · lost ${Math.round((q.loss || 0) * 100)}%">${'<i></i>'.repeat(4)}<small>${label}</small></span>`;
}
/** Browsers keep sound off until the page is clicked; turn Twilio's audio on with the first click. */
function wakeAudio() { try { const ac = window.Twilio && Twilio.Device && Twilio.Device.audioContext; if (ac && ac.state === 'suspended') ac.resume(); } catch {} }
['pointerdown', 'keydown'].forEach(t => document.addEventListener(t, wakeAudio, { capture: true, passive: true }));
function tick() { const s = P.callInfo && P.callInfo.start ? dur((Date.now() - P.callInfo.start) / 1000) : ''; ['#cb-t', '#cp-t'].forEach(id => { const t = $(id); if (t) t.textContent = s; }); }
/** The floating bar while in a call. On Calls → Home the call pane shows the same controls, so the bar steps aside. */
function bar() {
    let el = $('#callbar');
    const pane = $('#dl-call');
    const inPane = !!(P.callInfo && P.callInfo.leadId && pane && pane.getClientRects().length && P.dsel === P.callInfo.leadId && onCalls() && P.ctab === 'home');
    if (!P.callInfo || inPane) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'callbar'; el.className = 'callbar'; document.body.appendChild(el); }
    const i = P.callInfo, live = i.status === 'live';
    el.innerHTML = `<span class="cav">${esc(H.initials(i.name || ''))}</span><div class="ct"><b>${esc(i.name || pretty(i.number))}</b><span>${i.name ? esc(pretty(i.number)) + ' · ' : ''}${live ? `<span id="cb-t" class="num">${dur((Date.now() - i.start) / 1000)}</span> ${qualityHtml('cbq')}` : esc(i.status)}</span></div>
      <button type="button" class="cbtn ${i.muted ? 'on' : ''}" data-cb="mute" aria-pressed="${i.muted}" title="${i.muted ? 'Unmute' : 'Mute'}">${ic(i.muted ? 'mute' : 'mic')}<small>${i.muted ? 'Unmute' : 'Mute'}</small></button>
      <button type="button" class="cbtn ${i.pad ? 'on' : ''}" data-cb="pad" title="Keypad">${ic('keypad')}<small>Keypad</small></button>
      <button type="button" class="cbtn end" data-cb="end" title="Hang up">${ic('end')}<small>End</small></button>
      ${i.pad ? `<div class="cbpad">${keys('cbkey')}</div>` : ''}`;
}
const KEYS = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'], ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', '+'], ['#', '']];
const keys = (attr, off) => KEYS.map(([k, l]) => `<button type="button" class="key" data-${attr}="${k}"${off ? ' disabled' : ''}><b>${k}</b><small>${l}</small></button>`).join('');
function onIncoming(c) {
    const from = c.customParameters.get('caller') || c.parameters.From, pcs = c.customParameters.get('pcs');
    const card = { c, from: e164(from) || from, pcs, id: Math.random().toString(36).slice(2) };
    P.incoming.push(card); ring();
    const gone = () => { P.incoming = P.incoming.filter(x => x !== card); ring(); };
    c.on('cancel', gone); c.on('reject', gone); c.on('disconnect', gone);
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) { try { new Notification('Incoming call', { body: nameOf(card.from) || pretty(card.from), tag: 'el-call' }); } catch {} }
}
function ring() {
    let el = $('#ringing');
    if (!P.incoming.length) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'ringing'; el.className = 'ringing'; el.setAttribute('role', 'alertdialog'); el.setAttribute('aria-label', 'Incoming call'); document.body.appendChild(el); }
    el.innerHTML = P.incoming.map(r => `<div class="ring"><span class="cav pulse">${esc(H.initials(nameOf(r.from) || '#'))}</span><div class="ct"><small>Incoming call · ${esc(P.cfg.pretty)}</small><b>${esc(nameOf(r.from) || pretty(r.from))}</b>${nameOf(r.from) ? `<span>${esc(pretty(r.from))}</span>` : ''}</div>
      <button type="button" class="rbtn no" data-ring="decline" data-rid="${r.id}" title="Decline">${ic('end')}</button><button type="button" class="rbtn yes" data-ring="accept" data-rid="${r.id}" title="Answer">${ic('phone')}</button></div>`).join('');
}
function nameOf(num) { const t = (P.threads || []).find(x => x.number === num); return t ? t.name : null; }

// ------------------------------------------------------------------ the two pages
/** kind: 'calls' (arg: home | numbers | settings, and home/<lead id>) or 'dialer'. */
function view(kind, arg) {
    if (!P.cfg) return `<div class="boot">Loading…</div>`;
    if (kind === 'calls') {
        const [t, id] = String(arg || '').split('/');
        P.ctab = ['home', 'numbers', 'settings'].includes(t) ? t : 'home';
        if (id && /^[0-9a-f-]{36}$/i.test(id) && id !== P.dsel) { P.dsel = id; P.mob = 'lead'; }
        return callsView();
    }
    if (!P.cfg.ready) return setupView();
    return dialerView();
}
function clocks() {
    const lead = P.dlead && P.dlead.lead && P.dsel === P.dlead.lead.id ? P.dlead : null, tz = lead && lead.tz;
    return `<span title="${esc(myTz)}"><small>You</small><b>${tzTime(myTz)}</b></span>${tz ? `<span title="${esc(tz)}"><small>Them · ${esc(tzName(tz))}</small><b>${tzTime(tz)}</b></span>` : ''}`;
}
setInterval(() => { const c = $('#phx-clocks'); if (c) c.innerHTML = clocks(); }, 30000);
function setupView() {
    const m = P.cfg.missing || [];
    return `<div class="head"><div><h1>Dialer</h1><p class="sub">Calls, texts and voicemail on (469) 819-4097, right here in the CRM.</p></div></div>
      <section class="card setup"><div class="card-h"><h2>Almost ready</h2><span>Owner's steps</span></div>
        <div class="steps2">${[['Twilio account', 'Your Account SID and Auth Token, from the Twilio console home page.', ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN']],
            ['An API key', 'Console → Account → API keys → Create (Standard). Copy the SID and the secret.', ['TWILIO_API_KEY', 'TWILIO_API_SECRET']],
            ['A TwiML App', 'Voice → TwiML Apps → Create. Voice URL: the address in Admin → Phone. Copy its SID.', ['TWILIO_TWIML_APP_SID']]]
            .map(([t, d, ks], i) => `<div class="stp ${ks.every(k => !m.includes(k)) ? 'done' : ''}"><span class="n">${i + 1}</span><div><b>${t}</b><p>${d}</p><code>${ks.join(' · ')}</code></div></div>`).join('')}
          <div class="stp"><span class="n">4</span><div><b>Put them on the server</b><p>Render → the backend service → Environment. Add each value, then save. The server restarts and the phone switches on here.</p></div></div></div></section>`;
}
function callsView() {
    const tabs = [['home', 'Home', 'home'], ['numbers', 'My numbers', 'chart'], ['settings', 'Settings', 'gear']];
    return `<div class="phx calls" data-tab="${P.ctab}">
      <header class="phx-h"><nav class="phx-tabs" role="tablist">${tabs.map(([k, l, i]) => `<a role="tab" aria-selected="${P.ctab === k}" class="${P.ctab === k ? 'on' : ''}" href="#calls/${k}">${ic(i)}<span>${l}</span></a>`).join('')}</nav>
        <div class="phx-clocks" id="phx-clocks">${clocks()}</div><span class="sp"></span>${P.cfg.ready ? stateChip() : ''}</header>
      ${P.ctab === 'home' ? lockBanner() : ''}
      <div class="phx-b">${P.ctab === 'numbers' ? numbersView() : P.ctab === 'settings' ? callsSettingsView() : homeView()}</div></div>`;
}
function dialerView() {
    return `<div class="phx dialer" data-tab="${P.dtab}">
      <header class="phx-h"><nav class="phx-tabs" role="tablist">${[['phone', 'Phone', 'keypad'], ['sound', 'Sound and app', 'speaker']].map(([k, l, i]) => `<button type="button" role="tab" aria-selected="${P.dtab === k}" class="${P.dtab === k ? 'on' : ''}" data-dtab2="${k}">${ic(i)}<span>${l}</span>${k === 'phone' ? `<em class="ct hot" data-phbadge ${unread() ? '' : 'hidden'}>${unread() || ''}</em>` : ''}</button>`).join('')}</nav>
        <div class="phx-clocks"><span><small>Business line</small><b>${esc(P.cfg.pretty)}</b></span></div><span class="sp"></span>${stateChip()}
        <button type="button" class="btn sm" data-ph="install" ${standalone() ? 'hidden' : ''}>${ic('install')}<span>Install app</span></button></header>
      ${lockBanner()}
      <div class="phx-b">${P.dtab === 'sound' ? `<div class="phset">${soundCards(true)}</div>` : inboxView()}</div></div>`;
}

// ------------------------------------------------------------------ Calls → Home: who to call, the lead, the call
const STATUS_LABEL = { not_called: 'Not called', tried: 'Tried', spoke: 'Spoke', callback: 'Call back', in_play: 'In play', closed: 'Closed' };
const WARM = { hot: ['Hot', '--bad'], warm: ['Warm', '--gold'], lukewarm: ['Lukewarm', '--warn'], cold: ['Cold', '--dim'] };
const lastQ = () => P.dq && P.dq.rows || [];
async function loadQueue() {
    const f = P.dqf, qs = new URLSearchParams({ tab: f.tab, list: f.list, industry: f.industry, q: f.q });
    P.dq = await H.api('/api/crm/dialer?' + qs.toString());
    try { P.dq.bizTz = P.dq.bizTz || (window.CRM && CRM.st.meta && CRM.st.meta.timezone); } catch {}
    if (!P.dsel || (!lastQ().some(r => r.id === P.dsel) && !P.after && !P.callInfo && P.mob !== 'lead')) P.dsel = lastQ()[0] ? lastQ()[0].id : null;
    return P.dq;
}
function homeView() {
    if (!P.dq) { loadQueue().then(() => { if (onCalls() && P.ctab === 'home') rerender(); }).catch(e => { const b = $('.phx-b'); if (b) b.innerHTML = `<div class="empty err">The call list could not load: ${esc(e.message)}</div>`; }); return '<div class="boot">Loading the call list…</div>'; }
    const d = P.dq, c = d.counts || {}, f = P.dqf;
    const tabs = [['today', 'Today'], ['not_called', 'Not called'], ['tried', 'Tried'], ['spoke', 'Spoke'], ['callback', 'Call back'], ['in_play', 'In play'], ['closed', 'Closed'], ['all', 'All']];
    return `<div class="dl ${LAY.lc ? 'lc' : ''} ${LAY.rc ? 'rc' : ''} ${P.mob === 'lead' ? 'm-lead' : ''}" style="--lw:${LAY.l}px;--rw:${LAY.r}px">
      ${d.p91 ? '' : `<div class="banner">${ic('info')}<div><b>One step left:</b> run <span class="mono">sql/schema-phase91.sql</span> in Supabase. Until then every lead shows as not called, and how each call went is kept on the lead's history only.</div></div>`}
      <div class="dl-top"><label class="ph-search dl-q">${ic('search')}<input id="dl-q" type="search" placeholder="Find a lead: business, name, phone (or part of it), email or city" value="${esc(f.q)}" aria-label="Find a lead"></label>
        <select id="dl-list" aria-label="Call list"><option value="">Every call list</option>${(d.lists || []).map(l => `<option value="${esc(l.id)}" ${f.list === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>
        <select id="dl-ind" aria-label="Trade"><option value="">Every trade</option>${(d.industries || []).map(i => `<option ${f.industry === i ? 'selected' : ''}>${esc(i)}</option>`).join('')}</select></div>
      <div class="dl-tabs" role="tablist">${tabs.map(([k, l]) => `<button type="button" role="tab" aria-selected="${f.tab === k}" class="${f.tab === k ? 'on' : ''}" data-dtab="${k}">${l} <b>${(c[k] || 0).toLocaleString('en-US')}</b></button>`).join('')}</div>
      <div class="dl-panes">
        <aside class="dl-list" aria-label="Leads to call"><div class="dl-today">Today: <b>${d.today ? d.today.calls : 0}</b> calls · <b>${d.today ? d.today.conversations : 0}</b> conversation${d.today && d.today.conversations === 1 ? '' : 's'}</div>
          <div class="dl-lh"><b>${f.tab === 'today' ? 'Next to call' : STATUS_LABEL[f.tab] || 'Every lead'}</b><span>${(d.total || 0).toLocaleString('en-US')}</span><button type="button" class="iconbtn sm" data-fold="l" title="Fold the list away" aria-label="Fold the list away">${ic('left')}</button></div>
          <div class="dl-rows" id="dl-rows">${rowsHtml()}</div><div class="split" data-split="l" title="Drag to resize · double-click to fold" role="separator" aria-orientation="vertical"></div></aside>
        <section class="dl-lead" id="dl-lead">${leadHtml()}</section>
        <aside class="dl-call ${P.callInfo || P.after ? '' : 'compact'}" id="dl-call" aria-label="Call">${callPaneHtml()}<div class="split" data-split="r" title="Drag to resize · double-click to fold" role="separator" aria-orientation="vertical"></div></aside>
        <button type="button" class="dl-unfold l" data-fold="l" title="Show the list">${ic('right')}<span>List</span></button>
        <button type="button" class="dl-unfold r" data-fold="r" title="Show the call panel">${ic('left')}<span>Call</span></button>
      </div></div>`;
}
function rowsHtml() {
    const rows = lastQ();
    if (!rows.length) return `<div class="empty sm">${P.dqf.tab === 'today' ? 'Nobody is due a call right now. Try another list or trade, or the Not called tab.' : 'No lead here.'}</div>`;
    return rows.map(r => { const w = WARM[r.warmth] || WARM.cold;
        const sub = r.task ? esc(r.task) : r.revisit ? 'Revisit · ' + esc(r.last_call_outcome || 'closed') : r.tab === 'not_called' ? (r.score != null ? `Score ${r.score}/100` : 'Not called') : `${STATUS_LABEL[r.tab]}${r.calls_count ? ' · ' + r.calls_count + '×' : ''}`;
        return `<button type="button" class="dl-row ${P.dsel === r.id ? 'on' : ''} ${r.task ? 'task' : ''}" data-dsel="${r.id}"><b>${esc(r.company || r.full_name || pretty(r.phone))}</b>
          <span><i class="wdot" style="--c:var(${w[1]})"></i><em style="color:var(${w[1]})">${w[0]}</em>${r.industry ? ' · ' + esc(r.industry) : ''} · ${sub}</span>
          <small class="${r.openNow ? 'open' : 'shut'}">${r.openNow ? 'Open' : 'Closed'} · ${tzTime(r.tz)}${r.callback_at && r.tab !== 'not_called' && !r.revisit ? ' · ' + (new Date(r.callback_at) <= new Date() ? 'due' : 'due ' + shortDate(r.callback_at)) : ''}${r.campaign ? ` · ${ic('mail', 'sm')}in a campaign` : ''}</small></button>`; }).join('');
}
async function openLead(id, quiet) {
    P.dsel = id; if (!quiet) P.mob = 'lead';
    document.querySelectorAll('.dl-row').forEach(b => b.classList.toggle('on', b.dataset.dsel === id));
    const dl = $('.dl'); if (dl) dl.classList.toggle('m-lead', P.mob === 'lead'); bar();
    if (!P.dlead || P.dlead.lead.id !== id) { const m = $('#dl-lead'); if (m) m.innerHTML = '<div class="boot">Loading…</div>'; }
    try {
        const d = await H.api('/api/crm/leads/' + id); if (P.dsel !== id) return;
        const row = lastQ().find(r => r.id === id);
        d.tz = (row && row.tz) || guessTz(d.lead); d.row = row || null;
        P.dlead = d;
    } catch (e) { const m = $('#dl-lead'); if (m) m.innerHTML = `<div class="empty err">${esc(e.message)}</div>`; return; }
    drawLead(); drawCallPane(); const c = $('#phx-clocks'); if (c) c.innerHTML = clocks();
}
/** When the lead is not in the list (opened from elsewhere): its own time zone, else the business's. */
function guessTz(l) { return (l && l.timezone) || (P.dq && P.dq.bizTz) || 'America/Chicago'; }
function drawLead() { const m = $('#dl-lead'); if (m) m.innerHTML = leadHtml(); }
function drawRows() { const r = $('#dl-rows'); if (r) r.innerHTML = rowsHtml(); }
const srcLabel = k => { try { const s = CRM.srcOf(k); return s.path || s.label; } catch { return k; } };
const tagged = (l, t) => (l.tags || []).includes(t);
function leadHtml() {
    const d = P.dlead;
    if (!P.dsel) return `<div class="empty">${ic('list')}<b>Pick a lead on the left.</b> Its contact, how warm it is, every call and email, and what we noticed show here.</div>`;
    if (!d || d.lead.id !== P.dsel) return '<div class="boot">Loading…</div>';
    const l = d.lead, row = d.row || {}, tz = d.tz, items = (d.history && d.history.items) || [];
    const calls = items.filter(i => i.kind === 'call' && !(i.meta && i.meta.direction === 'inbound')), emails = items.filter(i => i.kind === 'email_out' || i.kind === 'campaign_email');
    const name = l.company || l.full_name, contact = l.company && l.full_name && l.full_name !== '-' && l.full_name !== l.company ? l.full_name : '';
    const lh = (P.dq && P.dq.rules && P.dq.rules.localHours) || null;
    const open = row.openNow != null ? row.openNow : null;
    const w = WARM[row.warmth || (l.last_email_at ? 'lukewarm' : 'cold')] || WARM.cold;
    const tab = row.tab || l.call_status || 'not_called';
    const dnc = tagged(l, 'Do not call'), wrong = tagged(l, 'Wrong number');
    const score = l.score != null ? `<b>${l.score}</b> of 100 <span class="dim">${l.score >= 70 ? 'strong' : l.score >= 40 ? 'fair' : 'weak'}</span>` : '<span class="dim">Not scored</span>';
    const maps = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent([name, l.city].filter(Boolean).join(', '));
    const fact = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
    const ins = Array.isArray(l.insights) ? l.insights : [];
    const camp = l.campaign || row.campaign;
    const stage = (window.CRM && CRM.st.meta && (CRM.st.meta.stages.find(s => s.key === l.stage) || {}).label) || l.stage;
    const tryAgain = l.callback_at ? (new Date(l.callback_at) <= new Date() ? `<b>Due now</b> <span class="dim">since ${esc(dateTime(l.callback_at))}</span>` : `<b>${esc(dateTime(l.callback_at))}</b>${tab === 'closed' ? ' <span class="dim">(revisit)</span>' : ''}`)
        : dnc ? '<span class="bad">Never: do not call</span>' : wrong ? '<span class="dim">When it has a new number</span>' : tab === 'closed' ? '<span class="dim">No: closed</span>' : '<b>Now</b>';
    return `<div class="lp-h"><button type="button" class="iconbtn back" data-dback aria-label="Back to the list">${ic('back')}</button><div class="lp-t"><h2>${esc(name)}</h2>${l.industry ? `<span class="pill">${esc(l.industry)}</span>` : ''}${dnc ? '<span class="flag bad">Do not call</span>' : ''}${wrong ? '<span class="flag warn">Wrong number</span>' : ''}</div>
        <span class="sp"></span>${tab === 'closed' && !dnc && !wrong && !l.client_id && l.stage !== 'won' ? `<button type="button" class="btn sm" data-dreopen title="Put it back in the call list, due now">${ic('redo')}Back to the call list</button>` : ''}<button type="button" class="btn sm" data-dnext>Next lead ${ic('next')}</button></div>
      <div class="lp-grid"><div class="lp-who">
        <p class="ask">${contact ? `Ask for <b>${esc(contact)}</b>` : 'Ask for the owner'} <button type="button" class="linkbtn" data-dfull>Edit contact</button></p>
        ${l.phone ? `<div class="lp-num ${wrong ? 'wrong' : ''}"><b class="num">${esc(pretty(l.phone))}</b><button type="button" class="btn sm" data-copy="${esc(l.phone)}">${ic('copy')}Copy</button></div>${wrong ? '<p class="dim small">This number was wrong. Put the right one in the full record and the lead comes back to the list.</p>' : ''}` : '<p class="dim">No phone number.</p>'}
        <p class="lp-links">${l.email ? `<span data-copy="${esc(l.email)}" class="cp" title="Copy">${ic('mail')}${esc(l.email)}</span>` : ''}${l.website ? `<a href="${esc(/^https?:/i.test(l.website) ? l.website : 'https://' + l.website)}" target="_blank" rel="noopener">${ic('globe')}${esc(String(l.website).replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, ''))}</a>` : ''}
          <a href="${esc(maps)}" target="_blank" rel="noopener">${ic('pin')}Google Maps listing</a></p>
        ${l.city ? `<p class="dim lp-addr">${esc(l.city)}</p>` : ''}
        <p><button type="button" class="btn sm ghost" data-dfull>${ic('lead')}Open the full record</button></p></div>
      <dl class="lp-facts">
        ${fact('Status', `<span><b>${STATUS_LABEL[tab] || 'Not called'}</b>${l.last_call_outcome ? ' · ' + esc(l.last_call_outcome) : ''}</span>`)}
        ${fact('Sales stage', `<span><b>${esc(stage || 'New')}</b>${l.in_pipeline ? ' · in the pipeline' : ''}${l.stage === 'lost' && l.lost_reason ? ' · ' + esc(l.lost_reason) : ''}</span>`)}
        ${fact('Their time', `<b>${tzTime(tz)} ${esc(tzName(tz))}</b> ${open == null ? '' : open ? '<span class="ok">open</span>' : '<span class="bad">closed</span>'}${lh && lh.on ? ` <span class="dim">(${h12(lh.from)} to ${h12(lh.to)})</span>` : ''}`)}
        ${fact('Warmth', `<b>${w[0]}</b>${l.last_email_at ? ` <span class="dim">Emailed ${agoDays(l.last_email_at)}</span>` : ''}`)}
        ${fact('Email campaign', camp ? `<b>${esc(camp.name)}</b>${camp.next_at ? ` <span class="dim">next email ${esc(shortDate(camp.next_at))}</span>` : ''}` : '<span class="dim">None</span>')}
        ${fact('Prospect score', score)}
        ${fact('Trade', esc(l.industry || '—'))}
        ${fact('Category', esc(srcLabel(l.source)))}
        ${fact('Called', calls.length ? `<b>${calls.length} time${calls.length === 1 ? '' : 's'}</b>${calls.slice(0, 3).map(i => `<small>${shortDate(i.at)} · ${esc((i.meta && i.meta.outcome) || 'Call')}${i.actor ? ' (' + esc(H.teamName(i.actor)) + ')' : ''}</small>`).join('')}` : '<span class="dim">Never</span>')}
        ${fact('Emailed', emails.length ? `<b>${emails.length} email${emails.length === 1 ? '' : 's'}</b>${emails.slice(0, 3).map(i => `<small>${shortDate(i.at)} · ${esc((i.meta && (i.meta.subject || i.meta.campaignName)) || 'Email')}${i.meta && i.meta.opened ? ' · opened' : ''}</small>`).join('')}` : '<span class="dim">Never</span>')}
        ${fact('Try again', tryAgain)}
      </dl></div>
      <section class="lp-sec"><h3>What we noticed</h3>${ins.length ? `<ul class="lp-ins">${ins.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="dim">Nothing yet. Add what you learn about the business, one line each; the SEO tools will add theirs here.</p>'}
        ${P.dq && P.dq.p91 ? `<form class="lp-add" id="lp-ins"><input id="lp-ins-in" placeholder="Add a line, e.g. Their site has no reviews" maxlength="300" aria-label="Add what we noticed"><button class="btn sm" type="submit">Add</button></form>` : ''}</section>
      <section class="lp-sec"><h3>History <small>${items.length}</small></h3><div class="lp-hist">${items.slice(0, 14).map(histLine).join('') || '<p class="dim">Nothing yet.</p>'}</div>${items.length > 14 ? '<button type="button" class="linkbtn" data-dfull>See all of it</button>' : ''}</section>`;
}
function histLine(i) {
    const m = i.meta || {}, k = i.kind;
    const t = k === 'call' ? (m.voicemail ? 'Voicemail' : (m.direction === 'inbound' ? 'Call in' : 'Call out') + (m.minutes ? ' · ' + m.minutes + ' min' : '') + (m.outcome ? ' · ' + m.outcome : ''))
        : k === 'email_out' || k === 'campaign_email' ? 'Email' + (m.subject ? ': ' + m.subject : m.campaignName ? ' · ' + m.campaignName : '') : k === 'email_in' ? 'Reply received' : k === 'sms' ? (m.direction === 'inbound' ? 'Text received' : 'Text sent')
        : k === 'stage' ? 'Moved to ' + (m.to || '') : k === 'note' ? 'Note' : k === 'meeting' ? 'Meeting' : k === 'system' ? (i.body || 'Update') : k;
    const icon = k === 'call' ? 'phone' : /email/.test(k) ? 'mail' : k === 'sms' ? 'msg' : 'note';
    return `<div class="lh">${ic(icon, 'sm')}<div><b>${esc(t)}</b>${i.body && k !== 'system' ? `<p>${esc(String(i.body).slice(0, 220))}</p>` : ''}</div><time>${shortDate(i.at)}${i.actor ? ' · ' + esc(H.teamName(i.actor)) : ''}</time></div>`;
}
function callPaneHtml() {
    const d = P.dlead, l = d && d.lead && d.lead.id === P.dsel ? d.lead : null, i = P.callInfo;
    if (i && (!l || i.leadId === l.id)) {
        const live = i.status === 'live';
        return `<div class="cp live"><span class="lbl">${live ? 'On the call' : esc(i.status)}</span><b class="cp-name">${esc(i.name || pretty(i.number))}</b><span class="num cp-n">${esc(pretty(i.number))}</span>
          <div class="cp-t"><span id="cp-t" class="num">${live ? dur((Date.now() - i.start) / 1000) : '0:00'}</span>${live ? qualityHtml() : ''}</div>
          ${i.warn ? `<p class="cp-warn">${esc(i.warn)}</p>` : ''}
          <div class="cp-ctl"><button type="button" class="cbtn2 ${i.muted ? 'on' : ''}" data-cb="mute">${ic(i.muted ? 'mute' : 'mic')}<small>${i.muted ? 'Unmute' : 'Mute'}</small></button>
            <button type="button" class="cbtn2 ${i.pad ? 'on' : ''}" data-cb="pad">${ic('keypad')}<small>Keypad</small></button><button type="button" class="cbtn2 end" data-cb="end">${ic('end')}<small>End</small></button></div>
          ${i.pad ? `<div class="pad sm">${keys('cbkey')}</div>` : ''}
          <label class="cp-notes"><span>Notes while you talk</span><textarea id="cp-note" rows="4" placeholder="What they said, names, numbers">${esc(i.note || '')}</textarea></label></div>`;
    }
    if (P.after && l && P.after.leadId === l.id) return afterHtml(P.after);
    if (!l) return `<div class="cp"><div class="empty sm">Pick a lead to call.</div></div>`;
    const row = (d && d.row) || {}, dnc = tagged(l, 'Do not call'), wrong = tagged(l, 'Wrong number');
    const blocked = !l.phone || dnc || wrong;
    return `<div class="cp"><span class="lbl">Call</span><b class="cp-name">${esc(l.company || l.full_name)}</b>
        ${l.phone ? `<span class="num cp-n">${esc(pretty(l.phone))}</span>` : '<span class="dim">No phone number on this lead.</span>'}
        ${dnc ? `<p class="cp-warn">${ic('ban', 'sm')}They asked not to be called. Calls and texts to this number are refused.</p>` : wrong ? `<p class="cp-warn soft">${ic('info', 'sm')}This number was wrong. Fix it in the full record first.</p>` : ''}
        ${row.openNow === false && !blocked ? `<p class="cp-warn soft">${ic('clock', 'sm')}Their business is closed now (${tzTime(d.tz)} there).${row.opensAt ? ' Opens ' + esc(new Date(row.opensAt).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })) + ' your time.' : ''}</p>` : ''}
        <button type="button" class="callbig" data-dcall ${blocked ? 'disabled' : ''}${lockAttr()}>${ic('phone')}<span>Call ${esc(pretty(l.phone || ''))}</span></button>
        <small class="dim">They see ${esc(P.cfg.pretty || 'the business number')}. ${P.cfg.record ? 'Calls are recorded.' : ''}</small>
        <button type="button" class="linkbtn" data-dlog${locked() || dnc ? ' disabled' : ''}>Log a call made another way</button></div>`;
}
/** How did the call go: who picked up, then the outcome, and what that will do. Used on Calls → Home and in a card elsewhere. */
const EFFECT = { no_answer: r => `Back in the list in ${r.retry.no_answer} h.`, voicemail: r => `Back in the list in ${r.retry.voicemail} h.`, busy: r => `Back in the list in ${r.retry.busy} h.`, gatekeeper: r => `Back in the list in ${r.retry.gatekeeper} h.`,
    spoke: r => `Back in the list in ${Math.round(r.retry.spoke / 24 * 10) / 10} days.`, callback: () => 'A call task and reminders at the time you pick.',
    interested: () => 'Into the pipeline (Contacted). Its email campaign stops: sales has it.', meeting: () => 'Into the pipeline at Meeting. Its email campaign stops.',
    not_interested: r => `Marked Lost. Email stops. Back in the call list in ${r.revisit.notInterested} days.`, not_fit: r => `Marked Lost. Email stops. Back in the call list in ${r.revisit.notInterested} days.`,
    wrong_number: () => 'The number is marked wrong. It comes back when someone puts in a new one.', dnc: () => 'Never called, texted or emailed again.' };
const RULES0 = { retry: { no_answer: 24, voicemail: 48, busy: 2, gatekeeper: 24, spoke: 72 }, revisit: { notInterested: 90, outOfTries: 30 } };
function afterHtml(a) {
    const outs = (P.dq && P.dq.outcomes) || [], picked = (P.dq && P.dq.picked) || { owner: 'The owner', front_desk: 'Front desk', someone: 'Someone else', none: 'No one' };
    const fit = outs.filter(o => !a.picked || o.who.includes(a.picked));
    const quick = (P.dlead && P.dlead.tz) ? quickTimes(P.dlead.tz) : [];
    const rules = { ...RULES0, ...((P.dq && P.dq.rules) || {}) }; rules.retry = rules.retry || RULES0.retry; rules.revisit = rules.revisit || RULES0.revisit;
    const eff = a.outcome && EFFECT[a.outcome] ? EFFECT[a.outcome](rules) : '';
    return `<div class="cp after"><span class="lbl">${a.secs ? 'Call ended · <span class="num">' + dur(a.secs) + '</span>' : a.connected ? 'Call ended' : 'Log a call'}</span><b class="cp-name">${esc(a.name || '')}</b>
      <h4>Who picked up?</h4><div class="ochips">${Object.entries(picked).map(([k, t]) => `<button type="button" class="ochip ${a.picked === k ? 'on' : ''}" data-apick="${k}">${esc(t)}</button>`).join('')}</div>
      <h4>How did the call go?</h4>${a.picked ? `<div class="ochips">${fit.map(o => `<button type="button" class="ochip o-${o.status} ${a.outcome === o.key ? 'on' : ''}" data-aout="${o.key}">${esc(o.label)}</button>`).join('')}</div>` : '<p class="dim small">Say who picked up first, then how it went.</p>'}
      ${eff ? `<p class="effect">${ic('info', 'sm')}${esc(eff)}</p>` : ''}
      ${a.outcome === 'callback' ? `<div class="cbk"><label for="a-cb">Call them back</label><input id="a-cb" type="datetime-local" value="${esc(a.callbackAt)}">${quick.length ? `<div class="ochips sm">${quick.map(([t, at]) => `<button type="button" class="ochip" data-acbq="${at}">${esc(t)}</button>`).join('')}</div>` : ''}</div>` : ''}
      <label class="check"><input type="checkbox" id="a-em" ${a.askedEmail ? 'checked' : ''}> They asked for an email</label>
      <textarea id="a-note" rows="3" placeholder="Notes: what was said, who to ask for, best time">${esc(a.note || '')}</textarea>
      <div class="cp-go"><button type="button" class="btn pri" data-asave="next"${lockAttr()}>Save and next lead ${ic('next')}</button><button type="button" class="btn" data-asave="stay"${lockAttr()}>Save</button></div>
      <button type="button" class="linkbtn" data-adiscard>That was not a call: discard it</button></div>`;
}
/** Callback shortcuts, at their time: in 2 hours, tomorrow 10 AM, Monday 10 AM. Shown in the browser's time. */
function quickTimes(tz) {
    const now = new Date(), z = zoned(tz, now), at = (addDays, h) => { const d = new Date(Date.UTC(z.y, z.m - 1, z.d + addDays)); return zonedToUtc(tz, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), h, 0); };
    const local = d => new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
    const toMon = ((8 - z.dow) % 7) || 7;
    return [['In 2 hours', local(new Date(now.getTime() + 2 * 3600e3))], ['Tomorrow 10 AM their time', local(at(1, 10))], ['Monday 10 AM their time', local(at(toMon, 10))]];
}
function drawCallPane() {
    const el = $('#dl-call'); if (!el) return;
    const split = el.querySelector('.split'); el.innerHTML = callPaneHtml(); if (split) el.appendChild(split);
    el.classList.toggle('compact', !(P.callInfo || (P.after && P.dsel === P.after.leadId)));
    bar();
}
/** A call to a lead ended somewhere other than Calls → Home: ask how it went in a card. */
function afterCard() {
    let el = $('#aftercard');
    const show = P.after && !(onCalls() && P.ctab === 'home' && P.dsel === P.after.leadId);
    if (!show) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'aftercard'; el.className = 'aftercard'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'How did the call go'); document.body.appendChild(el); }
    if (!P.dq && !P.loadingOutcomes) { P.loadingOutcomes = true; loadQueue().then(() => { P.loadingOutcomes = false; if ($('#aftercard')) afterCard(); }).catch(() => { P.loadingOutcomes = false; }); }
    el.innerHTML = afterHtml(P.after);
}
function redrawAfter() { if ($('#aftercard')) afterCard(); else drawCallPane(); }
async function saveAfter(next) {
    const a = P.after; if (!a) return;
    a.note = ($('#a-note') || {}).value || a.note; a.askedEmail = !!($('#a-em') || {}).checked;
    if (a.outcome === 'callback') a.callbackAt = ($('#a-cb') || {}).value || a.callbackAt;
    if (!a.picked) return H.toast('Say who picked up.', true);
    if (!a.outcome) return H.toast('Pick how the call went.', true);
    if (a.outcome === 'callback' && !a.callbackAt) return H.toast('Pick when to call them back.', true);
    document.querySelectorAll('[data-asave]').forEach(b => { b.disabled = true; });
    try {
        const r = await H.api('/api/crm/dialer/outcome', { method: 'POST', body: { lead_id: a.leadId, sid: a.sid, picked: a.picked, outcome: a.outcome, note: a.note, askedEmail: a.askedEmail, seconds: a.secs, callbackAt: a.callbackAt ? new Date(a.callbackAt).toISOString() : null } });
        H.toast(['Saved on ' + (a.name || 'the lead'), r.stage === 'lost' ? 'marked Lost' : r.stage ? 'moved to ' + r.stage : '', r.campaignsStopped ? 'email campaign stopped' : '', r.outOfTries ? 'out of tries: it rests' : ''].filter(Boolean).join(' · '));
        const id = a.leadId; P.after = null; afterCard(); remLoad();
        try { window.CRM && CRM.leads(true); } catch {}
        if (!onCalls() || P.ctab !== 'home') { P.dq = null; return; }
        const order = lastQ().map(r2 => r2.id), at = order.indexOf(id);
        await loadQueue().catch(() => {});
        const rows = lastQ().map(r2 => r2.id);
        const nextId = next ? (rows.find((r2, n) => n >= at && r2 !== id) || rows.find(r2 => r2 !== id) || null) : id;
        P.dsel = nextId; drawRows(); counts();
        if (nextId) openLead(nextId, true); else { P.dlead = null; drawLead(); drawCallPane(); }
    } catch (e) { H.toast(e.message, true); document.querySelectorAll('[data-asave]').forEach(b => { b.disabled = locked(); }); }
}
function counts() {
    const c = (P.dq && P.dq.counts) || {};
    document.querySelectorAll('[data-dtab]').forEach(b => { const n = b.querySelector('b'); if (n) n.textContent = (c[b.dataset.dtab] || 0).toLocaleString('en-US'); });
    const t = $('.dl-today'); if (t && P.dq.today) t.innerHTML = `Today: <b>${P.dq.today.calls}</b> calls · <b>${P.dq.today.conversations}</b> conversation${P.dq.today.conversations === 1 ? '' : 's'}`;
    const lh = $('.dl-lh span'); if (lh) lh.textContent = (P.dq.total || 0).toLocaleString('en-US');
}
function nextLead() {
    const rows = lastQ(), at = rows.findIndex(r => r.id === P.dsel), n = rows[at + 1] || rows[0];
    if (n && n.id !== P.dsel) openLead(n.id); else H.toast('That was the last lead in this list.');
}

// ------------------------------------------------------------------ resizing and folding the side panes
function setLay(patch) { Object.assign(LAY, patch); store.set('layout', LAY); const dl = $('.dl'); if (dl) { dl.style.setProperty('--lw', LAY.l + 'px'); dl.style.setProperty('--rw', LAY.r + 'px'); dl.classList.toggle('lc', LAY.lc); dl.classList.toggle('rc', LAY.rc); } const ph = $('.ph'); if (ph) ph.style.setProperty('--il', LAY.il + 'px'); bar(); }
let drag = null;
document.addEventListener('pointerdown', e => {
    const s = e.target.closest && e.target.closest('.split'); if (!s) return;
    e.preventDefault(); s.setPointerCapture(e.pointerId);
    drag = { k: s.dataset.split, x: e.clientX, w: LAY[s.dataset.split], el: s }; document.body.classList.add('resizing');
});
document.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, w = drag.k === 'r' ? drag.w - dx : drag.w + dx;
    const lim = drag.k === 'r' ? [260, 520] : [220, 560], v = Math.round(Math.max(lim[0], Math.min(lim[1], w)));
    LAY[drag.k] = v; const dl = $('.dl'), ph = $('.ph');
    if (dl && drag.k !== 'il') dl.style.setProperty(drag.k === 'l' ? '--lw' : '--rw', v + 'px'); if (ph && drag.k === 'il') ph.style.setProperty('--il', v + 'px');
});
document.addEventListener('pointerup', () => { if (!drag) return; document.body.classList.remove('resizing'); store.set('layout', LAY); drag = null; });
document.addEventListener('dblclick', e => { const s = e.target.closest && e.target.closest('.split'); if (s && s.dataset.split !== 'il') setLay({ [s.dataset.split + 'c']: true }); });
document.addEventListener('keydown', e => {
    const s = e.target.closest && e.target.closest('.split'); if (!s || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const k = s.dataset.split, d = (e.key === 'ArrowRight' ? 20 : -20) * (k === 'r' ? -1 : 1); setLay({ [k]: Math.max(220, Math.min(560, LAY[k] + d)) }); e.preventDefault();
});

// ------------------------------------------------------------------ Calls → My numbers
const RANGES = [['today', 'Today'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days']];
async function loadStats() { const qs = new URLSearchParams({ range: P.srange, ...(P.suser ? { user: P.suser } : {}) }); P.stats = await H.api('/api/crm/calls/stats?' + qs.toString()); return P.stats; }
const hm = secs => { const h = Math.floor(secs / 3600), m = Math.round((secs % 3600) / 60); return h ? `${h} h ${m} min` : `${m} min`; };
function numbersView() {
    if (!P.stats) { loadStats().then(() => { if (onCalls() && P.ctab === 'numbers') rerender(); }).catch(e => { const b = $('.phx-b'); if (b) b.innerHTML = `<div class="empty err">Your numbers could not load: ${esc(e.message)}</div>`; }); return '<div class="boot">Counting…</div>'; }
    const r = P.stats, s = r.stats, from = new Date(r.from), to = new Date(r.to);
    const card = (big, label, sub, cls = '') => `<div class="ncard ${cls}"><b>${big}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ''}</div>`;
    const PK = [['owner', 'The owner', '--ok'], ['front_desk', 'Front desk', '--acc'], ['someone', 'Someone else', '--gold'], ['none', 'No one', '--dim'], ['unlogged', 'No outcome logged', '--line2']];
    const max = Math.max(1, ...s.byDay.map(d => PK.reduce((a, [k]) => a + (d[k] || 0), 0)));
    const best = s.best ? `In this period owners picked up most often around <b>${h12(s.best.hour + ':00')}</b> their time: ${Math.round(s.best.rate * 100)}% of ${s.best.calls} calls. Hours with fewer than 8 calls are not compared.` : 'Once there are 8 or more calls in an hour, the hour owners pick up most shows here.';
    return `<div class="nums">
      <div class="nbar"><div class="period" role="group" aria-label="Period">${RANGES.map(([k, l]) => `<button type="button" data-srange="${k}" class="${P.srange === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        <span class="dim">${esc(from.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))} to ${esc(to.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }))} · ${esc(tzName(r.tz))} time</span><span class="sp"></span>
        ${r.people && r.people.length ? `<select id="suser" aria-label="Whose numbers"><option value="">Mine</option><option value="all" ${P.suser === 'all' ? 'selected' : ''}>The whole team</option>${r.people.map(p => `<option value="${p.id}" ${P.suser === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>` : ''}</div>
      <div class="ngrid">
        ${card(s.calls.toLocaleString('en-US'), 'Calls', `${s.leadsCalled.toLocaleString('en-US')} leads called`)}
        ${card(s.perHour, 'Calls per hour', `over ${s.hoursWithCalls} hour${s.hoursWithCalls === 1 ? '' : 's'} with a call in them`, 'hi')}
        ${card(s.answeredPct + '%', 'Answered', `${s.answered} picked up by someone, of ${s.outcomes} with an outcome`)}
        ${card(s.owner, 'Reached the owner', `${s.ownerPct}% of calls · ${s.frontDesk} front desk`)}
        ${card(hm(s.seconds), 'Time on calls', s.timedCalls ? `${s.avgSeconds} s a call, on ${s.timedCalls} timed` : 'No timed calls')}
        ${card(s.callbacksSet, 'Call-backs set', s.callbacksDue ? `${s.callbacksMade} of ${s.callbacksDue} due were made` : 'None were due')}
        ${card(s.interested, 'Interested', 'into the pipeline', 'hi')}
        ${card(s.meetings, 'Meetings booked', `${s.meetingsPct}% of owners reached`, 'hi')}
        ${card(s.emailsAsked, 'Emails asked for', 'each made an email task')}
        ${card(s.notInterested, 'Not interested', 'marked Lost; back in 90 days')}
        ${card(s.wrongNumbers + s.dnc, 'Wrong numbers and do not call', `${s.wrongNumbers} wrong · ${s.dnc} do not call`)}
        ${card(s.noTimer, 'Logged without dialing', 'calls logged without calling from here', s.noTimer ? 'warn' : '')}
      </div>
      <div class="ninsight">${ic('clock')}<span>${best}</span></div>
      <section class="card nchart"><div class="card-h"><div><h2>Calls by day</h2><span>Each bar is the day's calls, split by who picked up.</span></div></div>
        <div class="legend">${PK.map(([k, l, c]) => `<span><i style="--c:var(${c})"></i>${l}</span>`).join('')}</div>
        <div class="nm-bars" role="img" aria-label="Calls by day">${s.byDay.map(d => { const tot = PK.reduce((a, [k]) => a + (d[k] || 0), 0);
            return `<div class="nm-col" title="${esc(new Date(d.day + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }))}: ${tot} call${tot === 1 ? '' : 's'}${PK.filter(([k]) => d[k]).map(([k, l]) => ' · ' + l + ' ' + d[k]).join('')}"><div class="nm-stack" style="height:${Math.round(tot / max * 100)}%">${PK.filter(([k]) => d[k]).map(([k, , c]) => `<i style="flex:${d[k]};--c:var(${c})"></i>`).join('')}</div>${s.byDay.length <= 31 ? `<small>${new Date(d.day + 'T12:00:00').getDate()}</small>` : ''}</div>`; }).join('')}</div></section>
      ${s.byOutcome.length ? `<section class="card"><div class="card-h"><h2>How the calls went</h2><span>${s.outcomes} with an outcome</span></div><div class="obars">${s.byOutcome.map(o => `<div><span>${esc(o.label)}</span><i style="--v:${Math.round(o.n / s.outcomes * 100)}%"></i><b>${o.n}</b></div>`).join('')}</div></section>` : ''}
    </div>`;
}

// ------------------------------------------------------------------ Calls → Settings: the caller's reminders and sound
const STEP_LABEL = { 1440: '1 day before', 120: '2 hours before', 60: '1 hour before', 30: '30 minutes before', 15: '15 minutes before', 10: '10 minutes before', 5: '5 minutes before', 0: 'When it starts' };
async function loadPrefs() { P.prefs = await H.api('/api/crm/caller-prefs'); return P.prefs; }
function callsSettingsView() {
    if (!P.prefs) { loadPrefs().then(() => { if (onCalls() && P.ctab === 'settings') rerender(); }).catch(e => { const b = $('.phx-b'); if (b) b.innerHTML = `<div class="empty err">Settings could not load: ${esc(e.message)}</div>`; }); return '<div class="boot">Loading…</div>'; }
    const p = P.prefs, eff = p.effective, own = !!p.own.reminders, a = access();
    const offTxt = p.office.reminders.length ? p.office.reminders.map(x => STEP_LABEL[x].replace(' before', '')).join(', ') + ' before' : 'none';
    return `<div class="phset">
      <section class="card wide"><div class="card-h"><h2>${ic('bell')}Reminders</h2><span>${own ? 'Your own times. <button type="button" class="linkbtn" data-prefoffice>Use the office’s times again</button>' : `You are on the office's standard times (${esc(offTxt)}). Change them here for yourself.`}</span></div><div class="acb">
        <p class="note">Before a call-back or a to-do that has a time, a reminder pops up on whichever page of the CRM or the Dialer you are on, with the number to call.</p>
        <div class="remsteps">${p.steps.map(x => `<label class="${eff.reminders.includes(x) ? 'on' : ''}"><input type="checkbox" data-remstep value="${x}" ${eff.reminders.includes(x) ? 'checked' : ''}>${STEP_LABEL[x]}</label>`).join('')}</div>
        <div class="inline"><label for="pf-snooze">Snooze brings a reminder back after</label><select id="pf-snooze">${[1, 5, 10, 15, 30].map(m => `<option value="${m}" ${eff.snooze === m ? 'selected' : ''}>${m} minute${m === 1 ? '' : 's'}</option>`).join('')}</select></div>
        <div class="inline"><label class="check"><input type="checkbox" id="pf-tone" ${eff.tone ? 'checked' : ''}> Play a tone with each reminder</label><button type="button" class="btn sm" data-ph="tone">Hear it</button></div></div></section>
      <section class="card"><div class="card-h"><h2>${ic('info')}Desktop alerts</h2><span>When the CRM is open but you are in another tab or program</span></div><div class="acb">
        <label class="check"><input type="checkbox" id="pf-desk" ${eff.desktop ? 'checked' : ''}> Show me a desktop alert when a reminder is due</label>
        <p class="note">${!('Notification' in window) ? 'This browser cannot show desktop alerts.' : Notification.permission === 'granted' ? 'This browser allows them.' : Notification.permission === 'denied' ? 'This browser blocks them. Allow notifications for this site in the browser settings.' : 'This browser has not been asked yet. Press the button and choose Allow.'}</p>
        <button type="button" class="btn" data-ph="testalert">Allow this browser and send a test alert</button></div></section>
      <section class="card"><div class="card-h"><h2>${ic('lock')}Your calling hours</h2><span>Set by the owner in Admin → Phone</span></div><div class="acb">
        <p style="margin:0"><b>${a.allowed ? 'You can call now.' : 'You cannot call now.'}</b> ${esc(a.text || (a.why === 'open' ? 'Everyone on the team can call at any time.' : ''))}</p>
        ${a.hours ? `<p class="dim" style="margin:6px 0 0">Hours: ${a.hours.days.map(x => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][x]).join(', ')} · ${h12(a.hours.from)} to ${h12(a.hours.to)} ${esc(tzShort(a.tz))}</p>` : ''}</div></section>
      ${soundCards(false)}</div>`;
}
async function savePrefs(patch) {
    const cur = P.prefs.own, body = { reminders: cur.reminders, snooze: cur.snooze, tone: P.prefs.effective.tone, desktop: P.prefs.effective.desktop, ...patch };
    try { P.prefs = await H.api('/api/crm/caller-prefs', { method: 'PUT', body }); P.rem.prefs = P.prefs.effective; H.toast('Saved for you'); rerender(); } catch (e) { H.toast(e.message, true); }
}

// ------------------------------------------------------------------ sound: shared by Calls → Settings and Dialer → Sound and app
function soundCards(withApp) {
    const d = P.device, outOk = d && d.audio && d.audio.isOutputSelectionSupported, pf = P.preflight;
    return `<section class="card"><div class="card-h"><h2>${ic('mic')}Microphone</h2><span>On this computer. A headset with a microphone sounds best.</span></div><div class="acb">
        <div class="field"><label for="au-in">Use</label><select id="au-in"><option value="default">The computer's default</option></select></div>
        <div class="meter"><i id="mic-meter" style="--v:0%"></i></div><p class="note">Speak: the bar should move. If it stays still, pick another microphone or allow this site to use it.</p></div></section>
      <section class="card"><div class="card-h"><h2>${ic('speaker')}Speaker</h2><span>${outOk ? 'Where you hear the call and the ring' : 'This browser plays sound on the default speaker'}</span></div><div class="acb">
        ${outOk ? '<div class="field"><label for="au-out">Use</label><select id="au-out"><option value="default">The computer\'s default</option></select></div>' : ''}
        <button type="button" class="btn" data-ph="testspk">${ic('speaker')}Play a test sound</button></div></section>
      <section class="card"><div class="card-h"><h2>${ic('wave')}Sound clean-up</h2><span>On is best for almost everyone</span></div><div class="acb">
        <label class="check"><input type="checkbox" data-aud="echo" ${AUD.echo ? 'checked' : ''}> Cancel echo <small class="dim">stops them hearing themselves from your speakers</small></label>
        <label class="check"><input type="checkbox" data-aud="noise" ${AUD.noise ? 'checked' : ''}> Remove background noise <small class="dim">fans, traffic, the office</small></label>
        <label class="check"><input type="checkbox" data-aud="gain" ${AUD.gain ? 'checked' : ''}> Even out my volume <small class="dim">turn off with a studio microphone</small></label></div></section>
      <section class="card"><div class="card-h"><h2>${ic('bolt')}Call-quality test</h2><span>About 20 seconds; nobody is called</span></div><div class="acb">
        <p class="note">Checks the line from this computer to Twilio the way a real call does: sound quality, delay and steadiness, and which Twilio data centre it uses.</p>
        ${pf ? (pf.error ? `<p class="bad">${esc(pf.error)}</p>` : pf.running ? '<p>Testing… keep this page open.</p>' : `<div class="pfres q-${esc(pf.level)}"><b>${esc(pf.levelText)}</b><span>Sound ${pf.mos ? pf.mos.toFixed(1) + ' of 4.5' : '—'} · delay ${pf.rtt != null ? Math.round(pf.rtt) + ' ms' : '—'} · jitter ${pf.jitter != null ? Math.round(pf.jitter) + ' ms' : '—'}${pf.edge ? ' · via ' + esc(pf.edge) : ''}</span><small>${esc(pf.advice)}</small></div>`) : ''}
        <button type="button" class="btn" data-ph="preflight" ${pf && pf.running ? 'disabled' : ''}>Run the test</button></div></section>
      ${withApp ? `<section class="card"><div class="card-h"><h2>${ic('info')}Incoming calls</h2><span>When a call comes in and this is in the background</span></div><div class="acb"><button type="button" class="btn" data-ph="notify">Notify me of calls</button></div></section>
      <section class="card"><div class="card-h"><h2>${ic('install')}The app</h2><span>${standalone() ? 'You are in the installed app' : 'On this computer or phone'}</span></div><div class="acb">
        <p class="note">Install the Dialer as an app: its own window and icon, and calls ring even when the CRM is closed. The installed app asks for your workspace password each time it opens.</p>
        ${standalone() ? '' : `<button type="button" class="btn pri" data-ph="install">${ic('install')}Install the Dialer</button>`}</div></section>` : ''}`;
}
async function drawSoundDevices() {
    const d = P.device; if (!d || !d.audio) return;
    try { if (!d.audio.availableInputDevices.size || [...d.audio.availableInputDevices.values()].every(x => !x.label)) { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach(t => t.stop()); } } catch {}
    const fill = (sel, map, cur) => { if (!sel) return; sel.innerHTML = [...map.values()].map(x => `<option value="${esc(x.deviceId)}" ${x.deviceId === cur ? 'selected' : ''}>${esc(x.label || (x.deviceId === 'default' ? 'The computer\'s default' : 'A device'))}</option>`).join(''); };
    fill($('#au-in'), d.audio.availableInputDevices, AUD.input); if (d.audio.isOutputSelectionSupported) fill($('#au-out'), d.audio.availableOutputDevices, AUD.output);
    try { await d.audio.setInputDevice(AUD.input && d.audio.availableInputDevices.has(AUD.input) ? AUD.input : 'default'); P.meterOn = true; } catch {}
}
/** The level meter holds the microphone open; let it go when the sound settings close (a call opens it again). */
function releaseMeter() { if (!P.meterOn || P.call) return; P.meterOn = false; try { if (AUD.input === 'default' && P.device && P.device.audio.unsetInputDevice) P.device.audio.unsetInputDevice(); } catch {} }
async function preflight() {
    if (!window.Twilio || !Twilio.Device || !Twilio.Device.runPreflight) { P.preflight = { error: 'This browser cannot run the test. Use Chrome or Edge.' }; return rerender(); }
    P.preflight = { running: true }; rerender();
    try {
        const { token } = await H.api('/api/phone/token');
        const o = deviceOptions(), t = Twilio.Device.runPreflight(token, { codecPreferences: o.codecPreferences, edge: o.edge });
        t.on('completed', r => {
            const st = r.stats || {}, lv = r.callQuality || r.qualityLevel || '';
            const advice = { excellent: 'Calls will sound like a landline.', great: 'Calls will sound clear.', good: 'Calls will sound fine.', fair: 'Calls may break up now and then. A cable instead of Wi-Fi, or closing video calls and downloads, will help.', degraded: 'Calls will break up. Use a cable or a better network, and turn off any VPN.' }[lv] || '';
            P.preflight = { level: lv, levelText: lv ? lv[0].toUpperCase() + lv.slice(1) : 'Done', mos: st.mos && st.mos.average, rtt: st.rtt && st.rtt.average, jitter: st.jitter && st.jitter.average, edge: r.selectedEdge || r.edge, advice };
            if ($('[data-ph="preflight"]')) rerender();
        });
        t.on('failed', err => { P.preflight = { error: 'The test could not finish: ' + why(err) }; if ($('[data-ph="preflight"]')) rerender(); });
    } catch (e) { P.preflight = { error: e.message }; rerender(); }
}
async function install() {
    if (P.installEvt) { P.installEvt.prompt(); const r = await P.installEvt.userChoice; if (r.outcome === 'accepted') H.toast('Installed. Open “EdgeLead Dialer” from your home screen, Start menu or dock.'); P.installEvt = null; return; }
    if (!window.EL_PHONE_ONLY) { window.open('/phone.html?install=1', 'elphone', 'width=1240,height=820'); return; }
    if (standalone()) return H.toast('This is the installed app.');
    const steps = isIos() ? ['Open this page in <b>Safari</b>.', 'Tap <b>Share</b> (the square with the arrow).', 'Tap <b>Add to Home Screen</b>, then <b>Add</b>.']
        : /android/i.test(navigator.userAgent) ? ['Open this page in <b>Chrome</b>.', 'Tap <b>⋮</b> at the top right.', 'Tap <b>Install app</b> (or <b>Add to Home screen</b>).']
        : ['In <b>Chrome</b> or <b>Edge</b>: the install icon at the right of the address bar.', 'Or <b>⋮</b> → <b>Cast, save and share</b> → <b>Install page as app</b>.'];
    const lay = document.getElementById('layer');
    lay.innerHTML = `<div class="scrim" data-close></div><div class="modal" role="dialog" aria-modal="true" aria-label="Install the Dialer"><div class="mh"><h2>Install the Dialer</h2></div><div class="mb"><ol class="isteps">${steps.map(s => `<li>${s}</li>`).join('')}</ol>
      <p class="note" style="margin:0">The installed app asks for your workspace password each time it opens.</p></div><div class="mf"><button class="btn pri" type="button" data-close>Done</button></div></div>`;
}

// ------------------------------------------------------------------ reminders: callbacks and timed to-dos, on every page
// The server lists this caller's open tasks from two hours ago to a day ahead. Each pops up at the caller's chosen times
// before it (else the office's), with a tone and a desktop alert when the page is in the background; snooze brings it back.
let remPoll = 0, remTick = 0;
function remStart() { remLoad(); clearInterval(remPoll); remPoll = setInterval(remLoad, 60000); clearInterval(remTick); remTick = setInterval(remCheck, 15000); }
async function remLoad() { try { const r = await H.api('/api/crm/reminders'); P.rem.list = r.reminders || []; P.rem.prefs = r.prefs; remCheck(); } catch {} }
const fired = () => store.get('rem-fired', {}), snoozed = () => store.get('rem-snooze', {});
function remCheck() {
    const pr = P.rem.prefs; if (!pr) return;
    const now = Date.now(), F = fired(), Z = snoozed(), show = [];
    for (const t of P.rem.list) {
        const due = new Date(t.due_at).getTime();
        if (now > due + 15 * 60e3) continue;
        if (Z[t.id]) { if (now >= Z[t.id]) { delete Z[t.id]; show.push({ t, offset: Math.max(0, Math.round((due - now) / 60e3)), snoozed: true }); } continue; }
        const passed = (pr.reminders || []).filter(m => now >= due - m * 60e3).sort((a, b) => a - b);
        if (!passed.length) continue;
        const k = t.id + ':' + passed[0];
        if (F[k]) continue;
        passed.forEach(m => { F[t.id + ':' + m] = now; });
        show.push({ t, offset: Math.max(0, Math.round((due - now) / 60e3)) });
    }
    for (const id of Object.keys(F)) if (now - F[id] > 3 * 864e5) delete F[id];
    store.set('rem-fired', F); store.set('rem-snooze', Z);
    if (!show.length) return;
    P.rem.open = [...(P.rem.open || []).filter(x => !show.some(s => s.t.id === x.t.id)), ...show];
    remDraw();
    if (pr.tone) tone();
    if (pr.desktop && document.hidden && 'Notification' in window && Notification.permission === 'granted') show.forEach(s => { try { new Notification(remTitle(s), { body: remBody(s.t), tag: 'el-rem-' + s.t.id }); } catch {} });
}
const remTitle = s => (s.offset > 0 ? `In ${s.offset >= 60 ? Math.round(s.offset / 60) + ' h' : s.offset + ' min'}: ` : 'Now: ') + s.t.title;
const remBody = t => [t.lead && (t.lead.company || t.lead.full_name), t.lead && t.lead.phone && pretty(t.lead.phone), new Date(t.due_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })].filter(Boolean).join(' · ');
function remDraw() {
    let el = $('#reminders');
    const list = P.rem.open || [];
    if (!list.length) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'reminders'; el.className = 'reminders'; el.setAttribute('role', 'alert'); document.body.appendChild(el); }
    el.innerHTML = list.map(s => { const t = s.t, l = t.lead || {}, callable = t.kind === 'call' && l.phone && !(l.tags || []).includes('Do not call');
        return `<div class="remc"><span class="ri">${ic(t.kind === 'call' ? 'phone' : 'bell')}</span><div class="rt"><small>${s.snoozed ? 'Snoozed reminder · ' : ''}${s.offset > 0 ? 'In ' + (s.offset >= 60 ? Math.round(s.offset / 60) + ' h' : s.offset + ' min') : 'Due now'}</small><b>${esc(t.title)}</b><span>${esc(remBody(t))}</span></div>
          <button type="button" class="iconbtn sm" data-remx="${t.id}" aria-label="Dismiss">${ic('x')}</button>
          <div class="ra">${callable ? `<button type="button" class="btn sm pri" data-remcall="${t.id}"${lockAttr()}>${ic('phone')}Call now</button>` : ''}${t.lead_id ? `<button type="button" class="btn sm" data-remopen="${t.lead_id}">Open</button>` : ''}
            <button type="button" class="btn sm" data-remsnooze="${t.id}">Snooze ${(P.rem.prefs && P.rem.prefs.snooze) || 5} min</button><button type="button" class="btn sm ghost" data-remdone="${t.id}">${ic('check')}Done</button></div></div>`; }).join('');
}
const remClose = id => { P.rem.open = (P.rem.open || []).filter(x => x.t.id !== id); remDraw(); };
let actx = null;
function tone() {
    try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); const t0 = actx.currentTime;
        [[880, 0], [1175, .18]].forEach(([f, d]) => { const o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = f; o.type = 'sine'; g.gain.setValueAtTime(0, t0 + d); g.gain.linearRampToValueAtTime(.18, t0 + d + .02); g.gain.exponentialRampToValueAtTime(.001, t0 + d + .35); o.connect(g).connect(actx.destination); o.start(t0 + d); o.stop(t0 + d + .4); });
    } catch {}
}

// ------------------------------------------------------------------ Dialer → Phone: the calls and texts on the business number
function inboxView() {
    return `<div class="ph ${P.sel ? 'has-sel' : ''} ${P.info ? 'with-info' : ''}" style="--il:${LAY.il}px">
      <aside class="ph-list">
        <div class="ph-h"><div class="ph-line"><span class="lic">${ic('phone')}</span><div><b>${esc(P.cfg.pretty)}</b><small>${P.cfg.open ? 'Open now' : 'Closed'} · ${esc(P.cfg.hours)}</small></div></div>
          <div class="menu"><button type="button" class="iconbtn" data-ph="menu" aria-haspopup="true" aria-label="More">${ic('dots')}</button><div class="menu-pop" id="ph-menu" hidden>
            ${window.EL_PHONE_ONLY ? '' : `<button type="button" data-ph="window">${ic('window')}Open in its own window</button>`}
            <button type="button" data-ph="notify">${ic('info')}Notify me of calls</button></div></div></div>
        <div class="ph-acts"><button type="button" class="btn pri" data-ph="dial"${lockAttr()}>${ic('keypad')}Keypad</button><button type="button" class="btn" data-ph="new"${lockAttr()}>${ic('msg')}Text</button></div>
        <label class="ph-search">${ic('search')}<input id="ph-q" type="search" placeholder="Search names and numbers" value="${esc(P.q)}" aria-label="Search conversations"></label>
        <div class="ph-tabs" role="tablist">${[['all', 'All'], ['unread', 'Unread'], ['missed', 'Missed'], ['voicemail', 'Voicemail'], ['texts', 'Texts']].map(([k, l]) => `<button type="button" role="tab" aria-selected="${P.ibox === k}" class="${P.ibox === k ? 'on' : ''}" data-phtab="${k}">${l}</button>`).join('')}</div>
        <div class="ph-items" id="ph-items">${listHtml()}</div><div class="split" data-split="il" title="Drag to resize" role="separator" aria-orientation="vertical"></div>
      </aside>
      <section class="ph-main" id="ph-main">${P.sel ? threadHtml() : dialHtml()}</section>
      ${P.sel && P.info ? `<aside class="ph-info" id="ph-info">${infoHtml()}</aside>` : ''}
    </div>`;
}
function filtered() {
    const q = P.q.toLowerCase().replace(/[^\w+ ]/g, ''), qd = P.q.replace(/\D/g, '');
    return (P.threads || []).filter(t => (P.ibox === 'all' || (P.ibox === 'unread' && t.unread) || (P.ibox === 'missed' && t.missed) || (P.ibox === 'voicemail' && t.voicemail) || (P.ibox === 'texts' && t.texts)) &&
        (!q || (t.name || '').toLowerCase().includes(q) || (qd && t.number.replace(/\D/g, '').includes(qd))));
}
function lastLine(t) {
    const l = t.last; if (!l) return '';
    if (l.kind === 'text') return (l.direction === 'outbound' ? 'You: ' : '') + esc(l.body || '');
    if (l.voicemail) return `${ic('vm', 'sm')}Voicemail${l.duration ? ' · ' + dur(l.duration) : ''}`;
    if (l.direction === 'inbound' && l.status !== 'completed' && l.status !== 'in-progress') return `<span class="bad">${ic('missed', 'sm')}Missed call</span>`;
    return `${ic(l.direction === 'inbound' ? 'in' : 'out', 'sm')}${l.direction === 'inbound' ? 'Incoming' : 'Outgoing'} call${l.duration ? ' · ' + dur(l.duration) : ''}`;
}
function listHtml() {
    if (!P.threads) return '<div class="boot">Loading…</div>';
    const rows = filtered();
    if (!rows.length) return `<div class="empty">${P.threads.length ? 'Nothing here.' : 'No calls or texts yet. They appear here as they happen.'}</div>`;
    return rows.map(t => `<button type="button" class="ph-row ${P.sel === t.number ? 'on' : ''} ${t.unread ? 'unread' : ''}" data-phsel="${t.number}">
      <span class="cav" style="--c:var(${KIND_VAR[t.kind] || '--s-other'})">${esc(t.name ? H.initials(t.name) : '#')}</span>
      <span class="ct"><b>${esc(t.name || pretty(t.number))}</b><span>${lastLine(t)}</span></span>
      <span class="meta"><time>${when(t.last.at)}</time>${t.unread ? `<i class="dot" aria-label="${t.unread} unread"></i>` : ''}</span></button>`).join('');
}
function dialHtml(num = '') {
    return `<div class="dialwrap"><div class="dial"><input id="dial-in" class="dial-in" inputmode="tel" autocomplete="off" placeholder="${locked() ? 'Calling is closed' : 'Enter a number'}" value="${esc(num)}" aria-label="Number to call" ${locked() ? 'readonly' : ''}>
      <div class="pad">${keys('dk', locked())}</div>
      <div class="dial-acts"><span></span><button type="button" class="callbtn" data-ph="dialgo" aria-label="Call"${lockAttr()}>${ic('phone')}</button><button type="button" class="iconbtn" data-ph="dialdel" aria-label="Delete"${lockAttr()}>${ic('del')}</button></div>
      <p class="dial-note">${locked() ? esc(access().text || 'Calling is closed for you right now.') : `Calls show <b>${esc(P.cfg.pretty)}</b> to the person you call.`}</p></div></div>`;
}
function threadHtml() {
    const d = P.thread, num = P.sel;
    if (!d || d.number !== num) return `<div class="boot">Loading…</div>`;
    const name = (d.contact && d.contact.name) || (d.lead && (d.lead.full_name || d.lead.company)) || null;
    const items = [...d.calls.map(c => ({ k: 'call', at: c.started_at, c })), ...d.messages.map(m => ({ k: 'text', at: m.at, m }))].sort((a, b) => new Date(a.at) - new Date(b.at));
    let day = '';
    const body = items.map(it => { const dl = dayLabel(it.at), sep = dl !== day ? `<div class="dsep"><span>${dl}</span></div>` : ''; day = dl; return sep + (it.k === 'text' ? bubble(it.m) : callCard(it.c)); }).join('');
    const sms = P.cfg.sms, optedOut = d.contact && d.contact.opted_out;
    return `<header class="th-h"><button type="button" class="iconbtn back" data-ph="back" aria-label="Back">${ic('back')}</button><span class="cav" style="--c:var(${KIND_VAR[(d.contact || {}).kind] || '--s-other'})">${esc(name ? H.initials(name) : '#')}</span>
        <div class="ct"><b>${esc(name || d.pretty)}</b><span>${name ? esc(d.pretty) : 'Unknown number'}${d.contact && d.contact.kind && d.contact.kind !== 'other' ? ' · ' + KIND[d.contact.kind] : ''} <button type="button" class="linkbtn" data-copy="${esc(d.number)}" title="Copy the number">${ic('copy', 'sm')}Copy</button></span></div>
        <button type="button" class="btn pri" data-ph="callsel"${lockAttr()}>${ic('phone')}Call</button><button type="button" class="iconbtn ${P.info ? 'on' : ''}" data-ph="info" aria-label="Contact details">${ic('info')}</button></header>
      <div class="th-b" id="th-b">${body || '<div class="empty">No history yet. Call or text to start.</div>'}</div>
      <footer class="th-f">${!sms ? `<div class="smsoff">${ic('msg')}<span>Texting switches on once the number is approved for business texting (A2P 10DLC). Calls work now.</span></div>` : optedOut ? `<div class="smsoff">${ic('msg')}<span>They replied STOP, so they cannot be texted until they reply START.</span></div>` : locked() ? `<div class="smsoff">${ic('lock')}<span>${esc(access().text || 'Texting is closed for you right now.')}</span></div>` :
        `<div class="composer"><div class="tpl"><button type="button" class="iconbtn" data-ph="tpl" aria-label="Templates" title="Templates">${ic('bolt')}</button><div class="menu-pop up" id="tpl-pop" hidden>${P.cfg.templates.map(t => `<button type="button" data-tplk="${t.key}"><b>${esc(t.label)}</b><small>${esc(t.body)}</small></button>`).join('')}</div></div>
          <textarea id="sms-in" rows="1" placeholder="Write a message" aria-label="Message"></textarea><button type="button" class="sendbtn" data-ph="send" aria-label="Send">${ic('send')}</button></div>`}</footer>`;
}
function bubble(m) {
    const out = m.direction === 'outbound';
    return `<div class="bub ${out ? 'out' : 'in'}"><div class="bb">${esc(m.body || '')}${(m.media || []).map(x => x.url && /^image\//.test(x.type || '') ? `<img src="${esc(x.url)}" alt="Picture sent" loading="lazy">` : '').join('')}</div>
      <small>${new Date(m.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}${out ? ' · ' + (m.auto ? 'Automatic' : esc(H.teamName(m.user_id))) + (m.status && !['sent', 'delivered', 'queued', 'accepted', 'sending'].includes(m.status) ? ' · ' + esc(m.status) : '') : ''}</small></div>`;
}
function callCard(c) {
    const inb = c.direction === 'inbound', missed = inb && !c.voicemail && !['completed', 'in-progress'].includes(c.status);
    const title = c.voicemail ? 'Voicemail' : missed ? 'Missed call' : inb ? 'Incoming call' : (['completed'].includes(c.status) || c.duration) ? 'Outgoing call' : 'Outgoing call · ' + (c.status || '').replace('-', ' ');
    const who = inb ? (c.answered_by ? 'Answered by ' + H.teamName(c.answered_by) : '') : (c.user_id ? 'By ' + H.teamName(c.user_id) : '');
    return `<div class="cc ${missed ? 'missed' : ''} ${c.voicemail ? 'vm' : ''}"><span class="k">${ic(c.voicemail ? 'vm' : missed ? 'missed' : inb ? 'in' : 'out')}</span>
      <div class="x"><b>${title}${c.duration && !missed ? ' · ' + dur(c.duration) : ''}</b><span>${new Date(c.started_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}${who ? ' · ' + esc(who) : ''}</span>
        ${c.recording_url ? `<div class="vmplay"><button type="button" class="btn sm" data-play="${c.id}">${ic('play')}Play</button><audio id="au-${c.id}" controls hidden></audio></div>` : ''}
        ${c.transcript ? `<p class="tr">“${esc(c.transcript)}”</p>` : ''}
        <textarea class="cnote" data-cnote="${c.id}" rows="1" placeholder="Add a note to this call">${esc(c.note || '')}</textarea></div></div>`;
}
function infoHtml() {
    const d = P.thread; if (!d || d.number !== P.sel) return '';
    const c = d.contact || {}, l = d.lead;
    return `<div class="inf-h"><span class="cav lg" style="--c:var(${KIND_VAR[c.kind] || '--s-other'})">${esc(H.initials(c.name || (l && l.full_name) || '#'))}</span><b>${esc(c.name || (l && l.full_name) || d.pretty)}</b><span class="num">${esc(d.pretty)} <button type="button" class="linkbtn" data-copy="${esc(d.number)}">${ic('copy', 'sm')}Copy</button></span></div>
      <form id="ph-contact" class="inf-f">
        <div class="field"><label for="pc-n">Name</label><input id="pc-n" value="${esc(c.name || (l && l.full_name) || '')}" placeholder="Who is this?"></div>
        <div class="field"><label>Type</label><div class="kinds">${Object.entries(KIND).map(([k, t]) => `<label class="kchip" style="--c:var(${KIND_VAR[k]})"><input type="radio" name="pc-k" value="${k}" ${(c.kind || 'other') === k ? 'checked' : ''}><span>${t}</span></label>`).join('')}</div></div>
        <div class="field"><label for="pc-c">Company</label><input id="pc-c" value="${esc(c.company || '')}" placeholder="e.g. Lone Star Home Warranty"></div>
        <div class="field"><label for="pc-w">Work order</label><input id="pc-w" value="${esc(c.work_order || '')}" placeholder="e.g. WO-20431"></div>
        <div class="field"><label for="pc-o">Notes</label><textarea id="pc-o" rows="3" placeholder="Gate code, best time to call…">${esc(c.notes || '')}</textarea></div>
        <button class="btn" type="submit">Save contact</button></form>
      <div class="inf-l"><span class="lbl">In the CRM</span>${l ? `<button type="button" class="lnk" data-open="${l.id}">${ic('lead')}${esc(l.full_name || l.company)}<small>lead</small></button><button type="button" class="lnk" data-dgo="${l.id}">${ic('list')}Open in Calls<small>call and log how it went</small></button>` : `<button type="button" class="lnk" data-ph="mklead">${ic('plus')}Add as a lead<small>with this number</small></button>`}</div>`;
}

// ------------------------------------------------------------------ drawing in place
function drawList() { const el = $('#ph-items'); if (el) el.innerHTML = listHtml(); }
async function open(num) {
    P.sel = num; P.thread = null; P.dtab = 'phone';
    if (!onDialer()) { location.hash = 'dialer'; return; }
    rerender();
    try { P.thread = await H.api('/api/phone/thread/' + encodeURIComponent(num)); } catch (e) { H.toast(e.message, true); }
    const t = (P.threads || []).find(x => x.number === num); if (t) { t.unread = 0; badge(); }
    if (P.sel === num) rerender();
}
async function refreshThread() {
    if (!P.sel || document.activeElement && document.activeElement.matches('#sms-in,.cnote,#ph-contact *')) return;
    try { const d = await H.api('/api/phone/thread/' + encodeURIComponent(P.sel)); if (P.sel === d.number) { const grew = !P.thread || d.calls.length + d.messages.length !== P.thread.calls.length + P.thread.messages.length; P.thread = d; if (grew) drawMain(); } } catch {}
}
function drawMain() { const m = $('#ph-main'); if (m) { m.innerHTML = P.sel ? threadHtml() : dialHtml(); scrollEnd(); } const i = $('#ph-info'); if (i) i.innerHTML = infoHtml(); }
function rerender() { const v = $('#view'); if (!v) return; if (onCalls()) { v.innerHTML = callsView(); mounted(); } else if (onDialer()) { v.innerHTML = P.cfg && P.cfg.ready ? dialerView() : setupView(); mounted(); } }
function scrollEnd() { const b = $('#th-b'); if (b) b.scrollTop = b.scrollHeight; }
function mounted() {
    document.body.dataset.phpage = onCalls() ? 'calls-' + P.ctab : 'dialer-' + P.dtab; scrollEnd(); bar(); afterCard(); remDraw();
    const s = $('#sms-in'); if (s) grow(s);
    if (onDialer() && P.dtab === 'phone' && !P.sel) { const d = $('#dial-in'); if (d && matchMedia('(pointer:fine)').matches && !locked()) d.focus(); }
    if (onCalls() && P.ctab === 'home' && P.dq && P.dsel && (!P.dlead || P.dlead.lead.id !== P.dsel)) openLead(P.dsel, true);
    if ($('#au-in')) drawSoundDevices(); else releaseMeter();
    if (new URLSearchParams(location.search).has('install') && P.installEvt && !P.installAsked) { P.installAsked = true; H.toast('Press “Install app” at the top to install the Dialer.'); }
}
const grow = t => { t.style.height = 'auto'; t.style.height = Math.min(160, t.scrollHeight) + 'px'; };

async function send() {
    const t = $('#sms-in'), body = t.value.trim(); if (!body) return;
    const b = $('[data-ph="send"]'); b.disabled = true;
    try { const { message } = await H.api('/api/phone/messages', { method: 'POST', body: { to: P.sel, body } }); t.value = ''; grow(t); P.thread.messages.push(message); drawMain(); inbox().then(() => { drawList(); badge(); }); }
    catch (e) { H.toast(e.message, true); }
    b.disabled = false;
}
/** Open a lead on Calls → Home, from anywhere (the installed Dialer opens the CRM for it). */
function dial(leadId) {
    if (window.EL_PHONE_ONLY) { window.open('/#calls/home/' + leadId, '_blank'); return; }
    P.dsel = leadId; P.mob = 'lead';
    location.hash = 'calls/home/' + leadId;
}

// ------------------------------------------------------------------ events
let qTimer = 0;
document.addEventListener('click', async e => {
    const t = e.target;
    if (!t.closest('.menu') && !t.closest('.tpl')) document.querySelectorAll('.menu-pop').forEach(m => m.hidden = true);
    const cb = t.closest('[data-cb]');
    if (cb && P.call) {
        const k = cb.dataset.cb;
        if (k === 'mute') { P.callInfo.muted = !P.callInfo.muted; P.call.mute(P.callInfo.muted); }
        if (k === 'pad') P.callInfo.pad = !P.callInfo.pad;
        if (k === 'end') { const n = $('#cp-note'); if (n) P.callInfo.note = n.value; P.call.disconnect(); return; }
        bar(); drawCallPane(); return;
    }
    const ck = t.closest('[data-cbkey]'); if (ck && P.call) { P.call.sendDigits(ck.dataset.cbkey); return; }
    const rg = t.closest('[data-ring]');
    if (rg) {
        const r = P.incoming.find(x => x.id === rg.dataset.rid); if (!r) return;
        if (rg.dataset.ring === 'decline') { r.c.reject(); return; }
        if (P.call) P.call.disconnect();
        wakeAudio(); r.c.accept(); P.incoming = P.incoming.filter(x => x !== r); ring();
        wire(r.c, { number: r.from, name: nameOf(r.from), dir: 'in' }); P.callInfo.status = 'live'; P.callInfo.start = Date.now(); clearInterval(P.timer); P.timer = setInterval(tick, 1000); bar();
        if (r.pcs) H.api('/api/phone/answered', { method: 'POST', body: { sid: r.pcs } }).catch(() => {});
        return;
    }
    // reminders (on every page)
    const rx = t.closest('[data-remx]'); if (rx) return remClose(rx.dataset.remx);
    const rs = t.closest('[data-remsnooze]'); if (rs) { const Z = snoozed(); Z[rs.dataset.remsnooze] = Date.now() + ((P.rem.prefs && P.rem.prefs.snooze) || 5) * 60e3; store.set('rem-snooze', Z); return remClose(rs.dataset.remsnooze); }
    const rd = t.closest('[data-remdone]'); if (rd) { try { await H.api('/api/crm/tasks/' + rd.dataset.remdone, { method: 'PATCH', body: { done: true } }); H.toast('Done'); P.rem.list = P.rem.list.filter(x => x.id !== rd.dataset.remdone); } catch (err) { H.toast(err.message, true); } return remClose(rd.dataset.remdone); }
    const rc = t.closest('[data-remcall]'); if (rc) { const r = P.rem.list.find(x => x.id === rc.dataset.remcall); remClose(rc.dataset.remcall); if (r && r.lead) { if (!window.EL_PHONE_ONLY) dial(r.lead_id); call(r.lead.phone, r.lead.company || r.lead.full_name, r.lead_id); } return; }
    const ro = t.closest('[data-remopen]'); if (ro) { remClose((P.rem.list.find(x => x.lead_id === ro.dataset.remopen) || {}).id); return dial(ro.dataset.remopen); }
    // how the call went (Calls → Home, or the card on another page)
    const ap = t.closest('[data-apick]'); if (ap && P.after) { P.after.note = ($('#a-note') || {}).value || P.after.note; P.after.picked = ap.dataset.apick; const o = ((P.dq && P.dq.outcomes) || []).find(x => x.key === P.after.outcome); if (o && !o.who.includes(P.after.picked)) P.after.outcome = ''; return redrawAfter(); }
    const ao = t.closest('[data-aout]'); if (ao && P.after) { P.after.note = ($('#a-note') || {}).value || P.after.note; P.after.askedEmail = !!($('#a-em') || {}).checked; P.after.outcome = ao.dataset.aout; return redrawAfter(); }
    const aq = t.closest('[data-acbq]'); if (aq && P.after) { P.after.callbackAt = aq.dataset.acbq; const i = $('#a-cb'); if (i) i.value = aq.dataset.acbq; return; }
    const as = t.closest('[data-asave]'); if (as) return saveAfter(as.dataset.asave === 'next');
    if (t.closest('[data-adiscard]')) { P.after = null; afterCard(); drawCallPane(); return; }
    if (t.closest('[data-copy]')) return;          // the CRM copies it
    const dg = t.closest('[data-dgo]'); if (dg) return dial(dg.dataset.dgo);
    if (!t.closest('.phx, .ph, .callbar, .aftercard')) return;
    const px = t.closest('[data-dtab2]'); if (px) { P.dtab = px.dataset.dtab2; return rerender(); }
    // Calls → Home
    const dt = t.closest('[data-dtab]'); if (dt) { P.dqf.tab = dt.dataset.dtab; store.set('dqf', P.dqf); P.dq = null; P.dsel = null; P.mob = 'list'; return rerender(); }
    const ds = t.closest('[data-dsel]'); if (ds) return openLead(ds.dataset.dsel);
    const fo = t.closest('[data-fold]'); if (fo) { const k = fo.dataset.fold + 'c'; return setLay({ [k]: !LAY[k] }); }
    if (t.closest('[data-dback]')) { P.mob = 'list'; const dl = $('.dl'); if (dl) dl.classList.remove('m-lead'); bar(); return; }
    if (t.closest('[data-dnext]')) return nextLead();
    if (t.closest('[data-dfull]')) { if (P.dsel && H.openLead) H.openLead(P.dsel); return; }
    if (t.closest('[data-dreopen]')) { try { const r = await H.api('/api/crm/dialer/reopen', { method: 'POST', body: { ids: [P.dsel] } }); H.toast(r.reopened ? 'Back in the call list, due now' : 'It cannot go back: do not call, or a wrong number.', !r.reopened); const id = P.dsel; await loadQueue(); P.dsel = id; P.dlead = null; rerender(); } catch (err) { H.toast(err.message, true); } return; }
    if (t.closest('[data-dcall]')) { const l = P.dlead && P.dlead.lead; if (l) call(l.phone, l.company || l.full_name, l.id); return; }
    if (t.closest('[data-dlog]')) { const l = P.dlead && P.dlead.lead; if (!l || locked()) return; P.after = { leadId: l.id, name: l.company || l.full_name, sid: null, secs: 0, picked: '', outcome: '', note: '', callbackAt: '', askedEmail: false, connected: false }; return drawCallPane(); }
    // Calls → My numbers and Settings
    const sr = t.closest('[data-srange]'); if (sr) { P.srange = sr.dataset.srange; store.set('srange', P.srange); P.stats = null; return rerender(); }
    if (t.closest('[data-prefoffice]')) return savePrefs({ reminders: null, snooze: null });
    // Dialer → Phone
    const tab = t.closest('button[data-phtab]'); if (tab) { P.ibox = tab.dataset.phtab; document.querySelectorAll('[data-phtab]').forEach(b => { b.classList.toggle('on', b === tab); b.setAttribute('aria-selected', b === tab); }); return drawList(); }
    const row = t.closest('[data-phsel]'); if (row) return open(row.dataset.phsel);
    const dk = t.closest('[data-dk]'); if (dk) { if (locked()) return; const i = $('#dial-in'); i.value += dk.dataset.dk; i.focus(); return; }
    const tk = t.closest('[data-tplk]'); if (tk) { const s = $('#sms-in'); s.value = P.cfg.templates.find(x => x.key === tk.dataset.tplk).body; grow(s); s.focus(); $('#tpl-pop').hidden = true; return; }
    const pl = t.closest('[data-play]');
    if (pl) { const a = $('#au-' + pl.dataset.play); pl.disabled = true; pl.textContent = 'Loading…';
        try { const r = await fetch(H.backend + '/api/phone/recording/' + pl.dataset.play, { headers: { Authorization: 'Bearer ' + await H.token() } }); if (!r.ok) throw new Error('The recording could not load.'); a.src = URL.createObjectURL(await r.blob()); a.hidden = false; pl.remove(); a.play(); }
        catch (err) { H.toast(err.message, true); pl.disabled = false; pl.textContent = 'Play'; } return; }
    const a = t.closest('[data-ph]'); if (!a || a.disabled) return;
    const k = a.dataset.ph;
    if (k === 'menu') { const m = $('#ph-menu'); m.hidden = !m.hidden; return; }
    if (k === 'install') return install();
    if (k === 'window') { $('#ph-menu').hidden = true; window.open('phone.html', 'elphone', 'width=1240,height=820'); return; }
    if (k === 'notify') { const m = $('#ph-menu'); if (m) m.hidden = true; if (!('Notification' in window)) return H.toast('This browser cannot show notifications.', true);
        const p = await Notification.requestPermission(); return H.toast(p === 'granted' ? 'You will be notified of calls while this is open in the background.' : 'Notifications are blocked for this site in the browser settings.'); }
    if (k === 'testalert') { if (!('Notification' in window)) return H.toast('This browser cannot show desktop alerts.', true);
        const p = await Notification.requestPermission(); if (p !== 'granted') return H.toast('Desktop alerts are blocked for this site in the browser settings.', true);
        try { new Notification('EdgeLead reminder', { body: 'This is how a call-back reminder looks.', tag: 'el-test' }); } catch {} if (P.rem.prefs && P.rem.prefs.tone) tone(); return rerender(); }
    if (k === 'tone') return tone();
    if (k === 'testspk') { try { if (P.device && P.device.audio) await P.device.audio.speakerDevices.test(); else throw new Error('The phone is still connecting.'); } catch (err) { H.toast(err.message || 'The test sound could not play.', true); } return; }
    if (k === 'preflight') return preflight();
    if (k === 'dial') { P.sel = null; P.thread = null; rerender(); return; }
    if (k === 'dialdel') { const i = $('#dial-in'); i.value = i.value.slice(0, -1); i.focus(); return; }
    if (k === 'dialgo') { const n = $('#dial-in').value; return call(n); }
    if (k === 'new') { P.sel = null; rerender(); const m = $('#ph-main'); m.innerHTML = `<div class="dialwrap"><form class="dial" id="newsms"><h2 class="nt">New text</h2><input id="ns-to" class="dial-in sm" inputmode="tel" placeholder="Their number" aria-label="Their number"><button class="btn pri wide" type="submit">Start the conversation</button></form></div>`; $('#ns-to').focus(); return; }
    if (k === 'back') { P.sel = null; P.thread = null; rerender(); return; }
    if (k === 'callsel') { const lead = P.thread && P.thread.lead; return call(P.sel, nameOf(P.sel) || (P.thread && P.thread.contact && P.thread.contact.name), lead ? lead.id : null); }
    if (k === 'info') { P.info = !P.info; rerender(); return; }
    if (k === 'tpl') { const m = $('#tpl-pop'); m.hidden = !m.hidden; return; }
    if (k === 'send') return send();
    if (k === 'mklead') return H.newLead({ phone: P.sel, full_name: v('pc-n') });
});
const v = id => (($('#' + id) || {}).value || '').trim();
document.addEventListener('submit', async e => {
    if (e.target.id === 'newsms') { e.preventDefault(); const n = e164($('#ns-to').value); if (!n) return H.toast('That number is not valid.', true); return open(n); }
    if (e.target.id === 'lp-ins') {
        e.preventDefault(); const inp = $('#lp-ins-in'), line = inp.value.trim(); if (!line || !P.dlead) return;
        const l = P.dlead.lead, next = [...(Array.isArray(l.insights) ? l.insights : []), line];
        try { const { lead } = await H.api('/api/crm/leads/' + l.id, { method: 'PATCH', body: { insights: next } }); P.dlead.lead = { ...l, ...lead }; drawLead(); H.toast('Added'); } catch (err) { H.toast(err.message, true); }
        return;
    }
    if (e.target.id !== 'ph-contact') return; e.preventDefault();
    const kind = (document.querySelector('input[name="pc-k"]:checked') || {}).value || 'other';
    try { const { contact } = await H.api('/api/phone/contacts/' + encodeURIComponent(P.sel), { method: 'PUT', body: { name: v('pc-n'), kind, company: v('pc-c'), work_order: v('pc-w'), notes: ($('#pc-o') || {}).value || '' } });
        P.thread.contact = contact; const t = (P.threads || []).find(x => x.number === P.sel); if (t) { t.name = contact.name; t.kind = contact.kind; }
        H.toast('Contact saved'); drawList(); drawMain(); }
    catch (err) { H.toast(err.message, true); }
});
document.addEventListener('keydown', e => {
    if (e.target.id === 'sms-in' && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    if (e.target.id === 'dial-in' && e.key === 'Enter') { e.preventDefault(); call(e.target.value); }
    if (P.callInfo && P.callInfo.pad && /^[0-9*#]$/.test(e.key) && !e.target.matches('input,textarea')) P.call.sendDigits(e.key);
    // Calls → Home: J / K or the arrows move through the list, C calls
    if (onCalls() && P.ctab === 'home' && !e.target.matches('input,textarea,select') && !e.metaKey && !e.ctrlKey && !e.altKey && !document.querySelector('#layer .modal, #layer .drawer')) {
        const rows = lastQ(), at = rows.findIndex(r => r.id === P.dsel);
        if (['j', 'ArrowDown'].includes(e.key) && rows[at + 1]) { e.preventDefault(); openLead(rows[at + 1].id, true); const b = $(`[data-dsel="${rows[at + 1].id}"]`); if (b) b.scrollIntoView({ block: 'nearest' }); }
        if (['k', 'ArrowUp'].includes(e.key) && at > 0) { e.preventDefault(); openLead(rows[at - 1].id, true); const b = $(`[data-dsel="${rows[at - 1].id}"]`); if (b) b.scrollIntoView({ block: 'nearest' }); }
        if (e.key === 'c' && !P.callInfo && P.dlead && P.dlead.lead.phone && !$('[data-dcall]').disabled) { e.preventDefault(); call(P.dlead.lead.phone, P.dlead.lead.company || P.dlead.lead.full_name, P.dlead.lead.id); }
    }
});
document.addEventListener('input', e => {
    if (e.target.id === 'sms-in') grow(e.target);
    if (e.target.id === 'ph-q') { P.q = e.target.value; drawList(); }
    if (e.target.id === 'cp-note' && P.callInfo) P.callInfo.note = e.target.value;
    if (e.target.id === 'a-note' && P.after) P.after.note = e.target.value;
    if (e.target.id === 'a-cb' && P.after) P.after.callbackAt = e.target.value;
    if (e.target.id === 'dial-in' && locked()) e.target.value = '';
    if (e.target.id === 'dl-q') { P.dqf.q = e.target.value; clearTimeout(qTimer); qTimer = setTimeout(async () => { store.set('dqf', P.dqf); try { await loadQueue(); drawRows(); counts(); } catch (err) { H.toast(err.message, true); } }, 250); }
});
document.addEventListener('change', async e => {
    const t = e.target;
    if (t.id === 'a-em' && P.after) { P.after.askedEmail = t.checked; return; }
    if (t.id === 'dl-list' || t.id === 'dl-ind') { P.dqf[t.id === 'dl-list' ? 'list' : 'industry'] = t.value; store.set('dqf', P.dqf); P.dq = null; P.dsel = null; return rerender(); }
    if (t.id === 'suser') { P.suser = t.value; P.stats = null; return rerender(); }
    if (t.matches('[data-remstep]')) { const steps = [...document.querySelectorAll('[data-remstep]:checked')].map(x => +x.value); return savePrefs({ reminders: steps }); }
    if (t.id === 'pf-snooze') return savePrefs({ snooze: +t.value });
    if (t.id === 'pf-tone') return savePrefs({ tone: t.checked });
    if (t.id === 'pf-desk') return savePrefs({ desktop: t.checked });
    if (t.matches('[data-aud]')) { AUD[t.dataset.aud] = t.checked; store.set('audio', AUD); await applyAudio(); H.toast('Sound settings saved on this computer'); return; }
    if (t.id === 'au-in') { AUD.input = t.value; store.set('audio', AUD); try { await P.device.audio.setInputDevice(t.value); H.toast('Microphone changed'); } catch (err) { H.toast(err.message, true); } return; }
    if (t.id === 'au-out') { AUD.output = t.value; store.set('audio', AUD); try { await P.device.audio.speakerDevices.set(t.value); await P.device.audio.ringtoneDevices.set(t.value); H.toast('Speaker changed'); } catch (err) { H.toast(err.message, true); } return; }
    const n = t.closest('[data-cnote]'); if (!n) return;
    try { await H.api('/api/phone/calls/' + n.dataset.cnote, { method: 'PATCH', body: { note: n.value } }); const c = P.thread && P.thread.calls.find(x => x.id === n.dataset.cnote); if (c) c.note = n.value; H.toast('Note saved'); } catch (err) { H.toast(err.message, true); }
});
addEventListener('resize', () => bar());
addEventListener('hashchange', () => setTimeout(() => { if (!H) return; afterCard(); if (!$('#au-in')) releaseMeter(); }, 0));

return { init, view, mounted, call, open, dial, unread, reminders: remLoad, get ready() { return !!(P.cfg && P.cfg.ready); }, get busy() { return !!P.call; }, text(num) { const n = e164(num); if (n) open(n); } };
})();
