import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { db } from "../db/client";
import { subscriptions } from "../db/schema";
import { resetDatabase } from "../db/test-helpers";
import { FakePaymentAdapter } from "../infrastructure/payments/fake-payment.adapter";
import { bearer, signupAndGetToken } from "./test-support";

beforeEach(resetDatabase);

function app() {
  return createApp(bootstrap());
}

async function seedPayableCommunity(a: ReturnType<typeof app>, onboard = true) {
  const { token } = await signupAndGetToken(a);
  if (onboard) {
    // Go through the real onboarding route rather than writing the column
    // directly, so these tests exercise the path an actual creator takes.
    const res = await a.request("/payment-account", { method: "POST", headers: bearer(token) });
    if (res.status !== 201) {
      throw new Error(`payment onboarding failed in setup: ${res.status}`);
    }
  }
  const community = await (
    await a.request("/communities", {
      method: "POST", headers: bearer(token), body: JSON.stringify({ name: "Kelas Budi" }),
    })
  ).json();
  const tier = await (
    await a.request(`/communities/${community.id}/tiers`, {
      method: "POST", headers: bearer(token),
      body: JSON.stringify({ name: "Basic", priceAmount: 50000, billingCycle: "monthly" }),
    })
  ).json();
  return { token, community, tier };
}

const PAYER = { payerName: "Siti", payerWhatsappNumber: "+6281234567890" };

describe("POST /c/:slug/checkout", () => {
  it("returns an invoice url and a pending subscription", async () => {
    const a = app();
    const { community, tier } = await seedPayableCommunity(a);

    const res = await a.request(`/c/${community.slug}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tierId: tier.id, ...PAYER }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.invoiceUrl).toContain("http");
    expect(body.subscriptionId).toBeTruthy();
    expect(body.transactionId).toBeTruthy();
  });

  /**
   * I1, final whole-branch review — wired end to end through the composition
   * root. Task 9 built `/c/:slug/status/:subscriptionId` and nothing could reach
   * it: no route linked to it and no `success_redirect_url` was sent, so a member
   * who paid was left on the provider's receipt. The invoice the provider is
   * asked to create must carry a URL containing the subscription id.
   */
  it("asks the provider to send the payer back to OUR confirmation page", async () => {
    const deps = bootstrap();
    const a = createApp(deps);
    const { community, tier } = await seedPayableCommunity(a);

    const res = await a.request(`/c/${community.slug}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tierId: tier.id, ...PAYER }),
    });
    const { subscriptionId } = await res.json();

    const payments = deps.payments as FakePaymentAdapter;
    expect(payments.invoices).toHaveLength(1);
    const redirect = payments.invoices[0].successRedirectUrl;
    expect(redirect).toContain(subscriptionId);
    expect(redirect).toBe(`${deps.appBaseUrl}/c/${community.slug}/status/${subscriptionId}`);
    // And it is a URL a browser can actually be sent to.
    expect(redirect.startsWith("http://") || redirect.startsWith("https://")).toBe(true);
  });

  it("rejects a creator who has not completed payment onboarding with 409", async () => {
    const a = app();
    const { community, tier } = await seedPayableCommunity(a, false);

    const res = await a.request(`/c/${community.slug}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tierId: tier.id, ...PAYER }),
    });

    // Must never silently fall back to charging a platform account.
    expect(res.status).toBe(409);
  });

  it("rejects a tier belonging to a different community with 404", async () => {
    const a = app();
    const first = await seedPayableCommunity(a);
    const second = await seedPayableCommunity(a);

    const res = await a.request(`/c/${first.community.slug}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tierId: second.tier.id, ...PAYER }),
    });

    expect(res.status).toBe(404);
  });

  it("rejects an inactive tier with 404", async () => {
    const a = app();
    const { token, community, tier } = await seedPayableCommunity(a);
    await a.request(`/communities/${community.id}/tiers/${tier.id}`, {
      method: "PATCH",
      headers: bearer(token),
      body: JSON.stringify({ isActive: false }),
    });

    const res = await a.request(`/c/${community.slug}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tierId: tier.id, ...PAYER }),
    });

    expect(res.status).toBe(404);
  });

  it("rejects an unknown slug with 404", async () => {
    const res = await app().request(`/c/tidak-ada/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tierId: "00000000-0000-0000-0000-000000000000", ...PAYER }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects an archived community with 404", async () => {
    const a = app();
    const { token, community, tier } = await seedPayableCommunity(a);
    await a.request(`/communities/${community.id}`, {
      method: "PATCH",
      headers: bearer(token),
      body: JSON.stringify({ status: "archived" }),
    });

    const res = await a.request(`/c/${community.slug}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tierId: tier.id, ...PAYER }),
    });

    expect(res.status).toBe(404);
  });

  // Spec §9.1: paused communities render their public page (shared WhatsApp
  // links keep working) but cannot be purchased. The route must re-check
  // status server-side via findBySlug rather than trusting a client-supplied
  // acceptingNewMembers flag, which never even reaches this request.
  it("rejects checkout on a paused community with 409", async () => {
    const a = app();
    const { token, community, tier } = await seedPayableCommunity(a);
    await a.request(`/communities/${community.id}`, {
      method: "PATCH",
      headers: bearer(token),
      body: JSON.stringify({ status: "paused" }),
    });

    const res = await a.request(`/c/${community.slug}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tierId: tier.id, ...PAYER }),
    });

    expect(res.status).toBe(409);
  });

  it("rejects a malformed whatsapp number with 400", async () => {
    const a = app();
    const { community, tier } = await seedPayableCommunity(a);

    const res = await a.request(`/c/${community.slug}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tierId: tier.id, payerName: "Siti", payerWhatsappNumber: "nope" }),
    });

    expect(res.status).toBe(400);
  });

  /**
   * Phase 5, Task 6(a), through the real route and the real composition root — which
   * wires a `SystemClock`, so these seed `next_billing_date` relative to the actual
   * clock rather than to a fixture. The window itself is pinned against an injected
   * clock in start-checkout.test.ts; what this proves is that the widened rule survives
   * the wiring, which is where Phase 3 lost a whole feature.
   */
  describe("renewing an existing membership", () => {
    /** Puts the member's only subscription into a given state. */
    async function setSubscription(patch: {
      status: string;
      daysUntilDue: number;
      graceEndsAt?: Date | null;
    }) {
      const dueDate = new Date(Date.now() + patch.daysUntilDue * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const [row] = await db.select().from(subscriptions);
      await db
        .update(subscriptions)
        .set({
          status: patch.status,
          nextBillingDate: dueDate,
          graceEndsAt: patch.graceEndsAt ?? null,
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.id, row.id));
      return row.id;
    }

    async function firstCheckoutAndActivate(a: ReturnType<typeof app>, slug: string, tierId: string) {
      const checkout = await (
        await a.request(`/c/${slug}/checkout`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tierId, ...PAYER }),
        })
      ).json();
      // Activated by hand rather than through the webhook: this file is about the
      // checkout route, and routes/webhooks.test.ts owns that path.
      await db
        .update(subscriptions)
        .set({ status: "active", updatedAt: new Date() })
        .where(eq(subscriptions.id, checkout.subscriptionId));
      return checkout;
    }

    it("lets a past_due member renew, reusing the same subscription", async () => {
      const a = app();
      const { community, tier } = await seedPayableCommunity(a);
      const first = await firstCheckoutAndActivate(a, community.slug, tier.id);
      await setSubscription({
        status: "past_due",
        daysUntilDue: -2,
        graceEndsAt: new Date(Date.now() + 5 * 86_400_000),
      });

      const res = await a.request(`/c/${community.slug}/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tierId: tier.id, ...PAYER }),
      });

      expect(res.status).toBe(201);
      // The SAME row: a second one would be activated alongside the first, which stays
      // `past_due` for the churn pass to revoke.
      expect((await res.json()).subscriptionId).toBe(first.subscriptionId);
      expect(await db.select().from(subscriptions)).toHaveLength(1);
    });

    it("lets an ACTIVE member inside the reminder window renew: the pre_3d link must work", async () => {
      const a = app();
      const { community, tier } = await seedPayableCommunity(a);
      const first = await firstCheckoutAndActivate(a, community.slug, tier.id);
      await setSubscription({ status: "active", daysUntilDue: 2 });

      const res = await a.request(`/c/${community.slug}/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tierId: tier.id, ...PAYER }),
      });

      expect(res.status).toBe(201);
      expect((await res.json()).subscriptionId).toBe(first.subscriptionId);
    });

    it("still 409s an ACTIVE member who is nowhere near renewal", async () => {
      const a = app();
      const { community, tier } = await seedPayableCommunity(a);
      await firstCheckoutAndActivate(a, community.slug, tier.id);
      await setSubscription({ status: "active", daysUntilDue: 25 });

      const res = await a.request(`/c/${community.slug}/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tierId: tier.id, ...PAYER }),
      });

      // Phase 3's rule, unchanged: paying now buys them nothing they do not have.
      expect(res.status).toBe(409);
      expect(await db.select().from(subscriptions)).toHaveLength(1);
    });
  });

  it("reuses the member record when the same number checks out twice", async () => {
    const a = app();
    const { community, tier } = await seedPayableCommunity(a);
    const body = JSON.stringify({ tierId: tier.id, ...PAYER });
    const headers = { "Content-Type": "application/json" };

    await a.request(`/c/${community.slug}/checkout`, { method: "POST", headers, body });
    const second = await a.request(`/c/${community.slug}/checkout`, {
      method: "POST", headers, body,
    });

    // member.whatsapp_number is unique — a second checkout must not 500.
    expect(second.status).toBe(201);
  });
});
