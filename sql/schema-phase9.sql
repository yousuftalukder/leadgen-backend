-- =====================================================================
-- EDGELEAD — PHASE 9 MIGRATION
--
-- Run in the Supabase SQL editor BEFORE deploying server.js (phase 9).
-- Idempotent. Drops nothing. Adds nothing that the phase 8 server writes,
-- so it is safe to run while phase 8 is still live.
--
--   1. Clients + members (the unit of work, and how it is shared)
--   2. client_id on every artefact table
--   3. Gemini key pool
--   4. Meta owner-data: OAuth state, connections, snapshots, media
--   5. Report columns for content_plan / meta_owned
--   6. Engine registration + RLS
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- 1. CLIENTS
-- ---------------------------------------------------------------------
create table if not exists public.clients (
    id             uuid primary key default gen_random_uuid(),
    owner_user_id  uuid not null references auth.users(id) on delete cascade,
    name           text not null,
    brand          text,
    ig_handle      text,
    fb_page        text,
    fb_page_id     text,
    niche          text,
    location       text,
    notes          text,
    archived       boolean default false,
    created_at     timestamptz default now(),
    updated_at     timestamptz default now()
);
create index if not exists idx_clients_owner on public.clients(owner_user_id, archived, created_at desc);

create table if not exists public.client_members (
    client_id   uuid not null references public.clients(id) on delete cascade,
    user_id     uuid not null references auth.users(id) on delete cascade,
    role        text not null default 'editor',     -- viewer | editor
    added_by    uuid,
    created_at  timestamptz default now(),
    primary key (client_id, user_id)
);
create index if not exists idx_client_members_user on public.client_members(user_id);

-- ---------------------------------------------------------------------
-- 2. client_id ON EVERY ARTEFACT
-- ---------------------------------------------------------------------
alter table public.reports          add column if not exists client_id uuid references public.clients(id) on delete set null;
alter table public.jobs             add column if not exists client_id uuid references public.clients(id) on delete set null;
alter table public.competitor_sets  add column if not exists client_id uuid references public.clients(id) on delete set null;
alter table public.fb_group_sets    add column if not exists client_id uuid references public.clients(id) on delete set null;
alter table public.fb_page_sets     add column if not exists client_id uuid references public.clients(id) on delete set null;
alter table public.fb_suggestions   add column if not exists client_id uuid references public.clients(id) on delete set null;
alter table public.campaigns        add column if not exists client_id uuid references public.clients(id) on delete set null;

create index if not exists idx_reports_client on public.reports(client_id, created_at desc);
create index if not exists idx_jobs_client    on public.jobs(client_id, created_at desc);

-- ---------------------------------------------------------------------
-- 3. GEMINI KEY POOL
--    owner_user_id null = shared pool (admin managed). Personal keys are
--    used only for calls made on behalf of that user.
-- ---------------------------------------------------------------------
create table if not exists public.gemini_keys (
    id              uuid primary key default gen_random_uuid(),
    owner_user_id   uuid references auth.users(id) on delete cascade,
    label           text,
    key_enc         text not null,
    key_hash        text not null,
    status          text not null default 'active',   -- active | cooldown | invalid
    cooldown_until  timestamptz,
    fail_count      int default 0,
    calls_total     int default 0,
    last_used_at    timestamptz,
    last_error      text,
    created_at      timestamptz default now()
);
create unique index if not exists idx_gemini_keys_hash_owner
    on public.gemini_keys (key_hash, coalesce(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists idx_gemini_keys_owner on public.gemini_keys(owner_user_id, status);

-- ---------------------------------------------------------------------
-- 4. META OWNER DATA
-- ---------------------------------------------------------------------
create table if not exists public.meta_oauth_states (
    state       text primary key,
    user_id     uuid not null,
    client_id   uuid,
    expires_at  timestamptz not null
);

create table if not exists public.meta_connections (
    id                uuid primary key default gen_random_uuid(),
    user_id           uuid not null references auth.users(id) on delete cascade,
    client_id         uuid references public.clients(id) on delete set null,
    page_id           text not null,
    page_name         text,
    page_token_enc    text,
    ig_user_id        text,
    ig_username       text,
    user_token_enc    text,
    token_expires_at  timestamptz,
    scopes            text[] default '{}',
    status            text default 'active',       -- active | expired | revoked | error
    last_sync_at      timestamptz,
    last_error        text,
    created_at        timestamptz default now()
);
create unique index if not exists idx_meta_conn_user_page on public.meta_connections(user_id, page_id);
create index if not exists idx_meta_conn_client on public.meta_connections(client_id);

create table if not exists public.meta_snapshots (
    id             uuid primary key default gen_random_uuid(),
    connection_id  uuid not null references public.meta_connections(id) on delete cascade,
    user_id        uuid not null,
    snapshot_date  date not null,
    level          text not null,                  -- page | ig
    metrics        jsonb not null default '{}',
    created_at     timestamptz default now()
);
create unique index if not exists idx_meta_snap_unique on public.meta_snapshots(connection_id, level, snapshot_date);

create table if not exists public.meta_media (
    id             uuid primary key default gen_random_uuid(),
    connection_id  uuid not null references public.meta_connections(id) on delete cascade,
    user_id        uuid not null,
    platform       text not null,                  -- instagram | facebook
    media_id       text not null,
    shortcode      text,
    media_type     text,
    product_type   text,
    caption        text,
    permalink      text,
    posted_at      timestamptz,
    like_count     int,
    comments_count int,
    insights       jsonb default '{}',
    synced_at      timestamptz default now()
);
create unique index if not exists idx_meta_media_unique on public.meta_media(connection_id, media_id);
create index if not exists idx_meta_media_shortcode on public.meta_media(user_id, shortcode);

-- ---------------------------------------------------------------------
-- 5. REPORT COLUMNS
-- ---------------------------------------------------------------------
alter table public.reports add column if not exists source_report_ids uuid[] default '{}';
alter table public.reports add column if not exists meta_connection_id uuid;

-- ---------------------------------------------------------------------
-- 6. ENGINE REGISTRATION + RLS
-- ---------------------------------------------------------------------
insert into public.user_engine_access (user_id, engine)
select id, 'meta_owned' from public.app_users where role = 'admin'
on conflict (user_id, engine) do nothing;

insert into public.user_engine_access (user_id, engine)
select id, 'content_plan' from public.app_users where role = 'admin'
on conflict (user_id, engine) do nothing;

-- content_plan is granted alongside the IG report engine: it is derived from
-- the same data and costs nothing at Apify.
insert into public.user_engine_access (user_id, engine)
select distinct user_id, 'content_plan' from public.user_engine_access where engine = 'report'
on conflict (user_id, engine) do nothing;

alter table public.clients           enable row level security;
alter table public.client_members    enable row level security;
alter table public.gemini_keys       enable row level security;
alter table public.meta_oauth_states enable row level security;
alter table public.meta_connections  enable row level security;
alter table public.meta_snapshots    enable row level security;
alter table public.meta_media        enable row level security;

-- ---------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------
-- select count(*) from public.clients;
-- select engine, count(*) from public.user_engine_access group by 1;
-- DONE
