# Deployment

How this project gets to production, what to do when it doesn't, and what the
pipeline deliberately refuses to touch.

## At a glance

```
merge to main on GitHub
        │
        ▼
.github/workflows/deploy.yml          push:[main] + workflow_dispatch only
        │                             one at a time; a queued run waits
        ▼
self-hosted runner on the VPS         actions.runner.wildananugrah-diudara.wildandev
        │                             runs as `wildandev`
        ▼
fast-forward /home/wildandev/repo/diudara2 to origin/main
        │                             refuses if that tree has uncommitted work
        ▼
scripts/deploy.sh
        │
        ├─ infra up (docker compose)   postgres + mediamtx
        ├─ frontend build (bun)        ──┐
        ├─ backend install (bun)         │
        ├─ db:migrate                    │
        ├─ pm2 restart diudara-api       │
        ├─ nginx sync + reload           │  both hostnames
        └─ publish dist ─────────────────┘  both document roots
        │
        ▼
verify: /health, then per hostname `/`, `/api` → JSON, `/hls` → MediaMTX
        a failed check fails the job
```

There is no staging environment. A merge to `main` goes straight to the box
that serves real traffic.

## What runs where

| Thing | Where |
|---|---|
| API | pm2 app `diudara-api`, fork mode, `127.0.0.1:3004` |
| Frontend | static bundle in **two** document roots: `/var/www/html/diudara2/dist` and `/var/www/html/diudara/dist` |
| Hostnames | `diudara2.mhamzah.id` and `diudara.mhamzah.id` — same app, neither redirects, each with its own cert |
| Postgres | docker compose in `infra/`, host port **5443**, database `diudara_app` |
| MediaMTX | docker compose, host networking. RTMP **:1935 public**, HLS **:8888 loopback only** |
| RTMP ingest host | **`stream.mhamzah.id`** — DNS-only, points at the origin |
| Deployment clone | `/home/wildandev/repo/diudara2` — also holds the gitignored `.env` files |

**The RTMP host is not a site hostname, and that is not a preference.** Both
site names are proxied by Cloudflare, which forwards HTTP/HTTPS only. An ingest
URL built from them reaches a Cloudflare edge IP with nothing listening on 1935,
and OBS reports "Failed to connect to server". `MEDIAMTX_RTMP_HOST` in
`backend/.env` must name a DNS-only record pointing at this box.

## The trigger

`.github/workflows/deploy.yml`:

- **`push` to `main` and `workflow_dispatch` — nothing else.** This repository is
  public and the runner executes on the production machine. A `pull_request`
  trigger would let anyone who opens a PR run arbitrary code here. Tests on pull
  requests belong in a separate workflow on a GitHub-**hosted** runner.
- **`concurrency: deploy-production`, `cancel-in-progress: false`.** A second
  deploy queues behind the first rather than replacing it. Cancelling midway
  could leave pm2 reloaded against a half-copied bundle, or the database
  migrated for code that never finished deploying.
- **No `actions/checkout`.** The deployment is the clone on the box. A fresh
  checkout would land in the runner's workspace without `backend/.env` or
  `infra/.env` — it would build fine and deploy nothing usable.
- **The fast-forward happens in the workflow, not in `deploy.sh`.** The script
  deploys the tree you are looking at and never pulls, which is right for a
  human running it by hand; CI is the caller that has to decide what "current"
  means, so it does so explicitly: refuse on a dirty tree, then `fetch`,
  `checkout main`, `merge --ff-only`.

`--ff-only` matters: if local `main` has diverged, a plain merge would put
production on a commit that exists on no remote.

## The runner

```bash
systemctl status actions.runner.wildananugrah-diudara.wildandev.service
sudo systemctl restart actions.runner.wildananugrah-diudara.wildandev.service
ls -t /home/wildandev/actions-runner-diudara/_diag/Worker_*.log | head -1   # last job log
```

It runs as `wildandev`, which has passwordless sudo — `deploy.sh` needs it for
`rsync` into `/var/www`, and for `nginx -t` and the reload.

`/home/wildandev/actions-runner-diudara/.path` prepends `~/.bun/bin`, which is
why `bun` and `pm2` resolve inside jobs. A job that fails with
`bun: command not found` means that file was lost — restore it and restart the
service; the runner reads it at job start.

There is a second runner on this box, `actions-runner-carreel`, registered to a
different repository. Leave it alone.

## `scripts/deploy.sh`

Runs the same way by hand as it does in CI:

```bash
scripts/deploy.sh                # everything
scripts/deploy.sh --skip-infra   # don't touch docker compose
scripts/deploy.sh --skip-web     # don't build/publish the frontend
scripts/deploy.sh --skip-api     # don't install/migrate/restart the backend
scripts/deploy.sh --skip-nginx   # don't sync the nginx site configs
scripts/deploy.sh --serial       # one stage at a time, easier to read when debugging
scripts/deploy.sh --help
```

Order is not arbitrary: **api → nginx → web**. The new bundle calls `/api` on
the same origin, so it goes live last, once the API is serving and nginx has a
route to it. Adding the `/api` block while the old bundle is still live is
harmless, because the old bundle never calls it.

Logs from a failed run are kept in `/tmp/diudara-deploy.XXXXXX` and named per
stage. A successful run deletes them.

### What it never does

- **`db:seed`** — it truncates every table. Seeding is a one-off, by hand.
- **Touch `backend/.env` or `infra/.env`** — real secrets, placed once by hand,
  in no git history.
- **`git pull`** — see the trigger section; CI does that, deliberately and
  visibly.

## Deploying by hand

```bash
cd ~/repo/diudara2
git checkout main && git pull --ff-only
scripts/deploy.sh
```

Or re-run from the GitHub UI: **Actions → Deploy to Production → Run workflow**
(`workflow_dispatch`). That deploys whatever `origin/main` points at now, not the
commit of the run you are looking at.

## Rolling back

**The frontend and API** roll back the same way they deploy — by moving the
clone to the commit you want and running the script:

```bash
cd ~/repo/diudara2
git checkout main
git revert <bad-commit> && git push     # preferred
scripts/deploy.sh
```

Prefer `git revert` plus a push over `git reset --hard`: a reset leaves the box
on a commit that `origin/main` no longer matches, and the next CI deploy
fast-forwards straight back onto the bad commit.

**nginx** keeps its own backups. `sync_nginx` copies the live file to
`/etc/nginx/sites-available/<site>.bak.YYYYmmdd-HHMMSS` before replacing it, and
restores every backup automatically if `nginx -t` rejects the result. By hand:

```bash
sudo cp /etc/nginx/sites-available/diudara2.mhamzah.id.bak.20260917-090404 \
        /etc/nginx/sites-available/diudara2.mhamzah.id
sudo nginx -t && sudo systemctl reload nginx
```

**The database does not roll back.** Drizzle migrations here are forward-only —
there are no down migrations. A deploy that migrates and then fails leaves the
schema migrated. Reverting the code is not enough if the new migration dropped
or renamed something; that needs a hand-written forward migration. This is the
sharpest edge in the whole pipeline, and it is why `db:migrate` runs *before*
the pm2 restart rather than after: new code never briefly serves an old schema,
but old code can briefly serve a new one.

## When a deploy fails

| Symptom | Cause | Fix |
|---|---|---|
| Job never starts | Runner service down | `systemctl status actions.runner.wildananugrah-diudara.wildandev.service` |
| `refusing to deploy over them` | Uncommitted changes in `/home/wildandev/repo/diudara2` | Commit or stash them in that directory, re-run the workflow |
| `fatal: Not possible to fast-forward` | Local `main` diverged from origin | `git -C ~/repo/diudara2 status`; reconcile by hand, never force |
| `bun: command not found` | Runner's `.path` lost | Restore `~/actions-runner-diudara/.path`, restart the service |
| `nginx config rejected` | A bad site file in `deploy/nginx/` | The script already restored the previous config and reloaded nothing. Fix the file, re-run |
| `api via nginx returned '200 text/html'` | `/api` is falling through to the SPA | The site config lost its `location ^~ /api/` block |
| `api via nginx: 502` | nginx routes correctly, API is not answering | `pm2 logs diudara-api` |
| `/hls -> MediaMTX (want 302, got 200)` | `/hls` is hitting the SPA fallback | The site config lost its `location ^~ /hls/` block |
| Site up, OBS cannot connect | Ingest URL built from a Cloudflare-proxied name | `MEDIAMTX_RTMP_HOST=stream.mhamzah.id` in `backend/.env`, restart the API |

## Confirming a deploy actually landed

The job passing is good evidence; these are better:

```bash
# the bundle the site serves == the bundle just built
curl -s https://diudara.mhamzah.id/ | grep -o 'assets/index-[^"]*\.js'
ls frontend/dist/assets/index-*.js

# the API restarted, and is serving
pm2 list | grep diudara-api
curl -s localhost:3004/health

# both hostnames, the way deploy.sh checks them
for h in diudara.mhamzah.id diudara2.mhamzah.id; do
  curl -s -o /dev/null -w "$h / %{http_code}\n" "https://$h/"
  curl -s -o /dev/null -w "$h /api %{http_code} %{content_type}\n" "https://$h/api/communities"
done
```

The first CI deploy ran on 2026-09-17 at 12:05 and did exactly this: published
both document roots, restarted the API at 12:05:39, and left both hostnames
serving the merged bundle.

## Secrets

`backend/.env` and `infra/.env` are gitignored, live only on this box, and are
never read or written by CI. `.env.example` files are the committed templates
and their values are placeholders.

Two values must match **across both files** or the MediaMTX webhooks stop
authenticating and every publish is refused:

```
MEDIAMTX_WEBHOOK_SECRET      backend/.env  ==  infra/.env
POSTGRES_PASSWORD            infra/.env    ==  the password inside backend/.env's DATABASE_URL
```

Changing the webhook secret also requires recreating the MediaMTX container,
because compose bakes it into `MTX_AUTHHTTPADDRESS` at container start:

```bash
cd infra && docker compose up -d mediamtx
```

The live secrets were rotated on 2026-09-17 away from the `dev_only_*`
placeholders. Rotating `JWT_SECRET` signs every existing session out; that is
expected, not a fault.
