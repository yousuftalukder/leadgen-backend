// Apify key pool (v2.9.2). The influencer and content-audit scrapers (the next steps) run on Apify.
//
// Keys are added in the X Pulse Workspace (Settings → Apify keys) and kept encrypted in apify_keys (0026);
// a key in Render's APIFY_TOKEN, if one is set, joins the pool too. A run uses the usable key with the
// most credit left in its monthly cycle. When Apify refuses a key (401: not valid, 402: out of credit,
// 403: not allowed) the key is marked and the run moves on to the next one; any other failure (a bad
// input, a timeout) is the run's problem, not the key's, so it is reported instead. No function here
// returns a key to a browser: listKeys() gives the last four characters only.
//
// Apify's terms (4.3) allow one personal account per person; organization accounts are not limited.
// The pool is for keys you may hold (a paid key and a backup, an organization's keys), not for stacking
// free personal accounts.
const API = 'https://api.apify.com/v2';
const REFRESH_MS = 10 * 60 * 1000;   // how old a key's credit figures may be before a run re-reads them
const MIN_LEFT_USD = 0.05;           // less than this left in the cycle counts as spent
const KEY_RE = /^[A-Za-z0-9_-]{20,200}$/;

function createPool({ store, http, encrypt, decrypt, env = process.env, now = () => Date.now() }) {
  const nowIso = () => new Date(now()).toISOString();
  const envToken = () => (env.APIFY_TOKEN || '').trim();
  // The Render key lives in memory only: its figures are re-read after a restart.
  const envState = { id: 'env', label: 'Render (APIFY_TOKEN)', status: 'ACTIVE', runs: 0, source: 'render' };

  async function call(token, method, path, body) {
    let res;
    try {
      res = await http(API + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      return { ok: false, status: 0, error: `Apify could not be reached (${e.message}).` };
    }
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) return { ok: false, status: res.status, type: data?.error?.type || null, error: data?.error?.message || `Apify answered ${res.status}.` };
    return { ok: true, status: res.status, data };
  }

  // Who the key belongs to and where its month stands. Throws { status } when Apify refuses the key.
  async function readAccount(token) {
    const me = await call(token, 'GET', '/users/me');
    if (!me.ok) throw Object.assign(new Error(me.status === 401 ? 'Apify says this key is not valid.' : me.error), { status: me.status });
    const lim = await call(token, 'GET', '/users/me/limits');
    if (!lim.ok) throw Object.assign(new Error(lim.error), { status: lim.status });
    const u = me.data?.data || {}, l = lim.data?.data || {};
    return {
      userId: u.id || null, username: u.username || null, plan: u.plan?.id || null, isPaying: typeof u.isPaying === 'boolean' ? u.isPaying : null,
      limitUsd: Number(l.limits?.maxMonthlyUsageUsd ?? NaN), usedUsd: Number(l.current?.monthlyUsageUsd ?? NaN),
      cycleStart: l.monthlyUsageCycle?.startAt || null, cycleEnd: l.monthlyUsageCycle?.endAt || null
    };
  }
  const leftOf = (k) => (Number.isFinite(Number(k.limit_usd)) && Number.isFinite(Number(k.used_usd)) && k.limit_usd !== null && k.used_usd !== null
    ? Math.max(0, Number(k.limit_usd) - Number(k.used_usd)) : null);
  function figures(a) {
    const spent = Number.isFinite(a.limitUsd) && Number.isFinite(a.usedUsd) && a.limitUsd - a.usedUsd < MIN_LEFT_USD;
    return {
      apify_user_id: a.userId, apify_username: a.username, plan: a.plan, is_paying: a.isPaying,
      limit_usd: Number.isFinite(a.limitUsd) ? a.limitUsd : null, used_usd: Number.isFinite(a.usedUsd) ? a.usedUsd : null,
      cycle_start: a.cycleStart, cycle_end: a.cycleEnd,
      exhausted_until: spent ? a.cycleEnd || new Date(now() + 24 * 3600e3).toISOString() : null,
      last_checked_at: nowIso(), last_error: null
    };
  }
  async function patchKey(key, patch) {
    if (key.id === 'env') { Object.assign(envState, patch); return envState; }
    return store.update(key.id, { ...patch, updated_at: nowIso() });
  }

  // Add a key from the workspace. A key for an Apify account already in the pool replaces that one's key.
  async function addKey({ label, token, createdBy }) {
    const t = String(token || '').trim();
    if (!KEY_RE.test(t)) throw Object.assign(new Error('That does not look like an Apify API key. Copy it from Apify Console → Settings → API & Integrations.'), { status: 400 });
    let acct;
    try { acct = await readAccount(t); } catch (e) { throw Object.assign(new Error(e.status === 401 ? 'Apify says this key is not valid.' : e.message), { status: 400 }); }
    const row = { label: String(label || '').trim().slice(0, 60) || acct.username || 'Apify key', token_enc: encrypt(t), token_last4: t.slice(-4), status: 'ACTIVE', ...figures(acct) };
    const existing = acct.userId ? await store.findByAccount(acct.userId) : null;
    if (existing) {
      const key = await store.update(existing.id, { ...row, label: String(label || '').trim() ? row.label : existing.label, updated_at: nowIso() });
      return { replaced: true, key: publicKey(key) };
    }
    return { replaced: false, key: publicKey(await store.insert({ ...row, created_by: createdBy || null })) };
  }

  // Re-read one key's account and credit. Returns the key's public view.
  async function checkKey(key) {
    const token = key.id === 'env' ? envToken() : decrypt(key.token_enc);
    try {
      return await patchKey(key, { ...figures(await readAccount(token)), ...(key.status === 'INVALID' ? { status: 'ACTIVE' } : {}) });
    } catch (e) {
      if (e.status === 401) return patchKey(key, { status: 'INVALID', last_error: 'Apify says this key is not valid.', last_checked_at: nowIso() });
      return patchKey(key, { last_error: e.message, last_checked_at: nowIso() });
    }
  }
  async function allKeys() {
    const rows = await store.list();
    return envToken() ? [...rows, envState] : rows;
  }
  async function checkAll() {
    for (const k of await allKeys()) if (k.status !== 'DISABLED') await checkKey(k);
    return listKeys();
  }
  function publicKey(k) {
    return {
      id: k.id, label: k.label, last4: k.id === 'env' ? envToken().slice(-4) : k.token_last4, source: k.id === 'env' ? 'render' : 'workspace',
      status: k.status, username: k.apify_username || null, plan: k.plan || null, is_paying: k.is_paying ?? null,
      limit_usd: k.limit_usd ?? null, used_usd: k.used_usd ?? null, left_usd: leftOf(k), cycle_end: k.cycle_end || null,
      out_of_credit: !!(k.exhausted_until && Date.parse(k.exhausted_until) > now()), exhausted_until: k.exhausted_until || null,
      runs: k.runs || 0, last_used_at: k.last_used_at || null, last_checked_at: k.last_checked_at || null, last_error: k.last_error || null,
      created_at: k.created_at || null
    };
  }
  async function listKeys() {
    const keys = (await allKeys()).map(publicKey);
    const usable = keys.filter((k) => k.status === 'ACTIVE' && !k.out_of_credit);
    return { keys, usable: usable.length, left_usd: Math.round(usable.reduce((s, k) => s + (k.left_usd || 0), 0) * 100) / 100 };
  }

  // The key a run should use now: active, not out of credit, the most credit left; the least recently used on a tie.
  async function pickKey(exclude = []) {
    const out = [];
    for (let k of await allKeys()) {
      if (exclude.includes(k.id) || k.status !== 'ACTIVE') continue;
      if (!k.last_checked_at || now() - Date.parse(k.last_checked_at) > REFRESH_MS) k = await checkKey(k);
      if (k.status !== 'ACTIVE' || (k.exhausted_until && Date.parse(k.exhausted_until) > now())) continue;
      const left = leftOf(k);
      if (left !== null && left < MIN_LEFT_USD) continue;
      out.push({ k, left: left === null ? -1 : left });   // figures unknown (Apify unreachable): try it last
    }
    out.sort((a, b) => b.left - a.left || (Date.parse(a.k.last_used_at || 0) - Date.parse(b.k.last_used_at || 0)));
    return out.length ? out[0].k : null;
  }

  // Run an actor synchronously and return its dataset items. actorId: 'apify/instagram-scraper' or 'apify~instagram-scraper'.
  // Apify ends a synchronous run after 300 seconds (408), so timeoutSecs stays under that.
  async function runActor(actorId, input, { timeoutSecs = 240, maxItems, maxTotalChargeUsd } = {}) {
    const q = new URLSearchParams({ timeout: String(Math.min(290, timeoutSecs)) });
    if (maxItems) q.set('maxItems', String(maxItems));
    if (maxTotalChargeUsd) q.set('maxTotalChargeUsd', String(maxTotalChargeUsd));
    const path = `/acts/${encodeURIComponent(String(actorId).replace('/', '~'))}/run-sync-get-dataset-items?${q}`;
    const tried = [];
    for (;;) {
      const key = await pickKey(tried);
      if (!key) {
        const e = new Error(tried.length ? 'Every Apify key is out of credit or refused. Check Workspace → Settings → Apify keys.' : 'No Apify key with credit yet. Add one in Workspace → Settings → Apify keys.');
        e.code = 'APIFY_NO_KEY';
        e.status = 503;
        throw e;
      }
      tried.push(key.id);
      const token = key.id === 'env' ? envToken() : decrypt(key.token_enc);
      const r = await call(token, 'POST', path, input || {});
      if (r.ok) {
        // The run cost credit: note the use and re-read the figures before the next pick.
        await patchKey(key, { runs: (key.runs || 0) + 1, last_used_at: nowIso(), last_error: null, last_checked_at: null });
        return { items: Array.isArray(r.data) ? r.data : [], key: { id: key.id, label: key.label } };
      }
      if (r.status === 401) { await patchKey(key, { status: 'INVALID', last_error: 'Apify says this key is not valid.' }); continue; }
      if (r.status === 402) {
        const until = key.cycle_end && Date.parse(key.cycle_end) > now() ? key.cycle_end : new Date(now() + 24 * 3600e3).toISOString();
        await patchKey(key, { exhausted_until: until, last_error: `Out of credit: ${r.error}` });
        continue;
      }
      if (r.status === 403) { await patchKey(key, { last_error: `Not allowed: ${r.error}`, exhausted_until: new Date(now() + 3600e3).toISOString() }); continue; }
      const e = new Error(`Apify: ${r.error}`);
      e.status = r.status;
      throw e;
    }
  }

  // v2.11.0: the same, run asynchronously so a run can take longer than 300 s and so its cost is known:
  // start, wait (Apify holds each call up to 60 s), then read the dataset. Returns { items, key, runId,
  // costUsd, status }. A run that FAILED or was ABORTED throws; one that TIMED-OUT returns what it collected.
  async function runTracked(actorId, input, { timeoutSecs = 600, maxItems, maxTotalChargeUsd, memoryMbytes } = {}) {
    const q = new URLSearchParams({ timeout: String(timeoutSecs), waitForFinish: '60' });
    if (maxItems) q.set('maxItems', String(maxItems));
    if (maxTotalChargeUsd) q.set('maxTotalChargeUsd', String(maxTotalChargeUsd));
    if (memoryMbytes) q.set('memory', String(memoryMbytes));
    const actor = encodeURIComponent(String(actorId).replace('/', '~'));
    const tried = [];
    for (;;) {
      const key = await pickKey(tried);
      if (!key) {
        const e = new Error(tried.length ? 'Every Apify key is out of credit or refused. Check Workspace → Settings → Apify keys.' : 'No Apify key with credit yet. Add one in Workspace → Settings → Apify keys.');
        e.code = 'APIFY_NO_KEY';
        e.status = 503;
        throw e;
      }
      tried.push(key.id);
      const token = key.id === 'env' ? envToken() : decrypt(key.token_enc);
      const started = await call(token, 'POST', `/acts/${actor}/runs?${q}`, input || {});
      if (!started.ok) {
        if (started.status === 401) { await patchKey(key, { status: 'INVALID', last_error: 'Apify says this key is not valid.' }); continue; }
        if (started.status === 402) {
          const until = key.cycle_end && Date.parse(key.cycle_end) > now() ? key.cycle_end : new Date(now() + 24 * 3600e3).toISOString();
          await patchKey(key, { exhausted_until: until, last_error: `Out of credit: ${started.error}` });
          continue;
        }
        if (started.status === 403) { await patchKey(key, { last_error: `Not allowed: ${started.error}`, exhausted_until: new Date(now() + 3600e3).toISOString() }); continue; }
        throw Object.assign(new Error(`Apify: ${started.error}`), { status: started.status });
      }
      let run = started.data?.data || {};
      const deadline = now() + (timeoutSecs + 180) * 1000;
      while (['READY', 'RUNNING', 'TIMING-OUT', 'ABORTING'].includes(run.status) && now() < deadline) {
        const r = await call(token, 'GET', `/actor-runs/${encodeURIComponent(run.id)}?waitForFinish=60`);
        if (!r.ok) throw Object.assign(new Error(`Apify: ${r.error}`), { status: r.status, runId: run.id });
        run = r.data?.data || run;
      }
      let costUsd = runCost(run);
      await patchKey(key, { runs: (key.runs || 0) + 1, last_used_at: nowIso(), last_error: null, last_checked_at: null });
      if (!['SUCCEEDED', 'TIMED-OUT'].includes(run.status)) {
        throw Object.assign(new Error(`Apify run ${String(run.status || 'unknown').toLowerCase()}${run.statusMessage ? `: ${run.statusMessage}` : ''}.`), { runId: run.id, costUsd, keyLabel: key.label });
      }
      const ds = await call(token, 'GET', `/datasets/${encodeURIComponent(run.defaultDatasetId)}/items?clean=true&format=json`);
      if (!ds.ok) throw Object.assign(new Error(`Apify: ${ds.error}`), { status: ds.status, runId: run.id, costUsd, keyLabel: key.label });
      const items = Array.isArray(ds.data) ? ds.data : [];
      // Apify counts a run's charges over the seconds after it ends: read them again, and never record less
      // than the results times the price of one.
      if (items.length) {
        const again = await call(token, 'GET', `/actor-runs/${encodeURIComponent(run.id)}`);
        costUsd = Math.max(costUsd, again.ok ? runCost(again.data?.data) : 0, Math.round(items.length * primaryPrice(run) * 1e6) / 1e6);
      }
      return { items, key: { id: key.id, label: key.label }, runId: run.id, costUsd, status: run.status };
    }
  }

  async function setStatus(id, status) {
    if (id === 'env') throw Object.assign(new Error('The Render key is switched on or off in Render (APIFY_TOKEN).'), { status: 400 });
    if (!['ACTIVE', 'DISABLED'].includes(status)) throw Object.assign(new Error('Unknown status.'), { status: 400 });
    return publicKey(await store.update(id, { status, updated_at: nowIso() }));
  }
  async function renameKey(id, label) {
    if (id === 'env') throw Object.assign(new Error('The Render key keeps its name.'), { status: 400 });
    const l = String(label || '').trim().slice(0, 60);
    if (!l) throw Object.assign(new Error('A name is required.'), { status: 400 });
    return publicKey(await store.update(id, { label: l, updated_at: nowIso() }));
  }
  async function removeKey(id) {
    if (id === 'env') throw Object.assign(new Error('The Render key is removed in Render (delete APIFY_TOKEN).'), { status: 400 });
    await store.remove(id);
    return { removed: true };
  }
  async function findKey(id) { return id === 'env' ? (envToken() ? envState : null) : store.get(id); }

  return { addKey, checkKey, checkAll, listKeys, pickKey, runActor, runTracked, setStatus, renameKey, removeKey, findKey, readAccount };
}

// What a run cost. A pay-per-result actor fills usageTotalUsd a few seconds after the run ends, while its
// charged events are there at once, so both are counted and the larger kept.
function runCost(run) {
  const prices = run?.pricingInfo?.pricingPerEvent?.actorChargeEvents || {};
  let events = 0;
  for (const [name, n] of Object.entries(run?.chargedEventCounts || {})) events += (Number(prices[name]?.eventPriceUsd) || 0) * (Number(n) || 0);
  return Math.round(Math.max(events, Number(run?.usageTotalUsd) || 0) * 1e6) / 1e6;
}

// The price of one result of a pay-per-result actor (0 when the actor is priced some other way).
function primaryPrice(run) {
  const events = Object.values(run?.pricingInfo?.pricingPerEvent?.actorChargeEvents || {});
  const main = events.find((e) => e.isPrimaryEvent) || events.find((e) => !e.isOneTimeEvent);
  return Number(main?.eventPriceUsd) || 0;
}

// The pool on the live database.
function supabaseStore(supabase, q) {
  const cols = '*';
  return {
    list: () => q(supabase.from('xp_apify_keys').select(cols).order('created_at'), 'apify keys'),
    get: (id) => q(supabase.from('xp_apify_keys').select(cols).eq('id', id).maybeSingle(), 'apify key'),
    findByAccount: (userId) => q(supabase.from('xp_apify_keys').select(cols).eq('apify_user_id', userId).maybeSingle(), 'apify key account'),
    insert: (row) => q(supabase.from('xp_apify_keys').insert(row).select(cols).single(), 'apify key add'),
    update: (id, patch) => q(supabase.from('xp_apify_keys').update(patch).eq('id', id).select(cols).single(), 'apify key update'),
    remove: (id) => q(supabase.from('xp_apify_keys').delete().eq('id', id), 'apify key remove')
  };
}

let shared = null;
function pool() {
  if (!shared) {
    const { supabase, q } = require('./db');
    const S = require('./security');
    shared = createPool({ store: supabaseStore(supabase, q), http: (...a) => fetch(...a), encrypt: S.encrypt, decrypt: S.decrypt });
  }
  return shared;
}

module.exports = { createPool, supabaseStore, pool, runCost, primaryPrice, MIN_LEFT_USD };
