// ── Handler: event_page ───────────────────────────────────────────────────────
// For sources without a feed: an event listing, a civic calendar, a "notices"
// page. We fetch the page's extracted text, hash it, and let dedupe decide:
//   unchanged page → same content hash → seen → skip
//   changed page   → new content hash  → new  → drafted
// The seen_items ledger is the "last content" store, so there is no per-source
// hash column and re-runs stay idempotent. This is the v1 hash-diff: it detects
// THAT a page changed and drafts from its current content. Line-level "what
// changed" diffing is the later changedetection.io upgrade (roadmap Phase 2).
//
// Text (not raw HTML) is hashed via the shared extractor, so a rotating ad, a
// changing timestamp in the chrome, or reordered nav does not read as a change.

import crypto from 'node:crypto';
import { toNormalizedItem, normalizeUrl } from '../normalize.mjs';

// Collapse whitespace so cosmetic reflow (extra blank lines, trailing spaces)
// is not mistaken for a content change.
const normalizeText = (s = '') => String(s).replace(/\s+/g, ' ').trim();

export async function fetchNew(source, { deps }) {
  const { assertSafeUrl, fetchArticle } = deps;

  await assertSafeUrl(source.feed_url);
  const page = await fetchArticle(source.feed_url);

  const text = normalizeText(page.text || '');
  if (!text) return []; // nothing extractable — do not report a phantom change

  const contentHash = crypto.createHash('sha256').update(text).digest('hex');
  const dedupeKey = `event_page::${normalizeUrl(source.feed_url)}::${contentHash}`;

  return [toNormalizedItem({
    source,
    title: page.title || source.title || 'Page update',
    url: source.feed_url,
    publishedAt: page.publishedAt || new Date().toISOString(), // detection time if the page has none
    body: page.text || '',
    dedupeKey,
  })];
}
