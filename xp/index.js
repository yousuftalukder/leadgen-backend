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

/** Every EdgeLead client with an active Meta connection. Run at boot and before each cron pass. */
async function provisionAll() {
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
  return { results, ads: adsResult };
}

const running = new Map();   // clientId → started at
function startSync(clientId, opts) {
  if (running.has(clientId)) { const e = new Error('A sync for this client is already running.'); e.status = 409; throw e; }
  running.set(clientId, new Date().toISOString());
  syncClient(clientId, opts)
    .then((r) => console.log('[xp sync]', JSON.stringify({ client: r.client, status: r.status })))
    .catch((e) => console.error('[xp sync]', clientId, e.message))
    .finally(() => running.delete(clientId));
}

async function status(clientId) {
  const [{ data: xc }, { data: assets }, { data: runs }] = await Promise.all([
    supabase.from('xp_clients').select('id, client_name, timezone, last_synced_at, token_status').eq('id', clientId).maybeSingle(),
    supabase.from('xp_meta_assets').select('id, platform, name, username, status, first_synced_at, last_synced_at, last_full_backfill_at').eq('client_id', clientId).order('platform'),
    supabase.from('xp_sync_runs').select('id, asset_id, run_type, status, posts_seen, snapshots_written, started_at, finished_at, errors').eq('client_id', clientId).order('started_at', { ascending: false }).limit(6)
  ]);
  let coverage = null;
  if (xc) { try { coverage = await chat.coverage(clientId); } catch (e) { coverage = { error: e.message }; } }
  return {
    provisioned: !!xc,
    client: xc || null,
    assets: assets || [],
    runs: (runs || []).map((r) => ({ ...r, errors: Array.isArray(r.errors) ? r.errors.slice(0, 3) : [] })),
    running: running.has(clientId),
    coverage,
    model: cfg.gemini.model,
    schedule: { cron: cfg.cron.schedule, tz: cfg.cron.tz, enabled: cfg.cron.enabled }
  };
}

// ---------------------------------------------------------------- routes
function mount(app, d) {
  deps = d;
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
    if (!(await ensureProvisioned(a.clientId))) return res.status(409).json({ error: 'Connect a Facebook Page and Instagram account first — the assistant reads your own numbers.' });
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
    if (!(await ensureProvisioned(a.clientId))) return res.status(409).json({ error: 'Connect a Facebook Page and Instagram account first — the assistant reads your own numbers.' });
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
      const rows = await q(supabase.from('xp_ai_conversations').update({ deleted_at: new Date().toISOString() })
        .eq('id', conversationId).eq('client_id', a.clientId).is('deleted_at', null).select('id'), 'delete conv');
      if (!rows.length) return res.status(404).json({ error: 'Conversation not found.' });
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

  /** What the warehouse holds for this client: assets, last reads, coverage, whether a read is running. */
  app.get('/api/xp/status', async (req, res) => {
    const a = await chatContext(req, res, req.query.client_id || req.query.clientId); if (!a) return;
    try { res.json(await status(a.clientId)); } catch (e) { res.status(500).json({ error: e.message }); }
  });

  /** Read the numbers now: provision from EdgeLead's connection, then XpulseAI's sync, in the background. */
  app.post('/api/xp/sync', rateLimit({ windowMs: 60000, max: 3, key: bearerId }), async (req, res) => {
    const a = await chatContext(req, res, req.body && req.body.clientId, 'editor'); if (!a) return;
    try {
      const p = await provisionClient(a.clientId);
      if (!p.ok) return res.status(400).json({ error: p.error });
      if (!p.assets) return res.status(409).json({ error: 'No Meta connection filed under this client yet. Connect a Facebook Page and Instagram account first.' });
      startSync(a.clientId, { runType: 'MANUAL', triggeredBy: (a.ctx.user && a.ctx.user.email) || 'user', fullBackfill: !!(req.body && req.body.fullBackfill) });
      res.status(202).json({ started: true, assets: p.assets });
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
  app.post('/api/xp/admin/sync-all', async (req, res) => {
    const ctx = await requireAdmin(req, res); if (!ctx) return;
    runCron(ctx.user.email || 'admin').then((r) => console.log('[xp cron]', JSON.stringify(r).slice(0, 500))).catch((e) => console.error('[xp cron]', e.message));
    res.status(202).json({ started: true });
  });
}

function start() {
  if (!cfg.cron.enabled) return { enabled: false };
  setTimeout(() => provisionAll().then((r) => console.log('[xp] provisioned', JSON.stringify(r))).catch((e) => console.error('[xp] provision', e.message)), 20000).unref?.();
  cron.schedule(cfg.cron.schedule, () => runCron('internal-cron').then((r) => console.log('[xp cron]', JSON.stringify(r).slice(0, 500))).catch((e) => console.error('[xp cron]', e.message)), { timezone: cfg.cron.tz });
  console.log(`[xp] owner assistant sync on: "${cfg.cron.schedule}" ${cfg.cron.tz}`);
  return { enabled: true, schedule: cfg.cron.schedule };
}

module.exports = { mount, start, provisionClient, provisionAll, ensureProvisioned, status, runCron, chat, finalize, cfg };
