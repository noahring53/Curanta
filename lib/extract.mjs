// ── Structured article extraction ─────────────────────────────────────────────
// Garbage in, garbage out: every downstream research pass is bounded by how
// faithfully we recover the article. The previous extractor called .text() on a
// content div and collapsed all whitespace, which flattened headings, paragraph
// breaks, blockquotes, lists, and captions into one undifferentiated run-on
// string. A researcher reading that cannot tell a pull-quote from a photo
// caption from a subhead — so it treated promotional boilerplate as reporting
// and lost the article's own chronology and emphasis.
//
// This walks the content tree instead and emits TYPED BLOCKS, then serialises
// them to a markdown-ish document that preserves structure the model can reason
// over. No model call — this is pure parsing, and it is the cheapest quality
// win in the pipeline.

// Containers that never hold article prose.
const JUNK_SELECTOR = [
  'nav', 'header', 'footer', 'aside', 'script', 'style', 'noscript', 'iframe',
  'template', 'form', 'button', 'svg', 'audio', 'video',
  '.nav', '.navbar', '.header', '.footer', '.sidebar', '.menu',
  '.ad', '.ads', '.advertisement', '.banner', '.sponsored', '.promo',
  '.social-share', '.share-buttons', '.share-bar', '.sharing',
  '[class*="social-"]', '[class*="-share"]', '[class*="share-"]',
  '[class*="subscribe"]', '[class*="newsletter"]', '[class*="paywall"]',
  '[class*="cookie"]', '[class*="consent"]', '[class*="gdpr"]', '[class*="popup"]',
  '[class*="related"]', '[class*="recommended"]', '[class*="more-stories"]',
  '[class*="most-read"]', '[class*="trending"]', '[class*="outbrain"]', '[class*="taboola"]',
  '[class*="comment"]', '[class*="discussion"]', '[class*="modal"]', '[class*="overlay"]',
  '[class*="listen-to"]', '[class*="text-to-speech"]', '[class*="breadcrumb"]',
  '.byline-image', '.author-image', '.author-bio',
  '[aria-hidden="true"]', '[role="navigation"]', '[role="banner"]', '[role="complementary"]',
].join(',');

// Lines that are furniture rather than reporting. Matched against a whole block,
// so a sentence merely CONTAINING "subscribe" survives — only blocks that ARE
// the promo get dropped.
const BOILERPLATE = [
  /^advertisement$/i,
  /^sponsored(\s+content)?$/i,
  /^(sign up|subscribe|log ?in|register)\b/i,
  /^(read|see|learn) more\b/i,
  /^(related|also read|more on this|you may also like|recommended)\b[:.]?/i,
  /^(share|follow|tweet|email) (this|us|on)\b/i,
  /^(photo|image|credit|source|illustration)\s*[:|]/i,
  /^(getty|reuters|associated press|ap photo|afp|shutterstock)\b/i,
  /^copyright\b/i,
  /^all rights reserved/i,
  /^this (article|story) (was|first) (published|appeared)/i,
  /^(updated|published)\s*[:|]?\s*$/i,
  /^\d+\s*(min|minute)s?\s*read$/i,
  /^by\s+[\w.\- ]{2,40}$/i, // standalone byline — captured separately
  /^support (our|independent)\b/i,
  /^get the (latest|best)\b/i,
  /^enable javascript/i,
  /^please (enable|disable)\b/i,
];

const isBoilerplate = (text) => {
  const t = text.trim();
  if (!t) return true;
  return BOILERPLATE.some(re => re.test(t));
};

const CONTENT_SELECTORS = [
  'article [class*="article-body"]', 'article [class*="story-body"]',
  'article [class*="content"]', 'article [class*="body"]',
  '[itemprop="articleBody"]', '.article-body', '.article__body', '.article-content',
  '.article__content', '.story-body', '.story-content', '.post-body', '.post-content',
  '.post__content', '.entry-content', '.content-body', '#article-body', '#main-content',
  '.body-copy', '.body-text',
  'article',
  '[role="main"] [class*="content"]', '[role="main"] [class*="body"]', '[role="main"]',
  'main [class*="article"]', 'main [class*="story"]', 'main [class*="content"]', 'main',
];

// Walks a content root and emits typed blocks in document order.
function collectBlocks($, root) {
  const blocks = [];
  const seen = new Set();

  const push = (type, text, extra = {}) => {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean || clean.length < 2) return;
    if (isBoilerplate(clean)) return;
    // Sites repeat the same promo/caption in multiple wrappers — dedupe on the
    // normalised text so the model doesn't see a fact three times and weight it
    // as three independent confirmations.
    const key = `${type}:${clean.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    blocks.push({ type, text: clean, ...extra });
  };

  root.find('h1, h2, h3, h4, p, blockquote, q, ul, ol, figcaption, pre, table').each((_, el) => {
    const $el = $(el);
    // Skip nodes nested inside a block we'll already capture whole (list items
    // inside <ul>, paragraphs inside <blockquote>).
    if ($el.parents('blockquote, ul, ol, table').length) return;
    const tag = el.tagName?.toLowerCase();

    if (/^h[1-4]$/.test(tag)) {
      push('heading', $el.text(), { level: Number(tag[1]) });
    } else if (tag === 'blockquote' || tag === 'q') {
      push('quote', $el.text());
    } else if (tag === 'ul' || tag === 'ol') {
      const items = $el.children('li').map((_, li) => $(li).text().replace(/\s+/g, ' ').trim()).get()
        .filter(t => t && !isBoilerplate(t));
      if (items.length) push('list', items.join('\n'), { ordered: tag === 'ol', items });
    } else if (tag === 'figcaption') {
      // Captions carry real facts (names, places, dates) often found nowhere
      // else, so they are kept — but TYPED, so the model never mistakes a
      // caption for reported body prose.
      push('caption', $el.text());
    } else if (tag === 'table') {
      const rows = $el.find('tr').map((_, tr) =>
        $(tr).find('th, td').map((_, c) => $(c).text().replace(/\s+/g, ' ').trim()).get().join(' | ')
      ).get().filter(Boolean);
      // Rows ride in `extra` because push() normalises whitespace on `text`,
      // which would collapse a multi-row table into a single unreadable line.
      if (rows.length) push('table', rows.join(' ; '), { rows });
    } else if (tag === 'pre') {
      push('para', $el.text());
    } else {
      push('para', $el.text());
    }
  });

  return blocks;
}

// Serialises typed blocks into a compact structured document. Markdown-ish
// because models reason well over it and it costs almost no extra tokens.
function blocksToMarkdown(blocks, limit) {
  const out = [];
  let used = 0;
  for (const b of blocks) {
    let piece;
    if (b.type === 'heading')      piece = `\n${'#'.repeat(Math.min(b.level || 2, 4))} ${b.text}\n`;
    else if (b.type === 'quote')   piece = `> ${b.text}`;
    else if (b.type === 'list')    piece = (b.items || b.text.split('\n')).map(i => `- ${i}`).join('\n');
    else if (b.type === 'caption') piece = `[caption] ${b.text}`;
    else if (b.type === 'table')   piece = (b.rows || [b.text]).map(r => `| ${r} |`).join('\n');
    else                           piece = b.text;

    if (used + piece.length > limit) break;
    out.push(piece);
    used += piece.length + 2;
  }
  return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Picks the densest plausible content root. Scores by prose volume rather than
// raw text length so nav-heavy wrappers lose to real article bodies.
function pickRoot($) {
  let best = null, bestScore = 0;
  for (const sel of CONTENT_SELECTORS) {
    const el = $(sel).first();
    if (!el.length) continue;
    const paraChars = el.find('p').text().replace(/\s+/g, ' ').trim().length;
    const totalChars = el.text().replace(/\s+/g, ' ').trim().length;
    if (totalChars < 200) continue;
    // Density guards against picking a wrapper that is mostly links/furniture.
    const density = paraChars / Math.max(totalChars, 1);
    const score = paraChars * (0.4 + 0.6 * density);
    if (score > bestScore) { bestScore = score; best = el; }
  }
  return best;
}

/**
 * Parse a loaded cheerio document into a structured article.
 * Returns { markdown, blocks, wordCount, byline, publishedAt, structured }.
 * `publishedAt` is null when the page does not state one — never guessed.
 */
export function extractStructuredArticle($, url, { limit = 20000 } = {}) {
  $(JUNK_SELECTOR).remove();

  const root = pickRoot($) || $('body');
  let blocks = collectBlocks($, root);

  // Fall back to the whole body if the chosen root yielded almost nothing.
  if (blocks.filter(b => b.type === 'para').length < 2) {
    const bodyBlocks = collectBlocks($, $('body'));
    if (bodyBlocks.length > blocks.length) blocks = bodyBlocks;
  }

  const markdown = blocksToMarkdown(blocks, limit);
  const proseText = blocks.filter(b => b.type === 'para').map(b => b.text).join(' ');

  // Byline: prefer explicit metadata, then common author markup.
  const byline =
    $('meta[name="author"]').attr('content') ||
    $('[rel="author"]').first().text().trim() ||
    $('[class*="byline"]').first().text().replace(/\s+/g, ' ').replace(/^by\s+/i, '').trim() ||
    $('[itemprop="author"]').first().text().replace(/\s+/g, ' ').trim() ||
    '';

  // NEVER default to "now". A fabricated publication date corrupts every
  // downstream chronology and recency judgement; unknown must stay unknown.
  const publishedAt =
    $('meta[property="article:published_time"]').attr('content') ||
    $('meta[itemprop="datePublished"]').attr('content') ||
    $('time[datetime]').first().attr('datetime') ||
    null;

  const modifiedAt =
    $('meta[property="article:modified_time"]').attr('content') || null;

  return {
    markdown,
    blocks,
    wordCount: proseText.split(/\s+/).filter(Boolean).length,
    byline: byline.slice(0, 120),
    publishedAt,
    modifiedAt,
    structured: blocks.some(b => b.type === 'heading' || b.type === 'quote' || b.type === 'list'),
    counts: blocks.reduce((acc, b) => { acc[b.type] = (acc[b.type] || 0) + 1; return acc; }, {}),
  };
}
