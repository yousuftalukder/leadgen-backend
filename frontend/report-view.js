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

        // 03 — what worked: the narrative's two lists, the best posts, the formats.
        const posting = v.posting || {};
        const list = (items, cls) => items.length ? `<ul class="rp-list ${cls}">${items.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="el-muted">Nothing stood out.</p>';
        const worked = v.worked || [], didNot = v.didNot || [], posts = v.posts || [];
        if (worked.length || didNot.length || posts.length || posting.count) {
            out.push(sec(`Your content in ${month}`, '', `${worked.length || didNot.length ? `<div class="rp-two">
                    <div class="rp-col is-good"><h3 class="rp-h3">What worked</h3>${list(worked, 'is-good')}</div>
                    <div class="rp-col is-watch"><h3 class="rp-h3">What did not</h3>${list(didNot, 'is-watch')}</div></div>` : ''}
                ${posts.length ? `<h3 class="rp-h3">Your best posts in ${esc(month)}</h3>
                    <div class="ws-table-wrap"><table class="ws-table rp-table rp-posts"><thead><tr><th>Post</th><th>Type</th><th class="num">Reached</th><th class="num">Saves</th><th class="num">Shares</th></tr></thead>
                    <tbody>${posts.map(p => `<tr><td><div class="t">${p.caption ? esc(p.caption) : '<span class="el-muted">No caption</span>'}</div>
                        <div class="s">${[day(p.date), p.link ? `<a href="${esc(p.link)}" target="_blank" rel="noopener noreferrer">Open the post</a>` : ''].filter(Boolean).join(' · ')}</div></td>
                        <td>${esc(p.kind)}</td><td class="num">${fmt(p.reach)}</td><td class="num">${fmt(p.saved)}</td><td class="num">${fmt(p.shares)}</td></tr>`).join('')}</tbody></table></div>` : ''}
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
                body + (tasks && tasks.canEdit ? '<p class="rp-src no-print">Adding one puts it on the client’s task board. One marked “You” becomes the client’s to-do in their portal.</p>' : '')));
        }

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
    function owner(r, o = {}) {
        if (r && r.month) return monthly(r.month, o);
        return standard(r, o);
    }

    window.ELReport = { owner, monthly, standard, wire, day };
})();
