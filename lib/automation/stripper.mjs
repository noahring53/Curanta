// ── House-style stripper (deterministic backstop) ─────────────────────────────
// Layer 2 of the two-layer house-style enforcement. The prompt (layer 1) does the
// graceful phrasing; this is the mechanical guarantee that no em dash or semicolon
// ships even if the model slips. Scope: AUTOMATION DRAFTS ONLY — the existing
// newsletter pipeline is deliberately left untouched.
//
// Rules (per approval):
//   em dash / en dash → period (at a clause break) or comma
//   semicolon         → period
//
// What it protects: markdown links (the URL and anchor text) and verbatim
// double-quoted spans — a quote is reproduced exactly, dashes and all.

// Sentinel wrapping stashed spans: a Private-Use-Area code point that will not
// appear in civic text or captions. Written as an escape so this file stays plain
// UTF-8 text (a literal NUL byte here would trip binary/encoding tooling).
const SENT = '';
const RESTORE_RE = new RegExp(`${SENT}(\\d+)${SENT}`, 'g');

function protectSpans(text) {
  const spans = [];
  const stash = (m) => { const t = `${SENT}${spans.length}${SENT}`; spans.push(m); return t; };
  const out = text
    .replace(/\[[^\]]*\]\([^)]*\)/g, stash)          // markdown links
    .replace(/"[^"]*"/g, stash)                       // straight double quotes
    .replace(/[“][^”]*[”]/g, stash);   // curly double quotes
  return { out, spans };
}

function restore(text, spans) {
  return text.replace(RESTORE_RE, (_, i) => spans[Number(i)]);
}

export function stripHouseStyle(text = '') {
  if (!text) return text;
  const { out: protectedText, spans } = protectSpans(String(text));
  let out = protectedText;

  // Semicolon → sentence break.
  out = out.replace(/\s*;\s*/g, '. ');
  // Spaced em/en dash joins two clauses → sentence break.
  out = out.replace(/\s+[—–]\s+/g, '. ');
  // Any remaining (unspaced) em/en dash → comma.
  out = out.replace(/\s*[—–]\s*/g, ', ');

  // Cleanup artifacts, then re-capitalize the start of any sentence we created.
  out = out
    .replace(/ {2,}/g, ' ')
    .replace(/\s+([,.])/g, '$1')       // no space before comma/period
    .replace(/\.(\s*\.)+/g, '.')        // collapse ". ." → "."
    .replace(/,(\s*,)+/g, ',');
  out = out.replace(/([.!?])\s+([a-z])/g, (_, p, c) => `${p} ${c.toUpperCase()}`);

  return restore(out, spans).trim();
}

// True if the text still contains a raw em dash, en dash, or semicolon OUTSIDE
// protected spans. Used by tests and for a warning log after stripping.
export function hasStyleViolation(text = '') {
  const { out } = protectSpans(String(text));
  return /[—–;]/.test(out);
}
