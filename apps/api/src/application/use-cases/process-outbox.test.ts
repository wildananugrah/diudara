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

    expect(result).toEqual({ reclaimed: 0, claimed: 1, sent: 1, retried: 0, failed: 0 });
    expect(seen).toEqual([{ subscriptionId: "sub-1" }]);
    expect((await rowById(id)).status).toBe("sent");
  });

  it("does nothing, quietly, when the outbox is empty", async () => {
    const result = await processor({}).execute();
    expect(result).toEqual({ reclaimed: 0, claimed: 0, sent: 0, retried: 0, failed: 0 });
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

    expect(result).toEqual({ reclaimed: 0, claimed: 3, sent: 2, retried: 1, failed: 0 });
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

    expect(result).toEqual({ reclaimed: 0, claimed: 0, sent: 0, retried: 0, failed: 0 });
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
