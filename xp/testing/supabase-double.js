// An in-memory stand-in for the PostgREST client, covering exactly the surface sync.js uses.
//
// Why this exists: every change to sync.js is currently unverifiable without a live token, a live
// Meta account and a real Supabase project. That makes the riskiest file in the codebase the one
// nobody can test, so it only ever gets exercised in production at 00:10 UTC.
//
// Two things here are deliberately more than a stub:
//
//   * VIEWS ARE COMPUTED, not stored. sync.js decides which posts need a snapshot by reading
//     xp_v_posts_with_latest. A double that returned a canned array would agree with any bug in that
//     decision. Computing the view from the rows means the selection logic is genuinely tested.
//
//   * THE IMMUTABILITY TRIGGER IS EMULATED. In Postgres, fn_guard_final_snapshot() raises when a
//     finalized row is rewritten. sync.js is supposed to filter those rows out before writing, so
//     the guard should never fire — which makes it a free assertion. If it fires here, the
//     finalKeys() filter has a hole, and we learn that on a laptop instead of from a trigger error
//     in the nightly run.
const clone = (v) => (v === null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v)));

// Column defaults, copied from migrations_0001. These are NOT cosmetic.
//
// sync.js sets `is_story` explicitly when it inserts a post but leaves `is_deleted` to the column
// default. Without these, an inserted row carries `is_deleted: undefined`, the `.eq('is_deleted',
// false)` filter in syncPostSnapshots matches nothing, and the entire post-snapshot step returns
// early at `if (!due.length) return;` — writing zero rows and reporting OK. The first version of
// this file did exactly that: it "passed" a full FB replay while never once exercising the
// post-insights path, which is the largest table in the schema.
//
// A test double that silently skips a step is worse than no double at all, so any boolean flag a
// query filters on must default the way the schema does.
const DEFAULTS = {
  xp_clients: { is_active: true },
  xp_meta_posts: { is_story: false, is_deleted: false },
  xp_post_metric_snapshots: { is_final: false },
  xp_account_metric_snapshots: { is_final: false },
  xp_audience_snapshots: { is_final: false },
  xp_post_comments: { is_hidden: false, is_deleted: false },
  xp_metric_catalog: { is_active: true, is_verified: false },
  // 0022 (Stage E). The ads sync reads active accounts and closes open rows by these flags.
  xp_meta_ad_accounts: { is_active: true, client_id: null, last_synced_at: null },
  xp_ad_daily_snapshots: { is_final: false }
};

function withDefaults(table, row) {
  const d = DEFAULTS[table];
  if (!d) return row;
  for (const [col, val] of Object.entries(d)) if (row[col] === undefined) row[col] = val;
  return row;
}

// The one transition 0007 permits on a finalized row: null → value, once.
const PERMITTED_FINAL_TRANSITIONS = new Set(['followers_total_frozen', 'followers_estimate_method', 'followers_estimated_at']);
const GUARDED_TABLES = new Set(['xp_account_metric_snapshots', 'xp_post_metric_snapshots', 'xp_ad_daily_snapshots']);   // + fn_guard_final_ad_row (0022)

class DoubleError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

class QueryBuilder {
  constructor(store, table) {
    this.store = store; this.table = table;
    this.mode = 'select'; this.filters = []; this.orderBy = null;
    this._limit = null; this._single = false; this._required = false;
    this._returning = false; this.payload = null; this.opts = {};
  }

  select() { if (this.mode !== 'select') this._returning = true; return this; }
  insert(rows) { this.mode = 'insert'; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
  update(patch) { this.mode = 'update'; this.payload = patch; return this; }
  upsert(rows, opts = {}) { this.mode = 'upsert'; this.payload = Array.isArray(rows) ? rows : [rows]; this.opts = opts; return this; }
  delete() { this.mode = 'delete'; return this; }

  eq(c, v) { this.filters.push((r) => String(r[c]) === String(v)); return this; }
  neq(c, v) { this.filters.push((r) => String(r[c]) !== String(v)); return this; }
  gt(c, v) { this.filters.push((r) => r[c] > v); return this; }
  gte(c, v) { this.filters.push((r) => r[c] >= v); return this; }
  lt(c, v) { this.filters.push((r) => r[c] < v); return this; }
  lte(c, v) { this.filters.push((r) => r[c] <= v); return this; }
  in(c, vals) { const s = new Set(vals.map(String)); this.filters.push((r) => s.has(String(r[c]))); return this; }
  is(c, v) { this.filters.push((r) => (v === null ? r[c] === null || r[c] === undefined : r[c] === v)); return this; }
  not(c, op, v) { this.filters.push((r) => (op === 'is' && v === null ? r[c] !== null && r[c] !== undefined : String(r[c]) !== String(v))); return this; }
  order(c, o = {}) { this.orderBy = [c, o.ascending === false ? -1 : 1]; return this; }
  limit(n) { this._limit = n; return this; }
  single() { this._single = true; this._required = true; return this; }
  maybeSingle() { this._single = true; return this; }

  _match(rows) { return rows.filter((r) => this.filters.every((f) => f(r))); }

  _run() {
    const S = this.store;
    switch (this.mode) {
      case 'select': {
        let rows = this._match(S.read(this.table));
        if (this.orderBy) {
          const [c, dir] = this.orderBy;
          rows = [...rows].sort((a, b) => {
            const x = a[c], y = b[c];
            if (x === y) return 0;
            if (x === null || x === undefined) return 1;
            if (y === null || y === undefined) return -1;
            return (x > y ? 1 : -1) * dir;
          });
        }
        if (this._limit !== null) rows = rows.slice(0, this._limit);
        if (this._single) {
          if (!rows.length && this._required) throw new DoubleError(`no rows returned for ${this.table}`, 'PGRST116');
          return clone(rows[0] ?? null);
        }
        return clone(rows);
      }
      case 'insert': {
        const written = this.payload.map((r) => S.insert(this.table, r));
        S.stats.inserts += written.length;
        if (!this._returning) return null;
        return this._single ? clone(written[0] ?? null) : clone(written);
      }
      case 'update': {
        const rows = this._match(S.rows(this.table));
        for (const r of rows) S.applyUpdate(this.table, r, this.payload);
        S.stats.updates += rows.length;
        return this._returning ? clone(rows) : null;
      }
      case 'upsert': {
        const keyCols = String(this.opts.onConflict || 'id').split(',').map((s) => s.trim());
        for (const r of this.payload) S.upsert(this.table, r, keyCols, this.opts);
        S.stats.upserts += this.payload.length;
        return this._returning ? clone(this.payload) : null;
      }
      case 'delete': {
        const rows = this._match(S.rows(this.table));
        const keep = new Set(rows);
        S.tables.set(this.table, S.rows(this.table).filter((r) => !keep.has(r)));
        S.stats.deletes += rows.length;
        return null;
      }
      default: throw new DoubleError(`unsupported mode ${this.mode}`);
    }
  }

  // Thenable, so `await supabase.from(...)...` behaves like the real client: errors come back in
  // the envelope rather than as rejections, because q() is what turns them into throws.
  then(resolve) {
    try { return resolve({ data: this._run(), error: null }); }
    catch (e) { return resolve({ data: null, error: { message: e.message, code: e.code, details: null } }); }
  }
}

class Store {
  constructor() {
    this.tables = new Map();
    this.seq = 0;
    this.stats = { inserts: 0, updates: 0, upserts: 0, deletes: 0, guardHits: [] };
    this.strictGuard = true;
  }

  rows(table) {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return this.tables.get(table);
  }

  // Reads go through here so views can be synthesised on demand.
  read(table) {
    if (table === 'xp_v_post_latest') return this._vPostLatest();
    if (table === 'xp_v_posts_with_latest') return this._vPostsWithLatest();
    if (table === 'xp_v_account_daily') return this._vAccountDaily();
    return this.rows(table);
  }

  _vPostLatest() {
    const best = new Map();
    for (const s of this.rows('xp_post_metric_snapshots')) {
      const k = `${s.asset_id}|${s.meta_post_id}`;
      const cur = best.get(k);
      if (!cur || String(s.snapshot_date) > String(cur.snapshot_date)) best.set(k, s);
    }
    return [...best.values()];
  }

  _vPostsWithLatest() {
    const latest = new Map(this._vPostLatest().map((s) => [`${s.asset_id}|${s.meta_post_id}`, s]));
    return this.rows('xp_meta_posts').map((p) => {
      const l = latest.get(`${p.asset_id}|${p.meta_post_id}`) || {};
      return {
        ...p,
        latest_snapshot_date: l.snapshot_date ?? null,
        impressions: l.impressions ?? null, reach: l.reach ?? null, views: l.views ?? null,
        plays: l.plays ?? null, likes: l.likes ?? null, comments: l.comments ?? null,
        shares: l.shares ?? null, saves: l.saves ?? null,
        total_interactions: l.total_interactions ?? null, video_views: l.video_views ?? null,
        profile_visits: l.profile_visits ?? null, follows: l.follows ?? null
      };
    });
  }

  _vAccountDaily() {
    const byAsset = new Map();
    for (const r of this.rows('xp_account_metric_snapshots')) {
      if (!byAsset.has(r.asset_id)) byAsset.set(r.asset_id, []);
      byAsset.get(r.asset_id).push(r);
    }
    const out = [];
    for (const rows of byAsset.values()) {
      const sorted = [...rows].sort((a, b) => String(a.metric_date).localeCompare(String(b.metric_date)));
      sorted.forEach((r, i) => {
        const prev = sorted[i - 1];
        out.push({
          ...r,
          followers_total_is_observed: r.followers_total !== null && r.followers_total !== undefined,
          followers_gained_observed: prev && r.followers_total != null && prev.followers_total != null
            ? r.followers_total - prev.followers_total : null,
          prev_metric_date: prev ? prev.metric_date : null
        });
      });
    }
    return out;
  }

  insert(table, row) {
    const r = withDefaults(table, clone(row));
    if (r.id === undefined) r.id = `${table}_${++this.seq}`;
    this.rows(table).push(r);
    return r;
  }

  applyUpdate(table, row, patch) {
    this._guard(table, row, patch, 'update');
    Object.assign(row, clone(patch));
  }

  upsert(table, incoming, keyCols, opts) {
    const key = (r) => keyCols.map((c) => String(r[c])).join('|');
    const k = key(incoming);
    const existing = this.rows(table).find((r) => key(r) === k);
    if (!existing) return this.insert(table, incoming);   // defaults applied by insert()
    if (opts.ignoreDuplicates) return existing;
    this._guard(table, existing, incoming, 'upsert');
    Object.assign(existing, clone(incoming));
    return existing;
  }

  // Emulates fn_guard_final_snapshot(). A finalized row may change in exactly one way, once.
  _guard(table, existing, patch, how) {
    if (!GUARDED_TABLES.has(table) || existing.is_final !== true) return;
    const offending = Object.keys(patch).filter((col) => {
      if (PERMITTED_FINAL_TRANSITIONS.has(col)) {
        const was = existing[col];
        return !(was === null || was === undefined);   // null → value is allowed; value → other is not
      }
      const a = existing[col], b = patch[col];
      if (a === b) return false;
      return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
    });
    if (!offending.length) return;
    const msg = `${table}: ${how} would rewrite a finalized row (${keyish(existing)}); columns: ${offending.slice(0, 8).join(', ')}`;
    this.stats.guardHits.push(msg);
    if (this.strictGuard) throw new DoubleError(msg, 'P0001');
  }

  // A stable, comparable picture of everything written. `drop` removes columns that legitimately
  // differ between two identical runs (clocks, signed CDN URLs, Meta's own echoed timestamps).
  snapshot({ drop = {} } = {}) {
    const out = {};
    for (const [table, rows] of [...this.tables.entries()].sort()) {
      const skip = new Set(drop[table] || []);
      out[table] = rows
        .map((r) => Object.fromEntries(Object.entries(r).filter(([c]) => !skip.has(c)).sort(([a], [b]) => a.localeCompare(b))))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    return out;
  }

  counts() {
    return Object.fromEntries([...this.tables.entries()].map(([t, r]) => [t, r.length]).sort());
  }
}

const keyish = (r) => ['asset_id', 'metric_date', 'meta_post_id', 'snapshot_date']
  .filter((c) => r[c] !== undefined).map((c) => `${c}=${r[c]}`).join(' ');

// Drop-in replacement for the three exports of src/db.js.
function makeDb() {
  const store = new Store();
  const supabase = { from: (t) => new QueryBuilder(store, t) };

  async function q(promise, label = 'db') {
    const { data, error } = await promise;
    if (error) { const e = new Error(`[${label}] ${error.message}`); e.code = error.code; throw e; }
    return data;
  }

  async function upsertChunked(table, rows, onConflict, chunkSize = 500) {
    let written = 0;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const slice = rows.slice(i, i + chunkSize);
      await q(supabase.from(table).upsert(slice, { onConflict, ignoreDuplicates: false }), `upsert ${table}`);
      written += slice.length;
    }
    return written;
  }

  return { supabase, q, upsertChunked, store };
}

module.exports = { makeDb, Store, DoubleError };
