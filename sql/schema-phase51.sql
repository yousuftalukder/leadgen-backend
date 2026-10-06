-- ---------------------------------------------------------------------
-- PHASE 51 — the audit's security batch.
--
-- 1. reports.visible_to_client: a report reaches the business owner only once
--    the agency shares it. Reports start private to the team (competitor
--    research, prospect lists, drafts). A report an owner runs themselves is
--    shared from the start (trigger below). Existing reports stay private
--    until someone shares them.
--
-- 2. The database itself is closed to the public key. The site uses Supabase
--    only to sign in; every read and write goes through the server, which uses
--    the service role and is unaffected by any of this. But the anon key is in
--    every page, and some tables had no row security and some views ran as
--    their owner, so anyone holding that key could read (and for tables without
--    row security, change) data directly. This turns row security on for every
--    table in public, makes every view run as its caller, and takes the anon and
--    authenticated roles' rights away from every table, view and function there.
--
-- Run in the Supabase SQL editor before deploying the phase-51 server.
-- Idempotent.
-- ---------------------------------------------------------------------

-- 1. Reports the owner may see --------------------------------------------
alter table public.reports add column if not exists visible_to_client boolean not null default false;
create index if not exists idx_reports_client_visible on public.reports (client_id, visible_to_client, created_at desc);

create or replace function public.el_report_owner_visible() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- A report an owner ran themselves (a check-up from the app) is theirs from the start.
  if exists (select 1 from public.app_users u where u.id = new.user_id and u.role = 'client') then
    new.visible_to_client := true;
  end if;
  return new;
end $$;
drop trigger if exists trg_report_owner_visible on public.reports;
create trigger trg_report_owner_visible before insert on public.reports
  for each row execute function public.el_report_owner_visible();

-- Reports owners already ran stay theirs.
update public.reports r set visible_to_client = true
  where exists (select 1 from public.app_users u where u.id = r.user_id and u.role = 'client');

-- 2. Close the database to the public key -------------------------------------
do $$
declare r record;
begin
  -- Row security on every table in public. With no policies, the anon and
  -- authenticated roles see nothing; the service role bypasses it.
  for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity loop
    execute format('alter table public.%I enable row level security', r.relname);
  end loop;
  -- Views run as the caller, so row security applies through them too.
  for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'v' loop
    execute format('alter view public.%I set (security_invoker = true)', r.relname);
  end loop;
  -- No direct rights for the public roles on anything in public.
  for r in select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'S') loop
    execute format('revoke all on public.%I from anon, authenticated', r.relname);
  end loop;
  for r in select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prokind in ('f', 'p') loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $$;

-- Tables, views and functions made later start closed too.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- Check afterwards (Supabase → Advisors → Security): no "RLS disabled in public",
-- no "Security definer view".
