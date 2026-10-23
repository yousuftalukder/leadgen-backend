/**
 * Publishing to the EdgeLead website (phase 66).
 *
 * Part of the EdgeLead server, split out of server.js (phase 55). The parts load in
 * order from server.js and share one namespace, S: what this part needs from an earlier
 * part is unpacked below; anything else from another part is read as S.name when it runs.
 */
'use strict';
const S = require('./shared');
const { app, crypto, logger, oneLine, requireAdmin, sendErr } = S;
Object.assign(S, {
    siteConfig, siteCleanWork, siteCleanPost, siteCleanService, siteCleanSettings,
    siteParseFrontmatter, siteFrontmatter, siteSlug, siteUploadPath, sitePublish, siteBuildState
});

// ===========================================================================
// PHASE 66 :: THE WEBSITE'S CONTENT, PUBLISHED FROM HERE
//
// edgelead.com.bd is a static site (repository edgelead-site). Its work and proof, blog,
// prices, plan tables, results figures and Edge Meta AI answers are files under
// src/content/ and public/uploads/ in that repository. Publishing is a commit to its
// main branch; Netlify rebuilds, and the site shows that content until the next publish.
// The site's build validates every file against its own schemas (src/lib/schemas.ts),
// and the cleaners below apply the same rules first, so a bad entry is refused here
// with a message instead of failing the build. Nothing on the site is fetched live.
//
// One save is one commit: the content file plus any images uploaded for it, built on
// the branch as it is when the save arrives. A save carries the version of the file the
// page opened (its blob sha); if someone published that file since, the save is refused
// rather than overwriting their change. Images are uploaded first, one per request (the
// API's JSON limit is 2 MB), as unreferenced git blobs; the save puts them in its tree.
// Images an item no longer uses are removed in the same commit.
//
// Contract: docs/WORKSPACE-CONTENT.md in edgelead-site. Admins only.
// ===========================================================================
const SITE_SERVICES = ['social', 'ads', 'leads', 'seo', 'influencers', 'reporting', 'websites'];
S.SITE_SERVICES = SITE_SERVICES;
const WORK_KINDS = ['website', 'campaign', 'software'];
const WORK_FILTERS = ['Software', 'AI', 'Websites', 'Campaigns', 'Bangladesh', 'United States'];
const CONTENT = 'src/content';
const UPLOADS = 'public/uploads';
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const IMAGE_MAX = 1400000;                 // bytes after decoding; the JSON body limit is 2 MB
const ASSET = /^\/[\w\-./]+\.(jpe?g|png|webp|avif|gif|svg)$/i;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const SHA = /^[0-9a-f]{40}$/;

function siteConfig() {
    return {
        repo: process.env.SITE_REPO || 'yousuftalukder/edgelead-site',
        branch: process.env.SITE_BRANCH || 'main',
        token: process.env.SITE_REPO_TOKEN || '',
        url: (process.env.SITE_PUBLIC_URL || '').replace(/\/+$/, '')
    };
}
function siteFail(message, status = 400, code) { const e = new Error(message); e.statusCode = status; if (code) e.code = code; return e; }

// ---- cleaning: the site's schemas, applied before anything is committed ----------

const text = (v, max, label, required = true) => {
    const s = oneLine(v, max);
    if (required && !s) throw siteFail(`${label} is required.`);
    return s;
};
const para = (v, max) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
const list = (v, max, each) => (Array.isArray(v) ? v : []).map(x => oneLine(x, each)).filter(Boolean).slice(0, max);
const asset = (v, label) => {
    if (v === undefined || v === null || v === '') return undefined;
    const s = String(v).trim();
    if (!ASSET.test(s) || s.includes('..')) throw siteFail(`${label} must be an image path such as /uploads/work/name/cover.jpg.`);
    return s;
};
const day = (v, label, required = false) => {
    if (v === undefined || v === null || v === '') { if (required) throw siteFail(`${label} is required.`); return undefined; }
    const s = String(v).slice(0, 10);
    if (!ISO_DAY.test(s) || isNaN(Date.parse(s))) throw siteFail(`${label} must be a date (YYYY-MM-DD).`);
    return s;
};
const num = (v, label, def) => {
    if (v === undefined || v === null || v === '') return def;
    const n = Number(v);
    if (!Number.isFinite(n)) throw siteFail(`${label} must be a number.`);
    return n;
};

function siteSlug(v) {
    const s = String(v || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
    if (!s) throw siteFail('Give it a name made of letters or numbers.');
    return s;
}

/** A work item: a website, campaign or software project, its card and its optional live-site viewer. */
function siteCleanWork(b = {}) {
    const out = {
        title: text(b.title, 160, 'Title'),
        kind: WORK_KINDS.includes(b.kind) ? b.kind : (() => { throw siteFail('Kind must be website, campaign or software.'); })(),
        category: text(b.category, 80, 'Category'),
        status: text(b.status, 40, 'Status'),
        filters: [...new Set((Array.isArray(b.filters) ? b.filters : []).filter(f => WORK_FILTERS.includes(f)))],
        summary: text(para(b.summary, 600).replace(/\s+/g, ' '), 600, 'Summary'),
        tags: list(b.tags, 8, 40),
        gradient: oneLine(b.gradient, 160) || 'linear-gradient(160deg,#186aff,#0b3b8f)'
    };
    if (/[;{}<>]|url\(/i.test(out.gradient)) throw siteFail('The card colour must be a plain CSS gradient.');
    const cover = asset(b.cover, 'Cover');
    if (cover) { out.cover = cover; const alt = oneLine(b.coverAlt, 160); if (alt) out.coverAlt = alt; }
    if (typeof b.mockupHtml === 'string' && b.mockupHtml) out.mockupHtml = b.mockupHtml.slice(0, 20000);
    const results = (Array.isArray(b.results) ? b.results : [])
        .map(r => ({ label: oneLine(r && r.label, 40), value: oneLine(r && r.value, 24) }))
        .filter(r => r.label && r.value);
    if (results.length > 4) throw siteFail('Up to four results on a card.');
    out.results = results;
    const date = day(b.date, 'Date'); if (date) out.date = date;
    out.order = num(b.order, 'Order', 999);
    out.showCard = b.showCard !== false;
    out.published = b.published !== false;
    out.services = [...new Set((Array.isArray(b.services) ? b.services : []).filter(s => SITE_SERVICES.includes(s)))];
    out.related = {};
    for (const s of out.services) {
        const r = b.related && b.related[s];
        if (r && (r.title || r.text)) out.related[s] = { title: text(r.title, 120, 'Related title'), text: text(r.text, 300, 'Related text') };
    }
    if (b.site) {
        const v = b.site;
        const pages = (Array.isArray(v.pages) ? v.pages : []).map((p, i) => ({
            label: text(p && p.label, 40, `Screen ${i + 1} label`),
            path: oneLine(p && p.path, 200) || '/',
            image: asset(p && p.image, `Screen ${i + 1} image`) || (() => { throw siteFail(`Screen ${i + 1} needs a screenshot.`); })()
        }));
        if (!pages.length) throw siteFail('The live-site viewer needs at least one screen.');
        if (pages.length > 12) throw siteFail('Up to twelve screens per site.');
        const host = oneLine(v.host, 120).replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
        if (!/^[a-z0-9.-]+\.[a-z]{2,}(:\d+)?$/i.test(host)) throw siteFail('The site address must be a domain such as example.com.');
        const color = oneLine(v.color, 20) || '#186aff';
        if (!/^#[0-9a-f]{3,8}$/i.test(color)) throw siteFail('The site colour must be a hex colour such as #186aff.');
        out.site = {
            key: siteSlug(v.key || v.name),
            name: text(v.name, 60, 'Site name'),
            subtitle: text(v.subtitle, 60, 'Site subtitle'),
            color, host,
            signInOnly: v.signInOnly === true,
            headline: text(v.headline || v.name, 120, 'Site headline'),
            description: text(v.description, 400, 'Site description'),
            stack: list(v.stack, 8, 40),
            order: num(v.order, 'Viewer order', 999),
            pages
        };
    }
    return out;
}

/** A blog post: its frontmatter fields and its Markdown body. */
function siteCleanPost(b = {}) {
    const fm = {
        title: text(b.title, 160, 'Title'),
        date: day(b.date, 'Date', true),
        excerpt: text(b.excerpt, 300, 'Excerpt')
    };
    const cover = asset(b.cover, 'Cover'); if (cover) fm.cover = cover;
    const gradient = oneLine(b.gradient, 160);
    if (gradient) { if (/[;{}<>]|url\(/i.test(gradient)) throw siteFail('The card colour must be a plain CSS gradient.'); fm.gradient = gradient; }
    const tag = oneLine(b.tag, 30); if (tag) fm.tag = tag;
    const author = oneLine(b.author, 60); if (author) fm.author = author;
    fm.draft = b.draft === true;
    const body = para(b.body, 60000);
    if (!body) throw siteFail('The article has no text.');
    if (/^---\s*$/m.test(body.split('\n')[0])) throw siteFail('The article text cannot start with ---.');
    return { fm, body };
}

/** A service's pricing card, plan table and results figures. The name, order, accent and page stay as the site has them. */
function siteCleanService(b = {}, current = {}) {
    const p = b.pricing || {};
    const pricing = {
        price: oneLine(p.price, 80) || null,
        onRequest: oneLine(p.onRequest, 80) || 'Price on request · quoted after a free review',
        points: list(p.points, 6, 120),
        linkText: oneLine(p.linkText, 60) || 'Deliverables and plans'
    };
    if (!pricing.points.length) throw siteFail('The pricing card needs at least one line.');
    const pl = b.plans || {};
    const columns = list(pl.columns, 5, 40);
    if (!columns.length) throw siteFail('The plan table needs at least one plan.');
    const rows = (Array.isArray(pl.rows) ? pl.rows : []).map((r, i) => {
        const label = text(r && r.label, 80, `Row ${i + 1} name`);
        const values = (Array.isArray(r && r.values) ? r.values : []).map(v => (v === true || v === false ? v : oneLine(v, 60)));
        if (values.length !== columns.length) throw siteFail(`"${label}" has ${values.length} values for ${columns.length} plans.`);
        if (values.some(v => v === '')) throw siteFail(`"${label}" has an empty cell. Use ✓, — or some words.`);
        return { label, values };
    });
    if (!rows.length) throw siteFail('The plan table needs at least one row.');
    if (rows.length > 16) throw siteFail('Up to sixteen rows in a plan table.');
    const plans = { caption: oneLine(pl.caption, 40) || 'Per month', columns, rows };
    const pop = num(pl.popular, 'Highlighted plan', undefined);
    if (pop !== undefined && pop !== null) {
        if (!Number.isInteger(pop) || pop < 0 || pop >= columns.length) throw siteFail('The highlighted plan must be one of the plans.');
        plans.popular = pop;
    }
    const note = para(pl.note, 400).replace(/\s+/g, ' '); if (note) plans.note = note;
    const out = { name: current.name, order: current.order, accent: current.accent, page: current.page, pricing, plans };
    if (b.results) out.results = siteCleanResults(b.results, 'Results');
    return out;
}

function siteCleanResults(r, label) {
    const metrics = (Array.isArray(r.metrics) ? r.metrics : []).map((m, i) => {
        const trend = (Array.isArray(m && m.trend) ? m.trend : String((m && m.trend) || '').split(/[\s,]+/))
            .filter(x => x !== '' && x !== null && x !== undefined).map(Number);
        if (trend.length < 2 || trend.some(n => !Number.isFinite(n))) throw siteFail(`${label}: figure ${i + 1} needs at least two numbers for its trend line.`);
        const o = {
            value: text(m.value, 24, `${label}: figure ${i + 1} value`),
            change: text(m.change, 24, `${label}: figure ${i + 1} change`),
            label: text(m.label, 40, `${label}: figure ${i + 1} label`),
            trend: trend.slice(0, 16),
            lowerIsBetter: m.lowerIsBetter === true
        };
        const to = num(m.countTo, `${label}: figure ${i + 1} count`, undefined);
        if (to !== undefined) o.countTo = to;
        return o;
    });
    if (!metrics.length) throw siteFail(`${label} needs at least one figure.`);
    if (metrics.length > 6) throw siteFail(`${label}: up to six figures.`);
    return {
        note: text(para(r.note, 300).replace(/\s+/g, ' '), 300, `${label} source note`),
        updated: day(r.updated, `${label} date`) || new Date().toISOString().slice(0, 10),
        placeholder: r.placeholder === true,
        metrics
    };
}

/** settings.json: contact, the price switch, the ticker, the homepage stat and the Edge Meta AI answers. */
function siteCleanSettings(b = {}) {
    const c = b.contact || {};
    const st = b.stat || {};
    const series = (Array.isArray(st.series) ? st.series : String(st.series || '').split(/[\s,]+/)).filter(x => x !== '').map(Number);
    if (series.length < 2 || series.some(n => !Number.isFinite(n))) throw siteFail('The homepage stat needs at least two numbers for its line.');
    const row = (Array.isArray(st.row) ? st.row : []).map((x, i) => ({ value: num(x && x.value, `Stat ${i + 1}`, NaN), label: text(x && x.label, 30, `Stat ${i + 1} label`) }));
    if (row.length !== 3 || row.some(x => !Number.isFinite(x.value))) throw siteFail('The homepage stat needs exactly three smaller numbers.');
    const ma = b.metaAi || {};
    const qa = (Array.isArray(ma.qa) ? ma.qa : []).map((q, i) => ({
        q: text(q && q.q, 120, `Question ${i + 1}`),
        a: text(para(q && q.a, 500).replace(/\s+/g, ' '), 500, `Answer ${i + 1}`),
        lang: q && q.lang === 'bn' ? 'bn' : 'en',
        bars: (Array.isArray(q && q.bars) ? q.bars : []).map(x => ({ label: text(x && x.label, 20, `Answer ${i + 1} bar`), value: Math.max(0, Math.min(100, Math.round(num(x && x.value, 'Bar', 0)))) })).slice(0, 6)
    }));
    if (!qa.length) throw siteFail('Edge Meta AI needs at least one question.');
    if (qa.length > 6) throw siteFail('Up to six Edge Meta AI questions.');
    const ticker = list(b.ticker, 12, 120);
    if (!ticker.length) throw siteFail('The ticker needs at least one line.');
    if (!Number.isFinite(Number(st.value))) throw siteFail('The homepage stat needs its big number.');
    return {
        contact: { phone: text(c.phone, 40, 'Phone'), email: text(c.email, 120, 'Email'), office: text(c.office, 120, 'Office') },
        showPrices: b.showPrices === true,
        ticker,
        stat: {
            heading: text(st.heading, 60, 'Stat heading'),
            value: num(st.value, 'Stat number', NaN),
            caption: text(para(st.caption, 300).replace(/\s+/g, ' '), 300, 'Stat caption'),
            series: series.slice(0, 60), row,
            updated: day(st.updated, 'Stat date') || new Date().toISOString().slice(0, 10),
            placeholder: st.placeholder === true
        },
        metaAi: { updated: day(ma.updated, 'Edge Meta AI date') || new Date().toISOString().slice(0, 10), placeholder: ma.placeholder === true, qa }
    };
}

// ---- Markdown frontmatter, the small subset the site's posts use ----------------

function siteParseFrontmatter(src) {
    const m = String(src || '').replace(/\r\n?/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!m) return { fm: {}, body: String(src || '').trim() };
    const fm = {};
    for (const line of m[1].split('\n')) {
        const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
        if (!kv) continue;
        let v = kv[2].trim();
        if (v.startsWith('"')) { try { v = JSON.parse(v.match(/^"(?:[^"\\]|\\.)*"/)[0]); } catch { v = v.replace(/^"|"$/g, ''); } }
        else if (v.startsWith("'")) v = v.replace(/^'|'(\s+#.*)?$/g, '').replace(/''/g, "'");
        else {
            v = v.replace(/\s+#.*$/, '').trim();
            if (v === 'true' || v === 'false') v = v === 'true';
        }
        fm[kv[1]] = v;
    }
    return { fm, body: m[2].trim() };
}
function siteFrontmatter(fm, body) {
    const lines = Object.entries(fm).filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}: ${typeof v === 'boolean' ? v : k === 'date' ? v : JSON.stringify(String(v))}`);
    return `---\n${lines.join('\n')}\n---\n\n${body.trim()}\n`;
}

// ---- GitHub: the repository is the website's database ----------------------------

async function gh(method, path, body) {
    const cfg = siteConfig();
    if (!cfg.token) throw siteFail('Publishing is not set up: add SITE_REPO_TOKEN on the server (see docs/DEPLOY-PHASE66.md).', 503, 'site_not_configured');
    const doFetch = S._siteFetch || fetch;
    const res = await doFetch(`https://api.github.com/repos/${cfg.repo}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'edgelead-workspace',
            ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) {
        const msg = (data && data.message) || `GitHub ${res.status}`;
        if (res.status === 401 || res.status === 403) throw siteFail(`GitHub refused the website token (${msg}). Check SITE_REPO_TOKEN.`, 502, 'site_token');
        const e = siteFail(`GitHub: ${msg}`, res.status === 404 ? 404 : 502, 'github');
        e.githubStatus = res.status;
        throw e;
    }
    return data;
}

async function siteHead() {
    const cfg = siteConfig();
    const ref = await gh('GET', `/git/ref/heads/${cfg.branch}`);
    const commit = await gh('GET', `/git/commits/${ref.object.sha}`);
    return { sha: ref.object.sha, tree: commit.tree.sha };
}
async function siteTree(treeSha) {
    const t = await gh('GET', `/git/trees/${treeSha}?recursive=1`);
    return (t.tree || []).filter(e => e.type === 'blob');
}
async function siteBlobText(sha) {
    const b = await gh('GET', `/git/blobs/${sha}`);
    return Buffer.from(b.content || '', b.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
}

/**
 * Commit a set of changes on top of the branch as it is now. `changes` maps a repo path to
 * { content } (text), { blob } (an uploaded image) or null (delete). `expect` maps a path to
 * the blob sha the page opened (null = must not exist yet); a mismatch is a conflict.
 * If the branch moves between building the commit and moving the ref, it is rebuilt once.
 */
async function sitePublish({ changes, expect = {}, message, removePrefix = null, keep = [] }) {
    const cfg = siteConfig();
    for (let attempt = 0; attempt < 2; attempt++) {
        const head = await siteHead();
        const files = await siteTree(head.tree);
        const bySha = new Map(files.map(f => [f.path, f.sha]));
        for (const [p, want] of Object.entries(expect)) {
            const have = bySha.get(p) || null;
            if ((want || null) !== have) throw siteFail(have ? 'Someone published this since you opened it. Reload to see their version, then make your change again.' : 'This was removed since you opened it. Reload the page.', 409, 'site_conflict');
        }
        const tree = [];
        for (const [p, c] of Object.entries(changes)) {
            if (c === null) { if (bySha.has(p)) tree.push({ path: p, mode: '100644', type: 'blob', sha: null }); }
            else if (c.blob) tree.push({ path: p, mode: '100644', type: 'blob', sha: c.blob });
            else tree.push({ path: p, mode: '100644', type: 'blob', content: c.content });
        }
        // Images in an item's upload folder that it no longer refers to go in the same commit.
        if (removePrefix) {
            for (const f of files) if (f.path.startsWith(removePrefix) && !keep.includes(f.path) && !(f.path in changes)) tree.push({ path: f.path, mode: '100644', type: 'blob', sha: null });
        }
        if (!tree.length) return { sha: head.sha, unchanged: true };
        const nt = await gh('POST', '/git/trees', { base_tree: head.tree, tree });
        if (nt.sha === head.tree) return { sha: head.sha, unchanged: true };
        const commit = await gh('POST', '/git/commits', { message, tree: nt.sha, parents: [head.sha] });
        try {
            await gh('PATCH', `/git/refs/heads/${cfg.branch}`, { sha: commit.sha, force: false });
            S._siteCache = null;
            return { sha: commit.sha };
        } catch (err) {
            if (attempt === 0 && err.githubStatus === 422) continue;   // the branch moved: rebuild on the new head
            throw err;
        }
    }
    throw siteFail('The website changed while saving. Try again.', 409, 'site_conflict');
}

/** Everything the page edits, read from the branch head. Cached briefly; a publish clears it. */
async function siteContent() {
    if (S._siteCache && Date.now() - S._siteCache.t < 20000) return S._siteCache.v;
    const head = await siteHead();
    const files = await siteTree(head.tree);
    const pick = re => files.filter(f => re.test(f.path));
    const read = async f => ({ path: f.path, sha: f.sha, text: await siteBlobText(f.sha) });
    const [work, blog, services, settings] = await Promise.all([
        Promise.all(pick(/^src\/content\/work\/[^/]+\.json$/).map(read)),
        Promise.all(pick(/^src\/content\/blog\/[^/]+\.md$/).map(read)),
        Promise.all(pick(/^src\/content\/services\/[^/]+\.json$/).map(read)),
        Promise.all(pick(/^src\/content\/settings\.json$/).map(read))
    ]);
    const json = (f, kind) => { try { return JSON.parse(f.text); } catch { throw siteFail(`${f.path} is not valid JSON; fix it in the repository.`, 502); } };
    const id = (p, ext) => p.split('/').pop().slice(0, -ext.length);
    const v = {
        head: head.sha,
        work: work.map(f => ({ id: id(f.path, '.json'), sha: f.sha, data: json(f) })).sort((a, b) => (a.data.order ?? 999) - (b.data.order ?? 999)),
        blog: blog.map(f => { const { fm, body } = siteParseFrontmatter(f.text); return { id: id(f.path, '.md'), sha: f.sha, data: { ...fm, body } }; })
            .sort((a, b) => String(b.data.date || '').localeCompare(String(a.data.date || ''))),
        services: services.map(f => ({ id: id(f.path, '.json'), sha: f.sha, data: json(f) }))
            .filter(s => SITE_SERVICES.includes(s.id)).sort((a, b) => (a.data.order ?? 9) - (b.data.order ?? 9)),
        settings: settings[0] ? { sha: settings[0].sha, data: json(settings[0]) } : null
    };
    S._siteCache = { t: Date.now(), v };
    return v;
}

/** Netlify reports each build back to GitHub as a commit status or check run, when its GitHub app is connected. */
async function siteBuildState(sha) {
    const [st, checks] = await Promise.all([
        gh('GET', `/commits/${sha}/status`).catch(() => null),
        gh('GET', `/commits/${sha}/check-runs?per_page=20`).catch(() => null)
    ]);
    const reports = [
        ...((st && st.statuses) || []).map(s => ({ name: s.context, state: s.state, url: s.target_url, text: s.description })),
        ...((checks && checks.check_runs) || []).map(c => ({
            name: c.name, url: c.details_url || c.html_url, text: c.output && c.output.title,
            state: c.status !== 'completed' ? 'pending' : ['success', 'neutral', 'skipped'].includes(c.conclusion) ? 'success' : 'failure'
        }))
    ];
    if (!reports.length) return { state: 'unknown', reports };
    const state = reports.some(r => r.state === 'failure' || r.state === 'error') ? 'failure'
        : reports.some(r => r.state === 'pending') ? 'pending' : 'success';
    return { state, reports };
}

/** public/uploads/<kind>/<slug>/<name>-<random>.<ext>, a path only this part makes. */
function siteUploadPath(kind, slug, name, type) {
    if (!['work', 'blog'].includes(kind)) throw siteFail('Images belong to work or blog.');
    const ext = IMAGE_TYPES[type];
    if (!ext) throw siteFail('Use a JPG, PNG or WebP image.');
    const base = siteSlug(String(name || 'image').replace(/\.[a-z0-9]+$/i, '')).slice(0, 40) || 'image';
    return `${UPLOADS}/${kind}/${siteSlug(slug)}/${base}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
}

/** Uploaded blobs a save may put in its tree: inside public/uploads, real shas. */
function cleanUploads(list, prefix) {
    const out = {};
    for (const u of Array.isArray(list) ? list : []) {
        const p = String(u && u.repoPath || '');
        if (!p.startsWith(prefix) || p.includes('..') || !SHA.test(String(u.blob || ''))) throw siteFail('An uploaded image is not from this page. Upload it again.');
        out[p] = { blob: u.blob };
    }
    return out;
}
const toRepo = sitePath => `public${sitePath}`;
const requireSha = v => { const s = String(v || ''); if (!SHA.test(s)) throw siteFail('Reload the page and try again.'); return s; };
const who = ctx => (ctx.profile && (ctx.profile.full_name || ctx.profile.email)) || (ctx.user && ctx.user.email) || 'workspace';
const commitMsg = (what, ctx) => `content: ${what}\n\nPublished from the EdgeLead workspace by ${who(ctx)}.`;
function published(res, out, extra = {}) {
    const cfg = siteConfig();
    res.json({ ok: true, commit: out.sha, unchanged: !!out.unchanged, siteUrl: cfg.url || null, ...extra });
}

// ---- routes ----------------------------------------------------------------------

app.get('/api/site/content', async (req, res) => {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        if (req.query.fresh) S._siteCache = null;
        const cfg = siteConfig();
        res.json({ ...(await siteContent()), repo: cfg.repo, branch: cfg.branch, siteUrl: cfg.url || null });
    } catch (err) { sendErr(res, err); }
});

app.get('/api/site/status', async (req, res) => {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        const cfg = siteConfig();
        const commits = await gh('GET', `/commits?sha=${encodeURIComponent(cfg.branch)}&per_page=8`);
        const latest = (commits || [])[0];
        const build = latest ? await siteBuildState(latest.sha) : { state: 'unknown', reports: [] };
        res.json({
            repo: cfg.repo, branch: cfg.branch, siteUrl: cfg.url || null, build,
            commits: (commits || []).map(c => ({ sha: c.sha, message: String(c.commit.message || '').split('\n')[0], at: c.commit.author && c.commit.author.date, url: c.html_url }))
        });
    } catch (err) { sendErr(res, err); }
});

/** One image, stored as an unreferenced blob until a save puts it in a commit. */
app.post('/api/site/images', async (req, res) => {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        const { kind, slug, name, type, data } = req.body || {};
        const repoPath = siteUploadPath(kind, slug, name, type);
        const b64 = String(data || '').replace(/^data:[^,]*,/, '');
        if (!/^[A-Za-z0-9+/]+=*$/.test(b64)) throw siteFail('The image did not arrive whole. Try again.');
        const bytes = Buffer.from(b64, 'base64');
        if (!bytes.length) throw siteFail('The image is empty.');
        if (bytes.length > IMAGE_MAX) throw siteFail('The image is over 1.4 MB even after shrinking. Use a smaller one.');
        const sig = bytes.subarray(0, 12).toString('hex');
        const real = sig.startsWith('ffd8ff') ? 'image/jpeg' : sig.startsWith('89504e47') ? 'image/png' : (sig.startsWith('52494646') && sig.endsWith('57454250')) ? 'image/webp' : null;
        if (real !== type) throw siteFail('That file is not the image type it says it is.');
        const blob = await gh('POST', '/git/blobs', { content: b64, encoding: 'base64' });
        res.json({ repoPath, path: repoPath.slice('public'.length), blob: blob.sha });
    } catch (err) { sendErr(res, err); }
});

app.put('/api/site/work/:id', async (req, res) => {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        const id = siteSlug(req.params.id);
        if (id !== req.params.id) throw siteFail('That is not a valid work id.');
        const item = siteCleanWork(req.body && req.body.item);
        const path = `${CONTENT}/work/${id}.json`;
        const uploads = cleanUploads(req.body && req.body.uploads, `${UPLOADS}/work/${id}/`);
        const used = [item.cover, ...(item.site ? item.site.pages.map(p => p.image) : [])].filter(Boolean).map(toRepo);
        const out = await sitePublish({
            changes: { [path]: { content: JSON.stringify(item, null, 2) + '\n' }, ...Object.fromEntries(Object.entries(uploads).filter(([p]) => used.includes(p))) },
            expect: { [path]: (req.body && req.body.sha) || null },
            removePrefix: `${UPLOADS}/work/${id}/`, keep: used,
            message: commitMsg(`${req.body && req.body.sha ? 'update' : 'add'} work "${item.title}"`, ctx)
        });
        logger.info('site_publish', { what: 'work', id, by: ctx.user.id, commit: out.sha });
        published(res, out, { id });
    } catch (err) { sendErr(res, err); }
});

app.delete('/api/site/work/:id', async (req, res) => {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        const id = siteSlug(req.params.id);
        const path = `${CONTENT}/work/${id}.json`;
        const out = await sitePublish({
            changes: { [path]: null }, expect: { [path]: requireSha(req.query.sha) },
            removePrefix: `${UPLOADS}/work/${id}/`, message: commitMsg(`remove work "${id}"`, ctx)
        });
        logger.info('site_publish', { what: 'work_removed', id, by: ctx.user.id, commit: out.sha });
        published(res, out);
    } catch (err) { sendErr(res, err); }
});

app.put('/api/site/blog/:id', async (req, res) => {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        const id = siteSlug(req.params.id);
        if (id !== req.params.id) throw siteFail('That is not a valid article address.');
        const { fm, body } = siteCleanPost(req.body && req.body.post);
        const path = `${CONTENT}/blog/${id}.md`;
        const uploads = cleanUploads(req.body && req.body.uploads, `${UPLOADS}/blog/${id}/`);
        const used = Object.keys(uploads).filter(p => fm.cover === p.slice('public'.length) || body.includes(p.slice('public'.length)));
        const keepOld = [fm.cover, ...(body.match(/\/uploads\/blog\/[\w\-./]+/g) || [])].filter(Boolean).map(toRepo);
        const out = await sitePublish({
            changes: { [path]: { content: siteFrontmatter(fm, body) }, ...Object.fromEntries(used.map(p => [p, uploads[p]])) },
            expect: { [path]: (req.body && req.body.sha) || null },
            removePrefix: `${UPLOADS}/blog/${id}/`, keep: [...new Set([...keepOld, ...used])],
            message: commitMsg(`${req.body && req.body.sha ? 'update' : 'add'} article "${fm.title}"${fm.draft ? ' (draft)' : ''}`, ctx)
        });
        logger.info('site_publish', { what: 'blog', id, by: ctx.user.id, commit: out.sha });
        published(res, out, { id });
    } catch (err) { sendErr(res, err); }
});

app.delete('/api/site/blog/:id', async (req, res) => {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        const id = siteSlug(req.params.id);
        const path = `${CONTENT}/blog/${id}.md`;
        const out = await sitePublish({
            changes: { [path]: null }, expect: { [path]: requireSha(req.query.sha) },
            removePrefix: `${UPLOADS}/blog/${id}/`, message: commitMsg(`remove article "${id}"`, ctx)
        });
        logger.info('site_publish', { what: 'blog_removed', id, by: ctx.user.id, commit: out.sha });
        published(res, out);
    } catch (err) { sendErr(res, err); }
});

app.put('/api/site/services/:id', async (req, res) => {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        const id = req.params.id;
        if (!SITE_SERVICES.includes(id)) throw siteFail('Unknown service.', 404);
        const current = ((await siteContent()).services.find(s => s.id === id) || {}).data;
        if (!current) throw siteFail('That service has no file on the website yet.', 404);
        const svc = siteCleanService(req.body && req.body.service, current);
        if (!svc.results && current.results) svc.results = current.results;
        const path = `${CONTENT}/services/${id}.json`;
        const out = await sitePublish({
            changes: { [path]: { content: JSON.stringify(svc, null, 2) + '\n' } },
            expect: { [path]: (req.body && req.body.sha) || null },
            message: commitMsg(`update ${current.name}: pricing, plans and results`, ctx)
        });
        logger.info('site_publish', { what: 'service', id, by: ctx.user.id, commit: out.sha });
        published(res, out);
    } catch (err) { sendErr(res, err); }
});

app.put('/api/site/settings', async (req, res) => {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        const settings = siteCleanSettings(req.body && req.body.settings);
        const path = `${CONTENT}/settings.json`;
        const out = await sitePublish({
            changes: { [path]: { content: JSON.stringify(settings, null, 2) + '\n' } },
            expect: { [path]: (req.body && req.body.sha) || null },
            message: commitMsg('update site settings, homepage stat and Edge Meta AI answers', ctx)
        });
        logger.info('site_publish', { what: 'settings', by: ctx.user.id, commit: out.sha });
        published(res, out);
    } catch (err) { sendErr(res, err); }
});
