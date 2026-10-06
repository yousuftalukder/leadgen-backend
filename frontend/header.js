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
     * The staff menu is places, not tools (phase 33). The client is the unit
     * of work, so the menu is where work is found — Home, your tasks, the
     * clients, every lead, what repeats — and the tools are things you do FOR
     * a client, started from "New work" on the client or in the rail. Fifteen
     * tool names in a list read as a workbench nobody could find their way
     * around; five places read as an agency.
     *
     * `icon` names an entry in ICONS: drawn, so every row lines up and looks
     * the same on every platform, where emoji did neither.
     */
    const NAV = [
        { href: 'home.html',      icon: 'home',    label: 'Home',      engine: null },
        { href: 'my-tasks.html',  icon: 'check',   label: 'My tasks',  engine: null, count: 'tasks' },
        { href: 'clients.html',   icon: 'clients', label: 'Clients',   engine: null, count: 'clients' },
        { href: 'leads.html',     icon: 'leads',   label: 'Leads',     engine: 'leadgen' },
        { href: 'pipeline.html',  icon: 'target',  label: 'Pipeline',  engine: 'leadgen', count: 'followups' },
        { href: 'schedules.html', icon: 'clock',   label: 'Schedules', engine: null },
        { group: 'Admin' },
        { href: 'admin.html',     icon: 'shield',  label: 'Team & settings', adminOnly: true }
    ];

    /** Pages that belong under a menu entry without being one. */
    const NAV_PARENT = { 'workspace.html': 'clients.html' };

    /**
     * Everything that can be done for a client, grouped by what the agency is
     * trying to achieve rather than by platform. Each opens its page with the
     * client already chosen (?client=), so the question "for whom?" is asked
     * once, before the tool, and never again on the way.
     *
     * `apify` is true for the engines that spend scraping credit, so the list
     * can say which do before anyone starts one.
     */
    const WORK = [
        { group: 'Check performance', items: [
            { href: 'ig-report.html',      name: 'Instagram audit',          text: 'Score their recent posts against local peers.',               engine: 'report',       apify: true },
            { href: 'fb-report.html',      name: 'Facebook Page report',     text: 'Posting rhythm, reactions and reviews on their Page.',        engine: 'fb_page',      apify: true },
            { href: 'workspace.html',      name: 'Monthly report',           text: 'Last month from their own Meta numbers, in plain words.',     engine: 'meta_owned',   tab: 'meta' }
        ] },
        { group: 'Compare with competitors', items: [
            { href: 'ig-competitors.html', name: 'Competitor benchmark',     text: 'Side by side with their rivals: rank, gaps, what rivals win.', engine: 'report',       apify: true },
            { href: 'workspace.html',      name: 'Find competitors',         text: 'Suggest similar businesses to compare against.',              engine: 'report',       apify: true, tab: 'settings' }
        ] },
        { group: 'Plan content', items: [
            { href: 'content-plan.html',   name: 'Content plan',             text: 'A month of posts built from what already works for them.',    engine: 'content_plan' },
            { href: 'fb-advisor.html',     name: 'Group post ideas',         text: 'Draft posts for the Facebook groups their customers use.',    engine: 'fb_community' }
        ] },
        { group: 'Find customers', items: [
            { href: 'index.html',          name: 'Find leads on Instagram',  text: 'Local accounts by place, hashtag or a rival’s followers.',    engine: 'leadgen',      apify: true },
            { href: 'leads.html',          name: 'Find Facebook Pages',      text: 'Local businesses with a contact button, ready for outreach.', engine: 'leadgen',      apify: true },
            { href: 'fb-communities.html', name: 'Find Facebook groups',     text: 'Local groups where people ask for recommendations.',          engine: 'fb_community', apify: true },
            { href: 'fb-audit.html',       name: 'Read Facebook groups',     text: 'Pull real customer requests out of recent group posts.',      engine: 'fb_community', apify: true },
            { href: 'fb-leads.html',       name: 'Local demand',             text: 'The requests found so far, ready to answer.',                 engine: 'fb_community' },
            { href: 'reviews.html',        name: 'Review tracker',           text: 'Who reviewed the businesses around a place, and the creators behind it.', engine: 'leadgen', apify: true }
        ] },
        { group: 'Ask', items: [
            { href: 'workspace.html', name: 'Account assistant', text: 'What we did, what is planned, and their numbers, in one chat.', engine: null, tab: 'ask' }
        ] }
    ];

    /** Line icons, 24-unit grid, drawn in currentColor. */
    const ICONS = {
        home: '<path d="M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z"/>',
        clients: '<path d="M4 21V5l8-2v18"/><path d="M12 21h8V9l-8-2"/><path d="M8 8h.01M8 12h.01M8 16h.01M16 12h.01M16 16h.01"/>',
        leads: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
        clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
        shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
        check: '<path d="M5 12l5 5 9-10"/>',
        plus: '<path d="M12 5v14M5 12h14"/>',
        search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
        x: '<path d="M6 6l12 12M18 6 6 18"/>',
        arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
        doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
        spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
        target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
        store: '<path d="M4 9l1.5-5h13L20 9"/><path d="M4 9h16v2a3 3 0 0 1-5.3 1.9A3 3 0 0 1 12 14a3 3 0 0 1-2.7-1.1A3 3 0 0 1 4 11z"/><path d="M5 13v8h14v-8"/>',
        plug: '<path d="M9 3v5M15 3v5"/><path d="M7 8h10v4a5 5 0 0 1-10 0z"/><path d="M12 17v4"/>',
        key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 5l3 3M14 7l2 2"/>',
        chat: '<path d="M4 5h16v11H9l-5 4z"/>',
        users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.8c1.7.7 2.8 2.4 3 5.2"/>',
        link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
        sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
        chart: '<path d="M4 20V4M4 20h16M8 16v-5M12 16V8M16 16v-3"/>',
        play: '<path d="M7 5v14l11-7z"/>',
        pen: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
        alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
        info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
        out: '<path d="M15 4h4v16h-4"/><path d="M10 8l-4 4 4 4M6 12h10"/>'
    };
    const icon = (name, cls = '') => ICONS[name]
        ? `<svg class="el-svg ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`
        : '';

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
        'leads.html',       // Facebook Page discovery starts from the Lead List
        'reviews.html'      // the review tracker (phase 41)
    ];

    /**
     * What a client sees. A client is not an employee with fewer grants — the
     * employee menu is the agency's, and handing it to a business owner
     * buries the one page they came for.
     *
     * Engine filtering still applies on top, so a client without a grant does
     * not see the tab either.
     */
    /** Owner tools that open inside the Edge Meta AI app, as a sheet (phase 49). */
    const OWNER_EMBEDS = ['client-leads.html', 'client-community.html'];

    const CLIENT_NAV = [
        { href: 'client.html',           icon: 'home',   label: 'Home',           engine: null },
        { href: 'client-assistant.html', icon: 'spark',  label: 'Edge Meta AI',   engine: null },
        { href: 'client-leads.html',     icon: 'target', label: 'Find customers', engine: 'leadgen' },
        { href: 'client-community.html', icon: 'store',  label: 'Local demand',   engine: 'fb_community' }
    ];


    // phase 10/11 additions to the shell

    // The browser-tab icon, on every page that runs the shell and does not name one itself.
    if (!document.querySelector('link[rel~="icon"]')) {
        const fav = document.createElement('link');
        fav.rel = 'icon'; fav.type = 'image/png'; fav.href = 'icons/favicon-64.png?v=2';
        document.head.appendChild(fav);
    }

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

            if (!isPublic) {
                const terminal = EL.refused(res.status, data);
                if (terminal) throw terminal;
            }
            // A hit allowance is a 402 too, but not a terminal one: the account is
            // fine, this one action is not available, so the page shows it in place.
            if (res.status === 402 && !isPublic) {
                const err = new Error((data && data.error) || 'That is not available on your plan.');
                err.status = 402; err.data = data; err.quota = true;
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

        /**
         * The refusals that end the session's use of the page, whoever made the
         * request (EL.api, or a page's own fetch such as the chat's stream): a
         * lost session, a lapsed or disabled account, an owner whose business is
         * gone (phase 52). Puts the right screen up and returns the error to
         * throw; null for anything a page handles itself.
         *
         * 402 covers two different things. A lapsed account is terminal and
         * gets the whole screen. A hit allowance is not, so it returns null here.
         */
        refused(status, data) {
            const fail = (msg, extra) => Object.assign(new Error(msg), { status, data, handled: true }, extra || {});
            if (status === 401) { EL.signOut(); return fail('Session expired. Sign in again.'); }
            if (status === 402 && (!data || data.state === 'expired' || data.code === 'account_expired')) {
                blockExpired(data);
                return fail((data && data.error) || 'Your access has ended.');
            }
            // A disabled account is terminal, like a lapsed one, and gets the
            // whole screen. Without this it fell through to the generic error
            // and EL.init labelled it "Backend unreachable" — the right message
            // under the wrong heading, which reads as our fault, not theirs.
            if (status === 403 && data && data.code === 'account_suspended') {
                if (!EL._app && !EL.isEmbedded()) renderShell(null, null);
                block('Account disabled', EL.escape(data.error || 'This account has been disabled. Contact your administrator.'));
                return fail(data.error || 'Account disabled.', { code: data.code });
            }
            if (status === 403 && data && data.code === 'no_business') {
                EL.blockNoBusiness();
                return fail(data.error, { code: data.code });
            }
            return null;
        },

        /** An owner login whose business the agency has closed: nothing here to show any more. (phase 52) */
        blockNoBusiness() {
            block('Your access has ended', 'Your agency has closed this business’s Edge Meta AI, or has not set one up for this login. Nothing you saw has been deleted. Contact your agency to open it again.');
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
            // Keys, credit and resuming are the agency's (phase 52): an owner's page says it in its own words (onPaused).
            if (EL.me && EL.me.role === 'client') return;
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
            // The Edge Meta AI app signs in on its own page, so an owner signs out to it too
            // (phase 47); someone on the team who opened the app goes to EdgeLead's login. A
            // shared tool open inside the app takes the whole app with it, not just its frame.
            const owner = !EL.me || EL.me.role === 'client';
            const dest = new URL((EL._app || EL.isEmbedded()) && owner ? 'ai/' : 'index.html', location.href).href;
            let win = window;
            if (EL.isEmbedded() && owner) { try { if (window.top.location.origin === location.origin) win = window.top; } catch { /* another origin */ } }
            win.location.href = dest;
        },

        /**
         * The Supabase client, available before init (phase 47): the Edge Meta AI
         * app signs in on its own page instead of sending the owner out to the
         * EdgeLead login, which on a phone would leave the installed app.
         */
        authClient() {
            if (!EL.supabase) EL.supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
            return EL.supabase;
        },

        /** Boots the header. Resolves with /api/me, or blocks the page and never resolves. */
        async init(options = {}) {
            const { engine = 'leadgen', page, requireAdmin = false, app = null } = options;
            EL.engine = engine;
            EL._app = app;

            injectStyles();

            // ---- share mode: a client opening a read-only link --------------
            const shareTok = EL.shareToken();
            if (shareTok) {
                EL._shared = { token: shareTok };
                document.body.classList.add('el-share', 'el-has-header');
                renderShareBar();
                return { shared: true, role: 'viewer', engines: [] };
            }

            EL.authClient();

            const { data } = await EL.supabase.auth.getSession();
            if (!data.session) { window.location.href = app ? 'ai/' : 'index.html'; return new Promise(() => {}); }
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
                if (!app && !EL.isEmbedded()) renderShell(page, null);
                block('Backend unreachable', `The API did not answer: ${EL.escape(err.message)}. Check that the service is awake, then reload.`);
                return new Promise(() => {});
            }
            EL.me = me;

            // A page opened from a client (New work, a workspace tab, a link)
            // carries ?client=. It becomes the chosen client before any page
            // code reads it, so the work is filed where it was started from.
            // The picker drops it again if this account cannot open it.
            const wanted = new URLSearchParams(location.search).get('client');
            if (me.role !== 'client' && wanted && /^[0-9a-f-]{36}$/i.test(wanted)) EL.setClientId(wanted);

            // A client who lands on an employee page goes home rather than
            // being shown a console built for somebody else. Engine grants
            // alone would not catch this: a trial holds the report grant, so
            // nothing would stop them opening the full audit workbench.
            // Phase 49: a business owner lives in Edge Meta AI and nowhere else. Every
            // dashboard page sends them there, carrying the query (a Meta login coming
            // back, say). A shared tool opened inside the app (?embed=1) is the exception.
            if (me.role === 'client' && !app) {
                const sharedTool = EL.isEmbedded() && OWNER_EMBEDS.includes(currentPage(page));
                if (!sharedTool) {
                    window.location.replace('ai/' + location.search);
                    return new Promise(() => {});
                }
            }

            if (app) {
                // An app of its own (phase 47): the page draws everything. No rail,
                // no plan banner, no key strip; installable under its own name.
                document.body.classList.add('el-app');
                registerServiceWorker();
                mountInstallNudge(APPS[app]);
            } else if (EL.isEmbedded()) {
                // Inside the client page's report viewer (phase 31.3): the page's
                // content alone, without the rail, the plan banner or the work-for
                // bar. The access checks below still apply.
                document.body.classList.add('el-embed');
            } else {
                renderShell(page, me);
                renderPlanBanner(me);
                renderKeyNudge(me);
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
        // WORKSPACE PRIMITIVES (phase 33) — one drawer, one toast, one icon
        // set, one "new work" flow, shared by the shell and every page.
        // ---------------------------------------------------------------
        icon,
        drawer: openDrawer,
        closeDrawer,
        toast,
        newWork,
        /** The client a workspace page is about; New work starts there. */
        _pageClientId: null,
        /** Put a client at the top of "Recent clients" in this browser. */
        rememberClient(id) {
            if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return;
            EL._pageClientId = id;
            try { localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recentIds().filter(x => x !== id)].slice(0, 8))); } catch { /* private mode */ }
            if (EL._clients) renderRecent(EL._clients);
        },

        // ---------------------------------------------------------------
        // CLIENT WORKSPACE (phase 9/10)
        // A run started with a client selected is filed under that client
        // and visible to its members. The choice is remembered per browser
        // and the picker lives in the header bar on every page.
        // ---------------------------------------------------------------
        _clients: null,
        clientId() {
            // An owner is their business; a client picked on this device by the team is not theirs. (phase 51)
            if (EL.me && EL.me.role === 'client') return null;
            let v = '';
            try { v = localStorage.getItem(CLIENT_KEY) || ''; } catch { /* private mode */ }
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
            const targets = [document.getElementById('el-workfor')].filter(Boolean);
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
            if (EL._clientsErr) {
                bar.classList.add('is-empty');
                bar.innerHTML = `<span class="el-wf-tag">Client</span><span><b>Your clients could not be loaded</b> (${EL.esc(EL._clientsErr)}). Reload the page to try again.</span>`;
                return;
            }
            const c = cur ? list.find(x => x.id === cur) : null;
            bar.classList.toggle('is-empty', !c);
            bar.innerHTML = c
                ? `<span class="el-wf-tag">Client</span>
                   <span>Filing under <a href="workspace.html?client=${encodeURIComponent(c.id)}"><b>${EL.esc(c.name)}</b></a>${c.ig_handle ? ' · @' + EL.esc(c.ig_handle) : ''}${c.meta && c.meta.connected ? ' · Meta connected' : ''}</span>
                   <select class="el-client-select" aria-label="Which client this work is for">${EL._clientOptions(list, cur)}</select>`
                : `<span class="el-wf-tag">Client</span>
                   <span><b>Choose the client this work is for.</b> Nothing runs until you do${list.length ? '' : ' — <a href="clients.html?add=1">add one</a> first'}.</span>
                   <select class="el-client-select" aria-label="Which client this work is for">${EL._clientOptions(list, cur)}</select>`;
            bar.querySelector('select').addEventListener('change', EL._onClientChange);
        },

        async _mountClientPicker() {
            // A client account is the business; asking it to pick one is noise.
            if (EL.me && EL.me.role === 'client') return;
            const list = await EL.clients();
            const current = EL.clientId();
            if (current && !EL._clientsErr && !list.some(c => c.id === current)) EL.setClientId(null);
            const cur = EL.clientId();
            setCount('clients', list.filter(c => !c.archived).length);
            renderRecent(list);
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
                <button class="el-btn el-mini" type="button" data-act="owner" hidden></button>
                <button class="el-btn el-mini" type="button" data-act="share">🔗 Share link</button>
                <button class="el-btn el-mini" type="button" data-act="schedule">⏱ Repeat on a schedule</button>
                <span class="el-note" data-role="note"></span>
                <div class="el-share-list" data-role="shares"></div>`;
            const note = host.querySelector('[data-role="note"]');
            const list = host.querySelector('[data-role="shares"]');

            // Phase 51: a report reaches the business owner's app only once someone shares it here.
            const ownerBtn = host.querySelector('[data-act="owner"]');
            const drawOwner = (v) => {
                ownerBtn.dataset.on = v ? '1' : '';
                ownerBtn.textContent = v ? '✓ Shown in the owner’s app' : '👁 Share with the owner';
                ownerBtn.title = v ? 'The owner sees this report in Edge Meta AI. Click to hide it again.' : 'Only your team sees this report. Click to show it in the owner’s Edge Meta AI.';
                ownerBtn.classList.toggle('el-btn-go', !!v);
            };
            EL.api(`/api/reports/${encodeURIComponent(reportId)}/visibility`).then(v => {
                if (!v || !v.clientId || v.unavailable) return;
                drawOwner(v.visibleToClient);
                ownerBtn.hidden = false;
                ownerBtn.disabled = !v.canEdit;
                ownerBtn.addEventListener('click', async () => {
                    const want = ownerBtn.dataset.on !== '1';
                    ownerBtn.disabled = true;
                    try {
                        const r = await EL.api(`/api/reports/${encodeURIComponent(reportId)}/visibility`, { method: 'PATCH', body: { visible: want } });
                        drawOwner(r.visibleToClient);
                        note.style.color = '#10b981';
                        note.textContent = r.visibleToClient ? 'The owner now sees this report in their app.' : 'Hidden from the owner again.';
                    } catch (err) { note.style.color = '#ef4444'; note.textContent = err.message; }
                    finally { ownerBtn.disabled = false; }
                });
            }).catch(() => {});

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
        const active = NAV_PARENT[here] || here;
        const isAdmin = me && me.role === 'admin';
        const isClient = me && me.role === 'client';
        const engines = (me && me.engines) || [];
        // Keys and the Apify status are the team's tools. A business owner
        // sees them only when their runs spend their own credit.
        const keys = !isClient || !!(me && me.ownKey);

        const visible = (isClient ? CLIENT_NAV : NAV)
            .filter(t => {
                if (t.group) return true;                    // resolved below
                if (t.adminOnly) return isAdmin;
                if (!me) return true;
                if (t.engine === null) return true;          // every signed-in user
                return isAdmin || engines.includes(t.engine);
            });

        // Drop a group heading whose whole section was filtered away by engine
        // grants — an empty heading sitting over nothing reads as something
        // broken. A heading survives only if a link follows it before the next
        // heading does.
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
            : `<a class="el-tab ${t.href === active ? 'is-active' : ''}" href="${t.href}">
                   <span class="el-ico" aria-hidden="true">${icon(t.icon)}</span>
                   <span class="el-lab">${t.label}${t.adminOnly && me && me.pendingActivations
                       ? `<span class="el-badge" title="${me.pendingActivations} client(s) asked to continue">${me.pendingActivations}</span>` : ''}</span>
                   ${t.count ? `<span class="el-count" data-count="${t.count}"></span>` : ''}
               </a>`).join('');

        const email = (me && me.email) || (EL.user && EL.user.email) || '';
        const who = (me && me.full_name) || email.split('@')[0] || 'You';
        const initials = String(who).split(/[\s._-]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '•';
        const roleName = !me ? '' : (me.role === 'admin' ? 'Admin' : me.role === 'client' ? 'Owner' : 'Team');

        // A rail rather than a top bar: every destination visible at once, and
        // the two things done from anywhere — start work, find a client — at
        // the top of it, where the eye starts.
        const bar = document.createElement('aside');
        bar.className = 'el-sidebar';
        bar.id = 'el-sidebar';
        bar.innerHTML = `
            <div class="el-side-top">
                <a class="el-logo" href="${isClient ? 'client.html' : 'home.html'}" aria-label="EdgeLead home"><img class="el-logo-mark" src="icons/logo-mark.png?v=2" alt="" width="27" height="32"><span class="el-logo-text"><span>EdgeLead</span>${isClient ? '' : '<small class="el-logo-sub">Workspace</small>'}</span></a>
                ${isClient || !me ? '' : `
                <button class="el-newwork" type="button" id="el-newwork">${icon('plus')}<span>New work</span></button>
                <div class="el-find" role="search">
                    ${icon('search')}
                    <input id="el-find" type="search" placeholder="Find a client" autocomplete="off" aria-label="Find a client" aria-controls="el-find-list">
                    <div class="el-find-list" id="el-find-list" role="listbox" hidden></div>
                </div>`}
            </div>

            <nav class="el-nav" aria-label="Sections">${tabs}
                ${isClient ? '' : '<div class="el-group" id="el-recent-h" hidden>Recent clients</div><div id="el-recent"></div>'}
            </nav>

            <div class="el-side-foot">
                ${keys ? `<div class="el-pill">
                    <span class="el-node" id="el-node"></span>
                    <span id="el-status">Checking Apify…</span>
                </div>` : ''}
                <div class="el-user">
                    <span class="el-avatar" aria-hidden="true">${EL.esc(initials)}</span>
                    <span class="el-user-txt"><b>${EL.esc(who)}</b><small>${EL.esc(roleName)}</small></span>
                </div>
                ${keys ? `<div class="el-side-actions">
                    <button class="el-btn el-mini" type="button" id="el-key-btn" title="The Apify key your runs spend">Apify key</button>
                    <button class="el-btn el-mini" type="button" id="el-ai-btn" title="Your own Gemini key — used only for runs you start">AI key</button>
                </div>` : ''}
                <button class="el-btn el-mini el-signout" type="button" id="el-out">Sign out</button>
            </div>`;

        // The rail is off-canvas on a phone, so the bar that opens it has to
        // exist before it — otherwise there is no way back to navigation.
        const top = document.createElement('div');
        top.className = 'el-topbar';
        top.innerHTML = `
            <button class="el-burger" type="button" id="el-burger" aria-label="Open navigation" aria-expanded="false" aria-controls="el-sidebar">
                <span></span><span></span><span></span>
            </button>
            <div class="el-logo"><img class="el-logo-mark" src="icons/logo-mark.png?v=2" alt="" width="27" height="32"><span>EdgeLead</span></div>
            ${isClient || !me ? '' : `<button class="el-newwork el-newwork-top" type="button" id="el-newwork-top" aria-label="New work">${icon('plus')}</button>`}`;

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

        if (keys) {
            bar.querySelector('#el-key-btn').addEventListener('click', openKeyModal);
            bar.querySelector('#el-ai-btn').addEventListener('click', openGeminiModal);
        }
        bar.querySelector('#el-out').addEventListener('click', () => EL.signOut());

        if (!isClient && me) {
            const go = () => {
                setOpen(false);
                EL.newWork(EL._pageClientId || (WORK_PAGES.includes(here) ? EL.clientId() : null));
            };
            bar.querySelector('#el-newwork').addEventListener('click', go);
            top.querySelector('#el-newwork-top').addEventListener('click', go);
            wireFind(bar.querySelector('#el-find'), bar.querySelector('#el-find-list'));
            // "My tasks" is a count of what is still open. Quiet on failure:
            // before the phase-32 SQL has run it is simply not there yet.
            EL.api('/api/my-tasks').then(d => {
                const open = (d.tasks || []).filter(t => t.status !== 'done');
                const late = open.filter(t => t.dueDate && t.dueDate < new Date().toISOString().slice(0, 10)).length;
                setCount('tasks', open.length, late ? `${late} overdue` : '', late > 0);
            }).catch(() => {});
            // Follow-ups due today or overdue on your leads (phase 40). Quiet
            // before the phase-40 SQL, and for anyone without the lead tools.
            const me = EL.me || {};
            if (me.role === 'admin' || (me.engines || []).includes('leadgen')) {
                EL.api('/api/leads/pipeline?assigned=me&open=1').then(d => {
                    setCount('followups', d.dueNow || 0, d.dueNow ? `${d.dueNow} follow-up${d.dueNow === 1 ? '' : 's'} due` : '', (d.dueNow || 0) > 0);
                }).catch(() => {});
            }
        }
    }

    /** A number beside a menu entry; `hot` marks it as needing attention. */
    function setCount(key, n, title = '', hot = false) {
        document.querySelectorAll(`.el-count[data-count="${key}"]`).forEach(el => {
            el.textContent = n ? String(n) : '';
            el.title = title;
            el.classList.toggle('is-hot', !!hot);
        });
    }

    /**
     * Recent clients: the last few opened in this browser, filled from the
     * rest of the list so a new account still has something to click.
     */
    const RECENT_KEY = 'el-recent-clients';
    function recentIds() {
        try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
    }
    function renderRecent(list) {
        const host = document.getElementById('el-recent');
        const head = document.getElementById('el-recent-h');
        if (!host || !head) return;
        const live = (list || []).filter(c => !c.archived);
        const byId = new Map(live.map(c => [c.id, c]));
        const picked = recentIds().map(id => byId.get(id)).filter(Boolean);
        for (const c of live) { if (picked.length >= 5) break; if (!picked.includes(c)) picked.push(c); }
        head.hidden = !picked.length;
        const here = EL._pageClientId || (currentPage() === 'workspace.html' ? new URLSearchParams(location.search).get('client') : null);
        host.innerHTML = picked.slice(0, 5).map(c => `
            <a class="el-tab el-recent ${c.id === here ? 'is-active' : ''}" href="workspace.html?client=${encodeURIComponent(c.id)}" title="${EL.esc(c.name)}">
                <span class="el-ico" aria-hidden="true"><span class="el-dot ${c.meta && c.meta.connected ? 'is-on' : ''}"></span></span>
                <span class="el-lab">${EL.esc(c.name)}</span>
            </a>`).join('');
    }

    /** Type to find a client; Enter opens the first match. */
    function wireFind(input, listEl) {
        if (!input || !listEl) return;
        let matches = [];
        const close = () => { listEl.hidden = true; listEl.innerHTML = ''; };
        const draw = async () => {
            const q = input.value.trim().toLowerCase();
            if (!q) { close(); return; }
            const list = (await EL.clients()).filter(c => !c.archived);
            matches = list.filter(c => [c.name, c.ig_handle, c.niche, c.location].filter(Boolean).join(' ').toLowerCase().includes(q)).slice(0, 8);
            listEl.hidden = false;
            listEl.innerHTML = matches.length
                ? matches.map((c, i) => `<a role="option" class="el-find-row${i === 0 ? ' is-first' : ''}" href="workspace.html?client=${encodeURIComponent(c.id)}">
                      <b>${EL.esc(c.name)}</b><small>${EL.esc([c.niche, c.location].filter(Boolean).join(' · ') || (c.ig_handle ? '@' + c.ig_handle : ''))}</small></a>`).join('')
                : `<div class="el-find-none">No client matches “${EL.esc(input.value.trim())}”. <a href="clients.html?add=1">Add a client</a></div>`;
        };
        input.addEventListener('input', draw);
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter' && matches[0]) { e.preventDefault(); location.href = `workspace.html?client=${encodeURIComponent(matches[0].id)}`; }
            if (e.key === 'Escape') { input.value = ''; close(); }
        });
        input.addEventListener('blur', () => setTimeout(close, 150));
    }

    // ---- drawers and toasts: the two overlays every workspace page uses ------

    /**
     * A panel from the right: header, scrolling body, optional footer. Returns
     * { el, body, foot, close }. Escape and the scrim close it; focus goes in
     * on open and back to where it came from on close.
     */
    function openDrawer({ title = '', sub = '', body = '', foot = '', wide = false, onClose = null } = {}) {
        closeDrawer();
        const back = document.activeElement;
        const wrap = document.createElement('div');
        wrap.className = 'el-drawer-wrap';
        wrap.id = 'el-drawer';
        wrap.innerHTML = `
            <div class="el-drawer-scrim" data-dw-close></div>
            <aside class="el-drawer${wide ? ' is-wide' : ''}${wide === 'xl' ? ' is-xl' : ''}" role="dialog" aria-modal="true" aria-labelledby="el-dw-title">
                <header class="el-drawer-h">
                    <div class="el-drawer-t"><h2 id="el-dw-title">${title}</h2>${sub ? `<p>${sub}</p>` : ''}</div>
                    <button class="el-iconbtn" type="button" data-dw-close aria-label="Close">${icon('x')}</button>
                </header>
                <div class="el-drawer-b">${body}</div>
                ${foot ? `<footer class="el-drawer-f">${foot}</footer>` : ''}
            </aside>`;
        document.body.appendChild(wrap);
        document.body.classList.add('el-drawer-open');
        const api = {
            el: wrap,
            body: wrap.querySelector('.el-drawer-b'),
            foot: wrap.querySelector('.el-drawer-f'),
            setTitle(t, s) { wrap.querySelector('#el-dw-title').innerHTML = t; const p = wrap.querySelector('.el-drawer-t p'); if (p && s !== undefined) p.innerHTML = s; },
            close() { closeDrawer(); }
        };
        wrap._onClose = () => { if (onClose) onClose(); if (back && back.focus) back.focus(); };
        wrap.querySelectorAll('[data-dw-close]').forEach(b => b.addEventListener('click', () => closeDrawer()));
        const first = wrap.querySelector('.el-drawer-b input, .el-drawer-b select, .el-drawer-b textarea, .el-drawer-b button, .el-drawer-b a');
        setTimeout(() => (first || wrap.querySelector('[data-dw-close]')).focus(), 30);
        return api;
    }
    function closeDrawer() {
        const w = document.getElementById('el-drawer');
        if (!w) return;
        w.remove();
        document.body.classList.remove('el-drawer-open');
        if (w._onClose) w._onClose();
    }
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.getElementById('el-drawer')) closeDrawer(); });

    let _toastTimer = null;
    function toast(message, kind = 'ok') {
        let t = document.getElementById('el-toast');
        if (!t) { t = document.createElement('div'); t.id = 'el-toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
        t.className = 'el-toast is-' + kind;
        t.innerHTML = `${icon(kind === 'bad' ? 'alert' : 'check')}<span>${EL.esc(message)}</span>`;
        t.hidden = false;
        clearTimeout(_toastTimer);
        _toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
    }

    /**
     * New work: for whom first, then what. Every entry opens its page with
     * the client already chosen, so work is filed before it is started.
     */
    async function newWork(clientId) {
        const me = EL.me || {};
        const isAdmin = me.role === 'admin';
        const can = item => item.engine === null || isAdmin || (me.engines || []).includes(item.engine);
        const list = (await EL.clients()).filter(c => !c.archived);
        const client = clientId ? list.find(c => c.id === clientId) : null;

        if (!client) {
            const d = openDrawer({
                title: 'New work',
                sub: 'Who is it for? Everything is filed under a client.',
                body: `
                    <div class="el-field"><input type="search" id="el-nw-q" placeholder="Find a client" autocomplete="off" aria-label="Find a client"></div>
                    <div class="el-pick" id="el-nw-list"></div>
                    <a class="el-btn el-add" href="clients.html?add=1">${icon('plus')}Add a new client first</a>`
            });
            const draw = () => {
                const q = (d.body.querySelector('#el-nw-q').value || '').trim().toLowerCase();
                const rows = list.filter(c => !q || [c.name, c.niche, c.location, c.ig_handle].filter(Boolean).join(' ').toLowerCase().includes(q));
                d.body.querySelector('#el-nw-list').innerHTML = rows.length ? rows.map(c => `
                    <button type="button" class="el-pick-row" data-pick="${EL.esc(c.id)}">
                        <span class="el-avatar">${EL.esc(String(c.name || '?').split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase())}</span>
                        <span class="el-pick-t"><b>${EL.esc(c.name)}</b><small>${EL.esc([c.niche, c.location].filter(Boolean).join(' · ') || 'No details yet')}</small></span>
                        <span class="el-chip ${c.meta && c.meta.connected ? 'is-jade' : ''}">${c.meta && c.meta.connected ? 'Meta connected' : 'No Meta'}</span>
                    </button>`).join('') : `<p class="el-muted">${list.length ? 'No client matches that.' : 'No clients yet.'}</p>`;
                d.body.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => newWork(b.dataset.pick)));
            };
            d.body.querySelector('#el-nw-q').addEventListener('input', draw);
            draw();
            return d;
        }

        const connected = !!(client.meta && client.meta.connected);
        const href = item => `${item.href}?client=${encodeURIComponent(client.id)}${item.tab ? '&tab=' + item.tab : ''}`;
        const groups = WORK.map(g => {
            const items = g.items.filter(can);
            if (!items.length) return '';
            return `<div class="el-work-g"><div class="el-eyebrow">${g.group}</div>${items.map(item => {
                const blocked = item.engine === 'meta_owned' && !connected;
                const tag = item.apify ? '<span class="el-chip">Uses Apify credit</span>' : '<span class="el-chip is-jade">No Apify cost</span>';
                return `<a class="el-work" href="${href(item)}">
                    <span class="el-work-t"><b>${item.name}</b><small>${blocked ? 'Needs Meta connected first — opens the Meta tab.' : item.text}</small></span>
                    ${tag}
                </a>`;
            }).join('')}</div>`;
        }).join('');
        const d = openDrawer({
            title: `New work for ${EL.esc(client.name)}`,
            sub: 'Pages open with this client chosen, so everything you run is filed here.',
            body: `${groups}<button type="button" class="el-btn el-add" id="el-nw-other">Someone else</button>`
        });
        d.body.querySelector('#el-nw-other').addEventListener('click', () => newWork(null));
        return d;
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
    /** Installable apps besides EdgeLead itself, as the install nudge names them. (phase 47) */
    const APPS = {
        ai: { name: 'Edge Meta AI', icon: 'icons/ai-192.png?v=1', key: 'el-install-dismissed-ai', mount: '#ai-nudge',
              blurb: 'Opens straight into your chat, full screen, one tap from your phone. Ask about your Instagram and Facebook any time.' }
    };
    const EDGELEAD_APP = { name: 'EdgeLead', icon: 'icons/logo-mark.png?v=2', key: 'el-install-dismissed', mount: '.el-page',
        blurb: 'Opens like an app, full screen, one tap from your phone — your reports, your numbers every day, and a place to ask.' };

    function mountInstallNudge(appInfo) {
        const A = appInfo || EDGELEAD_APP;
        if (isStandalone() || document.getElementById('el-install')) return;
        let dismissed = 0;
        try { dismissed = Number(localStorage.getItem(A.key) || 0); } catch { /* private mode */ }
        if (dismissed && Date.now() - dismissed < 14 * 86400000) return;

        const host = document.querySelector(A.mount) || document.querySelector('.el-page') || document.body;
        const card = document.createElement('div');
        card.className = 'el-install';
        card.id = 'el-install';
        card.innerHTML = `
            <div class="el-install-ico" aria-hidden="true"><img src="${A.icon}" alt="" width="${A === EDGELEAD_APP ? 27 : 32}" height="32"></div>
            <div class="el-install-txt">
                <b>Put ${A.name} on your home screen</b>
                <span>${A.blurb}</span>
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
            showInstallHow(A);
        });
        card.querySelector('#el-install-no').addEventListener('click', () => {
            try { localStorage.setItem(A.key, String(Date.now())); } catch { /* private mode */ }
            card.remove();
        });
        window.addEventListener('appinstalled', () => card.remove());
    }

    function showInstallHow(appInfo) {
        const A = appInfo || EDGELEAD_APP;
        if (document.getElementById('el-install-how')) return;
        const ua = navigator.userAgent || '';
        const iOS = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        const steps = iOS
            ? ['Open this page in <b>Safari</b> if you are not already in it.',
               'Tap the <b>Share</b> button — the square with an arrow, at the bottom of the screen.',
               'Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.']
            : ['Open your browser\'s menu — the three dots, top right.',
               'Tap <b>Add to Home screen</b> (or <b>Install app</b>).',
               `Tap <b>Add</b> or <b>Install</b>. ${A.name} appears next to your other apps.`];
        const scrim = document.createElement('div');
        scrim.className = 'el-scrim';
        scrim.id = 'el-install-how';
        scrim.innerHTML = `
            <div class="el-modal" role="dialog" aria-modal="true" aria-labelledby="el-install-title">
                <h3 id="el-install-title">Add ${A.name} to your home screen</h3>
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
            <div class="el-logo"><img class="el-logo-mark" src="icons/logo-mark.png?v=2" alt="" width="27" height="32"><span>EdgeLead</span></div>
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
    /**
     * Staff who have not added their own Apify and AI keys are reminded on every page until they do,
     * with a gold dot on the sidebar buttons. "Later" hides the strip for a day; the dots stay.
     */
    const NUDGE_KEY = 'el.keynudge.later';
    function renderKeyNudge(me) {
        const old = document.getElementById('el-keynudge');
        if (old) old.remove();
        const k = me && me.ownKeys;
        document.getElementById('el-key-btn')?.classList.toggle('el-needs', !!k && !k.apify);
        document.getElementById('el-ai-btn')?.classList.toggle('el-needs', !!k && !k.ai);
        if (!k || (k.apify && k.ai)) return;
        let later = 0;
        try { later = Number(localStorage.getItem(NUDGE_KEY) || 0); } catch (_) { /* no storage */ }
        if (Date.now() - later < 86400000) return;
        const missing = [!k.apify ? 'Apify key' : null, !k.ai ? 'AI key' : null].filter(Boolean);
        const bar = document.createElement('div');
        bar.id = 'el-keynudge';
        bar.className = 'el-keynudge';
        bar.setAttribute('role', 'status');
        bar.innerHTML = `<span class="el-keynudge-dot" aria-hidden="true"></span>
            <span class="el-keynudge-txt"><b>Add your ${missing.join(' and ')}.</b> Your runs then use your own credit first, and the agency’s shared keys stay free for owners and scheduled work. Two minutes each; the window shows how.</span>
            <span class="el-keynudge-actions">
                ${!k.apify ? '<button class="el-btn el-btn-go el-mini" type="button" data-nudge="apify">Add Apify key</button>' : ''}
                ${!k.ai ? '<button class="el-btn el-btn-go el-mini" type="button" data-nudge="ai">Add AI key</button>' : ''}
                <button class="el-btn el-mini" type="button" data-nudge="later">Later</button>
            </span>`;
        // Beside the page's content, not inside it: pages redraw their own content after loading.
        const page = document.querySelector('.el-page, main');
        if (page && page.parentNode) page.parentNode.insertBefore(bar, page); else document.body.prepend(bar);
        bar.querySelector('[data-nudge="apify"]')?.addEventListener('click', () => openKeyModal());
        bar.querySelector('[data-nudge="ai"]')?.addEventListener('click', () => openGeminiModal());
        bar.querySelector('[data-nudge="later"]').addEventListener('click', () => {
            try { localStorage.setItem(NUDGE_KEY, String(Date.now())); } catch (_) { /* no storage */ }
            bar.remove();
        });
    }
    /** After a key is saved: mark it, and redraw the reminder. */
    function keySaved(kind) {
        if (EL.me && EL.me.ownKeys) { EL.me.ownKeys[kind] = true; renderKeyNudge(EL.me); }
    }

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
                <h3 id="el-key-title">${isAdmin ? 'Update Apify key' : 'Your Apify key'}</h3>
                <p>${isAdmin
                    ? 'Saved as the shared primary key for the selected engine. The old key stays in the pool as failover.'
                    : 'Apify pays for reading public Instagram and Facebook: lead searches, the review tracker, audits, competitor intel, Facebook reports and creator posts. Your key is encrypted and used only for runs you start; it is never shared.'}</p>
                ${isAdmin ? '' : `<details class="el-guide" open><summary>How to get one (2 minutes)</summary><ol>
                    <li>Go to <b>console.apify.com</b> and sign up with your own email. The free plan gives about $5 of credit each month.</li>
                    <li>Open <b>Settings → API &amp; Integrations</b> and copy your <b>Personal API token</b>. It starts with <code>apify_api_</code>.</li>
                    <li>Paste it below, keep <b>All my work</b>, and save. Your runs use it first; if it runs out, the agency’s shared keys take over (unless an admin set you to own keys only).</li>
                </ol></details>`}
                <label for="el-key-engine">${isAdmin ? 'Engine' : 'Use it for'}</label>
                <select id="el-key-engine">
                    ${isAdmin ? '' : '<option value="any" selected>All my work</option>'}
                    <option value="leadgen" ${isAdmin && EL.engine === 'leadgen' ? 'selected' : ''}>Lead finder</option>
                    <option value="report" ${isAdmin && EL.engine === 'report' ? 'selected' : ''}>Reports &amp; competitors</option>
                    <option value="fb_community" ${isAdmin && EL.engine === 'fb_community' ? 'selected' : ''}>Facebook communities</option>
                    <option value="fb_page" ${isAdmin && EL.engine === 'fb_page' ? 'selected' : ''}>Facebook Pages</option>
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
                if (data.scope === 'personal') keySaved('apify');
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
                <p>Gemini writes every AI part: report write-ups, content plan briefs and ideas, lead message drafts, Ask AI and Edge Meta AI when you use it.
                   Your key is encrypted, tried first for runs you start, and never used for anyone else's.${isAdmin ? ' Shared pool keys are managed on the Admin page.' : ''}</p>
                ${EL.me && EL.me.role === 'client' ? '' : `<details class="el-guide"><summary>How to get one (2 minutes)</summary><ol>
                    <li>Go to <b>aistudio.google.com</b> and sign in with <b>your own</b> Google account.</li>
                    <li>Press <b>Get API key → Create API key</b>. New keys start with <code>AQ.</code></li>
                    <li>For heavy use, turn on billing for that project in Google AI Studio: higher limits, and Google does not use your data to improve its products. At our volume it costs a few dollars a month.</li>
                    <li>Paste it below and save. Use one key from one account; more keys from the same project do not add capacity.</li>
                </ol></details>`}
                <div id="el-ai-list" class="el-note">Loading…</div>
                <label for="el-ai-label">Label</label>
                <input type="text" id="el-ai-label" placeholder="e.g. my studio key" autocomplete="off">
                <label for="el-ai-value">API key</label>
                <input type="password" id="el-ai-value" placeholder="AQ.… (from Google AI Studio)" autocomplete="off">
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
                keySaved('ai');
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
        document.querySelectorAll('.el-blocked:not([data-expired])').forEach(el => el.remove());
        blockFrame();
        const card = document.createElement('div');
        card.className = 'el-blocked';
        card.innerHTML = `<h2>${title}</h2><p>${message}</p>
            <div class="el-job-actions"><button class="el-btn" type="button" onclick="location.reload()">Reload</button>${outButton()}</div>`;
        document.body.appendChild(card);
        wireOut(card);
    }
    /** A full-screen refusal must scroll and must offer a way out, in the app too (phase 52). */
    function blockFrame() {
        document.body.style.overflow = 'auto';
        document.querySelectorAll('.ai-gate').forEach(g => { g.hidden = true; });
    }
    const outButton = () => (EL.supabase && !EL.isShared()) ? '<button class="el-btn" type="button" data-el-out>Sign out</button>' : '';
    const wireOut = card => card.querySelectorAll('[data-el-out]').forEach(b => b.addEventListener('click', () => EL.signOut()));

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
        blockFrame();

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
                ${outButton()}
            </div>
            <div id="el-expired-contact"></div>`;
        document.body.appendChild(card);
        wireOut(card);

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
