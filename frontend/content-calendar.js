/**
 * content-calendar.js — a content plan's posts on dates. (phase 42)
 *
 *   CPCal.mount(host, planId, { onCount })
 *   CPCal.mount(host, null, { listUrl, emptyText, onCount })   a client's month, whatever plan the posts came from (phase 43)
 *
 * Staff put a plan's briefs on the calendar, move them, mark them made or
 * posted (with the link), and see the owner's answer on each. The owner
 * decides from their portal; an approved post becomes a task on the board.
 * Styles are cp-* in app.css.
 */
(function () {
    'use strict';
    const esc = v => (window.EL && EL.escape ? EL.escape(v) : String(v ?? ''));
    const day = iso => new Date(String(iso).slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
    const mondayOf = iso => { const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
    const TONE = { idea: 'is-warn', changes: 'is-bad', approved: 'is-gold', made: 'is-gold', posted: 'is-jade', skipped: '' };

    async function mount(host, planId, opts = {}) {
        if (!host) return;
        host.innerHTML = '<p class="el-muted">Loading the calendar…</p>';
        let d;
        try { d = await EL.api(opts.listUrl || `/api/content-plan/${encodeURIComponent(planId)}/calendar`); }
        catch (err) { host.innerHTML = `<p class="el-muted">${esc(err.message)}</p>`; if (opts.onCount) opts.onCount(0); return; }
        const posts = d.posts || [], statuses = d.statuses || [];
        if (opts.onCount) opts.onCount(posts.length);
        const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

        if (!posts.length && opts.listUrl) { host.innerHTML = `<p class="el-muted">${esc(opts.emptyText || 'Nothing on the calendar yet.')}</p>`; return; }
        if (!posts.length) {
            host.innerHTML = `<div class="cp-empty">
                <p>Put this plan’s briefs on dates. Each one keeps its own best day where it names one; the rest are spread over four weeks.
                ${d.hasClient ? 'The owner then approves, asks for changes or skips each post from their portal, and an approved post goes onto the task board.' : 'File the plan under a client for the owner to approve the posts.'}</p>
                <div class="ld-actions"><label for="cp-start" class="cp-inl">Start on</label><input id="cp-start" type="date" value="${tomorrow}">
                <button class="ws-btn is-gold is-sm" type="button" id="cp-go">Put on the calendar</button><span class="ws-note" id="cp-go-note"></span></div></div>`;
            host.querySelector('#cp-go').addEventListener('click', async () => {
                const b = host.querySelector('#cp-go'); b.disabled = true;
                try {
                    const r = await EL.api(`/api/content-plan/${encodeURIComponent(planId)}/calendar`, { method: 'POST', body: { start: host.querySelector('#cp-start').value } });
                    EL.toast(`${r.added} post${r.added === 1 ? '' : 's'} on the calendar.`);
                    mount(host, planId, opts);
                } catch (err) { const n = host.querySelector('#cp-go-note'); n.className = 'ws-note is-bad'; n.textContent = err.message; b.disabled = false; }
            });
            return;
        }

        const weeks = {};
        for (const p of posts) (weeks[mondayOf(p.plannedOn)] = weeks[mondayOf(p.plannedOn)] || []).push(p);
        const count = s => posts.filter(p => p.status === s).length;
        host.innerHTML = `
            <div class="cp-sum">
                <span><b>${posts.length}</b> planned</span><span><b>${count('idea')}</b> waiting for the owner</span>
                <span><b>${count('changes')}</b> changes asked</span><span><b>${count('approved') + count('made')}</b> to make</span><span><b>${count('posted')}</b> posted</span>
            </div>
            ${Object.keys(weeks).sort().map(w => `<section class="cp-week"><h4>Week of ${esc(day(w))}</h4>
                <div class="cp-list">${weeks[w].map(p => `<button class="cp-card is-${esc(p.status)} is-staff" type="button" data-post="${esc(p.id)}">
                    <div class="cp-top"><span class="cp-date">${esc(day(p.plannedOn))}${p.time ? ' · ' + esc(p.time) : ''}</span>${p.format ? `<span class="cp-fmt">${esc(p.format)}</span>` : ''}
                        <span class="el-chip ${TONE[p.status] || ''}">${esc(p.statusName)}</span></div>
                    <span class="cp-hook">${esc(p.hook || 'Planned post')}</span>
                    ${p.brief && p.brief.topic ? `<span class="cp-line">${esc(p.brief.topic)}</span>` : ''}
                    ${p.ownerNote ? `<span class="cp-line"><b>Owner:</b> ${esc(p.ownerNote)}</span>` : ''}
                </button>`).join('')}</div></section>`).join('')}`;
        host.querySelectorAll('[data-post]').forEach(b => b.addEventListener('click', () => open(posts.find(p => p.id === b.dataset.post), statuses, () => mount(host, planId, opts))));
    }

    function open(p, statuses, onSaved) {
        const br = p.brief || {};
        const dw = EL.drawer({
            title: esc(p.hook || 'Planned post'), sub: `${esc(p.format || 'Post')} · ${esc(day(p.plannedOn))}${p.decidedBy === 'owner' && p.decidedAt ? ' · the owner answered' : ''}`, wide: true,
            body: `
                ${p.ownerNote ? `<div class="ws-note is-bad">The owner asked: ${esc(p.ownerNote)}</div>` : ''}
                <section class="ld-sec"><h3 class="ld-h">Status</h3>
                    <div class="ld-stages">${statuses.map(([k, n]) => `<button type="button" class="ld-st${k === p.status ? ' is-on' : ''}" data-st="${k}">${esc(n)}</button>`).join('')}</div>
                    <p class="ws-hint">“Waiting for approval” shows in the owner’s portal. Approving (or marking made or posted) puts it on the client’s task board.</p>
                </section>
                <div class="ws-form two">
                    <div><label for="cpd-date">Date</label><input id="cpd-date" type="date" value="${esc(p.plannedOn)}"></div>
                    <div><label for="cpd-time">Time</label><input id="cpd-time" type="time" value="${esc(p.time || '')}"></div>
                    <div><label for="cpd-url">Link once posted</label><input id="cpd-url" placeholder="https://www.instagram.com/p/…" value="${esc(p.postedUrl || '')}"></div>
                    <div><label for="cpd-hook">Hook</label><input id="cpd-hook" maxlength="300" value="${esc(p.hook || '')}"></div>
                </div>
                <div><label for="cpd-cap">Caption</label><textarea id="cpd-cap" rows="5" maxlength="4000">${esc(p.caption || '')}</textarea></div>
                <section class="ld-sec"><h3 class="ld-h">The brief</h3>
                    ${br.concept ? `<p class="ld-line">${esc(br.concept)}</p>` : ''}
                    ${br.shot ? `<p class="ld-line"><b>Shot:</b> ${esc(br.shot)}</p>` : ''}
                    ${(br.script || []).length ? `<ol class="cp-script">${br.script.map(x => `<li>${esc(x)}</li>`).join('')}</ol>` : ''}
                    ${br.why ? `<p class="ld-line"><b>Why:</b> ${esc(br.why)}</p>` : ''}
                    ${(br.tools || []).length ? `<p class="ld-line"><b>Tools:</b> ${esc(br.tools.join(', '))}</p>` : ''}
                    ${(br.evidence || []).length ? `<p class="ld-line"><b>${p.pickId ? 'The idea' : 'Proof'}:</b> ${br.evidence.map((u, i) => `<a href="${EL.safeUrl(u)}" target="_blank" rel="noopener noreferrer">${p.pickId ? 'the post it came from' : 'post ' + (i + 1)}</a>`).join(' · ')}</p>` : ''}
                </section>
                <div class="ws-note" id="cpd-note"></div>`,
            foot: `<button class="ws-btn is-quiet" type="button" data-dw-close>Close</button><button class="ws-btn is-gold" type="button" id="cpd-save">Save</button>`
        });
        let status = p.status;
        dw.el.querySelectorAll('[data-st]').forEach(b => b.addEventListener('click', () => {
            status = b.dataset.st;
            dw.el.querySelectorAll('[data-st]').forEach(x => x.classList.toggle('is-on', x === b));
        }));
        dw.el.querySelector('#cpd-save').addEventListener('click', async () => {
            const q = s => dw.el.querySelector(s);
            const body = { plannedOn: q('#cpd-date').value, time: q('#cpd-time').value || null, hook: q('#cpd-hook').value, caption: q('#cpd-cap').value };
            if (status !== p.status) body.status = status;
            if (q('#cpd-url').value.trim() || status === 'posted') body.postedUrl = q('#cpd-url').value.trim();
            try {
                await EL.api(`/api/content-posts/${encodeURIComponent(p.id)}`, { method: 'PATCH', body });
                EL.closeDrawer();
                EL.toast(status === 'approved' && p.status !== 'approved' ? 'Approved, and on the task board.' : 'Saved.');
                if (onSaved) onSaved();
            } catch (err) { const n = q('#cpd-note'); n.className = 'ws-note is-bad'; n.textContent = err.message; }
        });
    }

    window.CPCal = { mount };
})();
