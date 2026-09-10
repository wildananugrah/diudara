import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { db } from "../db/client";
import {
  outbox,
  userSubscriptions,
  userTiers,
  userTransactions,
  webhookEvents,
} from "../db/schema";
import { resetDatabase } from "../db/test-helpers";

beforeEach(resetDatabase);

const TOKEN = process.env.XENDIT_CALLBACK_TOKEN ?? "test-callback-token";

function app() {
  return createApp(bootstrap());
}

function post(a: ReturnType<typeof app>, body: unknown, token: string | null = TOKEN) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) headers["X-CALLBACK-TOKEN"] = token;
  return a.request("/webhooks/xendit", { method: "POST", headers, body: JSON.stringify(body) });
}

/**
 * A delivery Xendit could plausibly have sent for `externalId`. `id` defaults to
 * a placeholder that will NOT match the recorded gateway reference, so every
 * call site must pass the real invoice id — that is deliberate: a helper that
 * quietly produced a verifiable body would hide the check under test.
 */
function paidEvent(externalId: string, overrides: Record<string, unknown> = {}) {
  return { id: "evt-1", external_id: externalId, status: "PAID", amount: 50000, ...overrides };
}

/** `paidEvent` with the invoice id the handler will accept. */
function verifiedEvent(
  externalId: string,
  invoiceId: string,
  overrides: Record<string, unknown> = {}
) {
  return paidEvent(externalId, { id: invoiceId, ...overrides });
}

/**
 * The public callback endpoint, end to end, against the real database and its
 * real constraints.
 *
 * ONE STREAM, ONE KIND OF INVOICE, AND EVERYTHING ELSE IGNORED. Retire-telegram
 * Task 5 deleted the community half of this handler; what it could not delete is
 * the fact that Xendit delivers every callback to one public endpoint
 * authenticated by a static token. So this block covers the membership path AND
 * the properties that belong to the ENDPOINT rather than to either world — token
 * verification, body parsing, the replay guard, amount verification, and the
 * rule that an `external_id` outside our namespace resolves to nothing. Those
 * were written against a community fixture until Task 5 and are ported here
 * rather than deleted with it.
 *
 * Nothing here contacts Xendit: `bootstrap()` wires `FakePaymentAdapter` under
 * NODE_ENV=test, and the invoice id these deliveries echo back is read from the
 * column `StartUserSubscription` wrote it to.
 */
describe("POST /webhooks/xendit", () => {
  /** The namespace as a LITERAL. The wire format is the thing under test. */
  const PREFIX = "usub_";

  let accounts = 0;

  async function account(a: ReturnType<typeof app>) {
    accounts += 1;
    const acc = {
      handle: `orang${accounts}`,
      email: `orang${accounts}-${Date.now()}@example.com`,
      password: "supersecret123",
      displayName: `Orang ${accounts}`,
    };
    await a.request("/users/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(acc),
    });
    const res = await a.request("/users/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: acc.email, password: acc.password }),
    });
    const body = (await res.json()) as { token: string; user: { id: string } };
    return { token: body.token, userId: body.user.id, handle: acc.handle };
  }

  function authed(token: string) {
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  }

  /**
   * A real purchase: owner with a payout account and a tier, buyer subscribing.
   * Returns the ids the webhook will reference — the invoice id read from the
   * COLUMN, since that column is what the handler verifies `body.id` against.
   */
  async function buyMembership(
    a: ReturnType<typeof app>,
    tier: { priceAmount?: number; billingCycle?: string } = {}
  ) {
    const owner = await account(a);
    await a.request("/users/me/payout", { method: "POST", headers: authed(owner.token) });
    const created = await (
      await a.request("/users/me/tiers", {
        method: "POST",
        headers: authed(owner.token),
        body: JSON.stringify({
          name: "Anggota",
          priceAmount: tier.priceAmount ?? 50_000,
          ...(tier.billingCycle === undefined ? {} : { billingCycle: tier.billingCycle }),
        }),
      })
    ).json();
    const buyer = await account(a);
    const bought = await (
      await a.request(`/users/${owner.handle}/subscribe`, {
        method: "POST",
        headers: authed(buyer.token),
        body: JSON.stringify({ tierId: created.id }),
      })
    ).json();

    const [tx] = await db
      .select()
      .from(userTransactions)
      .where(eq(userTransactions.id, bought.transactionId));

    return {
      owner,
      buyer,
      tierId: created.id as string,
      subscriptionId: bought.subscriptionId as string,
      transactionId: bought.transactionId as string,
      externalId: bought.externalId as string,
      invoiceId: tx.gatewayReferenceId!,
    };
  }

  async function userSubscriptionRowById(id: string) {
    const [row] = await db
      .select()
      .from(userSubscriptions)
      .where(eq(userSubscriptions.id, id));
    return row;
  }

  async function userTransactionRowById(id: string) {
    const [row] = await db.select().from(userTransactions).where(eq(userTransactions.id, id));
    return row;
  }

  // =========================================================================
  // THE ENDPOINT'S OWN PROPERTIES, not either world's.
  //
  // Every test in this section was written against the community fixture Task 5
  // deleted, and every one of them is about `POST /webhooks/xendit` itself: who
  // is allowed to reach it, what it does with a body it cannot parse, and what
  // it does with an `external_id` that is not ours. They are ported rather than
  // deleted, because the branch going away is not the thing they were guarding.
  // =========================================================================

  it("rejects a wrong token with 401 and does not activate", async () => {
    const a = app();
    const { subscriptionId, externalId, invoiceId } = await buyMembership(a);

    expect((await post(a, verifiedEvent(externalId, invoiceId), "wrong-token")).status).toBe(401);

    expect((await userSubscriptionRowById(subscriptionId)).status).toBe("pending");
  });

  it("rejects a missing token with 401", async () => {
    const a = app();
    const { subscriptionId, externalId, invoiceId } = await buyMembership(a);

    expect((await post(a, verifiedEvent(externalId, invoiceId), null)).status).toBe(401);

    expect((await userSubscriptionRowById(subscriptionId)).status).toBe("pending");
  });

  it("rejects an empty token header with 401", async () => {
    // `X-CALLBACK-TOKEN:` with no value used to compare equal to an unset
    // configured token. It must never vouch for anything.
    const a = app();
    const { subscriptionId, externalId, invoiceId } = await buyMembership(a);

    expect((await post(a, verifiedEvent(externalId, invoiceId), "")).status).toBe(401);

    expect((await userSubscriptionRowById(subscriptionId)).status).toBe("pending");
  });

  it("rejects a token that is a PREFIX of the real one with 401", async () => {
    const a = app();
    const { externalId, invoiceId } = await buyMembership(a);

    expect((await post(a, verifiedEvent(externalId, invoiceId), TOKEN.slice(0, -1))).status).toBe(
      401
    );
    expect((await post(a, verifiedEvent(externalId, invoiceId), `${TOKEN}x`)).status).toBe(401);
  });

  it("records nothing at all when the token is wrong", async () => {
    // A 401 that still burned the provider_event_id would let an attacker who
    // does NOT have the token block a genuine delivery.
    const a = app();
    const { externalId, invoiceId } = await buyMembership(a);

    await post(a, verifiedEvent(externalId, invoiceId), "wrong-token");

    expect(await db.select().from(webhookEvents)).toHaveLength(0);
  });

  it("400s a malformed body instead of 500ing", async () => {
    const a = app();
    await buyMembership(a);

    for (const body of [{}, { id: "evt-x" }, { id: "evt-x", status: "PAID" }, [], "PAID"]) {
      expect((await post(a, body)).status).toBe(400);
    }
  });

  it("400s a body that is not valid JSON", async () => {
    const a = app();
    const res = await a.request("/webhooks/xendit", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CALLBACK-TOKEN": TOKEN },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("checks the token BEFORE parsing the body — an unauthenticated garbage body is 401", async () => {
    const a = app();
    const res = await a.request("/webhooks/xendit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(401);
  });

  it("never echoes the payer's details back in a rejection", async () => {
    const a = app();
    const { externalId, invoiceId } = await buyMembership(a);

    const res = await post(
      a,
      verifiedEvent(externalId, invoiceId, { amount: 1, payer_email: "siti@example.com" })
    );
    const text = await res.text();

    expect(res.status).toBe(400);
    expect(text).not.toContain("siti@example.com");
  });

  it("stores the raw payload on the webhook_event row for audit", async () => {
    const a = app();
    const { externalId, invoiceId } = await buyMembership(a);

    await post(a, verifiedEvent(externalId, invoiceId, { some_extra_field: "kept verbatim" }));

    const [event] = await db.select().from(webhookEvents);
    expect(event.provider).toBe("xendit");
    expect(event.eventType).toBe("invoice.paid");
    expect(event.payload).toMatchObject({
      id: invoiceId,
      status: "PAID",
      some_extra_field: "kept verbatim",
    });
  });

  /**
   * `provider_event_id` must be per-DELIVERY. If it derived from the invoice id
   * alone, this second, legitimate lifecycle event would look like a replay and
   * be silently swallowed.
   */
  it("does not swallow an expired event that follows a paid one for the same invoice", async () => {
    const a = app();
    const { externalId, invoiceId } = await buyMembership(a);

    expect((await post(a, verifiedEvent(externalId, invoiceId))).status).toBe(200);
    expect(
      (await post(a, verifiedEvent(externalId, invoiceId, { status: "EXPIRED" }))).status
    ).toBe(200);

    const events = await db.select().from(webhookEvents);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.eventType).sort()).toEqual(["invoice.expired", "invoice.paid"]);
  });

  it("does not activate twice for two deliveries that differ only in status", async () => {
    // Both bodies are verifiable and their provider_event_ids DIFFER
    // (`<invoice>:PAID` vs `<invoice>:SETTLED`), so the UNIQUE constraint cannot
    // stop the second one from being recorded. The `status !== "PAID"` branch is
    // what keeps it from activating again, and the re-read of the transaction's
    // status inside the unit of work is the backstop for the day some future
    // status also activates.
    const a = app();
    const { subscriptionId, externalId, invoiceId } = await buyMembership(a);

    expect((await post(a, verifiedEvent(externalId, invoiceId))).status).toBe(200);
    const after = await userSubscriptionRowById(subscriptionId);
    // Xendit sends SETTLED after PAID for the same invoice.
    expect(
      (await post(a, verifiedEvent(externalId, invoiceId, { status: "SETTLED" }))).status
    ).toBe(200);

    const again = await userSubscriptionRowById(subscriptionId);
    expect(again.status).toBe("active");
    expect(again.currentPeriodEnd!.toISOString()).toBe(after.currentPeriodEnd!.toISOString());
    expect(await db.select().from(webhookEvents)).toHaveLength(2);
  });

  /**
   * The probe, as a test — measured before the invoice-id check existed.
   *
   * `provider_event_id` is `<body.id>:<status>`, so a sender who varies `body.id`
   * gets a fresh idempotency key every time and the UNIQUE constraint never
   * fires. On the deleted community path that produced 12 activations from 12
   * concurrent deliveries. Two independent defences stop it, and they are BOTH on
   * this path: `body.id` is verified against the reference checkout recorded, and
   * the transaction's own status is re-read inside the unit of work.
   */
  it("does not activate 12 times for 12 concurrent deliveries with DIFFERENT invoice ids", async () => {
    const a = app();
    const { subscriptionId, externalId } = await buyMembership(a);

    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        post(a, paidEvent(externalId, { id: `forged-inv-${i}` }))
      )
    );

    // Every one of them is rejected: not one carries the invoice id checkout
    // recorded.
    expect(responses.map((r) => r.status)).toEqual(Array.from({ length: 12 }, () => 400));
    expect((await userSubscriptionRowById(subscriptionId)).status).toBe("pending");
    expect(await db.select().from(webhookEvents)).toHaveLength(0);
  });

  it("activates ONCE when a genuine and eleven forged deliveries race", async () => {
    const a = app();
    const { subscriptionId, externalId, invoiceId } = await buyMembership(a);

    const responses = await Promise.all([
      post(a, verifiedEvent(externalId, invoiceId)),
      ...Array.from({ length: 11 }, (_, i) =>
        post(a, paidEvent(externalId, { id: `forged-inv-${i}` }))
      ),
    ]);

    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 400)).toHaveLength(11);
    expect((await userSubscriptionRowById(subscriptionId)).status).toBe("active");
    expect(await db.select().from(webhookEvents)).toHaveLength(1);
  });

  /**
   * A FAILED ACTIVATION MUST NOT CONSUME THE EVENT ID.
   *
   * The claim is written before the activation it authorises, so if it committed
   * on its own the id would be spent: every retry Xendit makes is answered
   * "already handled" while the member is never activated. Money taken, access
   * never granted, and no way back — the failure `PaymentActivationUnitOfWorkPort`
   * exists to prevent. Ported from the community fixture, where the same
   * atomicity was proved by breaking the tier's billing cycle.
   */
  describe("a failed activation must not consume the event id", () => {
    /**
     * Breaks the tier's `billing_cycle` so `computeUserSubscriptionPeriodEnd`
     * throws INSIDE the unit of work — after `recordIfNew`, which is the only
     * ordering that makes this test mean anything — and puts it back afterwards.
     * It stands in for any failure (deadlock, connection drop, bug) that hits
     * after the event was recorded.
     */
    async function withBrokenActivation<T>(tierId: string, fn: () => T | Promise<T>): Promise<T> {
      await db.update(userTiers).set({ billingCycle: "weekly" }).where(eq(userTiers.id, tierId));
      try {
        return await fn();
      } finally {
        await db
          .update(userTiers)
          .set({ billingCycle: "monthly" })
          .where(eq(userTiers.id, tierId));
      }
    }

    it("rolls the webhook_event row back when the activation fails", async () => {
      const a = app();
      const { subscriptionId, tierId, externalId, invoiceId } = await buyMembership(a);

      const res = await withBrokenActivation(tierId, () =>
        post(a, verifiedEvent(externalId, invoiceId))
      );

      expect(res.status).toBe(500);
      // If this row survived, the idempotency key is spent and every retry is a
      // no-op: money taken, access never granted.
      expect(await db.select().from(webhookEvents)).toHaveLength(0);
      expect((await userSubscriptionRowById(subscriptionId)).status).toBe("pending");
    });

    it("leaves the transaction row untouched too, not just the event row", async () => {
      const a = app();
      const { transactionId, tierId, externalId, invoiceId } = await buyMembership(a);

      await withBrokenActivation(tierId, () => post(a, verifiedEvent(externalId, invoiceId)));

      const tx = await userTransactionRowById(transactionId);
      expect(tx.status).toBe("pending");
      expect(tx.paidAt).toBeNull();
    });

    it("lets the RETRY of that same event succeed — the actual point", async () => {
      const a = app();
      const { subscriptionId, transactionId, tierId, externalId, invoiceId } =
        await buyMembership(a);

      await withBrokenActivation(tierId, () => post(a, verifiedEvent(externalId, invoiceId)));

      // Byte-identical body, so the same provider_event_id. Xendit's retry.
      const retry = await post(a, verifiedEvent(externalId, invoiceId));

      expect(retry.status).toBe(200);
      const sub = await userSubscriptionRowById(subscriptionId);
      expect(sub.status).toBe("active");
      expect(sub.currentPeriodEnd).not.toBeNull();
      expect((await userTransactionRowById(transactionId)).status).toBe("paid");
      expect(await db.select().from(webhookEvents)).toHaveLength(1);
    });
  });

  it("mints an external_id in the namespace the webhook routes on", async () => {
    const a = app();
    const bought = await buyMembership(a);

    expect(bought.externalId).toBe(`${PREFIX}${bought.transactionId}`);
  });

  it("activates the membership on a verified PAID event", async () => {
    const a = app();
    const { subscriptionId, transactionId, externalId, invoiceId } = await buyMembership(a);

    const res = await post(a, verifiedEvent(externalId, invoiceId));

    expect(res.status).toBe(200);
    const sub = await userSubscriptionRowById(subscriptionId);
    expect(sub.status).toBe("active");
    expect(sub.currentPeriodEnd).not.toBeNull();
    const tx = await userTransactionRowById(transactionId);
    expect(tx.status).toBe("paid");
    expect(tx.paidAt).not.toBeNull();
  });

  it("sets current_period_end one month past the payment for a monthly tier", async () => {
    const a = app();
    const { subscriptionId, transactionId, externalId, invoiceId } = await buyMembership(a);

    await post(a, verifiedEvent(externalId, invoiceId));

    const sub = await userSubscriptionRowById(subscriptionId);
    const tx = await userTransactionRowById(transactionId);
    const paidAt = tx.paidAt!;
    const expected = new Date(paidAt);
    expected.setUTCMonth(expected.getUTCMonth() + 1);
    expect(sub.currentPeriodEnd!.toISOString()).toBe(expected.toISOString());
  });

  /**
   * THE OUTBOX HAS NO WRITER LEFT, and this is what says so.
   *
   * Retire-telegram Task 5 deleted the community branch, which was the only code
   * that wrote a `grant_access` outbox row on activation; Phase 1 of
   * communities-core then dropped `activity_log` and `subscription` outright
   * (the retired community-centric model — see `db/schema.ts`), so there is
   * nothing left to assert them empty against. A membership grants access by
   * BEING active (spec §8): there is no group to invite anybody to, so an
   * activation that produced a queued row would be queuing work for a worker
   * with no handler for it.
   */
  it("writes NOTHING to the outbox", async () => {
    const a = app();
    const { externalId, invoiceId } = await buyMembership(a);

    expect((await post(a, verifiedEvent(externalId, invoiceId))).status).toBe(200);

    expect(await db.select().from(outbox)).toHaveLength(0);
  });

  it("is idempotent — a replayed delivery activates once and extends the period once", async () => {
    const a = app();
    const { subscriptionId, externalId, invoiceId } = await buyMembership(a);

    expect((await post(a, verifiedEvent(externalId, invoiceId))).status).toBe(200);
    const after = await userSubscriptionRowById(subscriptionId);

    expect((await post(a, verifiedEvent(externalId, invoiceId))).status).toBe(200);
    const again = await userSubscriptionRowById(subscriptionId);

    expect(again.currentPeriodEnd!.toISOString()).toBe(after.currentPeriodEnd!.toISOString());
    expect(await db.select().from(webhookEvents)).toHaveLength(1);
  });

  it("is idempotent under CONCURRENT deliveries of the same event", async () => {
    const a = app();
    const { subscriptionId, externalId, invoiceId } = await buyMembership(a);

    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(() => post(a, verifiedEvent(externalId, invoiceId)))
    );

    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(await db.select().from(webhookEvents)).toHaveLength(1);
    expect((await userSubscriptionRowById(subscriptionId)).status).toBe("active");
  });

  it("rejects an amount that does not match our own record, and activates nothing", async () => {
    const a = app();
    const { subscriptionId, transactionId, externalId, invoiceId } = await buyMembership(a);

    const res = await post(a, verifiedEvent(externalId, invoiceId, { amount: 1 }));

    expect(res.status).toBe(400);
    expect((await userSubscriptionRowById(subscriptionId)).status).toBe("pending");
    expect((await userTransactionRowById(transactionId)).status).toBe("pending");
    // Nothing recorded, so the event id a genuine delivery needs is still unspent.
    expect(await db.select().from(webhookEvents)).toHaveLength(0);
  });

  it("rejects an amount HIGHER than our record too", async () => {
    const a = app();
    const { subscriptionId, externalId, invoiceId } = await buyMembership(a);

    expect((await post(a, verifiedEvent(externalId, invoiceId, { amount: 500_000 }))).status).toBe(
      400
    );
    expect((await userSubscriptionRowById(subscriptionId)).status).toBe("pending");
  });

  it("400s a delivery whose invoice id is not the one checkout recorded", async () => {
    const a = app();
    const { subscriptionId, externalId } = await buyMembership(a);

    const res = await post(a, paidEvent(externalId, { id: "forged-inv-7" }));

    expect(res.status).toBe(400);
    expect((await userSubscriptionRowById(subscriptionId)).status).toBe("pending");
  });

  it("records a non-PAID status without activating", async () => {
    const a = app();
    const { subscriptionId, transactionId, externalId, invoiceId } = await buyMembership(a);

    const res = await post(a, verifiedEvent(externalId, invoiceId, { status: "EXPIRED" }));

    expect(res.status).toBe(200);
    expect((await userSubscriptionRowById(subscriptionId)).status).toBe("pending");
    expect((await userTransactionRowById(transactionId)).status).toBe("pending");
    expect(await db.select().from(webhookEvents)).toHaveLength(1);
  });

  it("404s a namespaced id with no user transaction behind it, without recording anything", async () => {
    const a = app();
    await buyMembership(a);

    const res = await post(
      a,
      paidEvent(`${PREFIX}00000000-0000-0000-0000-000000000000`, { id: "inv-x" })
    );

    expect(res.status).toBe(404);
    expect(await db.select().from(webhookEvents)).toHaveLength(0);
  });

  /**
   * THE 500 VECTOR Task 6's re-review measured: slicing the prefix off `usub_`
   * yields `""` and off `usub_x` yields `"x"`, and both used to reach the driver
   * as `invalid input syntax for type uuid`. This endpoint is PUBLIC.
   */
  it("never 500s on a junk id behind the namespace, however malformed", async () => {
    const a = app();
    await buyMembership(a);

    for (const junk of ["", "x", "1 OR 1=1", "'; drop table user_transaction; --", "00000000"]) {
      const res = await post(a, paidEvent(`${PREFIX}${junk}`, { id: "inv-x" }));
      expect(res.status).toBe(200);
    }
    expect(await db.select().from(webhookEvents)).toHaveLength(0);
  });

  /**
   * The ruling carried from Task 6: a second PAID for a pair that is already
   * active must not 500. `user_subscription_one_pending` stops two live invoices
   * being minted now, but it is not retroactive — so the rows are staged the way
   * a pre-fix double tap left them.
   */
  describe("a second PAID for a pair that is already active", () => {
    /**
     * Activates one membership, then plants a SECOND payable invoice for the same
     * pair — the state a pre-Task-6 double tap left behind, and the one
     * `user_subscription_one_pending` prevents being created today but cannot
     * retroactively remove. Inserted directly, because no route will now produce
     * it: `POST /subscribe` refuses a pair that already holds an active
     * membership, which is the point.
     */
    async function stageSecondInvoiceForActivePair(a: ReturnType<typeof app>) {
      const first = await buyMembership(a);
      expect((await post(a, verifiedEvent(first.externalId, first.invoiceId))).status).toBe(200);

      const [subscription] = await db
        .insert(userSubscriptions)
        .values({
          subscriberId: first.buyer.userId,
          tierId: first.tierId,
          ownerId: first.owner.userId,
          status: "pending",
        })
        .returning();
      const [transaction] = await db
        .insert(userTransactions)
        .values({
          userSubscriptionId: subscription!.id,
          amount: 50_000,
          gatewayReferenceId: "fake-inv-stale",
          gatewayInvoiceUrl: "https://fake-checkout.local/fake-inv-stale",
        })
        .returning();

      return {
        first,
        second: {
          subscriptionId: subscription!.id,
          transactionId: transaction!.id,
          externalId: `${PREFIX}${transaction!.id}`,
          invoiceId: "fake-inv-stale",
        },
      };
    }

    it("answers 200 rather than 500, so the provider does not retry a failure forever", async () => {
      const a = app();
      const { second } = await stageSecondInvoiceForActivePair(a);

      const res = await post(a, verifiedEvent(second.externalId, second.invoiceId));

      expect(res.status).toBe(200);
    });

    it("leaves exactly ONE active membership for the pair", async () => {
      const a = app();
      const { first, second } = await stageSecondInvoiceForActivePair(a);

      await post(a, verifiedEvent(second.externalId, second.invoiceId));

      expect((await userSubscriptionRowById(first.subscriptionId)).status).toBe("active");
      expect((await userSubscriptionRowById(second.subscriptionId)).status).toBe("cancelled");
    });

    it("records the second payment as collected, so the refund owed is visible", async () => {
      const a = app();
      const { second } = await stageSecondInvoiceForActivePair(a);

      await post(a, verifiedEvent(second.externalId, second.invoiceId));

      const tx = await userTransactionRowById(second.transactionId);
      expect(tx.status).toBe("paid");
      expect(tx.paidAt).not.toBeNull();
    });

    it("records both deliveries, so neither is retried", async () => {
      const a = app();
      const { second } = await stageSecondInvoiceForActivePair(a);

      await post(a, verifiedEvent(second.externalId, second.invoiceId));

      expect(await db.select().from(webhookEvents)).toHaveLength(2);
    });
  });

  /**
   * THE RULE, END TO END, ON THE PUBLIC ENDPOINT (retire-telegram Task 5).
   *
   * One kind of invoice is left, so every `external_id` that is not `usub_<uuid>`
   * is somebody else's or a probe. A BARE UUID is the case this task created: it
   * is well-formed, it is what a retired community invoice carried, and it must
   * now be IGNORED rather than resolved against `user_transaction` — resolving it
   * there is how a payment for something else activates a membership.
   *
   * 200 rather than 404, for the reason the junk cases already give: there is no
   * fix of ours that would ever make it resolvable, so the provider must stop
   * retrying it.
   */
  it("IGNORES a bare uuid — the retired community shape — instead of resolving it as a membership", async () => {
    const a = app();
    const { subscriptionId, transactionId } = await buyMembership(a);

    // The real transaction id, WITHOUT the namespace. The nearest miss there is.
    const res = await post(a, paidEvent(transactionId, { id: "inv-x" }));

    expect(res.status).toBe(200);
    expect((await userSubscriptionRowById(subscriptionId)).status).toBe("pending");
    expect((await userTransactionRowById(transactionId)).status).toBe("pending");
    // Nothing recorded either: an ignored delivery must not spend an event id.
    expect(await db.select().from(webhookEvents)).toHaveLength(0);
  });

  it("IGNORES every other shape too, without 500ing and without writing anything", async () => {
    const a = app();
    const { subscriptionId } = await buyMembership(a);

    for (const bad of [
      "haxx",
      "1 OR 1=1",
      "0000",
      "sub_1234",
      "usub_",
      "usub_x",
      "usub_1 OR 1=1",
      "00000000-0000-0000-0000-000000000000",
    ]) {
      expect((await post(a, paidEvent(bad, { id: "inv-x" }))).status).toBe(200);
    }

    expect(await db.select().from(webhookEvents)).toHaveLength(0);
    expect((await userSubscriptionRowById(subscriptionId)).status).toBe("pending");
  });
});
