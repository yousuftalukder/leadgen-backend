// Token exchange, /debug_token, asset discovery (all Business Managers → owned + client pages → linked IG),
// attaching assets to a client, resolving the token for an asset, and validating stored tokens.
//
// v2.1.1 changes:
//  * resolveAssetToken() tries every source in turn and REPORTS each failure, instead of throwing on the
//    first one. A v1 blob on the FB asset no longer hides a perfectly good token on the connection.
//  * legacy (plaintext / v1 CBC) tokens are re-encrypted in place the first time they are used.
//  * assetTokenDiagnostics() explains, per asset, exactly why a sync cannot start and what to do.
//  * attachAssets() validates the page token before storing it, records its real expiry, and revives
//    assets previously marked EXPIRED.
const axios = require('axios');
const cfg = require('../config');
const { supabase, q } = require('../db');
const S = require('../security');
const T = require('../time');
const { GraphClient, GraphError } = require('./graph');
const { FB, IG } = require('./metrics');

const base = () => `https://graph.facebook.com/${cfg.meta.defaultApiVersion}`;

// ---------------------------------------------------------------- OAuth
async function exchangeCodeForLongLivedToken(code) {
  const short = await axios.get(`${base()}/oauth/access_token`, { params: { client_id: cfg.meta.appId, client_secret: cfg.meta.appSecret, redirect_uri: cfg.meta.redirectUri, code }, validateStatus: () => true });
  if (short.data?.error) throw new Error(`Meta code exchange failed: ${short.data.error.message}`);
  if (!short.data?.access_token) throw new Error('Meta code exchange returned no access_token.');
  const long = await axios.get(`${base()}/oauth/access_token`, { params: { grant_type: 'fb_exchange_token', client_id: cfg.meta.appId, client_secret: cfg.meta.appSecret, fb_exchange_token: short.data.access_token }, validateStatus: () => true });
  if (long.data?.error) throw new Error(`Meta long-lived exchange failed: ${long.data.error.message}`);
  return long.data.access_token || short.data.access_token;
}

// v2.15.3 (F-59): Meta limits how many calls the app may make in an hour. "(#4) Application request limit reached"
// (also #17 user, #32 page, #613) says nothing about a token: it means stop calling for a while.
const META_LIMIT_CODES = new Set([4, 17, 32, 613]);
const isMetaLimit = (e) => !!e && (e.rateLimited === true || META_LIMIT_CODES.has(Number(e.code)) || /\(#(4|17|32|613)\)|request limit reached/i.test(String(e.message || '')));
async function debugToken(token) {
  const r = await axios.get(`${base()}/debug_token`, { params: { input_token: token, access_token: `${cfg.meta.appId}|${cfg.meta.appSecret}` }, validateStatus: () => true });
  const d = r.data?.data;
  if (!d) {
    const err = r.data?.error || {};
    const e = Object.assign(new Error(err.message || 'debug_token failed'), { code: err.code ?? null });
    e.rateLimited = isMetaLimit(e);
    throw e;
  }
  return {
    is_valid: !!d.is_valid, user_id: d.user_id || null, app_id: d.app_id, type: d.type,
    expires_at: d.expires_at ? new Date(d.expires_at * 1000).toISOString() : null,      // 0/undefined = never (system user / page token)
    scopes: d.scopes || [], error: d.error?.message || null
  };
}

// ---------------------------------------------------------------- discovery
// Returns { user, businesses:[{id,name}], assets:[{ page:{...,access_token?}, ig, sources:[], hasPageToken }] }
async function discoverAssets(token) {
  const g = new GraphClient({ token, delayMs: 50 });
  const pages = new Map();   // page_id -> { page, sources:Set }
  const add = (p, source) => {
    if (!p?.id) return;
    const cur = pages.get(p.id) || { page: {}, sources: new Set() };
    cur.page = { ...cur.page, ...p, access_token: p.access_token || cur.page.access_token };
    cur.sources.add(source);
    pages.set(p.id, cur);
  };

  let user = null;
  try { user = await g.get('me', { fields: 'id,name' }); } catch { /* page/system tokens may not have /me */ }

  // 1. pages the user has a role on (comes with page tokens)
  try { for (const p of await g.paginate('me/accounts', { fields: FB.PAGE_FIELDS + ',access_token' })) add(p, 'me/accounts'); }
  catch (e) { if (!(e instanceof GraphError)) throw e; }

  // 2. every Business Manager → owned + client pages
  const businesses = [];
  try {
    for (const b of await g.paginate('me/businesses', { fields: 'id,name' })) {
      businesses.push({ id: b.id, name: b.name });
      for (const edge of ['owned_pages', 'client_pages']) {
        try { for (const p of await g.paginate(`${b.id}/${edge}`, { fields: FB.PAGE_FIELDS })) add(p, `${b.name}:${edge}`); }
        catch (e) { if (!(e instanceof GraphError)) throw e; }
      }
    }
  } catch (e) { if (!(e instanceof GraphError)) throw e; }

  // 3. pages without a token yet: ask for one directly (works when the user has a task on the page)
  const missing = [...pages.values()].filter((x) => !x.page.access_token).map((x) => x.page.id);
  if (missing.length) {
    const res = await g.batch(missing.map((id) => ({ key: id, relative_url: `${id}?fields=access_token,${FB.PAGE_FIELDS}` })));
    for (const [id, r] of res) if (r.ok && r.body?.access_token) add(r.body, 'direct');
  }

  const assets = [...pages.values()].map((x) => ({
    page: x.page, ig: x.page.instagram_business_account || null,
    sources: [...x.sources], hasPageToken: !!x.page.access_token
  })).sort((a, b) => String(a.page.name).localeCompare(String(b.page.name)));

  return { user, businesses, assets };
}

// ---------------------------------------------------------------- attach
// A Page, and the IG account linked to it, belongs to exactly one client. meta_assets is keyed on
// (platform, asset_id), so attaching a Page another client already holds would MOVE it there, with its
// history, and the first client would stop syncing (F-34). Refuse instead: taking a Page away from a
// client has to be a deliberate act, not a stray tick in the picker.
async function assetsOwnedElsewhere({ clientId, pageIds, discovered }) {
  const ids = [];
  for (const pid of pageIds || []) {
    ids.push(String(pid));
    const a = discovered?.assets?.find((x) => String(x.page.id) === String(pid));
    if (a?.ig?.id) ids.push(String(a.ig.id));
  }
  if (!ids.length) return [];
  const rows = await q(supabase.from('xp_meta_assets').select('platform,asset_id,name,client_id,xp_clients(client_name)').in('asset_id', ids), 'asset owners');
  return rows.filter((r) => String(r.client_id) !== String(clientId || ''))
    .map((r) => ({ platform: r.platform, asset_id: r.asset_id, name: r.name, client_id: r.client_id, client_name: r.xp_clients?.client_name || r.client_id }));
}

function ownedElsewhereError(conflicts) {
  const e = new Error(`Already connected to another client: ${conflicts.map((c) => `${c.platform} "${c.name}" belongs to ${c.client_name}`).join('; ')}. ` +
    'Tick only the Page of the client you are connecting.');
  e.status = 409;
  e.conflicts = conflicts;
  return e;
}

// F-31 (v2.7.2): every attach inserted a connection and none was ever retired, so validateConnections
// kept checking (and alerting on) tokens that no asset uses any more; one client had five. After an
// attach, a connection of this client that no asset points to is SUPERSEDED: kept for the record, no
// longer validated. Needs migration 0020 (the status value); before it, the update is refused and the
// attach itself is unaffected.
async function retireSupersededConnections(clientId) {
  try {
    const [conns, assets] = await Promise.all([
      q(supabase.from('xp_meta_connections').select('id').eq('client_id', clientId).eq('status', 'ACTIVE'), 'client connections'),
      q(supabase.from('xp_meta_assets').select('connection_id').eq('client_id', clientId), 'client assets')
    ]);
    const inUse = new Set(assets.map((a) => a.connection_id).filter(Boolean));
    const stale = conns.map((c) => c.id).filter((id) => !inUse.has(id));
    if (stale.length) await q(supabase.from('xp_meta_connections').update({ status: 'SUPERSEDED' }).in('id', stale), 'retire connections');
    return stale.length;
  } catch (e) {
    console.warn('[attach] superseded connections not retired:', e.message);
    return 0;
  }
}

async function attachAssets({ clientId, userToken, pageIds, discovered, connectionType = 'USER_OAUTH' }) {
  const conflicts = await assetsOwnedElsewhere({ clientId, pageIds, discovered });
  if (conflicts.length) throw ownedElsewhereError(conflicts);
  const dbg = await debugToken(userToken).catch(() => ({ is_valid: true, user_id: null, expires_at: null, scopes: [] }));
  const conn = await q(supabase.from('xp_meta_connections').insert({
    client_id: clientId, connection_type: connectionType, meta_user_id: dbg.user_id,
    business_id: discovered.businesses?.[0]?.id || null, business_name: discovered.businesses?.map((b) => b.name).join(', ') || null,
    token_enc: S.encrypt(userToken), token_expires_at: dbg.expires_at, scopes: dbg.scopes,
    status: dbg.is_valid ? 'ACTIVE' : 'INVALID', last_validated_at: new Date().toISOString(), validation_error: dbg.error
  }).select().single(), 'connection');

  const attached = [], warnings = [];
  for (const pid of pageIds) {
    const a = discovered.assets.find((x) => x.page.id === pid);
    if (!a) { warnings.push(`Page ${pid} was not in the discovery result — skipped.`); continue; }
    const pageToken = a.page.access_token || userToken;
    if (!a.page.access_token) warnings.push(`No page token for "${a.page.name}" — stored the user token instead. Page-level insights may be limited; you need an admin role on the page for a real page token.`);

    // Validate what we are about to store, so a bad token is caught here and not at 3am in cron.
    const pdbg = await debugToken(pageToken).catch((e) => ({ is_valid: false, expires_at: null, error: e.message }));
    if (!pdbg.is_valid) warnings.push(`Token for "${a.page.name}" did not validate: ${pdbg.error || 'invalid'}.`);

    const p = a.page;
    const fb = await q(supabase.from('xp_meta_assets').upsert({
      client_id: clientId, connection_id: conn.id, platform: 'FB', asset_id: p.id, name: p.name, username: p.username || null, category: p.category || null,
      access_token_enc: S.encrypt(pageToken), token_expires_at: pdbg.expires_at || null,
      status: 'ACTIVE',                       // revive assets previously marked EXPIRED
      insights_timezone: T.FB_INSIGHTS_TZ,
      profile: { about: p.about, website: p.website, link: p.link, picture: p.picture?.data?.url, followers_count: p.followers_count, fan_count: p.fan_count, is_verified: p.is_verified, verification_status: p.verification_status }
    }, { onConflict: 'platform,asset_id' }).select().single(), 'asset FB');
    attached.push(fb);

    if (a.ig?.id) {
      const ig = a.ig;
      const igRow = await q(supabase.from('xp_meta_assets').upsert({
        client_id: clientId, connection_id: conn.id, platform: 'IG', asset_id: ig.id, name: ig.name || ig.username, username: ig.username || null, category: null,
        linked_asset_id: fb.id, access_token_enc: S.encrypt(pageToken), token_expires_at: pdbg.expires_at || null,
        status: 'ACTIVE', insights_timezone: T.IG_INSIGHTS_TZ,
        profile: { biography: ig.biography, website: ig.website, picture: ig.profile_picture_url, followers_count: ig.followers_count, follows_count: ig.follows_count, media_count: ig.media_count }
      }, { onConflict: 'platform,asset_id' }).select().single(), 'asset IG');
      attached.push(igRow);
    } else {
      warnings.push(`"${a.page.name}" has no linked Instagram professional account — only Facebook will be tracked.`);
    }
  }
  await q(supabase.from('xp_clients').update({ token_status: 'ACTIVE', last_synced_at: null }).eq('id', clientId), 'client');
  const retired = await retireSupersededConnections(clientId);
  return { connection: conn, attached, warnings, retired_connections: retired };
}

// ---------------------------------------------------------------- tokens
// Try each source in order. Record why each one failed. Re-encrypt legacy blobs on first success.
// Returns { token, source, format, tried: [{source, ok, format, error}] }
async function resolveAssetToken(asset) {
  const tried = [];

  const attempt = async (source, blob, rewrite) => {
    if (blob === null || blob === undefined || String(blob).trim() === '') {
      tried.push({ source, ok: false, format: 'EMPTY', error: 'not set' });
      return null;
    }
    try {
      const { token, format, needsRewrite } = S.readToken(blob, source);
      tried.push({ source, ok: true, format });
      if (needsRewrite && rewrite) {
        await rewrite(S.encrypt(token)).catch((e) => console.warn(`[token] could not upgrade ${source}: ${e.message}`));
        console.warn(`[token] upgraded ${source} for asset ${asset.platform} ${asset.asset_id} from ${format} to AES-GCM`);
      }
      return { token, source, format, tried };
    } catch (e) {
      tried.push({ source, ok: false, format: e.tokenFormat || 'ERROR', error: e.message });
      return null;
    }
  };

  let r = await attempt('asset token', asset.access_token_enc,
    (enc) => q(supabase.from('xp_meta_assets').update({ access_token_enc: enc }).eq('id', asset.id), 'rewrite asset token'));
  if (r) return r;

  if (asset.linked_asset_id) {
    const p = await q(supabase.from('xp_meta_assets').select('id,access_token_enc').eq('id', asset.linked_asset_id).maybeSingle(), 'linked').catch(() => null);
    r = await attempt('linked page token', p?.access_token_enc,
      (enc) => q(supabase.from('xp_meta_assets').update({ access_token_enc: enc }).eq('id', p.id), 'rewrite linked token'));
    if (r) return r;
  } else {
    tried.push({ source: 'linked page token', ok: false, format: 'EMPTY', error: 'asset has no linked page' });
  }

  if (asset.connection_id) {
    const c = await q(supabase.from('xp_meta_connections').select('id,token_enc').eq('id', asset.connection_id).maybeSingle(), 'conn').catch(() => null);
    r = await attempt('connection token', c?.token_enc,
      (enc) => q(supabase.from('xp_meta_connections').update({ token_enc: enc }).eq('id', c.id), 'rewrite conn token'));
    if (r) return r;
  } else {
    tried.push({ source: 'connection token', ok: false, format: 'EMPTY', error: 'asset is not linked to a meta_connections row (v1-migrated asset)' });
  }

  if (cfg.meta.systemUserToken) {
    tried.push({ source: 'META_SYSTEM_USER_TOKEN', ok: true, format: 'ENV' });
    return { token: cfg.meta.systemUserToken, source: 'META_SYSTEM_USER_TOKEN', format: 'ENV', tried };
  }
  tried.push({ source: 'META_SYSTEM_USER_TOKEN', ok: false, format: 'EMPTY', error: 'not set in .env' });

  const detail = tried.map((t) => `  · ${t.source}: ${t.ok ? 'ok' : `${t.format} — ${t.error}`}`).join('\n');
  const err = new Error(
    `No usable Meta token for ${asset.platform} "${asset.name || asset.asset_id}".\n${detail}\n` +
    `Fix: open the admin, press Reconnect on this client and complete the asset picker — that writes fresh page tokens. ` +
    `If Reconnect is not possible, paste a page token via the asset's Repair token button.`
  );
  err.tried = tried;
  err.isTokenResolution = true;
  throw err;
}

// Back-compatible: sync.js and anything else calling this still get a plain string.
async function tokenForAsset(asset) {
  return (await resolveAssetToken(asset)).token;
}

// An Instagram professional account is readable ONLY through the access token of the Facebook Page
// it is linked to. A *user* token that can happily read the Page itself returns
//   "Object with ID '<ig-id>' does not exist, cannot be loaded due to missing permissions"
// for a perfectly valid IG account id. v1 stored one token per client with no distinction, so
// migrated rows commonly hold a user token — Facebook syncs, Instagram fails, and the error text
// points at permissions rather than at the token type.
//
// This asks Meta for the Page's own token using whatever token we have, stores it on both the FB
// and IG asset rows, and returns it. One extra call, once, and then it is cached in the DB.
async function upgradeToPageToken(asset, currentToken) {
  const pageAssetId = asset.platform === 'IG' ? asset.linked_asset_id : asset.id;
  if (!pageAssetId) return null;
  const page = await q(supabase.from('xp_meta_assets').select('id,asset_id,platform').eq('id', pageAssetId).maybeSingle(), 'page for upgrade');
  if (!page?.asset_id) return null;

  const g = new GraphClient({ token: currentToken, delayMs: 0 });
  let pageToken = null;
  try {
    const r = await g.get(page.asset_id, { fields: 'access_token' });
    pageToken = r?.access_token || null;
  } catch { /* fall through to me/accounts */ }
  if (!pageToken) {
    try {
      for (const p of await g.paginate('me/accounts', { fields: 'id,access_token' }, { maxPages: 10 })) {
        if (String(p.id) === String(page.asset_id) && p.access_token) { pageToken = p.access_token; break; }
      }
    } catch { /* give up */ }
  }
  if (!pageToken || pageToken === currentToken) return null;

  const enc = S.encrypt(pageToken);
  const dbg = await debugToken(pageToken).catch(() => ({ expires_at: null }));
  await q(supabase.from('xp_meta_assets').update({ access_token_enc: enc, token_expires_at: dbg.expires_at }).in('id', [page.id, asset.id]), 'store page token').catch(() => {});
  console.warn(`[token] upgraded ${asset.platform} ${asset.asset_id} from a non-page token to the Page token for ${page.asset_id}`);
  return pageToken;
}

// ---------------------------------------------------------------- diagnostics
// Answers "why will this asset not sync?" without running a sync. Never throws.
async function assetTokenDiagnostics(clientId) {
  let sel = supabase.from('xp_meta_assets').select('*');
  if (clientId) sel = sel.eq('client_id', clientId);
  const assets = await q(sel.order('platform'), 'diag assets');
  const out = [];
  for (const a of assets) {
    const row = {
      asset_id: a.id, client_id: a.client_id, platform: a.platform, meta_asset_id: a.asset_id, name: a.name, status: a.status,
      stored_format: S.tokenFormat(a.access_token_enc), has_connection: !!a.connection_id, has_linked: !!a.linked_asset_id,
      resolved: false, source: null, tried: [], token_valid: null, token_expires_at: null, scopes: [], error: null, hint: null
    };
    let token = null;
    try {
      const r = await resolveAssetToken(a);
      token = r.token; row.resolved = true; row.source = r.source; row.tried = r.tried;
    } catch (e) {
      row.tried = e.tried || []; row.error = e.message;
      row.hint = 'Reconnect this client via Meta OAuth (admin → Reconnect), or use Repair token.';
    }
    if (token) {
      try {
        const d = await debugToken(token);
        row.token_valid = d.is_valid; row.token_expires_at = d.expires_at; row.scopes = d.scopes;
        if (!d.is_valid) { row.error = d.error || 'token rejected by Meta'; row.hint = 'Token is decryptable but Meta says it is invalid or expired. Reconnect.'; }
        else {
          const need = a.platform === 'IG' ? ['instagram_basic', 'instagram_manage_insights'] : ['pages_read_engagement', 'read_insights'];
          const missing = need.filter((s) => !d.scopes.includes(s));
          if (missing.length) { row.error = `missing scope(s): ${missing.join(', ')}`; row.hint = 'Reconnect and accept all permissions in the Meta dialog.'; }
        }
      } catch (e) { row.token_valid = false; row.error = e.message; }
    }
    out.push(row);
  }
  return { checked_at: new Date().toISOString(), assets: out };
}

// Store a manually supplied page token on one asset (and its linked IG asset).
async function repairAssetToken(assetId, rawToken) {
  const token = String(rawToken || '').trim();
  if (!token) throw new Error('A token is required.');
  const asset = await q(supabase.from('xp_meta_assets').select('*').eq('id', assetId).single(), 'repair asset');
  const d = await debugToken(token);
  if (!d.is_valid) throw new Error(`Meta rejected this token: ${d.error || 'invalid'}`);
  const enc = S.encrypt(token);
  const ids = [assetId];
  const linked = await q(supabase.from('xp_meta_assets').select('id').eq('linked_asset_id', assetId), 'linked assets').catch(() => []);
  for (const l of linked || []) ids.push(l.id);
  await q(supabase.from('xp_meta_assets').update({ access_token_enc: enc, token_expires_at: d.expires_at, status: 'ACTIVE' }).in('id', ids), 'repair write');
  return { updated: ids.length, platform: asset.platform, name: asset.name, expires_at: d.expires_at, scopes: d.scopes };
}

// Validates every ACTIVE connection and every ACTIVE asset token. Marks EXPIRED/INVALID. Returns problems[].
// Live: one Meta call per connection and one or two per account. It stops at the first "request limit reached"
// (problems.metaBusy = true): the tokens are not the problem, and more calls would only keep the limit on.
async function validateConnections() {
  const problems = [];
  const now = new Date().toISOString();
  const conns = await q(supabase.from('xp_meta_connections').select('id,client_id,connection_type,token_enc,status').eq('status', 'ACTIVE'), 'conns');
  for (const c of conns) {
    try {
      const d = await debugToken(S.decrypt(c.token_enc));
      const status = d.is_valid ? 'ACTIVE' : 'EXPIRED';
      await q(supabase.from('xp_meta_connections').update({ status, last_validated_at: now, token_expires_at: d.expires_at, validation_error: d.error, scopes: d.scopes }).eq('id', c.id), 'conn upd');
      if (!d.is_valid) problems.push({ kind: 'connection', id: c.id, client_id: c.client_id, error: d.error || 'token invalid' });
    } catch (e) {
      if (isMetaLimit(e)) { problems.metaBusy = true; return problems; }
      problems.push({ kind: 'connection', id: c.id, client_id: c.client_id, error: e.message });
    }
  }
  // Check assets through the SAME resolution path the sync uses, so this dashboard cannot disagree with reality.
  const assets = await q(supabase.from('xp_meta_assets').select('*').eq('status', 'ACTIVE'), 'assets');
  for (const a of assets) {
    try {
      const { token, source } = await resolveAssetToken(a);
      const d = await debugToken(token);
      if (!d.is_valid) {
        await q(supabase.from('xp_meta_assets').update({ status: 'EXPIRED' }).eq('id', a.id), 'asset upd');
        problems.push({ kind: 'asset', id: a.id, client_id: a.client_id, platform: a.platform, name: a.name, source, error: d.error || 'page token invalid' });
      } else if (d.expires_at) await q(supabase.from('xp_meta_assets').update({ token_expires_at: d.expires_at }).eq('id', a.id), 'asset exp');
    } catch (e) {
      if (isMetaLimit(e)) { problems.metaBusy = true; return problems; }
      problems.push({ kind: 'asset', id: a.id, client_id: a.client_id, platform: a.platform, name: a.name, error: e.message, fixable: !!e.isTokenResolution });
    }
  }
  return problems;
}

module.exports = {
  exchangeCodeForLongLivedToken, debugToken, discoverAssets, attachAssets, assetsOwnedElsewhere, ownedElsewhereError,
  tokenForAsset, resolveAssetToken, upgradeToPageToken, assetTokenDiagnostics, repairAssetToken, validateConnections, isMetaLimit, FB, IG
};
