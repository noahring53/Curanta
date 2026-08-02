# Curanta Roadmap — Toward a Local Media Operating System

*Date: 2026-07-27. Companion to [fractals-analysis.md](fractals-analysis.md), [curanta-audit.md](curanta-audit.md), [fractals-gap-analysis.md](fractals-gap-analysis.md). Ordered by leverage-to-effort. No code has been written; this is the plan for approval.*

## Design principles (apply to every phase)

- **Market-scoped everything.** Every new table carries `market_id`. Nothing hardcoded to any specific county; a "market" is data, so one deployment serves N licensed publishers.
- **Human-in-the-loop by default.** Pipelines end in a review queue, never in a send. Items naming private individuals (crime/court) get a hard review gate that cannot be configured off.
- **Match the stack.** Express + single-repo vanilla-JS SPA + Supabase REST + Anthropic SDK. New capabilities are new route modules and cron jobs in the same Node service. The only new external services proposed are changedetection.io (Phase 3) and an optional transcription worker (Phase 2) — both justified inline.
- **Background jobs over manual triggers.** In-process `node-cron` schedules + a `jobs` run-log table (idempotency keys, last-run stamps, error counts) so restarts/redeploys don't double-process. This avoids a queue infrastructure (pg-boss, Redis) until scale demands it — polling cadences here are minutes/hours, not seconds.

## Phase 0 — Foundations: markets, persistence, jobs *(prerequisite for everything; ~1–2 weeks)*

The audit's structural gaps — no background execution, no server-side articles, no dedupe, no market concept — block all three centerpieces. Fix them once.

**Scope**
1. **Modularize the server.** Split [server.mjs](../server.mjs) into `server.mjs` (bootstrap) + `lib/` (`anthropic.mjs` with `createWithFallback`/GROUNDING/sanitizer/editor pass, `supabase.mjs` with `sbGet`/`sbPatch`/insert helper, `fetching.mjs` with `assertSafeUrl`/`fetchArticle`/`resolveFeedUrl`) + `routes/` (`ai.mjs`, `ingest.mjs`, `stripe.mjs`, `publish.mjs`). Pure move, no behavior change — makes every later phase a new file instead of edits to a 2,000-line one.
2. **Markets.** New `markets` table (name, geography label, timezone, branding JSONB, owner user_id). Extend `publications` with `market_id` — a publication becomes "a newsletter product within a market." Migration keeps today's users working: a default market is auto-created per user (mirroring the existing default-publication pattern in `user_settings`).
3. **Job runner.** `node-cron` in the web process + `jobs` table (job name, market_id, schedule, last_run_at, last_status, lock timestamp). A `runJob(name, fn)` wrapper handles locking, logging, and error capture. Add `/api/admin/jobs` status endpoint.
4. **Persisted articles + review queue.** `queue_items` table: market_id, publication_id, kind (`article` | `meeting_highlight` | `submission` | `change`), url, title, summary, text, source metadata, `content_hash` and `url_hash` for dedupe, ai_score, ai_reason, status (`new` | `triaged` | `used` | `dismissed`), `requires_review` boolean (the crime/court gate lives here from day one), timestamps. `/api/ingest` writes into it; the builder's source sidebar reads from it instead of transient browser state.
5. **Dedupe.** On insert: exact URL-hash match, then normalized-title match, then (cheap, no model call) token-overlap similarity to flag near-duplicates into a `duplicate_of` pointer. Cross-feed duplicates collapse into one queue item listing all sources — which also feeds Curanta's existing multi-source synthesis nicely.

**Files touched:** server.mjs (split), supabase-schema.sql (markets, jobs, queue_items + RLS), app.js (source sidebar reads queue API; `sourcesLSKey`/`loadSourcesFromDB` area, app.js:104–137 and 6493–6607), package.json (`node-cron`).

**Data model:** `markets`, `jobs`, `queue_items`; `publications.market_id`; `sources.market_id`.

**Dependencies:** none. Ship first.

## Phase 1 — Automated public-meeting coverage *(centerpiece #1; ~2–3 weeks)*

Trigger on new meeting video and agendas, produce per-item highlights with decisions, votes, and timestamps, land them in the review queue. Designed as one pipeline instanced per *meeting body*, so it clones across bodies (county commission, school board, city council) and across markets by adding rows, not code.

**Scope**
1. **Meeting bodies as data.** `meeting_bodies` table: market_id, name, YouTube channel RSS URL, agenda RSS URL (CivicPlus Agenda Center emits per-department RSS), polling cadence, active flag. Operator CRUD in Settings.
2. **Triggers (cron, ~every 30 min).** Job `poll-meeting-sources` polls each body's YouTube RSS (the resolver at server.mjs:518 already normalizes channel URLs) and agenda RSS. New items create `meetings` rows (body_id, date, video_url, agenda_url, status: `detected` → `transcribing` → `drafted` → `reviewed` → `published`). Agenda and video for the same meeting are matched by date/title proximity.
3. **Transcripts, tiered.**
   - Tier 1 (no new runtime): fetch YouTube's own captions via the timedtext track — the Node equivalent of `youtube-transcript-api` (either that fetch done directly or the `youtubei.js` npm package). Covers most government channels since YouTube auto-captions everything, and keeps timestamps.
   - Tier 2 (fallback, optional worker): `yt-dlp` + Whisper for videos with captions disabled, or non-YouTube video URLs. This needs binaries, so it runs as a small separate Railway worker service polling `meetings` with status `needs_transcription` — justified because the main web process shouldn't run ffmpeg/audio jobs. Ship Tier 1 first; Tier 2 is its own sub-phase.
4. **Highlight generation.** New Anthropic action `meeting-highlights` in `routes/ai.mjs`, reusing GROUNDING + sanitizer: input = transcript (chunked with timestamp anchors) + agenda text (via existing `fetchArticle`); output = structured JSON per agenda item: title, what was decided, vote tally (who voted how, when stated), discussion summary, and the video timestamp where the item begins (deep-linkable `?t=` URL). Stored in `meeting_items`.
5. **Review queue landing.** Each meeting item becomes a `queue_items` row (kind `meeting_highlight`). Any item whose text names a private individual in a crime/court/code-enforcement context is flagged `requires_review` (a cheap classifier prompt at generation time errs toward flagging). Operators pull highlights into newsletter sections through the existing drag-to-compose builder — a meeting-recap section is just a config-driven section (`sectionPrompt`, server.mjs:947) fed with meeting items.

**Files touched:** new `routes/meetings.mjs`, `jobs/meetings.mjs`, `lib/transcripts.mjs`; `routes/ai.mjs` (new action + prompt); supabase-schema.sql; app.js (Settings page for meeting bodies near `renderSettingsPage` app.js:2085; queue/sidebar rendering; a meeting-review view).

**Data model:** `meeting_bodies`, `meetings`, `meeting_items` (+ transcript storage — text column, or Supabase Storage for large ones).

**Dependencies:** Phase 0 (jobs, queue, markets). Tier 2 additionally: yt-dlp/Whisper worker.

## Phase 2 — Ambient local-news monitoring *(centerpiece #2; ~1–2 weeks)*

Everything happening in the market flows into ONE deduped, triaged queue with a daily "does a resident care?" ranking.

**Scope**
1. **Scheduled feed polling.** Job `poll-sources` runs the existing `/api/ingest` logic (moved into `lib/`) on every saved source per market on a cadence — the browser no longer has to be open. Existing RSS/YouTube/Reddit/Medium resolution carries over untouched.
2. **Change detection.** For sources without feeds (sheriff's office page, school announcements, DOT projects): integrate **changedetection.io** as a self-hosted sidecar (Docker on Railway). Justification: mature diffing (visual + text selectors, anti-bot handling) that would take weeks to rebuild; it exposes an API/RSS of changes. Curanta stores watch configs per market (`monitors` table), registers them via changedetection's API, and a cron job pulls diffs into `queue_items` (kind `change`) with the diff text as body.
3. **Social bridges.** Facebook pages (the civic staple) via RSS bridge services or page-scrape monitors through changedetection; anything exposing RSS (Bluesky, Mastodon, Nextdoor agency feeds where available) is just a source row. No per-network API integrations yet.
4. **Daily ranking pass.** Job `rank-queue` (daily, per market): batches the last 24–48h of `new` queue items through the existing `score-stories` action (server.mjs:1691) with a resident-relevance rubric replacing the newsletter-audience rubric — "would a resident of {market} care: does it affect their money, safety, kids, commute, property, or local institutions?" Scores + reasons stored on `queue_items`; the sidebar's existing fit-sort (`setSidebarSort`, app.js:2702) reads them.
5. **Queue UI.** Promote the source sidebar into a proper triage view: filter by kind/status/score, collapse duplicates, one-click "add to issue," dismiss, or "track" (pin for follow-up).

**Files touched:** new `jobs/monitor.mjs`, `routes/queue.mjs`, `lib/changedetection.mjs`; app.js (queue view, replacing parts of `renderSourceSidebar` app.js:2472); supabase-schema.sql; Railway config for the changedetection service.

**Data model:** `monitors` (market_id, target URL, selector config, changedetection watch id); `queue_items` gains rank fields (added in Phase 0 schema).

**Dependencies:** Phase 0. Independent of Phase 1 (can run in parallel if desired).

## Phase 3 — Community intake *(centerpiece #3; ~1 week)*

Curanta's first public-facing surface: event, news-tip, and interview/spotlight submission forms that auto-draft blurbs into the queue.

**Scope**
1. **Public form routes.** `/m/:marketSlug/submit/event|tip|interview` — server-rendered lightweight pages (no SPA/auth), branded from `markets.branding`, honeypot + rate-limited (the limiter patterns at server.mjs:59 extend naturally). This is deliberately the beachhead for later public surfaces (polls, directories).
2. **Submissions land in the queue.** `submissions` table → `queue_items` (kind `submission`). A `submission-blurb` AI action drafts a newsletter-ready blurb per type (event listing with date/place/price; tip summary flagged "unverified — needs confirmation"; interview/spotlight intro). Tips always get `requires_review`; nothing from the public ever auto-publishes.
3. **Events get structure.** `events` table (market_id, title, start/end, venue, submitter, status pending/approved) so approved events can compose into an auto-drafted "This Week" events section — and later power boosted-event revenue and calendar auto-sourcing.
4. **Operator moderation** inside the queue view: approve/edit/dismiss; approved events feed the events section generator.

**Files touched:** new `routes/public.mjs`, `routes/ai.mjs` (blurb action); new static form templates in `public/` (or server-rendered strings, matching the `privacy.html` standalone-page pattern); app.js (moderation in queue view; "insert events section" in builder); supabase-schema.sql.

**Data model:** `submissions`, `events`.

**Dependencies:** Phase 0. Benefits from Phase 2's queue UI but doesn't require it.

## Phase 4 — Licensing readiness: white-label + tenancy hardening *(~1–2 weeks)*

The business goal is licensing Curanta to other publishers; this phase removes the deployment-global assumptions.

**Scope**
1. **Per-tenant publishing credentials.** Move `BEEHIIV_API_KEY`/`BEEHIIV_PUBLICATION_ID` from env (server.mjs:1817) into per-publication encrypted config; `/api/publish/beehiiv` resolves credentials by publication. Same pattern reserves space for other ESPs later.
2. **White-label branding.** `markets.branding` (name, logo URL, colors, footer/legal identity) applied to: builder chrome, email export templates (`buildBeehiivHTML`, `buildExportHTML`), public submission pages, sender identity. The Curanta landing page stays Curanta; everything a *reader or submitter* sees is the operator's brand.
3. **Teams and roles.** `market_members` (market_id, user_id, role owner/editor/contributor) replacing the pure per-user RLS model; policies become "member of market." This turns the cosmetic Team panel (app.js:5251) into real shared review — approval status and comments move into the DB.
4. **Operator onboarding path.** A "new market" setup flow (market info → branding → meeting bodies → sources → sections), which is also the internal playbook for licensing demos.

**Files touched:** supabase-schema.sql (major RLS revision — the riskiest change in the roadmap, needs a careful migration), routes/publish.mjs, app.js (branding application, team panel, onboarding wizard), server.mjs config handling.

**Data model:** `market_members`; encrypted per-publication `publish_config`; `markets.branding` fleshed out.

**Dependencies:** Phase 0. Should land before signing the first external licensee; doesn't block Phases 1–3 for your own market.

## Phase 5 — Revenue surfaces and later bets *(sequenced, each independent)*

In leverage order, all deferred until the coverage engine (Phases 1–3) is proving value:

1. **Newsletter sponsor inventory (S–M).** `sponsors` + `sponsor_slots` tables; the existing CTA/Sponsor section pulls the booked sponsor per issue; simple booking/run-of-schedule tracking. First direct operator revenue, tiny lift.
2. **SMS alerts (M).** Twilio (or similar) per-market number; alert composer fed by high-score queue items; strictly operator-triggered sends.
3. **Public reader site + paywall (L).** Fractals' web presence + subscription revenue. A big product-shape decision (Curanta becomes reader-facing); the Phase 3 public routes and Phase 4 branding are the foundation. Includes reader-side Stripe (distinct from operator billing).
4. **Civic data dashboards (L, incremental).** Reuse the `monitors`/jobs machinery to capture numeric datapoints (gas prices, jail roster counts, permits) into a time-series table; render trend blocks into newsletters first (cheap), web dashboards later.
5. **Court/crime coverage (L).** Only after the `requires_review` gate has proven itself in daily use. Same pipeline pattern as meetings (source → structured extraction → gated queue), with a non-negotiable human gate and name-redaction defaults.
6. **Print and video (L).** Farthest from the newsletter core; revisit once markets demand them.

## Sequence summary

```
Phase 0  Foundations (markets, jobs, queue, dedupe)   ██
Phase 1  Meeting coverage                                ████
Phase 2  Ambient monitoring                              ███   (parallelizable with 1)
Phase 3  Community intake                                  ██
Phase 4  White-label / licensing                             ███
Phase 5  Revenue + later bets                                  ...ongoing
```
