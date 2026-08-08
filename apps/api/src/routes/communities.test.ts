import { describe, expect, it, beforeEach } from "bun:test";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { resetDatabase } from "../db/test-helpers";
import { bearer, signupAndGetToken } from "./test-support";

beforeEach(resetDatabase);

function app() {
  return createApp(bootstrap());
}

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
