// Meta Graph API client.
//  - get/paginate with retry + throttle backoff driven by Meta's usage headers
//  - batch(): up to 50 sub-requests per HTTP call
//  - insightsResilient(): asks for a metric set; if Meta rejects any, retries one-by-one and reports
//    which metric names are dead, so a renamed metric never silently breaks a whole snapshot again.
const axios = require('axios');
const crypto = require('crypto');
const cfg = require('../config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const THROTTLE_CODES = new Set([4, 17, 32, 613, 80001, 80002, 80003, 80004, 80005, 80006, 80008]);
const METRIC_ERROR_RE = /metric|invalid parameter|not supported|does not exist|deprecated|unsupported/i;

class GraphError extends Error {
  constructor(msg, { code, subcode, type, status, fbtrace, path } = {}) {
    super(msg); this.name = 'GraphError';
    Object.assign(this, { code, subcode, type, status, fbtrace, path });
  }
  get isThrottle() { return THROTTLE_CODES.has(this.code) || this.status === 429; }
  get isAuth() { return this.code === 190 || this.code === 102 || this.code === 10 || (this.code === 200 && /permission/i.test(this.message)); }
  get isMetric() { return (this.code === 100 || this.code === 3001) && METRIC_ERROR_RE.test(this.message); }
  get isNotFound() { return this.code === 803 || this.code === 100 && /does not exist|cannot be loaded/i.test(this.message); }
}

class GraphClient {
  constructor({ token, version, delayMs, batchSize } = {}) {
    if (!token) throw new Error('GraphClient needs a token');
    this.token = token;
    this.version = version || cfg.meta.defaultApiVersion;
    this.base = `https://graph.facebook.com/${this.version}`;
    this.delayMs = delayMs ?? cfg.sync.requestDelayMs;
    this.batchSize = Math.min(50, batchSize || cfg.sync.batchSize || 50);
    this.calls = 0;
    this.backoffUntil = 0;
    this.proof = cfg.meta.appSecret ? crypto.createHmac('sha256', cfg.meta.appSecret).update(token).digest('hex') : null;
    this.http = axios.create({ timeout: 60000, validateStatus: () => true });
  }

  // ---------------------------------------------------------------- low level
  _auth(params = {}) { return { access_token: this.token, ...(this.proof ? { appsecret_proof: this.proof } : {}), ...params }; }

  _readUsage(headers) {
    let worst = 0;
    for (const h of ['x-app-usage', 'x-business-use-case-usage', 'x-ad-account-usage']) {
      const v = headers?.[h]; if (!v) continue;
      try {
        const j = JSON.parse(v);
        const items = Array.isArray(j) ? j : Object.values(j).flat ? Object.values(j).flat() : [j];
        for (const it of [j, ...items]) for (const k of ['call_count', 'total_cputime', 'total_time']) if (typeof it?.[k] === 'number') worst = Math.max(worst, it[k]);
      } catch { /* ignore */ }
    }
    if (worst >= 95) this.backoffUntil = Date.now() + 5 * 60 * 1000;
    else if (worst >= 80) this.backoffUntil = Date.now() + 60 * 1000;
    return worst;
  }

  async _request(method, path, { params = {}, data, attempt = 0 } = {}) {
    if (this.backoffUntil > Date.now()) await sleep(this.backoffUntil - Date.now());
    if (this.delayMs) await sleep(this.delayMs);
    const url = path.startsWith('http') ? path : `${this.base}/${path.replace(/^\//, '')}`;
    this.calls++;
    const res = await this.http.request({ method, url, params: method === 'GET' ? this._auth(params) : this._auth(), data });
    this._readUsage(res.headers);
    const body = res.data;
    if (res.status < 400 && !body?.error) return body;
    const e = body?.error || {};
    const err = new GraphError(e.message || `HTTP ${res.status}`, { code: e.code, subcode: e.error_subcode, type: e.type, status: res.status, fbtrace: e.fbtrace_id, path });
    if ((err.isThrottle || res.status >= 500) && attempt < 5) {
      const wait = Math.min(120000, 2000 * 2 ** attempt) + Math.random() * 1000;
      await sleep(wait);
      return this._request(method, path, { params, data, attempt: attempt + 1 });
    }
    throw err;
  }

  get(path, params = {}) { return this._request('GET', path, { params }); }
  post(path, data = {}, params = {}) { return this._request('POST', path, { params, data: { ...this._auth(), ...data } }); }

  // Follow paging.next until done (or limit)
  async paginate(path, params = {}, { maxItems = Infinity, maxPages = 200 } = {}) {
    let out = [], page = 0, res = await this.get(path, { limit: 100, ...params });
    while (res) {
      out = out.concat(res.data || []);
      if (out.length >= maxItems || ++page >= maxPages || !res.paging?.next) break;
      res = await this._request('GET', res.paging.next, { params: {} });
    }
    return out.slice(0, maxItems);
  }

  // ---------------------------------------------------------------- batch
  // requests: [{ key, method='GET', relative_url }]  →  Map(key -> { ok, body, error })
  async batch(requests) {
    const results = new Map();
    for (let i = 0; i < requests.length; i += this.batchSize) {
      const slice = requests.slice(i, i + this.batchSize);
      const payload = slice.map((r) => ({ method: r.method || 'GET', relative_url: r.relative_url.replace(/^\//, '') }));
      let resp;
      try { resp = await this.post('', { batch: JSON.stringify(payload), include_headers: false }); }
      catch (err) { slice.forEach((r) => results.set(r.key, { ok: false, error: err })); continue; }
      slice.forEach((r, idx) => {
        const item = resp?.[idx];
        if (!item) return results.set(r.key, { ok: false, error: new GraphError('empty batch item') });
        let body = null; try { body = item.body ? JSON.parse(item.body) : null; } catch { body = item.body; }
        if (item.code >= 400 || body?.error) {
          const e = body?.error || {};
          results.set(r.key, { ok: false, error: new GraphError(e.message || `HTTP ${item.code}`, { code: e.code, subcode: e.error_subcode, status: item.code, path: r.relative_url }) });
        } else results.set(r.key, { ok: true, body });
      });
      // a batch of 50 counts as many calls for usage purposes; honour backoff between chunks
      if (this.backoffUntil > Date.now()) await sleep(this.backoffUntil - Date.now());
    }
    return results;
  }

  // ---------------------------------------------------------------- insights
  // Returns { data: [insight objects], live: [metric], dead: [{metric, error}] }
  async insightsResilient(objectId, metrics, params = {}) {
    const path = `${objectId}/insights`;
    const want = [...new Set(metrics)].filter(Boolean);
    if (!want.length) return { data: [], live: [], dead: [] };
    try {
      const r = await this.get(path, { ...params, metric: want.join(',') });
      return { data: r.data || [], live: want, dead: [] };
    } catch (err) {
      if (!(err instanceof GraphError) || !err.isMetric) throw err;
    }
    const data = [], live = [], dead = [];
    for (const m of want) {
      try { const r = await this.get(path, { ...params, metric: m }); data.push(...(r.data || [])); live.push(m); }
      catch (err) { if (err instanceof GraphError && err.isMetric) dead.push({ metric: m, error: err.message }); else throw err; }
    }
    return { data, live, dead };
  }
}

// Turn an insights `data` array into { metric_name -> value } with sensible collapsing:
//  - lifetime/total_value: value or total_value.value
//  - time series (period=day): array of {end_time, value}  (left as-is under `series`)
function insightsToMap(data) {
  const flat = {}, series = {};
  for (const it of data || []) {
    if (it.total_value !== undefined) flat[it.name] = it.total_value?.value ?? it.total_value;
    else if (Array.isArray(it.values)) {
      if (it.values.length === 1 && it.period !== 'day') flat[it.name] = it.values[0]?.value;
      else series[it.name] = it.values;
      if (it.values.length === 1 && it.period === 'day') flat[it.name] = it.values[0]?.value;   // single-day query
    } else if (it.value !== undefined) flat[it.name] = it.value;
  }
  return { flat, series };
}

module.exports = { GraphClient, GraphError, insightsToMap, sleep };
