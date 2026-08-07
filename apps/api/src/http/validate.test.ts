import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { z } from "zod";
import { errorHandler } from "./error-handler";
import { validate } from "./validate";

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
