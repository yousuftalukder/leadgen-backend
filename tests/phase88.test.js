#!/usr/bin/env node
/**
 * Phase 88 offline tests — the phone and the jobs won.
 *
 * What matters: any way a number is written becomes one E.164 form; only Twilio, proven by its signature, can drive a
 * webhook; the browser token carries the Voice grant and is signed; the business is open Mon–Sat 8–6 Central and
 * closed otherwise; the right TwiML is answered for each case; the inbox groups calls and texts by number with the
 * right name and counts; and won jobs are counted by the service sold, else by department.
 *
 *   node tests/phase88.test.js
 */
'use strict';
const assert = require('assert');
const Module = require('module');
const path = require('path');

const chain = () => {
    const p = Promise.resolve({ data: null, error: null, count: 0 });
    const h = new Proxy(function () {}, { get: (_, k) => (k === 'then' ? p.then.bind(p) : k === 'catch' ? p.catch.bind(p) : k === 'finally' ? p.finally.bind(p) : () => h), apply: () => h });
    return h;
};
const routes = [];
const stubs = {
    express: Object.assign(() => {
        const r = m => (p, ...h) => routes.push([m, p, h]);
        return { set() {}, use: r('use'), get: r('get'), post: r('post'), patch: r('patch'), delete: r('delete'), put: r('put'), listen() {} };
    }, { json: () => (_, __, n) => n && n(), raw: () => (_, __, n) => n && n(), static: () => () => {} }),
    cors: () => () => {},
    'apify-client': { ApifyClient: class {} },
    '@supabase/supabase-js': { createClient: () => ({ from: chain, rpc: chain, auth: { getUser: async () => ({ data: null, error: new Error('stub') }) } }) },
    dotenv: { config() {} }
};
const realLoad = Module._load;
Module._load = function (req, ...rest) { return stubs[req] !== undefined ? stubs[req] : realLoad.call(this, req, ...rest); };
process.env.SUPABASE_URL = 'http://stub'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
delete process.env.RENDER;

require(path.join(__dirname, '..', 'server.js'));
const S = require(path.join(__dirname, '..', 'src', 'shared'));

let passed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n       ')); process.exitCode = 1; } }
const refuses = (fn, re) => assert.throws(fn, e => e.statusCode === 400 && re.test(e.message), 'expected a 400 matching ' + re);
const crypto = require('crypto');

console.log('phase 88 :: numbers');
test('numbers written any way become E.164', () => {
    assert.strictEqual(S.toE164('(469) 819-4097'), '+14698194097');
    assert.strictEqual(S.toE164('1 469 819 4097'), '+14698194097');
    assert.strictEqual(S.toE164('+1-469-819-4097'), '+14698194097');
    assert.strictEqual(S.toE164('01711-204318'), '+8801711204318');
    assert.strictEqual(S.toE164('008801711204318'), '+8801711204318');
    assert.strictEqual(S.toE164('12'), null);
    assert.strictEqual(S.prettyNumber('+14698194097'), '(469) 819-4097');
});

console.log('phase 88 :: twilio');
test('a webhook is accepted only with Twilio\'s signature over the exact URL and fields', () => {
    // Twilio's documented example.
    const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
    const params = { CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' };
    const sig = S.twilioSignature('12345', url, params);
    assert.strictEqual(sig, '0/KCTR6DLpKmkAf8muzZqo1nDgQ=');   // the value in Twilio's own documentation
    assert.ok(S.validTwilio('12345', sig, url, params));
    assert.ok(!S.validTwilio('12345', sig, url, { ...params, Digits: '9999' }));
    assert.ok(!S.validTwilio('12345', undefined, url, params));
    assert.ok(!S.validTwilio('', sig, url, params));
});
test('the browser token carries the Voice grant and is signed with the API secret', () => {
    const t = S.voiceToken({ accountSid: 'ACx', apiKey: 'SKx', apiSecret: 'sec', appSid: 'APx', identity: 'u_1', now: 1000 });
    const [h, b, sig] = t.split('.');
    assert.deepStrictEqual(JSON.parse(Buffer.from(h, 'base64url')), { typ: 'JWT', alg: 'HS256', cty: 'twilio-fpa;v=1' });
    const body = JSON.parse(Buffer.from(b, 'base64url'));
    assert.strictEqual(body.iss, 'SKx'); assert.strictEqual(body.sub, 'ACx'); assert.strictEqual(body.exp, 4600);
    assert.deepStrictEqual(body.grants, { identity: 'u_1', voice: { incoming: { allow: true }, outgoing: { application_sid: 'APx' } } });
    assert.strictEqual(sig, crypto.createHmac('sha256', 'sec').update(h + '.' + b).digest('base64url'));
});
test('open Mon–Sat 8 AM to 6 PM Central, closed otherwise', () => {
    assert.ok(S.isOpen(new Date('2026-11-23T14:00:00Z')));        // Mon 8:00 Central
    assert.ok(!S.isOpen(new Date('2026-11-23T13:59:00Z')));       // Mon 7:59
    assert.ok(!S.isOpen(new Date('2026-11-24T00:00:00Z')));       // Mon 18:00
    assert.ok(S.isOpen(new Date('2026-11-28T20:00:00Z')));        // Sat 14:00
    assert.ok(!S.isOpen(new Date('2026-11-29T18:00:00Z')));       // Sun noon
    assert.ok(S.isOpen(new Date('2026-07-06T13:00:00Z')));        // Mon 8:00 in summer time
});
test('the call is routed: ring the team, else voicemail; outgoing shows the business number', () => {
    const ring = S.ringTeamTwiml('https://x', ['u_a', 'u_b'], { parentSid: 'CA1', from: '+12145550101' });
    assert.ok(/<Dial timeout="20"[^>]*action="https:\/\/x\/api\/phone\/hook\/after"/.test(ring));
    assert.strictEqual((ring.match(/<Client>/g) || []).length, 2);
    assert.ok(ring.includes('<Parameter name="pcs" value="CA1"/>'));
    assert.ok(/<Record [^>]*transcribe="true"/.test(S.ringTeamTwiml('https://x', [])), 'nobody to ring: voicemail');
    const vm = S.voicemailTwiml('https://x');
    assert.ok(vm.includes('Edge Home Services') && vm.includes('/api/phone/hook/transcription'));
    const out = S.outgoingTwiml('https://x', { callerId: '+14698194097', to: '+12145550101' });
    assert.ok(out.includes('callerId="+14698194097"') && out.includes('<Number statusCallback="https://x/api/phone/hook/status"'));
    assert.ok(S.outgoingTwiml('https://x', { callerId: '+1', to: '+1<x>' }).includes('+1&lt;x&gt;'), 'escaped');
});

console.log('phase 88 :: inbox');
test('calls and texts are grouped by number, newest first, with names and counts', () => {
    const calls = [
        { contact_number: '+12145550101', direction: 'inbound', status: 'no-answer', voicemail: false, started_at: '2026-11-20T10:00:00Z' },
        { contact_number: '+12145550101', direction: 'inbound', status: 'voicemail', voicemail: true, started_at: '2026-11-20T11:00:00Z' },
        { contact_number: '+14695550199', direction: 'outbound', status: 'completed', duration: 60, started_at: '2026-11-21T09:00:00Z', read_at: '2026-11-21T09:00:00Z' }
    ];
    const messages = [{ contact_number: '+12145550101', direction: 'inbound', body: 'Can you come Friday?', at: '2026-11-22T08:00:00Z' }];
    const t = S.phoneThreads(calls, messages, [{ number: '+14695550199', name: 'Lone Star Warranty', kind: 'warranty' }], [{ id: 'L1', full_name: 'Maria Lopez', phone_norm: '2145550101' }]);
    assert.deepStrictEqual(t.map(x => x.number), ['+12145550101', '+14695550199']);
    assert.strictEqual(t[0].name, 'Maria Lopez'); assert.strictEqual(t[0].lead_id, 'L1');
    assert.deepStrictEqual([t[0].missed, t[0].voicemail, t[0].unread, t[0].last.kind], [1, 1, 3, 'text']);
    assert.deepStrictEqual([t[1].name, t[1].kind, t[1].unread], ['Lone Star Warranty', 'warranty', 0]);
});

console.log('phase 88 :: jobs won');
test('won jobs count by the service sold, else by the department of the source', () => {
    assert.strictEqual(S.jobKind({ service: 'Website' }), 'website');
    assert.strictEqual(S.jobKind({ service: 'SEO' }), 'seo');
    assert.strictEqual(S.jobKind({ service: 'Meta ads' }), 'marketing');
    assert.strictEqual(S.jobKind({ service: 'Influencer marketing' }), 'influencer');
    assert.strictEqual(S.jobKind({ source: 'seo' }), 'seo');
    assert.strictEqual(S.jobKind({ source: 'referral' }), 'marketing');
    const jobs = S.jobsWon([
        { stage: 'won', service: 'Website', value: 100, currency: 'USD', stage_at: '2026-11-10T00:00:00Z' },
        { stage: 'won', service: 'Website', value: 50000, currency: 'BDT', stage_at: '2026-01-10T00:00:00Z' },
        { stage: 'proposal', service: 'SEO', value: 9, currency: 'BDT', stage_at: '2026-11-10T00:00:00Z' }
    ], '2026-11-01T00:00:00Z', '2026-11-30T00:00:00Z');
    const w = jobs.find(j => j.key === 'website');
    assert.deepStrictEqual([w.count, w.value, w.periodCount, w.periodValue], [2, 62000, 1, 12000]);
    assert.strictEqual(jobs.find(j => j.key === 'seo').count, 0);
    assert.deepStrictEqual(jobs.map(j => j.key), ['website', 'seo', 'marketing', 'influencer']);
});

console.log(`\n${passed} passed`);
