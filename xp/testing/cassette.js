// Records and replays Meta's HTTP responses at a single seam: GraphClient.prototype._request.
//
// That seam is chosen on purpose. get(), post(), paginate(), batch() and insightsResilient() all
// funnel into _request, so patching it leaves every one of them running as REAL CODE — including
// the metric-by-metric fallback in insightsResilient and the 50-request chunking in batch. Only
// the network is fake. A double that stubbed insightsResilient() instead would agree with any bug
// in the fallback logic, which is precisely the logic that broke when v19.0 metric names died.
//
// Secrets never reach a fixture file. Three places leak a token if you are not careful:
//   1. POST bodies — post() merges _auth() into `data` before _request sees it.
//   2. paging.next — Meta returns the FULL next-page URL with access_token in the query string,
//      and paginate() feeds that straight back into _request as the path.
//   3. Anything echoed inside a response body.
// All three are scrubbed on the way in, and the cassette key is computed from the SCRUBBED form
// so that a replay keyed off a scrubbed paging.next still matches what was recorded.
const crypto = require('crypto');

const SECRET_PARAMS = new Set(['access_token', 'appsecret_proof', 'client_secret', 'input_token']);
const TOKEN_IN_URL = /([?&](?:access_token|appsecret_proof|client_secret|input_token)=)[^&#\s"']+/gi;

function scrubString(s) {
  return typeof s === 'string' && s.includes('=') ? s.replace(TOKEN_IN_URL, '$1REDACTED') : s;
}

function scrubDeep(v) {
  if (typeof v === 'string') return scrubString(v);
  if (Array.isArray(v)) return v.map(scrubDeep);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = SECRET_PARAMS.has(k) ? 'REDACTED' : scrubDeep(val);
    return o;
  }
  return v;
}

function scrubParams(params = {}) {
  const o = {};
  for (const [k, v] of Object.entries(params)) { if (!SECRET_PARAMS.has(k)) o[k] = scrubDeep(v); }
  return o;
}

// A stable identity for a request. Absolute URLs (paging.next) are split so the query string is
// normalised the same way relative paths are; otherwise page 2 would key differently on replay.
function keyFor(method, path, params = {}, data) {
  let p = path, extra = {};
  if (/^https?:\/\//i.test(path)) {
    const u = new URL(path);
    p = u.pathname.replace(/^\/v\d+(\.\d+)?\//, '').replace(/^\//, '');
    for (const [k, v] of u.searchParams.entries()) if (!SECRET_PARAMS.has(k)) extra[k] = v;
  } else {
    p = String(path).replace(/^\//, '');
  }
  const merged = { ...extra, ...scrubParams(params) };
  const qs = Object.keys(merged).sort().map((k) => `${k}=${merged[k]}`).join('&');

  // A batch POST is identified by its payload, not its (empty) path.
  let body = '';
  if (data) {
    const clean = scrubParams(data);
    if (Object.keys(clean).length) body = crypto.createHash('sha1').update(JSON.stringify(clean, Object.keys(clean).sort())).digest('hex').slice(0, 12);
  }
  return `${method} ${p}${qs ? `?${qs}` : ''}${body ? `#${body}` : ''}`;
}

class Cassette {
  constructor(data = {}) {
    this.meta = data.meta || {};
    this.seed = data.seed || {};
    this.expected = data.expected || null;
    this.interactions = data.interactions || [];
    this._index = new Map();
    this.hits = new Set();
    this.misses = [];
    for (const it of this.interactions) if (!this._index.has(it.key)) this._index.set(it.key, it);
  }

  static from(json) { return new Cassette(typeof json === 'string' ? JSON.parse(json) : json); }

  toJSON() {
    return { meta: this.meta, seed: this.seed, expected: this.expected, interactions: this.interactions };
  }

  add(method, path, params, data, { body, error }) {
    const key = keyFor(method, path, params, data);
    if (this._index.has(key)) return;                       // first response wins; identical repeats add nothing
    const it = { key, method, path: scrubString(path), params: scrubParams(params) };
    if (error) it.error = { message: scrubString(error.message), code: error.code, subcode: error.subcode, status: error.status };
    else it.body = scrubDeep(body);
    this.interactions.push(it);
    this._index.set(key, it);
  }

  play(method, path, params, data) {
    const key = keyFor(method, path, params, data);
    const it = this._index.get(key);
    if (!it) { this.misses.push(key); return null; }
    this.hits.add(key);
    return it;
  }

  get unused() { return this.interactions.filter((i) => !this.hits.has(i.key)).map((i) => i.key); }
}

// Replaces the transport. Returns a restore() that puts the original method back, so a process can
// record one asset and replay another without leaking state between them.
function install(GraphClient, GraphError, { mode, cassette }) {
  const original = GraphClient.prototype._request;

  if (mode === 'record') {
    GraphClient.prototype._request = async function patched(method, path, opts = {}) {
      try {
        const body = await original.call(this, method, path, opts);
        cassette.add(method, path, opts.params, opts.data, { body });
        return body;
      } catch (err) {
        // Errors are part of the recording: the metric-deprecation fallback and the token-expiry
        // path only exist because Meta returns errors, and a cassette without them cannot
        // exercise either.
        cassette.add(method, path, opts.params, opts.data, { error: err });
        throw err;
      }
    };
  } else {
    GraphClient.prototype._request = async function patched(method, path, opts = {}) {
      this.calls++;
      const it = cassette.play(method, path, opts.params, opts.data);
      if (!it) {
        const e = new Error(
          `cassette miss — no recorded response for:\n    ${keyFor(method, path, opts.params, opts.data)}\n` +
          `  The code asked Meta something the recording does not cover. Either re-record, or this ` +
          `is a new request your change introduced (which is worth looking at on its own).`);
        e.isCassetteMiss = true;
        throw e;
      }
      if (it.error) {
        throw new GraphError(it.error.message, { code: it.error.code, subcode: it.error.subcode, status: it.error.status, path });
      }
      return JSON.parse(JSON.stringify(it.body));
    };
  }

  return () => { GraphClient.prototype._request = original; };
}

module.exports = { Cassette, install, keyFor, scrubDeep, scrubParams };
