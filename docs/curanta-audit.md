# Curanta — Codebase Audit

*Audit date: 2026-07-27. Repo: `letterwriterai` (product name Curanta). Everything below describes what is actually in the code.*

> **⚠ PARTIALLY STALE — corrected 2026-08-05.** Since this was written the schema and code have moved on. Known
> wrong claims below, corrected here so future sessions don't work from bad info:
> - **§1 "Tests: None in the repo"** and **§8 "no tests"** — **wrong now.** A test suite exists:
>   `lib/articles.test.mjs`, `lib/extract.test.mjs`, `lib/research.test.mjs`, run via `npm test`.
> - **§3 "Four tables"** and **§3 "Articles themselves are never persisted server-side"** — **wrong now.** The
>   schema has **six** tables; `articles` and `article_prompts` were added
>   ([supabase-schema.sql:97–136](../supabase-schema.sql)), and a single-source article drafting feature ships
>   in [lib/articles.mjs](../lib/articles.mjs) (`/api/articles/extract`, `/api/articles/generate`).
> - **§1 "one 1,970-line server file"** — server.mjs is now ~2,315 lines.
>
> For anything about the **ingest → auto-draft → email automation**, treat
> [automation-audit.md](automation-audit.md) as the source of truth — it is current as of 2026-08-05. The rest
> of this document (architecture posture, multi-tenancy analysis, prompt-pipeline description) remains accurate.

## 1. Stack and architecture

| Layer | What's there |
|---|---|
| Runtime | Node ≥20, ESM (`"type": "module"`) |
| Server | Express 4 — single file, [server.mjs](../server.mjs) (~1,970 lines) |
| Frontend | Vanilla-JS SPA, no framework, no build step — [public/app.js](../public/app.js) (~6,750 lines), [index.html](../public/index.html) (18-line shell), [styles.css](../public/styles.css) |
| AI | `@anthropic-ai/sdk`; default model `claude-sonnet-5` with automatic fallback to `claude-sonnet-4-6` (`createWithFallback`, server.mjs:120) |
| DB / auth | Supabase — client-side auth (SPA talks to Supabase directly); server uses raw REST helpers `sbGet`/`sbPatch` (server.mjs:147–174), no Supabase SDK. Schema in [supabase-schema.sql](../supabase-schema.sql) with RLS on every table |
| Billing | Stripe Checkout + customer portal + webhook (server.mjs:177–331). Plans: `pro` ($49) and `multi` ($99, 3 publications), 7-day trial, 500 generations/month metering |
| Ingestion | `rss-parser` + `cheerio` scraping, with an SSRF guard (`assertSafeUrl`, server.mjs:35) and browser-imitating headers/retry to get past WAFs |
| Publishing | Beehiiv API (draft posts), HTML export, rich-clipboard copy |
| Deploy | Railway (`APP_URL` defaults to `curanta-production.up.railway.app`); `node --watch` for dev |
| Tests | None in the repo. server.mjs exports `sanitizeAIVoice`, `aiTellCount`, `sectionPrompt` "for tests only" but no test files exist |
| Background jobs | **None.** Every ingestion, generation, and publish action is an HTTP request triggered by a user in the browser |

The architecture is deliberately thin: the server is a stateless proxy/prompt-composer; nearly all state and orchestration lives in the browser (`state` object, app.js:6–81), persisted to Supabase and mirrored to localStorage.

## 2. What Curanta does today, end to end

1. **Sign up / subscribe.** Supabase email auth (magic link supported). A DB trigger creates a `user_settings` row. Stripe Checkout starts a 7-day trial; webhooks keep `subscription_status`/`subscription_plan` in sync. Without a subscription, `/api/ai` returns 402 (`grandfathered` users bypass).
2. **Configure a publication.** Brand voice can be auto-discovered: `/api/discover-voice` probes a newsletter URL for RSS (Beehiiv/Substack/Ghost/WordPress patterns, then `<link rel=alternate>`, then link-scraping), pulls up to 15 back issues, and has Claude produce a voice profile, audience avatar, topic focus, and suggested sections. Users also define config-driven **sections** ({name, mode, format, length, instructions}) and per-section standing prompts.
3. **Add sources.** RSS feeds, single article URLs, YouTube channels/playlists (resolved to their RSS feeds, including @handle → channel-id scraping), subreddits, Medium profiles (`resolveFeedUrl`, server.mjs:518). Sources are saved per user (+per publication) in the `sources` table with localStorage fallback.
4. **Ingest.** Opening the builder auto-fetches sources (`autoFetchSources`, app.js:6592) through `/api/ingest` — quick mode returns RSS items instantly; `/api/hydrate` lazily fetches full article text/images when an article is actually used. `/api/extract-images` pulls og:image + content images.
5. **Triage.** Optional "smart story scoring": `score-stories` action has Claude score every candidate 0–100 for audience fit with a reason; the sidebar can sort by fit.
6. **Compose.** Drag articles into sections. Each section generates via `/api/ai` — either legacy actions (`lead-story`, `quick-hits`, `top-stories`, `cta`…) or the config-driven `section` action whose prompt is composed at runtime from the section config (`sectionPrompt`, server.mjs:947). Multi-article synthesis merges several reports on one story. Generation streams over SSE. A large grounding prompt (server.mjs:995), a deterministic AI-tell sanitizer (`sanitizeAIVoice`), an editor-pass second model call for lead stories, and a "humanity rescue" rewrite for tell-heavy drafts guard output quality. Auxiliary actions: rewrite, shorten, summarize, subject lines (two flavors), preview text, hooks, CTA, brand-voice, briefing-prompt.
7. **Review.** Everything lands in the editor as editable text. A Team panel holds comments and an approval status (draft/review/approved) — client-side only, not shared across users. Newsletter `status` in the DB supports draft/review/approved/sent/scheduled.
8. **Publish.** Beehiiv (creates a **draft** post via API — never auto-sends), email-HTML export, rich-text clipboard copy for pasting into any ESP, JSON export. Autosave to Supabase with a localStorage draft cache for crash recovery.

**Mock mode:** with no `ANTHROPIC_API_KEY`, every AI action returns canned output — the app is demoable without keys.

## 3. Data model

Four tables, all RLS "users own their rows":

- **`user_settings`** — 1:1 with auth user. Brand voice/samples, audience avatar, voice URLs, tone, brand color, default prompts, plus billing (`subscription_status/plan`, `grandfathered`, `stripe_customer_id`, `trial_ends_at`) and metering (`generations_this_month`, `generations_reset_at`). Doubles as the "Default publication."
- **`publications`** — extra publications beyond the default (name, voice, avatar, tone, prompts). Gated to the `multi` plan (limit 3) or grandfathered users.
- **`newsletters`** — title, subject, preview text, subject-line options, `sections` JSONB (all generated content), prompts, `publication_id` (NULL = default), `status`.
- **`sources`** — feed_url, title, type, `publication_id`; unique on (user, feed_url, publication).

Notable: section *configs* (the user's custom section layout) live in `user_settings.default_prompts` JSONB / localStorage rather than a table. Articles themselves are never persisted server-side — they live in browser state per session.

## 4. Multi-tenancy status

**What multi-tenant looks like today:** Curanta is a multi-*user* SaaS. Any number of users can sign up; RLS isolates their data; the `multi` plan gives one user up to 3 publications (separate voice/sources/newsletters). That's real and working.

**What's single-tenant / hardcoded:**

- **Beehiiv is deployment-global.** `BEEHIIV_API_KEY` / `BEEHIIV_PUBLICATION_ID` are env vars (server.mjs:1817) — one Beehiiv publication for the entire install. Any user hitting "publish" posts to the same Beehiiv account. This is the single biggest blocker to licensing.
- **One Anthropic key, one Stripe account, one `APP_URL`** — fine for one operator-of-record, but there's no per-tenant branding/domain: white-labeling is absent (logo, name "Curanta," landing page, legal pages are all fixed).
- **No concept of a market.** Publications have a name and voice but no geography, no market-scoped configuration, no operator/team model (single user owns everything; the Team panel is cosmetic).
- **No server-side per-tenant config at all** — the server has no tenant table; it trusts `userId`+`authToken` passed in request bodies and looks up `user_settings`.

**Not hardcoded to Camden County:** grep confirms the only "Camden" in the codebase is a placeholder example string in a UI prompt (app.js:4290). Nothing structural is market-specific.

## 5. Ingestion / automation inventory

| Mechanism | Trigger | Notes |
|---|---|---|
| `/api/ingest` (RSS/article) | User opens builder or adds a source | 16 items max per feed; quick mode + lazy hydrate |
| `/api/hydrate`, `/api/extract-images` | On demand per article | |
| `/api/discover-voice` | User runs voice wizard | Multi-strategy RSS discovery + AI analysis |
| YouTube/Reddit/Medium URL resolution | On source add | YouTube handled via RSS feeds only — no transcripts, no captions |
| Story scoring | User clicks "rank by fit" | AI ranking, deterministic temp 0.2 |
| Stripe webhook | Stripe | The only non-user-triggered code path in the app |

**There are no scheduled/background jobs of any kind** — no cron, no queue, no worker. Nothing happens unless a browser is open. There is also no dedupe layer: the same story from two feeds appears twice.

## 6. Where the Anthropic API is used

All calls are server-side in server.mjs, funneled through `createWithFallback`:

1. `/api/discover-voice` (server.mjs:800) — voice/audience profile JSON from back issues.
2. `/api/ai` (server.mjs:1459) — the workhorse. 15 actions; per-action temperature map (server.mjs:1329); max_tokens tiered by action; SSE streaming path; subscription + usage gate in front.
3. `editorPass` (server.mjs:1273) — internal second call tightening lead stories / rescuing tell-heavy drafts.

`MODEL` / `MODEL_LEAD` env-overridable; lead stories can use a stronger model.

## 7. Human-review points

- **Nothing publishes without a human.** All generation lands in the editor; Beehiiv publishing creates a *draft* in Beehiiv; export/copy is manual by nature.
- Editable everything: every generated block supports inline edit, rewrite, shorten, regenerate; subject lines are options to pick from.
- Approval workflow exists as UI state (draft → review → approved) and a DB status column, but has no enforcement and no multi-user semantics.
- `looksLikeRefusal` (app.js:3108) client-side guard catches model refusals before they land in copy.

## 8. Strengths and gaps relative to where this is headed

**Strengths to build on:** the prompt/quality pipeline (grounding + sanitizer + editor pass) is genuinely sophisticated and market-agnostic; config-driven sections mean new content types need no server changes; the ingest layer already handles RSS/YouTube/scraping with SSRF protection; publications give a ready-made seam to evolve into markets; mock mode + model fallback make it robust.

**Structural gaps:** no background execution, no persistence of ingested articles (no queue to triage), no dedupe, single-tenant publishing credentials, no white-label/branding layer, no market/geography concept, no team/roles, one 6,750-line frontend file and one 1,970-line server file that will need modularization as pipelines are added, and no tests.
