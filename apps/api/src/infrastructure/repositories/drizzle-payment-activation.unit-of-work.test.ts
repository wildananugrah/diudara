import { describe, expect, it, beforeEach } from "bun:test";
import type { PaymentActivationRepositories } from "../../application/ports/payment-activation-unit-of-work.port";
import { db } from "../../db/client";
import { webhookEvents } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzlePaymentActivationUnitOfWork } from "./drizzle-payment-activation.unit-of-work";

beforeEach(resetDatabase);

const unitOfWork = () => new DrizzlePaymentActivationUnitOfWork(db);

/**
 * Pins the thing `webhooks.test.ts` cannot: that the repositories handed to the
 * work function are bound to the TRANSACTION and not to the pool.
 *
 * The route-level rollback tests break the activation, which runs AFTER
 * `recordIfNew` — so the claim is written and then discarded, which is exactly
 * the property below. What those tests cannot distinguish is a failure that
 * happens after a write with no further work to fail: in production that is a
 * commit error, a deadlock, or the process dying between the INSERT and the
 * COMMIT. These tests produce it directly.
 *
 * WHY `webhook_event` IS THE SUBJECT. Until retire-telegram Task 5 it was the
 * outbox: the community branch enqueued a Telegram invite inside this unit of
 * work, and a surviving row meant an invite for a payment that was never
 * recorded. That writer is gone and `outbox` left this set with it, so the claim
 * row is now the write whose atomicity carries the money. It is the sharper
 * subject anyway — a claim that outlives its own rolled-back activation spends
 * the event id, and every provider retry after it is answered "already handled"
 * while the member is never activated.
 */
describe("DrizzlePaymentActivationUnitOfWork", () => {
  async function recordClaim(repositories: PaymentActivationRepositories) {
    return repositories.webhookEvents.recordIfNew({
      provider: "xendit",
      providerEventId: "inv_1:PAID",
      eventType: "invoice.paid",
      payload: { id: "inv_1" },
    });
  }

  it("discards a claimed event id when the unit of work rolls back", async () => {
    await expect(
      unitOfWork().run(async (repositories) => {
        expect(await recordClaim(repositories)).toBe(true);
        // Anything that fails after the claim was written: a commit error, a
        // deadlock, a bug. The row must not survive it.
        throw new Error("boom, after the claim");
      })
    ).rejects.toThrow("boom, after the claim");

    // A surviving row is a spent idempotency key for a delivery that activated
    // nobody: money taken, membership never granted, and every retry a 200.
    expect(await db.select().from(webhookEvents)).toHaveLength(0);
  });

  it("commits the claimed event id when the work succeeds", async () => {
    await unitOfWork().run(recordClaim);

    const rows = await db.select().from(webhookEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0].providerEventId).toBe("inv_1:PAID");
  });

  it("keeps a claimed event id invisible outside the transaction until it commits", async () => {
    // The other half of "inside the transaction": a pooled reader must not see
    // the row while the unit of work is still open. If the webhook-event
    // repository were bound to the pool instead of the transaction handle, this
    // read would find it — the INSERT would already have committed on its own
    // connection, and the rollback above could not take it back.
    let visibleMidTransaction = -1;

    await unitOfWork().run(async (repositories) => {
      await recordClaim(repositories);
      visibleMidTransaction = (await db.select().from(webhookEvents)).length;
    });

    expect(visibleMidTransaction).toBe(0);
    expect(await db.select().from(webhookEvents)).toHaveLength(1);
  });
});
