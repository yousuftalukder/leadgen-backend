#!/usr/bin/env node
/**
 * Phase 16 offline tests — Facebook Page leads.
 * Same harness as the other phases: no network, no Supabase, no Apify.
 *
 *   node tests/phase16.test.js
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

const U = 'user-1';
const profile = (over = {}) => Object.assign({
    page_id: '10001', username: 'HarborCafe', name: 'Harbor Cafe',
    url: 'https://www.facebook.com/HarborCafe',
    email: 'hello@harborcafe.com', phone: '+1 617 555 0142',
    website: 'harborcafe.com', category: 'Restaurant', city: 'Boston',
    address: '1 Dock St', followers: 4820, likes: 4600,
    about: 'Coffee by the water.', verified: true
}, over);

console.log('fbPageToLead — the row that lands in the shared list');
test('it is tagged facebook, not left to the instagram default', () => {
    assert.strictEqual(S.fbPageToLead(profile(), U).platform, 'facebook');
});
test('the page id is kept, because a vanity can change and the id cannot', () => {
    assert.strictEqual(S.fbPageToLead(profile(), U).platform_id, '10001');
});
test('the handle is lower-cased, because it is part of the unique key', () => {
    // The key is (owner, platform, username) on plain columns — an expression
    // index cannot be an upsert conflict target — so case must be normalised
    // here or "HarborCafe" and "harborcafe" become two leads.
    assert.strictEqual(S.fbPageToLead(profile(), U).username, 'harborcafe');
});
test('a full facebook url is reduced to the handle', () => {
    const l = S.fbPageToLead(profile({ username: 'https://www.facebook.com/HarborCafe/' }), U);
    assert.strictEqual(l.username, 'harborcafe');
});
test('a page with no vanity falls back to its numeric id', () => {
    const l = S.fbPageToLead(profile({ username: null }), U);
    assert.strictEqual(l.username, '10001');
});
test('a page with neither is refused rather than written half-formed', () => {
    assert.strictEqual(S.fbPageToLead(profile({ username: null, page_id: null }), U), null);
});
test('published contact details carry across', () => {
    const l = S.fbPageToLead(profile(), U);
    assert.strictEqual(l.email, 'hello@harborcafe.com');
    assert.strictEqual(l.phone, '+1 617 555 0142');
    assert.strictEqual(l.website, 'harborcafe.com');
    assert.strictEqual(l.city, 'Boston');
    assert.strictEqual(l.category, 'Restaurant');
});
test('it arrives enriched — one Page scrape returns profile and contacts together', () => {
    assert.strictEqual(S.fbPageToLead(profile(), U).is_enriched, true);
});
test('provenance is recorded', () => {
    assert.deepStrictEqual(S.fbPageToLead(profile(), U).sources_detected, ['facebook_page']);
});
test('followers fall back to likes when the actor returns only likes', () => {
    assert.strictEqual(S.fbPageToLead(profile({ followers: null }), U).followers_count, 4600);
});
test('a missing bio does not become the string "null"', () => {
    assert.strictEqual(S.fbPageToLead(profile({ about: null }), U).bio, null);
});
test('the owner is always the caller, never anything from the scrape', () => {
    assert.strictEqual(S.fbPageToLead(profile({ owner_user_id: 'someone-else' }), U).owner_user_id, U);
});

console.log('fbPageSearchRefs — turning search results into page refs');
test('it dedupes the same page arriving from two queries', () => {
    const refs = S.fbPageSearchRefs([
        { url: 'https://www.facebook.com/HarborCafe' },
        { url: 'https://www.facebook.com/HarborCafe' }
    ]);
    assert.strictEqual(refs.length, 1);
});
test('it drops anything that is not a page', () => {
    const refs = S.fbPageSearchRefs([
        { url: 'https://www.facebook.com/groups/123456' },   // a group, not a page
        { url: 'not a url at all' },
        { url: null },
        { url: 'https://www.facebook.com/HarborCafe' }
    ]);
    assert.strictEqual(refs.length, 1);
    assert.ok(/harborcafe/i.test(refs[0].pageId + refs[0].url));
});
test('an empty result set is an empty list, not a throw', () => {
    assert.deepStrictEqual(S.fbPageSearchRefs([]), []);
    assert.deepStrictEqual(S.fbPageSearchRefs(null), []);
});
test('name and category hints survive for the progress log', () => {
    const [r] = S.fbPageSearchRefs([
        { url: 'https://www.facebook.com/HarborCafe', title: 'Harbor Cafe', category: 'Restaurant' }
    ]);
    assert.strictEqual(r.hintName, 'Harbor Cafe');
    assert.strictEqual(r.hintCategory, 'Restaurant');
});

console.log('quota wiring for the new job type');
test('facebook discovery is metered by leads, not by item count', () => {
    assert.ok(S.LEADGEN_JOB_TYPES.has('fb_lead_discovery'),
        'without this the headroom precheck never runs for a Facebook search');
    assert.strictEqual(S.JOB_QUOTA_METRIC.fb_lead_discovery, undefined,
        'a Facebook search must not consume an item at queue time');
});

console.log('\n' + passed + ' passed');
