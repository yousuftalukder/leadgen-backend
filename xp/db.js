const { createClient } = require('@supabase/supabase-js');
const cfg = require('./config');

const supabase = createClient(cfg.supabaseUrl, cfg.supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

// Throw on Supabase errors so callers don't silently continue with null data.
async function q(promise, label = 'db') {
  const { data, error } = await promise;
  if (error) {
    const e = new Error(`[${label}] ${error.message}`);
    e.code = error.code;
    e.details = error.details;
    throw e;
  }
  return data;
}

// Upsert in chunks (PostgREST payload limits) with onConflict.
async function upsertChunked(table, rows, onConflict, chunk = 500) {
  let written = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    await q(supabase.from(table).upsert(slice, { onConflict, ignoreDuplicates: false }), `upsert ${table}`);
    written += slice.length;
  }
  return written;
}

module.exports = { supabase, q, upsertChunked };
