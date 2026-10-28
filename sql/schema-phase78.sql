-- ---------------------------------------------------------------------
-- PHASE 78 — the content plan, linked to the ad ledger and to the owner.
--
--   client_ad_creatives.content_entry_id
--       The content-plan post a creative was made from ("Use as ad
--       creative"). One post is entered once: the creative keeps pointing
--       at it, and picks up its link when the post goes out. A deleted post
--       leaves the creative, unlinked.
--
--   client_content_entries.owner_decision / owner_note / decided_at
--       The business owner's answer to a post the team typed in, from
--       "Posts to approve" in Edge Meta AI: approved, changes (with what to
--       change) or skipped. The team's own status (planned, made, posted,
--       skipped) stays the team's.
--
-- Run in the Supabase SQL editor before deploying the phase-78 server.
-- Idempotent.
-- ---------------------------------------------------------------------

alter table public.client_ad_creatives
    add column if not exists content_entry_id uuid references public.client_content_entries(id) on delete set null;
create index if not exists idx_client_ad_creatives_entry on public.client_ad_creatives (content_entry_id) where content_entry_id is not null;

alter table public.client_content_entries
    add column if not exists owner_decision text check (owner_decision is null or owner_decision in ('approved', 'changes', 'skipped'));
alter table public.client_content_entries
    add column if not exists owner_note text check (owner_note is null or char_length(owner_note) <= 2000);
alter table public.client_content_entries
    add column if not exists decided_at timestamptz;

-- PostgREST reads the new columns at once.
notify pgrst, 'reload schema';
