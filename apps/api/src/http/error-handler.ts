import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { AppError } from "../application/errors";

export function errorHandler(err: Error, c: Context): Response {
  if (err instanceof AppError) {
    // No cast needed: AppError.status is typed as Hono's ContentfulStatusCode.
    return c.json({ error: err.message }, err.status);
  }

  // Hono itself (and its built-ins like bodyLimit / basicAuth) throws
  // HTTPException with a deliberate status. Without this branch it would
  // fall through to the generic 500 below, silently discarding that status.
  if (err instanceof HTTPException) {
    return err.getResponse();
  }

  // Never surface an unexpected error's message — it may contain connection
  // strings, secrets, or internal paths.
  console.error("unhandled error:", err);
  return c.json({ error: "internal server error" }, 500);
}
