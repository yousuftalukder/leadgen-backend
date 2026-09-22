// D-1 replay harness. Makes sync.js verifiable with no tokens and no network.
//
//   node scripts/replay.js record <clientId> <assetId> [--full] [--out=fixtures/name.json]
//   node scripts/replay.js replay <fixture.json> [--twice] [--finalize] [--lag=2] [--verbose]
//   node scripts/replay.js list [dir]
//
// RECORD runs one real sync against Meta, tees every HTTP response into a cassette, and writes the
// resulting database state alongside it as the expected result. It is READ-ONLY against Supabase:
// the client and asset rows are read from the real database to seed an in-memory double, and every
// write lands in the double, not in your tables.
//
// REPLAY re-runs the same sync with the network replaced by the cassette. Everything above the
// transport — batching, pagination, the metric-deprecation fallback, the finalized-row filter,
// the anchor-day calculation — is the real code. If a change to sync.js alters what gets written,
// the diff says so, by table and column, in about a second.
//
// Two flags exercise the properties that are otherwise only observable in production:
//   --twice     runs the sync twice against the same double and compares. This is idempotency.js
//               without a database: the second run must not change a single stored value.
//   --finalize  marks closed days final between the two runs, the way fn_finalize_snapshots()
//               does at 00:10 UTC, and lets the emulated immutability trigger judge the second
//               run. A re-sync that tries to rewrite a closed day fails here instead of in the
//               nightly cron. This is the v1 bug that migration 0005 had to repair.
const fs = require('fs');
const path = require('path');
const { makeDb } = require('../testing/supabase-double');
const { Cassette, install } = require('../testing/cassette');

// Columns that legitimately differ between two identical runs: clocks, Meta's own echoed
// timestamps, and signed CDN links whose _nc_ohc / oh / oe parameters rotate on every fetch.
// Same list idempotency.js uses, for the same reasons.
const DROP = {
  xp_meta_posts: ['id', 'first_seen_at', 'last_seen_at', 'raw', 'media_url', 'thumbnail_url'],
  xp_post_comments: ['id', 'first_seen_at', 'last_seen_at', 'raw', 'like_count'],
  xp_account_metric_snapshots: ['id', 'collected_at', 'raw', 'followers_observed_at', 'followers_estimated_at'],
  xp_post_metric_snapshots: ['id', 'collected_at', 'raw'],
  xp_audience_snapshots: ['id', 'collected_at', 'raw'],
  xp_sync_runs: ['id', 'started_at', 'finished_at', 'api_calls', 'errors', 'status'],
  xp_meta_assets: ['last_synced_at', 'first_synced_at', 'last_full_backfill_at', 'profile', 'updated_at'],
  xp_clients: ['last_synced_at', 'updated_at'],
  xp_metric_catalog: ['id', 'last_verified_at']
};

const SEED_TABLES = ['xp_clients', 'xp_meta_assets', 'xp_system_config'];

const arg = (name, dflt = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};
const flag = (name) => process.argv.includes(`--${name}`);
const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => console.log(`  ❌ ${m}`);
const info = (m) => console.log(`  ${m}`);

// Swap a module's exports before anything requires it. require.resolve does not execute the file,
// so in replay mode src/db.js never runs and no Supabase connection is ever opened.
function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, children: [], paths: [], exports };
  return resolved;
}

function loadSyncWith(db, { token = 'REPLAY_TOKEN' } = {}) {
  stub('../db', { supabase: db.supabase, q: db.q, upsertChunked: db.upsertChunked });
  // Token decryption has nothing to do with ingestion correctness and would drag AES + a live
  // ENCRYPTION_KEY into every test run.
  stub('../meta/discovery', {
    tokenForAsset: async () => token,
    upgradeToPageToken: async () => null,
    resolveAssetToken: async () => ({ token, source: 'replay' })
  });
  const graph = require('../meta/graph');
  const sync = require('../ingest/sync');
  return { sync, graph };
}

// What fn_finalize_snapshots() does, in JS: close every day that is fully elapsed plus the lag.
function applyFinalizeLag(store, lagDays) {
  const cutoff = new Date(Date.now() - lagDays * 86400000).toISOString().slice(0, 10);
  let n = 0;
  for (const [table, dateCol] of [['xp_account_metric_snapshots', 'metric_date'], ['xp_post_metric_snapshots', 'snapshot_date']]) {
    for (const r of store.rows(table)) {
      if (!r.is_final && String(r[dateCol]) <= cutoff) { r.is_final = true; n++; }
    }
  }
  return { cutoff, rows: n };
}

// xp_sync_runs is an append-only log: a second sync SHOULD add a row. Comparing it would report a
// correct behaviour as a violation, so it is excluded from the idempotency comparison the same way
// idempotency.js excludes it.
// xp_account_metric_observations is the same shape of thing (0010): every run appends a reading, on
// purpose. Comparing it would report the evidence log working as a violation.
const NOT_STATE = new Set(['xp_sync_runs', 'xp_account_metric_observations']);

function diff(expected, actual, { ignore = new Set() } = {}) {
  const out = [];
  const tables = [...new Set([...Object.keys(expected || {}), ...Object.keys(actual || {})])]
    .filter((t) => !ignore.has(t)).sort();
  for (const t of tables) {
    const a = expected?.[t] || [], b = actual?.[t] || [];
    if (a.length !== b.length) { out.push({ table: t, kind: 'count', detail: `expected ${a.length} rows, got ${b.length}` }); continue; }
    for (let i = 0; i < a.length; i++) {
      const x = a[i], y = b[i];
      if (JSON.stringify(x) === JSON.stringify(y)) continue;
      const cols = [...new Set([...Object.keys(x), ...Object.keys(y)])]
        .filter((c) => JSON.stringify(x[c] ?? null) !== JSON.stringify(y[c] ?? null));
      out.push({ table: t, kind: 'row', detail: cols.map((c) => `${c}: ${JSON.stringify(x[c] ?? null)} → ${JSON.stringify(y[c] ?? null)}`).join(' · ') });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------- record
async function doRecord() {
  const clientId = process.argv[3], assetId = process.argv[4];
  if (!clientId || !assetId) throw new Error('usage: node scripts/replay.js record <clientId> <assetId>');

  // Load the real client FIRST, then swap it out. Seeding reads production; nothing writes to it.
  const real = require('../db');
  const client = await real.q(real.supabase.from('xp_clients').select('*').eq('id', clientId).single(), 'client');
  const asset = await real.q(real.supabase.from('xp_meta_assets').select('*').eq('id', assetId).single(), 'asset');
  const sysconf = await real.q(real.supabase.from('xp_system_config').select('*').eq('id', 1).maybeSingle(), 'xp_system_config').catch(() => null);
  if (asset.client_id !== client.id) throw new Error('that asset does not belong to that client');

  console.log(`\nRecording ${asset.platform} · ${asset.name} (${client.client_name})`);
  console.log('  Supabase is read-only for this run; all writes land in the in-memory double.');

  const db = makeDb();
  const seed = { xp_clients: [client], xp_meta_assets: [asset], xp_system_config: sysconf ? [sysconf] : [] };
  for (const t of SEED_TABLES) for (const r of seed[t] || []) db.store.insert(t, r);

  const { tokenForAsset } = require('../meta/discovery');
  const token = await tokenForAsset(asset);            // real token, used live, never written down
  const { sync, graph } = loadSyncWith(db, { token });

  const cassette = new Cassette({ meta: {
    recorded_at: new Date().toISOString(),
    client: client.client_name, platform: asset.platform, asset_name: asset.name,
    full_backfill: flag('full')
  } });
  const restore = install(graph.GraphClient, graph.GraphError, { mode: 'record', cassette });

  const settings = { version: sysconf?.meta_api_version || 'v26.0', batchSize: sysconf?.batch_size || 50,
                     delayMs: sysconf?.request_delay_ms ?? 150, accountBackfillDays: sysconf?.account_backfill_days || 90,
                     demographicsEveryDays: sysconf?.demographics_every_days || 7 };
  let result;
  try {
    result = await sync.syncAsset(client, asset, { runType: 'MANUAL', triggeredBy: 'replay', fullBackfill: flag('full') }, settings);
  } finally { restore(); }

  cassette.seed = seed;
  cassette.expected = db.store.snapshot({ drop: DROP });
  cassette.meta.result = { status: result.status, posts_seen: result.posts_seen, snapshots_written: result.snapshots_written, errors: result.errors.length };

  const outPath = path.resolve(arg('out', `fixtures/${asset.platform.toLowerCase()}-${String(asset.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}.json`));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(cassette.toJSON(), null, 2), 'utf8');

  console.log(`\n  run status ${result.status} · ${result.posts_seen} posts · ${result.snapshots_written} snapshots · ${result.errors.length} errors`);
  console.log(`  ${cassette.interactions.length} HTTP interactions recorded`);
  info(`rows written: ${JSON.stringify(db.store.counts())}`);

  // A fixture that still contains a token is a fixture you cannot commit.
  const text = fs.readFileSync(outPath, 'utf8');
  const leaks = (text.match(/EAA[A-Za-z0-9]{20,}/g) || []).length;
  if (leaks) bad(`${leaks} token-shaped string(s) survived scrubbing — DO NOT COMMIT ${outPath}`);
  else ok('no token-shaped strings in the fixture — safe to commit');

  console.log(`\n✅ Wrote ${outPath}`);
  console.log(`   Verify it replays: node scripts/replay.js replay ${path.relative(process.cwd(), outPath)} --twice --finalize`);
}

// ---------------------------------------------------------------------------- replay
async function doReplay() {
  const fixturePath = path.resolve(process.argv[3] || '');
  if (!fs.existsSync(fixturePath)) throw new Error(`fixture not found: ${fixturePath}`);
  const cassette = Cassette.from(fs.readFileSync(fixturePath, 'utf8'));
  const verbose = flag('verbose');
  const lag = parseInt(arg('lag', '2'), 10);

  const client = cassette.seed.xp_clients?.[0];
  const asset = cassette.seed.xp_meta_assets?.[0];
  const sysconf = cassette.seed.xp_system_config?.[0] || null;
  if (!client || !asset) throw new Error('fixture has no seed rows — re-record it');

  console.log(`\nReplaying ${asset.platform} · ${asset.name} (${client.client_name})`);
  console.log(`  recorded ${cassette.meta.recorded_at} · ${cassette.interactions.length} interactions · offline`);

  const db = makeDb();
  for (const t of SEED_TABLES) for (const r of cassette.seed[t] || []) db.store.insert(t, r);

  const { sync, graph } = loadSyncWith(db);
  const restore = install(graph.GraphClient, graph.GraphError, { mode: 'replay', cassette });

  const settings = { version: sysconf?.meta_api_version || 'v26.0', batchSize: sysconf?.batch_size || 50,
                     delayMs: 0, accountBackfillDays: sysconf?.account_backfill_days || 90,
                     demographicsEveryDays: sysconf?.demographics_every_days || 7 };
  const opts = { runType: 'MANUAL', triggeredBy: 'replay', fullBackfill: !!cassette.meta.full_backfill };

  let failures = 0;
  try {
    console.log('\n1. First run');
    const r1 = await sync.syncAsset(client, asset, opts, settings);
    info(`status ${r1.status} · ${r1.posts_seen} posts · ${r1.snapshots_written} snapshots · ${r1.errors.length} errors`);
    for (const e of r1.errors.slice(0, 5)) info(`   ! ${e.step}: ${String(e.message).slice(0, 110)}`);
    if (cassette.misses.length) {
      bad(`${cassette.misses.length} cassette miss(es) — the code asked for something not recorded`);
      for (const m of cassette.misses.slice(0, 6)) info(`     ${m}`);
      failures++;
    } else ok('every request the code made was covered by the recording');

    const after1 = db.store.snapshot({ drop: DROP });
    info(`rows: ${JSON.stringify(db.store.counts())}`);

    // 2. Does it still write what it wrote when the fixture was recorded?
    if (cassette.expected) {
      console.log('\n2. Against the recorded result');
      const d = diff(cassette.expected, after1);
      if (!d.length) ok('identical to the state captured at record time');
      else {
        bad(`${d.length} difference(s) from the recorded state`);
        failures++;
        for (const x of d.slice(0, verbose ? 100 : 12)) info(`     ${x.table} [${x.kind}] ${x.detail}`);
        if (d.length > 12 && !verbose) info(`     … ${d.length - 12} more (--verbose)`);
      }
    }

    // 3. Idempotency, offline.
    if (flag('twice')) {
      console.log('\n3. Second run — nothing may change');
      let finalized = null;
      if (flag('finalize')) {
        finalized = applyFinalizeLag(db.store, lag);
        info(`marked ${finalized.rows} row(s) final on or before ${finalized.cutoff} (${lag}-day lag), as the nightly finalize does`);
      }
      const before = db.store.snapshot({ drop: DROP });
      cassette.hits.clear();
      const r2 = await sync.syncAsset(client, asset, opts, settings);
      info(`status ${r2.status} · ${r2.snapshots_written} snapshot(s) written` +
           (flag('finalize') ? ' — these must all be OPEN days; closed days are filtered out before the write' : ''));

      if (db.store.stats.guardHits.length) {
        bad(`the immutability guard fired ${db.store.stats.guardHits.length} time(s) — a re-sync tried to rewrite a closed day`);
        for (const h of db.store.stats.guardHits.slice(0, 5)) info(`     ${h}`);
        failures++;
      } else if (flag('finalize')) {
        ok('no finalized row was touched — the finalized-row filter holds');
      }

      const d2 = diff(before, db.store.snapshot({ drop: DROP }), { ignore: NOT_STATE });
      if (!d2.length) ok('IDEMPOTENT — the second run changed nothing');
      else {
        bad(`${d2.length} value(s) changed on the second run`);
        failures++;
        for (const x of d2.slice(0, verbose ? 100 : 12)) info(`     ${x.table} [${x.kind}] ${x.detail}`);
      }
    }

    const unused = cassette.unused;
    if (unused.length && verbose) {
      console.log(`\n  ${unused.length} recorded interaction(s) went unused this run:`);
      for (const u of unused.slice(0, 20)) info(`     ${u}`);
    }
  } finally { restore(); }

  console.log(`\n${failures ? `❌ ${failures} check(s) failed.` : '✅ All checks passed. sync.js behaves exactly as recorded, with no network.'}`);
  process.exit(failures ? 2 : 0);
}

// ---------------------------------------------------------------------------- list
function doList() {
  const dir = path.resolve(process.argv[3] || 'fixtures');
  if (!fs.existsSync(dir)) { console.log(`No fixtures directory at ${dir}. Record one first.`); return; }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (!files.length) { console.log(`No fixtures in ${dir}.`); return; }
  console.log(`\nFixtures in ${dir}\n`);
  for (const f of files) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const m = c.meta || {};
      console.log(`  ${f}`);
      console.log(`     ${m.platform || '?'} · ${m.asset_name || '?'} · ${m.client || '?'} · recorded ${String(m.recorded_at || '').slice(0, 10)}`);
      console.log(`     ${(c.interactions || []).length} interactions${m.result ? ` · ${m.result.snapshots_written} snapshots at record time` : ''}${m.full_backfill ? ' · full backfill' : ''}`);
    } catch { console.log(`  ${f}  (unreadable)`); }
  }
}

(async () => {
  const cmd = process.argv[2];
  if (cmd === 'record') return doRecord();
  if (cmd === 'replay') return doReplay();
  if (cmd === 'list') return doList();
  console.log(`
D-1 replay harness — verify sync.js with no tokens and no network.

  node scripts/replay.js record <clientId> <assetId> [--full] [--out=path.json]
  node scripts/replay.js replay <fixture.json> [--twice] [--finalize] [--lag=2] [--verbose]
  node scripts/replay.js list [dir]

Record once, against a live asset. Replay for ever, on every change to sync.js.
`);
  process.exit(1);
})().catch((e) => { console.error(`\nreplay.js: ${e.message}`); process.exit(1); });
