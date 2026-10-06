/**
 * Instagram reports: the audit engine, jobs, the reports vault and trends.
 *
 * Part of the EdgeLead server, split out of server.js (phase 55). The parts load in
 * order from server.js and share one namespace, S: what this part needs from an earlier
 * part is unpacked below; anything else from another part is read as S.name when it runs.
 */
'use strict';
const S = require('./shared');
const {
    APIFY_CYCLE_CREDIT, BUDGET_MODE, BUDGET_RESERVE, DEFAULT_POSTS_PER_ACC, ENGINES, JOB_WORKERS,
    MAX_COMPETITORS, MAX_POSTS_PER_ACC, RESUMABLE_STATUSES, app, assertJobSlot, auth, budgetSnapshot,
    buildTokenCandidates, claimJob, createJob, cycleMonth, cycleUsage, estimateCredits, geminiNarrative,
    getWorkingClient, jobUnitCount, requireEngine, runJob, sendErr, spendLimit, supabase, tokenHash,
    updateJob
} = S;

// ===========================================================================
// REPORT ENGINE :: LEGACY ENDPOINT (existing ig-report.html keeps working)
// ===========================================================================

app.post('/api/generate-ig-report', spendLimit, async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'report'); if (!ctx) return;
        await assertJobSlot(ctx.user.id);
        const { target, compareRivals, rival1, rival2, postsLimit } = req.body;

        const cleanTarget = String(target || '').replace('@', '').replace(/\/+$/, '').trim().toLowerCase();
        if (!cleanTarget) return res.status(400).json({ success: false, error: 'Target handle required' });

        const rivals = compareRivals
            ? [...new Set([rival1, rival2]
                .map(h => String(h || '').replace('@', '').replace(/\/+$/, '').trim().toLowerCase())
                .filter(Boolean)
                .filter(h => h !== cleanTarget))]
            : [];

        const limit = Math.min(parseInt(postsLimit || DEFAULT_POSTS_PER_ACC, 10), MAX_POSTS_PER_ACC);
        const accounts = rivals.length + 1;
        const estimate = estimateCredits(accounts, limit);

        // NOTE: intentionally does NOT create a competitor_sets row and does NOT
        // tag posts with a set_id. Saved, re-runnable cohorts and trend tracking
        // stay exclusive to /api/deep-audit (Competitor Intel).
        const job = await createJob(ctx.user.id, 'ig_report', 'report',
            { clientId: await S.resolveClientId(req, ctx), target: cleanTarget, rivals, postsPerAccount: limit }, estimate);

        runJob(job.id, JOB_WORKERS['ig_report'](ctx.user.id, job.input, job.id));

        res.status(202).json({
            success: true,
            jobId: job.id,
            accounts,
            postsPerAccount: limit,
            estimatedUsd: estimate
        });
    } catch (err) {
        sendErr(res, err);
    }
});

// ===========================================================================
// REPORT ENGINE :: DEEP AUDIT + COMPETITOR BENCHMARK (async job)
// ===========================================================================

app.get('/api/estimate-credits', async (req, res) => {
    const ctx = await auth(req, res); if (!ctx) return;
    const accounts = Math.min(parseInt(req.query.accounts || '1', 10), MAX_COMPETITORS + 1);
    const posts = Math.min(parseInt(req.query.posts || DEFAULT_POSTS_PER_ACC, 10), MAX_POSTS_PER_ACC);
    const estimatedUsd = estimateCredits(accounts, posts);
    res.json({
        accounts, postsPerAccount: posts,
        totalPosts: accounts * posts,
        estimatedUsd,
        budget: await budgetSnapshot('report', ctx.user.id, estimatedUsd),
        note: 'Estimate only. Actual Apify billing depends on the actor and result count.'
    });
});

app.post('/api/deep-audit', spendLimit, async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'report'); if (!ctx) return;
        await assertJobSlot(ctx.user.id);

        const {
            target,
            competitors = [],
            postsPerAccount,
            setName,
            setId
        } = req.body;

        const cleanTarget = String(target || '').replace('@', '').trim().toLowerCase();
        if (!cleanTarget) return res.status(400).json({ error: 'Target handle required' });

        const rivals = [...new Set(
            (competitors || [])
                .map(h => String(h || '').replace('@', '').trim().toLowerCase())
                .filter(Boolean)
                .filter(h => h !== cleanTarget)
        )].slice(0, MAX_COMPETITORS);

        const limit = Math.min(parseInt(postsPerAccount || DEFAULT_POSTS_PER_ACC, 10), MAX_POSTS_PER_ACC);
        const accounts = rivals.length + 1;
        const estimate = estimateCredits(accounts, limit);

        // Reusable benchmark group so the same cohort can be re-run later
        let activeSetId = setId || null;
        if (!activeSetId) {
            const { data: set } = await supabase.from('competitor_sets').insert([{
                user_id: ctx.user.id,
                client_id: await S.resolveClientId(req, ctx),
                name: setName || `${cleanTarget} vs ${rivals.length} rivals`,
                target_handle: cleanTarget,
                competitor_handles: rivals,
                posts_per_account: limit
            }]).select('id').maybeSingle();
            activeSetId = set?.id || null;
        }

        const job = await createJob(ctx.user.id, 'deep_audit', 'report',
            { clientId: await S.resolveClientId(req, ctx), target: cleanTarget, competitors: rivals, postsPerAccount: limit, setId: activeSetId },
            estimate
        );

        runJob(job.id, JOB_WORKERS['deep_audit'](ctx.user.id, job.input, job.id));

        res.status(202).json({
            success: true,
            jobId: job.id,
            setId: activeSetId,
            accounts,
            postsPerAccount: limit,
            estimatedUsd: estimate
        });
    } catch (err) { sendErr(res, err); }
});

// ===========================================================================
// JOBS
// ===========================================================================

/**
 * Resume a job that paused for credit or was interrupted by a restart.
 *
 * Units already in `completed_units` are skipped and their saved analysis is
 * reused, so nothing that has already been paid for is scraped a second time.
 */
app.post('/api/job/:id/resume', spendLimit, async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;

        const { data: job } = await supabase.from('jobs')
            .select('*').eq('id', req.params.id).eq('user_id', ctx.user.id).maybeSingle();
        if (!job) return res.status(404).json({ error: 'Job not found.' });

        if (!RESUMABLE_STATUSES.includes(job.status)) {
            return res.status(409).json({
                error: `This job is ${job.status} and cannot be resumed.`
            });
        }

        const factory = JOB_WORKERS[job.type];
        if (!factory) {
            return res.status(400).json({
                error: `"${job.type}" jobs cannot be resumed. Start a new run instead.`
            });
        }

        // Confirm there is now a key that can actually pay, so the user gets an
        // immediate answer instead of watching the job pause again.
        const totalUnits = jobUnitCount(job);
        const doneUnits  = (job.completed_units || []).length;
        const leftUnits  = Math.max(0, totalUnits - doneUnits);
        const perUnit    = Number(job.credits_estimate || 0) / totalUnits;
        try {
            await getWorkingClient(job.engine, ctx.user.id, { needUsd: perUnit, jobId: job.id });
        } catch (e) {
            return res.status(402).json({
                error: e.message,
                code: 'NO_CREDIT',
                completed: doneUnits,
                remainingUnits: leftUnits,
                remainingEstimateUsd: +(perUnit * leftUnits).toFixed(4)
            });
        }

        await assertJobSlot(ctx.user.id);

        // Claim here rather than inside runJob, which is fire-and-forget: a
        // second click would otherwise be answered 202 while quietly doing
        // nothing. The claim also clears any stale cancellation flag, which
        // would stop the job the instant it started.
        const claimed = await claimJob(job.id, RESUMABLE_STATUSES, { resume: true });
        if (!claimed) {
            return res.status(409).json({
                error: 'This job is already running. Nothing further was started.'
            });
        }

        runJob(job.id, factory(ctx.user.id, job.input, job.id), { resume: true, claimed: true });

        res.status(202).json({
            success: true,
            jobId: job.id,
            resumedFrom: doneUnits,
            remainingUnits: leftUnits,
            note: 'Already-completed units will be reused, not re-scraped.'
        });
    } catch (err) { sendErr(res, err); }
});

/**
 * What the user actually wants to see before pressing Run: how much of the
 * cycle credit is left on each key they can draw from.
 */
app.get('/api/budget', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const engine = ENGINES.includes(req.query.engine) ? req.query.engine : 'leadgen';

        const candidates = await buildTokenCandidates(engine, ctx.user.id);
        const month = cycleMonth();
        const keys = [];
        let total = 0;

        for (const c of candidates) {
            const hash = tokenHash(c.token);
            const spent = await cycleUsage(hash, month);
            const remaining = Math.max(0, c.creditUsd - spent);
            total += remaining;
            keys.push({
                source: c.source,
                label: c.source === 'user_pool' ? 'Your key'
                     : c.source === 'engine_primary' ? 'Shared primary'
                     : c.source === 'global_pool' ? 'Shared pool'
                     : 'Server fallback',
                creditUsd:   +Number(c.creditUsd).toFixed(2),
                spentUsd:    +spent.toFixed(4),
                remainingUsd:+remaining.toFixed(4)
            });
        }

        res.json({
            engine, cycleMonth: month,
            creditPerKeyUsd: APIFY_CYCLE_CREDIT,   // default only; see keys[].creditUsd
            keys,
            totalRemainingUsd: +total.toFixed(4),
            reserveUsd: BUDGET_RESERVE,
            mode: BUDGET_MODE
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * Job state.
 *
 * The fields are returned BOTH at the top level and under `job`. The older
 * pages read `.job`, the header helper reads the top level, and that mismatch
 * meant EL.pollJob spun forever on a job it could never see the status of.
 * Serving both shapes fixes it without a flag-day frontend deploy.
 */
app.get('/api/job/:id', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        // Explicit columns. `partials` holds the full computed audit for every
        // finished unit, and select('*') was shipping it — twice, because the
        // payload is doubled for the old and new frontend shapes — on every
        // poll of a running job. Nothing in any page reads it.
        const { data, error } = await supabase.from('jobs')
            .select('id, type, engine, status, progress, current_step, error, log, ' +
                    'result, result_report_id, credits_estimate, completed_units, ' +
                    'cancel_requested, created_at, updated_at, finished_at')
            .eq('id', req.params.id).eq('user_id', ctx.user.id).maybeSingle();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Job not found' });

        // Workers store the payload once, in reports.report_json, and leave a
        // reportRef behind. Hydrate it here so every existing page keeps
        // reading job.result.report exactly as before, without the payload
        // being written to Postgres twice and shipped on the final poll.
        if (data.status === 'done' && data.result?.reportRef && !data.result.report) {
            const { data: rep } = await supabase.from('reports')
                .select('report_json').eq('id', data.result.reportRef)
                .eq('user_id', ctx.user.id).maybeSingle();
            if (rep?.report_json) data.result = { ...data.result, report: rep.report_json };
        }

        const view = {
            ...data,
            completedUnits: (data.completed_units || []).length,
            // Only registered worker types can be rebuilt from jobs.input, so
            // only they can be resumed. Surfacing it means the recovery banner
            // never has to offer a button that answers 400.
            resumable: !!JOB_WORKERS[data.type] && RESUMABLE_STATUSES.includes(data.status)
        };
        res.json({ ...view, job: view });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * Ask a running job to stop at its next unit boundary.
 *
 * The Apify run currently in flight still bills, but every unit after it does
 * not — on a ten-group audit that is most of the cost. The checkpoint is left
 * intact, so a cancelled job's completed units are reused if it is run again.
 */
app.post('/api/job/:id/cancel', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const { data: job } = await supabase.from('jobs')
            .select('id, status, completed_units').eq('id', req.params.id)
            .eq('user_id', ctx.user.id).maybeSingle();
        if (!job) return res.status(404).json({ error: 'Job not found.' });

        if (['done', 'failed', 'cancelled'].includes(job.status)) {
            return res.status(409).json({ error: `This job is already ${job.status}.` });
        }

        if (job.status === 'queued' || job.status === 'paused_no_credit' || job.status === 'interrupted') {
            await updateJob(job.id, {
                status: 'cancelled', cancel_requested: false,
                error: 'Cancelled before it resumed. Nothing further was charged.',
                finished_at: new Date().toISOString()
            }, 'Cancelled by the user');
            return res.json({ success: true, stopped: 'immediately' });
        }

        await updateJob(job.id, { cancel_requested: true }, 'Cancellation requested');
        res.json({
            success: true,
            stopped: 'at the next step',
            note: 'The step already running will finish and be billed. Nothing after it will start.',
            completed: (job.completed_units || []).length
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/jobs', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const { data } = await supabase.from('jobs')
            .select('id, type, engine, status, progress, current_step, error, credits_estimate, created_at, finished_at, cancel_requested, completed_units')
            .eq('user_id', ctx.user.id)
            .order('created_at', { ascending: false })
            .limit(30);
        res.json({
            jobs: (data || []).map(j => ({
                ...j,
                completedUnits: (j.completed_units || []).length,
                resumable: !!JOB_WORKERS[j.type] && RESUMABLE_STATUSES.includes(j.status)
            }))
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===========================================================================
// REPORTS VAULT + TREND COMPARISON
// ===========================================================================

/**
 * The Instagram vault list.
 *
 * This was `select('*')` with no platform filter and no limit — the only vault
 * endpoint that never got the treatment /api/fb/reports did. Two things went
 * wrong. Facebook community and Page reports appeared in the Instagram list,
 * and opening one handed an incompatible payload to renderReportDashboard(),
 * which reads `rep.main` and rendered a blank card. And every full
 * report_json the user had ever generated crossed the wire to draw a list of
 * names and grades.
 *
 * Columns only. Platform filtered. Capped. The payload comes from
 * /api/report/:id on click.
 */
app.get('/api/reports-history', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'report'); if (!ctx) return;
        const limit = Math.min(parseInt(req.query.limit || '100', 10), 200);

        // The platform filter landed in phase 5; the report_type filter did not,
        // so the Audit vault listed Competitor Intel runs and vice versa. Both
        // pages hit this endpoint with no parameters, so both saw everything.
        // Opening a foreign row switched tabs and rendered below the fold,
        // which looked like being bounced to the wrong page.
        //
        // No parameter keeps the old behaviour, so nothing breaks if one page
        // is deployed before the other.
        const type = String(req.query.type || '').trim();

        let q = supabase.from('reports')
            .select('id, platform, report_type, target_handle, competitor_handles, grade, score, ' +
                    'score_version, score_v1, engagement_rate, posts_analyzed, snapshot_date, ' +
                    'created_at, ai_summary, ai_status, set_id, credits_estimate, client_id, user_id')
            .eq('platform', 'instagram');
        q = (await S.applyReportScope(req, ctx))(q);

        // Legacy rows (pre phase 7) wrote 'single'/'compare' for audits and
        // 'single'/'competitor' for cohorts. set_id is the reliable tell:
        // deep_audit always creates a competitor_set, ig_report never does.
        // The fallback keeps both vaults correct even if the backfill has not
        // run yet; after it runs, only the first term ever matches.
        if (type === 'ig_report') {
            q = q.or('report_type.eq.ig_report,report_type.eq.compare,and(report_type.eq.single,set_id.is.null)');
        } else if (type === 'deep_audit') {
            q = q.or('report_type.eq.deep_audit,report_type.eq.competitor,and(report_type.eq.single,set_id.not.is.null)');
        } else if (type) {
            q = q.eq('report_type', type);
        }

        const { data: reports, error } = await q
            .order('created_at', { ascending: false })
            .limit(limit);
        if (error) throw error;
        res.status(200).json({ reports: reports || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/report/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'report'); if (!ctx) return;
        const { data } = await supabase.from('reports')
            .select('*').eq('id', req.params.id).maybeSingle();
        if (!data || !(await S.canReadReport(ctx, data))) return res.status(404).json({ error: 'Report not found' });
        res.json({ report: data });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * Re-run the strategy layer against a report that is already in the vault.
 *
 * A run whose narrative failed used to be dead: ai_json was null forever, and
 * the only way to get the strategy layer was to pay Apify to scrape the same
 * accounts again. Everything the model needs is in report_json, so this costs
 * nothing but a Gemini call.
 */
app.post('/api/report/:id/regenerate-narrative', spendLimit, async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;

        const { data: rep } = await supabase.from('reports')
            .select('id, platform, report_type, report_json')
            .eq('id', req.params.id).eq('user_id', ctx.user.id).maybeSingle();
        if (!rep) return res.status(404).json({ error: 'Report not found' });

        const engine = rep.platform === 'instagram' ? 'report'
                     : rep.report_type === 'fb_page' ? 'fb_page'
                     : 'fb_community';
        if (ctx.profile.role !== 'admin') {
            const { data: grant } = await supabase.from('user_engine_access')
                .select('id').eq('user_id', ctx.user.id).eq('engine', engine).maybeSingle();
            if (!grant) return res.status(403).json({ error: `No access to the ${engine} engine.` });
        }

        const rj = rep.report_json || {};
        let out;
        if (rep.platform === 'instagram') {
            if (!rj.main) return res.status(409).json({ error: 'This report has no stored payload to regenerate from.' });
            out = await geminiNarrative({ target: rj.main, rivals: rj.rivals || [], benchmark: rj.benchmark || null });
        } else if (rep.report_type === 'fb_page') {
            if (!rj.target) return res.status(409).json({ error: 'This report has no stored payload to regenerate from.' });
            out = await S.fbPageNarrative({ target: rj.target, rival: rj.rival || null, benchmark: rj.benchmark || null, brief: rj.brief || null });
        } else if (rj.mode === 'combined') {
            out = await S.fbNarrative({ mode: 'combined', groups: rj.groups || [], benchmark: rj.benchmark || null });
        } else if (rj.group) {
            out = await S.fbNarrative({ mode: 'single', group: rj.group });
        } else {
            return res.status(409).json({ error: 'This report shape cannot be regenerated.' });
        }

        const { ai, aiStatus } = out;
        if (!aiStatus.ok) {
            return res.status(502).json({ success: false, aiStatus, error: aiStatus.message });
        }

        const patched = { ...rj, ai, aiStatus };
        const { error } = await supabase.from('reports').update({
            ai_json: ai,
            ai_summary: ai?.executive_summary || null,
            ai_status: aiStatus,
            report_json: patched
        }).eq('id', rep.id).eq('user_id', ctx.user.id);
        if (error) throw error;

        res.json({ success: true, aiStatus, ai });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/competitor-sets', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'report'); if (!ctx) return;
        const { data } = await supabase.from('competitor_sets')
            .select('*').eq('user_id', ctx.user.id).order('created_at', { ascending: false });
        res.json({ sets: data || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * Trend comparison across snapshots of the same competitor set.
 * Every point carries its snapshot date so the UI can label the delta window.
 */
app.get('/api/set-trend/:setId', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'report'); if (!ctx) return;

        // report_json is no longer selected here. This endpoint used to pull
        // the entire payload for every snapshot in the set to read four
        // scalars off it; those four are now written onto the report row at
        // insert time.
        const { data: runs } = await supabase.from('reports')
            .select('id, snapshot_date, created_at, score, grade, engagement_rate, target_handle, ' +
                    'score_version, score_v1, followers_snapshot, posts_per_week, cohort_avg_er, target_rank')
            .eq('set_id', req.params.setId).eq('user_id', ctx.user.id)
            .order('created_at', { ascending: true });

        if (!runs || !runs.length) return res.json({ runs: [], delta: null });

        const points = runs.map(r => ({
            reportId: r.id,
            date: r.snapshot_date || r.created_at?.slice(0, 10),
            score: r.score,
            scoreVersion: r.score_version ?? 1,
            scoreV1: r.score_v1 ?? null,
            grade: r.grade,
            engagementRate: r.engagement_rate,
            postsPerWeek: r.posts_per_week ?? null,
            followers: r.followers_snapshot ?? null,
            cohortAvgEngagement: r.cohort_avg_er ?? null,
            rank: r.target_rank ?? null
        }));

        // Scoring-version discontinuity.
        //
        // reports.score holds whichever formula was live when the snapshot was
        // taken. Diffing a v1 snapshot against a v2 one reports the scoring
        // change as an account change — a healthy account reads as "down 13"
        // for reasons that have nothing to do with the account. When the
        // series is mixed, fall back to the v1 score, which every version
        // records, and say so rather than silently plotting two scales.
        const versions = [...new Set(points.map(p => p.scoreVersion))];
        const mixed = versions.length > 1;
        const comparable = mixed && points.every(p => p.scoreV1 != null);

        const scoreOf = p => (mixed && comparable) ? p.scoreV1 : p.score;
        points.forEach(p => { p.comparableScore = scoreOf(p); });

        let delta = null;
        if (points.length > 1) {
            const a = points[points.length - 2], b = points[points.length - 1];
            const days = Math.round((new Date(b.date) - new Date(a.date)) / 86400000);
            delta = {
                from: a.date, to: b.date, days,
                score: (mixed && !comparable) ? null : (scoreOf(b) || 0) - (scoreOf(a) || 0),
                engagementRate: +((b.engagementRate || 0) - (a.engagementRate || 0)).toFixed(2),
                followers: (b.followers || 0) - (a.followers || 0),
                rankChange: (a.rank && b.rank) ? a.rank - b.rank : null
            };
        }

        const scoring = {
            versions,
            mixed,
            comparable,
            basis: (mixed && comparable) ? 'score_v1' : 'score',
            note: !mixed ? null
                : comparable
                    ? 'This set spans a scoring change. The line is plotted on the original v1 scale so the snapshots stay comparable.'
                    : 'This set spans a scoring change and some snapshots predate the comparable score, so the score delta is not shown. Engagement rate, followers and rank are unaffected.'
        };

        res.json({ runs: points, delta, scoring });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/** Raw stored posts for a handle — powers post-level UI tables. */
app.get('/api/posts', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'report'); if (!ctx) return;
        const handle = String(req.query.handle || '').replace('@', '').toLowerCase().trim();
        if (!handle) return res.status(400).json({ error: 'handle required' });

        const { data } = await supabase.from('posts')
            .select('shortcode, post_url, post_type, caption, hashtags, likes, comments, views, posted_at, thumbnail_url')
            .eq('user_id', ctx.user.id).eq('handle', handle)
            .order('posted_at', { ascending: false })
            .limit(Math.min(parseInt(req.query.limit || '100', 10), 500));

        res.json({ handle, posts: data || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
