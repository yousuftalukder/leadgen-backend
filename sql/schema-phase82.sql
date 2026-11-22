-- ---------------------------------------------------------------------
-- PHASE 82 — a profile of one's own: name, phone, photo.
--
--   app_users.phone
--       A phone number the person gave in their profile, as typed
--       (digits, spaces, + ( ) - only). Edge Meta AI's Profile sheet sets it.
--
--   app_users.avatar_path
--       Their photo: the object's path in the private "avatars" bucket,
--       which the server makes on the first upload. It is only ever handed
--       out as a signed link. Null is no photo, and the initials show.
--
-- full_name was there from the start; the profile now lets the person
-- change it.
--
-- Run in the Supabase SQL editor before deploying the phase-82 server.
-- Idempotent.
-- ---------------------------------------------------------------------

alter table public.app_users
    add column if not exists phone text check (phone is null or char_length(phone) <= 40);
alter table public.app_users
    add column if not exists avatar_path text check (avatar_path is null or char_length(avatar_path) <= 200);
