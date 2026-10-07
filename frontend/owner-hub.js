/**
 * Edge Meta AI — the owner's Updates (phase 49).
 *
 * Owners no longer have a dashboard: everything the agency shares with them is
 * here, beside the chat. A row of chips under the app bar, each opening a sheet:
 *
 *   To-dos          what the agency needs from them — tick it off here
 *   Working on      what the agency is doing, opened with its description,
 *                   pictures, checklist and the conversation on it
 *   Posts           planned posts — approve, ask for changes, skip
 *   Reports         every report, read in full
 *   Numbers         the daily numbers from their own Meta
 *   Shared tools    Find customers / Local demand, when the agency gave them
 *   Billing         the agreement (signed once, before anything else) and the invoices (phase 60)
 *
 * The chat answers questions about all of this too (get_agency_work); anything
 * that changes something — an approval, a tick — is a button here, never a
 * sentence the model has to interpret.
 */
(function () {
    'use strict';
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const shortDay = iso => (iso ? new Date(String(iso).slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '');
    const today = () => new Date().toISOString().slice(0, 10);
    const ago = iso => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 2 ? 'just now' : m < 60 ? `${m} min ago` : m < 2160 ? `${Math.round(m / 60)} h ago` : shortDay(iso); };
    const STATE = { todo: 'Planned', doing: 'In progress', waiting: 'Waiting on you', done: 'Done' };
    const PRIO = { highest: 'Highest', high: 'High', medium: '', low: '', lowest: '' };
    const MEDIA = /!\[[^\]]{0,80}\]\(media:([0-9a-f-]{36})\)/gi;

    /** A description: text, line breaks and the agency's pictures (signed links from the server). Nothing else becomes markup. */
    function rich(text, media = {}) {
        const out = []; let last = 0; const src = String(text || '');
        const part = t => esc(t).replace(/\n/g, '<br>').replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)"'])/g, u => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
        for (const m of src.matchAll(MEDIA)) {
            out.push(part(src.slice(last, m.index)));
            const url = media[m[1].toLowerCase()];
            if (url) out.push(`<a href="${esc(url)}" target="_blank" rel="noopener"><img class="hub-img" src="${esc(url)}" alt="Picture" loading="lazy"></a>`);
            last = m.index + m[0].length;
        }
        out.push(part(src.slice(last)));
        return out.join('');
    }

    let me = null, data = { tasks: [], media: {}, posts: [], reports: [], growth: null, billing: null }, host = null;
    // Phase 60: while the agreement waits for a signature, its sheet cannot be closed or stepped back from.
    let locked = false;

    // ---- the sheet ---------------------------------------------------------------
    // One sheet at a time, with a way back (phase 52): a task opened from the to-do list
    // goes back to the list, not out of Updates. The phone's own back button does the
    // same instead of leaving the app — one history entry stands for every open sheet.
    let current = null, stack = [], inHistory = false, opener = null;
    function sheet(title, sub = '', reopen = null, opts = {}) {
        const open = !!document.getElementById('hub-sheet');
        if (open && current) stack.push(current);
        if (!open) stack = [];
        remove();
        current = reopen;
        const wrap = document.createElement('div');
        wrap.className = 'hub-wrap'; wrap.id = 'hub-sheet';
        wrap.innerHTML = `<div class="hub-scrim" data-hub-close></div>
            <section class="hub-sheet" role="dialog" aria-modal="true" aria-labelledby="hub-t">
                <header class="hub-h"><button class="icon-btn hub-back" type="button" data-hub-back aria-label="Back">←</button>
                    <div class="hub-ht"><h2 id="hub-t">${title}</h2>${sub ? `<p>${sub}</p>` : ''}</div>
                    <button class="icon-btn" type="button" data-hub-close aria-label="Close">✕</button></header>
                <div class="hub-b"></div>
            </section>`;
        wrap.classList.toggle('has-back', !opts.locked && (stack.length > 0 || open));
        wrap.classList.toggle('is-locked', !!opts.locked);
        locked = !!opts.locked;
        document.body.appendChild(wrap);
        document.body.classList.add('hub-open');
        if (!open) opener = document.activeElement;
        // Focus goes into the sheet, and back to what opened it on close (phase 57).
        setTimeout(() => { const t = wrap.querySelector('#hub-t'); if (t) { t.tabIndex = -1; t.focus(); } }, 30);
        wrap.querySelectorAll('[data-hub-close]').forEach(b => b.addEventListener('click', () => { if (!locked) close(); }));
        wrap.querySelector('[data-hub-back]').addEventListener('click', back);
        document.removeEventListener('keydown', escClose);
        document.addEventListener('keydown', escClose);
        if (!inHistory) { try { history.pushState({ hub: 1 }, ''); inHistory = true; } catch { /* sandboxed */ } }
        setTimeout(() => wrap.classList.add('is-in'), 10);
        return { el: wrap, body: wrap.querySelector('.hub-b'), title: t => { wrap.querySelector('#hub-t').innerHTML = t; } };
    }
    // Escape steps back, except while typing something not yet sent (phase 57): that lost the draft.
    function escClose(e) { if (locked) return; if (e.key === 'Escape' && !(e.target && /TEXTAREA|INPUT/.test(e.target.tagName) && e.target.value)) back(); }
    function remove() {
        const w = document.getElementById('hub-sheet');
        if (w) w.remove();
    }
    /** One step back: the sheet this one was opened from, or out of Updates. */
    function back() {
        const prev = stack.pop();
        if (!prev) return close();
        remove(); current = null;
        const keep = stack; stack = [];
        prev();                       // opens as a first sheet, so put the rest of the trail back under it
        stack = keep;
    }
    function close() {
        remove();
        current = null; stack = [];
        document.body.classList.remove('hub-open');
        if (opener && opener.focus && document.contains(opener)) opener.focus();
        opener = null;
        document.removeEventListener('keydown', escClose);
        if (inHistory) { inHistory = false; try { if (history.state && history.state.hub) history.back(); } catch { /* sandboxed */ } }
    }
    // The phone's back button: one step back, keeping the history entry while a sheet stays open.
    window.addEventListener('popstate', () => {
        if (!inHistory) return;
        inHistory = false;
        if (!document.getElementById('hub-sheet')) return;
        if (locked) { try { history.pushState({ hub: 1 }, ''); inHistory = true; } catch { /* sandboxed */ } return; }
        if (!stack.length) { close(); return; }
        back();
        try { history.pushState({ hub: 1 }, ''); inHistory = true; } catch { /* sandboxed */ }
    });

    // ---- loading -----------------------------------------------------------------
    let loadedAt = 0, loadFailed = false;
    async function load() {
        let fails = 0;
        const soft = (p, fallback) => p.catch(err => { if (!err.handled) fails += 1; return fallback; });
        const [t, c, r, g] = await Promise.all([
            soft(EL.api('/api/client/tasks'), { tasks: [] }),
            soft(EL.api('/api/client/content'), { posts: [] }),
            soft(EL.api('/api/client/reports'), { reports: [] }),
            soft(EL.api('/api/client/growth'), null)
        ]);
        // All four failing is no connection, not "nothing waiting on you" (phase 57).
        loadFailed = fails === 4;
        const b = await EL.api('/api/client/billing').catch(() => null);
        if (!loadFailed) { data = { tasks: t.tasks || [], media: t.media || {}, posts: c.posts || [], reports: r.reports || [], growth: g, billing: b }; loadedAt = Date.now(); }
        draw();
        // The agreement comes first: until it is signed, its sheet is the app.
        if (b && b.needsSignature && !locked) openSign();
    }
    const recentDone = t => t.status === 'done' && t.completedAt && Date.now() - Date.parse(t.completedAt) < 30 * 86400000;
    const todos = () => data.tasks.filter(t => t.yours && t.status !== 'done');
    const working = () => data.tasks.filter(t => !t.yours && t.status !== 'done');
    const waitingPosts = () => data.posts.filter(p => p.status === 'idea');
    const unpaid = () => ((data.billing && data.billing.invoices) || []).filter(v => v.status === 'unpaid');

    function draw() {
        const tools = [
            (me.engines || []).includes('leadgen') ? ['leads', 'Find customers', 'client-leads.html'] : null,
            (me.engines || []).includes('fb_community') ? ['demand', 'Local demand', 'client-community.html'] : null
        ].filter(Boolean);
        const chip = (k, label, n, hot) => `<button type="button" class="hub-chip${hot ? ' is-hot' : ''}" data-hub="${k}">${label}${n ? `<b>${n}</b>` : ''}</button>`;
        host.innerHTML = `<div class="hub-row" role="toolbar" aria-label="Updates from your agency">
            ${chip('todos', 'To-dos', todos().length, todos().length > 0)}
            ${chip('posts', 'Posts to approve', waitingPosts().length, waitingPosts().length > 0)}
            ${chip('work', 'Working on', working().length, false)}
            ${chip('reports', 'Reports', data.reports.length, false)}
            ${data.growth && data.growth.connected ? chip('numbers', 'Daily numbers', 0, false) : ''}
            ${(me.engines || []).includes('report') ? chip('checkup', 'New check-up', 0, false) : ''}
            ${tools.map(([k, l]) => chip('tool-' + k, l, 0, false)).join('')}
            ${data.billing && (data.billing.agreement || (data.billing.invoices || []).length) ? chip('billing', 'Billing', unpaid().length, unpaid().length > 0 || !!data.billing.needsSignature) : ''}
            ${loadFailed ? '<button type="button" class="hub-chip is-hot" data-hub="retry">Couldn’t load your updates · Retry</button>' : ''}
        </div>`;
        host.querySelectorAll('[data-hub]').forEach(b => b.addEventListener('click', () => {
            const k = b.dataset.hub;
            if (k === 'retry') { load().catch(() => {}); return; }
            if (k === 'todos') openTodos();
            else if (k === 'work') openWork();
            else if (k === 'posts') openPosts();
            else if (k === 'reports') openReports();
            else if (k === 'numbers') openNumbers();
            else if (k === 'checkup') openCheckup();
            else if (k === 'billing') openBilling();
            else { const t = tools.find(x => 'tool-' + x[0] === k); if (t) openTool(t[1], t[2]); }
        }));
        const n = todos().length + waitingPosts().length;
        const badge = document.getElementById('hub-badge');
        if (badge) { badge.textContent = n ? String(n) : ''; badge.hidden = !n; }
    }

    // ---- to-dos and the agency's work ----------------------------------------------
    const taskLine = t => {
        const late = t.status !== 'done' && t.dueDate && t.dueDate < today();
        const bits = [t.yours ? null : STATE[t.status], t.dueDate ? (late ? `<span class="hub-late">overdue since ${esc(shortDay(t.dueDate))}</span>` : `due ${esc(shortDay(t.dueDate))}`) : null, PRIO[t.priority] ? esc(PRIO[t.priority]) + ' priority' : null, t.from ? 'from ' + esc(t.from) : null].filter(Boolean);
        return bits.join(' · ');
    };
    function openTodos() {
        const s = sheet('Your to-dos', 'What your agency needs from you', openTodos);
        const drawList = () => {
            const list = data.tasks.filter(t => t.yours && (t.status !== 'done' || recentDone(t)));
            s.body.innerHTML = list.length ? `<div class="hub-list">${list.map(t => `<div class="hub-item">
                    <button class="ws-check" type="button" role="checkbox" aria-checked="${t.status === 'done'}" data-tick="${esc(t.id)}"><span class="box">${EL.icon('check')}</span><span class="hub-it">${esc(t.title)}</span></button>
                    ${taskLine(t) ? `<div class="hub-im">${taskLine(t)}</div>` : ''}
                    <button class="hub-more" type="button" data-open="${esc(t.id)}">Details and conversation →</button></div>`).join('')}</div>`
                : '<p class="hub-empty">Nothing is waiting on you. When your agency needs something, it shows up here.</p>';
            s.body.querySelectorAll('[data-tick]').forEach(b => b.addEventListener('click', async () => {
                const t = data.tasks.find(x => x.id === b.dataset.tick);
                const to = t.status === 'done' ? 'todo' : 'done';
                b.disabled = true;
                try { await EL.api(`/api/client/tasks/${encodeURIComponent(t.id)}`, { method: 'PATCH', body: { status: to } }); t.status = to; t.completedAt = to === 'done' ? new Date().toISOString() : null; EL.toast(to === 'done' ? 'Done. Your agency sees it.' : 'Marked not done.'); drawList(); draw(); }
                catch (err) { b.disabled = false; if (!err.handled) EL.toast(err.message, 'bad'); }
            }));
            s.body.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => openTask(data.tasks.find(x => x.id === b.dataset.open))));
        };
        drawList();
    }
    function openWork() {
        const s = sheet('What we are working on', 'Your agency’s work for you, as it stands', openWork);
        const open = working(), done = data.tasks.filter(t => !t.yours && recentDone(t));
        const order = { doing: 0, waiting: 1, todo: 2 };
        open.sort((a, b) => (order[a.status] - order[b.status]) || (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
        s.body.innerHTML = (open.length ? `<div class="hub-list">${open.map(t => `<button type="button" class="hub-item is-btn" data-open="${esc(t.id)}">
                <span class="hub-dot is-${esc(t.status)}"></span><span class="hub-it">${esc(t.title)}</span><span class="hub-im">${taskLine(t)}</span></button>`).join('')}</div>`
            : '<p class="hub-empty">Nothing open right now.</p>')
            + (done.length ? `<h3 class="hub-sub">Finished in the last 30 days</h3><div class="hub-list">${done.map(t => `<button type="button" class="hub-item is-btn is-done" data-open="${esc(t.id)}"><span class="hub-dot is-done"></span><span class="hub-it">${esc(t.title)}</span><span class="hub-im">done ${esc(shortDay(t.completedAt))}</span></button>`).join('')}</div>` : '');
        s.body.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => openTask(data.tasks.find(x => x.id === b.dataset.open))));
    }
    function openTask(t) {
        if (!t) return;
        // Picture links last an hour (phase 57): one left open longer fetches fresh ones on opening a task.
        if (Date.now() - loadedAt > 45 * 60000) { load().then(() => { if (document.getElementById('hub-sheet')) openTaskNow(data.tasks.find(x => x.id === t.id) || t); }).catch(() => {}); }
        openTaskNow(t);
    }
    function openTaskNow(t) {
        const s = sheet(esc(t.title), t.yours ? 'Your to-do' : esc(STATE[t.status] || ''), () => openTask(data.tasks.find(x => x.id === t.id) || t));
        const steps = t.checklist || [];
        s.body.innerHTML = `
            <div class="hub-meta">${taskLine(t) || ''}</div>
            ${t.notes ? `<div class="hub-desc">${rich(t.notes, data.media)}</div>` : '<p class="hub-empty">No description.</p>'}
            ${steps.length ? `<h3 class="hub-sub">Steps · ${steps.filter(x => x.done).length}/${steps.length}</h3><ul class="hub-steps">${steps.map(x => `<li class="${x.done ? 'is-done' : ''}">${x.done ? '✓' : '○'} ${esc(x.text)}</li>`).join('')}</ul>` : ''}
            <h3 class="hub-sub">Conversation</h3>
            <div id="hub-comments" class="hub-comments"><p class="hub-empty">Loading…</p></div>
            <form id="hub-cform" class="hub-cform"><textarea id="hub-ctext" rows="2" maxlength="4000" placeholder="Write to your agency about this…" aria-label="Your message"></textarea><button class="btn-primary" type="submit">Send</button></form>`;
        const drawComments = async () => {
            try {
                const r = await EL.api(`/api/tasks/${encodeURIComponent(t.id)}/comments`);
                const box = s.el.querySelector('#hub-comments');
                box.innerHTML = (r.comments || []).length ? r.comments.map(m => `<div class="hub-cm ${m.mine ? 'is-mine' : ''}"><div class="hub-cmh">${esc(m.mine ? 'You' : m.author.name || 'Your agency')} · ${esc(ago(m.createdAt))}</div><div>${rich(m.body, r.media || {})}</div></div>`).join('')
                    : '<p class="hub-empty">No messages yet. Ask a question or add a detail here; your agency sees it on the task.</p>';
            } catch (err) { s.el.querySelector('#hub-comments').innerHTML = `<p class="hub-empty">${esc(err.message)}</p>`; }
        };
        drawComments();
        s.el.querySelector('#hub-cform').addEventListener('submit', async e => {
            e.preventDefault();
            const ta = s.el.querySelector('#hub-ctext'), v = ta.value.trim();
            if (!v) return;
            const send = e.target.querySelector('button[type=submit]');
            if (send.disabled) return;
            send.disabled = true;          // one tap, one message (phase 57)
            try { await EL.api(`/api/tasks/${encodeURIComponent(t.id)}/comments`, { method: 'POST', body: { body: v } }); ta.value = ''; drawComments(); }
            catch (err) { if (!err.handled) EL.toast(err.message, 'bad'); }
            finally { send.disabled = false; }
        });
    }

    // ---- planned posts -------------------------------------------------------------------
    function openPosts() {
        const s = sheet('Posts planned for you', 'Approve the ones you like; your agency makes them', openPosts);
        const drawList = () => {
            const posts = data.posts;
            s.body.innerHTML = posts.length ? `<div class="cp-list">${posts.map(p => `<article class="cp-card is-${esc(p.status)}" data-post="${esc(p.id)}">
                <div class="cp-top"><span class="cp-date">${esc(shortDay(p.plannedOn))}${p.time ? ' · ' + esc(p.time) : ''}</span>${p.format ? `<span class="cp-fmt">${esc(p.format)}</span>` : ''}<span class="cp-st">${esc(p.statusName)}</span></div>
                <h3 class="cp-hook">${esc(p.hook || 'Planned post')}</h3>
                ${p.shot ? `<p class="cp-line"><b>What it shows:</b> ${esc(p.shot)}</p>` : ''}
                ${p.caption ? `<details class="cp-cap"><summary>Read the caption</summary><p>${esc(p.caption)}</p></details>` : ''}
                ${p.yourNote ? `<p class="cp-line"><b>You said:</b> ${esc(p.yourNote)}</p>` : ''}
                ${p.postedUrl ? `<a class="cp-link" href="${EL.safeUrl(p.postedUrl)}" target="_blank" rel="noopener noreferrer">See the post</a>` : ''}
                ${['idea', 'changes', 'approved'].includes(p.status) ? `<div class="cp-acts">
                    ${p.status !== 'approved' ? '<button class="ws-btn is-gold is-sm" type="button" data-do="approve">Approve</button>' : ''}
                    <button class="ws-btn is-sm" type="button" data-do="changes">${p.status === 'changes' ? 'Change my note' : 'Ask for changes'}</button>
                    ${p.status !== 'approved' ? '<button class="ws-btn is-quiet is-sm" type="button" data-do="skip">Skip this one</button>' : ''}</div>
                    <form class="cp-change" hidden><textarea rows="2" maxlength="2000" aria-label="What would you like changed?" placeholder="What would you like changed?">${esc(p.yourNote || '')}</textarea><button class="ws-btn is-sm" type="submit">Send</button></form>` : ''}
            </article>`).join('')}</div>` : '<p class="hub-empty">No posts planned yet. When your agency plans the next weeks, they show up here for your OK.</p>';
            const decide = async (id, decision, note) => {
                try {
                    const r = await EL.api(`/api/client/content/${encodeURIComponent(id)}/decision`, { method: 'POST', body: { decision, note } });
                    const i = data.posts.findIndex(p => p.id === id); if (i >= 0 && r.post) data.posts[i] = r.post;
                    EL.toast(decision === 'approve' ? 'Approved. Your agency will make it.' : decision === 'skip' ? 'Skipped.' : 'Sent to your agency.');
                    drawList(); draw();
                } catch (err) { if (!err.handled) EL.toast(err.message, 'bad'); drawList(); }
            };
            s.body.querySelectorAll('[data-post]').forEach(c => {
                c.querySelectorAll('[data-do]').forEach(b => b.addEventListener('click', () => {
                    if (b.dataset.do === 'changes') { const f = c.querySelector('.cp-change'); f.hidden = !f.hidden; if (!f.hidden) f.querySelector('textarea').focus(); return; }
                    // Skipping takes the post off the list for good, so it is asked twice (phase 57).
                    if (b.dataset.do === 'skip' && b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Skip it — tap again'; return; }
                    b.disabled = true; decide(c.dataset.post, b.dataset.do);
                }));
                const f = c.querySelector('.cp-change');
                if (f) f.addEventListener('submit', e => { e.preventDefault(); const v = f.querySelector('textarea').value.trim(); if (!v) return; decide(c.dataset.post, 'changes', v); });
            });
        };
        drawList();
    }

    // ---- reports --------------------------------------------------------------------------
    const BAND = { strong: 'Strong', healthy: 'Healthy', mixed: 'Mixed', weak: 'Weak', poor: 'Needs work' };
    function openReports() {
        const s = sheet('Your reports', '', openReports);
        s.body.innerHTML = data.reports.length ? `<div class="hub-list">${data.reports.map(r => `<button type="button" class="hub-item is-btn" data-rep="${esc(r.id)}">
                <span class="hub-it">${esc(r.title)}${r.handle ? ' · @' + esc(String(r.handle).replace(/^@/, '')) : ''}</span>
                <span class="hub-im">${esc(shortDay(r.date))}${r.band ? ' · ' + esc(BAND[r.band] || r.band) : ''}</span></button>`).join('')}</div>`
            : '<p class="hub-empty">No reports yet. Your agency’s reports for you appear here.</p>';
        s.body.querySelectorAll('[data-rep]').forEach(b => b.addEventListener('click', () => openReport(b.dataset.rep)));
    }
    async function openReport(id) {
        const s = sheet('Report', '', () => openReport(id));
        s.body.innerHTML = '<p class="hub-empty">Opening…</p>';
        try {
            const { report } = await EL.api('/api/client/report/' + encodeURIComponent(id));
            if (!report) { s.body.innerHTML = '<p class="hub-empty">That report is empty.</p>'; return; }
            s.title(esc(report.title || 'Report'));
            s.body.classList.add('is-report');
            s.body.innerHTML = window.ELReport ? ELReport.owner(report, {}) : '<p class="hub-empty">The report viewer did not load.</p>';
            if (window.ELReport) ELReport.hydrate(s.body);
        } catch (err) { if (!err.handled) s.body.innerHTML = `<p class="hub-empty">${esc(err.message)}</p>`; }
    }

    // ---- daily numbers ---------------------------------------------------------------------
    function openNumbers() {
        const g = data.growth || {}, gr = g.growth || {}, c = g.connection || {};
        const s = sheet('Your numbers, every day', esc(c.ig_username ? '@' + c.ig_username : (c.page_name || '')), openNumbers);
        const n = v => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-US'));
        if (gr.empty || !(gr.series || []).length) { s.body.innerHTML = '<p class="hub-empty">Your first numbers are being read and appear here soon. Updates by itself.</p>'; return; }
        const f = gr.followers || {};
        const tile = (k, v, sub) => `<div class="hub-tile"><span>${k}</span><b>${v}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
        const w = x => (x && x.now !== null && x.now !== undefined ? n(x.now) : '—');
        s.body.innerHTML = `<div class="hub-tiles">${tile('Followers', n(f.now), f.week !== null && f.week !== undefined ? `${f.week > 0 ? '+' : ''}${n(f.week)} this week` : '')}${tile('Reach, 7 days', w(gr.reach))}${tile('Profile visits, 7 days', w(gr.profile_views))}${tile('Interactions, 7 days', w(gr.interactions))}</div>
            <table class="hub-table"><thead><tr><th>Day</th><th>Followers</th><th>Reach</th><th>Visits</th></tr></thead>
            <tbody>${(gr.series || []).slice(-14).reverse().map(r => `<tr><td>${esc(shortDay(r.day))}</td><td>${n(r.followers)}</td><td>${n(r.reach)}</td><td>${n(r.profile_views)}</td></tr>`).join('')}</tbody></table>
            <p class="hub-empty">Ask Edge Meta AI about any of it: “why did reach drop on Tuesday?”</p>`;
    }

    // ---- a new Instagram check-up (phase 50) --------------------------------------------
    // The same run the owner Home page had: their account, and up to two businesses like
    // theirs to compare with. It runs on the agency's account allowance; the report opens here.
    const LAST_HANDLE = 'el-checkup-handle';
    // The run's own step names are the team's ("Building benchmark"); the owner reads these (phase 57).
    const plainStep = pct => pct < 30 ? 'Reading your posts…' : pct < 60 ? 'Looking at businesses like yours…' : pct < 90 ? 'Writing what we found…' : 'Almost done…';
    function openCheckup() {
        const s = sheet('New check-up', 'How your Instagram is doing, and how you compare', openCheckup);
        let last = '';
        try { last = localStorage.getItem(LAST_HANDLE) || ''; } catch { /* private mode */ }
        s.body.innerHTML = `<div class="hub-form">
            <p class="hub-empty">A check-up reads your recent posts and scores them, and compares you with similar businesses. It takes a couple of minutes; you can keep chatting meanwhile.</p>
            <label for="ck-h">Your Instagram handle</label><input id="ck-h" placeholder="harborcafe" autocomplete="off" spellcheck="false" value="${esc(last)}">
            <label for="ck-r1">Two businesses like yours <span class="hub-opt">optional</span></label>
            <div class="hub-two"><input id="ck-r1" placeholder="a competitor" autocomplete="off" spellcheck="false"><input id="ck-r2" placeholder="another one" aria-label="Second business to compare with" autocomplete="off" spellcheck="false"></div>
            <p class="hub-tip">Pick businesses about your size, ideally near you. Leave them blank and you still get your own report, without the comparison.</p>
            <button class="btn-primary" type="button" id="ck-go">Run my check-up</button>
            <p class="hub-err" id="ck-err" role="alert"></p>
            <div class="hub-prog" id="ck-prog" hidden><div class="hub-track"><i></i></div><div class="hub-step">Starting…</div></div>
        </div>`;
        const $ = id => s.el.querySelector('#' + id);
        const clean = v => String(v || '').replace('@', '').replace(/\/+$/, '').trim().toLowerCase();
        const go = async () => {
            const target = clean($('ck-h').value), r1 = clean($('ck-r1').value), r2 = clean($('ck-r2').value);
            const err = $('ck-err'); err.textContent = ''; err.className = 'hub-err';
            if (!target) { err.textContent = 'Enter your Instagram handle to get started.'; $('ck-h').focus(); return; }
            try { localStorage.setItem(LAST_HANDLE, target); } catch { /* private mode */ }
            const btn = $('ck-go'), prog = $('ck-prog');
            const step = (pct, msg) => { prog.querySelector('i').style.width = (pct || 0) + '%'; prog.querySelector('.hub-step').textContent = msg || ''; };
            const stop = () => { btn.disabled = false; btn.textContent = 'Run my check-up'; prog.hidden = true; };
            btn.disabled = true; btn.textContent = 'Running…'; prog.hidden = false; step(2, 'Starting…');
            try {
                await EL.runJob('/api/generate-ig-report', { target, compareRivals: !!(r1 || r2), rival1: r1 || null, rival2: r2 || null }, {
                    onProgress: j => step(j.progress, plainStep(j.progress)),
                    onFailed: j => { stop(); err.textContent = 'That check-up did not finish. Check the handle is right and public, then try again.'; if (!s.el.isConnected) EL.toast('Your check-up did not finish. Try again from Updates.', 'bad'); },
                    // Stopped with its work saved (credit ran out, a restart): the agency resumes it, not the owner.
                    onPaused: () => { stop(); err.className = 'hub-err is-quota'; err.textContent = 'Your check-up paused partway. Your agency can finish it from their side; nothing is lost.'; if (!s.el.isConnected) EL.toast('Your check-up paused partway. Your agency can finish it.', 'bad'); },
                    onDone: async j => {
                        step(100, 'Done — opening your report');
                        const id = j.result && (j.result.reportId || j.result.reportRef);
                        await load().catch(() => {});
                        // Still on this sheet: open the report. Gone elsewhere meanwhile: say so, without pulling them away.
                        if (!s.el.isConnected) { EL.toast('Your check-up is ready. Open it from Reports.'); return; }
                        if (id) openReport(id); else openReports();
                    }
                });
            } catch (e) {
                stop();
                if (e.handled) return;
                err.textContent = e.message;
                if (e.quota) err.className = 'hub-err is-quota';      // an allowance reached is amber, not red
            }
        };
        $('ck-go').addEventListener('click', go);
        ['ck-h', 'ck-r1', 'ck-r2'].forEach(id => $(id).addEventListener('keydown', e => { if (e.key === 'Enter') go(); }));
        setTimeout(() => $('ck-h').focus(), 60);
    }

    // ---- a shared tool, inside the app ----------------------------------------------------
    function openTool(label, page) {
        const s = sheet(esc(label), '', () => openTool(label, page));
        s.body.classList.add('is-frame');
        s.body.innerHTML = `<iframe class="hub-frame" src="${page}${page.includes('?') ? '&' : '?'}embed=1" title="${esc(label)}"></iframe>`;
    }

    // ---- billing (phase 60) ------------------------------------------------------------
    const taka = n => '৳' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
    /** The agreement, as the owner reads it: each service, its price, what is delivered, the terms. */
    function agreementHtml(a) {
        return `<div class="hub-agr">
            ${a.items.map(i => `<div class="hub-agr-i">
                <div class="hub-agr-h"><b>${esc(i.name)}</b><span>${esc(taka(i.price))} ${i.billing === 'monthly' ? 'a month' : 'once'}</span></div>
                ${i.description ? `<p>${esc(i.description)}</p>` : ''}
                ${(i.deliverables || []).length ? `<ul>${i.deliverables.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
            </div>`).join('')}
            <div class="hub-agr-t">${a.totals.monthly ? `<span>Monthly total <b>${esc(taka(a.totals.monthly))}</b></span>` : ''}${a.totals.oneOff ? `<span>One-off total <b>${esc(taka(a.totals.oneOff))}</b></span>` : ''}</div>
            ${a.startDate ? `<p class="hub-agr-m">Starts ${esc(shortDay(a.startDate))}</p>` : ''}
            ${a.terms ? `<h3 class="hub-agr-s">Terms</h3><p class="hub-agr-terms">${esc(a.terms)}</p>` : ''}
        </div>`;
    }
    function openSign() {
        const b = data.billing; if (!b || !b.agreement) return;
        const a = b.agreement;
        const who = (b.profile && b.profile.name) || 'your agency';
        const s = sheet('Your agreement', `With ${esc(who)}. Read it, then sign to continue.`, openSign, { locked: true });
        s.body.innerHTML = `${a.signed ? '<p class="hub-note">Your agency changed the agreement since you last signed it. Please read the new one.</p>' : ''}
            ${agreementHtml(a)}
            <div class="hub-form hub-sign">
                <label for="sg-name">Type your full name to sign</label>
                <input id="sg-name" autocomplete="name" maxlength="120" value="${esc((me && me.full_name) || '')}">
                <label class="hub-check"><input type="checkbox" id="sg-ok"> I have read this agreement and I agree to it, including the fees and the terms.</label>
                <button class="btn-primary" type="button" id="sg-go" disabled>Sign and continue</button>
                <p class="hub-err" id="sg-msg" role="alert"></p>
            </div>`;
        const $ = id => s.body.querySelector('#' + id);
        const ready = () => { $('sg-go').disabled = !($('sg-ok').checked && $('sg-name').value.trim().length >= 2); };
        $('sg-ok').addEventListener('change', ready); $('sg-name').addEventListener('input', ready); ready();
        $('sg-go').addEventListener('click', async () => {
            $('sg-go').disabled = true; $('sg-msg').textContent = '';
            try {
                await EL.api('/api/client/agreement/sign', { method: 'POST', body: { name: $('sg-name').value.trim(), agree: true, version: a.version } });
                locked = false; close();
                if (EL.toast) EL.toast('Signed. A copy is under Billing whenever you need it.');
                load().catch(() => {});
            } catch (err) {
                if (err.code === 'agreement_changed') { locked = false; load().catch(() => {}); return; }
                $('sg-msg').textContent = err.message; ready();
            }
        });
    }
    function openBilling() {
        const b = data.billing || {};
        if (b.needsSignature) return openSign();
        const s = sheet('Billing', esc((b.profile && b.profile.name) || ''), openBilling);
        const inv = b.invoices || [];
        const state = v => v.status === 'paid' ? 'Paid' : v.overdue ? '<span class="hub-late">Overdue</span>' : 'Unpaid';
        s.body.innerHTML = `
            <h3 class="hub-agr-s">Invoices</h3>
            ${inv.length ? `<div class="hub-list">${inv.map(v => `<button type="button" class="hub-item is-btn" data-inv="${esc(v.id)}">
                <span class="hub-it">${esc(v.number)} · ${esc(taka(v.total))}</span>
                <span class="hub-im">${esc(shortDay(v.issueDate))} · ${state(v)}${v.status === 'unpaid' && v.dueDate ? ' · due ' + esc(shortDay(v.dueDate)) : ''}</span></button>`).join('')}</div>`
            : '<p class="hub-empty">No invoices yet.</p>'}
            ${b.agreement ? `<h3 class="hub-agr-s">Your agreement</h3>
                ${b.agreement.signed ? `<p class="hub-agr-m">Signed by ${esc(b.agreement.signed.name)} on ${esc(shortDay(b.agreement.signed.at))}</p>` : ''}
                ${agreementHtml(b.agreement)}` : ''}`;
        s.body.querySelectorAll('[data-inv]').forEach(x => x.addEventListener('click', () => {
            const v = inv.find(i => i.id === x.dataset.inv);
            openTool(v ? v.number : 'Invoice', `invoice.html?id=${encodeURIComponent(x.dataset.inv)}`);
        }));
    }

    /** Mount under the app bar. `onAsk` lets a sheet hand a question to the chat. */
    function mount(user, hostEl) {
        me = user; host = hostEl;
        host.innerHTML = '';
        load().catch(() => {});
        document.addEventListener('visibilitychange', () => { if (!document.hidden) load().catch(() => {}); });
    }
    window.OwnerHub = { mount, reload: () => load(), open: k => ({ todos: openTodos, work: openWork, posts: openPosts, reports: openReports, numbers: openNumbers, checkup: openCheckup, billing: openBilling }[k] || (() => {}))() };
})();
