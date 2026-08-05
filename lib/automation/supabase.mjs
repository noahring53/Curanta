// ── Automation ↔ Supabase (service-role) ─────────────────────────────────────
// The pipeline runs with NO user session, so it talks to Supabase with the
// service-role key, which bypasses RLS. This is deliberately a separate helper
// from server.mjs's sbGet/sbPatch: those use the caller's own token (RLS on),
// which is exactly what a browserless job cannot supply. Env is read at call
// time so import order relative to dotenv never matters.

const base = () => (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const key  = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';

export function configured() {
  return Boolean(base() && key());
}

function headers(extra = {}) {
  const k = key();
  return { apikey: k, Authorization: `Bearer ${k}`, 'Content-Type': 'application/json', ...extra };
}

async function ok(res, label) {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`[sb ${label}] ${res.status} ${body.slice(0, 300)}`);
  }
}

// SELECT. `query` is a raw PostgREST querystring (e.g. "user_id=eq.X&status=eq.active").
// select=* is appended unless the caller already asked for specific columns.
export async function select(table, query = '') {
  const sel = query.includes('select=') ? '' : `${query ? '&' : ''}select=*`;
  const res = await fetch(`${base()}/rest/v1/${table}?${query}${sel}`, { headers: headers() });
  await ok(res, `select ${table}`);
  return res.json();
}

// INSERT. Returns the inserted rows (return=representation). With
// { ignoreDuplicates, onConflict } an existing row is silently skipped and comes
// back as [] — which is how dedupe distinguishes "new" from "already seen".
export async function insert(table, row, { ignoreDuplicates = false, onConflict = '' } = {}) {
  const prefer = ['return=representation', ignoreDuplicates ? 'resolution=ignore-duplicates' : '']
    .filter(Boolean).join(',');
  const qs = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : '';
  const res = await fetch(`${base()}/rest/v1/${table}${qs}`, {
    method: 'POST',
    headers: headers({ Prefer: prefer }),
    body: JSON.stringify(Array.isArray(row) ? row : [row]),
  });
  await ok(res, `insert ${table}`);
  return res.json();
}

export function insertIgnore(table, row, onConflict) {
  return insert(table, row, { ignoreDuplicates: true, onConflict });
}

// UPDATE. `query` selects the rows to patch (return=minimal).
export async function update(table, query, patch) {
  const res = await fetch(`${base()}/rest/v1/${table}?${query}`, {
    method: 'PATCH',
    headers: headers({ Prefer: 'return=minimal' }),
    body: JSON.stringify(patch),
  });
  await ok(res, `update ${table}`);
}
