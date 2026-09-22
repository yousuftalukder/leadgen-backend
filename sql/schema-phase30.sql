-- ---------------------------------------------------------------------
-- PHASE 30 — the numbers every day.
--
-- A connected Meta account is read once a day whether or not anyone runs a
-- report, so growth is read from the change between days. One row per
-- connection, level and day. Lifetime counts (followers) are what the
-- account said on that day; activity (reach, profile visits) is a day's
-- total, written once the day has ended.
--
-- Run in the Supabase SQL editor before deploying the phase-30 server.
-- Idempotent.
-- ---------------------------------------------------------------------

create table if not exists public.meta_daily (
    id               uuid primary key default gen_random_uuid(),
    connection_id    uuid not null references public.meta_connections(id) on delete cascade,
    user_id          uuid not null,
    day              date not null,
    level            text not null,                  -- page | ig
    followers        integer,                        -- lifetime count seen on `day`
    fans             integer,                        -- Page likes (page level only)
    following        integer,
    media_count      integer,
    reach            integer,                        -- the day's totals, written the day after
    views            integer,
    profile_views    integer,
    accounts_engaged integer,
    interactions     integer,
    website_clicks   integer,
    follows          integer,                        -- new follows that day
    source           text not null default 'sync',
    synced_at        timestamptz default now(),
    created_at       timestamptz default now()
);
create unique index if not exists idx_meta_daily_unique on public.meta_daily (connection_id, level, day);
create index if not exists idx_meta_daily_day on public.meta_daily (connection_id, day desc);
alter table public.meta_daily enable row level security;

comment on table public.meta_daily is
    'Owner-side Meta numbers, one row per connection, level and day. Written by the daily sync; read by /api/client/growth, /api/meta/growth and the assistant.';

-- When the connection was last read for the day, and what went wrong if it did not finish.
alter table public.meta_connections add column if not exists daily_synced_at timestamptz;
alter table public.meta_connections add column if not exists daily_error    text;
