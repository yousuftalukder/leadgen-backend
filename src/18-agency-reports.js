/**
 * The monthly report as an agency sends it, post photos, and the report before Meta.
 *
 * Part of the EdgeLead server, split out of server.js (phase 55). The parts load in
 * order from server.js and share one namespace, S: what this part needs from an earlier
 * part is unpacked below; anything else from another part is read as S.name when it runs.
 */
'use strict';
const S = require('./shared');
const {
    JOB_WORKERS, META_MONTH_METRICS, MONTH_RE, app, assertJobSlot, auth, clientAccess, clientStanding,
    contentPlanMonth, cpDocBlocks, createJob, crypto, logger, metaDefaultMonth, metaMonthLabel,
    metaMonthWindow, metaPrevMonth, oneLine, ordinal, registerWorker, runJob, sendErr, staffOnly, supabase
} = S;
Object.assign(S, {
    monthChange, monthStatus, monthRecs, cleanMonthlyAi, monthlyView, monthPlatforms, monthTrends,
    monthlyContext, monthlyBoard, storeMediaImage, keepAuditImages, igDoc, ciDoc, fbDoc, fbGroupsDoc,
    docFinish, reportDoc, publicMonthData, publicMonthlyDoc
});

// ===========================================================================
// PHASE 34 :: THE MONTHLY REPORT, AS AN AGENCY SENDS IT
//
// A monthly report was a table of movements and a paragraph. What an agency
// sends is a document with an order to it: the month in brief, a scorecard,
// what worked, who was reached, how the client compares, what was done for
// them and what happens next, each said in words as well as numbers.
//
// monthlyView() reads only the saved report, so the staff page, the owner's
// portal, a share link and the printed copy are one document, worded here
// once. monthlyContext() adds what the agency knew about the client that
// month: the work finished and filed for them, the leads found, where they
// stood against the businesses they were compared with. It reads as of the
// report's own date, so a report opened a year later still says what it said.
//
// Owner Insights and public data sit in separate, labelled sections, and no
// number in one is computed from the other (rule 3).
// ===========================================================================

/** How each monthly measure is said. `unit` follows a number; `noun` ends a sentence. */
const MONTH_WORDS = {
    reach:                   { short: 'Reach',               unit: 'reached',                noun: 'accounts reached' },
    views:                   { short: 'Views',               unit: 'views',                  noun: 'views of your posts' },
    accounts_engaged:        { short: 'Accounts engaged',    unit: 'accounts engaged',       noun: 'accounts that liked, commented, saved or shared' },
    total_interactions:      { short: 'Interactions',        unit: 'interactions',           noun: 'likes, comments, saves and shares' },
    profile_views:           { short: 'Profile visits',      unit: 'profile visits',         noun: 'profile visits' },
    website_clicks:          { short: 'Website taps',        unit: 'website taps',           noun: 'taps on your website link' },
    follower_count:          { short: 'New followers',       unit: 'new followers',          noun: 'new Instagram followers' },
    page_impressions_unique: { short: 'Facebook reach',      unit: 'reached on Facebook',    noun: 'people reached on Facebook' },
    page_post_engagements:   { short: 'Facebook engagement', unit: 'Facebook engagements',   noun: 'engagements with your Facebook posts' },
    page_views_total:        { short: 'Page views',          unit: 'Page views',             noun: 'views of your Facebook Page' },
    page_fan_adds_unique:    { short: 'New Page followers',  unit: 'new Page followers',     noun: 'new Facebook Page followers' }
};
const MONTH_GAINED = new Set(['follower_count', 'page_fan_adds_unique']);

/** The three cards that open the report. Each area takes the first measure it has. */
const MONTH_BRIEF = [
    { area: 'Visibility', keys: ['reach', 'views', 'page_impressions_unique'] },
    { area: 'Audience',   keys: ['follower_count', 'page_fan_adds_unique'] },
    { area: 'Action',     keys: ['website_clicks', 'profile_views', 'accounts_engaged', 'page_post_engagements'] }
];
// Below this, a percentage says more about the sample than the account:
// 3 website taps to 6 is "up 100%" and means nothing. Such a card gives the
// count instead (rule 5).
const MONTH_THIN = 50;

const MONTH_FORMAT = { reel: ['Reel', 'Reels'], carousel: ['Carousel', 'Carousels'], still: ['Photo', 'Photos'] };

const monthNum = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const monthFmt = v => (monthNum(v) === null ? '—' : Math.round(Number(v)).toLocaleString('en-US'));
/** Under 10% keeps a decimal, because 4.2% and 4% are different claims; above, it is noise. */
const monthPct = p => { const a = Math.abs(Number(p)); return (a < 10 ? a.toFixed(1).replace(/\.0$/, '') : String(Math.round(a))) + '%'; };
/** 'August 2026' -> 'August', for sentences; the cover carries the year. */
const monthShort = label => String(label || '').split(' ')[0] || 'this month';

function monthCovers(month) {
    if (!MONTH_RE.test(String(month || ''))) return null;
    const [y, m] = month.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const name = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
    return `${name} 1–${last}, ${y}`;
}

/** The change column, exactly: the difference and the percentage, or why there is none. */
function monthChange(d) {
    const now = monthNum(d.now), before = monthNum(d.before);
    if (d.kind === 'new') return 'new this month';
    if (d.kind === 'no_baseline') return 'no earlier month';
    if (now === null || before === null || d.kind === 'unknown') return 'not reported';
    const diff = Math.round(now - before);
    const sign = diff > 0 ? '+' : (diff < 0 ? '−' : '±');
    const pct = monthNum(d.pct) === null ? '' : ` (${d.pct > 0 ? '+' : (d.pct < 0 ? '−' : '±')}${monthPct(d.pct)})`;
    return `${sign}${Math.abs(diff).toLocaleString('en-US')}${pct}`;
}

/** Status against last month. There are no targets to be "on track" for, so none is claimed. */
function monthStatus(d) {
    if (d.kind === 'new') return { word: 'New', tone: 'gold' };
    if (d.kind === 'no_baseline') return { word: 'First month', tone: '' };
    if (d.kind === 'unknown') return { word: 'Not reported', tone: '' };
    // The same floor as the cards: 3 to 6 is not "Growing", it is small.
    if (Math.max(monthNum(d.now) || 0, monthNum(d.before) || 0) < MONTH_THIN) return { word: 'Small numbers', tone: '' };
    const p = monthNum(d.pct) || 0;
    if (d.kind === 'up' && p >= 10) return { word: 'Growing', tone: 'jade' };
    if (d.kind === 'down' && p <= -10) return { word: 'Watch', tone: 'warn' };
    return { word: 'Steady', tone: '' };
}

function monthCard(area, d, r) {
    const w = MONTH_WORDS[d.key] || { short: d.label, unit: String(d.label || '').toLowerCase(), noun: String(d.label || '').toLowerCase() };
    const now = monthNum(d.now), before = monthNum(d.before);
    const thisM = monthShort(r.monthLabel), prevM = monthShort(r.prevMonthLabel);
    const thin = Math.max(now || 0, before || 0) < MONTH_THIN;
    let big;
    if (MONTH_GAINED.has(d.key)) big = `+${monthFmt(now)} ${d.key === 'follower_count' ? 'followers' : 'Page followers'}`;
    else if ((d.kind === 'up' || d.kind === 'down') && !thin) big = `${w.short} ${d.kind} ${monthPct(d.pct)}`;
    else if (d.kind === 'flat' && !thin) big = `${w.short} steady`;
    else big = `${monthFmt(now)} ${w.unit}`;

    const cmp = { up: 'up from', down: 'down from', flat: 'about the same as' }[d.kind] || 'against';
    let line = `${monthFmt(now)} ${w.noun} in ${thisM}`;
    // From zero there is no percentage to give, so none is implied.
    if (d.kind === 'new') line += `, against none in ${prevM}.`;
    else line += before === null ? '.' : `, ${cmp} ${monthFmt(before)} in ${prevM}.`;
    if (d.key === 'follower_count' && monthNum(r.account && r.account.igFollowers) !== null) {
        line += ` ${monthFmt(r.account.igFollowers)} followers in total.`;
    }
    const tone = d.kind === 'up' || d.kind === 'new' ? 'good' : (d.kind === 'down' ? 'watch' : '');
    return { area, key: d.key, big, line, tone };
}

function monthGapName(g) {
    const [level, key, part] = String(g || '').split(':');
    if (key === 'follower_demographics') return `Follower ${({ age: 'ages', gender: 'gender', city: 'cities', country: 'countries' })[part] || 'details'}`;
    const m = META_MONTH_METRICS.find(x => x.key === key && x.level === level);
    return m ? m.label : String(key || g).replace(/_/g, ' ');
}

const MONTH_GENDER = { F: 'Women', M: 'Men', U: 'Not specified' };
let _regionNames = null;
function monthCountry(code) {
    try { _regionNames = _regionNames || new Intl.DisplayNames(['en'], { type: 'region' }); return _regionNames.of(String(code).toUpperCase()) || code; }
    catch { return code; }
}

/**
 * Follower demographics as shares. Ages and genders are every follower Meta
 * could classify, so they are shares of themselves; cities and countries are
 * only the top few, so they are shares of that same classified whole rather
 * than of each other, which would make the fifth city look like a fifth.
 */
function monthAudience(demo) {
    const G = demo || {};
    const sum = a => (Array.isArray(a) ? a : []).reduce((s, x) => s + (Number(x.value) || 0), 0);
    const base = sum(G.gender) || sum(G.age);
    const out = [];
    for (const [k, title, cap] of [['age', 'Age', 7], ['gender', 'Gender', 3], ['city', 'Top cities', 5], ['country', 'Top countries', 5]]) {
        let rows = (Array.isArray(G[k]) ? G[k] : []).filter(x => Number(x.value) > 0);
        if (!rows.length) continue;
        const denom = k === 'age' || k === 'gender' ? sum(rows) : (base || sum(rows));
        if (k === 'age') rows = rows.slice().sort((a, b) => String(a.key).localeCompare(String(b.key)));
        out.push({
            key: k, title,
            rows: rows.slice(0, cap).map(x => ({
                label: k === 'gender' ? (MONTH_GENDER[x.key] || String(x.key)) : k === 'country' ? monthCountry(x.key) : String(x.key || '—').replace(/(\d)-(\d)/, '$1–$2'),
                share: denom ? Math.round(Number(x.value) / denom * 1000) / 10 : null
            }))
        });
    }
    const top = key => { const g = out.find(x => x.key === key); return g ? g.rows.slice().sort((a, b) => b.share - a.share)[0] : null; };
    const age = top('age'), city = top('city');
    // "The largest group", never "most": 41% is the biggest share, not a majority.
    const ageWords = age ? `The largest group of your followers is aged ${age.label} (${age.share}%)` : null;
    const line = age && city ? `${ageWords}, and more of them live in ${city.label} (${city.share}%) than anywhere else.`
        : age ? `${ageWords}.`
        : city ? `More of your followers live in ${city.label} (${city.share}%) than anywhere else.` : null;
    return { groups: out, line };
}

/**
 * Recommendations as rows an agency can act on. Reports built from phase 34
 * carry {action, why, expected, who, priority}; older ones a list of lines,
 * which stay lines rather than being given a priority nobody set.
 */
function monthRecs(ai) {
    const P = ['high', 'medium', 'low'];
    if (Array.isArray(ai.recommendations) && ai.recommendations.length) {
        return ai.recommendations.slice(0, 6).map((x, i) => ({
            key: 'rec-' + i,
            action: oneLine(typeof x === 'string' ? x : x && x.action, 240),
            why: oneLine(x && x.why, 300) || null,
            expected: oneLine(x && x.expected, 200) || null,
            who: x && (x.who === 'client' || x.who === 'agency') ? x.who : null,
            priority: x && P.includes(x.priority) ? x.priority : null
        })).filter(x => x.action);
    }
    return (Array.isArray(ai.next_month) ? ai.next_month : []).slice(0, 6)
        .map((s, i) => ({ key: 'next-' + i, action: oneLine(s, 240), why: null, expected: null, who: null, priority: null }))
        .filter(x => x.action);
}

/** What the model returned, kept to the shape the report reads. Never trusted as-is. */
function cleanMonthlyAi(ai) {
    if (!ai || typeof ai !== 'object') return ai;
    const recs = monthRecs(ai);
    if (Array.isArray(ai.recommendations)) {
        ai.recommendations = recs.map(({ action, why, expected, who, priority }) => ({ action, why, expected, who, priority }));
        // Older readers (the owner view's "what to change", the assistant)
        // read next_month; it stays the list of actions.
        if (!Array.isArray(ai.next_month) || !ai.next_month.length) ai.next_month = recs.map(x => x.action);
    }
    return ai;
}

/** The monthly report as one document. Pure: reads the row, nothing else. */
function monthlyView(row) {
    if (!row || row.report_type !== 'meta_monthly') return null;
    const r = row.report_json || {};
    const ai = row.ai_json || r.ai || {};
    const deltas = (Array.isArray(r.deltas) ? r.deltas : []).filter(d => d && d.key);
    const byKey = Object.fromEntries(deltas.map(d => [d.key, d]));

    const used = new Set();
    const brief = [];
    for (const b of MONTH_BRIEF) {
        const present = b.keys.map(k => byKey[k]).filter(d => d && !used.has(d.key) && ((monthNum(d.now) || 0) > 0 || (monthNum(d.before) || 0) > 0));
        const pick = present.find(d => Math.max(monthNum(d.now) || 0, monthNum(d.before) || 0) >= MONTH_THIN) || present[0];
        if (!pick) continue;
        used.add(pick.key);
        // "Action" is a tap or a visit; an interaction standing in for one is engagement.
        brief.push(monthCard(['accounts_engaged', 'page_post_engagements'].includes(pick.key) ? 'Engagement' : b.area, pick, r));
    }

    const posting = r.posting || {};
    const formats = Object.entries(posting.formats || {})
        .map(([k, f]) => ({ kind: k, label: (MONTH_FORMAT[k] || [null, 'Other posts'])[1], n: Number(f && f.n) || 0,
            medianReach: monthNum(f && f.medianReach), medianSaved: monthNum(f && f.medianSaved), medianShares: monthNum(f && f.medianShares) }))
        .sort((a, b) => (b.medianReach ?? -1) - (a.medianReach ?? -1));
    const ranked = formats.filter(f => f.medianReach !== null && f.n >= 2);
    let formatLine = null;
    if (ranked.length >= 2) {
        const best = ranked[0], worst = ranked[ranked.length - 1];
        formatLine = `${best.label} reached the most people: a median of ${monthFmt(best.medianReach)} accounts each, across ${best.n}. `
            + `${worst.label} reached the fewest: ${monthFmt(worst.medianReach)} each, across ${worst.n}.`;
    } else if (formats.length === 1 && formats[0].medianReach !== null && formats[0].n >= 2) {
        formatLine = `All ${formats[0].n} posts were ${formats[0].label.toLowerCase()}, reaching a median of ${monthFmt(formats[0].medianReach)} accounts each.`;
    }

    const safeLink = u => (/^https:\/\/(www\.)?(instagram\.com|facebook\.com)\//i.test(String(u || '')) ? String(u) : null);
    const posts = (Array.isArray(posting.topByReach) ? posting.topByReach : []).slice(0, 5).map(p => ({
        image: p.image || null,
        kind: (MONTH_FORMAT[p.kind] || ['Post'])[0],
        caption: oneLine(p.caption, 160) || null,
        date: p.postedAt ? String(p.postedAt).slice(0, 10) : null,
        reach: monthNum(p.reach), saved: monthNum(p.saved), shares: monthNum(p.shares), views: monthNum(p.views),
        link: safeLink(p.permalink)
    }));

    const acc = r.account || {};
    const audience = monthAudience(r.demographics);
    const aiOk = !!(ai && (ai.headline || ai.executive_summary));
    const list = a => (Array.isArray(a) ? a : []).map(s => oneLine(s, 400)).filter(Boolean).slice(0, 5);

    return {
        cover: {
            kind: 'Monthly report',
            month: r.month || String(row.snapshot_date || '').slice(0, 7) || null,
            monthLabel: r.monthLabel || null,
            prevMonthLabel: r.comparable ? (r.prevMonthLabel || null) : null,
            covers: monthCovers(r.month),
            account: {
                pageName: acc.pageName || null,
                igUsername: acc.igUsername || null,
                igFollowers: monthNum(acc.igFollowers),
                pageFollowers: monthNum(acc.pageFollowers)
            },
            builtAt: r.generatedAt || row.created_at || null
        },
        comparable: !!r.comparable,
        verdict: aiOk ? (oneLine(ai.headline, 300) || null) : null,
        summary: aiOk ? (String(ai.executive_summary || '').trim().slice(0, 1500) || null) : null,
        narrative: aiOk ? null : ((row.ai_status && row.ai_status.message) || 'The written summary was not produced for this month.'),
        brief,
        scorecard: deltas.map(d => ({
            key: d.key, label: d.label, platform: d.level === 'ig' ? 'Instagram' : 'Facebook',
            now: monthNum(d.now), before: monthNum(d.before), pct: monthNum(d.pct), kind: d.kind,
            change: monthChange(d), status: monthStatus(d)
        })),
        moved: list(ai.what_moved),
        worked: list(ai.what_worked),
        didNot: list(ai.what_did_not),
        posting: { count: Number(posting.count) || 0, formats, formatLine },
        posts,
        audience: { ...audience, note: aiOk && ai.audience && !/not enough data/i.test(ai.audience) ? oneLine(ai.audience, 400) : null },
        recommendations: monthRecs(ai || {}),
        platforms: monthPlatforms(byKey, acc),
        contentPlan: r.contentPlan || null,
        contentPlanBlocks: cpDocBlocks(r.contentPlan),
        conclusion: aiOk ? (oneLine(ai.conclusion, 600) || null) : null,
        about: {
            source: 'Every figure in this report is your own Meta Insights, the numbers only the account owner can see. Nothing in it is scraped or estimated.',
            gaps: [...new Set((r.gaps || []).map(monthGapName))],
            warnings: (r.warnings || []).map(w => oneLine(w, 300)).filter(w => !/^Narrative unavailable/i.test(w)),
            caveats: aiOk ? (oneLine(ai.caveats, 400) || null) : null
        }
    };
}

/**
 * Facebook and Instagram side by side (phase 38), as in the agency's own
 * monthly deck. Each row pairs the nearest measure on each platform; a dash
 * means Meta gives no such figure there. "Both" is a plain sum, shown only
 * when both sides have the number.
 */
function monthPlatforms(byKey, acc) {
    const ROWS = [
        ['New followers', 'page_fan_adds_unique', 'follower_count'],
        ['Reach', 'page_impressions_unique', 'reach'],
        ['Views', null, 'views'],
        ['Engagement', 'page_post_engagements', 'total_interactions'],
        ['Profile and Page visits', 'page_views_total', 'profile_views'],
        ['Website taps', null, 'website_clicks']
    ];
    const val = k => (k && byKey[k] ? monthNum(byKey[k].now) : null);
    const rows = ROWS.map(([label, fb, ig]) => {
        const a = val(fb), b = val(ig);
        return { label, fb: a, ig: b, both: a !== null && b !== null ? a + b : null };
    }).filter(r => r.fb !== null || r.ig !== null);
    if (!rows.length || !rows.some(r => r.fb !== null) || !rows.some(r => r.ig !== null)) return null;
    return { rows, followers: { fb: monthNum(acc.pageFollowers), ig: monthNum(acc.igFollowers) } };
}

/** Five months of the account's own daily numbers, ending with the report's month (phase 38). */
async function monthTrends(connectionId, month) {
    if (!connectionId || !MONTH_RE.test(String(month || ''))) return null;
    const months = [];
    let m = month;
    for (let i = 0; i < 5; i++) { months.unshift(m); m = metaPrevMonth(m); }
    const from = `${months[0]}-01`, to = monthBounds(month).to.slice(0, 10);
    const { data, error } = await supabase.from('meta_daily').select('day, level, followers, reach, follows')
        .eq('connection_id', connectionId).gte('day', from).lt('day', to).limit(400);
    if (error || !data || !data.length) return null;
    const agg = {};
    for (const r of data) {
        const k = `${r.level}:${String(r.day).slice(0, 7)}`;
        const a = agg[k] = agg[k] || { reach: 0, follows: 0, days: 0, hasReach: false, hasFollows: false };
        a.days++;
        if (typeof r.reach === 'number') { a.reach += r.reach; a.hasReach = true; }
        if (typeof r.follows === 'number') { a.follows += r.follows; a.hasFollows = true; }
    }
    const series = (level, f) => months.map(mm => { const a = agg[`${level}:${mm}`]; return a && a[f === 'reach' ? 'hasReach' : 'hasFollows'] ? a[f] : null; });
    const withData = months.filter(mm => agg[`ig:${mm}`] || agg[`page:${mm}`]);
    if (withData.length < 2) return null;
    return {
        labels: months.map(mm => new Date(mm + '-01T00:00:00Z').toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })),
        reach: { ig: series('ig', 'reach'), fb: series('page', 'reach') },
        follows: { ig: series('ig', 'follows'), fb: series('page', 'follows') },
        firstMonth: withData[0]
    };
}

/** 'YYYY-MM' -> ISO bounds of that month. */
function monthBounds(month) {
    const w = metaMonthWindow(month);
    return { from: new Date(w.since * 1000).toISOString(), to: new Date(w.until * 1000).toISOString() };
}

/**
 * What the agency knew about the client that month. Everything here is read
 * as of the report, so it cannot drift after the fact, and everything is
 * what the owner may read: tasks only when marked for the client, public
 * standing only as the owner's own view of it.
 */
async function monthlyContext(row) {
    const out = { client: null, work: null, leads: null, standing: null };
    const month = (row && row.report_json && row.report_json.month) || String((row && row.snapshot_date) || '').slice(0, 7);
    if (!row || !row.client_id || !MONTH_RE.test(month)) return out;
    const { from, to } = monthBounds(month);
    const asOf = row.created_at || new Date().toISOString();
    const quiet = p => p.then(r => r, () => ({ data: null, error: true }));

    const [client, tasks, reps, leadsIn, leadsAll, bench] = await Promise.all([
        quiet(supabase.from('clients').select('id, name, brand').eq('id', row.client_id).maybeSingle()),
        quiet(supabase.from('client_tasks').select('title, completed_at')
            .eq('client_id', row.client_id).eq('status', 'done').eq('visible_to_client', true)
            .gte('completed_at', from).lt('completed_at', to).order('completed_at', { ascending: true }).limit(30)),
        // No ids: the owner's view never carries a source report id (rule 11).
        quiet(supabase.from('reports').select('report_type, target_handle, created_at')
            .eq('client_id', row.client_id).neq('report_type', 'meta_monthly')
            .gte('created_at', from).lt('created_at', to).order('created_at', { ascending: true }).limit(30)),
        quiet(supabase.from('client_leads').select('lead_id', { count: 'exact', head: true })
            .eq('client_id', row.client_id).gte('created_at', from).lt('created_at', to)),
        quiet(supabase.from('client_leads').select('lead_id', { count: 'exact', head: true })
            .eq('client_id', row.client_id).lt('created_at', to)),
        quiet(supabase.from('reports').select('report_type, target_handle, created_at, engagement_rate, bench:report_json->benchmark')
            .eq('client_id', row.client_id).in('report_type', ['ig_report', 'deep_audit'])
            .lte('created_at', asOf).order('created_at', { ascending: false }).limit(5))
    ]);

    if (client.data) out.client = { name: client.data.brand || client.data.name };
    if (row.report_type === 'meta_monthly') {
        const connId = (row.report_json && row.report_json.connection && row.report_json.connection.id) || row.meta_connection_id || null;
        out.trends = await monthTrends(connId, month).catch(() => null);
    }

    // A table that is not there yet (phase 32 unapplied) is "no tasks", not a
    // failed report; the rest of the section still stands.
    const done = (tasks.data || []).map(t => ({ title: oneLine(t.title, 300), date: String(t.completed_at || '').slice(0, 10) }));
    const filed = (reps.data || []).map(x => ({
        title: `${S.CLIENT_REPORT_TITLES[x.report_type] || 'Report'}${x.target_handle ? ' · ' + (['ig_report', 'deep_audit'].includes(x.report_type) ? '@' + String(x.target_handle).replace(/^@/, '') : x.target_handle) : ''}`,
        date: String(x.created_at || '').slice(0, 10)
    }));
    if (done.length || filed.length) out.work = { done, filed };

    if (!leadsIn.error && !leadsAll.error && (leadsAll.count || 0) > 0) {
        out.leads = { thisMonth: leadsIn.count || 0, toDate: leadsAll.count || 0 };
    }

    for (const b of (bench.data || [])) {
        const bm = b.bench || (b.report_json && b.report_json.benchmark) || {};
        if (!Array.isArray(bm.ranked) || bm.ranked.length < 2) continue;
        const s = clientStanding(b, bm, {});
        if (!s.verdict) continue;
        out.standing = { ...s, date: String(b.created_at || '').slice(0, 10), title: S.CLIENT_REPORT_TITLES[b.report_type] || 'Comparison' };
        break;
    }
    return out;
}

/** The recommendation tasks already on the client's board for this report, by key. */
async function monthlyBoard(row) {
    if (!row || !row.client_id) return {};
    const { data, error } = await supabase.from('client_tasks').select('id, status, source_key')
        .eq('client_id', row.client_id).eq('source_id', row.id).not('source_key', 'is', null);
    if (error) return {};
    return Object.fromEntries((data || []).map(t => [t.source_key, { id: t.id, status: t.status }]));
}


// ===========================================================================
// PHASE 36 :: POST PHOTOS KEPT, AND THE REPORT AS A DOCUMENT
//
// Instagram's image links expire within days, so a report that showed them
// broke by the time the client opened it. The photos of the posts a report
// shows are now copied into our own storage when the report is built, and the
// report keeps that copy.
//
// reportDoc() turns a saved report into the page-by-page document the owner,
// a share link and a PDF read: numbered sections of typed blocks (kpis, a
// table, bars, post cards, points, a week plan). report-view.js draws any
// document; this is the only place a report type decides what it says.
// Every section names its source (public data, owner data, our records, AI),
// and a block with no data is left out rather than drawn empty.
// ===========================================================================

const REPORT_MEDIA_BUCKET = process.env.REPORT_MEDIA_BUCKET || 'report-media';
// Only the platforms' own image hosts are fetched: the address comes from a
// scrape, and fetching anything else would let a crafted post reach inside.
const MEDIA_HOST_RE = /^https:\/\/([a-z0-9-]+\.)*(cdninstagram\.com|fbcdn\.net)\//i;
S.MEDIA_HOST_RE = MEDIA_HOST_RE;
const MEDIA_MAX_BYTES = 2 * 1024 * 1024;
let _mediaBucket = null;

async function ensureMediaBucket() {
    if (!supabase.storage) return false;
    if (!_mediaBucket) {
        _mediaBucket = (async () => {
            try {
                const { data } = await supabase.storage.getBucket(REPORT_MEDIA_BUCKET);
                if (data) return true;
                const { error } = await supabase.storage.createBucket(REPORT_MEDIA_BUCKET, {
                    public: true, fileSizeLimit: MEDIA_MAX_BYTES, allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp']
                });
                if (error && !/exist/i.test(error.message || '')) throw error;
                return true;
            } catch (err) {
                logger.warn('media_bucket_unavailable', { message: err.message });
                _mediaBucket = null;
                return false;
            }
        })();
    }
    return _mediaBucket;
}

/** Copy one post photo into storage. Returns its lasting public URL, or null. */
async function storeMediaImage(srcUrl, path) {
    if (!MEDIA_HOST_RE.test(String(srcUrl || ''))) return null;
    if (!(await ensureMediaBucket())) return null;
    try {
        const r = await fetch(srcUrl, { signal: AbortSignal.timeout(12000) });
        if (!r.ok) return null;
        const type = String(r.headers.get('content-type') || '').split(';')[0].trim();
        if (!/^image\/(jpeg|png|webp)$/.test(type)) return null;
        const buf = Buffer.from(await r.arrayBuffer());
        if (!buf.length || buf.length > MEDIA_MAX_BYTES) return null;
        const file = `${path}.${type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg'}`;
        const { error } = await supabase.storage.from(REPORT_MEDIA_BUCKET)
            .upload(file, buf, { contentType: type, upsert: true, cacheControl: '31536000' });
        if (error) { logger.warn('media_upload_failed', { message: error.message }); return null; }
        return supabase.storage.from(REPORT_MEDIA_BUCKET).getPublicUrl(file).data.publicUrl || null;
    } catch (err) {
        logger.warn('media_fetch_failed', { message: err.message });
        return null;
    }
}

/**
 * The photos a report can show: each audit's top and bottom posts and its
 * exemplars (the same card objects appear in several lists, so one copy
 * serves all). Adds `image` to each card; the scraped `thumbnail` stays.
 */
async function keepAuditImages(audits, prefix, { perAudit = 12 } = {}) {
    const cards = [];
    for (const a of audits.filter(Boolean)) {
        const own = [...(a.topPosts || []), ...(a.bottomPosts || []), ...Object.values(a.exemplars || {})].filter(c => c && c.thumbnail);
        cards.push(...own.slice(0, perAudit).map(c => ({ c, handle: a.handle })));
    }
    const byUrl = new Map();
    for (const { c, handle } of cards) {
        if (!byUrl.has(c.thumbnail)) byUrl.set(c.thumbnail, { list: [], key: `${prefix}/${String(handle || 'x').replace(/[^a-z0-9._-]/gi, '')}-${String(c.shortcode || crypto.createHash('sha1').update(c.thumbnail).digest('hex').slice(0, 12)).replace(/[^a-z0-9_-]/gi, '')}` });
        byUrl.get(c.thumbnail).list.push(c);
    }
    const jobs = [...byUrl.entries()];
    let kept = 0;
    for (let i = 0; i < jobs.length; i += 4) {
        await Promise.all(jobs.slice(i, i + 4).map(async ([url, { list, key }]) => {
            const stored = await storeMediaImage(url, key);
            if (stored) { kept++; for (const c of list) c.image = stored; }
        }));
    }
    return kept;
}

// ---- the document ------------------------------------------------------------

const docNum = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
S.docNum = docNum;
const docFmt = v => (docNum(v) === null ? '—' : Math.round(Number(v)).toLocaleString('en-US'));
S.docFmt = docFmt;
const docPct = (v, d = 1) => (docNum(v) === null ? '—' : `${Number(v).toFixed(d)}%`);
S.docPct = docPct;
const docX = v => (docNum(v) === null ? '—' : `${Number(v).toFixed(1)}×`);
const docMonth = iso => { const d = new Date(iso || Date.now()); return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }); };
S.docMonth = docMonth;
const docDay = iso => { const d = new Date(iso || ''); return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); };
S.docDay = docDay;
const docLines = a => (Array.isArray(a) ? a : []).map(s => oneLine(s, 400)).filter(Boolean);
/** A model line, split at its first colon or dash into a bold lead and the rest. */
const docPoint = s => { const m = /^(.{3,70}?)(?::|\s[—–-]\s)\s*(.+)$/.exec(s); return m ? { title: m[1], text: m[2] } : { title: s, text: '' }; };
const FORMAT_NAMES = { Reel: 'Reel', Carousel: 'Carousel', Video: 'Video', Image: 'Photo', Sidecar: 'Carousel' };

function docPostCard(c, extra = {}) {
    if (!c) return null;
    const idx = docNum(c.index);
    return {
        kind: FORMAT_NAMES[c.type] || c.type || 'Post',
        title: oneLine(c.caption, 90) || 'No caption',
        meta: [c.likes != null ? `${docFmt(c.likes)} likes` : null, c.comments != null ? `${docFmt(c.comments)} comments` : null, c.views ? `${docFmt(c.views)} views` : null].filter(Boolean).join(' · '),
        date: c.postedAt ? docDay(c.postedAt) : null,
        chip: idx === null ? null : { text: `${docX(idx)} typical`, tone: idx >= 1.2 ? 'good' : idx < 0.8 ? 'bad' : '' },
        image: c.image || null,
        link: /^https:\/\/(www\.)?instagram\.com\//.test(String(c.url || '')) ? c.url : null,
        ...extra
    };
}

function docPillarTone(p) { const s = p.max ? p.points / p.max : 0; return s >= 0.7 ? ['Strong', 'good'] : s <= 0.4 ? ['Weak', 'watch'] : ['Fair', 'gold']; }

function docHeat(h) {
    if (!h || !Array.isArray(h.cells) || !h.cells.length) return null;
    return { type: 'heat', title: 'Reactions by day and hour, against the account’s typical post',
        cells: h.cells.filter(c => c.posts > 0).map(c => ({ dow: c.dow, hour: c.hour, value: docNum(c.medIndex) ?? docNum(c.avgIndex) ?? 0, posts: c.posts })),
        note: h.reliable === false ? 'Fewer than 20 posts: read this as a hint, not a rule.' : 'Darker is stronger. Times are the account’s own time zone.' };
}

/** The Instagram audit (ig_report): one account, public data. */
function igDoc(row) {
    const j = row.report_json || {};
    const m = j.main || {};
    if (!m.handle) return null;
    const ai = row.ai_json || j.ai || {};
    const bench = j.benchmark || null;
    const cad = m.cadence || {};
    const mix = m.contentMix || {};
    const reel = mix.Reel || null;
    const pillars = (m.scoreBreakdown && m.scoreBreakdown.breakdown) || [];
    const summary = String(ai.executive_summary || '').trim();
    const firstStop = summary.search(/(?<=[.!?])\s/);
    const sections = [];

    sections.push({ title: 'At a glance', source: ['pub', 'ai'], blocks: [
        { type: 'kpis', items: [
            { label: 'Engagement, typical post', value: docPct(m.engagementRateMedian ?? m.engagementRate, 2), sub: bench ? `local average ${docPct(bench.cohort.avgEngagementRate, 2)}` : `average post ${docPct(m.engagementRate, 2)}`, tone: bench && parseFloat(m.engagementRate) >= parseFloat(bench.cohort.avgEngagementRate) ? 'good' : '' },
            { label: 'Posts a week', value: docNum(cad.postsPerWeek) === null ? '—' : String(cad.postsPerWeek), sub: bench ? `local average ${bench.cohort.avgPostsPerWeek}` : `${docFmt(cad.postsPerMonth)} a month` },
            reel && reel.avgViews ? { label: 'Views per Reel', value: docFmt(reel.avgViews), sub: `${reel.count} Reels read` } : { label: 'Average likes', value: docFmt(m.avgLikes), sub: `${docFmt(m.avgComments)} comments` },
            { label: 'Last post', value: cad.lastPostDaysAgo == null ? '—' : `${Math.round(cad.lastPostDaysAgo)} days ago`, sub: cad.longestGapDays != null ? `longest gap ${Math.round(cad.longestGapDays)} days` : '', tone: cad.silent ? 'bad' : '' }
        ] },
        summary ? { type: 'verdict', text: firstStop > 0 ? summary.slice(0, firstStop) : summary } : null,
        summary && firstStop > 0 ? { type: 'prose', paras: [summary.slice(firstStop + 1).trim()] } : null,
        bench ? { type: 'bars', title: 'Score out of 100', max: 100, rows: [{ label: 'This account', value: m.score, tone: 'good' }, { label: 'Local average', value: bench.cohort.avgScore, tone: 'gold' }] } : null
    ] });

    if (pillars.length) sections.push({ title: 'How the score is built', lead: `${m.score}/100, grade ${m.grade}. Each part is scored against what works for accounts this size.`, source: ['pub'], blocks: [
        { type: 'table', cols: [{ label: 'Part' }, { label: 'Points', num: true }, { label: 'What we found' }, { label: '' }],
          rows: pillars.map(p => { const [w, t] = docPillarTone(p); return [p.pillar, `${docFmt(p.points)} / ${p.max}`, p.detail || '', { chip: w, tone: t }]; }) }
    ] });

    const mixRows = Object.entries(mix).sort((a, b) => b[1].count - a[1].count);
    const flags = (m.flags || []).filter(f => f.reliable && f.lift != null).sort((a, b) => b.lift - a.lift).slice(0, 4);
    if (mixRows.length) sections.push({ title: 'What you post, and what works', source: ['pub'], blocks: [
        { type: 'table', cols: [{ label: 'Format' }, { label: 'Posts', num: true }, { label: 'Avg likes', num: true }, { label: 'Avg comments', num: true }, { label: 'Avg views', num: true }, { label: 'vs typical', num: true }],
          rows: mixRows.map(([k, v]) => [FORMAT_NAMES[k] || k, v.count, docFmt(v.avgLikes), docFmt(v.avgComments), v.avgViews ? docFmt(v.avgViews) : '—', { text: docX(v.avgIndex), tone: v.avgIndex >= 1.2 ? 'good' : v.avgIndex < 0.8 ? 'bad' : '' }]),
          note: '“vs typical” compares each post with the account’s own median post, so one viral post cannot skew it.' },
        flags.length ? { type: 'bars', title: 'Captions that earned more', max: Math.max(...flags.map(f => 1 + f.lift / 100)) * 1.1, unit: 'x', rows: flags.map(f => ({ label: f.with.label, value: +(1 + f.lift / 100).toFixed(2), tone: f.lift >= 0 ? 'good' : 'watch' })) } : null
    ] });

    const top = (m.topPosts || []).slice(0, 3), low = (m.bottomPosts || []).slice(0, 1);
    if (top.length) sections.push({ title: 'Best and weakest posts', source: ['pub'], blocks: [
        { type: 'posts', items: [...top.map(c => docPostCard(c)), ...low.map(c => docPostCard(c, { weak: true }))] }
    ] });

    const heat = docHeat(m.heatmap);
    const bh = m.heatmap && m.heatmap.bestHours && m.heatmap.bestHours[0], bd = m.heatmap && m.heatmap.bestDays && m.heatmap.bestDays[0];
    const hourName = h => { const x = Number(h); return `${(x % 12) || 12}${x < 12 ? ' am' : ' pm'}`; };
    if (heat) sections.push({ title: 'When your audience responds', source: ['pub'], blocks: [
        { type: 'row', blocks: [heat, { type: 'kpis', cols: 1, items: [
            bd ? { label: 'Best day', value: bd.dowName, sub: bd.medIndex != null ? `${docX(bd.medIndex)} typical` : '', tone: 'good' } : null,
            bh ? { label: 'Best hour', value: hourName(bh.hour), sub: bh.medIndex != null ? `${docX(bh.medIndex)} typical` : '', tone: 'good' } : null
        ].filter(Boolean) }] }
    ] });

    const months = ((m.momentum && m.momentum.months) || []).filter(x => x.posts);
    if (months.length >= 2) sections.push({ title: 'Consistency and momentum', source: ['pub'], blocks: [
        { type: 'row', blocks: [
            { type: 'line', title: 'Median reactions per post, by month', labels: months.map(x => new Date(x.month + '-01T00:00:00Z').toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })), series: [{ name: m.handle, values: months.map(x => x.medEngagement || 0) }] },
            { type: 'kpis', cols: 2, items: [
                { label: 'Posts a month', value: docFmt(cad.postsPerMonth) }, { label: 'Median gap', value: cad.medianGapDays == null ? '—' : `${cad.medianGapDays} days` },
                { label: 'Longest gap', value: cad.longestGapDays == null ? '—' : `${Math.round(cad.longestGapDays)} days` },
                { label: 'Momentum', value: m.momentum && m.momentum.changePct != null ? `${m.momentum.changePct > 0 ? '+' : ''}${m.momentum.changePct}%` : '—', tone: m.momentum && m.momentum.changePct > 0 ? 'good' : m.momentum && m.momentum.changePct < 0 ? 'bad' : '' }
            ] }
        ] },
        { type: 'note', text: 'A month still running is left out of the trend; momentum compares complete months.' }
    ] });

    const tags = (m.topHashtags || []).slice(0, 6);
    const checks = (m.completeness && m.completeness.checks) || [];
    if (tags.length || checks.length) sections.push({ title: 'Hashtags and your profile', source: ['pub'], blocks: [
        { type: 'row', blocks: [
            tags.length ? { type: 'table', cols: [{ label: 'Hashtag' }, { label: 'Uses', num: true }, { label: 'vs typical', num: true }], rows: tags.map(t => [t.tag, t.uses, { text: docX(t.avgIndex), tone: t.avgIndex >= 1 ? 'good' : 'bad' }]) } : null,
            checks.length ? { type: 'checks', title: `Profile checklist · ${checks.filter(c => c.ok).length} of ${checks.length}`, items: checks.map(c => ({ label: c.label, ok: !!c.ok })) } : null
        ].filter(Boolean) }
    ] });

    const strengths = docLines(ai.strengths), weaknesses = docLines(ai.weaknesses);
    if (strengths.length || weaknesses.length) sections.push({ title: 'What is working, what to fix', source: ['ai', 'pub'], blocks: [
        { type: 'row', blocks: [
            { type: 'points', title: 'What is working', tone: 'good', items: strengths.slice(0, 4).map(docPoint) },
            { type: 'points', title: 'What to fix', tone: 'watch', items: weaknesses.slice(0, 4).map(docPoint) }
        ] }
    ] });

    const plan = (Array.isArray(ai.action_plan_30_days) ? ai.action_plan_30_days : []).slice(0, 4).map(w => ({ week: oneLine(w.week, 30), actions: docLines(w.actions).slice(0, 4) })).filter(w => w.actions.length);
    const kt = ai.kpi_targets || {};
    const reelShare = reel ? parseFloat(reel.share) : null;
    if (plan.length) sections.push({ title: '30-day plan and targets', source: ['ai'], blocks: [
        { type: 'weeks', items: plan },
        (kt.engagement_rate || kt.posts_per_week || kt.reels_share) ? { type: 'table', cols: [{ label: 'Target, 30 days' }, { label: 'Now', num: true }, { label: 'Target', num: true }], rows: [
            kt.engagement_rate ? ['Engagement rate', docPct(m.engagementRate, 2), oneLine(kt.engagement_rate, 20)] : null,
            kt.posts_per_week ? ['Posts a week', String(cad.postsPerWeek ?? '—'), oneLine(kt.posts_per_week, 20)] : null,
            kt.reels_share ? ['Share of Reels', reelShare === null ? '—' : `${reelShare}%`, oneLine(kt.reels_share, 20)] : null
        ].filter(Boolean) } : null
    ] });

    return docFinish({
        type: 'ig_report',
        cover: { kind: `Instagram audit · ${docMonth(row.created_at)}`, title: m.fullName || `@${m.handle}`,
            sub: `@${m.handle} · ${m.postsAnalyzed || cad.spanDays ? `the last ${m.postsAnalyzed ? m.postsAnalyzed + ' public posts' : cad.spanDays + ' days of posts'}` : 'recent public posts'}${bench ? `, scored against ${bench.cohort.accounts - 1} local account${bench.cohort.accounts === 2 ? '' : 's'}` : ''}.`,
            receipt: [[m.grade || '—', 'grade'], [`${docFmt(m.score)}/100`, 'account score'], [docFmt(m.postsAnalyzed), 'posts read'], [docFmt(m.followers), 'followers']],
            builtAt: j.generatedAt || row.created_at },
        sections,
        about: [
            `Built from the account’s public Instagram posts, collected ${docDay(j.generatedAt || row.created_at)}. Likes, comments and Reel views are what Instagram shows publicly.`,
            'Reach, saves, shares, profile visits and audience are visible only to the account owner, so they are not estimated here. Connecting Meta adds them to the monthly report.',
            'Each post is compared with the account’s own typical post, so one viral post cannot redraw the picture. Written sections are by AI from these numbers only.'
        ]
    });
}

/** Competitor intelligence (deep_audit): the client and its rivals, ranked on one scale. */
function ciDoc(row) {
    const j = row.report_json || {};
    const m = j.main || {};
    const b = j.benchmark;
    if (!m.handle || !b || !Array.isArray(b.ranked) || b.ranked.length < 2) return null;
    const ai = row.ai_json || j.ai || {};
    const all = [m, ...(j.rivals || [])];
    const byHandle = Object.fromEntries(all.map(a => [a.handle, a]));
    const n = b.ranked.length;
    const me = b.ranked.find(r => r.isTarget) || {};
    const rankOn = k => 1 + all.filter(a => parseFloat(a[k]) > parseFloat(m[k])).length;
    const reelViews = a => (a.contentMix && a.contentMix.Reel && a.contentMix.Reel.avgViews) || null;
    const standing = clientStanding({ engagement_rate: m.engagementRate }, b, m);
    const best = [...b.ranked].filter(r => !r.isTarget)[0];
    const sections = [];

    sections.push({ title: 'The leaderboard', source: ['pub'], blocks: [
        { type: 'table', highlight: b.ranked.findIndex(r => r.isTarget),
          cols: [{ label: 'Rank' }, { label: 'Account' }, { label: 'Score', num: true }, { label: 'Followers', num: true }, { label: 'Engagement', num: true }, { label: 'Posts a week', num: true }, { label: 'Views per Reel', num: true }],
          rows: b.ranked.map(r => [`#${r.rank}`, `@${r.handle}${r.isTarget ? ' (you)' : ''}`, `${r.score} · ${r.grade}`, docFmt(r.followers), docPct(r.engagementRate, 2), r.postsPerWeek, docFmt(reelViews(byHandle[r.handle] || {}))]) },
        standing.verdict ? { type: 'verdict', text: `${standing.verdict} ${rankOn('engagementRate') === 1 ? 'You get the most reactions per follower of the group.' : ''}`.trim() } : null
    ] });

    const cohortEr = parseFloat(b.cohort.avgEngagementRate), cohortPpw = parseFloat(b.cohort.avgPostsPerWeek);
    sections.push({ title: 'Where the gaps are', lead: 'This account against the group average and the account ranked first.', source: ['pub'], blocks: [
        { type: 'row', blocks: [
            { type: 'bars', title: 'Engagement rate', unit: '%', rows: [{ label: 'You', value: parseFloat(m.engagementRate), tone: 'good' }, { label: 'Group average', value: cohortEr, tone: 'gold' }, best ? { label: `@${best.handle}`, value: parseFloat(best.engagementRate), tone: 'muted' } : null].filter(Boolean) },
            { type: 'bars', title: 'Posts a week', rows: [{ label: 'You', value: parseFloat(m.postsPerWeek), tone: parseFloat(m.postsPerWeek) >= cohortPpw ? 'good' : 'watch' }, { label: 'Group average', value: cohortPpw, tone: 'gold' }, best ? { label: `@${best.handle}`, value: parseFloat(best.postsPerWeek), tone: 'muted' } : null].filter(Boolean) },
            { type: 'bars', title: 'Account score', max: 100, rows: [{ label: 'You', value: m.score, tone: 'good' }, { label: 'Group average', value: b.cohort.avgScore, tone: 'gold' }, best ? { label: `@${best.handle}`, value: best.score, tone: 'muted' } : null].filter(Boolean) }
        ] }
    ] });

    const share = (a, k) => { const v = a.contentMix && a.contentMix[k]; return v ? v.share : '0%'; };
    const bestFormat = a => { const e = Object.entries(a.contentMix || {}).filter(([, v]) => v.count >= 2).sort((x, y) => y[1].avgIndex - x[1].avgIndex)[0]; return e ? `${FORMAT_NAMES[e[0]] || e[0]} · ${docX(e[1].avgIndex)}` : '—'; };
    sections.push({ title: 'The format battle', lead: 'What each account posts, and which format earns it the most against its own typical post.', source: ['pub'], blocks: [
        { type: 'table', highlight: b.ranked.findIndex(r => r.isTarget),
          cols: [{ label: 'Account' }, { label: 'Reels', num: true }, { label: 'Carousels', num: true }, { label: 'Photos', num: true }, { label: 'Best format' }],
          rows: b.ranked.map(r => { const a = byHandle[r.handle] || {}; return [`@${r.handle}`, share(a, 'Reel'), share(a, 'Carousel'), share(a, 'Image'), bestFormat(a)]; }) }
    ] });

    const rivalPosts = (j.rivals || []).map(a => a.topPosts && a.topPosts[0] ? docPostCard(a.topPosts[0], { by: `@${a.handle}` }) : null).filter(Boolean).slice(0, 4);
    if (rivalPosts.length) sections.push({ title: 'Rivals’ best posts', lead: 'What is working for them right now.', source: ['pub'], blocks: [{ type: 'posts', items: rivalPosts }] });

    const gaps = (b.hashtagGaps || []).slice(0, 6);
    const timing = (j.rivals || []).map(a => { const d = a.heatmap && a.heatmap.bestDays && a.heatmap.bestDays[0]; const h = a.heatmap && a.heatmap.bestHours && a.heatmap.bestHours[0]; return d || h ? `@${a.handle}: ${[d && d.dowName, h && `${(h.hour % 12) || 12}${h.hour < 12 ? ' am' : ' pm'}`].filter(Boolean).join(', ')}` : null; }).filter(Boolean);
    if (gaps.length || timing.length) sections.push({ title: 'Hashtags they use and you do not', source: ['pub'], blocks: [
        { type: 'row', blocks: [
            gaps.length ? { type: 'table', cols: [{ label: 'Hashtag' }, { label: 'Rivals using it', num: true }, { label: 'Their avg engagement', num: true }], rows: gaps.map(g => [g.tag, g.usedBy, docFmt(g.avgEngagement)]) } : null,
            timing.length ? { type: 'points', title: 'When rivals do best', items: timing.map(t => ({ title: t, text: '' })) } : null
        ].filter(Boolean) }
    ] });

    const insights = docLines(ai.competitor_insights), strategy = docLines(ai.content_strategy);
    if (insights.length || strategy.length) sections.push({ title: `What this means for @${m.handle}`, source: ['ai', 'pub'], blocks: [
        { type: 'row', blocks: [
            insights.length ? { type: 'points', title: 'What rivals do that you do not', tone: 'watch', items: insights.slice(0, 4).map(docPoint) } : null,
            strategy.length ? { type: 'points', title: 'Moves to make', tone: 'good', items: strategy.slice(0, 4).map(docPoint) } : null
        ].filter(Boolean) }
    ] });

    const plan = (Array.isArray(ai.action_plan_30_days) ? ai.action_plan_30_days : []).slice(0, 4).map(w => ({ week: oneLine(w.week, 30), actions: docLines(w.actions).slice(0, 4) })).filter(w => w.actions.length);
    if (plan.length) sections.push({ title: '30-day plan', source: ['ai'], blocks: [{ type: 'weeks', items: plan }] });

    return docFinish({
        type: 'deep_audit',
        cover: { kind: `Competitor intelligence · ${docMonth(row.created_at)}`, title: `@${m.handle} against ${n - 1} rival${n === 2 ? '' : 's'}`,
            sub: `${n} accounts read on the same day and scored on the same scale: ${b.ranked.map(r => '@' + r.handle).join(', ')}.`,
            receipt: [[me.rank ? ordinal(me.rank) : '—', `of ${n} overall`], [ordinal(rankOn('engagementRate')), 'on engagement'], [ordinal(rankOn('postsPerWeek')), 'on posting volume'], [docFmt(all.reduce((s, a) => s + (a.postsAnalyzed || 0), 0)), 'posts compared']],
            builtAt: j.generatedAt || row.created_at },
        sections,
        about: [
            `Every account was read on ${docDay(j.generatedAt || row.created_at)} from its public Instagram posts. All figures are public counts, scored by the same rules for every account.`,
            'The client’s own Meta numbers never appear here: rivals have none to compare with.',
            'Written sections are by AI from these numbers only.'
        ]
    });
}

/** The Facebook Page report (fb_page): one Page, or one Page against a rival (phase 37). */
function fbDoc(row) {
    const j = row.report_json || {};
    const t = j.target || {};
    if (!t.name && !t.pageId) return null;
    const ai = row.ai_json || j.ai || {};
    const rv = j.rival || null, bm = j.benchmark || null;
    const cad = t.cadence || {};
    const nice = k => String(k || '').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
    const name = t.name || 'This Page';
    const summary = String(ai.executive_summary || '').trim();
    const firstStop = summary.search(/(?<=[.!?])\s/);
    const state = Array.isArray(ai.state_of_the_page) ? docLines(ai.state_of_the_page)[0] : oneLine(ai.state_of_the_page, 300);
    const sections = [];

    sections.push({ title: 'At a glance', source: ['pub', 'ai'], blocks: [
        { type: 'kpis', items: [
            { label: 'Engagement per post', value: docFmt(t.medians && t.medians.engagement), sub: 'median reactions, comments and shares' },
            { label: 'Comments per 100 reactions', value: docNum(t.conversationRate) === null ? '—' : String(t.conversationRate), sub: t.conversationRate < 2 ? 'people react but rarely talk' : 'people talk back', tone: t.conversationRate < 2 ? 'watch' : 'good' },
            { label: 'Shares per 100 reactions', value: docNum(t.amplificationRate) === null ? '—' : String(t.amplificationRate), sub: t.amplificationRate > 8 ? 'strong word of mouth' : 'how often posts are passed on', tone: t.amplificationRate > 8 ? 'good' : '' },
            { label: 'Posts a week', value: docNum(cad.postsPerWeek) === null ? '—' : String(cad.postsPerWeek), sub: rv && rv.cadence ? `${rv.name} posts ${rv.cadence.postsPerWeek}` : (cad.lastPostDaysAgo != null ? `last post ${Math.round(cad.lastPostDaysAgo)} days ago` : ''), tone: cad.silent ? 'bad' : '' }
        ] },
        state || summary ? { type: 'verdict', text: state || (firstStop > 0 ? summary.slice(0, firstStop) : summary) } : null,
        summary ? { type: 'prose', paras: [state ? summary : (firstStop > 0 ? summary.slice(firstStop + 1).trim() : '')].filter(Boolean) } : null
    ] });

    const checks = (t.completeness && t.completeness.checks) || [];
    const sent = t.sentiment && t.sentiment.available ? t.sentiment : null;
    if (checks.length || sent) sections.push({ title: 'Page health', source: ['pub'], blocks: [
        { type: 'row', blocks: [
            checks.length ? { type: 'checks', title: `Page checklist · ${checks.filter(c => c.ok).length} of ${checks.length}`, items: checks.map(c => ({ label: c.label, ok: !!c.ok })) } : null,
            sent ? { type: 'bars', title: 'How people react', unit: '%', max: 100, rows: [
                sent.positiveShare != null ? { label: 'Warm reactions (love, care, wow)', value: sent.positiveShare, tone: 'good' } : null,
                sent.negativeShare != null ? { label: 'Negative reactions (sad, angry)', value: sent.negativeShare, tone: 'bad' } : null,
                sent.highEffortShare != null ? { label: 'Reactions beyond a Like', value: sent.highEffortShare, tone: 'gold' } : null
            ].filter(Boolean) } : null
        ].filter(Boolean) },
        t.rating ? { type: 'note', text: `Rated ${t.rating} out of 5${t.reviewsCount ? ` from ${docFmt(t.reviewsCount)} reviews` : ''}.` } : null
    ] });

    const formats = (t.formats || []).slice(0, 6), intents = (t.intents || []).slice(0, 5);
    if (formats.length || intents.length) sections.push({ title: 'What you post, and what works', source: ['pub'], blocks: [
        { type: 'row', blocks: [
            formats.length ? { type: 'table', title: 'By format', cols: [{ label: 'Format' }, { label: 'Posts', num: true }, { label: 'Avg engagement', num: true }, { label: 'vs typical', num: true }],
                rows: formats.map(f => [nice(f.key), f.posts, docFmt(f.avgEngagement), { text: docX(f.avgIndex), tone: f.avgIndex >= 1.2 ? 'good' : f.avgIndex < 0.8 ? 'bad' : '' }]) } : null,
            intents.length ? { type: 'bars', title: 'By what the post is for', unit: 'x', rows: intents.map(i => ({ label: nice(i.key), value: i.avgIndex, tone: i.avgIndex >= 1.2 ? 'good' : i.avgIndex < 0.8 ? 'watch' : 'gold' })) } : null
        ].filter(Boolean) },
        t.video && t.video.posts ? { type: 'note', text: `Video is ${t.video.share}% of posts at ${docX(t.video.avgIndex)} typical${t.video.avgViews ? `, averaging ${docFmt(t.video.avgViews)} views where Facebook shows them` : ''}.` } : null
    ] });

    const top = (t.topPosts || []).slice(0, 3);
    if (top.length) sections.push({ title: 'Best posts', lead: 'What earned the most, word for word.', source: ['pub'], blocks: [
        { type: 'quotes', items: top.map(p => ({ tag: `${nice(p.format)}${p.postedAt ? ' · ' + docDay(p.postedAt) : ''}`, text: oneLine(p.excerpt, 240) || '(no text)', meta: [p.reactions != null ? `${docFmt(p.reactions)} reactions` : null, p.comments != null ? `${docFmt(p.comments)} comments` : null, p.shares != null ? `${docFmt(p.shares)} shares` : null, p.views ? `${docFmt(p.views)} views` : null].filter(Boolean).join(' · '), chip: docNum(p.index) === null ? null : { text: `${docX(p.index)} typical`, tone: 'good' }, link: /^https:\/\/(www\.|m\.)?facebook\.com\//.test(String(p.url || '')) ? p.url : null })) }
    ] });

    const heat = docHeat(t.heatmap);
    const months = ((t.momentum && t.momentum.months) || []).filter(x => x.posts);
    if (heat || months.length >= 2) sections.push({ title: 'Timing and momentum', source: ['pub'], blocks: [
        { type: 'row', blocks: [
            heat ? { ...heat, title: 'Engagement by day and hour' } : null,
            months.length >= 2 ? { type: 'line', title: 'Median engagement per post, by month', labels: months.map(x => new Date(x.month + '-01T00:00:00Z').toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })), series: [{ name, values: months.map(x => x.medEngagement ?? x.avgEngagement ?? 0) }] } : null
        ].filter(Boolean) }
    ] });

    if (bm && rv) {
        const lead = r => r.winner === 'target' ? { chip: name, tone: 'good' } : r.winner === 'rival' ? { chip: rv.name, tone: 'watch' } : { chip: 'Level', tone: '' };
        const show = v => v === null || v === undefined ? '—' : (Number.isFinite(Number(v)) ? Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(v));
        sections.push({ title: `Against ${rv.name}`, lead: bm.verdict, source: ['pub'], blocks: [
            { type: 'table', cols: [{ label: 'Measure' }, { label: name, num: true }, { label: rv.name, num: true }, { label: 'Leader' }], rows: bm.rows.slice(0, 12).map(r => [r.metric, show(r.target), show(r.rival), lead(r)]) },
            bm.shareOfVoice ? { type: 'bars', title: 'Share of all engagement between the two Pages', unit: '%', max: 100, rows: [{ label: name, value: bm.shareOfVoice.target, tone: 'good' }, { label: rv.name, value: bm.shareOfVoice.rival, tone: 'gold' }] } : null,
            (bm.formatGaps || []).length ? { type: 'note', text: `${rv.name} does well with ${bm.formatGaps.map(g => `${nice(g.format)} (${docX(g.rivalIndex)})`).join(', ')}, which ${name} barely posts.` } : null
        ] });
    }

    const recs = (Array.isArray(j.recommendations) ? j.recommendations : []).filter(r => r && r.title).slice(0, 6);
    const P = { critical: ['Critical', 'bad'], high: ['High', 'watch'], medium: ['Medium', 'gold'], low: ['Low', ''] };
    const quick = docLines(ai.quick_wins);
    if (recs.length || quick.length) sections.push({ title: 'Recommendations', lead: 'In order of priority.', source: ['pub', 'ai'], blocks: [
        recs.length ? { type: 'table', cols: [{ label: 'Priority' }, { label: 'Action' }, { label: 'Why' }], rows: recs.map(r => [{ chip: (P[r.priority] || P.low)[0], tone: (P[r.priority] || P.low)[1] }, oneLine(r.action || r.title, 200), oneLine(r.why, 240) || '—']) } : null,
        quick.length ? { type: 'points', title: 'Quick wins', tone: 'good', items: quick.slice(0, 4).map(docPoint) } : null
    ] });

    const working = docLines(ai.what_is_working), failing = docLines(ai.what_is_failing);
    if (working.length || failing.length) sections.push({ title: 'What is working, what is not', source: ['ai', 'pub'], blocks: [
        { type: 'row', blocks: [
            { type: 'points', title: 'What is working', tone: 'good', items: working.slice(0, 4).map(docPoint) },
            { type: 'points', title: 'What is holding the Page back', tone: 'watch', items: failing.slice(0, 4).map(docPoint) }
        ] }
    ] });

    const plan = (Array.isArray(ai.thirty_day_plan) ? ai.thirty_day_plan : []).slice(0, 4).map(w => ({ week: oneLine(w.week, 30), actions: docLines(w.actions).slice(0, 4) })).filter(w => w.actions.length);
    const kpis = (Array.isArray(ai.kpis_to_watch) ? ai.kpis_to_watch : []).filter(k => k && k.kpi).slice(0, 5);
    if (plan.length || kpis.length) sections.push({ title: '30-day plan and what we will watch', source: ['ai'], blocks: [
        plan.length ? { type: 'weeks', items: plan } : null,
        kpis.length ? { type: 'table', cols: [{ label: 'Watch' }, { label: 'Now', num: true }, { label: 'In 30 days', num: true }], rows: kpis.map(k => [oneLine(k.kpi, 80), oneLine(k.current, 30) || '—', oneLine(k.target, 30) || '—']) } : null
    ] });

    return docFinish({
        type: 'fb_page',
        cover: { kind: `Facebook Page report · ${docMonth(row.created_at)}`, title: name,
            sub: `${t.category ? t.category + ' · ' : ''}the last ${docFmt(j.windowDays || cad.spanDays)} days of public posts${rv ? `, set against ${rv.name}` : ''}.`,
            receipt: [[t.grade || '—', 'Page grade'], [t.rating ? `${t.rating}★` : '—', t.reviewsCount ? `${docFmt(t.reviewsCount)} reviews` : 'rating'], [docFmt(t.postsAnalyzed), 'posts read'], [docFmt(t.followers), 'followers']],
            builtAt: j.generatedAt || row.created_at },
        sections,
        about: [
            `Built from the Page’s public posts and details, collected ${docDay(j.generatedAt || row.created_at)}. Reactions, comments, shares and (where Facebook shows them) video views are public counts.`,
            'Reach, impressions, clicks and Page visits are visible only to the Page owner and are not estimated. Connecting Meta adds them to the monthly report.',
            'Written sections are by AI from these numbers only.'
        ]
    });
}

/**
 * The Facebook groups read (fb_community, several rooms) or one room
 * (fb_group). Public posts only; the members who wrote them are never named.
 */
function fbGroupsDoc(row) {
    const j = row.report_json || {};
    const single = row.report_type === 'fb_group' || j.mode === 'individual';
    const groups = (single ? [j.group] : (j.groups || [])).filter(g => g && g.postsAnalyzed > 0);
    if (!groups.length) return null;
    const bm = single ? null : j.benchmark || null;
    const ai = row.ai_json || j.ai || {};
    const nice = k => String(k || '').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
    const tone = x => (x >= 1.2 ? 'good' : x < 0.8 ? 'bad' : '');
    const g0 = groups[0];
    const members = groups.reduce((s, g) => s + (g.memberCount || 0), 0);
    const posts = groups.reduce((s, g) => s + g.postsAnalyzed, 0);
    const demand = groups.reduce((s, g) => s + (g.demandSignals || 0), 0);
    const score = single ? g0.roomValue : (bm ? bm.avgRoomValue : Math.round(groups.reduce((s, g) => s + g.roomValue, 0) / groups.length));
    const verdictOf = name => (Array.isArray(ai.room_verdicts) ? ai.room_verdicts : []).find(v => v && String(v.group || '').toLowerCase() === String(name || '').toLowerCase());
    const V = { 'work it': ['Work it', 'good'], 'test it': ['Test it', 'gold'], 'skip it': ['Skip it', 'bad'] };
    const call = g => { const v = verdictOf(g.name); const k = v && String(v.verdict || '').toLowerCase().trim(); return V[k] || (g.roomValue >= 50 ? V['work it'] : g.roomValue >= 30 ? V['test it'] : V['skip it']); };
    const summary = String(ai.executive_summary || '').trim();
    const firstStop = summary.search(/(?<=[.!?])\s/);
    const sections = [];

    const worth = groups.filter(g => g.roomValue >= 50).length;
    const medComments = pmMedian(groups.map(g => g.medianComments));
    sections.push({ title: 'At a glance', source: ['pub', 'ai'], blocks: [
        { type: 'kpis', items: [
            single ? { label: 'Group score', value: `${docFmt(g0.roomValue)}/100`, sub: g0.roomValueBreakdown && g0.roomValueBreakdown.verdict, tone: g0.roomValue >= 50 ? 'good' : g0.roomValue < 30 ? 'bad' : 'watch' }
                   : { label: 'Groups worth working', value: `${worth} of ${groups.length}`, sub: bm && bm.bestRoom ? `best: ${bm.bestRoom.name}` : '', tone: worth ? 'good' : 'watch' },
            { label: 'Buying signals', value: docFmt(demand), sub: `${docPct(posts ? demand / posts * 100 : null)} of posts ask to buy or for a recommendation`, tone: demand ? 'good' : '' },
            { label: 'Comments per post', value: docFmt(medComments), sub: medComments >= 5 ? 'people talk here' : 'quiet threads', tone: medComments >= 5 ? 'good' : 'watch' },
            { label: 'Posts a day', value: String(+groups.reduce((s, g) => s + (g.postsPerDay || 0), 0).toFixed(1)), sub: single ? `across ${docFmt(g0.windowDays)} days read` : 'all groups together' }
        ] },
        summary ? { type: 'verdict', text: firstStop > 0 ? summary.slice(0, firstStop) : summary } : null,
        summary && firstStop > 0 ? { type: 'prose', paras: [summary.slice(firstStop + 1).trim()] } : null
    ] });

    if (single) {
        const b = g0.roomValueBreakdown || {};
        const pc = v => (docNum(v) === null ? null : Math.round(v * 100));
        sections.push({ title: 'Is this group worth your time', lead: b.verdict ? String(b.verdict).replace(/\broom\b/gi, 'group') : null, source: ['pub'], blocks: [
            { type: 'row', blocks: [
                { type: 'bars', title: 'What the score is made of', unit: '%', max: 100, rows: [
                    { label: 'Lively (posts a day)', value: pc(b.liveness), tone: 'gold' },
                    { label: 'Conversation (comments)', value: pc(b.conversation), tone: 'gold' },
                    { label: 'Many voices, not a few', value: pc(b.diversity), tone: 'gold' },
                    { label: 'People asking to buy', value: pc(b.demand), tone: 'good' }
                ].filter(r => r.value !== null) },
                { type: 'checks', title: 'Posting here', items: [
                    { label: g0.promoAllowed === false ? 'Promotion is banned: value posts and answers only' : 'Promotion is allowed', ok: g0.promoAllowed !== false },
                    { label: g0.approvalRequired ? 'Posts wait for admin approval' : 'Posts go up straight away', ok: !g0.approvalRequired },
                    { label: `${docFmt(g0.postsAnalyzed)} posts read${b.lowConfidence ? ': too few to be sure' : ''}`, ok: !b.lowConfidence },
                    { label: `${docFmt(g0.uniquePosters)} different people posted`, ok: (g0.uniquePosterRatio || 0) >= 0.5 }
                ] }
            ] },
            g0.memberCount ? { type: 'note', text: `${docFmt(g0.memberCount)} members${g0.adminShare ? `; admins wrote ${g0.adminShare}% of posts` : ''}.` } : null
        ] });
    } else if (bm && (bm.ranked || []).length) {
        sections.push({ title: 'Which groups are worth your time', lead: 'Ranked by group score: how lively, how talkative, how varied, and how often people ask to buy.', source: ['pub', 'ai'], blocks: [
            { type: 'table', cols: [{ label: 'Group' }, { label: 'Members', num: true }, { label: 'Posts a day', num: true }, { label: 'Comments', num: true }, { label: 'Buying signals', num: true }, { label: 'Score', num: true }, { label: 'Our call' }],
                rows: bm.ranked.slice(0, 15).map(r => { const c = call(r); return [oneLine(r.name, 60), docFmt(r.members), String(r.postsPerDay ?? '—'), docFmt(r.medianComments), docFmt(r.demandSignals), r.lowConfidence ? { text: `${r.roomValue}*`, tone: 'watch' } : { text: String(r.roomValue), tone: r.roomValue >= 50 ? 'good' : r.roomValue < 30 ? 'bad' : '' }, { chip: c[0], tone: c[1] }]; }) },
            bm.ranked.some(r => r.lowConfidence) ? { type: 'note', text: '* Fewer than 15 posts were public: read that score as a first look.' } : null,
            (Array.isArray(ai.room_verdicts) ? ai.room_verdicts : []).length ? { type: 'points', title: 'Why', items: ai.room_verdicts.filter(v => v && v.group && v.why).slice(0, 6).map(v => ({ title: oneLine(v.group, 60), text: oneLine(v.why, 240) })) } : null
        ] });
    }

    const cats = (single ? g0.demandCategories : bm && bm.demandCategories) || [];
    const kws = ((single ? g0.demandKeywords : bm && bm.demandKeywords) || []).slice(0, 10);
    const unmet = docLines(ai.unmet_demand);
    if (demand || unmet.length) sections.push({ title: 'What people are asking to buy', lead: demand ? `${docFmt(demand)} posts asked for a product, a service or a recommendation.` : null, source: ['pub', 'ai'], blocks: [
        { type: 'row', blocks: [
            cats.length && demand ? { type: 'bars', title: 'Kinds of request', unit: '%', max: 100, rows: cats.slice(0, 6).map(c => ({ label: nice(c.category), value: +(c.count / demand * 100).toFixed(1), tone: 'good' })) } : null,
            kws.length ? { type: 'table', title: 'Words in those requests', cols: [{ label: 'Asked about' }, { label: 'Times', num: true }], rows: kws.map(k => [k.term, k.hits]) } : null
        ] },
        unmet.length ? { type: 'points', title: 'Asked for, and not well answered', tone: 'good', items: unmet.slice(0, 5).map(docPoint) } : null
    ] });

    const formats = ((single ? g0.formats : bm && bm.formats) || []).slice(0, 6);
    const intents = ((single ? g0.intents : bm && bm.intents) || []).slice(0, 6);
    const openings = ((single ? g0.openings : bm && bm.openings) || []);
    const works = docLines(ai.what_works_here), fails = docLines(ai.what_fails_here);
    if (formats.length || intents.length || works.length) sections.push({ title: 'What gets a response here', source: ['pub', 'ai'], blocks: [
        { type: 'row', blocks: [
            formats.length ? { type: 'table', title: 'By format', cols: [{ label: 'Format' }, { label: 'Posts', num: true }, { label: 'vs typical', num: true }], rows: formats.map(f => [nice(f.key), f.posts, { text: docX(f.avgIndex), tone: tone(f.avgIndex) }]) } : null,
            intents.length ? { type: 'bars', title: 'By what the post is for', unit: 'x', rows: intents.map(i => ({ label: nice(i.key), value: i.avgIndex, tone: i.avgIndex >= 1.2 ? 'good' : i.avgIndex < 0.8 ? 'watch' : 'gold' })) } : null
        ] },
        openings[0] && openings[0].avgIndex >= 1.2 ? { type: 'note', text: `Posts that open with ${nice(openings[0].key).toLowerCase()} do best, at ${docX(openings[0].avgIndex)} typical.` } : null,
        works.length || fails.length ? { type: 'row', blocks: [
            { type: 'points', title: 'Works here', tone: 'good', items: works.slice(0, 4).map(docPoint) },
            { type: 'points', title: 'Falls flat here', tone: 'watch', items: fails.slice(0, 4).map(docPoint) }
        ] } : null
    ] });

    const top = groups.flatMap(g => (g.topPosts || []).slice(0, 3).map(p => ({ ...p, room: g.name })))
        .filter(p => oneLine(p.excerpt, 240)).sort((a, b) => (b.index || 0) - (a.index || 0))
        .filter((p, i, all) => all.findIndex(q => oneLine(q.excerpt, 120) === oneLine(p.excerpt, 120)) === i).slice(0, 4);
    if (top.length) sections.push({ title: 'Posts that did best', lead: 'Written by group members; shown for what they say, not who said it.', source: ['pub'], blocks: [
        { type: 'quotes', items: top.map(p => ({ tag: [single ? oneLine(nice(p.intent || p.format), 30) : oneLine(p.room, 34), p.postedAt ? docDay(p.postedAt) : null].filter(Boolean).join(' · '), text: oneLine(p.excerpt, 240), meta: [p.reactions != null ? `${docFmt(p.reactions)} reactions` : null, p.comments != null ? `${docFmt(p.comments)} comments` : null].filter(Boolean).join(' · '), chip: docNum(p.index) === null ? null : { text: `${docX(p.index)} typical`, tone: 'good' }, link: /^https:\/\/(www\.|m\.)?facebook\.com\//.test(String(p.url || '')) ? p.url : null })) }
    ] });

    const best = single ? g0 : (groups.find(g => bm && bm.bestRoom && g.groupId === bm.bestRoom.groupId) || groups.slice().sort((a, b) => b.roomValue - a.roomValue)[0]);
    const heat = docHeat(best.heatmap);
    const hours = ((best.heatmap && best.heatmap.bestHours) || []).filter(h => docNum(h.avgIndex) !== null).slice(0, 5);
    const play = (Array.isArray(ai.posting_playbook) ? ai.posting_playbook : []).filter(p => p && (p.room || p.angle)).slice(0, 8);
    if (heat || hours.length || play.length) sections.push({ title: 'When and how to post', source: ['pub', 'ai'], blocks: [
        { type: 'row', blocks: [
            heat ? { ...heat, title: single ? 'Response by day and hour' : `Response by day and hour in ${best.name}`, note: best.postsAnalyzed < 20 ? 'Fewer than 20 posts: read this as a hint, not a rule.' : `Darker is stronger. Local time.${best.approvalRequired ? ' Posts here wait for approval, so timing is approximate.' : ''}` } : null,
            hours.length ? { type: 'bars', title: 'Best hours to post', unit: 'x', rows: hours.map(h => ({ label: `${String(h.hour).padStart(2, '0')}:00 · ${docFmt(h.posts)} posts`, value: h.avgIndex, tone: h.avgIndex >= 1.2 ? 'good' : 'gold' })) } : null
        ] },
        play.length ? { type: 'table', title: 'Posting playbook', cols: [{ label: 'Group' }, { label: 'Post' }, { label: 'Angle' }, { label: 'When' }], rows: play.map(p => [oneLine(p.room, 50) || '—', [nice(p.format), nice(p.intent)].filter(x => x && x !== '').join(', ') || '—', oneLine(p.angle, 200) || '—', oneLine(p.best_time, 40) || '—']) } : null
    ] });

    const risks = docLines(ai.risks);
    if (!single || risks.length) sections.push({ title: 'Group rules and risks', source: ['pub', 'ai'], blocks: [
        single ? null : { type: 'table', cols: [{ label: 'Group' }, { label: 'Promotion' }, { label: 'Posting' }], rows: groups.slice(0, 15).map(g => [oneLine(g.name, 60), g.promoAllowed === false ? { chip: 'Banned', tone: 'bad' } : { chip: 'Allowed', tone: 'good' }, g.approvalRequired ? { chip: 'Admin approval', tone: 'watch' } : { chip: 'Straight away', tone: '' }]) },
        risks.length ? { type: 'points', title: 'Watch out for', tone: 'watch', items: risks.slice(0, 4).map(docPoint) } : null
    ] });

    const leads = docLines(ai.lead_actions);
    const plan = (Array.isArray(ai.next_30_days) ? ai.next_30_days : []).slice(0, 4).map(w => ({ week: oneLine(w.week, 30), actions: docLines(w.actions).slice(0, 4) })).filter(w => w.actions.length);
    if (leads.length || plan.length) sections.push({ title: 'Turning this into customers', source: ['ai'], blocks: [
        leads.length ? { type: 'points', title: 'This week', tone: 'good', items: leads.slice(0, 5).map(docPoint) } : null,
        plan.length ? { type: 'weeks', items: plan } : null
    ] });

    const where = [row.niche, row.location_label].filter(Boolean);
    return docFinish({
        type: single ? 'fb_group' : 'fb_community',
        cover: { kind: `${single ? 'Facebook group read' : 'Facebook groups read'} · ${docMonth(row.created_at)}`,
            title: single ? g0.name : (where.length ? `${row.niche ? nice(row.niche) + ' ' : ''}groups${row.location_label ? ' in ' + row.location_label : ''}` : `${groups.length} local Facebook groups`),
            sub: single ? `What this group talks about, what it asks to buy, and how to post in it.` : `Where your customers talk across ${groups.length} public groups, what they ask to buy, and how to show up.`,
            receipt: [[`${docFmt(score)}`, single ? 'group score' : 'average score'], [docFmt(members), 'members'], [docFmt(posts), 'posts read'], [docFmt(demand), 'buying signals']],
            builtAt: row.created_at },
        sections,
        about: [
            `Built from public posts in ${single ? 'this group' : 'these groups'}, read ${docDay(row.created_at)}. Private groups are never read.`,
            'Members are not named. A buying signal is a post asking for a product, a service or a recommendation.',
            'The group score (0 to 100) weighs how lively a group is, how much people comment, how many different people post, how often they ask to buy, and whether promotion is allowed. Thin samples are scored down.',
            'Written sections are by AI from these numbers only.'
        ]
    });
}

/** Drop empty blocks and sections, so a document only draws what it has. */
function docFinish(doc) {
    const keep = b => {
        if (!b) return false;
        if (b.type === 'row') { b.blocks = (b.blocks || []).filter(keep); return b.blocks.length > 0; }
        if (b.type === 'kpis') { b.items = (b.items || []).filter(Boolean); return b.items.length > 0; }
        if (['posts', 'points', 'weeks', 'checks', 'quotes'].includes(b.type)) return Array.isArray(b.items) && b.items.filter(Boolean).length > 0;
        if (b.type === 'table') return Array.isArray(b.rows) && b.rows.length > 0;
        if (b.type === 'bars') return Array.isArray(b.rows) && b.rows.length > 0;
        return true;
    };
    doc.sections = (doc.sections || []).map(s => ({ ...s, blocks: (s.blocks || []).filter(keep) })).filter(s => s.blocks.length);
    return doc;
}

/** The document for a report, when its type has one. */
function reportDoc(row) {
    if (!row) return null;
    try {
        if (row.report_type === 'ig_report') return igDoc(row);
        if (row.report_type === 'deep_audit') return ciDoc(row);
        if (row.report_type === 'fb_page') return fbDoc(row);
        if (row.report_type === 'fb_community' || row.report_type === 'fb_group') return fbGroupsDoc(row);
        if (row.report_type === 'public_monthly') return publicMonthlyDoc(row);
        if (row.report_type === 'review_scan') return S.reviewDoc(row);
    } catch (err) {
        logger.warn('report_doc_failed', { type: row.report_type, message: err.message });
    }
    return null;
}

// ===========================================================================
// PHASE 38 :: THE MONTHLY REPORT BEFORE META IS CONNECTED
//
// A client whose Meta is not connected still gets a monthly report, built
// only from what can be seen from outside and what the agency did. Nothing
// is scraped for it: it reads the posts and reports earlier runs stored for
// the client, so it costs no Apify. What it cannot know (reach, visits,
// saves, taps, audience) is said plainly in a box, never shown as zero, and
// that box is the reason to connect.
// ===========================================================================

const PUBLIC_MONTH_MAX_POSTS = 600;

function pmMedian(a) { const v = a.filter(x => typeof x === 'number' && Number.isFinite(x)).sort((x, y) => x - y); if (!v.length) return null; const m = Math.floor(v.length / 2); return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2); }
/** Newest read of each post wins: the same post is stored once per run that saw it. */
function pmDedupe(rows, key) { const seen = new Set(); return (rows || []).filter(r => { const k = r[key]; if (!k || seen.has(k)) return false; seen.add(k); return true; }); }

async function pmFollowers(clientId, types, path, before) {
    const { data } = await supabase.from('reports').select(`created_at, report_json`)
        .eq('client_id', clientId).in('report_type', types).lt('created_at', before)
        .order('created_at', { ascending: false }).limit(1);
    const r = (data || [])[0];
    const v = r ? path(r.report_json || {}) : null;
    return typeof v === 'number' ? { value: v, asOf: String(r.created_at).slice(0, 10) } : null;
}

async function publicMonthData(client, month) {
    const cur = monthBounds(month), prev = monthBounds(metaPrevMonth(month));
    const handle = String(client.ig_handle || '').replace(/^@/, '').toLowerCase() || null;

    // The client's Facebook Page is the one its latest Page report was about.
    const { data: fbRep } = await supabase.from('reports').select('report_json').eq('client_id', client.id)
        .eq('report_type', 'fb_page').order('created_at', { ascending: false }).limit(1);
    const pageId = ((fbRep || [])[0] && fbRep[0].report_json && fbRep[0].report_json.target && fbRep[0].report_json.target.pageId) || null;

    const ig = async b => !handle ? [] : pmDedupe((await supabase.from('posts')
        .select('shortcode, post_url, post_type, caption, likes, comments, views, thumbnail_url, posted_at, performance_index, scraped_at, handle')
        .eq('client_id', client.id).eq('platform', 'instagram').eq('handle', handle)
        .gte('posted_at', b.from).lt('posted_at', b.to).order('scraped_at', { ascending: false }).limit(PUBLIC_MONTH_MAX_POSTS)).data, 'shortcode');
    const fb = async b => !pageId ? [] : pmDedupe((await supabase.from('fb_page_posts')
        .select('post_id, post_url, media_type, content, reactions_total, comments, shares, views, posted_at, performance_index, scraped_at, page_id')
        .eq('client_id', client.id).eq('page_id', pageId)
        .gte('posted_at', b.from).lt('posted_at', b.to).order('scraped_at', { ascending: false }).limit(PUBLIC_MONTH_MAX_POSTS)).data, 'post_id');

    const [igNow, igPrev, fbNow, fbPrev, igEnd, igStart, fbEnd, fbStart] = await Promise.all([
        ig(cur), ig(prev), fb(cur), fb(prev),
        pmFollowers(client.id, ['ig_report', 'deep_audit'], j => j.main && j.main.followers, cur.to),
        pmFollowers(client.id, ['ig_report', 'deep_audit'], j => j.main && j.main.followers, cur.from),
        pmFollowers(client.id, ['fb_page'], j => j.target && j.target.followers, cur.to),
        pmFollowers(client.id, ['fb_page'], j => j.target && j.target.followers, cur.from)
    ]);

    const igEng = p => (p.likes || 0) + (p.comments || 0);
    const fbEng = p => (p.reactions_total || 0) + (p.comments || 0) + (p.shares || 0);
    const kinds = (rows, kindOf, eng) => {
        const g = {};
        for (const p of rows) { const k = kindOf(p); (g[k] = g[k] || []).push(eng(p)); }
        const all = pmMedian(rows.map(eng)) || 1;
        return Object.entries(g).map(([k, v]) => ({ kind: k, posts: v.length, median: pmMedian(v), vsTypical: +((pmMedian(v) || 0) / all).toFixed(2) })).sort((a, b) => b.posts - a.posts);
    };
    const igKind = p => ({ Reel: 'Reel', Video: 'Reel', Sidecar: 'Carousel', Image: 'Photo' }[p.post_type] || 'Post');
    const fbKind = p => String(p.media_type || 'post').replace(/^\w/, c => c.toUpperCase());

    const igTop = [...igNow].sort((a, b) => igEng(b) - igEng(a)).slice(0, 3);
    await Promise.all(igTop.map(async p => { p.image = await storeMediaImage(p.thumbnail_url, `pm/${client.id}/${month}-${String(p.shortcode).replace(/[^a-z0-9_-]/gi, '')}`); }));
    const fbTop = [...fbNow].sort((a, b) => fbEng(b) - fbEng(a)).slice(0, 2);

    // Local demand read in the month's Facebook group reports.
    const { data: rooms } = await supabase.from('reports').select('report_type, report_json').eq('client_id', client.id)
        .in('report_type', ['fb_community', 'fb_group']).gte('created_at', cur.from).lt('created_at', cur.to).limit(10);
    let requests = 0, groups = 0;
    for (const r of rooms || []) {
        const j = r.report_json || {};
        if (j.benchmark && typeof j.benchmark.totalDemand === 'number') { requests += j.benchmark.totalDemand; groups += j.benchmark.rooms || (j.groups || []).length; }
        else if (j.group) { requests += j.group.demandSignals || 0; groups += 1; }
    }

    const reel = rows => pmMedian(rows.filter(p => igKind(p) === 'Reel').map(p => p.views).filter(v => v > 0));
    return {
        month, monthLabel: metaMonthLabel(month), prevMonthLabel: metaMonthLabel(metaPrevMonth(month)),
        client: { name: client.brand || client.name, igHandle: handle, fbPage: pageId ? (fbRep[0].report_json.target.name || null) : null },
        ig: handle ? {
            posts: igNow.length, prevPosts: igPrev.length,
            engagement: igNow.reduce((s, p) => s + igEng(p), 0), prevEngagement: igPrev.reduce((s, p) => s + igEng(p), 0),
            reelViews: reel(igNow), prevReelViews: reel(igPrev),
            followers: igEnd, followersStart: igStart,
            formats: kinds(igNow, igKind, igEng),
            top: igTop.map(p => ({ kind: igKind(p), caption: oneLine(p.caption, 120) || null, likes: p.likes, comments: p.comments, views: p.views || null, date: String(p.posted_at).slice(0, 10), link: /^https:\/\/(www\.)?instagram\.com\//.test(String(p.post_url || '')) ? p.post_url : null, image: p.image || null }))
        } : null,
        fb: pageId ? {
            posts: fbNow.length, prevPosts: fbPrev.length,
            engagement: fbNow.reduce((s, p) => s + fbEng(p), 0), prevEngagement: fbPrev.reduce((s, p) => s + fbEng(p), 0),
            followers: fbEnd, followersStart: fbStart,
            formats: kinds(fbNow, fbKind, fbEng),
            top: fbTop.map(p => ({ kind: fbKind(p), text: oneLine(p.content, 240) || null, reactions: p.reactions_total, comments: p.comments, shares: p.shares, date: String(p.posted_at).slice(0, 10), link: /^https:\/\/(www\.|m\.)?facebook\.com\//.test(String(p.post_url || '')) ? p.post_url : null }))
        } : null,
        demand: groups ? { requests, groups } : null
    };
}

registerWorker('public_monthly', (userId, input, jobId) => async (progress) => {
    const { data: client } = await supabase.from('clients').select('id, name, brand, ig_handle').eq('id', input.clientId).maybeSingle();
    if (!client) throw new Error('That client no longer exists.');
    await progress(15, `Reading ${metaMonthLabel(input.month)} from the stored posts`);
    const data = await publicMonthData(client, input.month);
    if (!(data.ig && data.ig.posts) && !(data.fb && data.fb.posts)) {
        throw new Error(`No posts from ${data.monthLabel} are stored for ${client.name}. Run an Instagram audit or a Facebook Page report that covers the month first.`);
    }
    await progress(70, 'Adding the work we did and where they stand');
    const createdAt = new Date().toISOString();
    const ctx = await monthlyContext({ client_id: client.id, report_type: 'public_monthly', report_json: { month: input.month }, created_at: createdAt });
    const { data: plan } = await supabase.from('client_tasks').select('title, assigned_to_client, due_date')
        .eq('client_id', client.id).eq('visible_to_client', true).neq('status', 'done').order('due_date', { ascending: true }).limit(5)
        .then(r => r, () => ({ data: [] }));
    const contentPlan = await contentPlanMonth(client.id, input.month).catch(() => null);
    const payload = { ...data, context: ctx, contentPlan, plan: (plan || []).map(t => ({ title: oneLine(t.title, 200), who: t.assigned_to_client ? 'You' : 'Our team', due: t.due_date || null })), generatedAt: createdAt };
    await progress(92, 'Saving');
    const { data: saved } = await supabase.from('reports').insert([{
        user_id: userId, client_id: client.id,
        platform: data.ig ? 'instagram' : 'facebook',
        report_type: 'public_monthly',
        target_handle: data.client.igHandle || data.client.fbPage || client.name,
        posts_analyzed: (data.ig ? data.ig.posts : 0) + (data.fb ? data.fb.posts : 0),
        snapshot_date: `${input.month}-01`,
        credits_estimate: 0,
        report_json: payload
    }]).select('id').maybeSingle();
    return { reportId: saved?.id || null, reportRef: saved?.id || null, month: input.month };
});

/** The public-numbers monthly as a document. */
function publicMonthlyDoc(row) {
    const j = row.report_json || {};
    if (!j.month) return null;
    const ig = j.ig, fb = j.fb, ctx = j.context || {};
    const m = monthShort(j.monthLabel), pm = monthShort(j.prevMonthLabel);
    const chg = (now, before) => { const a = docNum(now), b = docNum(before); if (a === null || b === null) return '—'; const d = a - b; const pc = b ? Math.abs(d / b * 100) : 0; const p = b ? ` (${d >= 0 ? '+' : '−'}${pc < 1 ? pc.toFixed(1) : Math.round(pc)}%)` : ''; return `${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(Math.round(d)).toLocaleString('en-US')}${p}`; };
    const gained = f => f && f.followers && f.followersStart ? f.followers.value - f.followersStart.value : null;
    const posts = (ig ? ig.posts : 0) + (fb ? fb.posts : 0), prevPosts = (ig ? ig.prevPosts : 0) + (fb ? fb.prevPosts : 0);
    const eng = (ig ? ig.engagement : 0) + (fb ? fb.engagement : 0), prevEng = (ig ? ig.prevEngagement : 0) + (fb ? fb.prevEngagement : 0);
    const st = ctx.standing;
    const sections = [];

    const verdict = `${j.client.name} published ${posts} post${posts === 1 ? '' : 's'} in ${m}${prevPosts ? `, ${posts >= prevPosts ? posts - prevPosts + ' more than' : prevPosts - posts + ' fewer than'} ${pm}` : ''}, and ${eng >= prevEng ? 'people reacted more' : 'people reacted less'}: ${docFmt(eng)} likes, comments and shares${prevEng ? `, against ${docFmt(prevEng)}` : ''}.`;
    sections.push({ title: 'The month in brief', source: ['pub'], blocks: [
        { type: 'kpis', items: [
            ig && ig.followers ? { label: 'Instagram followers', value: docFmt(ig.followers.value), sub: gained(ig) !== null ? `${gained(ig) >= 0 ? '+' : ''}${docFmt(gained(ig))} over the month` : `as of ${docDay(ig.followers.asOf)}`, tone: gained(ig) > 0 ? 'good' : '' } : null,
            fb && fb.followers ? { label: 'Facebook followers', value: docFmt(fb.followers.value), sub: gained(fb) !== null ? `${gained(fb) >= 0 ? '+' : ''}${docFmt(gained(fb))} over the month` : `as of ${docDay(fb.followers.asOf)}`, tone: gained(fb) > 0 ? 'good' : '' } : null,
            { label: 'Posts published', value: String(posts), sub: prevPosts ? `${prevPosts} in ${pm}` : '' },
            { label: 'Likes, comments and shares', value: docFmt(eng), sub: prevEng ? chg(eng, prevEng) + ` on ${pm}` : '', tone: eng > prevEng ? 'good' : eng < prevEng ? 'watch' : '' },
            ig && ig.reelViews ? { label: 'Views per Reel', value: docFmt(ig.reelViews), sub: ig.prevReelViews ? `median, ${docFmt(ig.prevReelViews)} in ${pm}` : 'median' } : null
        ].filter(Boolean).slice(0, 4) },
        { type: 'verdict', text: verdict }
    ] });

    const rows = [
        ig && ig.followers ? ['Instagram followers (month end)', ig.followersStart ? docFmt(ig.followersStart.value) : '—', docFmt(ig.followers.value), ig.followersStart ? chg(ig.followers.value, ig.followersStart.value) : '—'] : null,
        fb && fb.followers ? ['Facebook followers (month end)', fb.followersStart ? docFmt(fb.followersStart.value) : '—', docFmt(fb.followers.value), fb.followersStart ? chg(fb.followers.value, fb.followersStart.value) : '—'] : null,
        ig ? ['Instagram posts', String(ig.prevPosts), String(ig.posts), chg(ig.posts, ig.prevPosts)] : null,
        fb ? ['Facebook posts', String(fb.prevPosts), String(fb.posts), chg(fb.posts, fb.prevPosts)] : null,
        ig ? ['Instagram likes and comments', docFmt(ig.prevEngagement), docFmt(ig.engagement), chg(ig.engagement, ig.prevEngagement)] : null,
        fb ? ['Facebook reactions, comments and shares', docFmt(fb.prevEngagement), docFmt(fb.engagement), chg(fb.engagement, fb.prevEngagement)] : null,
        ig && (ig.reelViews || ig.prevReelViews) ? ['Median views per Reel', docFmt(ig.prevReelViews), docFmt(ig.reelViews), chg(ig.reelViews, ig.prevReelViews)] : null
    ].filter(Boolean);
    sections.push({ title: `${m} against ${pm}`, lead: 'The public numbers, month against month. Post counts are for posts published in each month, as last read.', source: ['pub'], blocks: [
        { type: 'table', cols: [{ label: 'Measure' }, { label: pm, num: true }, { label: m, num: true }, { label: 'Change', num: true }], rows },
        { type: 'missing', title: 'Not in this report yet: reach, profile visits, website taps, saves and audience', text: 'These are visible only to the account owner. Connect Facebook and Instagram once, in about two minutes, and next month’s report shows how many people saw each post, visited the profile and tapped through to book.' }
    ] });

    const cards = [
        ...(ig ? ig.top : []).map(p => ({ kind: p.kind, title: p.caption || 'No caption', meta: [p.likes != null ? `${docFmt(p.likes)} likes` : null, p.comments != null ? `${docFmt(p.comments)} comments` : null, p.views ? `${docFmt(p.views)} views` : null].filter(Boolean).join(' · '), date: docDay(p.date), image: p.image, link: p.link, by: 'Instagram' }))
    ];
    const quotes = (fb ? fb.top : []).map(p => ({ tag: `Facebook · ${p.kind} · ${docDay(p.date)}`, text: p.text || '(no text)', meta: `${docFmt(p.reactions)} reactions · ${docFmt(p.comments)} comments · ${docFmt(p.shares)} shares`, link: p.link }));
    if (cards.length || quotes.length) sections.push({ title: 'Top-performing content', lead: 'The posts people reacted to most this month.', source: ['pub'], blocks: [
        cards.length ? { type: 'posts', items: cards } : null,
        quotes.length ? { type: 'quotes', items: quotes } : null
    ] });

    const fmtBars = (f, title) => f && f.formats && f.formats.length > 1 ? { type: 'bars', title, unit: 'x', rows: f.formats.map(x => ({ label: `${x.kind} · ${x.posts}`, value: x.vsTypical, tone: x.vsTypical >= 1.2 ? 'good' : x.vsTypical < 0.8 ? 'watch' : 'gold' })) } : null;
    const fb1 = fmtBars(ig, 'Instagram, by format, against the typical post'), fb2 = fmtBars(fb, 'Facebook, by format, against the typical post');
    if (fb1 || fb2) sections.push({ title: 'What you post', source: ['pub'], blocks: [{ type: 'row', blocks: [fb1, fb2].filter(Boolean) }] });

    if (st || j.demand) sections.push({ title: 'Against local rivals, and local demand', source: ['pub'], blocks: [
        { type: 'row', blocks: [
            st ? { type: 'points', title: `From the ${st.title} on ${docDay(st.date)}`, items: [{ title: st.verdict, text: st.gap || '' }] } : null,
            j.demand ? { type: 'points', title: 'Local Facebook groups this month', items: [{ title: `${docFmt(j.demand.requests)} people asked for what ${j.client.name} sells`, text: `across ${j.demand.groups} local group${j.demand.groups === 1 ? '' : 's'}.` }] } : null
        ].filter(Boolean) }
    ] });

    const work = ctx.work || {}, leads = ctx.leads;
    const done = [...(work.done || []).map(t => ({ title: t.title, text: `done ${docDay(t.date)}` })), ...(work.filed || []).map(f => ({ title: f.title, text: `delivered ${docDay(f.date)}` })), ...(leads && leads.thisMonth ? [{ title: `${docFmt(leads.thisMonth)} new leads found`, text: `${docFmt(leads.toDate)} to date` }] : [])];
    if (done.length) sections.push({ title: `What we did in ${m}`, source: ['ours'], blocks: [{ type: 'points', tone: 'good', items: done.slice(0, 8) }] });

    const cpBlocks = cpDocBlocks(j.contentPlan);
    if (cpBlocks) sections.push({ title: 'What we planned, and how it did', source: ['ours', 'pub'], blocks: cpBlocks });

    const plan = [{ first: true, title: 'Connect Facebook and Instagram to EdgeLead, so we can report reach, visits and bookings', who: 'You · 2 minutes' }, ...(j.plan || []).map(t => ({ title: t.title, who: t.who }))];
    sections.push({ title: 'Plan for next month', source: ['ours'], blocks: [
        { type: 'table', cols: [{ label: 'What' }, { label: 'Who' }], rows: plan.map(p => [p.first ? { text: p.title, tone: 'good' } : p.title, p.who]) }
    ] });

    return docFinish({
        type: 'public_monthly',
        cover: { kind: `Monthly report · ${j.monthLabel}`, title: j.client.name,
            sub: `${[j.client.igHandle ? `Instagram @${j.client.igHandle}` : null, j.client.fbPage ? `Facebook ${j.client.fbPage}` : null].filter(Boolean).join(' and ')} · covers ${monthCovers(j.month)} · public numbers.`,
            receipt: [
                [String(posts), 'posts published'], [docFmt(eng), 'likes, comments, shares'],
                [ig && gained(ig) !== null ? `${gained(ig) >= 0 ? '+' : ''}${docFmt(gained(ig))}` : (ig && ig.followers ? docFmt(ig.followers.value) : '—'), ig && gained(ig) !== null ? 'Instagram followers' : 'followers'],
                [st && st.rank ? ordinal(st.rank) : '—', st && st.of ? `of ${st.of} local rivals` : 'against rivals']
            ],
            builtAt: j.generatedAt || row.created_at },
        sections,
        about: [
            'Every number here is public: follower counts from the last reads before and after the month, and the likes, comments, shares and views Instagram and Facebook show on each post, as last read by our audits. Nothing new was scraped for this report.',
            'Reach, visits, saves, taps and audience are the owner’s own numbers and are not guessed. Once Meta is connected, the monthly report switches to the full version.'
        ]
    });
}

/**
 * Build the public-numbers monthly report for a client (phase 38). Staff
 * with edit access; a finished month; costs nothing, but runs as a job like
 * everything else (rule 4).
 */
// No spend limiter: it reads stored data and spends no credit; the job slot still caps it.
app.post('/api/reports/public-monthly', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        const c = await clientAccess(ctx.user.id, req.body?.clientId, 'editor');
        if (!c) return res.status(404).json({ error: 'Client not found, or you cannot edit it.' });
        const month = MONTH_RE.test(String(req.body?.month || '')) ? String(req.body.month) : metaDefaultMonth();
        if (month >= new Date().toISOString().slice(0, 7)) return res.status(400).json({ error: 'That month has not finished yet. Pick a completed month.' });
        await assertJobSlot(ctx.user.id);
        const job = await createJob(ctx.user.id, 'public_monthly', 'report', { clientId: c.id, month }, 0);
        runJob(job.id, JOB_WORKERS['public_monthly'](ctx.user.id, job.input, job.id));
        res.status(202).json({ success: true, jobId: job.id, month, estimatedUsd: 0 });
    } catch (err) { sendErr(res, err); }
});
