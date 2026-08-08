import { describe, expect, it, beforeEach } from "bun:test";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { resetDatabase } from "../db/test-helpers";
import { bearer, signupAndGetToken } from "./test-support";

beforeEach(resetDatabase);

function app() {
  return createApp(bootstrap());
}

async function makeCommunity(a: ReturnType<typeof app>, token: string, name = "Kelas Budi") {
  const res = await a.request("/communities", {
    method: "POST",
    headers: bearer(token),
    body: JSON.stringify({ name }),
  });
  return res.json();
}

const TIER = { name: "Basic", priceAmount: 50000, billingCycle: "monthly" };

describe("POST /communities/:id/tiers", () => {
  it("creates a tier under a community the caller owns", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);

    const res = await a.request(`/communities/${community.id}/tiers`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify(TIER),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("Basic");
    expect(body.priceAmount).toBe(50000);
    expect(body.isActive).toBe(true);
  });

  it("returns 404 when creating a tier under another creator's community", async () => {
    const a = app();
    const owner = await signupAndGetToken(a);
    const stranger = await signupAndGetToken(a);
    const community = await makeCommunity(a, owner.token);

    const res = await a.request(`/communities/${community.id}/tiers`, {
      method: "POST",
      headers: bearer(stranger.token),
      body: JSON.stringify(TIER),
    });

    expect(res.status).toBe(404);
  });

  it("rejects a negative price with 400", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);

    const res = await a.request(`/communities/${community.id}/tiers`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ ...TIER, priceAmount: -100 }),
    });

    expect(res.status).toBe(400);
  });

  it("rejects an unknown billing cycle with 400", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);

    const res = await a.request(`/communities/${community.id}/tiers`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ ...TIER, billingCycle: "weekly" }),
    });

    expect(res.status).toBe(400);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);

    const res = await a.request(`/communities/${community.id}/tiers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(TIER),
    });

    expect(res.status).toBe(401);
  });
});

describe("GET /communities/:id/tiers", () => {
  it("lists tiers for a community the caller owns", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);

    await a.request(`/communities/${community.id}/tiers`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify(TIER),
    });

    const res = await a.request(`/communities/${community.id}/tiers`, {
      headers: bearer(token),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).length).toBe(1);
  });

  it("returns 404 when listing another creator's tiers", async () => {
    const a = app();
    const owner = await signupAndGetToken(a);
    const stranger = await signupAndGetToken(a);
    const community = await makeCommunity(a, owner.token);

    const res = await a.request(`/communities/${community.id}/tiers`, {
      headers: bearer(stranger.token),
    });

    expect(res.status).toBe(404);
  });
});

describe("PATCH /communities/:id/tiers/:tierId", () => {
  it("updates a tier the caller owns", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);
    const tier = await (
      await a.request(`/communities/${community.id}/tiers`, {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify(TIER),
      })
    ).json();

    const res = await a.request(`/communities/${community.id}/tiers/${tier.id}`, {
      method: "PATCH",
      headers: bearer(token),
      body: JSON.stringify({ priceAmount: 75000, isActive: false }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.priceAmount).toBe(75000);
    expect(body.isActive).toBe(false);
  });

  it("returns 404 when updating another creator's tier", async () => {
    const a = app();
    const owner = await signupAndGetToken(a);
    const stranger = await signupAndGetToken(a);
    const community = await makeCommunity(a, owner.token);
    const tier = await (
      await a.request(`/communities/${community.id}/tiers`, {
        method: "POST",
        headers: bearer(owner.token),
        body: JSON.stringify(TIER),
      })
    ).json();

    const res = await a.request(`/communities/${community.id}/tiers/${tier.id}`, {
      method: "PATCH",
      headers: bearer(stranger.token),
      body: JSON.stringify({ priceAmount: 1 }),
    });

    expect(res.status).toBe(404);
  });

  it("returns 404 when the tierId belongs to a different community, even one the caller owns", async () => {
    // The cross-CREATOR test above never reaches the repository: the ownership
    // check rejects it first. This case does — one creator, two communities,
    // a tierId from B submitted under A's path — so it is the only route test
    // that exercises the `eq(membershipTiers.communityId, ...)` clause in
    // updateForCommunity. Deleting that clause left the whole suite green.
    const a = app();
    const { token } = await signupAndGetToken(a);
    const communityA = await makeCommunity(a, token, "Kelas A");
    const communityB = await makeCommunity(a, token, "Kelas B");

    const tierInB = await (
      await a.request(`/communities/${communityB.id}/tiers`, {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify(TIER),
      })
    ).json();

    const res = await a.request(`/communities/${communityA.id}/tiers/${tierInB.id}`, {
      method: "PATCH",
      headers: bearer(token),
      body: JSON.stringify({ name: "Dibajak", priceAmount: 1 }),
    });

    expect(res.status).toBe(404);

    // And the tier itself must be untouched — a 404 with the write applied
    // would be worse than a 200.
    const tiersInB = await (
      await a.request(`/communities/${communityB.id}/tiers`, { headers: bearer(token) })
    ).json();
    expect(tiersInB).toHaveLength(1);
    expect(tiersInB[0].name).toBe(TIER.name);
    expect(tiersInB[0].priceAmount).toBe(TIER.priceAmount);
  });

  it("rejects a non-UUID tierId with 400, not 500", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);

    const res = await a.request(`/communities/${community.id}/tiers/not-a-uuid`, {
      method: "PATCH",
      headers: bearer(token),
      body: JSON.stringify({ priceAmount: 1 }),
    });

    expect(res.status).toBe(400);
  });
});

describe("tier route path parameters", () => {
  it("rejects a non-UUID communityId with 400, not 500", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);

    const listed = await a.request("/communities/not-a-uuid/tiers", {
      headers: bearer(token),
    });
    expect(listed.status).toBe(400);

    const created = await a.request("/communities/not-a-uuid/tiers", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify(TIER),
    });
    expect(created.status).toBe(400);
  });

  it("still answers 401 before validating the params", async () => {
    const res = await app().request("/communities/not-a-uuid/tiers");
    expect(res.status).toBe(401);
  });
});
