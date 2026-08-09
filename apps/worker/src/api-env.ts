import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Parses a `.env` file's contents. Comments, blank lines and lines with no `=`
 * are skipped; the FIRST `=` splits (so a value may contain more), and one layer
 * of surrounding quotes is stripped.
 *
 * Deliberately the same rules as `apps/api/src/test-env-preload.ts`, which solves
 * the same problem for `bun test` run from the repo root.
 */
export function parseDotEnv(contents: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!key) continue;
    parsed[key] = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return parsed;
}

/** The default location: `apps/api/.env`, relative to this file. */
export function defaultApiEnvPath(): string {
  // apps/worker/src -> apps/worker -> apps -> apps/api/.env
  return join(dirname(dirname(import.meta.dir)), "api", ".env");
}

/**
 * Populates `env` from `apps/api/.env`.
 *
 * Bun auto-loads `.env` from the CURRENT WORKING DIRECTORY only, and this process
 * runs from `apps/worker`, which has no `.env` of its own — and should not, because
 * the worker reads the same database and the same messaging tokens as the API.
 * Without this the process died at import time with `DATABASE_URL is not set`,
 * from inside `db/client.ts`, before any of its own code ran (measured).
 *
 * Real environment variables always WIN over the file, so a container that injects
 * its own configuration is unaffected. A missing file is not an error — that is
 * exactly the container case.
 */
export function loadApiEnv(
  options: { envFilePath?: string; env?: Record<string, string | undefined> } = {}
): void {
  const envFilePath = options.envFilePath ?? defaultApiEnvPath();
  const env = options.env ?? process.env;

  if (existsSync(envFilePath)) {
    for (const [key, value] of Object.entries(parseDotEnv(readFileSync(envFilePath, "utf8")))) {
      if (!(key in env)) env[key] = value;
    }
  }

  if (!env.DATABASE_URL) {
    // One actionable line instead of a stack out of the database client.
    throw new Error(
      `DATABASE_URL is not set and no value was found in ${envFilePath}. The worker reads the ` +
        "same database as the API: copy apps/api/.env.example to apps/api/.env, or set " +
        "DATABASE_URL in this process's environment."
    );
  }
}
