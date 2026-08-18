// ── Email digest (Resend) ─────────────────────────────────────────────────────
// Delivers finished Auto-Draft articles to the operator's inbox so the whole
// loop is hands-off: sources → draft → email. Raw Resend REST via fetch (no new
// npm dependency), matching the app's Beehiiv/Supabase style. The key is read at
// call time so import order never matters, and nothing here throws into the
// automation cycle — the caller wraps sends in try/catch.

export function emailConfigured() {
  return Boolean(process.env.RESEND_API_KEY);
}

// Who the digest goes to / comes from. TO defaults to the operator's address
// (overridable via .env); FROM defaults to Resend's shared onboarding sender,
// which can email the account owner without domain verification — enough for a
// single operator emailing themselves. Set DIGEST_EMAIL_FROM once you verify a domain.
export function digestTo() {
  return process.env.DIGEST_EMAIL_TO || process.env.OPERATOR_EMAIL || '';
}
export function digestFrom() {
  return process.env.DIGEST_EMAIL_FROM || 'Curanta <onboarding@resend.dev>';
}

export async function sendEmail({ to, from, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY not set');
  if (!to) throw new Error('DIGEST_EMAIL_TO not set (no recipient)');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: from || digestFrom(),
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || data?.name || `Resend ${res.status}`);
  return { id: data.id };
}

function esc(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function host(url = '') {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// Build the digest email from the articles created in ONE auto-draft run. Each
// row: { title, body_html, source_publication, source_url }. The body is already
// safe HTML (escaped at generation in mdToTitleHtml), so it is embedded directly.
export function buildAutoDraftDigest(articles, { date = new Date() } = {}) {
  const n = articles.length;
  const dateLabel = date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const subject = `Curanta — ${n} new draft${n === 1 ? '' : 's'} ready (${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`;

  const blocks = articles.map((a, i) => {
    const src = a.source_publication || host(a.source_url) || '';
    const link = a.source_url
      ? `<a href="${esc(a.source_url)}" style="color:#6366f1;text-decoration:none">${esc(src || 'source')} ↗</a>`
      : esc(src);
    return `
    <div style="margin:0 0 26px;padding:0 0 22px;${i < articles.length - 1 ? 'border-bottom:1px solid #ececec' : ''}">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6366f1;font-weight:700;margin-bottom:6px">✦ Auto-drafted${src ? ` · ${link}` : ''}</div>
      <div style="font-size:21px;font-weight:800;line-height:1.3;color:#111;margin-bottom:10px">${esc(a.title || 'Untitled')}</div>
      <div style="font-size:15px;line-height:1.7;color:#222">${a.body_html || ''}</div>
    </div>`;
  }).join('\n');

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Georgia,'Times New Roman',serif">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f5"><tr><td align="center" style="padding:24px 14px">
<table width="640" cellpadding="0" cellspacing="0" border="0" style="background:#fff;border-radius:10px;box-shadow:0 2px 10px rgba(0,0,0,0.08)"><tr><td style="padding:30px 34px">
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <div style="font-size:22px;font-weight:800;color:#111">Your drafts are ready</div>
    <div style="font-size:12.5px;color:#888;margin-top:5px">${esc(dateLabel)} · ${n} auto-drafted article${n === 1 ? '' : 's'}</div>
    <div style="font-size:12.5px;color:#aaa;margin-top:3px">AI first drafts for your review. Open Curanta to edit, approve, or add to a newsletter — nothing has been published.</div>
  </div>
  <div style="margin-top:22px">${blocks}</div>
</td></tr></table>
<div style="font-size:11px;color:#bbb;margin-top:14px;font-family:-apple-system,sans-serif">Sent by Curanta Auto-Draft. Turn this off in Settings → AI Settings → Automation.</div>
</td></tr></table></body></html>`;

  return { subject, html };
}
