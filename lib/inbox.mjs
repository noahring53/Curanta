// ── Content Inbox ingestion ───────────────────────────────────────────────────
// Turns the operator's configured sources into a persistent, deduplicated inbox
// of candidate stories. The whole point is TOKEN EFFICIENCY: this pass fetches
// and normalizes feeds with ordinary code — no LLM touches an item here. The
// operator reviews the inbox and only THEN spends a model call, on the one story
// they choose to draft. Ingestion is idempotent: the store's unique (user,
// url_hash) index means re-running never creates a duplicate.

import { normalizeUrl } from './articles.mjs';

// Stable dedupe key for an item. The normalized URL is best (drops tracking
// params so the same story shared twice collapses); title is the fallback for
// the rare feed item with no link.
function itemHash(item) {
  const u = (item.url || '').trim();
  if (u) return normalizeUrl(u);
  return 'title:' + (item.title || '').trim().toLowerCase().slice(0, 200);
}

/**
 * Ingest one source into the inbox. Returns { fetched, added, skipped, error }.
 * Never throws — a dead feed reports an error and the batch moves on.
 */
export async function ingestSourceToInbox(source, { ingestUrl, store }) {
  const stat = { sourceId: source.id, title: source.title || source.feed_url, fetched: 0, added: 0, skipped: 0, error: '' };
  try {
    const result = await ingestUrl(source.feed_url, { quick: true });
    const items = result.articles || [];
    stat.fetched = items.length;
    for (const item of items) {
      if (!item.url && !item.title) continue;
      const res = store.upsertInboxItem({
        url_hash: itemHash(item),
        title: (item.title || 'Untitled').slice(0, 400),
        url: item.url || '',
        preview: (item.summary || '').slice(0, 500),
        source_title: result.source || source.title || '',
        source_id: source.id || null,
        publication_id: source.publication_id ?? null,
        published_at: item.publishedAt || null,
        status: 'new',
      });
      if (res.inserted) stat.added++; else stat.skipped++;
    }
  } catch (e) {
    stat.error = e.message || 'ingest failed';
  }
  return stat;
}

/**
 * Ingest every active source for the operator. Sources are read from the store,
 * fed through the shared ingestion core, and their health (last checked / last
 * error) is written back so the Sources and Inbox views can show feed status.
 */
export async function refreshInbox({ ingestUrl, store, publicationId = null, sourceId = null }) {
  const all = store.runQuery({
    table: 'sources', action: 'select',
    filters: [{ col: 'user_id', op: 'eq', val: store.LOCAL_USER.id }],
  }).data || [];

  let sources = all;
  if (sourceId) sources = sources.filter(s => s.id === sourceId);
  else if (publicationId !== null && publicationId !== '__all__') {
    sources = sources.filter(s => (s.publication_id ?? null) === publicationId);
  }

  const perSource = [];
  const totals = { sources: sources.length, fetched: 0, added: 0, skipped: 0, errors: 0 };

  for (const source of sources) {
    const stat = await ingestSourceToInbox(source, { ingestUrl, store });
    perSource.push(stat);
    totals.fetched += stat.fetched;
    totals.added += stat.added;
    totals.skipped += stat.skipped;
    if (stat.error) totals.errors++;
    // Write feed health back onto the source row.
    store.runQuery({
      table: 'sources', action: 'update',
      filters: [{ col: 'id', op: 'eq', val: source.id }],
      values: { last_checked_at: new Date().toISOString(), last_error: stat.error || '' },
    });
  }

  return { totals, perSource, ranAt: new Date().toISOString() };
}

// ── Routes ────────────────────────────────────────────────────────────────────
export function registerInboxRoutes(app, { ingestUrl, store, limiter = (_q, _s, next) => next() }) {
  // Manual "Refresh all sources" (and per-source refresh). This is the trigger
  // the DoD calls for — no cron required; the operator (or an optional interval)
  // decides when to pull. Reading a feed is cheap; only drafting costs tokens.
  app.post('/api/inbox/refresh', limiter, async (req, res) => {
    const { publicationId = null, sourceId = null } = req.body || {};
    try {
      const out = await refreshInbox({ ingestUrl, store, publicationId, sourceId });
      return res.json(out);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });
}
