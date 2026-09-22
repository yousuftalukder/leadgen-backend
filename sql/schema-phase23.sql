-- ===========================================================================
-- PHASE 23 — leads belong to clients too
--
-- A lead is found while working for a client, and until now that fact was
-- kept only for Instagram, only indirectly (leads -> campaign_leads ->
-- campaigns.client_id), and not at all for Facebook. So "for this client,
-- these are the leads" could not be answered.
--
-- client_leads is the explicit link. Many-to-many on purpose: one business
-- can be a lead for two different clients, and the master list stays the
-- union of everything. Rows are unique per (owner, platform, username), so
-- two employees finding the same business for one client produce two lead
-- rows and two links; the per-client view de-duplicates on read.
--
-- Deploy order: this file, then server.js, then the pages. Idempotent.
-- ===========================================================================

create table if not exists public.client_leads (
    client_id  uuid not null references public.clients(id) on delete cascade,
    lead_id    uuid not null references public.leads(id)   on delete cascade,
    -- How the link came to exist. One of: ig_campaign, fb_discovery,
    -- backfill, merge. Kept so a client's list can say where a lead came from.
    source     text,
    job_id     uuid,
    created_at timestamptz not null default timezone('utc'::text, now()),
    primary key (client_id, lead_id)
);
alter table public.client_leads enable row level security;
create index if not exists idx_client_leads_lead on public.client_leads (lead_id);

comment on table public.client_leads is
    'Which clients a lead was found for. Many-to-many; the master leads list is the union.';

-- ---------------------------------------------------------------------------
-- Backfill: every Instagram lead already linked to a campaign that was filed
-- under a client. Facebook leads before this phase carried no client and
-- cannot be recovered — there is nothing on the row that says who it was for.
-- ---------------------------------------------------------------------------
insert into public.client_leads (client_id, lead_id, source)
select c.client_id, cl.lead_id, 'backfill'
from public.campaign_leads cl
join public.campaigns c on c.id = cl.campaign_id
where c.client_id is not null
on conflict (client_id, lead_id) do nothing;
