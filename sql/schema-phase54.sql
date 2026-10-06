-- ---------------------------------------------------------------------
-- PHASE 54 — reliability and speed (audit batch 4).
--
-- el_client_report_counts: reports per client and type, counted by the
-- database. The clients list used to fetch every report row to count them:
-- slow as the history grows, and wrong past PostgREST's 1,000-row cap.
-- The server falls back to the old way until this exists.
--
-- Run in the Supabase SQL editor before (or after) deploying the phase-54
-- server; either order works. Idempotent.
-- ---------------------------------------------------------------------

create or replace view public.el_client_report_counts
with (security_invoker = true) as
    select client_id, report_type, count(*)::int as n
      from public.reports
     where client_id is not null
     group by client_id, report_type;

-- Closed to the public key like everything else since phase 51; the server reads it as the service role.
revoke all on public.el_client_report_counts from anon, authenticated;
grant select on public.el_client_report_counts to service_role;

-- The count reads this index rather than the table.
create index if not exists idx_reports_client_type on public.reports (client_id, report_type);
