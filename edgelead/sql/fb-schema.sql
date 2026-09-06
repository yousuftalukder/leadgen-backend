-- =====================================================================
-- EDGELEAD :: FACEBOOK COMMUNITY ENGINE  — SCHEMA MIGRATION
-- Additive only. Safe to run repeatedly. Drops nothing.
-- Run AFTER schema.sql, in Supabase -> SQL Editor -> New Query -> Run
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- 1. FB GROUPS  (the rooms)
-- ---------------------------------------------------------------------
create table if not exists public.fb_groups (
    id                 uuid primary key default gen_random_uuid(),
    user_id            uuid not null references auth.users(id) on delete cascade,
    group_id           text not null,                    -- numeric id or slug from the URL
    name               text,
    url                text,
    member_count       bigint default 0,
    location_label     text,
    lat                numeric,
    lng                numeric,
    niche              text,
    privacy            text default 'public',            -- 'public' | 'private' | 'unknown'
    rules_text         text,
    promo_allowed      boolean default true,
    approval_required  boolean default false,
    posts_per_day      numeric default 0,
    median_comments    numeric default 0,
    unique_poster_ratio numeric default 0,
    response_latency_mins numeric,
    room_value_score   numeric default 0,
    score_breakdown    jsonb,
    source             text default 'discovery',         -- 'discovery' | 'manual'
    is_archived        boolean default false,
    last_scraped_at    timestamptz,
    created_at         timestamptz default now()
);

create unique index if not exists idx_fb_groups_unique
    on public.fb_groups(user_id, group_id);
create index if not exists idx_fb_groups_user
    on public.fb_groups(user_id, room_value_score desc);
create index if not exists idx_fb_groups_niche
    on public.fb_groups(user_id, niche, location_label);


-- ---------------------------------------------------------------------
-- 2. FB GROUP SETS  (direct mirror of competitor_sets)
-- ---------------------------------------------------------------------
create table if not exists public.fb_group_sets (
    id               uuid primary key default gen_random_uuid(),
    user_id          uuid not null references auth.users(id) on delete cascade,
    name             text,
    location_label   text,
    niche            text,
    group_ids        text[] default '{}',   -- fb_groups.id values, as text
    audit_mode       text default 'combined',  -- 'combined' | 'individual'
    days_window      int default 60,
    posts_per_group  int default 120,
    last_run_at      timestamptz,
    created_at       timestamptz default now()
);

create index if not exists idx_fb_sets_user
    on public.fb_group_sets(user_id, created_at desc);


-- ---------------------------------------------------------------------
-- 3. FB POSTS  (post-level storage — mirrors public.posts)
-- ---------------------------------------------------------------------
create table if not exists public.fb_posts (
    id                uuid primary key default gen_random_uuid(),
    user_id           uuid not null references auth.users(id) on delete cascade,
    group_id          text not null,
    group_row_id      uuid,
    post_id           text not null,
    post_url          text,
    author_hash       text,                 -- sha256(author name + group). NEVER the name.
    author_label      text,                 -- 'member' | 'admin' | 'moderator'
    author_is_admin   boolean default false,
    content           text,
    content_length    int default 0,
    media_type        text,                 -- text | photo | album | video | link | poll
    link_url          text,
    link_domain       text,
    reactions_total   int default 0,
    reactions_breakdown jsonb,
    comments          int default 0,
    shares            int default 0,
    posted_at         timestamptz,
    hour_local        int,
    dow_local         int,                  -- 0 = Sunday
    engagement_raw    numeric default 0,    -- reactions + 3*comments + 4*shares
    performance_index numeric,              -- vs that group's month median
    intent_type       text,
    topic_tags        text[] default '{}',
    opening_pattern   text,
    length_band       text,
    is_provisional    boolean default false, -- true when < 24h old at scrape time
    report_id         uuid,
    raw               jsonb,
    scraped_at        timestamptz default now(),
    rescraped_at      timestamptz
);

create unique index if not exists idx_fb_posts_unique
    on public.fb_posts(user_id, group_id, post_id);
create index if not exists idx_fb_posts_group
    on public.fb_posts(group_id, posted_at desc);
create index if not exists idx_fb_posts_report
    on public.fb_posts(report_id);
create index if not exists idx_fb_posts_perf
    on public.fb_posts(user_id, performance_index desc nulls last);


-- ---------------------------------------------------------------------
-- 4. FB DEMAND SIGNALS  (the lead feed)
-- ---------------------------------------------------------------------
create table if not exists public.fb_demand_signals (
    id             uuid primary key default gen_random_uuid(),
    user_id        uuid not null references auth.users(id) on delete cascade,
    group_id       text not null,
    group_name     text,
    source_post_id text,
    source_url     text,
    snippet        text,
    matched_phrase text,
    intent         text,                  -- 'recommendation_request' | 'hiring' | ...
    category       text,                  -- home_services | food | health | ...
    urgency        text default 'low',    -- high | medium | low
    lead_score     numeric default 0,
    author_hash    text,
    engagement     int default 0,
    detected_at    timestamptz default now(),
    posted_at      timestamptz,
    status         text default 'new',    -- new | saved | contacted | won | dismissed
    notes          text,
    report_id      uuid
);

create unique index if not exists idx_fb_demand_unique
    on public.fb_demand_signals(user_id, group_id, source_post_id, matched_phrase);
create index if not exists idx_fb_demand_feed
    on public.fb_demand_signals(user_id, status, lead_score desc, detected_at desc);
create index if not exists idx_fb_demand_group
    on public.fb_demand_signals(group_id, detected_at desc);


-- ---------------------------------------------------------------------
-- 5. FB SUGGESTIONS  (post advisor drafts + the closed loop)
-- ---------------------------------------------------------------------
create table if not exists public.fb_suggestions (
    id               uuid primary key default gen_random_uuid(),
    user_id          uuid not null references auth.users(id) on delete cascade,
    group_id         text not null,
    group_name       text,
    report_id        uuid,
    draft_text       text not null,
    format           text,
    intent_type      text,
    rationale        text,
    pattern_used     text,
    suggested_time   text,
    predicted_band   text,                -- top | above | typical | below
    predicted_index  numeric,
    compliance_mode  text default 'open', -- 'open' | 'value_first' (promo banned in that group)
    posted           boolean default false,
    posted_at        timestamptz,
    posted_url       text,
    actual_index     numeric,
    verified_at      timestamptz,
    created_at       timestamptz default now()
);

create index if not exists idx_fb_suggestions_user
    on public.fb_suggestions(user_id, created_at desc);
create index if not exists idx_fb_suggestions_loop
    on public.fb_suggestions(user_id, posted, verified_at);


-- ---------------------------------------------------------------------
-- 6. REPORTS TABLE — Facebook columns
-- ---------------------------------------------------------------------
alter table public.reports add column if not exists fb_group_ids   text[] default '{}';
alter table public.reports add column if not exists fb_group_names text[] default '{}';
alter table public.reports add column if not exists location_label text;
alter table public.reports add column if not exists niche          text;
alter table public.reports add column if not exists audit_mode     text;

create index if not exists idx_reports_platform
    on public.reports(user_id, platform, created_at desc);


-- ---------------------------------------------------------------------
-- 7. ENGINE REGISTRATION
--    'fb_community' gates and bills exactly like 'leadgen' and 'report'.
--    Every existing admin is granted it so nobody is locked out on deploy.
-- ---------------------------------------------------------------------
insert into public.user_engine_access (user_id, engine)
select id, 'fb_community' from public.app_users where role = 'admin'
on conflict (user_id, engine) do nothing;


-- ---------------------------------------------------------------------
-- 8. RLS  (backend uses service_role and bypasses this — closes the
--    browser-side hole exactly as schema.sql does for the IG tables)
-- ---------------------------------------------------------------------
alter table public.fb_groups         enable row level security;
alter table public.fb_group_sets     enable row level security;
alter table public.fb_posts          enable row level security;
alter table public.fb_demand_signals enable row level security;
alter table public.fb_suggestions    enable row level security;

-- ---------------------------------------------------------------------
-- DONE
-- ---------------------------------------------------------------------
