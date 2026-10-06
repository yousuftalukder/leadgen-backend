/**
 * Leads: classification, discovery, enrichment, the vault, the master list and the pipeline.
 *
 * Part of the EdgeLead server, split out of server.js (phase 55). The parts load in
 * order from server.js and share one namespace, S: what this part needs from an earlier
 * part is unpacked below; anything else from another part is read as S.name when it runs.
 */
'use strict';
const S = require('./shared');
const {
    COST_PER_1K_PROFILE, JOB_WORKERS, LEADGEN_RESULTS_LIMIT, LEADGEN_UNIT_USD, aiReasonText, app,
    assertJobSlot, budgetSnapshot, callActor, createJob, extractBioContacts, geminiAvailable,
    geminiCallDetailed, getViews, getWorkingClient, igIsSponsored, igTaggedUsers, logger, refundLeadQuota,
    registerWorker, requireEngine, runActor, runJob, sendErr, shortcodeOf, spendLimit, supabase,
    takeLeadQuota, tsOf
} = S;
Object.assign(S, {
    leadPostSignal, leadSignalsAdd, leadSignalsMerge, classifyLead, leadFit, leadAssessment, leadsPhase40,
    igPlaceUrls, leadgenUnits, csvCell, linkLeadsToClient, leadScope, dedupeLeads, leadFilters, withFinders,
    visibleClientIds
});

// ===========================================================================
// PHASE 40 :: WHO A LEAD IS
//
// The discovery methods find POSTS and file whoever posted them. None of them
// asks what kind of account that is, so a food-influencer run also files the
// restaurants posting under #dhakafood, the venue posting from its own
// location page and every "XYZ Food" the account search returns. The methods
// stay exactly as they are; this is the step after them.
//
// Every lead is read twice:
//   1. at discovery, free: the posts we already paid for (captions, the paid
//      partnership label, where they post, who they tag, which businesses'
//      tagged tabs they turn up in);
//   2. at enrichment: the profile (Instagram's own category, the bio, the
//      website, a business address, followers against following).
// The result is influencer, business, personal (an ordinary account) or
// unsure, with the reasons that decided it. A person's correction wins over
// the rules and is kept, so the rules can be measured against it.
// ===========================================================================

const LEAD_KINDS = ['influencer', 'business', 'personal', 'unsure'];
const LEAD_KIND_EDGE = 25;              // |score| at which a kind is called
const LEAD_SIG_POSTS = 60;              // post ids remembered per lead, so a replayed post is not counted twice
const LEAD_METHOD_NAMES = { m1: 'location page', m3: 'hashtag', m3_1: 'phrase search', m4: 'a business’s tagged posts', m6: 'account search', fb: 'Facebook search', review: 'review tracker' };

// Caption wording, English and Bangla. A post counts once per list, however
// many words it hits, so one long caption cannot outvote ten short ones.
const LK_CREATOR_WORDS = /\b(tried|trying|must[- ]?try|review(ed|ing|s)?|honest (review|opinion|thoughts)|verdict|worth (it|the hype|every)|(would|highly|definitely) recommend|tast(e|ed|es|y|ing)|flavou?rs?|portion|my (favou?rite|go-?to|order|pick)|i (ordered|had|went|visited|tried|loved|got)|checked (it )?out|hidden gem|food ?blog(ger)?|foodie|vlog|collab|invited|gifted|thanks? (for|to) .{0,24}(having|hosting|inviting)|#ad\b|#pr\b|#?foodreview|#?foodblogger)\b/i;
const LK_CREATOR_WORDS_BN = /(রিভিউ|খেয়ে দেখ|খেলাম|খেয়েছি|ট্রাই কর|টেস্ট কর|স্বাদ|রেটিং|অবশ্যই (ট্রাই|খেয়ে)|ঘুরে এলাম|গিয়েছিলাম|দাওয়াত|কোলাব|ভ্লগ|ফুডি)/;
const LK_BUSINESS_WORDS = /\b(order (now|today|yours|online)|to order|for (order|orders|booking)|place (your|an) order|pre-?order|home delivery|free delivery|delivery (available|charge|all over)|cash on delivery|dm (us|to order|for (order|price|details))|inbox (us|for)|call (us|now|for)|hotline|whats ?app (us|for|to)|visit (us|our)|our (new|menu|shop|store|outlet|branch|kitchen|restaurant|cafe|customers?|products?|collection|team|chef)|we('re| are) (open|hiring|now|serving)|now open|open (daily|everyday|from|now)|opening hours|book (now|your|a table)|reserve (now|your)|reservations?|branch(es)?|outlets?|limited (stock|offer)|in stock|new arrivals?|shop now|buy now|grab yours|flat \d+ ?%|\d+ ?% off)\b/i;
S.LK_BUSINESS_WORDS = LK_BUSINESS_WORDS;
const LK_BUSINESS_WORDS_BN = /(অর্ডার কর|অর্ডার করতে|হোম ডেলিভারি|ডেলিভারি চার্জ|ক্যাশ অন ডেলিভারি|ইনবক্স কর|ইনবক্সে|যোগাযোগ কর|আমাদের (নতুন|মেনু|শাখা|আউটলেট|রেস্টুরেন্ট|দোকান)|শাখা|আউটলেট|বুকিং|কল করুন|হটলাইন)/;
S.LK_BUSINESS_WORDS_BN = LK_BUSINESS_WORDS_BN;
const LK_RATING = /(\b\d{1,2}(\.\d)?\s*\/\s*10\b|\b[1-5](\.\d)?\s*\/\s*5\b|(⭐|★){3,}|rating\s*[:\-]?\s*\d|রেটিং\s*[:\-]?\s*[\d০-৯])/i;
S.LK_RATING = LK_RATING;

// The profile.
const LK_CREATOR_CATEGORY = /\b(digital creator|creator|blogger|personal blog|public figure|video creator|influencer|gamer|gaming video creator|vlogger|writer|artist|musician|comedian|athlete|actor|actress|model|journalist|news personality|youtuber)\b/i;
const LK_BUSINESS_CATEGORY = /\b(restaurant|caf[eé]|coffee|bakery|food (and|&) beverage|food & drink|fast food|pizza|burger|dessert|sweet shop|caterer|catering|grocery|supermarket|shopping|retail|store|shop|boutique|clothing|brand|product\/service|local business|company|business|hotel|resort|salon|spa|beauty|cosmetic|clinic|hospital|dentist|pharmacy|real estate|property|school|college|university|agency|consult\w*|jewel\w*|furniture|electronics|gym|fitness cent\w*|travel (company|agency)|event plann\w*|e-?commerce|commercial|organi[sz]ation|non-?profit|bank|insurance|automotive|car dealer\w*|interior)\b/i;
const LK_CREATOR_BIO = /(collab|collaboration|\bpr\b|for (business|collab|pr|work|brand)|business (inquir|enquir|email|mail)|management|content creator|creator|blogger|vlogger|influencer|\breviews?\b|foodie|📩|✉️|ambassador|youtube|tiktok)/i;
const LK_BUSINESS_BIO = /(\border\b|delivery|open (daily|everyday|\d)|opening hours|hotline|call (us|now)|branch|outlet|visit us|our (shop|store|restaurant|cafe|menu|products)|we (are|deliver|make|serve|offer)|shop now|online shop|pre-?order|wholesale|since (19|20)\d\d|est\.?\s*(19|20)\d\d|\bltd\b|limited|pvt|অর্ডার|ডেলিভারি|শাখা|আউটলেট|হটলাইন)/i;
const LK_SHOP_SITE = /(foodpanda|pathao|ubereats|doordash|grubhub|deliveroo|swiggy|zomato|daraz|myshopify|shopify|woocommerce|square\.site|toasttab|opentable|resy|\/menu|\/order|\/shop|\/store)/i;
const LK_CREATOR_SITE = /(youtube\.com|youtu\.be|tiktok\.com|linktr\.ee|beacons\.ai|bio\.link|linkin\.bio|taplink|campsite\.bio|snipfeed|stan\.store)/i;
const LK_BUSINESS_HANDLE = /(caf[eé]|kitchen|restaurant|resto|bistro|grill|bakery|bakers|bakehouse|catering|sweets|official|ltd|limited|outlet|store|shop|mart|boutique|salon|clinic|lounge|diner|eatery|pizzeria|biryani)/i;
S.LK_BUSINESS_HANDLE = LK_BUSINESS_HANDLE;
const LK_CREATOR_HANDLE = /(foodie|eats|diar(y|ies)|tales|vlogs?|blogger|blogs|explorer|hunter|lover|journal|travell?er|wanderer|reviews?|withme|with_|by_)/i;

/** Where a tagged-tab post came from: the business whose /tagged/ page it was read off. */
function leadTaggedSource(i) {
    const m = /instagram\.com\/([^/?#]+)\/tagged/i.exec(String(i.inputUrl || i.input_url || i.url_input || ''));
    return m ? m[1].toLowerCase() : null;
}

/**
 * What one post says about whoever posted it. Kept small: this rides in the
 * job's checkpoint and in the lead's signals.
 */
function leadPostSignal(i, method, venue = null) {
    const caption = String(i.caption || i.text || '');
    const handle = String(i.ownerUsername || i.owner?.username || i.username || '').toLowerCase();
    const loc = i.locationId || i.location?.id || (i.locationName ? String(i.locationName).toLowerCase().slice(0, 60) : null);
    const tagged = [...igTaggedUsers(i), ...(Array.isArray(i.mentions) ? i.mentions.map(m => String(m).toLowerCase().replace('@', '')) : [])]
        .filter(h => h && h !== handle);
    return {
        id: String(i.shortCode || i.shortcode || i.id || '') || null,
        m: method,
        venue,
        cw: LK_CREATOR_WORDS.test(caption) || LK_CREATOR_WORDS_BN.test(caption) ? 1 : 0,
        bw: LK_BUSINESS_WORDS.test(caption) || LK_BUSINESS_WORDS_BN.test(caption) ? 1 : 0,
        rt: LK_RATING.test(caption) ? 1 : 0,
        sp: igIsSponsored(i) ? 1 : 0,
        rl: /reel|clips|video/i.test(String(i.productType || i.type || '')) ? 1 : 0,
        loc: loc ? String(loc) : null,
        tg: [...new Set(tagged)].slice(0, 12),
        lk: Number(i.likesCount) || 0,
        cm: Number(i.commentsCount) || 0,
        vw: getViews(i) || 0,
        at: tsOf(i)?.toISOString() || null,
        fn: i.ownerFullName || i.owner?.fullName || null,
        cap: caption.replace(/\s+/g, ' ').trim().slice(0, 200) || null
    };
}

function leadSignalsEmpty() {
    return { v: 1, posts: 0, likes: 0, comments: 0, views: 0, cw: 0, bw: 0, rt: 0, sp: 0, reels: 0,
        locs: {}, tagged: [], venues: [], seen: [], captions: [], lastPostAt: null, fullName: null };
}

/**
 * Fold posts into a lead's signals. A post already counted (same id) is
 * skipped, so a resumed run or a second campaign over the same hashtag does
 * not double a creator's evidence.
 */
function leadSignalsAdd(sig, posts) {
    const s = { ...leadSignalsEmpty(), ...(sig || {}) };
    s.locs = { ...(s.locs || {}) };
    const seen = new Set(s.seen || []);
    const tagged = new Set(s.tagged || []), venues = new Set(s.venues || []);
    const captions = [...(s.captions || [])];
    for (const p of posts || []) {
        if (!p) continue;
        if (p.venue) venues.add(p.venue);
        if (p.fn && !s.fullName) s.fullName = String(p.fn).slice(0, 120);
        if (p.id && seen.has(p.id)) continue;
        if (p.id) seen.add(p.id);
        if (p.m === 'm6') continue;                     // an account-search hit is not a post
        s.posts += 1;
        s.likes += p.lk || 0; s.comments += p.cm || 0; s.views += p.vw || 0;
        s.cw += p.cw || 0; s.bw += p.bw || 0; s.rt += p.rt || 0; s.sp += p.sp || 0; s.reels += p.rl || 0;
        if (p.loc) s.locs[p.loc] = (s.locs[p.loc] || 0) + 1;
        (p.tg || []).forEach(t => tagged.add(t));
        if (p.at && (!s.lastPostAt || p.at > s.lastPostAt)) s.lastPostAt = p.at;
        if (p.cap) { captions.unshift(p.cap); }
    }
    // Caps keep a lead's row small however many runs find it.
    const locKeys = Object.keys(s.locs).sort((a, b) => s.locs[b] - s.locs[a]).slice(0, 20);
    s.locs = Object.fromEntries(locKeys.map(k => [k, s.locs[k]]));
    s.tagged = [...tagged].slice(0, 40);
    s.venues = [...venues].slice(0, 25);
    s.seen = [...seen].slice(-LEAD_SIG_POSTS);
    s.captions = [...new Set(captions)].slice(0, 3);
    return s;
}

/** Merge two leads' stored signals (the same business found by two runs). */
function leadSignalsMerge(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    const out = leadSignalsAdd(a, []);
    const seen = new Set(out.seen);
    const fresh = (b.seen || []).filter(id => !seen.has(id)).length;
    // Counts from b are only added in proportion to posts a has not seen;
    // without per-post detail this is the honest approximation.
    const share = b.posts ? Math.min(1, fresh / Math.max(1, Math.min(b.posts, (b.seen || []).length || b.posts))) : 0;
    for (const k of ['posts', 'likes', 'comments', 'views', 'cw', 'bw', 'rt', 'sp', 'reels']) out[k] += Math.round((b[k] || 0) * share);
    for (const [k, v] of Object.entries(b.locs || {})) out.locs[k] = (out.locs[k] || 0) + Math.round(v * share);
    out.tagged = [...new Set([...out.tagged, ...(b.tagged || [])])].slice(0, 40);
    out.venues = [...new Set([...out.venues, ...(b.venues || [])])].slice(0, 25);
    out.seen = [...new Set([...out.seen, ...(b.seen || [])])].slice(-LEAD_SIG_POSTS);
    out.captions = [...new Set([...(b.captions || []), ...out.captions])].slice(0, 3);
    if (b.lastPostAt && (!out.lastPostAt || b.lastPostAt > out.lastPostAt)) out.lastPostAt = b.lastPostAt;
    out.fullName = out.fullName || b.fullName || null;
    return out;
}

const leadFollowerTier = f => (f == null ? null : f < 1000 ? 'starter' : f < 10000 ? 'nano' : f < 100000 ? 'micro' : f < 1000000 ? 'macro' : 'mega');
const LEAD_TIER_NAME = { starter: 'under 1K', nano: 'nano (1K–10K)', micro: 'micro (10K–100K)', macro: 'macro (100K–1M)', mega: 'mega (1M+)' };
// What a normal engagement rate looks like at each size: the bar a creator is read against.
const LEAD_TIER_ER = { starter: 5, nano: 4, micro: 2.5, macro: 1.5, mega: 1 };

/** Average likes + comments per post seen, as a share of followers. Null when either is unknown. */
function leadEngagement(row, sig) {
    const f = Number(row.followers_count) || 0;
    if (!sig || !sig.posts || !f) return null;
    return +(((sig.likes + sig.comments) / sig.posts) / f * 100).toFixed(2);
}

/**
 * Influencer, business, personal or unsure — with the reasons.
 * Positive points say creator, negative say business. Pure: rows and signals in, a verdict out.
 */
function classifyLead(row = {}, sig = null) {
    const s = sig || leadSignalsEmpty();
    const R = [];
    const add = (w, text) => { if (w) R.push({ w, text }); };
    const handle = String(row.username || '').toLowerCase();
    const enriched = !!row.is_enriched;

    // --- what the posts say (free, from discovery) -------------------------
    if (s.sp > 0) add(30, `Posted ${s.sp === 1 ? 'a paid partnership' : `${s.sp} paid partnerships`}`);
    const venues = (s.venues || []).length;
    // Being in several businesses' tagged posts is a creator's pattern, but
    // a regular who eats out tags places too, so on its own it is not enough.
    if (venues >= 3) add(25, `Tagged ${venues} different businesses`);
    else if (venues === 2) add(18, 'Tagged 2 different businesses');
    else if (venues === 1) add(4, `Tagged @${s.venues[0]}`);
    const locs = Object.values(s.locs || {});
    const places = locs.length;
    if (places >= 3) add(18, `Posts from ${places} different places`);
    else if (s.posts >= 3 && places === 1 && locs[0] / s.posts >= 0.8) add(-22, 'Every post is at the same place (likely the venue itself)');
    if ((s.tagged || []).length >= 4) add(10, `Tags ${s.tagged.length} other accounts`);
    if (s.posts) {
        const cw = s.cw / s.posts, bw = s.bw / s.posts;
        if (cw >= 0.2) add(Math.round(28 * Math.min(1, cw * 1.5)), `Review-style captions (${Math.round(cw * 100)}% of posts)`);
        if (bw >= 0.2) add(-Math.round(30 * Math.min(1, bw * 1.5)), `Selling captions: order, delivery, “our menu” (${Math.round(bw * 100)}% of posts)`);
        if (s.rt > 0) add(10, 'Gives ratings (8/10, ⭐)');
    }
    if (LK_BUSINESS_HANDLE.test(handle)) add(-14, 'The handle reads like a business');
    else if (LK_CREATOR_HANDLE.test(handle)) add(12, 'The handle reads like a creator');

    // --- what the profile says (after enrichment) --------------------------
    const cat = String(row.category || '');
    if (cat && LK_CREATOR_CATEGORY.test(cat)) add(40, `Instagram category: ${cat}`);
    else if (cat && LK_BUSINESS_CATEGORY.test(cat)) add(-45, `Instagram category: ${cat}`);
    const bio = String(row.bio || '');
    if (bio) {
        if (LK_CREATOR_BIO.test(bio)) add(18, 'Bio talks about collabs or reviews');
        if (LK_BUSINESS_BIO.test(bio)) add(-20, 'Bio sells: orders, delivery, branches');
    }
    const site = String(row.website || '');
    if (site && LK_SHOP_SITE.test(site)) add(-15, 'Links to a menu, shop or delivery page');
    else if (site && LK_CREATOR_SITE.test(site)) add(8, 'Links to a creator page (YouTube, TikTok, link-in-bio)');
    if (row.address) add(-25, 'Has a business address');
    const name = String(row.full_name || s.fullName || '');
    if (name && LK_BUSINESS_HANDLE.test(name)) add(-10, 'The name reads like a business');
    else if (/^[A-Z][a-z]+(\s[A-Z][a-z]+){1,2}$/.test(name.trim())) add(6, 'The name reads like a person');

    const score = Math.max(-100, Math.min(100, R.reduce((a, r) => a + r.w, 0)));
    const followers = row.followers_count == null ? null : Number(row.followers_count);
    let kind = score >= LEAD_KIND_EDGE ? 'influencer' : score <= -LEAD_KIND_EDGE ? 'business' : 'unsure';
    // An ordinary account: checked, small, and nothing says creator or shop.
    if (kind === 'unsure' && enriched && followers != null && followers < 1000) {
        kind = 'personal';
        R.push({ w: 0, text: 'Under 1,000 followers and nothing marks it as a creator or a business' });
    }
    if (!R.length) R.push({ w: 0, text: enriched ? 'Nothing on the profile says either way' : 'Not enough to go on yet: fill in its details' });
    const reasons = R.slice().sort((a, b) => Math.abs(b.w) - Math.abs(a.w)).slice(0, 5);
    return { kind, score, stage: enriched ? 'profile' : 'discovery', reasons };
}

/**
 * How good a lead of its kind is, 0–100, with the reasons. Influencers are
 * read on reach that is real (engagement for their size), evidence (how many
 * methods found them, how many businesses they have tagged) and whether they
 * can be reached. Businesses on whether they can be reached, are active, and
 * would plausibly need an agency.
 */
function leadFit(row = {}, sig = null, kind = 'unsure', methods = []) {
    const s = sig || leadSignalsEmpty();
    const R = [];
    const add = (w, text) => R.push({ w, text });
    const f = row.followers_count == null ? null : Number(row.followers_count);
    const tier = leadFollowerTier(f);
    const er = leadEngagement(row, s);
    const reach = !!(row.email || row.phone || row.whatsapp);
    const nMethods = new Set(methods || []).size;
    const days = s.lastPostAt ? (Date.now() - new Date(s.lastPostAt).getTime()) / 86400000 : null;
    let score = 0;

    if (kind === 'influencer') {
        if (tier) {
            const t = { starter: 0, nano: 20, micro: 22, macro: 15, mega: 8 }[tier];
            score += t; if (t) add(t, `${LEAD_TIER_NAME[tier]} followers`); else add(0, 'Under 1,000 followers');
        }
        if (er != null && tier) {
            const ratio = er / LEAD_TIER_ER[tier];
            if (ratio >= 1) { score += 25; add(25, `Engagement ${er}%, strong for their size`); }
            else if (ratio >= 0.5) { score += 12; add(12, `Engagement ${er}%, normal for their size`); }
            else if (ratio < 0.3 && f >= 10000) { score -= 10; add(-10, `Engagement ${er}% is low for ${f.toLocaleString('en-US')} followers: check for bought followers`); }
        }
        if (nMethods >= 3) { score += 15; add(15, `Found by ${nMethods} methods`); }
        else if (nMethods === 2) { score += 8; add(8, 'Found by 2 methods'); }
        if ((s.venues || []).length >= 2) { score += 10; add(10, `Has tagged ${s.venues.length} businesses`); }
        if (s.sp > 0) { score += 5; add(5, 'Already does brand work'); }
    } else if (kind === 'business') {
        if (f != null && f >= 300 && f <= 50000) { score += 15; add(15, `${f.toLocaleString('en-US')} followers: a size that hires help`); }
        else if (f != null && f > 200000) { score -= 10; add(-10, 'A large brand, less likely to need an agency'); }
        if (er != null && tier && tier !== 'starter' && er / LEAD_TIER_ER[tier] < 0.5) { score += 12; add(12, `Engagement ${er}% is weak: room to help`); }
        if (row.is_enriched && !row.website) { score += 8; add(8, 'No website'); }
        if (nMethods >= 2) { score += 10; add(10, `Found by ${nMethods} methods`); }
    }
    if (kind === 'influencer' || kind === 'business') {
        const w = kind === 'business' ? 25 : 10;
        if (reach) { score += w; add(w, 'Has a contact'); } else if (row.is_enriched) add(0, 'No contact found');
        if (days != null && days <= 30) { score += (kind === 'business' ? 15 : 10); add(kind === 'business' ? 15 : 10, 'Posted in the last 30 days'); }
        else if (days != null && days > 90) { score -= 10; add(-10, 'No post seen in 3 months'); }
    }
    if (!row.is_enriched && (kind === 'influencer' || kind === 'business')) add(0, 'Fill in its details for a full score');
    return { score: Math.max(0, Math.min(100, Math.round(score))), tier, engagement: er, reasons: R.filter(r => r.text).slice(0, 6) };
}

/** The columns a lead carries after being read. */
function leadAssessment(row, sig, methods) {
    const c = classifyLead(row, sig);
    const kind = row.kind_label || c.kind;
    const fit = leadFit(row, sig, kind, methods);
    return {
        lead_kind: c.kind, kind_score: c.score, kind_stage: c.stage, kind_reasons: c.reasons,
        fit_score: fit.score, fit_reasons: fit.reasons, classified_at: new Date().toISOString()
    };
}

// The phase-40 columns exist only once sql/schema-phase40.sql has run. Until
// then a lead is saved exactly as before, so a server deployed ahead of its
// SQL keeps finding leads instead of failing every insert.
const _lead40 = { ok: null, t: 0 };
async function leadsPhase40() {
    if (_lead40.ok === true) return true;
    if (_lead40.ok === false && Date.now() - _lead40.t < 300000) return false;
    try {
        const { error } = await supabase.from('leads').select('lead_kind').limit(1);
        _lead40.ok = !error;
    } catch { _lead40.ok = false; }
    _lead40.t = Date.now();
    return _lead40.ok;
}

// ===========================================================================
// STAGE 1 :: DISCOVERY PIPELINE  (checkpointed job)
//
// This ran Apify inside the HTTP request until phase 6. A long run hit the
// proxy timeout while the actor kept billing, and the user got a network error
// with no job, no checkpoint and no cancel. Worse, none of its actor calls
// carried a cost estimate, so callActor() skipped the budget gate, took no
// reservation and could never raise NO_CREDIT — the leadgen engine was the
// only engine that could overspend a key silently.
//
// Each Apify call is now one billable unit, checkpointed with the rows it
// returned. A resumed run replays those rows instead of paying to scrape them
// again — the contract every other engine already had.
// ===========================================================================

/** Map place-search rows to explore/locations URLs. Every id/url key the
 *  search actor has been seen to emit is accepted; nothing is invented. */
function igPlaceUrls(items) {
    const out = [];
    (items || []).forEach(it => {
        if (!it) return;
        const cands = [it, it.location, it.place].filter(Boolean);
        for (const c of cands) {
            const url = String(c.url || c.locationUrl || c.link || '');
            if (/instagram\.com\/explore\/locations\//i.test(url)) { out.push(url.split('?')[0]); return; }
            const id = c.locationId || c.id || c.pk || c.location_id;
            if (id && /^\d{3,}$/.test(String(id))) { out.push(`https://www.instagram.com/explore/locations/${id}/`); return; }
        }
    });
    return [...new Set(out)];
}

function leadgenUnits(input) {
    const {
        location = '', hashtags = [], method3_1_keywords = [],
        competitor_handles = [], method6_keywords = [], selected_methods = []
    } = input || {};

    const units = [];
    if (selected_methods.includes('method_1')   && location)                 units.push({ id: 'm1', kind: 'locations' });
    if (selected_methods.includes('method_3')   && hashtags.length)          units.push({ id: 'm3', kind: 'hashtags' });
    if (selected_methods.includes('method_3_1'))
        method3_1_keywords.forEach(kw => units.push({ id: 'm3_1:' + kw, kind: 'phrase', kw }));
    if (selected_methods.includes('method_4')   && competitor_handles.length) units.push({ id: 'm4', kind: 'tagged' });
    if (selected_methods.includes('method_6'))
        method6_keywords.forEach(kw => units.push({ id: 'm6:' + kw, kind: 'accounts', kw }));
    return units;
}

registerWorker('leadgen_campaign', (userId, input, jobId) => async (progress, ck) => {
    const {
        campaignId, location = '', method1_keywords = [], hashtags = [],
        competitor_handles = [], method6_keywords = []
    } = input;

    const warnings = [];
    const units = leadgenUnits(input);
    if (!units.length) {
        throw new Error('No discovery method selected, or the selected methods have no inputs.');
    }

    // Where a lead is filed. (phase 29) The industry is the campaign's first
    // keyword or hashtag unless the method that found the lead has its own;
    // the location is the place searched — never a pasted explore URL.
    const campaignIndustry = [...method1_keywords, ...(input.method3_1_keywords || []), ...method6_keywords, ...hashtags]
        .map(k => String(k || '').replace(/^#/, '').trim()).filter(Boolean)[0] || null;
    const filedLocation = String(location || '').split(',').map(x => x.trim())
        .filter(x => x && !/instagram\.com/i.test(x))[0] || null;

    // Shape one raw Apify item into the row the save phase writes. (phase 40)
    // Each row also carries what its post says about who posted it — read
    // from data already paid for, so sorting influencers from businesses
    // costs nothing extra.
    const onlyVenue = competitor_handles.length === 1 ? String(competitor_handles[0]).replace('@', '').trim().toLowerCase() : null;
    const shape = (i, method) => {
        const handle = i.ownerUsername || i.owner?.username || i.username || i.user?.username;
        if (!handle) return null;
        return {
            username: String(handle).toLowerCase().trim().replace('@', ''),
            post_views: getViews(i),
            post_likes: i.likesCount || 0,
            post_comments: i.commentsCount || 0,
            post_timestamp: tsOf(i)?.toISOString() || new Date().toISOString(),
            post_url: i.url || `https://instagram.com/p/${shortcodeOf(i)}`,
            sig: method ? leadPostSignal(i, method, method === 'm4' ? (leadTaggedSource(i) || onlyVenue) : null) : undefined
        };
    };

    const collect = (items, filterKeywords, method) => {
        const lower = (filterKeywords || []).map(k => String(k).toLowerCase().trim()).filter(Boolean);
        const out = [];
        (items || []).forEach(i => {
            const caption = String(i.caption || i.text || '').toLowerCase();
            if (lower.length && !lower.some(kw => caption.includes(kw))) return;
            const row = shape(i, method);
            if (row) out.push(row);
        });
        return out;
    };

    const discovered = [];

    for (let i = 0; i < units.length; i++) {
        const u = units[i];
        const pct = 5 + Math.floor(65 * i / units.length);

        // Already paid for on an earlier attempt. Replay, do not re-scrape.
        if (ck.isDone(u.id)) {
            discovered.push(...(ck.get(u.id) || []));
            await progress(pct, `Reusing ${u.id} from the earlier attempt — not re-scraped`);
            continue;
        }

        await progress(pct, `${u.id} (${i + 1} of ${units.length})`);

        // Budget gate per unit. A key that cannot cover ONE unit raises
        // NO_CREDIT, which runJob turns into paused_no_credit with the
        // checkpoint intact — rather than the old behaviour of scraping anyway.
        const { client } = await getWorkingClient('leadgen', userId, {
            needUsd: LEADGEN_UNIT_USD, jobId
        });

        let rows = [];
        try {
            if (u.kind === 'locations') {
                // PHASE 11 — a pasted explore URL still works; a plain place name
                // ("Rangpur", "Gulshan Dhaka") is resolved through the search
                // scraper's place search first. Field names on the search
                // output are read defensively: the actor is verified for
                // searchType 'user' (Method 6) but its place rows have not been
                // checked against live output, so every plausible id/url key
                // is accepted and a miss is reported, not guessed.
                const terms = String(location).split(',').map(c => c.trim()).filter(Boolean);
                const directUrls = terms.filter(loc => loc.includes('instagram.com/explore/locations'));
                const names = terms.filter(loc => !/instagram\.com/i.test(loc));
                if (names.length) {
                    const { items: places } = await callActor(client, 'apify/instagram-search-scraper',
                        { searchQueries: names.slice(0, 3), searchType: 'place' },
                        { estimateUsd: COST_PER_1K_PROFILE / 20, maxItems: 30, jobId });
                    const found = igPlaceUrls(places);
                    if (found.length) {
                        directUrls.push(...found.slice(0, 3 * names.length));
                        warnings.push(`Method 1: "${names.join('", "')}" resolved to ${found.length} location page(s).`);
                    } else {
                        warnings.push(`Method 1: no Instagram location matched "${names.join('", "')}" — paste an explore/locations URL instead.`);
                    }
                }
                if (!directUrls.length) {
                    warnings.push('METHOD 1 SKIPPED: no location could be resolved.');
                } else {
                    const items = await runActor('apify/instagram-scraper',
                        { directUrls: [...new Set(directUrls)], resultsLimit: LEADGEN_RESULTS_LIMIT, scrollWaitSecs: 5, pageTimeoutSecs: 60 },
                        warnings, 'Method 1 (Locations)', client, { jobId });
                    rows = collect(items, method1_keywords, 'm1');
                }

            } else if (u.kind === 'hashtags') {
                const directUrls = hashtags.map(h => String(h).replace('#', '').trim()).filter(Boolean)
                    .map(tag => `https://www.instagram.com/explore/tags/${tag}/`);
                const items = await runActor('apify/instagram-scraper',
                    { directUrls, resultsLimit: LEADGEN_RESULTS_LIMIT, scrollWaitSecs: 5, pageTimeoutSecs: 60 },
                    warnings, 'Method 3 (Hashtags)', client, { jobId });
                rows = collect(items, null, 'm3');

            } else if (u.kind === 'phrase') {
                const items = await runActor('apify/instagram-api-scraper',
                    { query: u.kw, limit: LEADGEN_RESULTS_LIMIT },
                    warnings, `Method 3.1 (${u.kw})`, client, { jobId });
                rows = collect(items, null, 'm3_1');

            } else if (u.kind === 'tagged') {
                const taggedUrls = competitor_handles.map(h => String(h).replace('@', '').trim()).filter(Boolean)
                    .map(handle => `https://www.instagram.com/${handle}/tagged/`);
                const items = await runActor('apify/instagram-scraper',
                    { directUrls: taggedUrls, resultsLimit: LEADGEN_RESULTS_LIMIT, scrollWaitSecs: 5, pageTimeoutSecs: 60 },
                    warnings, 'Method 4 (Competitor Tagged)', client, { jobId });
                rows = collect(items, null, 'm4');

            } else if (u.kind === 'accounts') {
                const { items } = await callActor(client, 'apify/instagram-search-scraper',
                    { searchQueries: [u.kw], searchType: 'user' },
                    { estimateUsd: COST_PER_1K_PROFILE / 20, maxItems: 50, jobId });
                rows = (items || []).map(it => {
                    const handle = it.username || it.ownerUsername;
                    if (!handle) return null;
                    return {
                        username: String(handle).toLowerCase().trim().replace('@', ''),
                        post_views: 0, post_likes: 0, post_comments: 0,
                        post_timestamp: new Date().toISOString(),
                        post_url: `https://instagram.com/${handle}`,
                        sig: { id: null, m: 'm6', fn: it.fullName || it.full_name || null }
                    };
                }).filter(Boolean);
                warnings.push(`X-RAY (Method 6): ${rows.length} accounts for "${u.kw}".`);
            }
        } catch (e) {
            // NO_CREDIT and CANCELLED must reach runJob to park the job with
            // its checkpoint. Anything else is one method failing, which is not
            // a reason to throw away the four that worked.
            if (e.code === 'NO_CREDIT' || e.code === 'CANCELLED') throw e;
            warnings.push(`Error (${u.id}): ${e.message}`);
            logger.warn('leadgen_unit_failed', { jobId, unit: u.id, message: e.message });
        }

        // Tagged before the checkpoint, so a resumed run files them the same way.
        rows.forEach(r => { r.industry = u.kw || campaignIndustry; });
        discovered.push(...rows);
        await ck.done(u.id, rows);
    }

    // --- save -------------------------------------------------------------
    // Batched. The old loop ran a SELECT and an INSERT per handle — roughly
    // 2000 sequential round trips on a 1000-lead campaign, which was a large
    // part of why this endpoint timed out before Apify was even the problem.
    await progress(75, 'Saving leads');

    // Every post each account turned up in, and which methods found it —
    // before the list is cut to one row per account. (phase 40)
    const evidence = new Map();
    discovered.forEach(p => {
        const key = String(p?.username || '').trim().toLowerCase();
        if (!key) return;
        const e = evidence.get(key) || { posts: [], methods: new Set() };
        if (p.sig) { e.posts.push(p.sig); if (p.sig.m) e.methods.add(p.sig.m); }
        evidence.set(key, e);
    });
    const p40 = await leadsPhase40();

    const uniqueMap = new Map();
    discovered.forEach(p => {
        if (!p?.username) return;
        // Normalised here, at the one place every discovered handle passes
        // through. Instagram treats handles case-insensitively but the actors
        // do not always agree on case, and since phase 16 the handle is part
        // of a unique key — so "HarborCafe" and "harborcafe" arriving from two
        // methods must not become two leads.
        const key = String(p.username).trim().toLowerCase();
        if (!key) return;
        p.username = key;
        const cur = uniqueMap.get(key);
        if (!cur || (p.post_views || 0) > (cur.post_views || 0)) uniqueMap.set(key, p);
    });
    const posts = Array.from(uniqueMap.values());

    if (!posts.length) {
        await supabase.from('campaigns')
            .update({ total_leads_found: 0 }).eq('id', campaignId).eq('user_id', userId);
        return { campaignId, newUniqueLeads: 0, totalLinked: 0, methodsRun: units.length, warnings };
    }

    const idByUsername = new Map();
    const CHUNK = 200;

    for (let i = 0; i < posts.length; i += CHUNK) {
        const names = posts.slice(i, i + CHUNK).map(p => p.username);
        const { data: existing } = await supabase.from('leads')
            .select('id, username')
            .eq('owner_user_id', userId).eq('platform', 'instagram')
            .in('username', names);
        (existing || []).forEach(l => idByUsername.set(l.username, l.id));
    }

    const existedBefore = new Set(idByUsername.keys());
    let missing = posts.filter(p => !idByUsername.has(p.username));

    // The allowance is taken here, before the writes, so two campaigns running
    // together cannot both see room and both use it. Anything not saved is
    // still linked below if the lead already existed — only new rows count.
    const allowedNew = await takeLeadQuota(userId, missing.length);
    if (allowedNew < missing.length) {
        warnings.push(allowedNew === 0
            ? `Lead allowance reached. ${missing.length} new lead(s) were found but not saved.`
            : `Lead allowance reached. Saved ${allowedNew} of ${missing.length} new lead(s) found.`);
        missing = missing.slice(0, allowedNew);
    }

    for (let i = 0; i < missing.length; i += CHUNK) {
        const batch = missing.slice(i, i + CHUNK).map(p => {
            const row = {
                owner_user_id: userId,
                platform: 'instagram',          // explicit: it is part of the conflict key
                username: p.username,
                profile_url: `https://instagram.com/${p.username}`,
                industry: p.industry || null,
                location: filedLocation,
                is_enriched: false
            };
            if (p40) {
                const e = evidence.get(p.username) || { posts: [], methods: new Set() };
                const sig = leadSignalsAdd(null, e.posts);
                row.signals = sig;
                row.methods = [...e.methods];
                if (sig.fullName) row.full_name = sig.fullName;
                Object.assign(row, leadAssessment(row, sig, row.methods));
            }
            return row;
        });
        // Upsert since phase 16, which added the unique key this conflicts on.
        // The select-then-insert above races: two campaigns both read before
        // either writes, and before that key existed both rows landed.
        const { data: created, error: insErr } = await supabase.from('leads')
            .upsert(batch, { onConflict: 'owner_user_id,platform,username', ignoreDuplicates: false })
            .select('id, username');
        if (insErr) {
            warnings.push(`DB: ${batch.length} lead(s) in one batch failed to save — ${insErr.message}`);
            logger.error('leadgen_lead_insert_failed', { jobId, message: insErr.message });
            // The allowance was taken for these rows before the write. They did
            // not land, so it goes back.
            await refundLeadQuota(userId, batch.length);
            continue;
        }
        (created || []).forEach(l => idByUsername.set(l.username, l.id));
        await progress(
            75 + Math.floor(15 * Math.min(i + CHUNK, missing.length) / Math.max(1, missing.length)),
            `Saved ${Math.min(i + CHUNK, missing.length)} of ${missing.length} new leads`);
    }

    const links = posts
        .filter(p => idByUsername.has(p.username))
        .map(p => ({
            campaign_id: campaignId,
            lead_id: idByUsername.get(p.username),
            user_id: userId,
            top_post_url: p.post_url,
            top_post_views: p.post_views || 0,
            post_likes: p.post_likes || 0,
            post_comments: p.post_comments || 0,
            post_timestamp: new Date(p.post_timestamp).toISOString()
        }));

    let linked = 0;
    for (let i = 0; i < links.length; i += CHUNK) {
        const slice = links.slice(i, i + CHUNK);
        // Upsert, not insert. A resumed run replays this whole phase, and
        // without the phase 6 unique index that duplicated every lead in the
        // Vault and inflated total_leads_found.
        const { error: linkErr } = await supabase.from('campaign_leads')
            .upsert(slice, { onConflict: 'campaign_id,lead_id', ignoreDuplicates: false });
        if (linkErr) {
            warnings.push(`DB: a batch of campaign links failed — ${linkErr.message}`);
            logger.error('leadgen_link_failed', { jobId, message: linkErr.message });
        } else {
            linked += slice.length;
        }
    }

    await progress(95, `Linked ${linked} lead(s) to the campaign`);

    // Leads this person already had: add this run's evidence and read them
    // again. A creator found once by a hashtag and now in two businesses'
    // tagged posts should move up, not stay where the first run left them.
    if (p40) {
        const again = posts.filter(p => existedBefore.has(p.username)).map(p => idByUsername.get(p.username)).filter(Boolean);
        for (let i = 0; i < again.length; i += CHUNK) {
            const { data: rowsNow } = await supabase.from('leads').select('*').in('id', again.slice(i, i + CHUNK));
            for (let j = 0; j < (rowsNow || []).length; j += 10) {
                await Promise.all(rowsNow.slice(j, j + 10).map(async r => {
                    const e = evidence.get(String(r.username).toLowerCase());
                    if (!e) return;
                    const sig = leadSignalsAdd(r.signals, e.posts);
                    const methods = [...new Set([...(r.methods || []), ...e.methods])];
                    const patch = { signals: sig, methods, ...leadAssessment({ ...r, full_name: r.full_name || sig.fullName }, sig, methods) };
                    if (!r.full_name && sig.fullName) patch.full_name = sig.fullName;
                    const { error } = await supabase.from('leads').update(patch).eq('id', r.id);
                    if (error) logger.warn('lead_reassess_failed', { leadId: r.id, message: error.message });
                }));
            }
        }
    }

    // The campaign knows which client it was filed under; the leads should
    // too, or "for this client, these are the leads" cannot be answered.
    {
        const { data: cmp } = await supabase.from('campaigns').select('client_id').eq('id', campaignId).maybeSingle();
        if (cmp?.client_id) await linkLeadsToClient(cmp.client_id, [...idByUsername.values()], 'ig_campaign', jobId);
    }

    await supabase.from('campaigns')
        .update({ total_leads_found: linked }).eq('id', campaignId).eq('user_id', userId);

    return {
        campaignId,
        newUniqueLeads: missing.length,   // genuinely new leads
        totalLinked: linked,              // rows on this campaign, new or not
        methodsRun: units.length,
        warnings
    };
});

app.post('/api/run-campaign', spendLimit, async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;
        await assertJobSlot(ctx.user.id);

        const {
            campaignName, location, method1_keywords = [], hashtags = [],
            method3_1_keywords = [], competitor_handles = [], method6_keywords = [],
            selected_methods = []
        } = req.body;

        const input = {
            location: location || '',
            method1_keywords, hashtags, method3_1_keywords,
            competitor_handles, method6_keywords, selected_methods
        };

        const units = leadgenUnits(input);
        if (!units.length) {
            return res.status(400).json({
                error: 'Select at least one discovery method and give it something to work with.'
            });
        }

        // The campaign row is created here, not in the worker, so its id is
        // stable across a resume and the worker stays rebuildable from
        // jobs.input alone.
        const { data: newCmp, error: cmpErr } = await supabase.from('campaigns').insert([{
            user_id: ctx.user.id,
            client_id: await S.resolveClientId(req, ctx),
            name: campaignName || 'Discovery Campaign',
            location: location || null,
            keywords: [...method1_keywords, ...method3_1_keywords],
            selected_methods
        }]).select('id').single();
        if (cmpErr) throw cmpErr;

        const estimate = +(units.length * LEADGEN_UNIT_USD).toFixed(4);

        const job = await createJob(ctx.user.id, 'leadgen_campaign', 'leadgen',
            { clientId: await S.resolveClientId(req, ctx), ...input, campaignId: newCmp.id }, estimate);

        runJob(job.id, JOB_WORKERS['leadgen_campaign'](ctx.user.id, job.input, job.id));

        res.status(202).json({
            success: true,
            jobId: job.id,
            campaignId: newCmp.id,
            methods: units.length,
            estimatedUsd: estimate,
            budget: await budgetSnapshot('leadgen', ctx.user.id, LEADGEN_UNIT_USD)
        });
    } catch (err) { sendErr(res, err); }
});

// ===========================================================================
// STAGE 2 :: ENRICHMENT  (checkpointed job)
// ===========================================================================

registerWorker('leadgen_enrich', (userId, input, jobId) => async (progress, ck) => {
    const { campaignId, batchSize } = input;
    const size = Math.min(parseInt(batchSize || 25, 10), 100);

    await progress(5, 'Finding leads that still need enriching');

    const { data: linkData, error: linkErr } = await supabase.from('campaign_leads')
        .select('leads(id, username, is_enriched)')
        .eq('campaign_id', campaignId)
        .eq('user_id', userId);
    if (linkErr) throw linkErr;

    const handles = (linkData || []).map(d => d.leads)
        .filter(l => l && l.is_enriched !== true)
        .map(l => l.username)
        .slice(0, size);

    if (!handles.length) {
        return { campaignId, enrichedCount: 0, requested: 0,
                 message: 'All leads on this campaign are already enriched.' };
    }

    // One unit per batch of 25, so a run that pauses for credit resumes at the
    // batch boundary instead of re-scraping profiles already paid for.
    const BATCH = 25;
    const batches = [];
    for (let i = 0; i < handles.length; i += BATCH) batches.push(handles.slice(i, i + BATCH));

    let updated = 0;

    for (let b = 0; b < batches.length; b++) {
        const names = batches[b];
        const unit = 'enrich:' + names[0] + ':' + names.length;
        const pct = 10 + Math.floor(80 * b / batches.length);

        if (ck.isDone(unit)) {
            updated += Number(ck.get(unit) || 0);
            await progress(pct, `Batch ${b + 1} already done — not re-scraped`);
            continue;
        }

        const estimate = +((names.length / 1000) * COST_PER_1K_PROFILE).toFixed(6);
        await progress(pct, `Enriching ${names.length} profile(s), batch ${b + 1} of ${batches.length}`);

        const { client } = await getWorkingClient('leadgen', userId, { needUsd: estimate, jobId });

        const { items: profiles } = await callActor(client, 'apify/instagram-profile-scraper',
            { usernames: names },
            { waitSecs: 25, estimateUsd: estimate, maxItems: names.length, jobId });

        let batchUpdated = 0;
        const p40 = await leadsPhase40();
        for (const p of (profiles || [])) {
            const username = String(p.username || p.ownerUsername || '').toLowerCase().trim();
            if (!username) continue;

            const contacts = extractBioContacts(p);
            const patch = {
                full_name: p.fullName || p.full_name || p.name || null,
                email: contacts.email || p.inputEmail || null,
                phone: contacts.phone || p.phoneNumber || null,
                whatsapp: contacts.whatsapp,
                followers_count: p.followersCount ?? p.followers ?? 0,
                following_count: p.followsCount ?? null,
                posts_count: p.postsCount ?? null,
                bio: p.biography || null,
                website: p.externalUrl || null,
                category: p.businessCategoryName || null,
                is_business: !!p.isBusinessAccount,
                is_verified: !!p.verified,
                city: p.city || p.cityName || null,
                address: p.addressStreet || (p.businessAddress && (p.businessAddress.street_address || p.businessAddress.streetAddress)) || null,
                is_enriched: true
            };
            // The profile is the stronger evidence: read the lead again with
            // it. (phase 40) The recent posts the scraper returns alongside
            // the profile are evidence too, at no extra cost.
            if (p40) {
                const { data: cur } = await supabase.from('leads').select('*')
                    .eq('username', username).eq('owner_user_id', userId).eq('platform', 'instagram').maybeSingle();
                if (cur) {
                    const recent = (Array.isArray(p.latestPosts) ? p.latestPosts : []).slice(0, 12)
                        .map(x => leadPostSignal({ ownerUsername: username, ...x }, 'profile'));
                    const sig = leadSignalsAdd(cur.signals, recent);
                    patch.signals = sig;
                    Object.assign(patch, leadAssessment({ ...cur, ...patch }, sig, cur.methods || []));
                }
            }
            // Scoped to instagram since phase 16: a Facebook page can share a
            // handle with an Instagram account, and enrichment from the IG
            // profile scraper must not overwrite the Facebook lead.
            const { error: updErr } = await supabase.from('leads').update(patch)
                .eq('username', username).eq('owner_user_id', userId).eq('platform', 'instagram');

            if (!updErr) batchUpdated++;
        }

        updated += batchUpdated;
        await ck.done(unit, batchUpdated);
    }

    return { campaignId, enrichedCount: updated, requested: handles.length };
});

app.post('/api/enrich-campaign', spendLimit, async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;
        await assertJobSlot(ctx.user.id);

        const { campaignId, batchSize } = req.body;
        if (!campaignId) return res.status(400).json({ error: 'Campaign ID required' });

        // Confirm the campaign is the caller's before spending anything on it.
        // The old handler queried campaign_leads by campaign_id alone, so a
        // caller could spend their own credit scraping another tenant's handles.
        const { data: cmp } = await supabase.from('campaigns')
            .select('id').eq('id', campaignId).eq('user_id', ctx.user.id).maybeSingle();
        if (!cmp) return res.status(404).json({ error: 'Campaign not found.' });

        const size = Math.min(parseInt(batchSize || 25, 10), 100);
        const estimate = +((size / 1000) * COST_PER_1K_PROFILE).toFixed(4);

        const job = await createJob(ctx.user.id, 'leadgen_enrich', 'leadgen',
            { clientId: await S.resolveClientId(req, ctx), campaignId, batchSize: size }, estimate);

        runJob(job.id, JOB_WORKERS['leadgen_enrich'](ctx.user.id, job.input, job.id));

        res.status(202).json({
            success: true, jobId: job.id, campaignId,
            batchSize: size, estimatedUsd: estimate
        });
    } catch (err) { sendErr(res, err); }
});

// ===========================================================================
// VAULT / HISTORY
// ===========================================================================

app.get('/api/client-history', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;
        // Paged, and the lead columns are named rather than leads(*). The old
        // query shipped every bio the account had ever enriched just to draw a
        // list of campaign names, and grew without bound for the life of the
        // user.
        const limit  = Math.min(parseInt(req.query.limit  || '20', 10), 50);
        const offset = Math.max(parseInt(req.query.offset || '0',  10), 0);

        const { count } = await supabase.from('campaigns')
            .select('id', { count: 'exact', head: true }).eq('user_id', ctx.user.id);

        const { data: campaigns } = await supabase.from('campaigns')
            .select('*, campaign_leads(top_post_views, post_likes, post_comments, post_timestamp, top_post_url, ' +
                    'leads(id, username, full_name, email, phone, followers_count, following_count, posts_count, ' +
                    'bio, website, category, is_business, is_verified, city, address, is_enriched, profile_url))')
            .eq('user_id', ctx.user.id)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        res.status(200).json({
            campaigns,
            paging: { limit, offset, total: count || 0, hasMore: offset + limit < (count || 0) }
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/search-leads', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;
        // PostgREST parses .or() as a DSL: commas separate terms, dots separate
        // column.operator.value. Anything from the user that survives into that
        // string is filter injection — bounded by the owner_user_id AND, but
        // still able to break or redefine the query.
        const query = String(req.query.q || '')
            .toLowerCase().trim()
            .replace(/[@,().\\%*]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 80);
        if (!query) return res.status(400).json({ error: 'Query required' });

        const { data: leads, error } = await supabase.from('leads')
            .select('*, campaign_leads(top_post_views, post_likes, post_comments, post_timestamp, top_post_url, campaigns(name))')
            .eq('owner_user_id', ctx.user.id)
            .or(`username.ilike.%${query}%,full_name.ilike.%${query}%,email.ilike.%${query}%`)
            .limit(50);

        if (error) throw error;
        res.status(200).json({ leads });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===========================================================================
// THE MASTER LEAD LIST (phase 20)
//
// Every lead this account has ever collected, across every campaign, every
// client and both platforms — browsable rather than searchable.
//
// /api/search-leads needs a search term and returns 50 rows, which is right
// for "find that florist" and useless for "what have we actually got". This is
// the second question: how many, from where, how many reachable, and give me
// the slice that matches.
//
// SCOPE (phase 29): one list for the whole agency. Every lead anyone here has
// collected — an employee's campaign, a colleague's Facebook search, a trial
// client's own draw — lands in the same place, filed by industry and
// location, one row per business (the leads_master view). `mine=1` narrows
// it to the caller's own rows; a client account only ever sees its own.
// Packaging any of it for sale is still not built here.
// ===========================================================================

/**
 * One CSV cell.
 *
 * Two separate jobs, and skipping either produces a broken file:
 *
 * 1. CSV quoting, for values containing a comma, a quote or a newline. Scraped
 *    bios contain all three routinely.
 * 2. Formula neutralisation. A value starting '=', '+', '-' or '@' is executed
 *    as a formula by Excel, Sheets and LibreOffice on open — so a scraped bio
 *    reading `=HYPERLINK(...)` becomes a live link in the operator's
 *    spreadsheet, and `=cmd|...` is worse. A leading apostrophe makes the cell
 *    literal text, which is what it always was.
 *
 * Every field written here came from a scrape, so none of it is trusted.
 */
function csvCell(v) {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/**
 * Record that these leads were found for this client. (phase 23)
 *
 * Idempotent: a resumed run replays its save phase, and the link must not
 * turn into a duplicate or an error when it does. Never throws — a failed
 * link is a warning on the run, not a reason to lose the leads themselves.
 */
async function linkLeadsToClient(clientId, leadIds, source, jobId = null) {
    const ids = [...new Set((leadIds || []).filter(id => S.UUID_RE.test(String(id || ''))))];
    if (!clientId || !S.UUID_RE.test(String(clientId)) || !ids.length) return 0;
    let linked = 0;
    for (let i = 0; i < ids.length; i += 200) {
        const slice = ids.slice(i, i + 200).map(lead_id => ({ client_id: clientId, lead_id, source, job_id: jobId }));
        const { error } = await supabase.from('client_leads').upsert(slice, { onConflict: 'client_id,lead_id', ignoreDuplicates: true });
        if (error) { logger.warn('client_leads_link_failed', { clientId, source, message: error.message }); continue; }
        linked += slice.length;
    }
    return linked;
}

/**
 * Whose rows a request reads. (phase 29)
 *
 *   client — the rows linked to one client (client_only=1), whoever found them.
 *   agency — the master list: every lead anyone here has collected, one row
 *            per business (the leads_master view). The default for an admin
 *            or an employee.
 *   mine   — the caller's own rows: mine=1, or a client account, which never
 *            sees the agency's list however it asks.
 *
 * A client_only request the caller cannot read is refused, not silently
 * widened to their own leads.
 */
async function leadScope(req, ctx) {
    if (String(req.query.client_only || '') === '1') {
        const cid = String(req.query.client_id || req.query.clientId || '');
        const c = await S.clientAccess(ctx.user.id, cid, 'viewer');
        if (!c) { const e = new Error('Client not found.'); e.statusCode = 404; throw e; }
        const { data } = await supabase.from('client_leads').select('lead_id').eq('client_id', c.id);
        return { kind: 'client', client: c, ids: (data || []).map(r => r.lead_id) };
    }
    if (ctx.profile?.role === 'client' || String(req.query.mine || '') === '1') return { kind: 'mine' };
    return { kind: 'agency' };
}

/**
 * One row per business in a client's view. Two employees finding the same
 * Page for one client produce two lead rows (the key is per owner); the
 * client is asking about the business, not about who found it. The richer
 * row wins — enriched over not, then the most recently seen. The agency
 * list gets the same rule from the leads_master view, in the database.
 */
function dedupeLeads(rows) {
    const best = new Map();
    for (const r of (rows || [])) {
        const k = `${r.platform || 'instagram'}:${String(r.username || '').toLowerCase()}`;
        const cur = best.get(k);
        if (!cur) { best.set(k, r); continue; }
        const better = (!!r.is_enriched && !cur.is_enriched) ||
            (!!r.is_enriched === !!cur.is_enriched && String(r.created_at) > String(cur.created_at));
        if (better) best.set(k, r);
    }
    return [...best.values()];
}

/**
 * Shared filter builder, so the CSV is always exactly what is on screen.
 *
 * Industry and location are how the list is filed: the search that found a
 * lead, else the profile's own category and city. Rows from before phase 29
 * may carry only the profile's values, so a filter word is looked for in
 * both columns.
 */
function leadFilters(q, scope, userId) {
    let s;
    if (scope.kind === 'client')      s = supabase.from('leads').select('*', { count: 'exact' }).in('id', scope.ids);
    else if (scope.kind === 'agency') s = supabase.from('leads_master').select('*', { count: 'exact' });
    else                              s = supabase.from('leads').select('*', { count: 'exact' }).eq('owner_user_id', userId);

    const platform = String(q.platform || '').toLowerCase();
    if (platform === 'instagram' || platform === 'facebook') s = s.eq('platform', platform);

    if (String(q.enriched || '') === '1') s = s.eq('is_enriched', true);
    if (String(q.business || '') === '1') s = s.eq('is_business', true);
    if (String(q.verified || '') === '1') s = s.eq('is_verified', true);

    // "Reachable" is the only count that matters for outreach, and it is not a
    // column — a lead is reachable if ANY channel is present.
    if (String(q.reachable || '') === '1') {
        s = s.or('email.not.is.null,phone.not.is.null,whatsapp.not.is.null');
    }
    if (String(q.has_email || '') === '1') s = s.not('email', 'is', null);

    const min = parseInt(q.min_followers, 10);
    const max = parseInt(q.max_followers, 10);
    if (Number.isFinite(min)) s = s.gte('followers_count', min);
    if (Number.isFinite(max)) s = s.lte('followers_count', max);

    // Same sanitising as /api/search-leads: anything reaching PostgREST's .or()
    // DSL is filter injection, bounded by the scope AND but still able to
    // redefine the query.
    const clean = v => String(v || '').toLowerCase().replace(/[@,().\\%*]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    const industry = clean(q.industry || q.category);
    if (industry) s = s.or(`industry.ilike.%${industry}%,category.ilike.%${industry}%`);
    const where = clean(q.location || q.city);
    if (where) s = s.or(`location.ilike.%${where}%,city.ilike.%${where}%`);
    // Which list (phase 40): influencers, businesses, personal accounts, or
    // the ones still unsure. kind_now is the person's label first, then the
    // rules; leads from before phase 40 read as unsure until sorted.
    const kind = String(q.kind || '').toLowerCase();
    if (LEAD_KINDS.includes(kind)) s = s.eq('kind_now', kind);
    else if (kind === 'check') s = s.in('kind_now', ['unsure', 'personal']);
    const minFit = parseInt(q.min_fit, 10);
    if (Number.isFinite(minFit)) s = s.gte('fit_score', minFit);
    if (String(q.method || '') && LEAD_METHOD_NAMES[String(q.method)]) s = s.contains('methods', [String(q.method)]);
    const finder = String(q.found_by || '');
    if (scope.kind !== 'mine' && S.UUID_RE.test(finder)) s = s.eq('owner_user_id', finder);
    const text = clean(q.q);
    if (text) s = s.or(`username.ilike.%${text}%,full_name.ilike.%${text}%,bio.ilike.%${text}%`);

    return s;
}

const LEAD_SORTS = {
    newest:    { col: 'created_at',      asc: false },
    oldest:    { col: 'created_at',      asc: true  },
    followers: { col: 'followers_count', asc: false },
    smallest:  { col: 'followers_count', asc: true  },
    username:  { col: 'username',        asc: true  },
    fit:       { col: 'fit_score',       asc: false }
};
S.LEAD_SORTS = LEAD_SORTS;

/**
 * Who found each row, for the "found by" column. One lookup per page rather
 * than per row; a name where they have one, else the email.
 */
async function withFinders(rows) {
    const list = rows || [];
    const ids = [...new Set(list.map(r => r.owner_user_id).filter(Boolean))];
    if (!ids.length) return list;
    const { data } = await supabase.from('app_users').select('id, email, full_name').in('id', ids);
    const by = new Map((data || []).map(u => [u.id, { id: u.id, email: u.email || null, name: u.full_name || null }]));
    return list.map(r => ({ ...r, found_by: by.get(r.owner_user_id) || { id: r.owner_user_id || null, email: null, name: null } }));
}

const LEAD_SCOPE_NOTE = {
    agency: 'Every lead anyone here has collected, one row per business.',
    mine:   'Your own rows only.'
};

app.get('/api/leads', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;

        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        let sort = LEAD_SORTS[String(req.query.sort || 'newest')] || LEAD_SORTS.newest;
        if (sort === LEAD_SORTS.fit && !(await leadsPhase40())) sort = LEAD_SORTS.newest;

        const scope = await leadScope(req, ctx);
        if (scope.kind === 'client') {
            // A client's list is de-duplicated across the people who found it,
            // and a page cannot be cut before the duplicates are gone — so the
            // whole view is read (capped) and paged here. Per-client sets are
            // hundreds, not hundreds of thousands.
            const client = { id: scope.client.id, name: scope.client.name };
            if (!scope.ids.length) return res.json({ leads: [], page: 1, limit, total: 0, pages: 1, scope: 'client', client });
            const { data, error } = await leadFilters(req.query, scope, ctx.user.id)
                .order(sort.col, { ascending: sort.asc, nullsFirst: false })
                .range(0, 4999);
            if (error) throw error;
            const rows = dedupeLeads(data);
            return res.json({
                leads: await withPipeline(await withFinders(rows.slice((page - 1) * limit, page * limit)), scope.client.id),
                page, limit, total: rows.length,
                pages: Math.max(1, Math.ceil(rows.length / limit)),
                scope: 'client', client
            });
        }

        const { data, error, count } = await leadFilters(req.query, scope, ctx.user.id)
            .order(sort.col, { ascending: sort.asc, nullsFirst: false })
            .range((page - 1) * limit, page * limit - 1);
        if (error) throw error;

        res.json({
            leads: await withPipeline(await withFinders(data || []), null),
            page, limit,
            total: count || 0,
            pages: Math.max(1, Math.ceil((count || 0) / limit)),
            scope: scope.kind
        });
    } catch (err) { sendErr(res, err); }
});

/**
 * The shape of the whole list — what an operator needs before filtering it.
 *
 * Counted with head-only queries rather than by loading rows: the list is
 * meant to grow into six figures and a summary must not get slower as it does.
 * Industries and locations are tallied from the most recent rows, capped,
 * because they are a shortcut to a filter, not an analysis.
 */
app.get('/api/leads/summary', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;
        const U = ctx.user.id;
        const scope = await leadScope(req, ctx);

        const tally = (rows, pick) => {
            const m = {};
            for (const r of rows) { const v = String(pick(r) || '').trim(); if (v) m[v] = (m[v] || 0) + 1; }
            return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([name, n]) => ({ name, n }));
        };
        const facets = rows => ({
            industries: tally(rows, r => r.industry || r.category),
            locations:  tally(rows, r => r.location || r.city),
            people:     new Set(rows.map(r => r.owner_user_id).filter(Boolean)).size
        });

        if (scope.kind === 'client') {
            // Counted over the de-duplicated view, so the tiles agree with the
            // list underneath them.
            const { data } = scope.ids.length
                ? await supabase.from('leads').select('*').in('id', scope.ids).range(0, 4999)
                : { data: [] };
            const rows = dedupeLeads(data);
            const has = f => rows.filter(r => r[f] != null && r[f] !== '').length;
            return res.json({
                total: rows.length,
                byPlatform: { instagram: rows.filter(r => r.platform !== 'facebook').length, facebook: rows.filter(r => r.platform === 'facebook').length },
                enriched: rows.filter(r => r.is_enriched).length,
                withEmail: has('email'), withPhone: has('phone'),
                reachable: rows.filter(r => r.email || r.phone || r.whatsapp).length,
                byKind: Object.fromEntries(LEAD_KINDS.map(k => [k, rows.filter(r => (r.kind_label || r.lead_kind || 'unsure') === k).length])),
                ...facets(rows),
                sampledFrom: rows.length,
                scope: 'client',
                client: { id: scope.client.id, name: scope.client.name },
                note: `Leads found for ${scope.client.name}, by anyone working on it, one row per business.`
            });
        }

        const base = () => scope.kind === 'agency'
            ? supabase.from('leads_master').select('id', { count: 'exact', head: true })
            : supabase.from('leads').select('id', { count: 'exact', head: true }).eq('owner_user_id', U);
        const countOf = fn => fn(base());

        const [all, ig, fb, enriched, withEmail, withPhone, reachable, ...kindCounts] = await Promise.all([
            countOf(q => q),
            countOf(q => q.eq('platform', 'instagram')),
            countOf(q => q.eq('platform', 'facebook')),
            countOf(q => q.eq('is_enriched', true)),
            countOf(q => q.not('email', 'is', null)),
            countOf(q => q.not('phone', 'is', null)),
            countOf(q => q.or('email.not.is.null,phone.not.is.null,whatsapp.not.is.null')),
            ...LEAD_KINDS.map(k => countOf(q => q.eq('kind_now', k)))
        ]);
        const byKind = (await leadsPhase40())
            ? Object.fromEntries(LEAD_KINDS.map((k, i) => [k, (kindCounts[i] && kindCounts[i].count) || 0]))
            : null;

        const sampleQ = scope.kind === 'agency'
            ? supabase.from('leads_master').select('industry, category, location, city, owner_user_id')
            : supabase.from('leads').select('industry, category, location, city, owner_user_id').eq('owner_user_id', U);
        const { data: sample } = await sampleQ.order('created_at', { ascending: false }).limit(5000);

        res.json({
            total: all.count || 0,
            byPlatform: { instagram: ig.count || 0, facebook: fb.count || 0 },
            enriched: enriched.count || 0,
            withEmail: withEmail.count || 0,
            withPhone: withPhone.count || 0,
            reachable: reachable.count || 0,
            byKind,
            ...facets(sample || []),
            sampledFrom: (sample || []).length,
            scope: scope.kind,
            note: `${LEAD_SCOPE_NOTE[scope.kind]} Industries and locations are tallied from the 5,000 most recent.`
        });
    } catch (err) { sendErr(res, err); }
});

/** CSV of exactly what the filters select. Both spellings, as with demand-export. */
app.get(['/api/leads/export', '/api/leads/export.csv'], async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;
        const cap = Math.min(Math.max(parseInt(req.query.limit, 10) || 5000, 1), 20000);
        let sort = LEAD_SORTS[String(req.query.sort || 'newest')] || LEAD_SORTS.newest;
        if (sort === LEAD_SORTS.fit && !(await leadsPhase40())) sort = LEAD_SORTS.newest;

        const scope = await leadScope(req, ctx);
        let data;
        if (scope.kind === 'client') {
            const r = scope.ids.length
                ? await leadFilters(req.query, scope, ctx.user.id).order(sort.col, { ascending: sort.asc, nullsFirst: false }).range(0, 4999)
                : { data: [], error: null };
            if (r.error) throw r.error;
            data = dedupeLeads(r.data).slice(0, cap);
        } else {
            const r = await leadFilters(req.query, scope, ctx.user.id)
                .order(sort.col, { ascending: sort.asc, nullsFirst: false })
                .range(0, cap - 1);
            if (r.error) throw r.error;
            data = r.data;
        }
        const rows = (await withFinders(data || [])).map(r => ({
            ...r,
            industry: r.industry || r.category || null,
            location: r.location || r.city || null,
            found_by: r.found_by?.email || r.found_by?.name || ''
        }));

        const cols = ['platform', 'username', 'full_name', 'kind_now', 'fit_score', 'industry', 'location',
            'email', 'phone', 'whatsapp', 'website',
            'followers_count', 'following_count', 'posts_count', 'engagement_rate',
            'category', 'city', 'address', 'is_business', 'is_verified', 'is_enriched',
            'profile_url', 'bio', 'found_by', 'created_at'];
        const csv = [cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\r\n');

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="edgelead-leads-${new Date().toISOString().slice(0, 10)}.csv"`);
        res.send('\ufeff' + csv);       // BOM, or Excel mangles non-ASCII names
    } catch (err) { sendErr(res, err); }
});

app.delete('/api/campaign/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;
        const { error } = await supabase.from('campaigns')
            .delete().eq('id', req.params.id).eq('user_id', ctx.user.id);
        if (error) throw error;
        res.status(200).json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===========================================================================
// PHASE 40 :: THE PIPELINE, AND CORRECTING A LEAD
//
// A lead that has been found is where the work starts. One pipeline row is
// one lead worked for one client brand (an influencer for a brand's campaign)
// or for the agency itself (a business it is pitching). Stages differ by
// kind. Every move writes a line in the row's history, so "who talked to
// them last and what did they say" has one answer.
// ===========================================================================

const PIPE_STAGES = {
    influencer: [['found', 'Found'], ['contacted', 'Contacted'], ['rates', 'Rates asked'], ['agreed', 'Agreed'], ['live', 'Content live'], ['paid', 'Paid'], ['dropped', 'Dropped']],
    business:   [['new', 'New'], ['contacted', 'Contacted'], ['replied', 'Replied'], ['meeting', 'Meeting'], ['won', 'Won'], ['lost', 'Lost']]
};
S.PIPE_STAGES = PIPE_STAGES;
const PIPE_CLOSED = new Set(['paid', 'dropped', 'won', 'lost']);
const pipeStageName = (kind, st) => ((PIPE_STAGES[kind] || []).find(x => x[0] === st) || [st, st])[1];
const PIPE_NIL = '00000000-0000-0000-0000-000000000000';

async function pipelineReady() {
    const { error } = await supabase.from('lead_pipeline').select('id').limit(1);
    return !error;
}
function pipelineMissing(res) {
    return res.status(503).json({ error: 'The lead pipeline needs the phase-40 database update. Run sql/schema-phase40.sql in the Supabase SQL editor.', code: 'migration_required' });
}

/** The clients this person may see: every one for an admin, else owned and member-of. */
async function visibleClientIds(ctx) {
    if (ctx.profile?.role === 'admin') return null;           // null = all
    const [{ data: owned }, { data: mem }] = await Promise.all([
        supabase.from('clients').select('id').eq('owner_user_id', ctx.user.id),
        supabase.from('client_members').select('client_id').eq('user_id', ctx.user.id)
    ]);
    return new Set([...(owned || []).map(c => c.id), ...(mem || []).map(m => m.client_id)]);
}

/**
 * The pipeline rows for a page of leads, by handle. In a client's list only
 * that client's row; in the agency list every row, so "already being worked
 * for Sakura by Rafi" shows before someone else starts the same conversation.
 */
async function withPipeline(rows, clientId) {
    const list = rows || [];
    if (!list.length || !(await leadsPhase40())) return list;
    const names = [...new Set(list.map(r => String(r.username || '')).filter(Boolean))];
    let q = supabase.from('lead_pipeline').select('id, platform, username, client_id, kind, stage, assigned_to, follow_up_on').in('username', names);
    if (clientId) q = q.eq('client_id', clientId);
    const { data, error } = await q;
    if (error || !data || !data.length) return list;
    const clientIds = [...new Set(data.map(p => p.client_id).filter(Boolean))];
    const people = [...new Set(data.map(p => p.assigned_to).filter(Boolean))];
    const [{ data: cs }, { data: us }] = await Promise.all([
        clientIds.length ? supabase.from('clients').select('id, name, brand').in('id', clientIds) : { data: [] },
        people.length ? supabase.from('app_users').select('id, email, full_name').in('id', people) : { data: [] }
    ]);
    const cName = id => { const c = (cs || []).find(x => x.id === id); return c ? (c.brand || c.name) : null; };
    const uName = id => { const u = (us || []).find(x => x.id === id); return u ? (u.full_name || String(u.email || '').split('@')[0]) : null; };
    return list.map(r => ({
        ...r,
        pipeline: data.filter(p => p.platform === (r.platform || 'instagram') && String(p.username).toLowerCase() === String(r.username || '').toLowerCase())
            .map(p => ({ id: p.id, clientId: p.client_id, client: cName(p.client_id), kind: p.kind, stage: p.stage, stageName: pipeStageName(p.kind, p.stage), assignedTo: p.assigned_to, assignee: uName(p.assigned_to), followUpOn: p.follow_up_on }))
    }));
}

/** One lead, as the detail drawer shows it. */
function leadDetailView(r) {
    const sig = r.signals || {};
    const places = Object.keys(sig.locs || {}).length;
    return {
        id: r.id, platform: r.platform || 'instagram', username: r.username, fullName: r.full_name || null,
        profileUrl: r.profile_url || null, kind: r.kind_label || r.lead_kind || 'unsure', machineKind: r.lead_kind || null,
        labeled: !!r.kind_label, kindScore: r.kind_score ?? null, kindStage: r.kind_stage || null, kindReasons: r.kind_reasons || [],
        fit: r.fit_score ?? null, fitReasons: r.fit_reasons || [], tier: leadFollowerTier(r.followers_count == null ? null : Number(r.followers_count)),
        engagement: leadEngagement(r, sig), methods: (r.methods || []).map(m => ({ key: m, name: LEAD_METHOD_NAMES[m] || m })),
        followers: r.followers_count ?? null, following: r.following_count ?? null, posts: r.posts_count ?? null,
        category: r.category || null, bio: r.bio || null, website: r.website || null,
        email: r.email || null, phone: r.phone || null, whatsapp: r.whatsapp || null,
        industry: r.industry || null, location: r.location || r.city || null, enriched: !!r.is_enriched, verified: !!r.is_verified,
        evidence: { postsSeen: sig.posts || 0, places, businessesTagged: sig.venues || [], paidPartnerships: sig.sp || 0, lastPostAt: sig.lastPostAt || null, captions: sig.captions || [] }
    };
}

// Correct a lead's kind. Applied to every copy of the business (one per
// person who found it), so the lists agree, and kept apart from the rules'
// verdict so the rules can be measured against people.
app.patch('/api/leads/:id/kind', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;
        if (!S.staffOnly(ctx, res)) return;
        if (!(await leadsPhase40())) return pipelineMissing(res);
        const kind = req.body?.kind === null || req.body?.kind === '' ? null : String(req.body?.kind || '');
        if (kind !== null && !['influencer', 'business', 'personal'].includes(kind)) return res.status(400).json({ error: 'Kind must be influencer, business or personal.' });
        if (!S.UUID_RE.test(String(req.params.id))) return res.status(404).json({ error: 'Lead not found.' });
        const { data: lead } = await supabase.from('leads').select('*').eq('id', req.params.id).maybeSingle();
        if (!lead) return res.status(404).json({ error: 'Lead not found.' });
        const { data: copies } = await supabase.from('leads').select('*').eq('platform', lead.platform || 'instagram').eq('username', lead.username);
        for (const r of (copies || [lead])) {
            const fit = leadFit(r, r.signals, kind || r.lead_kind || 'unsure', r.methods || []);
            await supabase.from('leads').update({
                kind_label: kind, labeled_by: kind ? ctx.user.id : null, labeled_at: kind ? new Date().toISOString() : null,
                fit_score: fit.score, fit_reasons: fit.reasons
            }).eq('id', r.id);
        }
        const { data: now } = await supabase.from('leads').select('*').eq('id', lead.id).maybeSingle();
        res.json({ lead: leadDetailView(now || lead), copies: (copies || []).length });
    } catch (err) { sendErr(res, err); }
});

app.get('/api/leads/:id/detail', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;
        if (!S.staffOnly(ctx, res)) return;
        if (!S.UUID_RE.test(String(req.params.id))) return res.status(404).json({ error: 'Lead not found.' });
        const { data: lead } = await supabase.from('leads').select('*').eq('id', req.params.id).maybeSingle();
        if (!lead) return res.status(404).json({ error: 'Lead not found.' });
        const [withP] = await withPipeline([lead], null);
        const visible = await visibleClientIds(ctx);
        const pipeline = (withP.pipeline || []).filter(p => !p.clientId || !visible || visible.has(p.clientId));
        res.json({ lead: leadDetailView(lead), pipeline, stages: PIPE_STAGES });
    } catch (err) { sendErr(res, err); }
});

/** How often the rules agree with the people who corrected them. */
app.get('/api/leads/accuracy', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;
        if (!S.staffOnly(ctx, res)) return;
        if (!(await leadsPhase40())) return pipelineMissing(res);
        const { data } = await supabase.from('leads').select('lead_kind, kind_label').not('kind_label', 'is', null).limit(5000);
        const rows = data || [];
        const grid = {};
        let agree = 0, unsure = 0;
        for (const r of rows) {
            const m = r.lead_kind || 'unsure';
            grid[r.kind_label] = grid[r.kind_label] || {};
            grid[r.kind_label][m] = (grid[r.kind_label][m] || 0) + 1;
            if (m === r.kind_label) agree++;
            if (m === 'unsure') unsure++;
        }
        res.json({
            labeled: rows.length, agree, unsure, wrong: rows.length - agree - unsure,
            agreement: rows.length ? Math.round(agree / rows.length * 100) : null,
            grid,
            note: rows.length < 50 ? 'Mark at least 50 leads (the “Is this right?” buttons) for this number to mean much.' : null
        });
    } catch (err) { sendErr(res, err); }
});

// Sort every lead again: after the rules change, or for leads collected
// before phase 40. A job, like all work, and free: no Apify, no model.
registerWorker('leads_reclassify', (userId, input) => async (progress) => {
    let from = 0, done = 0;
    const PAGE = 500;
    for (;;) {
        const { data } = await supabase.from('leads').select('*').order('created_at', { ascending: true }).range(from, from + PAGE - 1);
        const rows = data || [];
        if (!rows.length) break;
        for (let i = 0; i < rows.length; i += 20) {
            await Promise.all(rows.slice(i, i + 20).map(async r => {
                const methods = r.methods && r.methods.length ? r.methods : (r.platform === 'facebook' ? ['fb'] : []);
                const patch = r.platform === 'facebook'
                    ? { methods, lead_kind: 'business', kind_score: -60, kind_stage: 'profile', kind_reasons: [{ w: -60, text: 'A Facebook business Page' }],
                        ...(() => { const f = leadFit(r, r.signals, r.kind_label || 'business', methods); return { fit_score: f.score, fit_reasons: f.reasons, classified_at: new Date().toISOString() }; })() }
                    : { methods, ...leadAssessment(r, r.signals, methods) };
                await supabase.from('leads').update(patch).eq('id', r.id);
            }));
        }
        done += rows.length; from += PAGE;
        await progress(Math.min(95, 5 + Math.round(done / (done + PAGE) * 90)), `Sorted ${done.toLocaleString('en-US')} leads`);
        if (rows.length < PAGE) break;
    }
    return { sorted: done };
});

app.post('/api/leads/reclassify', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;
        if (ctx.profile?.role !== 'admin') return res.status(403).json({ error: 'Only an admin can re-sort the whole list.' });
        if (!(await leadsPhase40())) return pipelineMissing(res);
        await assertJobSlot(ctx.user.id);
        const job = await createJob(ctx.user.id, 'leads_reclassify', 'leadgen', {}, 0);
        runJob(job.id, JOB_WORKERS['leads_reclassify'](ctx.user.id, job.input, job.id));
        res.status(202).json({ jobId: job.id });
    } catch (err) { sendErr(res, err); }
});

// --- the pipeline -------------------------------------------------------------

async function pipeRowFor(ctx, id, need = 'viewer') {
    if (!S.UUID_RE.test(String(id || ''))) return null;
    const { data: p } = await supabase.from('lead_pipeline').select('*').eq('id', id).maybeSingle();
    if (!p) return null;
    if (p.client_id && !(await S.clientAccess(ctx.user.id, p.client_id, need))) return null;
    return p;
}

async function pipeNote(pipelineId, authorId, body, auto = false) {
    const text = String(body || '').trim().slice(0, 2000);
    if (!text) return null;
    const { data } = await supabase.from('lead_notes').insert([{ pipeline_id: pipelineId, author_id: authorId, body: text, auto }]).select().maybeSingle();
    return data;
}

/** The pipeline row, with the lead it is about and the names people read. */
async function pipeViews(rows) {
    const list = rows || [];
    if (!list.length) return [];
    const names = [...new Set(list.map(p => p.username))];
    const [{ data: leads }, { data: cs }, { data: us }, { data: notes }] = await Promise.all([
        supabase.from('leads_master').select('*').in('username', names),
        supabase.from('clients').select('id, name, brand').in('id', [...new Set(list.map(p => p.client_id).filter(Boolean))]),
        supabase.from('app_users').select('id, email, full_name').in('id', [...new Set(list.map(p => p.assigned_to).filter(Boolean))]),
        supabase.from('lead_notes').select('pipeline_id, body, auto, created_at').in('pipeline_id', list.map(p => p.id)).order('created_at', { ascending: false })
    ]);
    const today = new Date().toISOString().slice(0, 10);
    return list.map(p => {
        const l = (leads || []).find(x => (x.platform || 'instagram') === p.platform && String(x.username).toLowerCase() === String(p.username).toLowerCase()) || null;
        const c = (cs || []).find(x => x.id === p.client_id);
        const u = (us || []).find(x => x.id === p.assigned_to);
        const last = (notes || []).find(n => n.pipeline_id === p.id && !n.auto) || (notes || []).find(n => n.pipeline_id === p.id) || null;
        return {
            id: p.id, platform: p.platform, username: p.username, kind: p.kind, stage: p.stage, stageName: pipeStageName(p.kind, p.stage),
            closed: PIPE_CLOSED.has(p.stage),
            clientId: p.client_id || null, client: c ? (c.brand || c.name) : null,
            assignedTo: p.assigned_to || null, assignee: u ? (u.full_name || String(u.email || '').split('@')[0]) : null,
            followUpOn: p.follow_up_on || null,
            due: p.follow_up_on && !PIPE_CLOSED.has(p.stage) ? (p.follow_up_on < today ? 'overdue' : p.follow_up_on === today ? 'today' : null) : null,
            rate: p.rate || null, lostReason: p.lost_reason || null, stageAt: p.stage_at || p.created_at, updatedAt: p.updated_at || p.created_at,
            lastNote: last ? { body: last.body, auto: !!last.auto, at: last.created_at } : null,
            lead: l ? {
                id: l.id, fullName: l.full_name || null, followers: l.followers_count ?? null, fit: l.fit_score ?? null,
                email: l.email || null, phone: l.phone || null, whatsapp: l.whatsapp || null,
                profileUrl: l.profile_url || null, why: (l.kind_reasons || [])[0]?.text || null
            } : null
        };
    });
}

/** Who a lead can be handed to: the agency's active people. */
app.get('/api/leads/team', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;
        if (!S.staffOnly(ctx, res)) return;
        const { data } = await supabase.from('app_users').select('id, email, full_name, role, is_active').neq('role', 'client');
        res.json({ people: (data || []).filter(u => u.is_active !== false)
            .map(u => ({ id: u.id, name: u.full_name || String(u.email || '').split('@')[0], me: u.id === ctx.user.id }))
            .sort((a, b) => (b.me - a.me) || a.name.localeCompare(b.name)) });
    } catch (err) { sendErr(res, err); }
});

app.get('/api/leads/pipeline', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;
        if (!S.staffOnly(ctx, res)) return;
        if (!(await pipelineReady())) return pipelineMissing(res);
        let q = supabase.from('lead_pipeline').select('*');
        const kind = String(req.query.kind || '');
        if (PIPE_STAGES[kind]) q = q.eq('kind', kind);
        const cid = String(req.query.client_id || req.query.clientId || '');
        if (cid === 'agency') q = q.is('client_id', null);
        else if (cid === 'all') { /* every brand and the agency's own (phase 57) */ }
        else if (S.UUID_RE.test(cid)) {
            if (!(await S.clientAccess(ctx.user.id, cid, 'viewer'))) return res.status(404).json({ error: 'Client not found.' });
            q = q.eq('client_id', cid);
        }
        const who = String(req.query.assigned || '');
        if (who === 'me') q = q.eq('assigned_to', ctx.user.id);
        else if (S.UUID_RE.test(who)) q = q.eq('assigned_to', who);
        const { data, error } = await q.order('updated_at', { ascending: false }).limit(1000);
        if (error) throw error;
        const visible = await visibleClientIds(ctx);
        let rows = await pipeViews((data || []).filter(p => !p.client_id || !visible || visible.has(p.client_id)));
        const due = String(req.query.due || '');
        if (due === 'now') rows = rows.filter(r => r.due);
        if (String(req.query.open || '') === '1') rows = rows.filter(r => !r.closed);
        res.json({ rows, stages: PIPE_STAGES, dueNow: rows.filter(r => r.due && r.assignedTo === ctx.user.id).length });
    } catch (err) { sendErr(res, err); }
});

/** A pipeline lead goes to someone on the team who can open its client (phase 57), never an owner login. */
async function pipeAssigneeOk(userId, clientId) {
    if ((await S.userRole(userId)) === 'client') return false;
    const { data: u } = await supabase.from('app_users').select('id, is_active').eq('id', userId).maybeSingle();
    if (!u || u.is_active === false) return false;
    return clientId ? !!(await S.clientAccess(userId, clientId, 'viewer')) : true;
}

/**
 * Put leads in the pipeline, for a client brand or for the agency. One lead
 * or many (the list's checkboxes). A lead already being worked for the same
 * brand is not duplicated: the answer says who has it.
 */
app.post('/api/leads/pipeline', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;
        if (!S.staffOnly(ctx, res)) return;
        if (!(await pipelineReady())) return pipelineMissing(res);
        const b = req.body || {};
        const ids = [...new Set([].concat(b.leadIds || [], b.leadId || []).map(String).filter(id => S.UUID_RE.test(id)))].slice(0, 100);
        if (!ids.length) return res.status(400).json({ error: 'Choose at least one lead.' });
        let clientId = null;
        if (b.clientId) {
            const c = await S.clientAccess(ctx.user.id, String(b.clientId), 'editor');
            if (!c) return res.status(403).json({ error: 'You need edit access to that client to add leads for it.' });
            clientId = c.id;
        }
        const assignedTo = b.assignedTo === null ? null : (S.UUID_RE.test(String(b.assignedTo || '')) ? String(b.assignedTo) : ctx.user.id);
        if (assignedTo && !(await pipeAssigneeOk(assignedTo, clientId))) return res.status(400).json({ error: 'Choose someone on the team who can open that client.' });
        const followUpOn = /^\d{4}-\d{2}-\d{2}$/.test(String(b.followUpOn || '')) ? b.followUpOn : null;
        const { data: leads } = await supabase.from('leads').select('*').in('id', ids);
        const added = [], already = [], skipped = [];
        for (const l of (leads || [])) {
            const kind = ['influencer', 'business'].includes(b.kind) ? b.kind : (l.kind_label || l.lead_kind);
            if (!['influencer', 'business'].includes(kind)) { skipped.push({ username: l.username, why: 'Mark it as an influencer or a business first.' }); continue; }
            const username = String(l.username), platform = l.platform || 'instagram';
            let ex = supabase.from('lead_pipeline').select('*').eq('platform', platform).eq('username', username);
            ex = clientId ? ex.eq('client_id', clientId) : ex.is('client_id', null);
            const { data: existing } = await ex.maybeSingle();
            if (existing) { already.push(existing); continue; }
            const stage = (PIPE_STAGES[kind].find(s => s[0] === b.stage) || PIPE_STAGES[kind][0])[0];
            const { data: row, error } = await supabase.from('lead_pipeline').insert([{
                platform, username, client_id: clientId, kind, stage, assigned_to: assignedTo, follow_up_on: followUpOn,
                created_by: ctx.user.id, updated_by: ctx.user.id
            }]).select().maybeSingle();
            if (error) { skipped.push({ username, why: error.message }); continue; }
            await pipeNote(row.id, ctx.user.id, `Added${clientId ? '' : ' as the agency’s own prospect'} at ${pipeStageName(kind, stage)}.`, true);
            if (b.note) await pipeNote(row.id, ctx.user.id, b.note);
            added.push(row);
            // Assigning an influencer to a brand files the lead under it too.
            if (clientId) {
                const { data: copies } = await supabase.from('leads').select('id').eq('platform', platform).eq('username', username);
                await linkLeadsToClient(clientId, (copies || []).map(x => x.id), 'pipeline', null);
            }
        }
        res.status(added.length ? 201 : 200).json({
            added: await pipeViews(added), already: await pipeViews(already), skipped
        });
    } catch (err) { sendErr(res, err); }
});

app.get('/api/leads/pipeline/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;
        if (!S.staffOnly(ctx, res)) return;
        if (!(await pipelineReady())) return pipelineMissing(res);
        const p = await pipeRowFor(ctx, req.params.id, 'viewer');
        if (!p) return res.status(404).json({ error: 'Not found.' });
        const [view] = await pipeViews([p]);
        const { data: notes } = await supabase.from('lead_notes').select('*').eq('pipeline_id', p.id).order('created_at', { ascending: false }).limit(200);
        const authors = [...new Set((notes || []).map(n => n.author_id).filter(Boolean))];
        const { data: us } = authors.length ? await supabase.from('app_users').select('id, email, full_name').in('id', authors) : { data: [] };
        const nm = id => { const u = (us || []).find(x => x.id === id); return u ? (u.full_name || String(u.email || '').split('@')[0]) : null; };
        const { data: lead } = view.lead ? await supabase.from('leads').select('*').eq('id', view.lead.id).maybeSingle() : { data: null };
        res.json({
            row: view, lead: lead ? leadDetailView(lead) : null, stages: PIPE_STAGES[p.kind],
            notes: (notes || []).map(n => ({ id: n.id, body: n.body, auto: !!n.auto, at: n.created_at, author: nm(n.author_id) }))
        });
    } catch (err) { sendErr(res, err); }
});

app.patch('/api/leads/pipeline/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;
        if (!S.staffOnly(ctx, res)) return;
        if (!(await pipelineReady())) return pipelineMissing(res);
        const p = await pipeRowFor(ctx, req.params.id, 'editor');
        if (!p) return res.status(404).json({ error: 'Not found.' });
        const b = req.body || {};
        const patch = { updated_at: new Date().toISOString(), updated_by: ctx.user.id };
        const lines = [];
        if (b.stage !== undefined) {
            if (!PIPE_STAGES[p.kind].some(s => s[0] === b.stage)) return res.status(400).json({ error: 'That stage does not exist for this lead.' });
            if (b.stage !== p.stage) { patch.stage = b.stage; patch.stage_at = patch.updated_at; lines.push(`Moved to ${pipeStageName(p.kind, b.stage)}.`); }
        }
        if (b.assignedTo !== undefined) {
            const to = b.assignedTo === null ? null : (S.UUID_RE.test(String(b.assignedTo)) ? String(b.assignedTo) : undefined);
            if (to === undefined || (to && !(await pipeAssigneeOk(to, p.client_id)))) return res.status(400).json({ error: 'Choose someone on the team who can open that client.' });
            if (to !== p.assigned_to) {
                patch.assigned_to = to;
                const { data: u } = to ? await supabase.from('app_users').select('email, full_name').eq('id', to).maybeSingle() : { data: null };
                lines.push(to ? `Handed to ${u ? (u.full_name || String(u.email || '').split('@')[0]) : 'someone'}.` : 'Unassigned.');
            }
        }
        if (b.followUpOn !== undefined) {
            const d = b.followUpOn === null || b.followUpOn === '' ? null : (/^\d{4}-\d{2}-\d{2}$/.test(String(b.followUpOn)) ? b.followUpOn : undefined);
            if (d === undefined) return res.status(400).json({ error: 'Follow-up must be a date.' });
            if (d !== p.follow_up_on) { patch.follow_up_on = d; lines.push(d ? `Follow up on ${S.docDay(d + 'T00:00:00Z')}.` : 'Follow-up cleared.'); }
        }
        if (b.rate !== undefined) patch.rate = b.rate ? String(b.rate).slice(0, 120) : null;
        if (b.lostReason !== undefined) patch.lost_reason = b.lostReason ? String(b.lostReason).slice(0, 300) : null;
        const { data: row, error } = await supabase.from('lead_pipeline').update(patch).eq('id', p.id).select().maybeSingle();
        if (error) throw error;
        if (lines.length) await pipeNote(p.id, ctx.user.id, lines.join(' '), true);
        if (b.note) await pipeNote(p.id, ctx.user.id, b.note);
        const [view] = await pipeViews([row || { ...p, ...patch }]);
        res.json({ row: view });
    } catch (err) { sendErr(res, err); }
});

app.post('/api/leads/pipeline/:id/notes', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;
        if (!S.staffOnly(ctx, res)) return;
        if (!(await pipelineReady())) return pipelineMissing(res);
        const p = await pipeRowFor(ctx, req.params.id, 'viewer');
        if (!p) return res.status(404).json({ error: 'Not found.' });
        const n = await pipeNote(p.id, ctx.user.id, req.body?.body);
        if (!n) return res.status(400).json({ error: 'Write something first.' });
        await supabase.from('lead_pipeline').update({ updated_at: new Date().toISOString(), updated_by: ctx.user.id }).eq('id', p.id);
        res.status(201).json({ note: { id: n.id, body: n.body, auto: false, at: n.created_at, author: null } });
    } catch (err) { sendErr(res, err); }
});

app.delete('/api/leads/pipeline/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;
        if (!S.staffOnly(ctx, res)) return;
        if (!(await pipelineReady())) return pipelineMissing(res);
        const p = await pipeRowFor(ctx, req.params.id, 'editor');
        if (!p) return res.status(404).json({ error: 'Not found.' });
        await supabase.from('lead_pipeline').delete().eq('id', p.id);
        res.json({ success: true });
    } catch (err) { sendErr(res, err); }
});

/**
 * A first message, written from what this person actually posts. Staff read
 * it, change it and send it themselves: nothing is sent from here, because
 * automated Instagram messages break Meta's rules and get accounts banned.
 */
app.post('/api/leads/pipeline/:id/draft', spendLimit, async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;
        if (!S.staffOnly(ctx, res)) return;
        if (!(await pipelineReady())) return pipelineMissing(res);
        const p = await pipeRowFor(ctx, req.params.id, 'viewer');
        if (!p) return res.status(404).json({ error: 'Not found.' });
        if (!geminiAvailable()) return res.status(503).json({ error: 'No Gemini key is set up, so a draft cannot be written.' });
        const { data: l } = await supabase.from('leads_master').select('*').eq('platform', p.platform).eq('username', p.username).maybeSingle();
        const { data: c } = p.client_id ? await supabase.from('clients').select('name, brand, niche, location, ig_handle').eq('id', p.client_id).maybeSingle() : { data: null };
        const sig = (l && l.signals) || {};
        const facts = {
            to: { handle: '@' + p.username, name: l?.full_name || null, kind: p.kind, followers: l?.followers_count ?? null, category: l?.category || null,
                  bio: l?.bio ? String(l.bio).slice(0, 300) : null, recentCaptions: (sig.captions || []).slice(0, 3), businessesTheyTagged: (sig.venues || []).slice(0, 5) },
            from: c ? { brand: c.brand || c.name, niche: c.niche || null, location: c.location || null, instagram: c.ig_handle ? '@' + c.ig_handle : null } : { brand: 'our agency', offer: 'social media marketing for local businesses' },
            purpose: p.kind === 'influencer' ? 'invite them to a paid or gifted collaboration with the brand' : 'offer a free look at their Instagram and a short call about growing it',
            tone: String(req.body?.tone || 'friendly').slice(0, 30)
        };
        const prompt =
`Write the first direct message to send on Instagram. Facts (JSON):
${JSON.stringify(facts)}

Rules:
- 3 to 5 short sentences. Plain, warm, specific. No hashtags, no emojis beyond one, no "I hope this finds you well".
- Mention ONE specific thing from their recent captions or the businesses they tagged, so it is clearly not a mass message. If there is nothing specific, say what you noticed about their account in general terms instead of inventing a post.
- Say who is writing and why in one sentence. End with one easy question.
- Never promise a fee, a result or numbers. Never claim you saw something not in the facts.
- Write in the language the captions are in (English or Bangla).
Reply with ONLY this JSON: {"message": "..."}`;
        const r = await geminiCallDetailed(prompt, { temperature: 0.7, maxOutputTokens: 800, tag: 'Gemini lead draft', userId: ctx.user.id });
        if (!r.ok || !r.data?.message) return res.status(502).json({ error: aiReasonText(r.reason) || 'The draft could not be written. Try again.' });
        res.json({ message: String(r.data.message).slice(0, 1200) });
    } catch (err) { sendErr(res, err); }
});

/**
 * A won business becomes a client, carrying the handle across, so the audit
 * that won it and the work that follows sit in one place.
 */
app.post('/api/leads/pipeline/:id/convert', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'leadgen'); if (!ctx) return;
        if (!S.staffOnly(ctx, res)) return;
        if (!(await pipelineReady())) return pipelineMissing(res);
        const p = await pipeRowFor(ctx, req.params.id, 'editor');
        if (!p) return res.status(404).json({ error: 'Not found.' });
        if (p.kind !== 'business') return res.status(400).json({ error: 'Only a business becomes a client.' });
        const { data: l } = await supabase.from('leads_master').select('*').eq('platform', p.platform).eq('username', p.username).maybeSingle();
        const name = S.oneLine(req.body?.name || l?.full_name || p.username, 120);
        const row = S.cleanClientBody({
            name, ig_handle: p.platform === 'instagram' ? p.username : undefined,
            fb_page: p.platform === 'facebook' ? (l?.profile_url || p.username) : undefined,
            niche: l?.industry || l?.category || undefined, location: l?.location || l?.city || undefined
        });
        const insert = { owner_user_id: ctx.user.id };
        for (const [k, v] of Object.entries(row)) if (v !== undefined) insert[k] = v;
        const { data: client, error } = await supabase.from('clients').insert([insert]).select().maybeSingle();
        if (error) throw error;
        await supabase.from('lead_pipeline').update({ stage: 'won', stage_at: new Date().toISOString(), updated_at: new Date().toISOString(), updated_by: ctx.user.id }).eq('id', p.id);
        await pipeNote(p.id, ctx.user.id, `Won. Became the client “${client.name}”.`, true);
        const { data: copies } = await supabase.from('leads').select('id').eq('platform', p.platform).eq('username', l?.username || p.username);
        await linkLeadsToClient(client.id, (copies || []).map(x => x.id), 'won', null);
        res.status(201).json({ client: { id: client.id, name: client.name } });
    } catch (err) { sendErr(res, err); }
});
