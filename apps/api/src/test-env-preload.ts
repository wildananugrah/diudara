/**
 * Makes the test suite runnable from the repo root as well as from apps/api.
 *
 * Bun auto-loads `.env` from the current working directory only. Run `bun test`
 * from the repo root and `apps/api/.env` is never read, so `src/db/client.ts`
 * throws at module evaluation. Every module that imported `db` then fails with
 * `ReferenceError: Cannot access 'db' before initialization` — a temporal-dead-
 * zone artifact that buries the real cause under 8 unrelated failures.
 *
 * Wired in via the root `bunfig.toml` `[test] preload`, this runs before any
 * test module is evaluated, so DATABASE_URL is populated in time. Real
 * environment variables always win over the file, and if no value can be found
 * it fails with one actionable line instead of the TDZ cascade.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// src/ -> apps/api/
const envPath = join(dirname(import.meta.dir), ".env");

if (!process.env.DATABASE_URL) {
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!(key in process.env)) process.env[key] = value;
    }
  }

  if (!process.env.DATABASE_URL) {
    throw new Error(
      `DATABASE_URL is not set and no value was found in ${envPath}. ` +
        `Copy apps/api/.env.example to apps/api/.env, then start Postgres with ` +
        "`docker compose -f infra/docker-compose.yml up -d`.",
    );
  }
}
