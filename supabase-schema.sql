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
  status              text default 'draft' check (status in ('draft','review','approved','sent','scheduled')),
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);
alter table newsletters add column if not exists subject_lines jsonb default '[]';

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
alter table user_settings enable row level security;
alter table publications  enable row level security;
alter table newsletters   enable row level security;
alter table sources       enable row level security;

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
