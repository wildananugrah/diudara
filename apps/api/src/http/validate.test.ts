import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { z } from "zod";
import { errorHandler } from "./error-handler";
import { uuidParam, validate, validateParams } from "./validate";

const schema = z.object({
  name: z.string(),
  age: z.number().optional(),
});

function appWithValidation() {
  const app = new Hono<{ Variables: { validated: unknown } }>();
  app.onError(errorHandler);
  app.post("/thing", validate(schema), (c) => {
    return c.json({ validated: c.get("validated") });
  });
  return app;
}

describe("validate", () => {
  it("returns 400 for a malformed JSON body", async () => {
    const res = await appWithValidation().request("/thing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not valid json",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("request body must be valid JSON");
  });

  it("returns 400 for an empty/missing body", async () => {
    const res = await appWithValidation().request("/thing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("request body must be valid JSON");
  });

  it("returns 400 with the Zod issues in the message for a schema violation", async () => {
    const res = await appWithValidation().request("/thing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ age: "not-a-number" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    // name is missing and age has the wrong type — both issues should surface.
    expect(body.error).toContain("name");
    expect(body.error).toContain("age");
  });

  it("returns 200 and exposes the parsed value under c.get('validated') for a valid body", async () => {
    const res = await appWithValidation().request("/thing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Budi", age: 30 }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ validated: { name: "Budi", age: 30 } });
  });

  it("strips an extra unexpected key rather than passing it through", async () => {
    const res = await appWithValidation().request("/thing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Budi", extra: "should not survive" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.validated).toEqual({ name: "Budi" });
    expect("extra" in body.validated).toBe(false);
  });
});

const UUID = "8f1c2a5e-1d3b-4a6c-9e0f-2b7d4c6a8e10";

function appWithParamValidation() {
  const app = new Hono<{ Variables: { validatedParams: unknown } }>();
  app.onError(errorHandler);

  const sub = new Hono<{ Variables: { validatedParams: unknown } }>();
  sub.use("*", validateParams(z.object({ communityId: uuidParam })));
  sub.get("/", (c) => c.json({ params: c.get("validatedParams") }));
  sub.patch(
    "/:tierId",
    validateParams(z.object({ communityId: uuidParam, tierId: uuidParam })),
    (c) => c.json({ params: c.get("validatedParams") })
  );

  app.route("/communities/:communityId/tiers", sub);
  return app;
}

describe("validateParams", () => {
  it("returns 400 for a non-UUID path parameter instead of letting it reach the database", async () => {
    const res = await appWithParamValidation().request("/communities/not-a-uuid/tiers");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("communityId");
  });

  it("passes a well-formed parameter through", async () => {
    const res = await appWithParamValidation().request(`/communities/${UUID}/tiers`);
    expect(res.status).toBe(200);
    expect((await res.json()).params).toEqual({ communityId: UUID });
  });

  it("validates a parameter belonging to the route itself, not only the mount path", async () => {
    // A `use("*")` middleware on a mounted sub-app sees only the PARENT's
    // params, so route-level params must be checked on their own route.
    const app = appWithParamValidation();

    const badTier = await app.request(`/communities/${UUID}/tiers/not-a-uuid`, {
      method: "PATCH",
    });
    expect(badTier.status).toBe(400);
    expect((await badTier.json()).error).toContain("tierId");

    const good = await app.request(`/communities/${UUID}/tiers/${UUID}`, { method: "PATCH" });
    expect(good.status).toBe(200);
  });
});
