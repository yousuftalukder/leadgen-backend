/**
 * leads-ui.js — the two drawers the lead list and the pipeline share. (phase 40)
 *
 *   LeadUI.openLead(leadId, { onChange })   who this is and why we think so,
 *                                            "is this right?", add to a pipeline
 *   LeadUI.openPipe(pipelineId, { onChange }) stage, owner, follow-up, notes,
 *                                            a first message, turn into a client
 *   LeadUI.kindChip(kind) / LeadUI.fitChip(score) / LeadUI.KIND_NAME
 *
 * Styles are ld-* in app.css. Nothing here sends a message to anyone: the
 * draft is copied and sent by a person.
 */
(function () {
    'use strict';

    const esc = v => (window.EL && EL.escape ? EL.escape(v) : String(v ?? ''));
    const ic = n => (window.EL && EL.icon ? EL.icon(n) : '');
    const KIND_NAME = { influencer: 'Influencer', business: 'Business', personal: 'Ordinary account', unsure: 'Unsure' };
    const num = v => (v === null || v === undefined || v === '' ? '—' : Number(v).toLocaleString('en-US'));
    const day = iso => { const d = new Date(String(iso || '').length === 10 ? iso + 'T00:00:00' : iso); return isNaN(d) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); };
    const ago = iso => {
        const s = (Date.now() - new Date(iso).getTime()) / 1000;
        if (!isFinite(s)) return '';
        if (s < 90) return 'just now';
        if (s < 3600) return Math.round(s / 60) + ' min ago';
        if (s < 86400) return Math.round(s / 3600) + ' h ago';
        return day(iso);
    };

    function kindChip(kind) {
        const k = KIND_NAME[kind] ? kind : 'unsure';
        return `<span class="ld-kind is-${k}">${KIND_NAME[k]}</span>`;
    }
    function fitChip(score) {
        if (score === null || score === undefined) return '';
        const t = score >= 70 ? 'is-good' : score >= 40 ? 'is-mid' : 'is-low';
        return `<span class="ld-fit ${t}" title="Fit score out of 100">${score}</span>`;
    }
    const reasonList = list => (list || []).length
        ? `<ul class="ld-reasons">${list.map(r => `<li class="${r.w > 0 ? 'is-plus' : r.w < 0 ? 'is-minus' : ''}"><span class="mk">${r.w > 0 ? '+' : r.w < 0 ? '−' : '·'}</span>${esc(r.text)}</li>`).join('')}</ul>`
        : '<p class="el-muted">Nothing yet.</p>';

    let _team = null;
    async function team() {
        if (_team) return _team;
        try { _team = (await EL.api('/api/leads/team')).people || []; } catch { _team = []; }
        return _team;
    }
    async function clientOptions() {
        let list = [];
        try { list = (await EL.clients()).filter(c => !c.archived && c.access !== 'viewer'); } catch { /* none */ }
        return list;
    }

    // ---- the lead ------------------------------------------------------------
    async function openLead(id, opts = {}) {
        const d = EL.drawer({ title: 'Loading…', sub: '&nbsp;', body: '<p class="el-muted">Loading…</p>', wide: true });
        let data;
        try { data = await EL.api(`/api/leads/${encodeURIComponent(id)}/detail`); }
        catch (err) { d.body.innerHTML = `<p class="el-muted">${esc(err.message)}</p>`; return d; }
        const [people, clients] = await Promise.all([team(), clientOptions()]);
        const draw = () => {
            const l = data.lead;
            const ev = l.evidence || {};
            const contact = [l.email && `<span>${esc(l.email)}</span>`, l.phone && `<span>${esc(l.phone)}</span>`,
                l.whatsapp && l.whatsapp !== l.phone && `<span>WhatsApp ${esc(l.whatsapp)}</span>`,
                l.website && `<a href="${EL.safeUrl(l.website)}" target="_blank" rel="noopener noreferrer">${esc(l.website)}</a>`].filter(Boolean).join('');
            const url = l.profileUrl || (l.platform === 'facebook' ? `https://facebook.com/${l.username}` : `https://instagram.com/${l.username}`);
            d.setTitle(`${esc(l.fullName || '@' + l.username)}`,
                `<a href="${EL.safeUrl(url)}" target="_blank" rel="noopener noreferrer">${l.platform === 'facebook' ? '' : '@'}${esc(l.username)}</a>`
                + `${l.followers != null ? ' · ' + num(l.followers) + ' followers' : ''}${l.category ? ' · ' + esc(l.category) : ''}`);
            d.body.innerHTML = `
                <section class="ld-sec">
                    <div class="ld-head">${kindChip(l.kind)} ${fitChip(l.fit)}
                        <span class="ld-stage">${l.labeled ? 'Marked by your team' : (l.kindStage === 'profile' ? 'From its posts and profile' : 'From its posts only: fill in its details to be sure')}</span></div>
                    <div class="ld-ask"><span>Is this right?</span>
                        ${['influencer', 'business', 'personal'].map(k => `<button class="ld-pick${l.kind === k && l.labeled ? ' is-on' : ''}" type="button" data-kind="${k}">${KIND_NAME[k]}</button>`).join('')}
                        ${l.labeled ? '<button class="ld-pick is-quiet" type="button" data-kind="">Undo</button>' : ''}</div>
                    <p class="ws-hint">Your answer is kept and wins over the automatic sorting. It is also how we measure how accurate the sorting is.</p>
                </section>
                <section class="ld-sec"><h3 class="ld-h">Why we think so</h3>${reasonList(l.kindReasons)}</section>
                ${l.kind === 'influencer' || l.kind === 'business' ? `<section class="ld-sec"><h3 class="ld-h">Fit ${l.fit != null ? l.fit + ' / 100' : ''}</h3>${reasonList(l.fitReasons)}</section>` : ''}
                <section class="ld-sec"><h3 class="ld-h">What we saw</h3>
                    <div class="ld-facts">
                        <div><b>${(l.methods || []).length || '—'}</b><small>method${(l.methods || []).length === 1 ? '' : 's'} found it${(l.methods || []).length ? ': ' + esc(l.methods.map(m => m.name).join(', ')) : ''}</small></div>
                        <div><b>${num(ev.postsSeen)}</b><small>posts read</small></div>
                        <div><b>${num(ev.places)}</b><small>places posted from</small></div>
                        <div><b>${l.engagement != null ? l.engagement + '%' : '—'}</b><small>engagement${l.tier ? ' · ' + esc(l.tier) : ''}</small></div>
                    </div>
                    ${(ev.businessesTagged || []).length ? `<p class="ld-line"><b>Businesses they tagged:</b> ${ev.businessesTagged.map(h => `<a href="https://instagram.com/${encodeURIComponent(h)}" target="_blank" rel="noopener noreferrer">@${esc(h)}</a>`).join(', ')}</p>` : ''}
                    ${ev.paidPartnerships ? `<p class="ld-line"><b>${ev.paidPartnerships}</b> paid partnership post${ev.paidPartnerships === 1 ? '' : 's'}</p>` : ''}
                    ${(ev.captions || []).map(c => `<blockquote class="ld-quote">${esc(c)}</blockquote>`).join('')}
                    ${l.bio ? `<p class="ld-line"><b>Bio:</b> ${esc(l.bio)}</p>` : ''}
                </section>
                <section class="ld-sec"><h3 class="ld-h">Contact</h3><div class="ld-contact">${contact || '<span class="el-muted">No contact found yet.</span>'}</div></section>
                <section class="ld-sec"><h3 class="ld-h">Pipeline</h3>
                    ${(data.pipeline || []).length ? `<div class="ld-pipes">${data.pipeline.map(p => `<button class="ld-pipe" type="button" data-pipe="${esc(p.id)}">
                        <b>${esc(p.client || 'Our own prospect')}</b><span>${esc(p.stageName)}${p.assignee ? ' · ' + esc(p.assignee) : ''}${p.followUpOn ? ' · follow up ' + day(p.followUpOn) : ''}</span></button>`).join('')}</div>` : '<p class="el-muted">Not in anyone’s pipeline yet.</p>'}
                    ${l.kind === 'influencer' || l.kind === 'business' ? `
                    <div class="ws-form two ld-add">
                        <div><label for="ld-for">For</label><select id="ld-for">
                            ${l.kind === 'business' ? '<option value="">Our agency (a prospect for us)</option>' : ''}
                            ${clients.map(c => `<option value="${esc(c.id)}" ${EL.currentClient && EL.currentClient() && EL.currentClient().id === c.id ? 'selected' : ''}>${esc(c.brand || c.name)}</option>`).join('')}
                            ${l.kind === 'influencer' ? '<option value="">Not for a brand yet</option>' : ''}</select></div>
                        <div><label for="ld-who">Who handles it</label><select id="ld-who">${people.map(p => `<option value="${esc(p.id)}">${esc(p.name)}${p.me ? ' (me)' : ''}</option>`).join('')}</select></div>
                        <div><label for="ld-fu">Follow up on</label><input id="ld-fu" type="date"></div>
                        <div><label for="ld-note">Note</label><input id="ld-note" placeholder="Why they are worth it" maxlength="2000"></div>
                    </div>
                    <div class="ld-actions"><button class="ws-btn is-gold is-sm" type="button" id="ld-add">${ic('plus')}Add to pipeline</button><span class="ws-note" id="ld-add-note"></span></div>`
                    : '<p class="ws-hint">Mark it as an influencer or a business above to add it to a pipeline.</p>'}
                </section>`;
            d.body.querySelectorAll('[data-kind]').forEach(b => b.addEventListener('click', async () => {
                b.disabled = true;
                try {
                    const r = await EL.api(`/api/leads/${encodeURIComponent(l.id)}/kind`, { method: 'PATCH', body: { kind: b.dataset.kind || null } });
                    data.lead = { ...r.lead }; draw();
                    EL.toast(b.dataset.kind ? `Marked as ${KIND_NAME[b.dataset.kind].toLowerCase()}.` : 'Back to the automatic sorting.');
                    if (opts.onChange) opts.onChange();
                } catch (err) { EL.toast(err.message, 'bad'); b.disabled = false; }
            }));
            d.body.querySelectorAll('[data-pipe]').forEach(b => b.addEventListener('click', () => openPipe(b.dataset.pipe, opts)));
            const add = d.body.querySelector('#ld-add');
            if (add) add.addEventListener('click', async () => {
                add.disabled = true;
                const note = d.body.querySelector('#ld-add-note');
                try {
                    const r = await EL.api('/api/leads/pipeline', { method: 'POST', body: {
                        leadIds: [l.id], kind: l.kind, clientId: d.body.querySelector('#ld-for').value || null,
                        assignedTo: d.body.querySelector('#ld-who').value || null,
                        followUpOn: d.body.querySelector('#ld-fu').value || null, note: d.body.querySelector('#ld-note').value.trim() || null
                    } });
                    if ((r.already || []).length && !(r.added || []).length) {
                        const a = r.already[0];
                        note.className = 'ws-note is-bad';
                        note.textContent = `Already in the pipeline${a.client ? ' for ' + a.client : ''}${a.assignee ? ', with ' + a.assignee : ''}, at ${a.stageName}.`;
                        add.disabled = false; return;
                    }
                    EL.toast('Added to the pipeline.');
                    const again = await EL.api(`/api/leads/${encodeURIComponent(l.id)}/detail`);
                    data = again; draw();
                    if (opts.onChange) opts.onChange();
                } catch (err) { note.className = 'ws-note is-bad'; note.textContent = err.message; add.disabled = false; }
            });
        };
        draw();
        return d;
    }

    // ---- the pipeline row ----------------------------------------------------
    async function openPipe(id, opts = {}) {
        const d = EL.drawer({ title: 'Loading…', sub: '&nbsp;', body: '<p class="el-muted">Loading…</p>', wide: true });
        let data;
        const load = async () => { data = await EL.api(`/api/leads/pipeline/${encodeURIComponent(id)}`); };
        try { await load(); } catch (err) { d.body.innerHTML = `<p class="el-muted">${esc(err.message)}</p>`; return d; }
        const people = await team();

        const draw = () => {
            const r = data.row, l = data.lead || {};
            const url = (r.lead && r.lead.profileUrl) || (r.platform === 'facebook' ? `https://facebook.com/${r.username}` : `https://instagram.com/${r.username}`);
            d.setTitle(esc(l.fullName || '@' + r.username),
                `${kindChip(r.kind)} for <b>${esc(r.client || 'our agency')}</b> · <a href="${EL.safeUrl(url)}" target="_blank" rel="noopener noreferrer">open profile</a>`);
            const who = r.assignedTo || '';
            const closedBad = r.stage === 'lost' || r.stage === 'dropped';
            d.body.innerHTML = `
                <section class="ld-sec">
                    <h3 class="ld-h">Stage</h3>
                    <div class="ld-stages" role="radiogroup" aria-label="Stage">${data.stages.map(([k, n]) => `<button type="button" class="ld-st${k === r.stage ? ' is-on' : ''}" role="radio" aria-checked="${k === r.stage}" data-st="${k}">${esc(n)}</button>`).join('')}</div>
                </section>
                <section class="ld-sec">
                    <div class="ws-form two">
                        <div><label for="pp-who">Who handles it</label><select id="pp-who"><option value="">Nobody</option>${people.map(p => `<option value="${esc(p.id)}" ${p.id === who ? 'selected' : ''}>${esc(p.name)}${p.me ? ' (me)' : ''}</option>`).join('')}</select></div>
                        <div><label for="pp-fu">Follow up on</label><input id="pp-fu" type="date" value="${esc(r.followUpOn || '')}"></div>
                        ${r.kind === 'influencer' ? `<div><label for="pp-rate">Their rate</label><input id="pp-rate" value="${esc(r.rate || '')}" placeholder="e.g. ৳8,000 per reel" maxlength="120"></div>` : ''}
                        ${closedBad ? `<div><label for="pp-lost">Why it ended</label><input id="pp-lost" value="${esc(r.lostReason || '')}" maxlength="300"></div>` : ''}
                    </div>
                    <div class="ld-actions"><button class="ws-btn is-sm" type="button" id="pp-save">Save</button><span class="ws-note" id="pp-note"></span></div>
                </section>
                <section class="ld-sec">
                    <h3 class="ld-h">First message</h3>
                    <p class="ws-hint">Written from their own posts. Read it, change it, and send it yourself: nothing is sent from here.</p>
                    <div class="ld-actions"><button class="ws-btn is-sm" type="button" id="pp-draft">${ic('pen')}Write a first message</button>
                        ${r.kind === 'business' && r.stage !== 'won' ? `<button class="ws-btn is-sm" type="button" id="pp-convert">${ic('clients')}Won: make them a client</button>` : ''}</div>
                    <div id="pp-draft-box"></div>
                </section>
                <section class="ld-sec">
                    <h3 class="ld-h">Contact</h3>
                    <div class="ld-contact">${[l.email, l.phone, l.whatsapp && l.whatsapp !== l.phone ? 'WhatsApp ' + l.whatsapp : null].filter(Boolean).map(x => `<span>${esc(x)}</span>`).join('') || '<span class="el-muted">No contact found yet.</span>'}</div>
                </section>
                <section class="ld-sec">
                    <h3 class="ld-h">History</h3>
                    <form id="pp-nform" class="ld-nform"><input id="pp-ntext" placeholder="What happened? e.g. Sent DM, asked rates" maxlength="2000" aria-label="Add a note"><button class="ws-btn is-sm" type="submit">Add</button></form>
                    <div class="ld-notes">${(data.notes || []).map(n => `<div class="ld-n${n.auto ? ' is-auto' : ''}"><div class="meta">${esc(n.author || 'Team')} · ${esc(ago(n.at))}</div>${esc(n.body)}</div>`).join('') || '<p class="el-muted">Nothing yet.</p>'}</div>
                </section>`;
            d.el.querySelector('.el-drawer-f') && d.el.querySelector('.el-drawer-f').remove();

            const $ = s => d.body.querySelector(s);
            let stage = r.stage;
            d.body.querySelectorAll('[data-st]').forEach(b => b.addEventListener('click', async () => {
                if (b.dataset.st === stage) return;
                stage = b.dataset.st;
                await save({ stage });
            }));
            const save = async (extra = {}) => {
                const body = { assignedTo: $('#pp-who').value || null, followUpOn: $('#pp-fu').value || null, ...extra };
                if ($('#pp-rate')) body.rate = $('#pp-rate').value.trim() || null;
                if ($('#pp-lost')) body.lostReason = $('#pp-lost').value.trim() || null;
                try {
                    await EL.api(`/api/leads/pipeline/${encodeURIComponent(id)}`, { method: 'PATCH', body });
                    await load(); draw();
                    EL.toast(extra.stage ? `Moved to ${data.row.stageName}.` : 'Saved.');
                    if (opts.onChange) opts.onChange();
                } catch (err) { const n = $('#pp-note'); if (n) { n.className = 'ws-note is-bad'; n.textContent = err.message; } }
            };
            $('#pp-save').addEventListener('click', () => save());
            $('#pp-nform').addEventListener('submit', async e => {
                e.preventDefault();
                const v = $('#pp-ntext').value.trim(); if (!v) return;
                try { await EL.api(`/api/leads/pipeline/${encodeURIComponent(id)}/notes`, { method: 'POST', body: { body: v } }); await load(); draw(); if (opts.onChange) opts.onChange(); }
                catch (err) { EL.toast(err.message, 'bad'); }
            });
            $('#pp-draft').addEventListener('click', async () => {
                const b = $('#pp-draft'); b.disabled = true; b.textContent = 'Writing…';
                try {
                    const m = await EL.api(`/api/leads/pipeline/${encodeURIComponent(id)}/draft`, { method: 'POST', body: {} });
                    $('#pp-draft-box').innerHTML = `<textarea id="pp-msg" class="ld-msg" rows="6" aria-label="First message">${esc(m.message)}</textarea>
                        <div class="ld-actions"><button class="ws-btn is-gold is-sm" type="button" id="pp-copy">Copy</button><span class="ws-hint">Then paste it into Instagram and send.</span></div>`;
                    $('#pp-copy').addEventListener('click', async () => {
                        const t = $('#pp-msg');
                        try { await navigator.clipboard.writeText(t.value); EL.toast('Copied.'); }
                        catch { t.select(); EL.toast('Selected: press Ctrl+C (or ⌘C) to copy.'); }
                    });
                } catch (err) { $('#pp-draft-box').innerHTML = `<p class="ws-note is-bad">${esc(err.message)}</p>`; }
                b.disabled = false; b.innerHTML = `${ic('pen')}Write another`;
            });
            const conv = $('#pp-convert');
            if (conv) conv.addEventListener('click', async () => {
                if (conv.dataset.sure !== '1') { conv.dataset.sure = '1'; conv.textContent = 'Create the client: press again'; return; }
                conv.disabled = true;
                try {
                    const c = await EL.api(`/api/leads/pipeline/${encodeURIComponent(id)}/convert`, { method: 'POST', body: {} });
                    EL.toast(`${c.client.name} is now a client.`);
                    if (opts.onChange) opts.onChange();
                    location.href = `workspace.html?client=${encodeURIComponent(c.client.id)}`;
                } catch (err) { EL.toast(err.message, 'bad'); conv.disabled = false; }
            });
        };
        draw();
        return d;
    }

    window.LeadUI = { openLead, openPipe, kindChip, fitChip, KIND_NAME, day };
})();
