#!/usr/bin/env node
/**
 * Phase 14 offline tests — the client report view.
 * Same harness as phase11/phase13: every external module is stubbed through
 * Module._load so server.js loads as a library and only pure functions run.
 *
 *   node tests/phase14.test.js
 */
'use strict';
const assert = require('assert');
const Module = require('module');
const path = require('path');

// ---- stubs -----------------------------------------------------------------
const chain = () => {
    const p = Promise.resolve({ data: null, error: null, count: 0 });
    const h = new Proxy(function () {}, {
        get: (_, k) => (k === 'then' ? p.then.bind(p) : k === 'catch' ? p.catch.bind(p) : k === 'finally' ? p.finally.bind(p) : () => h),
        apply: () => h
    });
    return h;
};
const stubs = {
    express: Object.assign(() => ({
        set() {}, use() {}, get() {}, post() {}, patch() {}, delete() {}, put() {}, listen() {}
    }), { json: () => (_, __, n) => n && n(), static: () => () => {} }),
    cors: () => () => {},
    'apify-client': { ApifyClient: class {} },
    '@supabase/supabase-js': { createClient: () => ({ from: chain, rpc: chain, auth: { getUser: async () => ({ data: null, error: new Error('stub') }) } }) },
    dotenv: { config() {} }
};
const realLoad = Module._load;
Module._load = function (req, ...rest) { return stubs[req] !== undefined ? stubs[req] : realLoad.call(this, req, ...rest); };
process.env.SUPABASE_URL = 'http://stub'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';

const S = require(path.join(__dirname, '..', 'server.js'));
let passed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; } }

// A report shaped the way the ig_report worker actually writes one.
function report(over = {}, jsonOver = {}) {
    return Object.assign({
        id: 'r1', report_type: 'ig_report', platform: 'instagram',
        target_handle: 'cafe', snapshot_date: '2026-09-20', posts_analyzed: 42,
        score: 71, grade: 'B', engagement_rate: 2.4, cohort_avg_er: 1.9, target_rank: 2,
        ai_summary: 'Doing well.', followers_snapshot: 3200, posts_per_week: 3.5,
        report_json: Object.assign({
            main: {
                handle: 'cafe', score: 71, grade: 'B', engagementRate: '2.40',
                scoreBreakdown: [
                    { pillar: 'Engagement per follower', points: 22, max: 26, detail: '2.40% per post' },
                    { pillar: 'Posting cadence',         points: 4,  max: 16, detail: '1.2 posts/week' },
                    { pillar: 'Conversation',            points: 8,  max: 16, detail: '3.0 comments per 100 likes' },
                    { pillar: 'Reach',                   points: 0,  max: 12, detail: 'no view counts returned — pillar excluded' }
                ],
                profileCompleteness: {
                    score: 74,
                    checks: [{ label: 'Link in bio set', ok: false }, { label: 'Bio written (40+ chars)', ok: true }]
                }
            },
            benchmark: {
                cohort: { accounts: 3, avgEngagementRate: '1.90' },
                ranked: [
                    { rank: 1, handle: 'rival1', isTarget: false },
                    { rank: 2, handle: 'cafe',   isTarget: true  },
                    { rank: 3, handle: 'rival2', isTarget: false }
                ]
            }
        }, jsonOver)
    }, over);
}

console.log('clientReportView — what must never reach a client');
test('the raw score is not in the payload', () => {
    const v = S.clientReportView(report());
    assert.ok(!('score' in v), 'a number out of 100 invites an argument about the number');
    assert.ok(!JSON.stringify(v).includes('"score":71'));
});
test('internal bookkeeping is not in the payload', () => {
    const v = S.clientReportView(report({ credits_estimate: 4.2, set_id: 'abc', user_id: 'u1' }));
    const s = JSON.stringify(v);
    assert.ok(!s.includes('credits_estimate'));
    assert.ok(!s.includes('set_id'));
    assert.ok(!s.includes('user_id'));
});
test('the letter grade survives, because it travels in conversation', () => {
    assert.strictEqual(S.clientReportView(report()).grade, 'B');
});

console.log('clientReportView — bands');
test('band follows the score', () => {
    const band = s => S.clientReportView(report({ score: s })).band;
    assert.strictEqual(band(92), 'strong');
    assert.strictEqual(band(80), 'strong');
    assert.strictEqual(band(70), 'healthy');
    assert.strictEqual(band(55), 'mixed');
    assert.strictEqual(band(40), 'weak');
    assert.strictEqual(band(12), 'poor');
});
test('every band has a headline written for it', () => {
    for (const s of [90, 70, 55, 40, 10]) {
        const v = S.clientReportView(report({ score: s }));
        assert.ok(v.headline && v.headline.length > 10, `no headline for score ${s}`);
        assert.ok(!/undefined/.test(v.headline));
    }
});
test('a report with no score still returns something sayable', () => {
    const v = S.clientReportView(report({ score: null }, { main: {} }));
    assert.strictEqual(v.band, null);
    assert.ok(v.headline && v.headline.length > 10);
});

console.log('clientPillars — working vs fix');
test('a strong pillar reads as working, a weak one as a fix', () => {
    const v = S.clientReportView(report());
    assert.ok(v.working.some(w => /actually react/i.test(w.title)), 'engagement 22/26 should be working');
    assert.ok(v.fix.some(f => /not posting often enough/i.test(f.title)), 'cadence 4/16 should be a fix');
});
test('a mid-range pillar is neither — it is not actionable', () => {
    const v = S.clientReportView(report());
    const all = [...v.working, ...v.fix].map(x => x.title).join(' ');
    assert.ok(!/comment/i.test(all), 'conversation at 8/16 should be left out');
});
test('a pillar that could not be measured is never called a failing one', () => {
    const v = S.clientReportView(report());
    const all = [...v.working, ...v.fix].map(x => x.title).join(' ');
    assert.ok(!/beyond your own followers|only reaching/i.test(all),
        'Reach was excluded for missing view counts and must not appear as a fix');
});
test('every surfaced item carries a why', () => {
    const v = S.clientReportView(report());
    for (const item of [...v.working, ...v.fix]) {
        assert.ok(item.why && item.why.length > 10, `no why for: ${item.title}`);
    }
});

console.log('clientStanding');
test('middle of the pack reads as a placing', () => {
    const v = S.clientReportView(report());
    assert.strictEqual(v.standing.verdict, 'You come 2nd out of 3 businesses like yours.');
});
test('first place is said as ahead of everyone, not "1st of 3"', () => {
    const v = S.clientReportView(report({ target_rank: 1 }));
    assert.ok(/ahead of every/i.test(v.standing.verdict), v.standing.verdict);
});
test('last place is said plainly without a ranking number', () => {
    const v = S.clientReportView(report({ target_rank: 3 }));
    assert.ok(/behind the other 2/i.test(v.standing.verdict), v.standing.verdict);
});
test('the gap is phrased per 100 followers and names the direction', () => {
    const ahead = S.clientReportView(report()).standing;
    assert.ok(/for every 100 followers/i.test(ahead.gap), ahead.gap);
    assert.ok(/more reactions/.test(ahead.gap), ahead.gap);
    assert.strictEqual(ahead.ahead, true);

    const behind = S.clientReportView(report({ engagement_rate: 1.2 })).standing;
    assert.ok(/fewer reactions/.test(behind.gap), behind.gap);
    assert.strictEqual(behind.ahead, false);
});
test('a negligible gap is called level rather than dressed up', () => {
    const v = S.clientReportView(report({ engagement_rate: 1.92, cohort_avg_er: 1.9 }));
    assert.ok(/level with the others/i.test(v.standing.gap), v.standing.gap);
});
test('the client is labelled "You", never their own handle', () => {
    const peers = S.clientReportView(report()).standing.peers;
    const me = peers.find(p => p.is_you);
    assert.strictEqual(me.name, 'You');
    assert.strictEqual(peers.filter(p => p.is_you).length, 1);
});

console.log('provisional and degradation');
test('a thin sample is flagged rather than presented as a verdict', () => {
    const v = S.clientReportView(report({}, {
        main: { lowConfidence: true, scoreBreakdown: [] }, benchmark: {}
    }));
    assert.strictEqual(v.provisional, true);
    assert.ok(/first read rather than a verdict/i.test(v.provisional_note));
});
test('a confident report carries no provisional note', () => {
    const v = S.clientReportView(report());
    assert.strictEqual(v.provisional, false);
    assert.strictEqual(v.provisional_note, null);
});
test('an empty report_json does not throw', () => {
    const v = S.clientReportView(report({}, { main: undefined, benchmark: undefined }));
    assert.ok(v && typeof v.headline === 'string');
    assert.deepStrictEqual(v.working, []);
    assert.deepStrictEqual(v.fix, []);
});
test('a null row returns null rather than a broken shape', () => {
    assert.strictEqual(S.clientReportView(null), null);
});
test('missing profile checks degrade to an empty list', () => {
    const v = S.clientReportView(report({}, { main: { scoreBreakdown: [] }, benchmark: {} }));
    assert.deepStrictEqual(v.profile.missing, []);
});

console.log('content plans and community audits, said to an owner');
const planRow = () => ({
    id: 'p1', report_type: 'content_plan', snapshot_date: '2026-09-20', score: null, grade: null,
    report_json: {
        formatSpec: [{ key: 'reel', plural: 'reels', label: 'Reels' }],
        briefs: { reels: [{
            cell: 'reel|question|short|pricing', concept: 'Answer the price question',
            hook: 'Everyone asks what a refit costs', script: ['Open on the tap', 'Say the number', 'Offer a quote'],
            shot: 'Handheld, kitchen, natural light', caption: 'Here is what it actually costs…',
            slot: 'Tue 18:00', predicted_band: 'likely to do well', predicted_index: 1.28,
            boost: 'worth boosting', boost_why: 'Already your best format.'
        }] }
    }
});
const roomRow = () => ({
    id: 'c1', report_type: 'fb_community', snapshot_date: '2026-09-20', score: 62, grade: 'B',
    fb_group_names: ['Boston Neighbours', 'Southie Chat'],
    report_json: { rooms: [
        { name: 'Boston Neighbours', member_count: 14200, room_value_score: 78, posts: 120 },
        { name: 'Quiet Corner',      member_count: 300,   room_value_score: 12, posts: 20 }
    ] }
});

test('a plan leads with how many things to post, not a score band', () => {
    const v = S.clientReportView(planRow());
    assert.ok(/things to post next/i.test(v.headline), v.headline);
    assert.strictEqual(v.band, null, 'a plan has no score band to report');
});
test('briefs arrive with their script and shot intact', () => {
    const [i] = S.clientReportView(planRow()).ideas;
    assert.strictEqual(i.format, 'Reels');
    assert.deepStrictEqual(i.script, ['Open on the tap', 'Say the number', 'Offer a quote']);
    assert.strictEqual(i.shot, 'Handheld, kitchen, natural light');
    assert.strictEqual(i.when, 'Tue 18:00');
});
test('the cell machinery and the raw index never reach the client', () => {
    const s = JSON.stringify(S.clientReportView(planRow()).ideas);
    assert.ok(!s.includes('1.28'), 'predicted_index leaked');
    assert.ok(!/reel\|question/.test(s), 'the cell key leaked');
});
test('the boost call is spelled out, not left as a flag', () => {
    const [i] = S.clientReportView(planRow()).ideas;
    assert.strictEqual(i.boost, 'Worth putting money behind');
    assert.ok(!/double_down|organic only/.test(JSON.stringify(i)));
});
test('a community audit leads with how many rooms, and bands each one', () => {
    const v = S.clientReportView(roomRow());
    assert.ok(/local groups/i.test(v.headline), v.headline);
    assert.strictEqual(v.rooms.length, 2);
    assert.strictEqual(v.rooms[0].worth, 'Worth being in');
    assert.strictEqual(v.rooms[1].worth, 'Quiet for you');
});
test('room value scores never reach the client', () => {
    const s = JSON.stringify(S.clientReportView(roomRow()).rooms);
    assert.ok(!s.includes('78') && !s.includes('room_value'), 'a raw room score leaked');
});
test('an older audit with only group names still renders', () => {
    const r = roomRow(); r.report_json = {};
    const v = S.clientReportView(r);
    assert.strictEqual(v.rooms.length, 2);
    assert.strictEqual(v.rooms[0].name, 'Boston Neighbours');
});
test('an audit report carries no ideas, and a plan carries no rooms', () => {
    assert.deepStrictEqual(S.clientReportView(planRow()).rooms, []);
    assert.deepStrictEqual(S.clientReportView(roomRow()).ideas, []);
    assert.deepStrictEqual(S.clientReportView(report()).ideas, []);
});

console.log('clientDemandView — the local demand feed, said to an owner');
const signal = (over = {}) => Object.assign({
    snippet: 'Anyone know a good plumber near Southie? Kitchen tap is leaking badly.',
    intent: 'recommendation_request', urgency: 'high',
    group_name: 'Boston Neighbours', posted_at: '2026-09-20T10:00:00Z', lead_score: 88
}, over);

test('the internal scores never reach the client', () => {
    const v = S.clientDemandView(signal());
    const s = JSON.stringify(v);
    assert.ok(!s.includes('lead_score'));
    assert.ok(!s.includes('88'));
    assert.ok(!('urgency' in v), 'raw urgency should collapse into a stance');
});
test('three urgency bands become two words an owner can act on', () => {
    assert.strictEqual(S.clientDemandView(signal({ urgency: 'high' })).stance, 'Reply today');
    assert.strictEqual(S.clientDemandView(signal({ urgency: 'medium' })).stance, 'Worth a reply');
    assert.strictEqual(S.clientDemandView(signal({ urgency: 'low' })).stance, 'Keep an eye on it');
});
test('only high urgency flags as urgent, so the flag keeps meaning something', () => {
    assert.strictEqual(S.clientDemandView(signal({ urgency: 'high' })).urgent, true);
    assert.strictEqual(S.clientDemandView(signal({ urgency: 'medium' })).urgent, false);
    assert.strictEqual(S.clientDemandView(signal({ urgency: 'low' })).urgent, false);
});
test('every intent the miner emits has plain-language copy', () => {
    // Anything missing here renders as a bare enum in front of a customer.
    for (const intent of ['recommendation_request', 'question', 'buy_sell', 'hiring',
                          'event', 'offer', 'complaint', 'story']) {
        assert.ok(S.DEMAND_INTENT[intent], `no client wording for intent "${intent}"`);
        assert.ok(!/_/.test(S.DEMAND_INTENT[intent]), `"${intent}" copy still looks like an enum`);
    }
});
test('an unknown intent degrades to something sayable, not undefined', () => {
    const v = S.clientDemandView(signal({ intent: 'something_new' }));
    assert.ok(v.kind && !/undefined|_/.test(v.kind), v.kind);
});
test('no author is exposed, and the page is told so explicitly', () => {
    const v = S.clientDemandView(signal());
    const s = JSON.stringify(v);
    assert.ok(!/author/i.test(s.replace('author_shown', '')), 'an author field leaked');
    assert.strictEqual(v.author_shown, false,
        'the page needs this to explain the absence rather than render a blank name');
});
test('a null row returns null rather than a broken card', () => {
    assert.strictEqual(S.clientDemandView(null), null);
});
test('a missing snippet does not become the string "null"', () => {
    assert.strictEqual(S.clientDemandView(signal({ snippet: null })).asking_for, '');
});

console.log('ordinal');
test('ordinals read correctly, including the teens', () => {
    assert.strictEqual(S.ordinal(1), '1st');
    assert.strictEqual(S.ordinal(2), '2nd');
    assert.strictEqual(S.ordinal(3), '3rd');
    assert.strictEqual(S.ordinal(4), '4th');
    assert.strictEqual(S.ordinal(11), '11th');
    assert.strictEqual(S.ordinal(12), '12th');
    assert.strictEqual(S.ordinal(13), '13th');
    assert.strictEqual(S.ordinal(21), '21st');
});

console.log('\n' + passed + ' passed');
