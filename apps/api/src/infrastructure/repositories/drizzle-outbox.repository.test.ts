import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
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
