/**
 * Front end (phase 95): publish to the public website, edgelead.online, from the CRM. #frontend/<tab>[/<id>|/new]
 *
 *   Works          campaigns, products and other work we did: a card with a cover photo, up to four results, the
 *                  service pages it shows on. The homepage shows the first five (by order) that have a photo.
 *   Website works  websites and apps we built: the card, plus "Browse the real sites" on the website, where visitors
 *                  click through a full-page screenshot of each page.
 *   Blog           articles in Markdown, with a cover and images in the text. A draft stays off the site.
 *
 * Loaded the first time it opens. Owner only: the server (src/24-website.js, phase 66) checks the owner on every
 * call, checks every field against the website's own rules, and makes each Publish one commit to the website's
 * repository. Netlify rebuilds the website in about a minute; the status chip follows the build until it is live.
 * Images are shrunk here (JPEG, at most 1.3 MB), uploaded one at a time, and go live with the Publish that uses them.
 * Contract: docs/WORKSPACE-CONTENT.md in the Edge-lead-Front-end repository.
 */
(function () {
'use strict';
const C = window.CRM;
const { api, esc, ic, toast, $ } = C;
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const TABS = [['works', 'Works'], ['websites', 'Website works'], ['blog', 'Blog']];
const NOTE = {
    works: 'Campaigns, products and other work we did. Cards show on the Work page in order (1 first); the homepage shows the first five that have a photo. Tick a service to show it on that service\u2019s page too.',
    websites: 'Websites and apps we built. Each shows as a card on the Work page and in \u201cBrowse the real sites\u201d, where visitors click through a full-page screenshot of every page.',
    blog: 'Articles. The six newest show on the homepage. A draft is saved to the website but stays off it.'
};
const ADD = { works: 'Add work', websites: 'Add a website', blog: 'New article' };
const SVC = { social: 'Social media', ads: 'Ads', leads: 'Lead generation', seo: 'SEO', influencers: 'Influencers', reporting: 'Reporting', websites: 'Websites' };
const FILTERS = ['Software', 'AI', 'Websites', 'Campaigns', 'Bangladesh', 'United States'];
const STATUSES = ['Live', 'Delivered', 'Running', 'In development'];
const CATEGORIES = ['Campaigns \u00b7 Meta ads', 'Campaigns \u00b7 Google ads', 'Social media', 'SEO', 'Software', 'Software \u00b7 AI', 'Websites', 'Websites \u00b7 E-commerce'];
const GRAD = 'linear-gradient(160deg,#186aff,#0b3b8f)';

const F = { d: null, status: null, poll: null, ed: null, bound: false };

// ------------------------------------------------------------------ small helpers
const slug = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
const localDay = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const siteUrl = () => (F.d && F.d.siteUrl) || 'https://edgelead.online';
const isSiteWork = w => w.data.kind === 'website' || !!w.data.site;
const grad = g => (g && !/[;{}<>"'\\]|url\(/i.test(g) ? g : GRAD);
const svcName = k => { const s = ((F.d && F.d.services) || []).find(x => x.id === k); return (s && s.data && s.data.name) || SVC[k] || k; };
/** An image the page can show: one uploaded in this editor (not live yet), else the website's own copy. */
const imgUrl = p => { if (!p) return ''; if (F.ed && F.ed.previews[p]) return F.ed.previews[p]; return /^(https?:|blob:)/i.test(p) ? p : siteUrl() + p; };
const img = (p, alt = '') => (p ? `<img src="${esc(imgUrl(p))}" alt="${esc(alt)}" loading="lazy">` : '');
const csv = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
const day = d => { if (!d) return ''; const x = new Date(String(d).slice(0, 10) + 'T12:00:00'); return isNaN(x) ? String(d) : x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };

// ------------------------------------------------------------------ Markdown, for the article preview (text is escaped first)
const safeUrl = u => (/^(https?:\/\/|\/|\.\.?\/|#|mailto:)/i.test(u) && !/^\s*(javascript|data|vbscript):/i.test(u) ? u : null);
const linkUrl = u => (/^(https?:|mailto:|#)/i.test(u) ? u : siteUrl() + '/' + u.replace(/^(\.\.?\/)+/, '').replace(/^\//, ''));
function inline(raw) {
    const re = /!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_/g;
    let out = '', last = 0, m;
    while ((m = re.exec(raw))) {
        out += esc(raw.slice(last, m.index)); last = re.lastIndex;
        if (m[2] !== undefined) { const u = safeUrl(m[2]); out += u ? `<img src="${esc(imgUrl(u))}" alt="${esc(m[1])}" loading="lazy">` : esc(m[0]); }
        else if (m[4] !== undefined) { const u = safeUrl(m[4]); out += u ? `<a href="${esc(linkUrl(u))}" target="_blank" rel="noopener">${esc(m[3])}</a>` : esc(m[3]); }
        else if (m[5] !== undefined) out += `<strong>${esc(m[5])}</strong>`;
        else if (m[6] !== undefined) out += `<code>${esc(m[6])}</code>`;
        else out += `<em>${esc(m[7] !== undefined ? m[7] : m[8])}</em>`;
    }
    return out + esc(raw.slice(last));
}
/** The Markdown the website's articles use: headings, paragraphs, lists, quotes, rules, links, images, bold, italics, code. */
function md(src) {
    const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    const out = []; let para = [], list = null;
    const flushP = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
    const flushL = () => { if (list) { out.push(`<${list.tag}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
    for (const line of lines) {
        const t = line.trim();
        let m;
        if (!t) { flushP(); flushL(); continue; }
        if ((m = t.match(/^(#{1,6})\s+(.*)$/))) { flushP(); flushL(); const n = Math.min(4, Math.max(2, m[1].length)); out.push(`<h${n}>${inline(m[2])}</h${n}>`); continue; }
        if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flushP(); flushL(); out.push('<hr>'); continue; }
        if ((m = t.match(/^>\s?(.*)$/))) { flushP(); flushL(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
        if ((m = t.match(/^[-*+]\s+(.*)$/))) { flushP(); if (!list || list.tag !== 'ul') { flushL(); list = { tag: 'ul', items: [] }; } list.items.push(m[1]); continue; }
        if ((m = t.match(/^\d+[.)]\s+(.*)$/))) { flushP(); if (!list || list.tag !== 'ol') { flushL(); list = { tag: 'ol', items: [] }; } list.items.push(m[1]); continue; }
        flushL(); para.push(t);
    }
    flushP(); flushL();
    return out.join('\n');
}
C.siteMd = md;   // the article preview, for the tests

// ------------------------------------------------------------------ loading, and the website's build status
async function load(fresh) {
    if (F.d && !fresh) return F.d;
    F.d = await api('/api/site/content' + (fresh ? '?fresh=1' : ''));
    return F.d;
}
function chip() {
    const s = F.status;
    if (!s) return '<span class="fe-st"><i></i>Checking the website\u2026</span>';
    const b = s.build || {}, last = (s.commits || [])[0];
    const [cls, t] = { success: ['ok', 'Live'], pending: ['run', 'Building\u2026'], failure: ['bad', 'Build failed'] }[b.state] || ['', 'Published'];
    const log = (b.reports || []).find(r => r.url);
    return `<span class="fe-st ${cls}"><i></i>${t}${last ? `<small title="${esc(last.message)}">last change ${esc(C.ago(last.at))}</small>` : ''}${log && b.state === 'failure' ? `<a href="${esc(log.url)}" target="_blank" rel="noopener">build log</a>` : ''}</span>`;
}
async function loadStatus() {
    try { F.status = await api('/api/site/status'); } catch { F.status = { build: { state: 'unknown' }, commits: [] }; }
    const el = $('#fe-status'); if (el) el.innerHTML = chip();
    return F.status;
}
/** After a publish: follow the build for up to three minutes, so the chip says when it is live. */
function watch() {
    clearTimeout(F.poll);
    let n = 0;
    const tick = async () => {
        if (C.route !== 'frontend') return;
        const s = await loadStatus(), state = s && s.build && s.build.state;
        if ((state === 'pending' || (state === 'unknown' && n < 3)) && n++ < 18) F.poll = setTimeout(tick, 10000);
        else if (state === 'failure') toast('The website build failed, so the site still shows the previous version. Open the build log.', true);
        else if (state === 'success') toast('Live on the website.');
    };
    F.poll = setTimeout(tick, 5000);
}
function notSetUp(e) {
    const code = e && e.data && e.data.code;
    const setup = code === 'site_not_configured' || code === 'site_token';
    return `<div class="head"><div><h1>Front end</h1><p class="sub">Publish to the website.</p></div></div>
      <div class="card"><div class="empty">${ic(setup ? 'lock' : 'shield')}<b>${setup ? 'Publishing to the website is not set up yet.' : 'The website could not be read.'}</b>
        <p style="max-width:560px;margin:8px auto 0">${esc(e.message)}</p>
        ${setup ? `<ol class="fe-steps"><li>GitHub \u2192 Settings \u2192 Developer settings \u2192 Fine-grained tokens \u2192 <b>Generate</b>: repository <b>Edge-lead-Front-end</b> only; permissions <b>Contents: Read and write</b>, <b>Commit statuses</b> and <b>Checks: Read</b>.</li>
          <li>Render \u2192 the backend service \u2192 Environment: add <span class="mono">SITE_REPO_TOKEN</span> with that token. It redeploys by itself.</li><li>Open Front end again.</li></ol>` : ''}
        <div style="margin-top:14px"><button class="btn" type="button" data-fe="retry">Try again</button></div></div></div>`;
}

// ------------------------------------------------------------------ the lists
function itemsOf(tab) { return tab === 'blog' ? F.d.blog : F.d.work.filter(w => (tab === 'websites') === isSiteWork(w)); }
/** The homepage's "Selected work": the first five, by order, with screenshots or a cover photo. */
function homeIds() {
    return new Set(F.d.work.filter(w => w.data.published !== false && (w.data.cover || (w.data.site && (w.data.site.pages || []).length)))
        .sort((a, b) => (a.data.order ?? 999) - (b.data.order ?? 999)).slice(0, 5).map(w => w.id));
}
function workCard(tab, w, home) {
    const x = w.data, s = x.site, pic = x.cover || (s && s.pages && s.pages[0] && s.pages[0].image);
    const chips = [x.published === false ? '<span class="fe-chip">Hidden</span>' : '<span class="fe-chip ok">On the site</span>',
        home.has(w.id) ? '<span class="fe-chip hot">Homepage</span>' : '', x.showCard === false ? '<span class="fe-chip">Viewer only</span>' : '',
        s ? `<span class="fe-chip">${(s.pages || []).length} screen${(s.pages || []).length === 1 ? '' : 's'}</span>` : '',
        (x.results || []).length ? `<span class="fe-chip">${x.results.length} result${x.results.length === 1 ? '' : 's'}</span>` : ''].join('');
    return `<a class="fe-card${x.published === false ? ' off' : ''}" href="#frontend/${tab}/${esc(w.id)}">
        <span class="fe-th${s && !x.cover ? ' shot' : ''}" style="--g:${esc(grad(x.gradient))}">${img(pic)}${s ? `<em>${ic('globe')}${esc(s.host)}</em>` : ''}<span class="fe-ord" title="Order on the Work page">${esc(x.order ?? 999)}</span></span>
        <span class="fe-cb"><small>${esc(x.category)} \u00b7 ${esc(x.status)}</small><b>${esc(x.title)}</b><span class="fe-sum">${esc(x.summary)}</span><span class="fe-chips">${chips}</span></span></a>`;
}
function postCard(p) {
    const x = p.data;
    return `<a class="fe-card${x.draft ? ' off' : ''}" href="#frontend/blog/${esc(p.id)}">
        <span class="fe-th" style="--g:${esc(grad(x.gradient))}">${img(x.cover)}${x.cover ? '' : `<span class="fe-thw">${esc(x.title)}</span>`}</span>
        <span class="fe-cb"><small>${esc(day(x.date))}${x.tag ? ' \u00b7 ' + esc(x.tag) : ''}</small><b>${esc(x.title)}</b><span class="fe-sum">${esc(x.excerpt)}</span>
          <span class="fe-chips">${x.draft ? '<span class="fe-chip warn">Draft</span>' : '<span class="fe-chip ok">On the site</span>'}</span></span></a>`;
}
function listHtml(tab) {
    const items = itemsOf(tab), home = tab === 'blog' ? null : homeIds();
    const count = t => itemsOf(t).length;
    return `<div class="head"><div><h1>Front end</h1><p class="sub">What you publish here goes to <a href="${esc(siteUrl())}" target="_blank" rel="noopener">${esc(siteUrl().replace(/^https?:\/\//, ''))}</a> in about a minute and stays until the next change.</p></div><div class="sp"></div>
        <span id="fe-status">${chip()}</span>
        <a class="btn" href="${esc(tab === 'blog' ? siteUrl() + '/blog.html' : siteUrl() + '/work.html')}" target="_blank" rel="noopener">${ic('globe')}Open the site</a>
        <a class="btn pri" href="#frontend/${tab}/new">${ic('plus')}${ADD[tab]}</a></div>
      <nav class="views" role="tablist">${TABS.map(([k, l]) => `<a role="tab" href="#frontend/${k}" aria-selected="${tab === k}" class="${tab === k ? 'on' : ''}">${l}<span class="c">${count(k)}</span></a>`).join('')}</nav>
      <p class="fe-note">${NOTE[tab]}</p>
      ${items.length ? `<div class="fe-grid">${items.map(x => (tab === 'blog' ? postCard(x) : workCard(tab, x, home))).join('')}</div>`
        : `<div class="card"><div class="empty">${ic(tab === 'blog' ? 'note' : 'globe')}<b>Nothing here yet.</b> <a href="#frontend/${tab}/new">${ADD[tab]}</a>.</div></div>`}`;
}

// ------------------------------------------------------------------ the editor
function startEditor(tab, id) {
    if (F.ed && F.ed.tab === tab && F.ed.key === id) return F.ed;
    const list = tab === 'blog' ? F.d.blog : F.d.work;
    const entry = id === 'new' ? null : list.find(x => x.id === id);
    if (id !== 'new' && !entry) return null;
    let x;
    if (entry) x = JSON.parse(JSON.stringify(entry.data));
    else if (tab === 'blog') x = { title: '', excerpt: '', date: localDay(), tag: 'Blog', author: 'EdgeLead', draft: false, body: '' };
    else if (tab === 'websites') x = { title: '', kind: 'website', category: 'Websites', status: 'Live', filters: ['Websites'], summary: '', tags: [], results: [], services: ['websites'], related: {}, order: 10, showCard: true, published: true,
        site: { name: '', subtitle: '', host: '', color: '#186aff', headline: '', description: '', stack: [], order: 10, signInOnly: false, pages: [{ label: 'Home', path: '/' }] } };
    else x = { title: '', kind: 'campaign', category: '', status: 'Delivered', filters: [], summary: '', tags: [], results: [], services: [], related: {}, order: 10, showCard: true, published: true };
    F.ed = { tab, key: id, isNew: !entry, id: entry ? entry.id : '', sha: entry ? entry.sha : null, x, uploads: [], previews: {}, dirty: false, idLocked: !!entry, view: 'edit' };
    return F.ed;
}
const val = (root, k) => { const el = root.querySelector(`[data-k="${k}"]`); return el ? el.value : undefined; };
const chk = (root, k) => { const el = root.querySelector(`[data-k="${k}"]`); return !!(el && el.checked); };
/** Read the form into the item. */
function sync() {
    const e = F.ed, root = $('#fe-form'); if (!e || !root) return;
    const x = e.x;
    if (e.tab === 'blog') {
        for (const k of ['title', 'excerpt', 'date', 'tag', 'author', 'body']) { const v2 = val(root, k); if (v2 !== undefined) x[k] = v2; }
        x.draft = chk(root, 'draft');
    } else {
        for (const k of ['title', 'kind', 'status', 'category', 'summary', 'coverAlt', 'order', 'date']) { const v2 = val(root, k); if (v2 !== undefined) x[k] = v2; }
        if (!x.date) delete x.date;
        x.tags = csv(val(root, 'tags'));
        x.showCard = chk(root, 'showCard'); x.published = chk(root, 'published');
        x.filters = $$('[data-filter]:checked', root).map(c => c.dataset.filter);
        x.services = $$('[data-svc]:checked', root).map(c => c.dataset.svc);
        x.results = $$('[data-res]', root).map(r => ({ label: r.querySelector('[data-rl]').value.trim(), value: r.querySelector('[data-rv]').value.trim() })).filter(r => r.label || r.value);
        const rel = {};
        $$('[data-rel]', root).forEach(r => { const t = r.querySelector('[data-rt]').value.trim(), s = r.querySelector('[data-rs]').value.trim(); if (t || s) rel[r.dataset.rel] = { title: t, text: s }; });
        x.related = rel;
        if (x.site) {
            const s = x.site;
            for (const k of ['name', 'subtitle', 'host', 'color', 'headline', 'description', 'order']) { const el = root.querySelector(`[data-s="${k}"]`); if (el) s[k] = el.value; }
            s.stack = csv((root.querySelector('[data-s="stack"]') || {}).value);
            s.signInOnly = !!(root.querySelector('[data-s="signInOnly"]') || {}).checked;
            s.pages = $$('[data-pg]', root).map((r, i) => ({ label: r.querySelector('[data-pl]').value, path: r.querySelector('[data-pp]').value || '/', image: (s.pages[i] || {}).image }));
        }
    }
    if (e.isNew && !e.idLocked) e.id = slug(val(root, 'id') || x.title);
}
const thumbBtn = (p, label, act, g) => `<span class="fe-img" style="--g:${esc(grad(g))}">${img(p)}<span>${p ? '' : esc(label)}</span></span>`;
function workForm(e) {
    const x = e.x, s = x.site, site = e.tab === 'websites';
    return `
      <section class="fe-sec"><h3>The card</h3>
        <div class="grid2"><div class="field"><label>Title</label><input data-k="title" value="${esc(x.title)}" placeholder="${site ? 'Riverside Caf\u00e9 website' : 'Riverside Caf\u00e9: Eid campaign'}"></div>
          <div class="field"><label>Address on the site</label><input data-k="id" value="${esc(e.id)}" ${e.idLocked ? 'disabled' : 'placeholder="made from the title"'}><small>${e.idLocked ? 'Fixed once there is a picture or it is published.' : 'Lowercase words and dashes. It never changes after publishing.'}</small></div></div>
        <div class="fe-3"><div class="field"><label>Kind</label><select data-k="kind">${['campaign', 'software', 'website'].map(k => `<option value="${k}" ${x.kind === k ? 'selected' : ''}>${{ campaign: 'Campaign', software: 'Software or product', website: 'Website' }[k]}</option>`).join('')}</select></div>
          <div class="field"><label>Status</label><input data-k="status" value="${esc(x.status)}" list="fe-sts"><datalist id="fe-sts">${STATUSES.map(t => `<option>${t}</option>`).join('')}</datalist></div>
          <div class="field"><label>Category (the small label)</label><input data-k="category" value="${esc(x.category)}" list="fe-cats" placeholder="Campaigns \u00b7 Meta ads"><datalist id="fe-cats">${CATEGORIES.map(t => `<option>${esc(t)}</option>`).join('')}</datalist></div></div>
        <div class="field"><label>Summary</label><textarea data-k="summary" rows="3" placeholder="One or two sentences: what we did and what came of it.">${esc(x.summary)}</textarea></div>
        <div class="field"><label>Tags</label><input data-k="tags" value="${esc((x.tags || []).join(', '))}" placeholder="Meta ads, Reels, Barishal"><small>Separate with commas. Up to eight.</small></div>
        <div class="field"><label>Filters on the Work page</label><div class="fe-checks">${FILTERS.map(f => `<label><input type="checkbox" data-filter="${esc(f)}" ${(x.filters || []).includes(f) ? 'checked' : ''}>${esc(f)}</label>`).join('')}</div></div>
      </section>
      <section class="fe-sec"><h3>Cover photo</h3>
        <div class="fe-imgrow">${thumbBtn(x.cover, 'No photo', 'cover', x.gradient)}<div><button class="btn sm" type="button" data-fe="cover">${ic('up')}${x.cover ? 'Replace' : 'Upload'} photo</button>${x.cover ? ' <button class="btn sm ghost" type="button" data-fe="nocover">Remove</button>' : ''}
          <p class="fe-hint">${site ? 'Optional for a website: without one, the card shows the first screenshot.' : 'A screenshot, an ad or a photo of the work. Landscape, at least 1200 px wide.'}</p></div></div>
        <div class="field"><label>Describe the photo</label><input data-k="coverAlt" value="${esc(x.coverAlt)}" placeholder="The winning Eid reel on Instagram"></div>
      </section>
      <section class="fe-sec"><h3>Results on the card</h3><p class="fe-hint">Up to four, like \u201cCost per result \u00b7 \u09f343\u201d. Leave empty for none.</p>
        ${[0, 1, 2, 3].map(i => { const r = (x.results || [])[i] || {}; return `<div class="grid2 fe-res" data-res><input data-rl placeholder="Label" value="${esc(r.label)}" aria-label="Result ${i + 1} label"><input data-rv placeholder="Value" value="${esc(r.value)}" aria-label="Result ${i + 1} value"></div>`; }).join('')}
      </section>
      ${site || s ? siteForm(e) : `<section class="fe-sec"><h3>Live-site viewer</h3><p class="fe-hint">For a website or app: visitors click through a screenshot of each page under \u201cBrowse the real sites\u201d.</p><button class="btn sm" type="button" data-fe="addsite">${ic('plus')}Add to the live-site viewer</button></section>`}
      <section class="fe-sec"><h3>Show on service pages</h3>
        <div class="fe-checks">${Object.keys(SVC).map(k => `<label><input type="checkbox" data-svc="${k}" data-repaint ${(x.services || []).includes(k) ? 'checked' : ''}>${esc(svcName(k))}</label>`).join('')}</div>
        ${(x.services || []).map(k => { const r = (x.related || {})[k] || {}; return `<div class="fe-rel" data-rel="${k}"><span>On the ${esc(svcName(k))} page <small>(optional, shorter wording)</small></span><div class="grid2"><input data-rt placeholder="Title" value="${esc(r.title)}" aria-label="Title on the ${esc(svcName(k))} page"><input data-rs placeholder="One line" value="${esc(r.text)}" aria-label="Line on the ${esc(svcName(k))} page"></div></div>`; }).join('')}
      </section>
      <section class="fe-sec"><h3>Where it shows</h3>
        <div class="fe-3"><div class="field"><label>Order (1 comes first)</label><input data-k="order" type="number" min="0" value="${esc(x.order ?? 999)}"></div>
          <div class="field"><label>Date</label><input data-k="date" type="date" value="${esc(x.date ? String(x.date).slice(0, 10) : '')}"></div>
          <div class="field fe-checks fe-col"><label><input type="checkbox" data-k="showCard" ${x.showCard !== false ? 'checked' : ''}>Show as a card</label><label><input type="checkbox" data-k="published" ${x.published !== false ? 'checked' : ''}>On the site</label></div></div>
      </section>`;
}
function siteForm(e) {
    const s = e.x.site;
    if (!s) return '';
    return `<section class="fe-sec"><h3>The live site</h3><p class="fe-hint">Full-page screenshots, 1440 px wide, one per page (in Chrome: Developer tools \u2192 \u22ee \u2192 Run command \u2192 \u201cCapture full size screenshot\u201d). Up to twelve.</p>
        <div class="fe-3"><div class="field"><label>Site name</label><input data-s="name" value="${esc(s.name)}" placeholder="Riverside Caf\u00e9"></div>
          <div class="field"><label>Short description</label><input data-s="subtitle" value="${esc(s.subtitle)}" placeholder="Caf\u00e9 website"></div>
          <div class="field"><label>Address</label><input data-s="host" value="${esc(s.host)}" placeholder="riversidecafe.com.bd"></div></div>
        <div class="fe-3"><div class="field"><label>Bold lead-in</label><input data-s="headline" value="${esc(s.headline)}" placeholder="Riverside Caf\u00e9"></div>
          <div class="field"><label>Colour</label><span class="fe-color"><input type="color" data-colorpick value="${esc(/^#[0-9a-f]{6}$/i.test(s.color || '') ? s.color : '#186aff')}" aria-label="Pick the colour"><input data-s="color" value="${esc(s.color || '#186aff')}"></span></div>
          <div class="field"><label>Order in the viewer</label><input data-s="order" type="number" min="0" value="${esc(s.order ?? 99)}"></div></div>
        <div class="field"><label>Description</label><input data-s="description" value="${esc(s.description)}" placeholder="Menu, bookings and WhatsApp ordering, in Bangla and English."></div>
        <div class="grid2"><div class="field"><label>Built with</label><input data-s="stack" value="${esc((s.stack || []).join(', '))}" placeholder="Astro, bKash"></div>
          <div class="field fe-checks fe-col"><label><input type="checkbox" data-s="signInOnly" ${s.signInOnly ? 'checked' : ''}>Behind a sign-in (the screens show; the link goes to its sign-in page)</label></div></div>
        <div class="fe-pages">${(s.pages || []).map((p, i) => `<div class="fe-page" data-pg>${thumbBtn(p.image, 'No screenshot', 'page', e.x.gradient)}
            <div class="fe-pf"><input data-pl placeholder="Page name, like Home" value="${esc(p.label)}" aria-label="Screen ${i + 1} name"><input data-pp placeholder="/" value="${esc(p.path)}" aria-label="Screen ${i + 1} address">
              <span class="fe-pa"><button class="btn sm" type="button" data-fe="pimg" data-i="${i}">${ic('up')}${p.image ? 'Replace' : 'Upload'}</button>${i ? `<button class="btn sm ghost" type="button" data-fe="pup" data-i="${i}" aria-label="Move up">\u2191</button>` : ''}<button class="btn sm ghost" type="button" data-fe="pdel" data-i="${i}" aria-label="Remove this screen">${ic('x')}</button></span></div></div>`).join('')}</div>
        <div class="fe-row"><button class="btn sm" type="button" data-fe="padd" ${(s.pages || []).length >= 12 ? 'disabled' : ''}>${ic('plus')}Add a page</button>${e.tab === 'works' ? '<button class="btn sm ghost" type="button" data-fe="nosite">Take it out of the viewer</button>' : ''}</div>
      </section>`;
}
function postForm(e) {
    const x = e.x;
    return `
      <section class="fe-sec"><h3>The article</h3>
        <div class="grid2"><div class="field"><label>Title</label><input data-k="title" value="${esc(x.title)}" placeholder="Bangla or English? What to post for a Barishal audience"></div>
          <div class="field"><label>Address on the site</label><input data-k="id" value="${esc(e.id)}" ${e.idLocked ? 'disabled' : 'placeholder="made from the title"'}><small>${e.idLocked ? 'Fixed once there is a picture or it is published.' : 'blog/<address>.html. It never changes after publishing.'}</small></div></div>
        <div class="field"><label>Excerpt</label><input data-k="excerpt" value="${esc(x.excerpt)}" placeholder="One sentence for the card and for search results."></div>
        <div class="fe-3"><div class="field"><label>Date</label><input data-k="date" type="date" value="${esc(String(x.date || localDay()).slice(0, 10))}"></div>
          <div class="field"><label>Tag</label><input data-k="tag" value="${esc(x.tag || 'Blog')}"></div>
          <div class="field"><label>Author</label><input data-k="author" value="${esc(x.author || 'EdgeLead')}"></div></div>
      </section>
      <section class="fe-sec"><h3>Cover image</h3>
        <div class="fe-imgrow">${thumbBtn(x.cover, 'No cover', 'cover', x.gradient)}<div><button class="btn sm" type="button" data-fe="cover">${ic('up')}${x.cover ? 'Replace' : 'Upload'} cover</button>${x.cover ? ' <button class="btn sm ghost" type="button" data-fe="nocover">Remove</button>' : ''}<p class="fe-hint">Optional. Wide, about 1600 \u00d7 800.</p></div></div>
      </section>
      <section class="fe-sec"><h3>Text</h3>
        <div class="fe-tools" role="toolbar" aria-label="Formatting"><button class="btn sm ghost" type="button" data-md="h2" title="Heading">H2</button><button class="btn sm ghost" type="button" data-md="b" title="Bold"><b>B</b></button><button class="btn sm ghost" type="button" data-md="i" title="Italics"><i>I</i></button>
          <button class="btn sm ghost" type="button" data-md="ul" title="List">\u2022 List</button><button class="btn sm ghost" type="button" data-md="link" title="Link">${ic('link')}Link</button><button class="btn sm ghost" type="button" data-fe="bimg" title="Picture">${ic('up')}Picture</button></div>
        <textarea data-k="body" class="fe-body" rows="20" placeholder="Write here. ## for a heading, - for a list, **bold**, [a link](https://\u2026).">${esc(x.body)}</textarea>
        <p class="fe-hint">${(x.body || '').trim().split(/\s+/).filter(Boolean).length} words \u00b7 about ${Math.max(1, Math.round((x.body || '').trim().split(/\s+/).filter(Boolean).length / 200))} min read</p>
      </section>
      <section class="fe-sec"><label class="fe-checks"><span><input type="checkbox" data-k="draft" ${x.draft ? 'checked' : ''}> Draft: save it to the website but keep it off the site</span></label></section>`;
}
/** Roughly how it looks on the website. */
function previewHtml() {
    const e = F.ed, x = e.x;
    if (e.tab === 'blog') {
        return `<article class="fe-art">${x.cover ? `<div class="fe-acov">${img(x.cover, '')}</div>` : ''}<small>${esc(day(x.date))}${x.tag ? ' \u00b7 ' + esc(x.tag) : ''}${x.author ? ' \u00b7 ' + esc(x.author) : ''}</small>
            <h1>${esc(x.title || 'Your title')}</h1>${x.excerpt ? `<p class="fe-lead">${esc(x.excerpt)}</p>` : ''}<div class="fe-md">${md(x.body) || '<p class="fe-hint">The text shows here as you write.</p>'}</div></article>`;
    }
    const s = x.site, pic = x.cover || (s && s.pages && s.pages[0] && s.pages[0].image);
    const card = `<div class="fe-pcard"><div class="fe-pth" style="--g:${esc(grad(x.gradient))}">${img(pic)}</div><div class="fe-pb"><small>${esc(x.category || 'Category')}</small><b>${esc(x.title || 'Title')}</b><p>${esc(x.summary || 'The summary shows here.')}</p>
        ${(x.results || []).length ? `<div class="fe-pres">${x.results.map(r => `<div><b>${esc(r.value)}</b><span>${esc(r.label)}</span></div>`).join('')}</div>` : ''}
        ${(x.tags || []).length ? `<div class="fe-ptags">${x.tags.map(t => `<span>${esc(t)}</span>`).join('')}</div>` : ''}<span class="fe-pst">${esc(x.status || '')}</span></div></div>`;
    const viewer = s ? `<div class="fe-pview"><div class="fe-pbar" style="--c:${esc(/^#[0-9a-f]{3,8}$/i.test(s.color || '') ? s.color : '#186aff')}"><i></i><i></i><i></i><span>${esc(s.host || 'example.com')}${esc(((s.pages || [])[e.page || 0] || {}).path || '/')}</span></div>
        <div class="fe-pscr">${img(((s.pages || [])[e.page || 0] || {}).image) || '<span class="fe-hint">The screenshot shows here.</span>'}</div>
        <div class="fe-ptabs">${(s.pages || []).map((p, i) => `<button type="button" data-fe="ppage" data-i="${i}" class="${(e.page || 0) === i ? 'on' : ''}">${esc(p.label || 'Page ' + (i + 1))}</button>`).join('')}</div>
        <p><b>${esc(s.headline || s.name || '')}</b> ${esc(s.description || '')}</p></div>` : '';
    return `<small class="fe-plabel">The card on the Work page</small>${card}${viewer ? '<small class="fe-plabel">Browse the real sites</small>' + viewer : ''}`;
}
function editorHtml(tab, id) {
    const e = startEditor(tab, id);
    if (!e) return `<div class="head"><div><a class="btn sm ghost" href="#frontend/${tab}">\u2190 ${TABS.find(t => t[0] === tab)[1]}</a><h1>Not found</h1><p class="sub">It is not on the website any more. Someone may have removed it.</p></div></div>`;
    const what = TABS.find(t => t[0] === tab)[1];
    const name = e.x.title || (tab === 'blog' ? 'New article' : tab === 'websites' ? 'New website' : 'New work');
    const live = !e.isNew && (tab === 'blog' ? `${siteUrl()}/blog/${e.id}.html` : `${siteUrl()}/work.html`);
    return `<div class="head fe-head"><div><a class="btn sm ghost fe-back" href="#frontend/${tab}" data-fe-leave>\u2190 ${what}</a><h1>${e.isNew ? esc(name) : 'Edit \u00b7 ' + esc(name)}</h1>
        <p class="sub">${e.isNew ? 'Publishing puts it on the website in about a minute.' : 'Your changes go live when you press Publish.'}</p></div><div class="sp"></div>
        <span id="fe-status">${chip()}</span>${live ? `<a class="btn" href="${esc(live)}" target="_blank" rel="noopener">${ic('globe')}View on the site</a>` : ''}</div>
      <div class="fe-ed"><form class="card fe-form" id="fe-form" onsubmit="return false">${tab === 'blog' ? postForm(e) : workForm(e)}</form>
        <aside class="card fe-prev" aria-label="Preview"><div class="fe-ph"><b>Preview</b><small>roughly how it looks on the website</small></div><div id="fe-preview">${previewHtml()}</div></aside></div>
      <div class="fe-bar">${e.isNew ? '' : `<button class="btn ghost danger" type="button" data-fe="remove" title="Remove from the website" aria-label="Remove from the website">${ic('trash')}<span class="fe-rm">Remove from the website</span></button>`}<span class="sp"></span>
        <span class="fe-dirty" id="fe-dirty" ${e.dirty ? '' : 'hidden'}>Not published yet</span>
        <a class="btn" href="#frontend/${tab}" data-fe-leave>Cancel</a><button class="btn pri" type="button" data-fe="publish" id="fe-pub">${ic('up')}Publish</button></div>`;
}
function paint() { const f = $('#fe-form'); if (!f || !F.ed) return; f.innerHTML = F.ed.tab === 'blog' ? postForm(F.ed) : workForm(F.ed); preview(); }
function preview() { const p = $('#fe-preview'); if (p && F.ed) p.innerHTML = previewHtml(); }
function dirty() { if (!F.ed) return; F.ed.dirty = true; const d = $('#fe-dirty'); if (d) d.hidden = false; }

// ------------------------------------------------------------------ images: shrunk here, uploaded one at a time
async function shrink(file, maxW, maxBytes = 1300000) {
    const url = URL.createObjectURL(file);
    try {
        const im = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('That file is not an image this browser can read.')); i.src = url; });
        const scale = Math.min(1, maxW / im.naturalWidth);
        const w = Math.round(im.naturalWidth * scale), h = Math.min(16000, Math.round(im.naturalHeight * scale));
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(im, 0, 0, w, Math.round(im.naturalHeight * scale));
        for (const q of [0.85, 0.75, 0.65, 0.55, 0.45]) {
            const blob = await new Promise(ok => c.toBlob(ok, 'image/jpeg', q));
            if (blob && blob.size <= maxBytes) {
                const data = await new Promise(ok => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.readAsDataURL(blob); });
                return { data, type: 'image/jpeg', size: blob.size, blob };
            }
        }
        throw new Error('That image is too large even after shrinking. Crop it and try again.');
    } finally { URL.revokeObjectURL(url); }
}
function pick(maxW) {
    return new Promise(resolve => {
        const e = F.ed; sync();
        const key = e.id || slug(e.x.title);
        if (!key) { toast('Give it a title first: pictures are kept under its address.', true); return resolve(null); }
        const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/jpeg,image/png,image/webp';
        inp.onchange = async () => {
            const f = inp.files && inp.files[0]; if (!f) return resolve(null);
            try {
                toast('Preparing the picture\u2026');
                const s = await shrink(f, maxW);
                const r = await api('/api/site/images', { method: 'POST', body: { kind: e.tab === 'blog' ? 'blog' : 'work', slug: key, name: f.name, type: s.type, data: s.data } });
                e.id = key; e.idLocked = true;   // pictures are stored under the address, so it is fixed from now on
                e.uploads.push(r); e.previews[r.path] = URL.createObjectURL(s.blob);
                toast(`Picture ready (${Math.round(s.size / 1024)} KB). It goes live when you publish.`);
                dirty(); resolve(r);
            } catch (err) { toast(err.message, true); resolve(null); }
        };
        inp.click();
    });
}
function wrapSel(ta, before, after = before, placeholder = 'text') {
    const a = ta.selectionStart, b = ta.selectionEnd, sel = ta.value.slice(a, b) || placeholder;
    ta.setRangeText(before + sel + after, a, b, 'select'); ta.focus();
    ta.dispatchEvent(new Event('input', { bubbles: true }));
}
function linePrefix(ta, prefix) {
    const a = ta.selectionStart, start = ta.value.lastIndexOf('\n', a - 1) + 1;
    ta.setRangeText(prefix, start, start, 'end'); ta.focus();
    ta.dispatchEvent(new Event('input', { bubbles: true }));
}

// ------------------------------------------------------------------ publish and remove
async function publish(btn) {
    sync();
    const e = F.ed;
    if (!e.id) return toast('Give it a title first.', true);
    btn.disabled = true; btn.innerHTML = 'Publishing\u2026';
    const uploads = e.uploads.map(u => ({ repoPath: u.repoPath, blob: u.blob }));
    try {
        let r;
        if (e.tab === 'blog') { const { body, ...fm } = e.x; r = await api(`/api/site/blog/${encodeURIComponent(e.id)}`, { method: 'PUT', body: { post: { ...fm, body }, sha: e.sha, uploads } }); }
        else { const x = JSON.parse(JSON.stringify(e.x)); if (x.site && !x.site.key) x.site.key = slug(x.site.name || e.id); r = await api(`/api/site/work/${encodeURIComponent(e.id)}`, { method: 'PUT', body: { item: x, sha: e.sha, uploads } }); }
        const tab = e.tab;
        F.ed = null; F.d = null;
        toast(r.unchanged ? 'Nothing had changed, so nothing was published.' : 'Published. The website rebuilds in about a minute.');
        if (!r.unchanged) { F.status = { build: { state: 'pending' }, commits: (F.status && F.status.commits) || [] }; watch(); }
        location.hash = 'frontend/' + tab;
    } catch (err) {
        btn.disabled = false; btn.innerHTML = `${ic('up')}Publish`;
        toast(err.message, true);
        if (err.data && err.data.code === 'site_conflict') { const tab = e.tab, key = e.key; F.ed = null; F.d = null; await load(true); location.hash = `frontend/${tab}/${key}`; C.render(); }
    }
}
async function remove() {
    const e = F.ed;
    if (!confirm(`Remove \u201c${e.x.title}\u201d${e.tab === 'blog' ? '' : ' and its pictures'} from the website?`)) return;
    try {
        const r = e.tab === 'blog' ? await api(`/api/site/blog/${encodeURIComponent(e.id)}?sha=${e.sha}`, { method: 'DELETE' })
            : await api(`/api/site/work/${encodeURIComponent(e.id)}?sha=${e.sha}`, { method: 'DELETE' });
        const tab = e.tab; F.ed = null; F.d = null;
        toast('Removed. The website rebuilds in about a minute.');
        if (!r.unchanged) watch();
        location.hash = 'frontend/' + tab;
    } catch (err) { toast(err.message, true); }
}

// ------------------------------------------------------------------ the page
C.views.frontend = async arg => {
    const [t0, id] = String(arg || '').split('/');
    const tab = TABS.some(t => t[0] === t0) ? t0 : 'works';
    if (!C.isAdmin()) return '<div class="card"><div class="empty">Only the owner publishes to the website.</div></div>';
    try { await load(); } catch (e) { return notSetUp(e); }
    if (!F.status) loadStatus();
    if (!id && F.ed && !F.ed.dirty) F.ed = null;
    return id ? editorHtml(tab, id) : listHtml(tab);
};
C.mounted.frontend = () => {
    const st = $('#fe-status'); if (st && F.status) st.innerHTML = chip();
    const root = $('#view .fe-ed');
    if (!root || !F.ed) return;
    root.addEventListener('input', ev => {
        if (ev.target.matches('[data-colorpick]')) { const t = root.querySelector('[data-s="color"]'); if (t) t.value = ev.target.value; }
        sync(); dirty(); preview();
    });
    root.addEventListener('change', ev => { if (ev.target.matches('[data-repaint]')) { sync(); paint(); } });
};
if (!F.bound) {
    F.bound = true;
    document.addEventListener('click', async ev => {
        if (C.route !== 'frontend') return;
        const t = ev.target;
        if (t.closest('[data-fe="retry"]')) { F.d = null; return C.render(); }
        const leave = t.closest('[data-fe-leave], .rail a, .tabbar a');
        if (leave && F.ed && F.ed.dirty && !confirm('Leave without publishing? Your changes are not on the website yet.')) { ev.preventDefault(); return; }
        if (leave && F.ed) { F.ed = null; return; }
        const md2 = t.closest('[data-md]');
        if (md2) {
            const ta = $('#fe-form [data-k="body"]'); if (!ta) return;
            const k = md2.dataset.md;
            if (k === 'b') wrapSel(ta, '**'); else if (k === 'i') wrapSel(ta, '*'); else if (k === 'h2') linePrefix(ta, '## '); else if (k === 'ul') linePrefix(ta, '- ');
            else if (k === 'link') { const u = prompt('Link address (https://\u2026)'); if (u) wrapSel(ta, '[', `](${u.trim()})`, 'link text'); }
            return;
        }
        const b = t.closest('[data-fe]'); if (!b || !F.ed) return;
        const e = F.ed, x = e.x, k = b.dataset.fe, i = +b.dataset.i;
        if (k === 'publish') return publish(b);
        if (k === 'remove') return remove();
        if (k === 'ppage') { e.page = i; return preview(); }
        sync();
        if (k === 'cover') { const r = await pick(1600); if (r) { x.cover = r.path; paint(); } }
        else if (k === 'nocover') { delete x.cover; delete x.coverAlt; dirty(); paint(); }
        else if (k === 'addsite') { x.site = { name: (x.title || '').split(':')[0], subtitle: '', host: '', color: '#186aff', headline: (x.title || '').split(':')[0], description: '', stack: [], order: 10, signInOnly: false, pages: [{ label: 'Home', path: '/' }] }; dirty(); paint(); }
        else if (k === 'nosite') { delete x.site; dirty(); paint(); }
        else if (k === 'padd') { x.site.pages.push({ label: '', path: '/' }); paint(); }
        else if (k === 'pdel') { x.site.pages.splice(i, 1); e.page = 0; dirty(); paint(); }
        else if (k === 'pup' && i > 0) { const p = x.site.pages; [p[i - 1], p[i]] = [p[i], p[i - 1]]; dirty(); paint(); }
        else if (k === 'pimg') { const r = await pick(1440); if (r) { x.site.pages[i].image = r.path; e.page = i; paint(); } }
        else if (k === 'bimg') {
            const ta = $('#fe-form [data-k="body"]'), at = ta ? ta.selectionStart : (x.body || '').length;
            const r = await pick(1400); if (!r) return;
            x.body = (x.body || '').slice(0, at) + `\n\n![](${r.path})\n\n` + (x.body || '').slice(at); paint();
        }
    });
    addEventListener('beforeunload', ev => { if (F.ed && F.ed.dirty) { ev.preventDefault(); ev.returnValue = ''; } });
}
})();
