-- ===========================================================================
-- PHASE 4 — INSTAGRAM PARITY
-- ---------------------------------------------------------------------------
-- Adds the columns savePosts() now writes: fields the Apify actor was already
-- returning (and already being paid for) that the old savePosts() dropped, and
-- the derived columns needed to index a post against its own baseline.
--
-- Every statement is idempotent and additive. No column is dropped, no type is
-- changed, nothing is backfilled. Rows written before this migration keep NULL
-- in the new columns, which is correct: the data genuinely was not captured.
--
-- Safe to apply while the old server is still running — the new columns are
-- nullable and the old savePosts() simply will not populate them.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Fields the actor returned and savePosts() discarded
-- ---------------------------------------------------------------------------

-- Number of items in a carousel. NULL means the actor did not return
-- childPosts on that run, which is different from a 1-item post.
alter table public.posts add column if not exists carousel_count int;

-- Accounts tagged in the media itself, not in the caption. Collaboration
-- signal, and distinct from the mentions[] parsed out of caption text.
alter table public.posts add column if not exists tagged_users text[] default '{}';

-- Alt text: accessibility, and Instagram uses it for content understanding.
alter table public.posts add column if not exists alt_text text;

-- Media dimensions. 4:5 occupies roughly 25% more vertical feed space than
-- 1:1, which is one of the cheapest reach levers an account has and was
-- previously invisible to the report.
alter table public.posts add column if not exists media_width int;
alter table public.posts add column if not exists media_height int;
alter table public.posts add column if not exists aspect_ratio text;

-- Paid partnership / branded content flag. Sponsored posts behave differently
-- enough that averaging them in with organic distorts the baseline.
alter table public.posts add column if not exists is_sponsored boolean default false;

-- Reel audio: { title, artist, original, audioId }.
alter table public.posts add column if not exists audio jsonb;

-- Comments switched off on the post. A zero comment count means something
-- completely different when this is true.
alter table public.posts add column if not exists comments_disabled boolean;

-- First comment. Very often where the real hashtag block lives.
alter table public.posts add column if not exists first_comment text;


-- ---------------------------------------------------------------------------
-- 2. Derived columns
-- Persisted rather than recomputed because /api/posts and any future trend
-- query needs to sort and filter on them without pulling every row into node.
-- ---------------------------------------------------------------------------

-- likes + (IG_COMMENT_WEIGHT * comments)
alter table public.posts add column if not exists engagement_raw numeric;

-- Local-time posting slot, already offset by IG_TZ_OFFSET_MINUTES.
alter table public.posts add column if not exists hour_local smallint;
alter table public.posts add column if not exists dow_local  smallint;

-- Scraped before the post finished accumulating (24h default, 48h for
-- reels). The single most important flag here: without it a reel scraped six
-- hours after posting is averaged in as though it were finished.
alter table public.posts add column if not exists is_provisional boolean default false;


-- ---------------------------------------------------------------------------
-- 3. Indexes
-- ---------------------------------------------------------------------------

-- The heatmap and cadence queries filter settled posts by handle and slot.
create index if not exists idx_posts_settled
    on public.posts(handle, is_provisional, posted_at desc);

create index if not exists idx_posts_slot
    on public.posts(handle, dow_local, hour_local)
    where posted_at is not null;

-- Sponsored posts get excluded from organic baselines often enough to earn
-- a partial index.
create index if not exists idx_posts_sponsored
    on public.posts(handle) where is_sponsored = true;


-- ---------------------------------------------------------------------------
-- 4. Comments, so the next person reading the table knows what NULL means
-- ---------------------------------------------------------------------------
comment on column public.posts.carousel_count is
    'Items in the carousel. NULL = actor did not return childPosts, not "1 item".';
comment on column public.posts.is_provisional is
    'Scraped inside the settle window (24h, 48h for reels). Excluded from rate calculations.';
comment on column public.posts.engagement_raw is
    'likes + IG_COMMENT_WEIGHT*comments. Weighted because comments cost the viewer more and predict reach harder.';
comment on column public.posts.raw is
    'Diagnostic: { keys: [...] } listing what the actor actually returned. Read this before writing extraction code against a guessed field name.';

commit;


-- ===========================================================================
-- VERIFICATION — run after applying
-- ===========================================================================
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_schema = 'public' and table_name = 'posts'
--    and column_name in ('carousel_count','tagged_users','alt_text','media_width',
--                        'media_height','aspect_ratio','is_sponsored','audio',
--                        'comments_disabled','first_comment','engagement_raw',
--                        'hour_local','dow_local','is_provisional')
--  order by column_name;
--
-- Expect 14 rows, all nullable.
--
-- Then, after the first report run on the new server, this is the query that
-- answers "which fields does this actor version actually return":
--
-- select key, count(*)
--   from public.posts, jsonb_array_elements_text(raw->'keys') as key
--  where platform = 'instagram' and scraped_at > now() - interval '1 day'
--  group by key order by count(*) desc;
-- ===========================================================================
