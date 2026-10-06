/**
 * The monthly owner report, the comparison set, and merging clients.
 *
 * Part of the EdgeLead server, split out of server.js (phase 55). The parts load in
 * order from server.js and share one namespace, S: what this part needs from an earlier
 * part is unpacked below; anything else from another part is read as S.name when it runs.
 */
'use strict';
const S = require('./shared');
const {
    COST_PER_1K_PROFILE, JOB_WORKERS, META_MEDIA_LIMIT, aiReasonText, app, applyReportScope, assertJobSlot,
    auth, budgetedJson, callActor, clientAccess, clientArchived, createJob, decryptSecret, geminiAvailable,
    geminiCallDetailed, getWorkingClient, graphGet, graphInsights, logger, median, metaLoadConnection,
    missingTable, registerWorker, requireEngine, runJob, sendErr, seriesLast, seriesSum, spendLimit,
    supabase, xp
} = S;
Object.assign(S, {
    metaMonthWindow, metaPrevMonth, metaDefaultMonth, metaMonthLabel, pctDelta, comparableBand,
    competitorQueries
});

// ===========================================================================
// PHASE 19 :: THE MONTHLY OWNER REPORT
//
// The rolling 28-day sync answers "how are we doing". A monthly report answers
// a different question — "what happened in September, versus August" — and it
// is the thing an agency actually sends. That makes the comparison the point,
// not a garnish, so both months are pulled in the same job rather than
// diffed against whatever snapshot happened to be lying around.
//
// Everything here is owner-side Meta Insights. Nothing scraped is mixed in:
// the two are different measurements of different populations and a report
// that blends them is wrong in a way nobody can see.
// ===========================================================================

/** 'YYYY-MM' -> unix-second bounds covering exactly that calendar month, UTC. */
function metaMonthWindow(month) {
    const [y, m] = String(month).split('-').map(Number);
    const start = Date.UTC(y, m - 1, 1) / 1000;
    const end = Date.UTC(y, m, 1) / 1000;      // exclusive: the 1st of the next month
    return { since: start, until: end };
}
function metaPrevMonth(month) {
    const [y, m] = String(month).split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 2, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
/** The last COMPLETE month. A report on a month still running is a report that changes under you. */
function metaDefaultMonth(now = new Date()) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function metaMonthLabel(month) {
    const [y, m] = String(month).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
S.MONTH_RE = MONTH_RE;

/**
 * Percentage change, with the cases that matter kept distinct.
 *
 * 0 -> 40 is not "+Infinity%" and not "+0%"; it is "new", and a report that
 * prints either of the other two is lying about the same number.
 */
function pctDelta(now, before) {
    // Number(null) and Number('') are both 0, so coercing first would turn a
    // metric Meta never returned into a 100% collapse — a number the client
    // would ask about and nobody could explain. Absence is checked first and
    // stays absence.
    const num = v => (v === null || v === undefined || v === '' ? NaN : Number(v));
    const a = num(now), b = num(before);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return { pct: null, kind: 'unknown' };
    if (b === 0) return { pct: null, kind: a > 0 ? 'new' : 'flat' };
    const pct = ((a - b) / b) * 100;
    return { pct: Math.round(pct * 10) / 10, kind: Math.abs(pct) < 1 ? 'flat' : (pct > 0 ? 'up' : 'down') };
}

const META_MONTH_METRICS = [
    { key: 'reach',              level: 'ig',   label: 'Accounts reached' },
    { key: 'views',              level: 'ig',   label: 'Views' },
    { key: 'accounts_engaged',   level: 'ig',   label: 'Accounts engaged' },
    { key: 'total_interactions', level: 'ig',   label: 'Interactions' },
    { key: 'profile_views',      level: 'ig',   label: 'Profile visits' },
    { key: 'website_clicks',     level: 'ig',   label: 'Website taps' },
    { key: 'follower_count',     level: 'ig',   label: 'Followers gained' },
    { key: 'page_impressions_unique', level: 'page', label: 'Page reach' },
    { key: 'page_post_engagements',   level: 'page', label: 'Page engagements' },
    { key: 'page_views_total',        level: 'page', label: 'Page views' },
    { key: 'page_fan_adds_unique',    level: 'page', label: 'New Page followers' }
];
S.META_MONTH_METRICS = META_MONTH_METRICS;

/** Owner totals for one window. Used twice per job — this month and last. */
async function metaWindowTotals(conn, pageToken, since, until) {
    const gaps = [];
    const out = { ig: {}, page: {} };

    const pageIns = await graphInsights(conn.page_id,
        META_MONTH_METRICS.filter(m => m.level === 'page').map(m => m.key),
        { period: 'day', since, until }, pageToken);
    gaps.push(...pageIns.unsupported.map(m => `page:${m}`));
    out.page = Object.fromEntries(Object.entries(pageIns.values).map(([k, v]) => [k, seriesSum(v)]));

    if (conn.ig_user_id) {
        const igIns = await graphInsights(conn.ig_user_id,
            META_MONTH_METRICS.filter(m => m.level === 'ig').map(m => m.key),
            { period: 'day', metric_type: 'total_value', since, until }, pageToken);
        gaps.push(...igIns.unsupported.map(m => `ig:${m}`));
        out.ig = Object.fromEntries(Object.entries(igIns.values).map(([k, v]) => [k, Array.isArray(v) ? seriesSum(v) : Number(v) || 0]));
    }
    return { ...out, gaps };
}

registerWorker('meta_monthly', (userId, input, jobId) => async (progress, ck) => {
    const conn = await supabase.from('meta_connections').select('*').eq('id', input.connectionId).maybeSingle().then(r => r.data);
    if (!conn) throw new Error('Connection no longer exists.');
    const pageToken = decryptSecret(conn.page_token_enc);
    const month = input.month;
    const prev = metaPrevMonth(month);
    const win = metaMonthWindow(month);
    const pwin = metaMonthWindow(prev);
    const gaps = [], warnings = [];

    // --- both months' totals ------------------------------------------------
    await progress(8, `Reading ${metaMonthLabel(month)}`);
    let cur = ck.get('cur');
    if (!cur) { cur = await metaWindowTotals(conn, pageToken, win.since, win.until); await ck.done('cur', cur); }
    gaps.push(...cur.gaps);

    await progress(28, `Reading ${metaMonthLabel(prev)} to compare`);
    let before = ck.get('prev');
    if (!before) {
        // A missing previous month is a real state, not a failure: the account
        // may have connected mid-month. The report says so rather than
        // printing deltas against zero as though nothing happened last month.
        try { before = await metaWindowTotals(conn, pageToken, pwin.since, pwin.until); }
        catch (err) {
            if (err.statusCode === 401) throw err;
            before = { ig: {}, page: {}, gaps: [], unavailable: String(err.message || '').slice(0, 200) };
        }
        await ck.done('prev', before);
    }
    if (before.unavailable) warnings.push(`${metaMonthLabel(prev)} could not be read, so this month is reported without a comparison.`);

    // --- profile snapshot ---------------------------------------------------
    await progress(42, 'Reading the account');
    let who = ck.get('who');
    if (!who) {
        const pageMeta = await graphGet(conn.page_id, { fields: 'id,name,fan_count,followers_count,category,link' }, pageToken);
        let ig = null, demographics = {};
        if (conn.ig_user_id) {
            ig = await graphGet(conn.ig_user_id, { fields: 'id,username,name,followers_count,follows_count,media_count' }, pageToken);
            for (const bd of ['age', 'gender', 'city', 'country']) {
                try {
                    const d = await graphGet(`${conn.ig_user_id}/insights`, { metric: 'follower_demographics', period: 'lifetime', metric_type: 'total_value', breakdown: bd }, pageToken);
                    const rows = d.data?.[0]?.total_value?.breakdowns?.[0]?.results || [];
                    demographics[bd] = rows.map(r => ({ key: (r.dimension_values || []).join(' '), value: r.value }))
                        .sort((a, b) => b.value - a.value).slice(0, 10);
                } catch (err) { if (err.statusCode === 401) throw err; gaps.push(`ig:follower_demographics:${bd}`); }
            }
        } else {
            warnings.push('No Instagram professional account is linked to this Page, so the report covers Facebook only.');
        }
        who = { page: pageMeta, ig, demographics };
        await ck.done('who', who);
    }

    // --- the month's posts --------------------------------------------------
    await progress(58, 'Reading the posts published this month');
    let posts = ck.get('posts');
    if (!posts) {
        posts = [];
        if (conn.ig_user_id) {
            // /media has no reliable since/until, so the window is applied here.
            // Stopping at the first post older than the window works because
            // the edge is returned newest-first.
            const out = await graphGet(`${conn.ig_user_id}/media`, {
                fields: 'id,caption,media_type,media_product_type,timestamp,like_count,comments_count,permalink,shortcode,thumbnail_url,media_url',
                limit: META_MEDIA_LIMIT
            }, pageToken);
            const inWindow = (out.data || []).filter(m => {
                const t = Date.parse(m.timestamp || '') / 1000;
                return Number.isFinite(t) && t >= win.since && t < win.until;
            });
            for (let i = 0; i < inWindow.length; i++) {
                const m = inWindow[i];
                const kind = m.media_product_type === 'REELS' ? 'reel' : (m.media_type === 'CAROUSEL_ALBUM' ? 'carousel' : 'still');
                let ins = {};
                try {
                    const r = await graphInsights(m.id, ['reach', 'saved', 'shares', 'views', 'total_interactions'], {}, pageToken);
                    ins = Object.fromEntries(Object.entries(r.values).map(([k, v]) => [k, Array.isArray(v) ? seriesLast(v) : v]));
                } catch (err) { if (err.statusCode === 401) throw err; }
                posts.push({
                    // A video's photo is its thumbnail; an image's is the media itself.
                    thumb: m.thumbnail_url || (m.media_type === 'VIDEO' ? null : m.media_url) || null,
                    id: m.id, kind, permalink: m.permalink || null, postedAt: m.timestamp || null,
                    caption: (m.caption || '').slice(0, 200) || null,
                    likes: m.like_count ?? null, comments: m.comments_count ?? null,
                    reach: ins.reach ?? null, saved: ins.saved ?? null, shares: ins.shares ?? null,
                    views: ins.views ?? null, interactions: ins.total_interactions ?? null
                });
                if (i % 8 === 7) await progress(58 + Math.round(20 * (i / inWindow.length)), `Posts ${i + 1}/${inWindow.length}`);
            }
        }
        await ck.done('posts', posts);
    }

    // --- the comparison table ----------------------------------------------
    await progress(82, 'Building the month-over-month view');
    const deltas = META_MONTH_METRICS.map(m => {
        const now = cur[m.level]?.[m.key];
        const then = before.unavailable ? null : before[m.level]?.[m.key];
        if (now === undefined) return null;
        const d = then === null || then === undefined ? { pct: null, kind: 'no_baseline' } : pctDelta(now, then);
        return { key: m.key, level: m.level, label: m.label, now: Number(now) || 0, before: then ?? null, ...d };
    }).filter(Boolean);

    const byKind = {};
    for (const p of posts) {
        const a = byKind[p.kind] = byKind[p.kind] || { n: 0, reach: [], saved: [], shares: [], interactions: [] };
        a.n += 1;
        for (const f of ['reach', 'saved', 'shares', 'interactions']) if (typeof p[f] === 'number') a[f].push(p[f]);
    }
    const formats = Object.fromEntries(Object.entries(byKind).map(([k, a]) => [k, {
        n: a.n, medianReach: median(a.reach), medianSaved: median(a.saved),
        medianShares: median(a.shares), medianInteractions: median(a.interactions)
    }]));

    const top = arr => arr.filter(p => typeof p.reach === 'number').sort((a, b) => b.reach - a.reach).slice(0, 5);
    // The best posts' photos are kept (phase 38); Meta's addresses expire.
    const shown = [...new Set([...top(posts), ...posts.filter(p => typeof p.saved === 'number').sort((a, b) => b.saved - a.saved).slice(0, 3)])];
    await Promise.all(shown.map(async p => { if (p.thumb && !p.image) p.image = await S.storeMediaImage(p.thumb, `meta/${jobId || conn.id}/${String(p.id).replace(/[^a-z0-9_-]/gi, '')}`); }));
    for (const p of posts) delete p.thumb;
    const summary = {
        month, monthLabel: metaMonthLabel(month), prevMonth: prev, prevMonthLabel: metaMonthLabel(prev),
        comparable: !before.unavailable,
        account: {
            pageName: who.page?.name || conn.page_name || null,
            pageFollowers: who.page?.followers_count ?? who.page?.fan_count ?? null,
            igUsername: who.ig?.username || conn.ig_username || null,
            igFollowers: who.ig?.followers_count ?? null,
            igPosts: who.ig?.media_count ?? null
        },
        totals: { current: cur, previous: before.unavailable ? null : { ig: before.ig, page: before.page } },
        deltas,
        posting: { count: posts.length, formats, topByReach: top(posts), topBySaves: posts.filter(p => typeof p.saved === 'number').sort((a, b) => b.saved - a.saved).slice(0, 3) },
        demographics: who.demographics,
        gaps: [...new Set(gaps)],
        warnings,
        sources: { all: 'meta_owner_insights', note: 'Owner-only Meta Insights. Nothing here is scraped and nothing is blended with scraped data.' }
    };

    // --- narrative ----------------------------------------------------------
    await progress(90, 'Writing the month up');
    let ai = null, aiStatus = { ok: false, reason: 'no_key', message: aiReasonText('no_key') };
    if (geminiAvailable()) {
        const { json } = budgetedJson(summary, { maxChars: 28000, keep: ['deltas', 'account', 'posting'] });
        const prompt =
`You are writing the monthly social media report an agency sends its client. The month is ${summary.monthLabel}${summary.comparable ? `, compared against ${summary.prevMonthLabel}` : ' (no previous month is available to compare against)'}.
${input.brief ? `Context from the team: ${input.brief}\n` : ''}
Every number below is owner-side Meta Insights for this account. Rules:
- Never invent a number. Every figure you use must appear in the JSON.
- A metric with kind "new" went from zero — describe it as new, never as a percentage.
- A metric with kind "no_baseline" has no previous month. Do not imply a trend for it.
- Do not recommend ad spend, budgets, audiences or targeting. There is no ad data here.
- Write for the business owner: plain language, no metric jargon, no platform lecture.
${summary.comparable ? '' : '- There is no comparison month. Do not write as if there is.\n'}
Data (JSON):
${json}

Reply with ONLY this JSON:
{
 "headline": "one sentence a client reads first — the month in a line",
 "executive_summary": "3-4 sentences with the numbers that matter",
 "what_moved": ["2-4 lines, each naming a metric and its change"],
 "what_worked": ["2-3 lines about the posts and formats that performed, with numbers"],
 "what_did_not": ["1-3 honest lines; say 'nothing stood out' if that is the truth"],
 "audience": "1-2 sentences from demographics, or 'not enough data'",
 "recommendations": [{"action": "one concrete step for next month, starting with a verb", "why": "the number or post from this month that makes it worth doing", "expected": "what it should change, worded as an estimate", "who": "agency or client", "priority": "high, medium or low"}],
 "conclusion": "2-3 sentences that close the month with its key numbers and name next month's focus",
 "caveats": "one sentence on anything missing from the data, or empty string"
}
Give 3 to 5 recommendations, highest priority first, each doable by one person with a phone. "who" is "client" only for what the owner must do themselves (reply to messages, supply photos, approve an offer); everything else is "agency".`;
        const r = await geminiCallDetailed(prompt, { temperature: 0.4, maxOutputTokens: 4000, tag: 'Gemini Monthly', userId });
        aiStatus = { ok: r.ok, reason: r.reason, message: r.ok ? 'Generated.' : aiReasonText(r.reason), model: r.model || null };
        ai = r.ok ? S.cleanMonthlyAi(r.data) : null;
    }
    if (!aiStatus.ok) warnings.push(`Narrative unavailable: ${aiStatus.message}`);

    await progress(96, 'Saving');
    // What was planned for the month and how it did (phase 42). Quiet when
    // there is no calendar yet.
    const contentPlan = await S.contentPlanMonth(input.clientId || conn.client_id || null, month).catch(() => null);
    const payload = { ...summary, ai, aiStatus, contentPlan, generatedAt: new Date().toISOString(), connection: { id: conn.id, pageName: conn.page_name, igUsername: conn.ig_username } };
    const { data: saved } = await supabase.from('reports').insert([{
        user_id: userId,
        client_id: input.clientId || conn.client_id || null,
        meta_connection_id: conn.id,
        platform: 'meta',
        report_type: 'meta_monthly',
        target_handle: conn.ig_username || conn.page_name || conn.page_id,
        posts_analyzed: posts.length,
        // The 1st of the month being reported, so the timeline sorts by the
        // month covered rather than the day somebody pressed the button.
        snapshot_date: `${month}-01`,
        credits_estimate: 0,
        ai_summary: ai?.executive_summary || null,
        ai_json: ai || null,
        ai_status: aiStatus,
        report_json: payload
    }]).select('id').maybeSingle();

    return { reportId: saved?.id || null, reportRef: saved?.id || null, month, aiStatus, gaps: summary.gaps };
});

// ===========================================================================
// PHASE 19 :: THE COMPARISON SET
//
// "How do I compare to similar businesses near me" was the one client-facing
// promise that still depended on somebody typing competitor handles into a box
// by hand. This finds them: same niche, same place, similar size.
//
// Size is the part that is easy to get wrong. A 900-follower florist compared
// against a 400,000-follower chain learns nothing except that they are small,
// which they knew. The band below is deliberately narrow and the reason it
// exists is that a comparison outside it is not a comparison.
// ===========================================================================

/** The size band a comparison is meaningful inside: a third to three times. */
function comparableBand(followers) {
    const f = Number(followers) || 0;
    if (f < 200) return { min: 0, max: 3000 };   // too small for a ratio to mean anything
    return { min: Math.round(f / 3), max: Math.round(f * 3) };
}

/** Search phrases for a niche in a place. Ordered: most specific first. */
function competitorQueries(niche, location) {
    const n = String(niche || '').trim();
    const l = String(location || '').trim();
    if (!n) return [];
    const city = l.split(',')[0].trim();
    return [...new Set([
        city ? `${n} ${city}` : null,
        city ? `${city} ${n}` : null,
        l && l !== city ? `${n} ${l}` : null,
        n
    ].filter(Boolean))].slice(0, 3);
}

registerWorker('competitor_discovery', (userId, input, jobId) => async (progress, ck) => {
    const { niche, location, selfHandle, followers } = input;
    const band = comparableBand(followers);
    const warnings = [];

    await progress(8, `Searching for ${niche}${location ? ` in ${location}` : ''}`);
    let candidates = ck.get('candidates');
    if (!candidates) {
        const seen = new Set();
        candidates = [];
        for (const q of competitorQueries(niche, location)) {
            try {
                const estimate = COST_PER_1K_PROFILE / 20;
                const { client } = await getWorkingClient('report', userId, { needUsd: estimate, jobId });
                const { items } = await callActor(client, 'apify/instagram-search-scraper',
                    { searchQueries: [q], searchType: 'user' },
                    { estimateUsd: estimate, maxItems: 40, jobId });
                for (const it of (items || [])) {
                    const h = String(it.username || it.ownerUsername || '').toLowerCase().replace('@', '').trim();
                    if (!h || seen.has(h) || h === String(selfHandle || '').toLowerCase()) continue;
                    seen.add(h);
                    candidates.push({ username: h, foundFor: q });
                }
            } catch (err) { warnings.push(`Search "${q}" failed: ${err.message}`); }
        }
        await ck.done('candidates', candidates);
    }
    if (!candidates.length) {
        return { handles: [], considered: 0, warnings: [...warnings, 'No accounts came back for that niche and location. Try a broader niche word.'] };
    }

    await progress(45, `Checking ${Math.min(candidates.length, 30)} accounts`);
    let profiles = ck.get('profiles');
    if (!profiles) {
        const batch = candidates.slice(0, 30).map(c => c.username);
        const estimate = (batch.length / 1000) * COST_PER_1K_PROFILE;
        const { client } = await getWorkingClient('report', userId, { needUsd: estimate, jobId });
        const { items } = await callActor(client, 'apify/instagram-profile-scraper',
            { usernames: batch },
            { estimateUsd: estimate, maxItems: batch.length, jobId });
        profiles = items || [];
        await ck.done('profiles', profiles);
    }

    await progress(82, 'Picking the comparable ones');
    const scored = profiles.map(p => {
        const h = String(p.username || '').toLowerCase();
        const f = Number(p.followersCount ?? p.followers_count ?? 0) || 0;
        const isBusiness = !!(p.isBusinessAccount ?? p.is_business_account ?? p.businessCategoryName);
        const posts = Number(p.postsCount ?? p.posts_count ?? 0) || 0;
        return {
            username: h, followers: f, posts, isBusiness,
            category: p.businessCategoryName || p.category_name || null,
            private: !!(p.private ?? p.isPrivate),
            inBand: f >= band.min && f <= band.max
        };
    }).filter(p => p.username && !p.private && p.inBand && p.posts >= 6);

    // Closest in size first: the most comparable account is the one most like
    // them, not the biggest one that matched the search.
    const target = Number(followers) || 0;
    scored.sort((a, b) => {
        if (a.isBusiness !== b.isBusiness) return a.isBusiness ? -1 : 1;
        return Math.abs(a.followers - target) - Math.abs(b.followers - target);
    });
    const picked = scored.slice(0, 8);

    if (!picked.length) {
        warnings.push(`Found ${profiles.length} accounts but none were a comparable size (between ${band.min.toLocaleString()} and ${band.max.toLocaleString()} followers).`);
    }

    if (input.clientId && picked.length) {
        await supabase.from('clients').update({
            competitors: picked.map(p => p.username),
            competitors_source: 'discovered',
            competitors_updated_at: new Date().toISOString()
        }).eq('id', input.clientId);
    }

    return {
        handles: picked.map(p => p.username),
        accounts: picked,
        considered: profiles.length,
        band,
        warnings,
        note: 'Discovered from public Instagram search. Review them before using — a search match is not a competitor.'
    };
});

app.post('/api/clients/:id/competitors/discover', spendLimit, async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const c = await clientAccess(ctx.user.id, req.params.id, 'editor');
        if (!c) return res.status(404).json({ error: 'Client not found.' });
        await assertJobSlot(ctx.user.id);

        const { data: client } = await supabase.from('clients')
            .select('id, name, ig_handle, niche, location').eq('id', c.id).maybeSingle();
        const niche = String(req.body.niche || client?.niche || '').trim();
        const location = String(req.body.location || client?.location || '').trim();
        if (!niche) return res.status(400).json({ error: 'This client has no niche set, so there is nothing to search for. Add one first.' });

        // Their own follower count sets the band. Without it every account is
        // "comparable" and the result is a list of whoever ranked highest.
        let followers = Number(req.body.followers) || 0;
        if (!followers && client?.ig_handle) {
            const { data: last } = await supabase.from('reports')
                .select('followers_snapshot').eq('client_id', c.id)
                .not('followers_snapshot', 'is', null)
                .order('created_at', { ascending: false }).limit(1);
            followers = Number(last?.[0]?.followers_snapshot) || 0;
        }

        const job = await createJob(ctx.user.id, 'competitor_discovery', 'report', {
            clientId: c.id, niche, location, followers,
            selfHandle: client?.ig_handle || null
        }, COST_PER_1K_PROFILE / 20);
        runJob(job.id, JOB_WORKERS['competitor_discovery'](ctx.user.id, job.input, job.id));
        res.status(202).json({ success: true, jobId: job.id });
    } catch (err) { sendErr(res, err); }
});

// ===========================================================================
// MERGE (phase 23)
//
// Two records for one business happen honestly: an agency creates one, the
// business later signs itself up and gets its own, and only the empty case
// is absorbed automatically (phase 22) — a record with work in it is never
// touched as a side effect. This is the deliberate act for the rest: every
// row filed under `from` is re-pointed at `into`, members are carried over,
// and `from` is archived. Nothing is deleted.
// ===========================================================================

/** Every table that files rows under a client. Kept in one place so a new table cannot be forgotten by the merge. */
const MERGE_TABLES = [
    'reports', 'jobs', 'campaigns', 'meta_connections', 'meta_oauth_states', 'ai_conversations',
    'content_plan_notes', 'competitor_sets', 'fb_group_sets', 'fb_page_sets', 'fb_suggestions',
    'fb_posts', 'fb_page_posts', 'posts', 'report_shares', 'schedules',
    // phase 32: a merged client keeps its board and the talk on it
    'client_tasks', 'client_task_comments',
    // phase 48: the pictures in them (the files keep their path; the row says whose they are)
    'client_task_media',
    // phase 53: the content calendar and its picks, and the assistant's chats (they were left behind)
    'content_posts', 'content_picks', 'xp_ai_conversations'
];
S.MERGE_TABLES = MERGE_TABLES;
/**
 * Tables with one row per (client, something): a plain re-point would collide
 * where both records already hold that something. Each row moves on its own;
 * one the target already has stays with the archived record, which keeps it.
 */
const MERGE_KEYED = ['content_topics', 'lead_pipeline', 'content_profiles'];
async function mergeKeyed(table, fromId, intoId) {
    const { data, error } = await supabase.from(table).select('*').eq('client_id', fromId);
    if (error) { if (missingTable(error)) return { moved: 0, kept: 0 }; throw error; }
    let moved = 0, kept = 0;
    for (const row of (data || [])) {
        // content_profiles is keyed by client_id itself: the target's own profile wins.
        let q = supabase.from(table).update({ client_id: intoId }).eq('client_id', fromId);
        q = row.id !== undefined ? q.eq('id', row.id) : q;
        const { error: e } = await q;
        if (!e) moved += 1;
        else if (e.code === '23505') kept += 1;
        else throw e;
    }
    return { moved, kept };
}

app.post('/api/clients/:id/merge', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const into = await clientAccess(ctx.user.id, req.params.id, 'owner');
        const from = await clientAccess(ctx.user.id, req.body?.fromId, 'owner');
        if (!into || !from) return res.status(404).json({ error: 'You must own both clients, or be an admin.' });
        if (into.id === from.id) return res.status(400).json({ error: 'A client cannot be merged into itself.' });
        const dry = String(req.query.dry || req.body?.dry || '') === '1';

        const counts = {};
        for (const t of [...MERGE_TABLES, ...MERGE_KEYED]) {
            const { count } = await supabase.from(t).select('*', { count: 'exact', head: true }).eq('client_id', from.id);
            counts[t] = count || 0;
        }
        const { data: fromLinks } = await supabase.from('client_leads').select('lead_id, source, job_id').eq('client_id', from.id);
        const { data: fromMembers } = await supabase.from('client_members').select('user_id, role').eq('client_id', from.id);
        counts.client_leads = (fromLinks || []).length;
        counts.client_members = (fromMembers || []).length;

        if (dry) return res.json({ dry: true, into: { id: into.id, name: into.name }, from: { id: from.id, name: from.name }, counts });

        // The assistant's chats belong to its own record of the business (xp_clients); moving them to a
        // business it has never seen failed on that reference after everything else had moved (phase 57).
        if (counts.xp_ai_conversations) await S.xp.ensureChatClient(into.id);
        for (const t of MERGE_TABLES) {
            if (!counts[t]) continue;
            const { error } = await supabase.from(t).update({ client_id: into.id }).eq('client_id', from.id);
            if (error) throw error;
        }
        const keptBehind = {};
        for (const t of MERGE_KEYED) {
            if (!counts[t]) continue;
            const r = await mergeKeyed(t, from.id, into.id);
            if (r.kept) keptBehind[t] = r.kept;
        }
        // Links and members are keyed by (client, x): upsert into the target,
        // then clear the source, so a lead or a person already on both does not
        // become a conflict.
        if ((fromLinks || []).length) {
            await supabase.from('client_leads').upsert(
                fromLinks.map(l => ({ client_id: into.id, lead_id: l.lead_id, source: l.source || 'merge', job_id: l.job_id })),
                { onConflict: 'client_id,lead_id', ignoreDuplicates: true });
            await supabase.from('client_leads').delete().eq('client_id', from.id);
        }
        if ((fromMembers || []).length) {
            const { data: have } = await supabase.from('client_members').select('user_id').eq('client_id', into.id);
            const had = new Set((have || []).map(m => m.user_id));
            const add = fromMembers.filter(m => !had.has(m.user_id) && m.user_id !== into.owner_user_id)
                .map(m => ({ client_id: into.id, user_id: m.user_id, role: m.role, added_by: ctx.user.id }));
            if (add.length) await supabase.from('client_members').upsert(add, { onConflict: 'client_id,user_id' });
            await supabase.from('client_members').delete().eq('client_id', from.id);
        }
        // The old owner keeps a way in: if they are not the new owner, they
        // become an editor rather than losing the business they created.
        if (from.owner_user_id !== into.owner_user_id) {
            await supabase.from('client_members').upsert(
                [{ client_id: into.id, user_id: from.owner_user_id, role: 'editor', added_by: ctx.user.id }],
                { onConflict: 'client_id,user_id' });
            // A business owner's login now belongs to an agency client: it never expires (phase 57).
            if ((await S.userRole(from.owner_user_id)) === 'client') await S.markAgencyOwner(from.owner_user_id);
        }
        const stamp = new Date().toISOString().slice(0, 10);
        await supabase.from('clients').update({
            archived: true,
            notes: `${from.notes ? from.notes + '\n\n' : ''}Merged into "${into.name}" (${into.id}) on ${stamp}.`
        }).eq('id', from.id);
        await clientArchived(from.id, true);

        // Edge Meta AI's copy of the numbers is filed by business and by Meta account, so it cannot be
        // re-pointed row by row. The connections moved above; the old copy goes (its chats moved too) and
        // the merged business reads its history again from Meta, which is where it came from.
        let reread = false;
        if (counts.meta_connections) {
            const p = await xp.purge(from.id).catch(e => ({ error: e.message }));
            if (p && p.error) logger.warn('merge_xp_purge_failed', { from: from.id, message: p.error });
            Promise.resolve().then(() => xp.kickoff(into.id, 'merge', { force: true })).catch(e => logger.warn('merge_xp_kickoff_failed', { into: into.id, message: e.message }));
            reread = true;
        }

        logger.info('client_merged', { userId: ctx.user.id, from: from.id, into: into.id, counts, keptBehind });
        res.json({ success: true, into: { id: into.id, name: into.name }, from: { id: from.id, name: from.name }, counts, keptBehind, reread });
    } catch (err) { sendErr(res, err); }
});

/** The agreed comparison set. Kept on the client so every run uses the same one. */
app.put('/api/clients/:id/competitors', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const c = await clientAccess(ctx.user.id, req.params.id, 'editor');
        if (!c) return res.status(404).json({ error: 'Client not found.' });
        const handles = [...new Set((Array.isArray(req.body.handles) ? req.body.handles : [])
            .map(h => String(h || '').trim().replace(/^@/, '').replace(/\/+$/, '').toLowerCase())
            .filter(h => /^[a-z0-9._]{1,30}$/.test(h)))].slice(0, 12);
        const { error } = await supabase.from('clients').update({
            competitors: handles.length ? handles : null,
            competitors_source: handles.length ? (req.body.source === 'discovered' ? 'discovered' : 'manual') : null,
            competitors_updated_at: handles.length ? new Date().toISOString() : null
        }).eq('id', c.id);
        if (error) throw error;
        res.json({ success: true, handles });
    } catch (err) { sendErr(res, err); }
});

app.post('/api/meta/monthly', spendLimit, async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'meta_owned'); if (!ctx) return;
        await assertJobSlot(ctx.user.id);
        const conn = await metaLoadConnection(ctx.user.id, req.body.connectionId);
        if (!conn) return res.status(404).json({ error: 'Connection not found.' });

        const month = MONTH_RE.test(String(req.body.month || '')) ? String(req.body.month) : metaDefaultMonth();
        // A month that has not finished would produce a report that changes
        // if you ran it again tomorrow. That is not a monthly report.
        if (month >= new Date().toISOString().slice(0, 7)) {
            return res.status(400).json({ error: 'That month has not finished yet. Pick a completed month.' });
        }

        // The report is filed where the caller says only if they may edit
        // that client; otherwise under the connection's own client. Before
        // phase 32 any id in the body was trusted, so a report could be
        // dropped into the timeline of a client the caller could not open.
        let clientId = conn.client_id || null;
        if (req.body.clientId) {
            const target = await clientAccess(ctx.user.id, req.body.clientId, 'editor');
            if (!target) return res.status(403).json({ error: 'You do not have edit access to that client.' });
            clientId = target.id;
        }

        const job = await createJob(ctx.user.id, 'meta_monthly', 'meta_owned', {
            connectionId: conn.id, month,
            clientId,
            brief: String(req.body.brief || '').slice(0, 600) || null
        }, 0);
        runJob(job.id, JOB_WORKERS['meta_monthly'](ctx.user.id, job.input, job.id));
        res.status(202).json({ success: true, jobId: job.id, month, estimatedUsd: 0 });
    } catch (err) { sendErr(res, err); }
});

app.get('/api/meta/monthly', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'meta_owned'); if (!ctx) return;
        let q = supabase.from('reports')
            .select('id, user_id, client_id, meta_connection_id, target_handle, posts_analyzed, snapshot_date, created_at, ai_summary, ai_status')
            .eq('report_type', 'meta_monthly');
        q = (await applyReportScope(req, ctx))(q);
        const { data, error } = await q.order('snapshot_date', { ascending: false }).limit(60);
        if (error) throw error;
        res.json({ reports: (data || []).map(r => ({ ...r, month: String(r.snapshot_date || '').slice(0, 7) })) });
    } catch (err) { sendErr(res, err); }
});
