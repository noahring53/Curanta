// ── Handler: rss ──────────────────────────────────────────────────────────────
// Fetches feed items newer than the source's last_checked_at and normalizes them.
// Fetch depth depends on the source's draft_type:
//   link_roundup / short_blurb → RSS snippet only. For link_roundup this is also
//     the copyright boundary: we never scrape and reproduce a third-party article.
//   full_article → hydrate the real full source text (bounded), because the writer
//     must work from the document, not the teaser. These are sources the operator
//     controls the framing on (civic/meeting/release feeds).
// resolveFeedUrl / assertSafeUrl / fetchArticle arrive as deps so this handler
// reuses the server's plumbing without importing it.

import Parser from 'rss-parser';
import { toNormalizedItem } from '../normalize.mjs';

const parser = new Parser({ timeout: 15000 });

const stripHtml = (s = '') => String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

const MAX_ITEMS_PER_FEED = 40;
const HYDRATE_MAX = 12; // cap full-text fetches per run for full_article feeds

export async function fetchNew(source, { since, deps }) {
  const { resolveFeedUrl, assertSafeUrl, fetchArticle } = deps;

  await assertSafeUrl(source.feed_url);
  const resolved = await resolveFeedUrl(source.feed_url);
  if (resolved.url !== source.feed_url) await assertSafeUrl(resolved.url);

  const feed = await parser.parseURL(resolved.url);
  const sinceMs = since ? new Date(since).getTime() : 0;

  const items = [];
  for (const item of (feed.items || []).slice(0, MAX_ITEMS_PER_FEED)) {
    const publishedAt = item.isoDate || item.pubDate || null;
    const pubMs = publishedAt ? new Date(publishedAt).getTime() : 0;
    // Only items newer than the last run. If a feed has no usable date, let it
    // through — dedupe (seen_items) is the real safety net.
    if (sinceMs && pubMs && pubMs <= sinceMs) continue;

    const summary = stripHtml(
      item.contentSnippet || item.summary || item.content || item['content:encodedSnippet'] || ''
    ).slice(0, 500);

    items.push(toNormalizedItem({
      source,
      title: item.title || 'Untitled',
      url: item.link || '',
      publishedAt,
      body: summary,
    }));
  }

  // full_article needs the real document. Hydrate full text for the items we'll
  // draft, bounded, and keep the snippet on any that fail (the grounding prompt
  // handles a thin source and will add an EDITOR NOTE rather than invent).
  if (source.draft_type === 'full_article' && typeof fetchArticle === 'function') {
    let hydrated = 0;
    for (const it of items) {
      if (hydrated >= HYDRATE_MAX) break;
      if (!it.url) continue;
      hydrated++;
      try {
        const full = await fetchArticle(it.url);
        if (full?.text && full.text.length > (it.raw_text_or_transcript || '').length) {
          it.raw_text_or_transcript = full.text;
        }
      } catch (e) {
        console.warn(`[automation:rss] full-text hydrate failed for ${it.url}: ${e.message}`);
      }
    }
  }

  return items;
}
