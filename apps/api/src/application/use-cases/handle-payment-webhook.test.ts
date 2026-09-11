import { describe, expect, it } from "bun:test";
import { FixedClock } from "../../infrastructure/clock/fixed.clock";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import type { PaymentActivationUnitOfWorkPort } from "../ports/payment-activation-unit-of-work.port";
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

/**
 * The instant the harness's clock reads, i.e. the `paidAt` the handler settles with.
 * Phase 5 injected the clock: `paidAt` is what the next billing period is measured from,
 * so a `new Date()` inside the handler made that arithmetic unassertable.
 */
const SETTLED_AT = new Date("2026-08-09T11:00:00.000Z");

/**
 * Every method throws.
 *
 * The harness below spreads this and overrides only the four methods the handler
 * is allowed to call, so any OTHER method it learns to call fails loudly and by
 * name instead of quietly returning `null` and looking like correct behaviour.
 */
function forbiddenUserSubscriptions(): UserSubscriptionRepositoryPort {
  const forbid = (name: string) => () => {
    throw new Error(`the payment webhook must not call userSubscriptions.${name}`);
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
    throw new Error(`the payment webhook must not call userTiers.${name}`);
  };
  return {
    create: forbid("create"),
    findById: forbid("findById"),
    listByOwner: forbid("listByOwner"),
    listActiveByOwner: forbid("listActiveByOwner"),
    deactivate: forbid("deactivate"),
  } as unknown as UserTierRepositoryPort;
}

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
// The handler, and the one kind of invoice this codebase mints.
//
// Xendit delivers ONE webhook stream to ONE public endpoint. Retire-telegram
// Task 5 deleted the community half of this handler and its harness with it;
// what survives is the membership path and — the part the deletion put at risk —
// the rule that an `external_id` outside the `usub_` namespace is IGNORED rather
// than assumed to be the kind that is left.
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
    kind: "paid",
    currentPeriodEnd: null,
    communityId: null,
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
    communityId: null,
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
  };
  const order: string[] = [];
  const seenEventIds = new Set<string>();

  let transaction =
    options.transaction === undefined ? userTransactionRow() : options.transaction;
  let subscription =
    options.subscription === undefined ? userSubscriptionRow() : options.subscription;
  const tier = options.tier === undefined ? userTierRow() : options.tier;
  let activeSibling = options.activeSibling ?? null;

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

  /** Rolls the recorded event ids back too, so a failed delivery stays replayable. */
  const unitOfWork: PaymentActivationUnitOfWorkPort = {
    async run(work) {
      order.push("uow:begin");
      const claimedBefore = new Set(seenEventIds);
      const transactionBefore = transaction;
      const subscriptionBefore = subscription;
      try {
        const result = await work({ userSubscriptions, userTiers, webhookEvents });
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

  /**
   * THE RULE THAT HAD TO SURVIVE ITS OWN SECOND WORLD (retire-telegram Task 5).
   *
   * With the community branch deleted there is exactly ONE kind of invoice left,
   * and the temptation the deletion creates is to treat "unrecognised prefix" as
   * "must be the surviving kind". That would activate a membership against a
   * payment for something else — somebody else's invoice, or a probe.
   *
   * A BARE UUID is the sharp case and it is why this list grew: it is a
   * well-formed id, it is exactly what a retired community invoice carried, and
   * it is now nobody's. Nothing may be looked up for it, in either namespace, and
   * no unit of work may be opened — this endpoint is public.
   */
  it("IGNORES an external_id matching neither namespace, without throwing", async () => {
    for (const junk of [
      "haxx",
      "1 OR 1=1",
      "usub_",
      "usub_x",
      "",
      "inv_9f2",
      "sub_1234",
      // A bare uuid: the shape every retired community invoice carried.
      "3f1c9e0a-1111-4222-8333-444455556666",
    ]) {
      const { useCase, calls, order } = userHarness();

      const result = await useCase.execute(userPaidEvent({ externalId: junk }));

      expect(result).toEqual({ activated: false, duplicate: false });
      // Nothing looked up and no transaction opened: an unrecognised id is
      // somebody else's invoice or a probe, and this endpoint is public.
      expect(calls.findTransactionById).toEqual([]);
      expect(calls.recordIfNew).toEqual([]);
      expect(order).toEqual([]);
    }
  });

  /**
   * The ignore branch is not silent, and it is not chatty either.
   *
   * An operator reading these logs when payments look wrong needs to see that a
   * delivery arrived and was declined as not-ours; what they must NOT see is the
   * payer's name, email or phone number, all of which a Xendit callback carries.
   * `external_id` and `status` are attacker-chosen text, so both go through
   * `safeLabel` — a newline in either would otherwise forge a second log line in
   * exactly the log being read to diagnose the problem.
   */
  it("says out loud that it IGNORED a delivery, with ids only and no forged second line", async () => {
    const { useCase } = userHarness();

    const warnings = await captureWarnings(() =>
      useCase.execute(
        userPaidEvent({
          externalId: "sub_123\n[payments] all clear",
          payload: {
            id: "inv_x",
            payer_email: "siti@example.com",
            customer: { given_names: "Siti", mobile_number: "+6281234567890" },
          },
        })
      )
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("webhook IGNORED");
    expect(warnings[0]).toContain("external_id=sub_123?");
    expect(warnings[0].split("\n")).toHaveLength(1);
    expect(warnings[0]).not.toContain("siti@example.com");
    expect(warnings[0]).not.toContain("Siti");
    expect(warnings[0]).not.toContain("+6281234567890");
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

  it("stops a replay AT the event-id guard, before it can re-read anything it authorises", async () => {
    // Found by mutation: deleting the `recordIfNew` early return left every other
    // assertion in this block green, because the transaction-status check below
    // it absorbed the replay. That check is a SECOND line of defence and this is
    // the defence — so the guard has to be pinned by where the work STOPS, not
    // only by the answer that comes back.
    const { useCase, calls, order } = userHarness();

    await useCase.execute(userPaidEvent());
    const readsAfterFirst = calls.findTransactionById.length;
    await useCase.execute(userPaidEvent());

    // Two reads for the first delivery — the pooled amount check, then the
    // re-read inside the unit of work. ONE for the second: the pooled check, and
    // then nothing, because `recordIfNew` refused it.
    expect(readsAfterFirst).toBe(2);
    expect(calls.findTransactionById).toHaveLength(3);
    expect(order.filter((step) => step === "recordIfNew")).toHaveLength(2);
    expect(order.filter((step) => step === "findSubscription")).toHaveLength(1);
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
