import { describe, expect, it, beforeEach } from "bun:test";
import type { Hono } from "hono";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { db } from "../db/client";
import { members, subscriptions, transactions } from "../db/schema";
import { resetDatabase } from "../db/test-helpers";
import { bearer, signupAndGetToken } from "./test-support";

beforeEach(resetDatabase);

function app() {
  return createApp(bootstrap());
}

type App = ReturnType<typeof app>;

async function makeCommunity(a: App, token: string, name = "Kelas Budi") {
  const res = await a.request("/communities", {
    method: "POST",
    headers: bearer(token),
    body: JSON.stringify({ name }),
  });
  if (res.status !== 201) throw new Error(`makeCommunity: ${res.status} ${await res.text()}`);
  return res.json();
}

async function makeTier(
  a: App,
  token: string,
  communityId: string,
  input: { name: string; priceAmount: number }
) {
  const res = await a.request(`/communities/${communityId}/tiers`, {
    method: "POST",
    headers: bearer(token),
    body: JSON.stringify({ ...input, billingCycle: "monthly" }),
  });
  if (res.status !== 201) throw new Error(`makeTier: ${res.status} ${await res.text()}`);
  return res.json();
}

let seedCounter = 0;

/**
 * A member with a subscription in an explicit status, inserted straight into the
 * database. The full checkout + webhook path is exercised elsewhere; these tests
 * are about what the analytics reads report, so the states they must report on are
 * set up directly.
 */
async function seedMemberWithSubscription(
  tierId: string,
  status: string,
  overrides: { name?: string } = {}
) {
  seedCounter += 1;
  const [member] = await db
    .insert(members)
    .values({
      whatsappNumber: `+62811${String(seedCounter).padStart(7, "0")}`,
      name: overrides.name ?? `Member ${seedCounter}`,
    })
    .returning();
  const [subscription] = await db
    .insert(subscriptions)
    .values({ memberId: member.id, tierId, status })
    .returning();
  return { member, subscription };
}

async function seedTransaction(subscriptionId: string, amount: number, status: string) {
  await db
    .insert(transactions)
    .values({ subscriptionId, amount, status, paymentMethod: "qris" })
    .returning();
}

describe("GET /communities/:communityId/metrics", () => {
  it("reports member counts, gross revenue and tier distribution", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);
    const basic = await makeTier(a, token, community.id, { name: "Basic", priceAmount: 50_000 });
    await makeTier(a, token, community.id, { name: "VIP", priceAmount: 250_000 });

    const active = await seedMemberWithSubscription(basic.id, "active");
    await seedMemberWithSubscription(basic.id, "past_due");
    await seedMemberWithSubscription(basic.id, "churned");
    await seedTransaction(active.subscription.id, 50_000, "success");
    await seedTransaction(active.subscription.id, 999_999, "pending");

    const res = await a.request(`/communities/${community.id}/metrics`, {
      headers: bearer(token),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.members).toEqual({ active: 1, pastDue: 1, churned: 1 });
    expect(body.grossRevenueAmount).toBe(50_000);
    expect(body.tierDistribution).toEqual([
      { tierId: basic.id, tierName: "Basic", priceAmount: 50_000, activeMembers: 1 },
      {
        tierId: body.tierDistribution[1].tierId,
        tierName: "VIP",
        priceAmount: 250_000,
        activeMembers: 0,
      },
    ]);
  });

  it("names the revenue field so it cannot be mislabelled as net", async () => {
    // Xendit's split rule deducts DIUDARA's fee before the creator receives
    // anything, so this figure is GROSS. Task 7 has to label it as such, and a
    // field called `revenue` would invite presenting it as the creator's income.
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);

    const body = await (
      await a.request(`/communities/${community.id}/metrics`, { headers: bearer(token) })
    ).json();

    expect(Object.keys(body)).toContain("grossRevenueAmount");
    expect(Object.keys(body)).not.toContain("revenue");
    expect(Object.keys(body)).not.toContain("revenueAmount");
  });

  it("returns 404 for another creator's community and leaks nothing about it", async () => {
    const a = app();
    const owner = await signupAndGetToken(a);
    const stranger = await signupAndGetToken(a);
    const community = await makeCommunity(a, owner.token);
    const tier = await makeTier(a, owner.token, community.id, {
      name: "Kelas Rahasia VIP",
      priceAmount: 987_654,
    });
    const paid = await seedMemberWithSubscription(tier.id, "active", { name: "Siti Rahasia" });
    await seedTransaction(paid.subscription.id, 987_654, "success");

    const res = await a.request(`/communities/${community.id}/metrics`, {
      headers: bearer(stranger.token),
    });

    // 404, never 403: a 403 would confirm the community exists.
    expect(res.status).toBe(404);

    const text = await res.text();
    expect(text).not.toContain("Kelas Rahasia VIP");
    expect(text).not.toContain("Siti Rahasia");
    expect(text).not.toContain("987654");
    expect(text).not.toContain(paid.member.id);
    expect(text).not.toContain(tier.id);
    // No member count either — and rather than guessing which number might leak,
    // assert the body carries NO digits at all.
    expect(text).not.toMatch(/[0-9]/);
  });

  it("returns 404 for a community that does not exist", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const res = await a.request("/communities/00000000-0000-4000-8000-000000000000/metrics", {
      headers: bearer(token),
    });
    expect(res.status).toBe(404);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);
    const res = await a.request(`/communities/${community.id}/metrics`);
    expect(res.status).toBe(401);
  });

  it("rejects a non-UUID communityId with 400, not 500", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const res = await a.request("/communities/not-a-uuid/metrics", { headers: bearer(token) });
    expect(res.status).toBe(400);
  });

  it("still answers 401 before validating the params", async () => {
    const res = await app().request("/communities/not-a-uuid/metrics");
    expect(res.status).toBe(401);
  });
});

describe("mounting the analytics routes under /communities", () => {
  it("leaves the existing /communities collection endpoints working", async () => {
    // The analytics sub-app is mounted at `/communities`, so a `use("*")` inside it
    // would also match `GET /communities` and `POST /communities` — and its
    // communityId param check would then 400 both of them. Probed for real: Hono
    // composes EVERY matching handler, and `*` mounted at `/communities` matches
    // `/communities` itself. Its middleware is therefore per-route, and this test
    // is what would notice a `use("*")` creeping back in.
    const a = app();
    const { token } = await signupAndGetToken(a);
    await makeCommunity(a, token, "Kelas Satu");

    const listed = await a.request("/communities", { headers: bearer(token) });
    expect(listed.status).toBe(200);
    expect((await listed.json()).length).toBe(1);

    const created = await a.request("/communities", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ name: "Kelas Dua" }),
    });
    expect(created.status).toBe(201);
  });
});
