import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "../../db/client";
import { outbox, webhookEvents } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzlePaymentActivationUnitOfWork } from "./drizzle-payment-activation.unit-of-work";

beforeEach(resetDatabase);

const unitOfWork = () => new DrizzlePaymentActivationUnitOfWork(db);

/**
 * Pins the thing `webhooks.test.ts` cannot: that the OUTBOX repository handed to
 * the work function is bound to the TRANSACTION and not to the pool.
 *
 * The route-level rollback tests break the activation inside `markPaid`, which
 * runs BEFORE the enqueue — so the enqueue never happens at all, and those tests
 * pass whether the outbox repository is transactional or not. (Measured: binding
 * it to the pool left the whole suite green.) The failure that distinguishes the
 * two has to happen AFTER the enqueue, which is what these tests do directly. In
 * production that failure is a commit error, a deadlock, or the process dying
 * between the INSERT and the COMMIT.
 */
describe("DrizzlePaymentActivationUnitOfWork", () => {
  it("discards an enqueued outbox row when the unit of work rolls back", async () => {
    await expect(
      unitOfWork().run(async (repositories) => {
        await repositories.webhookEvents.recordIfNew({
          provider: "xendit",
          providerEventId: "inv_1:PAID",
          eventType: "invoice.paid",
          payload: { id: "inv_1" },
        });
        await repositories.outbox.enqueue({
          eventType: "grant_access",
          payload: { subscriptionId: "sub-1" },
        });
        // Anything that fails after the intent to invite was written: a commit
        // error, a deadlock, a bug. The row must not survive it.
        throw new Error("boom, after the enqueue");
      })
    ).rejects.toThrow("boom, after the enqueue");

    // A surviving row is an invite for a subscription that was never activated —
    // and the retry that DOES activate enqueues a second one, so the member gets
    // two links.
    expect(await db.select().from(outbox)).toHaveLength(0);
    expect(await db.select().from(webhookEvents)).toHaveLength(0);
  });

  it("commits the enqueued row with everything else when the work succeeds", async () => {
    await unitOfWork().run(async (repositories) => {
      await repositories.outbox.enqueue({
        eventType: "grant_access",
        payload: { subscriptionId: "sub-1" },
      });
    });

    const rows = await db.select().from(outbox);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
  });

  it("keeps an enqueued row invisible outside the transaction until it commits", async () => {
    // The other half of "inside the transaction": a pooled reader must not see
    // the row while the unit of work is still open. If the outbox repository were
    // bound to the pool instead of the transaction handle, this read would find
    // it — the INSERT would already have committed on its own connection.
    let visibleMidTransaction = -1;

    await unitOfWork().run(async (repositories) => {
      await repositories.outbox.enqueue({
        eventType: "grant_access",
        payload: { subscriptionId: "sub-1" },
      });
      visibleMidTransaction = (await db.select().from(outbox)).length;
    });

    expect(visibleMidTransaction).toBe(0);
    expect(await db.select().from(outbox)).toHaveLength(1);
  });
});
