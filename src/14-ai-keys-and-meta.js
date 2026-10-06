/**
 * Gemini keys, Meta owner data (OAuth, Graph), data deletion, the daily numbers.
 *
 * Part of the EdgeLead server, split out of server.js (phase 55). The parts load in
 * order from server.js and share one namespace, S: what this part needs from an earlier
 * part is unpacked below; anything else from another part is read as S.name when it runs.
 */
'use strict';
const S = require('./shared');
const {
    APIFY_CYCLE_CREDIT, ENGINE_LABELS, GEMINI_API_KEY, GEMINI_MODEL, GEMINI_MODEL_FALLBACKS, JOB_WORKERS,
    UUID_RE, _geminiCoolLocal, _geminiDeadModels, _geminiDiscovered, aiReasonText, app, applyReportScope,
    assertJobSlot, auth, bearerId, budgetedJson, canReadReport, cleanClientBody, clientAccess, createJob,
    crypto, cycleMonth, cycleUsage, decryptSecret, encryptSecret, enginePrimaryCredit, geminiAvailable,
    geminiCallDetailed, getEnginePrimary, invalidateGeminiPool, loadGeminiPool, logger, median, publicLimit,
    rateLimit, registerWorker, requireAdmin, requireEngine, requireOwnClient, runJob, sendErr, spendLimit,
    supabase, tokenHash, userRole, xp
} = S;
Object.assign(S, {
    cleanGeminiKey, geminiProbeKey, keyPoolSummary, metaConfigured, graphGet, graphInsights,
    metaParseSignedRequest, metaDeleteUserData, metaForget, metaLoadConnection, seriesSum, seriesLast,
    dayStr, shiftDay, metaDailySync, metaDailyTick, growthFrom, growthForConnections
});

// ===========================================================================
// PHASE 9 :: GEMINI KEYS (personal + shared pool)
// ===========================================================================

app.get('/api/gemini-keys', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const isAdmin = ctx.profile.role === 'admin';
        let q = supabase.from('gemini_keys')
            .select('id, owner_user_id, label, status, cooldown_until, fail_count, calls_total, last_used_at, last_error, created_at')
            .order('created_at', { ascending: false });
        q = isAdmin ? q : q.eq('owner_user_id', ctx.user.id);
        const { data, error } = await q;
        if (error) throw error;
        res.json({
            keys: (data || []).map(k => ({ ...k, scope: k.owner_user_id ? 'personal' : 'pool' })),
            envConfigured: !!GEMINI_API_KEY,
            // Google stopped accepting standard (AIza) keys in September 2026.
            envLegacy: /^AIza/.test(GEMINI_API_KEY),
            envKey: !!GEMINI_API_KEY,
            poolKeys: (data || []).filter(k => !k.owner_user_id && k.status !== 'invalid').length,
            discovered: _geminiDiscovered.models.slice(0, 3),
            model: GEMINI_MODEL,
            fallbacks: GEMINI_MODEL_FALLBACKS,
            deadModels: [..._geminiDeadModels.keys()]
        });
    } catch (err) { sendErr(res, err); }
});

/**
 * A Gemini key as pasted: trimmed, unquoted, without a "GEMINI_API_KEY=" in front. Google changed the
 * format in 2026: new AI Studio keys are auth keys that start with "AQ.", older standard keys start
 * with "AIza" (and stopped being accepted in September 2026). Both are accepted here; the shape check
 * only refuses what cannot be a key, and Google itself decides the rest. Null when it is no key.
 */
function cleanGeminiKey(raw) {
    const k = String(raw || '').trim().replace(/^GEMINI_API_KEY\s*=\s*/i, '').replace(/^["'`]+|["'`]+$/g, '').trim();
    return /^[A-Za-z0-9._-]{30,400}$/.test(k) ? k : null;
}
/** Ask Google whether a key works: the models list first, then one tiny request. A 429 means the key is fine but busy. */
async function geminiProbeKey(key) {
    const why = async r => { try { const j = await r.json(); return j?.error?.message || ''; } catch { return ''; } };
    let r;
    try { r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(15000) }); }
    catch { return { ok: false, error: 'Google could not be reached to check the key. Try again in a minute.' }; }
    if (r.ok || r.status === 429) return { ok: true };
    const first = await why(r);
    try {
        r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
            body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'ok' }] }], generationConfig: { maxOutputTokens: 1 } }),
            signal: AbortSignal.timeout(15000)
        });
    } catch { return { ok: false, error: 'Google could not be reached to check the key. Try again in a minute.' }; }
    if (r.ok || r.status === 429) return { ok: true };
    const second = await why(r);
    const legacy = /^AIza/.test(key) ? ' Keys that start with AIza were retired by Google in September 2026; create a new one in Google AI Studio (it starts with AQ.).' : '';
    return { ok: false, error: `Google rejected that key${second || first ? ': ' + (second || first).slice(0, 160) : '.'}${legacy}` };
}

app.post('/api/gemini-keys', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const key = cleanGeminiKey(req.body.key || req.body.token);
        if (!key) return res.status(400).json({ error: 'Paste the whole key from Google AI Studio. New keys start with AQ. and older ones with AIza.' });
        const isGlobal = !!req.body.global && ctx.profile.role === 'admin';

        // Google decides, not the shape: verify with one tiny call before storing anything.
        const check = await geminiProbeKey(key);
        if (!check.ok) return res.status(400).json({ error: check.error });

        const row = {
            owner_user_id: isGlobal ? null : ctx.user.id,
            label: String(req.body.label || '').slice(0, 80) || (isGlobal ? 'pool key' : 'my key'),
            key_enc: encryptSecret(key),
            key_hash: tokenHash(key),
            status: 'active'
        };
        const { data, error } = await supabase.from('gemini_keys').insert([row]).select('id, owner_user_id, label, status, created_at').maybeSingle();
        if (error) {
            if (/duplicate|unique/i.test(error.message)) return res.status(409).json({ error: 'That key is already stored.' });
            throw error;
        }
        invalidateGeminiPool(); await loadGeminiPool(true);
        res.status(201).json({ key: { ...data, scope: data.owner_user_id ? 'personal' : 'pool' } });
    } catch (err) { sendErr(res, err); }
});

// ---------------------------------------------------------------------------
// KEY POOLS AT A GLANCE (phase 44)
//
// Every Apify and Gemini key the server can reach, sorted into the tiers it
// tries them in, with what is usable right now — and, per person, which tier
// their next run would draw from. Pure over rows, so it can be tested.
// ---------------------------------------------------------------------------
const APIFY_ENGINES = ['leadgen', 'report', 'fb_community', 'fb_page'];
/** What each kind of key pays for, in the words the team uses. One list, shown on the admin key page. */
const KEY_COVERAGE = {
    apify: [
        { engine: 'leadgen', label: 'Lead finder', covers: ['Lead searches (Instagram and Facebook Pages)', 'Finding lead contact details', 'Review tracker: finding businesses and reading their tagged posts'] },
        { engine: 'report', label: 'Reports & competitors', covers: ['Instagram audits', 'Competitor intel and finding competitors', 'Monthly report without Meta', 'Creator posts: the weekly look and staff looks'] },
        { engine: 'fb_community', label: 'Facebook communities', covers: ['Facebook group reads', 'Finding and checking Facebook groups'] },
        { engine: 'fb_page', label: 'Facebook Pages', covers: ['Facebook Page reports'] }
    ],
    gemini: ['Every report write-up (Instagram, Facebook Page, Facebook groups, monthly reports)', 'Content plan briefs, the business audit and idea suggestions',
        'Review tracker: telling reviews from other posts', 'Lead first-message drafts', 'Ask AI for staff', 'Edge Meta AI for owners and staff'],
    free: ['Content plans built from stored posts', 'Meta owner numbers and the Edge Meta AI twice-daily read (Meta, not Apify)'],
    whose: [
        { who: 'A run a staff member starts', uses: 'their own key first, then the shared keys (never shared keys if set to "Own keys only")' },
        { who: 'A scheduled run', uses: 'the key of the person who made the schedule, then the shared keys' },
        { who: 'An owner using the portal and Edge Meta AI', uses: 'the shared keys (owners add no keys)' },
        { who: 'Automatic background work (creator posts weekly look)', uses: 'the shared keys' }
    ]
};
S.KEY_COVERAGE = KEY_COVERAGE;
function keyPoolSummary({ people = [], apify = [], primaries = {}, gemini = [], envApify = false, envGemini = false, now = Date.now() }) {
    const apifyUsable = k => k.status === 'active' && !(k.remainingUsd != null && k.remainingUsd <= 0);
    const geminiState = k => k.status === 'invalid' ? 'invalid'
        : (k.status === 'cooldown' && k.cooldown_until && new Date(k.cooldown_until).getTime() > now) ? 'cooldown' : 'active';
    const count = (rows, stateOf) => rows.reduce((m, k) => { const st = stateOf(k); m[st] = (m[st] || 0) + 1; m.total += 1; return m; }, { total: 0 });
    const apifyState = k => apifyUsable(k) ? 'active' : (k.status === 'active' ? 'out of credit' : k.status);
    const forEngine = (rows, e) => rows.filter(k => k.engine === e || k.engine === 'any');
    const sharedApify = apify.filter(k => !k.owner_user_id);
    const sharedGemini = gemini.filter(k => !k.owner_user_id);
    const primaryOk = e => !!(primaries[e] && primaries[e].configured && !(primaries[e].creditUsd && primaries[e].spentUsd >= primaries[e].creditUsd));
    const apifyNext = (own, byo, e) => {
        if (forEngine(own, e).some(apifyUsable)) return 'own key';
        if (byo) return 'nothing (own key only)';
        if (primaryOk(e)) return 'company primary';
        if (forEngine(sharedApify, e).some(apifyUsable)) return 'shared pool';
        if (envApify) return 'server key';
        return 'nothing';
    };
    const geminiNext = (own, byo) => {
        if (own.some(k => geminiState(k) === 'active')) return 'own key';
        if (byo) return own.some(k => geminiState(k) === 'cooldown') ? 'nothing right now (own key resting)' : 'nothing (own key only)';
        if (sharedGemini.some(k => geminiState(k) === 'active')) return 'shared pool';
        if (envGemini) return 'server key';
        return 'nothing';
    };
    return {
        apify: {
            order: ['Own key', 'Company primary for the engine', 'Shared pool', 'Server key'],
            primaries: APIFY_ENGINES.map(e => ({ engine: e, label: ENGINE_LABELS[e] || e, configured: !!(primaries[e] && primaries[e].configured),
                usable: primaryOk(e), creditUsd: primaries[e] ? primaries[e].creditUsd ?? null : null, spentUsd: primaries[e] ? primaries[e].spentUsd ?? null : null })),
            shared: { ...count(sharedApify, apifyState), byEngine: Object.fromEntries(['any', ...APIFY_ENGINES].map(e => [e, sharedApify.filter(k => k.engine === e && apifyUsable(k)).length])) },
            personal: count(apify.filter(k => k.owner_user_id), apifyState),
            env: !!envApify
        },
        gemini: {
            order: ['Own key', 'Shared pool', 'Server key'],
            shared: count(sharedGemini, geminiState),
            personal: count(gemini.filter(k => k.owner_user_id), geminiState),
            env: !!envGemini
        },
        people: people.map(u => {
            const ownA = apify.filter(k => k.owner_user_id === u.id), ownG = gemini.filter(k => k.owner_user_id === u.id);
            const byo = !!u.byo_key_only;
            return { id: u.id, name: u.full_name || String(u.email || '').split('@')[0], role: u.role, ownKeysOnly: byo,
                apify: { keys: ownA.length, active: ownA.filter(apifyUsable).length, next: Object.fromEntries(APIFY_ENGINES.map(e => [e, apifyNext(ownA, byo, e)])) },
                gemini: { keys: ownG.length, active: ownG.filter(k => geminiState(k) === 'active').length, next: geminiNext(ownG, byo) } };
        })
    };
}

app.get('/api/admin/key-pools', async (req, res) => {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        const [{ data: people }, { data: apify }, { data: gemini }] = await Promise.all([
            supabase.from('app_users').select('id, email, full_name, role, is_active, byo_key_only').neq('role', 'client'),
            supabase.from('apify_keys').select('id, owner_user_id, engine, label, status, monthly_credit_usd, token_hash, last_used_at'),
            supabase.from('gemini_keys').select('id, owner_user_id, label, status, cooldown_until, calls_total, last_used_at')
        ]);
        const month = cycleMonth();
        const apifyRows = [];
        for (const k of apify || []) {
            const credit = Number(k.monthly_credit_usd) > 0 ? Number(k.monthly_credit_usd) : APIFY_CYCLE_CREDIT;
            const spent = k.token_hash ? await cycleUsage(k.token_hash, month) : 0;
            apifyRows.push({ ...k, token_hash: undefined, remainingUsd: +(credit - spent).toFixed(4) });
        }
        const primaries = {};
        for (const e of APIFY_ENGINES) {
            const v = await getEnginePrimary(e);
            primaries[e] = v ? { configured: true, creditUsd: await enginePrimaryCredit(e), spentUsd: +(await cycleUsage(tokenHash(v))).toFixed(4) } : { configured: false };
        }
        res.json({ ...keyPoolSummary({ people: (people || []).filter(u => u.is_active !== false), apify: apifyRows, primaries, gemini: gemini || [],
            envApify: !!(process.env.APIFY_API_KEY || process.env.APIFY_API_TOKEN), envGemini: !!GEMINI_API_KEY }), coverage: KEY_COVERAGE });
    } catch (err) { sendErr(res, err); }
});

app.post('/api/gemini-keys/:id/reset', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        _geminiCoolLocal.delete(req.params.id);   // a reset key is usable at once, not after its local rest
        let q = supabase.from('gemini_keys').update({ status: 'active', cooldown_until: null, fail_count: 0, last_error: null }).eq('id', req.params.id);
        if (ctx.profile.role !== 'admin') q = q.eq('owner_user_id', ctx.user.id);
        const { error } = await q;
        if (error) throw error;
        invalidateGeminiPool();
        res.json({ success: true });
    } catch (err) { sendErr(res, err); }
});

app.delete('/api/gemini-keys/:id', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        let q = supabase.from('gemini_keys').delete().eq('id', req.params.id);
        if (ctx.profile.role !== 'admin') q = q.eq('owner_user_id', ctx.user.id);
        const { error } = await q;
        if (error) throw error;
        invalidateGeminiPool(); await loadGeminiPool(true);
        res.json({ success: true });
    } catch (err) { sendErr(res, err); }
});

// ===========================================================================
// PHASE 9 :: META OWNER DATA  (OAuth + Graph API, read-only scopes)
//
// Scraping shows what the public sees. This shows what only the owner sees:
// reach, saves, shares, views, demographics. The two are never blended: every
// number carries a source tag, and competitors are always 'scraped'.
// ===========================================================================

const META_APP_ID        = (process.env.META_APP_ID || '').trim();
const META_APP_SECRET    = (process.env.META_APP_SECRET || '').trim();
const META_GRAPH_VERSION = (process.env.META_GRAPH_VERSION || 'v24.0').trim();
S.META_GRAPH_VERSION = META_GRAPH_VERSION;
const META_SCOPES        = (process.env.META_SCOPES ||
    // Phase 45: comments are read too (pages_read_user_content, instagram_manage_comments), so the
    // Owner Assistant's comment digest works. Owners connected before this reconnect once to grant them.
    // Phase 46: ads_read, so Edge Meta AI can answer about ad spend and results. Read only.
    'pages_show_list,pages_read_engagement,pages_read_user_content,read_insights,instagram_basic,instagram_manage_insights,instagram_manage_comments,business_management,ads_read')
    .split(',').map(s => s.trim()).filter(Boolean);
S.META_SCOPES = META_SCOPES;
const FRONTEND_URL       = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');
S.FRONTEND_URL = FRONTEND_URL;
const BACKEND_URL_ENV    = (process.env.BACKEND_URL || '').replace(/\/+$/, '');
const META_MEDIA_LIMIT   = parseInt(process.env.META_MEDIA_LIMIT || '50', 10);
S.META_MEDIA_LIMIT = META_MEDIA_LIMIT;

function metaConfigured() { return !!(META_APP_ID && META_APP_SECRET); }
function backendBase(req) {
    if (BACKEND_URL_ENV) return BACKEND_URL_ENV;
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
    return `${proto}://${req.get('host')}`;
}
function metaRedirectUri(req) { return `${backendBase(req)}/api/meta/oauth/callback`; }

/** GET against the Graph API. Throws { code, type, message, subcode } on API error. */
async function graphGet(path, params = {}, token) {
    const u = new URL(`https://graph.facebook.com/${META_GRAPH_VERSION}/${String(path).replace(/^\/+/, '')}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    if (token) u.searchParams.set('access_token', token);
    const r = await fetch(u.toString());
    let body = null;
    try { body = await r.json(); } catch (_) { body = null; }
    if (!r.ok || body?.error) {
        const e = new Error(body?.error?.message || `Graph ${r.status}`);
        e.graph = body?.error || { code: r.status };
        e.statusCode = r.status === 401 || body?.error?.code === 190 ? 401 : 502;
        throw e;
    }
    return body;
}

/**
 * Insights with metric-name resilience. Graph renames and retires metrics per
 * version. Ask for the whole list; if it complains, drop the metric it names
 * and try again; finally probe one at a time. Returns { values, unsupported }.
 */
async function graphInsights(path, metrics, params, token) {
    const values = {};
    const unsupported = [];
    let list = metrics.slice();
    for (let i = 0; i < 6 && list.length; i++) {
        try {
            const out = await graphGet(`${path}/insights`, { ...params, metric: list.join(',') }, token);
            for (const m of (out.data || [])) {
                const tv = m.total_value?.value;
                values[m.name] = tv !== undefined ? tv : (m.values || []).map(v => ({ end_time: v.end_time, value: v.value }));
            }
            return { values, unsupported };
        } catch (err) {
            const msg = String(err.message || '');
            const named = list.find(m => new RegExp(`\\b${m}\\b`).test(msg));
            if (named) { unsupported.push(named); list = list.filter(m => m !== named); continue; }
            if (err.statusCode === 401) throw err;
            break;
        }
    }
    // Probe individually for whatever is left.
    for (const m of list) {
        try {
            const out = await graphGet(`${path}/insights`, { ...params, metric: m }, token);
            for (const d of (out.data || [])) {
                const tv = d.total_value?.value;
                values[d.name] = tv !== undefined ? tv : (d.values || []).map(v => ({ end_time: v.end_time, value: v.value }));
            }
        } catch (err) { if (err.statusCode === 401) throw err; unsupported.push(m); }
    }
    return { values, unsupported };
}

function igShortcodeFromPermalink(p) {
    const m = String(p || '').match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
}

/**
 * Phase 47: hand a business that just got a Meta connection to Edge Meta AI's first read, in the
 * background. Never awaited by the request and never fails it: the boot pass, the status route and
 * the twice-daily read all try again if this one could not start.
 */
function startFirstRead(clientId, why) {
    // The Home page's daily numbers too: the hourly pass would get there, this gets there now.
    Promise.resolve().then(() => metaDailyTick()).catch(() => {});
    Promise.resolve().then(() => xp.kickoff(clientId, why, { force: true }))
        .then(r => logger.info('xp_first_read', { clientId, why, started: !!(r && r.started), reason: r && r.reason }))
        .catch(e => logger.warn('xp_first_read_failed', { clientId, why, message: e.message }));
}

app.get('/api/meta/status', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        res.json({ configured: metaConfigured(), scopes: META_SCOPES, graphVersion: META_GRAPH_VERSION, redirectUri: metaRedirectUri(req) });
    } catch (err) { sendErr(res, err); }
});

app.get('/api/meta/oauth/start', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'meta_owned'); if (!ctx) return;
        if (!metaConfigured()) return res.status(503).json({ error: ctx.profile?.role === 'client'
            ? 'Connecting Facebook is not switched on yet. Your agency is setting it up; try again later.'
            : 'Meta is not set up yet: add META_APP_ID and META_APP_SECRET on Render (see the Meta app guide).' });
        // A client account connects its own business; it is never asked which (phase 30), and an id
        // the browser sent along is ignored rather than refused (phase 51).
        let clientId = null;
        if (ctx.profile?.role === 'client') {
            const own = await requireOwnClient(ctx, res); if (!own) return;
            clientId = own.id;
        }
        else if (req.query.client_id) {
            clientId = (await clientAccess(ctx.user.id, req.query.client_id, 'editor'))?.id || null;
            if (!clientId) return res.status(403).json({ error: 'No edit access to that client.' });
        }

        const state = crypto.randomBytes(24).toString('hex');
        const { error } = await supabase.from('meta_oauth_states').insert([{
            state, user_id: ctx.user.id, client_id: clientId,
            expires_at: new Date(Date.now() + 15 * 60000).toISOString()
        }]);
        if (error) throw error;

        const u = new URL(`https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`);
        u.searchParams.set('client_id', META_APP_ID);
        u.searchParams.set('redirect_uri', metaRedirectUri(req));
        u.searchParams.set('state', state);
        u.searchParams.set('scope', META_SCOPES.join(','));
        u.searchParams.set('response_type', 'code');
        res.json({ url: u.toString(), redirectUri: metaRedirectUri(req) });
    } catch (err) { sendErr(res, err); }
});

/** Public: Facebook redirects the browser here. State row is the auth. */
app.get('/api/meta/oauth/callback', async (req, res) => {
    // Staff land on the Clients page; a client account lands on its own
    // dashboard, which is the only page it can open anyway.
    let landing = 'clients.html';
    // Phase 57: an owner reads plain words, not the setup detail the team needs.
    const forOwner = q => (landing === 'ai/' && q.meta === 'error')
        ? { ...q, message: /no Pages/i.test(q.message || '')
            ? 'Facebook did not give us your Page. Try again and tick your Page in the Facebook window, or ask your agency.'
            : /expired/i.test(q.message || '') ? q.message : 'Facebook did not connect. Try again, or ask your agency.' }
        : q;
    const back = (q0) => {
        const q = forOwner(q0);
        const base = FRONTEND_URL ? `${FRONTEND_URL}/${landing}` : `/${landing}`;
        res.redirect(`${base}?${new URLSearchParams(q).toString()}`);
    };
    try {
        const { code, state, error: fbErr, error_description } = req.query;
        if (fbErr) return back({ meta: 'error', message: String(error_description || fbErr).slice(0, 200) });
        if (!code || !state) return back({ meta: 'error', message: 'Missing code or state.' });

        const { data: st } = await supabase.from('meta_oauth_states').select('*').eq('state', String(state)).maybeSingle();
        await supabase.from('meta_oauth_states').delete().eq('state', String(state));
        if (!st || new Date(st.expires_at).getTime() < Date.now()) return back({ meta: 'error', message: 'Login link expired. Try again.' });
        // Phase 49: owners live in Edge Meta AI, so that is where Meta sends them back.
        if ((await userRole(st.user_id).catch(() => null)) === 'client') landing = 'ai/';

        const shortTok = await graphGet('oauth/access_token', {
            client_id: META_APP_ID, client_secret: META_APP_SECRET,
            redirect_uri: metaRedirectUri(req), code: String(code)
        });
        const longTok = await graphGet('oauth/access_token', {
            grant_type: 'fb_exchange_token', client_id: META_APP_ID,
            client_secret: META_APP_SECRET, fb_exchange_token: shortTok.access_token
        });
        const userToken = longTok.access_token;
        const expiresAt = longTok.expires_in ? new Date(Date.now() + longTok.expires_in * 1000).toISOString() : null;

        let granted = [], fbUserId = null;
        try {
            const dbg = await graphGet('debug_token', { input_token: userToken, access_token: `${META_APP_ID}|${META_APP_SECRET}` });
            granted = dbg?.data?.scopes || [];
            // The app-scoped user id. A Data Deletion Request from Meta names
            // the person by this and nothing else; without it the request
            // could not be matched to a single row we hold.
            fbUserId = dbg?.data?.user_id ? String(dbg.data.user_id) : null;
        } catch (_) {}

        const pages = await graphGet('me/accounts', {
            fields: 'id,name,access_token,instagram_business_account{id,username}', limit: 100
        }, userToken);

        // Which client each Page goes under (phase 57). Facebook returns every Page the login manages,
        // not only this client's: filing them all here moved other clients' Pages (and Edge Meta AI's
        // copy of their numbers) under this one. Now a Page another live client already holds stays
        // with it; this client gets its own Page (the one it names, or the only new one); any other
        // new Page waits, unfiled, on the Clients page for someone to file.
        const list = pages.data || [];
        const pageIds = list.map(p => String(p.id));
        const { data: held } = pageIds.length
            ? await supabase.from('meta_connections').select('page_id, client_id').in('page_id', pageIds).not('client_id', 'is', null)
            : { data: [] };
        const holderIds = [...new Set((held || []).map(h => h.client_id))];
        const { data: liveHolders } = holderIds.length ? await supabase.from('clients').select('id').in('id', holderIds).eq('archived', false) : { data: [] };
        const liveSet = new Set((liveHolders || []).map(c => c.id));
        const holder = {};
        for (const h of (held || [])) if (liveSet.has(h.client_id) && !holder[h.page_id]) holder[h.page_id] = h.client_id;
        const mine = new Set();
        if (st.client_id) {
            const { data: cl } = await supabase.from('clients').select('name, fb_page, fb_page_id, ig_handle').eq('id', st.client_id).maybeSingle();
            const free = list.filter(p => !holder[String(p.id)] || holder[String(p.id)] === st.client_id);
            free.filter(p => holder[String(p.id)] === st.client_id).forEach(p => mine.add(String(p.id)));
            const fresh = free.filter(p => !holder[String(p.id)]);
            const norm = v => String(v || '').toLowerCase().replace(/^@/, '').replace(/[^a-z0-9]/g, '');
            const named = fresh.filter(p => cl && (
                (cl.fb_page_id && String(cl.fb_page_id) === String(p.id))
                || (cl.ig_handle && norm(cl.ig_handle) === norm(p.instagram_business_account?.username))
                || (cl.fb_page && norm(cl.fb_page).includes(norm(p.name)) && norm(p.name).length > 3)
                || (cl.name && norm(cl.name) === norm(p.name))));
            if (named.length) named.forEach(p => mine.add(String(p.id)));
            else if (fresh.length === 1 && !mine.size) mine.add(String(fresh[0].id));
        }
        const filedTo = pid => holder[pid] && holder[pid] !== st.client_id ? holder[pid] : (mine.has(pid) ? st.client_id : (holder[pid] || null));

        let saved = 0, unfiled = 0;
        for (const p of list) {
            const pid = String(p.id);
            const target = filedTo(pid);
            if (!target) unfiled += 1;
            const row = {
                user_id: st.user_id, client_id: target,
                page_id: String(p.id), page_name: p.name || null,
                page_token_enc: encryptSecret(p.access_token),
                ig_user_id: p.instagram_business_account?.id || null,
                ig_username: p.instagram_business_account?.username || null,
                user_token_enc: encryptSecret(userToken),
                token_expires_at: expiresAt, scopes: granted,
                fb_user_id: fbUserId,
                status: 'active', last_error: null
            };
            const { error } = await supabase.from('meta_connections').upsert([row], { onConflict: 'user_id,page_id' });
            if (!error) saved += 1;
        }
        // Naming both causes, because they look identical from here and the
        // second one is the usual answer while the Meta app is in Development
        // Mode: the login succeeds, Meta returns an empty Page list, and the
        // person reads "select a Page" and goes hunting through a dialog that
        // never offered them one.
        if (!saved) return back({ meta: 'error', message: 'Login worked but Meta returned no Pages. Either no Page was ticked in the dialog, or this Facebook account has no role on the EdgeLead Meta app yet — while the app is in Development Mode only Admins, Developers and Testers get Pages back.' });
        // Phase 47: the business is read now, not at the next 09:00 or 21:00, and nobody presses anything.
        if (st.client_id && mine.size) startFirstRead(st.client_id, 'connect');
        back({ meta: 'ok', pages: saved, client: st.client_id || '', filed: st.client_id ? mine.size : 0, unfiled });
    } catch (err) {
        logger.error('meta_oauth_callback', { message: err.message });
        back({ meta: 'error', message: String(err.message || 'OAuth failed').slice(0, 200) });
    }
});

// ===========================================================================
// META DATA DELETION (phase 24)
//
// When a person removes EdgeLead from their Facebook settings, Meta POSTs a
// signed_request here. The signature is HMAC-SHA256 over the payload with the
// app secret, so only Meta can produce it. The payload names the person by
// app-scoped user id; everything held under that id goes, and the response
// gives Meta a URL and a code the person can use to see that it went.
//
// This is a platform requirement for the app to be used by anyone outside
// its own testers. It is also simply right: the data is theirs.
// ===========================================================================

/** Verify and decode a Meta signed_request. Returns the payload, or null. */
function metaParseSignedRequest(signedRequest, secret) {
    const parts = String(signedRequest || '').split('.');
    if (parts.length !== 2 || !secret) return null;
    const b64 = v => Buffer.from(String(v).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const sig = b64(parts[0]);
    const expected = crypto.createHmac('sha256', secret).update(parts[1]).digest();
    if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;
    try {
        const payload = JSON.parse(b64(parts[1]).toString('utf8'));
        return payload && payload.algorithm && String(payload.algorithm).toUpperCase() === 'HMAC-SHA256' ? payload : null;
    } catch { return null; }
}

/** Everything held for one Facebook user, gone. Returns what was removed. */
async function metaDeleteUserData(fbUserId) {
    const { data: conns } = await supabase.from('meta_connections').select('id, client_id').eq('fb_user_id', String(fbUserId));
    return metaForget(conns || []);
}

/**
 * Forget Meta connections completely (phase 45). Used by Disconnect and by
 * Meta's data-deletion request, so the two can never drift apart again:
 *   1. the owner reports built from them (scraped reports are not touched:
 *      they were built from public data and name no Facebook user);
 *   2. the connections, and the media, snapshots and daily numbers that
 *      cascade from them;
 *   3. the Owner Assistant's copy: tokens, posts, readings, audience,
 *      comments, ads — and, when the business has no Meta connection left,
 *      its chats and its row, so the twice-daily read stops for it.
 * Step 3 goes through the database function from schema-phase45.sql; if it
 * is missing the rest still happens and the result says so.
 */
async function metaForget(conns) {
    const ids = conns.map(c => c.id);
    if (!ids.length) return { connections: 0, reports: 0, assistant: null };
    const { count } = await supabase.from('reports').select('id', { count: 'exact', head: true })
        .eq('platform', 'meta').in('meta_connection_id', ids);
    await supabase.from('reports').delete().eq('platform', 'meta').in('meta_connection_id', ids);
    await supabase.from('meta_connections').delete().in('id', ids);
    const assistant = {};
    for (const clientId of [...new Set(conns.map(c => c.client_id).filter(Boolean))]) {
        const { data: left } = await supabase.from('meta_connections').select('id').eq('client_id', clientId).limit(1);
        const r = await xp.purge(clientId, left && left.length ? conns.filter(c => c.client_id === clientId).map(c => c.id) : null).catch(e => ({ error: e.message }));
        if (r.error) logger.error('xp_purge_failed', { clientId, message: r.error });
        assistant[clientId] = r;
    }
    return { connections: ids.length, reports: count || 0, assistant };
}

app.post('/api/meta/data-deletion', publicLimit, async (req, res) => {
    try {
        const payload = metaParseSignedRequest(req.body?.signed_request, META_APP_SECRET);
        if (!payload || !payload.user_id) return res.status(400).json({ error: 'Invalid signed request.' });

        const removed = await metaDeleteUserData(payload.user_id);
        const code = crypto.randomBytes(12).toString('hex');
        await supabase.from('meta_deletion_requests').insert([{
            code, fb_user_id: String(payload.user_id),
            connections: removed.connections, reports: removed.reports
        }]);
        logger.info('meta_data_deletion', { fbUserId: String(payload.user_id), ...removed });

        // Meta expects exactly this shape.
        const base = FRONTEND_URL || `${req.protocol}://${req.get('host')}`;
        res.json({ url: `${base}/data-deletion.html?code=${code}`, confirmation_code: code });
    } catch (err) { sendErr(res, err); }
});

/** Public: the status page looks a confirmation code up here. */
app.get('/api/public/meta/deletion/:code', publicLimit, async (req, res) => {
    try {
        const code = String(req.params.code || '');
        if (!/^[a-f0-9]{24}$/.test(code)) return res.status(404).json({ error: 'No such request.' });
        const { data } = await supabase.from('meta_deletion_requests')
            .select('code, connections, reports, created_at').eq('code', code).maybeSingle();
        if (!data) return res.status(404).json({ error: 'No such request.' });
        res.json({ status: 'complete', ...data });
    } catch (err) { sendErr(res, err); }
});

app.get('/api/meta/connections', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        let q = supabase.from('meta_connections')
            .select('id, user_id, client_id, page_id, page_name, ig_user_id, ig_username, token_expires_at, scopes, status, last_sync_at, last_error, created_at')
            .order('created_at', { ascending: false });
        if (req.query.client_id) {
            const c = await clientAccess(ctx.user.id, req.query.client_id, 'viewer');
            if (!c) return res.status(403).json({ error: 'No access to that client.' });
            q = q.eq('client_id', c.id);
        } else {
            q = q.eq('user_id', ctx.user.id);
        }
        const { data, error } = await q;
        if (error) throw error;
        res.json({ connections: data || [], configured: metaConfigured() });
    } catch (err) { sendErr(res, err); }
});

app.patch('/api/meta/connections/:id', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const { data: conn } = await supabase.from('meta_connections').select('id, user_id').eq('id', req.params.id).maybeSingle();
        if (!conn || conn.user_id !== ctx.user.id) return res.status(404).json({ error: 'Connection not found.' });
        const clientId = req.body.clientId === null ? null : (await clientAccess(ctx.user.id, req.body.clientId, 'editor'))?.id;
        if (req.body.clientId && !clientId) return res.status(403).json({ error: 'No edit access to that client.' });
        const { error } = await supabase.from('meta_connections').update({ client_id: clientId }).eq('id', conn.id);
        if (error) throw error;
        if (clientId) startFirstRead(clientId, 'filed');
        res.json({ success: true });
    } catch (err) { sendErr(res, err); }
});

/**
 * Turn a Page you manage into a client, in one step. (phase 19)
 *
 * This is how an agency actually onboards: the employee is already a manager
 * on the client's Business Suite, so connecting Meta once hands back every
 * Page they look after. Before this, that list was a dead end — you had to go
 * to the Clients page, retype the business name, the Page and the Instagram
 * handle that Meta had just told us, save, come back, and assign. Four chances
 * to typo a handle that everything downstream keys on.
 *
 * The Page is the source of truth for name, Page id and linked Instagram, so
 * none of it is retyped. Niche and location are the only things Meta cannot
 * tell us, so they are the only things asked for.
 */
app.post('/api/meta/connections/:id/onboard', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const { data: conn } = await supabase.from('meta_connections')
            .select('id, user_id, client_id, page_id, page_name, ig_username').eq('id', req.params.id).maybeSingle();
        if (!conn || conn.user_id !== ctx.user.id) return res.status(404).json({ error: 'Connection not found.' });
        if (conn.client_id) return res.status(409).json({ error: 'This Page is already filed under a client.' });

        const body = cleanClientBody(req.body);
        const row = {
            owner_user_id: ctx.user.id,
            name: body.name || conn.page_name || `Page ${conn.page_id}`,
            fb_page: body.fb_page || conn.page_name || null,
            fb_page_id: conn.page_id,
            ig_handle: body.ig_handle !== undefined ? body.ig_handle : (conn.ig_username || null),
            niche: body.niche ?? null,
            location: body.location ?? null,
            notes: body.notes ?? null
        };
        const { data: client, error } = await supabase.from('clients').insert([row]).select().maybeSingle();
        if (error) throw error;

        // If filing the connection fails, the client row would be left behind
        // looking connected when it is not. Rolling it back is better than a
        // half-onboarded client nobody can explain.
        const { error: linkErr } = await supabase.from('meta_connections')
            .update({ client_id: client.id }).eq('id', conn.id);
        if (linkErr) {
            await supabase.from('clients').delete().eq('id', client.id);
            throw linkErr;
        }

        logger.info('meta_client_onboarded', { userId: ctx.user.id, clientId: client.id, pageId: conn.page_id });
        startFirstRead(client.id, 'onboard');
        res.status(201).json({ client: { ...client, access: 'owner' }, connectionId: conn.id });
    } catch (err) { sendErr(res, err); }
});

/**
 * Every Page this employee manages, with the client each is filed under and
 * whether it still needs one. The Clients page asks for exactly this after an
 * OAuth round trip, and building it from /api/meta/connections plus
 * /api/clients meant two calls and a join in the browser.
 */
app.get('/api/meta/inbox', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const [{ data: conns }, { data: owned }, { data: mem }] = await Promise.all([
            supabase.from('meta_connections')
                .select('id, client_id, page_id, page_name, ig_username, status, last_sync_at, token_expires_at')
                .eq('user_id', ctx.user.id).order('created_at', { ascending: false }),
            supabase.from('clients').select('id, name, archived').eq('owner_user_id', ctx.user.id),
            supabase.from('client_members').select('client_id').eq('user_id', ctx.user.id)
        ]);
        const memberIds = (mem || []).map(m => m.client_id);
        let shared = [];
        if (memberIds.length) {
            const { data } = await supabase.from('clients').select('id, name, archived').in('id', memberIds);
            shared = data || [];
        }
        const clients = [...(owned || []), ...shared].filter(c => !c.archived);
        const byId = Object.fromEntries(clients.map(c => [c.id, c.name]));

        const pages = (conns || []).map(c => ({
            connectionId: c.id, pageId: c.page_id, pageName: c.page_name,
            igUsername: c.ig_username, status: c.status,
            lastSyncAt: c.last_sync_at, tokenExpiresAt: c.token_expires_at,
            clientId: c.client_id, clientName: c.client_id ? (byId[c.client_id] || 'a client you cannot see') : null,
            needsClient: !c.client_id
        }));
        res.json({
            pages, clients: clients.map(c => ({ id: c.id, name: c.name })),
            unfiled: pages.filter(p => p.needsClient).length,
            configured: metaConfigured()
        });
    } catch (err) { sendErr(res, err); }
});

app.delete('/api/meta/connections/:id', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        if (!UUID_RE.test(String(req.params.id))) return res.status(404).json({ error: 'Connection not found.' });
        const { data: conn } = await supabase.from('meta_connections').select('id, client_id').eq('id', req.params.id).eq('user_id', ctx.user.id).maybeSingle();
        if (!conn) return res.status(404).json({ error: 'Connection not found.' });
        // Everything read from Meta for it goes, the Owner Assistant's copy included (phase 45).
        const out = await metaForget([conn]);
        const failed = Object.values(out.assistant || {}).some(r => r && r.error);
        res.json({ success: true, deleted: { reports: out.reports, assistant: !failed }, ...(failed ? { warning: 'The connection is removed. The assistant’s copy could not be deleted yet; it is retried on the next scheduled read.' } : {}) });
    } catch (err) { sendErr(res, err); }
});

async function metaLoadConnection(userId, id) {
    const { data: conn } = await supabase.from('meta_connections').select('*').eq('id', id).maybeSingle();
    if (!conn) return null;
    if (conn.user_id !== userId) {
        // A member of the client may sync on the owner's behalf.
        if (!conn.client_id || !(await clientAccess(userId, conn.client_id, 'editor'))) return null;
    }
    return conn;
}

app.post('/api/meta/sync', spendLimit, async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'meta_owned'); if (!ctx) return;
        await assertJobSlot(ctx.user.id);
        const conn = await metaLoadConnection(ctx.user.id, req.body.connectionId);
        if (!conn) return res.status(404).json({ error: 'Connection not found.' });
        const days = Math.min(Math.max(parseInt(req.body.days || '28', 10) || 28, 7), 90);
        const job = await createJob(ctx.user.id, 'meta_insights', 'meta_owned',
            { connectionId: conn.id, days, clientId: conn.client_id || null, brief: String(req.body.brief || '').slice(0, 600) || null }, 0);
        runJob(job.id, JOB_WORKERS['meta_insights'](ctx.user.id, job.input, job.id));
        res.status(202).json({ success: true, jobId: job.id, estimatedUsd: 0 });
    } catch (err) { sendErr(res, err); }
});

function seriesSum(arr) { return Array.isArray(arr) ? arr.reduce((s, v) => s + (Number(v.value) || 0), 0) : Number(arr) || 0; }
function seriesLast(arr) { return Array.isArray(arr) && arr.length ? Number(arr[arr.length - 1].value) || 0 : Number(arr) || 0; }


// ===========================================================================
// THE NUMBERS EVERY DAY (phase 30)
//
// A connected account is read once a day whether or not anyone runs a report,
// so growth is read from the change between days rather than from whichever
// two reports happen to exist. Graph API only — it costs nothing. One row per
// connection, level and day in meta_daily: the lifetime counts (followers)
// are what the account says today; the activity numbers (reach, profile
// visits, interactions) are a day's totals and are written for the days that
// have ended. The hourly pass is quiet unless a connection is due.
// ===========================================================================
const META_DAILY_POLL_MS    = parseInt(process.env.META_DAILY_POLL_MS || '3600000', 10);
S.META_DAILY_POLL_MS = META_DAILY_POLL_MS;
const META_DAILY_EVERY_MS   = 20 * 3600000;        // a connection is due again after 20 hours
const META_DAILY_RETRY_MS   = 4 * 3600000;         // a failed read is tried again after 4
const META_DAILY_FIRST_DAYS = 30;                  // the first read backfills a month of activity
const META_DAILY_IG_METRICS   = ['reach', 'views', 'accounts_engaged', 'total_interactions', 'profile_views', 'website_clicks', 'follower_count'];
const META_DAILY_PAGE_METRICS = ['page_impressions_unique', 'page_post_engagements', 'page_views_total', 'page_fan_adds_unique'];

function dayStr(d) { return new Date(d).toISOString().slice(0, 10); }
function shiftDay(iso, n) { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function dayEpoch(iso) { return Math.floor(Date.parse(`${iso}T00:00:00Z`) / 1000); }
const numOrNull = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

async function metaDailyUpsert(rows) {
    if (!rows.length) return;
    const { error } = await supabase.from('meta_daily').upsert(rows, { onConflict: 'connection_id,level,day' });
    if (error) throw new Error(`meta_daily: ${error.message}`);
}

async function metaDailyFail(conn, err, out) {
    const expired = err.statusCode === 401;
    const patch = {
        // Tried again in four hours rather than every hour, and not left for a
        // day either: a transient Graph error should not cost a day of numbers.
        daily_synced_at: new Date(Date.now() - (META_DAILY_EVERY_MS - META_DAILY_RETRY_MS)).toISOString(),
        daily_error: String(err.message || err).slice(0, 300)
    };
    if (expired) { patch.status = 'expired'; patch.last_error = patch.daily_error; }
    await supabase.from('meta_connections').update(patch).eq('id', conn.id);
    logger.warn('meta_daily_failed', { connectionId: conn.id, message: err.message, expired });
    return { ...out, ok: false, error: patch.daily_error, expired };
}

/**
 * Read one connection's numbers: today's lifetime counts, and the activity of
 * the last `days` ended days. Never throws — the result says what happened
 * and the connection row carries the last error, so the client page can show
 * it. A 401 marks the connection expired, as the report worker does.
 */
async function metaDailySync(conn, { days = 3, now = new Date() } = {}) {
    const today = dayStr(now);
    const out = { ok: true, connectionId: conn.id, today, days: 0, ig: false, page: false, warnings: [] };
    let pageToken = null;
    try { pageToken = decryptSecret(conn.page_token_enc); }
    catch (e) { return metaDailyFail(conn, e, out); }
    if (!pageToken) return metaDailyFail(conn, new Error('The connection has no Page token.'), out);

    const stamp = { connection_id: conn.id, user_id: conn.user_id, synced_at: now.toISOString() };
    const span = Math.min(Math.max(parseInt(days, 10) || 3, 1), 90);
    try {
        // --- the Page: lifetime counts today, activity per ended day ---------
        const pm = await graphGet(conn.page_id, { fields: 'id,fan_count,followers_count' }, pageToken);
        const rows = [{ ...stamp, level: 'page', day: today, followers: numOrNull(pm.followers_count), fans: numOrNull(pm.fan_count) }];
        const ins = await graphInsights(conn.page_id, META_DAILY_PAGE_METRICS,
            { period: 'day', since: dayEpoch(shiftDay(today, -span)), until: dayEpoch(today) }, pageToken);
        const map = { page_impressions_unique: 'reach', page_post_engagements: 'interactions', page_views_total: 'profile_views', page_fan_adds_unique: 'follows' };
        const byDay = {};
        for (const [metric, series] of Object.entries(ins.values)) {
            if (!Array.isArray(series) || !map[metric]) continue;
            for (const v of series) {
                if (!v || !v.end_time) continue;
                // end_time closes the day; the value belongs to the day before it.
                const day = shiftDay(dayStr(v.end_time), -1);
                if (day >= today) continue;
                (byDay[day] = byDay[day] || {})[map[metric]] = numOrNull(v.value);
            }
        }
        for (const [day, m] of Object.entries(byDay)) rows.push({ ...stamp, level: 'page', day, ...m });
        await metaDailyUpsert(rows);
        out.page = true;
        if (ins.unsupported.length) out.warnings.push(`page: ${ins.unsupported.join(', ')} not available`);

        // --- Instagram: lifetime counts today, one read per ended day --------
        if (conn.ig_user_id) {
            const im = await graphGet(conn.ig_user_id, { fields: 'id,followers_count,follows_count,media_count' }, pageToken);
            const igRows = [{ ...stamp, level: 'ig', day: today,
                followers: numOrNull(im.followers_count), following: numOrNull(im.follows_count), media_count: numOrNull(im.media_count) }];
            const unsupported = new Set();
            for (let i = 1; i <= span; i++) {
                const day = shiftDay(today, -i);
                const want = META_DAILY_IG_METRICS.filter(m => !unsupported.has(m));
                if (!want.length) break;
                const r = await graphInsights(conn.ig_user_id, want,
                    { period: 'day', metric_type: 'total_value', since: dayEpoch(day), until: dayEpoch(shiftDay(day, 1)) }, pageToken);
                r.unsupported.forEach(m => unsupported.add(m));
                const v = k => (r.values[k] === undefined ? null : (Array.isArray(r.values[k]) ? seriesSum(r.values[k]) : numOrNull(r.values[k])));
                igRows.push({ ...stamp, level: 'ig', day,
                    reach: v('reach'), views: v('views'), accounts_engaged: v('accounts_engaged'), interactions: v('total_interactions'),
                    profile_views: v('profile_views'), website_clicks: v('website_clicks'), follows: v('follower_count') });
                out.days += 1;
            }
            await metaDailyUpsert(igRows);
            out.ig = true;
            if (unsupported.size) out.warnings.push(`ig: ${[...unsupported].join(', ')} not available`);
        }

        await supabase.from('meta_connections').update({ daily_synced_at: now.toISOString(), daily_error: null }).eq('id', conn.id);
        return out;
    } catch (e) { return metaDailyFail(conn, e, out); }
}

/** The hourly pass: every active connection not read in the last 20 hours. */
let _dailyBusy = false;
async function metaDailyTick({ now = new Date(), limit = 10 } = {}) {
    if (!S.SCHEDULER_ENABLED || _dailyBusy || S._shuttingDown) return { due: 0, synced: 0, failed: 0, skipped: true };
    _dailyBusy = true;
    const out = { due: 0, synced: 0, failed: 0 };
    try {
        const { data } = await supabase.from('meta_connections').select('*').eq('status', 'active').limit(500);
        // Archived clients are not read (phase 57): archiving stops the work, as it does for schedules.
        const cids = [...new Set((data || []).map(c => c.client_id).filter(Boolean))];
        const { data: arch } = cids.length ? await supabase.from('clients').select('id').in('id', cids).eq('archived', true) : { data: [] };
        const archived = new Set((arch || []).map(c => c.id));
        const cutoff = now.getTime() - META_DAILY_EVERY_MS;
        const due = (data || []).filter(c => !archived.has(c.client_id) && (!c.daily_synced_at || Date.parse(c.daily_synced_at) < cutoff)).slice(0, limit);
        out.due = due.length;
        for (const conn of due) {
            const r = await metaDailySync(conn, { days: conn.daily_synced_at ? 3 : META_DAILY_FIRST_DAYS, now });
            if (r.ok) out.synced += 1; else out.failed += 1;
        }
        if (out.due) logger.info('meta_daily_tick', out);
    } catch (e) {
        logger.error('meta_daily_tick_failed', { message: e.message });
    } finally { _dailyBusy = false; }
    return out;
}

/**
 * Growth from a run of daily rows. Pure, so a test can hand it any days.
 *
 * Followers are compared with the latest row on or before N days ago — "on
 * or before" because one missed day must not turn a week's growth into
 * "unknown". Activity is summed over the last seven ended days against the
 * seven before. Anything with no baseline says so rather than computing a
 * percentage against nothing (pctDelta).
 */
function growthFrom(rows, today = new Date().toISOString().slice(0, 10)) {
    const days = (rows || []).filter(r => r && r.day).map(r => ({ ...r, day: (r.day instanceof Date ? r.day.toISOString() : String(r.day)).slice(0, 10) }))
        .sort((a, b) => a.day.localeCompare(b.day));
    if (!days.length) return { empty: true, days: 0, since: null, latest: null, today, followers: null, series: [] };

    const withF = days.filter(r => r.followers !== null && r.followers !== undefined);
    const nowRow = withF.length ? withF[withF.length - 1] : null;
    const at = n => { const cut = shiftDay(today, -n); for (let i = withF.length - 1; i >= 0; i--) if (withF[i].day <= cut) return withF[i]; return null; };
    const diff = (a, b) => (a && b && a !== b ? a.followers - b.followers : null);
    const pctOf = (a, b) => (a && b && a !== b ? S.pctDelta(a.followers, b.followers).pct : null);
    const sumWin = (key, from, to) => {
        let sum = 0, n = 0;
        for (const r of days) if (r.day >= from && r.day <= to && r[key] !== null && r[key] !== undefined) { sum += Number(r[key]) || 0; n += 1; }
        return n ? sum : null;
    };
    const win = key => {
        const now = sumWin(key, shiftDay(today, -7), shiftDay(today, -1));
        const before = sumWin(key, shiftDay(today, -14), shiftDay(today, -8));
        return { now, before, ...S.pctDelta(now, before) };
    };
    const d1 = at(1), d7 = at(7), d30 = at(30);
    return {
        empty: false, days: days.length, since: days[0].day, latest: days[days.length - 1].day, today,
        followers: nowRow ? {
            now: nowRow.followers, asOf: nowRow.day,
            day: diff(nowRow, d1), week: diff(nowRow, d7), month: diff(nowRow, d30),
            week_pct: pctOf(nowRow, d7), month_pct: pctOf(nowRow, d30)
        } : null,
        reach: win('reach'), views: win('views'), profile_views: win('profile_views'),
        interactions: win('interactions'), follows: win('follows'),
        series: days.slice(-30).map(r => ({
            day: r.day, followers: r.followers ?? null, reach: r.reach ?? null, views: r.views ?? null,
            profile_views: r.profile_views ?? null, interactions: r.interactions ?? null, follows: r.follows ?? null
        }))
    };
}

/** The daily rows of one connection (the one with the most rows, Instagram level first), as growth. */
async function growthForConnections(connIds, today = dayStr(new Date())) {
    const ids = (connIds || []).filter(Boolean);
    if (!ids.length) return { level: null, growth: growthFrom([], today) };
    const { data } = await supabase.from('meta_daily').select('*').in('connection_id', ids)
        .gte('day', shiftDay(today, -45)).order('day', { ascending: true }).limit(600);
    const rows = data || [];
    const level = rows.some(r => r.level === 'ig') ? 'ig' : 'page';
    const perConn = {};
    for (const r of rows) if (r.level === level) (perConn[r.connection_id] = perConn[r.connection_id] || []).push(r);
    const best = Object.values(perConn).sort((a, b) => b.length - a.length)[0] || [];
    return { level: best.length ? level : null, growth: growthFrom(best, today) };
}

/**
 * The connection a client is shown, and the one "sync now" reads: active over
 * not, with an Instagram account over without, with a token over without,
 * newest last. A business can end up with two rows — one from onboarding
 * before the Page was fully authorised, one from the real connection — and
 * the first row is not the right one.
 */
function primaryConnection(list) {
    return (list || []).slice().sort((a, b) =>
        ((b.status === 'active') - (a.status === 'active'))
        || ((!!b.ig_user_id) - (!!a.ig_user_id))
        || ((!!b.page_token_enc) - (!!a.page_token_enc))
        || String(b.created_at || '').localeCompare(String(a.created_at || '')))[0] || null;
}

async function growthPayload(connections, today = dayStr(new Date())) {
    const list = connections || [];
    const active = list.filter(c => c.status === 'active');
    const use = active.length ? active : list;
    const { level, growth } = await growthForConnections(use.map(c => c.id), today);
    const conn = primaryConnection(use);
    return {
        configured: metaConfigured(),
        connected: !!conn,
        connection: conn ? {
            id: conn.id, page_name: conn.page_name || null, ig_username: conn.ig_username || null, status: conn.status,
            daily_synced_at: conn.daily_synced_at || null, daily_error: conn.daily_error || null
        } : null,
        level, growth,
        source: 'meta_owner_insights'
    };
}

/** The client's own numbers. A client account is its business, so it is never asked which. */
app.get('/api/client/growth', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        if (ctx.profile.role !== 'client') return res.status(400).json({ error: 'This is the client view. Staff read growth from /api/meta/growth with a client.' });
        const own = await requireOwnClient(ctx, res); if (!own) return;
        const { data } = await supabase.from('meta_connections').select('*').eq('client_id', own.id).order('created_at', { ascending: false });
        res.json({ business: { id: own.id, name: own.name }, ...(await growthPayload(data || [])) });
    } catch (err) { sendErr(res, err); }
});

/** Staff: one connection, or every connection filed under a client the caller can read. */
app.get('/api/meta/growth', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        let conns;
        if (req.query.connection_id) {
            const c = await metaLoadConnection(ctx.user.id, String(req.query.connection_id));
            if (!c) return res.status(404).json({ error: 'Connection not found.' });
            conns = [c];
        } else {
            const cid = String(req.query.client_id || req.query.clientId || '');
            const c = cid ? await clientAccess(ctx.user.id, cid, 'viewer') : null;
            if (!c) return res.status(403).json({ error: 'No access to that client.' });
            const { data } = await supabase.from('meta_connections').select('*').eq('client_id', c.id).order('created_at', { ascending: false });
            conns = data || [];
        }
        res.json(await growthPayload(conns));
    } catch (err) { sendErr(res, err); }
});

/** Read the numbers now rather than waiting for the hourly pass. */
app.post('/api/meta/daily-sync', rateLimit({ windowMs: 60000, max: 4, key: bearerId }), async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        let conn = null;
        if (ctx.profile.role === 'client') {
            const own = await requireOwnClient(ctx, res); if (!own) return;
            const { data } = await supabase.from('meta_connections').select('*').eq('client_id', own.id).eq('status', 'active');
            conn = primaryConnection(data || []);
        } else {
            conn = await metaLoadConnection(ctx.user.id, String(req.body?.connectionId || ''));
        }
        if (!conn) return res.status(404).json({ error: 'No connected Meta account to read.' });
        const r = await metaDailySync(conn, { days: conn.daily_synced_at ? 3 : META_DAILY_FIRST_DAYS });
        const { data: fresh } = await supabase.from('meta_connections').select('*').eq('id', conn.id).maybeSingle();
        res.status(r.ok ? 200 : 502).json({ sync: r, ...(await growthPayload(fresh ? [fresh] : [conn])) });
    } catch (err) { sendErr(res, err); }
});

registerWorker('meta_insights', (userId, input, jobId) => async (progress, ck) => {
    const conn = await supabase.from('meta_connections').select('*').eq('id', input.connectionId).maybeSingle().then(r => r.data);
    if (!conn) throw new Error('Connection no longer exists.');
    const pageToken = decryptSecret(conn.page_token_enc);
    const days = input.days || 28;
    const until = Math.floor(Date.now() / 1000);
    const since = until - days * 86400;
    const today = new Date().toISOString().slice(0, 10);
    const gaps = [];
    const warnings = [];

    const fail = async (err) => {
        await supabase.from('meta_connections').update({
            status: err.statusCode === 401 ? 'expired' : 'error',
            last_error: String(err.message || '').slice(0, 300)
        }).eq('id', conn.id);
        throw err;
    };

    try {
        // --- Page account -------------------------------------------------
        await progress(5, `Reading Page insights for ${conn.page_name || conn.page_id}`);
        let page = ck.get('page');
        if (!page) {
            const meta = await graphGet(conn.page_id, { fields: 'id,name,fan_count,followers_count,category,link,about' }, pageToken);
            const ins = await graphInsights(conn.page_id,
                ['page_impressions_unique', 'page_post_engagements', 'page_views_total', 'page_fan_adds_unique', 'page_daily_follows_unique', 'page_media_view'],
                { period: 'day', since, until }, pageToken);
            gaps.push(...ins.unsupported.map(m => `page:${m}`));
            page = {
                id: meta.id, name: meta.name, fans: meta.fan_count ?? null, followers: meta.followers_count ?? null,
                category: meta.category || null, link: meta.link || null,
                series: ins.values,
                totals: Object.fromEntries(Object.entries(ins.values).map(([k, v]) => [k, seriesSum(v)]))
            };
            await supabase.from('meta_snapshots').upsert([{
                connection_id: conn.id, user_id: conn.user_id, snapshot_date: today, level: 'page',
                metrics: { fans: page.fans, followers: page.followers, totals: page.totals, days }
            }], { onConflict: 'connection_id,level,snapshot_date' });
            await ck.done('page', page);
        }

        // --- Page posts ----------------------------------------------------
        await progress(25, 'Reading Page posts');
        let pagePosts = ck.get('page_posts');
        if (!pagePosts) {
            pagePosts = [];
            const out = await graphGet(`${conn.page_id}/posts`, {
                fields: 'id,message,created_time,permalink_url,shares,reactions.summary(total_count),comments.summary(total_count),attachments{media_type}',
                since, until, limit: META_MEDIA_LIMIT
            }, pageToken);
            const items = out.data || [];
            const postMetrics = ['post_impressions_unique', 'post_engaged_users', 'post_clicks', 'post_reactions_by_type_total'];
            let unsupportedPost = null;
            for (let i = 0; i < items.length; i++) {
                const p = items[i];
                let insights = {}, unsupported = [];
                if (!unsupportedPost) {
                    const r = await graphInsights(p.id, postMetrics, {}, pageToken);
                    insights = r.values; unsupported = r.unsupported;
                    if (unsupported.length === postMetrics.length) unsupportedPost = unsupported;
                }
                const row = {
                    connection_id: conn.id, user_id: conn.user_id, platform: 'facebook',
                    media_id: String(p.id), shortcode: null,
                    media_type: p.attachments?.data?.[0]?.media_type || null, product_type: 'page_post',
                    caption: (p.message || '').slice(0, 4000) || null, permalink: p.permalink_url || null,
                    posted_at: p.created_time || null,
                    like_count: p.reactions?.summary?.total_count ?? null,
                    comments_count: p.comments?.summary?.total_count ?? null,
                    insights: { ...Object.fromEntries(Object.entries(insights).map(([k, v]) => [k, Array.isArray(v) ? seriesLast(v) : v])), shares: p.shares?.count ?? null, source: 'insights' }
                };
                pagePosts.push(row);
                if (i % 10 === 9) await progress(25 + Math.round(15 * (i / items.length)), `Page posts ${i + 1}/${items.length}`);
            }
            if (unsupportedPost) gaps.push(...unsupportedPost.map(m => `post:${m}`));
            if (pagePosts.length) await supabase.from('meta_media').upsert(pagePosts, { onConflict: 'connection_id,media_id' });
            await ck.done('page_posts', pagePosts);
        }

        // --- Instagram account --------------------------------------------
        let ig = ck.get('ig');
        let igMedia = ck.get('ig_media');
        if (conn.ig_user_id) {
            await progress(45, `Reading Instagram insights for @${conn.ig_username || conn.ig_user_id}`);
            if (!ig) {
                const meta = await graphGet(conn.ig_user_id, { fields: 'id,username,name,followers_count,follows_count,media_count,biography,website' }, pageToken);
                const day = await graphInsights(conn.ig_user_id,
                    ['reach', 'views', 'accounts_engaged', 'total_interactions', 'profile_views', 'website_clicks', 'follower_count'],
                    { period: 'day', metric_type: 'total_value', since, until }, pageToken);
                gaps.push(...day.unsupported.map(m => `ig:${m}`));
                const demo = {};
                for (const bd of ['age', 'gender', 'city', 'country']) {
                    try {
                        const d = await graphGet(`${conn.ig_user_id}/insights`, { metric: 'follower_demographics', period: 'lifetime', metric_type: 'total_value', breakdown: bd }, pageToken);
                        const res0 = d.data?.[0]?.total_value?.breakdowns?.[0]?.results || [];
                        demo[bd] = res0.map(r => ({ key: (r.dimension_values || []).join(' '), value: r.value })).sort((a, b) => b.value - a.value).slice(0, 12);
                    } catch (err) { if (err.statusCode === 401) throw err; gaps.push(`ig:follower_demographics:${bd}`); }
                }
                ig = {
                    id: meta.id, username: meta.username, name: meta.name || null,
                    followers: meta.followers_count ?? null, following: meta.follows_count ?? null, mediaCount: meta.media_count ?? null,
                    bio: meta.biography || null, website: meta.website || null,
                    totals: Object.fromEntries(Object.entries(day.values).map(([k, v]) => [k, Array.isArray(v) ? seriesSum(v) : v])),
                    series: day.values, demographics: demo
                };
                await supabase.from('meta_snapshots').upsert([{
                    connection_id: conn.id, user_id: conn.user_id, snapshot_date: today, level: 'ig',
                    metrics: { followers: ig.followers, following: ig.following, mediaCount: ig.mediaCount, totals: ig.totals, days, demographics: demo }
                }], { onConflict: 'connection_id,level,snapshot_date' });
                await ck.done('ig', ig);
            }

            await progress(60, 'Reading Instagram media insights');
            if (!igMedia) {
                igMedia = [];
                const out = await graphGet(`${conn.ig_user_id}/media`, {
                    fields: 'id,caption,media_type,media_product_type,timestamp,like_count,comments_count,permalink,shortcode,thumbnail_url,media_url',
                    limit: META_MEDIA_LIMIT
                }, pageToken);
                const items = out.data || [];
                const unsupportedByKind = {};
                for (let i = 0; i < items.length; i++) {
                    const m = items[i];
                    const kind = m.media_product_type === 'REELS' ? 'reel' : (m.media_type === 'CAROUSEL_ALBUM' ? 'carousel' : 'still');
                    const want = kind === 'reel'
                        ? ['reach', 'saved', 'shares', 'views', 'total_interactions', 'ig_reels_avg_watch_time', 'likes', 'comments']
                        : ['reach', 'saved', 'shares', 'views', 'total_interactions', 'likes', 'comments'];
                    const list = want.filter(x => !(unsupportedByKind[kind] || []).includes(x));
                    let insights = {};
                    if (list.length) {
                        const r = await graphInsights(m.id, list, {}, pageToken);
                        insights = Object.fromEntries(Object.entries(r.values).map(([k, v]) => [k, Array.isArray(v) ? seriesLast(v) : v]));
                        if (r.unsupported.length) unsupportedByKind[kind] = [...new Set([...(unsupportedByKind[kind] || []), ...r.unsupported])];
                    }
                    igMedia.push({
                        connection_id: conn.id, user_id: conn.user_id, platform: 'instagram',
                        media_id: String(m.id), shortcode: m.shortcode || igShortcodeFromPermalink(m.permalink),
                        media_type: m.media_type || null, product_type: m.media_product_type || null,
                        caption: (m.caption || '').slice(0, 4000) || null, permalink: m.permalink || null,
                        posted_at: m.timestamp || null, like_count: m.like_count ?? null, comments_count: m.comments_count ?? null,
                        insights: { ...insights, kind, source: 'insights' }
                    });
                    if (i % 10 === 9) await progress(60 + Math.round(25 * (i / items.length)), `Instagram media ${i + 1}/${items.length}`);
                }
                for (const [k, v] of Object.entries(unsupportedByKind)) gaps.push(...v.map(m => `ig_media:${k}:${m}`));
                if (igMedia.length) await supabase.from('meta_media').upsert(igMedia, { onConflict: 'connection_id,media_id' });
                await ck.done('ig_media', igMedia);
            }
        } else {
            warnings.push('This Page has no Instagram professional account linked, so only Page data was read.');
        }

        // --- Summary + narrative -------------------------------------------
        await progress(88, 'Building owner view');
        const byReach = (igMedia || []).filter(m => m.insights?.reach).sort((a, b) => (b.insights.reach || 0) - (a.insights.reach || 0));
        const bySaves = (igMedia || []).filter(m => m.insights?.saved).sort((a, b) => (b.insights.saved || 0) - (a.insights.saved || 0));
        const card = m => ({ id: m.media_id, shortcode: m.shortcode, kind: m.insights?.kind, permalink: m.permalink, postedAt: m.posted_at, caption: (m.caption || '').slice(0, 160), likes: m.like_count, comments: m.comments_count, reach: m.insights?.reach ?? null, saved: m.insights?.saved ?? null, shares: m.insights?.shares ?? null, views: m.insights?.views ?? null, interactions: m.insights?.total_interactions ?? null });
        const kindAgg = {};
        for (const m of (igMedia || [])) {
            const k = m.insights?.kind || 'unknown';
            const a = kindAgg[k] = kindAgg[k] || { n: 0, reach: [], saved: [], shares: [], views: [] };
            a.n += 1;
            for (const f of ['reach', 'saved', 'shares', 'views']) if (typeof m.insights?.[f] === 'number') a[f].push(m.insights[f]);
        }
        const kinds = Object.fromEntries(Object.entries(kindAgg).map(([k, a]) => [k, { n: a.n, medianReach: median(a.reach), medianSaved: median(a.saved), medianShares: median(a.shares), medianViews: median(a.views) }]));

        const summary = {
            page: page ? { name: page.name, fans: page.fans, followers: page.followers, totals: page.totals } : null,
            ig: ig ? { username: ig.username, followers: ig.followers, following: ig.following, mediaCount: ig.mediaCount, totals: ig.totals, demographics: ig.demographics } : null,
            windowDays: days,
            media: { count: (igMedia || []).length, kinds, topByReach: byReach.slice(0, 8).map(card), topBySaves: bySaves.slice(0, 5).map(card) },
            pagePosts: { count: (pagePosts || []).length, top: (pagePosts || []).slice().sort((a, b) => (b.insights?.post_impressions_unique || 0) - (a.insights?.post_impressions_unique || 0)).slice(0, 5).map(p => ({ id: p.media_id, permalink: p.permalink, caption: (p.caption || '').slice(0, 160), impressions: p.insights?.post_impressions_unique ?? null, engaged: p.insights?.post_engaged_users ?? null, reactions: p.like_count, comments: p.comments_count, shares: p.insights?.shares ?? null })) },
            gaps: [...new Set(gaps)],
            sources: { page: 'insights', ig: 'insights', media: 'insights', competitors: 'not available via Meta — use the scraped audit' }
        };

        await progress(92, 'Generating narrative');
        let ai = null, aiStatus = { ok: false, reason: 'no_key' };
        if (geminiAvailable()) {
            const { json } = budgetedJson(summary, { maxChars: 30000, keep: ['ig', 'page', 'gaps'] });
            const prompt =
`You are a social media strategist reading OWNER-SIDE Meta Insights for one account (numbers the public cannot see: reach, saves, shares, views, demographics). Window: last ${days} days.
${input.brief ? `Owner brief: ${input.brief}\n` : ''}
Data (JSON):
${json}

Reply with ONLY a JSON object:
{
 "executive_summary": "3-4 sentences, specific numbers, no fluff",
 "what_is_working": ["...", "..."],
 "what_is_not": ["...", "..."],
 "audience": "1-2 sentences from demographics, or 'not enough data' if empty",
 "saves_and_shares": "what the saved/shared posts have in common; name the post types",
 "next_30_days": ["action 1", "action 2", "action 3", "action 4"],
 "data_gaps": "one sentence on what could not be read (see gaps) and what that means"
}`;
            const r = await geminiCallDetailed(prompt, { temperature: 0.4, tag: 'Gemini Meta', userId });
            aiStatus = { ok: r.ok, reason: r.reason, message: r.ok ? 'Generated.' : aiReasonText(r.reason), model: r.model || null };
            ai = r.ok ? r.data : null;
        } else {
            aiStatus = { ok: false, reason: 'no_key', message: aiReasonText('no_key') };
        }
        if (!aiStatus.ok) warnings.push(`Narrative unavailable: ${aiStatus.message}`);

        await progress(96, 'Saving report');
        const payload = { summary, warnings, ai, aiStatus, generatedAt: new Date().toISOString(), connection: { id: conn.id, pageName: conn.page_name, igUsername: conn.ig_username } };
        const { data: saved } = await supabase.from('reports').insert([{
            user_id: userId,
            client_id: input.clientId || null,
            meta_connection_id: conn.id,
            platform: 'meta',
            report_type: 'meta_owned',
            target_handle: conn.ig_username || conn.page_name || conn.page_id,
            posts_analyzed: (igMedia || []).length + (pagePosts || []).length,
            snapshot_date: today,
            credits_estimate: 0,
            ai_summary: ai?.executive_summary || null,
            ai_json: ai || null,
            ai_status: aiStatus,
            report_json: payload
        }]).select('id').maybeSingle();

        await supabase.from('meta_connections').update({ status: 'active', last_sync_at: new Date().toISOString(), last_error: null }).eq('id', conn.id);
        return { reportId: saved?.id || null, reportRef: saved?.id || null, aiStatus, gaps: summary.gaps };
    } catch (err) {
        if (err.graph || err.statusCode === 401 || err.statusCode === 502) await fail(err);
        throw err;
    }
});

app.get('/api/meta/reports', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'meta_owned'); if (!ctx) return;
        let q = supabase.from('reports')
            .select('id, user_id, client_id, meta_connection_id, target_handle, posts_analyzed, snapshot_date, created_at, ai_summary, ai_status')
            .eq('platform', 'meta').eq('report_type', 'meta_owned');
        q = (await applyReportScope(req, ctx))(q);
        const { data, error } = await q.order('created_at', { ascending: false }).limit(100);
        if (error) throw error;
        res.json({ reports: data || [] });
    } catch (err) { sendErr(res, err); }
});

app.get('/api/meta/report/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'meta_owned'); if (!ctx) return;
        const { data } = await supabase.from('reports').select('*').eq('id', req.params.id).maybeSingle();
        if (!data || !(await canReadReport(ctx, data))) return res.status(404).json({ error: 'Report not found' });
        // A monthly report comes with its document (phase 34) and, for staff
        // who can see the client's board, which recommendations are on it.
        const view = S.monthlyView(data);
        if (view) {
            view.context = await S.monthlyContext(data);
            const c = data.client_id && ctx.profile?.role !== 'client' ? await clientAccess(ctx.user.id, data.client_id, 'viewer') : null;
            view.tasks = c ? { clientId: c.id, canEdit: ['owner', 'admin', 'editor'].includes(c.access), byKey: await S.monthlyBoard(data) } : null;
        }
        res.json({ report: data, view });
    } catch (err) { sendErr(res, err); }
});
