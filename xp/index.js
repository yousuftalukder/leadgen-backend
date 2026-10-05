/**
 * The XpulseAI Owner Assistant, inside EdgeLead. (phase 31)
 *
 * Everything else under xp/ is XpulseAI's code, copied: the warehouse sync
 * (ingest/sync.js), the chat and its 19 SQL-backed tools (ai/chat.js), the
 * figure panels (ai/charts.js), the Graph client, the token handling. This
 * file is the seam. On one side EdgeLead: a signed-in account, a client
 * record, a Meta connection made here. On the other XpulseAI: xp_clients,
 * xp_meta_assets, twice-daily reads, and an answer that streams.
 *
 *   provisionClient  EdgeLead client + its connections → xp_clients / xp_meta_connections / xp_meta_assets
 *   mount            the chat, conversation, status and sync routes, behind EdgeLead's auth
 *   start            the cron pair (09:00 and 21:00 UTC) and the boot-time provisioning pass
 */
'use strict';
const cron = require('node-cron');
const cfg = require('./config');
const { supabase, q } = require('./db');
const influencers = require('./social/influencers');
const apify = require('./apify');
const S = require('./security');
const T = require('./time');
const chat = require('./ai/chat');
const { panelsFor } = require('./ai/charts');
const { syncAll, syncClient, finalize } = require('./ingest/sync');
let ads = null;
try { ads = require('./ingest/ads'); } catch (e) { ads = null; }

const CONV_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAT_MAX_CHARS = 2000;
const CHAT_TITLE_MAX = 80;

// ---------------------------------------------------------------- XpulseAI's route helpers, verbatim
function chatMessageError(message) {
  if (typeof message !== 'string' || !message.trim()) return 'message required.';
  if (message.length > CHAT_MAX_CHARS) return `Please keep a question under ${CHAT_MAX_CHARS.toLocaleString('en-US')} characters.`;
  return null;
}
function publicChatError(e) {
  if (e && e.code === 'CHAT_TIMEOUT') return 'That answer took too long. Please ask again, or ask about a shorter period.';
  if (/\b429\b|RESOURCE_EXHAUSTED|quota|rate limit/i.test(String((e && e.message) || ''))) return 'The assistant is busy right now. Please try again in a minute.';
  return 'Something went wrong while reading your numbers. Please try again in a moment.';
}
const cleanChatTitle = (t) => typeof t === 'string'
  ? Array.from(t.replace(/[\x00-\x1f\x7f-\x9f​-‏‪-‮⁦-⁩﻿]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, CHAT_TITLE_MAX).join('').trim()
  : '';
async function chatQuota(clientId) {
  const limit = cfg.chatDailyLimit;
  if (!limit) return null;
  const client = await q(supabase.from('xp_clients').select('timezone').eq('id', clientId).single(), 'quota client');
  const tz = client.timezone || cfg.defaultClientTz;
  const since = T.DateTime.now().setZone(tz).startOf('day').toUTC().toISO();
  const { count, error } = await supabase.from('xp_ai_messages')
    .select('id, xp_ai_conversations!inner(client_id)', { count: 'exact', head: true })
    .eq('role', 'user').eq('xp_ai_conversations.client_id', clientId).gte('created_at', since);
  if (error) throw new Error(`[quota] ${error.message}`);
  const used = count || 0;
  return { limit, used, remaining: Math.max(0, limit - used), tz };
}
async function chatLimitCheck(isAdmin, clientId) {
  if (isAdmin) return { ok: true, quota: null };
  let quota = null;
  try { quota = await chatQuota(clientId); } catch (e) { console.error('[chat] daily limit not checked, question allowed:', e.message); }
  if (quota && quota.remaining <= 0) {
    const city = String(quota.tz).split('/').pop().replace(/_/g, ' ');
    return { ok: false, quota, error: `You have asked ${quota.limit.toLocaleString('en-US')} questions today, which is the daily limit. It resets at midnight, ${city} time.` };
  }
  return { ok: true, quota };
}
const leftAfter = (quota) => (quota ? Math.max(0, quota.remaining - 1) : null);

// ---------------------------------------------------------------- provisioning: EdgeLead → XpulseAI
let deps = {};

/**
 * One EdgeLead client and every active Meta connection filed under it become
 * one xp_clients row (same id), one xp_meta_connections row per connection,
 * and an FB asset plus an IG asset per Page. Tokens are read with EdgeLead's
 * key and sealed again with XpulseAI's; the sync then works exactly as it
 * does in XpulseAI. Idempotent: run it as often as you like.
 */
async function provisionClient(clientId) {
  const { data: c } = await supabase.from('clients').select('id, name, archived, timezone').eq('id', clientId).maybeSingle();
  if (!c) return { ok: false, error: 'Client not found.' };
  const { data: conns } = await supabase.from('meta_connections').select('*').eq('client_id', clientId).order('created_at', { ascending: false });
  // EdgeLead (phase 45): no connection, no warehouse row. A business that disconnected is not re-created here.
  if (!(conns || []).some((x) => x.status === 'active' && x.page_token_enc)) return { ok: true, clientId: c.id, connections: 0, assets: 0 };
  await q(supabase.from('xp_clients').upsert({
    id: c.id, client_name: c.name || 'Client', timezone: c.timezone || cfg.defaultClientTz,
    is_active: !c.archived, token_status: 'ACTIVE'
  }, { onConflict: 'id' }), 'xp client');

  let assets = 0, connections = 0;
  for (const conn of (conns || []).filter((x) => x.status === 'active' && x.page_token_enc)) {
    let pageToken = null, userToken = null;
    try {
      pageToken = deps.decrypt ? deps.decrypt(conn.page_token_enc) : conn.page_token_enc;
      userToken = conn.user_token_enc ? (deps.decrypt ? deps.decrypt(conn.user_token_enc) : conn.user_token_enc) : null;
    } catch (e) { console.warn('[xp] token unreadable for connection', conn.id, e.message); continue; }
    if (!pageToken) continue;
    const xc = await q(supabase.from('xp_meta_connections').upsert({
      el_connection_id: conn.id, client_id: c.id, connection_type: 'USER_OAUTH',
      meta_user_id: conn.fb_user_id || null,
      token_enc: S.encrypt(userToken || pageToken), token_expires_at: conn.token_expires_at || null,
      scopes: conn.scopes || [], status: 'ACTIVE'
    }, { onConflict: 'el_connection_id' }).select('id').single(), 'xp connection');
    connections += 1;
    const fb = await q(supabase.from('xp_meta_assets').upsert({
      client_id: c.id, connection_id: xc.id, platform: 'FB', asset_id: String(conn.page_id),
      name: conn.page_name || null, access_token_enc: S.encrypt(pageToken),
      token_expires_at: conn.token_expires_at || null, status: 'ACTIVE', insights_timezone: 'America/Los_Angeles'
    }, { onConflict: 'platform,asset_id' }).select('id').single(), 'xp fb asset');
    assets += 1;
    if (conn.ig_user_id) {
      await q(supabase.from('xp_meta_assets').upsert({
        client_id: c.id, connection_id: xc.id, platform: 'IG', asset_id: String(conn.ig_user_id),
        name: conn.ig_username ? `@${conn.ig_username}` : (conn.page_name || null), username: conn.ig_username || null,
        linked_asset_id: fb.id, status: 'ACTIVE', insights_timezone: 'UTC'
      }, { onConflict: 'platform,asset_id' }), 'xp ig asset');
      assets += 1;
    }
  }
  return { ok: true, clientId: c.id, connections, assets };
}

/**
 * EdgeLead (phase 45): delete what the assistant read for a business — all of it, or only what came
 * from some of its EdgeLead connections. The database function does the work, because settled rows
 * are guarded and only it may lift the guard. Returns its counts, or { error } when it is missing.
 */
async function purge(clientId, elConnectionIds = null) {
  const { data, error } = await supabase.rpc('el_xp_purge', { p_client: clientId, p_el_connections: elConnectionIds && elConnectionIds.length ? elConnectionIds : null });
  if (error) return { error: error.message };
  return data || {};
}

/**
 * Copies whose EdgeLead connection is gone — deleted with its client, or before phase 45 — are purged
 * on the next pass, so nothing keeps reading Meta for a connection nobody holds any more.
 */
async function purgeOrphans() {
  const [{ data: xc }, { data: live }] = await Promise.all([
    supabase.from('xp_meta_connections').select('client_id, el_connection_id').not('el_connection_id', 'is', null),
    supabase.from('meta_connections').select('id')
  ]);
  const alive = new Set((live || []).map((r) => r.id));
  const byClient = new Map();
  for (const r of xc || []) if (!alive.has(r.el_connection_id)) byClient.set(r.client_id, [...(byClient.get(r.client_id) || []), r.el_connection_id]);
  let purged = 0;
  for (const [clientId, ids] of byClient) { const r = await purge(clientId, ids); if (!r.error) purged += 1; else console.error('[xp] purge', clientId, r.error); }
  return purged;
}

/** Every EdgeLead client with an active Meta connection. Run at boot and before each cron pass. */
async function provisionAll() {
  await purgeOrphans().catch((e) => console.error('[xp] purgeOrphans', e.message));
  const { data } = await supabase.from('meta_connections').select('client_id').eq('status', 'active');
  const ids = [...new Set((data || []).map((r) => r.client_id).filter(Boolean))];
  const out = { clients: ids.length, assets: 0, failed: 0 };
  for (const id of ids) {
    try { out.assets += (await provisionClient(id)).assets || 0; }
    catch (e) { out.failed += 1; console.error('[xp] provision failed', id, e.message); }
  }
  return out;
}

/**
 * Whether the chat has something to read: an active asset for this client.
 * A client that connected a Page a minute ago is provisioned here on first
 * use; one with no connection at all is not, and the route says so.
 */
async function ensureProvisioned(clientId) {
  const { data } = await supabase.from('xp_meta_assets').select('id').eq('client_id', clientId).eq('status', 'ACTIVE').limit(1);
  if (data && data.length) return true;
  const r = await provisionClient(clientId).catch((e) => ({ ok: false, error: e.message }));
  return !!(r.ok && r.assets);
}

/**
 * EdgeLead (phase 50): the chat works before Meta is connected. Owners live in Edge Meta AI, so a
 * business without Meta still asks about its agency's work, its posts and its reports. It gets a
 * bare xp_clients row to hang its chats on, inactive, so the twice-daily read never tries it; the
 * first Meta connection fills it in and switches it on (provisionClient).
 */
async function ensureChatClient(clientId) {
  if (await ensureProvisioned(clientId)) return true;
  const { data: c } = await supabase.from('clients').select('id, name, archived, timezone').eq('id', clientId).maybeSingle();
  if (!c || c.archived) return false;
  const { data: xc } = await supabase.from('xp_clients').select('id').eq('id', clientId).maybeSingle();
  if (!xc) {
    await q(supabase.from('xp_clients').insert({ id: c.id, client_name: c.name || 'Client', timezone: c.timezone || cfg.defaultClientTz, is_active: false, token_status: 'ACTIVE' }), 'xp chat client');
  }
  return true;
}

// ---------------------------------------------------------------- access, EdgeLead's way
/**
 * Which client this request is about. A client account is its own business
 * and never chooses; staff name one and must be able to read it.
 */
async function clientFor(req, ctx, wanted, need = 'viewer') {
  if (ctx.profile && ctx.profile.role === 'client') {
    const own = await deps.ownClientFor(ctx).catch(() => null);
    if (!own) return null;
    if (wanted && String(wanted) !== String(own.id)) return null;
    return own.id;
  }
  const cid = String(wanted || (req.body && req.body.clientId) || (req.query && (req.query.client_id || req.query.clientId)) || '');
  if (!cid) return null;
  const c = await deps.clientAccess(ctx.user.id, cid, need);
  return c ? c.id : null;
}
const isAdmin = (ctx) => !!(ctx.profile && ctx.profile.role === 'admin');

// ---------------------------------------------------------------- the sync, on demand and on the clock
async function runCron(triggeredBy) {
  await provisionAll().catch((e) => console.error('[xp] provisionAll', e.message));
  const results = await syncAll({ runType: 'CRON', triggeredBy });
  let adsResult = null;
  if (ads && ads.syncAds) adsResult = await ads.syncAds({ triggeredBy }).catch((e) => ({ error: e.message }));
  // EdgeLead (phase 46): creator posts — refresh what is due, and each business's weekly look.
  const creators = apify.hostRunner() ? await influencers.daily().catch((e) => ({ error: e.message })) : null;
  return { results, ads: adsResult, creators };
}

const running = new Map();   // clientId → started at
// What a read runs. A seam for the tests, which have no Graph behind them: they swap in a recorder.
const hooks = { sync: syncClient, ads: ads && ads.syncAds ? ads.syncAds : null };
function _setHooks(h = {}) {
  hooks.sync = h.sync || syncClient;
  hooks.ads = h.ads !== undefined ? h.ads : (ads && ads.syncAds ? ads.syncAds : null);
  kicks.clear();
}
function startSync(clientId, opts, after) {
  if (running.has(clientId)) { const e = new Error('A sync for this client is already running.'); e.status = 409; throw e; }
  running.set(clientId, new Date().toISOString());
  hooks.sync(clientId, opts)
    .then((r) => { console.log('[xp sync]', JSON.stringify({ client: r.client, status: r.status })); if (after) return after(r); })
    .catch((e) => console.error('[xp sync]', clientId, e.message))
    .finally(() => running.delete(clientId));
}

/**
 * EdgeLead (phase 47): a business is read the moment its Meta is connected, not at the next 09:00 or
 * 21:00. Nobody presses anything: the connect callback, filing a Page under a client, the boot pass
 * and the status route all land here. The first read of an asset is its full backfill (90 days and
 * every post) because it has none yet; the ads pass follows, since ads are found through the login.
 *
 * `kicks` keeps one automatic start per business per half hour, so a read that fails is not retried
 * on every status poll; the twice-daily pass and staff's "Read now" still run it.
 */
const KICK_COOLDOWN_MS = 30 * 60000;
const kicks = new Map();     // clientId → last automatic start (ms)
async function kickoff(clientId, triggeredBy = 'connect', { force = false } = {}) {
  if (!clientId) return { started: false, reason: 'no_client' };
  if (running.has(clientId)) return { started: false, reason: 'running' };
  const last = kicks.get(clientId) || 0;
  if (!force && Date.now() - last < KICK_COOLDOWN_MS) return { started: false, reason: 'cooldown' };
  const p = await provisionClient(clientId);
  if (!p.ok || !p.assets) return { started: false, reason: p.ok ? 'no_assets' : 'error', error: p.error };
  kicks.set(clientId, Date.now());
  try {
    startSync(clientId, { runType: 'BACKFILL', triggeredBy }, () => (hooks.ads ? Promise.resolve(hooks.ads({ triggeredBy })).catch(() => null) : null));
  } catch (e) { return { started: false, reason: 'running' }; }
  return { started: true, assets: p.assets };
}

/** Businesses whose Meta is connected but whose history was never read: started once, after boot. */
async function catchUp() {
  const { data } = await supabase.from('xp_meta_assets').select('client_id').is('last_full_backfill_at', null).in('status', ['ACTIVE']);
  const { data: conns } = await supabase.from('meta_connections').select('client_id').eq('status', 'active');
  const { data: known } = await supabase.from('xp_clients').select('id');
  const have = new Set((known || []).map((r) => r.id));
  const ids = new Set([...(data || []).map((r) => r.client_id), ...(conns || []).map((r) => r.client_id).filter((id) => id && !have.has(id))]);
  const out = [];
  for (const id of ids) {
    if (!id) continue;
    out.push({ clientId: id, ...(await kickoff(id, 'catch-up').catch((e) => ({ started: false, error: e.message }))) });
    // one at a time: each first read is a few hundred Graph calls, and they share the app's rate limit
    while (running.size) await new Promise((r) => setTimeout(r, 2000));
  }
  return out;
}

/**
 * Where a business stands, in one word the pages can switch on:
 *   not_connected  no Meta connection filed under it
 *   reconnect      Meta refused the token; only a new login fixes it
 *   reading        connected, history not read yet (a read is running or about to)
 *   ready          there is something to answer from
 */
function phaseOf(s) {
  const assets = s.assets || [];
  if (!s.provisioned || !assets.length) return 'not_connected';
  const live = assets.filter((a) => a.status === 'ACTIVE' || a.status === 'EXPIRED');
  if (!live.length) return 'not_connected';
  const cov = s.coverage && Array.isArray(s.coverage.assets) ? s.coverage.assets : [];
  const hasData = cov.some((a) => a.account_days > 0 || a.post_days > 0);
  if ((s.client && s.client.token_status === 'EXPIRED') || live.every((a) => a.status === 'EXPIRED')) return 'reconnect';
  return hasData ? 'ready' : 'reading';
}

async function status(clientId) {
  const [{ data: xc }, { data: assets }, { data: runs }] = await Promise.all([
    supabase.from('xp_clients').select('id, client_name, timezone, last_synced_at, token_status').eq('id', clientId).maybeSingle(),
    supabase.from('xp_meta_assets').select('id, platform, name, username, status, first_synced_at, last_synced_at, last_full_backfill_at').eq('client_id', clientId).order('platform'),
    supabase.from('xp_sync_runs').select('id, asset_id, run_type, status, posts_seen, snapshots_written, started_at, finished_at, errors').eq('client_id', clientId).order('started_at', { ascending: false }).limit(6)
  ]);
  let coverage = null;
  if (xc) { try { coverage = await chat.coverage(clientId); } catch (e) { coverage = { error: e.message }; } }
  const out = {
    provisioned: !!xc,
    client: xc || null,
    assets: assets || [],
    runs: (runs || []).map((r) => ({ ...r, errors: Array.isArray(r.errors) ? r.errors.slice(0, 3) : [] })),
    running: running.has(clientId),
    coverage,
    model: cfg.gemini.model,
    schedule: { cron: cfg.cron.schedule, tz: cfg.cron.tz, enabled: cfg.cron.enabled }
  };
  out.phase = phaseOf(out);
  return out;
}

// ---------------------------------------------------------------- routes
function mount(app, d) {
  deps = d;
  if (d.geminiKeys) chat.setKeySource(d.geminiKeys);
  if (d.apifyRun) apify.setHostRunner(d.apifyRun);   // EdgeLead (phase 46): creator posts on EdgeLead's Apify keys
  const { auth, requireAdmin, rateLimit, bearerId, logger } = d;
  const log = logger || console;

  /** The client this chat is about, or a response already sent. */
  async function chatContext(req, res, wanted, need = 'viewer') {
    const ctx = await auth(req, res); if (!ctx) return null;
    const clientId = await clientFor(req, ctx, wanted, need);
    if (!clientId) { res.status(ctx.profile && ctx.profile.role === 'client' ? 404 : 403).json({ error: 'No access to that client.' }); return null; }
    return { ctx, clientId };
  }

  app.post('/api/xp/chat', rateLimit({ windowMs: 60000, max: 12, key: bearerId }), async (req, res) => {
    const a = await chatContext(req, res, req.body && req.body.clientId); if (!a) return;
    const { message, conversationId } = req.body || {};
    const bad = chatMessageError(message);
    if (bad) return res.status(400).json({ error: bad });
    if (!(await ensureChatClient(a.clientId))) return res.status(404).json({ error: 'That business could not be found.' });
    const gate = await chatLimitCheck(isAdmin(a.ctx), a.clientId);
    if (!gate.ok) return res.status(429).json({ error: gate.error, limit: gate.quota.limit, remaining: 0 });
    try {
      const out = await chat.answer({ clientId: a.clientId, message: message.trim(), conversationId });
      res.json({ ...out, remaining: leftAfter(gate.quota) });
    } catch (e) {
      log.error ? log.error('xp_chat_failed', { message: e.message }) : console.error('[xp chat]', e);
      res.status(e.code === 'CHAT_TIMEOUT' ? 504 : 500).json({ error: publicChatError(e) });
    }
  });

  // Streaming variant: Server-Sent Events over a POST. Events: status, delta, done, error. (XpulseAI, verbatim)
  app.post('/api/xp/chat/stream', rateLimit({ windowMs: 60000, max: 12, key: bearerId }), async (req, res) => {
    const a = await chatContext(req, res, req.body && req.body.clientId); if (!a) return;
    const { message, conversationId } = req.body || {};
    const bad = chatMessageError(message);
    if (bad) return res.status(400).json({ error: bad });
    if (!(await ensureChatClient(a.clientId))) return res.status(404).json({ error: 'That business could not be found.' });
    const gate = await chatLimitCheck(isAdmin(a.ctx), a.clientId);
    if (!gate.ok) return res.status(429).json({ error: gate.error, limit: gate.quota.limit, remaining: 0 });
    res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    if (res.flushHeaders) res.flushHeaders();
    const gone = new AbortController();
    res.on('close', () => { if (!res.writableEnded) gone.abort(); });
    const send = (type, data) => { if (!res.writableEnded) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
    const ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000);
    try {
      const out = await chat.answer({ clientId: a.clientId, message: message.trim(), conversationId, onEvent: (ev) => send(ev.type, ev), signal: gone.signal });
      send('done', { conversationId: out.conversationId, reply: out.reply, suggestions: out.suggestions, charts: out.charts || [], remaining: leftAfter(gate.quota) });
    } catch (e) {
      if (e.code === 'CHAT_CANCELLED') return;
      console.error('[xp chat/stream]', e.message);
      send('error', { error: publicChatError(e) });
    } finally {
      clearInterval(ping);
      res.end();
    }
  });

  app.get('/api/xp/chat/:clientId/conversations', async (req, res) => {
    const a = await chatContext(req, res, req.params.clientId); if (!a) return;
    try {
      const rows = await q(supabase.from('xp_ai_conversations').select('id,title,created_at,updated_at').eq('client_id', a.clientId).is('deleted_at', null).order('updated_at', { ascending: false }).limit(50), 'convs');
      res.json({ conversations: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // One past conversation, its figure panels rebuilt from the tool results stored with each answer. (XpulseAI, verbatim)
  app.get('/api/xp/chat/:clientId/conversations/:conversationId', async (req, res) => {
    const a = await chatContext(req, res, req.params.clientId); if (!a) return;
    const { conversationId } = req.params;
    if (!CONV_ID_RE.test(conversationId)) return res.status(404).json({ error: 'Conversation not found.' });
    try {
      const conv = await q(supabase.from('xp_ai_conversations').select('id,client_id,title,deleted_at').eq('id', conversationId).maybeSingle(), 'conv');
      if (!conv || conv.client_id !== a.clientId || conv.deleted_at) return res.status(404).json({ error: 'Conversation not found.' });
      const rows = (await q(supabase.from('xp_ai_messages').select('role,content,created_at,tool_calls,tool_results').eq('conversation_id', conv.id)
        .order('created_at', { ascending: false }).limit(60), 'messages')).reverse();
      let lastQuestion = '';
      const asked = [];
      const kept = rows.filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content));
      const lastAnswer = kept.map((m) => m.role).lastIndexOf('assistant');
      const messages = kept.map((m, i) => {
        if (m.role === 'user') { lastQuestion = m.content || ''; asked.push(lastQuestion); return { role: 'user', content: m.content, created_at: m.created_at }; }
        let charts = [];
        try { charts = panelsFor(m.tool_calls || [], m.tool_results || [], { question: lastQuestion }); } catch (e) { console.warn('[conversation] panels:', e.message); }
        let suggestions;
        if (i === lastAnswer) {
          try { suggestions = chat.suggestionsFor(m.tool_calls || [], m.tool_results || [], asked.join(' \n '), lastQuestion); } catch (e) { console.warn('[conversation] suggestions:', e.message); }
        }
        return { role: 'assistant', content: m.content, created_at: m.created_at, charts, ...(suggestions && suggestions.length ? { suggestions } : {}) };
      });
      res.json({ id: conv.id, title: conv.title, messages });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/xp/chat/:clientId/conversations/:conversationId', async (req, res) => {
    const a = await chatContext(req, res, req.params.clientId); if (!a) return;
    const { conversationId } = req.params;
    if (!CONV_ID_RE.test(conversationId)) return res.status(404).json({ error: 'Conversation not found.' });
    try {
      // EdgeLead (phase 45): deleting a chat erases it — the title, every question and answer, and the
      // data behind each answer. What stays is one bare row per message (when, and the tokens it cost),
      // because the daily question limit and the cost figures count them; deleting a chat must not
      // reset the limit. Those bare rows go with the rest after CHAT_RETENTION_DAYS.
      const rows = await q(supabase.from('xp_ai_conversations').update({ deleted_at: new Date().toISOString(), title: null })
        .eq('id', conversationId).eq('client_id', a.clientId).is('deleted_at', null).select('id'), 'delete conv');
      if (!rows.length) return res.status(404).json({ error: 'Conversation not found.' });
      await q(supabase.from('xp_ai_messages').update({ content: null, tool_calls: null, tool_results: null })
        .eq('conversation_id', conversationId).select('id'), 'erase messages');
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/xp/chat/:clientId/conversations/:conversationId', async (req, res) => {
    const a = await chatContext(req, res, req.params.clientId); if (!a) return;
    const { conversationId } = req.params;
    if (!CONV_ID_RE.test(conversationId)) return res.status(404).json({ error: 'Conversation not found.' });
    const title = cleanChatTitle(req.body && req.body.title);
    if (!title) return res.status(400).json({ error: 'Type a name for the chat.' });
    try {
      const rows = await q(supabase.from('xp_ai_conversations').update({ title })
        .eq('id', conversationId).eq('client_id', a.clientId).is('deleted_at', null).select('id,title'), 'rename conv');
      if (!rows.length) return res.status(404).json({ error: 'Conversation not found.' });
      res.json({ success: true, title: rows[0].title });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- creator posts (phase 46): staff only. The weekly look keeps posts that look like a customer's
  // hidden until staff show them, and only shown posts reach the owner's answers.
  async function creatorsContext(req, res, wanted, need) {
    const a = await chatContext(req, res, wanted, need); if (!a) return null;
    if (a.ctx.profile && a.ctx.profile.role === 'client') { res.status(403).json({ error: 'Creator posts are managed by your agency.' }); return null; }
    if (!(await ensureProvisioned(a.clientId))) { res.status(409).json({ error: 'Connect this business\'s Facebook Page and Instagram account first.' }); return null; }
    return a;
  }
  const creatorErr = (res, e) => res.status(e.status && e.status < 600 ? e.status : (e.code === 'NO_CREDIT' ? 402 : 500)).json({ error: typeof e.message === 'string' ? e.message : String(e.message || e) });
  app.get('/api/xp/creators', async (req, res) => {
    const a = await creatorsContext(req, res, req.query.client_id, 'viewer'); if (!a) return;
    try { res.json(await influencers.pageFor(a.clientId)); } catch (e) { creatorErr(res, e); }
  });
  app.post('/api/xp/creators/look', rateLimit({ windowMs: 60000, max: 3, key: bearerId }), async (req, res) => {
    const a = await creatorsContext(req, res, req.body && req.body.clientId, 'editor'); if (!a) return;
    try {
      const by = a.ctx.profile?.full_name || a.ctx.user.email || 'staff';
      const kind = req.body && req.body.refresh ? 'refresh' : 'discover';
      const job = influencers.startJob(a.clientId, kind, by, kind === 'refresh'
        ? () => influencers.refreshNumbers({ clientId: a.clientId, force: true }) : () => influencers.discover(a.clientId, { by }));
      res.status(202).json({ job: influencers.publicJob(job) });
    } catch (e) { creatorErr(res, e); }
  });
  app.post('/api/xp/creators', rateLimit({ windowMs: 60000, max: 10, key: bearerId }), async (req, res) => {
    const a = await creatorsContext(req, res, req.body && req.body.clientId, 'editor'); if (!a) return;
    const b = req.body || {};
    try { res.status(201).json(await influencers.addByLink(a.clientId, b.link, { visitDate: b.visitDate, costUsd: b.costUsd, notes: b.notes, by: a.ctx.profile?.full_name || a.ctx.user.email })); }
    catch (e) { creatorErr(res, e); }
  });
  app.patch('/api/xp/creators/:id', async (req, res) => {
    const a = await creatorsContext(req, res, req.body && req.body.clientId, 'editor'); if (!a) return;
    const b = req.body || {};
    try { res.json(await influencers.update(req.params.id, a.clientId, { status: b.status, visitDate: b.visitDate, costUsd: b.costUsd, notes: b.notes })); }
    catch (e) { creatorErr(res, e); }
  });
  app.delete('/api/xp/creators/:id', async (req, res) => {
    const a = await creatorsContext(req, res, req.query.client_id, 'editor'); if (!a) return;
    try { res.json(await influencers.remove(req.params.id, a.clientId)); } catch (e) { creatorErr(res, e); }
  });

  /** What the warehouse holds for this client: assets, last reads, coverage, whether a read is running. */
  app.get('/api/xp/status', async (req, res) => {
    const a = await chatContext(req, res, req.query.client_id || req.query.clientId); if (!a) return;
    try {
      let s = await status(a.clientId);
      // EdgeLead (phase 47): opening the page is enough. A business with Meta connected and nothing
      // read yet is started here, so nobody is ever shown a button they have to find and press.
      if (!s.running && (s.phase === 'reading' || s.phase === 'not_connected')) {
        const k = await kickoff(a.clientId, 'status').catch(() => ({ started: false }));
        if (k.started) s = await status(a.clientId);
      }
      res.json(s);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  /** Read the numbers now: provision from EdgeLead's connection, then XpulseAI's sync, in the background. */
  app.post('/api/xp/sync', rateLimit({ windowMs: 60000, max: 3, key: bearerId }), async (req, res) => {
    const a = await chatContext(req, res, req.body && req.body.clientId, 'editor'); if (!a) return;
    try {
      const p = await provisionClient(a.clientId);
      if (!p.ok) return res.status(400).json({ error: p.error });
      if (!p.assets) return res.status(409).json({ error: 'No Meta connection filed under this client yet. Connect a Facebook Page and Instagram account first.' });
      // Re-reading the whole history, or a range of days, is the team's tool; an owner's read is the normal one.
      const b = req.body || {};
      const staff = !(a.ctx.profile && a.ctx.profile.role === 'client');
      const opts = { runType: 'MANUAL', triggeredBy: (a.ctx.user && a.ctx.user.email) || 'user' };
      if (staff && b.fullBackfill) Object.assign(opts, { runType: 'BACKFILL', fullBackfill: true });
      if (staff && (b.rangeStart || b.rangeEnd)) {
        const r = rangeError(b.rangeStart, b.rangeEnd);
        if (r) return res.status(400).json({ error: r });
        Object.assign(opts, { runType: 'BACKFILL', rangeStart: b.rangeStart, rangeEnd: b.rangeEnd });
      }
      startSync(a.clientId, opts);
      res.status(202).json({ started: true, assets: p.assets, runType: opts.runType });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  /** Admin: every asset's health and the last runs, and a manual pass over everyone. */
  app.get('/api/xp/admin/health', async (req, res) => {
    const ctx = await requireAdmin(req, res); if (!ctx) return;
    try {
      const [{ data: health }, { data: runs }, { data: clients }] = await Promise.all([
        supabase.from('xp_v_sync_health').select('*').limit(200),
        supabase.from('xp_sync_runs').select('id, client_id, asset_id, run_type, status, posts_seen, snapshots_written, started_at, finished_at').order('started_at', { ascending: false }).limit(30),
        supabase.from('xp_clients').select('id, client_name, timezone, is_active, last_synced_at, token_status').order('client_name')
      ]);
      res.json({ health: health || [], runs: runs || [], clients: clients || [], running: [...running.keys()], schedule: { cron: cfg.cron.schedule, tz: cfg.cron.tz, enabled: cfg.cron.enabled }, model: cfg.gemini.model });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  /**
   * EdgeLead (phase 47): every business with Meta, on one screen — the connection and its access, what
   * the assistant has read and what it is missing, the last read, the owner's login and whether they
   * use the chat. Built for the question "who needs me today?", so each row carries its own verdict.
   */
  app.get('/api/xp/admin/overview', async (req, res) => {
    const ctx = await requireAdmin(req, res); if (!ctx) return;
    try { res.json(await overview()); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/xp/admin/sync-all', async (req, res) => {
    const ctx = await requireAdmin(req, res); if (!ctx) return;
    runCron(ctx.user.email || 'admin').then((r) => console.log('[xp cron]', JSON.stringify(r).slice(0, 500))).catch((e) => console.error('[xp cron]', e.message));
    res.status(202).json({ started: true });
  });
}

/** A staff backfill range: two real days, oldest first, not in the future, at most 93 days (one Graph window). */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function rangeError(start, end) {
  if (!DAY_RE.test(String(start || '')) || !DAY_RE.test(String(end || ''))) return 'Give both days, like 2026-08-01 and 2026-08-31.';
  const a = Date.parse(start + 'T00:00:00Z'), b = Date.parse(end + 'T00:00:00Z');
  // Round-trip, because Date.parse reads 2026-02-30 as 2 March instead of refusing it.
  if (Number.isNaN(a) || Number.isNaN(b) || new Date(a).toISOString().slice(0, 10) !== start || new Date(b).toISOString().slice(0, 10) !== end) return 'Those are not real days.';
  if (a > b) return 'The first day comes after the last.';
  if (b > Date.now() + 86400000) return 'The last day is in the future.';
  if ((b - a) / 86400000 > 92) return 'At most 93 days at a time. Read a long gap in pieces.';
  return null;
}

const DAY_MS = 86400000;
/** The overview behind the admin's Meta tab. Reads everything once and joins in memory. */
async function overview(now = Date.now()) {
  const [{ data: conns }, { data: xcs }, { data: assets }, { data: health }, { data: runs }, { data: convs }] = await Promise.all([
    supabase.from('meta_connections').select('id, client_id, page_id, page_name, ig_username, status, token_expires_at, last_error, last_sync_at, created_at'),
    supabase.from('xp_clients').select('id, client_name, last_synced_at, token_status, is_active'),
    supabase.from('xp_meta_assets').select('id, client_id, platform, name, username, status, first_synced_at, last_synced_at, last_full_backfill_at'),
    supabase.from('xp_v_sync_health').select('asset_id, missing_days_30'),
    supabase.from('xp_sync_runs').select('id, client_id, asset_id, run_type, status, errors, started_at, finished_at').order('started_at', { ascending: false }).limit(400),
    supabase.from('xp_ai_conversations').select('client_id, updated_at').is('deleted_at', null).gte('updated_at', new Date(now - 30 * DAY_MS).toISOString())
  ]);
  // A chat-only business (phase 50: no Meta yet) has an xp_clients row but nothing to read: not listed here.
  const ids = [...new Set([...(conns || []).map((c) => c.client_id), ...(assets || []).map((a) => a.client_id)].filter(Boolean))];
  const [{ data: clients }, { data: members }] = ids.length ? await Promise.all([
    supabase.from('clients').select('id, name, archived').in('id', ids),
    supabase.from('client_members').select('client_id, user_id, created_at').in('client_id', ids)
  ]) : [{ data: [] }, { data: [] }];
  const memberIds = [...new Set((members || []).map((m) => m.user_id))];
  const { data: users } = memberIds.length ? await supabase.from('app_users').select('id, email, full_name, role').in('id', memberIds) : { data: [] };
  const userById = new Map((users || []).map((u) => [u.id, u]));
  const missing = new Map((health || []).map((h) => [h.asset_id, Number(h.missing_days_30) || 0]));
  const lastRun = new Map();
  for (const r of runs || []) if (r.asset_id && !lastRun.has(r.asset_id)) lastRun.set(r.asset_id, r);

  const rows = ids.map((id) => {
    const c = (clients || []).find((x) => x.id === id) || {};
    const xc = (xcs || []).find((x) => x.id === id) || null;
    const cs = (conns || []).filter((x) => x.client_id === id);
    const as = (assets || []).filter((x) => x.client_id === id && x.status !== 'REMOVED').map((a) => {
      const r = lastRun.get(a.id) || null;
      return {
        id: a.id, platform: a.platform, name: a.name, username: a.username, status: a.status,
        firstReadAt: a.first_synced_at, lastReadAt: a.last_synced_at, historyReadAt: a.last_full_backfill_at,
        missingDays30: missing.has(a.id) ? missing.get(a.id) : null,
        lastRun: r ? { type: r.run_type, status: r.status, at: r.finished_at || r.started_at, error: Array.isArray(r.errors) && r.errors[0] ? String(r.errors[0].message || r.errors[0].error || '').slice(0, 200) : null } : null
      };
    });
    const owners = (members || []).filter((m) => m.client_id === id && (userById.get(m.user_id) || {}).role === 'client')
      .map((m) => ({ userId: m.user_id, email: userById.get(m.user_id).email, name: userById.get(m.user_id).full_name || null, since: m.created_at }));
    const chats = (convs || []).filter((x) => x.client_id === id);
    const expiries = cs.filter((x) => x.status === 'active' && x.token_expires_at).map((x) => Date.parse(x.token_expires_at));
    const accessUntil = expiries.length ? new Date(Math.min(...expiries)).toISOString() : null;
    const running_ = running.has(id);

    // One verdict, worst first, and what to do about it.
    const issues = [];
    if (!cs.some((x) => x.status === 'active')) issues.push({ level: 'bad', code: 'no_connection', text: cs.length ? 'Meta disconnected' : 'Meta not connected' });
    if ((xc && xc.token_status === 'EXPIRED') || as.some((a) => a.status === 'EXPIRED') || cs.some((x) => ['error', 'expired', 'revoked'].includes(x.status))) issues.push({ level: 'bad', code: 'reconnect', text: 'Meta refused the login: reconnect' });
    else if (accessUntil && Date.parse(accessUntil) - now < 10 * DAY_MS) issues.push({ level: 'warn', code: 'expiring', text: 'Meta access ends ' + accessUntil.slice(0, 10) + ': reconnect before then' });
    if (as.length && as.some((a) => !a.historyReadAt)) issues.push({ level: running_ ? 'info' : 'warn', code: 'history', text: running_ ? 'Reading the history now' : 'History not read yet' });
    if (as.some((a) => a.lastRun && a.lastRun.status === 'FAILED')) issues.push({ level: 'bad', code: 'failed', text: 'Last read failed' });
    else if (as.some((a) => a.lastRun && a.lastRun.status === 'PARTIAL')) issues.push({ level: 'warn', code: 'partial', text: 'Last read partly failed' });
    const stale = as.some((a) => a.historyReadAt && (!a.lastReadAt || now - Date.parse(a.lastReadAt) > 1.5 * DAY_MS));
    if (stale) issues.push({ level: 'warn', code: 'stale', text: 'Not read for over a day' });
    if (as.some((a) => (a.missingDays30 || 0) > 2 && a.historyReadAt)) issues.push({ level: 'warn', code: 'gaps', text: 'Days missing in the last 30' });
    if (!owners.length) issues.push({ level: 'info', code: 'no_owner', text: 'Owner has no login' });
    const worst = issues.find((i) => i.level === 'bad') ? 'bad' : issues.find((i) => i.level === 'warn') ? 'warn' : 'ok';

    return {
      clientId: id, name: c.name || (xc && xc.client_name) || 'Client', archived: !!c.archived,
      connections: cs.map((x) => ({ id: x.id, page: x.page_name || x.page_id, instagram: x.ig_username || null, status: x.status, accessUntil: x.token_expires_at, error: x.last_error || null, since: x.created_at })),
      accessUntil, assets: as, running: running_,
      lastReadAt: xc ? xc.last_synced_at : null,
      owners, chats30: chats.length, lastChatAt: chats.map((x) => x.updated_at).sort().pop() || null,
      issues, verdict: worst
    };
  }).sort((a, b) => ({ bad: 0, warn: 1, ok: 2 }[a.verdict] - { bad: 0, warn: 1, ok: 2 }[b.verdict]) || a.name.localeCompare(b.name));

  return {
    rows,
    totals: { businesses: rows.length, ok: rows.filter((r) => r.verdict === 'ok').length, warn: rows.filter((r) => r.verdict === 'warn').length, bad: rows.filter((r) => r.verdict === 'bad').length, running: running.size, withOwnerLogin: rows.filter((r) => r.owners.length).length },
    schedule: { cron: cfg.cron.schedule, tz: cfg.cron.tz, enabled: cfg.cron.enabled },
    model: cfg.gemini.model
  };
}

/** EdgeLead (phase 45): chats not touched for CHAT_RETENTION_DAYS (default 365) are deleted, daily. */
const CHAT_RETENTION_DAYS = parseInt(process.env.CHAT_RETENTION_DAYS || '365', 10);
async function purgeOldChats(now = Date.now()) {
  const cutoff = new Date(now - CHAT_RETENTION_DAYS * 86400000).toISOString();
  const { data, error } = await supabase.from('xp_ai_conversations').delete().lt('updated_at', cutoff).select('id');
  if (error) throw new Error(error.message);
  return (data || []).length;
}

function start() {
  setInterval(() => purgeOldChats().then((n) => { if (n) console.log('[xp] old chats deleted', n); }).catch((e) => console.error('[xp] purgeOldChats', e.message)), 86400000).unref?.();
  if (!cfg.cron.enabled) return { enabled: false };
  setTimeout(() => provisionAll()
    .then((r) => { console.log('[xp] provisioned', JSON.stringify(r)); return catchUp(); })
    .then((r) => { if (r && r.length) console.log('[xp] first reads started', r.filter((x) => x.started).length); })
    .catch((e) => console.error('[xp] provision', e.message)), 20000).unref?.();
  cron.schedule(cfg.cron.schedule, () => runCron('internal-cron').then((r) => console.log('[xp cron]', JSON.stringify(r).slice(0, 500))).catch((e) => console.error('[xp cron]', e.message)), { timezone: cfg.cron.tz });
  console.log(`[xp] owner assistant sync on: "${cfg.cron.schedule}" ${cfg.cron.tz}`);
  return { enabled: true, schedule: cfg.cron.schedule };
}

module.exports = { mount, start, provisionClient, provisionAll, ensureProvisioned, status, runCron, chat, finalize, cfg, purge, purgeOrphans, purgeOldChats, kickoff, catchUp, overview, phaseOf, rangeError, _setHooks, ensureChatClient };
