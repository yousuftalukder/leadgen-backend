-- Phase 91: the dialer, and who was called and emailed.
-- Run in the Supabase SQL editor BEFORE the server that needs it deploys. Safe to run twice.
-- The phase-91 server also runs without it: the dialer lists leads and calls work, and the pages
-- say "run the phase-91 SQL" where they need these columns.
--
--   crm_leads.call_status        where the lead is in the dialer: not_called, tried, spoke, callback, in_play, closed
--   crm_leads.calls_count        calls made to it (outbound, from the phone or logged by hand)
--   crm_leads.last_call_at       when it was last called
--   crm_leads.last_call_outcome  how the last call went ("No answer", "Interested", …)
--   crm_leads.callback_at        when to try it again (a callback the caller set, or the retry rules)
--   crm_leads.emails_count       emails sent to it (by hand or by a campaign)
--   crm_leads.last_email_at      when it was last emailed
--   crm_leads.insights           "What we noticed": short lines about the business (the SEO tools fill it later)
--
-- Who may use the phone and when, the call lists and the retry rules are settings (system_settings rows),
-- so they need nothing here.

alter table public.crm_leads add column if not exists call_status       text not null default 'not_called';
alter table public.crm_leads add column if not exists calls_count       integer not null default 0;
alter table public.crm_leads add column if not exists last_call_at      timestamptz;
alter table public.crm_leads add column if not exists last_call_outcome text;
alter table public.crm_leads add column if not exists callback_at       timestamptz;
alter table public.crm_leads add column if not exists emails_count      integer not null default 0;
alter table public.crm_leads add column if not exists last_email_at     timestamptz;
alter table public.crm_leads add column if not exists insights          jsonb not null default '[]'::jsonb;

alter table public.crm_leads drop constraint if exists crm_leads_call_status_check;
alter table public.crm_leads add constraint crm_leads_call_status_check
    check (call_status in ('not_called','tried','spoke','callback','in_play','closed'));

create index if not exists crm_leads_call_status_idx on public.crm_leads (call_status, callback_at);
create index if not exists crm_leads_last_call_idx   on public.crm_leads (last_call_at desc);
create index if not exists crm_activities_call_sid_idx on public.crm_activities ((meta->>'sid')) where type = 'call';

-- Backfill from each lead's timeline: calls out (not incoming, not voicemail) and emails sent.
with c as (
    select lead_id, count(*) n, max(at) last_at,
           (array_agg(meta->>'outcome' order by at desc))[1] last_outcome
      from public.crm_activities
     where type = 'call' and coalesce(meta->>'direction', 'outbound') <> 'inbound' and coalesce(meta->>'voicemail', 'false') <> 'true'
     group by lead_id
), e as (
    select lead_id, count(*) n, max(at) last_at from public.crm_activities where type = 'email_out' group by lead_id
)
update public.crm_leads l set
    calls_count       = coalesce(c.n, 0),
    last_call_at      = c.last_at,
    last_call_outcome = c.last_outcome,
    emails_count      = coalesce(e.n, 0),
    last_email_at     = e.last_at
  from public.crm_leads x
  left join c on c.lead_id = x.id
  left join e on e.lead_id = x.id
 where l.id = x.id and (c.lead_id is not null or e.lead_id is not null);

-- Where each lead stands: won, lost or a client is closed; a lead being worked in the pipeline is in play;
-- called before is tried (due again a day after its last call); the rest stay not called.
update public.crm_leads set call_status = 'closed'
 where call_status = 'not_called' and (client_id is not null or stage in ('won','lost'));
update public.crm_leads set call_status = 'in_play'
 where call_status = 'not_called' and in_pipeline and stage in ('replied','meeting','proposal');
update public.crm_leads set call_status = case when last_call_outcome = 'Spoke' then 'spoke' else 'tried' end,
                            callback_at = coalesce(callback_at, last_call_at + interval '1 day')
 where call_status = 'not_called' and calls_count > 0;
