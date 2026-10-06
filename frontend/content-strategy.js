/**
 * content-strategy.js — the content plan the way the agency works. (phase 43)
 *
 *   CSPlan.mount(host, clientId)   one client's month: the business, topics by category,
 *                                  ideas from the library, the month's picks, the market
 *   CSLib.mount(host)              the team's shared idea library
 *
 * The page chooses topics and suggests ideas. It never makes the content: the
 * team writes its own idea, script and style notes before a pick is final, and
 * a final pick goes on the calendar for the owner to approve.
 * Styles are cs-* in app.css.
 */
(function () {
    'use strict';
    const esc = v => (window.EL && EL.escape ? EL.escape(v) : String(v ?? ''));
    const url = u => (window.EL && EL.safeUrl ? EL.safeUrl(u) : '#');
    const TYPES = [['static', 'Static'], ['carousel', 'Carousel'], ['video', 'Video'], ['story', 'Story']];
    const TYPE_NAME = Object.fromEntries(TYPES);
    const PRIORITY_NEXT = { high: 'normal', normal: 'low', low: 'high' };
    const SOURCE_NAME = { audit: 'from the audit', rivals: 'from rivals', reviews: 'from reviews', manual: 'added by the team' };
    const lines = v => String(v || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
    const note = (el, text, tone) => { if (!el) return; el.className = 'ws-note' + (tone ? ' is-' + tone : ''); el.textContent = text || ''; };
    const typeChip = t => `<span class="cs-type is-${esc(t)}">${esc(TYPE_NAME[t] || t)}</span>`;
    const fitChip = f => f === 'good' ? '<span class="el-chip is-jade">Good fit</span>' : '<span class="el-chip is-warn">Weak fit</span>';

    // =======================================================================
    // ONE CLIENT'S PLAN
    // =======================================================================
    async function mountPlan(host, clientId, opts = {}) {
        if (!host) return;
        if (!clientId) { host.innerHTML = '<div class="cs-empty">Choose a client in the bar above. A plan is always for one business.</div>'; return; }
        let month = opts.month || new Date().toISOString().slice(0, 7);
        let S = null;
        const base = `/api/content-strategy/${encodeURIComponent(clientId)}`;

        async function load() {
            try { S = await EL.api(`${base}?month=${month}`); draw(); }
            catch (err) { host.innerHTML = `<div class="cs-empty">${esc(err.message)}</div>`; }
        }

        function draw() {
            const b = (S.profile && S.profile.business) || {};
            const src = (S.profile && S.profile.sources) || {};
            const audit = S.profile && S.profile.audit;
            const active = S.topics.filter(t => t.active);
            const pickedKey = new Set(S.picks.map(p => `${p.topicId}|${p.ideaId}`));
            const counts = TYPES.map(([k, n]) => `<span><b>${S.counts[k] || 0}</b> ${n.toLowerCase()}</span>`).join('');
            const finals = S.picks.filter(p => p.status === 'final' && !p.postId).length;
            host.innerHTML = `
                <div class="cs-bar">
                    <div><label for="cs-month" class="cs-inl">Month</label><input id="cs-month" type="month" value="${esc(month)}"></div>
                    <div class="cs-counts"><span><b>${S.picks.length}</b> planned</span>${counts}</div>
                </div>

                <section class="cs-step">
                    <header><span class="cs-n">1</span><div><h3>The business</h3><p>What they are and what they sell. Each offer becomes a primary topic.</p></div></header>
                    <div class="cs-audit">
                        <div><label for="cs-web">Website</label><input id="cs-web" placeholder="harborcafe.com" value="${esc(src.website || '')}"></div>
                        <div><label for="cs-ig">Instagram</label><input id="cs-ig" placeholder="@handle" value="${esc(src.instagram ? '@' + src.instagram : (S.client.igHandle ? '@' + S.client.igHandle : ''))}"></div>
                        <div class="cs-audit-go"><button class="ws-btn is-gold is-sm" type="button" id="cs-audit">${S.profile && S.profile.auditedAt ? 'Audit again' : 'Audit the business'}</button></div>
                    </div>
                    <p class="ws-hint">Reads the website (and its menu, services or pricing pages) and the Instagram posts already collected. Nothing is scraped, so it costs no Apify credit.</p>
                    <div class="ws-note" id="cs-audit-note"></div>
                    ${audit && audit.applied === false && audit.suggestion && audit.suggestion.summary && audit.suggestion.summary !== b.summary
                        ? `<div class="cs-banner">The last audit read it differently: “${esc(audit.suggestion.summary)}” <button class="ws-btn is-sm" type="button" id="cs-use-audit">Use the audit’s version</button></div>` : ''}
                    ${b.summary || (b.offers || []).length ? `
                    <div class="cs-biz">
                        <div class="cs-biz-main">
                            ${b.summary ? `<p class="cs-sum">${esc(b.summary)}</p>` : ''}
                            <dl>
                                ${b.model ? `<dt>Business model</dt><dd>${esc(b.model)}</dd>` : ''}
                                ${b.audience ? `<dt>Who buys</dt><dd>${esc(b.audience)}</dd>` : ''}
                                ${b.voice ? `<dt>Voice</dt><dd>${esc(b.voice)}</dd>` : ''}
                                ${(b.differentiators || []).length ? `<dt>Why them</dt><dd>${b.differentiators.map(esc).join(' · ')}</dd>` : ''}
                                ${(b.proof || []).length ? `<dt>Proof</dt><dd>${b.proof.map(esc).join(' · ')}</dd>` : ''}
                            </dl>
                        </div>
                        <div class="cs-offers">
                            <h4>What they sell</h4>
                            ${(b.offers || []).length ? `<ul>${b.offers.map(o => `<li><span>${esc(o.name)}${o.note ? `<small>${esc(o.note)}</small>` : ''}</span><b>${esc(o.price || '')}</b></li>`).join('')}</ul>` : '<p class="ws-hint">No offers yet.</p>'}
                        </div>
                    </div>` : '<div class="cs-empty">Not audited yet. Give the website or the Instagram handle and press Audit, or write it in yourself.</div>'}
                    <div class="ld-actions"><button class="ws-btn is-sm" type="button" id="cs-edit-biz">Edit the business</button>
                        ${S.profile && S.profile.auditedAt ? `<span class="ws-hint">Audited ${new Date(S.profile.auditedAt).toLocaleDateString()}${audit && audit.aiStatus && !audit.aiStatus.ok ? ' · AI: ' + esc(audit.aiStatus.message || audit.aiStatus.reason) : ''}</span>` : ''}</div>
                </section>

                <section class="cs-step">
                    <header><span class="cs-n">2</span><div><h3>Topics by category</h3><p>Tick what goes in this client’s plan. Click the priority to change it.</p></div></header>
                    <div class="cs-cats">${S.categories.map(([k, n]) => {
                        const list = S.topics.filter(t => t.category === k);
                        return `<div class="cs-cat">
                            <h4>${esc(n)} <span>${list.filter(t => t.active).length}/${list.length}</span></h4>
                            ${list.map(t => `<div class="cs-topic${t.active ? ' is-on' : ''}">
                                <input type="checkbox" data-tick="${esc(t.id)}" ${t.active ? 'checked' : ''} aria-label="Use ${esc(t.title)}">
                                <div class="cs-topic-body"><b>${esc(t.title)}</b>${t.detail ? `<small>${esc(t.detail)}</small>` : ''}${t.why ? `<small class="cs-why">${esc(t.why)}</small>` : ''}
                                    <span class="cs-src">${esc(SOURCE_NAME[t.source] || '')}</span></div>
                                <button type="button" class="cs-pri is-${esc(t.priority)}" data-pri="${esc(t.id)}" data-now="${esc(t.priority)}" title="Priority">${esc(t.priority)}</button>
                                <button type="button" class="cs-x" data-deltopic="${esc(t.id)}" aria-label="Remove ${esc(t.title)}">×</button>
                            </div>`).join('') || '<p class="ws-hint">None yet.</p>'}
                            <form class="cs-addtopic" data-cat="${esc(k)}"><input maxlength="160" placeholder="Add a topic" aria-label="Add a ${esc(n)} topic"><button class="ws-btn is-sm" type="submit">Add</button></form>
                        </div>`;
                    }).join('')}</div>
                </section>

                <section class="cs-step">
                    <header><span class="cs-n">3</span><div><h3>Ideas from the library</h3><p>For each ticked topic, ideas from the team’s library that could carry it — often from another industry. Pick one, then add your own notes in step 4.</p></div></header>
                    <div class="ld-actions"><button class="ws-btn is-gold is-sm" type="button" id="cs-suggest" ${active.length && S.libraryCount ? '' : 'disabled'}>Suggest ideas with AI</button>
                        <span class="ws-hint">${S.libraryCount ? `${S.libraryCount} idea(s) in the library. Without AI the best matches by type and tags are shown.` : 'The library is empty — add ideas in the Idea library tab.'}</span></div>
                    <div class="ws-note" id="cs-suggest-note"></div>
                    ${active.length ? active.map(t => `<div class="cs-ideas-row">
                        <div class="cs-ideas-topic"><span class="cs-catname">${esc(t.categoryName)}</span><b>${esc(t.title)}</b>
                            <button type="button" class="cs-link" data-pickbare="${esc(t.id)}">Plan it without a library idea</button></div>
                        <div class="cs-ideas">${t.ideas.length ? t.ideas.map(s => {
                            const i = s.idea; const done = pickedKey.has(`${t.id}|${i.id}`);
                            return `<div class="cs-idea">
                                <div class="cs-idea-top">${typeChip(i.postType)}${fitChip(s.fit)}${s.by === 'ai' ? '<span class="cs-src">AI</span>' : ''}</div>
                                <p class="cs-hook">${esc(i.hook || 'Saved post')}</p>
                                ${i.sourceName ? `<p class="cs-seen">Seen at ${esc(i.sourceName)}${i.industry ? ' · ' + esc(i.industry) : ''}${i.url ? ` · <a href="${url(i.url)}" target="_blank" rel="noopener noreferrer">open</a>` : ''}</p>` : (i.url ? `<p class="cs-seen"><a href="${url(i.url)}" target="_blank" rel="noopener noreferrer">open the post</a></p>` : '')}
                                ${i.whyWorked ? `<p class="cs-line"><b>Why it worked:</b> ${esc(i.whyWorked)}</p>` : ''}
                                ${s.adaptation ? `<p class="cs-line cs-adapt"><b>For this topic:</b> ${esc(s.adaptation)}</p>` : ''}
                                ${(s.reasons || []).length ? `<p class="cs-line cs-muted">${s.reasons.map(esc).join(' · ')}</p>` : ''}
                                <p class="cs-line"><b>Tools:</b> ${esc((s.tools || []).join(', '))}</p>
                                <button class="ws-btn is-sm${done ? '' : ' is-gold'}" type="button" data-pick="${esc(t.id)}|${esc(i.id)}" ${done ? 'disabled' : ''}>${done ? 'Picked' : 'Pick this'}</button>
                            </div>`;
                        }).join('') : '<p class="ws-hint">No library idea matches yet. Add some to the library, or plan it without one.</p>'}</div>
                    </div>`).join('') : '<div class="cs-empty">Tick topics in step 2 first.</div>'}
                </section>

                <section class="cs-step">
                    <header><span class="cs-n">4</span><div><h3>This month’s plan</h3><p>Open a pick to write your idea, script and style notes — a pick is final only once you have. Final picks go on the calendar for the owner to approve.</p></div></header>
                    ${S.picks.length ? `<div class="cs-scroll"><table class="cs-table"><thead><tr><th>Category</th><th>Topic</th><th>Idea</th><th>Type</th><th>Tools</th><th>Status</th></tr></thead><tbody>
                        ${S.picks.map(p => `<tr data-openpick="${esc(p.id)}" tabindex="0">
                            <td>${esc(p.categoryName || '—')}</td><td><b>${esc(p.title || p.topic || '—')}</b>${p.topic && p.title && p.title !== p.topic ? `<small>${esc(p.topic)}</small>` : ''}</td>
                            <td>${p.idea ? `${esc(p.idea.hook || 'Saved post')}${p.idea.sourceName ? `<small>${esc(p.idea.sourceName)}</small>` : ''}` : '<span class="cs-muted">Own idea</span>'}</td>
                            <td>${typeChip(p.postType)}</td><td>${esc((p.tools || []).join(', '))}</td>
                            <td>${p.post ? `<span class="el-chip is-gold">${esc(p.post.statusName)}</span>` : p.status === 'final' ? '<span class="el-chip is-jade">Final</span>' : '<span class="el-chip is-warn">Draft</span>'}</td>
                        </tr>`).join('')}</tbody></table></div>
                    <div class="ld-actions cs-sched"><label for="cs-start" class="cs-inl">Start on</label><input id="cs-start" type="date" value="${esc(month + '-01' < new Date(Date.now() + 86400000).toISOString().slice(0, 10) ? new Date(Date.now() + 86400000).toISOString().slice(0, 10) : month + '-01')}">
                        <button class="ws-btn is-gold is-sm" type="button" id="cs-schedule" ${finals ? '' : 'disabled'}>Put ${finals || ''} final pick${finals === 1 ? '' : 's'} on the calendar</button><span class="ws-note" id="cs-sched-note"></span></div>`
                        : '<div class="cs-empty">Nothing picked for this month yet.</div>'}
                    <h4 class="cs-sub">On the calendar this month</h4>
                    <div id="cs-cal"></div>
                </section>

                <section class="cs-step">
                    <header><span class="cs-n">5</span><div><h3>What works in this market</h3><p>From this client’s newest scorecard against its rivals.</p></div></header>
                    ${marketHtml(S.market)}
                </section>`;
            wire();
            if (window.CPCal) CPCal.mount(host.querySelector('#cs-cal'), null, { listUrl: `${base}/calendar?month=${month}`, emptyText: 'Nothing on the calendar for this month yet.' });
        }

        function marketHtml(m) {
            if (!m) return '<div class="cs-empty">No scorecard for this client yet. Build one in the Scorecard tab, with its rivals, to see what wins in this market.</div>';
            const pct = v => (v == null ? '—' : Math.round(v * 100) + '%');
            const idx = v => (v == null ? '—' : Number(v).toFixed(2) + '×');
            return `${m.stale ? '<div class="cs-banner">Some of the posts behind it are old. Rebuild the scorecard before leaning on it.</div>' : ''}
                <p class="ws-hint">vs ${esc((m.rivals || []).join(', ') || 'no rivals')} · built ${new Date(m.builtAt).toLocaleDateString()}${m.bestType ? ` · <b>${esc(TYPE_NAME[m.bestType])}</b> is what wins for rivals` : ''}</p>
                <div class="cs-scroll"><table class="cs-table"><thead><tr><th>Format</th><th>Share (them / rivals)</th><th>Score (them / rivals)</th><th>Best hour</th></tr></thead><tbody>
                ${m.formats.map(f => `<tr><td>${esc(f.label)}</td><td>${pct(f.share.target)} / ${pct(f.share.rivals)}</td><td>${idx(f.index.target)} / ${idx(f.index.rivals)}</td><td>${esc(f.bestHour || '—')}</td></tr>`).join('')}
                </tbody></table></div>
                ${(m.topics || []).length ? `<p class="cs-line"><b>Rival topics that work:</b> ${m.topics.map(t => `${esc(t.topic)} ${idx(t.index)}`).join(' · ')}</p>` : ''}
                ${(m.gaps || []).length ? `<p class="cs-line"><b>Gaps they have never tried:</b> ${m.gaps.map(g => `${esc(g.format)} about ${esc(g.topic)}`).join(' · ')}</p>` : ''}
                <p class="ws-hint">Score 1.00× is an account’s normal post. Public numbers only.</p>`;
        }

        function wire() {
            const q = s => host.querySelector(s);
            q('#cs-month').addEventListener('change', e => { if (/^\d{4}-\d{2}$/.test(e.target.value)) { month = e.target.value; load(); } });
            q('#cs-audit').addEventListener('click', async () => {
                const b = q('#cs-audit'); b.disabled = true;
                note(q('#cs-audit-note'), 'Starting…');
                try {
                    await EL.runJob(`${base}/audit`, { website: q('#cs-web').value.trim() || undefined, instagram: q('#cs-ig').value.trim() || undefined }, {
                        onProgress: j => note(q('#cs-audit-note'), `${j.progress || 0}% · ${j.current_step || j.status}`),
                        onDone: j => { EL.toast(`Audit done. ${(j.result && j.result.topicsAdded) || 0} topic(s) added.`); load(); },
                        onFailed: j => { note(q('#cs-audit-note'), 'Failed: ' + (j.error || 'unknown'), 'bad'); b.disabled = false; }
                    });
                } catch (err) { note(q('#cs-audit-note'), err.message, 'bad'); b.disabled = false; }
            });
            const use = q('#cs-use-audit');
            if (use) use.addEventListener('click', async () => {
                try { await EL.api(`${base}/profile`, { method: 'PUT', body: { business: S.profile.audit.suggestion } }); EL.toast('Using the audit’s version.'); load(); }
                catch (err) { EL.toast(err.message, 'bad'); }
            });
            q('#cs-edit-biz').addEventListener('click', editBusiness);
            host.querySelectorAll('[data-tick]').forEach(c => c.addEventListener('change', () => patchTopic(c.dataset.tick, { active: c.checked })));
            host.querySelectorAll('[data-pri]').forEach(b => b.addEventListener('click', () => patchTopic(b.dataset.pri, { priority: PRIORITY_NEXT[b.dataset.now] || 'normal' })));
            host.querySelectorAll('[data-deltopic]').forEach(b => b.addEventListener('click', async () => {
                if (!confirm('Remove this topic?')) return;
                try { await EL.api(`/api/content-topics/${encodeURIComponent(b.dataset.deltopic)}`, { method: 'DELETE' }); load(); } catch (err) { EL.toast(err.message, 'bad'); }
            }));
            host.querySelectorAll('.cs-addtopic').forEach(f => f.addEventListener('submit', async e => {
                e.preventDefault();
                const title = f.querySelector('input').value.trim(); if (!title) return;
                try { await EL.api(`${base}/topics`, { method: 'POST', body: { category: f.dataset.cat, title } }); load(); } catch (err) { EL.toast(err.message, 'bad'); }
            }));
            const sug = q('#cs-suggest');
            if (sug) sug.addEventListener('click', async () => {
                sug.disabled = true; note(q('#cs-suggest-note'), 'Starting…');
                try {
                    await EL.runJob(`${base}/suggest`, { month }, {
                        onProgress: j => note(q('#cs-suggest-note'), `${j.progress || 0}% · ${j.current_step || j.status}`),
                        onDone: j => { const a = j.result && j.result.aiStatus; EL.toast(a && !a.ok ? 'AI was not available; showing the best matches by type and tags.' : 'Ideas suggested.'); load(); },
                        onFailed: j => { note(q('#cs-suggest-note'), 'Failed: ' + (j.error || 'unknown'), 'bad'); sug.disabled = false; }
                    });
                } catch (err) { note(q('#cs-suggest-note'), err.message, 'bad'); sug.disabled = false; }
            });
            host.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', async () => {
                const [topicId, ideaId] = b.dataset.pick.split('|'); b.disabled = true;
                try { const r = await EL.api(`${base}/picks`, { method: 'POST', body: { month, topicId, ideaId } }); EL.toast('Picked. Add your notes in step 4.'); await load(); openPick(r.pick.id); }
                catch (err) { EL.toast(err.message, 'bad'); b.disabled = false; }
            }));
            host.querySelectorAll('[data-pickbare]').forEach(b => b.addEventListener('click', async () => {
                try { const r = await EL.api(`${base}/picks`, { method: 'POST', body: { month, topicId: b.dataset.pickbare } }); await load(); openPick(r.pick.id); }
                catch (err) { EL.toast(err.message, 'bad'); }
            }));
            host.querySelectorAll('[data-openpick]').forEach(r => {
                r.addEventListener('click', () => openPick(r.dataset.openpick));
                r.addEventListener('keydown', e => { if (e.key === 'Enter') openPick(r.dataset.openpick); });
            });
            const sch = q('#cs-schedule');
            if (sch) sch.addEventListener('click', async () => {
                sch.disabled = true;
                try {
                    const r = await EL.api(`${base}/schedule`, { method: 'POST', body: { month, start: q('#cs-start').value } });
                    EL.toast(`${r.added} post${r.added === 1 ? '' : 's'} on the calendar, waiting for the owner.${r.drafts ? ` ${r.drafts} still in draft.` : ''}`);
                    load();
                } catch (err) { note(q('#cs-sched-note'), err.message, 'bad'); sch.disabled = false; }
            });
        }

        async function patchTopic(id, body) {
            try { await EL.api(`/api/content-topics/${encodeURIComponent(id)}`, { method: 'PATCH', body }); load(); }
            catch (err) { EL.toast(err.message, 'bad'); }
        }

        function editBusiness() {
            const b = (S.profile && S.profile.business) || {};
            const dw = EL.drawer({
                title: 'The business', sub: esc(S.client.name), wide: true,
                body: `<div class="ws-form">
                    <div><label for="cb-sum">What they are, and how they make money</label><textarea id="cb-sum" rows="3" maxlength="800">${esc(b.summary || '')}</textarea></div>
                    <div class="ws-form two">
                        <div><label for="cb-model">Business model</label><input id="cb-model" maxlength="300" value="${esc(b.model || '')}"></div>
                        <div><label for="cb-aud">Who buys</label><input id="cb-aud" maxlength="300" value="${esc(b.audience || '')}"></div>
                    </div>
                    <div><label for="cb-voice">Voice</label><input id="cb-voice" maxlength="200" value="${esc(b.voice || '')}"></div>
                    <div><label for="cb-offers">What they sell — one per line: name | price | note</label><textarea id="cb-offers" rows="6">${esc((b.offers || []).map(o => [o.name, o.price || '', o.note || ''].join(' | ').replace(/( \| )+$/, '')).join('\n'))}</textarea>
                        <p class="ws-hint">Each offer becomes a primary topic the next time the business is audited.</p></div>
                    <div class="ws-form two">
                        <div><label for="cb-diff">Why them — one per line</label><textarea id="cb-diff" rows="3">${esc((b.differentiators || []).join('\n'))}</textarea></div>
                        <div><label for="cb-proof">Proof — one per line</label><textarea id="cb-proof" rows="3">${esc((b.proof || []).join('\n'))}</textarea></div>
                    </div>
                    <div class="ws-note" id="cb-note"></div></div>`,
                foot: `<button class="ws-btn is-quiet" type="button" data-dw-close>Close</button><button class="ws-btn is-gold" type="button" id="cb-save">Save</button>`
            });
            dw.el.querySelector('#cb-save').addEventListener('click', async () => {
                const v = s => dw.el.querySelector(s).value;
                const business = {
                    summary: v('#cb-sum'), model: v('#cb-model'), audience: v('#cb-aud'), voice: v('#cb-voice'),
                    offers: lines(v('#cb-offers')).map(l => { const [name, price, noteText] = l.split('|').map(x => x.trim()); return { name, price: price || null, note: noteText || null }; }),
                    differentiators: lines(v('#cb-diff')), proof: lines(v('#cb-proof'))
                };
                try { await EL.api(`${base}/profile`, { method: 'PUT', body: { business } }); EL.closeDrawer(); EL.toast('Saved.'); load(); }
                catch (err) { note(dw.el.querySelector('#cb-note'), err.message, 'bad'); }
            });
        }

        function openPick(id) {
            const p = S.picks.find(x => x.id === id);
            if (!p) return;
            const locked = p.post && ['made', 'posted'].includes(p.post.status);
            const dw = EL.drawer({
                title: esc(p.title || p.topic || 'Planned post'), sub: `${esc(p.categoryName || 'No topic')} · ${esc(TYPE_NAME[p.postType])}${p.post ? ' · on the calendar: ' + esc(p.post.statusName) : ''}`, wide: true,
                body: `
                    ${p.idea ? `<section class="ld-sec"><h3 class="ld-h">The library idea</h3><p class="ld-line">${esc(p.idea.hook || 'Saved post')}${p.idea.sourceName ? ' · seen at ' + esc(p.idea.sourceName) : ''}${p.idea.url ? ` · <a href="${url(p.idea.url)}" target="_blank" rel="noopener noreferrer">open</a>` : ''}</p></section>` : ''}
                    <div class="ws-form">
                        <div class="ws-form two">
                            <div><label for="pk-title">Working title</label><input id="pk-title" maxlength="300" value="${esc(p.title || '')}"></div>
                            <div><label for="pk-type">Post type</label><select id="pk-type">${TYPES.map(([k, n]) => `<option value="${k}"${k === p.postType ? ' selected' : ''}>${n}</option>`).join('')}</select></div>
                        </div>
                        <div><label for="pk-adapt">How the idea fits this topic</label><input id="pk-adapt" maxlength="600" value="${esc(p.adaptation || '')}"></div>
                        <div><label for="pk-idea">Your idea</label><textarea id="pk-idea" rows="3" maxlength="1000" placeholder="What the post is, in your words">${esc(p.ideaNote || '')}</textarea></div>
                        <div><label for="pk-script">Script — one beat per line</label><textarea id="pk-script" rows="5" maxlength="2000" placeholder="Hook&#10;Beat 2&#10;Close">${esc(p.scriptNote || '')}</textarea></div>
                        <div><label for="pk-style">Style — look, pace, shots</label><textarea id="pk-style" rows="3" maxlength="1000">${esc(p.styleNote || '')}</textarea></div>
                        <div><label for="pk-tools">Tools — comma separated</label><input id="pk-tools" value="${esc((p.tools || []).join(', '))}"></div>
                    </div>
                    <p class="ws-hint">${locked ? 'This post is already made; changes here no longer reach the calendar.' : 'The system does not write the post. Your idea, script or style note is what makes it final.'}</p>
                    <div class="ws-note" id="pk-note"></div>`,
                foot: `<button class="ws-btn is-danger is-sm" type="button" id="pk-del">Remove</button><span class="cs-grow"></span>
                    <button class="ws-btn is-quiet" type="button" data-dw-close>Close</button>
                    <button class="ws-btn" type="button" id="pk-draft">Save draft</button>
                    <button class="ws-btn is-gold" type="button" id="pk-final">${p.status === 'final' ? 'Save' : 'Save as final'}</button>`
            });
            const v = s => dw.el.querySelector(s).value;
            const save = async status => {
                const body = { title: v('#pk-title'), postType: v('#pk-type'), adaptation: v('#pk-adapt'), ideaNote: v('#pk-idea'), scriptNote: v('#pk-script'), styleNote: v('#pk-style'), tools: v('#pk-tools'), status };
                try { await EL.api(`/api/content-picks/${encodeURIComponent(p.id)}`, { method: 'PATCH', body }); EL.closeDrawer(); EL.toast(status === 'final' ? 'Final. Put it on the calendar when the month is ready.' : 'Saved.'); load(); }
                catch (err) { note(dw.el.querySelector('#pk-note'), err.message, 'bad'); }
            };
            dw.el.querySelector('#pk-draft').addEventListener('click', () => save('draft'));
            dw.el.querySelector('#pk-final').addEventListener('click', () => save('final'));
            dw.el.querySelector('#pk-del').addEventListener('click', async () => {
                if (!confirm('Remove this pick?')) return;
                try { await EL.api(`/api/content-picks/${encodeURIComponent(p.id)}`, { method: 'DELETE' }); EL.closeDrawer(); load(); }
                catch (err) { note(dw.el.querySelector('#pk-note'), err.message, 'bad'); }
            });
        }

        host.innerHTML = '<p class="el-muted">Loading the plan…</p>';
        await load();
    }

    // =======================================================================
    // THE IDEA LIBRARY
    // =======================================================================
    async function mountLib(host) {
        if (!host) return;
        const f = { type: '', q: '', tag: '', mine: false };
        const isAdmin = window.EL && EL.me && EL.me.role === 'admin';
        host.innerHTML = `
            <div class="cs-lib-head">
                <p class="ws-hint">Content worth copying the idea of, from any brand in any industry. The whole team saves here and every client’s plan picks from it. Owners never see it.</p>
                <div class="ld-actions"><button class="ws-btn is-gold is-sm" type="button" id="lib-add">Add an idea</button><button class="ws-btn is-sm" type="button" id="lib-import">Import a spreadsheet</button></div>
            </div>
            <div class="cs-filter">
                <div class="cs-chips" id="lib-types"><button type="button" class="ld-st is-on" data-type="">All</button>${TYPES.map(([k, n]) => `<button type="button" class="ld-st" data-type="${k}">${n}</button>`).join('')}
                    <button type="button" class="ld-st" id="lib-mine">Saved by me</button></div>
                <input id="lib-q" type="search" placeholder="Search hooks, notes, brands, tags" aria-label="Search the library">
            </div>
            <div class="cs-chips cs-tags" id="lib-tags"></div>
            <p class="ws-hint" id="lib-count"></p>
            <div class="cs-libgrid" id="lib-grid"><p class="el-muted">Loading…</p></div>`;
        const q = s => host.querySelector(s);

        async function load() {
            const p = new URLSearchParams();
            if (f.type) p.set('type', f.type); if (f.q) p.set('q', f.q); if (f.tag) p.set('tag', f.tag); if (f.mine) p.set('mine', '1');
            let d;
            try { d = await EL.api('/api/content-ideas?' + p.toString()); }
            catch (err) { q('#lib-grid').innerHTML = `<div class="cs-empty">${esc(err.message)}</div>`; return; }
            q('#lib-count').textContent = `${d.matched} of ${d.total} idea(s)${d.shown < d.matched ? ` · showing the newest ${d.shown}` : ''}`;
            q('#lib-tags').innerHTML = (d.tags || []).map(t => `<button type="button" class="cs-tag${f.tag === t.tag ? ' is-on' : ''}" data-tag="${esc(t.tag)}">#${esc(t.tag)} <span>${t.n}</span></button>`).join('');
            q('#lib-tags').querySelectorAll('[data-tag]').forEach(b => b.addEventListener('click', () => { f.tag = f.tag === b.dataset.tag ? '' : b.dataset.tag; load(); }));
            q('#lib-grid').innerHTML = d.ideas.length ? d.ideas.map(i => `<article class="cs-card">
                <div class="cs-idea-top">${typeChip(i.postType)}${i.uses ? `<span class="cs-src">used ${i.uses}×</span>` : ''}</div>
                <p class="cs-hook">${esc(i.hook || 'Saved post')}</p>
                <p class="cs-seen">${i.sourceName ? 'Seen at ' + esc(i.sourceName) : ''}${i.industry ? ' · ' + esc(i.industry) : ''}${i.url ? ` · <a href="${url(i.url)}" target="_blank" rel="noopener noreferrer">open</a>` : ''}</p>
                ${i.whyWorked ? `<p class="cs-line"><b>Why it worked:</b> ${esc(i.whyWorked)}</p>` : ''}
                ${i.style ? `<p class="cs-line"><b>Style:</b> ${esc(i.style)}</p>` : ''}
                ${(i.tools || []).length ? `<p class="cs-line"><b>Tools:</b> ${esc(i.tools.join(', '))}</p>` : ''}
                ${(i.tags || []).length ? `<p class="cs-line cs-muted">${i.tags.map(t => '#' + esc(t)).join(' ')}</p>` : ''}
                <div class="cs-card-foot"><span class="cs-muted">${esc(i.savedBy || 'someone')}</span>${i.mine || isAdmin ? `<button type="button" class="cs-link" data-edit="${esc(i.id)}">Edit</button>` : ''}</div>
            </article>`).join('') : '<div class="cs-empty">Nothing here yet.</div>';
            q('#lib-grid').querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => ideaForm(d.ideas.find(x => x.id === b.dataset.edit))));
        }

        function ideaForm(i) {
            const dw = EL.drawer({
                title: i ? 'Edit the idea' : 'Add an idea', sub: 'Shared with the whole team', wide: true,
                body: `<div class="ws-form">
                    <div><label for="li-url">Link to the post</label><input id="li-url" placeholder="https://www.instagram.com/reel/…" value="${esc(i ? i.url || '' : '')}"></div>
                    <div class="ws-form two">
                        <div><label for="li-src">Seen at (brand or account)</label><input id="li-src" maxlength="120" value="${esc(i ? i.sourceName || '' : '')}"></div>
                        <div><label for="li-ind">Their industry</label><input id="li-ind" maxlength="80" placeholder="e.g. gym, skincare" value="${esc(i ? i.industry || '' : '')}"></div>
                    </div>
                    <div><label>Post type</label><div class="cs-chips" id="li-type">${TYPES.map(([k, n]) => `<button type="button" class="ld-st${(i ? i.postType : '') === k ? ' is-on' : ''}" data-t="${k}">${n}</button>`).join('')}</div>
                        <p class="ws-hint">Left blank, it is read from the link.</p></div>
                    <div><label for="li-hook">The hook</label><input id="li-hook" maxlength="300" value="${esc(i ? i.hook || '' : '')}"></div>
                    <div><label for="li-why">Why it worked</label><textarea id="li-why" rows="3" maxlength="600">${esc(i ? i.whyWorked || '' : '')}</textarea></div>
                    <div><label for="li-style">Style — how it is put together</label><textarea id="li-style" rows="2" maxlength="600">${esc(i ? i.style || '' : '')}</textarea></div>
                    <div class="ws-form two">
                        <div><label for="li-tools">Tools</label><input id="li-tools" placeholder="CapCut, Canva" value="${esc(i ? (i.tools || []).join(', ') : '')}"></div>
                        <div><label for="li-tags">Tags</label><input id="li-tags" placeholder="reviews, educational, price" value="${esc(i ? (i.tags || []).join(', ') : '')}"></div>
                    </div>
                    <p class="ws-hint">Tag with a category (service, educational, reviews, generic, collab) and a few words; that is how ideas find topics.</p>
                    <div class="ws-note" id="li-note"></div></div>`,
                foot: `${i ? '<button class="ws-btn is-danger is-sm" type="button" id="li-del">Remove</button><span class="cs-grow"></span>' : ''}<button class="ws-btn is-quiet" type="button" data-dw-close>Close</button><button class="ws-btn is-gold" type="button" id="li-save">Save</button>`
            });
            let type = i ? i.postType : '';
            dw.el.querySelectorAll('[data-t]').forEach(b => b.addEventListener('click', () => {
                type = type === b.dataset.t ? '' : b.dataset.t;
                dw.el.querySelectorAll('[data-t]').forEach(x => x.classList.toggle('is-on', x.dataset.t === type));
            }));
            const v = s => dw.el.querySelector(s).value;
            dw.el.querySelector('#li-save').addEventListener('click', async () => {
                const body = { url: v('#li-url').trim() || null, sourceName: v('#li-src'), industry: v('#li-ind'), postType: type || undefined, hook: v('#li-hook'), whyWorked: v('#li-why'), style: v('#li-style'), tools: v('#li-tools'), tags: v('#li-tags') };
                try {
                    await EL.api(i ? `/api/content-ideas/${encodeURIComponent(i.id)}` : '/api/content-ideas', { method: i ? 'PATCH' : 'POST', body });
                    EL.closeDrawer(); EL.toast(i ? 'Saved.' : 'In the library.'); load();
                } catch (err) { note(dw.el.querySelector('#li-note'), err.message, 'bad'); }
            });
            const del = dw.el.querySelector('#li-del');
            if (del) del.addEventListener('click', async () => {
                if (!confirm('Remove this idea from the library for everyone?')) return;
                try { await EL.api(`/api/content-ideas/${encodeURIComponent(i.id)}`, { method: 'DELETE' }); EL.closeDrawer(); load(); }
                catch (err) { note(dw.el.querySelector('#li-note'), err.message, 'bad'); }
            });
        }

        function importForm() {
            const dw = EL.drawer({
                title: 'Import a spreadsheet', sub: 'Your content journal, as CSV', wide: true,
                body: `<p class="ws-hint">In Google Sheets or Excel: File → Download → CSV, then choose the file, or copy the cells and paste them here. The first row must be the column names. Columns are matched by name — link, brand or account, type or format, hook or idea, why or notes, style, tools, tags or topic, industry — and anything else is ignored. Links already in the library are skipped.</p>
                    <div class="ws-form">
                        <div><label for="im-file">CSV file</label><input id="im-file" type="file" accept=".csv,text/csv,text/plain"></div>
                        <div><label for="im-text">Or paste</label><textarea id="im-text" rows="8" placeholder="Link,Brand,Type,Hook,Why it worked,Tools,Tags"></textarea></div>
                    </div>
                    <div id="im-check"></div><div class="ws-note" id="im-note"></div>`,
                foot: `<button class="ws-btn is-quiet" type="button" data-dw-close>Close</button><button class="ws-btn" type="button" id="im-dry">Check</button><button class="ws-btn is-gold" type="button" id="im-go" disabled>Import</button>`
            });
            const box = dw.el.querySelector('#im-text');
            dw.el.querySelector('#im-file').addEventListener('change', async e => {
                const file = e.target.files && e.target.files[0]; if (!file) return;
                box.value = await file.text();
            });
            const send = async dryRun => {
                const csv = box.value;
                return EL.api('/api/content-ideas/import', { method: 'POST', body: { csv, dryRun } });
            };
            dw.el.querySelector('#im-dry').addEventListener('click', async () => {
                try {
                    const r = await send(true);
                    const names = { url: 'Link', source_name: 'Seen at', industry: 'Industry', post_type: 'Post type', hook: 'Hook', why_worked: 'Why it worked', style: 'Style', tools: 'Tools', tags: 'Tags' };
                    dw.el.querySelector('#im-check').innerHTML = `<section class="ld-sec"><h3 class="ld-h">What will come in</h3>
                        <p class="ld-line"><b>${r.would}</b> new idea(s)${r.dupes ? ` · ${r.dupes} already in the library` : ''}${r.skipped ? ` · ${r.skipped} row(s) with no link or hook` : ''}</p>
                        <p class="ld-line">${Object.entries(r.mapped).map(([k, h]) => `${esc(names[k] || k)} ← “${esc(h)}”`).join(' · ')}</p>
                        ${r.sample.map(i => `<p class="ld-line">${typeChip(i.postType)} ${esc(i.hook || i.url || '')}</p>`).join('')}</section>`;
                    dw.el.querySelector('#im-go').disabled = !r.would;
                    note(dw.el.querySelector('#im-note'), '');
                } catch (err) { note(dw.el.querySelector('#im-note'), err.message, 'bad'); }
            });
            dw.el.querySelector('#im-go').addEventListener('click', async () => {
                try { const r = await send(false); EL.closeDrawer(); EL.toast(`${r.added} idea(s) added.`); load(); }
                catch (err) { note(dw.el.querySelector('#im-note'), err.message, 'bad'); }
            });
        }

        q('#lib-add').addEventListener('click', () => ideaForm(null));
        q('#lib-import').addEventListener('click', importForm);
        q('#lib-types').querySelectorAll('[data-type]').forEach(b => b.addEventListener('click', () => {
            f.type = b.dataset.type;
            q('#lib-types').querySelectorAll('[data-type]').forEach(x => x.classList.toggle('is-on', x === b));
            load();
        }));
        q('#lib-mine').addEventListener('click', () => { f.mine = !f.mine; q('#lib-mine').classList.toggle('is-on', f.mine); load(); });
        let t = null;
        q('#lib-q').addEventListener('input', e => { clearTimeout(t); t = setTimeout(() => { f.q = e.target.value.trim(); load(); }, 250); });
        await load();
    }

    window.CSPlan = { mount: mountPlan };
    window.CSLib = { mount: mountLib };
})();
