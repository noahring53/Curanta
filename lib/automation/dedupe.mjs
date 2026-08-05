// ── Dedupe = idempotency ──────────────────────────────────────────────────────
// url_hash carries a unique index, so an insert conflict on it means "already
// seen" and the whole run becomes safe to re-invoke. title_hash catches the same
// story from a second feed under a different URL, checked first because a single
// insert can only be driven by one unique index.

import crypto from 'node:crypto';
import { normalizeUrl, normalizeTitle } from './normalize.mjs';
import * as db from './supabase.mjs';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export const hashUrl = (url = '') => sha(normalizeUrl(url));
export const hashTitle = (title = '') => sha(normalizeTitle(title));

/**
 * Record an item in seen_items if it is new. Returns { isNew, url_hash }.
 * isNew === false means it was already there (skip drafting it).
 *
 * Feed items dedupe on url + title. Change-watch items (event_page) instead carry
 * an explicit `dedupe_key` that folds in a content hash, so an UNCHANGED page keys
 * to the same value (seen → skip) and a CHANGED page keys to a new value
 * (new → draft). The seen_items ledger doubles as the "last content" store — no
 * extra column, and re-runs stay idempotent for both kinds.
 */
export async function claimIfNew({ userId, item }) {
  const key = item.dedupe_key || null;
  const url_hash = key ? sha(key) : hashUrl(item.url);
  const title_hash = key ? url_hash : hashTitle(item.title);

  // Same-title-from-another-feed guard applies to feed items only; a change-watch
  // item is already fully identified by its content-bearing key.
  if (!key) {
    const byTitle = await db.select('seen_items', `user_id=eq.${userId}&title_hash=eq.${title_hash}&limit=1`);
    if (byTitle.length) return { isNew: false, url_hash };
  }

  // Insert-on-conflict(url_hash): a duplicate returns [] instead of the row.
  const inserted = await db.insertIgnore('seen_items', {
    user_id: userId,
    source_id: item.source_id,
    market: item.market,
    url_hash,
    title_hash,
    url: item.url,
    title: item.title,
    published_at: item.published_at,
  }, 'user_id,url_hash');

  return { isNew: inserted.length > 0, url_hash };
}
