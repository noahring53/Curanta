// ── Caption reachability probe ────────────────────────────────────────────────
// Answers one question: can THIS host download YouTube caption CONTENT, or is it
// IP/POT-gated? Run it on the host you care about (i.e. ON Railway, not via
// `railway run`, which executes locally). No dependencies, no API keys, read-only.
//
// Usage (on Railway — e.g. as a temporary start command, or a one-off exec):
//   node scripts/check-youtube-captions.mjs k1QWYk0UWdo
//   node scripts/check-youtube-captions.mjs "https://www.youtube.com/watch?v=k1QWYk0UWdo"
//
// It reuses the SAME extraction the handler uses, so a PASS here means the
// no-binary caption path will work in production; a FAIL (empty body) means
// Railway is gated and we move to yt-dlp captions-only.

import { extractBalancedJson, pickCaptionTrack, parseTimedText, formatTranscript } from '../lib/automation/captions.mjs';

const raw = process.argv[2];
if (!raw) { console.error('Pass a video id or watch URL.'); process.exit(1); }
const videoId = raw.includes('http') ? (new URL(raw).searchParams.get('v') || raw) : raw;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1; SOCS=CAI' };

console.log(`Probing caption reachability for video ${videoId}\n`);

const watch = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en&gl=US`, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
const html = await watch.text();
const consent = /consent\.youtube\.com|before you continue/i.test(html);
const pr = (() => { try { return JSON.parse(extractBalancedJson(html, 'ytInitialPlayerResponse') || 'null'); } catch { return null; } })();
const track = pickCaptionTrack(pr);

console.log(`watch page: http=${watch.status} consentWall=${consent} playerJSON=${Boolean(pr)} playability=${pr?.playabilityStatus?.status || '?'}`);
console.log(`caption track list: ${track ? `found ${track.languageCode}${track.kind === 'asr' ? ' (auto/asr)' : ''}` : 'NONE'}`);

if (!track) {
  console.log('\nVERDICT: no caption track advertised for this video (try a known-captioned Camden meeting video).');
  process.exit(2);
}

let reachable = false, sample = '';
for (const fmt of ['', '&fmt=srv1', '&fmt=srv3', '&fmt=json3']) {
  try {
    const r = await fetch(track.baseUrl + fmt, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
    const body = await r.text();
    const lines = parseTimedText(body);
    console.log(`  track fetch fmt="${fmt || '(default)'}": http=${r.status} bytes=${body.length} parsedCues=${lines ? lines.length : 0}`);
    if (lines && lines.length && !reachable) { reachable = true; sample = formatTranscript(lines.slice(0, 4)); }
  } catch (e) { console.log(`  track fetch fmt="${fmt || '(default)'}": ERROR ${e.message}`); }
}

console.log(`\nVERDICT: ${reachable ? 'PASS — captions ARE reachable from this host. Keep the no-binary path.' : 'FAIL — caption body is empty (this host is IP/POT-gated). Move to yt-dlp captions-only.'}`);
if (reachable) console.log(`\nfirst cues:\n${sample}`);
process.exit(reachable ? 0 : 1);
