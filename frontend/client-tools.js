/**
 * EDGELEAD :: THE CLIENT'S WORKBOOK  (phase 69)
 * ---------------------------------------------------------------------------
 * Three tabs on a client's page for what the team types in by hand. Load after
 * header.js and ui.js. Everything is saved on the server, under the client.
 *
 *   Tools.contentPlan(host, ctx)   the plan the team writes, with the ideas the
 *                                  tool built from scraped posts beside it
 *   Tools.adLedger(host, ctx)      products & stock, ad creatives, ad runs
 *                                  (planned next and done), and what they add up to
 *   Tools.templates(host, ctx)     saved replies with pictures, to copy into
 *                                  Meta Business Suite
 *
 *   ctx = { clientId, clientName }
 *
 * The ideas are only ever shown: copying one into the plan is a person's
 * choice, and the row is theirs from then on (rule 3 — what a tool read and
 * what a person wrote are not mixed).
 * ---------------------------------------------------------------------------
 */
(function () {
    'use strict';
    const esc = v => EL.esc(v);
    const ic = n => EL.icon(n);

    // ---- talking to the server ----------------------------------------------
    const base = id => `/api/clients/${encodeURIComponent(id)}`;
    const load = (id, parts) => EL.api(`/api/clients/${encodeURIComponent(id)}/workbook?parts=${parts}`);
    const addRow = (id, kind, row) => EL.api(`/api/clients/${encodeURIComponent(id)}/workbook/${kind}`, { method: 'POST', body: row });
    const addRows = (id, kind, rows) => EL.api(`/api/clients/${encodeURIComponent(id)}/workbook/${kind}`, { method: 'POST', body: { rows } });
    const editRow = (id, kind, rowId, patch) => EL.api(`/api/clients/${encodeURIComponent(id)}/workbook/${kind}/${encodeURIComponent(rowId)}`, { method: 'PATCH', body: patch });
    const dropRow = (id, kind, rowId) => EL.api(`/api/clients/${encodeURIComponent(id)}/workbook/${kind}/${encodeURIComponent(rowId)}`, { method: 'DELETE' });
    const ideasFor = id => EL.api(`/api/clients/${encodeURIComponent(id)}/workbook-ideas`).catch(() => ({ plans: [] }));

    // ---- small formatters ---------------------------------------------------
    const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
    const has = v => v !== null && v !== undefined && v !== '';
    const tk = v => '৳' + Math.round(num(v)).toLocaleString('en-IN');
    const tk2 = v => v == null ? '—' : '৳' + num(v).toLocaleString('en-IN', { maximumFractionDigits: 1 });
    const pct = v => v == null ? '—' : (v * 100).toFixed(2) + '%';
    const fmt = v => Math.round(num(v)).toLocaleString('en-IN');
    const ratio = (a, b) => (b > 0 ? a / b : null);
    const roasTxt = v => (v != null ? v.toFixed(2) + '×' : '—');
    const today = () => new Date().toISOString().slice(0, 10);
    const dayName = iso => {
        if (!iso) return '';
        const d = new Date(iso + 'T00:00:00Z');
        return isNaN(d) ? iso : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: d.getUTCFullYear() === new Date().getUTCFullYear() ? undefined : 'numeric', timeZone: 'UTC' });
    };
    const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
    const migrationNote = err => err && err.code === 'migration_required'
        ? `<div class="ws-empty">${ic('alert')}<h3>One database update first</h3><p>${esc(err.message)}</p></div>` : null;

    async function copyText(text) {
        try { await navigator.clipboard.writeText(text); EL.toast('Copied. Paste it in the chat.'); }
        catch { EL.toast('The browser would not copy. Select the text and copy it.', 'bad'); }
    }
    /** A picture onto the clipboard, as PNG: the one picture type every browser pastes. */
    async function copyImage(url) {
        try {
            if (!window.ClipboardItem || !navigator.clipboard || !navigator.clipboard.write) throw new Error('unsupported');
            const png = (async () => {
                const blob = await (await fetch(url)).blob();
                if (blob.type === 'image/png') return blob;
                const bmp = await createImageBitmap(blob);
                const cv = document.createElement('canvas');
                cv.width = bmp.width; cv.height = bmp.height;
                cv.getContext('2d').drawImage(bmp, 0, 0);
                return new Promise((ok, no) => cv.toBlob(b => (b ? ok(b) : no(new Error('png'))), 'image/png'));
            })();
            // Safari wants the item made inside the click, with the picture still on its way.
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
            EL.toast('Picture copied. Paste it in the chat.');
        } catch { EL.toast('This browser could not copy the picture. Use Download, then attach it.', 'bad'); }
    }
    const downloadUrl = url => url + (url.includes('?') ? '&' : '?') + 'download=';

    // ---- one form, in the side drawer ---------------------------------------
    // A field: { k, l, t: 'text'|'area'|'number'|'date'|'select'|'url', opts, list, full, ph, hint, big }
    function fieldHtml(fd, v, dis) {
        const id = 'wb-f-' + fd.k;
        const val = v === null || v === undefined ? '' : v;
        const ph = fd.ph ? ` placeholder="${esc(fd.ph)}"` : '';
        let input;
        if (fd.t === 'area') input = `<textarea id="${id}" name="${fd.k}" class="wb-area${fd.big ? ' is-big' : ''}"${ph} ${dis}>${esc(val)}</textarea>`;
        else if (fd.t === 'select') input = `<select id="${id}" name="${fd.k}" ${dis}>${fd.blank === false ? '' : '<option value=""></option>'}${fd.opts.map(o => { const [k, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(k)}" ${String(k) === String(val) ? 'selected' : ''}>${esc(l)}</option>`; }).join('')}</select>`;
        else {
            const type = fd.t === 'number' ? 'text' : fd.t === 'date' ? 'date' : fd.t === 'url' ? 'url' : 'text';
            const extra = fd.t === 'number' ? ' inputmode="decimal"' : '';
            const list = fd.list ? ` list="${id}-l"` : '';
            input = `<input id="${id}" name="${fd.k}" type="${type}" value="${esc(val)}"${ph}${extra}${list} ${dis}>${fd.list ? `<datalist id="${id}-l">${fd.list.map(o => `<option value="${esc(o)}">`).join('')}</datalist>` : ''}`;
        }
        return `<div class="${fd.full ? 'wb-full' : ''}"><label for="${id}">${esc(fd.l)}</label>${input}${fd.hint ? `<div class="ws-hint">${esc(fd.hint)}</div>` : ''}</div>`;
    }
    function readForm(root, fields) {
        const out = {};
        for (const fd of fields) {
            if (fd.t === 'custom') continue;
            const el = root.querySelector(`[name="${fd.k}"]`);
            if (el) out[fd.k] = el.value.trim() === '' ? null : el.value;
        }
        return out;
    }

    /**
     * Open a row in the drawer. `top` and `bottom` are extra HTML around the fields;
     * `wire(d)` runs after drawing. onSave(data) returns a promise; a thrown error stays in the drawer.
     */
    function openForm({ title, sub = '', fields, row, canEdit, top = '', bottom = '', wire, onSave, onDelete, wide = true }) {
        const dis = canEdit ? '' : 'disabled';
        const d = EL.drawer({
            wide, title: esc(title), sub: esc(sub),
            body: `${top}<div class="wb-fields">${fields.map(fd => (fd.t === 'custom' ? fd.html : fieldHtml(fd, row ? row[fd.k] : fd.dflt, dis))).join('')}</div>${bottom}<div class="ws-note" id="wb-note"></div>`,
            foot: canEdit ? `${row && row.id && onDelete ? '<button class="ws-btn is-danger" type="button" id="wb-del">Delete</button>' : ''}<span style="flex:1"></span>
                <button class="ws-btn" type="button" data-dw-close>Cancel</button><button class="ws-btn is-gold" type="button" id="wb-save">Save</button>` : ''
        });
        const note = d.el.querySelector('#wb-note');
        const fail = err => { note.className = 'ws-note is-bad'; note.textContent = err.message || String(err); };
        const save = d.el.querySelector('#wb-save');
        if (save) save.addEventListener('click', async () => {
            save.disabled = true; note.className = 'ws-note'; note.textContent = 'Saving…';
            try { await onSave(readForm(d.el, fields), d); d.close(); }
            catch (err) { fail(err); save.disabled = false; }
        });
        const del = d.el.querySelector('#wb-del');
        if (del) del.addEventListener('click', async () => {
            if (del.dataset.sure !== '1') { del.dataset.sure = '1'; del.textContent = 'Delete — press again'; return; }
            del.disabled = true;
            try { await onDelete(); d.close(); } catch (err) { fail(err); del.disabled = false; }
        });
        if (wire) wire(d);
        return d;
    }

    // ---- pasting rows copied from a sheet ------------------------------------
    /** Rows of cells from text copied out of Google Sheets or Excel (tabs), or a CSV. Quoted cells may hold new lines. */
    function parseSheet(text) {
        text = String(text || '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
        if (!text.trim()) return [];
        const firstLine = text.split('\n')[0];
        const sep = firstLine.includes('\t') ? '\t' : ',';
        const rows = []; let row = [], cell = '', quoted = false;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (quoted) {
                if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
                else if (ch === '"') quoted = false;
                else cell += ch;
            } else if (ch === '"' && cell === '') quoted = true;
            else if (ch === sep) { row.push(cell); cell = ''; }
            else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
            else cell += ch;
        }
        row.push(cell); rows.push(row);
        return rows.map(r => r.map(c => c.trim()));
    }
    /** A typed date as yyyy-mm-dd. Day first (27/10/2026), as Bangladesh writes it; ISO passes through. */
    function sheetDate(s) {
        s = String(s || '').trim();
        if (!s) return null;
        let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
        if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
        m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
        if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
        const d = new Date(s);
        return isNaN(d) ? s : new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString().slice(0, 10);
    }
    // Which column is which, from the header's words. First rule that matches a header wins; a field is taken once.
    const SHEET_RULES = {
        content: [
            ['planned_on', /date|day|when/i], ['platform', /platform|channel/i], ['post_type', /type|format/i],
            ['caption', /caption/i], ['idea', /descr|script|idea|vision|concept|brief|content/i],
            ['status', /status/i], ['posted_url', /link|url/i], ['notes', /note|comment|remark/i]
        ],
        products: [
            ['combo_price', /comb?o+/i], ['cost', /buy|cost|purchase/i], ['price', /customer|sell|sale|retail|mrp|price/i],
            ['in_order', /in\s*order|ordered|incoming/i], ['stock', /quantity|qty|stock|in\s*hand/i],
            ['name', /product|item|name/i], ['category', /categor/i], ['sku', /sku|code/i], ['notes', /note|remark/i]
        ]
    };
    const CONTENT_STATUS = [['planned', 'Planned'], ['made', 'Made'], ['posted', 'Posted'], ['skipped', 'Skipped']];
    // Phase 78: the business owner's answer to a typed post, from "Posts to approve" in Edge Meta AI.
    const OWNER_SAID = { approved: 'Owner approved', changes: 'Owner asked for changes', skipped: 'Owner skipped it' };
    function mapSheet(kind, rows) {
        if (rows.length < 2) return { cols: [], items: [], skipped: 0 };
        const head = rows[0];
        const taken = new Set();
        const cols = head.map(h => {
            if (!h) return null;
            const hit = SHEET_RULES[kind].find(([k, re]) => !taken.has(k) && re.test(h));
            if (!hit) return null;
            taken.add(hit[0]); return hit[0];
        });
        let skipped = 0;
        const items = [];
        for (const r of rows.slice(1)) {
            const o = {};
            cols.forEach((k, i) => { if (k && has(r[i])) o[k] = r[i]; });
            if (kind === 'products') {
                if (!o.name) { if (Object.keys(o).length || r.some(Boolean)) skipped++; continue; }
                if (o.stock !== undefined && /stock\s*out|out\s*of\s*stock|^none$/i.test(o.stock)) o.stock = '0';
                for (const k of ['stock', 'in_order', 'cost', 'price', 'combo_price']) if (o[k] !== undefined) o[k] = String(o[k]).replace(/[৳,\s]/g, '');
            } else {
                if (!o.planned_on && !o.idea && !o.caption) { if (r.some(Boolean)) skipped++; continue; }
                if (o.planned_on) o.planned_on = sheetDate(o.planned_on);
                if (o.status) { const st = CONTENT_STATUS.find(([k, l]) => k === o.status.toLowerCase() || l.toLowerCase() === o.status.toLowerCase()); o.status = st ? st[0] : 'planned'; }
            }
            items.push(o);
        }
        return { cols: head.map((h, i) => ({ h, k: cols[i] })), items, skipped };
    }
    function pasteSheet({ kind, clientId, title, sub, labels, onDone }) {
        let mapped = { cols: [], items: [], skipped: 0 };
        const d = EL.drawer({
            wide: 'xl', title: esc(title), sub: esc(sub),
            body: `<textarea id="wb-paste" class="wb-area is-big" placeholder="Paste here (Ctrl+V)"></textarea>
                <div id="wb-paste-out" class="wb-paste-out"></div><div class="ws-note" id="wb-paste-note"></div>`,
            foot: `<span style="flex:1"></span><button class="ws-btn" type="button" data-dw-close>Cancel</button><button class="ws-btn is-gold" type="button" id="wb-paste-go" disabled>Add the rows</button>`
        });
        const out = d.el.querySelector('#wb-paste-out'), go = d.el.querySelector('#wb-paste-go'), note = d.el.querySelector('#wb-paste-note');
        const shown = Object.keys(labels);
        d.el.querySelector('#wb-paste').addEventListener('input', e => {
            mapped = mapSheet(kind, parseSheet(e.target.value));
            note.className = 'ws-note'; note.textContent = '';
            go.disabled = !mapped.items.length;
            go.textContent = mapped.items.length ? `Add ${mapped.items.length} row${mapped.items.length === 1 ? '' : 's'}` : 'Add the rows';
            if (!mapped.cols.length) { out.innerHTML = e.target.value.trim() ? '<p class="el-muted">Copy the header row too, so each column can be matched.</p>' : ''; return; }
            out.innerHTML = `<div class="wb-cols">${mapped.cols.filter(c => c.h).map(c => `<span class="el-chip ${c.k ? 'is-jade' : ''}">${esc(clip(c.h, 34))} → ${c.k ? esc(labels[c.k] || c.k) : 'not used'}</span>`).join('')}</div>
                ${mapped.items.length ? `<div class="ws-table-wrap"><table class="ws-table"><thead><tr>${shown.map(k => `<th>${esc(labels[k])}</th>`).join('')}</tr></thead>
                <tbody>${mapped.items.slice(0, 8).map(o => `<tr>${shown.map(k => `<td>${esc(clip(o[k] || '', 80))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
                ${mapped.items.length > 8 ? `<p class="el-muted">…and ${mapped.items.length - 8} more.</p>` : ''}` : ''}
                ${mapped.skipped ? `<p class="el-muted">${mapped.skipped} row${mapped.skipped === 1 ? '' : 's'} without ${kind === 'products' ? 'a product name' : 'a date or a description'} will be left out.</p>` : ''}`;
        });
        go.addEventListener('click', async () => {
            go.disabled = true; note.className = 'ws-note'; note.textContent = 'Adding…';
            try { const r = await addRows(clientId, kind, mapped.items); EL.toast(`${r.added} row${r.added === 1 ? '' : 's'} added.`); d.close(); onDone(); }
            catch (err) {
                note.className = 'ws-note is-bad';
                note.innerHTML = esc(err.message) + (err.data && (err.data.problems || []).length > 1 ? `<ul>${err.data.problems.slice(1, 6).map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : '');
                go.disabled = false;
            }
        });
    }

    // =========================================================================
    // CONTENT PLAN
    // =========================================================================
    const PLATFORMS = ['Facebook', 'Instagram', 'Facebook + Instagram', 'TikTok', 'YouTube', 'WhatsApp'];
    const POST_TYPES = ['Static', 'Video reel', 'Carousel', 'Story', 'Live', 'Text post'];
    const CONTENT_LABELS = { planned_on: 'Date', platform: 'Platform', post_type: 'Type of post', idea: 'Description', caption: 'Caption', status: 'Status', posted_url: 'Post link', notes: 'Notes' };
    const contentFields = () => [
        { k: 'planned_on', l: 'Date', t: 'date' },
        { k: 'platform', l: 'Platform', list: PLATFORMS, ph: 'Facebook' },
        { k: 'post_type', l: 'Type of post', list: POST_TYPES, ph: 'Static, video reel, carousel…' },
        { k: 'status', l: 'Status', t: 'select', opts: CONTENT_STATUS, blank: false, dflt: 'planned' },
        { k: 'idea', l: 'Description, script or idea', t: 'area', big: true, full: true, ph: 'What the post is: the idea, the script, what to show, the vision for it' },
        { k: 'caption', l: 'Caption', t: 'area', full: true, ph: 'The text that goes with it' },
        { k: 'posted_url', l: 'Post link, once it is out', t: 'url', full: true, ph: 'https://' },
        { k: 'notes', l: 'Notes', t: 'area', full: true }
    ];

    function ideaCards(plans, { use = false } = {}) {
        if (!plans.length) return '<p class="el-muted">No content plan has been built for this client yet. Build one under New work → Content plan: it reads the posts of this client and its rivals and suggests what to post.</p>';
        return plans.map((p, pi) => `<div class="wb-plan">
            <div class="wb-plan-h"><b>${esc(p.target ? (p.platform === 'instagram' ? '@' + p.target : p.target) : 'Content plan')}</b> <span class="el-muted">${esc(UI.day(p.createdAt))}</span> ${UI.srcChip('reports')}</div>
            ${p.summary ? `<p class="wb-sum">${esc(clip(p.summary, 400))}</p>` : ''}
            ${p.briefs.map((b, bi) => `<div class="wb-idea">
                <div class="wb-idea-h"><span class="el-chip">${esc(b.format)}</span>${b.slot ? `<span class="el-muted">${esc(b.slot)}</span>` : ''}</div>
                ${b.hook ? `<div class="wb-idea-t">${esc(b.hook)}</div>` : ''}
                ${b.concept ? `<div class="wb-idea-c">${esc(b.concept)}</div>` : ''}
                ${b.script.length || b.caption || b.why ? `<details class="wb-more"><summary>More</summary>
                    ${b.script.length ? `<ol>${b.script.map(s => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}
                    ${b.caption ? `<div class="wb-idea-cap">${esc(b.caption)}</div>` : ''}
                    ${b.why ? `<div class="el-muted">Why: ${esc(b.why)}</div>` : ''}</details>` : ''}
                ${use ? `<button class="ws-btn is-sm" type="button" data-use="${pi}:${bi}">${ic('plus')}Use as a start</button>` : ''}
            </div>`).join('')}
            ${p.stopDoing.length ? `<details class="wb-more"><summary>Stop doing</summary><ul>${p.stopDoing.map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>` : ''}
            ${p.captionRules.length ? `<details class="wb-more"><summary>Caption rules</summary><ul>${p.captionRules.map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>` : ''}
        </div>`).join('');
    }
    /** An idea as the start of a typed row. The person edits it; the tool never writes the row. */
    function ideaToRow(b) {
        const idea = [b.hook, b.concept, b.script.length ? b.script.map((s, i) => `${i + 1}. ${s}`).join('\n') : ''].filter(Boolean).join('\n\n');
        const type = /reel|video/i.test(b.format) ? 'Video reel' : /carousel/i.test(b.format) ? 'Carousel' : /still|image|photo/i.test(b.format) ? 'Static' : b.format;
        return { post_type: type, idea: idea || null, caption: b.caption || null };
    }

    async function contentPlan(host, ctx) {
        const id = ctx.clientId;
        let rows = [], canEdit = false, plans = [], filter = 'upcoming';
        try {
            const [d, ideas] = await Promise.all([load(id, 'content'), ideasFor(id)]);
            rows = d.content || []; canEdit = d.canEdit; plans = ideas.plans || [];
        } catch (err) { host.innerHTML = migrationNote(err) || `<div class="ws-empty">${ic('alert')}<p>${esc(err.message)}</p></div>`; return; }
        const reload = async () => { const d = await load(id, 'content'); rows = d.content || []; draw(); };

        // Phase 78: a saved post can become an ad creative in the ad ledger, linked to it, so it is
        // entered once. The owner's answer from "Posts to approve" shows above the fields.
        const linkBox = row => {
            if (!row || !row.id) return '';
            if (row.creative) return `<div class="wb-link-box">${ic('check')}<span>In the ad ledger as <b>${esc(row.creative.title)}</b>. Its spend and results go on that creative.</span></div>`;
            return canEdit ? `<div class="wb-link-box"><span>Running this post as an ad? Make it a creative in the ad ledger, filled from this post and linked to it.</span><button class="ws-btn is-sm" type="button" id="cp-creative">Use as ad creative</button></div>` : '';
        };
        const ownerBox = row => !row || !row.owner_decision ? ''
            : `<div class="wb-owner is-${esc(row.owner_decision)}"><b>${esc(OWNER_SAID[row.owner_decision] || row.owner_decision)}</b>${row.owner_note ? `<span>“${esc(row.owner_note)}”</span>` : ''}</div>`;
        const open = (row, start) => openForm({
            title: row ? 'Edit post' : 'Add a post', sub: ctx.clientName, fields: contentFields(), row: row || start || null, canEdit,
            top: ownerBox(row) + linkBox(row),
            bottom: plans.length ? `<details class="wb-more wb-ref"><summary>Ideas from the data, for reference</summary>${ideaCards(plans, { use: canEdit })}</details>` : '',
            wire: d => {
                d.el.querySelectorAll('[data-use]').forEach(b => b.addEventListener('click', () => {
                    const [pi, bi] = b.dataset.use.split(':').map(Number);
                    const s = ideaToRow(plans[pi].briefs[bi]);
                    for (const [k, v] of Object.entries(s)) {
                        const el = d.el.querySelector(`[name="${k}"]`); if (!el || !v) continue;
                        el.value = el.value.trim() && k === 'idea' ? `${el.value.trim()}\n\n${v}` : (el.value.trim() || v);
                    }
                    EL.toast('Copied into the form. Change it as you like.');
                }));
                const mk = d.el.querySelector('#cp-creative');
                if (mk) mk.addEventListener('click', async () => {
                    mk.disabled = true; mk.textContent = 'Making it…';
                    try {
                        const r = await EL.api(`${base(id)}/workbook/content/${encodeURIComponent(row.id)}/creative`, { method: 'POST' });
                        EL.toast(r.existing ? 'It is already in the ad ledger.' : 'Added to the ad ledger, under Creatives. Log its ads there.');
                        d.close(); await reload();
                    } catch (err) { mk.disabled = false; mk.textContent = 'Use as ad creative'; EL.toast(err.message, 'bad'); }
                });
            },
            onSave: async data => { if (row) await editRow(id, 'content', row.id, data); else await addRow(id, 'content', data); EL.toast('Saved.'); await reload(); },
            onDelete: async () => { await dropRow(id, 'content', row.id); EL.toast('Deleted.'); await reload(); }
        });

        // In the table: the description's first line as the title, then the rest of it, else the caption.
        const firstLine = v => String(v || '').split('\n').map(x => x.trim()).find(Boolean) || '';
        const rest = r => { const lines = String(r.idea || '').split('\n').map(x => x.trim()).filter(Boolean); return (r.idea ? lines.slice(1).join(' · ') : '') || (r.idea ? r.caption || '' : ''); };
        function draw() {
            const t = today();
            const isPast = r => r.planned_on && r.planned_on < t;
            const lists = {
                upcoming: rows.filter(r => !isPast(r)),
                past: rows.filter(isPast).reverse(),
                all: rows
            };
            const list = lists[filter];
            const late = rows.filter(r => isPast(r) && r.status === 'planned').length;
            const posted = rows.filter(r => r.status === 'posted').length;
            const wideOpen = window.innerWidth > 1100 ? 'open' : '';
            host.innerHTML = `
                <div class="ws-head"><div><h2 class="wb-h">Content plan for ${esc(ctx.clientName)}</h2>
                    <p class="ws-sub">What the team will post, typed in here. ${rows.length ? `${rows.length} post${rows.length === 1 ? '' : 's'} · ${posted} posted${late ? ` · <b class="wb-bad">${late} past their date and not made</b>` : ''}.` : 'Add posts one by one, or paste the rows of your Google Sheet.'}</p></div>
                    ${canEdit ? `<div class="ws-actions"><button class="ws-btn" type="button" id="cp-paste">Paste from a sheet</button><button class="ws-btn is-gold" type="button" id="cp-add">${ic('plus')}Add a post</button></div>` : ''}</div>
                <div class="wb-split">
                    <div class="wb-main">
                        <div class="ws-filters">${[['upcoming', 'Today and later'], ['past', 'Past'], ['all', 'All']].map(([k, l]) => `<button type="button" data-f="${k}" aria-pressed="${filter === k}">${l} <span class="ws-num">${lists[k].length}</span></button>`).join('')}</div>
                        ${list.length ? `<div class="ws-table-wrap"><table class="ws-table wb-table"><thead><tr><th>Date</th><th>Platform</th><th>Type of post</th><th>Description</th><th>Status</th></tr></thead><tbody>
                            ${list.map(r => `<tr class="is-link" data-row="${esc(r.id)}" tabindex="0">
                                <td class="ws-nowrap ${isPast(r) && r.status === 'planned' ? 'wb-bad' : ''}">${esc(dayName(r.planned_on) || 'No date')}</td>
                                <td>${esc(r.platform || '—')}</td><td>${esc(r.post_type || '—')}</td>
                                <td><div class="t">${esc(clip(firstLine(r.idea || r.caption), 140)) || '—'}</div>${rest(r) ? `<div class="s">${esc(clip(rest(r), 110))}</div>` : ''}${r.posted_url ? `<div class="s"><a class="ws-link" href="${esc(r.posted_url)}" target="_blank" rel="noopener" data-stop>Open the post</a></div>` : ''}${(r.owner_decision || r.creative) ? `<div class="wb-tags">${r.owner_decision ? `<span class="el-chip ${r.owner_decision === 'approved' ? 'is-jade' : 'is-warn'}" title="${esc(r.owner_note || '')}">${esc(OWNER_SAID[r.owner_decision] || r.owner_decision)}</span>` : ''}${r.creative ? '<span class="el-chip">Ad creative</span>' : ''}</div>` : ''}</td>
                                <td data-stop>${canEdit ? `<select class="wb-status is-${esc(r.status)}" data-status="${esc(r.id)}" aria-label="Status">${CONTENT_STATUS.map(([k, l]) => `<option value="${k}" ${k === r.status ? 'selected' : ''}>${l}</option>`).join('')}</select>` : `<span class="wb-status is-${esc(r.status)}">${esc((CONTENT_STATUS.find(s => s[0] === r.status) || [, r.status])[1])}</span>`}</td></tr>`).join('')}
                        </tbody></table></div>`
                        : `<div class="ws-empty">${ic('doc')}<h3>${filter === 'past' ? 'Nothing in the past' : 'Nothing planned yet'}</h3><p>${canEdit ? 'Add a post, or copy your content sheet (date, platform, type of post, description, with its header row) and use Paste from a sheet.' : 'The team has not planned any posts here yet.'}</p></div>`}
                    </div>
                    <aside class="wb-side"><details class="wb-panel" ${wideOpen}><summary><b>Ideas from the data</b> <span class="el-muted">${plans.length ? 'from the content plan tool' : 'none yet'}</span></summary>
                        <p class="el-muted wb-side-note">Built from the posts the tool read for ${esc(ctx.clientName)} and its rivals. For ideas only: nothing here goes into the plan unless you copy it.</p>
                        ${ideaCards(plans, { use: canEdit })}</details></aside>
                </div>`;
            host.querySelectorAll('[data-f]').forEach(b => b.addEventListener('click', () => { filter = b.dataset.f; draw(); }));
            host.querySelectorAll('[data-stop]').forEach(el => el.addEventListener('click', e => e.stopPropagation()));
            host.querySelectorAll('[data-row]').forEach(tr => {
                const go = () => open(rows.find(r => r.id === tr.dataset.row));
                tr.addEventListener('click', go);
                tr.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target === tr) go(); });
            });
            host.querySelectorAll('[data-status]').forEach(s => s.addEventListener('change', async () => {
                s.disabled = true;
                try { await editRow(id, 'content', s.dataset.status, { status: s.value }); const r = rows.find(x => x.id === s.dataset.status); if (r) r.status = s.value; s.className = 'wb-status is-' + s.value; EL.toast('Status saved.'); }
                catch (err) { EL.toast(err.message, 'bad'); }
                s.disabled = false;
            }));
            host.querySelectorAll('.wb-side [data-use]').forEach(b => b.addEventListener('click', () => {
                const [pi, bi] = b.dataset.use.split(':').map(Number);
                open(null, { ...ideaToRow(plans[pi].briefs[bi]), status: 'planned' });
            }));
            const add = host.querySelector('#cp-add'); if (add) add.addEventListener('click', () => open(null));
            const paste = host.querySelector('#cp-paste'); if (paste) paste.addEventListener('click', () => pasteSheet({
                kind: 'content', clientId: id, title: 'Paste the content plan from a sheet',
                sub: 'In Google Sheets, select the rows with their header row (date, platform, type of post, description), copy, and paste below. Dates like 27/10/2026 are read day first.',
                labels: CONTENT_LABELS, onDone: reload
            }));
        }
        draw();
    }

    // =========================================================================
    // AD LEDGER (with products and stock)
    // =========================================================================
    const LOW_STOCK = 10;
    const FORMATS = ['Reel', 'Image', 'Carousel', 'Video', 'Story', 'Influencer reel', 'Live'];
    const ANGLES = ['Problem–solution', 'Before–after', 'Offer / discount', 'Combo / bundle', 'Testimonial / review', 'Unboxing', 'How to use', 'Influencer talk', 'Trending audio', 'Other'];
    const OBJECTIVES = ['Messages', 'Purchases', 'Both', 'Engagement', 'Traffic'];
    const VERDICTS = ['Winner', 'OK', 'Loser', 'Too early'];
    const PLACES = ['Boost from page', 'Ads Manager'];
    const AD_STATUS = [['planned', 'Planned next'], ['running', 'Running'], ['done', 'Done']];
    const PRODUCT_LABELS = { name: 'Product name', stock: 'Quantity', in_order: 'In order', cost: 'Buying price', price: 'Customer price', combo_price: 'Combo price', category: 'Category', sku: 'Code', notes: 'Notes' };

    function metrics(r) {
        const spend = num(r.spend), imp = num(r.impressions), clicks = num(r.clicks), msg = num(r.messages), ord = num(r.orders), rev = num(r.revenue), reach = num(r.reach);
        return { spend, imp, clicks, msg, ord, rev, reach,
            cpm: imp ? spend / imp * 1000 : null, ctr: ratio(clicks, imp), cpmsg: ratio(spend, msg), cpo: ratio(spend, ord),
            roas: ratio(rev, spend), conv: ratio(ord, msg), freq: ratio(imp, reach) };
    }
    function sum(rows) {
        const t = { spend: 0, impressions: 0, clicks: 0, messages: 0, orders: 0, revenue: 0, reach: 0 };
        rows.forEach(r => Object.keys(t).forEach(k => { t[k] += num(r[k]); }));
        return metrics(t);
    }

    async function adLedger(host, ctx) {
        const id = ctx.clientId;
        let P = [], C = [], A = [], canEdit = false, view = 'overview', adFilter = 'all', q = '';
        try {
            const d = await load(id, 'products,creatives,ads');
            P = d.products || []; C = d.creatives || []; A = d.ads || []; canEdit = d.canEdit;
        } catch (err) { host.innerHTML = migrationNote(err) || `<div class="ws-empty">${ic('alert')}<p>${esc(err.message)}</p></div>`; return; }
        const reload = async () => { const d = await load(id, 'products,creatives,ads'); P = d.products || []; C = d.creatives || []; A = d.ads || []; draw(); };

        const ran = () => A.filter(r => r.status !== 'planned');
        const prodName = pid => (P.find(p => p.id === pid) || {}).name || 'Removed product';
        const creative = cid => C.find(c => c.id === cid);
        const runsOf = c => ran().filter(r => r.creative_id === c.id);
        const cs = c => sum(runsOf(c));
        const prodSpend = pid => {
            let t = 0;
            C.filter(c => (c.product_ids || []).includes(pid)).forEach(c => { const n = (c.product_ids || []).length || 1; runsOf(c).forEach(r => { t += num(r.spend) / n; }); });
            return t;
        };
        const stockTag = p => !has(p.stock) ? '' : num(p.stock) === 0 ? '<span class="el-chip is-bad">Stock out</span>' : num(p.stock) <= LOW_STOCK ? '<span class="el-chip is-warn">Low</span>' : '';
        const adName = r => { const c = creative(r.creative_id); return c ? c.title : (r.campaign || (r.creative_id ? 'Removed creative' : 'No creative yet')); };

        // ---- forms ----
        const productForm = row => openForm({
            title: row ? 'Edit product' : 'Add a product', sub: ctx.clientName, row, canEdit,
            fields: [
                { k: 'name', l: 'Product name', full: true },
                { k: 'category', l: 'Category', ph: 'Skincare, hair, combo…' }, { k: 'sku', l: 'Code', ph: 'Optional' },
                { k: 'stock', l: 'Quantity in hand', t: 'number', hint: '0 means stock out. Leave empty if you do not count it.' },
                { k: 'in_order', l: 'In order', t: 'number', hint: 'Ordered from the supplier, not arrived yet.' },
                { k: 'cost', l: 'Buying price (৳)', t: 'number' }, { k: 'price', l: 'Customer price (৳)', t: 'number' },
                { k: 'combo_price', l: 'Combo price (৳)', t: 'number' },
                { k: 'notes', l: 'Notes', t: 'area', full: true }
            ],
            onSave: async data => { if (row) await editRow(id, 'products', row.id, data); else await addRow(id, 'products', data); EL.toast('Saved.'); await reload(); },
            onDelete: async () => { await dropRow(id, 'products', row.id); EL.toast('Deleted. Creatives that showed it no longer list it.'); await reload(); }
        });
        const creativeForm = row => {
            const chosen = new Set((row && row.product_ids) || []);
            openForm({
                title: row ? 'Edit creative' : 'Add a creative', sub: ctx.clientName, row, canEdit,
                // Phase 78: made from a content-plan post; the post keeps its own page in the Content plan tab.
                top: row && row.content_entry_id ? `<div class="wb-link-box">${ic('check')}<span>Made from a post in the content plan${row.posted_on ? `, dated ${esc(dayName(row.posted_on))}` : ''}. When that post gets its link, this creative gets it too.</span></div>` : '',
                fields: [
                    { k: 'title', l: 'Creative name', full: true, ph: 'e.g. Reel | Combo 4+6' },
                    { k: 'format', l: 'Format', t: 'select', opts: FORMATS }, { k: 'angle', l: 'Angle', t: 'select', opts: ANGLES },
                    { k: 'posted_on', l: 'Date posted', t: 'date', dflt: today() }, { k: 'influencer', l: 'Influencer or model', ph: 'Name, or leave empty' },
                    { k: 'language', l: 'Language', t: 'select', opts: ['Bangla', 'English', 'Banglish'] },
                    { t: 'custom', k: 'product_ids', html: `<div class="wb-full"><label>Products shown</label><div class="wb-checks">${P.length ? P.map(p => `<label><input type="checkbox" data-prod value="${esc(p.id)}" ${chosen.has(p.id) ? 'checked' : ''} ${canEdit ? '' : 'disabled'}>${esc(p.name)}</label>`).join('') : '<span class="el-muted">No products yet. Add them under Products &amp; stock.</span>'}</div></div>` },
                    { k: 'hook', l: 'Hook (first 3 seconds)', t: 'area', full: true },
                    { k: 'link', l: 'Post link', t: 'url', full: true, ph: 'https://' },
                    { k: 'notes', l: 'Notes', t: 'area', full: true }
                ],
                onSave: async (data, d) => {
                    data.product_ids = [...d.el.querySelectorAll('[data-prod]:checked')].map(x => x.value);
                    if (row) await editRow(id, 'creatives', row.id, data); else await addRow(id, 'creatives', data);
                    EL.toast('Saved.'); await reload();
                },
                onDelete: async () => { await dropRow(id, 'creatives', row.id); EL.toast('Deleted. Its ads stay, marked “Removed creative”.'); await reload(); }
            });
        };
        const adForm = (row, start) => {
            const m = row ? metrics(row) : null;
            openForm({
                title: row ? 'Edit ad' : start && start.status === 'planned' ? 'Plan an ad' : 'Log an ad', sub: ctx.clientName, row: row || start || null, canEdit,
                fields: [
                    { k: 'creative_id', l: 'Creative', t: 'select', opts: C.map(c => [c.id, c.title]), full: true, hint: C.length ? '' : 'No creatives yet: add one under Creatives, or name the campaign below.' },
                    { k: 'status', l: 'Status', t: 'select', opts: AD_STATUS, blank: false, dflt: 'done' },
                    { k: 'campaign', l: 'Campaign or ad set name' },
                    { k: 'run_via', l: 'Run via', t: 'select', opts: PLACES }, { k: 'objective', l: 'Objective', t: 'select', opts: OBJECTIVES },
                    { k: 'start_on', l: 'Start date', t: 'date', dflt: today() }, { k: 'end_on', l: 'End date', t: 'date' },
                    { k: 'audience', l: 'Audience', full: true, ph: 'e.g. Women 18–34, Dhaka + Chattogram, beauty interests' },
                    { k: 'budget', l: 'Budget (৳)', t: 'number', hint: 'What you plan to spend.' }, { k: 'spend', l: 'Amount spent (৳)', t: 'number' },
                    { k: 'reach', l: 'Reach', t: 'number' }, { k: 'impressions', l: 'Impressions', t: 'number' },
                    { k: 'clicks', l: 'Link clicks', t: 'number' }, { k: 'messages', l: 'Messaging conversations', t: 'number' },
                    { k: 'orders', l: 'Orders (inbox + website)', t: 'number' }, { k: 'revenue', l: 'Sales value (৳)', t: 'number' },
                    { k: 'verdict', l: 'Verdict', t: 'select', opts: VERDICTS },
                    { k: 'learned', l: 'What we learned, and what to try next', t: 'area', full: true }
                ],
                bottom: m && m.spend ? `<p class="el-muted wb-calc">CPM ${tk2(m.cpm)} · CTR ${pct(m.ctr)} · cost per message ${tk2(m.cpmsg)} · cost per order ${tk2(m.cpo)} · ROAS ${roasTxt(m.roas)} · frequency ${m.freq != null ? m.freq.toFixed(1) : '—'}</p>` : '',
                onSave: async data => { if (row) await editRow(id, 'ads', row.id, data); else await addRow(id, 'ads', data); EL.toast('Saved.'); await reload(); },
                onDelete: async () => { await dropRow(id, 'ads', row.id); EL.toast('Deleted.'); await reload(); }
            });
        };

        // ---- views ----
        function overview() {
            const t = sum(ran());
            const stats = C.map(c => ({ c, runs: runsOf(c).length, m: cs(c) })).filter(s => s.runs);
            const byRoas = stats.filter(s => s.m.spend > 0 && s.m.roas != null).sort((a, b) => b.m.roas - a.m.roas).slice(0, 5);
            const byMsg = stats.filter(s => s.m.msg > 0).sort((a, b) => a.m.cpmsg - b.m.cpmsg).slice(0, 5);
            const advertised = new Set();
            C.forEach(c => { if (runsOf(c).length) (c.product_ids || []).forEach(x => advertised.add(x)); });
            const notAdvertised = P.filter(p => num(p.stock) > 0 && !advertised.has(p.id));
            const out = P.filter(p => has(p.stock) && num(p.stock) === 0);
            const low = P.filter(p => has(p.stock) && num(p.stock) > 0 && num(p.stock) <= LOW_STOCK);
            const tired = stats.filter(s => (s.m.freq || 0) >= 3);
            const next = A.filter(r => r.status === 'planned').sort((a, b) => String(a.start_on || '9').localeCompare(String(b.start_on || '9')));
            const running = A.filter(r => r.status === 'running');
            const ins = [];
            if (out.length) ins.push(`Stock out: ${out.map(p => `<b>${esc(p.name)}</b>${num(p.in_order) ? ` (${fmt(p.in_order)} on order)` : ''}`).join(', ')}. Stop ads that show these.`);
            if (low.length) ins.push(`Low stock (${LOW_STOCK} or less): ${low.map(p => `<b>${esc(p.name)}</b> (${fmt(p.stock)})`).join(', ')}. Pause or cap ads on these before they sell out.`);
            if (notAdvertised.length) ins.push(`In stock but never advertised: ${notAdvertised.slice(0, 8).map(p => `<b>${esc(p.name)}</b>`).join(', ')}${notAdvertised.length > 8 ? ` and ${notAdvertised.length - 8} more` : ''}.`);
            if (tired.length) ins.push(`Possible ad fatigue (frequency 3 or more): ${tired.map(s => `<b>${esc(s.c.title)}</b>`).join(', ')}. Try a fresh audience or a new hook.`);
            if (byRoas[0]) ins.push(`Best return so far: <b>${esc(byRoas[0].c.title)}</b> at ${roasTxt(byRoas[0].m.roas)} ROAS.`);
            if (!ins.length) ins.push('Add products, creatives and at least one finished ad to see suggestions here.');
            const kpi = (l, v) => `<div class="ws-kpi"><span class="l">${l}</span><span class="v">${v}</span></div>`;
            const rank = (list, val, empty) => list.length ? `<div class="ws-rows">${list.map(s => `<div class="ws-row"><div class="ws-grow"><div class="ws-t">${esc(s.c.title)}</div><div class="ws-m">${esc([s.c.format, s.c.angle].filter(Boolean).join(', '))}</div></div><b class="ws-num">${val(s)}</b></div>`).join('')}</div>` : `<p class="el-muted">${empty}</p>`;
            const groups = {};
            ran().forEach(r => { const c = creative(r.creative_id); const a = (c && c.angle) || 'Not set'; (groups[a] = groups[a] || []).push(r); });
            const angles = Object.entries(groups).map(([a, rs]) => ({ a, n: rs.length, m: sum(rs) })).sort((x, y) => y.m.spend - x.m.spend);
            const maxSpend = Math.max(1, ...angles.map(r => r.m.spend));
            return `
                <div class="ws-grid g4 wb-kpis">${kpi('Total spent', tk(t.spend))}${kpi('Messages', fmt(t.msg))}${kpi('Cost per message', tk2(t.cpmsg))}${kpi('Orders', fmt(t.ord))}
                    ${kpi('Cost per order', tk2(t.cpo))}${kpi('Sales value', tk(t.rev))}${kpi('ROAS', roasTxt(t.roas))}${kpi('Message → order', pct(t.conv))}</div>
                <section class="ws-card wb-gap"><div class="ws-card-h"><h2>What needs attention</h2></div><ul class="wb-ins">${ins.map(x => `<li>${x}</li>`).join('')}</ul></section>
                <div class="ws-grid g2e">
                    <section class="ws-card"><div class="ws-card-h"><h2>Next up</h2>${canEdit ? `<button class="ws-btn is-sm is-gold" type="button" data-plan>${ic('plus')}Plan an ad</button>` : ''}</div>
                        ${next.length || running.length ? `<div class="ws-rows">${[...running, ...next].map(r => `<div class="ws-row is-link" data-ad="${esc(r.id)}" role="button" tabindex="0"><span class="ws-sev ${r.status === 'running' ? 'is-jade' : 'is-gold'}"></span><div class="ws-grow"><div class="ws-t">${esc(adName(r))}</div>
                            <div class="ws-m">${esc([r.status === 'running' ? 'Running' : 'Planned', r.start_on ? 'from ' + dayName(r.start_on) : '', r.budget ? 'budget ' + tk(r.budget) : '', r.objective, r.audience].filter(Boolean).join(' · '))}</div></div></div>`).join('')}</div>`
                        : '<p class="el-muted">Nothing planned. Plan the next ads here, then fill in the numbers once they have run.</p>'}</section>
                    <section class="ws-card"><div class="ws-card-h"><h2>Stock</h2><button class="ws-link" type="button" data-view="products">Products &amp; stock ${ic('arrow')}</button></div>
                        <div class="ws-rows">
                            <div class="ws-row"><div class="ws-grow"><div class="ws-t">${P.length} product${P.length === 1 ? '' : 's'}</div><div class="ws-m">${out.length} stock out · ${low.length} low · ${fmt(P.reduce((s, p) => s + num(p.in_order), 0))} on order</div></div></div>
                            <div class="ws-row"><div class="ws-grow"><div class="ws-t">Stock value</div><div class="ws-m">${tk(P.reduce((s, p) => s + num(p.stock) * num(p.cost), 0))} at buying price · ${tk(P.reduce((s, p) => s + num(p.stock) * num(p.price), 0))} at customer price</div></div></div>
                        </div></section>
                </div>
                <div class="ws-grid g2e">
                    <section class="ws-card"><div class="ws-card-h"><h2>Top creatives by ROAS</h2></div>${rank(byRoas, s => roasTxt(s.m.roas), 'No sales value logged yet.')}</section>
                    <section class="ws-card"><div class="ws-card-h"><h2>Cheapest messages</h2></div>${rank(byMsg, s => tk2(s.m.cpmsg), 'No messages logged yet.')}</section>
                </div>
                <section class="ws-card"><div class="ws-card-h"><h2>Results by angle</h2></div>
                    ${angles.length ? `<div class="ws-table-wrap"><table class="ws-table"><thead><tr><th>Angle</th><th class="ws-num">Runs</th><th class="ws-num">Spent</th><th style="width:20%"></th><th class="ws-num">Cost/msg</th><th class="ws-num">Cost/order</th><th class="ws-num">ROAS</th></tr></thead><tbody>
                        ${angles.map(r => `<tr><td>${esc(r.a)}</td><td class="ws-num">${r.n}</td><td class="ws-num">${tk(r.m.spend)}</td><td><div class="wb-bar" style="width:${(r.m.spend / maxSpend * 100).toFixed(1)}%"></div></td><td class="ws-num">${tk2(r.m.cpmsg)}</td><td class="ws-num">${tk2(r.m.cpo)}</td><td class="ws-num">${roasTxt(r.m.roas)}</td></tr>`).join('')}
                    </tbody></table></div>` : '<p class="el-muted">Log finished ads to compare angles.</p>'}</section>`;
        }

        const match = o => !q || JSON.stringify(o).toLowerCase().includes(q.toLowerCase());
        const toolbar = (addLabel, addId, extra = '') => `<div class="wb-bar-row"><input type="search" id="wb-q" placeholder="Search" value="${esc(q)}" aria-label="Search">
            <span style="flex:1"></span>${canEdit ? `${extra}<button class="ws-btn is-gold" type="button" id="${addId}">${ic('plus')}${addLabel}</button>` : '<span class="el-muted">View only</span>'}</div>`;

        function productsView() {
            const list = P.filter(match);
            const out = P.filter(p => has(p.stock) && num(p.stock) === 0).length, low = P.filter(p => has(p.stock) && num(p.stock) > 0 && num(p.stock) <= LOW_STOCK).length;
            return `${toolbar('Add a product', 'wb-add-p', '<button class="ws-btn" type="button" id="wb-paste-p">Paste from a sheet</button>')}
                <p class="el-muted wb-gap">${P.length ? `${P.length} product${P.length === 1 ? '' : 's'} · ${out} stock out · ${low} low. ${canEdit ? 'Change the quantities right in the table; click a product for everything else.' : ''}` : ''}</p>
                ${list.length ? `<div class="ws-table-wrap"><table class="ws-table wb-table"><thead><tr><th class="ws-num">SL</th><th>Product</th><th class="ws-num">In hand</th><th class="ws-num">In order</th><th class="ws-num">Buying</th><th class="ws-num">Customer</th><th class="ws-num">Combo</th><th class="ws-num">Margin</th><th class="ws-num">Creatives</th><th class="ws-num">Ad spend</th></tr></thead><tbody>
                    ${list.map(p => `<tr class="is-link" data-p="${esc(p.id)}" tabindex="0"><td class="ws-num">${P.indexOf(p) + 1}</td>
                        <td><div class="t">${esc(p.name)}</div>${p.category || p.sku ? `<div class="s">${esc([p.category, p.sku].filter(Boolean).join(' · '))}</div>` : ''}</td>
                        <td class="ws-num ws-nowrap" data-stop>${canEdit ? `<input class="wb-qty" data-qty="stock" data-id="${esc(p.id)}" value="${has(p.stock) ? esc(p.stock) : ''}" inputmode="numeric" aria-label="Quantity in hand">` : (has(p.stock) ? fmt(p.stock) : '—')} ${stockTag(p)}</td>
                        <td class="ws-num" data-stop>${canEdit ? `<input class="wb-qty" data-qty="in_order" data-id="${esc(p.id)}" value="${has(p.in_order) ? esc(p.in_order) : ''}" inputmode="numeric" aria-label="In order">` : (has(p.in_order) ? fmt(p.in_order) : '—')}</td>
                        <td class="ws-num">${has(p.cost) ? tk(p.cost) : '—'}</td><td class="ws-num">${has(p.price) ? tk(p.price) : '—'}</td><td class="ws-num">${has(p.combo_price) ? tk(p.combo_price) : '—'}</td>
                        <td class="ws-num">${has(p.price) && has(p.cost) ? tk(num(p.price) - num(p.cost)) : '—'}</td>
                        <td class="ws-num">${C.filter(c => (c.product_ids || []).includes(p.id)).length}</td><td class="ws-num">${tk(prodSpend(p.id))}</td></tr>`).join('')}
                </tbody></table></div>` : `<div class="ws-empty">${ic('store')}<h3>${q ? 'Nothing matches that search' : 'No products yet'}</h3><p>${canEdit && !q ? 'Add products one by one, or copy your stock sheet (product name, quantity, in order, buying, customer and combo price, with its header row) and paste it.' : ''}</p></div>`}`;
        }
        function creativesView() {
            const list = C.filter(match);
            return `${P.length ? '' : '<div class="wsc-banner wb-gap">Add the products first, so each creative can say which products it shows.</div>'}
                ${toolbar('Add a creative', 'wb-add-c')}
                ${list.length ? `<div class="ws-table-wrap"><table class="ws-table wb-table"><thead><tr><th>Creative</th><th>Format</th><th>Posted</th><th class="ws-num">Runs</th><th class="ws-num">Spent</th><th class="ws-num">Cost/msg</th><th class="ws-num">ROAS</th></tr></thead><tbody>
                    ${list.map(c => { const m = cs(c); return `<tr class="is-link" data-c="${esc(c.id)}" tabindex="0">
                        <td><div class="t">${esc(c.title)}${c.link ? ` <a class="ws-link" href="${esc(c.link)}" target="_blank" rel="noopener" data-stop>open</a>` : ''}</div><div class="s">${esc((c.product_ids || []).map(prodName).join(', '))}</div></td>
                        <td>${[c.format, c.angle, c.influencer].filter(Boolean).map(x => `<span class="el-chip">${esc(x)}</span>`).join(' ')}</td>
                        <td class="ws-nowrap">${esc(dayName(c.posted_on) || '—')}</td><td class="ws-num">${runsOf(c).length}</td><td class="ws-num">${tk(m.spend)}</td><td class="ws-num">${tk2(m.cpmsg)}</td><td class="ws-num">${roasTxt(m.roas)}</td></tr>`; }).join('')}
                </tbody></table></div>` : `<div class="ws-empty">${ic('play')}<h3>${q ? 'Nothing matches that search' : 'No creatives yet'}</h3><p>A creative is the post or video an ad runs: its format, angle, hook and the products in it.</p></div>`}`;
        }
        function adsView() {
            const counts = { all: A.length, planned: 0, running: 0, done: 0 };
            A.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1; });
            const list = A.filter(r => (adFilter === 'all' || r.status === adFilter) && match({ ...r, _c: adName(r) }));
            return `${toolbar('Log an ad', 'wb-add-a', '<button class="ws-btn" type="button" data-plan>Plan an ad</button>')}
                <div class="ws-filters">${[['all', 'All'], ...AD_STATUS].map(([k, l]) => `<button type="button" data-af="${k}" aria-pressed="${adFilter === k}">${l} <span class="ws-num">${counts[k] || 0}</span></button>`).join('')}</div>
                ${list.length ? `<div class="ws-table-wrap"><table class="ws-table wb-table"><thead><tr><th>Ad</th><th>Dates</th><th>Status</th><th class="ws-num">Budget</th><th class="ws-num">Spent</th><th class="ws-num">CTR</th><th class="ws-num">Msgs</th><th class="ws-num">Cost/msg</th><th class="ws-num">Orders</th><th class="ws-num">Cost/order</th><th class="ws-num">ROAS</th><th class="ws-num">Freq</th></tr></thead><tbody>
                    ${list.map(r => { const m = metrics(r); const done = r.status !== 'planned'; return `<tr class="is-link" data-ad="${esc(r.id)}" tabindex="0">
                        <td><div class="t">${esc(adName(r))}</div><div class="s">${esc([creative(r.creative_id) ? r.campaign : '', r.audience].filter(Boolean).join(' · '))}</div></td>
                        <td class="ws-nowrap">${esc(dayName(r.start_on) || '—')}${r.end_on ? `<div class="s">to ${esc(dayName(r.end_on))}</div>` : ''}</td>
                        <td>${r.verdict ? `<span class="el-chip ${{ Winner: 'is-jade', Loser: 'is-bad', OK: 'is-warn' }[r.verdict] || ''}">${esc(r.verdict)}</span>` : `<span class="el-chip ${r.status === 'running' ? 'is-jade' : r.status === 'planned' ? 'is-gold' : ''}">${esc((AD_STATUS.find(s => s[0] === r.status) || [, r.status])[1])}</span>`}</td>
                        <td class="ws-num">${has(r.budget) ? tk(r.budget) : '—'}</td><td class="ws-num">${done ? tk(m.spend) : '—'}</td><td class="ws-num">${done ? pct(m.ctr) : '—'}</td><td class="ws-num">${done ? fmt(m.msg) : '—'}</td>
                        <td class="ws-num">${done ? tk2(m.cpmsg) : '—'}</td><td class="ws-num">${done ? fmt(m.ord) : '—'}</td><td class="ws-num">${done ? tk2(m.cpo) : '—'}</td><td class="ws-num">${done ? roasTxt(m.roas) : '—'}</td><td class="ws-num">${done && m.freq != null ? m.freq.toFixed(1) : '—'}</td></tr>`; }).join('')}
                </tbody></table></div>` : `<div class="ws-empty">${ic('chart')}<h3>${q || adFilter !== 'all' ? 'Nothing here' : 'No ads yet'}</h3><p>Plan the next ads, then type in their results from Ads Manager once they have run: spend, messages, orders, sales.</p></div>`}`;
        }

        function draw() {
            const views = [['overview', 'Overview'], ['products', `Products &amp; stock <span class="ws-num">${P.length}</span>`], ['creatives', `Creatives <span class="ws-num">${C.length}</span>`], ['ads', `Ads <span class="ws-num">${A.length}</span>`]];
            host.innerHTML = `<div class="ws-head"><div><h2 class="wb-h">Ad ledger for ${esc(ctx.clientName)}</h2>
                    <p class="ws-sub">Products and stock, the creatives, every ad run and what it brought in. Typed in by the team from Ads Manager and the shop; amounts in taka.</p></div></div>
                <div class="ws-filters wb-views" role="tablist">${views.map(([k, l]) => `<button type="button" role="tab" data-view="${k}" aria-pressed="${view === k}">${l}</button>`).join('')}</div>
                <div id="wb-view">${{ overview, products: productsView, creatives: creativesView, ads: adsView }[view]()}</div>`;
            host.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => { view = b.dataset.view; q = ''; draw(); }));
            host.querySelectorAll('[data-af]').forEach(b => b.addEventListener('click', () => { adFilter = b.dataset.af; draw(); }));
            host.querySelectorAll('[data-stop]').forEach(el => el.addEventListener('click', e => e.stopPropagation()));
            const wireRows = (attr, fn) => host.querySelectorAll(`[${attr}]`).forEach(tr => {
                tr.addEventListener('click', () => fn(tr.getAttribute(attr)));
                tr.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target === tr) fn(tr.getAttribute(attr)); });
            });
            wireRows('data-p', pid => productForm(P.find(p => p.id === pid)));
            wireRows('data-c', cid => creativeForm(C.find(c => c.id === cid)));
            wireRows('data-ad', aid => adForm(A.find(r => r.id === aid)));
            host.querySelectorAll('[data-plan]').forEach(b => b.addEventListener('click', () => adForm(null, { status: 'planned', start_on: today() })));
            const qi = host.querySelector('#wb-q');
            if (qi) qi.addEventListener('input', () => {
                q = qi.value; const pos = qi.selectionStart;
                draw(); const n = host.querySelector('#wb-q'); n.focus(); n.setSelectionRange(pos, pos);
            });
            const on = (sel, fn) => { const el = host.querySelector(sel); if (el) el.addEventListener('click', fn); };
            on('#wb-add-p', () => productForm(null));
            on('#wb-add-c', () => creativeForm(null));
            on('#wb-add-a', () => adForm(null, { status: 'done', start_on: today() }));
            on('#wb-paste-p', () => pasteSheet({
                kind: 'products', clientId: id, title: 'Paste products from a sheet',
                sub: 'In Google Sheets, select the rows with their header row (product name, quantity, in order, buying price, customer price, combo price), copy, and paste below. “Stock out” is read as 0.',
                labels: PRODUCT_LABELS, onDone: reload
            }));
            // Quantities change in place: a stock count is the edit made most often.
            host.querySelectorAll('[data-qty]').forEach(inp => {
                const saveQty = async () => {
                    const p = P.find(x => x.id === inp.dataset.id); if (!p) return;
                    const v = inp.value.trim() === '' ? null : inp.value.trim();
                    if (String(v ?? '') === String(p[inp.dataset.qty] ?? '')) return;
                    inp.disabled = true;
                    try { const r = await editRow(id, 'products', p.id, { [inp.dataset.qty]: v }); Object.assign(p, r.row); EL.toast(`${p.name}: saved.`); draw(); }
                    catch (err) { EL.toast(err.message, 'bad'); inp.disabled = false; inp.value = has(p[inp.dataset.qty]) ? p[inp.dataset.qty] : ''; }
                };
                inp.addEventListener('change', saveQty);
                inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); });
            });
        }
        draw();
    }

    // =========================================================================
    // MESSAGE TEMPLATES
    // =========================================================================
    const IMG_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    async function uploadPicture(clientId, blob) {
        if (!IMG_TYPES.includes(blob.type)) throw new Error('Use a PNG, JPEG, WebP or GIF picture.');
        if (blob.size > 5 * 1024 * 1024) throw new Error('That picture is over 5 MB. Use a smaller one.');
        const res = await fetch(`${EL.backendUrl()}${base(clientId)}/template-media`, {
            method: 'POST', headers: { Authorization: `Bearer ${await EL.token()}`, 'Content-Type': blob.type }, body: blob
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'The picture did not upload.');
        return data;
    }
    const bubble = (text, media) => `<div class="wb-bubble">${media.length ? `<div class="wb-pics">${media.map(m => `<img src="${esc(m.url)}" alt="" loading="lazy">`).join('')}</div>` : ''}${text ? `<div class="wb-text">${esc(text)}</div>` : ''}</div>`;

    async function templates(host, ctx) {
        const id = ctx.clientId;
        let T = [], canEdit = false, group = '', q = '';
        try { const d = await load(id, 'templates'); T = d.templates || []; canEdit = d.canEdit; }
        catch (err) { host.innerHTML = migrationNote(err) || `<div class="ws-empty">${ic('alert')}<p>${esc(err.message)}</p></div>`; return; }
        const reload = async () => { const d = await load(id, 'templates'); T = d.templates || []; draw(); };
        const groups = () => [...new Set(T.map(t => t.category).filter(Boolean))].sort();

        function form(row) {
            let media = row ? (row.media || []).map(m => ({ ...m })) : [];
            const draft = { title: row ? row.title : '', category: row ? row.category : '', body: row ? row.body : '' };
            openForm({
                title: row ? 'Edit template' : 'New message template', sub: ctx.clientName, row: draft, canEdit,
                fields: [
                    { k: 'title', l: 'Title', ph: 'e.g. Price and delivery' },
                    { k: 'category', l: 'Group', list: groups().concat(['Price', 'Delivery', 'Order confirmed', 'Payment', 'Greeting', 'Out of stock']).filter((x, i, a) => a.indexOf(x) === i), ph: 'Optional' },
                    { k: 'body', l: 'Message', t: 'area', big: true, full: true, ph: 'The reply exactly as the customer should read it. Line breaks and emoji are kept.' },
                    { t: 'custom', k: 'pics', html: `<div class="wb-full"><label>Pictures</label><div class="wb-thumbs" id="tp-thumbs"></div>
                        ${canEdit ? `<div class="wb-bar-row"><label class="ws-btn is-sm is-quiet">${ic('plus')}Add picture<input type="file" id="tp-file" accept="${IMG_TYPES.join(',')}" multiple hidden></label><span class="ws-hint">Up to 6, 5 MB each. You can paste a picture here too (Ctrl+V).</span></div>` : ''}</div>` }
                ],
                top: `<div class="wb-preview"><div class="wb-preview-h">Preview</div><div id="tp-preview"></div></div>`,
                wire: d => {
                    const thumbs = d.el.querySelector('#tp-thumbs'), prev = d.el.querySelector('#tp-preview'), body = d.el.querySelector('[name="body"]');
                    const paint = () => {
                        prev.innerHTML = bubble(body.value, media) || '';
                        thumbs.innerHTML = media.map((m, i) => `<span class="wb-thumb"><img src="${esc(m.url)}" alt="">${canEdit ? `<button type="button" class="el-iconbtn" data-rm="${i}" aria-label="Remove picture">${ic('x')}</button>` : ''}</span>`).join('');
                        thumbs.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => { media.splice(Number(b.dataset.rm), 1); paint(); }));
                    };
                    body.addEventListener('input', paint);
                    const add = async files => {
                        for (const file of files) {
                            if (media.length >= 6) { EL.toast('Six pictures at most.', 'bad'); break; }
                            try { const r = await uploadPicture(id, file); media.push({ id: r.id, url: r.url || URL.createObjectURL(file) }); paint(); }
                            catch (err) { EL.toast(err.message, 'bad'); }
                        }
                    };
                    const fi = d.el.querySelector('#tp-file');
                    if (fi) fi.addEventListener('change', () => { add([...fi.files]); fi.value = ''; });
                    if (canEdit) d.el.addEventListener('paste', e => {
                        const files = [...(e.clipboardData ? e.clipboardData.files : [])].filter(x => IMG_TYPES.includes(x.type));
                        if (files.length) { e.preventDefault(); add(files); }
                    });
                    d._media = () => media;
                    paint();
                },
                onSave: async (data, d) => {
                    data.media_ids = d._media().map(m => m.id);
                    if (row) await editRow(id, 'templates', row.id, data); else await addRow(id, 'templates', data);
                    EL.toast('Saved.'); await reload();
                },
                onDelete: async () => { await dropRow(id, 'templates', row.id); EL.toast('Deleted.'); await reload(); }
            });
        }

        function draw() {
            const gs = groups();
            if (group && !gs.includes(group)) group = '';
            const list = T.filter(t => (!group || t.category === group) && (!q || `${t.title} ${t.body || ''}`.toLowerCase().includes(q.toLowerCase())));
            host.innerHTML = `<div class="ws-head"><div><h2 class="wb-h">Message templates for ${esc(ctx.clientName)}</h2>
                    <p class="ws-sub">Replies for customers in Meta Business Suite. Copy the text, copy each picture, paste them into the chat.</p></div>
                    ${canEdit ? `<div class="ws-actions"><button class="ws-btn is-gold" type="button" id="tp-add">${ic('plus')}New template</button></div>` : ''}</div>
                ${T.length ? `<div class="wb-bar-row"><input type="search" id="tp-q" placeholder="Search the templates" value="${esc(q)}" aria-label="Search the templates"></div>
                    ${gs.length ? `<div class="ws-filters">${[['', 'All'], ...gs.map(g => [g, g])].map(([k, l]) => `<button type="button" data-g="${esc(k)}" aria-pressed="${group === k}">${esc(l)}</button>`).join('')}</div>` : ''}` : ''}
                ${list.length ? `<div class="wb-tpls">${list.map(t => `<section class="ws-card wb-tpl">
                    <div class="ws-card-h"><h2>${esc(t.title)}</h2>${t.category ? `<span class="el-chip">${esc(t.category)}</span>` : ''}</div>
                    ${bubble(t.body, t.media || [])}
                    <div class="ws-actions">${t.body ? `<button class="ws-btn is-sm is-gold" type="button" data-copy="${esc(t.id)}">Copy text</button>` : ''}
                        ${(t.media || []).map((m, i) => `<button class="ws-btn is-sm" type="button" data-img="${esc(t.id)}:${i}">Copy picture${t.media.length > 1 ? ' ' + (i + 1) : ''}</button><a class="ws-btn is-sm is-quiet" href="${esc(downloadUrl(m.url))}" target="_blank" rel="noopener">Download${t.media.length > 1 ? ' ' + (i + 1) : ''}</a>`).join('')}
                        <span style="flex:1"></span>${canEdit ? `<button class="ws-btn is-sm is-quiet" type="button" data-edit="${esc(t.id)}">${ic('pen')}Edit</button>` : ''}</div>
                </section>`).join('')}</div>`
                : `<div class="ws-empty">${ic('chat')}<h3>${T.length ? 'Nothing matches' : 'No templates yet'}</h3><p>${T.length ? '' : 'Save the replies the team sends again and again: prices, delivery charges, payment numbers, order confirmations. Each can carry pictures, such as a price list or a product photo.'}</p></div>`}`;
            host.querySelectorAll('[data-g]').forEach(b => b.addEventListener('click', () => { group = b.dataset.g; draw(); }));
            host.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', () => copyText((T.find(t => t.id === b.dataset.copy) || {}).body || '')));
            host.querySelectorAll('[data-img]').forEach(b => b.addEventListener('click', () => {
                const [tid, i] = b.dataset.img.split(':'); const t = T.find(x => x.id === tid);
                if (t && t.media[Number(i)]) copyImage(t.media[Number(i)].url);
            }));
            host.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => form(T.find(t => t.id === b.dataset.edit))));
            const add = host.querySelector('#tp-add'); if (add) add.addEventListener('click', () => form(null));
            const qi = host.querySelector('#tp-q');
            if (qi) qi.addEventListener('input', () => { q = qi.value; const pos = qi.selectionStart; draw(); const n = host.querySelector('#tp-q'); n.focus(); n.setSelectionRange(pos, pos); });
        }
        draw();
    }

    window.Tools = { contentPlan, adLedger, templates, parseSheet, mapSheet, sheetDate, ideaToRow };
})();
