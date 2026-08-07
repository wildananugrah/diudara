import { describe, expect, it, beforeEach } from "bun:test";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { resetDatabase } from "../db/test-helpers";
import { bearer, signupAndGetToken } from "./test-support";

beforeEach(resetDatabase);

function app() {
  return createApp(bootstrap());
}

async function makeCommunity(a: ReturnType<typeof app>, token: string) {
  const res = await a.request("/communities", {
    method: "POST",
    headers: bearer(token),
    body: JSON.stringify({ name: "Kelas Budi" }),
  });
  return res.json();
}

const CHANNEL = { platform: "telegram", externalGroupId: "-1001234567890" };

describe("POST /communities/:id/channels", () => {
  it("connects a channel to a community the caller owns", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);

    const res = await a.request(`/communities/${community.id}/channels`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify(CHANNEL),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.platform).toBe("telegram");
    expect(body.externalGroupId).toBe("-1001234567890");
    // Phase 4 wires the real bot; until then the channel is recorded but not live.
    expect(body.botStatus).toBe("disconnected");
    expect(body.inviteLink).toBeNull();
  });

  it("returns 404 when connecting to another creator's community", async () => {
    const a = app();
    const owner = await signupAndGetToken(a);
    const stranger = await signupAndGetToken(a);
    const community = await makeCommunity(a, owner.token);

    const res = await a.request(`/communities/${community.id}/channels`, {
      method: "POST",
      headers: bearer(stranger.token),
      body: JSON.stringify(CHANNEL),
    });

    expect(res.status).toBe(404);
  });

  it("rejects an unsupported platform with 400", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);

    const res = await a.request(`/communities/${community.id}/channels`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ platform: "discord", externalGroupId: "123" }),
    });

    expect(res.status).toBe(400);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);

    const res = await a.request(`/communities/${community.id}/channels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(CHANNEL),
    });

    expect(res.status).toBe(401);
  });
});

describe("GET /communities/:id/channels", () => {
  it("lists channels for a community the caller owns", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);

    await a.request(`/communities/${community.id}/channels`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify(CHANNEL),
    });

    const res = await a.request(`/communities/${community.id}/channels`, {
      headers: bearer(token),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).length).toBe(1);
  });

  it("returns 404 when listing another creator's channels", async () => {
    const a = app();
    const owner = await signupAndGetToken(a);
    const stranger = await signupAndGetToken(a);
    const community = await makeCommunity(a, owner.token);

    const res = await a.request(`/communities/${community.id}/channels`, {
      headers: bearer(stranger.token),
    });

    expect(res.status).toBe(404);
  });
});
