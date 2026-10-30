-- ---------------------------------------------------------------------
-- PHASE 87 — the workspace as the ad manager's memory.
--
-- What a check-in every three days needs, and what Meta cannot tell us:
-- what a result is worth, what happened to the orders, and what was
-- decided last time and why. The plan is docs/PLAN-AD-OPS.md; the method
-- is .claude/skills/ad-setup/REVIEW.md.
--
--   xp_ad_daily_snapshots  + thruplays, video_p100
--       ThruPlays (15 seconds, or the whole video if shorter) and plays to
--       the end, per ad per day, from the ads sync. Watch-through is
--       ThruPlays ÷ 3-second plays. Days closed before this phase stay
--       without them (a closed day never changes).
--
--   xp_ad_reach_windows
--       Each ad's last 7 days as one window: reach, impressions and
--       frequency. Reach cannot be added up from daily rows, so the sync
--       reads it from Meta as a window, replaced on every sync.
--
--   xp_meta_ad_accounts    + disable_reason
--       Why Meta disabled an account, for the health panel.
--
--   client_ad_economics
--       Per client: delivery charge and courier cost by zone, COD fee,
--       failed-parcel rate and the money lost per failed parcel, packing.
--       The break-even ad cost per order of every product comes from these.
--
--   client_products        + components
--       A combo made of other products: [{ product_id, qty }]. Its buying
--       cost and stock come from its parts when it has none of its own.
--
--   client_orders
--       One row per order: day, channel, items, value, delivery, where it
--       came from (an ad, organic, a repeat buyer), and what happened to it
--       (confirmed → shipped → delivered / failed / returned, or cancelled).
--       The buyer is a salted hash of the phone number; the number itself
--       is never stored.
--
--   client_ad_decisions
--       The decision log: what changed, which step of the check-in chain
--       it answers, the number it should move and when we will know; then
--       the grade (right, wrong, too early) and the lesson, tagged by idea.
--
-- Run in the Supabase SQL editor before deploying the phase-87 server.
-- Idempotent.
-- ---------------------------------------------------------------------

-- ---- 87a: the sync ----------------------------------------------------------------------------
alter table xp_ad_daily_snapshots add column if not exists thruplays  numeric;
alter table xp_ad_daily_snapshots add column if not exists video_p100 numeric;
alter table xp_meta_ad_accounts   add column if not exists disable_reason integer;

create table if not exists xp_ad_reach_windows (
    ad_id          text primary key references xp_meta_ads(ad_id) on delete cascade,
    client_id      uuid not null references xp_clients(id) on delete cascade,
    ad_account_id  text not null references xp_meta_ad_accounts(ad_account_id) on delete cascade,
    adset_id       text,
    period_from    date not null,
    period_to      date not null,
    spend          numeric(14,2),
    impressions    bigint,
    reach          bigint,
    frequency      numeric(8,2),
    updated_at     timestamptz not null default now()
);
create index if not exists xp_ad_reach_windows_client_idx on xp_ad_reach_windows (client_id);
comment on table xp_ad_reach_windows is
    'Phase 87. Each ad''s last 7 days as one window (reach, impressions, frequency), replaced on every ads sync. Reach does not add up across days.';

-- ---- 87b: what a result is worth ---------------------------------------------------------------
create table if not exists public.client_ad_economics (
    client_id       uuid primary key references public.clients(id) on delete cascade,
    delivery_zones  jsonb not null default '[]'::jsonb
                    check (jsonb_typeof(delivery_zones) = 'array' and jsonb_array_length(delivery_zones) <= 12),
    cod_fee_pct     numeric(5,2)  not null default 1   check (cod_fee_pct between 0 and 20),
    fail_rate_pct   numeric(5,2)  not null default 20  check (fail_rate_pct between 0 and 90),
    fail_loss       numeric(14,2) not null default 120 check (fail_loss >= 0),
    packing_cost    numeric(14,2) not null default 0   check (packing_cost >= 0),
    notes           text check (notes is null or char_length(notes) <= 2000),
    updated_by      uuid,
    updated_at      timestamptz not null default now()
);
comment on table public.client_ad_economics is
    'Phase 87. Delivery charge and courier cost by zone ([{name, charge, courier_cost}]), COD fee %, failed-parcel rate % and loss per failed parcel, packing cost: what an order costs beyond the product.';

alter table public.client_products add column if not exists components jsonb not null default '[]'::jsonb;
do $$ begin
    alter table public.client_products add constraint client_products_components_ck
        check (jsonb_typeof(components) = 'array' and jsonb_array_length(components) <= 20);
exception when duplicate_object then null; end $$;

-- ---- 87c: the orders log -----------------------------------------------------------------------
create table if not exists public.client_orders (
    id              uuid primary key default gen_random_uuid(),
    client_id       uuid not null references public.clients(id) on delete cascade,
    ordered_on      date not null,
    channel         text not null default 'messenger'
                    check (channel in ('messenger', 'whatsapp', 'instagram_dm', 'website', 'phone', 'walk_in', 'other')),
    items           jsonb not null default '[]'::jsonb
                    check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) <= 30),
    value           numeric(14,2) not null default 0 check (value >= 0),
    delivery_zone   text check (delivery_zone is null or char_length(delivery_zone) <= 60),
    delivery_charge numeric(14,2) check (delivery_charge is null or delivery_charge >= 0),
    free_delivery   boolean not null default false,
    source          text not null default 'unknown' check (source in ('ad', 'organic', 'repeat', 'unknown')),
    ad_id           text check (ad_id is null or ad_id ~ '^[0-9]{5,30}$'),
    status          text not null default 'confirmed'
                    check (status in ('confirmed', 'shipped', 'delivered', 'failed', 'returned', 'cancelled')),
    status_on       date,
    buyer_hash      text check (buyer_hash is null or buyer_hash ~ '^[0-9a-f]{32}$'),
    buyer_type      text check (buyer_type is null or buyer_type in ('new', 'returning')),
    notes           text check (notes is null or char_length(notes) <= 1000),
    created_by      uuid,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);
create index if not exists client_orders_client_day_idx on public.client_orders (client_id, ordered_on desc);
create index if not exists client_orders_ad_idx on public.client_orders (client_id, ad_id) where ad_id is not null;
create index if not exists client_orders_buyer_idx on public.client_orders (client_id, buyer_hash) where buyer_hash is not null;
comment on table public.client_orders is
    'Phase 87. One row per order, typed by the team: items [{product_id, qty, price}], value (items, without delivery), delivery, source (ad with its Meta ad id, organic, repeat), and its outcome. buyer_hash is an HMAC of the phone number; the number is never stored.';

-- ---- 87d: the decision log ---------------------------------------------------------------------
create table if not exists public.client_ad_decisions (
    id              uuid primary key default gen_random_uuid(),
    client_id       uuid not null references public.clients(id) on delete cascade,
    decided_on      date not null,
    scope           text not null default 'account' check (scope in ('account', 'campaign', 'adset', 'ad')),
    scope_id        text check (scope_id is null or char_length(scope_id) <= 40),
    scope_name      text check (scope_name is null or char_length(scope_name) <= 200),
    change          text not null check (char_length(change) between 1 and 1000),
    step            smallint check (step is null or step between 1 and 8),
    metric          text check (metric is null or char_length(metric) <= 40),
    expected        text check (expected is null or char_length(expected) <= 300),
    check_on        date,
    outcome         text check (outcome is null or outcome in ('right', 'wrong', 'too_early')),
    outcome_note    text check (outcome_note is null or char_length(outcome_note) <= 1000),
    graded_on       date,
    lesson          text check (lesson is null or char_length(lesson) <= 1000),
    idea_type       text check (idea_type is null or idea_type in ('opening', 'angle', 'offer', 'audience', 'format', 'budget', 'inbox', 'product', 'other')),
    idea            text check (idea is null or char_length(idea) <= 120),
    created_by      uuid,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);
create index if not exists client_ad_decisions_client_idx on public.client_ad_decisions (client_id, decided_on desc);
create index if not exists client_ad_decisions_lessons_idx on public.client_ad_decisions (idea_type) where lesson is not null;
comment on table public.client_ad_decisions is
    'Phase 87. Each change to a client''s ads: what, why (check-in step 1–8), the number it should move, when we will know; then the grade and the lesson, tagged by idea so it carries to other clients.';

-- Only the server (service role) reads and writes these, as for every other table.
alter table xp_ad_reach_windows         enable row level security;
alter table public.client_ad_economics  enable row level security;
alter table public.client_orders        enable row level security;
alter table public.client_ad_decisions  enable row level security;
