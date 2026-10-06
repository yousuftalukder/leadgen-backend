/**
 * The Gemini narrative layer: key pool, calls, JSON budgets.
 *
 * Part of the EdgeLead server, split out of server.js (phase 55). The parts load in
 * order from server.js and share one namespace, S: what this part needs from an earlier
 * part is unpacked below; anything else from another part is read as S.name when it runs.
 */
'use strict';
const S = require('./shared');
const {
    ELS, GEMINI_API_KEY, GEMINI_MODEL, METRICS, alertOnce, decryptSecret, isByoOnly, logger, supabase
} = S;
Object.assign(S, {
    budgetedJson, geminiRank, geminiModelChain, loadGeminiPool, invalidateGeminiPool, geminiAvailable,
    geminiCandidates, geminiMarkKey, geminiReportKey, geminiIsThinkingLevelModel, geminiCallDetailed,
    geminiCall, aiReasonText, aiPostCard, igAiSlim, igAiPayload, fbGroupAiSlim, fbPageAiSlim,
    geminiNarrative
});

// ===========================================================================
// GEMINI NARRATIVE LAYER
// ===========================================================================

/**
 * Single Gemini entry point with backoff.
 *
 * Volume is never the problem here - one report makes one or two calls, far
 * under any free-tier daily cap. The real failure mode is a burst 429 when a
 * job fires several calls back to back, which previously returned null and
 * silently dropped the whole narrative layer.
 */
/**
 * Serialise a payload to fit a character budget WITHOUT slicing the string.
 *
 * The old code did `JSON.stringify(payload).slice(0, 60000)`, which cuts
 * mid-token and hands the model an unterminated string inside an unclosed
 * array inside an unclosed object. It also cut in key order, so on a
 * comparison run the budget was exhausted inside `target` and the rivals and
 * the benchmark were never transmitted at all — while the prompt still asked
 * for competitor insights.
 *
 * This drops whole top-level sections, largest first, in reverse priority
 * order, and records what it dropped inside the document. The output is always
 * valid JSON and the model is always told what is missing.
 */
function budgetedJson(payload, { maxChars = 40000, keep = [] } = {}) {
    let obj = { ...(payload || {}) };
    let out = JSON.stringify(obj);
    if (out.length <= maxChars) return { json: out, dropped: [], chars: out.length };

    const dropped = [];
    // Biggest first, but never touch anything the prompt depends on.
    const candidates = Object.keys(obj)
        .filter(k => !keep.includes(k))
        .map(k => ({ k, size: JSON.stringify(obj[k] || null).length }))
        .sort((a, b) => b.size - a.size);

    for (const c of candidates) {
        if (out.length <= maxChars) break;
        delete obj[c.k];
        dropped.push(c.k);
        obj._omitted = dropped;
        out = JSON.stringify(obj);
    }

    // Everything droppable is gone and it still does not fit. Truncate the
    // arrays inside what is left rather than the string that holds them.
    if (out.length > maxChars) {
        for (const k of Object.keys(obj)) {
            if (Array.isArray(obj[k]) && obj[k].length > 3) obj[k] = obj[k].slice(0, 3);
        }
        obj._omitted = dropped.concat('array-tails');
        out = JSON.stringify(obj);
    }

    METRICS.ai.dropped += dropped.length;
    return { json: out, dropped, chars: out.length };
}

// ---------------------------------------------------------------------------
// GEMINI KEY POOL + MODEL DISCOVERY (phase 9)
//
// Before this, every narrative in the system went through one env key and one
// hard-coded model name. A free-tier 429 on that key stalled every report at
// once, and a retired model name turned into a 404 that was never retried.
//
// Resolution order for a call made on behalf of a user:
//   1. that user's own active gemini_keys rows
//   2. the shared pool (owner_user_id null), least recently used first
//   3. GEMINI_API_KEY from the environment
//
// A 429 puts the key on a short cooldown and the call moves to the next key
// immediately. A model 404 marks that model dead for an hour and moves on.
//
// Model names are not guessed: at first use the pool asks the API which models
// this key can call (models.list) and prefers the newest "flash" line, then
// "flash-lite", then "pro". GEMINI_MODEL, if set, always goes first, and
// GEMINI_MODEL_FALLBACKS is the static safety net if discovery fails.
// ---------------------------------------------------------------------------
const GEMINI_MODEL_FALLBACKS = (process.env.GEMINI_MODEL_FALLBACKS ||
    'gemini-2.5-flash,gemini-2.5-flash-lite,gemini-2.0-flash')
    .split(',').map(s => s.trim()).filter(Boolean);
S.GEMINI_MODEL_FALLBACKS = GEMINI_MODEL_FALLBACKS;
const GEMINI_DISCOVERY_TTL_MS = 3600000;
const _geminiDiscovered = { models: [], t: 0 };
S._geminiDiscovered = _geminiDiscovered;

/** Rank a model id: newer flash first, then flash-lite, then pro. Previews/experimental last. */
function geminiRank(name) {
    const m = String(name).match(/gemini-(\d+(?:\.\d+)?)-(flash-lite|flash|pro)/i);
    if (!m) return null;
    const ver = parseFloat(m[1]);
    const line = m[2].toLowerCase();
    const penalty = /preview|exp|latest|tts|image|audio|live|thinking/i.test(name) ? 1000 : 0;
    const lineScore = line === 'flash' ? 0 : line === 'flash-lite' ? 100 : 200;
    return penalty + lineScore - ver;   // lower is better
}

async function geminiDiscoverModels(key) {
    if (Date.now() - _geminiDiscovered.t < GEMINI_DISCOVERY_TTL_MS) return _geminiDiscovered.models;
    _geminiDiscovered.t = Date.now();
    try {
        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } });
        if (!r.ok) throw new Error('models.list ' + r.status);
        const data = await r.json();
        const names = (data.models || [])
            .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
            .map(m => String(m.name || '').replace(/^models\//, ''))
            .filter(n => geminiRank(n) !== null)
            .sort((a, b) => geminiRank(a) - geminiRank(b));
        _geminiDiscovered.models = names.slice(0, 6);
        logger.info('gemini_models_discovered', { preferred: _geminiDiscovered.models.slice(0, 3) });
    } catch (err) {
        logger.warn('gemini_model_discovery_failed', { message: err.message });
        _geminiDiscovered.models = [];
    }
    return _geminiDiscovered.models;
}

const GEMINI_KEY_COOLDOWN_MS = parseInt(process.env.GEMINI_KEY_COOLDOWN_MS || '90000', 10);
S.GEMINI_KEY_COOLDOWN_MS = GEMINI_KEY_COOLDOWN_MS;
// A Gemini call that has not answered in this long is abandoned and retried on the next key (phase 54).
const GEMINI_TIMEOUT_MS = parseInt(process.env.GEMINI_TIMEOUT_MS || '90000', 10);
S.GEMINI_TIMEOUT_MS = GEMINI_TIMEOUT_MS;
const GEMINI_DEAD_MODEL_MS   = 3600000;

const _geminiDeadModels = new Map();
S._geminiDeadModels = _geminiDeadModels;     // model -> ts
const _geminiPool = { rows: [], t: 0 };
S._geminiPool = _geminiPool;  // cached gemini_keys rows (decrypted lazily)
const _geminiCoolLocal = new Map();
S._geminiCoolLocal = _geminiCoolLocal;      // key id -> cooldown until (ms); survives a stale pool cache
const GEMINI_POOL_TTL_MS = 60000;

async function geminiModelChain(key) {
    const discovered = key ? await geminiDiscoverModels(key) : [];
    const envFirst = process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : [];
    const chain = [...envFirst, ...discovered, GEMINI_MODEL, ...GEMINI_MODEL_FALLBACKS].filter((m, i, a) => m && a.indexOf(m) === i);
    const now = Date.now();
    const live = chain.filter(m => !(_geminiDeadModels.get(m) && now - _geminiDeadModels.get(m) < GEMINI_DEAD_MODEL_MS));
    return live.length ? live : chain;
}

async function loadGeminiPool(force = false) {
    if (!force && Date.now() - _geminiPool.t < GEMINI_POOL_TTL_MS) return _geminiPool.rows;
    try {
        const { data, error } = await supabase.from('gemini_keys')
            .select('id, owner_user_id, key_enc, status, cooldown_until, last_used_at, fail_count')
            .neq('status', 'invalid')
            .order('last_used_at', { ascending: true, nullsFirst: true });
        if (error) throw error;
        _geminiPool.rows = data || [];
    } catch (err) {
        // Table missing (migration not run) or transient. Env key still works.
        if (!/relation .* does not exist/i.test(err.message || '')) logger.warn('gemini_pool_load_failed', { message: err.message });
        _geminiPool.rows = [];
    }
    _geminiPool.t = Date.now();
    return _geminiPool.rows;
}
function invalidateGeminiPool() { _geminiPool.t = 0; }

/** Is any narrative source configured at all? Sync, from the cached pool. */
function geminiAvailable() {
    return !!GEMINI_API_KEY || _geminiPool.rows.length > 0;
}

/** Ordered candidate keys for a user. Each: { id, key, source }. */
async function geminiCandidates(userId) {
    const rows = await loadGeminiPool();
    const now = Date.now();
    const usable = rows.filter(r => !(r.status === 'cooldown' && r.cooldown_until && new Date(r.cooldown_until).getTime() > now))
                       .filter(r => !(_geminiCoolLocal.get(r.id) > now));
    const own = usable.filter(r => userId && r.owner_user_id === userId);
    // "Own keys only" (app_users.byo_key_only) holds for AI as it does for
    // Apify: that person's calls never reach the shared pool or the server key.
    const byo = await isByoOnly(userId);
    const shared = byo ? [] : usable.filter(r => !r.owner_user_id);
    const out = [];
    for (const r of [...own, ...shared]) {
        try { out.push({ id: r.id, key: decryptSecret(r.key_enc), source: r.owner_user_id ? 'personal' : 'pool' }); }
        catch (err) { logger.warn('gemini_key_undecryptable', { id: r.id }); }
    }
    if (GEMINI_API_KEY && !byo) out.push({ id: null, key: GEMINI_API_KEY, source: 'env' });
    if (byo && !out.length) out.byoMissing = true;
    return out;
}

async function geminiMarkKey(id, patch) {
    if (!id) return;
    try { await supabase.from('gemini_keys').update(patch).eq('id', id); } catch (_) {}
    invalidateGeminiPool();
}

/** How a key did, for callers that talk to Gemini themselves (Edge Meta AI's streaming chat). */
async function geminiReportKey(id, outcome, detail) {
    if (!id) return;
    if (outcome === 'cooldown') {
        _geminiCoolLocal.set(id, Date.now() + GEMINI_KEY_COOLDOWN_MS);
        await geminiMarkKey(id, { status: 'cooldown', cooldown_until: new Date(Date.now() + GEMINI_KEY_COOLDOWN_MS).toISOString(), last_error: String(detail || '429').slice(0, 200) });
    } else if (outcome === 'invalid') {
        await geminiMarkKey(id, { status: 'invalid', last_error: String(detail || 'rejected').slice(0, 200), fail_count: 99 });
    } else if (outcome === 'ok') {
        await geminiMarkKey(id, { last_used_at: new Date().toISOString(), status: 'active', cooldown_until: null });
    }
}

function geminiIsThinkingLevelModel(model) { return /gemini-3/i.test(model); }

/**
 * One call to Gemini. Returns a status object, never a bare null.
 *
 *   { ok: true,  data: {...}, reason: 'ok', model, keySource }
 *   { ok: false, data: null,  reason: 'no_key' | 'http_4xx' | 'max_tokens' |
 *                                     'blocked' | 'empty' | 'unparseable' |
 *                                     'network' | 'exhausted' }
 */
async function geminiCallDetailed(prompt, {
    temperature = 0.5,
    maxOutputTokens = parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS || '8192', 10),
    thinkingBudget = parseInt(process.env.GEMINI_THINKING_BUDGET || '2048', 10),
    tag = 'gemini',
    retries = 3,
    userId = null
} = {}) {
    const uid = userId || ELS.getStore()?.userId || null;
    const candidates = await geminiCandidates(uid);
    if (!candidates.length) return { ok: false, data: null, reason: candidates.byoMissing ? 'no_own_key' : 'no_key' };

    METRICS.gemini.calls += 1;
    METRICS.ai.promptChars += prompt.length;

    const buildBody = (text, model, withThinking) => {
        const generationConfig = { temperature, maxOutputTokens, responseMimeType: 'application/json' };
        if (withThinking) {
            generationConfig.thinkingConfig = geminiIsThinkingLevelModel(model)
                ? { thinkingLevel: 'low' }
                : { thinkingBudget };
        }
        return JSON.stringify({ contents: [{ role: 'user', parts: [{ text }] }], generationConfig });
    };

    let text = prompt;
    let repairUsed = false;
    let keyIdx = 0;
    let withThinking = true;
    const models = await geminiModelChain(candidates[0].key);
    let modelIdx = 0;
    let lastReason = 'exhausted';
    const maxAttempts = retries + candidates.length + models.length;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (keyIdx >= candidates.length) { keyIdx = 0; await new Promise(r => setTimeout(r, Math.min(2000 * Math.pow(2, attempt), 15000))); }
        if (modelIdx >= models.length) break;
        const cand = candidates[keyIdx];
        const model = models[modelIdx];
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

        try {
            const r = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cand.key },
                body: buildBody(text, model, withThinking),
                // Phase 54: a call Google never answers used to hold the job (and its slot) for good.
                signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS)
            });

            if (r.status === 429) {
                METRICS.gemini.retries += 1;
                logger.warn('gemini_rate_limited', { tag, model, keySource: cand.source, keyId: cand.id });
                if (cand.id) _geminiCoolLocal.set(cand.id, Date.now() + GEMINI_KEY_COOLDOWN_MS);
                await geminiMarkKey(cand.id, { status: 'cooldown', cooldown_until: new Date(Date.now() + GEMINI_KEY_COOLDOWN_MS).toISOString(), last_error: '429' });
                keyIdx += 1; lastReason = 'exhausted';
                continue;
            }

            if (r.status === 401) {
                // The key itself is refused (retired, revoked, wrong type): the next key may be fine.
                const body = (await r.text()).slice(0, 400);
                logger.warn('gemini_key_invalid', { tag, keySource: cand.source, keyId: cand.id, status: 401, body });
                if (cand.source === 'env') alertOnce('gemini_env_key_refused', 'Google refused the server GEMINI_API_KEY (401). Replace it on Render with a new AI Studio key (starts with AQ.).', {});
                await geminiMarkKey(cand.id, { status: 'invalid', last_error: body.slice(0, 200), fail_count: 99 });
                keyIdx += 1; lastReason = 'http_401';
                continue;
            }
            if (r.status === 404 || r.status === 400 || r.status === 403 || r.status >= 500) {
                const body = (await r.text()).slice(0, 400);
                const isModelProblem = r.status === 404 || /model|not found|no longer available|not supported/i.test(body);
                const isThinkingProblem = r.status === 400 && /thinking/i.test(body);
                const isKeyProblem = (r.status === 400 || r.status === 403) && /api key|API_KEY|permission|not valid/i.test(body);

                if (isThinkingProblem && withThinking) { withThinking = false; logger.warn('gemini_thinking_config_rejected', { tag, model }); continue; }
                if (isKeyProblem) {
                    logger.warn('gemini_key_invalid', { tag, keySource: cand.source, keyId: cand.id, body });
                    await geminiMarkKey(cand.id, { status: 'invalid', last_error: body.slice(0, 200), fail_count: 99 });
                    keyIdx += 1; lastReason = 'http_' + r.status;
                    continue;
                }
                if (isModelProblem && r.status !== 403) {
                    _geminiDeadModels.set(model, Date.now());
                    logger.warn('gemini_model_unavailable', { tag, model, status: r.status, body });
                    alertOnce('gemini_model:' + model, `Gemini model ${model} is unavailable (${r.status}); falling back.`, { tag });
                    modelIdx += 1; lastReason = 'http_' + r.status;
                    continue;
                }
                if (r.status >= 500) {
                    METRICS.gemini.retries += 1;
                    logger.warn('gemini_retry', { tag, status: r.status, attempt: attempt + 1 });
                    await new Promise(res => setTimeout(res, Math.min(2000 * Math.pow(2, attempt), 15000)));
                    continue;
                }
                METRICS.gemini.failed += 1; METRICS.ai.failed += 1;
                logger.error('gemini_failed', { tag, status: r.status, body });
                return { ok: false, data: null, reason: 'http_' + r.status, detail: body, model };
            }

            if (!r.ok) {
                METRICS.gemini.failed += 1; METRICS.ai.failed += 1;
                const body = (await r.text()).slice(0, 300);
                logger.error('gemini_failed', { tag, status: r.status, body });
                alertOnce('gemini_failed', `Gemini returned ${r.status}. Reports will ship without their narrative layer.`, { tag });
                return { ok: false, data: null, reason: 'http_' + r.status, detail: body, model };
            }

            await geminiMarkKey(cand.id, { last_used_at: new Date().toISOString(), status: 'active', cooldown_until: null });

            const data = await r.json();
            const c0 = data?.candidates?.[0];
            const finish = String(c0?.finishReason || '').toUpperCase();
            const raw = (c0?.content?.parts || []).filter(p => !p.thought).map(x => x.text || '').join('');

            if (finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT' || finish === 'RECITATION') {
                METRICS.gemini.failed += 1; METRICS.ai.failed += 1;
                logger.warn('gemini_blocked', { tag, finishReason: finish });
                return { ok: false, data: null, reason: 'blocked', detail: finish, model };
            }
            if (finish === 'MAX_TOKENS') {
                METRICS.gemini.failed += 1; METRICS.ai.truncated += 1;
                logger.warn('gemini_max_tokens', { tag, model, maxOutputTokens, promptChars: text.length, chars: raw.length });
                alertOnce('gemini_max_tokens', 'Gemini hit its output cap before finishing the JSON. Raise GEMINI_MAX_OUTPUT_TOKENS.', { tag });
                return { ok: false, data: null, reason: 'max_tokens', model };
            }
            if (!raw.trim()) {
                METRICS.gemini.failed += 1; METRICS.ai.failed += 1;
                logger.warn('gemini_empty', { tag, finishReason: finish || 'none' });
                return { ok: false, data: null, reason: 'empty', detail: finish || null, model };
            }

            try {
                const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
                METRICS.gemini.ok += 1; METRICS.ai.ok += 1;
                return { ok: true, data: parsed, reason: 'ok', model, keySource: cand.source };
            } catch (parseErr) {
                if (repairUsed) {
                    METRICS.gemini.failed += 1; METRICS.ai.failed += 1;
                    logger.error('gemini_unparseable', { tag, chars: raw.length, head: raw.slice(0, 200) });
                    return { ok: false, data: null, reason: 'unparseable', model };
                }
                repairUsed = true;
                METRICS.gemini.retries += 1;
                text = prompt +
                    '\n\nYour previous reply was not valid JSON. Reply again with ONLY the JSON object, ' +
                    'no markdown fences, no commentary, and make sure every bracket and quote is closed.';
                continue;
            }
        } catch (err) {
            logger.error('gemini_error', { tag, attempt: attempt + 1, message: err.message });
            lastReason = 'network';
            await new Promise(res => setTimeout(res, Math.min(2000 * Math.pow(2, attempt), 15000)));
        }
    }
    METRICS.gemini.failed += 1; METRICS.ai.failed += 1;
    return { ok: false, data: null, reason: lastReason };
}

/** Back-compat shape: the parsed object, or null. */
async function geminiCall(prompt, opts = {}) {
    const r = await geminiCallDetailed(prompt, opts);
    return r.ok ? r.data : null;
}

/** Human-readable version of a failure reason, for the report and the UI. */
function aiReasonText(reason) {
    switch (reason) {
        case 'ok':          return 'Generated.';
        case 'no_key':      return 'No Gemini API key is configured on this server.';
        case 'no_own_key':  return 'This account uses its own AI key only, and has no working Gemini key. Add one with the AI key button.';
        case 'max_tokens':  return 'The model ran out of output budget before it finished. Raise GEMINI_MAX_OUTPUT_TOKENS.';
        case 'blocked':     return 'The model declined to answer for this content.';
        case 'empty':       return 'The model returned an empty response.';
        case 'unparseable': return 'The model returned something that was not valid JSON, twice.';
        case 'network':     return 'The strategy service could not be reached.';
        case 'exhausted':   return 'The strategy service was rate limited and did not recover in time.';
        default:
            if (String(reason).startsWith('http_')) return `The strategy service returned ${String(reason).slice(5)}.`;
            return 'The strategy layer could not be generated.';
    }
}

// ---------------------------------------------------------------------------
// AI PAYLOAD PROJECTORS
//
// The render payload and the model payload are two different documents and
// were being treated as one. A single IG audit serialises to 50-90KB, and
// most of that is thumbnail URLs — Instagram CDN links run 600-1500 characters
// each and there are 21 post cards per account. None of it helps the model.
//
// These projectors carry the numbers a strategist would actually reason over
// and drop everything that only exists to be drawn on screen.
// ---------------------------------------------------------------------------

const AI_PROMPT_BUDGET = parseInt(process.env.AI_PROMPT_BUDGET_CHARS || '40000', 10);
S.AI_PROMPT_BUDGET = AI_PROMPT_BUDGET;

/** A post reduced to the parts that carry signal. No media URLs. */
function aiPostCard(p) {
    if (!p) return null;
    return {
        type: p.type || p.postType || null,
        likes: p.likes ?? null,
        comments: p.comments ?? null,
        views: p.views ?? null,
        index: p.index ?? null,
        postedAt: p.postedAt || p.posted_at || null,
        caption: String(p.caption || '').slice(0, 160)
    };
}

function igAiSlim(a) {
    if (!a) return null;
    return {
        handle: a.handle,
        followers: a.followers,
        totalPosts: a.totalPosts,
        category: a.category,
        isBusiness: a.isBusiness,
        isVerified: a.isVerified,
        bio: String(a.bio || '').slice(0, 300),
        postsAnalyzed: a.postsAnalyzed,
        score: a.score,
        grade: a.grade,
        engagementRate: a.engagementRate,
        engagementRateMedian: a.engagementRateMedian,
        viralityScore: a.viralityScore,
        avgLikes: a.avgLikes,
        avgComments: a.avgComments,
        avgViews: a.avgViews,
        postsPerWeek: a.postsPerWeek,
        scorePillars: (a.scoreBreakdown?.breakdown || [])
            .map(b => ({ pillar: b.pillar, points: b.points, max: b.max, detail: b.detail })),
        confidence: a.scoreBreakdown
            ? { lowConfidence: a.scoreBreakdown.lowConfidence, sampleSize: a.scoreBreakdown.sampleSize, verdict: a.scoreBreakdown.verdict }
            : null,
        completeness: a.completeness
            ? { score: a.completeness.score, missing: a.completeness.missing }
            : null,
        contentMix: a.contentMix,
        topHashtags: (a.topHashtags || []).slice(0, 12),
        captionInsight: a.captionInsight,
        cadence: a.cadence ? {
            postsPerWeek: a.cadence.postsPerWeek,
            longestGapDays: a.cadence.longestGapDays,
            consistency: a.cadence.consistency,
            spanDays: a.cadence.spanDays
        } : null,
        momentum: a.momentum,
        last30Days: a.last30Days,
        bestHours: (a.heatmap?.bestHours || []).slice(0, 5),
        worstHours: (a.heatmap?.worstHours || []).slice(0, 3),
        bestDays: (a.heatmap?.bestDays || []).slice(0, 4),
        heatmapReliable: a.heatmap?.reliable ?? null,
        leaderboards: a.leaderboards ? {
            format: (a.leaderboards.format || []).slice(0, 6),
            length: (a.leaderboards.length || []).slice(0, 6),
            opening: (a.leaderboards.opening || []).slice(0, 6),
            topic: (a.leaderboards.topic || []).slice(0, 8)
        } : null,
        copyFlags: a.flags,
        topPosts: (a.topPosts || []).slice(0, 5).map(aiPostCard),
        bottomPosts: (a.bottomPosts || []).slice(0, 3).map(aiPostCard),
        provisionalExcluded: a.provisional
            ? { count: a.provisional.count, excludedFromRates: a.provisional.excludedFromRates }
            : null,
        missingSignals: a.dataQuality?.missing || []
    };
}

function igAiPayload({ target, rivals = [], benchmark = null }) {
    return {
        target: igAiSlim(target),
        rivals: (rivals || []).slice(0, 6).map(igAiSlim),
        benchmark: benchmark ? {
            cohort: benchmark.cohort,
            targetRank: benchmark.targetRank,
            gaps: benchmark.gaps || null,
            leaders: benchmark.leaders || null
        } : null
    };
}

function fbGroupAiSlim(g) {
    if (!g) return null;
    return {
        name: g.name,
        groupId: g.groupId,
        members: g.members ?? null,
        postsAnalyzed: g.postsAnalyzed,
        roomValue: g.roomValue,
        medianComments: g.medianComments,
        medianReactions: g.medianReactions,
        postsPerDay: g.postsPerDay ?? g.cadence?.postsPerDay ?? null,
        demandSignals: g.demandSignals,
        rules: g.rules,
        intents: g.intents,
        categories: g.categories,
        formats: g.formats || g.mediaMix || null,
        bestHours: (g.heatmap?.bestHours || g.bestHours || []).slice(0, 5),
        bestDays: (g.heatmap?.bestDays || g.bestDays || []).slice(0, 4),
        leaderboards: g.leaderboards,
        topDemand: (g.topDemand || g.demand || []).slice(0, 12),
        exemplars: (g.exemplars || []).slice(0, 4).map(aiPostCard)
    };
}

function fbPageAiSlim(p) {
    if (!p) return null;
    return {
        name: p.name,
        pageId: p.pageId,
        category: p.category,
        likes: p.likes ?? null,
        followers: p.followers ?? null,
        postsAnalyzed: p.postsAnalyzed,
        score: p.score,
        grade: p.grade,
        engagementRate: p.engagementRate,
        avgReactions: p.avgReactions,
        avgComments: p.avgComments,
        avgShares: p.avgShares,
        scorePillars: (p.scoreBreakdown?.breakdown || [])
            .map(b => ({ pillar: b.pillar, points: b.points, max: b.max, detail: b.detail })),
        completeness: p.completeness ? { score: p.completeness.score, missing: p.completeness.missing } : null,
        cadence: p.cadence,
        momentum: p.momentum,
        sentiment: p.sentiment || p.reactionSentiment || null,
        bestHours: (p.heatmap?.bestHours || []).slice(0, 5),
        bestDays: (p.heatmap?.bestDays || []).slice(0, 4),
        leaderboards: p.leaderboards,
        copyFlags: p.flags,
        reviews: p.reviews ? { rating: p.reviews.rating, count: p.reviews.count, themes: (p.reviews.themes || []).slice(0, 8) } : null,
        topPosts: (p.topPosts || []).slice(0, 5).map(aiPostCard),
        bottomPosts: (p.bottomPosts || []).slice(0, 3).map(aiPostCard),
        missingSignals: p.dataQuality?.missing || []
    };
}

async function geminiNarrative(payload) {
    if (!geminiAvailable()) {
        return { ai: null, aiStatus: { ok: false, reason: 'no_key', message: aiReasonText('no_key') } };
    }

    const { json, dropped, chars } = budgetedJson(igAiPayload(payload), {
        maxChars: AI_PROMPT_BUDGET,
        keep: ['target', 'benchmark']
    });

    const prompt =
`You are a senior social media strategist writing a paid client audit.
Analyse the JSON below and reply with ONLY valid JSON matching this schema:

{
 "executive_summary": "3-4 sentences a business owner would understand",
 "strengths": ["..."],
 "weaknesses": ["..."],
 "competitor_insights": ["what rivals are doing that the target is not"],
 "content_strategy": ["specific formats, hooks and posting slots"],
 "hashtag_strategy": ["..."],
 "action_plan_30_days": [{"week":"Week 1","actions":["..."]}],
 "kpi_targets": {"engagement_rate":"x%","posts_per_week":"n","reels_share":"x%"}
}

No markdown, no commentary outside the JSON.
Ground every claim in the numbers supplied. Never invent a metric that is not in the data.
If the rivals array is empty, return an empty array for competitor_insights rather than guessing.

DATA:
${json}`;

    const r = await geminiCallDetailed(prompt, { temperature: 0.4, tag: 'Gemini IG' });
    logger.info('ai_narrative', { tag: 'ig', ok: r.ok, reason: r.reason, promptChars: chars, dropped });
    return {
        ai: r.data,
        aiStatus: {
            ok: r.ok, reason: r.reason, message: aiReasonText(r.reason),
            promptChars: chars, dropped, model: GEMINI_MODEL,
            generatedAt: new Date().toISOString()
        }
    };
}
