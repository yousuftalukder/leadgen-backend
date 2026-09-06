#!/usr/bin/env node
/** Loads header.js in a stub DOM and checks the page contract + EL.api client scoping. */
'use strict';
const vm = require('vm'), fs = require('fs'), path = require('path'), assert = require('assert');
const store = {};
const el = () => ({ textContent: '', innerHTML: '', className: '', style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
    appendChild() {}, prepend() {}, remove() {}, addEventListener() {}, querySelector: () => el(), querySelectorAll: () => [], setAttribute() {}, scrollIntoView() {} });
const calls = [];
const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, URL, URLSearchParams, JSON, Math, Date, String, Number, Array, Object, RegExp, Error, Set, Map, encodeURIComponent, decodeURIComponent,
    localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; }, removeItem: k => { delete store[k]; } },
    document: { getElementById: () => el(), createElement: () => el(), querySelector: () => el(), querySelectorAll: () => [], head: el(), body: el(), addEventListener() {} },
    location: { search: '', pathname: '/ig-report.html', href: 'https://x/ig-report.html' },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
};
ctx.window = ctx; ctx.supabase = { createClient: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: 'tok', user: { id: 'u' } } } }) } }) };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'frontend', 'header.js'), 'utf8'), ctx);
const EL = ctx.EL;
(async () => {
    for (const k of ['init', 'api', 'runJob', 'pollJob', 'currentClient', 'clientBody', 'clientQuery', 'reportParam', 'isShared', 'loadShared', 'reportActions', 'escape', 'safeUrl', 'showCost', '_renderCancel', '_clearCancel', '_clearJobBanner', 'clientId', 'setClientId', 'clients', 'token', 'refreshStatus', 'openKeyModal', 'scheduleWhen'])
        assert.strictEqual(typeof EL[k], 'function', k);
    EL.supabase = ctx.supabase.createClient();
    // no client: nothing added
    await EL.api('/api/reports-history?type=ig_report');
    assert.ok(!/client_id/.test(calls.at(-1).url));
    // client selected: GET gets client_id, POST gets clientId, explicit ones are respected, public untouched
    EL.setClientId('11111111-1111-1111-1111-111111111111');
    await EL.api('/api/reports-history?type=ig_report');
    assert.ok(/[&?]client_id=1111/.test(calls.at(-1).url), calls.at(-1).url);
    await EL.api('/api/deep-audit', { method: 'POST', body: { target: 'x' } });
    assert.strictEqual(JSON.stringify(JSON.parse(calls.at(-1).opts.body)), JSON.stringify({ target: 'x', clientId: '11111111-1111-1111-1111-111111111111' }));
    await EL.api('/api/deep-audit', { method: 'POST', body: { target: 'x', clientId: null } });
    assert.strictEqual(JSON.parse(calls.at(-1).opts.body).clientId, null);
    await EL.api('/api/public/share/abcdefghijklmnopqrstuvwx');
    assert.ok(!/client_id/.test(calls.at(-1).url) && !calls.at(-1).opts.headers.Authorization);
    assert.strictEqual(EL.clientBody().clientId, '11111111-1111-1111-1111-111111111111');
    assert.strictEqual(EL.clientQuery('&'), '&client_id=11111111-1111-1111-1111-111111111111');
    // share token + report param validation
    ctx.location.search = '?share=abcdefghijklmnopqrstuvwx&report=not-a-uuid';
    assert.strictEqual(EL.shareToken(), 'abcdefghijklmnopqrstuvwx');
    assert.strictEqual(EL.reportParam(), null);
    ctx.location.search = '?report=11111111-1111-1111-1111-111111111111';
    assert.strictEqual(EL.reportParam(), '11111111-1111-1111-1111-111111111111');
    assert.strictEqual(EL.safeUrl('javascript:alert(1)'), '#');
    assert.strictEqual(EL.scheduleWhen({ cadence: 'weekly', day_of_week: 1, hour_utc: 6 }), 'Every Monday at 06:00 UTC');
    console.log('header.js smoke: ok');
})().catch(e => { console.error('header.js smoke FAILED:', e.message); process.exit(1); });
