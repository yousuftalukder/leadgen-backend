-- ---------------------------------------------------------------------
-- PHASE 29 — one master lead list for the whole agency, filed by
-- industry and location. Also the settings keys for outbound mail
-- (no schema: system_settings is key/value already).
--
-- Run in the Supabase SQL editor before deploying the phase-29 server.
-- Idempotent: every statement can be re-run.
-- ---------------------------------------------------------------------

-- 1. Where a lead is filed. The search that found it wins; the profile's
--    own category / city fill in when the search said nothing.
alter table public.leads add column if not exists industry text;
alter table public.leads add column if not exists location text;

comment on column public.leads.industry is
    'Filed under: the search term that found this lead, else the profile''s own category.';
comment on column public.leads.location is
    'Filed under: the search location that found this lead, else the profile''s own city.';

-- 2. Backfill. Instagram leads know their campaign (keywords[1] and location);
--    everything else falls back to what the profile itself says.
update public.leads l
   set industry = coalesce(l.industry, nullif(trim(c.keywords[1]), ''), nullif(trim(l.category), '')),
       location = coalesce(l.location, nullif(trim(c.location), ''),   nullif(trim(l.city), ''))
  from public.campaign_leads cl
  join public.campaigns c on c.id = cl.campaign_id
 where cl.lead_id = l.id
   and (l.industry is null or l.location is null);

update public.leads
   set industry = coalesce(industry, nullif(trim(category), '')),
       location = coalesce(location, nullif(trim(city), ''))
 where industry is null or location is null;

create index if not exists idx_leads_industry on public.leads (lower(industry));
create index if not exists idx_leads_location on public.leads (lower(location));

-- 3. The master list: every lead anyone at the agency has collected, one row
--    per business. Two employees finding the same Page produce two rows in
--    `leads` (the unique key is per owner); the agency asks about the
--    business. The richer row wins — enriched over not, then newest — and
--    `copies` says how many people found it.
--
--    security_invoker: the view must be exactly as reachable as the table
--    under it. Without it a view runs as its owner and the anon key could
--    read every lead through PostgREST, which is the one thing RLS on
--    `leads` exists to prevent. The server reads it with the service role.
create or replace view public.leads_master
  with (security_invoker = true) as
select distinct on (l.platform, lower(l.username))
       l.*,
       count(*) over (partition by l.platform, lower(l.username)) as copies
  from public.leads l
 order by l.platform, lower(l.username), l.is_enriched desc nulls last, l.created_at desc;

revoke all on public.leads_master from anon, authenticated;
grant  select on public.leads_master to service_role;

comment on view public.leads_master is
    'The agency master list: one row per business across every owner. Read by /api/leads for admins and employees.';
