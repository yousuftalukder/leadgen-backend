// Token-expiry + sync-failure alerts. Called from runCron() and from scripts/check-tokens.js
const axios = require('axios');
const cfg = require('../config');
const { supabase, q } = require('../db');
const { validateConnections } = require('../meta/discovery');

const DAYS = 24 * 60 * 60 * 1000;

// The env var wins; otherwise the "Alert webhook" field in the admin, which saves to system_config and
// until 18 Sep was never read by anything.
async function webhookUrl() {
  if (cfg.cron.alertWebhook) return cfg.cron.alertWebhook;
  const sc = await q(supabase.from('xp_system_config').select('alert_webhook_url').eq('id', 1).maybeSingle(), 'alert webhook').catch(() => null);
  return sc?.alert_webhook_url || null;
}

async function post(text) {
  const url = await webhookUrl();
  if (!url) { console.warn('[alert] no webhook configured:\n' + text); return false; }
  try { await axios.post(url, { content: text, text }); return true; }   // Discord uses `content`, Slack uses `text`
  catch (e) { console.error('[alert]', e.message); return false; }
}

// Connections/assets expiring within `withinDays`, plus anything already non-ACTIVE.
async function tokenExpiryReport(withinDays = 7) {
  const cutoff = new Date(Date.now() + withinDays * DAYS).toISOString();
  const conns = await q(supabase.from('xp_meta_connections')
    .select('id,client_id,connection_type,status,token_expires_at,validation_error, xp_clients(client_name)')
    .or(`status.neq.ACTIVE,token_expires_at.lte.${cutoff}`), 'conn expiry');
  const assets = await q(supabase.from('xp_meta_assets')
    .select('id,client_id,platform,name,status,token_expires_at, xp_clients(client_name)')
    .or(`status.eq.EXPIRED,token_expires_at.lte.${cutoff}`), 'asset expiry');
  const live = await validateConnections();   // hits /debug_token, marks EXPIRED/INVALID in DB
  // v2.15.3: Meta refusing calls for a while (its hourly limit) is not a token problem; nothing was checked.
  return { connections: conns, assets, live_problems: [...live], meta_busy: !!live.metaBusy };
}

async function alertTokenExpiry(withinDays = 7) {
  const r = await tokenExpiryReport(withinDays);
  const lines = [];
  for (const c of r.connections) lines.push(`- ${c.clients?.client_name || c.client_id}: ${c.connection_type} connection ${c.status}${c.token_expires_at ? ` (expires ${c.token_expires_at.slice(0, 10)})` : ''}${c.validation_error ? ` — ${c.validation_error}` : ''}`);
  for (const a of r.assets) lines.push(`- ${a.clients?.client_name || a.client_id}: ${a.platform} ${a.name} ${a.status}${a.token_expires_at ? ` (expires ${a.token_expires_at.slice(0, 10)})` : ''}`);
  for (const p of r.live_problems || []) lines.push(`- live check: ${JSON.stringify(p)}`);
  if (!lines.length) return { alerted: false, count: 0 };
  const uniq = [...new Set(lines)];
  await post(`🔑 XPulse — Meta tokens need attention (${uniq.length}):\n${uniq.join('\n')}\nReconnect via /api/auth/facebook?clientId=<id>`);
  return { alerted: true, count: uniq.length, lines: uniq };
}

async function alertSyncFailures(results) {
  const failures = (results || []).filter((r) => r.status !== 'OK');
  if (!failures.length) return false;
  return post(`🚨 XPulse sync issues:\n` + failures.map((f) => `- ${f.client}: ${f.error || f.status}`).join('\n'));
}

module.exports = { post, tokenExpiryReport, alertTokenExpiry, alertSyncFailures };
