-- =====================================================================
-- EDGELEAD :: PHASE 10 — client-scoped post history
-- Run AFTER schema-phase9.sql, BEFORE deploying the phase 10 server.
--
-- Why: every artefact table got client_id in phase 9 except the three
-- post tables. The Content Plan (and any future derived engine) reads
-- posts by user_id, so a teammate's Competitor Intel run on a shared
-- client was invisible to your Content Plan. This adds client_id to
-- posts / fb_posts / fb_page_posts, indexes it, and backfills from the
-- reports that produced the rows.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. COLUMNS
-- ---------------------------------------------------------------------
alter table public.posts         add column if not exists client_id uuid references public.clients(id) on delete set null;
alter table public.fb_posts      add column if not exists client_id uuid references public.clients(id) on delete set null;
alter table public.fb_page_posts add column if not exists client_id uuid references public.clients(id) on delete set null;

-- ---------------------------------------------------------------------
-- 2. INDEXES  (the shapes the content plan reads)
-- ---------------------------------------------------------------------
create index if not exists idx_posts_client_handle
    on public.posts(client_id, platform, handle, posted_at desc);
create index if not exists idx_fb_page_posts_client_page
    on public.fb_page_posts(client_id, page_id, posted_at desc);
create index if not exists idx_fb_posts_client_group
    on public.fb_posts(client_id, group_id, posted_at desc);

-- ---------------------------------------------------------------------
-- 3. BACKFILL
--
-- posts.report_id is null for Instagram audits (the worker never set it),
-- so IG rows are matched through the report that named the handle as
-- target or competitor, same user, most recent client-filed report wins.
-- FB rows do carry report_id (set after save) so they join directly,
-- with a second pass through fb_page_ids / fb_group_ids for older rows.
-- Nothing already stamped is touched. Re-runnable.
-- ---------------------------------------------------------------------
with src as (
    select distinct on (p.id) p.id as post_id, r.client_id
    from public.posts p
    join public.reports r
      on r.user_id = p.user_id
     and r.platform = 'instagram'
     and r.client_id is not null
     and (lower(r.target_handle) = lower(p.handle)
          or lower(p.handle) = any (select lower(unnest(coalesce(r.competitor_handles, '{}'::text[])))))
    where p.client_id is null
    order by p.id, r.created_at desc
)
update public.posts p set client_id = src.client_id
from src where p.id = src.post_id;

update public.fb_page_posts p set client_id = r.client_id
from public.reports r
where p.client_id is null and p.report_id = r.id and r.client_id is not null;

with src as (
    select distinct on (p.id) p.id as post_id, r.client_id
    from public.fb_page_posts p
    join public.reports r
      on r.user_id = p.user_id
     and r.report_type = 'fb_page'
     and r.client_id is not null
     and p.page_id = any (coalesce(r.fb_page_ids, '{}'::text[]))
    where p.client_id is null
    order by p.id, r.created_at desc
)
update public.fb_page_posts p set client_id = src.client_id
from src where p.id = src.post_id;

update public.fb_posts p set client_id = r.client_id
from public.reports r
where p.client_id is null and p.report_id = r.id and r.client_id is not null;

with src as (
    select distinct on (p.id) p.id as post_id, r.client_id
    from public.fb_posts p
    join public.reports r
      on r.user_id = p.user_id
     and r.platform = 'facebook'
     and r.client_id is not null
     and p.group_id = any (coalesce(r.fb_group_ids, '{}'::text[]))
    where p.client_id is null
    order by p.id, r.created_at desc
)
update public.fb_posts p set client_id = src.client_id
from src where p.id = src.post_id;

-- ---------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------
-- select count(*) filter (where client_id is not null) as stamped, count(*) as total from public.posts;
-- select count(*) filter (where client_id is not null) as stamped, count(*) as total from public.fb_page_posts;
-- select count(*) filter (where client_id is not null) as stamped, count(*) as total from public.fb_posts;
