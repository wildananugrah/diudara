/**
 * The rules that every diagnostic in the gating path goes through, in one place
 * so no call site can forget one.
 *
 * They exist because of things that actually happened in this codebase: Phase 2
 * leaked argon2id hashes through raw error logging, and Phase 3 found payer PII in
 * webhook payloads reaching log lines. Phase 4 adds a credential of its own — an
 * invite link is a bearer token for a paid community.
 */

/**
 * Removes anything URL-shaped from a message.
 *
 * An invite link belongs only in the notification to the member who bought it
 * (plan, Global Constraints) — never in `outbox.last_error`, which an operator
 * reads out of the database, and never in a log line, which reaches a log
 * aggregator. URLs in general rather than just `t.me` links: the Telegram bot
 * token is part of every Bot API request PATH, so any URL from that adapter is a
 * second credential. The surrounding text is kept, so the error stays diagnosable.
 */
export function redactLinks(message: string): string {
  return message.replace(/\b(?:https?|tg|wa):\/\/\S+/gi, "[link redacted]");
}

/**
 * Renders a value safe to appear in a log line: bounded, and stripped of
 * anything outside a conservative identifier set.
 *
 * A newline inside an event type or a status would otherwise forge a second log
 * line, and these lines are what an operator reads when invites are not arriving.
 * This is a LABEL sanitiser, not a redactor — only ever apply it to enum values
 * and our own ids.
 */
export function safeLabel(value: string): string {
  return value.slice(0, 64).replace(/[^A-Za-z0-9_.:-]/g, "?");
}

/**
 * Per-LINK budget, applied before the parts are joined.
 *
 * It is per-link and not only overall because the order is outer-to-inner and the
 * OUTER message is the long, low-value one: drizzle's is the whole SQL statement,
 * while the answer — the constraint violation — is on the cause behind it. A
 * single overall cap truncated the statement and threw the reason away, which is
 * the bug this function exists to fix, restated.
 */
const MAX_ERROR_PART_LENGTH = 120;

/**
 * Overall budget. `outbox.last_error` is varchar(500) and the repository truncates
 * to it, so this leaves room for the `giving up after N attempts: ` prefix rather
 * than letting the reason be cut off by the column.
 */
const MAX_ERROR_SUMMARY_LENGTH = 400;

/** `…` rather than `...`, matching every other truncation in this codebase. */
function clamp(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/**
 * One line of an error message, with the bound parameters of a failed statement
 * removed.
 *
 * Drizzle formats a query failure as `Failed query: <sql>\nparams: <values>`, so
 * taking the first line already drops the values; the `params:` cut is defence in
 * depth for a driver that puts them on the first line. The newline removal is not
 * cosmetic — a multi-line reason forges a second log line, which is the same
 * threat `safeLabel` covers for enum values.
 */
export function firstLineWithoutParams(message: string): string {
  const firstLine = message.split("\n", 1)[0]!;
  return firstLine.split(/\bparams:/i, 1)[0]!.trimEnd();
}

/**
 * Turns anything thrown into ONE log-safe, diagnosable line.
 *
 * WHY THE CAUSE CHAIN IS WALKED. Drizzle wraps every query failure in a
 * `DrizzleQueryError` whose message is the SQL statement and its bound values, and
 * whose `.cause` is the postgres.js `PostgresError` carrying the ONLY thing an
 * operator needs — `duplicate key value violates unique constraint "…"`,
 * `insert or update on table "…" violates foreign key constraint "…"`. Reading the
 * outer message alone therefore did both wrong things at once: it dumped the
 * parameters (`pg-errors.ts`: "← password hashes live here") and it discarded the
 * reason. A running worker did exactly that during Phase 4's end-to-end
 * verification, into both the log and `outbox.last_error`.
 *
 * Only `message` is ever read off a cause. `PostgresError.detail` carries the
 * offending key VALUE (`Key (member_id)=(…) is not present in table "member"`),
 * and `.params` carries every bound value; neither may reach a log line.
 *
 * Callers still apply `redactLinks` — a provider error can interpolate an invite
 * link into its own message, which no amount of cause-walking would remove.
 */
export function safeErrorSummary(err: unknown): string {
  if (!(err instanceof Error)) {
    // Deliberately not the value: a thrown object stringifies to its contents.
    return `non-Error thrown: ${typeof err}`;
  }

  const parts: string[] = [];
  // Bounded: `cause` is attacker-independent but a cycle would hang the worker,
  // and five links is deeper than anything this codebase produces.
  for (let current: unknown = err, depth = 0; current instanceof Error && depth < 5; depth++) {
    const line = clamp(firstLineWithoutParams(current.message), MAX_ERROR_PART_LENGTH);
    // Skipped when it adds nothing: a wrapper that only restates its cause would
    // otherwise spend half of `last_error` saying the same thing twice.
    if (line.length > 0 && !parts.includes(line)) {
      parts.push(line);
    }
    current = current.cause;
  }

  if (parts.length === 0) {
    return `${err.name || "Error"} with no message`;
  }
  return clamp(parts.join(": "), MAX_ERROR_SUMMARY_LENGTH);
}
