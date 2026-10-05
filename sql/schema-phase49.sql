-- ---------------------------------------------------------------------
-- PHASE 49 — business owners sign in to Edge Meta AI with an emailed code.
--
-- No password to remember: the owner types their email, EdgeLead emails a
-- 6-digit code, they type it, and the app stays signed in from then on.
-- Invite-only: a code is only ever sent to an owner login the agency made.
--
--   owner_login_codes   one row per code sent. Only a hash of the code is
--                       kept; a code works once, for 10 minutes, and five
--                       wrong tries end it.
--
-- Run in the Supabase SQL editor before deploying the phase-49 server.
-- Idempotent.
-- ---------------------------------------------------------------------

create table if not exists public.owner_login_codes (
    id          uuid primary key default gen_random_uuid(),
    email       text not null,
    user_id     uuid not null,
    code_hash   text not null,
    attempts    integer not null default 0,
    expires_at  timestamptz not null,
    used_at     timestamptz,
    created_at  timestamptz not null default now()
);
create index if not exists idx_owner_login_codes_email on public.owner_login_codes (email, created_at desc);
alter table public.owner_login_codes enable row level security;

comment on table public.owner_login_codes is
    'Sign-in codes for business owners (Edge Meta AI). The code itself is never stored, only its hash; one use, ten minutes, five tries.';
