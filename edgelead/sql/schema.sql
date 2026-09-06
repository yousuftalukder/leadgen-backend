-- =====================================================================
-- EDGELEAD :: PHASE 0 SCHEMA MIGRATION
-- Safe to run repeatedly. Creates only what is missing.
-- Run in Supabase Dashboard -> SQL Editor -> New Query -> Run
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- 0. SYSTEM SETTINGS  (already exists — just guarantee the unique key)
-- ---------------------------------------------------------------------
create table if not exists public.system_settings (
    key         text primary key,
    value       text,
    updated_at  timestamptz default now()
);

do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conrelid = 'public.system_settings'::regclass
          and contype in ('p','u')
          and conkey = array[(select attnum from pg_attribute
                              where attrelid='public.system_settings'::regclass
                                and attname='key')]
    ) then
        alter table public.system_settings add constraint system_settings_key_uniq unique (key);
    end if;
end $$;


-- ---------------------------------------------------------------------
-- 1. APP USERS  (role + activation, mirrors auth.users)
-- ---------------------------------------------------------------------
create table if not exists public.app_users (
    id          uuid primary key references auth.users(id) on delete cascade,
    email       text,
    full_name   text,
    role        text not null default 'user',          -- 'admin' | 'user'
    is_active   boolean not null default true,
    notes       text,
    created_at  timestamptz default now(),
    updated_at  timestamptz default now()
);

create index if not exists idx_app_users_role on public.app_users(role);


-- ---------------------------------------------------------------------
-- 2. ENGINE ACCESS GRANTS  ('leadgen' | 'report')
-- ---------------------------------------------------------------------
create table if not exists public.user_engine_access (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null references auth.users(id) on delete cascade,
    engine      text not null,
    granted_by  uuid,
    granted_at  timestamptz default now(),
    unique (user_id, engine)
);

create index if not exists idx_engine_access_user on public.user_engine_access(user_id);


-- ---------------------------------------------------------------------
-- 3. APIFY KEY POOL
--    Primary per-engine key still lives in system_settings and is never
--    deleted. This table holds rotation keys + per-user keys.
-- ---------------------------------------------------------------------
create table if not exists public.apify_keys (
    id              uuid primary key default gen_random_uuid(),
    owner_user_id   uuid references auth.users(id) on delete cascade, -- null = global pool
    engine          text not null default 'any',        -- 'leadgen' | 'report' | 'any'
    label           text,
    token           text not null,
    apify_username  text,
    status          text not null default 'active',     -- 'active' | 'exhausted' | 'invalid'
    fail_count      int  not null default 0,
    last_used_at    timestamptz,
    last_checked_at timestamptz,
    created_at      timestamptz default now()
);

create index if not exists idx_apify_keys_lookup on public.apify_keys(owner_user_id, engine, status);
create unique index if not exists idx_apify_keys_token on public.apify_keys(token);


-- ---------------------------------------------------------------------
-- 4. JOBS  (async run tracking + polling)
-- ---------------------------------------------------------------------
create table if not exists public.jobs (
    id               uuid primary key default gen_random_uuid(),
    user_id          uuid not null references auth.users(id) on delete cascade,
    type             text not null,        -- 'deep_audit' | 'campaign' | 'enrich'
    engine           text,
    status           text not null default 'queued',  -- queued|running|done|failed
    progress         int  not null default 0,          -- 0-100
    current_step     text,
    log              jsonb default '[]'::jsonb,
    input            jsonb,
    result           jsonb,
    result_report_id uuid,
    error            text,
    credits_estimate numeric,
    created_at       timestamptz default now(),
    updated_at       timestamptz default now(),
    finished_at      timestamptz
);

create index if not exists idx_jobs_user on public.jobs(user_id, created_at desc);


-- ---------------------------------------------------------------------
-- 5. POSTS  (post-level storage — this is what makes real reports possible)
-- ---------------------------------------------------------------------
create table if not exists public.posts (
    id             uuid primary key default gen_random_uuid(),
    user_id        uuid not null references auth.users(id) on delete cascade,
    platform       text not null default 'instagram',
    handle         text not null,
    shortcode      text not null,
    post_url       text,
    post_type      text,                 -- Image | Video | Sidecar | Reel
    caption        text,
    caption_length int default 0,
    hashtags       text[] default '{}',
    mentions       text[] default '{}',
    likes          int default 0,
    comments       int default 0,
    views          int default 0,
    is_video       boolean default false,
    video_duration numeric,
    thumbnail_url  text,
    media_url      text,
    location_name  text,
    posted_at      timestamptz,
    report_id      uuid,
    set_id         uuid,
    raw            jsonb,
    scraped_at     timestamptz default now()
);

create unique index if not exists idx_posts_unique
    on public.posts(user_id, platform, shortcode);
create index if not exists idx_posts_handle on public.posts(handle, posted_at desc);
create index if not exists idx_posts_set on public.posts(set_id);


-- ---------------------------------------------------------------------
-- 6. COMPETITOR SETS  (re-runnable benchmark groups)
-- ---------------------------------------------------------------------
create table if not exists public.competitor_sets (
    id                 uuid primary key default gen_random_uuid(),
    user_id            uuid not null references auth.users(id) on delete cascade,
    name               text,
    platform           text not null default 'instagram',
    target_handle      text not null,
    competitor_handles text[] default '{}',
    posts_per_account  int default 30,
    last_run_at        timestamptz,
    created_at         timestamptz default now()
);

create index if not exists idx_sets_user on public.competitor_sets(user_id, created_at desc);


-- ---------------------------------------------------------------------
-- 7. REPORTS  (extend the existing table — nothing dropped)
-- ---------------------------------------------------------------------
create table if not exists public.reports (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid,
    platform        text default 'instagram',
    target_handle   text,
    grade           text,
    engagement_rate numeric,
    report_json     jsonb,
    created_at      timestamptz default now()
);

alter table public.reports add column if not exists set_id             uuid;
alter table public.reports add column if not exists report_type        text default 'single';
alter table public.reports add column if not exists snapshot_date      date default current_date;
alter table public.reports add column if not exists competitor_handles text[] default '{}';
alter table public.reports add column if not exists ai_summary         text;
alter table public.reports add column if not exists ai_json            jsonb;
alter table public.reports add column if not exists posts_analyzed     int default 0;
alter table public.reports add column if not exists score              numeric;
alter table public.reports add column if not exists credits_estimate   numeric;

create index if not exists idx_reports_set on public.reports(set_id, snapshot_date desc);
create index if not exists idx_reports_user on public.reports(user_id, created_at desc);


-- ---------------------------------------------------------------------
-- 8. LEADS TENANCY FIX
--    Adds owner_user_id, backfills from campaign_leads, and replaces the
--    global unique-on-username with a per-owner unique.
-- ---------------------------------------------------------------------
alter table public.leads add column if not exists owner_user_id uuid;
alter table public.leads add column if not exists bio           text;
alter table public.leads add column if not exists website       text;
alter table public.leads add column if not exists category      text;
alter table public.leads add column if not exists is_business   boolean;
alter table public.leads add column if not exists is_verified   boolean;
alter table public.leads add column if not exists city          text;
alter table public.leads add column if not exists address       text;
alter table public.leads add column if not exists posts_count   int;
alter table public.leads add column if not exists following_count int;

-- backfill ownership from the join table
update public.leads l
set    owner_user_id = sub.user_id
from ( select distinct on (lead_id) lead_id, user_id
       from public.campaign_leads
       where user_id is not null
       order by lead_id, id ) sub
where l.id = sub.lead_id
  and l.owner_user_id is null;

-- drop any pre-existing global unique constraint / index on username
do $$
declare r record;
begin
    for r in
        select conname from pg_constraint
        where conrelid = 'public.leads'::regclass
          and contype = 'u'
          and array_length(conkey,1) = 1
          and conkey[1] = (select attnum from pg_attribute
                           where attrelid='public.leads'::regclass and attname='username')
    loop
        execute format('alter table public.leads drop constraint %I', r.conname);
    end loop;

    for r in
        select indexname from pg_indexes
        where schemaname='public' and tablename='leads'
          and indexdef ilike '%unique%' and indexdef ilike '%(username)%'
    loop
        execute format('drop index if exists public.%I', r.indexname);
    end loop;
end $$;

create unique index if not exists idx_leads_owner_username
    on public.leads (coalesce(owner_user_id,'00000000-0000-0000-0000-000000000000'::uuid), username);

create index if not exists idx_leads_owner on public.leads(owner_user_id);


-- ---------------------------------------------------------------------
-- 9. LOCK DOWN RLS
--    The anon key is published inside your HTML files. Right now
--    leads / reports / system_settings are UNRESTRICTED, which means
--    anyone can read your stored Apify tokens straight from the browser.
--    The backend uses the service_role key and bypasses RLS, so enabling
--    RLS with no policies breaks nothing and closes the hole.
-- ---------------------------------------------------------------------
alter table public.leads              enable row level security;
alter table public.reports            enable row level security;
alter table public.system_settings    enable row level security;
alter table public.campaigns          enable row level security;
alter table public.campaign_leads     enable row level security;
alter table public.app_users          enable row level security;
alter table public.user_engine_access enable row level security;
alter table public.apify_keys         enable row level security;
alter table public.jobs               enable row level security;
alter table public.posts              enable row level security;
alter table public.competitor_sets    enable row level security;

-- ---------------------------------------------------------------------
-- DONE
-- ---------------------------------------------------------------------
