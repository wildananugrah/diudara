import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { db } from "../../db/client";
import * as schema from "../../db/schema";
import { outbox } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleOutboxRepository } from "./drizzle-outbox.repository";

beforeEach(resetDatabase);

const repository = () => new DrizzleOutboxRepository(db);

async function rowById(id: string) {
  const [row] = await db.select().from(outbox).where(eq(outbox.id, id));
  return row;
}

const GRANT = { eventType: "grant_access", payload: { subscriptionId: "sub-1" } };

describe("DrizzleOutboxRepository.enqueue", () => {
  it("writes a pending row with no attempts yet", async () => {
    const { id } = await repository().enqueue(GRANT);

    const row = await rowById(id);
    expect(row.eventType).toBe("grant_access");
    expect(row.payload).toEqual({ subscriptionId: "sub-1" });
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.lastError).toBeNull();
  });
});

describe("DrizzleOutboxRepository.claimBatch", () => {
  it("claims a due pending row, marking it processing and counting the attempt", async () => {
    const { id } = await repository().enqueue(GRANT);

    const claimed = await repository().claimBatch(10);

    expect(claimed.map((row) => row.id)).toEqual([id]);
    expect(claimed[0].eventType).toBe("grant_access");
    expect(claimed[0].payload).toEqual({ subscriptionId: "sub-1" });
    expect(claimed[0].attempts).toBe(1);

    const row = await rowById(id);
    // Claimed rows must not be claimable again, or two workers send twice.
    expect(row.status).toBe("processing");
    expect(row.attempts).toBe(1);
  });

  it("does not claim a row whose retry is not due yet", async () => {
    const { id } = await repository().enqueue(GRANT);
    await repository().claimBatch(10);
    await repository().markFailed(id, "telegram down", new Date(Date.now() + 60_000));

    expect(await repository().claimBatch(10)).toEqual([]);
  });

  it("claims a row again once its retry falls due", async () => {
    const { id } = await repository().enqueue(GRANT);
    await repository().claimBatch(10);
    await repository().markFailed(id, "telegram down", new Date(Date.now() - 1_000));

    const claimed = await repository().claimBatch(10);
    expect(claimed.map((row) => row.id)).toEqual([id]);
    // The attempt counter is what a bounded-retry policy reads.
    expect(claimed[0].attempts).toBe(2);
  });

  /**
   * The batch bound is a real bound, not a suggestion.
   *
   * The first implementation used `WHERE id IN (SELECT ... LIMIT n FOR UPDATE SKIP
   * LOCKED)`, and this test caught it returning THREE rows for `claimBatch(2)`
   * intermittently in full-suite runs — a sublink's LIMIT is only evaluated once
   * if the planner chooses to, and an UPDATE re-checks its qualification for any
   * row a concurrent transaction has touched. The claim is a MATERIALIZED CTE now,
   * which cannot be re-evaluated.
   *
   * Both the returned rows AND the table are asserted: if this ever regresses,
   * the second assertion says whether the UPDATE really touched too many rows or
   * merely reported them.
   */
  it("honours the batch limit, in what it returns AND in what it touches", async () => {
    for (let i = 0; i < 5; i += 1) {
      await repository().enqueue({ eventType: "grant_access", payload: { n: i } });
    }

    expect(await repository().claimBatch(2)).toHaveLength(2);

    const rows = await db.select().from(outbox);
    expect(rows.filter((row) => row.status === "processing")).toHaveLength(2);
    expect(rows.filter((row) => row.status === "pending")).toHaveLength(3);
  });

  it("returns an empty batch when there is nothing to do", async () => {
    expect(await repository().claimBatch(10)).toEqual([]);
  });

  /**
   * Two workers polling the same table must never both get the same row: each
   * `grant_access` row is one invite link, and a double send means two links for
   * one paying member.
   *
   * This is a PROBABILISTIC detector on its own — Phase 3 learned that a
   * select-then-update mutant can survive a racing test. Task 5 owes the
   * deterministic pin (and the backoff/bounded-retry policy that consumes
   * `attempts`); this asserts the property the conditional claim exists for.
   */
  it("never hands the same row to two concurrent claims", async () => {
    for (let i = 0; i < 20; i += 1) {
      await repository().enqueue({ eventType: "grant_access", payload: { n: i } });
    }

    const [a, b] = await Promise.all([
      repository().claimBatch(20),
      repository().claimBatch(20),
    ]);

    const ids = [...a, ...b].map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(20);
  });
});

/**
 * THE guard on the claim, and deliberately timing-free — the racing test above is
 * a smoke check, not a guard. Phase 3 measured a select-then-insert mutant
 * surviving a full suite and failing an isolated racing test in only 4 of 6 runs,
 * so the mechanism this phase's invite links depend on may not be pinned by a
 * coin flip.
 *
 * The two tests below fail EVERY run against a select-then-update rewrite: the
 * first because that shape emits two statements, the second because it blocks on
 * (and then steals) a row another transaction already holds. The first also fails
 * against the `WHERE id IN (SELECT ... LIMIT n FOR UPDATE SKIP LOCKED)` sublink
 * form that was measured returning 3 rows for `claimBatch(2)`.
 */
describe("DrizzleOutboxRepository.claimBatch — the mechanism, pinned deterministically", () => {
  it("claims in ONE statement: a materialized CTE with FOR UPDATE SKIP LOCKED", async () => {
    // Deterministic by construction: it inspects the SQL that reached the driver,
    // so it cannot depend on interleaving at all.
    await repository().enqueue(GRANT);

    const statements: string[] = [];
    const debugClient = postgres(process.env.DATABASE_URL!, {
      max: 1,
      debug: (_connection, query) => statements.push(query),
    });
    try {
      const debugRepo = new DrizzleOutboxRepository(drizzle(debugClient, { schema }));

      expect(await debugRepo.claimBatch(1)).toHaveLength(1);

      // ONE statement, not two: a select-then-update emits two.
      const touchingTheTable = statements.filter((query) => /outbox/i.test(query));
      expect(touchingTheTable).toHaveLength(1);

      const statement = touchingTheTable[0].toLowerCase();
      // MATERIALIZED is the fix for the measured over-claim: without it the
      // planner may re-evaluate the candidate set and the batch bound stops
      // holding. Asserted as text because no behavioural test reproduced it.
      expect(statement).toContain("as materialized");
      // Locks the candidates and makes a concurrent claimer skip rather than
      // block — the second test below proves the behaviour.
      expect(statement).toContain("for update skip locked");
      // The claim is the UPDATE itself, conditional on the row still being due,
      // and it reports what it took.
      expect(statement).toMatch(/update\s+"?outbox"?/);
      expect(statement).toContain("returning");
      expect(statement).toContain("'pending'");
      expect(statement).toContain("next_attempt_at");
      // The forbidden shape, asserted directly: no statement READS the table on
      // its own. A select-then-update decides in one statement and acts in
      // another, and its first one starts with `select ... from outbox`.
      // (Statements that never mention outbox — postgres.js's own type-catalog
      // query — are not filtered in above, so they cannot mask this.)
      expect(touchingTheTable.filter((query) => /^\s*select/i.test(query))).toHaveLength(0);
      expect(statement.trimStart().startsWith("with")).toBe(true);
    } finally {
      await debugClient.end();
    }
  });

  it("SKIPS a row another transaction holds — it neither blocks on it nor claims it", async () => {
    // The interleaving that actually breaks a select-then-update, forced instead
    // of hoped for. One claimer runs inside an open transaction and holds its
    // row's lock uncommitted; a second claimer then runs on another connection.
    //
    // FOR UPDATE SKIP LOCKED steps over the held row and returns promptly with
    // only the other one. A select-then-update sees BOTH rows as pending (the
    // holder's UPDATE is invisible to its snapshot), then blocks forever on the
    // held row inside its own UPDATE — so this test fails on the timeout, every
    // run, rather than when the scheduler happens to cooperate.
    const first = await repository().enqueue({ eventType: "grant_access", payload: { n: 1 } });
    const second = await repository().enqueue({ eventType: "grant_access", payload: { n: 2 } });
    // Explicit due times, so which row a `limit 1` takes is not decided by two
    // defaultNow() values that may land in the same instant.
    await db
      .update(outbox)
      .set({ nextAttemptAt: new Date(Date.now() - 10_000) })
      .where(eq(outbox.id, first.id));
    await db
      .update(outbox)
      .set({ nextAttemptAt: new Date(Date.now() - 5_000) })
      .where(eq(outbox.id, second.id));

    let releaseHolder!: () => void;
    const holderMayCommit = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let held: string[] | undefined;

    const holder = db.transaction(async (tx) => {
      held = (await new DrizzleOutboxRepository(tx).claimBatch(1)).map((row) => row.id);
      await holderMayCommit;
    });

    try {
      await waitUntil(() => held !== undefined, "the holding transaction to claim its row");
      expect(held).toEqual([first.id]);

      const outside = await withTimeout(
        repository().claimBatch(5),
        "the second claim to return without blocking on the held row"
      );

      // Only the row nobody holds. Anything else means the claim is not skipping
      // locked rows — which is a second worker sending a second invite link.
      expect(outside.map((row) => row.id)).toEqual([second.id]);
      expect(outside[0].attempts).toBe(1);
    } finally {
      releaseHolder();
      await holder.catch(() => undefined);
    }

    // Both rows ended up claimed exactly once, by exactly one claimer each.
    const rows = await db.select().from(outbox);
    expect(rows.filter((row) => row.status === "processing")).toHaveLength(2);
    expect(rows.every((row) => row.attempts === 1)).toBe(true);
  });
});

/**
 * A worker that is SIGKILLed (or whose box dies) mid-send leaves its row
 * `processing` with nothing to move it: `claimBatch` only looks at `pending`, so
 * the paying member never gets their invite and no retry ever happens. Task 3/4
 * left this gap open; this closes it.
 */
describe("DrizzleOutboxRepository.reclaimStaleProcessing", () => {
  async function forceUpdatedAt(id: string, updatedAt: Date) {
    await db.update(outbox).set({ updatedAt }).where(eq(outbox.id, id));
  }

  it("returns a row stranded in processing to pending, so it is claimed again", async () => {
    const { id } = await repository().enqueue(GRANT);
    await repository().claimBatch(10);
    await forceUpdatedAt(id, new Date(Date.now() - 10 * 60_000));

    expect(await repository().reclaimStaleProcessing(new Date(Date.now() - 60_000))).toBe(1);

    const row = await rowById(id);
    expect(row.status).toBe("pending");
    // Says WHY it came back, for an operator reading the table.
    expect(row.lastError).toContain("reclaimed");

    const reclaimed = await repository().claimBatch(10);
    expect(reclaimed.map((r) => r.id)).toEqual([id]);
    // The attempt already spent is NOT refunded: a row that strands a worker
    // every time must still hit the retry bound rather than loop forever.
    expect(reclaimed[0].attempts).toBe(2);
  });

  it("leaves a row that is still being worked on alone", async () => {
    const { id } = await repository().enqueue(GRANT);
    await repository().claimBatch(10);

    expect(await repository().reclaimStaleProcessing(new Date(Date.now() - 60_000))).toBe(0);
    expect((await rowById(id)).status).toBe("processing");
  });

  it("never resurrects a sent or permanently failed row", async () => {
    const sent = await repository().enqueue(GRANT);
    const failed = await repository().enqueue(GRANT);
    await repository().claimBatch(10);
    await repository().markSent(sent.id);
    await repository().markPermanentlyFailed(failed.id, "gave up");
    await forceUpdatedAt(sent.id, new Date(Date.now() - 10 * 60_000));
    await forceUpdatedAt(failed.id, new Date(Date.now() - 10 * 60_000));

    expect(await repository().reclaimStaleProcessing(new Date(Date.now() - 60_000))).toBe(0);
    expect((await rowById(sent.id)).status).toBe("sent");
    expect((await rowById(failed.id)).status).toBe("failed");
  });
});

/**
 * Polls `condition` until it holds, then returns. Throws — rather than
 * continuing — if it never does, so a test built on it can never quietly proceed
 * from an unmet precondition and pass for the wrong reason. Same helper as
 * drizzle-webhook-event.repository.test.ts.
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
 * Fails with a readable message instead of hanging when `work` never settles.
 * A claim that BLOCKS is a specific defect (it is not skipping locked rows), and
 * a defect deserves an assertion failure that says so, not a suite timeout.
 */
async function withTimeout<T>(work: Promise<T>, what: string, timeoutMs = 3000): Promise<T> {
  const timedOut = Symbol("timed out");
  const result = await Promise.race([
    work,
    Bun.sleep(timeoutMs).then(() => timedOut),
  ]);
  if (result === timedOut) {
    throw new Error(
      `timed out after ${timeoutMs}ms waiting for ${what} — the claim BLOCKED, which means ` +
        "it is not stepping over rows another transaction holds"
    );
  }
  return result as T;
}

describe("DrizzleOutboxRepository marking", () => {
  it("marks a row sent, and it is never claimed again", async () => {
    const { id } = await repository().enqueue(GRANT);
    await repository().claimBatch(10);

    await repository().markSent(id);

    expect((await rowById(id)).status).toBe("sent");
    expect(await repository().claimBatch(10)).toEqual([]);
  });

  it("records the error and the next attempt time on a failure", async () => {
    const { id } = await repository().enqueue(GRANT);
    await repository().claimBatch(10);
    const due = new Date(Date.now() + 30_000);

    await repository().markFailed(id, "telegram createChatInviteLink failed", due);

    const row = await rowById(id);
    expect(row.status).toBe("pending");
    expect(row.lastError).toBe("telegram createChatInviteLink failed");
    expect(row.nextAttemptAt.getTime()).toBeCloseTo(due.getTime(), -3);
  });

  it("truncates an error too long for the column instead of failing the update", async () => {
    // last_error is varchar(500). A driver error thrown HERE would lose the
    // retry bookkeeping for a row that already failed once.
    const { id } = await repository().enqueue(GRANT);
    await repository().claimBatch(10);

    await repository().markFailed(id, "x".repeat(2_000), new Date());

    expect((await rowById(id)).lastError!.length).toBe(500);
  });

  it("marks a row permanently failed, and it is never claimed again", async () => {
    const { id } = await repository().enqueue(GRANT);
    await repository().claimBatch(10);

    await repository().markPermanentlyFailed(id, "giving up after 5 attempts");

    const row = await rowById(id);
    expect(row.status).toBe("failed");
    expect(row.lastError).toBe("giving up after 5 attempts");
    expect(await repository().claimBatch(10)).toEqual([]);
  });

  it("truncates a permanent-failure error too", async () => {
    const { id } = await repository().enqueue(GRANT);

    await repository().markPermanentlyFailed(id, "y".repeat(2_000));

    expect((await rowById(id)).lastError!.length).toBe(500);
  });
});
