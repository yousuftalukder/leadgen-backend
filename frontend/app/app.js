/**
 * EdgeLead CRM (phase 87, redrawn in phases 89 and 90): one page at /, its own script.
 * Views live in the address hash: #overview, #leads, #pipeline, #campaigns, #calls/<tab>, #dialer, #clients, #client/<id>/<tab>,
 * #influencers, #admin/<section>. The client page, email campaigns and Admin are their own files (app/client.js,
 * app/campaigns.js, app/admin.js), loaded the first time they open, through the small CRM interface at the end.
 * Every number and record comes from /api/crm/* and the client APIs on the server.
 */
(function () {
'use strict';
const SUPABASE_URL = 'https://sasbwgollyjpwegsbrty.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNhc2J3Z29sbHlqcHdlZ3NicnR5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4Mjg1MjEsImV4cCI6MjEwMTQwNDUyMX0.Ha6uDWqzC-T1Q49TE8WaqyjulPLntwt-2dSaknVtuKY';
const BACKEND = 'https://leadgen-backend-1-mgzc.onrender.com';
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';
// A password reset or invite link lands here with its token in the address (old welcome.html links are moved to /).
const AUTH_LINK = (location.hash.match(/type=(recovery|invite|signup)/) || [])[1] || null;
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ------------------------------------------------------------------ helpers
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SYM = { BDT: '৳', USD: '$', GBP: '£', EUR: '€', CAD: 'C$', AUD: 'A$', INR: '₹' };
const money = (v, c = 'BDT') => v == null ? '—' : (SYM[c] || c + ' ') + Number(v).toLocaleString(c === 'BDT' || c === 'INR' ? 'en-IN' : 'en-US', { maximumFractionDigits: 0 });
const lakh = v => '৳' + (v >= 1e7 ? (v / 1e7).toFixed(1) + 'Cr' : v >= 1e5 ? (v / 1e5).toFixed(1) + 'L' : Math.round(v).toLocaleString('en-IN'));
const num = n => Number(n || 0).toLocaleString('en-US');
const kfmt = n => n == null ? '—' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);
const pct = (a, b) => b ? Math.round(a / b * 100) : 0;
const initials = s => String(s || '?').replace(/^@/, '').split(/[\s._-]+/).filter(Boolean).slice(0, 2).map(x => x[0].toUpperCase()).join('') || '?';
const SRC_VAR = { website: '--s-web', seo: '--s-seo', ads_google: '--s-google', ads_meta: '--s-meta', social: '--s-social', email: '--s-email', influencer: '--s-inf', referral: '--s-ref', other: '--s-other' };
const DEPT_VAR = { website: '--s-web', seo: '--s-seo', marketing: '--s-meta', influencer: '--s-inf', other: '--s-ref' };
const STAGE_VAR = { new: '--dim', contacted: '--s-web', replied: '--s-email', meeting: '--s-meta', proposal: '--gold', won: '--ok', lost: '--bad' };
const CR_RING = { partner: '--ok', talking: '--gold', prospect: '--dim' };
const CR_LABEL = { partner: 'Worked with', talking: 'In talks', prospect: 'Prospect' };
const NICHE_VAR = ['--s-google', '--s-inf', '--s-social', '--s-web', '--s-email', '--s-seo', '--s-meta', '--s-ref'];
const nicheVar = n => NICHE_VAR[[...String(n || 'x')].reduce((a, c) => a + c.charCodeAt(0), 0) % NICHE_VAR.length];
const COUNTRY = { BD: 'Bangladesh', US: 'United States', GB: 'United Kingdom', CA: 'Canada', AU: 'Australia', IN: 'India', AE: 'UAE', SA: 'Saudi Arabia', MY: 'Malaysia', SG: 'Singapore' };
const cname = c => COUNTRY[c] || c || 'No country';
const startOfTomorrow = () => { const d = new Date(); d.setHours(24, 0, 0, 0); return d; };
function dueLabel(at) {
    if (!at) return '<span class="due" style="color:var(--dim)">—</span>';
    const d = new Date(at), t = new Date(); t.setHours(0, 0, 0, 0);
    const days = Math.floor((new Date(d).setHours(0, 0, 0, 0) - t) / 864e5);
    const txt = days < 0 ? `${-days} d overdue` : days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    return `<span class="due ${days < 0 ? 'over' : days === 0 ? 'today' : ''}">${txt}</span>`;
}
const ago = at => { const s = (Date.now() - new Date(at)) / 1000; return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + ' min ago' : s < 86400 ? Math.floor(s / 3600) + ' h ago' : s < 604800 ? Math.floor(s / 86400) + ' d ago' : new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };
const haversine = (a, b) => { const R = 6371, r = x => x * Math.PI / 180, dl = r(b.lat - a.lat), dg = r(b.lng - a.lng); const h = Math.sin(dl / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dg / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const ICONS = {
    overview: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>', leads: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M19 14.8c1.4.9 2.2 2.7 2.5 5.2"/>',
    pipeline: '<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="17" y="4" width="4" height="7" rx="1.5"/>', seq: '<path d="M4 6h10M4 12h7M4 18h12"/><path d="m17 9 3 3-3 3"/>',
    pin: '<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>', clients: '<path d="M4 20V8l8-4 8 4v12"/><path d="M9 20v-6h6v6"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>', mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>', note: '<path d="M5 4h10l4 4v12H5z"/><path d="M14 4v5h5M8 13h8M8 17h5"/>', reply: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 5 5v6"/>',
    stage: '<path d="M4 12h16M14 6l6 6-6 6"/>', wa: '<path d="M4 20l1.3-4A8 8 0 1 1 8 18.7z"/>', client: '<path d="M20 6 9 17l-5-5"/>', x: '<path d="M6 6l12 12M18 6 6 18"/>', plus: '<path d="M12 5v14M5 12h14"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>', seo: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.8-4.8M7.5 12l2-2 1.5 1.5L13.5 9"/>', mega: '<path d="M3 10v4h3l7 4V6L6 10z"/><path d="M16 9a4 4 0 0 1 0 6M19 6.5a8 8 0 0 1 0 11"/>', star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
    shield: '<path d="M12 3 4.5 6v6c0 4.5 3.2 7.8 7.5 9 4.3-1.2 7.5-4.5 7.5-9V6z"/><path d="m9 12 2 2 4-4"/>', search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>', task: '<path d="m5 12 5 5L20 7"/>', meet: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>', fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>', cash: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 9v.01M18 15v.01"/>', ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>', table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10"/>', up: '<path d="M12 16V4M6 10l6-6 6 6M4 20h16"/>',
    cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>', link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>', dot: '<circle cx="12" cy="12" r="3"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>', grip: '<path d="M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01" stroke-width="2.6"/>', copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>', trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>', edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
    keypad: '<circle cx="6" cy="5" r="1.2"/><circle cx="12" cy="5" r="1.2"/><circle cx="18" cy="5" r="1.2"/><circle cx="6" cy="11" r="1.2"/><circle cx="12" cy="11" r="1.2"/><circle cx="18" cy="11" r="1.2"/><circle cx="6" cy="17" r="1.2"/><circle cx="12" cy="17" r="1.2"/><circle cx="18" cy="17" r="1.2"/><circle cx="12" cy="22" r="1.2"/>',
    side: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 10l-2 2 2 2"/>', ban: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>', redo: '<path d="M20 8a8 8 0 1 0 1 6"/><path d="M20 3v5h-5"/>',
    tools: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L3 17.8V21h3.2l6.3-6.3a4 4 0 0 0 5.2-5.4l-2.5 2.5-2.3-.4-.4-2.3z"/>', lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>', out: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>', moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>'
};
const ic = k => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[k] || ''}</svg>`;
function toast(t, bad) { document.querySelectorAll('.toast').forEach(x => x.remove()); const el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); if (bad) el.style.background = 'var(--bad)'; el.textContent = t; document.body.appendChild(el); setTimeout(() => el.remove(), 3200); }

// ------------------------------------------------------------------ data
async function api(path, { method = 'GET', body } = {}) {
    const { data } = await sb.auth.getSession();
    if (!data.session) { signIn(); throw new Error('Signed out'); }
    const r = await fetch(BACKEND + path, { method, headers: { Authorization: 'Bearer ' + data.session.access_token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || `The server answered ${r.status}.`); e.status = r.status; e.data = j; throw e; }
    return j;
}
const st = { meta: null, leads: null, period: 30, trange: 'today', view: 'all', q: '', cat: '', ind: '', owner: '', out: '', sel: new Set(), leadMode: 'table',
    pCat: '', pInd: '', pOwner: '', pQ: '', hist: 'all', net: null, crOn: null, crStage: 'all', crQ: '', crCountry: 'all', picking: null, openId: null, cQ: '' };
const teamName = id => { const t = st.meta && st.meta.team.find(x => x.id === id); return t ? t.name : '—'; };
const srcOf = k => st.meta.sources.find(s => s.key === k) || { key: k, label: k };
const srcChip = k => { const s = srcOf(k); return `<span class="src" style="--c:var(${SRC_VAR[k] || '--s-other'})" title="${esc(s.path || s.label)}"><i></i><b>${esc(s.label)}</b></span>`; };
const stageChip = k => `<span class="stg" style="--c:var(${STAGE_VAR[k] || '--dim'})">${esc((st.meta.stages.find(s => s.key === k) || { label: k }).label)}</span>`;
const IND_VAR = ['--s-web', '--s-seo', '--s-google', '--s-meta', '--s-social', '--s-email', '--s-inf', '--s-ref'];
const indVar = n => IND_VAR[[...String(n || 'x').toLowerCase()].reduce((a, c) => a + c.charCodeAt(0), 0) % IND_VAR.length];
const indChip = n => n ? `<span class="ind" style="--c:var(${indVar(n)})">${esc(n)}</span>` : `<span class="ind none">No industry</span>`;
async function leads(force) { if (!st.leads || force) st.leads = (await api('/api/crm/leads')).leads; return st.leads; }
const isAdmin = () => st.meta && st.meta.me.role === 'admin';
/** Phase 93: the Dialer and Email campaigns open only for the owner and the people the owner unlocks them for (Admin → Team). */
const feat = k => isAdmin() || !!(st.meta && st.meta.features && st.meta.features[k]);
const FEAT_OF = { campaigns: 'campaigns', dialer: 'dialer' };
const FEAT_TEXT = { campaigns: ['Email campaigns are locked', 'The owner unlocks Email campaigns for you in Admin → Team.'], dialer: ['The Dialer is locked', 'The owner unlocks the Dialer for you in Admin → Team. You can still call your leads from Calls.'] };
const p90 = () => !!(st.meta && st.meta.p90);
const p91 = () => !!(st.meta && st.meta.p91);
/** Where a lead stands: a client, lost, being worked in the pipeline, or cold. Before the phase-90 SQL, any stage past New is the pipeline. */
const inPipe = l => p90() ? !!l.in_pipeline || !!l.client_id : l.stage !== 'new';
function leadState(l) { if (l.client_id || l.stage === 'won') return 'client'; if (l.stage === 'lost') return 'lost'; return inPipe(l) ? 'pipeline' : 'cold'; }
const STATE = { cold: ['Cold', '--dim'], pipeline: ['In pipeline', '--acc'], client: ['Client', '--ok'], lost: ['Lost', '--bad'] };
const stateChip = l => { const s = leadState(l); return `<span class="state ${s}"><i></i>${STATE[s][0]}</span>`; };
const telHref = p => 'tel:' + String(p || '').replace(/[^\d+]/g, '');
const webHref = w => /^https?:\/\//i.test(w) ? w : 'https://' + w;
const webShort = w => String(w || '').replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
const industries = () => { const set = new Map(); (st.meta.industries || []).forEach(i => set.set(i.toLowerCase(), i)); (st.leads || []).forEach(l => l.industry && !set.has(l.industry.toLowerCase()) && set.set(l.industry.toLowerCase(), l.industry)); return [...set.values()]; };

// ------------------------------------------------------------------ shell
const NAV = [
    ['overview', 'Overview', 'overview', 'Work'], ['leads', 'Leads', 'leads', 'Work'], ['pipeline', 'Pipeline', 'pipeline', 'Work'], ['calls', 'Calls', 'phone', 'Work'], ['campaigns', 'Email campaigns', 'seq', 'Work'],
    ['clients', 'Clients', 'clients', 'Business'], ['influencers', 'Influencers', 'pin', 'Business'], ['admin', 'Admin', 'shield', 'Owner'], ['dialer', 'Dialer', 'keypad', 'Phone']];
let route = 'overview', routeArg = '';
const navOf = r => r === 'client' ? 'clients' : r;
function shell() {
    const L = st.leads || [];
    const cold = L.filter(l => leadState(l) === 'cold').length, pipe = L.filter(l => leadState(l) === 'pipeline').length;
    const due = L.filter(l => l.next_step_at && new Date(l.next_step_at) < startOfTomorrow() && !['won', 'lost'].includes(l.stage)).length;
    const badge = k => k === 'overview' && due ? `<span class="ct hot" title="Follow-ups due">${due}</span>` : k === 'leads' && st.leads ? `<span class="ct">${num(cold)}</span>` : k === 'pipeline' && st.leads ? `<span class="ct">${num(pipe)}</span>`
        : k === 'dialer' ? `<span class="ct hot" data-phbadge ${window.ELPhone && ELPhone.unread() ? '' : 'hidden'}>${window.ELPhone ? ELPhone.unread() || '' : ''}</span>` : '';
    let grp = '';
    const mini = document.documentElement.dataset.rail === 'mini';
    $('#rail').innerHTML = `<div class="brand"><img class="logo" src="/icons/logo-mark.png" alt="" width="22" height="26"><span class="bname">EdgeLead</span>
        <button type="button" class="railbtn" id="railToggle" title="${mini ? 'Show the menu' : 'Fold the menu to icons'}" aria-label="${mini ? 'Show the menu' : 'Fold the menu to icons'}" aria-expanded="${!mini}">${ic('side')}</button></div>` + NAV.filter(n => n[0] !== 'admin' || isAdmin()).map(([k, l, i, g]) => {
        const head = g !== grp ? `<div class="grp">${g}</div>` : ''; grp = g;
        const on = navOf(route) === k;
        const lockd = FEAT_OF[k] && !feat(FEAT_OF[k]);
        return (k === 'dialer' ? toolsLink() : '') + head + `<a href="#${k}" class="${on ? 'on' : ''} ${lockd ? 'locked' : ''}" ${on ? 'aria-current="page"' : ''} title="${l}${lockd ? ' (locked)' : ''}" ${lockd ? `data-featlock="${k}"` : ''}>${ic(i)}<span class="lbl2">${l}</span>${lockd ? ic('lock').replace('class="ico"', 'class="ico lk"') : badge(k)}</a>`;
    }).join('') + (NAV.some(n => n[0] === 'dialer') ? '' : toolsLink()) +
        `<div class="foot"><div class="me" title="${esc(teamName(st.meta.me.id))}"><span class="ava">${initials(teamName(st.meta.me.id))}</span><div style="min-width:0"><b>${esc(teamName(st.meta.me.id))}</b><span>${isAdmin() ? 'Owner' : 'Team'}</span></div></div><button class="btn sm ghost" id="theme" type="button" title="Light / dark">${ic('moon')}<span class="lbl2">Light / dark</span></button><button class="btn sm ghost" id="signout" type="button" title="Sign out">${ic('out')}<span class="lbl2">Sign out</span></button></div>`;
    const tb = $('#toolsTop'); if (tb) { const t = toolsState(); tb.hidden = !t.show; tb.classList.toggle('locked', !t.open); tb.innerHTML = `${ic('tools')}<span>Tools</span>${t.open ? '' : ic('lock').replace('class="ico"', 'class="ico lk"')}`; tb.title = t.open ? 'Open the Tools' : 'Tools are locked'; }
    $('#tabbar').innerHTML = [['overview', 'Home', 'overview'], ['leads', 'Leads', 'leads'], ['pipeline', 'Pipeline', 'pipeline'], ['calls', 'Calls', 'phone'], ['more', 'More', 'menu']]
        .map(([k, l, i]) => k === 'more' ? `<button type="button" data-act="more" class="${['campaigns', 'dialer', 'clients', 'client', 'influencers', 'admin'].includes(route) ? 'on' : ''}">${ic(i)}${l}</button>` : `<a href="#${k}" class="${navOf(route) === k ? 'on' : ''}">${ic(i)}${l}</a>`).join('');
}

// ------------------------------------------------------------------ the Tools door (phase 89)
// The Tools live outside the CRM at /tools. The door shows for the owner and for anyone given a tool;
// it opens only once a tool they have is unlocked (Admin → Tools). The server checks both again.
function toolsState() {
    const list = (st.meta && st.meta.me && st.meta.me.tools) || [];
    return { show: isAdmin() || list.some(t => t.assigned), open: list.some(t => t.open) };
}
function toolsLink() {
    const t = toolsState(); if (!t.show) return '';
    return `<a href="/tools" class="tools-link" data-tools title="Tools">${ic('tools')}<span class="lbl2">Tools</span><span class="lock ${t.open ? 'open' : ''}">${ic(t.open ? 'unlock' : 'lock').replace('class="ico"', 'class="ico" style="width:12px;height:12px"')}${t.open ? 'Unlocked' : 'Locked'}</span></a>`;
}
function modalInfo(title, text) {
    $('#layer').innerHTML = `<div class="scrim" data-close></div><div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="mh"><h2 style="display:flex;align-items:center;gap:8px">${ic('lock')}${esc(title)}</h2></div>
      <div class="mb"><p class="sub" style="margin:0">${esc(text)}</p></div><div class="mf"><button class="btn" type="button" data-close>Close</button>${isAdmin() ? '<a class="btn pri" href="#admin/team" data-close>Open Admin → Team</a>' : ''}</div></div>`;
}
function toolsLocked() {
    $('#layer').innerHTML = `<div class="scrim" data-close></div><div class="modal" role="dialog" aria-modal="true" aria-label="Tools are locked"><div class="mh"><h2 style="display:flex;align-items:center;gap:8px">${ic('lock')}Tools are locked</h2></div>
      <div class="mb"><p class="sub" style="margin:0">${isAdmin() ? 'Unlock a tool in Admin → Tools. While a tool is locked nothing runs for it and no Apify credit is spent.' : 'The owner has given you Tools, but they are locked right now. Ask the owner to unlock them.'}</p></div>
      <div class="mf"><button class="btn" type="button" data-close>Close</button>${isAdmin() ? '<a class="btn pri" href="#admin/tools" data-close>Open Admin</a>' : ''}</div></div>`;
}

// ------------------------------------------------------------------ routing, and the parts that load when first opened
// The CRM's own pages are in this file. The client page, email campaigns and Admin load the first time they open,
// so opening the CRM stays fast: app/client.js, app/campaigns.js, app/admin.js.
const MODULES = { client: 'client', campaigns: 'campaigns', admin: 'admin' };
const loaded = {};
function need(name) {
    if (!loaded[name]) loaded[name] = new Promise((ok, no) => { const s = document.createElement('script'); s.src = '/app/' + name + '.js?v=90'; s.onload = ok; s.onerror = () => { delete loaded[name]; no(new Error('The ' + name + ' page could not load. Check the connection.')); }; document.head.appendChild(s); });
    return loaded[name];
}
const ROUTES = ['overview', 'leads', 'pipeline', 'campaigns', 'calls', 'dialer', 'clients', 'client', 'influencers', 'admin'];
let renderSeq = 0;
async function render() {
    const raw = window.EL_PHONE_ONLY ? 'dialer' : (location.hash || '#overview').slice(1).split('?')[0];
    const [r0, ...rest] = raw.split('/');
    route = { sequences: 'campaigns', settings: 'admin', phone: 'dialer' }[r0] || r0; routeArg = rest.join('/');   // #phone (old links, the voicemail email) is the Dialer
    if (!ROUTES.includes(route) || (route === 'admin' && !isAdmin())) { route = 'overview'; routeArg = ''; }
    if (route !== 'influencers' && route !== 'leads' && mapObj) { mapObj.remove(); mapObj = null; }
    if (route !== 'leads' && leadMap) { leadMap.remove(); leadMap = null; }
    shell();
    const v = $('#view'), seq = ++renderSeq;
    document.body.dataset.route = route;
    try {
        if (MODULES[route]) { if (!loaded[MODULES[route]]) v.innerHTML = '<div class="boot">Loading…</div>'; await need(MODULES[route]); }
        if (FEAT_OF[route] && !feat(FEAT_OF[route])) { const [h, d] = FEAT_TEXT[FEAT_OF[route]]; v.innerHTML = `<div class="lockedpage">${ic('lock')}<h2>${h}</h2><p>${d}</p><a class="btn pri" href="${window.EL_PHONE_ONLY ? '/' : ''}#${route === 'dialer' ? 'calls/home' : 'leads'}">${route === 'dialer' ? 'Open Calls' : 'Open Leads'}</a></div>`; shell(); return; }
        const fn = { overview: vOverview, leads: vLeads, pipeline: vPipeline, clients: vClients, influencers: vInfluencers, calls: async arg => window.ELPhone ? ELPhone.view('calls', arg) : '', dialer: async () => window.ELPhone ? ELPhone.view('dialer') : '' }[route] || CRM.views[route];
        const html = await fn(routeArg);
        if (seq !== renderSeq) return;   // a newer page was asked for while this one loaded
        v.innerHTML = html; shell();
        if (route === 'influencers') mapInit();
        if (route === 'leads' && st.leadMode === 'map') leadMapInit();
        if ((route === 'calls' || route === 'dialer') && window.ELPhone) ELPhone.mounted();
        if (CRM.mounted[route]) CRM.mounted[route](routeArg);
    } catch (e) { if (seq === renderSeq) v.innerHTML = `<div class="empty err">Could not load this page: ${esc(e.message)} <button class="btn sm" type="button" onclick="location.reload()">Try again</button></div>`; }
}

// ------------------------------------------------------------------ overview: the performance half
// ------------------------------------------------------------------ overview
const sparkSvg = (arr, c) => { const w = 120, h = 26, mx = Math.max(1, ...arr), pts = arr.map((v, i) => [i * w / Math.max(1, arr.length - 1), h - 3 - v / mx * (h - 6)]);
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(''); const e = pts[pts.length - 1];
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}L${w} ${h}L0 ${h}Z" fill="var(${c})" opacity=".12"/><path d="${d}" fill="none" stroke="var(${c})" stroke-width="1.6" vector-effect="non-scaling-stroke"/><circle cx="${e[0]}" cy="${e[1]}" r="2.2" fill="var(${c})"/></svg>`; };
async function perfHtml() {
    const [o] = await Promise.all([api('/api/crm/overview?days=' + st.period), leads()]);
    const T = o.totals;
    const row = (d, cls, cvar) => `<tr class="${cls} go" data-dept="${d.key}"><td><span class="nm" style="--c:var(${cvar})"><i></i>${esc(d.label)}</span></td><td>${num(d.leads)}</td><td>${num(d.sent)}</td><td>${num(d.calls)}</td><td>${num(d.replies)}</td>
        <td><span class="rate" style="--v:${Math.min(100, pct(d.replies, d.sent) * 4)}%;--c:var(${cvar})"><i></i>${pct(d.replies, d.sent)}%</span></td><td>${num(d.meetings)}</td><td>${num(d.won)}</td><td>${lakh(d.pipeline)}</td></tr>`;
    const strip = [['New leads', num(T.leads), '--ink', o.series.leads], ['Cold emails sent', num(T.sent), '--s-web', o.series.sent], ['Calls', num(T.calls), '--gold', o.series.calls],
                   ['Replies', num(T.replies), '--ok', o.series.replies], ['Meetings', num(T.meetings), '--s-meta', o.series.meetings], ['Won', num(T.won), '--ok', o.series.won]];
    const I = o.influencers;
    const JOB = { website: ['--s-web', 'globe'], seo: ['--s-seo', 'seo'], marketing: ['--s-meta', 'mega'], influencer: ['--s-inf', 'star'] };
    const J = o.jobs || [], jAll = J.reduce((a, j) => a + j.value, 0), jP = J.reduce((a, j) => a + j.periodValue, 0), jPc = J.reduce((a, j) => a + j.periodCount, 0), jC = J.reduce((a, j) => a + j.count, 0);
    const jobs = J.length ? `<section class="jobs">
        <div class="card jhero"><small class="lbl">Revenue won · ${st.period === 90 ? 'this quarter' : 'last ' + st.period + ' days'}</small><b class="big">${lakh(jP)}</b>
          <em>${num(jPc)} new job${jPc === 1 ? '' : 's'} · ${lakh(jAll)} from ${num(jC)} job${jC === 1 ? '' : 's'} all time</em>
          <div class="stack" role="img" aria-label="Revenue by job type">${J.filter(j => j.value).map(j => `<i style="--c:var(${JOB[j.key][0]});flex:${j.value}" title="${esc(j.label)}: ${lakh(j.value)}"></i>`).join('') || '<i style="flex:1;--c:var(--line2)"></i>'}</div>
          <div class="slegend">${J.map(j => `<span style="--c:var(${JOB[j.key][0]})"><i></i>${esc(j.label)}<b>${jAll ? pct(j.value, jAll) : 0}%</b></span>`).join('')}</div></div>
        ${J.map(j => `<div class="card job" style="--c:var(${JOB[j.key][0]})"><div class="jh"><span class="ji">${ic(JOB[j.key][1])}</span>${esc(j.label)}</div>
          <b class="jn">${num(j.count)}</b><small>${j.count === 1 ? 'job' : 'jobs'} won · all time</small>
          <div class="jv"><span>${lakh(j.value)}</span>${j.periodCount ? `<em>+${num(j.periodCount)} · ${lakh(j.periodValue)} this period</em>` : '<em class="z">none this period</em>'}</div>
          <i class="jbar"><i style="width:${jAll ? Math.max(3, pct(j.value, jAll)) : 0}%"></i></i></div>`).join('')}
      </section>` : '';
    return `<div class="sechead"><h2>Performance</h2><span>${st.period === 90 ? 'This quarter' : 'Last ' + st.period + ' days'}</span><div class="sp"></div>
        <div class="period" role="group" aria-label="Period">${[[7, '7 days'], [30, '30 days'], [90, 'Quarter']].map(([v, t]) => `<button type="button" data-period="${v}" class="${st.period === v ? 'on' : ''}">${t}</button>`).join('')}</div></div>
      ${jobs}
      <section class="card strip">${strip.map(([l, v, c, s]) => `<div class="m"><small>${l}</small><b>${v}</b>${l === 'Won' ? `<em>${lakh(T.wonValue)} signed</em>` : '<em style="color:var(--dim)">' + (st.period === 90 ? 'this quarter' : 'last ' + st.period + ' days') + '</em>'}${sparkSvg(s, c)}</div>`).join('')}</section>
      <section class="card"><div class="card-h"><h2>By department</h2><span>Click a row to see its leads</span></div><div class="tablewrap"><table class="dept"><thead><tr><th>Department</th><th>Leads</th><th>Emails sent</th><th>Calls</th><th>Replies</th><th>Reply rate</th><th>Meetings</th><th>Won</th><th>Open pipeline</th></tr></thead><tbody>
        ${o.departments.map(d => row(d, 'parent', DEPT_VAR[d.key]) + d.children.map(c => row(c, 'child', SRC_VAR[c.key])).join('')).join('')}</tbody>
        <tfoot><tr><td>All departments</td><td>${num(T.leads)}</td><td>${num(T.sent)}</td><td>${num(T.calls)}</td><td>${num(T.replies)}</td><td>${pct(T.replies, T.sent)}%</td><td>${num(T.meetings)}</td><td>${num(T.won)}</td><td>${lakh(T.pipeline)}</td></tr></tfoot></table></div></section>
      <section class="card" style="margin-top:16px"><div class="card-h"><h2>Influencer network</h2><a class="btn sm ghost" href="#influencers">Open the map</a></div>
        <div class="infl"><div><b>${num(I.total)}</b><small>creators in the network</small></div><div><b>${num(I.partners)}</b><small>worked with us</small></div><div><b>${num(I.posts)}</b><small>posts for clients this period</small></div><div><b>${kfmt(I.views)}</b><small>views on those posts</small></div></div></section>
      <div class="cols3">
        <section class="card"><div class="card-h"><h2>Up next</h2><span>${o.upNext.length ? 'Soonest first' : ''}</span></div><div class="list">${o.upNext.length ? o.upNext.map(l => `<div class="row" data-open="${l.id}"><span class="kind">${ic(/call|meet/i.test(l.next_step || '') ? 'phone' : 'mail')}</span><div class="t"><b>${esc(l.next_step || 'Follow up')}</b><span>${esc(l.full_name)}${l.company ? ' · ' + esc(l.company) : ''}</span></div>${dueLabel(l.next_step_at)}</div>`).join('') : '<div class="empty">Nothing scheduled. Add a next step on a lead and it appears here.</div>'}</div></section>
        <section class="card"><div class="card-h"><h2>Funnel</h2><span>Leads created this period</span></div><div class="funnel">${o.funnel.map(([l, v], i) => `<div><span>${l}</span><em><i style="--v:${o.funnel[0][1] ? Math.max(2, pct(v, o.funnel[0][1])) : 0}%;--o:${1 - i * .12}"></i></em><b>${num(v)}<small>${i ? pct(v, o.funnel[i - 1][1]) + '%' : ''}</small></b></div>`).join('')}</div></section>
        <section class="card"><div class="card-h"><h2>Team</h2><span>This period</span></div><div class="tablewrap"><table class="dept team" style="min-width:0"><thead><tr><th>Person</th><th>Emails</th><th>Calls</th><th>Replies</th><th>Won</th></tr></thead><tbody>
          ${st.meta.team.map(m => { const t = o.team[m.id] || {}; return `<tr><td><span class="nm"><span class="ava">${initials(m.name)}</span>${esc(m.name)}</span></td><td>${num(t.sent)}</td><td>${num(t.calls)}</td><td>${num(t.replies)}</td><td>${num(t.won)}</td></tr>`; }).join('')}</tbody></table></div></section>
      </div>`;
}
// ------------------------------------------------------------------ overview: today first, then how the business is doing
const GOAL = { calls: ['Calls', 'phone', '--s-web'], emails: ['Emails', 'mail', '--s-email'], prospects: ['Prospects found', 'search', '--s-meta'], followups: ['Follow-ups done', 'task', '--ok'] };
const ring = (pct, c) => { const r = 30, C = 2 * Math.PI * r; return `<svg class="gring" viewBox="0 0 72 72" aria-hidden="true"><circle cx="36" cy="36" r="${r}" class="trk"/><circle cx="36" cy="36" r="${r}" class="val" style="stroke:var(${c});stroke-dasharray:${(pct / 100 * C).toFixed(1)} ${C.toFixed(1)}"/></svg>`; };
const PRIO = { highest: 'Highest', high: 'High', medium: '', low: 'Low', lowest: 'Lowest' };
const dayLabel = d => { if (!d) return ''; const t = new Date(); t.setHours(0, 0, 0, 0); const x = new Date(d + 'T00:00:00'); const n = Math.round((x - t) / 864e5); return n < 0 ? `${-n} d overdue` : n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : x.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }); };
function todayHtml(T) {
    const tasks = T.clientTasks || [], calls = T.crmTasks || [];
    const over = tasks.filter(t => t.overdue), due = tasks.filter(t => !t.overdue);
    const row = t => `<a class="trow" href="#client/${t.client.id}/tasks/${t.id}"><span class="tdot ${t.status}"></span><div class="t"><b>${esc(t.title)}</b><span><span class="cl">${esc(t.client.name)}</span>${(t.labels || []).slice(0, 2).map(l => `<span class="lab">${esc(l)}</span>`).join('')}</span></div>
        ${PRIO[t.priority] ? `<span class="prio ${t.priority}">${PRIO[t.priority]}</span>` : ''}<span class="due ${t.overdue ? 'over' : dayLabel(t.due_date) === 'Today' ? 'today' : ''}">${dayLabel(t.due_date)}</span>${t.assignee_user_id ? `<span class="ava" title="${esc(teamName(t.assignee_user_id))}">${initials(teamName(t.assignee_user_id))}</span>` : t.assigned_to_client ? '<span class="ava cli" title="The client">C</span>' : '<span class="ava nobody"></span>'}</a>`;
    const callRow = t => `<div class="trow call"><span class="kind">${ic(t.kind === 'call' ? 'phone' : 'task')}</span><div class="t"><b>${esc(t.title)}</b><span>${t.lead ? esc([t.lead.full_name, t.lead.company].filter(Boolean).join(' · ')) : ''}</span></div>${dueLabel(t.due_at)}
        ${t.lead && t.lead.phone && t.kind === 'call' ? `<button class="btn sm" type="button" data-callnow="${esc(t.lead.phone)}" data-name="${esc(t.lead.company || t.lead.full_name || '')}" data-lead="${t.lead_id}">${ic('phone')}Call</button>` : ''}${t.lead ? `<button class="btn sm ghost" type="button" data-open="${t.lead_id}">Open</button>` : ''}<button class="btn sm ghost" type="button" data-taskdone2="${t.id}" title="Mark done">${ic('task')}</button></div>`;
    const G = T.goals || [], met = G.filter(g => g.met).length;
    return `<div class="today">
      <section class="card tcard"><div class="card-h"><div><h2>Client work</h2><span>${tasks.length ? `${tasks.length} task${tasks.length === 1 ? '' : 's'} due${over.length ? ` · <b class="bad">${over.length} overdue</b>` : ''}` : 'Nothing due'}</span></div>
          <div class="period sm" role="group" aria-label="Range">${[['today', 'Today'], ['7d', '7 days'], ['month', 'This month']].map(([k, l]) => `<button type="button" data-trange="${k}" class="${st.trange === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
        <div class="tlist">${over.length ? `<div class="tgrp bad">Overdue</div>${over.map(row).join('')}` : ''}${due.length ? `<div class="tgrp">${st.trange === 'today' ? 'Due today' : st.trange === '7d' ? 'Due in the next 7 days' : 'Due this month'}</div>${due.map(row).join('')}` : ''}
          ${tasks.length ? '' : `<div class="empty sm">${ic('task')}<b>All clear.</b> No client task is due ${st.trange === 'today' ? 'today' : st.trange === '7d' ? 'this week' : 'this month'}. Tasks with a due date on any client's board show here.</div>`}</div>
        ${calls.length ? `<div class="card-h sub2"><h2>Calls and follow-ups</h2><span>${calls.length} from leads and campaigns</span></div><div class="tlist">${calls.slice(0, 8).map(callRow).join('')}</div>` : ''}</section>
      <section class="card gcard"><div class="card-h"><div><h2>Outreach today</h2><span>${met} of ${G.length} goals met · ${esc(T.timezone || '')}</span></div>${isAdmin() ? '<a class="btn sm ghost" href="#admin/goals">Set goals</a>' : ''}</div>
        <div class="goals">${G.map(g => `<div class="goal ${g.met ? 'met' : ''}">${ring(g.pct, GOAL[g.key][2])}<div class="gn"><b>${num(g.done)}</b><small>of ${num(g.target)}</small></div><span>${GOAL[g.key][0]}</span></div>`).join('')}</div>
        <div class="gteam">${(T.team || []).filter(p => p.calls + p.emails + p.prospects + p.followups || st.meta.team.some(m => m.id === p.id)).map(p => `<div><span class="ava">${initials(p.name)}</span><b>${esc(p.name)}</b><span title="Calls">${ic('phone')}${p.calls}</span><span title="Emails">${ic('mail')}${p.emails}</span><span title="Prospects">${ic('search')}${p.prospects}</span><span title="Follow-ups">${ic('task')}${p.followups}</span></div>`).join('')}</div></section>
    </div>`;
}
async function vOverview() {
    const [T, perf] = await Promise.all([api('/api/crm/today?range=' + st.trange).catch(e => ({ error: e.message })), perfHtml()]);
    const hr = new Date().getHours();
    return `<div class="head"><div><p class="greet">Good ${hr < 12 ? 'morning' : hr < 17 ? 'afternoon' : 'evening'}, ${esc(teamName(st.meta.me.id).split(' ')[0])}.</p>
        <p class="sub">${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}${T.total ? ` · ${num(T.total.calls)} calls and ${num(T.total.emails)} emails so far today` : ''}</p></div></div>
      ${p90() ? '' : `<div class="banner">${ic('shield')}<div><b>One step left for this release:</b> run <span class="mono">sql/schema-phase90.sql</span> in Supabase. Until then, industries, the pipeline switch, the leads map and email campaigns wait.</div></div>`}
      ${T.error ? `<div class="empty err">Today could not load: ${esc(T.error)}</div>` : todayHtml(T)}
      ${perf}`;
}

// ------------------------------------------------------------------ leads: every lead, cold or not, with what you need to reach them
const LVIEWS = [['all', 'All', () => true], ['cold', 'Cold', l => leadState(l) === 'cold'], ['pipeline', 'In pipeline', l => leadState(l) === 'pipeline'], ['client', 'Clients', l => leadState(l) === 'client'],
    ['lost', 'Lost', l => leadState(l) === 'lost'], ['mine', 'Mine', l => l.owner_id === st.meta.me.id], ['due', 'Follow-up due', l => l.next_step_at && new Date(l.next_step_at) < startOfTomorrow() && !['won', 'lost'].includes(l.stage)]];
function leadFilter(l, { skip } = {}) {
    const q = st.q.toLowerCase();
    return (skip === 'view' || (LVIEWS.find(x => x[0] === st.view) || LVIEWS[0])[2](l))
        && (skip === 'cat' || !st.cat || l.source === st.cat)
        && (skip === 'ind' || !st.ind || (st.ind === '-' ? !l.industry : String(l.industry || '').toLowerCase() === st.ind.toLowerCase()))
        && (!st.owner || l.owner_id === st.owner)
        && (skip === 'out' || !st.out || outMatch(l, st.out))
        && (!q || [l.full_name, l.company, l.email, l.phone, l.city, l.website, l.industry].join(' ').toLowerCase().includes(q));
}
// Phase 91: who was called and emailed (the counts are kept on the lead by the server).
const OUTREACH = [['not_called', 'Never called', l => !l.calls_count], ['called', 'Called', l => l.calls_count > 0], ['emailed', 'Emailed', l => l.emails_count > 0], ['not_emailed', 'Never emailed', l => !l.emails_count],
    ['both', 'Called and emailed', l => l.calls_count > 0 && l.emails_count > 0], ['none', 'Neither called nor emailed', l => !l.calls_count && !l.emails_count],
    ['due', 'Due a call now', l => l.callback_at && new Date(l.callback_at) <= new Date() && !['closed', 'in_play'].includes(l.call_status)],
    ['campaign', 'In an email campaign now', l => !!l.campaign], ['no_campaign', 'Not in an email campaign', l => !l.campaign],
    ['resting', 'Resting: back in the call list later', l => l.call_status === 'closed' && l.callback_at && new Date(l.callback_at) > new Date()],
    ['dnc', 'Do not call', l => (l.tags || []).includes('Do not call')], ['wrong', 'Wrong number', l => (l.tags || []).includes('Wrong number')]];
const CALL_ST = [['tried', 'Tried, no conversation'], ['spoke', 'Spoke'], ['callback', 'Call back set'], ['in_play', 'In play'], ['closed', 'Closed']];
function outMatch(l, k) { const o = OUTREACH.find(x => x[0] === k); if (o) return o[2](l); if (k.startsWith('st:')) return (l.call_status || 'not_called') === k.slice(3); return true; }
function outCell(l) {
    const call = l.calls_count ? `<span class="oc y" title="${esc(l.last_call_outcome || '')}">${ic('phone')}<b>${l.calls_count}×</b>${l.last_call_outcome ? `<em>${esc(l.last_call_outcome)}</em>` : ''}${l.last_call_at ? `<small>${ago(l.last_call_at)}</small>` : ''}</span>` : `<span class="oc">${ic('phone')}<em>Not called</em></span>`;
    const mail = l.emails_count ? `<span class="oc y">${ic('mail')}<b>${l.emails_count}×</b>${l.last_email_at ? `<small>${ago(l.last_email_at)}</small>` : ''}</span>` : `<span class="oc">${ic('mail')}<em>Not emailed</em></span>`;
    const camp = l.campaign ? `<span class="oc camp" title="In the email campaign ${esc(l.campaign.name)}">${ic('seq')}<em>${esc(l.campaign.name)}</em>${l.campaign.next_at ? `<small>next ${new Date(l.campaign.next_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</small>` : ''}</span>` : '';
    const flag = (l.tags || []).includes('Do not call') ? '<span class="flag bad">Do not call</span>' : (l.tags || []).includes('Wrong number') ? '<span class="flag warn">Wrong number</span>' : '';
    return `<div class="outr">${call}${mail}${camp}${flag}</div>`;
}
const countBy = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
function contactCell(l) {
    // Shown, not worked: calls and emails start from the pipeline. Here a click copies the number or address.
    const parts = [l.phone ? `<span class="pn"><span data-copy="${esc(l.phone)}" title="Copy ${esc(l.phone)}">${ic('phone')}${esc(l.phone)}</span><button type="button" class="cpb" data-copy="${esc(l.phone)}" title="Copy the number" aria-label="Copy ${esc(l.phone)}">${ic('copy')}</button></span>` : '',
        l.email ? `<span data-copy="${esc(l.email)}" title="Copy ${esc(l.email)}">${ic('mail')}${esc(l.email)}</span>` : '',
        l.website ? `<a href="${esc(webHref(l.website))}" target="_blank" rel="noopener" title="${esc(l.website)}">${ic('globe')}${esc(webShort(l.website))}</a>` : ''].filter(Boolean);
    return parts.length ? `<div class="contact">${parts.join('')}</div>` : '<span class="dim">No contact yet</span>';
}
async function vLeads() {
    await leads();
    const all = st.leads, rows = all.filter(l => leadFilter(l));
    const byInd = countBy(all.filter(l => leadFilter(l, { skip: 'ind' })), l => l.industry || '-');
    const byCat = countBy(all.filter(l => leadFilter(l, { skip: 'cat' })), l => l.source);
    const inds = Object.entries(byInd).sort((a, b) => b[1] - a[1]);
    const states = countBy(all, leadState);
    const filtered = st.cat || st.ind || st.owner || st.q || st.out;
    const forOut = p91() ? all.filter(l => leadFilter(l, { skip: 'out' })) : [];
    const byOut = Object.fromEntries([...OUTREACH.map(([k, , f]) => [k, forOut.filter(f).length]), ...CALL_ST.map(([k]) => ['st:' + k, forOut.filter(l => (l.call_status || 'not_called') === k).length])]);
    const tableHtml = rows.length ? `<div class="card tablewrap"><table class="ltbl"><thead><tr><th style="width:40px"><input type="checkbox" class="chk" id="selall" aria-label="Select all shown"></th><th>Lead</th><th>Industry</th><th>Contact</th>${p91() ? '<th>Called · emailed</th>' : ''}<th>Location</th><th>Category</th><th>Status</th><th>Owner</th><th>Last touch</th></tr></thead><tbody>
        ${rows.slice(0, 500).map(l => `<tr data-open="${l.id}" class="${st.sel.has(l.id) ? 'sel' : ''}"><td class="c-chk"><input type="checkbox" class="chk" data-sel="${l.id}" ${st.sel.has(l.id) ? 'checked' : ''} aria-label="Select ${esc(l.full_name)}"></td>
          <td class="c-who who"><b>${esc(l.company || l.full_name)}</b><span>${esc(l.company ? (l.full_name && l.full_name !== '-' ? l.full_name : '') : (l.title || ''))}</span></td>
          <td class="c-ind">${indChip(l.industry)}</td><td class="c-contact">${contactCell(l)}</td>${p91() ? `<td class="c-out">${outCell(l)}</td>` : ''}
          <td class="c-loc">${esc([l.city, l.country].filter(Boolean).join(', ') || '—')}</td><td class="c-src">${srcChip(l.source)}</td>
          <td class="c-state">${stateChip(l)}${inPipe(l) && !['won', 'lost'].includes(l.stage) ? `<small>${esc((st.meta.stages.find(s => s.key === l.stage) || {}).label || '')}</small>` : l.stage === 'lost' && l.lost_reason ? `<small title="${esc(l.lost_reason)}">${esc(l.lost_reason)}</small>` : ''}</td>
          <td class="c-owner"><span class="ava" title="${esc(teamName(l.owner_id))}">${initials(teamName(l.owner_id))}</span></td><td class="c-last">${l.last_activity_at ? ago(l.last_activity_at) : '<span class="dim">Never</span>'}</td></tr>`).join('')}
        </tbody></table>${rows.length > 500 ? `<div class="empty sm">Showing 500 of ${num(rows.length)}. Narrow the filters to see the rest.</div>` : ''}</div>`
        : `<div class="card"><div class="empty">${all.length ? 'No lead matches these filters.' : 'No leads yet. Add one with New lead, import a CSV, or find them with the Tools.'}${filtered ? ' <button class="btn sm" type="button" data-act="clearf">Clear filters</button>' : ''}</div></div>`;
    return `<div class="head"><div><h1>Leads</h1><p class="sub">${num(all.length)} leads · ${num(states.cold || 0)} cold · ${num(states.pipeline || 0)} in the pipeline · ${num(states.client || 0)} clients. Work the good ones from the pipeline.</p></div><div class="sp"></div>
        <div class="seg" role="group" aria-label="View"><button type="button" data-lmode="table" class="${st.leadMode === 'table' ? 'on' : ''}">${ic('table')}Table</button><button type="button" data-lmode="map" class="${st.leadMode === 'map' ? 'on' : ''}">${ic('pin')}Map</button></div>
        <button class="btn" type="button" data-act="import">${ic('up')}Import CSV</button><button class="btn" type="button" data-act="export" title="The leads these filters show, as a CSV file">${ic('up').replace('class="ico"', 'class="ico" style="transform:rotate(180deg)"')}Export</button></div>
      <div class="views" role="tablist">${LVIEWS.map(([k, l, fn]) => `<button type="button" role="tab" aria-selected="${st.view === k}" class="${st.view === k ? 'on' : ''}" data-view="${k}">${l}<span class="c">${num(all.filter(x => fn(x) && leadFilter(x, { skip: 'view' })).length)}</span></button>`).join('')}</div>
      <div class="filters"><div class="searchin">${ic('search')}<input id="lq" type="search" placeholder="Name, business, phone, email, website" value="${esc(st.q)}" aria-label="Search leads"></div>
        <select id="fcat" aria-label="Category"><option value="">Every category</option>${st.meta.sources.map(s => `<option value="${s.key}" ${st.cat === s.key ? 'selected' : ''}>${esc(s.path || s.label)} · ${num(byCat[s.key] || 0)}</option>`).join('')}</select>
        <select id="find" aria-label="Industry"><option value="">Every industry</option>${inds.map(([k, n]) => `<option value="${esc(k)}" ${st.ind.toLowerCase() === k.toLowerCase() ? 'selected' : ''}>${k === '-' ? 'No industry yet' : esc(k)} · ${num(n)}</option>`).join('')}</select>
        <select id="fown" aria-label="Owner"><option value="">Everyone's</option>${st.meta.team.map(m => `<option value="${m.id}" ${st.owner === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
        ${p91() ? `<select id="fout" aria-label="Called or emailed"><option value="">Called or not, emailed or not</option><optgroup label="Outreach">${OUTREACH.map(([k, l]) => `<option value="${k}" ${st.out === k ? 'selected' : ''}>${l} · ${num(byOut[k] || 0)}</option>`).join('')}</optgroup>
          <optgroup label="In the dialer">${CALL_ST.map(([k, l]) => `<option value="st:${k}" ${st.out === 'st:' + k ? 'selected' : ''}>${l} · ${num(byOut['st:' + k] || 0)}</option>`).join('')}</optgroup></select>` : ''}
        ${filtered ? '<button class="btn ghost sm" type="button" data-act="clearf">Clear</button>' : ''}</div>
      ${inds.length > 1 ? `<div class="facets" aria-label="Industries">${inds.slice(0, 14).map(([k, n]) => `<button type="button" data-ind="${esc(k)}" class="${st.ind.toLowerCase() === k.toLowerCase() ? 'on' : ''}" style="--c:var(${k === '-' ? '--dim' : indVar(k)})"><i></i>${k === '-' ? 'No industry' : esc(k)}<b>${num(n)}</b></button>`).join('')}</div>` : ''}
      ${st.leadMode === 'map' ? leadMapHtml(rows) : tableHtml}
      ${st.sel.size ? bulkBar() : ''}`;
}
function bulkBar() {
    return `<div class="bulk" role="region" aria-label="Selected leads"><span><b>${st.sel.size}</b> selected</span>
        ${p90() ? `<button class="btn sm pri" type="button" data-act="bulkpipe">${ic('pipeline')}Add to pipeline</button>` : ''}
        ${p90() ? `<select class="btn sm" data-bulk="industry" aria-label="Set industry"><option value="">Industry…</option>${industries().map(i => `<option>${esc(i)}</option>`).join('')}</select>` : ''}
        <select class="btn sm" data-bulk="source" aria-label="Set category"><option value="">Category…</option>${st.meta.sources.map(s => `<option value="${s.key}">${esc(s.path || s.label)}</option>`).join('')}</select>
        <select class="btn sm" data-bulk="owner_id" aria-label="Assign to"><option value="">Assign to…</option>${st.meta.team.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select>
        <select class="btn sm" data-bulk="stage" aria-label="Move to stage"><option value="">Stage…</option>${st.meta.stages.filter(s2 => s2.key !== 'won').map(s2 => `<option value="${s2.key}">${esc(s2.label)}</option>`).join('')}</select>
        ${p90() && feat('campaigns') ? `<button class="btn sm" type="button" data-act="bulkcamp">${ic('seq')}Add to a campaign</button>` : ''}
        ${p91() ? `<button class="btn sm" type="button" data-act="bulkreopen" title="Due now in Calls; not for do-not-call or wrong numbers">${ic('redo')}Back to the call list</button>` : ''}
        ${isAdmin() ? `<button class="btn sm ghost danger" type="button" data-act="bulkdel">${ic('trash')}Delete</button>` : ''}
        <button class="btn sm ghost" type="button" data-act="clearsel">Clear</button></div>`;
}

// ------------------------------------------------------------------ the leads map: where our data is, and how warm it is
let leadMap = null;
function leadMapHtml(rows) {
    const placed = rows.filter(l => l.lat != null), states = countBy(placed, leadState), missing = rows.length - placed.length;
    return `<div class="lmap"><section class="card mapcard"><div class="map" id="lmap" aria-label="Map of leads"></div>
        <div class="maplegend">${['client', 'pipeline', 'cold', 'lost'].map(s => `<span><i class="f" style="--c:var(${STATE[s][1]})"></i>${STATE[s][0]} <b>${num(states[s] || 0)}</b></span>`).join('')}</div>
        <div class="maptools"><button class="btn sm" type="button" data-act="lfit">${ic('fit')}Fit</button></div></section>
      <aside class="card lmside"><div class="card-h"><h2>On the map</h2><span>${num(placed.length)} of ${num(rows.length)}</span></div>
        <div class="lmstats">${['client', 'pipeline', 'cold', 'lost'].map(s => `<div style="--c:var(${STATE[s][1]})"><i></i><span>${STATE[s][0]}</span><b>${num(countBy(rows, leadState)[s] || 0)}</b></div>`).join('')}</div>
        ${!p90() ? '<p class="note" style="margin:0 16px 16px">The map needs the phase-90 SQL. Run it once in Supabase.</p>'
          : missing ? `<p class="note" style="margin:0 16px 12px">${num(missing)} lead${missing === 1 ? ' has' : 's have'} no place yet. A place comes from the lead's city; new leads are placed on their own within a minute.</p>${isAdmin() ? '<div style="padding:0 16px 16px"><button class="btn sm" type="button" data-act="geocode">Place them now</button></div>' : ''}` : ''}
        <div class="lmtop"><span class="lbl">Busiest places</span>${Object.entries(countBy(rows.filter(l => l.city), l => l.city)).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c, n]) => `<div><span>${esc(c)}</span><b>${n}</b></div>`).join('') || '<div class="dim">No cities yet.</div>'}</div></aside></div>`;
}
function leadMapInit() {
    const el = $('#lmap'); if (!el) return;
    if (!window.maplibregl) { loadMapLib().then(() => route === 'leads' && st.leadMode === 'map' && leadMapInit(), () => { el.innerHTML = '<div class="empty">The map could not load. Check the connection and refresh.</div>'; }); return; }
    if (leadMap) { leadMap.remove(); leadMap = null; }
    const rows = st.leads.filter(l => leadFilter(l) && l.lat != null);
    const css = getComputedStyle(document.documentElement), col = s => css.getPropertyValue(STATE[s][1]).trim() || '#888';
    leadMap = new maplibregl.Map({ container: el, style: MAP_STYLE, center: [-95.37, 29.76], zoom: 8, attributionControl: { compact: true }, cooperativeGestures: matchMedia('(pointer: coarse)').matches });
    leadMap.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    leadMap.on('load', () => {
        leadMap.addSource('leads', { type: 'geojson', cluster: true, clusterRadius: 44, clusterMaxZoom: 13,
            data: { type: 'FeatureCollection', features: rows.map(l => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [l.lng, l.lat] }, properties: { id: l.id, s: leadState(l), n: l.company || l.full_name } })) } });
        leadMap.addLayer({ id: 'cl', type: 'circle', source: 'leads', filter: ['has', 'point_count'], paint: { 'circle-color': col('pipeline'), 'circle-opacity': .9, 'circle-stroke-width': 4, 'circle-stroke-color': 'rgba(61,90,254,.22)', 'circle-radius': ['step', ['get', 'point_count'], 15, 10, 19, 30, 24, 100, 30] } });
        // The count uses a font the base map already loads: a font it does not have would stop the whole layer drawing.
        const styleFont = ((leadMap.getStyle().layers || []).find(x => x.layout && Array.isArray(x.layout['text-font'])) || { layout: {} }).layout['text-font'];
        if (styleFont) leadMap.addLayer({ id: 'cln', type: 'symbol', source: 'leads', filter: ['has', 'point_count'], layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 12, 'text-font': styleFont, 'text-allow-overlap': true }, paint: { 'text-color': '#fff' } });
        leadMap.addLayer({ id: 'pt', type: 'circle', source: 'leads', filter: ['!', ['has', 'point_count']], paint: { 'circle-radius': 7, 'circle-stroke-width': 2, 'circle-stroke-color': '#fff',
            'circle-color': ['match', ['get', 's'], 'client', col('client'), 'pipeline', col('pipeline'), 'lost', col('lost'), col('cold')] } });
        leadMap.on('click', 'cl', e => { const f = e.features[0]; leadMap.getSource('leads').getClusterExpansionZoom(f.properties.cluster_id).then(z => leadMap.easeTo({ center: f.geometry.coordinates, zoom: z })); });
        leadMap.on('click', 'pt', e => openLead(e.features[0].properties.id));
        const pop = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10 });
        leadMap.on('mouseenter', 'pt', e => { leadMap.getCanvas().style.cursor = 'pointer'; const p = e.features[0].properties; pop.setLngLat(e.features[0].geometry.coordinates).setHTML(`<b>${esc(p.n)}</b><br><small>${STATE[p.s][0]}</small>`).addTo(leadMap); });
        leadMap.on('mouseleave', 'pt', () => { leadMap.getCanvas().style.cursor = ''; pop.remove(); });
        leadMap.on('mouseenter', 'cl', () => { leadMap.getCanvas().style.cursor = 'pointer'; }); leadMap.on('mouseleave', 'cl', () => { leadMap.getCanvas().style.cursor = ''; });
        lfit(rows);
    });
}
function lfit(rows) {
    if (!leadMap || !rows.length) return;
    const b = new maplibregl.LngLatBounds([rows[0].lng, rows[0].lat], [rows[0].lng, rows[0].lat]); rows.forEach(l => b.extend([l.lng, l.lat]));
    leadMap.fitBounds(b, { padding: 60, maxZoom: 12, duration: 900 });
}

// ------------------------------------------------------------------ pipeline: the leads being worked, by stage
function pipeFilter(l, skip) {
    const q = st.pQ.toLowerCase();
    return inPipe(l) && (skip === 'cat' || !st.pCat || l.source === st.pCat) && (skip === 'ind' || !st.pInd || String(l.industry || '-').toLowerCase() === st.pInd.toLowerCase())
        && (!st.pOwner || l.owner_id === st.pOwner) && (!q || [l.full_name, l.company, l.email, l.phone, l.industry].join(' ').toLowerCase().includes(q));
}
const toBdt = l => (Number(l.value) || 0) * ({ BDT: 1, USD: 120, GBP: 152, EUR: 130, CAD: 87, AUD: 79, INR: 1.4 }[l.currency] || 1);
async function vPipeline() {
    await leads();
    const P = st.leads.filter(l => pipeFilter(l));
    const cats = countBy(st.leads.filter(l => pipeFilter(l, 'cat')), l => l.source);
    const inds = Object.entries(countBy(st.leads.filter(l => pipeFilter(l, 'ind')), l => l.industry || '-')).sort((a, b) => b[1] - a[1]);
    const open = P.filter(l => !['won', 'lost'].includes(l.stage));
    const card = l => `<div class="deal" draggable="true" data-drag="${l.id}" data-open="${l.id}"><div class="dh"><b>${esc(l.company || l.full_name)}</b>${l.value ? `<span class="v">${money(l.value, l.currency)}</span>` : ''}</div>
        <span class="dn">${esc(l.company && l.full_name !== '-' ? l.full_name : '')}</span><div class="m">${indChip(l.industry)}${srcChip(l.source)}</div>
        <div class="m"><span class="dicons">${l.phone ? `<a href="${telHref(l.phone)}" data-tel="${esc(l.phone)}" data-name="${esc(l.company || l.full_name)}" data-lead="${l.id}" title="${esc(l.phone)}">${ic('phone')}</a>` : ''}${l.email ? `<a href="mailto:${esc(l.email)}" title="${esc(l.email)}">${ic('mail')}</a>` : ''}${l.website ? `<a href="${esc(webHref(l.website))}" target="_blank" rel="noopener" title="${esc(l.website)}">${ic('globe')}</a>` : ''}</span>${dueLabel(l.next_step_at)}<span class="ava">${initials(teamName(l.owner_id))}</span></div></div>`;
    return `<div class="head"><div><h1>Pipeline</h1><p class="sub">${num(open.length)} open · ${lakh(open.reduce((a, l) => a + toBdt(l), 0))} in play. Email, call and text from here; drag a card to move it, drop on Won to make it a client.</p></div><div class="sp"></div>
        <div class="searchin">${ic('search')}<input id="pq" type="search" placeholder="Search the pipeline" value="${esc(st.pQ)}" aria-label="Search the pipeline"></div>
        <select id="pown" aria-label="Owner"><option value="">Everyone's</option>${st.meta.team.map(m => `<option value="${m.id}" ${st.pOwner === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>
      ${p90() ? '' : `<div class="banner">${ic('pipeline')}<div>Until the phase-90 SQL runs, the pipeline shows every lead past New. After it, a lead joins with <b>Add to pipeline</b>.</div></div>`}
      <div class="facetrow"><span class="lbl">Category</span><div class="facets"><button type="button" data-pcat="" class="${!st.pCat ? 'on' : ''}">All<b>${num(Object.values(cats).reduce((a, b) => a + b, 0))}</b></button>${st.meta.sources.filter(s => cats[s.key]).map(s => `<button type="button" data-pcat="${s.key}" class="${st.pCat === s.key ? 'on' : ''}" style="--c:var(${SRC_VAR[s.key]})"><i></i>${esc(s.label)}<b>${num(cats[s.key])}</b></button>`).join('')}</div></div>
      <div class="facetrow"><span class="lbl">Industry</span><div class="facets"><button type="button" data-pind="" class="${!st.pInd ? 'on' : ''}">All</button>${inds.map(([k, n]) => `<button type="button" data-pind="${esc(k)}" class="${st.pInd.toLowerCase() === k.toLowerCase() ? 'on' : ''}" style="--c:var(${k === '-' ? '--dim' : indVar(k)})"><i></i>${k === '-' ? 'No industry' : esc(k)}<b>${num(n)}</b></button>`).join('')}</div></div>
      ${P.length || st.leads.some(inPipe) ? `<div class="board">${st.meta.stages.map(s => { const ls = P.filter(l => l.stage === s.key); const sum = ls.reduce((a, l) => a + toBdt(l), 0);
        return `<div class="col" data-col="${s.key}"><div class="col-h"><i style="background:var(${STAGE_VAR[s.key]})"></i><b>${s.label}</b><span>${ls.length}${sum ? ' · ' + lakh(sum) : ''}</span></div>
          <div class="cards">${ls.slice(0, 80).map(card).join('') || '<div class="colempty">Drop a lead here</div>'}${ls.length > 80 ? `<div class="empty sm">+${ls.length - 80} more. Filter to see them.</div>` : ''}</div></div>`; }).join('')}</div>`
        : `<div class="card"><div class="empty">${ic('pipeline')}<b>The pipeline is empty.</b> On the Leads page, select the leads worth working and press <b>Add to pipeline</b>, or open a lead and add it there.<div style="margin-top:12px"><a class="btn pri" href="#leads">Go to Leads</a></div></div></div>`}`;
}

// ------------------------------------------------------------------ clients
async function vClients() {
    const [{ clients }] = await Promise.all([api('/api/clients'), leads(), net().catch(() => ({ clients: [] }))]);
    const fromLead = id => st.leads.find(l => l.client_id === id);
    const loc = new Map(((st.net && st.net.clients) || []).map(c => [c.id, c]));
    const q = st.cQ.toLowerCase();
    const list = (clients || []).filter(c => !c.archived && (!q || [c.name, c.brand, c.niche, c.location].join(' ').toLowerCase().includes(q)));
    return `<div class="head"><div><h1>Clients</h1><p class="sub">${num(list.length)} businesses we work for. Open one for its task board and everything else we do for it.</p></div><div class="sp"></div>
        <div class="searchin">${ic('search')}<input id="cq" type="search" placeholder="Search clients" value="${esc(st.cQ)}" aria-label="Search clients"></div></div>
      ${list.length ? `<div class="cgrid">${list.map(c => { const l = fromLead(c.id), m = loc.get(c.id);
        return `<a class="card ccard" href="#client/${c.id}"><div class="ch"><span class="ava big" style="--c:var(${indVar(c.niche || c.name)})">${initials(c.brand || c.name)}</span><div style="min-width:0"><b>${esc(c.name)}</b><span>${esc([c.niche, c.location || [m && m.city, m && m.country].filter(Boolean).join(', ')].filter(Boolean).join(' · ') || 'No details yet')}</span></div></div>
          <div class="cm">${l ? `<span>${ic('leads')}From a ${esc(srcOf(l.source).label)} lead</span>` : '<span class="dim">Added directly</span>'}${c.converted_at || c.created_at ? `<span>${ic('cal')}Since ${new Date(c.converted_at || c.created_at).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}</span>` : ''}</div>
          <span class="go">Open ${ic('arrow')}</span></a>`; }).join('')}</div>`
        : `<div class="card"><div class="empty">${q ? 'No client matches.' : 'No clients yet. Win a lead in the pipeline and convert it: it arrives here with its history.'}</div></div>`}`;
}

// ------------------------------------------------------------------ influencers: the network on a real map
let mapObj = null, markers = [], linkAnim = 0;
async function net(force) { if (!st.net || force) st.net = await api('/api/crm/influencers'); return st.net; }
const crPosts = id => st.net.posts.filter(p => p.influencer_id === id);
const clientById = id => st.net.clients.find(c => c.id === id);
function crShown() {
    const q = st.crQ.toLowerCase();
    return st.net.influencers.filter(c => (st.crStage === 'all' || c.stage === st.crStage) && (st.crCountry === 'all' || (c.country || '') === st.crCountry) && (!q || [c.handle, c.name, c.city, c.niche].join(' ').toLowerCase().includes(q)));
}
async function vInfluencers() {
    await net();
    const all = st.net.influencers; if (!st.crOn && all[0]) st.crOn = all[0].id;
    const shown = crShown(), c = all.find(x => x.id === st.crOn);
    const countries = [...new Set([...all.map(x => x.country), ...st.net.clients.map(x => x.country)].filter(Boolean))].sort();
    const partners = all.filter(x => x.stage === 'partner'), views = st.net.posts.reduce((a, p) => a + (p.views || 0), 0);
    const byPosts = [...partners].sort((a, b) => crPosts(b.id).length - crPosts(a.id).length).slice(0, 6);
    const prof = c ? profile(c) : `<div class="empty">No creators yet. Add one, or add a lead to the network from its record.</div>`;
    return `<div class="head"><div><h1>Influencer network</h1><p class="sub">Every creator we worked with and the ones we want, on the map around our clients.</p></div><div class="sp"></div><button class="btn pri" type="button" data-act="newcr">${ic('plus')}Add creator</button></div>
      <div class="nettools"><div class="stagetabs" role="tablist">${[['all', 'Everyone', '--ink'], ['partner', 'Worked with', '--ok'], ['talking', 'In talks', '--gold'], ['prospect', 'Prospects', '--dim']].map(([k, l, col]) => `<button type="button" role="tab" data-crstage="${k}" class="${st.crStage === k ? 'on' : ''}" style="--c:var(${col})">${k === 'all' ? '' : '<i></i>'}${l}<span class="c">${all.filter(x => k === 'all' || x.stage === k).length}</span></button>`).join('')}</div>
        <select class="btn" id="crcountry" aria-label="Country"><option value="all">All countries</option>${countries.map(k => `<option value="${k}" ${st.crCountry === k ? 'selected' : ''}>${esc(cname(k))} · ${all.filter(x => x.country === k).length}</option>`).join('')}</select>
        <div style="flex:1"></div><input id="crq" type="search" placeholder="Search name, @handle, city" value="${esc(st.crQ)}" aria-label="Search creators"></div>
      <div class="net">
        <section class="card mapcard ${st.picking ? 'picking' : ''}"><div class="map" id="map" aria-label="Map of creators and clients"></div>
          ${st.picking ? `<div class="pickhint">Click the map where ${esc(st.picking.label)} is</div>` : ''}
          <div class="maplegend"><span><i class="f" style="--c:var(--ok)"></i>Worked with</span><span><i class="f" style="--c:var(--gold)"></i>In talks</span><span><i class="f" style="--c:var(--dim)"></i>Prospect</span><span><i style="--c:var(--ink);border-radius:3px" class="f"></i>Our client</span></div>
          <div class="maptools"><button class="btn sm" type="button" data-act="fit" title="Show everyone">${ic('fit')}Fit</button></div></section>
        <div style="display:grid;gap:16px;align-content:start">
          <section class="card icard">${prof}</section>
          <section class="card"><div class="card-h"><h2>The network</h2><span>All time</span></div>
            <div class="netstats"><div><b>${num(st.net.posts.length)}</b><small>posts for our clients</small></div><div><b>${num(partners.length)}</b><small>creators worked with</small></div><div><b>${num(all.filter(x => x.lead_id).length)}</b><small>also in Leads</small></div><div><b>${kfmt(views)}</b><small>views on those posts</small></div></div>
            ${byPosts.length ? `<div class="rank"><div class="card-h" style="padding-bottom:4px"><span class="lbl">Most posts for us</span></div>${byPosts.map(x => `<div class="cr ${x.id === st.crOn ? 'on' : ''}" data-cr="${x.id}"><span class="av" style="--c:var(${nicheVar(x.niche)})">${initials(x.name || x.handle)}</span><div style="min-width:0"><b>${esc(x.name || '@' + x.handle)}</b><span>${esc([...new Set(crPosts(x.id).map(p => (clientById(p.client_id) || {}).name).filter(Boolean))].join(', '))}</span></div><div class="r"><b>${crPosts(x.id).length}</b></div></div>`).join('')}</div>` : ''}</section>
        </div>
      </div>
      <section class="card" style="margin-top:16px"><div class="card-h"><h2>Everyone in the network</h2><span>${shown.length} shown</span></div><div class="tablewrap"><table class="nettbl"><thead><tr><th>Creator</th><th>Stage</th><th>Niche</th><th>Location</th><th style="text-align:right">Followers</th><th style="text-align:right">Engagement</th><th style="text-align:right">Posts for us</th><th>Clients</th><th>Rate</th></tr></thead><tbody>
        ${shown.map(x => { const ps = crPosts(x.id); return `<tr data-cr="${x.id}"><td><span class="crc"><span class="av" style="--c:var(${nicheVar(x.niche)})">${initials(x.name || x.handle)}</span><span><b style="font-weight:500;display:block">${esc(x.name || '@' + x.handle)}</b><span style="color:var(--muted);font-size:12.5px">@${esc(x.handle)}</span></span></span></td>
          <td><span class="status ${x.stage}">${CR_LABEL[x.stage]}</span></td><td>${esc(x.niche || '—')}</td><td style="color:var(--muted)">${esc([x.city, x.country && cname(x.country)].filter(Boolean).join(', ') || '—')}${x.lat == null ? ' · not on map' : ''}</td>
          <td class="num" style="text-align:right">${kfmt(x.followers)}</td><td class="num" style="text-align:right">${x.engagement == null ? '—' : x.engagement + '%'}</td><td class="num" style="text-align:right">${ps.length || '—'}</td>
          <td style="color:var(--muted);white-space:normal">${esc([...new Set(ps.map(p => (clientById(p.client_id) || {}).name).filter(Boolean))].join(', ') || '—')}</td><td class="num">${esc(x.rate || '—')}</td></tr>`; }).join('') || '<tr><td colspan="9" class="empty">No creators match.</td></tr>'}
      </tbody></table></div></section>`;
}
function profile(c) {
    const ps = crPosts(c.id), byClient = {};
    ps.forEach(p => { const k = p.client_id; (byClient[k] = byClient[k] || []).push(p); });
    const near = c.lat == null ? [] : st.net.clients.filter(m => m.lat != null).map(m => [m, haversine(c, m)]).sort((a, b) => a[1] - b[1]).slice(0, 3);
    const lead = c.lead_id && st.leads ? st.leads.find(l => l.id === c.lead_id) : null;
    return `<div class="h"><span class="av" style="--c:var(${nicheVar(c.niche)})">${initials(c.name || c.handle)}</span><div style="min-width:0;flex:1"><h2>${esc(c.name || '@' + c.handle)}</h2><span class="sub" style="font-size:12.5px">@${esc(c.handle)} · ${kfmt(c.followers)} followers</span></div><span class="status ${c.stage}">${CR_LABEL[c.stage]}</span></div>
      ${c.bio ? `<p class="bio" style="margin:0">${esc(c.bio)}</p>` : ''}
      <div class="istats"><div><small>Engagement</small><b>${c.engagement == null ? '—' : c.engagement + '%'}</b></div><div><small>Posts for us</small><b>${ps.length}</b></div><div><small>Rate / post</small><b>${esc(c.rate || '—')}</b></div></div>
      <div class="range"><span class="lbl">Typical range</span>${c.lat == null ? `<div>Not on the map yet. <button class="btn sm" type="button" data-act="crpick">Pick on map</button></div>` :
        `<div><b style="font-weight:500">${esc([c.home_area, c.city, c.country && cname(c.country)].filter(Boolean).join(', ') || 'Location set')}</b></div>${near.map(([m, d]) => `<div>${esc(m.name)}<span>${d < 10 ? d.toFixed(1) : Math.round(d)} km</span></div>`).join('')}`}</div>
      ${Object.keys(byClient).length ? `<div class="worked"><span class="lbl">Worked with us · ${ps.length} posts · ${kfmt(ps.reduce((a, p) => a + (p.views || 0), 0))} views</span>${Object.entries(byClient).map(([k, list]) => `<div><i></i><span><b style="font-weight:500">${esc((clientById(k) || { name: 'A client' }).name)}</b><small>${list.length} post${list.length > 1 ? 's' : ''} · ${kfmt(list.reduce((a, p) => a + (p.views || 0), 0))} views · last ${new Date(list.map(p => p.posted_at).sort().pop()).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</small></span></div>`).join('')}</div>` : ''}
      <div class="links">${lead ? `<button type="button" class="lnk" data-open="${lead.id}">${ic('leads')}Lead: ${esc(lead.full_name)}${lead.company ? ' · ' + esc(lead.company) : ''}<small>${esc(lead.stage)}</small></button>` : ''}
        <button type="button" class="lnk" data-act="crpost">${ic('plus')}Log a post for a client<small>marks them Worked with</small></button>
        <button type="button" class="lnk" data-act="credit">${ic('note')}Edit profile<small>stage, rate, location</small></button></div>`;
}
// The map library is about 800 KB, so it loads the first time the Influencers page opens, not with the CRM (phase 89).
let mapLib = null;
function loadMapLib() {
    if (window.maplibregl) return Promise.resolve();
    if (mapLib) return mapLib;
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css'; document.head.appendChild(css);
    mapLib = new Promise((ok, no) => { const sc = document.createElement('script'); sc.src = 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js'; sc.onload = ok; sc.onerror = () => { mapLib = null; no(); }; document.head.appendChild(sc); });
    return mapLib;
}
function mapInit() {
    const el0 = $('#map');
    if (el0 && !window.maplibregl) { loadMapLib().then(() => route === 'influencers' && mapInit(), () => { const m = $('#map'); if (m) m.innerHTML = '<div class="empty">The map could not load. Check the connection and refresh.</div>'; }); return; }
    const el = $('#map'); if (!el || !window.maplibregl) return;
    if (mapObj) { mapObj.remove(); mapObj = null; }
    const shown = crShown().filter(c => c.lat != null), clients = st.net.clients.filter(c => c.lat != null && (st.crCountry === 'all' || c.country === st.crCountry));
    mapObj = new maplibregl.Map({ container: el, style: MAP_STYLE, center: [90.37, 22.70], zoom: 11, attributionControl: { compact: true }, cooperativeGestures: matchMedia('(pointer: coarse)').matches });
    mapObj.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    markers = [];
    const sel = st.net.influencers.find(c => c.id === st.crOn);
    const hotClients = new Set(sel ? crPosts(sel.id).map(p => p.client_id) : []);
    clients.forEach(m => { const d = document.createElement('div'); d.className = 'cpin' + (hotClients.has(m.id) ? ' hot' : ''); d.innerHTML = `<i></i><b>${esc(m.name)}</b>`;
        markers.push(new maplibregl.Marker({ element: d, anchor: 'left', offset: [-7, 0] }).setLngLat([m.lng, m.lat]).addTo(mapObj)); });
    shown.forEach(c => { const d = document.createElement('button'); d.type = 'button'; d.className = 'pin' + (c.id === st.crOn ? ' on' : ''); d.setAttribute('aria-label', (c.name || '@' + c.handle) + ', ' + CR_LABEL[c.stage]);
        const dia = Math.round(26 + Math.min(18, Math.log10(Math.max(10, c.followers || 10)) * 3.4));
        d.style.cssText = `--c:var(${nicheVar(c.niche)});--ring:var(${CR_RING[c.stage]});--d:${dia}px`; d.textContent = initials(c.name || c.handle);
        d.title = `${c.name || '@' + c.handle} · ${kfmt(c.followers)} · ${CR_LABEL[c.stage]}`;
        d.addEventListener('click', e => { e.stopPropagation(); st.crOn = c.id; render(); });
        markers.push(new maplibregl.Marker({ element: d }).setLngLat([c.lng, c.lat]).addTo(mapObj)); });
    mapObj.on('load', () => {
        const css = getComputedStyle(document.documentElement), okc = css.getPropertyValue('--ok').trim() || '#14804a';
        const lines = sel && sel.lat != null ? crPosts(sel.id).map(p => clientById(p.client_id)).filter(m => m && m.lat != null).map(m => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[sel.lng, sel.lat], [m.lng, m.lat]] } })) : [];
        mapObj.addSource('links', { type: 'geojson', data: { type: 'FeatureCollection', features: lines } });
        mapObj.addLayer({ id: 'links-glow', type: 'line', source: 'links', paint: { 'line-color': okc, 'line-width': 8, 'line-opacity': .15 } });
        mapObj.addLayer({ id: 'links', type: 'line', source: 'links', layout: { 'line-cap': 'round' }, paint: { 'line-color': okc, 'line-width': 2.5, 'line-dasharray': [0, 4, 3] } });
        if (!matchMedia('(prefers-reduced-motion: reduce)').matches && lines.length) {
            const steps = [[0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0], [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5]];
            let i = 0; cancelAnimationFrame(linkAnim);
            const tick = () => { if (!mapObj || !mapObj.getLayer('links')) return; mapObj.setPaintProperty('links', 'line-dasharray', steps[i = (i + 1) % steps.length]); linkAnim = setTimeout(() => requestAnimationFrame(tick), 70); };
            tick();
        }
        fit(sel && sel.lat != null && !st.fitAll ? sel : null);
    });
    mapObj.on('click', async e => {
        if (!st.picking) return;
        const p = st.picking; st.picking = null;
        try {
            if (p.kind === 'creator') { await api('/api/crm/influencers/' + p.id, { method: 'PATCH', body: { lat: +e.lngLat.lat.toFixed(6), lng: +e.lngLat.lng.toFixed(6) } }); toast('Location saved'); }
            if (p.kind === 'client') { await api('/api/crm/clients/' + p.id + '/location', { method: 'PATCH', body: { lat: +e.lngLat.lat.toFixed(6), lng: +e.lngLat.lng.toFixed(6) } }); toast(p.label + ' is on the map'); }
            await net(true); render();
        } catch (err) { toast(err.message, true); }
    });
}
function fit(focus) {
    if (!mapObj) return;
    if (focus) { mapObj.flyTo({ center: [focus.lng, focus.lat], zoom: Math.max(mapObj.getZoom(), 12.5), speed: 1.1, curve: 1.4, essential: true });
        const ends = crPosts(focus.id).map(p => clientById(p.client_id)).filter(m => m && m.lat != null);
        if (ends.length) { const b = new maplibregl.LngLatBounds([focus.lng, focus.lat], [focus.lng, focus.lat]); ends.forEach(m => b.extend([m.lng, m.lat])); setTimeout(() => mapObj && mapObj.fitBounds(b, { padding: 90, maxZoom: 14, duration: 1400 }), 900); }
        return; }
    const pts = [...crShown(), ...st.net.clients.filter(c => st.crCountry === 'all' || c.country === st.crCountry)].filter(x => x.lat != null);
    if (!pts.length) return;
    const b = new maplibregl.LngLatBounds([pts[0].lng, pts[0].lat], [pts[0].lng, pts[0].lat]); pts.forEach(x => b.extend([x.lng, x.lat]));
    mapObj.fitBounds(b, { padding: 70, maxZoom: 13, duration: 1600 });
}

// ------------------------------------------------------------------ sign in (the CRM is the front door; it is index.html, at /)
function authScreen(inner) {
    document.body.innerHTML = `<main class="auth"><section class="card authcard"><div class="brand"><img class="logo" src="/icons/logo-mark.png" alt="" width="22" height="26">EdgeLead</div>${inner}<div class="err" id="aerr" role="alert"></div></section><p class="authfoot">EdgeLead CRM · for the EdgeLead team</p></main>`;
    const f = $('.authcard input'); if (f) f.focus();
}
function signIn(msg) {
    authScreen(`<h1>Sign in</h1><p class="sub">Use the email and password the owner gave you.</p>
      <form id="signin">${fieldHtml('si-e', 'Email', 'type="email" autocomplete="username" required')}${fieldHtml('si-p', 'Password', 'type="password" autocomplete="current-password" required')}
      <button class="btn pri wide" type="submit">Sign in</button></form><button class="linkbtn" type="button" id="forgot">Forgot your password?</button>`);
    if (msg) $('#aerr').textContent = msg;
    $('#signin').onsubmit = async ev => { ev.preventDefault(); const b = ev.target.querySelector('button'); b.disabled = true; b.textContent = 'Signing in…'; $('#aerr').textContent = '';
        const { error } = await sb.auth.signInWithPassword({ email: v('si-e').trim(), password: v('si-p') });
        if (error) { $('#aerr').textContent = /invalid/i.test(error.message) ? 'That email and password do not match.' : error.message; b.disabled = false; b.textContent = 'Sign in'; return; }
        try { sessionStorage.setItem('el-app-unlocked', '1'); } catch {}   // phase 91: signing in with the password unlocks the installed app too
        location.reload(); };
    $('#forgot').onclick = async () => { const email = v('si-e').trim(); if (!email) { $('#aerr').textContent = 'Write your email first, then press this again.'; return; }
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + '/' });
        $('#aerr').textContent = error ? error.message : 'If that email has an account, a link to set a new password is on its way.'; };
}
function setPassword() {
    authScreen(`<h1>Choose a password</h1><p class="sub">You will use it with your email to sign in.</p>
      <form id="setpw">${fieldHtml('np-1', 'New password', 'type="password" autocomplete="new-password" minlength="8" required')}${fieldHtml('np-2', 'Again', 'type="password" autocomplete="new-password" minlength="8" required')}
      <button class="btn pri wide" type="submit">Save and open the CRM</button></form>`);
    $('#setpw').onsubmit = async ev => { ev.preventDefault();
        if (v('np-1').length < 8) { $('#aerr').textContent = 'Use 8 characters or more.'; return; }
        if (v('np-1') !== v('np-2')) { $('#aerr').textContent = 'The two passwords are different.'; return; }
        const { error } = await sb.auth.updateUser({ password: v('np-1') });
        if (error) { $('#aerr').textContent = error.message; return; }
        location.replace('/'); };
}

// ------------------------------------------------------------------ the installed app's lock (phase 91)
// The Dialer installed as an app opens locked: the person types their workspace password again, checked by Supabase.
// It stays open while the app window is, and locks again after 15 minutes in the background (never during a call).
const standalone = () => matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: window-controls-overlay)').matches || navigator.standalone === true;
const UNLOCK = 'el-app-unlocked';
function appUnlocked() { try { return sessionStorage.getItem(UNLOCK) === '1'; } catch { return false; } }
function appLock(email) {
    authScreen(`<h1>Unlock the Dialer</h1><p class="sub">The installed app asks for your workspace password each time it opens.</p>
      <form id="unlock"><div class="field"><label for="ul-e">Email</label><input id="ul-e" type="email" value="${esc(email)}" autocomplete="username" readonly></div>${fieldHtml('ul-p', 'Password', 'type="password" autocomplete="current-password" required')}
      <button class="btn pri wide" type="submit">Unlock</button></form><button class="linkbtn" type="button" id="ul-other">Sign in as someone else</button>`);
    $('#ul-p').focus();
    $('#unlock').onsubmit = async ev => { ev.preventDefault(); const b = ev.target.querySelector('button'); b.disabled = true; b.textContent = 'Checking…'; $('#aerr').textContent = '';
        const { error } = await sb.auth.signInWithPassword({ email, password: v('ul-p') });
        if (error) { $('#aerr').textContent = /invalid/i.test(error.message) ? 'That password is not right.' : error.message; b.disabled = false; b.textContent = 'Unlock'; return; }
        try { sessionStorage.setItem(UNLOCK, '1'); } catch {}
        location.reload(); };
    $('#ul-other').onclick = async () => { await sb.auth.signOut(); try { sessionStorage.removeItem(UNLOCK); } catch {} location.reload(); };
}
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
    if (!standalone()) return;
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt > 15 * 60e3 && !(window.ELPhone && ELPhone.busy)) { try { sessionStorage.removeItem(UNLOCK); } catch {} location.reload(); }
    hiddenAt = 0;
});

// ------------------------------------------------------------------ lead record
async function openLead(id) {
    st.openId = id;
    $('#layer').innerHTML = `<div class="scrim" data-close></div><aside class="drawer" role="dialog" aria-modal="true" aria-label="Lead"><div class="boot">Loading…</div></aside><div id="sub"></div>`;
    try {
        const d = await api('/api/crm/leads/' + id); if (st.openId !== id) return;
        st.lead = d; drawLead(d);
        const i = st.leads ? st.leads.findIndex(x => x.id === id) : -1; if (i >= 0) st.leads[i] = { ...st.leads[i], ...d.lead };
    } catch (e) { $('.drawer').innerHTML = `<div class="empty err">${esc(e.message)}</div>`; }
}
const HK = { note: ['note', 'Note'], email_out: ['mail', 'Email sent'], email_in: ['reply', 'Reply received'], call: ['phone', 'Call'], sms: ['reply', 'Text'], whatsapp: ['wa', 'WhatsApp'],
    meeting: ['meet', 'Meeting'], stage: ['stage', 'Stage'], task: ['task', 'Task done'], system: ['dot', 'Update'], campaign_email: ['mail', 'Campaign email'] };
const HFILTER = [['all', 'All', () => true], ['call', 'Calls', i => i.kind === 'call'], ['sms', 'Texts', i => i.kind === 'sms' || i.kind === 'whatsapp'], ['email', 'Emails', i => ['email_out', 'email_in', 'campaign_email'].includes(i.kind)], ['note', 'Notes', i => ['note', 'meeting'].includes(i.kind)]];
function histItem(i) {
    const m = i.meta || {}, [icon, label] = HK[i.kind] || ['note', 'Update'];
    const dir = m.direction === 'inbound' ? 'in' : m.direction === 'outbound' ? 'out' : '';
    let title = label;
    if (i.kind === 'stage') title = `Moved to ${esc((st.meta.stages.find(s => s.key === m.to) || { label: m.to || '' }).label)}${m.auto ? ' <small>(a reply came in)</small>' : ''}`;
    else if (i.kind === 'call') title = m.voicemail ? 'Voicemail' : `${dir === 'in' ? 'Call in' : dir === 'out' ? 'Call out' : 'Call'}${m.minutes ? ' · ' + m.minutes + ' min' : ''}${m.outcome ? ' · ' + esc(m.outcome) : ''}`;
    else if (i.kind === 'sms') title = dir === 'in' ? 'Text received' : 'Text sent' + (m.auto ? ' <small>(automatic)</small>' : '');
    else if (i.kind === 'email_out' && m.campaign) title = `Campaign email${m.campaignName ? ' · ' + esc(m.campaignName) : ''}`;
    else if (i.kind === 'system') title = esc(i.body || 'Update');
    const subject = m.subject ? `<p class="subj">${esc(m.subject)}</p>` : '';
    const opened = m.opened ? `<span class="pill ok">Opened${m.opens > 1 ? ' ×' + m.opens : ''}</span>` : m.status === 'failed' ? '<span class="pill bad">Failed</span>' : '';
    const body = i.body && i.kind !== 'system' ? `<p class="hb ${i.body.length > 280 ? 'clamp' : ''}">${esc(i.body)}</p>${i.body.length > 280 ? '<button type="button" class="linkbtn" data-more>Show all</button>' : ''}` : '';
    return `<div class="ev k-${i.kind} ${dir}"><span class="k">${ic(icon)}</span><div class="x"><div class="xh"><b>${title}</b>${opened}<span class="w" title="${new Date(i.at).toLocaleString('en-GB')}">${ago(i.at)}${i.actor ? ' · ' + esc(teamName(i.actor)) : ''}</span></div>${subject}${body}</div></div>`;
}
function drawLead({ lead: l, activities, history, tasks, influencers, client }) {
    const items = history ? history.items : activities.map(a => ({ kind: a.type, at: a.at, id: a.id, actor: a.actor_id, body: a.body, meta: a.meta || {} }));
    const counts = Object.fromEntries(HFILTER.map(([k, , f]) => [k, items.filter(f).length]));
    const hf = (HFILTER.find(h => h[0] === st.hist) || HFILTER[0])[2];
    const si = st.meta.stages.findIndex(s => s.key === l.stage), work = inPipe(l) || leadState(l) === 'client';
    const waNum = String(l.whatsapp || l.phone || '').replace(/\D/g, '');
    const lock = work ? '' : ' disabled title="Add the lead to the pipeline first"';
    const dnc = (l.tags || []).includes('Do not call'), wrong = (l.tags || []).includes('Wrong number');
    const noCall = dnc ? ' disabled title="They asked not to be called"' : wrong ? ' disabled title="The number is wrong: fix it below first"' : '';
    const sel = (field, opts, cur) => `<select data-field="${field}" id="pf-${field}">${opts.map(([v, t]) => `<option value="${esc(v)}" ${String(cur ?? '') === String(v) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
    const inp = (field, val, type = 'text', ph = '', extra = '') => `<input data-field="${field}" id="pf-${field}" type="${type}" value="${esc(val ?? '')}" placeholder="${esc(ph)}" ${extra}>`;
    const box = (title, icon, rows) => `<section class="pbox"><h3>${ic(icon)}${title}</h3><dl>${rows.join('')}</dl></section>`;
    const prow = (label, field, html) => `<div><dt><label for="pf-${field}">${label}</label></dt><dd>${html}</dd></div>`;
    $('.drawer').innerHTML = `<div class="dr-h"><div class="dr-top"><span class="ava big" style="--c:var(${indVar(l.industry || l.company)})">${initials(l.company || l.full_name)}</span>
        <div class="t"><h2>${esc(l.company || l.full_name)}</h2><p class="sub">${esc([l.company && l.full_name !== '-' ? l.full_name : '', l.title].filter(Boolean).join(', '))}${l.city || l.country ? ' · ' + esc([l.city, l.country && cname(l.country)].filter(Boolean).join(', ')) : ''}</p>
          <div class="lchips">${indChip(l.industry)}${stateChip(l)}${srcChip(l.source)}${dnc ? '<span class="flag bad">Do not call</span>' : ''}${wrong ? '<span class="flag warn">Wrong number: fix it below to call again</span>' : ''}</div>
          ${l.phone || l.email || (l.whatsapp && l.whatsapp !== l.phone) ? `<div class="lnums">${l.phone ? `<span class="lnum"><b class="num">${esc(l.phone)}</b><button type="button" class="btn sm" data-copy="${esc(l.phone)}">${ic('copy')}Copy</button></span>` : ''}${l.whatsapp && l.whatsapp !== l.phone ? `<span class="lnum"><span>${ic('wa')}${esc(l.whatsapp)}</span><button type="button" class="btn sm ghost" data-copy="${esc(l.whatsapp)}">${ic('copy')}Copy</button></span>` : ''}${l.email ? `<span class="lnum"><span>${esc(l.email)}</span><button type="button" class="btn sm ghost" data-copy="${esc(l.email)}">${ic('copy')}Copy</button></span>` : ''}</div>` : ''}
          ${p91() ? `<div class="lout"><span class="${l.calls_count ? 'y' : ''}">${ic('phone')}${l.calls_count ? `Called ${l.calls_count}×${l.last_call_outcome ? ' · ' + esc(l.last_call_outcome) : ''}${l.last_call_at ? ' · ' + ago(l.last_call_at) : ''}` : 'Never called'}</span><span class="${l.emails_count ? 'y' : ''}">${ic('mail')}${l.emails_count ? `Emailed ${l.emails_count}×${l.last_email_at ? ' · ' + ago(l.last_email_at) : ''}` : 'Never emailed'}</span>${l.campaign ? `<span class="y">${ic('seq')}In “${esc(l.campaign.name)}”${l.campaign.next_at ? ' · next email ' + dueLabel(l.campaign.next_at).replace(/<[^>]+>/g, '') : ''}</span>` : ''}${l.callback_at && !['in_play'].includes(l.call_status) && !dnc && !wrong ? `<span>${ic('cal')}${l.call_status === 'closed' ? 'Back in the call list' : 'Try again'} ${new Date(l.callback_at) <= new Date() ? 'now' : dueLabel(l.callback_at).replace(/<[^>]+>/g, '')}</span>` : ''}</div>` : ''}</div><button class="btn ghost sm" type="button" data-close aria-label="Close">${ic('x')}</button></div>
      ${work ? `<div class="stepper" role="group" aria-label="Stage">${st.meta.stages.map((s, i) => `<button type="button" data-stage="${s.key}" class="${i < si && l.stage !== 'lost' ? 'past' : ''} ${i === si ? 'cur' : ''} ${s.key === 'lost' ? 'lost' : ''}" ${l.client_id && s.key !== 'won' ? 'disabled' : ''}>${s.label}</button>`).join('')}</div>`
        : `<div class="coldbar">${ic('lock')}<div><b>Cold lead.</b> Call it from Calls. Email and texts are worked from the pipeline: add it when it is worth working (an Interested call adds it for you).</div><button class="btn pri sm" type="button" data-act="topipe">${ic('pipeline')}Add to pipeline</button></div>`}
      <div class="acts">${l.email ? `<a class="btn sm ${work ? 'pri' : ''}" ${work ? `href="mailto:${esc(l.email)}"` : 'aria-disabled="true" tabindex="-1"'}${lock}>${ic('mail')}Email</a>` : ''}
        ${l.phone ? `<button class="btn sm ${work ? '' : 'pri'}" type="button" data-act="phcall"${noCall}>${ic('phone')}Call</button>${window.ELPhone ? `<button class="btn sm" type="button" data-act="phdial" title="Opens this lead in Calls, to call it and log how it went">${ic('keypad')}Open in dialer</button>` : ''}<button class="btn sm" type="button" data-act="phtext"${dnc ? noCall : lock}>${ic('reply')}Text</button>` : ''}
        ${p91() && l.call_status === 'closed' && !dnc && !wrong && !l.client_id && l.stage !== 'won' ? `<button class="btn sm" type="button" data-act="reopen" title="Put it back in the call list, due now">${ic('redo')}Back to the call list</button>` : ''}
        ${dnc && isAdmin() ? `<button class="btn sm ghost" type="button" data-act="undnc" title="Only if they asked to be called again">Allow calls again</button>` : ''}
        ${waNum ? `<a class="btn sm" ${work ? `href="https://wa.me/${waNum}" target="_blank" rel="noopener"` : 'aria-disabled="true" tabindex="-1"'}${lock}>${ic('wa')}WhatsApp</a>` : ''}
        ${p90() && l.email ? `<button class="btn sm" type="button" data-act="tocamp"${!feat('campaigns') ? ' disabled title="Email campaigns are locked for you"' : lock}>${ic(feat('campaigns') ? 'seq' : 'lock')}Add to campaign</button>` : ''}
        <button class="btn sm ghost" type="button" data-act="tonet">${ic('pin')}Influencer network</button>
        ${work && inPipe(l) && p90() && !l.client_id ? `<button class="btn sm ghost" type="button" data-act="frompipe">Take out of pipeline</button>` : ''}
        ${l.client_id ? `<a class="btn sm" href="#client/${l.client_id}" data-close>${ic('clients')}Open client</a>` : work ? `<button class="btn sm gold" type="button" data-act="convert">${ic('client')}Convert to client</button>` : ''}        ${isAdmin() && !l.client_id ? `<button class="btn sm ghost danger" type="button" data-act="dellead" title="Delete this lead and its history">${ic('trash')}Delete</button>` : ''}</div></div>
    <div class="dr-b"><div class="feed">
      <div class="compose"><div class="tabs" role="tablist">${[['note', 'Note'], ['call', 'Log call'], ['email_out', 'Email sent'], ['email_in', 'Reply'], ['whatsapp', 'WhatsApp'], ['meeting', 'Meeting'], ['task', 'Task']].map(([k, t]) => `<button type="button" role="tab" data-ctab="${k}" class="${ctab === k ? 'on' : ''}">${t}</button>`).join('')}</div>
        <textarea id="cbody" aria-label="Write here" placeholder="Write a note"></textarea>
        <div class="inline" id="cextra" hidden></div>
        <div class="bar"><span id="chint">Saved on this lead's history</span><button class="btn sm pri" type="button" data-act="csave">Save</button></div></div>
      ${tasks.filter(t => !t.done_at).map(t => `<div class="ev task"><span class="k">${ic('task')}</span><div class="x"><div class="xh"><b>${esc(t.title)}</b>${t.due_at ? dueLabel(t.due_at) : ''}<button class="btn sm" type="button" data-taskdone="${t.id}">Done</button></div></div></div>`).join('')}
      <div class="hhead"><h3>History</h3><div class="hf" role="tablist">${HFILTER.map(([k, lab]) => `<button type="button" role="tab" data-hist="${k}" class="${st.hist === k ? 'on' : ''}">${lab}<span>${counts[k]}</span></button>`).join('')}</div></div>
      <div class="hist">${items.filter(hf).map(histItem).join('') || '<div class="empty sm">Nothing here yet.</div>'}</div>
    </div>
    <div class="props">
      ${box('Contact', 'phone', [prow('Email', 'email', inp('email', l.email, 'email', 'name@business.com')), prow('Phone', 'phone', inp('phone', l.phone, 'tel', '+1 …')), prow('WhatsApp', 'whatsapp', inp('whatsapp', l.whatsapp, 'tel', 'If not the phone')), prow('Website', 'website', inp('website', l.website, 'url', 'https://'))])}
      ${box('Business', 'clients', [prow('Business', 'company', inp('company', l.company)), prow('Contact person', 'full_name', inp('full_name', l.full_name)), ...(p90() ? [prow('Industry', 'industry', inp('industry', l.industry, 'text', 'Roofing, Plumbing…', 'list="indlist" required'))] : []),
          prow('Category', 'source', sel('source', st.meta.sources.map(s => [s.key, s.path || s.label]), l.source)), prow('City', 'city', inp('city', l.city)), prow('Country', 'country', inp('country', l.country, 'text', 'US', 'maxlength="2"'))])}
      ${box('Deal', 'stage', [prow('Value', 'value', `<div class="inline">${inp('value', l.value, 'number', '0')}${sel('currency', st.meta.currencies.map(c => [c, c]), l.currency)}</div>`), prow('Score', 'score', inp('score', l.score, 'number', '0–100', 'min="0" max="100"')),
          prow('Owner', 'owner_id', sel('owner_id', [['', 'Nobody'], ...st.meta.team.map(m => [m.id, m.name])], l.owner_id)), ...(l.stage === 'lost' ? [prow('Why lost', 'lost_reason', inp('lost_reason', l.lost_reason))] : [])])}
      ${box('Next step', 'cal', [prow('What', 'next_step', inp('next_step', l.next_step, 'text', 'What happens next')), prow('When', 'next_step_at', inp('next_step_at', l.next_step_at ? new Date(new Date(l.next_step_at) - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 16) : '', 'datetime-local'))])}
      ${p91() ? `<section class="pbox"><h3>${ic('search')}<label for="pf-insights">What we noticed</label></h3><textarea data-field="insights" id="pf-insights" rows="4" placeholder="One line each, e.g. Their site has no reviews. The dialer shows these.">${esc((Array.isArray(l.insights) ? l.insights : []).join('\n'))}</textarea></section>` : ''}
      <section class="pbox"><h3>${ic('link')}Linked</h3><div class="links">
        ${client ? `<a class="lnk" href="#client/${client.id}" data-close>${ic('clients')}${esc(client.name)}<small>client</small></a>` : ''}
        ${influencers.map(c => `<button type="button" class="lnk" data-crgo="${c.id}">${ic('pin')}@${esc(c.handle)}<small>creator</small></button>`).join('')}
        <button type="button" class="lnk" data-dept="${srcOf(l.source).dept}">${ic('overview')}${esc(srcOf(l.source).path || srcOf(l.source).label)}<small>department</small></button>
        <span class="dim small">Added ${ago(l.created_at)}${l.tags && l.tags.length ? ' · ' + l.tags.map(esc).join(', ') : ''}</span></div></section>
      <datalist id="indlist">${industries().map(i => `<option value="${esc(i)}">`).join('')}</datalist>
    </div></div>`;
    setCtab(ctab);
}
let ctab = 'note';
function setCtab(k) {
    ctab = k; document.querySelectorAll('[data-ctab]').forEach(b => b.classList.toggle('on', b.dataset.ctab === k));
    const ex = $('#cextra'); if (!ex) return; ex.hidden = !['call', 'task'].includes(k);
    ex.innerHTML = k === 'call' ? `<input id="c-min" type="number" min="0" placeholder="Minutes" aria-label="Minutes"><select id="c-out" aria-label="Outcome"><option value="">Outcome</option><option>Spoke</option><option>No answer</option><option>Left voicemail</option><option>Wrong number</option><option>Call back later</option></select>`
        : k === 'task' ? `<input id="c-due" type="datetime-local" aria-label="Due">` : '';
    $('#cbody').placeholder = { note: 'Write a note', call: 'What was said', whatsapp: 'What was said on WhatsApp', email_out: 'Paste or sum up the email you sent', email_in: 'Paste or sum up their reply (moves them to Replied and stops their campaigns)', meeting: 'Notes from the meeting', task: 'What needs doing' }[k];
}
async function saveField(el) {
    const f = el.dataset.field; let val = el.value;
    if (f === 'next_step_at') val = val ? new Date(val).toISOString() : null;
    if (f === 'industry' && !val.trim()) { toast('A lead keeps an industry. Pick one, or Other.', true); el.value = (st.lead && st.lead.lead.industry) || ''; return; }
    try { const { lead } = await api('/api/crm/leads/' + st.openId, { method: 'PATCH', body: { [f]: val === '' ? null : val } }); const i = st.leads ? st.leads.findIndex(x => x.id === lead.id) : -1; if (i >= 0) st.leads[i] = lead; if (st.lead) st.lead.lead = lead; toast('Saved'); }
    catch (e) { toast(e.message, true); }
}
async function setPipeline(ids, on) {
    if (ids.length === 1) await api('/api/crm/leads/' + ids[0], { method: 'PATCH', body: { in_pipeline: on } });
    else await api('/api/crm/leads/bulk', { method: 'POST', body: { ids, set: { in_pipeline: on } } });
    await leads(true);
}
function modal(title, body, okText, onOk, wide) {
    if (!$('#sub')) $('#layer').innerHTML = '<div id="sub"></div>';
    $('#sub').innerHTML = `<div class="scrim" data-unsub style="z-index:30"></div><div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}" ${wide ? 'style="width:min(680px,calc(100% - 32px))"' : ''}><div class="mh"><h2>${esc(title)}</h2><button class="btn ghost sm" type="button" data-unsub aria-label="Close">${ic('x')}</button></div><div class="mb">${body}<div class="err" id="merr" role="alert"></div></div>
      <div class="mf"><button class="btn" type="button" data-unsub>Cancel</button><button class="btn pri" type="button" id="mok">${esc(okText)}</button></div></div>`;
    const first = $('#sub .modal input, #sub .modal select, #sub .modal textarea'); if (first) first.focus();
    $('#mok').onclick = async () => { const b = $('#mok'); b.disabled = true; try { await onOk(); } catch (e) { $('#merr').textContent = e.message; } b.disabled = false; };
}
const fieldHtml = (id, label, attrs = '', hint = '') => `<div class="field"><label for="${id}">${label}</label><input id="${id}" ${attrs}>${hint ? `<small>${hint}</small>` : ''}</div>`;
const v = id => ($('#' + id) || {}).value || '';
const indField = (id, val = '', req = true) => p90() ? `<div class="field"><label for="${id}">Industry${req ? ' <span class="req">required</span>' : ''}</label><input id="${id}" list="${id}-l" value="${esc(val)}" placeholder="Roofing, Plumbing, Appliance repair…" autocomplete="off"><datalist id="${id}-l">${industries().map(i => `<option value="${esc(i)}">`).join('')}</datalist></div>` : '';

function newLead(pre = {}) {
    modal('New lead', `<div class="grid2">${fieldHtml('nl-co', 'Business', `placeholder="Business name" value="${esc(pre.company || '')}"`)}${fieldHtml('nl-n', 'Contact person', `autocomplete="off" placeholder="Full name" value="${esc(pre.full_name || '')}"`)}</div>
      <div class="grid2">${indField('nl-i')}<div class="field"><label for="nl-s">Category</label><select id="nl-s">${st.meta.sources.map(s => `<option value="${s.key}">${esc(s.path || s.label)}</option>`).join('')}</select></div></div>
      <div class="grid2">${fieldHtml('nl-e', 'Email', 'type="email" placeholder="name@business.com"')}${fieldHtml('nl-p', 'Phone', `type="tel" placeholder="+1 …" value="${esc(pre.phone || '')}"`)}</div>
      <div class="grid2">${fieldHtml('nl-w', 'Website', 'type="url" placeholder="business.com"')}<div class="field"><label for="nl-o">Owner</label><select id="nl-o">${st.meta.team.map(m => `<option value="${m.id}" ${m.id === st.meta.me.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div></div>
      <div class="grid2">${fieldHtml('nl-city', 'City', 'placeholder="Houston"')}${fieldHtml('nl-c', 'Country', 'maxlength="2" placeholder="US"', 'Two letters: US, BD, GB…')}</div>
      ${p90() ? '<label class="check"><input type="checkbox" id="nl-pipe"> Put it straight in the pipeline</label>' : ''}
      <p class="note" style="margin:0">If the email or phone already belongs to a lead, you'll be shown that lead instead of a duplicate.</p>`, 'Add lead', async () => {
        if (p90() && !v('nl-i').trim()) throw new Error('Pick the industry: what the business does.');
        try {
            const { lead } = await api('/api/crm/leads', { method: 'POST', body: { full_name: v('nl-n') || v('nl-co'), company: v('nl-co'), industry: v('nl-i') || undefined, email: v('nl-e'), phone: v('nl-p'), website: v('nl-w'), source: v('nl-s'), owner_id: v('nl-o'), city: v('nl-city'), country: v('nl-c'), ...(p90() ? { in_pipeline: $('#nl-pipe').checked } : {}) } });
            st.leads = null; $('#layer').innerHTML = ''; toast((lead.company || lead.full_name) + ' added'); await render(); openLead(lead.id);
        } catch (e) { if (e.status === 409 && e.data.duplicate) { $('#merr').innerHTML = `<div class="dupe">${esc(e.message)} <button class="btn sm" type="button" data-open="${e.data.duplicate.id}">Open that lead</button></div>`; return; } throw e; }
    }, true);
}
function importCsv() {
    modal('Import leads from a CSV', `<div class="field"><label for="ic-f">CSV file</label><input id="ic-f" type="file" accept=".csv,text/csv"><small>Columns are matched by name: Name, Company, Industry, Email, Phone, Website, City, Country, Value. Others are ignored.</small></div>
      <div class="grid2"><div class="field"><label for="ic-s">Category for these leads</label><select id="ic-s">${st.meta.sources.map(s => `<option value="${s.key}">${esc(s.path || s.label)}</option>`).join('')}</select></div>${indField('ic-i')}</div>
      <div class="grid2"><div class="field"><label for="ic-o">Owner</label><select id="ic-o">${st.meta.team.map(m => `<option value="${m.id}" ${m.id === st.meta.me.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>${fieldHtml('ic-t', 'Tag (optional)', 'maxlength="40" placeholder="e.g. Houston roofers, November"')}</div>
      <label class="check"><input type="checkbox" id="ic-u"> The file has its own Source column: use it where a row has one</label>${p90() ? '<p class="note" style="margin:0">Rows with their own Industry column keep it; the rest get the industry chosen here.</p>' : ''}<div id="ic-out"></div>`, 'Import', async () => {
        const file = $('#ic-f').files[0]; if (!file) throw new Error('Choose a CSV file first.');
        const csv = await file.text();
        const r = await api('/api/crm/leads/import', { method: 'POST', body: { csv, source: v('ic-s'), industry: v('ic-i') || undefined, owner_id: v('ic-o'), tag: v('ic-t').trim(), useFileSource: $('#ic-u').checked } });
        st.leads = null;
        $('#ic-out').innerHTML = `<div class="note"><b>${r.added} added.</b> ${r.duplicates.length ? r.duplicates.length + ' already in the CRM were skipped. ' : ''}${r.skipped.length ? r.skipped.length + ' rows could not be used: ' + r.skipped.slice(0, 5).map(s => 'row ' + s.row + ' (' + esc(s.reason) + ')').join('; ') : ''}</div>`;
        $('#mok').textContent = 'Done'; $('#mok').onclick = () => { $('#layer').innerHTML = ''; render(); };
    }, true);
}
/** The leads on screen, as a CSV file: everything you need to work or check them elsewhere. */
function exportCsv(rows) {
    const cell = x => { const t = x == null ? '' : String(x); return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
    const stage = k => (st.meta.stages.find(s2 => s2.key === k) || { label: k || '' }).label;
    const cols = [['Business', l => l.company], ['Contact', l => l.full_name], ['Industry', l => l.industry], ['Category', l => srcOf(l.source).path || srcOf(l.source).label], ['Phone', l => l.phone], ['Email', l => l.email],
        ['Website', l => l.website], ['City', l => l.city], ['Country', l => l.country], ['Status', l => STATE[leadState(l)][0]], ['Stage', l => stage(l.stage)], ['Lost reason', l => l.lost_reason], ['Owner', l => teamName(l.owner_id)],
        ['Score', l => l.score], ['Calls', l => l.calls_count], ['Last call', l => l.last_call_at && l.last_call_at.slice(0, 10)], ['Last outcome', l => l.last_call_outcome], ['Try again', l => l.callback_at && l.callback_at.slice(0, 16).replace('T', ' ')],
        ['Emails', l => l.emails_count], ['Last email', l => l.last_email_at && l.last_email_at.slice(0, 10)], ['Campaign', l => l.campaign && l.campaign.name], ['Tags', l => (l.tags || []).join('; ')], ['Added', l => l.created_at && l.created_at.slice(0, 10)]];
    const csv = [cols.map(c => c[0]).join(','), ...rows.map(l => cols.map(c => cell(c[1](l))).join(','))].join('\r\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `edgelead-leads-${new Date().toISOString().slice(0, 10)}.csv`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast(`${num(rows.length)} lead${rows.length === 1 ? '' : 's'} exported`);
}
async function toCampaign(ids) {
    const { campaigns } = await api('/api/crm/campaigns');
    const live = campaigns.filter(c => c.status !== 'archived');
    if (!live.length) { toast('Make a campaign first: Email campaigns → New campaign.'); location.hash = 'campaigns'; $('#layer').innerHTML = ''; return; }
    modal(`Add ${ids.length === 1 ? 'this lead' : ids.length + ' leads'} to a campaign`, `<div class="field"><label for="tc-c">Campaign</label><select id="tc-c">${live.map(c => `<option value="${c.id}">${esc(c.name)} · ${esc(c.status)}</option>`).join('')}</select><small>Leads without an email, or who unsubscribed, are left out. A lead already on it stays where it is.</small></div>`, 'Add', async () => {
        const r = await api('/api/crm/campaigns/' + v('tc-c') + '/enroll', { method: 'POST', body: { leadIds: ids } });
        $('#sub').innerHTML = ''; toast(`${r.added} added${r.already ? ', ' + r.already + ' already on it' : ''}${r.skipped ? ', ' + r.skipped + ' left out' : ''}`);
        if (st.openId) openLead(st.openId); else { st.sel.clear(); render(); }
    });
}

function convertLead(lead) {
    modal(`Make ${lead.company || lead.full_name} a client?`, `<p style="margin:0;color:var(--muted)">This creates the client with ${esc(lead.full_name)} as its contact, keeps the whole lead history and marks the lead Won.</p>
      <div class="grid2"><div class="field"><label for="cv-svc">First service</label><select id="cv-svc">${['Website', 'SEO', 'Meta ads', 'Google ads', 'Social media', 'Influencer marketing', 'Lead generation', 'Reporting'].map(x => `<option>${x}</option>`).join('')}</select></div>
        ${fieldHtml('cv-val', 'Signed value (' + esc(lead.currency || 'BDT') + ')', `type="number" value="${esc(lead.value ?? '')}"`)}</div>`, 'Create client', async () => {
        const r = await api('/api/crm/leads/' + lead.id + '/convert', { method: 'POST', body: { service: v('cv-svc'), value: v('cv-val') } });
        st.leads = null; toast(r.client.name + ' is now a client'); $('#layer').innerHTML = ''; await render(); openLead(lead.id);
    });
}
function creatorForm(c, onOk, title, ok) {
    modal(title, `<div class="grid2">${fieldHtml('cr-h', 'Instagram handle or link', `value="${esc(c.handle || '')}" placeholder="@handle"`)}${fieldHtml('cr-n', 'Name', `value="${esc(c.name || '')}"`)}</div>
      <div class="grid2">${fieldHtml('cr-ni', 'Niche', `value="${esc(c.niche || '')}" placeholder="Food, fashion, beauty…"`)}<div class="field"><label for="cr-st">Stage</label><select id="cr-st">${['prospect', 'talking', 'partner'].map(k => `<option value="${k}" ${(c.stage || 'prospect') === k ? 'selected' : ''}>${CR_LABEL[k]}</option>`).join('')}</select></div></div>
      <div class="grid2">${fieldHtml('cr-f', 'Followers', `type="number" value="${esc(c.followers ?? '')}"`)}${fieldHtml('cr-e', 'Engagement %', `type="number" step="0.1" value="${esc(c.engagement ?? '')}"`)}</div>
      <div class="grid2">${fieldHtml('cr-r', 'Rate per post', `value="${esc(c.rate || '')}" placeholder="৳8,000"`)}${fieldHtml('cr-a', 'Home area', `value="${esc(c.home_area || '')}" placeholder="Band Road"`)}</div>
      <div class="grid2">${fieldHtml('cr-c', 'City', `value="${esc(c.city || '')}"`)}${fieldHtml('cr-co', 'Country', `maxlength="2" value="${esc(c.country || '')}" placeholder="BD"`, 'BD, US, GB, CA, AU…')}</div>
      <div class="field"><label for="cr-b">Bio</label><textarea id="cr-b">${esc(c.bio || '')}</textarea></div>
      <p class="note" style="margin:0">After saving, use “Pick on map” on their profile to place them exactly.</p>`, ok, async () => onOk({ handle: v('cr-h'), name: v('cr-n'), niche: v('cr-ni'), stage: v('cr-st'), followers: v('cr-f'), engagement: v('cr-e'), rate: v('cr-r'), home_area: v('cr-a'), city: v('cr-c'), country: v('cr-co'), bio: $('#cr-b').value }), true);
}

// ------------------------------------------------------------------ events
const closeLayer = () => { $('#layer').innerHTML = ''; st.openId = null; st.lead = null; };
function moreMenu() {
    $('#layer').innerHTML = `<div class="scrim" data-close></div><div class="sheet" role="dialog" aria-modal="true" aria-label="More"><div class="sh-h"><b>More</b><button class="btn ghost sm" type="button" data-close aria-label="Close">${ic('x')}</button></div>
      ${[['campaigns', 'Email campaigns', 'seq'], ['clients', 'Clients', 'clients'], ['influencers', 'Influencers', 'pin'], ['dialer', 'Dialer', 'keypad'], ...(isAdmin() ? [['admin', 'Admin', 'shield']] : [])].map(([k, l, i]) => FEAT_OF[k] && !feat(FEAT_OF[k]) ? `<a href="#${k}" data-featlock="${k}">${ic(i)}${l}<small>Locked</small></a>` : `<a href="#${k}" data-close>${ic(i)}${l}</a>`).join('')}
      ${toolsState().show ? `<a href="/tools" data-tools>${ic('tools')}Tools<small>${toolsState().open ? 'Unlocked' : 'Locked'}</small></a>` : ''}
      <button type="button" id="theme">${ic('moon')}Light / dark</button><button type="button" id="signout">${ic('out')}Sign out</button></div>`;
}
function phoneTo(num, name, leadId) { if (window.ELPhone) { closeLayer(); return ELPhone.call(num, name, leadId || null); } location.href = telHref(num); }
document.addEventListener('click', async e => {
    const t = e.target;
    const fl = t.closest('[data-featlock]'); if (fl) { e.preventDefault(); const [h, d] = FEAT_TEXT[fl.dataset.featlock]; return modalInfo(h, d); }
    if (t.closest('[data-tools],#toolsTop')) { if (!toolsState().open) { e.preventDefault(); return toolsLocked(); } if (t.closest('#toolsTop')) location.href = '/tools'; return; }
    if (t.closest('[data-close]')) { closeLayer(); return; }
    if (t.closest('[data-unsub]')) { $('#sub').innerHTML = ''; if (!st.openId) $('#layer').innerHTML = ''; return; }
    if (t.closest('#theme')) { const r = document.documentElement; const dark = r.dataset.theme ? r.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; r.dataset.theme = dark ? 'light' : 'dark'; try { localStorage.setItem('crm-theme', r.dataset.theme); } catch {} if (route === 'influencers') mapInit(); if (route === 'leads' && st.leadMode === 'map') leadMapInit(); return; }
    if (t.closest('#signout')) { try { localStorage.removeItem('crm-meta-v1'); } catch {} await sb.auth.signOut(); location.replace('/'); return; }
    if (t.closest('#railToggle')) { const r = document.documentElement, mini = r.dataset.rail !== 'mini'; if (mini) r.dataset.rail = 'mini'; else delete r.dataset.rail; try { localStorage.setItem('crm-rail', mini ? 'mini' : ''); } catch {} shell(); return; }
    if (t.closest('#newLead')) return newLead();
    if (t.closest('#openPal')) return palette();
    if (t.closest('[data-more]')) { const p = t.closest('.x').querySelector('.hb'); p.classList.remove('clamp'); t.remove(); return; }
    const tel = t.closest('[data-tel]'); if (tel && window.ELPhone) { e.preventDefault(); return phoneTo(tel.dataset.tel, tel.dataset.name, tel.dataset.lead); }
    const cn = t.closest('[data-callnow]'); if (cn) return phoneTo(cn.dataset.callnow, cn.dataset.name, cn.dataset.lead);
    const pe = t.closest('[data-period]'); if (pe) { st.period = +pe.dataset.period; return render(); }
    const tr = t.closest('[data-trange]'); if (tr) { st.trange = tr.dataset.trange; return render(); }
    const dp = t.closest('[data-dept]'); if (dp) { const d = dp.dataset.dept; st.cat = ''; st.view = 'all'; st.ind = '';
        if (['website', 'seo', 'influencer'].includes(d)) st.cat = d; else if (st.meta.sources.some(s => s.key === d)) st.cat = d;
        closeLayer(); location.hash = 'leads'; return render(); }
    const vw = t.closest('[data-view]'); if (vw) { st.view = vw.dataset.view; st.sel.clear(); return render(); }
    const lm = t.closest('[data-lmode]'); if (lm) { st.leadMode = lm.dataset.lmode; return render(); }
    const fi = t.closest('[data-ind]'); if (fi) { st.ind = st.ind.toLowerCase() === fi.dataset.ind.toLowerCase() ? '' : fi.dataset.ind; st.sel.clear(); return render(); }
    const pc = t.closest('[data-pcat]'); if (pc) { st.pCat = pc.dataset.pcat; return render(); }
    const pi = t.closest('[data-pind]'); if (pi) { st.pInd = pi.dataset.pind; return render(); }
    const hfb = t.closest('[data-hist]'); if (hfb) { st.hist = hfb.dataset.hist; if (st.lead) drawLead(st.lead); return; }
    if (t.matches('[data-sel]')) { const id = t.dataset.sel; t.checked ? st.sel.add(id) : st.sel.delete(id); return render(); }
    if (t.id === 'selall') { const rows = st.leads.filter(l => leadFilter(l)).slice(0, 500); rows.forEach(l => t.checked ? st.sel.add(l.id) : st.sel.delete(l.id)); return render(); }
    if (t.closest('.c-chk')) return;
    if (t.closest('.contact a, .dicons a') && !t.closest('[data-tel]')) return;   // mail and web links open as they are
    if (t.closest('.contact [data-copy]')) { e.stopPropagation(); const c = t.closest('[data-copy]'); try { await navigator.clipboard.writeText(c.dataset.copy); toast('Copied ' + c.dataset.copy); } catch { toast(c.dataset.copy); } return; }
    const a = t.closest('[data-act]');
    if (a && !a.disabled) {
        const k = a.dataset.act;
        if (k === 'more') return moreMenu();
        if (k === 'import') return importCsv();
        if ((k === 'phcall' || k === 'phtext') && st.openId) { const ld = (st.lead && st.lead.lead) || {}; const ph = ld.phone || ($('.drawer [data-field="phone"]') || {}).value;
            if (!window.ELPhone) { location.href = (k === 'phcall' ? 'tel:' : 'sms:') + String(ph).replace(/[^\d+]/g, ''); return; }
            if (k === 'phcall') return phoneTo(ph, ld.company || ld.full_name, ld.id); closeLayer(); return ELPhone.text(ph); }
        if (k === 'phdial' && st.openId && window.ELPhone) { const id = st.openId; closeLayer(); return ELPhone.dial(id); }
        if (k === 'reopen' && st.openId) { try { const r = await api('/api/crm/dialer/reopen', { method: 'POST', body: { ids: [st.openId] } }); toast(r.reopened ? 'Back in the call list, due now' : 'It cannot go back: do not call, or a wrong number.', !r.reopened); await leads(true); openLead(st.openId); } catch (err) { toast(err.message, true); } return; }
        if (k === 'undnc' && st.openId) { const ld = (st.lead && st.lead.lead) || {}; if (!confirm('Allow calls to ' + (ld.company || ld.full_name) + ' again? Only if they asked. They stay unsubscribed from email.')) return;
            try { await api('/api/crm/leads/' + st.openId, { method: 'PATCH', body: { tags: (ld.tags || []).filter(x => x !== 'Do not call') } }); await api('/api/crm/dialer/reopen', { method: 'POST', body: { ids: [st.openId] } }).catch(() => {}); toast('Calls allowed again'); await leads(true); openLead(st.openId); } catch (err) { toast(err.message, true); } return; }
        if (k === 'export') return exportCsv(st.leads.filter(l => leadFilter(l)));
        if (k === 'dellead' && st.openId) { const ld = (st.lead && st.lead.lead) || {}; return modal('Delete ' + (ld.company || ld.full_name) + '?', `<p style="margin:0;color:var(--muted)">The lead, its notes, calls logged on it and its tasks are deleted. Calls and texts on the phone stay, without the link. This cannot be undone.</p>`, 'Delete lead', async () => {
            await api('/api/crm/leads/' + st.openId, { method: 'DELETE' }); closeLayer(); toast('Deleted'); await leads(true); render(); }); }
        if (k === 'bulkdel') { const ids = [...st.sel]; return modal(`Delete ${ids.length} lead${ids.length === 1 ? '' : 's'}?`, `<p style="margin:0;color:var(--muted)">They are deleted with their notes, logged calls and tasks. Clients are left alone. This cannot be undone.</p>`, 'Delete', async () => {
            const r = await api('/api/crm/leads/bulk-delete', { method: 'POST', body: { ids } }); $('#layer').innerHTML = ''; toast(`${r.deleted} deleted${r.kept ? `, ${r.kept} clients kept` : ''}`); st.sel.clear(); await leads(true); render(); }); }
        if (k === 'bulkreopen') { const ids = [...st.sel]; try { const r = await api('/api/crm/dialer/reopen', { method: 'POST', body: { ids } }); toast(`${r.reopened} back in the call list${r.dnc ? `, ${r.dnc} do not call` : ''}${r.wrong ? `, ${r.wrong} with a wrong number` : ''}${r.clients ? `, ${r.clients} clients` : ''} left out`); st.sel.clear(); await leads(true); render(); } catch (err) { toast(err.message, true); } return; }
        if (k === 'clearsel') { st.sel.clear(); return render(); }
        if (k === 'clearf') { st.cat = st.ind = st.owner = st.q = st.out = ''; return render(); }
        if (k === 'fit') { st.fitAll = true; fit(null); st.fitAll = false; return; }
        if (k === 'lfit') return lfit(st.leads.filter(l => leadFilter(l) && l.lat != null));
        if (k === 'geocode') { try { const r = await api('/api/admin/crm/geocode', { method: 'POST', body: {} }); toast(r.queued ? `Placing ${r.queued} leads: about ${Math.ceil(r.seconds / 60)} min. Refresh after.` : 'Every lead with a city is placed already.'); } catch (err) { toast(err.message, true); } return; }
        if (k === 'bulkpipe') { const ids = [...st.sel]; try { await setPipeline(ids, true); toast(`${ids.length} lead${ids.length === 1 ? '' : 's'} added to the pipeline`); st.sel.clear(); render(); } catch (err) { toast(err.message, true); } return; }
        if (k === 'bulkcamp') return toCampaign([...st.sel]);
        if (k === 'topipe' && st.openId) { try { await setPipeline([st.openId], true); toast('In the pipeline. Email, call and text it from here on.'); openLead(st.openId); shell(); if (route === 'leads' || route === 'pipeline') render(); } catch (err) { toast(err.message, true); } return; }
        if (k === 'frompipe' && st.openId) { try { await setPipeline([st.openId], false); toast('Taken out of the pipeline'); openLead(st.openId); if (route === 'pipeline') render(); } catch (err) { toast(err.message, true); } return; }
        if (k === 'tocamp' && st.openId) return toCampaign([st.openId]);
        if (k === 'newcr') return creatorForm({}, async body => { const { influencer } = await api('/api/crm/influencers', { method: 'POST', body }); st.crOn = influencer.id; await net(true); closeLayer(); toast('@' + influencer.handle + ' added'); render(); }, 'Add a creator', 'Add creator');
        const cr = st.net && st.net.influencers.find(x => x.id === st.crOn);
        if (k === 'credit' && cr) return creatorForm(cr, async body => { await api('/api/crm/influencers/' + cr.id, { method: 'PATCH', body }); await net(true); closeLayer(); toast('Saved'); render(); }, 'Edit ' + (cr.name || '@' + cr.handle), 'Save');
        if (k === 'crpick' && cr) { st.picking = { kind: 'creator', id: cr.id, label: cr.name || '@' + cr.handle }; return render(); }
        if (k === 'crpost' && cr) return modal('Log a post by ' + (cr.name || '@' + cr.handle), `<div class="field"><label for="po-c">For client</label><select id="po-c">${st.net.clients.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
              <div class="grid2">${fieldHtml('po-d', 'Posted on', `type="date" value="${new Date().toISOString().slice(0, 10)}"`)}${fieldHtml('po-v', 'Views', 'type="number" min="0"')}</div>${fieldHtml('po-u', 'Link to the post', 'type="url" placeholder="https://instagram.com/p/…"')}`, 'Log post', async () => {
                await api('/api/crm/influencers/' + cr.id + '/posts', { method: 'POST', body: { client_id: v('po-c'), posted_at: v('po-d'), views: v('po-v'), url: v('po-u') } }); await net(true); closeLayer(); toast('Post logged'); render(); });
        if (k === 'convert' && st.openId) { const { lead: fresh } = await api('/api/crm/leads/' + st.openId); return convertLead(fresh); }
        if (k === 'tonet' && st.openId) return modal('Add to the influencer network', `${fieldHtml('tn-h', 'Their Instagram handle or link', 'placeholder="@handle"')}<div class="grid2">${fieldHtml('tn-f', 'Followers', 'type="number"')}${fieldHtml('tn-ni', 'Niche', 'placeholder="Food, fashion…"')}</div>`, 'Add to network', async () => {
            const { influencer } = await api('/api/crm/leads/' + st.openId + '/influencer', { method: 'POST', body: { handle: v('tn-h'), followers: v('tn-f'), niche: v('tn-ni') } }); st.net = null; toast('@' + influencer.handle + ' is in the network'); openLead(st.openId); });
        if (k === 'csave' && st.openId) {
            const body = $('#cbody').value.trim();
            try {
                if (ctab === 'task') { if (!body) throw new Error('Write what needs doing.'); await api('/api/crm/tasks', { method: 'POST', body: { lead_id: st.openId, title: body, due_at: v('c-due') ? new Date(v('c-due')).toISOString() : null } }); }
                else await api('/api/crm/leads/' + st.openId + '/activities', { method: 'POST', body: { type: ctab, body, minutes: v('c-min'), outcome: v('c-out') } });
                toast('Saved'); openLead(st.openId); leads(true).then(shell);
            } catch (err) { toast(err.message, true); }
            return;
        }
        if (CRM.onAct[k]) return CRM.onAct[k](a, e);
        return;
    }
    const ct = t.closest('[data-ctab]'); if (ct) return setCtab(ct.dataset.ctab);
    const sg = t.closest('.stepper [data-stage]'); if (sg && st.openId) {
        const to = sg.dataset.stage;
        if (to === 'won') { const { lead } = await api('/api/crm/leads/' + st.openId); return convertLead(lead); }
        try { await api('/api/crm/leads/' + st.openId, { method: 'PATCH', body: { stage: to } }); toast('Moved to ' + (st.meta.stages.find(s => s.key === to) || {}).label); openLead(st.openId); leads(true).then(() => route !== 'overview' && !MODULES[route] && render()); } catch (err) { toast(err.message, true); }
        return;
    }
    const td = t.closest('[data-taskdone]'); if (td) { await api('/api/crm/tasks/' + td.dataset.taskdone, { method: 'PATCH', body: { done: true } }); toast('Done'); return openLead(st.openId); }
    const td2 = t.closest('[data-taskdone2]'); if (td2) { td2.disabled = true; try { await api('/api/crm/tasks/' + td2.dataset.taskdone2, { method: 'PATCH', body: { done: true } }); toast('Done'); render(); } catch (err) { toast(err.message, true); td2.disabled = false; } return; }
    const cp = t.closest('[data-copy]'); if (cp) { try { await navigator.clipboard.writeText(cp.dataset.copy); toast('Copied'); } catch { toast(cp.dataset.copy); } return; }
    const sc = t.closest('[data-crstage]'); if (sc) { st.crStage = sc.dataset.crstage; return render(); }
    const cg = t.closest('[data-crgo]'); if (cg) { st.crOn = cg.dataset.crgo; closeLayer(); location.hash = 'influencers'; return render(); }
    const crr = t.closest('[data-cr]'); if (crr) { st.crOn = crr.dataset.cr; return render(); }
    const pcl = t.closest('[data-pinclient]'); if (pcl) { e.preventDefault(); st.picking = { kind: 'client', id: pcl.dataset.pinclient, label: pcl.dataset.name }; location.hash = 'influencers'; return; }
    const o = t.closest('[data-open]'); if (o) { $('#sub') && ($('#sub').innerHTML = ''); return openLead(o.dataset.open); }
});
document.addEventListener('change', async e => {
    const t = e.target;
    if (t.matches('[data-field]') && st.openId && t.closest('.drawer')) return saveField(t);
    if (t.matches('[data-bulk]') && t.value) { try { await api('/api/crm/leads/bulk', { method: 'POST', body: { ids: [...st.sel], set: { [t.dataset.bulk]: t.value } } }); toast(st.sel.size + ' leads updated'); st.sel.clear(); await leads(true); render(); } catch (err) { toast(err.message, true); } return; }
    if (t.id === 'crcountry') { st.crCountry = t.value; return render(); }
    if (t.id === 'fcat') { st.cat = t.value; st.sel.clear(); return render(); }
    if (t.id === 'find') { st.ind = t.value; st.sel.clear(); return render(); }
    if (t.id === 'fown') { st.owner = t.value; st.sel.clear(); return render(); }
    if (t.id === 'fout') { st.out = t.value; st.sel.clear(); return render(); }
    if (t.id === 'pown') { st.pOwner = t.value; return render(); }
});
document.addEventListener('input', e => {
    const t = e.target, key = { lq: 'q', crq: 'crQ', pq: 'pQ', cq: 'cQ' }[t.id];
    if (key) { const pos = t.selectionStart; st[key] = t.value; clearTimeout(t._d); t._d = setTimeout(async () => { await render(); const n = $('#' + t.id); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }, 200); }
});
document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); palette(); }
    else if (e.key === 'Escape') { if ($('#sub') && $('#sub').innerHTML) $('#sub').innerHTML = ''; else closeLayer(); if (st.picking) { st.picking = null; render(); } }
    else if (e.key.toLowerCase() === 'n' && !e.target.matches('input,textarea,select,[contenteditable]') && !$('#layer').innerHTML && !e.metaKey && !e.ctrlKey && !MODULES[route]) newLead();
});
document.addEventListener('dragstart', e => { const c = e.target.closest && e.target.closest('[data-drag]'); if (c) e.dataTransfer.setData('text/plain', c.dataset.drag); });
document.addEventListener('dragover', e => { const c = e.target.closest && e.target.closest('.board .col'); if (c) { e.preventDefault(); c.classList.add('drop'); } });
document.addEventListener('dragleave', e => { const c = e.target.closest && e.target.closest('.board .col'); if (c && !c.contains(e.relatedTarget)) c.classList.remove('drop'); });
document.addEventListener('drop', async e => {
    const c = e.target.closest && e.target.closest('.board .col'); if (!c) return; e.preventDefault(); c.classList.remove('drop');
    const id = e.dataTransfer.getData('text/plain'), to = c.dataset.col, l = st.leads.find(x => x.id === id); if (!l || l.stage === to) return;
    if (to === 'won') { st.openId = id; $('#layer').innerHTML = '<div id="sub"></div>'; const { lead } = await api('/api/crm/leads/' + id); return convertLead(lead); }
    try { await api('/api/crm/leads/' + id, { method: 'PATCH', body: { stage: to } }); await leads(true); render(); toast((l.company || l.full_name) + ' moved'); } catch (err) { toast(err.message, true); }
});
function palette() {
    const items = [...(st.leads || []).slice(0, 600).map(l => ({ g: 'Leads', t: (l.company || l.full_name) + (l.company && l.full_name !== '-' ? ' · ' + l.full_name : ''), s: l.industry || srcOf(l.source).label, go: () => { closeLayer(); openLead(l.id); } })),
        ...NAV.filter(n => n[0] !== 'admin' || isAdmin()).map(([k, l]) => ({ g: 'Go to', t: l, s: '', go: () => { closeLayer(); location.hash = k; } })),
        { g: 'Actions', t: 'New lead', s: 'N', go: () => { closeLayer(); newLead(); } }, { g: 'Actions', t: 'Import CSV', s: '', go: () => { closeLayer(); importCsv(); } },
        { g: 'Actions', t: 'New email campaign', s: '', go: () => { closeLayer(); location.hash = 'campaigns/new'; } }];
    $('#layer').innerHTML = `<div class="scrim" data-close></div><div class="modal pal" role="dialog" aria-modal="true" aria-label="Search"><input id="palIn" placeholder="Search leads, pages, actions" autocomplete="off" aria-label="Search"><div class="res" id="palRes"></div></div><div id="sub"></div>`;
    let cur = 0, shown = [];
    const draw = q => { q = q.toLowerCase(); shown = items.filter(i => i.t.toLowerCase().includes(q) || String(i.s).toLowerCase().includes(q)).slice(0, 12); cur = Math.max(0, Math.min(cur, shown.length - 1)); let g = '';
        $('#palRes').innerHTML = shown.map((i, n) => { const h = i.g !== g ? `<div class="grp">${i.g}</div>` : ''; g = i.g; return h + `<button type="button" data-i="${n}" class="${n === cur ? 'on' : ''}">${esc(i.t)}<small>${esc(i.s)}</small></button>`; }).join('') || '<div class="empty">Nothing matches.</div>'; };
    const inp = $('#palIn'); inp.focus(); draw('');
    inp.oninput = () => { cur = 0; draw(inp.value); };
    inp.onkeydown = ev => { if (ev.key === 'ArrowDown') { cur++; draw(inp.value); ev.preventDefault(); } if (ev.key === 'ArrowUp') { cur--; draw(inp.value); ev.preventDefault(); } if (ev.key === 'Enter' && shown[cur]) shown[cur].go(); };
    $('#palRes').onclick = ev => { const b = ev.target.closest('[data-i]'); if (b) shown[+b.dataset.i].go(); };
}
const makePass = () => { const a = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const b = new Uint32Array(14); crypto.getRandomValues(b); return [...b].map(x => a[x % a.length]).join(''); };

// ------------------------------------------------------------------ what the lazily loaded pages use
const CRM = window.CRM = { api, esc, ic, toast, st, $, money, lakh, num, kfmt, pct, initials, ago, dueLabel, dayLabel, teamName, srcOf, srcChip, stageChip, indChip, indVar, stateChip, leadState, inPipe, feat,
    isAdmin, p90, leads, industries, modal, fieldHtml, v, openLead, render, shell, makePass, closeLayer, countBy, toBdt, ICONS, need, phoneTo, cname,
    token: async () => (await sb.auth.getSession()).data.session.access_token, toolsState,
    views: {}, mounted: {}, onAct: {}, get route() { return route; }, get arg() { return routeArg; }, backend: BACKEND };

// ------------------------------------------------------------------ boot
(async function boot() {
    try { const th = localStorage.getItem('crm-theme'); if (th) document.documentElement.dataset.theme = th; if (localStorage.getItem('crm-rail') === 'mini') document.documentElement.dataset.rail = 'mini'; } catch {}
    const { data } = await sb.auth.getSession();
    if (AUTH_LINK && data.session) { history.replaceState(null, '', location.pathname); return setPassword(); }
    if (!data.session) return signIn();
    if (standalone() && !appUnlocked()) return appLock(data.session.user.email || '');
    if (!window.EL_PHONE_ONLY && (location.pathname !== '/' || location.hash.includes('access_token'))) history.replaceState(null, '', '/' + (location.hash.includes('access_token') ? '' : location.hash));
    // Phase 93: draw at once from the settings this browser saw last (same person, under 12 hours old), and fetch the
    // fresh ones alongside; without them, wait for the server as before.
    const META = 'crm-meta-v1';
    let cached = null; try { cached = JSON.parse(localStorage.getItem(META) || 'null'); } catch {}
    const fresh = api('/api/crm/meta');
    const keep = m => { try { localStorage.setItem(META, JSON.stringify({ at: Date.now(), uid: data.session.user.id, meta: m })); } catch {} };
    const refused = async e => {
        if (e.status === 403) { try { localStorage.removeItem(META); } catch {} await sb.auth.signOut(); signIn('This workspace is for the EdgeLead team only.'); return true; }
        if (e.status === 401) { await sb.auth.signOut(); signIn('Your session ended. Sign in again.'); return true; }
        return false;
    };
    if (cached && cached.uid === data.session.user.id && Date.now() - cached.at < 12 * 3600e3 && cached.meta && cached.meta.me) {
        st.meta = cached.meta;
        fresh.then(m => { const changed = JSON.stringify(m) !== JSON.stringify(st.meta); st.meta = m; keep(m); if (changed) { shell(); if (['admin', 'campaigns', 'dialer'].includes(route)) render(); } }).catch(refused);
    } else {
        try { st.meta = await fresh; keep(st.meta); }
        catch (e) {
            if (await refused(e)) return;
            $('#view').innerHTML = `<div class="empty err">Could not reach the server: ${esc(e.message)} <button class="btn sm" type="button" onclick="location.reload()">Try again</button></div>`; return;
        }
    }
    if (window.EL_PHONE_ONLY) document.body.classList.add('phone-only');
    if (window.ELPhone) ELPhone.init({ api, toast, esc, initials, teamName, route: () => route, backend: BACKEND, token: async () => (await sb.auth.getSession()).data.session.access_token, newLead: pre => newLead(pre), openLead, isAdmin, feat }).then(() => { if (route === 'calls' || route === 'dialer') render(); shell(); });
    addEventListener('hashchange', render);
    render();
    leads().then(shell).catch(() => {});
})();
})();
