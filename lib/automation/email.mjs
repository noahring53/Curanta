// ── Email transport: Resend ───────────────────────────────────────────────────
// Raw REST via fetch, matching the app's Supabase/Beehiiv style — no new npm
// dependency. Reads the key at call time so import order never matters.

export function configured() {
  return Boolean(process.env.RESEND_API_KEY);
}

export async function sendEmail({ to, from, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY not set');
  if (!to) throw new Error('DIGEST_TO not set');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: from || 'Curanta <onboarding@resend.dev>',
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
