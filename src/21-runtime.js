/**
 * Single-instance guard, start-up and graceful shutdown.
 *
 * Part of the EdgeLead server, split out of server.js (phase 55). The parts load in
 * order from server.js and share one namespace, S: what this part needs from an earlier
 * part is unpacked below; anything else from another part is read as S.name when it runs.
 */
'use strict';
const S = require('./shared');
const {
    AI_PROMPT_BUDGET, ALERT_WEBHOOK, APIFY_CYCLE_CREDIT, APIFY_MEMORY_MB, APIFY_PROXY_GROUP,
    APIFY_TIMEOUT_SECS, APP_VERSION, AUTO_RESUME, BUDGET_MODE, ELS, ENC_KEY, ENC_KEY_OLD, ENC_REQUIRED,
    ENGINES, FB_DEFAULT_GROUPS, FB_DEFAULT_POSTS, GEMINI_API_KEY, GEMINI_MODEL, IG_SCORE_VERSION,
    JOB_STALE_MINUTES, KEEPALIVE_MS, LOCAL_JOBS, MASTER_ADMIN_EMAIL, META_DAILY_POLL_MS, METRICS,
    SCHEDULER_ENABLED, SCHEDULER_POLL_MS, SELF_URL, _byoCache, _statusCache, alertOnce, app, auth, bearerId,
    callActor, clientAccess, crypto, decryptSecret, encryptSecret, fbEstimateCredits, geminiAvailable,
    geminiCandidates, geminiReportKey, getWorkingClient, isEncrypted, keepAwakeIfBusy, loadGeminiPool,
    logger, metaDailyTick, ownClientFor, primaryKeyName, rateLimit, requireAdmin, reviveStaleKeys,
    schedulerTick, supabase, sweepStaleJobs, sweepStaleReservations, tokenHash, xp
} = S;
Object.assign(S, {
    xpApifyRun, rotateEncryptionKey, migrateSecretsAtRest, schemaProbe, preflight, start, gracefulShutdown
});
Object.defineProperty(S, '_shuttingDown', { get: () => _shuttingDown, set: (v) => { _shuttingDown = v; }, enumerable: true });

// ===========================================================================
// PHASE 11 :: SINGLE-INSTANCE GUARD
//
// Rate-limit buckets, the auth cache, Gemini cooldowns and the auto-resume
// tracker are per-process Maps. That is fine on one Render instance and wrong
// on two. Rather than silently degrade, every instance heartbeats into
// system_settings and alarms if it sees another live heartbeat. This does not
// make two instances safe; it makes the mistake visible within a minute.
// ===========================================================================

const INSTANCE_ID = crypto.randomBytes(6).toString('hex');
S.INSTANCE_ID = INSTANCE_ID;
const INSTANCE_BEAT_MS = 30000;
let _multiInstanceSeen = false;

async function instanceHeartbeat() {
    try {
        const now = Date.now();
        await supabase.from('system_settings').upsert({
            key: 'instance_heartbeat:' + INSTANCE_ID,
            value: JSON.stringify({ t: now, version: APP_VERSION, pid: process.pid }),
            updated_at: new Date(now).toISOString()
        }, { onConflict: 'key' });

        const { data } = await supabase.from('system_settings').select('key, value').like('key', 'instance_heartbeat:%');
        const others = (data || []).filter(r => r.key !== 'instance_heartbeat:' + INSTANCE_ID).map(r => {
            try { return { key: r.key, ...(JSON.parse(r.value || '{}')) }; } catch { return { key: r.key, t: 0 }; }
        });
        const live = others.filter(o => now - Number(o.t || 0) < INSTANCE_BEAT_MS * 3);
        const stale = others.filter(o => now - Number(o.t || 0) > 86400000);
        if (stale.length) {
            await supabase.from('system_settings').delete().in('key', stale.map(s => s.key));
        }
        METRICS.instances = { self: INSTANCE_ID, live: 1 + live.length };
        if (live.length && !_multiInstanceSeen) {
            _multiInstanceSeen = true;
            logger.error('multiple_instances', { self: INSTANCE_ID, others: live.map(o => o.key) });
            alertOnce('multiple_instances',
                `${1 + live.length} server instances are running. Rate limits, Gemini cooldowns and cancel/resume state are per-process — scale back to one instance.`,
                { self: INSTANCE_ID, others: live.map(o => o.key) });
        } else if (!live.length) {
            _multiInstanceSeen = false;
        }
    } catch (e) { logger.warn('instance_heartbeat_failed', { message: e.message }); }
}


// Boot: warm the Gemini pool so geminiAvailable() is truthful from the start.
loadGeminiPool(true).then(rows => logger.info('gemini_pool', { keys: rows.length, env: !!GEMINI_API_KEY, model: GEMINI_MODEL }));
setInterval(() => loadGeminiPool(true).catch(() => {}), 300000).unref?.();

// Phase 31: the Owner Assistant's routes (chat, conversations, status, sync),
// behind EdgeLead's own auth and client access. They must be registered
// BEFORE the catch-all below: Express runs in registration order, and the
// first deploy mounted them after it, so every /api/xp request was a 404.
xp.mount(app, { auth, requireAdmin, clientAccess, ownClientFor, decrypt: decryptSecret, rateLimit, bearerId, logger,
    // Edge Meta AI draws from the same keys as everything else: the person's own, then the pool, then the server key.
    geminiKeys: { list: () => geminiCandidates(ELS.getStore()?.userId || null), report: geminiReportKey },
    // Creator posts (phase 46) run on EdgeLead's Apify keys: the person's own first when staff start a
    // look, the shared keys for the weekly pass; same budget gate and spend ledger as every engine.
    apifyRun: xpApifyRun });

async function xpApifyRun(actorId, input, { maxItems, maxTotalChargeUsd } = {}) {
    const { client } = await getWorkingClient('report', ELS.getStore()?.userId || null, { needUsd: maxTotalChargeUsd || 0 });
    const { run, items, usd } = await callActor(client, actorId, input, { estimateUsd: maxTotalChargeUsd || 0.05, maxItems });
    return { items: items || [], runId: run?.id || null, costUsd: usd, key: { id: client.__el?.keyId || null, label: client.__el?.apifyUsername || 'EdgeLead key' },
        status: run?.status === 'TIMED-OUT' ? 'TIMED-OUT' : 'SUCCEEDED' };
}

app.use('/api', (req, res) => {
    res.status(404).json({
        error: `No such endpoint: ${req.method} ${req.path}`,
        hint: 'Check the path, or the frontend may be newer than the deployed server.'
    });
});

/**
 * The last line. Anything a route threw synchronously, or handed to next(),
 * lands here as JSON instead of a stack trace in an HTML page.
 */
app.use((err, req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    METRICS.http.errors += 1;
    logger.error('unhandled_route_error', {
        method: req.method, path: req.path, status,
        message: err.message, stack: (err.stack || '').slice(0, 600)
    });
    if (res.headersSent) return;
    res.status(status).json({
        error: status >= 500 ? 'Something went wrong on the server.' : (err.message || 'Request failed'),
        // A malformed JSON body is the common 400 here and the caller can fix it.
        detail: status < 500 ? err.message : undefined
    });
});

function decryptWithOldKey(stored) {
    if (!ENC_KEY_OLD) throw new Error('APP_ENCRYPTION_KEY_OLD is not set');
    if (!stored) return stored;
    if (!isEncrypted(stored)) return stored;          // legacy plaintext row
    // Same wire format as decryptSecret(): encv1:<iv>:<tag>:<ct>, base64 each.
    const [, ivB, tagB, ctB] = String(stored).split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', ENC_KEY_OLD, Buffer.from(ivB, 'base64'));
    d.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ctB, 'base64')), d.final()]).toString('utf8');
}

/**
 * Re-wrap every stored secret under the current key.
 *
 * dryRun defaults to true. A rotation that cannot be rehearsed is a rotation
 * nobody runs until the incident, which is the worst possible time to find out
 * one of the rows will not decrypt.
 */
async function rotateEncryptionKey({ dryRun = true } = {}) {
    if (!ENC_KEY)     return { error: 'APP_ENCRYPTION_KEY is not set — nothing to rotate to.' };
    if (!ENC_KEY_OLD) return { error: 'APP_ENCRYPTION_KEY_OLD is not set — nothing to rotate from.' };
    if (ENC_KEY.equals(ENC_KEY_OLD)) return { error: 'Old and new keys are identical.' };

    const report = { dryRun, keys: { total: 0, rotated: 0, failed: 0 },
                     primaries: { total: 0, rotated: 0, failed: 0 }, failures: [] };

    // A secret may be encrypted under the old key, under the new key already
    // (a partial previous run), or sitting in plaintext. Try each in turn and
    // record which path worked, so a resumed rotation is idempotent.
    const recover = (stored, label) => {
        if (!isEncrypted(stored)) return { plain: stored, via: 'plaintext' };
        try { return { plain: decryptSecret(stored, { currentKeyOnly: true }), via: 'already-new' }; } catch (_) {}
        try { return { plain: decryptWithOldKey(stored), via: 'old-key' }; } catch (e) {
            report.failures.push({ item: label, message: e.message });
            return null;
        }
    };

    // --- apify_keys --------------------------------------------------------
    try {
        const { data: rows, error } = await supabase.from('apify_keys').select('id, token, token_hash');
        if (error) throw new Error(error.message);

        for (const row of rows || []) {
            report.keys.total += 1;
            const rec = recover(row.token, `apify_keys:${row.id}`);
            if (!rec) { report.keys.failed += 1; continue; }
            if (rec.via === 'already-new') continue;   // nothing to do

            if (!dryRun) {
                const patch = { token: encryptSecret(rec.plain) };
                if (!row.token_hash) patch.token_hash = tokenHash(rec.plain);
                const { error: upErr } = await supabase.from('apify_keys').update(patch).eq('id', row.id);
                if (upErr) { report.keys.failed += 1; report.failures.push({ item: `apify_keys:${row.id}`, message: upErr.message }); continue; }
            }
            report.keys.rotated += 1;
        }
    } catch (e) {
        report.failures.push({ item: 'apify_keys', message: e.message });
    }

    // --- system_settings primaries ------------------------------------------
    for (const engine of ENGINES) {
        const name = primaryKeyName(engine);
        try {
            const { data } = await supabase.from('system_settings').select('value').eq('key', name).maybeSingle();
            if (!data?.value) continue;
            report.primaries.total += 1;

            const rec = recover(data.value, `system_settings:${name}`);
            if (!rec) { report.primaries.failed += 1; continue; }
            if (rec.via === 'already-new') continue;

            if (!dryRun) {
                await supabase.from('system_settings').upsert({
                    key: name, value: encryptSecret(rec.plain), updated_at: new Date().toISOString()
                }, { onConflict: 'key' });
            }
            report.primaries.rotated += 1;
        } catch (e) {
            report.primaries.failed += 1;
            report.failures.push({ item: `system_settings:${name}`, message: e.message });
        }
    }

    // Any in-process client holds a decrypted token bound to the old row. They
    // are still valid tokens — rotation changes how the token is stored, not
    // the token — so nothing needs invalidating. The BYO cache is cleared
    // anyway so the next request re-reads from the rotated rows.
    if (!dryRun) {
        _byoCache.clear();
        _statusCache.clear();
        logger.info('encryption_key_rotated', {
            keysRotated: report.keys.rotated, primariesRotated: report.primaries.rotated,
            failed: report.keys.failed + report.primaries.failed
        });
    }

    report.ok = report.failures.length === 0;
    report.nextStep = dryRun
        ? (report.ok
            ? 'Dry run clean. Re-POST with { "confirm": "rotate" } to write.'
            : 'Dry run found failures — resolve them before writing. Nothing was changed.')
        : (report.ok
            ? 'Rotation complete. Remove APP_ENCRYPTION_KEY_OLD from the environment and redeploy.'
            : 'Rotation finished with failures. Leave APP_ENCRYPTION_KEY_OLD set until they are resolved — it is the only thing that can still read those rows.');

    return report;
}

async function migrateSecretsAtRest() {
    if (!ENC_KEY) {
        logger.warn('encryption_disabled', {
            note: 'APP_ENCRYPTION_KEY is not set. Apify tokens are stored in plaintext. ' +
                  'Generate one with: openssl rand -hex 32'
        });
        return { encrypted: 0, hashed: 0, skipped: true };
    }

    let encrypted = 0, hashed = 0;

    try {
        const { data: rows } = await supabase.from('apify_keys').select('id, token, token_hash');
        for (const row of rows || []) {
            const patch = {};
            let plain = null;
            try { plain = decryptSecret(row.token, { currentKeyOnly: true }); }
            catch (e) {
                // During a rotation window this is expected: the row is sealed
                // under APP_ENCRYPTION_KEY_OLD and rotateEncryptionKey() owns
                // moving it. decryptSecret() can still read it, so nothing is
                // broken — this migration just has no work to do here.
                if (ENC_KEY_OLD) logger.debug('migrate_skipped_pending_rotation', { keyId: row.id });
                else logger.error('migrate_decrypt_failed', { keyId: row.id, message: e.message });
                continue;
            }

            if (!isEncrypted(row.token)) { patch.token = encryptSecret(plain); encrypted += 1; }
            if (!row.token_hash)         { patch.token_hash = tokenHash(plain); hashed += 1; }
            if (Object.keys(patch).length) await supabase.from('apify_keys').update(patch).eq('id', row.id);
        }
    } catch (e) {
        logger.error('migrate_keys_failed', { message: e.message });
    }

    try {
        for (const engine of ENGINES) {
            const name = primaryKeyName(engine);
            const { data } = await supabase.from('system_settings')
                .select('value').eq('key', name).maybeSingle();
            if (data?.value && !isEncrypted(data.value)) {
                await supabase.from('system_settings').upsert({
                    key: name, value: encryptSecret(data.value), updated_at: new Date().toISOString()
                }, { onConflict: 'key' });
                encrypted += 1;
            }
        }
    } catch (e) {
        logger.error('migrate_primaries_failed', { message: e.message });
    }

    if (encrypted || hashed) logger.info('secrets_migrated', { encrypted, hashed });
    return { encrypted, hashed, skipped: false };
}

/**
 * Confirm at boot that the migrations this build depends on have actually run.
 *
 * Every one of these failures used to be silent at boot and only visible much
 * later as missing data: posts that never persisted, a trend line that could
 * not tell v1 from v2 snapshots, an AI status nobody could read back.
 */
async function schemaProbe() {
    const required = [
        { table: 'posts',   column: 'is_provisional',    migration: 'schema-phase4.sql',
          impact: 'Instagram posts will not be written — reports still render, but post history stops accumulating.' },
        { table: 'reports', column: 'score_version',     migration: 'schema-phase5.sql',
          impact: 'Trend lines cannot tell a scoring change apart from a real change in the account.' },
        { table: 'reports', column: 'ai_status',         migration: 'schema-phase5.sql',
          impact: 'A failed strategy layer will not record why it failed.' },
        { table: 'reports', column: 'followers_snapshot', migration: 'schema-phase5.sql',
          impact: 'Trend snapshots fall back to nulls for followers, cadence and rank.' },
        { table: 'jobs',    column: 'partials',          migration: 'schema-phase1.sql',
          impact: 'Job checkpoints cannot be stored — a paused run will re-scrape and re-charge on resume.' },
        { table: 'reports', column: 'client_id',         migration: 'schema-phase9.sql',
          impact: 'Every report insert will fail — clients, content plans and Meta syncs cannot save.' },
        { table: 'clients', column: 'id',                migration: 'schema-phase9.sql',
          impact: 'Client workspace routes will 500.' },
        { table: 'gemini_keys', column: 'key_enc',       migration: 'schema-phase9.sql',
          impact: 'Only the env Gemini key can be used; no pool, no per-user keys.' },
        { table: 'meta_connections', column: 'page_token_enc', migration: 'schema-phase9.sql',
          impact: 'Meta OAuth callback cannot store a connection.' },
        { table: 'posts',         column: 'client_id', migration: 'schema-phase10.sql',
          impact: 'Instagram post upserts will fail on an unknown column — audits render but post history stops; content plans starve.' },
        { table: 'fb_page_posts', column: 'client_id', migration: 'schema-phase10.sql',
          impact: 'FB Page post upserts will fail — page reports render but the FB content plan has nothing to read.' },
        { table: 'fb_posts',      column: 'client_id', migration: 'schema-phase10.sql',
          impact: 'FB group post upserts will fail — community audits and the demand feed stop accumulating.' },
        { table: 'posts',         column: 'plays',     migration: 'schema-phase11.sql',
          impact: 'Instagram post upserts will fail on an unknown column — audits render but post history stops.' },
        { table: 'leads',         column: 'whatsapp',  migration: 'schema-phase11.sql',
          impact: 'Lead enrichment updates will fail on an unknown column.' },
        { table: 'schedules',     column: 'next_run_at', migration: 'schema-phase11.sql',
          impact: 'Scheduled runs cannot be created or fired.' },
        { table: 'report_shares', column: 'token',     migration: 'schema-phase11.sql',
          impact: 'Report share links cannot be created.' },
        { table: 'content_posts', column: 'planned_on', migration: 'schema-phase42.sql',
          impact: 'Content plans cannot be put on the calendar and owners see no posts to approve.' },
        { table: 'content_picks', column: 'month',     migration: 'schema-phase43.sql',
          impact: 'The business audit, topics, the idea library and the month plan answer 503.' },
        { table: 'leads',         column: 'kind_now',  migration: 'schema-phase40.sql',
          impact: 'Leads are saved but not sorted into influencers and businesses, and the pipeline answers 503.' }
    ];

    const missing = [];
    for (const r of required) {
        try {
            const { error } = await supabase.from(r.table).select(r.column).limit(1);
            if (error) missing.push(r);
        } catch (_) { missing.push(r); }
    }

    if (missing.length) {
        missing.forEach(m => logger.error('schema_missing', {
            table: m.table, column: m.column, migration: m.migration, impact: m.impact
        }));
        alertOnce('schema_missing',
            `${missing.length} required column(s) are missing. Run: ` +
            [...new Set(missing.map(m => m.migration))].join(', '),
            { columns: missing.map(m => `${m.table}.${m.column}`) });
    } else {
        logger.info('schema_ok', { checked: required.length });
    }
    return missing;
}

/** A boot-time sanity check. Anything printed here is a deployment mistake. */
function preflight() {
    const problems = [];

    // Phase 4: a half-configured rotation should fail at boot, not on the
    // first request that touches a credential.
    if (ENC_KEY_OLD && ENC_KEY && ENC_KEY_OLD.equals(ENC_KEY)) {
        problems.push('APP_ENCRYPTION_KEY_OLD is identical to APP_ENCRYPTION_KEY.');
    }
    if (ENC_KEY_OLD && !ENC_KEY) {
        problems.push('APP_ENCRYPTION_KEY_OLD is set but APP_ENCRYPTION_KEY is not — nothing to rotate to.');
    }
    if (ENC_KEY_OLD) {
        logger.warn('rotation_mode_active', {
            note: 'APP_ENCRYPTION_KEY_OLD is set. Finish the rotation and unset it — ' +
                  'leaving it in place keeps the retired key live in the environment.'
        });
    }
    if (!process.env.SUPABASE_URL) problems.push('SUPABASE_URL is not set');
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) problems.push('SUPABASE_SERVICE_ROLE_KEY is not set');
    if (/^AIza/.test(GEMINI_API_KEY)) problems.push('GEMINI_API_KEY is an old standard key (AIza…). Google stopped accepting those in September 2026 — replace it with a new AI Studio key (AQ.…)');
    if (!ENC_KEY) problems.push(ENC_REQUIRED
        ? 'APP_ENCRYPTION_KEY is not set — connecting Meta and saving Apify or AI keys will be refused until it is'
        : 'APP_ENCRYPTION_KEY is not set — secrets are stored in plaintext (allowed only outside production)');
    if (!geminiAvailable()) problems.push('No Gemini key anywhere (env or pool) — reports will ship without their narrative layer');
    if (!(process.env.META_APP_ID && process.env.META_APP_SECRET)) problems.push('META_APP_ID / META_APP_SECRET not set — Meta owner-data connections are disabled');
    if (!MASTER_ADMIN_EMAIL) problems.push('MASTER_ADMIN_EMAIL is not set — the first user to sign in becomes admin');
    if (!ALERT_WEBHOOK) problems.push('ALERT_WEBHOOK_URL is not set — failures will only appear in the logs');
    if (!SELF_URL) problems.push(
        'Neither SELF_URL nor RENDER_EXTERNAL_URL is set — the instance cannot keep itself awake, ' +
        'so a long job will be interrupted whenever the user closes the tab');
    if (BUDGET_MODE !== 'block') problems.push(`BUDGET_MODE=${BUDGET_MODE} — a run can overspend a key without pausing`);

    // The default run has to fit the default budget. Checking the actual number
    // beats warning on a hard-coded threshold that drifts away from the config.
    const defaultRunUsd = fbEstimateCredits(FB_DEFAULT_GROUPS, FB_DEFAULT_POSTS, false);
    if (defaultRunUsd > APIFY_CYCLE_CREDIT * 0.5) {
        problems.push(
            `A default Facebook audit (${FB_DEFAULT_GROUPS} groups x ${FB_DEFAULT_POSTS} posts) ` +
            `estimates $${defaultRunUsd.toFixed(2)} against a $${APIFY_CYCLE_CREDIT} cycle — ` +
            `fewer than 2 runs per key per month`
        );
    }
    problems.forEach(p => logger.warn('preflight', { problem: p }));
    return problems;
}

const PORT = process.env.PORT || 10000;

async function start() {
    preflight();

    const server = app.listen(PORT, async () => {
        logger.info('boot', {
            port: PORT,
            version: APP_VERSION,
            budgetMode: BUDGET_MODE,
            creditPerKeyUsd: APIFY_CYCLE_CREDIT,
            memoryMb: APIFY_MEMORY_MB,
            timeoutSecs: APIFY_TIMEOUT_SECS,
            proxy: APIFY_PROXY_GROUP || 'actor default',
            geminiModel: GEMINI_MODEL,
            geminiMaxOutputTokens: parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS || '8192', 10),
            aiPromptBudgetChars: AI_PROMPT_BUDGET,
            igScoreVersion: IG_SCORE_VERSION,
            encryptionAtRest: !!ENC_KEY,
            rotationPending: !!ENC_KEY_OLD,
            keepAlive: !!SELF_URL,
            autoResume: AUTO_RESUME,
            alerts: !!ALERT_WEBHOOK,
            instance: INSTANCE_ID,
            scheduler: SCHEDULER_ENABLED
        });

        await schemaProbe();
        await migrateSecretsAtRest();

        // Jobs run in-process. Render's free tier sleeps on idle and restarts on
        // every deploy, so anything still marked running at boot is orphaned.
        await sweepStaleJobs();
        await sweepStaleReservations();
        await reviveStaleKeys();

        setInterval(sweepStaleJobs, Math.max(5, JOB_STALE_MINUTES) * 60000).unref?.();
        setInterval(sweepStaleReservations, Math.max(5, JOB_STALE_MINUTES) * 60000).unref?.();
        setInterval(reviveStaleKeys, 3600000).unref?.();
        if (SELF_URL) setInterval(keepAwakeIfBusy, KEEPALIVE_MS).unref?.();

        // Phase 11: heartbeat first so a second instance is visible at once,
        // then the scheduler, which stays quiet until a schedule is due.
        await instanceHeartbeat();
        setInterval(instanceHeartbeat, INSTANCE_BEAT_MS).unref?.();
        if (SCHEDULER_ENABLED) {
            setTimeout(() => schedulerTick().catch(() => {}), 15000).unref?.();
            setInterval(schedulerTick, Math.max(15000, SCHEDULER_POLL_MS)).unref?.();
            // Phase 30: the daily Meta read. Quiet unless a connection is due.
            setTimeout(() => metaDailyTick().catch(() => {}), 45000).unref?.();
            setInterval(() => metaDailyTick().catch(() => {}), Math.max(60000, META_DAILY_POLL_MS)).unref?.();
        }
        // Phase 31: XpulseAI's warehouse sync on its own clock (09:00 and 21:00 UTC),
        // and the boot-time pass that provisions every connected client into it.
        try { logger.info('xp_start', xp.start()); } catch (e) { logger.error('xp_start_failed', { message: e.message }); }
        logger.info('phase11_ready', { instance: INSTANCE_ID, scheduler: SCHEDULER_ENABLED, pollMs: SCHEDULER_POLL_MS });
    });

    return server;
}

/**
 * Park in-flight jobs on the way out.
 *
 * sweepStaleJobs() already recovers these, but only after JOB_STALE_MINUTES of
 * a dead heartbeat — during which the UI spins on a job nobody is running.
 * Render sends SIGTERM on every single deploy, so this is the common path, not
 * the exceptional one.
 *
 * Best-effort and time-boxed: the platform SIGKILLs shortly after, and a
 * shutdown that hangs is worse than one that misses a row the sweep would have
 * caught anyway. 'interrupted' is already in RESUMABLE_STATUSES, so these are
 * picked up — and auto-resumed — on the next boot exactly as before.
 */
let _shuttingDown = false;
async function gracefulShutdown(signal, server) {
    if (_shuttingDown) return;
    _shuttingDown = true;
    logger.warn('shutdown_started', { signal });

    try { server?.close(); } catch (_) {}

    // Drop our own heartbeat so the instance that replaces us does not see a
    // fresh row and raise multiple_instances on every deploy. Best-effort;
    // the 90 s staleness window still covers a SIGKILL.
    try {
        await Promise.race([
            supabase.from('system_settings').delete().eq('key', 'instance_heartbeat:' + INSTANCE_ID),
            new Promise(r => setTimeout(r, 1500))
        ]);
    } catch (_) {}

    try {
        // Only this process's own jobs: another instance's are alive and must not be parked (phase 54).
        const mine = [...LOCAL_JOBS];
        if (mine.length) await Promise.race([
            supabase.from('jobs')
                .update({
                    status: 'interrupted',
                    error: 'The server restarted while this job was running. ' +
                           'Anything already scraped was saved — resume to finish the rest.',
                    updated_at: new Date().toISOString()
                })
                .in('id', mine)
                .in('status', ['running', 'queued']),
            new Promise(r => setTimeout(r, 4000))
        ]);
    } catch (e) {
        logger.error('shutdown_park_failed', { message: e.message });
    }

    logger.warn('shutdown_complete', { signal });
    process.exit(0);
}
