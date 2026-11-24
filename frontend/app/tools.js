/**
 * EdgeLead Tools (phase 89): the Apify work, at /tools, outside the CRM.
 *
 *   Home              the tools this person has, and their recent runs
 *   Lead Finder       find businesses and creators on Instagram (and Facebook Pages), add them to the CRM
 *   Instagram report  audit an account against up to two rivals
 *   Facebook Page     audit a Page, with one rival
 *   Facebook groups   read groups for demand and what works
 *
 * Two locks decide who gets in, and the server checks both on every call: the owner gives a person a tool
 * (Admin → Tools in the CRM), and the tool is unlocked. Every run is filed under a client.
 * The CRM is not changed by anything here; "Add to CRM" uses the CRM's own API like the New lead form does.
 */
(function () {
'use strict';
const SUPABASE_URL = 'https://sasbwgollyjpwegsbrty.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNhc2J3Z29sbHlqcHdlZ3NicnR5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4Mjg1MjEsImV4cCI6MjEwMTQwNDUyMX0.Ha6uDWqzC-T1Q49TE8WaqyjulPLntwt-2dSaknVtuKY';
const BACKEND = 'https://leadgen-backend-1-mgzc.onrender.com';
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ------------------------------------------------------------------ helpers
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = n => n == null || n === '' || isNaN(n) ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
const kfmt = n => n == null || isNaN(n) ? '—' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n));
const pctf = v => v == null || v === '' || isNaN(parseFloat(v)) ? '—' : (Math.round(parseFloat(v) * 100) / 100) + '%';
const initials = s => String(s || '?').replace(/^@/, '').split(/[\s._-]+/).filter(Boolean).slice(0, 2).map(x => x[0].toUpperCase()).join('') || '?';
const ago = at => { if (!at) return ''; const s = (Date.now() - new Date(at)) / 1000; return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + ' min ago' : s < 86400 ? Math.floor(s / 3600) + ' h ago' : s < 604800 ? Math.floor(s / 86400) + ' d ago' : new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };
const words = s => String(s || '').split(/[\n,]+/).map(x => x.trim()).filter(Boolean);
const handle = s => String(s || '').trim().replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/[/?#].*$/, '').replace(/^@/, '');
const human = k => String(k).replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
const ICONS = {
    home: '<path d="M4 11 12 4l8 7v9H4z"/><path d="M10 20v-5h4v5"/>', finder: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/><path d="M8.5 11h5M11 8.5v5"/>',
    ig: '<rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="1" fill="currentColor" stroke="none"/>',
    fbpage: '<path d="M14 21v-8h3l.5-3.5H14V7.8c0-1 .3-1.8 1.8-1.8h1.8V3a24 24 0 0 0-2.7-.2c-2.6 0-4.4 1.6-4.4 4.6v2.1H7.5V13h3v8"/>',
    fbgroups: '<circle cx="8" cy="9" r="3"/><circle cx="16.5" cy="9.5" r="2.5"/><path d="M2.5 19c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6M14 14.6c2.8-.5 5.6.9 6.5 4.4"/>',
    runs: '<path d="M4 12a8 8 0 1 0 2.3-5.6"/><path d="M4 4v4h4M12 8v4l3 2"/>', lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>', ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>', x: '<path d="M6 6l12 12M18 6 6 18"/>',
    play: '<path d="M7 4.5v15l13-7.5z"/>', check: '<path d="M20 6 9 17l-5-5"/>', mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>', phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
    back: '<path d="M15 18l-6-6 6-6"/>', spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/>', tools: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L3 17.8V21h3.2l6.3-6.3a4 4 0 0 0 5.2-5.4l-2.5 2.5-2.3-.4-.4-2.3z"/>',
    out: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>', moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>'
};
const ic = (k, cls = '') => `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[k] || ''}</svg>`;
function toast(t, bad) { const el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); if (bad) el.style.background = 'var(--bad)'; el.textContent = t; document.body.appendChild(el); setTimeout(() => el.remove(), 3600); }

async function api(path, { method = 'GET', body } = {}) {
    const { data } = await sb.auth.getSession();
    if (!data.session) { location.replace('/'); throw new Error('Signed out'); }
    const r = await fetch(BACKEND + path, { method, headers: { Authorization: 'Bearer ' + data.session.access_token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || `The server answered ${r.status}.`); e.status = r.status; e.data = j; throw e; }
    return j;
}

// ------------------------------------------------------------------ state
const TOOLS = [
    { route: 'finder', key: 'leadfinder', icon: 'finder', blurb: 'Search Instagram by place, hashtag, phrase or a rival\'s tags, and Facebook Pages by keyword. Every account is scored for fit; add the good ones to the CRM.' },
    { route: 'ig', key: 'reports', icon: 'ig', blurb: 'Audit an Instagram account: score, cadence, best times, formats and top posts, side by side with up to two rivals.' },
    { route: 'fbpage', key: 'fbpage', icon: 'fbpage', blurb: 'Audit a Facebook Page against one rival: what is working, what is failing, and a 30-day plan.' },
    { route: 'fbgroups', key: 'fbgroups', icon: 'fbgroups', blurb: 'Read Facebook groups for people asking for a service, which rooms are worth posting in, and when.' }
];
const JOB_TOOL = { leadgen_campaign: 'finder', leadgen_enrich: 'finder', fb_lead_discovery: 'finder', ig_report: 'ig', fb_page_report: 'fbpage', fb_community_audit: 'fbgroups' };
const JOB_LABEL = { leadgen_campaign: 'Lead Finder · Instagram', leadgen_enrich: 'Lead Finder · contact details', fb_lead_discovery: 'Lead Finder · Facebook', ig_report: 'Instagram report', fb_page_report: 'Facebook Page report', fb_community_audit: 'Facebook groups' };
const st = { me: null, tools: [], clients: [], client: null, jobs: [], active: null, finder: { q: '', kind: '', platform: '', page: 1 } };
const tool = r => st.tools.find(t => t.key === (TOOLS.find(x => x.route === r) || {}).key) || null;
const usable = r => { const t = tool(r); return !!(t && t.open); };
const clientName = id => (st.clients.find(c => c.id === id) || {}).name || '';

// ------------------------------------------------------------------ shell
let route = 'home';
function shell() {
    const navItem = (r, label, icon, extra = '') => `<a href="#${r}" class="${route === r || route.startsWith(r + '/') ? 'on' : ''}">${ic(icon)}${label}${extra}</a>`;
    const tl = TOOLS.filter(t => tool(t.route) && tool(t.route).assigned);
    const running = st.jobs.filter(j => ['queued', 'running'].includes(j.status)).length;
    $('#rail').innerHTML = `<div class="brand"><b>E</b>EdgeLead <span class="brand-sub">Tools</span></div>` +
        navItem('home', 'Home', 'home') +
        `<div class="grp">Tools</div>` + tl.map(t => navItem(t.route, esc(tool(t.route).label), t.icon, tool(t.route).open ? '' : `<span class="ct">${ic('lock', 'xs')}</span>`)).join('') +
        `<div class="grp">Work</div>` + navItem('runs', 'Runs', 'runs', running ? `<span class="ct hot">${running}</span>` : '') +
        `<a href="/" class="tools-link">${ic('back')}Back to the CRM</a>` +
        `<div class="foot"><div class="me"><span class="ava">${initials(st.me.name)}</span><div style="min-width:0"><b>${esc(st.me.name)}</b><span>${st.me.role === 'admin' ? 'Owner' : 'Team'}</span></div></div><button class="btn sm ghost" id="theme" type="button">${ic('moon')}Light / dark</button><button class="btn sm ghost" id="signout" type="button">${ic('out')}Sign out</button></div>`;
    $('#tabbar').innerHTML = [['home', 'Home', 'home'], ...tl.map(t => [t.route, { finder: 'Finder', ig: 'Instagram', fbpage: 'Page', fbgroups: 'Groups' }[t.route], t.icon]), ['runs', 'Runs', 'runs']]
        .map(([r, l, i]) => `<a href="#${r}" class="${route.split('/')[0] === r ? 'on' : ''}">${ic(i)}${l}</a>`).join('');
    const cp = $('#clientPick'); cp.hidden = !st.tools.some(t => t.open);
    $('#client').innerHTML = (st.clients.length ? '' : '<option value="">No clients yet</option>') + st.clients.map(c => `<option value="${c.id}" ${c.id === st.client ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
}
async function render() {
    route = (location.hash || '#home').slice(1) || 'home';
    const base = route.split('/')[0];
    if (!['home', 'runs', 'report', ...TOOLS.map(t => t.route)].includes(base)) route = 'home';
    shell();
    const v = $('#view');
    try {
        let html;
        if (base === 'home') html = vHome();
        else if (base === 'runs') html = await vRuns();
        else if (base === 'report') html = await vReport(route.split('/')[1], route.split('/')[2]);
        else if (!tool(base) || !tool(base).assigned) html = notYours();
        else if (!tool(base).open) html = lockedTool(tool(base));
        else html = await ({ finder: vFinder, ig: vIg, fbpage: vFbPage, fbgroups: vFbGroups })[base]();
        v.innerHTML = activeBar() + html;
        v.scrollTop = 0;
    } catch (e) { v.innerHTML = `<div class="empty err">Could not load this: ${esc(e.message)} <button class="btn sm" type="button" onclick="location.reload()">Try again</button></div>`; }
}

// ------------------------------------------------------------------ gates
function lockedAll() {
    return `<div class="gate">${ic('lock', 'xl')}<h1>Tools are locked</h1>
      <p class="sub">${st.me.role === 'admin' ? 'Unlock a tool in the CRM: Admin → Tools. While a tool is locked nothing runs for it and no Apify credit is spent.' : 'The owner has given you Tools, but they are locked right now. Ask the owner to unlock them.'}</p>
      <div class="gate-acts"><a class="btn" href="/">Back to the CRM</a>${st.me.role === 'admin' ? '<a class="btn pri" href="/#admin">Open Admin</a>' : ''}</div></div>`;
}
function noTools() {
    return `<div class="gate">${ic('tools', 'xl')}<h1>No Tools for you yet</h1><p class="sub">The owner gives Tools to people in the CRM: Admin → Tools.</p><div class="gate-acts"><a class="btn pri" href="/">Back to the CRM</a></div></div>`;
}
const notYours = () => `<div class="gate">${ic('lock', 'xl')}<h1>This tool is not yours</h1><p class="sub">Ask the owner to give it to you in Admin → Tools.</p><div class="gate-acts"><a class="btn" href="#home">Tools home</a></div></div>`;
const lockedTool = t => `<div class="gate">${ic('lock', 'xl')}<h1>${esc(t.label)} is locked</h1><p class="sub">${st.me.role === 'admin' ? 'Unlock it in the CRM: Admin → Tools.' : 'Ask the owner to unlock it.'}</p><div class="gate-acts"><a class="btn" href="#home">Tools home</a></div></div>`;
const needClient = () => st.client ? '' : `<p class="formnote bad">${st.clients.length ? 'Choose a client at the top first.' : st.me.role === 'admin' ? 'There are no clients yet. Convert a won lead in the CRM and it becomes one.' : 'You have no clients to run this for. Ask the owner to give you one in Admin → Tools.'}</p>`;

// ------------------------------------------------------------------ home
function vHome() {
    const mine = TOOLS.filter(t => tool(t.route) && tool(t.route).assigned);
    const recent = st.jobs.slice(0, 6);
    const hr = new Date().getHours();
    return `<div class="head"><div><h1>Good ${hr < 12 ? 'morning' : hr < 17 ? 'afternoon' : 'evening'}, ${esc(st.me.name.split(' ')[0])}.</h1><p class="sub">The research tools, outside the CRM. Every run is filed under a client and spends Apify credit.</p></div></div>
      <div class="tgrid">${mine.map(t => { const s = tool(t.route); return `<a class="card tcard ${s.open ? '' : 'locked'}" href="#${t.route}">
        <span class="ti">${ic(t.icon)}</span><div class="tt"><b>${esc(s.label)}</b><span class="lockstate ${s.open ? 'open' : ''}">${s.open ? 'Ready' : 'Locked'}</span></div>
        <p>${esc(t.blurb)}</p><span class="go">${s.open ? 'Open' : 'Locked by the owner'} ${s.open ? '→' : ''}</span></a>`; }).join('')}</div>
      <section class="card" style="margin-top:20px"><div class="card-h"><h2>Recent runs</h2><a class="btn sm ghost" href="#runs">All runs</a></div>
        ${recent.length ? `<div class="list">${recent.map(runRow).join('')}</div>` : '<div class="empty">Nothing run yet. Pick a tool above.</div>'}</section>`;
}
function runRow(j) {
    const live = ['queued', 'running'].includes(j.status);
    const open = j.reportId ? `#report/${JOB_TOOL[j.type]}/${j.reportId}` : JOB_TOOL[j.type] === 'finder' ? '#finder' : '';
    return `<div class="row run" ${open && j.status === 'done' ? `data-href="${open}"` : ''}><span class="kind">${ic(TOOLS.find(t => t.route === JOB_TOOL[j.type]).icon)}</span>
      <div class="t"><b>${esc(j.target || JOB_LABEL[j.type])}</b><span>${esc(JOB_LABEL[j.type])}${j.clientId && clientName(j.clientId) ? ' · ' + esc(clientName(j.clientId)) : ''} · ${ago(j.created_at)}</span></div>
      ${live ? `<span class="jstate run"><i style="--v:${j.progress || 3}%"></i>${j.progress || 0}%</span>` : `<span class="jstate ${j.status}">${{ done: 'Done', failed: 'Failed', cancelled: 'Stopped', paused: 'Paused' }[j.status] || esc(j.status)}</span>`}
      ${j.type === 'leadgen_campaign' && j.status === 'done' && j.campaignId ? `<button class="btn sm" type="button" data-enrich="${j.campaignId}" title="Read the profiles for emails, phones and follower counts">Get contacts</button>` : ''}</div>`;
}
async function vRuns() {
    await loadJobs();
    return `<div class="head"><div><h1>Runs</h1><p class="sub">Everything you started in the Tools, newest first. A run that fails spends nothing more.</p></div></div>
      <section class="card">${st.jobs.length ? `<div class="list">${st.jobs.map(j => runRow(j) + (j.status === 'failed' && j.error ? `<div class="runerr">${esc(j.error)}</div>` : '')).join('')}</div>` : '<div class="empty">No runs yet.</div>'}</section>`;
}

// ------------------------------------------------------------------ the running job
function activeBar() {
    const j = st.active; if (!j) return '';
    const done = j.status === 'done', bad = ['failed', 'cancelled'].includes(j.status);
    return `<div class="jobbar ${done ? 'ok' : bad ? 'bad' : ''}" role="status"><div class="jb-t"><b>${esc(JOB_LABEL[j.type] || 'Run')}${j.target ? ' · ' + esc(j.target) : ''}</b>
        <span>${done ? 'Finished.' : bad ? esc(j.error || 'It stopped.') : esc(j.step || 'Starting…')}</span></div>
      ${done || bad ? '' : `<div class="jb-p"><i style="width:${Math.max(3, j.progress || 0)}%"></i></div><span class="jb-n">${j.progress || 0}%</span>`}
      ${done && j.open ? `<a class="btn sm pri" href="${j.open}">Open</a>` : ''}${done || bad ? '<button class="btn sm ghost" type="button" data-dismiss>Close</button>' : '<button class="btn sm ghost" type="button" data-cancel>Stop</button>'}</div>`;
}
let pollT = 0;
function track(jobId, type, target) {
    st.active = { id: jobId, type, target, status: 'queued', progress: 0, step: 'Queued' };
    clearTimeout(pollT); poll(); paintBar();
}
function paintBar() { const v = $('#view'); const old = $('.jobbar', v); const html = activeBar(); if (old) old.outerHTML = html || ''; else if (html) v.insertAdjacentHTML('afterbegin', html); }
async function poll() {
    const a = st.active; if (!a) return;
    try {
        const j = await api('/api/job/' + a.id);
        Object.assign(a, { status: j.status, progress: j.progress, step: j.current_step, error: j.error });
        if (j.status === 'done') {
            const rid = j.result && (j.result.reportId || j.result.reportRef);
            a.open = rid ? `#report/${JOB_TOOL[a.type]}/${rid}` : JOB_TOOL[a.type] === 'finder' ? '#finder' : null;
            toast('Finished: ' + (JOB_LABEL[a.type] || 'run'));
            loadJobs().then(shell);
            if (route.split('/')[0] === JOB_TOOL[a.type] || route === 'runs' || route === 'home') { paintBar(); if (route === 'finder' || route === 'runs' || route === 'home') return render(); }
        }
        paintBar();
        if (['queued', 'running'].includes(j.status)) pollT = setTimeout(poll, 2500);
        else loadJobs().then(shell);
    } catch (e) { pollT = setTimeout(poll, 6000); }
}
async function start(path, body, type, target) {
    if (!st.client) { toast('Choose a client at the top first.', true); return; }
    try {
        const r = await api(path, { method: 'POST', body: { ...body, clientId: st.client } });
        track(r.jobId, type, target);
        toast(r.estimatedUsd != null ? `Started · about $${Number(r.estimatedUsd).toFixed(2)} of Apify credit` : 'Started');
        loadJobs().then(shell);
        return r;
    } catch (e) { toast(e.message, true); }
}
async function loadJobs() { try { st.jobs = (await api('/api/tools/jobs')).jobs || []; } catch { st.jobs = st.jobs || []; } return st.jobs; }

// ------------------------------------------------------------------ Lead Finder
const METHODS = [
    ['method_1', 'Places', 'Posts tagged at a place: put the place in Location.'],
    ['method_3', 'Hashtags', 'Accounts posting with these hashtags.'],
    ['method_3_1', 'Phrases', 'Each phrase is searched on its own, e.g. "bakery dhaka".'],
    ['method_6', 'Accounts by keyword', 'Accounts whose name or bio matches each keyword.'],
    ['method_4', 'Tagged by a rival', 'Accounts tagged in a competitor\'s posts.']
];
async function vFinder() {
    const f = st.finder;
    const qs = new URLSearchParams({ limit: '50', page: String(f.page), sort: 'fit' });
    if (f.q) qs.set('q', f.q); if (f.kind) qs.set('kind', f.kind); if (f.platform) qs.set('platform', f.platform);
    const res = await api('/api/leads?' + qs).catch(e => ({ leads: [], error: e.message, total: 0, pages: 1 }));
    const fbOn = usable('fbpage') || usable('fbgroups');
    return `<div class="head"><div><h1>Lead Finder</h1><p class="sub">Find businesses and creators, then add the good ones to the CRM as leads.</p></div></div>
      <div class="split">
        <section class="card form" aria-label="New search">
          <div class="card-h"><h2>New search</h2><div class="seg" role="tablist"><button type="button" class="on" data-fsrc="ig">Instagram</button><button type="button" data-fsrc="fb" ${fbOn ? '' : 'disabled title="Facebook is locked"'}>Facebook Pages</button></div></div>
          <form id="f-ig" class="fbody">
            <div class="field"><label for="lf-name">Name this search</label><input id="lf-name" placeholder="Barishal restaurants, November"></div>
            <div class="field"><label for="lf-loc">Location</label><input id="lf-loc" placeholder="Barishal, Bangladesh"></div>
            <fieldset class="methods"><legend>How to look</legend>${METHODS.map(([k, l, d], i) => `<label class="method"><input type="checkbox" name="m" value="${k}" ${i < 2 ? 'checked' : ''}><span><b>${l}</b><small>${d}</small></span></label>`).join('')}</fieldset>
            <div class="field" data-for="method_3"><label for="lf-tags">Hashtags</label><input id="lf-tags" placeholder="barishalfood, dhakaeats"></div>
            <div class="field" data-for="method_3_1" hidden><label for="lf-ph">Phrases</label><input id="lf-ph" placeholder="bakery barishal, cake shop"></div>
            <div class="field" data-for="method_6" hidden><label for="lf-kw">Keywords</label><input id="lf-kw" placeholder="salon, spa"></div>
            <div class="field" data-for="method_4" hidden><label for="lf-riv">Rival accounts</label><input id="lf-riv" placeholder="@rivalbakery, @anotherone"></div>
            ${needClient()}<button class="btn pri wide" type="submit" ${st.client ? '' : 'disabled'}>${ic('play')}Run the search</button></form>
          <form id="f-fb" class="fbody" hidden>
            <div class="field"><label for="ff-kw">What to search for</label><input id="ff-kw" placeholder="dentist, dental clinic" required><small>Up to four, separated by commas.</small></div>
            <div class="field"><label for="ff-loc">Location</label><input id="ff-loc" placeholder="Dallas, TX"></div>
            <div class="field"><label for="ff-max">How many Pages</label><select id="ff-max"><option>10</option><option selected>20</option><option>40</option></select></div>
            ${needClient()}<button class="btn pri wide" type="submit" ${st.client ? '' : 'disabled'}>${ic('play')}Find Pages</button></form>
        </section>
        <section class="card results" aria-label="Found accounts">
          <div class="card-h"><h2>Found accounts</h2><span>${num(res.total || 0)} in total · best fit first</span></div>
          <div class="filters"><input type="search" id="lf-q" placeholder="Search name, @handle, bio" value="${esc(f.q)}" aria-label="Search found accounts">
            <select id="lf-kind" aria-label="Kind"><option value="">Every kind</option>${[['business', 'Businesses'], ['influencer', 'Creators'], ['personal', 'Personal'], ['unsure', 'Not sorted yet']].map(([k, l]) => `<option value="${k}" ${f.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
            <select id="lf-plat" aria-label="Platform"><option value="">Both platforms</option><option value="instagram" ${f.platform === 'instagram' ? 'selected' : ''}>Instagram</option><option value="facebook" ${f.platform === 'facebook' ? 'selected' : ''}>Facebook</option></select></div>
          ${res.error ? `<div class="empty err">${esc(res.error)}</div>` : res.leads.length ? `<div class="tablewrap"><table class="found"><thead><tr><th>Account</th><th>Kind</th><th class="r">Followers</th><th>Contact</th><th>Fit</th><th></th></tr></thead><tbody>
            ${res.leads.map(l => `<tr><td><div class="acct" title="${esc(l.bio || '')}"><span class="ava pf ${l.platform === 'facebook' ? 'fb' : ''}">${initials(l.full_name || l.username)}</span><div style="min-width:0"><b>${esc(l.full_name || '@' + l.username)}</b><span class="sub2"><a href="${esc(l.profile_url || (l.platform === 'facebook' ? 'https://facebook.com/' : 'https://instagram.com/') + l.username)}" target="_blank" rel="noopener">@${esc(l.username)}</a>${l.city || l.location ? ' · ' + esc(l.city || l.location) : ''}</span></div></div></td>
              <td><span class="kindtag ${esc(l.kind_now || 'unsure')}">${esc({ business: 'Business', influencer: 'Creator', personal: 'Personal', unsure: 'Unsorted' }[l.kind_now] || 'Unsorted')}</span>${l.category ? `<small class="cat">${esc(l.category)}</small>` : ''}</td>
              <td class="r">${kfmt(l.followers_count)}</td>
              <td>${l.email || l.phone || l.whatsapp ? `<div class="contact">${l.email ? `<span title="${esc(l.email)}">${ic('mail', 'xs')}${esc(l.email)}</span>` : ''}${l.phone || l.whatsapp ? `<span>${ic('phone', 'xs')}${esc(l.phone || l.whatsapp)}</span>` : ''}</div>` : '<span class="dim">Not read yet</span>'}</td>
              <td>${l.fit_score == null ? '<span class="dim">—</span>' : `<span class="fit" style="--v:${l.fit_score}%"><i></i>${l.fit_score}</span>`}</td>
              <td class="r"><button class="btn sm" type="button" title="Add to the CRM as a lead" data-tocrm='${esc(JSON.stringify({ n: l.full_name || l.username, u: l.username, e: l.email || '', p: l.phone || l.whatsapp || '', c: l.city || '', w: l.website || '', pl: l.platform || 'instagram' }))}'>${ic('plus')}Add</button></td></tr>`).join('')}
            </tbody></table></div>
            <div class="pager"><button class="btn sm" type="button" data-page="${f.page - 1}" ${f.page <= 1 ? 'disabled' : ''}>Previous</button><span>Page ${f.page} of ${res.pages || 1}</span><button class="btn sm" type="button" data-page="${f.page + 1}" ${f.page >= (res.pages || 1) ? 'disabled' : ''}>Next</button></div>`
            : `<div class="empty">${f.q || f.kind || f.platform ? 'Nothing matches these filters.' : 'Nothing found yet. Run a search and the accounts land here.'}</div>`}
        </section>
      </div>`;
}

// ------------------------------------------------------------------ reports: forms and history
const histRow = (kind, r, title, sub) => `<a class="row" href="#report/${kind}/${r.id}"><span class="grade g${esc(String(r.grade || '').charAt(0))}">${esc(r.grade || '–')}</span>
    <div class="t"><b>${esc(title)}</b><span>${esc(sub)}</span></div><span class="dim small">${ago(r.created_at)}</span></a>`;
async function vIg() {
    const { reports } = await api('/api/reports-history?type=ig_report&limit=30').catch(() => ({ reports: [] }));
    return `<div class="head"><div><h1>Instagram report</h1><p class="sub">An audit of one account, side by side with up to two rivals.</p></div></div>
      <div class="split">
        <section class="card form"><div class="card-h"><h2>New report</h2></div>
          <form id="f-igr" class="fbody">
            <div class="field"><label for="ig-t">Account</label><input id="ig-t" placeholder="@bonhibachigrill or instagram.com/…" required></div>
            <div class="grid2"><div class="field"><label for="ig-r1">Rival 1 <small>optional</small></label><input id="ig-r1" placeholder="@rival"></div><div class="field"><label for="ig-r2">Rival 2 <small>optional</small></label><input id="ig-r2" placeholder="@rival"></div></div>
            <div class="field"><label for="ig-n">Posts to read per account</label><select id="ig-n"><option value="20">20 · quicker</option><option value="30" selected>30 · standard</option><option value="60">60 · deeper</option></select></div>
            ${needClient()}<button class="btn pri wide" type="submit" ${st.client ? '' : 'disabled'}>${ic('play')}Run the report</button></form></section>
        <section class="card"><div class="card-h"><h2>Reports</h2><span>${reports.length}</span></div>
          ${reports.length ? `<div class="list">${reports.map(r => histRow('ig', r, '@' + r.target_handle, [r.competitor_handles && r.competitor_handles.length ? 'vs ' + r.competitor_handles.map(h => '@' + h).join(', ') : null, r.score != null ? 'score ' + r.score : null, r.engagement_rate != null ? pctf(r.engagement_rate) + ' engagement' : null, clientName(r.client_id)].filter(Boolean).join(' · '))).join('')}</div>` : '<div class="empty">No reports yet.</div>'}</section>
      </div>`;
}
async function vFbPage() {
    const { reports } = await api('/api/fb/page-reports').catch(() => ({ reports: [] }));
    return `<div class="head"><div><h1>Facebook Page report</h1><p class="sub">An audit of a Page and one rival over the days you choose.</p></div></div>
      <div class="split">
        <section class="card form"><div class="card-h"><h2>New report</h2></div>
          <form id="f-fbp" class="fbody">
            <div class="field"><label for="fp-t">Page</label><input id="fp-t" placeholder="facebook.com/yourpage or the Page's handle" required></div>
            <div class="field"><label for="fp-r">Rival Page <small>optional</small></label><input id="fp-r" placeholder="facebook.com/rival"></div>
            <div class="grid2"><div class="field"><label for="fp-d">Days to read</label><select id="fp-d"><option value="30">30</option><option value="60">60</option><option value="90" selected>90</option></select></div>
              <div class="field"><label for="fp-n">Posts per Page</label><select id="fp-n"><option value="25">25</option><option value="40" selected>40</option><option value="60">60</option></select></div></div>
            <label class="check"><input type="checkbox" id="fp-rev">Read their reviews too</label>
            ${needClient()}<button class="btn pri wide" type="submit" ${st.client ? '' : 'disabled'}>${ic('play')}Run the report</button></form></section>
        <section class="card"><div class="card-h"><h2>Reports</h2><span>${reports.length}</span></div>
          ${reports.length ? `<div class="list">${reports.map(r => histRow('fbpage', r, (r.fb_page_names && r.fb_page_names[0]) || r.target_handle || 'Page', [r.fb_page_names && r.fb_page_names[1] ? 'vs ' + r.fb_page_names[1] : null, r.score != null ? 'score ' + r.score : null, r.posts_analyzed ? r.posts_analyzed + ' posts' : null, clientName(r.client_id)].filter(Boolean).join(' · '))).join('')}</div>` : '<div class="empty">No reports yet.</div>'}</section>
      </div>`;
}
async function vFbGroups() {
    const [{ reports }, g] = await Promise.all([api('/api/fb/reports').catch(() => ({ reports: [] })), api('/api/fb/groups').catch(() => ({ groups: [] }))]);
    const groups = g.groups || [];
    return `<div class="head"><div><h1>Facebook groups</h1><p class="sub">Read groups for people asking for a service, which rooms are worth posting in, and when.</p></div></div>
      <div class="split">
        <section class="card form"><div class="card-h"><h2>New reading</h2></div>
          <form id="f-fbg" class="fbody">
            ${groups.length ? `<fieldset class="methods"><legend>Saved groups</legend>${groups.slice(0, 30).map(x => `<label class="method"><input type="checkbox" name="g" value="${x.id}"><span><b>${esc(x.name || x.url)}</b><small>${x.members ? kfmt(x.members) + ' members' : esc(x.url || '')}</small></span></label>`).join('')}</fieldset>` : ''}
            <div class="field"><label for="fg-u">Group links</label><textarea id="fg-u" rows="3" placeholder="https://facebook.com/groups/…  one per line"></textarea></div>
            <div class="grid2"><div class="field"><label for="fg-n">What you sell</label><input id="fg-n" placeholder="Home cleaning"></div><div class="field"><label for="fg-l">Where</label><input id="fg-l" placeholder="Dhaka"></div></div>
            <div class="field"><label for="fg-d">Days to read</label><select id="fg-d"><option value="14">14</option><option value="30" selected>30</option><option value="60">60</option></select></div>
            ${needClient()}<button class="btn pri wide" type="submit" ${st.client ? '' : 'disabled'}>${ic('play')}Read the groups</button></form></section>
        <section class="card"><div class="card-h"><h2>Readings</h2><span>${reports.length}</span></div>
          ${reports.length ? `<div class="list">${reports.map(r => histRow('fbgroups', r, (r.fb_group_names || []).slice(0, 2).join(', ') + ((r.fb_group_names || []).length > 2 ? ` +${r.fb_group_names.length - 2}` : '') || r.target_handle || 'Groups', [r.niche, r.location_label, r.posts_analyzed ? r.posts_analyzed + ' posts' : null, clientName(r.client_id)].filter(Boolean).join(' · '))).join('')}</div>` : '<div class="empty">No readings yet.</div>'}</section>
      </div>`;
}

// ------------------------------------------------------------------ reports: the view
async function vReport(kind, id) {
    const path = { ig: '/api/report/', fbpage: '/api/fb/page-report/', fbgroups: '/api/fb/report/' }[kind];
    if (!path || !id) return '<div class="empty">That report link is not right.</div>';
    if (!usable(kind)) return tool(kind) && tool(kind).assigned ? lockedTool(tool(kind)) : notYours();
    const { report } = await api(path + encodeURIComponent(id));
    const R = report.report_json || {}, AI = report.ai_json || R.ai || null;
    const back = `<a class="btn sm ghost" href="#${kind}">${ic('back')}All reports</a>`;
    const when = new Date(report.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    if (kind === 'fbgroups') return back + groupsReport(R, AI, when);
    const T = kind === 'ig' ? R.main : R.target;
    if (!T) return back + '<div class="empty">This report has no data. It may have failed while it ran.</div>';
    const rivals = kind === 'ig' ? (R.rivals || []) : R.rival ? [R.rival] : [];
    const name = kind === 'ig' ? '@' + T.handle : T.name;
    const sb_ = T.scoreBreakdown || {};
    const kpis = kind === 'ig'
        ? [['Followers', kfmt(T.followers)], ['Engagement', pctf(T.engagementRate)], ['Posts a week', num(T.cadence ? T.cadence.postsPerWeek : T.postsPerWeek)], ['Avg likes', kfmt(T.avgLikes)], ['Avg comments', kfmt(T.avgComments)], ['Avg views', T.avgViews ? kfmt(T.avgViews) : '—']]
        : [['Followers', kfmt(T.followers)], ['Engagement', pctf(T.engagementRate)], ['Posts a week', num(T.cadence && T.cadence.postsPerWeek)], ['Conversation', pctf(T.conversationRate)], ['Shares', pctf(T.amplificationRate)], ['Posts read', num(T.postsAnalyzed)]];
    const posts = (T.topPosts || []).slice(0, 6);
    const mix = T.contentMix ? Object.entries(T.contentMix) : (T.formats || []).map(f => [f.key || f.format, f]);
    const best = T.heatmap ? { days: (T.heatmap.bestDays || []).slice(0, 3), hours: (T.heatmap.bestHours || []).slice(0, 3) } : null;
    const recs = (R.recommendations || []).slice(0, 8);
    return back + `<div class="rhead card"><span class="ava big">${initials(T.fullName || T.name || T.handle)}</span>
        <div class="rh-t"><h1>${esc(T.fullName || name)}</h1><p class="sub">${esc([kind === 'ig' ? '@' + T.handle : null, T.category, when, report.client_id && clientName(report.client_id)].filter(Boolean).join(' · '))}</p>${sb_.verdict ? `<p class="verdict">${esc(sb_.verdict)}</p>` : ''}</div>
        <div class="scorebox"><span class="grade xl g${esc(String(T.grade || '').charAt(0))}">${esc(T.grade || '–')}</span><div><b>${T.score != null ? T.score : '—'}</b><small>out of 100</small></div></div></div>
      <section class="card kpirow">${kpis.map(([l, v]) => `<div><small>${l}</small><b>${v}</b></div>`).join('')}</section>
      ${AI && AI.executive_summary ? `<section class="card summary"><div class="card-h"><h2>${ic('spark')}The short version</h2></div><p>${esc(AI.executive_summary)}</p></section>` : ''}
      <div class="rcols">
        ${sb_.breakdown && sb_.breakdown.length ? `<section class="card"><div class="card-h"><h2>Where the score comes from</h2><span>${sb_.lowConfidence ? 'few posts, read loosely' : ''}</span></div><div class="pillars">${sb_.breakdown.map(p => `<div><span>${esc(p.pillar)}<small>${esc(p.detail || '')}</small></span><em><i style="width:${p.max ? Math.round(p.points / p.max * 100) : 0}%"></i></em><b>${p.points}/${p.max}</b></div>`).join('')}</div></section>` : ''}
        <section class="card"><div class="card-h"><h2>When and what</h2></div><div class="when">
          ${best && (best.days.length || best.hours.length) ? `<div><span class="lbl">Best days</span><p>${best.days.map(d => `<span class="chip">${esc(d.dowName)}</span>`).join('') || '—'}</p></div><div><span class="lbl">Best hours</span><p>${best.hours.map(h => `<span class="chip">${fmtHour(h.hour)}</span>`).join('') || '—'}</p></div>` : ''}
          ${mix.length ? `<div><span class="lbl">Formats</span><div class="mix">${mix.map(([k, m]) => `<div><span>${esc(human(k))}</span><em><i style="width:${parseFloat(m.share) || 0}%"></i></em><b>${esc(m.share || '')}</b></div>`).join('')}</div></div>` : ''}
          ${T.topHashtags && T.topHashtags.length ? `<div><span class="lbl">Hashtags that work</span><p>${T.topHashtags.slice(0, 8).map(h => `<span class="chip">#${esc(h.tag)}</span>`).join('')}</p></div>` : ''}
        </div></section>
      </div>
      ${rivals.length ? `<section class="card"><div class="card-h"><h2>Against rivals</h2></div><div class="tablewrap"><table class="cmp"><thead><tr><th>Account</th><th>Grade</th><th class="r">Score</th><th class="r">Followers</th><th class="r">Engagement</th><th class="r">Posts a week</th></tr></thead><tbody>
        ${[T, ...rivals].map((x, i) => `<tr class="${i ? '' : 'me'}"><td><b>${esc(kind === 'ig' ? '@' + x.handle : x.name)}</b>${i ? '' : ' <span class="pill">this report</span>'}</td><td><span class="grade g${esc(String(x.grade || '').charAt(0))}">${esc(x.grade || '–')}</span></td><td class="r">${x.score ?? '—'}</td><td class="r">${kfmt(x.followers)}</td><td class="r">${pctf(x.engagementRate)}</td><td class="r">${num(x.cadence ? x.cadence.postsPerWeek : x.postsPerWeek)}</td></tr>`).join('')}</tbody></table></div></section>` : ''}
      ${posts.length ? `<section class="card"><div class="card-h"><h2>Top posts</h2><span>by engagement for their reach</span></div><div class="posts">${posts.map(p => `<a class="post" href="${esc(p.url || '#')}" target="_blank" rel="noopener">${p.thumbnail || p.image ? `<img loading="lazy" src="${esc(p.thumbnail || p.image)}" alt="" onerror="this.remove()">` : ''}<div><span class="pill">${esc(p.type || human(p.format || 'post'))}</span><p>${esc(String(p.caption || p.excerpt || '').slice(0, 140))}</p><small>${[p.likes != null ? kfmt(p.likes) + ' likes' : p.reactions != null ? kfmt(p.reactions) + ' reactions' : null, p.comments != null ? kfmt(p.comments) + ' comments' : null, p.views ? kfmt(p.views) + ' views' : null].filter(Boolean).join(' · ')}</small></div></a>`).join('')}</div></section>` : ''}
      ${recs.length ? `<section class="card"><div class="card-h"><h2>What to do</h2></div><div class="recs">${recs.map(r => typeof r === 'string' ? `<div><p>${esc(r)}</p></div>` : `<div>${r.priority ? `<span class="prio ${esc(r.priority)}">${esc(r.priority)}</span>` : ''}<b>${esc(r.title || '')}</b>${r.action ? `<p>${esc(r.action)}</p>` : ''}${r.why ? `<small>${esc(r.why)}</small>` : ''}</div>`).join('')}</div></section>` : ''}
      ${aiSections(AI, ['executive_summary'])}
      ${(R.warnings || []).length ? `<p class="formnote">${R.warnings.map(esc).join('<br>')}</p>` : ''}`;
}
function groupsReport(R, AI, when) {
    const B = R.benchmark || {}, G = R.groups || [];
    const ranked = B.ranked || [];
    return `<div class="rhead card"><span class="ava big">${ic('fbgroups')}</span><div class="rh-t"><h1>${esc(G.map(g => g.name).slice(0, 3).join(', ') || 'Facebook groups')}</h1><p class="sub">${esc([G.length + ' group' + (G.length === 1 ? '' : 's'), when].join(' · '))}</p></div></div>
      <section class="card kpirow">${[['Groups', num(B.rooms || G.length)], ['Posts read', num(B.totalPosts)], ['Asking for a service', num(B.totalDemand)], ['Members', kfmt(B.totalMembers)], ['Room value', num(B.avgRoomValue)]].map(([l, v]) => `<div><small>${l}</small><b>${v}</b></div>`).join('')}</section>
      ${AI && AI.executive_summary ? `<section class="card summary"><div class="card-h"><h2>${ic('spark')}The short version</h2></div><p>${esc(AI.executive_summary)}</p></section>` : ''}
      ${ranked.length ? `<section class="card"><div class="card-h"><h2>The rooms, best first</h2></div><div class="tablewrap"><table class="cmp"><thead><tr><th>Group</th><th>Verdict</th><th class="r">Value</th><th class="r">Posts a day</th><th class="r">Asking</th><th>Promotion</th></tr></thead><tbody>
        ${ranked.map(g => `<tr><td><b>${esc(g.name)}</b>${g.lowConfidence ? ' <span class="pill">few posts</span>' : ''}</td><td><span class="verdictchip ${esc(String(g.verdict || '').toLowerCase())}">${esc(g.verdict || '—')}</span></td><td class="r">${num(g.roomValue)}</td><td class="r">${num(g.postsPerDay)}</td><td class="r">${num(g.demandSignals)}</td><td>${g.promoAllowed ? 'Allowed' : 'Not allowed'}${g.approvalRequired ? ' · approval' : ''}</td></tr>`).join('')}</tbody></table></div></section>` : ''}
      ${aiSections(AI, ['executive_summary'])}`;
}
const fmtHour = h => { h = Number(h); return isNaN(h) ? '—' : (h % 12 || 12) + (h < 12 ? ' AM' : ' PM'); };
/** Every other part of the AI read, whatever its shape: lists of sentences, or rows of named fields. */
function aiSections(AI, skip) {
    if (!AI) return '';
    const parts = Object.entries(AI).filter(([k, v]) => !skip.includes(k) && Array.isArray(v) && v.length);
    if (!parts.length) return '';
    const cell = v => Array.isArray(v) ? `<ul>${v.map(x => `<li>${esc(typeof x === 'object' ? Object.values(x).join(' · ') : x)}</li>`).join('')}</ul>` : esc(typeof v === 'object' && v ? Object.values(v).join(' · ') : v);
    return `<div class="aigrid">${parts.map(([k, v]) => `<section class="card"><div class="card-h"><h2>${esc(human(k))}</h2></div>
      ${typeof v[0] === 'string' ? `<ul class="ailist">${v.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`
        : `<div class="airows">${v.map(o => `<div>${Object.entries(o || {}).map(([kk, vv]) => `<div class="kv"><span>${esc(human(kk))}</span><div>${cell(vv)}</div></div>`).join('')}</div>`).join('')}</div>`}</section>`).join('')}</div>`;
}

// ------------------------------------------------------------------ events
document.addEventListener('click', async e => {
    const t = e.target;
    const href = t.closest('[data-href]'); if (href && !t.closest('button,a')) { location.hash = href.dataset.href; return; }
    if (t.closest('#theme')) { const r = document.documentElement; const dark = r.dataset.theme ? r.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; r.dataset.theme = dark ? 'light' : 'dark'; try { localStorage.setItem('crm-theme', r.dataset.theme); } catch {} return; }
    if (t.closest('#signout')) { await sb.auth.signOut(); location.replace('/'); return; }
    if (t.closest('[data-dismiss]')) { st.active = null; paintBar(); return; }
    if (t.closest('[data-cancel]') && st.active) { try { await api('/api/job/' + st.active.id + '/cancel', { method: 'POST' }); toast('Stopping after the current step. What was read is kept.'); } catch (err) { toast(err.message, true); } return; }
    const src = t.closest('[data-fsrc]'); if (src && !src.disabled) { $$('[data-fsrc]').forEach(b => b.classList.toggle('on', b === src)); $('#f-ig').hidden = src.dataset.fsrc !== 'ig'; $('#f-fb').hidden = src.dataset.fsrc !== 'fb'; return; }
    const pg = t.closest('[data-page]'); if (pg && !pg.disabled) { st.finder.page = Math.max(1, +pg.dataset.page); return render(); }
    const en = t.closest('[data-enrich]'); if (en) { en.disabled = true; await start('/api/enrich-campaign', { campaignId: en.dataset.enrich, batchSize: 50 }, 'leadgen_enrich', 'Reading contact details'); return; }
    const tc = t.closest('[data-tocrm]');
    if (tc) {
        const d = JSON.parse(tc.dataset.tocrm); tc.disabled = true;
        try {
            await api('/api/crm/leads', { method: 'POST', body: { full_name: d.n, company: d.n, email: d.e || null, phone: d.p || null, city: d.c || null, website: d.w || null, source: 'social', source_detail: `Lead Finder · ${d.pl === 'facebook' ? 'Facebook' : 'Instagram'} @${d.u}`, tags: ['Lead Finder'] } });
            tc.innerHTML = ic('check') + 'In the CRM'; tc.classList.add('done'); toast(d.n + ' is a lead in the CRM');
        } catch (err) { tc.disabled = false; toast(err.status === 409 ? err.message + ' It is already in the CRM.' : err.message, true); }
    }
});
document.addEventListener('change', e => {
    const t = e.target;
    if (t.id === 'client') { st.client = t.value || null; try { localStorage.setItem('tools-client', st.client || ''); } catch {} return render(); }
    if (t.name === 'm') { const on = new Set($$('input[name=m]:checked').map(x => x.value)); $$('[data-for]').forEach(f => { f.hidden = !on.has(f.dataset.for); }); return; }
    if (t.id === 'lf-kind' || t.id === 'lf-plat') { st.finder.kind = $('#lf-kind').value; st.finder.platform = $('#lf-plat').value; st.finder.page = 1; return render(); }
});
let qT = 0;
document.addEventListener('input', e => { if (e.target.id === 'lf-q') { clearTimeout(qT); qT = setTimeout(async () => { st.finder.q = e.target.value.trim(); st.finder.page = 1; await render(); const q = $('#lf-q'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }, 350); } });
document.addEventListener('submit', async e => {
    const f = e.target; const val = id => (($('#' + id) || {}).value || '').trim();
    if (!['f-ig', 'f-fb', 'f-igr', 'f-fbp', 'f-fbg'].includes(f.id)) return;
    e.preventDefault();
    const b = f.querySelector('[type=submit]'); b.disabled = true;
    try {
        if (f.id === 'f-ig') {
            const m = $$('input[name=m]:checked', f).map(x => x.value);
            if (!m.length) return toast('Pick at least one way to look.', true);
            const body = { campaignName: val('lf-name') || 'Lead Finder search', location: val('lf-loc'), selected_methods: m,
                hashtags: words(val('lf-tags')).map(x => x.replace(/^#/, '')), method3_1_keywords: words(val('lf-ph')), method6_keywords: words(val('lf-kw')),
                competitor_handles: words(val('lf-riv')).map(handle), method1_keywords: [] };
            if (m.includes('method_1') && !body.location) return toast('Places needs a location.', true);
            await start('/api/run-campaign', body, 'leadgen_campaign', body.campaignName);
        }
        if (f.id === 'f-fb') await start('/api/fb/find-leads', { keywords: words(val('ff-kw')).slice(0, 4), location: val('ff-loc'), maxPages: +val('ff-max') }, 'fb_lead_discovery', val('ff-kw'));
        if (f.id === 'f-igr') { const t = handle(val('ig-t')); const r1 = handle(val('ig-r1')), r2 = handle(val('ig-r2'));
            await start('/api/generate-ig-report', { target: t, compareRivals: !!(r1 || r2), rival1: r1, rival2: r2, postsLimit: +val('ig-n') }, 'ig_report', '@' + t); }
        if (f.id === 'f-fbp') await start('/api/fb/page-report', { target: val('fp-t'), rival: val('fp-r') || undefined, days: +val('fp-d'), postsPerPage: +val('fp-n'), includeReviews: $('#fp-rev').checked }, 'fb_page_report', val('fp-t'));
        if (f.id === 'f-fbg') {
            const ids = $$('input[name=g]:checked', f).map(x => x.value), urls = val('fg-u').split(/\s+/).filter(x => /^https?:\/\//.test(x));
            if (!ids.length && !urls.length) return toast('Pick a saved group or paste a group link.', true);
            await start('/api/fb/audit-community', { groupIds: ids, groupUrls: urls, niche: val('fg-n') || undefined, location: val('fg-l') || undefined, days: +val('fg-d'), mode: 'combined' }, 'fb_community_audit', val('fg-n') || 'Groups');
        }
    } finally { b.disabled = false; }
});
addEventListener('keydown', e => { if (e.key === 'Escape' && st.active && ['done', 'failed', 'cancelled'].includes(st.active.status)) { st.active = null; paintBar(); } });

// ------------------------------------------------------------------ boot
(async () => {
    const { data } = await sb.auth.getSession();
    if (!data.session) { location.replace('/'); return; }
    let me;
    try { me = await api('/api/tools/me'); }
    catch (e) {
        if (e.status === 401 || e.status === 403) { location.replace('/'); return; }
        $('#view').innerHTML = `<div class="empty err">Could not reach the server: ${esc(e.message)} <button class="btn sm" type="button" onclick="location.reload()">Try again</button></div>`; return;
    }
    Object.assign(st, { me: me.me, tools: me.tools, clients: me.clients });
    let saved = null; try { saved = localStorage.getItem('tools-client'); } catch {}
    st.client = (st.clients.find(c => c.id === saved) || st.clients[0] || {}).id || null;
    if (!st.tools.some(t => t.assigned)) { $('#rail').innerHTML = `<div class="brand"><b>E</b>EdgeLead <span class="brand-sub">Tools</span></div><a href="/" class="tools-link">${ic('back')}Back to the CRM</a>`; $('#view').innerHTML = noTools(); return; }
    if (!st.tools.some(t => t.open)) { shell(); $('#view').innerHTML = lockedAll(); return; }
    await loadJobs();
    const live = st.jobs.find(j => ['queued', 'running'].includes(j.status));
    if (live) { st.active = { id: live.id, type: live.type, target: live.target, status: live.status, progress: live.progress, step: live.step }; poll(); }
    addEventListener('hashchange', render);
    render();
})();
})();
