/**
 * What every test run does before a single test module is evaluated: find the
 * database configuration, then give this run a database of its own.
 *
 * TWO JOBS, and they have to happen in this order and in this file.
 *
 * 1. MAKE THE SUITE RUNNABLE AT ALL. Bun auto-loads `.env` from the current working
 *    directory only. Run `bun test` from the repo root and `apps/api/.env` is never
 *    read, so `src/db/client.ts` throws at module evaluation and every module that
 *    imported `db` then fails with `ReferenceError: Cannot access 'db' before
 *    initialization` — a temporal-dead-zone artifact that buries the real cause under
 *    8 unrelated failures.
 *
 * 2. ISOLATE THE RUN. See `db/test-database.ts` for what shared state cost this
 *    project. In short: `resetDatabase()` truncates every table, so two concurrent
 *    runs destroyed each other (measured: 168 and 191 failures out of 894, none of
 *    them real), a running worker claimed the suite's outbox rows out from under it,
 *    and a finished run left rows behind. This creates
 *    `diudara_test_<ms>_<pid>_<rand>`, migrates it, points `DATABASE_URL` at it, and
 *    drops it when the run ends.
 *
 * Wired in via `[test] preload` in BOTH `bunfig.toml` files — the repo root's and
 * `apps/api/bunfig.toml` — because Bun reads `bunfig.toml` from the current working
 * directory and does not search upwards, and `bun run test` runs each workspace's
 * `bun test` from that workspace's own directory. Without the second one the primary
 * command developers use would have been the one path with no isolation.
 *
 * TOP-LEVEL AWAIT IS LOAD-BEARING. A preload's module evaluation is awaited before any
 * test file is loaded, which is the only reason `DATABASE_URL` can be rewritten before
 * `db/client.ts` reads it — that module captures the value once, at import.
 */
import { afterAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import {
  COLLECTABLE_AFTER_MS,
  createdAtOfPerRunDatabase,
  isolationIsEnabled,
  perRunDatabaseName,
  withDatabaseName,
} from "./db/test-database";

// src/ -> apps/api/
const apiRoot = dirname(import.meta.dir);
const envPath = join(apiRoot, ".env");

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

/**
 * Drops the databases of runs that died before they could drop their own.
 *
 * The only backstop there is: `afterAll` does not run when a process is killed, and a
 * developer's Ctrl-C on a long suite is not an unusual event. Without this, one
 * abandoned database per interrupted run accumulates for ever.
 *
 * Deliberately conservative in three ways, because the thing on the other side of a
 * mistake here is somebody's local data:
 *
 *  - only names `createdAtOfPerRunDatabase` recognises in full, so `diudara` itself can
 *    never match;
 *  - only ones older than `COLLECTABLE_AFTER_MS`, so a concurrent run's fresh database
 *    is never a candidate even in the window before it has any connections;
 *  - only ones with no backends connected, and with a plain `drop database` rather than
 *    `with (force)`, so a long-running suite whose database has aged past the threshold
 *    is skipped rather than shot.
 *
 * Every failure is swallowed: this is housekeeping, and a run must not fail because
 * somebody else's leftovers could not be tidied.
 */
async function collectAbandonedDatabases(admin: postgres.Sql): Promise<void> {
  try {
    const candidates = await admin<{ datname: string; backends: number }[]>`
      select d.datname,
             (select count(*)::int from pg_stat_activity a where a.datname = d.datname) as backends
      from pg_database d
      where d.datname like ${`${"diudara_test_"}%`}
    `;
    const now = Date.now();
    for (const { datname, backends } of candidates) {
      const createdAt = createdAtOfPerRunDatabase(datname);
      if (createdAt === null) continue;
      if (now - createdAt < COLLECTABLE_AFTER_MS) continue;
      if (backends > 0) continue;
      try {
        await admin.unsafe(`drop database if exists "${datname}"`);
        console.log(`[test] collected an abandoned test database: ${datname}`);
      } catch {
        // Somebody connected between the count and the drop. Next run's problem.
      }
    }
  } catch {
    // No permission to read pg_database, or the server went away. Not this run's job.
  }
}

if (isolationIsEnabled(process.env)) {
  const baseUrl = process.env.DATABASE_URL;
  const databaseName = perRunDatabaseName();

  // The maintenance database, because `create database` cannot run from inside the
  // database being created. Same host and credentials; only the path changes.
  const admin = postgres(withDatabaseName(baseUrl, "postgres"), {
    max: 1,
    onnotice: () => undefined,
  });
  try {
    await collectAbandonedDatabases(admin);
    // No bound parameter is possible in `create database`; the name comes from
    // `Date.now()`, `process.pid` and `Math.random()` and matches `[a-z0-9_]+`.
    await admin.unsafe(`create database "${databaseName}"`);
  } finally {
    await admin.end();
  }

  // BEFORE anything imports `db/client.ts`, which reads this once and keeps it.
  process.env.DATABASE_URL = withDatabaseName(baseUrl, databaseName);
  // Published so `assertTestEnvironment` can refuse to truncate a database this run
  // does not own — see its docstring for why NODE_ENV=test alone was not enough.
  process.env.DIUDARA_TEST_DATABASE = databaseName;

  // The GENERATED migrations, run by drizzle's own migrator rather than by a hand-kept
  // list of DDL: a schema built any other way would drift from the one `db:migrate`
  // produces, and the suite would be testing a database no deployment has. It also
  // means `drizzle/README.md`'s `0003` hazard cannot bite a test run — the database is
  // empty by construction, which is the state that migration requires.
  const migrationClient = postgres(process.env.DATABASE_URL, { max: 1 });
  try {
    await migrate(drizzle(migrationClient), { migrationsFolder: join(apiRoot, "drizzle") });
  } finally {
    await migrationClient.end();
  }

  console.log(
    `[test] isolated run: database ${databaseName} (set DIUDARA_TEST_DB_ISOLATION=off to ` +
      "run against DATABASE_URL and keep the rows)"
  );

  // Registered in the preload, which makes it a hook for the WHOLE run rather than for
  // one file — verified: Bun calls it once, after the last test file, and awaits it.
  afterAll(async () => {
    // The suite's pool has to let go before the database can be dropped. `db/client.ts`
    // may never have been imported (a run of nothing but pure-domain tests), and
    // importing it here is harmless: it only opens connections lazily.
    try {
      const { sql } = await import("./db/client");
      await sql.end({ timeout: 5 });
    } catch {
      // Nothing to close.
    }

    const cleanup = postgres(withDatabaseName(baseUrl, "postgres"), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      // `with (force)` here and NOT in the collector: this is our own database at the
      // end of our own run, so any connection still on it is ours — a pool that has not
      // finished closing — and waiting for it would hang the run's exit.
      await cleanup.unsafe(`drop database if exists "${databaseName}" with (force)`);
    } catch (err) {
      // Loud, but not fatal: the tests have already passed or failed on their merits,
      // and the collector above will get this database on some later run.
      console.warn(
        `[test] could not drop ${databaseName}: ${err instanceof Error ? err.message : err}`
      );
    } finally {
      await cleanup.end();
    }
  });
}
