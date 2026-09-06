-- ===========================================================================
-- EDGELEAD — SCHEMA PHASE 6
--
-- Run this once against Supabase BEFORE deploying the phase 6 server, and
-- AFTER schema-phase5.sql. Additive and idempotent.
--
-- What it is for:
--   Phase 6 converts /api/run-campaign into a checkpointed job. A checkpointed
--   save must be safe to replay: if the process dies halfway through writing
--   the campaign_leads rows, the resumed run writes the same set again. Without
--   a unique key on (campaign_id, lead_id) that produces duplicate rows, which
--   inflate total_leads_found and duplicate every lead in the Vault.
--
--   The old synchronous handler never had this problem because it never
--   resumed — it just lost the whole run.
-- ===========================================================================


-- ---------------------------------------------------------------------
-- 1. DE-DUPE ANYTHING ALREADY THERE
--
-- The pre-phase-6 handler inserted without a conflict target, so a campaign
-- that was run twice against the same campaign_id already carries duplicates.
-- Keep the lowest id of each pair; it is the one the Vault has been showing.
-- ---------------------------------------------------------------------
delete from public.campaign_leads a
 using public.campaign_leads b
 where a.campaign_id = b.campaign_id
   and a.lead_id     = b.lead_id
   and a.id          > b.id;


-- ---------------------------------------------------------------------
-- 2. THE CONSTRAINT
--
-- Named explicitly so the server can pass it as an onConflict target.
-- ---------------------------------------------------------------------
create unique index if not exists campaign_leads_campaign_lead_uniq
    on public.campaign_leads (campaign_id, lead_id);


-- ---------------------------------------------------------------------
-- 3. THE INDEX enrich-campaign READS BY
--
-- The enrichment worker pages through campaign_leads by campaign and by owner.
-- Both filters are now present (the user_id filter was missing entirely before
-- phase 6 — see PATCH-6 section 3).
-- ---------------------------------------------------------------------
create index if not exists idx_campaign_leads_campaign_user
    on public.campaign_leads (campaign_id, user_id);

create index if not exists idx_campaigns_user_created
    on public.campaigns (user_id, created_at desc);


-- ---------------------------------------------------------------------
-- 4. VERIFY
-- ---------------------------------------------------------------------
-- select
--     to_regclass('public.campaign_leads_campaign_lead_uniq') is not null as uniq_exists,
--     count(*) = count(distinct (campaign_id, lead_id))                   as no_duplicates
-- from public.campaign_leads;
-- -- expected: true, true
