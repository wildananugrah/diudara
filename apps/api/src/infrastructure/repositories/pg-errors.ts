import { UniqueViolationError, type UniqueRuleName } from "../../application/errors";

/** SQLSTATE for unique_violation. */
const UNIQUE_VIOLATION = "23505";

/**
 * Drizzle wraps driver errors in a `DrizzleQueryError` whose `.cause` is the
 * postgres.js `PostgresError`. Verified shape (bun test probe, 2026-08-08):
 *
 *   err.name              === "Error"            // NOT "DrizzleQueryError"
 *   err.params            === [...bound values]  // ← password hashes live here
 *   err.cause.code        === "23505"
 *   err.cause.constraint_name === "creator_email_unique"
 *
 * Nothing here reads `.params` or the SQL text — only the SQLSTATE and the
 * constraint name, so no bound value can escape through this path.
 */
export function uniqueViolationConstraint(err: unknown): string | null {
  for (let current: unknown = err, depth = 0; current && depth < 5; depth++) {
    const candidate = current as { code?: unknown; constraint_name?: unknown; cause?: unknown };
    if (candidate.code === UNIQUE_VIOLATION) {
      return typeof candidate.constraint_name === "string" ? candidate.constraint_name : "";
    }
    current = candidate.cause;
  }
  return null;
}

/**
 * Rethrows `err` as a `UniqueViolationError` when it is a unique violation on a
 * constraint present in `rules`; otherwise rethrows it untouched.
 *
 * The original error object is never re-exposed for the mapped case — that is
 * deliberate: it carries the failed statement's bound parameters.
 */
export function rethrowUniqueViolation(
  err: unknown,
  rules: Record<string, { rule: UniqueRuleName; message: string }>
): never {
  const constraint = uniqueViolationConstraint(err);
  if (constraint !== null) {
    const mapped = rules[constraint];
    if (mapped) {
      throw new UniqueViolationError(mapped.rule, mapped.message);
    }
  }
  throw err;
}
