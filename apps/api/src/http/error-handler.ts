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
  // strings, secrets, or internal paths. And never log the error OBJECT: a
  // Drizzle `DrizzleQueryError` carries `.params`, the bound parameters of the
  // failed statement, which for an insert into `creator` is the argon2id
  // password hash. `console.error("...", err)` printed that to stderr, breaking
  // "password hashes never leave the repository layer" via the log instead of
  // the response body. Only the error's name and a sanitised first line go out.
  console.error(`unhandled error: ${err?.name ?? "Error"}: ${safeSummary(err?.message)}`);
  return c.json({ error: "internal server error" }, 500);
}

const MAX_LOGGED_MESSAGE_LENGTH = 200;

/**
 * The first line of `message`, with anything from a `params:` marker onwards
 * removed, truncated to a fixed length.
 *
 * Drizzle formats its message as `Failed query: <sql>\nparams: <values>`, so
 * taking the first line already drops the bound values. The `params:` cut and
 * the truncation are defence in depth: a driver that puts values on the first
 * line, or an enormous statement, still cannot fill the log.
 */
function safeSummary(message: unknown): string {
  if (typeof message !== "string" || message.length === 0) {
    return "(no message)";
  }
  const firstLine = message.split("\n", 1)[0]!;
  const beforeParams = firstLine.split(/\bparams:/i, 1)[0]!.trimEnd();
  return beforeParams.length > MAX_LOGGED_MESSAGE_LENGTH
    ? `${beforeParams.slice(0, MAX_LOGGED_MESSAGE_LENGTH)}… (truncated)`
    : beforeParams;
}
