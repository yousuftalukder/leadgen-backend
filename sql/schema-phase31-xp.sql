-- ---------------------------------------------------------------------
-- PHASE 31 — the XpulseAI Owner Assistant warehouse, inside EdgeLead.
--
-- XpulseAI's migrations 0001–0028, copied verbatim and applied in order, with one
-- mechanical change: every table, view and index is prefixed xp_, because
-- XpulseAI's clients, meta_connections, ai_conversations and ai_messages
-- would otherwise collide with EdgeLead's tables of the same names. The SQL
-- functions (fn_*) keep their names; EdgeLead's are el_*.
--
-- Skipped: 0015/0016/0017 (data repairs for XpulseAI's own three clients), 0025 staff, 0027 email, 0029 owner accounts (EdgeLead has its own auth and mail).
--
-- Run in the Supabase SQL editor before deploying the phase-31 server.
-- ---------------------------------------------------------------------

-- ===================================================================
-- 0001_schema_v2.sql
-- ===================================================================
-- =====================================================================
--  XPulse Meta Analytics — MASTER SCHEMA v2
--  Run in Supabase SQL Editor (as postgres). Idempotent: safe to re-run.
--  Migrates data from v1 tables (xp_clients, xp_meta_posts, meta_post_snapshots,
--  meta_daily_metrics, xp_generated_reports) without deleting anything.
--  v1 tables are renamed legacy_* and can be dropped after verification.
-- =====================================================================

begin;

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 0. Helpers
-- ---------------------------------------------------------------------
create or replace function fn_set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Immutability guard: finalized snapshot rows cannot be changed or deleted
-- unless the session explicitly opts in:  set app.allow_snapshot_rewrite = 'on';
create or replace function fn_guard_final_snapshot() returns trigger
language plpgsql as $$
begin
  if old.is_final
     and current_setting('app.allow_snapshot_rewrite', true) is distinct from 'on' then
    raise exception 'Row in % for % is finalized and immutable. Set app.allow_snapshot_rewrite=on to override.',
      tg_table_name, coalesce(to_jsonb(old)->>'snapshot_date', to_jsonb(old)->>'metric_date');
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

-- Today in a given IANA timezone
create or replace function fn_today(tz text) returns date
language sql stable as $$
  select (now() at time zone tz)::date
$$;

-- ---------------------------------------------------------------------
-- 1. Tenants / logins  (existing table, extended in place)
-- ---------------------------------------------------------------------
create table if not exists xp_clients (
  id                uuid primary key default gen_random_uuid(),
  client_name       text not null,
  meta_page_id      text unique,          -- v1 field, kept for compatibility; assets live in xp_meta_assets
  ig_account_id     text,                 -- v1 field
  email             text,
  username          text unique,
  password          text,                 -- scrypt "salt:hash"
  meta_access_token text,                 -- v1 field (encrypted); moved to xp_meta_assets/connections
  token_status      text default 'ACTIVE',
  token_expires_at  timestamptz,
  last_synced_at    timestamptz
);
alter table xp_clients add column if not exists timezone      text not null default 'Asia/Dhaka';
alter table xp_clients add column if not exists company_name  text;
alter table xp_clients add column if not exists logo_url      text;
alter table xp_clients add column if not exists is_active     boolean not null default true;
alter table xp_clients add column if not exists notes         text;
alter table xp_clients add column if not exists created_at    timestamptz not null default now();
alter table xp_clients add column if not exists updated_at    timestamptz not null default now();
create unique index if not exists xp_clients_username_key on xp_clients(username);
drop trigger if exists trg_clients_updated on xp_clients;
create trigger trg_clients_updated before update on xp_clients
  for each row execute function fn_set_updated_at();

-- ---------------------------------------------------------------------
-- 2. Meta connections (a token) and assets (a page / IG account)
-- ---------------------------------------------------------------------
create table if not exists xp_meta_connections (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid references xp_clients(id) on delete cascade,
  connection_type    text not null check (connection_type in ('USER_OAUTH','SYSTEM_USER','MANUAL')),
  meta_user_id       text,
  business_id        text,
  business_name      text,
  token_enc          text not null,                 -- AES-256-GCM  iv:tag:cipher
  token_expires_at   timestamptz,                   -- null = never (system user)
  scopes             text[] default '{}',
  status             text not null default 'ACTIVE' check (status in ('ACTIVE','EXPIRED','REVOKED','INVALID')),
  last_validated_at  timestamptz,
  validation_error   text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
drop trigger if exists trg_conn_updated on xp_meta_connections;
create trigger trg_conn_updated before update on xp_meta_connections
  for each row execute function fn_set_updated_at();

create table if not exists xp_meta_assets (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid not null references xp_clients(id) on delete cascade,
  connection_id      uuid references xp_meta_connections(id) on delete set null,
  platform           text not null check (platform in ('FB','IG')),
  asset_id           text not null,                 -- FB page id or IG user id
  name               text,
  username           text,
  category           text,
  linked_asset_id    uuid references xp_meta_assets(id) on delete set null,   -- IG -> its FB page
  access_token_enc   text,                          -- page token (FB); IG uses linked page token
  token_expires_at   timestamptz,
  status             text not null default 'ACTIVE' check (status in ('ACTIVE','PAUSED','EXPIRED','REMOVED')),
  insights_timezone  text not null default 'UTC',   -- FB page insights: America/Los_Angeles ; IG: UTC
  profile            jsonb default '{}'::jsonb,     -- bio, website, picture, verification, fan_count...
  first_synced_at    timestamptz,
  last_synced_at     timestamptz,
  last_full_backfill_at timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (platform, asset_id)
);
create index if not exists xp_meta_assets_client_idx on xp_meta_assets(client_id);
drop trigger if exists trg_assets_updated on xp_meta_assets;
create trigger trg_assets_updated before update on xp_meta_assets
  for each row execute function fn_set_updated_at();

-- ---------------------------------------------------------------------
-- 3. Rename v1 metric tables to legacy_* (only if they are v1-shaped)
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('public.xp_meta_posts') is not null
     and not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='xp_meta_posts' and column_name='asset_id') then
    alter table xp_meta_posts rename to legacy_meta_posts;
  end if;

  if to_regclass('public.meta_post_snapshots') is not null
     and not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='meta_post_snapshots' and column_name='asset_id') then
    alter table meta_post_snapshots rename to legacy_meta_post_snapshots;
  end if;

  if to_regclass('public.meta_daily_metrics') is not null
     and not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='meta_daily_metrics' and column_name='asset_id') then
    alter table meta_daily_metrics rename to legacy_meta_daily_metrics;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 4. Posts (metadata only — counters live in snapshots)
-- ---------------------------------------------------------------------
create table if not exists xp_meta_posts (
  id                  uuid primary key default gen_random_uuid(),
  client_id           uuid not null references xp_clients(id) on delete cascade,
  asset_id            uuid not null references xp_meta_assets(id) on delete cascade,
  platform            text not null check (platform in ('FB','IG')),
  meta_post_id        text not null,
  media_type          text,            -- IMAGE / VIDEO / CAROUSEL_ALBUM / STORY / photo / video / link ...
  media_product_type  text,            -- FEED / REELS / STORY / AD (IG); status_type (FB)
  caption             text,
  permalink           text,
  media_url           text,
  thumbnail_url       text,
  publish_date        timestamptz not null,
  is_story            boolean not null default false,
  story_expires_at    timestamptz,
  parent_post_id      text,            -- carousel children
  is_deleted          boolean not null default false,
  deleted_detected_at timestamptz,
  raw                 jsonb default '{}'::jsonb,
  first_seen_at       timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  unique (asset_id, meta_post_id)
);
create index if not exists xp_meta_posts_client_pub_idx on xp_meta_posts(client_id, publish_date desc);
create index if not exists xp_meta_posts_asset_pub_idx  on xp_meta_posts(asset_id, publish_date desc);

-- ---------------------------------------------------------------------
-- 5. Post metric snapshots — ABSOLUTE lifetime-to-date values as read on snapshot_date
-- ---------------------------------------------------------------------
create table if not exists xp_post_metric_snapshots (
  id                  bigint generated always as identity primary key,
  client_id           uuid not null references xp_clients(id) on delete cascade,
  asset_id            uuid not null references xp_meta_assets(id) on delete cascade,
  meta_post_id        text not null,
  platform            text not null check (platform in ('FB','IG')),
  snapshot_date       date not null,                 -- in client presentation timezone
  impressions         bigint,                        -- FB post_impressions / IG views (legacy impressions)
  reach               bigint,                        -- FB post_impressions_unique / IG reach
  views               bigint,                        -- IG views / FB video views proxy
  plays               bigint,                        -- reels plays
  likes               bigint,
  comments            bigint,
  shares              bigint,
  saves               bigint,
  reactions_total     bigint,
  reactions           jsonb,                         -- {like:..,love:..,haha:..}
  engaged_users       bigint,
  clicks              bigint,
  total_interactions  bigint,
  video_views         bigint,
  avg_watch_time_ms   bigint,
  profile_visits      bigint,
  follows             bigint,
  extra               jsonb default '{}'::jsonb,     -- story navigation, replies, exits, etc.
  raw                 jsonb default '{}'::jsonb,     -- full Graph API insight payload
  source              text not null default 'LIVE' check (source in ('LIVE','BACKFILL','MIGRATED','RECONSTRUCTED')),
  is_final            boolean not null default false,
  collected_at        timestamptz not null default now(),
  unique (asset_id, meta_post_id, snapshot_date)
);
create index if not exists xp_pms_client_date_idx on xp_post_metric_snapshots(client_id, snapshot_date);
create index if not exists xp_pms_post_date_idx   on xp_post_metric_snapshots(asset_id, meta_post_id, snapshot_date desc);
drop trigger if exists trg_pms_guard_upd on xp_post_metric_snapshots;
create trigger trg_pms_guard_upd before update on xp_post_metric_snapshots
  for each row execute function fn_guard_final_snapshot();
drop trigger if exists trg_pms_guard_del on xp_post_metric_snapshots;
create trigger trg_pms_guard_del before delete on xp_post_metric_snapshots
  for each row execute function fn_guard_final_snapshot();

-- ---------------------------------------------------------------------
-- 6. Account metric snapshots — one row per asset per day
-- ---------------------------------------------------------------------
create table if not exists xp_account_metric_snapshots (
  id                  bigint generated always as identity primary key,
  client_id           uuid not null references xp_clients(id) on delete cascade,
  asset_id            uuid not null references xp_meta_assets(id) on delete cascade,
  platform            text not null check (platform in ('FB','IG')),
  metric_date         date not null,
  -- observed totals (as read at collected_at)
  followers_total     bigint,
  fans_total          bigint,                        -- FB page likes
  following_total     bigint,                        -- IG
  media_count         bigint,
  -- day metrics reported by API for metric_date
  impressions         bigint,
  reach               bigint,
  views               bigint,
  page_views          bigint,                        -- FB page_views_total
  profile_views       bigint,                        -- IG
  engagements         bigint,                        -- FB page_post_engagements / IG total_interactions
  likes               bigint,
  comments            bigint,
  shares              bigint,
  saves               bigint,
  replies             bigint,
  video_views         bigint,
  accounts_engaged    bigint,
  website_clicks      bigint,
  profile_link_taps   bigint,
  follows_day         bigint,                        -- API-reported follows for the day
  unfollows_day       bigint,
  fan_adds            bigint,
  fan_removes         bigint,
  reactions           jsonb,
  online_followers    jsonb,                         -- hour -> count
  extra               jsonb default '{}'::jsonb,
  raw                 jsonb default '{}'::jsonb,
  source              text not null default 'LIVE' check (source in ('LIVE','BACKFILL','MIGRATED','RECONSTRUCTED')),
  is_final            boolean not null default false,
  collected_at        timestamptz not null default now(),
  unique (asset_id, metric_date)
);
create index if not exists xp_ams_client_date_idx on xp_account_metric_snapshots(client_id, metric_date);
drop trigger if exists trg_ams_guard_upd on xp_account_metric_snapshots;
create trigger trg_ams_guard_upd before update on xp_account_metric_snapshots
  for each row execute function fn_guard_final_snapshot();
drop trigger if exists trg_ams_guard_del on xp_account_metric_snapshots;
create trigger trg_ams_guard_del before delete on xp_account_metric_snapshots
  for each row execute function fn_guard_final_snapshot();

-- ---------------------------------------------------------------------
-- 7. Audience demographics (periodic)
-- ---------------------------------------------------------------------
create table if not exists xp_audience_snapshots (
  id            bigint generated always as identity primary key,
  client_id     uuid not null references xp_clients(id) on delete cascade,
  asset_id      uuid not null references xp_meta_assets(id) on delete cascade,
  snapshot_date date not null,
  audience_type text not null check (audience_type in ('FOLLOWERS','ENGAGED','REACHED')),
  dimension     text not null,          -- age_gender | city | country | gender | age
  breakdown     jsonb not null,         -- {"18-24|F": 120, ...}
  raw           jsonb default '{}'::jsonb,
  is_final      boolean not null default false,
  collected_at  timestamptz not null default now(),
  unique (asset_id, snapshot_date, audience_type, dimension)
);
drop trigger if exists trg_aud_guard_upd on xp_audience_snapshots;
create trigger trg_aud_guard_upd before update on xp_audience_snapshots
  for each row execute function fn_guard_final_snapshot();

-- ---------------------------------------------------------------------
-- 8. Comments
-- ---------------------------------------------------------------------
create table if not exists xp_post_comments (
  id                 bigint generated always as identity primary key,
  client_id          uuid not null references xp_clients(id) on delete cascade,
  asset_id           uuid not null references xp_meta_assets(id) on delete cascade,
  meta_post_id       text not null,
  comment_id         text not null unique,
  parent_comment_id  text,
  author_id          text,
  author_name        text,
  message            text,
  like_count         int,
  is_hidden          boolean default false,
  created_time       timestamptz,
  sentiment          text,               -- filled later by AI: POSITIVE/NEUTRAL/NEGATIVE
  raw                jsonb default '{}'::jsonb,
  first_seen_at      timestamptz not null default now(),
  last_seen_at       timestamptz not null default now(),
  is_deleted         boolean not null default false
);
create index if not exists xp_comments_post_idx on xp_post_comments(asset_id, meta_post_id);

-- ---------------------------------------------------------------------
-- 9. Sync audit log
-- ---------------------------------------------------------------------
create table if not exists xp_sync_runs (
  id                 bigint generated always as identity primary key,
  client_id          uuid references xp_clients(id) on delete set null,
  asset_id           uuid references xp_meta_assets(id) on delete set null,
  run_type           text not null check (run_type in ('CRON','MANUAL','BACKFILL','DISCOVERY','FINALIZE')),
  range_start        date,
  range_end          date,
  status             text not null default 'RUNNING' check (status in ('RUNNING','OK','PARTIAL','FAILED')),
  posts_seen         int default 0,
  snapshots_written  int default 0,
  api_calls          int default 0,
  errors             jsonb default '[]'::jsonb,
  triggered_by       text,
  started_at         timestamptz not null default now(),
  finished_at        timestamptz
);
create index if not exists xp_sync_runs_client_idx on xp_sync_runs(client_id, started_at desc);

-- ---------------------------------------------------------------------
-- 10. Metric catalog — what we pull, per platform/level. Verified against live API in Phase 2.
-- ---------------------------------------------------------------------
create table if not exists xp_metric_catalog (
  id             serial primary key,
  platform       text not null check (platform in ('FB','IG')),
  level          text not null check (level in ('ACCOUNT','POST','STORY','REEL','AUDIENCE')),
  metric_name    text not null,
  period         text,                 -- day | lifetime | total_over_range
  mapped_column  text,                 -- column in the snapshot table
  description    text,
  is_active      boolean not null default true,
  is_verified    boolean not null default false,
  last_verified_at timestamptz,
  deprecated_note text,
  unique (platform, level, metric_name)
);

insert into xp_metric_catalog (platform, level, metric_name, period, mapped_column, description) values
 -- Facebook page (day)
 ('FB','ACCOUNT','page_impressions','day','impressions','Total impressions of any page content'),
 ('FB','ACCOUNT','page_impressions_unique','day','reach','Unique people who saw page content'),
 ('FB','ACCOUNT','page_views_total','day','page_views','Page profile views'),
 ('FB','ACCOUNT','page_post_engagements','day','engagements','Engagements on posts'),
 ('FB','ACCOUNT','page_video_views','day','video_views','Video views'),
 ('FB','ACCOUNT','page_fan_adds','day','fan_adds','New page likes'),
 ('FB','ACCOUNT','page_fan_removes','day','fan_removes','Page unlikes'),
 ('FB','ACCOUNT','page_daily_follows','day','follows_day','New follows'),
 ('FB','ACCOUNT','page_daily_unfollows','day','unfollows_day','Unfollows'),
 ('FB','ACCOUNT','page_actions_post_reactions_total','day','reactions','Reactions by type'),
 -- Facebook post (lifetime)
 ('FB','POST','post_impressions','lifetime','impressions','Post impressions'),
 ('FB','POST','post_impressions_unique','lifetime','reach','Post reach'),
 ('FB','POST','post_engaged_users','lifetime','engaged_users','Unique people who engaged'),
 ('FB','POST','post_clicks','lifetime','clicks','Clicks anywhere on post'),
 ('FB','POST','post_reactions_by_type_total','lifetime','reactions','Reactions breakdown'),
 ('FB','POST','post_video_views','lifetime','video_views','Video views (3s)'),
 ('FB','POST','post_video_avg_time_watched','lifetime','avg_watch_time_ms','Average watch time'),
 -- Instagram account (day)
 ('IG','ACCOUNT','reach','day','reach','Accounts reached'),
 ('IG','ACCOUNT','views','day','views','Views (replaces impressions)'),
 ('IG','ACCOUNT','profile_views','day','profile_views','Profile visits'),
 ('IG','ACCOUNT','accounts_engaged','day','accounts_engaged','Accounts that engaged'),
 ('IG','ACCOUNT','total_interactions','day','engagements','Likes+comments+shares+saves+replies'),
 ('IG','ACCOUNT','likes','day','likes','Likes'),
 ('IG','ACCOUNT','comments','day','comments','Comments'),
 ('IG','ACCOUNT','shares','day','shares','Shares'),
 ('IG','ACCOUNT','saves','day','saves','Saves'),
 ('IG','ACCOUNT','replies','day','replies','Story replies'),
 ('IG','ACCOUNT','profile_links_taps','day','profile_link_taps','Taps on profile links'),
 ('IG','ACCOUNT','website_clicks','day','website_clicks','Website taps'),
 ('IG','ACCOUNT','follows_and_unfollows','day','follows_day','Follows / unfollows'),
 ('IG','ACCOUNT','follower_count','day','followers_total','Daily follower count (30-day lookback)'),
 ('IG','ACCOUNT','online_followers','lifetime','online_followers','Followers online by hour'),
 -- Instagram media (lifetime)
 ('IG','POST','views','lifetime','views','Views'),
 ('IG','POST','reach','lifetime','reach','Reach'),
 ('IG','POST','likes','lifetime','likes','Likes'),
 ('IG','POST','comments','lifetime','comments','Comments'),
 ('IG','POST','shares','lifetime','shares','Shares'),
 ('IG','POST','saved','lifetime','saves','Saves'),
 ('IG','POST','total_interactions','lifetime','total_interactions','Total interactions'),
 ('IG','POST','profile_visits','lifetime','profile_visits','Profile visits from post'),
 ('IG','POST','follows','lifetime','follows','Follows from post'),
 ('IG','REEL','ig_reels_avg_watch_time','lifetime','avg_watch_time_ms','Reel average watch time'),
 ('IG','REEL','ig_reels_video_view_total','lifetime','plays','Reel plays'),
 -- Instagram stories (lifetime, 24h)
 ('IG','STORY','views','lifetime','views','Story views'),
 ('IG','STORY','reach','lifetime','reach','Story reach'),
 ('IG','STORY','replies','lifetime','extra.replies','Story replies'),
 ('IG','STORY','navigation','lifetime','extra.navigation','Taps forward/back, exits'),
 ('IG','STORY','shares','lifetime','shares','Story shares'),
 ('IG','STORY','follows','lifetime','follows','Follows from story'),
 ('IG','STORY','profile_visits','lifetime','profile_visits','Profile visits from story'),
 -- Audience
 ('IG','AUDIENCE','follower_demographics','lifetime','breakdown','age/gender/city/country'),
 ('IG','AUDIENCE','engaged_audience_demographics','lifetime','breakdown','age/gender/city/country'),
 ('FB','AUDIENCE','page_fans_country','lifetime','breakdown','Fans by country'),
 ('FB','AUDIENCE','page_fans_city','lifetime','breakdown','Fans by city'),
 ('FB','AUDIENCE','page_fans_gender_age','lifetime','breakdown','Fans by gender/age')
on conflict (platform, level, metric_name) do nothing;

-- ---------------------------------------------------------------------
-- 11. AI conversations
-- ---------------------------------------------------------------------
create table if not exists xp_ai_conversations (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references xp_clients(id) on delete cascade,
  title       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create table if not exists xp_ai_messages (
  id               bigint generated always as identity primary key,
  conversation_id  uuid not null references xp_ai_conversations(id) on delete cascade,
  role             text not null check (role in ('user','assistant','tool')),
  content          text,
  tool_calls       jsonb,               -- which SQL functions were called with what args
  tool_results     jsonb,               -- the numbers the model was given
  model            text,
  tokens_in        int,
  tokens_out       int,
  created_at       timestamptz not null default now()
);
create index if not exists xp_ai_messages_conv_idx on xp_ai_messages(conversation_id, created_at);

-- ---------------------------------------------------------------------
-- 12. Reports
-- ---------------------------------------------------------------------
create table if not exists xp_generated_reports (
  id           uuid primary key default gen_random_uuid(),
  page_id      uuid,                    -- v1 (was client id)
  report_title text,
  report_type  text,
  date_range   text,
  pdf_url      text,                    -- v1 base64 data URL — deprecated
  created_at   timestamptz not null default now()
);
alter table xp_generated_reports add column if not exists client_id     uuid references xp_clients(id) on delete cascade;
alter table xp_generated_reports add column if not exists period_start  date;
alter table xp_generated_reports add column if not exists period_end    date;
alter table xp_generated_reports add column if not exists storage_path  text;   -- Supabase Storage object path
alter table xp_generated_reports add column if not exists size_bytes    bigint;
alter table xp_generated_reports add column if not exists generated_by  text;   -- 'client' | 'admin'
alter table xp_generated_reports add column if not exists summary       jsonb;  -- headline numbers used
update xp_generated_reports set client_id = page_id where client_id is null and page_id is not null;
create index if not exists xp_reports_client_idx on xp_generated_reports(client_id, created_at desc);

-- ---------------------------------------------------------------------
-- 13. System config (existing) — add fields, do not overwrite values
-- ---------------------------------------------------------------------
create table if not exists xp_system_config (
  id                     int primary key,
  meta_api_version       text,
  fb_posts_ep            text,
  fb_post_views_metric   text,
  fb_page_views_metric   text,
  fb_engage_metric       text,
  ig_media_ep            text,
  ig_impressions_metric  text,
  ig_carousel_metric     text,
  ig_video_metric        text,
  ig_profile_views_metric text,
  updated_at             timestamptz
);
alter table xp_system_config add column if not exists batch_size          int default 50;
alter table xp_system_config add column if not exists request_delay_ms    int default 150;
alter table xp_system_config add column if not exists account_backfill_days int default 90;
alter table xp_system_config add column if not exists demographics_every_days int default 7;
alter table xp_system_config add column if not exists alert_webhook_url   text;
insert into xp_system_config (id, meta_api_version, updated_at) values (1, 'v19.0', now())
on conflict (id) do nothing;
-- NOTE: meta_api_version must be bumped in Phase 2 after verifying the current Graph API version.

-- ---------------------------------------------------------------------
-- 14. MIGRATION from v1 data
-- ---------------------------------------------------------------------

-- 14a. Assets from xp_clients
insert into xp_meta_assets (client_id, platform, asset_id, name, access_token_enc, token_expires_at, status, insights_timezone, last_synced_at)
select c.id, 'FB', c.meta_page_id, c.client_name, c.meta_access_token, c.token_expires_at,
       case when c.token_status = 'EXPIRED' then 'EXPIRED' else 'ACTIVE' end,
       'America/Los_Angeles', c.last_synced_at
from xp_clients c
where c.meta_page_id is not null
on conflict (platform, asset_id) do nothing;

insert into xp_meta_assets (client_id, platform, asset_id, name, linked_asset_id, status, insights_timezone, last_synced_at)
select c.id, 'IG', c.ig_account_id, c.client_name || ' (Instagram)', fb.id,
       case when c.token_status = 'EXPIRED' then 'EXPIRED' else 'ACTIVE' end,
       'UTC', c.last_synced_at
from xp_clients c
join xp_meta_assets fb on fb.platform = 'FB' and fb.asset_id = c.meta_page_id
where c.ig_account_id is not null
on conflict (platform, asset_id) do nothing;

-- 14b. Posts
do $$
begin
  if to_regclass('public.legacy_meta_posts') is not null then
    insert into xp_meta_posts (client_id, asset_id, platform, meta_post_id, caption, publish_date, first_seen_at, last_seen_at)
    select l.client_id, a.id, l.platform, l.meta_post_id, l.caption, l.publish_date, now(), now()
    from legacy_meta_posts l
    join xp_meta_assets a on a.client_id = l.client_id and a.platform = l.platform
    on conflict (asset_id, meta_post_id) do nothing;
  end if;
end $$;

-- 14c. Post snapshots
--   (i)  latest known lifetime values -> one MIGRATED snapshot dated on the client's last sync day
--   (ii) legacy deltas -> RECONSTRUCTED absolutes:  abs(D) = latest - sum(deltas after D)
do $$
begin
  if to_regclass('public.legacy_meta_posts') is not null then
    insert into xp_post_metric_snapshots
      (client_id, asset_id, meta_post_id, platform, snapshot_date,
       impressions, reach, views, likes, comments, shares, video_views, source, is_final, collected_at)
    select l.client_id, a.id, l.meta_post_id, l.platform,
           coalesce((c.last_synced_at at time zone c.timezone)::date, fn_today(c.timezone)),
           l.views, l.reach, l.views, l.likes, l.comments, l.shares, l.video_views,
           'MIGRATED',
           coalesce((c.last_synced_at at time zone c.timezone)::date, fn_today(c.timezone)) < fn_today(c.timezone),
           coalesce(c.last_synced_at, now())
    from legacy_meta_posts l
    join xp_clients c     on c.id = l.client_id
    join xp_meta_assets a on a.client_id = l.client_id and a.platform = l.platform
    on conflict (asset_id, meta_post_id, snapshot_date) do nothing;
  end if;

  if to_regclass('public.legacy_meta_post_snapshots') is not null
     and to_regclass('public.legacy_meta_posts') is not null then
    with latest as (
      select l.client_id, l.meta_post_id, l.platform,
             coalesce(l.views,0) v, coalesce(l.reach,0) r, coalesce(l.likes,0) lk, coalesce(l.comments,0) cm
      from legacy_meta_posts l
    ),
    ordered as (
      select s.client_id, s.meta_post_id, s.platform, s.snapshot_date,
             coalesce(sum(s.views_gained)    over w, 0) as after_views,
             coalesce(sum(s.reach_gained)    over w, 0) as after_reach,
             coalesce(sum(s.likes_gained)    over w, 0) as after_likes,
             coalesce(sum(s.comments_gained) over w, 0) as after_comments
      from legacy_meta_post_snapshots s
      window w as (partition by s.client_id, s.meta_post_id order by s.snapshot_date desc
                   rows between unbounded preceding and 1 preceding)
    )
    insert into xp_post_metric_snapshots
      (client_id, asset_id, meta_post_id, platform, snapshot_date,
       impressions, reach, views, likes, comments, source, is_final, collected_at)
    select o.client_id, a.id, o.meta_post_id, o.platform, o.snapshot_date,
           greatest(0, lt.v - o.after_views), greatest(0, lt.r - o.after_reach),
           greatest(0, lt.v - o.after_views),
           greatest(0, lt.lk - o.after_likes), greatest(0, lt.cm - o.after_comments),
           'RECONSTRUCTED', true, now()
    from ordered o
    join latest lt     on lt.client_id = o.client_id and lt.meta_post_id = o.meta_post_id
    join xp_clients c     on c.id = o.client_id
    join xp_meta_assets a on a.client_id = o.client_id and a.platform = o.platform
    where o.snapshot_date < fn_today(c.timezone)
    on conflict (asset_id, meta_post_id, snapshot_date) do nothing;
  end if;
end $$;

-- 14d. Account daily metrics -> per-asset rows
do $$
begin
  if to_regclass('public.legacy_meta_daily_metrics') is not null then
    insert into xp_account_metric_snapshots
      (client_id, asset_id, platform, metric_date, followers_total, follows_day,
       page_views, engagements, video_views, source, is_final)
    select m.client_id, a.id, 'FB', m.metric_date,
           nullif(m.fb_total_followers, 0), nullif(m.fb_new_followers, 0),
           m.fb_views, m.fb_engagements, m.fb_video_views,
           'MIGRATED', m.metric_date < fn_today(c.timezone)
    from legacy_meta_daily_metrics m
    join xp_clients c on c.id = m.client_id
    join xp_meta_assets a on a.client_id = m.client_id and a.platform = 'FB'
    on conflict (asset_id, metric_date) do nothing;

    insert into xp_account_metric_snapshots
      (client_id, asset_id, platform, metric_date, followers_total, follows_day,
       profile_views, engagements, source, is_final)
    select m.client_id, a.id, 'IG', m.metric_date,
           nullif(m.ig_total_followers, 0), nullif(m.ig_new_followers, 0),
           m.ig_views, m.ig_engagements,
           'MIGRATED', m.metric_date < fn_today(c.timezone)
    from legacy_meta_daily_metrics m
    join xp_clients c on c.id = m.client_id
    join xp_meta_assets a on a.client_id = m.client_id and a.platform = 'IG'
    on conflict (asset_id, metric_date) do nothing;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 15. Finalization (cron calls nightly and after each sync)
-- ---------------------------------------------------------------------
create or replace function fn_finalize_snapshots() returns table(table_name text, rows_finalized bigint)
language plpgsql as $$
declare n bigint;
begin
  update xp_post_metric_snapshots p set is_final = true
  from xp_clients c
  where p.client_id = c.id and p.is_final = false and p.snapshot_date < fn_today(c.timezone);
  get diagnostics n = row_count;
  table_name := 'xp_post_metric_snapshots'; rows_finalized := n; return next;

  update xp_account_metric_snapshots p set is_final = true
  from xp_clients c
  where p.client_id = c.id and p.is_final = false and p.metric_date < fn_today(c.timezone);
  get diagnostics n = row_count;
  table_name := 'xp_account_metric_snapshots'; rows_finalized := n; return next;

  update xp_audience_snapshots p set is_final = true
  from xp_clients c
  where p.client_id = c.id and p.is_final = false and p.snapshot_date < fn_today(c.timezone);
  get diagnostics n = row_count;
  table_name := 'xp_audience_snapshots'; rows_finalized := n; return next;
end $$;

-- ---------------------------------------------------------------------
-- 16. Views — deltas are DERIVED here
-- ---------------------------------------------------------------------
create or replace view xp_v_post_daily_deltas as
select s.*,
       s.impressions        - lag(s.impressions)        over w as impressions_gained,
       s.reach              - lag(s.reach)              over w as reach_gained,
       s.views              - lag(s.views)              over w as views_gained,
       s.plays              - lag(s.plays)              over w as plays_gained,
       s.likes              - lag(s.likes)              over w as likes_gained,
       s.comments           - lag(s.comments)           over w as comments_gained,
       s.shares             - lag(s.shares)             over w as shares_gained,
       s.saves              - lag(s.saves)              over w as saves_gained,
       s.video_views        - lag(s.video_views)        over w as video_views_gained,
       s.total_interactions - lag(s.total_interactions) over w as interactions_gained,
       lag(s.snapshot_date) over w                               as prev_snapshot_date,
       (lag(s.snapshot_date) over w) is null                     as is_first_observation
from xp_post_metric_snapshots s
window w as (partition by s.asset_id, s.meta_post_id order by s.snapshot_date);

create or replace view xp_v_post_latest as
select distinct on (s.asset_id, s.meta_post_id) s.*
from xp_post_metric_snapshots s
order by s.asset_id, s.meta_post_id, s.snapshot_date desc;

create or replace view xp_v_posts_with_latest as
select p.*,
       l.snapshot_date as latest_snapshot_date,
       l.impressions, l.reach, l.views, l.plays, l.likes, l.comments, l.shares, l.saves,
       l.total_interactions, l.video_views, l.profile_visits, l.follows
from xp_meta_posts p
left join xp_v_post_latest l on l.asset_id = p.asset_id and l.meta_post_id = p.meta_post_id;

create or replace view xp_v_account_daily as
select a.*,
       a.followers_total - lag(a.followers_total) over w as followers_gained_observed,
       lag(a.metric_date) over w                         as prev_metric_date
from xp_account_metric_snapshots a
window w as (partition by a.asset_id order by a.metric_date);

-- Per client per day rollup (what happened on that day)
create or replace view xp_v_client_day_summary as
with post_gains as (
  select client_id, platform, snapshot_date as d,
         sum(coalesce(reach_gained,0))        as post_reach_gained,
         sum(coalesce(impressions_gained,0))  as post_impressions_gained,
         sum(coalesce(views_gained,0))        as post_views_gained,
         sum(coalesce(likes_gained,0))        as likes_gained,
         sum(coalesce(comments_gained,0))     as comments_gained,
         sum(coalesce(shares_gained,0))       as shares_gained,
         sum(coalesce(saves_gained,0))        as saves_gained,
         count(*) filter (where is_first_observation) as posts_first_seen
  from xp_v_post_daily_deltas
  group by client_id, platform, snapshot_date
),
acct as (
  select client_id, platform, metric_date as d,
         sum(followers_total)  as followers_total,
         sum(followers_gained_observed) as followers_gained,
         sum(reach) as account_reach, sum(impressions) as account_impressions,
         sum(views) as account_views, sum(page_views) as page_views, sum(profile_views) as profile_views,
         sum(engagements) as engagements, sum(video_views) as account_video_views,
         sum(follows_day) as follows_day, sum(unfollows_day) as unfollows_day,
         bool_and(is_final) as is_final
  from xp_v_account_daily
  group by client_id, platform, metric_date
),
posts_pub as (
  select client_id, platform, (publish_date at time zone 'UTC')::date as d, count(*) as posts_published
  from xp_meta_posts where not is_story group by 1,2,3
)
select coalesce(pg.client_id, ac.client_id, pp.client_id) as client_id,
       coalesce(pg.platform,  ac.platform,  pp.platform)  as platform,
       coalesce(pg.d, ac.d, pp.d) as day,
       pp.posts_published, pg.posts_first_seen,
       pg.post_reach_gained, pg.post_impressions_gained, pg.post_views_gained,
       pg.likes_gained, pg.comments_gained, pg.shares_gained, pg.saves_gained,
       ac.followers_total, ac.followers_gained, ac.follows_day, ac.unfollows_day,
       ac.account_reach, ac.account_impressions, ac.account_views,
       ac.page_views, ac.profile_views, ac.engagements, ac.account_video_views,
       ac.is_final
from post_gains pg
full join acct ac      on ac.client_id = pg.client_id and ac.platform = pg.platform and ac.d = pg.d
full join posts_pub pp on pp.client_id = coalesce(pg.client_id, ac.client_id)
                      and pp.platform  = coalesce(pg.platform,  ac.platform)
                      and pp.d         = coalesce(pg.d, ac.d);

-- Sync health: missing account-metric days in the last 30 days per asset
create or replace view xp_v_sync_health as
select a.id as asset_id, a.client_id, a.platform, a.name,
       a.last_synced_at,
       (select count(*) from generate_series(current_date - 29, current_date - 1, '1 day') g(d)
         where not exists (select 1 from xp_account_metric_snapshots s where s.asset_id = a.id and s.metric_date = g.d)) as missing_days_30,
       (select array_agg(g.d::text order by g.d) from generate_series(current_date - 29, current_date - 1, '1 day') g(d)
         where not exists (select 1 from xp_account_metric_snapshots s where s.asset_id = a.id and s.metric_date = g.d)) as missing_dates
from xp_meta_assets a
where a.status = 'ACTIVE';

-- ---------------------------------------------------------------------
-- 17. Query functions used by the AI and the PDF (deterministic numbers)
-- ---------------------------------------------------------------------

-- A post's counters as of a date (latest snapshot on or before that date)
create or replace function fn_post_as_of(p_asset uuid, p_post text, p_date date)
returns xp_post_metric_snapshots
language sql stable as $$
  select s.* from xp_post_metric_snapshots s
  where s.asset_id = p_asset and s.meta_post_id = p_post and s.snapshot_date <= p_date
  order by s.snapshot_date desc limit 1
$$;

-- Follower series for a client (per platform)
create or replace function fn_followers_series(p_client uuid, p_start date, p_end date)
returns table(platform text, metric_date date, followers_total bigint, followers_gained bigint, is_final boolean)
language sql stable as $$
  select platform, metric_date, followers_total, followers_gained_observed, is_final
  from xp_v_account_daily
  where client_id = p_client and metric_date between p_start and p_end
  order by platform, metric_date
$$;

-- The main period summary. Everything the chat/PDF should quote comes from here.
create or replace function fn_client_period_summary(p_client uuid, p_start date, p_end date)
returns jsonb
language plpgsql stable as $$
declare
  v_tz    text;
  v_today date;
  v_out   jsonb;
begin
  select timezone into v_tz from xp_clients where id = p_client;
  v_today := fn_today(coalesce(v_tz, 'UTC'));

  with plat as (select unnest(array['IG','FB']) as platform),
  pub as (
    select platform, count(*) as posts_published
    from xp_meta_posts
    where client_id = p_client and not is_story
      and (publish_date at time zone coalesce(v_tz,'UTC'))::date between p_start and p_end
    group by platform
  ),
  gains as (
    select platform,
           sum(coalesce(reach_gained,0))       as reach_gained,
           sum(coalesce(impressions_gained,0)) as impressions_gained,
           sum(coalesce(views_gained,0))       as views_gained,
           sum(coalesce(likes_gained,0))       as likes_gained,
           sum(coalesce(comments_gained,0))    as comments_gained,
           sum(coalesce(shares_gained,0))      as shares_gained,
           sum(coalesce(saves_gained,0))       as saves_gained,
           sum(coalesce(video_views_gained,0)) as video_views_gained
    from xp_v_post_daily_deltas
    where client_id = p_client and snapshot_date between p_start and p_end
    group by platform
  ),
  acct as (
    select platform,
           sum(reach) as account_reach, sum(impressions) as account_impressions, sum(views) as account_views,
           sum(page_views) as page_views, sum(profile_views) as profile_views,
           sum(engagements) as engagements, sum(video_views) as video_views,
           sum(follows_day) as follows, sum(unfollows_day) as unfollows,
           count(*) as days_with_data,
           bool_and(is_final) as all_final
    from xp_account_metric_snapshots
    where client_id = p_client and metric_date between p_start and p_end
    group by platform
  ),
  f_start as (
    select distinct on (platform) platform, followers_total, metric_date
    from xp_account_metric_snapshots
    where client_id = p_client and metric_date <= p_start and followers_total is not null
    order by platform, metric_date desc
  ),
  f_end as (
    select distinct on (platform) platform, followers_total, metric_date
    from xp_account_metric_snapshots
    where client_id = p_client and metric_date <= p_end and followers_total is not null
    order by platform, metric_date desc
  ),
  top_by_gain as (
    select d.platform, d.meta_post_id, sum(coalesce(d.reach_gained,0)) as reach_gained_in_period,
           sum(coalesce(d.likes_gained,0)) as likes_gained_in_period
    from xp_v_post_daily_deltas d
    where d.client_id = p_client and d.snapshot_date between p_start and p_end
    group by d.platform, d.meta_post_id
  ),
  top_posts as (
    select t.platform,
           jsonb_agg(jsonb_build_object(
             'post_id', t.meta_post_id,
             'caption', left(coalesce(p.caption,''), 140),
             'permalink', p.permalink,
             'media_type', p.media_type,
             'publish_date', p.publish_date,
             'reach_gained_in_period', t.reach_gained_in_period,
             'likes_gained_in_period', t.likes_gained_in_period,
             'reach_as_of_end', (fn_post_as_of(p.asset_id, p.meta_post_id, p_end)).reach,
             'likes_as_of_end', (fn_post_as_of(p.asset_id, p.meta_post_id, p_end)).likes
           ) order by t.reach_gained_in_period desc) filter (where rn <= 5) as items
    from (select *, row_number() over (partition by platform order by reach_gained_in_period desc) rn from top_by_gain) t
    join xp_meta_posts p on p.client_id = p_client and p.meta_post_id = t.meta_post_id
    group by t.platform
  ),
  per_platform as (
    select pl.platform,
           jsonb_build_object(
             'posts_published', coalesce(pub.posts_published,0),
             'content', jsonb_build_object(
               'reach_gained', coalesce(g.reach_gained,0),
               'impressions_gained', coalesce(g.impressions_gained,0),
               'views_gained', coalesce(g.views_gained,0),
               'likes_gained', coalesce(g.likes_gained,0),
               'comments_gained', coalesce(g.comments_gained,0),
               'shares_gained', coalesce(g.shares_gained,0),
               'saves_gained', coalesce(g.saves_gained,0),
               'video_views_gained', coalesce(g.video_views_gained,0)),
             'account', jsonb_build_object(
               'reach', a.account_reach, 'impressions', a.account_impressions, 'views', a.account_views,
               'page_views', a.page_views, 'profile_views', a.profile_views,
               'engagements', a.engagements, 'video_views', a.video_views,
               'follows', a.follows, 'unfollows', a.unfollows,
               'days_with_data', coalesce(a.days_with_data,0),
               'days_in_period', (p_end - p_start + 1)),
             'followers', jsonb_build_object(
               'start', fs.followers_total, 'start_observed_on', fs.metric_date,
               'end',   fe.followers_total, 'end_observed_on',   fe.metric_date,
               'net',   case when fs.followers_total is not null and fe.followers_total is not null
                             then fe.followers_total - fs.followers_total end),
             'top_posts', coalesce(tp.items, '[]'::jsonb)
           ) as body
    from plat pl
    left join pub   on pub.platform = pl.platform
    left join gains g on g.platform = pl.platform
    left join acct  a on a.platform = pl.platform
    left join f_start fs on fs.platform = pl.platform
    left join f_end   fe on fe.platform = pl.platform
    left join top_posts tp on tp.platform = pl.platform
  )
  select jsonb_build_object(
    'client_id', p_client,
    'period', jsonb_build_object('start', p_start, 'end', p_end, 'timezone', v_tz),
    'is_running_period', p_end >= v_today,
    'data_available_from', (select min(metric_date) from xp_account_metric_snapshots where client_id = p_client),
    'platforms', jsonb_object_agg(platform, body),
    'generated_at', now()
  ) into v_out
  from per_platform;

  return v_out;
end $$;

-- ---------------------------------------------------------------------
-- 18. Security — RLS on everything. Server uses service_role (bypasses RLS).
--     No policies are created for anon: anon gets nothing.
--     If you later use Supabase Auth for xp_clients, add policies like:
--       create policy client_read on xp_meta_posts for select
--         using (client_id = (auth.jwt() ->> 'client_id')::uuid);
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  for t in select unnest(array[
    'xp_clients','xp_meta_connections','xp_meta_assets','xp_meta_posts','xp_post_metric_snapshots',
    'xp_account_metric_snapshots','xp_audience_snapshots','xp_post_comments','xp_sync_runs',
    'xp_metric_catalog','xp_ai_conversations','xp_ai_messages','xp_generated_reports','xp_system_config'])
  loop
    execute format('alter table %I enable row level security', t);
  end loop;
  for t in select table_name from information_schema.tables
           where table_schema='public' and table_name like 'legacy_%'
  loop
    execute format('alter table %I enable row level security', t);
  end loop;
  if to_regclass('public.api_configurations') is not null then
    alter table api_configurations enable row level security;
  end if;
end $$;

commit;

-- =====================================================================
-- VERIFICATION (run after commit)
-- =====================================================================
-- select 'xp_clients' t, count(*) from xp_clients
-- union all select 'xp_meta_assets', count(*) from xp_meta_assets
-- union all select 'xp_meta_posts', count(*) from xp_meta_posts
-- union all select 'legacy_meta_posts', count(*) from legacy_meta_posts
-- union all select 'xp_post_metric_snapshots', count(*) from xp_post_metric_snapshots
-- union all select 'legacy_meta_post_snapshots', count(*) from legacy_meta_post_snapshots
-- union all select 'xp_account_metric_snapshots', count(*) from xp_account_metric_snapshots
-- union all select 'legacy_meta_daily_metrics', count(*) from legacy_meta_daily_metrics;
--
-- select source, count(*) from xp_post_metric_snapshots group by 1;
-- select * from xp_v_sync_health;
-- select fn_client_period_summary((select id from xp_clients limit 1), '2026-08-01', '2026-08-31');
-- select * from fn_finalize_snapshots();
--
-- Immutability check (should ERROR):
-- update xp_post_metric_snapshots set reach = 0
--   where id = (select id from xp_post_metric_snapshots where is_final limit 1);
--
-- Cleanup after 30 days of confidence:
-- drop table legacy_meta_post_snapshots, legacy_meta_daily_metrics, legacy_meta_posts, api_configurations;


-- ===================================================================
-- 0002_finalize_window.sql
-- ===================================================================
-- 0002: account rows finalize one day later so Facebook's Pacific-time day has fully closed
--       (Dhaka is UTC+6; a Pacific day D ends at 14:00 Dhaka on D+1). Post rows still finalize at day end.
create or replace function fn_finalize_snapshots() returns table(table_name text, rows_finalized bigint)
language plpgsql as $$
declare n bigint;
begin
  update xp_post_metric_snapshots p set is_final = true
  from xp_clients c where p.client_id = c.id and p.is_final = false and p.snapshot_date < fn_today(c.timezone);
  get diagnostics n = row_count; table_name := 'xp_post_metric_snapshots'; rows_finalized := n; return next;

  update xp_account_metric_snapshots p set is_final = true
  from xp_clients c where p.client_id = c.id and p.is_final = false and p.metric_date < fn_today(c.timezone) - 1;
  get diagnostics n = row_count; table_name := 'xp_account_metric_snapshots'; rows_finalized := n; return next;

  update xp_audience_snapshots p set is_final = true
  from xp_clients c where p.client_id = c.id and p.is_final = false and p.snapshot_date < fn_today(c.timezone);
  get diagnostics n = row_count; table_name := 'xp_audience_snapshots'; rows_finalized := n; return next;
end $$;

-- Bump the API version now that v19.0 is retired (expired 2026-05-21)
update xp_system_config set meta_api_version = 'v26.0', updated_at = now() where id = 1;


-- ===================================================================
-- 0003_drop_plaintext_passwords.sql
-- ===================================================================
-- Run ONLY after every active client has logged in at least once since v2 (login re-hashes on success),
-- or after resetting credentials from the admin. Any remaining plaintext password is replaced with an
-- unusable value so the account must be reset from the admin — plaintext never survives.

select id, username, 'PLAINTEXT — will be locked' as note from xp_clients where password is not null and position(':' in password) = 0;
update xp_clients set password = 'locked:' || encode(gen_random_bytes(16), 'hex')
 where password is not null and position(':' in password) = 0;


-- ===================================================================
-- 0004_honest_coverage.sql
-- ===================================================================
-- migrations_0004_honest_coverage.sql
-- Idempotent. Safe to re-run. No data is modified — this only replaces a read function
-- and adds one view.
--
-- WHY
-- ---
-- `fn_client_period_summary` wrapped every content metric in `coalesce(..., 0)`.
-- That means "we have no observations for this period" and "we observed the period and
-- nothing happened" both come back as 0. The August report therefore printed
-- "0 CONTENT REACH GAINED / 0 LIKES / 0 COMMENTS" for a month where 30 posts were
-- published — which is not a small cosmetic issue, it is a false statement to a client.
--
-- It is also unfixable by syncing harder. Meta does not expose per-post daily history:
-- /insights returns lifetime-to-date counters *as of now*. Per-post daily gains can only
-- ever exist for days on which we ourselves took a snapshot. For any period before the
-- first snapshot the honest answer is "not tracked", permanently.
--
-- Account-level metrics are different: FB page insights backfill ~2 years, which is why
-- page reach and page views for August are real numbers while post metrics are not.
--
-- AFTER THIS MIGRATION
-- --------------------
--   content.* is NULL when no post snapshot exists in the period  → UI prints "not tracked"
--   content.* is 0    when snapshots exist and the gain really was zero
--   every platform carries coverage counters so the UI/AI can explain itself
--   plan objective #3 (a closed day always returns the same answer) is unaffected

-- ---------------------------------------------------------------------
-- 1. Coverage view — "since when do we actually have data, and for what"
-- ---------------------------------------------------------------------
create or replace view xp_v_data_coverage as
select
  a.client_id,
  a.id                                             as asset_id,
  a.platform,
  a.name,
  a.status,
  a.first_synced_at,
  a.last_synced_at,
  a.last_full_backfill_at,
  (select min(s.metric_date)   from xp_account_metric_snapshots s where s.asset_id = a.id) as account_data_from,
  (select max(s.metric_date)   from xp_account_metric_snapshots s where s.asset_id = a.id) as account_data_to,
  (select count(*)             from xp_account_metric_snapshots s where s.asset_id = a.id) as account_days,
  (select min(s.snapshot_date) from xp_post_metric_snapshots    s where s.asset_id = a.id) as post_data_from,
  (select max(s.snapshot_date) from xp_post_metric_snapshots    s where s.asset_id = a.id) as post_data_to,
  (select count(distinct s.snapshot_date) from xp_post_metric_snapshots s where s.asset_id = a.id) as post_days,
  (select count(*)             from xp_meta_posts p where p.asset_id = a.id and not p.is_story and not p.is_deleted) as posts_known
from xp_meta_assets a;

comment on view xp_v_data_coverage is
  'Per-asset data horizons. post_data_from is the earliest day we ever snapshotted a post; '
  'nothing before it can ever have per-post daily gains, because Meta does not serve that history.';

-- ---------------------------------------------------------------------
-- 2. Honest period summary
-- ---------------------------------------------------------------------
create or replace function fn_client_period_summary(p_client uuid, p_start date, p_end date)
returns jsonb
language plpgsql stable as $$
declare
  v_tz    text;
  v_today date;
  v_out   jsonb;
begin
  select timezone into v_tz from xp_clients where id = p_client;
  v_today := fn_today(coalesce(v_tz, 'UTC'));

  with plat as (select unnest(array['IG','FB']) as platform),
  pub as (
    select platform, count(*) as posts_published
    from xp_meta_posts
    where client_id = p_client and not is_story
      and (publish_date at time zone coalesce(v_tz,'UTC'))::date between p_start and p_end
    group by platform
  ),
  -- How much post-level observation do we actually have inside the window?
  -- A gain needs TWO consecutive snapshots, so one snapshot day yields no delta.
  cover as (
    select platform,
           count(distinct snapshot_date)                      as post_days_in_period,
           count(distinct meta_post_id)                       as posts_observed,
           min(snapshot_date)                                 as first_snapshot_in_period
    from xp_post_metric_snapshots
    where client_id = p_client and snapshot_date between p_start and p_end
    group by platform
  ),
  horizon as (
    select platform, min(snapshot_date) as post_data_from
    from xp_post_metric_snapshots where client_id = p_client group by platform
  ),
  gains as (
    select platform,
           sum(coalesce(reach_gained,0))       as reach_gained,
           sum(coalesce(impressions_gained,0)) as impressions_gained,
           sum(coalesce(views_gained,0))       as views_gained,
           sum(coalesce(likes_gained,0))       as likes_gained,
           sum(coalesce(comments_gained,0))    as comments_gained,
           sum(coalesce(shares_gained,0))      as shares_gained,
           sum(coalesce(saves_gained,0))       as saves_gained,
           sum(coalesce(video_views_gained,0)) as video_views_gained
    from xp_v_post_daily_deltas
    where client_id = p_client and snapshot_date between p_start and p_end
    group by platform
  ),
  acct as (
    select platform,
           sum(reach) as account_reach, sum(impressions) as account_impressions, sum(views) as account_views,
           sum(page_views) as page_views, sum(profile_views) as profile_views,
           sum(engagements) as engagements, sum(video_views) as video_views,
           sum(follows_day) as follows, sum(unfollows_day) as unfollows,
           count(*) as days_with_data,
           bool_and(is_final) as all_final
    from xp_account_metric_snapshots
    where client_id = p_client and metric_date between p_start and p_end
    group by platform
  ),
  f_start as (
    select distinct on (platform) platform, followers_total, metric_date
    from xp_account_metric_snapshots
    where client_id = p_client and metric_date <= p_start and followers_total is not null
    order by platform, metric_date desc
  ),
  f_end as (
    select distinct on (platform) platform, followers_total, metric_date
    from xp_account_metric_snapshots
    where client_id = p_client and metric_date <= p_end and followers_total is not null
    order by platform, metric_date desc
  ),
  top_by_gain as (
    select d.platform, d.meta_post_id, sum(coalesce(d.reach_gained,0)) as reach_gained_in_period,
           sum(coalesce(d.likes_gained,0)) as likes_gained_in_period
    from xp_v_post_daily_deltas d
    where d.client_id = p_client and d.snapshot_date between p_start and p_end
    group by d.platform, d.meta_post_id
  ),
  top_posts as (
    select t.platform,
           jsonb_agg(jsonb_build_object(
             'post_id', t.meta_post_id,
             'caption', left(coalesce(p.caption,''), 140),
             'permalink', p.permalink,
             'media_type', p.media_type,
             'publish_date', p.publish_date,
             'reach_gained_in_period', t.reach_gained_in_period,
             'likes_gained_in_period', t.likes_gained_in_period,
             'reach_as_of_end', (fn_post_as_of(p.asset_id, p.meta_post_id, p_end)).reach,
             'likes_as_of_end', (fn_post_as_of(p.asset_id, p.meta_post_id, p_end)).likes
           ) order by t.reach_gained_in_period desc) filter (where rn <= 5) as items
    from (select *, row_number() over (partition by platform order by reach_gained_in_period desc) rn from top_by_gain) t
    join xp_meta_posts p on p.client_id = p_client and p.meta_post_id = t.meta_post_id
    group by t.platform
  ),
  per_platform as (
    select pl.platform,
           jsonb_build_object(
             'posts_published', coalesce(pub.posts_published,0),

             -- THE FIX: a metric is only a number when we observed enough days to derive one.
             -- < 2 snapshot days in the window ⇒ no delta is derivable ⇒ null, never 0.
             'content', case when coalesce(cv.post_days_in_period,0) < 2 then
               jsonb_build_object(
                 'reach_gained', null, 'impressions_gained', null, 'views_gained', null,
                 'likes_gained', null, 'comments_gained', null, 'shares_gained', null,
                 'saves_gained', null, 'video_views_gained', null,
                 'tracked', false,
                 'reason', case
                   when h.post_data_from is null
                     then 'No post snapshots have ever been taken for this platform.'
                   when h.post_data_from > p_end
                     then 'Post tracking began on ' || h.post_data_from || ', after this period ended.'
                   when coalesce(cv.post_days_in_period,0) = 0
                     then 'No post snapshots fall inside this period; tracking began on ' || h.post_data_from || '.'
                   else 'Only one snapshot day falls inside this period, so no day-over-day gain can be derived.'
                 end)
             else
               jsonb_build_object(
                 'reach_gained', coalesce(g.reach_gained,0),
                 'impressions_gained', coalesce(g.impressions_gained,0),
                 'views_gained', coalesce(g.views_gained,0),
                 'likes_gained', coalesce(g.likes_gained,0),
                 'comments_gained', coalesce(g.comments_gained,0),
                 'shares_gained', coalesce(g.shares_gained,0),
                 'saves_gained', coalesce(g.saves_gained,0),
                 'video_views_gained', coalesce(g.video_views_gained,0),
                 'tracked', true, 'reason', null)
             end,

             'coverage', jsonb_build_object(
               'post_days_in_period', coalesce(cv.post_days_in_period,0),
               'posts_observed',      coalesce(cv.posts_observed,0),
               'post_data_from',      h.post_data_from,
               'account_days_in_period', coalesce(a.days_with_data,0),
               'days_in_period',      (p_end - p_start + 1),
               'account_complete',    coalesce(a.days_with_data,0) >= (p_end - p_start + 1)),

             'account', jsonb_build_object(
               'reach', a.account_reach, 'impressions', a.account_impressions, 'views', a.account_views,
               'page_views', a.page_views, 'profile_views', a.profile_views,
               'engagements', a.engagements, 'video_views', a.video_views,
               'follows', a.follows, 'unfollows', a.unfollows,
               'days_with_data', coalesce(a.days_with_data,0),
               'days_in_period', (p_end - p_start + 1)),

             'followers', jsonb_build_object(
               'start', fs.followers_total, 'start_observed_on', fs.metric_date,
               'end',   fe.followers_total, 'end_observed_on',   fe.metric_date,
               'net',   case when fs.followers_total is not null and fe.followers_total is not null
                             then fe.followers_total - fs.followers_total end),

             'top_posts', coalesce(tp.items, '[]'::jsonb)
           ) as body
    from plat pl
    left join pub   on pub.platform = pl.platform
    left join cover cv on cv.platform = pl.platform
    left join horizon h on h.platform = pl.platform
    left join gains g on g.platform = pl.platform
    left join acct  a on a.platform = pl.platform
    left join f_start fs on fs.platform = pl.platform
    left join f_end   fe on fe.platform = pl.platform
    left join top_posts tp on tp.platform = pl.platform
  )
  select jsonb_build_object(
    'client_id', p_client,
    'period', jsonb_build_object('start', p_start, 'end', p_end, 'timezone', v_tz),
    'is_running_period', p_end >= v_today,
    'data_available_from',         (select min(metric_date)   from xp_account_metric_snapshots where client_id = p_client),
    'account_data_available_from', (select min(metric_date)   from xp_account_metric_snapshots where client_id = p_client),
    'post_data_available_from',    (select min(snapshot_date) from xp_post_metric_snapshots    where client_id = p_client),
    'platforms', jsonb_object_agg(platform, body),
    'generated_at', now()
  ) into v_out
  from per_platform;

  return v_out;
end $$;

comment on function fn_client_period_summary(uuid, date, date) is
  'Period rollup. content.* is null (not 0) when fewer than two post-snapshot days fall in the '
  'window, because a day-over-day gain cannot be derived from them. content.reason explains why.';

-- ---------------------------------------------------------------------
-- 3. Verification
-- ---------------------------------------------------------------------
-- select * from xp_v_data_coverage;
--
-- Last month (should show content.tracked=false until a full month has been snapshotted):
-- select jsonb_pretty(fn_client_period_summary(
--   (select id from xp_clients limit 1),
--   (date_trunc('month', current_date) - interval '1 month')::date,
--   (date_trunc('month', current_date) - interval '1 day')::date));
--
-- Today (account data only, post gains appear from the second snapshot day onward):
-- select jsonb_pretty(fn_client_period_summary((select id from xp_clients limit 1), current_date, current_date));


-- ===================================================================
-- 0005_follower_truth.sql
-- ===================================================================
-- migrations_0005_follower_truth.sql
-- Idempotent. Safe to re-run. Run AFTER 0001, 0002 and 0004.
--
-- STAGE A of the map: "make the numbers true".
--
-- Three separate defects, one migration:
--
--   1. IG follower totals are not totals.
--      `follower_count` in the IG day series is the number of NEW followers that day. v2.1
--      mapped it into `followers_total`, so the follower chart plotted 3, 7, 2 … instead of
--      12,431, and `followers.net` in the period summary was the difference between two daily
--      gains — a number with no meaning. Meta does not serve historical follower totals at all:
--      the only absolute reading available is today's profile field. This migration moves the
--      mis-stored values into a new `followers_gained_day` column and derives historical totals
--      at READ time (xp_v_account_daily.followers_total_est) rather than writing guesses into
--      frozen rows.
--
--   2. Migrated v1 rows are frozen, so real data can never replace them.
--      0001 imported v1's daily metrics with is_final = true for any past date. sync.js skips
--      every finalized row, so a full FB backfill of August silently wrote nothing and the
--      August report kept showing v1's approximations. Those rows are archived and unfrozen
--      here so the backfill can overwrite them with real Graph API values. Days Meta cannot
--      serve keep the migrated value and stay labelled MIGRATED.
--
--   3. Reconstructed per-post history is indistinguishable from observed history.
--      0001 rebuilt absolutes from v1's (already corrupt) deltas. Those rows make
--      xp_v_post_daily_deltas emit gains that were never observed and make xp_v_data_coverage claim
--      post tracking started months ago. They are kept — they are the only record of v1 — but
--      xp_v_post_daily_deltas now marks them, and every consumer filters on is_trusted.
--
-- Nothing is deleted. Overrides of the immutability trigger are logged in `xp_data_repairs`.

-- ---------------------------------------------------------------------
-- 0. Audit table for every deliberate override of the immutability guard
-- ---------------------------------------------------------------------
create table if not exists xp_data_repairs (
  id            bigint generated always as identity primary key,
  migration     text        not null,
  target_table  text        not null,
  action        text        not null,
  rows_affected bigint      not null default 0,
  detail        jsonb       not null default '{}'::jsonb,
  ran_at        timestamptz not null default now()
);

comment on table xp_data_repairs is
  'Append-only log of every migration that rewrote finalized snapshot rows. Objective #3 says a '
  'closed day never changes; when it must, it is written down here with a reason.';

-- ---------------------------------------------------------------------
-- 1. New column: the day's follower gain, as reported by the API
-- ---------------------------------------------------------------------
alter table xp_account_metric_snapshots
  add column if not exists followers_gained_day bigint;

comment on column xp_account_metric_snapshots.followers_gained_day is
  'New followers reported for this day (IG follower_count). A GAIN, not a total. May be gross '
  'adds rather than net; prefer follows_day - unfollows_day when both are present.';

comment on column xp_account_metric_snapshots.followers_total is
  'Absolute follower count as observed on this date. FB: page_follows (real daily history). '
  'IG: only observable for today, from the profile object — null for past days, estimated at '
  'read time by xp_v_account_daily.followers_total_est.';

-- ---------------------------------------------------------------------
-- 2. Repair: move mis-mapped IG follower_count out of followers_total
-- ---------------------------------------------------------------------
-- The original metric map is preserved in raw->'flat', so the mis-mapping can be identified
-- exactly rather than guessed at: a row is affected iff followers_total equals the
-- follower_count the API returned for that day.
do $$
declare n bigint;
begin
  perform set_config('app.allow_snapshot_rewrite', 'on', true);

  update xp_account_metric_snapshots s
     set followers_gained_day = coalesce(s.followers_gained_day, (s.raw->'flat'->>'follower_count')::bigint),
         followers_total      = null
   where s.platform = 'IG'
     and s.followers_total is not null
     and s.raw ? 'flat'
     and (s.raw->'flat'->>'follower_count') ~ '^[0-9]+$'
     and s.followers_total = (s.raw->'flat'->>'follower_count')::bigint;

  get diagnostics n = row_count;
  insert into xp_data_repairs (migration, target_table, action, rows_affected, detail)
  values ('0005', 'xp_account_metric_snapshots', 'ig_follower_count_unmapped', n,
          jsonb_build_object('note', 'followers_total held a daily gain; moved to followers_gained_day'));
end $$;

-- ---------------------------------------------------------------------
-- 3. Repair: unfreeze migrated/reconstructed ACCOUNT rows so the backfill can land
-- ---------------------------------------------------------------------
-- Archived first. The archive is a plain table with no triggers, so it keeps v1's version of
-- history verbatim even after the backfill overwrites the live rows.
create table if not exists archive_account_snapshots_v1 (
  archived_at timestamptz not null default now(),
  row_data    jsonb       not null
);

do $$
declare n bigint;
begin
  insert into archive_account_snapshots_v1 (row_data)
  select to_jsonb(s) from xp_account_metric_snapshots s
  where s.source in ('MIGRATED', 'RECONSTRUCTED')
    and not exists (
      select 1 from archive_account_snapshots_v1 a
      where (a.row_data->>'id')::bigint = s.id);
  get diagnostics n = row_count;
  insert into xp_data_repairs (migration, target_table, action, rows_affected, detail)
  values ('0005', 'archive_account_snapshots_v1', 'archive_before_unfreeze', n, '{}'::jsonb);
end $$;

do $$
declare n bigint;
begin
  perform set_config('app.allow_snapshot_rewrite', 'on', true);

  update xp_account_metric_snapshots s
     set is_final = false
   where s.source in ('MIGRATED', 'RECONSTRUCTED')
     and s.is_final = true;

  get diagnostics n = row_count;
  insert into xp_data_repairs (migration, target_table, action, rows_affected, detail)
  values ('0005', 'xp_account_metric_snapshots', 'unfreeze_migrated_rows', n,
          jsonb_build_object('why', 'sync skips finalized rows, so real Graph API values could never replace v1 approximations',
                             'next', 'run a full backfill, then fn_finalize_snapshots() refreezes them'));
end $$;

-- ---------------------------------------------------------------------
-- 4. xp_v_account_daily v2 — observed totals in, estimated totals out
-- ---------------------------------------------------------------------
-- followers_total_est is derived, never stored:
--   * a day with an observed total uses it, and is_observed = true
--   * a day after the last observation  = last observed  + gains since it
--   * a day before the first observation = first observed - gains since that day
-- so the series is continuous and every point says whether it was measured or inferred.
--
-- xp_v_client_day_summary depends on this view, so both are dropped and recreated (the column
-- list changes, which CREATE OR REPLACE VIEW cannot do).
drop view if exists xp_v_client_day_summary;
drop view if exists xp_v_account_daily;

create view xp_v_account_daily as
with base as (
  select a.*,
         -- the most trustworthy statement about this day's change, in priority order
         coalesce(
           case when a.follows_day is not null and a.unfollows_day is not null
                then a.follows_day - a.unfollows_day end,
           case when a.fan_adds is not null and a.fan_removes is not null
                then a.fan_adds - a.fan_removes end,
           a.followers_gained_day
         ) as followers_change_reported
  from xp_account_metric_snapshots a
),
grouped as (
  select b.*,
         sum(coalesce(b.followers_change_reported, 0))
           over (partition by b.asset_id order by b.metric_date
                 rows between unbounded preceding and current row)          as cum_change,
         count(b.followers_total)
           over (partition by b.asset_id order by b.metric_date
                 rows between unbounded preceding and current row)          as grp_back,
         count(b.followers_total)
           over (partition by b.asset_id order by b.metric_date desc
                 rows between unbounded preceding and current row)          as grp_fwd
  from base b
),
anchored as (
  select g.*,
         max(g.followers_total) filter (where g.followers_total is not null)
           over (partition by g.asset_id, g.grp_back)                       as anchor_back_total,
         max(g.cum_change)      filter (where g.followers_total is not null)
           over (partition by g.asset_id, g.grp_back)                       as anchor_back_cum,
         max(g.followers_total) filter (where g.followers_total is not null)
           over (partition by g.asset_id, g.grp_fwd)                        as anchor_fwd_total,
         max(g.cum_change)      filter (where g.followers_total is not null)
           over (partition by g.asset_id, g.grp_fwd)                        as anchor_fwd_cum
  from grouped g
)
select
  a.id, a.client_id, a.asset_id, a.platform, a.metric_date,
  a.followers_total, a.fans_total, a.following_total, a.media_count,
  a.impressions, a.reach, a.views, a.page_views, a.profile_views, a.engagements,
  a.likes, a.comments, a.shares, a.saves, a.replies, a.video_views,
  a.accounts_engaged, a.website_clicks, a.profile_link_taps,
  a.follows_day, a.unfollows_day, a.fan_adds, a.fan_removes,
  a.followers_gained_day, a.reactions, a.online_followers, a.extra, a.raw,
  a.source, a.is_final, a.collected_at,

  -- unchanged contract: the delta between two OBSERVED totals
  a.followers_total - lag(a.followers_total) over w                          as followers_gained_observed,
  lag(a.metric_date) over w                                                  as prev_metric_date,

  -- new
  a.followers_change_reported,
  (a.followers_total is not null)                                            as followers_total_is_observed,
  coalesce(
    a.followers_total,
    case when a.anchor_back_total is not null
         then a.anchor_back_total + (a.cum_change - a.anchor_back_cum) end,
    case when a.anchor_fwd_total is not null
         then a.anchor_fwd_total - (a.anchor_fwd_cum - a.cum_change) end
  )                                                                          as followers_total_est,
  coalesce(a.followers_total - lag(a.followers_total) over w,
           a.followers_change_reported)                                      as followers_gained
from anchored a
window w as (partition by a.asset_id order by a.metric_date);

comment on view xp_v_account_daily is
  'Account snapshots plus a continuous follower series. followers_total is what was measured; '
  'followers_total_est is what we believe, anchored on the nearest measurement and moved by the '
  'reported daily changes. followers_total_is_observed says which is which — quote it.';

-- Recreated verbatim from 0001 except that follower fields now come from the estimated series.
create view xp_v_client_day_summary as
with post_gains as (
  select client_id, platform, snapshot_date as d,
         sum(coalesce(reach_gained,0))        as post_reach_gained,
         sum(coalesce(impressions_gained,0))  as post_impressions_gained,
         sum(coalesce(views_gained,0))        as post_views_gained,
         sum(coalesce(likes_gained,0))        as likes_gained,
         sum(coalesce(comments_gained,0))     as comments_gained,
         sum(coalesce(shares_gained,0))       as shares_gained,
         sum(coalesce(saves_gained,0))        as saves_gained,
         count(*) filter (where is_first_observation) as posts_first_seen
  from xp_v_post_daily_deltas
  group by client_id, platform, snapshot_date
),
acct as (
  select client_id, platform, metric_date as d,
         sum(followers_total_est) as followers_total,
         sum(followers_gained)    as followers_gained,
         sum(reach) as account_reach, sum(impressions) as account_impressions,
         sum(views) as account_views, sum(page_views) as page_views, sum(profile_views) as profile_views,
         sum(engagements) as engagements, sum(video_views) as account_video_views,
         sum(follows_day) as follows_day, sum(unfollows_day) as unfollows_day,
         bool_and(is_final) as is_final
  from xp_v_account_daily
  group by client_id, platform, metric_date
),
posts_pub as (
  select client_id, platform, (publish_date at time zone 'UTC')::date as d, count(*) as posts_published
  from xp_meta_posts where not is_story group by 1,2,3
)
select coalesce(pg.client_id, ac.client_id, pp.client_id) as client_id,
       coalesce(pg.platform,  ac.platform,  pp.platform)  as platform,
       coalesce(pg.d, ac.d, pp.d) as day,
       pp.posts_published, pg.posts_first_seen,
       pg.post_reach_gained, pg.post_impressions_gained, pg.post_views_gained,
       pg.likes_gained, pg.comments_gained, pg.shares_gained, pg.saves_gained,
       ac.followers_total, ac.followers_gained, ac.follows_day, ac.unfollows_day,
       ac.account_reach, ac.account_impressions, ac.account_views,
       ac.page_views, ac.profile_views, ac.engagements, ac.account_video_views,
       ac.is_final
from post_gains pg
full join acct ac      on ac.client_id = pg.client_id and ac.platform = pg.platform and ac.d = pg.d
full join posts_pub pp on pp.client_id = coalesce(pg.client_id, ac.client_id)
                      and pp.platform  = coalesce(pg.platform,  ac.platform)
                      and pp.d         = coalesce(pg.d, ac.d);

-- ---------------------------------------------------------------------
-- 5. fn_followers_series v2 — one row per platform per day, with provenance
-- ---------------------------------------------------------------------
drop function if exists fn_followers_series(uuid, date, date);

create function fn_followers_series(p_client uuid, p_start date, p_end date)
returns table(
  platform          text,
  metric_date       date,
  followers_total   bigint,     -- estimated series: what a chart should plot
  is_observed       boolean,    -- true when every asset on this platform was measured that day
  followers_gained  bigint,
  is_final          boolean
)
language sql stable as $$
  select d.platform,
         d.metric_date,
         sum(d.followers_total_est)::bigint,
         bool_and(d.followers_total_is_observed),
         sum(d.followers_gained)::bigint,
         bool_and(d.is_final)
  from xp_v_account_daily d
  where d.client_id = p_client
    and d.metric_date between p_start and p_end
  group by d.platform, d.metric_date
  order by d.platform, d.metric_date
$$;

comment on function fn_followers_series(uuid, date, date) is
  'Follower series per platform. followers_total is the estimated (continuous) series; '
  'is_observed = false means the point was inferred from daily gains, not measured. IG points '
  'before today are always inferred — Meta does not serve historical follower totals.';

-- ---------------------------------------------------------------------
-- 6. xp_v_post_daily_deltas — mark rebuilt history so consumers can exclude it
-- ---------------------------------------------------------------------
-- Existing columns keep their names and order, so CREATE OR REPLACE is legal.
create or replace view xp_v_post_daily_deltas as
select s.*,
       s.impressions        - lag(s.impressions)        over w as impressions_gained,
       s.reach              - lag(s.reach)              over w as reach_gained,
       s.views              - lag(s.views)              over w as views_gained,
       s.plays              - lag(s.plays)              over w as plays_gained,
       s.likes              - lag(s.likes)              over w as likes_gained,
       s.comments           - lag(s.comments)           over w as comments_gained,
       s.shares             - lag(s.shares)             over w as shares_gained,
       s.saves              - lag(s.saves)              over w as saves_gained,
       s.video_views        - lag(s.video_views)        over w as video_views_gained,
       s.total_interactions - lag(s.total_interactions) over w as interactions_gained,
       lag(s.snapshot_date) over w                               as prev_snapshot_date,
       (lag(s.snapshot_date) over w) is null                     as is_first_observation,
       lag(s.source) over w                                      as prev_source,
       -- a gain is trustworthy only if BOTH endpoints were really observed
       (s.source in ('LIVE','BACKFILL')
        and (lag(s.source) over w) in ('LIVE','BACKFILL'))        as is_trusted
from xp_post_metric_snapshots s
window w as (partition by s.asset_id, s.meta_post_id order by s.snapshot_date);

comment on view xp_v_post_daily_deltas is
  'Per-post day-over-day gains derived by subtraction. is_trusted = false means one endpoint was '
  'MIGRATED or RECONSTRUCTED from v1 and the gain was never actually observed — do not report it.';

-- ---------------------------------------------------------------------
-- 7. xp_v_data_coverage v2 — honest about reconstructed history
-- ---------------------------------------------------------------------
-- Dropped and recreated, not replaced: CREATE OR REPLACE VIEW can only APPEND columns, and the
-- new ones sit alongside existing ones. Replacing in place fails with 42P16 "cannot change name
-- of view column". Nothing depends on this view, so the drop is safe.
drop view if exists xp_v_data_coverage;

create view xp_v_data_coverage as
select
  a.client_id,
  a.id                                             as asset_id,
  a.platform,
  a.name,
  a.status,
  a.first_synced_at,
  a.last_synced_at,
  a.last_full_backfill_at,
  (select min(s.metric_date)   from xp_account_metric_snapshots s where s.asset_id = a.id) as account_data_from,
  (select max(s.metric_date)   from xp_account_metric_snapshots s where s.asset_id = a.id) as account_data_to,
  (select count(*)             from xp_account_metric_snapshots s where s.asset_id = a.id) as account_days,
  -- observed only: rebuilt v1 rows are not tracking
  (select min(s.snapshot_date) from xp_post_metric_snapshots s
     where s.asset_id = a.id and s.source in ('LIVE','BACKFILL'))                       as post_data_from,
  (select max(s.snapshot_date) from xp_post_metric_snapshots s
     where s.asset_id = a.id and s.source in ('LIVE','BACKFILL'))                       as post_data_to,
  (select count(distinct s.snapshot_date) from xp_post_metric_snapshots s
     where s.asset_id = a.id and s.source in ('LIVE','BACKFILL'))                       as post_days,
  (select count(*) from xp_meta_posts p
     where p.asset_id = a.id and not p.is_story and not p.is_deleted)                    as posts_known,
  (select min(s.snapshot_date) from xp_post_metric_snapshots s where s.asset_id = a.id)    as post_data_from_incl_v1,
  (select min(s.metric_date) from xp_account_metric_snapshots s
     where s.asset_id = a.id and s.followers_total is not null)                          as followers_observed_from
from xp_meta_assets a;

comment on view xp_v_data_coverage is
  'Per-asset data horizons. post_data_from counts only snapshots we took ourselves; nothing '
  'before it can have real per-post daily gains, because Meta does not serve that history.';

-- ---------------------------------------------------------------------
-- 8. Verification
-- ---------------------------------------------------------------------
-- What did this migration touch?
--   select * from xp_data_repairs order by ran_at desc;
--
-- Follower series sanity — totals must look like follower counts, not like 2, 5, 3:
--   select * from fn_followers_series((select id from xp_clients limit 1),
--                                     current_date - 60, current_date);
--
-- Which follower points are real?
--   select platform, count(*) filter (where followers_total_is_observed) as observed,
--          count(*) as days
--   from xp_v_account_daily group by platform;
--
-- How much per-post history is genuinely ours?
--   select platform, name, post_data_from, post_data_from_incl_v1, post_days from xp_v_data_coverage;


-- ===================================================================
-- 0006_query_layer_v2.sql
-- ===================================================================
-- migrations_0006_query_layer_v2.sql
-- Idempotent. Safe to re-run. Run AFTER 0005.
--
-- STEP 2 of the map: the query layer the report and the AI both read from.
--
-- Everything a client will ever be shown is computed here, once, in SQL. The report does not
-- get to define engagement rate one way and the chat another; there is a single function for
-- each idea and both call it. Nothing in this file writes.
--
-- Definitions fixed here (write these in the report footnotes too):
--   interactions   = total_interactions when Meta gives it, else likes/reactions + comments
--                    + shares + saves. One definition, both platforms.
--   engagement rate= interactions ÷ reach × 100        (per post — the industry default)
--   ER on followers= interactions ÷ followers × 100    (account level, for benchmarks)
--   "lifetime as of D" = the post's counters in the last snapshot taken on or before D. This
--                    exists for every post we have ever snapshotted, including posts published
--                    long before daily tracking began — which is why the report can show a real
--                    content table for August even though August has no daily gains.
--
-- Naming: fn_* returns numbers for a client and a period, always in the client's timezone.

-- =====================================================================
-- 1. Shared definitions
-- =====================================================================

-- One canonical content format per post, across two very different taxonomies.
create or replace function fn_content_format(p_platform text, p_media_type text, p_product_type text)
returns text
language sql immutable as $$
  select case
    when p_platform = 'IG' then case
      when upper(coalesce(p_product_type,'')) = 'REELS'          then 'REEL'
      when upper(coalesce(p_product_type,'')) = 'STORY'          then 'STORY'
      when upper(coalesce(p_media_type,''))   = 'CAROUSEL_ALBUM' then 'CAROUSEL'
      when upper(coalesce(p_media_type,''))   = 'VIDEO'          then 'VIDEO'
      when upper(coalesce(p_media_type,''))   = 'IMAGE'          then 'IMAGE'
      else 'OTHER' end
    else case
      when lower(coalesce(p_media_type, p_product_type,'')) in ('photo','added_photos')        then 'PHOTO'
      when lower(coalesce(p_media_type, p_product_type,'')) in ('video','added_video')         then 'VIDEO'
      when lower(coalesce(p_media_type, p_product_type,'')) in ('link','shared_story')         then 'LINK'
      when lower(coalesce(p_media_type, p_product_type,'')) in ('status','mobile_status_update') then 'TEXT'
      when lower(coalesce(p_media_type, p_product_type,'')) like '%reel%'                      then 'REEL'
      when coalesce(p_media_type, p_product_type) is null                                      then 'OTHER'
      else upper(coalesce(p_media_type, p_product_type)) end
  end
$$;

-- The single definition of "interactions".
create or replace function fn_interactions(
  p_platform text, p_total bigint, p_likes bigint, p_reactions bigint,
  p_comments bigint, p_shares bigint, p_saves bigint)
returns bigint
language sql immutable as $$
  select coalesce(
    p_total,
    coalesce(case when p_platform = 'FB' then coalesce(p_reactions, p_likes) else p_likes end, 0)
      + coalesce(p_comments, 0) + coalesce(p_shares, 0) + coalesce(p_saves, 0)
  )
$$;

-- A cast that yields null instead of throwing, for walking JSON of mixed types.
create or replace function fn_num(p_text text)
returns numeric
language sql immutable as $$
  select case when p_text ~ '^-?[0-9]+(\.[0-9]+)?$' then p_text::numeric end
$$;

-- The single definition of engagement rate. Null base ⇒ null rate, never 0.
create or replace function fn_er(p_interactions bigint, p_base bigint)
returns numeric
language sql immutable as $$
  select case when p_base is null or p_base = 0 or p_interactions is null then null
              else round(p_interactions::numeric * 100 / p_base, 2) end
$$;

-- =====================================================================
-- 2. xp_v_post_scored — one row per post, latest observed lifetime counters
-- =====================================================================
create or replace view xp_v_post_scored as
select
  p.client_id, p.asset_id, p.platform, p.meta_post_id,
  p.caption, p.permalink, p.thumbnail_url, p.media_url,
  p.media_type, p.media_product_type,
  fn_content_format(p.platform, p.media_type, p.media_product_type) as format,
  p.publish_date, p.is_story, p.is_deleted,
  l.snapshot_date as as_of,
  l.reach, l.impressions, l.views, l.plays,
  l.likes, l.comments, l.shares, l.saves, l.reactions_total, l.reactions,
  l.video_views, l.avg_watch_time_ms, l.clicks, l.engaged_users,
  l.profile_visits, l.follows, l.extra,
  fn_interactions(p.platform, l.total_interactions, l.likes, l.reactions_total,
                  l.comments, l.shares, l.saves)                     as interactions,
  fn_er(fn_interactions(p.platform, l.total_interactions, l.likes, l.reactions_total,
                        l.comments, l.shares, l.saves), l.reach)     as engagement_rate
from xp_meta_posts p
left join xp_v_post_latest l on l.asset_id = p.asset_id and l.meta_post_id = p.meta_post_id;

comment on view xp_v_post_scored is
  'Every post with its most recent observed lifetime counters, a normalised format and an '
  'engagement rate. as_of is the day those counters were read — quote it alongside them.';

-- =====================================================================
-- 3. fn_content_table — the post-level table the report has never had
-- =====================================================================
-- Posts PUBLISHED in the window, with their lifetime counters as of p_end plus, where daily
-- tracking covered the window, what they gained inside it.
create or replace function fn_content_table(
  p_client uuid, p_start date, p_end date,
  p_limit int default 200, p_order text default 'reach')
returns jsonb
language plpgsql stable as $$
declare v_tz text; v_out jsonb;
begin
  select coalesce(timezone,'UTC') into v_tz from xp_clients where id = p_client;

  select coalesce(jsonb_agg(x order by x_rank), '[]'::jsonb) into v_out
  from (
    select jsonb_build_object(
             'post_id', p.meta_post_id, 'platform', p.platform, 'format',
             fn_content_format(p.platform, p.media_type, p.media_product_type),
             'caption', left(coalesce(p.caption,''), 220),
             'permalink', p.permalink, 'thumbnail_url', p.thumbnail_url,
             'published_at', p.publish_date,
             'published_on', (p.publish_date at time zone v_tz)::date,
             'as_of', s.snapshot_date,
             'reach', s.reach, 'impressions', s.impressions, 'views', s.views, 'plays', s.plays,
             'likes', coalesce(s.likes, s.reactions_total), 'comments', s.comments,
             'shares', s.shares, 'saves', s.saves,
             'video_views', s.video_views, 'avg_watch_time_ms', s.avg_watch_time_ms,
             'clicks', s.clicks, 'profile_visits', s.profile_visits, 'follows', s.follows,
             'interactions', fn_interactions(p.platform, s.total_interactions, s.likes,
                                             s.reactions_total, s.comments, s.shares, s.saves),
             'engagement_rate', fn_er(fn_interactions(p.platform, s.total_interactions, s.likes,
                                             s.reactions_total, s.comments, s.shares, s.saves), s.reach),
             'reach_gained_in_period', g.reach_gained,
             'interactions_gained_in_period', g.interactions_gained,
             'tracked_in_period', g.reach_gained is not null
           ) as x,
           row_number() over (
             order by case lower(p_order)
                        when 'engagement' then fn_er(fn_interactions(p.platform, s.total_interactions,
                                                s.likes, s.reactions_total, s.comments, s.shares, s.saves), s.reach)
                        when 'interactions' then fn_interactions(p.platform, s.total_interactions, s.likes,
                                                s.reactions_total, s.comments, s.shares, s.saves)::numeric
                        when 'recent' then extract(epoch from p.publish_date)::numeric
                        else coalesce(s.reach, 0)::numeric end desc nulls last
           ) as x_rank
    from xp_meta_posts p
    left join lateral (
      select * from xp_post_metric_snapshots s2
      where s2.asset_id = p.asset_id and s2.meta_post_id = p.meta_post_id
        and s2.snapshot_date <= p_end
      order by s2.snapshot_date desc limit 1
    ) s on true
    left join lateral (
      select sum(d.reach_gained) as reach_gained, sum(d.interactions_gained) as interactions_gained
      from xp_v_post_daily_deltas d
      where d.asset_id = p.asset_id and d.meta_post_id = p.meta_post_id
        and d.snapshot_date between p_start and p_end and d.is_trusted
    ) g on true
    where p.client_id = p_client
      and not p.is_story and not p.is_deleted
      and (p.publish_date at time zone v_tz)::date between p_start and p_end
    order by x_rank
    limit greatest(p_limit, 1)
  ) q;

  return v_out;
end $$;

comment on function fn_content_table(uuid, date, date, int, text) is
  'Posts published in the window with lifetime counters as of the window end. p_order: '
  'reach | engagement | interactions | recent. tracked_in_period=false means the post existed '
  'before daily snapshots began, so only its lifetime total is knowable.';

-- =====================================================================
-- 4. fn_top_posts — same data, ranked, for the summary pages
-- =====================================================================
create or replace function fn_top_posts(
  p_client uuid, p_start date, p_end date,
  p_limit int default 10, p_order text default 'reach', p_platform text default null)
returns jsonb
language plpgsql stable as $$
declare v_all jsonb; v_out jsonb;
begin
  v_all := fn_content_table(p_client, p_start, p_end, 500, p_order);
  select coalesce(jsonb_agg(e order by ord), '[]'::jsonb) into v_out
  from (
    select e, ord
    from jsonb_array_elements(v_all) with ordinality as t(e, ord)
    where p_platform is null or e->>'platform' = p_platform
    order by ord
    limit greatest(p_limit, 1)
  ) q;
  return v_out;
end $$;

-- =====================================================================
-- 5. fn_format_breakdown — Reels vs carousels vs photos, and the FB equivalent
-- =====================================================================
create or replace function fn_format_breakdown(p_client uuid, p_start date, p_end date)
returns jsonb
language plpgsql stable as $$
declare v_tz text; v_out jsonb;
begin
  select coalesce(timezone,'UTC') into v_tz from xp_clients where id = p_client;

  select coalesce(jsonb_agg(jsonb_build_object(
           'platform', platform, 'format', format,
           'posts', posts,
           'total_reach', total_reach, 'avg_reach', avg_reach, 'median_reach', median_reach,
           'total_interactions', total_interactions, 'avg_interactions', avg_interactions,
           'avg_engagement_rate', avg_er,
           'share_of_posts_pct', round(posts::numeric * 100 / nullif(platform_posts, 0), 1),
           'share_of_reach_pct', round(total_reach::numeric * 100 / nullif(platform_reach, 0), 1)
         ) order by platform, total_reach desc nulls last), '[]'::jsonb) into v_out
  from (
    -- window functions cannot be nested inside an aggregate call, so the per-platform
    -- denominators are computed here and only read above
    select b.*,
           sum(b.posts)        over (partition by b.platform) as platform_posts,
           sum(b.total_reach)  over (partition by b.platform) as platform_reach
    from (
      select v.platform, v.format,
             count(*)                                                            as posts,
             sum(v.reach)                                                        as total_reach,
             round(avg(v.reach))                                                 as avg_reach,
             round(percentile_cont(0.5) within group
                   (order by v.reach::double precision)::numeric)                as median_reach,
             sum(v.interactions)                                                 as total_interactions,
             round(avg(v.interactions))                                          as avg_interactions,
             round(avg(v.engagement_rate), 2)                                    as avg_er
      from xp_v_post_scored v
      where v.client_id = p_client and not v.is_story and not v.is_deleted
        and (v.publish_date at time zone v_tz)::date between p_start and p_end
      group by v.platform, v.format
    ) b
  ) q;

  return jsonb_build_object(
    'period', jsonb_build_object('start', p_start, 'end', p_end, 'timezone', v_tz),
    'basis', 'lifetime counters as of the latest snapshot, for posts published in this window',
    'formats', v_out);
end $$;

-- =====================================================================
-- 6. fn_posting_pattern — when to post, from your own results
-- =====================================================================
create or replace function fn_posting_pattern(p_client uuid, p_start date, p_end date)
returns jsonb
language plpgsql stable as $$
declare v_tz text; v_dow jsonb; v_hour jsonb; v_online jsonb;
begin
  select coalesce(timezone,'UTC') into v_tz from xp_clients where id = p_client;

  select coalesce(jsonb_agg(jsonb_build_object(
           'platform', platform, 'dow', dow, 'day_name', day_name, 'posts', posts,
           'avg_reach', avg_reach, 'avg_interactions', avg_interactions, 'avg_engagement_rate', avg_er)
         order by platform, dow), '[]'::jsonb) into v_dow
  from (
    select v.platform,
           extract(dow from (v.publish_date at time zone v_tz))::int  as dow,
           trim(to_char((v.publish_date at time zone v_tz), 'Day'))   as day_name,
           count(*) as posts, round(avg(v.reach)) as avg_reach,
           round(avg(v.interactions)) as avg_interactions, round(avg(v.engagement_rate),2) as avg_er
    from xp_v_post_scored v
    where v.client_id = p_client and not v.is_story and not v.is_deleted
      and (v.publish_date at time zone v_tz)::date between p_start and p_end
    group by 1,2,3
  ) q;

  select coalesce(jsonb_agg(jsonb_build_object(
           'platform', platform, 'hour', hour, 'posts', posts,
           'avg_reach', avg_reach, 'avg_engagement_rate', avg_er) order by platform, hour), '[]'::jsonb) into v_hour
  from (
    select v.platform,
           extract(hour from (v.publish_date at time zone v_tz))::int as hour,
           count(*) as posts, round(avg(v.reach)) as avg_reach, round(avg(v.engagement_rate),2) as avg_er
    from xp_v_post_scored v
    where v.client_id = p_client and not v.is_story and not v.is_deleted
      and (v.publish_date at time zone v_tz)::date between p_start and p_end
    group by 1,2
  ) q;

  -- When the audience is actually online (IG only, rolling 30 days, hour → follower count).
  -- Averaged across the most recent days that carry the breakdown.
  select coalesce(jsonb_object_agg(hr::text, avg_followers), '{}'::jsonb) into v_online
  from (
    select kv.key::int as hr, round(avg(kv.value::numeric)) as avg_followers
    from xp_account_metric_snapshots a
    cross join lateral jsonb_each_text(a.online_followers) kv
    where a.client_id = p_client and a.platform = 'IG'
      and a.online_followers is not null
      and a.metric_date between p_start and p_end
      and kv.value ~ '^[0-9.]+$'
    group by 1
  ) q;

  return jsonb_build_object(
    'period', jsonb_build_object('start', p_start, 'end', p_end, 'timezone', v_tz),
    'note', 'Averages are over posts published in the window, using lifetime counters. '
            'A day or hour with 1–2 posts is not evidence.',
    'by_day_of_week', v_dow,
    'by_hour', v_hour,
    'audience_online_by_hour', v_online);
end $$;

-- =====================================================================
-- 7. fn_audience — demographics, finally readable
-- =====================================================================
create or replace function fn_audience(p_client uuid, p_asof date default null)
returns jsonb
language plpgsql stable as $$
declare v_asof date; v_out jsonb;
begin
  v_asof := coalesce(p_asof, current_date);

  -- Latest snapshot per (asset, audience_type, dimension) on or before v_asof, exploded into
  -- normalised label/value pairs. IG keys look like "18-24|F", FB keys like "F.25-34".
  with latest as (
    select distinct on (s.asset_id, s.audience_type, s.dimension)
           s.asset_id, s.audience_type, s.dimension, s.snapshot_date, s.breakdown,
           a.platform, a.name as asset_name
    from xp_audience_snapshots s
    join xp_meta_assets a on a.id = s.asset_id
    where s.client_id = p_client and s.snapshot_date <= v_asof
    order by s.asset_id, s.audience_type, s.dimension, s.snapshot_date desc
  ),
  exploded as (
    select l.asset_id, l.audience_type, l.dimension, l.snapshot_date, l.platform, l.asset_name,
           l.breakdown, kv.key as label, kv.value::numeric as value
    from latest l
    cross join lateral jsonb_each_text(l.breakdown) kv
    where kv.value ~ '^[0-9]+(\.[0-9]+)?$'
  ),
  ranked as (
    select e.*, row_number() over (partition by e.asset_id, e.audience_type, e.dimension
                                   order by e.value desc) as rn,
           sum(e.value) over (partition by e.asset_id, e.audience_type, e.dimension) as total_people
    from exploded e
  ),
  rolled as (
    select r.platform, r.asset_name, r.audience_type, r.dimension, r.snapshot_date,
           max(r.total_people) as total_people,
           min(r.breakdown::text) as raw_text,
           jsonb_agg(jsonb_build_object(
             'label', r.label, 'value', r.value,
             'age',    case when r.label like '%.%' then split_part(r.label, '.', 2)
                            when r.label like '%|%' then split_part(r.label, '|', 1) end,
             'gender', case when r.label like '%.%' then split_part(r.label, '.', 1)
                            when r.label like '%|%' then split_part(r.label, '|', 2) end,
             'share_pct', round(r.value * 100 / nullif(r.total_people, 0), 1)
           ) order by r.value desc) filter (where r.rn <= 12) as top_items
    from ranked r
    group by r.platform, r.asset_name, r.audience_type, r.dimension, r.snapshot_date
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'platform', platform, 'asset', asset_name, 'audience_type', audience_type,
           'dimension', dimension, 'snapshot_date', snapshot_date,
           'total', total_people,
           'top', coalesce(top_items, '[]'::jsonb),
           'raw', raw_text::jsonb)
         order by platform, audience_type, dimension), '[]'::jsonb) into v_out
  from rolled;

  return jsonb_build_object(
    'as_of', v_asof,
    'note', 'Demographics are a periodic snapshot of the CURRENT audience, not a per-day series. '
            'age/gender keys are normalised; the untouched payload is in raw.',
    'segments', v_out);
end $$;

-- =====================================================================
-- 8. fn_stories_summary — 24h content, captured daily, never once shown
-- =====================================================================
create or replace function fn_stories_summary(p_client uuid, p_start date, p_end date)
returns jsonb
language plpgsql stable as $$
declare v_tz text; v_tot jsonb; v_items jsonb;
begin
  select coalesce(timezone,'UTC') into v_tz from xp_clients where id = p_client;

  with s as (
    select p.meta_post_id, p.permalink, p.thumbnail_url, p.media_type, p.publish_date,
           l.views, l.reach, l.shares, l.follows, l.profile_visits, l.total_interactions, l.extra,
           (l.extra->>'replies')::bigint as replies,
           fn_er(coalesce(l.total_interactions,
                          coalesce(l.shares,0) + coalesce((l.extra->>'replies')::bigint,0)), l.reach) as engagement_rate
    from xp_meta_posts p
    join xp_v_post_latest l on l.asset_id = p.asset_id and l.meta_post_id = p.meta_post_id
    where p.client_id = p_client and p.is_story
      and (p.publish_date at time zone v_tz)::date between p_start and p_end
  )
  select jsonb_build_object(
           'stories', count(*), 'views', sum(views), 'reach', sum(reach),
           'replies', sum(replies), 'shares', sum(shares), 'follows', sum(follows),
           'profile_visits', sum(profile_visits),
           'avg_reach', round(avg(reach)), 'avg_engagement_rate', round(avg(engagement_rate),2)),
         coalesce(jsonb_agg(jsonb_build_object(
           'post_id', meta_post_id, 'permalink', permalink, 'thumbnail_url', thumbnail_url,
           'published_at', publish_date, 'views', views, 'reach', reach,
           'replies', replies, 'engagement_rate', engagement_rate)
           order by reach desc nulls last), '[]'::jsonb)
  into v_tot, v_items
  from s;

  return jsonb_build_object(
    'period', jsonb_build_object('start', p_start, 'end', p_end, 'timezone', v_tz),
    'note', 'Stories expire after 24h. Only stories that were live during a sync exist here; '
            'a missed day is a permanent gap, not a zero.',
    'totals', coalesce(v_tot, '{}'::jsonb),
    'stories', v_items);
end $$;

-- =====================================================================
-- 9. fn_comments_digest — what people are actually saying
-- =====================================================================
create or replace function fn_comments_digest(
  p_client uuid, p_start date, p_end date, p_limit int default 25)
returns jsonb
language plpgsql stable as $$
declare v_tz text; v_stats jsonb; v_items jsonb; v_posts jsonb;
begin
  select coalesce(timezone,'UTC') into v_tz from xp_clients where id = p_client;

  with c as (
    select * from xp_post_comments
    where client_id = p_client and not is_deleted
      and (created_time at time zone v_tz)::date between p_start and p_end
  )
  select jsonb_build_object(
           'comments', count(*),
           'unique_authors', count(distinct author_id),
           'threaded_replies', count(*) filter (where parent_comment_id is not null),
           'sentiment', jsonb_build_object(
             'positive', count(*) filter (where sentiment = 'POSITIVE'),
             'neutral',  count(*) filter (where sentiment = 'NEUTRAL'),
             'negative', count(*) filter (where sentiment = 'NEGATIVE'),
             'unscored', count(*) filter (where sentiment is null))),
         coalesce(jsonb_agg(jsonb_build_object(
           'comment_id', comment_id, 'post_id', meta_post_id, 'author', author_name,
           'message', left(coalesce(message,''), 300), 'likes', like_count,
           'created_time', created_time, 'sentiment', sentiment)
           order by coalesce(like_count,0) desc, created_time desc) filter (where rn <= p_limit), '[]'::jsonb)
  into v_stats, v_items
  from (select c.*, row_number() over (order by coalesce(c.like_count,0) desc, c.created_time desc) rn from c) c;

  select coalesce(jsonb_agg(jsonb_build_object(
           'post_id', meta_post_id, 'comments', n, 'permalink', permalink,
           'caption', left(coalesce(caption,''),120)) order by n desc), '[]'::jsonb) into v_posts
  from (
    select pc.meta_post_id, count(*) n, max(p.permalink) permalink, max(p.caption) caption
    from xp_post_comments pc
    left join xp_meta_posts p on p.asset_id = pc.asset_id and p.meta_post_id = pc.meta_post_id
    where pc.client_id = p_client and not pc.is_deleted
      and (pc.created_time at time zone v_tz)::date between p_start and p_end
    group by pc.meta_post_id
    order by n desc limit 10
  ) q;

  return jsonb_build_object(
    'period', jsonb_build_object('start', p_start, 'end', p_end, 'timezone', v_tz),
    'stats', coalesce(v_stats,'{}'::jsonb),
    'most_discussed_posts', v_posts,
    'top_comments', v_items);
end $$;

-- =====================================================================
-- 10. fn_hashtag_performance
-- =====================================================================
create or replace function fn_hashtag_performance(
  p_client uuid, p_start date, p_end date, p_limit int default 25)
returns jsonb
language plpgsql stable as $$
declare v_tz text; v_out jsonb;
begin
  select coalesce(timezone,'UTC') into v_tz from xp_clients where id = p_client;

  select coalesce(jsonb_agg(jsonb_build_object(
           'hashtag', tag, 'posts', posts, 'avg_reach', avg_reach,
           'avg_interactions', avg_interactions, 'avg_engagement_rate', avg_er)
         order by posts desc, avg_reach desc nulls last), '[]'::jsonb) into v_out
  from (
    select tag, count(*) posts, round(avg(reach)) avg_reach,
           round(avg(interactions)) avg_interactions, round(avg(engagement_rate),2) avg_er
    from (
      select v.reach, v.interactions, v.engagement_rate,
             (regexp_matches(lower(v.caption), '#([[:alnum:]_]+)', 'g'))[1] as tag
      from xp_v_post_scored v
      where v.client_id = p_client and not v.is_story and not v.is_deleted
        and v.caption is not null
        and (v.publish_date at time zone v_tz)::date between p_start and p_end
    ) t
    group by tag
    having count(*) >= 2
    order by count(*) desc
    limit greatest(p_limit,1)
  ) q;

  return jsonb_build_object(
    'period', jsonb_build_object('start', p_start, 'end', p_end),
    'note', 'Hashtags used on at least two posts. Correlation only — a tag does not cause reach.',
    'hashtags', v_out);
end $$;

-- =====================================================================
-- 11. fn_compare_periods — "how did August compare to July"
-- =====================================================================
create or replace function fn_compare_periods(
  p_client uuid, p_start date, p_end date,
  p_prev_start date default null, p_prev_end date default null)
returns jsonb
language plpgsql stable as $$
declare
  v_len int; v_ps date; v_pe date; v_cur jsonb; v_prev jsonb; v_deltas jsonb;
begin
  v_len := (p_end - p_start) + 1;
  v_ps  := coalesce(p_prev_start, p_start - v_len);
  v_pe  := coalesce(p_prev_end,   p_start - 1);

  v_cur  := fn_client_period_summary(p_client, p_start, p_end);
  v_prev := fn_client_period_summary(p_client, v_ps, v_pe);

  -- Every numeric leaf of content.* / account.* / lifetime.* is compared, so adding a metric to
  -- the summary automatically adds it to the comparison. Keys are prefixed with their group.
  with pairs as (
    select p.pl,
           g.grp || '.' || e.key                            as k,
           fn_num(v_cur ->'platforms'->p.pl->g.grp->>e.key) as cur_v,
           fn_num(v_prev->'platforms'->p.pl->g.grp->>e.key) as prev_v
    from (select unnest(array['IG','FB']) as pl) p
    cross join (select unnest(array['content','account','lifetime']) as grp) g
    cross join lateral jsonb_each(
      case when jsonb_typeof(v_cur->'platforms'->p.pl->g.grp) = 'object'
           then v_cur->'platforms'->p.pl->g.grp else '{}'::jsonb end) e
  )
  select jsonb_object_agg(pl, body) into v_deltas
  from (
    select pl,
           jsonb_object_agg(k, jsonb_build_object(
             'current', cur_v, 'previous', prev_v,
             'change', case when cur_v is null or prev_v is null then null else cur_v - prev_v end,
             'change_pct', case when cur_v is null or prev_v is null or prev_v = 0 then null
                                else round((cur_v - prev_v) * 100 / prev_v, 1) end)) as body
    from pairs
    where cur_v is not null or prev_v is not null
    group by pl
  ) y;

  return jsonb_build_object(
    'current',  jsonb_build_object('start', p_start, 'end', p_end),
    'previous', jsonb_build_object('start', v_ps,   'end', v_pe),
    'note', 'A null change means one of the two periods was not tracked — not that it was zero.',
    'current_summary', v_cur,
    'previous_summary', v_prev,
    'deltas', coalesce(v_deltas, '{}'::jsonb));
end $$;

-- =====================================================================
-- 12. fn_client_period_summary v3
--     = 0004's honest version, plus: stories excluded from post gains, rebuilt v1 rows
--       excluded from gains, and an engagement block that works even before tracking began.
-- =====================================================================
create or replace function fn_client_period_summary(p_client uuid, p_start date, p_end date)
returns jsonb
language plpgsql stable as $$
declare
  v_tz    text;
  v_today date;
  v_out   jsonb;
begin
  select timezone into v_tz from xp_clients where id = p_client;
  v_today := fn_today(coalesce(v_tz, 'UTC'));

  with plat as (select unnest(array['IG','FB']) as platform),
  pub as (
    select platform, count(*) as posts_published
    from xp_meta_posts
    where client_id = p_client and not is_story and not is_deleted
      and (publish_date at time zone coalesce(v_tz,'UTC'))::date between p_start and p_end
    group by platform
  ),
  -- Observation coverage. Stories carry exactly one snapshot each and would otherwise inflate
  -- the count of "days we tracked posts".
  cover as (
    select s.platform,
           count(distinct s.snapshot_date) as post_days_in_period,
           count(distinct s.meta_post_id)  as posts_observed
    from xp_post_metric_snapshots s
    join xp_meta_posts p on p.asset_id = s.asset_id and p.meta_post_id = s.meta_post_id
    where s.client_id = p_client and s.snapshot_date between p_start and p_end
      and s.source in ('LIVE','BACKFILL') and not p.is_story
    group by s.platform
  ),
  horizon as (
    select s.platform, min(s.snapshot_date) as post_data_from
    from xp_post_metric_snapshots s
    join xp_meta_posts p on p.asset_id = s.asset_id and p.meta_post_id = s.meta_post_id
    where s.client_id = p_client and s.source in ('LIVE','BACKFILL') and not p.is_story
    group by s.platform
  ),
  gains as (
    select d.platform,
           sum(coalesce(d.reach_gained,0))       as reach_gained,
           sum(coalesce(d.impressions_gained,0)) as impressions_gained,
           sum(coalesce(d.views_gained,0))       as views_gained,
           sum(coalesce(d.likes_gained,0))       as likes_gained,
           sum(coalesce(d.comments_gained,0))    as comments_gained,
           sum(coalesce(d.shares_gained,0))      as shares_gained,
           sum(coalesce(d.saves_gained,0))       as saves_gained,
           sum(coalesce(d.video_views_gained,0)) as video_views_gained,
           sum(coalesce(d.interactions_gained,0)) as interactions_gained
    from xp_v_post_daily_deltas d
    join xp_meta_posts p on p.asset_id = d.asset_id and p.meta_post_id = d.meta_post_id
    where d.client_id = p_client and d.snapshot_date between p_start and p_end
      and d.is_trusted and not p.is_story
    group by d.platform
  ),
  -- Lifetime performance of the posts published in this window. Available for EVERY period,
  -- including periods that predate daily tracking, because it reads absolute counters.
  life as (
    select v.platform,
           count(*)                                          as posts,
           sum(v.reach)::bigint                              as reach,
           sum(v.views)::bigint                              as views,
           sum(v.interactions)::bigint                       as interactions,
           sum(coalesce(v.likes, v.reactions_total))::bigint as likes,
           sum(v.comments)::bigint                           as comments,
           sum(v.shares)::bigint                             as shares,
           sum(v.saves)::bigint                              as saves,
           round(avg(v.reach))                               as avg_reach,
           round(avg(v.engagement_rate), 2)                  as avg_engagement_rate,
           max(v.as_of)                                      as as_of
    from xp_v_post_scored v
    where v.client_id = p_client and not v.is_story and not v.is_deleted
      and (v.publish_date at time zone coalesce(v_tz,'UTC'))::date between p_start and p_end
    group by v.platform
  ),
  acct as (
    select platform,
           sum(reach) as account_reach, sum(impressions) as account_impressions, sum(views) as account_views,
           sum(page_views) as page_views, sum(profile_views) as profile_views,
           sum(engagements) as engagements, sum(video_views) as video_views,
           sum(follows_day) as follows, sum(unfollows_day) as unfollows,
           count(*) as days_with_data,
           bool_and(is_final) as all_final
    from xp_account_metric_snapshots
    where client_id = p_client and metric_date between p_start and p_end
    group by platform
  ),
  f_start as (
    select distinct on (platform) platform, followers_total, is_observed, metric_date
    from (
      select d.platform, d.metric_date,
             sum(d.followers_total_est)::bigint as followers_total,
             bool_and(d.followers_total_is_observed) as is_observed
      from xp_v_account_daily d
      where d.client_id = p_client and d.metric_date <= p_start
      group by d.platform, d.metric_date
    ) s
    where followers_total is not null
    order by platform, metric_date desc
  ),
  f_end as (
    select distinct on (platform) platform, followers_total, is_observed, metric_date
    from (
      select d.platform, d.metric_date,
             sum(d.followers_total_est)::bigint as followers_total,
             bool_and(d.followers_total_is_observed) as is_observed
      from xp_v_account_daily d
      where d.client_id = p_client and d.metric_date <= p_end
      group by d.platform, d.metric_date
    ) s
    where followers_total is not null
    order by platform, metric_date desc
  ),
  top_by_gain as (
    select d.platform, d.meta_post_id, sum(coalesce(d.reach_gained,0)) as reach_gained_in_period,
           sum(coalesce(d.likes_gained,0)) as likes_gained_in_period
    from xp_v_post_daily_deltas d
    join xp_meta_posts p on p.asset_id = d.asset_id and p.meta_post_id = d.meta_post_id
    where d.client_id = p_client and d.snapshot_date between p_start and p_end
      and d.is_trusted and not p.is_story
    group by d.platform, d.meta_post_id
  ),
  top_posts as (
    select t.platform,
           jsonb_agg(jsonb_build_object(
             'post_id', t.meta_post_id,
             'caption', left(coalesce(p.caption,''), 140),
             'permalink', p.permalink,
             'thumbnail_url', p.thumbnail_url,
             'media_type', p.media_type,
             'format', fn_content_format(p.platform, p.media_type, p.media_product_type),
             'publish_date', p.publish_date,
             'reach_gained_in_period', t.reach_gained_in_period,
             'likes_gained_in_period', t.likes_gained_in_period,
             'reach_as_of_end', (fn_post_as_of(p.asset_id, p.meta_post_id, p_end)).reach,
             'likes_as_of_end', (fn_post_as_of(p.asset_id, p.meta_post_id, p_end)).likes
           ) order by t.reach_gained_in_period desc) filter (where rn <= 5) as items
    from (select *, row_number() over (partition by platform order by reach_gained_in_period desc) rn from top_by_gain) t
    join xp_meta_posts p on p.client_id = p_client and p.meta_post_id = t.meta_post_id
    group by t.platform
  ),
  per_platform as (
    select pl.platform,
           jsonb_build_object(
             'posts_published', coalesce(pub.posts_published,0),

             -- a metric is a number only when we observed enough days to derive one
             'content', case when coalesce(cv.post_days_in_period,0) < 2 then
               jsonb_build_object(
                 'reach_gained', null, 'impressions_gained', null, 'views_gained', null,
                 'likes_gained', null, 'comments_gained', null, 'shares_gained', null,
                 'saves_gained', null, 'video_views_gained', null, 'interactions_gained', null,
                 'tracked', false,
                 'reason', case
                   when h.post_data_from is null
                     then 'No post snapshots have ever been taken for this platform.'
                   when h.post_data_from > p_end
                     then 'Post tracking began on ' || h.post_data_from || ', after this period ended.'
                   when coalesce(cv.post_days_in_period,0) = 0
                     then 'No post snapshots fall inside this period; tracking began on ' || h.post_data_from || '.'
                   else 'Only one snapshot day falls inside this period, so no day-over-day gain can be derived.'
                 end)
             else
               jsonb_build_object(
                 'reach_gained', coalesce(g.reach_gained,0),
                 'impressions_gained', coalesce(g.impressions_gained,0),
                 'views_gained', coalesce(g.views_gained,0),
                 'likes_gained', coalesce(g.likes_gained,0),
                 'comments_gained', coalesce(g.comments_gained,0),
                 'shares_gained', coalesce(g.shares_gained,0),
                 'saves_gained', coalesce(g.saves_gained,0),
                 'video_views_gained', coalesce(g.video_views_gained,0),
                 'interactions_gained', coalesce(g.interactions_gained,0),
                 'tracked', true, 'reason', null)
             end,

             -- always available: what the posts published in this window have earned in total
             'lifetime', case when lf.posts is null then null else jsonb_build_object(
                 'as_of', lf.as_of,
                 'posts', lf.posts, 'reach', lf.reach, 'views', lf.views,
                 'interactions', lf.interactions, 'likes', lf.likes, 'comments', lf.comments,
                 'shares', lf.shares, 'saves', lf.saves,
                 'avg_reach', lf.avg_reach, 'avg_engagement_rate', lf.avg_engagement_rate,
                 'basis', 'lifetime totals of posts published in this period, as of the last snapshot')
             end,

             'engagement', jsonb_build_object(
               'rate_on_reach',      fn_er(lf.interactions, lf.reach),
               'rate_on_followers',  fn_er(lf.interactions, fe.followers_total),
               'rate_on_reach_in_period',
                 case when coalesce(cv.post_days_in_period,0) >= 2
                      then fn_er(g.interactions_gained::bigint, g.reach_gained::bigint) end,
               'avg_per_post',       lf.avg_engagement_rate,
               'definition', 'interactions / reach * 100; interactions = total_interactions or '
                             'likes+comments+shares+saves'),

             'coverage', jsonb_build_object(
               'post_days_in_period', coalesce(cv.post_days_in_period,0),
               'posts_observed',      coalesce(cv.posts_observed,0),
               'post_data_from',      h.post_data_from,
               'account_days_in_period', coalesce(a.days_with_data,0),
               'days_in_period',      (p_end - p_start + 1),
               'account_complete',    coalesce(a.days_with_data,0) >= (p_end - p_start + 1)),

             'account', jsonb_build_object(
               'reach', a.account_reach, 'impressions', a.account_impressions, 'views', a.account_views,
               'page_views', a.page_views, 'profile_views', a.profile_views,
               'engagements', a.engagements, 'video_views', a.video_views,
               'follows', a.follows, 'unfollows', a.unfollows,
               'days_with_data', coalesce(a.days_with_data,0),
               'days_in_period', (p_end - p_start + 1)),

             'followers', jsonb_build_object(
               'start', fs.followers_total, 'start_observed_on', fs.metric_date,
               'start_is_measured', fs.is_observed,
               'end',   fe.followers_total, 'end_observed_on',   fe.metric_date,
               'end_is_measured', fe.is_observed,
               'net',   case when fs.followers_total is not null and fe.followers_total is not null
                             then fe.followers_total - fs.followers_total end),

             'top_posts', coalesce(tp.items, '[]'::jsonb)
           ) as body
    from plat pl
    left join pub   on pub.platform = pl.platform
    left join cover cv on cv.platform = pl.platform
    left join horizon h on h.platform = pl.platform
    left join gains g on g.platform = pl.platform
    left join life  lf on lf.platform = pl.platform
    left join acct  a on a.platform = pl.platform
    left join f_start fs on fs.platform = pl.platform
    left join f_end   fe on fe.platform = pl.platform
    left join top_posts tp on tp.platform = pl.platform
  )
  select jsonb_build_object(
    'client_id', p_client,
    'period', jsonb_build_object('start', p_start, 'end', p_end, 'timezone', v_tz),
    'is_running_period', p_end >= v_today,
    'data_available_from',         (select min(metric_date)   from xp_account_metric_snapshots where client_id = p_client),
    'account_data_available_from', (select min(metric_date)   from xp_account_metric_snapshots where client_id = p_client),
    'post_data_available_from',    (select min(snapshot_date) from xp_post_metric_snapshots
                                     where client_id = p_client and source in ('LIVE','BACKFILL')),
    'platforms', jsonb_object_agg(platform, body),
    'generated_at', now()
  ) into v_out
  from per_platform;

  return v_out;
end $$;

comment on function fn_client_period_summary(uuid, date, date) is
  'Period rollup. content.* is the day-over-day gain and is null when the window was not tracked. '
  'lifetime.* is the total earned by posts published in the window and is always available. '
  'engagement.* is computed from lifetime unless the window was fully tracked.';

-- =====================================================================
-- 13. Verification (run these after the migration)
-- =====================================================================
-- select jsonb_pretty(fn_format_breakdown((select id from xp_clients limit 1),
--          date_trunc('month', current_date - interval '1 month')::date,
--          (date_trunc('month', current_date) - interval '1 day')::date));
-- select jsonb_pretty(fn_audience((select id from xp_clients limit 1)));
-- select jsonb_pretty(fn_posting_pattern((select id from xp_clients limit 1), current_date - 60, current_date));
-- select jsonb_array_length(fn_content_table((select id from xp_clients limit 1), current_date - 60, current_date));
-- select jsonb_pretty(fn_comments_digest((select id from xp_clients limit 1), current_date - 60, current_date, 5));
-- select jsonb_pretty(fn_stories_summary((select id from xp_clients limit 1), current_date - 30, current_date));
-- select jsonb_pretty(fn_hashtag_performance((select id from xp_clients limit 1), current_date - 180, current_date));
-- select jsonb_pretty(fn_compare_periods((select id from xp_clients limit 1),
--          date_trunc('month', current_date)::date, current_date));


-- ===================================================================
-- 0007_frozen_follower_estimates.sql
-- ===================================================================
-- migrations_0007_frozen_follower_estimates.sql
-- Idempotent. Safe to re-run. Run AFTER 0005 and 0006.
--
-- DECISION (2026-09-08, Yousuf): option B.
--   A closed day must return the same follower number forever, even for days Meta never gave us
--   a real total for. So the estimate is computed ONCE, written into the row, and frozen — not
--   recomputed on every read.
--
-- WHY AN ESTIMATE EXISTS AT ALL
-- ----------------------------
-- Meta serves no historical Instagram follower total. Not at any endpoint, not at any API
-- version. `follower_count` is the day's gain; the only absolute reading is today's profile
-- field. For every IG day before we started reading that field there is nothing to observe —
-- only something to infer, from the gains either side of a real measurement.
--
-- THE CONTRACT THIS MIGRATION ENFORCES
-- ------------------------------------
--   followers_total          measured. Never written by this migration. Frozen by 0001's trigger.
--   followers_total_frozen   inferred, written EXACTLY ONCE per row, then immutable.
--   followers_estimate_method  how it was inferred, and how much slop is in it.
--
-- The immutability trigger is narrowed rather than bypassed: it now permits one specific
-- transition — a null followers_total_frozen becoming non-null, with every other column
-- unchanged — and refuses everything else, including a second write of the same column. There
-- is no session flag involved, so nothing can be left switched on by accident.
--
-- ORDER MATTERS: run this AFTER the full backfill. The estimate is only as good as the daily
-- change data present when it is frozen, and by design it is never revisited.

-- ---------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------
alter table xp_account_metric_snapshots
  add column if not exists followers_total_frozen    bigint,
  add column if not exists followers_estimate_method text,
  add column if not exists followers_estimated_at    timestamptz;

comment on column xp_account_metric_snapshots.followers_total_frozen is
  'Inferred follower total for a day Meta never reported one. Written once by '
  'fn_freeze_follower_estimates() and immutable thereafter. Null means either the day was '
  'measured (see followers_total) or it has not been frozen yet.';

comment on column xp_account_metric_snapshots.followers_estimate_method is
  'Provenance of followers_total_frozen: which measured day it was anchored on, in which '
  'direction, and how many of the intervening days reported gross adds instead of net change.';

create index if not exists xp_ams_unfrozen_idx
  on xp_account_metric_snapshots (asset_id, metric_date)
  where followers_total is null and followers_total_frozen is null;

-- ---------------------------------------------------------------------
-- 2. Narrowed immutability guard
-- ---------------------------------------------------------------------
-- Replaces 0001's version on all three snapshot tables (the triggers already point at this
-- function by name, so no trigger changes are needed).
--
-- Allowed on a finalized row:
--   * the session has explicitly opted in (as before — deliberate, and logged by convention)
--   * the FIRST write of a follower estimate, changing nothing else
-- Refused: everything else, including overwriting an estimate that already exists.
create or replace function fn_guard_final_snapshot() returns trigger
language plpgsql as $$
declare
  old_j    jsonb;
  new_j    jsonb;
  est_cols text[] := array['followers_total_frozen', 'followers_estimate_method', 'followers_estimated_at'];
  c        text;
begin
  -- open day: anything goes
  if not old.is_final then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  -- explicit, deliberate override (migrations only)
  if current_setting('app.allow_snapshot_rewrite', true) = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  -- the one narrow exception: first write of an inferred follower total
  if tg_op = 'UPDATE'
     and (to_jsonb(old) ->> 'followers_total_frozen') is null
     and (to_jsonb(new) ->> 'followers_total_frozen') is not null then
    old_j := to_jsonb(old);
    new_j := to_jsonb(new);
    foreach c in array est_cols loop
      old_j := old_j - c;
      new_j := new_j - c;
    end loop;
    if old_j = new_j then
      return new;   -- nothing else moved
    end if;
    raise exception
      'Refused: a follower estimate may be written to closed day %, but no other column may change.',
      coalesce(to_jsonb(old)->>'metric_date', to_jsonb(old)->>'snapshot_date');
  end if;

  raise exception
    'Row in % for % is finalized and immutable. Set app.allow_snapshot_rewrite=on to override.',
    tg_table_name, coalesce(to_jsonb(old)->>'snapshot_date', to_jsonb(old)->>'metric_date');
end $$;

comment on function fn_guard_final_snapshot() is
  'Immutability guard for finalized snapshots. Permits exactly one narrow transition: the first '
  'write of followers_total_frozen (with no other column changing). A second write of that '
  'column is refused, which is what makes a frozen estimate permanent.';

-- ---------------------------------------------------------------------
-- 3. fn_freeze_follower_estimates — the write-once pass
-- ---------------------------------------------------------------------
-- Freezes every CLOSED day that has no measured total and no estimate yet. Days that were
-- measured are left alone. Today is left alone (it is still open, and it normally has a real
-- profile reading anyway).
--
-- Skips assets that have never had a full backfill unless p_force, because freezing before the
-- backfill would permanently bake in gaps that the backfill was about to fill.
create or replace function fn_freeze_follower_estimates(
  p_client uuid default null,
  p_force  boolean default false)
returns table(
  asset_name   text,
  platform     text,
  days_frozen  bigint,
  days_left    bigint,
  anchored_on  date,
  skipped      text)
language plpgsql as $$
declare
  r        record;
  n        bigint;
  v_left   bigint;
  v_anchor date;
begin
  for r in
    select a.id, a.name, a.platform, a.client_id, a.last_full_backfill_at,
           coalesce(c.timezone, 'UTC') as tz
    from xp_meta_assets a
    join xp_clients c on c.id = a.client_id
    where (p_client is null or a.client_id = p_client)
      and a.status <> 'REMOVED'
    order by a.platform, a.name
  loop
    asset_name := r.name; platform := r.platform;
    days_frozen := 0; days_left := 0; anchored_on := null; skipped := null;

    if r.last_full_backfill_at is null and not p_force then
      skipped := 'no full backfill yet — run the backfill first, or call with p_force => true';
      return next;
      continue;
    end if;

    select max(metric_date) into v_anchor
    from xp_account_metric_snapshots
    where asset_id = r.id and followers_total is not null;

    if v_anchor is null then
      skipped := 'no measured follower total exists for this asset — nothing to anchor on';
      select count(*) into days_left from xp_account_metric_snapshots
      where asset_id = r.id and followers_total is null;
      return next;
      continue;
    end if;

    with base as (
      select s.id, s.metric_date, s.is_final, s.followers_total, s.followers_total_frozen,
             coalesce(
               case when s.follows_day is not null and s.unfollows_day is not null
                    then s.follows_day - s.unfollows_day end,
               case when s.fan_adds is not null and s.fan_removes is not null
                    then s.fan_adds - s.fan_removes end,
               s.followers_gained_day
             ) as chg,
             ((s.follows_day is not null and s.unfollows_day is not null)
              or (s.fan_adds is not null and s.fan_removes is not null)) as is_net
      from xp_account_metric_snapshots s
      where s.asset_id = r.id
    ),
    cum as (
      select b.*,
             sum(coalesce(b.chg, 0)) over (order by b.metric_date
               rows between unbounded preceding and current row)                as cc,
             count(*) filter (where not b.is_net) over (order by b.metric_date
               rows between unbounded preceding and current row)                as gross_n,
             count(b.followers_total) over (order by b.metric_date
               rows between unbounded preceding and current row)                as grp_back,
             count(b.followers_total) over (order by b.metric_date desc
               rows between unbounded preceding and current row)                as grp_fwd
      from base b
    ),
    anch as (
      select c2.*,
             max(c2.followers_total) filter (where c2.followers_total is not null)
               over (partition by c2.grp_back)                                  as back_total,
             max(c2.cc)             filter (where c2.followers_total is not null)
               over (partition by c2.grp_back)                                  as back_cc,
             max(c2.gross_n)        filter (where c2.followers_total is not null)
               over (partition by c2.grp_back)                                  as back_gross,
             max(c2.metric_date)    filter (where c2.followers_total is not null)
               over (partition by c2.grp_back)                                  as back_date,
             max(c2.followers_total) filter (where c2.followers_total is not null)
               over (partition by c2.grp_fwd)                                   as fwd_total,
             max(c2.cc)             filter (where c2.followers_total is not null)
               over (partition by c2.grp_fwd)                                   as fwd_cc,
             max(c2.gross_n)        filter (where c2.followers_total is not null)
               over (partition by c2.grp_fwd)                                   as fwd_gross,
             max(c2.metric_date)    filter (where c2.followers_total is not null)
               over (partition by c2.grp_fwd)                                   as fwd_date
      from cum c2
    ),
    est as (
      select a2.id,
             case
               when a2.back_total is not null then (a2.back_total + (a2.cc - a2.back_cc))::bigint
               when a2.fwd_total  is not null then (a2.fwd_total  - (a2.fwd_cc - a2.cc))::bigint
             end as est,
             case
               when a2.back_total is not null then
                 'forward_from_' || a2.back_date ||
                 case when (a2.gross_n - a2.back_gross) > 0
                      then ' (' || (a2.gross_n - a2.back_gross) || ' gross-only days)'
                      else ' (net)' end
               when a2.fwd_total is not null then
                 'backward_from_' || a2.fwd_date ||
                 case when (a2.fwd_gross - a2.gross_n) > 0
                      then ' (' || (a2.fwd_gross - a2.gross_n) || ' gross-only days)'
                      else ' (net)' end
             end as method
      from anch a2
      where a2.followers_total is null
        and a2.followers_total_frozen is null
        and a2.is_final                       -- closed days only
    ),
    upd as (
      update xp_account_metric_snapshots t
         set followers_total_frozen    = e.est,
             followers_estimate_method = e.method,
             followers_estimated_at    = now()
      from est e
      where t.id = e.id
        and e.est is not null
        and e.est >= 0
        and t.followers_total_frozen is null   -- belt and braces; the trigger enforces it too
      returning 1
    )
    select count(*) into n from upd;

    select count(*) into v_left
    from xp_account_metric_snapshots
    where asset_id = r.id and followers_total is null and followers_total_frozen is null and is_final;

    days_frozen := n;
    days_left   := v_left;
    anchored_on := v_anchor;
    return next;
  end loop;
end $$;

comment on function fn_freeze_follower_estimates(uuid, boolean) is
  'Write-once pass: gives every closed day without a measured follower total a frozen estimate. '
  'Never revisits a day it has already frozen. Run it after a full backfill and after '
  'fn_finalize_snapshots(); the sync calls it automatically.';

-- ---------------------------------------------------------------------
-- 4. xp_v_account_daily v3 — frozen first, live inference only for open days
-- ---------------------------------------------------------------------
-- A closed day now reads from stored values only, so it cannot drift. The live inference
-- survives solely for today and for any closed day not yet frozen, and is labelled as such.
drop view if exists xp_v_client_day_summary;
drop view if exists xp_v_account_daily;

create view xp_v_account_daily as
with base as (
  select a.*,
         coalesce(
           case when a.follows_day is not null and a.unfollows_day is not null
                then a.follows_day - a.unfollows_day end,
           case when a.fan_adds is not null and a.fan_removes is not null
                then a.fan_adds - a.fan_removes end,
           a.followers_gained_day
         ) as followers_change_reported
  from xp_account_metric_snapshots a
),
grouped as (
  select b.*,
         sum(coalesce(b.followers_change_reported, 0))
           over (partition by b.asset_id order by b.metric_date
                 rows between unbounded preceding and current row)          as cum_change,
         count(b.followers_total)
           over (partition by b.asset_id order by b.metric_date
                 rows between unbounded preceding and current row)          as grp_back,
         count(b.followers_total)
           over (partition by b.asset_id order by b.metric_date desc
                 rows between unbounded preceding and current row)          as grp_fwd
  from base b
),
anchored as (
  select g.*,
         max(g.followers_total) filter (where g.followers_total is not null)
           over (partition by g.asset_id, g.grp_back)                       as anchor_back_total,
         max(g.cum_change)      filter (where g.followers_total is not null)
           over (partition by g.asset_id, g.grp_back)                       as anchor_back_cum,
         max(g.followers_total) filter (where g.followers_total is not null)
           over (partition by g.asset_id, g.grp_fwd)                        as anchor_fwd_total,
         max(g.cum_change)      filter (where g.followers_total is not null)
           over (partition by g.asset_id, g.grp_fwd)                        as anchor_fwd_cum
  from grouped g
)
select
  a.id, a.client_id, a.asset_id, a.platform, a.metric_date,
  a.followers_total, a.fans_total, a.following_total, a.media_count,
  a.impressions, a.reach, a.views, a.page_views, a.profile_views, a.engagements,
  a.likes, a.comments, a.shares, a.saves, a.replies, a.video_views,
  a.accounts_engaged, a.website_clicks, a.profile_link_taps,
  a.follows_day, a.unfollows_day, a.fan_adds, a.fan_removes,
  a.followers_gained_day, a.reactions, a.online_followers, a.extra, a.raw,
  a.source, a.is_final, a.collected_at,
  a.followers_total_frozen, a.followers_estimate_method, a.followers_estimated_at,

  -- unchanged contract: the delta between two MEASURED totals
  a.followers_total - lag(a.followers_total) over w                          as followers_gained_observed,
  lag(a.metric_date) over w                                                  as prev_metric_date,

  a.followers_change_reported,
  (a.followers_total is not null)                                            as followers_total_is_observed,

  -- the number to plot
  coalesce(
    a.followers_total,
    a.followers_total_frozen,
    case when a.anchor_back_total is not null
         then a.anchor_back_total + (a.cum_change - a.anchor_back_cum) end,
    case when a.anchor_fwd_total is not null
         then a.anchor_fwd_total - (a.anchor_fwd_cum - a.cum_change) end
  )                                                                          as followers_total_est,

  -- and where that number came from
  case
    when a.followers_total is not null        then 'MEASURED'
    when a.followers_total_frozen is not null then 'FROZEN_ESTIMATE'
    when a.anchor_back_total is not null
      or a.anchor_fwd_total  is not null      then 'LIVE_ESTIMATE'
    else 'UNKNOWN'
  end                                                                        as followers_total_basis,

  -- true when this day's answer can never change again
  (a.is_final and (a.followers_total is not null or a.followers_total_frozen is not null))
                                                                             as followers_total_is_settled,

  coalesce(a.followers_total - lag(a.followers_total) over w,
           a.followers_change_reported)                                      as followers_gained
from anchored a
window w as (partition by a.asset_id order by a.metric_date);

comment on view xp_v_account_daily is
  'Account snapshots plus a continuous follower series. followers_total_basis says whether a '
  'point was MEASURED, a FROZEN_ESTIMATE (written once, permanent) or a LIVE_ESTIMATE (an open '
  'day, or a closed day awaiting fn_freeze_follower_estimates). followers_total_is_settled is '
  'true when the answer for that day can never change again.';

create view xp_v_client_day_summary as
with post_gains as (
  select client_id, platform, snapshot_date as d,
         sum(coalesce(reach_gained,0))        as post_reach_gained,
         sum(coalesce(impressions_gained,0))  as post_impressions_gained,
         sum(coalesce(views_gained,0))        as post_views_gained,
         sum(coalesce(likes_gained,0))        as likes_gained,
         sum(coalesce(comments_gained,0))     as comments_gained,
         sum(coalesce(shares_gained,0))       as shares_gained,
         sum(coalesce(saves_gained,0))        as saves_gained,
         count(*) filter (where is_first_observation) as posts_first_seen
  from xp_v_post_daily_deltas
  group by client_id, platform, snapshot_date
),
acct as (
  select client_id, platform, metric_date as d,
         sum(followers_total_est) as followers_total,
         sum(followers_gained)    as followers_gained,
         bool_and(followers_total_is_settled) as followers_settled,
         sum(reach) as account_reach, sum(impressions) as account_impressions,
         sum(views) as account_views, sum(page_views) as page_views, sum(profile_views) as profile_views,
         sum(engagements) as engagements, sum(video_views) as account_video_views,
         sum(follows_day) as follows_day, sum(unfollows_day) as unfollows_day,
         bool_and(is_final) as is_final
  from xp_v_account_daily
  group by client_id, platform, metric_date
),
posts_pub as (
  select client_id, platform, (publish_date at time zone 'UTC')::date as d, count(*) as posts_published
  from xp_meta_posts where not is_story group by 1,2,3
)
select coalesce(pg.client_id, ac.client_id, pp.client_id) as client_id,
       coalesce(pg.platform,  ac.platform,  pp.platform)  as platform,
       coalesce(pg.d, ac.d, pp.d) as day,
       pp.posts_published, pg.posts_first_seen,
       pg.post_reach_gained, pg.post_impressions_gained, pg.post_views_gained,
       pg.likes_gained, pg.comments_gained, pg.shares_gained, pg.saves_gained,
       ac.followers_total, ac.followers_gained, ac.followers_settled,
       ac.follows_day, ac.unfollows_day,
       ac.account_reach, ac.account_impressions, ac.account_views,
       ac.page_views, ac.profile_views, ac.engagements, ac.account_video_views,
       ac.is_final
from post_gains pg
full join acct ac      on ac.client_id = pg.client_id and ac.platform = pg.platform and ac.d = pg.d
full join posts_pub pp on pp.client_id = coalesce(pg.client_id, ac.client_id)
                      and pp.platform  = coalesce(pg.platform,  ac.platform)
                      and pp.d         = coalesce(pg.d, ac.d);

-- ---------------------------------------------------------------------
-- 5. fn_followers_series v3 — carries the basis through to the caller
-- ---------------------------------------------------------------------
drop function if exists fn_followers_series(uuid, date, date);

create function fn_followers_series(p_client uuid, p_start date, p_end date)
returns table(
  platform          text,
  metric_date       date,
  followers_total   bigint,
  is_observed       boolean,
  basis             text,
  is_settled        boolean,
  followers_gained  bigint,
  is_final          boolean
)
language sql stable as $$
  select d.platform,
         d.metric_date,
         sum(d.followers_total_est)::bigint,
         bool_and(d.followers_total_is_observed),
         case when bool_and(d.followers_total_basis = 'MEASURED')        then 'MEASURED'
              when bool_or (d.followers_total_basis = 'LIVE_ESTIMATE')   then 'LIVE_ESTIMATE'
              when bool_or (d.followers_total_basis = 'UNKNOWN')         then 'UNKNOWN'
              else 'FROZEN_ESTIMATE' end,
         bool_and(d.followers_total_is_settled),
         sum(d.followers_gained)::bigint,
         bool_and(d.is_final)
  from xp_v_account_daily d
  where d.client_id = p_client
    and d.metric_date between p_start and p_end
  group by d.platform, d.metric_date
  order by d.platform, d.metric_date
$$;

comment on function fn_followers_series(uuid, date, date) is
  'Follower series per platform. basis: MEASURED | FROZEN_ESTIMATE | LIVE_ESTIMATE | UNKNOWN. '
  'is_settled = true means that day''s answer is permanent. Quote the basis to the client rather '
  'than presenting an inference as a measurement.';

-- ---------------------------------------------------------------------
-- 6. fn_follower_integrity — the proof, runnable at any time
-- ---------------------------------------------------------------------
-- Answers "can Aug 5 still change?" per platform, and shows the frozen days' provenance.
create or replace function fn_follower_integrity(p_client uuid)
returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'checked_at', now(),
    'by_platform', coalesce(jsonb_object_agg(platform, body), '{}'::jsonb))
  from (
    select d.platform,
           jsonb_build_object(
             'days',            count(*),
             'measured',        count(*) filter (where d.followers_total_basis = 'MEASURED'),
             'frozen_estimate', count(*) filter (where d.followers_total_basis = 'FROZEN_ESTIMATE'),
             'live_estimate',   count(*) filter (where d.followers_total_basis = 'LIVE_ESTIMATE'),
             'unknown',         count(*) filter (where d.followers_total_basis = 'UNKNOWN'),
             'settled_closed_days',
               count(*) filter (where d.is_final and d.followers_total_is_settled),
             'unsettled_closed_days',
               count(*) filter (where d.is_final and not d.followers_total_is_settled),
             'first_measured_on', min(d.metric_date) filter (where d.followers_total is not null),
             'range', jsonb_build_object('min', min(d.followers_total_est),
                                         'max', max(d.followers_total_est))
           ) as body
    from xp_v_account_daily d
    where d.client_id = p_client
    group by d.platform
  ) q
$$;

comment on function fn_follower_integrity(uuid) is
  'unsettled_closed_days must be 0. Anything above 0 is a closed day whose follower number could '
  'still change on the next read — run fn_freeze_follower_estimates().';

-- ---------------------------------------------------------------------
-- 7. Verification
-- ---------------------------------------------------------------------
-- Freeze (after the backfill):
--   select * from fn_freeze_follower_estimates();
--
-- Prove it is settled — unsettled_closed_days must be 0:
--   select jsonb_pretty(fn_follower_integrity((select id from xp_clients limit 1)));
--
-- Prove Aug 5 cannot move. Run this twice, an hour apart; the number must be identical:
--   select platform, metric_date, followers_total, basis, is_settled
--   from fn_followers_series((select id from xp_clients limit 1), '2026-08-05', '2026-08-05');
--
-- Prove the guard actually refuses a second write (this SHOULD raise an exception):
--   update xp_account_metric_snapshots set followers_total_frozen = 999999
--   where id = (select id from xp_account_metric_snapshots
--               where followers_total_frozen is not null and is_final limit 1);
--
-- See the provenance of the frozen days:
--   select metric_date, followers_total_frozen, followers_estimate_method
--   from xp_account_metric_snapshots
--   where followers_total_frozen is not null order by metric_date limit 20;


-- ===================================================================
-- 0008_anchor_and_lag.sql
-- ===================================================================
-- =====================================================================
-- 0008 · Anchor provenance and a finalization lag that respects Meta's clocks
-- =====================================================================
-- Run AFTER 0006 and 0007. Safe to run before or after the full backfill, and safe to re-run.
--
-- Two problems, one root cause: we were labelling days with the CLIENT's calendar while Meta
-- labels them with its own.
--
--   1. The only observable Instagram follower total is the profile counter, read at sync time.
--      The cron ran at 03:30 Asia/Dhaka = 21:30 UTC *the previous day*, and the reading was
--      stored against the Dhaka date — a UTC day that had not begun. 0007 then froze that
--      misalignment permanently. Fixed in code (anchorDateFor) plus the column added below,
--      so that from now on every follower total records WHEN it was actually read.
--
--   2. fn_finalize_snapshots closed an account day once the CLIENT's date advanced past it by
--      one. For Asia/Dhaka (UTC+6) that happened to be safe. For any client behind UTC it would
--      close a UTC day before that day had ended, making an incomplete day permanent. The lag is
--      now two days, which covers every timezone Meta uses plus a day of late-data grace.

-- ---------------------------------------------------------------------
-- 1. Provenance for the follower anchor
-- ---------------------------------------------------------------------
alter table xp_account_metric_snapshots
  add column if not exists followers_observed_at timestamptz;

comment on column xp_account_metric_snapshots.followers_observed_at is
  'Wall-clock instant at which followers_total was read from the profile. The row''s metric_date '
  'is the insights day that reading describes (UTC for IG, America/Los_Angeles for FB); this '
  'column is the evidence for that claim. Null on rows whose follower total came from a time '
  'series, from v1, or from an inference.';

-- HISTORICAL ROWS ARE DELIBERATELY LEFT NULL. An earlier draft of this migration backfilled them
-- with the end of the day they were attributed to. That was wrong twice over:
--
--   1. It updates finalized rows, so fn_guard_final_snapshot() refuses it — correctly. Getting
--      past it would have meant setting app.allow_snapshot_rewrite=on, i.e. switching off the
--      immutability guarantee to write a value we invented.
--   2. Worse, it would have stamped exactly the mis-anchored rows this migration exists to catch
--      as 'ok'. The pre-fix readings were taken at 21:30 UTC the day BEFORE the day they are
--      labelled with; writing "read at the end of that day" over them launders the bug out of
--      the audit trail.
--
-- Null therefore means "we did not record when this was read", which is the truth. Where a real
-- read time can be recovered, fn_anchor_health() falls back to collected_at and says so — a read,
-- not a write. Nothing about a closed day changes.

-- ---------------------------------------------------------------------
-- 2. Finalization lag
-- ---------------------------------------------------------------------
-- Invariant: a row may only be finalized once every timezone Meta uses for it has fully
-- elapsed, plus one day of grace for late-arriving data. Max |offset| from UTC is 14 hours,
-- so one day of lag is not always enough; two always is.
create or replace function fn_finalize_snapshots() returns table(table_name text, rows_finalized bigint)
language plpgsql as $$
declare n bigint;
begin
  -- Post snapshots are labelled with OUR read date, not a Meta day boundary, so one day is right.
  update xp_post_metric_snapshots p set is_final = true
  from xp_clients c where p.client_id = c.id and p.is_final = false and p.snapshot_date < fn_today(c.timezone);
  get diagnostics n = row_count; table_name := 'xp_post_metric_snapshots'; rows_finalized := n; return next;

  -- Account snapshots are labelled with META's day (UTC / America/Los_Angeles). Two days.
  update xp_account_metric_snapshots p set is_final = true
  from xp_clients c where p.client_id = c.id and p.is_final = false and p.metric_date < fn_today(c.timezone) - 2;
  get diagnostics n = row_count; table_name := 'xp_account_metric_snapshots'; rows_finalized := n; return next;

  update xp_audience_snapshots p set is_final = true
  from xp_clients c where p.client_id = c.id and p.is_final = false and p.snapshot_date < fn_today(c.timezone);
  get diagnostics n = row_count; table_name := 'xp_audience_snapshots'; rows_finalized := n; return next;
end $$;

comment on function fn_finalize_snapshots() is
  'Closes rows for days that can no longer change. Account rows lag by two days because their '
  'metric_date is a Meta insights day (UTC for IG, America/Los_Angeles for FB), not a client '
  'calendar day: a one-day lag would close a UTC day early for any client behind UTC.';

-- ---------------------------------------------------------------------
-- 3. fn_anchor_health — is the follower anchor landing on the right day?
-- ---------------------------------------------------------------------
-- Read-only. Answers one question per row: was this follower total read INSIDE the insights day
-- it is attributed to?
--
--   basis = 'measured'      followers_observed_at, written by post-0008 syncs. Trustworthy.
--   basis = 'collected_at'  no recorded read time, so the row's write time is used instead. Close
--                           enough to be diagnostic — a profile-only row is written seconds after
--                           the read — but it moves on every re-sync of an open day, so treat it
--                           as evidence, not proof.
--   basis = 'v1_import'     collected_at is the migration's own clock and says nothing about when
--                           Meta was read. Unknowable; reported as such.
--
-- `hours_before_day_end` is how long before the day ended the reading was taken. Between 0 and
-- ~24 is normal; NEGATIVE means it was read after the day ended (stale but harmless); greater
-- than 24 means it was read before the day began — the bug this migration exists to catch.
create or replace function fn_anchor_health(p_client uuid default null, p_days int default 14)
returns table(
  asset_name            text,
  platform              text,
  metric_date           date,
  followers_total       bigint,
  observed_at           timestamptz,
  basis                 text,
  hours_before_day_end  numeric,
  verdict               text)
language sql stable as $$
  with x as (
    select a.name as asset_name, s.platform, s.metric_date, s.followers_total,
           coalesce(s.followers_observed_at, s.collected_at) as ts,
           case when s.followers_observed_at is not null then 'measured'
                when s.source = 'MIGRATED'                 then 'v1_import'
                else 'collected_at' end                    as basis,
           (s.metric_date::timestamp at time zone
             case when s.platform = 'IG' then 'UTC' else 'America/Los_Angeles' end)     as day_start,
           ((s.metric_date + 1)::timestamp at time zone
             case when s.platform = 'IG' then 'UTC' else 'America/Los_Angeles' end)     as day_end
    from xp_account_metric_snapshots s
    join xp_meta_assets a on a.id = s.asset_id
    where s.followers_total is not null
      and (p_client is null or s.client_id = p_client)
      and s.metric_date >= current_date - p_days
  )
  select x.asset_name, x.platform, x.metric_date, x.followers_total, x.ts, x.basis,
         round(extract(epoch from (x.day_end - x.ts)) / 3600.0, 2),
         case
           when x.basis = 'v1_import' then 'unknown — imported from v1, no read time exists'
           when x.ts < x.day_start    then 'WRONG DAY — read before the day began'
           when x.ts > x.day_end      then 'LATE — read after the day ended'
           else 'ok'
         end
  from x
  order by x.platform, x.metric_date desc;
$$;

comment on function fn_anchor_health(uuid, int) is
  'Checks that every measured follower total was read inside the insights day it is attributed '
  'to. WRONG DAY on a post-0008 row (basis = measured) is a live bug: the cron is running outside '
  'the anchor window. WRONG DAY on a pre-0008 row (basis = collected_at) is the historical '
  'misalignment 0008 fixes going forward; those rows are closed and are not rewritten.';

-- ---------------------------------------------------------------------
-- 3b. fn_proc_exists — check a function is installed without invoking it
-- ---------------------------------------------------------------------
-- verify.js used to prove fn_freeze_follower_estimates() existed by CALLING it, which is how a
-- read-only gate script ended up writing to the database.
create or replace function fn_proc_exists(p_name text)
returns boolean
language sql stable as $$
  select exists (select 1 from pg_proc where proname = p_name);
$$;

-- ---------------------------------------------------------------------
-- 4. Verification (run these now)
-- ---------------------------------------------------------------------
-- select * from fn_anchor_health(null, 60);
--   expect: pre-0008 IG rows show basis 'collected_at' and may read WRONG DAY — that is the bug,
--   already frozen into closed days, and it is not rewritten. Every row written from the first
--   corrected cron run onward must show basis 'measured' and verdict 'ok'.
-- select * from fn_finalize_snapshots();
-- select max(metric_date) filter (where is_final), max(metric_date)
--   from xp_account_metric_snapshots;                          -- expect: final max = overall max - 2..3


-- ===================================================================
-- 0009_per_metric_coverage.sql
-- ===================================================================
-- ============================================================================
-- 0009 · Per-metric account coverage + the day-attribution convention record
-- ============================================================================
--
-- TWO PROBLEMS, ONE MIGRATION. Both surfaced on 2026-09-09.
--
-- (a) fn_client_period_summary counted DAYS WITH A ROW, not days with a VALUE:
--
--         count(*) as days_with_data
--
--     sum(views) correctly skips nulls, but the denominator counted every row in the
--     period and was then attached to every metric alike. For Instagram, 1–10 September
--     that produced "469 views across 9 of the 10 days" when views existed on exactly
--     TWO days. The number was right; the assurance beside it was four times too generous.
--
--     Before C-2 the system said nothing about coverage. After C-2 it states a confident,
--     specific, wrong denominator — which is worse than silence, because a client can act
--     on it. The content block already gets this right (post_days_in_period, with a
--     tracked:false branch and a written reason); the account block never did.
--
--     count(col) ignores nulls. That is the whole fix.
--
-- (b) Instagram total_value metrics written before 2026-09-08 are attributed one day
--     later than the day they describe (see SESSION_FINDINGS F-3). Those rows are FROZEN
--     and must stay frozen — rewriting them would launder a bug out of the audit trail,
--     which is precisely what the immutability guard exists to prevent. So this migration
--     RECORDS the convention rather than repairing the data, and nothing in
--     xp_account_metric_snapshots is touched.
--
-- Backwards compatible: every existing key keeps its name, type and meaning. New keys are
-- added alongside. template.js, narrative.js and chat.js continue to work unchanged; they
-- simply gain a more honest denominator when they are ready to read it.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0009-b · xp_data_conventions
-- ---------------------------------------------------------------------------
-- What was true, over which span. Read at query time so a period that straddles a change
-- can say so, instead of silently mixing two conventions into one total.

create table if not exists xp_data_conventions (
  id              bigserial primary key,
  platform        text        not null check (platform in ('IG','FB')),
  metric_family   text        not null,
  convention      text        not null,
  effective_from  date        not null,
  effective_to    date,                       -- null = still in force
  note            text        not null,
  recorded_at     timestamptz not null default now()
);

comment on table xp_data_conventions is
  'Non-obvious facts about how stored values should be read, by platform, metric family and '
  'date span. Written when a convention changes; never used to modify snapshot rows. '
  'Frozen days keep whatever they were given — this table explains them.';

create index if not exists xp_ix_data_conventions_lookup
  on xp_data_conventions (platform, metric_family, effective_from);

insert into xp_data_conventions (platform, metric_family, convention, effective_from, effective_to, note)
select 'IG', 'total_value', 'DAY_PLUS_ONE', date '2026-06-01', date '2026-09-07',
       'Instagram insights close at UTC-7 (midnight America/Los_Angeles), but the sync built '
       'total_value request windows from UTC midnights. Meta resolved the 7-hour straddle in '
       'favour of the earlier day, and the value was stored under the day that had been asked '
       'for. Every views / profile_views / total_interactions / likes / comments / shares / '
       'saves value in this span therefore describes the PRECEDING day. Reach is unaffected: '
       'it comes from the series endpoint, which reports its own dates. These rows are final '
       'and will not be corrected.'
where not exists (
  select 1 from xp_data_conventions
  where platform = 'IG' and metric_family = 'total_value' and convention = 'DAY_PLUS_ONE'
);

insert into xp_data_conventions (platform, metric_family, convention, effective_from, effective_to, note)
select 'IG', 'total_value', 'DAY_EXACT', date '2026-09-08', null,
       'Day windows are now taken from the end_time Meta stamps on each series bucket, with '
       'the window start nudged one second inside the day so the opening instant is not '
       'resolved backwards to the previous day. reach is requested down both the series and '
       'total_value paths every sync and the two must agree; a mismatch raises a '
       'day-attribution error on the run.'
where not exists (
  select 1 from xp_data_conventions
  where platform = 'IG' and metric_family = 'total_value' and convention = 'DAY_EXACT'
);

-- Convenience: which conventions touch a given span.
create or replace function fn_conventions_for(p_start date, p_end date)
returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'platform', platform, 'metric_family', metric_family, 'convention', convention,
           'effective_from', effective_from, 'effective_to', effective_to, 'note', note)
         order by platform, effective_from), '[]'::jsonb)
  from xp_data_conventions
  where effective_from <= p_end
    and (effective_to is null or effective_to >= p_start);
$$;

comment on function fn_conventions_for(date, date) is
  'Conventions in force at any point in [p_start, p_end]. A period returning more than one '
  'row for the same platform+family straddles a change and must say so in the report.';

-- ---------------------------------------------------------------------------
-- 0009-a · fn_client_period_summary v4 — per-metric account coverage
-- ---------------------------------------------------------------------------
-- Only two things differ from v3:
--   1. the acct CTE gains count(<col>) per metric, which ignores nulls
--   2. account.days_by_metric and coverage.account_days_by_metric expose them
-- Everything else is byte-for-byte v3.

create or replace function fn_client_period_summary(p_client uuid, p_start date, p_end date)
returns jsonb
language plpgsql stable as $fn$
declare
  v_tz    text;
  v_today date;
  v_out   jsonb;
begin
  select timezone into v_tz from xp_clients where id = p_client;
  v_today := fn_today(coalesce(v_tz, 'UTC'));

  with plat as (select unnest(array['IG','FB']) as platform),
  pub as (
    select platform, count(*) as posts_published
    from xp_meta_posts
    where client_id = p_client and not is_story and not is_deleted
      and (publish_date at time zone coalesce(v_tz,'UTC'))::date between p_start and p_end
    group by platform
  ),
  -- Observation coverage. Stories carry exactly one snapshot each and would otherwise inflate
  -- the count of "days we tracked posts".
  cover as (
    select s.platform,
           count(distinct s.snapshot_date) as post_days_in_period,
           count(distinct s.meta_post_id)  as posts_observed
    from xp_post_metric_snapshots s
    join xp_meta_posts p on p.asset_id = s.asset_id and p.meta_post_id = s.meta_post_id
    where s.client_id = p_client and s.snapshot_date between p_start and p_end
      and s.source in ('LIVE','BACKFILL') and not p.is_story
    group by s.platform
  ),
  horizon as (
    select s.platform, min(s.snapshot_date) as post_data_from
    from xp_post_metric_snapshots s
    join xp_meta_posts p on p.asset_id = s.asset_id and p.meta_post_id = s.meta_post_id
    where s.client_id = p_client and s.source in ('LIVE','BACKFILL') and not p.is_story
    group by s.platform
  ),
  gains as (
    select d.platform,
           sum(coalesce(d.reach_gained,0))       as reach_gained,
           sum(coalesce(d.impressions_gained,0)) as impressions_gained,
           sum(coalesce(d.views_gained,0))       as views_gained,
           sum(coalesce(d.likes_gained,0))       as likes_gained,
           sum(coalesce(d.comments_gained,0))    as comments_gained,
           sum(coalesce(d.shares_gained,0))      as shares_gained,
           sum(coalesce(d.saves_gained,0))       as saves_gained,
           sum(coalesce(d.video_views_gained,0)) as video_views_gained,
           sum(coalesce(d.interactions_gained,0)) as interactions_gained
    from xp_v_post_daily_deltas d
    join xp_meta_posts p on p.asset_id = d.asset_id and p.meta_post_id = d.meta_post_id
    where d.client_id = p_client and d.snapshot_date between p_start and p_end
      and d.is_trusted and not p.is_story
    group by d.platform
  ),
  -- Lifetime performance of the posts published in this window. Available for EVERY period,
  -- including periods that predate daily tracking, because it reads absolute counters.
  life as (
    select v.platform,
           count(*)                                          as posts,
           sum(v.reach)::bigint                              as reach,
           sum(v.views)::bigint                              as views,
           sum(v.interactions)::bigint                       as interactions,
           sum(coalesce(v.likes, v.reactions_total))::bigint as likes,
           sum(v.comments)::bigint                           as comments,
           sum(v.shares)::bigint                             as shares,
           sum(v.saves)::bigint                              as saves,
           round(avg(v.reach))                               as avg_reach,
           round(avg(v.engagement_rate), 2)                  as avg_engagement_rate,
           max(v.as_of)                                      as as_of
    from xp_v_post_scored v
    where v.client_id = p_client and not v.is_story and not v.is_deleted
      and (v.publish_date at time zone coalesce(v_tz,'UTC'))::date between p_start and p_end
    group by v.platform
  ),
  acct as (
    select platform,
           sum(reach) as account_reach, sum(impressions) as account_impressions, sum(views) as account_views,
           sum(page_views) as page_views, sum(profile_views) as profile_views,
           sum(engagements) as engagements, sum(video_views) as video_views,
           sum(follows_day) as follows, sum(unfollows_day) as unfollows,
           count(*) as days_with_data,
           -- v4: count(col) ignores nulls, count(*) does not. A row exists for almost every
           -- day; a VALUE does not. Reporting the row count as the coverage of every metric
           -- is how "469 views across 9 of the 10 days" reached a client when views existed
           -- on two. One denominator per metric, or none at all.
           count(reach)         as d_reach,
           count(impressions)   as d_impressions,
           count(views)         as d_views,
           count(page_views)    as d_page_views,
           count(profile_views) as d_profile_views,
           count(engagements)   as d_engagements,
           count(video_views)   as d_video_views,
           count(follows_day)   as d_follows,
           count(unfollows_day) as d_unfollows,
           bool_and(is_final) as all_final
    from xp_account_metric_snapshots
    where client_id = p_client and metric_date between p_start and p_end
    group by platform
  ),
  f_start as (
    select distinct on (platform) platform, followers_total, is_observed, metric_date
    from (
      select d.platform, d.metric_date,
             sum(d.followers_total_est)::bigint as followers_total,
             bool_and(d.followers_total_is_observed) as is_observed
      from xp_v_account_daily d
      where d.client_id = p_client and d.metric_date <= p_start
      group by d.platform, d.metric_date
    ) s
    where followers_total is not null
    order by platform, metric_date desc
  ),
  f_end as (
    select distinct on (platform) platform, followers_total, is_observed, metric_date
    from (
      select d.platform, d.metric_date,
             sum(d.followers_total_est)::bigint as followers_total,
             bool_and(d.followers_total_is_observed) as is_observed
      from xp_v_account_daily d
      where d.client_id = p_client and d.metric_date <= p_end
      group by d.platform, d.metric_date
    ) s
    where followers_total is not null
    order by platform, metric_date desc
  ),
  top_by_gain as (
    select d.platform, d.meta_post_id, sum(coalesce(d.reach_gained,0)) as reach_gained_in_period,
           sum(coalesce(d.likes_gained,0)) as likes_gained_in_period
    from xp_v_post_daily_deltas d
    join xp_meta_posts p on p.asset_id = d.asset_id and p.meta_post_id = d.meta_post_id
    where d.client_id = p_client and d.snapshot_date between p_start and p_end
      and d.is_trusted and not p.is_story
    group by d.platform, d.meta_post_id
  ),
  top_posts as (
    select t.platform,
           jsonb_agg(jsonb_build_object(
             'post_id', t.meta_post_id,
             'caption', left(coalesce(p.caption,''), 140),
             'permalink', p.permalink,
             'thumbnail_url', p.thumbnail_url,
             'media_type', p.media_type,
             'format', fn_content_format(p.platform, p.media_type, p.media_product_type),
             'publish_date', p.publish_date,
             'reach_gained_in_period', t.reach_gained_in_period,
             'likes_gained_in_period', t.likes_gained_in_period,
             'reach_as_of_end', (fn_post_as_of(p.asset_id, p.meta_post_id, p_end)).reach,
             'likes_as_of_end', (fn_post_as_of(p.asset_id, p.meta_post_id, p_end)).likes
           ) order by t.reach_gained_in_period desc) filter (where rn <= 5) as items
    from (select *, row_number() over (partition by platform order by reach_gained_in_period desc) rn from top_by_gain) t
    join xp_meta_posts p on p.client_id = p_client and p.meta_post_id = t.meta_post_id
    group by t.platform
  ),
  per_platform as (
    select pl.platform,
           jsonb_build_object(
             'posts_published', coalesce(pub.posts_published,0),

             -- a metric is a number only when we observed enough days to derive one
             'content', case when coalesce(cv.post_days_in_period,0) < 2 then
               jsonb_build_object(
                 'reach_gained', null, 'impressions_gained', null, 'views_gained', null,
                 'likes_gained', null, 'comments_gained', null, 'shares_gained', null,
                 'saves_gained', null, 'video_views_gained', null, 'interactions_gained', null,
                 'tracked', false,
                 'reason', case
                   when h.post_data_from is null
                     then 'No post snapshots have ever been taken for this platform.'
                   when h.post_data_from > p_end
                     then 'Post tracking began on ' || h.post_data_from || ', after this period ended.'
                   when coalesce(cv.post_days_in_period,0) = 0
                     then 'No post snapshots fall inside this period; tracking began on ' || h.post_data_from || '.'
                   else 'Only one snapshot day falls inside this period, so no day-over-day gain can be derived.'
                 end)
             else
               jsonb_build_object(
                 'reach_gained', coalesce(g.reach_gained,0),
                 'impressions_gained', coalesce(g.impressions_gained,0),
                 'views_gained', coalesce(g.views_gained,0),
                 'likes_gained', coalesce(g.likes_gained,0),
                 'comments_gained', coalesce(g.comments_gained,0),
                 'shares_gained', coalesce(g.shares_gained,0),
                 'saves_gained', coalesce(g.saves_gained,0),
                 'video_views_gained', coalesce(g.video_views_gained,0),
                 'interactions_gained', coalesce(g.interactions_gained,0),
                 'tracked', true, 'reason', null)
             end,

             -- always available: what the posts published in this window have earned in total
             'lifetime', case when lf.posts is null then null else jsonb_build_object(
                 'as_of', lf.as_of,
                 'posts', lf.posts, 'reach', lf.reach, 'views', lf.views,
                 'interactions', lf.interactions, 'likes', lf.likes, 'comments', lf.comments,
                 'shares', lf.shares, 'saves', lf.saves,
                 'avg_reach', lf.avg_reach, 'avg_engagement_rate', lf.avg_engagement_rate,
                 'basis', 'lifetime totals of posts published in this period, as of the last snapshot')
             end,

             'engagement', jsonb_build_object(
               'rate_on_reach',      fn_er(lf.interactions, lf.reach),
               'rate_on_followers',  fn_er(lf.interactions, fe.followers_total),
               'rate_on_reach_in_period',
                 case when coalesce(cv.post_days_in_period,0) >= 2
                      then fn_er(g.interactions_gained::bigint, g.reach_gained::bigint) end,
               'avg_per_post',       lf.avg_engagement_rate,
               'definition', 'interactions / reach * 100; interactions = total_interactions or '
                             'likes+comments+shares+saves'),

             'coverage', jsonb_build_object(
               'post_days_in_period', coalesce(cv.post_days_in_period,0),
               'posts_observed',      coalesce(cv.posts_observed,0),
               'post_data_from',      h.post_data_from,
               'account_days_in_period', coalesce(a.days_with_data,0),
               'days_in_period',      (p_end - p_start + 1),
               'account_complete',    coalesce(a.days_with_data,0) >= (p_end - p_start + 1),
               -- v4: days a VALUE exists, per metric. account_days_in_period above counts rows
               -- and is retained only so older consumers keep working — it is not a coverage
               -- figure for any individual metric and must not be quoted as one.
               'account_days_by_metric', jsonb_build_object(
                 'reach', coalesce(a.d_reach,0), 'impressions', coalesce(a.d_impressions,0),
                 'views', coalesce(a.d_views,0), 'page_views', coalesce(a.d_page_views,0),
                 'profile_views', coalesce(a.d_profile_views,0),
                 'engagements', coalesce(a.d_engagements,0),
                 'video_views', coalesce(a.d_video_views,0),
                 'follows', coalesce(a.d_follows,0), 'unfollows', coalesce(a.d_unfollows,0))),

             'account', jsonb_build_object(
               'reach', a.account_reach, 'impressions', a.account_impressions, 'views', a.account_views,
               'page_views', a.page_views, 'profile_views', a.profile_views,
               'engagements', a.engagements, 'video_views', a.video_views,
               'follows', a.follows, 'unfollows', a.unfollows,
               'days_with_data', coalesce(a.days_with_data,0),
               'days_in_period', (p_end - p_start + 1),
               -- v4: the denominator that belongs to each number above, beside it.
               'days_by_metric', jsonb_build_object(
                 'reach', coalesce(a.d_reach,0), 'impressions', coalesce(a.d_impressions,0),
                 'views', coalesce(a.d_views,0), 'page_views', coalesce(a.d_page_views,0),
                 'profile_views', coalesce(a.d_profile_views,0),
                 'engagements', coalesce(a.d_engagements,0),
                 'video_views', coalesce(a.d_video_views,0),
                 'follows', coalesce(a.d_follows,0), 'unfollows', coalesce(a.d_unfollows,0))),

             'followers', jsonb_build_object(
               'start', fs.followers_total, 'start_observed_on', fs.metric_date,
               'start_is_measured', fs.is_observed,
               'end',   fe.followers_total, 'end_observed_on',   fe.metric_date,
               'end_is_measured', fe.is_observed,
               'net',   case when fs.followers_total is not null and fe.followers_total is not null
                             then fe.followers_total - fs.followers_total end),

             'top_posts', coalesce(tp.items, '[]'::jsonb)
           ) as body
    from plat pl
    left join pub   on pub.platform = pl.platform
    left join cover cv on cv.platform = pl.platform
    left join horizon h on h.platform = pl.platform
    left join gains g on g.platform = pl.platform
    left join life  lf on lf.platform = pl.platform
    left join acct  a on a.platform = pl.platform
    left join f_start fs on fs.platform = pl.platform
    left join f_end   fe on fe.platform = pl.platform
    left join top_posts tp on tp.platform = pl.platform
  )
  select jsonb_build_object(
    'client_id', p_client,
    'period', jsonb_build_object('start', p_start, 'end', p_end, 'timezone', v_tz),
    'is_running_period', p_end >= v_today,
    'data_available_from',         (select min(metric_date)   from xp_account_metric_snapshots where client_id = p_client),
    'account_data_available_from', (select min(metric_date)   from xp_account_metric_snapshots where client_id = p_client),
    'post_data_available_from',    (select min(snapshot_date) from xp_post_metric_snapshots
                                     where client_id = p_client and source in ('LIVE','BACKFILL')),
    'conventions', fn_conventions_for(p_start, p_end),
    'platforms', jsonb_object_agg(platform, body),
    'generated_at', now()
  ) into v_out
  from per_platform;

  return v_out;
end
$fn$;

comment on function fn_client_period_summary(uuid, date, date) is
  'v4 (0009). account.days_by_metric and coverage.account_days_by_metric give the number of '
  'days each metric actually HAS A VALUE, via count(col). The older days_with_data / '
  'account_days_in_period count ROWS and are kept only for compatibility — they must never be '
  'quoted as the coverage of an individual metric. Also returns conventions for the span.';

commit;

-- ============================================================================
-- VERIFY — run after applying
-- ============================================================================
-- Instagram, 1–10 September 2026: reach should show ~9 days, views/engagements/profile_views 2.
--
--   select jsonb_pretty(
--     fn_client_period_summary('af5ee82b-39fe-4a8f-91c3-bd33bc9a875b','2026-09-01','2026-09-10')
--       -> 'platforms' -> 'IG' -> 'account' -> 'days_by_metric');
--
-- August 2026 should show reach 30, views 29, engagements 29 — matching the raw per-month
-- counts recorded in SESSION_FINDINGS §4:
--
--   select jsonb_pretty(
--     fn_client_period_summary('af5ee82b-39fe-4a8f-91c3-bd33bc9a875b','2026-08-01','2026-08-31')
--       -> 'platforms' -> 'IG' -> 'account' -> 'days_by_metric');
--
-- Conventions for a period straddling the cutover should return two IG total_value rows:
--
--   select jsonb_pretty(fn_conventions_for('2026-09-01','2026-09-10'));
--
-- Nothing in xp_account_metric_snapshots changes. Confirm:
--
--   select count(*) from xp_account_metric_snapshots where updated_at > now() - interval '10 minutes';
-- ============================================================================


-- ===================================================================
-- 0010_settle_lock.sql
-- ===================================================================
-- ============================================================================
-- 0010 · Lock account days on evidence, not on a timer
-- ============================================================================
--
-- THE PROBLEM (PROGRESS 2026-09-10, SESSION_FINDINGS F-11)
--
--   Instagram account reach keeps climbing for days after the insights day closes.
--   8 September read 2 at ~3h, 397 at ~38h, 2,470 at ~51h and was still rising.
--   fn_finalize_snapshots closed account rows at today-2, so 7 September froze at 26 —
--   roughly 1% of its settled value — and the immutability guard now correctly refuses
--   to change it. Every IG reach value ever frozen was captured mid-count.
--
-- WHAT THIS DOES
--
--   1. xp_account_metric_observations — an APPEND-ONLY log. Every sync that reads an open day
--      inserts one row with what Meta returned THIS run (not the carried-forward value).
--      The snapshot row still holds the latest reading; this table holds the curve.
--      Nothing in it can ever be updated or deleted.
--
--   2. fn_finalize_snapshots v3 — an account row is locked when ONE of these holds:
--        settled     the two most recent observations, at least settle_min_gap_hours apart,
--                    report the same reach (and no other tracked metric moved), AND the day
--                    is at least settle_floor_days old (the 0008 timezone argument still
--                    applies — nothing is comparable before every Meta clock has passed it).
--        unsettled   the day is older than settle_ceiling_days and still moving. Locked so
--                    the ledger cannot stay open forever, and labelled so reports can say so.
--        unobserved  the day is older than settle_ceiling_days and has fewer than two
--                    readings carrying a reach value (rows written before 0010, or a sync
--                    that kept failing).
--      Post and audience rows are unchanged: they are labelled with OUR read date and one
--      day is still right for them.
--
--   3. settle_status / settled_at / settle_observations on xp_account_metric_snapshots.
--      Written in the same UPDATE that flips is_final, so the guard never sees a change to
--      a final row. Rows that were already final when this ran keep settle_status = NULL;
--      READ THAT AS "locked under the timer regime" — fn_reach_settlement() spells it out.
--
--   4. A convention record for the timer-locked span, and read-only helpers for reports.
--
-- WHAT THIS DOES NOT DO
--
--   It does not touch any row that is already final. 7 September stays at 26. Rewriting it
--   would launder the bug out of the audit trail — the exact thing the guard exists to stop.
--
-- TUNING lives in xp_system_config (id = 1), not in code:
--   settle_floor_days      default 2    never lock younger than this
--   settle_ceiling_days    default 14   always lock older than this, labelled
--   settle_min_gap_hours   default 10   two equal readings must be at least this far apart
-- The sync reads settle_ceiling_days too: it is how far back open days are re-read.
--
-- Safe to re-run. Every statement is idempotent.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0010-a · tuning knobs
-- ---------------------------------------------------------------------------
alter table xp_system_config add column if not exists settle_floor_days    int not null default 2;
alter table xp_system_config add column if not exists settle_ceiling_days  int not null default 14;
alter table xp_system_config add column if not exists settle_min_gap_hours int not null default 10;

insert into xp_system_config (id) select 1 where not exists (select 1 from xp_system_config where id = 1);

-- ---------------------------------------------------------------------------
-- 0010-b · the observation log
-- ---------------------------------------------------------------------------
create table if not exists xp_account_metric_observations (
  id                   bigint generated always as identity primary key,
  client_id            uuid not null references xp_clients(id) on delete cascade,
  asset_id             uuid not null references xp_meta_assets(id) on delete cascade,
  platform             text not null check (platform in ('FB','IG')),
  metric_date          date not null,
  sync_run_id          bigint references xp_sync_runs(id) on delete set null,
  observed_at          timestamptz not null default now(),
  -- the metrics stability is judged on. What Meta returned on THIS read; null = not served.
  reach                bigint,
  impressions          bigint,
  views                bigint,
  engagements          bigint,
  profile_views        bigint,
  accounts_engaged     bigint,
  followers_gained_day bigint,
  -- everything else observed on this read, as mapped, before carry-forward
  observed             jsonb not null default '{}'::jsonb
);

create index if not exists xp_amo_asset_day_idx
  on xp_account_metric_observations (asset_id, metric_date, observed_at desc);

comment on table xp_account_metric_observations is
  'Append-only. One row per sync per open account day, holding what Meta returned on that read. '
  'xp_account_metric_snapshots keeps the latest value; this keeps the curve. It is the evidence '
  'fn_finalize_snapshots() locks on, and the record of how long Meta takes to settle a day.';

create or replace function fn_guard_append_only() returns trigger
language plpgsql as $$
begin
  if current_setting('app.allow_snapshot_rewrite', true) = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  raise exception '% is append-only; % refused.', tg_table_name, tg_op;
end $$;

drop trigger if exists trg_amo_append_only_upd on xp_account_metric_observations;
create trigger trg_amo_append_only_upd before update on xp_account_metric_observations
  for each row execute function fn_guard_append_only();
drop trigger if exists trg_amo_append_only_del on xp_account_metric_observations;
create trigger trg_amo_append_only_del before delete on xp_account_metric_observations
  for each row execute function fn_guard_append_only();

-- ---------------------------------------------------------------------------
-- 0010-c · lock verdict columns on the snapshot row
-- ---------------------------------------------------------------------------
-- ALTER TABLE does not fire row triggers, so this cannot collide with the guard.
alter table xp_account_metric_snapshots add column if not exists settle_status text
  check (settle_status in ('settled','unsettled','unobserved'));
alter table xp_account_metric_snapshots add column if not exists settled_at timestamptz;
alter table xp_account_metric_snapshots add column if not exists settle_observations int;

comment on column xp_account_metric_snapshots.settle_status is
  'How the row came to be final. settled = two equal readings >= settle_min_gap_hours apart; '
  'unsettled = still moving at settle_ceiling_days, locked anyway; unobserved = fewer than two '
  'readings by the ceiling. NULL on a final row = locked by the pre-0010 timer, mid-count for IG reach.';

-- ---------------------------------------------------------------------------
-- 0010-d · fn_finalize_snapshots v3
-- ---------------------------------------------------------------------------
create or replace function fn_finalize_snapshots() returns table(table_name text, rows_finalized bigint)
language plpgsql as $$
declare
  n        bigint;
  floor_d  int;
  ceil_d   int;
  gap_h    int;
begin
  select coalesce(settle_floor_days, 2), coalesce(settle_ceiling_days, 14), coalesce(settle_min_gap_hours, 10)
    into floor_d, ceil_d, gap_h
  from xp_system_config where id = 1;
  floor_d := coalesce(floor_d, 2); ceil_d := coalesce(ceil_d, 14); gap_h := coalesce(gap_h, 10);
  if ceil_d < floor_d then ceil_d := floor_d; end if;

  -- Post snapshots are labelled with OUR read date, not a Meta day boundary, so one day is right.
  update xp_post_metric_snapshots p set is_final = true
  from xp_clients c where p.client_id = c.id and p.is_final = false and p.snapshot_date < fn_today(c.timezone);
  get diagnostics n = row_count; table_name := 'xp_post_metric_snapshots'; rows_finalized := n; return next;

  -- Account snapshots: evidence-based. See the header.
  with cand as (
    select p.id, p.asset_id, p.metric_date, (fn_today(c.timezone) - p.metric_date) as age_days
    from xp_account_metric_snapshots p
    join xp_clients c on c.id = p.client_id
    where p.is_final = false
      and p.metric_date < fn_today(c.timezone) - floor_d
  ),
  -- Only readings that actually carry a reach value are evidence. A run where Meta served
  -- nothing must not become the "latest observation" and stall the comparison forever.
  obs as (
    select o.asset_id, o.metric_date, o.observed_at,
           o.reach, o.impressions, o.views, o.engagements,
           row_number() over (partition by o.asset_id, o.metric_date order by o.observed_at desc) as rn,
           count(*)     over (partition by o.asset_id, o.metric_date) as n_obs
    from xp_account_metric_observations o
    join cand on cand.asset_id = o.asset_id and cand.metric_date = o.metric_date
    where o.reach is not null
  ),
  verdict as (
    select cand.id,
           coalesce(l.n_obs, 0) as n_obs,
           case
             when l.reach is not null and pv.reach is not null
                  and extract(epoch from (l.observed_at - pv.observed_at)) / 3600.0 >= gap_h
                  and l.reach = pv.reach
                  and (l.impressions is null or pv.impressions is null or l.impressions = pv.impressions)
                  and (l.views       is null or pv.views       is null or l.views       = pv.views)
                  and (l.engagements is null or pv.engagements is null or l.engagements = pv.engagements)
               then 'settled'
             when cand.age_days > ceil_d and coalesce(l.n_obs, 0) >= 2 then 'unsettled'
             when cand.age_days > ceil_d                              then 'unobserved'
             else null
           end as status
    from cand
    left join obs l  on l.asset_id  = cand.asset_id and l.metric_date  = cand.metric_date and l.rn  = 1
    left join obs pv on pv.asset_id = cand.asset_id and pv.metric_date = cand.metric_date and pv.rn = 2
  )
  update xp_account_metric_snapshots s
     set is_final = true,
         settle_status = v.status,
         settled_at = now(),
         settle_observations = v.n_obs
  from verdict v
  where s.id = v.id and v.status is not null;
  get diagnostics n = row_count; table_name := 'xp_account_metric_snapshots'; rows_finalized := n; return next;

  update xp_audience_snapshots p set is_final = true
  from xp_clients c where p.client_id = c.id and p.is_final = false and p.snapshot_date < fn_today(c.timezone);
  get diagnostics n = row_count; table_name := 'xp_audience_snapshots'; rows_finalized := n; return next;
end $$;

comment on function fn_finalize_snapshots() is
  'v3 (0010). Post/audience rows close one day after their read date. Account rows close on '
  'evidence: two readings >= settle_min_gap_hours apart with identical reach, never younger than '
  'settle_floor_days, always by settle_ceiling_days (labelled unsettled/unobserved). Knobs in xp_system_config.';

-- ---------------------------------------------------------------------------
-- 0010-e · convention record for the timer-locked span
-- ---------------------------------------------------------------------------
-- effective_to is the newest IG day that is final without a settle verdict — i.e. the last day
-- the timer closed. Computed, not typed, so it is right whatever the lag was set to on the day
-- this migration runs.
insert into xp_data_conventions (platform, metric_family, convention, effective_from, effective_to, note)
select 'IG', 'reach', 'TIMER_LOCK_MID_COUNT', date '2026-06-01',
       coalesce((select max(metric_date) from xp_account_metric_snapshots
                 where platform = 'IG' and is_final and settle_status is null), date '2026-09-07'),
       'Account rows were finalized on a fixed lag (today-2) while Meta was still aggregating '
       'reach for the day. Observed: 8 Sep 2026 read 2 at ~3h after close, 397 at ~38h, 2,470 at '
       '~51h and still rising. Every reach value in this span was captured mid-count and is an '
       'UNDERCOUNT of unknown size; 7 Sep 2026 is locked at 26 against neighbours of 140-400 and '
       'a same-age reading of 2,470. Monthly reach sums over this span inherit the undercount. '
       'These rows are final and will not be corrected. From the day after effective_to, rows '
       'lock only once two readings agree (settle_status = settled) or are labelled otherwise.'
where not exists (
  select 1 from xp_data_conventions
  where platform = 'IG' and metric_family = 'reach' and convention = 'TIMER_LOCK_MID_COUNT'
);

-- ---------------------------------------------------------------------------
-- 0010-f · read-only helpers
-- ---------------------------------------------------------------------------

-- One row per account day: what it says, how it was locked, and the settle curve behind it.
create or replace function fn_reach_settlement(p_asset uuid, p_start date, p_end date)
returns table (
  metric_date    date,
  reach          bigint,
  is_final       boolean,
  lock_basis     text,          -- settled | unsettled | unobserved | timer_lock | open
  n_obs          int,
  first_read_at  timestamptz,
  first_reach    bigint,
  last_read_at   timestamptz,
  last_reach     bigint,
  hours_to_last  numeric        -- last read, in hours after the first read
)
language sql stable as $$
  select s.metric_date, s.reach, s.is_final,
         case
           when s.is_final and s.settle_status is not null then s.settle_status
           when s.is_final                                then 'timer_lock'
           else 'open'
         end as lock_basis,
         coalesce(o.n_obs, 0)::int,
         o.first_read_at, o.first_reach, o.last_read_at, o.last_reach,
         round(extract(epoch from (o.last_read_at - o.first_read_at)) / 3600.0, 1)
  from xp_account_metric_snapshots s
  left join lateral (
    select count(*) as n_obs,
           min(observed_at) as first_read_at,
           max(observed_at) as last_read_at,
           (array_agg(reach order by observed_at asc))[1]  as first_reach,
           (array_agg(reach order by observed_at desc))[1] as last_reach
    from xp_account_metric_observations x
    where x.asset_id = s.asset_id and x.metric_date = s.metric_date
  ) o on true
  where s.asset_id = p_asset and s.metric_date between p_start and p_end
  order by s.metric_date;
$$;

comment on function fn_reach_settlement(uuid, date, date) is
  'Per-day lock basis and settle curve for one asset. lock_basis timer_lock = final before 0010, '
  'mid-count for IG reach. Use it to answer "can this number be trusted".';

-- Period roll-up for reports and chat: how many days in the span rest on what.
create or replace function fn_period_settlement(p_client uuid, p_start date, p_end date)
returns jsonb
language sql stable as $$
  select coalesce(jsonb_object_agg(platform, per), '{}'::jsonb)
  from (
    select s.platform,
           jsonb_build_object(
             'days_settled',    count(*) filter (where s.is_final and s.settle_status = 'settled'),
             'days_unsettled',  count(*) filter (where s.is_final and s.settle_status = 'unsettled'),
             'days_unobserved', count(*) filter (where s.is_final and s.settle_status = 'unobserved'),
             'days_timer_lock', count(*) filter (where s.is_final and s.settle_status is null),
             'days_open',       count(*) filter (where not s.is_final),
             'reach_trusted',   coalesce(sum(s.reach) filter (where s.is_final and s.settle_status = 'settled'), 0),
             'reach_total',     coalesce(sum(s.reach), 0)
           ) as per
    from xp_account_metric_snapshots s
    where s.client_id = p_client and s.metric_date between p_start and p_end
    group by s.platform
  ) t;
$$;

comment on function fn_period_settlement(uuid, date, date) is
  'Per platform: how many account days in the period are settled / unsettled / unobserved / '
  'timer-locked / open, and how much of the reach sum rests on settled days. For C-4 and chat.';

-- Operator view: what is open right now and how it is doing.
create or replace function fn_settle_health()
returns table (
  platform     text,
  asset_name   text,
  metric_date  date,
  age_days     int,
  n_obs        int,
  last_reach   bigint,
  prev_reach   bigint,
  gap_hours    numeric,
  verdict      text
)
language sql stable as $$
  with open_rows as (
    select s.platform, a.name as asset_name, s.asset_id, s.metric_date,
           (fn_today(c.timezone) - s.metric_date) as age_days
    from xp_account_metric_snapshots s
    join xp_clients c on c.id = s.client_id
    join xp_meta_assets a on a.id = s.asset_id
    where not s.is_final
  ),
  o as (
    select x.asset_id, x.metric_date, x.reach, x.observed_at,
           row_number() over (partition by x.asset_id, x.metric_date order by x.observed_at desc) rn,
           count(*)     over (partition by x.asset_id, x.metric_date) n_obs
    from xp_account_metric_observations x
    join open_rows r on r.asset_id = x.asset_id and r.metric_date = x.metric_date
  )
  select r.platform, r.asset_name, r.metric_date, r.age_days,
         coalesce(l.n_obs, 0)::int,
         l.reach, pv.reach,
         round(extract(epoch from (l.observed_at - pv.observed_at)) / 3600.0, 1),
         case
           when l.reach is null                       then 'no reading yet'
           when pv.reach is null                      then 'one reading — waiting for a second'
           when l.reach = pv.reach                    then 'stable — will lock when floor/gap allow'
           when l.reach > pv.reach                    then 'still climbing'
           else 'FELL — Meta restated this day, investigate'
         end
  from open_rows r
  left join o l  on l.asset_id  = r.asset_id and l.metric_date  = r.metric_date and l.rn  = 1
  left join o pv on pv.asset_id = r.asset_id and pv.metric_date = r.metric_date and pv.rn = 2
  order by r.platform, r.metric_date;
$$;

comment on function fn_settle_health() is
  'Every open account day with its last two reach readings and a one-line verdict. Run after each sync.';

-- ============================================================================
-- VERIFY — run after applying
-- ============================================================================
-- 1. Knobs present:
--      select settle_floor_days, settle_ceiling_days, settle_min_gap_hours from xp_system_config where id = 1;
--    → 2 | 14 | 10
--
-- 2. Nothing already-final was touched (should equal the count you noted BEFORE running):
--      select count(*) from xp_account_metric_snapshots where is_final;
--
-- 3. The convention landed and effective_to is the last timer-locked IG day (expect 2026-09-07):
--      select convention, effective_from, effective_to from xp_data_conventions where metric_family = 'reach';
--
-- 4. Finalize is safe to call now and locks nothing it should not (8/9 Sep must stay open):
--      select * from fn_finalize_snapshots();
--      select * from fn_settle_health();
--
-- 5. After the first post-deploy sync, observations exist for every open IG day:
--      select metric_date, count(*), min(reach), max(reach)
--      from xp_account_metric_observations
--      where asset_id = '2aed09c2-4896-490b-8ebd-1d62dd99c4c3'
--      group by 1 order by 1;
--
-- 6. The curve for the days in question:
--      select * from fn_reach_settlement('2aed09c2-4896-490b-8ebd-1d62dd99c4c3','2026-09-05','2026-09-12');
-- ============================================================================


-- ===================================================================
-- 0011_settle_plateau.sql
-- ===================================================================
-- ============================================================================
-- 0011 · Settle on a plateau, keep watching after the lock, audit the timer-locked span
-- ============================================================================
--
-- WHY (review of 2026-09-12)
--
--   1. 0010 locked a day when its two most recent readings agreed. On a 09:00/21:00 cron those are
--      always 12 hours apart, so settle_min_gap_hours only had two useful values: <= 12 (any pair)
--      or > 12 (never — everything limped to the ceiling as 'unsettled'). The knob could not
--      express "held for 24 hours". 9 Sep IG locked at 1,013 on one 12-hour pause while 8 Sep had
--      jumped 397 → 2,470 across a 13-hour interval. One pause is not evidence of a finish.
--
--      v4 locks when reach has HELD ITS CURRENT VALUE for >= settle_min_gap_hours across >= 2
--      readings. The gap now means what it says: 24 = a plateau spanning three 12-hourly readings.
--
--   2. Observations stopped at lock (sync.js filtered them to open days). The evidence needed to
--      grade the rule was discarded at the moment the rule fired. sync.js now logs every day in
--      the lookback, locked or not; fn_settle_drift() lists final rows Meta has since contradicted.
--      The snapshot row stays frozen — the guard is untouched — the contradiction is simply visible.
--
--   3. IG reach is backfillable for 30 days. xp_reach_audit is a scratch table for a live-vs-stored
--      comparison over that window (scripts/reach-audit.js). It never writes to snapshots.
--
--   4. Two convention records are set straight (0011-g, 0011-h): the Facebook reach measurement
--      changed under us when Meta retired page_impressions_unique, and the Instagram "every value
--      is an undercount" note from 0010-e is narrowed to what a 23-day audit actually found. The
--      old wording is kept in a new superseded_note column; the convention code is not renamed.
--
-- Safe to re-run. Every statement is idempotent. Nothing already final is modified.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0011-a · one more verdict column: how long the plateau was when the row locked
-- ---------------------------------------------------------------------------
alter table xp_account_metric_snapshots add column if not exists settle_plateau_hours numeric;
comment on column xp_account_metric_snapshots.settle_plateau_hours is
  'Hours reach had held its final value when the row locked (settled rows only). NULL = not applicable.';

-- ---------------------------------------------------------------------------
-- 0011-b · fn_finalize_snapshots v4
-- ---------------------------------------------------------------------------
create or replace function fn_finalize_snapshots() returns table(table_name text, rows_finalized bigint)
language plpgsql as $$
declare
  n        bigint;
  floor_d  int;
  ceil_d   int;
  gap_h    int;
begin
  select coalesce(settle_floor_days, 2), coalesce(settle_ceiling_days, 14), coalesce(settle_min_gap_hours, 24)
    into floor_d, ceil_d, gap_h
  from xp_system_config where id = 1;
  floor_d := coalesce(floor_d, 2); ceil_d := coalesce(ceil_d, 14); gap_h := coalesce(gap_h, 24);
  if ceil_d < floor_d then ceil_d := floor_d; end if;

  -- Post snapshots are labelled with OUR read date, not a Meta day boundary, so one day is right.
  update xp_post_metric_snapshots p set is_final = true
  from xp_clients c where p.client_id = c.id and p.is_final = false and p.snapshot_date < fn_today(c.timezone);
  get diagnostics n = row_count; table_name := 'xp_post_metric_snapshots'; rows_finalized := n; return next;

  with cand as (
    select p.id, p.asset_id, p.metric_date, (fn_today(c.timezone) - p.metric_date) as age_days
    from xp_account_metric_snapshots p
    join xp_clients c on c.id = p.client_id
    where p.is_final = false
      and p.metric_date < fn_today(c.timezone) - floor_d
  ),
  -- Only readings that carry a reach value are evidence.
  obs as (
    select o.asset_id, o.metric_date, o.observed_at,
           o.reach, o.impressions, o.views, o.engagements,
           row_number() over (partition by o.asset_id, o.metric_date order by o.observed_at desc) as rn,
           count(*)     over (partition by o.asset_id, o.metric_date) as n_obs
    from xp_account_metric_observations o
    join cand on cand.asset_id = o.asset_id and cand.metric_date = o.metric_date
    where o.reach is not null
  ),
  latest as (select * from obs where rn = 1),
  prev   as (select * from obs where rn = 2),
  -- The trailing run of readings equal to the latest value: starts after the last reading that
  -- differed (or at the first reading if none ever did).
  plateau as (
    select l.asset_id, l.metric_date,
           min(o.observed_at) as plateau_start,
           count(*)           as plateau_n
    from latest l
    join obs o on o.asset_id = l.asset_id and o.metric_date = l.metric_date and o.reach = l.reach
    where o.observed_at > coalesce(
      (select max(x.observed_at) from obs x
        where x.asset_id = l.asset_id and x.metric_date = l.metric_date and x.reach <> l.reach),
      '-infinity'::timestamptz)
    group by l.asset_id, l.metric_date
  ),
  verdict as (
    select cand.id,
           coalesce(l.n_obs, 0) as n_obs,
           round(extract(epoch from (l.observed_at - p.plateau_start)) / 3600.0, 1) as plateau_hours,
           case
             when l.reach is not null
                  and p.plateau_n >= 2
                  and extract(epoch from (l.observed_at - p.plateau_start)) / 3600.0 >= gap_h
                  and (l.impressions is null or pv.impressions is null or l.impressions = pv.impressions)
                  and (l.views       is null or pv.views       is null or l.views       = pv.views)
                  and (l.engagements is null or pv.engagements is null or l.engagements = pv.engagements)
               then 'settled'
             when cand.age_days > ceil_d and coalesce(l.n_obs, 0) >= 2 then 'unsettled'
             when cand.age_days > ceil_d                              then 'unobserved'
             else null
           end as status
    from cand
    left join latest  l  on l.asset_id  = cand.asset_id and l.metric_date  = cand.metric_date
    left join prev    pv on pv.asset_id = cand.asset_id and pv.metric_date = cand.metric_date
    left join plateau p  on p.asset_id  = cand.asset_id and p.metric_date  = cand.metric_date
  )
  update xp_account_metric_snapshots s
     set is_final = true,
         settle_status = v.status,
         settled_at = now(),
         settle_observations = v.n_obs,
         settle_plateau_hours = case when v.status = 'settled' then v.plateau_hours end
  from verdict v
  where s.id = v.id and v.status is not null;
  get diagnostics n = row_count; table_name := 'xp_account_metric_snapshots'; rows_finalized := n; return next;

  update xp_audience_snapshots p set is_final = true
  from xp_clients c where p.client_id = c.id and p.is_final = false and p.snapshot_date < fn_today(c.timezone);
  get diagnostics n = row_count; table_name := 'xp_audience_snapshots'; rows_finalized := n; return next;
end $$;

comment on function fn_finalize_snapshots() is
  'v4 (0011). Account rows close when reach has held its current value for >= settle_min_gap_hours '
  'across >= 2 readings (plateau), never younger than settle_floor_days, always by settle_ceiling_days '
  '(labelled unsettled/unobserved). Post/audience rows close one day after their read date.';

-- ---------------------------------------------------------------------------
-- 0011-c · post-lock drift: final rows that Meta has since contradicted
-- ---------------------------------------------------------------------------
-- Requires sync.js v2.5, which logs observations for locked days too. Until it runs, this is empty.
create or replace function fn_settle_drift(p_client uuid default null)
returns table (
  platform         text,
  asset_name       text,
  metric_date      date,
  lock_basis       text,        -- settled | unsettled | unobserved | timer_lock
  locked_reach     bigint,
  latest_obs_reach bigint,
  latest_obs_at    timestamptz,
  drift            bigint,      -- latest observation minus the frozen value
  drift_pct        numeric
)
language sql stable as $$
  select s.platform, a.name, s.metric_date,
         coalesce(s.settle_status, 'timer_lock'),
         s.reach, o.reach, o.observed_at,
         o.reach - s.reach,
         case when s.reach > 0 then round(100.0 * (o.reach - s.reach) / s.reach, 1) end
  from xp_account_metric_snapshots s
  join xp_meta_assets a on a.id = s.asset_id
  join lateral (
    select x.reach, x.observed_at
    from xp_account_metric_observations x
    where x.asset_id = s.asset_id and x.metric_date = s.metric_date and x.reach is not null
    order by x.observed_at desc limit 1
  ) o on true
  where s.is_final
    and (p_client is null or s.client_id = p_client)
    and o.observed_at > coalesce(s.settled_at, '-infinity'::timestamptz)
    and o.reach is distinct from s.reach
  order by s.platform, s.metric_date;
$$;

comment on function fn_settle_drift(uuid) is
  'Final account rows whose most recent observation (taken after the lock) disagrees with the frozen '
  'value. A settled row here = a false settle; the rule is too loose. A timer_lock row here = the '
  'undercount, measured. The frozen value is never changed; this makes the disagreement visible.';

-- ---------------------------------------------------------------------------
-- 0011-d · fn_reach_settlement v2 — adds the post-lock columns
-- ---------------------------------------------------------------------------
drop function if exists fn_reach_settlement(uuid, date, date);
create function fn_reach_settlement(p_asset uuid, p_start date, p_end date)
returns table (
  metric_date     date,
  reach           bigint,
  is_final        boolean,
  lock_basis      text,          -- settled | unsettled | unobserved | timer_lock | open
  plateau_hours   numeric,
  n_obs           int,
  first_read_at   timestamptz,
  first_reach     bigint,
  last_read_at    timestamptz,
  last_reach      bigint,
  hours_to_last   numeric,
  post_lock_drift bigint         -- non-null = Meta moved this day after it was frozen
)
language sql stable as $$
  select s.metric_date, s.reach, s.is_final,
         case
           when s.is_final and s.settle_status is not null then s.settle_status
           when s.is_final                                then 'timer_lock'
           else 'open'
         end,
         s.settle_plateau_hours,
         coalesce(o.n_obs, 0)::int,
         o.first_read_at, o.first_reach, o.last_read_at, o.last_reach,
         round(extract(epoch from (o.last_read_at - o.first_read_at)) / 3600.0, 1),
         case when s.is_final
               and o.last_read_at > coalesce(s.settled_at, '-infinity'::timestamptz)
               and o.last_reach is distinct from s.reach
              then o.last_reach - s.reach end
  from xp_account_metric_snapshots s
  left join lateral (
    select count(*) as n_obs,
           min(observed_at) as first_read_at,
           max(observed_at) as last_read_at,
           (array_agg(reach order by observed_at asc))[1]  as first_reach,
           (array_agg(reach order by observed_at desc))[1] as last_reach
    from xp_account_metric_observations x
    where x.asset_id = s.asset_id and x.metric_date = s.metric_date and x.reach is not null
  ) o on true
  where s.asset_id = p_asset and s.metric_date between p_start and p_end
  order by s.metric_date;
$$;

comment on function fn_reach_settlement(uuid, date, date) is
  'Per-day lock basis, plateau length and settle curve for one asset. post_lock_drift non-null means '
  'Meta has reported a different value since the row froze. Use it to answer "can this number be trusted".';

-- ---------------------------------------------------------------------------
-- 0011-e · fn_period_settlement v2 — adds days_drifted for C-4
-- ---------------------------------------------------------------------------
create or replace function fn_period_settlement(p_client uuid, p_start date, p_end date)
returns jsonb
language sql stable as $$
  with drift as (
    select distinct x.platform, x.metric_date from fn_settle_drift(p_client) x
  )
  select coalesce(jsonb_object_agg(platform, per), '{}'::jsonb)
  from (
    select s.platform,
           jsonb_build_object(
             'days_in_period',  (p_end - p_start + 1),
             'days_settled',    count(*) filter (where s.is_final and s.settle_status = 'settled'),
             'days_unsettled',  count(*) filter (where s.is_final and s.settle_status = 'unsettled'),
             'days_unobserved', count(*) filter (where s.is_final and s.settle_status = 'unobserved'),
             'days_timer_lock', count(*) filter (where s.is_final and s.settle_status is null),
             'days_open',       count(*) filter (where not s.is_final),
             'days_drifted',    count(*) filter (where d.metric_date is not null),
             'reach_trusted',   coalesce(sum(s.reach) filter (where s.is_final and s.settle_status = 'settled'), 0),
             'reach_total',     coalesce(sum(s.reach), 0)
           ) as per
    from xp_account_metric_snapshots s
    left join drift d on d.platform = s.platform and d.metric_date = s.metric_date
    where s.client_id = p_client and s.metric_date between p_start and p_end
    group by s.platform
  ) t;
$$;

-- ---------------------------------------------------------------------------
-- 0011-f · xp_reach_audit — scratch table for the 30-day live-vs-stored comparison
-- ---------------------------------------------------------------------------
create table if not exists xp_reach_audit (
  id           bigint generated always as identity primary key,
  client_id    uuid not null references xp_clients(id) on delete cascade,
  asset_id     uuid not null references xp_meta_assets(id) on delete cascade,
  platform     text not null check (platform in ('FB','IG')),
  metric_date  date not null,
  stored_reach bigint,
  lock_basis   text,
  live_reach   bigint,
  read_at      timestamptz not null default now(),
  api_version  text,
  insights_tz  text,
  note         text
);
create index if not exists xp_reach_audit_asset_day_idx on xp_reach_audit (asset_id, metric_date, read_at desc);
comment on table xp_reach_audit is
  'Scratch. What Meta reports NOW for a past day next to what is frozen. Written only by '
  'scripts/reach-audit.js. Never feeds snapshots. Two runs a day apart on the same days = the control test.';

-- Latest audit reading per day, with the undercount factor.
create or replace function fn_reach_audit(p_asset uuid)
returns table (
  metric_date  date,
  lock_basis   text,
  stored_reach bigint,
  live_reach   bigint,
  factor       numeric,      -- live / stored; 1.0 = we had it right
  n_reads      int,
  live_moved   boolean,      -- live readings disagree between audit runs → the day is still moving
  last_read_at timestamptz
)
language sql stable as $$
  select r.metric_date,
         (array_agg(r.lock_basis   order by r.read_at desc))[1],
         (array_agg(r.stored_reach order by r.read_at desc))[1],
         (array_agg(r.live_reach   order by r.read_at desc))[1],
         case when (array_agg(r.stored_reach order by r.read_at desc))[1] > 0
              then round((array_agg(r.live_reach order by r.read_at desc))[1]::numeric
                       / (array_agg(r.stored_reach order by r.read_at desc))[1], 2) end,
         count(*)::int,
         count(distinct r.live_reach) > 1,
         max(r.read_at)
  from xp_reach_audit r
  where r.asset_id = p_asset
  group by r.metric_date
  order by r.metric_date;
$$;

-- ---------------------------------------------------------------------------
-- 0011-g · the Facebook reach convention break
-- ---------------------------------------------------------------------------
-- xp_metric_catalog, 2026-09-13: page_impressions, page_impressions_unique, page_fans, page_fan_adds,
-- page_fan_removes, page_fans_city, page_fans_country, page_fans_gender_age, post_impressions,
-- post_impressions_unique and post_engaged_users all return "(#100) The value must be a valid
-- insights metric". They were deprecated for all API versions on 2025-06-15 and 2025-11-15.
--
-- mapAccountDay picked reach with first('page_impressions_unique', 'page_total_media_view_unique').
-- While the first name still answered, FB reach meant "people who saw anything about the Page".
-- Once it died, the same column silently began carrying "unique viewers of the Page's media" —
-- a strictly smaller population. The Shaking Seafood series steps 2066, 1074, 330 → 225, 355, 47,
-- 87 across that changeover. Neither span is wrong; they measure different things, and a month
-- total that straddles the break is the sum of two different questions.
--
-- effective_from is derived from the data. Account rows keep the metrics Meta actually answered
-- with under raw -> 'flat' (metric name -> value; a dead metric is simply absent — there is no
-- raw -> 'insights' key on account rows, that shape belongs to post rows). The changeover is the
-- first FB day whose flat map holds page_total_media_view_unique and not page_impressions_unique,
-- after the last day that still held page_impressions_unique. Both dates are printed so the
-- verdict can be eyeballed against the stored reach series; if nothing matches, nothing is
-- inserted and the notice says so.
--
-- The notes below are shown to xp_clients verbatim by the chat (rule 9 quotes them), so they are
-- written for the client, not for the engineer.
do $$
declare
  last_old  date;
  first_new date;
begin
  select max(metric_date) into last_old
  from xp_account_metric_snapshots
  where platform = 'FB' and (raw -> 'flat') ? 'page_impressions_unique';

  select min(metric_date) into first_new
  from xp_account_metric_snapshots
  where platform = 'FB'
    and (raw -> 'flat') ? 'page_total_media_view_unique'
    and not ((raw -> 'flat') ? 'page_impressions_unique')
    and metric_date > coalesce(last_old, date '1900-01-01');

  if first_new is null then
    raise notice '0011-g: could not derive the FB changeover date (last day carrying page_impressions_unique: %). Insert the two convention rows by hand once known.', last_old;
  elsif exists (select 1 from xp_data_conventions where platform = 'FB' and metric_family = 'reach' and convention = 'REACH_MEDIA_VIEWERS') then
    raise notice '0011-g: FB reach convention already recorded.';
  else
    insert into xp_data_conventions (platform, metric_family, convention, effective_from, effective_to, note)
    values ('FB', 'reach', 'REACH_PAGE_IMPRESSIONS_UNIQUE', date '2020-01-01', coalesce(last_old, first_new - 1),
      'Facebook reach for these dates counts everyone who had any content from or about the Page '
      'appear on their screen — posts, ads and social mentions included. Meta has since retired '
      'this measurement (page_impressions_unique).'),
     ('FB', 'reach', 'REACH_MEDIA_VIEWERS', first_new, null,
      'From this date Facebook reach counts unique viewers of the Page''s media only '
      '(page_total_media_view_unique), the replacement Meta provides. That is a smaller group '
      'than the earlier measurement, so the Facebook reach series steps down here for reasons that '
      'have nothing to do with performance. A total that spans this date adds two different '
      'measurements together and should not be compared with a total on either side of it. '
      'Facebook impressions likewise moved from page_impressions to page_media_view.');
    raise notice '0011-g: FB reach convention recorded. Old measurement last seen %, new measurement from %.', last_old, first_new;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 0011-h · the timer-locked Instagram span: what the evidence actually says
-- ---------------------------------------------------------------------------
-- 0010-e recorded the timer-locked IG span (rows frozen at today-2 before this migration's
-- predecessor) as TIMER_LOCK_MID_COUNT, with a note asserting that EVERY reach value in the span
-- was captured mid-count and is an undercount of unknown size. That was the honest reading of
-- three days of curve data on 2026-09-10. It was carried as fact into four planning documents on
-- the strength of one number that nobody verified.
--
-- 2026-09-13, read-only probe of the IG series endpoint against stored rows: 23 timer-locked days
-- (eighteen consecutive in August, five in September) — 22 match Meta's current figure exactly.
-- The one discrepancy is 2026-09-07: stored 26, Meta now reports 275. The rule that froze that
-- span was still wrong in principle (it locked on a clock, not on evidence), but the values it
-- froze are, on the evidence, almost all right — most of them were first read days after the
-- day closed, when Meta had already finished counting.
--
-- The row is not deleted and the old text is not thrown away: the audit trail keeps the claim
-- that was made and the evidence that narrowed it. The note is rewritten because the chat quotes
-- it to xp_clients verbatim, and "every value is an undercount" is now a false statement to a client.
--
-- The convention CODE stays TIMER_LOCK_MID_COUNT on purpose. 0010 is "safe to re-run" and its
-- 0010-e insert is guarded only by "no row with this code exists" — rename the row and a re-run
-- of 0010 quietly re-inserts the retracted undercount note next to this one, and the chat quotes
-- both. The code is an engineer's label; the note is what the client reads.
alter table xp_data_conventions add column if not exists superseded_note text;
alter table xp_data_conventions add column if not exists note_revised_at timestamptz;
comment on column xp_data_conventions.superseded_note is
  'Earlier wording of note, kept when evidence narrowed or corrected it. The convention code is never renamed (0011-h).';

update xp_data_conventions
   set superseded_note = note,
       note_revised_at = now(),
       note            =
         'Instagram reach for these dates was frozen on a fixed schedule (two days after the day '
         'closed) rather than after checking that Meta had finished counting. A check against '
         'Meta on 13 September 2026 covering 23 of these days (mid-August to early September) '
         'found 22 identical to what Meta reports now. One day, 7 September 2026, is understated '
         '(stored 26; Meta now reports 275) and stays as recorded. Days before mid-August can no '
         'longer be checked. Treat reach in this span as unverified but, on the evidence, '
         'accurate; treat 7 September 2026 as understated. From the day after this span, a day is '
         'frozen only once Meta''s figure has stopped changing, or is labelled as not verified.'
 where platform = 'IG' and metric_family = 'reach'
   and convention = 'TIMER_LOCK_MID_COUNT'
   and superseded_note is null;

do $$
declare n int;
begin
  select count(*) into n from xp_data_conventions
  where platform = 'IG' and metric_family = 'reach' and convention = 'TIMER_LOCK_MID_COUNT'
    and note_revised_at is not null;
  if n = 0 then
    raise notice '0011-h: no TIMER_LOCK_MID_COUNT row found to revise (0010-e was never applied on this database).';
  else
    raise notice '0011-h: IG timer-lock convention note revised to the audit evidence; previous wording kept in superseded_note.';
  end if;
end $$;

-- The observation log now holds every day in the lookback, not only open ones (sync.js v2.5).
comment on table xp_account_metric_observations is
  'Append-only. One row per sync per account day in the lookback, open or locked, holding what Meta '
  'returned on that read. xp_account_metric_snapshots keeps the frozen value; this keeps the curve — '
  'the evidence fn_finalize_snapshots() locks on, and after the lock, the record of whether Meta '
  'kept moving (fn_settle_drift).';

-- ============================================================================
-- VERIFY — run after applying
-- ============================================================================
-- 1. Finalize still locks nothing it should not; note the count before and after:
--      select count(*) from xp_account_metric_snapshots where is_final;
--      select * from fn_finalize_snapshots();
--
-- 2. The knob. 0011 does NOT change it; DEPLOY step 3 does, deliberately:
--      select settle_floor_days, settle_ceiling_days, settle_min_gap_hours from xp_system_config where id = 1;
--
-- 3. Empty until sync.js v2.5 has run at least once after a lock:
--      select * from fn_settle_drift();
--
-- 4. The two convention edits — read the notices from 0011-g and 0011-h, then:
--      select platform, metric_family, convention, effective_from, effective_to, note_revised_at is not null as revised
--      from xp_data_conventions order by platform, effective_from;
--    Expect: the IG reach TIMER_LOCK_MID_COUNT row with revised = true (its note no longer says
--    "UNDERCOUNT"), and two FB reach rows if 0011-g could derive the changeover.
--
-- 5. Curve with the new columns:
--      select * from fn_reach_settlement('2aed09c2-4896-490b-8ebd-1d62dd99c4c3','2026-09-05','2026-09-12');
-- ============================================================================


-- ===================================================================
-- 0012_c4_client_facing.sql
-- ===================================================================
-- ============================================================================
-- 0012 · C-4 — what the client sees
-- ============================================================================
-- Safe to re-run. Adds columns and functions only; rewrites no snapshot row.
--
-- 0012-a  impressions_organic / impressions_paid on xp_account_metric_snapshots (FB only has data:
--         page_media_view with breakdown=is_from_ads). Historical days stay null — the split was
--         first requested by sync.js v2.5 and closed rows are never rewritten.
-- 0012-b  xp_clients.brand_color — per-client report accent. Logos use the existing xp_clients.logo_url,
--         written by the admin branding endpoint (public 'brand' bucket).
-- 0012-c  xp_system_config: monthly report schedule (day 4, 09:00 UTC). The cron reads it at boot.
-- 0012-d  fn_paid_split(client, start, end) — the split per platform for a period, with coverage.
-- 0012-e  fn_period_bundle(client, start, end) — summary + settlement + conventions + paid split in
--         ONE call. The chat's get_period_summary and the report loader both use it, so an
--         ordinary question resolves in one tool round instead of three or four.
-- ============================================================================

-- 0012-a ---------------------------------------------------------------------
alter table xp_account_metric_snapshots add column if not exists impressions_organic bigint;
alter table xp_account_metric_snapshots add column if not exists impressions_paid    bigint;
comment on column xp_account_metric_snapshots.impressions_organic is
  'FB page_media_view where is_from_ads = false. NULL before 2026-09-12 (never requested) and on IG (Meta offers no split).';
comment on column xp_account_metric_snapshots.impressions_paid is
  'FB page_media_view where is_from_ads = true. See impressions_organic.';

-- 0012-b ---------------------------------------------------------------------
alter table xp_clients add column if not exists brand_color text;
comment on column xp_clients.brand_color is 'Hex accent colour for the report cover and pills, e.g. #c2410c. NULL = XPulse blue.';

-- 0012-c ---------------------------------------------------------------------
alter table xp_system_config add column if not exists monthly_report_enabled  boolean not null default true;
alter table xp_system_config add column if not exists monthly_report_day      int     not null default 4;
alter table xp_system_config add column if not exists monthly_report_hour_utc int     not null default 9;
comment on column xp_system_config.monthly_report_day is
  'Day of month the previous month''s FINAL report is generated. 4 = the last day of the month has had '
  'the 2-day floor plus a 24-hour plateau to settle. Never 1.';

-- 0012-d ---------------------------------------------------------------------
create or replace function fn_paid_split(p_client uuid, p_start date, p_end date)
returns jsonb
language sql stable as $$
  select coalesce(jsonb_object_agg(platform, per), '{}'::jsonb)
  from (
    select s.platform,
           jsonb_build_object(
             'days_in_period',      (p_end - p_start + 1),
             'days_with_split',     count(*) filter (where s.impressions_organic is not null or s.impressions_paid is not null),
             'split_from',          min(s.metric_date) filter (where s.impressions_organic is not null or s.impressions_paid is not null),
             'impressions_organic', sum(s.impressions_organic),
             'impressions_paid',    sum(s.impressions_paid),
             'impressions_total',   sum(s.impressions),
             'paid_share_pct',      case when coalesce(sum(s.impressions_organic),0) + coalesce(sum(s.impressions_paid),0) > 0
                                         then round(100.0 * coalesce(sum(s.impressions_paid),0)
                                              / (coalesce(sum(s.impressions_organic),0) + coalesce(sum(s.impressions_paid),0)), 1)
                                    end,
             'note',                case when s.platform = 'IG' then 'Meta provides no paid/organic split for Instagram account insights; Instagram reach and views are organic and paid combined.'
                                         else 'Facebook impressions split by Meta''s is_from_ads breakdown; days before split_from were closed before the split was requested and stay combined.' end
           ) as per
    from xp_account_metric_snapshots s
    where s.client_id = p_client and s.metric_date between p_start and p_end
    group by s.platform
  ) t;
$$;
comment on function fn_paid_split(uuid, date, date) is
  'Per-platform paid vs organic impressions for a period, with how many days carry the split. Sums ignore nulls; a null sum means no day in the period had it.';

-- 0012-e ---------------------------------------------------------------------
create or replace function fn_period_bundle(p_client uuid, p_start date, p_end date)
returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'summary',     fn_client_period_summary(p_client, p_start, p_end),
    'settlement',  fn_period_settlement(p_client, p_start, p_end),
    'conventions', fn_conventions_for(p_start, p_end),
    'paid_split',  fn_paid_split(p_client, p_start, p_end)
  );
$$;
comment on function fn_period_bundle(uuid, date, date) is
  'Everything a period answer needs in one round trip: fn_client_period_summary + fn_period_settlement + fn_conventions_for + fn_paid_split.';

-- ----------------------------------------------------------------------------
do $$ begin
  raise notice '0012: columns impressions_organic/impressions_paid, xp_clients.brand_color, monthly report config, fn_paid_split, fn_period_bundle — applied.';
end $$;


-- ===================================================================
-- 0013_clients_meta_access_token_nullable.sql
-- ===================================================================
-- ============================================================================
-- 0013 · new xp_clients can be created again
-- ============================================================================
-- Safe to re-run. Relaxes one constraint; changes no row.
--
-- xp_clients.meta_access_token is a v1 column: v1 kept one Meta token per client there. v2 keeps tokens
-- in xp_meta_connections / xp_meta_assets and never reads or writes this column, but the column was still
-- NOT NULL with no default. Both v2 ways of creating a client — the OAuth attach with "— new client —"
-- (server.js /api/admin/oauth/:session/attach) and the manual token form (/api/admin/xp_clients/manual) —
-- insert without it, so every attempt failed with
--   null value in column "meta_access_token" of relation "xp_clients" violates not-null constraint
-- and only the three v1 xp_clients ever existed. Found 18 Sep 2026 while adding Kon Asian Bistro.
-- Applied 18 Sep 2026 through the Supabase connector (the first entry in supabase_migrations).
--
-- The old values on the three v1 rows are left alone here; nulling them is a separate hygiene step
-- (MASTER_PROGRESS.md F-27).
-- ============================================================================

alter table public.xp_clients alter column meta_access_token drop not null;


-- ===================================================================
-- 0014_conventions_per_asset.sql
-- ===================================================================
-- ============================================================================
-- 0014 · a convention note belongs to the asset it describes (MASTER_PROGRESS F-35)
-- ============================================================================
-- Safe to re-run. Adds one column and one function overload, scopes two rows, re-points two callers.
-- Rewrites no snapshot row and no note text.
--
-- xp_data_conventions had no owner: fn_conventions_for(p_start, p_end) handed every note to every client.
-- Two of the four notes describe Shaking Seafood's own history — the IG reach audit ("6 September 2026,
-- is understated (stored 3; Meta reports 9)") and the day-attribution bug fixed on 8 Sep — so the other
-- xp_clients' chat and reports would quote them as facts about their own data (breaks §2.8). None of the
-- other xp_clients' rows in that span were written by the buggy sync or locked on the old timer: Bon Asian's
-- history starts 30 Aug and was synced from 15 Sep; Mosaka, Kon, Tomo and Sawa were backfilled on 18 Sep.
--
-- 0014-a  xp_data_conventions.asset_id — null means "every asset on that platform".
-- 0014-b  TIMER_LOCK_MID_COUNT and DAY_PLUS_ONE scoped to Shaking Seafood's IG asset; logged in xp_data_repairs.
-- 0014-c  fn_conventions_for(p_client, p_start, p_end): platform-wide notes plus the client's own.
--         The two-argument form now returns platform-wide notes only, so nothing can leak through it.
-- 0014-d  fn_client_period_summary and fn_period_bundle call the client form. Their live definitions are
--         re-executed with that single call replaced — nothing else in them changes.
--
-- Check:
--   select c.client_name, jsonb_path_query_array(fn_period_bundle(c.id, '2026-08-01', '2026-09-18'), '$.conventions[*].convention')
--   from xp_clients c order by c.created_at;
-- ============================================================================

-- 0014-a ---------------------------------------------------------------------
alter table xp_data_conventions add column if not exists asset_id uuid references xp_meta_assets(id);
comment on column xp_data_conventions.asset_id is
  'The asset whose data this note describes. Null = every asset on that platform.';

-- 0014-b (EdgeLead) ----------------------------------------------------------
-- XpulseAI scoped these two notes to Shaking Seafood's Instagram asset. That asset does not exist
-- here, and the notes describe that account's history (a timer lock and a day-attribution bug this
-- copy never ran), so they are removed rather than scoped. The removal is logged.
with removed as (
  delete from xp_data_conventions
   where platform = 'IG'
     and convention in ('TIMER_LOCK_MID_COUNT', 'DAY_PLUS_ONE')
     and asset_id is null
  returning convention
)
insert into xp_data_repairs (migration, target_table, action, rows_affected, detail)
select '0014', 'xp_data_conventions', 'remove notes about another deployment''s asset', count(*),
       jsonb_build_object(
         'conventions', jsonb_agg(convention),
         'reason', 'F-35: these notes describe Shaking Seafood''s history in XpulseAI; no asset in this copy has that history')
from removed
having count(*) > 0;

-- 0014-c ---------------------------------------------------------------------
create or replace function fn_conventions_for(p_client uuid, p_start date, p_end date)
returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'platform', dc.platform, 'metric_family', dc.metric_family, 'convention', dc.convention,
           'effective_from', dc.effective_from, 'effective_to', dc.effective_to, 'note', dc.note)
         order by dc.platform, dc.effective_from), '[]'::jsonb)
  from xp_data_conventions dc
  where dc.effective_from <= p_end
    and (dc.effective_to is null or dc.effective_to >= p_start)
    and (dc.asset_id is null
         or dc.asset_id in (select a.id from xp_meta_assets a where a.client_id = p_client));
$$;

comment on function fn_conventions_for(uuid, date, date) is
  'Conventions in force at any point in [p_start, p_end] for one client: platform-wide notes plus notes '
  'about that client''s own assets. More than one row for the same platform+family means the period '
  'straddles a change and must say so.';

create or replace function fn_conventions_for(p_start date, p_end date)
returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'platform', dc.platform, 'metric_family', dc.metric_family, 'convention', dc.convention,
           'effective_from', dc.effective_from, 'effective_to', dc.effective_to, 'note', dc.note)
         order by dc.platform, dc.effective_from), '[]'::jsonb)
  from xp_data_conventions dc
  where dc.effective_from <= p_end
    and (dc.effective_to is null or dc.effective_to >= p_start)
    and dc.asset_id is null;
$$;

comment on function fn_conventions_for(date, date) is
  'Platform-wide conventions only (0014). Anything shown to a client must use '
  'fn_conventions_for(p_client, p_start, p_end), which adds the notes about that client''s own assets.';

-- 0014-d ---------------------------------------------------------------------
do $$
declare
  f record;
  d text;
begin
  for f in
    select p.oid, p.proname
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public' and p.proname in ('fn_client_period_summary', 'fn_period_bundle')
  loop
    d := pg_get_functiondef(f.oid);
    continue when position('fn_conventions_for(p_client, p_start, p_end)' in d) > 0;   -- already re-pointed
    if position('fn_conventions_for(p_start, p_end)' in d) = 0 then
      raise exception '0014-d: % does not call fn_conventions_for(p_start, p_end); left unchanged', f.proname;
    end if;
    execute replace(d, 'fn_conventions_for(p_start, p_end)', 'fn_conventions_for(p_client, p_start, p_end)');
  end loop;
end $$;


-- ===================================================================
-- 0018_close_interrupted_runs.sql
-- ===================================================================
-- ============================================================================
-- 0018 · close runs a restart left RUNNING, on the database's clock
-- ============================================================================
-- Safe to re-run. Adds one function; server.js calls it at boot.
--
-- The first version of this cleanup (v2.6.4 draft) compared started_at with the APPLICATION's clock. On
-- 18 Sep a test run on a laptop whose clock was 57 minutes fast treated a sync that was still running on
-- Render as "older than 30 minutes" and marked it FAILED; the run overwrote that when it finished.
-- Rule 11 (§2): times come from Postgres, never from the application.
-- ============================================================================

create or replace function fn_close_interrupted_runs(p_minutes integer default 30)
returns setof bigint
language sql as $$
  update xp_sync_runs
     set status = 'FAILED',
         finished_at = now(),
         errors = coalesce(errors, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
           'step', 'interrupted', 'message', 'The server restarted while this run was in progress.', 'at', now()))
   where status = 'RUNNING'
     and started_at < now() - make_interval(mins => p_minutes)
  returning id;
$$;

comment on function fn_close_interrupted_runs(integer) is
  'Marks sync runs still RUNNING after p_minutes as FAILED/interrupted, using the database clock. Called at server boot.';


-- ===================================================================
-- 0019_fb_reach_note_client_words.sql
-- ===================================================================
-- ============================================================================
-- 0019 · the Facebook reach note in client words (F-35, part 2)
-- ============================================================================
-- Safe to re-run: changes the note only while it still quotes API metric names.
--
-- REACH_MEDIA_VIEWERS (FB reach, every client) is quoted verbatim by chat and reports, and it named three
-- API metrics (page_total_media_view_unique, page_impressions_unique, page_media_view), which breaks
-- §2 rule 10. The meaning is unchanged. Rule 8: the previous wording goes to superseded_note, and the older
-- superseded text is kept in the xp_data_repairs log.
-- ============================================================================

do $$
declare r record;
begin
  select id, note, superseded_note into r from xp_data_conventions
   where platform = 'FB' and convention = 'REACH_MEDIA_VIEWERS' and note like '%page_total_media_view_unique%';
  if found then
    update xp_data_conventions
       set superseded_note = r.note,
           note = 'Facebook reach counts the people who viewed the Page''s posts and other content, which is how Meta '
               || 'measures Facebook reach now that its older reach measure has been retired. Every Facebook reach figure '
               || 'here uses this one measurement, so the figures can be compared with each other. It counts a smaller '
               || 'group than the older measure, so it should not be compared with Facebook reach in older reports or '
               || 'other tools. Facebook impressions are counted the same way.',
           note_revised_at = now()
     where id = r.id;
    insert into xp_data_repairs (migration, target_table, action, rows_affected, detail)
    values ('0019', 'xp_data_conventions', 'revise_note', 1,
            jsonb_build_object('convention', 'REACH_MEDIA_VIEWERS', 'why', 'rule 10: the note quoted API metric names to xp_clients',
                               'previous_superseded_note', r.superseded_note));
  end if;
end $$;


-- ===================================================================
-- 0020_supersede_connections_honest_health.sql
-- ===================================================================
-- ============================================================================
-- 0020 · retire superseded Meta connections (F-31) and count health gaps by values (F-44)
-- ============================================================================
-- Safe to re-run.
--
-- 1. F-31: every reconnect inserted a xp_meta_connections row and none was ever retired, so
--    validateConnections() kept checking, and alerting on, tokens that no asset uses any more
--    (Shaking Seafood had five, Bon Asian two, all ACTIVE). A connection no asset points to is
--    SUPERSEDED: kept for the record, no longer validated. From v2.7.2, attachAssets() retires them
--    after every attach.
-- 2. F-44 (rest): xp_v_sync_health counted a day as present when a row existed, even an empty v1 shell,
--    which is how Bon Asian's missing history read "30d ok". A day now counts only when it has reach.
--    Measured before applying: 0 gaps on all 12 assets under both rules, so today's figures do not move.
--    missing_dates are plain dates (they were timestamps as text).
-- ============================================================================

alter table xp_meta_connections drop constraint if exists meta_connections_status_check;
alter table xp_meta_connections drop constraint if exists xp_meta_connections_status_check;
alter table xp_meta_connections add constraint meta_connections_status_check
  check (status in ('ACTIVE', 'EXPIRED', 'REVOKED', 'INVALID', 'SUPERSEDED'));

do $$
declare n int;
begin
  update xp_meta_connections c
     set status = 'SUPERSEDED', updated_at = now()
   where c.status = 'ACTIVE'
     and not exists (select 1 from xp_meta_assets a where a.connection_id = c.id);
  get diagnostics n = row_count;
  if n > 0 then
    insert into xp_data_repairs (migration, target_table, action, rows_affected, detail)
    values ('0020', 'xp_meta_connections', 'supersede', n,
            jsonb_build_object('why', 'F-31: connections left behind by reconnects; no asset uses them'));
  end if;
end $$;

create or replace view xp_v_sync_health as
select a.id as asset_id, a.client_id, a.platform, a.name,
       a.last_synced_at,
       (select count(*) from generate_series(current_date - 29, current_date - 1, '1 day') g(d)
         where not exists (select 1 from xp_account_metric_snapshots s
                            where s.asset_id = a.id and s.metric_date = g.d and s.reach is not null)) as missing_days_30,
       (select array_agg(g.d::date::text order by g.d) from generate_series(current_date - 29, current_date - 1, '1 day') g(d)
         where not exists (select 1 from xp_account_metric_snapshots s
                            where s.asset_id = a.id and s.metric_date = g.d and s.reach is not null)) as missing_dates
from xp_meta_assets a
where a.status = 'ACTIVE';


-- ===================================================================
-- 0021_conversation_soft_delete.sql
-- ===================================================================
-- ============================================================================
-- 0021 · xp_clients can delete a chat from the portal (soft delete)
-- ============================================================================
-- Safe to re-run. A deleted conversation keeps its rows: the admin's usage and cost figures and the
-- optional daily question limit count xp_ai_messages, so deleting a chat must not erase them (nor let a
-- client reset the limit by deleting today's chats). The portal lists and opens only conversations
-- without deleted_at; asking in a deleted conversation starts a new one.
-- ============================================================================
alter table xp_ai_conversations add column if not exists deleted_at timestamptz;
create index if not exists xp_ai_conversations_client_live_idx on xp_ai_conversations (client_id, updated_at desc) where deleted_at is null;


-- ===================================================================
-- 0022_stage_e_ads.sql
-- ===================================================================
-- 0022 — Stage E: ad spend, results and return on ad spend from Meta ad accounts (v2.8.0, 18 Sep 2026).
--
-- What it adds
--   xp_meta_ad_accounts    every ad account the connected Meta login can read, found on each sync. An
--                       account appears once its owner shares it with that login or its business.
--   xp_meta_ads            each ad seen, and the restaurant it belongs to, matched by the Facebook Page or
--                       Instagram account the ad runs as. An ad for a Page that is no client's is kept
--                       with no restaurant (looked up once) and its figures are never stored.
--   xp_meta_ad_campaigns   campaign name, objective, status and lifetime totals. Reach lives here, per
--                       campaign over its whole run: people are never added up across days or campaigns.
--   xp_ad_daily_snapshots  one row per ad per day, in the ad account's time zone: spend, ad views
--                       (impressions), clicks, link clicks, and Meta's actions and action values.
--                       Meta can attribute messages, leads and purchases to a day for up to 28 days, so
--                       a row stays open and is re-read on every sync until the day is 29 days old; then
--                       it closes and never changes (fn_guard_final_ad_row, as fn_guard_final_snapshot
--                       does for account rows).
--   fn_ad_summary, fn_ad_campaigns, fn_ad_daily   the only readers the chat and the report use.
--   xp_sync_runs.run_type  gains 'ADS'.
--
-- Return on ad spend is purchase value / spend, and only where Meta recorded purchase value. Nothing
-- here estimates revenue. Safe to run twice.

-- 0022-a ---------------------------------------------------------------------- tables
create table if not exists xp_meta_ad_accounts (
  ad_account_id   text primary key,                                   -- 'act_<id>'
  name            text,
  currency        text,
  timezone_name   text,
  account_status  integer,                                            -- Meta: 1 active, 2 disabled, 101 closed, ...
  business_name   text,
  meta_user_id    text,                                               -- the Meta login that can read it
  client_id       uuid references xp_clients(id) on delete set null,     -- set when every ad in it is one restaurant's, or by the admin
  is_active       boolean not null default true,                      -- false: the admin stopped syncing it
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  last_synced_at  timestamptz,
  last_error      text
);
comment on table xp_meta_ad_accounts is
  'Stage E (0022). Ad accounts the connected Meta login can read. client_id is the one restaurant every ad in the account belongs to (set automatically, or by the admin); null for an account that serves several.';

create table if not exists xp_meta_ad_campaigns (
  campaign_id           text primary key,
  ad_account_id         text not null references xp_meta_ad_accounts(ad_account_id) on delete cascade,
  client_id             uuid references xp_clients(id) on delete cascade,
  name                  text,
  objective             text,
  status                text,                                         -- Meta's effective_status
  start_time            timestamptz,
  stop_time             timestamptz,
  lifetime_spend        numeric(14,2),
  lifetime_impressions  bigint,
  lifetime_reach        bigint,
  lifetime_link_clicks  bigint,
  lifetime_from         date,
  lifetime_to           date,
  lifetime_as_of        timestamptz,
  updated_at            timestamptz not null default now()
);
create index if not exists xp_meta_ad_campaigns_client_idx on xp_meta_ad_campaigns (client_id);

create table if not exists xp_meta_ads (
  ad_id          text primary key,
  ad_account_id  text not null references xp_meta_ad_accounts(ad_account_id) on delete cascade,
  campaign_id    text,
  adset_id       text,
  name           text,
  client_id      uuid references xp_clients(id) on delete cascade,
  page_id        text,
  ig_user_id     text,
  matched_by     text check (matched_by in ('facebook_page', 'instagram_account')),
  lookup_error   text,                                                -- the creative could not be read; retried on the next sync
  first_seen_at  timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists xp_meta_ads_client_idx on xp_meta_ads (client_id);
create index if not exists xp_meta_ads_account_idx on xp_meta_ads (ad_account_id);

create table if not exists xp_ad_daily_snapshots (
  ad_id              text not null references xp_meta_ads(ad_id) on delete cascade,
  metric_date        date not null,                                   -- a day in the ad account's time zone
  client_id          uuid not null references xp_clients(id) on delete cascade,
  ad_account_id      text not null references xp_meta_ad_accounts(ad_account_id) on delete cascade,
  campaign_id        text,
  currency           text not null,
  spend              numeric(14,2),
  impressions        bigint,                                          -- shown to xp_clients as ad views
  reach              bigint,                                          -- people reached that day by this ad; never summed
  clicks             bigint,
  link_clicks        bigint,
  post_engagements   numeric,
  video_plays        numeric,
  messages_started   numeric,
  leads              numeric,
  purchases          numeric,
  purchase_value     numeric(14,2),
  actions            jsonb,
  action_values      jsonb,
  raw                jsonb,
  is_final           boolean not null default false,
  first_observed_at  timestamptz not null default now(),
  observed_at        timestamptz not null default now(),
  primary key (ad_id, metric_date)
);
create index if not exists xp_ad_daily_client_date_idx on xp_ad_daily_snapshots (client_id, metric_date);
create index if not exists xp_ad_daily_account_open_idx on xp_ad_daily_snapshots (ad_account_id, metric_date) where not is_final;
comment on table xp_ad_daily_snapshots is
  'Stage E (0022). One row per ad per day (ad account time zone). Open for 29 days while Meta can still attribute results to the day, then final and immutable (fn_guard_final_ad_row).';

-- Only the server (service role) reads and writes these, as for every other table.
alter table xp_meta_ad_accounts   enable row level security;
alter table xp_meta_ad_campaigns  enable row level security;
alter table xp_meta_ads           enable row level security;
alter table xp_ad_daily_snapshots enable row level security;

-- 0022-b ---------------------------------------------------------------------- a closed day never changes
-- A final row may not be updated or deleted. A re-read of an open row stamps observed_at with the
-- database clock (principle 11) and keeps first_observed_at; closing a row changes nothing else.
create or replace function fn_guard_final_ad_row() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if old.is_final then
      raise exception 'xp_ad_daily_snapshots: ad % on % is final and cannot be deleted', old.ad_id, old.metric_date;
    end if;
    return old;
  end if;
  if old.is_final then
    raise exception 'xp_ad_daily_snapshots: ad % on % is final and cannot change', old.ad_id, old.metric_date;
  end if;
  new.first_observed_at := old.first_observed_at;
  if new.is_final is not distinct from old.is_final then new.observed_at := now(); end if;
  return new;
end $$;

drop trigger if exists trg_ad_daily_guard_upd on xp_ad_daily_snapshots;
drop trigger if exists trg_ad_daily_guard_del on xp_ad_daily_snapshots;
create trigger trg_ad_daily_guard_upd before update on xp_ad_daily_snapshots for each row execute function fn_guard_final_ad_row();
create trigger trg_ad_daily_guard_del before delete on xp_ad_daily_snapshots for each row execute function fn_guard_final_ad_row();

-- 0022-c ---------------------------------------------------------------------- xp_sync_runs knows ad runs
alter table xp_sync_runs drop constraint if exists sync_runs_run_type_check;
alter table xp_sync_runs drop constraint if exists xp_sync_runs_run_type_check;
alter table xp_sync_runs add constraint sync_runs_run_type_check
  check (run_type in ('CRON', 'MANUAL', 'BACKFILL', 'DISCOVERY', 'FINALIZE', 'ADS'));

-- 0022-d ---------------------------------------------------------------------- readers
-- The period's ad figures for a restaurant. Money is never added across currencies: totals is the
-- single-currency result, and null when the period mixes currencies (by_currency then has each).
-- roas only when Meta recorded purchase value; costs only when their denominator is above zero.
create or replace function fn_ad_summary(p_client uuid, p_start date, p_end date)
returns jsonb
language sql stable set search_path = public as $$
  with r as (
    select * from xp_ad_daily_snapshots where client_id = p_client and metric_date between p_start and p_end
  ), cur as (
    select currency,
           sum(spend) as spend, sum(impressions) as impressions, sum(clicks) as clicks, sum(link_clicks) as link_clicks,
           sum(post_engagements) as post_engagements, sum(video_plays) as video_plays,
           sum(messages_started) as messages_started, sum(leads) as leads,
           sum(purchases) as purchases, sum(purchase_value) as purchase_value,
           count(distinct metric_date) filter (where spend > 0) as days_with_spend,
           count(distinct metric_date) filter (where not is_final) as days_still_updating,
           count(distinct campaign_id) as campaigns, count(distinct ad_id) as ads,
           min(metric_date) as first_day, max(metric_date) as last_day
    from r group by currency
  ), per as (
    select currency, jsonb_build_object(
             'currency', currency, 'spend', spend, 'ad_views', impressions, 'clicks', clicks, 'link_clicks', link_clicks,
             'post_engagements', post_engagements, 'video_plays', video_plays, 'messages_started', messages_started,
             'leads', leads, 'purchases', purchases, 'purchase_value', purchase_value,
             'roas', case when spend > 0 and purchase_value > 0 then round(purchase_value / spend, 2) end,
             'cost_per_link_click', case when link_clicks > 0 then round(spend / link_clicks, 2) end,
             'cost_per_message', case when messages_started > 0 then round(spend / messages_started, 2) end,
             'cost_per_lead', case when leads > 0 then round(spend / leads, 2) end,
             'cost_per_purchase', case when purchases > 0 then round(spend / purchases, 2) end,
             'cost_per_1000_views', case when impressions > 0 then round(spend * 1000 / impressions, 2) end,
             'link_click_rate_pct', case when impressions > 0 then round(100.0 * link_clicks / impressions, 2) end,
             'days_with_spend', days_with_spend, 'days_still_updating', days_still_updating,
             'campaigns', campaigns, 'ads', ads, 'first_day', first_day, 'last_day', last_day) as j,
           spend
    from cur
  ), accts as (
    select x.* from xp_meta_ad_accounts x
    where x.is_active and (x.client_id = p_client or exists (select 1 from xp_meta_ads a where a.ad_account_id = x.ad_account_id and a.client_id = p_client))
  )
  select jsonb_build_object(
    'period', jsonb_build_object('start', p_start, 'end', p_end, 'days', p_end - p_start + 1),
    'connected', exists (select 1 from accts),
    'ad_accounts', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'currency', currency, 'timezone', timezone_name, 'last_synced_at', last_synced_at) order by name), '[]'::jsonb) from accts),
    'data_from', (select min(metric_date) from xp_ad_daily_snapshots where client_id = p_client),
    'last_synced_at', (select max(last_synced_at) from accts),
    'totals', case when (select count(*) from per) = 1 then (select j from per) end,
    'by_currency', (select coalesce(jsonb_agg(j order by spend desc nulls last), '[]'::jsonb) from per)
  );
$$;
comment on function fn_ad_summary(uuid, date, date) is
  'Stage E. A restaurant''s ad figures for a period: spend, ad views, clicks, results, costs and return on ad spend (only where Meta recorded purchase value). connected says whether any ad account is linked to the restaurant.';

-- Campaigns in the period, by spend. lifetime carries reach over the campaign's whole run.
create or replace function fn_ad_campaigns(p_client uuid, p_start date, p_end date, p_limit integer default 10)
returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(c order by (c->>'spend')::numeric desc nulls last), '[]'::jsonb)
  from (
    select jsonb_build_object(
             'campaign_id', r.campaign_id,
             'name', coalesce(k.name, 'Campaign ' || r.campaign_id),
             'objective', k.objective, 'status', k.status,
             'currency', min(r.currency),
             'spend', sum(r.spend), 'ad_views', sum(r.impressions), 'clicks', sum(r.clicks), 'link_clicks', sum(r.link_clicks),
             'post_engagements', sum(r.post_engagements), 'video_plays', sum(r.video_plays),
             'messages_started', sum(r.messages_started), 'leads', sum(r.leads),
             'purchases', sum(r.purchases), 'purchase_value', sum(r.purchase_value),
             'roas', case when sum(r.spend) > 0 and sum(r.purchase_value) > 0 then round(sum(r.purchase_value) / sum(r.spend), 2) end,
             'cost_per_link_click', case when sum(r.link_clicks) > 0 then round(sum(r.spend) / sum(r.link_clicks), 2) end,
             'cost_per_message', case when sum(r.messages_started) > 0 then round(sum(r.spend) / sum(r.messages_started), 2) end,
             'first_day', min(r.metric_date), 'last_day', max(r.metric_date),
             'days_still_updating', count(distinct r.metric_date) filter (where not r.is_final),
             'lifetime', case when k.client_id = p_client then jsonb_build_object(
                 'reach', k.lifetime_reach, 'spend', k.lifetime_spend, 'ad_views', k.lifetime_impressions,
                 'from', k.lifetime_from, 'to', k.lifetime_to) end,
             'start_time', k.start_time, 'stop_time', k.stop_time
           ) as c
    from xp_ad_daily_snapshots r
    left join xp_meta_ad_campaigns k on k.campaign_id = r.campaign_id
    where r.client_id = p_client and r.metric_date between p_start and p_end
    group by r.campaign_id, k.campaign_id
    order by sum(r.spend) desc nulls last
    limit greatest(1, least(coalesce(p_limit, 10), 50))
  ) t;
$$;
comment on function fn_ad_campaigns(uuid, date, date, integer) is
  'Stage E. A restaurant''s campaigns in a period, by spend, with results, costs, return on ad spend where Meta recorded purchase value, and lifetime reach.';

-- Day by day, for charts.
create or replace function fn_ad_daily(p_client uuid, p_start date, p_end date)
returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(d order by d->>'date', d->>'currency'), '[]'::jsonb)
  from (
    select jsonb_build_object(
             'date', metric_date, 'currency', currency,
             'spend', sum(spend), 'ad_views', sum(impressions), 'link_clicks', sum(link_clicks),
             'messages_started', sum(messages_started), 'purchases', sum(purchases), 'purchase_value', sum(purchase_value),
             'still_updating', bool_or(not is_final)) as d
    from xp_ad_daily_snapshots
    where client_id = p_client and metric_date between p_start and p_end
    group by metric_date, currency
  ) t;
$$;
comment on function fn_ad_daily(uuid, date, date) is
  'Stage E. A restaurant''s ad spend, ad views and results per day (ad account time zone), per currency.';

do $$ begin raise notice '0022: xp_meta_ad_accounts, xp_meta_ads, xp_meta_ad_campaigns, xp_ad_daily_snapshots (+ guard), xp_sync_runs ADS, fn_ad_summary, fn_ad_campaigns, fn_ad_daily — applied.'; end $$;


-- ===================================================================
-- 0023_post_views_are_views.sql
-- ===================================================================
-- 0023 — A post's views are Meta's Views on both platforms (v2.8.1, 19 Sep 2026).
--
-- F-56. fn_content_table (and fn_top_posts, which reads it) returned a Facebook post's `views` from
-- post_video_views: 3-second video plays, 0 on every photo and link. Meta's post Views
-- (post_media_view) sat under `impressions`. So the chat showed video plays as a Facebook post's
-- views (176 for a video Meta shows as 415 views), and p_order 'views' fell through to reach, so
-- "top posts by views" was really by reach.
--   * `views` is now Meta's Views on both platforms: Facebook post_media_view, Instagram views.
--   * `video_views` keeps the video plays. `impressions` is no longer returned: it only duplicated views.
--   * `views_gained_in_period`, from the same trusted daily deltas as reach_gained_in_period.
--   * p_order 'views' ranks by views.
-- Nothing else reads fn_content_table or fn_top_posts (checked 19 Sep); the report reads its own
-- functions. Safe to run twice.

create or replace function fn_content_table(p_client uuid, p_start date, p_end date, p_limit integer default 200, p_order text default 'reach')
returns jsonb
language plpgsql stable as $function$
declare v_tz text; v_out jsonb;
begin
  select coalesce(timezone,'UTC') into v_tz from xp_clients where id = p_client;

  select coalesce(jsonb_agg(x order by x_rank), '[]'::jsonb) into v_out
  from (
    select jsonb_build_object(
             'post_id', p.meta_post_id, 'platform', p.platform, 'format',
             fn_content_format(p.platform, p.media_type, p.media_product_type),
             'caption', left(coalesce(p.caption,''), 220),
             'permalink', p.permalink, 'thumbnail_url', p.thumbnail_url,
             'published_at', p.publish_date,
             'published_on', (p.publish_date at time zone v_tz)::date,
             'as_of', s.snapshot_date,
             'reach', s.reach, 'views', v.views, 'plays', s.plays,
             'likes', coalesce(s.likes, s.reactions_total), 'comments', s.comments,
             'shares', s.shares, 'saves', s.saves,
             'video_views', s.video_views, 'avg_watch_time_ms', s.avg_watch_time_ms,
             'clicks', s.clicks, 'profile_visits', s.profile_visits, 'follows', s.follows,
             'interactions', fn_interactions(p.platform, s.total_interactions, s.likes,
                                             s.reactions_total, s.comments, s.shares, s.saves),
             'engagement_rate', fn_er(fn_interactions(p.platform, s.total_interactions, s.likes,
                                             s.reactions_total, s.comments, s.shares, s.saves), s.reach),
             'reach_gained_in_period', g.reach_gained,
             'views_gained_in_period', g.views_gained,
             'interactions_gained_in_period', g.interactions_gained,
             'tracked_in_period', g.reach_gained is not null
           ) as x,
           row_number() over (
             order by case lower(p_order)
                        when 'engagement' then fn_er(fn_interactions(p.platform, s.total_interactions,
                                                s.likes, s.reactions_total, s.comments, s.shares, s.saves), s.reach)
                        when 'interactions' then fn_interactions(p.platform, s.total_interactions, s.likes,
                                                s.reactions_total, s.comments, s.shares, s.saves)::numeric
                        when 'views' then coalesce(v.views, 0)::numeric
                        when 'recent' then extract(epoch from p.publish_date)::numeric
                        else coalesce(s.reach, 0)::numeric end desc nulls last
           ) as x_rank
    from xp_meta_posts p
    left join lateral (
      select * from xp_post_metric_snapshots s2
      where s2.asset_id = p.asset_id and s2.meta_post_id = p.meta_post_id
        and s2.snapshot_date <= p_end
      order by s2.snapshot_date desc limit 1
    ) s on true
    -- Meta's Views: Facebook post_media_view (stored as impressions), Instagram views.
    cross join lateral (
      select case when p.platform = 'FB' then s.impressions else coalesce(s.views, s.impressions) end as views
    ) v
    left join lateral (
      select sum(d.reach_gained) as reach_gained, sum(d.interactions_gained) as interactions_gained,
             sum(case when p.platform = 'FB' then d.impressions_gained else coalesce(d.views_gained, d.impressions_gained) end) as views_gained
      from xp_v_post_daily_deltas d
      where d.asset_id = p.asset_id and d.meta_post_id = p.meta_post_id
        and d.snapshot_date between p_start and p_end and d.is_trusted
    ) g on true
    where p.client_id = p_client
      and not p.is_story and not p.is_deleted
      and (p.publish_date at time zone v_tz)::date between p_start and p_end
    order by x_rank
    limit greatest(p_limit, 1)
  ) q;

  return v_out;
end $function$;

comment on function fn_content_table(uuid, date, date, integer, text) is
  'Posts published in the period with lifetime counters as of the period end. views = Meta''s Views on both platforms (Facebook post_media_view); video_views = video plays. Gains in period from trusted daily deltas. p_order: views | reach | interactions | engagement | recent (0023).';

do $$ begin raise notice '0023: fn_content_table — views are Meta''s Views on both platforms, views_gained_in_period, order by views — applied.'; end $$;

-- 0023, part 2 — formats and timing carry views too (applied 19 Sep as its own step). Views are Meta's
-- Views: Facebook post_media_view (the impressions column), Instagram views. Formats are listed by
-- total views; every figure that was there before is still there.
create or replace function fn_format_breakdown(p_client uuid, p_start date, p_end date)
returns jsonb
language plpgsql stable as $function$
declare v_tz text; v_out jsonb;
begin
  select coalesce(timezone,'UTC') into v_tz from xp_clients where id = p_client;

  select coalesce(jsonb_agg(jsonb_build_object(
           'platform', platform, 'format', format,
           'posts', posts,
           'total_views', total_views, 'avg_views', avg_views,
           'total_reach', total_reach, 'avg_reach', avg_reach, 'median_reach', median_reach,
           'total_interactions', total_interactions, 'avg_interactions', avg_interactions,
           'avg_engagement_rate', avg_er,
           'share_of_posts_pct', round(posts::numeric * 100 / nullif(platform_posts, 0), 1),
           'share_of_views_pct', round(total_views::numeric * 100 / nullif(platform_views, 0), 1),
           'share_of_reach_pct', round(total_reach::numeric * 100 / nullif(platform_reach, 0), 1)
         ) order by platform, total_views desc nulls last, total_reach desc nulls last), '[]'::jsonb) into v_out
  from (
    -- window functions cannot be nested inside an aggregate call, so the per-platform
    -- denominators are computed here and only read above
    select b.*,
           sum(b.posts)        over (partition by b.platform) as platform_posts,
           sum(b.total_views)  over (partition by b.platform) as platform_views,
           sum(b.total_reach)  over (partition by b.platform) as platform_reach
    from (
      select v.platform, v.format,
             count(*)                                                            as posts,
             sum(w.views)                                                        as total_views,
             round(avg(w.views))                                                 as avg_views,
             sum(v.reach)                                                        as total_reach,
             round(avg(v.reach))                                                 as avg_reach,
             round(percentile_cont(0.5) within group
                   (order by v.reach::double precision)::numeric)                as median_reach,
             sum(v.interactions)                                                 as total_interactions,
             round(avg(v.interactions))                                          as avg_interactions,
             round(avg(v.engagement_rate), 2)                                    as avg_er
      from xp_v_post_scored v
      cross join lateral (select case when v.platform = 'FB' then v.impressions else coalesce(v.views, v.impressions) end as views) w
      where v.client_id = p_client and not v.is_story and not v.is_deleted
        and (v.publish_date at time zone v_tz)::date between p_start and p_end
      group by v.platform, v.format
    ) b
  ) q;

  return jsonb_build_object(
    'period', jsonb_build_object('start', p_start, 'end', p_end, 'timezone', v_tz),
    'basis', 'lifetime counters as of the latest snapshot, for posts published in this window',
    'formats', v_out);
end $function$;

create or replace function fn_posting_pattern(p_client uuid, p_start date, p_end date)
returns jsonb
language plpgsql stable as $function$
declare v_tz text; v_dow jsonb; v_hour jsonb; v_online jsonb;
begin
  select coalesce(timezone,'UTC') into v_tz from xp_clients where id = p_client;

  select coalesce(jsonb_agg(jsonb_build_object(
           'platform', platform, 'dow', dow, 'day_name', day_name, 'posts', posts,
           'avg_views', avg_views, 'avg_reach', avg_reach, 'avg_interactions', avg_interactions, 'avg_engagement_rate', avg_er)
         order by platform, dow), '[]'::jsonb) into v_dow
  from (
    select v.platform,
           extract(dow from (v.publish_date at time zone v_tz))::int  as dow,
           trim(to_char((v.publish_date at time zone v_tz), 'Day'))   as day_name,
           count(*) as posts, round(avg(w.views)) as avg_views, round(avg(v.reach)) as avg_reach,
           round(avg(v.interactions)) as avg_interactions, round(avg(v.engagement_rate),2) as avg_er
    from xp_v_post_scored v
    cross join lateral (select case when v.platform = 'FB' then v.impressions else coalesce(v.views, v.impressions) end as views) w
    where v.client_id = p_client and not v.is_story and not v.is_deleted
      and (v.publish_date at time zone v_tz)::date between p_start and p_end
    group by 1,2,3
  ) q;

  select coalesce(jsonb_agg(jsonb_build_object(
           'platform', platform, 'hour', hour, 'posts', posts,
           'avg_views', avg_views, 'avg_reach', avg_reach, 'avg_engagement_rate', avg_er) order by platform, hour), '[]'::jsonb) into v_hour
  from (
    select v.platform,
           extract(hour from (v.publish_date at time zone v_tz))::int as hour,
           count(*) as posts, round(avg(w.views)) as avg_views, round(avg(v.reach)) as avg_reach, round(avg(v.engagement_rate),2) as avg_er
    from xp_v_post_scored v
    cross join lateral (select case when v.platform = 'FB' then v.impressions else coalesce(v.views, v.impressions) end as views) w
    where v.client_id = p_client and not v.is_story and not v.is_deleted
      and (v.publish_date at time zone v_tz)::date between p_start and p_end
    group by 1,2
  ) q;

  -- When the audience is actually online (IG only, rolling 30 days, hour → follower count).
  -- Averaged across the most recent days that carry the breakdown.
  select coalesce(jsonb_object_agg(hr::text, avg_followers), '{}'::jsonb) into v_online
  from (
    select kv.key::int as hr, round(avg(kv.value::numeric)) as avg_followers
    from xp_account_metric_snapshots a
    cross join lateral jsonb_each_text(a.online_followers) kv
    where a.client_id = p_client and a.platform = 'IG'
      and a.online_followers is not null
      and a.metric_date between p_start and p_end
      and kv.value ~ '^[0-9.]+$'
    group by 1
  ) q;

  return jsonb_build_object(
    'period', jsonb_build_object('start', p_start, 'end', p_end, 'timezone', v_tz),
    'note', 'Averages are over posts published in the window, using lifetime counters. '
            'A day or hour with 1–2 posts is not evidence.',
    'by_day_of_week', v_dow,
    'by_hour', v_hour,
    'audience_online_by_hour', v_online);
end $function$;

do $$ begin raise notice '0023 part 2: fn_format_breakdown and fn_posting_pattern carry avg/total views (Meta''s Views) — applied.'; end $$;


-- ===================================================================
-- 0024_ads_logins.sql
-- ===================================================================
-- 0024 — Facebook logins connected for ads only (v2.8.2, 19 Sep 2026).
--
-- Admin → Ads → "Connect ad accounts" signs in with the Facebook profile that can see the ad accounts
-- the boosts are paid from, asking only for ads_read and business_management. That login is kept
-- here, NOT in xp_meta_connections: it never replaces a Page connection and never touches a Page token,
-- so connecting it cannot disconnect a restaurant (F-22 is about Page logins). The ads sync reads the
-- ad accounts of every ACTIVE row here as well as of every Page connection's login.
create table if not exists xp_meta_ad_logins (
  id                 uuid primary key default gen_random_uuid(),
  meta_user_id       text not null unique,
  name               text,
  token_enc          text not null,
  scopes             text[],
  token_expires_at   timestamptz,
  status             text not null default 'ACTIVE' check (status in ('ACTIVE', 'REMOVED')),
  ad_accounts_seen   integer,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  last_error         text
);
comment on table xp_meta_ad_logins is
  'v2.8.2 (0024). Facebook logins connected for ads only (ads_read, business_management), confirmed by the admin. Never used for Pages.';
alter table xp_meta_ad_logins enable row level security;

do $$ begin raise notice '0024: xp_meta_ad_logins — applied.'; end $$;


-- ===================================================================
-- 0026_apify_keys.sql
-- ===================================================================
-- 0026 — Apify keys, managed from the X Pulse Workspace (v2.9.2, 19 Sep 2026).
--
-- The influencer and content-audit scrapers (next steps) run on Apify. Keys are added in the workspace
-- (Settings → Apify keys) instead of Render's environment, so one can be added, swapped or removed
-- without a redeploy. They form a pool: a run uses the ACTIVE key with the most credit left in its
-- monthly cycle and moves to the next when Apify says a key is out of credit (402) or no longer valid
-- (401). The key itself is stored encrypted (AES-GCM, src/security.js) and never sent to a browser.
-- Additive only: one new table, nothing existing changes.
create table if not exists xp_apify_keys (
  id               uuid primary key default gen_random_uuid(),
  label            text not null,
  token_enc        text not null,                    -- encrypted; only the server can read it
  token_last4      text not null,                    -- what the workspace shows
  status           text not null default 'ACTIVE' check (status in ('ACTIVE', 'DISABLED', 'INVALID')),
  apify_user_id    text,
  apify_username   text,
  plan             text,
  is_paying        boolean,
  limit_usd        numeric,                          -- this monthly cycle, from GET /v2/users/me/limits
  used_usd         numeric,
  cycle_start      timestamptz,
  cycle_end        timestamptz,
  exhausted_until  timestamptz,                      -- out of credit until the cycle resets
  runs             integer not null default 0,
  last_checked_at  timestamptz,
  last_used_at     timestamptz,
  last_error       text,
  created_by       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
-- One row per Apify account: adding a new key for an account already in the pool replaces its key.
create unique index if not exists xp_apify_keys_account_key on xp_apify_keys (apify_user_id) where apify_user_id is not null;
comment on table xp_apify_keys is
  'v2.9.2 (0026). Apify API keys for the scrapers, added in the workspace. Encrypted; a run uses the active key with the most credit left.';
alter table xp_apify_keys enable row level security;

do $$ begin raise notice '0026: xp_apify_keys — applied.'; end $$;


-- ===================================================================
-- 0028_social_data.sql
-- ===================================================================
-- 0028 — Public social data for content work (v2.11.0, 19 Sep 2026): influencers, content audits, ideas.
--
-- Read with Apify (the key pool, 0026) from public Instagram profiles and posts: each restaurant's own public
-- profile, one rival per restaurant, and the influencers who post about it. Meta's API never returns a
-- collab post an influencer owns, but the restaurant's public grid does (coauthorProducers), so collabs are
-- found automatically. Numbers are what Instagram shows publicly (views = plays, likes, comments); the
-- restaurants' private insights stay in the Meta tables. Staff-only: owners see influencer results in their
-- answers and report, never rivals. Additive only: new tables, nothing existing changes.

create table if not exists xp_social_profiles (
  id               uuid primary key default gen_random_uuid(),
  platform         text not null check (platform in ('IG', 'TT')),
  username         text not null,                    -- lower case, no @
  external_id      text,
  full_name        text,
  biography        text,
  category         text,
  verified         boolean,
  is_business      boolean,
  followers        integer,
  following        integer,
  posts_count      integer,
  profile_pic_path text,                             -- a copy in storage (Instagram's links expire)
  last_fetched_at  timestamptz,
  raw              jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (platform, username)
);
comment on table xp_social_profiles is 'v2.11.0 (0028). Public profiles read with Apify: restaurants'' own, rivals, influencers.';

-- Which public profiles a restaurant's content work looks at: its own (SELF) and its rival(s) (RIVAL).
create table if not exists xp_client_social_profiles (
  client_id   uuid not null references xp_clients(id) on delete cascade,
  profile_id  uuid not null references xp_social_profiles(id) on delete cascade,
  role        text not null check (role in ('SELF', 'RIVAL')),
  added_by    text,
  created_at  timestamptz not null default now(),
  primary key (client_id, profile_id)
);

create table if not exists xp_social_posts (
  id                uuid primary key default gen_random_uuid(),
  platform          text not null check (platform in ('IG', 'TT')),
  external_id       text not null,                   -- the platform's post id
  short_code        text,                            -- Instagram's code in /p/… and /reel/…
  url               text,
  owner_profile_id  uuid references xp_social_profiles(id) on delete set null,
  owner_username    text,
  posted_at         timestamptz,
  format            text check (format in ('PHOTO', 'CAROUSEL', 'REEL', 'VIDEO')),
  caption           text,
  hashtags          text[] not null default '{}',
  mentions          text[] not null default '{}',
  collaborators     text[] not null default '{}',   -- coauthors of a collab post
  tagged            text[] not null default '{}',
  paid_partnership  boolean,
  duration_s        numeric,
  music             text,
  views             integer,                         -- the latest public numbers (views = plays)
  likes             integer,
  comments          integer,
  shares            integer,
  saves             integer,
  thumbnail_path    text,                            -- a copy in storage
  ai                jsonb,                           -- content tags from Gemini (themes, opening line, call to action, …)
  first_seen_at     timestamptz not null default now(),
  last_fetched_at   timestamptz,
  raw               jsonb,
  unique (platform, external_id)
);
create index if not exists xp_social_posts_owner_idx on xp_social_posts (owner_profile_id, posted_at desc);
create index if not exists xp_social_posts_short_code_idx on xp_social_posts (short_code);
comment on table xp_social_posts is 'v2.11.0 (0028). Public posts read with Apify, with their latest public numbers and content tags.';

-- Every read of a post's public numbers, so growth over days and weeks can be shown.
create table if not exists xp_social_post_snapshots (
  id          bigint generated always as identity primary key,
  post_id     uuid not null references xp_social_posts(id) on delete cascade,
  fetched_at  timestamptz not null default now(),
  views       integer,
  likes       integer,
  comments    integer,
  shares      integer,
  saves       integer
);
create index if not exists xp_social_post_snapshots_post_idx on xp_social_post_snapshots (post_id, fetched_at);

-- Influencer posts about a restaurant: found on its public grid (a collab) or added by staff.
create table if not exists xp_influencer_posts (
  id                   uuid primary key default gen_random_uuid(),
  client_id            uuid not null references xp_clients(id) on delete cascade,
  post_id              uuid not null references xp_social_posts(id) on delete cascade,
  influencer_username  text,
  source               text not null check (source in ('AUTO', 'MANUAL')),
  status               text not null default 'ACTIVE' check (status in ('ACTIVE', 'HIDDEN')),
  visit_date           date,
  cost_usd             numeric,
  notes                text,
  added_by             text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (client_id, post_id)
);
comment on table xp_influencer_posts is 'v2.11.0 (0028). Influencer posts per restaurant (AUTO: a collab found on its grid; MANUAL: added by staff).';

-- A content audit: a restaurant against one rival, from both profiles' public posts.
create table if not exists xp_content_audits (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null references xp_clients(id) on delete cascade,
  self_profile_id   uuid references xp_social_profiles(id) on delete set null,
  rival_profile_id  uuid references xp_social_profiles(id) on delete set null,
  status            text not null default 'RUNNING' check (status in ('RUNNING', 'DONE', 'FAILED')),
  window_days       integer,
  stats             jsonb,                           -- worked out in code
  analysis          jsonb,                           -- the AI's reading of those numbers
  error             text,
  cost_usd          numeric,
  created_by        text,
  created_at        timestamptz not null default now(),
  finished_at       timestamptz
);
create index if not exists xp_content_audits_client_idx on xp_content_audits (client_id, created_at desc);

-- Post ideas, from an audit or written by staff.
create table if not exists xp_content_ideas (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references xp_clients(id) on delete cascade,
  audit_id    uuid references xp_content_audits(id) on delete set null,
  format      text,
  title       text not null,
  hook        text,
  caption     text,
  shot_list   text,
  best_time   text,
  why         text,
  evidence    text[] not null default '{}',          -- the posts behind the idea
  status      text not null default 'NEW' check (status in ('NEW', 'KEPT', 'USED', 'BINNED')),
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists xp_content_ideas_client_idx on xp_content_ideas (client_id, created_at desc);

-- Every Apify run: what for, for which restaurant, on which key, how many results, what it cost.
create table if not exists xp_apify_runs (
  id           bigint generated always as identity primary key,
  actor        text not null,
  purpose      text not null,                        -- DISCOVER, INFLUENCER, AUDIT, PROFILE
  client_id    uuid references xp_clients(id) on delete set null,
  key_label    text,
  run_id       text,
  items        integer,
  cost_usd     numeric,
  status       text not null,
  error        text,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz
);
create index if not exists xp_apify_runs_started_idx on xp_apify_runs (started_at desc);

alter table xp_social_profiles enable row level security;
alter table xp_client_social_profiles enable row level security;
alter table xp_social_posts enable row level security;
alter table xp_social_post_snapshots enable row level security;
alter table xp_influencer_posts enable row level security;
alter table xp_content_audits enable row level security;
alter table xp_content_ideas enable row level security;
alter table xp_apify_runs enable row level security;

do $$ begin raise notice '0028: xp_social_profiles, xp_client_social_profiles, xp_social_posts, xp_social_post_snapshots, xp_influencer_posts, xp_content_audits, xp_content_ideas, xp_apify_runs — applied.'; end $$;


-- ===================================================================
-- EdgeLead's own additions (phase 31)
-- ===================================================================
-- Which EdgeLead Meta connection an XpulseAI connection row was provisioned from, so
-- re-provisioning updates rather than duplicates.
alter table public.xp_meta_connections add column if not exists el_connection_id uuid;
create unique index if not exists xp_meta_connections_el_connection_idx on public.xp_meta_connections (el_connection_id) where el_connection_id is not null;
-- A client's timezone, which the owner assistant resolves every date in.
alter table public.clients add column if not exists timezone text;

-- The Facebook reach convention. 0011-g derives its changeover date from data; every Facebook day
-- in this copy is read under the new measurement, so the note (in 0019's client words) applies
-- from the start. Skipped when a Facebook reach convention already exists.
insert into xp_data_conventions (platform, metric_family, convention, effective_from, effective_to, note)
select 'FB', 'reach', 'REACH_MEDIA_VIEWERS', date '2020-01-01', null,
       'Facebook reach counts the people who viewed the Page''s posts and other content, which is how Meta '
    || 'measures Facebook reach now that its older reach measure has been retired. Every Facebook reach figure '
    || 'here uses this one measurement, so the figures can be compared with each other. It counts a smaller '
    || 'group than the older measure, so it should not be compared with Facebook reach in older reports or '
    || 'other tools. Facebook impressions are counted the same way.'
where not exists (select 1 from xp_data_conventions where platform = 'FB' and metric_family = 'reach');
insert into xp_data_repairs (migration, target_table, action, rows_affected, detail)
select 'el-0011g', 'xp_data_conventions', 'seed FB reach convention', 1,
       jsonb_build_object('convention', 'REACH_MEDIA_VIEWERS',
                          'why', '0011-g derives the changeover date from data; every Facebook day here is read under the new measurement, so the note applies from the start')
where exists (select 1 from xp_data_conventions where platform = 'FB' and convention = 'REACH_MEDIA_VIEWERS')
  and not exists (select 1 from xp_data_repairs where migration = 'el-0011g');

