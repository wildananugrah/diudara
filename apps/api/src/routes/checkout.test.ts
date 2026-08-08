import { describe, expect, it, beforeEach } from "bun:test";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { resetDatabase } from "../db/test-helpers";
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
