import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { AppError, RateLimitedError } from "../application/errors";
import { redactLinks, safeErrorSummary } from "../application/log-safety";

export function errorHandler(err: Error, c: Context): Response {
  if (err instanceof AppError) {
    // RateLimitedError carries a machine-readable `resetAt` alongside the
    // human message, so the dashboard can format "coba lagi pukul ..." itself
    // rather than parsing a timestamp out of prose (design spec §10, plan
    // Task 5/7: "429 renders as ... with the reset time — not a generic
    // error").
    if (err instanceof RateLimitedError) {
      return c.json({ error: err.message, resetAt: err.resetAt }, err.status);
    }
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
  console.error(`unhandled error: ${err?.name ?? "Error"}: ${safeSummary(err)}`);
  return c.json({ error: "internal server error" }, 500);
}

const MAX_LOGGED_MESSAGE_LENGTH = 200;

/**
 * One log-safe line for an unexpected error: the cause chain summarised, invite
 * links and tokens redacted, then truncated.
 *
 * SYMMETRICAL WITH `ProcessOutbox` BY CONSTRUCTION — both now call
 * `redactLinks(safeErrorSummary(err))`, and that is the point. This guard used to
 * apply `firstLineWithoutParams` to `err.message` alone, so it differed from the
 * worker's in two ways that both mattered:
 *
 *   - it did not walk `.cause`, so a drizzle `DrizzleQueryError` logged its SQL
 *     statement and threw away the constraint violation behind it;
 *   - it did not apply `redactLinks`, so a provider error that interpolated an
 *     invite link (or a Bot API URL, which carries the bot token in its PATH) put
 *     that credential straight into the API's log.
 *
 * Two processes log the same errors and the rule must not drift between them. The
 * truncation stays local: this caller has no `outbox.last_error` column to fill, so
 * it is stricter than the worker's.
 */
function safeSummary(err: unknown): string {
  if (!(err instanceof Error)) {
    return "(no message)";
  }
  const summary = redactLinks(safeErrorSummary(err));
  return summary.length > MAX_LOGGED_MESSAGE_LENGTH
    ? `${summary.slice(0, MAX_LOGGED_MESSAGE_LENGTH)}… (truncated)`
    : summary;
}
