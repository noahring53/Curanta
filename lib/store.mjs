// ── Local persistence store (node:sqlite) ────────────────────────────────────
// Single-operator local mode: replaces Supabase (auth + Postgres) with an
// embedded SQLite database and a tiny query executor whose response shape
// mirrors the slice of the Supabase JS client the app already uses. That lets
// the 7,000-line frontend keep every `sb.from('table')…` call site unchanged —
// only the client OBJECT is swapped (see makeLocalClient in public/app.js).
//
// Storage model is "document store on SQLite": each table has a handful of
// indexed columns (the ones the app filters/orders on) plus a `data` JSON blob
// holding every other field. The frontend writes many evolving fields to
// user_settings/newsletters; the blob keeps that flexible without a migration
// per field, while the indexed columns keep queries fast and correct.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

// The single local operator. A fixed id keeps every row owned by one user, and
// `grandfathered: true` makes every subscription/plan gate in the app pass
// without touching the billing code (which stays dormant in the repo).
export const LOCAL_USER = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'operator@localhost',
};

// Per-table schema. `cols` are real, indexed SQLite columns; everything else a
// row carries lives in the JSON `data` column. `pk` is the primary key column.
const TABLES = {
  user_settings: { pk: 'user_id', cols: ['user_id'] },
  publications:  { pk: 'id', cols: ['id', 'user_id', 'name', 'created_at'] },
  newsletters:   { pk: 'id', cols: ['id', 'user_id', 'publication_id', 'status', 'created_at', 'updated_at'] },
  sources:       { pk: 'id', cols: ['id', 'user_id', 'publication_id', 'feed_url', 'type', 'title', 'created_at'] },
  articles:      { pk: 'id', cols: ['id', 'user_id', 'publication_id', 'status', 'created_at', 'updated_at', 'source_inbox_id'] },
  inbox_items:   { pk: 'id', cols: ['id', 'user_id', 'publication_id', 'source_id', 'url_hash', 'status', 'published_at', 'ingested_at', 'created_at'] },
};

let db = null;

export function isValidTable(t) {
  return Object.prototype.hasOwnProperty.call(TABLES, t);
}

// ── Init ──────────────────────────────────────────────────────────────────────
export function initStore(dbPath = process.env.DB_PATH || './data/curanta.db') {
  if (db) return db;
  const abs = resolve(dbPath);
  mkdirSync(dirname(abs), { recursive: true });
  db = new DatabaseSync(abs);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  for (const [name, cfg] of Object.entries(TABLES)) {
    const colDefs = cfg.cols
      .map(c => `${c} TEXT${c === cfg.pk ? ' PRIMARY KEY' : ''}`)
      .join(', ');
    db.exec(`CREATE TABLE IF NOT EXISTS ${name} (${colDefs}, data TEXT NOT NULL DEFAULT '{}')`);
  }
  // Older databases predate the articles.source_inbox_id column (added for
  // Auto-Draft idempotency). CREATE TABLE IF NOT EXISTS won't add it, so bring
  // existing installs forward with a guarded ALTER (ignored once it exists).
  try { db.exec('ALTER TABLE articles ADD COLUMN source_inbox_id TEXT'); } catch { /* already present */ }

  // Helpful indexes for the hot query paths.
  db.exec('CREATE INDEX IF NOT EXISTS idx_sources_user ON sources(user_id, publication_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_newsletters_user ON newsletters(user_id, publication_id, updated_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_articles_user ON articles(user_id, publication_id, updated_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_inbox_user ON inbox_items(user_id, publication_id, status, ingested_at)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uniq_inbox_url ON inbox_items(user_id, url_hash)');
  // Data-layer idempotency for Auto-Draft: one auto-article per Inbox item. The
  // partial index leaves manual drafts (NULL source_inbox_id) unconstrained.
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uniq_articles_inbox ON articles(user_id, source_inbox_id) WHERE source_inbox_id IS NOT NULL');

  seedLocalUser();
  return db;
}

// A grandfathered settings row so the app boots signed-in with full access.
function seedLocalUser() {
  const existing = db.prepare('SELECT user_id FROM user_settings WHERE user_id = ?').get(LOCAL_USER.id);
  if (existing) return;
  writeRow('user_settings', {
    user_id: LOCAL_USER.id,
    grandfathered: true,
    subscription_status: 'active',
    subscription_plan: 'multi',
    tone: 'punchy-executive',
    brand_color: '#6366f1',
    default_prompts: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { pk: 'user_id' });
}

// ── Row (de)serialization ───────────────────────────────────────────────────
function splitRow(table, values) {
  const cfg = TABLES[table];
  const indexed = {};
  const rest = {};
  for (const [k, v] of Object.entries(values || {})) {
    if (cfg.cols.includes(k)) indexed[k] = v;
    else rest[k] = v;
  }
  return { indexed, rest };
}

function rowToObject(table, row) {
  if (!row) return null;
  const cfg = TABLES[table];
  let data = {};
  try { data = row.data ? JSON.parse(row.data) : {}; } catch { data = {}; }
  const out = { ...data };
  for (const c of cfg.cols) out[c] = row[c] ?? null;
  return out;
}

// Write (insert or replace) a full row. Used by seeding and upsert.
function writeRow(table, values) {
  const cfg = TABLES[table];
  const v = { ...values };
  if (cfg.pk === 'id' && !v.id) v.id = randomUUID();
  const now = new Date().toISOString();
  if (cfg.cols.includes('created_at') && v.created_at == null) v.created_at = now;
  if (cfg.cols.includes('updated_at') && v.updated_at == null) v.updated_at = now;
  if (cfg.cols.includes('ingested_at') && v.ingested_at == null) v.ingested_at = now;

  const { indexed, rest } = splitRow(table, v);
  const cols = [...cfg.cols.filter(c => indexed[c] !== undefined), 'data'];
  const placeholders = cols.map(() => '?').join(', ');
  const params = cols.map(c => (c === 'data' ? JSON.stringify(rest) : normalize(indexed[c])));
  db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`).run(...params);
  return rowToObject(table, db.prepare(`SELECT * FROM ${table} WHERE ${cfg.pk} = ?`).get(v[cfg.pk]));
}

// SQLite only binds null/number/bigint/string/Uint8Array. Coerce everything
// else (booleans, dates) to a string so binding never throws.
function normalize(val) {
  if (val === undefined || val === null) return null;
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number' || typeof val === 'string' || typeof val === 'bigint') return val;
  return String(val);
}

// ── Generic query executor (Supabase-shaped) ──────────────────────────────────
// Returns { data, error } exactly like the Supabase JS client so call sites that
// do `const { data, error } = await sb.from(...)…` need no changes.
export function runQuery(spec = {}) {
  const { table } = spec;
  if (!isValidTable(table)) return { data: null, error: { message: `Unknown table: ${table}`, code: 'BAD_TABLE' } };
  try {
    switch (spec.action) {
      case 'select': return doSelect(spec);
      case 'insert': return doInsert(spec);
      case 'update': return doUpdate(spec);
      case 'upsert': return doUpsert(spec);
      case 'delete': return doDelete(spec);
      default: return { data: null, error: { message: `Unknown action: ${spec.action}`, code: 'BAD_ACTION' } };
    }
  } catch (e) {
    return { data: null, error: { message: e.message, code: 'STORE_ERR' } };
  }
}

function matchRows(table, filters = []) {
  const cfg = TABLES[table];
  const where = [];
  const params = [];
  const post = []; // filters on non-indexed (data) fields, applied in JS
  for (const f of filters) {
    if (cfg.cols.includes(f.col)) {
      if (f.op === 'is' && f.val === null) where.push(`${f.col} IS NULL`);
      else if (f.op === 'is') { where.push(`${f.col} = ?`); params.push(normalize(f.val)); }
      else { where.push(`${f.col} = ?`); params.push(normalize(f.val)); }
    } else {
      post.push(f);
    }
  }
  const sql = `SELECT * FROM ${table}${where.length ? ' WHERE ' + where.join(' AND ') : ''}`;
  let rows = db.prepare(sql).all(...params).map(r => rowToObject(table, r));
  if (post.length) {
    rows = rows.filter(r => post.every(f => (f.op === 'is' && f.val === null) ? (r[f.col] == null) : (String(r[f.col]) === String(f.val))));
  }
  return rows;
}

function doSelect(spec) {
  let rows = matchRows(spec.table, spec.filters);
  if (spec.order?.col) {
    const { col, ascending = true } = spec.order;
    rows.sort((a, b) => {
      const av = a[col] ?? '', bv = b[col] ?? '';
      if (av < bv) return ascending ? -1 : 1;
      if (av > bv) return ascending ? 1 : -1;
      return 0;
    });
  }
  if (typeof spec.limit === 'number') rows = rows.slice(0, spec.limit);

  if (spec.single) {
    if (rows.length === 0) return { data: null, error: { message: 'No rows found', code: 'PGRST116' } };
    return { data: rows[0], error: null };
  }
  if (spec.maybeSingle) return { data: rows[0] || null, error: null };
  return { data: rows, error: null };
}

function doInsert(spec) {
  const list = Array.isArray(spec.values) ? spec.values : [spec.values];
  const written = list.map(v => writeRow(spec.table, v));
  if (spec.single) return { data: written[0] || null, error: null };
  if (spec.returning) return { data: written, error: null };
  return { data: null, error: null };
}

function doUpdate(spec) {
  const cfg = TABLES[spec.table];
  const targets = matchRows(spec.table, spec.filters);
  const updated = [];
  for (const existing of targets) {
    const merged = { ...existing, ...spec.values };
    updated.push(writeRow(spec.table, merged));
  }
  if (spec.single) return { data: updated[0] || null, error: updated.length ? null : { message: 'No rows updated', code: 'PGRST116' } };
  if (spec.returning) return { data: updated, error: null };
  return { data: null, error: null };
}

function doUpsert(spec) {
  const cfg = TABLES[spec.table];
  const list = Array.isArray(spec.values) ? spec.values : [spec.values];
  const conflictCols = (spec.onConflict || cfg.pk).split(',').map(s => s.trim());
  const out = [];
  for (const v of list) {
    const filters = conflictCols.map(c => ({ col: c, op: 'eq', val: v[c] }));
    const existing = matchRows(spec.table, filters)[0];
    out.push(writeRow(spec.table, existing ? { ...existing, ...v } : v));
  }
  if (spec.single) return { data: out[0] || null, error: null };
  if (spec.returning) return { data: out, error: null };
  return { data: null, error: null };
}

function doDelete(spec) {
  const cfg = TABLES[spec.table];
  const targets = matchRows(spec.table, spec.filters);
  const stmt = db.prepare(`DELETE FROM ${spec.table} WHERE ${cfg.pk} = ?`);
  for (const t of targets) stmt.run(normalize(t[cfg.pk]));
  return { data: null, error: null };
}

// ── Server-side helpers ───────────────────────────────────────────────────────
// Used directly by server.mjs (not through the client shim): reading the master
// prompt for generation, and inbox writes from the ingestion pipeline.
export function getUserSettings(userId = LOCAL_USER.id) {
  const row = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId);
  return rowToObject('user_settings', row);
}

export function getArticleMaster(userId = LOCAL_USER.id, publicationId = '') {
  let dp = null;
  if (publicationId) {
    const row = db.prepare('SELECT * FROM publications WHERE id = ? AND user_id = ?').get(publicationId, userId);
    dp = rowToObject('publications', row)?.default_prompts;
  }
  if (!dp) dp = getUserSettings(userId)?.default_prompts;
  const article = dp?._article;
  if (typeof article === 'string') return article;
  return article?.masterPrompt || '';
}

export function getNewsletterMaster(userId = LOCAL_USER.id, publicationId = '') {
  const settings = getUserSettings(userId);
  const dp = settings?.default_prompts || {};
  const nl = dp?._newsletter;
  if (typeof nl === 'string') return nl;
  return nl?.masterPrompt || '';
}

// ── Inbox helpers (used by the ingestion pipeline) ────────────────────────────
export function upsertInboxItem(item) {
  // Dedup key: caller supplies url_hash. ON CONFLICT(user_id,url_hash) keeps the
  // first-seen row so re-ingesting the same feed never creates duplicates.
  const existing = db.prepare('SELECT id FROM inbox_items WHERE user_id = ? AND url_hash = ?')
    .get(item.user_id || LOCAL_USER.id, item.url_hash);
  if (existing) return { inserted: false, id: existing.id };
  const row = writeRow('inbox_items', {
    user_id: LOCAL_USER.id,
    status: 'new',
    ...item,
  });
  return { inserted: true, id: row.id };
}

export function listInbox({ userId = LOCAL_USER.id, publicationId = null, status = null, limit = 200 } = {}) {
  const filters = [{ col: 'user_id', op: 'eq', val: userId }];
  if (publicationId !== undefined && publicationId !== '__all__') {
    filters.push({ col: 'publication_id', op: 'is_or_eq', val: publicationId });
  }
  let rows = matchRows('inbox_items', filters.map(f => f.op === 'is_or_eq'
    ? { col: f.col, op: f.val == null ? 'is' : 'eq', val: f.val }
    : f));
  if (status) rows = rows.filter(r => (r.status || 'new') === status);
  rows.sort((a, b) => String(b.ingested_at || '').localeCompare(String(a.ingested_at || '')));
  return rows.slice(0, limit);
}

export function getDb() { return db; }
