/**
 * Job workers: what each kind of run does.
 *
 * Part of the EdgeLead server, split out of server.js (phase 55). The parts load in
 * order from server.js and share one namespace, S: what this part needs from an earlier
 * part is unpacked below; anything else from another part is read as S.name when it runs.
 */
'use strict';
const S = require('./shared');
const {
    COST_PER_1K_POSTS, COST_PER_1K_PROFILE, DEFAULT_POSTS_PER_ACC, FB_DEFAULT_DAYS, FB_DEFAULT_POSTS,
    FB_MAX_GROUPS, FB_SEARCH_ACTOR, IG_SCORE_VERSION, MAX_POSTS_PER_ACC, buildBenchmark, callActor,
    computeAudit, crypto, estimateCredits, extractPosts, geminiNarrative, getWorkingClient, registerWorker,
    ruleRecommendations, savePosts, supabase
} = S;

// ===========================================================================
// SHARED: AUDIT ONE HANDLE
// ===========================================================================

async function auditHandle(client, userId, handle, postsLimit, meta = {}) {
    const h = String(handle || '').replace('@', '').replace(/\/+$/, '').trim().toLowerCase();
    if (!h) return null;

    const limit = Math.min(postsLimit || DEFAULT_POSTS_PER_ACC, MAX_POSTS_PER_ACC);

    const { items: profiles } = await callActor(client, 'apify/instagram-profile-scraper',
        { usernames: [h] },
        { estimateUsd: COST_PER_1K_PROFILE / 1000, jobId: meta.jobId });
    const prof = profiles[0] || {};

    const { items: rawPosts } = await callActor(client, 'apify/instagram-scraper', {
        directUrls: [`https://www.instagram.com/${h}/`],
        resultsType: 'posts',
        resultsLimit: limit,
        addParentData: false
    }, { estimateUsd: (limit / 1000) * COST_PER_1K_POSTS, maxItems: limit, jobId: meta.jobId });
    const posts = extractPosts(rawPosts || []);

    const persistence = await savePosts(userId, h, posts, meta);
    const audit = computeAudit(h, prof, posts);
    if (audit) audit.persistence = persistence;
    return audit;
}

// ===========================================================================
// SYSTEM / KEY MANAGEMENT ENDPOINTS
// ===========================================================================

// ===========================================================================
// JOB WORKERS
// Registered at module scope and rebuildable from jobs.input alone, which
// is what lets /api/job/:id/resume pick a paused job back up after a key
// change or a server restart.
// ===========================================================================

registerWorker('ig_report', (userId, input, jobId) => async (progress, ck) => {

    const cleanTarget  = String(input.target || '');
    const rivals       = Array.isArray(input.rivals) ? input.rivals : [];
    const limit        = input.postsPerAccount || DEFAULT_POSTS_PER_ACC;
    const accounts     = rivals.length + 1;
    const estimate     = estimateCredits(accounts, limit);
    const perAccount   = estimateCredits(1, limit);

            const step = Math.floor(80 / accounts);
            const warnings = [];

            // The key is resolved per account, not once for the whole job. When
            // the current key runs dry mid-run the next account simply picks up
            // the next key in the chain, and the user never notices.
            const grab = () => getWorkingClient('report', userId, { needUsd: perAccount, jobId })
                .then(r => r.client);

            let main = ck.get(cleanTarget);
            if (main) {
                await progress(5, `@${cleanTarget} already analysed — reusing saved data`);
            } else {
                await progress(5, `Auditing target @${cleanTarget}`);
                main = await auditHandle(await grab(), userId, cleanTarget, limit, { jobId, clientId: input.clientId || null });
                if (!main) throw new Error('Target profile could not be scraped.');
                if (main.persistence?.error) {
                    warnings.push('Posts could not be written to the database, so this run adds nothing to post history. ' +
                                  'The report itself is unaffected.');
                }
                await ck.done(cleanTarget, main);
            }

            const rivalAudits = [];
            for (let i = 0; i < rivals.length; i++) {
                const cached = ck.get(rivals[i]);
                if (cached) { rivalAudits.push(cached); continue; }

                await progress(5 + step * (i + 1), `Auditing rival @${rivals[i]} (${i + 1}/${rivals.length})`);
                try {
                    const a = await auditHandle(await grab(), userId, rivals[i], limit, { jobId, clientId: input.clientId || null });
                    if (a) { rivalAudits.push(a); await ck.done(rivals[i], a); }
                } catch (e) {
                    if (e.code === 'NO_CREDIT') throw e;   // pause cleanly, keep the checkpoint
                    console.error('[rival failed]', rivals[i], e.message);
                    warnings.push(`@${rivals[i]} could not be analysed: ${e.message}`);
                }
            }

            await progress(88, 'Building benchmark');
            const benchmark = rivalAudits.length ? buildBenchmark(main, rivalAudits) : null;
            const recommendations = ruleRecommendations(main);

            await progress(92, 'Generating AI narrative');
            const { ai, aiStatus } = await geminiNarrative({ target: main, rivals: rivalAudits, benchmark });
            if (!aiStatus.ok) warnings.push(`Strategy layer unavailable: ${aiStatus.message}`);

            const payload = {
                main, rivals: rivalAudits, recommendations, benchmark, ai, aiStatus, warnings,
                scoreVersion: IG_SCORE_VERSION, generatedAt: new Date().toISOString()
            };
            const postsAnalyzed = main.postsAnalyzed + rivalAudits.reduce((s, r) => s + r.postsAnalyzed, 0);

            // Instagram's photo links expire; the report keeps its own copies (phase 36).
            await progress(94, 'Keeping the post photos');
            await S.keepAuditImages([main, ...rivalAudits.map(r => ({ ...r, topPosts: (r.topPosts || []).slice(0, 2), bottomPosts: [], exemplars: {} }))], `ig/${jobId || crypto.randomUUID()}`);

            await progress(96, 'Saving report');
            const { data: saved } = await supabase.from('reports').insert([{
                user_id: userId,
                client_id: input.clientId || null,
                platform: 'instagram',
                // Stable per-worker type. The old 'single'/'compare' collided
                // with deep_audit's 'single', so the two vaults could not be told
                // apart. Legacy rows are backfilled by schema-phase7.sql.
                report_type: 'ig_report',
                target_handle: main.handle,
                competitor_handles: rivalAudits.map(r => r.handle),
                grade: main.grade,
                score: main.score,
                engagement_rate: parseFloat(main.engagementRate),
                posts_analyzed: postsAnalyzed,
                snapshot_date: new Date().toISOString().slice(0, 10),
                credits_estimate: estimate,
                score_version: IG_SCORE_VERSION,
                score_v1: main.scoreV1 ?? null,
                followers_snapshot: main.followers ?? null,
                posts_per_week: parseFloat(main.postsPerWeek) || null,
                cohort_avg_er: benchmark?.cohort?.avgEngagementRate ?? null,
                target_rank: benchmark?.targetRank ?? null,
                ai_summary: ai?.executive_summary || null,
                ai_json: ai || null,
                ai_status: aiStatus,
                report_json: payload
            }]).select('id').maybeSingle();

            // The payload is already in reports.report_json. Storing a second
            // copy in jobs.result doubled the write and shipped ~600KB to the
            // browser on the final poll. reportRef tells /api/job/:id to
            // hydrate it from the vault instead.
            return {
                reportId: saved?.id || null,
                reportRef: saved?.id || null,
                postsAnalyzed,
                aiStatus,
                report: saved?.id ? undefined : payload
            };
        });

registerWorker('deep_audit', (userId, input, jobId) => async (progress, ck) => {

    const cleanTarget  = String(input.target || '');
    const rivals       = Array.isArray(input.competitors) ? input.competitors : [];
    const limit        = input.postsPerAccount || DEFAULT_POSTS_PER_ACC;
    const activeSetId  = input.setId || null;
    const accounts     = rivals.length + 1;
    const estimate     = estimateCredits(accounts, limit);
    const perAccount   = estimateCredits(1, limit);

            const meta = { setId: activeSetId, jobId, clientId: input.clientId || null };
            const step = Math.floor(80 / accounts);
            const warnings = [];

            const grab = () => getWorkingClient('report', userId, { needUsd: perAccount, jobId })
                .then(r => r.client);

            let main = ck.get(cleanTarget);
            if (main) {
                await progress(5, `@${cleanTarget} already analysed — reusing saved data`);
            } else {
                await progress(5, `Auditing target @${cleanTarget}`);
                main = await auditHandle(await grab(), userId, cleanTarget, limit, meta);
                if (!main) throw new Error('Target profile could not be scraped.');
                if (main.persistence?.error) {
                    warnings.push('Posts could not be written to the database, so this run adds nothing to post history. ' +
                                  'The report itself is unaffected.');
                }
                await ck.done(cleanTarget, main);
            }

            const rivalAudits = [];
            for (let i = 0; i < rivals.length; i++) {
                const cached = ck.get(rivals[i]);
                if (cached) { rivalAudits.push(cached); continue; }

                await progress(5 + step * (i + 1), `Auditing competitor @${rivals[i]} (${i + 1}/${rivals.length})`);
                try {
                    const a = await auditHandle(await grab(), userId, rivals[i], limit, meta);
                    if (a) { rivalAudits.push(a); await ck.done(rivals[i], a); }
                } catch (e) {
                    if (e.code === 'NO_CREDIT') throw e;
                    console.error('[competitor failed]', rivals[i], e.message);
                    warnings.push(`@${rivals[i]} could not be analysed: ${e.message}`);
                }
            }

            await progress(88, 'Building benchmark');
            const benchmark = buildBenchmark(main, rivalAudits);
            const recommendations = ruleRecommendations(main);

            await progress(92, 'Generating AI strategy');
            const { ai, aiStatus } = await geminiNarrative({ target: main, rivals: rivalAudits, benchmark });
            if (!aiStatus.ok) warnings.push(`Strategy layer unavailable: ${aiStatus.message}`);

            const payload = {
                main, rivals: rivalAudits, benchmark, recommendations, ai, aiStatus, warnings,
                scoreVersion: IG_SCORE_VERSION, generatedAt: new Date().toISOString()
            };
            const postsAnalyzed = main.postsAnalyzed + rivalAudits.reduce((s, r) => s + r.postsAnalyzed, 0);

            // Instagram's photo links expire; the report keeps its own copies (phase 36).
            await progress(94, 'Keeping the post photos');
            await S.keepAuditImages([main, ...rivalAudits.map(r => ({ ...r, topPosts: (r.topPosts || []).slice(0, 2), bottomPosts: [], exemplars: {} }))], `ig/${jobId || crypto.randomUUID()}`);

            await progress(96, 'Saving report');
            const { data: saved } = await supabase.from('reports').insert([{
                user_id: userId,
                client_id: input.clientId || null,
                platform: 'instagram',
                report_type: 'deep_audit',
                set_id: activeSetId,
                target_handle: main.handle,
                competitor_handles: rivalAudits.map(r => r.handle),
                grade: main.grade,
                score: main.score,
                engagement_rate: parseFloat(main.engagementRate),
                posts_analyzed: postsAnalyzed,
                snapshot_date: new Date().toISOString().slice(0, 10),
                credits_estimate: estimate,
                score_version: IG_SCORE_VERSION,
                score_v1: main.scoreV1 ?? null,
                followers_snapshot: main.followers ?? null,
                posts_per_week: parseFloat(main.postsPerWeek) || null,
                cohort_avg_er: benchmark?.cohort?.avgEngagementRate ?? null,
                target_rank: benchmark?.targetRank ?? null,
                ai_summary: ai?.executive_summary || null,
                ai_json: ai || null,
                ai_status: aiStatus,
                report_json: payload
            }]).select('id').maybeSingle();

            if (activeSetId) {
                await supabase.from('competitor_sets')
                    .update({ last_run_at: new Date().toISOString() }).eq('id', activeSetId);
            }

            return {
                reportId: saved?.id || null,
                reportRef: saved?.id || null,
                setId: activeSetId,
                postsAnalyzed,
                aiStatus,
                report: saved?.id ? undefined : payload
            };
        });

registerWorker('fb_community_audit', (userId, input, jobId) => async (progress, ck) => {

    const names = Array.isArray(input.groupNames) ? input.groupNames : [];
    const refs = (input.groups || []).map((id, i) => ({
        groupId: String(id),
        url: `https://www.facebook.com/groups/${id}/`,
        rowId: null,
        name: names[i] || String(id)
    }));
    const auditMode      = input.mode === 'individual' ? 'individual' : 'combined';
    const limit          = input.postsPerGroup || FB_DEFAULT_POSTS;
    const window         = input.days || FB_DEFAULT_DAYS;
    const sampleComments = !!input.sampleComments;
    const commentPosts   = sampleComments ? (input.commentSamplePosts ?? 20) : 0;
    const activeSetId    = input.setId || null;
    const niche          = input.niche || null;
    const location       = input.location || null;
    const since          = input.since || null;
    const estimate       = S.fbEstimateCredits(refs.length, limit, sampleComments, commentPosts);
    const perGroup       = S.fbEstimateCredits(1, limit, sampleComments, commentPosts);

            const step = Math.floor(65 / refs.length);
            const audits = [];
            const allDemand = [];
            let totalPosts = 0;

            for (let i = 0; i < refs.length; i++) {
                // Already scraped and paid for on an earlier attempt.
                const cached = ck.get(refs[i].groupId);
                if (cached) {
                    audits.push(cached);
                    totalPosts += cached.postsAnalyzed || 0;
                    await progress(5 + step * (i + 1),
                        `${cached.name} already measured — reusing saved data`);
                    continue;
                }

                await progress(5 + step * i, `Scraping ${refs[i].name || refs[i].groupId} (${i + 1}/${refs.length})`);
                try {
                    // Fresh key per group. This is the single most important
                    // change for a $5 budget: one group exhausting a key no
                    // longer kills the whole run.
                    const { client } = await getWorkingClient('fb_community', userId,
                        { needUsd: perGroup, jobId });

                    const { meta, rows, demand } = await S.fbProcessGroup(client, userId, refs[i], {
                        limit, days: window, sampleComments, commentPosts, niche, location,
                        source: 'audit', since, jobId
                    });

                    if (!rows.length) {
                        await progress(5 + step * (i + 1), `${meta.name}: no public posts returned — likely private`);
                        const empty = S.computeGroupAudit(meta, [], []);
                        audits.push(empty);
                        await ck.done(refs[i].groupId, empty);   // the run was billed either way
                        continue;
                    }

                    await S.fbSavePosts(rows, input.clientId || null);
                    await S.fbSaveDemand(demand);
                    allDemand.push(...demand);
                    totalPosts += rows.length;

                    const audit = S.computeGroupAudit(meta, rows, demand);
                    audits.push(audit);

                    await supabase.from('fb_groups').update({
                        posts_per_day: audit.postsPerDay,
                        median_comments: audit.medianComments,
                        unique_poster_ratio: audit.uniquePosterRatio,
                        room_value_score: audit.roomValue,
                        score_breakdown: audit.roomValueBreakdown,
                        last_scraped_at: new Date().toISOString()
                    }).eq('user_id', userId).eq('group_id', meta.group_id);

                    await ck.done(refs[i].groupId, audit);

                    await progress(5 + step * (i + 1),
                        `${meta.name}: ${rows.length} posts, ${demand.length} demand signals, Room Value ${audit.roomValue}`);
                } catch (e) {
                    if (e.code === 'NO_CREDIT') {
                        // Everything measured so far is checkpointed. Park the
                        // job rather than throwing the partial work away.
                        await progress(5 + step * i,
                            `Out of Apify credit after ${audits.length}/${refs.length} rooms. Update a key and resume.`);
                        throw e;
                    }
                    await progress(5 + step * (i + 1), `Failed on ${refs[i].groupId}: ${e.message}`);
                }
            }

            // Demand rows for groups reused from a checkpoint are already in
            // fb_demand_signals rather than in allDemand, so count from the
            // audits instead of from this run's in-memory array.
            const totalDemand = audits.reduce((sum, a) => sum + (a.demandSignals || 0), 0);

            if (!audits.some(a => a.postsAnalyzed > 0)) {
                throw new Error('No public posts returned from any selected group. Public groups only in v1 — private groups need a logged-in session and we will not do that.');
            }

            // ---------- INDIVIDUAL MODE: one report per room ----------
            if (auditMode === 'individual') {
                const reports = [];
                const aiStep = Math.floor(25 / audits.length);

                for (let i = 0; i < audits.length; i++) {
                    const a = audits[i];
                    if (!a.postsAnalyzed) continue;
                    await progress(72 + aiStep * i, `Writing report for ${a.name}`);

                    const { ai, aiStatus } = await S.fbNarrative({ mode: 'single', group: a });
                    const payload = { mode: 'individual', group: a, benchmark: null, ai, aiStatus };

                    const { data: saved } = await supabase.from('reports').insert([{
                        user_id: userId,
                        client_id: input.clientId || null,
                        platform: 'facebook',
                        report_type: 'fb_group',
                        audit_mode: 'individual',
                        set_id: activeSetId,
                        target_handle: a.name,
                        fb_group_ids: [a.groupId],
                        fb_group_names: [a.name],
                        location_label: location || null,
                        niche: niche || null,
                        grade: a.roomValue >= 70 ? 'A' : a.roomValue >= 50 ? 'B' : a.roomValue >= 30 ? 'C' : 'D',
                        score: a.roomValue,
                        engagement_rate: a.medianComments,
                        posts_analyzed: a.postsAnalyzed,
                        snapshot_date: new Date().toISOString().slice(0, 10),
                        credits_estimate: S.fbEstimateCredits(1, limit, sampleComments, commentPosts),
                        ai_summary: ai?.executive_summary || null,
                        ai_json: ai || null,
                        ai_status: aiStatus,
                        report_json: payload
                    }]).select('id').maybeSingle();

                    if (saved?.id) {
                        await supabase.from('fb_posts').update({ report_id: saved.id })
                            .eq('user_id', userId).eq('group_id', a.groupId).is('report_id', null);
                        await supabase.from('fb_demand_signals').update({ report_id: saved.id })
                            .eq('user_id', userId).eq('group_id', a.groupId).is('report_id', null);
                    }
                    reports.push({ reportId: saved?.id || null, groupId: a.groupId, name: a.name, roomValue: a.roomValue, postsAnalyzed: a.postsAnalyzed, demandSignals: a.demandSignals });
                }

                if (activeSetId) await supabase.from('fb_group_sets').update({ last_run_at: new Date().toISOString() }).eq('id', activeSetId);

                return {
                    mode: 'individual', setId: activeSetId,
                    reports, postsAnalyzed: totalPosts, demandSignals: totalDemand,
                    reportId: reports[0]?.reportId || null,
                    report: { mode: 'individual', groups: audits, reports }
                };
            }

            // ---------- COMBINED MODE: one comparative report ----------
            await progress(74, 'Ranking rooms against each other');
            const benchmark = S.buildCommunityBenchmark(audits);

            await progress(84, 'Writing the community strategy');
            const { ai, aiStatus } = await S.fbNarrative({ mode: 'combined', groups: audits, benchmark });

            const payload = { mode: 'combined', groups: audits, benchmark, ai, aiStatus };
            const live = audits.filter(a => a.postsAnalyzed > 0);

            await progress(94, 'Saving report');
            const { data: saved } = await supabase.from('reports').insert([{
                user_id: userId,
                client_id: input.clientId || null,
                platform: 'facebook',
                report_type: 'fb_community',
                audit_mode: 'combined',
                set_id: activeSetId,
                target_handle: benchmark?.bestRoom?.name || live[0]?.name || 'Community audit',
                fb_group_ids: live.map(a => a.groupId),
                fb_group_names: live.map(a => a.name),
                location_label: location || null,
                niche: niche || null,
                grade: (benchmark?.avgRoomValue || 0) >= 70 ? 'A' : (benchmark?.avgRoomValue || 0) >= 50 ? 'B' : (benchmark?.avgRoomValue || 0) >= 30 ? 'C' : 'D',
                score: benchmark?.avgRoomValue || 0,
                engagement_rate: live.length ? +(live.reduce((s, a) => s + a.medianComments, 0) / live.length).toFixed(2) : 0,
                posts_analyzed: totalPosts,
                snapshot_date: new Date().toISOString().slice(0, 10),
                credits_estimate: estimate,
                ai_summary: ai?.executive_summary || null,
                ai_json: ai || null,
                ai_status: aiStatus,
                report_json: payload
            }]).select('id').maybeSingle();

            if (saved?.id) {
                const ids = live.map(a => a.groupId);
                await supabase.from('fb_posts').update({ report_id: saved.id })
                    .eq('user_id', userId).in('group_id', ids).is('report_id', null);
                await supabase.from('fb_demand_signals').update({ report_id: saved.id })
                    .eq('user_id', userId).in('group_id', ids).is('report_id', null);
            }
            if (activeSetId) await supabase.from('fb_group_sets').update({ last_run_at: new Date().toISOString() }).eq('id', activeSetId);

            return {
                mode: 'combined', reportId: saved?.id || null, reportRef: saved?.id || null,
                setId: activeSetId, aiStatus,
                postsAnalyzed: totalPosts, demandSignals: totalDemand,
                report: saved?.id ? undefined : payload
            };
        });

registerWorker('fb_page_report', (userId, input, jobId) => async (progress, ck) => {

    const targetRef      = S.parsePageRef(input.target);
    const rivalRef       = input.rival ? S.parsePageRef(input.rival) : null;
    const limit          = input.postsPerPage || S.FB_PAGE_DEFAULT_POSTS;
    const window         = input.days || S.FB_PAGE_DEFAULT_DAYS;
    const includeReviews = !!input.includeReviews;
    const activeSetId    = input.setId || null;
    const brief          = input.brief || null;
    const since          = input.since || null;
    const estimate       = S.fbPageEstimateCredits(rivalRef ? 2 : 1, limit, includeReviews);
    const perPage        = S.fbPageEstimateCredits(1, limit, includeReviews);

            const grab = () => getWorkingClient('fb_page', userId, { needUsd: perPage, jobId })
                .then(r => r.client);

            let main = ck.get(targetRef.pageId);
            if (main) {
                await progress(6, `${main.name} already analysed — reusing saved data`);
            } else {
                await progress(6, `Reading the Page profile for ${targetRef.pageId}`);
                const r = await S.fbAuditPage(await grab(), userId, targetRef, {
                    limit, days: window, includeReviews, since, jobId, clientId: input.clientId || null
                });
                main = r.audit;
                if (!main) throw new Error('The target Page could not be read.');
                await ck.done(targetRef.pageId, main);
            }

            await progress(rivalRef ? 42 : 62,
                `${main.name}: ${main.postsAnalyzed} posts analysed, page score ${main.score}`);

            let rivalAudit = null;
            if (rivalRef) {
                rivalAudit = ck.get(rivalRef.pageId) || null;
                if (rivalAudit) {
                    await progress(70, `${rivalAudit.name} already analysed — reusing saved data`);
                } else {
                    await progress(48, `Reading the rival Page ${rivalRef.pageId}`);
                    try {
                        const r = await S.fbAuditPage(await grab(), userId, rivalRef, {
                            limit, days: window, includeReviews, since, jobId, clientId: input.clientId || null
                        });
                        rivalAudit = r.audit;
                        await ck.done(rivalRef.pageId, rivalAudit);
                        await progress(70, `${rivalAudit.name}: ${rivalAudit.postsAnalyzed} posts analysed, page score ${rivalAudit.score}`);
                    } catch (e) {
                        if (e.code === 'NO_CREDIT') throw e;
                        await progress(70, `Rival failed: ${e.message}. Continuing with a single-page report.`);
                    }
                }
            }

            if (!main.postsAnalyzed && !(rivalAudit && rivalAudit.postsAnalyzed)) {
                throw new Error('No public posts were returned. Public Pages only — confirm the URL points at a Facebook Page rather than a personal profile or a group.');
            }

            await progress(78, 'Building the head-to-head comparison');
            const benchmark = S.buildPageBenchmark(main, rivalAudit);

            await progress(82, 'Assembling recommendations');
            const recommendations = S.fbPageRecommendations(main, benchmark);

            await progress(88, 'Writing the AI strategy layer');
            const { ai, aiStatus } = await S.fbPageNarrative({
                target: main, rival: rivalAudit, benchmark,
                brief: brief ? String(brief).slice(0, 600) : null
            });

            const payload = {
                mode: rivalAudit ? 'versus' : 'single',
                generatedAt: new Date().toISOString(),
                windowDays: window,
                target: main, rival: rivalAudit, benchmark, recommendations, ai, aiStatus,
                brief: brief || null
            };

            const postsAnalyzed = main.postsAnalyzed + (rivalAudit?.postsAnalyzed || 0);

            await progress(95, 'Saving report to the vault');
            const { data: saved } = await supabase.from('reports').insert([{
                user_id: userId,
                client_id: input.clientId || null,
                platform: 'facebook',
                report_type: 'fb_page',
                audit_mode: rivalAudit ? 'versus' : 'single',
                set_id: activeSetId,
                target_handle: main.name || main.pageId,
                competitor_handles: rivalAudit ? [rivalAudit.name || rivalAudit.pageId] : [],
                fb_page_ids: rivalAudit ? [main.pageId, rivalAudit.pageId] : [main.pageId],
                fb_page_names: rivalAudit ? [main.name, rivalAudit.name] : [main.name],
                grade: main.grade,
                score: main.score,
                engagement_rate: main.engagementRate,
                posts_analyzed: postsAnalyzed,
                snapshot_date: new Date().toISOString().slice(0, 10),
                credits_estimate: estimate,
                ai_summary: ai?.executive_summary || null,
                ai_json: ai || null,
                ai_status: aiStatus,
                followers_snapshot: main.followers ?? main.likes ?? null,
                report_json: payload
            }]).select('id').maybeSingle();

            if (saved?.id) {
                const ids = rivalAudit ? [main.pageId, rivalAudit.pageId] : [main.pageId];
                await supabase.from('fb_page_posts').update({ report_id: saved.id })
                    .eq('user_id', userId).in('page_id', ids).is('report_id', null);
            }
            if (activeSetId) {
                await supabase.from('fb_page_sets')
                    .update({ last_run_at: new Date().toISOString() }).eq('id', activeSetId);
            }

            return {
                reportId: saved?.id || null, reportRef: saved?.id || null,
                setId: activeSetId, aiStatus,
                mode: payload.mode, postsAnalyzed,
                report: saved?.id ? undefined : payload
            };
        });


// ---------------------------------------------------------------------------
// fb_discovery and fb_verify used to pass an inline closure to runJob rather
// than registering a factory, so they could not be rebuilt from jobs.input and
// could never be resumed. The sharper cost was that the discovery closure never
// touched the checkpoint at all — a 12-group run that died at group 11 lost all
// 11 paid units AND could not be picked back up. Both halves are fixed here.
// ---------------------------------------------------------------------------

registerWorker('fb_discovery', (userId, input, jobId) => async (progress, ck) => {
    const {
        location = '', niche = '', keywords = [],
        seeds = [], sampleSize = 40, maxGroups = 12
    } = input;

    const sample = Math.min(parseInt(sampleSize, 10) || 40, 120);
    const cap    = Math.min(parseInt(maxGroups, 10) || 12, FB_MAX_GROUPS);

    const { client } = await getWorkingClient('fb_community', userId, {
        needUsd: S.fbEstimateCredits(1, sample, false), jobId
    });

    let refs = (seeds || []).map(id => ({
        groupId: id, url: `https://www.facebook.com/groups/${id}/`
    }));

    // The search phase is itself a billable unit and is now checkpointed. It
    // used to be repeated in full on every attempt.
    if (!refs.length) {
        if (ck.isDone('search')) {
            refs = (ck.get('search') || []).slice(0, cap);
            await progress(15, `Reusing ${refs.length} candidate(s) from the earlier search`);
        } else {
            await progress(8, `Searching Facebook for "${niche || keywords.join(', ')}" near ${location || 'anywhere'}`);
            const queries = [
                ...(keywords || []),
                niche && location ? `${niche} ${location}` : null,
                location ? `${location} community` : null,
                location ? `${location} buy sell` : null,
                niche || null
            ].filter(Boolean).slice(0, 5);

            const found = new Map();
            for (const q of queries) {
                try {
                    const { items } = await callActor(client, FB_SEARCH_ACTOR, {
                        search: q, searchType: 'groups', query: q,
                        resultsLimit: 25, maxResults: 25
                    }, { maxItems: 25, estimateUsd: S.fbEstimateCredits(1, 25, false), jobId });
                    (items || []).forEach(it => {
                        const ref = S.parseGroupRef(it.url || it.groupUrl || it.link || it.id);
                        if (!ref) return;
                        if (!found.has(ref.groupId)) found.set(ref.groupId, {
                            ...ref,
                            hintName: it.name || it.title || null,
                            hintMembers: S.firstNum(it.membersCount, it.memberCount)
                        });
                    });
                    await progress(12, `"${q}" returned ${items?.length || 0} candidates`);
                } catch (e) {
                    if (e.code === 'NO_CREDIT' || e.code === 'CANCELLED') throw e;
                    await progress(12, `Search for "${q}" failed: ${e.message}`);
                }
            }
            const all = Array.from(found.values());
            await ck.done('search', all);
            refs = all.slice(0, cap);
        }
    }

    if (!refs.length) {
        throw new Error('No groups found. Facebook group search is the least reliable part of this pipeline — paste group URLs directly on the Discover tab and they will be scored the same way.');
    }

    await progress(20, `Measuring ${refs.length} rooms`);

    const scored = [];
    const step = Math.max(1, Math.floor(70 / refs.length));

    for (let i = 0; i < refs.length; i++) {
        const unit = 'group:' + refs[i].groupId;

        // The whole point of registering this worker: a group already sampled
        // and paid for is replayed from the checkpoint.
        if (ck.isDone(unit)) {
            const saved = ck.get(unit);
            if (saved) scored.push(saved);
            await progress(20 + step * (i + 1), `${refs[i].groupId} already sampled — reused`);
            continue;
        }

        await progress(20 + step * i, `Sampling ${refs[i].groupId} (${i + 1}/${refs.length})`);
        try {
            const { meta, rows, demand } = await S.fbProcessGroup(client, userId, refs[i], {
                limit: sample, days: 30, sampleComments: false,
                niche, location, source: 'discovery'
            });

            if (meta.privacy === 'private') {
                await ck.done(unit, null);
                await progress(20 + step * (i + 1),
                    `${meta.name} is private — skipped (needs a logged-in session, which we will not do)`);
                continue;
            }

            await S.fbSavePosts(rows, input.clientId || null);
            await S.fbSaveDemand(demand);

            const audit = S.computeGroupAudit(meta, rows, demand);
            await supabase.from('fb_groups').update({
                posts_per_day: audit.postsPerDay,
                median_comments: audit.medianComments,
                unique_poster_ratio: audit.uniquePosterRatio,
                room_value_score: audit.roomValue,
                score_breakdown: audit.roomValueBreakdown,
                last_scraped_at: new Date().toISOString()
            }).eq('user_id', userId).eq('group_id', meta.group_id);

            const entry = {
                groupId: meta.group_id, name: meta.name, url: meta.url,
                memberCount: meta.member_count, privacy: meta.privacy,
                promoAllowed: meta.promo_allowed, approvalRequired: meta.approval_required,
                postsPerDay: audit.postsPerDay, medianComments: audit.medianComments,
                uniquePosters: audit.uniquePosters, uniquePosterRatio: audit.uniquePosterRatio,
                demandSignals: audit.demandSignals, demandRate: audit.demandRate,
                roomValue: audit.roomValue, breakdown: audit.roomValueBreakdown,
                postsSampled: audit.postsAnalyzed
            };
            scored.push(entry);
            await ck.done(unit, entry);
            await progress(20 + step * (i + 1),
                `${meta.name}: Room Value ${audit.roomValue} — ${audit.roomValueBreakdown.verdict}`);
        } catch (e) {
            if (e.code === 'NO_CREDIT' || e.code === 'CANCELLED') throw e;
            await progress(20 + step * (i + 1), `Could not sample ${refs[i].groupId}: ${e.message}`);
        }
    }

    if (!scored.length) throw new Error('Every candidate group failed to scrape. They are most likely private.');

    scored.sort((a, b) => b.roomValue - a.roomValue);
    scored.forEach((g, i) => { g.rank = i + 1; g.isTop10 = i < 10; });

    await progress(96, `Ranked ${scored.length} rooms`);
    return {
        groups: scored,
        top10: scored.slice(0, 10),
        location, niche,
        skipped: refs.length - scored.length
    };
});

registerWorker('fb_verify', (userId, input, jobId) => async (progress, ck) => {
    const { suggestionId } = input;

    // Read the row here, not in the handler. Closing over a request-scoped
    // object is exactly what stopped this job type from being resumable.
    const { data: sug } = await supabase.from('fb_suggestions')
        .select('*').eq('id', suggestionId).eq('user_id', userId).maybeSingle();
    if (!sug) throw new Error('That suggestion no longer exists.');

    const { client } = await getWorkingClient('fb_community', userId, {
        needUsd: S.fbEstimateCredits(1, 80, false), jobId
    });

    let rows;
    if (ck.isDone('scrape')) {
        rows = ck.get('scrape') || [];
        await progress(60, 'Reusing the feed already scraped for this check');
    } else {
        await progress(20, `Re-scraping ${sug.group_name}`);
        const ref = { groupId: sug.group_id, url: `https://www.facebook.com/groups/${sug.group_id}/` };
        const r = await S.fbProcessGroup(client, userId, ref,
            { limit: 80, days: 14, sampleComments: false, source: 'verify' });
        rows = r.rows;
        await S.fbSavePosts(rows, input.clientId || null);
        await ck.done('scrape', rows);
    }

    await progress(70, 'Matching the posted draft');
    const needle = String(sug.draft_text || '').slice(0, 60).toLowerCase().replace(/\s+/g, ' ').trim();
    const match = sug.posted_url
        ? rows.find(r => r.post_url && r.post_url.includes(String(sug.posted_url).split('/').filter(Boolean).pop()))
        : rows.find(r => (r.content || '').toLowerCase().replace(/\s+/g, ' ').includes(needle.slice(0, 40)));

    if (!match) throw new Error('Could not find that post in the recent feed. Paste the exact post URL on the card and try again.');

    await supabase.from('fb_suggestions').update({
        actual_index: match.performance_index,
        verified_at: new Date().toISOString(),
        posted_url: sug.posted_url || match.post_url
    }).eq('id', sug.id).eq('user_id', userId);

    const predicted = Number(sug.predicted_index) || null;
    return {
        suggestionId: sug.id,
        predictedIndex: predicted,
        actualIndex: match.performance_index,
        delta: predicted ? +(match.performance_index - predicted).toFixed(2) : null,
        verdict: match.performance_index >= 2 ? 'Top performer in that room'
               : match.performance_index >= 1.2 ? 'Above the room median'
               : match.performance_index >= 0.8 ? 'Typical for that room'
               : 'Below the room median',
        postUrl: match.post_url
    };
});
