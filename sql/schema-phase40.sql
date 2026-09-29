-- ---------------------------------------------------------------------
-- PHASE 40 — who a lead is, and what happens to it next.
--
-- 1. Every lead is sorted: influencer, business, personal (an ordinary
--    account) or unsure, with the reasons, from its posts at discovery and
--    its profile at enrichment. A person's correction (kind_label) wins over
--    the rules and is kept, so the rules can be measured against it.
-- 2. Every lead gets a fit score for its kind, and remembers which search
--    methods found it.
-- 3. A pipeline: one row per lead per client brand (or per agency, for a
--    business the agency itself is pitching), with a stage, an owner, a
--    follow-up date and notes. One row per business across the whole team,
--    so two people cannot chase the same shop without knowing.
--
-- Run in the Supabase SQL editor before deploying the phase-40 server.
-- Idempotent.
-- ---------------------------------------------------------------------

alter table public.leads add column if not exists lead_kind     text;
alter table public.leads add column if not exists kind_score    int;
alter table public.leads add column if not exists kind_stage    text;         -- 'discovery' (posts only) | 'profile' (profile read too)
alter table public.leads add column if not exists kind_reasons  jsonb;        -- [{ "w": 25, "text": "Tagged 3 different businesses" }]
alter table public.leads add column if not exists kind_label    text;         -- a person's correction; wins over lead_kind
alter table public.leads add column if not exists labeled_by    uuid;
alter table public.leads add column if not exists labeled_at    timestamptz;
alter table public.leads add column if not exists signals       jsonb;        -- what its posts said: counts, places, tags, businesses it tagged
alter table public.leads add column if not exists methods       text[] not null default '{}';
alter table public.leads add column if not exists fit_score     int;
alter table public.leads add column if not exists fit_reasons   jsonb;
alter table public.leads add column if not exists classified_at timestamptz;

do $$ begin
    alter table public.leads add constraint leads_kind_check
        check (lead_kind is null or lead_kind in ('influencer', 'business', 'personal', 'unsure'));
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.leads add constraint leads_kind_label_check
        check (kind_label is null or kind_label in ('influencer', 'business', 'personal'));
exception when duplicate_object then null; end $$;

-- The kind a list shows: a person's label first, then the rules, and
-- 'unsure' for leads collected before phase 40 until they are sorted.
-- Generated, so the server never writes it and it can never disagree.
alter table public.leads add column if not exists kind_now text
    generated always as (coalesce(kind_label, lead_kind, 'unsure')) stored;
create index if not exists idx_leads_kind on public.leads (kind_now);
create index if not exists idx_leads_fit  on public.leads (fit_score desc nulls last);

-- The master list is `l.*` frozen at creation, so it has to be rebuilt to
-- carry the new columns. Same definition as phase 29.
drop view if exists public.leads_master;
create view public.leads_master
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

create table if not exists public.lead_pipeline (
    id            uuid primary key default gen_random_uuid(),
    platform      text not null default 'instagram',
    username      text not null,                                   -- the lead's handle or Page slug, as stored on the lead
    client_id     uuid references public.clients(id) on delete cascade,   -- the brand it is for; null = the agency's own prospect
    kind          text not null check (kind in ('influencer', 'business')),
    stage         text not null,
    assigned_to   uuid,
    follow_up_on  date,
    rate          text check (rate is null or char_length(rate) <= 120),        -- an influencer's quoted rate, as they said it
    lost_reason   text check (lost_reason is null or char_length(lost_reason) <= 300),
    created_by    uuid,
    updated_by    uuid,
    stage_at      timestamptz not null default now(),
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);
create unique index if not exists idx_lead_pipeline_one
    on public.lead_pipeline (platform, username, coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists idx_lead_pipeline_client   on public.lead_pipeline (client_id, stage);
create index if not exists idx_lead_pipeline_assigned on public.lead_pipeline (assigned_to, follow_up_on);
alter table public.lead_pipeline enable row level security;
comment on table public.lead_pipeline is
    'One lead being worked for one client brand (or for the agency). Stage, owner, follow-up. Read and written only by the server.';

create table if not exists public.lead_notes (
    id           uuid primary key default gen_random_uuid(),
    pipeline_id  uuid not null references public.lead_pipeline(id) on delete cascade,
    author_id    uuid,
    body         text not null check (char_length(body) between 1 and 2000),
    auto         boolean not null default false,                  -- written by the server: a stage change, a follow-up moved
    created_at   timestamptz not null default now()
);
create index if not exists idx_lead_notes_pipeline on public.lead_notes (pipeline_id, created_at);
alter table public.lead_notes enable row level security;
comment on table public.lead_notes is 'The history of one pipeline row: notes people wrote and the moves the server recorded.';
