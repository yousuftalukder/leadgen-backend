-- =====================================================================
-- EDGELEAD — PHASE 17 MIGRATION
--
-- Run this in the Supabase SQL editor BEFORE deploying server.js.
-- Safe to run more than once.
--
-- Manual research findings on a content plan.
--
-- A plan is computed from scraped posts, and that is its strength and its
-- limit: it knows what was published and how it performed, and it knows
-- nothing about the conversation somebody had with a customer, the
-- competitor who quietly changed their pricing, or the local event next
-- month. Those arrive through a person, and until now there was nowhere
-- to put them.
--
-- What it does:
--   1. content_plan_notes — a finding, optionally pinned to one brief.
--
-- Rule 3 of this repo is that scraped and owner metrics are never
-- blended and every metric carries a source. A human observation is a
-- third source and is kept just as separate: it lives in its own table,
-- is rendered as somebody's note, and never feeds a computed index.
-- =====================================================================


create table if not exists public.content_plan_notes (
    id          uuid primary key default uuid_generate_v4(),
    report_id   uuid not null references public.reports(id) on delete cascade,
    user_id     uuid not null references auth.users(id) on delete cascade,
    client_id   uuid references public.clients(id) on delete set null,

    -- The brief this is about, by its cell key. Null means the note is
    -- about the plan as a whole. Deliberately not a foreign key: briefs
    -- live inside reports.report_json, so there is nothing to point at,
    -- and a regenerated plan can legitimately lose a cell without the
    -- note that discussed it becoming invalid history.
    cell        text,

    body        text not null,
    author_name text,

    created_at  timestamptz not null default timezone('utc'::text, now()),
    updated_at  timestamptz not null default timezone('utc'::text, now())
);

alter table public.content_plan_notes enable row level security;

-- Every read is "the notes on this plan, oldest first".
create index if not exists idx_cp_notes_report
    on public.content_plan_notes (report_id, created_at);

-- The admin view of who has been contributing.
create index if not exists idx_cp_notes_user
    on public.content_plan_notes (user_id, created_at desc);


-- ---------------------------------------------------------------------
-- DONE
--
--     select count(*) from public.content_plan_notes;
--
-- Expect 0 on a fresh install. RLS is on with no policies, which is
-- deny-all for anon and authenticated while the service role bypasses
-- it — the same posture as every other table here.
-- ---------------------------------------------------------------------
