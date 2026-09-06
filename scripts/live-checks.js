#!/usr/bin/env node
/**
 * EDGELEAD :: LIVE CHECKS  (run after every deploy, from your own machine)
 *
 * The concurrency guarantees are enforced in Postgres and in per-process
 * state; code reading cannot prove them. This script does, with two real
 * accounts against the real deployment, and writes the result to
 * docs/LIVE-CHECKS-<date>.md so "passed on <date>" is a fact, not a memory.
 *
 * Usage (Node 18+, no dependencies):
 *   BACKEND_URL=https://…onrender.com \
 *   SUPABASE_URL=https://….supabase.co SUPABASE_ANON_KEY=… \
 *   USER_A_EMAIL=… USER_A_PASSWORD=… USER_B_EMAIL=… USER_B_PASSWORD=… \
 *   [CLIENT_ID=<uuid shared by A and B>] [IG_HANDLE=some_public_handle] [SPEND=1] \
 *   node scripts/live-checks.js
 *
 * Without SPEND=1 nothing that costs Apify credit is started; the checks that
 * need a real job are reported as SKIPPED with the reason. With SPEND=1 one
 * small IG audit (1 account, 10 posts) is started and cancelled at the first
 * step — expect a few cents.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const env = k => process.env[k] || '';
const BACKEND = env('BACKEND_URL').replace(/\/+$/, '');
const results = [];
const note = (name, status, detail = '') => { results.push({ name, status, detail }); console.log(`${status.padEnd(7)} ${name}${detail ? ' — ' + detail : ''}`); };

async function signIn(email, password) {
    const r = await fetch(`${env('SUPABASE_URL')}/auth/v1/token?grant_type=password`, {
        method: 'POST', headers: { apikey: env('SUPABASE_ANON_KEY'), 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(`sign-in failed for ${email}: ${d.error_description || d.msg || r.status}`);
    return d.access_token;
}
async function api(token, p, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const r = await fetch(BACKEND + p, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    let d = null; try { d = await r.json(); } catch {}
    return { status: r.status, data: d };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    for (const k of ['BACKEND_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'USER_A_EMAIL', 'USER_A_PASSWORD', 'USER_B_EMAIL', 'USER_B_PASSWORD'])
        if (!env(k)) { console.error('missing ' + k); process.exit(2); }

    const A = await signIn(env('USER_A_EMAIL'), env('USER_A_PASSWORD'));
    const B = await signIn(env('USER_B_EMAIL'), env('USER_B_PASSWORD'));

    // 1. health + single instance ------------------------------------------
    {
        const h = await api(null, '/api/health');
        if (h.status === 200 && h.data.ok) note('health', 'PASS', `version ${h.data.version}, instance ${h.data.instance}, instances ${JSON.stringify(h.data.instances)}`);
        else note('health', 'FAIL', String(h.status));
        if (h.data?.instances && h.data.instances.live > 1) note('single instance', 'FAIL', `${h.data.instances.live} live instances`);
        else note('single instance', 'PASS');
    }

    // 2. auth surface --------------------------------------------------------
    {
        const r = await api(null, '/api/me');
        note('unauthenticated /api/me is 401', r.status === 401 ? 'PASS' : 'FAIL', String(r.status));
        const r2 = await api('not-a-token', '/api/me');
        note('bad token is 401', r2.status === 401 ? 'PASS' : 'FAIL', String(r2.status));
    }

    // 3. per-user spend rate limit (6/min) — uses the estimate endpoint's
    //    sibling that is spend-gated but validates before spending: resume on
    //    a non-existent job returns 404, but the 7th call must return 429.
    {
        const codes = [];
        for (let i = 0; i < 8; i++) codes.push((await api(A, '/api/job/00000000-0000-0000-0000-000000000000/resume', { method: 'POST' })).status);
        const hit = codes.indexOf(429);
        note('spend limit 6/min per user', hit >= 0 && hit <= 6 ? 'PASS' : 'FAIL', codes.join(','));
        const b = await api(B, '/api/job/00000000-0000-0000-0000-000000000000/resume', { method: 'POST' });
        note('B not throttled by A', b.status !== 429 ? 'PASS' : 'FAIL', String(b.status));
        await sleep(61000);
    }

    // 4. RLS / membership: B cannot read A's private report ------------------
    {
        const list = await api(A, '/api/reports-history?limit=50');
        const priv = (list.data?.reports || []).find(r => !r.client_id);
        if (!priv) note('B cannot read A private report', 'SKIP', 'A has no report without a client');
        else {
            const r = await api(B, '/api/report/' + priv.id);
            note('B cannot read A private report', r.status === 404 || r.status === 403 ? 'PASS' : 'FAIL', String(r.status));
        }
    }

    // 5. shared client: both members see the same timeline --------------------
    if (env('CLIENT_ID')) {
        const ta = await api(A, `/api/clients/${env('CLIENT_ID')}/timeline`);
        const tb = await api(B, `/api/clients/${env('CLIENT_ID')}/timeline`);
        const ok = ta.status === 200 && tb.status === 200 && (ta.data.reports || []).length === (tb.data.reports || []).length;
        note('shared client timeline identical for A and B', ok ? 'PASS' : 'FAIL', `${ta.status}/${tb.status}`);
    } else note('shared client timeline', 'SKIP', 'CLIENT_ID not set');

    // 6. share link lifecycle ---------------------------------------------------
    {
        const list = await api(A, '/api/reports-history?limit=5');
        const rep = (list.data?.reports || [])[0];
        if (!rep) note('share link lifecycle', 'SKIP', 'A has no reports');
        else {
            const s = await api(A, '/api/share', { method: 'POST', body: { reportId: rep.id, expiresDays: 1 } });
            const tok = s.data?.share?.token;
            const pub = tok ? await api(null, '/api/public/share/' + tok) : { status: 0 };
            const stripped = pub.data?.report && !('user_id' in pub.data.report) && !('client_id' in pub.data.report);
            await api(A, '/api/share/' + s.data?.share?.id, { method: 'DELETE' });
            const after = tok ? await api(null, '/api/public/share/' + tok) : { status: 0 };
            note('share: create → public read → revoke → 404', s.status === 201 && pub.status === 200 && stripped && after.status === 404 ? 'PASS' : 'FAIL',
                `${s.status}/${pub.status}/${stripped ? 'stripped' : 'LEAKS OWNER FIELDS'}/${after.status}`);
            const junk = await api(null, '/api/public/share/zzzzzzzzzzzzzzzzzzzzzzzz');
            note('share: unknown token 404', junk.status === 404 ? 'PASS' : 'FAIL', String(junk.status));
        }
    }

    // 7. schedule create/patch/delete (no run) ---------------------------------
    {
        const jobs = await api(A, '/api/jobs');
        const j = (jobs.data?.jobs || []).find(x => ['ig_report', 'deep_audit', 'fb_page_report', 'fb_community_audit'].includes(x.type) && x.status === 'done');
        if (!j) note('schedule lifecycle', 'SKIP', 'A has no finished schedulable job');
        else {
            const c = await api(A, '/api/schedules', { method: 'POST', body: { jobId: j.id, cadence: 'monthly', dayOfMonth: 28, hourUtc: 23, label: 'live-check' } });
            const id = c.data?.schedule?.id;
            const p = id ? await api(A, '/api/schedules/' + id, { method: 'PATCH', body: { paused: true } }) : { status: 0 };
            const fb = id ? await api(B, '/api/schedules/' + id, { method: 'DELETE' }) : { status: 0 };   // B must not delete A's private schedule
            const d = id ? await api(A, '/api/schedules/' + id, { method: 'DELETE' }) : { status: 0 };
            note('schedule: create → pause → B denied → delete', c.status === 201 && p.status === 200 && (fb.status === 404 || fb.status === 403) && d.status === 200 ? 'PASS' : 'FAIL',
                `${c.status}/${p.status}/${fb.status}/${d.status}`);
        }
    }

    // 8. concurrency on a real job (optional, spends a few cents) ---------------
    if (env('SPEND') === '1') {
        const target = env('IG_HANDLE') || 'instagram';
        const start = await api(A, '/api/generate-ig-report', { method: 'POST', body: { target, postsLimit: 10, ...(env('CLIENT_ID') ? { clientId: env('CLIENT_ID') } : {}) } });
        const jobId = start.data?.jobId;
        if (!jobId) note('job start', 'FAIL', JSON.stringify(start.data));
        else {
            note('job start', 'PASS', jobId);
            await sleep(2000);
            const cancel = await api(A, `/api/job/${jobId}/cancel`, { method: 'POST' });
            note('cancel accepted', cancel.status === 200 ? 'PASS' : 'FAIL', JSON.stringify(cancel.data));
            let st = null;
            for (let i = 0; i < 60; i++) { await sleep(3000); st = (await api(A, '/api/job/' + jobId)).data; const s = st?.job?.status || st?.status; if (['cancelled', 'done', 'failed', 'paused_no_credit'].includes(s)) break; }
            const status = st?.job?.status || st?.status;
            note('job settles after cancel', ['cancelled', 'done'].includes(status) ? 'PASS' : 'FAIL', status);
            if (status === 'cancelled') {
                // double-click Resume: exactly one 202, the other 409
                const [r1, r2] = await Promise.all([api(A, `/api/job/${jobId}/resume`, { method: 'POST' }), api(A, `/api/job/${jobId}/resume`, { method: 'POST' })]);
                const codes = [r1.status, r2.status].sort();
                note('double-click resume: one 202, one 409', codes.join(',') === '202,409' ? 'PASS' : (codes.join(',') === '402,402' ? 'SKIP' : 'FAIL'), codes.join(','));
                await sleep(2000);
                await api(A, `/api/job/${jobId}/cancel`, { method: 'POST' });
            }
            // Jobs are owner-only by design (a teammate sees them on the client timeline, not by id).
            const bRead = await api(B, '/api/job/' + jobId);
            note('B cannot read A job by id', bRead.status === 404 ? 'PASS' : 'FAIL', String(bRead.status));
        }
        const budget = await api(A, '/api/budget?engine=report');
        const left = budget.data?.totalRemainingUsd;
        if (typeof left === 'number' && left < 0.01) {
            const r = await api(A, '/api/generate-ig-report', { method: 'POST', body: { target, postsLimit: 10 } });
            note('budget exhausted → 402 or paused', r.status === 402 || r.status === 202 ? 'PASS' : 'FAIL', String(r.status));
        } else note('budget exhausted → 402', 'SKIP', `report engine has $${left} left; cannot force without draining a key`);
    } else {
        note('cancel/resume/double-click on a real job', 'SKIP', 'set SPEND=1 to run (costs a few cents)');
    }

    // ---- write the record ---------------------------------------------------
    const date = new Date().toISOString().slice(0, 10);
    const fails = results.filter(r => r.status === 'FAIL').length;
    const md = `# Live checks — ${date}\n\nBackend: ${BACKEND}\nResult: **${fails ? fails + ' FAILED' : 'ALL PASSED'}** (${results.filter(r => r.status === 'PASS').length} pass, ${results.filter(r => r.status === 'SKIP').length} skipped)\n\n| Check | Result | Detail |\n|---|---|---|\n${results.map(r => `| ${r.name} | ${r.status} | ${String(r.detail).replace(/\|/g, '/')} |`).join('\n')}\n`;
    const out = path.join(__dirname, '..', 'docs', `LIVE-CHECKS-${date}.md`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, md);
    console.log(`\nwrote ${out}`);
    process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
