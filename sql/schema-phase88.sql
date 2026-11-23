-- Phase 88: the phone (calls, texts, voicemail) and the service sold on a won lead.
-- Run in the Supabase SQL editor BEFORE the server that needs it deploys. Safe to run twice.
--
--   phone_calls      every call on the business number, in and out, with voicemail and its transcript
--   phone_messages   every text, in and out
--   phone_contacts   names and types for numbers (homeowner, property manager, warranty company, technician…)
--   crm_leads.service          the service sold when a lead became a client (for "jobs won" on the Overview)
--   crm_activities type 'sms'  texts appear on a lead's timeline

alter table public.crm_leads add column if not exists service text;

alter table public.crm_activities drop constraint if exists crm_activities_type_check;
alter table public.crm_activities add constraint crm_activities_type_check
    check (type in ('note','email_out','email_in','call','whatsapp','meeting','stage','task','system','sms'));

create table if not exists public.phone_calls (
    id             uuid primary key default gen_random_uuid(),
    sid            text unique not null,                 -- Twilio's CallSid (the caller's leg)
    direction      text not null check (direction in ('inbound','outbound')),
    from_number    text,
    to_number      text,
    contact_number text,                                 -- the outside party, E.164
    status         text,                                 -- ringing, in-progress, completed, no-answer, busy, failed, canceled, voicemail
    user_id        uuid,                                 -- who placed it (outbound)
    answered_by    uuid,                                 -- who picked it up (inbound)
    started_at     timestamptz not null default now(),
    answered_at    timestamptz,
    ended_at       timestamptz,
    duration       integer,                              -- seconds
    voicemail      boolean not null default false,
    recording_sid  text,
    recording_url  text,
    transcript     text,
    note           text,
    price          numeric(10,4),
    lead_id        uuid references public.crm_leads(id) on delete set null,
    read_at        timestamptz
);
create index if not exists phone_calls_contact_idx on public.phone_calls (contact_number, started_at desc);
create index if not exists phone_calls_started_idx on public.phone_calls (started_at desc);

create table if not exists public.phone_messages (
    id             uuid primary key default gen_random_uuid(),
    sid            text unique,
    direction      text not null check (direction in ('inbound','outbound')),
    contact_number text not null,
    body           text,
    media          jsonb not null default '[]'::jsonb,
    status         text,
    auto           boolean not null default false,       -- the missed-call text
    user_id        uuid,
    lead_id        uuid references public.crm_leads(id) on delete set null,
    at             timestamptz not null default now(),
    read_at        timestamptz
);
create index if not exists phone_messages_contact_idx on public.phone_messages (contact_number, at desc);
create index if not exists phone_messages_at_idx on public.phone_messages (at desc);

create table if not exists public.phone_contacts (
    id          uuid primary key default gen_random_uuid(),
    number      text unique not null,
    name        text,
    kind        text not null default 'other' check (kind in ('homeowner','property_manager','warranty','technician','vendor','other')),
    company     text,
    work_order  text,
    notes       text,
    opted_out   boolean not null default false,          -- replied STOP
    lead_id     uuid references public.crm_leads(id) on delete set null,
    created_by  uuid,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

alter table public.phone_calls    enable row level security;
alter table public.phone_messages enable row level security;
alter table public.phone_contacts enable row level security;
