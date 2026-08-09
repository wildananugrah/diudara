import { describe, expect, it, beforeEach } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { db, sql } from "../../db/client";
import * as schema from "../../db/schema";
import { webhookEvents } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleWebhookEventRepository } from "./drizzle-webhook-event.repository";

beforeEach(resetDatabase);

const repo = new DrizzleWebhookEventRepository(db);

function event(providerEventId: string) {
  return {
    provider: "xendit",
    providerEventId,
    eventType: "invoice.paid",
    payload: { id: "inv_1", status: "PAID" },
  };
}

describe("DrizzleWebhookEventRepository.recordIfNew", () => {
  it("returns true the first time an event id is seen", async () => {
    expect(await repo.recordIfNew(event("evt-1"))).toBe(true);

    const rows = await db.select().from(webhookEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe("xendit");
    expect(rows[0].providerEventId).toBe("evt-1");
    expect(rows[0].eventType).toBe("invoice.paid");
    expect(rows[0].payload).toEqual({ id: "inv_1", status: "PAID" });
    expect(rows[0].processedAt).toBeInstanceOf(Date);
  });

  it("returns false for a replay and writes no second row", async () => {
    await repo.recordIfNew(event("evt-1"));

    expect(await repo.recordIfNew(event("evt-1"))).toBe(false);
    expect(await db.select().from(webhookEvents)).toHaveLength(1);
  });

  it("keeps distinct event ids independent", async () => {
    expect(await repo.recordIfNew(event("evt-1"))).toBe(true);
    expect(await repo.recordIfNew(event("evt-2"))).toBe(true);
    expect(await db.select().from(webhookEvents)).toHaveLength(2);
  });

  /**
   * The two tests below are THE guard on this method, and they are deliberately
   * timing-free. The concurrent smoke check further down is not a guard.
   *
   * Measured (final whole-branch review, I3): `recordIfNew` rewritten as the
   * select-then-insert its docstring forbids, then this file run in isolation —
   * **0 of 6 runs failed**. The concurrent test below only fires when the OS
   * happens to interleave the two callers inside the same instant, which is a
   * scheduling accident, not an assertion. This is the most load-bearing line in
   * the phase (it is the ENTIRE replay defence), so its test may not be a coin
   * flip.
   */
  it("emits a single INSERT ... ON CONFLICT DO NOTHING, not a select then an insert", async () => {
    // Deterministic by construction: it inspects the SQL that reached the
    // driver, so it cannot depend on interleaving at all. A select-then-insert
    // rewrite emits no `on conflict` clause and fails here every time.
    const statements: string[] = [];
    const debugClient = postgres(process.env.DATABASE_URL!, {
      max: 1,
      debug: (_connection, query) => statements.push(query),
    });
    try {
      const debugRepo = new DrizzleWebhookEventRepository(drizzle(debugClient, { schema }));

      expect(await debugRepo.recordIfNew(event("evt-sql-shape"))).toBe(true);

      // ONE statement, not two: a select-then-insert emits two.
      const touchingTheTable = statements.filter((q) => /webhook_event/i.test(q));
      expect(touchingTheTable).toHaveLength(1);

      const statement = touchingTheTable[0].toLowerCase();
      expect(statement).toContain("insert into");
      // The conflict target is named by drizzle, so match around it rather than
      // pinning the exact identifier quoting.
      expect(statement).toMatch(/on conflict \("provider_event_id"\) do nothing/);
      // ...RETURNING is what makes "did I insert it?" answerable at all.
      expect(statement).toContain("returning");
      // The forbidden shape, asserted directly.
      expect(statement).not.toContain("select");
    } finally {
      await debugClient.end();
    }
  });

  it("reports a replay — rather than throwing — while the winner is still UNCOMMITTED", async () => {
    // The interleaving that actually breaks a select-then-insert, forced instead
    // of hoped for. One caller inserts inside an open transaction and holds it;
    // a second caller on another connection then issues its statement and is
    // BLOCKED by the uncommitted unique-index tuple. We wait for Postgres itself
    // to report that backend as lock-waiting — so this test never proceeds on a
    // guess — and only then commit.
    //
    // Both implementations block, so the wait terminates either way. What
    // differs is the outcome: `on conflict do nothing` sees the committed row
    // and returns zero rows (false), while a select-then-insert already decided
    // "not seen" from its own snapshot and raises
    // webhook_event_provider_event_id_unique — a 500 on the webhook path, after
    // the winner has already activated the subscription.
    let releaseWinner!: () => void;
    const winnerMayCommit = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    let winnerHasInserted = false;

    const winner = db.transaction(async (tx) => {
      const inTransaction = new DrizzleWebhookEventRepository(tx);
      expect(await inTransaction.recordIfNew(event("evt-uncommitted"))).toBe(true);
      winnerHasInserted = true;
      await winnerMayCommit;
    });

    try {
      await waitUntil(() => winnerHasInserted, "the winner's INSERT to be issued");

      const loser = repo.recordIfNew(event("evt-uncommitted"));
      await waitUntil(blockedOnWebhookEvent, "the second caller to block on the unique index");
      releaseWinner();
      await winner;

      expect(await loser).toBe(false);
      expect(await db.select().from(webhookEvents)).toHaveLength(1);
    } finally {
      // Never leave the transaction open if an assertion above threw, or every
      // later test in this process blocks behind it.
      releaseWinner();
      await winner.catch(() => undefined);
    }
  });

  it("lets the DATABASE arbitrate a concurrent race — exactly one caller wins", async () => {
    // SMOKE CHECK ONLY — see the note above. Whether the two callers actually
    // collide is up to the scheduler, so a green run here proves nothing; the
    // two tests above are what pin the mechanism.
    const results = await Promise.all([
      repo.recordIfNew(event("evt-race")),
      repo.recordIfNew(event("evt-race")),
      repo.recordIfNew(event("evt-race")),
      repo.recordIfNew(event("evt-race")),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await db.select().from(webhookEvents)).toHaveLength(1);
  });

  it("does not swallow paid and expired for the same invoice when keys differ", async () => {
    // The provider_event_id must be per-DELIVERY. This test pins the repository
    // half of that: two different keys are two different rows, whatever they
    // were derived from.
    expect(await repo.recordIfNew({ ...event("inv_1:PAID"), eventType: "invoice.paid" })).toBe(
      true
    );
    expect(
      await repo.recordIfNew({ ...event("inv_1:EXPIRED"), eventType: "invoice.expired" })
    ).toBe(true);
    expect(await db.select().from(webhookEvents)).toHaveLength(2);
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
 * True once Postgres reports a backend of THIS database waiting on a lock while
 * running a statement against `webhook_event`. This is the observation that
 * makes the uncommitted-winner test deterministic instead of sleep-based: the
 * database, not a timer, tells us the second caller has reached the contended
 * index.
 */
async function blockedOnWebhookEvent(): Promise<boolean> {
  const rows = await sql<{ waiting: number }[]>`
    select count(*)::int as waiting
    from pg_stat_activity
    where datname = current_database()
      and wait_event_type = 'Lock'
      and query ilike '%webhook_event%'
  `;
  return rows[0].waiting > 0;
}
