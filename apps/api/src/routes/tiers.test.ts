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
});
