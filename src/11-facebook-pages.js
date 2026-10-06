/**
 * Facebook Pages: reports, lead discovery, saved pages and trends.
 *
 * Part of the EdgeLead server, split out of server.js (phase 55). The parts load in
 * order from server.js and share one namespace, S: what this part needs from an earlier
 * part is unpacked below; anything else from another part is read as S.name when it runs.
 */
'use strict';
const S = require('./shared');
const {
    AI_PROMPT_BUDGET, DOW_NAMES, FB_COMMENT_WEIGHT, FB_SEARCH_ACTOR, FB_SHARE_WEIGHT, GEMINI_MODEL,
    JOB_WORKERS, aiReasonText, app, assertJobSlot, auth, budgetSnapshot, budgetedJson, callActor,
    classifyIntent, createJob, domainOf, fbEstimateCredits, fbMediaType, fbPageAiSlim, fbPostId,
    fbReactions, fbText, fbTimestamp, firstNum, geminiAvailable, geminiCallDetailed, getWorkingClient,
    leadAssessment, leadFit, leaderboard, leadsPhase40, lengthBand, linkLeadsToClient, localParts, logger,
    median, openingPattern, refundLeadQuota, registerWorker, requireEngine, runJob, sendErr, spendLimit,
    supabase, tagsOf, takeLeadQuota, timeHeatmap, topicTags
} = S;
Object.assign(S, {
    parsePageRef, normaliseReactionBreakdown, profileCompleteness, computePageScore, buildPageBenchmark,
    fbPageRecommendations, fbPageNarrative, fbPageEstimateCredits, fbAuditPage, fbPageSearchRefs,
    fbPageToLead
});

// ===========================================================================
// ===========================================================================
//  FACEBOOK PAGE REPORT ENGINE
//  Engine key: 'fb_page'.  Job type: 'fb_page_report'.
//
//  This is the Facebook mirror of the Instagram deep audit: it reports on a
//  BUSINESS PAGE, not a group. One target page, optionally one rival page,
//  every dimension the public payload will give us — profile completeness,
//  cadence, format mix, reaction sentiment, conversation rate, amplification,
//  timing, copy patterns, hashtags, links, CTAs, video, momentum — each post
//  indexed against that page's OWN median so a 900-follower page and a
//  900k-follower page can be read on the same scale.
//
//  Reuses the existing jobs table, /api/job/:id polling, the reports vault,
//  the Apify key pool and every FB text helper defined above. No parallel
//  infrastructure, no duplicated primitives.
// ===========================================================================
// ===========================================================================

// --- Actors are env-overridable: Apify renames its Facebook actors often ---
const FB_PAGE_DETAILS_ACTOR = process.env.FB_PAGE_DETAILS_ACTOR || 'apify/facebook-pages-scraper';
const FB_PAGE_POSTS_ACTOR   = process.env.FB_PAGE_POSTS_ACTOR   || 'apify/facebook-posts-scraper';
const FB_PAGE_REVIEWS_ACTOR = process.env.FB_PAGE_REVIEWS_ACTOR || 'apify/facebook-reviews-scraper';

const FB_PAGE_DEFAULT_POSTS = parseInt(process.env.FB_PAGE_DEFAULT_POSTS || '50', 10);
S.FB_PAGE_DEFAULT_POSTS = FB_PAGE_DEFAULT_POSTS;
const FB_PAGE_MAX_POSTS     = parseInt(process.env.FB_PAGE_MAX_POSTS     || '300', 10);
const FB_PAGE_DEFAULT_DAYS  = parseInt(process.env.FB_PAGE_DEFAULT_DAYS  || '90', 10);
S.FB_PAGE_DEFAULT_DAYS = FB_PAGE_DEFAULT_DAYS;
const FB_PAGE_MAX_DAYS      = parseInt(process.env.FB_PAGE_MAX_DAYS      || '365', 10);
const COST_PER_1K_FB_PAGE_POSTS = parseFloat(process.env.COST_PER_1K_FB_PAGE_POSTS || '3.20');
const COST_PER_FB_PAGE_PROFILE  = parseFloat(process.env.COST_PER_FB_PAGE_PROFILE  || '0.004');

// ---------------------------------------------------------------------------
// PAGE REFERENCE PARSING
// Accepts: a full URL, fb.com short form, profile.php?id=, /people/Name/123,
// a bare @handle, or a bare slug. Group URLs are rejected on purpose — this
// engine is Pages only, the group engine already exists.
// ---------------------------------------------------------------------------
function parsePageRef(input) {
    let s = String(input || '').trim();
    if (!s) return null;
    if (/facebook\.com\/groups\//i.test(s)) return null;

    s = s.replace(/^@/, '');

    // profile.php?id=123456
    const pid = s.match(/facebook\.com\/profile\.php\?id=(\d+)/i);
    if (pid) return { pageId: pid[1], url: `https://www.facebook.com/profile.php?id=${pid[1]}`, isNumeric: true };

    // /people/Some-Name/1000123456789
    const people = s.match(/facebook\.com\/people\/[^/]+\/(\d+)/i);
    if (people) return { pageId: people[1], url: `https://www.facebook.com/profile.php?id=${people[1]}`, isNumeric: true };

    // any facebook / fb.com url
    const m = s.match(/(?:facebook\.com|fb\.com|fb\.me)\/(?:pg\/)?([^/?#\s]+)/i);
    let slug = m ? m[1] : s.replace(/^https?:\/\//i, '').replace(/\/+$/, '').split(/[/?#]/)[0];

    slug = String(slug || '').trim();
    if (!slug || /\s/.test(slug)) return null;
    if (/^(pages|pg|profile\.php|people|groups|watch|marketplace|events)$/i.test(slug)) return null;

    return {
        pageId: slug.toLowerCase(),
        url: `https://www.facebook.com/${slug}/`,
        isNumeric: /^\d+$/.test(slug)
    };
}

// ---------------------------------------------------------------------------
// PROFILE NORMALISATION
// Apify's page actors are inconsistent between versions, so every field is
// resolved through a list of aliases rather than a single key.
// ---------------------------------------------------------------------------
function pickFirst(obj, keys, fallback = null) {
    for (const k of keys) {
        const v = k.split('.').reduce((o, part) => (o == null ? o : o[part]), obj);
        if (v !== undefined && v !== null && v !== '') return v;
    }
    return fallback;
}

function fbPageProfile(items, ref) {
    const raw = (items || []).find(i => i && (i.title || i.pageName || i.name || i.likes || i.followers)) || {};

    const hoursRaw = pickFirst(raw, ['openingHours', 'hours', 'businessHours', 'info.hours']);
    const categories = pickFirst(raw, ['categories', 'category', 'pageCategory', 'info.categories'], []);
    const catList = Array.isArray(categories) ? categories.map(String) : [String(categories)].filter(Boolean);

    return {
        page_id: ref.pageId,
        username: pickFirst(raw, ['pageUrl', 'username', 'userName', 'vanity'], ref.pageId),
        name: pickFirst(raw, ['title', 'pageName', 'name', 'pageTitle'], ref.pageId),
        url: pickFirst(raw, ['pageUrl', 'url', 'facebookUrl'], ref.url),
        category: catList[0] || null,
        categories: catList,
        about: String(pickFirst(raw, ['intro', 'about', 'pageIntro', 'description', 'bio', 'info.about'], '') || '').slice(0, 3000),
        likes: firstNum(raw.likes, raw.likesCount, raw.pageLikes, raw.fanCount, 0),
        followers: firstNum(raw.followers, raw.followersCount, raw.pageFollowers, raw.followerCount, 0),
        verified: !!pickFirst(raw, ['isVerified', 'verified', 'isBusinessPageActive'], false),
        website: pickFirst(raw, ['website', 'websites.0', 'info.website']),
        email: pickFirst(raw, ['email', 'emails.0', 'info.email']),
        phone: pickFirst(raw, ['phone', 'phoneNumber', 'contactPhone', 'info.phone']),
        address: pickFirst(raw, ['address', 'addressString', 'streetAddress', 'info.address', 'location.address']),
        city: pickFirst(raw, ['city', 'location.city']),
        country: pickFirst(raw, ['country', 'location.country']),
        rating: (() => { const r = pickFirst(raw, ['rating', 'pageRating', 'overallStarRating', 'ratingOverall']); const n = Number(r); return isNaN(n) ? null : n; })(),
        reviews_count: firstNum(raw.reviewsCount, raw.ratingCount, raw.reviews, 0),
        price_range: pickFirst(raw, ['priceRange', 'price_range', 'info.priceRange']),
        creation_date: pickFirst(raw, ['creationDate', 'pageCreatedDate', 'createdAt', 'foundedDate']),
        profile_pic: pickFirst(raw, ['profilePhoto', 'profilePic', 'profilePictureUrl', 'avatar', 'profilePhotoUrl']),
        cover_photo: pickFirst(raw, ['coverPhoto', 'coverPhotoUrl', 'coverImage']),
        has_hours: !!(hoursRaw && (Array.isArray(hoursRaw) ? hoursRaw.length : Object.keys(hoursRaw || {}).length)),
        hours: hoursRaw || null,
        messenger: pickFirst(raw, ['messenger', 'messengerLink', 'info.messenger']),
        cta: pickFirst(raw, ['pageCta', 'callToAction', 'cta', 'ctaType']),
        ad_status: pickFirst(raw, ['adStatus', 'adLibraryStatus', 'isRunningAds']),
        raw_keys: Object.keys(raw || {}).slice(0, 60)
    };
}

// ---------------------------------------------------------------------------
// POST NORMALISATION
// ---------------------------------------------------------------------------
const FB_CTA_RE = /\b(dm|inbox|message us|contact us|call (us|now)|whatsapp|order now|book now|buy now|shop now|visit|click|link in|sign up|register|apply|call \+?\d|hotline|order koren|অর্ডার|ইনবক্স|যোগাযোগ|কল করুন)\b/i;
S.FB_CTA_RE = FB_CTA_RE;
const FB_QUESTION_RE = /\?|(^|\s)(who|what|when|where|why|which|how|anyone|any ?one|kobe|kothay|কি|কেন|কিভাবে|কোথায়)\b/i;
S.FB_QUESTION_RE = FB_QUESTION_RE;
const FB_OFFER_RE = /\b(offer|discount|sale|% ?off|free delivery|limited time|combo|deal|bogo|coupon|promo code|ছাড়|অফার|ডিসকাউন্ট)\b/i;
S.FB_OFFER_RE = FB_OFFER_RE;
const FB_EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
S.FB_EMOJI_RE = FB_EMOJI_RE;

function fbPageViews(p) {
    return firstNum(p.viewsCount, p.videoViewCount, p.videoPlayCount, p.playCount, p.views, p.viewCount, 0);
}

function normaliseReactionBreakdown(breakdown) {
    if (!breakdown || typeof breakdown !== 'object') return null;
    const out = {};
    Object.entries(breakdown).forEach(([k, v]) => {
        const key = String(k).toLowerCase().replace(/[^a-z]/g, '');
        const n = Number(v);
        if (!isNaN(n) && n > 0) out[key] = (out[key] || 0) + n;
    });
    return Object.keys(out).length ? out : null;
}

function fbPageNormalisePost(item, pageId, pageRowId, userId) {
    const postId = fbPostId(item);
    if (!postId) return null;

    const text = fbText(item);
    const d = fbTimestamp(item);
    const { total: reactions, breakdown } = fbReactions(item);
    const comments = firstNum(item.commentsCount, item.comments?.length, item.commentCount);
    const shares = firstNum(item.sharesCount, item.shareCount, item.shares);
    const views = fbPageViews(item);
    const media = fbMediaType(item);
    const { hour, dow } = localParts(d);
    const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
    const hashtags = tagsOf(text, '#');
    const ageHours = d ? (Date.now() - d.getTime()) / 3600000 : 999;

    const engagement = reactions + (FB_COMMENT_WEIGHT * comments) + (FB_SHARE_WEIGHT * shares);

    return {
        user_id: userId,
        page_id: pageId,
        page_row_id: pageRowId || null,
        post_id: postId,
        post_url: item.url || item.postUrl || item.topLevelUrl || item.link || null,
        content: text.slice(0, 6000),
        content_length: text.length,
        word_count: words,
        media_type: media.type,
        link_url: media.link || null,
        link_domain: media.link ? domainOf(media.link) : null,
        reactions_total: reactions,
        reactions_breakdown: normaliseReactionBreakdown(breakdown),
        comments,
        shares,
        views,
        posted_at: d ? d.toISOString() : null,
        hour_local: hour,
        dow_local: dow,
        engagement_raw: engagement,
        performance_index: null,          // filled by the indexing pass
        intent_type: classifyIntent(text),
        topic_tags: topicTags(text),
        hashtags,
        opening_pattern: openingPattern(text),
        length_band: lengthBand(words),
        has_link: !!media.link,
        has_question: FB_QUESTION_RE.test(text),
        has_cta: FB_CTA_RE.test(text),
        has_offer: FB_OFFER_RE.test(text),
        has_emoji: FB_EMOJI_RE.test(text),
        is_provisional: ageHours < 24,
        raw: { keys: Object.keys(item || {}).slice(0, 40) }
    };
}

/**
 * Index every post against the page's own median for that calendar month.
 * A page that grew 4x over the window would otherwise make every old post
 * look like a failure; monthly baselines remove that drift.
 */
function fbPageIndexPosts(rows) {
    const buckets = {};
    rows.forEach(r => {
        const month = (r.posted_at || '').slice(0, 7) || 'unknown';
        (buckets[`${r.page_id}::${month}`] = buckets[`${r.page_id}::${month}`] || []).push(r);
    });

    const baselines = {};
    Object.entries(buckets).forEach(([key, group]) => {
        const settled = group.filter(r => !r.is_provisional);
        const pool = settled.length >= 4 ? settled : group;
        const med = median(pool.map(r => r.engagement_raw));
        baselines[key] = med > 0 ? med : 1;
    });

    rows.forEach(r => {
        const month = (r.posted_at || '').slice(0, 7) || 'unknown';
        r.performance_index = +(r.engagement_raw / (baselines[`${r.page_id}::${month}`] || 1)).toFixed(3);
    });

    return { rows, baselines };
}

// ---------------------------------------------------------------------------
// BOOLEAN-DIMENSION LEADERBOARD
// "Posts with a question in them" vs "posts without" — a flag comparison, not
// a category comparison, so it needs its own shape.
// ---------------------------------------------------------------------------
function flagCompare(rows, field, labelOn, labelOff) {
    const on = rows.filter(r => r[field]);
    const off = rows.filter(r => !r[field]);
    const avg = arr => arr.length ? +(arr.reduce((s, r) => s + (r.performance_index || 0), 0) / arr.length).toFixed(2) : null;
    const avgE = arr => arr.length ? Math.round(arr.reduce((s, r) => s + (r.engagement_raw || 0), 0) / arr.length) : 0;

    const onIdx = avg(on), offIdx = avg(off);
    return {
        field,
        with: { label: labelOn, posts: on.length, share: rows.length ? +((on.length / rows.length) * 100).toFixed(1) : 0, avgIndex: onIdx, avgEngagement: avgE(on) },
        without: { label: labelOff, posts: off.length, share: rows.length ? +((off.length / rows.length) * 100).toFixed(1) : 0, avgIndex: offIdx, avgEngagement: avgE(off) },
        lift: (onIdx != null && offIdx != null && offIdx > 0) ? +((onIdx / offIdx - 1) * 100).toFixed(1) : null,
        reliable: on.length >= 3 && off.length >= 3
    };
}

// ---------------------------------------------------------------------------
// REACTION SENTIMENT
// Reaction mix is the only free sentiment signal Facebook gives away.
// ---------------------------------------------------------------------------
const POSITIVE_REACTIONS = ['like', 'love', 'care', 'haha', 'wow'];
const NEGATIVE_REACTIONS = ['sad', 'angry'];

function reactionSentiment(rows) {
    const totals = {};
    rows.forEach(r => {
        const b = r.reactions_breakdown;
        if (!b) return;
        Object.entries(b).forEach(([k, v]) => { totals[k] = (totals[k] || 0) + Number(v || 0); });
    });

    const grand = Object.values(totals).reduce((s, v) => s + v, 0);
    if (!grand) return { available: false, note: 'The actor did not return a reaction breakdown for this page.' };

    const pos = POSITIVE_REACTIONS.reduce((s, k) => s + (totals[k] || 0), 0);
    const neg = NEGATIVE_REACTIONS.reduce((s, k) => s + (totals[k] || 0), 0);
    const like = totals.like || 0;

    return {
        available: true,
        totals,
        mix: Object.entries(totals).sort((a, b) => b[1] - a[1])
            .map(([type, count]) => ({ type, count, share: +((count / grand) * 100).toFixed(1) })),
        positiveShare: +((pos / grand) * 100).toFixed(1),
        negativeShare: +((neg / grand) * 100).toFixed(1),
        // Everything beyond a plain Like took deliberate effort from the reader.
        highEffortShare: +(((grand - like) / grand) * 100).toFixed(1),
        grandTotal: grand
    };
}

// ---------------------------------------------------------------------------
// CADENCE + MOMENTUM
// ---------------------------------------------------------------------------
function cadenceStats(rows) {
    const stamps = rows.map(r => r.posted_at ? new Date(r.posted_at).getTime() : null)
        .filter(Boolean).sort((a, b) => a - b);

    if (stamps.length < 2) {
        return { postsPerWeek: rows.length, spanDays: 1, longestGapDays: null, medianGapDays: null,
                 consistency: null, activeWeeks: rows.length ? 1 : 0, lastPostDaysAgo: null, silent: false };
    }

    const spanDays = Math.max(1, (stamps[stamps.length - 1] - stamps[0]) / 86400000);
    const gaps = [];
    for (let i = 1; i < stamps.length; i++) gaps.push((stamps[i] - stamps[i - 1]) / 86400000);

    const medGap = median(gaps);
    const longest = Math.max(...gaps);
    const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((s, g) => s + Math.pow(g - mean, 2), 0) / gaps.length);
    // 100 = perfectly metronomic. Falls as the gaps become erratic.
    const consistency = mean > 0 ? Math.max(0, Math.round(100 - Math.min(100, (sd / mean) * 55))) : null;

    const weeks = new Set(rows.filter(r => r.posted_at)
        .map(r => { const d = new Date(r.posted_at); const y = d.getUTCFullYear();
                    const w = Math.floor((d - new Date(Date.UTC(y, 0, 1))) / (7 * 86400000)); return `${y}-${w}`; }));

    return {
        postsPerWeek: +((rows.length / spanDays) * 7).toFixed(1),
        postsPerMonth: +((rows.length / spanDays) * 30).toFixed(1),
        spanDays: Math.round(spanDays),
        medianGapDays: +medGap.toFixed(1),
        longestGapDays: +longest.toFixed(1),
        consistency,
        activeWeeks: weeks.size,
        lastPostDaysAgo: +((Date.now() - stamps[stamps.length - 1]) / 86400000).toFixed(1),
        silent: (Date.now() - stamps[stamps.length - 1]) / 86400000 > 14
    };
}

/** Month-by-month trajectory: is this page climbing or sliding? */
function momentum(allRows) {
    // Posts under 24h old are still collecting engagement. Leaving them in
    // would make the newest month look like a collapse every single time.
    const rows = allRows.filter(r => !r.is_provisional);
    const byMonth = {};
    rows.forEach(r => {
        if (!r.posted_at) return;
        const m = r.posted_at.slice(0, 7);
        byMonth[m] = byMonth[m] || { month: m, posts: 0, engagement: 0, reactions: 0, comments: 0, shares: 0 };
        byMonth[m].posts++;
        byMonth[m].engagement += r.engagement_raw || 0;
        byMonth[m].reactions += r.reactions_total || 0;
        byMonth[m].comments += r.comments || 0;
        byMonth[m].shares += r.shares || 0;
    });

    const months = Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month)).map(m => ({
        ...m,
        avgEngagement: Math.round(m.engagement / m.posts),
        avgComments: +(m.comments / m.posts).toFixed(1)
    }));

    let direction = null, changePct = null;
    if (months.length >= 2) {
        const prev = months[months.length - 2], last = months[months.length - 1];
        if (prev.avgEngagement > 0) {
            changePct = +(((last.avgEngagement - prev.avgEngagement) / prev.avgEngagement) * 100).toFixed(1);
            direction = changePct > 8 ? 'rising' : changePct < -8 ? 'falling' : 'flat';
        }
    }

    // Newest third vs oldest third — steadier than a single month comparison.
    let halfSplit = null;
    if (rows.length >= 9) {
        const sorted = [...rows].filter(r => r.posted_at).sort((a, b) => new Date(a.posted_at) - new Date(b.posted_at));
        const third = Math.floor(sorted.length / 3);
        const oldAvg = sorted.slice(0, third).reduce((s, r) => s + r.engagement_raw, 0) / third;
        const newAvg = sorted.slice(-third).reduce((s, r) => s + r.engagement_raw, 0) / third;
        halfSplit = {
            oldestThirdAvg: Math.round(oldAvg),
            newestThirdAvg: Math.round(newAvg),
            changePct: oldAvg > 0 ? +(((newAvg - oldAvg) / oldAvg) * 100).toFixed(1) : null
        };
    }

    return { months, direction, changePct, halfSplit };
}

// ---------------------------------------------------------------------------
// PROFILE COMPLETENESS
// Cheap to fix, disproportionately valuable, and almost every local business
// page is missing something here.
// ---------------------------------------------------------------------------
function profileCompleteness(p) {
    const checks = [
        { key: 'name',       label: 'Page name set',            ok: !!p.name,                          weight: 5 },
        { key: 'category',   label: 'Business category set',    ok: !!p.category,                      weight: 10 },
        { key: 'about',      label: 'About / intro written',    ok: !!(p.about && p.about.length > 40), weight: 15 },
        { key: 'website',    label: 'Website linked',           ok: !!p.website,                       weight: 12 },
        { key: 'phone',      label: 'Phone number published',   ok: !!p.phone,                         weight: 12 },
        { key: 'email',      label: 'Email published',          ok: !!p.email,                         weight: 6 },
        { key: 'address',    label: 'Address published',        ok: !!p.address,                       weight: 10 },
        { key: 'hours',      label: 'Opening hours set',        ok: !!p.has_hours,                     weight: 10 },
        { key: 'profile_pic',label: 'Profile photo set',        ok: !!p.profile_pic,                   weight: 5 },
        { key: 'cover',      label: 'Cover photo set',          ok: !!p.cover_photo,                   weight: 5 },
        { key: 'cta',        label: 'Call-to-action button set', ok: !!p.cta,                          weight: 5 },
        { key: 'reviews',    label: 'Reviews enabled and present', ok: (p.reviews_count || 0) > 0,     weight: 5 }
    ];

    const earned = checks.filter(c => c.ok).reduce((s, c) => s + c.weight, 0);
    const total = checks.reduce((s, c) => s + c.weight, 0);

    return {
        score: Math.round((earned / total) * 100),
        checks,
        missing: checks.filter(c => !c.ok).map(c => c.label)
    };
}

// ---------------------------------------------------------------------------
// PAGE SCORE
// Six pillars. Every pillar is bounded, so one dimension cannot carry a page
// that is failing everywhere else — and the breakdown is returned so the
// client can see exactly where the points went.
// ---------------------------------------------------------------------------
function computePageScore(parts) {
    const { engagementRate, postsPerWeek, consistency, conversationRate,
            amplificationRate, completeness, momentumPct, formatSpread, sampleSize } = parts;

    // 1. Engagement per follower (25) — the headline number, log-scaled because
    //    small pages routinely post 8% rates that a 500k page can never reach.
    const er = engagementRate || 0;
    const engagementPts = Math.min(25, Math.round((Math.log10(1 + er * 12) / Math.log10(13)) * 25));

    // 2. Cadence (18) — 3-7 posts a week is the sweet spot for a business page.
    const ppw = postsPerWeek || 0;
    const cadencePts = ppw === 0 ? 0
        : ppw < 1 ? 4
        : ppw < 2 ? 9
        : ppw <= 7 ? 18
        : ppw <= 12 ? 14
        : 10;

    // 3. Consistency (12) — rhythm matters as much as volume.
    const consistencyPts = Math.round(((consistency ?? 50) / 100) * 12);

    // 4. Conversation (18) — comments per 100 reactions. Comments are the
    //    hardest engagement to fake and the strongest reach signal.
    const conv = conversationRate || 0;
    const conversationPts = Math.min(18, Math.round((Math.log10(1 + conv) / Math.log10(26)) * 18));

    // 5. Amplification (12) — shares per 100 reactions.
    const amp = amplificationRate || 0;
    const amplificationPts = Math.min(12, Math.round((Math.log10(1 + amp) / Math.log10(16)) * 12));

    // 6. Profile completeness (10) + format range (5)
    const completenessPts = Math.round(((completeness || 0) / 100) * 10);
    const formatPts = Math.min(5, (formatSpread || 0) >= 3 ? 5 : (formatSpread || 0) * 2);

    let score = engagementPts + cadencePts + consistencyPts + conversationPts +
                amplificationPts + completenessPts + formatPts;

    // Momentum adjusts within ±5, it does not dominate.
    const momentumAdj = momentumPct == null ? 0 : Math.max(-5, Math.min(5, Math.round(momentumPct / 10)));
    score = Math.max(0, Math.min(100, score + momentumAdj));

    const grade = score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : score >= 35 ? 'D' : 'F';

    return {
        score, grade,
        breakdown: [
            { pillar: 'Engagement per follower', points: engagementPts,   max: 25, detail: `${er.toFixed(2)}% per post` },
            { pillar: 'Posting cadence',         points: cadencePts,      max: 18, detail: `${ppw} posts/week` },
            { pillar: 'Consistency',             points: consistencyPts,  max: 12, detail: consistency == null ? 'not enough posts' : `${consistency}/100 rhythm` },
            { pillar: 'Conversation',            points: conversationPts, max: 18, detail: `${conv.toFixed(1)} comments per 100 reactions` },
            { pillar: 'Amplification',           points: amplificationPts,max: 12, detail: `${amp.toFixed(1)} shares per 100 reactions` },
            { pillar: 'Profile completeness',    points: completenessPts, max: 10, detail: `${completeness || 0}% complete` },
            { pillar: 'Format range',            points: formatPts,       max: 5,  detail: `${formatSpread || 0} formats in use` },
            { pillar: 'Momentum adjustment',     points: momentumAdj,     max: 5,  detail: momentumPct == null ? 'no trend data' : `${momentumPct > 0 ? '+' : ''}${momentumPct}% month over month` }
        ],
        lowConfidence: sampleSize > 0 && sampleSize < 12,
        verdict: (sampleSize > 0 && sampleSize < 12)
            ? `Only ${sampleSize} posts in the window — treat this as provisional`
            : score >= 80 ? 'Strong page — protect what is working'
            : score >= 65 ? 'Healthy page with a clear gap to close'
            : score >= 50 ? 'Functional but underperforming'
            : score >= 35 ? 'Weak — the fundamentals need fixing first'
            : 'Dormant or badly broken'
    };
}

// ---------------------------------------------------------------------------
// FULL PAGE AUDIT
// ---------------------------------------------------------------------------
function computePageAudit(profile, rows, extras = {}) {
    const posts = rows.length;
    const completeness = profileCompleteness(profile);

    if (!posts) {
        return {
            pageId: profile.page_id,
            name: profile.name,
            url: profile.url,
            profile,
            completeness,
            postsAnalyzed: 0,
            score: 0, grade: 'F',
            scoreBreakdown: { verdict: 'No public posts returned — the page may be new, restricted, region-locked, or the URL may be wrong.', breakdown: [] },
            formats: [], intents: [], lengths: [], openings: [],
            heatmap: { cells: [], bestHours: [], bestDays: [] },
            topPosts: [], bottomPosts: [], hashtags: [], topics: [], domains: [],
            flags: [], sentiment: { available: false }, cadence: cadenceStats([]), momentum: { months: [] },
            findings: ['No public posts were returned for this page. Confirm the page is public and the URL points at a Page, not a personal profile or a group.']
        };
    }

    const cadence = cadenceStats(rows);
    const mo = momentum(rows);

    const totalReactions = rows.reduce((s, r) => s + (r.reactions_total || 0), 0);
    const totalComments  = rows.reduce((s, r) => s + (r.comments || 0), 0);
    const totalShares    = rows.reduce((s, r) => s + (r.shares || 0), 0);
    const totalViews     = rows.reduce((s, r) => s + (r.views || 0), 0);
    const totalEngagement = totalReactions + totalComments + totalShares;

    const audience = profile.followers || profile.likes || 0;
    const engagementRate = audience ? +((totalEngagement / posts / audience) * 100).toFixed(3) : 0;

    const conversationRate  = totalReactions ? +((totalComments / totalReactions) * 100).toFixed(2) : 0;
    const amplificationRate = totalReactions ? +((totalShares / totalReactions) * 100).toFixed(2) : 0;

    const formats  = leaderboard(rows, 'media_type');
    const intents  = leaderboard(rows, 'intent_type');
    const lengths  = leaderboard(rows, 'length_band');
    const openings = leaderboard(rows, 'opening_pattern');
    const heat     = timeHeatmap(rows);
    const sentiment = reactionSentiment(rows);

    const flags = [
        flagCompare(rows, 'has_question', 'Asks a question', 'No question'),
        flagCompare(rows, 'has_link',     'Contains a link', 'No link'),
        flagCompare(rows, 'has_cta',      'Contains a call to action', 'No call to action'),
        flagCompare(rows, 'has_offer',    'Promotional / offer', 'Not promotional'),
        flagCompare(rows, 'has_emoji',    'Uses emoji', 'No emoji')
    ];

    // Hashtags, topics, outbound domains
    const tally = (list) => {
        const agg = {};
        list.forEach(({ key, index }) => {
            agg[key] = agg[key] || { key, uses: 0, indexSum: 0 };
            agg[key].uses++; agg[key].indexSum += index || 0;
        });
        return Object.values(agg).map(a => ({ key: a.key, uses: a.uses, avgIndex: +(a.indexSum / a.uses).toFixed(2) }));
    };

    const hashtagRows = [];
    const topicRows = [];
    const domainRows = [];
    rows.forEach(r => {
        (r.hashtags || []).forEach(h => hashtagRows.push({ key: h, index: r.performance_index }));
        (r.topic_tags || []).forEach(t => topicRows.push({ key: t, index: r.performance_index }));
        if (r.link_domain) domainRows.push({ key: r.link_domain, index: r.performance_index });
    });

    const hashtags = tally(hashtagRows).sort((a, b) => b.uses - a.uses).slice(0, 25);
    const topics   = tally(topicRows).filter(t => t.uses >= 2).sort((a, b) => b.uses - a.uses).slice(0, 25);
    const domains  = tally(domainRows).sort((a, b) => b.uses - a.uses).slice(0, 12);

    const videos = rows.filter(r => r.media_type === 'video');
    const videoStats = videos.length ? {
        posts: videos.length,
        share: +((videos.length / posts) * 100).toFixed(1),
        avgViews: Math.round(videos.reduce((s, r) => s + (r.views || 0), 0) / videos.length),
        avgIndex: +(videos.reduce((s, r) => s + (r.performance_index || 0), 0) / videos.length).toFixed(2),
        viewToReactionRatio: (() => {
            const v = videos.reduce((s, r) => s + (r.views || 0), 0);
            const rx = videos.reduce((s, r) => s + (r.reactions_total || 0), 0);
            return v && rx ? +(rx / v * 100).toFixed(2) : null;
        })()
    } : null;

    const sorted = [...rows].sort((a, b) => (b.performance_index || 0) - (a.performance_index || 0));
    const slim = r => ({
        postId: r.post_id, url: r.post_url,
        excerpt: (r.content || '').slice(0, 240),
        format: r.media_type, intent: r.intent_type,
        opening: r.opening_pattern, lengthBand: r.length_band,
        reactions: r.reactions_total, comments: r.comments, shares: r.shares, views: r.views,
        index: r.performance_index, postedAt: r.posted_at,
        hour: r.hour_local, dowName: r.dow_local !== null ? DOW_NAMES[r.dow_local] : null,
        hasLink: r.has_link, hasCta: r.has_cta, hasQuestion: r.has_question,
        provisional: r.is_provisional
    });

    const scored = computePageScore({
        engagementRate,
        postsPerWeek: cadence.postsPerWeek,
        consistency: cadence.consistency,
        conversationRate,
        amplificationRate,
        completeness: completeness.score,
        momentumPct: mo.changePct,
        formatSpread: formats.length,
        sampleSize: posts
    });

    // ---- Plain-language findings, each tied to a number in this report ----
    const findings = [];
    if (formats[0]) findings.push(`${formats[0].key} posts run at ${formats[0].avgIndex}x this page's own median across ${formats[0].posts} posts — the strongest format here.`);
    if (formats.length > 1) {
        const worst = formats[formats.length - 1];
        findings.push(`${worst.key} posts run at ${worst.avgIndex}x. ${worst.avgIndex < 0.8 ? 'This audience ignores them — cut or rework them.' : 'Usable, but not the first choice.'}`);
    }
    if (intents[0]) findings.push(`Posts framed as ${String(intents[0].key).replace(/_/g, ' ')} index at ${intents[0].avgIndex}x.`);
    if (heat.bestHours[0]) findings.push(`Best posting window is ${String(heat.bestHours[0].hour).padStart(2, '0')}:00 local (${heat.bestHours[0].avgIndex}x across ${heat.bestHours[0].posts} posts)${heat.bestDays[0] ? `, strongest on ${heat.bestDays[0].dowName}` : ''}.`);
    if (lengths[0]) findings.push(`${lengths[0].key} captions index highest at ${lengths[0].avgIndex}x.`);

    const qFlag = flags.find(f => f.field === 'has_question');
    if (qFlag?.reliable && qFlag.lift != null) findings.push(`Posts that ask a question perform ${qFlag.lift > 0 ? qFlag.lift + '% better' : Math.abs(qFlag.lift) + '% worse'} than posts that do not (${qFlag.with.posts} vs ${qFlag.without.posts} posts).`);
    const lFlag = flags.find(f => f.field === 'has_link');
    if (lFlag?.reliable && lFlag.lift != null && lFlag.lift < -15) findings.push(`Posts containing an outbound link lose ${Math.abs(lFlag.lift)}% against posts without one — the classic link-suppression pattern.`);
    const cFlag = flags.find(f => f.field === 'has_cta');
    if (cFlag?.reliable && cFlag.lift != null) findings.push(`Posts with a call to action index ${cFlag.with.avgIndex}x vs ${cFlag.without.avgIndex}x without one.`);

    if (cadence.silent) findings.push(`The page has not posted for ${cadence.lastPostDaysAgo} days. Everything below describes a page that is currently dormant.`);
    if (cadence.longestGapDays > 14) findings.push(`Longest silence in the window was ${cadence.longestGapDays} days; the median gap between posts is ${cadence.medianGapDays} days.`);
    if (mo.direction) findings.push(`Month over month, average engagement is ${mo.direction}${mo.changePct != null ? ` (${mo.changePct > 0 ? '+' : ''}${mo.changePct}%)` : ''}.`);
    if (sentiment.available) findings.push(`${sentiment.highEffortShare}% of reactions are something other than a plain Like${sentiment.negativeShare > 4 ? `, and ${sentiment.negativeShare}% are angry or sad — check the comments on those posts` : ''}.`);
    if (conversationRate < 2 && totalReactions > 50) findings.push(`Only ${conversationRate} comments per 100 reactions. This audience scrolls and taps but does not talk — the posts are not asking anything of them.`);
    if (amplificationRate > 8) findings.push(`${amplificationRate} shares per 100 reactions is unusually high — this page produces content people forward, which is the cheapest reach there is.`);
    if (completeness.missing.length) findings.push(`Profile is ${completeness.score}% complete. Missing: ${completeness.missing.join(', ')}.`);
    if (videoStats && videoStats.posts >= 3) findings.push(`Video makes up ${videoStats.share}% of posts and indexes at ${videoStats.avgIndex}x${videoStats.avgViews ? `, averaging ${videoStats.avgViews.toLocaleString()} views` : ''}.`);
    if (!audience) findings.push('Follower count was not returned, so the engagement rate could not be calculated per follower. Every index figure is still valid.');

    return {
        pageId: profile.page_id,
        name: profile.name,
        url: profile.url,
        profile,
        completeness,
        postsAnalyzed: posts,
        windowDays: cadence.spanDays,
        followers: profile.followers,
        likes: profile.likes,
        verified: profile.verified,
        category: profile.category,
        rating: profile.rating,
        reviewsCount: profile.reviews_count,
        reviews: extras.reviews || null,

        totals: { reactions: totalReactions, comments: totalComments, shares: totalShares, views: totalViews, engagement: totalEngagement },
        averages: {
            reactions: Math.round(totalReactions / posts),
            comments: +(totalComments / posts).toFixed(1),
            shares: +(totalShares / posts).toFixed(1),
            views: totalViews ? Math.round(totalViews / posts) : 0,
            engagement: Math.round(totalEngagement / posts)
        },
        medians: {
            reactions: median(rows.map(r => r.reactions_total)),
            comments: median(rows.map(r => r.comments)),
            shares: median(rows.map(r => r.shares)),
            engagement: median(rows.map(r => r.engagement_raw))
        },
        engagementRate,
        conversationRate,
        amplificationRate,
        cadence,
        momentum: mo,
        sentiment,
        formats, intents, lengths, openings,
        flags,
        heatmap: heat,
        hashtags, topics, domains,
        video: videoStats,
        topPosts: sorted.slice(0, 10).map(slim),
        bottomPosts: sorted.slice(-10).reverse().map(slim),
        provisionalPosts: rows.filter(r => r.is_provisional).length,
        score: scored.score,
        grade: scored.grade,
        scoreBreakdown: scored,
        findings,
        exemplars: sorted.filter(r => (r.content || '').length > 60).slice(0, 3).map(r => ({
            text: (r.content || '').slice(0, 700), index: r.performance_index,
            format: r.media_type, intent: r.intent_type
        }))
    };
}

// ---------------------------------------------------------------------------
// HEAD TO HEAD
// One rival, every dimension, and an explicit winner per row so the client
// does not have to interpret a table of numbers.
// ---------------------------------------------------------------------------
function buildPageBenchmark(target, rival) {
    if (!rival || !rival.postsAnalyzed) return null;

    const rowsOut = [];
    const cmp = (metric, a, b, higherIsBetter = true, fmt = v => v) => {
        const aa = a == null ? null : Number(a);
        const bb = b == null ? null : Number(b);
        let winner = 'tie';
        if (aa != null && bb != null && aa !== bb) {
            winner = (higherIsBetter ? aa > bb : aa < bb) ? 'target' : 'rival';
        }
        const gapPct = (aa != null && bb != null && bb !== 0) ? +(((aa - bb) / Math.abs(bb)) * 100).toFixed(1) : null;
        rowsOut.push({ metric, target: aa == null ? null : fmt(aa), rival: bb == null ? null : fmt(bb), rawTarget: aa, rawRival: bb, winner, gapPct });
    };

    cmp('Page score',                 target.score,                 rival.score);
    cmp('Followers',                  target.followers,             rival.followers);
    cmp('Posts in window',            target.postsAnalyzed,         rival.postsAnalyzed);
    cmp('Posts per week',             target.cadence.postsPerWeek,  rival.cadence.postsPerWeek);
    cmp('Posting consistency',        target.cadence.consistency,   rival.cadence.consistency);
    cmp('Engagement rate %',          target.engagementRate,        rival.engagementRate);
    cmp('Avg reactions per post',     target.averages.reactions,    rival.averages.reactions);
    cmp('Avg comments per post',      target.averages.comments,     rival.averages.comments);
    cmp('Avg shares per post',        target.averages.shares,       rival.averages.shares);
    cmp('Comments per 100 reactions', target.conversationRate,      rival.conversationRate);
    cmp('Shares per 100 reactions',   target.amplificationRate,     rival.amplificationRate);
    cmp('Profile completeness %',     target.completeness.score,    rival.completeness.score);
    cmp('Longest silence (days)',     target.cadence.longestGapDays, rival.cadence.longestGapDays, false);
    cmp('Days since last post',       target.cadence.lastPostDaysAgo, rival.cadence.lastPostDaysAgo, false);
    if (target.sentiment.available && rival.sentiment.available) {
        cmp('Non-Like reaction share %', target.sentiment.highEffortShare, rival.sentiment.highEffortShare);
    }
    if (target.video && rival.video) {
        cmp('Video share of posts %',  target.video.share,           rival.video.share);
    }

    const wins   = rowsOut.filter(r => r.winner === 'target').length;
    const losses = rowsOut.filter(r => r.winner === 'rival').length;

    // Where the rival does something this page does not
    const formatGaps = (rival.formats || []).filter(rf => {
        const mine = (target.formats || []).find(tf => tf.key === rf.key);
        return rf.avgIndex >= 1.1 && (!mine || mine.posts < 2);
    }).map(rf => ({ format: rf.key, rivalIndex: rf.avgIndex, rivalPosts: rf.posts }));

    const intentGaps = (rival.intents || []).filter(ri => {
        const mine = (target.intents || []).find(ti => ti.key === ri.key);
        return ri.avgIndex >= 1.1 && (!mine || mine.posts < 2);
    }).map(ri => ({ intent: ri.key, rivalIndex: ri.avgIndex, rivalPosts: ri.posts }));

    const rivalHashtags = (rival.hashtags || []).filter(h =>
        !(target.hashtags || []).some(t => t.key === h.key)).slice(0, 12);

    const shareOfVoice = (() => {
        const t = target.totals.engagement, r = rival.totals.engagement;
        const sum = t + r;
        return sum ? { target: +((t / sum) * 100).toFixed(1), rival: +((r / sum) * 100).toFixed(1) } : null;
    })();

    return {
        target: { name: target.name, pageId: target.pageId, score: target.score, grade: target.grade },
        rival:  { name: rival.name,  pageId: rival.pageId,  score: rival.score,  grade: rival.grade },
        rows: rowsOut,
        wins, losses, ties: rowsOut.length - wins - losses,
        verdict: wins > losses
            ? `${target.name} leads on ${wins} of ${rowsOut.length} measures.`
            : wins < losses
                ? `${rival.name} leads on ${losses} of ${rowsOut.length} measures.`
                : 'Evenly matched across the measured dimensions.',
        shareOfVoice,
        formatGaps, intentGaps,
        rivalHashtags,
        rivalTopPosts: (rival.topPosts || []).slice(0, 5),
        biggestGaps: rowsOut.filter(r => r.winner === 'rival' && r.gapPct != null)
            .sort((a, b) => a.gapPct - b.gapPct).slice(0, 5),
        biggestLeads: rowsOut.filter(r => r.winner === 'target' && r.gapPct != null)
            .sort((a, b) => b.gapPct - a.gapPct).slice(0, 5)
    };
}

// ---------------------------------------------------------------------------
// RULE-BASED RECOMMENDATIONS
// These fire with or without Gemini, so the report is never empty.
// ---------------------------------------------------------------------------
function fbPageRecommendations(a, benchmark) {
    const recs = [];
    const push = (priority, title, why, action) => recs.push({ priority, title, why, action });

    if (!a.postsAnalyzed) return recs;

    if (a.cadence.silent) {
        push('critical', 'Restart publishing',
            `Nothing has been posted for ${a.cadence.lastPostDaysAgo} days, so reach has already decayed.`,
            'Publish three posts this week using the strongest format below before optimising anything else.');
    } else if (a.cadence.postsPerWeek < 2) {
        push('high', 'Raise cadence to at least 3 posts a week',
            `Currently ${a.cadence.postsPerWeek} posts per week, with a median gap of ${a.cadence.medianGapDays} days.`,
            'Book two fixed publishing slots a week and fill them from the winning format and intent.');
    } else if (a.cadence.postsPerWeek > 12) {
        push('medium', 'Cut volume and raise the floor',
            `${a.cadence.postsPerWeek} posts a week is diluting the average — high-volume pages usually carry a long tail of dead posts.`,
            'Drop to 5-7 stronger posts a week and reinvest the effort in the top-performing format.');
    }

    if (a.cadence.consistency != null && a.cadence.consistency < 45) {
        push('medium', 'Fix the rhythm, not just the volume',
            `Posting consistency scores ${a.cadence.consistency}/100 — bursts followed by silence.`,
            'Pick fixed days and stick to them. Even three predictable posts beat seven erratic ones.');
    }

    if (a.formats[0] && a.formats.length > 1) {
        const best = a.formats[0], worst = a.formats[a.formats.length - 1];
        if (best.avgIndex >= 1.2) {
            push('high', `Shift the mix toward ${best.key}`,
                `${best.key} indexes at ${best.avgIndex}x across ${best.posts} posts, while ${worst.key} sits at ${worst.avgIndex}x.`,
                `Move roughly half of the ${worst.key} slots to ${best.key} for the next 30 days and re-run this report.`);
        }
    }

    if (a.conversationRate < 2 && a.totals.reactions > 50) {
        push('high', 'Engineer comments deliberately',
            `${a.conversationRate} comments per 100 reactions — the audience taps but does not talk, and comments drive far more reach than reactions.`,
            'End every second post with one specific, answerable question. Reply to every comment within the hour.');
    }

    const q = (a.flags || []).find(f => f.field === 'has_question');
    if (q?.reliable && q.lift != null && q.lift > 15) {
        push('high', 'Ask more questions',
            `Posts with a question already run ${q.lift}% ahead here (${q.with.posts} posts vs ${q.without.posts}).`,
            'Make a question the default closing line unless there is a reason not to.');
    }

    const link = (a.flags || []).find(f => f.field === 'has_link');
    if (link?.reliable && link.lift != null && link.lift < -20) {
        push('medium', 'Stop putting links in the post body',
            `Link posts lose ${Math.abs(link.lift)}% against non-link posts on this page.`,
            'Put the link in the first comment or in the CTA button, and keep the post itself native.');
    }

    if (a.heatmap.bestHours[0]) {
        const h = a.heatmap.bestHours[0];
        const worst = a.heatmap.worstHours?.[0];
        push('medium', `Publish around ${String(h.hour).padStart(2, '0')}:00 local`,
            `That window indexes ${h.avgIndex}x across ${h.posts} posts${worst ? `, against ${worst.avgIndex}x at ${String(worst.hour).padStart(2, '0')}:00` : ''}.`,
            `Schedule the main post of each day for ${String(h.hour).padStart(2, '0')}:00${a.heatmap.bestDays[0] ? `, favouring ${a.heatmap.bestDays[0].dowName}` : ''}.`);
    }

    if (a.completeness.missing.length) {
        push(a.completeness.score < 60 ? 'high' : 'low', 'Complete the page profile',
            `The profile is ${a.completeness.score}% complete; missing ${a.completeness.missing.join(', ')}.`,
            'Fix these in Page Settings today — it takes minutes and it is the cheapest conversion win available.');
    }

    if (a.sentiment.available && a.sentiment.negativeShare > 5) {
        push('high', 'Investigate negative reactions',
            `${a.sentiment.negativeShare}% of reactions are angry or sad.`,
            'Open the highest-reaction posts, read the comments, and answer publicly rather than deleting.');
    }

    if (a.momentum.direction === 'falling') {
        push('high', 'Reverse the slide',
            `Average engagement is down ${Math.abs(a.momentum.changePct)}% month over month.`,
            'Compare the current month against the top posts table below and go back to what worked before the drop.');
    }

    if (benchmark) {
        // Follower count and raw post volume are outcomes, not actions — they
        // make for a useless recommendation, so they stay in the table only.
        const NOT_ACTIONABLE = ['Followers', 'Posts in window', 'Page score'];
        (benchmark.biggestGaps || [])
            .filter(g => !NOT_ACTIONABLE.includes(g.metric))
            .slice(0, 3).forEach(g => {
            push('high', `Close the gap on ${String(g.metric).toLowerCase()}`,
                `${benchmark.rival.name} leads here: ${g.rival} against your ${g.target}.`,
                'Treat this as the single measurable target for the next 30 days.');
        });
        (benchmark.formatGaps || []).slice(0, 2).forEach(g => {
            push('medium', `Test ${g.format} posts`,
                `${benchmark.rival.name} runs ${g.format} at ${g.rivalIndex}x across ${g.rivalPosts} posts and this page barely uses the format.`,
                `Run four ${g.format} posts over the next two weeks and compare.`);
        });
    }

    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    return recs.sort((x, y) => order[x.priority] - order[y.priority]);
}

// ---------------------------------------------------------------------------
// AI NARRATIVE
// ---------------------------------------------------------------------------
async function fbPageNarrative(payload) {
    if (!geminiAvailable()) {
        return { ai: null, aiStatus: { ok: false, reason: 'no_key', message: aiReasonText('no_key') } };
    }

    const { json, dropped, chars } = budgetedJson({
        target: fbPageAiSlim(payload.target),
        rival: fbPageAiSlim(payload.rival),
        benchmark: payload.benchmark || null,
        brief: payload.brief || null
    }, { maxChars: AI_PROMPT_BUDGET, keep: ['target', 'brief'] });

    const prompt =
`You are a social media strategist writing a paid client report about a Facebook business Page.
The reader is the business owner. They want to know how their Page is really doing, what to change,
and — if a rival is included — where they are being beaten.

Reply with ONLY valid JSON matching this schema:
{
 "executive_summary": "4-6 sentences a business owner understands, naming real numbers from the data",
 "state_of_the_page": ["specific observations about health, cadence and audience behaviour"],
 "what_is_working": ["concrete, each citing a number from the data"],
 "what_is_failing": ["concrete, each citing a number from the data"],
 "content_playbook": [{"format":"...","intent":"...","best_time":"...","angle":"...","why":"cites a number"}],
 "competitor_read": ["only if a rival is supplied: where the rival wins and what to copy"],
 "quick_wins": ["things that can be done this week with no budget"],
 "thirty_day_plan": [{"week":"Week 1","actions":["..."]}],
 "risks": ["anything in the data that should worry the owner"],
 "kpis_to_watch": [{"kpi":"...","current":"...","target":"..."}]
}
Ground every claim in the numbers supplied. Never invent a metric that is not in the data.
If a rival is not supplied, return an empty array for competitor_read. No markdown outside the JSON.

DATA:
${json}`;

    const r = await geminiCallDetailed(prompt, { temperature: 0.45, tag: 'Gemini FB Page' });
    logger.info('ai_narrative', { tag: 'fb_page', ok: r.ok, reason: r.reason, promptChars: chars, dropped });
    return {
        ai: r.data,
        aiStatus: {
            ok: r.ok, reason: r.reason, message: aiReasonText(r.reason),
            promptChars: chars, dropped, model: GEMINI_MODEL,
            generatedAt: new Date().toISOString()
        }
    };
}

// ---------------------------------------------------------------------------
// SCRAPE + PERSIST
// ---------------------------------------------------------------------------
async function fbScrapePageProfile(client, ref) {
    try {
        const { items } = await callActor(client, FB_PAGE_DETAILS_ACTOR, {
            startUrls: [{ url: ref.url }],
            resultsLimit: 1,
            scrapeAbout: true,
            scrapePosts: false
        }, { maxItems: 1, estimateUsd: COST_PER_FB_PAGE_PROFILE });
        return items || [];
    } catch (err) {
        if (err.code === 'NO_CREDIT') throw err;
        console.error('[fbScrapePageProfile]', ref.pageId, err.message);
        return [];
    }
}

async function fbScrapePagePosts(client, ref, opts = {}) {
    const limit = Math.min(opts.limit || FB_PAGE_DEFAULT_POSTS, FB_PAGE_MAX_POSTS);
    const days  = Math.min(opts.days || FB_PAGE_DEFAULT_DAYS, FB_PAGE_MAX_DAYS);
    const onlyPostsNewerThan = opts.since ||
        new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

    const { items } = await callActor(client, FB_PAGE_POSTS_ACTOR, {
        startUrls: [{ url: ref.url }],
        resultsLimit: limit,
        maxPosts: limit,
        onlyPostsNewerThan,
        scrapeComments: false,
        maxComments: 0
    }, {
        maxItems: limit,
        jobId: opts.jobId,
        estimateUsd: (limit / 1000) * COST_PER_1K_FB_PAGE_POSTS
    });
    return items || [];
}

async function fbScrapePageReviews(client, ref, limit = 30) {
    try {
        const { items } = await callActor(client, FB_PAGE_REVIEWS_ACTOR, {
            startUrls: [{ url: ref.url }],
            resultsLimit: limit,
            maxReviews: limit
        }, { maxItems: limit, estimateUsd: 0.02 });
        const rows = (items || []).map(r => ({
            text: String(r.text || r.review || r.comment || '').slice(0, 600),
            isPositive: r.isRecommended ?? r.recommends ?? (Number(r.rating) >= 4) ?? null,
            rating: Number(r.rating) || null,
            date: r.date || r.time || null
        })).filter(r => r.text || r.rating);

        if (!rows.length) return null;
        const positive = rows.filter(r => r.isPositive === true).length;
        const negative = rows.filter(r => r.isPositive === false).length;
        return {
            sampled: rows.length,
            positive, negative,
            positiveShare: +((positive / rows.length) * 100).toFixed(1),
            recent: rows.slice(0, 12)
        };
    } catch (err) {
        console.error('[fbScrapePageReviews]', ref.pageId, err.message);
        return null;
    }
}

async function fbUpsertPage(userId, profile) {
    const row = {
        user_id: userId,
        page_id: profile.page_id,
        username: profile.username,
        name: profile.name,
        url: profile.url,
        category: profile.category,
        categories: profile.categories || [],
        about: profile.about || null,
        likes: profile.likes || 0,
        followers: profile.followers || 0,
        verified: !!profile.verified,
        website: profile.website || null,
        email: profile.email || null,
        phone: profile.phone || null,
        address: profile.address || null,
        city: profile.city || null,
        country: profile.country || null,
        rating: profile.rating,
        reviews_count: profile.reviews_count || 0,
        price_range: profile.price_range || null,
        creation_date: profile.creation_date ? String(profile.creation_date).slice(0, 60) : null,
        profile_pic: profile.profile_pic || null,
        cover_photo: profile.cover_photo || null,
        has_hours: !!profile.has_hours,
        hours: profile.hours || null,
        cta: profile.cta ? String(profile.cta).slice(0, 120) : null,
        last_scraped_at: new Date().toISOString()
    };
    const { data, error } = await supabase.from('fb_pages')
        .upsert(row, { onConflict: 'user_id,page_id' })
        .select('id, page_id, name, url, followers, likes, page_score, last_scraped_at')
        .maybeSingle();
    if (error) console.error('[fbUpsertPage]', error.message);
    return data;
}

async function fbSavePagePosts(rows, clientId = null) {
    if (!rows.length) return 0;
    const cid = (clientId && S.UUID_RE.test(String(clientId))) ? clientId : null;   // phase 10
    let saved = 0;
    for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200).map(r => ({ ...r, client_id: cid }));
        const { error } = await supabase.from('fb_page_posts')
            .upsert(chunk, { onConflict: 'user_id,page_id,post_id' });
        if (error) console.error('[fbSavePagePosts]', error.message);
        else saved += chunk.length;
    }
    return saved;
}

function fbPageEstimateCredits(pages, postsPerPage, withReviews) {
    const posts = pages * postsPerPage;
    const reviewCost = withReviews ? pages * 0.02 : 0;
    return +(((posts / 1000) * COST_PER_1K_FB_PAGE_POSTS) + (pages * COST_PER_FB_PAGE_PROFILE) + reviewCost).toFixed(4);
}

/** One page, end to end: profile -> posts -> index -> persist -> audit. */
async function fbAuditPage(client, userId, ref, opts = {}) {
    const profileItems = await fbScrapePageProfile(client, ref);
    const profile = fbPageProfile(profileItems, ref);
    const pageRow = await fbUpsertPage(userId, profile);

    const rawPosts = await fbScrapePagePosts(client, ref, opts);
    const rows = rawPosts
        .map(item => fbPageNormalisePost(item, profile.page_id, pageRow?.id, userId))
        .filter(Boolean);

    // De-duplicate: some actors emit the same post twice across pagination.
    const seen = new Set();
    const unique = rows.filter(r => (seen.has(r.post_id) ? false : (seen.add(r.post_id), true)));

    fbPageIndexPosts(unique);
    await fbSavePagePosts(unique, opts.clientId || null);

    let reviews = null;
    if (opts.includeReviews) reviews = await fbScrapePageReviews(client, ref, 30);

    const audit = computePageAudit(profile, unique, { reviews });

    if (pageRow?.id) {
        await supabase.from('fb_pages').update({
            page_score: audit.score,
            score_breakdown: audit.scoreBreakdown,
            posts_per_week: audit.cadence?.postsPerWeek || 0,
            engagement_rate: audit.engagementRate || 0,
            last_scraped_at: new Date().toISOString()
        }).eq('id', pageRow.id);
    }

    return { audit, rows: unique, pageRow };
}

// ===========================================================================
// FB PAGE API :: ESTIMATE
// ===========================================================================

app.get('/api/fb/page/estimate-credits', async (req, res) => {
    const ctx = await auth(req, res); if (!ctx) return;
    const pages = Math.min(parseInt(req.query.pages || '1', 10), 2);
    const posts = Math.min(parseInt(req.query.posts || FB_PAGE_DEFAULT_POSTS, 10), FB_PAGE_MAX_POSTS);
    const withReviews = req.query.reviews === 'true' || req.query.reviews === '1';
    const estimatedUsd = fbPageEstimateCredits(pages, posts, withReviews);
    res.json({
        pages, postsPerPage: posts, totalPosts: pages * posts, includeReviews: withReviews,
        estimatedUsd,
        budget: await budgetSnapshot('fb_page', ctx.user.id, estimatedUsd),
        note: 'Estimate only. Actual Apify billing depends on the actor and how many posts the page actually returns.'
    });
});

// ===========================================================================
// FB PAGE API :: RUN A REPORT  (async job, poll /api/job/:id)
// ===========================================================================

// ===========================================================================
// FACEBOOK LEAD DISCOVERY  (phase 16)
//
// The Facebook half of lead generation, and it works off Pages rather than
// groups on purpose.
//
// The group pipeline destroys author identity by design — author_hash is a
// one-way HMAC and author_label holds only 'admin' or 'member' — so a group
// post proves demand exists but names nobody reachable. Making it name people
// would mean deleting a privacy control built deliberately, over private
// individuals posting in often-private groups.
//
// A Page is a business publishing its own contact button, which is the direct
// equivalent of the Instagram business profiles the existing methods already
// target. Same shape of data, same defensibility.
// ===========================================================================

/** A Page result from search, reduced to what discovery needs. */
function fbPageSearchRefs(items) {
    const out = new Map();
    for (const it of (items || [])) {
        const ref = parsePageRef(it.url || it.pageUrl || it.link || it.facebookUrl || it.id);
        if (!ref || out.has(ref.pageId)) continue;
        out.set(ref.pageId, {
            ...ref,
            hintName: it.title || it.name || it.pageName || null,
            hintCategory: it.category || it.categoryName || null
        });
    }
    return [...out.values()];
}

/**
 * A scraped Page turned into a lead row.
 *
 * username is the page's vanity where it has one and its numeric id where it
 * does not, because the unique key is (owner, platform, username) and a page
 * without a vanity still has to land somewhere stable.
 */
function fbPageToLead(profile, userId, filed = {}) {
    const handle = String(profile.username || profile.page_id || '')
        .replace(/^https?:\/\/(www\.)?facebook\.com\//i, '')
        .replace(/\/+$/, '')
        .trim()
        .toLowerCase();
    if (!handle) return null;

    return {
        owner_user_id: userId,
        platform: 'facebook',
        platform_id: profile.page_id || null,
        username: handle,
        full_name: profile.name || null,
        email: profile.email || null,
        phone: profile.phone || null,
        website: profile.website || null,
        category: profile.category || null,
        city: profile.city || null,
        address: profile.address || null,
        // Filed under the search that found it; the Page's own category and
        // city when the search said nothing. (phase 29)
        industry: filed.industry || profile.category || null,
        location: filed.location || profile.city || null,
        followers_count: profile.followers || profile.likes || null,
        bio: profile.about ? String(profile.about).slice(0, 2000) : null,
        is_business: true,
        is_verified: !!profile.verified,
        profile_url: profile.url || `https://www.facebook.com/${handle}`,
        // Enriched on arrival: unlike Instagram, one Page scrape returns the
        // profile and its contact details together, so there is no second pass.
        is_enriched: true,
        sources_detected: ['facebook_page']
    };
}

registerWorker('fb_lead_discovery', (userId, input, jobId) => async (progress, ck) => {
    const keywords = (Array.isArray(input.keywords) ? input.keywords : [])
        .map(k => String(k || '').trim()).filter(Boolean).slice(0, 4);
    const location = String(input.location || '').trim();
    const maxPages = Math.min(parseInt(input.maxPages, 10) || 20, 40);
    const warnings = [];

    if (!keywords.length) throw new Error('Give it at least one thing to search for.');

    // Each query remembers the keyword it came from, so a Page found by
    // "bridal wear Dhaka" is filed under "bridal wear". (phase 29)
    const keywordOf = new Map();
    for (const k of keywords) { if (location) keywordOf.set(`${k} ${location}`, k); keywordOf.set(k, k); }
    const queries = [...keywordOf.keys()].slice(0, 5);

    // ---- 1. find candidate pages -------------------------------------------
    const refs = new Map();
    for (let i = 0; i < queries.length; i++) {
        const q = queries[i];
        const unit = 'fbsearch:' + q;

        if (ck.isDone(unit)) {
            (ck.get(unit) || []).forEach(r => { if (!refs.has(r.pageId)) refs.set(r.pageId, r); });
            await progress(5 + Math.floor(25 * i / queries.length), `"${q}" already searched — reusing`);
            continue;
        }

        await progress(5 + Math.floor(25 * i / queries.length), `Searching Facebook for "${q}"`);
        const estimate = fbEstimateCredits(1, 25, false);
        const { client } = await getWorkingClient('leadgen', userId, { needUsd: estimate, jobId });

        try {
            const { items } = await callActor(client, FB_SEARCH_ACTOR, {
                search: q, searchType: 'pages', query: q,
                resultsLimit: 25, maxResults: 25
            }, { maxItems: 25, estimateUsd: estimate, jobId });

            const found = fbPageSearchRefs(items).map(r => ({ ...r, keyword: keywordOf.get(q) || keywords[0] || null }));
            found.forEach(r => { if (!refs.has(r.pageId)) refs.set(r.pageId, r); });
            await ck.done(unit, found);
        } catch (e) {
            if (e.code === 'NO_CREDIT' || e.code === 'CANCELLED') throw e;
            warnings.push(`Search for "${q}" failed: ${e.message}`);
            await ck.done(unit, []);
        }
    }

    if (!refs.size) {
        return { platform: 'facebook', found: 0, saved: 0, warnings: warnings.concat('No pages matched that search.') };
    }

    // ---- 2. drop the ones already on the list -------------------------------
    const candidates = [...refs.values()].slice(0, maxPages);
    const { data: existing } = await supabase.from('leads')
        .select('platform_id')
        .eq('owner_user_id', userId).eq('platform', 'facebook')
        .in('platform_id', candidates.map(c => c.pageId));
    const known = new Set((existing || []).map(e => e.platform_id));
    const fresh = candidates.filter(c => !known.has(c.pageId));

    if (!fresh.length) {
        return { platform: 'facebook', found: candidates.length, saved: 0,
                 warnings: warnings.concat('Every page found is already on your list.') };
    }

    // ---- 3. the allowance, before any of it is scraped ----------------------
    // Taken up front rather than per page: scraping forty pages and then
    // discovering there was room for five spends the difference for nothing.
    const allowed = await takeLeadQuota(userId, fresh.length);
    if (allowed <= 0) {
        return { platform: 'facebook', found: candidates.length, saved: 0,
                 warnings: warnings.concat('Lead allowance reached, so nothing new was collected.') };
    }
    if (allowed < fresh.length) {
        warnings.push(`Lead allowance reached. Collected ${allowed} of the ${fresh.length} new pages found.`);
    }

    const wanted = fresh.slice(0, allowed);
    let refunded = 0;

    // ---- 4. scrape each page, one checkpoint each ---------------------------
    const rows = [];
    for (let i = 0; i < wanted.length; i++) {
        const ref  = wanted[i];
        const unit = 'fbpage:' + ref.pageId;
        const pct  = 35 + Math.floor(55 * i / wanted.length);

        if (ck.isDone(unit)) {
            const saved = ck.get(unit);
            if (saved) rows.push(saved); else refunded += 1;
            await progress(pct, `Page ${i + 1} of ${wanted.length} already collected`);
            continue;
        }

        await progress(pct, `Reading ${ref.hintName || ref.pageId} (${i + 1} of ${wanted.length})`);

        try {
            const { client } = await getWorkingClient('leadgen', userId,
                { needUsd: COST_PER_FB_PAGE_PROFILE, jobId });
            const items = await fbScrapePageProfile(client, ref);
            const lead  = fbPageToLead(fbPageProfile(items, ref), userId,
                { industry: ref.keyword || keywords[0] || null, location: location || null });

            if (lead) { rows.push(lead); await ck.done(unit, lead); }
            else      { refunded += 1;  await ck.done(unit, null); }
        } catch (e) {
            if (e.code === 'NO_CREDIT' || e.code === 'CANCELLED') throw e;
            warnings.push(`Could not read ${ref.hintName || ref.pageId}: ${e.message}`);
            refunded += 1;
            await ck.done(unit, null);
        }
    }

    // ---- 5. save ------------------------------------------------------------
    await progress(92, `Saving ${rows.length} business(es)`);
    let saved = 0;

    // A Facebook Page found by a business search is a business: filed as one
    // on the Businesses list, scored the same way. (phase 40)
    if (await leadsPhase40()) {
        for (const r of rows) {
            r.methods = ['fb'];
            const a = leadAssessment(r, null, r.methods);
            Object.assign(r, a, { lead_kind: 'business', kind_score: -60, kind_stage: 'profile',
                kind_reasons: [{ w: -60, text: 'A Facebook business Page' }],
                ...(() => { const f = leadFit(r, null, 'business', r.methods); return { fit_score: f.score, fit_reasons: f.reasons }; })() });
        }
    }

    for (let i = 0; i < rows.length; i += 100) {
        const slice = rows.slice(i, i + 100);
        // Upsert, not insert: phase 16 added the unique key these conflict on,
        // so a re-run or an overlapping search updates rather than duplicating.
        const { error } = await supabase.from('leads')
            .upsert(slice, { onConflict: 'owner_user_id,platform,username', ignoreDuplicates: false });
        if (error) {
            warnings.push(`A batch of ${slice.length} did not save — ${error.message}`);
            logger.error('fb_lead_save_failed', { jobId, message: error.message });
            refunded += slice.length;
        } else {
            saved += slice.length;
        }
    }

    // Facebook leads carried no client at all before phase 23 — a search run
    // for a client left nothing on the row or anywhere else that said so.
    if (input.clientId && saved) {
        const names = rows.map(r => r.username).filter(Boolean);
        const { data: mine } = await supabase.from('leads').select('id')
            .eq('owner_user_id', userId).eq('platform', 'facebook').in('username', names);
        await linkLeadsToClient(input.clientId, (mine || []).map(r => r.id), 'fb_discovery', jobId);
    }

    // Allowance was taken for every page we meant to read. Anything that did
    // not become a saved lead goes back.
    if (refunded > 0) await refundLeadQuota(userId, refunded);

    await progress(100, `Saved ${saved} business(es) from Facebook`);
    return { platform: 'facebook', found: candidates.length, saved, warnings };
});

/**
 * Start a Facebook Page lead search.
 *
 * On the leadgen engine rather than fb_page: this is lead generation that
 * happens to read Pages, so it draws the leadgen key and is gated by the
 * leadgen grant — which is what a trial client already holds.
 */
app.post('/api/fb/find-leads', spendLimit, async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;
        await assertJobSlot(ctx.user.id);

        const keywords = (Array.isArray(req.body?.keywords) ? req.body.keywords : [req.body?.keywords])
            .map(k => String(k || '').trim()).filter(Boolean).slice(0, 4);
        if (!keywords.length) return res.status(400).json({ error: 'Give it at least one thing to search for.' });

        const location = String(req.body?.location || '').trim();
        const maxPages = Math.min(parseInt(req.body?.maxPages, 10) || 20, 40);

        // Search calls plus one profile read each — the same arithmetic the
        // worker will actually perform.
        const estimate = +(
            fbEstimateCredits(Math.min(keywords.length * (location ? 2 : 1), 5), 25, false) +
            maxPages * COST_PER_FB_PAGE_PROFILE
        ).toFixed(4);

        const job = await createJob(ctx.user.id, 'fb_lead_discovery', 'leadgen',
            { clientId: await S.resolveClientId(req, ctx), keywords, location, maxPages }, estimate);

        runJob(job.id, JOB_WORKERS['fb_lead_discovery'](ctx.user.id, job.input, job.id));

        res.status(202).json({ success: true, jobId: job.id, maxPages, estimatedUsd: estimate });
    } catch (err) { sendErr(res, err); }
});

app.post('/api/fb/page-report', spendLimit, async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_page'); if (!ctx) return;
        await assertJobSlot(ctx.user.id);

        const {
            target, rival, postsPerPage, days,
            includeReviews = false, setName, setId, brief
        } = req.body;

        const targetRef = parsePageRef(target);
        if (!targetRef) {
            return res.status(400).json({
                error: 'Enter a valid Facebook Page URL or handle. Group URLs are not supported here — use the Community Audit page for groups.'
            });
        }

        const rivalRef = rival ? parsePageRef(rival) : null;
        if (rival && !rivalRef) return res.status(400).json({ error: 'The rival Page URL or handle could not be read.' });
        if (rivalRef && rivalRef.pageId === targetRef.pageId) {
            return res.status(400).json({ error: 'The rival must be a different Page from the target.' });
        }

        const limit = Math.min(parseInt(postsPerPage || FB_PAGE_DEFAULT_POSTS, 10), FB_PAGE_MAX_POSTS);
        const window = Math.min(parseInt(days || FB_PAGE_DEFAULT_DAYS, 10), FB_PAGE_MAX_DAYS);
        const pageCount = rivalRef ? 2 : 1;
        const estimate = fbPageEstimateCredits(pageCount, limit, includeReviews);

        // Re-runnable pair, so the same target+rival can be tracked over time.
        let activeSetId = setId || null;
        if (!activeSetId && setName) {
            const { data: set } = await supabase.from('fb_page_sets').insert([{
                user_id: ctx.user.id,
                client_id: await S.resolveClientId(req, ctx),
                name: setName,
                target_page: targetRef.pageId,
                target_url: targetRef.url,
                rival_page: rivalRef?.pageId || null,
                rival_url: rivalRef?.url || null,
                posts_per_page: limit,
                days_window: window
            }]).select('id').maybeSingle();
            activeSetId = set?.id || null;
        }

        const since = new Date(Date.now() - window * 86400000).toISOString().slice(0, 10);

        const job = await createJob(ctx.user.id, 'fb_page_report', 'fb_page', { clientId: await S.resolveClientId(req, ctx),
            target: targetRef.url, rival: rivalRef?.url || null,
            postsPerPage: limit, days: window, includeReviews, setId: activeSetId,
            brief: brief ? String(brief).slice(0, 600) : null, since
        }, estimate);

        runJob(job.id, JOB_WORKERS['fb_page_report'](ctx.user.id, job.input, job.id));

        res.status(202).json({
            success: true,
            jobId: job.id,
            setId: activeSetId,
            target: targetRef.pageId,
            rival: rivalRef?.pageId || null,
            pages: pageCount,
            postsPerPage: limit,
            days: window,
            estimatedUsd: estimate,
            budget: await budgetSnapshot('fb_page', ctx.user.id, estimate)
        });
    } catch (err) { sendErr(res, err); }
});

// ===========================================================================
// FB PAGE API :: REPORT VAULT
// ===========================================================================

app.get('/api/fb/page-reports', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_page'); if (!ctx) return;
        let q = supabase.from('reports')
            .select('id, user_id, client_id, target_handle, competitor_handles, fb_page_ids, fb_page_names, audit_mode, grade, score, engagement_rate, posts_analyzed, snapshot_date, created_at, ai_summary, set_id, credits_estimate')
            .eq('platform', 'facebook');
        q = (await S.applyReportScope(req, ctx))(q);
        const { data, error } = await q
            .eq('report_type', 'fb_page')
            .order('created_at', { ascending: false })
            .limit(200);
        if (error) throw error;
        res.json({ reports: data || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fb/page-report/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_page'); if (!ctx) return;
        const { data } = await supabase.from('reports').select('*')
            .eq('id', req.params.id).maybeSingle();
        if (!data || !(await S.canReadReport(ctx, data))) return res.status(404).json({ error: 'Report not found' });
        res.json({ report: data });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/fb/page-report/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_page'); if (!ctx) return;
        const { error } = await supabase.from('reports')
            .delete().eq('id', req.params.id).eq('user_id', ctx.user.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===========================================================================
// FB PAGE API :: SAVED PAIRS + TREND
// ===========================================================================

app.get('/api/fb/page-sets', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_page'); if (!ctx) return;
        const { data } = await supabase.from('fb_page_sets')
            .select('*').eq('user_id', ctx.user.id).order('created_at', { ascending: false });
        res.json({ sets: data || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/fb/page-sets/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_page'); if (!ctx) return;
        const { error } = await supabase.from('fb_page_sets')
            .delete().eq('id', req.params.id).eq('user_id', ctx.user.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/** Snapshot-to-snapshot drift for one saved pair. */
app.get('/api/fb/page-trend/:setId', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_page'); if (!ctx) return;

        const { data: runs } = await supabase.from('reports')
            .select('id, snapshot_date, created_at, score, grade, engagement_rate, posts_analyzed, report_json')
            .eq('set_id', req.params.setId).eq('user_id', ctx.user.id)
            .eq('report_type', 'fb_page')
            .order('created_at', { ascending: true });

        if (!runs || !runs.length) return res.json({ runs: [], delta: null });

        const points = runs.map(r => ({
            reportId: r.id,
            date: r.snapshot_date || r.created_at?.slice(0, 10),
            score: r.score,
            grade: r.grade,
            engagementRate: r.engagement_rate,
            postsAnalyzed: r.posts_analyzed,
            followers: r.report_json?.target?.followers ?? null,
            postsPerWeek: r.report_json?.target?.cadence?.postsPerWeek ?? null,
            conversationRate: r.report_json?.target?.conversationRate ?? null,
            rivalScore: r.report_json?.rival?.score ?? null,
            wins: r.report_json?.benchmark?.wins ?? null
        }));

        let delta = null;
        if (points.length > 1) {
            const a = points[points.length - 2], b = points[points.length - 1];
            delta = {
                from: a.date, to: b.date,
                days: Math.round((new Date(b.date) - new Date(a.date)) / 86400000),
                score: (b.score || 0) - (a.score || 0),
                engagementRate: +((b.engagementRate || 0) - (a.engagementRate || 0)).toFixed(3),
                followers: (b.followers || 0) - (a.followers || 0),
                postsPerWeek: +((b.postsPerWeek || 0) - (a.postsPerWeek || 0)).toFixed(1),
                gapToRival: (b.rivalScore != null && a.rivalScore != null)
                    ? ((b.score || 0) - b.rivalScore) - ((a.score || 0) - a.rivalScore) : null
            };
        }

        res.json({ runs: points, delta });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===========================================================================
// FB PAGE API :: SAVED PAGES + POST-LEVEL DATA
// ===========================================================================

app.get('/api/fb/pages', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_page'); if (!ctx) return;
        const { data } = await supabase.from('fb_pages')
            .select('id, page_id, name, url, category, followers, likes, verified, page_score, engagement_rate, posts_per_week, last_scraped_at')
            .eq('user_id', ctx.user.id)
            .order('last_scraped_at', { ascending: false })
            .limit(200);
        res.json({ pages: data || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fb/page-posts', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_page'); if (!ctx) return;
        const pageId = String(req.query.page_id || '').trim().toLowerCase();
        if (!pageId) return res.status(400).json({ error: 'page_id required' });

        let q = supabase.from('fb_page_posts')
            .select('post_id, post_url, content, media_type, intent_type, opening_pattern, length_band, hashtags, reactions_total, reactions_breakdown, comments, shares, views, performance_index, posted_at, hour_local, dow_local, has_link, has_cta, has_question, is_provisional')
            .eq('user_id', ctx.user.id).eq('page_id', pageId);

        if (req.query.sort === 'top') q = q.order('performance_index', { ascending: false, nullsFirst: false });
        else q = q.order('posted_at', { ascending: false });

        const { data } = await q.limit(Math.min(parseInt(req.query.limit || '100', 10), 500));
        res.json({ pageId, posts: data || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
