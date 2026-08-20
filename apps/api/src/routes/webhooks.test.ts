import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { db } from "../db/client";
import {
  activityLogs,
  membershipTiers,
  outbox,
  subscriptions,
  transactions,
  userSubscriptions,
  userTransactions,
  webhookEvents,
} from "../db/schema";
import { resetDatabase } from "../db/test-helpers";
import { bearer, signupAndGetToken } from "./test-support";

beforeEach(resetDatabase);

const TOKEN = process.env.XENDIT_CALLBACK_TOKEN ?? "test-callback-token";

function app() {
  return createApp(bootstrap());
}

/** Runs a real checkout and returns the ids the webhook will reference. */
async function checkout(
  a: ReturnType<typeof app>,
  tier: { priceAmount?: number; billingCycle?: string } = {}
) {
  const { token } = await signupAndGetToken(a);
  await a.request("/payment-account", { method: "POST", headers: bearer(token) });

  const community = await (
    await a.request("/communities", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ name: "Kelas Budi" }),
    })
  ).json();
  const created = await (
    await a.request(`/communities/${community.id}/tiers`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({
        name: "Basic",
        priceAmount: tier.priceAmount ?? 50000,
        billingCycle: tier.billingCycle ?? "monthly",
      }),
    })
  ).json();
  return {
    communityId: community.id,
    slug: community.slug as string,
    tierId: created.id as string,
    ...(await buy(a, community.slug, created.id)),
  };
}

/**
 * One trip through `POST /c/:slug/checkout`, for the same payer every time — so
 * calling it twice against the same tier is exactly the double-submit that
 * produces two pending subscriptions for one (member, tier).
 */
async function buy(a: ReturnType<typeof app>, slug: string, tierId: string) {
  const result = await (
    await a.request(`/c/${slug}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tierId,
        payerName: "Siti",
        payerWhatsappNumber: "+6281234567890",
      }),
    })
  ).json();

  // StartCheckout records the provider's invoice id on the transaction, and the
  // handler now verifies `body.id` against it — so a test delivery has to echo
  // back the REAL one. Read from the column rather than from the fake adapter:
  // that column is what the handler compares against.
  const [tx] = await db
    .select()
    .from(transactions)
    .where(eq(transactions.id, result.transactionId));

  return {
    subscriptionId: result.subscriptionId as string,
    externalId: result.transactionId as string,
    invoiceId: tx.gatewayReferenceId!,
  };
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

async function subscriptionRow(id: string) {
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, id));
  return row;
}

describe("POST /webhooks/xendit", () => {
  it("activates the subscription on a verified PAID event", async () => {
    const a = app();
    const { subscriptionId, externalId, invoiceId } = await checkout(a);

    expect((await post(a, verifiedEvent(externalId, invoiceId))).status).toBe(200);

    const sub = await subscriptionRow(subscriptionId);
    expect(sub.status).toBe("active");
    expect(sub.nextBillingDate).not.toBeNull();
    expect(sub.startedAt).not.toBeNull();
  });

  it("marks our own transaction success with the provider's invoice id", async () => {
    const a = app();
    const { externalId, invoiceId } = await checkout(a);

    // The reference is written at CHECKOUT now, not by the webhook, and the
    // handler refuses any body whose id disagrees with it — so this asserts the
    // settled row still carries the invoice id the provider actually issued.
    expect(invoiceId).toBeTruthy();
    await post(a, verifiedEvent(externalId, invoiceId));

    const [tx] = await db.select().from(transactions).where(eq(transactions.id, externalId));
    expect(tx.status).toBe("success");
    expect(tx.paidAt).not.toBeNull();
    expect(tx.gatewayReferenceId).toBe(invoiceId);
  });

  it("moves subscription.updated_at past created_at", async () => {
    // The updated_at carry-forward has no BEFORE UPDATE trigger behind it, so
    // this proves the column is not frozen at creation time.
    const a = app();
    const { subscriptionId, externalId, invoiceId } = await checkout(a);
    await Bun.sleep(25);

    await post(a, verifiedEvent(externalId, invoiceId));

    const sub = await subscriptionRow(subscriptionId);
    expect(sub.updatedAt.getTime()).toBeGreaterThan(sub.createdAt.getTime());
  });

  it("writes exactly one activity_log 'joined' entry for the member", async () => {
    const a = app();
    const { communityId, subscriptionId, externalId, invoiceId } = await checkout(a);

    await post(a, verifiedEvent(externalId, invoiceId));

    const logs = await db.select().from(activityLogs);
    expect(logs).toHaveLength(1);
    expect(logs[0].eventType).toBe("joined");
    expect(logs[0].communityId).toBe(communityId);
    expect(logs[0].memberId).toBe((await subscriptionRow(subscriptionId)).memberId);
  });

  /**
   * The outbox row is the intent to invite, and it is written in the SAME
   * transaction as the activation — see PaymentActivationUnitOfWorkPort. Every
   * assertion in this block is a COUNT, not a final state: Phase 3's own
   * idempotency test asserted only that activation happened, which is true whether
   * or not replay protection works, and a reviewer caught that it would have
   * stayed green against a broken implementation.
   */
  describe("the grant_access outbox row", () => {
    it("leaves exactly one pending outbox row after an activation", async () => {
      const a = app();
      const { subscriptionId, externalId, invoiceId } = await checkout(a);

      await post(a, verifiedEvent(externalId, invoiceId));

      const rows = await db.select().from(outbox);
      expect(rows).toHaveLength(1);
      expect(rows[0].eventType).toBe("grant_access");
      expect(rows[0].status).toBe("pending");
      expect(rows[0].attempts).toBe(0);
      expect(rows[0].payload).toMatchObject({ subscriptionId });
    });

    it("carries ids only — no payer name or phone number", async () => {
      // The row is read by the worker outside any request context. `checkout()`
      // pays as "Siti" on +6281234567890.
      const a = app();
      const { externalId, invoiceId } = await checkout(a);

      await post(a, verifiedEvent(externalId, invoiceId));

      const [row] = await db.select().from(outbox);
      const serialised = JSON.stringify(row.payload);
      expect(serialised).not.toContain("Siti");
      expect(serialised).not.toContain("6281234567890");
    });

    it("writes ONE row for a REPLAYED webhook, not two", async () => {
      // The trap. Two rows means two invite links for one paying member, and the
      // subscription is `active` either way — so only the count detects it.
      const a = app();
      const { externalId, invoiceId } = await checkout(a);

      expect((await post(a, verifiedEvent(externalId, invoiceId))).status).toBe(200);
      expect((await post(a, verifiedEvent(externalId, invoiceId))).status).toBe(200);

      expect(await db.select().from(outbox)).toHaveLength(1);
    });

    it("writes ONE row under three CONCURRENT deliveries of the same event", async () => {
      const a = app();
      const { externalId, invoiceId } = await checkout(a);

      await Promise.all([
        post(a, verifiedEvent(externalId, invoiceId)),
        post(a, verifiedEvent(externalId, invoiceId)),
        post(a, verifiedEvent(externalId, invoiceId)),
      ]);

      expect(await db.select().from(outbox)).toHaveLength(1);
    });

    it("writes ONE row when PAID is followed by SETTLED for the same invoice", async () => {
      // Both bodies are verifiable and their provider_event_ids DIFFER, so the
      // UNIQUE constraint cannot stop the second from being recorded — markPaid's
      // `status = 'pending'` predicate is what stops the second grant.
      const a = app();
      const { externalId, invoiceId } = await checkout(a);

      await post(a, verifiedEvent(externalId, invoiceId));
      await post(a, verifiedEvent(externalId, invoiceId, { status: "SETTLED" }));

      expect(await db.select().from(webhookEvents)).toHaveLength(2);
      expect(await db.select().from(outbox)).toHaveLength(1);
    });

    it("writes NO row for a non-PAID delivery", async () => {
      const a = app();
      const { externalId, invoiceId } = await checkout(a);

      await post(a, verifiedEvent(externalId, invoiceId, { status: "EXPIRED" }));

      expect(await db.select().from(outbox)).toHaveLength(0);
    });

    it("writes NO row for a rejected delivery", async () => {
      const a = app();
      const { externalId } = await checkout(a);

      await post(a, paidEvent(externalId, { id: "inv_forged" }));

      expect(await db.select().from(outbox)).toHaveLength(0);
    });
  });

  it("computes next_billing_date from the tier's billing cycle", async () => {
    // Exact arithmetic (including end-of-month clamping) is pinned against a
    // fixed paidAt in domain/billing-cycle.test.ts and the repository test.
    // Here the paid-at is "now", so this asserts the shape and the ORDERING —
    // recomputing the expected date with the same calendar logic would only
    // restate the implementation, and doing it with `setUTCMonth` would make the
    // test fail on the 31st of a month.
    const dates: Record<string, string> = {};

    for (const billingCycle of ["monthly", "quarterly", "yearly"] as const) {
      await resetDatabase();
      const a = app();
      const { subscriptionId, externalId, invoiceId } = await checkout(a, { billingCycle });

      await post(a, verifiedEvent(externalId, invoiceId));

      const sub = await subscriptionRow(subscriptionId);
      expect(sub.nextBillingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      dates[billingCycle] = sub.nextBillingDate!;
    }

    const today = new Date().toISOString().slice(0, 10);
    expect(dates.monthly > today).toBe(true);
    expect(dates.quarterly > dates.monthly).toBe(true);
    expect(dates.yearly > dates.quarterly).toBe(true);
  });

  it("rejects a wrong token with 401 and does not activate", async () => {
    const a = app();
    const { subscriptionId, externalId, invoiceId } = await checkout(a);

    expect((await post(a, verifiedEvent(externalId, invoiceId), "wrong-token")).status).toBe(401);

    expect((await subscriptionRow(subscriptionId)).status).not.toBe("active");
  });

  it("rejects a missing token with 401", async () => {
    const a = app();
    const { subscriptionId, externalId, invoiceId } = await checkout(a);

    expect((await post(a, verifiedEvent(externalId, invoiceId), null)).status).toBe(401);

    expect((await subscriptionRow(subscriptionId)).status).not.toBe("active");
  });

  it("rejects an empty token header with 401", async () => {
    // `X-CALLBACK-TOKEN:` with no value used to compare equal to an unset
    // configured token. It must never vouch for anything.
    const a = app();
    const { subscriptionId, externalId, invoiceId } = await checkout(a);

    expect((await post(a, verifiedEvent(externalId, invoiceId), "")).status).toBe(401);

    expect((await subscriptionRow(subscriptionId)).status).not.toBe("active");
  });

  it("rejects a token that is a PREFIX of the real one with 401", async () => {
    const a = app();
    const { externalId, invoiceId } = await checkout(a);

    expect((await post(a, verifiedEvent(externalId, invoiceId), TOKEN.slice(0, -1))).status).toBe(401);
    expect((await post(a, verifiedEvent(externalId, invoiceId), `${TOKEN}x`)).status).toBe(401);
  });

  it("records nothing at all when the token is wrong", async () => {
    // A 401 that still burned the provider_event_id would let an attacker who
    // does NOT have the token block a genuine delivery.
    const a = app();
    const { externalId, invoiceId } = await checkout(a);

    await post(a, verifiedEvent(externalId, invoiceId), "wrong-token");

    expect(await db.select().from(webhookEvents)).toHaveLength(0);
    expect(await db.select().from(activityLogs)).toHaveLength(0);
  });

  it("is idempotent — a replayed event does not activate twice", async () => {
    const a = app();
    const { subscriptionId, externalId, invoiceId } = await checkout(a);

    const first = await post(a, verifiedEvent(externalId, invoiceId));
    const second = await post(a, verifiedEvent(externalId, invoiceId));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200); // no-op, not an error

    const sub = await subscriptionRow(subscriptionId);
    expect(sub.status).toBe("active");
    // The assertions that actually detect a double activation: status is
    // "active" either way.
    expect(await db.select().from(activityLogs)).toHaveLength(1);
    expect(await db.select().from(webhookEvents)).toHaveLength(1);
  });

  it("is idempotent under CONCURRENT deliveries of the same event", async () => {
    // Xendit retries do not wait for the first delivery to finish. A
    // check-then-insert replay guard passes for both and one of them 500s.
    const a = app();
    const { subscriptionId, externalId, invoiceId } = await checkout(a);

    const responses = await Promise.all([
      post(a, verifiedEvent(externalId, invoiceId)),
      post(a, verifiedEvent(externalId, invoiceId)),
      post(a, verifiedEvent(externalId, invoiceId)),
    ]);

    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    expect((await subscriptionRow(subscriptionId)).status).toBe("active");
    expect(await db.select().from(activityLogs)).toHaveLength(1);
  });

  /**
   * I2, final whole-branch review — the probe, as a test.
   *
   * `provider_event_id` is `<body.id>:<status>`, so a sender who varies `body.id`
   * gets a fresh idempotency key every time and the UNIQUE constraint never
   * fires. Measured before the fix: 12 concurrent PAID deliveries with 12
   * DISTINCT `body.id` values → all HTTP 200, 12 `webhook_event` rows and **12
   * `activity_log` "joined" rows**. In Phase 4 each of those is a WhatsApp
   * invite.
   *
   * Two independent defences now stop it: `body.id` is verified against the
   * gateway reference StartCheckout recorded, and `markPaid` only settles a
   * transaction that is still `pending`.
   */
  it("does not activate 12 times for 12 concurrent deliveries with DIFFERENT invoice ids", async () => {
    const a = app();
    const { subscriptionId, externalId } = await checkout(a);

    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        post(a, paidEvent(externalId, { id: `forged-inv-${i}` }))
      )
    );

    // Every one of them is now rejected: not one carries the invoice id we
    // recorded at checkout.
    expect(responses.map((r) => r.status)).toEqual(Array.from({ length: 12 }, () => 400));
    expect((await subscriptionRow(subscriptionId)).status).toBe("pending");
    expect(await db.select().from(activityLogs)).toHaveLength(0);
    expect(await db.select().from(webhookEvents)).toHaveLength(0);
  });

  it("writes ONE joined row even when a genuine and a forged delivery race", async () => {
    // The realistic version: one delivery carries the real invoice id, eleven
    // carry forged ones, and they all arrive at once.
    const a = app();
    const { subscriptionId, externalId, invoiceId } = await checkout(a);

    const responses = await Promise.all([
      post(a, verifiedEvent(externalId, invoiceId)),
      ...Array.from({ length: 11 }, (_, i) =>
        post(a, paidEvent(externalId, { id: `forged-inv-${i}` }))
      ),
    ]);

    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 400)).toHaveLength(11);
    expect((await subscriptionRow(subscriptionId)).status).toBe("active");
    expect(await db.select().from(activityLogs)).toHaveLength(1);
  });

  it("does not activate twice for two deliveries that differ only in status", async () => {
    // Both bodies are verifiable and their provider_event_ids DIFFER
    // (`<invoice>:PAID` vs `<invoice>:SETTLED`), so the UNIQUE constraint cannot
    // stop the second one from being recorded. Today the `status !== "PAID"`
    // branch is what keeps it from activating again; `markPaid`'s
    // `status = 'pending'` predicate is the backstop for the day some future
    // status also activates, and it is pinned directly in
    // drizzle-subscription.repository.test.ts because — with the invoice-id check
    // in place — no HTTP path can reach markPaid twice any more.
    const a = app();
    const { subscriptionId, externalId, invoiceId } = await checkout(a);

    expect((await post(a, verifiedEvent(externalId, invoiceId))).status).toBe(200);
    // Xendit sends SETTLED after PAID for the same invoice. Under a stricter
    // future rule this might activate; today it must not activate AGAIN.
    expect(
      (await post(a, verifiedEvent(externalId, invoiceId, { status: "SETTLED" }))).status
    ).toBe(200);

    expect((await subscriptionRow(subscriptionId)).status).toBe("active");
    expect(await db.select().from(webhookEvents)).toHaveLength(2);
    expect(await db.select().from(activityLogs)).toHaveLength(1);
  });

  /**
   * Task 7 item 2. `markPaid`'s zero-row path treated EVERY non-`pending` status
   * as "already settled", including `failed` — so a genuine payment arriving for a
   * failed transaction returned HTTP 200 and was swallowed as a duplicate. Xendit
   * does not retry a 200, and the delivery is not replayable afterwards either
   * (the event id is spent), so the money was taken and the access silently never
   * granted, with a `[payments] already-settled` line as the only trace.
   *
   * `failed` and `success` are genuinely different: one is an idempotent no-op,
   * the other is an operator's problem that must not be reported as normal.
   */
  describe("a payment for a transaction that is not pending", () => {
    /** What a later phase's retry/expiry handling will leave behind. */
    async function markTransactionFailed(externalId: string) {
      await db
        .update(transactions)
        .set({ status: "failed" })
        .where(eq(transactions.id, externalId));
    }

    it("does NOT swallow a genuine PAID for a FAILED transaction as a duplicate", async () => {
      const a = app();
      const { subscriptionId, externalId, invoiceId } = await checkout(a);
      await markTransactionFailed(externalId);

      const res = await post(a, verifiedEvent(externalId, invoiceId));

      // Not 200. A 2xx here is Xendit's signal to stop, and it will not retry.
      expect(res.status).toBe(409);
      expect((await subscriptionRow(subscriptionId)).status).toBe("pending");
      // And nothing was recorded, so the SAME delivery can be replayed by hand
      // once an operator has repaired the row — a burnt event id would make even
      // that impossible.
      expect(await db.select().from(webhookEvents)).toHaveLength(0);
      expect(await db.select().from(outbox)).toHaveLength(0);
      expect(await db.select().from(activityLogs)).toHaveLength(0);
    });

    it("says which transaction and which status, with no payer details", async () => {
      const a = app();
      const { externalId, invoiceId } = await checkout(a);
      await markTransactionFailed(externalId);

      const warnings: string[] = [];
      const original = console.warn;
      console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
      try {
        await post(a, verifiedEvent(externalId, invoiceId, { payer_email: "siti@example.com" }));
      } finally {
        console.warn = original;
      }

      const text = warnings.join("\n");
      expect(text).toContain(externalId);
      expect(text).toContain("failed");
      // `checkout()` pays as "Siti" on +6281234567890. Ids and enum values only.
      expect(text).not.toContain("siti@example.com");
      expect(text).not.toContain("Siti");
      expect(text).not.toContain("6281234567890");
    });

    it("still treats an already-SUCCESS transaction as an idempotent 200 no-op", async () => {
      // The other half. This one really IS a duplicate, and it must stay a 200 —
      // otherwise Xendit retries a delivery there is nothing to do about.
      const a = app();
      const { subscriptionId, externalId, invoiceId } = await checkout(a);
      await post(a, verifiedEvent(externalId, invoiceId));

      const replay = await post(a, verifiedEvent(externalId, invoiceId, { status: "SETTLED" }));

      expect(replay.status).toBe(200);
      expect((await subscriptionRow(subscriptionId)).status).toBe("active");
      expect(await db.select().from(outbox)).toHaveLength(1);
      expect(await db.select().from(activityLogs)).toHaveLength(1);
    });
  });

  /**
   * Task 7 item 3. A double-submit at checkout creates TWO pending subscriptions
   * for one (member, tier) — nothing prevented it and nothing decided which was
   * authoritative. Phase 4 is the first phase to act on one: each activation
   * enqueues a `grant_access` row, so the member is invited twice and holds two
   * single-use bearer credentials for the same group, one of which they can hand
   * to somebody who never paid.
   *
   * The rule: the FIRST one to activate is authoritative, and a later activation
   * for the same (member, tier) is superseded — recorded, `cancelled`, and NOT
   * granted. The transaction still settles as `success`, because the money really
   * did arrive and pretending otherwise would hide a refund that is owed.
   */
  describe("a second pending subscription for the same member and tier", () => {
    it("does not activate twice or queue a second invite", async () => {
      const a = app();
      const first = await checkout(a);
      // The double-submit: same payer, same tier, a second pending subscription.
      const second = await buy(a, first.slug, first.tierId);
      expect(second.subscriptionId).not.toBe(first.subscriptionId);

      expect((await post(a, verifiedEvent(first.externalId, first.invoiceId))).status).toBe(200);
      const res = await post(a, verifiedEvent(second.externalId, second.invoiceId));

      // A 2xx: there is nothing for the provider to retry, and this is a state we
      // have handled, not an error.
      expect(res.status).toBe(200);
      // THE assertion, first: two rows here means two invite links for one paying
      // member, and both subscriptions read `active` either way.
      expect(await db.select().from(outbox)).toHaveLength(1);
      expect((await subscriptionRow(first.subscriptionId)).status).toBe("active");
      expect((await subscriptionRow(second.subscriptionId)).status).toBe("cancelled");
    });

    it("records the money as collected, so the refund owed is visible", async () => {
      const a = app();
      const first = await checkout(a);
      const second = await buy(a, first.slug, first.tierId);

      await post(a, verifiedEvent(first.externalId, first.invoiceId));
      await post(a, verifiedEvent(second.externalId, second.invoiceId));

      const [tx] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, second.externalId));
      expect(tx.status).toBe("success");
      expect(tx.paidAt).not.toBeNull();
    });

    it("audits WHY the second one was not granted", async () => {
      const a = app();
      const first = await checkout(a);
      const second = await buy(a, first.slug, first.tierId);

      await post(a, verifiedEvent(first.externalId, first.invoiceId));
      await post(a, verifiedEvent(second.externalId, second.invoiceId));

      const logs = await db.select().from(activityLogs);
      // One "joined" for the authoritative activation, one explaining the other.
      expect(logs.map((l) => l.eventType).sort()).toEqual(["access_not_granted", "joined"]);
      const notGranted = logs.find((l) => l.eventType === "access_not_granted")!;
      expect(JSON.stringify(notGranted.metadata)).toContain("duplicate_active_subscription");
      expect(JSON.stringify(notGranted.metadata)).toContain(second.subscriptionId);
    });

    it("still activates a RENEWAL of the same subscription", async () => {
      // The rule must not break the ordinary case it resembles: a renewal is a new
      // transaction against the SAME subscription, which is already active.
      const a = app();
      const first = await checkout(a);
      await post(a, verifiedEvent(first.externalId, first.invoiceId));

      const [renewal] = await db
        .insert(transactions)
        .values({
          subscriptionId: first.subscriptionId,
          amount: 50000,
          paymentMethod: "invoice",
          gatewayReferenceId: "inv_renewal_1",
        })
        .returning();

      const res = await post(a, verifiedEvent(renewal.id, "inv_renewal_1"));

      expect(res.status).toBe(200);
      expect((await subscriptionRow(first.subscriptionId)).status).toBe("active");
      expect(await db.select().from(outbox)).toHaveLength(2);
    });
  });

  it("400s a delivery whose invoice id is not the one checkout recorded", async () => {
    const a = app();
    const { subscriptionId, externalId } = await checkout(a);

    const res = await post(a, paidEvent(externalId, { id: "inv_forged" }));

    expect(res.status).toBe(400);
    expect((await subscriptionRow(subscriptionId)).status).toBe("pending");
    // Nothing written — so a forger cannot consume the event id a genuine
    // delivery needs.
    expect(await db.select().from(webhookEvents)).toHaveLength(0);
    expect(await db.select().from(activityLogs)).toHaveLength(0);
  });

  // MINOR, final whole-branch review: payment_method was hardcoded "invoice" and
  // the callback's own value was discarded.
  it("persists the payment_method the callback reports", async () => {
    const a = app();
    const { externalId, invoiceId } = await checkout(a);

    const [before] = await db.select().from(transactions).where(eq(transactions.id, externalId));
    expect(before.paymentMethod).toBe("invoice");

    await post(a, verifiedEvent(externalId, invoiceId, { payment_method: "BANK_TRANSFER" }));

    const [after] = await db.select().from(transactions).where(eq(transactions.id, externalId));
    expect(after.paymentMethod).toBe("BANK_TRANSFER");
  });

  it("leaves payment_method alone when the callback does not report one", async () => {
    // NOT NULL column: writing `undefined` through would be a NULL violation.
    const a = app();
    const { externalId, invoiceId } = await checkout(a);

    await post(a, verifiedEvent(externalId, invoiceId));

    const [tx] = await db.select().from(transactions).where(eq(transactions.id, externalId));
    expect(tx.paymentMethod).toBe("invoice");
    expect(tx.status).toBe("success");
  });

  it("still activates when the callback's payment_method is unusable", async () => {
    // A 400 here would mean a member who really paid never gets access, over a
    // display string. It degrades instead.
    const a = app();
    const { subscriptionId, externalId, invoiceId } = await checkout(a);

    const res = await post(
      a,
      verifiedEvent(externalId, invoiceId, { payment_method: "A_METHOD_NAME_FAR_TOO_LONG_FOR_THE_COLUMN" })
    );

    expect(res.status).toBe(200);
    expect((await subscriptionRow(subscriptionId)).status).toBe("active");
    const [tx] = await db.select().from(transactions).where(eq(transactions.id, externalId));
    expect(tx.paymentMethod).toBe("invoice");
  });

  it("records the provider's invoice id on the transaction at CHECKOUT, before any webhook", async () => {
    // The anchor everything above depends on. Before this, gateway_reference_id
    // was null until a webhook arrived and then held whatever the body claimed.
    const a = app();
    const { externalId, invoiceId } = await checkout(a);

    const [tx] = await db.select().from(transactions).where(eq(transactions.id, externalId));
    expect(tx.gatewayReferenceId).toBe(invoiceId);
    expect(tx.gatewayReferenceId).toBeTruthy();
    expect(tx.status).toBe("pending");
  });

  describe("a failed activation must not consume the event id", () => {
    /**
     * Breaks the tier's `billing_cycle` so `computeNextBillingDate` throws inside
     * `markPaid` — a real failure path, already pinned at the repository level —
     * and puts it back afterwards. This stands in for any transient failure
     * (deadlock, connection drop, bug) that hits AFTER the event was recorded.
     */
    async function withBrokenActivation<T>(
      subscriptionId: string,
      fn: () => T | Promise<T>
    ): Promise<T> {
      const [sub] = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.id, subscriptionId));
      await db
        .update(membershipTiers)
        .set({ billingCycle: "weekly" })
        .where(eq(membershipTiers.id, sub.tierId));
      try {
        return await fn();
      } finally {
        await db
          .update(membershipTiers)
          .set({ billingCycle: "monthly" })
          .where(eq(membershipTiers.id, sub.tierId));
      }
    }

    it("rolls the webhook_event row back when the activation fails", async () => {
      const a = app();
      const { subscriptionId, externalId, invoiceId } = await checkout(a);

      const res = await withBrokenActivation(subscriptionId, () =>
        post(a, verifiedEvent(externalId, invoiceId))
      );

      expect(res.status).toBe(500);
      // If this row survived, the idempotency key is spent and every retry
      // Xendit makes is a no-op: money taken, access never granted.
      expect(await db.select().from(webhookEvents)).toHaveLength(0);
      expect((await subscriptionRow(subscriptionId)).status).toBe("pending");
    });

    /**
     * The other direction of the atomicity requirement. A `grant_access` row that
     * survived a rolled-back activation is an invite for a subscription that is
     * still `pending`: the worker would issue a link to someone whose payment we
     * did not record, and — because the retry then activates and enqueues again —
     * a second link after that.
     *
     * This is the assertion that goes red if the enqueue is moved OUTSIDE the
     * unit of work.
     */
    it("rolls the outbox row back too, so no invite is queued for a failed activation", async () => {
      const a = app();
      const { subscriptionId, externalId, invoiceId } = await checkout(a);

      const res = await withBrokenActivation(subscriptionId, () =>
        post(a, verifiedEvent(externalId, invoiceId))
      );

      expect(res.status).toBe(500);
      expect(await db.select().from(outbox)).toHaveLength(0);
    });

    it("queues exactly one invite once the RETRY of that event succeeds", async () => {
      const a = app();
      const { subscriptionId, externalId, invoiceId } = await checkout(a);

      await withBrokenActivation(subscriptionId, () =>
        post(a, verifiedEvent(externalId, invoiceId))
      );
      expect(await db.select().from(outbox)).toHaveLength(0);

      const retry = await post(a, verifiedEvent(externalId, invoiceId));

      expect(retry.status).toBe(200);
      const rows = await db.select().from(outbox);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("pending");
      expect(rows[0].payload).toMatchObject({ subscriptionId });
    });

    it("lets the RETRY of that same event succeed — the actual point", async () => {
      const a = app();
      const { subscriptionId, externalId, invoiceId } = await checkout(a);

      await withBrokenActivation(subscriptionId, () => post(a, verifiedEvent(externalId, invoiceId)));

      // Byte-identical body, so the same provider_event_id. Xendit's retry.
      const retry = await post(a, verifiedEvent(externalId, invoiceId));

      expect(retry.status).toBe(200);
      const sub = await subscriptionRow(subscriptionId);
      expect(sub.status).toBe("active");
      expect(sub.nextBillingDate).not.toBeNull();
      expect(await db.select().from(activityLogs)).toHaveLength(1);
      expect(await db.select().from(webhookEvents)).toHaveLength(1);

      const [tx] = await db.select().from(transactions).where(eq(transactions.id, externalId));
      expect(tx.status).toBe("success");
    });

    it("leaves the transaction row untouched too, not just the event row", async () => {
      const a = app();
      const { subscriptionId, externalId, invoiceId } = await checkout(a);

      await withBrokenActivation(subscriptionId, () => post(a, verifiedEvent(externalId, invoiceId)));

      const [tx] = await db.select().from(transactions).where(eq(transactions.id, externalId));
      expect(tx.status).toBe("pending");
      expect(tx.paidAt).toBeNull();
      expect(await db.select().from(activityLogs)).toHaveLength(0);
    });
  });

  it("does not swallow an expired event that follows a paid one for the same invoice", async () => {
    // provider_event_id must be per-DELIVERY. If it derived from the invoice id
    // alone, this second, legitimate event would look like a replay.
    const a = app();
    const { externalId, invoiceId } = await checkout(a);

    expect((await post(a, verifiedEvent(externalId, invoiceId))).status).toBe(200);
    expect(
      (await post(a, verifiedEvent(externalId, invoiceId, { status: "EXPIRED" }))).status
    ).toBe(200);

    const events = await db.select().from(webhookEvents);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.eventType).sort()).toEqual(["invoice.expired", "invoice.paid"]);
  });

  it("rejects an amount that does not match our own record", async () => {
    const a = app();
    const { subscriptionId, externalId, invoiceId } = await checkout(a);

    // The token authenticates the SENDER, not the message. A forged or tampered
    // body must not be able to activate a 50,000 subscription by claiming 1.
    // The invoice id is the REAL one, so the amount is the only thing wrong —
    // otherwise this would be passing for the id check's reason, not its own.
    const res = await post(a, verifiedEvent(externalId, invoiceId, { amount: 1 }));
    expect(res.status).toBe(400);

    expect((await subscriptionRow(subscriptionId)).status).not.toBe("active");
    expect(await db.select().from(activityLogs)).toHaveLength(0);
    expect(await db.select().from(webhookEvents)).toHaveLength(0);
  });

  it("rejects an amount HIGHER than our record too", async () => {
    const a = app();
    const { subscriptionId, externalId, invoiceId } = await checkout(a);

    expect((await post(a, verifiedEvent(externalId, invoiceId, { amount: 5_000_000 }))).status).toBe(400);
    expect((await subscriptionRow(subscriptionId)).status).not.toBe("active");
  });

  it("rejects an unknown external id with 404", async () => {
    const a = app();
    await checkout(a);
    const res = await post(a, paidEvent("00000000-0000-0000-0000-000000000000", { id: "evt-3" }));
    expect(res.status).toBe(404);
  });

  /**
   * CHANGED BY TASK 7, deliberately, and it changes nothing about a real invoice.
   *
   * Every `external_id` this codebase has ever put on the wire is either a bare
   * `transaction.id` uuid (community) or `usub_<uuid>` (a user subscription), so
   * a string that is NEITHER shape cannot be an invoice of ours at all — it is
   * somebody else's, or a probe. It used to be handed to the community lookup and
   * answered 404; it is now IGNORED with a 200 (spec §7: "an unrecognised prefix
   * is ignored, never assumed to be either kind"), which also stops the provider
   * retrying a delivery no fix of ours could ever make resolvable.
   *
   * What this test has always been for survives unchanged: none of these 500s.
   * And an unknown BARE UUID — the shape a real community invoice has — still
   * 404s, pinned by the test above.
   */
  it("IGNORES an external id that is neither shape, without 500ing and without writing anything", async () => {
    const a = app();
    const { subscriptionId } = await checkout(a);
    for (const bad of ["haxx", "1 OR 1=1", "0000", "usub_", "usub_x", "usub_1 OR 1=1"]) {
      expect((await post(a, paidEvent(bad))).status).toBe(200);
    }

    expect(await db.select().from(webhookEvents)).toHaveLength(0);
    expect(await db.select().from(outbox)).toHaveLength(0);
    expect(await db.select().from(activityLogs)).toHaveLength(0);
    expect((await subscriptionRow(subscriptionId)).status).not.toBe("active");
  });

  it("ignores a non-PAID status without activating", async () => {
    const a = app();
    const { subscriptionId, externalId, invoiceId } = await checkout(a);

    expect(
      (await post(a, verifiedEvent(externalId, invoiceId, { status: "EXPIRED" }))).status
    ).toBe(200);

    const sub = await subscriptionRow(subscriptionId);
    expect(sub.status).not.toBe("active");
    expect(sub.startedAt).toBeNull();
    expect(sub.nextBillingDate).toBeNull();
    expect(await db.select().from(activityLogs)).toHaveLength(0);

    const [tx] = await db.select().from(transactions).where(eq(transactions.id, externalId));
    expect(tx.status).toBe("pending");
    expect(tx.paidAt).toBeNull();
  });

  it("400s a malformed body instead of 500ing", async () => {
    const a = app();
    await checkout(a);

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
    const { externalId, invoiceId } = await checkout(a);

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
    const { externalId, invoiceId } = await checkout(a);

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
});

/**
 * Task 7 of Phase 5a — the OTHER kind of invoice arriving down the SAME stream,
 * at the same public endpoint, against the real database and its real
 * constraints.
 *
 * Nothing here contacts Xendit: `bootstrap()` wires `FakePaymentAdapter` under
 * NODE_ENV=test, and the invoice id these deliveries echo back is read from the
 * column `StartUserSubscription` wrote it to.
 */
describe("POST /webhooks/xendit — user subscriptions", () => {
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

  it("writes NO community rows for a user-subscription payment", async () => {
    const a = app();
    const { externalId, invoiceId } = await buyMembership(a);

    await post(a, verifiedEvent(externalId, invoiceId));

    // A user membership grants access by BEING active (spec §8). There is no
    // Telegram group to invite anybody to, and no `member` row to audit against.
    expect(await db.select().from(activityLogs)).toHaveLength(0);
    expect(await db.select().from(outbox)).toHaveLength(0);
    expect(await db.select().from(subscriptions)).toHaveLength(0);
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

  it("still activates a COMMUNITY invoice arriving between two user ones", async () => {
    // The regression that matters, end to end: one stream, three deliveries, and
    // the community path must be reached by exactly the route it always was.
    const a = app();
    const community = await checkout(a);
    const membership = await buyMembership(a);

    expect((await post(a, verifiedEvent(membership.externalId, membership.invoiceId))).status).toBe(
      200
    );
    expect((await post(a, verifiedEvent(community.externalId, community.invoiceId))).status).toBe(
      200
    );

    expect((await subscriptionRow(community.subscriptionId)).status).toBe("active");
    expect((await userSubscriptionRowById(membership.subscriptionId)).status).toBe("active");
    // The community activation still wrote its own audit entry and its own invite.
    expect(await db.select().from(activityLogs)).toHaveLength(1);
    expect(await db.select().from(outbox)).toHaveLength(1);
  });
});
