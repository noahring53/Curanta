// ── Dry-run previewer for automation drafts ───────────────────────────────────
// Fetches a feed, hydrates full text for full_article, drafts each item with the
// REAL automation prompts + house-style stripper, and prints the drafts. No DB,
// no email, nothing persisted — just so you can eyeball draft quality (grounding,
// house style, {market} Angle) before enabling the pipeline.
//
// Needs ANTHROPIC_API_KEY in your .env (this makes real, billed model calls).
//
// Usage:
//   node scripts/preview-automation-draft.mjs --feed <rss-url> --type full_article --market Camden --count 2
//   node scripts/preview-automation-draft.mjs --feed <rss-url> --type short_blurb  --market Camden --count 3
//   node scripts/preview-automation-draft.mjs --stype youtube_channel --feed <channel-or-feed-url> --type full_article --market Camden --count 1
//
// --type  (draft_type): full_article | short_blurb | link_roundup   (default full_article)
// --stype (source type): rss | event_page | youtube_channel         (default rss)
// youtube_channel pulls captions inline; caption-less videos are skipped/deferred.

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { load } from 'cheerio';
import { extractStructuredArticle } from '../lib/extract.mjs';
import { getHandler } from '../lib/automation/handlers/index.mjs';
import { selectDraftPrompt, buildUserPrompt, stripHouseStyle, hasStyleViolation } from '../lib/automation/prompts.mjs';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};

const feed = arg('feed');
const type = arg('type', 'full_article');   // full_article | short_blurb | link_roundup
const stype = arg('stype', type === 'full_article' ? 'rss' : 'rss'); // source type: rss | event_page | youtube_channel
const market = arg('market', 'Camden');
const count = Number(arg('count', '2'));

if (!feed) { console.error('Pass --feed <rss url or channel/page url>'); process.exit(1); }
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) { console.error('ANTHROPIC_API_KEY not set (add it to .env). This script makes real model calls.'); process.exit(1); }

const anthropic = new Anthropic({ apiKey });
const model = process.env.ANTHROPIC_MODEL_LEAD || process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function fetchArticleReal(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
  const p = extractStructuredArticle(load(await r.text()), url);
  return { text: p.markdown || '', wordCount: p.wordCount, publishedAt: p.publishedAt, title: p.title };
}

// Minimal resolver so the previewer accepts a YouTube channel/@handle/playlist URL
// (mirrors the server's resolveFeedUrl for the youtube cases; passthrough otherwise).
async function resolveFeedUrl(rawUrl) {
  let u; try { u = new URL(rawUrl); } catch { return { url: rawUrl, kind: 'rss' }; }
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
  if (host === 'youtube.com') {
    if (u.pathname.startsWith('/feeds/')) return { url: rawUrl, kind: 'youtube' };
    const list = u.searchParams.get('list');
    if (list && !u.pathname.startsWith('/watch')) return { url: `https://www.youtube.com/feeds/videos.xml?playlist_id=${list}`, kind: 'youtube' };
    const chan = u.pathname.match(/^\/channel\/(UC[\w-]+)/);
    if (chan) return { url: `https://www.youtube.com/feeds/videos.xml?channel_id=${chan[1]}`, kind: 'youtube' };
    if (/^\/(@[\w.-]+|c\/[^/]+|user\/[^/]+)/.test(u.pathname)) {
      const pagePath = u.pathname.split('/').slice(0, u.pathname.startsWith('/@') ? 2 : 3).join('/');
      const html = await (await fetch(`https://www.youtube.com${pagePath}`, { headers: { 'User-Agent': UA } })).text();
      const id = html.match(/"externalId":"(UC[\w-]+)"/) || html.match(/channel\/(UC[\w-]+)"/);
      if (id) return { url: `https://www.youtube.com/feeds/videos.xml?channel_id=${id[1]}`, kind: 'youtube' };
      throw new Error('Could not resolve that YouTube channel. Try its /channel/UC… or feeds/videos.xml URL.');
    }
  }
  return { url: rawUrl, kind: 'rss' };
}

const deps = { resolveFeedUrl, assertSafeUrl: async () => {}, fetchArticle: fetchArticleReal };
const source = { id: 'preview', feed_url: feed, title: new URL(feed).hostname.replace(/^www\./, ''), market, draft_type: type, status: 'active', last_checked_at: null };

const handler = getHandler(stype);
if (!handler) { console.error(`No handler for source type "${stype}" (use rss | event_page | youtube_channel).`); process.exit(1); }

console.log(`Feed: ${feed}\nSource type: ${stype} | Draft type: ${type} | Market: ${market} | Model: ${model}\n`);
const items = (await handler.fetchNew(source, { since: null, deps })).slice(0, count);
if (!items.length) { console.error('No draftable items (a youtube_channel with no captioned videos in the lookback window will be empty).'); process.exit(1); }

for (const [i, it] of items.entries()) {
  const { system, maxTokens, temperature } = selectDraftPrompt(it.draft_type, { market, lowFidelity: it.low_fidelity });
  const user = buildUserPrompt(it);
  const msg = await anthropic.messages.create({ model, max_tokens: maxTokens, temperature, system, messages: [{ role: 'user', content: user }] });
  const raw = msg.content[0].text;
  const clean = stripHouseStyle(raw);
  console.log(`\n${'='.repeat(74)}\nDRAFT ${i + 1}/${items.length}  [${it.draft_type}${it.low_fidelity ? ', captions/low-fidelity' : ''}]  source chars: ${(it.raw_text_or_transcript || '').length}\n${it.title}\n${it.url}\n${'='.repeat(74)}`);
  console.log(clean);
  const fired = /[—–;]/.test(raw) && !/[—–;]/.test(clean);
  console.log(`\n[stripper fired: ${fired ? 'yes — model emitted an em dash/semicolon, cleaned' : 'no — model wrote clean copy'} | violations remaining: ${hasStyleViolation(clean) ? 'YES (bug)' : 'none'}]`);
}
