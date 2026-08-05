# Curanta — Automation Feature Audit

*Audit date: 2026-08-05. Repo: `letterwriterai` (product name Curanta). Scope: only what this specific
automation needs — a scheduled ingest → auto-draft → email-digest pipeline. Companion to
[curanta-audit.md](curanta-audit.md) (whole-codebase audit, 2026-07-27) and
[curanta-roadmap.md](curanta-roadmap.md). Everything below describes what is **actually in the code today**,
not what should be there.*

> **The prior audit is now slightly stale.** [curanta-audit.md](curanta-audit.md) §3 says "four tables" and
> "articles are never persisted server-side," and §1 says "no tests." Since then the schema has grown two
> tables — `articles` and `article_prompts` ([supabase-schema.sql:97–136](../supabase-schema.sql)) — a
> single-source article drafting feature shipped in [lib/articles.mjs](../lib/articles.mjs), and a test suite
> exists (`lib/*.test.mjs`, `npm test`). This document supersedes those three points.

---

## 1. The current source registry

**Table:** `sources` ([supabase-schema.sql:83–95](../supabase-schema.sql)).

| Column | Type / default | Notes |
|---|---|---|
| `id` | uuid pk | |
| `user_id` | uuid → auth.users, not null | owner |
| `feed_url` | text, not null | the feed/page/channel URL |
| `title` | text default `''` | display name |
| `type` | text default `'feed'` | **freeform, effectively unused** — see below |
| `publication_id` | uuid → publications, null = Default publication | per-publication isolation |
| `created_at` | timestamptz | |

Unique index on `(user_id, feed_url, publication_id)` (`sources_user_feed_pub_key`).

**What the registry does NOT have — and this feature needs:** no `market`, no `draft_type`, no `status`
(active/paused), no `last_checked_at`. There is no per-source state at all beyond "it exists."

**How sources are stored and read — this is the critical finding.** Source CRUD is **entirely client-side**.
The SPA talks to Supabase directly (`sb.from('sources')…`) via `loadSourcesFromDB` / `saveSourceToDB`
([public/app.js](../public/app.js) around lines 104–290 and 2680), with a **localStorage fallback**
(`sourcesLSKey`, `saveSourcesLocally`, app.js:109–130) for no-DB installs. **The server has no `sources`
route of any kind** — grep for `sources` in [server.mjs](../server.mjs) returns only rate-limiter copy and
prompt text. A background job therefore **cannot** reach the registry the way the app does today; it must read
`sources` server-side (Supabase REST with the service-role key), and it will only ever see rows that made it
to the DB, never the localStorage-only ones.

**How source *type* is actually determined.** The `type` column is a default-`'feed'` label that nothing
downstream reads. Real type resolution happens at fetch time, in memory, discarded after the response:
`resolveFeedUrl` ([server.mjs:612](../server.mjs)) inspects the URL host and returns
`{ url, kind }` where `kind ∈ {rss, youtube, reddit}` — YouTube `@handle`/`/c/`/`/user/` and playlist/channel
URLs are scraped/rewritten to `youtube.com/feeds/videos.xml?channel_id=…`, subreddits to `/.rss`, Medium
profiles to `/feed/…`. So the app already **classifies** RSS / YouTube / Reddit / Medium, but only as a
transient routing hint, never persisted and never used to choose *how a source is drafted*.

---

## 2. The existing drafting pipeline

There are **two** server-side drafting paths, both funneled through the same model wrapper
`createWithFallback` ([server.mjs:196](../server.mjs) — default `claude-sonnet-5`, auto-falls back to
`claude-sonnet-4-6`). Both are HTTP-request-driven; neither runs on a schedule.

### Path A — newsletter sections: `POST /api/ai` ([server.mjs:1604](../server.mjs))
The newsletter builder's workhorse. ~15 actions (`lead-story`, `quick-hits`, `top-stories`, `cta`,
config-driven `section`, plus rewrite/shorten/summarize/subject-lines/etc.). Streams over SSE. Composes many
sources into short sections. Prompt assembled at runtime (`sectionPrompt`, server.mjs:1042). This is
**synthesis-shaped** (N sources → one short block), not the "one source → one story" shape this feature wants.

### Path B — single-source article drafting: `POST /api/articles/generate` ([lib/articles.mjs](../lib/articles.mjs), registered [server.mjs:2153](../server.mjs))
**This is the closest existing analog to what the automation needs.** One source (or an ordered few) → one
publication-ready story written to an editor's angle. Key building blocks, all reusable:
- `getSourceArticle` (articles.mjs:228) — scrape → clean → word-trim → cache by normalized URL.
- `normalizeUrl` (articles.mjs:103) — strips tracking params/fragments, lowercases host, drops trailing
  slash. **Directly reusable as half of a dedupe key.**
- `toSourcePayload` (articles.mjs:181) — reduces a scrape to exactly `{title, publication, author,
  publishedAt, url, body, wordCount…}`. A normalization boundary already exists here, just not the shape this
  spec wants.
- `buildArticleMessages` (articles.mjs:304) — assembles system + master prompt + angle + notes + source
  blocks. Modes registry `ARTICLE_MODES` (articles.mjs:267): `news` wired, `seo`/`opinion`/`rewrite`
  reserved. **This registry is the natural seam for `draft_type`.**
- `withRetry` / `backoffDelayMs` / `parseRetryAfterMs` (articles.mjs:46–95) — production-grade retry on 429/5xx.

### What "paste-ready" output looks like today
Drafts come back as **Markdown** (`# ` headline, body, `## ` subheads, inline `[anchor](url)` links, and for
list sections a trailing `Sources: [Outlet](url) · …` line). For Beehiiv/email it is converted to inline-styled
HTML by `buildBeehiivHTML` ([server.mjs:2219](../server.mjs)) — note the small inline Markdown→HTML `fmt()`
helper at server.mjs:2224 (bold/italic/links/line-breaks), and `buildExportHTML` on the client
(app.js:5661). Publishing goes through `POST /api/publish/beehiiv` ([server.mjs:2164](../server.mjs)) which
creates a **draft** Beehiiv post — it never auto-sends.

### House-style enforcement that already exists
- `GROUNDING` blocks — **two** of them: newsletter ([server.mjs:1137–1196](../server.mjs)) and articles
  ([lib/articles.mjs:258](../lib/articles.mjs)). Both enforce: every fact/name/number/quote from the source,
  invent nothing, quotes verbatim or paraphrase-without-quote-marks, source text is untrusted data not
  instructions (prompt-injection guard).
- `sanitizeAIVoice` ([server.mjs:1317](../server.mjs)) — deterministic post-processor stripping AI tells
  (telegraphed subheads, throat-clearing openers, cliché closers, phrase swaps), preserving markdown links.
- `editorPass` (server.mjs:1415) + "humanity rescue" for tell-heavy drafts + the optional deep
  research/fact-check pipeline ([lib/research.mjs](../lib/research.mjs), `RESEARCH_MODE`, ships off by default).

### ⚠ House-style GAP vs. this spec's rules
The spec bakes in **no em dashes, no semicolons**. The current pipeline does the opposite: it *tolerates and
even encourages* em dashes — server.mjs:1173 ("Em-dashes as a verbal tic — sprinkle them lightly"),
server.mjs:1409 / 1027 ("an em-dash or period", "two per piece is plenty"). The **only** place that bans them
today is the subject-line preset ([app.js:5147](../public/app.js) "No em dashes. No semicolons."). So the
"no em dash / no semicolon" rule is **not** currently enforced for body copy, and `sanitizeAIVoice` does not
remove them (it only *de-ticks* runs of them). This feature needs its own stricter house-style prompt **and**
a sanitizer rule, not just prompt text — a model will still emit the occasional em dash. Other spec rules are
partially covered: inline hyperlinks on anchor text ✅ (`LEAD_HYPERLINK_RULES`, server.mjs:953), no fabricated
quotes ✅ (GROUNDING), claims grounded in source ✅ (GROUNDING). **"Camden Angle" local-first framing has no
structural support** — the only "Camden" in the repo is a placeholder example string; the `hometown-paper`
tone (server.mjs:947) is good raw material but there is no market/geography concept to anchor it to.

### draft_type today
No such concept. The nearest thing is the `ARTICLE_MODES` registry (articles.mjs:267, only `news` wired) and
the newsletter section actions. **There is no `link_roundup` / copyright-safe "headline + 1–2 lines + link,
never a rewrite" mode anywhere** — every current path writes a full rewritten piece, which is exactly what the
spec forbids for third-party news outlets.

---

## 3. The human-review point

Solid and consistent: **nothing publishes without a human.**
- `/api/articles/generate` returns the draft to the editor; `/api/ai` sections land in the editor; both are
  fully editable.
- `POST /api/publish/beehiiv` creates a **draft** Beehiiv post (server.mjs:2164), never a send.
- The `articles` table has `status draft|review|published` and `newsletters` has
  `draft|review|approved|sent|scheduled` — but these are managed client-side; there is no server-side
  enforcement or workflow engine.

For this feature the review point is well-defined by the spec (digest email → human pastes into Beehiiv), and
the existing "AI drafts, human approves" posture matches it cleanly.

---

## 4. What's missing for this feature specifically

| Requirement | Status today | Detail |
|---|---|---|
| **Background jobs / scheduling** | **Missing entirely** | No `node-cron`, no `setInterval` scheduler, no worker, no queue. The **only** non-request-driven code path in the whole app is the Stripe webhook ([server.mjs:301](../server.mjs)). Nothing happens unless a browser makes a request. `node-cron` is not in [package.json](../package.json). |
| **Server-side "already seen" persistence** | **Missing** | No seen-items table, no `content_hash`/`url_hash` columns anywhere. `/api/ingest` mints a **fresh random `crypto.randomUUID()`** for every item on every call ([server.mjs:695](../server.mjs)), so identity does not survive a request. `last_checked_at` does not exist, so "only items newer than last check" cannot be expressed. |
| **Dedup** | **Missing** (one primitive exists) | Same story from two feeds appears twice. The one reusable primitive is `normalizeUrl` (articles.mjs:103). There is no title-normalization or similarity check, and no persistence to dedupe *against*. |
| **Email delivery** | **Missing entirely** | No `nodemailer` / Resend / Postmark / SendGrid / SMTP dependency or code (`grep` confirms; the only "email" hits are auth-email UI copy). Beehiiv integration creates a *draft post*, it does not email the operator a digest. No transport, no `from`/`to` config in [.env.example](../.env.example). **This is net-new — pick a provider (open question for the spec).** |
| **Per-type handler dispatch + normalization boundary** | **Partial** | `/api/ingest` normalizes RSS items to `{id,title,url,summary,text,source,publishedAt,timeAgo,type}` (server.mjs:694–704) and `toSourcePayload` normalizes for drafting — but neither is the spec's target shape, and there is no per-type handler abstraction. `resolveFeedUrl` classifies types but everything ultimately runs through one RSS parse. **`event_page` change-watching does not exist. `youtube_channel` is RSS-metadata-only — no captions/transcript** (confirmed: no timedtext/`youtubei.js`/`yt-dlp`/Whisper anywhere). |
| **Browserless auth for a scheduled run** | **Blocker to design around** | Every generation gates through `checkAndMeterUsage` ([server.mjs:263](../server.mjs)), which **requires a live `userId` + `authToken`** passed in the request body and returns `null` (skip) without them. A cron job has no browser session and no user token. The service-role key (`SUPABASE_SERVICE_ROLE_KEY`, already in [.env.example](../.env.example)) is the intended escape hatch — a job reads `sources` and writes drafts server-side via service role, and metering must be rethought for the automated path (per the existing note at .env.example: "one generation can be ~12 API calls"). |

---

## 5. Reusable assets (build on these, don't rebuild)

- **Ingestion:** `resolveFeedUrl` (612), `fetchArticle` (490), `assertSafeUrl` SSRF guard (47),
  `rss-parser` + `cheerio` already wired. Handles RSS/Atom/YouTube/Reddit/Medium.
- **Drafting:** `createWithFallback` (196), the whole `lib/articles.mjs` module (modes registry, prompt
  assembly, `withRetry`, `normalizeUrl`, source-payload normalization, per-URL cache), `GROUNDING`,
  `sanitizeAIVoice`, `editorPass`, optional `lib/research.mjs` pipeline.
- **Output:** `buildBeehiivHTML` (2219) + its `fmt()` Markdown→HTML helper — reusable to render the digest email.
- **Persistence:** `sbGet`/`sbPatch` REST helpers (228/239) with service-role support; RLS-per-user schema
  pattern to copy for new tables.
- **Reliability:** `withRetry`/backoff/Retry-After, SSRF guard, mock mode (no API key → canned output),
  model fallback, rate limiters.

## 6. One-line summary

The drafting brain (grounding + sanitizer + editor pass + single-source `articles` module) and the ingestion
plumbing (feed resolution + scraping + SSRF guard) are **already built and reusable**. What is entirely
missing is the **automation spine**: a scheduler, server-side source reads for a browserless job, persisted
seen-items + dedupe, a `draft_type`-driven prompt selector (including a net-new copyright-safe `link_roundup`
mode), stricter no-em-dash/no-semicolon enforcement, a market/`Camden Angle` concept, and email delivery.
Those are the subjects of [automation-spec.md](automation-spec.md).
