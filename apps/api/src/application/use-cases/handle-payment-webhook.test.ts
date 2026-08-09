import { describe, expect, it } from "bun:test";
import { NotFoundError, ValidationError } from "../errors";
import type { ActivityLogRepositoryPort } from "../ports/activity-log-repository.port";
import type { PaymentActivationUnitOfWorkPort } from "../ports/payment-activation-unit-of-work.port";
import type {
  MarkPaidResult,
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
    gatewayReferenceId: null,
    paidAt: null,
    createdAt: new Date("2026-08-09T09:00:00Z"),
    updatedAt: new Date("2026-08-09T09:00:00Z"),
    ...overrides,
  };
}

interface Calls {
  findTransactionByExternalId: string[];
  recordIfNew: string[];
  markPaid: string[];
  activity: { memberId: string | null; communityId: string; eventType: string }[];
}

/** A recording harness whose call log is the assertion target for ORDERING. */
function harness(
  options: {
    transaction?: TransactionRecord | null;
    alreadySeen?: boolean;
    failMarkPaid?: boolean;
  } = {}
) {
  const calls: Calls = {
    findTransactionByExternalId: [],
    recordIfNew: [],
    markPaid: [],
    activity: [],
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
    async findTransactionByExternalId(id) {
      calls.findTransactionByExternalId.push(id);
      order.push("find");
      return transaction;
    },
    async markPaid(input): Promise<MarkPaidResult> {
      calls.markPaid.push(input.transactionId);
      order.push("markPaid");
      if (options.failMarkPaid === true) {
        throw new Error("activation blew up");
      }
      return {
        transaction: transactionRecord({ status: "success", paidAt: input.paidAt }),
        subscription: {
          id: "sub-1",
          memberId: "member-1",
          tierId: "tier-1",
          status: "active",
          nextBillingDate: "2026-09-09",
          startedAt: input.paidAt,
          retryCount: 0,
          lastAttemptAt: null,
          createdAt: new Date("2026-08-09T09:00:00Z"),
          updatedAt: new Date("2026-08-09T10:00:00Z"),
        },
        communityId: "community-1",
      };
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
        const result = await work({ subscriptions, webhookEvents, activityLog });
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
      "uow:commit",
    ]);
  });

  it("passes the provider's invoice id through as the gateway reference", async () => {
    const { useCase } = harness();
    const result = await useCase.execute(paidEvent());
    expect(result.activated).toBe(true);
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
