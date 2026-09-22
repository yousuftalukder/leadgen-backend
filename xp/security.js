// AES-256-GCM token storage, scrypt passwords, HMAC sessions, signed OAuth state.
//
// v2.1.1 — token decryption is now tolerant and self-describing.
// The v1 database stored tokens in a different shape than v2 writes them. `migrations_0001`
// copied `clients.meta_access_token` straight into `meta_assets.access_token_enc`, so a v1 row
// can hold a plaintext token, or a 2-part CBC blob, instead of v2's `iv:tag:cipher`.
// The old decrypt() threw a bare "Invalid token format." for all of these, which surfaced in the
// admin run log as a fatal error with no way to tell WHICH problem it was or how to fix it.
//
// Now: readToken() recognises every historical shape, returns the format it found, and throws an
// error that names the cause and the remedy. Callers re-encrypt legacy blobs in place, so the
// problem heals itself the first time a token is used successfully.
const crypto = require('crypto');
const cfg = require('./config');

const KEY = crypto.createHash('sha256').update(cfg.encryptionKey).digest();

const HEX = /^[0-9a-f]+$/i;
// Meta user/page/system-user tokens: long, URL-safe, no colons. EAA... is the common prefix.
const META_TOKEN_RE = /^[A-Za-z0-9_\-.|]{40,}$/;

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
}

// Describe a stored blob WITHOUT decrypting it. Safe to call on anything; never throws.
// Returns one of: EMPTY | GCM | CBC_LEGACY | PLAINTEXT | UNKNOWN
function tokenFormat(blob) {
  if (blob === null || blob === undefined || String(blob).trim() === '') return 'EMPTY';
  const s = String(blob).trim();
  const parts = s.split(':');
  if (parts.length === 3 && parts.every((p) => p && HEX.test(p)) && parts[0].length === 24 && parts[1].length === 32) return 'GCM';
  if (parts.length === 2 && parts.every((p) => p && HEX.test(p)) && parts[0].length === 32) return 'CBC_LEGACY';
  if (parts.length === 1 && META_TOKEN_RE.test(s)) return 'PLAINTEXT';
  return 'UNKNOWN';
}

// Full read. Returns { token, format, needsRewrite }.
// needsRewrite=true means the caller should re-store encrypt(token) to upgrade the row.
function readToken(blob, label = 'token') {
  const format = tokenFormat(blob);
  const s = String(blob ?? '').trim();

  if (format === 'EMPTY') {
    const e = new Error(`No ${label} stored.`);
    e.tokenFormat = 'EMPTY';
    throw e;
  }

  if (format === 'GCM') {
    const [ivHex, tagHex, encHex] = s.split(':');
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivHex, 'hex'));
      d.setAuthTag(Buffer.from(tagHex, 'hex'));
      return { token: Buffer.concat([d.update(Buffer.from(encHex, 'hex')), d.final()]).toString('utf8'), format, needsRewrite: false };
    } catch {
      const e = new Error(`Stored ${label} is AES-GCM but will not decrypt — ENCRYPTION_KEY has changed since it was written. Restore the old ENCRYPTION_KEY, or reconnect this client via Meta OAuth to write a fresh token.`);
      e.tokenFormat = 'GCM_BAD_KEY';
      throw e;
    }
  }

  if (format === 'CBC_LEGACY') {
    const [ivHex, encHex] = s.split(':');
    try {
      const d = crypto.createDecipheriv('aes-256-cbc', KEY, Buffer.from(ivHex, 'hex'));
      const out = Buffer.concat([d.update(Buffer.from(encHex, 'hex')), d.final()]).toString('utf8');
      if (!META_TOKEN_RE.test(out)) throw new Error('decrypted to something that is not a token');
      return { token: out, format, needsRewrite: true };
    } catch {
      const e = new Error(`Stored ${label} looks like a v1 AES-CBC blob but will not decrypt with the current ENCRYPTION_KEY. Reconnect this client via Meta OAuth, or paste a page token in the admin (Token → Repair).`);
      e.tokenFormat = 'CBC_BAD_KEY';
      throw e;
    }
  }

  if (format === 'PLAINTEXT') {
    // A v1 row that was never encrypted. Usable as-is; caller re-encrypts it.
    return { token: s, format, needsRewrite: true };
  }

  const e = new Error(`Stored ${label} is in an unrecognised format (${s.length} chars, ${s.split(':').length} segment(s)). It is not AES-GCM, not v1 AES-CBC, and not a bare Meta token. Reconnect this client via Meta OAuth to replace it.`);
  e.tokenFormat = 'UNKNOWN';
  throw e;
}

// Back-compatible: same signature and return type as before, just with real error messages.
function decrypt(blob) {
  return readToken(blob).token;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  // A v1 plaintext password is `salt:hash`-shaped only by accident; require both halves to be hex.
  const parts = String(stored).split(':');
  const looksHashed = parts.length === 2 && HEX.test(parts[0]) && HEX.test(parts[1]) && parts[1].length === 128;
  if (!looksHashed) {
    const a = Buffer.from(String(password));
    const b = Buffer.from(String(stored));
    return a.length === b.length && crypto.timingSafeEqual(a, b);   // legacy plaintext; auto-migrated on login
  }
  const [salt, hashHex] = parts;
  const a = crypto.scryptSync(password, salt, 64);
  const b = Buffer.from(hashHex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// True when `stored` still needs to be re-hashed on next successful login.
function passwordNeedsRehash(stored) {
  const parts = String(stored || '').split(':');
  return !(parts.length === 2 && HEX.test(parts[0]) && HEX.test(parts[1]) && parts[1].length === 128);
}

// v2.7.2 (F-37): a client session belongs to the password it was opened with. The token carries a
// short stamp of the stored password hash, so a new password ends every session opened with the old
// one; the server also refuses sessions of a deactivated client (server.js clientSession). Before,
// a token lived its full 12 hours whatever happened to the account.
function passwordStamp(storedPassword) {
  return crypto.createHmac('sha256', cfg.clientSessionSecret).update(`pw:${storedPassword || ''}`).digest('hex').slice(0, 16);
}

// ttlMs: 12 h by default; "Remember me" on the portal's sign-in asks for cfg.clientRememberTtlMs (v2.8.3).
// Either way the token dies at once when the password changes (the stamp) or the client is deactivated.
function signClientToken(clientId, storedPassword = '', ttlMs = cfg.clientSessionTtlMs) {
  const expiresAt = Date.now() + ttlMs;
  const payload = `${clientId}.${expiresAt}.${passwordStamp(storedPassword)}`;
  const sig = crypto.createHmac('sha256', cfg.clientSessionSecret).update(payload).digest('hex');
  return { token: `${payload}.${sig}`, expiresAt };
}

// { clientId, stamp } for a well-signed, unexpired token, else null. Tokens from before v2.7.2 have
// three parts and no stamp; they are refused, so everyone signs in once after the upgrade.
function readClientToken(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 4) return null;
  const [clientId, exp, stamp, sig] = parts;
  if (!HEX.test(sig) || !HEX.test(stamp)) return null;
  const expected = crypto.createHmac('sha256', cfg.clientSessionSecret).update(`${clientId}.${exp}.${stamp}`).digest('hex');
  const a = Buffer.from(sig, 'hex'), b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (!(Date.now() <= parseInt(exp, 10))) return null;
  return { clientId, stamp };
}

function verifyClientToken(token) {
  const t = readClientToken(token);
  return t ? t.clientId : null;
}

// v2.9.0: X Pulse staff sessions for the workspace. The same idea as a client token (expiry and a stamp
// of the password it was opened with), but a different shape and a key derived under its own label, so a
// client token can never pass as a staff token or the reverse.
const STAFF_KEY = crypto.createHmac('sha256', String(cfg.clientSessionSecret)).update('xpulse staff session v1').digest();
function signStaffToken(staffId, storedPassword = '', ttlMs = cfg.staffSessionTtlMs) {
  const expiresAt = Date.now() + ttlMs;
  const payload = `s1.${staffId}.${expiresAt}.${passwordStamp(storedPassword)}`;
  const sig = crypto.createHmac('sha256', STAFF_KEY).update(payload).digest('hex');
  return { token: `${payload}.${sig}`, expiresAt };
}
// { staffId, stamp } for a well-signed, unexpired staff token, else null.
function readStaffToken(token) {
  if (typeof token !== 'string' || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== 's1') return null;
  const [, staffId, exp, stamp, sig] = parts;
  if (!HEX.test(sig) || !HEX.test(stamp) || !/^[0-9a-f-]{36}$/i.test(staffId)) return null;
  const expected = crypto.createHmac('sha256', STAFF_KEY).update(`s1.${staffId}.${exp}.${stamp}`).digest('hex');
  const a = Buffer.from(sig, 'hex'), b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (!(Date.now() <= parseInt(exp, 10))) return null;
  return { staffId, stamp };
}

// v2.10.0: someone who signed in correctly but has not confirmed their email yet gets this instead of a
// session. It can only ask for the confirmation email again (or give the address to send it to), for 30
// minutes; it is signed with the staff key under its own label, so it never passes as a session token.
function signPending(staffId, ttlMs = 30 * 60 * 1000) {
  const payload = Buffer.from(JSON.stringify({ p: 'confirm', s: staffId, exp: Date.now() + ttlMs })).toString('base64url');
  return `${payload}.${crypto.createHmac('sha256', STAFF_KEY).update(`pending:${payload}`).digest('base64url')}`;
}
function readPending(ticket) {
  if (typeof ticket !== 'string' || !ticket.includes('.') || ticket.length > 400) return null;
  const [payload, sig] = ticket.split('.');
  const expected = crypto.createHmac('sha256', STAFF_KEY).update(`pending:${payload}`).digest('base64url');
  const a = Buffer.from(String(sig)), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const o = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return o.p === 'confirm' && Date.now() <= o.exp && /^[0-9a-f-]{36}$/i.test(o.s) ? o.s : null;
  } catch { return null; }
}

// v2.13.0: business owners' own accounts in Owner Assistant (0029). One owner can hold several businesses,
// so the token names the owner, not a business; each request is checked against the owner's businesses.
// Its own shape and key label, so neither a business's old token nor a staff token can pass as one.
const OWNER_KEY = crypto.createHmac('sha256', String(cfg.clientSessionSecret)).update('xpulse owner session v1').digest();
function signOwnerToken(ownerId, storedPassword = '', ttlMs = cfg.clientSessionTtlMs) {
  const expiresAt = Date.now() + ttlMs;
  const payload = `o1.${ownerId}.${expiresAt}.${passwordStamp(storedPassword)}`;
  const sig = crypto.createHmac('sha256', OWNER_KEY).update(payload).digest('hex');
  return { token: `${payload}.${sig}`, expiresAt };
}
// { ownerId, stamp } for a well-signed, unexpired owner token, else null.
function readOwnerToken(token) {
  if (typeof token !== 'string' || !token.startsWith('o1.')) return null;
  const parts = token.split('.');
  if (parts.length !== 5) return null;
  const [, ownerId, exp, stamp, sig] = parts;
  if (!HEX.test(sig) || !HEX.test(stamp) || !/^[0-9a-f-]{36}$/i.test(ownerId)) return null;
  const expected = crypto.createHmac('sha256', OWNER_KEY).update(`o1.${ownerId}.${exp}.${stamp}`).digest('hex');
  const a = Buffer.from(sig, 'hex'), b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (!(Date.now() <= parseInt(exp, 10))) return null;
  return { ownerId, stamp };
}
// An owner who signed in correctly but has not confirmed their email yet (like signPending for staff).
function signOwnerPending(ownerId, ttlMs = 30 * 60 * 1000) {
  const payload = Buffer.from(JSON.stringify({ p: 'owner-confirm', o: ownerId, exp: Date.now() + ttlMs })).toString('base64url');
  return `${payload}.${crypto.createHmac('sha256', OWNER_KEY).update(`pending:${payload}`).digest('base64url')}`;
}
function readOwnerPending(ticket) {
  if (typeof ticket !== 'string' || !ticket.includes('.') || ticket.length > 400) return null;
  const [payload, sig] = ticket.split('.');
  const expected = crypto.createHmac('sha256', OWNER_KEY).update(`pending:${payload}`).digest('base64url');
  const a = Buffer.from(String(sig)), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const o = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return o.p === 'owner-confirm' && Date.now() <= o.exp && /^[0-9a-f-]{36}$/i.test(o.o) ? o.o : null;
  } catch { return null; }
}

// One-time links (staff invites, password resets): a random secret travels in the link; only its
// SHA-256 is stored, so a copy of the database cannot be turned back into working links.
const newLinkSecret = () => crypto.randomBytes(32).toString('base64url');
const hashLinkSecret = (secret) => crypto.createHash('sha256').update(String(secret || '')).digest('hex');

// Short-lived signed state for OAuth (prevents CSRF and lets us carry the target client id)
function signState(obj) {
  const payload = Buffer.from(JSON.stringify({ ...obj, exp: Date.now() + 15 * 60 * 1000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', cfg.clientSessionSecret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function verifyState(state) {
  if (!state || !String(state).includes('.')) return null;
  const [payload, sig] = String(state).split('.');
  const expected = crypto.createHmac('sha256', cfg.clientSessionSecret).update(payload).digest('base64url');
  if (sig !== expected) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (Date.now() > obj.exp) return null;
    return obj;
  } catch { return null; }
}

// Short-lived signed ticket so a plain browser GET (new tab, no headers) can reach an admin route.
// Used by "Preview HTML" and PDF links, which cannot send x-admin-key.
// v2.7.2 (F-37): signed with a key derived from the admin key, not the client session secret. A leaked
// session secret no longer mints admin tickets, and changing the admin key voids every ticket.
const TICKET_KEY = crypto.createHmac('sha256', String(cfg.adminApiKey)).update('xpulse admin ticket v1').digest();
function signTicket(scope, ttlMs = 10 * 60 * 1000) {
  const payload = Buffer.from(JSON.stringify({ s: scope, exp: Date.now() + ttlMs })).toString('base64url');
  const sig = crypto.createHmac('sha256', TICKET_KEY).update(`t:${payload}`).digest('base64url');
  return `${payload}.${sig}`;
}
function verifyTicket(ticket, scope) {
  if (!ticket || !String(ticket).includes('.')) return false;
  const [payload, sig] = String(ticket).split('.');
  const expected = crypto.createHmac('sha256', TICKET_KEY).update(`t:${payload}`).digest('base64url');
  const a = Buffer.from(String(sig)), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Date.now() <= obj.exp && obj.s === scope;
  } catch { return false; }
}

module.exports = {
  encrypt, decrypt, readToken, tokenFormat,
  hashPassword, verifyPassword, passwordNeedsRehash,
  signClientToken, verifyClientToken, readClientToken, passwordStamp, signState, verifyState, signTicket, verifyTicket,
  signStaffToken, readStaffToken, newLinkSecret, hashLinkSecret, signPending, readPending,
  signOwnerToken, readOwnerToken, signOwnerPending, readOwnerPending
};
