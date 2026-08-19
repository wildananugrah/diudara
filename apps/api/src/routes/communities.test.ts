import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { db } from "../db/client";
import { communities } from "../db/schema";
import { resetDatabase } from "../db/test-helpers";
import { bearer, signupAndGetToken } from "./test-support";

beforeEach(resetDatabase);

function app() {
  return createApp(bootstrap());
}

/**
 * Runs `fn` with each of `vars` set to its given value (or unset when the
 * value is `undefined`), always restoring the originals — same in-process
 * mutation as `bootstrap.test.ts`'s own `withEnv`/`public-community.test.ts`'s
 * copy, ASYNC for the same reason that one is: `fn` makes real HTTP requests,
 * so restoring the environment must wait for `fn`'s promise to settle rather
 * than firing as soon as the async function returns from its first `await`.
 */
async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    originals[key] = process.env[key];
  }
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await fn();
  } finally {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/** The env override that boots a process with no payment provider at all. */
const PAYMENTS_DISABLED_ENV = {
  NODE_ENV: "production",
  APP_BASE_URL: "http://localhost:5173",
  XENDIT_SECRET_KEY: undefined,
  XENDIT_SPLIT_RULE_ID: undefined,
  XENDIT_CALLBACK_TOKEN: undefined,
  // selectMessagingProviders is unaffected by Task 2 and still refuses to
  // boot outside RELAXED_NODE_ENVS when absent — fully configuring it here
  // isolates the assertion to the payments dimension, exactly as
  // bootstrap.test.ts's own rewritten tests do.
  TELEGRAM_BOT_TOKEN: "123456:real-bot-token",
  FONNTE_API_TOKEN: "real-fonnte-token",
  TELEGRAM_WEBHOOK_SECRET: "tg_" + "S".repeat(40),
  // Task 2 (images): selectMediaStorage now block-boots NODE_ENV=production
  // with no S3 vars set — same reasoning as the messaging tokens just above,
  // fully configured here so this test stays isolated to the payments
  // dimension instead of failing on an unrelated guard.
  S3_ACCESS_KEY_ID: "test-s3-access-key",
  S3_SECRET_ACCESS_KEY: "test-s3-secret-key",
  S3_BUCKET: "test-bucket",
  S3_ENDPOINT: "https://s3.test.example.com",
  S3_REGION: "id-jkt-1",
};

describe("POST /communities", () => {
  it("creates a community with a slug derived from the name", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);

    const res = await a.request("/communities", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ name: "Kelas Bimbel Budi", niche: "bimbel" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.slug).toBe("kelas-bimbel-budi");
    expect(body.name).toBe("Kelas Bimbel Budi");
  });

  it("rejects an unauthenticated request with 401", async () => {
    const res = await app().request("/communities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Kelas" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects an empty name with 400", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);

    const res = await a.request("/communities", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ name: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("gives the second community a suffixed slug", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);

    await a.request("/communities", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ name: "Kelas Budi" }),
    });
    const res = await a.request("/communities", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ name: "Kelas Budi" }),
    });

    expect((await res.json()).slug).toBe("kelas-budi-2");
  });

  it("creates a second community with a 200-character name without overflowing the slug column", async () => {
    // `createCommunitySchema.name` allows 255 characters, so a slug at or past
    // the column's 120-character limit is reachable from the public API. The
    // first community fit; the second appended "-2" past varchar(120) and 500'd.
    const a = app();
    const { token } = await signupAndGetToken(a);
    const name = "k".repeat(200);

    const create = () =>
      a.request("/communities", {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({ name }),
      });

    const first = await create();
    const second = await create();

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const firstSlug = (await first.json()).slug;
    const secondSlug = (await second.json()).slug;
    expect(firstSlug).not.toBe(secondSlug);
    expect(secondSlug.length).toBeLessThanOrEqual(120);
  });

  it("gives every concurrent create of the same name a 201 with a distinct slug", async () => {
    // `slugExists` + insert is check-then-act, and the slug namespace is GLOBAL
    // across creators — so unrelated creators race too. Before the retry loop,
    // four concurrent creates of one name returned 500, 201, 201, 500.
    const a = app();
    const { token } = await signupAndGetToken(a);
    const racers = 5;

    const responses = await Promise.all(
      Array.from({ length: racers }, () =>
        a.request("/communities", {
          method: "POST",
          headers: bearer(token),
          body: JSON.stringify({ name: "Kelas Bareng" }),
        })
      )
    );

    expect(responses.map((r) => r.status)).toEqual(Array(racers).fill(201));

    const slugs = (await Promise.all(responses.map((r) => r.json()))).map((b) => b.slug);
    expect(new Set(slugs).size).toBe(racers);
  });

  it("keeps concurrent creates from two different creators distinct", async () => {
    const a = app();
    const one = await signupAndGetToken(a);
    const two = await signupAndGetToken(a);

    const responses = await Promise.all(
      [one, two, one, two].map((who) =>
        a.request("/communities", {
          method: "POST",
          headers: bearer(who.token),
          body: JSON.stringify({ name: "Kelas Bareng" }),
        })
      )
    );

    expect(responses.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    const slugs = (await Promise.all(responses.map((r) => r.json()))).map((b) => b.slug);
    expect(new Set(slugs).size).toBe(4);
  });
});

/**
 * Task 2 fix round 1 (review Critical): `createCommunitySchema` was
 * `z.object({ name, niche })`, and Zod STRIPS unknown keys — so
 * `routes/communities.ts`'s `...input` spread could never carry `accessMode`
 * through to `CreateCommunity`, no matter what a client sent. On a
 * payments-disabled box `input.accessMode` was therefore always `undefined`,
 * and the guard (correctly) refused it every time: `POST /communities`
 * always 409'd, even with `accessMode: "request"` in the body — the box
 * booted and then could not do the one thing it exists to do. Fixed by
 * adding `accessMode` to the shared Zod schema, `CommunityRecord`/
 * `CommunityPatch`, and `DrizzleCommunityRepository`.
 *
 * These go through the REAL HTTP route, the REAL Zod schema, and a REAL
 * Postgres row read back with a fresh query — not a fake repository that
 * would only prove it echoes its input.
 */
describe("POST /communities, payments disabled", () => {
  it("accepts accessMode: request and persists it, readable back from Postgres", async () => {
    await withEnv(PAYMENTS_DISABLED_ENV, async () => {
      const a = createApp(bootstrap());
      const { token } = await signupAndGetToken(a);

      const res = await a.request("/communities", {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({ name: "Kelas Gratis", accessMode: "request" }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.accessMode).toBe("request");

      // Read back with a FRESH query against the real table — not the value
      // the route just handed back — so a column mapped wrong or a silently
      // dropped write would show up here even if the response body lied.
      const [row] = await db.select().from(communities).where(eq(communities.id, body.id));
      expect(row.accessMode).toBe("request");
    });
  });

  it("still 409s when accessMode is omitted (defaults to paid, which is refused)", async () => {
    await withEnv(PAYMENTS_DISABLED_ENV, async () => {
      const a = createApp(bootstrap());
      const { token } = await signupAndGetToken(a);

      const res = await a.request("/communities", {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({ name: "Kelas Tanpa Mode" }),
      });

      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe(
        "pembayaran belum dikonfigurasi di server ini, jadi komunitas berbayar belum bisa dibuat"
      );
    });
  });

  it("still 409s when accessMode: paid is sent explicitly", async () => {
    await withEnv(PAYMENTS_DISABLED_ENV, async () => {
      const a = createApp(bootstrap());
      const { token } = await signupAndGetToken(a);

      const res = await a.request("/communities", {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({ name: "Kelas Berbayar", accessMode: "paid" }),
      });

      expect(res.status).toBe(409);
    });
  });

  it("rejects an accessMode outside the allowlist with 400, not a silent write", async () => {
    await withEnv(PAYMENTS_DISABLED_ENV, async () => {
      const a = createApp(bootstrap());
      const { token } = await signupAndGetToken(a);

      const res = await a.request("/communities", {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({ name: "Kelas Aneh", accessMode: "free" }),
      });

      expect(res.status).toBe(400);
    });
  });
});

describe("GET /communities", () => {
  it("returns only the calling creator's communities", async () => {
    const a = app();
    const owner = await signupAndGetToken(a);
    const stranger = await signupAndGetToken(a);

    await a.request("/communities", {
      method: "POST",
      headers: bearer(owner.token),
      body: JSON.stringify({ name: "Punya Owner" }),
    });

    const ownerList = await (
      await a.request("/communities", { headers: bearer(owner.token) })
    ).json();
    const strangerList = await (
      await a.request("/communities", { headers: bearer(stranger.token) })
    ).json();

    expect(ownerList.length).toBe(1);
    expect(ownerList[0].name).toBe("Punya Owner");
    expect(strangerList).toEqual([]);
  });
});

describe("GET /communities/:id", () => {
  it("returns a community the caller owns", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const created = await (
      await a.request("/communities", {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({ name: "Kelas Satu", niche: "bimbel" }),
      })
    ).json();

    const res = await a.request(`/communities/${created.id}`, { headers: bearer(token) });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(created.id);
    expect(body.name).toBe("Kelas Satu");
    expect(body.niche).toBe("bimbel");
  });

  it("returns 404 — not 403 — for another creator's community", async () => {
    const a = app();
    const owner = await signupAndGetToken(a);
    const stranger = await signupAndGetToken(a);

    const created = await (
      await a.request("/communities", {
        method: "POST",
        headers: bearer(owner.token),
        body: JSON.stringify({ name: "Punya Owner" }),
      })
    ).json();

    const res = await a.request(`/communities/${created.id}`, {
      headers: bearer(stranger.token),
    });

    // 404, not 403: never confirm the resource exists to a non-owner.
    expect(res.status).toBe(404);
  });

  it("returns 404 for a well-formed id that does not exist", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);

    const res = await a.request("/communities/00000000-0000-0000-0000-000000000000", {
      headers: bearer(token),
    });

    expect(res.status).toBe(404);
  });

  it("rejects a non-UUID id with 400, not 500", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);

    const res = await a.request("/communities/not-a-uuid", { headers: bearer(token) });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("id");
  });

  it("still requires authentication before validating the id", async () => {
    const res = await app().request("/communities/not-a-uuid");
    expect(res.status).toBe(401);
  });
});

describe("PATCH /communities/:id", () => {
  it("updates a community the caller owns", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const created = await (
      await a.request("/communities", {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({ name: "Nama Lama" }),
      })
    ).json();

    const res = await a.request(`/communities/${created.id}`, {
      method: "PATCH",
      headers: bearer(token),
      body: JSON.stringify({ name: "Nama Baru" }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe("Nama Baru");
  });

  it("returns 404 — not 403 — when updating another creator's community", async () => {
    const a = app();
    const owner = await signupAndGetToken(a);
    const stranger = await signupAndGetToken(a);

    const created = await (
      await a.request("/communities", {
        method: "POST",
        headers: bearer(owner.token),
        body: JSON.stringify({ name: "Asli" }),
      })
    ).json();

    const res = await a.request(`/communities/${created.id}`, {
      method: "PATCH",
      headers: bearer(stranger.token),
      body: JSON.stringify({ name: "Dibajak" }),
    });

    // 404, not 403: never confirm the resource exists to a non-owner.
    expect(res.status).toBe(404);

    const stillOriginal = await (
      await a.request("/communities", { headers: bearer(owner.token) })
    ).json();
    expect(stillOriginal[0].name).toBe("Asli");
  });

  it("rejects a slug already taken by another community with 409", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);

    await a.request("/communities", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ name: "Sudah Dipakai" }),
    });
    const second = await (
      await a.request("/communities", {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({ name: "Yang Kedua" }),
      })
    ).json();

    const res = await a.request(`/communities/${second.id}`, {
      method: "PATCH",
      headers: bearer(token),
      body: JSON.stringify({ slug: "sudah-dipakai" }),
    });

    expect(res.status).toBe(409);
  });

  it("rejects a non-UUID id with 400, not 500", async () => {
    // An unvalidated id reaches `where id = $1` and Postgres raises
    // "invalid input syntax for type uuid" — an unhandled DB error on trivially
    // reachable client input.
    const a = app();
    const { token } = await signupAndGetToken(a);

    const res = await a.request("/communities/not-a-uuid", {
      method: "PATCH",
      headers: bearer(token),
      body: JSON.stringify({ name: "Apa Saja" }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("id");
  });

  it("still requires authentication before validating the id", async () => {
    // Param validation must not become an oracle: an anonymous caller gets 401
    // whether or not the id is well-formed.
    const res = await app().request("/communities/not-a-uuid", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Apa Saja" }),
    });
    expect(res.status).toBe(401);
  });
});
