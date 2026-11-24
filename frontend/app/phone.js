/**
 * EdgeLead CRM, phase 88: the phone. Calls, texts and voicemail on the business number, OpenPhone-style.
 *   Inbox (left) · conversation (middle) · contact (right). A keypad to dial, a bar while in a call,
 *   a card when a call comes in. Calls ring wherever the CRM or the Phone app is open.
 * The CRM (app/app.js) hands in its helpers with ELPhone.init(); phone.html runs only this view.
 */
window.ELPhone = (function () {
'use strict';
const SDK = 'https://unpkg.com/@twilio/voice-sdk@2.18.5/dist/twilio.min.js';
let H = null;                       // helpers from the CRM: api, toast, esc, ic, initials, openLead, render, route
const P = { cfg: null, device: null, state: 'off', call: null, callInfo: null, incoming: [], threads: null, sel: null, thread: null, tab: 'all', q: '', timer: 0, poll: 0, installEvt: null, info: true };
const $ = (s, r = document) => r.querySelector(s);
const KIND = { homeowner: 'Homeowner', property_manager: 'Property manager', warranty: 'Warranty company', technician: 'Technician', vendor: 'Vendor', other: 'Other' };
const KIND_VAR = { homeowner: '--s-web', property_manager: '--s-meta', warranty: '--s-google', technician: '--s-seo', vendor: '--s-ref', other: '--s-other' };
const pretty = n => { const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(n || ''); return m ? `(${m[1]}) ${m[2]}-${m[3]}` : (n || ''); };
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
const I = {
    phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>', in: '<path d="M16 3 10 9M10 4v5h5"/><path d="M5 4h3l2 4-2 1a10 10 0 0 0 5 5l1-2 4 2v3a2 2 0 0 1-2 2A15 15 0 0 1 3 6a2 2 0 0 1 2-2"/>',
    out: '<path d="M14 9l6-6M15 3h5v5"/><path d="M5 4h3l2 4-2 1a10 10 0 0 0 5 5l1-2 4 2v3a2 2 0 0 1-2 2A15 15 0 0 1 3 6a2 2 0 0 1 2-2"/>', missed: '<path d="m15 3 6 6M21 3l-6 6"/><path d="M5 4h3l2 4-2 1a10 10 0 0 0 5 5l1-2 4 2v3a2 2 0 0 1-2 2A15 15 0 0 1 3 6a2 2 0 0 1 2-2"/>',
    vm: '<circle cx="6.5" cy="12" r="3.5"/><circle cx="17.5" cy="12" r="3.5"/><path d="M6.5 15.5h11"/>', msg: '<path d="M4 5h16v11H9l-5 4z"/>', keypad: '<circle cx="6" cy="5" r="1.2"/><circle cx="12" cy="5" r="1.2"/><circle cx="18" cy="5" r="1.2"/><circle cx="6" cy="11" r="1.2"/><circle cx="12" cy="11" r="1.2"/><circle cx="18" cy="11" r="1.2"/><circle cx="6" cy="17" r="1.2"/><circle cx="12" cy="17" r="1.2"/><circle cx="18" cy="17" r="1.2"/><circle cx="12" cy="22" r="1.2"/>',
    mute: '<path d="M9 9v3a3 3 0 0 0 5 2.2M15 9.3V5a3 3 0 0 0-5.7-1.3"/><path d="M19 11a7 7 0 0 1-1.2 3.9M5 11a7 7 0 0 0 11 5.7M12 18v3M3 3l18 18"/>', mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    end: '<path d="M3 15c5-5 13-5 18 0l-2.5 2.5-3.5-1.5v-3a12 12 0 0 0-6 0v3L5.5 17.5z"/>', send: '<path d="M4 12 20 4l-6 16-3-7z"/>', bolt: '<path d="M13 3 5 14h6l-1 7 8-11h-6z"/>', dots: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>', play: '<path d="M7 4v16l13-8z"/>', back: '<path d="M15 5l-7 7 7 7"/>', del: '<path d="M21 5H9l-6 7 6 7h12z"/><path d="m12 9 6 6M18 9l-6 6"/>', plus: '<path d="M12 5v14M5 12h14"/>', search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    install: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 8v6M9 11l3 3 3-3"/>', window: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>', lead: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M19 8v6M16 11h6"/>'
};
const ic = (k, cls = '') => `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true">${I[k] || ''}</svg>`;
const esc = s => H.esc(s);

// ------------------------------------------------------------------ setup
async function init(helpers) {
    H = helpers;
    window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); P.installEvt = e; });
    try { P.cfg = await H.api('/api/phone/config'); } catch { P.cfg = { ready: false, missing: [] }; }
    if (!P.cfg.ready) return;
    await inbox().catch(() => {}); badge();
    clearInterval(P.poll); P.poll = setInterval(() => inbox().then(() => { badge(); if (H.route() === 'phone') { drawList(); if (P.sel) refreshThread(); } }).catch(() => {}), 20000);
    startDevice();
}
function loadSdk() {
    if (window.Twilio && window.Twilio.Device) return Promise.resolve();
    return new Promise((ok, no) => { const s = document.createElement('script'); s.src = SDK; s.onload = ok; s.onerror = () => no(new Error('The calling software could not load.')); document.head.appendChild(s); });
}
async function startDevice() {
    try {
        await loadSdk();
        const { token } = await H.api('/api/phone/token');
        const d = new Twilio.Device(token, { codecPreferences: ['opus', 'pcmu'], closeProtection: 'A call is in progress. Leave anyway?', logLevel: 'error' });
        P.device = d;
        d.on('registered', () => setState('ready'));
        d.on('unregistered', () => setState('off'));
        d.on('error', err => { setState(P.state === 'ready' ? 'ready' : 'error'); if (err && err.code !== 31005) H.toast(err.message || 'Calling error', true); });
        d.on('tokenWillExpire', async () => { try { d.updateToken((await H.api('/api/phone/token')).token); } catch {} });
        d.on('incoming', onIncoming);
        await d.register();
    } catch (e) { setState('error'); console.warn('phone', e); }
}
function setState(s) { P.state = s; const el = $('#ph-state'); if (el) el.outerHTML = stateChip(); }
const stateChip = () => `<span id="ph-state" class="phstate ${P.state}" title="${P.state === 'ready' ? 'Calls ring here' : 'Not connected: calls go to voicemail'}"><i></i>${P.state === 'ready' ? 'Ready' : P.state === 'error' ? 'Offline' : 'Connecting'}</span>`;
async function inbox() { P.threads = (await H.api('/api/phone/inbox')).threads; return P.threads; }
function badge() { const n = (P.threads || []).reduce((a, t) => a + (t.unread || 0), 0); document.querySelectorAll('[data-phbadge]').forEach(b => { b.textContent = n || ''; b.hidden = !n; }); }
const unread = () => (P.threads || []).reduce((a, t) => a + (t.unread || 0), 0);

// ------------------------------------------------------------------ calls
function call(number, name) {
    const to = e164(number);
    if (!to) return H.toast('That number is not valid.', true);
    if (!P.cfg || !P.cfg.ready) return H.toast('The phone is not set up yet. The owner finishes it in Admin.', true);
    if (!P.device || P.state !== 'ready') return H.toast('The phone is still connecting. Try again in a moment.', true);
    if (P.call) return H.toast('Finish the current call first.', true);
    P.device.connect({ params: { To: to } }).then(c => wire(c, { number: to, name: name || nameOf(to), dir: 'out' })).catch(e => H.toast(e.message, true));
}
function wire(c, info) {
    P.call = c; P.callInfo = { ...info, status: info.dir === 'out' ? 'Calling…' : 'Connecting…', start: 0, muted: false, pad: false };
    bar();
    c.on('accept', () => { P.callInfo.start = Date.now(); P.callInfo.status = 'live'; bar(); clearInterval(P.timer); P.timer = setInterval(tick, 1000); });
    c.on('ringing', () => { P.callInfo.status = 'Ringing…'; bar(); });
    const end = why => { clearInterval(P.timer); const n = P.callInfo && P.callInfo.number; P.call = null; P.callInfo = null; bar(); if (why) H.toast(why); setTimeout(() => inbox().then(() => { badge(); if (H.route() === 'phone') { drawList(); if (P.sel === n) refreshThread(); } }), 2500); };
    c.on('disconnect', () => end('Call ended'));
    c.on('cancel', () => end());
    c.on('reject', () => end());
    c.on('error', e => end(e.message));
}
function tick() { const t = $('#cb-t'); if (t && P.callInfo && P.callInfo.start) t.textContent = dur((Date.now() - P.callInfo.start) / 1000); }
function bar() {
    let el = $('#callbar');
    if (!P.callInfo) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'callbar'; el.className = 'callbar'; document.body.appendChild(el); }
    const i = P.callInfo, live = i.status === 'live';
    el.innerHTML = `<span class="cav">${esc(H.initials(i.name || ''))}</span><div class="ct"><b>${esc(i.name || pretty(i.number))}</b><span>${i.name ? esc(pretty(i.number)) + ' · ' : ''}${live ? `<span id="cb-t" class="num">${dur((Date.now() - i.start) / 1000)}</span>` : esc(i.status)}</span></div>
      <button type="button" class="cbtn ${i.muted ? 'on' : ''}" data-cb="mute" aria-pressed="${i.muted}" title="${i.muted ? 'Unmute' : 'Mute'}">${ic(i.muted ? 'mute' : 'mic')}<small>${i.muted ? 'Unmute' : 'Mute'}</small></button>
      <button type="button" class="cbtn ${i.pad ? 'on' : ''}" data-cb="pad" title="Keypad">${ic('keypad')}<small>Keypad</small></button>
      <button type="button" class="cbtn end" data-cb="end" title="Hang up">${ic('end')}<small>End</small></button>
      ${i.pad ? `<div class="cbpad">${keys('cbkey')}</div>` : ''}`;
}
const KEYS = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'], ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', '+'], ['#', '']];
const keys = attr => KEYS.map(([k, l]) => `<button type="button" class="key" data-${attr}="${k}"><b>${k}</b><small>${l}</small></button>`).join('');
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

// ------------------------------------------------------------------ the view
function view() {
    if (!P.cfg) return `<div class="boot">Loading…</div>`;
    if (!P.cfg.ready) return setupView();
    return `<div class="ph ${P.sel ? 'has-sel' : ''} ${P.info ? 'with-info' : ''}">
      <aside class="ph-list">
        <div class="ph-h"><div class="ph-line"><span class="lic">${ic('phone')}</span><div><b>${esc(P.cfg.pretty)}</b><small>${P.cfg.open ? 'Open now' : 'Closed'} · ${esc(P.cfg.hours)}</small></div></div>${stateChip()}
          <div class="menu"><button type="button" class="iconbtn" data-ph="menu" aria-haspopup="true" aria-label="More">${ic('dots')}</button><div class="menu-pop" id="ph-menu" hidden>
            <button type="button" data-ph="install">${ic('install')}Install as a desktop app</button>
            ${window.EL_PHONE_ONLY ? '' : `<button type="button" data-ph="window">${ic('window')}Open in its own window</button>`}
            <button type="button" data-ph="notify">${ic('info')}Notify me of calls</button></div></div></div>
        <div class="ph-acts"><button type="button" class="btn pri" data-ph="dial">${ic('keypad')}Call</button><button type="button" class="btn" data-ph="new">${ic('msg')}Text</button></div>
        <label class="ph-search">${ic('search')}<input id="ph-q" type="search" placeholder="Search names and numbers" value="${esc(P.q)}" aria-label="Search conversations"></label>
        <div class="ph-tabs" role="tablist">${[['all', 'All'], ['unread', 'Unread'], ['missed', 'Missed'], ['voicemail', 'Voicemail'], ['texts', 'Texts']].map(([k, l]) => `<button type="button" role="tab" aria-selected="${P.tab === k}" class="${P.tab === k ? 'on' : ''}" data-phtab="${k}">${l}</button>`).join('')}</div>
        <div class="ph-items" id="ph-items">${listHtml()}</div>
      </aside>
      <section class="ph-main" id="ph-main">${P.sel ? threadHtml() : dialHtml()}</section>
      ${P.sel && P.info ? `<aside class="ph-info" id="ph-info">${infoHtml()}</aside>` : ''}
    </div>`;
}
function setupView() {
    const m = P.cfg.missing || [];
    return `<div class="head"><div><h1>Phone</h1><p class="sub">Calls, texts and voicemail on (469) 819-4097, right here in the CRM.</p></div></div>
      <section class="card setup"><div class="card-h"><h2>Almost ready</h2><span>Owner's steps</span></div>
        <div class="steps2">${[['Twilio account', 'Your Account SID and Auth Token, from the Twilio console home page.', ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN']],
            ['An API key', 'Console → Account → API keys → Create (Standard). Copy the SID and the secret.', ['TWILIO_API_KEY', 'TWILIO_API_SECRET']],
            ['A TwiML App', 'Voice → TwiML Apps → Create. Voice URL: the address in Admin → Phone. Copy its SID.', ['TWILIO_TWIML_APP_SID']]]
            .map(([t, d, ks], i) => `<div class="stp ${ks.every(k => !m.includes(k)) ? 'done' : ''}"><span class="n">${i + 1}</span><div><b>${t}</b><p>${d}</p><code>${ks.join(' · ')}</code></div></div>`).join('')}
          <div class="stp"><span class="n">4</span><div><b>Put them on the server</b><p>Render → the backend service → Environment. Add each value, then save. The server restarts and the phone switches on here.</p></div></div></div></section>`;
}
function filtered() {
    const q = P.q.toLowerCase().replace(/[^\w+ ]/g, ''), qd = P.q.replace(/\D/g, '');
    return (P.threads || []).filter(t => (P.tab === 'all' || (P.tab === 'unread' && t.unread) || (P.tab === 'missed' && t.missed) || (P.tab === 'voicemail' && t.voicemail) || (P.tab === 'texts' && t.texts)) &&
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
    return `<div class="dialwrap"><div class="dial"><input id="dial-in" class="dial-in" inputmode="tel" autocomplete="off" placeholder="Enter a number" value="${esc(num)}" aria-label="Number to call">
      <div class="pad">${keys('dk')}</div>
      <div class="dial-acts"><span></span><button type="button" class="callbtn" data-ph="dialgo" aria-label="Call">${ic('phone')}</button><button type="button" class="iconbtn" data-ph="dialdel" aria-label="Delete">${ic('del')}</button></div>
      <p class="dial-note">Calls show <b>${esc(P.cfg.pretty)}</b> to the person you call.</p></div></div>`;
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
        <div class="ct"><b>${esc(name || d.pretty)}</b><span>${name ? esc(d.pretty) : 'Unknown number'}${d.contact && d.contact.kind && d.contact.kind !== 'other' ? ' · ' + KIND[d.contact.kind] : ''}</span></div>
        <button type="button" class="btn pri" data-ph="callsel">${ic('phone')}Call</button><button type="button" class="iconbtn ${P.info ? 'on' : ''}" data-ph="info" aria-label="Contact details">${ic('info')}</button></header>
      <div class="th-b" id="th-b">${body || '<div class="empty">No history yet. Call or text to start.</div>'}</div>
      <footer class="th-f">${!sms ? `<div class="smsoff">${ic('msg')}<span>Texting switches on once the number is approved for business texting (A2P 10DLC). Calls work now.</span></div>` : optedOut ? `<div class="smsoff">${ic('msg')}<span>They replied STOP, so they cannot be texted until they reply START.</span></div>` :
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
    return `<div class="inf-h"><span class="cav lg" style="--c:var(${KIND_VAR[c.kind] || '--s-other'})">${esc(H.initials(c.name || (l && l.full_name) || '#'))}</span><b>${esc(c.name || (l && l.full_name) || d.pretty)}</b><span class="num">${esc(d.pretty)}</span></div>
      <form id="ph-contact" class="inf-f">
        <div class="field"><label for="pc-n">Name</label><input id="pc-n" value="${esc(c.name || (l && l.full_name) || '')}" placeholder="Who is this?"></div>
        <div class="field"><label>Type</label><div class="kinds">${Object.entries(KIND).map(([k, t]) => `<label class="kchip" style="--c:var(${KIND_VAR[k]})"><input type="radio" name="pc-k" value="${k}" ${(c.kind || 'other') === k ? 'checked' : ''}><span>${t}</span></label>`).join('')}</div></div>
        <div class="field"><label for="pc-c">Company</label><input id="pc-c" value="${esc(c.company || '')}" placeholder="e.g. Lone Star Home Warranty"></div>
        <div class="field"><label for="pc-w">Work order</label><input id="pc-w" value="${esc(c.work_order || '')}" placeholder="e.g. WO-20431"></div>
        <div class="field"><label for="pc-o">Notes</label><textarea id="pc-o" rows="3" placeholder="Gate code, best time to call…">${esc(c.notes || '')}</textarea></div>
        <button class="btn" type="submit">Save contact</button></form>
      <div class="inf-l"><span class="lbl">In the CRM</span>${l ? `<button type="button" class="lnk" data-open="${l.id}">${ic('lead')}${esc(l.full_name || l.company)}<small>lead</small></button>` : `<button type="button" class="lnk" data-ph="mklead">${ic('plus')}Add as a lead<small>with this number</small></button>`}</div>`;
}

// ------------------------------------------------------------------ drawing in place
function drawList() { const el = $('#ph-items'); if (el) el.innerHTML = listHtml(); }
async function open(num) {
    P.sel = num; P.thread = null;
    if (H.route() !== 'phone') { location.hash = 'phone'; return; }
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
function rerender() { const v = $('#view'); if (v && H.route() === 'phone') { v.innerHTML = view(); mounted(); } }
function scrollEnd() { const b = $('#th-b'); if (b) b.scrollTop = b.scrollHeight; }
function mounted() { scrollEnd(); const s = $('#sms-in'); if (s) grow(s); if (!P.sel) { const d = $('#dial-in'); if (d && matchMedia('(pointer:fine)').matches) d.focus(); } }
const grow = t => { t.style.height = 'auto'; t.style.height = Math.min(160, t.scrollHeight) + 'px'; };

async function send() {
    const t = $('#sms-in'), body = t.value.trim(); if (!body) return;
    const b = $('[data-ph="send"]'); b.disabled = true;
    try { const { message } = await H.api('/api/phone/messages', { method: 'POST', body: { to: P.sel, body } }); t.value = ''; grow(t); P.thread.messages.push(message); drawMain(); inbox().then(() => { drawList(); badge(); }); }
    catch (e) { H.toast(e.message, true); }
    b.disabled = false;
}

// ------------------------------------------------------------------ events
document.addEventListener('click', async e => {
    const t = e.target;
    if (!t.closest('.menu') && !t.closest('.tpl')) document.querySelectorAll('.menu-pop').forEach(m => m.hidden = true);
    const cb = t.closest('[data-cb]');
    if (cb && P.call) {
        const k = cb.dataset.cb;
        if (k === 'mute') { P.callInfo.muted = !P.callInfo.muted; P.call.mute(P.callInfo.muted); }
        if (k === 'pad') P.callInfo.pad = !P.callInfo.pad;
        if (k === 'end') { P.call.disconnect(); return; }
        return bar();
    }
    const ck = t.closest('[data-cbkey]'); if (ck && P.call) { P.call.sendDigits(ck.dataset.cbkey); return; }
    const rg = t.closest('[data-ring]');
    if (rg) {
        const r = P.incoming.find(x => x.id === rg.dataset.rid); if (!r) return;
        if (rg.dataset.ring === 'decline') { r.c.reject(); return; }
        if (P.call) P.call.disconnect();
        r.c.accept(); P.incoming = P.incoming.filter(x => x !== r); ring();
        wire(r.c, { number: r.from, name: nameOf(r.from), dir: 'in' }); P.callInfo.status = 'live'; P.callInfo.start = Date.now(); clearInterval(P.timer); P.timer = setInterval(tick, 1000); bar();
        if (r.pcs) H.api('/api/phone/answered', { method: 'POST', body: { sid: r.pcs } }).catch(() => {});
        return;
    }
    if (!t.closest('.ph, .callbar')) return;
    const tab = t.closest('[data-phtab]'); if (tab) { P.tab = tab.dataset.phtab; document.querySelectorAll('[data-phtab]').forEach(b => { b.classList.toggle('on', b === tab); b.setAttribute('aria-selected', b === tab); }); return drawList(); }
    const row = t.closest('[data-phsel]'); if (row) return open(row.dataset.phsel);
    const dk = t.closest('[data-dk]'); if (dk) { const i = $('#dial-in'); i.value += dk.dataset.dk; i.focus(); return; }
    const tk = t.closest('[data-tplk]'); if (tk) { const s = $('#sms-in'); s.value = P.cfg.templates.find(x => x.key === tk.dataset.tplk).body; grow(s); s.focus(); $('#tpl-pop').hidden = true; return; }
    const pl = t.closest('[data-play]');
    if (pl) { const a = $('#au-' + pl.dataset.play); pl.disabled = true; pl.textContent = 'Loading…';
        try { const r = await fetch(H.backend + '/api/phone/recording/' + pl.dataset.play, { headers: { Authorization: 'Bearer ' + await H.token() } }); if (!r.ok) throw new Error('The recording could not load.'); a.src = URL.createObjectURL(await r.blob()); a.hidden = false; pl.remove(); a.play(); }
        catch (err) { H.toast(err.message, true); pl.disabled = false; pl.textContent = 'Play'; } return; }
    const a = t.closest('[data-ph]'); if (!a) return;
    const k = a.dataset.ph;
    if (k === 'menu') { const m = $('#ph-menu'); m.hidden = !m.hidden; return; }
    if (k === 'install') { $('#ph-menu').hidden = true;
        if (P.installEvt) { P.installEvt.prompt(); const r = await P.installEvt.userChoice; if (r.outcome === 'accepted') H.toast('Installed. Open “EdgeLead Phone” from your desktop or Start menu.'); P.installEvt = null; return; }
        if (!window.EL_PHONE_ONLY) { window.open('phone.html?install=1', 'elphone', 'width=1180,height=780'); return; }
        return H.toast(matchMedia('(display-mode: standalone)').matches ? 'This is the installed app.' : 'In Chrome or Edge: the install icon at the right of the address bar, or ⋮ → Cast, save and share → Install page as app.'); }
    if (k === 'window') { $('#ph-menu').hidden = true; window.open('phone.html', 'elphone', 'width=1180,height=780'); return; }
    if (k === 'notify') { $('#ph-menu').hidden = true; if (!('Notification' in window)) return H.toast('This browser cannot show notifications.', true);
        const p = await Notification.requestPermission(); return H.toast(p === 'granted' ? 'You will be notified of calls while this is open in the background.' : 'Notifications are blocked for this site in the browser settings.'); }
    if (k === 'dial') { P.sel = null; P.thread = null; rerender(); return; }
    if (k === 'dialdel') { const i = $('#dial-in'); i.value = i.value.slice(0, -1); i.focus(); return; }
    if (k === 'dialgo') { const n = $('#dial-in').value; return call(n); }
    if (k === 'new') { P.sel = null; rerender(); const m = $('#ph-main'); m.innerHTML = `<div class="dialwrap"><form class="dial" id="newsms"><h2 class="nt">New text</h2><input id="ns-to" class="dial-in sm" inputmode="tel" placeholder="Their number" aria-label="Their number"><button class="btn pri wide" type="submit">Start the conversation</button></form></div>`; $('#ns-to').focus(); return; }
    if (k === 'back') { P.sel = null; P.thread = null; rerender(); return; }
    if (k === 'callsel') return call(P.sel, nameOf(P.sel) || (P.thread && P.thread.contact && P.thread.contact.name));
    if (k === 'info') { P.info = !P.info; rerender(); return; }
    if (k === 'tpl') { const m = $('#tpl-pop'); m.hidden = !m.hidden; return; }
    if (k === 'send') return send();
    if (k === 'mklead') return H.newLead({ phone: P.sel, full_name: v('pc-n') });
});
const v = id => (($('#' + id) || {}).value || '').trim();
document.addEventListener('submit', async e => {
    if (e.target.id === 'newsms') { e.preventDefault(); const n = e164($('#ns-to').value); if (!n) return H.toast('That number is not valid.', true); return open(n); }
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
});
document.addEventListener('input', e => {
    if (e.target.id === 'sms-in') grow(e.target);
    if (e.target.id === 'ph-q') { P.q = e.target.value; drawList(); }
});
document.addEventListener('change', async e => {
    const n = e.target.closest('[data-cnote]'); if (!n) return;
    try { await H.api('/api/phone/calls/' + n.dataset.cnote, { method: 'PATCH', body: { note: n.value } }); const c = P.thread && P.thread.calls.find(x => x.id === n.dataset.cnote); if (c) c.note = n.value; H.toast('Note saved'); } catch (err) { H.toast(err.message, true); }
});

return { init, view, mounted, call, open, unread, get ready() { return !!(P.cfg && P.cfg.ready); }, text(num) { const n = e164(num); if (n) open(n); } };
})();
