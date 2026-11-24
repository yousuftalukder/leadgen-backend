#!/usr/bin/env node
/**
 * WIRING AUDIT — does every tool in this product actually join up?
 *
 * The phase tests check logic. This checks the seams between the three layers
 * the repo rule names: SQL, server, pages. Those seams are where this codebase
 * breaks, and they break silently:
 *
 *   - a page calling an endpoint that was renamed        -> button does nothing
 *   - a worker registered with no route to start it      -> dead engine
 *   - a route starting a worker that does not exist      -> 500 on click
 *   - a report_type the pages cannot label or open       -> blank row
 *   - a page that forgot app.css or header.js            -> unstyled, no auth
 *
 * None of those show up in a unit test and none of them throw at startup.
 *
 * This reads source rather than running the server, so it needs no network,
 * no database and no Apify key. It is deliberately conservative: where a
 * pattern cannot be resolved statically it is reported as SKIPPED rather than
 * guessed at, because a false alarm here costs more than a miss.
 *
 *   node tests/wiring.test.js
 */
'use strict';
// Phase 87: these tests exercise the social media tools, which are switched off by default.
process.env.TOOLS_ENABLED = 'all';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// Phase 31: the Owner Assistant's routes are registered from xp/index.js, so its
// source is part of "the server" for every check that reads route registrations.
// Phase 55: the server is server.js plus its parts in src/, read in load order.
const SERVER = [path.join(ROOT, 'server.js'), ...fs.readdirSync(path.join(ROOT, 'src')).filter(f => f.endsWith('.js')).sort().map(f => path.join(ROOT, 'src', f)), path.join(ROOT, 'xp', 'index.js')]
    .map(f => fs.readFileSync(f, 'utf8')).join('\n');
const FRONT_DIR = path.join(ROOT, 'frontend');
// Phase 89: two apps (the CRM at /, the Tools at /tools), the Phone and the legal pages. Pages and scripts
// are read from every folder of frontend/ except the vendored library; the service workers fetch no API.
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? (e.name === 'vendor' ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]);
const FILES = walk(FRONT_DIR).map(f => path.relative(FRONT_DIR, f).split(path.sep).join('/'));
const PAGES = FILES.filter(f => f.endsWith('.html'));
const SCRIPTS = FILES.filter(f => f.endsWith('.js') && !/(^|\/)(sw|phone-sw)\.js$/.test(f));
const HEADER = '';
let pass = 0, fail = 0, skip = 0;
const problems = [];
function ok(msg)   { pass++; console.log('  ok   ' + msg); }
function bad(msg, detail) {
    fail++; problems.push(msg);
    console.log('  FAIL ' + msg + (detail ? '\n       ' + String(detail).split('\n').join('\n       ') : ''));
}
function skipped(msg) { skip++; console.log('  skip ' + msg); }
function check(msg, list) { if (!list || !list.length) ok(msg); else bad(msg, list.join('\n')); }

// ---------------------------------------------------------------------------
// 1. ROUTES THE SERVER ACTUALLY REGISTERS
// ---------------------------------------------------------------------------
/** Every app.<verb>('<path>' ...) in server.js. */
function serverRoutes() {
    const out = [];
    const re = /\bapp\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2/g;
    let m;
    while ((m = re.exec(SERVER))) out.push({ method: m[1].toUpperCase(), path: m[3] });
    return out;
}
const ROUTES = serverRoutes();

/** Express ':param' -> a regex that matches a concrete call. */
function routeMatcher(p) {
    const src = '^' + p
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '[^/?#]+')
        + '$';
    return new RegExp(src);
}
const MATCHERS = ROUTES.map(r => ({ ...r, re: routeMatcher(r.path) }));

console.log(`\nserver surface — ${ROUTES.length} routes registered`);
check('no route path is registered twice for the same method', (() => {
    const seen = new Map(), dupes = [];
    for (const r of ROUTES) {
        const k = r.method + ' ' + r.path;
        // Express takes the FIRST match, so a duplicate is dead code at best
        // and a silently shadowed handler at worst.
        if (seen.has(k)) dupes.push(k); else seen.set(k, true);
    }
    return dupes;
})());

// ---------------------------------------------------------------------------
// 2. EVERY ENDPOINT THE PAGES CALL MUST EXIST
// ---------------------------------------------------------------------------
/**
 * Read the full argument text of a call, from its opening paren to the
 * matching close, respecting nesting and string literals.
 *
 * A regex cannot do this, and the version of this check that tried produced
 * seventeen false alarms in one run: `{ method: 'POST', body: { ... } }` has a
 * nested brace, and `[^}]*?` stops at the first one. An audit that cries wolf
 * is worse than no audit, so the args are actually parsed.
 */
function argsOf(src, openParenIdx) {
    let depth = 0, quote = null, i = openParenIdx;
    for (; i < src.length; i++) {
        const c = src[i], prev = src[i - 1];
        if (quote) {
            if (c === quote && prev !== '\\') quote = null;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') { depth--; if (!depth) return src.slice(openParenIdx + 1, i); }
    }
    return null;
}

/** Split argument text on TOP-LEVEL commas only. */
function splitArgs(text) {
    const out = []; let depth = 0, quote = null, start = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i], prev = text[i - 1];
        if (quote) { if (c === quote && prev !== '\\') quote = null; continue; }
        if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
        if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) depth--;
        else if (c === ',' && !depth) { out.push(text.slice(start, i)); start = i + 1; }
    }
    out.push(text.slice(start));
    return out.map(s => s.trim());
}

/**
 * Turn a path EXPRESSION into a concrete path, with 'X' standing in for any
 * value computed at runtime. Handles the three forms the pages use:
 *
 *   '/api/clients'                     -> /api/clients
 *   `/api/clients/${id}/members`       -> /api/clients/X/members
 *   '/api/report/' + encodeURI(id)     -> /api/report/X
 */
function resolvePathExpr(expr) {
    const parts = [];
    const operands = splitOnPlus(expr.trim());
    if (!operands) return null;
    for (const op of operands) {
        const t = op.trim();
        let m;
        if ((m = /^'([^']*)'$/.exec(t)) || (m = /^"([^"]*)"$/.exec(t))) parts.push({ lit: m[1] });
        else if ((m = /^`([^`]*)`$/.exec(t))) parts.push({ lit: m[1].replace(/\$\{[^}]*\}/g, 'X') });
        else parts.push({ runtime: true });
    }

    const joined = parts.map(p => (p.lit !== undefined ? p.lit : 'X')).join('');
    if (!joined.startsWith('/api')) return null;

    // A runtime value appended to a path that does NOT end in '/' is ambiguous:
    //   '/api/report/' + id        -> a path segment
    //   '/api/clients' + '?a=1'    -> a query string
    // Nothing in the source says which, so BOTH readings are offered and the
    // call passes if either names a real route. Guessing one way produced
    // false alarms; guessing the other would hide dead endpoints only when the
    // very same path also exists without the segment, which is harmless.
    const candidates = new Set();
    candidates.add(joined.split('?')[0]);

    const last = parts[parts.length - 1];
    const before = parts.slice(0, -1).map(p => (p.lit !== undefined ? p.lit : 'X')).join('');
    if (last && last.runtime && before && !before.endsWith('/')) {
        candidates.add(before.split('?')[0]);       // the query-string reading
    }
    return [...candidates].filter(p => p.startsWith('/api')).map(p => p.replace(/(.)\/+$/, '$1'));
}

/** Split an expression on top-level '+' operators. */
function splitOnPlus(text) {
    const out = []; let depth = 0, quote = null, start = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i], prev = text[i - 1];
        if (quote) { if (c === quote && prev !== '\\') quote = null; continue; }
        if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
        if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) depth--;
        else if (c === '+' && !depth) { out.push(text.slice(start, i)); start = i + 1; }
    }
    out.push(text.slice(start));
    return out;
}

/** Every API call a page makes, with its real HTTP method. */
function pageCalls(src) {
    const calls = [];
    const re = /(?:\bEL\.|\bH\.|[^.\w])(api|runJob|start)\s*\(/g;   // phase 89: api(), H.api() and the Tools' start() too
    let m;
    while ((m = re.exec(src))) {
        const open = m.index + m[0].length - 1;
        const args = argsOf(src, open);
        if (args === null) continue;
        const parts = splitArgs(args);
        const paths = resolvePathExpr(parts[0] || '');
        if (paths === null || !paths.length) { calls.push({ raw: parts[0], unresolved: true }); continue; }

        // runJob POSTs, always — it starts a job. Treating it as GET is what
        // produced most of the earlier false alarms.
        let method = m[1] === 'runJob' || m[1] === 'start' ? 'POST' : 'GET';
        if (m[1] === 'api' && parts[1]) {
            const mm = /(?:^|[{,\s])method\s*:\s*['"](\w+)['"]/.exec(parts[1]);
            if (mm) method = mm[1].toUpperCase();
        }
        calls.push({ raw: parts[0], paths, method });
    }
    // Hand-rolled fetch to the backend origin (the SSE stream does this).
    const re2 = /EL\.backendUrl\(\)\s*\+\s*(['"`])([^'"`]+)\1/g;
    while ((m = re2.exec(src))) {
        const p = String(m[2]).split('?')[0];
        if (p.startsWith('/api')) calls.push({ raw: m[2], paths: [p], method: 'ANY' });
    }
    return calls;
}

console.log('\npage → server: every endpoint a page calls must exist');
{
    const missing = [], unresolved = [];
    const sources = [...PAGES, ...SCRIPTS].map(f => [f, fs.readFileSync(path.join(FRONT_DIR, f), 'utf8')]);

    let checked = 0;
    for (const [file, src] of sources) {
        for (const call of pageCalls(src)) {
            if (call.unresolved) { unresolved.push(`${file}: ${call.raw}`); continue; }
            checked++;
            const hit = call.paths.some(p => MATCHERS.some(r =>
                (call.method === 'ANY' || r.method === call.method) && r.re.test(p)));
            if (!hit) missing.push(`${file}: ${call.method} ${call.paths.join(' | ')}  (from ${call.raw})`);
        }
    }
    if (!checked) bad('the endpoint scan found calls to check', 'nothing matched — this check has gone stale');
    check('no page calls an endpoint the server does not register', missing);
    ok(`${checked} endpoint call sites resolved and matched`);
    if (unresolved.length) skipped(`${unresolved.length} computed endpoint(s) not statically checkable`);
}

// ---------------------------------------------------------------------------
// 3. WORKERS AND THE ROUTES THAT START THEM
// ---------------------------------------------------------------------------
console.log('\njob engine: every worker reachable, every reference real');
{
    const registered = [...SERVER.matchAll(/registerWorker\(\s*(['"`])([\w]+)\1/g)].map(m => m[2]);
    const invoked = [...SERVER.matchAll(/JOB_WORKERS\[\s*(['"`])([\w]+)\1\s*\]/g)].map(m => m[2]);
    const created = [...SERVER.matchAll(/createJob\(\s*[^,]+,\s*(['"`])([\w]+)\1/g)].map(m => m[2]);

    check('every registered worker has a route that starts it',
        [...new Set(registered)].filter(w => !invoked.includes(w))
            .map(w => `registerWorker('${w}') is never started — dead engine`));

    check('every JOB_WORKERS[...] reference points at a registered worker',
        [...new Set(invoked)].filter(w => !registered.includes(w))
            .map(w => `JOB_WORKERS['${w}'] would be undefined — 500 on click`));

    check('every createJob type has a worker',
        [...new Set(created)].filter(w => !registered.includes(w))
            .map(w => `createJob(..., '${w}') has no registerWorker('${w}')`));

    ok(`${new Set(registered).size} workers registered, all wired`);
}

// ---------------------------------------------------------------------------
// 4. REPORT TYPES THE PAGES MUST BE ABLE TO SHOW
// ---------------------------------------------------------------------------
console.log('\nreport types: everything written must be labelable and openable');
{
    // report_type: 'x'  — what the server actually writes into reports.
    const written = [...new Set(
        [...SERVER.matchAll(/report_type:\s*(['"`])([\w]+)\1/g)].map(m => m[2])
    )].sort();

    {
        // The client surface has its own naming, in owner language. It was
        // keyed by JOB type for two entries (fb_page_report, fb_community_audit)
        // that no row has ever carried, so a client's Facebook report read as
        // "Report". Same check, other side of the product.
        const titles = (/const CLIENT_REPORT_TITLES\s*=\s*\{([^}]*)\}/.exec(SERVER) || [])[1];
        if (!titles) {
            bad('the client-surface TITLES map is findable', 'the pattern matched nothing — this check has gone stale');
        } else {
            const keys = [...titles.matchAll(/^\s*(\w+):/gm)].map(m => m[1]);
            check('every report_type the server writes has an owner-language title on the client surface',
                written.filter(t => !keys.includes(t)).map(t => `report_type '${t}' would show a client "Report" with no name`));
            check('no client title is keyed by something the server never writes',
                keys.filter(k => !written.includes(k)).map(k => `TITLES['${k}'] can never match a row — is it a job type?`));
        }
        ok(`${written.length} report types written: ${written.join(', ')}`);
    }
    // Phase 89: the Tools open the three Apify report kinds; every one must have a route that serves it.
    const tools = fs.readFileSync(path.join(FRONT_DIR, 'app', 'tools.js'), 'utf8');
    check('the Tools open every Apify report kind they list', ['ig', 'fbpage', 'fbgroups'].filter(k => !new RegExp(`${k}: '/api/[\\w/-]+/'`).test(tools)).map(k => `no report route for ${k}`));
}

// ---------------------------------------------------------------------------
// 5. EVERY PAGE IS A REAL PAGE
// ---------------------------------------------------------------------------
console.log('\npages: shell, styles and auth on every one');
{
    // Legal pages Meta's review links to: no app, no session, still must parse.
    const STATIC = new Set(['privacy.html', 'terms.html', 'data-deletion.html']);
    // The apps: each loads the shared design system, the supabase client and its own script, and sends
    // anyone without a session to the sign-in (the CRM shows it; the Tools send people to /).
    const APPS = { 'index.html': 'app.js', 'phone.html': 'app.js', 'tools/index.html': 'tools.js' };
    const bad_ = [], badParse = [];
    for (const f of PAGES) {
        const src = fs.readFileSync(path.join(FRONT_DIR, f), 'utf8');
        for (const m of src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) { try { new Function(m[1]); } catch (e) { badParse.push(`${f}: ${e.message}`); } }
        if (STATIC.has(f)) { if (!/app\/legal\.css/.test(src)) bad_.push(`${f} has no stylesheet`); continue; }
        const js = APPS[f];
        if (!js) { bad_.push(`${f} is a page nobody planned: add it to APPS or STATIC`); continue; }
        if (!/href=["']\/?app\/app\.css["']/.test(src)) bad_.push(`${f} does not load app/app.css`);
        if (!new RegExp(`src=["']/?app/${js.replace('.', '\\.')}["']`).test(src)) bad_.push(`${f} does not load app/${js}`);
        if (!/supabase-js/.test(src)) bad_.push(`${f} does not load the supabase client`);
        const code = fs.readFileSync(path.join(FRONT_DIR, 'app', js), 'utf8');
        if (!/if \(!data\.session\) return signIn\(\)|if \(!data\.session\) \{ location\.replace\('\/'\)/.test(code)) bad_.push(`app/${js} lets someone without a session in`);
    }
    check('every page is one of the apps or a legal page, with its styles, script and sign-in', bad_);
    check('every inline script parses', badParse);
    for (const f of SCRIPTS) { try { new (require('vm').Script)(fs.readFileSync(path.join(FRONT_DIR, f), 'utf8')); } catch (e) { badParse.push(`${f}: ${e.message}`); } }
    check('every script parses', badParse);
    ok(`${PAGES.length} pages checked`);
}

// ---------------------------------------------------------------------------
// 6. NAVIGATION POINTS AT PAGES THAT EXIST
// ---------------------------------------------------------------------------
console.log('\nnavigation: every destination exists, every page is reachable');
{
    // Every root-relative page the apps link to must exist (or be a rewrite Netlify serves).
    const all = [...PAGES, ...SCRIPTS].map(f => fs.readFileSync(path.join(FRONT_DIR, f), 'utf8')).join('\n');
    const toml = fs.readFileSync(path.join(FRONT_DIR, 'netlify.toml'), 'utf8');
    const served = new Set(['/', ...PAGES.map(f => '/' + f), ...[...toml.matchAll(/from = "(\/[\w./-]*)"\s+to = "[^"]+"\s+status = 200/g)].map(m => m[1])]);
    const links = [...new Set([...all.matchAll(/href=["'`](\/[\w./-]*)(?:#[^"'`]*)?["'`]/g)].map(m => m[1]))].filter(h => !/\.(css|png|js|webmanifest)$/.test(h));
    check('every page the apps link to is served', links.filter(h => !served.has(h)).map(h => `a link to ${h}, which nothing serves`));
    check('nothing links to the old pages or to crm.html', [...all.matchAll(/["'`(](?:\/)?(crm|leads|admin|workspace|ig-report|fb-report|client|clients|welcome)\.html/g)].map(m => `a link to ${m[1]}.html`));
    ok(`${links.length} links checked`);
}

// ---------------------------------------------------------------------------
// 7. THE SOURCE RULE — scraped and owner numbers never blended
// ---------------------------------------------------------------------------
console.log('\nthe source rule: owner and scraped data stay apart');
{
    // Every report the server writes must declare where its numbers came from.
    // This is the repo's hardest rule and the easiest to drop when adding an
    // engine, because nothing fails if you forget.
    const insertBlocks = [...SERVER.matchAll(/from\('reports'\)\s*\.insert\(\[\{([\s\S]{0,2600}?)\}\]\)/g)]
        .map(m => m[1]);
    const typed = insertBlocks.map(b => (b.match(/report_type:\s*['"`]([\w]+)['"`]/) || [])[1]).filter(Boolean);

    if (!insertBlocks.length) {
        bad('report inserts are findable in server.js', 'the pattern matched nothing — this check has gone stale');
    } else {
        ok(`${insertBlocks.length} report insert sites found (${[...new Set(typed)].join(', ')})`);
    }

    // meta_* engines must never carry a scraped source label and vice versa.
    const metaBlocks = insertBlocks.filter(b => /platform:\s*['"`]meta['"`]/.test(b));
    check('every meta report declares itself as owner insights', metaBlocks
        .filter(b => !/source/i.test(b) && !/report_json/.test(b))
        .map(() => 'a meta report was written with no source declared'));
}

// ---------------------------------------------------------------------------
// 8. EVERY ENGINE MUST BE GRANTABLE
//
// This check exists because the bug it catches shipped: the admin panel kept
// its own hardcoded list of four engine checkboxes while the server had six,
// so meta_owned and content_plan could not be granted to anyone. An admin
// ticked every box on the screen, the employee was still refused by
// requireEngine, and neither screen explained why.
//
// An engine the server enforces but nobody can grant is a permanently locked
// door. The fix was to send the list from the server; this makes sure no page
// starts keeping its own copy again.
// ---------------------------------------------------------------------------
console.log('\nengines: everything the server gates must be grantable');
{
    const m = /^const ENGINES\s*=\s*\[([^\]]*)\]/m.exec(SERVER);
    const engines = m ? [...m[1].matchAll(/'([\w]+)'/g)].map(x => x[1]) : [];
    if (!engines.length) {
        bad('the server ENGINES list is findable', 'the pattern matched nothing — this check has gone stale');
    } else {
        // Phase 89: the owner gives the Apify engines through Admin → Tools (TOOL_AREA). Every Apify engine
        // requireEngine checks on a tool route must be in a tool, or nobody can be given it.
        const area = (/const TOOL_AREA = \[([\s\S]*?)\n\];/.exec(SERVER) || [])[1] || '';
        const given = [...area.matchAll(/engines: \[([^\]]*)\]/g)].flatMap(m => [...m[1].matchAll(/'(\w+)'/g)].map(x => x[1]));
        const apify = (/const APIFY_ENGINES = \[([^\]]*)\]/.exec(SERVER) || [])[1];
        const need = apify ? [...apify.matchAll(/'(\w+)'/g)].map(x => x[1]) : [];
        check('every Apify engine can be given in Admin → Tools', need.length ? need.filter(e => !given.includes(e)).map(e => `engine '${e}' is in no tool, so nobody can be given it`) : ['APIFY_ENGINES could not be found']);
        const app = fs.readFileSync(path.join(FRONT_DIR, 'app', 'app.js'), 'utf8');
        check('Admin renders the tools and saves access through the server', /\/api\/admin\/tools\/access/.test(app) && /a\.tools\.map/.test(app) ? [] : ['app.js no longer renders Admin → Tools from the server']);
        ok(`${engines.length} engines; Apify engines given through Tools: ${need.join(', ')}`);
    }

    // Whatever the trial hands out must be a real engine, or a trial account
    // holds a grant that gates nothing.
    const t = /^const TRIAL_ENGINES\s*=\s*\(process\.env\.TRIAL_ENGINES\s*\|\|\s*'([^']*)'/m.exec(SERVER);
    if (t) {
        const trial = t[1].split(',').map(x => x.trim()).filter(Boolean);
        check('every default trial engine is a real engine',
            trial.filter(e => !engines.includes(e))
                .map(e => `TRIAL_ENGINES contains '${e}', which is not in ENGINES`));
    }
}

// ---------------------------------------------------------------------------
// 9. CAPABILITY REACHABILITY
//
// The checks above are code-to-code: does a page call a route that exists,
// does a worker have a route. That is not the same question as "can a human
// reach this", and the difference is where the real bugs were:
//
//   - two engines enforced by requireEngine with no checkbox anywhere
//   - three quota settings enforced on every run, changeable only by SQL
//   - a role the server assigns that the create form could not offer
//
// Every one of those was internally consistent. Nothing was broken; something
// was simply unreachable. That is the class this section covers.
// ---------------------------------------------------------------------------
console.log('\nreachability: every admin endpoint has a control or is written down');
{
    const app = fs.readFileSync(path.join(FRONT_DIR, 'app', 'app.js'), 'utf8');
    const adminRoutes = [...new Set([...SERVER.matchAll(/app\.\w+\(\s*'(\/api\/admin\/[\w/:-]+)'/g)].map(m => m[1]))];
    const docs = fs.readdirSync(path.join(ROOT, 'docs')).map(f => fs.readFileSync(path.join(ROOT, 'docs', f), 'utf8')).join('\n');
    const readme = fs.existsSync(path.join(ROOT, 'README.md')) ? fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8') : '';
    const unreachable = adminRoutes.filter(r => { const tail = r.replace(/\/api\/admin\//, '').split('/')[0]; return !app.includes('/api/admin/' + tail) && !docs.includes(tail) && !readme.includes(tail); });
    check('every admin endpoint has a control in the CRM or is documented as ops-only', unreachable.map(r => `${r} has no control and is not documented`));
    ok(`${adminRoutes.length} admin endpoints, all reachable or documented`);
}

// ---------------------------------------------------------------------------
// 10. THE WORK-FOR BAR IS ON EVERY PAGE THAT STARTS WORK
//
// header.js keeps one explicit list of the pages that carry the "filing
// under" bar. A page that starts jobs but is missing from it lets work be
// launched with the question unasked — which is exactly how 15 of 16 reports
// ended up filed under nothing. Same discipline as the engine list: one list,
// and this makes sure it matches the code.
// ---------------------------------------------------------------------------
console.log('\nwork pages: every run the Tools start is filed under a client');
{
    const tools = fs.readFileSync(path.join(FRONT_DIR, 'app', 'tools.js'), 'utf8');
    const startFn = tools.slice(tools.indexOf('async function start('), tools.indexOf('\n}', tools.indexOf('async function start(')));
    check('start() refuses without a client and sends clientId with every run', /if \(!st\.client\)/.test(startFn) && /clientId: st\.client/.test(startFn) ? [] : ['start() can launch a run with no client']);
    const direct = [...tools.matchAll(/api\(\s*'(\/api\/(?:run-campaign|generate-ig-report|fb\/page-report|fb\/audit-community|fb\/find-leads|enrich-campaign))'\s*,\s*\{\s*method:\s*'POST'/g)].map(m => m[1]);
    check('no run is started around start()', direct.map(p => `${p} is POSTed directly, without the client check`));
}

// ---------------------------------------------------------------------------
// 11. TEST RUNNER HYGIENE
// ---------------------------------------------------------------------------
console.log('\ntest runner: every test file actually runs');
{
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const script = pkg.scripts?.test || '';
    const files = fs.readdirSync(__dirname).filter(f => /\.(test|smoke)\.js$/.test(f));

    // Two legitimate shapes: the script names every file, or it delegates to a
    // runner that discovers them. Only the first has to be audited file by
    // file — a runner that reads this directory cannot fall behind it.
    const runnerRef = /node\s+(\S*run-tests\.js)/.exec(script);
    let discovers = false;
    if (runnerRef) {
        const runnerPath = path.join(ROOT, runnerRef[1]);
        if (fs.existsSync(runnerPath)) {
            const runner = fs.readFileSync(runnerPath, 'utf8');
            discovers = /readdirSync\(/.test(runner) && /\.(?:test|smoke)\b/.test(runner);
        } else {
            bad('the test runner named by npm test exists', `${runnerRef[1]} is missing`);
        }
    }

    if (discovers) {
        ok(`npm test delegates to a runner that discovers all ${files.length} test files`);
    } else {
        check('npm test runs every test file', files.filter(f => !script.includes(f))
            .map(f => `tests/${f} is never run by npm test`));
        // && short-circuits: one failure hides every later file, and the pass
        // count printed is then a lie. This bit us once already.
        check('npm test does not &&-chain (one failure would hide the rest)',
            /&&/.test(script) ? ['"test" uses && — a failure in an early file silently skips the others'] : []);
    }
}

// ---------------------------------------------------------------------------
console.log('\n' + '─'.repeat(64));
console.log(`${pass} checks passed, ${fail} failed, ${skip} skipped`);
if (fail) {
    console.log('\nWhat to fix:');
    problems.forEach(p => console.log('  • ' + p));
    process.exitCode = 1;
}
