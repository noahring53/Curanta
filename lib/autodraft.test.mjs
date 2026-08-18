// Deterministic tests for the Auto-Draft cycle + email digest. Uses the REAL
// SQLite store (temp DB) and stubs only the external seams (article fetch, model,
// and the Resend fetch) so the whole path — generate → persist → idempotency →
// email — is exercised without a network or an API key.

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DB = join(tmpdir(), `autodraft-test-${Date.now()}.db`);
process.env.DB_PATH = DB;
delete process.env.RESEND_API_KEY; // start unconfigured

const store = await import('./store.mjs');
store.initStore(DB);
const { runAutoDraftCycle } = await import('./autodraft.mjs');

// ── Stubs ─────────────────────────────────────────────────────────────────────
const LONG_TEXT = Array.from({ length: 160 }, (_, i) => `word${i}`).join(' ');
let generateCalls = 0;
const deps = {
  ingestUrl: async () => ({ articles: [] }),            // no live feeds in the test
  fetchArticle: async (url) => ({ title: 'Source Title', source: 'Source Pub', url, text: LONG_TEXT, publishedAt: null }),
  generate: async () => { generateCalls++; return '# Generated Headline\n\nFirst paragraph of the draft.\n\nSecond paragraph.'; },
  loadMaster: async () => 'MASTER PROMPT',
  hasAI: true,
  classifyError: (e) => ({ status: 500, error: 'generation_failed', message: e.message }),
};

// Enable Auto-Draft with a watermark in the past (bypasses the real scheduler/timers).
function enable(emailDigest = true) {
  store.runQuery({
    table: 'user_settings', action: 'update',
    filters: [{ col: 'user_id', op: 'eq', val: store.LOCAL_USER.id }],
    values: { auto_draft: { enabled: true, enabledAt: '2020-01-01T00:00:00.000Z', emailDigest } },
  });
}
function seedItem(url_hash, url, title) {
  store.runQuery({ table: 'inbox_items', action: 'insert', values: {
    user_id: store.LOCAL_USER.id, url_hash, url, title, source_title: 'Feed', status: 'new',
  } });
}
function inbox(url_hash) {
  return store.runQuery({ table: 'inbox_items', action: 'select',
    filters: [{ col: 'url_hash', op: 'eq', val: url_hash }], single: true }).data;
}
function autoArticles() {
  return (store.runQuery({ table: 'articles', action: 'select',
    filters: [{ col: 'user_id', op: 'eq', val: store.LOCAL_USER.id }] }).data || [])
    .filter(a => a.generation_source === 'auto');
}

let passed = 0;
const ok = (label) => { console.log('  ✓', label); passed++; };

// ── Test 1: disabled → cycle is a no-op ───────────────────────────────────────
{
  const r = await runAutoDraftCycle(store, deps, { trigger: 'test' });
  assert.equal(r.skipped, 'disabled');
  assert.equal(autoArticles().length, 0);
  ok('disabled: cycle skipped, nothing drafted');
}

// ── Test 2: enabled, no RESEND key → drafts created, email SKIPPED, no throw ───
{
  enable(true);
  seedItem('t-1', 'https://example.com/a', 'Story A');
  const r = await runAutoDraftCycle(store, deps, { trigger: 'test' });
  assert.equal(r.created, 1, 'one draft created');
  assert.equal(r.emailed, undefined, 'no email sent without a key');
  const arts = autoArticles();
  assert.equal(arts.length, 1);
  assert.equal(arts[0].generation_source, 'auto');
  assert.equal(arts[0].source_inbox_id, inbox('t-1').id, 'article linked to inbox item');
  assert.match(arts[0].body_html, /Generated Headline|First paragraph/);
  assert.equal(inbox('t-1').auto_draft_status, 'drafted');
  assert.equal(inbox('t-1').generated_article_id, arts[0].id);
  ok('no key: draft persisted + linked, email skipped, no crash');
}

// ── Test 3: idempotency → re-running creates no second article, no email ───────
{
  const before = autoArticles().length;
  const r = await runAutoDraftCycle(store, deps, { trigger: 'test' });
  assert.equal(r.created, 0, 'nothing new to draft');
  assert.equal(autoArticles().length, before, 'no duplicate article');
  ok('idempotent: same feed item never re-drafted');
}

// ── Test 4: configured + new item → digest emailed via (stubbed) Resend ───────
{
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.DIGEST_EMAIL_TO = 'operator@example.com';
  const realFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 200, json: async () => ({ id: 'email_abc123' }) };
  };
  try {
    seedItem('t-2', 'https://example.com/b', 'Story B');
    const r = await runAutoDraftCycle(store, deps, { trigger: 'test' });
    assert.equal(r.created, 1, 'the new item drafted');
    assert.equal(r.emailed, 1, 'digest reports one article emailed');
    assert.ok(captured, 'Resend fetch was called');
    assert.match(captured.url, /api\.resend\.com\/emails/);
    assert.equal(captured.opts.headers.Authorization, 'Bearer re_test_key');
    const body = JSON.parse(captured.opts.body);
    assert.deepEqual(body.to, ['operator@example.com']);
    assert.match(body.subject, /new draft/i);
    assert.match(body.html, /Generated Headline|Story B|Auto-drafted/);
  } finally {
    globalThis.fetch = realFetch;
  }
  ok('configured: digest sent to the right address with the right payload');
}

// ── Test 5: email failure must NOT fail the run (drafts still saved) ───────────
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 422, json: async () => ({ message: 'domain not verified' }) });
  try {
    seedItem('t-3', 'https://example.com/c', 'Story C');
    const r = await runAutoDraftCycle(store, deps, { trigger: 'test' });
    assert.equal(r.created, 1, 'draft still created despite email failure');
    assert.match(r.emailError || '', /domain not verified/);
    assert.equal(inbox('t-3').auto_draft_status, 'drafted', 'item still marked drafted');
  } finally {
    globalThis.fetch = realFetch;
  }
  ok('email failure recorded but the run still succeeds');
}

// ── Test 6: email digest turned OFF → configured but no send ───────────────────
{
  enable(false); // emailDigest:false, fresh watermark still in the past
  const realFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, status: 200, json: async () => ({ id: 'x' }) }; };
  try {
    seedItem('t-4', 'https://example.com/d', 'Story D');
    const r = await runAutoDraftCycle(store, deps, { trigger: 'test' });
    assert.equal(r.created, 1);
    assert.equal(r.emailed, undefined, 'no email when digest is off');
    assert.equal(called, false, 'Resend not called when digest is off');
  } finally {
    globalThis.fetch = realFetch;
  }
  ok('digest off: drafts created, no email sent');
}

console.log(`\n✅ autodraft: ${passed}/6 checks passed`);

// Best-effort temp cleanup — close the DB handle first; ignore if the OS still
// holds the file (the temp dir is reclaimed anyway).
try { store.getDb()?.close(); } catch {}
for (const f of [DB, DB + '-journal', DB + '-wal', DB + '-shm']) {
  try { rmSync(f, { force: true }); } catch {}
}
