/**
 * EDGELEAD MASTER BACKEND
 * ---------------------------------------------------------------------------
 * Express 5 + Supabase (service role) + Apify + Gemini
 *
 * Backwards compatible: every endpoint the current index.html and
 * ig-report.html call still exists and still returns the same shape.
 *
 * New in this version:
 *   - Apify key pool with automatic failover (primary-per-engine preserved)
 *   - Master admin: create users, grant per-engine access, per-user keys
 *   - Async job engine (create -> poll) for long competitor runs
 *   - Post-level storage (public.posts) so reports stop being shallow
 *   - Deep audit: content mix, hashtag intel, posting rhythm, 30d trend
 *   - Competitor benchmarking against up to 10 manually supplied handles
 *   - Gemini narrative layer (server-side only, cached into the report row)
 *
 * PHASE 4 — Instagram parity:
 *   - igNormalisePost(): derived-feature pass on every post, matching the
 *     Facebook Page engine (intent, opening, length band, flags, aspect
 *     ratio, carousel depth, audio, provisional flagging)
 *   - igIndexPosts(): each post scored against the account's own monthly
 *     median, so growth over the window does not make old posts look bad
 *   - Median-first aggregation throughout. One breakout reel no longer sets
 *     the account's engagement rate, its best posting hour or its "always use
 *     emoji" recommendation.
 *   - Reels get a 48h settle window, stills 24h. A reel scraped six hours
 *     after posting is an unfinished post, not a weak one.
 *   - Score v2: seven bounded pillars with a returned breakdown. scoreV1 is
 *     carried alongside so vault reports stay comparable.
 *   - /api/admin/cost-reality: validates the estimate constants against the
 *     settled usage ledger.
 *   - /api/admin/rotate-encryption-key: re-wraps every secret under a new key.
 *
 * FACEBOOK COMMUNITY ENGINE (engine key: 'fb_community'):
 *   - Engine 1 Discovery: rank local groups by Room Value, not member count
 *   - Engine 2 Audit: 30/60/90-day scrape, indexed against each room's own
 *     median, sliced by format / intent / time / length / opening pattern.
 *     Runs combined (one comparative report) or individual (one per room) —
 *     the user picks per run.
 *   - Engine 3 Advisor: drafts conditioned on one room's real data, with a
 *     hard-coded compliance gate for groups that ban promotion
 *   - Demand mining: buying intent extracted into a lead feed, author names
 *     hashed rather than stored
 *
 * FACEBOOK PAGE REPORT ENGINE (engine key: 'fb_page'):
 *   - Full business-Page audit: profile completeness, cadence, consistency,
 *     format mix, reaction sentiment, conversation and amplification rates,
 *     timing heatmap, copy patterns, hashtags, links, CTAs, video, momentum
 *   - Every post indexed against that Page's own monthly median, so pages of
 *     wildly different size are directly comparable
 *   - Optional head-to-head against ONE rival Page, with a per-metric winner
 *   - Page Score out of 100 with a visible pillar-by-pillar breakdown
 *   - Reports vault + re-runnable pairs for snapshot-to-snapshot drift
 * ---------------------------------------------------------------------------
 */

'use strict';
// Phase 55: the server is split into src/ by area. They load in this order; each
// registers its routes on the one app as it loads, exactly as the single file did.
const S = require('./src/shared');
require('./src/01-core');
require('./src/02-usage-and-posts');
require('./src/03-analytics');
require('./src/04-gemini');
require('./src/05-jobs-quota-mail');
require('./src/06-workers');
require('./src/07-system-and-admin');
require('./src/08-leads');
require('./src/09-instagram-reports');
require('./src/10-facebook-groups');
require('./src/11-facebook-pages');
require('./src/12-clients');
require('./src/13-tasks-and-owner-sign-in');
require('./src/14-ai-keys-and-meta');
require('./src/15-monthly-and-merge');
require('./src/16-content-plan');
require('./src/17-schedules-and-shares');
require('./src/18-agency-reports');
require('./src/19-reviews');
require('./src/20-assistant');
require('./src/21-billing');
require('./src/22-runtime');
const {
    ASSISTANT_TOOLS, CLIENT_PILLARS, CLIENT_REPORT_TITLES, DEMAND_INTENT, JOB_QUOTA_METRIC, JOB_WORKERS,
    KEY_COVERAGE, LEADGEN_JOB_TYPES, LEAD_SORTS, LOCAL_JOBS, MAIL_KEYS, MEDIA_HOST_RE, MERGE_TABLES,
    META_MONTH_METRICS, METRICS, PIPE_STAGES, QUOTA_FALLBACK, RECENT_EVENTS, REPORT_PAGE, SCHEDULABLE_TYPES,
    TRIAL_ENGINES, accountDenial, accountState, aiPostCard, aiReasonText, app, assistantAnswer,
    assistantDeclarations, assistantScope, assistantSystemPrompt, auth, bucketCaption, budgetedJson,
    buildBenchmark, categorize, ciDoc, classifyIntent, classifyKeyError, classifyLead, classifyTaggedPost,
    cleanGeminiKey, cleanMonthlyAi, cleanPaymentOption, cleanScheduleBody, clientAccess, clientDemandView,
    clientPillars, clientPlanIdeas, clientRemaining, clientReportView, clientRooms, clientStanding,
    comparableBand, competitorQueries, computePageScore, computeRoomValue, contactSettings,
    contentPlanMonth, cpBand, cpBoostCall, cpFeature, cpParseSlot, cpScheduleDates, cpScore, createJob,
    csBaseTopics, csBusiness, csImportRows, csPageText, csParseCsv, csRank, csSiteLinks, csToolsFor, csType,
    csvCell, cycleMonth, dayStr, decryptSecret, dedupeLeads, domainOf, encryptSecret, ensureProfile,
    estimateCredits, extractBioContacts, fbDoc, fbEstimateCredits, fbGroupAiSlim, fbGroupsDoc, fbMediaType,
    fbPageAiSlim, fbPageEstimateCredits, fbPageSearchRefs, fbPageToLead, fbReactions, geminiCallDetailed,
    geminiCandidates, geminiProbeKey, geminiRank, geminiReportKey, getPlays, getVideoViews,
    gracefulShutdown, graphInsights, growthForConnections, growthFrom, igAiPayload, igAiSlim,
    igDistribution, igDoc, igHandleFromUrl, igNormalisePost, igPlaceUrls, invalidateAuth,
    invalidateEngineAccess, isEncrypted, keepAuditImages, keepAwakeIfBusy, keyPoolSummary, leadAssessment,
    leadFilters, leadFit, leadPostSignal, leadScope, leadSignalsAdd, leadSignalsMerge, leaderboard,
    leadgenUnits, lengthBand, linkLeadsToClient, localParts, logger, mailSettings, maskSecret, median,
    metaDailySync, metaDailyTick, metaDefaultMonth, metaDeleteUserData, metaForget, metaMonthLabel,
    metaMonthWindow, metaParseSignedRequest, metaPrevMonth, migrateSecretsAtRest, mineDemand, monthChange,
    monthPlatforms, monthRecs, monthStatus, monthTrends, monthlyContext, monthlyView,
    normaliseReactionBreakdown, openingPattern, ordinal, ownClientFor, parseGroupRef, parsePageRef,
    parseRules, pctDelta, preflight, primaryKeyName, profileCompleteness, publicMonthData, publicMonthlyDoc,
    quotaError, quotaPeriod, reportDoc, resolveClientId, reviewAggregate, reviewDoc, reviewEstimate,
    reviewNameMatch, reviewPlace, reviewPrivateIp, ruleRecommendations, safePublicFetch,
    scheduleInputForRun, scheduleNextRun, scheduleSummary, schemaProbe, sendMail, shareToken, shareUrlFor,
    shiftDay, start, storeMediaImage, sweepStaleJobs, sweepStaleReservations, timeHeatmap, tokenHash,
    topicTags, urgencyOf, userRole, withFinders, xpApifyRun
} = S;

if (require.main === module) {
    start().then(server => {
        ['SIGTERM', 'SIGINT'].forEach(sig =>
            process.on(sig, () => gracefulShutdown(sig, server)));
    });
}

// Exported so the test suite can exercise the pure logic without booting a
// server or touching Supabase. Nothing here changes runtime behaviour.
// Every route above is registered. From here an uncaught exception is a
// runtime fault to log and survive, not a boot failure to die on.

S.BOOTED = true;

module.exports = {
    jobStillAllowed: S.jobStillAllowed,   // phase 57
    app, start, JOB_WORKERS, __geminiTest: (prompt, userId) => geminiCallDetailed(prompt, { userId, tag: 'test' }), cpFeature, cpScore, cpBand, geminiRank, graphInsights, clientAccess,
    // secrets
    encryptSecret, decryptSecret, isEncrypted, maskSecret, tokenHash,
    // budget + keys
    classifyKeyError, cycleMonth, clientRemaining, estimateCredits, fbEstimateCredits,
    fbPageEstimateCredits, primaryKeyName, buildBenchmark, ruleRecommendations,
    leadgenUnits,
    // analysis helpers
    median, computeRoomValue, bucketCaption, lengthBand, openingPattern, topicTags,
    categorize, urgencyOf, classifyIntent, mineDemand, parseGroupRef, parsePageRef,
    parseRules, localParts, domainOf, fbReactions, fbMediaType, normaliseReactionBreakdown,
    computePageScore, profileCompleteness, timeHeatmap, leaderboard,
    // ai layer
    budgetedJson, igAiPayload, igAiSlim, fbPageAiSlim, fbGroupAiSlim, aiPostCard, aiReasonText,
    // observability
    METRICS, RECENT_EVENTS, logger, preflight, schemaProbe, migrateSecretsAtRest,
    sweepStaleJobs, sweepStaleReservations, keepAwakeIfBusy,
    // caches
    invalidateAuth, invalidateEngineAccess, LOCAL_JOBS,
    // phase 11
    scheduleNextRun, scheduleInputForRun, cleanScheduleBody, scheduleSummary, SCHEDULABLE_TYPES,
    shareToken, shareUrlFor, REPORT_PAGE,
    extractBioContacts, getPlays, getVideoViews, igPlaceUrls, igDistribution, igNormalisePost,
    // phase 13
    accountState, accountDenial, quotaPeriod, JOB_QUOTA_METRIC, LEADGEN_JOB_TYPES,
    QUOTA_FALLBACK, TRIAL_ENGINES, quotaError,
    // phase 14
    clientReportView, clientStanding, clientPillars, ordinal, CLIENT_PILLARS,
    clientPlanIdeas, clientRooms,
    // phase 15
    ASSISTANT_TOOLS, assistantDeclarations, assistantSystemPrompt,
    // phase 16
    fbPageToLead, fbPageSearchRefs,
    // phase 14 (client surface, extended)
    clientDemandView, DEMAND_INTENT,
    // phase 17
    cpBoostCall,
    // phase 19
    metaMonthWindow, metaPrevMonth, metaDefaultMonth, metaMonthLabel, pctDelta,
    META_MONTH_METRICS, comparableBand, competitorQueries,
    // phase 20
    csvCell, LEAD_SORTS,
    // phase 22 — reached directly by the use-case test, which drives real
    // handlers over an in-memory database instead of trusting that they wire
    resolveClientId, ownClientFor, createJob, ensureProfile, userRole,
    // phase 23
    linkLeadsToClient, dedupeLeads, MERGE_TABLES,
    // phase 24
    metaParseSignedRequest, metaDeleteUserData,
    // phase 26
    auth,
    // phase 27
    contactSettings, cleanPaymentOption,
    sendMail, mailSettings, MAIL_KEYS, leadScope, leadFilters, withFinders,
    metaDailySync, metaDailyTick, growthFrom, growthForConnections, shiftDay, dayStr,
    // phase 34
    monthlyView, monthlyContext, monthRecs, cleanMonthlyAi, monthChange, monthStatus, CLIENT_REPORT_TITLES,
    // phase 35
    assistantScope, assistantAnswer,
    // phase 36
    cpScheduleDates, cpParseSlot, contentPlanMonth,
    KEY_COVERAGE, cleanGeminiKey, geminiProbeKey, keyPoolSummary, geminiCandidates, geminiReportKey, geminiCallDetailed, metaForget, metaDeleteUserData, xpApifyRun,
    csType, csParseCsv, csImportRows, csRank, csToolsFor, csPageText, csSiteLinks, csBaseTopics, csBusiness,
    classifyTaggedPost, reviewAggregate, reviewPlace, igHandleFromUrl, reviewNameMatch, reviewDoc, safePublicFetch, reviewPrivateIp, reviewEstimate,
    __setReviewLookup: fn => { S._reviewLookup = fn; },
    classifyLead, leadFit, leadPostSignal, leadSignalsAdd, leadSignalsMerge, leadAssessment, PIPE_STAGES,
    reportDoc, igDoc, ciDoc, fbDoc, fbGroupsDoc, publicMonthlyDoc, publicMonthData, monthPlatforms, monthTrends, keepAuditImages, storeMediaImage, MEDIA_HOST_RE
};
