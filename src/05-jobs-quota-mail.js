/**
 * The job engine, quotas and outbound mail.
 *
 * Part of the EdgeLead server, split out of server.js (phase 55). The parts load in
 * order from server.js and share one namespace, S: what this part needs from an earlier
 * part is unpacked below; anything else from another part is read as S.name when it runs.
 */
'use strict';
const S = require('./shared');
const {
    ALLOWED, APIFY_TIMEOUT_SECS, AUTH_CACHE_MS, COST_PER_1K_POSTS, COST_PER_1K_PROFILE, ELS,
    JOB_STALE_MINUTES, MAX_ACTIVE_JOBS, METRICS, accountState, alertOnce, decryptSecret, logger, supabase
} = S;
Object.assign(S, {
    quotaPeriod, invalidateQuotaCaps, contactSettings, cleanPaymentOption, mailSettings, sendMail,
    mailStatus, appUrl, mailActivationRequested, mailActivated, mailNewTrial, trialDaysSetting,
    effectiveCap, quotaError, takeLeadQuota, refundLeadQuota, createJob, assertJobSlot, claimJob,
    jobUnitCount, updateJob, runJob, registerWorker, sweepStaleJobs, keepAwakeIfBusy,
    sweepStaleReservations, estimateCredits
});
Object.defineProperty(S, '_mailTransport', { get: () => _mailTransport, set: (v) => { _mailTransport = v; }, enumerable: true });

// ===========================================================================
// JOB ENGINE
// ===========================================================================

// ===========================================================================
// QUOTA  (phase 13)
//
// Engine access decides whether an account may touch a tool at all. Quota
// decides how much of it they get. The two stay separate on purpose: a trial
// client without the content_plan grant never reaches this layer, and a client
// who has the grant is still held to a ceiling.
//
// Item caps assume a run costs about what a run usually costs. The usd cap is
// the one that actually protects the shared pool, because a runaway actor
// breaks that assumption without exceeding any item count.
// ===========================================================================

/**
 * Job types where one run is one countable item. Leadgen is absent on purpose:
 * a campaign's cost is the leads it writes, which is not known when the job is
 * created, so it is metered at insert time instead. Anything not listed here
 * is still held to the usd cap.
 */
const JOB_QUOTA_METRIC = {
    ig_report:          'ig_report',
    deep_audit:         'ig_report',
    fb_community_audit: 'fb_group_audit',
    fb_discovery:       'fb_group_audit'
};
S.JOB_QUOTA_METRIC = JOB_QUOTA_METRIC;

const LEADGEN_JOB_TYPES = new Set(['leadgen_campaign', 'leadgen_enrich', 'fb_lead_discovery']);
S.LEADGEN_JOB_TYPES = LEADGEN_JOB_TYPES;

const QUOTA_DEFAULT_KEY = { trial: 'trial_caps', paid: 'client_monthly_caps' };

/**
 * Used only when system_settings holds nothing parseable. Fails closed: an
 * unreadable setting must not read as "no limit", which is exactly the case
 * where the pool gets drained.
 */
const QUOTA_FALLBACK = {
    trial: { ig_report: 1, fb_group_audit: 1, leads: 50,  usd: 2 },
    paid:  { ig_report: 4, fb_group_audit: 4, leads: 500, usd: 25 }
};
S.QUOTA_FALLBACK = QUOTA_FALLBACK;

/**
 * The counter a state writes to. Trial spend lives in its own bucket so a
 * trial cap and a monthly cap never share a counter, and nothing has to be
 * reset when an account converts.
 */
function quotaPeriod(state) {
    if (state === 'trial') return 'trial';
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Authoritative state, from the database rather than the auth cache. */
async function accountStateDb(userId) {
    const { data, error } = await supabase.rpc('el_account_state', { p_user: userId });
    if (error) {
        logger.error('account_state_unavailable', { message: error.message });
        const err = new Error('Could not verify your account. Try again in a moment.');
        err.statusCode = 503;
        throw err;
    }
    return data || 'expired';
}

const _capsCache = new Map();
function invalidateQuotaCaps() { _capsCache.clear(); }

async function defaultCaps(state) {
    const key = QUOTA_DEFAULT_KEY[state];
    if (!key) return null;                       // admin and employee are uncapped by default
    const hit = _capsCache.get(key);
    if (hit && Date.now() - hit.t < AUTH_CACHE_MS) return hit.v;

    const { data } = await supabase.from('system_settings').select('value').eq('key', key).maybeSingle();
    let v;
    try {
        v = data?.value ? JSON.parse(data.value) : null;
    } catch (e) {
        logger.warn('quota_caps_unparsable', { key, message: e.message });
        v = null;
    }
    if (!v || typeof v !== 'object') v = QUOTA_FALLBACK[state] || QUOTA_FALLBACK.trial;

    _capsCache.set(key, { v, t: Date.now() });
    return v;
}

/**
 * The contact email and the ways to pay, as the admin set them. (phase 27)
 *
 * Money is collected outside the product by decision — which only works if
 * the client is told where to send it. These are read by every place a
 * client is asked to continue, and by the privacy and terms pages. Cached
 * with the caps; PATCH /api/admin/settings clears the same cache.
 */
async function contactSettings() {
    const hit = _capsCache.get('contact');
    if (hit && Date.now() - hit.t < AUTH_CACHE_MS) return hit.v;
    const { data } = await supabase.from('system_settings').select('key, value').in('key', ['contact_email', 'payment_options']);
    const raw = Object.fromEntries((data || []).map(r => [r.key, r.value]));
    let options = [];
    try { const p = raw.payment_options ? JSON.parse(raw.payment_options) : []; options = Array.isArray(p) ? p : []; } catch { options = []; }
    const v = { email: String(raw.contact_email || '').trim(), paymentOptions: options };
    _capsCache.set('contact', { v, t: Date.now() });
    return v;
}

/** One way to pay, cleaned. Null if there is nothing usable in it. */
function cleanPaymentOption(o) {
    if (!o || typeof o !== 'object') return null;
    const label = String(o.label || '').trim().slice(0, 40);
    const details = String(o.details || '').trim().slice(0, 300);
    const url = String(o.url || '').trim().slice(0, 300);
    if (!label && !details) return null;
    if (url && !/^https?:\/\//i.test(url)) return { error: `"${label || details}" has a link that is not http(s).` };
    return { label: label || 'Pay', details, ...(url ? { url } : {}) };
}


// ===========================================================================
// OUTBOUND MAIL (phase 29)
//
// One Gmail account of the agency's, with an app password, set in Admin →
// Trial & plans. Three messages and nothing else: a business starts a trial
// (to the agency), a client asks to continue (to the agency), an admin
// activates a plan (to the client). Mail is a courtesy on top of a request
// that already succeeded, so nothing here ever throws into a route — the
// result says what happened and the admin page shows the last outcome.
//
// The app password is sealed with the same key as the Apify tokens and is
// never sent back to a browser; the settings endpoint says only that one is
// saved. Gmail's own ceiling is about 500 messages a day, which is a large
// multiple of what three notifications will ever produce.
// ===========================================================================
const MAIL_KEYS = ['mail_from', 'mail_from_name', 'mail_notify_to', 'mail_app_password'];
S.MAIL_KEYS = MAIL_KEYS;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
S.EMAIL_RE = EMAIL_RE;
const _mailState = { lastSentAt: null, lastError: null, lastTo: null, sent: 0 };
let _mailTransport = null;   // { sig, transport } — rebuilt when the settings change

async function mailSettings() {
    const hit = _capsCache.get('mail');
    if (hit && Date.now() - hit.t < AUTH_CACHE_MS) return hit.v;
    const { data } = await supabase.from('system_settings').select('key, value').in('key', MAIL_KEYS);
    const raw = Object.fromEntries((data || []).map(r => [r.key, r.value]));
    let password = '';
    if (raw.mail_app_password) {
        try { password = String(decryptSecret(raw.mail_app_password) || ''); }
        catch (e) { logger.error('mail_password_unreadable', { message: e.message }); password = ''; }
    }
    const from = String(raw.mail_from || '').trim().toLowerCase();
    const v = {
        from,
        fromName: String(raw.mail_from_name || '').trim().slice(0, 60) || 'EdgeLead',
        notifyTo: String(raw.mail_notify_to || '').trim().toLowerCase() || from,
        password,
        configured: !!(from && password)
    };
    _capsCache.set('mail', { v, t: Date.now() });
    return v;
}

function mailInstalled() {
    try { require('nodemailer'); return true; } catch { return false; }
}

function mailTransportFor(s) {
    const sig = `${s.from}\n${s.password}`;
    if (_mailTransport && _mailTransport.sig === sig) return _mailTransport.transport;
    let nodemailer;
    try { nodemailer = require('nodemailer'); }
    catch { throw new Error('nodemailer is not installed on the server — run npm install and redeploy.'); }
    const transport = nodemailer.createTransport({
        host: 'smtp.gmail.com', port: 465, secure: true,
        auth: { user: s.from, pass: s.password },
        connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000
    });
    _mailTransport = { sig, transport };
    return transport;
}

/** Send one message. Never throws. */
async function sendMail({ to, subject, text }) {
    const s = await mailSettings();
    if (!s.configured) return { ok: false, skipped: true, error: 'Email is not set up (Admin → Trial & plans → Email).' };
    const addr = String(to || '').trim().toLowerCase();
    if (!EMAIL_RE.test(addr)) return { ok: false, error: `"${addr}" is not an email address.` };
    try {
        const info = await mailTransportFor(s).sendMail({
            from: `"${s.fromName.replace(/["\r\n]/g, '')}" <${s.from}>`,
            to: addr,
            subject: String(subject || '').replace(/[\r\n]+/g, ' ').slice(0, 200),
            text: String(text || '')
        });
        Object.assign(_mailState, { lastSentAt: new Date().toISOString(), lastError: null, lastTo: addr, sent: _mailState.sent + 1 });
        logger.info('mail_sent', { to: addr, subject, id: info?.messageId || null });
        return { ok: true, id: info?.messageId || null };
    } catch (e) {
        _mailState.lastError = `${new Date().toISOString()} — ${e.message}`;
        logger.error('mail_failed', { to: addr, subject, message: e.message });
        return { ok: false, error: e.message };
    }
}

/** What the admin page shows about mail: everything except the password. */
async function mailStatus() {
    const s = await mailSettings();
    return {
        from: s.from, fromName: s.fromName, notifyTo: s.notifyTo,
        hasPassword: !!s.password, configured: s.configured, installed: mailInstalled(),
        lastSentAt: _mailState.lastSentAt, lastError: _mailState.lastError, sent: _mailState.sent
    };
}

/** Where the pages live, for links in mail. FRONTEND_URL, else the first allowed origin. */
function appUrl() {
    if (S.FRONTEND_URL) return S.FRONTEND_URL;
    const o = ALLOWED.find(x => /^https?:\/\//i.test(x));
    return o ? o.replace(/\/+$/, '') : '';
}

function fmtDay(iso) {
    const d = iso ? new Date(iso) : null;
    return d && !isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : 'a date not on file';
}

/** A trial client asked to continue → the agency. */
async function mailActivationRequested(ctx, note) {
    const s = await mailSettings();
    if (!s.configured) return { ok: false, skipped: true };
    const own = await S.ownClientFor(ctx).catch(() => null);
    const email = ctx.user.email || ctx.profile.email || '';
    const ended = accountState(ctx.profile) === 'expired';
    const base = appUrl();
    return sendMail({
        to: s.notifyTo,
        subject: `${email} wants to continue on EdgeLead`,
        text: [
            `${email}${own?.name && own.name !== email ? ` (${own.name})` : ''} asked to continue.`,
            '',
            `Their trial ${ended ? 'ended' : 'ends'} ${fmtDay(ctx.profile.trial_ends_at)}.`,
            note ? `Their note: "${note}"` : 'They left no note.',
            '',
            base ? `Activate them: ${base}/admin.html` : 'Activate them from Admin → People.',
            '',
            '— EdgeLead'
        ].join('\n')
    });
}

/** An admin activated a plan → the client. */
async function mailActivated(target, { planLabel, paidUntil }) {
    const s = await mailSettings();
    if (!s.configured) return { ok: false, skipped: true };
    const { data: u } = await supabase.from('app_users').select('email, role, plan_label').eq('id', target).maybeSingle();
    if (!u?.email || u.role !== 'client') return { ok: false, skipped: true };
    const c = await contactSettings();
    const base = appUrl();
    const label = planLabel || u.plan_label || 'Your plan';
    return sendMail({
        to: u.email,
        subject: 'Your EdgeLead plan is active',
        text: [
            `${label} is active on your EdgeLead account until ${fmtDay(paidUntil)}.`,
            '',
            base ? `Sign in: ${base}/client.html` : 'Sign in as usual.',
            c.email ? `Questions: ${c.email}` : null,
            '',
            '— EdgeLead'
        ].filter(l => l !== null).join('\n')
    });
}

/** A business signed itself up → the agency. */
async function mailNewTrial(email, trialEndsAt) {
    const s = await mailSettings();
    if (!s.configured) return { ok: false, skipped: true };
    const base = appUrl();
    return sendMail({
        to: s.notifyTo,
        subject: `New trial on EdgeLead: ${email}`,
        text: [
            `${email} just started a free trial. It ends ${fmtDay(trialEndsAt)}.`,
            '',
            base ? `See them: ${base}/admin.html` : null,
            '— EdgeLead'
        ].filter(l => l !== null).join('\n')
    });
}

/** Length of the free trial, in days. Read once per cache window. */
async function trialDaysSetting() {
    const hit = _capsCache.get('trial_days');
    if (hit && Date.now() - hit.t < AUTH_CACHE_MS) return hit.v;

    const { data } = await supabase.from('system_settings')
        .select('value').eq('key', 'trial_days').maybeSingle();
    const n = parseInt(data?.value ?? '', 10);
    const v = Number.isFinite(n) && n > 0 && n <= 365 ? n : 7;

    _capsCache.set('trial_days', { v, t: Date.now() });
    return v;
}

/**
 * null means unlimited. A usage_limits row wins even when its cap is null,
 * which is how one client gets exempted from one metric without being
 * exempted from all of them.
 */
async function effectiveCap(userId, state, metric) {
    const { data } = await supabase.from('usage_limits')
        .select('cap').eq('user_id', userId).eq('metric', metric).maybeSingle();
    if (data) return data.cap === null ? null : Number(data.cap);

    const caps = await defaultCaps(state);
    if (!caps) return null;
    const c = caps[metric];
    return (c === undefined || c === null) ? null : Number(c);
}

async function quotaUsed(userId, period, metric) {
    const { data } = await supabase.from('usage_counters')
        .select('used').eq('user_id', userId).eq('period', period).eq('metric', metric).maybeSingle();
    return Number(data?.used || 0);
}

function quotaError(metric, cap) {
    const label = {
        ig_report:      'Instagram report',
        fb_group_audit: 'group audit',
        leads:          'lead',
        usd:            'usage'
    }[metric] || metric;
    const err = new Error(
        metric === 'usd'
            ? `This would exceed your usage allowance. Contact us to raise it.`
            : `You have used your ${label} allowance (${cap}). Contact us to raise it.`
    );
    err.statusCode = 402;
    // 402 covers both "your account lapsed" and "you hit your allowance", and
    // those are very different things to be told. The code is what lets the
    // client surface tell them apart — without it a client who runs out of
    // leads is shown "your access has ended", which is simply false.
    err.code = 'quota_exceeded';
    err.quotaMetric = metric;
    return err;
}

/**
 * Take quota for a job before it is queued. Everything taken is rolled back if
 * a later metric refuses, so a job that cannot start never leaves a dent in
 * the counters.
 *
 * Returns what was taken, which createJob records on the job so the failure
 * path can hand it back.
 */
async function reserveQuota(userId, type, creditsEstimate) {
    const state = await accountStateDb(userId);
    if (state === 'suspended' || state === 'expired') {
        const err = new Error(
            state === 'suspended'
                ? 'Account disabled. Contact your administrator.'
                : 'Your access has ended. Contact us to continue.'
        );
        err.statusCode = state === 'suspended' ? 403 : 402;
        err.code = state === 'suspended' ? 'account_suspended' : 'account_expired';
        throw err;
    }

    const period  = quotaPeriod(state);
    const wanted  = [];

    const metric = JOB_QUOTA_METRIC[type];
    if (metric) wanted.push({ metric, amount: 1 });

    const usd = Number(creditsEstimate) || 0;
    if (usd > 0) wanted.push({ metric: 'usd', amount: usd });

    // A leadgen run writes its leads later, so there is nothing to take here.
    // Refuse up front anyway when the allowance is already gone, rather than
    // letting a job start, spend on Apify, and then fail to save what it found.
    if (LEADGEN_JOB_TYPES.has(type)) {
        const cap = await effectiveCap(userId, state, 'leads');
        if (cap !== null && await quotaUsed(userId, period, 'leads') >= cap) {
            throw quotaError('leads', cap);
        }
    }

    const taken = [];
    for (const w of wanted) {
        const cap = await effectiveCap(userId, state, w.metric);
        if (cap === null) continue;
        const { error } = await supabase.rpc('el_quota_consume', {
            p_user: userId, p_period: period, p_metric: w.metric, p_amount: w.amount, p_cap: cap
        });
        if (error) {
            for (const back of taken) {
                await supabase.rpc('el_quota_release', {
                    p_user: userId, p_period: period, p_metric: back.metric, p_amount: back.amount
                }).catch(() => {});
            }
            if (String(error.message || '').includes('quota_exceeded')) throw quotaError(w.metric, cap);
            throw error;
        }
        taken.push(w);
    }

    return { period, taken };
}

/**
 * Leads are metered as they are written rather than when the job is queued,
 * because a campaign cannot know how many it will find. Returns how many of
 * `want` may be saved, having already taken that many from the allowance.
 *
 * Deliberately partial: finding 80 leads against 50 of allowance saves 50 and
 * warns, rather than refusing the batch. The scrape is already paid for by
 * then, so throwing away all 80 would waste money that has left the account.
 */
async function takeLeadQuota(userId, want) {
    if (!(want > 0)) return 0;

    const state = await accountStateDb(userId);
    if (state === 'suspended' || state === 'expired') return 0;

    const cap = await effectiveCap(userId, state, 'leads');
    if (cap === null) return want;

    const period = quotaPeriod(state);
    const room   = Math.max(0, cap - await quotaUsed(userId, period, 'leads'));
    const take   = Math.min(want, room);
    if (take <= 0) return 0;

    const { error } = await supabase.rpc('el_quota_consume', {
        p_user: userId, p_period: period, p_metric: 'leads', p_amount: take, p_cap: cap
    });
    if (error) {
        // A concurrent run took the room between the read and the write. Not an
        // error worth failing the job over: save none this pass and let the
        // caller say so.
        if (String(error.message || '').includes('quota_exceeded')) return 0;
        throw error;
    }
    return take;
}

/** Give back lead allowance taken for rows that then failed to save. */
async function refundLeadQuota(userId, amount) {
    if (!(amount > 0)) return;
    try {
        const state = await accountStateDb(userId);
        await supabase.rpc('el_quota_release', {
            p_user: userId, p_period: quotaPeriod(state), p_metric: 'leads', p_amount: amount
        });
    } catch (e) {
        logger.warn('lead_quota_refund_failed', { message: e.message });
    }
}

/** Hand back what a job reserved. Never throws — a failing job is already bad news. */
async function releaseQuota(userId, reservation) {
    if (!reservation || !Array.isArray(reservation.taken)) return;
    for (const t of reservation.taken) {
        try {
            await supabase.rpc('el_quota_release', {
                p_user: userId, p_period: reservation.period, p_metric: t.metric, p_amount: t.amount
            });
        } catch (e) {
            logger.warn('quota_release_failed', { metric: t.metric, message: e.message });
        }
    }
}

async function createJob(userId, type, engine, input, creditsEstimate) {
    // Every job in the product comes through here, which is the only reason a
    // ceiling is worth having: no route can forget to ask.
    const reservation = await reserveQuota(userId, type, creditsEstimate);

    const { data, error } = await supabase.from('jobs').insert([{
        user_id: userId, type, engine,
        // _quota rides on input because the failure path needs to know what to
        // hand back, and the period can roll over between queue and failure.
        input: { ...(input || {}), _quota: reservation },
        client_id: (input && S.UUID_RE.test(String(input.clientId || ''))) ? input.clientId : null,
        credits_estimate: creditsEstimate || null,
        status: 'queued', progress: 0, log: [],
        completed_units: []
    }]).select().single();

    if (error) {
        await releaseQuota(userId, reservation);
        throw error;
    }
    return data;
}

/** Refuse to queue a fifth thing while four are already spending money. */
async function assertJobSlot(userId) {
    const { count } = await supabase.from('jobs')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .in('status', ['queued', 'running']);
    if ((count || 0) >= MAX_ACTIVE_JOBS) {
        const err = new Error(
            `You already have ${count} job(s) running. Wait for them to finish before starting another.`
        );
        err.statusCode = 429;
        throw err;
    }
}

/**
 * Record a finished unit AND the analysis it produced.
 *
 * Storing the computed result, not just the unit name, is what makes resume
 * actually free. The scraped rows are already in `posts` / `fb_posts`, but the
 * audit object also needs profile-level numbers that are not reconstructable
 * from the post rows alone. Persisting it here means a resumed job never has to
 * re-scrape, and therefore never pays twice.
 */
let _rpcCheckpointAvailable = true;
async function savePartial(jobId, unit, value) {
    if (!jobId || !unit) return;
    const key = String(unit);

    // Append inside Postgres. The old read-modify-write was safe only because
    // a job processed one unit at a time; the moment two units overlap, or a
    // resumed job races the sweep, the losing write silently drops a completed
    // unit and the user pays to scrape it twice.
    if (_rpcCheckpointAvailable) {
        try {
            const { error } = await supabase.rpc('el_job_checkpoint', {
                p_job_id: jobId, p_unit: key,
                p_value: value === undefined ? null : value
            });
            if (!error) return;
            _rpcCheckpointAvailable = false;
            logger.warn('rpc_checkpoint_unavailable', { message: error.message });
        } catch (e) {
            _rpcCheckpointAvailable = false;
            logger.warn('rpc_checkpoint_unavailable', { message: e.message });
        }
    }

    try {
        const { data } = await supabase.from('jobs')
            .select('completed_units, partials').eq('id', jobId).maybeSingle();
        const done = Array.isArray(data?.completed_units) ? data.completed_units : [];
        const partials = (data?.partials && typeof data.partials === 'object') ? data.partials : {};
        if (!done.includes(key)) done.push(key);
        if (value !== undefined) partials[key] = value;
        await supabase.from('jobs')
            .update({ completed_units: done, partials, updated_at: new Date().toISOString() })
            .eq('id', jobId);
    } catch (e) { logger.error('save_partial_failed', { jobId, message: e.message }); }
}

/** The states a job can be picked back up from. Shared so the resume endpoint
 *  and the claim can never disagree about what is resumable. */
const RESUMABLE_STATUSES = ['paused_no_credit', 'interrupted', 'failed', 'cancelled'];
S.RESUMABLE_STATUSES = RESUMABLE_STATUSES;

/**
 * Take exclusive ownership of a job before running it.
 *
 * The status check and the status write used to be two separate statements, so
 * a double-clicked Resume — or the same job resumed on two Render instances —
 * passed the check twice and ran the worker twice against one checkpoint. Both
 * copies then scraped the same pending units and both were billed.
 *
 * One conditional UPDATE is the claim. Whoever flips the row out of the
 * expected set wins; every other caller gets zero rows back and stops. This is
 * the job-level equivalent of what budget reservations already do at the key
 * level.
 */
async function claimJob(jobId, fromStatuses, { resume = false } = {}) {
    const patch = {
        status: 'running',
        error: null,
        cancel_requested: false,
        updated_at: new Date().toISOString()
    };
    if (!resume) patch.progress = 1;

    const { data, error } = await supabase.from('jobs')
        .update(patch)
        .eq('id', jobId)
        .in('status', fromStatuses)
        .select('id')
        .maybeSingle();

    if (error) throw error;
    return !!data;
}

/**
 * How many billable units a job's input describes.
 *
 * Resume needs this to price ONE remaining unit rather than the whole run. The
 * old divisor was `groups.length || competitors.length || 1`, and three job
 * types carry neither key, so it fell through to 1 and demanded the entire job
 * estimate be free on a single key before it would restart a run that was nine
 * tenths paid for.
 */
function jobUnitCount(job) {
    const i = job?.input || {};
    switch (job?.type) {
        case 'ig_report':          return 1 + (Array.isArray(i.rivals) ? i.rivals.length : 0);
        case 'deep_audit':         return 1 + (Array.isArray(i.competitors) ? i.competitors.length : 0);
        case 'fb_community_audit': return Math.max(1, (i.groups || []).length);
        case 'fb_discovery':       return Math.max(1, (i.seeds || []).length || Number(i.maxGroups) || 1);
        case 'fb_page_report':     return i.rival ? 2 : 1;
        case 'fb_verify':          return 1;
        case 'leadgen_campaign':   return Math.max(1, S.leadgenUnits(i).length);
        case 'leadgen_enrich':     return Math.max(1, Math.ceil((Number(i.batchSize) || 25) / 25));
        default:                   return 1;
    }
}

/**
 * Cooperative cancellation.
 *
 * An Apify run already in flight cannot be recalled, but the unit boundary is
 * where the money is: stopping before group 6 of 10 saves 5 units of credit.
 * Workers check this through the progress callback, so no worker needs to know
 * cancellation exists.
 */
class JobCancelled extends Error {
    constructor() { super('Cancelled'); this.name = 'JobCancelled'; this.code = 'CANCELLED'; }
}

/**
 * One progress tick: cancellation check, log append and progress write.
 *
 * This was three round trips — a select for cancel_requested, then updateJob's
 * select for the log, then the update — on every step of every job. Folding
 * the two reads together also means the cancellation decision and the log line
 * come from the same snapshot, and closes the read-modify-write on `log` that
 * dropped a line whenever two writes overlapped.
 */
async function jobTick(jobId, progress, step) {
    const { data } = await supabase.from('jobs')
        .select('cancel_requested, status, log').eq('id', jobId).maybeSingle();
    if (!data) return;
    if (data.cancel_requested || data.status === 'cancelled') throw new JobCancelled();

    const log = Array.isArray(data.log) ? data.log : [];
    if (step) log.push({ t: new Date().toISOString(), m: step });

    await supabase.from('jobs').update({
        progress,
        current_step: step,
        log: log.slice(-100),
        updated_at: new Date().toISOString()
    }).eq('id', jobId);
}

async function updateJob(jobId, patch, logLine) {
    const body = { ...patch, updated_at: new Date().toISOString() };
    if (logLine) {
        const { data: cur } = await supabase.from('jobs').select('log').eq('id', jobId).maybeSingle();
        const log = Array.isArray(cur?.log) ? cur.log : [];
        log.push({ t: new Date().toISOString(), m: logLine });
        body.log = log.slice(-100);
    }
    await supabase.from('jobs').update(body).eq('id', jobId);
}

/**
 * Fire-and-forget runner. Never awaited by the request handler.
 *
 * The worker receives (progress, ck) where ck is the checkpoint helper:
 *   ck.isDone(unit)  - was this unit already scraped in an earlier attempt?
 *   ck.done(unit)    - record a unit as finished and paid for
 *   ck.units         - the raw completed list
 *
 * When every key runs dry the job does NOT fail. It parks in
 * 'paused_no_credit' with its checkpoint intact, so updating a key and calling
 * /api/job/:id/resume picks up exactly where it stopped and never pays twice
 * for work already in the database.
 */
/**
 * The jobs this process is running (phase 54). On a deploy Render starts the new
 * instance before it stops the old one, so for a while both run jobs. Shutdown
 * used to park every running job in the table — including the ones the new
 * instance had just claimed — and resuming those started a second paid copy.
 * Now an instance parks only its own.
 */
const LOCAL_JOBS = new Set();
S.LOCAL_JOBS = LOCAL_JOBS;

function runJob(jobId, worker, opts = {}) {
    LOCAL_JOBS.add(String(jobId));
    (async () => {
        let beat = null;
        let row = null;
        try {
            // Claim BEFORE reading the checkpoint. Losing the claim means some
            // other process already owns this job, and the correct action is to
            // do nothing at all rather than run a second copy of it.
            const claimed = opts.claimed === true || await claimJob(
                jobId,
                opts.resume ? RESUMABLE_STATUSES : ['queued'],
                { resume: !!opts.resume }
            );
            if (!claimed) {
                LOCAL_JOBS.delete(String(jobId));
                logger.warn('job_claim_lost', { jobId, resume: !!opts.resume });
                return;
            }

            row = (await supabase.from('jobs')
                .select('completed_units, partials, user_id, input').eq('id', jobId).maybeSingle()).data;
            const units = Array.isArray(row?.completed_units) ? row.completed_units.slice() : [];
            const partials = (row?.partials && typeof row.partials === 'object') ? { ...row.partials } : {};

            const ck = {
                units, partials,
                isDone: u => units.includes(String(u)),
                get:    u => partials[String(u)],
                done: async (u, value) => {
                    const key = String(u);
                    if (!units.includes(key)) units.push(key);
                    if (value !== undefined) partials[key] = value;
                    await savePartial(jobId, key, value);
                }
            };

            const jobT0 = Date.now();
            if (opts.resume) METRICS.jobs.resumed += 1; else METRICS.jobs.started += 1;
            logger.info(opts.resume ? 'job_resumed' : 'job_started',
                { jobId, completedUnits: units.length });

            // The status write moved into claimJob above, where it is atomic.
            // This is only the log line.
            await updateJob(jobId, {},
                opts.resume ? `Resuming, ${units.length} unit(s) already complete` : 'Job started');

            // A unit that is one long actor call emits no progress tick for up
            // to APIFY_RUN_TIMEOUT_SECS. Without a heartbeat, sweepStaleJobs()
            // cannot tell that job apart from one killed by a restart, and it
            // parks a live run as resumable.
            beat = setInterval(() => {
                supabase.from('jobs')
                    .update({ updated_at: new Date().toISOString() })
                    .eq('id', jobId).eq('status', 'running')
                    .then(() => {}, () => {});
            }, 60000);
            beat.unref?.();

            // Every progress tick is also a cancellation checkpoint, which is
            // why workers get this for free without knowing about it.
            const progressFn = (progress, step) => jobTick(jobId, progress, step);

            const result = await ELS.run({ userId: row?.user_id || null }, () => worker(progressFn, ck));

            METRICS.jobs.done += 1;
            logger.info('job_done', { jobId, ms: Date.now() - jobT0, units: units.length });

            await updateJob(jobId, {
                status: 'done', progress: 100,
                result, result_report_id: result?.reportId || null,
                finished_at: new Date().toISOString()
            }, 'Job complete');
            if (row?.input?.scheduleId) S.scheduleNoteOutcome(row.input.scheduleId, { status: 'done', reportId: result?.reportId || null });
        } catch (err) {
            if (err && err.code === 'CANCELLED') {
                METRICS.jobs.cancelled += 1;
                logger.info('job_cancelled', { jobId });
                await updateJob(jobId, {
                    status: 'cancelled',
                    cancel_requested: false,
                    error: 'Cancelled. Anything already scraped was saved and will be reused if you run this again.',
                    finished_at: new Date().toISOString()
                }, 'Cancelled by the user');
                return;
            }
            if (err && err.code === 'NO_CREDIT') {
                METRICS.jobs.paused += 1;
                logger.warn('job_paused_no_credit', { jobId, message: err.message });
                await updateJob(jobId, {
                    status: 'paused_no_credit',
                    error: err.message
                }, 'Paused: ' + err.message);
                if (row?.input?.scheduleId) S.scheduleNoteOutcome(row.input.scheduleId, { status: 'paused_no_credit', error: err.message });
                return;
            }
            METRICS.jobs.failed += 1;
            logger.error('job_failed', { jobId, message: err.message, stack: (err.stack || '').slice(0, 600) });
            alertOnce('job_failed:' + (err.message || '').slice(0, 40),
                `A job failed: ${err.message}`, { jobId });
            await updateJob(jobId, {
                status: 'failed', error: err.message,
                finished_at: new Date().toISOString()
            }, 'Failed: ' + err.message);
            // Terminal failure only. paused_no_credit, interrupted and cancelled
            // all return above because they are resumable — handing their quota
            // back would let the resumed run take it a second time.
            await releaseQuota(row?.user_id, row?.input?._quota);
            if (row?.input?.scheduleId) S.scheduleNoteOutcome(row.input.scheduleId, { status: 'failed', error: err.message });
        } finally {
            LOCAL_JOBS.delete(String(jobId));
            if (beat) clearInterval(beat);
        }
    })();
}

// ---------------------------------------------------------------------------
// WORKER REGISTRY
// Jobs run in-process. Render spins the free tier down on idle and restarts on
// every deploy, so a worker has to be rebuildable from jobs.input alone in
// order for resume to survive a restart.
// ---------------------------------------------------------------------------
const JOB_WORKERS = {};
S.JOB_WORKERS = JOB_WORKERS;
function registerWorker(type, factory) { JOB_WORKERS[type] = factory; }

/**
 * Anything left 'running' with no heartbeat is orphaned by a restart. Park it
 * so the UI stops spinning and the user can resume it by hand.
 */
const AUTO_RESUME = String(process.env.AUTO_RESUME_JOBS || 'true') !== 'false';
S.AUTO_RESUME = AUTO_RESUME;
const AUTO_RESUME_MAX = parseInt(process.env.AUTO_RESUME_MAX_ATTEMPTS || '2', 10);
const _autoResumeTries = new Map();

// A job id not seen in a day is finished, one way or another. _authCache and
// the rate-limit buckets both get swept; this one never was.
setInterval(() => {
    if (_autoResumeTries.size > 500) _autoResumeTries.clear();
}, 86400000).unref?.();

async function sweepStaleJobs() {
    const cutoff = new Date(Date.now() - JOB_STALE_MINUTES * 60000).toISOString();
    try {
        const { data } = await supabase.from('jobs')
            .select('id, type, user_id, input, completed_units')
            .in('status', ['running', 'queued'])
            .lt('updated_at', cutoff);

        const resumed = [];
        for (const j of (data || [])) {
            const n = Array.isArray(j.completed_units) ? j.completed_units.length : 0;
            // Every job type is registered as of phase 6, so canResume is now
            // true for all of them. The check stays because a job row written
            // by an older build can still carry a type this process does not
            // know, and telling its owner to resume would produce a 400.
            const canResume = !!JOB_WORKERS[j.type];
            await updateJob(j.id, {
                status: 'interrupted',
                error: 'The server restarted while this job was running. ' +
                       (!canResume
                           ? 'This job type cannot be resumed — start a new run.'
                           : n ? `${n} unit(s) were already saved — resume to finish the rest.`
                               : 'Nothing was charged. Resume to start again.')
            }, 'Interrupted by a server restart');

            // Pick it back up without waiting for a human to click Resume.
            //
            // The checkpoint makes this safe: claimJob() is a single
            // conditional UPDATE so only one process can win it, and every
            // completed unit is skipped rather than re-scraped. Leaving the
            // job parked meant a user who closed their laptop came back to a
            // dead run they had to restart by hand.
            if (AUTO_RESUME && canResume) {
                const tries = (_autoResumeTries.get(j.id) || 0) + 1;
                _autoResumeTries.set(j.id, tries);
                if (tries > AUTO_RESUME_MAX) {
                    logger.warn('auto_resume_giving_up', { jobId: j.id, tries });
                    await updateJob(j.id, {}, 'Auto-resume gave up after repeated interruptions — resume manually.');
                    continue;
                }
                try {
                    const factory = JOB_WORKERS[j.type];
                    runJob(j.id, factory(j.user_id, j.input || {}, j.id), { resume: true });
                    resumed.push(j.id);
                } catch (e) {
                    logger.error('auto_resume_failed', { jobId: j.id, message: e.message });
                }
            }
        }
        if (data?.length) {
            METRICS.jobs.interrupted += data.length;
            METRICS.jobs.autoResumed = (METRICS.jobs.autoResumed || 0) + resumed.length;
            logger.warn('jobs_interrupted', {
                count: data.length, ids: data.map(j => j.id), autoResumed: resumed.length
            });
            if (resumed.length < data.length) {
                alertOnce('jobs_interrupted',
                    `${data.length - resumed.length} job(s) were orphaned by a restart and could not be auto-resumed.`);
            }
        }
    } catch (e) { logger.error('sweep_failed', { message: e.message }); }
}

/**
 * Keep the instance awake while work is in flight.
 *
 * Render's free tier spins a web service down on absence of INBOUND HTTP. The
 * job heartbeat writes to Supabase, which is outbound and does not count, so
 * until now the only thing keeping a running job alive was the user's browser
 * polling it. Close the laptop mid-run and the instance slept, the Apify call
 * in flight was billed and produced nothing, and the job sat dead until
 * somebody came back and pressed Resume.
 *
 * One request to our own /api/health is inbound traffic and resets the idle
 * timer. It only fires when there is actually a job running.
 */
const SELF_URL = (process.env.SELF_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
S.SELF_URL = SELF_URL;
const KEEPALIVE_MS = parseInt(process.env.KEEPALIVE_MS || '240000', 10);
S.KEEPALIVE_MS = KEEPALIVE_MS;

async function keepAwakeIfBusy() {
    if (!SELF_URL) return;
    try {
        const { data } = await supabase.from('jobs')
            .select('id').in('status', ['running', 'queued']).limit(1);
        if (!data?.length) return;
        const r = await fetch(SELF_URL + '/api/health', { method: 'GET' });
        logger.debug('keepalive_ping', { status: r.status, jobs: data.length });
    } catch (e) {
        logger.debug('keepalive_failed', { message: e.message });
    }
}

/**
 * Release reservations left behind by a process that died mid-run.
 *
 * A reservation holds credit against the cycle on purpose — that is what stops
 * two runs double-spending the same key. But if the server is killed between
 * reserving and settling, that hold never clears and the key looks poorer than
 * it is until the month rolls over. Anything older than the maximum possible
 * run is by definition abandoned: the actor cannot still be going.
 */
async function sweepStaleReservations() {
    const cutoff = new Date(Date.now() - (APIFY_TIMEOUT_SECS + 300) * 1000).toISOString();
    try {
        const { data, error } = await supabase.from('apify_usage_events')
            .delete().eq('is_reservation', true).lt('created_at', cutoff)
            .select('id, usage_usd');
        if (error) throw error;
        if (data?.length) {
            const usd = data.reduce((sum, r) => sum + Number(r.usage_usd || 0), 0);
            logger.warn('reservations_released', { count: data.length, usd: +usd.toFixed(4) });
        }
    } catch (e) {
        // A missing is_reservation column means the phase 3 migration has not
        // run yet. Reservations are simply not in use, so there is nothing to
        // sweep and nothing to warn about on every tick.
        logger.debug('reservation_sweep_skipped', { message: e.message });
    }
}

function estimateCredits(accounts, postsPerAccount) {
    const posts = accounts * postsPerAccount;
    return +(((posts / 1000) * COST_PER_1K_POSTS) + ((accounts / 1000) * COST_PER_1K_PROFILE)).toFixed(4);
}
