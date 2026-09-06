-- =====================================================================
-- EDGELEAD — PHASE 2 MIGRATION
--
-- Run this in the Supabase SQL editor BEFORE deploying server.js.
-- Safe to run more than once.
--
-- What it does:
--   1. Gives every Apify key a stable token_hash identity, so the raw
--      token can be encrypted without losing deduplication.
--   2. Removes the unique index on the raw token. Encrypted values use a
--      random IV, so the same token no longer produces the same string
--      and that index would stop deduplicating anything.
--   3. Adds app_users.byo_key_only, which pins a user to their own Apify
--      key and stops them falling back onto shared credit.
--   4. Adds a cost-truth view: what a run actually costs per 1k rows,
--      which is the number the COST_PER_1K_* env constants approximate.
-- =====================================================================

create extension if not exists pgcrypto;


-- ---------------------------------------------------------------------
-- 1. TOKEN IDENTITY
--
--    token_hash matches the server's tokenHash(): the first 32 hex chars
--    of the SHA-256 of the raw token. It is not reversible and it is
--    already the join key used by apify_usage_events.
-- ---------------------------------------------------------------------
alter table public.apify_keys
    add column if not exists token_hash text;

update public.apify_keys
set    token_hash = left(encode(digest(token, 'sha256'), 'hex'), 32)
where  token_hash is null
  and  token is not null
  and  token not like 'encv1:%';


-- ---------------------------------------------------------------------
-- 2. DEDUPE BEFORE THE UNIQUE INDEX
--
--    The old onConflict:'token' upsert could not create duplicates, so
--    this should find nothing. It exists because the unique index below
--    will refuse to build if it ever did.
-- ---------------------------------------------------------------------
delete from public.apify_keys a
using  public.apify_keys b
where  a.token_hash = b.token_hash
  and  a.token_hash is not null
  and  a.created_at > b.created_at;


-- ---------------------------------------------------------------------
-- 3. SWAP THE UNIQUE INDEX ONTO THE HASH
-- ---------------------------------------------------------------------
drop index if exists public.idx_apify_keys_token;

create unique index if not exists idx_apify_keys_token_hash
    on public.apify_keys (token_hash);


-- ---------------------------------------------------------------------
-- 4. BRING-YOUR-OWN-KEY USERS
--
--    false  (default): current behaviour. Own key first, then the engine
--                      primary, then the shared pool.
--    true            : own key only. No shared credit, ever. If their key
--                      is dry the job pauses and tells them so.
-- ---------------------------------------------------------------------
alter table public.app_users
    add column if not exists byo_key_only boolean not null default false;


-- ---------------------------------------------------------------------
-- 5. METRICS SUPPORT
-- ---------------------------------------------------------------------
create index if not exists idx_usage_actor
    on public.apify_usage_events (cycle_month, actor_id);


-- ---------------------------------------------------------------------
-- 6. COST TRUTH
--
--    COST_PER_1K_FB_POSTS and friends are guesses in env vars. This view
--    is what they should have been. Compare them once a real run exists:
--
--        select * from public.apify_cost_truth;
-- ---------------------------------------------------------------------
create or replace view public.apify_cost_truth as
select
    cycle_month,
    actor_id,
    count(*)                                                as runs,
    sum(items)                                              as items,
    round(sum(usage_usd), 4)                                as usd,
    case when coalesce(sum(items), 0) > 0
         then round((sum(usage_usd) / sum(items)) * 1000, 4)
         else null end                                      as usd_per_1k_items
from public.apify_usage_events
group by 1, 2
order by 1 desc, 5 desc;


-- ---------------------------------------------------------------------
-- DONE
--
-- After deploying server.js with APP_ENCRYPTION_KEY set, confirm the
-- migration ran by checking that no plaintext token remains:
--
--     select count(*) as still_plaintext
--     from public.apify_keys
--     where token not like 'encv1:%';
--
-- It should return 0. The server re-encrypts on every boot, so if it
-- does not, APP_ENCRYPTION_KEY is missing from the environment.
-- ---------------------------------------------------------------------
