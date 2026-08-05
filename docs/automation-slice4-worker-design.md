# Slice 4 — youtube_channel + transcription worker (DESIGN, for approval)

> **⚠ BLOCKER found during Slice 4 build (2026-08-05).** The Tier-1 "pull YouTube's own captions by
> fetch" approach is **built and unit-tested, but caption *content* cannot be downloaded from a datacenter
> IP.** The caption *track list* is readable from the watch page (Camden County BOC videos do carry `en(asr)`
> auto-captions, confirmed), but every fetch of the caption track body returns **HTTP 200 with an empty body** —
> across `srv1`/`srv3`/`json3`, the simplified `/api/timedtext` endpoint, and the InnerTube `player` API
> (ANDROID/IOS clients), and also for a known-captioned control video. This is YouTube's proof-of-origin
> (POT) / datacenter-IP gating. **Railway is a datacenter, so this will very likely behave the same in
> production.** The handler degrades safely (it defers, emits nothing, never errors or fabricates), but it will
> produce zero YouTube drafts until caption retrieval works. Options now under discussion:
> - **yt-dlp in captions-only mode** (`--skip-download --write-auto-subs --sub-lang en --sub-format json3`) — no
>   Whisper, no ffmpeg, no audio. Much lighter than the full worker below; yt-dlp does the token/client dance
>   that raw fetch cannot. Can run inline or in a tiny worker. Reverses the "no yt-dlp" preference, so it needs
>   a decision. May still need cookies/a residential proxy if YouTube blocks the datacenter IP outright.
> - **Verify on Railway first** — small chance its IP range is not gated; cheap to test before changing approach.
> - **Residential proxy** for the pure-fetch path — works but adds cost/ops.
>
> No further Slice 4 code until this is decided.


*Date: 2026-08-05. Companion to [automation-spec.md](automation-spec.md). **No code yet** — this is the design
to approve first, per instruction. Reaffirmed decisions: full yt-dlp + Whisper, a SEPARATE worker service (not
synchronous in the request), manual trigger (no scheduler).*

## The four questions, answered up front

1. **Where the worker runs.** A separate Railway service in the same project, from the same repo, started with
   `node worker.mjs` on a small Docker image that bundles `yt-dlp` + `ffmpeg` + Whisper. It shares the Supabase
   DB (service-role) and env with the web service. The web dyno never runs ffmpeg/Whisper. This is the **first
   new external service** in the whole automation feature — everything else lives in the web process — so it is
   the main thing to sign off on.
2. **How a long job reports back without blocking the run.** The **database is the message bus** — no Redis, no
   pg-boss, consistent with the rest of the feature. The web run *enqueues* a `transcription_jobs` row
   (`status=pending`) and returns immediately. The worker processes it independently and writes back
   `status=done` + the transcript. The **next** manual run drains `done` jobs, drafts them, and includes them in
   that digest. The triggering run is never blocked by transcription.
3. **What happens when a video has no captions.** Two tiers. **Tier 1 (in the web run, cheap):** try YouTube's
   own captions (timedtext) with a short timeout. If present, we have a transcript instantly and draft it in the
   same run — this covers most government channels (auto-captions) and keeps timestamps. **Tier 2 (the
   worker):** no captions → enqueue for yt-dlp + Whisper. If the worker also can't get audio (private, removed,
   live not ended) → after `TRANSCRIBE_MAX_ATTEMPTS` the job is marked `failed`, logged, surfaced in job stats,
   and (optionally) a degraded `short_blurb` is drafted from title + description so the video is not lost. A
   failure never blocks or crashes a run.
4. **Per-run cost/time ceiling so one meeting-length video can't stall a digest.** The web run **never
   transcribes**. Its only added cost is bounded Tier-1 caption attempts (`AUTOMATION_MAX_CAPTION_FETCH_PER_RUN`,
   each ~10s timeout) and O(1) enqueues, so the digest run stays fast regardless of video length. All heavy work
   is in the worker, which enforces its own ceilings: `AUDIO_MAX_MINUTES` (skip/trim beyond),
   `TRANSCRIBE_JOB_TIMEOUT_SEC` (kill runaway jobs), `WORKER_CONCURRENCY` (default 1), and
   `TRANSCRIBE_MAX_ATTEMPTS`. A three-hour council meeting transcribes in the background and lands in a later
   digest; it cannot delay the one you triggered.

## Flow

```
┌── web run (POST /api/automation/run) ───────────────────────────────┐
│ 0. drain: transcription_jobs status=done  → draft (full_article) →   │
│           status=drafted → into THIS digest                          │
│ 1. youtube_channel handler:                                          │
│      resolveFeedUrl(channel) → new videos since last_checked_at      │
│      dedupe each video (seen_items, url_hash on video URL)           │
│      Tier 1: try captions (timedtext, capped, short timeout)         │
│        ├ got transcript → normalize → draft NOW → this digest        │
│        └ none → INSERT transcription_jobs(status=pending); no wait   │
│ 2. …other sources… → assemble digest → email → done (never blocks)   │
└─────────────────────────────────────────────────────────────────────┘
        (DB = queue)                         ▲ writes transcript
        ▼ claims pending                      │
┌── worker (separate Railway service, node worker.mjs) ───────────────┐
│ loop: claim one pending job (pending→processing, atomic)             │
│       yt-dlp audio → ffmpeg → Whisper → transcript (+timestamps)     │
│       success → status=done, transcript stored                       │
│       fail/timeout → attempts++, retry up to MAX, then status=failed │
└─────────────────────────────────────────────────────────────────────┘
```

**Why draft in the web process, not the worker:** all house-style/grounding/Anthropic logic stays in ONE place
(the web run, reusing the Slice 2 `full_article` prompt + stripper). The worker is a pure transcription service.
A transcript is just another `raw_text_or_transcript` feeding the existing normalized shape — Slice 4 adds no
new draft_type and reuses Slice 2 end to end.

## Data model (new table, design only)

```sql
create table if not exists transcription_jobs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  source_id     uuid,                 -- the youtube_channel source
  market        text default '',
  source_name   text default '',
  video_url     text not null,
  video_id      text default '',
  title         text default '',
  published_at  timestamptz,
  draft_type    text default 'full_article',
  status        text default 'pending',   -- pending|processing|done|failed|drafted
  transcript    text default '',
  transcript_source text default '',      -- 'captions' | 'whisper'
  error         text default '',
  attempts      int default 0,
  worker_id     text default '',
  claimed_at    timestamptz,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);
create unique index if not exists transcription_jobs_user_video on transcription_jobs (user_id, video_url);
```
The unique `(user_id, video_url)` index prevents double-enqueue across re-runs (idempotent, same principle as
`seen_items`). Video dedupe still records the video in `seen_items` at enqueue time so it is not re-processed.
Atomic claim: conditional update `pending → processing` guarded by `worker_id`/`claimed_at`; a stale
`processing` claim older than `TRANSCRIBE_JOB_TIMEOUT_SEC` is reclaimable.

## Env (design)

```
# Web run (Tier 1 captions)
AUTOMATION_ENABLE_CAPTIONS=true
AUTOMATION_MAX_CAPTION_FETCH_PER_RUN=10
AUTOMATION_MAX_VIDEOS_PER_RUN=20
# Worker (Tier 2)
WHISPER_MODE=local            # local (whisper.cpp/faster-whisper) | api
WHISPER_MODEL=base            # if local
WHISPER_API_KEY=...           # if api
YTDLP_PATH=yt-dlp
FFMPEG_PATH=ffmpeg
AUDIO_MAX_MINUTES=180
TRANSCRIBE_JOB_TIMEOUT_SEC=1800
WORKER_CONCURRENCY=1
WORKER_POLL_SECONDS=30
TRANSCRIBE_MAX_ATTEMPTS=3
```

## Timestamps (optional, note)

Both captions and Whisper can retain segment timestamps, enabling deep-linkable `?t=` URLs and the
per-agenda-item highlights the roadmap describes. Slice 4 can store timestamps but the minimal deliverable is
transcript text feeding a `full_article`. Highlights are a later slice.

## Build order within Slice 4 (once approved)

1. Schema (`transcription_jobs`) + `youtube_channel` handler with **Tier 1 captions only** + web-run drain step.
   This alone covers most government channels and needs **no worker** — smallest working slice.
2. Add the worker service (Docker image + `worker.mjs`) for Tier 2 yt-dlp + Whisper, with all ceilings.
3. Failure handling: degraded title/description blurb after `TRANSCRIBE_MAX_ATTEMPTS`, job stats in the digest
   footer ("N videos transcribing, M failed").

## Decisions to confirm before any code

- **A separate Railway worker service + a Docker image with yt-dlp/ffmpeg/Whisper is acceptable** (the first
  external service in this feature). If you'd rather stay single-service for now, the alternative is **Tier 1
  captions only** (no worker), which handles auto-captioned gov channels and defers Whisper — smaller, but
  caption-less videos would be skipped rather than transcribed.
- **`WHISPER_MODE`: local vs API.** Local = compute cost only, heavier image, slower on a small dyno. API =
  simpler image, per-minute cost, another key. Which?
- **Caption-less videos surfacing in a *later* digest (not the triggering run) is acceptable** — this is the
  non-blocking guarantee. Confirm that latency is fine given the manual cadence.
```
