-- LetterWriterAI — Supabase Schema
-- Run this in your Supabase project: Dashboard → SQL Editor → New query → Paste → Run

-- ── newsletters ───────────────────────────────────────────────────────────────
create table if not exists newsletters (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete cascade not null,
  title       text not null default 'Untitled Newsletter',
  subject     text default '',
  preview_text text default '',
  sections    jsonb default '{"topStories":[],"leadStory":[],"quickHits":[],"cta":[]}',
  top_stories_content text default '',
  prompts     jsonb default '{}',
  status      text default 'draft' check (status in ('draft','review','approved','sent')),
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- ── sources ───────────────────────────────────────────────────────────────────
create table if not exists sources (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users(id) on delete cascade not null,
  feed_url   text not null,
  title      text default '',
  type       text default 'feed',
  created_at timestamptz default now(),
  unique(user_id, feed_url)
);

-- ── updated_at trigger ────────────────────────────────────────────────────────
create or replace function set_updated_at()
returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists newsletters_updated_at on newsletters;
create trigger newsletters_updated_at
  before update on newsletters
  for each row execute function set_updated_at();

-- ── Row-Level Security ────────────────────────────────────────────────────────
alter table newsletters enable row level security;
alter table sources     enable row level security;

-- newsletters: users own their own rows
create policy "newsletters: select own" on newsletters for select using (auth.uid() = user_id);
create policy "newsletters: insert own" on newsletters for insert with check (auth.uid() = user_id);
create policy "newsletters: update own" on newsletters for update using (auth.uid() = user_id);
create policy "newsletters: delete own" on newsletters for delete using (auth.uid() = user_id);

-- sources: users own their own rows
create policy "sources: select own" on sources for select using (auth.uid() = user_id);
create policy "sources: insert own" on sources for insert with check (auth.uid() = user_id);
create policy "sources: update own" on sources for update using (auth.uid() = user_id);
create policy "sources: delete own" on sources for delete using (auth.uid() = user_id);
