-- =====================================================================
-- EDGELEAD :: PHASE 11 — scheduled runs, share links, IG extras
-- Run AFTER schema-phase10.sql, BEFORE deploying the phase 11 server.
-- Re-runnable.
--
-- 1. schedules      — "re-run this job's input every week / month"
-- 2. report_shares  — read-only, expiring, revocable links to one report
-- 3. posts.plays    — reel plays kept apart from autoplay views
-- 4. leads.whatsapp — number mined from the bio / wa.me link
-- 5. heartbeat rows in system_settings need nothing (key/value text)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. SCHEDULES
-- ---------------------------------------------------------------------
create table if not exists public.schedules (
    id               uuid primary key default gen_random_uuid(),
    user_id          uuid not null references auth.users(id) on delete cascade,
    client_id        uuid references public.clients(id) on delete cascade,
    job_type         text not null,          -- ig_report | deep_audit | fb_community_audit | fb_page_report | meta_insights
    engine           text not null,
    input            jsonb not null,         -- the validated job input, verbatim
    credits_estimate numeric default 0,
    label            text,
    cadence          text not null default 'monthly' check (cadence in ('weekly','monthly')),
    day_of_week      int  not null default 1 check (day_of_week between 0 and 6),
    day_of_month     int  not null default 1 check (day_of_month between 1 and 28),
    hour_utc         int  not null default 6 check (hour_utc between 0 and 23),
    next_run_at      timestamptz not null,
    last_run_at      timestamptz,
    last_job_id      uuid,
    last_report_id   uuid,
    last_status      text,                   -- started | done | failed | paused_no_credit | skipped* | deferred
    last_error       text,
    runs             int  not null default 0,
    paused           boolean not null default false,
    source_job_id    uuid,
    created_at       timestamptz default now(),
    updated_at       timestamptz default now()
);
create index if not exists idx_schedules_due    on public.schedules(next_run_at) where paused = false;
create index if not exists idx_schedules_user   on public.schedules(user_id, created_at desc);
create index if not exists idx_schedules_client on public.schedules(client_id, created_at desc);

-- ---------------------------------------------------------------------
-- 2. REPORT SHARES
-- ---------------------------------------------------------------------
create table if not exists public.report_shares (
    id             uuid primary key default gen_random_uuid(),
    token          text not null unique,
    report_id      uuid not null references public.reports(id) on delete cascade,
    user_id        uuid not null references auth.users(id) on delete cascade,
    client_id      uuid references public.clients(id) on delete set null,
    label          text,
    expires_at     timestamptz not null,
    revoked_at     timestamptz,
    views          int not null default 0,
    last_viewed_at timestamptz,
    created_at     timestamptz default now()
);
create index if not exists idx_report_shares_report on public.report_shares(report_id, created_at desc);
create index if not exists idx_report_shares_user   on public.report_shares(user_id, created_at desc);
create index if not exists idx_report_shares_client on public.report_shares(client_id, created_at desc);

-- ---------------------------------------------------------------------
-- 3 + 4. COLUMNS
-- ---------------------------------------------------------------------
alter table public.posts add column if not exists plays bigint default 0;
alter table public.leads add column if not exists whatsapp text;

-- ---------------------------------------------------------------------
-- RLS: same posture as every phase-9 table. The server holds the service
-- role; there are no anon/authenticated policies, so nothing is readable
-- through PostgREST with the anon key — including share tokens.
-- ---------------------------------------------------------------------
alter table public.schedules     enable row level security;
alter table public.report_shares enable row level security;

-- ---------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------
-- select column_name from information_schema.columns where table_name='posts' and column_name='plays';
-- select column_name from information_schema.columns where table_name='leads' and column_name='whatsapp';
-- select count(*) from public.schedules;
-- select count(*) from public.report_shares;
-- DONE
