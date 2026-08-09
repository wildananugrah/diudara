import { describe, expect, it, beforeEach } from "bun:test";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { resetDatabase } from "../db/test-helpers";
import { bearer, signupAndGetToken } from "./test-support";

beforeEach(resetDatabase);

const TOKEN = process.env.XENDIT_CALLBACK_TOKEN ?? "test-callback-token";

function app() {
  return createApp(bootstrap());
}

/** Runs a real checkout and returns the ids the status endpoint and webhook reference. */
async function checkout(a: ReturnType<typeof app>) {
  const { token } = await signupAndGetToken(a);
  await a.request("/payment-account", { method: "POST", headers: bearer(token) });

  const community = await (
    await a.request("/communities", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ name: "Kelas Bimbel Budi", niche: "bimbel" }),
    })
  ).json();
  const tier = await (
    await a.request(`/communities/${community.id}/tiers`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ name: "Basic", priceAmount: 50000, billingCycle: "monthly" }),
    })
  ).json();
  const result = await (
    await a.request(`/c/${community.slug}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tierId: tier.id,
        payerName: "Siti Marlina",
        payerWhatsappNumber: "+6281234567890",
      }),
    })
  ).json();

  return { subscriptionId: result.subscriptionId as string, externalId: result.transactionId as string };
}

function postWebhook(a: ReturnType<typeof app>, externalId: string) {
  return a.request("/webhooks/xendit", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CALLBACK-TOKEN": TOKEN },
    body: JSON.stringify({ id: "evt-status-1", external_id: externalId, status: "PAID", amount: 50000 }),
  });
}

describe("GET /c/subscription/:subscriptionId/status", () => {
  it("returns pending for a freshly created subscription, without authentication", async () => {
    const a = app();
    const { subscriptionId } = await checkout(a);

    const res = await a.request(`/c/subscription/${subscriptionId}/status`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("pending");
  });

  it("flips to active once the webhook activates the subscription", async () => {
    const a = app();
    const { subscriptionId, externalId } = await checkout(a);

    expect((await postWebhook(a, externalId)).status).toBe(200);

    const body = await (await a.request(`/c/subscription/${subscriptionId}/status`)).json();
    expect(body.status).toBe("active");
  });

  it("returns 404 for an unknown (but well-formed) subscription id", async () => {
    const res = await app().request(
      "/c/subscription/00000000-0000-0000-0000-000000000000/status"
    );
    expect(res.status).toBe(404);
  });

  it("404s a subscription id that is not even a uuid, rather than 500ing", async () => {
    const a = app();
    for (const bad of ["haxx", "1 OR 1=1", "0000", "../../etc/passwd"]) {
      expect((await a.request(`/c/subscription/${encodeURIComponent(bad)}/status`)).status).toBe(
        404
      );
    }
  });

  // THE central risk of this endpoint: the id travels in a redirect URL, may
  // sit in browser history, and could be guessed at. It must return ONLY the
  // status string — asserted against the RAW response text, not a typed
  // field, because a spread would leak a column silently and a
  // `body.someField === undefined` check would not catch that.
  it("leaks nothing but the status — no name, WhatsApp number, amount, tier, creator, or community", async () => {
    const a = app();
    const { subscriptionId } = await checkout(a);

    const res = await a.request(`/c/subscription/${subscriptionId}/status`);
    const text = await res.text();

    expect(text).toBe(JSON.stringify({ status: "pending" }));

    for (const forbidden of [
      "Siti",
      "Marlina",
      "6281234567890",
      "50000",
      "Basic",
      "Bimbel",
      "memberId",
      "member_id",
      "tierId",
      "tier_id",
      "creatorId",
      "creator_id",
      "communityId",
      "community_id",
      "whatsapp",
      "xendit",
      "passwordHash",
      "email",
    ]) {
      expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("leaks nothing even once active — same projection after activation", async () => {
    const a = app();
    const { subscriptionId, externalId } = await checkout(a);
    await postWebhook(a, externalId);

    const text = await (await a.request(`/c/subscription/${subscriptionId}/status`)).text();
    expect(text).toBe(JSON.stringify({ status: "active" }));
  });
});
