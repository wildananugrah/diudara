import { describe, expect, it, beforeEach } from "bun:test";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { resetDatabase } from "../db/test-helpers";
import { bearer, signupAndGetToken } from "./test-support";

beforeEach(resetDatabase);

function app() {
  return createApp(bootstrap());
}

async function seedCommunity(a: ReturnType<typeof app>) {
  const { token } = await signupAndGetToken(a);
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
  return { token, community, tier };
}

describe("GET /c/:slug", () => {
  it("returns the community and its active tiers without authentication", async () => {
    const a = app();
    const { community } = await seedCommunity(a);

    const res = await a.request(`/c/${community.slug}`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.name).toBe("Kelas Bimbel Budi");
    expect(body.tiers.length).toBe(1);
    expect(body.tiers[0].priceAmount).toBe(50000);
  });

  it("leaks nothing about the creator or the platform's payment wiring", async () => {
    const a = app();
    const { community } = await seedCommunity(a);

    const text = await (await a.request(`/c/${community.slug}`)).text();
    for (const forbidden of ["creatorId", "creator_id", "xendit", "passwordHash", "email"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("hides inactive tiers from buyers", async () => {
    const a = app();
    const { token, community, tier } = await seedCommunity(a);
    await a.request(`/communities/${community.id}/tiers/${tier.id}`, {
      method: "PATCH",
      headers: bearer(token),
      body: JSON.stringify({ isActive: false }),
    });

    const body = await (await a.request(`/c/${community.slug}`)).json();
    expect(body.tiers.length).toBe(0);
  });

  it("returns 404 for an unknown slug", async () => {
    expect((await app().request("/c/tidak-ada")).status).toBe(404);
  });

  it("returns 404 for an archived community", async () => {
    const a = app();
    const { token, community } = await seedCommunity(a);
    await a.request(`/communities/${community.id}`, {
      method: "PATCH",
      headers: bearer(token),
      body: JSON.stringify({ status: "archived" }),
    });

    expect((await a.request(`/c/${community.slug}`)).status).toBe(404);
  });
});
