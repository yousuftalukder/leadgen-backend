-- ---------------------------------------------------------------------
-- PHASE 62 — documents on a task.
--
--   client_task_files   one row per document attached to a task: a PDF,
--                       a Word file (.doc, .docx) or a spreadsheet
--                       (.xls, .xlsx, .csv). The file itself is in the
--                       private storage bucket "task-files" (the server
--                       makes it, 20 MB a file); a document is only ever
--                       handed out as a short-lived signed link, to
--                       someone who may read the task, and downloads under
--                       the name it was uploaded with.
--
-- Pictures pasted into a description stay in client_task_media (phase 48).
--
-- Run in the Supabase SQL editor before deploying the phase-62 server.
-- Idempotent.
-- ---------------------------------------------------------------------

create table if not exists public.client_task_files (
    id            uuid primary key default gen_random_uuid(),
    client_id     uuid not null references public.clients(id) on delete cascade,
    task_id       uuid not null references public.client_tasks(id) on delete cascade,
    path          text not null,                                   -- the object's path in the task-files bucket
    filename      text not null check (char_length(filename) between 1 and 200),
    content_type  text not null,
    bytes         integer not null check (bytes > 0),
    uploaded_by   uuid,
    created_at    timestamptz not null default now()
);
create index if not exists idx_client_task_files_task   on public.client_task_files (task_id, created_at desc);
create index if not exists idx_client_task_files_client on public.client_task_files (client_id);
alter table public.client_task_files enable row level security;

comment on table public.client_task_files is
    'A document attached to a task. The bytes are in the private task-files bucket; the server hands out signed download links only to people who may read the task.';
