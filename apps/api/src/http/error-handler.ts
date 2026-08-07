import type { Context } from "hono";
import { AppError } from "../application/errors";

export function errorHandler(err: Error, c: Context): Response {
  if (err instanceof AppError) {
    // No cast needed: AppError.status is typed as Hono's ContentfulStatusCode.
    return c.json({ error: err.message }, err.status);
  }

  // Never surface an unexpected error's message — it may contain connection
  // strings, secrets, or internal paths.
  console.error("unhandled error:", err);
  return c.json({ error: "internal server error" }, 500);
}
