-- ===========================================================================
-- PHASE 24 — Meta data deletion
--
-- Meta's platform terms require an app to honour a Data Deletion Request:
-- when a person removes the app from their Facebook settings, Meta POSTs a
-- signed request naming them by their app-scoped Facebook user id, and the
-- app must delete what it holds on them and give back a URL where they can
-- see that it did.
--
-- We never stored that id. A connection knew its Page and its Instagram
-- account but not which Facebook user granted it — so a deletion request
-- could not be matched to anything. debug_token returns the id at OAuth
-- time; from this phase it is kept.
--
-- Deploy order: this file, then server.js, then the pages. Idempotent.
-- ===========================================================================

alter table public.meta_connections add column if not exists fb_user_id text;
create index if not exists idx_meta_connections_fb_user on public.meta_connections (fb_user_id);

comment on column public.meta_connections.fb_user_id is
    'App-scoped Facebook user id of the person who granted this connection. Needed to honour a Data Deletion Request.';

-- One row per deletion request Meta sends. The confirmation code is what the
-- person is shown; the status page looks it up. Kept after the data is gone,
-- because the whole point is being able to say it is gone.
create table if not exists public.meta_deletion_requests (
    code        text primary key,
    fb_user_id  text not null,
    connections integer not null default 0,
    reports     integer not null default 0,
    created_at  timestamptz not null default timezone('utc'::text, now())
);
alter table public.meta_deletion_requests enable row level security;
