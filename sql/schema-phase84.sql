-- ---------------------------------------------------------------------
-- PHASE 84 — Edge Meta AI's settings, as in the Owner Assistant.
--
--   app_users.ui_language
--       The language the person chose for Edge Meta AI: 'en' or 'bn'.
--       Kept on the account, so it follows them to every device. Null is
--       "not chosen yet": the page keeps what the device last used.
--
--   clients.owner_details
--       What the owner tells the agency about the business, from their
--       Profile: { phone, website, address, hours, notes }. The agency reads
--       it on the client's Settings tab. The agency's own fields (name, what
--       they do, where, notes) stay the agency's.
--
-- Run in the Supabase SQL editor before deploying the phase-84 server.
-- Idempotent.
-- ---------------------------------------------------------------------

alter table public.app_users
    add column if not exists ui_language text;
alter table public.app_users drop constraint if exists app_users_ui_language_check;
alter table public.app_users add constraint app_users_ui_language_check
    check (ui_language is null or ui_language in ('en', 'bn'));

alter table public.clients
    add column if not exists owner_details jsonb;
alter table public.clients drop constraint if exists clients_owner_details_check;
alter table public.clients add constraint clients_owner_details_check
    check (owner_details is null or (jsonb_typeof(owner_details) = 'object' and pg_column_size(owner_details) <= 4000));
