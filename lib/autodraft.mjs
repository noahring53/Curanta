// ── Auto-Draft automation ─────────────────────────────────────────────────────
// Optional pipeline that extends the Inbox one step further: when the operator
// turns Auto-Draft ON, the server checks sources about once an hour, finds
// genuinely NEW stories, and drafts each one through the SAME article generation
// pipeline the Articles page uses — no separate, lower-quality generator.
//
//   OFF: sources → ingest → normalize → dedupe → Inbox            (stops here)
//   ON:  … → identify NEW item → generate article → save to Articles
//
// Everything routes through ONE function, runAutoDraftCycle(), called by both the
// hourly scheduler and the manual "Run Now" button, guarded by a single in-flight
// lock so overlapping runs can never stack. Cost discipline is built in: only new
// items, deduped, capped per cycle, and never re-drafted once done.

import { refreshInbox } from './inbox.mjs';
import { getSources, buildArticleMessages } from './articles.mjs';
import { emailConfigured, digestTo, sendEmail, buildAutoDraftDigest } from './email.mjs';

// Tunables. The cap bounds worst-case spend for one cycle; the interval is the
// "about once an hour" cadence. Both are deliberately conservative.
const MAX_PER_CYCLE = 15;
const DEFAULT_INTERVAL_MIN = 60;

// The standing angle for automatic drafts. The operator can't supply a per-story
// angle every hour, so the Master Article Prompt does the heavy lifting and this
// generic-but-honest instruction fills the angle slot. It must never invent facts.
export const DEFAULT_AUTO_ANGLE =
  'Draft this as a potentially relevant story for this publication. Focus on the ' +
  'most locally relevant and newsworthy information that is directly supported by ' +
  'the source material. Do not invent facts, quotes, or figures.';

// ── Settings (persisted in user_settings.data.auto_draft) ─────────────────────
// Rides the existing user_settings JSON blob — no schema migration for a handful
// of automation flags. Defaults keep Auto-Draft OFF for existing installs.
function defaultState() {
  return {
    enabled: false,
    enabledAt: '',        // watermark: only items ingested at/after this are eligible
    intervalMinutes: DEFAULT_INTERVAL_MIN,
    lastCheckAt: '',      // last time sources were checked
    lastRunAt: '',        // last time a cycle finished
    lastCreated: 0,       // drafts created on the last run
    lastErrors: 0,        // generation failures on the last run
    lastRemaining: 0,     // eligible items left uncapped for a later run
    emailDigest: true,    // email finished drafts (only sends if RESEND_API_KEY is set)
    lastEmailAt: '',      // last successful digest send
    lastEmailError: '',   // last digest failure (surfaced in Settings)
  };
}

export function getAutoDraftState(store) {
  const settings = store.getUserSettings(store.LOCAL_USER.id) || {};
  return { ...defaultState(), ...(settings.auto_draft || {}) };
}

function writeAutoDraftState(store, patch) {
  const current = getAutoDraftState(store);
  const next = { ...current, ...patch };
  store.runQuery({
    table: 'user_settings', action: 'update',
    filters: [{ col: 'user_id', op: 'eq', val: store.LOCAL_USER.id }],
    values: { auto_draft: next, updated_at: new Date().toISOString() },
  });
  return next;
}

// ── Markdown → { title, html } (server-side, no DOM) ──────────────────────────
// The model writes markdown; the Articles editor stores HTML. This mirrors the
// client's artMdToHtml/artSplitHeadline so an auto-draft opens identically to a
// hand-generated one. Everything is escaped first — model/source output can never
// inject markup into the stored draft.
function escapeHtml(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function inlineMd(s) {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

export function mdToTitleHtml(md = '') {
  const lines = String(md).replace(/\r/g, '').split('\n');
  // First non-blank "# " line is the headline — pulled out so the body has none.
  let title = '';
  const firstIdx = lines.findIndex(l => l.trim());
  if (firstIdx >= 0) {
    const m = lines[firstIdx].trim().match(/^#\s+(.*)$/);
    if (m) { title = m[1].trim(); lines.splice(0, firstIdx + 1); }
  }

  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { closeList(); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeList(); const lvl = Math.max(2, h[1].length); out.push(`<h${lvl}>${inlineMd(h[2])}</h${lvl}>`); continue; }
    if (/^>\s?/.test(line)) { closeList(); out.push(`<blockquote>${inlineMd(line.replace(/^>\s?/, ''))}</blockquote>`); continue; }
    const ul = line.match(/^[-*•]\s+(.*)$/);
    if (ul) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inlineMd(ul[1])}</li>`); continue; }
    const ol = line.match(/^\d+[.)]\s+(.*)$/);
    if (ol) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inlineMd(ol[1])}</li>`); continue; }
    if (/^(-{3,}|\*{3,})$/.test(line)) { closeList(); out.push('<hr>'); continue; }
    closeList();
    out.push(`<p>${inlineMd(line)}</p>`);
  }
  closeList();
  return { title, html: out.join('\n') };
}

// A clearly-labelled placeholder for no-key installs, so the automation is
// demonstrable without an Anthropic key — exactly as the manual Articles page
// falls back. Real drafting is the norm; this is never a second "real" generator.
function mockMarkdown(source) {
  const lede = (source.body || '').split(/\n{2,}/).find(b => b.length > 80 && !b.startsWith('#')) || source.title || '';
  return `# ${source.title || 'Untitled'}\n\n*Auto-draft placeholder — no ANTHROPIC_API_KEY configured.*\n\n${lede}`;
}

// ── Idempotency: has this inbox item already produced an auto-article? ─────────
// Data-layer guard (in addition to the item's own auto_draft_status): scans the
// articles table for a row tagged with this inbox id. Combined with the unique
// (user_id, source_inbox_id) index in the store, the same feed story can never
// spawn Article A at 10:00, B at 11:00, C at 12:00.
function existingArticleFor(store, inboxId) {
  const rows = store.runQuery({
    table: 'articles', action: 'select',
    filters: [{ col: 'user_id', op: 'eq', val: store.LOCAL_USER.id }, { col: 'source_inbox_id', op: 'eq', val: inboxId }],
  }).data || [];
  return rows[0] || null;
}

function patchInboxItem(store, id, fields) {
  store.runQuery({
    table: 'inbox_items', action: 'update',
    filters: [{ col: 'id', op: 'eq', val: id }],
    values: fields,
  });
}

// ── The one reusable cycle ────────────────────────────────────────────────────
// Called by BOTH the hourly scheduler and the "Run Now" button. A single module-
// level lock means a second call while one is running is a no-op, never an
// overlapping ingest/generate storm.
let running = false;

export async function runAutoDraftCycle(store, deps, { trigger = 'scheduled' } = {}) {
  const { ingestUrl, fetchArticle, generate, loadMaster, hasAI = false, classifyError } = deps;

  if (running) return { skipped: 'in_progress', trigger };
  const state = getAutoDraftState(store);
  if (!state.enabled) return { skipped: 'disabled', trigger };

  running = true;
  const startedAt = new Date().toISOString();
  const result = { trigger, ranAt: startedAt, checked: null, eligible: 0, created: 0, failed: 0, capped: false, remaining: 0 };

  try {
    // 1–4. Reuse the existing ingestion pipeline: fetch → normalize → dedupe →
    // persist Inbox items. One bad feed reports an error and the batch moves on
    // (refreshInbox already isolates each source).
    let checkedAt = new Date().toISOString();
    try {
      const refresh = await refreshInbox({ ingestUrl, store, publicationId: '__all__' });
      result.checked = refresh.totals;
      checkedAt = refresh.ranAt || checkedAt;
    } catch (e) {
      console.error('[autodraft] ingest failed (continuing to draft any pending items):', e.message);
    }

    // 5–7. Identify genuinely NEW, not-yet-drafted items. "New" = discovered at or
    // after Auto-Draft was last enabled (the watermark), so flipping the switch
    // never drafts the entire pre-existing backlog — only fresh discoveries.
    const enabledAt = state.enabledAt || startedAt;
    const all = store.listInbox({ limit: 1000 });
    const eligible = all
      .filter(i => i.url
        && !i.auto_draft_status                    // never attempted (idempotent)
        && (i.status || 'new') !== 'dismissed'     // respect the operator dismissing it
        && String(i.ingested_at || '') >= enabledAt)
      .sort((a, b) => String(a.ingested_at || '').localeCompare(String(b.ingested_at || ''))); // oldest first

    result.eligible = eligible.length;

    // 8. Per-cycle cap. Anything over the cap is LEFT in the Inbox (untouched,
    // still eligible) for the next hourly run — never dropped.
    const batch = eligible.slice(0, MAX_PER_CYCLE);
    result.capped = eligible.length > MAX_PER_CYCLE;
    result.remaining = Math.max(0, eligible.length - batch.length);

    const createdRows = [];   // the articles drafted this run — the digest payload

    for (const item of batch) {
      try {
        // Data-layer idempotency: if an article already links to this item, adopt
        // it and skip the model call entirely.
        const prior = existingArticleFor(store, item.id);
        if (prior) {
          patchInboxItem(store, item.id, { auto_draft_status: 'drafted', generated_article_id: prior.id, auto_draft_error: '' });
          continue;
        }

        // Mark in-progress and stamp the attempt BEFORE the model call, so a crash
        // mid-generation leaves a visible 'drafting' state rather than silence.
        patchInboxItem(store, item.id, { auto_draft_status: 'drafting', auto_draft_attempted_at: new Date().toISOString(), auto_draft_error: '' });

        // 9. Generate through the EXISTING pipeline: real source grounding + the
        // publication's Master Article Prompt + the default auto angle. Source text
        // is DATA — it can never override the master/system prompt (buildArticleMessages
        // keeps the editor's instructions and the source in separate, labelled blocks).
        const { sources } = await getSources([item.url], { fetchArticle });
        if (!sources.length) throw new Error('Could not extract the source article.');
        const master = await loadMaster(store.LOCAL_USER.id, '', item.publication_id || '');
        const { system, user, maxTokens, temperature } = buildArticleMessages({
          mode: 'news', masterPrompt: master, angle: DEFAULT_AUTO_ANGLE, sources,
        });

        // 12. Transient provider errors (429/529/network) are retried with backoff
        // inside generate(); after that it throws and we record failure — no infinite loop.
        const markdown = hasAI
          ? await generate({ system, user, maxTokens, temperature })
          : mockMarkdown(sources[0]);

        const { title, html } = mdToTitleHtml(markdown);

        // 10. Persist as a normal Article draft — identical shape to a hand-drafted
        // one, so it opens, edits, approves, and adds-to-newsletter the same way.
        // generation_source='auto' + source_inbox_id tag it and enforce idempotency.
        const inserted = store.runQuery({
          table: 'articles', action: 'insert', single: true, returning: true,
          values: {
            user_id: store.LOCAL_USER.id,
            publication_id: item.publication_id ?? null,
            title: (title || item.title || 'Untitled Article').slice(0, 400),
            body_html: html,
            status: 'draft',
            angle: DEFAULT_AUTO_ANGLE,
            notes: '',
            mode: 'news',
            source_url: item.url,
            source_title: item.title || '',
            source_publication: item.source_title || '',
            source_inbox_id: item.id,
            generation_source: 'auto',
          },
        }).data;

        // 11. Link the Inbox item to its draft.
        patchInboxItem(store, item.id, {
          auto_draft_status: 'drafted',
          generated_article_id: inserted?.id || '',
          auto_draft_error: '',
        });
        if (inserted) createdRows.push(inserted);
        result.created++;
      } catch (e) {
        // One failed generation must not abort the cycle. Record a typed reason
        // (never a blanket "rate limited") and move on; the item can be retried.
        const c = classifyError ? classifyError(e) : null;
        const reason = (c && (c.message || c.error)) || e.message || 'generation failed';
        patchInboxItem(store, item.id, { auto_draft_status: 'failed', auto_draft_error: String(reason).slice(0, 300) });
        console.error(`[autodraft] draft failed for "${(item.title || '').slice(0, 60)}": ${reason}`);
        result.failed++;
      }
    }

    // Email the finished drafts so the loop is truly hands-off. Never throws into
    // the cycle: a mail failure is recorded and the run still counts as a success
    // (the drafts are saved regardless). Only sends when there's something new,
    // the operator hasn't turned the digest off, and a key is configured.
    const emailPatch = {};
    if (createdRows.length && state.emailDigest !== false && emailConfigured()) {
      try {
        const { subject, html } = buildAutoDraftDigest(createdRows);
        const to = digestTo();
        if (!to) throw new Error('no recipient — set DIGEST_EMAIL_TO');
        const sent = await sendEmail({ to, subject, html });
        emailPatch.lastEmailAt = new Date().toISOString();
        emailPatch.lastEmailError = '';
        result.emailed = createdRows.length;
        console.log(`[autodraft] digest emailed to ${to} (${createdRows.length} drafts, id ${sent.id})`);
      } catch (e) {
        emailPatch.lastEmailError = String(e.message || e).slice(0, 300);
        result.emailError = emailPatch.lastEmailError;
        console.error('[autodraft] digest email failed (drafts are still saved):', emailPatch.lastEmailError);
      }
    } else if (createdRows.length && state.emailDigest !== false && !emailConfigured()) {
      console.log('[autodraft] digest skipped: RESEND_API_KEY not set (drafts saved to Articles).');
    }

    writeAutoDraftState(store, {
      lastCheckAt: checkedAt,
      lastRunAt: new Date().toISOString(),
      lastCreated: result.created,
      lastErrors: result.failed,
      lastRemaining: result.remaining,
      ...emailPatch,
    });

    console.log(`[autodraft] ${trigger} run: ${result.created} drafted, ${result.failed} failed, ${result.eligible} eligible${result.capped ? ` (capped at ${MAX_PER_CYCLE}, ${result.remaining} left)` : ''}`);
    return result;
  } finally {
    running = false;
  }
}

// Retry ONE failed item on demand: clear its failed state and run the cycle. The
// item becomes eligible again (its status is cleared) and the same guarded cycle
// picks it up — no separate generation path.
export async function retryInboxItem(store, deps, itemId) {
  const item = store.listInbox({ limit: 1000 }).find(i => i.id === itemId);
  if (!item) return { error: 'not_found' };
  patchInboxItem(store, itemId, { auto_draft_status: '', auto_draft_error: '' });
  // Ensure it passes the watermark check even if it was discovered before enable.
  const st = getAutoDraftState(store);
  if (String(item.ingested_at || '') < (st.enabledAt || '')) {
    // Nudge the watermark back so this specific retry is eligible.
    patchInboxItem(store, itemId, { ingested_at: new Date().toISOString() });
  }
  return runAutoDraftCycle(store, deps, { trigger: 'retry' });
}

// ── Scheduler (one instance, restart-safe) ────────────────────────────────────
let timer = null;

export function startScheduler(store, deps) {
  if (timer) return;                         // never stack intervals (hot reload safe)
  const mins = getAutoDraftState(store).intervalMinutes || DEFAULT_INTERVAL_MIN;
  timer = setInterval(() => {
    runAutoDraftCycle(store, deps, { trigger: 'scheduled' })
      .catch(e => console.error('[autodraft] scheduled run error:', e.message));
  }, mins * 60 * 1000);
  timer.unref?.();
}

export function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

export function isRunning() { return running; }
export function isScheduled() { return !!timer; }

// Turn the feature ON/OFF. Enabling stamps a fresh watermark, starts the
// scheduler, and kicks a run shortly after so the operator doesn't wait an hour.
// Disabling stops future runs but deletes nothing already generated.
export function setAutoDraftEnabled(store, deps, enabled) {
  if (enabled) {
    const next = writeAutoDraftState(store, { enabled: true, enabledAt: new Date().toISOString() });
    startScheduler(store, deps);
    setTimeout(() => {
      runAutoDraftCycle(store, deps, { trigger: 'enable' })
        .catch(e => console.error('[autodraft] enable run error:', e.message));
    }, 1500).unref?.();
    return next;
  }
  stopScheduler();
  return writeAutoDraftState(store, { enabled: false });
}

// Called once at boot: resume the scheduler iff the persisted setting is ON.
export function initAutoDraftScheduler(store, deps) {
  const st = getAutoDraftState(store);
  if (!st.enabled) return false;
  startScheduler(store, deps);
  setTimeout(() => {
    runAutoDraftCycle(store, deps, { trigger: 'boot' })
      .catch(e => console.error('[autodraft] boot run error:', e.message));
  }, 5000).unref?.();
  return true;
}

// ── Routes ────────────────────────────────────────────────────────────────────
export function registerAutoDraftRoutes(app, { store, deps, limiter = (_q, _s, next) => next() }) {
  const publicState = () => {
    const s = getAutoDraftState(store);
    return {
      enabled: s.enabled,
      intervalMinutes: s.intervalMinutes,
      lastCheckAt: s.lastCheckAt,
      lastRunAt: s.lastRunAt,
      lastCreated: s.lastCreated,
      lastErrors: s.lastErrors,
      lastRemaining: s.lastRemaining,
      running: isRunning(),
      scheduled: isScheduled(),
      maxPerCycle: MAX_PER_CYCLE,
      // Email digest status so Settings can show whether hands-off delivery is live.
      emailDigest: s.emailDigest !== false,
      emailConfigured: emailConfigured(),
      emailTo: digestTo(),
      lastEmailAt: s.lastEmailAt,
      lastEmailError: s.lastEmailError,
    };
  };

  app.get('/api/autodraft', (_req, res) => res.json(publicState()));

  app.post('/api/autodraft/toggle', (req, res) => {
    const enabled = !!(req.body && req.body.enabled);
    setAutoDraftEnabled(store, deps, enabled);
    res.json(publicState());
  });

  // Turn the email digest on/off independently of the automation itself.
  app.post('/api/autodraft/email', (req, res) => {
    const emailDigest = !!(req.body && req.body.emailDigest);
    writeAutoDraftState(store, { emailDigest });
    res.json(publicState());
  });

  // Send a one-off TEST digest so the operator can confirm delivery works without
  // waiting for a real run. Uses the two most recent auto-drafts as sample content.
  app.post('/api/autodraft/test-email', async (_req, res) => {
    try {
      if (!emailConfigured()) return res.status(400).json({ error: 'RESEND_API_KEY not set' });
      const to = digestTo();
      if (!to) return res.status(400).json({ error: 'No recipient — set DIGEST_EMAIL_TO or OPERATOR_EMAIL' });
      const recent = (store.runQuery({
        table: 'articles', action: 'select',
        filters: [{ col: 'user_id', op: 'eq', val: store.LOCAL_USER.id }],
        order: { col: 'created_at', ascending: false }, limit: 2,
      }).data) || [];
      const sample = recent.length ? recent : [{ title: 'Test article', body_html: '<p>This is a Curanta test digest. Email delivery is working.</p>', source_publication: 'Curanta' }];
      const { subject, html } = buildAutoDraftDigest(sample);
      const sent = await sendEmail({ to, subject: `[Test] ${subject}`, html });
      res.json({ ok: true, to, id: sent.id });
    } catch (e) {
      res.status(502).json({ error: String(e.message || e) });
    }
  });

  // Manual "Run Now" — the SAME cycle the scheduler calls, same in-flight lock.
  app.post('/api/autodraft/run', limiter, async (req, res) => {
    try {
      const out = await runAutoDraftCycle(store, deps, { trigger: 'manual' });
      res.json({ ...out, state: publicState() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/autodraft/retry', limiter, async (req, res) => {
    const itemId = req.body && req.body.itemId;
    if (!itemId) return res.status(400).json({ error: 'itemId is required' });
    try {
      const out = await retryInboxItem(store, deps, itemId);
      res.json({ ...out, state: publicState() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}
