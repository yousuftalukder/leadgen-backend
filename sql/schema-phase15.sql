-- =====================================================================
-- EDGELEAD — PHASE 15 MIGRATION
--
-- Run this in the Supabase SQL editor BEFORE deploying server.js.
-- Safe to run more than once.
--
-- The owner assistant. A client asks a question in their own words and
-- gets an answer built from their own data — the reports already in the
-- vault, and, once they connect Meta, the owner-only numbers nobody can
-- scrape.
--
-- What it does:
--   1. ai_conversations — one thread, owned by a user and optionally
--      scoped to a client record.
--   2. ai_messages — the turns, including what the assistant looked at.
--
-- The assistant reads through bounded tools, never free SQL, so nothing
-- here grants it reach beyond what the tools already select.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. CONVERSATIONS
--
--    client_id is nullable on purpose. A self-serve account has no
--    clients row — the account IS the business — so a thread belongs to
--    a user first and to a client record only when an employee opened it
--    on a client's behalf.
-- ---------------------------------------------------------------------
create table if not exists public.ai_conversations (
    id          uuid primary key default uuid_generate_v4(),
    user_id     uuid not null references auth.users(id) on delete cascade,
    client_id   uuid references public.clients(id) on delete set null,
    title       text,
    created_at  timestamptz not null default timezone('utc'::text, now()),
    updated_at  timestamptz not null default timezone('utc'::text, now())
);

alter table public.ai_conversations enable row level security;

-- The list is always "my threads, newest first".
create index if not exists idx_ai_conv_user
    on public.ai_conversations (user_id, updated_at desc);
create index if not exists idx_ai_conv_client
    on public.ai_conversations (client_id, updated_at desc)
    where client_id is not null;


-- ---------------------------------------------------------------------
-- 2. MESSAGES
--
--    tools records which bounded tools answered the turn. It is kept for
--    two reasons: the page shows "I looked at your September report", and
--    when an answer is wrong it is the only way to tell a bad tool from a
--    bad reading of a good tool.
-- ---------------------------------------------------------------------
create table if not exists public.ai_messages (
    id              uuid primary key default uuid_generate_v4(),
    conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
    role            text not null,
    content         text not null default '',
    tools           jsonb,
    created_at      timestamptz not null default timezone('utc'::text, now())
);

alter table public.ai_messages enable row level security;

-- Every read of a thread is "its turns, oldest first".
create index if not exists idx_ai_msg_conv
    on public.ai_messages (conversation_id, created_at);


-- ---------------------------------------------------------------------
-- DONE
--
-- Both tables are RLS-enabled with no policies, which is deny-all for
-- anon and authenticated while the server's service role bypasses RLS —
-- the same posture as every other table here. The frontend holds the
-- anon key and uses it for auth only.
--
--     select tablename from pg_tables
--     where schemaname = 'public' and tablename like 'ai_%';
-- ---------------------------------------------------------------------
