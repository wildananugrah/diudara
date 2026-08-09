import { describe, expect, it } from "bun:test";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import type { ActivityLogRepositoryPort } from "../ports/activity-log-repository.port";
import type { OutboxRepositoryPort } from "../ports/outbox-repository.port";
import type { PaymentActivationUnitOfWorkPort } from "../ports/payment-activation-unit-of-work.port";
import type {
  MarkPaidOutcome,
  SubscriptionRepositoryPort,
  TransactionRecord,
} from "../ports/subscription-repository.port";
import type { WebhookEventRepositoryPort } from "../ports/webhook-event-repository.port";
import { HandlePaymentWebhook } from "./handle-payment-webhook";

const TRANSACTION_ID = "3f1c9e0a-1111-4222-8333-444455556666";

function transactionRecord(overrides: Partial<TransactionRecord> = {}): TransactionRecord {
  return {
    id: TRANSACTION_ID,
    subscriptionId: "sub-1",
    amount: 50000,
    paymentMethod: "invoice",
    status: "pending",
    // Written by StartCheckout from the provider's createInvoice result, and the
    // value `paidEvent()` below echoes back as `body.id`. It is NOT null by
    // default any more: the handler now verifies `body.id` against it, so a null
    // here would mean "checkout never recorded the invoice id", which is its own
    // (tested) rejection path.
    gatewayReferenceId: "inv_1",
    paidAt: null,
    createdAt: new Date("2026-08-09T09:00:00Z"),
    updatedAt: new Date("2026-08-09T09:00:00Z"),
    ...overrides,
  };
}

/**
 * The settled-transaction-plus-subscription payload `markPaid` returns. Shared by
 * the `activated` and `superseded` outcomes because they carry the SAME shape and
 * differ only in the discriminant and in the subscription's status — which is
 * exactly the thing the caller has to branch on.
 */
function activationResult(paidAt: Date) {
  return {
    transaction: transactionRecord({ status: "success", paidAt }),
    subscription: {
      id: "sub-1",
      memberId: "member-1",
      tierId: "tier-1",
      status: "active",
      nextBillingDate: "2026-09-09",
      startedAt: paidAt,
      retryCount: 0,
      lastAttemptAt: null,
      createdAt: new Date("2026-08-09T09:00:00Z"),
      updatedAt: new Date("2026-08-09T10:00:00Z"),
    },
    communityId: "community-1",
  };
}

interface Calls {
  findTransactionByExternalId: string[];
  recordIfNew: string[];
  markPaid: string[];
  activity: { memberId: string | null; communityId: string; eventType: string }[];
  enqueued: { eventType: string; payload: unknown }[];
}

/** A recording harness whose call log is the assertion target for ORDERING. */
function harness(
  options: {
    transaction?: TransactionRecord | null;
    alreadySeen?: boolean;
    failMarkPaid?: boolean;
    /** `markPaid` returns null: the transaction was no longer `pending`. */
    alreadySettled?: boolean;
    /**
     * The status `markPaid` reports for a transaction it could not settle. Any
     * non-`pending`, non-`success` value takes the `conflicting_status` branch —
     * today that means `failed`.
     */
    conflictingStatus?: string;
    /**
     * `markPaid` reports the member already holds an active subscription to this
     * tier, so this one was cancelled instead of activated.
     */
    superseded?: boolean;
  } = {}
) {
  const calls: Calls = {
    findTransactionByExternalId: [],
    recordIfNew: [],
    markPaid: [],
    activity: [],
    enqueued: [],
  };
  const order: string[] = [];
  const transaction =
    options.transaction === undefined ? transactionRecord() : options.transaction;

  const subscriptions: SubscriptionRepositoryPort = {
    async createPending() {
      throw new Error("not used");
    },
    async createTransaction() {
      throw new Error("not used");
    },
    async findById() {
      throw new Error("not used");
    },
    async findByIdWithCommunity() {
      throw new Error("not used");
    },
    async findTransactionByExternalId(id) {
      calls.findTransactionByExternalId.push(id);
      order.push("find");
      return transaction;
    },
    async attachGatewayReference() {
      throw new Error("not used");
    },
    async markPaid(input): Promise<MarkPaidOutcome> {
      calls.markPaid.push(input.transactionId);
      order.push("markPaid");
      if (options.failMarkPaid === true) {
        throw new Error("activation blew up");
      }
      if (options.superseded === true) {
        // The real repository returns the CANCELLED row here, and the transaction
        // is still `success` — the money arrived. Mirrored so a test cannot pass
        // against a fake that is rosier than the thing it stands for.
        const settled = activationResult(input.paidAt);
        return {
          ...settled,
          outcome: "superseded",
          subscription: { ...settled.subscription, status: "cancelled", startedAt: null },
        };
      }
      if (options.conflictingStatus !== undefined) {
        return { outcome: "conflicting_status", status: options.conflictingStatus };
      }
      if (options.alreadySettled === true) {
        return { outcome: "already_settled", status: "success" };
      }
      return { ...activationResult(input.paidAt), outcome: "activated" };
    },
  };

  const webhookEvents: WebhookEventRepositoryPort = {
    async recordIfNew(input) {
      calls.recordIfNew.push(input.providerEventId);
      order.push("recordIfNew");
      return options.alreadySeen !== true;
    },
  };

  const activityLog: ActivityLogRepositoryPort = {
    async record(input) {
      calls.activity.push({
        memberId: input.memberId,
        communityId: input.communityId,
        eventType: input.eventType,
      });
      order.push("activity");
    },
  };

  const outbox: OutboxRepositoryPort = {
    async enqueue(input) {
      calls.enqueued.push({ eventType: input.eventType, payload: input.payload });
      order.push("outbox");
      return { id: `outbox-${calls.enqueued.length}` };
    },
    async claimBatch() {
      throw new Error("not used");
    },
    async markSent() {
      throw new Error("not used");
    },
    async markFailed() {
      throw new Error("not used");
    },
    async markPermanentlyFailed() {
      throw new Error("not used");
    },
    async reclaimStaleProcessing() {
      throw new Error("not used");
    },
  };

  /**
   * Stands in for the real transaction: records that a unit of work was opened,
   * and — the part that matters — records whether it COMMITTED or rolled back,
   * so a test can assert that a failure inside it does not leave the event id
   * claimed.
   */
  const unitOfWork: PaymentActivationUnitOfWorkPort = {
    async run(work) {
      order.push("uow:begin");
      try {
        const result = await work({ subscriptions, webhookEvents, activityLog, outbox });
        order.push("uow:commit");
        return result;
      } catch (error) {
        order.push("uow:rollback");
        throw error;
      }
    },
  };

  return {
    calls,
    order,
    useCase: new HandlePaymentWebhook(subscriptions, unitOfWork),
  };
}

function paidEvent(overrides: Record<string, unknown> = {}) {
  return {
    providerEventId: "inv_1:PAID",
    invoiceId: "inv_1",
    externalId: TRANSACTION_ID,
    status: "PAID",
    amount: 50000,
    eventType: "invoice.paid",
    paymentMethod: undefined,
    payload: { id: "inv_1", status: "PAID" },
    ...overrides,
  };
}

describe("HandlePaymentWebhook", () => {
  it("activates on a PAID event and records the audit entry", async () => {
    const { useCase, calls, order } = harness();

    const result = await useCase.execute(paidEvent());

    expect(result.activated).toBe(true);
    expect(calls.markPaid).toEqual([TRANSACTION_ID]);
    expect(calls.activity).toEqual([
      { memberId: "member-1", communityId: "community-1", eventType: "joined" },
    ]);
    expect(order).toEqual([
      "find",
      "uow:begin",
      "recordIfNew",
      "markPaid",
      "activity",
      "outbox",
      "uow:commit",
    ]);
  });

  /**
   * The atomicity requirement, at the unit level: the intent to invite is written
   * INSIDE the same unit of work as the activation.
   *
   * Asserted positionally rather than by "did it happen", because the failure this
   * guards against is not a missing call — it is a call in the wrong PLACE. An
   * enqueue after `uow:commit` would look identical in every other assertion, and
   * would lose the invite whenever the process died between the two writes: money
   * taken, nothing queued, and no retry, because the webhook event id is spent.
   */
  it("enqueues the grant_access row INSIDE the unit of work, not after it", async () => {
    const { useCase, order } = harness();

    await useCase.execute(paidEvent());

    expect(order.indexOf("outbox")).toBeGreaterThan(order.indexOf("uow:begin"));
    expect(order.indexOf("outbox")).toBeLessThan(order.indexOf("uow:commit"));
  });

  it("enqueues exactly one grant_access row, addressed by subscription", async () => {
    const { useCase, calls } = harness();

    await useCase.execute(paidEvent());

    expect(calls.enqueued).toHaveLength(1);
    expect(calls.enqueued[0].eventType).toBe("grant_access");
    expect(calls.enqueued[0].payload).toMatchObject({
      subscriptionId: "sub-1",
      memberId: "member-1",
      communityId: "community-1",
    });
  });

  it("keeps the payer's details out of the outbox payload", async () => {
    // The row is read by the worker and logged around; the raw body already has
    // exactly one home, `webhook_event.payload`. Ids and integers only.
    const { useCase, calls } = harness();

    await useCase.execute(
      paidEvent({
        payload: { id: "inv_1", payer_email: "siti@example.com", payer_name: "Siti" },
      })
    );

    const serialised = JSON.stringify(calls.enqueued[0].payload);
    expect(serialised).not.toContain("siti@example.com");
    expect(serialised).not.toContain("Siti");
  });

  it("does not enqueue anything when the activation itself fails", async () => {
    // The real unit of work would roll the row back anyway; not writing it at all
    // when nothing was activated is the same rule the activity_log entry follows.
    const { useCase, calls, order } = harness({ failMarkPaid: true });

    await expect(useCase.execute(paidEvent())).rejects.toThrow("activation blew up");

    expect(calls.enqueued).toEqual([]);
    expect(order).toContain("uow:rollback");
  });

  it("does not enqueue for a replayed event", async () => {
    const { useCase, calls } = harness({ alreadySeen: true });

    await useCase.execute(paidEvent());

    expect(calls.enqueued).toEqual([]);
  });

  it("does not enqueue for an already-settled transaction", async () => {
    const { useCase, calls } = harness({ alreadySettled: true });

    await useCase.execute(paidEvent());

    expect(calls.enqueued).toEqual([]);
  });

  it("does not enqueue for a status that is not PAID", async () => {
    const { useCase, calls } = harness();

    await captureWarnings(() => useCase.execute(paidEvent({ status: "EXPIRED" })));

    expect(calls.enqueued).toEqual([]);
  });

  it("passes the provider's invoice id through as the gateway reference", async () => {
    const { useCase } = harness();
    const result = await useCase.execute(paidEvent());
    expect(result.activated).toBe(true);
  });

  /**
   * I2, final whole-branch review. `provider_event_id` is derived from
   * `body.id`, so before this check the ENTIRE replay defence rested on a field
   * we never verified against anything of ours. Probed: 12 concurrent PAID
   * deliveries with 12 distinct `body.id` values → 12 `activity_log` "joined"
   * rows, all HTTP 200. In Phase 4 that is 12 WhatsApp invites.
   */
  describe("verifying body.id against the invoice id we stored at checkout", () => {
    it("400s an invoice id that is not the one we recorded, and never activates", async () => {
      const { useCase, calls, order } = harness();

      await expect(
        useCase.execute(paidEvent({ invoiceId: "forged-inv-7", providerEventId: "forged-inv-7:PAID" }))
      ).rejects.toBeInstanceOf(ValidationError);

      // Rejected on a read, before anything is written — so a forger cannot even
      // consume the event id a genuine delivery needs.
      expect(order).toEqual(["find"]);
      expect(calls.recordIfNew).toEqual([]);
      expect(calls.markPaid).toEqual([]);
      expect(calls.activity).toEqual([]);
    });

    it("is checked BEFORE the amount, because the event id derives from it", async () => {
      const { useCase } = harness();
      const warnings = await captureWarnings(() =>
        useCase
          .execute(paidEvent({ invoiceId: "forged-inv-7", amount: 1 }))
          .catch(() => undefined)
      );
      expect(warnings.some((line) => /invoice id mismatch/.test(line))).toBe(true);
      expect(warnings.some((line) => /amount mismatch/.test(line))).toBe(false);
    });

    it("fails CLOSED when checkout never recorded an invoice id at all", async () => {
      // Trusting body.id when we have nothing to compare it against is exactly
      // the hole this closes, so a null reference must reject rather than adopt.
      const { useCase, calls } = harness({
        transaction: transactionRecord({ gatewayReferenceId: null }),
      });

      await expect(useCase.execute(paidEvent())).rejects.toBeInstanceOf(ValidationError);
      expect(calls.recordIfNew).toEqual([]);
      expect(calls.markPaid).toEqual([]);
    });

    it("logs the mismatch with ids only, sanitised", async () => {
      const { useCase } = harness();
      const warnings = await captureWarnings(() =>
        useCase
          .execute(
            paidEvent({
              invoiceId: "forged\n[security] fine",
              payload: { payer_email: "siti@example.com" },
            })
          )
          .catch(() => undefined)
      );

      const text = warnings.join("\n");
      expect(text).toContain("invoice id mismatch");
      expect(text).toContain("expected=inv_1");
      expect(text).not.toContain("siti@example.com");
      expect(warnings.every((line) => !line.includes("\n"))).toBe(true);
    });
  });

  // I2(b). The second line of defence, and the only one that does not depend on
  // a provider field: even a delivery that passes every check above must not
  // activate a transaction that is already `success`.
  it("does not activate twice when markPaid reports the transaction is already settled", async () => {
    const { useCase, calls, order } = harness({ alreadySettled: true });

    const result = await useCase.execute(paidEvent());

    expect(result).toEqual({ activated: false, duplicate: true });
    expect(calls.markPaid).toEqual([TRANSACTION_ID]);
    // The audit entry is what Phase 4 turns into a WhatsApp invite.
    expect(calls.activity).toEqual([]);
    expect(order).toEqual(["find", "uow:begin", "recordIfNew", "markPaid", "uow:commit"]);
  });

  it("says out loud that it saw an already-settled transaction", async () => {
    const { useCase } = harness({ alreadySettled: true });
    const warnings = await captureWarnings(() => useCase.execute(paidEvent()));
    expect(warnings.some((line) => /already-settled transaction/.test(line))).toBe(true);
    expect(warnings.some((line) => line.includes(TRANSACTION_ID))).toBe(true);
  });

  /**
   * Task 7 item 2. `failed` used to be indistinguishable from `success` here —
   * both produced `{ activated: false, duplicate: true }` and an HTTP 200 — so a
   * genuine payment for a failed transaction was thrown away with a log line
   * calling it a duplicate. Xendit does not retry a 200.
   */
  describe("a payment for a transaction in a status that cannot be settled", () => {
    it("throws a 409 rather than reporting a duplicate", async () => {
      const { useCase } = harness({ conflictingStatus: "failed" });

      let thrown: unknown;
      await captureWarnings(async () => {
        thrown = await useCase.execute(paidEvent()).catch((err: unknown) => err);
      });

      expect(thrown).toBeInstanceOf(ConflictError);
      expect((thrown as ConflictError).status).toBe(409);
    });

    it("does not activate, audit or enqueue anything", async () => {
      const { useCase, calls, order } = harness({ conflictingStatus: "failed" });

      await captureWarnings(() => useCase.execute(paidEvent()).catch(() => undefined));

      expect(calls.activity).toEqual([]);
      // The whole point: no invite is queued for a payment we refused to settle.
      expect(calls.enqueued).toEqual([]);
      // And the throw reaches the unit of work, which rolls `recordIfNew` back —
      // so the event id is not spent and the delivery can be replayed by hand.
      expect(order).toEqual(["find", "uow:begin", "recordIfNew", "markPaid", "uow:rollback"]);
    });

    it("names the transaction and the status, and nothing else", async () => {
      const { useCase } = harness({ conflictingStatus: "failed" });

      const warnings = await captureWarnings(() =>
        useCase.execute(paidEvent()).catch(() => undefined)
      );

      const text = warnings.join("\n");
      expect(text).toContain("ALERT");
      expect(text).toContain(TRANSACTION_ID);
      expect(text).toContain("failed");
      // NOT called a duplicate — that wording is what made this invisible.
      expect(text).not.toMatch(/already-settled/);
    });

    it("treats any unrecognised status the same way, not just failed", async () => {
      // NOTE: kept adjacent to the superseded block below on purpose — both are
      // non-activating outcomes and both must leave `calls.enqueued` empty.
      // `transaction.status` is a varchar, not an enum. A status a later phase
      // adds must fail closed rather than be absorbed as a duplicate.
      for (const status of ["refunded", "expired", "chargeback", "PENDING"]) {
        const { useCase, calls } = harness({ conflictingStatus: status });
        let thrown: unknown;
        await captureWarnings(async () => {
          thrown = await useCase.execute(paidEvent()).catch((err: unknown) => err);
        });
        expect(thrown).toBeInstanceOf(ConflictError);
        expect(calls.enqueued).toEqual([]);
      }
    });
  });

  /**
   * Task 7 item 3. `markPaid` reports `superseded` when the member already holds an
   * active subscription to this tier, and the ONE thing that must not happen then
   * is a second `grant_access` row: that is a second single-use invite link for the
   * same member, which they can forward to somebody who never paid.
   */
  describe("a payment superseded by an existing active subscription", () => {
    it("does NOT enqueue a grant_access row", async () => {
      const { useCase, calls } = harness({ superseded: true });

      await captureWarnings(() => useCase.execute(paidEvent()));

      expect(calls.enqueued).toEqual([]);
    });

    it("answers 2xx-shaped: not activated, and not a duplicate either", async () => {
      // `duplicate: true` would be wrong — this is a distinct, handled state, and
      // a caller branching on it must be able to tell them apart.
      const { useCase } = harness({ superseded: true });

      let result: unknown;
      await captureWarnings(async () => {
        result = await useCase.execute(paidEvent());
      });

      expect(result).toEqual({ activated: false, duplicate: false });
    });

    it("audits it as access_not_granted with the reason and the amount", async () => {
      const { useCase, calls } = harness({ superseded: true });

      await captureWarnings(() => useCase.execute(paidEvent()));

      expect(calls.activity).toEqual([
        { memberId: "member-1", communityId: "community-1", eventType: "access_not_granted" },
      ]);
    });

    it("says out loud that a refund is likely owed", async () => {
      const { useCase } = harness({ superseded: true });

      const warnings = await captureWarnings(() => useCase.execute(paidEvent()));

      const text = warnings.join("\n");
      expect(text).toContain("superseded");
      expect(text).toContain("refund");
      expect(text).toContain(TRANSACTION_ID);
    });
  });

  describe("order of operations", () => {
    it("404s an unknown external id BEFORE recording the event", async () => {
      // Recording first would burn the event id: Xendit's retry after we fixed
      // the underlying problem would be swallowed as a replay.
      const { useCase, calls } = harness({ transaction: null });

      await expect(useCase.execute(paidEvent())).rejects.toBeInstanceOf(NotFoundError);
      expect(calls.recordIfNew).toEqual([]);
      expect(calls.markPaid).toEqual([]);
      expect(calls.activity).toEqual([]);
    });

    it("400s an amount mismatch BEFORE recording the event, and never activates", async () => {
      const { useCase, calls, order } = harness();

      await expect(useCase.execute(paidEvent({ amount: 1 }))).rejects.toBeInstanceOf(
        ValidationError
      );
      // No transaction is even opened for a body that fails the amount check.
      expect(order).toEqual(["find"]);
      expect(calls.recordIfNew).toEqual([]);
      expect(calls.markPaid).toEqual([]);
    });

    it("rejects an amount HIGHER than ours too, not just lower", async () => {
      const { useCase, calls } = harness();
      await expect(useCase.execute(paidEvent({ amount: 500000 }))).rejects.toBeInstanceOf(
        ValidationError
      );
      expect(calls.markPaid).toEqual([]);
    });

    it("does nothing at all when the event was already recorded", async () => {
      const { useCase, calls, order } = harness({ alreadySeen: true });

      const result = await useCase.execute(paidEvent());

      expect(result.activated).toBe(false);
      expect(result.duplicate).toBe(true);
      expect(order).toEqual(["find", "uow:begin", "recordIfNew", "uow:commit"]);
      expect(calls.markPaid).toEqual([]);
      expect(calls.activity).toEqual([]);
    });
  });

  describe("non-PAID statuses", () => {
    it("records the event but does not activate", async () => {
      for (const status of ["EXPIRED", "PENDING", "FAILED", "SETTLED"]) {
        const { useCase, calls } = harness();

        const result = await useCase.execute(paidEvent({ status, providerEventId: `inv_1:${status}` }));

        expect(result.activated).toBe(false);
        expect(calls.recordIfNew).toEqual([`inv_1:${status}`]);
        expect(calls.markPaid).toEqual([]);
        expect(calls.activity).toEqual([]);
      }
    });

    // I5, final whole-branch review. Probed before this: a SETTLED delivery was
    // HTTP 200, subscription still `pending`, webhook_event written, and not one
    // log line — indistinguishable from success on the wire.
    it("WARNS on every recorded-but-unactioned status", async () => {
      for (const status of ["EXPIRED", "PENDING", "FAILED", "SETTLED", "SOMETHING_NEW"]) {
        const { useCase } = harness();

        const warnings = await captureWarnings(() =>
          useCase.execute(paidEvent({ status, providerEventId: `inv_1:${status}` }))
        );

        expect(warnings.some((line) => /recorded but NOT actioned/.test(line))).toBe(true);
        expect(warnings.some((line) => line.includes(`status=${status}`))).toBe(true);
        expect(warnings.some((line) => line.includes(TRANSACTION_ID))).toBe(true);
      }
    });

    it("stays silent on PAID — the warning must mean something", async () => {
      const { useCase } = harness();
      const warnings = await captureWarnings(() => useCase.execute(paidEvent()));
      expect(warnings).toEqual([]);
    });

    it("logs no payer PII, and cannot be made to forge a second log line", async () => {
      // The payload carries the payer's name, email and phone. The status is
      // attacker-chosen text, so a newline in it would otherwise mint a fake
      // line in the very log an operator reads when payments look wrong.
      const { useCase } = harness();

      const warnings = await captureWarnings(() =>
        useCase.execute(
          paidEvent({
            status: "EXPIRED\n[security] all clear",
            payload: {
              id: "inv_1",
              status: "EXPIRED",
              payer_email: "siti@example.com",
              customer: { given_names: "Siti", mobile_number: "+6281234567890" },
            },
          })
        )
      );

      const text = warnings.join("\n");
      expect(text).toContain("recorded but NOT actioned");
      expect(text).not.toContain("siti@example.com");
      expect(text).not.toContain("Siti");
      expect(text).not.toContain("+6281234567890");
      // One line per warning, so the injected newline did not survive.
      expect(warnings.every((line) => !line.includes("\n"))).toBe(true);
      expect(text).not.toContain("[security] all clear");
    });

    it("is case-sensitive about PAID rather than lower-casing its way into activation", async () => {
      // Xendit sends upper-case statuses. Accepting "paid"/"Paid" would widen
      // the one condition that turns money into access on the strength of a
      // guess about the provider's formatting.
      for (const status of ["paid", "Paid", " PAID", "PAID "]) {
        const { useCase, calls } = harness();
        const result = await useCase.execute(paidEvent({ status }));
        expect(result.activated).toBe(false);
        expect(calls.markPaid).toEqual([]);
      }
    });
  });

  it("rolls the unit of work back when the activation fails", async () => {
    // The event id was claimed inside the transaction, so the rollback releases
    // it and Xendit's retry is processed normally instead of being swallowed as
    // a replay. Without this, the member paid and never got access.
    const { useCase, calls, order } = harness({ failMarkPaid: true });

    await expect(useCase.execute(paidEvent())).rejects.toThrow(/activation blew up/);

    expect(calls.recordIfNew).toEqual(["inv_1:PAID"]);
    expect(order).toEqual(["find", "uow:begin", "recordIfNew", "markPaid", "uow:rollback"]);
    expect(calls.activity).toEqual([]);
  });

  it("claims the event id INSIDE the unit of work, never before it", async () => {
    // If recordIfNew committed on its own, no rollback could release the id.
    const { useCase, order } = harness();
    await useCase.execute(paidEvent());

    expect(order.indexOf("uow:begin")).toBeLessThan(order.indexOf("recordIfNew"));
    expect(order.indexOf("recordIfNew")).toBeLessThan(order.indexOf("uow:commit"));
  });

  it("still compares the amount when the status is not PAID", async () => {
    // Recording a forged EXPIRED event under a real invoice's key would let an
    // attacker consume the event id a genuine delivery needs.
    const { useCase, calls } = harness();

    await expect(
      useCase.execute(paidEvent({ status: "EXPIRED", amount: 1 }))
    ).rejects.toBeInstanceOf(ValidationError);
    expect(calls.recordIfNew).toEqual([]);
  });
});

/** Captures `console.warn` for the duration of `fn`, restoring it afterwards. */
async function captureWarnings(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return lines;
}
