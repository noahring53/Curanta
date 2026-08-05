// ── YouTube caption fetch (Tier 1, no worker) ─────────────────────────────────
// Pulls YouTube's OWN captions for a video and returns timestamped segments. This
// is the "no new runtime" path: it fetches the watch page, reads the caption track
// list out of ytInitialPlayerResponse, and downloads the timedtext track. It keeps
// timestamps so a draft can cite [mm:ss] and a later slice can build ?t= deep
// links. yt-dlp + Whisper (for caption-less videos) is a documented later add and
// is deliberately NOT here.
//
// The parsing helpers are pure and unit-tested; only fetchCaptions does network.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// From a datacenter IP, YouTube serves a consent wall whose HTML has no player
// response (so captions look absent even when they exist). Pre-accepting consent
// via these cookies + gl=US returns the real watch page. Found the hard way: the
// Camden County channel's videos have en(asr) captions that only appear with this.
const CONSENT_HEADERS = {
  'User-Agent': UA,
  'Accept-Language': 'en-US,en;q=0.9',
  Cookie: 'CONSENT=YES+1; SOCS=CAI',
};

export function decodeEntities(s = '') {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

export function mmss(sec = 0) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
}

// Balanced-brace extraction: the greedy-regex approach breaks on the huge nested
// player JSON. Walk from the marker's first "{" tracking string/escape state.
export function extractBalancedJson(html, marker) {
  const i = String(html).indexOf(marker);
  if (i < 0) return null;
  const start = html.indexOf('{', i);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let j = start; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return html.slice(start, j + 1); }
  }
  return null;
}

// Prefer a human English track, then English auto-captions (asr), then anything.
export function pickCaptionTrack(playerResponse) {
  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks) || !tracks.length) return null;
  return tracks.find((t) => /^en/i.test(t.languageCode || '') && t.kind !== 'asr')
      || tracks.find((t) => /^en/i.test(t.languageCode || ''))
      || tracks[0];
}

// Parse a timedtext response into [{ t, txt }]. Handles srv1 (<text start dur>)
// and the srv3 (<p t d><s>) shapes.
export function parseTimedText(xml = '') {
  const out = [];
  for (const m of String(xml).matchAll(/<text[^>]*\bstart="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g)) {
    const t = Number(m[1]);
    const txt = decodeEntities(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (txt) out.push({ t, txt });
  }
  if (out.length) return out;
  for (const m of String(xml).matchAll(/<p[^>]*\bt="(\d+)"[^>]*>([\s\S]*?)<\/p>/g)) {
    const t = Number(m[1]) / 1000;
    const txt = decodeEntities(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (txt) out.push({ t, txt });
  }
  return out.length ? out : null;
}

export function formatTranscript(lines) {
  if (!lines || !lines.length) return '';
  return lines.map((l) => `[${mmss(l.t)}] ${l.txt}`).join('\n');
}

/**
 * Fetch captions for a video id. Returns { lines, kind, lang } or null when the
 * video has no captions (the caller then defers it cleanly). Never throws for a
 * missing-captions case — only genuine network errors propagate.
 */
export async function fetchCaptions(videoId, { assertSafeUrl = async () => {} } = {}) {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}&hl=en&gl=US`;
  await assertSafeUrl(watchUrl);
  const res = await fetch(watchUrl, { headers: CONSENT_HEADERS, signal: AbortSignal.timeout(12000) });
  const html = await res.text();

  const raw = extractBalancedJson(html, 'ytInitialPlayerResponse');
  if (!raw) return null;
  let pr;
  try { pr = JSON.parse(raw); } catch { return null; }

  const track = pickCaptionTrack(pr);
  if (!track?.baseUrl) return null;
  const meta = { kind: track.kind === 'asr' ? 'asr' : 'manual', lang: track.languageCode || '' };

  for (const suffix of ['', '&fmt=srv1']) {
    try {
      const url = track.baseUrl + suffix;
      await assertSafeUrl(url);
      const r = await fetch(url, { headers: CONSENT_HEADERS, signal: AbortSignal.timeout(12000) });
      const lines = parseTimedText(await r.text());
      if (lines && lines.length) return { lines, ...meta };
    } catch { /* try next format */ }
  }
  return null;
}
