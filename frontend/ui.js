/**
 * EDGELEAD :: WORKSPACE COMPONENTS  (phase 33)
 * ---------------------------------------------------------------------------
 * The parts the client-first pages share: Home, My tasks, Clients and a
 * client's workspace. Load after header.js; everything goes through EL, so
 * the session, the client scoping and the error screens are header.js's.
 *
 *   UI.TYPE_LABEL / UI.TYPE_PAGE      a report type's name, and the page that opens it
 *   UI.sourceOf(type)                 'meta' | 'reports' | 'public' — where its numbers came from
 *   UI.initials, UI.day, UI.ago, UI.today, UI.isLate
 *   UI.srcChip(src)                   the label every number carries (rule 3)
 *   UI.board(host, clientId, opts)    a client's task board, drag and drop
 *   UI.openTask(task, ctx)            the task drawer: create, edit, checklist, comments
 *   UI.taskRow(task, opts)            one task in a list
 *   UI.addClient(opts)                the add-client drawer
 *   UI.askBox(host, opts)             the account assistant for one client: suggestions, a thread, streamed status
 * ---------------------------------------------------------------------------
 */
(function () {
    'use strict';
    const esc = v => EL.esc(v);
    const ic = (n, cls) => EL.icon(n, cls);

    // ---- report types -------------------------------------------------------
    // Plain names, the same everywhere a report is listed. The wiring audit
    // checks every report_type the server writes has an entry in both maps.
    const TYPE_LABEL = { ig_report: 'Instagram audit', deep_audit: 'Competitor benchmark', content_plan: 'Content plan', fb_community: 'Facebook groups read', fb_group: 'Facebook group read', fb_page: 'Facebook Page report', meta_owned: 'Owner numbers, 28 days', meta_monthly: 'Monthly report', public_monthly: 'Monthly report · public numbers' };
    const TYPE_PAGE = { ig_report: 'ig-report.html', deep_audit: 'ig-competitors.html', content_plan: 'content-plan.html', fb_community: 'fb-audit.html', fb_group: 'fb-audit.html', fb_page: 'fb-report.html', meta_owned: 'content-plan.html', meta_monthly: 'monthly.html', public_monthly: 'report.html' };
    // A job is shown by what it is for, not by its engine name.
    const JOB_LABEL = { ig_report: 'Instagram audit', deep_audit: 'Competitor benchmark', fb_community_audit: 'Reading Facebook groups', fb_page_report: 'Facebook Page report', fb_discovery: 'Finding Facebook groups', fb_verify: 'Checking Facebook groups', leadgen_campaign: 'Lead search', leadgen_enrich: 'Finding lead contact details', fb_lead_discovery: 'Facebook Page search', meta_insights: 'Owner numbers, 28 days', meta_monthly: 'Monthly report', competitor_discovery: 'Finding competitors', content_plan: 'Content plan', public_monthly: 'Monthly report from public numbers', leads_reclassify: 'Sorting leads' };
    const jobName = type => JOB_LABEL[type] || String(type || 'Work').replace(/_/g, ' ');
    const STATE_NAME = { queued: 'Waiting to start', running: 'Running', paused_no_credit: 'Paused: out of Apify credit', interrupted: 'Stopped before finishing', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };
    const jobState = s => STATE_NAME[s] || String(s || '').replace(/_/g, ' ');
    const sourceOf = type => (type === 'meta_owned' || type === 'meta_monthly') ? 'meta' : (type === 'content_plan' ? 'reports' : 'public');
    const srcChip = src => src === 'meta' ? '<span class="el-chip is-jade">Owner data · Meta</span>'
        : src === 'reports' ? '<span class="el-chip is-gold">Built from reports</span>'
        : '<span class="el-chip">Public data</span>';

    // ---- small formatters ---------------------------------------------------
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const today = () => new Date().toISOString().slice(0, 10);
    const day = iso => {
        if (!iso) return '';
        const s = String(iso);
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
        if (!m) return s;
        const thisYear = new Date().getFullYear() === Number(m[1]);
        return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}${thisYear ? '' : ' ' + m[1]}`;
    };
    const ago = iso => {
        if (!iso) return '';
        const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
        if (s < 90) return 'just now';
        if (s < 3600) return `${Math.round(s / 60)} min ago`;
        if (s < 86400) return `${Math.round(s / 3600)} h ago`;
        if (s < 86400 * 14) return `${Math.round(s / 86400)} days ago`;
        return day(iso);
    };
    const initials = name => String(name || '?').split(/[\s@._&-]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
    const isLate = t => t.status !== 'done' && !!t.dueDate && t.dueDate < today();

    // ---- tasks --------------------------------------------------------------
    const STATUS = [
        ['todo', 'To do', 'var(--text-muted)'],
        ['doing', 'In progress', 'var(--accent-solid)'],
        ['waiting', 'Waiting on client', 'var(--warn)'],
        ['done', 'Done', 'var(--jade)']
    ];
    const STATUS_NAME = Object.fromEntries(STATUS.map(([k, n]) => [k, n]));
    const LABELS = ['Content', 'Reporting', 'Ads', 'Community', 'Leads', 'Setup', 'Profile'];
    const LABEL_COLOR = { Content: 'var(--accent-solid)', Reporting: 'var(--jade)', Ads: 'var(--warn)', Community: '#f0d39a', Leads: '#60a5fa', Setup: 'var(--text-muted)', Profile: 'var(--danger)' };
    const labelChip = l => `<span class="ws-lbl" style="--c:${LABEL_COLOR[l] || 'var(--text-muted)'}">${esc(l)}</span>`;

    const whoName = (t, ctx = {}) => {
        if (!t.assignee) return 'Unassigned';
        if (t.assignee.kind === 'client') return ctx.clientName ? `${ctx.clientName} (client)` : 'The client';
        return t.assignee.name || t.assignee.email || 'Someone';
    };
    const whoInitials = t => !t.assignee ? '–' : (t.assignee.kind === 'client' ? 'CL' : initials(t.assignee.name || t.assignee.email));

    /** One card on the board. */
    function cardHtml(t, ctx = {}) {
        const late = isLate(t);
        const done = (t.checklist || []).filter(i => i.done).length;
        return `<div class="ws-card-k ${t.status === 'done' ? 'is-done' : ''}" draggable="${ctx.canEdit ? 'true' : 'false'}" data-task="${esc(t.id)}" role="button" tabindex="0" aria-label="${esc(t.title)}">
            <span class="kt">${esc(t.title)}</span>
            ${(t.labels || []).length || t.visibleToClient ? `<span class="ws-chips">${(t.labels || []).map(labelChip).join('')}${t.visibleToClient ? '<span class="ws-lbl" style="--c:var(--jade)">Client sees</span>' : ''}</span>` : ''}
            ${t.source && t.source.label ? `<span class="ksrc">${ic('link')}${esc(t.source.label)}</span>` : ''}
            <span class="kf">
                <span class="ws-due ${late ? 'is-late' : ''}">${t.dueDate ? (late ? 'Overdue · ' : 'Due ') + day(t.dueDate) : 'No date'}</span>
                <span style="display:inline-flex;gap:8px;align-items:center">
                    ${(t.checklist || []).length ? `<span class="ws-num">${done}/${t.checklist.length}</span>` : ''}
                    ${t.comments ? `<span class="ws-num" style="display:inline-flex;gap:3px;align-items:center">${ic('chat')}${t.comments}</span>` : ''}
                    <span class="el-avatar" title="${esc(whoName(t, ctx))}">${esc(whoInitials(t))}</span>
                </span>
            </span>
        </div>`;
    }

    /**
     * A client's board. Everyone who can open the client reads it; the
     * columns accept drops only for editors. Every change goes to the server
     * first and the board redraws from what it answered, so two people moving
     * cards never see a board that only exists in their own tab.
     */
    function board(host, clientId, opts = {}) {
        let data = null, filter = 'all';
        const state = { reload: load };

        async function load() {
            try {
                data = await EL.api(`/api/clients/${encodeURIComponent(clientId)}/tasks`);
            } catch (err) {
                host.innerHTML = `<div class="ws-empty">${ic('alert')}<h3>${err.code === 'migration_required' ? 'The task board is not switched on yet' : 'The board could not be loaded'}</h3><p>${esc(err.message)}</p></div>`;
                return;
            }
            if (opts.onLoad) opts.onLoad(data);
            draw();
        }

        function ctx() {
            return { clientId, clientName: data && data.client ? data.client.name : '', people: data ? data.people : [], canEdit: !!(data && data.canEdit), onSaved: load };
        }

        function draw() {
            const c = ctx();
            const me = EL.me && EL.me.id;
            const all = data.tasks || [];
            const list = all.filter(t => filter === 'all'
                || (filter === 'mine' && t.assignee && t.assignee.id === me)
                || (filter === 'client' && t.assignee && t.assignee.kind === 'client'));
            host.innerHTML = `
                <div class="ws-head" style="margin-bottom:12px">
                    <div><h2 style="margin:0;font-size:1.1rem;color:var(--text-primary)">Task board</h2>
                        <p class="ws-sub" style="margin-top:4px">Everyone on this client sees this board and every change.${c.canEdit ? ' Drag a card to move it.' : ' You can read it; an editor on the client changes it.'}</p></div>
                    ${c.canEdit ? `<div class="ws-actions"><button class="ws-btn is-gold" type="button" data-new="todo">${ic('plus')}New task</button></div>` : ''}
                </div>
                <div class="ws-filters">
                    <button type="button" data-filter="all" aria-pressed="${filter === 'all'}">All <span class="ws-num">${all.length}</span></button>
                    <button type="button" data-filter="mine" aria-pressed="${filter === 'mine'}">Mine</button>
                    <button type="button" data-filter="client" aria-pressed="${filter === 'client'}">The client’s to-dos</button>
                </div>
                <div class="ws-board">${STATUS.map(([k, name, color]) => {
                    const items = list.filter(t => t.status === k).sort((a, b) => (a.position - b.position) || String(a.createdAt).localeCompare(String(b.createdAt)));
                    return `<section class="ws-col" data-col="${k}" aria-label="${name}">
                        <div class="ws-col-h"><span class="ws-col-dot" style="background:${color}"></span>${name}<span class="n">${items.length}</span></div>
                        ${items.map(t => cardHtml(t, c)).join('')}
                        ${c.canEdit ? `<button class="ws-addcard" type="button" data-new="${k}">${ic('plus')}Add task</button>` : ''}
                    </section>`;
                }).join('')}</div>`;

            host.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => { filter = b.dataset.filter; draw(); }));
            host.querySelectorAll('[data-new]').forEach(b => b.addEventListener('click', () => openTask(null, { ...ctx(), status: b.dataset.new })));
            host.querySelectorAll('[data-task]').forEach(el => {
                const open = () => openTask((data.tasks || []).find(t => t.id === el.dataset.task), ctx());
                el.addEventListener('click', open);
                el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
                el.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', el.dataset.task); e.dataTransfer.effectAllowed = 'move'; el.classList.add('is-dragging'); });
                el.addEventListener('dragend', () => { el.classList.remove('is-dragging'); host.querySelectorAll('.ws-col.is-over').forEach(x => x.classList.remove('is-over')); });
            });
            if (!c.canEdit) return;
            host.querySelectorAll('[data-col]').forEach(col => {
                col.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; col.classList.add('is-over'); });
                col.addEventListener('dragleave', e => { if (!col.contains(e.relatedTarget)) col.classList.remove('is-over'); });
                col.addEventListener('drop', async e => {
                    e.preventDefault(); col.classList.remove('is-over');
                    const id = e.dataTransfer.getData('text/plain');
                    const t = (data.tasks || []).find(x => x.id === id);
                    if (!t || t.status === col.dataset.col) return;
                    const was = t.status;
                    t.status = col.dataset.col; draw();                  // move now, confirm with the server
                    try {
                        await EL.api(`/api/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status: col.dataset.col } });
                        EL.toast(`Moved to ${STATUS_NAME[col.dataset.col]}. Everyone on this client sees it.`);
                        load();
                    } catch (err) { t.status = was; draw(); EL.toast(err.message, 'bad'); }
                });
            });
        }

        load();
        return state;
    }

    /**
     * The task drawer. `task` null means a new one. `ctx` carries the client,
     * who can be given work (people), whether the caller may edit, and what to
     * do after a save. Comments are read when the drawer opens.
     */
    function openTask(task, ctx = {}) {
        const isNew = !task;
        const t = task || { title: '', notes: '', status: ctx.status || 'todo', dueDate: null, labels: [], checklist: [], assignee: EL.me ? { kind: 'person', id: EL.me.id } : null, visibleToClient: false };
        const canEdit = ctx.canEdit !== false;
        const people = ctx.people || [];
        const whoVal = t.assignee ? (t.assignee.kind === 'client' ? 'client' : t.assignee.id) : '';
        const options = [['', 'Nobody yet'], ...people.map(p => [p.id, p.name || p.email]), ['client', `${ctx.clientName || 'The client'} (client)`]];
        if (whoVal && !options.some(([v]) => v === whoVal)) options.push([whoVal, whoName(t, ctx)]);
        let visible = !!t.visibleToClient;
        let checklist = (t.checklist || []).map(i => ({ ...i }));
        const dis = canEdit ? '' : 'disabled';

        const d = EL.drawer({
            title: isNew ? 'New task' : esc(t.title),
            sub: `${esc(ctx.clientName || '')}${t.source && t.source.label ? ' · from ' + esc(t.source.label) : ''}`,
            body: `
                <div class="ws-form">
                    <div><label for="tk-title">Task</label><input id="tk-title" value="${esc(t.title)}" placeholder="What needs doing?" maxlength="300" ${dis}></div>
                    <div class="ws-form two">
                        <div><label for="tk-status">Status</label><select id="tk-status" ${dis}>${STATUS.map(([k, n]) => `<option value="${k}" ${t.status === k ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
                        <div><label for="tk-who">Assigned to</label><select id="tk-who" ${dis}>${options.map(([v, n]) => `<option value="${esc(v)}" ${v === whoVal ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></div>
                        <div><label for="tk-due">Due</label><input id="tk-due" type="date" value="${esc(t.dueDate || '')}" ${dis}></div>
                        <div><label for="tk-label">Label</label><select id="tk-label" ${dis}><option value="">None</option>${LABELS.map(l => `<option ${(t.labels || [])[0] === l ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
                    </div>
                    <div><label for="tk-notes">Notes</label><textarea id="tk-notes" rows="3" placeholder="Anything the person doing it needs to know" ${dis}>${esc(t.notes || '')}</textarea>
                        <div class="ws-hint" id="tk-notes-hint">${visible ? 'The client sees these notes.' : 'Only your team sees these notes.'}</div></div>
                    <div class="ws-switch"><div><div style="font-weight:700;color:var(--text-primary)">The client sees this task</div>
                        <div class="ws-hint">Shows in the owner’s portal. A task assigned to the client always does.</div></div>
                        <button class="ws-toggle" type="button" role="switch" id="tk-vis" aria-checked="${visible}" aria-label="The client sees this task" ${dis}></button></div>
                </div>
                <div><label>Checklist</label><div id="tk-check"></div>
                    ${canEdit ? `<div style="display:flex;gap:8px;margin-top:6px"><input id="tk-check-new" placeholder="Add a step" maxlength="200"><button class="ws-btn is-sm" type="button" id="tk-check-add">Add</button></div>` : ''}</div>
                ${isNew ? '' : `<div><label>Conversation</label><div id="tk-comments" style="display:flex;flex-direction:column;gap:10px"><p class="el-muted">Loading…</p></div>
                    <form id="tk-cform" style="display:flex;gap:8px;margin-top:10px"><input id="tk-ctext" placeholder="Write a comment" maxlength="2000" aria-label="Comment"><button class="ws-btn is-sm" type="submit">Comment</button></form></div>`}
                <div class="ws-note" id="tk-note"></div>`,
            foot: canEdit ? `${isNew ? '' : `<button class="ws-btn is-danger is-sm" type="button" id="tk-del" style="margin-right:auto">Delete</button>`}
                <button class="ws-btn is-quiet" type="button" data-dw-close>Cancel</button>
                <button class="ws-btn is-gold" type="button" id="tk-save">${isNew ? 'Add task' : 'Save'}</button>` : ''
        });
        const $ = id => d.el.querySelector('#' + id);
        d.el.querySelectorAll('[data-dw-close]').forEach(b => b.addEventListener('click', () => EL.closeDrawer()));

        const drawChecklist = () => {
            $('tk-check').innerHTML = checklist.length ? checklist.map((i, n) => `<button class="ws-check" type="button" role="checkbox" aria-checked="${i.done}" data-i="${n}" ${dis}><span class="box">${i.done ? ic('check') : ''}</span><span>${esc(i.text)}</span></button>`).join('')
                : '<p class="el-muted">No steps.</p>';
            $('tk-check').querySelectorAll('[data-i]').forEach(b => b.addEventListener('click', () => { const i = checklist[+b.dataset.i]; i.done = !i.done; drawChecklist(); }));
        };
        drawChecklist();
        if (canEdit) {
            const add = () => { const v = $('tk-check-new').value.trim(); if (!v) return; checklist.push({ text: v, done: false }); $('tk-check-new').value = ''; drawChecklist(); };
            $('tk-check-add').addEventListener('click', add);
            $('tk-check-new').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
            $('tk-vis').addEventListener('click', () => {
                visible = !visible;
                $('tk-vis').setAttribute('aria-checked', String(visible));
                $('tk-notes-hint').textContent = visible ? 'The client sees these notes.' : 'Only your team sees these notes.';
            });
            $('tk-who').addEventListener('change', () => {
                if ($('tk-who').value === 'client') { visible = true; $('tk-vis').setAttribute('aria-checked', 'true'); $('tk-notes-hint').textContent = 'The client sees these notes.'; }
            });
            $('tk-save').addEventListener('click', async () => {
                const body = {
                    title: $('tk-title').value, status: $('tk-status').value, assignee: $('tk-who').value || null,
                    dueDate: $('tk-due').value || null, labels: $('tk-label').value ? [$('tk-label').value] : [],
                    notes: $('tk-notes').value, checklist, visibleToClient: visible
                };
                if (!body.title.trim()) { $('tk-note').className = 'ws-note is-bad'; $('tk-note').textContent = 'Give the task a name.'; $('tk-title').focus(); return; }
                $('tk-save').disabled = true;
                try {
                    if (isNew) await EL.api(`/api/clients/${encodeURIComponent(ctx.clientId)}/tasks`, { method: 'POST', body: { ...body, ...(ctx.source ? { source: ctx.source } : {}) } });
                    else await EL.api(`/api/tasks/${encodeURIComponent(t.id)}`, { method: 'PATCH', body });
                    EL.closeDrawer();
                    EL.toast(isNew ? `Added to ${ctx.clientName || 'the client'}’s board.` : 'Saved. Everyone on this client sees the change.');
                    if (ctx.onSaved) ctx.onSaved();
                } catch (err) { $('tk-note').className = 'ws-note is-bad'; $('tk-note').textContent = err.message; $('tk-save').disabled = false; }
            });
            if (!isNew) $('tk-del').addEventListener('click', async () => {
                const b = $('tk-del');
                if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Delete — press again'; return; }
                try { await EL.api(`/api/tasks/${encodeURIComponent(t.id)}`, { method: 'DELETE' }); EL.closeDrawer(); EL.toast('Task deleted.'); if (ctx.onSaved) ctx.onSaved(); }
                catch (err) { $('tk-note').className = 'ws-note is-bad'; $('tk-note').textContent = err.message; }
            });
        }

        if (!isNew) {
            const drawComments = async () => {
                try {
                    const r = await EL.api(`/api/tasks/${encodeURIComponent(t.id)}/comments`);
                    $('tk-comments').innerHTML = (r.comments || []).length ? r.comments.map(m => `
                        <div class="ws-comment"><span class="el-avatar">${esc(initials(m.author.name || m.author.email))}</span>
                            <div class="body"><div class="meta">${esc(m.author.kind === 'client' ? (m.author.name || 'Client') + ' · client' : (m.author.name || m.author.email || 'Team'))} · ${esc(ago(m.createdAt))}</div>${esc(m.body)}</div></div>`).join('')
                        : '<p class="el-muted">No comments yet.</p>';
                } catch (err) { $('tk-comments').innerHTML = `<p class="el-muted">${esc(err.message)}</p>`; }
            };
            drawComments();
            $('tk-cform').addEventListener('submit', async e => {
                e.preventDefault();
                const v = $('tk-ctext').value.trim(); if (!v) return;
                try { await EL.api(`/api/tasks/${encodeURIComponent(t.id)}/comments`, { method: 'POST', body: { body: v } }); $('tk-ctext').value = ''; drawComments(); if (ctx.onSaved) ctx.onSaved(); }
                catch (err) { EL.toast(err.message, 'bad'); }
            });
        }
        return d;
    }

    /** One task in a list (My tasks, Home). */
    function taskRow(t, opts = {}) {
        const late = isLate(t);
        const sev = late ? 'is-bad' : t.status === 'done' ? 'is-jade' : t.status === 'doing' ? 'is-gold' : t.status === 'waiting' ? 'is-warn' : '';
        return `<div class="ws-row is-link" data-task="${esc(t.id)}" role="button" tabindex="0">
            <span class="ws-sev ${sev}"></span>
            <div class="ws-grow"><div class="ws-t">${esc(t.title)}</div>
                <div class="ws-m">${opts.showClient && t.client ? esc(t.client.name) + ' · ' : ''}${STATUS_NAME[t.status] || t.status}${t.dueDate ? ` · ${late ? 'overdue, was due' : 'due'} ${day(t.dueDate)}` : ''}${t.source && t.source.label ? ' · from ' + esc(t.source.label) : ''}</div></div>
            <span class="ws-chips">${(t.labels || []).map(labelChip).join('')}</span>
        </div>`;
    }

    // ---- add a client ---------------------------------------------------------
    /**
     * The four steps from the prototype. Only the name is required; each
     * later step is optional and says so. The client is created at the end,
     * then its competitors, teammates and owner invite are added in turn,
     * and anything that fails is reported without undoing the client.
     */
    function addClient(opts = {}) {
        const draft = { name: '', niche: '', location: '', ig: '', fb: '', competitors: '', meta: 'later', team: [], owner: '', ownerName: '' };
        let step = 1;
        const steps = ['Business', 'Social accounts', 'Meta', 'Team & owner'];
        const d = EL.drawer({ title: 'Add client', sub: 'Only the name is required. Everything else can be added later.', body: '', foot: '' });

        const read = () => {
            const v = id => { const el = d.el.querySelector('#' + id); return el ? el.value.trim() : undefined; };
            const map = { 'ac-name': 'name', 'ac-niche': 'niche', 'ac-loc': 'location', 'ac-ig': 'ig', 'ac-fb': 'fb', 'ac-comp': 'competitors', 'ac-owner': 'owner', 'ac-owner-name': 'ownerName', 'ac-team': 'teamText' };
            for (const [id, k] of Object.entries(map)) { const x = v(id); if (x !== undefined) draft[k] = x; }
        };
        const draw = (err = '') => {
            const stepper = steps.map((s, i) => `<span class="${i + 1 === step ? 'is-on' : i + 1 < step ? 'is-done' : ''}">${i + 1}. ${s}</span>`).join('');
            let body = `<div class="ws-stepper">${stepper}</div>`;
            if (step === 1) body += `<div class="ws-form">
                <div><label for="ac-name">Business name</label><input id="ac-name" value="${esc(draft.name)}" placeholder="e.g. Harbor Dental Studio" autocomplete="off" maxlength="300">${err ? `<div class="ws-note is-bad">${esc(err)}</div>` : ''}</div>
                <div class="ws-form two">
                    <div><label for="ac-niche">What they do</label><input id="ac-niche" value="${esc(draft.niche)}" placeholder="e.g. family dentist"><div class="ws-hint">Used to find comparable businesses and to plan content.</div></div>
                    <div><label for="ac-loc">Where</label><input id="ac-loc" value="${esc(draft.location)}" placeholder="City, State"></div>
                </div></div>`;
            if (step === 2) body += `<div class="ws-form">
                <div><label for="ac-ig">Instagram</label><input id="ac-ig" value="${esc(draft.ig)}" placeholder="@handle"></div>
                <div><label for="ac-fb">Facebook Page</label><input id="ac-fb" value="${esc(draft.fb)}" placeholder="facebook.com/…"></div>
                <div><label for="ac-comp">Competitors</label><input id="ac-comp" value="${esc(draft.competitors)}" placeholder="@rival1, @rival2"><div class="ws-hint">The accounts this client is compared against, up to 10. Audits and benchmarks use them.</div></div>
            </div>`;
            if (step === 3) body += `<p class="el-muted">Can you connect their Facebook Page and Instagram now? Audits and lead searches work without it; daily numbers, monthly reports and Edge Meta AI need it.</p>
                <div class="ws-form">${[['now', 'Connect now', 'You sign in with a Facebook account that manages their Page. You pick which Page goes under this client.'],
                    ['owner', 'The owner will connect', 'They do it from their own portal after you invite them in the next step.'],
                    ['later', 'Later', 'It stays on this client’s setup list.']].map(([k, t, s]) =>
                    `<button type="button" class="ws-option" data-meta="${k}" aria-pressed="${draft.meta === k}"><span class="radio"></span><span><b>${t}</b><span>${s}</span></span></button>`).join('')}</div>`;
            if (step === 4) body += `<div class="ws-form">
                <div><label for="ac-team">Teammates on this client</label><input id="ac-team" value="${esc(draft.teamText || '')}" placeholder="colleague@agency.com, another@agency.com"><div class="ws-hint">They can open this client, see its board and start work under it. You are its owner.</div></div>
                <div class="ws-form two">
                    <div><label for="ac-owner">Owner’s email, for their portal</label><input id="ac-owner" type="email" value="${esc(draft.owner)}" placeholder="Optional"></div>
                    <div><label for="ac-owner-name">Owner’s name</label><input id="ac-owner-name" value="${esc(draft.ownerName)}" placeholder="Optional"></div>
                </div>
                <div class="ws-hint">The owner gets their own login for this business only: their reports in plain words, their numbers, and the to-dos you share with them. Never your costs, keys or other clients.</div>
            </div>`;
            d.setTitle('Add client', 'Only the name is required. Everything else can be added later.');
            d.body.innerHTML = body + '<div class="ws-note" id="ac-note"></div>';
            if (d.foot) d.foot.remove();
            const f = document.createElement('footer');
            f.className = 'el-drawer-f';
            f.innerHTML = `${step > 1 ? '<button class="ws-btn is-quiet" type="button" id="ac-back">Back</button>' : '<button class="ws-btn is-quiet" type="button" id="ac-cancel">Cancel</button>'}
                <button class="ws-btn is-gold" type="button" id="ac-next">${step < 4 ? 'Continue' : ic('check') + 'Create client'}</button>`;
            d.el.querySelector('.el-drawer').appendChild(f);
            d.foot = f;
            d.body.querySelectorAll('[data-meta]').forEach(b => b.addEventListener('click', () => { read(); draft.meta = b.dataset.meta; draw(); }));
            const back = f.querySelector('#ac-back'); if (back) back.addEventListener('click', () => { read(); step--; draw(); });
            const cancel = f.querySelector('#ac-cancel'); if (cancel) cancel.addEventListener('click', () => EL.closeDrawer());
            f.querySelector('#ac-next').addEventListener('click', next);
            const first = d.body.querySelector('input'); if (first) first.focus();
            d.body.querySelectorAll('input').forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); next(); } }));
        };

        async function next() {
            read();
            if (step === 1 && !draft.name) { draw('Add the business name to continue.'); return; }
            if (step < 4) { step++; draw(); return; }
            const note = d.body.querySelector('#ac-note');
            const btn = d.foot.querySelector('#ac-next');
            btn.disabled = true; note.className = 'ws-note'; note.textContent = 'Creating…';
            let client;
            try {
                const r = await EL.api('/api/clients', { method: 'POST', body: {
                    name: draft.name, niche: draft.niche || null, location: draft.location || null,
                    ig_handle: draft.ig || null, fb_page: draft.fb || null
                } });
                client = r.client;
            } catch (err) { note.className = 'ws-note is-bad'; note.textContent = err.message; btn.disabled = false; return; }

            // The rest is added to a client that now exists. A failure is
            // reported and left for the client's own page to fix.
            const problems = [];
            const handles = String(draft.competitors || '').split(/[\s,]+/).map(s => s.replace(/^@/, '').trim()).filter(Boolean);
            if (handles.length) {
                try { await EL.api(`/api/clients/${client.id}/competitors`, { method: 'PUT', body: { handles } }); }
                catch (err) { problems.push('competitors: ' + err.message); }
            }
            for (const email of String(draft.teamText || '').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean)) {
                try { await EL.api(`/api/clients/${client.id}/members`, { method: 'POST', body: { email, role: 'editor' } }); }
                catch (err) { problems.push(`${email}: ${err.message}`); }
            }
            let invite = null;
            if (draft.owner) {
                try { invite = await EL.api(`/api/clients/${client.id}/portal-invite`, { method: 'POST', body: { email: draft.owner, name: draft.ownerName || null } }); }
                catch (err) { problems.push('owner invite: ' + err.message); }
            }
            EL._clients = null;
            EL.rememberClient(client.id);
            if (draft.meta === 'now') {
                try { const m = await EL.api(`/api/meta/oauth/start?client_id=${client.id}`); window.location.href = m.url; return; }
                catch (err) { problems.push('Meta: ' + err.message); }
            }
            EL.closeDrawer();
            if (opts.onCreated) opts.onCreated(client, { problems, invite });
            else {
                const q = new URLSearchParams({ client: client.id, added: '1' });
                if (invite && invite.link) sessionStorage.setItem('el-invite-' + client.id, JSON.stringify(invite));
                if (problems.length) sessionStorage.setItem('el-added-problems-' + client.id, JSON.stringify(problems));
                window.location.href = 'workspace.html?' + q.toString();
            }
        }

        draw();
        return d;
    }

    // ---- ask ai (phase 35) ----------------------------------------------------
    // One chat per client for the team. It reads the client's reports, Meta
    // numbers, task board, leads and work log through the server's lookups,
    // which are locked to this client; nothing here decides what it can see.
    const ASK_SUGGEST = name => [
        `What have we done for ${name} this month?`,
        'What is planned next, and what is waiting on the client?',
        'Their key numbers in two lines',
        `Prep me for a call with ${name}`,
        'Draft a three-line update I can send the owner'
    ];

    /** A model answer as safe HTML: paragraphs, "- " lists and **bold**, nothing else. */
    function answerHtml(text) {
        const inline = t => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
        return String(text || '').trim().split(/\n{2,}/).map(block => {
            const lines = block.split('\n');
            if (lines.every(l => /^\s*([-*•]|\d+[.)])\s+/.test(l))) {
                const ordered = /^\s*\d/.test(lines[0]);
                return `<${ordered ? 'ol' : 'ul'}>${lines.map(l => `<li>${inline(l.replace(/^\s*([-*•]|\d+[.)])\s+/, ''))}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`;
            }
            return `<p>${lines.map(inline).join('<br>')}</p>`;
        }).join('');
    }

    /** POST with server-sent status events; resolves with the answer payload. */
    async function askStream(body, onStatus) {
        const res = await fetch(EL.backendUrl() + '/api/assistant/ask?stream=1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + await EL.token() },
            body: JSON.stringify(body)
        });
        if (!res.ok) {
            let d = null; try { d = await res.json(); } catch { d = null; }
            if (res.status === 401) { EL.signOut(); throw new Error('Signed out.'); }
            throw new Error((d && d.error) || (res.status === 429 ? 'That was a lot of questions in a minute. Wait a moment and ask again.' : `Request failed (${res.status})`));
        }
        const reader = res.body.getReader(), dec = new TextDecoder();
        let buf = '', out = null;
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const frames = buf.split('\n\n'); buf = frames.pop();
            for (const f of frames) {
                if (!f.trim() || f.startsWith(':')) continue;
                let ev = 'message', data = '';
                for (const line of f.split('\n')) {
                    if (line.startsWith('event:')) ev = line.slice(6).trim();
                    else if (line.startsWith('data:')) data += line.slice(5).trim();
                }
                let d; try { d = JSON.parse(data); } catch { continue; }
                if (ev === 'status' && d.label) onStatus(d.label);
                else if (ev === 'done') out = d;
                else if (ev === 'error') throw new Error(d.error || 'That did not work.');
            }
        }
        if (!out) throw new Error('The answer did not arrive. Ask again.');
        return out;
    }

    /**
     * opts: { clientId, clientName, compact, initial, onAsk }
     * compact: the Overview's launcher, a box and suggestions; asking calls
     * onAsk(question) so the page can open the full thread. Otherwise the
     * thread itself, resuming the latest conversation about this client.
     */
    function askBox(host, opts = {}) {
        const name = opts.clientName || 'this client';
        const suggest = ASK_SUGGEST(name);
        if (opts.compact) {
            host.innerHTML = `<section class="ws-card ws-ask is-compact"><div class="ws-card-h"><h2>${EL.icon('spark')}Account assistant</h2>
                    <span class="el-muted">What we did, what is planned, and ${esc(name)}’s numbers, in seconds</span></div>
                <form class="ws-ask-form"><input type="text" maxlength="2000" placeholder="e.g. What have we done for them this month?" aria-label="Ask the account assistant about ${esc(name)}"><button class="ws-btn is-gold" type="submit">Ask</button></form>
                <div class="ws-ask-sugg">${suggest.slice(0, 3).map(t => `<button type="button" class="ws-chipbtn">${esc(t)}</button>`).join('')}</div></section>`;
            const input = host.querySelector('input');
            const send = t => { t = String(t || '').trim(); if (t && opts.onAsk) opts.onAsk(t); };
            host.querySelector('form').addEventListener('submit', e => { e.preventDefault(); send(input.value); });
            host.querySelectorAll('.ws-chipbtn').forEach(b => b.addEventListener('click', () => send(b.textContent)));
            return;
        }

        let conversationId = null, busy = false;
        const turns = [];
        host.innerHTML = `<section class="ws-card ws-ask">
            <div class="ws-card-h"><h2>${EL.icon('spark')}Account assistant · ${esc(name)}</h2><button class="ws-link" type="button" data-new>Start a new conversation</button></div>
            <p class="el-muted ws-ask-lead">What we did for ${esc(name)}, what is planned, and their numbers, ready to tell the client. It reads their reports, their own Meta numbers when connected, the task board, the leads found and what the team has run, and nothing from any other client.</p>
            <div class="ws-ask-thread" aria-live="polite"></div>
            <div class="ws-ask-sugg"></div>
            <form class="ws-ask-form"><textarea rows="2" maxlength="2000" placeholder="Ask about ${esc(name)}…" aria-label="Your question"></textarea><button class="ws-btn is-gold" type="submit">Ask</button></form>
        </section>`;
        const thread = host.querySelector('.ws-ask-thread');
        const sugg = host.querySelector('.ws-ask-sugg');
        const input = host.querySelector('textarea');
        const form = host.querySelector('form');

        function draw(status) {
            thread.innerHTML = turns.map(t => t.role === 'user'
                ? `<div class="ws-ask-q">${esc(t.text)}</div>`
                : `<div class="ws-ask-a">${answerHtml(t.text)}</div>`).join('')
                + (status ? `<div class="ws-ask-status"><span class="el-dot"></span>${esc(status)}…</div>` : '');
            sugg.innerHTML = turns.length ? '' : suggest.map(t => `<button type="button" class="ws-chipbtn">${esc(t)}</button>`).join('');
            sugg.querySelectorAll('.ws-chipbtn').forEach(b => b.addEventListener('click', () => ask(b.textContent)));
            thread.scrollTop = thread.scrollHeight;
        }

        async function ask(text) {
            text = String(text || '').trim();
            if (!text || busy) return;
            busy = true; form.querySelector('button').disabled = true; input.value = '';
            turns.push({ role: 'user', text });
            draw('Thinking');
            try {
                const out = await askStream({ message: text, conversationId, clientId: opts.clientId }, label => draw(label));
                conversationId = out.conversationId || conversationId;
                turns.push({ role: 'assistant', text: out.answer || '' });
            } catch (err) {
                turns.push({ role: 'assistant', text: err.message || 'That did not work. Ask again in a moment.' });
            } finally {
                busy = false; form.querySelector('button').disabled = false; draw(); input.focus();
            }
        }

        form.addEventListener('submit', e => { e.preventDefault(); ask(input.value); });
        input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input.value); } });
        host.querySelector('[data-new]').addEventListener('click', () => { conversationId = null; turns.length = 0; draw(); input.focus(); });

        // Resume the latest conversation about this client, unless the page
        // arrived with a question to ask (from the Overview box).
        draw();
        if (opts.initial) { ask(opts.initial); return; }
        EL.api(`/api/assistant/conversations?client_id=${encodeURIComponent(opts.clientId)}`).then(async r => {
            const last = (r.conversations || [])[0];
            if (!last || turns.length) return;
            const d = await EL.api('/api/assistant/conversation/' + encodeURIComponent(last.id));
            if (turns.length) return;
            conversationId = last.id;
            for (const m of (d.messages || []).slice(-12)) turns.push({ role: m.role === 'assistant' ? 'assistant' : 'user', text: m.content });
            draw();
        }).catch(() => {});
    }

    window.UI = {
        TYPE_LABEL, TYPE_PAGE, JOB_LABEL, jobName, jobState, sourceOf, srcChip, STATUS, STATUS_NAME, LABELS,
        initials, day, ago, today, isLate, labelChip,
        board, openTask, taskRow, addClient, askBox, answerHtml
    };
})();
