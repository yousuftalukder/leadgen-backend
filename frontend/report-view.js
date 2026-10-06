/* =========================================================================
   EDGELEAD — THE REPORT A CLIENT READS  (phase 34)
   -------------------------------------------------------------------------
   One renderer for the three places a client's report is read: the staff
   page (monthly.html), the owner's portal (client.html) and a share link
   (share.html), and so for the printed copy too. The words and every
   number come from the server (monthlyView, clientReportView); this lays
   them out in the order an agency sends them and computes nothing.

   Load after header.js. Styles are the rp-* rules in app.css (rule 17).

   API (window.ELReport):
     ELReport.document(doc, opts) -> HTML for a server-built document
                                     (phase 36: Instagram audit, competitor
                                     intel; any report whose view carries doc)
     ELReport.hydrate(host)       -> image fallbacks after the HTML is in place
     ELReport.owner(r, opts)      -> HTML for any report in the owner's view:
                                     the monthly document when r.month is set,
                                     otherwise the standard layout
     ELReport.monthly(view, opts) -> HTML for the monthly document
     ELReport.wire(host, view, opts)
                                  -> the staff-only "Add to tasks" buttons
   opts: { toolbar: html, clientName, tasks: { clientId, canEdit, byKey }, reportId }
   ========================================================================= */
(function () {
    'use strict';

    const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const ic = n => (window.EL && EL.icon ? EL.icon(n) : '');
    const fmt = v => (v === null || v === undefined || v === '' || !isFinite(v) ? '—' : Math.round(Number(v)).toLocaleString('en-US'));
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    /** '2026-08-20' or an ISO stamp -> 'Aug 20, 2026'. Always with the year: a report outlives the year it was made in. */
    const day = iso => {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
        return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : '';
    };
    const paras = t => String(t || '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
        .map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
    const STATUS_NAME = { todo: 'To do', doing: 'In progress', waiting: 'Waiting on client', done: 'Done' };
    const WHO = { client: 'You', agency: 'Our team' };
    const PRIORITY = { high: ['High', 'is-gold'], medium: ['Medium', ''], low: ['Low', ''] };

    /** Numbered sections, counted as they are drawn, so a missing one leaves no gap. */
    function sections() {
        let n = 0;
        return (title, lead, body, cls = '') => `<section class="rp-sec ${cls}">
            <h2><span class="rp-n">${String(++n).padStart(2, '0')}</span>${esc(title)}</h2>
            ${lead ? `<p class="rp-lead">${lead}</p>` : ''}${body}</section>`;
    }

    // ---- the monthly document ----------------------------------------------
    function monthly(v, o = {}) {
        if (!v) return '';
        const ctx = v.context || {};
        const c = v.cover || {};
        const acc = c.account || {};
        const name = (ctx.client && ctx.client.name) || o.clientName || acc.pageName || (acc.igUsername ? '@' + acc.igUsername : 'Your business');
        const month = String(c.monthLabel || '').split(' ')[0] || 'This month';
        const prev = String(c.prevMonthLabel || '').split(' ')[0];
        const sec = sections();
        const accounts = [acc.igUsername ? `Instagram @${esc(acc.igUsername)}` : '', acc.pageName ? `Facebook ${esc(acc.pageName)}` : ''].filter(Boolean).join(' · ');
        const out = [];

        out.push(`<header class="rp-cover">
            <div class="el-eyebrow">Monthly report · ${esc(c.monthLabel || '')}</div>
            <h1>${esc(name)}</h1>
            <p class="rp-by">${[accounts, c.covers ? 'Covers ' + esc(c.covers) : '', c.builtAt ? 'Prepared by EdgeLead on ' + day(c.builtAt) : 'Prepared by EdgeLead'].filter(Boolean).join(' · ')}</p>
            <div class="ws-chips"><span class="el-chip is-jade">Owner data · Meta</span>${v.comparable && c.prevMonthLabel
                ? `<span class="el-chip">Compared with ${esc(c.prevMonthLabel)}</span>` : '<span class="el-chip is-warn">No earlier month to compare</span>'}${ctx.standing ? '<span class="el-chip">Public data, shown apart</span>' : ''}</div>
            ${o.toolbar ? `<div class="rp-toolbar no-print">${o.toolbar}</div>` : ''}
        </header>`);

        // 01 — the month in brief: three cards, the verdict, the summary.
        const cards = (v.brief || []).map(b => `<div class="rp-card ${b.tone ? 'is-' + b.tone : ''}">
            <span class="el-eyebrow">${esc(b.area)}</span><span class="rp-big">${esc(b.big)}</span><p>${esc(b.line)}</p></div>`).join('');
        if (cards || v.verdict || v.summary || v.narrative) {
            out.push(sec('The month in brief', '', `${cards ? `<div class="rp-cards">${cards}</div>` : ''}
                ${v.verdict ? `<p class="rp-verdict">${esc(v.verdict)}</p>` : ''}
                ${v.summary ? `<div class="rp-prose">${paras(v.summary)}</div>` : ''}
                ${v.narrative ? `<p class="rp-note">${esc(v.narrative)} Every number in this report is still exact.</p>` : ''}`));
        }

        // Facebook and Instagram side by side (phase 38).
        const pf = v.platforms;
        if (pf && (pf.rows || []).length) {
            out.push(sec('Performance summary', 'Facebook and Instagram side by side. A dash means Meta gives no such figure for that platform.',
                block({ type: 'row', blocks: [
                    { type: 'table', cols: [{ label: 'Measure' }, { label: 'Facebook', num: true }, { label: 'Instagram', num: true }, { label: 'Both', num: true }],
                      rows: pf.rows.map(r => [r.label, fmt(r.fb), fmt(r.ig), r.both === null ? '—' : { text: fmt(r.both), tone: '' }]) },
                    pf.followers && (pf.followers.fb !== null || pf.followers.ig !== null) ? { type: 'bars', title: 'Followers now', rows: [
                        pf.followers.fb !== null ? { label: 'Facebook', value: pf.followers.fb, tone: 'muted' } : null,
                        pf.followers.ig !== null ? { label: 'Instagram', value: pf.followers.ig, tone: 'good' } : null].filter(Boolean) } : null
                ].filter(Boolean) })));
        }

        // 02 — the scorecard, Instagram and Facebook as two groups.
        const rows = v.scorecard || [];
        if (rows.length) {
            const group = p => {
                const list = rows.filter(r => r.platform === p);
                return list.length ? `<tr class="rp-group"><th colspan="5">${p}</th></tr>` + list.map(r => `<tr>
                    <td class="t">${esc(r.label)}</td>
                    <td class="num now">${fmt(r.now)}</td>
                    <td class="num before">${v.comparable ? fmt(r.before) : '—'}</td>
                    <td class="num ws-nowrap">${esc(r.change)}</td>
                    <td><span class="el-chip ${r.status && r.status.tone ? 'is-' + r.status.tone : ''}">${esc(r.status ? r.status.word : '')}</span></td></tr>`).join('') : '';
            };
            out.push(sec('Scorecard',
                v.comparable && prev ? `${esc(month)} against ${esc(prev)}. Every figure is ${esc(name)}’s own Meta Insights. “Growing” is up 10% or more, “Watch” is down 10% or more, and a measure under 50 both months is too small to call.`
                    : `${esc(month)} on its own: there is no earlier month to compare with.`,
                `<div class="ws-table-wrap"><table class="ws-table rp-table"><thead><tr><th>Measure</th><th class="num">${esc(month)}</th>
                    <th class="num before">${esc(prev || 'Before')}</th><th class="num">Change</th><th>Status</th></tr></thead>
                    <tbody>${group('Instagram')}${group('Facebook')}</tbody></table></div>`));
        }

        // Five months of their own daily numbers (phase 38).
        const tr = ctx.trends;
        if (tr && tr.labels) {
            const two = (a, b) => [a.some(x => x !== null) ? { name: 'Instagram', values: a.map(x => x || 0) } : null, b.some(x => x !== null) ? { name: 'Facebook', values: b.map(x => x || 0) } : null].filter(Boolean);
            const reach = two(tr.reach.ig, tr.reach.fb), follows = two(tr.follows.ig, tr.follows.fb);
            if (reach.length || follows.length) out.push(sec('The longer view', 'From the numbers read every day since the account was connected. Months before the connection show as zero.',
                block({ type: 'row', blocks: [follows.length ? { type: 'line', title: 'New followers a month', labels: tr.labels, series: follows } : null, reach.length ? { type: 'line', title: 'People reached a month', labels: tr.labels, series: reach } : null].filter(Boolean) })));
        }

        // 03 — what worked: the narrative's two lists, the best posts, the formats.
        const posting = v.posting || {};
        const list = (items, cls) => items.length ? `<ul class="rp-list ${cls}">${items.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="el-muted">Nothing stood out.</p>';
        const worked = v.worked || [], didNot = v.didNot || [], posts = v.posts || [];
        if (worked.length || didNot.length || posts.length || posting.count) {
            out.push(sec(`Your content in ${month}`, '', `${worked.length || didNot.length ? `<div class="rp-two">
                    <div class="rp-col is-good"><h3 class="rp-h3">What worked</h3>${list(worked, 'is-good')}</div>
                    <div class="rp-col is-watch"><h3 class="rp-h3">What did not</h3>${list(didNot, 'is-watch')}</div></div>` : ''}
                ${posts.length ? `<h3 class="rp-h3">Your best posts in ${esc(month)}, by people reached</h3>
                    ${block({ type: 'posts', items: posts.map(p => ({ kind: p.kind, title: p.caption || 'No caption', image: p.image || null, link: p.link, date: day(p.date),
                        meta: [p.reach != null ? `${fmt(p.reach)} reached` : null, p.saved != null ? `${fmt(p.saved)} saves` : null, p.shares != null ? `${fmt(p.shares)} shares` : null, p.views ? `${fmt(p.views)} views` : null].filter(Boolean).join(' · ') })) })}` : ''}
                <p class="rp-note">${posting.count ? `${fmt(posting.count)} post${posting.count === 1 ? '' : 's'} published in ${esc(month)}.` : `Nothing was published in ${esc(month)}.`}
                    ${posting.formatLine ? esc(posting.formatLine) : ''} ${posting.formatLine ? 'Medians, so one unusual post does not redraw the picture.' : ''}</p>`));
        }

        // 04 — who they reach.
        const aud = v.audience || {};
        if ((aud.groups || []).length) {
            out.push(sec('Who you reach', aud.line ? esc(aud.line) : '', `<div class="rp-demo">${aud.groups.map(g => `<div>
                    <h3 class="rp-h3">${esc(g.title)}</h3>${g.rows.map(r => `<div class="rp-bar"><span class="lab">${esc(r.label)}</span>
                        <span class="pc">${r.share === null ? '—' : esc(r.share) + '%'}</span>
                        <span class="track"><i style="width:${Math.max(0, Math.min(100, Number(r.share) || 0))}%"></i></span></div>`).join('')}</div>`).join('')}</div>
                ${aud.note ? `<p class="rp-note">${esc(aud.note)}</p>` : ''}
                <p class="rp-src">Shares of the followers Meta could classify, from Meta’s follower demographics.</p>`));
        }

        // 05 — where they stand, from public data, kept apart.
        const st = ctx.standing;
        if (st) {
            out.push(sec('Against similar businesses',
                `From the ${esc(st.title)} on ${day(st.date)}. This is public data, what anyone can see on these accounts, and it is kept apart from your own numbers above.`,
                `<div class="rp-standing"><p class="rp-verdict">${esc(st.verdict)}</p>${st.gap ? `<p>${esc(st.gap)}</p>` : ''}
                    ${(st.peers || []).length ? `<ol class="rp-ranks">${st.peers.map(p => `<li class="${p.is_you ? 'is-you' : ''}"><span>#${esc(p.position)}</span><b>${esc(p.name)}</b></li>`).join('')}</ol>` : ''}</div>`));
        }

        // 06 — what the agency did that month.
        const work = ctx.work || {}, leads = ctx.leads;
        const workRows = [
            ...(work.done || []).map(t => [ic('check'), t.title, 'Done ' + day(t.date)]),
            ...(work.filed || []).map(f => [ic('doc'), f.title, 'Delivered ' + day(f.date)]),
            ...(leads && leads.thisMonth ? [[ic('target'), `${fmt(leads.thisMonth)} new lead${leads.thisMonth === 1 ? '' : 's'} found for you`, `${fmt(leads.toDate)} found to date`]] : [])
        ];
        if (workRows.length) {
            out.push(sec(`What we did in ${month}`, '', `<div class="ws-rows rp-work">${workRows.map(([i, t, m]) =>
                `<div class="ws-row"><span class="rp-ic">${i}</span><div class="ws-grow"><div class="ws-t">${esc(t)}</div><div class="ws-m">${esc(m)}</div></div></div>`).join('')}</div>`));
        }

        // 07 — recommendations: a table when the report carries the detail, a list when it does not.
        const recs = v.recommendations || [];
        if (recs.length) {
            const tasks = o.tasks || null;
            const cell = r => {
                if (!tasks) return '';
                const t = (tasks.byKey || {})[r.key];
                if (t) return `<a class="ws-btn is-sm is-quiet" href="workspace.html?client=${encodeURIComponent(tasks.clientId)}&tab=tasks">${ic('check')}${esc(STATUS_NAME[t.status] || 'On the board')}</a>`;
                return tasks.canEdit ? `<button class="ws-btn is-sm" type="button" data-rec="${esc(r.key)}">${ic('plus')}Add to tasks</button>` : '';
            };
            const detailed = recs.some(r => r.why || r.expected || r.priority || r.who);
            const body = detailed
                ? `<div class="ws-table-wrap"><table class="ws-table rp-table rp-recs"><thead><tr><th>Priority</th><th>Action</th><th>Why</th><th>Expected result</th><th>Who</th>${tasks ? '<th class="no-print">Task</th>' : ''}</tr></thead>
                    <tbody>${recs.map(r => `<tr><td>${r.priority ? `<span class="el-chip ${PRIORITY[r.priority][1]}">${PRIORITY[r.priority][0]}</span>` : '—'}</td>
                        <td class="t">${esc(r.action)}</td><td>${esc(r.why || '—')}</td><td>${esc(r.expected || '—')}</td><td class="ws-nowrap">${esc(WHO[r.who] || '—')}</td>
                        ${tasks ? `<td class="ws-nowrap no-print" data-cell="${esc(r.key)}">${cell(r)}</td>` : ''}</tr>`).join('')}</tbody></table></div>`
                : `<ol class="rp-steps">${recs.map(r => `<li><span class="t">${esc(r.action)}</span>${tasks ? `<span class="no-print" data-cell="${esc(r.key)}">${cell(r)}</span>` : ''}</li>`).join('')}</ol>`;
            out.push(sec('What we recommend',
                detailed ? 'In order of priority. Expected results are estimates, not promises.' : 'For next month.',
                body + (tasks && tasks.canEdit ? '<p class="rp-src no-print">Adding one puts it on the client’s task board. One marked “You” becomes the owner’s to-do in their Edge Meta AI app.</p>' : '')));
        }

        // What was planned and how it did (phase 42): built on the server, drawn with the document blocks.
        if (Array.isArray(v.contentPlanBlocks) && v.contentPlanBlocks.length) {
            out.push(sec('What we planned, and how it did', 'The posts on this month’s content calendar.', v.contentPlanBlocks.filter(Boolean).map(block).join('')));
        }

        if (v.conclusion) out.push(sec('Conclusion', '', `<p class="rp-verdict">${esc(v.conclusion)}</p>`));

        // 08 — about this report.
        const ab = v.about || {};
        out.push(sec('About this report', '', `<div class="rp-about">
            <p>${esc(ab.source || '')}</p>
            ${st ? `<p>The comparison with similar businesses is public data from ${day(st.date)} and is never combined with your own numbers.</p>` : ''}
            ${(ab.gaps || []).length ? `<p><b>Not available for this account:</b> ${ab.gaps.map(esc).join(', ')}. Shown as “—”, never as zero.</p>` : ''}
            ${(ab.warnings || []).map(w => `<p>${esc(w)}</p>`).join('')}
            ${ab.caveats ? `<p>${esc(ab.caveats)}</p>` : ''}
            ${c.builtAt ? `<p>Built ${day(c.builtAt)}.</p>` : ''}</div>`, 'rp-last'));

        return `<article class="rp">${out.join('')}</article>`;
    }

    /** Staff only: put a recommendation on the client's board, once. */
    function wire(host, v, o = {}) {
        const tasks = o.tasks;
        if (!host || !tasks || !tasks.canEdit || !window.EL) return;
        host.querySelectorAll('[data-rec]').forEach(b => b.addEventListener('click', async () => {
            const r = (v.recommendations || []).find(x => x.key === b.dataset.rec);
            if (!r) return;
            b.disabled = true;
            try {
                const d = await EL.api(`/api/clients/${encodeURIComponent(tasks.clientId)}/tasks`, { method: 'POST', body: {
                    title: r.action,
                    notes: [r.why ? 'Why: ' + r.why : '', r.expected ? 'Expected: ' + r.expected : ''].filter(Boolean).join('\n') || undefined,
                    // The recommendation is already in the client's report, so
                    // the task is theirs to see; one marked for them is theirs to do.
                    visibleToClient: true,
                    assignee: r.who === 'client' ? 'client' : undefined,
                    source: { type: 'recommendation', id: o.reportId, key: r.key, label: `Monthly report · ${(v.cover && v.cover.monthLabel) || ''}`.trim() }
                } });
                tasks.byKey = tasks.byKey || {};
                tasks.byKey[r.key] = { id: d.task.id, status: d.task.status };
                const cellEl = host.querySelector(`[data-cell="${CSS.escape(r.key)}"]`);
                if (cellEl) cellEl.innerHTML = `<a class="ws-btn is-sm is-quiet" href="workspace.html?client=${encodeURIComponent(tasks.clientId)}&tab=tasks">${ic('check')}${esc(STATUS_NAME[d.task.status] || 'On the board')}</a>`;
                if (EL.toast) EL.toast(d.existing ? 'Already on the board.' : 'Added to the client’s task board.');
            } catch (err) {
                b.disabled = false;
                if (!err.handled && EL.toast) EL.toast(err.code === 'migration_required' ? 'Tasks are not switched on yet: the phase 32 SQL has not run.' : err.message, 'bad');
            }
        }));
    }

    // ---- every other report, in the owner's words ----------------------------
    function standard(r, o = {}) {
        if (!r) return '';
        const sec = sections();
        const out = [];
        const who = o.clientName || (r.handle ? '@' + String(r.handle).replace(/^@/, '') : '');
        out.push(`<header class="rp-cover">
            <div class="el-eyebrow">${esc(r.title || 'Report')}${r.date ? ' · ' + day(r.date) : ''}</div>
            <h1>${esc(r.headline || '')}</h1>
            <p class="rp-by">${[who ? esc(who) : '', r.posts_looked_at ? `Based on ${fmt(r.posts_looked_at)} recent posts` : '', r.grade ? 'Grade ' + esc(r.grade) : ''].filter(Boolean).join(' · ')}</p>
            ${o.toolbar ? `<div class="rp-toolbar no-print">${o.toolbar}</div>` : ''}
        </header>`);
        if (r.provisional && r.provisional_note) out.push(`<p class="rp-flag">${esc(r.provisional_note)}</p>`);

        const st = r.standing || {};
        if (st.verdict) {
            out.push(sec('Where you stand', '', `<div class="rp-standing"><p class="rp-verdict">${esc(st.verdict)}</p>${st.gap ? `<p>${esc(st.gap)}</p>` : ''}
                ${(st.peers || []).length ? `<ol class="rp-ranks">${st.peers.map(p => `<li class="${p.is_you ? 'is-you' : ''}"><span>#${esc(p.position)}</span><b>${esc(p.name)}</b></li>`).join('')}</ol>` : ''}</div>`));
        }
        if ((r.ideas || []).length) {
            out.push(sec('What to post next', 'Each one is written out: what to film, what to say, and what to put in the caption.', `<div class="rp-ideas">${r.ideas.map((i, n) => `<div class="rp-idea">
                <div class="rp-idea-top"><span class="rp-idea-n">${n + 1}</span><div><b>${esc(i.concept || i.hook || 'Post idea')}</b>
                    <div class="el-muted">${[i.format, i.when, i.outlook].filter(Boolean).map(esc).join(' · ')}</div></div></div>
                ${i.hook ? `<p class="rp-hook">“${esc(i.hook)}”</p>` : ''}
                ${(i.script || []).length ? `<ol class="rp-script">${i.script.map(s => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}
                ${i.shot ? `<p class="rp-meta"><b>On screen:</b> ${esc(i.shot)}</p>` : ''}
                ${i.caption ? `<p class="rp-meta"><b>Caption:</b> ${esc(i.caption)}</p>` : ''}
                ${i.boost ? `<p class="rp-meta"><b>${esc(i.boost)}</b>${i.boost_why ? ' — ' + esc(i.boost_why) : ''}</p>` : ''}</div>`).join('')}</div>`));
        }
        if ((r.rooms || []).length) {
            out.push(sec('Where your customers are talking', '', `<div class="ws-rows">${r.rooms.map(g => `<div class="ws-row"><span class="rp-ic">${ic('users')}</span>
                <div class="ws-grow"><div class="ws-t">${esc(g.name)}</div><div class="ws-m">${[g.members ? fmt(g.members) + ' members' : '', g.worth || ''].filter(Boolean).map(esc).join(' · ')}</div></div></div>`).join('')}</div>`));
        }
        const pts = (items, cls) => items.length ? `<ul class="rp-points">${items.map(p => `<li class="${cls}"><b>${esc(p.title)}</b>${p.why ? `<span>${esc(p.why)}</span>` : ''}</li>`).join('')}</ul>` : '<p class="el-muted">Nothing stood out here.</p>';
        if ((r.working || []).length || (r.fix || []).length) {
            out.push(sec('What is working, and what to change', '', `<div class="rp-two">
                <div class="rp-col is-good"><h3 class="rp-h3">What is working</h3>${pts(r.working || [], 'is-good')}</div>
                <div class="rp-col is-watch"><h3 class="rp-h3">What to change</h3>${pts(r.fix || [], 'is-watch')}</div></div>`));
        }
        const missing = (r.profile && r.profile.missing) || [];
        if (missing.length) {
            out.push(sec('Missing from your profile', 'Someone who likes a post and visits your profile should never have to search for how to reach you. These are quick to add.',
                `<ul class="rp-missing">${missing.map(m => `<li>${esc(m)}</li>`).join('')}</ul>`));
        }
        if (r.summary) out.push(sec('In summary', '', `<div class="rp-prose">${paras(r.summary)}</div>`, 'rp-last'));
        return `<article class="rp">${out.join('')}</article>`;
    }

    /** Whatever the owner opened: the monthly document, or the standard layout. */
    // ---- documents (phase 36) ---------------------------------------------------
    // The server decides what a report says (reportDoc); this draws the blocks.
    const SRC = { pub: ['Public data', 'rd-pub'], meta: ['Owner data · Meta', 'rd-meta'], ours: ['Our records', 'rd-ours'], ai: ['Written by AI from these numbers', 'rd-ai'] };
    const TONE = { good: 'is-good', watch: 'is-watch', bad: 'is-bad', gold: 'is-gold', muted: 'is-muted' };
    const cell = c => {
        if (c === null || c === undefined) return '—';
        if (typeof c !== 'object') return esc(c);
        if (c.chip) return `<span class="el-chip ${c.tone === 'good' ? 'is-jade' : c.tone === 'watch' ? 'is-warn' : c.tone === 'bad' ? 'is-bad' : c.tone === 'gold' ? 'is-gold' : ''}">${esc(c.chip)}</span>`;
        return `<span class="${TONE[c.tone] || ''}">${esc(c.text)}</span>`;
    };
    const barVal = (v, unit) => unit === 'x' ? `${Number(v).toFixed(1)}×` : unit === '%' ? `${+Number(v).toFixed(Math.abs(v) < 10 ? 2 : 1)}%` : fmt(v);
    const HOUR_BANDS = [[6, 9, '6a'], [9, 12, '9a'], [12, 15, '12p'], [15, 18, '3p'], [18, 21, '6p'], [21, 24, '9p']];
    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    function block(b) {
        switch (b.type) {
            case 'kpis': return `<div class="rd-kpis" style="--cols:${b.cols || Math.min(4, b.items.length)}">${b.items.map(k => `<div class="rd-kpi ${TONE[k.tone] || ''}"><span class="l">${esc(k.label)}</span><span class="v">${esc(k.value)}</span>${k.sub ? `<span class="s">${esc(k.sub)}</span>` : ''}</div>`).join('')}</div>`;
            case 'verdict': return `<p class="rp-verdict">${esc(b.text)}</p>`;
            case 'prose': return `<div class="rp-prose">${(b.paras || []).map(p => `<p>${esc(p)}</p>`).join('')}</div>`;
            case 'note': return `<p class="rp-src">${esc(b.text)}</p>`;
            case 'table': return `${b.title ? `<h3 class="rp-h3">${esc(b.title)}</h3>` : ''}<div class="ws-table-wrap"><table class="ws-table rp-table"><thead><tr>${b.cols.map(c => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead>
                <tbody>${b.rows.map((r, i) => `<tr class="${i === b.highlight ? 'rd-you' : ''}">${r.map((c, j) => `<td class="${b.cols[j] && b.cols[j].num ? 'num' : ''}">${cell(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${b.note ? `<p class="rp-src">${esc(b.note)}</p>` : ''}`;
            case 'bars': {
                const max = b.max || Math.max(...b.rows.map(r => Number(r.value) || 0)) * 1.15 || 1;
                return `<div class="rd-box">${b.title ? `<h3 class="rp-h3">${esc(b.title)}</h3>` : ''}<div class="rd-bars">${b.rows.map(r => `<div class="rd-bar ${TONE[r.tone] || ''}"><span class="lab">${esc(r.label)}</span><span class="val">${barVal(r.value, b.unit)}</span><span class="track"><i style="width:${Math.max(2, Math.min(100, (Number(r.value) || 0) / max * 100))}%"></i></span></div>`).join('')}</div></div>`;
            }
            case 'posts': return `<div class="rd-posts">${b.items.filter(Boolean).map(pc => `<figure class="rd-post ${pc.weak ? 'is-weak' : ''}">
                <div class="rd-img" data-kind="${esc(pc.kind)}">${pc.image ? `<img src="${esc(pc.image)}" alt="${esc(pc.title)}" loading="lazy">` : ''}<span>${esc(pc.by ? pc.by + ' · ' : '')}${esc(pc.kind)}</span></div>
                <figcaption><b>${esc(pc.title)}</b><span class="m">${esc([pc.date, pc.meta].filter(Boolean).join(' · '))}</span>
                ${pc.chip ? `<span class="el-chip ${pc.chip.tone === 'good' ? 'is-jade' : pc.chip.tone === 'bad' ? 'is-bad' : ''}">${esc(pc.chip.text)}</span>` : ''}${pc.link ? ` <a class="rd-link" href="${esc(pc.link)}" target="_blank" rel="noopener noreferrer">Open the post</a>` : ''}</figcaption></figure>`).join('')}</div>`;
            case 'quotes': return `<div class="rd-quotes">${b.items.map(q => `<figure class="rd-quote"><span class="el-chip">${esc(q.tag)}</span><blockquote>${esc(q.text)}</blockquote>
                <figcaption><span class="m">${esc(q.meta || '')}</span>${q.chip ? ` <span class="el-chip ${q.chip.tone === 'good' ? 'is-jade' : ''}">${esc(q.chip.text)}</span>` : ''}${q.link ? ` <a class="rd-link" href="${esc(q.link)}" target="_blank" rel="noopener noreferrer">Open the post</a>` : ''}</figcaption></figure>`).join('')}</div>`;
            case 'points': return `<div class="rp-col ${b.tone === 'good' ? 'is-good' : b.tone === 'watch' ? 'is-watch' : ''}">${b.title ? `<h3 class="rp-h3">${esc(b.title)}</h3>` : ''}<ol class="rd-points">${b.items.map(it => `<li><b>${esc(it.title)}</b>${it.text ? `<span>${esc(it.text)}</span>` : ''}</li>`).join('')}</ol></div>`;
            case 'weeks': return `<div class="rd-weeks">${b.items.map(w => `<div class="rd-week"><span class="w">${esc(w.week)}</span><ul>${w.actions.map(a => `<li>${esc(a)}</li>`).join('')}</ul></div>`).join('')}</div>`;
            case 'checks': return `<div class="rd-box">${b.title ? `<h3 class="rp-h3">${esc(b.title)}</h3>` : ''}<ul class="rd-checks">${b.items.map(c => `<li class="${c.ok ? 'ok' : 'no'}">${esc(c.label)}</li>`).join('')}</ul></div>`;
            case 'heat': {
                const grid = {}; let max = 0;
                for (const c of b.cells || []) {
                    const band = HOUR_BANDS.findIndex(([a, z]) => c.hour >= a && c.hour < z); if (band < 0) continue;
                    const k = c.dow + ':' + band; const g = grid[k] = grid[k] || { sum: 0, n: 0 };
                    g.sum += (Number(c.value) || 0) * (c.posts || 1); g.n += (c.posts || 1);
                }
                for (const g of Object.values(grid)) { g.v = g.sum / g.n; max = Math.max(max, g.v); }
                const order = [1, 2, 3, 4, 5, 6, 0];
                return `<div class="rd-box">${b.title ? `<h3 class="rp-h3">${esc(b.title)}</h3>` : ''}<div class="rd-heat"><span></span>${HOUR_BANDS.map(h => `<span class="h">${h[2]}</span>`).join('')}
                    ${order.map(d => `<span class="d">${DAYS[d]}</span>${HOUR_BANDS.map((_, bi) => { const g = grid[d + ':' + bi]; return `<i style="--a:${g && max ? (0.12 + 0.88 * g.v / max).toFixed(2) : 0.04}" title="${g ? g.n + ' posts' : 'no posts'}"></i>`; }).join('')}`).join('')}</div>${b.note ? `<p class="rp-src">${esc(b.note)}</p>` : ''}</div>`;
            }
            case 'line': {
                const W = 520, H = 170, L = 44, R = 14, T = 12, B = 26;
                const vals = b.series.flatMap(x => x.values.map(Number));
                const max = Math.max(1, ...vals) * 1.1;
                const x = i => L + (b.labels.length < 2 ? 0 : i * (W - L - R) / (b.labels.length - 1)), y = v => T + (H - T - B) * (1 - v / max);
                const cls = ['rd-s1', 'rd-s2', 'rd-s3'];
                return `<div class="rd-box">${b.title ? `<h3 class="rp-h3">${esc(b.title)}</h3>` : ''}<svg class="rd-line" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(b.title || 'trend')}">
                    ${[0, max / 2, max].map(t => `<line class="g" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="t" x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${fmt(t)}</text>`).join('')}
                    ${b.labels.map((l, i) => `<text class="t" x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(l)}</text>`).join('')}
                    ${b.series.map((sr, si) => `<polyline class="${cls[si % 3]}" fill="none" points="${sr.values.map((v, i) => `${x(i)},${y(Number(v) || 0)}`).join(' ')}"/><circle class="${cls[si % 3]} dot" cx="${x(sr.values.length - 1)}" cy="${y(Number(sr.values[sr.values.length - 1]) || 0)}" r="4"/>`).join('')}
                </svg>${b.series.length > 1 ? `<p class="rp-src">${b.series.map((sr, si) => `<span class="rd-key ${cls[si % 3]}"></span>${esc(sr.name)}`).join(' &nbsp; ')}</p>` : ''}</div>`;
            }
            case 'row': return `<div class="rd-row" style="--cols:${b.blocks.length}">${b.blocks.map(x => `<div class="rd-cell">${block(x)}</div>`).join('')}</div>`;
            case 'missing': return `<div class="rd-missing"><b>${esc(b.title)}</b><span>${esc(b.text)}</span></div>`;
            default: return '';
        }
    }

    function documentHtml(doc, o = {}) {
        if (!doc) return '';
        const c = doc.cover || {};
        const sec = sections();
        return `<article class="rp">
            <header class="rp-cover">
                <div class="el-eyebrow">${esc(c.kind || '')}</div>
                <h1>${esc(c.title || '')}</h1>
                ${c.sub ? `<p class="rp-by">${esc(c.sub)}</p>` : ''}
                ${(c.receipt || []).length ? `<div class="rd-receipt">${c.receipt.map(r => `<div><b>${esc(r[0])}</b><small>${esc(r[1])}</small></div>`).join('')}</div>` : ''}
                <p class="rp-by">Prepared by EdgeLead${c.builtAt ? ' on ' + day(c.builtAt) : ''}</p>
                ${o.toolbar ? `<div class="rp-toolbar no-print">${o.toolbar}</div>` : ''}
            </header>
            ${doc.sections.map(s => sec(s.title, s.lead ? esc(s.lead) : '', `<div class="rd-srcs">${(s.source || []).map(k => SRC[k] ? `<span class="rd-src ${SRC[k][1]}">${SRC[k][0]}</span>` : '').join('')}</div>${s.blocks.map(block).join('')}`)).join('')}
            ${(doc.about || []).length ? sec('About this report', '', `<div class="rp-about">${doc.about.map(t => `<p>${esc(t)}</p>`).join('')}</div>`, 'rp-last') : ''}
        </article>`;
    }

    /** A stored photo that fails to load falls back to its labelled panel. */
    function hydrate(host) {
        if (!host) return;
        host.querySelectorAll('.rd-img img').forEach(img => img.addEventListener('error', () => img.remove(), { once: true }));
    }

    function owner(r, o = {}) {
        if (r && r.month) return monthly(r.month, o);
        if (r && r.doc) return documentHtml(r.doc, o);
        return standard(r, o);
    }

    window.ELReport = { owner, monthly, standard, wire, day, document: documentHtml, hydrate };
})();
