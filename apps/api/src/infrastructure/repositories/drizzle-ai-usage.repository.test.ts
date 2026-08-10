import { describe, expect, it, beforeEach } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { db, sql } from "../../db/client";
import * as schema from "../../db/schema";
import { aiUsage, creators } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleAiUsageRepository } from "./drizzle-ai-usage.repository";

beforeEach(resetDatabase);

const repo = new DrizzleAiUsageRepository(db);

async function seedCreator(name = "Test Creator") {
  const [creator] = await db.insert(creators).values({ name }).returning();
  return creator.id;
}

describe("DrizzleAiUsageRepository.consumeOne", () => {
  it("allows the first call of the day and reports used = 1", async () => {
    const creatorId = await seedCreator();

    const result = await repo.consumeOne({
      creatorId,
      usageDate: "2026-08-10",
      dailyLimit: 3,
    });

    expect(result).toEqual({ allowed: true, used: 1 });

    const rows = await db.select().from(aiUsage);
    expect(rows).toHaveLength(1);
    expect(rows[0].creatorId).toBe(creatorId);
    expect(rows[0].usageDate).toBe("2026-08-10");
    expect(rows[0].messageCount).toBe(1);
  });

  it("allows up to the limit and refuses the call after it, without moving the count", async () => {
    const creatorId = await seedCreator();
    const usageDate = "2026-08-10";
    const dailyLimit = 3;

    expect(await repo.consumeOne({ creatorId, usageDate, dailyLimit })).toEqual({
      allowed: true,
      used: 1,
    });
    expect(await repo.consumeOne({ creatorId, usageDate, dailyLimit })).toEqual({
      allowed: true,
      used: 2,
    });
    // The call AT the limit: this is the third message against a limit of 3, and
    // it must still be allowed — the cap is "no MORE than dailyLimit", not
    // "fewer than dailyLimit".
    expect(await repo.consumeOne({ creatorId, usageDate, dailyLimit })).toEqual({
      allowed: true,
      used: 3,
    });

    // The call AFTER the limit: refused, and the stored count does not move.
    expect(await repo.consumeOne({ creatorId, usageDate, dailyLimit })).toEqual({
      allowed: false,
      used: 3,
    });
    expect(await repo.consumeOne({ creatorId, usageDate, dailyLimit })).toEqual({
      allowed: false,
      used: 3,
    });

    const rows = await db.select().from(aiUsage);
    expect(rows).toHaveLength(1);
    expect(rows[0].messageCount).toBe(3);
  });

  it("keeps a different creator's cap independent", async () => {
    const creatorA = await seedCreator("Creator A");
    const creatorB = await seedCreator("Creator B");
    const usageDate = "2026-08-10";
    const dailyLimit = 1;

    expect(await repo.consumeOne({ creatorId: creatorA, usageDate, dailyLimit })).toEqual({
      allowed: true,
      used: 1,
    });
    // Creator A is now capped; creator B has spent nothing today and is
    // unaffected by A's cap.
    expect(await repo.consumeOne({ creatorId: creatorA, usageDate, dailyLimit })).toEqual({
      allowed: false,
      used: 1,
    });
    expect(await repo.consumeOne({ creatorId: creatorB, usageDate, dailyLimit })).toEqual({
      allowed: true,
      used: 1,
    });

    const rows = await db.select().from(aiUsage);
    expect(rows).toHaveLength(2);
  });

  it("keeps the same creator's cap independent across days", async () => {
    const creatorId = await seedCreator();
    const dailyLimit = 1;

    expect(
      await repo.consumeOne({ creatorId, usageDate: "2026-08-10", dailyLimit })
    ).toEqual({ allowed: true, used: 1 });
    // Same creator, same limit, capped yesterday — but today is a fresh row.
    expect(
      await repo.consumeOne({ creatorId, usageDate: "2026-08-10", dailyLimit })
    ).toEqual({ allowed: false, used: 1 });
    expect(
      await repo.consumeOne({ creatorId, usageDate: "2026-08-11", dailyLimit })
    ).toEqual({ allowed: true, used: 1 });

    const rows = await db.select().from(aiUsage);
    expect(rows).toHaveLength(2);
  });

  /**
   * THE GUARD on the SQL shape, deliberately timing-free: it inspects the
   * statement that actually reached the driver rather than depending on any
   * interleaving. A read-then-write rewrite emits a `select` here and fails
   * this test every time, regardless of scheduling.
   */
  it("emits a single INSERT ... ON CONFLICT DO UPDATE ... RETURNING, not a select", async () => {
    const statements: string[] = [];
    const debugClient = postgres(process.env.DATABASE_URL!, {
      max: 1,
      debug: (_connection, query) => statements.push(query),
    });
    try {
      const creatorId = await seedCreator();
      const debugRepo = new DrizzleAiUsageRepository(drizzle(debugClient, { schema }));

      const result = await debugRepo.consumeOne({
        creatorId,
        usageDate: "2026-08-12",
        dailyLimit: 5,
      });
      expect(result).toEqual({ allowed: true, used: 1 });

      // ONE statement, not a select followed by an insert/update.
      const touchingTheTable = statements.filter((q) => /ai_usage/i.test(q));
      expect(touchingTheTable).toHaveLength(1);

      const statement = touchingTheTable[0].toLowerCase();
      expect(statement).toContain("insert into");
      expect(statement).toContain("on conflict");
      expect(statement).toContain("do update set");
      expect(statement).toContain("returning");
      // The forbidden shape, asserted directly: no bare select anywhere in
      // the statement that performs the check-and-increment.
      expect(statement).not.toContain("select");
    } finally {
      await debugClient.end();
    }
  });

  /**
   * THE REAL GUARD on the race. A bare `Promise.all` of two `consumeOne()`
   * calls does not construct an interleaving; it merely hopes the scheduler
   * happens to overlap them, and in this project that hope has produced a
   * false pass five separate times. So this test FORCES the dangerous
   * interleaving instead:
   *
   *   1. Seed the row one message below the cap (one slot left).
   *   2. Run a "winner" call inside an explicit transaction we hold open
   *      AFTER it has issued its write, so its row lock is provably held
   *      uncommitted.
   *   3. Only once that write is confirmed to have happened do we start the
   *      "loser" call, on a separate connection, targeting the same row.
   *   4. Wait for POSTGRES ITSELF to report the loser's backend as
   *      lock-waiting on `ai_usage` (via `pg_stat_activity`), rather than
   *      guessing with a timer — this is the same mechanism the Phase 3
   *      webhook-replay test uses, chosen for the same reason: a timer
   *      releases whichever way the race went, even on a slow database.
   *   5. Only then release the winner and let both settle.
   *
   * A correct single-statement UPSERT re-evaluates its `WHERE` against the
   * row's CURRENT value once it acquires the lock, so the loser can never
   * see the stale "one slot left" state — at most one of the two calls can
   * come back `allowed: true`. A read-then-write implementation's `select`
   * is a plain non-locking read: it returns the stale committed value to the
   * loser BEFORE the winner commits, regardless of how long the wait is, so
   * the loser also decides "allowed" and both calls exceed the cap. That is
   * the failure this test is built to catch, and did catch in the
   * mutation-check (see the task report).
   */
  it("lets the database arbitrate a forced race — at most one caller may exceed the last slot", async () => {
    const creatorId = await seedCreator();
    const usageDate = "2026-08-10";
    const dailyLimit = 2;

    // One slot left: the next call is allowed, the one after is not — UNLESS
    // the implementation races.
    await db.insert(aiUsage).values({ creatorId, usageDate, messageCount: dailyLimit - 1 });

    let winnerHasRun = false;
    let winnerResult!: { allowed: boolean; used: number };
    let releaseWinner!: () => void;
    const winnerMayCommit = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });

    const winnerTx = db.transaction(async (tx) => {
      const inTransaction = new DrizzleAiUsageRepository(tx);
      winnerResult = await inTransaction.consumeOne({ creatorId, usageDate, dailyLimit });
      winnerHasRun = true;
      await winnerMayCommit;
    });

    try {
      await waitUntil(() => winnerHasRun, "the winner's check-and-increment to be issued");

      const loserPromise = repo.consumeOne({ creatorId, usageDate, dailyLimit });
      await waitUntil(blockedOnAiUsage, "the second caller to block on the contended row");

      releaseWinner();
      await winnerTx;
      const loserResult = await loserPromise;

      const allowedCount = [winnerResult.allowed, loserResult.allowed].filter(Boolean).length;
      expect(allowedCount).toBe(1);

      const [row] = await db.select().from(aiUsage);
      expect(row.messageCount).toBe(dailyLimit);
    } finally {
      // Never leave the transaction open if an assertion above threw, or
      // every later test in this process blocks behind it.
      releaseWinner();
      await winnerTx.catch(() => undefined);
    }
  });

  it("lets the database arbitrate a concurrent race — SMOKE CHECK ONLY, not the guard", async () => {
    // Whether the four calls below actually collide inside the database is up
    // to the OS scheduler, so a green run here proves nothing on its own; the
    // forced-interleaving test above is what pins the mechanism. This is kept
    // only as a cheap sanity check on real concurrent usage.
    const creatorId = await seedCreator();
    const usageDate = "2026-08-10";
    const dailyLimit = 2;

    const results = await Promise.all([
      repo.consumeOne({ creatorId, usageDate, dailyLimit }),
      repo.consumeOne({ creatorId, usageDate, dailyLimit }),
      repo.consumeOne({ creatorId, usageDate, dailyLimit }),
      repo.consumeOne({ creatorId, usageDate, dailyLimit }),
    ]);

    expect(results.filter((r) => r.allowed)).toHaveLength(dailyLimit);

    const [row] = await db.select().from(aiUsage);
    expect(row.messageCount).toBe(dailyLimit);
  });
});

/**
 * Polls `condition` until it holds, then returns. Throws — rather than
 * continuing — if it never does, so a test built on it can never quietly
 * proceed from an unmet precondition and pass for the wrong reason.
 */
async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

/**
 * True once Postgres reports a backend of THIS database waiting on a lock
 * while running a statement against `ai_usage`. This is what makes the
 * forced-race test deterministic instead of sleep-based: the database, not a
 * timer, tells us the second caller has reached the contended row.
 */
async function blockedOnAiUsage(): Promise<boolean> {
  const rows = await sql<{ waiting: number }[]>`
    select count(*)::int as waiting
    from pg_stat_activity
    where datname = current_database()
      and wait_event_type = 'Lock'
      and query ilike '%ai_usage%'
  `;
  return rows[0].waiting > 0;
}
