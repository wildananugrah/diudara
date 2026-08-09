/**
 * Two rules that every diagnostic in the gating path goes through, in one place
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
