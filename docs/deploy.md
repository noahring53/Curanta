# Deploying Curanta for true 24/7 auto-draft

Running on this PC only checks sources while the machine is awake. To have
Auto-Draft run every hour and email you drafts even when your computer is off,
deploy the server to a small always-on host. Any platform that runs a Docker
container works; the app is self-contained (Node + built-in SQLite, no external
database).

## What you need

1. A host account (Railway, Fly.io, Render, or any small VPS — ~$5/mo).
2. A **persistent volume** mounted at `/data` (this is where the SQLite database
   lives — without it, your sources/articles/settings reset on every redeploy).
3. These environment variables set on the host:

   | Variable | Value | Notes |
   |---|---|---|
   | `ANTHROPIC_API_KEY` | your key | required for real drafting |
   | `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | or whatever your account supports |
   | `RESEND_API_KEY` | your Resend key | enables the email digest |
   | `DIGEST_EMAIL_TO` | your email | where drafts are sent |
   | `INBOX_REFRESH_MINUTES` | `30` | keeps the Inbox warm between auto-draft runs |
   | `DB_PATH` | `/data/curanta.db` | already set in the Dockerfile |
   | `TRUST_PROXY` | `1` | already set in the Dockerfile |

   `PORT` is provided by the platform automatically — don't hardcode it.

The `Dockerfile` in the repo root already sets `DB_PATH`, `TRUST_PROXY`, and the
start command, so most hosts need nothing more than the volume + the secrets above.

## Railway (quickest)

1. Push this repo to GitHub.
2. Railway → New Project → Deploy from GitHub repo. It detects the `Dockerfile`.
3. Add a Volume, mount path `/data`.
4. Variables tab → add the secrets from the table above.
5. Deploy. Open the generated URL, go to **Settings → AI Settings → Automation**,
   turn **Auto-Draft on**. That setting persists in the database on the volume.

## Fly.io

```bash
fly launch --no-deploy            # generates fly.toml from the Dockerfile
fly volume create curanta_data --size 1
# In fly.toml, mount it:
#   [mounts]
#   source = "curanta_data"
#   destination = "/data"
fly secrets set ANTHROPIC_API_KEY=... ANTHROPIC_MODEL=claude-sonnet-4-6 \
  RESEND_API_KEY=... DIGEST_EMAIL_TO=you@example.com INBOX_REFRESH_MINUTES=30
fly deploy
```

## Any VPS with Docker

```bash
docker build -t curanta .
docker run -d --name curanta --restart unless-stopped -p 80:3000 \
  -v /srv/curanta-data:/data \
  -e ANTHROPIC_API_KEY=... -e ANTHROPIC_MODEL=claude-sonnet-4-6 \
  -e RESEND_API_KEY=... -e DIGEST_EMAIL_TO=you@example.com \
  -e INBOX_REFRESH_MINUTES=30 \
  curanta
```

`--restart unless-stopped` gives you crash/reboot recovery.

## Bringing your existing data along (optional)

To keep the sources/articles you already created on this PC, copy
`data/curanta.db` up to the host's volume at `/data/curanta.db` before first boot
(e.g. `fly ssh sftp` / `railway run` / `scp`). Otherwise the cloud instance starts
with a fresh database and you just re-add your sources in the UI.

## Security note

There's no login on the single-operator build. If you deploy it to a public URL,
put it behind the platform's access control (a private network, basic-auth proxy,
or IP allowlist) so only you can reach it — it holds your API keys' capabilities.
