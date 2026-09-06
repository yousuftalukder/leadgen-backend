-- =====================================================================
-- EDGELEAD — PHASE 3 MIGRATION
--
-- Run this in the Supabase SQL editor BEFORE deploying server.js.
-- Safe to run more than once. Drops nothing.
--
-- What it does:
--   1. Per-key cycle credit, so a customer on a paid Apify plan is no
--      longer capped at the free-tier default.
--   2. Budget reservations, so two runs on the same key cannot both pass
--      the affordability gate and discover the overspend afterwards.
--   3. Job cancellation, so a run can be stopped at the next unit
--      boundary instead of burning the rest of the estimate.
--   4. Two RPCs that move hot-path work into Postgres: cycle spend is
--      summed in the database, and checkpoint appends are atomic.
--   5. The base tables schema.sql assumed but never created, so a fresh
--      database can be built from these files alone.
--
-- The server degrades rather than breaks if this has not run yet: it
-- falls back to client-side summing, skips reservations, and logs why.
-- Deploy order still matters for correctness, not for uptime.
-- =====================================================================

create extension if not exists "pgcrypto";


-- ---------------------------------------------------------------------
-- 0. BASE TABLES
--
--    schema.sql section 8 does `alter table public.leads` and reads from
--    public.campaign_leads, but nothing in the migration set ever created
--    them — they only existed because the original single-tenant build
--    made them by hand. That meant schema.sql could not build a working
--    database from scratch, which blocked a staging copy and any local
--    test database. Created here, guarded, so nothing is touched on the
--    live instance where they already exist.
-- ---------------------------------------------------------------------
create table if not exists public.leads (
    id              uuid primary key default gen_random_uuid(),
    owner_user_id   uuid references auth.users(id) on delete cascade,
    username        text not null,
    full_name       text,
    profile_url     text,
    followers       bigint default 0,
    email           text,
    phone           text,
    bio             text,
    website         text,
    category        text,
    is_business     boolean,
    is_verified     boolean,
    city            text,
    address         text,
    posts_count     int,
    following_count int,
    raw             jsonb,
    created_at      timestamptz default now()
);

create table if not exists public.campaigns (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid references auth.users(id) on delete cascade,
    name         text,
    keyword      text,
    location     text,
    platform     text default 'instagram',
    lead_count   int default 0,
    created_at   timestamptz default now()
);

create table if not exists public.campaign_leads (
    id          uuid primary key default gen_random_uuid(),
    campaign_id uuid references public.campaigns(id) on delete cascade,
    lead_id     uuid references public.leads(id) on delete cascade,
    user_id     uuid references auth.users(id) on delete cascade,
    created_at  timestamptz default now()
);

create index if not exists idx_campaign_leads_campaign on public.campaign_leads(campaign_id);
create index if not exists idx_campaign_leads_user     on public.campaign_leads(user_id);
create index if not exists idx_campaigns_user          on public.campaigns(user_id, created_at desc);

alter table public.leads          enable row level security;
alter table public.campaigns      enable row level security;
alter table public.campaign_leads enable row level security;


-- ---------------------------------------------------------------------
-- 1. PER-KEY CYCLE CREDIT
--
--    APIFY_MONTHLY_CREDIT_USD was one global number applied to every key:
--    the env fallback, the company primary, and a customer's own key on a
--    paid plan. Raising the env var lifted the ceiling for all of them at
--    once, including the free ones, which is the wrong lever.
--
--    null here means "use the server default", so existing rows keep
--    behaving exactly as they do today.
-- ---------------------------------------------------------------------
alter table public.apify_keys
    add column if not exists monthly_credit_usd numeric;

comment on column public.apify_keys.monthly_credit_usd is
    'Cycle credit for this key in USD. Null falls back to APIFY_MONTHLY_CREDIT_USD.';


-- ---------------------------------------------------------------------
-- 2. BUDGET RESERVATIONS
--
--    A reservation is an ordinary ledger row carrying the pre-run
--    estimate. Because cycle spend counts reservations, a second run on
--    the same key sees the credit as already committed and routes to the
--    next key instead of racing it. The row is rewritten with the real
--    usageTotalUsd the moment the run returns.
--
--    Reservations older than one run timeout are abandoned by definition
--    and the server sweeps them on a timer.
-- ---------------------------------------------------------------------
alter table public.apify_usage_events
    add column if not exists is_reservation boolean not null default false;

create index if not exists idx_usage_reservations
    on public.apify_usage_events (created_at)
    where is_reservation = true;

-- The spend query filters on this pair on every key resolution.
create index if not exists idx_usage_cycle_hash
    on public.apify_usage_events (token_hash, cycle_month, is_reservation);


-- ---------------------------------------------------------------------
-- 3. JOB CANCELLATION
--
--    An Apify run already in flight cannot be recalled, but the unit
--    boundary is where the money is: stopping before group 6 of 10 saves
--    most of the estimate. The checkpoint survives, so a cancelled job's
--    completed units are reused rather than re-scraped.
-- ---------------------------------------------------------------------
alter table public.jobs
    add column if not exists cancel_requested boolean not null default false;

-- Statuses now in use:
--   queued | running | done | failed
--   paused_no_credit  -> every key is dry, checkpoint intact, resumable
--   interrupted       -> server restarted mid-run, checkpoint intact, resumable
--   cancelled         -> stopped on request, checkpoint intact, resumable
create index if not exists idx_jobs_cancelling
    on public.jobs (id) where cancel_requested = true;


-- ---------------------------------------------------------------------
-- 4. CYCLE SPEND IN THE DATABASE
--
--    This ran on every key resolution and pulled every usage row for the
--    key back to Node to be summed in JavaScript. Fine at a hundred runs,
--    quietly expensive at ten thousand. Summing where the rows live also
--    means the number cannot drift between two server instances.
-- ---------------------------------------------------------------------
create or replace function public.el_cycle_spend(
    p_token_hash text,
    p_cycle_month text
)
returns numeric
language sql
stable
as $$
    select coalesce(sum(usage_usd), 0)::numeric
    from public.apify_usage_events
    where token_hash = p_token_hash
      and cycle_month = p_cycle_month;
$$;


-- ---------------------------------------------------------------------
-- 5. ATOMIC CHECKPOINT APPEND
--
--    The old path was read-modify-write from Node. That was safe only
--    while a job handled exactly one unit at a time; the moment two units
--    overlap, or a resumed job races the stale-job sweep, the losing write
--    drops a completed unit and the customer pays to scrape it twice.
--
--    Appending inside a single statement removes the window entirely.
-- ---------------------------------------------------------------------
create or replace function public.el_job_checkpoint(
    p_job_id uuid,
    p_unit   text,
    p_value  jsonb default null
)
returns void
language sql
volatile
as $$
    update public.jobs
    set completed_units = (
            select array_agg(distinct u)
            from unnest(coalesce(completed_units, '{}') || array[p_unit]) as u
        ),
        partials = case
            when p_value is null then coalesce(partials, '{}'::jsonb)
            else coalesce(partials, '{}'::jsonb) || jsonb_build_object(p_unit, p_value)
        end,
        updated_at = now()
    where id = p_job_id;
$$;

-- The service role calls these; nothing else should be able to.
revoke all on function public.el_cycle_spend(text, text)          from public, anon, authenticated;
revoke all on function public.el_job_checkpoint(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.el_cycle_spend(text, text)          to service_role;
grant execute on function public.el_job_checkpoint(uuid, text, jsonb) to service_role;


-- ---------------------------------------------------------------------
-- 6. COST TRUTH, EXCLUDING RESERVATIONS
--
--    apify_cost_truth from phase 2 would count an in-flight estimate as
--    though it were a settled charge. Replaced so the number stays honest.
-- ---------------------------------------------------------------------
create or replace view public.apify_cost_truth as
select
    cycle_month,
    actor_id,
    count(*)                                                as runs,
    sum(items)                                              as items,
    round(sum(usage_usd), 4)                                as usd,
    case when coalesce(sum(items), 0) > 0
         then round((sum(usage_usd) / sum(items)) * 1000, 4)
         else null end                                      as usd_per_1k_items
from public.apify_usage_events
where is_reservation = false
group by 1, 2
order by 1 desc, 5 desc;

create or replace view public.apify_spend_by_cycle as
select
    cycle_month,
    coalesce(apify_username, left(token_hash, 8)) as apify_account,
    engine,
    count(*)                 as runs,
    sum(items)               as items,
    round(sum(usage_usd), 4) as usd
from public.apify_usage_events
where is_reservation = false
group by 1, 2, 3
order by 1 desc, 6 desc;


-- ---------------------------------------------------------------------
-- 7. BUDGET AT A GLANCE
--
--    What each key is allowed to spend against what it has spent. This is
--    the query that answers "are we about to run out" before a job pauses,
--    rather than after.
-- ---------------------------------------------------------------------
create or replace view public.apify_key_budget as
select
    k.id,
    coalesce(k.apify_username, k.label, 'unnamed')            as account,
    k.engine,
    k.status,
    case when k.owner_user_id is null then 'shared' else 'personal' end as scope,
    coalesce(k.monthly_credit_usd, 5)                          as credit_usd,
    round(coalesce(s.spent, 0), 4)                             as spent_usd,
    round(greatest(0, coalesce(k.monthly_credit_usd, 5) - coalesce(s.spent, 0)), 4) as remaining_usd
from public.apify_keys k
left join lateral (
    select sum(usage_usd) as spent
    from public.apify_usage_events e
    where e.token_hash = k.token_hash
      and e.cycle_month = to_char(now(), 'YYYY-MM')
) s on true
order by remaining_usd desc;


-- ---------------------------------------------------------------------
-- 8. ONE-TIME CLEANUP
--
--    Any reservation predating this migration cannot exist, but a job
--    left mid-flight by the deploy that installs it can. Park those as
--    resumable rather than leaving the UI spinning.
-- ---------------------------------------------------------------------
update public.jobs
set    status = 'interrupted',
       error  = 'Interrupted by the phase 3 deploy. Resume to finish — completed steps are reused.'
where  status in ('queued', 'running')
  and  updated_at < now() - interval '30 minutes';


-- ---------------------------------------------------------------------
-- DONE
--
-- Confirm the RPCs are visible to the service role:
--
--     select proname from pg_proc
--     where proname in ('el_cycle_spend', 'el_job_checkpoint');
--
-- Then, after deploying server.js, check the logs for
-- rpc_cycle_spend_unavailable or rpc_checkpoint_unavailable. Neither
-- should appear. If they do, the functions did not install and the
-- server has fallen back to the slower client-side path.
--
-- Budget at a glance, any time:
--
--     select * from public.apify_key_budget;
-- ---------------------------------------------------------------------
