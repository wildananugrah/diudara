import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { errorHandler } from "./error-handler";
import { ConflictError, NotFoundError, UnauthorizedError, ValidationError } from "../application/errors";
import { db } from "../db/client";
import { creators } from "../db/schema";
import { resetDatabase } from "../db/test-helpers";

/** Runs `fn` with console.error captured, returning everything it wrote. */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => (a instanceof Error ? String(a) : String(a))).join(" "));
  };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines.join("\n");
}

function appThatThrows(err: Error) {
  const app = new Hono();
  app.onError(errorHandler);
  app.get("/boom", () => {
    throw err;
  });
  return app;
}

describe("errorHandler", () => {
  it("maps ValidationError to 400", async () => {
    const res = await appThatThrows(new ValidationError("bad input")).request("/boom");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad input" });
  });

  it("maps UnauthorizedError to 401", async () => {
    const res = await appThatThrows(new UnauthorizedError()).request("/boom");
    expect(res.status).toBe(401);
  });

  it("maps NotFoundError to 404", async () => {
    const res = await appThatThrows(new NotFoundError()).request("/boom");
    expect(res.status).toBe(404);
  });

  it("maps ConflictError to 409", async () => {
    const res = await appThatThrows(new ConflictError("email is already registered")).request("/boom");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "email is already registered" });
  });

  it("preserves Hono's own HTTPException status instead of collapsing it to 500", async () => {
    const res = await appThatThrows(new HTTPException(404, { message: "route not found" })).request(
      "/boom"
    );
    expect(res.status).toBe(404);
  });

  it("preserves a 429 HTTPException, e.g. from a built-in like bodyLimit", async () => {
    const res = await appThatThrows(new HTTPException(429, { message: "too many requests" })).request(
      "/boom"
    );
    expect(res.status).toBe(429);
  });

  it("maps an unexpected error to 500 without leaking its message", async () => {
    const res = await captureStderr(async () => {
      const response = await appThatThrows(
        new Error("connection string user:password@host")
      ).request("/boom");
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body).toEqual({ error: "internal server error" });
      expect(JSON.stringify(body)).not.toContain("password@host");
    });
    expect(res).toContain("unhandled error");
  });

  it("never writes a failed query's bound parameters to the log", async () => {
    // A DrizzleQueryError carries `.params` — the bound values of the failed
    // statement. For an insert into `creator` that includes the argon2id
    // password hash, so `console.error("...", err)` published it to stderr:
    // "password hashes never leave the repository layer", broken via the log.
    await resetDatabase();
    const passwordHash = await Bun.password.hash("supersecret123");
    await db
      .insert(creators)
      .values({ name: "Racer", email: "dup@example.com", passwordHash });

    let dbError: Error | undefined;
    try {
      await db
        .insert(creators)
        .values({ name: "Racer", email: "dup@example.com", passwordHash });
    } catch (err) {
      dbError = err as Error;
    }

    // Pin the premise: without this, the test could pass against an error that
    // never carried the hash in the first place.
    expect(dbError).toBeDefined();
    expect(JSON.stringify((dbError as unknown as { params: unknown }).params)).toContain(
      "$argon2id"
    );

    const logged = await captureStderr(async () => {
      const res = await appThatThrows(dbError!).request("/boom");
      expect(res.status).toBe(500);
    });

    expect(logged).not.toContain("$argon2id");
    expect(logged).not.toContain("dup@example.com");
    expect(logged).toContain("unhandled error");
    await resetDatabase();
  });

  it("truncates a very long first line rather than logging it whole", async () => {
    const logged = await captureStderr(async () => {
      await appThatThrows(new Error("x".repeat(5000))).request("/boom");
    });
    expect(logged).toContain("(truncated)");
    expect(logged.length).toBeLessThan(400);
  });
});
