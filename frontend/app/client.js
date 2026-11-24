/**
 * The client page (phase 90): #client/<id>/<tab>[/<task id>]. Loaded the first time a client opens.
 *
 *   Overview           where the work stands: open tasks by status, what is due, recent work
 *   Task board         to do, doing, waiting, done; drag to move or reorder; a task opens in a side panel with its
 *                      status, priority, due date, assignee, labels, what the client sees, description (pictures paste
 *                      in), checklist, files and comments (type @ to mention someone, who gets an email)
 *   Content plan, Ad ledger (products, creatives, ads), Message templates
 *                      tables drawn from the server's own field definitions (/api/crm/client-schema)
 *   Ad brief & plan    the brief, and the plans for the owner to approve, reject or mark launched
 *   Billing            the agreement (packages and terms) and the invoices
 *   Reports, Team & access, Details
 *
 * Which tabs a client shows is the owner's choice in Admin → Client pages (by kind of client, or for one client).
 */
(function () {
'use strict';
const C = window.CRM;
const { api, esc, ic, toast, st, $, num, initials, ago, teamName, modal, v } = C;
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const TAB_ICON = { overview: 'overview', tasks: 'pipeline', content: 'cal', ledger: 'mega', adbrief: 'star', templates: 'reply', billing: 'cash', reports: 'seo', team: 'leads', details: 'note' };
const STATUS = [['todo', 'To do'], ['doing', 'Doing'], ['waiting', 'Waiting'], ['done', 'Done']];
const PRIO = [['highest', 'Highest'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low'], ['lowest', 'Lowest']];
const LABELS = ['Website', 'Content', 'Reporting', 'Ads', 'Community', 'Leads', 'Setup', 'Profile'];
const S = { id: null, client: null, members: [], tabs: [], tab: 'overview', canEdit: false, schema: null, board: null, task: null, filter: { q: '', who: '', label: '' }, wb: {}, ledger: 'products' };
const day = d => d ? new Date(d + (String(d).length === 10 ? 'T00:00:00' : '')).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const money0 = n => n == null || n === '' ? '—' : '৳' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
async function schema() { if (!S.schema) S.schema = await api('/api/crm/client-schema'); return S.schema; }

// ------------------------------------------------------------------ the page
C.views.client = async arg => {
    const [id, tab, sub] = String(arg || '').split('/');
    if (!id) { location.hash = 'clients'; return ''; }
    if (S.id !== id) Object.assign(S, { id, board: null, wb: {}, task: null });
    const [d, t] = await Promise.all([api('/api/clients/' + id), api('/api/crm/client-tabs/' + id), schema()]);
    S.client = d.client; S.members = d.members || []; S.owner = d.owner; S.tabs = t.tabs; S.canEdit = t.canEdit;
    S.tab = S.tabs.includes(tab) ? tab : 'overview';
    S.sub = sub || null;
    const c = S.client;
    const body = await ({ overview: tOverview, tasks: tBoard, content: () => tWorkbook('content'), ledger: tLedger, templates: () => tWorkbook('templates'), adbrief: tAdBrief, billing: tBilling, reports: tReports, team: tTeam, details: tDetails }[S.tab] || tOverview)();
    const lead = (st.leads || []).find(l => l.client_id === c.id);
    return `<div class="chead"><a class="btn sm ghost back" href="#clients">${ic('stage').replace('<path', '<path transform="rotate(180 12 12)"')}Clients</a>
        <div class="chtop"><span class="ava big" style="--c:var(${C.indVar(c.niche || c.name)})">${initials(c.brand || c.name)}</span><div class="t"><h1>${esc(c.name)}</h1>
          <p class="sub">${esc([c.niche, c.location].filter(Boolean).join(' · ') || 'Add what they do and where in Details')}${lead ? ` · <button type="button" class="linkbtn" data-open="${lead.id}">lead history</button>` : ''}</p></div>
          ${S.canEdit ? `<button class="btn pri" type="button" data-cact="newtask">${ic('plus')}New task</button>` : ''}</div>
        <nav class="ctabs" role="tablist" aria-label="${esc(c.name)}">${S.tabs.map(k => { const tdef = (S.schema.tabs || []).find(x => x.key === k) || { label: k };
          return `<a role="tab" href="#client/${c.id}/${k}" aria-selected="${S.tab === k}" class="${S.tab === k ? 'on' : ''}">${ic(TAB_ICON[k] || 'note')}${esc(tdef.label)}</a>`; }).join('')}
          ${C.isAdmin() ? `<a class="ctabs-cfg" href="#admin/clientpages" title="Choose which tabs clients show">${ic('settings')}</a>` : ''}</nav></div>
      <div class="cbody">${body}</div>`;
};
C.mounted.client = () => {
    if (S.tab === 'tasks' && S.sub) openTask(S.sub);
    if (S.tab === 'tasks') setupDrag();
};

// ------------------------------------------------------------------ overview
async function tOverview() {
    const [b, tl] = await Promise.all([board(true), api('/api/clients/' + S.id + '/timeline').catch(() => ({ reports: [], jobs: [] }))]);
    const open = b.tasks.filter(t => t.status !== 'done');
    const today = new Date().toISOString().slice(0, 10);
    const over = open.filter(t => t.dueDate && t.dueDate < today), soon = open.filter(t => t.dueDate && t.dueDate >= today).sort((a, z) => a.dueDate.localeCompare(z.dueDate)).slice(0, 8);
    const done30 = b.tasks.filter(t => t.status === 'done' && t.completedAt && Date.now() - new Date(t.completedAt) < 30 * 864e5).length;
    const byS = Object.fromEntries(STATUS.map(([k]) => [k, b.tasks.filter(t => t.status === k).length]));
    const tot = Math.max(1, b.tasks.length);
    return `<div class="cstats card">${[['Open tasks', open.length, ''], ['Overdue', over.length, over.length ? 'bad' : ''], ['Done in 30 days', done30, 'ok'], ['People on it', b.people.length, '']].map(([l, n, c]) => `<div><small>${l}</small><b class="${c}">${num(n)}</b></div>`).join('')}</div>
      <div class="ccols"><section class="card"><div class="card-h"><h2>Work by status</h2><a class="btn sm ghost" href="#client/${S.id}/tasks">Open the board</a></div>
          <div class="sbar">${STATUS.map(([k]) => `<i class="s-${k}" style="flex:${byS[k] || 0}" title="${byS[k]}"></i>`).join('')}</div>
          <div class="slegend2">${STATUS.map(([k, l]) => `<span class="s-${k}"><i></i>${l}<b>${byS[k]}</b><em>${Math.round(byS[k] / tot * 100)}%</em></span>`).join('')}</div>
          <div class="card-h"><h2>Due next</h2><span>${over.length ? over.length + ' overdue' : ''}</span></div>
          <div class="tlist">${[...over, ...soon].slice(0, 10).map(taskRow).join('') || '<div class="empty sm">Nothing with a due date. Give tasks a due date to see them here and on the Overview.</div>'}</div></section>
        <section class="card"><div class="card-h"><h2>Recent work</h2><span>Reports and runs</span></div>
          <div class="list">${[...(tl.reports || []).map(r => ({ at: r.created_at, t: (r.report_type || 'Report').replace(/_/g, ' '), s: r.target_handle || r.ai_summary || '' })), ...(tl.jobs || []).map(j => ({ at: j.created_at, t: String(j.type || 'Run').replace(/_/g, ' '), s: j.status }))]
            .sort((a, z) => String(z.at).localeCompare(String(a.at))).slice(0, 8).map(x => `<div class="row" style="cursor:default"><span class="kind">${ic('seo')}</span><div class="t"><b style="text-transform:capitalize">${esc(x.t)}</b><span>${esc(String(x.s || '').slice(0, 90))}</span></div><span class="dim small">${ago(x.at)}</span></div>`).join('') || '<div class="empty sm">No reports filed under this client yet.</div>'}</div>
          <div class="card-h"><h2>Team</h2></div><div class="tlist">${b.people.map(p => `<div class="trow"><span class="ava">${initials(p.name || p.email)}</span><div class="t"><b>${esc(p.name || p.email)}</b><span>${esc(p.role === 'admin' ? 'Owner' : 'Team')}</span></div><span class="dim small">${b.tasks.filter(t => t.assignee && t.assignee.id === p.id && t.status !== 'done').length} open</span></div>`).join('')}</div></section></div>`;
}
const taskRow = t => `<a class="trow" href="#client/${S.id}/tasks/${t.id}"><span class="tdot ${t.status}"></span><div class="t"><b>${esc(t.title)}</b><span>${(t.labels || []).map(l => `<span class="lab">${esc(l)}</span>`).join('')}</span></div>${t.priority && !['medium'].includes(t.priority) ? `<span class="prio ${t.priority}">${esc(t.priority)}</span>` : ''}<span class="due ${t.dueDate && t.dueDate < new Date().toISOString().slice(0, 10) ? 'over' : ''}">${C.dayLabel(t.dueDate)}</span>${who(t)}</a>`;
const who = t => t.assignee ? (t.assignee.kind === 'client' ? '<span class="ava cli" title="The client">C</span>' : `<span class="ava" title="${esc(t.assignee.name || t.assignee.email)}">${initials(t.assignee.name || t.assignee.email)}</span>`) : '<span class="ava nobody" title="Nobody yet"></span>';

// ------------------------------------------------------------------ the task board
async function board(force) { if (!S.board || force) S.board = await api('/api/clients/' + S.id + '/tasks'); return S.board; }
function shownTasks(b) {
    const q = S.filter.q.toLowerCase();
    return b.tasks.filter(t => (!q || (t.title + ' ' + t.notes).toLowerCase().includes(q)) && (!S.filter.label || (t.labels || []).includes(S.filter.label))
        && (!S.filter.who || (S.filter.who === 'client' ? t.assignee && t.assignee.kind === 'client' : S.filter.who === 'none' ? !t.assignee : t.assignee && t.assignee.id === S.filter.who)));
}
async function tBoard() {
    const b = await board(true);
    const tasks = shownTasks(b);
    const labels = [...new Set([...LABELS, ...b.tasks.flatMap(t => t.labels || [])])];
    const card = t => { const ck = t.checklist || [], dn = ck.filter(i => i.done).length;
        return `<div class="kcard ${t.status === 'done' ? 'isdone' : ''}" draggable="${S.canEdit}" data-kdrag="${t.id}" data-task="${t.id}"><div class="kh"><span class="kkey">${esc(t.key || '')}</span>${t.priority !== 'medium' ? `<span class="prio ${t.priority}">${esc(t.priority)}</span>` : ''}${t.visibleToClient ? `<span class="vis" title="The client sees this task">${ic('globe')}</span>` : ''}</div>
          <b>${esc(t.title)}</b>${(t.labels || []).length ? `<div class="klabs">${t.labels.map(l => `<span class="lab">${esc(l)}</span>`).join('')}</div>` : ''}
          <div class="kf">${t.status === 'done' ? `<span class="kck ok">${ic('task')}Done${t.completedAt ? ' ' + ago(t.completedAt) : ''}</span>` : t.dueDate ? `<span class="due ${t.dueDate < new Date().toISOString().slice(0, 10) ? 'over' : ''}">${ic('cal')}${C.dayLabel(t.dueDate)}</span>` : ''}${ck.length ? `<span class="kck ${dn === ck.length ? 'ok' : ''}">${ic('task')}${dn}/${ck.length}</span>` : ''}${t.comments ? `<span>${ic('reply')}${t.comments}</span>` : ''}<span class="sp"></span>${who(t)}</div></div>`; };
    return `<div class="kbar"><div class="searchin">${ic('search')}<input id="kq" type="search" placeholder="Search tasks" value="${esc(S.filter.q)}" aria-label="Search tasks"></div>
        <select id="kwho" aria-label="Assignee"><option value="">Everyone</option><option value="none" ${S.filter.who === 'none' ? 'selected' : ''}>Nobody yet</option><option value="client" ${S.filter.who === 'client' ? 'selected' : ''}>The client</option>${b.people.map(p => `<option value="${p.id}" ${S.filter.who === p.id ? 'selected' : ''}>${esc(p.name || p.email)}</option>`).join('')}</select>
        <select id="klab" aria-label="Label"><option value="">Every label</option>${labels.map(l => `<option ${S.filter.label === l ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
        <span class="sp"></span><span class="dim small">${b.tasks.filter(t => t.status !== 'done').length} open · ${b.tasks.filter(t => t.status === 'done').length} done</span></div>
      <div class="kb">${STATUS.map(([k, l]) => { const ts = tasks.filter(t => t.status === k).sort((a, z) => a.position - z.position);
        return `<div class="kcol" data-kcol="${k}"><div class="kcol-h"><span class="tdot ${k}"></span><b>${l}</b><span>${ts.length}</span>${S.canEdit ? `<button class="btn ghost sm" type="button" data-cact="quick" data-status="${k}" aria-label="Add to ${l}">${ic('plus')}</button>` : ''}</div>
          <div class="kcards">${S.canEdit && S.quick === k ? `<form class="kquick" data-quick="${k}"><textarea id="kqt" placeholder="What needs doing? Enter to add" rows="2"></textarea></form>` : ''}${ts.map(card).join('') || (S.quick === k ? '' : '<div class="colempty">Nothing here</div>')}</div></div>`; }).join('')}</div>`;
}
function setupDrag() {
    const kb = $('.kb'); if (!kb || kb._drag) return; kb._drag = true;
    kb.addEventListener('dragstart', e => { const c = e.target.closest('[data-kdrag]'); if (!c) return; e.dataTransfer.setData('text/kt', c.dataset.kdrag); c.classList.add('dragging'); });
    kb.addEventListener('dragend', e => { const c = e.target.closest('[data-kdrag]'); if (c) c.classList.remove('dragging'); $$('.kcol.drop').forEach(x => x.classList.remove('drop')); });
    kb.addEventListener('dragover', e => { const col = e.target.closest('.kcol'); if (!col) return; e.preventDefault(); $$('.kcol.drop').forEach(x => x !== col && x.classList.remove('drop')); col.classList.add('drop'); });
    kb.addEventListener('drop', async e => {
        const col = e.target.closest('.kcol'); if (!col) return; e.preventDefault(); col.classList.remove('drop');
        const id = e.dataTransfer.getData('text/kt'); const t = S.board.tasks.find(x => x.id === id); if (!t) return;
        const status = col.dataset.kcol, before = e.target.closest('[data-kdrag]');
        const list = S.board.tasks.filter(x => x.status === status && x.id !== id).sort((a, z) => a.position - z.position);
        let position;
        if (before && before.dataset.kdrag !== id) { const i = list.findIndex(x => x.id === before.dataset.kdrag); const prev = list[i - 1]; position = prev ? (prev.position + list[i].position) / 2 : list[i].position - 1024; }
        else position = list.length ? list[list.length - 1].position + 1024 : 1024;
        Object.assign(t, { status, position });
        try { await api('/api/tasks/' + id, { method: 'PATCH', body: { status, position } }); C.render(); } catch (err) { toast(err.message, true); C.render(); }
    });
}

// ------------------------------------------------------------------ one task, in the side panel
const RICH = /!\[[^\]]{0,80}\]\(media:([0-9a-f-]{36})\)|@\[([^\]\n]{1,80})\]\(user:([0-9a-f-]{36})\)/gi;
function rich(text, media = {}) {
    const out = []; let last = 0; const src = String(text || '');
    const part = t => esc(t).replace(/\n/g, '<br>').replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)"'])/g, u => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
    for (const m of src.matchAll(RICH)) {
        out.push(part(src.slice(last, m.index)));
        if (m[3]) out.push(`<span class="mention" data-uid="${esc(m[3])}" data-name="${esc(m[2])}" contenteditable="false">@${esc(m[2])}</span>`);
        else { const url = media[m[1].toLowerCase()]; out.push(url ? `<img class="timg" data-media="${esc(m[1])}" src="${esc(url)}" alt="Picture" loading="lazy">` : `<span class="timg-missing" data-media="${esc(m[1])}" contenteditable="false">Picture</span>`); }
        last = m.index + m[0].length;
    }
    out.push(part(src.slice(last)));
    return out.join('');
}
function editorText(root) {
    let out = '';
    const walk = n => {
        if (n.nodeType === 3) { out += n.nodeValue.replace(/ /g, ' '); return; }
        if (n.nodeType !== 1) return;
        if (n.dataset && n.dataset.media) { if (out && !out.endsWith('\n')) out += '\n'; out += `![image](media:${n.dataset.media})\n`; return; }
        if (n.dataset && n.dataset.uid) { out += `@[${String(n.dataset.name || '').replace(/[\[\]\n]/g, ' ').slice(0, 80)}](user:${n.dataset.uid})`; return; }
        if (n.tagName === 'BR') { out += '\n'; return; }
        const block = /^(DIV|P|LI|H[1-6])$/.test(n.tagName);
        if (block && out && !out.endsWith('\n')) out += '\n';
        n.childNodes.forEach(walk);
        if (block && out && !out.endsWith('\n')) out += '\n';
    };
    root.childNodes.forEach(walk);
    return out.replace(/\n{3,}/g, '\n\n').trim();
}
async function upload(url, file, headers = {}) {
    const r = await fetch(C.backend + url, { method: 'POST', headers: { Authorization: 'Bearer ' + await C.token(), 'Content-Type': file.type || 'application/octet-stream', ...headers }, body: file });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'The upload did not go through.'); return j;
}
async function shrink(file) {
    if (file.type === 'image/gif' || (file.size < 1.5 * 1024 * 1024 && /^image\/(png|jpeg|webp)$/.test(file.type))) return file;
    try { const bmp = await createImageBitmap(file); const k = Math.min(1, 2000 / Math.max(bmp.width, bmp.height)); const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k); cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height); return await new Promise(r => cv.toBlob(r, 'image/jpeg', .86)); } catch { return file; }
}
function pictures(el, media) {
    const add = async files => { for (const f of files) { if (!/^image\//.test(f.type)) continue; try { const r = await upload(`/api/clients/${S.id}/task-media`, await shrink(f)); media[r.id] = r.url; document.execCommand('insertHTML', false, `<img class="timg" data-media="${r.id}" src="${esc(r.url || '')}" alt="Picture"><br>`); } catch (e) { toast(e.message, true); } } };
    el.addEventListener('paste', e => { const fs = [...(e.clipboardData.files || [])]; if (fs.length) { e.preventDefault(); add(fs); return; } e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain')); });
    el.addEventListener('drop', e => { const fs = [...(e.dataTransfer.files || [])]; if (fs.length) { e.preventDefault(); add(fs); } });
}
function mentions(el, people) {
    const menu = document.createElement('div'); menu.className = 'mpick'; menu.hidden = true; el.after(menu);
    let range = null, list = [], cur = 0;
    const close = () => { menu.hidden = true; range = null; };
    const pick = p => { if (!range) return; const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); const tok = range.cloneRange(); tok.setStart(range.startContainer, range._at); tok.deleteContents();
        const span = document.createElement('span'); span.className = 'mention'; span.contentEditable = 'false'; span.dataset.uid = p.id; span.dataset.name = p.name; span.textContent = '@' + p.name; tok.insertNode(span);
        const sp = document.createTextNode(' '); span.after(sp); const r2 = document.createRange(); r2.setStartAfter(sp); sel.removeAllRanges(); sel.addRange(r2); close(); };
    el.addEventListener('input', () => {
        const sel = getSelection(); if (!sel.rangeCount) return close();
        const r = sel.getRangeAt(0), node = r.startContainer; if (node.nodeType !== 3) return close();
        const before = node.nodeValue.slice(0, r.startOffset), m = /(^|\s)@([\w .'-]{0,24})$/.exec(before); if (!m) return close();
        list = people.filter(p => p.name.toLowerCase().includes(m[2].toLowerCase())).slice(0, 6); if (!list.length) return close();
        range = r.cloneRange(); range._at = r.startOffset - m[2].length - 1; cur = 0;
        menu.innerHTML = list.map((p, i) => `<button type="button" data-i="${i}" class="${i ? '' : 'on'}"><span class="ava">${initials(p.name)}</span>${esc(p.name)}</button>`).join(''); menu.hidden = false;
    });
    el.addEventListener('keydown', e => { if (menu.hidden) return; if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); cur = (cur + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length; $$('button', menu).forEach((b, i) => b.classList.toggle('on', i === cur)); } if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(list[cur]); } if (e.key === 'Escape') close(); });
    menu.addEventListener('mousedown', e => { const b = e.target.closest('[data-i]'); if (b) { e.preventDefault(); pick(list[+b.dataset.i]); } });
}
async function openTask(id) {
    $('#layer').innerHTML = `<div class="scrim" data-tclose></div><aside class="drawer tdrawer" role="dialog" aria-modal="true" aria-label="Task"><div class="boot">Loading…</div></aside><div id="sub"></div>`;
    try {
        const [d, cm] = await Promise.all([api('/api/tasks/' + id), api('/api/tasks/' + id + '/comments')]);
        S.task = { ...d, comments: cm.comments || [], mentionable: (cm.people || []).filter(p => p.id !== st.meta.me.id), media: { ...(d.media || {}), ...(cm.media || {}) } };
        drawTask();
    } catch (e) { $('.drawer').innerHTML = `<div class="empty err">${esc(e.message)}</div>`; }
}
function drawTask() {
    const { task: t, files = [], canEdit, comments } = S.task, media = S.task.media;
    const ck = t.checklist || [], dn = ck.filter(i => i.done).length;
    const ro = canEdit ? '' : 'disabled';
    const people = (S.board && S.board.people) || [];
    $('.tdrawer').innerHTML = `<div class="dr-h"><div class="dr-top"><span class="kkey big">${esc(t.key || 'Task')}</span><div class="t"><textarea class="ttitle" data-tf="title" rows="1" ${ro} aria-label="Title">${esc(t.title)}</textarea></div>
        <button class="btn ghost sm" type="button" data-tclose aria-label="Close">${ic('x')}</button></div>
        <div class="tmeta">
          <label>Status<select data-tf="status" ${ro}>${STATUS.map(([k, l]) => `<option value="${k}" ${t.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label>Priority<select data-tf="priority" ${ro}>${PRIO.map(([k, l]) => `<option value="${k}" ${t.priority === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label>Due<input type="date" data-tf="dueDate" value="${esc(t.dueDate || '')}" ${ro}></label>
          <label>Assignee<select data-tf="assignee" ${ro}><option value="">Nobody</option><option value="client" ${t.assignee && t.assignee.kind === 'client' ? 'selected' : ''}>The client</option>${people.map(p => `<option value="${p.id}" ${t.assignee && t.assignee.id === p.id ? 'selected' : ''}>${esc(p.name || p.email)}</option>`).join('')}</select></label>
        </div>
        <div class="tlabels">${LABELS.concat((t.labels || []).filter(l => !LABELS.includes(l))).map(l => `<button type="button" class="lchip ${(t.labels || []).includes(l) ? 'on' : ''}" data-tlab="${esc(l)}" ${ro}>${esc(l)}</button>`).join('')}
          <label class="check vis"><input type="checkbox" data-tf="visibleToClient" ${t.visibleToClient ? 'checked' : ''} ${ro}> The client sees this task</label></div></div>
      <div class="tbody">
        <section><h3>Description</h3><div class="ted" id="tnotes" ${canEdit ? 'contenteditable="true"' : ''} data-placeholder="What needs doing, and anything useful. Paste pictures straight in.">${rich(t.notes, media)}</div>
          ${canEdit ? '<div class="tbar"><span class="dim small">Pictures can be pasted or dropped in.</span><button class="btn sm" type="button" data-cact="savenotes">Save description</button></div>' : ''}</section>
        <section><h3>Checklist <span class="dim">${ck.length ? dn + ' of ' + ck.length : ''}</span></h3>${ck.length ? `<div class="ckbar"><i style="width:${ck.length ? Math.round(dn / ck.length * 100) : 0}%"></i></div>` : ''}
          <div class="ck">${ck.map((i, n) => `<label class="${i.done ? 'done' : ''}"><input type="checkbox" data-ck="${n}" ${i.done ? 'checked' : ''} ${ro}><span>${esc(i.text)}</span>${canEdit ? `<button type="button" class="btn ghost sm" data-ckdel="${n}" aria-label="Remove">${ic('x')}</button>` : ''}</label>`).join('')}</div>
          ${canEdit ? '<form class="ckadd" data-ckadd><input id="ckin" placeholder="Add an item, Enter to save" maxlength="200"></form>' : ''}</section>
        <section><h3>Files <span class="dim">${files.length || ''}</span></h3><div class="files">${files.map(f => `<div class="file"><span class="fi">${esc((f.name.split('.').pop() || '').toUpperCase())}</span><div class="t"><b>${f.url ? `<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.name)}</a>` : esc(f.name)}</b><span>${f.bytes >= 1048576 ? (f.bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(f.bytes / 1024)) + ' KB'} · ${ago(f.createdAt)}${f.uploadedBy ? ' · ' + esc(f.uploadedBy.name || '') : ''}</span></div>${canEdit ? `<button type="button" class="btn ghost sm" data-fdel="${f.id}" aria-label="Remove">${ic('trash')}</button>` : ''}</div>`).join('')}</div>
          <label class="btn sm fileadd">${ic('up')}Attach PDF, Word or Excel<input type="file" id="tfile" accept=".pdf,.doc,.docx,.xls,.xlsx,.csv" multiple hidden></label></section>
        <section><h3>Comments <span class="dim">${comments.length || ''}</span></h3><div class="comments">${comments.map(c => `<div class="cm ${c.author.kind === 'client' ? 'fromcl' : ''}"><span class="ava">${initials(c.author.name)}</span><div><div class="cmh"><b>${esc(c.author.name)}</b>${c.author.kind === 'client' ? '<span class="pill">client</span>' : ''}<span class="dim small">${ago(c.createdAt)}</span></div><div class="cmb">${rich(c.body, media)}</div></div></div>`).join('') || '<div class="dim small">No comments yet.</div>'}</div>
          <div class="ccompose"><div class="ted sm" id="tcbox" contenteditable="true" data-placeholder="${t.visibleToClient ? 'The client reads these comments. Type @ to mention a teammate.' : 'Only the team sees this. Type @ to mention someone; they get an email.'}"></div><div class="tbar"><span class="sp"></span><button class="btn sm pri" type="button" data-cact="comment">Comment</button></div></div></section>
        ${canEdit ? `<section class="tdanger"><span class="dim small">Made ${ago(t.createdAt)}${t.createdBy ? ' by ' + esc(teamName(t.createdBy)) : ''}${t.source ? ' · from ' + esc(t.source.label || t.source.type) : ''}</span><button type="button" class="btn sm ghost danger" data-cact="deltask">${ic('trash')}Delete task</button></section>` : ''}
      </div>`;
    const ta = $('.ttitle'); if (ta) { const fit = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }; fit(); ta.addEventListener('input', fit); }
    if (canEdit) pictures($('#tnotes'), media);
    pictures($('#tcbox'), media); mentions($('#tcbox'), S.task.mentionable);
}
async function patchTask(body, quiet) {
    const t = S.task.task;
    try { const r = await api('/api/tasks/' + t.id, { method: 'PATCH', body }); S.task.task = { ...t, ...r.task }; const i = S.board ? S.board.tasks.findIndex(x => x.id === t.id) : -1; if (i >= 0) S.board.tasks[i] = S.task.task; if (!quiet) toast('Saved'); return true; }
    catch (e) { toast(e.message, true); return false; }
}
const closeTask = () => { S.task = null; C.closeLayer(); if (S.tab === 'tasks') { history.replaceState(null, '', `#client/${S.id}/tasks`); C.render(); } };

// ------------------------------------------------------------------ workbook tables: content plan, ledger, templates
async function wb(kind, force) { if (!S.wb[kind] || force) { const d = await api(`/api/clients/${S.id}/workbook?parts=${kind}`); S.wb[kind] = d[kind] || []; S.wbEdit = d.canEdit; } return S.wb[kind]; }
const WB_COLS = { content: ['planned_on', 'platform', 'post_type', 'idea', 'status', 'posted_url'], products: ['name', 'category', 'stock', 'cost', 'price'], creatives: ['title', 'format', 'angle', 'posted_on', 'influencer', 'link'],
    ads: ['creative_id', 'status', 'campaign', 'start_on', 'end_on', 'spend', 'reach', 'clicks', 'orders', 'verdict'], templates: ['title', 'category', 'body'] };
const WB_TITLE = { content: 'Content plan', products: 'Products', creatives: 'Creatives', ads: 'Ads run', templates: 'Message templates' };
function cellOf(kind, f, r) {
    const fd = S.schema.workbook[kind].fields[f] || {}; const x = r[f];
    if (x == null || x === '') return '<span class="dim">—</span>';
    if (f === 'creative_id') { const c = (S.wb.creatives || []).find(y => y.id === x); return esc(c ? c.title : 'A creative'); }
    if (fd.t === 'date') return day(x);
    if (fd.t === 'money') return money0(x);
    if (fd.t === 'int') return num(x);
    if (fd.t === 'url') return `<a href="${esc(x)}" target="_blank" rel="noopener" data-stop>${ic('ext')}Open</a>`;
    if (fd.t === 'enum') return `<span class="wstat w-${esc(String(x).toLowerCase().replace(/\s/g, ''))}">${esc(x)}</span>`;
    return `<span class="clip">${esc(String(x).slice(0, 140))}</span>`;
}
async function tWorkbook(kind, extra = '') {
    const rows = await wb(kind, true);
    if (kind === 'ads') await wb('creatives');
    const def = S.schema.workbook[kind], cols = WB_COLS[kind].filter(f => def.fields[f]);
    const byMonth = kind === 'content';
    let lastM = '';
    return `${extra}<div class="kbar"><h2>${WB_TITLE[kind]}</h2><span class="dim small">${num(rows.length)} ${esc(def.label)}${rows.length === 1 ? '' : 's'}</span><span class="sp"></span>${S.wbEdit ? `<button class="btn pri sm" type="button" data-wbnew="${kind}">${ic('plus')}Add ${esc(def.label)}</button>` : ''}</div>
      ${rows.length ? `<div class="card tablewrap"><table class="wtbl"><thead><tr>${cols.map(f => `<th>${esc(def.fields[f].label)}</th>`).join('')}</tr></thead><tbody>
        ${rows.map(r => { const m = byMonth && r.planned_on ? new Date(r.planned_on + 'T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) : ''; const head = byMonth && m !== lastM ? `<tr class="mrow"><td colspan="${cols.length}">${esc(m || 'No date')}</td></tr>` : ''; lastM = m;
          return head + `<tr data-wbrow="${kind}:${r.id}">${cols.map(f => `<td>${cellOf(kind, f, r)}</td>`).join('')}</tr>`; }).join('')}</tbody></table></div>`
        : `<div class="card"><div class="empty">${ic(kind === 'content' ? 'cal' : kind === 'templates' ? 'reply' : 'mega')}Nothing yet.${S.wbEdit ? ` <button class="btn sm" type="button" data-wbnew="${kind}">Add the first ${esc(def.label)}</button>` : ''}</div></div>`}`;
}
async function tLedger() {
    const sub = ['products', 'creatives', 'ads'].includes(S.sub) ? S.sub : S.ledger; S.ledger = sub;
    if (sub !== 'creatives') await wb('creatives');
    return tWorkbook(sub, `<div class="seg ledger" role="tablist">${[['products', 'Products'], ['creatives', 'Creatives'], ['ads', 'Ads run']].map(([k, l]) => `<a role="tab" href="#client/${S.id}/ledger/${k}" class="${sub === k ? 'on' : ''}">${l}</a>`).join('')}</div>`);
}
function fieldInput(id, f, val, refs = {}) {
    const n = `id="${id}"`;
    if (f.t === 'text') return `<textarea ${n} rows="3">${esc(val || '')}</textarea>`;
    if (f.t === 'enum') return `<select ${n}><option value="">—</option>${f.list.map(o => `<option ${String(val) === String(o) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    if (f.t === 'set') return `<div class="tick" ${n} data-set>${f.list.map(o => `<label><input type="checkbox" value="${esc(o)}" ${(val || []).includes(o) ? 'checked' : ''}>${esc(o)}</label>`).join('')}</div>`;
    if (f.t === 'id' && refs[f.ref]) return `<select ${n}><option value="">—</option>${refs[f.ref].map(o => `<option value="${o.id}" ${val === o.id ? 'selected' : ''}>${esc(o.title || o.name || o.idea || 'Item')}</option>`).join('')}</select>`;
    if (f.t === 'ids' && refs[f.ref]) return `<div class="tick" ${n} data-set>${refs[f.ref].map(o => `<label><input type="checkbox" value="${o.id}" ${(val || []).includes(o.id) ? 'checked' : ''}>${esc(o.name || o.title)}</label>`).join('')}</div>`;
    const type = { date: 'date', int: 'number', money: 'number', url: 'url' }[f.t] || 'text';
    return `<input ${n} type="${type}" ${f.t === 'money' ? 'step="0.01"' : ''} value="${esc(val ?? '')}">`;
}
const readField = (id, f) => { const el = $('#' + id); if (!el) return undefined; if (el.dataset.set !== undefined) return $$('input:checked', el).map(x => x.value); const x = el.value; return x === '' ? null : x; };
async function wbForm(kind, row) {
    const def = S.schema.workbook[kind];
    const refs = { products: kind === 'creatives' ? await wb('products') : null, creatives: kind === 'ads' ? await wb('creatives') : null };
    const fields = Object.entries(def.fields).filter(([, f]) => f.t !== 'id' || refs[f.ref]).filter(([, f]) => f.t !== 'ids' || refs[f.ref]);
    modal(row ? `Edit ${def.label}` : `Add ${def.label}`, `<div class="wform">${fields.map(([k, f]) => `<div class="field ${f.t === 'text' || f.t === 'ids' ? 'wide' : ''}"><label for="wf-${k}">${esc(f.label)}${f.req ? ' <span class="req">required</span>' : ''}</label>${fieldInput('wf-' + k, f, row ? row[k] : f.dflt, refs)}</div>`).join('')}</div>
      ${row ? `<button type="button" class="btn sm ghost danger" data-wbdel="${kind}:${row.id}">${ic('trash')}Delete this ${esc(def.label)}</button>` : ''}`, row ? 'Save' : 'Add', async () => {
        const body = Object.fromEntries(fields.map(([k, f]) => [k, readField('wf-' + k, f)]));
        if (row) await api(`/api/clients/${S.id}/workbook/${kind}/${row.id}`, { method: 'PATCH', body }); else await api(`/api/clients/${S.id}/workbook/${kind}`, { method: 'POST', body });
        $('#sub').innerHTML = ''; C.closeLayer(); toast(row ? 'Saved' : 'Added'); S.wb[kind] = null; C.render();
    }, true);
}

// ------------------------------------------------------------------ ad brief and plans
function formOf(prefix, spec, val = {}) {
    return Object.entries(spec).map(([k, f]) => {
        if (f.t === 'list') { const items = Array.isArray(val[k]) && val[k].length ? val[k] : [];
            return `<div class="field wide"><div class="lhead"><label>${esc(f.label)}</label><button type="button" class="btn sm" data-listadd="${prefix}-${k}">${ic('plus')}Add</button></div><div class="listf" id="${prefix}-${k}" data-list="${k}" data-max="${f.max}">${items.map((it, i) => listItem(`${prefix}-${k}`, i, f.of, it)).join('')}</div></div>`; }
        return `<div class="field ${f.t === 'text' || f.t === 'set' ? 'wide' : ''}"><label for="${prefix}-${k}">${esc(f.label)}</label>${fieldInput(prefix + '-' + k, f, val[k])}</div>`;
    }).join('');
}
const listItem = (p, i, of, it = {}) => `<fieldset class="litem" data-li="${i}"><legend>${i + 1}<button type="button" class="btn ghost sm" data-listdel aria-label="Remove">${ic('x')}</button></legend><div class="wform">${formOf(`${p}-${i}`, of, it)}</div></fieldset>`;
function readForm(prefix, spec) {
    const out = {};
    for (const [k, f] of Object.entries(spec)) {
        if (f.t === 'list') { out[k] = $$(`#${prefix}-${k} > .litem`).map(el => readForm(`${prefix}-${k}-${el.dataset.li}`, f.of)); continue; }
        const x = readField(`${prefix}-${k}`, f); if (x !== null && x !== undefined && !(Array.isArray(x) && !x.length)) out[k] = f.t === 'int' || f.t === 'money' ? Number(x) : x;
    }
    return out;
}
async function tAdBrief() {
    const ad = S.schema.ad;
    if (!ad) return '<div class="empty">The ad brief is not available on this server.</div>';
    const [b, p] = await Promise.all([api(`/api/clients/${S.id}/ad-brief`).catch(e => ({ error: e.message })), api(`/api/clients/${S.id}/ad-plans`).catch(e => ({ error: e.message }))]);
    if (b.error) return `<div class="card"><div class="empty err">${esc(b.error)}</div></div>`;
    S.plans = p.plans || []; S.canDecide = !!p.canDecide;
    const brief = b.brief || {};
    if (S.sub === 'plan') return planEditor(null);
    const plan = S.plans.find(x => x.id === S.sub); if (plan) return planEditor(plan);
    return `<div class="ccols"><section class="card"><div class="card-h"><h2>The brief</h2><span>${brief.updated_at ? 'Saved ' + ago(brief.updated_at) : 'Not filled in yet'}</span></div>
        <form class="wform pad" id="briefform">${formOf('br', ad.brief, brief)}</form>${S.canEdit ? '<div class="tbar pad"><span class="sp"></span><button class="btn pri" type="button" data-cact="savebrief">Save the brief</button></div>' : ''}</section>
      <section class="card"><div class="card-h"><h2>Plans</h2>${S.canEdit ? `<a class="btn sm pri" href="#client/${S.id}/adbrief/plan">${ic('plus')}New plan</a>` : ''}</div>
        <div class="list">${S.plans.map(x => `<a class="row" href="#client/${S.id}/adbrief/${x.id}"><span class="kind">${ic('star')}</span><div class="t"><b>${esc(x.title)}</b><span>${esc([x.plan && x.plan.objective, x.plan && x.plan.total_budget ? money0(x.plan.total_budget) : null].filter(Boolean).join(' · ') || 'Draft')}</span></div><span class="wstat w-${esc(x.status)}">${esc(x.status)}</span><span class="dim small">${ago(x.updated_at || x.created_at)}</span></a>`).join('') || '<div class="empty sm">No plans yet. A plan is ad sets, creatives and the rules for stopping and scaling, for the owner to approve.</div>'}</div></section></div>`;
}
function planEditor(plan) {
    const ad = S.schema.ad, pv = (plan && plan.plan) || {};
    return `<div class="kbar"><a class="btn sm ghost" href="#client/${S.id}/adbrief">${ic('stage').replace('<path', '<path transform="rotate(180 12 12)"')}Brief and plans</a><span class="sp"></span>
        ${plan ? `<span class="wstat w-${esc(plan.status)}">${esc(plan.status)}</span>${S.canDecide ? ['approved', 'rejected', 'launched'].filter(x => x !== plan.status && (x !== 'launched' || plan.status === 'approved')).map(x => `<button class="btn sm" type="button" data-plan="${x}">${{ approved: 'Approve', rejected: 'Reject', launched: 'Mark launched' }[x]}</button>`).join('') : ''}` : ''}</div>
      <section class="card"><div class="wform pad"><div class="field wide"><label for="pl-title">Plan name</label><input id="pl-title" value="${esc(plan ? plan.title : 'Ad plan, ' + new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }))}"></div>${formOf('pl', ad.plan, pv)}</div>
        ${S.canEdit ? `<div class="tbar pad"><span class="dim small">${plan && plan.status !== 'draft' ? 'Saving a change sends it back to draft.' : ''}</span><span class="sp"></span>${plan ? '<button class="btn ghost danger" type="button" data-cact="delplan">Delete</button>' : ''}<button class="btn pri" type="button" data-cact="saveplan" data-id="${plan ? plan.id : ''}">Save plan</button></div>` : ''}</section>`;
}

// ------------------------------------------------------------------ billing
async function tBilling() {
    const [a, all] = await Promise.all([api(`/api/clients/${S.id}/agreement`).catch(e => ({ error: e.message })), api('/api/billing').catch(() => ({ invoices: [] }))]);
    if (a.error) return `<div class="card"><div class="empty err">${esc(a.error)}</div></div>`;
    S.agreement = a; const ag = a.agreement || { items: [], totals: { monthly: 0, oneOff: 0 }, status: 'empty' };
    const inv = (all.invoices || []).filter(i => i.clientId === S.id);
    return `<div class="ccols"><section class="card"><div class="card-h"><h2>Agreement</h2><span class="wstat w-${ag.status}">${{ empty: 'Not set', awaiting: 'Awaiting signature', signed: 'Signed' }[ag.status] || ag.status}</span></div>
        <div class="list">${(ag.items || []).map(i => `<div class="row" style="cursor:default"><span class="kind">${ic('client')}</span><div class="t"><b>${esc(i.name)}</b><span>${esc(i.description || (i.deliverables || []).join(', ') || '')}</span></div><b>${money0(i.price)}</b><span class="dim small">${i.billing === 'monthly' ? '/ month' : 'once'}</span></div>`).join('') || '<div class="empty sm">No packages on the agreement yet.</div>'}</div>
        <div class="totals"><div><small>Monthly</small><b>${money0(ag.totals.monthly)}</b></div><div><small>One-off</small><b>${money0(ag.totals.oneOff)}</b></div><div><small>Starts</small><b>${day(ag.startDate)}</b></div></div>
        ${ag.signed ? `<p class="note" style="margin:0 18px 16px">Signed by ${esc(ag.signed.name)} on ${day(ag.signed.at)}.</p>` : ''}
        ${a.canEdit ? `<div class="tbar pad"><span class="sp"></span><button class="btn" type="button" data-cact="agreement">${ag.items.length ? 'Change the agreement' : 'Set up the agreement'}</button></div>` : ''}</section>
      <section class="card"><div class="card-h"><h2>Invoices</h2>${a.canEdit ? `<button class="btn sm pri" type="button" data-cact="invoice">${ic('plus')}New invoice</button>` : ''}</div>
        <div class="list">${inv.map(i => `<div class="row" style="cursor:default"><span class="kind">${ic('note')}</span><div class="t"><b>${esc(i.number)} · ${money0(i.total)}</b><span>Issued ${day(i.issueDate)}${i.dueDate ? ' · due ' + day(i.dueDate) : ''}</span></div><span class="wstat w-${i.overdue ? 'overdue' : i.status}">${i.overdue ? 'overdue' : esc(i.status)}</span>
          ${a.canEdit && i.status !== 'void' ? `<select class="btn sm" data-invst="${i.id}" aria-label="Status"><option value="">Mark…</option>${['paid', 'unpaid', 'void'].filter(s => s !== i.status).map(s => `<option value="${s}">${s}</option>`).join('')}</select>` : ''}</div>`).join('') || '<div class="empty sm">No invoices yet.</div>'}</div></section></div>`;
}

// ------------------------------------------------------------------ reports, team, details
async function tReports() {
    const tl = await api('/api/clients/' + S.id + '/timeline').catch(() => ({ reports: [] }));
    const kind = r => r.platform === 'instagram' ? 'ig' : r.report_type === 'fb_page' ? 'fbpage' : r.platform === 'facebook' ? 'fbgroups' : null;
    const open = C.toolsState().open;
    return `<div class="kbar"><h2>Reports</h2><span class="dim small">Filed under this client by the Tools</span><span class="sp"></span>${open ? '<a class="btn sm" href="/tools">Open the Tools</a>' : ''}</div>
      <section class="card"><div class="list">${(tl.reports || []).map(r => { const k = kind(r); const href = k && open ? `/tools#report/${k}/${r.id}` : null;
        return `<${href ? `a href="${href}"` : 'div style="cursor:default"'} class="row"><span class="grade g${esc(String(r.grade || '').charAt(0))}">${esc(r.grade || '–')}</span><div class="t"><b>${esc(r.target_handle ? (r.platform === 'instagram' ? '@' : '') + r.target_handle : String(r.report_type || 'Report').replace(/_/g, ' '))}</b><span>${esc([String(r.report_type || '').replace(/_/g, ' '), r.score != null ? 'score ' + r.score : null].filter(Boolean).join(' · '))}</span></div><span class="dim small">${ago(r.created_at)}</span></${href ? 'a' : 'div'}>`; }).join('') || '<div class="empty sm">No reports yet. Run one in the Tools with this client chosen.</div>'}</div></section>`;
}
async function tTeam() {
    return `<div class="kbar"><h2>Team &amp; access</h2><span class="dim small">Who on the team can open and work on ${esc(S.client.name)}</span></div>
      <section class="card"><div class="list">
        <div class="row" style="cursor:default"><span class="ava">${initials(teamName(S.owner && S.owner.id) !== '—' ? teamName(S.owner.id) : (S.owner && S.owner.email))}</span><div class="t"><b>${esc(teamName(S.owner && S.owner.id) !== '—' ? teamName(S.owner.id) : (S.owner && S.owner.email) || 'Account lead')}</b><span>Account lead</span></div></div>
        ${S.members.filter(m => m.accountRole !== 'client').map(m => `<div class="row" style="cursor:default"><span class="ava">${initials(m.name || m.email)}</span><div class="t"><b>${esc(m.name || m.email)}</b><span>${m.role === 'editor' ? 'Can edit' : 'Can view'} · added ${ago(m.created_at)}</span></div>${S.canEdit ? `<button class="btn sm ghost danger" type="button" data-memdel="${m.user_id}">Remove</button>` : ''}</div>`).join('')}
      </div>${S.canEdit ? `<form class="tbar pad" id="memadd"><select id="mem-u" aria-label="Teammate">${st.meta.team.filter(p => p.id !== (S.owner && S.owner.id) && !S.members.some(m => m.user_id === p.id)).map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('') || '<option value="">Everyone is on it</option>'}</select><select id="mem-r" aria-label="Access"><option value="editor">Can edit</option><option value="viewer">Can view</option></select><button class="btn pri sm" type="submit">Add to client</button></form>` : ''}</section>`;
}
async function tDetails() {
    const c = S.client;
    const F = [['name', 'Name'], ['brand', 'Brand'], ['niche', 'Kind of business'], ['location', 'Location'], ['ig_handle', 'Instagram'], ['fb_page', 'Facebook Page']];
    return `<section class="card"><div class="card-h"><h2>Details</h2><span>The kind of business decides which tabs show</span></div>
      <form class="wform pad" id="cdetails">${F.map(([k, l]) => `<div class="field"><label for="cd-${k}">${l}</label><input id="cd-${k}" value="${esc(c[k] || '')}" ${S.canEdit ? '' : 'disabled'} ${k === 'niche' ? 'list="cd-kinds" placeholder="Roofing, Restaurant, E-commerce…"' : ''}></div>`).join('')}
        <datalist id="cd-kinds">${C.industries().map(i => `<option value="${esc(i)}">`).join('')}</datalist>
        <div class="field wide"><label for="cd-notes">Notes</label><textarea id="cd-notes" rows="5" ${S.canEdit ? '' : 'disabled'}>${esc(c.notes || '')}</textarea></div></form>
      ${S.canEdit ? `<div class="tbar pad"><button class="btn ghost danger" type="button" data-cact="archive">Archive client</button><span class="sp"></span><button class="btn" type="button" data-pinclient="${c.id}" data-name="${esc(c.name)}">${ic('pin')}${c.lat != null ? 'Move its pin' : 'Pin on the influencer map'}</button><button class="btn pri" type="button" data-cact="savedetails">Save details</button></div>` : ''}</section>`;
}

// ------------------------------------------------------------------ events (only while a client page is open)
const here = () => C.route === 'client';
document.addEventListener('click', async e => {
    if (!here()) return;
    const t = e.target;
    if (t.closest('[data-tclose]')) return closeTask();
    const tk = t.closest('[data-task]'); if (tk && !t.closest('a[data-stop]')) { history.replaceState(null, '', `#client/${S.id}/tasks/${tk.dataset.task}`); return openTask(tk.dataset.task); }
    const row = t.closest('[data-wbrow]'); if (row && !t.closest('[data-stop]')) { const [k, id] = row.dataset.wbrow.split(':'); return wbForm(k, (S.wb[k] || []).find(r => r.id === id)); }
    const nw = t.closest('[data-wbnew]'); if (nw) return wbForm(nw.dataset.wbnew, null);
    const wd = t.closest('[data-wbdel]'); if (wd) { const [k, id] = wd.dataset.wbdel.split(':'); if (!confirm('Delete it? This cannot be undone.')) return; try { await api(`/api/clients/${S.id}/workbook/${k}/${id}`, { method: 'DELETE' }); C.closeLayer(); toast('Deleted'); S.wb[k] = null; C.render(); } catch (err) { toast(err.message, true); } return; }
    const la = t.closest('[data-listadd]'); if (la) { const box = $('#' + la.dataset.listadd); const k = box.dataset.list; const spec = la.dataset.listadd.startsWith('pl-') ? S.schema.ad.plan[k].of : S.schema.ad.brief[k].of;
        if (box.children.length >= +box.dataset.max) return toast(`${box.dataset.max} at most.`, true); box.insertAdjacentHTML('beforeend', listItem(la.dataset.listadd, Date.now() % 100000, spec)); return; }
    const ld = t.closest('[data-listdel]'); if (ld) { ld.closest('.litem').remove(); return; }
    const lab = t.closest('[data-tlab]'); if (lab && S.task) { const l = lab.dataset.tlab, cur = S.task.task.labels || []; const next = cur.includes(l) ? cur.filter(x => x !== l) : [...cur, l]; if (await patchTask({ labels: next }, true)) drawTask(); return; }
    const ckd = t.closest('[data-ckdel]'); if (ckd && S.task) { e.preventDefault(); const ck = [...S.task.task.checklist]; ck.splice(+ckd.dataset.ckdel, 1); if (await patchTask({ checklist: ck }, true)) drawTask(); return; }
    const fd = t.closest('[data-fdel]'); if (fd && S.task) { if (!confirm('Remove this file?')) return; try { await api(`/api/tasks/${S.task.task.id}/files/${fd.dataset.fdel}`, { method: 'DELETE' }); S.task.files = S.task.files.filter(f => f.id !== fd.dataset.fdel); drawTask(); } catch (err) { toast(err.message, true); } return; }
    const md = t.closest('[data-memdel]'); if (md) { if (!confirm('Take them off this client?')) return; try { await api(`/api/clients/${S.id}/members/${md.dataset.memdel}`, { method: 'DELETE' }); toast('Removed'); C.render(); } catch (err) { toast(err.message, true); } return; }
    const pl = t.closest('[data-plan]'); if (pl) { try { await api(`/api/clients/${S.id}/ad-plans/${S.sub}`, { method: 'PATCH', body: { status: pl.dataset.plan } }); toast('Plan ' + pl.dataset.plan); C.render(); } catch (err) { toast(err.message, true); } return; }
    const a = t.closest('[data-cact]'); if (!a) return;
    const k = a.dataset.cact;
    try {
        if (k === 'newtask') { location.hash = `client/${S.id}/tasks`; S.quick = 'todo'; await C.render(); const q = $('#kqt'); if (q) q.focus(); return; }
        if (k === 'quick') { S.quick = S.quick === a.dataset.status ? null : a.dataset.status; await C.render(); const q = $('#kqt'); if (q) q.focus(); return; }
        if (k === 'savenotes' && S.task) { await patchTask({ notes: editorText($('#tnotes')) }); return; }
        if (k === 'comment' && S.task) { const box = $('#tcbox'), body = editorText(box); if (!body) return toast('Write something first.', true);
            const r = await api(`/api/tasks/${S.task.task.id}/comments`, { method: 'POST', body: { body } }); if (r.comment) S.task.comments.push({ ...r.comment, author: { kind: 'team', name: teamName(st.meta.me.id) } }); else { const cm = await api(`/api/tasks/${S.task.task.id}/comments`); S.task.comments = cm.comments || []; Object.assign(S.task.media, cm.media || {}); }
            drawTask(); toast((r.mentioned || []).length ? `Comment added. ${r.mentioned.length === 1 ? 'The person you mentioned gets' : r.mentioned.length + ' people get'} an email.` : 'Comment added'); return; }
        if (k === 'deltask' && S.task) { if (!confirm('Delete this task, its comments and files?')) return; await api('/api/tasks/' + S.task.task.id, { method: 'DELETE' }); toast('Task deleted'); S.board = null; return closeTask(); }
        if (k === 'savebrief') { await api(`/api/clients/${S.id}/ad-brief`, { method: 'PUT', body: readForm('br', S.schema.ad.brief) }); toast('Brief saved'); return; }
        if (k === 'saveplan') { const body = { title: v('pl-title').trim(), plan: readForm('pl', S.schema.ad.plan) }; const id = a.dataset.id;
            const r = id ? await api(`/api/clients/${S.id}/ad-plans/${id}`, { method: 'PATCH', body }) : await api(`/api/clients/${S.id}/ad-plans`, { method: 'POST', body });
            toast('Plan saved'); location.hash = `client/${S.id}/adbrief/${(r.plan || {}).id || id}`; return; }
        if (k === 'delplan') { if (!confirm('Delete this plan?')) return; await api(`/api/clients/${S.id}/ad-plans/${S.sub}`, { method: 'DELETE' }); toast('Plan deleted'); location.hash = `client/${S.id}/adbrief`; return; }
        if (k === 'savedetails') { const body = Object.fromEntries(['name', 'brand', 'niche', 'location', 'ig_handle', 'fb_page'].map(f => [f, v('cd-' + f)])); body.notes = $('#cd-notes').value; await api('/api/clients/' + S.id, { method: 'PATCH', body }); toast('Saved'); C.render(); return; }
        if (k === 'archive') { if (!confirm(`Archive ${S.client.name}? It leaves the client list; nothing is deleted.`)) return; await api('/api/clients/' + S.id, { method: 'PATCH', body: { archived: true } }); toast('Archived'); location.hash = 'clients'; return; }
        if (k === 'agreement') return agreementForm();
        if (k === 'invoice') return invoiceForm();
    } catch (err) { toast(err.message, true); }
});
document.addEventListener('change', async e => {
    if (!here()) return;
    const t = e.target;
    if (t.id === 'kwho') { S.filter.who = t.value; return C.render(); }
    if (t.id === 'klab') { S.filter.label = t.value; return C.render(); }
    if (t.dataset.tf && S.task) { const f = t.dataset.tf; const val = t.type === 'checkbox' ? t.checked : t.value;
        const body = f === 'assignee' ? { assignee: val || null } : f === 'dueDate' ? { dueDate: val || null } : { [f]: val };
        if (await patchTask(body, f === 'title')) { if (f !== 'title') drawTask(); } return; }
    if (t.dataset.ck !== undefined && S.task) { const ck = S.task.task.checklist.map((i, n) => n === +t.dataset.ck ? { ...i, done: t.checked } : i); if (await patchTask({ checklist: ck }, true)) drawTask(); return; }
    if (t.id === 'tfile' && S.task) { for (const f of t.files) { try { const r = await upload(`/api/tasks/${S.task.task.id}/files`, f, { 'X-File-Name': encodeURIComponent(f.name) }); S.task.files = [...(S.task.files || []), r.file]; } catch (err) { toast(err.message, true); } } drawTask(); return; }
    if (t.dataset.invst && t.value) { try { await api('/api/invoices/' + t.dataset.invst, { method: 'PATCH', body: { status: t.value } }); toast('Marked ' + t.value); C.render(); } catch (err) { toast(err.message, true); } }
});
document.addEventListener('focusout', e => { if (here() && e.target.classList && e.target.classList.contains('ttitle') && S.task && e.target.value.trim() && e.target.value.trim() !== S.task.task.title) patchTask({ title: e.target.value.trim() }); });
document.addEventListener('input', e => { if (here() && e.target.id === 'kq') { const pos = e.target.selectionStart; S.filter.q = e.target.value; clearTimeout(e.target._d); e.target._d = setTimeout(async () => { await C.render(); const n = $('#kq'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }, 200); } });
document.addEventListener('keydown', e => {
    if (!here()) return;
    if (e.target.id === 'kqt' && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const title = e.target.value.trim(); if (!title) return; const status = e.target.closest('[data-quick]').dataset.quick;
        api(`/api/clients/${S.id}/tasks`, { method: 'POST', body: { title, status } }).then(() => { toast('Task added'); S.quick = status; return C.render(); }).then(() => { const q = $('#kqt'); if (q) q.focus(); }).catch(err => toast(err.message, true)); }
    if (e.target.classList && e.target.classList.contains('ttitle') && e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
    if (e.key === 'Escape' && S.task) closeTask();
});
document.addEventListener('submit', async e => {
    if (!here()) return;
    if (e.target.matches('[data-ckadd]')) { e.preventDefault(); const text = v('ckin').trim(); if (!text || !S.task) return; if (await patchTask({ checklist: [...(S.task.task.checklist || []), { text, done: false }] }, true)) { drawTask(); const i = $('#ckin'); if (i) i.focus(); } return; }
    if (e.target.id === 'memadd') { e.preventDefault(); const uid = v('mem-u'); const p = st.meta.team.find(x => x.id === uid); if (!p) return;
        const email = p.email;
        if (!email) return toast('Their email is not known. Ask the owner to check their login in Admin.', true);
        try { await api(`/api/clients/${S.id}/members`, { method: 'POST', body: { email, role: v('mem-r') } }); toast(p.name + ' added'); C.render(); } catch (err) { toast(err.message, true); } }
});

// ------------------------------------------------------------------ agreement and invoice forms
function agreementForm() {
    const a = S.agreement, ag = a.agreement || { items: [], terms: '', startDate: null };
    const line = (it = {}, i) => `<div class="aline" data-al="${i}"><input placeholder="Package or service" value="${esc(it.name || '')}" data-k="name"><select data-k="billing"><option value="monthly" ${it.billing !== 'one_off' ? 'selected' : ''}>Monthly</option><option value="one_off" ${it.billing === 'one_off' ? 'selected' : ''}>One-off</option></select><input type="number" placeholder="Price" value="${esc(it.price ?? '')}" data-k="price"><input placeholder="What it includes" value="${esc(it.description || '')}" data-k="description"><button type="button" class="btn ghost sm" data-alrm aria-label="Remove">${ic('x')}</button></div>`;
    modal('The agreement', `${(a.packages || []).length ? `<div class="field"><label for="ag-pk">Add a package</label><select id="ag-pk"><option value="">Choose…</option>${a.packages.map((p, i) => `<option value="${i}">${esc(p.name)} · ${money0(p.price)} ${p.billing === 'monthly' ? '/ month' : 'once'}</option>`).join('')}</select></div>` : ''}
      <div id="aglines" class="alines">${(ag.items || []).map(line).join('')}</div><button type="button" class="btn sm" id="agadd">${ic('plus')}Add a line</button>
      <div class="grid2">${C.fieldHtml('ag-start', 'Starts', `type="date" value="${esc(ag.startDate || '')}"`)}</div>
      <div class="field"><label for="ag-terms">Terms</label><textarea id="ag-terms" rows="4">${esc(ag.terms || '')}</textarea></div><p class="note" style="margin:0">Changing a signed agreement asks the owner to sign again.</p>`, 'Save agreement', async () => {
        const items = $$('#aglines .aline').map(r => Object.fromEntries($$('[data-k]', r).map(x => [x.dataset.k, x.dataset.k === 'price' ? Number(x.value || 0) : x.value]))).filter(x => x.name);
        await api(`/api/clients/${S.id}/agreement`, { method: 'PUT', body: { items, terms: $('#ag-terms').value, startDate: v('ag-start') || null } });
        C.closeLayer(); toast('Agreement saved'); C.render();
    }, true);
    const lines = $('#aglines');
    $('#agadd').onclick = () => lines.insertAdjacentHTML('beforeend', line({}, Date.now()));
    lines.onclick = e => { const r = e.target.closest('[data-alrm]'); if (r) r.closest('.aline').remove(); };
    const pk = $('#ag-pk'); if (pk) pk.onchange = () => { const p = a.packages[+pk.value]; if (p) lines.insertAdjacentHTML('beforeend', line(p, Date.now())); pk.value = ''; };
}
function invoiceForm() {
    const ag = (S.agreement && S.agreement.agreement) || { items: [] };
    const line = (it = {}) => `<div class="aline inv"><input placeholder="What it is for" value="${esc(it.text || it.name || '')}" data-k="text"><input type="number" placeholder="Qty" value="${esc(it.qty || 1)}" data-k="qty"><input type="number" placeholder="Price" value="${esc(it.price ?? '')}" data-k="price"><button type="button" class="btn ghost sm" data-alrm aria-label="Remove">${ic('x')}</button></div>`;
    const due = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    modal('New invoice', `<div id="invlines" class="alines">${(ag.items || []).filter(i => i.billing === 'monthly').map(line).join('') || line()}</div><button type="button" class="btn sm" id="invadd">${ic('plus')}Add a line</button>
      <div class="grid2">${C.fieldHtml('inv-issue', 'Issued', `type="date" value="${new Date().toISOString().slice(0, 10)}"`)}${C.fieldHtml('inv-due', 'Due', `type="date" value="${due}"`)}</div>
      <div class="field"><label for="inv-notes">Notes</label><textarea id="inv-notes" rows="2"></textarea></div>`, 'Create invoice', async () => {
        const items = $$('#invlines .aline').map(r => Object.fromEntries($$('[data-k]', r).map(x => [x.dataset.k, x.dataset.k === 'text' ? x.value : Number(x.value || 0)]))).filter(x => x.text);
        await api(`/api/clients/${S.id}/invoices`, { method: 'POST', body: { items, issueDate: v('inv-issue'), dueDate: v('inv-due') || null, notes: $('#inv-notes').value } });
        C.closeLayer(); toast('Invoice created'); C.render();
    }, true);
    $('#invadd').onclick = () => $('#invlines').insertAdjacentHTML('beforeend', line());
    $('#invlines').onclick = e => { const r = e.target.closest('[data-alrm]'); if (r) r.closest('.aline').remove(); };
}
})();
