-- ===========================================================================
-- PHASE 19 — completing the two-sided product
--
--   1. The comparison set a client is measured against, held on the client
--      rather than retyped into every run.
--   2. An index for per-client assistant threads. The column itself
--      (ai_conversations.client_id) shipped in phase 15 and was never
--      written to; phase 19 starts writing it, so it needs an index.
--
-- Deploy order is the repo rule: this file, then server.js, then the pages.
-- Every statement is idempotent — running it twice changes nothing.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The comparison set
--
-- "How do I compare to similar businesses near me" needs a STABLE set of
-- accounts, not whatever someone typed into the competitor box that morning.
-- If the set moves between runs, the comparison is meaningless — the client
-- looks like they improved when really the yardstick changed.
--
-- text[] rather than a join table: this is a short, ordered, hand-curated list
-- that is always read whole and always rewritten whole. A join table would
-- add a migration and three endpoints to model something that is genuinely
-- one column.
-- ---------------------------------------------------------------------------
alter table public.clients add column if not exists competitors text[];
alter table public.clients add column if not exists competitors_source text;
alter table public.clients add column if not exists competitors_updated_at timestamptz;

comment on column public.clients.competitors is
    'Handles this client is benchmarked against. Kept stable on purpose: a moving yardstick makes every comparison meaningless.';
comment on column public.clients.competitors_source is
    'How the set was arrived at: "manual" or "discovered".';

-- ---------------------------------------------------------------------------
-- 2. Per-client assistant threads
--
-- An employee running eight clients needs eight separate conversations, not
-- one thread that mixes them. The assistant list is always "my threads for
-- this client, newest first", so that is the index.
--
-- Partial on client_id is wrong here: threads with no client (an employee
-- asking about their own account) are a real, queried case.
-- ---------------------------------------------------------------------------
create index if not exists idx_ai_conversations_user_client
    on public.ai_conversations (user_id, client_id, updated_at desc);

-- ---------------------------------------------------------------------------
-- 3. Monthly owner reports
--
-- meta_monthly is a new reports.report_type, not a new table — it carries the
-- same columns as every other report (client_id, meta_connection_id,
-- snapshot_date) and has to appear in the same timelines and share links.
-- A second table would have meant teaching every one of those about it.
--
-- The index exists because the monthly report is always fetched as "the
-- months for this connection, newest first" when building the comparison
-- against the previous month.
-- ---------------------------------------------------------------------------
create index if not exists idx_reports_meta_monthly
    on public.reports (meta_connection_id, snapshot_date desc)
    where report_type = 'meta_monthly';
