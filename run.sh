# 1 — the API (port 3000)
bun run --cwd apps/api dev

# 2 — the worker (delivers Telegram invites, runs renewal passes)
bun run --cwd apps/worker dev

# 3 — the web app (port 5173)
bun run --cwd apps/web dev
