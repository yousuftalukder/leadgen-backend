-- ---------------------------------------------------------------------
-- PHASE 43 — the content plan the way the agency works.
--
-- 1. The business: what the audit of its website and socials found — the
--    business model, who it sells to and what it sells (each offer becomes
--    a primary topic). Staff correct it; the correction is what is used.
-- 2. Topics by category: services, educational, reviews, generic and
--    influencer collab, each ticked or not, with a priority and a reason.
-- 3. The idea library: one list for the whole team of content worth
--    copying the idea of, from any brand in any industry — the link, the
--    hook, why it worked, the post type and the tools it needs.
-- 4. Picks: for a client's month, one idea from the library per topic,
--    with the team's own notes on idea, script and style. A pick marked
--    final goes onto the calendar (phase 42) for the owner to approve.
--
-- The system chooses and suggests. It never makes the content.
--
-- Run in the Supabase SQL editor before deploying the phase-43 server.
-- Idempotent.
-- ---------------------------------------------------------------------

create table if not exists public.content_profiles (
    client_id    uuid primary key references public.clients(id) on delete cascade,
    sources      jsonb not null default '{}'::jsonb,     -- { website, instagram, facebook } as the team gave them
    business     jsonb not null default '{}'::jsonb,     -- { summary, model, audience, voice, offers: [{ name, price, note }], proof: [], differentiators: [] }
    audit        jsonb,                                  -- what the last audit read and suggested, kept apart from the corrected business
    audited_at   timestamptz,
    updated_by   uuid,
    updated_at   timestamptz not null default now()
);
alter table public.content_profiles enable row level security;
comment on table public.content_profiles is
    'What a client''s business is and sells, from the audit of its website and socials, as corrected by the team. Read and written only by the server.';

create table if not exists public.content_topics (
    id            uuid primary key default gen_random_uuid(),
    client_id     uuid not null references public.clients(id) on delete cascade,
    category      text not null check (category in ('service', 'educational', 'reviews', 'generic', 'collab')),
    title         text not null check (char_length(title) between 1 and 160),
    detail        text check (detail is null or char_length(detail) <= 600),
    why           text check (why is null or char_length(why) <= 400),
    priority      text not null default 'normal' check (priority in ('high', 'normal', 'low')),
    active        boolean not null default true,         -- ticked: in this client's plan
    source        text not null default 'manual' check (source in ('audit', 'rivals', 'reviews', 'manual')),
    suggestions   jsonb,                                 -- [{ ideaId, fit, adaptation, tools }] from the last "suggest ideas" run
    suggested_at  timestamptz,
    created_by    uuid,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);
create unique index if not exists idx_content_topics_title on public.content_topics (client_id, lower(title));
create index if not exists idx_content_topics_client on public.content_topics (client_id, category);
alter table public.content_topics enable row level security;
comment on table public.content_topics is 'A client''s content topics by category. Read and written only by the server.';

create table if not exists public.content_ideas (
    id            uuid primary key default gen_random_uuid(),
    url           text check (url is null or char_length(url) <= 500),
    source_name   text check (source_name is null or char_length(source_name) <= 120),   -- the brand or account it was seen at
    industry      text check (industry is null or char_length(industry) <= 80),
    post_type     text not null check (post_type in ('static', 'carousel', 'video', 'story')),
    hook          text check (hook is null or char_length(hook) <= 300),
    why_worked    text check (why_worked is null or char_length(why_worked) <= 600),
    style         text check (style is null or char_length(style) <= 600),          -- how it is put together: structure, pacing, look
    tools         text[] not null default '{}',
    tags          text[] not null default '{}',
    saved_by      uuid,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);
create unique index if not exists idx_content_ideas_url on public.content_ideas (lower(url)) where url is not null;
create index if not exists idx_content_ideas_type on public.content_ideas (post_type, created_at desc);
create index if not exists idx_content_ideas_tags on public.content_ideas using gin (tags);
alter table public.content_ideas enable row level security;
comment on table public.content_ideas is
    'The team''s shared idea library: content worth copying the idea of, from any brand or industry. Staff only; never shown to a business owner.';

create table if not exists public.content_picks (
    id            uuid primary key default gen_random_uuid(),
    client_id     uuid not null references public.clients(id) on delete cascade,
    month         date not null,                                        -- first day of the month it is for
    topic_id      uuid references public.content_topics(id) on delete set null,
    idea_id       uuid references public.content_ideas(id) on delete set null,
    post_type     text not null check (post_type in ('static', 'carousel', 'video', 'story')),
    title         text check (title is null or char_length(title) <= 300),
    adaptation    text check (adaptation is null or char_length(adaptation) <= 600),
    idea_note     text check (idea_note is null or char_length(idea_note) <= 1000),
    script_note   text check (script_note is null or char_length(script_note) <= 2000),
    style_note    text check (style_note is null or char_length(style_note) <= 1000),
    tools         text[] not null default '{}',
    status        text not null default 'draft' check (status in ('draft', 'final')),
    post_id       uuid,                                                 -- the content_posts row once it is on the calendar
    created_by    uuid,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);
create index if not exists idx_content_picks_month on public.content_picks (client_id, month);
create index if not exists idx_content_picks_idea  on public.content_picks (idea_id);
alter table public.content_picks enable row level security;
comment on table public.content_picks is
    'One planned post for a client''s month: the topic, the library idea and the team''s notes. Read and written only by the server.';

-- A calendar post can now come from a pick as well as from a scorecard brief.
alter table public.content_posts alter column report_id drop not null;
alter table public.content_posts add column if not exists pick_id uuid references public.content_picks(id) on delete set null;
create unique index if not exists idx_content_posts_pick on public.content_posts (pick_id) where pick_id is not null;
