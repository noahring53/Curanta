// ── The normalization boundary ───────────────────────────────────────────────
// Every handler's output crosses through here into ONE shape. Nothing downstream
// (dedupe, prompts, digest) is allowed to know or care what source `type` an item
// came from — that is the whole point. `normalizeUrl` is reused from the existing
// single-source article module so a URL deduped here matches one deduped there.

import { normalizeUrl } from '../articles.mjs';

export { normalizeUrl };

// Title dedupe key: lowercase, strip everything but alphanumerics, collapse
// whitespace. Catches the same story arriving from a second feed with a different
// URL and cosmetic title punctuation differences.
export function normalizeTitle(t = '') {
  return String(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

/**
 * The one shape. `draft_type` rides along from the source row so the drafting
 * step never has to look the source up again. `dedupeKey` is optional: feed items
 * omit it (dedupe falls back to url + title), change-watch items pass a
 * content-bearing key so a changed page reads as new and an unchanged one as seen.
 * `lowFidelity` marks machine-transcribed sources (YouTube captions) so the
 * drafting step can lower its trust in exact wording. Both are drafting-relevant
 * metadata, not the source TYPE, so the normalization boundary still holds.
 * @returns {{source_id, source_name, market, title, url, published_at, raw_text_or_transcript, draft_type, dedupe_key?, low_fidelity?}}
 */
export function toNormalizedItem({ source, title, url, publishedAt, body, dedupeKey = null, lowFidelity = false }) {
  const item = {
    source_id: source.id,
    source_name: source.title || '',
    market: source.market || '',
    title: String(title || '').trim(),
    url: url || '',
    published_at: publishedAt || null,
    raw_text_or_transcript: body || '',
    draft_type: source.draft_type || 'link_roundup',
  };
  if (dedupeKey) item.dedupe_key = dedupeKey;
  if (lowFidelity) item.low_fidelity = true;
  return item;
}
