/**
 * Operations, system status, self-serve signup, admin users, trial and plan limits.
 *
 * Part of the EdgeLead server, split out of server.js (phase 55). The parts load in
 * order from server.js and share one namespace, S: what this part needs from an earlier
 * part is unpacked below; anything else from another part is read as S.name when it runs.
 */
'use strict';
const S = require('./shared');
const {
    ALERT_WEBHOOK, APIFY_CYCLE_CREDIT, APIFY_MEMORY_MB, APIFY_TIMEOUT_SECS, APP_VERSION, ApifyClient,
    BOOT_TS, BUDGET_MODE, COST_PER_1K_FB_POSTS, COST_PER_1K_POSTS, COST_PER_1K_PROFILE, EMAIL_RE, ENC_KEY,
    ENC_KEY_OLD, ENGINES, ENGINE_LABELS, FB_COMMENTS_ACTOR, FB_DEFAULT_DAYS, FB_DEFAULT_GROUPS,
    FB_DEFAULT_POSTS, FB_GROUP_POSTS_ACTOR, FB_SEARCH_ACTOR, GEMINI_API_KEY, GEMINI_MODEL, IG_SCORE_VERSION,
    MASTER_ADMIN_EMAIL, METRICS, QUOTA_FALLBACK, RECENT_EVENTS, SELF_URL, _authCache, _byoCache,
    _geminiDiscovered, _geminiPool, _primaryCreditCache, accountState, app, auth, bearerId,
    cleanPaymentOption, contactSettings, crypto, cycleMonth, cycleUsage, decryptSecret, effectiveCap,
    encryptSecret, enginePrimaryCredit, geminiAvailable, getEnginePrimary, getWorkingClient, invalidateAuth,
    invalidateEngineAccess, invalidateQuotaCaps, isByoOnly, logger, mailActivated, mailActivationRequested,
    mailSettings, mailStatus, markKey, maskSecret, primaryKeyName, publicLimit, quotaPeriod, rateLimit,
    requireAdmin, saveKeyRow, sendErr, sendMail, setEnginePrimary, supabase, tokenHash, trialDaysSetting
} = S;

// ===========================================================================
// PHASE 4 — OPERATIONS ENDPOINTS
// ===========================================================================

/**
 * The constants a report run is priced on, and which actor each one covers.
 * Adding a constant here is all it takes to bring it under validation.
 */
function costConstants() {
    return [
        { name: 'COST_PER_1K_POSTS',   env: 'COST_PER_1K_POSTS',   value: COST_PER_1K_POSTS,
          actors: ['apify/instagram-scraper'], unit: 'items' },
        { name: 'COST_PER_1K_PROFILE', env: 'COST_PER_1K_PROFILE', value: COST_PER_1K_PROFILE,
          actors: ['apify/instagram-profile-scraper'], unit: 'items' },
        { name: 'COST_PER_1K_FB_POSTS', env: 'COST_PER_1K_FB_POSTS', value: COST_PER_1K_FB_POSTS,
          actors: [FB_GROUP_POSTS_ACTOR, FB_SEARCH_ACTOR, FB_COMMENTS_ACTOR], unit: 'items' }
    ];
}

app.get('/api/admin/cost-reality', async (req, res) => {
    const ctx = await requireAdmin(req, res);
    if (!ctx) return;

    const days = Math.min(365, Math.max(1, parseInt(req.query.days || '90', 10)));
    const since = new Date(Date.now() - days * 86400000).toISOString();

    try {
        // Settled events only. A reservation row still carries the estimate,
        // and validating an estimate against itself would always agree.
        const { data: events, error } = await supabase.from('apify_usage_events')
            .select('actor_id, usage_usd, items, compute_units, created_at')
            .eq('is_reservation', false)
            .gt('usage_usd', 0)
            .gte('created_at', since)
            .limit(20000);

        if (error) throw new Error(error.message);

        const byActor = {};
        (events || []).forEach(e => {
            if (!e.actor_id) return;
            (byActor[e.actor_id] = byActor[e.actor_id] || []).push(e);
        });

        const actorRows = Object.entries(byActor).map(([actorId, evs]) => {
            const withItems = evs.filter(e => (e.items || 0) > 0);
            const perK = withItems.map(e => (Number(e.usage_usd) / e.items) * 1000);
            const totalUsd = evs.reduce((s, e) => s + Number(e.usage_usd || 0), 0);
            const totalItems = evs.reduce((s, e) => s + (e.items || 0), 0);

            return {
                actorId,
                runs: evs.length,
                runsWithItems: withItems.length,
                totalUsd: +totalUsd.toFixed(4),
                totalItems,
                // Median, not mean. One run that timed out after scraping four
                // items would otherwise set the constant for everything.
                medianUsdPer1k: perK.length ? +S.median(perK).toFixed(3) : null,
                meanUsdPer1k: perK.length ? +(perK.reduce((s, v) => s + v, 0) / perK.length).toFixed(3) : null,
                p90UsdPer1k: perK.length
                    ? +[...perK].sort((a, b) => a - b)[Math.min(perK.length - 1, Math.floor(perK.length * 0.9))].toFixed(3)
                    : null,
                blendedUsdPer1k: totalItems > 0 ? +((totalUsd / totalItems) * 1000).toFixed(3) : null
            };
        });

        const verdicts = costConstants().map(c => {
            const matched = actorRows.filter(a => c.actors.includes(a.actorId));
            const sample = matched.reduce((s, a) => s + a.runsWithItems, 0);
            const observed = matched.length
                ? +S.median(matched.map(a => a.medianUsdPer1k).filter(v => v != null)).toFixed(3)
                : null;

            const ratio = observed != null && c.value > 0 ? observed / c.value : null;
            const status =
                sample < 10          ? 'insufficient-data' :
                ratio == null        ? 'no-data' :
                ratio > 1.25         ? 'UNDER-ESTIMATING'  :   // runs cost more than we reserve
                ratio < 0.6          ? 'over-estimating'   :   // we reserve far more than we spend
                                       'ok';

            return {
                constant: c.name,
                env: c.env,
                configured: c.value,
                observedUsdPer1k: observed,
                ratio: ratio != null ? +ratio.toFixed(2) : null,
                sampleRuns: sample,
                status,
                // The number to actually put in the env var: the p90, not the
                // median. An estimate that is right half the time is an
                // estimate that pauses half the jobs it prices.
                suggested: matched.length
                    ? +Math.max(...matched.map(a => a.p90UsdPer1k || 0)).toFixed(2)
                    : null,
                note:
                    status === 'insufficient-data' ? `Only ${sample} settled runs with item counts in the last ${days} days — not enough to move a constant on.` :
                    status === 'UNDER-ESTIMATING'  ? 'Runs are costing more than the reservation. This is the direction that causes surprise budget exhaustion mid-job.' :
                    status === 'over-estimating'   ? 'Reserving well above actual. Jobs are being declined for budget they would never have used.' :
                    'Within tolerance.'
            };
        });

        res.json({
            windowDays: days,
            settledEvents: (events || []).length,
            // The whole point of the endpoint, stated plainly.
            summary: verdicts.filter(v => v.status === 'UNDER-ESTIMATING' || v.status === 'over-estimating')
                .map(v => `${v.constant}: configured ${v.configured}, observed ${v.observedUsdPer1k} (${v.ratio}x) — suggest ${v.suggested}`),
            allWithinTolerance: verdicts.every(v => v.status === 'ok' || v.status === 'insufficient-data'),
            constants: verdicts,
            actors: actorRows.sort((a, b) => b.totalUsd - a.totalUsd)
        });
    } catch (e) {
        logger.error('cost_reality_failed', { message: e.message });
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/rotate-encryption-key', async (req, res) => {
    const ctx = await requireAdmin(req, res);
    if (!ctx) return;

    // Master admin only. This one touches every credential in the system.
    if (!MASTER_ADMIN_EMAIL || (ctx.user.email || '').toLowerCase() !== MASTER_ADMIN_EMAIL) {
        return res.status(403).json({ error: 'Key rotation is restricted to the master admin.' });
    }

    const dryRun = req.body?.confirm !== 'rotate';
    try {
        const report = await S.rotateEncryptionKey({ dryRun });
        res.status(report.error ? 400 : 200).json(report);
    } catch (e) {
        logger.error('rotate_key_failed', { message: e.message });
        res.status(500).json({ error: e.message });
    }
});

// ===========================================================================
// SYSTEM
// ===========================================================================

app.get('/api/health', (req, res) => res.json({
    ok: true,
    ts: new Date().toISOString(),
    version: APP_VERSION,
    uptimeSecs: Math.round((Date.now() - BOOT_TS) / 1000),
    encryptionAtRest: !!ENC_KEY,
    rotationPending: !!ENC_KEY_OLD,
    keepAlive: !!SELF_URL,
    igScoreVersion: IG_SCORE_VERSION,
    instance: S.INSTANCE_ID,
    instances: METRICS.instances || null,
    scheduler: S.SCHEDULER_ENABLED,
    ai: { model: GEMINI_MODEL, discovered: _geminiDiscovered.models.slice(0, 3), poolKeys: _geminiPool.rows.length, envKey: !!GEMINI_API_KEY, configured: geminiAvailable(), ok: METRICS.ai.ok, failed: METRICS.ai.failed, truncated: METRICS.ai.truncated },
    // Whether the Meta app credentials are set at all. Booleans and the API
    // version only — no ids, no secret. This was invisible from outside, which
    // made "is Meta connected up?" unanswerable without signing in, and that
    // is the first question anyone asks when the owner assistant says it has
    // no owner numbers. `configured` says the server CAN start an OAuth
    // handshake; it says nothing about whether the Meta app has passed review,
    // which is what decides if anyone outside your dev/tester list can finish one.
    meta: { configured: S.metaConfigured(), graphVersion: S.META_GRAPH_VERSION, scopes: S.META_SCOPES.length },
    budgetMode: BUDGET_MODE
}));

/**
 * Everything you need to answer "is it quietly burning money or quietly
 * broken". Admin only: it exposes spend and key health.
 */
app.get('/api/admin/metrics', async (req, res) => {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        const month = String(req.query.month || cycleMonth());

        const [{ data: jobRows }, { data: usageRows }, { data: keyRows }] = await Promise.all([
            supabase.from('jobs').select('status').limit(2000),
            supabase.from('apify_usage_events')
                .select('engine, usage_usd, apify_username, items, actor_id, is_reservation')
                .eq('cycle_month', month).limit(5000),
            supabase.from('apify_keys')
                .select('status, engine, owner_user_id, apify_username, label, monthly_credit_usd, token_hash')
        ]);

        const jobsByStatus = {};
        (jobRows || []).forEach(j => { jobsByStatus[j.status] = (jobsByStatus[j.status] || 0) + 1; });

        const spendByEngine = {}, spendByKey = {}, runsByActor = {};
        let totalSpend = 0, totalItems = 0, reservedUsd = 0, openReservations = 0;
        (usageRows || []).forEach(u => {
            const usd = Number(u.usage_usd || 0);
            // A reservation is credit claimed by a run still in flight. It is
            // committed against the budget but has not settled, so it is
            // reported separately rather than folded into actual spend.
            if (u.is_reservation) { reservedUsd += usd; openReservations += 1; return; }
            totalSpend += usd;
            totalItems += Number(u.items || 0);
            spendByEngine[u.engine || 'unknown'] = +((spendByEngine[u.engine || 'unknown'] || 0) + usd).toFixed(4);
            spendByKey[u.apify_username || 'unknown'] = +((spendByKey[u.apify_username || 'unknown'] || 0) + usd).toFixed(4);
            const a = runsByActor[u.actor_id || 'unknown'] || { runs: 0, usd: 0, items: 0 };
            a.runs += 1; a.usd = +(a.usd + usd).toFixed(4); a.items += Number(u.items || 0);
            runsByActor[u.actor_id || 'unknown'] = a;
        });

        const keysByStatus = {};
        (keyRows || []).forEach(k => { keysByStatus[k.status] = (keysByStatus[k.status] || 0) + 1; });

        // What each key is allowed to spend against what it has spent. This is
        // the view that answers "are we about to run out" before a job pauses.
        const keyBudgets = [];
        for (const k of (keyRows || [])) {
            const credit = Number(k.monthly_credit_usd) > 0 ? Number(k.monthly_credit_usd) : APIFY_CYCLE_CREDIT;
            const spent = k.token_hash ? await cycleUsage(k.token_hash, month) : 0;
            keyBudgets.push({
                label: k.apify_username || k.label || 'unnamed',
                engine: k.engine, status: k.status,
                scope: k.owner_user_id ? 'personal' : 'shared',
                creditUsd: +credit.toFixed(2),
                spentUsd: +spent.toFixed(4),
                remainingUsd: +Math.max(0, credit - spent).toFixed(4)
            });
        }
        keyBudgets.sort((a, b) => b.remainingUsd - a.remainingUsd);

        // Real cost per 1k rows this cycle. This is the number the estimate
        // constants in env are supposed to approximate — compare them.
        const actualPer1k = totalItems ? +((totalSpend / totalItems) * 1000).toFixed(3) : null;

        res.json({
            ts: new Date().toISOString(),
            version: APP_VERSION,
            uptimeSecs: Math.round((Date.now() - BOOT_TS) / 1000),
            cycle: month,
            config: {
                budgetMode: BUDGET_MODE,
                creditPerKeyUsd: APIFY_CYCLE_CREDIT,
                encryptionAtRest: !!ENC_KEY,
                alertWebhook: !!ALERT_WEBHOOK,
                geminiModel: GEMINI_MODEL,
                memoryMb: APIFY_MEMORY_MB,
                timeoutSecs: APIFY_TIMEOUT_SECS,
                estimateConstants: {
                    COST_PER_1K_POSTS,
                    COST_PER_1K_PROFILE,
                    COST_PER_1K_FB_POSTS
                },
                fbDefaults: {
                    postsPerGroup: FB_DEFAULT_POSTS,
                    groups: FB_DEFAULT_GROUPS,
                    daysWindow: FB_DEFAULT_DAYS
                }
            },
            counters: {
                ...METRICS,
                apify: { ...METRICS.apify, usd: +METRICS.apify.usd.toFixed(4) }
            },
            spend: {
                totalUsd: +totalSpend.toFixed(4),
                totalItems,
                actualCostPer1kItems: actualPer1k,
                reservedUsd: +reservedUsd.toFixed(4),
                openReservations,
                byEngine: spendByEngine,
                byKey: spendByKey,
                byActor: runsByActor
            },
            jobs: jobsByStatus,
            keys: { byStatus: keysByStatus, total: (keyRows || []).length, budgets: keyBudgets },
            recentEvents: RECENT_EVENTS.slice(-40)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ===========================================================================
// SELF-SERVE SIGNUP SUPPORT  (phase 13)
//
// The signup itself happens in the browser against Supabase Auth, because
// that is what sends the confirmation email — and email confirmation is the
// thing standing between a 7-day trial on the shared Apify pool and someone
// farming it with addresses they do not own. The server's part is this
// precheck, plus ensureProfile() minting the account as a trial client on
// first login.
// ===========================================================================

const SIGNUP_MIN_PASSWORD = parseInt(process.env.SIGNUP_MIN_PASSWORD || '10', 10);

/**
 * HaveIBeenPwned range lookup, k-anonymity: SHA-1 the password, send the first
 * five hex characters, match the remaining 35 locally. The password itself
 * never leaves this process and HIBP never learns which hash we wanted.
 *
 * Supabase does this natively, but only on Pro plans, so we do it ourselves.
 *
 * Fails OPEN. A breach checker that takes signup down whenever a third party
 * is slow costs more than the checks it would have caught, and Supabase still
 * enforces minimum length underneath us.
 */
async function isLeakedPassword(password) {
    try {
        const sha1   = crypto.createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
        const prefix = sha1.slice(0, 5);
        const suffix = sha1.slice(5);

        const r = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
            headers: { 'Add-Padding': 'true' },
            signal: AbortSignal.timeout ? AbortSignal.timeout(3500) : undefined
        });
        if (!r.ok) return false;

        for (const line of (await r.text()).split('\n')) {
            const [hash, count] = line.trim().split(':');
            if (hash === suffix && parseInt(count || '0', 10) > 0) return true;
        }
        return false;
    } catch (e) {
        logger.warn('hibp_unavailable', { message: e.message });
        return false;
    }
}

/**
 * Called by the signup page before it hands the password to Supabase.
 *
 * Advisory by nature — anything client-side can be skipped by not being a
 * browser. It is still worth having: it protects everyone who uses the form,
 * and the floor that cannot be bypassed (minimum length) is enforced by
 * Supabase Auth itself.
 *
 * Rate limited hard. This endpoint takes a plaintext password from an
 * unauthenticated caller, so it must not become an oracle to grind against.
 */
app.post('/api/public/signup/password-check',
    rateLimit({ windowMs: 60000, max: 10 }),
    async (req, res) => {
        const password = String(req.body?.password || '');
        if (password.length < SIGNUP_MIN_PASSWORD) {
            return res.json({
                ok: false,
                reason: 'too_short',
                error: `Use at least ${SIGNUP_MIN_PASSWORD} characters.`
            });
        }
        if (await isLeakedPassword(password)) {
            return res.json({
                ok: false,
                reason: 'breached',
                error: 'That password has appeared in a known data breach. Pick a different one.'
            });
        }
        res.json({ ok: true });
    });

/**
 * "I want to keep going." (phase 26)
 *
 * Reachable by a trial client at any time and by a LAPSED client — the one
 * route that is. It records the wish on the account; the admin sees it as
 * "wants to continue", first in the list, with the activation control next
 * to it. Nothing is paid here; money is collected out of band by decision.
 */
app.post('/api/me/request-activation', rateLimit({ windowMs: 60000, max: 5, key: bearerId }), async (req, res) => {
    try {
        const ctx = await auth(req, res, { allowLapsed: true }); if (!ctx) return;
        if (ctx.profile.role !== 'client') return res.status(400).json({ error: 'Only a client account asks to continue.' });
        const note = String(req.body?.note || '').trim().slice(0, 500) || null;
        const now = new Date().toISOString();
        const { error } = await supabase.from('app_users')
            .update({ activation_requested_at: now, activation_note: note, updated_at: now }).eq('id', ctx.user.id);
        if (error) throw error;
        // The auth cache holds the old profile for a minute; the next /api/me
        // must show the request as sent.
        for (const [k, v] of _authCache) if (v.ctx?.user?.id === ctx.user.id) _authCache.delete(k);
        logger.info('activation_requested', { userId: ctx.user.id, state: accountState(ctx.profile) });
        // The agency hears about it by mail, if mail is set up. Not awaited:
        // an SMTP hiccup is not the client's problem.
        mailActivationRequested(ctx, note).catch(e => logger.warn('mail_activation_requested_failed', { message: e.message }));
        res.json({ success: true, requestedAt: now, email: ctx.user.email || null });
    } catch (err) { sendErr(res, err); }
});

app.get('/api/me', async (req, res) => {
    const ctx = await auth(req, res); if (!ctx) return;
    const { data: access } = await supabase.from('user_engine_access')
        .select('engine').eq('user_id', ctx.user.id);

    const state = accountState(ctx.profile);
    const body = {
        id: ctx.user.id,
        email: ctx.user.email,
        role: ctx.profile.role,
        engines: ctx.profile.role === 'admin' ? ENGINES : (access || []).map(a => a.engine),
        state
    };

    // Only a client needs a window and an allowance on screen. An employee
    // seeing "0 of 50 leads" would just be confusing.
    if (ctx.profile.role === 'admin') {
        // What is waiting for them, so the sidebar can say so without a
        // trip to the admin page.
        const { count } = await supabase.from('app_users').select('id', { count: 'exact', head: true })
            .eq('role', 'client').not('activation_requested_at', 'is', null);
        body.pendingActivations = count || 0;
    }
    // Staff (not admins, not owners) are reminded until they have added their own Apify and AI keys.
    if (ctx.profile.role !== 'admin' && ctx.profile.role !== 'client') {
        const [{ data: ak }, { data: gk }] = await Promise.all([
            supabase.from('apify_keys').select('id').eq('owner_user_id', ctx.user.id).eq('status', 'active').limit(1),
            supabase.from('gemini_keys').select('id').eq('owner_user_id', ctx.user.id).neq('status', 'invalid').limit(1)
        ]);
        body.ownKeys = { apify: !!(ak && ak.length), ai: !!(gk && gk.length) };
    }

    if (ctx.profile.role === 'client') {
        const own = await S.ownClientFor(ctx).catch(() => null);
        body.business = own ? { id: own.id, name: own.name, ig_handle: own.ig_handle || null } : null;
        // An owner login the agency made: no trial clock, and no business means access has ended.
        body.agency_owner = ctx.profile.agency_owner === true;
        // Phase 56: why there is no business — a trial that ran out says so, with the date.
        if (!own && body.agency_owner) body.trial_ended = await S.endedTrialFor(ctx.user.id).catch(() => null);
        body.activation_requested_at = ctx.profile.activation_requested_at || null;
        body.trial_ends_at = ctx.profile.trial_ends_at || null;
        body.paid_until    = ctx.profile.paid_until || null;
        body.plan_label    = ctx.profile.plan_label || null;
        // An owner only sees the key controls when an admin has made their
        // runs spend their own Apify credit (phase 34); otherwise it is jargon.
        body.ownKey        = await isByoOnly(ctx.user.id);

        if (state === 'trial' || state === 'paid') {
            const period = quotaPeriod(state);
            const { data: rows } = await supabase.from('usage_counters')
                .select('metric, used').eq('user_id', ctx.user.id).eq('period', period);

            const used = Object.fromEntries((rows || []).map(r => [r.metric, Number(r.used)]));
            body.usage = {};
            // The four caps at once, not one after another (phase 54): /api/me is on every page load.
            const METRICS_SHOWN = ['ig_report', 'fb_group_audit', 'leads', 'usd'];
            const caps = await Promise.all(METRICS_SHOWN.map(m => effectiveCap(ctx.user.id, state, m)));
            for (const [i, metric] of METRICS_SHOWN.entries()) {
                const cap = caps[i];
                body.usage[metric] = {
                    used: used[metric] || 0,
                    cap: cap === null ? null : cap,
                    remaining: cap === null ? null : Math.max(0, cap - (used[metric] || 0))
                };
            }
        }
    }

    res.json(body);
});

/**
 * Connectivity badge. Authenticated, because it discloses the Apify username.
 *
 * This is called on every page load by every user. It used to run a database
 * write and a live round trip to Apify each time, which cost latency on the
 * free tier and — worse — mutated key status as a side effect of somebody
 * merely looking at a page. It is now cached per user + engine, and the
 * expensive path only runs on a miss or when explicitly refreshed.
 */
const _statusCache = new Map();
S._statusCache = _statusCache;
const STATUS_TTL_MS = parseInt(process.env.ACTOR_STATUS_TTL_MS || '120000', 10);

setInterval(() => {
    const now = Date.now();
    for (const [k, v] of _statusCache) if (now - v.t > STATUS_TTL_MS * 4) _statusCache.delete(k);
}, 600000).unref?.();

app.get('/api/actor-status', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const engine = ENGINES.includes(req.query.engine) ? req.query.engine : 'leadgen';
        const cacheKey = ctx.user.id + ':' + engine;
        const force = req.query.refresh === '1' || req.query.refresh === 'true';

        const hit = _statusCache.get(cacheKey);
        if (!force && hit && Date.now() - hit.t < STATUS_TTL_MS) {
            return res.status(200).json({ ...hit.v, cached: true });
        }

        let payload;
        try {
            const { apifyUsername, candidate, budget } = await getWorkingClient(engine, ctx.user.id);
            payload = {
                active: true, username: apifyUsername, engine,
                source: candidate.source,
                remainingUsd: budget ? +Math.max(0, budget.remaining).toFixed(2) : null
            };
        } catch (err) {
            payload = {
                active: false, engine,
                error: err.code === 'NO_CREDIT' ? 'No credit' : 'Invalid/Expired Key'
            };
        }

        _statusCache.set(cacheKey, { v: payload, t: Date.now() });
        res.status(200).json(payload);
    } catch (err) {
        res.status(200).json({ active: false, error: 'Invalid/Expired Key' });
    }
});

// Primary per-engine key. Changeable at any time, never deletable.
app.post('/api/update-apify-key', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;

        const { newApiKey, engine } = req.body;
        if (!newApiKey) return res.status(400).json({ error: 'Key required' });
        // A personal key may pay for all of that person's work ('any'); an admin's key is an engine's primary.
        const activeEngine = engine === 'any' && ctx.profile.role !== 'admin' ? 'any' : ENGINES.includes(engine) ? engine : 'leadgen';

        const apifyUser = await new ApifyClient({ token: newApiKey }).user().get();

        const requester = { id: ctx.user.id, role: ctx.profile.role };

        if (ctx.profile.role === 'admin') {
            // Demote the outgoing primary into the global pool instead of
            // discarding it. Apify credit renews monthly, so a key that is dry
            // today is worth $5 again in a few weeks — throwing it away leaks
            // budget every single rotation.
            const previous = await getEnginePrimary(activeEngine);
            if (previous && previous !== newApiKey) {
                try {
                    await saveKeyRow(previous, {
                        ownerUserId: null,
                        engine: activeEngine,
                        label: `demoted primary (${activeEngine})`,
                        status: 'exhausted',
                        requester
                    });
                } catch (e) { logger.warn('demote_primary_failed', { message: e.message }); }
            }

            await setEnginePrimary(activeEngine, newApiKey);
        } else {
            // Non-admins set their own personal key for that engine. saveKeyRow
            // refuses if that token is already registered to somebody else.
            await saveKeyRow(newApiKey, {
                ownerUserId: ctx.user.id,
                engine: activeEngine,
                label: 'personal',
                apifyUsername: apifyUser.username,
                requester
            });
        }
        _byoCache.delete(ctx.user.id);
        _primaryCreditCache.clear();
        for (const k of [..._statusCache.keys()]) {
            if (k.startsWith(ctx.user.id + ':')) _statusCache.delete(k);
        }

        res.status(200).json({
            success: true,
            message: 'Apify key verified and saved.',
            username: apifyUser.username,
            engine: activeEngine,
            scope: ctx.profile.role === 'admin' ? 'engine_primary' : 'personal'
        });
    } catch (err) {
        if (err.code === 'KEY_CONFLICT') return res.status(409).json({ error: err.message });
        res.status(400).json({ error: 'Key verification failed: ' + err.message });
    }
});

// --- Key pool -------------------------------------------------------------

app.get('/api/apify-keys', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const isAdmin = ctx.profile.role === 'admin';

        let q = supabase.from('apify_keys')
            .select('id, owner_user_id, engine, label, apify_username, status, fail_count, last_used_at, created_at, monthly_credit_usd, token_hash')
            .order('created_at', { ascending: false });

        if (!isAdmin) q = q.eq('owner_user_id', ctx.user.id);

        const { data, error } = await q;
        if (error) throw error;

        const primaries = {};
        for (const e of ENGINES) {
            const v = await getEnginePrimary(e);
            primaries[e] = v
                ? {
                    configured: true,
                    masked: maskSecret(v),
                    creditUsd: await enginePrimaryCredit(e),
                    spentUsd: +(await cycleUsage(tokenHash(v))).toFixed(4)
                  }
                : { configured: false, creditUsd: await enginePrimaryCredit(e) };
        }

        // Live spend per key, so the admin screen shows what is left rather
        // than only what is configured.
        const month = cycleMonth();
        const keys = [];
        for (const k of (data || [])) {
            const credit = Number(k.monthly_credit_usd) > 0 ? Number(k.monthly_credit_usd) : APIFY_CYCLE_CREDIT;
            const spent = k.token_hash ? await cycleUsage(k.token_hash, month) : 0;
            const { token_hash, ...safe } = k;
            keys.push({
                ...safe,
                creditUsd: +credit.toFixed(2),
                spentUsd: +spent.toFixed(4),
                remainingUsd: +Math.max(0, credit - spent).toFixed(4)
            });
        }

        res.json({ keys, primaries, defaultCreditUsd: APIFY_CYCLE_CREDIT, cycleMonth: month });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/apify-keys', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const { token, engine, label, global: isGlobal } = req.body;
        if (!token) return res.status(400).json({ error: 'Token required' });

        const eng = [...ENGINES, 'any'].includes(engine) ? engine : 'any';
        const apifyUser = await new ApifyClient({ token }).user().get();
        const owner = (isGlobal && ctx.profile.role === 'admin') ? null : ctx.user.id;

        const data = await saveKeyRow(token, {
            ownerUserId: owner,
            engine: eng,
            label: label || apifyUser.username,
            apifyUsername: apifyUser.username,
            requester: { id: ctx.user.id, role: ctx.profile.role }
        });

        res.json({ success: true, key: data });
    } catch (err) {
        if (err.code === 'KEY_CONFLICT') return res.status(409).json({ error: err.message });
        res.status(400).json({ error: 'Key rejected: ' + err.message });
    }
});

app.post('/api/apify-keys/:id/recheck', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        let q = supabase.from('apify_keys').select('*').eq('id', req.params.id);
        if (ctx.profile.role !== 'admin') q = q.eq('owner_user_id', ctx.user.id);
        const { data: key } = await q.maybeSingle();
        if (!key) return res.status(404).json({ error: 'Key not found' });

        try {
            const u = await new ApifyClient({ token: decryptSecret(key.token) }).user().get();
            await markKey(key.id, { status: 'active', fail_count: 0, apify_username: u.username, last_checked_at: new Date().toISOString() });
            res.json({ success: true, status: 'active', username: u.username });
        } catch (e) {
            await markKey(key.id, { status: 'invalid', last_checked_at: new Date().toISOString() });
            res.json({ success: false, status: 'invalid', error: e.message });
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * Per-key cycle credit.
 *
 * The single global APIFY_MONTHLY_CREDIT_USD capped everybody at the free-tier
 * $5, including a customer paying Apify $49 a month. Raising the env var lifted
 * the ceiling for every key at once, including the free ones, which is the
 * wrong lever. A limit now lives on the key it describes.
 */
app.patch('/api/apify-keys/:id', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const patch = {};

        if (req.body.monthlyCreditUsd !== undefined) {
            const n = parseFloat(req.body.monthlyCreditUsd);
            if (!(n >= 0) || n > 10000) return res.status(400).json({ error: 'Enter a credit limit between 0 and 10000.' });
            patch.monthly_credit_usd = n || null;      // null falls back to the default
        }
        if (req.body.label !== undefined)  patch.label  = String(req.body.label).slice(0, 120) || null;
        if (req.body.status !== undefined && ctx.profile.role === 'admin') {
            if (!['active', 'exhausted', 'invalid'].includes(req.body.status)) {
                return res.status(400).json({ error: 'Unknown status.' });
            }
            patch.status = req.body.status;
            if (req.body.status === 'active') patch.fail_count = 0;
        }
        if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update.' });

        let q = supabase.from('apify_keys').update(patch).eq('id', req.params.id);
        if (ctx.profile.role !== 'admin') q = q.eq('owner_user_id', ctx.user.id);

        const { data, error } = await q
            .select('id, engine, label, apify_username, status, monthly_credit_usd').maybeSingle();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Key not found.' });

        logger.info('key_limit_updated', { keyId: data.id, by: ctx.user.id, patch: Object.keys(patch) });
        res.json({ success: true, key: data });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/** Cycle credit for an engine primary key, which has no row in apify_keys. */
app.patch('/api/admin/engine-credit', async (req, res) => {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        const { engine, monthlyCreditUsd } = req.body;
        if (!ENGINES.includes(engine)) return res.status(400).json({ error: 'Unknown engine.' });
        const n = parseFloat(monthlyCreditUsd);
        if (!(n > 0) || n > 10000) return res.status(400).json({ error: 'Enter a credit limit between 0 and 10000.' });

        await supabase.from('system_settings').upsert({
            key: primaryKeyName(engine) + '_credit_usd',
            value: String(n),
            updated_at: new Date().toISOString()
        }, { onConflict: 'key' });

        _primaryCreditCache.clear();
        res.json({ success: true, engine, monthlyCreditUsd: n });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/apify-keys/:id', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        let q = supabase.from('apify_keys').delete().eq('id', req.params.id);
        if (ctx.profile.role !== 'admin') q = q.eq('owner_user_id', ctx.user.id);
        const { error } = await q;
        if (error) throw error;
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===========================================================================
// ADMIN: USER MANAGEMENT
// ===========================================================================

// ===========================================================================
// TRIAL AND PLAN LIMITS (phase 21)
//
// These three settings decide what a trial gets, what a paying client gets,
// and how long a trial lasts. The server has read them from system_settings
// since phase 13 and enforced them on every run — and there has never been a
// way to change them except by writing SQL against production.
//
// That is the same fault as the engine checkboxes: a capability the server
// enforces that no human can reach. It is worse here, because the person who
// most needs to change a trial cap is the person least likely to be holding a
// psql prompt.
// ===========================================================================

/** The metrics a cap can be set on. Anything else is ignored rather than stored. */
const QUOTA_METRICS = [
    { key: 'ig_report',      label: 'Instagram reports',   kind: 'count' },
    { key: 'fb_group_audit', label: 'Group audits',        kind: 'count' },
    { key: 'leads',          label: 'Leads',               kind: 'count' },
    { key: 'usd',            label: 'Apify spend ceiling', kind: 'usd'   }
];

/** Public: what a client — signed in, lapsed, or reading the privacy page — needs to reach us or pay. */
app.get('/api/public/contact', publicLimit, async (req, res) => {
    try { res.json(await contactSettings()); } catch (err) { sendErr(res, err); }
});

app.get('/api/admin/settings', async (req, res) => {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        const keys = ['trial_days', 'trial_caps', 'client_monthly_caps'];
        const { data } = await supabase.from('system_settings').select('key, value').in('key', keys);
        const raw = Object.fromEntries((data || []).map(r => [r.key, r.value]));

        const parse = (v, fallback) => {
            try { const p = v ? JSON.parse(v) : null; return (p && typeof p === 'object') ? p : fallback; }
            catch { return fallback; }
        };
        const days = parseInt(raw.trial_days ?? '', 10);

        res.json({
            trialDays: Number.isFinite(days) && days > 0 && days <= 365 ? days : 7,
            trialCaps: parse(raw.trial_caps, QUOTA_FALLBACK.trial),
            clientMonthlyCaps: parse(raw.client_monthly_caps, QUOTA_FALLBACK.paid),
            metrics: QUOTA_METRICS,
            fallbacks: QUOTA_FALLBACK,
            ...(await contactSettings().then(c => ({ contactEmail: c.email, paymentOptions: c.paymentOptions }))),
            mail: await mailStatus(),
            // Says out loud when a value is the built-in fallback rather than
            // something anyone chose, so an unset limit does not look decided.
            stored: { trial_days: raw.trial_days != null, trial_caps: raw.trial_caps != null, client_monthly_caps: raw.client_monthly_caps != null }
        });
    } catch (err) { sendErr(res, err); }
});

app.patch('/api/admin/settings', async (req, res) => {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;

        const cleanCaps = obj => {
            if (!obj || typeof obj !== 'object') return null;
            const out = {};
            for (const m of QUOTA_METRICS) {
                const v = obj[m.key];
                if (v === null || v === '') { out[m.key] = null; continue; }   // null = unlimited
                const n = Number(v);
                if (!Number.isFinite(n) || n < 0) continue;                    // junk is dropped, not stored
                out[m.key] = m.kind === 'usd' ? Math.round(n * 100) / 100 : Math.floor(n);
            }
            return Object.keys(out).length ? out : null;
        };

        const writes = [];
        if (req.body.trialDays !== undefined) {
            const d = parseInt(req.body.trialDays, 10);
            if (!Number.isFinite(d) || d < 1 || d > 365) {
                return res.status(400).json({ error: 'Trial length must be between 1 and 365 days.' });
            }
            writes.push({ key: 'trial_days', value: String(d) });
        }
        for (const [field, key] of [['trialCaps', 'trial_caps'], ['clientMonthlyCaps', 'client_monthly_caps']]) {
            if (req.body[field] === undefined) continue;
            const caps = cleanCaps(req.body[field]);
            if (!caps) return res.status(400).json({ error: `No usable values for ${key}.` });
            writes.push({ key, value: JSON.stringify(caps) });
        }
        if (req.body.contactEmail !== undefined) {
            const email = String(req.body.contactEmail || '').trim().toLowerCase().slice(0, 120);
            if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                return res.status(400).json({ error: 'That does not look like an email address.' });
            }
            writes.push({ key: 'contact_email', value: email });
        }
        if (req.body.paymentOptions !== undefined) {
            const list = Array.isArray(req.body.paymentOptions) ? req.body.paymentOptions : [];
            const cleaned = [];
            for (const o of list.slice(0, 6)) {
                const c = cleanPaymentOption(o);
                if (c && c.error) return res.status(400).json({ error: c.error });
                if (c) cleaned.push(c);
            }
            writes.push({ key: 'payment_options', value: JSON.stringify(cleaned) });
        }
        if (req.body.mail !== undefined) {
            const m = req.body.mail && typeof req.body.mail === 'object' ? req.body.mail : {};
            if (m.from !== undefined) {
                const from = String(m.from || '').trim().toLowerCase().slice(0, 120);
                if (from && !EMAIL_RE.test(from)) return res.status(400).json({ error: 'The sending address does not look like an email address.' });
                writes.push({ key: 'mail_from', value: from });
            }
            if (m.notifyTo !== undefined) {
                const to = String(m.notifyTo || '').trim().toLowerCase().slice(0, 120);
                if (to && !EMAIL_RE.test(to)) return res.status(400).json({ error: 'The notification address does not look like an email address.' });
                writes.push({ key: 'mail_notify_to', value: to });
            }
            if (m.fromName !== undefined) writes.push({ key: 'mail_from_name', value: String(m.fromName || '').trim().slice(0, 60) });
            if (m.appPassword !== undefined) {
                // Google shows an app password as four groups of four; the
                // spaces are display only.
                const pw = String(m.appPassword || '').replace(/\s+/g, '');
                if (pw && pw.length < 8) return res.status(400).json({ error: 'That app password looks too short — Google shows it as four groups of four characters.' });
                writes.push({ key: 'mail_app_password', value: pw ? encryptSecret(pw) : '' });
            }
            S._mailTransport = null;
        }
        if (!writes.length) return res.status(400).json({ error: 'Nothing to change.' });

        const now = new Date().toISOString();
        const { error } = await supabase.from('system_settings')
            .upsert(writes.map(w => ({ ...w, updated_at: now })), { onConflict: 'key' });
        if (error) throw error;

        // Caps are cached per process for the auth window. Without this an
        // admin raises a limit, watches nothing change, and raises it again.
        invalidateQuotaCaps();
        logger.info('admin_settings_changed', { userId: ctx.user.id, keys: writes.map(w => w.key) });
        res.json({ success: true, changed: writes.map(w => w.key) });
    } catch (err) { sendErr(res, err); }
});

/** Send one test message with the saved Gmail settings, and say exactly what happened. */
app.post('/api/admin/mail/test', async (req, res) => {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        const s = await mailSettings();
        if (!s.configured) return res.status(400).json({ ok: false, error: 'Save a Gmail address and an app password first.' });
        const to = String(req.body?.to || '').trim().toLowerCase() || s.notifyTo;
        const r = await sendMail({
            to,
            subject: 'EdgeLead can send email',
            text: `This is the test message from EdgeLead, sent from ${s.from} at ${new Date().toISOString()}.\n\n` +
                  'If you are reading it, new trials and requests to continue will reach this address, and clients will hear when you activate them.'
        });
        res.status(r.ok ? 200 : 502).json({ ...r, to });
    } catch (err) { sendErr(res, err); }
});

app.get('/api/admin/users', async (req, res) => {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        const { data: users } = await supabase.from('app_users')
            .select('*').order('created_at', { ascending: false });
        const { data: access } = await supabase.from('user_engine_access').select('user_id, engine');

        const map = {};
        (access || []).forEach(a => { (map[a.user_id] = map[a.user_id] || []).push(a.engine); });

        // state is computed rather than stored, so the admin list can never
        // disagree with what the gate will actually do to that account.
        res.json({
            users: (users || []).map(u => ({
                ...u,
                engines: map[u.id] || [],
                state: accountState(u),
                expires_at: u.paid_until || u.trial_ends_at || null
            })),
            // The grantable engines, sent rather than hardcoded in the page.
            //
            // They WERE hardcoded, and drifted: the admin panel offered four
            // checkboxes while the server had six, so meta_owned and
            // content_plan could not be granted to anyone at all. An admin
            // ticking every box they could see still produced an employee who
            // was refused by requireEngine, with nothing on either screen
            // explaining why. Two lists that must agree, maintained by hand,
            // will always end up like that — so now there is one list.
            allEngines: ENGINES.map(e => ({ key: e, label: ENGINE_LABELS[e] || e }))
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/users', async (req, res) => {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        const { email, password, fullName, role, engines, byoKeyOnly } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

        const { data: created, error: createErr } = await supabase.auth.admin.createUser({
            email, password, email_confirm: true
        });
        if (createErr) throw createErr;

        const newId = created.user.id;
        const newRole = ['admin', 'user', 'client'].includes(role) ? role : 'user';
        const row = {
            id: newId,
            email: email.toLowerCase(),
            full_name: fullName || null,
            role: newRole,
            is_active: true,
            byo_key_only: byoKeyOnly === true
        };

        // An admin can hand out a trial directly — useful for a client who was
        // sold in a meeting rather than through the signup page.
        if (newRole === 'client') {
            const days  = Number.isFinite(parseInt(req.body.trialDays, 10))
                ? parseInt(req.body.trialDays, 10)
                : await trialDaysSetting();
            const start = new Date();
            row.trial_started_at = start.toISOString();
            row.trial_ends_at    = new Date(start.getTime() + days * 86400000).toISOString();
        }

        await supabase.from('app_users').upsert(row);

        for (const e of (engines || []).filter(x => ENGINES.includes(x))) {
            await supabase.from('user_engine_access')
                .upsert({ user_id: newId, engine: e, granted_by: ctx.user.id }, { onConflict: 'user_id,engine' });
        }

        res.json({ success: true, userId: newId });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

// Admin writes below invalidate the auth/engine caches for the affected user,
// so a disabled account or a revoked grant takes effect immediately rather
// than at the end of the cache TTL.
app.patch('/api/admin/users/:id', async (req, res) => {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        S._roleCache.delete(String(req.params.id));   // a demoted admin must lose clientAccess now, not in a minute
        // The auth cache holds the old profile for a minute. Without this, a
        // client activated just now keeps seeing "your access has ended" —
        // with a Reload button that changes nothing — until the cache turns.
        for (const [k, v] of _authCache) if (v.ctx?.user?.id === String(req.params.id)) _authCache.delete(k);
        const {
            role, isActive, engines, password, byoKeyOnly,
            paidUntil, planLabel, trialDays
        } = req.body;
        const target = req.params.id;

        const patch = { updated_at: new Date().toISOString() };

        // Was `role === 'admin' ? 'admin' : 'user'`, which quietly promoted a
        // client to employee whenever an admin patched anything else on the
        // same request. Roles are now named explicitly.
        if (role) {
            patch.role = ['admin', 'user', 'client'].includes(role) ? role : 'user';
        }
        if (typeof isActive === 'boolean') patch.is_active = isActive;
        if (typeof byoKeyOnly === 'boolean') { patch.byo_key_only = byoKeyOnly; _byoCache.delete(target); }

        // Manual activation. paid_until is the whole of billing: an admin sets
        // a date, money is collected out of band, and access ends by itself.
        // Passing null revokes without deleting anything.
        if (paidUntil !== undefined) {
            const when = paidUntil ? new Date(paidUntil) : null;
            if (when && isNaN(when.getTime())) {
                return res.status(400).json({ error: 'paidUntil is not a valid date.' });
            }
            patch.paid_until   = when ? when.toISOString() : null;
            // Activating answers the request. Revoking does not re-raise it.
            if (when) { patch.activation_requested_at = null; patch.activation_note = null; }
            patch.activated_by = ctx.user.id;
            patch.activated_at = new Date().toISOString();
        }
        if (planLabel !== undefined) patch.plan_label = planLabel || null;

        // Extending a trial is a separate lever from selling one: it moves the
        // trial window without implying the account ever paid.
        if (trialDays !== undefined) {
            const d = parseInt(trialDays, 10);
            if (!Number.isFinite(d) || d < 0 || d > 365) {
                return res.status(400).json({ error: 'trialDays must be between 0 and 365.' });
            }
            const start = new Date();
            patch.trial_started_at = start.toISOString();
            patch.trial_ends_at    = new Date(start.getTime() + d * 86400000).toISOString();
        }

        await supabase.from('app_users').update(patch).eq('id', target);

        // Activation is the one change a client should hear about. (phase 29)
        if (paidUntil !== undefined && patch.paid_until) {
            mailActivated(target, { planLabel: patch.plan_label, paidUntil: patch.paid_until })
                .catch(e => logger.warn('mail_activated_failed', { message: e.message }));
        }

        if (password) await supabase.auth.admin.updateUserById(target, { password });

        if (Array.isArray(engines)) {
            await supabase.from('user_engine_access').delete().eq('user_id', target);
            for (const e of engines.filter(x => ENGINES.includes(x))) {
                await supabase.from('user_engine_access')
                    .upsert({ user_id: target, engine: e, granted_by: ctx.user.id }, { onConflict: 'user_id,engine' });
            }
        }
        invalidateAuth(target);
        invalidateEngineAccess(target);
        res.json({ success: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

/**
 * Phase 51: what a person's account carries that must outlive them. Every one of these is filed
 * under the person with ON DELETE CASCADE, so deleting the login used to delete the clients they
 * made — with every task, post, schedule and owner login under those clients — and their Meta
 * connections, schedules, jobs and scraped posts on every client. They now move to the admin who
 * deletes the account (decided by the agency: "clients go to admin"). Personal keys, usage counters
 * and grants are the person's own and go with them.
 */
const HAND_OVER = [
    ['clients', 'owner_user_id'], ['schedules', 'user_id'], ['meta_connections', 'user_id'], ['report_shares', 'user_id'],
    ['jobs', 'user_id'], ['posts', 'user_id'], ['competitor_sets', 'user_id'], ['campaigns', 'user_id'],
    ['content_plan_notes', 'user_id'], ['ai_conversations', 'user_id'], ['reports', 'user_id'],
    ['fb_pages', 'user_id'], ['fb_page_posts', 'user_id'], ['fb_page_sets', 'user_id'], ['fb_groups', 'user_id'],
    ['fb_group_sets', 'user_id'], ['fb_posts', 'user_id'], ['fb_demand_signals', 'user_id'], ['fb_suggestions', 'user_id'],
    ['client_tasks', 'assignee_user_id'],
    // phase 57: the leads inside those campaigns, which cascade with the login and left them empty
    ['campaign_leads', 'user_id']
];
async function handOverUser(fromId, toId) {
    const moved = {};
    for (const [table, col] of HAND_OVER) {
        const { data, error } = await supabase.from(table).update({ [col]: toId }).eq(col, fromId).select('id');
        if (!error) { if ((data || []).length) moved[table] = data.length; continue; }
        if (S.missingTable(error)) continue;
        if (error.code !== '23505') throw new Error(`Could not hand over ${table}: ${error.message}`);
        // The admin already holds the same thing (the same Page connected, say): theirs is kept,
        // this copy is the duplicate. Row by row, so only true duplicates go.
        const { data: rows } = await supabase.from(table).select('id').eq(col, fromId);
        let n = 0, dropped = 0;
        for (const r of rows || []) {
            const { error: e1 } = await supabase.from(table).update({ [col]: toId }).eq('id', r.id);
            if (!e1) { n += 1; continue; }
            if (e1.code !== '23505') throw new Error(`Could not hand over ${table}: ${e1.message}`);
            await supabase.from(table).delete().eq('id', r.id); dropped += 1;
        }
        if (n || dropped) moved[table] = n + (dropped ? ` (+${dropped} duplicate${dropped === 1 ? '' : 's'} dropped)` : '');
    }
    return moved;
}

app.delete('/api/admin/users/:id', async (req, res) => {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        if (req.params.id === ctx.user.id) return res.status(400).json({ error: 'You cannot delete yourself.' });
        if (!S.UUID_RE.test(String(req.params.id))) return res.status(400).json({ error: 'Not a user id.' });
        // Phase 51: hand everything over first; if that fails, nothing is deleted.
        const moved = await handOverUser(req.params.id, ctx.user.id);
        logger.info('user_handed_over', { from: req.params.id, to: ctx.user.id, moved });
        // Phase 57: a login Supabase did not delete keeps working; its profile is not removed behind its back
        // (it would come back as a brand-new trial on the next sign-in).
        const { error: delErr } = await supabase.auth.admin.deleteUser(req.params.id);
        if (delErr && !/not found/i.test(delErr.message || '')) throw new Error('The login could not be deleted: ' + delErr.message + ' Their work was already handed to you; try again.');
        await supabase.from('app_users').delete().eq('id', req.params.id);
        invalidateAuth(req.params.id);
        invalidateEngineAccess(req.params.id);
        res.json({ success: true, movedTo: ctx.user.id, moved });
    } catch (err) { res.status(400).json({ error: err.message }); }
});
