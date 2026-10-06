/**
 * The usage ledger, post persistence and saving reports.
 *
 * Part of the EdgeLead server, split out of server.js (phase 55). The parts load in
 * order from server.js and share one namespace, S: what this part needs from an earlier
 * part is unpacked below; anything else from another part is read as S.name when it runs.
 */
'use strict';
const S = require('./shared');
const {
    APIFY_CYCLE_CREDIT, APIFY_MEMORY_MB, APIFY_PROXY_GROUP, APIFY_TIMEOUT_SECS, BUDGET_MODE, BUDGET_RESERVE,
    IG_COMMENT_WEIGHT, IG_MIN_CONFIDENT_POSTS, IG_PROVISIONAL_HOURS, IG_REEL_PROVISIONAL_HOURS,
    IG_TZ_OFFSET_MINS, IG_URL_RE, LEADGEN_RESULTS_LIMIT, LEADGEN_UNIT_USD, METRICS, NoCreditError,
    RUN_COST_ALERT_USD, alertOnce, cycleMonth, extractPosts, getPlays, getViews, logger, postTypeOf,
    shortcodeOf, supabase, tagsOf, tsOf
} = S;
Object.assign(S, {
    cycleUsage, clientRemaining, callActor, runActor, igTaggedUsers, igIsSponsored, igNormalisePost,
    igIndexPosts, igDistribution, igAggIndex, igLeaderboard, igFlagCompare, igHeatmap, igCadence,
    igMomentum, igProfileCompleteness, igComputeScore, igExtras, igDataQuality, savePosts
});

// ===========================================================================
// USAGE LEDGER
// Every actor run reports what it actually cost. Recording that is what turns
// key rotation from reactive (wait for a failure) into predictive (know the
// budget before spending it).
// ===========================================================================

/**
 * Total USD committed by one key in the current billing cycle: settled spend
 * plus anything currently reserved by a run in flight.
 *
 * Summed in Postgres via el_cycle_spend() rather than pulled row by row, so a
 * key with thousands of runs behind it does not drag the hot path. The RPC is
 * optional — if the migration has not been applied yet this falls back to the
 * old client-side sum, so deploying the server before the SQL degrades rather
 * than breaks.
 */
let _rpcSpendAvailable = true;
async function cycleUsage(hash, month = cycleMonth()) {
    if (!hash) return 0;

    if (_rpcSpendAvailable) {
        try {
            const { data, error } = await supabase.rpc('el_cycle_spend', {
                p_token_hash: hash, p_cycle_month: month
            });
            if (!error) return Number(data || 0);
            _rpcSpendAvailable = false;
            logger.warn('rpc_cycle_spend_unavailable', { message: error.message });
        } catch (e) {
            _rpcSpendAvailable = false;
            logger.warn('rpc_cycle_spend_unavailable', { message: e.message });
        }
    }

    try {
        const { data } = await supabase
            .from('apify_usage_events')
            .select('usage_usd')
            .eq('token_hash', hash)
            .eq('cycle_month', month);
        return (data || []).reduce((sum, r) => sum + Number(r.usage_usd || 0), 0);
    } catch (e) {
        logger.error('cycle_usage_failed', { message: e.message });
        alertOnce('ledger_unreadable',
            'The usage ledger is unreadable, so cycle spend cannot be checked.',
            { message: e.message });
        // Failing open here would silently disable every budget gate in the
        // app: each key reads as having spent nothing and every affordability
        // check passes. That is acceptable when the operator asked only to
        // track spend. It is the opposite of what BUDGET_MODE=block was set
        // for, so in that mode nothing starts until the ledger is readable.
        if (BUDGET_MODE === 'block') {
            throw new Error('Spend cannot be verified right now, so nothing will be started. Try again shortly.');
        }
        return 0;
    }
}

/**
 * Claim budget BEFORE the actor starts.
 *
 * A reservation is a normal ledger row carrying the estimate, flagged
 * is_reservation. Because cycleUsage() sums reservations too, two runs on the
 * same key — in the same process or in two Render instances — can no longer
 * both pass the budget gate and then discover the overspend afterwards. The
 * row is settled with the real cost the moment the run returns, and deleted if
 * the run never happened.
 *
 * Returns a reservation id, or null when reservations are unavailable (the
 * column does not exist yet). A null reservation degrades to exactly the old
 * record-after-the-fact behaviour rather than blocking the run.
 */
async function reserveUsage(client, { actorId, estimateUsd = 0, jobId = null }) {
    const el = client?.__el;
    if (!el || !(estimateUsd > 0)) return null;
    try {
        const { data, error } = await supabase.from('apify_usage_events').insert([{
            user_id:        el.userId || null,
            key_id:         el.keyId || null,
            token_hash:     el.tokenHash,
            apify_username: el.apifyUsername || null,
            engine:         el.engine || null,
            job_id:         jobId || el.jobId || null,
            actor_id:       actorId,
            usage_usd:      +Number(estimateUsd).toFixed(6),
            items:          0,
            is_reservation: true,
            cycle_month:    cycleMonth()
        }]).select('id').single();
        if (error) throw error;
        el.spentThisCycle = Number(el.spentThisCycle || 0) + Number(estimateUsd);
        el.remaining = +(el.creditUsd - el.spentThisCycle).toFixed(4);
        return data.id;
    } catch (e) {
        logger.warn('reserve_failed', { actorId, message: e.message });
        return null;
    }
}

/** Release a reservation for a run that never billed anything. */
async function releaseUsage(client, reservationId, estimateUsd = 0) {
    if (!reservationId) return;
    try { await supabase.from('apify_usage_events').delete().eq('id', reservationId); }
    catch (e) { logger.warn('release_failed', { message: e.message }); }
    const el = client?.__el;
    if (el) {
        el.spentThisCycle = Math.max(0, Number(el.spentThisCycle || 0) - Number(estimateUsd || 0));
        el.remaining = +(el.creditUsd - el.spentThisCycle).toFixed(4);
    }
}

/**
 * Turn a reservation into a settled row carrying the real usageTotalUsd, or
 * write a fresh row when nothing was reserved.
 */
async function recordUsage(client, { actorId, run, items = 0, jobId = null, reservationId = null, reservedUsd = 0, floorUsd = 0 }) {
    const el = client?.__el;
    if (!el) return 0;

    const reported =
        Number(run?.usageTotalUsd) ||
        Number(run?.usage?.USD) ||
        0;

    // floorUsd is set when the run had not settled at read time, so `reported`
    // is a partial figure. Charging the estimate instead of the partial keeps
    // the budget honest; the real number lands in Apify's own ledger either way.
    const usd = Math.max(reported, Number(floorUsd) || 0);

    const row = {
        user_id:        el.userId || null,
        key_id:         el.keyId || null,
        token_hash:     el.tokenHash,
        apify_username: el.apifyUsername || null,
        engine:         el.engine || null,
        job_id:         jobId || el.jobId || null,
        actor_id:       actorId,
        run_id:         run?.id || null,
        usage_usd:      usd,
        compute_units:  Number(run?.stats?.computeUnits) || null,
        items,
        cycle_month:    cycleMonth()
    };

    try {
        if (reservationId) {
            await supabase.from('apify_usage_events')
                .update({ ...row, is_reservation: false }).eq('id', reservationId);
            // The estimate was already counted against the cycle. Swap it for
            // the real number rather than adding on top of it.
            el.spentThisCycle = Math.max(0, Number(el.spentThisCycle || 0) - Number(reservedUsd || 0) + usd);
        } else {
            await supabase.from('apify_usage_events').insert([row]);
            el.spentThisCycle = Number(el.spentThisCycle || 0) + usd;
        }
    } catch (e) {
        logger.error('record_usage_failed', { actorId, message: e.message });
    }

    el.remaining = +(el.creditUsd - el.spentThisCycle).toFixed(4);
    return usd;
}

/** Remaining cycle budget for the key currently bound to this client. */
function clientRemaining(client) {
    const el = client?.__el;
    if (!el) return Infinity;
    const credit = Number(el.creditUsd) > 0 ? Number(el.creditUsd) : APIFY_CYCLE_CREDIT;
    return credit - Number(el.spentThisCycle || 0) - BUDGET_RESERVE;
}

/**
 * Single entry point for every Apify actor run.
 *
 *   - pins memory (compute units are RAM x hours, so this is a cost lever)
 *   - pins a wall-clock timeout so a stuck run cannot burn credit forever
 *   - optionally forces a cheaper proxy group
 *   - records real spend to the ledger
 *   - refuses to start when the bound key cannot afford the estimate
 */
async function callActor(client, actorId, input, opts = {}) {
    const estimate = Number(opts.estimateUsd || 0);

    if (BUDGET_MODE === 'block' && estimate > 0 && clientRemaining(client) < estimate) {
        throw new NoCreditError(
            `Key ${client?.__el?.apifyUsername || ''} has about ` +
            `$${Math.max(0, clientRemaining(client)).toFixed(2)} left this cycle, ` +
            `this step needs about $${estimate.toFixed(2)}.`
        );
    }

    const payload = { ...input };
    if (APIFY_PROXY_GROUP && !payload.proxyConfiguration) {
        payload.proxyConfiguration = {
            useApifyProxy: true,
            apifyProxyGroups: [APIFY_PROXY_GROUP]
        };
    }

    const runOpts = {
        memory:  opts.memoryMb   || APIFY_MEMORY_MB,
        timeout: opts.timeoutSecs || APIFY_TIMEOUT_SECS
    };
    if (opts.waitSecs) runOpts.waitSecs = opts.waitSecs;
    if (opts.maxItems) runOpts.maxItems = opts.maxItems;

    // Claim the estimate up front so a second run on the same key cannot slip
    // through the gate while this one is still in flight.
    const reservationId = await reserveUsage(client, {
        actorId, estimateUsd: estimate, jobId: opts.jobId
    });

    const t0 = Date.now();
    let run;
    try {
        run = await client.actor(actorId).call(payload, runOpts);
    } catch (err) {
        // Older apify-client builds validate run options strictly. If the
        // options are what it rejected, fall back to a bare call rather than
        // failing the whole job.
        const m = (err.message || '').toLowerCase();
        const optionsRejected = m.includes('expected property') || m.includes('did not match') || m.includes('validation');

        if (!optionsRejected) {
            METRICS.apify.failures += 1;
            logger.error('actor_failed', {
                actorId, jobId: opts.jobId || null,
                key: client?.__el?.apifyUsername || null,
                ms: Date.now() - t0, message: err.message
            });
        }

        if (optionsRejected) {
            logger.warn('actor_options_rejected', { actorId, message: err.message });
            try {
                run = await client.actor(actorId).call(payload);
            } catch (err2) {
                await releaseUsage(client, reservationId, estimate);
                throw err2;
            }
        } else {
            // Nothing ran, so nothing is owed. Hand the credit straight back.
            await releaseUsage(client, reservationId, estimate);
            throw err;
        }
    }

    let rows;
    try {
        const { items } = await client.dataset(run.defaultDatasetId).listItems();
        rows = items || [];
    } catch (err) {
        // The run happened and will be billed even though the dataset read
        // failed, so the reservation is settled rather than released.
        await recordUsage(client, { actorId, run, items: 0, jobId: opts.jobId, reservationId, reservedUsd: estimate });
        throw err;
    }

    // An unfinished run under-reports both ways: the dataset is only partly
    // written, and run.usageTotalUsd is the spend so far rather than the spend
    // this run will end up billing. Settling the reservation at that number
    // understates the cycle and lets the next call through a gate it should
    // have failed. Keep the larger of the two.
    const runStatus = String(run?.status || '').toUpperCase();
    const finished = ['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT', 'TIMED_OUT'].includes(runStatus);
    if (!finished) {
        METRICS.apify.unfinished = (METRICS.apify.unfinished || 0) + 1;
        logger.warn('actor_run_unfinished', {
            actorId, runId: run?.id || null, status: runStatus || 'unknown',
            items: rows.length, jobId: opts.jobId || null,
            note: 'dataset read before the run settled — results and cost are both partial'
        });
        alertOnce('unfinished_run:' + actorId,
            `Apify actor ${actorId} was read while still ${runStatus || 'running'}. ` +
            `Results are partial and the recorded cost is a floor, not the final bill.`,
            { actorId, runId: run?.id || null });
    }

    const usd = await recordUsage(client, {
        actorId, run, items: rows.length, jobId: opts.jobId,
        reservationId, reservedUsd: estimate,
        floorUsd: finished ? 0 : estimate
    });

    METRICS.apify.runs  += 1;
    METRICS.apify.usd   += usd;
    METRICS.apify.items += rows.length;

    logger.info('actor_run', {
        actorId,
        items: rows.length,
        usd: +usd.toFixed(4),
        estimateUsd: estimate ? +estimate.toFixed(4) : 0,
        ms: Date.now() - t0,
        runId: run?.id || null,
        jobId: opts.jobId || null,
        key: client?.__el?.apifyUsername || 'unknown',
        remaining: +Math.max(0, clientRemaining(client)).toFixed(4)
    });

    // A single run costing more than the alert threshold is either a runaway
    // actor or a wrong cost constant. Both are worth knowing about the same day
    // rather than at the end of the month.
    if (usd > RUN_COST_ALERT_USD) {
        alertOnce('expensive_run:' + actorId,
            `One Apify run cost $${usd.toFixed(2)} (threshold $${RUN_COST_ALERT_USD.toFixed(2)})`,
            { actorId, items: rows.length, runId: run?.id || null, key: client?.__el?.apifyUsername });
    }
    // Paying for zero rows is the signature of an actor whose input shape or
    // name changed under us. It used to be completely silent.
    if (rows.length === 0) {
        METRICS.apify.emptyRuns += 1;
        alertOnce('empty_run:' + actorId,
            `Apify actor ${actorId} returned 0 items but charged $${usd.toFixed(4)}. Check the actor id and input shape.`,
            { actorId, runId: run?.id || null });
    }
    // Estimates drive every budget decision. If reality drifts far from the
    // estimate the constants in env are wrong, not the code.
    if (estimate > 0 && usd > estimate * 2 && usd > 0.05) {
        logger.warn('cost_estimate_drift', { actorId, estimateUsd: +estimate.toFixed(4), actualUsd: +usd.toFixed(4) });
        alertOnce('estimate_drift:' + actorId,
            `Apify run cost $${usd.toFixed(3)} against an estimate of $${estimate.toFixed(3)}. The COST_PER_1K_* constants need correcting.`,
            { actorId });
    }

    return { run, items: rows, usd };
}

async function runActor(actorId, input, warningsArray, methodName, client, opts = {}) {
    try {
        logger.info('leadgen_actor', { actorId, method: methodName });
        // An estimate is not optional. Without one callActor skips the budget
        // gate, takes no reservation and can never raise NO_CREDIT — which is
        // why the leadgen engine was the only engine that could overspend a
        // key silently.
        const { items } = await callActor(client, actorId, input, {
            estimateUsd: opts.estimateUsd ?? LEADGEN_UNIT_USD,
            maxItems:    opts.maxItems    ?? LEADGEN_RESULTS_LIMIT,
            jobId:       opts.jobId || null
        });
        const extracted = extractPosts(items || []);
        if (warningsArray) warningsArray.push(`X-RAY (${methodName}): Extracted ${extracted.length} real posts.`);
        return extracted;
    } catch (err) {
        if (err.code === 'NO_CREDIT') throw err;      // must bubble up to pause the job
        console.error(`[Apify ERROR] ${actorId}:`, err.message);
        if (warningsArray) warningsArray.push(`Error (${methodName}): ${err.message}`);
        return [];
    }
}

// ===========================================================================
// POST PERSISTENCE
// ===========================================================================

// ---------------------------------------------------------------------------
// FIELD EXTRACTION
// Everything below reads fields the instagram-scraper actor already returns
// and savePosts() was dropping on the floor. Each accessor tries the several
// spellings the actor has shipped over the years and returns null rather than
// guessing, so a schema drift shows up as a missing field in dataQuality
// instead of a plausible-looking wrong number.
// ---------------------------------------------------------------------------

function igCarouselCount(p) {
    if (Array.isArray(p.childPosts)) return p.childPosts.length;
    if (Array.isArray(p.sidecarChildren)) return p.sidecarChildren.length;
    if (Array.isArray(p.edge_sidecar_to_children?.edges)) return p.edge_sidecar_to_children.edges.length;
    return null;
}

function igTaggedUsers(p) {
    const src = p.taggedUsers || p.usertags || p.tagged_users || [];
    if (!Array.isArray(src)) return [];
    return Array.from(new Set(src
        .map(u => (typeof u === 'string' ? u : (u.username || u.user?.username || null)))
        .filter(Boolean)
        .map(s => String(s).toLowerCase())))
        .slice(0, 30);
}

function igAltText(p) {
    return p.alt || p.altText || p.accessibilityCaption || p.accessibility_caption || null;
}

/**
 * Aspect ratio, bucketed.
 *
 * This is not cosmetic. 4:5 occupies roughly 25% more vertical feed space
 * than 1:1 and materially more than 16:9, and feed real estate is the single
 * cheapest engagement lever an account has. An account shipping everything at
 * 1:1 is giving away impressions for free and no other metric in the report
 * would ever surface it.
 */
function igDimensions(p) {
    const w = p.dimensionsWidth ?? p.dimensions?.width ?? p.imageWidth ?? null;
    const h = p.dimensionsHeight ?? p.dimensions?.height ?? p.imageHeight ?? null;
    if (!w || !h) return { width: null, height: null, aspect: null };

    const r = w / h;
    const aspect =
        Math.abs(r - 0.8)   < 0.06 ? '4:5'  :
        Math.abs(r - 1)     < 0.06 ? '1:1'  :
        Math.abs(r - 0.5625)< 0.06 ? '9:16' :
        Math.abs(r - 1.777) < 0.12 ? '16:9' :
        r < 0.8  ? 'tall'   :
        r > 1.2  ? 'wide'   : 'other';

    return { width: w, height: h, aspect };
}

function igIsSponsored(p) {
    return !!(p.isSponsored || p.is_paid_partnership || p.paidPartnership ||
              (Array.isArray(p.sponsorTags) && p.sponsorTags.length) ||
              (Array.isArray(p.coauthorProducers) && p.coauthorProducers.some(c => c?.is_paid_partnership)));
}

function igAudio(p) {
    const m = p.musicInfo || p.music_info || p.audio || null;
    if (!m) return null;
    return {
        title:  m.song_name || m.title || m.audio_title || null,
        artist: m.artist_name || m.artist || null,
        original: m.uses_original_audio ?? m.isOriginalAudio ?? null,
        audioId: m.audio_id || m.id || null
    };
}

function igFirstComment(p) {
    if (typeof p.firstComment === 'string') return p.firstComment;
    if (p.firstComment?.text) return p.firstComment.text;
    const lc = Array.isArray(p.latestComments) ? p.latestComments : [];
    return lc[0]?.text || null;
}

function igCommentsDisabled(p) {
    return p.isCommentsDisabled ?? p.commentsDisabled ?? p.comments_disabled ?? null;
}


// ---------------------------------------------------------------------------
// NORMALISATION
// One post in, one fully-derived row out. This is the IG counterpart of
// fbPageNormalisePost() and it is deliberately the only place that reads the
// raw actor item, so there is exactly one thing to fix when Apify renames a
// field.
// ---------------------------------------------------------------------------
function igNormalisePost(item, handle, userId = null, meta = {}) {
    const sc = shortcodeOf(item);
    if (!sc) return null;

    const caption  = item.caption || item.text || '';
    const d        = tsOf(item);
    const type     = postTypeOf(item);
    const likes    = item.likesCount || 0;
    const comments = item.commentsCount || 0;
    const views    = getViews(item);
    const plays    = getPlays(item);           // phase 11: kept apart from views
    const words    = caption ? caption.split(/\s+/).filter(Boolean).length : 0;

    const { hour, dow } = S.localParts(d, IG_TZ_OFFSET_MINS);
    const dims = igDimensions(item);

    const ageHours = d ? (Date.now() - d.getTime()) / 3600000 : 9999;
    const settleWindow = (type === 'Reel' || type === 'Video')
        ? IG_REEL_PROVISIONAL_HOURS
        : IG_PROVISIONAL_HOURS;

    const hashtags = tagsOf(caption, '#').slice(0, 40);
    const mentions = tagsOf(caption, '@').slice(0, 40);

    return {
        // --- identity -------------------------------------------------------
        user_id: userId,
        platform: 'instagram',
        handle: (handle || item.ownerUsername || '').toLowerCase(),
        shortcode: sc,
        post_url: item.url || `https://www.instagram.com/p/${sc}/`,
        post_type: type,

        // --- content --------------------------------------------------------
        caption: caption.slice(0, 4000),
        caption_length: caption.length,
        word_count: words,
        hashtags,
        mentions,
        hashtag_count: hashtags.length,
        mention_count: mentions.length,

        // --- metrics --------------------------------------------------------
        likes,
        comments,
        views,
        plays,
        is_video: !!(item.isVideo || item.videoUrl),
        video_duration: item.videoDuration || item.duration || null,
        thumbnail_url: item.displayUrl || item.thumbnailUrl || null,
        media_url: item.videoUrl || item.displayUrl || null,
        location_name: item.locationName || item.location?.name || null,
        posted_at: d ? d.toISOString() : null,

        // --- fields the actor returned and savePosts() used to discard ------
        carousel_count: igCarouselCount(item),
        tagged_users: igTaggedUsers(item),
        alt_text: igAltText(item),
        media_width: dims.width,
        media_height: dims.height,
        aspect_ratio: dims.aspect,
        is_sponsored: igIsSponsored(item),
        audio: igAudio(item),
        comments_disabled: igCommentsDisabled(item),
        first_comment: (igFirstComment(item) || '').slice(0, 1000) || null,

        // --- derived features ----------------------------------------------
        // Comments are weighted because they cost the viewer far more than a
        // like and correlate much harder with reach. Same reasoning as
        // FB_COMMENT_WEIGHT, different constant because the ratios differ.
        engagement_raw: likes + (IG_COMMENT_WEIGHT * comments),
        performance_index: null,        // filled by igIndexPosts()
        hour_local: hour,
        dow_local: dow,
        length_band: S.lengthBand(words),
        opening_pattern: S.openingPattern(caption),
        topic_tags: S.topicTags(caption),
        has_link: IG_URL_RE.test(caption),
        has_question: S.FB_QUESTION_RE.test(caption),
        has_cta: S.FB_CTA_RE.test(caption),
        has_offer: S.FB_OFFER_RE.test(caption),
        has_emoji: S.FB_EMOJI_RE.test(caption),
        has_alt_text: !!igAltText(item),
        is_carousel: (igCarouselCount(item) || 0) > 1,
        is_provisional: ageHours < settleWindow,
        age_hours: Math.round(ageHours),

        // --- bookkeeping ----------------------------------------------------
        report_id: meta.reportId || null,
        set_id: meta.setId || null,
        scraped_at: new Date().toISOString(),

        // The diagnostic the FB path has had all along and the IG path did
        // not. Costs one line and one small jsonb column, and answers "which
        // fields does this actor version actually return" from production
        // data instead of from a guess.
        raw: { keys: Object.keys(item || {}).slice(0, 60) }
    };
}

/**
 * Index every post against the account's own median for its calendar month.
 *
 * Identical reasoning to fbPageIndexPosts(): an account that tripled its
 * following over the scrape window would otherwise have every older post
 * scored as a failure. Provisional posts are excluded from the baseline
 * where there are enough settled posts to build one without them — they are
 * still indexed, they just do not get to drag the baseline down.
 */
function igIndexPosts(rows) {
    const buckets = {};
    rows.forEach(r => {
        const month = (r.posted_at || '').slice(0, 7) || 'unknown';
        const k = `${r.handle}::${month}`;
        (buckets[k] = buckets[k] || []).push(r);
    });

    const baselines = {};
    Object.entries(buckets).forEach(([key, group]) => {
        const settled = group.filter(r => !r.is_provisional);
        const pool = settled.length >= 4 ? settled : group;
        const med = S.median(pool.map(r => r.engagement_raw));
        baselines[key] = med > 0 ? med : 1;
    });

    rows.forEach(r => {
        const month = (r.posted_at || '').slice(0, 7) || 'unknown';
        r.performance_index = +(r.engagement_raw / (baselines[`${r.handle}::${month}`] || 1)).toFixed(3);
    });

    return { rows, baselines, months: Object.keys(baselines).length };
}


// ---------------------------------------------------------------------------
// DISTRIBUTION STATS
// The whole reason this exists: computeAudit() averaged everything, and on
// Instagram one reel that broke containment moves the mean by a multiple
// while moving the median by almost nothing. Reporting both is the only
// honest way to show an account whether its typical post is working.
// ---------------------------------------------------------------------------
function igDistribution(rows) {
    const pick = f => rows.map(f).filter(v => typeof v === 'number' && !isNaN(v));

    const likes = pick(r => r.likes);
    const comments = pick(r => r.comments);
    const views = pick(r => r.views).filter(v => v > 0);
    const eng = pick(r => r.engagement_raw);
    // phase 11: reels that report both numbers. plays/views < 1 means most
    // "views" were autoplay scrolls that never became a watch.
    const both = rows.filter(r => (r.plays || 0) > 0 && (r.views || 0) > 0 && r.plays !== r.views);
    const plays = pick(r => r.plays).filter(v => v > 0);

    const stat = arr => {
        if (!arr.length) return { mean: 0, median: 0, max: 0, min: 0, p90: 0 };
        const s = [...arr].sort((a, b) => a - b);
        return {
            mean: Math.round(arr.reduce((x, y) => x + y, 0) / arr.length),
            median: Math.round(S.median(arr)),
            min: Math.round(s[0]),
            max: Math.round(s[s.length - 1]),
            p90: Math.round(s[Math.min(s.length - 1, Math.floor(s.length * 0.9))])
        };
    };

    const e = stat(eng);
    return {
        likes: stat(likes),
        comments: stat(comments),
        views: stat(views),
        engagement: e,
        // How far the mean is being pulled by the tail. Above ~1.6 the average
        // is describing the outlier, not the account.
        skew: e.median > 0 ? +(e.mean / e.median).toFixed(2) : null,
        outlierDriven: e.median > 0 && (e.mean / e.median) > 1.6,
        viewsAvailable: views.length > 0,
        plays: stat(plays),
        playback: {
            playsAvailable: plays.length > 0,
            distinguishable: both.length,
            medianPlaysPerView: both.length
                ? +S.median(both.map(r => r.plays / r.views)).toFixed(2) : null
        }
    };
}


// ---------------------------------------------------------------------------
// AGGREGATION — median-first
//
// These deliberately do NOT reuse leaderboard(), flagCompare() and
// timeHeatmap() from the FB engine, even though the shapes match.
//
// Those three all aggregate performance_index with a mean, and on Instagram
// that reintroduces the exact bug this patch exists to remove. Tested against
// a fixture with one runaway reel, the mean-based helpers reported reels at
// 7.5x baseline, emoji captions at +640% and Saturday at 16.7x — all of them
// one post wearing a costume. The medians for the same data are 1.06x, +6%
// and 1.0x.
//
// So: sort and headline on the median, carry the mean alongside for anyone
// who wants it, and mark a row unreliable when the two disagree badly.
// ---------------------------------------------------------------------------

// Below this, a median is not a median. With two posts it is just the mean
// again, which is how a bucket containing one runaway reel and one dud came
// back claiming a 40x effect. Small buckets are still reported — the post
// count is useful — but they do not get to make a performance claim.
const IG_MIN_BUCKET = 3;

function igAggIndex(group) {
    const idx = group.map(r => r.performance_index || 0);
    const med = +S.median(idx).toFixed(2);
    const avg = +(idx.reduce((s, v) => s + v, 0) / idx.length).toFixed(2);
    const sparse = group.length < IG_MIN_BUCKET;

    return {
        medIndex: sparse ? null : med,
        avgIndex: sparse ? null : avg,
        sparse,
        // A big gap means one post is carrying the group, so the row should be
        // read as "one post did this", not "this category performs".
        outlierDriven: !sparse && med > 0 && (avg / med) > 1.8,
        note: sparse ? `Only ${group.length} post(s) — not enough to read a pattern` : null
    };
}

function igLeaderboard(rows, dimension, minCount = 2) {
    const agg = {};
    rows.forEach(r => {
        const k = r[dimension] || 'unknown';
        (agg[k] = agg[k] || []).push(r);
    });

    return Object.entries(agg)
        .filter(([, g]) => g.length >= Math.min(minCount, rows.length))
        .map(([key, g]) => ({
            key,
            posts: g.length,
            share: ((g.length / rows.length) * 100).toFixed(1) + '%',
            ...igAggIndex(g),
            medEngagement: Math.round(S.median(g.map(r => r.engagement_raw))),
            avgEngagement: Math.round(g.reduce((s, r) => s + r.engagement_raw, 0) / g.length),
            medComments: Math.round(S.median(g.map(r => r.comments)))
        }))
        .sort((x, y) => (y.medIndex ?? -1) - (x.medIndex ?? -1));
}

function igFlagCompare(rows, field, labelOn, labelOff) {
    const on = rows.filter(r => r[field]);
    const off = rows.filter(r => !r[field]);
    if (!on.length || !off.length) return null;

    const onA = igAggIndex(on), offA = igAggIndex(off);
    const side = (g, a, label) => ({
        label, posts: g.length,
        share: +((g.length / rows.length) * 100).toFixed(1),
        medIndex: a.medIndex, avgIndex: a.avgIndex,
        medEngagement: Math.round(S.median(g.map(r => r.engagement_raw)))
    });

    // Lift computed on medians, so a single breakout post cannot manufacture
    // a "+640% — always use emoji" recommendation out of nothing.
    const lift = (onA.medIndex != null && offA.medIndex != null && offA.medIndex > 0)
        ? +((onA.medIndex / offA.medIndex - 1) * 100).toFixed(1)
        : null;

    return {
        field,
        with: side(on, onA, labelOn),
        without: side(off, offA, labelOff),
        lift,
        reliable: on.length >= 4 && off.length >= 4 && lift != null && !onA.outlierDriven && !offA.outlierDriven,
        note: (onA.sparse || offA.sparse)
            ? 'One side of this split has too few posts to compare.'
            : (onA.outlierDriven || offA.outlierDriven)
            ? 'One post dominates this split — treat the lift as indicative only.'
            : null
    };
}

function igHeatmap(rows) {
    const cells = {};
    rows.forEach(r => {
        if (r.hour_local === null || r.dow_local === null) return;
        const k = `${r.dow_local}:${r.hour_local}`;
        (cells[k] = cells[k] || []).push(r);
    });

    const flat = Object.entries(cells).map(([k, g]) => {
        const [dow, hour] = k.split(':').map(Number);
        return { dow, dowName: S.DOW_NAMES[dow], hour, posts: g.length, ...igAggIndex(g) };
    });

    const byHour = {}, byDay = {};
    rows.forEach(r => {
        if (r.hour_local !== null) (byHour[r.hour_local] = byHour[r.hour_local] || []).push(r);
        if (r.dow_local !== null) (byDay[r.dow_local] = byDay[r.dow_local] || []).push(r);
    });

    const hourRank = Object.entries(byHour)
        .map(([h, g]) => ({ hour: +h, posts: g.length, ...igAggIndex(g) }))
        .filter(h => h.posts >= IG_MIN_BUCKET)
        .sort((a, b) => (b.medIndex ?? -1) - (a.medIndex ?? -1));

    const dayRank = Object.entries(byDay)
        .map(([d, g]) => ({ dow: +d, dowName: S.DOW_NAMES[+d], posts: g.length, ...igAggIndex(g) }))
        .filter(d => d.posts >= IG_MIN_BUCKET)
        .sort((a, b) => (b.medIndex ?? -1) - (a.medIndex ?? -1));

    return {
        cells: flat,
        bestHours: hourRank.slice(0, 5),
        worstHours: hourRank.slice(-3).reverse(),
        bestDays: dayRank,
        // Under this many posts a heatmap is decoration, not evidence.
        reliable: rows.length >= 20
    };
}


// ---------------------------------------------------------------------------
// CADENCE — mirrors cadenceStats() on the FB side
// ---------------------------------------------------------------------------
function igCadence(rows) {
    const stamps = rows.map(r => r.posted_at ? new Date(r.posted_at).getTime() : null)
        .filter(Boolean).sort((a, b) => a - b);

    if (stamps.length < 2) {
        return {
            postsPerWeek: rows.length, postsPerMonth: rows.length, spanDays: 1,
            medianGapDays: null, longestGapDays: null, consistency: null,
            activeWeeks: rows.length ? 1 : 0, lastPostDaysAgo: null, silent: false
        };
    }

    const spanDays = Math.max(1, (stamps[stamps.length - 1] - stamps[0]) / 86400000);
    const gaps = [];
    for (let i = 1; i < stamps.length; i++) gaps.push((stamps[i] - stamps[i - 1]) / 86400000);

    const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((s, g) => s + Math.pow(g - mean, 2), 0) / gaps.length);
    const consistency = mean > 0 ? Math.max(0, Math.round(100 - Math.min(100, (sd / mean) * 55))) : null;

    const weeks = new Set(rows.filter(r => r.posted_at).map(r => {
        const d = new Date(r.posted_at);
        const y = d.getUTCFullYear();
        const w = Math.floor((d - new Date(Date.UTC(y, 0, 1))) / (7 * 86400000));
        return `${y}-${w}`;
    }));

    return {
        postsPerWeek: +((rows.length / spanDays) * 7).toFixed(1),
        postsPerMonth: +((rows.length / spanDays) * 30).toFixed(1),
        spanDays: Math.round(spanDays),
        medianGapDays: +S.median(gaps).toFixed(1),
        longestGapDays: +Math.max(...gaps).toFixed(1),
        consistency,
        activeWeeks: weeks.size,
        lastPostDaysAgo: +((Date.now() - stamps[stamps.length - 1]) / 86400000).toFixed(1),
        silent: (Date.now() - stamps[stamps.length - 1]) / 86400000 > 14
    };
}


// ---------------------------------------------------------------------------
// MOMENTUM — mirrors momentum() on the FB side
// ---------------------------------------------------------------------------
function igMomentum(allRows) {
    const rows = allRows.filter(r => !r.is_provisional);
    const byMonth = {};

    rows.forEach(r => {
        if (!r.posted_at) return;
        const m = r.posted_at.slice(0, 7);
        byMonth[m] = byMonth[m] || { month: m, posts: 0, engagement: 0, likes: 0, comments: 0, views: 0 };
        byMonth[m].posts++;
        byMonth[m].engagement += r.engagement_raw || 0;
        byMonth[m].likes += r.likes || 0;
        byMonth[m].comments += r.comments || 0;
        byMonth[m].views += r.views || 0;
    });

    const thisMonth = new Date().toISOString().slice(0, 7);

    const months = Object.values(byMonth)
        .sort((a, b) => a.month.localeCompare(b.month))
        .map(m => ({
            ...m,
            // Median, not mean. A month containing one breakout post otherwise
            // reads as a spike, and the month after it reads as a collapse.
            medEngagement: Math.round(S.median(rows.filter(r => r.posted_at?.slice(0, 7) === m.month)
                                                 .map(r => r.engagement_raw))),
            avgEngagement: Math.round(m.engagement / m.posts),
            avgLikes: Math.round(m.likes / m.posts),
            avgComments: +(m.comments / m.posts).toFixed(1),
            avgViews: Math.round(m.views / m.posts),
            partial: m.month === thisMonth
        }));

    // The month in progress is not a data point yet. Comparing three days of
    // September against all of August is how a growing account gets told it
    // is in freefall — and then gets a -5 momentum penalty for it.
    const complete = months.filter(m => !m.partial && m.posts >= 3);

    let direction = null, changePct = null, basis = null;
    if (complete.length >= 2) {
        const prev = complete[complete.length - 2], last = complete[complete.length - 1];
        if (prev.medEngagement > 0) {
            changePct = +(((last.medEngagement - prev.medEngagement) / prev.medEngagement) * 100).toFixed(1);
            direction = changePct > 8 ? 'rising' : changePct < -8 ? 'falling' : 'flat';
            basis = `${prev.month} → ${last.month}, median engagement, complete months only`;
        }
    }

    // Newest third vs oldest third. Steadier than any single month pair, and
    // the fallback when there are not two complete months to compare.
    let halfSplit = null;
    if (rows.length >= 9) {
        const sorted = [...rows].filter(r => r.posted_at)
            .sort((a, b) => new Date(a.posted_at) - new Date(b.posted_at));
        const third = Math.floor(sorted.length / 3);
        const oldMed = S.median(sorted.slice(0, third).map(r => r.engagement_raw));
        const newMed = S.median(sorted.slice(-third).map(r => r.engagement_raw));
        halfSplit = {
            oldestThirdMedian: Math.round(oldMed),
            newestThirdMedian: Math.round(newMed),
            changePct: oldMed > 0 ? +(((newMed - oldMed) / oldMed) * 100).toFixed(1) : null
        };
        if (direction === null && halfSplit.changePct != null) {
            changePct = halfSplit.changePct;
            direction = changePct > 8 ? 'rising' : changePct < -8 ? 'falling' : 'flat';
            basis = 'newest third vs oldest third of the window (not enough complete months)';
        }
    }

    return {
        months, direction, changePct, halfSplit, basis,
        partialMonth: months.find(m => m.partial)?.month || null,
        completeMonths: complete.length,
        provisionalExcluded: allRows.length - rows.length
    };
}


// ---------------------------------------------------------------------------
// PROFILE COMPLETENESS
// The IG counterpart of profileCompleteness(). Weighted towards the fields
// that actually convert a profile visit into a contact, because that is what
// a business account is for.
// ---------------------------------------------------------------------------
function igProfileCompleteness(b) {
    const checks = [
        { key: 'name',      label: 'Display name set',           ok: !!b.fullName,                      weight: 6 },
        { key: 'bio',       label: 'Bio written (40+ chars)',    ok: !!(b.bio && b.bio.length > 40),    weight: 16 },
        { key: 'website',   label: 'Link in bio set',            ok: !!b.website,                       weight: 18 },
        { key: 'category',  label: 'Business category set',      ok: !!b.category,                      weight: 10 },
        { key: 'email',     label: 'Contact email published',    ok: !!b.email,                         weight: 12 },
        { key: 'phone',     label: 'Phone number published',     ok: !!b.phone,                         weight: 12 },
        { key: 'city',      label: 'Location set',               ok: !!b.city,                          weight: 8 },
        { key: 'pic',       label: 'Profile photo set',          ok: !!b.profilePic,                    weight: 6 },
        { key: 'business',  label: 'Business / creator account', ok: !!b.isBusiness,                    weight: 12 }
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
// SCORE v2
// Seven bounded pillars plus a bounded momentum adjustment, and the breakdown
// comes back with the score so the page can show where every point went.
// The v1 score was four unbounded-ish terms with no explanation attached,
// which made a grade impossible to argue with or act on.
// ---------------------------------------------------------------------------
function igComputeScore(parts) {
    const { engagementRate, postsPerWeek, consistency, commentRatio,
            viewsPerFollower, completeness, momentumPct, formatSpread,
            sampleSize, viewsAvailable } = parts;

    // 1. Engagement per follower (26). Log-scaled: a 2k account routinely
    //    posts 8% and a 500k account structurally cannot, so a linear scale
    //    just ranks accounts by how small they are.
    const er = engagementRate || 0;
    const engagementPts = Math.min(26, Math.round((Math.log10(1 + er * 12) / Math.log10(13)) * 26));

    // 2. Cadence (16). 3-7 a week is the band where the feed keeps serving
    //    you without the audience tuning out.
    const ppw = postsPerWeek || 0;
    const cadencePts = ppw === 0 ? 0 : ppw < 1 ? 4 : ppw < 2 ? 8 : ppw <= 7 ? 16 : ppw <= 14 ? 12 : 8;

    // 3. Consistency (11) — rhythm, not volume.
    const consistencyPts = Math.round(((consistency ?? 50) / 100) * 11);

    // 4. Conversation (16) — comments per 100 likes. The hardest engagement
    //    to buy and the strongest surviving reach signal.
    const conv = commentRatio || 0;
    const conversationPts = Math.min(16, Math.round((Math.log10(1 + conv) / Math.log10(11)) * 16));

    // 5. Reach (12) — views per follower. Only scored when the actor actually
    //    returned view counts; scoring a zero we never measured would punish
    //    an account for a scrape limitation.
    const vpf = viewsPerFollower || 0;
    const reachPts = !viewsAvailable ? null
        : Math.min(12, Math.round((Math.log10(1 + vpf * 3) / Math.log10(7)) * 12));

    // 6. Format range (7) — reels, carousels and stills do different jobs.
    const formatPts = Math.min(7, (formatSpread || 0) >= 3 ? 7 : (formatSpread || 0) * 3);

    // 7. Profile completeness (12).
    const completenessPts = Math.round(((completeness || 0) / 100) * 12);

    // When views are unavailable the 12 reach points are redistributed rather
    // than lost, so two accounts are not graded on different denominators.
    const measured = engagementPts + cadencePts + consistencyPts + conversationPts +
                     formatPts + completenessPts + (reachPts ?? 0);
    const maxAvailable = 26 + 16 + 11 + 16 + 7 + 12 + (reachPts === null ? 0 : 12);
    let score = Math.round((measured / maxAvailable) * 100);

    const momentumAdj = momentumPct == null ? 0 : Math.max(-5, Math.min(5, Math.round(momentumPct / 10)));
    score = Math.max(0, Math.min(100, score + momentumAdj));

    const grade = score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : score >= 35 ? 'D' : 'F';
    const low = sampleSize > 0 && sampleSize < IG_MIN_CONFIDENT_POSTS;

    const breakdown = [
        { pillar: 'Engagement per follower', points: engagementPts,   max: 26, detail: `${er.toFixed(2)}% per post` },
        { pillar: 'Posting cadence',         points: cadencePts,      max: 16, detail: `${ppw} posts/week` },
        { pillar: 'Consistency',             points: consistencyPts,  max: 11, detail: consistency == null ? 'not enough posts' : `${consistency}/100 rhythm` },
        { pillar: 'Conversation',            points: conversationPts, max: 16, detail: `${conv.toFixed(1)} comments per 100 likes` },
        { pillar: 'Reach',                   points: reachPts ?? 0,   max: 12, detail: reachPts === null ? 'no view counts returned — pillar excluded' : `${vpf.toFixed(2)} views per follower` },
        { pillar: 'Format range',            points: formatPts,       max: 7,  detail: `${formatSpread || 0} formats in use` },
        { pillar: 'Profile completeness',    points: completenessPts, max: 12, detail: `${completeness || 0}% complete` },
        { pillar: 'Momentum adjustment',     points: momentumAdj,     max: 5,  detail: momentumPct == null ? 'no trend data' : `${momentumPct > 0 ? '+' : ''}${momentumPct}% month over month` }
    ];

    return {
        score, grade, breakdown,
        lowConfidence: low,
        sampleSize,
        verdict: low
            ? `Only ${sampleSize} posts in the window — treat this as provisional, not a verdict`
            : score >= 80 ? 'Strong account — the job is protecting what works'
            : score >= 65 ? 'Healthy, with one clear gap to close'
            : score >= 50 ? 'Functional but underperforming its follower count'
            : score >= 35 ? 'Weak — fix the fundamentals before optimising anything'
            : 'Dormant or badly broken'
    };
}


// ---------------------------------------------------------------------------
// EXTRAS
// Everything the scrape now captures, plus the three fields that were being
// written to the posts table and read by nothing: video_duration,
// location_name and mentions.
// ---------------------------------------------------------------------------
function igExtras(rows) {
    const n = rows.length;
    const share = c => n ? +((c / n) * 100).toFixed(1) : 0;

    // --- carousel depth ---------------------------------------------------
    const carousels = rows.filter(r => r.is_carousel);
    const depthBuckets = {};
    carousels.forEach(r => {
        const d = r.carousel_count;
        const k = d >= 8 ? '8+' : d >= 5 ? '5-7' : d >= 3 ? '3-4' : '2';
        (depthBuckets[k] = depthBuckets[k] || []).push(r);
    });

    // --- aspect ratio ------------------------------------------------------
    const aspects = {};
    rows.filter(r => r.aspect_ratio).forEach(r => {
        (aspects[r.aspect_ratio] = aspects[r.aspect_ratio] || []).push(r);
    });

    // --- video duration (saved since day one, analysed until now by nobody)
    const durations = rows.map(r => Number(r.video_duration)).filter(d => d > 0);
    const durBuckets = {};
    rows.filter(r => Number(r.video_duration) > 0).forEach(r => {
        const d = Number(r.video_duration);
        const k = d <= 15 ? '0-15s' : d <= 30 ? '16-30s' : d <= 60 ? '31-60s' : d <= 90 ? '61-90s' : '90s+';
        (durBuckets[k] = durBuckets[k] || []).push(r);
    });

    // --- locations ---------------------------------------------------------
    const locs = {};
    rows.filter(r => r.location_name).forEach(r => {
        (locs[r.location_name] = locs[r.location_name] || []).push(r);
    });

    // --- mentions ----------------------------------------------------------
    const mentionCount = {};
    rows.forEach(r => (r.mentions || []).forEach(m => { mentionCount[m] = (mentionCount[m] || 0) + 1; }));

    // --- audio -------------------------------------------------------------
    const withAudio = rows.filter(r => r.audio?.title);
    const audioCount = {};
    withAudio.forEach(r => {
        const k = r.audio.artist ? `${r.audio.title} — ${r.audio.artist}` : r.audio.title;
        audioCount[k] = (audioCount[k] || 0) + 1;
    });

    // --- tagged users ------------------------------------------------------
    const tagCount = {};
    rows.forEach(r => (r.tagged_users || []).forEach(u => { tagCount[u] = (tagCount[u] || 0) + 1; }));

    const top = (obj, limit = 8) => Object.entries(obj)
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);

    // Median-based for the same reason the leaderboards are: with a mean, a
    // single breakout reel made the 9:16 bucket read 39.98x baseline off two
    // posts, which is a recommendation to shoot everything vertical based on
    // one lucky video.
    const bucketRows = obj => Object.entries(obj)
        .map(([key, group]) => ({
            key,
            posts: group.length,
            share: share(group.length),
            ...igAggIndex(group),
            medEngagement: Math.round(S.median(group.map(r => r.engagement_raw))),
            avgEngagement: Math.round(group.reduce((s, r) => s + r.engagement_raw, 0) / group.length)
        }))
        .sort((a, b) => (b.medIndex ?? -1) - (a.medIndex ?? -1));

    return {
        carousel: {
            posts: carousels.length,
            share: share(carousels.length),
            avgDepth: carousels.length
                ? +(carousels.reduce((s, r) => s + (r.carousel_count || 0), 0) / carousels.length).toFixed(1)
                : null,
            byDepth: bucketRows(depthBuckets),
            available: rows.some(r => r.carousel_count !== null)
        },
        aspectRatio: {
            byRatio: bucketRows(aspects),
            available: Object.keys(aspects).length > 0,
            // The specific thing worth telling an account about.
            fourFiveShare: share(rows.filter(r => r.aspect_ratio === '4:5').length),
            note: Object.keys(aspects).length
                ? '4:5 takes about 25% more vertical feed space than 1:1. Free impressions if the crop allows it.'
                : 'The actor did not return image dimensions on this run.'
        },
        videoDuration: {
            available: durations.length > 0,
            posts: durations.length,
            medianSeconds: durations.length ? +S.median(durations).toFixed(1) : null,
            byBand: bucketRows(durBuckets)
        },
        locations: {
            tagged: rows.filter(r => r.location_name).length,
            share: share(rows.filter(r => r.location_name).length),
            top: bucketRows(locs).slice(0, 6)
        },
        mentions: {
            postsWithMentions: rows.filter(r => (r.mentions || []).length).length,
            share: share(rows.filter(r => (r.mentions || []).length).length),
            top: top(mentionCount)
        },
        taggedUsers: {
            available: rows.some(r => (r.tagged_users || []).length),
            postsWithTags: rows.filter(r => (r.tagged_users || []).length).length,
            share: share(rows.filter(r => (r.tagged_users || []).length).length),
            top: top(tagCount)
        },
        audio: {
            available: withAudio.length > 0,
            posts: withAudio.length,
            originalShare: withAudio.length
                ? share(withAudio.filter(r => r.audio.original).length)
                : 0,
            top: top(audioCount, 6)
        },
        altText: {
            // Accessibility, and IG uses alt text for content understanding.
            coverage: share(rows.filter(r => r.has_alt_text).length),
            missing: rows.filter(r => !r.has_alt_text).length
        },
        sponsored: {
            posts: rows.filter(r => r.is_sponsored).length,
            share: share(rows.filter(r => r.is_sponsored).length)
        },
        commentsDisabled: {
            posts: rows.filter(r => r.comments_disabled === true).length,
            available: rows.some(r => r.comments_disabled !== null)
        }
    };
}


/**
 * What the actor actually gave us this run.
 *
 * The honest counterpart to the raw.keys line. Rather than silently rendering
 * an empty section, the report can say "the actor did not return dimensions"
 * — which is a fact about the scrape, not a fact about the account.
 */
function igDataQuality(rows, rawItems) {
    const keySet = new Set();
    (rawItems || []).slice(0, 25).forEach(i => Object.keys(i || {}).forEach(k => keySet.add(k)));

    const optional = [
        { field: 'childPosts',    label: 'Carousel children',   present: rows.some(r => r.carousel_count !== null) },
        { field: 'taggedUsers',   label: 'Tagged users',        present: rows.some(r => (r.tagged_users || []).length) },
        { field: 'alt',           label: 'Alt text',            present: rows.some(r => r.has_alt_text) },
        { field: 'dimensions',    label: 'Image dimensions',    present: rows.some(r => r.aspect_ratio) },
        { field: 'musicInfo',     label: 'Reel audio',          present: rows.some(r => r.audio) },
        { field: 'isSponsored',   label: 'Paid partnership flag', present: rows.some(r => r.is_sponsored) },
        { field: 'latestComments',label: 'First comment',       present: rows.some(r => r.first_comment) },
        { field: 'videoDuration', label: 'Video duration',      present: rows.some(r => Number(r.video_duration) > 0) },
        { field: 'locationName',  label: 'Location',            present: rows.some(r => r.location_name) },
        { field: 'playCount',     label: 'View counts',         present: rows.some(r => r.views > 0) }
    ];

    return {
        actorKeys: Array.from(keySet).sort(),
        fields: optional,
        missing: optional.filter(o => !o.present).map(o => o.label),
        postsSeen: rows.length,
        provisional: rows.filter(r => r.is_provisional).length
    };
}


// ===========================================================================
// SAVE
// ===========================================================================

async function savePosts(userId, handle, posts, meta = {}) {
    const seen = new Set();
    const rows = [];

    for (const p of posts || []) {
        const row = igNormalisePost(p, handle, userId, meta);
        if (!row || seen.has(row.shortcode)) continue;
        seen.add(row.shortcode);

        // The audit-only derived fields are not persisted — they are cheap to
        // recompute and would otherwise need a migration every time one is
        // added. What is persisted is the raw signal the actor charged us for.
        rows.push({
            user_id: row.user_id,
            platform: row.platform,
            handle: row.handle,
            shortcode: row.shortcode,
            post_url: row.post_url,
            post_type: row.post_type,
            caption: row.caption,
            caption_length: row.caption_length,
            hashtags: row.hashtags,
            mentions: row.mentions,
            likes: row.likes,
            comments: row.comments,
            views: row.views,
            is_video: row.is_video,
            video_duration: row.video_duration,
            thumbnail_url: row.thumbnail_url,
            media_url: row.media_url,
            location_name: row.location_name,
            posted_at: row.posted_at,
            report_id: row.report_id,
            set_id: row.set_id,
            client_id: (meta.clientId && S.UUID_RE.test(String(meta.clientId))) ? meta.clientId : null,   // phase 10
            scraped_at: row.scraped_at,

            // --- phase 4 columns ---------------------------------------------
            carousel_count: row.carousel_count,
            tagged_users: row.tagged_users,
            alt_text: row.alt_text,
            media_width: row.media_width,
            media_height: row.media_height,
            aspect_ratio: row.aspect_ratio,
            is_sponsored: row.is_sponsored,
            audio: row.audio,
            comments_disabled: row.comments_disabled,
            first_comment: row.first_comment,
            engagement_raw: row.engagement_raw,
            hour_local: row.hour_local,
            dow_local: row.dow_local,
            is_provisional: row.is_provisional,
            raw: row.raw
        });
    }

    if (!rows.length) return { saved: 0, failed: 0, error: null };

    // A failure here used to be invisible. computeAudit() works from the
    // in-memory array, so the report rendered perfectly while the posts table
    // stayed empty — which is exactly what happens when schema-phase4.sql was
    // never applied and every upsert errors on an unknown column. The run
    // looked fine and /api/posts silently returned nothing for weeks.
    let saved = 0, failed = 0, firstError = null;
    for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        const { error } = await supabase.from('posts')
            .upsert(chunk, { onConflict: 'user_id,platform,shortcode' });
        if (error) {
            failed += chunk.length;
            firstError = firstError || error.message;
            logger.error('save_posts_failed', { message: error.message, handle, chunk: chunk.length });
        } else {
            saved += chunk.length;
        }
    }

    if (firstError) {
        alertOnce('save_posts_failed',
            'Instagram posts are not being written to the database. The reports still render from memory, ' +
            'but post-level history is not accumulating. Usually a missing migration: ' + firstError,
            { handle });
    }
    return { saved, failed, error: firstError };
}
