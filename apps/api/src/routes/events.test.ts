import { describe, expect, it, beforeEach } from "bun:test";
import { Hono } from "hono";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { resetDatabase } from "../db/test-helpers";
import type { TokenIssuerPort } from "../application/ports/token-issuer.port";
import type { AuthVariables } from "../http/auth.middleware";
import { errorHandler } from "../http/error-handler";
import { eventRoutes } from "./events";
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

describe("POST /communities/:communityId/events", () => {
  it("schedules a session and returns an RTMP URL and a stream key", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);

    const res = await a.request(`/communities/${community.id}/events`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ title: "Live Q&A" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.title).toBe("Live Q&A");
    expect(body.status).toBe("scheduled");
    expect(body.rtmpUrl).toContain("rtmp://");
    expect(body.streamKey).toMatch(/^[0-9a-f]{32}$/);
    expect(body.hlsPlaybackPath).toContain(body.streamKey);
  });

  it("mints a different key for a second session in the same community", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);

    const schedule = () =>
      a.request(`/communities/${community.id}/events`, {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({ title: "Session" }),
      });

    const first = await (await schedule()).json();
    const second = await (await schedule()).json();

    expect(second.streamKey).not.toBe(first.streamKey);
    expect(second.id).not.toBe(first.id);
  });

  it("returns 404 when scheduling for another creator's community", async () => {
    const a = app();
    const owner = await signupAndGetToken(a);
    const stranger = await signupAndGetToken(a);
    const community = await makeCommunity(a, owner.token);

    const res = await a.request(`/communities/${community.id}/events`, {
      method: "POST",
      headers: bearer(stranger.token),
      body: JSON.stringify({ title: "Not yours" }),
    });

    expect(res.status).toBe(404);
    // Nothing about the stream key ever reaches a stranger's response.
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("streamKey");
  });

  it("accepts an explicit scheduledAt and rejects an unparseable one with 400", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);

    const ok = await a.request(`/communities/${community.id}/events`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ title: "Later", scheduledAt: "2026-09-01T10:00:00.000Z" }),
    });
    expect(ok.status).toBe(201);

    const bad = await a.request(`/communities/${community.id}/events`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ title: "Bad time", scheduledAt: "not-a-date" }),
    });
    expect(bad.status).toBe(400);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);

    const res = await a.request(`/communities/${community.id}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Live Q&A" }),
    });

    expect(res.status).toBe(401);
  });

  it("rejects a non-UUID communityId with 400, not 500", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);

    const res = await a.request("/communities/not-a-uuid/events", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ title: "Live Q&A" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /communities/:communityId/events", () => {
  it("lists sessions for a community the caller owns, including the stream key", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);
    const created = await (
      await a.request(`/communities/${community.id}/events`, {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({ title: "Live Q&A" }),
      })
    ).json();

    const res = await a.request(`/communities/${community.id}/events`, {
      headers: bearer(token),
    });

    expect(res.status).toBe(200);
    const list = await res.json();
    expect(list).toHaveLength(1);
    // The owner is allowed to see their own key again — it is how they would
    // recover it if OBS lost the connection settings.
    expect(list[0].streamKey).toBe(created.streamKey);
  });

  it("returns 404, and the stream key does not appear anywhere, for another creator's community", async () => {
    const a = app();
    const owner = await signupAndGetToken(a);
    const stranger = await signupAndGetToken(a);
    const community = await makeCommunity(a, owner.token);
    await a.request(`/communities/${community.id}/events`, {
      method: "POST",
      headers: bearer(owner.token),
      body: JSON.stringify({ title: "Owner's session" }),
    });

    const res = await a.request(`/communities/${community.id}/events`, {
      headers: bearer(stranger.token),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("streamKey");
  });

  it("rejects an unauthenticated request with 401", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);

    const res = await a.request(`/communities/${community.id}/events`);
    expect(res.status).toBe(401);
  });
});

describe("POST/GET /communities/:communityId/events when streaming is disabled", () => {
  const fakeTokenIssuer: TokenIssuerPort = {
    async issue() {
      return "fake.token";
    },
    async verify(token) {
      return token === "valid" ? { creatorId: "creator-1" } : null;
    },
  };

  function disabledApp() {
    const honoApp = new Hono<{ Variables: AuthVariables }>();
    honoApp.onError(errorHandler);
    honoApp.route(
      "/communities/:communityId/events",
      eventRoutes({
        tokenIssuer: fakeTokenIssuer,
        scheduleLiveSession: undefined,
        listLiveSessions: {
          async execute() {
            return [];
          },
        } as never,
      })
    );
    return honoApp;
  }

  it("POST returns 503 rather than 500 or silently doing nothing", async () => {
    const res = await disabledApp().request(
      "/communities/00000000-0000-4000-8000-000000000000/events",
      {
        method: "POST",
        headers: { Authorization: "Bearer valid", "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Live Q&A" }),
      }
    );
    expect(res.status).toBe(503);
  });

  it("GET still works — listing depends on no provider", async () => {
    const res = await disabledApp().request(
      "/communities/00000000-0000-4000-8000-000000000000/events",
      { headers: { Authorization: "Bearer valid" } }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});
