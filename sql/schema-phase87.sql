-- Phase 87: the CRM. Run in the Supabase SQL editor BEFORE the server that needs it deploys.
-- Safe to run twice: every create is "if not exists" and the copy of old pipeline rows skips rows already copied.
--
--   crm_leads              EdgeLead's own cold leads, until they become clients
--   crm_activities         one timeline per lead (notes, emails, calls, WhatsApp, meetings, stage moves)
--   crm_tasks              follow-ups
--   crm_influencers        the creator network, anywhere in the world, with a map position
--   crm_influencer_posts   posts a creator made for one of our clients
--   clients + lat, lng, city, country   so clients show on the network map
--   system_settings.tools_enabled       the social media tools switch; every tool starts OFF
--
-- The server reads and writes these with the service role. Row level security is on with no policies,
-- so the anon key used in browsers can read none of it.

create table if not exists public.crm_leads (
    id                 uuid primary key default gen_random_uuid(),
    full_name          text not null check (char_length(full_name) between 1 and 160),
    title              text,
    company            text,
    website            text,
    email              text,
    email_norm         text,
    phone              text,
    phone_norm         text,
    whatsapp           text,
    city               text,
    country            text check (country is null or country ~ '^[A-Z]{2}$'),
    timezone           text,
    source             text not null default 'other'
                       check (source in ('website','seo','ads_google','ads_meta','social','email','influencer','referral','other')),
    source_detail      text,
    stage              text not null default 'new'
                       check (stage in ('new','contacted','replied','meeting','proposal','won','lost')),
    lost_reason        text,
    value              numeric(14,2),
    currency           text not null default 'BDT',
    score              integer check (score is null or score between 0 and 100),
    tags               text[] not null default '{}',
    next_step          text,
    next_step_at       timestamptz,
    last_activity_at   timestamptz,
    unsubscribed       boolean not null default false,
    owner_id           uuid references auth.users(id) on delete set null,
    client_id          uuid references public.clients(id) on delete set null,
    created_by         uuid,
    legacy_pipeline_id uuid,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now(),
    stage_at           timestamptz not null default now()
);
create unique index if not exists crm_leads_email_uq   on public.crm_leads (email_norm) where email_norm is not null;
create unique index if not exists crm_leads_phone_uq   on public.crm_leads (phone_norm) where phone_norm is not null;
create unique index if not exists crm_leads_legacy_uq  on public.crm_leads (legacy_pipeline_id) where legacy_pipeline_id is not null;
create index if not exists crm_leads_stage_idx  on public.crm_leads (stage);
create index if not exists crm_leads_owner_idx  on public.crm_leads (owner_id);
create index if not exists crm_leads_source_idx on public.crm_leads (source);
create index if not exists crm_leads_next_idx   on public.crm_leads (next_step_at) where next_step_at is not null;

create table if not exists public.crm_activities (
    id        uuid primary key default gen_random_uuid(),
    lead_id   uuid not null references public.crm_leads(id) on delete cascade,
    type      text not null check (type in ('note','email_out','email_in','call','whatsapp','meeting','stage','task','system')),
    body      text check (body is null or char_length(body) <= 20000),
    meta      jsonb not null default '{}'::jsonb,   -- stage moves {from,to}; calls {minutes,outcome}; later: email ids, Twilio call sid and recording
    actor_id  uuid,
    at        timestamptz not null default now()
);
create index if not exists crm_activities_lead_idx on public.crm_activities (lead_id, at desc);
create index if not exists crm_activities_at_idx   on public.crm_activities (at desc, type);

create table if not exists public.crm_tasks (
    id          uuid primary key default gen_random_uuid(),
    lead_id     uuid references public.crm_leads(id) on delete cascade,
    title       text not null check (char_length(title) between 1 and 240),
    due_at      timestamptz,
    done_at     timestamptz,
    owner_id    uuid,
    created_by  uuid,
    created_at  timestamptz not null default now()
);
create index if not exists crm_tasks_open_idx on public.crm_tasks (owner_id, due_at) where done_at is null;

create table if not exists public.crm_influencers (
    id          uuid primary key default gen_random_uuid(),
    platform    text not null default 'instagram',
    handle      text not null check (char_length(handle) between 1 and 80),
    name        text,
    niche       text,
    followers   integer,
    engagement  numeric(6,2),
    rate        text,
    bio         text,
    notes       text,
    platforms   text[] not null default '{}',
    home_area   text,
    city        text,
    country     text check (country is null or country ~ '^[A-Z]{2}$'),
    lat         double precision check (lat is null or lat between -90 and 90),
    lng         double precision check (lng is null or lng between -180 and 180),
    stage       text not null default 'prospect' check (stage in ('prospect','talking','partner')),
    lead_id     uuid references public.crm_leads(id) on delete set null,
    created_by  uuid,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
create unique index if not exists crm_influencers_handle_uq on public.crm_influencers (platform, lower(handle));
create index if not exists crm_influencers_stage_idx on public.crm_influencers (stage);

create table if not exists public.crm_influencer_posts (
    id             uuid primary key default gen_random_uuid(),
    influencer_id  uuid not null references public.crm_influencers(id) on delete cascade,
    client_id      uuid not null references public.clients(id) on delete cascade,
    url            text,
    posted_at      date not null default current_date,
    views          integer check (views is null or views >= 0),
    created_by     uuid,
    created_at     timestamptz not null default now()
);
create index if not exists crm_influencer_posts_cr_idx on public.crm_influencer_posts (influencer_id);
create index if not exists crm_influencer_posts_client_idx on public.crm_influencer_posts (client_id, posted_at desc);

alter table public.clients add column if not exists lat double precision;
alter table public.clients add column if not exists lng double precision;
alter table public.clients add column if not exists city text;
alter table public.clients add column if not exists country text;

alter table public.crm_leads            enable row level security;
alter table public.crm_activities       enable row level security;
alter table public.crm_tasks            enable row level security;
alter table public.crm_influencers      enable row level security;
alter table public.crm_influencer_posts enable row level security;

-- The social media tools start switched off. An admin turns any of them on in Settings.
insert into public.system_settings (key, value) values ('tools_enabled', '{}') on conflict (key) do nothing;

-- ---------------------------------------------------------------------------------------------
-- Copy the old Instagram pipeline across (the old tables stay as they are).
--   business leads of the agency itself (no client)  ->  crm_leads, source Social, tagged "Lead Finder"
--   influencers, for any client                       ->  crm_influencers
--   their notes                                       ->  crm_activities
-- ---------------------------------------------------------------------------------------------
with best as (
    select distinct on (lower(username)) lower(username) as u, full_name, email, phone, whatsapp, website, city, category, followers_count, engagement_rate, bio
    from public.leads order by lower(username), is_enriched desc nulls last, created_at desc
)
insert into public.crm_leads (full_name, company, website, email, email_norm, phone, phone_norm, whatsapp, city, source, source_detail,
                              stage, lost_reason, tags, next_step, next_step_at, owner_id, created_by, legacy_pipeline_id, created_at, updated_at, stage_at)
select coalesce(nullif(b.full_name, ''), '@' || p.username),
       coalesce(nullif(b.full_name, ''), '@' || p.username),
       b.website,
       nullif(b.email, ''), case when b.email ~* '^[^\s@]+@[^\s@]+\.[^\s@]+$' then lower(b.email) end,
       nullif(b.phone, ''), nullif(regexp_replace(coalesce(b.phone, ''), '\D', '', 'g'), ''),
       nullif(b.whatsapp, ''), b.city, 'social', 'Lead Finder · @' || p.username || coalesce(' · ' || b.category, ''),
       case p.stage when 'contacted' then 'contacted' when 'replied' then 'replied' when 'meeting' then 'meeting' when 'won' then 'won' when 'lost' then 'lost' else 'new' end,
       p.lost_reason, array['Lead Finder'],
       case when p.follow_up_on is not null then 'Follow up' end, p.follow_up_on::timestamptz,
       p.assigned_to, p.created_by, p.id, p.created_at, p.updated_at, p.stage_at
from public.lead_pipeline p
left join best b on b.u = lower(p.username)
where p.kind = 'business' and p.client_id is null
on conflict do nothing;

insert into public.crm_activities (lead_id, type, body, actor_id, at)
select l.id, 'note', n.body, n.author_id, n.created_at
from public.lead_notes n
join public.crm_leads l on l.legacy_pipeline_id = n.pipeline_id
where not exists (select 1 from public.crm_activities a where a.lead_id = l.id and a.type = 'note' and a.at = n.created_at and a.body = n.body);

with best as (
    select distinct on (lower(username)) lower(username) as u, full_name, followers_count, engagement_rate, bio, city, category
    from public.leads order by lower(username), is_enriched desc nulls last, created_at desc
)
insert into public.crm_influencers (platform, handle, name, niche, followers, engagement, rate, bio, city, stage, created_by, created_at, updated_at)
select coalesce(p.platform, 'instagram'), p.username, nullif(b.full_name, ''), b.category, b.followers_count, b.engagement_rate, p.rate, b.bio, b.city,
       case when p.stage in ('agreed','live','paid') then 'partner' when p.stage in ('contacted','rates') then 'talking' else 'prospect' end,
       p.created_by, p.created_at, p.updated_at
from public.lead_pipeline p
left join best b on b.u = lower(p.username)
where p.kind = 'influencer'
on conflict do nothing;
