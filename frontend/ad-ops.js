/**
 * EDGELEAD :: RUNNING A CLIENT'S ADS  (phase 87)
 * ---------------------------------------------------------------------------
 * Two tabs on a client's page, and the settings behind them. Load after
 * header.js and ui.js.
 *
 *   AdOps.checkin(host, ctx)    the ads check-in: per ad and ad set the chain
 *                               of eight steps with the first broken one
 *                               flagged, the whole business day by day,
 *                               stock, budget, forecast, account health,
 *                               decisions to grade, and the lessons library
 *   AdOps.orders(host, ctx)     the orders log, and "Delivery & costs"
 *   AdOps.economicsForm(ctx, onSaved)   the delivery and cost settings alone
 *
 *   ctx = { clientId, clientName, resultsPage }
 *
 * The check-in is written to be read top to bottom by a person or by Claude in
 * a browser: each part is a section with an id (#ci-broken, #ci-ads, #ci-adsets,
 * #ci-business, #ci-stock, #ci-budget, #ci-forecast, #ci-unplanned,
 * #ci-health, #ci-decisions, #ci-econ, #ci-lessons, #ci-gaps), and "Copy as
 * text" gives it as one block. The same figures are at
 * GET /api/clients/:id/ad-checkin as JSON. Nothing here writes to Meta.
 * ---------------------------------------------------------------------------
 */
(function () {
    'use strict';
    const esc = v => EL.esc(v);
    const ic = n => EL.icon(n);
    const base = id => `/api/clients/${encodeURIComponent(id)}`;

    const SYM = { BDT: '৳', USD: '$', EUR: '€', GBP: '£', INR: '₹' };
    const has = v => v !== null && v !== undefined && v !== '';
    const num = v => (has(v) ? Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—');
    const money = (v, cur = 'BDT') => (has(v) ? `${SYM[cur] || (cur ? cur + ' ' : '')}${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '—');
    const pct = v => (has(v) ? `${v}%` : '—');
    const times = v => (has(v) ? `${v}×` : '—');
    const day = v => (v ? UI.day(v) : '—');
    const isoToday = () => new Date().toISOString().slice(0, 10);
    const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
    const migrationNote = err => (err && err.code === 'migration_required'
        ? `<div class="ws-empty">${ic('alert')}<h3>One database update first</h3><p>${esc(err.message)}</p></div>` : null);
    const failBox = err => migrationNote(err) || `<div class="ws-empty">${ic('alert')}<p>${esc(err.message)}</p></div>`;
    const table = (head, rows, empty, cls = '') => (rows.length
        ? `<div class="ws-table-wrap"><table class="ws-table ao-table ${cls}"><thead><tr>${head.map(h => `<th${h.n ? ' class="ws-num"' : ''}>${esc(h.l || h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr${r.attrs || ''}>${(r.cells || r).map((c, i) => `<td${head[i] && head[i].n ? ' class="ws-num"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
        : `<p class="el-muted">${empty}</p>`);
    const section = (sid, title, sub, inner, actions = '') => `<section class="ws-card" id="${sid}"><div class="ws-card-h"><h2>${title}</h2>${actions}</div>${sub ? `<p class="el-muted ao-sub">${sub}</p>` : ''}${inner}</section>`;
    const kpi = (l, v, d) => `<div class="ws-kpi"><span class="l">${esc(l)}</span><span class="v">${v}</span>${d ? `<span class="d">${d}</span>` : ''}</div>`;

    const STEP_NAMES = ['Delivering', 'Cost to reach (CPM)', 'Stop-scroll', 'Watch-through', 'Cost per message', 'Chats → orders', 'Cost per order', 'Fatigue'];
    const STATE = { ok: 'ok', broken: 'broken', too_early: 'too early', unknown: 'not known' };
    const SCOPES = [['account', 'The whole account'], ['campaign', 'A campaign'], ['adset', 'An ad set'], ['ad', 'An ad']];
    const METRICS = [['cpm', 'CPM'], ['stop_scroll', 'Stop-scroll'], ['watch_through', 'Watch-through'], ['ctr', 'CTR'], ['cost_per_message', 'Cost per message'],
        ['chat_to_order', 'Chats → orders'], ['cost_per_order', 'Cost per order'], ['frequency', 'Frequency'], ['spend', 'Spend'], ['orders', 'Orders'], ['other', 'Other']];
    const OUTCOMES = [['right', 'Right'], ['wrong', 'Wrong'], ['too_early', 'Too early']];
    const IDEA_TYPES = [['opening', 'Opening (first seconds)'], ['angle', 'Angle'], ['offer', 'Offer'], ['audience', 'Audience'], ['format', 'Format'],
        ['budget', 'Budget'], ['inbox', 'Inbox / replies'], ['product', 'Product'], ['other', 'Other']];
    const CHANNELS = [['messenger', 'Messenger'], ['whatsapp', 'WhatsApp'], ['instagram_dm', 'Instagram DM'], ['website', 'Website'], ['phone', 'Phone'], ['walk_in', 'Walk-in'], ['other', 'Other']];
    const SOURCES = [['ad', 'An ad'], ['organic', 'Organic (no ad)'], ['repeat', 'Repeat buyer'], ['unknown', 'Not known']];
    const ORDER_STATUS = [['confirmed', 'Confirmed'], ['shipped', 'Shipped'], ['delivered', 'Delivered'], ['failed', 'Failed'], ['returned', 'Returned'], ['cancelled', 'Cancelled']];
    const STATUS_CHIP = { confirmed: '', shipped: 'is-gold', delivered: 'is-jade', failed: 'is-bad', returned: 'is-bad', cancelled: '' };
    const label = (list, k) => ((list.find(x => x[0] === k) || [])[1] || k || '—');
    const opts = (list, val, blank = true) => `${blank ? '<option value=""></option>' : ''}${list.map(([k, l]) => `<option value="${esc(k)}" ${String(val ?? '') === String(k) ? 'selected' : ''}>${esc(l)}</option>`).join('')}`;
    const fld = (l, html, full, hint) => `<div class="${full ? 'wb-full' : ''}"><label>${esc(l)}</label>${html}${hint ? `<div class="ws-hint">${esc(hint)}</div>` : ''}</div>`;

    async function copy(text, what) {
        try { await navigator.clipboard.writeText(text); EL.toast(`Copied: ${what}.`); } catch { EL.toast('The browser would not copy here.', 'bad'); }
    }

    // =========================================================================
    // DELIVERY & COSTS
    // =========================================================================
    async function economicsForm(ctx, onSaved) {
        let E;
        try { E = await EL.api(`${base(ctx.clientId)}/economics`); } catch (err) { EL.toast(err.message, 'bad'); return; }
        const e = E.economics, dis = E.canEdit ? '' : 'disabled';
        const zone = (z = {}) => `<div class="ao-zone" data-zone>
            ${fld('Zone', `<input data-k="name" value="${esc(z.name || '')}" placeholder="Dhaka, Chattogram, other…" ${dis}>`)}
            ${fld('Customer pays', `<input data-k="charge" inputmode="decimal" value="${esc(z.charge ?? '')}" ${dis}>`)}
            ${fld('Courier costs us', `<input data-k="courier_cost" inputmode="decimal" value="${esc(z.courier_cost ?? '')}" ${dis}>`)}
            ${E.canEdit ? '<button type="button" class="ws-btn is-sm is-quiet" data-drop-zone>Remove</button>' : '<span></span>'}</div>`;
        const d = EL.drawer({
            wide: true, title: 'Delivery & costs', sub: esc(ctx.clientName),
            body: `<p class="el-muted">What an order costs beyond the product. Every product’s break-even ad cost per order comes from these (Ad ledger → Products, and the check-in). ${E.set ? '' : '<b>Not set yet: the defaults below are assumed.</b>'}</p>
                <h3 class="ab-h3">Delivery by zone</h3><div class="ao-zones" id="ao-zones">${(e.delivery_zones || []).map(zone).join('')}</div>
                ${E.canEdit ? '<button type="button" class="ws-btn is-sm" id="ao-add-zone">Add a zone</button>' : ''}
                <h3 class="ab-h3">Costs per order</h3>
                <div class="wb-fields" id="ao-econ">
                    ${fld('COD fee (% of the price)', `<input name="cod_fee_pct" inputmode="decimal" value="${esc(e.cod_fee_pct)}" ${dis}>`, false, 'The courier’s cash-on-delivery fee. About 1% in Bangladesh.')}
                    ${fld('Failed parcels (%)', `<input name="fail_rate_pct" inputmode="decimal" value="${esc(e.fail_rate_pct)}" ${dis}>`, false, 'Parcels refused or not delivered. Use 20 until the courier’s figure is known.')}
                    ${fld('Money lost per failed parcel', `<input name="fail_loss" inputmode="decimal" value="${esc(e.fail_loss)}" ${dis}>`, false, 'Delivery plus the return charge. About 120.')}
                    ${fld('Packing per order', `<input name="packing_cost" inputmode="decimal" value="${esc(e.packing_cost)}" ${dis}>`)}
                    ${fld('Notes', `<textarea name="notes" class="wb-area" ${dis}>${esc(e.notes || '')}</textarea>`, true)}
                </div>
                <h3 class="ab-h3">What each product can afford</h3>
                ${table(['Product', { l: 'Price', n: 1 }, { l: 'Buying', n: 1 }, { l: 'Margin', n: 1 }, { l: 'Break-even per order', n: 1 }, { l: 'With free delivery', n: 1 }, { l: 'Target per order', n: 1 }],
                    E.products.map(p => [`<span class="t">${esc(p.name)}</span>${p.combo ? `<div class="s">Combo: ${esc(p.parts.map(x => `${x.qty}× ${x.name}`).join(', '))}</div>` : ''}${p.missing.length ? `<div class="s">Missing ${esc(p.missing.join(', '))}</div>` : ''}`,
                        money(p.price), money(p.cost) + (p.cost_from === 'parts' ? '<div class="s">from parts</div>' : ''), money(p.margin),
                        p.break_even !== null ? `<span class="${p.loses_money ? 'wb-bad' : ''}">${money(p.break_even)}</span>` : '—',
                        p.free_delivery_break_even !== null ? `<span class="${p.free_delivery_loses ? 'wb-bad' : ''}">${money(p.free_delivery_break_even)}</span>` : '—',
                        money(p.target_cost_per_order)]), 'No products yet. Add them in the Ad ledger, under Products & stock.')}
                <p class="el-muted">Break-even = margin − COD fee − failed-parcel cost − packing − what you add to a zone’s courier cost. Free delivery also takes off the dearest zone’s courier cost. The target is half of break-even.</p>
                <div class="ws-note" id="ao-econ-note"></div>`,
            foot: `<span style="flex:1"></span><button class="ws-btn" type="button" data-dw-close>Close</button>${E.canEdit ? '<button class="ws-btn is-gold" type="button" id="ao-econ-save">Save</button>' : ''}`
        });
        UI.cards(d.el);
        const zones = d.el.querySelector('#ao-zones'), note = d.el.querySelector('#ao-econ-note');
        d.el.addEventListener('click', ev => { const b = ev.target.closest('[data-drop-zone]'); if (b) b.closest('[data-zone]').remove(); });
        const add = d.el.querySelector('#ao-add-zone');
        if (add) add.addEventListener('click', () => zones.insertAdjacentHTML('beforeend', zone()));
        const save = d.el.querySelector('#ao-econ-save');
        if (save) save.addEventListener('click', async () => {
            const body = { delivery_zones: [...zones.querySelectorAll('[data-zone]')].map(z => Object.fromEntries([...z.querySelectorAll('[data-k]')].map(i => [i.dataset.k, i.value.trim()]))).filter(z => z.name || z.charge || z.courier_cost) };
            d.el.querySelectorAll('#ao-econ [name]').forEach(i => { body[i.name] = i.value.trim(); });
            save.disabled = true; note.className = 'ws-note'; note.textContent = 'Saving…';
            try { await EL.api(`${base(ctx.clientId)}/economics`, { method: 'PUT', body }); EL.toast('Saved.'); d.close(); if (onSaved) onSaved(); }
            catch (err) { note.className = 'ws-note is-bad'; note.textContent = err.message; save.disabled = false; }
        });
    }

    // =========================================================================
    // THE DECISION LOG
    // =========================================================================
    function decisionForm(ctx, row, start, onSaved) {
        const r = row || start || {};
        const grading = !!row;
        const d = EL.drawer({
            wide: true, title: row ? 'Decision' : 'Log a decision', sub: esc(ctx.clientName),
            body: `<p class="el-muted">One change per ad set per check-in, so the next check shows what caused what. Write it so someone with no memory of today can grade it.</p>
                <div class="wb-fields" id="ao-dec">
                    ${fld('Date', `<input name="decided_on" type="date" value="${esc(r.decided_on || isoToday())}">`)}
                    ${fld('When we will know', `<input name="check_on" type="date" value="${esc(r.check_on || addDays(isoToday(), 3))}">`)}
                    ${fld('What it applies to', `<select name="scope">${opts(SCOPES, r.scope || 'account', false)}</select>`)}
                    ${fld('Meta id (optional)', `<input name="scope_id" value="${esc(r.scope_id || '')}" placeholder="the ad, ad set or campaign id">`)}
                    ${fld('Name', `<input name="scope_name" value="${esc(r.scope_name || '')}" placeholder="the ad or ad set as it is called">`, true)}
                    ${fld('What changed', `<textarea name="change" class="wb-area" placeholder="Paused the price-first cut; new problem-first opening on the same video">${esc(r.change || '')}</textarea>`, true)}
                    ${fld('Why: the step of the chain', `<select name="step">${opts(STEP_NAMES.map((n, i) => [String(i + 1), `${i + 1}. ${n}`]), r.step ? String(r.step) : '')}</select>`)}
                    ${fld('The number it should move', `<select name="metric">${opts(METRICS, r.metric)}</select>`)}
                    ${fld('Expected', `<input name="expected" value="${esc(r.expected || '')}" placeholder="stop-scroll from 14% to 22%+">`, true)}
                    ${grading ? `
                    ${fld('Outcome', `<select name="outcome">${opts(OUTCOMES, r.outcome)}</select>`)}
                    ${fld('Kind of idea', `<select name="idea_type">${opts(IDEA_TYPES, r.idea_type)}</select>`)}
                    ${fld('What happened', `<textarea name="outcome_note" class="wb-area" placeholder="The number it moved, with the comparison">${esc(r.outcome_note || '')}</textarea>`, true)}
                    ${fld('The idea, in a few words', `<input name="idea" value="${esc(r.idea || '')}" placeholder="problem-first opening">`, true)}
                    ${fld('The lesson', `<textarea name="lesson" class="wb-area" placeholder="About the idea, not the ad: “her face + price in the first second beats product close-ups”">${esc(r.lesson || '')}</textarea>`, true, 'Lessons are shared across the agency’s clients in the lessons library.')}` : ''}
                </div><div class="ws-note" id="ao-dec-note"></div>`,
            foot: `${row ? '<button class="ws-btn is-danger" type="button" id="ao-dec-del">Delete</button>' : ''}<span style="flex:1"></span><button class="ws-btn" type="button" data-dw-close>Cancel</button><button class="ws-btn is-gold" type="button" id="ao-dec-save">Save</button>`
        });
        const note = d.el.querySelector('#ao-dec-note');
        const failN = err => { note.className = 'ws-note is-bad'; note.textContent = err.message; };
        d.el.querySelector('#ao-dec-save').addEventListener('click', async ev => {
            const b = ev.currentTarget, body = {};
            d.el.querySelectorAll('#ao-dec [name]').forEach(i => { body[i.name] = i.value.trim() === '' ? null : i.value.trim(); });
            if (body.step) body.step = Number(body.step);
            b.disabled = true; note.className = 'ws-note'; note.textContent = 'Saving…';
            try {
                if (row) await EL.api(`${base(ctx.clientId)}/ad-decisions/${encodeURIComponent(row.id)}`, { method: 'PATCH', body });
                else await EL.api(`${base(ctx.clientId)}/ad-decisions`, { method: 'POST', body });
                EL.toast('Saved.'); d.close(); if (onSaved) onSaved();
            } catch (err) { failN(err); b.disabled = false; }
        });
        const del = d.el.querySelector('#ao-dec-del');
        if (del) del.addEventListener('click', async () => {
            if (del.dataset.sure !== '1') { del.dataset.sure = '1'; del.textContent = 'Delete — press again'; return; }
            del.disabled = true;
            try { await EL.api(`${base(ctx.clientId)}/ad-decisions/${encodeURIComponent(row.id)}`, { method: 'DELETE' }); d.close(); if (onSaved) onSaved(); }
            catch (err) { failN(err); del.disabled = false; }
        });
    }

    // =========================================================================
    // THE CHECK-IN
    // =========================================================================
    async function checkin(host, ctx) {
        const id = ctx.clientId;
        let period = { preset: '3', from: null, to: null };
        let D = null, DEC = null, LES = null, ideaFilter = '';
        const query = () => {
            const to = period.to || isoToday();
            const from = period.preset === 'custom' ? period.from : addDays(to, -(Number(period.preset) - 1));
            return `?from=${from}&to=${to}`;
        };
        async function load() {
            host.innerHTML = '<div class="ws-empty"><p>Reading the ads…</p></div>';
            try {
                [D, DEC] = await Promise.all([EL.api(`${base(id)}/ad-checkin${query()}`), EL.api(`${base(id)}/ad-decisions`)]);
                LES = await EL.api(`/api/ad-lessons?client=${encodeURIComponent(id)}${ideaFilter ? `&idea_type=${ideaFilter}` : ''}`).catch(() => ({ lessons: [] }));
            } catch (err) { host.innerHTML = failBox(err); return; }
            draw();
        }
        const cur = () => (D && D.currency) || 'BDT';

        // ---- parts ----
        const figs = (x, c) => `<div class="ao-figs">
            <div><span>Spent</span><b>${money(x.spend, c)}</b></div>
            <div><span>CPM</span><b>${money(x.cpm, c)}</b></div>
            <div><span>Stop-scroll</span><b>${pct(x.stop_scroll)}</b></div>
            <div><span>Watch-through</span><b>${pct(x.watch_through)}</b></div>
            <div><span>CTR</span><b>${pct(x.ctr)}</b></div>
            <div><span>Messages</span><b>${num(x.messages)}</b></div>
            <div><span>Cost / message</span><b>${money(x.cost_per_message, c)}</b></div>
            <div><span>Orders</span><b>${x.orders_from === 'log' ? num(x.orders) : num(x.meta_purchases)}</b><i>${x.orders_from === 'log' ? 'logged' : 'Meta'}</i></div>
            <div><span>Cost / order</span><b>${money(x.cost_per_order, c)}</b></div>
        </div>`;
        const chainPills = steps => `<ol class="ao-chain">${steps.map(s => `<li class="is-${esc(s.state)}" title="${esc(`${s.name}: ${STATE[s.state]}${has(s.value) ? ` · ${s.value}` : ''}${has(s.threshold) ? ` (limit ${s.threshold})` : ''}${s.why ? ' · ' + s.why : ''}`)}">${s.step}. ${esc(s.name)}</li>`).join('')}</ol>`;
        const fix = (f, c) => f ? `<div class="ao-fix"><b>Step ${f.step}, ${esc(f.name)}:</b> ${esc(fmtStep(f, c))}. ${esc(f.next_move)}</div>` : '';
        function fmtStep(s, c) {
            const isMoney = [2, 5, 7].includes(s.step), isPct = [3, 4, 6].includes(s.step);
            const f = v => (!has(v) ? '—' : isMoney ? money(v, c) : isPct ? `${v}%` : num(v));
            return `${f(s.value)} against ${s.step === 1 ? 'a running ad set' : `${[3, 4, 6].includes(s.step) ? 'at least' : 'at most'} ${f(s.threshold)}`}`;
        }

        function brokenPart() {
            const c = cur();
            const sets = D.adsets.filter(s => s.first_broken);
            const rows = [
                ...sets.map(s => `<li><b>Ad set ${esc(s.name || s.adset_id)}</b>: step ${s.first_broken.step}, ${esc(s.first_broken.name)} (${esc(fmtStep(s.first_broken, c))}). ${esc(s.first_broken.next_move)}</li>`),
                ...D.broken.map(b => `<li><b>${esc(b.name || b.ad_id)}</b>: step ${b.step}, ${esc(b.step_name)} (${esc(fmtStep({ ...b, step: b.step }, c))}). ${esc(b.next_move)}</li>`)
            ];
            return section('ci-broken', 'First broken steps', 'Stop at the first broken step: everything after it is a symptom. One change per ad set per check-in.',
                rows.length ? `<ul class="ao-list">${rows.join('')}</ul>` : '<p><span class="el-chip is-jade">Nothing broken in this period</span> <span class="el-muted">Steps marked “too early” or “not known” are listed on each ad.</span></p>');
        }

        function totalsPart() {
            const t = D.totals.period, b = D.business.period, c = cur();
            return `<div class="ao-kpis" id="ci-totals">
                ${kpi('Spent', money(t.spend, c))}${kpi('CPM', money(t.cpm, c))}${kpi('Stop-scroll', pct(t.stop_scroll))}${kpi('Watch-through', pct(t.watch_through))}
                ${kpi('Messages', num(t.messages), `${money(t.cost_per_message, c)} each`)}
                ${kpi('Orders from ads', t.orders_from === 'log' ? num(t.orders) : num(t.meta_purchases), t.orders_from === 'log' ? 'logged' : 'Meta purchases')}
                ${kpi('Cost per order', money(t.cost_per_order, c))}
                ${kpi('All orders', num(b.orders), `${num(b.delivered)} delivered`)}
                ${kpi('Delivered sales', money(b.delivered_value, c))}
                ${kpi('MER', times(b.mer), 'delivered sales ÷ ad spend')}
            </div>`;
        }

        function adsPart() {
            const c = cur();
            const live = D.ads.filter(a => !a.paused), idle = D.ads.filter(a => a.paused);
            const card = a => `<article class="ao-ad ${a.first_broken ? 'is-broken' : ''}">
                <div class="ao-ad-h"><b>${esc(a.name || a.ad_id)}</b><span class="s">${esc([a.adset, a.campaign].filter(Boolean).join(' · '))}${a.frequency_7d !== null ? ` · frequency ${num(a.frequency_7d)} (7 days)` : ''}</span></div>
                ${chainPills(a.chain)}${fix(a.first_broken, c)}
                ${figs(a.period, c)}
                <details class="wb-more"><summary>Life so far, the last 7 days, and what it sold</summary>
                    <p class="s">Last 7 days</p>${figs(a.week, c)}<p class="s">Life so far (up to ${LIFE} days)</p>${figs(a.life, c)}
                    ${a.sells.length ? `<p class="s">Sold (logged orders): ${esc(a.sells.map(s => `${s.units}× ${s.name}`).join(', '))}</p>` : ''}
                    <p class="s">Meta ad id ${esc(a.ad_id)}</p></details>
                ${D.canEdit ? `<div><button type="button" class="ws-btn is-sm" data-decide="${esc(a.ad_id)}">Log a decision</button></div>` : ''}
            </article>`;
            return section('ci-ads', 'Ads in the period', `Each ad’s chain, step by step, then its figures for ${esc(day(D.period.from))} to ${esc(day(D.period.to))}. Red is broken; dashed is too early to judge.`,
                `${live.length ? `<div class="ao-ads">${live.map(card).join('')}</div>` : '<p class="el-muted">No ad spent anything in this period.</p>'}
                ${idle.length ? `<details class="wb-more" style="margin-top:10px"><summary>${idle.length} ad${idle.length === 1 ? '' : 's'} that did not run in the period</summary>
                    ${table(['Ad', { l: 'Spent (life)', n: 1 }, { l: 'Cost / message', n: 1 }, { l: 'Cost / order', n: 1 }], idle.map(a => [`<span class="t">${esc(a.name || a.ad_id)}</span><div class="s">${esc(a.adset || '')}</div>`, money(a.life.spend, c), money(a.life.cost_per_message, c), money(a.life.cost_per_order, c)]), '')}</details>` : ''}`);
        }
        const LIFE = 180;

        function adsetsPart() {
            const c = cur();
            return section('ci-adsets', 'Ad sets', 'Step 1 (delivering) is judged here: a live ad set that spent nothing is broken. Frequency is the highest of its ads’.',
                table(['Ad set', 'Status', { l: 'Budget', n: 1 }, { l: 'Spent', n: 1 }, { l: 'CPM', n: 1 }, { l: 'Cost / msg', n: 1 }, { l: 'Orders', n: 1 }, { l: 'Cost / order', n: 1 }, { l: 'Freq (7d)', n: 1 }, 'First broken step'],
                    D.adsets.map(s => [`<span class="t">${esc(s.name || s.adset_id)}</span><div class="s">${esc(s.campaign || '')}</div>`, esc((s.status || '—').toLowerCase()),
                        s.daily_budget !== null ? `${money(s.daily_budget, c)}/day` : s.lifetime_budget !== null ? `${money(s.lifetime_budget, c)} total` : '—',
                        money(s.period.spend, c), money(s.period.cpm, c), money(s.period.cost_per_message, c),
                        s.week.orders_from === 'log' ? num(s.week.orders) : num(s.week.meta_purchases), money(s.week.cost_per_order, c), num(s.highest_frequency_7d),
                        s.paused ? '<span class="el-muted">not running</span>' : s.first_broken ? `<span class="el-chip is-bad">${s.first_broken.step}. ${esc(s.first_broken.name)}</span>` : '<span class="el-chip is-jade">none</span>']),
                    'No ad sets read for this business yet.'));
        }

        function businessPart() {
            const B = D.business, c = cur(), p = B.period, m = B.last_30;
            const rows = B.days.slice().reverse().filter(x => x.orders || x.spend).slice(0, 30);
            return section('ci-business', 'The whole business', 'All orders from every source against all ad spend. Meta takes credit for some sales that would have happened anyway: if Meta’s numbers improve but these don’t, believe these.',
                `<div class="ao-kpis">
                    ${kpi('Orders (period)', num(p.orders), `${num(p.ad_orders)} from ads`)}${kpi('Delivered (period)', num(p.delivered), money(p.delivered_value, c))}
                    ${kpi('MER (period)', times(p.mer))}${kpi('Cost per delivered order', money(p.cost_per_delivered, c))}
                    ${kpi('Orders (30 days)', num(m.orders), `${num(m.delivered)} delivered`)}${kpi('MER (30 days)', times(m.mer))}
                    ${kpi('Failed or returned', pct(B.fail_rate_30), 'of settled orders, 30 days')}
                </div>
                ${B.compare && B.compare.note ? `<div class="wsc-banner" style="margin-top:12px">${esc(B.compare.note)} Meta: ${num(B.compare.meta_purchases)} purchases; logged from ads: ${num(B.compare.logged_ad_orders)}.</div>` : ''}
                <details class="wb-more" style="margin-top:10px"><summary>Day by day, last 30 days</summary>
                ${table(['Day', { l: 'Orders', n: 1 }, { l: 'From ads', n: 1 }, { l: 'Delivered', n: 1 }, { l: 'Delivered sales', n: 1 }, { l: 'Ad spend', n: 1 }, { l: 'Messages', n: 1 }, { l: 'MER', n: 1 }],
                    rows.map(x => [`<span class="t">${esc(day(x.day))}</span>`, num(x.orders), num(x.ad_orders), num(x.delivered), money(x.delivered_value, c), money(x.spend, c), num(x.messages), times(x.mer)]),
                    'No orders and no spend in the last 30 days.')}</details>`);
        }

        function stockPart() {
            const W = { out: ['Stock out', 'is-bad'], low: ['Low', 'is-warn'], runs_out_soon: ['Runs out within a week', 'is-warn'] };
            return section('ci-stock', 'Stock', 'Pause before it runs out, not after. Days left come from the last 14 days of logged orders.',
                table(['Product', { l: 'In hand', n: 1 }, { l: 'On order', n: 1 }, { l: 'Sold (14 days)', n: 1 }, { l: 'By ads', n: 1 }, { l: 'Days left', n: 1 }, ''],
                    D.stock.map(p => [`<span class="t">${esc(p.name)}</span>${p.combo ? '<div class="s">combo, from its parts</div>' : ''}`, num(p.stock), num(p.in_order), num(p.sold_14d), num(p.sold_by_ads_14d), num(p.days_left),
                        p.warning ? `<span class="el-chip ${W[p.warning][1]}">${W[p.warning][0]}</span>` : '']),
                    'No stock warnings, and no logged sales in the last 14 days.'));
        }

        function budgetPart() {
            const b = D.budget, c = cur();
            if (!b.monthly_budget) return section('ci-budget', 'Spend this month', '', `<p>${money(b.spent, c)} spent so far in ${esc(b.month)}. <span class="el-muted">No monthly budget in the brief to compare with (Ad brief &amp; plan tab).</span></p>`);
            const w = Math.min(100, b.share_spent || 0);
            const tag = { over: ['Will go over', 'is-bad'], under: ['Will underspend', 'is-warn'], on_track: ['On track', 'is-jade'] }[b.state];
            return section('ci-budget', 'Spend this month', `The bar is the share of the budget spent; the line is the share of the month gone (${b.days_gone} of ${b.days_in_month} days).`,
                `<div class="ao-bar"><span style="width:${w}%"></span><i style="left:${Math.min(100, b.share_of_month)}%"></i></div>
                <p>${money(b.spent, c)} of ${money(b.monthly_budget, c)} (${pct(b.share_spent)}). At this pace: ${money(b.projected, c)} (${pct(b.projected_vs_budget)} of the budget). ${tag ? `<span class="el-chip ${tag[1]}">${tag[0]}</span>` : ''}</p>`);
        }

        function forecastPart() {
            const F = D.forecast, c = cur();
            if (!F) return section('ci-forecast', 'The month against its forecast', '', '<p class="el-muted">The plan has no forecast. Add expected spend, messages, chat → order rate and orders to the plan (Ad brief &amp; plan tab).</p>');
            const row = (l, x, f) => (x ? [esc(l), f(x.expected), f(x.expected_by_now), f(x.so_far), f(x.pace), `<span class="el-chip ${x.state === 'behind' ? 'is-bad' : 'is-jade'}">${x.state === 'behind' ? 'Behind' : 'On track'}</span>`] : null);
            return section('ci-forecast', 'The month against its forecast', `From the plan. Orders are ${esc(F.orders_from)}. A miss shows up here early, and in money.`,
                `${table(['Figure', { l: 'Expected', n: 1 }, { l: 'Expected by now', n: 1 }, { l: 'So far', n: 1 }, { l: 'At this pace', n: 1 }, ''],
                    [row('Spend', F.spend, v => money(v, c)), row('Messages', F.messages, num), row('Orders', F.orders, num)].filter(Boolean), '')}
                ${F.chat_to_order ? `<p>Chats → orders: expected ${pct(F.chat_to_order.expected)}, so far ${pct(F.chat_to_order.so_far)}.</p>` : ''}`);
        }

        function unplannedPart() {
            const c = cur();
            return section('ci-unplanned', 'Campaigns no plan mentions', 'Spent in the last 30 days, but in no ad plan (its Meta campaign ids) and no Ad ledger row. Often the owner’s own boosts: measure them separately.',
                table(['Campaign', 'Status', { l: 'Spent (30 days)', n: 1 }], D.unplanned.map(u => [`<span class="t">${esc(u.name || u.campaign_id)}</span><div class="s">${esc(u.campaign_id)}</div>`, esc((u.status || '—').toLowerCase()), money(u.spend_30d, c)]),
                    'Every campaign that spent is in a plan or the ledger.'));
        }

        function healthPart() {
            return section('ci-health', 'Account health', '', D.health.length ? `<ul class="ao-list">${D.health.map(a => `<li><b>${esc(a.name)}</b>: ${a.ok ? `<span class="el-chip is-jade">${esc(a.status || 'OK')}</span>` : `<span class="el-chip is-bad">${esc(a.problems.join(' · '))}</span>`} <span class="el-muted">read ${esc(day(a.last_synced_at))}</span></li>`).join('')}</ul>`
                : '<p class="el-muted">No ad account is shared with us for this business.</p>');
        }

        function decisionsPart() {
            const due = D.decisions_due, all = DEC.decisions;
            const row = x => [`<span class="t">${esc(x.change)}</span><div class="s">${esc([x.scope_name, x.step ? `step ${x.step}, ${STEP_NAMES[x.step - 1]}` : '', x.expected ? `expected ${x.expected}` : ''].filter(Boolean).join(' · '))}</div>${x.lesson ? `<div class="s">Lesson: ${esc(x.lesson)}</div>` : ''}`,
                esc(day(x.decided_on)), esc(day(x.check_on)),
                x.outcome ? `<span class="el-chip ${x.outcome === 'right' ? 'is-jade' : x.outcome === 'wrong' ? 'is-bad' : 'is-warn'}">${esc(label(OUTCOMES, x.outcome))}</span>` : (x.check_on && x.check_on <= D.today ? '<span class="el-chip is-gold">Grade it</span>' : '<span class="el-muted">waiting</span>')];
            const rows = list => list.map(x => ({ cells: row(x), attrs: ` class="is-link" data-dec="${esc(x.id)}" tabindex="0"` }));
            return section('ci-decisions', 'Decisions', `What was changed, why, and what it should move. Grade each one when its check date comes: right, wrong or too early, and write the lesson about the idea. ${D.decisions_open} waiting for their date.`,
                `${due.length ? `<h3 class="ab-h3">Due for grading (${due.length})</h3>${table(['Decision', 'Made', 'Check', 'Outcome'], rows(due), '')}` : '<p><span class="el-chip is-jade">Nothing due for grading</span></p>'}
                <details class="wb-more" style="margin-top:10px"><summary>The whole log (${all.length})</summary>${table(['Decision', 'Made', 'Check', 'Outcome'], rows(all), 'No decisions logged yet.')}</details>`,
                D.canEdit ? '<button type="button" class="ws-btn is-sm is-gold" id="ci-add-dec">Log a decision</button>' : '');
        }

        function econPart() {
            const c = cur();
            const T = D.targets, F = D.targets_from;
            return section('ci-econ', 'What a result is worth', `The thresholds this check-in used: cost per message ${money(T.cost_per_message, c)} (${esc(F.cost_per_message || 'none')}), cost per order ${money(T.cost_per_order, c)} (${esc(F.cost_per_order || 'none')}), CPM ${esc(F.cpm || 'none')}, stop-scroll ${esc(F.stop_scroll)}, frequency ${esc(F.frequency)}.`,
                table(['Product', { l: 'Price', n: 1 }, { l: 'Margin', n: 1 }, { l: 'Break-even per order', n: 1 }, { l: 'Free delivery', n: 1 }, { l: 'Target per order', n: 1 }, { l: 'Target per message', n: 1 }],
                    D.economics.map(p => [`<span class="t">${esc(p.name)}</span>${p.missing.length ? `<div class="s">missing ${esc(p.missing.join(', '))}</div>` : ''}`, money(p.price, c), money(p.margin, c),
                        p.break_even !== null ? `<span class="${p.loses_money ? 'wb-bad' : ''}">${money(p.break_even, c)}</span>` : '—',
                        p.free_delivery_break_even !== null ? `<span class="${p.free_delivery_loses ? 'wb-bad' : ''}">${money(p.free_delivery_break_even, c)}</span>` : '—',
                        money(p.target_cost_per_order, c), money(p.target_cost_per_message, c)]), 'No products yet.'),
                D.canEdit ? '<button type="button" class="ws-btn is-sm" id="ci-econ-edit">Delivery &amp; costs</button>' : '');
        }

        function lessonsPart() {
            const L = LES.lessons || [];
            return section('ci-lessons', 'Lessons library', 'Graded lessons from every business you can open, the same kind of business first. Start a new plan from what worked elsewhere.',
                `<div class="ws-filters"><button type="button" data-idea="" aria-pressed="${!ideaFilter}">All</button>${IDEA_TYPES.map(([k, l]) => `<button type="button" data-idea="${k}" aria-pressed="${ideaFilter === k}">${esc(l)}</button>`).join('')}</div>
                ${L.length ? `<div class="ao-items">${L.slice(0, 40).map(x => `<div class="ao-lesson"><b>${esc(x.lesson)}</b>
                    <span class="s">${esc([x.idea_type ? label(IDEA_TYPES, x.idea_type) : null, x.idea, x.client + (x.this_client ? ' (this client)' : x.same_kind ? ' (same kind of business)' : ''), day(x.decided_on)].filter(Boolean).join(' · '))}</span>
                    <span class="s">${esc(x.change)}${x.outcome ? ` → ${label(OUTCOMES, x.outcome).toLowerCase()}` : ''}${x.outcome_note ? `: ${x.outcome_note}` : ''}</span></div>`).join('')}</div>`
                    : '<p class="el-muted">No lessons yet. Grade decisions and write the lesson about the idea to start the library.</p>'}`);
        }

        function gapsPart() {
            return section('ci-gaps', 'What this check-in could not see', '', `<ul class="ao-list">${D.gaps.map(g => `<li>${esc(g)}</li>`).join('')}</ul>`);
        }

        // ---- the whole check-in as text, for a chat or a doc ----
        function asText() {
            const c = cur(), o = [], t = D.totals.period, B = D.business;
            const f = x => `spent ${money(x.spend, c)}, CPM ${money(x.cpm, c)}, stop-scroll ${pct(x.stop_scroll)}, watch-through ${pct(x.watch_through)}, CTR ${pct(x.ctr)}, ${num(x.messages)} msgs at ${money(x.cost_per_message, c)}, ${x.orders_from === 'log' ? num(x.orders) + ' orders (log)' : num(x.meta_purchases) + ' purchases (Meta)'} at ${money(x.cost_per_order, c)}`;
            o.push(`# Ads check-in: ${D.client.name}, ${D.period.from} to ${D.period.to}`, '');
            o.push(`Plan: ${D.plan ? `${D.plan.title} (${D.plan.status})` : 'none approved'}`);
            o.push(`Targets: cost/msg ${money(D.targets.cost_per_message, c)} (${D.targets_from.cost_per_message || 'none'}), cost/order ${money(D.targets.cost_per_order, c)} (${D.targets_from.cost_per_order || 'none'}), CPM ≤ ${money(D.targets.max_cpm || (D.targets.normal_cpm ? D.targets.normal_cpm * 1.5 : null), c)}, stop-scroll ≥ ${D.targets.min_stop_scroll || D.targets.stop_scroll_default}%, frequency ≤ ${D.targets.max_frequency || D.targets.frequency_default}`, '');
            o.push('## First broken steps');
            D.adsets.filter(s => s.first_broken).forEach(s => o.push(`- Ad set ${s.name}: step ${s.first_broken.step} ${s.first_broken.name}, ${fmtStep(s.first_broken, c)}. ${s.first_broken.next_move}`));
            D.broken.forEach(b => o.push(`- ${b.name || b.ad_id}: step ${b.step} ${b.step_name}, ${fmtStep(b, c)}. ${b.next_move}`));
            if (!D.broken.length && !D.adsets.some(s => s.first_broken)) o.push('- None.');
            o.push('', `## Totals: ${f(t)}`);
            o.push(`Business (period): ${num(B.period.orders)} orders (${num(B.period.ad_orders)} from ads), ${num(B.period.delivered)} delivered worth ${money(B.period.delivered_value, c)}, MER ${times(B.period.mer)}, cost per delivered ${money(B.period.cost_per_delivered, c)}. 30 days: ${num(B.last_30.orders)} orders, MER ${times(B.last_30.mer)}, failed/returned ${pct(B.fail_rate_30)}.`);
            if (B.compare && B.compare.note) o.push(B.compare.note);
            o.push('', '## Ads');
            D.ads.filter(a => !a.paused).forEach(a => {
                o.push(`- ${a.name || a.ad_id} [${a.ad_id}] (${[a.adset, a.campaign].filter(Boolean).join(' / ')}): ${f(a.period)}; 7-day frequency ${num(a.frequency_7d)}`);
                o.push(`  chain: ${a.chain.map(s => `${s.step}${s.state === 'ok' ? '✓' : s.state === 'broken' ? '✗' : s.state === 'too_early' ? '…' : '?'}`).join(' ')}; life: ${f(a.life)}`);
            });
            o.push('', '## Stock');
            D.stock.forEach(p => o.push(`- ${p.name}: ${num(p.stock)} in hand, ${num(p.sold_14d)} sold in 14 days, ${num(p.days_left)} days left${p.warning ? ` [${p.warning}]` : ''}`));
            const b = D.budget;
            o.push('', `## Budget: ${money(b.spent, c)} of ${money(b.monthly_budget, c)} in ${b.month}, ${b.days_gone}/${b.days_in_month} days, pace ${money(b.projected, c)} (${b.state})`);
            if (D.forecast) { const F = D.forecast; o.push(`## Forecast: ${['spend', 'messages', 'orders'].filter(k => F[k]).map(k => `${k} ${num(F[k].so_far)} of ${num(F[k].expected)} (pace ${num(F[k].pace)}, ${F[k].state})`).join('; ')}`); }
            o.push('', '## Unplanned campaigns'); D.unplanned.forEach(u => o.push(`- ${u.name || u.campaign_id} [${u.campaign_id}]: ${money(u.spend_30d, c)} in 30 days`)); if (!D.unplanned.length) o.push('- None.');
            o.push('', '## Account health'); D.health.forEach(a => o.push(`- ${a.name}: ${a.ok ? 'OK' : a.problems.join('; ')}`));
            o.push('', '## Decisions due for grading'); D.decisions_due.forEach(x => o.push(`- [${x.id}] ${x.decided_on}: ${x.change} (step ${x.step || '?'}, expected ${x.expected || '—'}, check ${x.check_on})`)); if (!D.decisions_due.length) o.push('- None.');
            o.push('', '## Could not see'); D.gaps.forEach(g => o.push(`- ${g}`));
            return o.join('\n');
        }

        function draw() {
            const p = period;
            host.innerHTML = `<div class="ao">
                <div class="ao-head"><div><h2>Ads check-in for ${esc(ctx.clientName)}</h2>
                    <p class="el-muted ao-sub">${esc(day(D.period.from))} to ${esc(day(D.period.to))} · plan: ${D.plan ? `<b>${esc(D.plan.title)}</b> (${esc(D.plan.status)})` : 'none approved'} · orders ${D.totals.period.orders_from === 'log' ? 'from the orders log' : 'from Meta’s purchase events'}</p></div>
                    <div class="ws-actions ao-noprint" style="margin:0">
                        <button class="ws-btn is-sm" type="button" id="ci-copy">Copy as text</button>
                        <a class="ws-btn is-sm" href="${esc(ctx.resultsPage)}?client=${encodeURIComponent(id)}&month=${esc(D.period.to.slice(0, 7))}" target="_blank" rel="noopener">Results report</a>
                    </div></div>
                <div class="ao-period ws-filters ao-noprint">${[['3', 'Last 3 days'], ['7', '7 days'], ['14', '14 days'], ['30', '30 days'], ['custom', 'Choose']].map(([k, l]) => `<button type="button" data-p="${k}" aria-pressed="${p.preset === k}">${l}</button>`).join('')}
                    ${p.preset === 'custom' ? `<input type="date" id="ci-from" value="${esc(D.period.from)}" aria-label="From"> <input type="date" id="ci-to" value="${esc(D.period.to)}" aria-label="To"> <button type="button" class="ws-btn is-sm" id="ci-go">Show</button>` : ''}</div>
                ${totalsPart()}
                ${brokenPart()}${adsPart()}${adsetsPart()}${businessPart()}${stockPart()}${budgetPart()}${forecastPart()}${unplannedPart()}${healthPart()}${decisionsPart()}${econPart()}${lessonsPart()}${gapsPart()}
            </div>`;
            UI.cards(host);
            host.querySelectorAll('[data-p]').forEach(b => b.addEventListener('click', () => {
                period = { preset: b.dataset.p, from: D.period.from, to: b.dataset.p === 'custom' ? D.period.to : null };
                if (b.dataset.p === 'custom') draw(); else load();
            }));
            const go = host.querySelector('#ci-go');
            if (go) go.addEventListener('click', () => { period = { preset: 'custom', from: host.querySelector('#ci-from').value, to: host.querySelector('#ci-to').value }; load(); });
            host.querySelector('#ci-copy').addEventListener('click', () => copy(asText(), 'the whole check-in as text'));
            const reload = () => load();
            const add = host.querySelector('#ci-add-dec'); if (add) add.addEventListener('click', () => decisionForm(ctx, null, null, reload));
            host.querySelectorAll('[data-decide]').forEach(b => b.addEventListener('click', () => {
                const a = D.ads.find(x => x.ad_id === b.dataset.decide) || {};
                decisionForm(ctx, null, { scope: 'ad', scope_id: a.ad_id, scope_name: a.name, step: a.first_broken ? a.first_broken.step : null }, reload);
            }));
            host.querySelectorAll('[data-dec]').forEach(tr => {
                const open = () => decisionForm(ctx, DEC.decisions.find(x => x.id === tr.dataset.dec) || D.decisions_due.find(x => x.id === tr.dataset.dec), null, reload);
                tr.addEventListener('click', open); tr.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
            });
            const ec = host.querySelector('#ci-econ-edit'); if (ec) ec.addEventListener('click', () => economicsForm(ctx, reload));
            host.querySelectorAll('[data-idea]').forEach(b => b.addEventListener('click', async () => {
                ideaFilter = b.dataset.idea;
                LES = await EL.api(`/api/ad-lessons?client=${encodeURIComponent(id)}${ideaFilter ? `&idea_type=${ideaFilter}` : ''}`).catch(() => ({ lessons: [] }));
                draw();
            }));
        }
        await load();
    }

    // =========================================================================
    // THE ORDERS LOG
    // =========================================================================
    async function orders(host, ctx) {
        const id = ctx.clientId;
        let O = null, filter = 'all', range = { from: null, to: null };
        async function load() {
            try { O = await EL.api(`${base(id)}/orders${range.from ? `?from=${range.from}&to=${range.to}` : ''}`); }
            catch (err) {
                host.innerHTML = err && err.status === 404 ? `<div class="ws-empty">${ic('lock')}<h3>Orders are for the client’s editors</h3><p>Buyers’ orders are only shown to people who can edit this client. The Ads check-in shows the totals.</p></div>` : failBox(err);
                return;
            }
            draw();
        }
        const pname = pid => (O.products.find(p => p.id === pid) || {}).name || 'Removed product';
        const items = o => (o.items || []).map(x => `${x.qty}× ${pname(x.product_id)}`).join(', ');
        const adName = aid => (O.ads.find(a => a.ad_id === aid) || {}).name || aid;

        function form(row) {
            const r = row || { ordered_on: isoToday(), channel: 'messenger', status: 'confirmed', source: 'ad', items: [{}] };
            const itemRow = (x = {}) => `<div class="ao-item" data-item>
                ${fld('Product', `<select data-k="product_id">${opts(O.products.map(p => [p.id, p.name]), x.product_id)}</select>`)}
                ${fld('Qty', `<input data-k="qty" inputmode="numeric" value="${esc(x.qty ?? 1)}">`)}
                ${fld('Price each', `<input data-k="price" inputmode="decimal" value="${esc(x.price ?? '')}" placeholder="its price">`)}
                <button type="button" class="ws-btn is-sm is-quiet" data-drop-item>Remove</button></div>`;
            const d = EL.drawer({
                wide: true, title: row ? 'Order' : 'Add an order', sub: esc(ctx.clientName),
                body: `<div class="wb-fields" id="ao-ord">
                    ${fld('Order date', `<input name="ordered_on" type="date" value="${esc(r.ordered_on || '')}">`)}
                    ${fld('Came in by', `<select name="channel">${opts(CHANNELS, r.channel, false)}</select>`)}
                    ${fld('Where it came from', `<select name="source">${opts(SOURCES, r.source, false)}</select>`)}
                    ${fld('Which ad', `<select name="ad_id">${opts(O.ads.map(a => [a.ad_id, `${a.name}${a.spend_60d ? '' : ' (no spend, 60 days)'}`]), r.ad_id)}</select>`, false, 'From the Messenger chat: the ad the buyer replied to. Leave empty if not known.')}
                    ${fld('Status', `<select name="status">${opts(ORDER_STATUS, r.status, false)}</select>`)}
                    ${fld('Buyer', `<select name="buyer_type">${opts([['new', 'New'], ['returning', 'Returning']], r.buyer_type)}</select>`, false, 'Filled in from the phone number when it is given.')}
                    ${fld('Phone number', `<input name="phone" inputmode="tel" autocomplete="off" placeholder="${row && row.known_buyer ? 'Known (not shown)' : '01…'}">`, false,
                        O.hashing ? 'Never stored or shown. It is turned into a code, only to tell new buyers from returning ones.' : 'Not used: the server has no secret to code it with. Pick New or Returning by hand.')}
                </div>
                <h3 class="ab-h3">Items</h3><div class="ao-items" id="ao-items">${(r.items && r.items.length ? r.items : [{}]).map(itemRow).join('')}</div>
                <button type="button" class="ws-btn is-sm" id="ao-add-item">Add an item</button>
                <div class="wb-fields" id="ao-ord2" style="margin-top:12px">
                    ${fld('Order value', `<input name="value" inputmode="decimal" value="${row ? esc(r.value) : ''}" placeholder="the items’ total">`, false, 'Without delivery. Empty: the items’ total.')}
                    ${fld('Delivery zone', `<input name="delivery_zone" list="ao-zone-l" value="${esc(r.delivery_zone || '')}"><datalist id="ao-zone-l">${O.zones.map(z => `<option value="${esc(z.name)}">`).join('')}</datalist>`)}
                    ${fld('Delivery charge', `<input name="delivery_charge" inputmode="decimal" value="${esc(r.delivery_charge ?? '')}" placeholder="from the zone">`)}
                    <div><label><input type="checkbox" name="free_delivery" ${r.free_delivery ? 'checked' : ''}> Free delivery</label></div>
                    ${fld('Notes', `<textarea name="notes" class="wb-area">${esc(r.notes || '')}</textarea>`, true)}
                </div><div class="ws-note" id="ao-ord-note"></div>`,
                foot: `${row ? '<button class="ws-btn is-danger" type="button" id="ao-ord-del">Delete</button>' : ''}<span style="flex:1"></span><button class="ws-btn" type="button" data-dw-close>Cancel</button><button class="ws-btn is-gold" type="button" id="ao-ord-save">Save</button>`
            });
            const box = d.el.querySelector('#ao-items'), note = d.el.querySelector('#ao-ord-note');
            const failN = err => { note.className = 'ws-note is-bad'; note.textContent = err.message; };
            d.el.addEventListener('click', ev => { const b = ev.target.closest('[data-drop-item]'); if (b) b.closest('[data-item]').remove(); });
            d.el.querySelector('#ao-add-item').addEventListener('click', () => box.insertAdjacentHTML('beforeend', itemRow()));
            d.el.querySelector('#ao-ord-save').addEventListener('click', async ev => {
                const b = ev.currentTarget, body = {};
                d.el.querySelectorAll('#ao-ord [name], #ao-ord2 [name]').forEach(i => {
                    if (i.type === 'checkbox') body[i.name] = i.checked;
                    else body[i.name] = i.value.trim() === '' ? null : i.value.trim();
                });
                if (!body.phone) delete body.phone;
                if (row && !body.buyer_type) delete body.buyer_type;
                body.items = [...box.querySelectorAll('[data-item]')].map(x => Object.fromEntries([...x.querySelectorAll('[data-k]')].map(i => [i.dataset.k, i.value.trim() || null]))).filter(x => x.product_id);
                if (body.source !== 'ad') body.ad_id = null;
                b.disabled = true; note.className = 'ws-note'; note.textContent = 'Saving…';
                try {
                    const res = row ? await EL.api(`${base(id)}/orders/${encodeURIComponent(row.id)}`, { method: 'PATCH', body })
                        : await EL.api(`${base(id)}/orders`, { method: 'POST', body });
                    EL.toast(res.phone === 'bad_phone' ? 'Saved. That phone number did not look right, so it was not used.' : 'Saved.');
                    d.close(); await load();
                } catch (err) { failN(err); b.disabled = false; }
            });
            const del = d.el.querySelector('#ao-ord-del');
            if (del) del.addEventListener('click', async () => {
                if (del.dataset.sure !== '1') { del.dataset.sure = '1'; del.textContent = 'Delete — press again'; return; }
                del.disabled = true;
                try { await EL.api(`${base(id)}/orders/${encodeURIComponent(row.id)}`, { method: 'DELETE' }); d.close(); await load(); } catch (err) { failN(err); del.disabled = false; }
            });
        }

        function draw() {
            const all = O.orders;
            const counts = Object.fromEntries(ORDER_STATUS.map(([k]) => [k, all.filter(o => o.status === k).length]));
            const list = filter === 'all' ? all : all.filter(o => o.status === filter);
            const live = all.filter(o => o.status !== 'cancelled');
            const settled = all.filter(o => ['delivered', 'failed', 'returned'].includes(o.status));
            const deliveredValue = all.filter(o => o.status === 'delivered').reduce((s, o) => s + Number(o.value || 0), 0);
            const fromAds = live.filter(o => o.source === 'ad' || o.ad_id).length;
            const returning = live.filter(o => o.buyer_type === 'returning').length;
            host.innerHTML = `<div class="ao">
                <div class="ao-head"><div><h2>Orders for ${esc(ctx.clientName)}</h2>
                    <p class="el-muted ao-sub">Every order and what happened to it, from ${esc(day(O.from))} to ${esc(day(O.to))}. Meta counts chats; the business lives on delivered orders. Only the client’s editors see this list.</p></div>
                    <div class="ws-actions" style="margin:0"><button class="ws-btn is-sm" type="button" id="ao-econ">Delivery &amp; costs</button><button class="ws-btn is-sm is-gold" type="button" id="ao-add">${ic('plus')}Add an order</button></div></div>
                <div class="ao-kpis">${kpi('Orders', num(live.length), `${num(all.length - live.length)} cancelled`)}${kpi('Delivered', num(counts.delivered), money(deliveredValue))}
                    ${kpi('Failed or returned', settled.length ? pct(Math.round((counts.failed + counts.returned) / settled.length * 1000) / 10) : '—', 'of settled')}
                    ${kpi('From ads', live.length ? pct(Math.round(fromAds / live.length * 1000) / 10) : '—')}${kpi('Returning buyers', live.length ? pct(Math.round(returning / live.length * 1000) / 10) : '—')}</div>
                <div class="ao-period">
                    <div class="ws-filters" style="margin:0"><button type="button" data-f="all" aria-pressed="${filter === 'all'}">All <span class="ws-num">${all.length}</span></button>${ORDER_STATUS.map(([k, l]) => `<button type="button" data-f="${k}" aria-pressed="${filter === k}">${l} <span class="ws-num">${counts[k]}</span></button>`).join('')}</div>
                    <span style="flex:1"></span><input type="date" id="ao-from" value="${esc(O.from)}" aria-label="From"><input type="date" id="ao-to" value="${esc(O.to)}" aria-label="To"><button type="button" class="ws-btn is-sm" id="ao-go">Show</button>
                </div>
                ${table(['Order', 'Date', { l: 'Value', n: 1 }, 'Delivery', 'From', 'Status', 'Buyer'],
                    list.map(o => ({ attrs: ` class="is-link" data-o="${esc(o.id)}" tabindex="0"`, cells: [
                        `<span class="t">${esc(items(o) || 'No items')}</span><div class="s">${esc(label(CHANNELS, o.channel))}${o.notes ? ' · ' + esc(o.notes.slice(0, 80)) : ''}</div>`,
                        esc(day(o.ordered_on)), money(o.value),
                        esc([o.delivery_zone, o.free_delivery ? 'free' : has(o.delivery_charge) ? money(o.delivery_charge) : null].filter(Boolean).join(' · ') || '—'),
                        esc(o.source === 'ad' ? (o.ad_id ? `Ad: ${adName(o.ad_id)}` : 'An ad') : label(SOURCES, o.source)),
                        `<span data-stop><select class="wb-status" data-st="${esc(o.id)}" aria-label="Status">${opts(ORDER_STATUS, o.status, false)}</select></span>`,
                        esc(o.buyer_type ? label([['new', 'New'], ['returning', 'Returning']], o.buyer_type) : '—')
                    ] })),
                    all.length ? 'No orders with that status.' : 'No orders in this period. Add each confirmed order here: with its outcome, the check-in can judge chats → orders and cost per delivered order.')}
            </div>`;
            UI.cards(host);
            host.querySelectorAll('[data-f]').forEach(b => b.addEventListener('click', () => { filter = b.dataset.f; draw(); }));
            host.querySelector('#ao-go').addEventListener('click', () => { range = { from: host.querySelector('#ao-from').value, to: host.querySelector('#ao-to').value }; load(); });
            host.querySelector('#ao-add').addEventListener('click', () => form(null));
            host.querySelector('#ao-econ').addEventListener('click', () => economicsForm(ctx, load));
            host.querySelectorAll('[data-stop]').forEach(el => el.addEventListener('click', e => e.stopPropagation()));
            host.querySelectorAll('[data-o]').forEach(tr => {
                const open = () => form(O.orders.find(o => o.id === tr.dataset.o));
                tr.addEventListener('click', open); tr.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target === tr) open(); });
            });
            host.querySelectorAll('[data-st]').forEach(s => s.addEventListener('change', async () => {
                s.disabled = true;
                try { const r = await EL.api(`${base(id)}/orders/${encodeURIComponent(s.dataset.st)}`, { method: 'PATCH', body: { status: s.value } }); Object.assign(O.orders.find(o => o.id === s.dataset.st), r.order); EL.toast('Status saved.'); draw(); }
                catch (err) { EL.toast(err.message, 'bad'); s.disabled = false; }
            }));
        }
        await load();
    }

    window.AdOps = { checkin, orders, economicsForm };
})();
