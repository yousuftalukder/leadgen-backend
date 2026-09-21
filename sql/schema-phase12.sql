-- =====================================================================
-- EDGELEAD — PHASE 12 MIGRATION
--
-- Run this in the Supabase SQL editor BEFORE deploying server.js.
-- Safe to run more than once. Drops nothing that exists on the live
-- instance.
--
-- This is a reconciliation migration. It adds no product capability.
--
-- Why it exists:
--   Phase 3 section 0 created leads / campaigns / campaign_leads with
--   `if not exists` guards, because those three tables had been made by
--   hand on the live instance long before the migration set existed. On
--   live the guards fired and the CREATE statements did nothing — so
--   nobody noticed that the definitions in the file were written from
--   memory and do not match what is actually there. The live tables and
--   server.js have agreed with each other the whole time; only the file
--   was wrong.
--
--   That made sql/ unusable as a rebuild source: a database built from
--   phase 1..11 produces campaigns.keyword and leads.followers, which
--   server.js never writes, and lacks campaigns.keywords and
--   leads.followers_count, which it writes on every run. A staging copy
--   built from these files would fail on the first leadgen job.
--
--   Phase 3 has now been corrected in place, so a fresh build is right
--   from the start. Section 1 below is the safety net for any database
--   already built from the uncorrected file. On the live instance every
--   statement in section 1 is a no-op.
--
-- What it does:
--   1. Converges the three leadgen tables to the shape server.js writes.
--   2. Drops the duplicate unique constraint on campaign_leads.
--   3. Drops two RLS policies that no migration ever declared.
--   4. Makes the three apify views run as the caller, not the definer.
--   5. Pins search_path on the two RPCs.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. LEADGEN TABLE CONVERGENCE
--
--    No-ops on the live instance — every add already exists and every
--    drop names a column that was never there. This section only does
--    work on a database built from the pre-correction phase 3 file.
--
--    The drops are the half that matters. Without them a fresh build
--    carries both spellings (keyword AND keywords), which is a worse
--    failure than a missing column: inserts succeed, the wrong column
--    stays null, and nothing complains until someone reads it back.
-- ---------------------------------------------------------------------

-- leads: server.js writes followers_count, not followers, and has never
-- written a raw payload for a lead.
alter table public.leads add column if not exists followers_count  integer;
alter table public.leads add column if not exists engagement_rate  numeric;
alter table public.leads add column if not exists avg_reel_views   integer default 0;
alter table public.leads add column if not exists sources_detected text[];
alter table public.leads add column if not exists is_enriched      boolean default false;
alter table public.leads add column if not exists whatsapp         text;
alter table public.leads drop column if exists followers;
alter table public.leads drop column if exists raw;

-- campaigns: a campaign carries an array of keywords and an array of
-- selected methods, not one keyword and one platform string. The lead
-- count is total_leads_found. client_id arrived with phase 9.
alter table public.campaigns add column if not exists location_id       text;
alter table public.campaigns add column if not exists keywords          text[];
alter table public.campaigns add column if not exists selected_methods  text[];
alter table public.campaigns add column if not exists end_cursor        text;
alter table public.campaigns add column if not exists is_exhausted      boolean default false;
alter table public.campaigns add column if not exists total_leads_found integer default 0;
alter table public.campaigns add column if not exists client_id         uuid
    references public.clients(id) on delete set null;
alter table public.campaigns drop column if exists keyword;
alter table public.campaigns drop column if exists lead_count;
alter table public.campaigns drop column if exists platform;

-- campaign_leads: the link row carries the post that surfaced the lead,
-- and its timestamp column is added_at.
alter table public.campaign_leads add column if not exists top_post_url   text;
alter table public.campaign_leads add column if not exists top_post_views integer default 0;
alter table public.campaign_leads add column if not exists post_likes     integer default 0;
alter table public.campaign_leads add column if not exists post_comments  integer default 0;
alter table public.campaign_leads add column if not exists post_timestamp timestamptz;
alter table public.campaign_leads add column if not exists added_at       timestamptz
    not null default timezone('utc'::text, now());
alter table public.campaign_leads drop column if exists created_at;


-- ---------------------------------------------------------------------
-- 2. DUPLICATE UNIQUENESS ON campaign_leads
--
--    (campaign_id, lead_id) is enforced twice: by unique_campaign_lead,
--    a constraint made by hand and declared in no migration, and by
--    campaign_leads_campaign_lead_uniq, the index phase 6 added so the
--    resumed-run upsert had something to conflict against. Two unique
--    indexes on the same pair means every link write maintains both.
--
--    The phase 6 index is the one the migration set knows about, so the
--    hand-made constraint goes. Guarded, because dropping the wrong one
--    would silently break onConflict campaign_id,lead_id and let a
--    resumed run duplicate every lead in the campaign — the exact bug
--    phase 6 was written to fix.
-- ---------------------------------------------------------------------
do $$
begin
    if to_regclass('public.campaign_leads_campaign_lead_uniq') is not null then
        alter table public.campaign_leads drop constraint if exists unique_campaign_lead;
        raise notice 'phase12: dropped unique_campaign_lead, phase 6 index retained';
    else
        raise warning 'phase12: campaign_leads_campaign_lead_uniq is missing - keeping unique_campaign_lead. Run phase 6 first.';
    end if;
end $$;


-- ---------------------------------------------------------------------
-- 3. TWO UNDECLARED RLS POLICIES
--
--    Every other table in this database is RLS-enabled with no policies,
--    which is deny-all for anon and authenticated while the server's
--    service role bypasses RLS entirely. That is the intended posture:
--    the frontend holds the anon key and uses it for auth only — it
--    makes no PostgREST data calls at all.
--
--    campaigns and campaign_leads were the two exceptions, each carrying
--    an auth.uid() = user_id policy from the original single-tenant
--    build. Nothing reads them: they were the only direct browser path
--    into the data, and no page uses it.
--
--    They also scope on user_id alone, which is already the wrong shape
--    for the client/employee split — a client reaching their own rows
--    goes through client_id, not ownership.
--
--    To restore exactly what was here:
--      create policy "Users can manage their own campaigns"
--        on public.campaigns for all using (auth.uid() = user_id);
--      create policy "Users can view their own campaign leads"
--        on public.campaign_leads for all using (auth.uid() = user_id);
-- ---------------------------------------------------------------------
drop policy if exists "Users can manage their own campaigns"    on public.campaigns;
drop policy if exists "Users can view their own campaign leads" on public.campaign_leads;


-- ---------------------------------------------------------------------
-- 4. THE APIFY VIEWS RUN AS THE CALLER
--
--    apify_cost_truth, apify_spend_by_cycle and apify_key_budget were
--    created without security_invoker, so they run with the definer's
--    rights and read straight past RLS on apify_usage_events and
--    apify_keys. Postgres grants SELECT on new views in public to anon
--    and authenticated by default, and the anon key is published in
--    frontend/header.js — so anyone holding it could read the spend and
--    remaining credit of every key in the pool. Not the tokens, which
--    these views never select, but more than a logged-in client should
--    see.
--
--    Nothing in the product queries them: they are operator views, read
--    from the SQL editor. Under security_invoker the service role and a
--    SQL-editor superuser still bypass RLS and see everything; anon and
--    authenticated now hit deny-all on the underlying tables and get
--    nothing back.
--
--    Reversible with set (security_invoker = false).
-- ---------------------------------------------------------------------
alter view public.apify_cost_truth     set (security_invoker = true);
alter view public.apify_spend_by_cycle set (security_invoker = true);
alter view public.apify_key_budget     set (security_invoker = true);


-- ---------------------------------------------------------------------
-- 5. PINNED search_path ON THE RPCS
--
--    Both functions resolve public.apify_usage_events and public.jobs
--    through whatever search_path the caller happens to carry. Execute
--    is already revoked from anon and authenticated and granted only to
--    service_role, so this is hardening rather than a live hole — it
--    removes the case where a future caller with a different search_path
--    resolves those names to something else.
--
--    Bodies are untouched.
-- ---------------------------------------------------------------------
alter function public.el_cycle_spend(text, text)           set search_path = public, pg_temp;
alter function public.el_job_checkpoint(uuid, text, jsonb) set search_path = public, pg_temp;


-- ---------------------------------------------------------------------
-- DONE
--
-- Confirm the leadgen tables now match what server.js writes:
--
--     select column_name from information_schema.columns
--     where table_schema = 'public' and table_name = 'campaigns'
--     order by column_name;
--
-- Expect keywords and selected_methods present, keyword and platform
-- absent.
--
-- Confirm uniqueness is enforced exactly once:
--
--     select indexname from pg_indexes
--     where schemaname = 'public' and tablename = 'campaign_leads';
--
-- Expect campaign_leads_campaign_lead_uniq, and no unique_campaign_lead.
-- ---------------------------------------------------------------------
