/**
 * Admin (phase 90): the owner's cockpit, #admin/<section>. Loaded the first time it opens; the server checks the
 * owner on every call. A status strip across the top, the sections down the side (each with a light), one main
 * panel with collapsible cards:
 *
 *   Overview        every system at a glance, with the next thing to set up
 *   Team            people, passwords, turning a login off
 *   Tools           the Apify tools' locks, and who has which tool for which clients
 *   Keys            each tool's Apify key and credit, the shared pool, the Gemini keys
 *   Email           the campaign mailbox, the sending window and the daily cap
 *   Goals           the daily outreach goals on the Overview, and the business time zone
 *   Leads           industries, categories, and where leads without a country are (for the map)
 *   Client pages    which tabs a client's page shows, by kind of client or for one client
 *   Billing         packages and the business details on invoices
 *   Phone           the business number, its usage and its Twilio set-up
 *   Client logins   business owners' old logins
 */
(function () {
'use strict';
const C = window.CRM;
const { api, esc, ic, toast, st, $, num, initials, modal, v } = C;
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const SECTIONS = [['overview', 'Overview', 'overview'], ['team', 'Team', 'leads'], ['tools', 'Tools', 'tools'], ['keys', 'Apify and AI keys', 'lock'], ['email', 'Email sending', 'mail'],
    ['goals', 'Goals', 'task'], ['leads', 'Leads and industries', 'pin'], ['clientpages', 'Client pages', 'clients'], ['billing', 'Billing', 'cash'], ['phone', 'Phone', 'phone'], ['logins', 'Client logins', 'shield']];
const A = { data: {}, sec: 'overview' };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const card = (title, sub, body, { open = true, id = '', right = '' } = {}) => `<details class="acard card" ${open ? 'open' : ''} ${id ? `id="${id}"` : ''}><summary><div><h2>${title}</h2>${sub ? `<span>${sub}</span>` : ''}</div>${right}<span class="chev">${ic('stage')}</span></summary><div class="acb">${body}</div></details>`;
const light = s => `<i class="light ${s}"></i>`;
const usd = x => x == null ? '—' : '$' + Number(x).toFixed(2);

// everything the cockpit shows, read at once and kept while Admin is open
async function load(force) {
    if (A.data.at && !force && Date.now() - A.data.at < 20000) return A.data;
    const [users, access, phone, ak, gk, crm, mail, billing] = await Promise.all([api('/api/admin/users'), api('/api/admin/tools/access'), api('/api/admin/phone/usage').catch(e => ({ error: e.message })),
        api('/api/apify-keys').catch(() => null), api('/api/gemini-keys').catch(() => null), api('/api/admin/crm-settings').catch(e => ({ error: e.message })), api('/api/admin/mailbox').catch(e => ({ error: e.message })), api('/api/admin/billing').catch(() => null)]);
    A.data = { at: Date.now(), users: users.users || [], access, phone, ak, gk, crm, mail, billing };
    return A.data;
}
function status(d) {
    const tools = (d.access.switches || []).filter(t => t.on).length;
    const staff = d.users.filter(u => u.role !== 'client' && u.is_active).length;
    const pool = d.ak ? (d.ak.keys || []).filter(k => !k.owner_user_id && k.status === 'active').length : 0;
    const prim = d.ak ? Object.values(d.ak.primaries || {}).filter(p => p.configured).length : 0;
    return {
        team: ['ok', `${staff} active`], tools: [tools ? 'ok' : 'off', tools ? `${tools} unlocked` : 'All locked'], keys: [prim || pool ? 'ok' : 'warn', `${prim} tool key${prim === 1 ? '' : 's'} · ${pool} in pool`],
        email: [d.mail.state && d.mail.state.connected ? (d.mail.state.paused ? 'warn' : 'ok') : 'warn', d.mail.state && d.mail.state.connected ? (d.mail.state.paused ? 'Paused' : `${d.mail.sentToday || 0} sent today`) : 'Not connected'],
        goals: ['ok', d.crm.goals ? `${d.crm.goals.calls} calls · ${d.crm.goals.emails} emails a day` : ''], leads: [d.crm.p90 ? 'ok' : 'warn', d.crm.p90 ? `${(d.crm.industries || []).length} industries` : 'Run the phase-90 SQL'],
        clientpages: ['ok', `${((d.crm.clientTabs || {}).default || []).length} tabs by default`], billing: [d.billing && (d.billing.packages || []).length ? 'ok' : 'off', d.billing ? `${(d.billing.packages || []).length} packages` : ''],
        phone: [d.phone && d.phone.ready ? 'ok' : 'warn', d.phone && d.phone.ready ? 'Live' : 'Not set up'], logins: ['off', `${d.users.filter(u => u.role === 'client').length}`], overview: ['ok', '']
    };
}

C.views.admin = async arg => {
    A.sec = SECTIONS.some(s => s[0] === arg) ? arg : 'overview';
    const d = await load(A.force); A.force = false;
    const S = status(d);
    const main = await ({ overview: secOverview, team: secTeam, tools: secTools, keys: secKeys, email: secEmail, goals: secGoals, leads: secLeads, clientpages: secClientPages, billing: secBilling, phone: secPhone, logins: secLogins }[A.sec])(d, S);
    const strip = [['team', 'Team'], ['tools', 'Tools'], ['email', 'Email'], ['phone', 'Phone'], ['keys', 'Keys'], ['leads', 'Database']].map(([k, l]) => `<a class="sstat ${S[k][0]}" href="#admin/${k}">${light(S[k][0])}<small>${l}</small><b>${esc(S[k][1])}</b></a>`).join('');
    return `<div class="head"><div><h1>Admin</h1><p class="sub">Only you can open this. Everything about how the CRM, the Tools and the phone run.</p></div></div>
      <div class="sstrip">${strip}</div>
      <div class="cockpit"><nav class="anav" aria-label="Admin sections">${SECTIONS.map(([k, l, i]) => `<a href="#admin/${k}" class="${A.sec === k ? 'on' : ''}">${ic(i)}<span>${l}</span>${k === 'overview' ? '' : light(S[k][0])}</a>`).join('')}</nav>
        <div class="amain">${main}</div></div>`;
};

// ------------------------------------------------------------------ overview: every system, and what to do next
async function secOverview(d, S) {
    const todo = [];
    if (!d.crm.p90) todo.push(['Run sql/schema-phase90.sql in Supabase', 'Industries, the pipeline switch, the leads map and email campaigns need it.', 'leads']);
    if (!(d.mail.state && d.mail.state.connected)) todo.push(['Connect the campaign mailbox', 'A Google Workspace address with an app password. Campaign emails wait until it is connected.', 'email']);
    if (!(d.phone && d.phone.ready)) todo.push(['Finish the phone set-up', 'Twilio settings are missing on the server.', 'phone']);
    if (!(d.billing && (d.billing.packages || []).length)) todo.push(['Add your service packages', 'They fill a client\'s agreement and invoices in one click.', 'billing']);
    const tiles = SECTIONS.filter(s => s[0] !== 'overview').map(([k, l, i]) => `<a class="atile ${S[k][0]}" href="#admin/${k}"><span class="ai">${ic(i)}</span><div><b>${l}</b><span>${light(S[k][0])}${esc(S[k][1] || '')}</span></div></a>`).join('');
    return `${todo.length ? card('Next to set up', `${todo.length} thing${todo.length === 1 ? '' : 's'}`, `<div class="todo">${todo.map(([t, dsc, k], i) => `<a href="#admin/${k}"><span class="n">${i + 1}</span><div><b>${t}</b><span>${dsc}</span></div>${ic('arrow')}</a>`).join('')}</div>`) : ''}
      <div class="atiles">${tiles}</div>`;
}

// ------------------------------------------------------------------ team
async function secTeam(d) {
    const me = st.meta.me.id;
    const staff = d.users.filter(u => u.role !== 'client').sort((a, b) => (b.role === 'admin') - (a.role === 'admin') || (a.full_name || a.email).localeCompare(b.full_name || b.email));
    const person = u => `<div class="opt person ${u.is_active ? '' : 'off'}"><span class="ava">${initials(u.full_name || u.email)}</span>
        <div class="t"><b>${esc(u.full_name || u.email.split('@')[0])}${u.id === me ? ' <small class="pill">you</small>' : ''}</b><span>${esc(u.email)} · ${u.role === 'admin' ? 'Owner' : 'Team'}${u.is_active ? '' : ' · turned off'}${u.last_seen_at ? ' · seen ' + C.ago(u.last_seen_at) : ''}</span></div>
        ${u.id === me ? '' : `<div class="acts2"><button class="btn sm" type="button" data-uact="pass" data-uid="${u.id}" data-name="${esc(u.full_name || u.email)}">New password</button>
          <button class="btn sm" type="button" data-uact="${u.is_active ? 'off' : 'on'}" data-uid="${u.id}">${u.is_active ? 'Turn off' : 'Turn on'}</button>
          <button class="btn sm ghost danger" type="button" data-uact="remove" data-uid="${u.id}" data-name="${esc(u.full_name || u.email)}">Remove</button></div>`}</div>`;
    return card('People', `${staff.filter(u => u.is_active).length} active`, staff.map(person).join('')) +
      card('Add a teammate', 'They sign in at workspace.edgelead.online', `<form class="addp" id="addp" autocomplete="off"><div class="grid3">${C.fieldHtml('ap-n', 'Name', 'placeholder="Full name"')}${C.fieldHtml('ap-e', 'Email', 'type="email" placeholder="name@edgelead.online"')}
        <div class="field"><label for="ap-p">Password</label><div class="inline"><input id="ap-p" type="text" minlength="8" placeholder="8 characters or more"><button class="btn sm" type="button" data-aact="genpass">Make one</button></div></div></div>
        <div class="bar"><span class="note" style="margin:0">They see the CRM. Give them Tools and clients in <a href="#admin/tools">Tools</a>.</span><button class="btn pri" type="submit">Add teammate</button></div><div id="ap-out"></div></form>`);
}

// ------------------------------------------------------------------ tools
async function secTools(d) {
    const a = d.access, bg = (a.background || []).filter(t => t.on);
    return card('Locks', `${a.switches.filter(t => t.on).length} unlocked`, `<p class="note" style="margin:0 0 10px">The Tools open at <b>/tools</b>, outside the CRM. A tool opens only when it is unlocked here <i>and</i> given to the person. While a tool is locked nothing runs for it and no Apify credit is spent.</p>
        ${a.switches.map(t => `<div class="opt lockrow"><div class="t"><b>${esc(t.label)}<span class="lockstate ${t.on ? 'open' : ''}">${t.on ? 'Unlocked' : 'Locked'}</span></b><span>${esc(t.detail)}</span></div><label class="sw"><input type="checkbox" data-tool="${t.key}" ${t.on ? 'checked' : ''} aria-label="Unlock ${esc(t.label)}"><i></i></label></div>`).join('')}
        ${bg.length ? `<div class="opt"><div class="t"><b>Still running in the background</b><span>${bg.map(t => esc(t.label)).join(', ')}: these have no page any more. Turn them off to stop their background work.</span></div><div class="acts2">${bg.map(t => `<button class="btn sm" type="button" data-tooloff="${t.key}">Turn off ${esc(t.label)}</button>`).join('')}</div></div>` : ''}`) +
      card('Who has Tools', 'You have every tool', a.people.length ? a.people.map(p => `<form class="acc-row" data-access="${p.id}"><div class="acc-who"><span class="ava">${initials(p.name)}</span><div style="min-width:0"><b>${esc(p.name)}</b><span>${esc(p.email || '')}${p.active ? '' : ' · turned off'}</span></div></div>
        <div class="acc-grp"><span class="lbl">Tools they can use</span><div class="tick">${a.tools.map(t => `<label><input type="checkbox" name="tool" value="${t.key}" ${p.tools.includes(t.key) ? 'checked' : ''}>${esc(t.label)}</label>`).join('')}</div>
          <span class="lbl" style="margin-top:4px">Clients they work on (also opens the client in the CRM)</span><div class="tick">${a.clients.length ? a.clients.map(c => `<label><input type="checkbox" name="client" value="${c.id}" ${p.clients.includes(c.id) ? 'checked' : ''}>${esc(c.name)}</label>`).join('') : '<span class="sub" style="margin:0">No clients yet.</span>'}</div>
          <div><button class="btn sm pri" type="submit">Save ${esc(p.name.split(' ')[0])}'s access</button></div></div></form>`).join('') : '<div class="empty sm">No teammates yet. Add one in Team.</div>');
}

// ------------------------------------------------------------------ keys
const APIFY_TOOL_ENGINES = [['leadgen', 'Lead Finder'], ['report', 'Instagram report'], ['fb_page', 'Facebook Page report'], ['fb_community', 'Facebook groups']];
async function secKeys(d) {
    const a = d.ak, g = d.gk; if (!a) return '<div class="empty">The keys could not be read.</div>';
    const pool = (a.keys || []).filter(k => !k.owner_user_id), gem = ((g && g.keys) || []).filter(k => !k.owner_user_id);
    return card('Each tool\'s Apify key', esc(a.cycleMonth || ''), `<p class="note" style="margin:0 0 10px">Each tool spends its own key first, then the shared pool, then the server's key. Credit renews monthly.</p>
        ${APIFY_TOOL_ENGINES.map(([e, l]) => { const p = (a.primaries || {})[e] || {}; const pc = p.creditUsd ? Math.min(100, Math.round((p.spentUsd || 0) / p.creditUsd * 100)) : 0;
          return `<div class="opt"><div class="t"><b>${esc(l)}</b><span>${p.configured ? `${esc(p.masked || 'Key set')} · ${usd(p.spentUsd)} of ${usd(p.creditUsd)} spent` : 'No key of its own: uses the pool'}</span>${p.configured ? `<i class="meter"><i style="width:${pc}%"></i></i>` : ''}</div>
          <div class="acts2"><button class="btn sm" type="button" data-keyset="${e}" data-label="${esc(l)}">${p.configured ? 'Replace key' : 'Add key'}</button>${p.configured ? `<button class="btn sm ghost" type="button" data-keycredit="${e}" data-cur="${p.creditUsd || ''}">Monthly credit</button>` : ''}</div></div>`; }).join('')}`) +
      card('Shared Apify pool', `${pool.length} key${pool.length === 1 ? '' : 's'}`, `${pool.map(k => `<div class="opt"><div class="t"><b>${esc(k.label || k.apify_username || 'Apify key')}</b><span>${esc(k.engine === 'any' ? 'Any tool' : (APIFY_TOOL_ENGINES.find(x => x[0] === k.engine) || [0, k.engine])[1])} · ${esc(k.status)} · ${usd(k.remainingUsd)} left of ${usd(k.creditUsd)}</span></div><button class="btn sm ghost danger" type="button" data-keydel="${k.id}">Remove</button></div>`).join('') || '<div class="opt"><div class="t"><span>No pool keys. Add one so a run keeps going when a tool\'s own key runs dry.</span></div></div>'}
        <form class="opt keyadd" id="poolAdd" autocomplete="off"><div class="inline" style="flex:1;flex-wrap:wrap"><input id="pk-t" type="password" placeholder="apify_api_…" aria-label="Apify token" required style="flex:2;min-width:180px"><input id="pk-l" placeholder="Label" aria-label="Label" style="flex:1;min-width:100px"><button class="btn sm pri" type="submit">Add to pool</button></div></form>`) +
      card('Gemini keys', 'Write the reports\' summaries', `${gem.map(k => `<div class="opt"><div class="t"><b>${esc(k.label || 'Gemini key')}</b><span>${esc(k.status)}${k.calls_total ? ' · ' + num(k.calls_total) + ' calls' : ''}${k.last_error ? ' · ' + esc(String(k.last_error).slice(0, 80)) : ''}</span></div><button class="btn sm ghost danger" type="button" data-gemdel="${k.id}">Remove</button></div>`).join('') || '<div class="opt"><div class="t"><span>No pool keys; the server\'s key is used.</span></div></div>'}
        <form class="opt keyadd" id="gemAdd" autocomplete="off"><div class="inline" style="flex:1;flex-wrap:wrap"><input id="gk-t" type="password" placeholder="Gemini API key" aria-label="Gemini key" required style="flex:2;min-width:180px"><input id="gk-l" placeholder="Label" aria-label="Label" style="flex:1;min-width:100px"><button class="btn sm pri" type="submit">Add key</button></div></form>`, { open: false });
}

// ------------------------------------------------------------------ email sending
async function secEmail(d) {
    if (d.mail.error) return `<div class="card"><div class="empty err">${esc(d.mail.error)}</div></div>`;
    const m = d.mail.mailbox || { host: 'smtp.gmail.com', port: 465, dailyCap: 50, window: { from: 9, to: 17, days: [1, 2, 3, 4, 5] } };
    const on = d.mail.state && d.mail.state.connected, w = m.window || { from: 9, to: 17, days: [1, 2, 3, 4, 5] };
    const hours = (id, val) => `<select id="${id}">${Array.from({ length: 25 }, (_, h) => `<option value="${h}" ${val === h ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}</select>`;
    return `${d.mail.p90 ? '' : `<div class="banner">${ic('shield')}<div>Campaigns need <span class="mono">sql/schema-phase90.sql</span>. The mailbox can be set up now.</div></div>`}
      ${card('The mailbox', on ? `${light('ok')}Connected · ${num(d.mail.sentToday)} sent today` : `${light('warn')}Not connected`, `<p class="note" style="margin:0 0 12px">Use a real mailbox people can reply to, on your own domain: a Google Workspace address on edgelead.online is best. In Google: Account → Security → 2-Step Verification on → App passwords → make one for "Mail", and paste it here. The password is stored encrypted and never shown again.</p>
        <form class="wform" id="mailform" autocomplete="off">
          ${C.fieldHtml('mb-user', 'Mailbox address (sign-in)', `type="email" value="${esc(m.user || '')}" placeholder="yousuf@edgelead.online"`)}
          ${C.fieldHtml('mb-pass', m.hasPass ? 'App password (saved; type to replace)' : 'App password', `type="password" placeholder="${m.hasPass ? '••••••••••••••••' : '16 letters from Google'}"`)}
          ${C.fieldHtml('mb-fname', 'From name', `value="${esc(m.fromName || '')}" placeholder="Yousuf at EdgeLead"`)}
          ${C.fieldHtml('mb-femail', 'From address', `type="email" value="${esc(m.fromEmail || '')}" placeholder="Same as the mailbox"`)}
          ${C.fieldHtml('mb-reply', 'Replies go to (optional)', `type="email" value="${esc(m.replyTo || '')}" placeholder="Same as the from address"`)}
          <div class="field"><label for="mb-host">Server</label><div class="inline"><input id="mb-host" value="${esc(m.host || 'smtp.gmail.com')}"><select id="mb-port">${[465, 587].map(p => `<option ${m.port === p ? 'selected' : ''}>${p}</option>`).join('')}</select></div><small>Google: smtp.gmail.com, 465</small></div>
          <div class="field wide"><label for="mb-sig">Signature</label><textarea id="mb-sig" rows="4" placeholder="Yousuf Talukder&#10;EdgeLead · edgelead.online · (469) 819-4097">${esc(m.signature || '')}</textarea></div>
          <div class="field wide"><label for="mb-addr">Business address (the law asks for one in every cold email)</label><input id="mb-addr" value="${esc(m.address || '')}" placeholder="Street, City, State ZIP"></div>
        </form>
        <div class="tbar"><span class="dim small">Saving checks the sign-in with the mail server.</span><span class="sp"></span>${on ? '<button class="btn ghost danger" type="button" data-aact="mailoff">Disconnect</button>' : ''}<button class="btn pri" type="button" data-aact="mailsave">${on ? 'Save' : 'Connect'}</button></div>`)}
      ${card('When and how much', 'Spread out, inside working hours', `<div class="wform">
          <div class="field"><label for="mb-from">From</label>${hours('mb-from', w.from)}</div><div class="field"><label for="mb-to">To</label>${hours('mb-to', w.to)}</div>
          <div class="field wide"><label>Days</label><div class="tick" id="mb-days">${DAYS.map((x, i) => `<label><input type="checkbox" value="${i}" ${(w.days || []).includes(i) ? 'checked' : ''}>${x}</label>`).join('')}</div><small>In the business time zone (${esc((d.crm && d.crm.timezone) || 'America/Chicago')}), set in Goals.</small></div>
          <div class="field"><label for="mb-cap">Emails a day, at most</label><input id="mb-cap" type="number" min="1" max="2000" value="${esc(m.dailyCap || 50)}"><small>Start with 30–50 a day on a new mailbox and raise it slowly.</small></div>
          <div class="field"><label>Sending</label><label class="check"><input type="checkbox" id="mb-paused" ${m.paused ? 'checked' : ''}> Pause all campaign email</label></div>
        </div><div class="tbar"><span class="sp"></span><button class="btn pri" type="button" data-aact="mailsave">Save</button></div>`)}`;
}

// ------------------------------------------------------------------ goals
async function secGoals(d) {
    const g = d.crm.goals || {};
    const G = [['calls', 'Calls', 'Outbound calls on the phone, plus calls logged by hand'], ['emails', 'Emails', 'Emails sent, by hand or by a campaign'], ['prospects', 'Prospects found', 'New leads in the CRM plus accounts found by Lead Finder'], ['followups', 'Follow-ups done', 'Call and follow-up tasks ticked off']];
    return card('Daily outreach goals', 'The rings on the Overview', `<div class="goaledit">${G.map(([k, l, dsc]) => `<div class="field"><label for="go-${k}">${l}</label><input id="go-${k}" type="number" min="0" max="10000" value="${esc(g[k] ?? 0)}"><small>${dsc}</small></div>`).join('')}</div>
        <div class="tbar"><span class="dim small">For the whole team, per day.</span><span class="sp"></span><button class="btn pri" type="button" data-aact="goals">Save goals</button></div>`) +
      card('Business time zone', esc(d.crm.timezone || ''), `<div class="wform"><div class="field"><label for="go-tz">Time zone</label><select id="go-tz">${['America/Chicago', 'America/New_York', 'America/Denver', 'America/Los_Angeles', 'Asia/Dhaka', 'Europe/London', 'Asia/Dubai'].concat(d.crm.timezone && !['America/Chicago', 'America/New_York', 'America/Denver', 'America/Los_Angeles', 'Asia/Dhaka', 'Europe/London', 'Asia/Dubai'].includes(d.crm.timezone) ? [d.crm.timezone] : []).map(z => `<option ${d.crm.timezone === z ? 'selected' : ''}>${z}</option>`).join('')}</select><small>"Today" on the Overview and the sending window follow it.</small></div></div>
        <div class="tbar"><span class="sp"></span><button class="btn pri" type="button" data-aact="tz">Save</button></div>`);
}

// ------------------------------------------------------------------ leads, industries, the map
async function secLeads(d) {
    const ind = d.crm.industries || [];
    const L = st.leads || await C.leads();
    const used = C.countBy(L.filter(l => l.industry), l => l.industry.toLowerCase());
    const noInd = L.filter(l => !l.industry).length;
    return `${d.crm.p90 ? '' : `<div class="banner">${ic('shield')}<div><b>Run <span class="mono">sql/schema-phase90.sql</span> in the Supabase SQL editor.</b> It adds industry, the pipeline switch and map places to leads, and the tables for email campaigns. It is safe to run twice.</div></div>`}
      ${card('Industries', `${ind.length} in the list${noInd ? ` · ${num(noInd)} lead${noInd === 1 ? '' : 's'} without one` : ''}`, `<p class="note" style="margin:0 0 10px">The list people pick from on a lead. A lead can also have an industry that is not in the list; it shows in the filters all the same.</p>
        <div class="indlist" id="indlist">${ind.map(i => `<span class="indrow"><input value="${esc(i)}" data-ind aria-label="Industry"><small>${num(used[i.toLowerCase()] || 0)}</small><button type="button" class="btn ghost sm" data-inddel aria-label="Remove">${ic('x')}</button></span>`).join('')}</div>
        <div class="tbar"><button class="btn sm" type="button" data-aact="indadd">${ic('plus')}Add an industry</button><span class="sp"></span><button class="btn pri" type="button" data-aact="indsave">Save industries</button></div>
        ${noInd && d.crm.p90 ? `<div class="opt" style="margin-top:12px"><div class="t"><b>${num(noInd)} lead${noInd === 1 ? '' : 's'} without an industry</b><span>Give them one at once, e.g. the industry of the file they came from. Or select them on the Leads page and set it there.</span></div><div class="inline"><select id="bulkind">${ind.map(i => `<option>${esc(i)}</option>`).join('')}</select><button class="btn sm" type="button" data-aact="indfill">Set for all ${num(noInd)}</button></div></div>` : ''}`)}
      ${card('Categories', 'Where a lead came from: each lead has one', `<div class="tree">${st.meta.sources.map(s => `<div>${C.srcChip(s.key)}${s.path ? `<span class="dim small">${esc(s.path)}</span>` : ''}</div>`).join('')}</div><p class="note" style="margin:10px 0 0">Categories roll up into the departments on the Overview: Website, SEO, Marketing (ads, social, email), Influencer, Referral and other.</p>`, { open: false })}
      ${card('The leads map', `${num(L.filter(l => l.lat != null).length)} of ${num(L.length)} placed`, `<div class="wform"><div class="field wide"><label for="geo-h">Where leads without a country are</label><input id="geo-h" value="${esc((d.crm.geo || {}).hint || '')}" placeholder="Houston, TX, USA"><small>A lead's place is looked up from its city. Cities like "Katy" or "Downtown" need this to land in the right place.</small></div></div>
        <div class="tbar"><button class="btn" type="button" data-aact="geoall" ${d.crm.p90 ? '' : 'disabled'}>Place every lead again</button><span class="sp"></span><button class="btn pri" type="button" data-aact="geo">Save and place new leads</button></div>`)}`;
}

// ------------------------------------------------------------------ client pages: which tabs show
async function secClientPages(d) {
    const ct = d.crm.clientTabs || { default: [], byType: {}, byClient: {} }, cat = d.crm.catalogue || [];
    const kinds = [...new Set([...(d.crm.clientKinds || []), ...Object.keys(ct.byType || {})])];
    const clients = d.access.clients || [];
    const grid = (name, list, inherit) => `<div class="tabgrid" data-tabs="${esc(name)}">${cat.map(t => `<label class="${t.always ? 'always' : ''}" title="${esc(t.detail)}"><input type="checkbox" value="${t.key}" ${(list || inherit || []).includes(t.key) || t.always ? 'checked' : ''} ${t.always ? 'disabled' : ''}><span><b>${esc(t.label)}</b><small>${esc(t.detail)}</small></span></label>`).join('')}</div>`;
    return card('Every client, unless set below', 'The default', grid('default', ct.default)) +
      card('By kind of business', 'The kind is the client\'s "Kind of business" in its Details', `${kinds.length ? kinds.map(k => `<div class="kindrow"><div class="kindh"><b>${esc(k)}</b><label class="check"><input type="checkbox" data-own="${esc(k)}" ${ct.byType && ct.byType[k] ? 'checked' : ''}> Its own tabs</label></div>${ct.byType && ct.byType[k] ? grid('type:' + k, ct.byType[k]) : '<span class="dim small">Uses the default.</span>'}</div>`).join('') : '<div class="empty sm">No kinds yet. Set a client\'s kind of business in its Details tab.</div>'}
        <div class="tbar"><input id="newkind" placeholder="Add a kind, e.g. Restaurant" list="kindlist"><datalist id="kindlist">${C.industries().map(i => `<option value="${esc(i)}">`).join('')}</datalist><button class="btn sm" type="button" data-aact="kindadd">${ic('plus')}Add</button></div>`) +
      card('One client', 'Overrides its kind', `${Object.keys(ct.byClient || {}).map(id => { const c = clients.find(x => x.id === id); return `<div class="kindrow"><div class="kindh"><b>${esc(c ? c.name : 'A client')}</b><button class="btn sm ghost" type="button" data-unclient="${id}">Use its kind again</button></div>${grid('client:' + id, ct.byClient[id])}</div>`; }).join('')}
        <div class="tbar"><select id="newclient"><option value="">Choose a client…</option>${clients.filter(c => !(ct.byClient || {})[c.id]).map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select><button class="btn sm" type="button" data-aact="clientadd">${ic('plus')}Set its own tabs</button></div>`, { open: !!Object.keys(ct.byClient || {}).length }) +
      `<div class="savebar"><span class="dim small">Overview and Details are always shown.</span><span class="sp"></span><button class="btn pri" type="button" data-aact="tabsave">Save client pages</button></div>`;
}
function readTabs() {
    const out = { default: [], byType: {}, byClient: {} };
    for (const g of $$('[data-tabs]')) {
        const list = $$('input:checked', g).map(i => i.value), n = g.dataset.tabs;
        if (n === 'default') out.default = list; else if (n.startsWith('type:')) out.byType[n.slice(5)] = list; else if (n.startsWith('client:')) out.byClient[n.slice(7)] = list;
    }
    return out;
}

// ------------------------------------------------------------------ billing
async function secBilling(d) {
    const b = d.billing || { packages: [], profile: {} }, p = b.profile || {};
    const line = (x = {}) => `<div class="aline pk"><input placeholder="Package" value="${esc(x.name || '')}" data-k="name"><select data-k="billing"><option value="monthly" ${x.billing !== 'one_off' ? 'selected' : ''}>Monthly</option><option value="one_off" ${x.billing === 'one_off' ? 'selected' : ''}>One-off</option></select><input type="number" placeholder="Price" value="${esc(x.price ?? '')}" data-k="price"><input placeholder="What it includes" value="${esc(x.description || '')}" data-k="description"><button type="button" class="btn ghost sm" data-alrm aria-label="Remove">${ic('x')}</button></div>`;
    return card('Packages', `${(b.packages || []).length} · ${esc(b.currency || '')}`, `<p class="note" style="margin:0 0 10px">The services you sell. A client's agreement picks from these.</p><div class="alines" id="pklines">${(b.packages || []).map(line).join('')}</div>
        <div class="tbar"><button class="btn sm" type="button" data-aact="pkadd">${ic('plus')}Add a package</button><span class="sp"></span><button class="btn pri" type="button" data-aact="pksave">Save packages</button></div>`) +
      card('On every invoice', 'Your business details', `<div class="wform">${[['name', 'Business name'], ['email', 'Email'], ['phone', 'Phone'], ['address', 'Address']].map(([k, l]) => C.fieldHtml('bp-' + k, l, `value="${esc(p[k] || '')}"`)).join('')}
        <div class="field wide"><label for="bp-terms">Standard terms</label><textarea id="bp-terms" rows="3">${esc(p.terms || '')}</textarea></div><div class="field wide"><label for="bp-note">Note on invoices</label><textarea id="bp-note" rows="2">${esc(p.invoiceNote || '')}</textarea></div></div>
        <div class="tbar"><span class="sp"></span><button class="btn pri" type="button" data-aact="bpsave">Save details</button></div>`, { open: false });
}

// ------------------------------------------------------------------ phone
async function secPhone(d) {
    const u = d.phone;
    if (!u || u.error) return card('Phone', 'Usage', `<div class="empty">${esc((u && u.error) || 'Not available yet.')}</div>`);
    const O = u.ours, tw = Array.isArray(u.twilio) ? Object.fromEntries(u.twilio.map(r => [r.category, r])) : null;
    const month = new Date(u.month + '-01T00:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const tile = (l, x, sub) => `<div><small>${l}</small><b>${x}</b>${sub ? `<em>${sub}</em>` : ''}</div>`;
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
        <div class="opt"><div class="t"><b>In Twilio, “A message comes in”</b><span class="mono">${esc(u.hooks.sms)}</span></div><button class="btn sm" type="button" data-copy="${esc(u.hooks.sms)}">Copy</button></div></div></section>`;
}
async function secLogins(d) {
    const owners = d.users.filter(u => u.role === 'client');
    return card('Client logins', 'From the old Edge Meta AI', `<p class="note" style="margin:0 0 10px">Business owners who had their own login. They cannot use the CRM or the Tools; the pages they used were removed.</p>
      ${owners.map(u => `<div class="opt person ${u.is_active ? '' : 'off'}"><span class="ava">${initials(u.full_name || u.email)}</span><div class="t"><b>${esc(u.full_name || u.email)}</b><span>${esc(u.email)}${u.is_active ? '' : ' · turned off'}</span></div><div class="acts2"><button class="btn sm" type="button" data-uact="${u.is_active ? 'off' : 'on'}" data-uid="${u.id}">${u.is_active ? 'Turn off' : 'Turn on'}</button><button class="btn sm ghost danger" type="button" data-uact="remove" data-uid="${u.id}" data-name="${esc(u.full_name || u.email)}">Remove</button></div></div>`).join('') || '<div class="empty sm">None.</div>'}`);
}

// ------------------------------------------------------------------ events (only while Admin is open)
const here = () => C.route === 'admin';
const again = () => { A.force = true; return C.render(); };
async function settings(body, msg) { await api('/api/admin/crm-settings', { method: 'PUT', body }); st.meta = await api('/api/crm/meta'); toast(msg || 'Saved'); return again(); }
document.addEventListener('click', async e => {
    if (!here()) return;
    const t = e.target;
    try {
        const ks = t.closest('[data-keyset]');
        if (ks) { const k = prompt(`Paste the Apify token for ${ks.dataset.label}. The old key moves to the shared pool.`); if (!k) return; await api('/api/update-apify-key', { method: 'POST', body: { newApiKey: k.trim(), engine: ks.dataset.keyset } }); toast('Key saved'); return again(); }
        const kc = t.closest('[data-keycredit]');
        if (kc) { const n = prompt('Monthly Apify credit for this key, in US dollars', kc.dataset.cur || '5'); if (!n) return; await api('/api/admin/engine-credit', { method: 'PATCH', body: { engine: kc.dataset.keycredit, monthlyCreditUsd: n } }); toast('Saved'); return again(); }
        const kd = t.closest('[data-keydel],[data-gemdel]');
        if (kd) { if (!confirm('Remove this key? Runs stop using it at once.')) return; await api(kd.dataset.keydel ? '/api/apify-keys/' + kd.dataset.keydel : '/api/gemini-keys/' + kd.dataset.gemdel, { method: 'DELETE' }); toast('Removed'); return again(); }
        const off = t.closest('[data-tooloff]');
        if (off) { const r = await api('/api/admin/tools', { method: 'PUT', body: { tools: { [off.dataset.tooloff]: false } } }); toast(r.restarting ? 'Turned off. The server restarts and is back within a minute.' : 'Turned off'); return again(); }
        const ua = t.closest('[data-uact]');
        if (ua) { const id = ua.dataset.uid, k = ua.dataset.uact, name = ua.dataset.name;
            if (k === 'on' || k === 'off') { await api('/api/admin/users/' + id, { method: 'PATCH', body: { isActive: k === 'on' } }); toast(k === 'on' ? 'Turned on' : 'Turned off. They are signed out within a minute.'); return again(); }
            if (k === 'pass') { const pw = C.makePass(); return modal('New password for ' + name, C.fieldHtml('up-p', 'New password', `type="text" value="${pw}" minlength="8"`, 'Copy it now and give it to them. It is not shown again.'), 'Save password', async () => {
                if (v('up-p').length < 8) throw new Error('Use 8 characters or more.'); await api('/api/admin/users/' + id, { method: 'PATCH', body: { password: v('up-p') } }); C.closeLayer(); toast('Password changed'); }); }
            if (k === 'remove') return modal('Remove ' + name + '?', `<p style="margin:0;color:var(--muted)">Their login is deleted. Their leads, clients and work move to you, so nothing is lost.</p>`, 'Remove', async () => { await api('/api/admin/users/' + id, { method: 'DELETE' }); C.closeLayer(); toast(name + ' removed'); again(); }); }
        const dl = t.closest('[data-inddel]'); if (dl) { dl.closest('.indrow').remove(); return; }
        const uc = t.closest('[data-unclient]'); if (uc) { const ct = readTabs(); delete ct.byClient[uc.dataset.unclient]; return settings({ clientTabs: ct }, 'It uses its kind again'); }
        const rm = t.closest('[data-alrm]'); if (rm) { rm.closest('.aline').remove(); return; }
        const a = t.closest('[data-aact]'); if (!a) return;
        const k = a.dataset.aact;
        if (k === 'genpass') { $('#ap-p').value = C.makePass(); return; }
        if (k === 'mailsave') { a.disabled = true; try {
            const body = { user: v('mb-user') || undefined, fromName: v('mb-fname'), fromEmail: v('mb-femail') || undefined, replyTo: v('mb-reply') || null, host: v('mb-host') || undefined, port: v('mb-port') ? +v('mb-port') : undefined,
                signature: $('#mb-sig') ? $('#mb-sig').value : undefined, address: v('mb-addr') || undefined, dailyCap: v('mb-cap') ? +v('mb-cap') : undefined, paused: $('#mb-paused') ? $('#mb-paused').checked : undefined,
                window: $('#mb-from') ? { from: +v('mb-from'), to: +v('mb-to'), days: $$('#mb-days input:checked').map(x => +x.value) } : undefined };
            if (v('mb-pass')) body.pass = v('mb-pass');
            await api('/api/admin/mailbox', { method: 'PUT', body }); st.meta = await api('/api/crm/meta'); toast('Mailbox saved'); return again(); } finally { a.disabled = false; } }
        if (k === 'mailoff') { if (!confirm('Disconnect the mailbox? Campaign email stops until it is connected again.')) return; await api('/api/admin/mailbox', { method: 'DELETE' }); toast('Disconnected'); return again(); }
        if (k === 'goals') return settings({ goals: Object.fromEntries(['calls', 'emails', 'prospects', 'followups'].map(x => [x, +v('go-' + x)])) }, 'Goals saved');
        if (k === 'tz') return settings({ timezone: v('go-tz') }, 'Time zone saved');
        if (k === 'indadd') { $('#indlist').insertAdjacentHTML('beforeend', `<span class="indrow"><input value="" data-ind aria-label="Industry" placeholder="New industry"><small>0</small><button type="button" class="btn ghost sm" data-inddel aria-label="Remove">${ic('x')}</button></span>`); $('#indlist .indrow:last-child input').focus(); return; }
        if (k === 'indsave') return settings({ industries: $$('[data-ind]').map(i => i.value.trim()).filter(Boolean) }, 'Industries saved');
        if (k === 'indfill') { const ids = (st.leads || []).filter(l => !l.industry).map(l => l.id); for (let i = 0; i < ids.length; i += 500) await api('/api/crm/leads/bulk', { method: 'POST', body: { ids: ids.slice(i, i + 500), set: { industry: v('bulkind') } } }); await C.leads(true); toast(`${ids.length} leads set to ${v('bulkind')}`); return again(); }
        if (k === 'geo') { await api('/api/admin/crm-settings', { method: 'PUT', body: { geo: { hint: v('geo-h') } } }); const r = await api('/api/admin/crm/geocode', { method: 'POST', body: {} }).catch(err => ({ error: err.message })); toast(r.error ? r.error : r.queued ? `Placing ${r.queued} leads, about ${Math.max(1, Math.ceil(r.seconds / 60))} min` : 'Saved. Every lead with a city is placed.'); return again(); }
        if (k === 'geoall') { if (!confirm('Look up every lead\'s place again? It takes about a second a city.')) return; await api('/api/admin/crm-settings', { method: 'PUT', body: { geo: { hint: v('geo-h') } } }); const r = await api('/api/admin/crm/geocode', { method: 'POST', body: { force: true } }); toast(`Placing ${r.queued} leads again`); return; }
        if (k === 'tabsave') return settings({ clientTabs: readTabs() }, 'Client pages saved');
        if (k === 'kindadd') { const kind = v('newkind').trim().toLowerCase(); if (!kind) return; const ct = readTabs(); ct.byType[kind] = ct.default; return settings({ clientTabs: ct }, 'Added ' + kind); }
        if (k === 'clientadd') { const id = v('newclient'); if (!id) return; const ct = readTabs(); ct.byClient[id] = ct.default; return settings({ clientTabs: ct }, 'This client has its own tabs now'); }
        if (k === 'pkadd') { $('#pklines').insertAdjacentHTML('beforeend', `<div class="aline pk"><input placeholder="Package" data-k="name"><select data-k="billing"><option value="monthly">Monthly</option><option value="one_off">One-off</option></select><input type="number" placeholder="Price" data-k="price"><input placeholder="What it includes" data-k="description"><button type="button" class="btn ghost sm" data-alrm aria-label="Remove">${ic('x')}</button></div>`); return; }
        if (k === 'pksave') { const packages = $$('#pklines .aline').map(r => Object.fromEntries($$('[data-k]', r).map(x => [x.dataset.k, x.dataset.k === 'price' ? Number(x.value || 0) : x.value]))).filter(x => x.name); await api('/api/admin/billing', { method: 'PUT', body: { packages } }); toast('Packages saved'); return again(); }
        if (k === 'bpsave') { await api('/api/admin/billing', { method: 'PUT', body: { profile: { name: v('bp-name'), email: v('bp-email'), phone: v('bp-phone'), address: v('bp-address'), terms: $('#bp-terms').value, invoiceNote: $('#bp-note').value } } }); toast('Details saved'); return again(); }
    } catch (err) { toast(err.message, true); }
});
document.addEventListener('change', async e => {
    if (!here()) return;
    const t = e.target;
    if (t.matches('[data-tool]')) { t.disabled = true; try { const r = await api('/api/admin/tools', { method: 'PUT', body: { tools: { [t.dataset.tool]: t.checked } } }); st.meta = await api('/api/crm/meta'); toast(r.restarting ? 'Saved. The server restarts and is back within a minute.' : 'Saved'); } catch (err) { t.checked = !t.checked; toast(err.message, true); } t.disabled = false; return again(); }
    if (t.matches('[data-own]')) { const ct = readTabs(), kind = t.dataset.own; if (t.checked) ct.byType[kind] = ct.default; else delete ct.byType[kind]; return settings({ clientTabs: ct }, t.checked ? kind + ' has its own tabs' : kind + ' uses the default'); }
});
document.addEventListener('submit', async e => {
    if (!here()) return;
    const f = e.target;
    if (f.id === 'poolAdd' || f.id === 'gemAdd') { e.preventDefault(); const b = f.querySelector('[type=submit]'); b.disabled = true;
        try { if (f.id === 'poolAdd') await api('/api/apify-keys', { method: 'POST', body: { token: v('pk-t').trim(), label: v('pk-l').trim() || null, engine: 'any', global: true } }); else await api('/api/gemini-keys', { method: 'POST', body: { key: v('gk-t').trim(), label: v('gk-l').trim() || null, global: true } }); toast('Key added'); return again(); }
        catch (err) { toast(err.message, true); b.disabled = false; return; } }
    const acc = f.closest('[data-access]');
    if (acc) { e.preventDefault(); const b = acc.querySelector('[type=submit]'); b.disabled = true; const pick = n => $$(`input[name=${n}]:checked`, acc).map(x => x.value);
        try { await api('/api/admin/tools/access/' + acc.dataset.access, { method: 'PUT', body: { tools: pick('tool'), clients: pick('client') } }); toast('Access saved'); } catch (err) { toast(err.message, true); } b.disabled = false; return; }
    if (f.id === 'addp') { e.preventDefault(); const b = f.querySelector('[type=submit]'); b.disabled = true;
        try { const email = v('ap-e').trim(), password = v('ap-p');
            if (!email || password.length < 8) throw new Error('Write their email and a password of 8 characters or more.');
            await api('/api/admin/users', { method: 'POST', body: { email, password, fullName: v('ap-n').trim(), role: 'user' } });
            st.meta = await api('/api/crm/meta'); toast('Teammate added'); await again();
            const out = $('#ap-out'); if (out) out.innerHTML = `<div class="note"><b>Send them this:</b> sign in at workspace.edgelead.online with ${esc(email)} and the password ${esc(password)}. They can change it with “Forgot your password?”.</div>`;
        } catch (err) { toast(err.message, true); b.disabled = false; } }
});
})();
