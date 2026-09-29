-- ---------------------------------------------------------------------
-- PHASE 32 — the client workspace: a task board per client.
--
-- Reports said what to do; nothing said who was doing it. Every client now
-- has a board (To do, In progress, Waiting on the client, Done). Anyone who
-- can open the client can read it; editors change it. A task can be the
-- client's own to-do (assigned_to_client) and any task can be shown to the
-- client (visible_to_client) — those are the only rows the owner's portal
-- ever selects. Comments sit beside the task, filed under the same client.
--
-- Run in the Supabase SQL editor before deploying the phase-32 server.
-- Idempotent.
-- ---------------------------------------------------------------------

create table if not exists public.client_tasks (
    id                 uuid primary key default gen_random_uuid(),
    client_id          uuid not null references public.clients(id) on delete cascade,
    title              text not null check (char_length(title) between 1 and 300),
    notes              text check (notes is null or char_length(notes) <= 4000),
    status             text not null default 'todo' check (status in ('todo', 'doing', 'waiting', 'done')),
    assignee_user_id   uuid,                                -- a person on the team; null when unassigned or the client's own
    assigned_to_client boolean not null default false,      -- the owner's to-do (always visible to them)
    visible_to_client  boolean not null default false,      -- shown in the owner's portal
    due_date           date,
    labels             text[] not null default '{}',
    checklist          jsonb not null default '[]'::jsonb,  -- [{ "text": …, "done": … }]
    source_type        text check (source_type is null or source_type in ('report', 'recommendation', 'job', 'schedule')),
    source_id          uuid,                                -- the report or job it came from
    source_label       text,                                -- "Monthly report · Aug 2026"
    source_key         text,                                -- which recommendation in that report, so it is added once
    position           double precision not null default 0,
    created_by         uuid,
    completed_at       timestamptz,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now()
);
create index if not exists idx_client_tasks_board    on public.client_tasks (client_id, status, position);
create index if not exists idx_client_tasks_assignee on public.client_tasks (assignee_user_id) where status <> 'done';
create unique index if not exists idx_client_tasks_source
    on public.client_tasks (client_id, source_id, source_key) where source_key is not null;
alter table public.client_tasks enable row level security;

comment on table public.client_tasks is
    'One card on a client''s task board. Read by anyone who can open the client; changed by editors; rows with visible_to_client are the only ones /api/client/tasks selects.';

create table if not exists public.client_task_comments (
    id              uuid primary key default gen_random_uuid(),
    task_id         uuid not null references public.client_tasks(id) on delete cascade,
    client_id       uuid not null references public.clients(id) on delete cascade,
    author_user_id  uuid not null,
    body            text not null check (char_length(body) between 1 and 2000),
    created_at      timestamptz not null default now()
);
create index if not exists idx_client_task_comments_task on public.client_task_comments (task_id, created_at);
alter table public.client_task_comments enable row level security;

comment on table public.client_task_comments is
    'The conversation on a task, filed under the task''s client so a merge carries it along.';
