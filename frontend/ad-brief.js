/**
 * EDGELEAD :: THE AD BRIEF AND THE AD PLAN  (phase 85)
 * ---------------------------------------------------------------------------
 * A client's tab with everything needed to plan its next ad set, on one page
 * in a fixed order, and the plans made from it. Load after header.js and
 * client-tools.js.
 *
 *   AdBrief.mount(host, ctx)     ctx = { clientId, clientName }
 *
 * The page is written to be read top to bottom by a person or by Claude in a
 * browser: each part is a section with a heading and an id (#ab-brief,
 * #ab-business, #ab-products, #ab-audience, #ab-adsets, #ab-splits,
 * #ab-ledger, #ab-bench, #ab-plans), figures are in tables, and
 * "Copy as text" gives the whole brief as one block. Nothing here writes to
 * Meta: an approved plan is built in Ads Manager by hand.
 * ---------------------------------------------------------------------------
 */
(function () {
    'use strict';
    const esc = v => EL.esc(v);
    const ic = n => EL.icon(n);
    const base = id => `/api/clients/${encodeURIComponent(id)}`;

    const GOALS = [['messages', 'Messages (inbox conversations)'], ['orders', 'Orders / purchases'], ['leads', 'Leads (forms)'], ['calls', 'Phone calls'],
        ['visits', 'Visits to the shop'], ['awareness', 'Awareness (reach)'], ['followers', 'Followers']];
    const CHANNELS = [['messenger', 'Messenger'], ['whatsapp', 'WhatsApp'], ['instagram_dm', 'Instagram DM'], ['website', 'Website'], ['phone', 'Phone'], ['walk_in', 'Walk-in']];
    const YES_NO = [['yes', 'Yes'], ['no', 'No'], ['unknown', 'Not sure']];
    const OBJECTIVES = ['Messages', 'Sales', 'Leads', 'Traffic', 'Awareness', 'Engagement', 'Calls'];
    const GOAL_TO_OBJECTIVE = { messages: 'Messages', orders: 'Sales', leads: 'Leads', calls: 'Calls', visits: 'Awareness', awareness: 'Awareness', followers: 'Engagement' };
    const DESTINATIONS = [['messenger', 'Messenger'], ['whatsapp', 'WhatsApp'], ['instagram_dm', 'Instagram DM'], ['website', 'Website'], ['call', 'Phone call'], ['lead_form', 'Instant form'], ['none', 'None (reach / video)']];
    const FORMATS = ['Reel', 'Image', 'Carousel', 'Video', 'Story', 'Influencer reel', 'Live'];
    const STATUS = { draft: ['Draft', ''], approved: ['Approved', 'is-jade'], rejected: ['Rejected', 'is-bad'], launched: ['Launched', 'is-gold'] };
    const DIM = { age_gender: 'By age and gender', region: 'By region', placement: 'By placement' };

    const SYM = { BDT: '৳', USD: '$', EUR: '€', GBP: '£', INR: '₹' };
    const has = v => v !== null && v !== undefined && v !== '';
    const num = v => (has(v) ? Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—');
    const money = (v, cur) => (has(v) ? `${SYM[cur] || (cur ? cur + ' ' : '')}${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '—');
    const pct = v => (has(v) ? `${v}%` : '—');
    const day = v => (v ? UI.day(v) : '—');
    const label = (list, k) => ((list.find(x => x[0] === k) || [])[1] || k || '—');

    async function mount(host, ctx) {
        const id = ctx.clientId;
        let D, P;
        try {
            [D, P] = await Promise.all([EL.api(`${base(id)}/ad-brief`), EL.api(`${base(id)}/ad-plans`)]);
        } catch (err) {
            host.innerHTML = `<div class="ws-empty">${ic('alert')}<p>${esc(err.message)}</p></div>`;
            return;
        }
        const cur = () => (D.brief.currency || D.ads.currency || 'BDT');
        const reload = async () => { [D, P] = await Promise.all([EL.api(`${base(id)}/ad-brief`), EL.api(`${base(id)}/ad-plans`)]); draw(); };

        // ---- the parts --------------------------------------------------------------------------
        const table = (head, rows, empty) => (rows.length
            ? `<div class="ws-table-wrap"><table class="ws-table ab-table"><thead><tr>${head.map(h => `<th${h.n ? ' class="ws-num"' : ''}>${esc(h.l || h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map((c, i) => `<td${head[i].n ? ' class="ws-num"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
            : `<p class="el-muted">${empty}</p>`);
        const dl = rows => `<dl class="ab-dl">${rows.filter(([, v]) => has(v)).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
        const section = (sid, title, sub, inner) => `<section class="ws-card ab-part" id="${sid}"><div class="ws-card-h"><h2>${title}</h2></div>${sub ? `<p class="el-muted ab-sub">${sub}</p>` : ''}${inner}</section>`;

        function briefPart() {
            const b = D.brief || {}, dis = D.canEdit ? '' : 'disabled';
            const sel = (k, opts) => `<select name="${k}" ${dis}><option value=""></option>${opts.map(([v, l]) => `<option value="${v}" ${b[k] === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
            const inp = (k, ph = '', type = 'text') => `<input name="${k}" type="${type}" value="${esc(b[k] ?? '')}" placeholder="${esc(ph)}" ${dis}>`;
            const area = (k, ph = '') => `<textarea name="${k}" class="wb-area" placeholder="${esc(ph)}" ${dis}>${esc(b[k] || '')}</textarea>`;
            const f = (l, html, full) => `<div class="${full ? 'wb-full' : ''}"><label>${esc(l)}</label>${html}</div>`;
            const lib = n => `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&q=${encodeURIComponent(n)}&search_type=keyword_unordered`;
            return section('ab-brief', 'The brief', 'What the ads are for. Fill in what you know; the gaps list above says what is still missing.', `
                <form id="ab-brief-form" class="wb-fields">
                    ${f('Goal', sel('goal', GOALS))}
                    ${f('Monthly ad budget', inp('monthly_budget', 'e.g. 30000'))}
                    ${f('Currency', inp('currency', 'BDT'))}
                    ${f('Offer ends', inp('offer_ends', '', 'date'))}
                    ${f('Offer', area('offer', 'What is on offer now: price, discount, combo, free delivery…'), true)}
                    ${f('Products to push', area('products_focus', 'Which products, and why these'), true)}
                    ${f('Where they sell or deliver', area('sell_areas', 'Cities, areas, nationwide delivery, a shop people visit…'), true)}
                    <div class="wb-full"><label>How orders come in</label><div class="wb-checks">${CHANNELS.map(([v, l]) => `<label><input type="checkbox" name="order_channels" value="${v}" ${(b.order_channels || []).includes(v) ? 'checked' : ''} ${dis}>${esc(l)}</label>`).join('')}</div></div>
                    ${f('WhatsApp number', inp('whatsapp', '+880…'))}
                    ${f('Website', inp('website', 'www.…'))}
                    ${f('Meta Pixel on the website', sel('pixel', YES_NO))}
                    ${f('Product catalog in Meta', sel('catalog', YES_NO))}
                    ${f('Who buys', area('customer', 'Age, gender, where they live, what they care about, how they pay'), true)}
                    ${f('Busy seasons and hours', area('peak_times', 'Eid, weddings, month end, evenings…'), true)}
                    ${f('What to avoid', area('avoid', 'Claims, words, audiences, places the owner does not want'), true)}
                    ${f('What worked and what did not', area('past_learnings', 'From past ads, boosts and posts'), true)}
                    <div class="wb-full"><label for="ab-obs">What we saw on the page and in Meta’s Ad Library</label>
                        <textarea id="ab-obs" name="observations" class="wb-area is-big" placeholder="The page: WhatsApp or Shop button, reviews, response time, pinned post, last post date. The Ad Library: their active ads and competitors’ ads (offers, formats, how long they have run)." ${dis}>${esc(D.observations || '')}</textarea>
                        <div class="ws-hint">Ad Library: <a class="ws-link" href="${lib(D.client.name)}" target="_blank" rel="noopener">${esc(D.client.name)}</a>${(D.client.competitors || []).slice(0, 8).map(h => ` · <a class="ws-link" href="${lib(h)}" target="_blank" rel="noopener">${esc(h)}</a>`).join('')}${D.client.fb_page ? ` · <a class="ws-link" href="${EL.safeUrl(/^https?:/i.test(D.client.fb_page) ? D.client.fb_page : 'https://facebook.com/' + D.client.fb_page.replace(/^.*facebook\.com\//, ''))}" target="_blank" rel="noopener">their Facebook Page</a>` : ''}${D.client.ig_handle ? ` · <a class="ws-link" href="https://instagram.com/${encodeURIComponent(D.client.ig_handle)}" target="_blank" rel="noopener">@${esc(D.client.ig_handle)}</a>` : ''}</div>
                    </div>
                </form>
                ${D.canEdit ? `<div class="ws-actions"><button class="ws-btn is-gold" type="button" id="ab-save">Save the brief</button><span class="ws-note" id="ab-note">${D.brief_updated_at ? `Saved ${esc(day(D.brief_updated_at))}` : ''}</span></div>` : ''}`);
        }

        function businessPart() {
            const c = D.client, o = c.owner_details || {};
            return section('ab-business', 'The business', 'What the agency has, and what the owner told us in Edge Meta AI.', dl([
                ['Name', esc(c.name)], ['Brand', esc(c.brand || '')], ['What they do', esc(c.niche || '')], ['Where', esc(c.location || '')],
                ['Instagram', c.ig_handle ? '@' + esc(c.ig_handle) : ''], ['Facebook Page', esc(c.fb_page || '')],
                ['Competitors', esc((c.competitors || []).join(', '))], ['Agency notes', esc(c.notes || '').replace(/\n/g, '<br>')],
                ['Owner: phone', esc(o.phone || '')], ['Owner: website', esc(o.website || '')], ['Owner: address', esc(o.address || '')],
                ['Owner: opening hours', esc(o.hours || '').replace(/\n/g, '<br>')], ['Owner: notes', esc(o.notes || '').replace(/\n/g, '<br>')]
            ]));
        }

        function productsPart() {
            return section('ab-products', 'Products and margins', 'From the ad ledger. A margin is the customer price minus the buying price.', table(
                ['Product', { l: 'Price', n: 1 }, { l: 'Combo', n: 1 }, { l: 'Buying', n: 1 }, { l: 'Margin', n: 1 }, { l: 'Margin %', n: 1 }, { l: 'Stock', n: 1 }],
                D.products.map(p => [esc(p.name), money(p.price, cur()), money(p.combo_price, cur()), money(p.cost, cur()), money(p.margin, cur()), pct(p.margin_pct), num(p.stock)]),
                'No products yet. Add them in the Ad ledger tab, under Products &amp; stock.'));
        }

        function audiencePart() {
            const TYPE = { FOLLOWERS: 'followers', ENGAGED: 'people who engaged', REACHED: 'people reached' };
            const blocks = D.audience.map(a => `<div class="ab-aud"><h3>${esc(a.platform)} ${esc(TYPE[a.type] || a.type)} · ${esc(a.dimension.replace('_', ' and '))} <span class="el-muted">(${num(a.total)}, ${esc(day(a.as_of))})</span></h3>
                ${table(['Group', { l: 'People', n: 1 }, { l: 'Share', n: 1 }], a.top.map(s => [esc(s.segment.replace('|', ', ')), num(s.count), pct(s.share)]), '')}</div>`);
            return section('ab-audience', 'Who follows them', 'From Meta, the latest reading. The biggest groups first.', blocks.length ? `<div class="ab-grid">${blocks.join('')}</div>` : '<p class="el-muted">No age, gender or city figures yet.</p>');
        }

        function results(r, c) {
            if (!r) return ['—', '—', '—', '—', '—', '—'];
            const per = r.cost_per_message != null ? `${money(r.cost_per_message, c)}/msg` : r.cost_per_purchase != null ? `${money(r.cost_per_purchase, c)}/order` : r.cost_per_lead != null ? `${money(r.cost_per_lead, c)}/lead` : '—';
            const got = [r.messages && `${num(r.messages)} msgs`, r.purchases && `${num(r.purchases)} orders`, r.leads && `${num(r.leads)} leads`].filter(Boolean).join(', ') || '—';
            return [money(r.spend, c), got, per, pct(r.ctr), money(r.cpm, c), r.roas != null ? `${r.roas}×` : '—'];
        }
        const RES_HEAD = [{ l: 'Spent', n: 1 }, { l: 'Results', n: 1 }, { l: 'Cost per result', n: 1 }, { l: 'CTR', n: 1 }, { l: 'CPM', n: 1 }, { l: 'ROAS', n: 1 }];

        function adsetsPart() {
            const A = D.ads, c = A.currency || cur();
            const acc = A.accounts.length ? A.accounts.map(a => `${esc(a.name || 'Ad account')} (${esc(a.currency || '')})${a.last_synced_at ? `, read ${esc(day(a.last_synced_at))}` : ''}${a.last_error ? ` <span class="el-chip is-bad" title="${esc(a.last_error)}">read failed</span>` : ''}`).join('; ') : 'none shared';
            const total = A.total ? `<div class="ab-kpis">${[['Spent', money(A.total.spend, c)], ['Messages', num(A.total.messages)], ['Cost per message', money(A.total.cost_per_message, c)], ['Orders', num(A.total.purchases)], ['ROAS', A.total.roas != null ? A.total.roas + '×' : '—'], ['CTR', pct(A.total.ctr)], ['CPM', money(A.total.cpm, c)]].map(([l, v]) => `<div class="ws-kpi"><span class="l">${l}</span><span class="v">${v}</span></div>`).join('')}</div>` : '';
            const sets = A.ad_sets.map(s => {
                const budget = s.daily_budget != null ? `${money(s.daily_budget, s.currency || c)}/day` : s.lifetime_budget != null ? `${money(s.lifetime_budget, s.currency || c)} total` : 'campaign budget';
                const setup = [s.objective && `Objective ${s.objective}`, s.optimization_goal && `optimise ${s.optimization_goal}`, s.destination_type && `to ${s.destination_type}`, s.bid_strategy && s.bid_strategy.replace(/_/g, ' ').toLowerCase(), budget].filter(Boolean).map(esc).join(' · ');
                return [`<b>${esc(s.name || s.adset_id)}</b><div class="s">${esc(s.campaign || '')} · ${esc((s.status || '').toLowerCase())} · ${esc(day(s.start_time))}${s.end_time ? '–' + esc(day(s.end_time)) : ''}</div><div class="s">${setup}</div><ul class="ab-tg">${s.targeting.map(l => `<li>${esc(l)}</li>`).join('')}</ul>`, ...results(s.results, s.currency || c)];
            });
            return section('ab-adsets', 'Past ad sets: how they were set up, and what they returned',
                `Read from Meta. Ad account: ${acc}.${A.period ? ` Results ${esc(day(A.period.from))} to ${esc(day(A.period.to))}.` : ''} Busiest first.`,
                total + table(['Ad set and its settings', ...RES_HEAD], sets, A.accounts.length ? 'No ad sets read yet for this business.' : 'No Meta ad account is shared with us for this business.'));
        }

        function splitsPart() {
            const c = D.ads.currency || cur();
            const blocks = Object.entries(DIM).filter(([k]) => (D.ads.splits[k] || []).length).map(([k, l]) => `<div class="ab-split"><h3>${l}</h3>${table(['Group', ...RES_HEAD], D.ads.splits[k].map(r => [esc(r.segment.replace('|', ', ')), ...results(r, c)]), '')}</div>`);
            return section('ab-splits', `Who the ads worked for (last ${D.ads.splits_days} days)`, 'All ad sets together, split one way at a time. Use it to keep the groups that cost least per result and drop the rest.',
                blocks.length ? blocks.join('') : '<p class="el-muted">No splits yet: they come with the ad sets, from Meta.</p>');
        }

        function ledgerPart() {
            const c = cur();
            return section('ab-ledger', 'Ads the team logged', 'From the Ad ledger tab: what the team ran or boosted, with its verdict and what was learned.', table(
                ['Ad', 'Objective and audience', ...RES_HEAD.slice(0, 3), 'Verdict and lesson'],
                D.ledger.map(r => [`<b>${esc(r.creative || '—')}</b><div class="s">${esc([r.format, r.angle, r.status, day(r.start_on)].filter(Boolean).join(' · '))}</div>`,
                    esc([r.objective, r.audience].filter(Boolean).join(' · ') || '—'), ...results(r.results, c).slice(0, 3), esc([r.verdict, r.learned].filter(Boolean).join(': ') || '—')]),
                'Nothing logged yet.'));
        }

        function benchPart() {
            const B = D.benchmarks;
            if (!B) return section('ab-bench', 'What similar businesses pay', '', '<p class="el-muted">Not enough similar businesses with ads yet to compare fairly.</p>');
            const row = (l, x, f) => [esc(l), x.median != null ? f(x.median) : '—', num(x.businesses)];
            return section('ab-bench', 'What similar businesses pay', `Medians over ${num(B.businesses)} of the agency’s other businesses (${esc(B.level)}), last ${B.days} days. No business is named.`, table(
                ['Figure', { l: 'Median', n: 1 }, { l: 'Businesses', n: 1 }],
                [row('Cost per message', B.cost_per_message, v => money(v, B.currency)), row('Cost per order', B.cost_per_purchase, v => money(v, B.currency)), row('Cost per lead', B.cost_per_lead, v => money(v, B.currency)),
                    row('CPM', B.cpm, v => money(v, B.currency)), row('CTR', B.ctr, pct), row('ROAS', B.roas, v => v + '×')], ''));
        }

        function plansPart() {
            return section('ab-plans', 'Ad plans', 'A plan made from this brief: the campaign, its ad sets, creative ideas, and when to stop or scale. Approved plans are built in Ads Manager by hand.',
                `${D.canEdit ? '<div class="ws-actions"><button class="ws-btn is-gold" type="button" id="ab-new-plan">Plan an ad set</button></div>' : ''}
                ${P.plans.length ? `<ul class="ab-plans">${P.plans.map(p => `<li><button type="button" class="ab-plan" data-plan="${esc(p.id)}"><b>${esc(p.title)}</b>
                    <span class="el-chip ${STATUS[p.status][1]}">${STATUS[p.status][0]}</span>
                    <span class="s">${esc([p.plan.objective, p.plan.total_budget != null ? money(p.plan.total_budget, p.plan.currency || cur()) + (p.plan.budget_type === 'daily' ? '/day' : '') : '', `${(p.plan.ad_sets || []).length} ad set(s)`, day(p.created_at)].filter(Boolean).join(' · '))}</span></button></li>`).join('')}</ul>` : '<p class="el-muted">No plans yet.</p>'}`);
        }

        // ---- the whole page as text, for pasting into a chat with an AI or a doc -------------------
        function asText() {
            const out = [], c = cur(), b = D.brief, cl = D.client;
            const line = (k, v) => { if (has(v) && !(Array.isArray(v) && !v.length)) out.push(`- ${k}: ${Array.isArray(v) ? v.join(', ') : v}`); };
            out.push(`# Ad brief: ${cl.name}`, '');
            out.push('## Gaps'); D.gaps.forEach(g => out.push(`- ${g}`)); out.push('');
            out.push('## The brief');
            line('Goal', label(GOALS, b.goal)); line('Monthly budget', b.monthly_budget != null ? money(b.monthly_budget, c) : null); line('Offer', b.offer); line('Offer ends', b.offer_ends);
            line('Products to push', b.products_focus); line('Where they sell', b.sell_areas); line('Orders come in by', (b.order_channels || []).map(x => label(CHANNELS, x)));
            line('WhatsApp', b.whatsapp); line('Website', b.website); line('Pixel', b.pixel); line('Catalog', b.catalog); line('Who buys', b.customer);
            line('Busy times', b.peak_times); line('Avoid', b.avoid); line('Learned so far', b.past_learnings); line('Seen on the page and in the Ad Library', D.observations);
            out.push('', '## The business');
            line('What they do', cl.niche); line('Where', cl.location); line('Instagram', cl.ig_handle && '@' + cl.ig_handle); line('Facebook', cl.fb_page); line('Competitors', cl.competitors);
            line('Agency notes', cl.notes); if (cl.owner_details) Object.entries(cl.owner_details).forEach(([k, v]) => k !== 'updated_at' && line(`Owner ${k}`, v));
            out.push('', '## Products');
            D.products.forEach(p => out.push(`- ${p.name}: price ${money(p.price, c)}, buying ${money(p.cost, c)}, margin ${money(p.margin, c)} (${pct(p.margin_pct)}), stock ${num(p.stock)}`));
            out.push('', '## Audience');
            D.audience.forEach(a => out.push(`- ${a.platform} ${a.type.toLowerCase()} by ${a.dimension} (${a.as_of}): ${a.top.slice(0, 8).map(s => `${s.segment} ${s.share}%`).join(', ')}`));
            out.push('', `## Past ad sets (${D.ads.period ? `${D.ads.period.from} to ${D.ads.period.to}` : 'none read'})`);
            if (D.ads.total) out.push(`- All: ${results(D.ads.total, D.ads.currency || c).join(' | ')} (spent | results | cost per result | CTR | CPM | ROAS)`);
            D.ads.ad_sets.forEach(s => out.push(`- ${s.name} [${s.status}] ${s.objective || ''} optimise ${s.optimization_goal || '?'} to ${s.destination_type || '?'}, budget ${s.daily_budget != null ? money(s.daily_budget, s.currency) + '/day' : s.lifetime_budget != null ? money(s.lifetime_budget, s.currency) + ' total' : 'campaign'}; ${s.targeting.join('; ')} => ${results(s.results, s.currency || c).join(' | ')}`));
            Object.entries(DIM).forEach(([k, l]) => { if ((D.ads.splits[k] || []).length) { out.push('', `## ${l} (last ${D.ads.splits_days} days)`); D.ads.splits[k].forEach(r => out.push(`- ${r.segment}: ${results(r, D.ads.currency || c).join(' | ')}`)); } });
            out.push('', '## Ads the team logged');
            D.ledger.forEach(r => out.push(`- ${r.creative || '—'} (${[r.format, r.angle, r.objective, r.audience].filter(Boolean).join(', ')}): ${results(r.results, c).slice(0, 3).join(' | ')}; ${[r.verdict, r.learned].filter(Boolean).join(': ')}`));
            out.push('', '## Benchmarks');
            if (D.benchmarks) { const B = D.benchmarks; out.push(`- ${B.businesses} similar businesses (${B.level}), last ${B.days} days, medians: cost per message ${money(B.cost_per_message.median, B.currency)}, cost per order ${money(B.cost_per_purchase.median, B.currency)}, CPM ${money(B.cpm.median, B.currency)}, CTR ${pct(B.ctr.median)}, ROAS ${B.roas.median ?? '—'}`); }
            else out.push('- None yet.');
            return out.join('\n');
        }

        // ---- the plan form ----------------------------------------------------------------------
        function planForm(row) {
            const p = row ? JSON.parse(JSON.stringify(row.plan || {})) : {
                objective: GOAL_TO_OBJECTIVE[D.brief.goal] || '', budget_type: 'daily', currency: cur(),
                total_budget: D.brief.monthly_budget ? Math.round(D.brief.monthly_budget / 30) : '', ad_sets: [{}], creatives: [{}]
            };
            const editable = D.canEdit;
            const dis = editable ? '' : 'disabled';
            const v = x => esc(x ?? '');
            const opt = (list, val) => `<option value=""></option>${list.map(o => { const [k, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(k)}" ${String(val ?? '') === String(k) ? 'selected' : ''}>${esc(l)}</option>`; }).join('')}`;
            const fld = (l, html, full) => `<div class="${full ? 'wb-full' : ''}"><label>${esc(l)}</label>${html}</div>`;
            const adSet = (a, i) => `<fieldset class="ab-fs" data-set="${i}"><legend>Ad set ${i + 1}${editable ? ` <button type="button" class="ws-btn is-sm is-quiet" data-drop-set="${i}">Remove</button>` : ''}</legend><div class="wb-fields">
                ${fld('Ad set name', `<input data-k="name" value="${v(a.name)}" ${dis}>`)}
                ${fld('Budget', `<input data-k="budget" inputmode="decimal" value="${v(a.budget)}" placeholder="Leave empty for a campaign budget" ${dis}>`)}
                ${fld('Locations', `<textarea data-k="locations" class="wb-area" placeholder="Dhaka (city) +10 km; Chattogram…" ${dis}>${v(a.locations)}</textarea>`, true)}
                ${fld('Radius (km)', `<input data-k="radius_km" inputmode="numeric" value="${v(a.radius_km)}" ${dis}>`)}
                ${fld('Genders', `<select data-k="genders" ${dis}>${opt([['all', 'All'], ['female', 'Women'], ['male', 'Men']], a.genders)}</select>`)}
                ${fld('Youngest age', `<input data-k="age_min" inputmode="numeric" value="${v(a.age_min)}" ${dis}>`)}
                ${fld('Oldest age', `<input data-k="age_max" inputmode="numeric" value="${v(a.age_max)}" placeholder="65 = 65+" ${dis}>`)}
                ${fld('Languages', `<input data-k="languages" value="${v(a.languages)}" placeholder="Bengali, English" ${dis}>`)}
                ${fld('Advantage+ audience', `<select data-k="advantage_audience" ${dis}>${opt([['on', 'On'], ['off', 'Off']], a.advantage_audience)}</select>`)}
                ${fld('Interests and behaviours', `<textarea data-k="interests" class="wb-area" ${dis}>${v(a.interests)}</textarea>`, true)}
                ${fld('Exclusions', `<textarea data-k="exclusions" class="wb-area" ${dis}>${v(a.exclusions)}</textarea>`, true)}
                ${fld('Custom and lookalike audiences', `<textarea data-k="custom_audiences" class="wb-area" placeholder="Page engagers 365 days; 1% lookalike of buyers…" ${dis}>${v(a.custom_audiences)}</textarea>`, true)}
                ${fld('Placements', `<select data-k="placements" ${dis}>${opt([['advantage', 'Advantage+ (all)'], ['manual', 'Manual']], a.placements)}</select>`)}
                ${fld('Which placements', `<input data-k="placements_detail" value="${v(a.placements_detail)}" placeholder="FB + IG feeds, Reels, Stories" ${dis}>`)}
                ${fld('Optimise for', `<input data-k="optimization" value="${v(a.optimization)}" placeholder="Conversations, Purchases, Landing page views…" ${dis}>`)}
                ${fld('Where people go', `<select data-k="destination" ${dis}>${opt(DESTINATIONS, a.destination)}</select>`)}
                ${fld('When it runs', `<input data-k="schedule" value="${v(a.schedule)}" placeholder="All day; or 10am–11pm" ${dis}>`)}
                ${fld('Bid strategy', `<input data-k="bid" value="${v(a.bid)}" placeholder="Highest volume; cost per result goal ৳…" ${dis}>`)}
                ${fld('Why this ad set', `<textarea data-k="why" class="wb-area" placeholder="Which figures above it rests on" ${dis}>${v(a.why)}</textarea>`, true)}
            </div></fieldset>`;
            const creative = (c, i) => `<fieldset class="ab-fs" data-cr="${i}"><legend>Creative idea ${i + 1}${editable ? ` <button type="button" class="ws-btn is-sm is-quiet" data-drop-cr="${i}">Remove</button>` : ''}</legend><div class="wb-fields">
                ${fld('Format', `<select data-k="format" ${dis}>${opt(FORMATS, c.format)}</select>`)}
                ${fld('Angle', `<input data-k="angle" value="${v(c.angle)}" placeholder="Offer, problem–solution, testimonial…" ${dis}>`)}
                ${fld('Product shown', `<input data-k="product" value="${v(c.product)}" ${dis}>`)}
                ${fld('Language', `<select data-k="language" ${dis}>${opt(['Bangla', 'English', 'Banglish'], c.language)}</select>`)}
                ${fld('Hook (first 3 seconds)', `<textarea data-k="hook" class="wb-area" ${dis}>${v(c.hook)}</textarea>`, true)}
                ${fld('Primary text', `<textarea data-k="copy" class="wb-area" ${dis}>${v(c.copy)}</textarea>`, true)}
                ${fld('Headline', `<input data-k="headline" value="${v(c.headline)}" ${dis}>`)}
                ${fld('Button', `<input data-k="cta" value="${v(c.cta)}" placeholder="Send message, Shop now…" ${dis}>`)}
                ${fld('Why this creative', `<textarea data-k="why" class="wb-area" ${dis}>${v(c.why)}</textarea>`, true)}
            </div></fieldset>`;

            const d = EL.drawer({
                wide: true, title: esc(row ? row.title : 'Plan an ad set'), sub: esc(ctx.clientName + (row ? ` · ${STATUS[row.status][0]}` : '')),
                body: `<form id="ab-plan-form">
                    <div class="wb-fields">
                        ${fld('Plan name', `<input name="title" value="${v(row ? row.title : '')}" placeholder="e.g. Eid combo, messages, Dhaka" ${dis}>`, true)}
                        ${fld('Campaign objective', `<select name="objective" ${dis}>${opt(OBJECTIVES, p.objective)}</select>`)}
                        ${fld('Budget type', `<select name="budget_type" ${dis}>${opt([['daily', 'Daily'], ['lifetime', 'Lifetime']], p.budget_type)}</select>`)}
                        ${fld('Campaign budget', `<input name="total_budget" inputmode="decimal" value="${v(p.total_budget)}" ${dis}>`)}
                        ${fld('Currency', `<input name="currency" value="${v(p.currency)}" ${dis}>`)}
                        ${fld('Start', `<input name="start_on" type="date" value="${v(p.start_on)}" ${dis}>`)}
                        ${fld('End', `<input name="end_on" type="date" value="${v(p.end_on)}" ${dis}>`)}
                        ${fld('The plan in short', `<textarea name="summary" class="wb-area" ${dis}>${v(p.summary)}</textarea>`, true)}
                    </div>
                    <h3 class="ab-h3">Ad sets</h3><div id="ab-sets">${(p.ad_sets || []).map(adSet).join('')}</div>
                    ${editable ? '<button type="button" class="ws-btn is-sm" id="ab-add-set">Add an ad set</button>' : ''}
                    <h3 class="ab-h3">Creative ideas <span class="el-muted">(suggestions; the media is made by the team)</span></h3><div id="ab-crs">${(p.creatives || []).map(creative).join('')}</div>
                    ${editable ? '<button type="button" class="ws-btn is-sm" id="ab-add-cr">Add a creative idea</button>' : ''}
                    <h3 class="ab-h3">Rules</h3>
                    <div class="wb-fields">
                        ${fld('Target cost per result', `<input name="target_cost" inputmode="decimal" value="${v(p.target_cost)}" ${dis}>`)}
                        ${fld('First check after', `<input name="check_after" value="${v(p.check_after)}" placeholder="3 days or ৳3,000 spent" ${dis}>`)}
                        ${fld('When to stop an ad set', `<textarea name="stop_rule" class="wb-area" ${dis}>${v(p.stop_rule)}</textarea>`, true)}
                        ${fld('When to scale up', `<textarea name="scale_rule" class="wb-area" ${dis}>${v(p.scale_rule)}</textarea>`, true)}
                        ${fld('What this plan is based on', `<textarea name="sources" class="wb-area" placeholder="The figures and notes from the brief it rests on" ${dis}>${v(p.sources)}</textarea>`, true)}
                        ${row ? fld('Review note', `<textarea name="review_note" class="wb-area" ${P.canDecide ? '' : 'disabled'}>${v(row.review_note)}</textarea>`, true) : ''}
                    </div>
                    <h3 class="ab-h3">Numbers the check-in judges against <span class="el-muted">(phase 87: the Ads check-in tab reads these)</span></h3>
                    <div class="wb-fields">
                        ${fld('Target cost per order', `<input name="target_cost_per_order" inputmode="decimal" value="${v(p.target_cost_per_order)}" placeholder="half the product’s break-even" ${dis}>`)}
                        ${fld('Highest CPM', `<input name="max_cpm" inputmode="decimal" value="${v(p.max_cpm)}" placeholder="empty: 1.5× the account’s" ${dis}>`)}
                        ${fld('Lowest stop-scroll %', `<input name="min_stop_scroll" inputmode="numeric" value="${v(p.min_stop_scroll)}" placeholder="25" ${dis}>`)}
                        ${fld('Highest 7-day frequency', `<input name="max_frequency" inputmode="decimal" value="${v(p.max_frequency)}" placeholder="3" ${dis}>`)}
                        ${fld('Meta campaign ids', `<input name="meta_campaign_ids" value="${v(p.meta_campaign_ids)}" placeholder="from Ads Manager, once it is built" ${dis}>`, true)}
                    </div>
                    <h3 class="ab-h3">The month’s forecast</h3>
                    <div class="wb-fields">
                        ${fld('Expected spend', `<input name="forecast_spend" inputmode="decimal" value="${v(p.forecast_spend)}" ${dis}>`)}
                        ${fld('Expected messages', `<input name="forecast_messages" inputmode="numeric" value="${v(p.forecast_messages)}" ${dis}>`)}
                        ${fld('Chats that become orders (%)', `<input name="forecast_order_rate" inputmode="numeric" value="${v(p.forecast_order_rate)}" placeholder="e.g. 20" ${dis}>`)}
                        ${fld('Expected orders', `<input name="forecast_orders" inputmode="numeric" value="${v(p.forecast_orders)}" ${dis}>`)}
                    </div>
                </form><div class="ws-note" id="ab-plan-note"></div>`,
                foot: `${row && editable ? '<button class="ws-btn is-danger" type="button" id="ab-plan-del">Delete</button>' : ''}<span style="flex:1"></span>
                    ${row && P.canDecide ? `${row.status !== 'rejected' ? '<button class="ws-btn" type="button" data-status="rejected">Reject</button>' : ''}
                        ${row.status === 'draft' || row.status === 'rejected' ? '<button class="ws-btn" type="button" data-status="approved">Approve</button>' : ''}
                        ${row.status === 'approved' ? '<button class="ws-btn" type="button" data-status="launched">Mark launched</button>' : ''}` : ''}
                    <button class="ws-btn" type="button" data-dw-close>Close</button>${editable ? `<button class="ws-btn is-gold" type="button" id="ab-plan-save">${row ? 'Save' : 'Save as draft'}</button>` : ''}`
            });
            const f = d.el.querySelector('#ab-plan-form'), note = d.el.querySelector('#ab-plan-note');
            const group = sel => [...f.querySelectorAll(sel)].map(fs => { const o = {}; fs.querySelectorAll('[data-k]').forEach(el => { if (el.value.trim() !== '') o[el.dataset.k] = el.value.trim(); }); return o; });
            const read = () => {
                const o = {};
                ['objective', 'budget_type', 'total_budget', 'currency', 'start_on', 'end_on', 'summary', 'target_cost', 'check_after', 'stop_rule', 'scale_rule', 'sources',
                    'target_cost_per_order', 'max_cpm', 'min_stop_scroll', 'max_frequency', 'meta_campaign_ids', 'forecast_spend', 'forecast_messages', 'forecast_order_rate', 'forecast_orders']
                    .forEach(k => { const el = f.querySelector(`[name="${k}"]`); if (el && el.value.trim() !== '') o[k] = el.value.trim(); });
                o.ad_sets = group('[data-set]'); o.creatives = group('[data-cr]');
                ['radius_km', 'age_min', 'age_max'].forEach(k => o.ad_sets.forEach(a => { if (a[k] !== undefined) a[k] = Number(a[k]); }));
                return o;
            };
            const renumber = () => {
                f.querySelectorAll('[data-set]').forEach((fs, i) => { fs.dataset.set = i; fs.querySelector('legend').firstChild.nodeValue = `Ad set ${i + 1} `; });
                f.querySelectorAll('[data-cr]').forEach((fs, i) => { fs.dataset.cr = i; fs.querySelector('legend').firstChild.nodeValue = `Creative idea ${i + 1} `; });
            };
            f.addEventListener('click', e => {
                const ds = e.target.closest('[data-drop-set], [data-drop-cr]');
                if (ds) { ds.closest('fieldset').remove(); renumber(); }
            });
            const addSet = d.el.querySelector('#ab-add-set');
            if (addSet) addSet.addEventListener('click', () => { const n = f.querySelectorAll('[data-set]').length; if (n >= 6) { note.textContent = 'Six ad sets at most.'; return; } f.querySelector('#ab-sets').insertAdjacentHTML('beforeend', adSet({}, n)); });
            const addCr = d.el.querySelector('#ab-add-cr');
            if (addCr) addCr.addEventListener('click', () => { const n = f.querySelectorAll('[data-cr]').length; if (n >= 8) { note.textContent = 'Eight creative ideas at most.'; return; } f.querySelector('#ab-crs').insertAdjacentHTML('beforeend', creative({}, n)); });
            const fail = err => { note.className = 'ws-note is-bad'; note.textContent = err.message || String(err); };
            const save = d.el.querySelector('#ab-plan-save');
            if (save) save.addEventListener('click', async () => {
                const title = f.querySelector('[name="title"]').value.trim();
                if (!title) return fail(new Error('Give the plan a name.'));
                save.disabled = true; note.className = 'ws-note'; note.textContent = 'Saving…';
                try {
                    const body = { title, plan: read() };
                    const rn = f.querySelector('[name="review_note"]'); if (rn && P.canDecide) body.review_note = rn.value;
                    if (row) await EL.api(`${base(id)}/ad-plans/${encodeURIComponent(row.id)}`, { method: 'PATCH', body });
                    else await EL.api(`${base(id)}/ad-plans`, { method: 'POST', body });
                    EL.toast(row && row.status !== 'draft' ? 'Saved. A changed plan is a draft again.' : 'Saved.');
                    d.close(); await reload();
                } catch (err) { fail(err); save.disabled = false; }
            });
            d.el.querySelectorAll('[data-status]').forEach(b => b.addEventListener('click', async () => {
                b.disabled = true;
                try {
                    const rn = f.querySelector('[name="review_note"]');
                    await EL.api(`${base(id)}/ad-plans/${encodeURIComponent(row.id)}`, { method: 'PATCH', body: { status: b.dataset.status, review_note: rn ? rn.value : undefined } });
                    EL.toast(`Marked ${STATUS[b.dataset.status][0].toLowerCase()}.`); d.close(); await reload();
                } catch (err) { fail(err); b.disabled = false; }
            }));
            const del = d.el.querySelector('#ab-plan-del');
            if (del) del.addEventListener('click', async () => {
                if (del.dataset.sure !== '1') { del.dataset.sure = '1'; del.textContent = 'Delete — press again'; return; }
                del.disabled = true;
                try { await EL.api(`${base(id)}/ad-plans/${encodeURIComponent(row.id)}`, { method: 'DELETE' }); d.close(); await reload(); } catch (err) { fail(err); del.disabled = false; }
            });
            return d;
        }

        // ---- drawing ----------------------------------------------------------------------------
        function draw() {
            host.innerHTML = `<div class="ab">
                <section class="ws-card ab-top" id="ab-gaps"><div class="ws-card-h"><h2>Ad brief</h2>
                    <div class="ws-actions" style="margin:0"><button class="ws-btn is-sm" type="button" id="ab-copy">Copy as text</button>${D.canEdit ? '<button class="ws-btn is-sm is-gold" type="button" id="ab-plan-top">Plan an ad set</button>' : ''}</div></div>
                    <p class="el-muted ab-sub">Everything needed to plan ${esc(D.client.name)}’s next ads, read top to bottom. Nothing here changes anything in Meta.</p>
                    ${D.gaps.length ? `<div class="wsc-banner wb-gap"><b>Still missing</b><ul class="ab-gaplist">${D.gaps.map(g => `<li>${esc(g)}</li>`).join('')}</ul></div>` : '<p class="el-chip is-jade">Nothing obvious is missing.</p>'}
                </section>
                ${briefPart()}${businessPart()}${productsPart()}${audiencePart()}${adsetsPart()}${splitsPart()}${ledgerPart()}${benchPart()}${plansPart()}
            </div>`;
            UI.cards(host);
            const save = host.querySelector('#ab-save');
            if (save) save.addEventListener('click', async () => {
                const form = host.querySelector('#ab-brief-form'), n = host.querySelector('#ab-note');
                const brief = {};
                form.querySelectorAll('input[name]:not([type=checkbox]), select[name], textarea[name]').forEach(el => { if (el.name !== 'observations' && el.value.trim() !== '') brief[el.name] = el.value.trim(); });
                brief.order_channels = [...form.querySelectorAll('[name="order_channels"]:checked')].map(x => x.value);
                save.disabled = true; n.className = 'ws-note'; n.textContent = 'Saving…';
                try {
                    await EL.api(`${base(id)}/ad-brief`, { method: 'PUT', body: { brief, observations: host.querySelector('#ab-obs').value } });
                    EL.toast('Brief saved.'); await reload();
                } catch (err) { n.className = 'ws-note is-bad'; n.textContent = err.message; save.disabled = false; }
            });
            host.querySelector('#ab-copy').addEventListener('click', () => {
                const text = asText();
                try { navigator.clipboard.writeText(text).then(() => EL.toast('Copied: the whole brief as text.'), () => EL.toast('Could not copy here.', 'bad')); } catch { EL.toast('Could not copy here.', 'bad'); }
            });
            ['#ab-plan-top', '#ab-new-plan'].forEach(s => { const b = host.querySelector(s); if (b) b.addEventListener('click', () => planForm(null)); });
            host.querySelectorAll('[data-plan]').forEach(b => b.addEventListener('click', () => planForm(P.plans.find(p => p.id === b.dataset.plan))));
        }
        draw();
    }

    window.AdBrief = { mount };
})();
