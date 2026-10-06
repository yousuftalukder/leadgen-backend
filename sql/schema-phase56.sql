-- ---------------------------------------------------------------------
-- PHASE 56 — the Clients hub: trials, and knowing who signed in.
--
--   clients.trial_started_at / trial_ends_at
--       A business trying Edge Meta AI before it signs. While trial_ends_at
--       is in the future the owner uses the app as any client's owner does;
--       after it, the app says the trial ended, until the team extends it or
--       converts the business (which clears trial_ends_at).
--   clients.converted_at
--       When a trial became a client.
--   app_users.last_seen_at
--       When an owner login was last used, at most hourly. The hub tells an
--       invite never opened from an owner who uses the app. Filled once from
--       Supabase's own last sign-in for the logins that already exist.
--
-- Run in the Supabase SQL editor before deploying the phase-56 server.
-- Idempotent.
-- ---------------------------------------------------------------------

alter table public.clients add column if not exists trial_started_at timestamptz;
alter table public.clients add column if not exists trial_ends_at    timestamptz;
alter table public.clients add column if not exists converted_at     timestamptz;
create index if not exists idx_clients_trial on public.clients (trial_ends_at) where trial_ends_at is not null;

alter table public.app_users add column if not exists last_seen_at timestamptz;
update public.app_users a set last_seen_at = u.last_sign_in_at
  from auth.users u
 where u.id = a.id and a.last_seen_at is null and u.last_sign_in_at is not null;
