-- ===========================================================================
-- PHASE 26 — the money moment
--
-- The business model is try free, then buy, with an admin activating the
-- account by hand. Until now the moment a trial ended looked like this:
-- "Your access has ended. Contact us to continue." — with no way to contact
-- anyone, no way for the client to say they want to, and no way for the
-- admin to see who does. The path dead-ended exactly where it should convert.
--
-- An activation request lives on the account, because it is a fact about
-- the account: a timestamp, an optional note, and nothing else. It is cleared
-- when an admin activates. Idempotent.
-- ===========================================================================

alter table public.app_users add column if not exists activation_requested_at timestamptz;
alter table public.app_users add column if not exists activation_note text;

comment on column public.app_users.activation_requested_at is
    'When this client asked to continue after (or before) their trial ended. Cleared on activation.';
