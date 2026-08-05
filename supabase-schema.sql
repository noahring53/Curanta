-- ─────────────────────────────────────────────────────────────────────────────
-- Curanta — Supabase Schema (complete, idempotent)
-- Run in your Supabase project: Dashboard → SQL Editor → New query → Paste → Run.
-- Safe to run multiple times.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── user_settings ─────────────────────────────────────────────────────────────
-- One row per user. Holds the Default publication's brand voice/audience/prompts
-- plus account-level subscription + usage fields.
create table if not exists user_settings (
  user_id                uuid primary key references auth.users(id) on delete cascade,
  brand_voice            text default '',
  brand_voice_samples    text default '',
  audience_avatar        text default '',
  voice_urls             jsonb default '[]',
  tone                   text default 'punchy-executive',
  brand_color            text default '#6366f1',
  default_prompts        jsonb default '{}',
  -- subscription / billing
  subscription_status    text default 'inactive',  -- inactive | trialing | active | past_due
  subscription_plan      text default 'pro',       -- pro | multi
  grandfathered          boolean default false,
  stripe_customer_id     text,
  trial_ends_at          timestamptz,
  -- usage metering
  generations_this_month integer default 0,
  generations_reset_at   timestamptz default now(),
  updated_at             timestamptz default now()
);

-- Backfill columns if an older user_settings table already exists
alter table user_settings add column if not exists brand_voice            text default '';
alter table user_settings add column if not exists brand_voice_samples    text default '';
alter table user_settings add column if not exists audience_avatar        text default '';
alter table user_settings add column if not exists voice_urls             jsonb default '[]';
alter table user_settings add column if not exists tone                   text default 'punchy-executive';
alter table user_settings add column if not exists brand_color            text default '#6366f1';
alter table user_settings add column if not exists default_prompts        jsonb default '{}';
alter table user_settings add column if not exists subscription_status    text default 'inactive';
alter table user_settings add column if not exists subscription_plan      text default 'pro';
alter table user_settings add column if not exists grandfathered          boolean default false;
alter table user_settings add column if not exists stripe_customer_id     text;
alter table user_settings add column if not exists trial_ends_at          timestamptz;
alter table user_settings add column if not exists generations_this_month integer default 0;
alter table user_settings add column if not exists generations_reset_at   timestamptz default now();
alter table user_settings add column if not exists updated_at             timestamptz default now();

-- ── publications ──────────────────────────────────────────────────────────────
-- Extra publications beyond the Default (which lives in user_settings).
create table if not exists publications (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users(id) on delete cascade not null,
  name            text not null,
  brand_voice     text default '',
  audience_avatar text default '',
  tone            text default 'punchy-executive',
  default_prompts jsonb default '{}',
  created_at      timestamptz default now()
);

-- ── newsletters ───────────────────────────────────────────────────────────────
create table if not exists newsletters (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid references auth.users(id) on delete cascade not null,
  title               text not null default 'Untitled Newsletter',
  subject             text default '',
  preview_text        text default '',
  subject_lines       jsonb default '[]',
  sections            jsonb default '{"topStories":[],"leadStory":[],"quickHits":[],"cta":[]}',
  top_stories_content text default '',
  prompts             jsonb default '{}',
  publication_id      uuid references publications(id) on delete set null, -- NULL = Default publication
  status              text default 'draft' check (status in ('draft','review','approved','sent','scheduled')),
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);
alter table newsletters add column if not exists subject_lines jsonb default '[]';
-- Per-publication newsletter separation (safe on older tables).
-- on delete set null: deleting a publication keeps its newsletters (moved to Default).
alter table newsletters add column if not exists publication_id uuid references publications(id) on delete set null;

-- ── sources ───────────────────────────────────────────────────────────────────
create table if not exists sources (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references auth.users(id) on delete cascade not null,
  feed_url       text not null,
  title          text default '',
  type           text default 'feed',
  publication_id uuid references publications(id) on delete cascade, -- NULL = Default publication
  created_at     timestamptz default now()
);
-- Per-publication source isolation (safe on older tables)
alter table sources add column if not exists publication_id uuid references publications(id) on delete cascade;
alter table sources drop constraint if exists sources_user_id_feed_url_key;
create unique index if not exists sources_user_feed_pub_key on sources (user_id, feed_url, publication_id);

-- ── article_prompts ───────────────────────────────────────────────────────────
-- The Prompt Library. Master prompts live here so generation only ever sends an
-- ID: the server reads the prompt text itself, and a long house-style prompt is
-- never re-uploaded from the browser on each article.
create table if not exists article_prompts (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references auth.users(id) on delete cascade not null,
  name           text not null default 'Untitled prompt',
  description    text default '',
  prompt         text not null default '',
  is_default     boolean default false,
  mode           text default 'news',   -- news | seo | opinion | rewrite (future modes)
  publication_id uuid references publications(id) on delete cascade, -- NULL = Default publication
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);
create index if not exists article_prompts_user_idx on article_prompts (user_id, publication_id);

-- ── articles ──────────────────────────────────────────────────────────────────
-- Generated drafts. body_html (not markdown) because the rich text editor is the
-- system of record once a draft is opened — round-tripping through markdown
-- would silently drop the formatting the writer added.
create table if not exists articles (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid references auth.users(id) on delete cascade not null,
  title              text not null default 'Untitled Article',
  body_html          text default '',
  angle              text default '',
  notes              text default '',
  mode               text default 'news',
  source_url         text default '',
  source_title       text default '',
  source_publication text default '',
  prompt_id          uuid references article_prompts(id) on delete set null,
  status             text default 'draft' check (status in ('draft','review','published')),
  publication_id     uuid references publications(id) on delete set null, -- NULL = Default publication
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);
create index if not exists articles_user_idx on articles (user_id, publication_id, updated_at desc);

-- ── updated_at trigger ────────────────────────────────────────────────────────
create or replace function set_updated_at()
returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists newsletters_updated_at on newsletters;
create trigger newsletters_updated_at
  before update on newsletters
  for each row execute function set_updated_at();

drop trigger if exists user_settings_updated_at on user_settings;
create trigger user_settings_updated_at
  before update on user_settings
  for each row execute function set_updated_at();

drop trigger if exists articles_updated_at on articles;
create trigger articles_updated_at
  before update on articles
  for each row execute function set_updated_at();

drop trigger if exists article_prompts_updated_at on article_prompts;
create trigger article_prompts_updated_at
  before update on article_prompts
  for each row execute function set_updated_at();

-- ── Auto-create a user_settings row on signup ─────────────────────────────────
-- Ensures every new user has a row so Stripe checkout + webhooks can update it.
create or replace function handle_new_user()
returns trigger as $$
begin
  insert into public.user_settings (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ── Row-Level Security ────────────────────────────────────────────────────────
alter table user_settings   enable row level security;
alter table publications    enable row level security;
alter table newsletters     enable row level security;
alter table sources         enable row level security;
alter table article_prompts enable row level security;
alter table articles        enable row level security;

-- user_settings: users own their own row
drop policy if exists "user_settings: select own" on user_settings;
drop policy if exists "user_settings: insert own" on user_settings;
drop policy if exists "user_settings: update own" on user_settings;
create policy "user_settings: select own" on user_settings for select using (auth.uid() = user_id);
create policy "user_settings: insert own" on user_settings for insert with check (auth.uid() = user_id);
create policy "user_settings: update own" on user_settings for update using (auth.uid() = user_id);

-- publications: users own their own rows
drop policy if exists "publications: select own" on publications;
drop policy if exists "publications: insert own" on publications;
drop policy if exists "publications: update own" on publications;
drop policy if exists "publications: delete own" on publications;
create policy "publications: select own" on publications for select using (auth.uid() = user_id);
create policy "publications: insert own" on publications for insert with check (auth.uid() = user_id);
create policy "publications: update own" on publications for update using (auth.uid() = user_id);
create policy "publications: delete own" on publications for delete using (auth.uid() = user_id);

-- newsletters: users own their own rows
drop policy if exists "newsletters: select own" on newsletters;
drop policy if exists "newsletters: insert own" on newsletters;
drop policy if exists "newsletters: update own" on newsletters;
drop policy if exists "newsletters: delete own" on newsletters;
create policy "newsletters: select own" on newsletters for select using (auth.uid() = user_id);
create policy "newsletters: insert own" on newsletters for insert with check (auth.uid() = user_id);
create policy "newsletters: update own" on newsletters for update using (auth.uid() = user_id);
create policy "newsletters: delete own" on newsletters for delete using (auth.uid() = user_id);

-- sources: users own their own rows
drop policy if exists "sources: select own" on sources;
drop policy if exists "sources: insert own" on sources;
drop policy if exists "sources: update own" on sources;
drop policy if exists "sources: delete own" on sources;
create policy "sources: select own" on sources for select using (auth.uid() = user_id);
create policy "sources: insert own" on sources for insert with check (auth.uid() = user_id);
create policy "sources: update own" on sources for update using (auth.uid() = user_id);
create policy "sources: delete own" on sources for delete using (auth.uid() = user_id);

-- article_prompts: users own their own rows. The server reads these with the
-- caller's own token, so these policies are what stop one user's prompt ID
-- resolving against another user's library.
drop policy if exists "article_prompts: select own" on article_prompts;
drop policy if exists "article_prompts: insert own" on article_prompts;
drop policy if exists "article_prompts: update own" on article_prompts;
drop policy if exists "article_prompts: delete own" on article_prompts;
create policy "article_prompts: select own" on article_prompts for select using (auth.uid() = user_id);
create policy "article_prompts: insert own" on article_prompts for insert with check (auth.uid() = user_id);
create policy "article_prompts: update own" on article_prompts for update using (auth.uid() = user_id);
create policy "article_prompts: delete own" on article_prompts for delete using (auth.uid() = user_id);

-- articles: users own their own rows
drop policy if exists "articles: select own" on articles;
drop policy if exists "articles: insert own" on articles;
drop policy if exists "articles: update own" on articles;
drop policy if exists "articles: delete own" on articles;
create policy "articles: select own" on articles for select using (auth.uid() = user_id);
create policy "articles: insert own" on articles for insert with check (auth.uid() = user_id);
create policy "articles: update own" on articles for update using (auth.uid() = user_id);
create policy "articles: delete own" on articles for delete using (auth.uid() = user_id);

-- ═════════════════════════════════════════════════════════════════════════════
-- AUTOMATION — ingest → auto-draft → email-digest pipeline (Slice 1)
-- The pipeline runs browserless via the Supabase SERVICE-ROLE key, which bypasses
-- RLS. The RLS policies below exist for when the app UI (an authenticated user)
-- later reads its own seen_items / drafts.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── sources: automation columns ──────────────────────────────────────────────
-- market: plain text label (e.g. "Camden"); drives the {market} Angle + grouping.
-- draft_type: HOW a source is written, independent of its ingest type. Defaults to
--   link_roundup — the copyright-safe default that never rewrites third-party news.
-- type: repurposed from the old default 'feed'. Backfilled to 'rss' below.
alter table sources add column if not exists market          text default '';
alter table sources add column if not exists draft_type      text default 'link_roundup';
alter table sources add column if not exists status          text default 'active';
alter table sources add column if not exists last_checked_at timestamptz;
update sources set type = 'rss' where type is null or type = 'feed' or type = '';
-- Constraints added after backfill so existing rows don't violate them.
do $$ begin
  alter table sources add constraint sources_type_chk
    check (type in ('rss','event_page','youtube_channel')) not valid;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table sources add constraint sources_draft_type_chk
    check (draft_type in ('full_article','short_blurb','link_roundup')) not valid;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table sources add constraint sources_status_chk
    check (status in ('active','paused')) not valid;
exception when duplicate_object then null; end $$;

-- ── seen_items: dedupe + "already drafted" ledger ────────────────────────────
create table if not exists seen_items (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references auth.users(id) on delete cascade not null,
  source_id    uuid references sources(id) on delete cascade,
  market       text default '',
  url_hash     text not null,          -- sha256(normalizeUrl(url))
  title_hash   text not null,          -- sha256(normalizeTitle(title))
  url          text default '',
  title        text default '',
  published_at timestamptz,
  draft_id     uuid,                   -- set once drafted
  created_at   timestamptz default now()
);
-- The idempotency backbone: a conflict here = already seen = skip.
create unique index if not exists seen_items_user_urlhash on seen_items (user_id, url_hash);
create index if not exists seen_items_user_titlehash on seen_items (user_id, title_hash);

-- ── drafts: generated output the digest reads from ───────────────────────────
create table if not exists drafts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) on delete cascade not null,
  source_id     uuid references sources(id) on delete set null,
  source_name   text default '',
  market        text default '',
  draft_type    text default '',
  title         text default '',
  url           text default '',
  published_at  timestamptz,
  body_markdown text default '',        -- paste-ready, house-style
  status        text default 'new' check (status in ('new','digested','dismissed')),
  created_at    timestamptz default now()
);
create index if not exists drafts_user_status on drafts (user_id, status, created_at desc);

-- ── jobs: run log + lock (idempotency / observability) ───────────────────────
create table if not exists jobs (
  name        text primary key,         -- 'run'
  last_run_at timestamptz,
  last_status text default '',           -- ok | error | running
  locked_at   timestamptz,               -- non-null = a run is in flight
  last_error  text default '',
  meta        jsonb default '{}'
);

-- ── RLS for the automation tables ────────────────────────────────────────────
alter table seen_items enable row level security;
alter table drafts     enable row level security;
alter table jobs       enable row level security;  -- no policies: service-role only

drop policy if exists "seen_items: select own" on seen_items;
drop policy if exists "seen_items: modify own" on seen_items;
create policy "seen_items: select own" on seen_items for select using (auth.uid() = user_id);
create policy "seen_items: modify own" on seen_items for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "drafts: select own" on drafts;
drop policy if exists "drafts: modify own" on drafts;
create policy "drafts: select own" on drafts for select using (auth.uid() = user_id);
create policy "drafts: modify own" on drafts for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
