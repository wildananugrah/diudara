import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { errorHandler } from "./error-handler";
import { ConflictError, NotFoundError, UnauthorizedError, ValidationError } from "../application/errors";

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

  it("maps an unexpected error to 500 without leaking its message", async () => {
    const res = await appThatThrows(new Error("connection string user:password@host")).request("/boom");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "internal server error" });
    expect(JSON.stringify(body)).not.toContain("password@host");
  });
});
