import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { activityLogs, outbox } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleOutboxRepository } from "../../infrastructure/repositories/drizzle-outbox.repository";
import { OUTBOX_GRANT_ACCESS } from "../ports/outbox-repository.port";
import { ProcessOutbox, type OutboxHandler } from "./process-outbox";

beforeEach(resetDatabase);

const repository = () => new DrizzleOutboxRepository(db);

/** A link-shaped string, so "no invite link leaked" is a real assertion. */
const INVITE_LINK = "https://t.me/+SuperSecretInviteToken";

function processor(
  handlers: Record<string, OutboxHandler>,
  config: {
    batchSize?: number;
    maxAttempts?: number;
    baseBackoffMs?: number;
    staleProcessingMs?: number;
    maxPassMs?: number;
  } = {}
) {
  return new ProcessOutbox(repository(), new Map(Object.entries(handlers)), config);
}

async function rowById(id: string) {
  const [row] = await db.select().from(outbox).where(eq(outbox.id, id));
  return row;
}

/** Makes every pending row due right now, without sleeping through a backoff. */
async function makeEverythingDue() {
  await db
    .update(outbox)
    .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
    .where(eq(outbox.status, "pending"));
}

describe("ProcessOutbox", () => {
  it("dispatches a claimed row to the handler for its event type and marks it sent", async () => {
    const seen: unknown[] = [];
    const { id } = await repository().enqueue({
      eventType: OUTBOX_GRANT_ACCESS,
      payload: { subscriptionId: "sub-1" },
    });

    const result = await processor({
      [OUTBOX_GRANT_ACCESS]: async (payload) => {
        seen.push(payload);
      },
    }).execute();

    expect(result).toEqual({
      reclaimed: 0,
      claimed: 1,
      sent: 1,
      retried: 0,
      failed: 0,
      released: 0,
    });
    expect(seen).toEqual([{ subscriptionId: "sub-1" }]);
    expect((await rowById(id)).status).toBe("sent");
  });

  it("does nothing, quietly, when the outbox is empty", async () => {
    const result = await processor({}).execute();
    expect(result).toEqual({
      reclaimed: 0,
      claimed: 0,
      sent: 0,
      retried: 0,
      failed: 0,
      released: 0,
    });
  });

  it("marks a row sent only after its handler RESOLVES", async () => {
    const { id } = await repository().enqueue({
      eventType: OUTBOX_GRANT_ACCESS,
      payload: {},
    });

    const result = await processor({
      [OUTBOX_GRANT_ACCESS]: async () => {
        throw new Error("telegram is down");
      },
    }).execute();

    expect(result.sent).toBe(0);
    expect(result.retried).toBe(1);
    const row = await rowById(id);
    expect(row.status).toBe("pending");
    expect(row.lastError).toContain("telegram is down");
  });

  it("keeps working through the batch when one row fails", async () => {
    await repository().enqueue({ eventType: OUTBOX_GRANT_ACCESS, payload: { n: 1 } });
    await repository().enqueue({ eventType: "boom", payload: { n: 2 } });
    await repository().enqueue({ eventType: OUTBOX_GRANT_ACCESS, payload: { n: 3 } });

    const result = await processor({
      [OUTBOX_GRANT_ACCESS]: async () => undefined,
      boom: async () => {
        throw new Error("nope");
      },
    }).execute();

    expect(result).toEqual({
      reclaimed: 0,
      claimed: 3,
      sent: 2,
      retried: 1,
      failed: 0,
      released: 0,
    });
  });

  it("backs off exponentially between attempts", async () => {
    const { id } = await repository().enqueue({ eventType: OUTBOX_GRANT_ACCESS, payload: {} });
    const failing = processor(
      {
        [OUTBOX_GRANT_ACCESS]: async () => {
          throw new Error("still down");
        },
      },
      { baseBackoffMs: 1_000 }
    );

    const before = Date.now();
    await failing.execute();
    const firstDelay = (await rowById(id)).nextAttemptAt.getTime() - before;

    await makeEverythingDue();
    const beforeSecond = Date.now();
    await failing.execute();
    const secondDelay = (await rowById(id)).nextAttemptAt.getTime() - beforeSecond;

    // A provider that is down stays down for a while; hammering it every tick
    // wastes the retry budget in seconds.
    expect(firstDelay).toBeGreaterThanOrEqual(1_000);
    expect(secondDelay).toBeGreaterThanOrEqual(2 * firstDelay - 500);
  });

  it("stops retrying at the attempt bound: failed, with last_error, and never claimed again", async () => {
    const { id } = await repository().enqueue({ eventType: OUTBOX_GRANT_ACCESS, payload: {} });
    let calls = 0;
    const failing = processor(
      {
        [OUTBOX_GRANT_ACCESS]: async () => {
          calls += 1;
          throw new Error("telegram rejected the request");
        },
      },
      { maxAttempts: 3, baseBackoffMs: 0 }
    );

    for (let pass = 0; pass < 6; pass += 1) {
      await makeEverythingDue();
      await failing.execute();
    }

    // Bounded: three attempts, then terminal. Not "eventually", not "usually".
    expect(calls).toBe(3);
    const row = await rowById(id);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(3);
    expect(row.lastError).toContain("telegram rejected the request");
    expect(row.lastError).toContain("3 attempts");
    // The claim itself refuses it now, which is what "never again" means.
    expect(await repository().claimBatch(10)).toEqual([]);
  });

  it("retries a row whose event type has no handler, then gives up on it", async () => {
    const { id } = await repository().enqueue({ eventType: "unknown_event", payload: {} });
    const runner = processor({}, { maxAttempts: 2, baseBackoffMs: 0 });

    await runner.execute();
    expect((await rowById(id)).status).toBe("pending");

    await makeEverythingDue();
    await runner.execute();

    // Retried rather than failed immediately, so a row enqueued by a NEWER API
    // during a rolling deploy is not thrown away by an older worker — but
    // bounded, so it cannot sit there forever either.
    const row = await rowById(id);
    expect(row.status).toBe("failed");
    expect(row.lastError).toContain("unknown_event");
  });

  it("reclaims a row stranded in processing, then sends it", async () => {
    const { id } = await repository().enqueue({ eventType: OUTBOX_GRANT_ACCESS, payload: {} });
    // Exactly what a SIGKILLed worker leaves behind.
    await repository().claimBatch(10);
    await db
      .update(outbox)
      .set({ updatedAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(outbox.id, id));

    const result = await processor(
      { [OUTBOX_GRANT_ACCESS]: async () => undefined },
      { staleProcessingMs: 60_000 }
    ).execute();

    expect(result.reclaimed).toBe(1);
    expect(result.sent).toBe(1);
    expect((await rowById(id)).status).toBe("sent");
  });

  it("leaves a row another worker is actively processing alone", async () => {
    await repository().enqueue({ eventType: OUTBOX_GRANT_ACCESS, payload: {} });
    await repository().claimBatch(10);

    const result = await processor(
      { [OUTBOX_GRANT_ACCESS]: async () => undefined },
      { staleProcessingMs: 60_000 }
    ).execute();

    expect(result).toEqual({
      reclaimed: 0,
      claimed: 0,
      sent: 0,
      retried: 0,
      failed: 0,
      released: 0,
    });
  });

  it("honours the batch size", async () => {
    for (let i = 0; i < 5; i += 1) {
      await repository().enqueue({ eventType: OUTBOX_GRANT_ACCESS, payload: { i } });
    }

    const result = await processor(
      { [OUTBOX_GRANT_ACCESS]: async () => undefined },
      { batchSize: 2 }
    ).execute();

    expect(result.claimed).toBe(2);
    expect(result.sent).toBe(2);
  });

  describe("an invite link must never leak", () => {
    const lines: string[] = [];
    const original = { warn: console.warn, error: console.error, log: console.log };

    beforeEach(() => {
      lines.length = 0;
      const capture = (...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      };
      console.warn = capture;
      console.error = capture;
      console.log = capture;
    });

    afterEach(() => {
      console.warn = original.warn;
      console.error = original.error;
      console.log = original.log;
    });

    it("is stripped from last_error AND from every log line", async () => {
      const { id } = await repository().enqueue({
        eventType: OUTBOX_GRANT_ACCESS,
        payload: { subscriptionId: "sub-1" },
      });
      const runner = processor(
        {
          // A provider error that carries the link is not hypothetical: Phase 2
          // leaked argon2id hashes through raw error logging, and an adapter that
          // interpolates its own response is one refactor away.
          [OUTBOX_GRANT_ACCESS]: async () => {
            throw new Error(`failed after issuing ${INVITE_LINK} to the member`);
          },
        },
        { maxAttempts: 1, baseBackoffMs: 0 }
      );

      await runner.execute();

      const row = await rowById(id);
      expect(row.status).toBe("failed");
      // The diagnostic survives; the credential does not.
      expect(row.lastError).toContain("failed after issuing");
      expect(row.lastError).not.toContain(INVITE_LINK);
      expect(row.lastError).not.toContain("t.me");

      expect(lines.length).toBeGreaterThan(0);
      const printed = lines.join("\n");
      expect(printed).not.toContain(INVITE_LINK);
      expect(printed).not.toContain("t.me");
      expect(printed).toContain(id);
    });

    it("keeps the payload out of the logs entirely", async () => {
      await repository().enqueue({
        eventType: OUTBOX_GRANT_ACCESS,
        payload: { subscriptionId: "sub-1", secretish: "0812-payer-pii" },
      });

      await processor(
        {
          [OUTBOX_GRANT_ACCESS]: async () => {
            throw new Error("plain failure");
          },
        },
        { maxAttempts: 1 }
      ).execute();

      // Phase 3 found payer PII in webhook payloads. The worker logs ids, event
      // types and error text — never the row's payload.
      expect(lines.join("\n")).not.toContain("0812-payer-pii");
    });

    /**
     * The failure mode a RUNNING worker produced during Phase 4's end-to-end
     * verification, which no test until now could see: drizzle wraps every query
     * failure in a `DrizzleQueryError` whose `message` is
     *
     *   Failed query: <the whole sql statement>
     *   params: <every bound value, comma separated>
     *
     * so reading `err.message` dumps the bound parameters — the exact leak
     * `pg-errors.ts` documents ("← password hashes live here") and
     * `http/error-handler.ts` already guards against with `safeSummary`. The
     * worker's path had no such guard, so a real query failure printed the
     * statement and its values into the log AND into `outbox.last_error`, while
     * the actual reason — which lives on `.cause`, not on the message — was
     * thrown away.
     *
     * A REAL failing query rather than a hand-built error object: the shape above
     * is drizzle's, not ours, and a fake would keep passing after an upgrade
     * changed it.
     */
    it("reports why a real query failed, without the statement's bound values", async () => {
      const { id } = await repository().enqueue({
        eventType: OUTBOX_GRANT_ACCESS,
        payload: { subscriptionId: "sub-1" },
      });

      await processor(
        {
          [OUTBOX_GRANT_ACCESS]: async () => {
            // A foreign-key violation, with a link-shaped value and a
            // PII-shaped value among the bound parameters.
            await db.insert(activityLogs).values({
              memberId: "00000000-0000-0000-0000-000000000000",
              communityId: "00000000-0000-0000-0000-000000000000",
              eventType: "0812-payer-pii",
              metadata: { inviteLink: INVITE_LINK },
            });
          },
        },
        { maxAttempts: 1, baseBackoffMs: 0 }
      ).execute();

      const row = await rowById(id);
      expect(row.status).toBe("failed");

      // WHY it failed, which is the only thing `last_error` exists for.
      expect(row.lastError).toContain("foreign key constraint");
      // Not the statement, and above all not its values.
      expect(row.lastError).not.toContain("params:");
      expect(row.lastError).not.toContain("0812-payer-pii");
      expect(row.lastError).not.toContain(INVITE_LINK);
      expect(row.lastError).not.toContain("t.me");
      // `detail` carries the offending key value; only `message` may be used.
      expect(row.lastError).not.toContain("is not present in table");

      const printed = lines.join("\n");
      expect(printed).toContain("foreign key constraint");
      expect(printed).not.toContain("params:");
      expect(printed).not.toContain("0812-payer-pii");
      expect(printed).not.toContain(INVITE_LINK);

      // ONE log line. Drizzle's message embeds a newline before `params:`, so an
      // unsanitised reason forged a second line in the worker's output — the very
      // thing `safeLabel` exists to stop for event types.
      expect(lines.every((line) => !line.includes("\n"))).toBe(true);
    });
  });

  /**
   * I2, final whole-branch review: the stale-processing clock was PER BATCH.
   *
   * `claimBatch` stamps `updated_at` once for all the rows it claims, and they are
   * then handled serially with nothing touching them again. With `batchSize: 10` and
   * a 15s adapter timeout, a degraded Telegram makes one pass outlive
   * `staleProcessingMs`, so a second worker reclaims rows the first has not reached —
   * and both then run them. For a `grant_access` row that is a double claim, which is
   * one member and two invite links.
   */
  describe("a slow pass cannot let a second worker claim rows it still holds", () => {
    it("touches each row as it is dequeued, so the clock measures the ROW not the batch", async () => {
      for (const n of [1, 2]) {
        await repository().enqueue({ eventType: OUTBOX_GRANT_ACCESS, payload: { n } });
      }

      // Both rows share a claim timestamp. The handler for whichever comes first takes
      // long enough that, without a per-row touch, the other would already look stale
      // by the time it is reached.
      //
      // IN HANDLING ORDER, and deliberately NOT keyed by which row was enqueued first.
      // `claimBatch`'s inner CTE is ordered, but the `update … returning` around it is
      // not, and Postgres defines no order for RETURNING — so which of the two rows a
      // pass handles first is genuinely undefined. Naming them made this test fail on
      // ~40% of runs against a freshly created database (measured, Task 8: the fresh
      // database has no statistics on `outbox`, so the planner is free to choose a
      // different shape and did). The property the test exists for — the stamp is
      // restarted per ROW, not stamped once per batch — says nothing about order.
      const stampsInHandlingOrder: Date[] = [];
      await processor(
        {
          [OUTBOX_GRANT_ACCESS]: async (payload) => {
            const n = (payload as { n: number }).n;
            const rows = await db.select().from(outbox);
            for (const row of rows) {
              if (row.status === "processing" && (row.payload as { n: number }).n === n) {
                stampsInHandlingOrder.push(row.updatedAt);
              }
            }
            await Bun.sleep(60);
          },
        },
        { staleProcessingMs: 60_000 }
      ).execute();

      // The second row's clock was restarted when its turn came, so it is strictly
      // later than the first's — proof the stamp is per row and not per batch.
      expect(stampsInHandlingOrder).toHaveLength(2);
      expect(stampsInHandlingOrder[1].getTime()).toBeGreaterThan(
        stampsInHandlingOrder[0].getTime()
      );
    });

    it("releases rows it did not reach instead of holding them past the threshold", async () => {
      for (const n of [1, 2, 3]) {
        await repository().enqueue({ eventType: OUTBOX_GRANT_ACCESS, payload: { n } });
      }

      const handled: number[] = [];
      const result = await processor(
        {
          [OUTBOX_GRANT_ACCESS]: async (payload) => {
            handled.push((payload as { n: number }).n);
            await Bun.sleep(40);
          },
        },
        // A pass budget one row's work can exceed, so the bound fires mid-batch.
        { batchSize: 10, maxPassMs: 30 }
      ).execute();

      // It stopped early rather than working through a batch it could not finish in
      // time, and handed the rest back as `pending` — claimable immediately, by this
      // worker's next pass or any other, with no window in which two hold them.
      expect(handled.length).toBeLessThan(3);
      expect(result.released).toBe(3 - handled.length);
      const pending = (await db.select().from(outbox)).filter((row) => row.status === "pending");
      expect(pending).toHaveLength(3 - handled.length);
      // Not left in `processing`, which is what would have needed the reclaim timer.
      expect((await db.select().from(outbox)).some((row) => row.status === "processing")).toBe(
        false
      );
    });

    it("does not release anything on a pass that finishes within its budget", async () => {
      await repository().enqueue({ eventType: OUTBOX_GRANT_ACCESS, payload: {} });

      const result = await processor(
        { [OUTBOX_GRANT_ACCESS]: async () => undefined },
        { maxPassMs: 60_000 }
      ).execute();

      expect(result).toMatchObject({ claimed: 1, sent: 1, released: 0 });
    });

    it("spends an attempt on a released row, so a row at the back cannot retry forever", async () => {
      // A row that always lands after a slow one would otherwise be claimed and
      // released endlessly, which is the unbounded retry this phase forbids.
      for (const n of [1, 2]) {
        await repository().enqueue({ eventType: OUTBOX_GRANT_ACCESS, payload: { n } });
      }

      await processor(
        {
          [OUTBOX_GRANT_ACCESS]: async () => {
            await Bun.sleep(40);
          },
        },
        { batchSize: 10, maxPassMs: 30 }
      ).execute();

      const rows = await db.select().from(outbox);
      expect(rows.every((row) => row.attempts === 1)).toBe(true);
    });
  });

  it("sanitises an event type before putting it in a log line", async () => {
    // eventType comes out of the database, but the database got it from an
    // enqueuer, and a newline would forge a second log line — the same rule
    // HandlePaymentWebhook's safeLabel applies to webhook fields.
    const { id } = await repository().enqueue({
      eventType: "evil\n[outbox] all is well",
      payload: {},
    });

    const lines: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      await processor({}, { maxAttempts: 1 }).execute();
    } finally {
      console.warn = originalWarn;
    }

    expect((await rowById(id)).status).toBe("failed");
    expect(lines.join("\n")).not.toContain("\n[outbox] all is well");
  });
});
