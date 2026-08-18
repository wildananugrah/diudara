import { describe, expect, it } from "bun:test";
import { ForbiddenError } from "./errors";

/**
 * Task 2, Step 0: `apps/api/src/application/errors.ts` had no 403 class before
 * this — `ValidationError` (400), `UnauthorizedError` (401), `NotFoundError`
 * (404) and `ConflictError` (409), and nothing in between. A 403 arriving as a
 * 409 is exactly the silent mis-mapping this project has paid for, so this
 * pins the status code directly rather than trusting a route test alone.
 */
describe("ForbiddenError", () => {
  it("maps to HTTP 403", () => {
    expect(new ForbiddenError().status).toBe(403);
  });

  it("defaults to the message 'forbidden'", () => {
    expect(new ForbiddenError().message).toBe("forbidden");
  });

  it("accepts a custom message", () => {
    expect(new ForbiddenError("kiriman ini bukan milik Anda").message).toBe(
      "kiriman ini bukan milik Anda"
    );
  });
});
