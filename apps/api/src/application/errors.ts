import type { ContentfulStatusCode } from "hono/utils/http-status";

export class AppError extends Error {
  constructor(message: string, readonly status: ContentfulStatusCode) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message = "invalid request") {
    super(message, 400);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "unauthorized") {
    super(message, 401);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "not found") {
    super(message, 404);
  }
}

export class ConflictError extends AppError {
  constructor(message = "already exists") {
    super(message, 409);
  }
}

export class UnsupportedOperationError extends AppError {
  constructor(message = "operation not supported by this provider") {
    super(message, 409);
  }
}

/**
 * The AI co-builder's daily spend cap (Phase 7) was already reached for this
 * creator. Carries `resetAt` — an ISO-8601 UTC instant — as a typed field
 * rather than only inside `message`, so `errorHandler` can put it in the
 * response body as its own key and a caller (the dashboard) never has to
 * parse a timestamp out of human prose. `message` still carries a
 * human-readable Indonesian sentence with the same instant baked in, for any
 * caller that only reads `error`.
 */
export class RateLimitedError extends AppError {
  constructor(message: string, readonly resetAt: string) {
    super(message, 429);
  }
}

/**
 * The AI co-builder is not configured on this box — `Dependencies.
 * sendAiMessage` is `undefined` (see `selectAiProvider` in bootstrap.ts).
 * Unlike a 404/409/etc, this is never the caller's fault: the same request
 * would succeed on a fully configured box. `GET /ai/status` lets the
 * dashboard avoid ever reaching this by hiding the chat screen instead.
 */
export class ServiceUnavailableError extends AppError {
  constructor(message = "service unavailable") {
    super(message, 503);
  }
}

/**
 * The AI provider failed twice in a row — the malformed-output or
 * timeout/5xx `AiProviderError` SendAiMessage's retry-once policy could not
 * recover from (see send-ai-message.ts). 502, not 500: this box is fine, the
 * upstream model provider is what failed. The conversation is left exactly
 * as it was before the call — the creator's message is saved, no assistant
 * reply is appended — so retrying is just sending another message.
 */
export class AiUpstreamError extends AppError {
  constructor(message = "AI provider error") {
    super(message, 502);
  }
}

/**
 * How far a gating-provider call got before it failed.
 *
 *  - `"rejected"`      — the provider ANSWERED and the answer was a failure (a non-2xx
 *    status, or a 2xx body that explicitly says the method failed), or the call was
 *    refused locally and never left this process. Either way the provider created
 *    NOTHING: no invite link exists that we do not hold.
 *  - `"indeterminate"` — the request never completed, or completed unreadably: an
 *    abort, a timeout, a reset connection, or a success body whose shape we cannot
 *    parse. A credential may exist at the provider that nobody holds.
 *
 * The distinction is load-bearing rather than cosmetic. `GrantChannelAccess` writes
 * the mint marker (`link_minted_at` / `mint_lease_until`) in the same statement as the
 * claim, BEFORE `grantAccess` is called, and once set it permanently forbids minting
 * for that (member, channel) — see THE CREDENTIAL-LIFECYCLE INVARIANT. Whether the
 * marker may be released after a failure turns on exactly one question: can we prove
 * the provider created nothing? A `"rejected"` failure proves it; an
 * `"indeterminate"` one cannot, and must fail closed.
 *
 * Measured with no distinction at all — every `grantAccess` failure keeping the marker
 * — one transient Telegram 5xx followed by a healthy provider left a PAYING MEMBER
 * PERMANENTLY UNGRANTABLE: 5 retries minted nothing, the outbox row failed, and three
 * later `execute` calls all reported `mint_lost`. Nothing but a `revoke` could clear
 * it, and there is no reissue tool.
 */
export type ProviderCallOutcome = "rejected" | "indeterminate";

/**
 * A messaging-provider call failed, carrying WHETHER A RESPONSE WAS RECEIVED.
 *
 * The adapter that made the request is the only thing that knows, so the adapter has
 * to say — and it has to say it in a typed field. Sniffing an error MESSAGE for
 * "timeout" or "abort" would be guesswork about a string that varies by runtime and by
 * proxy, deciding whether a paying member can ever be granted access again.
 *
 * Extends `Error` and NOT `AppError`, deliberately: a provider failure is not an HTTP
 * status this API returns. `AppError` would map it to a chosen response code in
 * `errorHandler`, and these errors travel the outbox worker's path where the correct
 * behaviour is a retry, not a status. The message never carries a request, a response
 * body, or a URL — the bot token is part of every Bot API request path.
 */
export class ProviderCallError extends Error {
  constructor(
    message: string,
    readonly outcome: ProviderCallOutcome,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * Reads a caught error's provider outcome, defaulting to `"indeterminate"`.
 *
 * The default is the whole point: FAIL CLOSED IS REACHED BY NOT KNOWING. Anything
 * that is not a `ProviderCallError` — a bug in an adapter, a third-party throw, a
 * provider we have not taught to classify — is ambiguous by definition, so it keeps
 * the mint marker set. Only an adapter that positively asserts "the provider answered
 * me and said no" gets the window reopened.
 */
export function providerCallOutcome(err: unknown): ProviderCallOutcome {
  return err instanceof ProviderCallError ? err.outcome : "indeterminate";
}

/**
 * Storage-agnostic names for the uniqueness rules the application reasons about.
 * Repository adapters translate their backing store's constraint names into
 * these, so use-cases never learn a Postgres constraint identifier.
 */
export const UniqueRule = {
  creatorEmail: "creator_email",
  communitySlug: "community_slug",
  channelPlatformGroup: "channel_platform_group",
} as const;

export type UniqueRuleName = (typeof UniqueRule)[keyof typeof UniqueRule];

/**
 * A uniqueness constraint was violated by the DATABASE, not by a pre-check.
 * The database is the only source of truth for uniqueness — a read-then-write
 * pre-check is always a TOCTOU race under concurrency — so repositories raise
 * this from the failed write and callers decide whether to retry (slug
 * allocation) or surface a 409 (duplicate email, duplicate group).
 *
 * It extends ConflictError so that an uncaught one still maps to 409 rather
 * than reaching the unhandled-error path, where the driver's error object
 * would carry the bound parameters of the failed statement.
 */
export class UniqueViolationError extends ConflictError {
  constructor(readonly rule: UniqueRuleName, message = "already exists") {
    super(message);
  }
}
