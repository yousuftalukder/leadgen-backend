-- ---------------------------------------------------------------------
-- PHASE 42 — the content plan as a calendar the owner approves.
--
-- A plan's briefs become posts on dates. The owner approves, asks for
-- changes or skips each one from their portal; an approved post becomes a
-- task for the team; a posted one carries its link, so the monthly report
-- can say how the planned posts actually did.
--
-- Run in the Supabase SQL editor before deploying the phase-42 server.
-- Idempotent.
-- ---------------------------------------------------------------------

create table if not exists public.content_posts (
    id            uuid primary key default gen_random_uuid(),
    report_id     uuid not null references public.reports(id) on delete cascade,     -- the content plan
    client_id     uuid references public.clients(id) on delete cascade,
    brief_key     text not null,                          -- 'reels:0' — which brief in the plan, so scheduling twice adds nothing
    format        text,
    hook          text check (hook is null or char_length(hook) <= 300),
    caption       text check (caption is null or char_length(caption) <= 4000),
    brief         jsonb not null default '{}'::jsonb,     -- script, shot, why, evidence, predicted band, boost
    planned_on    date not null,
    planned_time  text check (planned_time is null or char_length(planned_time) <= 20),
    status        text not null default 'idea' check (status in ('idea', 'approved', 'changes', 'skipped', 'made', 'posted')),
    owner_note    text check (owner_note is null or char_length(owner_note) <= 2000),
    decided_by    text check (decided_by is null or decided_by in ('owner', 'team')),
    decided_at    timestamptz,
    task_id       uuid,
    posted_url    text check (posted_url is null or char_length(posted_url) <= 500),
    shortcode     text,
    posted_at     timestamptz,
    created_by    uuid,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);
create unique index if not exists idx_content_posts_brief on public.content_posts (report_id, brief_key);
create index if not exists idx_content_posts_client on public.content_posts (client_id, planned_on);
alter table public.content_posts enable row level security;
comment on table public.content_posts is
    'One planned post from a content plan: its date, the owner''s decision, the task it became and the link once posted. Read and written only by the server; the owner portal sees its own business''s rows through /api/client/content.';
