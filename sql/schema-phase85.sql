-- ---------------------------------------------------------------------
-- PHASE 85 — the ad brief and the ad plan.
--
-- Everything needed to plan a client's next ad set, read in one place, and
-- a plan made from it that the agency approves and then builds in Ads
-- Manager. Read only on Meta: nothing here creates or changes an ad.
--
--   xp_meta_ad_sets
--       How each of the business's ad sets was set up, as Meta has it:
--       optimisation goal, budget, bid strategy, destination, targeting
--       (locations, ages, genders, interests, audiences, placements).
--       Read by the ads sync with the ads_read permission it already has.
--       Budgets and bids are stored in the account's currency (Meta sends
--       them in cents; the sync divides).
--
--   xp_ad_breakdowns
--       Each ad set's last 90 days split one way at a time: by age and
--       gender, by region, by placement. Replaced on every sync.
--
--   client_ad_briefs
--       The brief for a client: goal, offer, budget, where they sell and
--       deliver, how orders come in, pixel, what to avoid, and what was
--       seen on the page and in the Ad Library. One per client.
--
--   client_ad_plans
--       A proposed campaign and its ad sets, with creative ideas and the
--       rules for stopping or scaling. Draft → approved or rejected →
--       launched (built in Ads Manager by hand).
--
-- Run in the Supabase SQL editor before deploying the phase-85 server.
-- Idempotent.
-- ---------------------------------------------------------------------

create table if not exists xp_meta_ad_sets (
    adset_id          text primary key,
    ad_account_id     text not null references xp_meta_ad_accounts(ad_account_id) on delete cascade,
    campaign_id       text,
    client_id         uuid references xp_clients(id) on delete cascade,
    name              text,
    status            text,
    optimization_goal text,
    billing_event     text,
    bid_strategy      text,
    bid_amount        numeric(14,2),
    daily_budget      numeric(14,2),
    lifetime_budget   numeric(14,2),
    currency          text,
    destination_type  text,
    promoted_object   jsonb,
    targeting         jsonb,
    start_time        timestamptz,
    end_time          timestamptz,
    updated_at        timestamptz not null default now()
);
create index if not exists xp_meta_ad_sets_client_idx on xp_meta_ad_sets (client_id);

create table if not exists xp_ad_breakdowns (
    adset_id          text not null,
    dimension         text not null check (dimension in ('age_gender', 'region', 'placement')),
    segment           text not null,
    client_id         uuid not null references xp_clients(id) on delete cascade,
    period_from       date not null,
    period_to         date not null,
    currency          text,
    spend             numeric(14,2),
    impressions       bigint,
    reach             bigint,
    link_clicks       bigint,
    messages_started  numeric,
    leads             numeric,
    purchases         numeric,
    purchase_value    numeric(14,2),
    updated_at        timestamptz not null default now(),
    primary key (adset_id, dimension, segment)
);
create index if not exists xp_ad_breakdowns_client_idx on xp_ad_breakdowns (client_id, dimension);

create table if not exists public.client_ad_briefs (
    client_id     uuid primary key references public.clients(id) on delete cascade,
    brief         jsonb not null default '{}'::jsonb check (jsonb_typeof(brief) = 'object' and pg_column_size(brief) <= 20000),
    observations  text check (observations is null or char_length(observations) <= 6000),
    updated_by    uuid,
    updated_at    timestamptz not null default now()
);

create table if not exists public.client_ad_plans (
    id           uuid primary key default gen_random_uuid(),
    client_id    uuid not null references public.clients(id) on delete cascade,
    status       text not null default 'draft' check (status in ('draft', 'approved', 'rejected', 'launched')),
    title        text not null check (char_length(title) between 1 and 160),
    plan         jsonb not null default '{}'::jsonb check (jsonb_typeof(plan) = 'object' and pg_column_size(plan) <= 60000),
    review_note  text check (review_note is null or char_length(review_note) <= 2000),
    created_by   uuid,
    decided_by   uuid,
    decided_at   timestamptz,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);
create index if not exists client_ad_plans_client_idx on public.client_ad_plans (client_id, created_at desc);

-- Only the server (service role) reads and writes these, as for every other table.
alter table xp_meta_ad_sets          enable row level security;
alter table xp_ad_breakdowns         enable row level security;
alter table public.client_ad_briefs  enable row level security;
alter table public.client_ad_plans   enable row level security;
