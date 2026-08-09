/**
 * ONE DATABASE PER TEST RUN.
 *
 * Why this exists, in the words of three phases' ledgers: test isolation used to be
 * per-`DATABASE_URL`, which is to say there was none. Every test file called
 * `resetDatabase()`, which truncates every table, and every process pointed at the same
 * `diudara` database. So:
 *
 *  - TWO CONCURRENT RUNS destroyed each other. Measured on this branch immediately
 *    before this module was written: 168 failures in one run and 191 in the other, out
 *    of 894 tests, none of them a real defect.
 *  - A RUNNING WORKER stole the suite's outbox rows. It polls every 5 seconds, claims
 *    whatever it finds and sends it, so a test that enqueued a row and then asserted
 *    the row was claimable found it already `sent` — and the test that asserted a
 *    member was messaged once found them messaged twice.
 *  - A COMPLETED RUN left its rows behind (the fixtures clean up in `beforeEach`, not
 *    `afterAll`), which is the trigger `drizzle/README.md` records for migration `0003`
 *    failing on a non-empty `community` table.
 *
 * Phases 3, 4 and 5 each lost time to "unreproducible" failures that were one of these.
 * The fix is to stop sharing: the test preload creates `diudara_test_<ms>_<pid>_<rand>`,
 * migrates it, points `DATABASE_URL` at it, and drops it when the run finishes. Nothing
 * else in the suite changes — `resetDatabase()` still truncates, it just truncates a
 * database nobody else can see.
 *
 * A SCHEMA per run was the other candidate and was rejected for one concrete reason:
 * `drizzle-webhook-event.repository.test.ts` waits for a lock by asking
 * `pg_stat_activity` for a blocked backend `where datname = current_database()`, which
 * is scoped by DATABASE and not by schema. Two concurrent runs sharing a database would
 * each see the other's blocked backend and proceed from a precondition they had not
 * actually reached — a false pass, which is worse than the failures being fixed.
 *
 * This module holds only the parts that can be tested without a server. The preload
 * (`src/test-env-preload.ts`) does the connecting.
 */

/**
 * The prefix that makes a database collectable.
 *
 * Everything the garbage collector may drop starts with this, and `createdAtOfPerRunDatabase`
 * is the only thing that decides membership. `diudara` itself must never match — that is
 * a developer's local data, and dropping it is not recoverable.
 */
export const PER_RUN_DATABASE_PREFIX = "diudara_test_";

/**
 * `diudara_test_<epochMs>_<pid>_<random>`.
 *
 * The TIMESTAMP is not decoration: `pg_database` records no creation time, so a run
 * that was killed before it could drop its database leaves something that has to be
 * identifiable as old. Embedding the instant in the name is the only place to put it
 * that survives the process that made it.
 *
 * The PID and the random suffix are both needed. Two `bun test` processes can start
 * inside the same millisecond (`bun run --workspaces test` twice over), and one process
 * asking twice — which the tests here do — must get two names.
 *
 * Lower-case letters, digits and underscores only, because the name is interpolated
 * into `create database`, which takes no bound parameters. It comes from
 * `Date.now()`, `process.pid` and `Math.random()`, so there is no untrusted input to
 * carry — the character class is there so that stays true if somebody ever adds a
 * component that does.
 */
export function perRunDatabaseName(): string {
  const random = Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, "0");
  return `${PER_RUN_DATABASE_PREFIX}${Date.now()}_${process.pid}_${random}`;
}

/**
 * When a per-run database was created, or `null` if the name is not one of ours.
 *
 * `null` is the important answer. This function is asked about EVERY database on the
 * server, including `postgres`, `template1` and the developer's own `diudara`, and its
 * answer is what the collector acts on. So it insists on the whole shape — prefix, a
 * plausible epoch-millisecond timestamp, a pid and a suffix — rather than just the
 * prefix.
 */
export function createdAtOfPerRunDatabase(name: string): number | null {
  const match = new RegExp(`^${PER_RUN_DATABASE_PREFIX}(\\d{13})_(\\d+)_([a-z0-9]{6})$`).exec(name);
  if (match === null) return null;
  const createdAtMs = Number(match[1]);
  return Number.isSafeInteger(createdAtMs) ? createdAtMs : null;
}

/**
 * The same connection string, pointed at a different database.
 *
 * `URL` rather than string surgery, so credentials, port and query parameters (a
 * managed Postgres puts `sslmode=require` there) all survive untouched, and a
 * percent-encoded password is neither decoded nor re-encoded — either would produce a
 * string that cannot authenticate.
 */
export function withDatabaseName(connectionString: string, databaseName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

/**
 * Whether this process should get a database of its own.
 *
 * Gated on `NODE_ENV === "test"` — which `bun test` sets itself, and which
 * `assertTestEnvironment` already relies on — and not merely on "the preload was
 * loaded": creating and dropping databases is not something to do on the strength of a
 * file having been imported.
 *
 * `DIUDARA_TEST_DB_ISOLATION=off` is the escape hatch, for the one thing per-run
 * databases genuinely make harder: inspecting what a failing run left in its tables.
 * Any OTHER value of the switch leaves isolation ON, because failing closed here means
 * failing isolated — a typo must not quietly point the suite at the development
 * database and truncate it.
 */
export function isolationIsEnabled(env: {
  NODE_ENV?: string | undefined;
  DIUDARA_TEST_DB_ISOLATION?: string | undefined;
}): boolean {
  if (env.NODE_ENV !== "test") return false;
  return env.DIUDARA_TEST_DB_ISOLATION?.trim().toLowerCase() !== "off";
}

/**
 * How long a per-run database has to have existed before another run may collect it.
 *
 * The collector runs at the START of every run, so it will inevitably meet the fresh
 * databases of runs that are still going. A CONNECTION check alone is not enough to
 * tell them apart: between `create database` and the suite's first query there is a
 * window in which a live run's database has no backends at all. Ten minutes is far
 * longer than that window and far shorter than the time between somebody's crashed run
 * and their next one.
 */
export const COLLECTABLE_AFTER_MS = 10 * 60_000;
