/**
 * The content plan, its calendar and the agency's planning workflow.
 *
 * Part of the EdgeLead server, split out of server.js (phase 55). The parts load in
 * order from server.js and share one namespace, S: what this part needs from an earlier
 * part is unpacked below; anything else from another part is read as S.name when it runs.
 */
'use strict';
const S = require('./shared');
const {
    FB_CTA_RE, FB_EMOJI_RE, FB_OFFER_RE, FB_QUESTION_RE, IG_URL_RE, JOB_WORKERS, MAX_COMPETITORS, UUID_RE,
    aiReasonText, app, applyReportScope, assertJobSlot, auth, budgetedJson, canReadReport, clientAccess,
    createJob, crypto, endOfColumn, geminiAvailable, geminiCallDetailed, igIndexPosts, lengthBand, logger,
    median, oneLine, openingPattern, ownClientFor, parsePageRef, registerWorker, requireEngine,
    resolveClientId, runJob, sendErr, spendLimit, staffOnly, supabase, topicTags, userRole
} = S;
Object.assign(S, {
    cpBoostCall, cpBand, cpFeature, cpScore, cpParseSlot, cpScheduleDates, syncPostFromTask,
    contentPlanMonth, cpDocBlocks, csType, csParseCsv, csImportRows, csRank, csToolsFor, csBusiness,
    csPageText, csSiteLinks, csBaseTopics
});

// ===========================================================================
// PHASE 10 :: CONTENT PLAN  (derived engine, zero Apify — Instagram + FB Page)
//
// Performance Audit / Competitor Intel / FB Page Report each store the rows
// they scraped. This turns those rows into a plan: which format cells rivals
// win and the target is absent from (gaps), which the target already wins
// (double down), which it posts and loses (stop), and a brief for each.
// Gemini writes only inside the cells the scorecard supplies; the evidence
// and the predicted band are computed.
//
// Phase 10 changes:
//   - rows are read for the selected client AND the caller's own vault, so a
//     teammate's run on a shared client feeds the plan (dedup by post, most
//     recently scraped copy wins). Reads are never blended across clients.
//   - Facebook Pages are a first-class platform (fb_page_posts), with the
//     same cell scoring and their own format set.
//   - freshness is measured and reported; stale data raises a warning and is
//     printed in the "how true is this" panel rather than silently used.
// ===========================================================================

const CP_POSTS_PER_HANDLE = parseInt(process.env.CONTENT_PLAN_POSTS_PER_HANDLE || '120', 10);
const CP_MIN_CELL  = 2;
const CP_MIN_ROWS  = 6;
const CP_STALE_DAYS = parseInt(process.env.CONTENT_PLAN_STALE_DAYS || '45', 10);

const CP_PLATFORMS = {
    instagram: {
        key: 'instagram', label: 'Instagram', unit: 'account', prefix: '@',
        sourceTypes: ['ig_report', 'deep_audit'],
        sourceEngines: 'a Performance Audit or Competitor Intel',
        formats: [
            { key: 'Reel',     plural: 'reels',     label: 'Reels',     defaultCount: 4, conceptHint: 'what the reel shows, shot by shot in 2-3 lines' },
            { key: 'Carousel', plural: 'carousels', label: 'Carousels', defaultCount: 3, conceptHint: 'slide-by-slide outline' },
            { key: 'Still',    plural: 'stills',    label: 'Stills',    defaultCount: 3, conceptHint: 'the single image' }
        ],
        unavailable: 'Competitor reach, saves, shares, impressions and demographics cannot be obtained from any source.'
    },
    facebook: {
        key: 'facebook', label: 'Facebook Page', unit: 'Page', prefix: '',
        sourceTypes: ['fb_page'],
        sourceEngines: 'an FB Page Report',
        formats: [
            { key: 'Video', plural: 'videos', label: 'Videos',     defaultCount: 3, conceptHint: 'what the video shows, shot by shot in 2-3 lines' },
            { key: 'Photo', plural: 'photos', label: 'Photos',     defaultCount: 3, conceptHint: 'the single image' },
            { key: 'Album', plural: 'albums', label: 'Albums',     defaultCount: 2, conceptHint: 'image-by-image outline' },
            { key: 'Link',  plural: 'links',  label: 'Link posts', defaultCount: 1, conceptHint: 'what is linked and how the post frames it' },
            { key: 'Text',  plural: 'texts',  label: 'Text posts', defaultCount: 1, conceptHint: 'the post text, structure only' }
        ],
        unavailable: 'Competitor reach, impressions, clicks and demographics cannot be obtained from any source. Video views are only present when Facebook shows them publicly.'
    }
};
function cpPlatform(p) { return CP_PLATFORMS[p] || CP_PLATFORMS.instagram; }
function cpCounts(platform, raw = {}) {
    const out = {};
    for (const f of cpPlatform(platform).formats) {
        const v = parseInt(raw[f.plural], 10);
        out[f.plural] = Number.isFinite(v) ? Math.min(Math.max(v, 0), 8) : f.defaultCount;
    }
    return out;
}

function cpFormat(r) {
    if (r.post_type === 'Reel' || (r.is_video && r.post_type !== 'Sidecar')) return 'Reel';
    if (r.post_type === 'Sidecar' || (r.carousel_count || 0) > 1) return 'Carousel';
    return 'Still';
}
function cpFbFormat(r) {
    const m = String(r.media_type || '').toLowerCase();
    if (m === 'video') return 'Video';
    if (m === 'album') return 'Album';
    if (m === 'photo') return 'Photo';
    if (m === 'link')  return 'Link';
    return 'Text';                                   // text | poll | unknown
}
/**
 * Whether a brief may carry a "spend money on this" recommendation.
 *
 * The model is told the rule in the prompt; this enforces it, for the same
 * reason the cell gate exists. A why=gap cell is by definition something this
 * account has never won — putting budget behind it is the most expensive kind
 * of wrong advice a plan can give, and it is exactly the advice a confident
 * model will volunteer.
 *
 * Only a why=double_down cell — something already winning organically — can
 * be recommended for boosting. Everything else is downgraded, and the
 * downgrade is recorded so the page can say why rather than silently
 * disagreeing with the brief next to it.
 */
function cpBoostCall(modelBoost, cellWhy, modelWhy) {
    const wants = /worth/i.test(String(modelBoost || ''));
    const may   = cellWhy === 'double_down';

    if (wants && may) {
        return { boost: 'worth boosting', downgraded: false, why: modelWhy || null };
    }
    if (wants && !may) {
        return {
            boost: 'organic only',
            downgraded: true,
            why: 'Not proven for this account yet — win it organically before putting money behind it.'
        };
    }
    return { boost: 'organic only', downgraded: false, why: modelWhy || null };
}

function cpBand(idx) {
    if (idx == null || isNaN(idx)) return 'typical';
    if (idx >= 1.5) return 'top';
    if (idx >= 1.15) return 'above';
    if (idx >= 0.8) return 'typical';
    return 'below';
}
function cpHashtagBand(n) { return n === 0 ? '0' : n <= 5 ? '1-5' : n <= 15 ? '6-15' : '16+'; }
function cpHook(caption) {
    const first = String(caption || '').split(/\r?\n/).map(s => s.trim()).find(Boolean) || '';
    return first.slice(0, 90);
}

/** Instagram row (posts table) -> scorecard feature. */
function cpFeature(r) {
    const caption = r.caption || '';
    const words = caption.split(/\s+/).filter(Boolean).length;
    const tags = topicTags(caption, 3);
    const hashtags = Array.isArray(r.hashtags) ? r.hashtags.length : 0;
    const format = cpFormat(r);
    return {
        ...r,
        format,
        opening: openingPattern(caption),
        lengthBand: lengthBand(words),
        topic: tags[0] || 'general',
        topics: tags,
        hook: cpHook(caption),
        hashtagBand: cpHashtagBand(hashtags),
        hasQuestion: FB_QUESTION_RE.test(caption),
        hasCta: FB_CTA_RE.test(caption),
        hasOffer: FB_OFFER_RE.test(caption),
        hasEmoji: FB_EMOJI_RE.test(caption),
        hasLink: IG_URL_RE.test(caption),
        hasFirstComment: !!r.first_comment,
        audioOriginal: r.audio ? !!(r.audio.original) : null,
        aspect: r.aspect_ratio || null,
        slides: r.carousel_count || null,
        playsRatio: (r.views && r.likes) ? +(r.views / Math.max(1, r.likes)).toFixed(1) : null,
        hour: r.hour_local, dow: r.dow_local
    };
}

/** Facebook Page row (fb_page_posts table) -> the same feature shape. */
function cpFbFeature(r) {
    const caption = r.content || '';
    const words = r.word_count || caption.split(/\s+/).filter(Boolean).length;
    const tags = (Array.isArray(r.topic_tags) && r.topic_tags.length) ? r.topic_tags.slice(0, 3) : topicTags(caption, 3);
    const hashtags = Array.isArray(r.hashtags) ? r.hashtags.length : 0;
    return {
        ...r,
        handle: r.page_id,
        shortcode: r.post_id,
        caption,
        likes: r.reactions_total || 0,
        format: cpFbFormat(r),
        opening: r.opening_pattern || openingPattern(caption),
        lengthBand: r.length_band || lengthBand(words),
        topic: tags[0] || 'general',
        topics: tags,
        hook: cpHook(caption),
        hashtagBand: cpHashtagBand(hashtags),
        hasQuestion: !!r.has_question,
        hasCta: !!r.has_cta,
        hasOffer: !!r.has_offer,
        hasEmoji: !!r.has_emoji,
        hasLink: !!r.has_link,
        hasFirstComment: false,
        audioOriginal: null,
        aspect: null,
        slides: null,
        linkDomain: r.link_domain || null,
        playsRatio: (r.views && r.reactions_total) ? +(r.views / Math.max(1, r.reactions_total)).toFixed(1) : null,
        hour: r.hour_local, dow: r.dow_local
    };
}
function cpCellKey(f) { return `${f.format}|${f.opening}|${f.lengthBand}|${f.topic}`; }

/** Sample-damped median index for a group of features. */
function cpScore(rows) {
    const idx = rows.map(r => r.performance_index).filter(v => typeof v === 'number');
    if (!idx.length) return { n: 0, medianIndex: null, winRate: 0, confidence: 0 };
    const med = median(idx);
    const wins = idx.filter(v => v >= 1.15).length / idx.length;
    const confidence = Math.min(1, idx.length / 6);
    // Shrink toward 1.0 (the account's own median) when the sample is thin.
    const damped = 1 + (med - 1) * confidence;
    return { n: idx.length, medianIndex: +med.toFixed(2), dampedIndex: +damped.toFixed(2), winRate: +wins.toFixed(2), confidence: +confidence.toFixed(2) };
}

function cpGroupBy(rows, keyFn) {
    const m = {};
    for (const r of rows) { const k = keyFn(r); if (k == null) continue; (m[k] = m[k] || []).push(r); }
    return m;
}

function cpLeaderboard(rows, keyFn, label, min = CP_MIN_CELL) {
    return Object.entries(cpGroupBy(rows, keyFn))
        .map(([k, g]) => ({ [label]: k, ...cpScore(g) }))
        .filter(x => x.n >= min)
        .sort((a, b) => (b.dampedIndex || 0) - (a.dampedIndex || 0));
}

function cpExemplars(rows, n = 3) {
    return rows.slice().sort((a, b) => (b.performance_index || 0) - (a.performance_index || 0)).slice(0, n)
        .map(r => ({ handle: r.handle, name: r.displayName || null, url: r.post_url, index: r.performance_index, band: cpBand(r.performance_index), hook: r.hook, likes: r.likes, comments: r.comments, views: r.views, postedAt: r.posted_at, owner: r.owner || null }));
}

const CP_IG_COLS = 'user_id, client_id, handle, shortcode, post_url, post_type, caption, hashtags, likes, comments, views, is_video, video_duration, thumbnail_url, posted_at, carousel_count, aspect_ratio, is_sponsored, audio, first_comment, engagement_raw, hour_local, dow_local, is_provisional, scraped_at';
const CP_FB_COLS = 'user_id, client_id, page_id, post_id, post_url, content, word_count, media_type, link_url, link_domain, reactions_total, comments, shares, views, posted_at, hour_local, dow_local, engagement_raw, performance_index, topic_tags, hashtags, opening_pattern, length_band, has_link, has_question, has_cta, has_offer, has_emoji, is_provisional, scraped_at';

/**
 * Stored posts for one handle: the caller's own rows plus, when a client is
 * selected, rows any teammate filed under that client. The same post scraped
 * twice keeps the most recent copy. Returns the rows and where they came
 * from, so the plan can print its own provenance.
 */
async function cpLoadRows(platform, userId, clientId, handle) {
    const fb = platform === 'facebook';
    const table = fb ? 'fb_page_posts' : 'posts';
    const idKey = fb ? 'post_id' : 'shortcode';
    const base = () => {
        let q = supabase.from(table).select(fb ? CP_FB_COLS : CP_IG_COLS);
        q = fb ? q.eq('page_id', handle) : q.eq('platform', 'instagram').eq('handle', handle);
        return q.order('posted_at', { ascending: false }).limit(CP_POSTS_PER_HANDLE);
    };
    const own = (await base().eq('user_id', userId)).data || [];
    let team = [];
    if (clientId && UUID_RE.test(String(clientId))) {
        team = (await base().eq('client_id', clientId).neq('user_id', userId)).data || [];
    }
    const byId = new Map();
    for (const r of [...own, ...team]) {
        const k = r[idKey]; if (!k) continue;
        const prev = byId.get(k);
        if (!prev || String(r.scraped_at || '') > String(prev.scraped_at || '')) byId.set(k, r);
    }
    const rows = [...byId.values()]
        .filter(r => !(platform === 'instagram' && r.is_sponsored))
        .sort((a, b) => String(b.posted_at || '').localeCompare(String(a.posted_at || '')))
        .slice(0, CP_POSTS_PER_HANDLE);
    const lastScraped = rows.reduce((m, r) => (r.scraped_at && r.scraped_at > m) ? r.scraped_at : m, '') || null;
    const newestPost  = rows.reduce((m, r) => (r.posted_at && r.posted_at > m) ? r.posted_at : m, '') || null;
    const ageDays = lastScraped ? Math.max(0, Math.round((Date.now() - new Date(lastScraped).getTime()) / 86400000)) : null;
    return {
        rows,
        source: { own: own.length, team: team.length, merged: rows.length,
                  lastScrapedAt: lastScraped, newestPostAt: newestPost, ageDays,
                  stale: ageDays == null ? true : ageDays > CP_STALE_DAYS }
    };
}

/** Display names for Facebook page ids (fb_pages is per user; any copy will do). */
async function cpPageNames(pageIds) {
    if (!pageIds.length) return {};
    const { data } = await supabase.from('fb_pages').select('page_id, name, username').in('page_id', pageIds);
    const out = {};
    for (const p of (data || [])) if (p.page_id && !out[p.page_id]) out[p.page_id] = p.name || p.username || p.page_id;
    return out;
}

/**
 * Owner-side metrics for the target from the client's connected Meta account.
 * IG media are keyed by shortcode; Page posts by the post id after the
 * "pageid_" prefix. Everything here carries source:'insights' and is never
 * folded into the scraped index.
 */
async function cpOwnerMap(platform, clientId, target, targetName) {
    if (!clientId || !UUID_RE.test(String(clientId))) return { map: {}, connection: null };
    const { data: conns } = await supabase.from('meta_connections')
        .select('id, page_id, page_name, ig_username, last_sync_at').eq('client_id', clientId).eq('status', 'active');
    let conn = null;
    if (platform === 'instagram') {
        conn = (conns || []).find(c => (c.ig_username || '').toLowerCase() === target) || null;
    } else {
        const want = [String(target).toLowerCase(), String(targetName || '').toLowerCase()].filter(Boolean);
        conn = (conns || []).find(c => want.includes(String(c.page_id || '').toLowerCase()) || want.includes(String(c.page_name || '').toLowerCase())) || null;
    }
    if (!conn) return { map: {}, connection: null };
    const { data: mm } = await supabase.from('meta_media').select('media_id, shortcode, insights').eq('connection_id', conn.id).eq('platform', platform);
    const map = {};
    for (const m of (mm || [])) {
        const ins = m.insights || {};
        if (platform === 'instagram') {
            if (m.shortcode) map[m.shortcode] = { reach: ins.reach ?? null, saved: ins.saved ?? null, shares: ins.shares ?? null, views: ins.views ?? null, interactions: ins.total_interactions ?? null, source: 'insights' };
        } else {
            // Graph ids are "pageid_postid"; scrapers store the numeric post id,
            // sometimes the full pair. Register every form so either matches.
            const mid = String(m.media_id || '');
            const rec = { reach: ins.post_impressions_unique ?? null, engaged: ins.post_engaged_users ?? null, clicks: ins.post_clicks ?? null, shares: ins.shares ?? null, saved: null, views: null, source: 'insights' };
            const keys = new Set([mid, mid.slice(mid.indexOf('_') + 1), mid.split('_').pop()].filter(Boolean));
            for (const k of keys) map[k] = rec;
        }
    }
    return { map, connection: conn };
}

registerWorker('content_plan', (userId, input, jobId) => async (progress, ck) => {
    const platform = input.platform === 'facebook' ? 'facebook' : 'instagram';
    const spec     = cpPlatform(platform);
    const target   = String(input.target || '').toLowerCase();
    const rivals   = (input.rivals || []).map(h => String(h).toLowerCase()).filter(h => h && h !== target);
    const counts   = cpCounts(platform, input.counts || {});
    const clientId = (input.clientId && UUID_RE.test(String(input.clientId))) ? input.clientId : null;
    const featureOf = platform === 'facebook' ? cpFbFeature : cpFeature;

    // --- load --------------------------------------------------------------
    await progress(5, `Loading stored posts for ${spec.prefix}${target}`);
    const tLoad = await cpLoadRows(platform, userId, clientId, target);
    if (tLoad.rows.length < CP_MIN_ROWS) {
        const e = new Error(`Only ${tLoad.rows.length} posts stored for ${spec.prefix}${target}${clientId ? ' under this client or your vault' : ''}. ` +
                            `Run ${spec.sourceEngines} on it first — the content plan is built from those rows and costs nothing extra.`);
        e.statusCode = 422; throw e;
    }
    const rivalLoads = {};
    for (const r of rivals) rivalLoads[r] = await cpLoadRows(platform, userId, clientId, r);
    const missingRivals = rivals.filter(r => rivalLoads[r].rows.length < CP_MIN_ROWS);
    const usedRivals = rivals.filter(r => !missingRivals.includes(r));

    let names = {};
    if (platform === 'facebook') names = await cpPageNames([target, ...rivals]);
    const display = h => platform === 'facebook' ? (names[h] || h) : `@${h}`;

    const freshness = {
        staleAfterDays: CP_STALE_DAYS,
        target: { handle: target, name: display(target), ...tLoad.source },
        rivals: usedRivals.map(r => ({ handle: r, name: display(r), ...rivalLoads[r].source })),
        scope: clientId ? 'client+own' : 'own'
    };

    // --- owner layer -------------------------------------------------------
    await progress(15, 'Attaching owner metrics where available');
    const { map: ownerMap, connection: ownerConnection } = await cpOwnerMap(platform, clientId, target, names[target]);

    // --- features + index --------------------------------------------------
    await progress(25, 'Indexing and classifying');
    const all = [];
    const push = (rows, role) => rows.forEach(r => {
        const f = featureOf(r);
        f.role = role;
        f.displayName = display(f.handle);
        if (role === 'target' && ownerMap[f.shortcode]) f.owner = ownerMap[f.shortcode];
        all.push(f);
    });
    push(tLoad.rows, 'target');
    for (const r of usedRivals) push(rivalLoads[r].rows, 'rival');
    igIndexPosts(all);                                  // keyed on handle + month; page_id stands in for handle on FB
    const settled = all.filter(r => !r.is_provisional);
    const T = settled.filter(r => r.role === 'target');
    const R = settled.filter(r => r.role === 'rival');

    // --- format cells ------------------------------------------------------
    const cellsT = cpGroupBy(T, cpCellKey);
    const cellsR = cpGroupBy(R, cpCellKey);
    const keys = [...new Set([...Object.keys(cellsT), ...Object.keys(cellsR)])];
    const cells = keys.map(k => {
        const [format, opening, lengthBand, topic] = k.split('|');
        const t = cpScore(cellsT[k] || []);
        const r = cpScore(cellsR[k] || []);
        let verdict = 'filler';
        if (t.n === 0 && r.n >= CP_MIN_CELL && (r.dampedIndex || 0) >= 1.15) verdict = 'gap';
        else if (t.n >= CP_MIN_CELL && (t.dampedIndex || 0) >= 1.15) verdict = 'double_down';
        else if (t.n >= CP_MIN_CELL && (t.dampedIndex || 0) < 0.85) verdict = 'stop';
        else if (t.n === 0 && r.n >= CP_MIN_CELL) verdict = 'rival_only';
        return { key: k, format, opening, lengthBand, topic, target: t, rivals: r, verdict,
                 exemplars: cpExemplars([...(cellsR[k] || []), ...(cellsT[k] || [])], 3) };
    });
    const byVerdict = v => cells.filter(c => c.verdict === v).sort((a, b) => ((b.rivals.dampedIndex || b.target.dampedIndex || 0) - (a.rivals.dampedIndex || a.target.dampedIndex || 0)));
    const lists = { gaps: byVerdict('gap').slice(0, 10), doubleDown: byVerdict('double_down').slice(0, 10), stop: byVerdict('stop').slice(0, 10), filler: byVerdict('filler').slice(0, 6) };

    // --- per-format analysis -----------------------------------------------
    await progress(45, `Analysing ${spec.formats.map(f => f.label.toLowerCase()).join(', ')}`);
    const fmtRows = k => ({ target: T.filter(r => r.format === k), rivals: R.filter(r => r.format === k), all: settled.filter(r => r.format === k) });
    const lostRow = r => ({ handle: r.handle, name: r.displayName || null, url: r.post_url, index: r.performance_index, hook: r.hook, likes: r.likes, comments: r.comments, views: r.views });
    const wonLost = rows => ({
        won: cpExemplars(rows.filter(r => cpBand(r.performance_index) === 'top' || cpBand(r.performance_index) === 'above'), 5),
        average: cpExemplars(rows.filter(r => cpBand(r.performance_index) === 'typical'), 3),
        lost: rows.filter(r => cpBand(r.performance_index) === 'below').slice().sort((a, b) => (a.performance_index || 0) - (b.performance_index || 0)).slice(0, 4).map(lostRow)
    });
    const hourKey = r => r.hour == null ? null : `${String(r.hour).padStart(2, '0')}:00`;
    const formats = {};
    for (const f of spec.formats) {
        const g = fmtRows(f.key);
        const block = {
            key: f.key, label: f.label,
            share: { target: T.length ? +(g.target.length / T.length).toFixed(2) : 0, rivals: R.length ? +(g.rivals.length / R.length).toFixed(2) : 0 },
            score: { target: cpScore(g.target), rivals: cpScore(g.rivals) },
            target: wonLost(g.target), rivals: wonLost(g.rivals),
            byHook: cpLeaderboard(g.all, r => r.opening, 'opening'),
            byHour: cpLeaderboard(g.all, hourKey, 'hour'),
            byLength: cpLeaderboard(g.all, r => r.lengthBand, 'band')
        };
        if (platform === 'instagram') {
            if (f.key === 'Reel') {
                block.byAudio = cpLeaderboard(g.all.filter(r => r.audioOriginal !== null), r => r.audioOriginal ? 'original audio' : 'reused audio', 'audio');
                block.byAspect = cpLeaderboard(g.all, r => r.aspect, 'aspect');
                block.playsRatio = { target: median(g.target.map(r => r.playsRatio).filter(v => v)), rivals: median(g.rivals.map(r => r.playsRatio).filter(v => v)) };
            }
            if (f.key === 'Carousel') block.bySlides = cpLeaderboard(g.all, r => r.slides == null ? null : (r.slides <= 3 ? '2-3 slides' : r.slides <= 6 ? '4-6 slides' : '7+ slides'), 'slides');
            if (f.key === 'Still') block.byAspect = cpLeaderboard(g.all, r => r.aspect, 'aspect');
        } else {
            if (f.key === 'Video') block.playsRatio = { target: median(g.target.map(r => r.playsRatio).filter(v => v)), rivals: median(g.rivals.map(r => r.playsRatio).filter(v => v)) };
            if (f.key === 'Link')  block.byDomain = cpLeaderboard(g.all, r => r.linkDomain, 'domain');
        }
        formats[f.plural] = block;
    }

    // --- caption analysis --------------------------------------------------
    const flag = (rows, f, on, off) => {
        const a = cpScore(rows.filter(r => r[f])), b = cpScore(rows.filter(r => !r[f]));
        return { on, off, with: a, without: b, lift: (a.dampedIndex != null && b.dampedIndex != null) ? +(a.dampedIndex - b.dampedIndex).toFixed(2) : null };
    };
    const flags = platform === 'instagram'
        ? ['hasQuestion', 'hasCta', 'hasOffer', 'hasEmoji', 'hasLink', 'hasFirstComment']
        : ['hasQuestion', 'hasCta', 'hasOffer', 'hasEmoji', 'hasLink'];
    const captions = {
        target: flags.map(f => ({ flag: f, ...flag(T, f, 'with', 'without') })),
        rivals: flags.map(f => ({ flag: f, ...flag(R, f, 'with', 'without') })),
        lengthBand: { target: cpLeaderboard(T, r => r.lengthBand, 'band'), rivals: cpLeaderboard(R, r => r.lengthBand, 'band') },
        hashtagBand: { target: cpLeaderboard(T, r => r.hashtagBand, 'band'), rivals: cpLeaderboard(R, r => r.hashtagBand, 'band') },
        opening: { target: cpLeaderboard(T, r => r.opening, 'opening'), rivals: cpLeaderboard(R, r => r.opening, 'opening') },
        topics: { target: cpLeaderboard(T, r => r.topic, 'topic'), rivals: cpLeaderboard(R, r => r.topic, 'topic') }
    };

    // --- owner view --------------------------------------------------------
    const ownerRows = T.filter(r => r.owner);
    const med = (rows, k) => median(rows.map(r => r.owner[k]).filter(v => v != null));
    const ownerRow = r => ({ url: r.post_url, format: r.format, hook: r.hook, reach: r.owner.reach, saved: r.owner.saved, shares: r.owner.shares, engaged: r.owner.engaged ?? null, clicks: r.owner.clicks ?? null, index: r.performance_index });
    const owner = ownerConnection ? {
        connection: ownerConnection.id, matched: ownerRows.length, lastSync: ownerConnection.last_sync_at,
        byFormat: Object.fromEntries(spec.formats.map(f => {
            const g = ownerRows.filter(r => r.format === f.key);
            return [f.key, { n: g.length, medianReach: med(g, 'reach'), medianSaved: med(g, 'saved'), medianShares: med(g, 'shares'), medianEngaged: med(g, 'engaged'), medianClicks: med(g, 'clicks') }];
        })),
        // IG: saves are the strongest owner-side signal. FB Pages have no saves; reach is the ranking metric.
        mostSaved: platform === 'instagram' ? ownerRows.slice().sort((a, b) => (b.owner.saved || 0) - (a.owner.saved || 0)).slice(0, 5).map(ownerRow) : [],
        topReach: ownerRows.slice().sort((a, b) => (b.owner.reach || 0) - (a.owner.reach || 0)).slice(0, 5).map(ownerRow),
        // Where public index and owner reach disagree, the public number is lying.
        hiddenWinners: ownerRows.filter(r => cpBand(r.performance_index) === 'below' && r.owner.reach).sort((a, b) => b.owner.reach - a.owner.reach).slice(0, 3).map(ownerRow)
    } : null;

    // --- provenance --------------------------------------------------------
    const staleNames = [freshness.target, ...freshness.rivals].filter(x => x.stale).map(x => `${x.name} (${x.ageDays == null ? 'unknown age' : x.ageDays + 'd'})`);
    const teamRows = tLoad.source.team + usedRivals.reduce((n, r) => n + rivalLoads[r].source.team, 0);
    const trueness = {
        scraped: platform === 'instagram'
            ? 'Likes, comments, views, captions, timing for every account. Same basis for target and rivals.'
            : 'Reactions, comments, shares, views (when public), post text, timing for every Page. Same basis for target and rivals.',
        insights: owner
            ? `${platform === 'instagram' ? 'Reach, saves, shares, views' : 'Reach, engaged users, clicks, shares'} for ${owner.matched} of ${T.length} target posts via the connected Meta account.`
            : 'Not connected — no owner-side numbers. Connect the client\'s Meta account to add owner metrics.',
        derived: 'Performance index (post vs. own monthly median), bands, cells, win rates and predictions are computed from the scraped numbers.',
        unavailable: spec.unavailable,
        freshness: `Target data last scraped ${tLoad.source.ageDays == null ? 'at an unknown time' : tLoad.source.ageDays + ' day(s) ago'}; ` +
                   `newest target post ${tLoad.source.newestPostAt ? tLoad.source.newestPostAt.slice(0, 10) : 'unknown'}. ` +
                   (staleNames.length ? `Older than ${CP_STALE_DAYS} days: ${staleNames.join(', ')}. Re-run the source audit before acting on those cells.` : `Everything is within ${CP_STALE_DAYS} days.`),
        provenance: clientId
            ? `${teamRows ? teamRows + ' row(s) came from teammates\' runs filed under this client; ' : ''}the rest are from your own vault. Rows from other clients are never read.`
            : 'No client selected — only your own vault was read.'
    };

    // --- briefs ------------------------------------------------------------
    await progress(65, 'Writing briefs');
    const candidates = [...lists.gaps.map(c => ({ ...c, why: 'gap' })), ...lists.doubleDown.map(c => ({ ...c, why: 'double_down' }))];
    const pick = (format, n) => candidates.filter(c => c.format === format).slice(0, Math.max(n, 1) + 2);
    const cellPack = c => ({
        cell: c.key, why: c.why, opening: c.opening, lengthBand: c.lengthBand, topic: c.topic,
        rivalIndex: c.rivals.dampedIndex, targetIndex: c.target.dampedIndex, rivalWinRate: c.rivals.winRate,
        evidence: c.exemplars.map(e => ({ url: e.url, hook: e.hook, index: e.index, handle: e.name || e.handle }))
    });
    const cellSets = {};
    for (const f of spec.formats) cellSets[f.plural] = pick(f.key, counts[f.plural]).map(cellPack);
    const evidence = {
        platform, target: display(target), rivals: usedRivals.map(display), brief: input.brief || null,
        counts,
        ...cellSets,
        stop: lists.stop.slice(0, 5).map(c => ({ cell: c.key, targetIndex: c.target.dampedIndex, n: c.target.n })),
        captionRules: {
            target: captions.target.filter(c => c.lift != null).map(c => ({ flag: c.flag, lift: c.lift })),
            rivals: captions.rivals.filter(c => c.lift != null).map(c => ({ flag: c.flag, lift: c.lift })),
            bestLength: captions.lengthBand.rivals[0]?.band || captions.lengthBand.target[0]?.band || null,
            bestHashtags: captions.hashtagBand.rivals[0]?.band || null
        },
        bestHours: Object.fromEntries(spec.formats.map(f => [f.plural, (formats[f.plural].byHour || []).slice(0, 3)])),
        owner: owner ? { top: (owner.mostSaved.length ? owner.mostSaved : owner.topReach).slice(0, 3), hiddenWinners: owner.hiddenWinners } : null,
        freshnessNote: staleNames.length ? `Data for ${staleNames.join(', ')} is older than ${CP_STALE_DAYS} days.` : null
    };

    let ai = null, aiStatus = { ok: false, reason: 'no_key' };
    if (geminiAvailable()) {
        const { json } = budgetedJson(evidence, { maxChars: 32000, keep: [...spec.formats.map(f => f.plural), 'counts', 'target'] });
        const formatLines = spec.formats.map(f =>
            ` "${f.plural}": [ { "cell": "...", "concept": "${f.conceptHint}", "hook": "first line on screen / first line of the post", "script": ["3-6 beats, each one line, in order — what is said or shown from the hook to the close"], "shot": "what the camera or the image actually shows, in one line, concrete enough to hand to whoever makes it", "caption": "full ${platform === 'instagram' ? 'caption' : 'post text'} in the cell's length band", "evidence": ["url"], "slot": "day + hour if bestHours suggests one", "boost": "worth boosting | organic only", "boost_why": "one line", "why": "one line" } ]`
        ).join(',\n');
        const countLine = spec.formats.map(f => `${counts[f.plural]} ${f.plural}`).join(', ');
        const prompt =
`You are a content strategist. Below is a computed scorecard for ${spec.label} ${spec.unit} ${display(target)} against rivals ${usedRivals.map(display).join(', ') || '(none)'}.
Each "cell" is a content format x opening pattern x caption length x topic. The cell lists are keyed by format: ${spec.formats.map(f => `${f.plural} = ${f.label}`).join(', ')}. Cells marked why=gap are ones rivals win and the target has never used. why=double_down are ones the target already wins.

RULES:
- Write briefs ONLY for the cells given. Do not invent formats, topics or hooks outside them.
- Each brief must name its cell and cite at least one evidence URL from that cell.
- Hooks must follow the cell's opening pattern. Captions must follow the cell's length band.
- Never claim reach, saves, clicks or impressions unless the owner block supplies them.
- If freshnessNote is present, say so once in the summary; do not pretend the data is current.
- Write in the language the evidence hooks are in (English or Bangla as seen).
- "script" is the spoken or written beats in order, and "shot" is what is actually on screen. Both must be makeable by one person with a phone. No crews, no studios, no stock footage, no voice actors, no motion graphics.
- Derive script and shot from the evidence hooks in the cell, not from what usually works on this platform. If a cell's exemplars do not show you what was on screen, say so in "shot" rather than inventing a treatment.
- "boost" may only be "worth boosting" for a why=double_down cell — something this account already wins organically. A why=gap cell is unproven for them, and putting money behind unproven content is how budgets get wasted. Everything else is "organic only".
- Never suggest a budget, a bid, an audience size or a targeting setting. There is no ad data here and you would be guessing.

Scorecard (JSON):
${json}

Reply with ONLY this JSON:
{
 "summary": "3 sentences: the biggest gap, the biggest strength, the one thing to stop",
${formatLines},
 "stop_doing": ["one line per stop cell, with the number"],
 "caption_rules": ["3-5 rules with the lift numbers"]
}
Produce exactly ${countLine} (fewer only if there are not enough cells).`;
        const r = await geminiCallDetailed(prompt, { temperature: 0.55, maxOutputTokens: 12000, tag: 'Gemini Content Plan', userId });
        aiStatus = { ok: r.ok, reason: r.reason, message: r.ok ? 'Generated.' : aiReasonText(r.reason), model: r.model || null };
        ai = r.ok ? r.data : null;
    } else {
        aiStatus = { ok: false, reason: 'no_key', message: aiReasonText('no_key') };
    }

    // Gate: a brief must sit in a cell we handed the model (gap or double
    // down). Anything else is invented and is dropped, the same way the FB
    // advisor drops a pitch in a no-promo room. Predicted band comes from the
    // cell's computed index, never from the model.
    const allowed = Object.fromEntries(candidates.map(c => [c.key, c]));
    let removed = 0;
    const stamp = (list, format) => (Array.isArray(list) ? list : []).flatMap(b => {
        const c = allowed[String(b.cell || '')];
        if (!c || c.format !== format) { removed += 1; return []; }
        const idx = c.target.n >= CP_MIN_CELL ? c.target.dampedIndex : c.rivals.dampedIndex;
        const ev = (Array.isArray(b.evidence) ? b.evidence : []).filter(u => c.exemplars.some(e => e.url === u));

        const call = cpBoostCall(b.boost, c.why, b.boost_why);

        return [{ ...b, evidence: ev.length ? ev : c.exemplars.map(e => e.url),
                  predicted_band: cpBand(idx), predicted_index: idx,
                  boost: call.boost,
                  boost_downgraded: call.downgraded,
                  boost_why: call.why,
                  script: Array.isArray(b.script) ? b.script.slice(0, 8) : [],
                  shot: b.shot || null,
                  sources: { evidence: 'scraped', prediction: 'derived',
                             boost: 'derived', owner: owner ? 'insights' : null } }];
    });
    let briefs = null;
    if (ai) {
        briefs = { summary: ai.summary, stopDoing: ai.stop_doing || [], captionRules: ai.caption_rules || [] };
        for (const f of spec.formats) briefs[f.plural] = stamp(ai[f.plural], f.key);
        briefs.removed = removed;
    }
    if (removed) logger.warn('content_plan_briefs_removed', { jobId, removed });

    await progress(92, 'Saving plan');
    const warnings = [];
    if (missingRivals.length) warnings.push(`Rivals with fewer than ${CP_MIN_ROWS} stored posts were ignored: ${missingRivals.map(display).join(', ')}. Run ${spec.sourceEngines} on them to include them.`);
    if (staleNames.length) warnings.push(`Stored data is older than ${CP_STALE_DAYS} days for: ${staleNames.join(', ')}. The plan reflects that period, not today.`);
    if (!aiStatus.ok) warnings.push(`Briefs unavailable: ${aiStatus.message}. The scorecard below is still complete.`);
    if (briefs?.removed) warnings.push(`${briefs.removed} draft brief(s) named a cell that is not in the evidence and were dropped.`);
    const payload = {
        platform, formatSpec: spec.formats.map(f => ({ key: f.key, plural: f.plural, label: f.label })),
        target, targetName: display(target), rivals: usedRivals, rivalNames: usedRivals.map(display), names, counts,
        sample: { target: T.length, rivals: R.length, provisionalDropped: all.length - settled.length },
        freshness, lists, formats, captions, owner, trueness, briefs, aiStatus, warnings,
        generatedAt: new Date().toISOString()
    };
    const { data: saved, error: saveErr } = await supabase.from('reports').insert([{
        user_id: userId,
        client_id: clientId,
        platform,
        report_type: 'content_plan',
        target_handle: platform === 'facebook' ? display(target) : target,
        competitor_handles: usedRivals.map(display),
        fb_page_ids: platform === 'facebook' ? [target, ...usedRivals] : null,
        fb_page_names: platform === 'facebook' ? [target, ...usedRivals].map(display) : null,
        posts_analyzed: settled.length,
        snapshot_date: new Date().toISOString().slice(0, 10),
        credits_estimate: 0,
        source_report_ids: Array.isArray(input.sourceReportIds) ? input.sourceReportIds.filter(x => UUID_RE.test(String(x))) : [],
        ai_summary: briefs?.summary || null,
        ai_json: briefs || null,
        ai_status: aiStatus,
        report_json: payload
    }]).select('id').maybeSingle();
    if (saveErr) { const e = new Error(`Plan computed but could not be saved: ${saveErr.message}`); e.statusCode = 500; throw e; }
    return { reportId: saved?.id || null, reportRef: saved?.id || null, aiStatus, platform };
});

app.post('/api/content-plan', spendLimit, async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'content_plan'); if (!ctx) return;
        await assertJobSlot(ctx.user.id);
        let platform = req.body.platform === 'facebook' ? 'facebook' : (req.body.platform === 'instagram' ? 'instagram' : null);
        const cleanIg = h => String(h || '').replace('@', '').replace(/\/+$/, '').trim().toLowerCase();
        const cleanFb = h => { const r = parsePageRef(h); return r ? r.pageId : ''; };
        const splitList = v => Array.isArray(v) ? v : String(v || '').split(/[\s,]+/);
        const sourceReportIds = [];
        let rep = null;

        // Start from an existing report: reuse its platform, target and rivals.
        if (req.body.reportId) {
            const { data } = await supabase.from('reports')
                .select('id, user_id, client_id, platform, target_handle, competitor_handles, fb_page_ids, report_type')
                .eq('id', req.body.reportId).maybeSingle();
            rep = data;
            if (!rep || !(await canReadReport(ctx, rep))) return res.status(404).json({ error: 'Source report not found.' });
            if (!platform) platform = rep.report_type === 'fb_page' ? 'facebook' : 'instagram';
            sourceReportIds.push(rep.id);
        }
        if (!platform) platform = 'instagram';
        const clean = platform === 'facebook' ? cleanFb : cleanIg;

        let target = clean(req.body.target);
        let rivals = splitList(req.body.rivals).map(clean).filter(Boolean);
        if (rep) {
            if (platform === 'facebook') {
                const ids = Array.isArray(rep.fb_page_ids) ? rep.fb_page_ids : [];
                target = target || ids[0] || '';
                if (!rivals.length) rivals = ids.slice(1);
            } else {
                target = target || cleanIg(rep.target_handle);
                if (!rivals.length) rivals = (rep.competitor_handles || []).map(cleanIg);
            }
        }
        if (!target) return res.status(400).json({ error: platform === 'facebook' ? 'Target Page URL or slug required.' : 'Target handle required.' });
        rivals = [...new Set(rivals.filter(h => h && h !== target))].slice(0, MAX_COMPETITORS);

        // Counts arrive either as { counts: { reels: 4, ... } } or flat keys (older page build).
        const counts = cpCounts(platform, { ...(req.body || {}), ...(req.body.counts || {}) });
        const clientId = await resolveClientId(req, ctx);

        const job = await createJob(ctx.user.id, 'content_plan', 'content_plan',
            { platform, target, rivals, counts, clientId, sourceReportIds, brief: String(req.body.brief || '').slice(0, 600) || null }, 0);
        runJob(job.id, JOB_WORKERS['content_plan'](ctx.user.id, job.input, job.id));
        res.status(202).json({ success: true, jobId: job.id, estimatedUsd: 0, platform, target, rivals, counts });
    } catch (err) { sendErr(res, err); }
});

app.get('/api/content-plans', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'content_plan'); if (!ctx) return;
        let q = supabase.from('reports')
            .select('id, user_id, client_id, platform, target_handle, competitor_handles, posts_analyzed, snapshot_date, created_at, ai_summary, ai_status, source_report_ids')
            .eq('report_type', 'content_plan');
        q = (await applyReportScope(req, ctx))(q);
        const { data, error } = await q.order('created_at', { ascending: false }).limit(100);
        if (error) throw error;
        res.json({ reports: data || [] });
    } catch (err) { sendErr(res, err); }
});

/**
 * Reports the content plan can be built on: the caller's own IG audits,
 * Competitor Intel and FB Page Reports, plus anything filed under the selected
 * client by a teammate. Each carries platform so the page can pick the right
 * format set.
 */
app.get('/api/content-plan/sources', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'content_plan'); if (!ctx) return;
        let q = supabase.from('reports')
            .select('id, user_id, platform, report_type, target_handle, competitor_handles, fb_page_ids, fb_page_names, created_at, client_id')
            .in('report_type', ['ig_report', 'deep_audit', 'fb_page']);
        const cid = req.query?.client_id;
        if (cid) {
            const c = await clientAccess(ctx.user.id, cid, 'viewer');
            if (!c) return res.status(403).json({ error: 'No access to that client.' });
            q = q.or(`client_id.eq.${c.id},user_id.eq.${ctx.user.id}`);
        } else {
            q = q.eq('user_id', ctx.user.id);
        }
        const { data, error } = await q.order('created_at', { ascending: false }).limit(80);
        if (error) throw error;
        res.json({ sources: (data || []).map(s => ({ ...s, platform: s.report_type === 'fb_page' ? 'facebook' : 'instagram', mine: s.user_id === ctx.user.id })) });
    } catch (err) { sendErr(res, err); }
});

app.get('/api/content-plan/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'content_plan'); if (!ctx) return;
        const { data } = await supabase.from('reports').select('*').eq('id', req.params.id).maybeSingle();
        if (!data || data.report_type !== 'content_plan' || !(await canReadReport(ctx, data))) return res.status(404).json({ error: 'Plan not found' });

        // Notes ship with the plan rather than behind a second request: they
        // are part of reading it, and a page that had to ask twice would
        // routinely render the plan without them.
        const { data: notes } = await supabase.from('content_plan_notes')
            .select('id, cell, body, author_name, created_at, updated_at, user_id')
            .eq('report_id', data.id).order('created_at', { ascending: true }).limit(200);

        res.json({ report: data, notes: notes || [] });
    } catch (err) { sendErr(res, err); }
});

// ---------------------------------------------------------------------------
// MANUAL RESEARCH FINDINGS
//
// A plan knows what was published and how it performed. It does not know what
// a customer said on the phone, that a rival quietly changed their pricing, or
// that the town has a festival in three weeks. Those arrive through a person.
//
// Kept in their own table and rendered as somebody's note, never folded into a
// computed index — the same separation rule 3 applies to scraped and owner
// metrics. A human observation is a third source, not a correction to the
// other two.
// ---------------------------------------------------------------------------

app.post('/api/content-plan/:id/notes', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'content_plan'); if (!ctx) return;
        if (!UUID_RE.test(String(req.params.id))) return res.status(400).json({ error: 'Bad plan id.' });

        const body = String(req.body?.body || '').trim().slice(0, 4000);
        if (!body) return res.status(400).json({ error: 'Write something first.' });

        const { data: plan } = await supabase.from('reports')
            .select('id, user_id, client_id, report_type').eq('id', req.params.id).maybeSingle();
        if (!plan || plan.report_type !== 'content_plan' || !(await canReadReport(ctx, plan))) {
            return res.status(404).json({ error: 'Plan not found' });
        }

        const { data, error } = await supabase.from('content_plan_notes').insert([{
            report_id: plan.id,
            user_id: ctx.user.id,
            client_id: plan.client_id || null,
            cell: req.body?.cell ? String(req.body.cell).slice(0, 200) : null,
            body,
            author_name: ctx.profile?.full_name || ctx.user.email || null
        }]).select().single();
        if (error) throw error;

        res.status(201).json({ success: true, note: data });
    } catch (err) { sendErr(res, err); }
});

app.patch('/api/content-plan/notes/:noteId', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'content_plan'); if (!ctx) return;
        if (!UUID_RE.test(String(req.params.noteId))) return res.status(400).json({ error: 'Bad note id.' });

        const body = String(req.body?.body || '').trim().slice(0, 4000);
        if (!body) return res.status(400).json({ error: 'Write something first.' });

        // Only the author edits, even where a colleague can read the plan.
        // Rewriting somebody else's observation and leaving their name on it
        // is worse than not being able to edit it at all.
        const { data: note } = await supabase.from('content_plan_notes')
            .select('id, user_id').eq('id', req.params.noteId).maybeSingle();
        if (!note) return res.status(404).json({ error: 'Note not found' });
        if (note.user_id !== ctx.user.id && ctx.profile?.role !== 'admin') {
            return res.status(403).json({ error: 'You can only edit your own notes.' });
        }

        const { data, error } = await supabase.from('content_plan_notes')
            .update({ body, updated_at: new Date().toISOString() })
            .eq('id', note.id).select().single();
        if (error) throw error;

        res.json({ success: true, note: data });
    } catch (err) { sendErr(res, err); }
});

app.delete('/api/content-plan/notes/:noteId', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'content_plan'); if (!ctx) return;
        if (!UUID_RE.test(String(req.params.noteId))) return res.status(400).json({ error: 'Bad note id.' });

        const { data: note } = await supabase.from('content_plan_notes')
            .select('id, user_id').eq('id', req.params.noteId).maybeSingle();
        if (!note) return res.status(404).json({ error: 'Note not found' });
        if (note.user_id !== ctx.user.id && ctx.profile?.role !== 'admin') {
            return res.status(403).json({ error: 'You can only delete your own notes.' });
        }

        await supabase.from('content_plan_notes').delete().eq('id', note.id);
        res.json({ success: true });
    } catch (err) { sendErr(res, err); }
});

// ===========================================================================
// PHASE 42 :: THE PLAN AS A CALENDAR THE OWNER APPROVES
//
// A plan used to end at a list of briefs. Now each brief becomes a post on a
// date (the brief's own best slot where it names one, else spread over four
// weeks), the owner approves, asks for changes or skips it from their portal,
// an approved post becomes a task for the team, and a posted one carries its
// link, so the monthly report can say how the planned posts actually did.
// ===========================================================================

const CP_POST_STATUS = [['idea', 'Waiting for approval'], ['changes', 'Changes asked'], ['approved', 'Approved'], ['made', 'Made'], ['posted', 'Posted'], ['skipped', 'Skipped']];
const cpStatusName = s => (CP_POST_STATUS.find(x => x[0] === s) || [s, s])[1];
const CP_DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** A brief's slot ("Tue 7pm", "Friday 20:00") as a weekday and a time. */
function cpParseSlot(slot) {
    const s = String(slot || '').toLowerCase();
    const d = /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*/.exec(s);
    const t = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\b/.exec(s.replace(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*/, ''));
    let time = null;
    if (t) {
        let h = +t[1]; const m = t[2] ? +t[2] : 0;
        if (t[3] === 'pm' && h < 12) h += 12;
        if (t[3] === 'am' && h === 12) h = 0;
        if (h <= 23 && m <= 59) time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
    return { dow: d ? CP_DOW[d[1]] : null, time };
}

/**
 * Dates for a plan's briefs, from `start`, over four weeks. A brief keeps its
 * own weekday when it names one; no two posts share a day unless a week is
 * fuller than seven. Pure.
 */
function cpScheduleDates(briefs, start) {
    const s = new Date(String(start).slice(0, 10) + 'T00:00:00Z');
    const monday = new Date(s); monday.setUTCDate(s.getUTCDate() - ((s.getUTCDay() + 6) % 7));
    const weeks = 4, n = briefs.length, used = new Set();
    const order = [2, 4, 6, 1, 3, 5, 0];      // Tue, Thu, Sat, Mon, Wed, Fri, Sun
    const day = d => d.toISOString().slice(0, 10);
    return briefs.map((b, i) => {
        const week = Math.min(weeks - 1, Math.floor(i * weeks / Math.max(1, n)));
        const slot = cpParseSlot(b.slot);
        const tryDows = slot.dow !== null ? [slot.dow, ...order.filter(x => x !== slot.dow)] : order;
        for (let w = week; w < week + 3; w++) {
            for (const dow of tryDows) {
                const d = new Date(monday); d.setUTCDate(monday.getUTCDate() + w * 7 + ((dow + 6) % 7));
                if (d < s || used.has(day(d))) continue;
                used.add(day(d));
                return { plannedOn: day(d), time: slot.time };
            }
        }
        const d = new Date(s); d.setUTCDate(s.getUTCDate() + i);
        return { plannedOn: day(d), time: slot.time };
    });
}

async function contentPostsReady() {
    const { error } = await supabase.from('content_posts').select('id').limit(1);
    return !error;
}
function contentPostsMissing(res) {
    return res.status(503).json({ error: 'The content calendar needs the phase-42 database update. Run sql/schema-phase42.sql in the Supabase SQL editor.', code: 'migration_required' });
}

/** The staff view of a planned post. */
function contentPostView(p) {
    const b = p.brief || {};
    return {
        id: p.id, planId: p.report_id, clientId: p.client_id || null, key: p.brief_key, format: p.format || null,
        hook: p.hook || null, caption: p.caption || null, plannedOn: p.planned_on, time: p.planned_time || null,
        status: p.status, statusName: cpStatusName(p.status), ownerNote: p.owner_note || null,
        decidedBy: p.decided_by || null, decidedAt: p.decided_at || null, taskId: p.task_id || null,
        postedUrl: p.posted_url || null, postedAt: p.posted_at || null,
        brief: { concept: b.concept || null, script: b.script || [], shot: b.shot || null, why: b.why || null, evidence: b.evidence || [], band: b.predicted_band || null, boost: b.boost || null, cell: b.cell || null,
                 topic: b.topic || null, category: b.category || null, tools: b.tools || [], from: b.from || null },
        pickId: p.pick_id || null
    };
}

/** The owner's view: what the post is and what is asked of them. No people, no plan ids. */
function contentPostOwnerView(p) {
    const b = p.brief || {};
    return {
        id: p.id, plannedOn: p.planned_on, time: p.planned_time || null, format: p.format || null,
        hook: p.hook || null, caption: p.caption || null, shot: b.shot || null, why: b.why || null,
        status: p.status, statusName: p.status === 'idea' ? 'Waiting for your OK' : cpStatusName(p.status),
        yourNote: p.owner_note || null, postedUrl: p.posted_url || null
    };
}

/** Who makes an approved post: a staff member who can still edit the client, or nobody. */
async function contentPostAssignee(p) {
    const candidates = [];
    if (p.report_id) {
        const { data: r } = await supabase.from('reports').select('user_id').eq('id', p.report_id).maybeSingle();
        if (r && r.user_id) candidates.push(r.user_id);
    }
    if (p.pick_id) {
        const { data: k } = await supabase.from('content_picks').select('created_by').eq('id', p.pick_id).maybeSingle();
        if (k && k.created_by) candidates.push(k.created_by);
    }
    const { data: c } = await supabase.from('clients').select('owner_user_id').eq('id', p.client_id).maybeSingle();
    if (c && c.owner_user_id) candidates.push(c.owner_user_id);
    for (const id of candidates) {
        if ((await userRole(id)) === 'client') continue;
        if (await clientAccess(id, p.client_id, 'editor')) return id;
    }
    return null;
}

/**
 * The task made for a post, moved on the board: the post follows (phase 53).
 * Done means made; reopened means approved again. A post already posted, or one
 * the owner sent back, is left alone — the board does not overrule them.
 */
async function syncPostFromTask(task, before) {
    const m = /^post:([0-9a-f-]{36})$/i.exec(String(task.source_key || ''));
    if (!m || task.status === before) return;
    const now = new Date().toISOString();
    if (task.status === 'done') {
        await supabase.from('content_posts').update({ status: 'made', updated_at: now }).eq('id', m[1]).eq('status', 'approved');
    } else if (before === 'done') {
        await supabase.from('content_posts').update({ status: 'approved', updated_at: now }).eq('id', m[1]).eq('status', 'made');
    }
}

/** Approving a post puts "make it" on the team's board, once. */
async function contentPostTask(p, byUserId) {
    if (!p.client_id || p.task_id) return p.task_id || null;
    const key = 'post:' + p.id;
    // The post id is unique, so the key alone finds it; a post from a pick (phase 43) has no plan report.
    const { data: dup } = await supabase.from('client_tasks').select('id').eq('client_id', p.client_id).eq('source_key', key).maybeSingle();
    if (dup) return dup.id;
    const b = p.brief || {};
    const due = new Date(p.planned_on + 'T00:00:00Z'); due.setUTCDate(due.getUTCDate() - 2);
    const today = new Date().toISOString().slice(0, 10);
    // Phase 53: the task goes to someone. Whoever planned the post (the plan's or the pick's author)
    // if they are still on the team, else the client's account lead; never the business owner.
    const assignee = await contentPostAssignee(p);
    const notes = [b.topic ? `Topic: ${b.topic}` : null, b.concept, b.shot ? 'Shot: ' + b.shot : null, (b.tools || []).length ? 'Tools: ' + b.tools.join(', ') : null, (b.script || []).length ? 'Script:\n' + b.script.map((x, i) => `${i + 1}. ${x}`).join('\n') : null, p.caption ? 'Caption:\n' + p.caption : null]
        .filter(Boolean).join('\n\n').slice(0, 4000);
    const { data, error } = await supabase.from('client_tasks').insert([{
        client_id: p.client_id, title: oneLine(`Make the ${String(p.format || 'post').toLowerCase()}: ${p.hook || 'planned post'}`, 300),
        notes, status: 'todo', due_date: due.toISOString().slice(0, 10) < today ? today : due.toISOString().slice(0, 10),
        labels: ['Content'], checklist: [], assignee_user_id: assignee, assigned_to_client: false, visible_to_client: false,
        source_type: p.report_id ? 'report' : null, source_id: p.report_id || null, source_key: key, source_label: `Content plan · ${S.docDay(p.planned_on + 'T00:00:00Z')}`,
        position: await endOfColumn(p.client_id, 'todo'), created_by: byUserId || null
    }]).select('id').maybeSingle();
    if (error) { logger.warn('content_task_failed', { postId: p.id, message: error.message }); return null; }
    return data ? data.id : null;
}

/** Move a post; the decision, the task and the link follow from the status. */
async function contentPostMove(p, status, { by = 'team', userId = null, note, postedUrl } = {}) {
    const now = new Date().toISOString();
    const patch = { status, updated_at: now };
    if (['approved', 'changes', 'skipped'].includes(status)) { patch.decided_by = by; patch.decided_at = now; }
    if (note !== undefined && by === 'owner') patch.owner_note = note ? String(note).slice(0, 2000) : null;
    if (status === 'approved' || status === 'made' || status === 'posted') {
        const taskId = await contentPostTask({ ...p, ...patch }, userId);
        if (taskId) patch.task_id = taskId;
    }
    if (status === 'posted') {
        patch.posted_at = p.posted_at || now;
        if (postedUrl !== undefined) {
            const u = String(postedUrl || '').trim();
            patch.posted_url = /^https:\/\/(www\.)?(instagram|facebook)\.com\//i.test(u) ? u.slice(0, 500) : null;
            const m = /instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/.exec(u);
            patch.shortcode = m ? m[1] : null;
        }
        const taskId = patch.task_id || p.task_id;
        if (taskId) await supabase.from('client_tasks').update({ status: 'done', completed_at: now, updated_at: now }).eq('id', taskId);
    }
    const { data } = await supabase.from('content_posts').update(patch).eq('id', p.id).select().maybeSingle();
    return data || { ...p, ...patch };
}

/**
 * The month's planned posts and how the posted ones did: public likes and
 * comments from the posts collected, and owner reach where Meta is
 * connected — side by side, never blended (rule 3).
 */
async function contentPlanMonth(clientId, month) {
    if (!clientId || !/^\d{4}-\d{2}$/.test(String(month || ''))) return null;
    const [y, m] = month.split('-').map(Number);
    const from = `${month}-01`, to = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    const { data, error } = await supabase.from('content_posts').select('*').eq('client_id', clientId).gte('planned_on', from).lt('planned_on', to);
    if (error || !data || !data.length) return null;
    const codes = data.map(p => p.shortcode).filter(Boolean);
    const [{ data: pub }, { data: own }] = codes.length ? await Promise.all([
        supabase.from('posts').select('shortcode, likes, comments, views').in('shortcode', codes),
        supabase.from('meta_media').select('shortcode, insights').in('shortcode', codes)
    ]) : [{ data: [] }, { data: [] }];
    const items = data.sort((a, b) => String(a.planned_on).localeCompare(String(b.planned_on))).map(p => {
        const s = (pub || []).find(x => x.shortcode === p.shortcode) || null;
        const o = (own || []).find(x => x.shortcode === p.shortcode) || null;
        return { plannedOn: p.planned_on, format: p.format || null, hook: p.hook || null, status: p.status,
            url: p.posted_url || null, likes: s ? s.likes ?? null : null, comments: s ? s.comments ?? null : null,
            reach: o && o.insights ? S.docNum(o.insights.reach) : null, band: (p.brief || {}).predicted_band || null };
    });
    const n = st => items.filter(i => i.status === st).length;
    return { planned: items.length, approved: items.filter(i => ['approved', 'made', 'posted'].includes(i.status)).length,
        posted: n('posted'), skipped: n('skipped'), waiting: n('idea') + n('changes'), items };
}

/** The month's planned posts as document blocks, shared by both monthly reports. */
function cpDocBlocks(cp) {
    if (!cp || !cp.planned) return null;
    const hasReach = cp.items.some(i => i.reach != null);
    const tone = st => (st === 'posted' ? 'good' : st === 'skipped' ? '' : st === 'changes' || st === 'idea' ? 'watch' : 'gold');
    return [
        { type: 'kpis', items: [
            { label: 'Posts planned', value: S.docFmt(cp.planned), sub: 'from the content plan' },
            { label: 'Approved', value: S.docFmt(cp.approved), sub: cp.waiting ? `${cp.waiting} still waiting for an OK` : 'all decided', tone: cp.waiting ? 'watch' : 'good' },
            { label: 'Posted', value: S.docFmt(cp.posted), sub: cp.planned ? `${Math.round(cp.posted / cp.planned * 100)}% of the plan` : '', tone: cp.posted ? 'good' : '' },
            cp.skipped ? { label: 'Skipped', value: S.docFmt(cp.skipped), sub: 'left out on purpose' } : null
        ].filter(Boolean) },
        { type: 'table', cols: [{ label: 'Planned for' }, { label: 'Post' }, { label: 'Status' }, { label: 'Likes', num: true }, { label: 'Comments', num: true }].concat(hasReach ? [{ label: 'Reach (your Meta)', num: true }] : []),
            rows: cp.items.slice(0, 20).map(i => [S.docDay(i.plannedOn + 'T00:00:00Z'), `${i.format ? i.format + ': ' : ''}${oneLine(i.hook, 90) || '—'}`, { chip: cpStatusName(i.status), tone: tone(i.status) },
                i.likes == null ? '—' : S.docFmt(i.likes), i.comments == null ? '—' : S.docFmt(i.comments)].concat(hasReach ? [i.reach == null ? '—' : S.docFmt(i.reach)] : [])) },
        { type: 'note', text: `Likes and comments are the public counts for posts we have the link for${hasReach ? '; reach is from your own Meta numbers, shown beside them and never added together' : ''}.` }
    ];
}

async function planForCalendar(ctx, id, need = 'viewer') {
    if (!UUID_RE.test(String(id || ''))) return null;
    const { data } = await supabase.from('reports').select('id, user_id, client_id, report_type, report_json, ai_json').eq('id', id).maybeSingle();
    if (!data || data.report_type !== 'content_plan' || !(await canReadReport(ctx, data))) return null;
    if (need === 'editor' && data.client_id && !(await clientAccess(ctx.user.id, data.client_id, 'editor'))) return null;
    if (need === 'editor' && !data.client_id && data.user_id !== ctx.user.id && ctx.profile?.role !== 'admin') return null;
    return data;
}

app.get('/api/content-plan/:id/calendar', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'content_plan'); if (!ctx) return;
        if (!(await contentPostsReady())) return contentPostsMissing(res);
        const plan = await planForCalendar(ctx, req.params.id);
        if (!plan) return res.status(404).json({ error: 'Plan not found' });
        const { data } = await supabase.from('content_posts').select('*').eq('report_id', plan.id).order('planned_on', { ascending: true });
        res.json({ posts: (data || []).map(contentPostView), statuses: CP_POST_STATUS, hasClient: !!plan.client_id });
    } catch (err) { sendErr(res, err); }
});

/** Put a plan's briefs on dates. Pressing it again adds only briefs not yet on it. */
app.post('/api/content-plan/:id/calendar', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'content_plan'); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        if (!(await contentPostsReady())) return contentPostsMissing(res);
        const plan = await planForCalendar(ctx, req.params.id, 'editor');
        if (!plan) return res.status(404).json({ error: 'Plan not found, or you cannot edit it.' });
        const p = plan.report_json || {};
        const b = p.briefs || plan.ai_json || {};
        const spec = Array.isArray(p.formatSpec) && p.formatSpec.length ? p.formatSpec : [{ key: 'Reel', plural: 'reels' }, { key: 'Carousel', plural: 'carousels' }, { key: 'Still', plural: 'stills' }];
        const briefs = spec.flatMap(f => (Array.isArray(b[f.plural]) ? b[f.plural] : []).map((x, i) => ({ ...x, _key: `${f.plural}:${i}`, _format: f.label || f.key })));
        if (!briefs.length) return res.status(400).json({ error: 'This plan has no briefs to schedule.' });
        const start = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.start || '')) ? req.body.start : new Date(Date.now() + 86400000).toISOString().slice(0, 10);
        const { data: have } = await supabase.from('content_posts').select('brief_key').eq('report_id', plan.id);
        const taken = new Set((have || []).map(x => x.brief_key));
        const todo = briefs.filter(x => !taken.has(x._key));
        const dates = cpScheduleDates(todo, start);
        const rows = todo.map((x, i) => ({
            report_id: plan.id, client_id: plan.client_id || null, brief_key: x._key, format: String(x._format).replace(/s$/, ''),
            hook: oneLine(x.hook || x.concept, 300) || null, caption: x.caption ? String(x.caption).slice(0, 4000) : null,
            brief: { concept: x.concept || null, script: Array.isArray(x.script) ? x.script.slice(0, 8) : [], shot: x.shot || null, why: x.why || null,
                evidence: (x.evidence || []).slice(0, 3), predicted_band: x.predicted_band || null, boost: x.boost || null, cell: x.cell || null, slot: x.slot || null },
            planned_on: dates[i].plannedOn, planned_time: dates[i].time, status: 'idea', created_by: ctx.user.id
        }));
        if (rows.length) {
            const { error } = await supabase.from('content_posts').insert(rows);
            if (error) throw error;
        }
        const { data } = await supabase.from('content_posts').select('*').eq('report_id', plan.id).order('planned_on', { ascending: true });
        res.status(rows.length ? 201 : 200).json({ added: rows.length, posts: (data || []).map(contentPostView) });
    } catch (err) { sendErr(res, err); }
});

app.patch('/api/content-posts/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'content_plan'); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        if (!(await contentPostsReady())) return contentPostsMissing(res);
        if (!UUID_RE.test(String(req.params.id))) return res.status(404).json({ error: 'Post not found.' });
        const { data: p } = await supabase.from('content_posts').select('*').eq('id', req.params.id).maybeSingle();
        const may = p && (p.report_id ? await planForCalendar(ctx, p.report_id, 'editor') : await clientAccess(ctx.user.id, p.client_id, 'editor'));
        if (!may) return res.status(404).json({ error: 'Post not found, or you cannot edit it.' });
        const b = req.body || {};
        const patch = {};
        if (b.plannedOn !== undefined) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.plannedOn))) return res.status(400).json({ error: 'The date is not valid.' });
            patch.planned_on = b.plannedOn;
        }
        if (b.time !== undefined) patch.planned_time = /^\d{2}:\d{2}$/.test(String(b.time || '')) ? b.time : null;
        if (b.hook !== undefined) patch.hook = oneLine(b.hook, 300) || null;
        if (b.caption !== undefined) patch.caption = b.caption ? String(b.caption).slice(0, 4000) : null;
        if (Object.keys(patch).length) {
            patch.updated_at = new Date().toISOString();
            await supabase.from('content_posts').update(patch).eq('id', p.id);
            Object.assign(p, patch);
        }
        let row = p;
        if (b.status !== undefined && b.status !== p.status) {
            if (!CP_POST_STATUS.some(s => s[0] === b.status)) return res.status(400).json({ error: 'That status does not exist.' });
            row = await contentPostMove(p, b.status, { by: 'team', userId: ctx.user.id, postedUrl: b.postedUrl });
        } else if (b.postedUrl !== undefined && p.status === 'posted') {
            row = await contentPostMove(p, 'posted', { by: 'team', userId: ctx.user.id, postedUrl: b.postedUrl });
        }
        res.json({ post: contentPostView(row) });
    } catch (err) { sendErr(res, err); }
});

// --- the owner's side -----------------------------------------------------------

app.get('/api/client/content', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        if (ctx.profile?.role !== 'client') return res.status(403).json({ error: 'This is the business owner’s view.' });
        if (!(await contentPostsReady())) return res.json({ posts: [] });
        const own = await ownClientFor(ctx);
        if (!own) return res.json({ posts: [] });
        const since = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
        const { data } = await supabase.from('content_posts').select('*').eq('client_id', own.id).gte('planned_on', since)
            .neq('status', 'skipped').order('planned_on', { ascending: true }).limit(60);
        const posts = (data || []).map(contentPostOwnerView);
        res.json({ posts, waiting: posts.filter(p => p.status === 'idea').length });
    } catch (err) { sendErr(res, err); }
});

app.post('/api/client/content/:id/decision', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        if (ctx.profile?.role !== 'client') return res.status(403).json({ error: 'This is the business owner’s view.' });
        if (!(await contentPostsReady())) return contentPostsMissing(res);
        const own = await ownClientFor(ctx);
        if (!own || !UUID_RE.test(String(req.params.id))) return res.status(404).json({ error: 'Post not found.' });
        const { data: p } = await supabase.from('content_posts').select('*').eq('id', req.params.id).eq('client_id', own.id).maybeSingle();
        if (!p) return res.status(404).json({ error: 'Post not found.' });
        const to = { approve: 'approved', changes: 'changes', skip: 'skipped' }[String(req.body?.decision || '')];
        if (!to) return res.status(400).json({ error: 'Choose approve, changes or skip.' });
        if (['made', 'posted'].includes(p.status)) return res.status(409).json({ error: 'This post is already made.' });
        const note = req.body?.note ? String(req.body.note).trim().slice(0, 2000) : null;
        if (to === 'changes' && !note) return res.status(400).json({ error: 'Say what you would like changed.' });
        const row = await contentPostMove(p, to, { by: 'owner', note });
        res.json({ post: contentPostOwnerView(row) });
    } catch (err) { sendErr(res, err); }
});

// ===========================================================================
// PHASE 43 :: THE CONTENT PLAN THE WAY THE AGENCY WORKS
//
// The scorecard says what works in a market. This is the part before it:
// what the business is and sells (from an audit of its website and posts,
// corrected by the team), the topics by category that follow from that, and
// one idea per topic picked from the team's shared idea library — content
// seen anywhere, from any brand or industry, with its hook, why it worked,
// the post type and the tools it needs. The team adds its own idea, script
// and style notes before a pick is final; a final pick goes onto the
// calendar, where the owner approves the post (phase 42).
//
// The system chooses topics and suggests ideas. It never makes the content.
// ===========================================================================

const CS_CATEGORIES = [['service', 'Services'], ['educational', 'Educational'], ['reviews', 'Reviews and growth'], ['generic', 'Generic'], ['collab', 'Influencer collab']];
const CS_TYPES = [['static', 'Static'], ['carousel', 'Carousel'], ['video', 'Video'], ['story', 'Story']];
const CS_TYPE_NAME = Object.fromEntries(CS_TYPES);
const CS_CAT_NAME = Object.fromEntries(CS_CATEGORIES);
/** The post types a category tends to need, best first. */
const CS_TYPE_PREF = {
    service: ['video', 'carousel', 'static'], educational: ['carousel', 'video', 'static'],
    reviews: ['story', 'video', 'static'], generic: ['static', 'story', 'carousel'], collab: ['video', 'story']
};
/** The short tool suggestion when an idea names none. */
const CS_DEFAULT_TOOLS = {
    static: ['Canva'], carousel: ['Canva'], video: ['Phone camera', 'CapCut'], story: ['Instagram stickers', 'Phone camera']
};
/** Scorecard formats as library post types. */
const CS_FORMAT_TYPE = { Reel: 'video', Carousel: 'carousel', Still: 'static', Video: 'video', Photo: 'static', Album: 'carousel' };
const CS_STOP = new Set('the and for with this that your you our are was were from have has had not but all any can will just into out about more most what when where which who how why its it’s them they their then than there here also very much some such only over under after before again a an of to in on at by is be as or if so no do we us my me'.split(' '));
const CS_MAX_LIBRARY = 3000;

/** A post type from whatever a person or a spreadsheet calls it; the link decides when nothing does. */
function csType(v, url) {
    const s = String(v || '').toLowerCase().trim();
    if (/stor/.test(s)) return 'story';
    if (/carou|slide|album|swipe/.test(s)) return 'carousel';
    if (/reel|video|tiktok|short|clip/.test(s)) return 'video';
    if (/static|still|photo|image|post|single|graphic/.test(s)) return 'static';
    const u = String(url || '');
    if (/instagram\.com\/stories\//i.test(u)) return 'story';
    if (/instagram\.com\/(reel|tv)\/|tiktok\.com|youtube\.com\/shorts|facebook\.com\/(reel|watch)/i.test(u)) return 'video';
    return s ? null : 'static';
}
/** Short labels from an array or "a, b; c". */
function csList(v, { max = 8, len = 40, lower = false } = {}) {
    const raw = Array.isArray(v) ? v : String(v || '').split(/[,;|\n]+/);
    const out = [];
    for (const x of raw) {
        let t = oneLine(String(x || '').replace(/^#/, ''), len);
        if (!t) continue;
        if (lower) t = t.toLowerCase();
        if (!out.some(o => o.toLowerCase() === t.toLowerCase())) out.push(t);
        if (out.length >= max) break;
    }
    return out;
}
function csUrl(v) {
    const u = String(v || '').trim();
    return /^https?:\/\/[^\s]+$/i.test(u) ? u.slice(0, 500) : null;
}
const csMonth = v => (/^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || '')) ? String(v) : new Date().toISOString().slice(0, 7));
const csWords = text => [...new Set(String(text || '').toLowerCase().normalize('NFKD').split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 2 && !CS_STOP.has(w)))];

/** One library idea from a request body or a spreadsheet row. Null when it holds nothing to go on. */
function csIdeaRow(b) {
    const url = csUrl(b.url);
    const hook = oneLine(b.hook, 300) || null;
    if (!url && !hook) return null;
    return {
        url, hook,
        source_name: oneLine(String(b.source_name ?? b.sourceName ?? '').replace(/^@/, ''), 120) || S.igHandleFromUrl(url) || null,
        industry: oneLine(b.industry, 80) || null,
        post_type: csType(b.post_type ?? b.postType ?? b.type, url) || 'static',
        why_worked: b.why_worked ?? b.whyWorked ? String(b.why_worked ?? b.whyWorked).trim().slice(0, 600) || null : null,
        style: b.style ? String(b.style).trim().slice(0, 600) || null : null,
        tools: csList(b.tools, { max: 6 }),
        tags: csList(b.tags, { max: 12, lower: true })
    };
}
function csIdeaView(r, { names = {}, uses = {}, me = null } = {}) {
    return {
        id: r.id, url: r.url || null, sourceName: r.source_name || null, industry: r.industry || null,
        postType: r.post_type, postTypeName: CS_TYPE_NAME[r.post_type] || r.post_type,
        hook: r.hook || null, whyWorked: r.why_worked || null, style: r.style || null,
        tools: r.tools || [], tags: r.tags || [], savedBy: names[r.saved_by] || null, mine: !!me && r.saved_by === me,
        uses: uses[r.id] || 0, createdAt: r.created_at
    };
}

/** A small CSV reader: quotes, doubled quotes, commas and newlines inside quotes. */
function csParseCsv(text) {
    const s = String(text || '').replace(/^﻿/, '');
    const rows = []; let row = [], cell = '', q = false;
    const tab = !s.split('\n')[0].includes(',') && s.split('\n')[0].includes('\t');
    const sep = tab ? '\t' : ',';
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (q) {
            if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; }
            else if (ch === '"') q = false;
            else cell += ch;
        } else if (ch === '"') q = true;
        else if (ch === sep) { row.push(cell); cell = ''; }
        else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && s[i + 1] === '\n') i++;
            row.push(cell); cell = '';
            if (row.some(c => c.trim())) rows.push(row);
            row = [];
        } else cell += ch;
    }
    row.push(cell);
    if (row.some(c => c.trim())) rows.push(row);
    return rows;
}
/** Which library field a spreadsheet header means. The first header to claim a field keeps it. */
const CS_HEADERS = [
    ['url', /^(url|link|links|post|post ?link|post ?url|reference|ref|source ?link)$/],
    ['post_type', /(post ?type|content ?type|format|^type$|^kind$)/],
    ['source_name', /(brand|account|handle|creator|^page$|seen ?at|^source$|^from$|^who$)/],
    ['industry', /(industry|niche|sector|business ?type)/],
    ['hook', /(hook|headline|^idea$|^title$|concept|opening)/],
    ['why_worked', /(why|learning|insight|takeaway|^notes?$|^comments?$|observation|what worked)/],
    ['style', /(style|structure|script|how|treatment|format notes)/],
    ['tools', /(tool|app|software|editor)/],
    ['tags', /(tag|topic|categor|theme|pillar|keyword)/]
];
function csImportRows(text, max = 2000) {
    const rows = csParseCsv(text);
    if (rows.length < 2) return { rows: [], mapped: {}, skipped: 0 };
    const head = rows[0].map(h => String(h || '').trim().toLowerCase());
    const col = {};
    head.forEach((h, i) => {
        const hit = CS_HEADERS.find(([f, re]) => !(f in col) && re.test(h));
        if (hit) col[hit[0]] = i;
    });
    // A link column the header did not name: the first column full of links.
    if (!('url' in col)) {
        const i = head.findIndex((_, k) => !Object.values(col).includes(k) && rows.slice(1, 6).some(r => /^https?:\/\//i.test(String(r[k] || '').trim())));
        if (i >= 0) col.url = i;
    }
    const out = []; let skipped = 0;
    for (const r of rows.slice(1, max + 1)) {
        const get = f => (f in col ? String(r[col[f]] ?? '').trim() : '');
        const idea = csIdeaRow({ url: get('url'), hook: get('hook'), source_name: get('source_name'), industry: get('industry'),
            post_type: get('post_type'), why_worked: get('why_worked'), style: get('style'), tools: get('tools'), tags: get('tags') });
        if (idea) out.push(idea); else skipped++;
    }
    return { rows: out, mapped: Object.fromEntries(Object.entries(col).map(([f, i]) => [f, rows[0][i]])), skipped };
}

/**
 * How well a library idea serves a topic. Pure, so the ranking can be read
 * and tested: the post type the category needs, the format rivals win with,
 * words the idea and the topic share, and a penalty for an idea this client
 * already used.
 */
function csRank(topic, ideas, { market = null, used = {}, month = {} } = {}) {
    const pref = CS_TYPE_PREF[topic.category] || [];
    const words = new Set(csWords(`${topic.title} ${topic.detail || ''} ${CS_CAT_NAME[topic.category] || ''}`));
    const best = market && market.bestType;
    return ideas.map(i => {
        let score = 0; const reasons = [];
        const at = pref.indexOf(i.post_type);
        if (at === 0) { score += 3; reasons.push(`${CS_TYPE_NAME[i.post_type]} suits ${CS_CAT_NAME[topic.category].toLowerCase()} posts`); }
        else if (at > 0) score += 2 - Math.min(1.5, at * 0.5);
        if (best && i.post_type === best) { score += 1.5; reasons.push(`${CS_TYPE_NAME[best]} is what wins for rivals here`); }
        const tags = (i.tags || []).map(t => t.toLowerCase());
        if (tags.includes(topic.category) || tags.some(t => csWords(CS_CAT_NAME[topic.category]).includes(t))) { score += 3; reasons.push(`Tagged for ${CS_CAT_NAME[topic.category].toLowerCase()}`); }
        const tagHits = tags.filter(t => csWords(t).some(w => words.has(w)));
        if (tagHits.length) { score += Math.min(4, tagHits.length * 2); reasons.push(`Tagged ${tagHits.slice(0, 3).join(', ')}`); }
        const textHits = csWords(`${i.hook || ''} ${i.why_worked || ''} ${i.style || ''}`).filter(w => words.has(w));
        if (textHits.length) { score += Math.min(3, textHits.length); if (!tagHits.length) reasons.push(`Mentions ${textHits.slice(0, 3).join(', ')}`); }
        if (month[i.id]) { score -= 3; reasons.push('Already picked this month'); }
        else if (used[i.id]) { score -= 1; reasons.push('Used for this client before'); }
        const fit = score >= 5 ? 'good' : score >= 3 ? 'ok' : 'weak';
        return { idea: i, score: +score.toFixed(2), fit, reasons };
    }).sort((a, b) => b.score - a.score || String(b.idea.created_at || '').localeCompare(String(a.idea.created_at || '')));
}
/** The short tool suggestion: the idea's own tools first, then the usual ones for its type. At most three. */
function csToolsFor(type, idea) {
    return [...new Set([...(idea && idea.tools || []), ...(CS_DEFAULT_TOOLS[type] || [])])].slice(0, 3);
}

/**
 * What works in this market, from the client's newest scorecard plan: the
 * format rivals win with, their best topics and hours, and the gaps. Null
 * when no plan exists yet.
 */
async function csMarket(clientId) {
    const { data } = await supabase.from('reports').select('id, created_at, report_json').eq('client_id', clientId)
        .eq('report_type', 'content_plan').order('created_at', { ascending: false }).limit(1);
    const rep = data && data[0];
    const p = rep && rep.report_json;
    if (!p) return null;
    const spec = Array.isArray(p.formatSpec) && p.formatSpec.length ? p.formatSpec : [{ key: 'Reel', plural: 'reels', label: 'Reels' }, { key: 'Carousel', plural: 'carousels', label: 'Carousels' }, { key: 'Still', plural: 'stills', label: 'Stills' }];
    const formats = spec.map(f => {
        const x = (p.formats || {})[f.plural] || {};
        return { key: f.key, label: f.label, type: CS_FORMAT_TYPE[f.key] || null,
            share: { target: x.share?.target ?? null, rivals: x.share?.rivals ?? null },
            index: { target: x.score?.target?.dampedIndex ?? null, rivals: x.score?.rivals?.dampedIndex ?? null },
            bestHour: (x.byHour || [])[0]?.hour || null };
    });
    const ranked = formats.filter(f => f.index.rivals != null && f.type).sort((a, b) => b.index.rivals - a.index.rivals);
    const topics = ((p.captions || {}).topics || {}).rivals || [];
    return {
        planId: rep.id, builtAt: rep.created_at, rivals: p.rivalNames || (p.rivals || []).map(r => '@' + r), formats,
        bestType: ranked[0] && ranked[0].index.rivals >= 1.05 ? ranked[0].type : null,
        topics: topics.filter(t => t.topic && t.topic !== 'general').slice(0, 6).map(t => ({ topic: t.topic, index: t.dampedIndex ?? null, n: t.n })),
        gaps: ((p.lists || {}).gaps || []).slice(0, 5).map(c => ({ format: c.format, topic: c.topic, opening: c.opening, index: c.rivals?.dampedIndex ?? null })),
        stale: !!(p.freshness && [p.freshness.target, ...(p.freshness.rivals || [])].some(x => x && x.stale))
    };
}

async function csReady() {
    const [a, b] = await Promise.all([supabase.from('content_picks').select('id').limit(1), supabase.from('content_posts').select('pick_id').limit(1)]);
    return !a.error && !b.error;
}
function csMissing(res) {
    return res.status(503).json({ error: 'The content workflow needs the phase-43 database update. Run sql/schema-phase43.sql in the Supabase SQL editor.', code: 'migration_required' });
}
/** The client, when this person may read (or, with 'editor', change) its plan. */
async function csClient(ctx, id, need = 'viewer') {
    if (!UUID_RE.test(String(id || ''))) return null;
    return clientAccess(ctx.user.id, id, need);
}
async function csNames(ids) {
    const want = [...new Set(ids.filter(Boolean))];
    if (!want.length) return {};
    const { data } = await supabase.from('app_users').select('id, email, full_name').in('id', want);
    return Object.fromEntries((data || []).map(u => [u.id, u.full_name || String(u.email || '').split('@')[0]]));
}
async function csLibrary(limit = CS_MAX_LIBRARY) {
    const { data } = await supabase.from('content_ideas').select('*').order('created_at', { ascending: false }).limit(limit);
    return data || [];
}
const csEmptyBusiness = b => !b || (!b.summary && !(b.offers || []).length);
function csBusiness(v) {
    const b = v && typeof v === 'object' ? v : {};
    return {
        summary: b.summary ? String(b.summary).trim().slice(0, 800) : null,
        model: b.model ? String(b.model).trim().slice(0, 300) : null,
        audience: b.audience ? String(b.audience).trim().slice(0, 300) : null,
        voice: b.voice ? String(b.voice).trim().slice(0, 200) : null,
        offers: (Array.isArray(b.offers) ? b.offers : []).map(o => ({ name: oneLine(o && o.name, 120), price: oneLine(o && o.price, 60) || null, note: oneLine(o && o.note, 200) || null }))
            .filter(o => o.name).slice(0, 20),
        differentiators: csList(b.differentiators, { max: 8, len: 200 }),
        proof: csList(b.proof, { max: 8, len: 200 })
    };
}
function csTopicView(t, suggestions) {
    return {
        id: t.id, category: t.category, categoryName: CS_CAT_NAME[t.category], title: t.title, detail: t.detail || null, why: t.why || null,
        priority: t.priority, active: !!t.active, source: t.source, suggestedAt: t.suggested_at || null, ideas: suggestions || []
    };
}
function csPickView(p, { ideas = {}, topics = {}, post = null } = {}) {
    const i = ideas[p.idea_id], t = topics[p.topic_id];
    return {
        id: p.id, month: String(p.month).slice(0, 7), topicId: p.topic_id || null, ideaId: p.idea_id || null,
        topic: t ? t.title : null, category: t ? t.category : null, categoryName: t ? CS_CAT_NAME[t.category] : null,
        idea: i ? { hook: i.hook || null, url: i.url || null, sourceName: i.source_name || null } : null,
        postType: p.post_type, postTypeName: CS_TYPE_NAME[p.post_type], title: p.title || null, adaptation: p.adaptation || null,
        ideaNote: p.idea_note || null, scriptNote: p.script_note || null, styleNote: p.style_note || null, tools: p.tools || [],
        status: p.status, postId: p.post_id || null,
        post: post ? { plannedOn: post.planned_on, status: post.status, statusName: cpStatusName(post.status) } : null
    };
}

/** Readable text from a web page: title, description, headings and body copy. */
function csPageText(html) {
    const h = String(html || '');
    const title = oneLine((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(h) || [])[1] || '', 200);
    const desc = oneLine((/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i.exec(h) || /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i.exec(h) || [])[1] || '', 400);
    const body = h.replace(/<(script|style|noscript|svg|nav|footer)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<(h[1-4]|li|p|div|br|tr)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#?\w+;/g, ' ')
        .split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(s => s.length > 2);
    return { title, description: desc, text: [...new Set(body)].join('\n').slice(0, 6000) };
}
/** The site's own pages most likely to say what it sells. */
function csSiteLinks(html, base) {
    const out = [];
    const re = /<a[^>]+href=["']([^"'#]+)["']/gi; let m;
    while ((m = re.exec(String(html || '')))) {
        let u; try { u = new URL(m[1], base); } catch { continue; }
        if (u.host !== new URL(base).host || !/^https?:$/.test(u.protocol)) continue;
        if (!/(menu|service|product|price|pricing|package|about|shop|course|treatment|offer|collection)/i.test(u.pathname)) continue;
        const s = u.origin + u.pathname;
        if (!out.includes(s) && s !== base) out.push(s);
    }
    return out.slice(0, 3);
}

/** Topics that follow from the business without a model: one per offer, and the standing ones. */
function csBaseTopics(business, { market = null, reviews = null, client = {} } = {}) {
    const out = (business.offers || []).slice(0, 8).map((o, i) => ({
        category: 'service', title: o.name, detail: [o.price, o.note].filter(Boolean).join(' · ') || null,
        why: 'One of the things they sell — each offer is a primary topic.', priority: i < 3 ? 'high' : 'normal', source: 'audit'
    }));
    if (reviews && reviews.count) out.push({ category: 'reviews', title: 'Happy customers', detail: `${reviews.count} review post(s) found by the review tracker${reviews.handles ? ' from ' + reviews.handles : ''}.`, why: 'Real customers already post about them.', priority: 'high', source: 'reviews' });
    for (const t of (market && market.topics) || []) {
        if ((t.index || 0) < 1.1) continue;
        out.push({ category: 'educational', title: `${t.topic[0].toUpperCase()}${t.topic.slice(1)} (works for rivals)`, detail: null,
            why: `Rival posts about ${t.topic} score ${Number(t.index).toFixed(2)}× their normal (${t.n} posts).`, priority: 'normal', source: 'rivals' });
    }
    if (!out.some(t => t.category === 'reviews')) out.push({ category: 'reviews', title: 'Happy customers', detail: 'Customer photos, messages and ratings.', why: 'Proof from customers, not from the brand.', priority: 'normal', source: 'audit' });
    out.push({ category: 'generic', title: 'Behind the scenes', detail: client.niche ? `How the ${client.niche} work gets done.` : null, why: 'Shows the people and the work.', priority: 'normal', source: 'audit' });
    out.push({ category: 'collab', title: 'Creator visit', detail: client.location ? `A local creator in ${client.location} tries it.` : 'A local creator tries it.', why: 'Borrowed audience and a second voice.', priority: 'low', source: 'audit' });
    return out;
}
async function csAddTopics(clientId, list, userId) {
    const { data: have } = await supabase.from('content_topics').select('title').eq('client_id', clientId);
    const seen = new Set((have || []).map(t => String(t.title).toLowerCase()));
    const rows = [];
    for (const t of list) {
        const title = oneLine(t.title, 160);
        if (!title || seen.has(title.toLowerCase()) || !CS_CAT_NAME[t.category]) continue;
        seen.add(title.toLowerCase());
        rows.push({ client_id: clientId, category: t.category, title, detail: t.detail ? String(t.detail).slice(0, 600) : null,
            why: t.why ? String(t.why).slice(0, 400) : null, priority: ['high', 'normal', 'low'].includes(t.priority) ? t.priority : 'normal',
            active: t.active !== undefined ? !!t.active : (t.category === 'service' || t.priority === 'high'), source: ['audit', 'rivals', 'reviews', 'manual'].includes(t.source) ? t.source : 'audit',
            created_by: userId || null });
    }
    if (rows.length) { const { error } = await supabase.from('content_topics').insert(rows); if (error) throw error; }
    return rows.length;
}
/** Review posts the review tracker found for this client's own account. */
async function csReviews(client) {
    const { data } = await supabase.from('reports').select('report_json').eq('client_id', client.id).eq('report_type', 'review_scan').order('created_at', { ascending: false }).limit(1);
    const j = data && data[0] && data[0].report_json;
    if (!j) return null;
    const own = String(client.ig_handle || '').replace('@', '').toLowerCase();
    const row = (j.board || []).find(b => b.handle === own) || null;
    const count = row ? (row.reviews || 0) + (row.paidReviews || 0) : 0;
    return count ? { count, handles: null } : null;
}

registerWorker('content_audit', (userId, input) => async (progress) => {
    const { data: client } = await supabase.from('clients').select('*').eq('id', input.clientId).maybeSingle();
    if (!client) { const e = new Error('Client not found.'); e.statusCode = 404; throw e; }
    const read = { website: null, instagram: null };
    let site = null;
    if (input.website) {
        await progress(10, 'Reading the website');
        const home = await S.safePublicFetch(input.website);
        if (home) {
            const pages = [{ url: input.website, ...csPageText(home) }];
            for (const u of csSiteLinks(home, input.website)) {
                const h = await S.safePublicFetch(u);
                if (h) pages.push({ url: u, ...csPageText(h) });
            }
            site = pages;
            read.website = { url: input.website, ok: true, pages: pages.map(p => ({ url: p.url, title: p.title || null, chars: p.text.length })) };
        } else read.website = { url: input.website, ok: false };
    }
    let captions = [];
    if (input.instagram) {
        await progress(30, `Reading @${input.instagram}'s stored posts`);
        const l = await cpLoadRows('instagram', userId, client.id, input.instagram);
        captions = l.rows.slice(0, 30).map(r => ({ type: cpFormat(r), hook: cpHook(r.caption), caption: String(r.caption || '').slice(0, 280), likes: r.likes, comments: r.comments }));
        read.instagram = { handle: input.instagram, posts: captions.length, ageDays: l.source.ageDays };
    }
    const market = await csMarket(client.id);
    const reviews = await csReviews(client);

    await progress(50, 'Working out the business and its topics');
    let ai = null, aiStatus = { ok: false, reason: 'no_key', message: aiReasonText('no_key') };
    if ((site || captions.length) && geminiAvailable()) {
        const evidence = {
            business: { name: client.name, niche: client.niche || null, location: client.location || null },
            website: site ? site.map(p => ({ url: p.url, title: p.title, description: p.description, text: p.text.slice(0, 3500) })) : null,
            instagramPosts: captions,
            market: market ? { rivals: market.rivals, formats: market.formats, topics: market.topics, gaps: market.gaps } : null,
            reviews
        };
        const { json } = budgetedJson(evidence, { maxChars: 26000, keep: ['business', 'website'] });
        const prompt =
`You are a social media strategist at an agency, auditing a client before planning their content. Below is what was read: their website pages, their recent Instagram posts, what works for their rivals, and review posts customers made about them.

RULES:
- Offers are only things the website or the posts actually say they sell. Keep a price only if it is written; never guess one.
- Never invent awards, numbers, customers or claims. "proof" lists only things the evidence shows (e.g. "4.7 on Google, 900 reviews" only if written).
- Topics, by category:
  service: one per main offer (these are the primary topics).
  educational: trends and know-how in their field a customer would save or share.
  reviews: happy customers and growth numbers, only from what the evidence shows exists.
  generic: behind the scenes, team, place, moments, seasons.
  collab: what a local creator could do with them.
- Each topic gets a one-line "why" that names where it came from (website, their posts, rivals, reviews).
- Write in the language the evidence is mostly in.

Evidence (JSON):
${json}

Reply with ONLY this JSON:
{
 "business": { "summary": "2 sentences: what they are and how they make money", "model": "one line: how the business model works", "audience": "who buys", "voice": "how they talk", "offers": [ { "name": "...", "price": "as written or null", "note": "one line" } ], "differentiators": ["..."], "proof": ["..."] },
 "topics": [ { "category": "service|educational|reviews|generic|collab", "title": "short", "detail": "one line", "why": "one line naming the source", "priority": "high|normal|low" } ]
}
12 to 20 topics, every category at least once.`;
        const r = await geminiCallDetailed(prompt, { temperature: 0.4, maxOutputTokens: 6000, tag: 'Gemini Content Audit', userId });
        aiStatus = { ok: r.ok, reason: r.reason, message: r.ok ? 'Generated.' : aiReasonText(r.reason), model: r.model || null };
        ai = r.ok ? r.data : null;
    }
    const pageDesc = site && (site[0].description || site[0].title);
    const suggestion = ai ? csBusiness(ai.business) : csBusiness({ summary: pageDesc || null });
    await progress(85, 'Saving');
    const { data: prof } = await supabase.from('content_profiles').select('*').eq('client_id', client.id).maybeSingle();
    const replace = !prof || csEmptyBusiness(prof.business) || input.replace === true;
    const business = replace ? suggestion : csBusiness(prof.business);
    const now = new Date().toISOString();
    const row = { client_id: client.id, sources: { website: input.website || null, instagram: input.instagram || null },
        business, audit: { read, suggestion, aiStatus, at: now, applied: replace }, audited_at: now, updated_by: userId, updated_at: now };
    const { error } = prof ? await supabase.from('content_profiles').update(row).eq('client_id', client.id) : await supabase.from('content_profiles').insert([row]);
    if (error) throw error;
    const aiTopics = ai && Array.isArray(ai.topics) ? ai.topics.map(t => ({ ...t, source: /rival/i.test(t.why || '') ? 'rivals' : /review/i.test(t.why || '') ? 'reviews' : 'audit' })) : [];
    const added = await csAddTopics(client.id, [...aiTopics, ...csBaseTopics(business, { market, reviews, client })], userId);
    await progress(100, `${added} topic(s) added`);
    return { topicsAdded: added, applied: replace, aiStatus, read };
});

/** Ask the model to pick and adapt library ideas for each ticked topic, from the ranked shortlist only. */
registerWorker('content_suggest', (userId, input) => async (progress) => {
    const clientId = input.clientId;
    const [{ data: topics }, lib, market, { data: prof }, { data: picks }] = await Promise.all([
        supabase.from('content_topics').select('*').eq('client_id', clientId).eq('active', true),
        csLibrary(), csMarket(clientId),
        supabase.from('content_profiles').select('business').eq('client_id', clientId).maybeSingle(),
        supabase.from('content_picks').select('idea_id, month').eq('client_id', clientId)
    ]);
    if (!(topics || []).length) { const e = new Error('Tick at least one topic first.'); e.statusCode = 400; throw e; }
    if (!lib.length) { const e = new Error('The idea library is empty. Add ideas to it first.'); e.statusCode = 400; throw e; }
    const monthDate = `${csMonth(input.month)}-01`;
    const used = {}, month = {};
    for (const p of picks || []) { if (!p.idea_id) continue; used[p.idea_id] = 1; if (String(p.month).slice(0, 10) === monthDate) month[p.idea_id] = 1; }
    const shortlist = Object.fromEntries(topics.map(t => [t.id, csRank(t, lib, { market, used, month }).slice(0, 5)]));
    await progress(30, `Matching ${topics.length} topic(s) against ${lib.length} idea(s)`);
    let ai = null, aiStatus = { ok: false, reason: 'no_key', message: aiReasonText('no_key') };
    if (geminiAvailable()) {
        const evidence = {
            business: (prof && prof.business) || {},
            market: market ? { bestType: market.bestType, topics: market.topics, gaps: market.gaps } : null,
            topics: topics.map(t => ({ topicId: t.id, category: t.category, title: t.title, detail: t.detail, why: t.why,
                candidates: shortlist[t.id].map(c => ({ ideaId: c.idea.id, type: c.idea.post_type, hook: c.idea.hook, whyItWorked: c.idea.why_worked, style: c.idea.style, seenAt: c.idea.source_name, industry: c.idea.industry, tools: c.idea.tools })) }))
        };
        const { json } = budgetedJson(evidence, { maxChars: 30000, keep: ['topics'] });
        const prompt =
`You help an agency's content team choose ideas. Each topic below has a shortlist of ideas from the team's library — content they saw elsewhere, often from other industries. For each topic, pick up to 3 ideas from ITS OWN shortlist that could carry that topic for this business.

RULES:
- Use only ideaIds from that topic's candidates. Never invent an idea.
- "fit" is "good" when the idea's mechanism carries the topic naturally, "weak" when it is a stretch. Say "weak" honestly rather than leaving it out if it is the best there is.
- "adaptation" is ONE line: how this idea becomes about this topic for this business. Do not write the post, the script or the caption — the team does that.
- "tools" is at most 3 short tool names needed to make it (keep the idea's own tools when it names them).
- Prefer the post type rivals win with (market.bestType) when two ideas are otherwise equal.

Topics and shortlists (JSON):
${json}

Reply with ONLY this JSON:
{ "topics": [ { "topicId": "...", "ideas": [ { "ideaId": "...", "fit": "good|weak", "adaptation": "one line", "tools": ["..."] } ] } ] }`;
        const r = await geminiCallDetailed(prompt, { temperature: 0.4, maxOutputTokens: 6000, tag: 'Gemini Content Ideas', userId });
        aiStatus = { ok: r.ok, reason: r.reason, message: r.ok ? 'Generated.' : aiReasonText(r.reason), model: r.model || null };
        ai = r.ok ? r.data : null;
    }
    await progress(80, 'Saving the suggestions');
    const byTopic = {};
    for (const x of (ai && Array.isArray(ai.topics) ? ai.topics : [])) byTopic[String(x.topicId)] = Array.isArray(x.ideas) ? x.ideas : [];
    let dropped = 0;
    const now = new Date().toISOString();
    for (const t of topics) {
        const allowed = Object.fromEntries(shortlist[t.id].map(c => [c.idea.id, c]));
        let list = (byTopic[t.id] || []).flatMap(s => {
            const c = allowed[String(s.ideaId)];
            if (!c) { dropped++; return []; }
            return [{ ideaId: c.idea.id, fit: s.fit === 'good' ? 'good' : 'weak', adaptation: oneLine(s.adaptation, 300) || null,
                tools: csList(s.tools, { max: 3 }).length ? csList(s.tools, { max: 3 }) : csToolsFor(c.idea.post_type, c.idea), by: 'ai' }];
        }).filter((s, i, a) => a.findIndex(x => x.ideaId === s.ideaId) === i).slice(0, 3);
        if (!list.length) list = shortlist[t.id].slice(0, 3).map(c => ({ ideaId: c.idea.id, fit: c.fit === 'good' ? 'good' : 'weak', adaptation: null, tools: csToolsFor(c.idea.post_type, c.idea), by: 'rules' }));
        await supabase.from('content_topics').update({ suggestions: list, suggested_at: now, updated_at: now }).eq('id', t.id);
    }
    if (dropped) logger.warn('content_suggest_dropped', { clientId, dropped });
    await progress(100, `Ideas suggested for ${topics.length} topic(s)`);
    return { topics: topics.length, dropped, aiStatus };
});

/** Everything the plan page shows for one client and month. */
async function csState(client, monthKey, me) {
    const monthDate = `${monthKey}-01`;
    const [{ data: prof }, { data: topics }, lib, market, { data: allPicks }] = await Promise.all([
        supabase.from('content_profiles').select('*').eq('client_id', client.id).maybeSingle(),
        supabase.from('content_topics').select('*').eq('client_id', client.id).order('created_at', { ascending: true }),
        csLibrary(), csMarket(client.id),
        supabase.from('content_picks').select('*').eq('client_id', client.id)
    ]);
    const ideas = Object.fromEntries(lib.map(i => [i.id, i]));
    const tmap = Object.fromEntries((topics || []).map(t => [t.id, t]));
    const used = {}, month = {};
    for (const p of allPicks || []) { if (!p.idea_id) continue; used[p.idea_id] = 1; if (String(p.month).slice(0, 10) === monthDate) month[p.idea_id] = 1; }
    const picks = (allPicks || []).filter(p => String(p.month).slice(0, 10) === monthDate).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const postIds = picks.map(p => p.post_id).filter(Boolean);
    const { data: posts } = postIds.length ? await supabase.from('content_posts').select('id, planned_on, status').in('id', postIds) : { data: [] };
    const postOf = Object.fromEntries((posts || []).map(p => [p.id, p]));
    const names = await csNames(lib.map(i => i.saved_by));
    const view = i => csIdeaView(i, { names, me });
    const topicViews = (topics || []).map(t => {
        let s;
        if (Array.isArray(t.suggestions) && t.suggestions.length) {
            s = t.suggestions.filter(x => ideas[x.ideaId]).map(x => ({ ...x, idea: view(ideas[x.ideaId]), reasons: [] }));
        }
        if (!s || !s.length) {
            s = t.active ? csRank(t, lib, { market, used, month }).slice(0, 3).filter(c => c.score > 0)
                .map(c => ({ ideaId: c.idea.id, fit: c.fit === 'good' ? 'good' : 'weak', adaptation: null, tools: csToolsFor(c.idea.post_type, c.idea), by: 'rules', reasons: c.reasons, idea: view(c.idea) })) : [];
        }
        return csTopicView(t, s);
    });
    const picked = picks.map(p => csPickView(p, { ideas, topics: tmap, post: postOf[p.post_id] }));
    return {
        client: { id: client.id, name: client.name, igHandle: client.ig_handle || null, niche: client.niche || null, location: client.location || null },
        month: monthKey,
        profile: prof ? { sources: prof.sources || {}, business: csBusiness(prof.business), audit: prof.audit || null, auditedAt: prof.audited_at || null, updatedAt: prof.updated_at } : null,
        topics: topicViews, picks: picked,
        counts: Object.fromEntries(CS_TYPES.map(([k]) => [k, picked.filter(p => p.postType === k).length])),
        market, libraryCount: lib.length, categories: CS_CATEGORIES, postTypes: CS_TYPES, defaultTools: CS_DEFAULT_TOOLS
    };
}

// --- the idea library (the whole team's) -----------------------------------------

app.get('/api/content-ideas', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'content_plan'); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        if (!(await csReady())) return csMissing(res);
        let rows = await csLibrary();
        const type = CS_TYPE_NAME[req.query.type] ? req.query.type : null;
        const all = rows.length;
        if (type) rows = rows.filter(r => r.post_type === type);
        const tag = String(req.query.tag || '').toLowerCase().trim();
        if (tag) rows = rows.filter(r => (r.tags || []).includes(tag));
        const q = csWords(req.query.q);
        if (q.length) rows = rows.filter(r => { const w = csWords(`${r.hook} ${r.why_worked} ${r.style} ${r.source_name} ${r.industry} ${(r.tags || []).join(' ')} ${(r.tools || []).join(' ')}`); return q.every(x => w.some(y => y.startsWith(x))); });
        if (req.query.mine === '1') rows = rows.filter(r => r.saved_by === ctx.user.id);
        const { data: picks } = await supabase.from('content_picks').select('idea_id');
        const uses = {};
        for (const p of picks || []) if (p.idea_id) uses[p.idea_id] = (uses[p.idea_id] || 0) + 1;
        const names = await csNames(rows.map(r => r.saved_by));
        const tags = {};
        for (const r of rows) for (const t of r.tags || []) tags[t] = (tags[t] || 0) + 1;
        res.json({ ideas: rows.slice(0, 500).map(r => csIdeaView(r, { names, uses, me: ctx.user.id })), total: all, shown: Math.min(500, rows.length), matched: rows.length,
            types: CS_TYPES, tags: Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([t, n]) => ({ tag: t, n })) });
    } catch (err) { sendErr(res, err); }
});

app.post('/api/content-ideas', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'content_plan'); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        if (!(await csReady())) return csMissing(res);
        const row = csIdeaRow(req.body || {});
        if (!row) return res.status(400).json({ error: 'Give the link, or at least the hook.' });
        if (row.url) {
            const { data: dup } = await supabase.from('content_ideas').select('*').ilike('url', row.url).limit(1);
            if (dup && dup[0] && String(dup[0].url).toLowerCase() === row.url.toLowerCase()) return res.status(409).json({ error: 'That link is already in the library.', idea: csIdeaView(dup[0]) });
        }
        const { data, error } = await supabase.from('content_ideas').insert([{ ...row, saved_by: ctx.user.id }]).select().maybeSingle();
        if (error) throw error;
        res.status(201).json({ idea: csIdeaView(data, { names: await csNames([ctx.user.id]), me: ctx.user.id }) });
    } catch (err) { sendErr(res, err); }
});

/** A spreadsheet journal, pasted or uploaded as CSV: the headers say which column is which. */
app.post('/api/content-ideas/import', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'content_plan'); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        if (!(await csReady())) return csMissing(res);
        const text = String(req.body?.csv || '');
        if (!text.trim()) return res.status(400).json({ error: 'Paste the sheet, or choose a CSV file.' });
        if (text.length > 1500000) return res.status(413).json({ error: 'That sheet is too big. Split it into parts under 1.5 MB.' });
        const { rows, mapped, skipped } = csImportRows(text);
        if (!rows.length) return res.status(400).json({ error: 'No rows with a link or a hook were found. The first row must be the column names.', mapped });
        const have = new Set((await csLibrary()).map(r => String(r.url || '').toLowerCase()).filter(Boolean));
        const fresh = [];
        let dupes = 0;
        for (const r of rows) {
            const k = String(r.url || '').toLowerCase();
            if (k && have.has(k)) { dupes++; continue; }
            if (k) have.add(k);
            fresh.push({ ...r, saved_by: ctx.user.id });
        }
        if (req.body?.dryRun) return res.json({ dryRun: true, would: fresh.length, dupes, skipped, mapped, sample: fresh.slice(0, 5).map(r => csIdeaView(r)) });
        for (let i = 0; i < fresh.length; i += 200) {
            const { error } = await supabase.from('content_ideas').insert(fresh.slice(i, i + 200));
            if (error) throw error;
        }
        res.status(201).json({ added: fresh.length, dupes, skipped, mapped });
    } catch (err) { sendErr(res, err); }
});

async function csIdeaFor(ctx, id) {
    if (!UUID_RE.test(String(id || ''))) return null;
    const { data } = await supabase.from('content_ideas').select('*').eq('id', id).maybeSingle();
    return data || null;
}
app.patch('/api/content-ideas/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'content_plan'); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        if (!(await csReady())) return csMissing(res);
        const idea = await csIdeaFor(ctx, req.params.id);
        if (!idea) return res.status(404).json({ error: 'Idea not found.' });
        const merged = csIdeaRow({ ...idea, ...Object.fromEntries(Object.entries(req.body || {}).filter(([, v]) => v !== undefined)),
            source_name: req.body?.sourceName ?? idea.source_name, why_worked: req.body?.whyWorked ?? idea.why_worked, post_type: req.body?.postType ?? idea.post_type });
        if (!merged) return res.status(400).json({ error: 'An idea needs a link or a hook.' });
        const { data, error } = await supabase.from('content_ideas').update({ ...merged, updated_at: new Date().toISOString() }).eq('id', idea.id).select().maybeSingle();
        if (error) throw error;
        res.json({ idea: csIdeaView(data, { names: await csNames([data.saved_by]), me: ctx.user.id }) });
    } catch (err) { sendErr(res, err); }
});
app.delete('/api/content-ideas/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'content_plan'); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        if (!(await csReady())) return csMissing(res);
        const idea = await csIdeaFor(ctx, req.params.id);
        if (!idea) return res.status(404).json({ error: 'Idea not found.' });
        if (idea.saved_by !== ctx.user.id && ctx.profile?.role !== 'admin') return res.status(403).json({ error: 'Only the person who saved it, or an admin, can remove it.' });
        await supabase.from('content_ideas').delete().eq('id', idea.id);
        res.json({ deleted: true });
    } catch (err) { sendErr(res, err); }
});

// --- one client's plan -------------------------------------------------------------

app.get('/api/content-strategy/:clientId', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'content_plan'); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        if (!(await csReady())) return csMissing(res);
        const client = await csClient(ctx, req.params.clientId);
        if (!client) return res.status(404).json({ error: 'Client not found.' });
        res.json(await csState(client, csMonth(req.query.month), ctx.user.id));
    } catch (err) { sendErr(res, err); }
});

app.put('/api/content-strategy/:clientId/profile', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'content_plan'); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        if (!(await csReady())) return csMissing(res);
        const client = await csClient(ctx, req.params.clientId, 'editor');
        if (!client) return res.status(404).json({ error: 'Client not found, or you cannot edit it.' });
        const { data: prof } = await supabase.from('content_profiles').select('*').eq('client_id', client.id).maybeSingle();
        const now = new Date().toISOString();
        const row = { client_id: client.id, business: csBusiness(req.body?.business || (prof && prof.business)), updated_by: ctx.user.id, updated_at: now };
        if (req.body?.sources) row.sources = { website: csUrl(req.body.sources.website), instagram: String(req.body.sources.instagram || '').replace(/^@/, '').trim().toLowerCase() || null };
        const { error } = prof ? await supabase.from('content_profiles').update(row).eq('client_id', client.id) : await supabase.from('content_profiles').insert([row]);
        if (error) throw error;
        res.json({ business: row.business });
    } catch (err) { sendErr(res, err); }
});

app.post('/api/content-strategy/:clientId/audit', spendLimit, async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'content_plan'); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        if (!(await csReady())) return csMissing(res);
        const client = await csClient(ctx, req.params.clientId, 'editor');
        if (!client) return res.status(404).json({ error: 'Client not found, or you cannot edit it.' });
        const website = req.body?.website ? csUrl(/^https?:\/\//i.test(req.body.website) ? req.body.website : 'https://' + String(req.body.website).trim()) : null;
        const instagram = (String(req.body?.instagram || client.ig_handle || '').replace(/^@/, '').trim().toLowerCase()) || null;
        if (!website && !instagram) return res.status(400).json({ error: 'Give the website or the Instagram handle to audit.' });
        await assertJobSlot(ctx.user.id);
        const job = await createJob(ctx.user.id, 'content_audit', 'content_plan', { clientId: client.id, website, instagram, replace: req.body?.replace === true }, 0);
        runJob(job.id, JOB_WORKERS['content_audit'](ctx.user.id, job.input, job.id));
        res.status(202).json({ jobId: job.id, estimatedUsd: 0 });
    } catch (err) { sendErr(res, err); }
});

app.post('/api/content-strategy/:clientId/suggest', spendLimit, async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'content_plan'); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        if (!(await csReady())) return csMissing(res);
        const client = await csClient(ctx, req.params.clientId, 'editor');
        if (!client) return res.status(404).json({ error: 'Client not found, or you cannot edit it.' });
        await assertJobSlot(ctx.user.id);
        const job = await createJob(ctx.user.id, 'content_suggest', 'content_plan', { clientId: client.id, month: csMonth(req.body?.month) }, 0);
        runJob(job.id, JOB_WORKERS['content_suggest'](ctx.user.id, job.input, job.id));
        res.status(202).json({ jobId: job.id, estimatedUsd: 0 });
    } catch (err) { sendErr(res, err); }
});

app.post('/api/content-strategy/:clientId/topics', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'content_plan'); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        if (!(await csReady())) return csMissing(res);
        const client = await csClient(ctx, req.params.clientId, 'editor');
        if (!client) return res.status(404).json({ error: 'Client not found, or you cannot edit it.' });
        const b = req.body || {};
        if (!CS_CAT_NAME[b.category]) return res.status(400).json({ error: 'Choose a category.' });
        if (!oneLine(b.title, 160)) return res.status(400).json({ error: 'Give the topic a name.' });
        const n = await csAddTopics(client.id, [{ category: b.category, title: b.title, detail: b.detail, why: b.why, priority: b.priority || 'normal', source: 'manual', active: true }], ctx.user.id);
        if (!n) return res.status(409).json({ error: 'This client already has a topic with that name.' });
        res.status(201).json({ added: n });
    } catch (err) { sendErr(res, err); }
});

async function csTopicFor(ctx, id) {
    if (!UUID_RE.test(String(id || ''))) return null;
    const { data } = await supabase.from('content_topics').select('*').eq('id', id).maybeSingle();
    if (!data || !(await csClient(ctx, data.client_id, 'editor'))) return null;
    return data;
}
app.patch('/api/content-topics/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'content_plan'); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        if (!(await csReady())) return csMissing(res);
        const t = await csTopicFor(ctx, req.params.id);
        if (!t) return res.status(404).json({ error: 'Topic not found, or you cannot edit it.' });
        const b = req.body || {}, patch = {};
        if (b.active !== undefined) patch.active = !!b.active;
        if (b.priority !== undefined) { if (!['high', 'normal', 'low'].includes(b.priority)) return res.status(400).json({ error: 'Priority is high, normal or low.' }); patch.priority = b.priority; }
        if (b.category !== undefined) { if (!CS_CAT_NAME[b.category]) return res.status(400).json({ error: 'Unknown category.' }); patch.category = b.category; }
        if (b.title !== undefined) { const v = oneLine(b.title, 160); if (!v) return res.status(400).json({ error: 'A topic needs a name.' }); patch.title = v; }
        if (b.detail !== undefined) patch.detail = b.detail ? String(b.detail).slice(0, 600) : null;
        if (b.why !== undefined) patch.why = b.why ? String(b.why).slice(0, 400) : null;
        patch.updated_at = new Date().toISOString();
        const { data, error } = await supabase.from('content_topics').update(patch).eq('id', t.id).select().maybeSingle();
        if (error) throw error;
        res.json({ topic: csTopicView(data || { ...t, ...patch }) });
    } catch (err) { sendErr(res, err); }
});
app.delete('/api/content-topics/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'content_plan'); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        if (!(await csReady())) return csMissing(res);
        const t = await csTopicFor(ctx, req.params.id);
        if (!t) return res.status(404).json({ error: 'Topic not found, or you cannot edit it.' });
        await supabase.from('content_topics').delete().eq('id', t.id);
        res.json({ deleted: true });
    } catch (err) { sendErr(res, err); }
});

/** Pick an idea for a topic this month. Picking the same idea for the same topic again returns the first pick. */
app.post('/api/content-strategy/:clientId/picks', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'content_plan'); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        if (!(await csReady())) return csMissing(res);
        const client = await csClient(ctx, req.params.clientId, 'editor');
        if (!client) return res.status(404).json({ error: 'Client not found, or you cannot edit it.' });
        const b = req.body || {};
        const month = `${csMonth(b.month)}-01`;
        const topic = b.topicId ? await csTopicFor(ctx, b.topicId) : null;
        if (b.topicId && (!topic || topic.client_id !== client.id)) return res.status(404).json({ error: 'Topic not found.' });
        const idea = b.ideaId ? await csIdeaFor(ctx, b.ideaId) : null;
        if (b.ideaId && !idea) return res.status(404).json({ error: 'Idea not found.' });
        if (!topic && !idea) return res.status(400).json({ error: 'Pick a topic, an idea, or both.' });
        const { data: same } = await supabase.from('content_picks').select('*').eq('client_id', client.id).eq('month', month);
        const dup = (same || []).find(p => p.topic_id === (topic ? topic.id : null) && p.idea_id === (idea ? idea.id : null));
        if (dup) return res.json({ pick: csPickView(dup, { ideas: idea ? { [idea.id]: idea } : {}, topics: topic ? { [topic.id]: topic } : {} }), existed: true });
        const type = CS_TYPE_NAME[b.postType] ? b.postType : (idea ? idea.post_type : (CS_TYPE_PREF[topic.category] || ['static'])[0]);
        const sug = topic && Array.isArray(topic.suggestions) ? topic.suggestions.find(s => idea && s.ideaId === idea.id) : null;
        const { data, error } = await supabase.from('content_picks').insert([{
            client_id: client.id, month, topic_id: topic ? topic.id : null, idea_id: idea ? idea.id : null, post_type: type,
            title: oneLine(b.title || (topic && topic.title) || (idea && idea.hook), 300) || null,
            adaptation: (sug && sug.adaptation) || null, tools: (sug && sug.tools && sug.tools.length) ? sug.tools : csToolsFor(type, idea),
            status: 'draft', created_by: ctx.user.id
        }]).select().maybeSingle();
        if (error) throw error;
        res.status(201).json({ pick: csPickView(data, { ideas: idea ? { [idea.id]: idea } : {}, topics: topic ? { [topic.id]: topic } : {} }) });
    } catch (err) { sendErr(res, err); }
});

async function csPickFor(ctx, id) {
    if (!UUID_RE.test(String(id || ''))) return null;
    const { data } = await supabase.from('content_picks').select('*').eq('id', id).maybeSingle();
    if (!data || !(await csClient(ctx, data.client_id, 'editor'))) return null;
    return data;
}
app.patch('/api/content-picks/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'content_plan'); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        if (!(await csReady())) return csMissing(res);
        const p = await csPickFor(ctx, req.params.id);
        if (!p) return res.status(404).json({ error: 'Pick not found, or you cannot edit it.' });
        const b = req.body || {}, patch = {};
        const text = (k, col, max) => { if (b[k] !== undefined) patch[col] = b[k] ? String(b[k]).trim().slice(0, max) || null : null; };
        text('title', 'title', 300); text('adaptation', 'adaptation', 600); text('ideaNote', 'idea_note', 1000); text('scriptNote', 'script_note', 2000); text('styleNote', 'style_note', 1000);
        if (b.tools !== undefined) patch.tools = csList(b.tools, { max: 6 });
        if (b.postType !== undefined) { if (!CS_TYPE_NAME[b.postType]) return res.status(400).json({ error: 'Post type is static, carousel, video or story.' }); patch.post_type = b.postType; }
        if (b.status !== undefined) {
            if (!['draft', 'final'].includes(b.status)) return res.status(400).json({ error: 'Status is draft or final.' });
            const after = { ...p, ...patch };
            // The manual touch: a pick is final only once a person has said what the idea, script or style is.
            if (b.status === 'final' && !after.idea_note && !after.script_note && !after.style_note) {
                return res.status(400).json({ error: 'Add your note on the idea, the script or the style before marking it final.' });
            }
            patch.status = b.status;
        }
        patch.updated_at = new Date().toISOString();
        const { data, error } = await supabase.from('content_picks').update(patch).eq('id', p.id).select().maybeSingle();
        if (error) throw error;
        const row = data || { ...p, ...patch };
        // Once on the calendar, the post carries the same words.
        if (row.post_id) {
            const post = { hook: oneLine(row.title, 300) || null, format: CS_TYPE_NAME[row.post_type] };
            const { data: cur } = await supabase.from('content_posts').select('brief, status').eq('id', row.post_id).maybeSingle();
            if (cur && !['made', 'posted'].includes(cur.status)) {
                post.brief = { ...(cur.brief || {}), concept: row.adaptation || row.idea_note || null, script: String(row.script_note || '').split(/\n+/).map(s => s.trim()).filter(Boolean).slice(0, 8), shot: row.style_note || null, tools: row.tools || [] };
                await supabase.from('content_posts').update({ ...post, updated_at: patch.updated_at }).eq('id', row.post_id);
            }
        }
        const [{ data: idea }, { data: topic }] = await Promise.all([
            row.idea_id ? supabase.from('content_ideas').select('*').eq('id', row.idea_id).maybeSingle() : { data: null },
            row.topic_id ? supabase.from('content_topics').select('*').eq('id', row.topic_id).maybeSingle() : { data: null }
        ]);
        res.json({ pick: csPickView(row, { ideas: idea ? { [idea.id]: idea } : {}, topics: topic ? { [topic.id]: topic } : {} }) });
    } catch (err) { sendErr(res, err); }
});
app.delete('/api/content-picks/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'content_plan'); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        if (!(await csReady())) return csMissing(res);
        const p = await csPickFor(ctx, req.params.id);
        if (!p) return res.status(404).json({ error: 'Pick not found, or you cannot edit it.' });
        if (p.post_id) {
            const { data: post } = await supabase.from('content_posts').select('id, status').eq('id', p.post_id).maybeSingle();
            if (post && post.status !== 'idea') return res.status(409).json({ error: 'The owner has already answered this post. Skip it on the calendar instead.' });
            if (post) await supabase.from('content_posts').delete().eq('id', post.id);
        }
        await supabase.from('content_picks').delete().eq('id', p.id);
        res.json({ deleted: true });
    } catch (err) { sendErr(res, err); }
});

/** Put the month's final picks on the calendar for the owner to approve. Pressing it again adds only new ones. */
app.post('/api/content-strategy/:clientId/schedule', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'content_plan'); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        if (!(await csReady())) return csMissing(res);
        const client = await csClient(ctx, req.params.clientId, 'editor');
        if (!client) return res.status(404).json({ error: 'Client not found, or you cannot edit it.' });
        const monthKey = csMonth(req.body?.month);
        const { data: picks } = await supabase.from('content_picks').select('*').eq('client_id', client.id).eq('month', `${monthKey}-01`);
        const all = (picks || []).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
        const todo = all.filter(p => p.status === 'final' && !p.post_id);
        const drafts = all.filter(p => p.status === 'draft').length;
        if (!todo.length) {
            const on = all.filter(p => p.post_id).length;
            return res.status(400).json({ error: drafts ? `Nothing new is final: ${drafts} pick(s) still in draft. Add your notes and mark them final.`
                : on ? 'Everything final is already on the calendar.' : 'No picks for this month yet.' });
        }
        const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
        let start = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.start || '')) ? req.body.start : `${monthKey}-01`;
        if (start < tomorrow) start = tomorrow;
        const ids = [...new Set(todo.flatMap(p => [p.idea_id, p.topic_id]).filter(Boolean))];
        const [{ data: ideas }, { data: topics }] = await Promise.all([
            supabase.from('content_ideas').select('*').in('id', ids), supabase.from('content_topics').select('*').in('id', ids)
        ]);
        const I = Object.fromEntries((ideas || []).map(x => [x.id, x])), T = Object.fromEntries((topics || []).map(x => [x.id, x]));
        const dates = cpScheduleDates(todo.map(() => ({})), start);
        const rows = todo.map((p, i) => {
            const idea = I[p.idea_id], topic = T[p.topic_id];
            return {
                id: crypto.randomUUID(), report_id: null, pick_id: p.id, client_id: client.id, brief_key: 'pick:' + p.id, format: CS_TYPE_NAME[p.post_type],
                hook: oneLine(p.title || (idea && idea.hook), 300) || null, caption: null,
                brief: { concept: p.adaptation || p.idea_note || null, idea: p.idea_note || null,
                    script: String(p.script_note || '').split(/\n+/).map(s => s.trim()).filter(Boolean).slice(0, 8), shot: p.style_note || null,
                    why: topic ? (topic.why || `${CS_CAT_NAME[topic.category]}: ${topic.title}`) : null, evidence: idea && idea.url ? [idea.url] : [],
                    topic: topic ? topic.title : null, category: topic ? topic.category : null, tools: p.tools || [],
                    from: idea ? { hook: idea.hook || null, sourceName: idea.source_name || null } : null },
                planned_on: dates[i].plannedOn, planned_time: null, status: 'idea', created_by: ctx.user.id
            };
        });
        const { error } = await supabase.from('content_posts').insert(rows);
        if (error) throw error;
        for (const r of rows) await supabase.from('content_picks').update({ post_id: r.id, updated_at: new Date().toISOString() }).eq('id', r.pick_id);
        res.status(201).json({ added: rows.length, drafts });
    } catch (err) { sendErr(res, err); }
});

/** Every planned post for the client in a month, whichever plan it came from. */
app.get('/api/content-strategy/:clientId/calendar', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'content_plan'); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        if (!(await contentPostsReady())) return contentPostsMissing(res);
        const client = await csClient(ctx, req.params.clientId);
        if (!client) return res.status(404).json({ error: 'Client not found.' });
        const m = csMonth(req.query.month);
        const [y, mo] = m.split('-').map(Number);
        const { data } = await supabase.from('content_posts').select('*').eq('client_id', client.id)
            .gte('planned_on', `${m}-01`).lt('planned_on', new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10)).order('planned_on', { ascending: true });
        res.json({ posts: (data || []).map(contentPostView), statuses: CP_POST_STATUS, hasClient: true });
    } catch (err) { sendErr(res, err); }
});
