// ── Handler: youtube_channel (Tier 1 captions only) ───────────────────────────
// Resolves the channel to its videos RSS (reusing resolveFeedUrl), takes recent
// videos, and pulls YouTube's own captions for each. A captioned video becomes a
// normalized item whose raw_text_or_transcript is the timestamped transcript,
// flagged low_fidelity (machine captions). A caption-less video is cleanly
// DEFERRED: emit nothing, do not mark it seen, so a later run retries it once the
// auto-captions have processed. yt-dlp + Whisper for permanently caption-less
// sources is a documented later add (see docs/automation-slice4-worker-design.md),
// intentionally not built here.
//
// A lookback window (not last_checked_at) governs eligibility, because deferral
// requires a video to remain visible across runs until it either gets captions or
// ages out. Dedupe (seen_items, keyed on the video URL) stops a captioned video
// being drafted twice.

import Parser from 'rss-parser';
import { toNormalizedItem } from '../normalize.mjs';
import { fetchCaptions as realFetchCaptions, formatTranscript } from '../captions.mjs';

const parser = new Parser({ timeout: 15000 });

const LOOKBACK_HOURS = Number(process.env.AUTOMATION_YT_LOOKBACK_HOURS || 72);
const MAX_VIDEOS = Number(process.env.AUTOMATION_MAX_VIDEOS_PER_RUN || 20);
const MAX_CAPTION_FETCH = Number(process.env.AUTOMATION_MAX_CAPTION_FETCH_PER_RUN || 10);

function videoIdFrom(item) {
  if (item['yt:videoId']) return item['yt:videoId'];
  const m = String(item.id || '').match(/video:([\w-]+)/);
  if (m) return m[1];
  try { return new URL(item.link).searchParams.get('v') || ''; } catch { return ''; }
}

export async function fetchNew(source, { deps }) {
  const { resolveFeedUrl, assertSafeUrl } = deps;
  const fetchCaptions = deps.fetchCaptions || realFetchCaptions;

  await assertSafeUrl(source.feed_url);
  const resolved = await resolveFeedUrl(source.feed_url);
  if (resolved.url !== source.feed_url) await assertSafeUrl(resolved.url);
  const feed = await parser.parseURL(resolved.url);

  const cutoff = Date.now() - LOOKBACK_HOURS * 3600 * 1000;
  const candidates = (feed.items || [])
    .map((it) => ({ it, pub: new Date(it.isoDate || it.pubDate || 0).getTime() }))
    .filter((x) => !x.pub || x.pub >= cutoff)   // within lookback (or undated)
    .slice(0, MAX_VIDEOS);

  const items = [];
  let capFetches = 0;
  for (const { it } of candidates) {
    if (capFetches >= MAX_CAPTION_FETCH) break;
    const vid = videoIdFrom(it);
    if (!vid) continue;
    capFetches++;

    let cap = null;
    try {
      cap = await fetchCaptions(vid, { assertSafeUrl });
    } catch (e) {
      console.warn(`[automation:youtube] caption fetch errored for ${vid}: ${e.message}`);
    }

    if (!cap || !cap.lines?.length) {
      // Caption-less (or not processed yet) → defer cleanly. No item, not marked
      // seen, so a later run retries it while it stays in the lookback window.
      console.log(`[automation:youtube] no captions yet for ${vid} — deferred`);
      continue;
    }

    items.push(toNormalizedItem({
      source,
      title: it.title || 'Untitled video',
      url: it.link || `https://www.youtube.com/watch?v=${vid}`,
      publishedAt: it.isoDate || it.pubDate || null,
      body: formatTranscript(cap.lines),
      lowFidelity: true, // machine-generated captions
    }));
  }
  return items;
}
