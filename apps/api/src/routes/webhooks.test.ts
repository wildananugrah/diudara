import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { db } from "../db/client";
import { activityLogs, subscriptions, transactions, webhookEvents } from "../db/schema";
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
  const result = await (
    await a.request(`/c/${community.slug}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tierId: created.id,
        payerName: "Siti",
        payerWhatsappNumber: "+6281234567890",
      }),
    })
  ).json();

  return {
    communityId: community.id,
    subscriptionId: result.subscriptionId,
    externalId: result.transactionId,
  };
}

function post(a: ReturnType<typeof app>, body: unknown, token: string | null = TOKEN) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) headers["X-CALLBACK-TOKEN"] = token;
  return a.request("/webhooks/xendit", { method: "POST", headers, body: JSON.stringify(body) });
}

function paidEvent(externalId: string, overrides: Record<string, unknown> = {}) {
  return { id: "evt-1", external_id: externalId, status: "PAID", amount: 50000, ...overrides };
}

async function subscriptionRow(id: string) {
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, id));
  return row;
}

describe("POST /webhooks/xendit", () => {
  it("activates the subscription on a verified PAID event", async () => {
    const a = app();
    const { subscriptionId, externalId } = await checkout(a);

    expect((await post(a, paidEvent(externalId))).status).toBe(200);

    const sub = await subscriptionRow(subscriptionId);
    expect(sub.status).toBe("active");
    expect(sub.nextBillingDate).not.toBeNull();
    expect(sub.startedAt).not.toBeNull();
  });

  it("marks our own transaction success with the provider's invoice id", async () => {
    const a = app();
    const { externalId } = await checkout(a);

    await post(a, paidEvent(externalId, { id: "inv_xendit_9" }));

    const [tx] = await db.select().from(transactions).where(eq(transactions.id, externalId));
    expect(tx.status).toBe("success");
    expect(tx.paidAt).not.toBeNull();
    expect(tx.gatewayReferenceId).toBe("inv_xendit_9");
  });

  it("moves subscription.updated_at past created_at", async () => {
    // The updated_at carry-forward has no BEFORE UPDATE trigger behind it, so
    // this proves the column is not frozen at creation time.
    const a = app();
    const { subscriptionId, externalId } = await checkout(a);
    await Bun.sleep(25);

    await post(a, paidEvent(externalId));

    const sub = await subscriptionRow(subscriptionId);
    expect(sub.updatedAt.getTime()).toBeGreaterThan(sub.createdAt.getTime());
  });

  it("writes exactly one activity_log 'joined' entry for the member", async () => {
    const a = app();
    const { communityId, subscriptionId, externalId } = await checkout(a);

    await post(a, paidEvent(externalId));

    const logs = await db.select().from(activityLogs);
    expect(logs).toHaveLength(1);
    expect(logs[0].eventType).toBe("joined");
    expect(logs[0].communityId).toBe(communityId);
    expect(logs[0].memberId).toBe((await subscriptionRow(subscriptionId)).memberId);
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
      const { subscriptionId, externalId } = await checkout(a, { billingCycle });

      await post(a, paidEvent(externalId));

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
    const { subscriptionId, externalId } = await checkout(a);

    expect((await post(a, paidEvent(externalId), "wrong-token")).status).toBe(401);

    expect((await subscriptionRow(subscriptionId)).status).not.toBe("active");
  });

  it("rejects a missing token with 401", async () => {
    const a = app();
    const { subscriptionId, externalId } = await checkout(a);

    expect((await post(a, paidEvent(externalId), null)).status).toBe(401);

    expect((await subscriptionRow(subscriptionId)).status).not.toBe("active");
  });

  it("rejects an empty token header with 401", async () => {
    // `X-CALLBACK-TOKEN:` with no value used to compare equal to an unset
    // configured token. It must never vouch for anything.
    const a = app();
    const { subscriptionId, externalId } = await checkout(a);

    expect((await post(a, paidEvent(externalId), "")).status).toBe(401);

    expect((await subscriptionRow(subscriptionId)).status).not.toBe("active");
  });

  it("rejects a token that is a PREFIX of the real one with 401", async () => {
    const a = app();
    const { externalId } = await checkout(a);

    expect((await post(a, paidEvent(externalId), TOKEN.slice(0, -1))).status).toBe(401);
    expect((await post(a, paidEvent(externalId), `${TOKEN}x`)).status).toBe(401);
  });

  it("records nothing at all when the token is wrong", async () => {
    // A 401 that still burned the provider_event_id would let an attacker who
    // does NOT have the token block a genuine delivery.
    const a = app();
    const { externalId } = await checkout(a);

    await post(a, paidEvent(externalId), "wrong-token");

    expect(await db.select().from(webhookEvents)).toHaveLength(0);
    expect(await db.select().from(activityLogs)).toHaveLength(0);
  });

  it("is idempotent — a replayed event does not activate twice", async () => {
    const a = app();
    const { subscriptionId, externalId } = await checkout(a);

    const first = await post(a, paidEvent(externalId));
    const second = await post(a, paidEvent(externalId));

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
    const { subscriptionId, externalId } = await checkout(a);

    const responses = await Promise.all([
      post(a, paidEvent(externalId)),
      post(a, paidEvent(externalId)),
      post(a, paidEvent(externalId)),
    ]);

    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    expect((await subscriptionRow(subscriptionId)).status).toBe("active");
    expect(await db.select().from(activityLogs)).toHaveLength(1);
  });

  it("does not swallow an expired event that follows a paid one for the same invoice", async () => {
    // provider_event_id must be per-DELIVERY. If it derived from the invoice id
    // alone, this second, legitimate event would look like a replay.
    const a = app();
    const { externalId } = await checkout(a);

    expect((await post(a, paidEvent(externalId, { id: "inv_1" }))).status).toBe(200);
    expect((await post(a, paidEvent(externalId, { id: "inv_1", status: "EXPIRED" }))).status).toBe(
      200
    );

    const events = await db.select().from(webhookEvents);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.eventType).sort()).toEqual(["invoice.expired", "invoice.paid"]);
  });

  it("rejects an amount that does not match our own record", async () => {
    const a = app();
    const { subscriptionId, externalId } = await checkout(a);

    // The token authenticates the SENDER, not the message. A forged or tampered
    // body must not be able to activate a 50,000 subscription by claiming 1.
    const res = await post(a, paidEvent(externalId, { id: "evt-2", amount: 1 }));
    expect(res.status).toBe(400);

    expect((await subscriptionRow(subscriptionId)).status).not.toBe("active");
    expect(await db.select().from(activityLogs)).toHaveLength(0);
    expect(await db.select().from(webhookEvents)).toHaveLength(0);
  });

  it("rejects an amount HIGHER than our record too", async () => {
    const a = app();
    const { subscriptionId, externalId } = await checkout(a);

    expect((await post(a, paidEvent(externalId, { amount: 5_000_000 }))).status).toBe(400);
    expect((await subscriptionRow(subscriptionId)).status).not.toBe("active");
  });

  it("rejects an unknown external id with 404", async () => {
    const a = app();
    await checkout(a);
    const res = await post(a, paidEvent("00000000-0000-0000-0000-000000000000", { id: "evt-3" }));
    expect(res.status).toBe(404);
  });

  it("404s an external id that is not even a uuid, rather than 500ing", async () => {
    const a = app();
    await checkout(a);
    for (const bad of ["haxx", "1 OR 1=1", "0000"]) {
      expect((await post(a, paidEvent(bad))).status).toBe(404);
    }
  });

  it("ignores a non-PAID status without activating", async () => {
    const a = app();
    const { subscriptionId, externalId } = await checkout(a);

    expect((await post(a, paidEvent(externalId, { id: "evt-4", status: "EXPIRED" }))).status).toBe(
      200
    );

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
    const { externalId } = await checkout(a);

    const res = await post(
      a,
      paidEvent(externalId, { amount: 1, payer_email: "siti@example.com" })
    );
    const text = await res.text();

    expect(res.status).toBe(400);
    expect(text).not.toContain("siti@example.com");
  });

  it("stores the raw payload on the webhook_event row for audit", async () => {
    const a = app();
    const { externalId } = await checkout(a);

    await post(a, paidEvent(externalId, { id: "inv_audit" }));

    const [event] = await db.select().from(webhookEvents);
    expect(event.provider).toBe("xendit");
    expect(event.eventType).toBe("invoice.paid");
    expect(event.payload).toMatchObject({ id: "inv_audit", status: "PAID" });
  });
});
