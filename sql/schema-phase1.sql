-- =====================================================================
-- EDGELEAD :: PHASE 1 MIGRATION
-- Job checkpoints (resume) + Apify usage ledger (real spend tracking)
--
-- Safe to run repeatedly. Creates only what is missing, drops nothing.
-- Run in Supabase Dashboard -> SQL Editor -> New Query -> Run
-- AFTER schema.sql, fb-schema.sql and fb-page-schema.sql.
-- =====================================================================

create extension if not exists "pgcrypto";


-- ---------------------------------------------------------------------
-- 1. JOB CHECKPOINTS
--
--    completed_units : which scrape units are finished AND paid for
--    partials        : the analysis each finished unit produced
--
--    The scraped rows already live in posts / fb_posts, but an audit also
--    needs profile-level numbers that cannot be rebuilt from post rows
--    alone. Persisting the computed audit here is what makes resume free:
--    a resumed job re-reads it instead of re-scraping, so no unit is ever
--    billed twice.
-- ---------------------------------------------------------------------
alter table public.jobs add column if not exists completed_units text[]  default '{}';
alter table public.jobs add column if not exists partials        jsonb   default '{}'::jsonb;

-- Statuses now in use:
--   queued | running | done | failed
--   paused_no_credit  -> every key is dry, checkpoint intact, resumable
--   interrupted       -> server restarted mid-run, checkpoint intact, resumable
create index if not exists idx_jobs_resumable
    on public.jobs (user_id, status)
    where status in ('paused_no_credit', 'interrupted');

-- The boot sweep looks for stale rows by heartbeat.
create index if not exists idx_jobs_active_updated
    on public.jobs (status, updated_at)
    where status in ('queued', 'running');


-- ---------------------------------------------------------------------
-- 2. APIFY USAGE LEDGER
--
--    One row per actor run, carrying the real usageTotalUsd the platform
--    reported. token_hash is a SHA-256 prefix of the token, so spend can
--    be attributed to the engine primary and the env fallback too — keys
--    that have no row in apify_keys — without storing the secret twice.
-- ---------------------------------------------------------------------
create table if not exists public.apify_usage_events (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid references auth.users(id) on delete set null,
    key_id          uuid references public.apify_keys(id) on delete set null,
    token_hash      text not null,
    apify_username  text,
    engine          text,
    job_id          uuid,
    actor_id        text,
    run_id          text,
    usage_usd       numeric not null default 0,
    compute_units   numeric,
    items           int,
    cycle_month     text not null,          -- 'YYYY-MM'
    created_at      timestamptz default now()
);

-- The hot path: "how much has this key spent this cycle?"
create index if not exists idx_usage_cycle
    on public.apify_usage_events (token_hash, cycle_month);

create index if not exists idx_usage_user
    on public.apify_usage_events (user_id, created_at desc);

create index if not exists idx_usage_job
    on public.apify_usage_events (job_id);


-- ---------------------------------------------------------------------
-- 3. RLS
--    Same pattern as everything else: enabled with no policies, because
--    the backend uses the service_role key and bypasses RLS. This closes
--    the table to the anon key that is published in the HTML.
-- ---------------------------------------------------------------------
alter table public.apify_usage_events enable row level security;


-- ---------------------------------------------------------------------
-- 4. CONVENIENCE VIEW  (optional, for eyeballing spend in the SQL editor)
-- ---------------------------------------------------------------------
create or replace view public.apify_spend_by_cycle as
select
    cycle_month,
    coalesce(apify_username, left(token_hash, 8)) as apify_account,
    engine,
    count(*)                as runs,
    sum(items)              as items,
    round(sum(usage_usd), 4) as usd
from public.apify_usage_events
group by 1, 2, 3
order by 1 desc, 6 desc;


-- ---------------------------------------------------------------------
-- 5. ONE-TIME CLEANUP
--    Any job left 'running' from before this migration is orphaned by
--    definition — the process that owned it is long gone.
-- ---------------------------------------------------------------------
update public.jobs
set    status = 'interrupted',
       error  = 'Orphaned before checkpointing existed. Start a new run.'
where  status in ('queued', 'running')
  and  updated_at < now() - interval '1 hour';


-- ---------------------------------------------------------------------
-- DONE
-- ---------------------------------------------------------------------
