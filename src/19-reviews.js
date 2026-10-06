/**
 * The review tracker.
 *
 * Part of the EdgeLead server, split out of server.js (phase 55). The parts load in
 * order from server.js and share one namespace, S: what this part needs from an earlier
 * part is unpacked below; anything else from another part is read as S.name when it runs.
 */
'use strict';
const S = require('./shared');
const {
    COST_PER_1K_POSTS, COST_PER_1K_PROFILE, JOB_WORKERS, LK_BUSINESS_HANDLE, LK_BUSINESS_WORDS,
    LK_BUSINESS_WORDS_BN, LK_RATING, app, assertJobSlot, budgetSnapshot, callActor, clientAccess, createJob,
    docDay, docFinish, docFmt, docMonth, docNum, docPct, geminiAvailable, geminiCallDetailed,
    getWorkingClient, igIsSponsored, leadAssessment, leadPostSignal, leadSignalsAdd, leadsPhase40,
    linkLeadsToClient, oneLine, registerWorker, requireEngine, resolveClientId, runActor, runJob, sendErr,
    shortcodeOf, spendLimit, staffOnly, supabase, takeLeadQuota, tsOf, visibleClientIds
} = S;
Object.assign(S, {
    reviewEstimate, reviewPrivateIp, safePublicFetch, igHandleFromUrl, reviewPlace, reviewNameMatch,
    classifyTaggedPost, reviewAggregate, reviewDoc
});
Object.defineProperty(S, '_reviewLookup', { get: () => _reviewLookup, set: (v) => { _reviewLookup = v; }, enumerable: true });

// ===========================================================================
// PHASE 41 :: THE REVIEW TRACKER
//
// What staff did by hand, one handle at a time: open a restaurant's tagged
// posts and read which ones were reviews. Now for a whole area at once:
//   1. the businesses of a kind around a place, from Google Maps;
//   2. each one's Instagram: the link on Maps or on their website (sure),
//      else an Instagram search checked against the name (likely, or "check"
//      for a person to confirm — never a guess passed off as a match);
//   3. each one's tagged posts over a window (90 days by default);
//   4. every tagged post read: a review (organic or paid), a customer's
//      photo, another business, or unclear. Rules decide the clear ones for
//      free; only the unclear go to the model, twenty captions a call;
//   5. the creators who reviewed become influencer leads, and a scoreboard
//      says who is being reviewed and by whom.
// Public posts only. The tagged tab shows photo tags, not caption mentions
// or collab posts; the report says so.
// ===========================================================================

const REVIEW_MAPS_ACTOR    = process.env.REVIEW_MAPS_ACTOR || 'compass/crawler-google-places';
const REVIEW_MAPS_CONTACTS = String(process.env.REVIEW_MAPS_CONTACTS || 'true') !== 'false';
const COST_PER_1K_PLACES   = parseFloat(process.env.COST_PER_1K_PLACES || (REVIEW_MAPS_CONTACTS ? '7' : '4'));
const REVIEW_MAX_BUSINESSES = 30;
const REVIEW_MAX_POSTS      = 100;
const REVIEW_AI_BATCH       = 20;

/** What a scan will cost at most, before it starts. */
function reviewEstimate({ places = 0, businesses = 0, postsPer = 40, searches = 0 } = {}) {
    const usd = (places / 1000) * COST_PER_1K_PLACES
        + (businesses * postsPer / 1000) * COST_PER_1K_POSTS
        + searches * (COST_PER_1K_PROFILE / 20);
    return +usd.toFixed(4);
}

// --- a website fetch that cannot be turned on our own network --------------
// A Maps listing's website is someone else's text. Fetching it from the
// server is fine; fetching whatever it redirects to on 10.x or the metadata
// address is not. Every hop is resolved and checked.
function reviewPrivateIp(ip) {
    const v = String(ip || '').toLowerCase();
    if (v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true;
    const m = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(v);
    if (!m) return false;
    const [a, b] = [+m[1], +m[2]];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
let _reviewLookup = (host) => require('dns').promises.lookup(host, { all: true });
async function safePublicFetch(url, { maxBytes = 600000, timeoutMs = 8000, hops = 3 } = {}) {
    let target = String(url || '');
    for (let i = 0; i <= hops; i++) {
        let u;
        try { u = new URL(target); } catch { return null; }
        if (!/^https?:$/.test(u.protocol)) return null;
        const host = u.hostname.replace(/^\[|\]$/g, '');
        const net = require('net');
        const ips = net.isIP(host) ? [{ address: host }] : await _reviewLookup(host).catch(() => []);
        if (!ips.length || ips.some(x => reviewPrivateIp(x.address))) return null;
        let r;
        try { r = await fetch(u.toString(), { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'Mozilla/5.0 (EdgeLead review tracker)' } }); }
        catch { return null; }
        if (r.status >= 300 && r.status < 400 && r.headers && r.headers.get && r.headers.get('location')) {
            target = new URL(r.headers.get('location'), u).toString();
            continue;
        }
        if (!r.ok) return null;
        const type = String((r.headers && r.headers.get && r.headers.get('content-type')) || '');
        if (type && !/text\/html|application\/xhtml/i.test(type)) return null;
        const text = await r.text().catch(() => '');
        return text.slice(0, maxBytes);
    }
    return null;
}

const IG_RESERVED = new Set(['p', 'reel', 'reels', 'explore', 'stories', 'accounts', 'tv', 'about', 'developer', 'legal', 'direct', 'web', 'share']);
/** An Instagram handle from a link, or null. */
function igHandleFromUrl(v) {
    const m = /instagram\.com\/(?:#!\/)?([A-Za-z0-9._]{1,30})(?:[/?#]|$)/i.exec(String(v || ''));
    if (!m) return null;
    const h = m[1].toLowerCase().replace(/\.+$/, '');
    return IG_RESERVED.has(h) ? null : h;
}

/** One Maps listing, whatever the actor calls its fields. */
function reviewPlace(it) {
    const socials = [].concat(it.instagrams || [], it.instagram || [], (it.socialMedia && it.socialMedia.instagram) || [], it.socialProfiles || [])
        .map(x => (typeof x === 'string' ? x : (x && (x.url || x.link)) || '')).filter(Boolean);
    const website = it.website || it.url_website || null;
    const handle = socials.map(igHandleFromUrl).find(Boolean) || igHandleFromUrl(website) || null;
    return {
        key: String(it.placeId || it.place_id || it.cid || it.url || it.title || it.name || '').slice(0, 200),
        name: oneLine(it.title || it.name || '', 120) || null,
        category: oneLine(it.categoryName || it.category || (Array.isArray(it.categories) ? it.categories[0] : '') || '', 80) || null,
        address: oneLine(it.address || it.street || '', 200) || null,
        phone: it.phone || it.phoneUnformatted || null,
        website: website && /^https?:\/\//i.test(website) && !/instagram\.com/i.test(website) ? website : null,
        rating: docNum(it.totalScore ?? it.rating),
        reviews: docNum(it.reviewsCount ?? it.reviews),
        mapsUrl: /^https:\/\/(www\.)?google\.[a-z.]+\/maps/i.test(String(it.url || '')) ? it.url : null,
        handle, source: handle ? 'maps' : null
    };
}

/** How alike a business name and an Instagram account are, 0–1. */
function reviewNameMatch(name, acct) {
    const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\b(the|and|restaurant|cafe|café|bd|dhaka|ltd|official)\b/g, ' ').split(/\s+/).filter(t => t.length > 1);
    const a = new Set(norm(name));
    if (!a.size) return 0;
    const b = new Set([...norm(acct.fullName || acct.full_name), ...norm(String(acct.username || '').replace(/[._]/g, ' '))]);
    const squash = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    let hit = 0; for (const t of a) if (b.has(t)) hit++;
    let score = hit / a.size;
    if (squash(acct.username).includes(squash([...a].join(''))) && [...a].join('').length >= 4) score = Math.max(score, 0.9);
    return +Math.min(1, score).toFixed(2);
}

// What a tagged post is. Signals, each counted once per post.
const RV_SIGNALS = [
    [/\b(review(ed|ing)?|rating|rated|verdict|overall|pros|cons)\b|রিভিউ|রেটিং/i, 'calls it a review'],
    [/\b(tast(e|ed|y)|flavou?r|portion|ambien(ce|ce)|ambiance|service|presentation|texture|spicy|juicy|crispy)\b|স্বাদ|পরিবেশ|সার্ভিস/i, 'talks about taste, portions or service'],
    [/\b(price|priced|tk\.?\s?\d|\d+\s?tk|taka|bdt|\$\d|worth (it|the|every))\b|৳|দাম/i, 'mentions the price or value'],
    [/\b(must[- ]?try|(would|highly|definitely|don'?t) recommend|go[- ]to|hidden gem|come back|again)\b|অবশ্যই|আবার/i, 'recommends it (or not)'],
    [/\b(tried|trying|visited|checked (it )?out|went to|first time)\b|ট্রাই|খেয়ে দেখ|গিয়েছিলাম|ঘুরে এলাম/i, 'describes a visit']
];
const RV_PAID = /\b(in collaboration with|collab(oration)?|invited( by)?|gifted|complimentary|hosted by|thanks? (to|for) .{0,24}(having|hosting|inviting)|#ad\b|#pr\b|#sponsored|paid partnership)\b|দাওয়াত/i;

/**
 * One tagged post: review (organic or paid), customer, business, or unclear.
 * Unclear goes to the model; everything else is decided here, for free.
 */
function classifyTaggedPost(p, venue) {
    const caption = String(p.caption || p.text || '');
    const poster = String(p.ownerUsername || p.owner?.username || '').toLowerCase();
    const reasons = [];
    if (!poster) return { label: 'other', reasons: ['No poster'], score: 0 };
    if (venue && poster === String(venue).toLowerCase()) return { label: 'business', reasons: ['Posted by the business itself'], score: 0 };
    let score = 0;
    for (const [re, why] of RV_SIGNALS) if (re.test(caption)) { score += 1; reasons.push(why); }
    if (LK_RATING.test(caption)) { score += 2; reasons.push('gives a rating'); }
    if (caption.length > 180) { score += 1; reasons.push('a long caption'); }
    if (/reel|clips|video/i.test(String(p.productType || p.type || ''))) { score += 1; reasons.push('a Reel or video'); }
    const paid = igIsSponsored(p) || RV_PAID.test(caption);
    const sells = LK_BUSINESS_WORDS.test(caption) || LK_BUSINESS_WORDS_BN.test(caption);
    if ((LK_BUSINESS_HANDLE.test(poster) || sells) && score < 3) return { label: 'business', reasons: [sells ? 'The caption sells something' : 'Posted by another business'], score };
    if (score >= 3) return { label: paid ? 'review_paid' : 'review', reasons: paid ? ['marked as a collaboration or ad', ...reasons] : reasons, score };
    // A short caption with no opinion at all is someone's photo from a
    // visit. "Loved the place" is an opinion, just a thin one: that goes to
    // the model rather than being guessed either way.
    const opinion = /\b(lov(e|ed|ing)|amazing|awesome|delicious|yumm?y|tasty|best|favou?rite|disappoint\w*|overrated|underrated|meh|not worth|bad|great)\b|মজা|অসাধারণ|দারুণ|ভালো|খারাপ/i.test(caption);
    if (score === 0 && caption.length < 90 && !paid && !opinion) return { label: 'customer', reasons: ['A short caption with nothing about the place'], score };
    return { label: 'unclear', reasons, score, paid };
}

/** The unclear ones, twenty at a time. Returns labels by index; missing means still unclear. */
async function reviewAiLabels(items, userId) {
    if (!items.length || !geminiAvailable()) return {};
    const prompt =
`Each item is an Instagram post that tagged a business (the venue). Decide what each post is.
Labels:
- "review": the poster gives an opinion of the venue (food, price, service, recommend or not), as a creator or a customer writing a review.
- "customer": a photo from a visit with no real opinion (e.g. "dinner with family", "birthday!").
- "business": posted by another business, a supplier, an event, or an ad.
- "other": anything else.
Set "paid": true only when the caption says it was a collaboration, invitation, gift or ad.
Captions may be in English or Bangla. Judge only from the text given.

Items (JSON):
${JSON.stringify(items.map(x => ({ i: x.i, venue: '@' + x.venue, poster: '@' + x.poster, caption: String(x.caption || '').slice(0, 500) })))}

Reply with ONLY this JSON: {"labels":[{"i":0,"label":"review","paid":false}]}`;
    const r = await geminiCallDetailed(prompt, { temperature: 0.1, maxOutputTokens: 2000, tag: 'Gemini review sort', userId });
    if (!r.ok || !Array.isArray(r.data?.labels)) return {};
    const out = {};
    for (const x of r.data.labels) {
        if (!x || !Number.isInteger(x.i)) continue;
        const l = String(x.label || '');
        if (l === 'review') out[x.i] = x.paid ? 'review_paid' : 'review';
        else if (['customer', 'business', 'other'].includes(l)) out[x.i] = l;
    }
    return out;
}

const RV_IS_REVIEW = l => l === 'review' || l === 'review_paid';

/** The scoreboard and the reviewer list, from the posts read. Pure. */
function reviewAggregate(businesses, posts, { clientHandle = null, previous = null } = {}) {
    const prevIds = new Set((previous && previous.postIds) || []);
    const prevReviewers = new Set((previous && previous.reviewers) || []);
    const byBiz = new Map(businesses.map(b => [b.handle, { ...b, tagged: 0, reviews: 0, paid: 0, customers: 0, unclear: 0, reviewers: new Set(), lastReview: null, newReviews: 0 }]));
    const people = new Map();
    for (const p of posts) {
        const b = byBiz.get(p.venue);
        if (!b) continue;
        b.tagged++;
        if (p.label === 'customer') b.customers++;
        if (p.label === 'unclear') b.unclear++;
        if (!RV_IS_REVIEW(p.label)) continue;
        b.reviews++; if (p.label === 'review_paid') b.paid++;
        b.reviewers.add(p.poster);
        if (p.at && (!b.lastReview || p.at > b.lastReview)) b.lastReview = p.at;
        const isNew = !!previous && !prevIds.has(p.id);
        if (isNew) b.newReviews++;
        const r = people.get(p.poster) || { handle: p.poster, reviews: 0, paid: 0, venues: new Set(), engagement: 0, last: null, posts: [], isNew: false };
        r.reviews++; if (p.label === 'review_paid') r.paid++;
        r.venues.add(p.venue);
        r.engagement += (p.likes || 0) + (p.comments || 0);
        if (p.at && (!r.last || p.at > r.last)) r.last = p.at;
        if (r.posts.length < 3) r.posts.push({ url: p.url, venue: p.venue, caption: oneLine(p.caption, 200), at: p.at, paid: p.label === 'review_paid' });
        people.set(p.poster, r);
    }
    const client = clientHandle ? String(clientHandle).toLowerCase() : null;
    const reviewers = [...people.values()].map(r => ({
        handle: r.handle, reviews: r.reviews, paid: r.paid, venues: [...r.venues],
        avgEngagement: Math.round(r.engagement / Math.max(1, r.reviews)), last: r.last, posts: r.posts,
        reviewedClient: client ? r.venues.has(client) : null,
        isNew: !!previous && !prevReviewers.has(r.handle)
    })).sort((a, b) => (b.venues.length - a.venues.length) || (b.avgEngagement - a.avgEngagement));
    const board = [...byBiz.values()].map(b => ({
        name: b.name, handle: b.handle, match: b.match || null, rating: b.rating ?? null, mapsReviews: b.reviews_maps ?? null,
        tagged: b.tagged, reviews: b.reviews, paid: b.paid, customers: b.customers, unclear: b.unclear,
        creators: b.reviewers.size, lastReview: b.lastReview, newReviews: b.newReviews, isClient: !!client && b.handle === client
    })).sort((a, b) => b.reviews - a.reviews);
    return { board, reviewers, missedByClient: client ? reviewers.filter(r => !r.reviewedClient).slice(0, 25) : [] };
}


/** The kinds of business to look for: one or several, comma-separated. */
function reviewCategories(input) {
    const raw = Array.isArray(input.categories) ? input.categories : String(input.category || '').split(',');
    return [...new Set(raw.map(c => oneLine(c, 60)).filter(Boolean))].slice(0, 5);
}

/**
 * Steps 1 and 2 of a scan, also run on their own (review_places) so staff can
 * see the list, untick businesses, fix a handle or add rivals before paying
 * to read anyone's tagged posts. Each run sets its own sources:
 *   - Google Maps: one or more kinds of business around an area, as many as
 *     asked, filtered by rating and review count;
 *   - a list of Instagram handles (the old manual rival style), used as given;
 *   - one business to include (usually the client).
 */
async function reviewGatherPlaces(userId, input, jobId, progress, ck, warnings) {
    const maxBiz = Math.min(REVIEW_MAX_BUSINESSES, Math.max(1, parseInt(input.maxBusinesses, 10) || 15));
    const cats = reviewCategories(input);
    const area = oneLine(input.area, 120) || null;
    const minRating = docNum(input.minRating), minReviews = docNum(input.minReviews);
    const skip = new Set((input.exclude || []).map(x => String(x || '').toLowerCase()));
    let places = ck.get('places');
    if (!places) {
        places = [];
        for (const h of (input.handles || []).slice(0, REVIEW_MAX_BUSINESSES)) {
            const handle = String(h.handle || h || '').replace('@', '').trim().toLowerCase();
            if (/^[a-z0-9._]{1,30}$/.test(handle) && !places.some(p => p.handle === handle)) places.push({ key: 'ig:' + handle, name: oneLine(h.name, 120) || '@' + handle, handle, source: 'given', match: 'sure' });
        }
        if (cats.length && area && input.useMaps !== false) {
            await progress(5, `Finding ${cats.join(', ')} around ${area} on Google Maps`);
            // Asked for per kind, filtered after: a rating filter can only
            // remove, so ask for a little more when one is set.
            const per = Math.min(REVIEW_MAX_BUSINESSES, Math.ceil(maxBiz / cats.length * (minRating || minReviews ? 1.5 : 1)));
            const need = +(per * cats.length / 1000 * COST_PER_1K_PLACES).toFixed(4);
            const { client } = await getWorkingClient('leadgen', userId, { needUsd: need, jobId });
            try {
                const { items } = await callActor(client, REVIEW_MAPS_ACTOR, {
                    searchStringsArray: cats, locationQuery: area, maxCrawledPlacesPerSearch: per,
                    language: 'en', skipClosedPlaces: true, ...(REVIEW_MAPS_CONTACTS ? { scrapeContacts: true } : {})
                }, { estimateUsd: need, maxItems: per * cats.length, jobId });
                const seen = new Set(places.map(p => p.handle).filter(Boolean)), keys = new Set();
                let dropped = 0, added = 0;
                for (const it of (items || []).map(reviewPlace)) {
                    if (!it.name || keys.has(it.key)) continue;
                    keys.add(it.key);
                    if (it.handle && (seen.has(it.handle) || skip.has(it.handle))) continue;
                    if ((minRating !== null && (it.rating === null || it.rating < minRating)) || (minReviews !== null && (it.reviews === null || it.reviews < minReviews))) { dropped++; continue; }
                    if (added >= maxBiz) break;
                    if (it.handle) seen.add(it.handle);
                    places.push({ ...it, match: it.handle ? 'sure' : null, reviews_maps: it.reviews });
                    added++;
                }
                if (dropped) warnings.push(`${dropped} business(es) on Maps were below the rating or review count asked for and were left out.`);
            } catch (e) {
                if (e.code === 'NO_CREDIT' || e.code === 'CANCELLED') throw e;
                warnings.push(`Google Maps search failed: ${e.message}`);
            }
        }
        if (input.seed) {
            const h = igHandleFromUrl(input.seed) || (/^@?[a-z0-9._]{1,30}$/i.test(String(input.seed).trim()) ? String(input.seed).trim().replace('@', '').toLowerCase() : null);
            if (h && !places.some(p => p.handle === h)) places.unshift({ key: 'ig:' + h, name: '@' + h, handle: h, source: 'given', match: 'sure' });
        }
        await ck.done('places', places);
    }
    if (!places.length) throw Object.assign(new Error('No businesses to scan. Give a kind of business and an area, or Instagram handles.'), { statusCode: 422 });

    // --- 2. their Instagram ---------------------------------------------------
    await progress(15, 'Finding each business’s Instagram');
    for (let i = 0; i < places.length; i++) {
        const p = places[i];
        if (p.handle) continue;
        const unit = 'match:' + p.key;
        if (ck.isDone(unit)) { Object.assign(p, ck.get(unit) || {}); continue; }
        let found = null;
        if (p.website) {
            const html = await safePublicFetch(p.website);
            const h = html ? [...html.matchAll(/instagram\.com\/(?:#!\/)?[A-Za-z0-9._]{1,30}/gi)].map(m => igHandleFromUrl(m[0])).find(Boolean) : null;
            if (h) found = { handle: h, source: 'website', match: 'sure' };
        }
        // The name search costs a little each; a run can switch it off and
        // leave unlinked businesses for a person to fill in.
        if (!found && p.name && input.searchNames !== false) {
            const need = +(COST_PER_1K_PROFILE / 20).toFixed(4);
            try {
                const { client } = await getWorkingClient('leadgen', userId, { needUsd: need, jobId });
                const { items } = await callActor(client, 'apify/instagram-search-scraper',
                    { searchQueries: [`${p.name} ${area || ''}`.trim()], searchType: 'user' }, { estimateUsd: need, maxItems: 10, jobId });
                const best = (items || []).map(a => ({ a, s: reviewNameMatch(p.name, a) })).filter(x => x.a && (x.a.username || x.a.ownerUsername)).sort((x, y) => y.s - x.s)[0];
                if (best && best.s >= 0.5) found = { handle: String(best.a.username || best.a.ownerUsername).toLowerCase(), source: 'search', match: best.s >= 0.75 ? 'likely' : 'check', matchScore: best.s };
            } catch (e) {
                if (e.code === 'NO_CREDIT' || e.code === 'CANCELLED') throw e;
                warnings.push(`Instagram search for “${p.name}” failed: ${e.message}`);
            }
        }
        Object.assign(p, found || { handle: null, match: 'none' });
        await ck.done(unit, found || { handle: null, match: 'none' });
        await progress(15 + Math.round(15 * (i + 1) / places.length), `Matched ${i + 1} of ${places.length}`);
    }
    return places;
}

/** Step one on its own: the list to choose from, before any tagged posts are read. */
registerWorker('review_places', (userId, input, jobId) => async (progress, ck) => {
    const warnings = [];
    const places = await reviewGatherPlaces(userId, input, jobId, progress, ck, warnings);
    await progress(100, `${places.length} business(es) found`);
    return {
        places: places.map(p => ({ key: p.key, name: p.name || null, category: p.category || null, address: p.address || null, rating: p.rating ?? null,
            reviews: p.reviews_maps ?? p.reviews ?? null, handle: p.handle || null, match: p.match || 'none', matchScore: p.matchScore ?? null,
            source: p.source || null, website: p.website || null, mapsUrl: p.mapsUrl || null })),
        warnings
    };
});

registerWorker('review_scan', (userId, input, jobId) => async (progress, ck) => {
    const warnings = [];
    const days = Math.min(365, Math.max(7, parseInt(input.days, 10) || 90));
    const postsPer = Math.min(REVIEW_MAX_POSTS, Math.max(10, parseInt(input.postsPer, 10) || 40));
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const category = reviewCategories(input).join(', ') || null, area = oneLine(input.area, 120) || null;

    const places = await reviewGatherPlaces(userId, input, jobId, progress, ck, warnings);

    const scan = places.filter(p => p.handle && (p.match === 'sure' || p.match === 'likely'));
    const unmatched = places.filter(p => !p.handle || p.match === 'check' || p.match === 'none');

    // --- 3. tagged posts ------------------------------------------------------
    const posts = [];
    for (let i = 0; i < scan.length; i++) {
        const b = scan[i];
        const unit = 'tagged:' + b.handle;
        let rows = ck.get(unit);
        if (!ck.isDone(unit)) {
            await progress(30 + Math.round(45 * i / Math.max(1, scan.length)), `Reading posts that tagged @${b.handle} (${i + 1} of ${scan.length})`);
            const need = +(postsPer / 1000 * COST_PER_1K_POSTS).toFixed(4);
            const { client } = await getWorkingClient('leadgen', userId, { needUsd: need, jobId });
            const items = await runActor('apify/instagram-scraper',
                { directUrls: [`https://www.instagram.com/${b.handle}/tagged/`], resultsLimit: postsPer, scrollWaitSecs: 5, pageTimeoutSecs: 60 },
                warnings, `Tagged @${b.handle}`, client, { jobId, estimateUsd: need, maxItems: postsPer });
            rows = (items || []).map(p => ({
                id: String(p.shortCode || p.shortcode || p.id || ''), venue: b.handle,
                poster: String(p.ownerUsername || p.owner?.username || '').toLowerCase(),
                caption: String(p.caption || '').slice(0, 1200), at: tsOf(p)?.toISOString() || null,
                likes: Number(p.likesCount) || 0, comments: Number(p.commentsCount) || 0,
                url: /^https:\/\/(www\.)?instagram\.com\//.test(String(p.url || '')) ? p.url : (shortcodeOf(p) ? `https://www.instagram.com/p/${shortcodeOf(p)}/` : null),
                sig: leadPostSignal(p, 'review', b.handle),
                ...(() => { const c = classifyTaggedPost(p, b.handle); return { label: c.label, why: c.reasons, decided: 'rules' }; })()
            })).filter(p => p.id && p.poster && (!p.at || p.at >= since));
            await ck.done(unit, rows);
        }
        posts.push(...(rows || []));
    }

    // --- 4. the unclear ones ---------------------------------------------------
    const unclear = input.useAi === false ? [] : posts.map((p, i) => ({ p, i })).filter(x => x.p.label === 'unclear');
    for (let s = 0; s < unclear.length; s += REVIEW_AI_BATCH) {
        const unit = 'ai:' + s;
        let labels = ck.get(unit);
        if (!ck.isDone(unit)) {
            await progress(78, `Reading ${unclear.length - s} unclear post(s)`);
            labels = await reviewAiLabels(unclear.slice(s, s + REVIEW_AI_BATCH).map(x => ({ i: x.i, venue: x.p.venue, poster: x.p.poster, caption: x.p.caption })), userId);
            await ck.done(unit, labels);
        }
        for (const [i, l] of Object.entries(labels || {})) { posts[+i].label = l; posts[+i].decided = 'ai'; }
    }

    // --- 5. the scoreboard, the reviewers, and the leads -------------------------
    await progress(85, 'Adding up who reviewed whom');
    const clientRow = input.clientId ? (await supabase.from('clients').select('id, ig_handle').eq('id', input.clientId).maybeSingle()).data : null;
    const clientHandle = clientRow && clientRow.ig_handle ? String(clientRow.ig_handle).replace('@', '').toLowerCase() : null;
    const keyOf = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    let prevQ = supabase.from('reports').select('report_json, created_at').eq('report_type', 'review_scan');
    prevQ = input.clientId ? prevQ.eq('client_id', input.clientId) : prevQ.eq('user_id', userId);
    const { data: prevRows } = await prevQ.order('created_at', { ascending: false }).limit(5);
    const prev = (prevRows || []).map(r => r.report_json || {}).find(j => keyOf(j.category) === keyOf(category) && keyOf(j.area) === keyOf(area)) || null;
    const agg = reviewAggregate(scan, posts, { clientHandle, previous: prev ? { postIds: prev.postIds || [], reviewers: (prev.reviewers || []).map(r => r.handle) } : null });

    let savedLeads = 0;
    if (await leadsPhase40()) {
        const reviewersAll = agg.reviewers;
        const names = reviewersAll.map(r => r.handle);
        const { data: existing } = names.length ? await supabase.from('leads').select('*').eq('owner_user_id', userId).eq('platform', 'instagram').in('username', names) : { data: [] };
        const have = new Map((existing || []).map(l => [l.username, l]));
        const fresh = names.filter(n => !have.has(n));
        const allowed = await takeLeadQuota(userId, fresh.length);
        if (allowed < fresh.length) warnings.push(`Lead allowance reached: ${fresh.length - allowed} reviewer(s) were not saved as leads.`);
        const postsBy = h => posts.filter(p => p.poster === h && RV_IS_REVIEW(p.label)).map(p => p.sig);
        const ids = [];
        for (const h of fresh.slice(0, allowed)) {
            const sig = leadSignalsAdd(null, postsBy(h));
            const row = { owner_user_id: userId, platform: 'instagram', username: h, profile_url: `https://instagram.com/${h}`,
                industry: category, location: area, is_enriched: false, signals: sig, methods: ['review'], full_name: sig.fullName || null };
            Object.assign(row, leadAssessment(row, sig, row.methods));
            const { data } = await supabase.from('leads').upsert([row], { onConflict: 'owner_user_id,platform,username', ignoreDuplicates: false }).select('id').maybeSingle();
            if (data) { ids.push(data.id); savedLeads++; }
        }
        for (const [h, l] of have) {
            const sig = leadSignalsAdd(l.signals, postsBy(h));
            const methods = [...new Set([...(l.methods || []), 'review'])];
            await supabase.from('leads').update({ signals: sig, methods, ...leadAssessment(l, sig, methods) }).eq('id', l.id);
            ids.push(l.id);
        }
        if (input.clientId) await linkLeadsToClient(input.clientId, ids, 'review_scan', jobId);
    }

    const counts = {
        businesses: places.length, scanned: scan.length, unmatched: unmatched.length,
        tagged: posts.length, reviews: posts.filter(p => RV_IS_REVIEW(p.label)).length,
        paid: posts.filter(p => p.label === 'review_paid').length, customers: posts.filter(p => p.label === 'customer').length,
        unclear: posts.filter(p => p.label === 'unclear').length, byAi: posts.filter(p => p.decided === 'ai').length,
        creators: agg.reviewers.length
    };
    const top = posts.filter(p => RV_IS_REVIEW(p.label)).sort((a, b) => (b.likes + b.comments) - (a.likes + a.comments)).slice(0, 6)
        .map(p => ({ url: p.url, venue: p.venue, poster: p.poster, caption: oneLine(p.caption, 240), at: p.at, likes: p.likes, comments: p.comments, paid: p.label === 'review_paid' }));
    const report = {
        category, area, windowDays: days, postsPer, generatedAt: new Date().toISOString(),
        clientHandle, counts, board: agg.board, reviewers: agg.reviewers.slice(0, 60), missedByClient: agg.missedByClient, top,
        unmatched: unmatched.map(p => ({ name: p.name, handle: p.handle || null, match: p.match, address: p.address || null, website: p.website || null, mapsUrl: p.mapsUrl || null })),
        postIds: posts.map(p => p.id), hasPrevious: !!prev, warnings: warnings.slice(0, 20)
    };
    await progress(95, 'Saving the scoreboard');
    const { data: saved, error } = await supabase.from('reports').insert([{
        user_id: userId, client_id: input.clientId || null, platform: 'instagram', report_type: 'review_scan',
        target_handle: [category, area].filter(Boolean).join(' · ') || scan.map(b => '@' + b.handle).slice(0, 3).join(', '),
        posts_analyzed: posts.length, snapshot_date: new Date().toISOString().slice(0, 10),
        report_json: report
    }]).select('id').maybeSingle();
    if (error) throw error;
    return { reportId: saved?.id || null, ...counts, savedLeads, warnings };
});

/** Recent scans this person can open: their own, and those filed under their clients. */
app.get('/api/reviews/scans', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        const { data } = await supabase.from('reports').select('id, user_id, client_id, target_handle, created_at, report_json')
            .eq('report_type', 'review_scan').order('created_at', { ascending: false }).limit(200);
        const visible = await visibleClientIds(ctx);
        const rows = (data || []).filter(r => r.user_id === ctx.user.id || (r.client_id && (!visible || visible.has(r.client_id)))).slice(0, 20);
        const names = {};
        const ids = [...new Set(rows.map(r => r.client_id).filter(Boolean))];
        if (ids.length) { const { data: cs } = await supabase.from('clients').select('id, name, brand').in('id', ids); (cs || []).forEach(c => { names[c.id] = c.brand || c.name; }); }
        res.json({ scans: rows.map(r => ({ id: r.id, title: r.target_handle, createdAt: r.created_at, clientId: r.client_id, client: names[r.client_id] || null,
            counts: (r.report_json && r.report_json.counts) || {}, windowDays: r.report_json && r.report_json.windowDays })) });
    } catch (err) { sendErr(res, err); }
});

/** Before a scan: what it will cost at most. */
app.get('/api/reviews/estimate', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;
        const max = Math.min(REVIEW_MAX_BUSINESSES, Math.max(1, parseInt(req.query.max, 10) || 15));
        const postsPer = Math.min(REVIEW_MAX_POSTS, Math.max(10, parseInt(req.query.posts, 10) || 40));
        const handles = Math.min(REVIEW_MAX_BUSINESSES, parseInt(req.query.handles, 10) || 0);
        const maps = String(req.query.maps || '1') !== '0';
        const names = String(req.query.names || '1') !== '0';
        const step = String(req.query.step || 'scan');
        const usd = step === 'find'
            ? reviewEstimate({ places: maps ? max : 0, searches: maps && names ? max : 0 })
            : reviewEstimate({ places: maps ? max : 0, businesses: (maps ? max : 0) + handles, postsPer, searches: maps && names ? max : 0 });
        res.json({ usd, note: 'The most it can cost: every business needing an Instagram search and every tagged post read. Most runs cost less.' });
    } catch (err) { sendErr(res, err); }
});

/** The per-run choices both steps take, cleaned once. */
function reviewInput(b = {}) {
    const handles = (Array.isArray(b.handles) ? b.handles : String(b.handles || '').split(/[\s,]+/))
        .map(h => (typeof h === 'string' ? { handle: h } : h))
        .filter(h => h && /^@?[a-z0-9._]{1,30}$/i.test(String(h.handle || '').trim())).slice(0, REVIEW_MAX_BUSINESSES)
        .map(h => ({ handle: String(h.handle).replace('@', '').trim().toLowerCase(), name: h.name ? oneLine(h.name, 120) : null }));
    const num = (v, lo, hi) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
    const categories = reviewCategories({ categories: b.categories, category: b.category });
    return {
        categories, category: categories.join(', ') || null, area: oneLine(b.area, 120) || null,
        seed: b.seed ? oneLine(b.seed, 200) : null, handles,
        exclude: (Array.isArray(b.exclude) ? b.exclude : []).map(x => String(x || '').replace('@', '').toLowerCase()).filter(Boolean).slice(0, 60),
        maxBusinesses: Math.round(num(b.maxBusinesses, 1, REVIEW_MAX_BUSINESSES) || 15),
        minRating: num(b.minRating, 0, 5), minReviews: num(b.minReviews, 0, 100000),
        useMaps: b.useMaps !== false, searchNames: b.searchNames !== false, useAi: b.useAi !== false,
        postsPer: Math.round(num(b.postsPer, 10, REVIEW_MAX_POSTS) || 40),
        days: Math.round(num(b.days, 7, 365) || 90)
    };
}
const reviewUsesMaps = i => !!(i.useMaps && i.categories.length && i.area);

/** Step one: find the businesses, match their Instagram, and stop — nothing is read yet. */
app.post('/api/reviews/find', spendLimit, async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        const input = reviewInput(req.body || {});
        if (!reviewUsesMaps(input) && !input.handles.length && !input.seed) return res.status(400).json({ error: 'Give a kind of business and an area, or Instagram handles.' });
        const clientId = await resolveClientId(req, ctx);
        await assertJobSlot(ctx.user.id);
        input.clientId = clientId || null;
        const maps = reviewUsesMaps(input);
        const estimate = reviewEstimate({ places: maps ? input.maxBusinesses : 0, businesses: 0, searches: maps && input.searchNames ? input.maxBusinesses : 0 });
        const job = await createJob(ctx.user.id, 'review_places', 'leadgen', input, estimate);
        runJob(job.id, JOB_WORKERS['review_places'](ctx.user.id, job.input, job.id));
        res.status(202).json({ jobId: job.id, estimatedUsd: estimate });
    } catch (err) { sendErr(res, err); }
});

/**
 * The scan. Either in one go (Maps and/or handles), or — the usual way from
 * the page — with the exact list picked after step one, passed as handles
 * with Maps switched off.
 */
app.post('/api/reviews/scan', spendLimit, async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        const input = reviewInput(req.body || {});
        if (!reviewUsesMaps(input) && !input.handles.length && !input.seed) return res.status(400).json({ error: 'Give a kind of business and an area (e.g. “restaurants”, “Gulshan, Dhaka”), or Instagram handles to scan.' });
        const clientId = await resolveClientId(req, ctx);
        if (clientId && !(await clientAccess(ctx.user.id, clientId, 'editor'))) return res.status(403).json({ error: 'You need edit access to that client.' });
        await assertJobSlot(ctx.user.id);
        input.clientId = clientId || null;
        const maps = reviewUsesMaps(input);
        const n = (maps ? input.maxBusinesses : 0) + input.handles.length + (input.seed ? 1 : 0);
        const estimate = reviewEstimate({ places: maps ? input.maxBusinesses : 0, businesses: n, postsPer: input.postsPer, searches: maps && input.searchNames ? input.maxBusinesses : 0 });
        const job = await createJob(ctx.user.id, 'review_scan', 'leadgen', input, estimate);
        runJob(job.id, JOB_WORKERS['review_scan'](ctx.user.id, job.input, job.id));
        res.status(202).json({ jobId: job.id, estimatedUsd: estimate, budget: await budgetSnapshot('leadgen', ctx.user.id, estimate) });
    } catch (err) { sendErr(res, err); }
});

// --- the scoreboard as a document ----------------------------------------------
function reviewDoc(row) {
    const j = row.report_json || {};
    const c = j.counts || {};
    if (!Array.isArray(j.board)) return null;
    const where = [j.category, j.area].filter(Boolean).join(' in ');
    const ig = h => `@${h}`;
    const link = u => (/^https:\/\/(www\.)?instagram\.com\//.test(String(u || '')) ? u : null);
    const clientRow = j.board.find(b => b.isClient) || null;
    const total = c.reviews || 0;
    const sections = [];

    sections.push({ title: 'At a glance', source: ['pub', 'ours'], blocks: [
        { type: 'kpis', items: [
            { label: 'Businesses read', value: docFmt(c.scanned), sub: c.unmatched ? `${c.unmatched} more could not be matched to Instagram` : `found on Google Maps${j.area ? ' around ' + j.area : ''}` },
            { label: 'Reviews found', value: docFmt(total), sub: `in ${docFmt(c.tagged)} tagged posts over ${j.windowDays} days`, tone: total ? 'good' : '' },
            { label: 'Creators reviewing', value: docFmt(c.creators), sub: c.paid ? `${c.paid} review${c.paid === 1 ? ' was' : 's were'} paid or hosted` : 'none marked as paid' },
            clientRow ? { label: 'Your share of reviews', value: total ? docPct(clientRow.reviews / total * 100, 0) : '—', sub: `${clientRow.reviews} of ${total}`, tone: total && clientRow.reviews / total < 1 / Math.max(2, j.board.length) ? 'watch' : 'good' } : null
        ] },
        (j.missedByClient || []).length && clientRow ? { type: 'verdict', text: `${j.missedByClient.length} creator${j.missedByClient.length === 1 ? '' : 's'} reviewed nearby ${j.category || 'businesses'} in the last ${j.windowDays} days but not @${clientRow.handle}.` } : null
    ] });

    sections.push({ title: 'Who is being reviewed', lead: 'Posts that tagged each business, read one by one.', source: ['pub'], blocks: [
        { type: 'table', highlight: j.board.findIndex(b => b.isClient),
            cols: [{ label: 'Business' }, { label: 'Tagged posts', num: true }, { label: 'Reviews', num: true }, { label: 'Paid', num: true }, { label: 'Creators', num: true }, { label: 'Last review' }].concat(j.hasPrevious ? [{ label: 'New', num: true }] : []),
            rows: j.board.map(b => [`${b.name && b.name !== ig(b.handle) ? oneLine(b.name, 40) + ' · ' : ''}${ig(b.handle)}${b.match === 'likely' ? ' *' : ''}`, b.tagged, { text: String(b.reviews), tone: b.reviews ? 'good' : '' }, b.paid, b.creators, b.lastReview ? docDay(b.lastReview) : '—'].concat(j.hasPrevious ? [b.newReviews ? { text: '+' + b.newReviews, tone: 'good' } : '0'] : [])) },
        j.board.some(b => b.match === 'likely') ? { type: 'note', text: '* Instagram account found by a search on the business name and checked against it, not linked from the listing.' } : null,
        { type: 'bars', title: 'Share of all reviews found', unit: '%', max: 100, rows: j.board.filter(b => b.reviews).slice(0, 8).map(b => ({ label: ig(b.handle), value: total ? +(b.reviews / total * 100).toFixed(1) : 0, tone: b.isClient ? 'good' : 'gold' })) }
    ] });

    const rv = (j.reviewers || []).slice(0, 15);
    if (rv.length) sections.push({ title: 'The creators who review here', lead: 'Most businesses reviewed first. Each is on the Influencers list, ready to add to a pipeline.', source: ['pub'], blocks: [
        { type: 'table', cols: [{ label: 'Creator' }, { label: 'Reviews', num: true }, { label: 'Businesses', num: true }, { label: 'Avg likes + comments', num: true }, { label: 'Last' }].concat(clientRow ? [{ label: 'Reviewed you' }] : []),
            rows: rv.map(r => [ig(r.handle) + (r.isNew ? ' (new)' : ''), r.reviews, r.venues.length, docFmt(r.avgEngagement), r.last ? docDay(r.last) : '—']
                .concat(clientRow ? [r.reviewedClient ? { chip: 'Yes', tone: 'good' } : { chip: 'Not yet', tone: 'watch' }] : [])) }
    ] });

    if ((j.top || []).length) sections.push({ title: 'Reviews that got the most attention', source: ['pub'], blocks: [
        { type: 'quotes', items: j.top.slice(0, 4).map(p => ({ tag: `${ig(p.poster)} on ${ig(p.venue)}${p.at ? ' · ' + docDay(p.at) : ''}`, text: p.caption || '(no caption)', meta: `${docFmt(p.likes)} likes · ${docFmt(p.comments)} comments`, chip: p.paid ? { text: 'Paid or hosted', tone: 'gold' } : null, link: link(p.url) })) }
    ] });

    if ((j.unmatched || []).length) sections.push({ title: 'Businesses we could not read', lead: 'No Instagram account could be confirmed. Add the right handle and scan again to include them.', source: ['ours'], blocks: [
        { type: 'table', cols: [{ label: 'Business' }, { label: 'What we found' }], rows: j.unmatched.slice(0, 20).map(u => [oneLine(u.name || '', 60) || '—', u.handle ? `Maybe @${u.handle}: check` : 'No account found']) }
    ] });

    return docFinish({
        type: 'review_scan',
        cover: { kind: `Review tracker · ${docMonth(row.created_at)}`, title: where ? where.replace(/^\w/, x => x.toUpperCase()) : 'Tagged-post reviews',
            sub: `Who reviewed the businesses${j.area ? ' around ' + j.area : ''} on Instagram in the last ${j.windowDays} days, and the creators behind the reviews.`,
            receipt: [[docFmt(c.scanned), 'businesses'], [docFmt(c.tagged), 'tagged posts'], [docFmt(total), 'reviews'], [docFmt(c.creators), 'creators']],
            builtAt: j.generatedAt || row.created_at },
        sections,
        about: [
            `Built from public Instagram posts that tagged each business in the photo, over the ${j.windowDays} days before ${docDay(j.generatedAt || row.created_at)}. Posts that only mention a business in the caption, or collab posts, do not appear in its tagged posts and are not counted.`,
            `Businesses come from Google Maps. An Instagram account is used when the listing or the business’s website links to it, or when a search on the name finds a close match.`,
            `A post counts as a review when it gives an opinion: taste, price, service, a rating or a recommendation. Clear cases are sorted by rules; ${c.byAi ? `${c.byAi} unclear post${c.byAi === 1 ? ' was' : 's were'} read by AI` : 'none needed AI'}${c.unclear ? `, and ${c.unclear} stayed unclear and are not counted` : ''}.`
        ]
    });
}
