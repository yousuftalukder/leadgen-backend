-- =====================================================================
-- EDGELEAD :: FACEBOOK PAGE REPORT ENGINE  — SCHEMA MIGRATION
-- Additive only. Safe to run repeatedly. Drops nothing.
-- Run AFTER schema.sql and fb-schema.sql, in Supabase -> SQL Editor.
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- 1. FB PAGES  (the business pages being reported on — target or rival)
-- ---------------------------------------------------------------------
create table if not exists public.fb_pages (
    id               uuid primary key default gen_random_uuid(),
    user_id          uuid not null references auth.users(id) on delete cascade,
    page_id          text not null,               -- vanity slug, or numeric id
    username         text,
    name             text,
    url              text,
    category         text,
    categories       text[] default '{}',
    about            text,
    likes            bigint default 0,
    followers        bigint default 0,
    verified         boolean default false,
    website          text,
    email            text,
    phone            text,
    address          text,
    city             text,
    country          text,
    rating           numeric,
    reviews_count    bigint default 0,
    price_range      text,
    creation_date    text,
    profile_pic      text,
    cover_photo      text,
    has_hours        boolean default false,
    hours            jsonb,
    cta              text,
    page_score       numeric default 0,
    score_breakdown  jsonb,
    engagement_rate  numeric default 0,
    posts_per_week   numeric default 0,
    is_archived      boolean default false,
    last_scraped_at  timestamptz,
    created_at       timestamptz default now()
);

create unique index if not exists idx_fb_pages_unique
    on public.fb_pages(user_id, page_id);
create index if not exists idx_fb_pages_user
    on public.fb_pages(user_id, last_scraped_at desc);


-- ---------------------------------------------------------------------
-- 2. FB PAGE POSTS  (post-level storage — this is what makes the report
--    deep rather than a screenshot of the follower count)
-- ---------------------------------------------------------------------
create table if not exists public.fb_page_posts (
    id                  uuid primary key default gen_random_uuid(),
    user_id             uuid not null references auth.users(id) on delete cascade,
    page_id             text not null,
    page_row_id         uuid,
    post_id             text not null,
    post_url            text,
    content             text,
    content_length      int default 0,
    word_count          int default 0,
    media_type          text,                 -- text | photo | album | video | link | poll
    link_url            text,
    link_domain         text,
    reactions_total     int default 0,
    reactions_breakdown jsonb,
    comments            int default 0,
    shares              int default 0,
    views               bigint default 0,
    posted_at           timestamptz,
    hour_local          int,
    dow_local           int,                  -- 0 = Sunday
    engagement_raw      numeric default 0,    -- reactions + 3*comments + 4*shares
    performance_index   numeric,              -- vs that page's own month median
    intent_type         text,
    topic_tags          text[] default '{}',
    hashtags            text[] default '{}',
    opening_pattern     text,
    length_band         text,
    has_link            boolean default false,
    has_question        boolean default false,
    has_cta             boolean default false,
    has_offer           boolean default false,
    has_emoji           boolean default false,
    is_provisional      boolean default false, -- true when < 24h old at scrape time
    report_id           uuid,
    raw                 jsonb,
    scraped_at          timestamptz default now()
);

create unique index if not exists idx_fb_page_posts_unique
    on public.fb_page_posts(user_id, page_id, post_id);
create index if not exists idx_fb_page_posts_page
    on public.fb_page_posts(page_id, posted_at desc);
create index if not exists idx_fb_page_posts_report
    on public.fb_page_posts(report_id);
create index if not exists idx_fb_page_posts_perf
    on public.fb_page_posts(user_id, performance_index desc nulls last);


-- ---------------------------------------------------------------------
-- 3. FB PAGE SETS  (a saved target + rival pair, so the same match-up can
--    be re-run later and the two snapshots line up into a drift view)
-- ---------------------------------------------------------------------
create table if not exists public.fb_page_sets (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid not null references auth.users(id) on delete cascade,
    name            text,
    target_page     text not null,
    target_url      text,
    rival_page      text,
    rival_url       text,
    posts_per_page  int default 50,
    days_window     int default 90,
    last_run_at     timestamptz,
    created_at      timestamptz default now()
);

create index if not exists idx_fb_page_sets_user
    on public.fb_page_sets(user_id, created_at desc);


-- ---------------------------------------------------------------------
-- 4. REPORTS TABLE — Facebook Page columns
--    Page reports live in the same vault as everything else:
--      platform = 'facebook', report_type = 'fb_page',
--      audit_mode = 'single' | 'versus'
-- ---------------------------------------------------------------------
alter table public.reports add column if not exists fb_page_ids   text[] default '{}';
alter table public.reports add column if not exists fb_page_names text[] default '{}';

create index if not exists idx_reports_type
    on public.reports(user_id, platform, report_type, created_at desc);


-- ---------------------------------------------------------------------
-- 5. ENGINE REGISTRATION
--    'fb_page' gates and bills exactly like the other engines.
--    Granted to every admin, and to everyone who already has the
--    Facebook community engine, so nobody is locked out on deploy.
-- ---------------------------------------------------------------------
insert into public.user_engine_access (user_id, engine)
select id, 'fb_page' from public.app_users where role = 'admin'
on conflict (user_id, engine) do nothing;

insert into public.user_engine_access (user_id, engine)
select distinct user_id, 'fb_page' from public.user_engine_access where engine = 'fb_community'
on conflict (user_id, engine) do nothing;


-- ---------------------------------------------------------------------
-- 6. RLS
--    The backend uses the service_role key and bypasses this. Enabling
--    RLS with no policies closes the browser-side hole, exactly as
--    schema.sql and fb-schema.sql already do.
-- ---------------------------------------------------------------------
alter table public.fb_pages      enable row level security;
alter table public.fb_page_posts enable row level security;
alter table public.fb_page_sets  enable row level security;

-- ---------------------------------------------------------------------
-- DONE
-- ---------------------------------------------------------------------
