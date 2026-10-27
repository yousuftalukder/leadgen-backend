-- ---------------------------------------------------------------------
-- PHASE 69 — the client's workbook: what the team types in by hand.
--
--   client_content_entries    the content plan a person writes: a date, the
--                             platform, the kind of post, the idea or script,
--                             the caption, and whether it went out. The plan
--                             the tool builds from scraped posts stays where it
--                             is (reports, content_posts); the page shows it
--                             beside these rows as ideas, never mixed in.
--   client_products           products and stock: quantity in hand, how many
--                             are on order, buying, customer and combo price.
--   client_ad_creatives       the ad ledger's creatives: format, angle, hook,
--                             which products they show.
--   client_ad_runs            each ad run against a creative: planned next,
--                             running, or done with its spend and results.
--   client_message_templates  saved replies for customers in Meta Business
--                             Suite: a title, the text, up to six pictures.
--   client_template_media     one row per picture on a template. The file is
--                             in the private storage bucket "client-library"
--                             (the server makes it, 5 MB a picture) and is only
--                             handed out as a short-lived signed link.
--
-- Read and written only by the server, for people on the client.
--
-- Run in the Supabase SQL editor before deploying the phase-69 server.
-- Idempotent.
-- ---------------------------------------------------------------------

create table if not exists public.client_content_entries (
    id            uuid primary key default gen_random_uuid(),
    client_id     uuid not null references public.clients(id) on delete cascade,
    planned_on    date,
    platform      text check (platform is null or char_length(platform) <= 60),
    post_type     text check (post_type is null or char_length(post_type) <= 60),
    idea          text check (idea is null or char_length(idea) <= 4000),          -- the description, script or vision
    caption       text check (caption is null or char_length(caption) <= 4000),
    status        text not null default 'planned' check (status in ('planned', 'made', 'posted', 'skipped')),
    posted_url    text check (posted_url is null or char_length(posted_url) <= 500),
    notes         text check (notes is null or char_length(notes) <= 2000),
    created_by    uuid,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);
create index if not exists idx_client_content_entries_client on public.client_content_entries (client_id, planned_on);
alter table public.client_content_entries enable row level security;

create table if not exists public.client_products (
    id            uuid primary key default gen_random_uuid(),
    client_id     uuid not null references public.clients(id) on delete cascade,
    name          text not null check (char_length(name) between 1 and 200),
    category      text check (category is null or char_length(category) <= 80),
    sku           text check (sku is null or char_length(sku) <= 60),
    stock         integer check (stock is null or stock >= 0),                      -- in hand; 0 is stock out, null not counted
    in_order      integer check (in_order is null or in_order >= 0),                -- ordered from the supplier, not arrived
    cost          numeric(14, 2) check (cost is null or cost >= 0),                 -- buying price
    price         numeric(14, 2) check (price is null or price >= 0),               -- customer price
    combo_price   numeric(14, 2) check (combo_price is null or combo_price >= 0),
    notes         text check (notes is null or char_length(notes) <= 2000),
    created_by    uuid,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);
create index if not exists idx_client_products_client on public.client_products (client_id, created_at);
alter table public.client_products enable row level security;

create table if not exists public.client_ad_creatives (
    id            uuid primary key default gen_random_uuid(),
    client_id     uuid not null references public.clients(id) on delete cascade,
    title         text not null check (char_length(title) between 1 and 200),
    format        text check (format is null or char_length(format) <= 40),
    angle         text check (angle is null or char_length(angle) <= 60),
    posted_on     date,
    influencer    text check (influencer is null or char_length(influencer) <= 120),
    language      text check (language is null or char_length(language) <= 20),
    product_ids   uuid[] not null default '{}',
    hook          text check (hook is null or char_length(hook) <= 1000),
    link          text check (link is null or char_length(link) <= 500),
    notes         text check (notes is null or char_length(notes) <= 2000),
    created_by    uuid,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);
create index if not exists idx_client_ad_creatives_client on public.client_ad_creatives (client_id, created_at);
alter table public.client_ad_creatives enable row level security;

create table if not exists public.client_ad_runs (
    id            uuid primary key default gen_random_uuid(),
    client_id     uuid not null references public.clients(id) on delete cascade,
    creative_id   uuid references public.client_ad_creatives(id) on delete set null,
    status        text not null default 'done' check (status in ('planned', 'running', 'done')),
    campaign      text check (campaign is null or char_length(campaign) <= 200),
    run_via       text check (run_via is null or char_length(run_via) <= 40),
    objective     text check (objective is null or char_length(objective) <= 40),
    start_on      date,
    end_on        date,
    audience      text check (audience is null or char_length(audience) <= 500),
    budget        numeric(14, 2) check (budget is null or budget >= 0),
    spend         numeric(14, 2) check (spend is null or spend >= 0),
    reach         bigint check (reach is null or reach >= 0),
    impressions   bigint check (impressions is null or impressions >= 0),
    clicks        bigint check (clicks is null or clicks >= 0),
    messages      bigint check (messages is null or messages >= 0),
    orders        bigint check (orders is null or orders >= 0),
    revenue       numeric(14, 2) check (revenue is null or revenue >= 0),
    verdict       text check (verdict is null or char_length(verdict) <= 20),
    learned       text check (learned is null or char_length(learned) <= 2000),
    created_by    uuid,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);
create index if not exists idx_client_ad_runs_client on public.client_ad_runs (client_id, start_on);
create index if not exists idx_client_ad_runs_creative on public.client_ad_runs (creative_id);
alter table public.client_ad_runs enable row level security;

create table if not exists public.client_message_templates (
    id            uuid primary key default gen_random_uuid(),
    client_id     uuid not null references public.clients(id) on delete cascade,
    title         text not null check (char_length(title) between 1 and 120),
    category      text check (category is null or char_length(category) <= 60),
    body          text check (body is null or char_length(body) <= 4000),
    media_ids     uuid[] not null default '{}',
    created_by    uuid,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);
create index if not exists idx_client_message_templates_client on public.client_message_templates (client_id, created_at);
alter table public.client_message_templates enable row level security;

create table if not exists public.client_template_media (
    id            uuid primary key default gen_random_uuid(),
    client_id     uuid not null references public.clients(id) on delete cascade,
    path          text not null,                                   -- the object's path in the client-library bucket
    content_type  text not null,
    bytes         integer not null check (bytes > 0),
    uploaded_by   uuid,
    created_at    timestamptz not null default now()
);
create index if not exists idx_client_template_media_client on public.client_template_media (client_id);
alter table public.client_template_media enable row level security;

comment on table public.client_content_entries is
    'A post in the content plan a person wrote for a client. The tool''s own plan (reports of type content_plan) is shown beside it, never merged into it.';
comment on table public.client_products is
    'A client''s product and its stock: quantity in hand, on order, buying, customer and combo price.';
comment on table public.client_ad_creatives is
    'An ad creative in the client''s ad ledger.';
comment on table public.client_ad_runs is
    'One ad run in the client''s ad ledger: planned next, running, or done with its spend and results, typed in from Ads Manager.';
comment on table public.client_message_templates is
    'A saved reply the team copies into Meta Business Suite for this client''s customers.';
comment on table public.client_template_media is
    'A picture on a message template. The bytes are in the private client-library bucket; the server hands out signed links to people on the client.';
