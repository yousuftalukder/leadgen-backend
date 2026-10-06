/**
 * Facebook groups: scraping, analysis, AI, persistence and the community engines.
 *
 * Part of the EdgeLead server, split out of server.js (phase 55). The parts load in
 * order from server.js and share one namespace, S: what this part needs from an earlier
 * part is unpacked below; anything else from another part is read as S.name when it runs.
 */
'use strict';
const S = require('./shared');
const {
    AI_PROMPT_BUDGET, COST_PER_1K_FB_POSTS, FB_COMMENT_WEIGHT, FB_DEFAULT_DAYS, FB_DEFAULT_POSTS,
    FB_GROUP_POSTS_ACTOR, FB_MAX_GROUPS, FB_MAX_POSTS, FB_SHARE_WEIGHT, FB_TZ_OFFSET_MINS, GEMINI_MODEL,
    JOB_WORKERS, aiReasonText, app, assertJobSlot, auth, budgetSnapshot, budgetedJson, callActor, createJob,
    crypto, fbGroupAiSlim, geminiAvailable, geminiCall, geminiCallDetailed, getWorkingClient, logger,
    requireEngine, runJob, sendErr, spendLimit, supabase
} = S;
Object.assign(S, {
    parseGroupRef, fbPostId, fbText, fbTimestamp, firstNum, fbReactions, fbMediaType, domainOf, localParts,
    classifyIntent, categorize, urgencyOf, mineDemand, lengthBand, openingPattern, topicTags, median,
    computeRoomValue, parseRules, leaderboard, timeHeatmap, computeGroupAudit, buildCommunityBenchmark,
    fbNarrative, fbSavePosts, fbSaveDemand, fbEstimateCredits, fbProcessGroup
});

// ===========================================================================
// ===========================================================================
//  FACEBOOK COMMUNITY ENGINE
//  Engine key: 'fb_community'.  Job types: 'fb_discovery' | 'fb_community_audit'
//  | 'fb_verify'.  Reuses jobs, reports, /api/job/:id polling and the Apify
//  key pool verbatim — no parallel infrastructure.
// ===========================================================================
// ===========================================================================

// (crypto is required once at the top of the file)

// ---------------------------------------------------------------------------
// IDENTITY HANDLING
// Facebook group members have a far stronger privacy expectation than public
// Instagram business accounts, and several target regions treat storing names
// without a lawful basis as a real problem. We keep the content and hash the
// person. To act on a lead the user clicks through to the live post.
// ---------------------------------------------------------------------------
const FB_HASH_SALT = process.env.FB_HASH_SALT || 'edgelead-fb-default-salt-change-me';

function authorHash(name, groupId) {
    const raw = String(name || 'anonymous').trim().toLowerCase() + '::' + String(groupId || '');
    return crypto.createHmac('sha256', FB_HASH_SALT).update(raw).digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// URL / ID PARSING
// ---------------------------------------------------------------------------
function parseGroupRef(input) {
    const s = String(input || '').trim();
    if (!s) return null;
    const m = s.match(/facebook\.com\/groups\/([^/?#\s]+)/i);
    const id = m ? m[1] : s.replace(/^@/, '').replace(/\/+$/, '');
    if (!id || /\s/.test(id)) return null;
    return { groupId: id, url: `https://www.facebook.com/groups/${id}/` };
}

function fbPostId(p) {
    return String(
        p.postId || p.post_id || p.id || p.legacyId ||
        (p.url || p.postUrl || p.topLevelUrl || '').match(/(?:posts|permalink|multi_permalink)\/(\d+)/)?.[1] ||
        (p.url || '').split('?')[0].replace(/\/+$/, '').split('/').pop() || ''
    ).trim();
}

function fbPostUrl(p, groupId) {
    return p.url || p.postUrl || p.topLevelUrl ||
        (fbPostId(p) ? `https://www.facebook.com/groups/${groupId}/posts/${fbPostId(p)}/` : null);
}

function fbText(p) {
    return String(p.text || p.message || p.content || p.postText || p.caption || '').trim();
}

function fbTimestamp(p) {
    const raw = p.time || p.timestamp || p.date || p.publishedAt || p.postedAt || p.createdAt || null;
    if (!raw) return null;
    const d = typeof raw === 'number'
        ? new Date(raw * (raw > 1e12 ? 1 : 1000))
        : new Date(raw);
    return isNaN(d.getTime()) ? null : d;
}

function firstNum(...vals) {
    for (const v of vals) {
        if (v === null || v === undefined) continue;
        const n = typeof v === 'string' ? parseInt(v.replace(/[^\d]/g, ''), 10) : Number(v);
        if (!isNaN(n)) return n;
    }
    return 0;
}

function fbReactions(p) {
    if (!p || typeof p !== 'object') return { total: 0, breakdown: null };
    const b = p.reactions || p.reactionsCount || p.reactionCount || {};
    if (typeof b === 'object' && !Array.isArray(b)) {
        const sum = Object.values(b).reduce((s, v) => s + (Number(v) || 0), 0);
        if (sum > 0) return { total: sum, breakdown: b };
    }
    const total = firstNum(p.likesCount, p.likes, p.reactionsCount, p.reactionCount, b);
    const breakdown = p.reactionsBreakdown || p.reactionsByType || null;
    return { total, breakdown: breakdown || null };
}

function fbMediaType(p) {
    // Actors do occasionally emit a null row in the middle of a dataset.
    // Throwing here killed the whole job after the scrape had already billed.
    if (!p || typeof p !== 'object') return { type: 'text', link: null };
    const attach = p.attachments || p.media || [];
    const arr = Array.isArray(attach) ? attach : [attach];
    const link = p.link || p.linkUrl || p.externalUrl ||
        arr.find(a => a && (a.url || a.link) && /^https?:/.test(a.url || a.link))?.url;

    if (p.poll || p.pollOptions || /\bpoll\b/i.test(p.type || '')) return { type: 'poll', link: null };
    if (p.videoUrl || p.video || /video/i.test(p.type || '') || arr.some(a => a && /video/i.test(a.type || ''))) {
        return { type: 'video', link: link || null };
    }
    const imgs = arr.filter(a => a && (/photo|image/i.test(a.type || '') || a.image || a.thumbnail || a.photo));
    if (imgs.length > 1 || (Array.isArray(p.images) && p.images.length > 1)) return { type: 'album', link: link || null };
    if (imgs.length === 1 || p.imageUrl || p.thumbnailUrl || (Array.isArray(p.images) && p.images.length === 1)) {
        return { type: 'photo', link: link || null };
    }
    if (link && !/facebook\.com/i.test(link)) return { type: 'link', link };
    return { type: 'text', link: null };
}

function domainOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

// Local-time bucketing. Facebook returns UTC; local groups behave on local clocks.
function localParts(date, offsetMins = FB_TZ_OFFSET_MINS) {
    if (!date) return { hour: null, dow: null };
    const shifted = new Date(date.getTime() + offsetMins * 60000);
    return { hour: shifted.getUTCHours(), dow: shifted.getUTCDay() };
}

// ---------------------------------------------------------------------------
// INTENT CLASSIFICATION
// Ordered by specificity. First rule that matches wins, so put the
// commercially interesting intents above the generic ones.
// English + Bangla, because the first target markets are bilingual.
// ---------------------------------------------------------------------------
const FB_INTENT_RULES = [
    {
        intent: 'recommendation_request',
        re: [
            /\b(anyone know|any ?one knows?|does anybody|does anyone|can anyone (recommend|suggest)|looking for|in search of|need (a|an|some|someone|help)|where can i (find|get|buy)|who does|any good|recommend(ations?)?|suggest (me|a|any|some)|referrals?)\b/i,
            /(কেউ কি জানেন|কেউ জানেন|খুঁজছি|খুজছি|দরকার|প্রয়োজন|কোথায় পাবো|কোথায় পাব|সাজেস্ট|রেফার|ভালো কোন)/
        ]
    },
    {
        intent: 'hiring',
        re: [/\b(hiring|we are hiring|job (opening|vacancy|post)|vacancy|apply now|cv (to|at)|recruit(ing|ment)|freelancer needed|developer needed)\b/i,
             /(নিয়োগ|চাকরি|লোক নিব|কর্মী নিয়োগ)/]
    },
    {
        intent: 'buy_sell',
        re: [/\b(for sale|selling|sell my|price is|negotiable|brand new|used|fixed price|cod\b|delivery charge|only serious buyer|urgent sale)\b/i,
             /(বিক্রি|বিক্রয়|দাম|মূল্য|নিতে চাইলে)/]
    },
    {
        intent: 'offer',
        re: [/\b(we offer|our service|our shop|contact us|dm me|inbox (me|please)|book now|order now|call now|whatsapp|discount|special offer|limited time|free delivery|visit our)\b/i,
             /(আমাদের|অর্ডার করুন|ইনবক্স|যোগাযোগ|ডিসকাউন্ট|অফার)/]
    },
    {
        intent: 'event',
        re: [/\b(event|meetup|workshop|seminar|webinar|rsvp|join us (on|this)|happening (on|this)|save the date|registration (open|link))\b/i,
             /(ইভেন্ট|আয়োজন|অনুষ্ঠান|রেজিস্ট্রেশন)/]
    },
    {
        intent: 'complaint',
        re: [/\b(worst|scam|scammer|fraud|beware|warning|cheated|ripped off|terrible service|never (go|buy|order)|do not (buy|trust)|avoid this)\b/i,
             /(প্রতারক|প্রতারণা|ঠকাইছে|সাবধান|খারাপ অভিজ্ঞতা)/]
    },
    {
        intent: 'question',
        re: [/\?\s*$/, /^(how|what|where|when|why|which|who|is there|are there|can i|should i|do you|has anyone|anybody)\b/i,
             /(কি|কেন|কিভাবে|কীভাবে)\s*\?/]
    },
    {
        intent: 'story',
        re: [/\b(i (just|finally|recently)|today i|so happy|update:|thank you (all|everyone)|grateful|my experience)\b/i,
             /(ধন্যবাদ|আজকে|অভিজ্ঞতা)/]
    }
];

function classifyIntent(text) {
    const t = String(text || '');
    if (!t) return 'unknown';
    for (const rule of FB_INTENT_RULES) {
        if (rule.re.some(r => r.test(t))) return rule.intent;
    }
    return 'discussion';
}

// ---------------------------------------------------------------------------
// DEMAND MINING
// This is the lead feed. Every match is a person in a specific room saying
// out loud that they want to buy something. Instagram cannot produce this.
// ---------------------------------------------------------------------------
const FB_DEMAND_PATTERNS = [
    { phrase: 'looking for',        re: /\blooking for\b/i,                                weight: 10 },
    { phrase: 'does anyone know',   re: /\b(does |do )?any ?(one|body) (know|have|recommend)\b/i, weight: 10 },
    { phrase: 'can anyone recommend', re: /\bcan any ?(one|body) (recommend|suggest)\b/i,  weight: 10 },
    { phrase: 'recommend a',        re: /\brecommend(ation)?s? (a|an|any|for|me)\b/i,      weight: 9  },
    { phrase: 'need someone who',   re: /\bneed (someone|somebody|a person|a guy|help) (who|that|to|for)?\b/i, weight: 10 },
    { phrase: 'need a',             re: /\bneed (a|an|some)\b/i,                           weight: 7  },
    { phrase: 'where can i get',    re: /\bwhere can i (get|find|buy|order)\b/i,            weight: 9  },
    { phrase: 'suggest me',         re: /\bsuggest (me|a|any|some|good)\b/i,                weight: 8  },
    { phrase: 'any good',           re: /\bany good\b/i,                                   weight: 7  },
    { phrase: 'in search of',       re: /\bin search of\b/i,                               weight: 9  },
    { phrase: 'who can help',       re: /\bwho can (help|do|fix|make|build)\b/i,            weight: 9  },
    { phrase: 'best place for',     re: /\bbest (place|shop|service|option) (for|to|in)\b/i, weight: 8 },
    { phrase: 'is available',       re: /\bis (there )?any(one|body|thing)? available\b/i,  weight: 6  },
    { phrase: 'hiring',             re: /\b(hiring|urgently need|freelancer needed|needed urgently)\b/i, weight: 9 },
    { phrase: 'খুঁজছি',              re: /(খুঁজছি|খুজছি|খুঁজতেছি)/,                            weight: 10 },
    { phrase: 'দরকার',               re: /(দরকার|প্রয়োজন|লাগবে)/,                             weight: 9  },
    { phrase: 'কেউ কি জানেন',        re: /(কেউ (কি )?জানেন|কেউ (কি )?আছেন)/,                  weight: 10 },
    { phrase: 'কোথায় পাবো',          re: /(কোথায় পাবো|কোথায় পাব|কোথায় পাওয়া যাবে)/,          weight: 9  },
    { phrase: 'সাজেস্ট করুন',         re: /(সাজেস্ট|রেফার) ?(করুন|করবেন|দিন)?/,                 weight: 8  }
];

const FB_CATEGORY_MAP = [
    ['home_services', /\b(plumb\w*|electric\w*|carpenter|painter|mason|ac (repair|servicing)|appliance|cleaning service|pest control|mistri|renovat\w*|interior)\b|(মিস্ত্রি|রঙ|প্লাম্বার|ইলেকট্রিশিয়ান)/i],
    ['auto',          /\b(car|bike|motorcycle|mechanic|garage|tyre|tire|servicing|driver|rent a car|cng)\b|(গাড়ি|বাইক|ড্রাইভার)/i],
    ['real_estate',   /\b(flat|apartment|house for rent|to ?let|sublet|land|plot|rent(al)?|room available|hostel|mess)\b|(বাসা|ফ্ল্যাট|ভাড়া|জমি)/i],
    ['food',          /\b(restaurant|cafe|catering|cake|biryani|iftar|homemade|tiffin|bakery|food delivery)\b|(খাবার|রেস্টুরেন্ট|কেক|বিরিয়ানি)/i],
    ['health',        /\b(doctor|clinic|hospital|dentist|physio|therapist|medicine|pharmacy|diagnostic|nurse|caregiver)\b|(ডাক্তার|হাসপাতাল|ঔষধ)/i],
    ['education',     /\b(tutor|coaching|admission|ielts|course|training|teacher|batch|home tuition)\b|(টিউটর|কোচিং|ভর্তি)/i],
    ['tech',          /\b(website|web ?dev|app develop\w*|software|laptop|pc build|it support|hosting|domain|seo|graphic design\w*|logo)\b|(ওয়েবসাইট|সফটওয়্যার|ল্যাপটপ)/i],
    ['beauty',        /\b(salon|parlour|parlor|makeup|bridal|haircut|spa|skincare)\b|(পার্লার|মেকআপ)/i],
    ['events',        /\b(photographer|videographer|decorator|event manage\w*|wedding|birthday party|sound system|stage)\b|(ফটোগ্রাফার|ডেকোরেশন|বিয়ে)/i],
    ['legal_finance', /\b(lawyer|advocate|accountant|tax|audit|insurance|loan|notary|trade licen[cs]e)\b|(উকিল|আইনজীবী|ট্যাক্স)/i],
    ['logistics',     /\b(courier|delivery|shifting|movers|truck|transport|shipping)\b|(কুরিয়ার|ট্রাক|শিফটিং)/i],
    ['jobs',          /\b(job|vacancy|hiring|cv|resume|intern|part ?time|full ?time)\b|(চাকরি|নিয়োগ)/i]
];

function categorize(text) {
    for (const [cat, re] of FB_CATEGORY_MAP) if (re.test(text)) return cat;
    return 'other';
}

const FB_URGENT_HIGH = /\b(urgent(ly)?|asap|immediately|emergency|today|tonight|tomorrow|right now|within (a|an|24|48))\b|(জরুরি|জরুরী|আজকে|এখনই|কালকের মধ্যে)/i;
const FB_URGENT_MED  = /\b(this week|by (friday|saturday|sunday|monday)|soon|next week|within a week)\b|(এই সপ্তাহে|শীঘ্রই)/i;

function urgencyOf(text) {
    if (FB_URGENT_HIGH.test(text)) return 'high';
    if (FB_URGENT_MED.test(text))  return 'medium';
    return 'low';
}

/**
 * Pulls buying intent out of one post. Returns [] for most posts, which is
 * correct — a room where every post is a demand signal is a room of spam.
 */
/**
 * Is this the seller talking, not the buyer? A vendor advert routinely
 * contains "looking for a reliable plumber?" as a hook, which is why the
 * demand patterns alone let ads into the lead feed. Any two vendor cues, or
 * one hard cue (phone number, "our services include"), and the post is not
 * demand — it is competition.
 */
const FB_VENDOR_HARD = [
    /\b(our services? (include|are)|services? (we )?(offer|provide)|we (offer|provide|specialise|specialize|install|repair|deliver)|we are (a|an|the) (team|company|business))\b/i,
    /\b(book (now|today|your)|order now|call (us|now|today)|dm (us|me) for (price|rate|details|order)|inbox (us|me) for)\b/i,
    /(\+?880|\b0?1[3-9]\d{8}\b|\(\d{3}\) ?\d{3}-\d{4}|\b\d{3}[-. ]\d{3}[-. ]\d{4}\b)/,          // phone numbers, BD + US forms
    /(কল করুন|অর্ডার করুন|ইনবক্স করুন|আমাদের সার্ভিস|আমরা দিচ্ছি|হোম ডেলিভারি)/
];
const FB_VENDOR_SOFT = [
    /\b(llc|ltd|inc|co\.|pvt|enterprise|solutions|services)\b/i,
    /\b(free (quote|estimate|consultation)|licensed|insured|years? of experience|satisfaction guaranteed|affordable|best price|special offer|discount)\b/i,
    /\b(whatsapp|contact us|visit (our|us)|website|www\.|http)\b/i,
    /\b(price|rate|tk|৳|\$)\s*\d/i,
    /(\p{Extended_Pictographic}[^\p{Extended_Pictographic}\n]{2,40}){5,}/u   // emoji-bulleted service list
];

function looksLikeVendor(text) {
    const t = String(text || '');
    if (FB_VENDOR_HARD.some(re => re.test(t))) return true;
    return FB_VENDOR_SOFT.filter(re => re.test(t)).length >= 2;
}

function mineDemand(text, ctx = {}) {
    const t = String(text || '');
    if (t.length < 12) return [];

    const hits = FB_DEMAND_PATTERNS.filter(p => p.re.test(t));
    if (!hits.length) return [];
    if (looksLikeVendor(t)) return [];

    // One signal per post, built from the strongest phrase. Multiple rows for
    // the same post would inflate the feed and double-count the same lead.
    const best = hits.sort((a, b) => b.weight - a.weight)[0];
    const urgency = urgencyOf(t);
    const category = categorize(t);
    const engagement = ctx.engagement || 0;

    const urgencyBoost = urgency === 'high' ? 25 : urgency === 'medium' ? 12 : 0;
    const specificity  = Math.min(15, Math.floor(t.length / 40));
    const heat         = Math.min(20, Math.round(engagement / 3));
    const categoryBoost = category === 'other' ? 0 : 10;
    const recency = ctx.postedAt
        ? Math.max(0, 20 - Math.floor((Date.now() - new Date(ctx.postedAt).getTime()) / 86400000))
        : 0;

    const score = Math.min(100,
        best.weight * 2 + urgencyBoost + specificity + heat + categoryBoost + recency);

    return [{
        matched_phrase: best.phrase,
        snippet: t.slice(0, 600),
        intent: hits.some(h => /hiring/.test(h.phrase)) ? 'hiring' : 'recommendation_request',
        category,
        urgency,
        lead_score: score
    }];
}

// ---------------------------------------------------------------------------
// POST SHAPE ANALYSIS
// ---------------------------------------------------------------------------
function lengthBand(words) {
    if (words < 40)  return 'short (<40w)';
    if (words < 120) return 'medium (40-120w)';
    return 'long (120w+)';
}

function openingPattern(text) {
    const t = String(text || '').trim();
    if (!t) return 'empty';
    const first = t.split(/[\n.!?]/)[0].trim();
    if (/^[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u.test(first)) return 'emoji';
    if (/^(who|what|where|when|why|how|which|is|are|can|does|do|any|has)\b/i.test(first)) return 'question';
    if (/\?$/.test(first)) return 'question';
    if (/^\d/.test(first)) return 'number';
    // Greeting is checked BEFORE location/name. "Hi everyone," satisfies both,
    // and the location rule used to win, quietly filing every greeting-opener
    // under location/name and skewing the opening-pattern leaderboard.
    if (/^(hi|hello|hey|assalamu|salam|dear|friends|guys|everyone)\b/i.test(first)) return 'greeting';
    if (/^[A-Z\u0980-\u09FF][\w\u0980-\u09FF' ]{2,24},/.test(first)) return 'location/name';
    if (first.length < 45 && !/\s/.test(first.slice(-1))) return 'short hook';
    return 'statement';
}

const FB_STOPWORDS = new Set(('a an the and or but if of to in on for with at by from is are was were be been am i you he she it we they my your our their this that these those not no yes do does did have has had will would can could should there here what when where who whom which how why all any some more most other so than too very just about also as into over after before out up down off again once now new please thank thanks help need want get got make made take like know good best hi hello hey dm inbox').split(' '));

function topicTags(text, limit = 6) {
    const words = String(text || '').toLowerCase()
        .replace(/https?:\/\/\S+/g, ' ')
        .match(/[\p{L}][\p{L}\p{N}'-]{2,}/gu) || [];
    const freq = {};
    words.forEach(w => { if (!FB_STOPWORDS.has(w) && w.length > 3) freq[w] = (freq[w] || 0) + 1; });
    return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, limit).map(e => e[0]);
}

// ---------------------------------------------------------------------------
// ROOM VALUE
// A 200k-member group with 4 posts a day is dead. A 6k-member group with 40
// posts a day is where business happens. Member count is a tiebreaker here,
// never a driver.
// ---------------------------------------------------------------------------
function median(nums) {
    const a = nums.filter(n => typeof n === 'number' && !isNaN(n)).sort((x, y) => x - y);
    if (!a.length) return 0;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function computeRoomValue(stats) {
    const {
        postsPerDay = 0, medianComments = 0, uniquePosterRatio = 0,
        promoAllowed = true, approvalRequired = false, memberCount = 0,
        demandRate = 0
    } = stats;

    const sampleSize = stats.sampleSize || 0;

    const liveness  = Math.min(1, postsPerDay / 15);       // 15+/day saturates
    const conversation = Math.min(1, medianComments / 10); // 10+ median comments saturates
    const diversity = Math.max(0, Math.min(1, uniquePosterRatio));
    const demand    = Math.min(1, demandRate * 5);         // 20% of posts asking = saturated

    // Posting permission discounts the value of POSTING into the room. It does
    // not discount the demand feed: a group that bans ads still tells you who
    // wants to buy, and answering a request in-thread is allowed everywhere.
    let permission = promoAllowed ? 1 : 0.75;
    if (approvalRequired) permission *= 0.75;

    const postingValue = (0.28 * liveness) + (0.30 * conversation) + (0.22 * diversity);
    const demandValue  = 0.20 * demand;

    // Confidence damping. Twelve posts is not enough to call a room, and a
    // thin sample scoring 58 next to a thick sample scoring 28 is a lie.
    const confidence = sampleSize === 0 ? 1 : Math.min(1, 0.55 + (sampleSize / 40) * 0.45);

    const sizeTiebreak = memberCount > 0 ? Math.min(5, Math.log10(memberCount)) : 0;
    const raw = (postingValue * permission + demandValue) * 100 * confidence + sizeTiebreak;
    const score = Math.round(Math.min(100, raw));

    return {
        score,
        breakdown: {
            liveness: +liveness.toFixed(2),
            conversation: +conversation.toFixed(2),
            diversity: +diversity.toFixed(2),
            demand: +demand.toFixed(2),
            permission: +permission.toFixed(2),
            confidence: +confidence.toFixed(2),
            sampleSize,
            sizeTiebreak: +sizeTiebreak.toFixed(2),
            lowConfidence: sampleSize > 0 && sampleSize < 15,
            verdict: (sampleSize > 0 && sampleSize < 15)
                   ? `Not enough data (${sampleSize} posts) — treat as provisional`
                   : score >= 70 ? 'Prime room'
                   : score >= 50 ? 'Worth working'
                   : score >= 30 ? 'Marginal'
                   : 'Dead room — skip it'
        }
    };
}

// ---------------------------------------------------------------------------
// RULES PARSING — the compliance gate depends on this being right
// ---------------------------------------------------------------------------
const FB_PROMO_BAN = /\b(no (promo\w*|advertis\w*|selling|sales|business posts?|spam|self ?promo\w*)|promo\w* (is )?not allowed|advertis\w* (is )?(not allowed|prohibited|banned)|do not (advertise|promote|sell)|strictly no (ads|selling|promo\w*))\b|(প্রচার নিষেধ|বিজ্ঞাপন নিষিদ্ধ|প্রমোশন নিষেধ)/i;
const FB_APPROVAL   = /\b(posts? (are|will be|must be) (approved|reviewed)|admin approval|approval (required|queue)|moderated group|all posts? go through)\b|(অনুমোদন|এডমিন অনুমোদন)/i;

function parseRules(rulesText) {
    const t = String(rulesText || '');
    return {
        promo_allowed: !FB_PROMO_BAN.test(t),
        approval_required: FB_APPROVAL.test(t),
        rules_text: t.slice(0, 4000) || null
    };
}

// ===========================================================================
// FB SCRAPE LAYER
// ===========================================================================

/**
 * Pulls posts for one public group. Returns normalised rows, not raw Apify.
 * Private groups are deliberately not supported: they need a logged-in
 * session, which is both a TOS violation and an account-ban risk.
 */
async function fbScrapeGroup(client, groupRef, opts = {}) {
    const { groupId, url } = groupRef;
    const limit = Math.min(opts.limit || FB_DEFAULT_POSTS, FB_MAX_POSTS);
    const days = opts.days || FB_DEFAULT_DAYS;

    // The window boundary is frozen at job creation and passed in. Recomputing
    // it from Date.now() would mean a job paused Monday and resumed Thursday
    // measures its groups over different periods, which silently corrupts every
    // cross-group comparison in the benchmark.
    const onlyPostsNewerThan = opts.since ||
        new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

    const wantComments = !!opts.sampleComments && (opts.commentPosts == null || opts.commentPosts > 0);
    const actorInput = {
        startUrls: [{ url }],
        resultsLimit: limit,
        maxPosts: limit,
        onlyPostsNewerThan
    };
    if (wantComments) {
        actorInput.commentsMode = 'RANKED_THREADED';
        actorInput.maxComments = 10;
        actorInput.scrapeComments = true;
    }

    const { items } = await callActor(client, FB_GROUP_POSTS_ACTOR, actorInput, {
        maxItems: limit,
        jobId: opts.jobId,
        estimateUsd: fbEstimateCredits(1, limit, opts.sampleComments, opts.commentPosts)
    });

    const raw = items || [];
    // What the actor actually returned is the only thing that explains a
    // zero-post room, so it is logged every time, not just on failure.
    logger.info('fb_group_scraped', {
        groupId, count: raw.length, wantComments,
        keys: Object.keys(raw[0] || {}).slice(0, 30)
    });

    return { raw, groupId, url };
}

/** Group-level metadata, harvested from whatever the post payload carries. */
function fbGroupMeta(rawItems, groupRef) {
    const first = (rawItems || []).find(i => i && (i.groupTitle || i.groupName || i.group)) || {};
    const g = first.group || {};
    const rules = first.groupRules || g.rules || first.rules || '';
    const rulesText = Array.isArray(rules)
        ? rules.map(r => (typeof r === 'string' ? r : `${r.title || ''} ${r.description || ''}`)).join('\n')
        : String(rules || '');

    const privacyRaw = String(first.groupPrivacy || g.privacy || first.privacy || 'public').toLowerCase();

    const memberCount = firstNum(
        first.groupMembersCount, first.groupMemberCount, first.membersCount, first.memberCount,
        g.memberCount, g.membersCount, g.members, groupRef.hintMembers, 0
    );
    const hasPrivacy = !!(first.groupPrivacy || g.privacy || first.privacy);

    return {
        group_id: groupRef.groupId,
        name: first.groupTitle || first.groupName || g.name || groupRef.hintName || groupRef.name || groupRef.groupId,
        url: groupRef.url,
        member_count: memberCount,
        privacy: privacyRaw.includes('private') || privacyRaw.includes('closed') ? 'private' : 'public',
        privacy_known: hasPrivacy,
        rules_known: !!rulesText,
        ...parseRules(rulesText)
    };
}

/** Raw Apify item -> the shape fb_posts stores. */
function fbNormalisePost(item, groupId, groupRowId, userId) {
    const postId = fbPostId(item);
    if (!postId) return null;

    const text = fbText(item);
    const d = fbTimestamp(item);
    const { total: reactions, breakdown } = fbReactions(item);
    const comments = firstNum(item.commentsCount, item.comments?.length, item.commentCount);
    const shares = firstNum(item.sharesCount, item.shareCount, item.shares);
    const media = fbMediaType(item);
    const { hour, dow } = localParts(d);
    const words = text ? text.split(/\s+/).length : 0;

    const authorName = item.user?.name || item.author?.name || item.authorName || item.ownerName || null;
    const isAdmin = !!(item.isAdmin || item.authorIsAdmin || /admin|moderator/i.test(item.authorRole || ''));

    const engagement = reactions + (FB_COMMENT_WEIGHT * comments) + (FB_SHARE_WEIGHT * shares);
    const ageHours = d ? (Date.now() - d.getTime()) / 3600000 : 999;

    return {
        user_id: userId,
        group_id: groupId,
        group_row_id: groupRowId || null,
        post_id: postId,
        post_url: fbPostUrl(item, groupId),
        author_hash: authorHash(authorName, groupId),
        author_label: isAdmin ? 'admin' : 'member',
        author_is_admin: isAdmin,
        content: text.slice(0, 6000),
        content_length: text.length,
        media_type: media.type,
        link_url: media.link || null,
        link_domain: media.link ? domainOf(media.link) : null,
        reactions_total: reactions,
        reactions_breakdown: breakdown,
        comments,
        shares,
        posted_at: d ? d.toISOString() : null,
        hour_local: hour,
        dow_local: dow,
        engagement_raw: engagement,
        performance_index: null,          // filled by the normalisation pass
        intent_type: classifyIntent(text),
        topic_tags: topicTags(text),
        opening_pattern: openingPattern(text),
        length_band: lengthBand(words),
        is_provisional: ageHours < 24,    // FB counts are still settling under 24h
        raw: { keys: Object.keys(item || {}).slice(0, 40) }
    };
}

/**
 * NORMALISATION PASS.
 * Raw counts lie because groups differ in size. Everything is indexed against
 * that group's own median for that month, so an index of 3.0 means "three
 * times what this room normally does" and is directly comparable between a
 * 5k group and a 50k group.
 */
function fbIndexPosts(rows) {
    const buckets = {};
    rows.forEach(r => {
        const month = (r.posted_at || '').slice(0, 7) || 'unknown';
        const key = `${r.group_id}::${month}`;
        (buckets[key] = buckets[key] || []).push(r);
    });

    const baselines = {};
    Object.entries(buckets).forEach(([key, group]) => {
        // Provisional posts are excluded from the baseline so half-counted
        // fresh posts cannot drag the median down.
        const settled = group.filter(r => !r.is_provisional);
        const pool = settled.length >= 5 ? settled : group;
        const med = median(pool.map(r => r.engagement_raw));
        baselines[key] = med > 0 ? med : 1;
    });

    rows.forEach(r => {
        const month = (r.posted_at || '').slice(0, 7) || 'unknown';
        const base = baselines[`${r.group_id}::${month}`] || 1;
        r.performance_index = +(r.engagement_raw / base).toFixed(3);
    });

    return { rows, baselines };
}

// ===========================================================================
// FB ANALYSIS LAYER
// ===========================================================================

function leaderboard(rows, dimension, minCount = 2) {
    const agg = {};
    rows.forEach(r => {
        const k = r[dimension] || 'unknown';
        agg[k] = agg[k] || { key: k, count: 0, indexSum: 0, engagementSum: 0, commentSum: 0 };
        agg[k].count++;
        agg[k].indexSum += r.performance_index || 0;
        agg[k].engagementSum += r.engagement_raw || 0;
        agg[k].commentSum += r.comments || 0;
    });

    return Object.values(agg)
        .filter(a => a.count >= Math.min(minCount, rows.length))
        .map(a => ({
            key: a.key,
            posts: a.count,
            share: ((a.count / rows.length) * 100).toFixed(1) + '%',
            avgIndex: +(a.indexSum / a.count).toFixed(2),
            avgEngagement: Math.round(a.engagementSum / a.count),
            avgComments: Math.round(a.commentSum / a.count)
        }))
        .sort((x, y) => y.avgIndex - x.avgIndex);
}

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
S.DOW_NAMES = DOW_NAMES;

function timeHeatmap(rows) {
    const cells = {};
    rows.forEach(r => {
        if (r.hour_local === null || r.dow_local === null) return;
        const k = `${r.dow_local}:${r.hour_local}`;
        cells[k] = cells[k] || { dow: r.dow_local, hour: r.hour_local, posts: 0, indexSum: 0 };
        cells[k].posts++;
        cells[k].indexSum += r.performance_index || 0;
    });

    const flat = Object.values(cells).map(c => ({
        dow: c.dow, dowName: DOW_NAMES[c.dow], hour: c.hour,
        posts: c.posts, avgIndex: +(c.indexSum / c.posts).toFixed(2)
    }));

    const byHour = {}, byDay = {};
    rows.forEach(r => {
        if (r.hour_local !== null) {
            byHour[r.hour_local] = byHour[r.hour_local] || { posts: 0, indexSum: 0 };
            byHour[r.hour_local].posts++; byHour[r.hour_local].indexSum += r.performance_index || 0;
        }
        if (r.dow_local !== null) {
            byDay[r.dow_local] = byDay[r.dow_local] || { posts: 0, indexSum: 0 };
            byDay[r.dow_local].posts++; byDay[r.dow_local].indexSum += r.performance_index || 0;
        }
    });

    const hourRank = Object.entries(byHour)
        .map(([h, v]) => ({ hour: +h, posts: v.posts, avgIndex: +(v.indexSum / v.posts).toFixed(2) }))
        .filter(h => h.posts >= 2)
        .sort((a, b) => b.avgIndex - a.avgIndex);

    const dayRank = Object.entries(byDay)
        .map(([d, v]) => ({ dow: +d, dowName: DOW_NAMES[+d], posts: v.posts, avgIndex: +(v.indexSum / v.posts).toFixed(2) }))
        .sort((a, b) => b.avgIndex - a.avgIndex);

    return { cells: flat, bestHours: hourRank.slice(0, 5), worstHours: hourRank.slice(-3).reverse(), bestDays: dayRank };
}

/** Everything the audit knows about one room. */
function computeGroupAudit(groupMeta, rows, demandRows) {
    const posts = rows.length;

    if (!posts) {
        return {
            groupId: groupMeta.group_id,
            name: groupMeta.name,
            url: groupMeta.url,
            memberCount: groupMeta.member_count,
            postsAnalyzed: 0,
            roomValue: 0,
            roomValueBreakdown: { verdict: 'No posts returned — group may be private, empty, or blocked.' },
            formats: [], intents: [], openings: [], lengths: [],
            heatmap: { cells: [], bestHours: [], bestDays: [] },
            topPosts: [], bottomPosts: [], demandKeywords: [], demandSignals: 0,
            whatWorks: ['No public posts were returned for this group. Confirm the group is public and the URL is correct.']
        };
    }

    const stamps = rows.map(r => r.posted_at ? new Date(r.posted_at).getTime() : null).filter(Boolean).sort((a, b) => a - b);
    const spanDays = stamps.length > 1 ? Math.max(1, (stamps[stamps.length - 1] - stamps[0]) / 86400000) : 1;
    const postsPerDay = +(posts / spanDays).toFixed(1);

    const uniquePosters = new Set(rows.map(r => r.author_hash)).size;
    const uniquePosterRatio = +(uniquePosters / posts).toFixed(2);
    const medianComments = median(rows.map(r => r.comments));
    const medianReactions = median(rows.map(r => r.reactions_total));
    const demandRate = posts ? demandRows.length / posts : 0;

    const rv = computeRoomValue({
        postsPerDay, medianComments, uniquePosterRatio,
        promoAllowed: groupMeta.promo_allowed,
        approvalRequired: groupMeta.approval_required,
        memberCount: groupMeta.member_count,
        demandRate,
        sampleSize: posts
    });

    const sorted = [...rows].sort((a, b) => (b.performance_index || 0) - (a.performance_index || 0));
    const slim = r => ({
        postId: r.post_id, url: r.post_url,
        excerpt: (r.content || '').slice(0, 220),
        format: r.media_type, intent: r.intent_type,
        opening: r.opening_pattern, lengthBand: r.length_band,
        reactions: r.reactions_total, comments: r.comments, shares: r.shares,
        index: r.performance_index, postedAt: r.posted_at,
        hour: r.hour_local, dowName: r.dow_local !== null ? DOW_NAMES[r.dow_local] : null,
        byAdmin: r.author_is_admin, provisional: r.is_provisional
    });

    const formats = leaderboard(rows, 'media_type');
    const intents = leaderboard(rows, 'intent_type');
    const openings = leaderboard(rows, 'opening_pattern');
    const lengths = leaderboard(rows, 'length_band');
    const heatmap = timeHeatmap(rows);

    // Demand keywords, from the demand rows only — this is what the room is
    // actively shopping for, not what it happens to talk about.
    const kw = {};
    demandRows.forEach(d => topicTags(d.snippet, 8).forEach(t => { kw[t] = (kw[t] || 0) + 1; }));
    const demandKeywords = Object.entries(kw).sort((a, b) => b[1] - a[1]).slice(0, 20)
        .map(([term, hits]) => ({ term, hits }));

    const demandCategories = {};
    demandRows.forEach(d => { demandCategories[d.category] = (demandCategories[d.category] || 0) + 1; });

    const whatWorks = [];
    if (formats[0]) whatWorks.push(`${formats[0].key} posts run at ${formats[0].avgIndex}x this room's median — the strongest format here across ${formats[0].posts} posts.`);
    if (formats.length > 1) {
        const worst = formats[formats.length - 1];
        whatWorks.push(`${worst.key} posts run at ${worst.avgIndex}x. ${worst.avgIndex < 0.8 ? 'This room suppresses them — avoid.' : 'Usable but not your first choice.'}`);
    }
    if (intents[0]) whatWorks.push(`Posts that ${intents[0].key.replace(/_/g, ' ')} perform at ${intents[0].avgIndex}x. In this room, ${intents[0].key === 'recommendation_request' || intents[0].key === 'question' ? 'asking beats telling.' : 'that is what earns attention.'}`);
    if (heatmap.bestHours[0]) whatWorks.push(`Best posting window is ${String(heatmap.bestHours[0].hour).padStart(2, '0')}:00 local (${heatmap.bestHours[0].avgIndex}x across ${heatmap.bestHours[0].posts} posts)${heatmap.bestDays[0] ? `, strongest on ${heatmap.bestDays[0].dowName}` : ''}.`);
    if (lengths[0]) whatWorks.push(`${lengths[0].key} posts index highest at ${lengths[0].avgIndex}x.`);
    if (!groupMeta.promo_allowed) whatWorks.push('This group bans promotion. Every draft the advisor produces here is locked to value-first or question format.');
    if (groupMeta.approval_required) whatWorks.push('Posts go through an approval queue, so same-day timing is unreliable. Treat the posting-time heatmap as directional only.');
    if (demandRows.length) whatWorks.push(`${demandRows.length} live demand signals found (${((demandRate) * 100).toFixed(1)}% of posts) — this room states what it wants to buy.`);

    return {
        groupId: groupMeta.group_id,
        name: groupMeta.name,
        url: groupMeta.url,
        memberCount: groupMeta.member_count,
        privacy: groupMeta.privacy,
        promoAllowed: groupMeta.promo_allowed,
        approvalRequired: groupMeta.approval_required,
        rulesText: groupMeta.rules_text,
        postsAnalyzed: posts,
        windowDays: Math.round(spanDays),
        postsPerDay,
        uniquePosters,
        uniquePosterRatio,
        medianComments,
        medianReactions,
        adminShare: +((rows.filter(r => r.author_is_admin).length / posts) * 100).toFixed(1),
        provisionalPosts: rows.filter(r => r.is_provisional).length,
        roomValue: rv.score,
        roomValueBreakdown: rv.breakdown,
        formats, intents, openings, lengths, heatmap,
        topPosts: sorted.slice(0, 10).map(slim),
        bottomPosts: sorted.slice(-10).reverse().map(slim),
        demandSignals: demandRows.length,
        demandRate: +(demandRate * 100).toFixed(1),
        demandCategories: Object.entries(demandCategories).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ category: k, count: v })),
        demandKeywords,
        whatWorks,
        // Verbatim winners, used to condition the advisor on THIS room
        exemplars: sorted.filter(r => (r.content || '').length > 60).slice(0, 3).map(r => ({
            text: (r.content || '').slice(0, 700),
            index: r.performance_index, format: r.media_type, intent: r.intent_type
        }))
    };
}

/** Cross-group roll-up for a combined audit. */
function buildCommunityBenchmark(audits) {
    const live = audits.filter(a => a.postsAnalyzed > 0);
    if (!live.length) return null;

    const ranked = [...live].sort((a, b) => b.roomValue - a.roomValue).map((a, i) => ({
        rank: i + 1, groupId: a.groupId, name: a.name, roomValue: a.roomValue,
        members: a.memberCount, postsPerDay: a.postsPerDay, medianComments: a.medianComments,
        demandSignals: a.demandSignals, demandRate: a.demandRate,
        promoAllowed: a.promoAllowed, approvalRequired: a.approvalRequired,
        postsAnalyzed: a.postsAnalyzed,
        lowConfidence: !!a.roomValueBreakdown.lowConfidence,
        verdict: a.roomValueBreakdown.verdict
    }));

    const rollup = (dim) => {
        const agg = {};
        live.forEach(a => (a[dim] || []).forEach(row => {
            agg[row.key] = agg[row.key] || { key: row.key, posts: 0, weighted: 0, rooms: 0 };
            agg[row.key].posts += row.posts;
            agg[row.key].weighted += row.avgIndex * row.posts;
            agg[row.key].rooms++;
        }));
        return Object.values(agg)
            .map(a => ({ key: a.key, posts: a.posts, rooms: a.rooms, avgIndex: +(a.weighted / a.posts).toFixed(2) }))
            .sort((x, y) => y.avgIndex - x.avgIndex);
    };

    const kw = {};
    live.forEach(a => (a.demandKeywords || []).forEach(k => { kw[k.term] = (kw[k.term] || 0) + k.hits; }));

    const cats = {};
    live.forEach(a => (a.demandCategories || []).forEach(c => { cats[c.category] = (cats[c.category] || 0) + c.count; }));

    return {
        rooms: live.length,
        totalPosts: live.reduce((s, a) => s + a.postsAnalyzed, 0),
        totalDemand: live.reduce((s, a) => s + a.demandSignals, 0),
        avgRoomValue: Math.round(live.reduce((s, a) => s + a.roomValue, 0) / live.length),
        totalMembers: live.reduce((s, a) => s + (a.memberCount || 0), 0),
        ranked,
        formats: rollup('formats'),
        intents: rollup('intents'),
        openings: rollup('openings'),
        demandKeywords: Object.entries(kw).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([term, hits]) => ({ term, hits })),
        demandCategories: Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([category, count]) => ({ category, count })),
        bestRoom: ranked[0] || null,
        deadRooms: ranked.filter(r => r.roomValue < 30).map(r => r.name)
    };
}

// ===========================================================================
// FB AI LAYER
// ===========================================================================

async function geminiJSON(prompt, maxTokens = 4096, temperature = 0.5) {
    return geminiCall(prompt, { temperature, maxOutputTokens: maxTokens, tag: 'Gemini FB' });
}

async function fbNarrative(payload) {
    if (!geminiAvailable()) {
        return { ai: null, aiStatus: { ok: false, reason: 'no_key', message: aiReasonText('no_key') } };
    }

    const slim = payload.mode === 'single'
        ? { mode: 'single', group: fbGroupAiSlim(payload.group) }
        : {
            mode: 'combined',
            groups: (payload.groups || []).slice(0, 15).map(fbGroupAiSlim),
            benchmark: payload.benchmark || null
          };
    const { json, dropped, chars } = budgetedJson(slim, {
        maxChars: AI_PROMPT_BUDGET, keep: ['mode', 'group', 'groups']
    });

    const prompt =
`You are a local-market community strategist writing a paid client report about Facebook groups.
The client wants to know which rooms are worth their time, what to post in them, and what demand is going unmet.

Reply with ONLY valid JSON matching this schema:
{
 "executive_summary": "3-5 sentences a business owner understands, naming the specific groups",
 "room_verdicts": [{"group":"name","verdict":"work it | test it | skip it","why":"one sentence"}],
 "what_works_here": ["concrete, specific to these rooms, not generic advice"],
 "what_fails_here": ["formats or intents the data shows underperform"],
 "unmet_demand": ["what people are asking for that nobody is answering well"],
 "posting_playbook": [{"room":"name","format":"...","intent":"...","best_time":"...","angle":"..."}],
 "lead_actions": ["how to convert the demand signals into paying work this week"],
 "risks": ["rules, approval queues, or ban risks specific to these groups"],
 "next_30_days": [{"week":"Week 1","actions":["..."]}]
}
Ground every claim in the numbers supplied. Do not invent group names. No markdown outside the JSON.

DATA:
${json}`;

    const r = await geminiCallDetailed(prompt, { temperature: 0.45, tag: 'Gemini FB' });
    logger.info('ai_narrative', { tag: 'fb_community', ok: r.ok, reason: r.reason, promptChars: chars, dropped });
    return {
        ai: r.data,
        aiStatus: {
            ok: r.ok, reason: r.reason, message: aiReasonText(r.reason),
            promptChars: chars, dropped, model: GEMINI_MODEL,
            generatedAt: new Date().toISOString()
        }
    };
}

/**
 * POST ADVISOR.
 * Conditioned on one specific room's data — its winning format, winning
 * intent, best hour, demand keywords, verbatim exemplars and its rules.
 * Without that conditioning this is just a worse ChatGPT.
 *
 * The compliance gate is a hard constraint, not a suggestion: if the group
 * bans promotion, no draft may pitch. Getting users banned is the single
 * biggest churn risk in this product.
 */
async function fbGenerateDrafts(audit, opts = {}) {
    const count = Math.min(Math.max(parseInt(opts.count || 5, 10), 1), 10);
    const promoAllowed = audit.promoAllowed !== false && !opts.forceValueFirst;
    const mode = promoAllowed ? 'open' : 'value_first';

    const bestFormat = audit.formats?.[0]?.key || 'text';
    const bestIntent = audit.intents?.[0]?.key || 'question';
    const bestHour = audit.heatmap?.bestHours?.[0];
    const bestDay = audit.heatmap?.bestDays?.[0];
    const timeLabel = bestHour
        ? `${String(bestHour.hour).padStart(2, '0')}:00 local${bestDay ? ` on ${bestDay.dowName}` : ''}`
        : 'no reliable window in the data';

    const complianceBlock = promoAllowed
        ? `This group permits commercial posts. Drafts may include a soft offer, but the value must land before the ask.`
        : `HARD CONSTRAINT — THIS GROUP PROHIBITS PROMOTION.
Every draft MUST be value-first or question format. No pitch, no service description, no pricing,
no "DM me", no "contact us", no link to a business page, no call to action that sells anything.
A draft that violates this gets the user banned. If you cannot write a compliant draft, write a
question that surfaces demand instead.`;

    const prompt =
`You write Facebook group posts that fit one specific room. You have that room's real performance data.
Write in the same register as the exemplar posts below — same language mix, same formality, same length.

ROOM: ${audit.name} (${audit.memberCount || 'unknown'} members)
Winning format: ${bestFormat} (${audit.formats?.[0]?.avgIndex || '?'}x room median)
Winning intent: ${bestIntent} (${audit.intents?.[0]?.avgIndex || '?'}x room median)
Winning opening pattern: ${audit.openings?.[0]?.key || 'unknown'}
Winning length: ${audit.lengths?.[0]?.key || 'unknown'}
Best time to post: ${timeLabel}
Underperforming formats: ${(audit.formats || []).slice(-2).map(f => `${f.key} (${f.avgIndex}x)`).join(', ') || 'none identified'}
Live demand keywords: ${(audit.demandKeywords || []).slice(0, 12).map(k => k.term).join(', ') || 'none found'}
Top demand categories: ${(audit.demandCategories || []).slice(0, 4).map(c => c.category).join(', ') || 'none'}
Group rules: ${(audit.rulesText || 'not published').slice(0, 900)}

${complianceBlock}

VERBATIM HIGH-PERFORMING POSTS FROM THIS EXACT ROOM (match this voice):
${(audit.exemplars || []).map((e, i) => `[${i + 1}] (${e.index}x, ${e.format}, ${e.intent})\n${e.text}`).join('\n---\n') || 'None available — write in plain conversational local-group voice.'}

${opts.brief ? `WHAT THE USER SELLS / WANTS TO ACHIEVE: ${String(opts.brief).slice(0, 600)}` : ''}

Produce ${count} drafts. Reply with ONLY valid JSON:
{"drafts":[{
  "draft_text":"the full post, ready to paste",
  "format":"text|photo|album|video|link|poll",
  "intent_type":"question|recommendation_request|story|offer|event|discussion",
  "pattern_used":"the specific pattern from the data this exploits",
  "rationale":"one sentence citing the number it is built on",
  "suggested_time":"e.g. Tuesday 20:00 local",
  "predicted_band":"top|above|typical",
  "predicted_index":1.8
}]}`;

    const ai = await geminiCallDetailed(prompt, { temperature: 0.75, maxOutputTokens: 6000, tag: 'Gemini FB' });
    const out = ai.ok ? ai.data : null;
    let drafts = Array.isArray(out?.drafts) ? out.drafts : [];
    const produced = drafts.length;

    // Belt and braces: the compliance gate is enforced in code as well as in
    // the prompt. A model that ignores the instruction must not reach the user.
    if (!promoAllowed) {
        const banned = /\b(dm me|inbox me|message me|contact us|call us|whatsapp|order now|book now|our (service|shop|company|price)|we offer|discount|visit our|price starts|only \d+ ?(tk|৳|\$))\b/i;
        drafts = drafts.filter(d => !banned.test(String(d.draft_text || '')));
    }

    return { drafts, complianceMode: mode, promoAllowed, ai, removed: produced - drafts.length };
}

// ===========================================================================
// FB PERSISTENCE
// ===========================================================================

async function fbUpsertGroup(userId, meta, extra = {}, { preserve = false } = {}) {
    // preserve=true is the scrape path. The posts actor does not return
    // member counts or rules, so a scrape must never overwrite what the user
    // typed in the Edit modal with 0 / null / defaults. ON CONFLICT DO UPDATE
    // only touches the columns supplied, so unknown values are simply omitted.
    const row = {
        user_id: userId,
        group_id: meta.group_id,
        url: meta.url,
        ...extra
    };
    const nameIsId = !meta.name || String(meta.name) === String(meta.group_id);
    if (!preserve || !nameIsId) row.name = meta.name || meta.group_id;
    if (!preserve || (meta.member_count || 0) > 0) row.member_count = meta.member_count || 0;
    if (!preserve || meta.privacy === 'private' || meta.privacy_known) row.privacy = meta.privacy || 'public';
    if (!preserve || meta.rules_known) {
        row.rules_text = meta.rules_text || null;
        row.promo_allowed = meta.promo_allowed !== false;
        row.approval_required = !!meta.approval_required;
    }
    const { data, error } = await supabase.from('fb_groups')
        .upsert(row, { onConflict: 'user_id,group_id' })
        .select('id, group_id, name, url, member_count, room_value_score, promo_allowed, approval_required, privacy, niche, location_label')
        .maybeSingle();
    if (error) console.error('[fbUpsertGroup]', error.message);
    return data;
}

async function fbSavePosts(rows, clientId = null) {
    if (!rows.length) return 0;
    // phase 10: rows are filed under the client the run was started for,
    // so every member of that client can build on them.
    const cid = (clientId && S.UUID_RE.test(String(clientId))) ? clientId : null;
    let saved = 0;
    for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200).map(r => ({ ...r, client_id: cid }));
        const { error } = await supabase.from('fb_posts')
            .upsert(chunk, { onConflict: 'user_id,group_id,post_id' });
        if (error) console.error('[fbSavePosts]', error.message);
        else saved += chunk.length;
    }
    return saved;
}

async function fbSaveDemand(rows) {
    if (!rows.length) return 0;
    let saved = 0;
    for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        const { error } = await supabase.from('fb_demand_signals')
            .upsert(chunk, { onConflict: 'user_id,group_id,source_post_id,matched_phrase' });
        if (error) console.error('[fbSaveDemand]', error.message);
        else saved += chunk.length;
    }
    return saved;
}

function fbEstimateCredits(groups, postsPerGroup, sampleComments, commentPosts = null) {
    const posts = groups * postsPerGroup;
    // The comment surcharge applies to the posts whose comments are pulled,
    // not to every post in the run. commentPosts === null keeps the old
    // "all posts" behaviour for callers that have not been told a count.
    const sampled = sampleComments
        ? (commentPosts == null ? postsPerGroup : Math.min(Math.max(commentPosts, 0), postsPerGroup))
        : 0;
    const surcharge = (groups * sampled / 1000) * COST_PER_1K_FB_POSTS * 0.6;
    return +(((posts / 1000) * COST_PER_1K_FB_POSTS) + surcharge).toFixed(4);
}

/**
 * Scrape one group end to end: raw -> normalised -> indexed -> demand mined.
 * Shared by discovery (shallow) and audit (deep).
 */
async function fbProcessGroup(client, userId, groupRef, opts) {
    const { raw } = await fbScrapeGroup(client, groupRef, opts);
    const meta = fbGroupMeta(raw, groupRef);

    const scrapeNote = raw.length
        ? null
        : (meta.privacy === 'private'
            ? 'Group is private — no public posts.'
            : 'Actor returned 0 posts. Check the URL form and that the group is public; see fb_group_scraped in server logs.');

    const groupRow = await fbUpsertGroup(userId, meta, {
        niche: opts.niche || null,
        location_label: opts.location || null,
        source: opts.source || 'manual',
        last_scraped_at: new Date().toISOString(),
        last_scrape_posts: raw.length,
        last_scrape_note: scrapeNote
    }, { preserve: true });

    const rows = raw
        .map(item => fbNormalisePost(item, meta.group_id, groupRow?.id, userId))
        .filter(Boolean);

    fbIndexPosts(rows);

    const now = new Date().toISOString();
    const demand = [];
    const base = r => ({
        user_id: userId,
        group_id: meta.group_id,
        group_name: meta.name,
        source_url: r.post_url,
        posted_at: r.posted_at,
        detected_at: now
    });

    rows.forEach(r => {
        mineDemand(r.content, { engagement: r.engagement_raw, postedAt: r.posted_at }).forEach(d => {
            demand.push({
                ...base(r),
                source_post_id: r.post_id,
                author_hash: r.author_hash,
                engagement: Math.round(r.engagement_raw),
                source_type: 'post',
                ...d
            });
        });
    });

    // Comment mining. Only the top-N posts by engagement, because that is
    // what the surcharge in fbEstimateCredits was charged for. Comments are
    // where "me too, who did you use?" lives — a second demand layer that
    // the post text alone never shows.
    const commentPosts = opts.sampleComments ? (opts.commentPosts ?? 20) : 0;
    if (commentPosts > 0 && rows.length) {
        const byPostId = new Map(raw.map(item => [fbPostId(item), item]));
        const top = [...rows].sort((a, b) => b.engagement_raw - a.engagement_raw).slice(0, commentPosts);
        for (const r of top) {
            const item = byPostId.get(r.post_id);
            const comments = fbCommentsOf(item);
            comments.forEach((c, i) => {
                if (!c.text || c.text.length < 12) return;
                mineDemand(c.text, { engagement: c.likes || 0, postedAt: c.postedAt || r.posted_at }).forEach(d => {
                    demand.push({
                        ...base(r),
                        source_post_id: `${r.post_id}#c${i}`,
                        author_hash: authorHash(c.author || null, meta.group_id),
                        engagement: Math.round(c.likes || 0),
                        source_type: 'comment',
                        ...d
                    });
                });
            });
        }
    }

    return { meta, groupRow, rows, demand };
}

/**
 * Comment payload of one raw group post, normalised to {text, author, likes,
 * postedAt}. The groups actor has shipped comments under several keys over
 * time; every known one is read.
 */
function fbCommentsOf(item) {
    if (!item) return [];
    const arr = [item.comments, item.latestComments, item.topComments, item.commentsList]
        .find(Array.isArray) || [];
    return arr.map(c => {
        if (!c) return null;
        if (typeof c === 'string') return { text: c, author: null, likes: 0, postedAt: null };
        return {
            text: String(c.text || c.message || c.commentText || '').trim(),
            author: c.profileName || c.authorName || c.name || c.author?.name || c.user?.name || null,
            likes: firstNum(c.likesCount, c.likes, c.reactionsCount, 0),
            postedAt: c.date || c.timestamp || c.time || null
        };
    }).filter(Boolean);
}

// ===========================================================================
// FB API :: ESTIMATE
// ===========================================================================

app.get('/api/fb/estimate-credits', async (req, res) => {
    const ctx = await auth(req, res); if (!ctx) return;
    const groups = Math.min(parseInt(req.query.groups || '1', 10), FB_MAX_GROUPS);
    const posts = Math.min(parseInt(req.query.posts || FB_DEFAULT_POSTS, 10), FB_MAX_POSTS);
    const sampleComments = req.query.comments === 'true' || req.query.comments === '1';
    const commentPosts = req.query.cposts != null
        ? Math.min(Math.max(parseInt(req.query.cposts, 10) || 0, 0), 40) : null;
    const estimatedUsd = fbEstimateCredits(groups, posts, sampleComments, commentPosts);
    res.json({
        groups, postsPerGroup: posts,
        totalPosts: groups * posts,
        sampleComments, commentPosts,
        estimatedUsd,
        budget: await budgetSnapshot('fb_community', ctx.user.id, estimatedUsd),
        note: 'Estimate only. Facebook group runs cost more per post than Instagram — comment sampling is the expensive part.'
    });
});

// ===========================================================================
// FB API :: ENGINE 1 — COMMUNITY DISCOVERY
// ===========================================================================

/**
 * Ranked groups for a location + niche. Returns the full list with the top 10
 * flagged, because member count is a vanity metric and the ranking is the
 * product. Discovery does a shallow scrape (enough posts to measure liveness)
 * rather than the full audit pull.
 */
app.post('/api/fb/discover-groups', spendLimit, async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        await assertJobSlot(ctx.user.id);

        const {
            location = '', niche = '', keywords = [],
            sampleSize, maxGroups, groupUrls = []
        } = req.body;

        const seeds = [...new Set(
            (Array.isArray(groupUrls) ? groupUrls : String(groupUrls || '').split(/[\n,]/))
                .map(parseGroupRef).filter(Boolean).map(g => g.groupId)
        )].slice(0, FB_MAX_GROUPS);

        if (!location && !niche && !keywords.length && !seeds.length) {
            return res.status(400).json({ error: 'Give a location, a niche, or paste group URLs.' });
        }

        const sample = Math.min(parseInt(sampleSize || 40, 10), 120);
        const cap = Math.min(parseInt(maxGroups || 12, 10), FB_MAX_GROUPS);
        const estimate = fbEstimateCredits(seeds.length || cap, sample, false);

        const job = await createJob(ctx.user.id, 'fb_discovery', 'fb_community',
            { clientId: await S.resolveClientId(req, ctx), location, niche, keywords, seeds, sampleSize: sample, maxGroups: cap }, estimate);

        runJob(job.id, JOB_WORKERS['fb_discovery'](ctx.user.id, job.input, job.id));

        res.status(202).json({
            success: true, jobId: job.id,
            candidates: seeds.length || cap,
            estimatedUsd: estimate
        });
    } catch (err) { sendErr(res, err); }
});

/** Manual import — always works, unlike group search. */
app.post('/api/fb/groups/import', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        const { urls = [], niche, location } = req.body;

        const refs = (Array.isArray(urls) ? urls : String(urls || '').split(/[\n,]/))
            .map(parseGroupRef).filter(Boolean);
        if (!refs.length) return res.status(400).json({ error: 'No valid Facebook group URLs found.' });

        const saved = [];
        for (const ref of refs.slice(0, FB_MAX_GROUPS)) {
            const row = await fbUpsertGroup(ctx.user.id, {
                group_id: ref.groupId, name: ref.groupId, url: ref.url,
                member_count: 0, privacy: 'unknown', promo_allowed: true, approval_required: false
            }, { niche: niche || null, location_label: location || null, source: 'manual' });
            if (row) saved.push(row);
        }
        res.json({ success: true, groups: saved, note: 'Imported unscored. Run discovery or an audit to score them.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fb/groups', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        let q = supabase.from('fb_groups').select('*')
            .eq('user_id', ctx.user.id).eq('is_archived', false)
            .order('room_value_score', { ascending: false });
        if (req.query.niche) q = q.eq('niche', req.query.niche);
        if (req.query.location) q = q.ilike('location_label', `%${req.query.location}%`);
        const { data, error } = await q;
        if (error) throw error;
        res.json({ groups: data || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * Add one room by hand.
 *
 * fb-communities.html has always had this form; the endpoint behind it was
 * never written, so "Save room" returned a 404 and the manual path into the
 * product did not work at all. Optionally probes the room so it arrives with a
 * Room Value score instead of an empty one.
 *
 * The rules text matters more than it looks: the advisor's compliance gate
 * reads promo_allowed, and for a hand-added room this is the only place it
 * can be set.
 */
app.post('/api/fb/groups', spendLimit, async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        const {
            url, name, memberCount, location, niche, rulesText,
            promoAllowed = true, approvalRequired = false, probe = false
        } = req.body;

        const ref = parseGroupRef(url);
        if (!ref) return res.status(400).json({ error: 'That is not a Facebook group URL. It should look like facebook.com/groups/…' });
        const probeClientId = await S.resolveClientId(req, ctx);   // phase 10: probe rows filed under the client

        // Stated rules win over the checkboxes when they contradict them: a
        // group that writes "no promotion" in its rules bans promotion no
        // matter which box was ticked.
        const parsed = rulesText ? parseRules(rulesText) : null;

        const meta = {
            group_id: ref.groupId,
            name: (name && String(name).trim()) || ref.groupId,
            url: ref.url,
            member_count: parseInt(memberCount || '0', 10) || 0,
            privacy: 'unknown',
            rules_text: rulesText ? String(rulesText).slice(0, 4000) : null,
            promo_allowed: parsed ? parsed.promo_allowed : promoAllowed !== false,
            approval_required: parsed ? parsed.approval_required : !!approvalRequired
        };

        const extra = {
            niche: niche || null,
            location_label: location || null,
            source: 'manual'
        };

        const warnings = [];

        if (probe) {
            // A shallow probe: enough posts to score the room, not enough to
            // cost real money.
            const PROBE_POSTS = 25;
            try {
                const { client } = await getWorkingClient('fb_community', ctx.user.id, {
                    needUsd: fbEstimateCredits(1, PROBE_POSTS, false)
                });
                const { rows, demand, meta: scraped } = await fbProcessGroup(
                    client, ctx.user.id, ref,
                    { limit: PROBE_POSTS, days: 30, sampleComments: false, source: 'manual' }
                );

                // What the scrape found beats what was typed in, except where
                // the user deliberately overrode it.
                if (scraped?.name && !name) meta.name = scraped.name;
                if (scraped?.member_count) meta.member_count = scraped.member_count;
                if (scraped?.privacy) meta.privacy = scraped.privacy;

                if (rows?.length) {
                    await fbSavePosts(rows, probeClientId);
                    await fbSaveDemand(demand);
                    // Scored the same way discovery scores a room, so a
                    // hand-added group is directly comparable to a found one.
                    const audit = computeGroupAudit({ ...meta, ...scraped }, rows, demand || []);
                    extra.room_value_score = audit.roomValue;
                    extra.score_breakdown = audit.roomValueBreakdown;
                } else {
                    warnings.push('The probe returned no posts — the group may be private, empty, or blocked. Saved unscored.');
                }
                extra.last_scraped_at = new Date().toISOString();
            } catch (e) {
                if (e.code === 'NO_CREDIT') {
                    warnings.push('Saved, but not probed: no Apify key has credit for it right now.');
                } else {
                    warnings.push('Saved, but the probe failed: ' + e.message);
                }
            }
        }

        const row = await fbUpsertGroup(ctx.user.id, meta, extra);
        if (!row) return res.status(500).json({ error: 'The room could not be saved.' });

        res.json({ success: true, group: row, warnings });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * Edit a saved room's details. Rules text is the field that actually changes
 * behaviour downstream, so it is re-parsed rather than stored blindly.
 */
app.patch('/api/fb/groups/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        const patch = {};

        if (req.body.name !== undefined)           patch.name = String(req.body.name || '').slice(0, 300) || null;
        if (req.body.niche !== undefined)          patch.niche = String(req.body.niche || '').slice(0, 120) || null;
        if (req.body.location_label !== undefined) patch.location_label = String(req.body.location_label || '').slice(0, 200) || null;
        if (req.body.member_count !== undefined)   patch.member_count = parseInt(req.body.member_count, 10) || 0;

        if (req.body.rules_text !== undefined) {
            const text = String(req.body.rules_text || '');
            patch.rules_text = text.slice(0, 4000) || null;
            if (text.trim()) {
                const parsed = parseRules(text);
                patch.promo_allowed = parsed.promo_allowed;
                patch.approval_required = parsed.approval_required;
            }
        }
        // An explicit toggle still wins over the parse when no rules were given.
        if (req.body.promo_allowed !== undefined && !patch.rules_text) {
            patch.promo_allowed = req.body.promo_allowed !== false;
        }
        if (req.body.approval_required !== undefined && !patch.rules_text) {
            patch.approval_required = !!req.body.approval_required;
        }

        if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update.' });

        const { data, error } = await supabase.from('fb_groups')
            .update(patch).eq('id', req.params.id).eq('user_id', ctx.user.id)
            .select('id, group_id, name, url, niche, location_label, member_count, rules_text, promo_allowed, approval_required, room_value_score')
            .maybeSingle();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Room not found.' });

        res.json({ success: true, group: data });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/fb/groups/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        const { error } = await supabase.from('fb_groups')
            .update({ is_archived: true }).eq('id', req.params.id).eq('user_id', ctx.user.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===========================================================================
// FB API :: GROUP SETS  (mirror of competitor_sets)
// ===========================================================================

app.post('/api/fb/group-sets', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        const { name, location, niche, groupIds = [], auditMode, days, postsPerGroup } = req.body;
        if (!groupIds.length) return res.status(400).json({ error: 'Pick at least one group.' });

        // Normalise to facebook group ids so a set re-runs identically whether
        // it was built from row ids on one page or raw ids on another.
        const isUuid = v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v));
        const uuids = groupIds.filter(isUuid);
        let resolved = groupIds.filter(v => !isUuid(v)).map(String);
        if (uuids.length) {
            const { data } = await supabase.from('fb_groups')
                .select('group_id').eq('user_id', ctx.user.id).in('id', uuids);
            resolved = resolved.concat((data || []).map(r => r.group_id));
        }
        const finalIds = [...new Set(resolved)];
        if (!finalIds.length) return res.status(400).json({ error: 'None of those groups resolved.' });

        const { data, error } = await supabase.from('fb_group_sets').insert([{
            user_id: ctx.user.id,
            name: name || `${niche || 'Community'} — ${location || 'set'}`,
            location_label: location || null,
            niche: niche || null,
            group_ids: finalIds.slice(0, FB_MAX_GROUPS),
            audit_mode: auditMode === 'individual' ? 'individual' : 'combined',
            days_window: Math.min(parseInt(days || FB_DEFAULT_DAYS, 10), 90),
            posts_per_group: Math.min(parseInt(postsPerGroup || FB_DEFAULT_POSTS, 10), FB_MAX_POSTS)
        }]).select().maybeSingle();
        if (error) throw error;
        res.json({ success: true, set: data });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fb/group-sets', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        const { data } = await supabase.from('fb_group_sets')
            .select('*').eq('user_id', ctx.user.id).order('created_at', { ascending: false });
        res.json({ sets: data || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/fb/group-sets/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        await supabase.from('fb_group_sets').delete().eq('id', req.params.id).eq('user_id', ctx.user.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===========================================================================
// FB API :: ENGINE 2 — COMMUNITY AUDIT
//
// mode = 'combined'    -> one report covering every selected room, with a
//                         cross-room ranking and a rolled-up playbook
// mode = 'individual'  -> one report per room, run in a single job
//
// The user picks. A combined run answers "which of my rooms deserve the
// effort"; individual runs answer "how do I win in this one room".
// ===========================================================================

app.post('/api/fb/audit-community', spendLimit, async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        await assertJobSlot(ctx.user.id);

        const {
            groupIds = [], groupUrls = [], mode = 'combined',
            days, postsPerGroup, sampleComments = false, commentSamplePosts,
            setId, setName, niche, location
        } = req.body;

        // Resolve selection: saved rows by id, plus any pasted URLs.
        let refs = [];
        if (groupIds.length) {
            const isUuid = v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v));
            const rowIds = groupIds.filter(isUuid);
            const rawIds = groupIds.filter(v => !isUuid(v)).map(String);

            const found = [];
            if (rowIds.length) {
                const { data } = await supabase.from('fb_groups')
                    .select('id, group_id, url, name').eq('user_id', ctx.user.id).in('id', rowIds);
                found.push(...(data || []));
            }
            if (rawIds.length) {
                const { data } = await supabase.from('fb_groups')
                    .select('id, group_id, url, name').eq('user_id', ctx.user.id).in('group_id', rawIds);
                found.push(...(data || []));
                // Ids we have never seen are still auditable — build a ref directly.
                rawIds.filter(id => !found.some(f => f.group_id === id))
                      .forEach(id => found.push({ id: null, group_id: id, url: null, name: id }));
            }
            refs = found.map(r => ({
                groupId: r.group_id,
                url: r.url || `https://www.facebook.com/groups/${r.group_id}/`,
                rowId: r.id, name: r.name
            }));
        }
        (Array.isArray(groupUrls) ? groupUrls : String(groupUrls || '').split(/[\n,]/))
            .map(parseGroupRef).filter(Boolean)
            .forEach(r => { if (!refs.some(x => x.groupId === r.groupId)) refs.push(r); });

        refs = refs.slice(0, FB_MAX_GROUPS);
        if (!refs.length) return res.status(400).json({ error: 'Select at least one group, or paste a group URL.' });

        const auditMode = mode === 'individual' ? 'individual' : 'combined';
        const limit = Math.min(parseInt(postsPerGroup || FB_DEFAULT_POSTS, 10), FB_MAX_POSTS);
        const window = Math.min(parseInt(days || FB_DEFAULT_DAYS, 10), 90);
        // How many posts (per room, by engagement) get their comments pulled
        // and mined. 0 with sampleComments=true means "count only".
        const commentPosts = sampleComments
            ? Math.min(Math.max(parseInt(commentSamplePosts ?? 20, 10) || 0, 0), 40)
            : 0;
        const estimate = fbEstimateCredits(refs.length, limit, sampleComments, commentPosts);

        // Re-runnable set, same pattern as competitor_sets
        let activeSetId = setId || null;
        if (!activeSetId && refs.length > 1) {
            const { data: set } = await supabase.from('fb_group_sets').insert([{
                user_id: ctx.user.id,
                client_id: await S.resolveClientId(req, ctx),
                name: setName || `${niche || 'Community'} — ${refs.length} rooms`,
                location_label: location || null, niche: niche || null,
                group_ids: refs.map(r => r.groupId),
                audit_mode: auditMode, days_window: window, posts_per_group: limit
            }]).select('id').maybeSingle();
            activeSetId = set?.id || null;
        }

        // Freeze the window boundary now. A job paused today and resumed next
        // week must measure every room over the same period or the benchmark
        // silently compares unlike things.
        const since = new Date(Date.now() - window * 86400000).toISOString().slice(0, 10);

        const job = await createJob(ctx.user.id, 'fb_community_audit', 'fb_community', { clientId: await S.resolveClientId(req, ctx),
            groups: refs.map(r => r.groupId), mode: auditMode,
            days: window, postsPerGroup: limit, sampleComments, commentSamplePosts: commentPosts,
            setId: activeSetId, groupNames: refs.map(r => r.name || r.groupId),
            niche: niche || null, location: location || null, since
        }, estimate);

        runJob(job.id, JOB_WORKERS['fb_community_audit'](ctx.user.id, job.input, job.id));

        res.status(202).json({
            success: true, jobId: job.id, mode: auditMode, setId: activeSetId,
            groups: refs.length, groupNames: refs.map(r => r.name || r.groupId),
            postsPerGroup: limit, days: window, commentSamplePosts: commentPosts,
            estimatedUsd: estimate,
            budget: await budgetSnapshot('fb_community', ctx.user.id, estimate)
        });
    } catch (err) { sendErr(res, err); }
});

// ===========================================================================
// FB API :: REPORTS
// ===========================================================================

app.get('/api/fb/reports', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        let q = supabase.from('reports')
            .select('id, user_id, client_id, target_handle, fb_group_names, fb_group_ids, audit_mode, grade, score, posts_analyzed, snapshot_date, created_at, ai_summary, location_label, niche, set_id, report_type')
            .eq('platform', 'facebook');
        q = (await S.applyReportScope(req, ctx))(q);
        const { data, error } = await q
            // Page reports share the vault but are a different engine. Without
            // this they showed up in the community list and 404'd on open.
            .neq('report_type', 'fb_page')
            .order('created_at', { ascending: false }).limit(100);
        if (error) throw error;
        res.json({ reports: data || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fb/report/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        const { data } = await supabase.from('reports').select('*')
            .eq('id', req.params.id).maybeSingle();
        if (!data || !(await S.canReadReport(ctx, data))) return res.status(404).json({ error: 'Report not found' });
        res.json({ report: data });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/** Delete one community report. The vault list has always offered this. */
app.delete('/api/fb/report/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        const { error } = await supabase.from('reports')
            .delete().eq('id', req.params.id).eq('user_id', ctx.user.id)
            .eq('platform', 'facebook').neq('report_type', 'fb_page');
        if (error) throw error;
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fb/set-trend/:setId', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        const { data: runs } = await supabase.from('reports')
            .select('id, snapshot_date, created_at, score, grade, posts_analyzed, report_json')
            .eq('set_id', req.params.setId).eq('user_id', ctx.user.id)
            .eq('platform', 'facebook').order('created_at', { ascending: true });

        if (!runs || !runs.length) return res.json({ runs: [], delta: null });

        const points = runs.map(r => ({
            reportId: r.id,
            date: r.snapshot_date || r.created_at?.slice(0, 10),
            avgRoomValue: r.score,
            grade: r.grade,
            postsAnalyzed: r.posts_analyzed,
            rooms: r.report_json?.benchmark?.rooms || (r.report_json?.groups || []).length,
            demandSignals: r.report_json?.benchmark?.totalDemand ?? null,
            bestRoom: r.report_json?.benchmark?.bestRoom?.name || null
        }));

        let delta = null;
        if (points.length > 1) {
            const a = points[points.length - 2], b = points[points.length - 1];
            delta = {
                from: a.date, to: b.date,
                days: Math.round((new Date(b.date) - new Date(a.date)) / 86400000),
                avgRoomValue: (b.avgRoomValue || 0) - (a.avgRoomValue || 0),
                demandSignals: (b.demandSignals || 0) - (a.demandSignals || 0),
                postsAnalyzed: (b.postsAnalyzed || 0) - (a.postsAnalyzed || 0)
            };
        }
        res.json({ runs: points, delta });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/** Stored posts for one room — powers the post-level table in the report UI. */
app.get('/api/fb/posts', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        const groupId = String(req.query.group_id || '').trim();
        if (!groupId) return res.status(400).json({ error: 'group_id required' });

        let q = supabase.from('fb_posts')
            .select('post_id, post_url, content, media_type, intent_type, opening_pattern, length_band, reactions_total, comments, shares, performance_index, posted_at, hour_local, dow_local, author_is_admin, is_provisional')
            .eq('user_id', ctx.user.id).eq('group_id', groupId);

        if (req.query.sort === 'top') q = q.order('performance_index', { ascending: false, nullsFirst: false });
        else q = q.order('posted_at', { ascending: false });

        const { data } = await q.limit(Math.min(parseInt(req.query.limit || '100', 10), 500));
        res.json({ groupId, posts: data || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===========================================================================
// FB API :: DEMAND FEED  (lead generation)
// ===========================================================================

app.get('/api/fb/demand-feed', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;

        let q = supabase.from('fb_demand_signals').select('*').eq('user_id', ctx.user.id);
        if (req.query.group_id) q = q.eq('group_id', req.query.group_id);
        if (req.query.category)  q = q.eq('category', req.query.category);
        if (req.query.urgency)   q = q.eq('urgency', req.query.urgency);
        if (req.query.status)    q = q.eq('status', req.query.status);
        else                     q = q.neq('status', 'dismissed');
        if (req.query.since)     q = q.gte('posted_at', req.query.since);
        if (req.query.min_score) q = q.gte('lead_score', parseInt(req.query.min_score, 10));

        // Free-text search over what the person asked for and the trigger
        // phrase. Sanitised the same way as search-leads: PostgREST's .or()
        // is a DSL, so commas, dots and parens must not survive from input.
        const text = String(req.query.q || '')
            .trim().replace(/[@,().\\%*]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
        if (text) q = q.or(`snippet.ilike.*${text}*,matched_phrase.ilike.*${text}*`);

        // sort=recent → newest post first; anything else → lead score first.
        q = req.query.sort === 'recent'
            ? q.order('posted_at', { ascending: false, nullsFirst: false }).order('lead_score', { ascending: false })
            : q.order('lead_score', { ascending: false }).order('detected_at', { ascending: false });

        const { data, error } = await q
            .limit(Math.min(parseInt(req.query.limit || '200', 10), 500));
        if (error) throw error;

        const rows = data || [];
        const byCategory = {}, byUrgency = {}, byGroup = {};
        rows.forEach(r => {
            byCategory[r.category] = (byCategory[r.category] || 0) + 1;
            byUrgency[r.urgency] = (byUrgency[r.urgency] || 0) + 1;
            byGroup[r.group_name || r.group_id] = (byGroup[r.group_name || r.group_id] || 0) + 1;
        });

        res.json({
            signals: rows,
            summary: {
                total: rows.length,
                hot: rows.filter(r => r.lead_score >= 60).length,
                byCategory: Object.entries(byCategory).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ key: k, count: v })),
                byUrgency, 
                byGroup: Object.entries(byGroup).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ key: k, count: v }))
            }
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/fb/demand/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        const { status, notes } = req.body;
        const patch = {};
        if (status && ['new', 'saved', 'contacted', 'won', 'dismissed'].includes(status)) patch.status = status;
        if (typeof notes === 'string') patch.notes = notes.slice(0, 2000);
        if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update.' });

        const { error } = await supabase.from('fb_demand_signals')
            .update(patch).eq('id', req.params.id).eq('user_id', ctx.user.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/** CSV export of the lead feed. No names — the link is the identity. */
// The page asks for '.csv'; the original route had no extension, so the
// export button 404'd. Both spellings are served rather than picking one and
// breaking whichever caller used the other.
app.get(['/api/fb/demand-export', '/api/fb/demand-export.csv'], async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        let q = supabase.from('fb_demand_signals')
            .select('group_name, category, urgency, lead_score, matched_phrase, snippet, source_url, posted_at, status')
            .eq('user_id', ctx.user.id);
        // Same filter set as /api/fb/demand-feed, so the CSV is what is on screen.
        if (req.query.group_id) q = q.eq('group_id', req.query.group_id);
        if (req.query.category) q = q.eq('category', req.query.category);
        if (req.query.urgency)  q = q.eq('urgency', req.query.urgency);
        if (req.query.status)   q = q.eq('status', req.query.status);
        else                    q = q.neq('status', 'dismissed');
        const text = String(req.query.q || '')
            .trim().replace(/[@,().\\%*]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
        if (text) q = q.or(`snippet.ilike.*${text}*,matched_phrase.ilike.*${text}*`);
        const { data } = await q.order('lead_score', { ascending: false }).limit(2000);

        const cell = v => `"${String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
        const header = ['Group', 'Category', 'Urgency', 'Score', 'Trigger phrase', 'What they asked for', 'Post link', 'Posted', 'Status'];
        const csv = [header.join(',')].concat((data || []).map(r => [
            r.group_name, r.category, r.urgency, r.lead_score, r.matched_phrase,
            r.snippet, r.source_url, r.posted_at, r.status
        ].map(cell).join(','))).join('\n');

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="fb-demand-feed.csv"');
        res.send('\uFEFF' + csv);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===========================================================================
// FB API :: ENGINE 3 — POST ADVISOR
// ===========================================================================

app.post('/api/fb/suggest-posts', spendLimit, async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        const { reportId, groupId, count = 5, brief } = req.body;
        if (!reportId) return res.status(400).json({ error: 'Run an audit first — drafts are conditioned on a report.' });

        const { data: report } = await supabase.from('reports')
            .select('id, report_json').eq('id', reportId).eq('user_id', ctx.user.id).maybeSingle();
        if (!report?.report_json) return res.status(404).json({ error: 'Report not found.' });

        const rj = report.report_json;
        const pool = rj.mode === 'individual' || rj.mode === 'combined'
            ? (rj.groups || (rj.group ? [rj.group] : []))
            : (rj.group ? [rj.group] : []);

        const audit = groupId ? pool.find(g => g.groupId === groupId) : pool[0];
        if (!audit) return res.status(400).json({ error: 'That group is not in this report.' });
        if (!audit.postsAnalyzed) return res.status(400).json({ error: 'No post data for that room — nothing to condition drafts on.' });

        if (!geminiAvailable()) return res.status(503).json({ error: 'GEMINI_API_KEY is not configured on the server.' });

        // The report is frozen at audit time. The fb_groups row is what the
        // user edits (promo ok / no promo, rules pasted in), so it wins.
        const { data: groupRow } = await supabase.from('fb_groups')
            .select('promo_allowed, approval_required, rules_text, member_count, name')
            .eq('user_id', ctx.user.id).eq('group_id', audit.groupId).maybeSingle();
        if (groupRow) {
            audit.promoAllowed = groupRow.promo_allowed !== false;
            audit.approvalRequired = !!groupRow.approval_required;
            if (groupRow.rules_text) audit.rulesText = groupRow.rules_text;
            if (groupRow.member_count && !audit.memberCount) audit.memberCount = groupRow.member_count;
        }

        const { drafts, complianceMode, promoAllowed, ai, removed } = await fbGenerateDrafts(audit, { count, brief });
        if (!drafts.length) {
            if (ai && !ai.ok) {
                const retryable = ai.reason === 'exhausted' || ai.reason === 'network' || String(ai.reason).startsWith('http_5');
                return res.status(retryable ? 503 : 502).json({
                    error: `Drafts could not be generated: ${aiReasonText(ai.reason)}${retryable ? ' Try again in a minute.' : ''}`,
                    aiStatus: ai
                });
            }
            if (removed > 0) {
                return res.status(422).json({
                    error: `The model produced ${removed} draft(s) but every one contained a pitch, and this room is marked "no promo". Give a value-first brief (what you know, not what you sell), or mark the room "promo ok" on the Communities page if its rules allow it.`,
                    removed, complianceMode
                });
            }
            return res.status(502).json({ error: 'The model returned no drafts. Try again, or reduce the count.' });
        }

        const suggClientId = await S.resolveClientId(req, ctx);
        const rows = drafts.map(d => ({
            user_id: ctx.user.id,
            client_id: suggClientId,
            group_id: audit.groupId,
            group_name: audit.name,
            report_id: report.id,
            draft_text: String(d.draft_text || '').slice(0, 6000),
            format: d.format || null,
            intent_type: d.intent_type || null,
            rationale: d.rationale || null,
            pattern_used: d.pattern_used || null,
            suggested_time: d.suggested_time || null,
            predicted_band: ['top', 'above', 'typical', 'below'].includes(d.predicted_band) ? d.predicted_band : 'typical',
            predicted_index: Number(d.predicted_index) || null,
            compliance_mode: complianceMode
        }));

        const { data: saved, error } = await supabase.from('fb_suggestions').insert(rows).select();
        if (error) throw error;

        res.json({
            success: true,
            suggestions: saved,
            complianceMode,
            promoAllowed,
            gate: promoAllowed ? null : 'This group prohibits promotion. Every draft is locked to value-first or question format.'
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fb/suggestions', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        let q = supabase.from('fb_suggestions').select('*').eq('user_id', ctx.user.id);
        if (req.query.group_id) q = q.eq('group_id', req.query.group_id);
        if (req.query.report_id) q = q.eq('report_id', req.query.report_id);
        if (req.query.posted === 'true') q = q.eq('posted', true);
        const { data } = await q.order('created_at', { ascending: false }).limit(200);
        res.json({ suggestions: data || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fb/suggestions/:id/mark-posted', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        const { postedUrl } = req.body;
        const { error } = await supabase.from('fb_suggestions').update({
            posted: true,
            posted_at: new Date().toISOString(),
            posted_url: postedUrl || null
        }).eq('id', req.params.id).eq('user_id', ctx.user.id);
        if (error) throw error;
        res.json({ success: true, note: 'Come back in 48 hours and verify it — predicted vs actual is what makes the advisor smarter.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/fb/suggestions/:id', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        await supabase.from('fb_suggestions').delete().eq('id', req.params.id).eq('user_id', ctx.user.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * CLOSING THE LOOP.
 * Re-scrapes the room, finds the posted draft, and records actual vs
 * predicted. Six months of this data is the part competitors cannot copy.
 */
app.post('/api/fb/suggestions/:id/verify', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        await assertJobSlot(ctx.user.id);

        const { data: sug } = await supabase.from('fb_suggestions').select('*')
            .eq('id', req.params.id).eq('user_id', ctx.user.id).maybeSingle();
        if (!sug) return res.status(404).json({ error: 'Suggestion not found.' });
        if (!sug.posted) return res.status(400).json({ error: 'Mark it as posted first.' });

        const hoursSince = sug.posted_at ? (Date.now() - new Date(sug.posted_at).getTime()) / 3600000 : 999;
        if (hoursSince < 48) {
            return res.status(400).json({
                error: `Too early. Facebook reaction and comment counts are still settling — wait ${Math.ceil(48 - hoursSince)} more hours.`
            });
        }

        const job = await createJob(ctx.user.id, 'fb_verify', 'fb_community',
            { clientId: await S.resolveClientId(req, ctx), suggestionId: sug.id, groupId: sug.group_id }, fbEstimateCredits(1, 60, false));

        runJob(job.id, JOB_WORKERS['fb_verify'](ctx.user.id, job.input, job.id));

        res.status(202).json({ success: true, jobId: job.id });
    } catch (err) { sendErr(res, err); }
});

/** Predicted vs actual across everything verified — the advisor's own scorecard. */
app.get('/api/fb/advisor-accuracy', async (req, res) => {
    try {
        const ctx = await requireEngine(req, res, 'fb_community'); if (!ctx) return;
        const { data } = await supabase.from('fb_suggestions')
            .select('group_name, format, intent_type, predicted_band, predicted_index, actual_index, verified_at')
            .eq('user_id', ctx.user.id).not('actual_index', 'is', null)
            .order('verified_at', { ascending: false }).limit(200);

        const rows = data || [];
        if (!rows.length) return res.json({ verified: 0, rows: [], accuracy: null });

        const withBoth = rows.filter(r => r.predicted_index);
        const mae = withBoth.length
            ? +(withBoth.reduce((s, r) => s + Math.abs(r.actual_index - r.predicted_index), 0) / withBoth.length).toFixed(2)
            : null;
        const bandHit = rows.filter(r => {
            const a = r.actual_index;
            const band = a >= 2 ? 'top' : a >= 1.2 ? 'above' : a >= 0.8 ? 'typical' : 'below';
            return band === r.predicted_band;
        }).length;

        res.json({
            verified: rows.length,
            meanAbsoluteError: mae,
            bandAccuracy: +((bandHit / rows.length) * 100).toFixed(1),
            avgActualIndex: +(rows.reduce((s, r) => s + r.actual_index, 0) / rows.length).toFixed(2),
            rows
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
