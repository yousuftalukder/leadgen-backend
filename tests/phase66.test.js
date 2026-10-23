#!/usr/bin/env node
/**
 * Phase 66 offline tests — publishing the website's content from the workspace.
 *
 * What matters: a bad entry is refused here with a message instead of failing the
 * site's build; a save is one commit with its images; a save never overwrites a change
 * someone else published since the page opened; images an item stops using go in the
 * same commit; and a branch that moves mid-save is retried once, not clobbered.
 * GitHub is an in-memory fake, so nothing touches the real repository.
 *
 *   node tests/phase66.test.js
 */
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const Module = require('module');
const path = require('path');

const chain = () => {
    const p = Promise.resolve({ data: null, error: null, count: 0 });
    const h = new Proxy(function () {}, {
        get: (_, k) => (k === 'then' ? p.then.bind(p) : k === 'catch' ? p.catch.bind(p) : k === 'finally' ? p.finally.bind(p) : () => h),
        apply: () => h
    });
    return h;
};
const stubs = {
    express: Object.assign(() => ({
        set() {}, use() {}, get() {}, post() {}, patch() {}, delete() {}, put() {}, listen() {}
    }), { json: () => (_, __, n) => n && n(), raw: () => (_, __, n) => n && n(), static: () => () => {} }),
    cors: () => () => {},
    'apify-client': { ApifyClient: class {} },
    '@supabase/supabase-js': { createClient: () => ({ from: chain, rpc: chain, auth: { getUser: async () => ({ data: null, error: new Error('stub') }) } }) },
    dotenv: { config() {} }
};
const realLoad = Module._load;
Module._load = function (req, ...rest) { return stubs[req] !== undefined ? stubs[req] : realLoad.call(this, req, ...rest); };
process.env.SUPABASE_URL = 'http://stub'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
delete process.env.RENDER;
process.env.SITE_REPO_TOKEN = 'test-token';
process.env.SITE_REPO = 'acme/site';

require(path.join(__dirname, '..', 'server.js'));
const S = require(path.join(__dirname, '..', 'src', 'shared'));

// ---- a small GitHub: refs, commits, trees and blobs, enough for the Git Data API calls ----
function fakeGitHub(files) {
    const h = s => crypto.createHash('sha1').update(s).digest('hex');
    const blobs = {}, trees = {}, commits = {};
    const blob = content => { const sha = h('blob' + content); blobs[sha] = content; return sha; };
    const tree = map => { const sha = h('tree' + JSON.stringify([...map].sort())); trees[sha] = new Map(map); return sha; };
    const root = tree(new Map(Object.entries(files).map(([p, c]) => [p, blob(c)])));
    let head = h('c0'); commits[head] = { tree: root, message: 'init' };
    const gh = { calls: [], movedOnce: false, moveBeforeNextPatch: null, statuses: [], checks: [] };
    gh.head = () => head;
    gh.files = () => Object.fromEntries([...trees[commits[head].tree]].map(([p, s]) => [p, blobs[s]]));
    gh.blobSha = p => trees[commits[head].tree].get(p) || null;
    gh.commit = () => commits[head];
    gh.commitCount = () => Object.keys(commits).length;
    gh.fetch = async (url, opts) => {
        const u = new URL(url), p = u.pathname.replace('/repos/acme/site', ''), m = opts.method;
        const body = opts.body ? JSON.parse(opts.body) : null;
        gh.calls.push(`${m} ${p}`);
        assert.strictEqual(opts.headers.Authorization, 'Bearer test-token');
        const ok = d => ({ ok: true, status: 200, json: async () => d });
        let r;
        if (m === 'GET' && p === '/git/ref/heads/main') return ok({ object: { sha: head } });
        if (m === 'GET' && (r = p.match(/^\/git\/commits\/(\w+)$/))) return ok({ tree: { sha: commits[r[1]].tree } });
        if (m === 'GET' && (r = p.match(/^\/git\/trees\/(\w+)$/))) return ok({ tree: [...trees[r[1]]].map(([path, sha]) => ({ path, sha, type: 'blob' })) });
        if (m === 'GET' && (r = p.match(/^\/git\/blobs\/(\w+)$/))) return ok({ content: Buffer.from(blobs[r[1]]).toString('base64'), encoding: 'base64' });
        if (m === 'POST' && p === '/git/blobs') return ok({ sha: blob(Buffer.from(body.content, 'base64').toString('latin1')) });
        if (m === 'POST' && p === '/git/trees') {
            const next = new Map(trees[body.base_tree]);
            for (const e of body.tree) {
                if (e.sha === null) next.delete(e.path);
                else if (e.content !== undefined) next.set(e.path, blob(e.content));
                else { assert.ok(blobs[e.sha], 'tree refers to a blob that was never uploaded'); next.set(e.path, e.sha); }
            }
            return ok({ sha: tree(next) });
        }
        if (m === 'POST' && p === '/git/commits') { const sha = h('c' + Object.keys(commits).length + body.tree); commits[sha] = { tree: body.tree, parent: body.parents[0], message: body.message }; return ok({ sha }); }
        if (m === 'PATCH' && p === '/git/refs/heads/main') {
            if (gh.moveBeforeNextPatch) {   // someone else publishes between our read and our ref update
                const other = gh.moveBeforeNextPatch; gh.moveBeforeNextPatch = null;
                const t = new Map(trees[commits[head].tree]); t.set(other.path, blob(other.content));
                const sha = h('other' + Date.now()); commits[sha] = { tree: tree(t), parent: head, message: 'other' }; head = sha;
            }
            if (commits[body.sha].parent !== head) return { ok: false, status: 422, json: async () => ({ message: 'Update is not a fast forward' }) };
            head = body.sha; return ok({ object: { sha: head } });
        }
        if (m === 'GET' && /\/commits\/\w+\/status$/.test(p)) return ok({ statuses: gh.statuses });
        if (m === 'GET' && /\/commits\/\w+\/check-runs$/.test(p)) return ok({ check_runs: gh.checks });
        return { ok: false, status: 404, json: async () => ({ message: 'Not Found ' + m + ' ' + p }) };
    };
    return gh;
}

const goodWork = () => ({
    title: 'Riverside Café: Eid campaign', kind: 'campaign', category: 'Campaigns · Meta ads', status: 'Delivered',
    filters: ['Campaigns', 'Bangladesh', 'Mars'], summary: 'Two creatives tested.', tags: ['Meta ads'],
    cover: '/uploads/work/riverside-eid/cover-aaa111.jpg', results: [{ label: 'Cost per result', value: '৳43' }],
    services: ['ads', 'nope'], related: { ads: { title: 'Riverside Eid', text: 'Cost per result down 18%.' } }
});

let passed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n       ')); process.exitCode = 1; } }
const refuses = (fn, re) => assert.throws(fn, e => e.statusCode === 400 && re.test(e.message), 'expected a 400 matching ' + re);

(async () => {
    console.log('phase 66 :: what the website accepts');
    await test('a campaign is cleaned to the site\'s schema: unknown filters and services dropped, defaults filled', () => {
        const w = S.siteCleanWork(goodWork());
        assert.deepStrictEqual(w.filters, ['Campaigns', 'Bangladesh']);
        assert.deepStrictEqual(w.services, ['ads']);
        assert.strictEqual(w.order, 999); assert.strictEqual(w.published, true); assert.strictEqual(w.showCard, true);
        assert.ok(w.gradient.startsWith('linear-gradient'));
    });
    await test('the build-breaking mistakes are refused with a message', () => {
        refuses(() => S.siteCleanWork({ ...goodWork(), kind: 'poster' }), /Kind/);
        refuses(() => S.siteCleanWork({ ...goodWork(), cover: 'uploads/x.jpg' }), /image path/);
        refuses(() => S.siteCleanWork({ ...goodWork(), cover: '/uploads/../../x.jpg' }), /image path/);
        refuses(() => S.siteCleanWork({ ...goodWork(), results: Array(5).fill({ label: 'a', value: '1' }) }), /four/);
        refuses(() => S.siteCleanWork({ ...goodWork(), gradient: 'red;background:url(x)' }), /gradient/);
        refuses(() => S.siteCleanWork({ ...goodWork(), title: '  ' }), /Title/);
        refuses(() => S.siteCleanWork({ ...goodWork(), date: '23/10/2026' }), /date/);
    });
    await test('a live-site viewer needs a real domain and a screenshot for every screen', () => {
        const site = { name: 'Riverside', subtitle: 'Café site', host: 'https://riversidecafe.com.bd/menu', description: 'Menu and orders.', pages: [{ label: 'Home', path: '/', image: '/uploads/work/r/home.jpg' }] };
        const w = S.siteCleanWork({ ...goodWork(), site });
        assert.strictEqual(w.site.host, 'riversidecafe.com.bd');
        assert.strictEqual(w.site.key, 'riverside');
        refuses(() => S.siteCleanWork({ ...goodWork(), site: { ...site, pages: [{ label: 'Home' }] } }), /screenshot/);
        refuses(() => S.siteCleanWork({ ...goodWork(), site: { ...site, host: 'not a domain' } }), /domain/);
        refuses(() => S.siteCleanWork({ ...goodWork(), site: { ...site, color: 'red' } }), /hex/);
    });
    await test('a plan table needs one value per plan, and no blank cells', () => {
        const cur = { name: 'Ads', order: 2, accent: '#5b9bff', page: 'services/ads.html' };
        const svc = { pricing: { points: ['a'] }, plans: { columns: ['Starter', 'Growth'], popular: 1, rows: [{ label: 'Retargeting', values: [false, true] }] } };
        const out = S.siteCleanService(svc, cur);
        assert.strictEqual(out.name, 'Ads'); assert.strictEqual(out.pricing.price, null); assert.strictEqual(out.plans.popular, 1);
        assert.match(out.pricing.onRequest, /Price on request/);
        refuses(() => S.siteCleanService({ ...svc, plans: { ...svc.plans, rows: [{ label: 'X', values: [true] }] } }, cur), /1 values for 2 plans/);
        refuses(() => S.siteCleanService({ ...svc, plans: { ...svc.plans, rows: [{ label: 'X', values: [true, ''] }] } }, cur), /empty cell/);
        refuses(() => S.siteCleanService({ ...svc, plans: { ...svc.plans, popular: 4 } }, cur), /highlighted/);
    });
    await test('results figures: trend from a typed list, placeholder off unless ticked, date defaults to today', () => {
        const cur = { name: 'Ads', order: 2, accent: '#5b9bff', page: 'services/ads.html' };
        const out = S.siteCleanService({ pricing: { points: ['a'] }, plans: { columns: ['A'], rows: [{ label: 'r', values: ['x'] }] },
            results: { note: 'From our report.', metrics: [{ value: '৳43', change: '−18%', label: 'Cost per result', trend: '30, 24 18 12', lowerIsBetter: true }] } }, cur);
        assert.deepStrictEqual(out.results.metrics[0].trend, [30, 24, 18, 12]);
        assert.strictEqual(out.results.placeholder, false);
        assert.strictEqual(out.results.updated, new Date().toISOString().slice(0, 10));
        refuses(() => S.siteCleanService({ pricing: { points: ['a'] }, plans: { columns: ['A'], rows: [{ label: 'r', values: ['x'] }] }, results: { note: 'n', metrics: [{ value: '1', change: '+', label: 'l', trend: 'a b' }] } }, cur), /trend/);
    });
    await test('settings: three small numbers under the stat, and at least one Edge Meta AI question', () => {
        const s = { contact: { phone: '1', email: 'a@b.c', office: 'Barishal' }, ticker: ['x'], stat: { heading: 'Reach', value: 10, caption: 'c', series: '1 2 3', row: [{ value: 1, label: 'a' }, { value: 2, label: 'b' }, { value: 3, label: 'c' }] }, metaAi: { qa: [{ q: 'q?', a: 'a.', lang: 'bn', bars: [{ label: 'x', value: 140 }] }] } };
        const out = S.siteCleanSettings(s);
        assert.strictEqual(out.showPrices, false);
        assert.strictEqual(out.metaAi.qa[0].bars[0].value, 100);
        refuses(() => S.siteCleanSettings({ ...s, stat: { ...s.stat, row: s.stat.row.slice(0, 2) } }), /three/);
        refuses(() => S.siteCleanSettings({ ...s, metaAi: { qa: [] } }), /Edge Meta AI/);
    });
    await test('blog frontmatter round-trips, including quotes, colons and the seed files\' unquoted style', () => {
        const { fm, body } = S.siteCleanPost({ title: 'bKash: which "checkout" wins', date: '2026-10-02', excerpt: 'Short.', draft: false, body: 'Hello\n\n## Part' });
        const md = S.siteFrontmatter(fm, body);
        const back = S.siteParseFrontmatter(md);
        assert.strictEqual(back.fm.title, 'bKash: which "checkout" wins');
        assert.strictEqual(back.fm.draft, false);
        assert.strictEqual(back.body, 'Hello\n\n## Part');
        const seed = S.siteParseFrontmatter('---\ntitle: How our pricing works\ndate: 2026-10-20\ncover: /uploads/blog/x/c.jpg   # optional\n---\n\nBody');
        assert.strictEqual(seed.fm.title, 'How our pricing works'); assert.strictEqual(seed.fm.cover, '/uploads/blog/x/c.jpg');
        refuses(() => S.siteCleanPost({ title: 't', date: '2026-10-02', excerpt: 'e', body: '' }), /no text/);
    });
    await test('uploaded images get paths only this server makes', () => {
        const p = S.siteUploadPath('work', 'Riverside Eid!', 'My Cover.PNG', 'image/png');
        assert.match(p, /^public\/uploads\/work\/riverside-eid\/my-cover-[0-9a-f]{6}\.png$/);
        refuses(() => S.siteUploadPath('settings', 'x', 'a', 'image/png'), /work or blog/);
        refuses(() => S.siteUploadPath('work', 'x', 'a', 'image/gif'), /JPG, PNG or WebP/);
    });

    console.log('phase 66 :: one save, one commit');
    const seed = {
        'src/content/work/riverside-eid.json': '{"title":"old"}\n',
        'public/uploads/work/riverside-eid/old-111111.jpg': 'OLDJPG',
        'public/uploads/work/riverside-eid/keep-222222.jpg': 'KEEPJPG',
        'src/content/settings.json': '{}\n'
    };
    await test('a save commits the file and its new image together, and drops images the item stopped using', async () => {
        const gh = fakeGitHub(seed); S._siteFetch = gh.fetch;
        const img = await gh.fetch('https://api.github.com/repos/acme/site/git/blobs', { method: 'POST', headers: { Authorization: 'Bearer test-token' }, body: JSON.stringify({ content: Buffer.from('NEWJPG').toString('base64'), encoding: 'base64' }) }).then(r => r.json());
        const before = gh.commitCount();
        const out = await S.sitePublish({
            changes: { 'src/content/work/riverside-eid.json': { content: '{"title":"new"}\n' }, 'public/uploads/work/riverside-eid/cover-333333.jpg': { blob: img.sha } },
            expect: { 'src/content/work/riverside-eid.json': gh.blobSha('src/content/work/riverside-eid.json') },
            removePrefix: 'public/uploads/work/riverside-eid/',
            keep: ['public/uploads/work/riverside-eid/cover-333333.jpg', 'public/uploads/work/riverside-eid/keep-222222.jpg'],
            message: 'content: update work'
        });
        assert.strictEqual(gh.commitCount(), before + 1, 'exactly one commit');
        assert.strictEqual(out.sha, gh.head());
        const f = gh.files();
        assert.strictEqual(f['src/content/work/riverside-eid.json'], '{"title":"new"}\n');
        assert.strictEqual(f['public/uploads/work/riverside-eid/cover-333333.jpg'], 'NEWJPG');
        assert.strictEqual(f['public/uploads/work/riverside-eid/keep-222222.jpg'], 'KEEPJPG');
        assert.ok(!('public/uploads/work/riverside-eid/old-111111.jpg' in f), 'the unused image is removed');
        assert.strictEqual(f['src/content/settings.json'], '{}\n', 'other files untouched');
    });
    await test('a save made from an out-of-date copy is refused, and nothing is committed', async () => {
        const gh = fakeGitHub(seed); S._siteFetch = gh.fetch;
        const before = gh.head();
        await assert.rejects(S.sitePublish({ changes: { 'src/content/work/riverside-eid.json': { content: 'x' } }, expect: { 'src/content/work/riverside-eid.json': 'f'.repeat(40) }, message: 'm' }),
            e => e.statusCode === 409 && e.code === 'site_conflict');
        assert.strictEqual(gh.head(), before);
    });
    await test('adding a new item whose name is already taken is refused instead of overwriting it', async () => {
        const gh = fakeGitHub(seed); S._siteFetch = gh.fetch;
        await assert.rejects(S.sitePublish({ changes: { 'src/content/work/riverside-eid.json': { content: 'x' } }, expect: { 'src/content/work/riverside-eid.json': null }, message: 'm' }), e => e.statusCode === 409);
    });
    await test('when someone else publishes mid-save, it rebuilds on their commit and keeps both changes', async () => {
        const gh = fakeGitHub(seed); S._siteFetch = gh.fetch;
        gh.moveBeforeNextPatch = { path: 'src/content/blog/theirs.md', content: 'THEIRS' };
        await S.sitePublish({ changes: { 'src/content/settings.json': { content: '{"a":1}\n' } }, expect: {}, message: 'm' });
        const f = gh.files();
        assert.strictEqual(f['src/content/settings.json'], '{"a":1}\n');
        assert.strictEqual(f['src/content/blog/theirs.md'], 'THEIRS');
    });
    await test('saving with nothing changed makes no commit', async () => {
        const gh = fakeGitHub(seed); S._siteFetch = gh.fetch;
        const before = gh.commitCount();
        const out = await S.sitePublish({ changes: { 'src/content/settings.json': { content: '{}\n' } }, expect: {}, message: 'm' });
        assert.strictEqual(out.unchanged, true); assert.strictEqual(gh.commitCount(), before);
    });
    await test('with no token set, it says how to set it up rather than calling GitHub', async () => {
        const t = process.env.SITE_REPO_TOKEN; delete process.env.SITE_REPO_TOKEN;
        try { await assert.rejects(S.sitePublish({ changes: {}, message: 'm' }), e => e.statusCode === 503 && e.code === 'site_not_configured'); }
        finally { process.env.SITE_REPO_TOKEN = t; }
    });

    console.log('phase 66 :: did it go live');
    await test('the build state reads Netlify\'s report on the commit, whichever way it reports', async () => {
        const gh = fakeGitHub(seed); S._siteFetch = gh.fetch;
        assert.strictEqual((await S.siteBuildState(gh.head())).state, 'unknown');
        gh.statuses = [{ context: 'netlify/edgelead/deploy', state: 'pending', target_url: 'https://app.netlify.com/x' }];
        assert.strictEqual((await S.siteBuildState(gh.head())).state, 'pending');
        gh.statuses = [{ context: 'netlify', state: 'success' }]; gh.checks = [{ name: 'netlify', status: 'completed', conclusion: 'failure' }];
        assert.strictEqual((await S.siteBuildState(gh.head())).state, 'failure');
        gh.checks = [{ name: 'netlify', status: 'completed', conclusion: 'success' }];
        assert.strictEqual((await S.siteBuildState(gh.head())).state, 'success');
    });

    console.log(`\n${passed} passed`);
})();
