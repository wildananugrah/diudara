import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { db } from "../db/client";
import { appUsers, userStreams, userSubscriptions, userTiers } from "../db/schema";
import { resetDatabase } from "../db/test-helpers";
import { errorHandler } from "../http/error-handler";
import type { UserAuthVariables } from "../http/user-auth.middleware";
import type { UserRepositoryPort } from "../application/ports/user-repository.port";
import type { UserTokenIssuerPort } from "../application/ports/user-token-issuer.port";
import { streamRoutes } from "./streams";

beforeEach(resetDatabase);

function app() {
  return createApp(bootstrap());
}

const RINA = {
  handle: "rina",
  email: "rina@example.com",
  password: "supersecret123",
  displayName: "Rina",
};

const BUDI = {
  handle: "budi",
  email: "budi@example.com",
  password: "supersecret123",
  displayName: "Budi",
};

function authed(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

/**
 * Signs up and then logs in, returning the bearer token and the new user's
 * id. Two calls because `POST /users/signup` deliberately answers
 * `{ ok: true }` and nothing else (see `RegisterUser`'s docstring) — mirrors
 * `routes/posts.test.ts`'s own `tokenForValidUser`.
 */
async function signUp(a: ReturnType<typeof app>, account: typeof RINA) {
  const signup = await a.request("/users/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(account),
  });
  expect(signup.status).toBe(201);
  const login = await a.request("/users/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: account.email, password: account.password }),
  });
  expect(login.status).toBe(200);
  const body = await login.json();
  return { token: body.token as string, userId: body.user.id as string };
}

async function startStream(
  a: ReturnType<typeof app>,
  token: string,
  payload: { title: string; visibility?: "public" | "members" }
) {
  return a.request("/streams", {
    method: "POST",
    headers: authed(token),
    body: JSON.stringify(payload),
  });
}

/** An `active` subscription from `subscriberId` to `ownerId`, paid until `periodEnd`. */
async function subscribe(subscriberId: string, ownerId: string, periodEnd: Date) {
  const [tier] = await db
    .insert(userTiers)
    .values({ ownerId, name: "Anggota", priceAmount: 50_000, billingCycle: "monthly" })
    .returning();
  await db.insert(userSubscriptions).values({
    subscriberId,
    tierId: tier!.id,
    ownerId,
    status: "active",
    currentPeriodEnd: periodEnd,
  });
}

const IN_A_MONTH = () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const YESTERDAY = () => new Date(Date.now() - 24 * 60 * 60 * 1000);

describe("POST /streams", () => {
  it("returns both publish URLs and the key", async () => {
    const a = app();
    const { token } = await signUp(a, RINA);

    const res = await startStream(a, token, { title: "Tanya jawab", visibility: "members" });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual([
      "hlsPlaybackPath",
      "id",
      "rtmpUrl",
      "streamKey",
      "title",
      "visibility",
      "whipUrl",
    ]);
    expect(body.title).toBe("Tanya jawab");
    expect(body.visibility).toBe("members");
  });

  it("defaults an omitted visibility to public", async () => {
    const a = app();
    const { token } = await signUp(a, RINA);

    const body = await (await startStream(a, token, { title: "Ngobrol" })).json();

    expect(body.visibility).toBe("public");
  });

  it("refuses a second live stream with a 409, not a second key", async () => {
    const a = app();
    const { token, userId } = await signUp(a, RINA);
    await startStream(a, token, { title: "Satu", visibility: "public" });

    const res = await startStream(a, token, { title: "Dua" });

    expect(res.status).toBe(409);
    const rows = await db.select().from(userStreams).where(eq(userStreams.ownerId, userId));
    expect(rows).toHaveLength(1);
  });

  it("says why in Bahasa when it refuses the second stream", async () => {
    const a = app();
    const { token } = await signUp(a, RINA);
    await startStream(a, token, { title: "Satu", visibility: "public" });

    const body = await (await startStream(a, token, { title: "Dua" })).json();

    expect(body.error).toBe("sudah ada siaran yang sedang berlangsung");
  });

  it("rejects an empty or whitespace-only title with a 400", async () => {
    const a = app();
    const { token } = await signUp(a, RINA);

    expect((await startStream(a, token, { title: "   " })).status).toBe(400);
  });

  it("rejects a title of 141 characters, and accepts one of 140", async () => {
    const a = app();
    const { token } = await signUp(a, RINA);

    expect((await startStream(a, token, { title: "a".repeat(141) })).status).toBe(400);
    expect((await startStream(a, token, { title: "a".repeat(140) })).status).toBe(201);
  });

  it("rejects a visibility the server does not recognise", async () => {
    const a = app();
    const { token } = await signUp(a, RINA);

    const res = await a.request("/streams", {
      method: "POST",
      headers: authed(token),
      body: JSON.stringify({ title: "Ngobrol", visibility: "secret" }),
    });

    expect(res.status).toBe(400);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const a = app();

    const res = await a.request("/streams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Ngobrol" }),
    });

    expect(res.status).toBe(401);
  });
});

describe("GET /streams", () => {
  /** Rina live and gated; Budi signed up but not subscribed. */
  async function gatedStream(a: ReturnType<typeof app>) {
    const rina = await signUp(a, RINA);
    const budi = await signUp(a, BUDI);
    const stream = await (
      await startStream(a, rina.token, { title: "Tanya jawab", visibility: "members" })
    ).json();
    return { rina, budi, stream };
  }

  it("the listing's projection is CLOSED, and a locked row carries no playback path", async () => {
    const a = app();
    await gatedStream(a);

    const { streams } = await (await a.request("/streams")).json();
    const [gated] = streams;

    expect(Object.keys(gated).sort()).toEqual(["id", "locked", "owner", "title", "visibility"]);
    expect(gated.locked).toBe(true);
  });

  it("an unlocked row carries the path", async () => {
    const a = app();
    const { rina, budi } = await gatedStream(a);
    await subscribe(budi.userId, rina.userId, IN_A_MONTH());

    const { streams } = await (
      await a.request("/streams", { headers: { Authorization: `Bearer ${budi.token}` } })
    ).json();
    const [open] = streams;

    expect(Object.keys(open).sort()).toEqual([
      "hlsPlaybackPath",
      "id",
      "locked",
      "owner",
      "title",
      "visibility",
    ]);
    expect(open.locked).toBe(false);
  });

  /**
   * THE LEAK THIS ENDPOINT'S PROJECTION EXISTS TO CLOSE. `listLive` returns
   * `stream_key` on every row — correct at the repository layer, catastrophic
   * on this wire: a stream key authorises a PUBLISH, so one leaked key lets
   * any reader of a public listing broadcast as that creator. Asserted over
   * the whole serialised body, so a key smuggled inside a URL fails too.
   */
  it("NEVER sends a stream key, to a member, a stranger or the owner", async () => {
    const a = app();
    const { rina, budi, stream } = await gatedStream(a);
    await subscribe(budi.userId, rina.userId, IN_A_MONTH());

    const anonymous = await (await a.request("/streams")).text();
    const member = await (
      await a.request("/streams", { headers: { Authorization: `Bearer ${budi.token}` } })
    ).text();
    const owner = await (
      await a.request("/streams", { headers: { Authorization: `Bearer ${rina.token}` } })
    ).text();

    expect(stream.streamKey).toMatch(/^[0-9a-f]{32}$/);
    expect(anonymous).not.toContain(stream.streamKey);
    expect(member).not.toContain(stream.streamKey);
    expect(owner).not.toContain(stream.streamKey);
  });

  it("works signed out — Siaran is a publicly reachable page", async () => {
    const a = app();
    const rina = await signUp(a, RINA);
    await startStream(a, rina.token, { title: "Ngobrol santai", visibility: "public" });

    const res = await a.request("/streams");

    expect(res.status).toBe(200);
    const { streams } = await res.json();
    expect(streams.map((row: { title: string }) => row.title)).toEqual(["Ngobrol santai"]);
    expect(streams[0].locked).toBe(false);
  });

  /**
   * `resolveViewerId` degrades a bad token to "signed out" rather than
   * throwing — the same rule `GET /users/feed` follows, and the reason a
   * stale session cannot 401 a page that never required one.
   */
  it("treats a garbage bearer token as signed out, not as a 401", async () => {
    const a = app();
    await gatedStream(a);

    const res = await a.request("/streams", { headers: { Authorization: "Bearer nonsense" } });

    expect(res.status).toBe(200);
    expect((await res.json()).streams[0].locked).toBe(true);
  });

  it("locks a gated stream for a LAPSED member", async () => {
    const a = app();
    const { rina, budi } = await gatedStream(a);
    await subscribe(budi.userId, rina.userId, YESTERDAY());

    const { streams } = await (
      await a.request("/streams", { headers: { Authorization: `Bearer ${budi.token}` } })
    ).json();

    expect(streams[0].locked).toBe(true);
  });

  it("never locks the owner out of their own gated stream", async () => {
    const a = app();
    const { rina } = await gatedStream(a);

    const { streams } = await (
      await a.request("/streams", { headers: { Authorization: `Bearer ${rina.token}` } })
    ).json();

    expect(streams[0].locked).toBe(false);
  });

  it("drops a stream that has ENDED", async () => {
    const a = app();
    const rina = await signUp(a, RINA);
    const stream = await (
      await startStream(a, rina.token, { title: "Sudah selesai", visibility: "public" })
    ).json();
    await a.request(`/streams/${stream.id}`, {
      method: "DELETE",
      headers: authed(rina.token),
    });

    const { streams } = await (await a.request("/streams")).json();

    expect(streams).toEqual([]);
  });
});

describe("DELETE /streams/:id", () => {
  it("ends your own stream and frees the slot", async () => {
    const a = app();
    const rina = await signUp(a, RINA);
    const stream = await (
      await startStream(a, rina.token, { title: "Tanya jawab", visibility: "public" })
    ).json();

    const res = await a.request(`/streams/${stream.id}`, {
      method: "DELETE",
      headers: authed(rina.token),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ended: true });
    // The slot is genuinely free: a second stream now starts.
    expect((await startStream(a, rina.token, { title: "Lagi" })).status).toBe(201);
  });

  it("REFUSES to end somebody else's stream with a 403", async () => {
    const a = app();
    const rina = await signUp(a, RINA);
    const budi = await signUp(a, BUDI);
    const stream = await (
      await startStream(a, rina.token, { title: "Tanya jawab", visibility: "public" })
    ).json();

    const res = await a.request(`/streams/${stream.id}`, {
      method: "DELETE",
      headers: authed(budi.token),
    });

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("siaran ini bukan milik Anda");
    const [row] = await db.select().from(userStreams).where(eq(userStreams.id, stream.id));
    expect(row!.status).toBe("live");
  });

  it("404s an unknown id and 400s an id that is not a uuid", async () => {
    const a = app();
    const rina = await signUp(a, RINA);

    expect(
      (
        await a.request("/streams/00000000-0000-4000-8000-000000000000", {
          method: "DELETE",
          headers: authed(rina.token),
        })
      ).status
    ).toBe(404);
    expect(
      (await a.request("/streams/not-a-uuid", { method: "DELETE", headers: authed(rina.token) }))
        .status
    ).toBe(400);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const a = app();
    const rina = await signUp(a, RINA);
    const stream = await (
      await startStream(a, rina.token, { title: "Tanya jawab", visibility: "public" })
    ).json();

    const res = await a.request(`/streams/${stream.id}`, { method: "DELETE" });

    expect(res.status).toBe(401);
  });
});

/**
 * A box with no MediaMTX configured — `Dependencies.streamingProvider`, and
 * therefore `startUserStream`, is `undefined` (see `selectStreamingProvider`
 * in bootstrap.ts). Built by hand rather than by moving `NODE_ENV`, the same
 * shape `routes/events.test.ts` uses for the identical case: this is about
 * ONE undefined field, not about what a production boot selects.
 */
describe("/streams when streaming is not configured", () => {
  const OWNER_ID = "11111111-1111-4111-8111-111111111111";

  const fakeTokenIssuer: UserTokenIssuerPort = {
    async issue() {
      return "fake.token";
    },
    async verify(token) {
      return token === "valid" ? { userId: OWNER_ID, sessionEpoch: 1 } : null;
    },
  };

  const fakeUserRepository = {
    async findById(id: string) {
      return id === OWNER_ID
        ? {
            id: OWNER_ID,
            handle: "rina",
            email: "rina@example.com",
            whatsappNumber: null,
            displayName: "Rina",
            bio: null,
            sessionEpoch: 1,
            createdAt: new Date("2026-08-22T10:00:00.000Z"),
          }
        : null;
    },
  } as unknown as UserRepositoryPort;

  function disabledApp(overrides: Partial<Parameters<typeof streamRoutes>[0]> = {}) {
    const honoApp = new Hono<{ Variables: UserAuthVariables }>();
    honoApp.onError(errorHandler);
    honoApp.route(
      "/streams",
      streamRoutes({
        userTokenIssuer: fakeTokenIssuer,
        userRepository: fakeUserRepository,
        startUserStream: undefined,
        listLiveStreams: {
          async execute() {
            return { streams: [] };
          },
        } as never,
        endOwnUserStream: {
          async execute() {
            return undefined;
          },
        } as never,
        ...overrides,
      })
    );
    return honoApp;
  }

  it("a box with no streaming provider refuses to start a stream, and says so", async () => {
    const res = await disabledApp().request("/streams", {
      method: "POST",
      headers: { Authorization: "Bearer valid", "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Halo" }),
    });

    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("siaran langsung belum tersedia di server ini");
  });

  it("GET /streams still works — the listing depends on no provider", async () => {
    const res = await disabledApp().request("/streams");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ streams: [] });
  });

  it("DELETE still works — ending a row depends on no provider either", async () => {
    const res = await disabledApp().request("/streams/22222222-2222-4222-8222-222222222222", {
      method: "DELETE",
      headers: { Authorization: "Bearer valid", "Content-Type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ended: true });
  });
});
