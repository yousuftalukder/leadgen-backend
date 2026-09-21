-- =====================================================================
-- EDGELEAD — PHASE 16 MIGRATION
--
-- Run this in the Supabase SQL editor BEFORE deploying server.js.
-- Safe to run more than once.
--
-- Lead generation stops being Instagram-only.
--
-- Facebook leads come from Pages, not from groups. The group pipeline
-- hashes author identity on purpose — author_hash is a one-way HMAC and
-- author_label holds only 'admin' or 'member' — so a group post proves
-- demand exists but names nobody you can contact. Un-hashing it would
-- mean deleting a privacy control that was built deliberately, over
-- private individuals posting in often-private groups.
--
-- A Facebook Page is the opposite: a business publishing its own contact
-- button. That is the direct equivalent of the Instagram business
-- profile the existing methods already target, with the same
-- defensibility.
--
-- What it does:
--   1. leads.platform, so one list can hold both without ambiguity.
--   2. leads.platform_id, for the Facebook page id.
--   3. The unique key the writer has been missing since phase 3.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. PLATFORM
--
--    Every existing row is Instagram, which is what the default records.
--    sources_detected already carries where a *contact detail* was found;
--    this is where the *lead* came from, which is a different question.
-- ---------------------------------------------------------------------
alter table public.leads
    add column if not exists platform text not null default 'instagram';

alter table public.leads
    add column if not exists platform_id text;

comment on column public.leads.platform is
    'instagram | facebook. Where the lead was discovered, not where a contact detail was found.';
comment on column public.leads.platform_id is
    'Facebook page id. Null for Instagram, where the handle is the identity.';


-- ---------------------------------------------------------------------
-- 2. THE UNIQUE KEY THE WRITER HAS BEEN MISSING
--
--    The leadgen worker selects existing usernames, diffs, then inserts
--    the remainder. Two campaigns running together both read before
--    either writes, so both insert the same lead — and because nothing
--    enforced uniqueness, both rows landed. campaign_leads has been
--    protected since phase 6; leads never was.
--
--    Checked before writing this: 0 duplicate (owner_user_id, username)
--    pairs across 405 rows, so the index builds without a dedupe step.
--    It is created non-unique-first nowhere — if this ever fails, there
--    are duplicates and they must be merged before retrying, not dropped.
--
--    Plain columns, not lower(username). PostgREST's on_conflict takes a
--    column list and cannot name an expression index, so an expression
--    key would be unusable as an upsert target — which is most of why
--    the key is being added. The writer lower-cases every handle on the
--    way in instead.
-- ---------------------------------------------------------------------
create unique index if not exists leads_owner_platform_username_uniq
    on public.leads (owner_user_id, platform, username);

-- The old non-unique index on the same leading columns is now redundant:
-- the unique one above serves every lookup it served.
drop index if exists public.idx_leads_owner_username;


-- ---------------------------------------------------------------------
-- 3. FINDING FACEBOOK LEADS BY PAGE
--
--    Kept for the search path used by the discovery worker.
-- ---------------------------------------------------------------------
create index if not exists idx_leads_platform
    on public.leads (owner_user_id, platform, created_at desc);


-- ---------------------------------------------------------------------
-- DONE
--
--     select platform, count(*) from public.leads group by platform;
--
-- Expect every existing row to read 'instagram'.
--
--     select indexname from pg_indexes
--     where schemaname = 'public' and tablename = 'leads';
--
-- Expect leads_owner_platform_username_uniq present and
-- idx_leads_owner_username gone.
-- ---------------------------------------------------------------------
