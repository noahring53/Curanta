// ── Digest assembly ───────────────────────────────────────────────────────────
// Groups this run's new drafts by market → source, renders each paste-ready block
// (Markdown → inline-styled HTML, same approach as buildBeehiivHTML's fmt), and
// returns { subject, html }. No sending here — email.mjs does that.

// Minimal, safe Markdown → HTML: escape first, then insert our own tags. The
// draft bodies are the only Markdown we emit, so there is no literal HTML to
// preserve.
function fmt(md = '') {
  return String(md)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^#\s+(.*)$/gm, '<div style="font-size:17px;font-weight:700;margin:0 0 6px">$1</div>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:#6366f1;text-decoration:underline">$1</a>')
    .replace(/\n/g, '<br>');
}

function esc(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function tsLabel(d) {
  if (!d) return '';
  try {
    return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch { return ''; }
}

// drafts: rows from the `drafts` table (id, source_name, market, title, url,
// published_at, body_markdown). Grouped market → source, preserving input order.
export function buildDigest(drafts, { date = new Date() } = {}) {
  const n = drafts.length;
  const dateLabel = date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const subject = `Curanta digest — ${n} new ${n === 1 ? 'item' : 'items'} (${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`;

  // market → source_name → [drafts]
  const byMarket = new Map();
  for (const d of drafts) {
    const market = d.market || 'General';
    const src = d.source_name || 'Unknown source';
    if (!byMarket.has(market)) byMarket.set(market, new Map());
    const srcMap = byMarket.get(market);
    if (!srcMap.has(src)) srcMap.set(src, []);
    srcMap.get(src).push(d);
  }

  const blocks = [];
  for (const [market, srcMap] of byMarket) {
    blocks.push(`<h2 style="font-size:13px;text-transform:uppercase;letter-spacing:0.1em;color:#6366f1;margin:28px 0 4px">${esc(market)}</h2>`);
    for (const [src, list] of srcMap) {
      blocks.push(`<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#888;border-bottom:1px solid #e0e0e0;padding-bottom:4px;margin:16px 0 10px">${esc(src)}</div>`);
      for (const d of list) {
        const ts = tsLabel(d.published_at);
        blocks.push(
          `<div style="margin:0 0 20px;padding:0 0 16px;border-bottom:1px solid #f0f0f0">` +
          `<div style="font-size:15px;line-height:1.7;color:#1a1a1a">${fmt(d.body_markdown || '')}</div>` +
          (ts ? `<div style="font-size:11px;color:#aaa;margin-top:6px">${esc(ts)}</div>` : '') +
          `</div>`
        );
      }
    }
  }

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f7f7f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Georgia,serif">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f7f7f7"><tr><td align="center" style="padding:24px 16px">
<table width="640" cellpadding="0" cellspacing="0" border="0" style="background:#fff;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.08)"><tr><td style="padding:28px 32px">
  <div style="font-size:20px;font-weight:800">Curanta daily digest</div>
  <div style="font-size:12px;color:#888;margin-top:4px">${esc(dateLabel)} · ${n} paste-ready ${n === 1 ? 'draft' : 'drafts'}</div>
  <div style="font-size:12px;color:#aaa;margin-top:2px">Review, edit, and paste into Beehiiv. Nothing has been published.</div>
  <div style="margin-top:8px">${blocks.join('\n')}</div>
</td></tr></table>
</td></tr></table></body></html>`;

  return { subject, html };
}
