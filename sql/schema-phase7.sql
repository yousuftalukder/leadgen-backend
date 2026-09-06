-- ===========================================================================
-- EDGELEAD — SCHEMA PHASE 7
--
-- Run once in Supabase SQL Editor, AFTER schema-phase6.sql, BEFORE deploying
-- the phase 7 server. Additive and idempotent. Safe to re-run.
--
-- Purpose: give every Instagram report a stable report_type so the two IG
-- vaults (ig-report.html / ig-competitors.html) can filter cleanly.
--
-- Old values:  ig_report worker  → 'single' or 'compare'
--              deep_audit worker → 'single' or 'competitor'
-- Both wrote 'single' when there were no rivals, so report_type alone could
-- not separate them. set_id can: deep_audit ALWAYS creates a competitor_set,
-- ig_report NEVER sets one.
--
-- New values:  'ig_report' | 'deep_audit'
-- The server keeps a legacy fallback, so nothing breaks if this runs late.
-- ===========================================================================

update public.reports
   set report_type = 'deep_audit'
 where platform = 'instagram'
   and (report_type = 'competitor'
        or (report_type = 'single' and set_id is not null));

update public.reports
   set report_type = 'ig_report'
 where platform = 'instagram'
   and (report_type = 'compare'
        or (report_type = 'single' and set_id is null));

-- ---------------------------------------------------------------------
-- VERIFY — expected: only ig_report and deep_audit remain for instagram
-- ---------------------------------------------------------------------
-- select report_type, count(*) from public.reports
--  where platform = 'instagram' group by 1 order by 1;


-- ===========================================================================
-- CAPTURE THE LEADGEN BASE SCHEMA (one-time, manual)
--
-- campaigns, campaign_leads and leads were created before the schema files
-- existed. No file in the project can recreate them. Run the query below,
-- paste its output into a new file `schema-base-leadgen.sql`, and add it to
-- the project. After that the database can be rebuilt from files alone.
-- ===========================================================================
-- select
--   'create table if not exists public.' || table_name || ' (' || chr(10) ||
--   string_agg('    ' || column_name || ' ' || data_type ||
--              case when is_nullable = 'NO' then ' not null' else '' end ||
--              case when column_default is not null then ' default ' || column_default else '' end,
--              ',' || chr(10) order by ordinal_position) ||
--   chr(10) || ');'
-- from information_schema.columns
-- where table_schema = 'public'
--   and table_name in ('campaigns', 'campaign_leads', 'leads')
-- group by table_name;
