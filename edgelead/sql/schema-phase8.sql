-- =====================================================================
-- schema-phase8.sql — run BEFORE deploying the phase 8 server.js
-- =====================================================================

-- 1. Demand signals mined from comments, not just posts.
alter table public.fb_demand_signals
    add column if not exists source_type text default 'post';   -- 'post' | 'comment'

-- 2. A zero-post room must say why.
alter table public.fb_groups
    add column if not exists last_scrape_posts int,
    add column if not exists last_scrape_note  text;

-- Verify
select column_name from information_schema.columns
 where table_name = 'fb_demand_signals' and column_name = 'source_type'
union all
select column_name from information_schema.columns
 where table_name = 'fb_groups' and column_name in ('last_scrape_posts', 'last_scrape_note');
-- expected: 3 rows
