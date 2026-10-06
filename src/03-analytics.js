/**
 * The analytics engine: scores, benchmarks, recommendations.
 *
 * Part of the EdgeLead server, split out of server.js (phase 55). The parts load in
 * order from server.js and share one namespace, S: what this part needs from an earlier
 * part is unpacked below; anything else from another part is read as S.name when it runs.
 */
'use strict';
const S = require('./shared');
const {
    IG_SCORE_V2, extractBioContacts, igAggIndex, igCadence, igComputeScore, igDataQuality, igDistribution,
    igExtras, igFlagCompare, igHeatmap, igIndexPosts, igLeaderboard, igMomentum, igNormalisePost,
    igProfileCompleteness
} = S;
Object.assign(S, { bucketCaption, computeAudit, buildBenchmark, ruleRecommendations });

// ===========================================================================
// ANALYTICS ENGINE
// ===========================================================================

function bucketCaption(len) {
    if (len < 100) return 'short (<100)';
    if (len < 300) return 'medium (100-300)';
    if (len < 800) return 'long (300-800)';
    return 'very long (800+)';
}

function computeAudit(handle, profile, posts) {
    const followers = profile.followersCount ?? profile.followers ?? 0;

    const base = {
        handle,
        followers,
        following: profile.followsCount ?? profile.followingCount ?? 0,
        totalPosts: profile.postsCount ?? 0,
        fullName: profile.fullName || null,
        bio: profile.biography || '',
        website: profile.externalUrl || profile.website || null,
        category: profile.businessCategoryName || profile.categoryName || null,
        isBusiness: !!profile.isBusinessAccount,
        isVerified: !!profile.verified || !!profile.isVerified,
        email: extractBioContacts(profile).email,
        phone: extractBioContacts(profile).phone,
        whatsapp: extractBioContacts(profile).whatsapp,
        contactSources: extractBioContacts(profile).sources,
        city: profile.city || profile.cityName || null,
        address: profile.addressStreet || null,
        profilePic: profile.profilePicUrlHD || profile.profilePicUrl || null,
        postsAnalyzed: 0
    };

    // --- normalise + dedupe once ------------------------------------------
    const seen = new Set();
    const rows = [];
    for (const p of posts || []) {
        const r = igNormalisePost(p, handle);
        if (!r || seen.has(r.shortcode)) continue;
        seen.add(r.shortcode);
        rows.push(r);
    }

    base.postsAnalyzed = rows.length;
    const completeness = igProfileCompleteness(base);

    if (!rows.length) {
        const empty = igComputeScore({
            engagementRate: 0, postsPerWeek: 0, consistency: null, commentRatio: 0,
            viewsPerFollower: 0, completeness: completeness.score, momentumPct: null,
            formatSpread: 0, sampleSize: 0, viewsAvailable: false
        });
        return {
            ...base,
            engagementRate: '0.0', viralityScore: '0.0', postsPerWeek: '0.0',
            avgLikes: 0, avgComments: 0, avgViews: 0,
            score: empty.score, grade: empty.grade, scoreV1: 0,
            contentMix: {}, topHashtags: [], postingHours: [], postingDays: [],
            captionInsight: {}, last30Days: {}, consistency: {}, topPosts: [], bottomPosts: [],
            distribution: null, cadence: igCadence([]), momentum: null, heatmap: null,
            scoreBreakdown: empty, completeness, leaderboards: {}, flags: [],
            extras: null, exemplars: {}, provisional: { count: 0, settled: 0 },
            dataQuality: igDataQuality([], posts)
        };
    }

    igIndexPosts(rows);

    // Settled posts drive every rate. A reel three hours old is not a weak
    // reel, and letting it into the averages is how a healthy account gets
    // told its content is collapsing.
    const settled = rows.filter(r => !r.is_provisional);
    const statPool = settled.length >= Math.max(4, Math.ceil(rows.length * 0.4)) ? settled : rows;
    const usingSettledOnly = statPool !== rows;

    const n = statPool.length;
    const likes = statPool.reduce((s, r) => s + r.likes, 0);
    const comments = statPool.reduce((s, r) => s + r.comments, 0);
    const views = statPool.reduce((s, r) => s + r.views, 0);

    const avgLikes = likes / n, avgComments = comments / n, avgViews = views / n;

    // Two engagement rates, and the difference between them is the point.
    //
    // engagementRate is the mean — the number every other tool in this
    // category reports, kept so the benchmark and the vault stay comparable.
    // engagementRateMedian describes the post this account typically ships.
    // On an account with one runaway reel the mean read 19.4% and the median
    // 2.9%; the second number is the one a strategy should be built on, so
    // that is the one the score uses.
    const distribution = igDistribution(statPool);
    const engagementRate = followers > 0 ? (((avgLikes + avgComments) / followers) * 100).toFixed(2) : '0.0';
    const engagementRateMedian = followers > 0
        ? (((distribution.likes.median + distribution.comments.median) / followers) * 100).toFixed(2)
        : '0.0';
    const viralityScore = followers > 0 ? (avgViews / followers).toFixed(2) : '0.0';
    const viralityScoreMedian = followers > 0 ? (distribution.views.median / followers).toFixed(2) : '0.0';

    const cadence = igCadence(rows);
    const mo = igMomentum(rows);
    const heatmap = igHeatmap(rows);

    // --- content mix (kept in the v1 shape so nothing downstream breaks) ---
    const mix = {};
    statPool.forEach(r => {
        mix[r.post_type] = mix[r.post_type] || { count: 0, likes: 0, comments: 0, views: 0, idx: 0 };
        const m = mix[r.post_type];
        m.count++; m.likes += r.likes; m.comments += r.comments; m.views += r.views;
        m.idx += r.performance_index || 0;
    });

    const contentMix = {};
    Object.entries(mix).forEach(([k, v]) => {
        contentMix[k] = {
            count: v.count,
            share: ((v.count / n) * 100).toFixed(1) + '%',
            avgLikes: Math.round(v.likes / v.count),
            avgComments: Math.round(v.comments / v.count),
            avgViews: Math.round(v.views / v.count),
            avgEngagement: Math.round((v.likes + v.comments) / v.count),
            avgIndex: +(v.idx / v.count).toFixed(2)
        };
    });

    // --- hashtags ----------------------------------------------------------
    const tagStat = {};
    statPool.forEach(r => r.hashtags.forEach(t => {
        tagStat[t] = tagStat[t] || { uses: 0, engagement: 0, idx: 0 };
        tagStat[t].uses++;
        tagStat[t].engagement += r.likes + r.comments;
        tagStat[t].idx += r.performance_index || 0;
    }));

    const topHashtags = Object.entries(tagStat)
        .map(([tag, s]) => ({
            tag, uses: s.uses,
            avgEngagement: Math.round(s.engagement / s.uses),
            avgIndex: +(s.idx / s.uses).toFixed(2)
        }))
        .sort((a, b) => b.uses - a.uses || b.avgEngagement - a.avgEngagement)
        .slice(0, 20);

    // --- caption length ----------------------------------------------------
    const capStat = {};
    statPool.forEach(r => {
        const b = bucketCaption(r.caption_length);
        capStat[b] = capStat[b] || { count: 0, engagement: 0 };
        capStat[b].count++; capStat[b].engagement += r.likes + r.comments;
    });
    const captionInsight = {};
    Object.entries(capStat).forEach(([k, v]) => {
        captionInsight[k] = { count: v.count, avgEngagement: Math.round(v.engagement / v.count) };
    });

    // --- posting hours / days, kept in the v1 shape ------------------------
    const hours = {}, days = {};
    statPool.forEach(r => {
        if (r.hour_local !== null) {
            hours[r.hour_local] = hours[r.hour_local] || { count: 0, engagement: 0 };
            hours[r.hour_local].count++; hours[r.hour_local].engagement += r.likes + r.comments;
        }
        if (r.dow_local !== null) {
            const dn = S.DOW_NAMES[r.dow_local];
            days[dn] = days[dn] || { count: 0, engagement: 0 };
            days[dn].count++; days[dn].engagement += r.likes + r.comments;
        }
    });
    const rank = o => Object.entries(o)
        .map(([k, v]) => ({ key: k, count: v.count, avgEngagement: Math.round(v.engagement / v.count) }))
        .sort((a, b) => b.avgEngagement - a.avgEngagement);

    // --- last 30 days ------------------------------------------------------
    const cutoff = Date.now() - 30 * 86400000;
    const recent = rows.filter(r => r.posted_at && new Date(r.posted_at).getTime() >= cutoff);
    const recentEng = recent.reduce((s, r) => s + r.likes + r.comments, 0);

    // --- leaderboards ------------------------------------------------------
    const leaderboards = {
        format:  igLeaderboard(statPool, 'post_type', 2),
        length:  igLeaderboard(statPool, 'length_band', 2),
        opening: igLeaderboard(statPool, 'opening_pattern', 2),
        aspect:  igLeaderboard(statPool.filter(r => r.aspect_ratio), 'aspect_ratio', 2)
    };

    const topicAgg = {};
    statPool.forEach(r => (r.topic_tags || []).forEach(t => {
        (topicAgg[t] = topicAgg[t] || []).push(r);
    }));
    leaderboards.topic = Object.entries(topicAgg)
        .filter(([, g]) => g.length >= 2)
        .map(([key, g]) => ({
            key, posts: g.length,
            share: ((g.length / n) * 100).toFixed(1) + '%',
            ...igAggIndex(g),
            medEngagement: Math.round(S.median(g.map(r => r.engagement_raw)))
        }))
        .sort((a, b) => (b.medIndex ?? -1) - (a.medIndex ?? -1))
        .slice(0, 12);

    // --- copy flags --------------------------------------------------------
    const flags = [
        igFlagCompare(statPool, 'has_question', 'Asks a question', 'No question'),
        igFlagCompare(statPool, 'has_cta',      'Has a call to action', 'No CTA'),
        igFlagCompare(statPool, 'has_offer',    'Mentions an offer', 'No offer'),
        igFlagCompare(statPool, 'has_emoji',    'Uses emoji', 'No emoji'),
        igFlagCompare(statPool, 'has_link',     'Points at a link', 'No link'),
        igFlagCompare(statPool, 'is_carousel',  'Carousel', 'Single media'),
        igFlagCompare(statPool, 'has_alt_text', 'Has alt text', 'No alt text')
    ].filter(Boolean);

    // --- posts -------------------------------------------------------------
    const card = r => ({
        url: r.post_url,
        shortcode: r.shortcode,
        likes: r.likes,
        comments: r.comments,
        views: r.views,
        type: r.post_type,
        index: r.performance_index,
        postedAt: r.posted_at,
        caption: (r.caption || '').slice(0, 300),
        thumbnail: r.thumbnail_url,
        aspect: r.aspect_ratio,
        carouselCount: r.carousel_count,
        provisional: r.is_provisional
    });

    const byEngagement = [...statPool].sort((a, b) => b.engagement_raw - a.engagement_raw);
    const topPosts = byEngagement.slice(0, 6).map(card);
    const bottomPosts = byEngagement.slice(-4).reverse().map(card);

    const best = (pred) => {
        const pool = statPool.filter(pred).sort((a, b) => (b.performance_index || 0) - (a.performance_index || 0));
        return pool.length ? card(pool[0]) : null;
    };
    const exemplars = {
        bestOverall: byEngagement.length ? card(byEngagement[0]) : null,
        bestReel: best(r => r.post_type === 'Reel'),
        bestCarousel: best(r => r.is_carousel),
        bestStill: best(r => r.post_type === 'Image'),
        mostCommented: [...statPool].sort((a, b) => b.comments - a.comments)[0]
            ? card([...statPool].sort((a, b) => b.comments - a.comments)[0]) : null
    };

    const extras = igExtras(rows);

    // --- score -------------------------------------------------------------
    const commentRatio = distribution.likes.median > 0
        ? (distribution.comments.median / distribution.likes.median) * 100
        : 0;
    const scoreBreakdown = igComputeScore({
        // Median rates, so the grade describes the account rather than its
        // single best day.
        engagementRate: parseFloat(engagementRateMedian),
        postsPerWeek: cadence.postsPerWeek,
        consistency: cadence.consistency,
        commentRatio,
        viewsPerFollower: parseFloat(viralityScoreMedian),
        completeness: completeness.score,
        momentumPct: mo.changePct,
        formatSpread: Object.keys(mix).length,
        sampleSize: rows.length,
        viewsAvailable: distribution.viewsAvailable
    });

    // v1 score, retained so reports saved before this patch stay comparable
    // against reports saved after it.
    const scoreV1 = Math.round(
        Math.min(40, parseFloat(engagementRate) * 13) +
        Math.min(25, parseFloat(viralityScore) * 12) +
        Math.min(20, cadence.postsPerWeek * 4) +
        Math.min(15, Object.keys(mix).length * 5)
    );

    return {
        ...base,

        // --- v1 surface, unchanged shape -----------------------------------
        engagementRate,
        viralityScore,
        engagementRateMedian,
        viralityScoreMedian,
        postsPerWeek: String(cadence.postsPerWeek),
        score: IG_SCORE_V2 ? scoreBreakdown.score : scoreV1,
        grade: IG_SCORE_V2 ? scoreBreakdown.grade
             : scoreV1 >= 85 ? 'A+' : scoreV1 >= 70 ? 'A' : scoreV1 >= 55 ? 'B' : scoreV1 >= 40 ? 'C' : 'D',
        scoreV1,
        avgLikes: Math.round(avgLikes),
        avgComments: Math.round(avgComments),
        avgViews: Math.round(avgViews),
        contentMix,
        topHashtags,
        postingHours: rank(hours).slice(0, 8),
        postingDays: rank(days),
        captionInsight,
        consistency: {
            postsPerWeek: String(cadence.postsPerWeek),
            longestGapDays: String(cadence.longestGapDays),
            windowDays: String(cadence.spanDays)
        },
        last30Days: {
            posts: recent.length,
            totalEngagement: recentEng,
            avgEngagement: recent.length ? Math.round(recentEng / recent.length) : 0
        },
        topPosts,

        // --- phase 4 ---------------------------------------------------------
        bottomPosts,
        exemplars,
        distribution,
        cadence,
        momentum: mo,
        heatmap,
        scoreBreakdown,
        completeness,
        leaderboards,
        flags,
        extras,
        provisional: {
            count: rows.length - settled.length,
            settled: settled.length,
            total: rows.length,
            excludedFromRates: usingSettledOnly,
            // The posts themselves, not just a count. Telling someone "2 posts
            // were excluded" without saying which is worse than not mentioning
            // it — they cannot check the call.
            posts: rows.filter(r => r.is_provisional)
                       .sort((a, b) => new Date(b.posted_at) - new Date(a.posted_at))
                       .slice(0, 6).map(card),
            note: usingSettledOnly
                ? `${rows.length - settled.length} post(s) newer than the settle window are shown but excluded from rates.`
                : 'Too few settled posts to exclude the new ones — rates include everything.'
        },
        dataQuality: igDataQuality(rows, posts)
    };
}


function buildBenchmark(main, rivals) {
    const all = [main, ...rivals];
    const avg = k => all.reduce((s, a) => s + parseFloat(a[k] || 0), 0) / all.length;

    const cohort = {
        accounts: all.length,
        avgFollowers: Math.round(all.reduce((s, a) => s + (a.followers || 0), 0) / all.length),
        avgEngagementRate: avg('engagementRate').toFixed(2),
        avgViralityScore: avg('viralityScore').toFixed(2),
        avgPostsPerWeek: avg('postsPerWeek').toFixed(1),
        avgScore: Math.round(avg('score'))
    };

    const ranked = [...all].sort((a, b) => b.score - a.score).map((a, i) => ({
        rank: i + 1, handle: a.handle, score: a.score, grade: a.grade,
        followers: a.followers, engagementRate: a.engagementRate,
        postsPerWeek: a.postsPerWeek, isTarget: a.handle === main.handle
    }));

    const gaps = {
        engagementRate: (parseFloat(main.engagementRate) - parseFloat(cohort.avgEngagementRate)).toFixed(2),
        viralityScore:  (parseFloat(main.viralityScore)  - parseFloat(cohort.avgViralityScore)).toFixed(2),
        postsPerWeek:   (parseFloat(main.postsPerWeek)   - parseFloat(cohort.avgPostsPerWeek)).toFixed(1),
        score:          main.score - cohort.avgScore
    };

    // hashtags the cohort uses that the target does not
    const mine = new Set((main.topHashtags || []).map(h => h.tag));
    const theirs = {};
    rivals.forEach(r => (r.topHashtags || []).forEach(h => {
        if (mine.has(h.tag)) return;
        theirs[h.tag] = theirs[h.tag] || { tag: h.tag, usedBy: 0, avgEngagement: 0 };
        theirs[h.tag].usedBy++;
        theirs[h.tag].avgEngagement = Math.round((theirs[h.tag].avgEngagement + h.avgEngagement) / 2);
    }));

    const hashtagGaps = Object.values(theirs)
        .sort((a, b) => b.usedBy - a.usedBy || b.avgEngagement - a.avgEngagement)
        .slice(0, 15);

    return { cohort, ranked, gaps, hashtagGaps, targetRank: ranked.find(r => r.isTarget)?.rank || null };
}

function ruleRecommendations(a) {
    const out = [];
    if (parseFloat(a.engagementRate) < 1.5)
        out.push('Engagement rate is below the 1.5% healthy band. Close captions with a direct question and shift static posts into multi-slide carousels.');
    if (parseFloat(a.viralityScore) < 0.8)
        out.push('Reel play counts are trailing follower totals. Move to 7-15 second trending Reels to re-enter the Explore distribution.');
    if (parseFloat(a.postsPerWeek) < 3.0)
        out.push(`Posting cadence is ${a.postsPerWeek}/week. Target 4-5 to avoid algorithmic drop-off.`);
    if (parseFloat(a.consistency?.longestGapDays || 0) > 14)
        out.push(`There is a ${a.consistency.longestGapDays}-day silence in the recent window. Gaps that long reset reach.`);
    if (!a.website)
        out.push('No link in bio. Add a tracked landing page — this is the single cheapest conversion fix.');
    if (!out.length)
        out.push('Account health is strong. Hold the current Reel cadence and scale the top-performing formats.');
    return out;
}
