// ── The pipeline run (manual trigger) ─────────────────────────────────────────
// One on-demand pass: for each active source → handler → normalize → dedupe →
// draft → persist, then assemble one digest and email it. No scheduler, no cron.
// Idempotent: dedupe (seen_items) means a second "Run now" drafts and sends
// nothing new, so double-clicking is harmless. A DB lock stops two runs
// overlapping. When a scheduler is wanted later, it just calls runPipeline().

import * as db from './supabase.mjs';
import { getHandler } from './handlers/index.mjs';
import { selectDraftPrompt, buildUserPrompt, stripHouseStyle, hasStyleViolation } from './prompts.mjs';
import { claimIfNew } from './dedupe.mjs';
import { buildDigest } from './digest.mjs';
import * as email from './email.mjs';

const enabled = () => ['true', '1', 'on'].includes(String(process.env.AUTOMATION_ENABLED || '').toLowerCase());
const runSecret = () => process.env.AUTOMATION_RUN_SECRET || '';
const userId = () => process.env.AUTOMATION_USER_ID || '';
const maxDrafts = () => Number(process.env.AUTOMATION_MAX_DRAFTS_PER_RUN || 25);
const LOCK_STALE_MS = 10 * 60 * 1000;

// ── Locking (via the jobs table) ──────────────────────────────────────────────
async function acquireLock() {
  const rows = await db.select('jobs', 'name=eq.run');
  const row = rows[0];
  if (row?.locked_at && Date.now() - new Date(row.locked_at).getTime() < LOCK_STALE_MS) return false;
  const stamp = { locked_at: new Date().toISOString(), last_status: 'running' };
  if (row) await db.update('jobs', 'name=eq.run', stamp);
  else await db.insert('jobs', { name: 'run', ...stamp });
  return true;
}

async function releaseLock(status, meta = {}, lastError = '') {
  await db.update('jobs', 'name=eq.run', {
    locked_at: null,
    last_status: status,
    last_run_at: new Date().toISOString(),
    last_error: lastError,
    meta,
  });
}

function mockDraft(item) {
  return `# ${item.title}\n\nMock link-roundup summary (no ANTHROPIC_API_KEY set). A third-party item would get a one to two sentence original summary here.\n\nRead more: [${item.source_name || 'Source'}](${item.url})`;
}

// ── The run ───────────────────────────────────────────────────────────────────
export async function runPipeline(deps) {
  const { generate, hasAI } = deps;
  const uid = userId();
  const cap = maxDrafts();
  const stats = { sources: 0, fetched: 0, new: 0, drafted: 0, skipped: 0, errors: 0 };

  const sources = await db.select('sources', `user_id=eq.${uid}&status=eq.active`);
  stats.sources = sources.length;

  for (const source of sources) {
    if (stats.drafted >= cap) break;

    const handler = getHandler(source.type || 'rss');
    if (!handler) {
      console.warn(`[automation] no handler for type="${source.type}" (source ${source.id}) — skipped`);
      continue;
    }

    let items = [];
    try {
      items = await handler.fetchNew(source, { since: source.last_checked_at, deps });
    } catch (e) {
      stats.errors++;
      console.error(`[automation] source ${source.id} fetch failed: ${e.message}`);
      continue; // one bad feed never sinks the batch
    }
    stats.fetched += items.length;

    for (const item of items) {
      if (stats.drafted >= cap) break;
      if (!item.url && !item.title) continue;

      let claim;
      try {
        claim = await claimIfNew({ userId: uid, item });
      } catch (e) {
        stats.errors++;
        console.error(`[automation] dedupe failed for "${item.title}": ${e.message}`);
        continue;
      }
      if (!claim.isNew) { stats.skipped++; continue; }
      stats.new++;

      try {
        const { system, maxTokens, temperature } = selectDraftPrompt(item.draft_type, { market: item.market, lowFidelity: item.low_fidelity });
        const user = buildUserPrompt(item);
        let body = hasAI ? await generate({ system, user, maxTokens, temperature }) : mockDraft(item);
        body = stripHouseStyle(body);
        if (hasStyleViolation(body)) console.warn(`[automation] style violation survived strip in "${item.title}"`);

        const inserted = await db.insert('drafts', {
          user_id: uid,
          source_id: item.source_id,
          source_name: item.source_name,
          market: item.market,
          draft_type: item.draft_type,
          title: item.title,
          url: item.url,
          published_at: item.published_at,
          body_markdown: body,
          status: 'new',
        });
        stats.drafted++;
        const draftId = inserted[0]?.id;
        if (draftId) {
          await db.update('seen_items', `user_id=eq.${uid}&url_hash=eq.${claim.url_hash}`, { draft_id: draftId });
        }
      } catch (e) {
        stats.errors++;
        console.error(`[automation] draft failed for "${item.title}": ${e.message}`);
      }
    }

    // Stamp the source only after a successful poll so a failed fetch is retried.
    try {
      await db.update('sources', `id=eq.${source.id}`, { last_checked_at: new Date().toISOString() });
    } catch (e) {
      console.error(`[automation] could not stamp last_checked_at for ${source.id}: ${e.message}`);
    }
  }

  // ── Digest + email (same run) ───────────────────────────────────────────────
  let emailed = false;
  let digestItems = 0;
  const fresh = await db.select('drafts', `user_id=eq.${uid}&status=eq.new&order=created_at.desc`);
  digestItems = fresh.length;

  if (fresh.length) {
    const { subject, html } = buildDigest(fresh);
    if (email.configured() && process.env.DIGEST_TO) {
      await email.sendEmail({ to: process.env.DIGEST_TO, from: process.env.DIGEST_FROM, subject, html });
      emailed = true;
      const ids = fresh.map((d) => d.id).join(',');
      await db.update('drafts', `id=in.(${ids})`, { status: 'digested' });
    } else {
      console.warn('[automation] RESEND_API_KEY or DIGEST_TO not set — drafts left as "new", not emailed');
    }
  }

  return { ...stats, digestItems, emailed };
}

// ── Route ─────────────────────────────────────────────────────────────────────
export function registerAutomationRoutes(app, deps) {
  app.post('/api/automation/run', async (req, res) => {
    if (!enabled()) return res.status(503).json({ error: 'automation_disabled', message: 'Set AUTOMATION_ENABLED=true to enable.' });
    if (!db.configured()) return res.status(503).json({ error: 'service_role_required', message: 'SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required for the browserless run.' });
    if (!userId()) return res.status(400).json({ error: 'config', message: 'AUTOMATION_USER_ID not set.' });

    const secret = req.get('x-automation-secret') || req.body?.secret || '';
    if (!runSecret() || secret !== runSecret()) return res.status(401).json({ error: 'unauthorized' });

    let locked;
    try {
      locked = await acquireLock();
    } catch (e) {
      return res.status(500).json({ error: 'lock_failed', message: e.message });
    }
    if (!locked) return res.status(409).json({ error: 'run_in_progress', message: 'A run is already in flight.' });

    try {
      const stats = await runPipeline(deps);
      await releaseLock('ok', stats);
      console.log('[automation] run ok:', JSON.stringify(stats));
      return res.json({ success: true, stats });
    } catch (e) {
      await releaseLock('error', {}, e.message).catch(() => {});
      console.error('[automation] run failed:', e.message);
      return res.status(500).json({ error: 'run_failed', message: e.message });
    }
  });
}
