/**
 * EdgeLead CRM (phase 87): one page, its own small script. It does not load header.js.
 * Views live in the address hash: #overview, #leads, #pipeline, #sequences, #influencers, #clients, #settings.
 * Every number and record comes from /api/crm/* on the server (src/25-crm.js).
 */
(function () {
'use strict';
const SUPABASE_URL = 'https://sasbwgollyjpwegsbrty.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNhc2J3Z29sbHlqcHdlZ3NicnR5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4Mjg1MjEsImV4cCI6MjEwMTQwNDUyMX0.Ha6uDWqzC-T1Q49TE8WaqyjulPLntwt-2dSaknVtuKY';
const BACKEND = 'https://leadgen-backend-1-mgzc.onrender.com';
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';
// A password reset or invite link lands here with its token in the address (welcome.html is served by this page).
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
    shield: '<path d="M12 3 4.5 6v6c0 4.5 3.2 7.8 7.5 9 4.3-1.2 7.5-4.5 7.5-9V6z"/><path d="m9 12 2 2 4-4"/>', search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>', task: '<path d="m5 12 5 5L20 7"/>', meet: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>', fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'
};
const ic = k => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[k] || ''}</svg>`;
function toast(t, bad) { const el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); if (bad) el.style.background = 'var(--bad)'; el.textContent = t; document.body.appendChild(el); setTimeout(() => el.remove(), 3200); }

// ------------------------------------------------------------------ data
async function api(path, { method = 'GET', body } = {}) {
    const { data } = await sb.auth.getSession();
    if (!data.session) { signIn(); throw new Error('Signed out'); }
    const r = await fetch(BACKEND + path, { method, headers: { Authorization: 'Bearer ' + data.session.access_token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || `The server answered ${r.status}.`); e.status = r.status; e.data = j; throw e; }
    return j;
}
const st = { meta: null, leads: null, overview: {}, period: 30, filter: 'all', q: '', sel: new Set(), net: null, crOn: null, crStage: 'all', crQ: '', crCountry: 'all', picking: null, openId: null };
const teamName = id => { const t = st.meta && st.meta.team.find(x => x.id === id); return t ? t.name : '—'; };
const srcOf = k => st.meta.sources.find(s => s.key === k) || { key: k, label: k };
const srcChip = k => { const s = srcOf(k); return `<span class="src" style="--c:var(${SRC_VAR[k] || '--s-other'})" title="${esc(s.path || s.label)}"><i></i><b>${esc(s.label)}</b></span>`; };
const stageChip = k => `<span class="stg" style="--c:var(${STAGE_VAR[k] || '--dim'})">${esc((st.meta.stages.find(s => s.key === k) || { label: k }).label)}</span>`;
async function leads(force) { if (!st.leads || force) st.leads = (await api('/api/crm/leads')).leads; return st.leads; }
const isAdmin = () => st.meta && st.meta.me.role === 'admin';

// ------------------------------------------------------------------ shell
const NAV = [['overview', 'Overview', 'overview'], ['leads', 'Leads', 'leads'], ['pipeline', 'Pipeline', 'pipeline'], ['sequences', 'Sequences', 'seq'], ['influencers', 'Influencers', 'pin'], ['phone', 'Phone', 'phone'], ['clients', 'Clients', 'clients'], ['settings', 'Settings', 'settings'], ['admin', 'Admin', 'shield']];
let route = 'overview';
function shell() {
    const open = (st.leads || []).filter(l => !['won', 'lost'].includes(l.stage)).length;
    const due = (st.leads || []).filter(l => l.next_step_at && new Date(l.next_step_at) < startOfTomorrow() && !['won', 'lost'].includes(l.stage)).length;
    const toolsOn = st.meta ? Object.values(st.meta.tools || {}).filter(Boolean).length : 0;
    $('#rail').innerHTML = `<div class="brand"><b>E</b>EdgeLead</div>` +
        NAV.slice(0, 6).map(([k, l, i]) => `<a href="#${k}" class="${route === k ? 'on' : ''}" ${route === k ? 'aria-current="page"' : ''}>${ic(i)}${l}${k === 'overview' && due ? `<span class="ct hot" title="Follow-ups due">${due}</span>` : k === 'leads' && st.leads ? `<span class="ct">${open}</span>` : k === 'phone' ? `<span class="ct hot" data-phbadge ${window.ELPhone && ELPhone.unread() ? '' : 'hidden'}>${window.ELPhone ? ELPhone.unread() || '' : ''}</span>` : ''}</a>`).join('') +
        `<div class="grp">Business</div>` + NAV.slice(6).filter(n => n[0] !== 'admin' || isAdmin()).map(([k, l, i]) => `<a href="#${k}" class="${route === k ? 'on' : ''}">${ic(i)}${l}</a>`).join('') +
        `<div class="foot"><span>${esc(teamName(st.meta.me.id))} · ${isAdmin() ? 'Owner' : 'Team'}</span><button class="btn sm ghost" id="theme" type="button">Light / dark</button><button class="btn sm ghost" id="signout" type="button">Sign out</button></div>`;
    $('#tabbar').innerHTML = NAV.filter(n => ['overview', 'leads', 'pipeline', 'phone', 'influencers'].includes(n[0])).map(([k, l, i]) => `<a href="#${k}" class="${route === k ? 'on' : ''}">${ic(i)}${l}</a>`).join('');
}
async function render() {
    route = window.EL_PHONE_ONLY ? 'phone' : (location.hash || '#overview').slice(1).split('?')[0];
    if (!NAV.some(n => n[0] === route) || (route === 'admin' && !isAdmin())) route = 'overview';
    if (route !== 'influencers' && mapObj) { mapObj.remove(); mapObj = null; }
    shell();
    const v = $('#view');
    try {
        const html = await ({ overview: vOverview, leads: vLeads, pipeline: vPipeline, sequences: vSequences, influencers: vInfluencers, clients: vClients, settings: vSettings, admin: vAdmin, phone: async () => window.ELPhone ? ELPhone.view() : '' }[route])();
        v.innerHTML = html; shell();
        if (route === 'influencers') mapInit();
        if (route === 'phone' && window.ELPhone) ELPhone.mounted();
    } catch (e) { v.innerHTML = `<div class="empty err">Could not load this page: ${esc(e.message)} <button class="btn sm" type="button" onclick="location.reload()">Try again</button></div>`; }
}

// ------------------------------------------------------------------ overview
const sparkSvg = (arr, c) => { const w = 120, h = 26, mx = Math.max(1, ...arr), pts = arr.map((v, i) => [i * w / Math.max(1, arr.length - 1), h - 3 - v / mx * (h - 6)]);
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(''); const e = pts[pts.length - 1];
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}L${w} ${h}L0 ${h}Z" fill="var(${c})" opacity=".12"/><path d="${d}" fill="none" stroke="var(${c})" stroke-width="1.6" vector-effect="non-scaling-stroke"/><circle cx="${e[0]}" cy="${e[1]}" r="2.2" fill="var(${c})"/></svg>`; };
async function vOverview() {
    const [o] = await Promise.all([api('/api/crm/overview?days=' + st.period), leads()]);
    const T = o.totals, hr = new Date().getHours();
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
    return `<div class="head"><div><p class="greet">Good ${hr < 12 ? 'morning' : hr < 17 ? 'afternoon' : 'evening'}, ${esc(teamName(st.meta.me.id).split(' ')[0])}.</p>
        <p class="sub">${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })} · ${o.upNext.filter(l => new Date(l.next_step_at) < startOfTomorrow()).length} follow-ups due today</p></div><div class="sp"></div>
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

// ------------------------------------------------------------------ leads
const VIEWS = [['all', 'All open', l => !['won', 'lost'].includes(l.stage)], ['mine', 'Mine', l => l.owner_id === st.meta.me.id && !['won', 'lost'].includes(l.stage)],
    ['due', 'Due', l => l.next_step_at && new Date(l.next_step_at) < startOfTomorrow() && !['won', 'lost'].includes(l.stage)], ['website', 'Website', l => l.source === 'website'], ['seo', 'SEO', l => l.source === 'seo'],
    ['ads', 'Ads', l => ['ads_google', 'ads_meta'].includes(l.source)], ['marketing', 'Marketing', l => ['ads_google', 'ads_meta', 'social', 'email'].includes(l.source)], ['influencer', 'Influencer', l => l.source === 'influencer'],
    ['other', 'Referral & other', l => ['referral', 'other'].includes(l.source)], ['closed', 'Won & lost', l => ['won', 'lost'].includes(l.stage)]];
async function vLeads() {
    await leads();
    const f = (VIEWS.find(v => v[0] === st.filter) || VIEWS[0])[2], q = st.q.toLowerCase();
    const rows = st.leads.filter(f).filter(l => !q || [l.full_name, l.company, l.email, l.phone, l.city].join(' ').toLowerCase().includes(q));
    return `<div class="head"><div><h1>Leads</h1><p class="sub">Cold leads until they sign. Convert a won lead and it becomes a client.</p></div><div class="sp"></div>
        <input class="btn" style="cursor:text;min-width:220px" id="lq" type="search" placeholder="Filter by name, business, email" value="${esc(st.q)}" aria-label="Filter leads"><button class="btn" type="button" data-act="import">Import CSV</button></div>
      <div class="views" role="tablist">${VIEWS.map(([k, l, fn]) => `<button type="button" role="tab" aria-selected="${st.filter === k}" class="${st.filter === k ? 'on' : ''}" data-view="${k}">${l}<span class="c">${st.leads.filter(fn).length}</span></button>`).join('')}</div>
      <div class="card tablewrap">${rows.length ? `<table class="ltbl"><thead><tr><th style="width:36px"><input type="checkbox" class="chk" id="selall" aria-label="Select all"></th><th>Lead</th><th>Source</th><th>Stage</th><th>Next step</th><th>Value</th><th>Score</th><th>Owner</th><th>Last activity</th></tr></thead><tbody>
        ${rows.map(l => `<tr data-open="${l.id}"><td class="c-chk"><input type="checkbox" class="chk" data-sel="${l.id}" ${st.sel.has(l.id) ? 'checked' : ''} aria-label="Select ${esc(l.full_name)}"></td>
          <td class="c-who who"><b>${esc(l.full_name)}</b><span>${esc([l.company, l.city].filter(Boolean).join(' · ') || l.email || '')}</span></td><td class="c-src">${srcChip(l.source)}</td><td class="c-stage">${stageChip(l.stage)}</td>
          <td class="c-due">${dueLabel(l.next_step_at)}</td><td class="c-val num">${money(l.value, l.currency)}</td><td class="c-score">${l.score == null ? '—' : `<span class="score" style="--v:${l.score}%"><i></i>${l.score}</span>`}</td>
          <td class="c-owner"><span class="ava" title="${esc(teamName(l.owner_id))}">${initials(teamName(l.owner_id))}</span></td><td class="c-last" style="color:var(--muted);font-size:12.5px;white-space:nowrap">${l.last_activity_at ? ago(l.last_activity_at) : '—'}</td></tr>`).join('')}
        </tbody></table>` : `<div class="empty">${st.leads.length ? 'No leads in this view.' : 'No leads yet. Add one with New lead, or import a CSV.'}</div>`}</div>
      ${st.sel.size ? `<div class="bulk"><span>${st.sel.size} selected</span>
        <select class="btn sm" data-bulk="stage" aria-label="Move to stage"><option value="">Move to…</option>${st.meta.stages.filter(s => s.key !== 'won').map(s => `<option value="${s.key}">${s.label}</option>`).join('')}</select>
        <select class="btn sm" data-bulk="owner_id" aria-label="Assign to"><option value="">Assign to…</option>${st.meta.team.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select>
        <button class="btn sm" type="button" data-act="clearsel">Clear</button></div>` : ''}`;
}

// ------------------------------------------------------------------ pipeline
async function vPipeline() {
    await leads();
    return `<div class="head"><div><h1>Pipeline</h1><p class="sub">Drag a lead to move it. Dropping on Won asks to create the client.</p></div></div>
      <div class="board">${st.meta.stages.map(s => { const ls = st.leads.filter(l => l.stage === s.key); const sum = ls.reduce((a, l) => a + (Number(l.value) || 0) * ({ BDT: 1, USD: 120, GBP: 152, EUR: 130, CAD: 87, AUD: 79, INR: 1.4 }[l.currency] || 1), 0);
        return `<div class="col" data-col="${s.key}"><div class="col-h"><i style="width:8px;height:8px;border-radius:50%;background:var(${STAGE_VAR[s.key]})"></i><b>${s.label}</b><span>${ls.length} · ${lakh(sum)}</span></div>
          ${ls.slice(0, 80).map(l => `<div class="deal" draggable="true" data-drag="${l.id}" data-open="${l.id}"><b>${esc(l.company || l.full_name)}</b><span style="color:var(--muted);font-size:12.5px">${esc(l.full_name)}</span><div class="m">${srcChip(l.source)}<span class="v">${money(l.value, l.currency)}</span></div><div class="m">${dueLabel(l.next_step_at)}<span class="ava">${initials(teamName(l.owner_id))}</span></div></div>`).join('')}
          ${ls.length > 80 ? `<div class="empty" style="padding:8px">+${ls.length - 80} more in Leads</div>` : ''}</div>`; }).join('')}</div>`;
}

// ------------------------------------------------------------------ sequences (email automation: next phase)
async function vSequences() {
    return `<div class="head"><div><h1>Sequences</h1><p class="sub">Email steps that send on their own and stop when someone replies.</p></div></div>
      <div class="banner">${ic('mail')}<div><b style="color:var(--ink)">Email automation is the next phase.</b> It needs a mailbox on your own domain, ideally Google Workspace on edgelead.online, so replies are detected and your main inbox is never at risk.</div></div>
      <section class="card"><div class="card-h"><h2>What arrives with it</h2></div><div class="list">
        ${[['Sequences', 'Email, wait, follow-up and task steps, per department'], ['Send windows and daily caps', 'Per mailbox, in the lead\'s own time zone'], ['Stops on reply, meeting or unsubscribe', 'Replies land on the lead\'s timeline and move it to Replied'],
           ['Open and click tracking', 'Counted on the Overview, by department'], ['Unsubscribe link in every email', 'Unsubscribed leads are never emailed again']].map(([a, b]) => `<div class="row" style="cursor:default"><span class="kind">${ic('seq')}</span><div class="t"><b>${a}</b><span>${b}</span></div></div>`).join('')}
      </div></section>`;
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
function mapInit() {
    const el = $('#map'); if (!el || !window.maplibregl) { if (el) el.innerHTML = '<div class="empty">The map could not load. Check the connection and refresh.</div>'; return; }
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

// ------------------------------------------------------------------ clients
async function vClients() {
    const [{ clients }] = await Promise.all([api('/api/clients'), leads(), net()]);
    const fromLead = id => st.leads.find(l => l.client_id === id);
    const loc = new Map(st.net.clients.map(c => [c.id, c]));
    return `<div class="head"><div><h1>Clients</h1><p class="sub">Businesses we work for. A converted lead arrives here with its history.</p></div></div>
      <section class="card">${(clients || []).filter(c => !c.archived).map(c => { const l = fromLead(c.id), m = loc.get(c.id);
        return `<div class="row" style="cursor:default"><span class="kind">${ic('clients')}</span><div class="t"><b>${esc(c.name)}</b><span>${esc([c.location || [m && m.city, m && m.country].filter(Boolean).join(', '), l ? 'from a ' + srcOf(l.source).label + ' lead' : null].filter(Boolean).join(' · ') || 'No location yet')}</span></div>
          ${l ? `<button class="btn sm ghost" type="button" data-open="${l.id}">Lead history</button>` : ''}<button class="btn sm" type="button" data-pinclient="${c.id}" data-name="${esc(c.name)}">${m && m.lat != null ? 'Move pin' : 'Pin on map'}</button></div>`; }).join('') || '<div class="empty">No clients yet.</div>'}</section>`;
}

// ------------------------------------------------------------------ settings
async function vSettings() {
    const tree = st.meta.sources;
    return `<div class="head"><div><h1>Settings</h1><p class="sub">How the CRM is set up.${isAdmin() ? ' People and tools are in Admin.' : ''}</p></div></div>
      <div class="set">
        <section class="card"><div class="card-h"><h2>Lead sources</h2><span>Every lead has one</span></div><div class="tree">
          ${tree.filter(s => s.dept !== 'marketing').slice(0, 2).map(s => `<div>${srcChip(s.key)}</div>`).join('')}<div><span class="src"><b>Marketing</b></span></div><div class="l2"><span class="src"><b>Ads</b></span></div>
          ${['ads_google', 'ads_meta'].map(k => `<div class="l3">${srcChip(k)}</div>`).join('')}${['social', 'email'].map(k => `<div class="l2">${srcChip(k)}</div>`).join('')}${['influencer', 'referral', 'other'].map(k => `<div>${srcChip(k)}</div>`).join('')}</div></section>
        <section class="card"><div class="card-h"><h2>Team</h2><span>${st.meta.team.length} people</span></div>${st.meta.team.map(m => `<div class="opt"><span class="ava">${initials(m.name)}</span><div class="t"><b>${esc(m.name)}</b><span>${m.role === 'admin' ? 'Owner' : 'Team'}</span></div></div>`).join('')}
          ${isAdmin() ? '<div class="opt"><div class="t"><span>Add, turn off or remove people in Admin.</span></div><a class="btn sm" href="#admin">Admin</a></div>' : ''}</section>
        <section class="card"><div class="card-h"><h2>Mailboxes</h2><span>Next phase</span></div><div class="opt"><div class="t"><b>Email automation</b><span>Connect a Google Workspace mailbox on edgelead.online to send sequences.</span></div><button class="btn sm" type="button" disabled>Coming next</button></div></section>
        <section class="card"><div class="card-h"><h2>Calling</h2><span>After email</span></div><div class="opt"><div class="t"><b>Twilio dialer</b><span>Call from a lead's record; every call recorded and logged.</span></div><button class="btn sm" type="button" disabled>Coming next</button></div></section>
      </div>`;
}


// ------------------------------------------------------------------ admin (the owner only; the server checks too)
async function vAdmin() {
    const [{ users }, { tools }, ph] = await Promise.all([api('/api/admin/users'), api('/api/admin/tools'), api('/api/admin/phone/usage').catch(e => ({ error: e.message }))]);
    const staff = users.filter(u => u.role !== 'client').sort((a, b) => (b.role === 'admin') - (a.role === 'admin') || (a.full_name || a.email).localeCompare(b.full_name || b.email));
    const owners = users.filter(u => u.role === 'client');
    const me = st.meta.me.id;
    const person = u => `<div class="opt person ${u.is_active ? '' : 'off'}"><span class="ava">${initials(u.full_name || u.email)}</span>
        <div class="t"><b>${esc(u.full_name || u.email.split('@')[0])}${u.id === me ? ' <small class="pill">you</small>' : ''}</b><span>${esc(u.email)} · ${u.role === 'admin' ? 'Owner' : u.role === 'client' ? 'Client login' : 'Team'}${u.is_active ? '' : ' · turned off'} · added ${new Date(u.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span></div>
        ${u.id === me ? '' : `<div class="acts2"><button class="btn sm" type="button" data-uact="pass" data-uid="${u.id}" data-name="${esc(u.full_name || u.email)}">New password</button>
          <button class="btn sm" type="button" data-uact="${u.is_active ? 'off' : 'on'}" data-uid="${u.id}">${u.is_active ? 'Turn off' : 'Turn on'}</button>
          <button class="btn sm ghost danger" type="button" data-uact="remove" data-uid="${u.id}" data-name="${esc(u.full_name || u.email)}">Remove</button></div>`}</div>`;
    const tools_ = tools;
    return `<div class="head"><div><h1>Admin</h1><p class="sub">Only you can open this. Teammates use the CRM but cannot see or change any of this.</p></div></div>
      <div class="set">
        <section class="card"><div class="card-h"><h2>Team</h2><span>${staff.filter(u => u.is_active).length} active</span></div>
          ${staff.map(person).join('')}
          <form class="addp" id="addp" autocomplete="off"><div class="card-h" style="padding:0 0 4px"><span class="lbl">Add a teammate</span></div>
            <div class="grid3">${fieldHtml('ap-n', 'Name', 'placeholder="Full name"')}${fieldHtml('ap-e', 'Email', 'type="email" placeholder="name@edgelead.online"')}
            <div class="field"><label for="ap-p">Password</label><div class="inline"><input id="ap-p" type="text" minlength="8" placeholder="8 characters or more"><button class="btn sm" type="button" data-act="genpass">Make one</button></div></div></div>
            <div class="bar"><span class="note" style="margin:0">They sign in at workspace.edgelead.online with this email and password, and see the CRM only.</span><button class="btn pri" type="submit">Add teammate</button></div>
            <div id="ap-out"></div></form></section>
        ${phoneUsage(ph)}
        ${tools_ ? `<section class="card"><div class="card-h"><h2>Social media tools</h2><span>${tools_.filter(t => t.on).length ? tools.filter(t => t.on).length + ' on' : 'All off'}</span></div>
          <p class="note" style="margin:0 16px 8px">While a tool is off its pages stop working and nothing runs for it in the background: no Apify runs, no scheduled reports, no Meta sync. Turning Edge Meta AI or reports on or off restarts the server, about a minute.</p>
          ${tools_.map(t => `<div class="opt"><div class="t"><b>${esc(t.label)}</b><span>${esc(t.detail)}</span></div><label class="sw"><input type="checkbox" data-tool="${t.key}" ${t.on ? 'checked' : ''} aria-label="${esc(t.label)}"><i></i></label></div>`).join('')}</section>` : ''}
        ${owners.length ? `<section class="card"><div class="card-h"><h2>Client logins</h2><span>From the old Edge Meta AI</span></div>
          <p class="note" style="margin:0 16px 8px">Business owners who had their own login. They cannot use the CRM; the old pages they used are closed for now.</p>${owners.map(person).join('')}</section>` : ''}
      </div>`;
}
function phoneUsage(u) {
    if (!u || u.error) return `<section class="card"><div class="card-h"><h2>Phone</h2><span>Usage</span></div><div class="empty">${esc((u && u.error) || 'Not available yet.')}</div></section>`;
    const O = u.ours, tw = Array.isArray(u.twilio) ? Object.fromEntries(u.twilio.map(r => [r.category, r])) : null;
    const usd = v => '$' + (Number(v) || 0).toFixed(2);
    const month = new Date(u.month + '-01T00:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const tile = (l, v, sub) => `<div><small>${l}</small><b>${v}</b>${sub ? `<em>${sub}</em>` : ''}</div>`;
    return `<section class="card phu"><div class="card-h"><h2>Phone · ${esc(u.number)}</h2><span class="phstate ${u.ready ? 'ready' : 'error'}"><i></i>${u.ready ? 'Live' : 'Not set up'}</span></div>
      <div class="phu-t">${tile('Twilio spend · ' + esc(month), tw ? usd((tw.totalprice || {}).price) : '—', u.balance ? 'Balance ' + usd(u.balance.amount) : (u.twilio && u.twilio.error ? esc(u.twilio.error) : ''))}
        ${tile('Calls in', num(O.callsIn), num(O.minutesIn) + ' min · ' + num(O.missed) + ' missed')}${tile('Calls out', num(O.callsOut), num(O.minutesOut) + ' min')}
        ${tile('Voicemails', num(O.voicemails), '')}${tile('Texts', num(O.textsIn + O.textsOut), num(O.textsOut) + ' sent · ' + num(O.textsIn) + ' received')}</div>
      ${tw ? `<div class="phu-b">${[['calls', 'Phone calls'], ['calls-client', 'In-app calling'], ['sms', 'Texts'], ['phonenumbers', 'Number rental'], ['recordings', 'Recordings'], ['transcriptions', 'Transcriptions']].map(([k, l]) => `<div><span>${l}</span><span class="num">${num(Math.round((tw[k] || {}).usage || 0))} ${esc((tw[k] || {}).unit || '')}</span><b class="num">${usd((tw[k] || {}).price)}</b></div>`).join('')}</div>` : ''}
      <div class="tablewrap"><table class="dept team" style="min-width:0"><thead><tr><th>Person</th><th>Calls made</th><th>Minutes</th><th>Answered</th><th>Texts sent</th></tr></thead><tbody>
        ${u.people.map(p => `<tr><td><span class="nm"><span class="ava">${initials(p.name)}</span>${esc(p.name)}</span></td><td>${num(p.callsOut)}</td><td>${num(p.minutesOut)}</td><td>${num(p.answered)}</td><td>${num(p.texts)}</td></tr>`).join('')}</tbody></table></div>
      <div class="phu-s"><div class="opt"><div class="t"><b>Texting</b><span>${u.sms ? 'On' : 'Off until the number is approved for business texting (A2P 10DLC). Then set PHONE_SMS_ENABLED=1 on the server.'}</span></div></div>
        <div class="opt"><div class="t"><b>Forward unanswered calls</b><span>${u.forward ? 'To ' + esc(u.forward) + ' for 20 seconds, then voicemail' : 'Off. Set PHONE_FORWARD_TO on the server to try a mobile before voicemail.'}</span></div></div>
        ${u.missing.length ? `<div class="opt"><div class="t"><b>Missing on the server</b><span class="mono">${u.missing.map(esc).join(' · ')}</span></div></div>` : ''}
        <div class="opt"><div class="t"><b>In Twilio, “A call comes in” and the TwiML App's voice URL</b><span class="mono">${esc(u.hooks.voice)}</span></div><button class="btn sm" type="button" data-copy="${esc(u.hooks.voice)}">Copy</button></div>
        <div class="opt"><div class="t"><b>In Twilio, “A message comes in”</b><span class="mono">${esc(u.hooks.sms)}</span></div><button class="btn sm" type="button" data-copy="${esc(u.hooks.sms)}">Copy</button></div></div>
    </section>`;
}
const makePass = () => { const a = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const b = new Uint32Array(14); crypto.getRandomValues(b); return [...b].map(x => a[x % a.length]).join(''); };

// ------------------------------------------------------------------ sign in (the CRM is the front door; index.html and welcome.html serve this page)
function authScreen(inner) {
    document.body.innerHTML = `<main class="auth"><section class="card authcard"><div class="brand"><b>E</b>EdgeLead</div>${inner}<div class="err" id="aerr" role="alert"></div></section><p class="authfoot">EdgeLead CRM · for the EdgeLead team</p></main>`;
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
        location.reload(); };
    $('#forgot').onclick = async () => { const email = v('si-e').trim(); if (!email) { $('#aerr').textContent = 'Write your email first, then press this again.'; return; }
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + '/welcome.html' });
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
        location.replace('crm.html'); };
}

// ------------------------------------------------------------------ lead record
async function openLead(id) {
    st.openId = id;
    $('#layer').innerHTML = `<div class="scrim" data-close></div><aside class="drawer" role="dialog" aria-modal="true" aria-label="Lead"><div class="boot">Loading…</div></aside><div id="sub"></div>`;
    try {
        const d = await api('/api/crm/leads/' + id); if (st.openId !== id) return;
        drawLead(d);
    } catch (e) { $('.drawer').innerHTML = `<div class="empty err">${esc(e.message)}</div>`; }
}
function drawLead({ lead: l, activities, tasks, influencers, client }) {
    const si = st.meta.stages.findIndex(s => s.key === l.stage);
    const waNum = String(l.whatsapp || l.phone || '').replace(/\D/g, '');
    const evIcon = { sms: 'reply', note: 'note', email_out: 'mail', email_in: 'reply', call: 'phone', whatsapp: 'wa', meeting: 'meet', stage: 'stage', task: 'task', system: 'note' };
    const evText = a => a.type === 'stage' ? `Moved to ${esc((st.meta.stages.find(s => s.key === (a.meta || {}).to) || { label: (a.meta || {}).to }).label)}${a.meta && a.meta.auto ? ' (a reply came in)' : ''}`
        : a.type === 'email_out' ? 'Email sent' : a.type === 'email_in' ? 'Reply received' : a.type === 'call' && !(a.meta || {}).voicemail ? `Call${a.meta && a.meta.minutes ? ' · ' + a.meta.minutes + ' min' : ''}${a.meta && a.meta.outcome ? ' · ' + esc(a.meta.outcome) : ''}`
        : a.type === 'sms' ? ((a.meta || {}).direction === 'inbound' ? 'Text received' : 'Text sent') : a.type === 'call' && (a.meta || {}).voicemail ? 'Voicemail' : a.type === 'whatsapp' ? 'WhatsApp' : a.type === 'meeting' ? 'Meeting' : a.type === 'task' ? 'Task done' : a.type === 'note' ? 'Note' : esc(a.body || 'Update');
    const sel = (field, opts, cur) => `<select data-field="${field}">${opts.map(([v, t]) => `<option value="${esc(v)}" ${String(cur ?? '') === String(v) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
    const inp = (field, val, type = 'text', ph = '') => `<input data-field="${field}" type="${type}" value="${esc(val ?? '')}" placeholder="${esc(ph)}">`;
    $('.drawer').innerHTML = `<div class="dr-h"><div class="dr-top"><span class="ava" style="width:40px;height:40px;font-size:14px">${initials(l.full_name)}</span><div class="t"><h2>${esc(l.full_name)}</h2><p class="sub">${esc([l.title, l.company].filter(Boolean).join(', ') || 'No business yet')}${l.city || l.country ? ' · ' + esc([l.city, l.country && cname(l.country)].filter(Boolean).join(', ')) : ''}</p></div><button class="btn ghost sm" type="button" data-close aria-label="Close">${ic('x')}</button></div>
      <div class="stepper" role="group" aria-label="Stage">${st.meta.stages.map((s, i) => `<button type="button" data-stage="${s.key}" class="${i < si && l.stage !== 'lost' ? 'past' : ''} ${i === si ? 'cur' : ''} ${s.key === 'lost' ? 'lost' : ''}" ${l.client_id && s.key !== 'won' ? 'disabled' : ''}>${s.label}</button>`).join('')}</div>
      <div class="acts">${l.email ? `<a class="btn sm pri" href="mailto:${esc(l.email)}">${ic('mail')}Email</a>` : ''}${waNum ? `<a class="btn sm" href="https://wa.me/${waNum}" target="_blank" rel="noopener">${ic('wa')}WhatsApp</a>` : ''}
        ${l.phone ? `<button class="btn sm" type="button" data-act="phcall">${ic('phone')}Call</button><button class="btn sm" type="button" data-act="phtext">${ic('reply')}Text</button>` : ''}
        <button class="btn sm" type="button" data-act="tonet">${ic('pin')}Add to influencer network</button>${l.client_id ? '' : `<button class="btn sm gold" type="button" data-act="convert">${ic('client')}Convert to client</button>`}</div></div>
    <div class="dr-b"><div class="feed">
      <div class="compose"><div class="tabs" role="tablist">${[['note', 'Note'], ['call', 'Log call'], ['whatsapp', 'WhatsApp'], ['email_out', 'Email sent'], ['email_in', 'Reply'], ['meeting', 'Meeting'], ['task', 'Task']].map(([k, t], i) => `<button type="button" data-ctab="${k}" class="${i ? '' : 'on'}">${t}</button>`).join('')}</div>
        <textarea id="cbody" aria-label="Write here" placeholder="Write a note"></textarea>
        <div class="inline" id="cextra" hidden></div>
        <div class="bar"><span id="chint">Saved to this lead's timeline</span><button class="btn sm pri" type="button" data-act="csave">Save</button></div></div>
      ${tasks.filter(t => !t.done_at).map(t => `<div class="ev"><span class="k" style="background:var(--gold-soft);color:var(--ink)">${ic('task')}</span><div class="x"><b>${esc(t.title)}</b><span class="w">${t.due_at ? dueLabel(t.due_at) : ''}</span> <button class="btn sm" type="button" data-taskdone="${t.id}">Done</button></div></div>`).join('')}
      ${activities.map(a => `<div class="ev"><span class="k ${a.type === 'email_out' ? 'mail' : a.type === 'email_in' ? 'reply' : a.type === 'call' ? 'call' : ''}">${ic(evIcon[a.type] || 'note')}</span><div class="x"><b>${evText(a)}</b><span class="w">${ago(a.at)}${a.actor_id ? ' · ' + esc(teamName(a.actor_id)) : ''}</span>${a.body && a.type !== 'system' ? `<p style="white-space:pre-wrap">${esc(a.body)}</p>` : ''}</div></div>`).join('') || '<div class="empty">No activity yet.</div>'}
    </div>
    <div class="props"><dl>
      <div><dt>Next step</dt><dd>${inp('next_step', l.next_step, 'text', 'What happens next')}${inp('next_step_at', l.next_step_at ? new Date(new Date(l.next_step_at) - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 16) : '', 'datetime-local')}</dd></div>
      <div><dt>Source</dt><dd>${sel('source', st.meta.sources.map(s => [s.key, s.path || s.label]), l.source)}</dd></div>
      <div><dt>Deal value</dt><dd class="inline">${inp('value', l.value, 'number')}${sel('currency', st.meta.currencies.map(c => [c, c]), l.currency)}</dd></div>
      <div><dt>Owner</dt><dd>${sel('owner_id', [['', 'Nobody'], ...st.meta.team.map(m => [m.id, m.name])], l.owner_id)}</dd></div>
      <div><dt>Email</dt><dd>${inp('email', l.email, 'email')}</dd></div>
      <div><dt>Phone</dt><dd>${inp('phone', l.phone, 'tel', '+880 …')}</dd></div>
      <div><dt>Business</dt><dd>${inp('company', l.company)}</dd></div>
      <div><dt>Website</dt><dd>${inp('website', l.website, 'url', 'https://')}</dd></div>
      <div><dt>City · country</dt><dd class="inline">${inp('city', l.city)}${inp('country', l.country, 'text', 'BD')}</dd></div>
      <div><dt>Score</dt><dd>${inp('score', l.score, 'number', '0–100')}</dd></div>
      ${l.stage === 'lost' ? `<div><dt>Why lost</dt><dd>${inp('lost_reason', l.lost_reason)}</dd></div>` : ''}
    </dl>
    <div class="links"><span class="lbl">Linked</span>
      ${client ? `<a class="lnk" href="#clients">${ic('clients')}${esc(client.name)}<small>client</small></a>` : ''}
      ${influencers.map(c => `<button type="button" class="lnk" data-crgo="${c.id}">${ic('pin')}@${esc(c.handle)}<small>creator</small></button>`).join('')}
      <button type="button" class="lnk" data-dept="${srcOf(l.source).dept}">${ic('overview')}${esc(srcOf(l.source).path || srcOf(l.source).label)}<small>department</small></button></div></div></div>`;
}
let ctab = 'note';
async function saveField(el) {
    const f = el.dataset.field; let v = el.value;
    if (f === 'next_step_at') v = v ? new Date(v).toISOString() : null;
    if (f === 'tags') v = v.split(',').map(x => x.trim()).filter(Boolean);
    try { const { lead } = await api('/api/crm/leads/' + st.openId, { method: 'PATCH', body: { [f]: v === '' ? null : v } }); const i = st.leads ? st.leads.findIndex(x => x.id === lead.id) : -1; if (i >= 0) st.leads[i] = lead; toast('Saved'); }
    catch (e) { toast(e.message, true); }
}
function modal(title, body, okText, onOk, wide) {
    $('#sub').innerHTML = `<div class="scrim" data-unsub style="z-index:30"></div><div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}" ${wide ? 'style="width:min(680px,calc(100% - 32px))"' : ''}><div class="mh"><h2>${esc(title)}</h2></div><div class="mb">${body}<div class="err" id="merr" role="alert"></div></div>
      <div class="mf"><button class="btn" type="button" data-unsub>Cancel</button><button class="btn pri" type="button" id="mok">${esc(okText)}</button></div></div>`;
    const first = $('#sub .modal input, #sub .modal select, #sub .modal textarea'); if (first) first.focus();
    $('#mok').onclick = async () => { const b = $('#mok'); b.disabled = true; try { await onOk(); } catch (e) { $('#merr').textContent = e.message; } b.disabled = false; };
}
const fieldHtml = (id, label, attrs = '', hint = '') => `<div class="field"><label for="${id}">${label}</label><input id="${id}" ${attrs}>${hint ? `<small>${hint}</small>` : ''}</div>`;
const v = id => ($('#' + id) || {}).value || '';

function newLead(pre = {}) {
    if (!$('#sub')) $('#layer').innerHTML = '<div id="sub"></div>';
    modal('New lead', `<div class="grid2">${fieldHtml('nl-n', 'Name', `autocomplete="off" placeholder="Full name" value="${esc(pre.full_name || '')}"`)}${fieldHtml('nl-co', 'Business', 'placeholder="Business name"')}</div>
      <div class="grid2">${fieldHtml('nl-e', 'Email', 'type="email" placeholder="name@business.com"')}${fieldHtml('nl-p', 'Phone or WhatsApp', `type="tel" placeholder="+880 …" value="${esc(pre.phone || '')}"`)}</div>
      <div class="grid2"><div class="field"><label for="nl-s">Source</label><select id="nl-s">${st.meta.sources.map(s => `<option value="${s.key}">${esc(s.path || s.label)}</option>`).join('')}</select></div>
        <div class="field"><label for="nl-o">Owner</label><select id="nl-o">${st.meta.team.map(m => `<option value="${m.id}" ${m.id === st.meta.me.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div></div>
      <div class="grid2">${fieldHtml('nl-city', 'City', 'placeholder="Barishal"')}${fieldHtml('nl-c', 'Country', 'maxlength="2" placeholder="BD"', 'Two letters: BD, US, GB…')}</div>
      <p class="note" style="margin:0">If the email or phone already belongs to a lead, you'll be shown that lead instead of a duplicate.</p>`, 'Add lead', async () => {
        try {
            const { lead } = await api('/api/crm/leads', { method: 'POST', body: { full_name: v('nl-n'), company: v('nl-co'), email: v('nl-e'), phone: v('nl-p'), source: v('nl-s'), owner_id: v('nl-o'), city: v('nl-city'), country: v('nl-c') } });
            st.leads = null; $('#layer').innerHTML = ''; toast(lead.full_name + ' added'); await render(); openLead(lead.id);
        } catch (e) { if (e.status === 409 && e.data.duplicate) { $('#merr').innerHTML = `<div class="dupe">${esc(e.message)} <button class="btn sm" type="button" data-open="${e.data.duplicate.id}">Open that lead</button></div>`; return; } throw e; }
    });
}
function importCsv() {
    if (!$('#sub')) $('#layer').innerHTML = '<div id="sub"></div>';
    modal('Import leads from a CSV', `<div class="field"><label for="ic-f">CSV file</label><input id="ic-f" type="file" accept=".csv,text/csv"><small>Columns are matched by name: Name, Company, Email, Phone, Website, City, Country, Value. Others are ignored.</small></div>
      <div class="grid2"><div class="field"><label for="ic-s">Category for these leads</label><select id="ic-s">${st.meta.sources.map(s => `<option value="${s.key}">${esc(s.path || s.label)}</option>`).join('')}</select></div>
        <div class="field"><label for="ic-o">Owner</label><select id="ic-o">${st.meta.team.map(m => `<option value="${m.id}" ${m.id === st.meta.me.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div></div>
      ${fieldHtml('ic-t', 'Tag (optional)', 'maxlength="40" placeholder="e.g. Dhaka salons, November"', 'Added to every lead in this file, so you can find the batch later.')}
      <label class="check"><input type="checkbox" id="ic-u"> The file has its own Source column: use it where a row has one</label><div id="ic-out"></div>`, 'Import', async () => {
        const file = $('#ic-f').files[0]; if (!file) throw new Error('Choose a CSV file first.');
        const csv = await file.text();
        const r = await api('/api/crm/leads/import', { method: 'POST', body: { csv, source: v('ic-s'), owner_id: v('ic-o'), tag: v('ic-t').trim(), useFileSource: $('#ic-u').checked } });
        st.leads = null;
        $('#ic-out').innerHTML = `<div class="note"><b>${r.added} added.</b> ${r.duplicates.length ? r.duplicates.length + ' already in the CRM were skipped. ' : ''}${r.skipped.length ? r.skipped.length + ' rows could not be used: ' + r.skipped.slice(0, 5).map(s => 'row ' + s.row + ' (' + esc(s.reason) + ')').join('; ') : ''}</div>`;
        $('#mok').textContent = 'Done'; $('#mok').onclick = () => { $('#layer').innerHTML = ''; render(); };
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
document.addEventListener('click', async e => {
    const t = e.target;
    if (t.closest('[data-close]')) { $('#layer').innerHTML = ''; st.openId = null; return; }
    if (t.closest('[data-unsub]')) { $('#sub').innerHTML = ''; if (!st.openId) $('#layer').innerHTML = ''; return; }
    if (t.closest('#theme')) { const r = document.documentElement; const dark = r.dataset.theme ? r.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; r.dataset.theme = dark ? 'light' : 'dark'; try { localStorage.setItem('crm-theme', r.dataset.theme); } catch {} if (route === 'influencers') mapInit(); return; }
    if (t.closest('#signout')) { await sb.auth.signOut(); location.replace('crm.html'); return; }
    if (t.closest('#newLead')) return newLead();
    if (t.closest('#openPal')) return palette();
    const pe = t.closest('[data-period]'); if (pe) { st.period = +pe.dataset.period; return render(); }
    const dp = t.closest('[data-dept]'); if (dp) { st.filter = { website: 'website', seo: 'seo', marketing: 'marketing', ads_google: 'ads', ads_meta: 'ads', social: 'marketing', email: 'marketing', influencer: 'influencer', other: 'other' }[dp.dataset.dept] || 'all'; $('#layer').innerHTML = ''; location.hash = 'leads'; return; }
    const vw = t.closest('[data-view]'); if (vw) { st.filter = vw.dataset.view; st.sel.clear(); return render(); }
    if (t.matches('[data-sel]')) { const id = t.dataset.sel; t.checked ? st.sel.add(id) : st.sel.delete(id); return render(); }
    if (t.id === 'selall') { const f = (VIEWS.find(x => x[0] === st.filter) || VIEWS[0])[2]; st.leads.filter(f).forEach(l => t.checked ? st.sel.add(l.id) : st.sel.delete(l.id)); return render(); }
    if (t.closest('.c-chk')) return;
    const a = t.closest('[data-act]');
    if (a) {
        const k = a.dataset.act;
        if (k === 'import') return importCsv();
        if ((k === 'phcall' || k === 'phtext') && st.openId && window.ELPhone) { const ld = (st.leads || []).find(x => x.id === st.openId) || {}; const ph = ld.phone || ($('.drawer [data-field="phone"]') || {}).value;
            if (k === 'phcall') return ELPhone.call(ph, ld.full_name); $('#layer').innerHTML = ''; st.openId = null; return ELPhone.text(ph); }
        if (k === 'genpass') { $('#ap-p').value = makePass(); return; }
        if (k === 'clearsel') { st.sel.clear(); return render(); }
        if (k === 'fit') { st.fitAll = true; fit(null); st.fitAll = false; return; }
        if (k === 'newcr') { if (!$('#sub')) $('#layer').innerHTML = '<div id="sub"></div>'; return creatorForm({}, async body => { const { influencer } = await api('/api/crm/influencers', { method: 'POST', body }); st.crOn = influencer.id; await net(true); $('#layer').innerHTML = ''; toast('@' + influencer.handle + ' added'); render(); }, 'Add a creator', 'Add creator'); }
        const cr = st.net && st.net.influencers.find(x => x.id === st.crOn);
        if (k === 'credit' && cr) { if (!$('#sub')) $('#layer').innerHTML = '<div id="sub"></div>'; return creatorForm(cr, async body => { await api('/api/crm/influencers/' + cr.id, { method: 'PATCH', body }); await net(true); $('#layer').innerHTML = ''; toast('Saved'); render(); }, 'Edit ' + (cr.name || '@' + cr.handle), 'Save'); }
        if (k === 'crpick' && cr) { st.picking = { kind: 'creator', id: cr.id, label: cr.name || '@' + cr.handle }; return render(); }
        if (k === 'crpost' && cr) { if (!$('#sub')) $('#layer').innerHTML = '<div id="sub"></div>';
            return modal('Log a post by ' + (cr.name || '@' + cr.handle), `<div class="field"><label for="po-c">For client</label><select id="po-c">${st.net.clients.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
              <div class="grid2">${fieldHtml('po-d', 'Posted on', `type="date" value="${new Date().toISOString().slice(0, 10)}"`)}${fieldHtml('po-v', 'Views', 'type="number" min="0"')}</div>${fieldHtml('po-u', 'Link to the post', 'type="url" placeholder="https://instagram.com/p/…"')}`, 'Log post', async () => {
                await api('/api/crm/influencers/' + cr.id + '/posts', { method: 'POST', body: { client_id: v('po-c'), posted_at: v('po-d'), views: v('po-v'), url: v('po-u') } }); await net(true); $('#layer').innerHTML = ''; toast('Post logged'); render(); }); }
        const lead = st.leads && st.leads.find(x => x.id === st.openId);
        if (k === 'convert' && st.openId) { const { lead: fresh } = await api('/api/crm/leads/' + st.openId); return convertLead(fresh); }
        if (k === 'tonet' && st.openId) return modal('Add to the influencer network', `${fieldHtml('tn-h', 'Their Instagram handle or link', 'placeholder="@handle"')}<div class="grid2">${fieldHtml('tn-f', 'Followers', 'type="number"')}${fieldHtml('tn-ni', 'Niche', 'placeholder="Food, fashion…"')}</div>`, 'Add to network', async () => {
            const { influencer } = await api('/api/crm/leads/' + st.openId + '/influencer', { method: 'POST', body: { handle: v('tn-h'), followers: v('tn-f'), niche: v('tn-ni') } }); st.net = null; toast('@' + influencer.handle + ' is in the network'); openLead(st.openId); });
        if (k === 'csave' && st.openId) {
            const body = $('#cbody').value.trim();
            try {
                if (ctab === 'task') { if (!body) throw new Error('Write what needs doing.'); await api('/api/crm/tasks', { method: 'POST', body: { lead_id: st.openId, title: body, due_at: v('c-due') ? new Date(v('c-due')).toISOString() : null } }); }
                else await api('/api/crm/leads/' + st.openId + '/activities', { method: 'POST', body: { type: ctab, body, minutes: v('c-min'), outcome: v('c-out') } });
                st.leads = null; toast('Saved'); openLead(st.openId); leads(true).then(shell);
            } catch (err) { toast(err.message, true); }
            return;
        }
        return void lead;
    }
    const ct = t.closest('[data-ctab]'); if (ct) { ctab = ct.dataset.ctab; document.querySelectorAll('[data-ctab]').forEach(b => b.classList.toggle('on', b === ct));
        const ex = $('#cextra'); ex.hidden = !['call', 'task'].includes(ctab);
        ex.innerHTML = ctab === 'call' ? `<input id="c-min" type="number" min="0" placeholder="Minutes" class="btn sm" style="width:110px" aria-label="Minutes"><select id="c-out" class="btn sm" aria-label="Outcome"><option value="">Outcome</option><option>Spoke</option><option>No answer</option><option>Left voicemail</option><option>Wrong number</option><option>Call back later</option></select>`
            : ctab === 'task' ? `<input id="c-due" type="datetime-local" class="btn sm" aria-label="Due">` : '';
        $('#cbody').placeholder = { note: 'Write a note', call: 'What was said', whatsapp: 'What was said on WhatsApp', email_out: 'Paste or sum up the email you sent', email_in: 'Paste or sum up their reply (moves them to Replied)', meeting: 'Notes from the meeting', task: 'What needs doing' }[ctab];
        return; }
    const sg = t.closest('.stepper [data-stage]'); if (sg && st.openId) {
        const to = sg.dataset.stage;
        if (to === 'won') { const { lead } = await api('/api/crm/leads/' + st.openId); return convertLead(lead); }
        try { await api('/api/crm/leads/' + st.openId, { method: 'PATCH', body: { stage: to } }); st.leads = null; toast('Moved to ' + to); openLead(st.openId); leads(true).then(() => route !== 'overview' && render()); } catch (err) { toast(err.message, true); }
        return;
    }
    const td = t.closest('[data-taskdone]'); if (td) { await api('/api/crm/tasks/' + td.dataset.taskdone, { method: 'PATCH', body: { done: true } }); st.leads = null; toast('Done'); return openLead(st.openId); }
    const cp = t.closest('[data-copy]'); if (cp) { try { await navigator.clipboard.writeText(cp.dataset.copy); toast('Copied'); } catch { toast(cp.dataset.copy); } return; }
    const ua = t.closest('[data-uact]'); if (ua) {
        const id = ua.dataset.uid, k = ua.dataset.uact, name = ua.dataset.name;
        if (k === 'on' || k === 'off') { try { await api('/api/admin/users/' + id, { method: 'PATCH', body: { isActive: k === 'on' } }); toast(k === 'on' ? 'Turned on' : 'Turned off. They are signed out within a minute.'); render(); } catch (err) { toast(err.message, true); } return; }
        if (!$('#sub')) $('#layer').innerHTML = '<div id="sub"></div>';
        if (k === 'pass') { const pw = makePass(); return modal('New password for ' + name, `${fieldHtml('up-p', 'New password', `type="text" value="${pw}" minlength="8"`, 'Copy it now and give it to them. It is not shown again.')}`, 'Save password', async () => {
            if (v('up-p').length < 8) throw new Error('Use 8 characters or more.'); await api('/api/admin/users/' + id, { method: 'PATCH', body: { password: v('up-p') } }); $('#layer').innerHTML = ''; toast('Password changed'); }); }
        if (k === 'remove') return modal('Remove ' + name + '?', `<p style="margin:0;color:var(--muted)">Their login is deleted. Their leads, clients and work move to you, so nothing is lost.</p>`, 'Remove', async () => {
            await api('/api/admin/users/' + id, { method: 'DELETE' }); $('#layer').innerHTML = ''; toast(name + ' removed'); render(); });
    }
    const sc = t.closest('[data-crstage]'); if (sc) { st.crStage = sc.dataset.crstage; return render(); }
    const cg = t.closest('[data-crgo]'); if (cg) { st.crOn = cg.dataset.crgo; $('#layer').innerHTML = ''; st.openId = null; location.hash = 'influencers'; return render(); }
    const crr = t.closest('[data-cr]'); if (crr) { st.crOn = crr.dataset.cr; return render(); }
    const pc = t.closest('[data-pinclient]'); if (pc) { st.picking = { kind: 'client', id: pc.dataset.pinclient, label: pc.dataset.name }; location.hash = 'influencers'; return; }
    const o = t.closest('[data-open]'); if (o) { $('#sub') && ($('#sub').innerHTML = ''); return openLead(o.dataset.open); }
});
document.addEventListener('submit', async e => {
    if (e.target.id !== 'addp') return; e.preventDefault();
    const b = e.target.querySelector('[type=submit]'); b.disabled = true;
    try {
        const email = v('ap-e').trim(), password = v('ap-p');
        if (!email || password.length < 8) throw new Error('Write their email and a password of 8 characters or more.');
        await api('/api/admin/users', { method: 'POST', body: { email, password, fullName: v('ap-n').trim(), role: 'user' } });
        toast('Teammate added'); await render();
        $('#ap-out').innerHTML = `<div class="note"><b>Send them this:</b> sign in at workspace.edgelead.online with ${esc(email)} and the password ${esc(password)}. They can change it with “Forgot your password?”.</div>`;
        st.meta = await api('/api/crm/meta');
    } catch (err) { toast(err.message, true); b.disabled = false; }
});
document.addEventListener('change', async e => {
    const t = e.target;
    if (t.matches('[data-field]') && st.openId) return saveField(t);
    if (t.matches('[data-bulk]') && t.value) { try { await api('/api/crm/leads/bulk', { method: 'POST', body: { ids: [...st.sel], set: { [t.dataset.bulk]: t.value } } }); toast(st.sel.size + ' leads updated'); st.sel.clear(); await leads(true); render(); } catch (err) { toast(err.message, true); } return; }
    if (t.matches('[data-tool]')) { t.disabled = true; try { const r = await api('/api/admin/tools', { method: 'PUT', body: { tools: { [t.dataset.tool]: t.checked } } }); st.meta.tools = Object.fromEntries(r.tools.map(x => [x.key, x.on])); toast(r.restarting ? 'Saved. The server restarts and is back within a minute.' : 'Saved'); } catch (err) { t.checked = !t.checked; toast(err.message, true); } t.disabled = false; return render(); }
    if (t.id === 'crcountry') { st.crCountry = t.value; return render(); }
});
document.addEventListener('input', e => {
    const t = e.target;
    if (t.id === 'lq' || t.id === 'crq') { const pos = t.selectionStart; if (t.id === 'lq') st.q = t.value; else st.crQ = t.value; clearTimeout(t._d); t._d = setTimeout(async () => { await render(); const n = $('#' + t.id); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }, 180); }
});
document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); palette(); }
    else if (e.key === 'Escape') { if ($('#sub') && $('#sub').innerHTML) $('#sub').innerHTML = ''; else { $('#layer').innerHTML = ''; st.openId = null; } if (st.picking) { st.picking = null; render(); } }
    else if (e.key.toLowerCase() === 'n' && !e.target.matches('input,textarea,select') && !$('#layer').innerHTML && !e.metaKey && !e.ctrlKey) newLead();
});
document.addEventListener('dragstart', e => { const c = e.target.closest('[data-drag]'); if (c) e.dataTransfer.setData('text/plain', c.dataset.drag); });
document.addEventListener('dragover', e => { const c = e.target.closest('.col'); if (c) { e.preventDefault(); c.classList.add('drop'); } });
document.addEventListener('dragleave', e => { const c = e.target.closest('.col'); if (c && !c.contains(e.relatedTarget)) c.classList.remove('drop'); });
document.addEventListener('drop', async e => {
    const c = e.target.closest('.col'); if (!c) return; e.preventDefault(); c.classList.remove('drop');
    const id = e.dataTransfer.getData('text/plain'), to = c.dataset.col, l = st.leads.find(x => x.id === id); if (!l || l.stage === to) return;
    if (to === 'won') { st.openId = id; $('#layer').innerHTML = '<div id="sub"></div>'; const { lead } = await api('/api/crm/leads/' + id); return convertLead(lead); }
    try { await api('/api/crm/leads/' + id, { method: 'PATCH', body: { stage: to } }); await leads(true); render(); toast((l.company || l.full_name) + ' moved'); } catch (err) { toast(err.message, true); }
});
function palette() {
    const items = [...(st.leads || []).slice(0, 400).map(l => ({ g: 'Leads', t: l.full_name + (l.company ? ' · ' + l.company : ''), s: srcOf(l.source).label, go: () => { $('#layer').innerHTML = ''; openLead(l.id); } })),
        ...NAV.map(([k, l]) => ({ g: 'Go to', t: l, s: '', go: () => { $('#layer').innerHTML = ''; location.hash = k; } })),
        { g: 'Actions', t: 'New lead', s: 'N', go: () => { $('#layer').innerHTML = '<div id="sub"></div>'; newLead(); } }, { g: 'Actions', t: 'Import CSV', s: '', go: () => { $('#layer').innerHTML = '<div id="sub"></div>'; importCsv(); } }];
    $('#layer').innerHTML = `<div class="scrim" data-close></div><div class="modal pal" role="dialog" aria-modal="true" aria-label="Search"><input id="palIn" placeholder="Search leads, pages, actions" autocomplete="off" aria-label="Search"><div class="res" id="palRes"></div></div><div id="sub"></div>`;
    let cur = 0, shown = [];
    const draw = q => { q = q.toLowerCase(); shown = items.filter(i => i.t.toLowerCase().includes(q)).slice(0, 10); cur = Math.max(0, Math.min(cur, shown.length - 1)); let g = '';
        $('#palRes').innerHTML = shown.map((i, n) => { const h = i.g !== g ? `<div class="grp">${i.g}</div>` : ''; g = i.g; return h + `<button type="button" data-i="${n}" class="${n === cur ? 'on' : ''}">${esc(i.t)}<small>${esc(i.s)}</small></button>`; }).join('') || '<div class="empty">Nothing matches.</div>'; };
    const inp = $('#palIn'); inp.focus(); draw('');
    inp.oninput = () => { cur = 0; draw(inp.value); };
    inp.onkeydown = ev => { if (ev.key === 'ArrowDown') { cur++; draw(inp.value); ev.preventDefault(); } if (ev.key === 'ArrowUp') { cur--; draw(inp.value); ev.preventDefault(); } if (ev.key === 'Enter' && shown[cur]) shown[cur].go(); };
    $('#palRes').onclick = ev => { const b = ev.target.closest('[data-i]'); if (b) shown[+b.dataset.i].go(); };
}

// ------------------------------------------------------------------ boot
(async function boot() {
    try { const th = localStorage.getItem('crm-theme'); if (th) document.documentElement.dataset.theme = th; } catch {}
    const { data } = await sb.auth.getSession();
    if (AUTH_LINK && data.session) { history.replaceState(null, '', location.pathname); return setPassword(); }
    if (!data.session) return signIn();
    if (!window.EL_PHONE_ONLY && !/crm\.html$/.test(location.pathname)) history.replaceState(null, '', 'crm.html' + (location.hash.includes('access_token') ? '' : location.hash));
    try { st.meta = await api('/api/crm/meta'); }
    catch (e) {
        if (e.status === 403) { await sb.auth.signOut(); return signIn('This workspace is for the EdgeLead team only.'); }
        if (e.status === 401) { await sb.auth.signOut(); return signIn('Your session ended. Sign in again.'); }
        $('#view').innerHTML = `<div class="empty err">Could not reach the server: ${esc(e.message)} <button class="btn sm" type="button" onclick="location.reload()">Try again</button></div>`; return;
    }
    if (window.EL_PHONE_ONLY) document.body.classList.add('phone-only');
    if (window.ELPhone) ELPhone.init({ api, toast, esc, initials, teamName, route: () => route, backend: BACKEND, token: async () => (await sb.auth.getSession()).data.session.access_token, newLead: pre => { if (!$('#sub')) $('#layer').innerHTML = '<div id="sub"></div>'; newLead(pre); } }).then(() => { if (route === 'phone') render(); shell(); });
    addEventListener('hashchange', render);
    render();
    leads().then(shell).catch(() => {});
})();
})();
