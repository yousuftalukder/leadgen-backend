-- Phase 90: industry and the pipeline on every lead, leads on the map, and email campaigns.
-- Run in the Supabase SQL editor BEFORE the server that needs it deploys. Safe to run twice.
-- The phase-90 server also runs without it (the new parts say "run the phase-90 SQL"), so the
-- order matters only for the new features, never for what already works.
--
--   crm_leads.industry           what the business does (roofing, plumbing, appliance repair…); the category is the source
--   crm_leads.in_pipeline        put in the pipeline on purpose; email, calls and texts are worked from there
--   crm_leads.pipeline_at        when it went in
--   crm_leads.lat, lng           where it is, for the leads map (looked up from the city by the server)
--   crm_tasks.kind               'todo', 'call' or 'email': a campaign's call step makes a 'call' task
--   crm_tasks.enrollment_id      the campaign step that made it
--   crm_email_templates          reusable emails, optionally for one category or industry
--   crm_campaigns                an email campaign: who it is for (audience), its steps, its sending rules
--   crm_enrollments              one lead on one campaign: where it is, when the next step is due, how it ended
--   crm_emails                   every email a campaign sent, with when it was opened

alter table public.crm_leads add column if not exists industry    text;
alter table public.crm_leads add column if not exists in_pipeline boolean not null default false;
alter table public.crm_leads add column if not exists pipeline_at timestamptz;
alter table public.crm_leads add column if not exists lat         double precision;
alter table public.crm_leads add column if not exists lng         double precision;
create index if not exists crm_leads_industry_idx on public.crm_leads (industry);
create index if not exists crm_leads_pipeline_idx on public.crm_leads (in_pipeline, stage);

-- Leads already being worked are in the pipeline: anything past New, and anything that became a client.
update public.crm_leads set in_pipeline = true, pipeline_at = coalesce(pipeline_at, stage_at, updated_at)
 where in_pipeline = false and (stage <> 'new' or client_id is not null);

alter table public.crm_tasks add column if not exists kind          text not null default 'todo';
alter table public.crm_tasks add column if not exists enrollment_id uuid;
alter table public.crm_tasks drop constraint if exists crm_tasks_kind_check;
alter table public.crm_tasks add constraint crm_tasks_kind_check check (kind in ('todo','call','email'));

create table if not exists public.crm_email_templates (
    id          uuid primary key default gen_random_uuid(),
    name        text not null check (char_length(name) between 1 and 120),
    subject     text not null default '' check (char_length(subject) <= 300),
    body        text not null default '' check (char_length(body) <= 20000),
    source      text,                     -- a category (lead source) it is written for, or null for any
    industry    text,                     -- an industry it is written for, or null for any
    created_by  uuid,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

create table if not exists public.crm_campaigns (
    id           uuid primary key default gen_random_uuid(),
    name         text not null check (char_length(name) between 1 and 120),
    status       text not null default 'draft' check (status in ('draft','active','paused','archived')),
    audience     jsonb not null default '{}'::jsonb,   -- { sources:[], industries:[], stages:[], pipeline:'any'|'in'|'out', owners:[], skipContacted:bool }
    steps        jsonb not null default '[]'::jsonb,   -- [{ id, type:'email'|'wait'|'call'|'task', days, subject, body, templateId, title }]
    settings     jsonb not null default '{}'::jsonb,   -- { stopOnReply, stopOnStage, window:{from,to,days}, timezone, dailyCap }
    created_by   uuid,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    activated_at timestamptz
);

create table if not exists public.crm_enrollments (
    id           uuid primary key default gen_random_uuid(),
    campaign_id  uuid not null references public.crm_campaigns(id) on delete cascade,
    lead_id      uuid not null references public.crm_leads(id) on delete cascade,
    status       text not null default 'active' check (status in ('active','done','stopped','replied','unsubscribed','bounced','failed')),
    step         integer not null default 0,
    next_at      timestamptz,
    last_at      timestamptz,
    sent         integer not null default 0,
    stop_reason  text,
    enrolled_by  uuid,
    created_at   timestamptz not null default now(),
    unique (campaign_id, lead_id)
);
create index if not exists crm_enrollments_due_idx  on public.crm_enrollments (status, next_at);
create index if not exists crm_enrollments_lead_idx on public.crm_enrollments (lead_id);

create table if not exists public.crm_emails (
    id            uuid primary key default gen_random_uuid(),
    campaign_id   uuid references public.crm_campaigns(id) on delete set null,
    enrollment_id uuid references public.crm_enrollments(id) on delete set null,
    lead_id       uuid references public.crm_leads(id) on delete cascade,
    step          integer,
    to_email      text not null,
    subject       text,
    body          text,
    message_id    text,
    status        text not null default 'sent' check (status in ('sent','failed')),
    error         text,
    sent_by       uuid,
    sent_at       timestamptz not null default now(),
    opened_at     timestamptz,
    opens         integer not null default 0
);
create index if not exists crm_emails_lead_idx     on public.crm_emails (lead_id, sent_at desc);
create index if not exists crm_emails_campaign_idx on public.crm_emails (campaign_id, sent_at desc);
create index if not exists crm_emails_sent_idx     on public.crm_emails (sent_at desc);

alter table public.crm_email_templates enable row level security;
alter table public.crm_campaigns       enable row level security;
alter table public.crm_enrollments     enable row level security;
alter table public.crm_emails          enable row level security;
