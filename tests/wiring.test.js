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
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const FRONT_DIR = path.join(ROOT, 'frontend');
const PAGES = fs.readdirSync(FRONT_DIR).filter(f => f.endsWith('.html'));
const HEADER = fs.readFileSync(path.join(FRONT_DIR, 'header.js'), 'utf8');

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
    const re = /EL\.(api|runJob)\s*\(/g;
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
        let method = m[1] === 'runJob' ? 'POST' : 'GET';
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
    const sources = [...PAGES.map(f => [f, fs.readFileSync(path.join(FRONT_DIR, f), 'utf8')]), ['header.js', HEADER]];

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

    const clientsSrc = fs.readFileSync(path.join(FRONT_DIR, 'clients.html'), 'utf8');
    const labelBlock = (clientsSrc.match(/TYPE_LABEL\s*=\s*\{[^}]*\}/) || [''])[0];
    const pageBlock  = (clientsSrc.match(/TYPE_PAGE\s*=\s*\{[^}]*\}/) || [''])[0];

    if (!labelBlock || !pageBlock) {
        bad('clients.html still declares TYPE_LABEL and TYPE_PAGE', 'one of the maps could not be found');
    } else {
        // A timeline row with no label renders as "undefined"; with no page it
        // links to '#'. Both are silent.
        const unlabelled = written.filter(t => !new RegExp(`\\b${t}\\b`).test(labelBlock));
        const unopenable = written.filter(t => !new RegExp(`\\b${t}\\b`).test(pageBlock));
        check('every report_type the server writes has a label in the timeline', unlabelled
            .map(t => `report_type '${t}' would render as "undefined" in the client timeline`));
        check('every report_type the server writes has a page to open it', unopenable
            .map(t => `report_type '${t}' would link to '#'`));
        ok(`${written.length} report types written: ${written.join(', ')}`);
    }
}

// ---------------------------------------------------------------------------
// 5. EVERY PAGE IS A REAL PAGE
// ---------------------------------------------------------------------------
console.log('\npages: shell, styles and auth on every one');
{
    // share.html is the read-only public view: no session, so no auth boot.
    const PUBLIC = new Set(['share.html']);
    // Legal and policy pages Meta's review links to. They deliberately carry
    // no app shell — no header.js, no session, nothing to be signed in to —
    // so a person can read them without an account. They still must parse
    // and still must be reachable.
    const STATIC = new Set(['privacy.html', 'terms.html', 'data-deletion.html']);
    const noCss = [], noHeader = [], noSupabase = [], noInit = [], badParse = [];

    for (const f of PAGES) {
        const src = fs.readFileSync(path.join(FRONT_DIR, f), 'utf8');
        if (!/<link[^>]+href=["']app\.css["']/.test(src)) noCss.push(f);
        if (!STATIC.has(f) && !/<script[^>]+src=["']header\.js["']/.test(src)) noHeader.push(f);
        if (!STATIC.has(f) && !/supabase-js/.test(src)) noSupabase.push(f);
        if (!PUBLIC.has(f) && !STATIC.has(f) && !/EL\.(init|initShared|loadShared)/.test(src)) noInit.push(f);
        for (const m of src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
            try { new Function(m[1]); } catch (e) { badParse.push(`${f}: ${e.message}`); }
        }
    }
    check('every page loads the shared stylesheet', noCss);
    check('every page loads header.js', noHeader);
    check('every page loads the supabase client', noSupabase);
    check('every non-public page boots through EL.init', noInit);
    check('every inline script parses', badParse);
    ok(`${PAGES.length} pages checked`);
}

// ---------------------------------------------------------------------------
// 6. NAVIGATION POINTS AT PAGES THAT EXIST
// ---------------------------------------------------------------------------
console.log('\nnavigation: every destination exists, every page is reachable');
{
    const navHrefs = [...HEADER.matchAll(/href:\s*(['"`])([\w.-]+\.html)\1/g)].map(m => m[2]);
    const missing = [...new Set(navHrefs)].filter(h => !PAGES.includes(h));
    check('every nav entry points at a page that exists', missing
        .map(h => `nav links to ${h}, which is not in frontend/`));

    // Pages reachable some other way (a link, a redirect, a share URL) are
    // fine; pages reachable NO way are the problem.
    const allSrc = PAGES.map(f => fs.readFileSync(path.join(FRONT_DIR, f), 'utf8')).join('\n') + HEADER;
    const orphans = PAGES.filter(f =>
        f !== 'index.html' &&
        !navHrefs.includes(f) &&
        !new RegExp(`['"\`(/]${f.replace('.', '\\.')}`).test(allSrc));
    check('no page is unreachable from anywhere', orphans
        .map(f => `${f} is not linked from the nav or any page`));
    ok(`${new Set(navHrefs).size} nav destinations, all present`);
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
    const admin = fs.readFileSync(path.join(FRONT_DIR, 'admin.html'), 'utf8');

    if (!engines.length) {
        bad('the server ENGINES list is findable', 'the pattern matched nothing — this check has gone stale');
    } else {
        // Two shapes are acceptable: the page renders from a server-sent list,
        // or it names every engine itself. Only the second needs auditing.
        const derived = /allEngines/.test(admin);
        if (derived) {
            check('the admin panel renders engines from the server list',
                /const ENGINES\s*=|data-eng="(leadgen|report|fb_community|fb_page)"/.test(admin)
                    ? ['admin.html still has a hardcoded engine name alongside the server-sent list']
                    : []);
            // The server must actually send it, or the page renders nothing.
            check('the server sends allEngines to the admin panel',
                /allEngines:\s*ENGINES/.test(SERVER) ? [] : ['/api/admin/users does not send allEngines']);
            ok(`${engines.length} engines, all grantable: ${engines.join(', ')}`);
        } else {
            check('every engine the server gates is offered in the admin panel',
                engines.filter(e => !new RegExp(`["'\`]${e}["'\`]`).test(admin))
                    .map(e => `engine '${e}' is enforced by requireEngine but has no checkbox — it can never be granted`));
        }
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
console.log('\nreachability: everything the server enforces must be reachable by a human');
{
    const admin = fs.readFileSync(path.join(FRONT_DIR, 'admin.html'), 'utf8');

    // --- roles ----------------------------------------------------------
    // ACCOUNT roles only: the ones the auth gate branches on. A looser pattern
    // also catches 'viewer' (a client_members role), and 'target'/'rival'
    // (report comparison labels) — none of which belong on app_users, so
    // demanding an admin control for them is noise.
    // The deny-list is spelled out rather than inferred, so what this check
    // ignores is visible instead of being an accident of a regex.
    const NOT_ACCOUNT_ROLES = new Set([
        'assistant', 'model', 'system',   // Gemini message roles
        'viewer', 'editor', 'owner',      // client_members access levels
        'target', 'rival'                 // report comparison labels
    ]);
    const roles = [...new Set(
        [...SERVER.matchAll(/profile\.role\s*===\s*'(\w+)'/g)].map(m => m[1])
            .concat([...SERVER.matchAll(/\brole\s*[=:]\s*'(\w+)'/g)].map(m => m[1]))
    )].filter(r => !NOT_ACCOUNT_ROLES.has(r));

    check('every account role the server recognises can be assigned in admin',
        roles.filter(r => !new RegExp(`value="${r}"`).test(admin))
            .map(r => `role '${r}' exists in the server but no admin control offers it`));

    // Creating and editing are separate capabilities, and they drifted apart:
    // the edit dropdown offered all three roles while the create form offered
    // two, so onboarding a client meant making them an employee first and
    // changing it afterwards. "Assignable somewhere" would have passed that.
    const createSelect = (/<select id="nu-role">([\s\S]*?)<\/select>/.exec(admin) || [])[1] || '';
    check('every account role can be chosen when CREATING an account, not only when editing one',
        createSelect
            ? roles.filter(r => !new RegExp(`value="${r}"`).test(createSelect))
                .map(r => `the create form cannot make a '${r}' account — it can only be set by editing afterwards`)
            : ['the create form\'s role select could not be found — this check has gone stale']);
    ok(`roles assignable: ${roles.join(', ')}`);

    // --- quota settings -------------------------------------------------
    // A setting the server reads from system_settings and enforces, with no
    // way to change it, is a limit nobody chose and nobody can move.
    const settingKeys = [...new Set(
        [...SERVER.matchAll(/\.eq\('key',\s*'(\w+)'\)/g)].map(m => m[1])
            .concat([...SERVER.matchAll(/QUOTA_DEFAULT_KEY\s*=\s*\{([^}]*)\}/g)]
                .flatMap(m => [...m[1].matchAll(/'(\w+)'/g)].map(x => x[1])))
    )].filter(k => !/apify_token|heartbeat|cycle|encryption/.test(k));

    check('every quota setting the server enforces is editable in admin',
        settingKeys.filter(k => !admin.includes(k) && !/allEngines/.test(admin) === false && !adminReachesSetting(admin, k))
            .map(k => `system_settings['${k}'] is enforced but can only be changed with SQL`));
    ok(`quota settings reachable: ${settingKeys.join(', ')}`);

    // --- admin endpoints ------------------------------------------------
    // An admin route with no caller is either an ops endpoint (fine, but it
    // must be written down) or a feature nobody can find.
    const adminRoutes = [...new Set(
        [...SERVER.matchAll(/app\.\w+\(\s*'(\/api\/admin\/[\w/:-]+)'/g)].map(m => m[1])
    )];
    const docs = fs.existsSync(path.join(ROOT, 'docs'))
        ? fs.readdirSync(path.join(ROOT, 'docs')).map(f => fs.readFileSync(path.join(ROOT, 'docs', f), 'utf8')).join('\n')
        : '';
    const readme = fs.existsSync(path.join(ROOT, 'README.md')) ? fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8') : '';
    const unreachable = adminRoutes.filter(r => {
        const tail = r.replace(/\/api\/admin\//, '').split('/')[0];
        return !admin.includes(tail) && !docs.includes(tail) && !readme.includes(tail);
    });
    check('every admin endpoint has a control or is documented as ops-only', unreachable
        .map(r => `${r} has no admin control and is not documented — nobody can reach or find it`));
    ok(`${adminRoutes.length} admin endpoints, all reachable or documented`);
}

/** Does admin.html offer a control for this system_settings key? */
function adminReachesSetting(admin, key) {
    if (admin.includes(key)) return true;
    // A page that renders caps from the server's own metric list reaches every
    // cap key without naming any of them.
    if (/api\/admin\/settings/.test(admin) && /data-cap=/.test(admin)) {
        return ['trial_caps', 'client_monthly_caps', 'trial_days'].includes(key);
    }
    return false;
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
console.log('\nwork pages: every page that starts a job asks which client it is for');
{
    const listed = (/const WORK_PAGES\s*=\s*\[([\s\S]*?)\]/.exec(HEADER) || [])[1];
    const workPages = listed ? [...listed.matchAll(/'([\w.-]+\.html)'/g)].map(m => m[1]) : [];

    // Routes that create a job: the enclosing route of every JOB_WORKERS[...] start.
    const routeStarts = [...SERVER.matchAll(/app\.post\(\s*'(\/api\/[^']+)'/g)].map(m => ({ i: m.index, p: m[1] }));
    const jobRoutes = new Set();
    for (const m of SERVER.matchAll(/JOB_WORKERS\[/g)) {
        const owner = routeStarts.filter(r => r.i < m.index).pop();
        if (owner) jobRoutes.add(owner.p);
    }
    const jobMatchers = [...jobRoutes].map(routeMatcher);

    const starters = [];
    for (const f of PAGES) {
        if (/^client-|^client\.html$|^share\.html$|^signup\.html$/.test(f)) continue;   // clients ARE their business; public pages start nothing
        const src = fs.readFileSync(path.join(FRONT_DIR, f), 'utf8');
        const engineNull = /EL\.init\(\s*\{[^}]*engine:\s*null/.test(src);
        if (engineNull) continue;                                                    // workspace pages: work is scoped by the record itself
        const posts = pageCalls(src).filter(c => c.method === 'POST' || c.method === 'ANY');
        if (posts.some(c => c.paths.some(p => jobMatchers.some(re => re.test(p))))) starters.push(f);
    }

    check('every page that starts a job carries the work-for bar', starters
        .filter(f => !workPages.includes(f))
        .map(f => `${f} starts jobs but is not in WORK_PAGES — work can be launched with no client asked for`));
    check('every WORK_PAGES entry is a real page that starts a job', workPages
        .filter(f => !PAGES.includes(f) || !starters.includes(f))
        .map(f => `${f} is in WORK_PAGES but ${PAGES.includes(f) ? 'starts no job' : 'does not exist'}`));
    ok(`${starters.length} job-starting pages, all carrying the bar: ${starters.join(', ')}`);
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
