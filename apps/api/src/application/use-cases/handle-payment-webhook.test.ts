import { describe, expect, it } from "bun:test";
import { FixedClock } from "../../infrastructure/clock/fixed.clock";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import type { ActivityLogRepositoryPort } from "../ports/activity-log-repository.port";
import type { OutboxRepositoryPort } from "../ports/outbox-repository.port";
import type { PaymentActivationUnitOfWorkPort } from "../ports/payment-activation-unit-of-work.port";
import type {
  MarkPaidOutcome,
  SubscriptionRepositoryPort,
  TransactionRecord,
} from "../ports/subscription-repository.port";
import type {
  UserSubscriptionRepositoryPort,
  UserSubscriptionRow,
  UserTransactionRow,
} from "../ports/user-subscription-repository.port";
import type {
  UserTierRepositoryPort,
  UserTierRow,
} from "../ports/user-tier-repository.port";
import type { WebhookEventRepositoryPort } from "../ports/webhook-event-repository.port";
import { HandlePaymentWebhook } from "./handle-payment-webhook";

const TRANSACTION_ID = "3f1c9e0a-1111-4222-8333-444455556666";

/**
 * The instant the harness's clock reads, i.e. the `paidAt` the handler settles with.
 * Phase 5 injected the clock: `paidAt` is what the next billing period is measured from,
 * so a `new Date()` inside the handler made that arithmetic unassertable.
 */
const SETTLED_AT = new Date("2026-08-09T11:00:00.000Z");

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
      // Phase 5's grace deadline. Null here because an ACTIVATED subscription has no
      // deadline — only entering `past_due` writes one.
      graceEndsAt: null,
      startedAt: paidAt,
      retryCount: 0,
      lastAttemptAt: null,
      createdAt: new Date("2026-08-09T09:00:00Z"),
      updatedAt: new Date("2026-08-09T10:00:00Z"),
    },
    communityId: "community-1",
  };
}

/**
 * Every method throws. Handed to the COMMUNITY harness so that a community
 * invoice reaching into `user_subscription`/`user_tier` — the regression this
 * task's whole shape exists to prevent — fails loudly instead of quietly
 * returning `null` and looking like correct behaviour.
 */
function forbiddenUserSubscriptions(): UserSubscriptionRepositoryPort {
  const forbid = (name: string) => () => {
    throw new Error(`a community invoice must not touch userSubscriptions.${name}`);
  };
  return {
    create: forbid("create"),
    claimPending: forbid("claimPending"),
    findById: forbid("findById"),
    activate: forbid("activate"),
    cancel: forbid("cancel"),
    findActiveFor: forbid("findActiveFor"),
    createTransaction: forbid("createTransaction"),
    findTransactionById: forbid("findTransactionById"),
    attachGatewayReference: forbid("attachGatewayReference"),
    findPendingCheckout: forbid("findPendingCheckout"),
    markTransactionPaid: forbid("markTransactionPaid"),
  } as unknown as UserSubscriptionRepositoryPort;
}

function forbiddenUserTiers(): UserTierRepositoryPort {
  const forbid = (name: string) => () => {
    throw new Error(`a community invoice must not touch userTiers.${name}`);
  };
  return {
    create: forbid("create"),
    findById: forbid("findById"),
    listByOwner: forbid("listByOwner"),
    listActiveByOwner: forbid("listActiveByOwner"),
    deactivate: forbid("deactivate"),
  } as unknown as UserTierRepositoryPort;
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
     * `markPaid` refused: the subscription this payment was for has been CHURNED,
     * which is terminal. Nothing was written, so the delivery must be refused too
     * rather than answered 200 — see C2 in the final whole-branch review.
     */
    subscriptionChurned?: boolean;
    /**
     * `markPaid` reports the member already holds an active subscription to this
     * tier, so this one was cancelled instead of activated.
     */
    superseded?: boolean;
    /**
     * `markPaid` reports the activation EXTENDED an existing membership. Phase 5: the
     * audit entry is `renewed` rather than `joined`, because Phase 6 counts `joined` rows
     * as new members.
     */
    renewed?: boolean;
    /** What the injected clock reads, i.e. the `paidAt` the handler settles with. */
    now?: Date;
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
    async createActiveWithoutBilling() {
      throw new Error("not used");
    },
    async findCurrentSubscriptionForTier() {
      return null;
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
    async findDueForRenewal() {
      throw new Error("not used");
    },
    async markPastDue() {
      throw new Error("not used");
    },
    async findPastGraceDeadline() {
      throw new Error("not used");
    },
    async markChurned() {
      throw new Error("not used");
    },
    async findRenewalContext() {
      throw new Error("not used");
    },
    async hasLiveSubscriptionInCommunity() {
      throw new Error("not used");
    },
    async listActiveForCommunity() {
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
      if (options.subscriptionChurned === true) {
        // The real repository rolls its own statement back before returning this, so
        // NOTHING was written — including the transaction's settlement. Mirrored by
        // returning it without recording an activation.
        return { outcome: "subscription_churned", subscriptionStatus: "churned" };
      }
      if (options.alreadySettled === true) {
        return { outcome: "already_settled", status: "success" };
      }
      return {
        ...activationResult(input.paidAt),
        outcome: "activated",
        renewed: options.renewed === true,
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

  const outbox: OutboxRepositoryPort = {
    async enqueue(input) {
      calls.enqueued.push({ eventType: input.eventType, payload: input.payload });
      order.push("outbox");
      return { id: `outbox-${calls.enqueued.length}` };
    },
    async enqueueMany() {
      throw new Error("not used");
    },
    async claimBatch() {
      throw new Error("not used");
    },
    async touchProcessing() {
      // not used
    },
    async releaseToPending() {
      return 0;
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
        const result = await work({
          subscriptions,
          // THROWS ON EVERY METHOD, deliberately. This is the community harness,
          // and Phase 5a's tables must not be touched by a community invoice —
          // a silent no-op fake would let that regression pass unnoticed.
          userSubscriptions: forbiddenUserSubscriptions(),
          userTiers: forbiddenUserTiers(),
          webhookEvents,
          activityLog,
          outbox,
        });
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
    useCase: new HandlePaymentWebhook(
      subscriptions,
      forbiddenUserSubscriptions(),
      unitOfWork,
      new FixedClock(options.now ?? SETTLED_AT)
    ),
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
   * C2, final whole-branch review. `churned` is the state machine's terminal state, so
   * a payment that arrives for a churned subscription cannot be applied — and it must
   * not be swallowed either. The same treatment `conflicting_status` gets, because it is
   * the same problem: a real payment nobody can settle without a person looking at it.
   */
  describe("a payment for a subscription that has already been CHURNED", () => {
    it("throws a 409, so the delivery is not answered 200 and thrown away", async () => {
      const { useCase } = harness({ subscriptionChurned: true });

      let thrown: unknown;
      await captureWarnings(async () => {
        thrown = await useCase.execute(paidEvent()).catch((err: unknown) => err);
      });

      expect(thrown).toBeInstanceOf(ConflictError);
      expect((thrown as ConflictError).status).toBe(409);
    });

    it("records nothing and rolls the event id back, so it can be replayed", async () => {
      const { useCase, calls, order } = harness({ subscriptionChurned: true });

      let thrown: unknown;
      await captureWarnings(async () => {
        thrown = await useCase.execute(paidEvent()).catch((err: unknown) => err);
      });

      // Asserted here too, and not only above: an UNHANDLED outcome also rolls back —
      // by reading `subscription` off a result that has none and throwing a TypeError —
      // so the emptiness below proves nothing on its own.
      expect(thrown).toBeInstanceOf(ConflictError);
      expect(calls.activity).toEqual([]);
      // A churned member's re-grant is a NEW subscription with an unban and a fresh
      // link. Enqueuing a grant here would reactivate the revoked membership and mint a
      // second invite link against a subscription nobody is paying for.
      expect(calls.enqueued).toEqual([]);
      expect(order).toEqual(["find", "uow:begin", "recordIfNew", "markPaid", "uow:rollback"]);
    });

    it("ALERTS, naming the transaction and the subscription status only", async () => {
      const { useCase } = harness({ subscriptionChurned: true });

      const warnings = await captureWarnings(() =>
        useCase.execute(paidEvent()).catch(() => undefined)
      );

      const text = warnings.join("\n");
      expect(text).toContain("ALERT");
      expect(text).toContain("CHURNED");
      expect(text).toContain(TRANSACTION_ID);
      // The member HAS paid, and the line has to say so — that is what makes this
      // recoverable rather than a silent loss.
      expect(text).toMatch(/has PAID/);
      expect(text).not.toMatch(/already-settled/);
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

// ===========================================================================
// Task 7, Phase 5a — the SAME handler, the other kind of invoice.
//
// Xendit delivers ONE webhook stream. Everything below arrives at the identical
// public endpoint the block above tests, and is told apart from it by the
// `external_id` namespace alone.
// ===========================================================================

/** `usub_` as a LITERAL, never the imported constant: the wire format is the thing under test. */
const USER_EXTERNAL_ID = "usub_9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const USER_TRANSACTION_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const USER_SUBSCRIPTION_ID = "11111111-2222-4333-8444-555566667777";
const USER_TIER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SUBSCRIBER_ID = "22222222-3333-4444-8555-666677778888";
const OWNER_ID = "33333333-4444-4555-8666-777788889999";

function userTransactionRow(overrides: Partial<UserTransactionRow> = {}): UserTransactionRow {
  return {
    id: USER_TRANSACTION_ID,
    userSubscriptionId: USER_SUBSCRIPTION_ID,
    amount: 50000,
    status: "pending",
    // `StartUserSubscription.attachGatewayReference` wrote this after the
    // provider call returned. It is the anchor `body.id` is verified against, so
    // it is present by default — a null here is its own (tested) refusal.
    gatewayReferenceId: "inv_user_1",
    gatewayInvoiceUrl: "https://fake-checkout.local/inv_user_1",
    paidAt: null,
    createdAt: new Date("2026-08-09T09:00:00Z"),
    ...overrides,
  };
}

function userSubscriptionRow(overrides: Partial<UserSubscriptionRow> = {}): UserSubscriptionRow {
  return {
    id: USER_SUBSCRIPTION_ID,
    subscriberId: SUBSCRIBER_ID,
    tierId: USER_TIER_ID,
    ownerId: OWNER_ID,
    status: "pending",
    currentPeriodEnd: null,
    createdAt: new Date("2026-08-09T09:00:00Z"),
    ...overrides,
  };
}

function userTierRow(overrides: Partial<UserTierRow> = {}): UserTierRow {
  return {
    id: USER_TIER_ID,
    ownerId: OWNER_ID,
    name: "Anggota",
    priceAmount: 50000,
    billingCycle: "monthly",
    isActive: true,
    createdAt: new Date("2026-08-01T09:00:00Z"),
    ...overrides,
  };
}

interface UserCalls {
  findTransactionById: string[];
  findSubscriptionById: string[];
  findTier: string[];
  findActiveFor: { subscriberId: string; ownerId: string }[];
  markTransactionPaid: { id: string; paidAt: Date }[];
  activate: { id: string; periodEnd: Date }[];
  cancel: string[];
  recordIfNew: string[];
  /** Community repositories. Must stay empty for every test in this block. */
  community: string[];
}

/**
 * STATEFUL on purpose, unlike the community harness above.
 *
 * Idempotency is the property this block exists to prove, and a fake that
 * answers `recordIfNew` from a flag rather than from what it has already seen
 * cannot prove it: the second delivery would be told it is new by a constant.
 * So this one remembers event ids, settles the transaction when it is told to,
 * and activates the subscription — which makes "deliver the same body twice" a
 * real test rather than a staged one.
 */
function userHarness(
  options: {
    transaction?: UserTransactionRow | null;
    subscription?: UserSubscriptionRow | null;
    tier?: UserTierRow | null;
    /**
     * A DIFFERENT subscription that already holds this pair's one active slot —
     * the state `user_subscription_one_active` would refuse a second row for.
     */
    activeSibling?: UserSubscriptionRow | null;
    now?: Date;
  } = {}
) {
  const calls: UserCalls = {
    findTransactionById: [],
    findSubscriptionById: [],
    findTier: [],
    findActiveFor: [],
    markTransactionPaid: [],
    activate: [],
    cancel: [],
    recordIfNew: [],
    community: [],
  };
  const order: string[] = [];
  const seenEventIds = new Set<string>();

  let transaction =
    options.transaction === undefined ? userTransactionRow() : options.transaction;
  let subscription =
    options.subscription === undefined ? userSubscriptionRow() : options.subscription;
  const tier = options.tier === undefined ? userTierRow() : options.tier;
  let activeSibling = options.activeSibling ?? null;

  const forbid = (name: string) => () => {
    throw new Error(`a user-subscription invoice must not touch subscriptions.${name}`);
  };
  const community = {
    async findTransactionByExternalId(id: string) {
      // Recorded rather than thrown, so the assertion names the leak instead of
      // an exception message.
      calls.community.push(id);
      order.push("community:find");
      return null;
    },
    createPending: forbid("createPending"),
    createActiveWithoutBilling: forbid("createActiveWithoutBilling"),
    findCurrentSubscriptionForTier: forbid("findCurrentSubscriptionForTier"),
    createTransaction: forbid("createTransaction"),
    findById: forbid("findById"),
    findByIdWithCommunity: forbid("findByIdWithCommunity"),
    attachGatewayReference: forbid("attachGatewayReference"),
    findDueForRenewal: forbid("findDueForRenewal"),
    markPastDue: forbid("markPastDue"),
    findPastGraceDeadline: forbid("findPastGraceDeadline"),
    markChurned: forbid("markChurned"),
    findRenewalContext: forbid("findRenewalContext"),
    hasLiveSubscriptionInCommunity: forbid("hasLiveSubscriptionInCommunity"),
    listActiveForCommunity: forbid("listActiveForCommunity"),
    markPaid: forbid("markPaid"),
  } as unknown as SubscriptionRepositoryPort;

  const userSubscriptions: UserSubscriptionRepositoryPort = {
    ...forbiddenUserSubscriptions(),
    async findTransactionById(id) {
      calls.findTransactionById.push(id);
      order.push("findTransaction");
      return transaction !== null && transaction.id === id ? transaction : null;
    },
    async findById(id) {
      calls.findSubscriptionById.push(id);
      order.push("findSubscription");
      return subscription !== null && subscription.id === id ? subscription : null;
    },
    async findActiveFor(subscriberId, ownerId) {
      calls.findActiveFor.push({ subscriberId, ownerId });
      order.push("findActiveFor");
      if (activeSibling !== null) return activeSibling;
      return subscription !== null &&
        subscription.status === "active" &&
        subscription.subscriberId === subscriberId &&
        subscription.ownerId === ownerId
        ? subscription
        : null;
    },
    async markTransactionPaid(id, paidAt) {
      calls.markTransactionPaid.push({ id, paidAt });
      order.push("markTransactionPaid");
      if (transaction === null || transaction.id !== id) return null;
      transaction = { ...transaction, status: "paid", paidAt };
      return transaction;
    },
    async activate(id, periodEnd) {
      calls.activate.push({ id, periodEnd });
      order.push("activate");
      if (subscription === null || subscription.id !== id) return null;
      subscription = { ...subscription, status: "active", currentPeriodEnd: periodEnd };
      // What the partial unique index means: once this row is active, it IS the
      // pair's active subscription.
      activeSibling = null;
      return subscription;
    },
    async cancel(id) {
      calls.cancel.push(id);
      order.push("cancel");
      if (subscription === null || subscription.id !== id) return null;
      subscription = { ...subscription, status: "cancelled" };
      return subscription;
    },
  };

  const userTiers: UserTierRepositoryPort = {
    ...forbiddenUserTiers(),
    async findById(id) {
      calls.findTier.push(id);
      order.push("findTier");
      return tier !== null && tier.id === id ? tier : null;
    },
  };

  const webhookEvents: WebhookEventRepositoryPort = {
    async recordIfNew(input) {
      calls.recordIfNew.push(input.providerEventId);
      order.push("recordIfNew");
      // The UNIQUE constraint, modelled: the SECOND caller with this id is told
      // it is not new, exactly as `onConflictDoNothing` would.
      if (seenEventIds.has(input.providerEventId)) return false;
      seenEventIds.add(input.providerEventId);
      return true;
    },
  };

  const activityLog: ActivityLogRepositoryPort = {
    async record() {
      throw new Error("a user subscription writes no community activity_log entry");
    },
  };

  const outbox = {
    async enqueue() {
      throw new Error("a user subscription queues no Telegram grant in 5a");
    },
  } as unknown as OutboxRepositoryPort;

  /** Rolls the recorded event ids back too, so a failed delivery stays replayable. */
  const unitOfWork: PaymentActivationUnitOfWorkPort = {
    async run(work) {
      order.push("uow:begin");
      const claimedBefore = new Set(seenEventIds);
      const transactionBefore = transaction;
      const subscriptionBefore = subscription;
      try {
        const result = await work({
          subscriptions: community,
          userSubscriptions,
          userTiers,
          webhookEvents,
          activityLog,
          outbox,
        });
        order.push("uow:commit");
        return result;
      } catch (error) {
        order.push("uow:rollback");
        seenEventIds.clear();
        for (const id of claimedBefore) seenEventIds.add(id);
        transaction = transactionBefore;
        subscription = subscriptionBefore;
        throw error;
      }
    },
  };

  return {
    calls,
    order,
    state: {
      get transaction() {
        return transaction;
      },
      get subscription() {
        return subscription;
      },
    },
    useCase: new HandlePaymentWebhook(
      community,
      userSubscriptions,
      unitOfWork,
      new FixedClock(options.now ?? SETTLED_AT)
    ),
  };
}

function userPaidEvent(overrides: Record<string, unknown> = {}) {
  return {
    providerEventId: "inv_user_1:PAID",
    invoiceId: "inv_user_1",
    externalId: USER_EXTERNAL_ID,
    status: "PAID",
    amount: 50000,
    eventType: "invoice.paid",
    paymentMethod: undefined,
    payload: { id: "inv_user_1", status: "PAID" },
    ...overrides,
  };
}

describe("HandlePaymentWebhook — user subscriptions (Task 7, Phase 5a)", () => {
  it("activates a user subscription when its invoice is PAID", async () => {
    const { useCase, calls, state } = userHarness();

    const result = await useCase.execute(userPaidEvent());

    expect(result).toEqual({ activated: true, duplicate: false });
    expect(state.subscription!.status).toBe("active");
    expect(state.transaction!.status).toBe("paid");
    expect(calls.markTransactionPaid).toEqual([
      { id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", paidAt: SETTLED_AT },
    ]);
    expect(calls.activate).toHaveLength(1);
  });

  it("resolves the transaction by the id BEHIND the prefix, never the whole external id", async () => {
    const { useCase, calls } = userHarness();

    await useCase.execute(userPaidEvent());

    // TWICE, and both with the sliced id: once on the pool for the amount check
    // that must happen before a transaction is opened, and once inside the unit
    // of work so the status it settles on is the committed one. Never the raw
    // `usub_…` string, which no table has a row for.
    expect(calls.findTransactionById).toEqual([
      "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
      "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
    ]);
  });

  it("ends the period one billing cycle after the instant WE settled it", async () => {
    // Not a timestamp off the body: `paid_at` in a callback is attacker-chosen,
    // and moving it moves when a member's access runs out.
    const { useCase, calls, state } = userHarness();

    await useCase.execute(userPaidEvent());

    expect(calls.activate[0].periodEnd).toEqual(new Date("2026-09-09T11:00:00.000Z"));
    expect(state.subscription!.currentPeriodEnd).toEqual(new Date("2026-09-09T11:00:00.000Z"));
  });

  it("measures the period with the TIER's billing cycle, not a default", async () => {
    const { useCase, calls } = userHarness({ tier: userTierRow({ billingCycle: "yearly" }) });

    await useCase.execute(userPaidEvent());

    expect(calls.activate[0].periodEnd).toEqual(new Date("2027-08-09T11:00:00.000Z"));
  });

  it("never touches the community tables for a namespaced invoice", async () => {
    const { useCase, calls } = userHarness();

    await useCase.execute(userPaidEvent());

    expect(calls.community).toEqual([]);
  });

  it("IGNORES an external_id matching neither namespace, without throwing", async () => {
    for (const junk of ["haxx", "1 OR 1=1", "usub_", "usub_x", "", "inv_9f2"]) {
      const { useCase, calls, order } = userHarness();

      const result = await useCase.execute(userPaidEvent({ externalId: junk }));

      expect(result).toEqual({ activated: false, duplicate: false });
      // Nothing looked up, in EITHER namespace, and no transaction opened: an
      // unrecognised id is somebody else's invoice or a probe, and this endpoint
      // is public.
      expect(calls.community).toEqual([]);
      expect(calls.findTransactionById).toEqual([]);
      expect(calls.recordIfNew).toEqual([]);
      expect(order).toEqual([]);
    }
  });

  it("is idempotent: the same PAID webhook twice activates once and extends the period once", async () => {
    // Redelivery is normal provider behaviour, not an edge case.
    const { useCase, calls, state } = userHarness();

    const first = await useCase.execute(userPaidEvent());
    const second = await useCase.execute(userPaidEvent());

    expect(first).toEqual({ activated: true, duplicate: false });
    expect(second).toEqual({ activated: false, duplicate: true });
    expect(calls.activate).toHaveLength(1);
    expect(calls.markTransactionPaid).toHaveLength(1);
    expect(state.subscription!.currentPeriodEnd).toEqual(new Date("2026-09-09T11:00:00.000Z"));
  });

  it("does not extend the period even when the redelivery arrives a month later", async () => {
    // The clock is what `periodEnd` is measured from, so a replay that got past
    // the guard would move the member's expiry forward by a whole cycle.
    const { useCase, calls } = userHarness();
    await useCase.execute(userPaidEvent());

    const later = userHarness({ now: new Date("2026-09-09T11:00:00.000Z") });
    await later.useCase.execute(userPaidEvent());
    await later.useCase.execute(userPaidEvent());

    expect(calls.activate).toHaveLength(1);
    expect(later.calls.activate).toHaveLength(1);
    expect(later.state.subscription!.currentPeriodEnd).toEqual(
      new Date("2026-10-09T11:00:00.000Z")
    );
  });

  it("claims the event id INSIDE the unit of work, before anything it authorises", async () => {
    const { useCase, order } = userHarness();

    await useCase.execute(userPaidEvent());

    expect(order.indexOf("recordIfNew")).toBeGreaterThan(order.indexOf("uow:begin"));
    expect(order.indexOf("recordIfNew")).toBeLessThan(order.indexOf("activate"));
    expect(order.indexOf("activate")).toBeLessThan(order.indexOf("uow:commit"));
  });

  it("refuses a payload claiming a different amount than our own record", async () => {
    // The existing handler logs `[security] webhook amount mismatch` because this
    // was a real finding. Our record is the truth; the payload is a claim.
    const { useCase, calls, order } = userHarness();

    await expect(useCase.execute(userPaidEvent({ amount: 1 }))).rejects.toThrow(
      "webhook amount does not match our record"
    );

    expect(calls.activate).toEqual([]);
    expect(calls.recordIfNew).toEqual([]);
    // Refused BEFORE a transaction is opened, so a forger cannot burn the event
    // id a genuine delivery needs.
    expect(order).not.toContain("uow:begin");
  });

  it("refuses an amount HIGHER than ours too, not only lower", async () => {
    const { useCase, calls } = userHarness();

    await expect(useCase.execute(userPaidEvent({ amount: 500000 }))).rejects.toThrow(
      "webhook amount does not match our record"
    );
    expect(calls.activate).toEqual([]);
  });

  it("logs the amount mismatch with ids and integers only", async () => {
    const original = console.warn;
    const lines: string[] = [];
    console.warn = (line: string) => lines.push(line);
    try {
      const { useCase } = userHarness();
      await expect(
        useCase.execute(
          userPaidEvent({ amount: 1, payload: { payer_email: "rina@example.com" } })
        )
      ).rejects.toThrow(ValidationError);
    } finally {
      console.warn = original;
    }

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[security] webhook amount mismatch");
    expect(lines[0]).toContain("expected=50000");
    expect(lines[0]).toContain("claimed=1");
    expect(lines[0]).not.toContain("rina@example.com");
  });

  it("refuses a delivery whose invoice id is not the one checkout recorded", async () => {
    const { useCase, calls, order } = userHarness();

    await expect(
      useCase.execute(userPaidEvent({ invoiceId: "forged-inv-7" }))
    ).rejects.toThrow("webhook invoice id does not match our record");

    expect(calls.activate).toEqual([]);
    expect(order).not.toContain("uow:begin");
  });

  it("fails CLOSED when checkout never recorded an invoice id at all", async () => {
    const { useCase, calls } = userHarness({
      transaction: userTransactionRow({ gatewayReferenceId: null }),
    });

    await expect(useCase.execute(userPaidEvent())).rejects.toThrow(
      "this transaction cannot be verified against the provider"
    );
    expect(calls.activate).toEqual([]);
  });

  it("404s a namespaced id with no transaction behind it, recording nothing", async () => {
    const { useCase, calls } = userHarness({ transaction: null });

    await expect(useCase.execute(userPaidEvent())).rejects.toThrow(NotFoundError);
    expect(calls.recordIfNew).toEqual([]);
  });

  it("records but does not activate any status other than PAID", async () => {
    for (const status of ["EXPIRED", "PENDING", "FAILED", "SETTLED", "paid", "Paid"]) {
      const { useCase, calls, state } = userHarness();

      const result = await useCase.execute(
        userPaidEvent({ status, providerEventId: `inv_user_1:${status}` })
      );

      expect(result).toEqual({ activated: false, duplicate: false });
      expect(calls.recordIfNew).toEqual([`inv_user_1:${status}`]);
      expect(calls.activate).toEqual([]);
      expect(calls.markTransactionPaid).toEqual([]);
      expect(state.subscription!.status).toBe("pending");
      expect(state.transaction!.status).toBe("pending");
    }
  });

  it("still compares the amount when the status is not PAID", async () => {
    const { useCase, calls } = userHarness();

    await expect(
      useCase.execute(userPaidEvent({ status: "EXPIRED", amount: 1 }))
    ).rejects.toThrow("webhook amount does not match our record");
    expect(calls.recordIfNew).toEqual([]);
  });

  it("says out loud that a non-PAID delivery was recorded and not actioned", async () => {
    const original = console.warn;
    const lines: string[] = [];
    console.warn = (line: string) => lines.push(line);
    try {
      const { useCase } = userHarness();
      await useCase.execute(
        userPaidEvent({ status: "EXPIRED\nPAID", providerEventId: "inv_user_1:EXPIRED" })
      );
    } finally {
      console.warn = original;
    }

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[payments] webhook recorded but NOT actioned");
    // One line, not two: an attacker-chosen status must not forge a log entry.
    expect(lines[0].split("\n")).toHaveLength(1);
    expect(lines[0]).toContain("status=EXPIRED?PAID");
  });

  it("stays silent on a successful activation — the warning must mean something", async () => {
    const original = console.warn;
    const lines: string[] = [];
    console.warn = (line: string) => lines.push(line);
    try {
      const { useCase } = userHarness();
      await useCase.execute(userPaidEvent());
    } finally {
      console.warn = original;
    }

    expect(lines).toEqual([]);
  });

  describe("a second PAID for a pair that is ALREADY active", () => {
    /**
     * Task 6's `user_subscription_one_pending` stops two live invoices being
     * minted, but it is not retroactive and a provider can still redeliver oddly.
     * Activating here would violate `user_subscription_one_active` — and a 500 to
     * Xendit means retries, and retries mean the same failure repeatedly.
     */
    const activeSibling = () =>
      userSubscriptionRow({
        id: "99999999-8888-4777-8666-555544443333",
        status: "active",
        currentPeriodEnd: new Date("2026-09-01T00:00:00Z"),
      });

    it("does not 500, and does not activate a second subscription for the pair", async () => {
      const { useCase, calls, state } = userHarness({ activeSibling: activeSibling() });

      const result = await useCase.execute(userPaidEvent());

      expect(result).toEqual({ activated: false, duplicate: false });
      expect(calls.activate).toEqual([]);
      expect(state.subscription!.status).not.toBe("active");
    });

    it("RECORDS the event, so the provider stops retrying a delivery nothing can fix", async () => {
      const { useCase, calls } = userHarness({ activeSibling: activeSibling() });

      await useCase.execute(userPaidEvent());

      expect(calls.recordIfNew).toEqual(["inv_user_1:PAID"]);
    });

    it("records the money as collected, so the refund owed is visible", async () => {
      const { useCase, state } = userHarness({ activeSibling: activeSibling() });

      await useCase.execute(userPaidEvent());

      expect(state.transaction!.status).toBe("paid");
      expect(state.transaction!.paidAt).toEqual(SETTLED_AT);
    });

    it("releases the pending slot, so this pair is not wedged out of buying again", async () => {
      // Nothing in 5a expires a pending `user_subscription`, and
      // `user_subscription_one_pending` means one left behind blocks every later
      // checkout for that pair.
      const { useCase, calls, state } = userHarness({ activeSibling: activeSibling() });

      await useCase.execute(userPaidEvent());

      expect(calls.cancel).toEqual([USER_SUBSCRIPTION_ID]);
      expect(state.subscription!.status).toBe("cancelled");
    });

    it("ALERTS, naming ids and the amount and nothing else", async () => {
      const original = console.warn;
      const lines: string[] = [];
      console.warn = (line: string) => lines.push(line);
      try {
        const { useCase } = userHarness({ activeSibling: activeSibling() });
        await useCase.execute(
          userPaidEvent({ payload: { payer_email: "rina@example.com", payer_name: "Rina" } })
        );
      } finally {
        console.warn = original;
      }

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("[payments] ALERT");
      expect(lines[0]).toContain(USER_SUBSCRIPTION_ID);
      expect(lines[0]).toContain("amount=50000");
      expect(lines[0]).not.toContain("rina@example.com");
      expect(lines[0]).not.toContain("Rina");
    });

    it("still activates a subscription that is ITSELF the pair's active row", async () => {
      // The exclusion of the row itself is what keeps this from refusing a
      // legitimate re-delivery against the very subscription being activated.
      const { useCase, calls } = userHarness({
        subscription: userSubscriptionRow({ status: "active" }),
      });

      const result = await useCase.execute(userPaidEvent());

      expect(result).toEqual({ activated: true, duplicate: false });
      expect(calls.cancel).toEqual([]);
    });
  });

  describe("a transaction that is no longer pending", () => {
    it("treats an already-PAID transaction as an idempotent no-op, not a second activation", async () => {
      const { useCase, calls } = userHarness({
        transaction: userTransactionRow({ status: "paid", paidAt: SETTLED_AT }),
      });

      const result = await useCase.execute(userPaidEvent());

      expect(result).toEqual({ activated: false, duplicate: true });
      expect(calls.activate).toEqual([]);
      expect(calls.markTransactionPaid).toEqual([]);
    });

    it("throws a 409 for any OTHER non-pending status rather than answering 200 and losing it", async () => {
      const { useCase, calls, order } = userHarness({
        transaction: userTransactionRow({ status: "failed" }),
      });

      await expect(useCase.execute(userPaidEvent())).rejects.toThrow(ConflictError);

      expect(calls.activate).toEqual([]);
      // Rolled back, so the event id is unspent and the delivery can be replayed
      // once somebody has reconciled the row by hand.
      expect(order).toContain("uow:rollback");
    });
  });

  it("rolls the event id back when the activation itself fails", async () => {
    const { useCase, order } = userHarness({ subscription: null });

    await expect(useCase.execute(userPaidEvent())).rejects.toThrow();

    expect(order).toContain("uow:rollback");
  });

  it("throws rather than writing a wrong period when the tier's cycle is unrecognised", async () => {
    // `user_tier.billing_cycle` is a varchar, not an enum. A 500 with the
    // delivery unrecorded is replayable; a guessed cycle is a wrong expiry date
    // nobody would notice.
    const { useCase, calls, order } = userHarness({
      tier: userTierRow({ billingCycle: "weekly" }),
    });

    await expect(useCase.execute(userPaidEvent())).rejects.toThrow("unrecognised billing cycle");

    expect(calls.activate).toEqual([]);
    expect(order).toContain("uow:rollback");
  });
});

/**
 * The regression that matters: this task edits a handler serving live money.
 * Community invoices must resolve by exactly the path they do today.
 */
describe("HandlePaymentWebhook — community invoices are untouched by the routing", () => {
  it("still resolves COMMUNITY invoices exactly as before", async () => {
    const { useCase, calls, order } = harness();

    const result = await useCase.execute(paidEvent());

    expect(result).toEqual({ activated: true, duplicate: false });
    // The external id reaches the community repository VERBATIM — not sliced,
    // not re-derived, not looked up in the other namespace first.
    expect(calls.findTransactionByExternalId).toEqual(["3f1c9e0a-1111-4222-8333-444455556666"]);
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

  it("hands a bare uuid to the community handler even though `usub_` exists", async () => {
    // The routing must not become "try one, then the other": a community
    // transaction id is a bare uuid and always was.
    const { useCase, calls } = harness();

    await useCase.execute(paidEvent());

    expect(calls.findTransactionByExternalId).toHaveLength(1);
    expect(calls.markPaid).toEqual(["3f1c9e0a-1111-4222-8333-444455556666"]);
  });

  it("still 404s an unknown community transaction, rather than ignoring it", async () => {
    // A bare uuid IS the community shape, so an unknown one is a real failure we
    // want the provider to retry — not a probe to be waved through.
    const { useCase, calls } = harness({ transaction: null });

    await expect(useCase.execute(paidEvent())).rejects.toThrow(NotFoundError);
    expect(calls.recordIfNew).toEqual([]);
  });
});
