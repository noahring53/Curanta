# Curanta — Automation Build Spec

*Date: 2026-08-05. Companion to [automation-audit.md](automation-audit.md). This is the plan for approval.*
*No code has been written. **Implementation waits for sign-off.***

> **Decisions locked (2026-08-05).** Email transport = **Resend**. YouTube transcripts = **full yt-dlp +
> Whisper** in scope. **No scheduling/polling in v1** — the pipeline is triggered **manually** ("Run now").
> Metering = a per-run draft cap (not the human monthly limit). `market` = a plain text label, not a new table.
> These replace the former §10 open questions.

## What we're building

A **manually triggered** pipeline that, without a browser open on a timer, ingests registered sources on
demand, drafts each new item in Curanta house style according to its `draft_type`, and emails the operator one
paste-ready digest grouped by source. It never auto-publishes. **Nothing runs on a schedule** — you invoke a
run when you want one. Adding a source = inserting a row; adding a source *type* = writing one handler; adding a
*drafting style* = adding one prompt. (A scheduler is a trivial later add — it would just call the same run
function — but is deliberately out of scope now.)

## Design principles (from the brief, honoring the existing stack)

- **Match the stack.** Express + Supabase REST (`sbGet`/`sbPatch` + a new insert helper) + Anthropic SDK
  (`createWithFallback`) + Resend for email. No queue infra (pg-boss/Redis), **no cron**. The one run is an
  authenticated HTTP endpoint. yt-dlp/Whisper transcription needs binaries — see §2 for where it runs.
- **Idempotent and safe to re-run.** All "new vs. seen" state lives server-side. Re-running the manual job
  double-drafts nothing and double-sends nothing — so clicking "Run now" twice is harmless.
- **One normalized shape.** Every handler emits the same object; nothing downstream knows a source's type.
- **Human-in-the-loop.** The pipeline ends in an email, never a send. Copyright-sensitive sources are
  structurally prevented from being rewritten (`link_roundup`).
- **Config-driven, secrets from env.** Behavior is data (rows) and env vars, not code branches.

---

## 1. Data model (new tables + columns)

Added to [supabase-schema.sql](../supabase-schema.sql), idempotent, RLS "users own their rows" like every
existing table. Reads/writes from the job use the **service-role key** (bypasses RLS) — see §7.

### 1a. `sources` — extend the existing table
```sql
alter table sources add column if not exists market        text default '';
alter table sources add column if not exists draft_type    text default 'link_roundup'
  check (draft_type in ('full_article','short_blurb','link_roundup'));
alter table sources add column if not exists status         text default 'active'
  check (status in ('active','paused'));
alter table sources add column if not exists last_checked_at timestamptz;
-- `type` already exists (default 'feed'); repurpose with a check once backfilled:
--   rss | event_page | youtube_channel   (see migration note below)
```
**Migration note.** `type` today is default `'feed'` and unused (audit §1). Backfill existing rows to `'rss'`,
then add `check (type in ('rss','event_page','youtube_channel'))`. `draft_type` defaults to `link_roundup` —
the safe default (never rewrites third-party content). The operator sets the real `draft_type` per source.

> A source stays owned by a `user_id`/`publication_id` as today. `market` is a plain text label for now
> (e.g. "Camden"); it drives the "Camden Angle" framing and digest grouping. Promoting `market` to a real
> `markets` table is [curanta-roadmap.md](curanta-roadmap.md) Phase 0 and is **out of scope here** — this
> feature only needs the label.

### 1b. `seen_items` — dedupe + "already drafted" ledger
```sql
create table if not exists seen_items (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) on delete cascade not null,
  source_id     uuid references sources(id) on delete cascade,
  market        text default '',
  url_hash      text not null,          -- sha256(normalizeUrl(url))
  title_hash    text not null,          -- sha256(normalizeTitle(title))
  url           text default '',
  title         text default '',
  published_at  timestamptz,
  draft_id      uuid,                   -- FK to drafts.id once drafted
  created_at    timestamptz default now()
);
create unique index if not exists seen_items_user_urlhash on seen_items (user_id, url_hash);
create index if not exists seen_items_user_titlehash on seen_items (user_id, title_hash);
```
The unique index on `(user_id, url_hash)` is the idempotency backbone: an insert conflict = already seen =
skip. `title_hash` catches the same story arriving from a second feed under a different URL.

### 1c. `drafts` — the generated output the digest reads from
```sql
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
  status        text default 'new'      -- new | digested | dismissed
    check (status in ('new','digested','dismissed')),
  created_at    timestamptz default now()
);
create index if not exists drafts_user_status on drafts (user_id, status, created_at desc);
```
(Reuses the shape of the existing `articles` table but is automation-owned, so we don't entangle the
browser-authored articles workflow.)

### 1d. `jobs` — run log / locking (idempotency + observability)
```sql
create table if not exists jobs (
  name          text primary key,       -- 'run' (the single manual pipeline run)
  last_run_at   timestamptz,
  last_status   text default '',        -- ok | error | running
  locked_at     timestamptz,            -- non-null = a run is in flight
  last_error    text default '',
  meta          jsonb default '{}'      -- counts: fetched/new/drafted/skipped
);
```
A `runJob(name, fn)` wrapper takes the lock (`locked_at`), runs, logs counts, releases. The lock is what makes
a double-clicked "Run now" safe: a second invocation while one is in flight is refused. A stale lock older than
a max-runtime threshold is reclaimable so a crashed run doesn't wedge future runs.

---

## 2. Pipeline architecture

New files, mirroring the roadmap's module split (no rewrite of `server.mjs`):

```
lib/automation/
  run.mjs           the pipeline run: for each active source → handler → normalize → dedupe → draft →
                    persist → assemble digest → email. runJob() lock/log wrapper lives here.
  normalize.mjs     the ONE normalized shape + normalizeTitle(); re-exports normalizeUrl from articles.mjs
  dedupe.mjs        hashing + seen_items check/insert
  digest.mjs        gather this run's new drafts → render paste-ready HTML → return for email
  email.mjs         Resend transport adapter
  handlers/
    index.mjs       type → handler registry  { rss, event_page, youtube_channel }
    rss.mjs
    event_page.mjs
    youtube_channel.mjs
  transcripts.mjs   yt-dlp + Whisper transcription (see §2 youtube handler)
  prompts.mjs       draft_type → house-style prompt selector
```
`server.mjs` gains **one route**: `POST /api/automation/run` (authenticated to the operator), guarded by an env
flag so it ships inert (matching the `RESEARCH_MODE` pattern). No boot-time scheduler. A "Run now" button in the
app calls this route; you can also curl it. When a scheduler is wanted later, it simply calls the same
`run.mjs` entry point.

### The flow (brief §Pipeline, made concrete)

1. **Trigger** (`POST /api/automation/run`). Operator-invoked, on demand. `runJob('run', …)` takes the lock so
   two concurrent runs can't overlap, then executes steps 2–6 in one pass and emails the digest at the end.
   **No timer, no continuous polling.**
2. **Dispatch per source** (`run.mjs`). Read `sources where status='active'` (service role). For each, look up
   `handlers[source.type]` and call it with `{ source, since: source.last_checked_at }`. The handler fetches
   **only items newer than `last_checked_at`** (filter on item `published_at`; fall back to seen-ledger check
   when a feed lacks reliable dates) — so even a manual run only surfaces what's new since the last run. After a
   successful fetch, stamp `last_checked_at = now()`.
3. **Normalize** (`normalize.mjs`). Every handler returns items already in — or `run.mjs` immediately maps to
   — **exactly this shape**, and nothing downstream may branch on `type`:
   ```js
   {
     source_id, source_name, market,
     title, url, published_at,
     raw_text_or_transcript,   // full text (rss/event_page) or transcript (youtube)
     draft_type                // copied from the source row
   }
   ```
   This is the enforced boundary: `dedupe.mjs`, `prompts.mjs`, and `digest.mjs` accept only this object.
4. **Dedupe** (`dedupe.mjs`). Compute `url_hash = sha256(normalizeUrl(url))` (reusing
   [articles.mjs `normalizeUrl`](../lib/articles.mjs)) and `title_hash = sha256(normalizeTitle(title))`
   (lowercase, strip punctuation, collapse whitespace). Try to insert into `seen_items`; a unique-conflict on
   `url_hash`, or an existing `title_hash` for the same user/market, means **already seen → skip**. This makes
   the whole job idempotent and re-runnable.
5. **Draft** (`prompts.mjs` + `createWithFallback`). Select the house-style system prompt by `draft_type`
   (§3), send `raw_text_or_transcript` + item metadata, run the result through `sanitizeAIVoice` **plus a new
   em-dash/semicolon stripper** (§3), and write a `drafts` row (`status='new'`). Link `seen_items.draft_id`.
6. **Digest + email** (`digest.mjs` + `email.mjs`). At the end of the same run, gather `drafts where
   status='new'`, group by `source_name` within `market`, render each as paste-ready Markdown→HTML (reuse the
   `fmt()` helper from [buildBeehiivHTML](../server.mjs)) with its source link + timestamp, and email the
   operator via **Resend**. Mark included drafts `status='digested'`. **No Beehiiv call, no auto-publish.** If
   there are no new drafts, send nothing (or a short "nothing new" note — operator preference).
7. **Persist** (all of the above). `sources.last_checked_at`, `seen_items`, `drafts`, and `jobs` are all
   server-side, so state survives restarts and redeploys.

### Handler contract (the extension point)
```js
// handlers/<type>.mjs
export async function fetchNew(source, { since }) {
  // return: Array<NormalizedItem>  (already the §3 shape, newer than `since`)
}
```
- **`rss.mjs`** — wraps existing `resolveFeedUrl` + `rss-parser` + `fetchArticle` (audit §5). Filters items to
  `published_at > since`. This is the first slice.
- **`youtube_channel.mjs`** — `resolveFeedUrl` already turns a channel/@handle into the videos RSS feed; new
  items are new videos. **Transcription is in scope for v1 (`transcripts.mjs`):** `yt-dlp` downloads the audio,
  Whisper transcribes it, and the transcript becomes `raw_text_or_transcript`. This needs the `yt-dlp` and
  `ffmpeg` binaries plus a Whisper path (local `whisper.cpp`/`faster-whisper`, or an API — see §8). **Runtime
  caution:** transcription is slow and CPU/GPU-heavy, and the run is synchronous (an HTTP request the operator
  waits on). For v1, cap concurrent transcriptions and per-run video count; if a run would exceed a time
  budget, transcribe what fits and leave the rest for the next run (they stay unseen). If synchronous proves
  too slow in practice, the fallback is a small separate worker service (roadmap Phase 1 Tier 2) — flag before
  building that.
- **`event_page.mjs`** — watch a URL for changes (civic calendars/event listings). v1: fetch page text via
  `fetchArticle`, hash it, compare to the last stored hash for that source; on change, emit one item whose
  body is the changed/new text. (A managed diff service like changedetection.io is a later upgrade, per
  roadmap Phase 2 — not needed for v1.)

---

## 3. House-style, driven by `draft_type`

`prompts.mjs` maps `draft_type` → system prompt. All three inherit a shared **house-style rules block** baked
in per the brief:

> - No em dashes. No semicolons.
> - Inline hyperlinks on meaningful anchor text (outlet name or a short natural phrase), never bare URLs.
> - No fabricated or generated quotes; quotations verbatim from the source or paraphrased without quote marks.
> - Every claim grounded in the source material; invent nothing. (Reuse the existing `GROUNDING` block.)
> - Local-first **"{market} Angle"**: lead with why a resident of {market} should care — money, safety, kids,
>   commute, property, or local institutions.

**Enforcement is two-layer**, because a prompt alone won't reliably kill em dashes (audit §2 GAP): the prompt
*plus* a deterministic post-pass in `sanitizeAIVoice`'s pipeline that rewrites `—`/`–` to commas or periods and
`;` to periods (outside verbatim quotes and outside markdown link targets).

| `draft_type` | Used for | Output shape | Hard rule |
|---|---|---|---|
| `full_article` | Civic/meeting/transcript sources you control framing on | Full house-style story: `#` headline + body + inline links + `Sources:` line | Reuses `ARTICLE_MODES.news` machinery |
| `short_blurb` | Official accounts, event pages | 2–4 tight sentences, one inline link, the local angle up front | No section headers |
| `link_roundup` | **Third-party news outlets (copyright)** | Headline + **1–2 line** summary + link. **NEVER a rewritten article.** | Enforced by prompt *and* a length/paraphrase guard; RSS from a news outlet **defaults here** |

`link_roundup` is the safety valve: it is the default `draft_type` for new sources so nothing gets rewritten by
accident.

---

## 4. Idempotency & failure handling

- **Locking:** `runJob` refuses to start if `jobs.locked_at` is set and fresh; reclaims a stale lock.
- **Dedupe = idempotency:** re-running `poll-sources` re-checks `seen_items`; already-seen items are skipped, so
  a crash mid-run and a re-run produce no duplicates.
- **Digest idempotency:** only `status='new'` drafts are sent, then flipped to `'digested'` in the same
  transaction-ish step; a re-run sends nothing. If the email send fails, drafts stay `'new'` and retry next run.
- **Per-source isolation:** one source erroring (dead feed, blocked page) is logged to `jobs.meta` and skipped;
  it never sinks the batch. Reuse `withRetry` (articles.mjs) for transient 429/5xx.
- **SSRF:** every fetched URL passes existing `assertSafeUrl`.

---

## 5. What the operator sees

- **Config:** set `market`, `type`, `draft_type`, `status` per source. v1 can drive this via SQL / a minimal
  settings addition; a full source-registry UI is optional polish, not required for the pipeline to work.
- **Output:** one morning email, drafts grouped by source under each market heading, each block paste-ready for
  Beehiiv with its source link and timestamp. Copy block → paste into Beehiiv → edit → publish. Human in the
  loop, exactly as today.

---

## 6. Reuse map (don't rebuild — audit §5)

`resolveFeedUrl`, `fetchArticle`, `assertSafeUrl`, `rss-parser`, `createWithFallback`, `GROUNDING`,
`sanitizeAIVoice`, `editorPass`, `lib/articles.mjs` (`normalizeUrl`, `withRetry`, `toSourcePayload`,
`ARTICLE_MODES`), `sbGet`/`sbPatch`, `buildBeehiivHTML`'s `fmt()`. Net-new: scheduler, handlers,
dedupe/seen-ledger, `draft_type` prompt selector, em-dash/semicolon stripper, email transport.

## 7. Auth for a browserless run (audit §4 blocker)

The run executes with **no user session**. The `POST /api/automation/run` route is authenticated to the
operator (Supabase token from the app's "Run now" button, or a shared secret header for curl). Inside, it reads
`sources` and writes `seen_items`/`drafts` via the **service-role key** (`SUPABASE_SERVICE_ROLE_KEY`, already
configured), scoped in the query to the operator's `user_id`. `checkAndMeterUsage`
([server.mjs:263](../server.mjs)) is **not** on this path; **metering = a per-run draft cap**
(`AUTOMATION_MAX_DRAFTS_PER_RUN`), not the human monthly generation limit. *(Locked decision.)*

## 8. Configuration & secrets (all from env)

```
AUTOMATION_ENABLED=false                 # ships inert; flip on (RESEARCH_MODE pattern)
AUTOMATION_USER_ID=<operator uuid>       # whose sources a run processes (single-operator v1)
AUTOMATION_RUN_SECRET=...                # shared secret to curl POST /api/automation/run
AUTOMATION_MAX_DRAFTS_PER_RUN=25         # cost guard (also the metering policy)
AUTOMATION_MAX_TRANSCRIBE_PER_RUN=3      # bound the slow yt-dlp+Whisper work per run
# ── Resend (email) ──
RESEND_API_KEY=re_...
DIGEST_TO=noahring53@gmail.com
DIGEST_FROM="Curanta <digest@yourdomain>"  # a Resend-verified sender
# ── Transcription (yt-dlp + Whisper) ──
YTDLP_PATH=yt-dlp                        # binary must be installed on the host
WHISPER_MODE=api                         # api | local
WHISPER_API_KEY=...                      # if WHISPER_MODE=api
WHISPER_MODEL=base                       # if WHISPER_MODE=local (whisper.cpp/faster-whisper)
```
No cron/timezone vars — there is no scheduler in v1.

---

## 9. Build order (Phase 3 — smallest working slice first)

1. **Slice 1 — thin end-to-end (rss + link_roundup + Resend email, manual trigger).** Schema (`sources` cols,
   `seen_items`, `drafts`, `jobs`); `run.mjs` + `runJob` + `POST /api/automation/run`; `handlers/rss.mjs`;
   `normalize.mjs`; `dedupe.mjs`; `prompts.mjs` (`link_roundup` only); `digest.mjs` + `email.mjs` (Resend).
   Prove: click Run → one RSS source → deduped → one drafted roundup item → one digest email. **This validates
   the whole spine before breadth.**
2. **Slice 2 — the other draft types.** Add `full_article` + `short_blurb` prompts, the em-dash/semicolon
   stripper (prompt + deterministic pass), and the `{market} Angle` framing.
3. **Slice 3 — event_page handler.** Fetch page text via `fetchArticle`, hash-diff against last stored hash,
   emit changed text as one item.
4. **Slice 4 — youtube_channel + transcription.** `handlers/youtube_channel.mjs` + `transcripts.mjs`
   (yt-dlp + Whisper), with per-run transcription cap and time budget. Verify host has yt-dlp/ffmpeg.
5. **Slice 5 — resilience & polish.** Per-source error surfacing in `jobs.meta`, draft/ transcription caps,
   stale-lock reclaim, a "Run now" button + minimal source-registry UI.
6. **Later (deferred, flag before starting):** a scheduler that calls `run.mjs` (if you later want it
   unattended), a separate transcription worker if synchronous proves too slow, changedetection.io for richer
   `event_page` diffing, promoting `market` to a real table (roadmap Phase 0).

---

## 10. Decisions (was: open questions) — all resolved 2026-08-05

1. **Email transport → Resend.** One env key, clean SDK, fine deliverability for a self-addressed digest.
2. **YouTube transcripts → full yt-dlp + Whisper, in scope** (Slice 4). Needs binaries; runs synchronously
   within a run under a per-run cap, with a worker as the later escape hatch if too slow.
3. **Trigger → manual "Run now", no scheduling in v1.** `POST /api/automation/run`; no cron. A scheduler is a
   later, trivial add that reuses the same run function.
4. **Metering → per-run draft cap** (`AUTOMATION_MAX_DRAFTS_PER_RUN`), not the human monthly limit.
5. **`market` → plain text label** on `sources`, not a new table (that's roadmap Phase 0, deferred).

---

**STOP.** Awaiting your approval of this spec before writing any code (Phase 3).
