/**
 * EDGELEAD :: SHARED HEADER + AUTH RUNTIME  (phase 11)
 * ---------------------------------------------------------------------------
 * Drop this on any page:
 *
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 *   <script src="header.js"></script>
 *   <script>
 *     EL.init({ engine: 'report', page: 'ig-competitors.html' }).then(me => { ... });
 *   </script>
 *
 * CONTRACT (pages conform to this; the server is the API contract):
 *   EL.init(opts)            session gate, nav, status pill, client picker.
 *                            In share mode (?share=<token>) it needs no session,
 *                            renders a read-only bar and resolves { shared: true }.
 *   EL.api(path, opts)       bearer fetch. Adds `clientId` to POST bodies and
 *                            `client_id` to GET queries for the selected client.
 *   EL.runJob / EL.pollJob   start + follow a job; pause/cancel banners for free.
 *   EL.currentClient()       selected client row or null.
 *   EL.clientBody()          { clientId } for hand-built POST bodies.
 *   EL.clientQuery(prefix)   '?client_id=…' / '&client_id=…' / '' for hand-built GETs.
 *   EL.reportParam()         ?report=<id> deep link, or null.
 *   EL.isShared()            true when the page was opened from a share link.
 *   EL.loadShared()          { report, client, shared } from the public endpoint.
 *   EL.reportActions(mount, { reportId, jobId })
 *                            Share-link + Repeat-on-schedule toolbar under a report.
 *   EL.escape / EL.safeUrl   XSS helpers every page must use for scraped text.
 *
 * All header CSS is namespaced `el-` so it cannot collide with page styles.
 * ---------------------------------------------------------------------------
 */
(function () {
    'use strict';

    // The browser's install prompt fires once, early, and only if nobody has
    // called preventDefault on it yet — so it is caught here at parse time
    // and offered later, from the client pages, when there is a place for it.
    let _installEvt = null;
    if (typeof window.addEventListener === 'function') window.addEventListener('beforeinstallprompt', e => {
        e.preventDefault();
        _installEvt = e;
        const b = document.getElementById('el-install-go');
        if (b) b.textContent = 'Add to home screen';
    });

    const SUPABASE_URL = 'https://sasbwgollyjpwegsbrty.supabase.co';
    const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNhc2J3Z29sbHlqcHdlZ3NicnR5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4Mjg1MjEsImV4cCI6MjEwMTQwNDUyMX0.Ha6uDWqzC-T1Q49TE8WaqyjulPLntwt-2dSaknVtuKY';
    const BACKEND_URL = 'https://leadgen-backend-1-mgzc.onrender.com';
    const CLIENT_KEY = 'el-client-id';

    // Shown as a "Contact us" button to accounts whose access has lapsed.
    // Left empty on purpose: set it to a real support address and the button
    // appears; leave it blank and the screen simply has no mail link.
    const SUPPORT_EMAIL = '';

    /**
     * Wake the backend the moment this file runs, not when the first real
     * request needs it.
     *
     * Render's free tier sleeps an idle service, and the next request pays a
     * cold start measured in tens of seconds. Every page used to hit that wall
     * at EL.init → /api/me, after the HTML, CSS and fonts had already loaded —
     * so the wait was serial and the screen sat empty through all of it.
     *
     * Firing here overlaps the cold start with everything else the page is
     * doing. On a warm backend it costs one cheap request; on a cold one it
     * buys back however long the rest of the page takes to render.
     *
     * Deliberately unauthenticated and deliberately ignored: this is a wake-up
     * call, not a health check, and nothing should wait on it or fail from it.
     */
    const _wokeAt = Date.now();
    let _backendCold = false;          // set once the wake-up call comes back slow
    try {
        fetch(BACKEND_URL + '/api/health', { method: 'GET', cache: 'no-store', keepalive: true })
            .then(() => { _backendCold = Date.now() - _wokeAt > 2500; })
            .catch(() => { _backendCold = true; });
    } catch { /* fetch unavailable */ }

    /**
     * Grouped, because twelve flat items is a list you read rather than a menu
     * you scan. The groups are the three things somebody is actually here to
     * do — look at Instagram, look at Facebook, or run the business — so the
     * eye lands on the right third before it reads a single label.
     *
     * Icon and label are separate fields so the icons can sit in a fixed
     * column and the labels start on one line. Emoji have wildly different
     * widths; inlined into the label string they left the text ragged.
     */
    const NAV = [
        { group: 'Instagram' },
        { href: 'index.html',          icon: '🎯', label: 'Lead Finder',       engine: 'leadgen' },
        { href: 'leads.html',          icon: '📋', label: 'Lead List',         engine: 'leadgen' },
        { href: 'ig-report.html',      icon: '📊', label: 'Performance Audit', engine: 'report'  },
        { href: 'ig-competitors.html', icon: '🥊', label: 'Competitor Intel',  engine: 'report'  },

        { group: 'Facebook' },
        { href: 'fb-report.html',      icon: '📘', label: 'Page Report',       engine: 'fb_page' },
        { href: 'fb-communities.html', icon: '🏘', label: 'Communities',       engine: 'fb_community' },
        { href: 'fb-audit.html',       icon: '🔬', label: 'Community Audit',   engine: 'fb_community' },
        { href: 'fb-leads.html',       icon: '🎣', label: 'Demand Feed',       engine: 'fb_community' },
        { href: 'fb-advisor.html',     icon: '✍️', label: 'Post Advisor',      engine: 'fb_community' },

        { group: 'Workspace' },
        { href: 'assistant.html',      icon: '💬', label: 'Analyst',           engine: null },
        { href: 'monthly.html',        icon: '📅', label: 'Monthly Report',   engine: 'meta_owned' },
        { href: 'content-plan.html',   icon: '🧭', label: 'Content Plan',      engine: 'content_plan' },
        { href: 'clients.html',        icon: '👥', label: 'Clients',           engine: null },
        { href: 'schedules.html',      icon: '⏱',  label: 'Schedules',         engine: null },
        { href: 'admin.html',          icon: '🛠', label: 'Admin',             adminOnly: true }
    ];

    /**
     * What a client sees. A client is not an employee with fewer grants — the
     * employee nav is a workbench of eleven tools, and handing that to a
     * business owner buries the one page they came for.
     *
     * Engine filtering still applies on top, so a client without a grant does
     * not see the tab either.
     */
    /**
     * Pages where somebody presses Run. These carry the "filing under" bar
     * at the top, because the sidebar picker on its own was not enough: with
     * it tucked in the footer, 15 of 16 reports on the live database were
     * filed under nothing. The bar puts the question where the button is.
     *
     * Kept as one explicit list, and the wiring audit checks it against the
     * pages that actually POST to a job route — the same discipline as the
     * engine list, for the same reason.
     */
    const WORK_PAGES = [
        'index.html', 'ig-report.html', 'ig-competitors.html',
        'fb-report.html', 'fb-communities.html', 'fb-audit.html', 'fb-advisor.html',
        'content-plan.html',
        'leads.html'        // Facebook Page discovery starts from the Lead List
    ];

    const CLIENT_NAV = [
        { href: 'client.html',           icon: '📊', label: 'My Reports',   engine: null },
        { href: 'client-assistant.html', icon: '💬', label: 'Ask',          engine: null },
        { href: 'client-leads.html',     icon: '🎯', label: 'Find Leads',   engine: 'leadgen' },
        { href: 'client-community.html', icon: '🏘', label: 'Local Demand', engine: 'fb_community' }
    ];


    // phase 10/11 additions to the shell

    const EL = {
        BACKEND_URL,
        supabase: null,
        session: null,
        user: null,
        me: null,          // { id, email, role, engines[] }
        engine: 'leadgen',
        _shared: null,     // { token } when opened from a share link

        /** Always resolves a live token, refreshing the session if it expired. */
        async token() {
            if (!EL.supabase) throw new Error('This is a read-only shared view.');
            const { data } = await EL.supabase.auth.getSession();
            if (!data.session) { EL.signOut(); throw new Error('Session expired'); }
            EL.session = data.session;
            return data.session.access_token;
        },

        /**
         * fetch wrapper: bearer token, JSON in/out, server error message
         * surfaced. Phase 10: the selected client rides along automatically —
         * `clientId` on JSON bodies, `client_id` on GET query strings — so no
         * page can forget to file a run under the client again.
         */
        /** The API origin, for the rare page that must fetch before EL.init. */
        backendUrl() { return BACKEND_URL; },

        async api(path, opts = {}) {
            const method = String(opts.method || 'GET').toUpperCase();
            const isPublic = path.startsWith('/api/public/');
            const headers = { ...(opts.headers || {}) };
            if (!isPublic) headers['Authorization'] = `Bearer ${await EL.token()}`;

            let body = opts.body;
            const cid = EL.clientId();
            if (body && typeof body !== 'string') {
                if (cid && body.clientId === undefined && body.client_id === undefined) body = { ...body, clientId: cid };
                headers['Content-Type'] = 'application/json';
                body = JSON.stringify(body);
            }
            let url = `${BACKEND_URL}${path}`;
            if (method === 'GET' && cid && !isPublic && !/[?&]client_id=/.test(path)) {
                url += (path.includes('?') ? '&' : '?') + 'client_id=' + encodeURIComponent(cid);
            }
            const res = await fetch(url, { ...opts, method, headers, body });

            let data = null;
            try { data = await res.json(); } catch { /* empty body */ }

            if (res.status === 401 && !isPublic) { EL.signOut(); throw new Error('Session expired. Sign in again.'); }
            // 402 covers two different things. A lapsed account is terminal and
            // gets the whole screen. A hit allowance is not — the account is
            // fine, this one action is not available — so it is thrown for the
            // page to show in place, and blockExpired stays out of the way.
            if (res.status === 402 && !isPublic) {
                const lapsed = !data || data.state === 'expired' || data.code === 'account_expired';
                if (lapsed) {
                    blockExpired(data);
                    const err = new Error((data && data.error) || 'Your access has ended.');
                    err.status = 402; err.data = data; err.handled = true;
                    throw err;
                }
                const err = new Error((data && data.error) || 'That is not available on your plan.');
                err.status = 402; err.data = data; err.quota = true;
                throw err;
            }
            // A disabled account is terminal, like a lapsed one, and gets the
            // whole screen. Without this it fell through to the generic error
            // and EL.init labelled it "Backend unreachable" — the right message
            // under the wrong heading, which reads as our fault, not theirs.
            if (res.status === 403 && data && data.code === 'account_suspended' && !isPublic) {
                renderShell(null, null);
                block('Account disabled', data.error || 'This account has been disabled. Contact your administrator.');
                const err = new Error(data.error || 'Account disabled.');
                err.status = 403; err.data = data; err.code = data.code; err.handled = true;
                throw err;
            }
            if (!res.ok) {
                const err = new Error((data && (data.error || data.message)) || `Request failed (${res.status})`);
                err.status = res.status; err.data = data;
                if (data && data.code) err.code = data.code;
                // The server is the one that refuses work with no client; the
                // page only points at where to fix it. Every page passes
                // through here, so no page has to remember to.
                if (err.code === 'client_required') EL._nudgeClient();
                throw err;
            }
            return data;
        },

        /** Remaining Apify credit across every key this user can draw from. */
        async budget(engine) {
            try { return await EL.api(`/api/budget?engine=${encodeURIComponent(engine || EL.engine)}`); }
            catch { return null; }
        },

        /** Opens the "Update Apify key" dialog from anywhere. */
        openKeyModal() { openKeyModal(); },

        /**
         * Polls a job to completion and handles the pause states for you.
         *
         * A job that runs out of Apify credit no longer fails — it parks in
         * `paused_no_credit` with everything it already scraped checkpointed.
         * This helper surfaces that as a prompt to update a key and resume,
         * and resuming never re-scrapes work that has already been paid for.
         *
         *   EL.pollJob(jobId, {
         *       onProgress: (job) => { ... },
         *       onDone:     (job) => { ... },
         *       onFailed:   (job) => { ... }
         *   });
         */
        async pollJob(jobId, opts = {}) {
            const { onProgress, onDone, onFailed, onPaused, intervalMs = 2500, mount } = opts;

            EL._polling.add(jobId);
            let seenLogLines = opts._seen || 0;
            let backoff = intervalMs;

            for (;;) {
                if (!EL._polling.has(jobId)) return null;   // superseded or stopped

                let job;
                try {
                    const res = await EL.api(`/api/job/${jobId}`);
                    // The endpoint serves the job both at the top level and
                    // under `job`. Reading only the top level is what used to
                    // leave status undefined and spin this loop forever.
                    job = res && res.job ? res.job : res;
                    backoff = intervalMs;
                } catch (err) {
                    // Render's free tier sleeps; a cold start can take 30s.
                    // Back off rather than hammering it, and keep waiting.
                    backoff = Math.min(backoff * 1.5, 15000);
                    await EL._sleep(backoff);
                    continue;
                }

                if (!job || !job.status) { await EL._sleep(intervalMs); continue; }

                if (opts.onLog) {
                    const lines = Array.isArray(job.log) ? job.log : [];
                    lines.slice(seenLogLines).forEach(l => { try { opts.onLog(l.m, l.t); } catch {} });
                    seenLogLines = lines.length;
                }
                if (onProgress) { try { onProgress(job); } catch {} }

                if (job.status === 'done') {
                    EL._polling.delete(jobId);
                    EL._clearJobBanner(mount);
                    EL.refreshStatus();                     // spend just changed
                    if (onDone) onDone(job);
                    return job;
                }

                // Every stop that leaves the checkpoint intact is recoverable
                // and gets the same banner. Treating them as failures is what
                // made a $2 pause look like a lost run.
                if (['paused_no_credit', 'interrupted', 'cancelled'].includes(job.status)) {
                    EL._polling.delete(jobId);
                    EL._renderJobBanner(job, mount, () => EL.pollJob(jobId, { ...opts, _seen: seenLogLines }));
                    EL.refreshStatus();
                    if (onPaused) { try { onPaused(job); } catch {} }
                    return job;
                }

                if (job.status === 'failed') {
                    EL._polling.delete(jobId);
                    EL._clearJobBanner(mount);
                    EL.refreshStatus();
                    if (onFailed) onFailed(job);
                    return job;
                }

                await EL._sleep(intervalMs);
            }
        },

        /** Stop a poll loop without touching the job itself. */
        stopPolling(jobId) { EL._polling.delete(jobId); },

        /** Ask the server to stop a running job at its next step. */
        async cancelJob(jobId) {
            return EL.api(`/api/job/${jobId}/cancel`, { method: 'POST' });
        },

        _polling: new Set(),
        _sleep: ms => new Promise(r => setTimeout(r, ms)),

        /**
         * Only ever emit an http(s) URL into an href. Escaping alone leaves
         * `javascript:` intact, and every URL in a report came from a scraped
         * post — one click is all it takes.
         */
        safeUrl(u) {
            const v = String(u == null ? '' : u).trim();
            return /^https?:\/\//i.test(v) ? EL.escape(v) : '#';
        },

        /**
         * HTML-escape. Shared here so no page has to define its own, and so
         * the two oldest pages — which never had one — get it for free.
         * Everything interpolated into innerHTML must go through this:
         * captions, post text and group names are attacker-controlled.
         */
        escape(v) {
            return String(v == null ? '' : v).replace(/[&<>"']/g, c => (
                { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
            ));
        },

        /** Resume a paused or interrupted job. Resolves with the API answer. */
        async resumeJob(jobId) {
            return EL.api(`/api/job/${jobId}/resume`, { method: 'POST' });
        },

        _clearJobBanner(mount) {
            const host = typeof mount === 'string' ? document.getElementById(mount) : mount;
            (host || document).querySelectorAll('.el-job-banner').forEach(n => n.remove());
        },

        _renderJobBanner(job, mount, rePoll) {
            EL._clearJobBanner(mount);
            const host = (typeof mount === 'string' ? document.getElementById(mount) : mount) || document.body;

            const done = (job.completed_units || []).length;
            const esc = EL.escape;

            const title = {
                paused_no_credit: 'Out of Apify credit',
                interrupted:      'Interrupted by a server restart',
                cancelled:        'Run cancelled'
            }[job.status] || 'Run stopped';

            const box = document.createElement('div');
            box.className = 'el-job-banner';
            box.innerHTML = `
                <strong>${esc(title)}</strong>
                <p>${done
                    ? `${done} item(s) were already scraped and saved. Resuming reuses them — you will not be charged for them twice.`
                    : 'Nothing further was charged.'}</p>
                <p class="el-job-detail">${esc(job.error || '')}</p>
                <div class="el-job-budget"></div>
                <div class="el-job-actions">
                    ${job.status === 'paused_no_credit'
                        ? '<button class="el-btn" type="button" data-act="key">Update key</button>' : ''}
                    <button class="el-btn el-btn-go" type="button" data-act="resume">
                        ${done ? 'Resume from step ' + (done + 1) : 'Start again'}
                    </button>
                    <button class="el-btn" type="button" data-act="dismiss">Dismiss</button>
                </div>
                <div class="el-job-note"></div>`;
            host.prepend(box);
            box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

            const note = box.querySelector('.el-job-note');

            // Show what is actually left, so "add a key" is a decision rather
            // than a guess.
            if (job.status === 'paused_no_credit') {
                EL.budget(job.engine).then(b => {
                    if (!b) return;
                    const slot = box.querySelector('.el-job-budget');
                    slot.textContent =
                        `$${(b.totalRemainingUsd || 0).toFixed(2)} left across ${b.keys.length} key(s) this cycle.`;
                }).catch(() => {});
            }

            const keyBtn = box.querySelector('[data-act="key"]');
            if (keyBtn) keyBtn.addEventListener('click', () => openKeyModal());

            box.querySelector('[data-act="dismiss"]').addEventListener('click', () => EL._clearJobBanner(mount));

            box.querySelector('[data-act="resume"]').addEventListener('click', async (e) => {
                const btn = e.currentTarget;
                btn.disabled = true;
                note.style.color = '#94a3b8';
                note.textContent = 'Checking for a key with credit…';
                try {
                    const r = await EL.resumeJob(job.id);
                    note.style.color = '#10b981';
                    note.textContent = `Resumed from ${r.resumedFrom} completed item(s).`;
                    EL._clearJobBanner(mount);
                    if (rePoll) rePoll();
                } catch (err) {
                    btn.disabled = false;
                    note.style.color = '#ef4444';
                    note.textContent = err.message;
                    if (/credit/i.test(err.message)) openKeyModal();
                }
            });
        },

        /**
         * A Cancel control for a job in flight. The step already running still
         * bills, but nothing after it starts — on a ten-group audit that is
         * most of the estimate.
         */
        _renderCancel(jobId, mount, onCancelled) {
            const host = (typeof mount === 'string' ? document.getElementById(mount) : mount);
            if (!host || host.querySelector('.el-cancel-row')) return;

            const row = document.createElement('div');
            row.className = 'el-cancel-row';
            row.innerHTML = `<button class="el-btn el-mini" type="button">Cancel run</button>
                             <span class="el-cancel-note"></span>`;
            host.prepend(row);

            const btn = row.querySelector('button');
            const note = row.querySelector('.el-cancel-note');
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                note.textContent = 'Stopping…';
                try {
                    const r = await EL.cancelJob(jobId);
                    note.textContent = r.stopped === 'immediately'
                        ? 'Stopped. Nothing further was charged.'
                        : 'Stopping after the current step. Nothing new will start.';
                    if (onCancelled) onCancelled();
                } catch (err) {
                    btn.disabled = false;
                    note.textContent = err.message;
                }
            });
        },

        _clearCancel(mount) {
            const host = (typeof mount === 'string' ? document.getElementById(mount) : mount);
            (host || document).querySelectorAll('.el-cancel-row').forEach(n => n.remove());
        },

        async signOut() {
            if (EL.isShared()) return;
            try { await EL.supabase.auth.signOut(); } catch {}
            window.location.href = 'index.html';
        },

        /** Boots the header. Resolves with /api/me, or blocks the page and never resolves. */
        async init(options = {}) {
            const { engine = 'leadgen', page, requireAdmin = false } = options;
            EL.engine = engine;

            injectStyles();

            // ---- share mode: a client opening a read-only link --------------
            const shareTok = EL.shareToken();
            if (shareTok) {
                EL._shared = { token: shareTok };
                document.body.classList.add('el-share', 'el-has-header');
                renderShareBar();
                return { shared: true, role: 'viewer', engines: [] };
            }

            EL.supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

            const { data } = await EL.supabase.auth.getSession();
            if (!data.session) { window.location.href = 'index.html'; return new Promise(() => {}); }
            EL.session = data.session;
            EL.user = data.session.user;

            // A cold Render instance takes tens of seconds to answer the first
            // request. Saying so beats an empty screen, which reads as broken
            // and gets reloaded — which starts the wait over.
            // If the wake-up call already came back slow we know the instance
            // was asleep, so there is no reason to make them wait another two
            // seconds to be told. If it came back fast, a slow /api/me is
            // something else and the delay avoids flashing a notice at anyone
            // whose request was merely ordinary.
            const slowTimer = setTimeout(() => bootNotice(
                _backendCold ? 'Waking the server' : 'Still loading',
                _backendCold
                    ? 'This only happens on the first visit after a quiet spell. It usually takes under a minute.'
                    : 'Taking longer than usual. Hang on a moment.'
            ), _backendCold ? 250 : 1800);

            let me;
            try {
                me = await EL.api('/api/me');
                clearTimeout(slowTimer); clearBootNotice();
            } catch (err) {
                clearTimeout(slowTimer); clearBootNotice();
                // A lapsed account fails /api/me with 402, and EL.api has
                // already put the right screen up. Stacking "backend
                // unreachable" on top of it would be wrong and alarming.
                if (err.handled) return new Promise(() => {});
                renderShell(page, null);
                block('Backend unreachable', `The API did not answer: ${err.message}. Check that the service is awake, then reload.`);
                return new Promise(() => {});
            }
            EL.me = me;

            // A client who lands on an employee page goes home rather than
            // being shown a console built for somebody else. Engine grants
            // alone would not catch this: a trial holds the report grant, so
            // nothing would stop them opening the full audit workbench.
            if (me.role === 'client') {
                const allowed = CLIENT_NAV.map(t => t.href);
                if (!allowed.includes(currentPage(page))) {
                    window.location.href = 'client.html';
                    return new Promise(() => {});
                }
            }

            if (EL.isEmbedded()) {
                // Inside the client page's report viewer (phase 31.3): the page's
                // content alone, without the rail, the plan banner or the work-for
                // bar. The access checks below still apply.
                document.body.classList.add('el-embed');
            } else {
                renderShell(page, me);
                renderPlanBanner(me);
                // A client's pages are installable: the service worker for the
                // shell, and one nudge to put it on the home screen. (phase 30)
                if (me.role === 'client') { registerServiceWorker(); mountInstallNudge(); }
                refreshStatus();
                // A client-role account IS its business, so it is never asked
                // which one. Everyone else is asked on every page where work starts.
                if (me.role !== 'client' && WORK_PAGES.includes(currentPage(page))) mountWorkForHost();
                EL._mountClientPicker().catch(() => {});
            }

            const isAdmin = me.role === 'admin';
            if (requireAdmin && !isAdmin) {
                block('Admin only', 'This page manages users and API keys. Ask an administrator to grant you the admin role.');
                return new Promise(() => {});
            }
            if (engine && !isAdmin && !(me.engines || []).includes(engine)) {
                block('No access to this engine',
                    `Your account is not granted the ${engine} engine. An administrator can enable it from the admin page.`);
                return new Promise(() => {});
            }
            return me;
        },

        /**
         * Start a job and follow it to the end.
         *
         * One call replaces the poll loop every page used to hand-roll — and
         * every one of those loops handled only 'done' and 'failed', which is
         * why a paused run looked like a hang. Anything that stops with its
         * checkpoint intact now surfaces as a recovery banner automatically.
         *
         *   EL.runJob('/api/fb/audit-community', { groupIds }, {
         *       mount: 'results',
         *       onProgress: j => setBar(j.progress, j.current_step),
         *       onLog:      m => log(m),
         *       onDone:     j => render(j.result),
         *       onFailed:   j => showError(j.error)
         *   });
         */
        async runJob(path, body, opts = {}) {
            if (EL.me && EL.me.role !== 'client' && !EL.clientId()) {
                EL._nudgeClient();
                const e = new Error('Choose a client first — every run is filed under a business. Pick one above or in the sidebar.');
                e.code = 'client_required';
                throw e;
            }
            const start = await EL.api(path, { method: 'POST', body });
            const jobId = start.jobId;
            if (!jobId) throw new Error('The server did not return a job id.');

            if (opts.mount) EL._renderCancel(jobId, opts.mount, () => {});

            const finish = job => {
                EL._clearCancel(opts.mount);
                return job;
            };

            const job = await EL.pollJob(jobId, {
                ...opts,
                onDone:   j => { finish(j); if (opts.onDone) opts.onDone(j); },
                onFailed: j => { finish(j); if (opts.onFailed) opts.onFailed(j); },
                onPaused: j => { finish(j); if (opts.onPaused) opts.onPaused(j); }
            });
            return { start, job };
        },

        /**
         * Render "this run costs about $X, you have $Y" next to a Run button.
         * Cheap — the estimate endpoints spend nothing — and it turns a pause
         * partway through a run into a decision made before it starts.
         */
        async showCost(elementId, estimatePath) {
            const host = document.getElementById(elementId);
            if (!host) return null;
            try {
                const e = await EL.api(estimatePath);
                const cost = Number(e.estimatedUsd || 0);
                const left = e.budget ? Number(e.budget.totalRemainingUsd || 0) : null;

                let cls = '', msg = `≈ $${cost.toFixed(2)} for this run`;
                if (left != null) {
                    msg += ` · $${left.toFixed(2)} available`;
                    if (e.budget.willPause) { cls = 'is-over'; msg += ' — it will pause partway'; }
                    else if (left - cost < cost)  { cls = 'is-tight'; }
                }
                host.className = 'el-run-cost ' + cls;
                host.textContent = msg;
                return e;
            } catch {
                host.textContent = '';
                return null;
            }
        },

        openKeyModal, openGeminiModal, refreshStatus,

        // ---------------------------------------------------------------
        // CLIENT WORKSPACE (phase 9/10)
        // A run started with a client selected is filed under that client
        // and visible to its members. The choice is remembered per browser
        // and the picker lives in the header bar on every page.
        // ---------------------------------------------------------------
        _clients: null,
        clientId() {
            const v = localStorage.getItem(CLIENT_KEY) || '';
            return /^[0-9a-f-]{36}$/i.test(v) ? v : null;
        },
        setClientId(id) {
            if (id) localStorage.setItem(CLIENT_KEY, id); else localStorage.removeItem(CLIENT_KEY);
            document.querySelectorAll('.el-client-select').forEach(sel => { sel.value = id || ''; });
        },
        // Why this records the failure instead of swallowing it: an empty list
        // and a failed call both used to come back as [], so a picker showing
        // only "None (just me)" could mean "you have no clients" OR "the call
        // died" — and there was no way to tell which from the screen. The
        // reason is kept so the picker can say which one happened.
        _clientsErr: null,
        async clients(force = false) {
            if (EL._clients && !force) return EL._clients;
            EL._clientsErr = null;
            try {
                // never scope this list to the selected client — it IS the list of clients
                const token = await EL.token();
                const res = await fetch(`${BACKEND_URL}/api/clients`, { headers: { Authorization: `Bearer ${token}` } });
                const d = await res.json().catch(() => ({}));
                if (!res.ok) EL._clientsErr = d.error || `HTTP ${res.status}`;
                EL._clients = res.ok ? (d.clients || []) : [];
            } catch (err) { EL._clientsErr = err.message || 'network error'; EL._clients = []; }
            return EL._clients;
        },
        /**
         * The contact email and the ways to pay, as the admin set them.
         * Public and unauthenticated on purpose: the expired screen has no
         * session to speak of, and the privacy page has no account at all.
         * One source, read by every slot that shows it.
         */
        _contact: null,
        async contact() {
            if (EL._contact) return EL._contact;
            try {
                const r = await fetch(BACKEND_URL + '/api/public/contact', { cache: 'no-store' });
                EL._contact = r.ok ? await r.json() : { email: '', paymentOptions: [] };
            } catch { EL._contact = { email: '', paymentOptions: [] }; }
            return EL._contact;
        },

        /**
         * "I want to keep going." Works during the trial and after it has
         * ended — the one call a lapsed account may still make. Nothing is
         * paid here; the admin sees the request and activates by hand.
         */
        async requestActivation(note = '') {
            return EL.api('/api/me/request-activation', { method: 'POST', body: { note: String(note || '').slice(0, 500) } });
        },

        /** The selected client's row, or null. Sync once the picker has loaded. */
        currentClient() {
            const id = EL.clientId();
            if (!id) return null;
            return (EL._clients || []).find(c => c.id === id) || { id, name: 'Selected client' };
        },
        clientBody() { const id = EL.clientId(); return id ? { clientId: id } : {}; },
        clientQuery(prefix = '?') {
            const id = EL.clientId();
            return id ? `${prefix}client_id=${encodeURIComponent(id)}` : '';
        },
        /** ?report=<uuid> deep link from the client timeline, or null. */
        reportParam() {
            const v = new URLSearchParams(location.search).get('report') || '';
            return /^[0-9a-f-]{36}$/i.test(v) ? v : null;
        },
        /** ?embed=1: this page is shown inside another page's viewer (the client timeline). */
        isEmbedded() { return new URLSearchParams(location.search).get('embed') === '1'; },

        /** Draw attention to the picker after a refusal, then let it go. */
        _nudgeClient() {
            const targets = [document.getElementById('el-workfor'), document.querySelector('.el-side-foot .el-client')].filter(Boolean);
            targets.forEach(t => { t.classList.remove('is-nudge'); void t.offsetWidth; t.classList.add('is-nudge'); });
            const bar = document.getElementById('el-workfor');
            if (bar) { bar.scrollIntoView({ behavior: 'smooth', block: 'center' }); const s = bar.querySelector('select'); if (s) s.focus(); }
            setTimeout(() => targets.forEach(t => t.classList.remove('is-nudge')), 1800);
        },

        /** The options every picker on the page shares, so they can never disagree. */
        _clientOptions(list, cur) {
            const label = c => EL.esc(c.name) + (c.access === 'admin' ? ' · admin' : (c.access && c.access !== 'owner' ? ' · shared' : ''));
            return `<option value="">Choose a client…</option>` +
                list.filter(c => !c.archived || c.id === cur)
                    .map(c => `<option value="${c.id}" ${c.id === cur ? 'selected' : ''}>${label(c)}</option>`).join('');
        },

        _onClientChange(e) {
            EL.setClientId(e.target.value || null);
            // A page's vault, sources and estimates all depend on the client.
            // Reloading is simpler and safer than every page re-fetching.
            const u = new URL(location.href); u.searchParams.delete('report');
            location.href = u.toString();
        },

        /** The bar at the top of a work page: which business this is for. */
        _renderWorkFor(list, cur) {
            const bar = document.getElementById('el-workfor');
            if (!bar) return;
            const c = cur ? list.find(x => x.id === cur) : null;
            bar.classList.toggle('is-empty', !c);
            bar.innerHTML = c
                ? `<span class="el-wf-tag">Client</span>
                   <span>Filing under <b>${EL.esc(c.name)}</b>${c.ig_handle ? ' · @' + EL.esc(c.ig_handle) : ''}${c.meta && c.meta.connected ? ' · Meta connected' : ''}</span>
                   <select class="el-client-select" aria-label="Which client this work is for">${EL._clientOptions(list, cur)}</select>`
                : `<span class="el-wf-tag">Client</span>
                   <span><b>Choose the client this work is for.</b> Nothing runs until you do${list.length ? '' : ' — <a href="clients.html">create one</a> first'}.</span>
                   <select class="el-client-select" aria-label="Which client this work is for">${EL._clientOptions(list, cur)}</select>`;
            bar.querySelector('select').addEventListener('change', EL._onClientChange);
        },

        async _mountClientPicker() {
            const host = document.getElementById('el-client-host');
            if (!host) return;
            // A client account is the business; asking it to pick one is noise.
            if (EL.me && EL.me.role === 'client') { host.remove(); return; }
            const list = await EL.clients();
            const current = EL.clientId();
            if (current && !list.some(c => c.id === current)) EL.setClientId(null);
            const cur = EL.clientId();
            // Three states, not two. A failed call used to look exactly like an
            // empty account, which sends you hunting for a missing client that
            // was there all along.
            if (EL._clientsErr) {
                host.innerHTML = `
                    <span>Client</span>
                    <select class="el-client-select" disabled><option>couldn’t load</option></select>
                    <button type="button" class="el-client-retry" title="${EL.esc(EL._clientsErr)}">Retry</button>`;
                host.querySelector('.el-client-retry').addEventListener('click', () => {
                    EL._clients = null; EL._mountClientPicker().catch(() => {});
                });
                return;
            }
            host.innerHTML = `
                <span title="Every run is filed under the selected client and every vault is scoped to it.">Client</span>
                <select class="el-client-select" aria-label="Client workspace">${EL._clientOptions(list, cur)}</select>
                <a class="el-client-manage" href="clients.html" title="${list.length ? list.length + ' client' + (list.length === 1 ? '' : 's') : 'No clients yet'}">Manage</a>`;
            host.querySelector('select').addEventListener('change', EL._onClientChange);
            EL._renderWorkFor(list, cur);
        },

        /**
         * Legacy in-page picker (phase 9). Kept for pages that still call it;
         * it mirrors the header picker rather than fighting it.
         */
        async clientSelector(mount, opts = {}) {
            const host = typeof mount === 'string' ? document.getElementById(mount) : mount;
            if (!host) return null;
            const list = await EL.clients();
            const current = EL.clientId();
            host.className = 'el-client-picker ' + (host.className || '');
            host.innerHTML = `
                <label>${opts.label || 'Client'}</label>
                <select class="el-client-select">
                    <option value="">No client (just me)</option>
                    ${list.map(c => `<option value="${c.id}" ${c.id === current ? 'selected' : ''}>${EL.esc(c.name)}${c.access && c.access !== 'owner' ? ' · shared' : ''}</option>`).join('')}
                </select>
                <a href="clients.html" class="el-client-manage">Manage</a>`;
            host.querySelector('select').addEventListener('change', e => {
                EL.setClientId(e.target.value || null);
                if (opts.onChange) opts.onChange(e.target.value || null);
            });
            return host;
        },
        esc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },

        // ---------------------------------------------------------------
        // SHARE MODE (phase 11)
        // ---------------------------------------------------------------
        shareToken() {
            const v = new URLSearchParams(location.search).get('share') || '';
            return /^[A-Za-z0-9_-]{20,64}$/.test(v) ? v : null;
        },
        isShared() { return !!EL._shared; },
        /** Fetch the shared report. Throws with the server's message (expired, revoked, deleted). */
        async loadShared() {
            const tok = EL.shareToken();
            if (!tok) throw new Error('No share token in the URL.');
            const d = await EL.api(`/api/public/share/${encodeURIComponent(tok)}`);
            const bar = document.getElementById('el-share-meta');
            if (bar) {
                const exp = d.shared?.expiresAt ? new Date(d.shared.expiresAt).toLocaleDateString() : '';
                bar.innerHTML = `${d.client?.name ? `<b>${EL.esc(d.client.name)}</b> · ` : ''}${d.shared?.label ? EL.esc(d.shared.label) + ' · ' : ''}read-only${exp ? ' · link valid until ' + exp : ''}`;
            }
            return d;
        },

        // ---------------------------------------------------------------
        // REPORT ACTIONS (phase 11): share link + repeat on a schedule.
        //   EL.reportActions('report-actions', { reportId, jobId })
        // Idempotent per mount; hidden in share mode.
        // ---------------------------------------------------------------
        async reportActions(mount, { reportId, jobId } = {}) {
            if (EL.isShared()) return null;
            const host = typeof mount === 'string' ? document.getElementById(mount) : mount;
            if (!host || !reportId) return null;
            host.className = 'el-actions el-owner-only';
            host.innerHTML = `
                <button class="el-btn el-mini" type="button" data-act="share">🔗 Share link</button>
                <button class="el-btn el-mini" type="button" data-act="schedule">⏱ Repeat on a schedule</button>
                <span class="el-note" data-role="note"></span>
                <div class="el-share-list" data-role="shares"></div>`;
            const note = host.querySelector('[data-role="note"]');
            const list = host.querySelector('[data-role="shares"]');

            const renderShares = async () => {
                try {
                    const { shares } = await EL.api(`/api/shares?report_id=${encodeURIComponent(reportId)}`);
                    const live = (shares || []).filter(s => s.active);
                    list.innerHTML = live.map(s => `<div>
                        <code>${EL.esc(s.url)}</code>
                        <span>${s.views || 0} view(s) · until ${new Date(s.expires_at).toLocaleDateString()}</span>
                        <button class="el-btn el-mini" type="button" data-copy="${EL.esc(s.url)}">Copy</button>
                        <button class="el-btn el-mini" type="button" data-revoke="${s.id}">Turn off</button></div>`).join('');
                    list.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', () =>
                        navigator.clipboard.writeText(b.dataset.copy).then(() => { note.style.color = '#10b981'; note.textContent = 'Link copied.'; })));
                    list.querySelectorAll('[data-revoke]').forEach(b => b.addEventListener('click', async () => {
                        b.disabled = true;
                        try { await EL.api(`/api/share/${b.dataset.revoke}`, { method: 'DELETE' }); await renderShares(); }
                        catch (err) { note.style.color = '#ef4444'; note.textContent = err.message; b.disabled = false; }
                    }));
                } catch { list.innerHTML = ''; }
            };
            renderShares();

            host.querySelector('[data-act="share"]').addEventListener('click', () => openShareModal(reportId, async (url) => {
                note.style.color = '#10b981';
                note.textContent = 'Link created and copied. Anyone with it can read this report until it expires.';
                try { await navigator.clipboard.writeText(url); } catch {}
                renderShares();
            }));
            host.querySelector('[data-act="schedule"]').addEventListener('click', () => openScheduleModal({ reportId, jobId }, (s) => {
                note.style.color = '#10b981';
                note.textContent = `Scheduled. Next run ${new Date(s.next_run_at).toLocaleString()} — manage it on the Schedules page.`;
            }));
            return host;
        },

        openShareModal(reportId, onDone) { return openShareModal(reportId, onDone); },
        openScheduleModal(ref, onDone) { return openScheduleModal(ref, onDone); },

        /** Human label for a schedule row. */
        scheduleWhen(s) {
            const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            const h = String(s.hour_utc).padStart(2, '0') + ':00 UTC';
            return s.cadence === 'weekly' ? `Every ${days[s.day_of_week] || 'Monday'} at ${h}` : `Monthly on day ${s.day_of_month} at ${h}`;
        }
    };

    // -----------------------------------------------------------------------

    /**
     * The header's CSS lives in app.css as of phase 18, so it arrives with the
     * stylesheet instead of being appended after the first paint. Injecting it
     * here meant every page rendered once unstyled and then again — a flash on
     * every navigation, on every page.
     *
     * This stays as a fallback for a page that forgets to link app.css: it
     * detects the stylesheet by probing for a rule only app.css defines, and
     * injects the old strings if it is genuinely missing. A page that has the
     * stylesheet pays one cheap DOM check and nothing else.
     */
    function injectStyles() {
        if (document.getElementById('el-header-styles')) return;
        if (!document.body) return;

        // Read a sentinel custom property that no media query ever changes.
        // The previous probe read .el-header's computed position, which the
        // old mobile rule flips to static — so on a phone it concluded the
        // stylesheet was missing and injected a second copy of the whole file.
        if (getComputedStyle(document.documentElement)
                .getPropertyValue('--el-stylesheet').trim() === '1') return;

        // The stylesheet is genuinely missing. Load it rather than carry a
        // second copy of the CSS in this file: keeping the strings here cost
        // every page ~7KB to insure against a case that only happens if a new
        // page forgets the <link>.
        const link = document.createElement('link');
        link.id = 'el-header-styles';
        link.rel = 'stylesheet';
        link.href = 'app.css';
        document.head.appendChild(link);
    }

    function currentPage(explicit) {
        if (explicit) return explicit;
        const file = window.location.pathname.split('/').pop();
        return file || 'index.html';
    }

    /**
     * The "how to continue" slot: a mail link if there is an address, the
     * ways to pay if there are any. Empty string when the admin has set
     * nothing, so a slot with nothing to say takes no space.
     */
    function contactSlotHtml(c, { lead = 'To activate now' } = {}) {
        if (!c) return '';
        const opts = Array.isArray(c.paymentOptions) ? c.paymentOptions : [];
        const mail = c.email ? `<a class="el-btn" href="mailto:${EL.escape(c.email)}?subject=EdgeLead%20access">Email ${EL.escape(c.email)}</a>` : '';
        const pay = opts.length ? `<div class="el-pay"><b>${EL.escape(lead)}:</b>
            <ul>${opts.map(o => `<li><b>${EL.escape(o.label || 'Pay')}</b>${o.details ? ` — ${EL.escape(o.details)}` : ''}${o.url ? ` <a href="${EL.safeUrl(o.url)}" target="_blank" rel="noopener noreferrer">open ↗</a>` : ''}</li>`).join('')}</ul></div>` : '';
        return (mail || pay) ? `<div class="el-contact-slot">${mail}${pay}</div>` : '';
    }

    /** The empty host for the work-for bar; the picker fills it. */
    function mountWorkForHost() {
        if (document.getElementById('el-workfor')) return;
        const pg = document.querySelector('.el-page');
        if (!pg) return;
        const h = document.createElement('div');
        h.id = 'el-workfor';
        h.className = 'el-workfor';
        pg.insertAdjacentElement('afterbegin', h);
    }

    function renderShell(page, me) {
        const here = currentPage(page);
        const isAdmin = me && me.role === 'admin';
        const engines = (me && me.engines) || [];

        const visible = (me && me.role === 'client' ? CLIENT_NAV : NAV)
            .filter(t => {
                if (t.group) return true;                    // resolved below
                if (t.adminOnly) return isAdmin;
                if (!me) return true;
                if (t.engine === null) return true;          // every signed-in user
                return isAdmin || engines.includes(t.engine);
            });

        // Drop a group heading whose whole section was filtered away by engine
        // grants — an empty "Facebook" label sitting over nothing reads as
        // something broken. A heading survives only if a link follows it before
        // the next heading does.
        const kept = visible.filter((t, i) => {
            if (!t.group) return true;
            for (let j = i + 1; j < visible.length; j++) {
                if (visible[j].group) return false;          // next heading first
                return true;                                 // a link first
            }
            return false;                                    // nothing after it
        });

        const tabs = kept.map(t => t.group
            ? `<div class="el-group">${t.group}</div>`
            : `<a class="el-tab ${t.href === here ? 'is-active' : ''}" href="${t.href}">
                   <span class="el-ico" aria-hidden="true">${t.icon || ''}</span>
                   <span class="el-lab">${t.label}${t.adminOnly && me && me.pendingActivations
                       ? `<span class="el-badge" title="${me.pendingActivations} client(s) asked to continue">${me.pendingActivations}</span>` : ''}</span>
               </a>`).join('');

        // A rail rather than a top bar. Twelve destinations in a horizontal
        // strip either wrap or scroll sideways, and both hide the tail of the
        // list — which is where Admin and Schedules live. Stacked, the whole
        // set is visible at once and the labels get room to be words rather
        // than abbreviations.
        const bar = document.createElement('aside');
        bar.className = 'el-sidebar';
        bar.id = 'el-sidebar';
        bar.innerHTML = `
            <div class="el-side-top">
                <div class="el-logo">⚡ EDGELEAD</div>
            </div>

            <nav class="el-nav" aria-label="Sections">${tabs}</nav>

            <div class="el-side-foot">
                <div class="el-client" id="el-client-host"><span>Client</span><select class="el-client-select" disabled><option>…</option></select></div>
                <div class="el-pill">
                    <span class="el-node" id="el-node"></span>
                    <span id="el-status">Checking Apify…</span>
                </div>
                <div class="el-side-actions">
                    <button class="el-btn el-mini" type="button" id="el-key-btn">Update key</button>
                    <button class="el-btn el-mini" type="button" id="el-ai-btn" title="Your own Gemini key — used only for runs you start">AI key</button>
                </div>
                <button class="el-btn el-signout" type="button" id="el-out">Sign out</button>
            </div>`;

        // The rail is off-canvas on a phone, so the bar that opens it has to
        // exist before it — otherwise there is no way back to navigation.
        const top = document.createElement('div');
        top.className = 'el-topbar';
        top.innerHTML = `
            <button class="el-burger" type="button" id="el-burger" aria-label="Open navigation" aria-expanded="false" aria-controls="el-sidebar">
                <span></span><span></span><span></span>
            </button>
            <div class="el-logo">⚡ EDGELEAD</div>`;

        const scrim = document.createElement('div');
        scrim.className = 'el-scrim';
        scrim.id = 'el-scrim';

        document.body.prepend(scrim);
        document.body.prepend(bar);
        document.body.prepend(top);
        document.body.classList.add('el-has-header', 'el-has-sidebar');

        const setOpen = open => {
            document.body.classList.toggle('el-nav-open', open);
            top.querySelector('#el-burger').setAttribute('aria-expanded', String(open));
        };
        top.querySelector('#el-burger').addEventListener('click',
            () => setOpen(!document.body.classList.contains('el-nav-open')));
        scrim.addEventListener('click', () => setOpen(false));
        // Escape closes it, and following a link closes it too — otherwise the
        // drawer stays over the page you just navigated to.
        document.addEventListener('keydown', e => { if (e.key === 'Escape') setOpen(false); });
        bar.querySelectorAll('.el-tab').forEach(a => a.addEventListener('click', () => setOpen(false)));

        bar.querySelector('#el-key-btn').addEventListener('click', openKeyModal);
        bar.querySelector('#el-ai-btn').addEventListener('click', openGeminiModal);
        bar.querySelector('#el-out').addEventListener('click', () => EL.signOut());
    }

    // ---- installable client surface (phase 30) ----------------------------

    function registerServiceWorker() {
        if (!('serviceWorker' in navigator) || location.protocol !== 'https:') return;
        navigator.serviceWorker.register('sw.js').catch(() => { /* the pages work without it */ });
    }

    function isStandalone() {
        return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
            || window.navigator.standalone === true
            || /[?&]source=pwa\b/.test(location.search);
    }

    /**
     * One card, at the top of the page, on the client's pages only: put
     * EdgeLead on the home screen. Chrome on Android and desktop hand over a
     * real prompt; Safari on iPhone has no such thing, so it gets the three
     * taps written out. "Not now" is remembered for two weeks; an installed
     * app never sees it.
     */
    function mountInstallNudge() {
        if (isStandalone() || document.getElementById('el-install')) return;
        let dismissed = 0;
        try { dismissed = Number(localStorage.getItem('el-install-dismissed') || 0); } catch { /* private mode */ }
        if (dismissed && Date.now() - dismissed < 14 * 86400000) return;

        const host = document.querySelector('.el-page') || document.body;
        const card = document.createElement('div');
        card.className = 'el-install';
        card.id = 'el-install';
        card.innerHTML = `
            <div class="el-install-ico" aria-hidden="true">⚡</div>
            <div class="el-install-txt">
                <b>Put EdgeLead on your home screen</b>
                <span>Opens like an app, full screen, one tap from your phone — your reports, your numbers every day, and a place to ask.</span>
            </div>
            <div class="el-install-act">
                <button class="el-btn el-mini el-install-go" type="button" id="el-install-go">${_installEvt ? 'Add to home screen' : 'Show me how'}</button>
                <button class="el-btn el-mini" type="button" id="el-install-no">Not now</button>
            </div>`;
        host.prepend(card);

        card.querySelector('#el-install-go').addEventListener('click', async () => {
            if (_installEvt) {
                const evt = _installEvt; _installEvt = null;
                try {
                    evt.prompt();
                    const choice = await evt.userChoice;
                    if (choice && choice.outcome === 'accepted') { card.remove(); return; }
                } catch { /* fall through to the written steps */ }
            }
            showInstallHow();
        });
        card.querySelector('#el-install-no').addEventListener('click', () => {
            try { localStorage.setItem('el-install-dismissed', String(Date.now())); } catch { /* private mode */ }
            card.remove();
        });
        window.addEventListener('appinstalled', () => card.remove());
    }

    function showInstallHow() {
        if (document.getElementById('el-install-how')) return;
        const ua = navigator.userAgent || '';
        const iOS = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        const steps = iOS
            ? ['Open this page in <b>Safari</b> if you are not already in it.',
               'Tap the <b>Share</b> button — the square with an arrow, at the bottom of the screen.',
               'Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.']
            : ['Open your browser\'s menu — the three dots, top right.',
               'Tap <b>Add to Home screen</b> (or <b>Install app</b>).',
               'Tap <b>Add</b> or <b>Install</b>. EdgeLead appears next to your other apps.'];
        const scrim = document.createElement('div');
        scrim.className = 'el-scrim';
        scrim.id = 'el-install-how';
        scrim.innerHTML = `
            <div class="el-modal" role="dialog" aria-modal="true" aria-labelledby="el-install-title">
                <h3 id="el-install-title">Add EdgeLead to your home screen</h3>
                <p>Three taps. It then opens full screen, like an app, and stays signed in.</p>
                <ol class="el-install-steps">${steps.map(t => `<li>${t}</li>`).join('')}</ol>
                <div class="el-modal-actions">
                    <button class="el-btn el-btn-go" type="button" id="el-install-ok">Got it</button>
                </div>
            </div>`;
        document.body.appendChild(scrim);
        const close = () => scrim.remove();
        scrim.querySelector('#el-install-ok').addEventListener('click', close);
        scrim.addEventListener('click', e => { if (e.target === scrim) close(); });
        document.addEventListener('keydown', function esc(e) {
            if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
        });
    }

    function renderShareBar() {
        const bar = document.createElement('div');
        bar.className = 'el-share-bar';
        bar.innerHTML = `
            <div class="el-logo">⚡ EDGELEAD</div>
            <div id="el-share-meta">Shared report · read-only</div>
            <div>Prepared with EdgeLead</div>`;
        document.body.prepend(bar);
    }

    /**
     * Trial / plan strip, clients only.
     *
     * Employees never see it — "0 of 50 leads" against an uncapped account is
     * just noise. The usd metric is deliberately not shown: it is our Apify
     * cost, not a number a client has any use for.
     */
    function renderPlanBanner(me) {
        const old = document.querySelector('.el-plan');
        if (old) old.remove();

        if (!me || me.role !== 'client') return;
        if (me.state !== 'trial' && me.state !== 'paid') return;

        // Plan-strip CSS lives in app.css as of phase 18.

        const endsAt = me.state === 'trial' ? me.trial_ends_at : me.paid_until;
        const days   = endsAt ? Math.ceil((new Date(endsAt).getTime() - Date.now()) / 86400000) : null;
        const urgent = me.state === 'trial' && days !== null && days <= 2;

        let lead;
        if (me.state === 'trial') {
            lead = days === null ? 'Free trial'
                 : days <= 0     ? 'Trial ends today'
                 : days === 1    ? 'Trial ends tomorrow'
                 : `${days} days left in your trial`;
        } else {
            lead = me.plan_label ? EL.escape(me.plan_label) : 'Active plan';
            if (days !== null && days <= 14) lead += ` — renews in ${days} day${days === 1 ? '' : 's'}`;
        }

        const LABELS = { ig_report: 'Reports', fb_group_audit: 'Audits', leads: 'Leads' };
        const meters = Object.entries(LABELS).map(([metric, label]) => {
            const u = me.usage && me.usage[metric];
            if (!u || u.cap === null || u.cap === undefined) return '';
            const pct = u.cap > 0 ? Math.min(100, Math.round((u.used / u.cap) * 100)) : 100;
            return `<span class="el-plan-meter">${label}
                <span class="el-plan-bar ${pct >= 100 ? 'is-full' : ''}"><i style="width:${pct}%"></i></span>
                <b>${u.used}/${u.cap}</b></span>`;
        }).join('');

        const bar = document.createElement('div');
        bar.className = 'el-plan' + (urgent ? ' is-urgent' : '');
        // The one thing a trial banner is for. Sent once, it says so and stays
        // said; the admin has it in front of them from that moment.
        const asked = !!me.activation_requested_at;
        const cta = me.state === 'trial'
            ? `<button class="el-plan-cta" type="button" id="el-plan-continue" ${asked ? 'disabled' : ''}>${asked ? 'Request sent ✓' : 'Keep going after the trial'}</button>`
            : '';
        bar.innerHTML = `
            <span class="el-plan-tag">${me.state === 'trial' ? 'Trial' : 'Plan'}</span>
            <span>${lead}</span>
            <span class="el-plan-meters">${meters}</span>${cta}`;
        document.body.appendChild(bar);
        document.body.classList.add('el-has-plan');
        const btn = document.getElementById('el-plan-continue');
        if (btn && !asked) btn.addEventListener('click', async () => {
            btn.disabled = true; btn.textContent = 'Sending…';
            try {
                await EL.requestActivation(); btn.textContent = 'Request sent ✓';
                const slot = contactSlotHtml(await EL.contact(), { lead: 'To activate straight away' });
                if (slot && !bar.querySelector('.el-contact-slot')) bar.insertAdjacentHTML('beforeend', slot);
            }
            catch (err) { btn.disabled = false; btn.textContent = 'Keep going after the trial'; if (!err.handled) alert(err.message); }
        });
        // Already asked earlier: the ways to pay are still the thing they need.
        if (asked && me.state === 'trial') EL.contact().then(c => { const slot = contactSlotHtml(c, { lead: 'To activate straight away' }); if (slot) bar.insertAdjacentHTML('beforeend', slot); });
    }

    async function refreshStatus(opts = {}) {
        const label = document.getElementById('el-status');
        const node = document.getElementById('el-node');
        if (!label) return;
        try {
            const data = await EL.api(
                `/api/actor-status?engine=${encodeURIComponent(EL.engine)}` +
                (opts.force ? '&refresh=1' : '')
            );
            if (data.active) {
                // Remaining credit belongs next to the connectivity dot: it is
                // the number that decides whether pressing Run is a good idea.
                const left = typeof data.remainingUsd === 'number'
                    ? ` · $${data.remainingUsd.toFixed(2)} left` : '';
                label.textContent = `Apify live · ${data.username}${left}`;
                label.style.color = data.remainingUsd != null && data.remainingUsd < 0.5 ? '#f59e0b' : '#10b981';
                node.className = 'el-node is-live';
            } else {
                label.textContent = data.error === 'No credit' ? 'Apify out of credit' : 'Apify key rejected';
                label.style.color = '#ef4444';
                node.className = 'el-node is-dead';
            }
        } catch (err) {
            label.textContent = 'Apify status unavailable';
            label.style.color = '#ef4444';
            node.className = 'el-node is-dead';
        }
    }

    function openKeyModal() {
        if (document.getElementById('el-key-modal')) return;
        const isAdmin = EL.me && EL.me.role === 'admin';

        const scrim = document.createElement('div');
        scrim.className = 'el-scrim';
        scrim.id = 'el-key-modal';
        scrim.innerHTML = `
            <div class="el-modal" role="dialog" aria-modal="true" aria-labelledby="el-key-title">
                <h3 id="el-key-title">Update Apify key</h3>
                <p>${isAdmin
                    ? 'Saved as the shared primary key for the selected engine. The old key stays in the pool as failover.'
                    : 'Saved as your personal key, encrypted, and used only for runs you start. It is never added to the shared pool and never used by another account.'}</p>
                <label for="el-key-engine">Engine</label>
                <select id="el-key-engine">
                    <option value="leadgen" ${EL.engine === 'leadgen' ? 'selected' : ''}>Lead finder</option>
                    <option value="report" ${EL.engine === 'report' ? 'selected' : ''}>Reports &amp; competitors</option>
                    <option value="fb_community" ${EL.engine === 'fb_community' ? 'selected' : ''}>Facebook communities</option>
                    <option value="fb_page" ${EL.engine === 'fb_page' ? 'selected' : ''}>Facebook Pages</option>
                </select>
                <label for="el-key-value">API token</label>
                <input type="password" id="el-key-value" placeholder="apify_api_…" autocomplete="off">
                <div class="el-note" id="el-key-note"></div>
                <div class="el-modal-actions">
                    <button class="el-btn el-btn-go" type="button" id="el-key-save">Save key</button>
                    <button class="el-btn" type="button" id="el-key-cancel">Cancel</button>
                </div>
            </div>`;
        document.body.appendChild(scrim);

        const close = () => scrim.remove();
        const note = scrim.querySelector('#el-key-note');
        const input = scrim.querySelector('#el-key-value');
        input.focus();

        scrim.querySelector('#el-key-cancel').addEventListener('click', close);
        scrim.addEventListener('click', e => { if (e.target === scrim) close(); });
        document.addEventListener('keydown', function esc(e) {
            if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
        });

        scrim.querySelector('#el-key-save').addEventListener('click', async () => {
            const newApiKey = input.value.trim();
            const engine = scrim.querySelector('#el-key-engine').value;
            if (!newApiKey) { note.style.color = '#ef4444'; note.textContent = 'Paste a token first.'; return; }

            note.style.color = '#94a3b8';
            note.textContent = 'Verifying with Apify…';
            try {
                const data = await EL.api('/api/update-apify-key', { method: 'POST', body: { newApiKey, engine } });
                note.style.color = '#10b981';
                note.textContent = `Saved for ${data.username} (${data.scope === 'engine_primary' ? 'shared primary' : 'personal'}).`;
                refreshStatus();
                setTimeout(close, 1100);
            } catch (err) {
                note.style.color = '#ef4444';
                note.textContent = err.message;
            }
        });
    }

    /**
     * Personal Gemini key. The narrative layer used to run on one server key
     * for everyone, so one busy user could rate-limit every other report. A
     * personal key is tried first for this user's runs; the shared pool and
     * the server key remain as fallback.
     */
    function openGeminiModal() {
        if (document.getElementById('el-ai-modal')) return;
        const isAdmin = EL.me && EL.me.role === 'admin';
        const scrim = document.createElement('div');
        scrim.className = 'el-scrim';
        scrim.id = 'el-ai-modal';
        scrim.innerHTML = `
            <div class="el-modal" role="dialog" aria-modal="true" aria-labelledby="el-ai-title">
                <h3 id="el-ai-title">Gemini API key</h3>
                <p>Used for report narratives, drafts and content plans. Your key is encrypted, tried first for runs you start, and never used for anyone else's.
                   Get one free at <b>aistudio.google.com</b>.${isAdmin ? ' Shared pool keys are managed on the Admin page.' : ''}</p>
                <div id="el-ai-list" class="el-note">Loading…</div>
                <label for="el-ai-label">Label</label>
                <input type="text" id="el-ai-label" placeholder="e.g. my studio key" autocomplete="off">
                <label for="el-ai-value">API key</label>
                <input type="password" id="el-ai-value" placeholder="AIza…" autocomplete="off">
                <div class="el-note" id="el-ai-note"></div>
                <div class="el-modal-actions">
                    <button class="el-btn el-btn-go" type="button" id="el-ai-save">Save key</button>
                    <button class="el-btn" type="button" id="el-ai-cancel">Close</button>
                </div>
            </div>`;
        document.body.appendChild(scrim);
        const close = () => scrim.remove();
        const note = scrim.querySelector('#el-ai-note');
        const listEl = scrim.querySelector('#el-ai-list');
        scrim.querySelector('#el-ai-cancel').addEventListener('click', close);
        scrim.addEventListener('click', e => { if (e.target === scrim) close(); });

        const load = async () => {
            try {
                const d = await EL.api('/api/gemini-keys');
                const mine = (d.keys || []).filter(k => k.scope === 'personal' && k.owner_user_id === EL.me.id);
                listEl.innerHTML = mine.length
                    ? mine.map(k => `<div class="el-ai-row"><span>${EL.esc(k.label || 'key')} · <em>${EL.esc(k.status)}</em>${k.last_error ? ' · ' + EL.esc(String(k.last_error).slice(0, 60)) : ''}</span>
                        <button class="el-btn el-mini" data-del="${k.id}" type="button">Remove</button></div>`).join('')
                    : `No personal key yet. ${d.envKey || d.poolKeys ? 'Runs currently use the shared key.' : 'No shared key is configured either — narratives will be skipped.'}`;
                listEl.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
                    b.disabled = true;
                    try { await EL.api(`/api/gemini-keys/${b.dataset.del}`, { method: 'DELETE' }); await load(); }
                    catch (err) { note.style.color = '#ef4444'; note.textContent = err.message; b.disabled = false; }
                }));
            } catch (err) { listEl.textContent = err.message; }
        };
        load();

        scrim.querySelector('#el-ai-save').addEventListener('click', async () => {
            const key = scrim.querySelector('#el-ai-value').value.trim();
            const label = scrim.querySelector('#el-ai-label').value.trim();
            if (!key) { note.style.color = '#ef4444'; note.textContent = 'Paste a key first.'; return; }
            note.style.color = '#94a3b8'; note.textContent = 'Verifying with Google…';
            try {
                await EL.api('/api/gemini-keys', { method: 'POST', body: { key, label } });
                note.style.color = '#10b981'; note.textContent = 'Saved. Your runs will use this key first.';
                scrim.querySelector('#el-ai-value').value = '';
                await load();
            } catch (err) { note.style.color = '#ef4444'; note.textContent = err.message; }
        });
    }

    /**
     * Create a read-only link for one report. The link is the credential:
     * anyone holding it can read that report, nothing else, until it expires.
     */
    function openShareModal(reportId, onDone) {
        if (document.getElementById('el-share-modal')) return;
        const scrim = document.createElement('div');
        scrim.className = 'el-scrim';
        scrim.id = 'el-share-modal';
        scrim.innerHTML = `
            <div class="el-modal" role="dialog" aria-modal="true" aria-labelledby="el-share-title">
                <h3 id="el-share-title">Share this report</h3>
                <p>Creates a read-only link. Anyone with the link can open this one report — no sign-in, no other reports, nothing they can change. You can turn it off any time.</p>
                <label for="el-share-days">Link valid for</label>
                <select id="el-share-days">
                    <option value="7">7 days</option>
                    <option value="30" selected>30 days</option>
                    <option value="90">90 days</option>
                    <option value="365">1 year</option>
                </select>
                <label for="el-share-label">Note to self (optional)</label>
                <input type="text" id="el-share-label" placeholder="e.g. sent to Maria on Monday" maxlength="120" autocomplete="off">
                <div class="el-note" id="el-share-note"></div>
                <div class="el-modal-actions">
                    <button class="el-btn el-btn-go" type="button" id="el-share-go">Create link</button>
                    <button class="el-btn" type="button" id="el-share-cancel">Cancel</button>
                </div>
            </div>`;
        document.body.appendChild(scrim);
        const close = () => scrim.remove();
        const note = scrim.querySelector('#el-share-note');
        scrim.querySelector('#el-share-cancel').addEventListener('click', close);
        scrim.addEventListener('click', e => { if (e.target === scrim) close(); });
        scrim.querySelector('#el-share-go').addEventListener('click', async (e) => {
            e.currentTarget.disabled = true;
            note.style.color = '#94a3b8'; note.textContent = 'Creating…';
            try {
                const r = await EL.api('/api/share', { method: 'POST', body: {
                    reportId, expiresDays: +scrim.querySelector('#el-share-days').value,
                    label: scrim.querySelector('#el-share-label').value.trim()
                } });
                note.style.color = '#10b981';
                note.innerHTML = `<code style="word-break:break-all">${EL.esc(r.url)}</code>`;
                if (onDone) onDone(r.url, r.share);
                setTimeout(close, 1400);
            } catch (err) {
                e.currentTarget.disabled = false;
                note.style.color = '#ef4444'; note.textContent = err.message;
            }
        });
    }

    /**
     * Repeat a run on a schedule. The server copies the job's validated input,
     * so a schedule can only be made from a run this account started.
     */
    function openScheduleModal(ref, onDone) {
        if (document.getElementById('el-sched-modal')) return;
        const scrim = document.createElement('div');
        scrim.className = 'el-scrim';
        scrim.id = 'el-sched-modal';
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        scrim.innerHTML = `
            <div class="el-modal" role="dialog" aria-modal="true" aria-labelledby="el-sched-title">
                <h3 id="el-sched-title">Repeat this run</h3>
                <p>Re-runs exactly what this report ran — same accounts, same settings, same client — on a schedule. Each run spends Apify credit like a manual one and pauses the same way if credit runs out.</p>
                <label for="el-sched-cadence">How often</label>
                <select id="el-sched-cadence">
                    <option value="monthly" selected>Monthly</option>
                    <option value="weekly">Weekly</option>
                </select>
                <div class="el-grid2">
                    <div id="el-sched-dom-wrap">
                        <label for="el-sched-dom">Day of month</label>
                        <select id="el-sched-dom">${Array.from({ length: 28 }, (_, i) => `<option value="${i + 1}" ${i === 0 ? 'selected' : ''}>${i + 1}</option>`).join('')}</select>
                    </div>
                    <div id="el-sched-dow-wrap" style="display:none">
                        <label for="el-sched-dow">Day of week</label>
                        <select id="el-sched-dow">${days.map((d, i) => `<option value="${i}" ${i === 1 ? 'selected' : ''}>${d}</option>`).join('')}</select>
                    </div>
                    <div>
                        <label for="el-sched-hour">Hour (UTC)</label>
                        <select id="el-sched-hour">${Array.from({ length: 24 }, (_, i) => `<option value="${i}" ${i === 6 ? 'selected' : ''}>${String(i).padStart(2, '0')}:00</option>`).join('')}</select>
                    </div>
                </div>
                <label for="el-sched-label">Label (optional)</label>
                <input type="text" id="el-sched-label" placeholder="e.g. Monthly report for Acme" maxlength="120" autocomplete="off">
                <div class="el-note" id="el-sched-note"></div>
                <div class="el-modal-actions">
                    <button class="el-btn el-btn-go" type="button" id="el-sched-go">Schedule</button>
                    <button class="el-btn" type="button" id="el-sched-cancel">Cancel</button>
                </div>
            </div>`;
        document.body.appendChild(scrim);
        const close = () => scrim.remove();
        const note = scrim.querySelector('#el-sched-note');
        const cad = scrim.querySelector('#el-sched-cadence');
        cad.addEventListener('change', () => {
            const w = cad.value === 'weekly';
            scrim.querySelector('#el-sched-dom-wrap').style.display = w ? 'none' : '';
            scrim.querySelector('#el-sched-dow-wrap').style.display = w ? '' : 'none';
        });
        scrim.querySelector('#el-sched-cancel').addEventListener('click', close);
        scrim.addEventListener('click', e => { if (e.target === scrim) close(); });
        scrim.querySelector('#el-sched-go').addEventListener('click', async (e) => {
            e.currentTarget.disabled = true;
            note.style.color = '#94a3b8'; note.textContent = 'Saving…';
            try {
                const body = {
                    cadence: cad.value,
                    dayOfMonth: +scrim.querySelector('#el-sched-dom').value,
                    dayOfWeek: +scrim.querySelector('#el-sched-dow').value,
                    hourUtc: +scrim.querySelector('#el-sched-hour').value,
                    label: scrim.querySelector('#el-sched-label').value.trim()
                };
                if (ref.jobId) body.jobId = ref.jobId; else body.reportId = ref.reportId;
                const r = await EL.api('/api/schedules', { method: 'POST', body });
                note.style.color = '#10b981';
                note.textContent = `Scheduled. First run ${new Date(r.schedule.next_run_at).toLocaleString()}.`;
                if (onDone) onDone(r.schedule);
                setTimeout(close, 1400);
            } catch (err) {
                e.currentTarget.disabled = false;
                note.style.color = '#ef4444'; note.textContent = err.message;
            }
        });
    }

        // Job-banner CSS lives in app.css as of phase 18. It was an IIFE here,
    // so it injected on every page load whether or not a job ever ran.


    /**
     * A waiting state that is honest about what it is waiting for.
     *
     * Deliberately not a spinner: a spinner says "something is happening" and
     * nothing else, so a thirty-second one reads as a hang. Naming the cause
     * and giving a rough duration is the difference between someone waiting
     * and someone reloading — and a reload restarts the cold start.
     */
    function bootNotice(title, message) {
        if (document.getElementById('el-boot')) return;
        const el = document.createElement('div');
        el.id = 'el-boot';
        el.className = 'el-boot';
        el.innerHTML = `
            <div class="el-boot-card">
                <div class="el-boot-bar"><i></i></div>
                <h3>${title}</h3>
                <p>${message}</p>
            </div>`;
        document.body.appendChild(el);
    }

    function clearBootNotice() {
        const el = document.getElementById('el-boot');
        if (el) el.remove();
    }

    function block(title, message) {
        document.querySelectorAll('.el-page').forEach(el => el.remove());
        const card = document.createElement('div');
        card.className = 'el-blocked';
        card.innerHTML = `<h2>${title}</h2><p>${message}</p>
            <button class="el-btn" type="button" onclick="location.reload()">Reload</button>`;
        document.body.appendChild(card);
    }

    /**
     * A lapsed account is not an error, it is a state with a next step. This is
     * the whole reason the server answers 402 instead of 403: "your trial ended,
     * here is how to continue" and "you may not do this" are different screens,
     * and a page cannot tell them apart if both arrive as 403.
     *
     * Idempotent — EL.api and EL.init can both reach it on the same load.
     */
    function blockExpired(data) {
        if (document.querySelector('.el-blocked[data-expired]')) return;
        document.querySelectorAll('.el-page').forEach(el => el.remove());

        const ended = data && data.ended_at ? new Date(data.ended_at) : null;
        const when  = ended && !isNaN(ended.getTime()) ? ended.toLocaleDateString() : null;

        const card = document.createElement('div');
        card.className = 'el-blocked';
        card.setAttribute('data-expired', '1');
        card.innerHTML = `
            <h2>Your access has ended</h2>
            <p>${EL.escape((data && data.error) || 'This account has no active plan.')}</p>
            ${when ? `<p class="el-job-detail">Ended ${EL.escape(when)}.</p>` : ''}
            <p class="el-job-detail">Nothing has been deleted. Your reports and data are waiting,
               and everything returns the moment the account is reactivated.</p>
            <div class="el-job-actions">
                ${data && data.activation_requested_at
                    ? `<span class="el-note">You asked to continue on ${EL.escape(new Date(data.activation_requested_at).toLocaleDateString())}. The team has it.</span>`
                    : `<button class="el-btn el-btn-go" type="button" id="el-req-continue">Ask to continue</button>`}
                <button class="el-btn" type="button" onclick="location.reload()">Reload</button>
            </div>
            <div id="el-expired-contact"></div>`;
        document.body.appendChild(card);

        // What the admin set, or the build-time address as a fallback. Filled
        // after the card is up so a slow answer never delays the screen.
        EL.contact().then(c => {
            const host = document.getElementById('el-expired-contact');
            if (!host) return;
            const eff = { email: c.email || SUPPORT_EMAIL, paymentOptions: c.paymentOptions };
            host.innerHTML = contactSlotHtml(eff, { lead: 'To activate now' });
        });

        // This used to be the end of the road: "contact us" with, when
        // SUPPORT_EMAIL was blank, nobody to contact. The business model is
        // try-then-buy, and the buy step had no button.
        const ask = document.getElementById('el-req-continue');
        if (ask) ask.addEventListener('click', async () => {
            ask.disabled = true; ask.textContent = 'Sending…';
            try {
                const r = await EL.requestActivation();
                ask.replaceWith(Object.assign(document.createElement('span'), { className: 'el-note',
                    textContent: `Request sent. The team will be in touch${r && r.email ? ' at ' + r.email : ''}.` }));
            } catch (err) { ask.disabled = false; ask.textContent = 'Ask to continue'; }
        });
    }

    window.EL = EL;
})();
