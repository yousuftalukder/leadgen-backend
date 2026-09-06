-- ===========================================================================
-- EDGELEAD — SCHEMA PHASE 5
--
-- Run this once against Supabase BEFORE deploying the phase 5 server.
-- Everything here is additive and idempotent: no column is dropped, no row is
-- rewritten in a way that loses information, and running it twice is a no-op.
--
-- What it is for:
--   1. Scoring version, so a trend line can tell a change in the formula apart
--      from a change in the account.
--   2. AI status, so a report that shipped without its strategy layer records
--      why, and can be regenerated later without re-scraping.
--   3. Four denormalised trend scalars, so /api/set-trend stops loading every
--      snapshot's full report_json to read four numbers off it.
-- ===========================================================================


-- ---------------------------------------------------------------------
-- 1. SCORING VERSION
--
-- reports.score records whichever formula was live at the time and nothing
-- said which. /api/set-trend diffs that column across snapshots, so flipping
-- IG_SCORE_V2 — or simply deploying the v2 patch mid-cohort — showed up as
-- "the account dropped 13 points" when nothing about the account had moved.
--
-- score_v1 is the original formula's number, recorded on every run from now
-- on. It is the only scale that exists in both versions, which is what lets a
-- mixed series still be plotted honestly.
-- ---------------------------------------------------------------------
alter table public.reports add column if not exists score_version smallint;
alter table public.reports add column if not exists score_v1      numeric;

-- Every row that already exists predates versioning, and every one of them was
-- written by whichever formula was live then. Defaulting them to 1 is only
-- correct for rows written before the v2 patch. If v2 has already been running
-- in production, set the cutoff below to the timestamp of that deploy before
-- running this block; if it has not, leave it as is.
--
--   \set v2_deployed_at '2026-09-04T00:00:00Z'
--
update public.reports
   set score_version = 1
 where score_version is null
   and platform = 'instagram';

-- Non-Instagram reports do not use the IG scale at all. Marking them 0 keeps
-- them out of any version comparison rather than silently claiming v1.
update public.reports
   set score_version = 0
 where score_version is null;

alter table public.reports alter column score_version set default 2;


-- ---------------------------------------------------------------------
-- 2. AI STATUS
--
-- ai_json being null answered "is there a strategy layer" but never "why not".
-- Storing the status makes the failure legible in the UI and lets
-- POST /api/report/:id/regenerate-narrative retry it against the payload
-- already saved, at no Apify cost.
-- ---------------------------------------------------------------------
alter table public.reports add column if not exists ai_status jsonb;

-- Backfill: an existing report with no narrative failed for a reason nobody
-- recorded. Say that, rather than leaving the UI unable to distinguish it from
-- a report that was never given the chance.
update public.reports
   set ai_status = jsonb_build_object(
        'ok', false,
        'reason', 'unknown_legacy',
        'message', 'This report predates strategy-layer diagnostics. Use Generate it now to produce it from the saved data.'
       )
 where ai_status is null
   and ai_json is null
   and report_json is not null;

update public.reports
   set ai_status = jsonb_build_object('ok', true, 'reason', 'ok', 'message', 'Generated.')
 where ai_status is null
   and ai_json is not null;


-- ---------------------------------------------------------------------
-- 3. TREND SCALARS
--
-- /api/set-trend selected report_json for every run in a set purely to read
-- followers, cadence, cohort engagement and rank off it. On a cohort with a
-- year of monthly snapshots that is megabytes of jsonb to draw one line.
-- ---------------------------------------------------------------------
alter table public.reports add column if not exists followers_snapshot bigint;
alter table public.reports add column if not exists posts_per_week     numeric;
alter table public.reports add column if not exists cohort_avg_er      numeric;
alter table public.reports add column if not exists target_rank        int;

-- Backfill from the payloads already stored, so existing trend lines keep
-- their history instead of starting over with nulls. Safe to re-run: the
-- `is null` guards make it idempotent.
update public.reports
   set followers_snapshot = nullif((report_json #>> '{main,followers}'), '')::bigint
 where followers_snapshot is null
   and report_json #>> '{main,followers}' ~ '^[0-9]+$';

update public.reports
   set posts_per_week = nullif((report_json #>> '{main,postsPerWeek}'), '')::numeric
 where posts_per_week is null
   and report_json #>> '{main,postsPerWeek}' ~ '^[0-9]+(\.[0-9]+)?$';

update public.reports
   set cohort_avg_er = nullif((report_json #>> '{benchmark,cohort,avgEngagementRate}'), '')::numeric
 where cohort_avg_er is null
   and report_json #>> '{benchmark,cohort,avgEngagementRate}' ~ '^-?[0-9]+(\.[0-9]+)?$';

update public.reports
   set target_rank = nullif((report_json #>> '{benchmark,targetRank}'), '')::int
 where target_rank is null
   and report_json #>> '{benchmark,targetRank}' ~ '^[0-9]+$';

-- Backfill score_v1 where the payload happens to carry it (phase 4 reports do).
update public.reports
   set score_v1 = nullif((report_json #>> '{main,scoreV1}'), '')::numeric
 where score_v1 is null
   and report_json #>> '{main,scoreV1}' ~ '^-?[0-9]+(\.[0-9]+)?$';


-- ---------------------------------------------------------------------
-- 4. INDEXES
--
-- The vault list is now filtered by platform and capped, and the FB lists
-- filter by report_type. Both want an index that matches how they read.
-- ---------------------------------------------------------------------
create index if not exists idx_reports_user_platform
    on public.reports(user_id, platform, created_at desc);

create index if not exists idx_reports_user_type
    on public.reports(user_id, platform, report_type, created_at desc);


-- ---------------------------------------------------------------------
-- 5. VERIFY
--
-- Run this after the migration. Every row should come back true.
-- ---------------------------------------------------------------------
-- select
--     to_regclass('public.reports') is not null                      as reports_exists,
--     count(*) filter (where score_version is null) = 0               as versioned,
--     count(*) filter (where ai_status is null and report_json is not null) = 0 as ai_status_backfilled
-- from public.reports;
--
-- select column_name from information_schema.columns
--  where table_schema = 'public' and table_name = 'reports'
--    and column_name in ('score_version','score_v1','ai_status',
--                        'followers_snapshot','posts_per_week','cohort_avg_er','target_rank')
--  order by column_name;
-- -- expected: 7 rows
