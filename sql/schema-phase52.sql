-- ---------------------------------------------------------------------
-- PHASE 52 — the owner app, finished.
--
-- 1. app_users.agency_owner: an owner login the agency made for one of its
--    businesses. It never runs out: the agency is the customer, and the
--    owner reaches Edge Meta AI for as long as the agency keeps their
--    business. el_account_state treats it as paid, the same as the server.
--    A self-serve signup (no agency) keeps its trial, as before.
--    Such a login also never gets a business made up for it: when the agency
--    archives or removes the business, the app says access has ended.
--
-- 2. xp_ai_conversations.user_id: whose chat it is. The owner and the
--    agency's team each keep their own chats about the business. Chats from
--    before this have no author; the team keeps them, owners never see them.
--
-- Run in the Supabase SQL editor before deploying the phase-52 server.
-- Idempotent.
-- ---------------------------------------------------------------------

-- 1. Owner logins that never expire -----------------------------------------
alter table public.app_users add column if not exists agency_owner boolean not null default false;

-- Every owner login an agency already put on a business.
update public.app_users u set agency_owner = true
 where u.role = 'client' and u.agency_owner = false
   and exists (select 1 from public.client_members m where m.user_id = u.id and m.role = 'editor');

-- The account state, now aware of it. Order matters: suspension beats
-- everything, role beats dates, an agency's owner login beats dates.
create or replace function public.el_account_state(p_user uuid)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
    select case
        when u.is_active is not true                           then 'suspended'
        when u.role = 'admin'                                  then 'admin'
        when u.role <> 'client'                                then 'employee'
        when u.agency_owner is true                            then 'paid'
        when u.paid_until    is not null and u.paid_until    > now() then 'paid'
        when u.trial_ends_at is not null and u.trial_ends_at > now() then 'trial'
        else 'expired'
    end
    from public.app_users u
    where u.id = p_user;
$$;
-- Phase 51 closed functions to the public roles; a replaced function keeps
-- its grants, but say it again so this file stands on its own.
revoke execute on function public.el_account_state(uuid) from public, anon, authenticated;
grant execute on function public.el_account_state(uuid) to service_role;

-- 2. Each person's own chats -------------------------------------------------
alter table public.xp_ai_conversations add column if not exists user_id uuid;
create index if not exists xp_ai_conversations_user_idx
    on public.xp_ai_conversations (client_id, user_id, updated_at desc) where deleted_at is null;
