/**
 * Scheduled runs, read-only share links and the client report view.
 *
 * Part of the EdgeLead server, split out of server.js (phase 55). The parts load in
 * order from server.js and share one namespace, S: what this part needs from an earlier
 * part is unpacked below; anything else from another part is read as S.name when it runs.
 */
'use strict';
const S = require('./shared');
const {
    FRONTEND_URL, JOB_WORKERS, MAX_ACTIVE_JOBS, METRICS, UUID_RE, alertOnce, app, auth, clientAccess,
    createJob, crypto, getWorkingClient, jobUnitCount, logger, runJob, sendErr, spendLimit, supabase
} = S;
Object.assign(S, {
    scheduleNextRun, scheduleInputForRun, cleanScheduleBody, scheduleNoteOutcome, schedulerTick,
    scheduleSummary, shareUrlFor, shareToken, ordinal, clientStanding, clientPillars, clientPlanIdeas,
    clientRooms, clientReportView
});

// ===========================================================================
// PHASE 11 :: SCHEDULED RUNS
//
// A monthly report a human has to remember to click is a report that gets
// forgotten. A schedule is "re-run this job's input every week / month". It
// stores the job's *validated* input verbatim, so no engine needs a second
// validation path, and it runs through the same createJob → runJob engine as
// a click does — same budget gate, same checkpoint, same cancel/resume.
//
// Claiming a due schedule is one compare-and-set UPDATE on next_run_at (the
// job-level pattern claimJob already uses), so a second instance polling the
// same table cannot fire the same schedule twice.
// ===========================================================================

const SCHEDULER_POLL_MS   = parseInt(process.env.SCHEDULER_POLL_MS || '60000', 10);
S.SCHEDULER_POLL_MS = SCHEDULER_POLL_MS;
const SCHEDULER_ENABLED   = String(process.env.SCHEDULER_ENABLED || 'true') !== 'false';
S.SCHEDULER_ENABLED = SCHEDULER_ENABLED;
const SCHEDULE_MAX_PER_USER = parseInt(process.env.SCHEDULE_MAX_PER_USER || '25', 10);
/** Job types that are safe to re-run from their stored input alone. */
const SCHEDULABLE_TYPES = {
    ig_report:          'report',
    deep_audit:         'report',
    fb_community_audit: 'fb_community',
    fb_page_report:     'fb_page',
    meta_insights:      'content_plan',
    review_scan:        'leadgen'          // monthly: new reviews since the last scan (phase 41)
};
S.SCHEDULABLE_TYPES = SCHEDULABLE_TYPES;

/**
 * Next fire time strictly after `from`. Weekly = next `dayOfWeek` at
 * `hourUtc`; monthly = `dayOfMonth` (1–28 so every month has it) at `hourUtc`.
 * Pure, so the test suite can pin it.
 */
function scheduleNextRun(s, from = new Date()) {
    const hour = Math.min(23, Math.max(0, parseInt(s.hour_utc ?? 6, 10) || 0));
    const f = new Date(from.getTime());
    if (s.cadence === 'weekly') {
        const dow = Math.min(6, Math.max(0, parseInt(s.day_of_week ?? 1, 10) || 0));
        const d = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), f.getUTCDate(), hour, 0, 0, 0));
        let delta = (dow - d.getUTCDay() + 7) % 7;
        if (delta === 0 && d.getTime() <= f.getTime()) delta = 7;
        d.setUTCDate(d.getUTCDate() + delta);
        return d;
    }
    // monthly
    const dom = Math.min(28, Math.max(1, parseInt(s.day_of_month ?? 1, 10) || 1));
    let d = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), dom, hour, 0, 0, 0));
    if (d.getTime() <= f.getTime()) d = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth() + 1, dom, hour, 0, 0, 0));
    return d;
}

/**
 * The stored input is what the user validated when they clicked Run, with two
 * exceptions: a frozen window boundary (`since`) has to move with the calendar
 * or every monthly FB report would measure the same month forever, and the
 * schedule id is stamped so the finished job can be linked back.
 */
function scheduleInputForRun(s) {
    const input = { ...(s.input || {}) };
    if (input.days && Number(input.days) > 0) {
        input.since = new Date(Date.now() - Number(input.days) * 86400000).toISOString().slice(0, 10);
    }
    input.scheduleId = s.id;
    input.clientId = s.client_id || null;
    return input;
}

function cleanScheduleBody(b = {}) {
    const out = {};
    if (b.cadence !== undefined) {
        if (!['weekly', 'monthly'].includes(b.cadence)) throw Object.assign(new Error('cadence must be weekly or monthly'), { statusCode: 400 });
        out.cadence = b.cadence;
    }
    if (b.dayOfWeek !== undefined)  out.day_of_week  = Math.min(6, Math.max(0, parseInt(b.dayOfWeek, 10) || 0));
    if (b.dayOfMonth !== undefined) out.day_of_month = Math.min(28, Math.max(1, parseInt(b.dayOfMonth, 10) || 1));
    if (b.hourUtc !== undefined)    out.hour_utc     = Math.min(23, Math.max(0, parseInt(b.hourUtc, 10) || 0));
    if (b.label !== undefined)      out.label        = String(b.label || '').trim().slice(0, 120) || null;
    if (typeof b.paused === 'boolean') out.paused = b.paused;
    return out;
}

async function scheduleCanRead(ctx, row) {
    if (!row) return false;
    if (row.user_id === ctx.user.id) return true;
    if (row.client_id && await clientAccess(ctx.user.id, row.client_id, 'viewer')) return true;
    return false;
}
async function scheduleCanEdit(ctx, row) {
    if (!row) return false;
    if (row.user_id === ctx.user.id) return true;
    if (row.client_id && await clientAccess(ctx.user.id, row.client_id, 'editor')) return true;
    return false;
}

/** Called from runJob when a job carrying input.scheduleId settles. */
async function scheduleNoteOutcome(scheduleId, { status, reportId = null, error = null } = {}) {
    if (!scheduleId || !UUID_RE.test(String(scheduleId))) return;
    try {
        const patch = { last_status: status, updated_at: new Date().toISOString() };
        if (reportId) patch.last_report_id = reportId;
        if (error) patch.last_error = String(error).slice(0, 500);
        else if (status === 'done') patch.last_error = null;
        // A run that settles after its client was archived keeps the archive marker (phase 57):
        // unarchiving resumes only schedules marked 'archived', and this one would be left paused.
        const { data: row } = await supabase.from('schedules').select('last_status').eq('id', scheduleId).maybeSingle();
        if (row && row.last_status === 'archived') delete patch.last_status;
        await supabase.from('schedules').update(patch).eq('id', scheduleId);
    } catch (e) { logger.warn('schedule_note_failed', { scheduleId, message: e.message }); }
}

/**
 * Fire one schedule now. Every guard a click gets, a schedule gets:
 * account still active, engine still granted, job slot free, key can pay.
 * A guard that fails records why on the row and moves on — nothing is queued.
 */
async function fireSchedule(s, { manual = false } = {}) {
    const engine = SCHEDULABLE_TYPES[s.job_type];
    const factory = JOB_WORKERS[s.job_type];
    if (!engine || !factory) {
        await supabase.from('schedules').update({ last_status: 'skipped', last_error: `"${s.job_type}" cannot be scheduled.`, paused: true }).eq('id', s.id);
        return { ok: false, reason: 'unschedulable' };
    }

    const { data: profile } = await supabase.from('app_users').select('id, role, is_active').eq('id', s.user_id).maybeSingle();
    if (!profile || profile.is_active === false) {
        await supabase.from('schedules').update({ last_status: 'skipped', last_error: 'Owner account is disabled.', paused: true }).eq('id', s.id);
        return { ok: false, reason: 'owner_disabled' };
    }
    if (profile.role !== 'admin') {
        const { data: grant } = await supabase.from('user_engine_access').select('id').eq('user_id', s.user_id).eq('engine', engine).maybeSingle();
        if (!grant) {
            await supabase.from('schedules').update({ last_status: 'skipped', last_error: `Owner no longer has the ${engine} engine.`, paused: true }).eq('id', s.id);
            return { ok: false, reason: 'no_engine' };
        }
    }
    if (s.client_id) {
        const access = await clientAccess(s.user_id, s.client_id, 'editor');
        if (!access) {
            await supabase.from('schedules').update({ last_status: 'skipped', last_error: 'Owner lost edit access to the client.', paused: true }).eq('id', s.id);
            return { ok: false, reason: 'no_client' };
        }
        // An archived client runs nothing (phase 57), however the schedule was started.
        if (access.archived) {
            await supabase.from('schedules').update({ last_status: 'archived', paused: true, updated_at: new Date().toISOString() }).eq('id', s.id);
            return { ok: false, reason: 'archived' };
        }
    }

    const { count } = await supabase.from('jobs').select('id', { count: 'exact', head: true })
        .eq('user_id', s.user_id).in('status', ['queued', 'running']);
    if ((count || 0) >= MAX_ACTIVE_JOBS) {
        // Not a failure: try again in ten minutes rather than next month.
        await supabase.from('schedules').update({
            last_status: 'deferred', last_error: `${count} job(s) already running; retrying in 10 minutes.`,
            next_run_at: new Date(Date.now() + 600000).toISOString(), updated_at: new Date().toISOString()
        }).eq('id', s.id);
        return { ok: false, reason: 'busy' };
    }

    const input = scheduleInputForRun(s);
    const estimate = Number(s.credits_estimate || 0);
    const perUnit = estimate / Math.max(1, jobUnitCount({ type: s.job_type, input }));
    try {
        await getWorkingClient(engine, s.user_id, { needUsd: perUnit });
    } catch (e) {
        await supabase.from('schedules').update({
            last_status: 'skipped_no_credit', last_error: e.message, updated_at: new Date().toISOString()
        }).eq('id', s.id);
        alertOnce('schedule_no_credit:' + s.id, `Scheduled run "${s.label || s.job_type}" skipped: ${e.message}`, { scheduleId: s.id });
        return { ok: false, reason: 'no_credit' };
    }

    const job = await createJob(s.user_id, s.job_type, engine, input, estimate);
    runJob(job.id, factory(s.user_id, job.input, job.id));
    await supabase.from('schedules').update({
        last_job_id: job.id, last_status: 'started', last_error: null,
        runs: (s.runs || 0) + 1, updated_at: new Date().toISOString()
    }).eq('id', s.id);
    METRICS.jobs.scheduled = (METRICS.jobs.scheduled || 0) + 1;
    logger.info('schedule_fired', { scheduleId: s.id, jobId: job.id, type: s.job_type, manual });
    return { ok: true, jobId: job.id };
}

let _schedulerBusy = false;
async function schedulerTick() {
    if (!SCHEDULER_ENABLED || _schedulerBusy || S._shuttingDown) return;
    _schedulerBusy = true;
    try {
        const nowIso = new Date().toISOString();
        const { data: due, error } = await supabase.from('schedules').select('*')
            .eq('paused', false).lte('next_run_at', nowIso)
            .order('next_run_at', { ascending: true }).limit(5);
        if (error) { logger.warn('scheduler_read_failed', { message: error.message }); return; }
        for (const s of (due || [])) {
            // Compare-and-set claim: whoever advances next_run_at owns this fire.
            const next = scheduleNextRun(s, new Date()).toISOString();
            const { data: claimed } = await supabase.from('schedules')
                .update({ next_run_at: next, last_run_at: nowIso, updated_at: nowIso })
                .eq('id', s.id).eq('next_run_at', s.next_run_at)
                .select('id').maybeSingle();
            if (!claimed) continue;
            try { await fireSchedule(s); }
            catch (e) {
                logger.error('schedule_fire_failed', { scheduleId: s.id, message: e.message });
                await supabase.from('schedules').update({ last_status: 'failed', last_error: e.message }).eq('id', s.id);
            }
        }
    } catch (e) {
        logger.error('scheduler_tick_failed', { message: e.message });
    } finally { _schedulerBusy = false; }
}

/** Create a schedule from a job the caller ran (by job id, or the report it produced). */
app.post('/api/schedules', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const { jobId, reportId } = req.body || {};
        let q = supabase.from('jobs').select('id, user_id, type, engine, input, client_id, credits_estimate, status').eq('user_id', ctx.user.id);
        if (jobId && UUID_RE.test(String(jobId))) q = q.eq('id', jobId);
        else if (reportId && UUID_RE.test(String(reportId))) q = q.eq('result_report_id', reportId);
        else return res.status(400).json({ error: 'jobId or reportId required.' });
        const { data: job } = await q.order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (!job) return res.status(404).json({ error: 'That run was not found in your jobs. Only runs you started can be scheduled.' });
        if (!SCHEDULABLE_TYPES[job.type]) return res.status(400).json({ error: `"${job.type}" runs cannot be scheduled.` });

        const { count } = await supabase.from('schedules').select('id', { count: 'exact', head: true }).eq('user_id', ctx.user.id);
        if ((count || 0) >= SCHEDULE_MAX_PER_USER) return res.status(429).json({ error: `You already have ${count} schedules. Delete one first.` });

        const fields = cleanScheduleBody(req.body || {});
        const row = {
            user_id: ctx.user.id,
            client_id: job.client_id || null,
            job_type: job.type, engine: job.engine,
            input: (() => { const i = { ...(job.input || {}) }; delete i.scheduleId; return i; })(),
            credits_estimate: job.credits_estimate || 0,
            cadence: fields.cadence || 'monthly',
            day_of_week: fields.day_of_week ?? 1,
            day_of_month: fields.day_of_month ?? 1,
            hour_utc: fields.hour_utc ?? 6,
            label: fields.label || null,
            source_job_id: job.id,
            paused: false
        };
        row.next_run_at = scheduleNextRun(row).toISOString();
        const { data, error } = await supabase.from('schedules').insert([row]).select().single();
        if (error) throw error;
        res.status(201).json({ success: true, schedule: data });
    } catch (err) { sendErr(res, err); }
});

app.get('/api/schedules', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        let q = supabase.from('schedules').select('*');
        const cid = req.query?.client_id;
        if (cid) {
            const c = await clientAccess(ctx.user.id, cid, 'viewer');
            if (!c) return res.status(403).json({ error: 'No access to that client.' });
            q = q.eq('client_id', c.id);
        } else {
            q = q.eq('user_id', ctx.user.id);
        }
        const { data, error } = await q.order('next_run_at', { ascending: true }).limit(200);
        if (error) throw error;
        res.json({ schedules: (data || []).map(s => ({ ...s, mine: s.user_id === ctx.user.id, input: undefined, summary: scheduleSummary(s) })) });
    } catch (err) { sendErr(res, err); }
});

/** A one-line description of what a schedule re-runs, built from its input. */
function scheduleSummary(s) {
    const i = s.input || {};
    switch (s.job_type) {
        case 'ig_report':          return `IG audit @${i.target}${(i.rivals || []).length ? ' vs ' + i.rivals.map(r => '@' + r).join(', ') : ''}`;
        case 'deep_audit':         return `Competitor Intel @${i.target} vs ${(i.competitors || []).length} rival(s)`;
        case 'fb_community_audit': return `Community audit · ${(i.groupNames || i.groups || []).length} room(s) · ${i.days}d`;
        case 'fb_page_report':     return `FB Page report · ${i.target}${i.rival ? ' vs ' + i.rival : ''} · ${i.days}d`;
        case 'meta_insights':      return `Meta owner sync`;
        default:                   return s.job_type;
    }
}

app.patch('/api/schedules/:id', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const { data: row } = await supabase.from('schedules').select('*').eq('id', req.params.id).maybeSingle();
        if (!row || !(await scheduleCanEdit(ctx, row))) return res.status(404).json({ error: 'Schedule not found.' });
        const patch = cleanScheduleBody(req.body || {});
        const merged = { ...row, ...patch };
        if (patch.cadence || patch.day_of_week !== undefined || patch.day_of_month !== undefined || patch.hour_utc !== undefined || patch.paused === false) {
            patch.next_run_at = scheduleNextRun(merged).toISOString();
        }
        patch.updated_at = new Date().toISOString();
        const { data, error } = await supabase.from('schedules').update(patch).eq('id', row.id).select().single();
        if (error) throw error;
        res.json({ success: true, schedule: { ...data, input: undefined, summary: scheduleSummary(data) } });
    } catch (err) { sendErr(res, err); }
});

app.post('/api/schedules/:id/run-now', spendLimit, async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const { data: row } = await supabase.from('schedules').select('*').eq('id', req.params.id).maybeSingle();
        if (!row || !(await scheduleCanEdit(ctx, row))) return res.status(404).json({ error: 'Schedule not found.' });
        const r = await fireSchedule(row, { manual: true });
        if (!r.ok) {
            const { data: after } = await supabase.from('schedules').select('last_error').eq('id', row.id).maybeSingle();
            return res.status(r.reason === 'no_credit' ? 402 : 409).json({ error: after?.last_error || 'Could not start.', reason: r.reason });
        }
        res.status(202).json({ success: true, jobId: r.jobId });
    } catch (err) { sendErr(res, err); }
});

app.delete('/api/schedules/:id', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const { data: row } = await supabase.from('schedules').select('id, user_id, client_id').eq('id', req.params.id).maybeSingle();
        if (!row || !(await scheduleCanEdit(ctx, row))) return res.status(404).json({ error: 'Schedule not found.' });
        await supabase.from('schedules').delete().eq('id', row.id);
        res.json({ success: true });
    } catch (err) { sendErr(res, err); }
});

// ===========================================================================
// PHASE 11 :: READ-ONLY REPORT SHARE LINKS
//
// A link the client can open beats a PDF attachment. The token is the whole
// secret: 192 random bits, base64url, stored plain (it is not a password —
// anyone holding it can already read the report). Links expire, can be
// revoked, and count views so a freelancer can see whether the client looked.
// The public route returns the report row with ownership fields stripped and
// nothing else — no client list, no vault, no job state.
// ===========================================================================

const SHARE_DEFAULT_DAYS = parseInt(process.env.SHARE_DEFAULT_DAYS || '30', 10);
S.SHARE_DEFAULT_DAYS = SHARE_DEFAULT_DAYS;
const SHARE_MAX_DAYS     = parseInt(process.env.SHARE_MAX_DAYS || '365', 10);
S.SHARE_MAX_DAYS = SHARE_MAX_DAYS;
// publicLimit is declared beside spendLimit and readLimit near the top of the
// file. It was here once, after routes that use it — a const read before its
// line is a ReferenceError at load, which node --check cannot see.

/** Which page renders which report type. Server is the contract; pages conform. */
const REPORT_PAGE = {
    ig_report: 'ig-report.html', single: 'ig-report.html', compare: 'ig-report.html',
    deep_audit: 'ig-competitors.html', competitor: 'ig-competitors.html',
    fb_page: 'fb-report.html',
    fb_community: 'fb-audit.html', fb_group: 'fb-audit.html',
    content_plan: 'content-plan.html', meta_owned: 'content-plan.html',
    public_monthly: 'report.html',
    review_scan: 'report.html'
};
S.REPORT_PAGE = REPORT_PAGE;

/**
 * Every share link points at one client-facing page, not at the employee page
 * that happens to render that report type.
 *
 * Sending them to ig-report.html put a client inside the agency's workbench
 * with a read-only bar over it, and shipped every pillar score and rival
 * handle along with the link.
 *
 * REPORT_PAGE above no longer has a caller because of this change. It is kept
 * rather than deleted because it is the only record of which employee page
 * renders which report type, which is what an in-app "open this report" link
 * would need — but nothing reads it today.
 */
function shareUrlFor(row, token) {
    const base = FRONTEND_URL || '';
    return `${base}/share.html?share=${encodeURIComponent(token)}`;
}

function shareToken() { return crypto.randomBytes(24).toString('base64url'); }

// ===========================================================================
// CLIENT REPORT VIEW  (phase 14)
//
// The same report, said differently. Not a subset and not a dumbed-down copy:
// the employee report answers "what is the state of this account and what do I
// do about it", and a business owner is asking something narrower — am I doing
// well, how do I compare to businesses like mine, and what should I change.
//
// Nothing here is scraped or computed fresh. Every number already exists in
// reports.report_json because the employee report needed it; this reads the
// same row and chooses different words.
// ===========================================================================

/**
 * Plain-language readings of each score pillar. IG and FB Page emit the same
 * breakdown shape, so one table covers both.
 *
 * `strong` and `weak` are written to be true at a glance without the number —
 * an owner should be able to skip every figure on the page and still leave
 * knowing what to do.
 */
const CLIENT_PILLARS = {
    'Engagement per follower': {
        strong: 'The people following you actually react to what you post.',
        weak:   'Most of your followers scroll past without reacting.',
        why:    'This is the clearest sign you have the right audience rather than just a large one.'
    },
    'Posting cadence': {
        strong: 'You post often enough to stay in front of people.',
        weak:   'You are not posting often enough to stay visible.',
        why:    'Accounts that go quiet get shown to fewer people, and it takes weeks to recover.'
    },
    'Consistency': {
        strong: 'You post on a steady rhythm rather than in bursts.',
        weak:   'Your posting comes in bursts with long gaps between.',
        why:    'A long silence resets your reach, so five posts in a week then nothing beats nothing then five.'
    },
    'Conversation': {
        strong: 'People comment, not just tap like.',
        weak:   'People tap like but rarely comment.',
        why:    'Comments are worth far more than likes — they are what puts a post in front of new people.'
    },
    'Reach': {
        strong: 'Your posts are being seen well beyond your own followers.',
        weak:   'Your posts are mostly only reaching people who already follow you.',
        why:    'Reaching past your followers is how the account grows without paying for it.'
    },
    'Amplification': {
        strong: 'People share your posts on.',
        weak:   'Your posts are rarely shared.',
        why:    'A share puts you in front of someone who trusts the person sharing.'
    },
    'Format range': {
        strong: 'You use a good mix of post types.',
        weak:   'You lean on one type of post.',
        why:    'Different formats reach different people, and a single format caps how far you go.'
    },
    'Profile completeness': {
        strong: 'Your profile tells a visitor who you are and how to reach you.',
        weak:   'Your profile is missing things a visitor needs to contact you.',
        why:    'Someone who likes a post and visits your profile should never have to search for how to buy.'
    },
    'Momentum adjustment': {
        strong: 'Your numbers are moving in the right direction.',
        weak:   'Your numbers are drifting down month over month.',
        why:    'The direction matters more than the size — a small account climbing beats a bigger one sliding.'
    }
};
S.CLIENT_PILLARS = CLIENT_PILLARS;

function ordinal(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return null;
    const s = ['th', 'st', 'nd', 'rd'], m = v % 100;
    return v + (s[(m - 20) % 10] || s[m] || s[0]);
}

/**
 * How the account sits against the businesses it was compared with. This is
 * the question owners ask first and it is the one the employee report answers
 * least directly, because it buries it in a ranked table of handles.
 */
function clientStanding(row, bench, main) {
    const ranked = Array.isArray(bench.ranked) ? bench.ranked : [];
    const rank   = row.target_rank ?? (ranked.find(r => r.isTarget) || {}).rank ?? null;
    const of     = ranked.length || (bench.cohort && bench.cohort.accounts) || null;

    const yours  = parseFloat(row.engagement_rate ?? main.engagementRate ?? NaN);
    const avg    = parseFloat(row.cohort_avg_er ?? (bench.cohort || {}).avgEngagementRate ?? NaN);
    const haveEr = Number.isFinite(yours) && Number.isFinite(avg);

    let verdict = null;
    if (rank && of) {
        if (rank === 1)       verdict = `You are ahead of every business you were compared with.`;
        else if (rank === of) verdict = `You are behind the other ${of - 1} businesses you were compared with.`;
        else                  verdict = `You come ${ordinal(rank)} out of ${of} businesses like yours.`;
    }

    let gapLine = null;
    if (haveEr) {
        const diff = yours - avg;
        const pct  = Math.abs(diff).toFixed(2);
        gapLine = Math.abs(diff) < 0.05
            ? 'Your engagement is level with the others — no real gap either way.'
            : `For every 100 followers, you get about ${pct} ${diff > 0 ? 'more' : 'fewer'} reactions on a typical post than they do.`;
    }

    return {
        rank, of,
        verdict,
        gap: gapLine,
        yours: haveEr ? +yours.toFixed(2) : null,
        peer_average: haveEr ? +avg.toFixed(2) : null,
        ahead: haveEr ? yours >= avg : null,
        peers: ranked.map(r => ({
            name: r.isTarget ? 'You' : (r.handle ? '@' + r.handle : 'A similar business'),
            position: r.rank,
            is_you: !!r.isTarget
        }))
    };
}

/**
 * Splits the score pillars into what is working and what to change.
 *
 * The thresholds are deliberately wide apart. A pillar sitting mid-range is
 * neither a win nor a problem, and listing it as either would pad the page
 * with things the owner cannot act on.
 */
function clientPillars(breakdown) {
    const working = [], fix = [];
    for (const p of (Array.isArray(breakdown) ? breakdown : [])) {
        const copy = CLIENT_PILLARS[p.pillar];
        if (!copy || !p.max) continue;
        // A pillar that could not be measured is not a failing one.
        if (/not enough|no view counts|no trend/i.test(String(p.detail || ''))) continue;

        const share = Number(p.points) / Number(p.max);
        if (share >= 0.7)      working.push({ title: copy.strong, why: copy.why });
        else if (share <= 0.4) fix.push({ title: copy.weak, why: copy.why });
    }
    return { working, fix };
}

/**
 * A content plan, said to the person who has to make the posts.
 *
 * The employee plan is a scorecard of format x opening x length x topic cells
 * with a damped index on each. An owner does not run cells; they need to know
 * what to film on Tuesday. So the briefs come through with their script and
 * shot intact, and the cell machinery stays behind.
 */
function clientPlanIdeas(j) {
    const spec = Array.isArray(j.formatSpec) ? j.formatSpec : [];
    const out = [];

    for (const f of spec) {
        for (const b of (j.briefs?.[f.plural] || [])) {
            out.push({
                format: f.label || f.plural,
                concept: b.concept || null,
                hook: b.hook || null,
                script: Array.isArray(b.script) ? b.script : [],
                shot: b.shot || null,
                caption: b.caption || null,
                when: b.slot || null,
                // The band, never the index. "Likely to do well" is actionable;
                // "predicted index 1.28" invites an argument about the number.
                outlook: b.predicted_band || null,
                boost: b.boost === 'worth boosting' ? 'Worth putting money behind' : 'Post it organically',
                boost_why: b.boost_why || null
            });
        }
    }
    return out;
}

/**
 * A community audit, said to the business whose customers are in those rooms.
 *
 * Room value scores, unique-poster ratios and admin shares are how an agency
 * decides where to spend an afternoon. An owner wants to know which rooms are
 * worth being in and what people there are asking for.
 */
function clientRooms(row, j) {
    const names = Array.isArray(row.fb_group_names) ? row.fb_group_names : [];
    const rooms = Array.isArray(j.rooms) ? j.rooms : Array.isArray(j.audits) ? j.audits : [];

    if (rooms.length) {
        return rooms.slice(0, 12).map(r => ({
            name: r.name || r.group_name || 'A local group',
            members: r.member_count ?? r.members ?? null,
            // Three bands, because an owner is deciding whether to join, not
            // ranking twelve rooms against each other.
            worth: (r.room_value_score ?? r.roomValue ?? 0) >= 60 ? 'Worth being in'
                 : (r.room_value_score ?? r.roomValue ?? 0) >= 35 ? 'Worth a look'
                 : 'Quiet for you',
            posts_read: r.posts ?? r.postsAnalysed ?? null
        }));
    }
    // Older reports stored only the names.
    return names.slice(0, 12).map(n => ({ name: n, members: null, worth: null, posts_read: null }));
}

function clientReportView(row) {
    if (!row) return null;
    const j     = row.report_json || {};
    const main  = j.main || {};
    const bench = j.benchmark || {};

    const score = row.score ?? main.score ?? null;
    const band  = score === null ? null
                : score >= 80 ? 'strong'
                : score >= 65 ? 'healthy'
                : score >= 50 ? 'mixed'
                : score >= 35 ? 'weak'
                : 'poor';

    const HEADLINE = {
        strong:  'Your account is in good shape.',
        healthy: 'Your account is healthy, with one clear thing to fix.',
        mixed:   'Your account works, but it is underperforming for its size.',
        weak:    'There are some basics to fix before anything else will help.',
        poor:    'The fundamentals need attention first.'
    };

    // A plan and a community audit answer different questions from an audit,
    // so they get their own opening line rather than a score-band verdict.
    const isPlan  = row.report_type === 'content_plan';
    const isRooms = row.report_type === 'fb_community' || row.report_type === 'fb_group';
    const ideas   = isPlan  ? clientPlanIdeas(j)      : [];
    const rooms   = isRooms ? clientRooms(row, j)     : [];

    // A Facebook Page report and the two owner-side Meta reports carry their
    // findings in the narrative, not in an Instagram score breakdown. Until
    // phase 26 they fell through to the Instagram path and came out as an
    // empty page with a generic headline — "check their business report in
    // FB and Instagram" was half-built. The page draws {title, why} points,
    // a headline and a summary; that is what they become.
    const isFb    = row.report_type === 'fb_page';
    const isMeta  = row.report_type === 'meta_owned' || row.report_type === 'meta_monthly';
    const ai      = row.ai_json || j.ai || {};
    const li      = (arr, why) => (Array.isArray(arr) ? arr : []).filter(Boolean).slice(0, 6).map(t => ({ title: String(t), why }));
    const first   = t => String(t || '').split(/(?<=[.!?])\s+/)[0] || null;

    let { working, fix } = (isFb || isMeta)
        ? { working: [], fix: [] }
        : clientPillars(main.scoreBreakdown || main.breakdown || j.breakdown);
    if (isFb) {
        working = li(ai.what_is_working, 'Keep doing this');
        fix     = [...li(ai.what_is_failing, 'What held the Page back'), ...li(ai.quick_wins, 'Quick to do')];
    } else if (row.report_type === 'meta_owned') {
        working = li(ai.what_is_working, 'From your own numbers');
        fix     = [...li(ai.what_is_not, 'What is not landing'), ...li(ai.next_30_days, 'Next 30 days')];
    } else if (row.report_type === 'meta_monthly') {
        working = li(ai.what_worked, 'This month');
        fix     = [...li(ai.what_did_not, 'What did not'), ...li(ai.next_month, 'Next month')];
    }
    const narrativeHeadline = isFb
        ? (ai.state_of_the_page || first(ai.executive_summary) || 'Here is how your Page is doing.')
        : row.report_type === 'meta_monthly'
            ? (ai.headline || `${j.monthLabel || 'The month'} in review.`)
        : isMeta
            ? (first(ai.executive_summary) || 'Here is what your own numbers say.')
        : null;

    // Profile gaps are the cheapest wins on the page and the easiest for an
    // owner to action without help, so they are surfaced separately rather
    // than folded into the completeness pillar.
    const pc      = main.profileCompleteness || main.completeness || {};
    const missing = Array.isArray(pc.checks)
        ? pc.checks.filter(c => !c.ok).map(c => c.label)
        : [];

    const provisional = !!(main.lowConfidence || j.lowConfidence);

    return {
        id: row.id,
        type: row.report_type,
        title: S.CLIENT_REPORT_TITLES[row.report_type] || 'Report',
        platform: row.platform,
        handle: row.target_handle,
        date: row.snapshot_date || (row.created_at || '').slice(0, 10),
        posts_looked_at: row.posts_analyzed ?? null,

        headline: isPlan
                    ? (ideas.length ? `${ideas.length} things to post next.` : 'Your content plan.')
                : isRooms
                    ? (rooms.length ? `${rooms.length} local groups where your customers are talking.`
                                    : 'Your community report.')
                : narrativeHeadline
                    ? narrativeHeadline
                : band ? HEADLINE[band] : 'Here is how your account is doing.',
        band: isPlan || isRooms || isMeta ? null : band,

        // Present only on the type they belong to, so a page can render what
        // it is given without knowing the report types.
        ideas,
        rooms,
        // The letter grade is kept because it travels well in conversation;
        // the raw score is not, because a number out of 100 invites an
        // argument about the number instead of the finding.
        grade: row.grade || main.grade || null,

        provisional,
        provisional_note: provisional
            ? 'There were not many recent posts to look at, so treat this as a first read rather than a verdict.'
            : null,

        // A Page report's benchmark and an owner report have no peer table in
        // the Instagram shape; guessing one would put a made-up rank on the page.
        standing: (isFb || isMeta) ? null : clientStanding(row, bench, main),

        // Month-over-month movement, present only on a monthly report.
        movements: row.report_type === 'meta_monthly'
            ? (Array.isArray(j.deltas) ? j.deltas : []).map(d => ({ label: d.label, now: d.now, before: d.before ?? null, pct: d.pct ?? null, kind: d.kind }))
            : [],

        working,
        fix,

        profile: {
            complete_pct: pc.score ?? pc.percent ?? null,
            missing
        },

        summary: ((isFb || isMeta) && ai.executive_summary) || row.ai_summary || null,
        followers: row.followers_snapshot ?? main.followers ?? null,
        posts_per_week: row.posts_per_week ?? null,

        // The monthly report as the agency's document (phase 34). The routes
        // that open one report add its context; a list never pays for it.
        month: S.monthlyView(row),
        // The agency's document for the other report types (phase 36).
        doc: S.reportDoc(row)
    };
}
