// ── Handler registry: source.type → handler ──────────────────────────────────
// Adding a source TYPE = adding one module and one line here. All three v1 types
// are wired: rss (Slice 1), event_page (Slice 3), youtube_channel (Slice 4,
// Tier-1 captions). An unknown type logs "no handler" and is skipped.

import * as rss from './rss.mjs';
import * as event_page from './event_page.mjs';
import * as youtube_channel from './youtube_channel.mjs';

export const handlers = { rss, event_page, youtube_channel };

export function getHandler(type) {
  return handlers[type] || null;
}
