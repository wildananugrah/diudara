import type { ContentfulStatusCode } from "hono/utils/http-status";

export class AppError extends Error {
  /**
   * **An optional MACHINE-READABLE reason, sent as `code` beside `error` and
   * meant to be branched on rather than parsed out of the message.**
   *
   * Added by the final whole-branch review for `POST /users/media`, whose four
   * distinct 400s were indistinguishable on the wire — so the web client
   * inferred the reason from the bare status and described a 45-megapixel photo
   * as an unsupported iPhone format. `message` stays the human sentence and
   * `code` stays the protocol token; nothing ever shows a code to anybody.
   *
   * Undefined on every error that has no need for one, and `errorHandler` omits
   * the key entirely then — an existing response body does not grow a `code:
   * null` it never had.
   */
  readonly code?: string;

  constructor(message: string, readonly status: ContentfulStatusCode, code?: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class ValidationError extends AppError {
  constructor(message = "invalid request", code?: string) {
    super(message, 400, code);
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

export class ForbiddenError extends AppError {
  constructor(message = "forbidden") {
    super(message, 403);
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
 * A rate limit was already reached for this caller. Carries `resetAt` — an
 * ISO-8601 UTC instant — as a typed field rather than only inside `message`,
 * so `errorHandler` can put it in the response body as its own key and a
 * caller never has to parse a timestamp out of human prose. `message` still
 * carries a human-readable Indonesian sentence with the same instant baked
 * in, for any caller that only reads `error`.
 *
 * NOTHING RAISES IT TODAY. Its only raiser was the AI co-builder's daily
 * spend cap (Phase 7), which retire-telegram Task 4 deleted. The class and
 * `errorHandler`'s 429 branch are kept deliberately: the branch is the only
 * thing in this codebase that knows how to shape a 429 body, it is still
 * covered by `error-handler.test.ts`, and it is what the next rate limit will
 * be built on. If that never comes, it is one class and one `instanceof` to
 * remove — but removing it now would delete a tested behaviour to save
 * nothing.
 */
export class RateLimitedError extends AppError {
  constructor(message: string, readonly resetAt: string) {
    super(message, 429);
  }
}

/**
 * "This feature is not configured on THIS BOX" — the only trigger left after
 * retire-telegram Task 4 deleted the AI co-builder, which contributed the
 * other one (a provider that answered with a transport-level failure).
 *
 * Raised where a `Dependencies` field is `undefined`/`null` because the
 * environment did not configure the feature: payments
 * (`POST /payment-account`, `POST /users/me/payout`,
 * `POST /users/:handle/subscribe`) and streaming (`POST /streams`,
 * `POST /streams/:id/watch-token`). Unlike a 404/409/etc this is never the
 * caller's fault — the same request would succeed on a fully configured box —
 * which is why it is a 503 and not a 400.
 */
export class ServiceUnavailableError extends AppError {
  constructor(message = "service unavailable") {
    super(message, 503);
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
 *
 * PHASE 1 ("communities-core") removed `creatorEmail`, `communitySlug`,
 * `channelPlatformGroup` and `subscriptionMemberTierActive`: nothing can raise
 * them once `creator`, `community`, `channel` and `subscription` are dropped.
 *
 * `communitySlug` WILL BE NEEDED AGAIN. A later task in this phase creates a
 * new `community` table with its own slug-uniqueness constraint, and that is
 * NOT this rule — do not re-add it under this name pre-emptively; add a fresh
 * entry once the new constraint exists and its real Postgres name is known.
 */
export const UniqueRule = {
  /** `app_user_handle_unique` — the handle a user picked at signup. */
  userHandle: "user_handle",
  /** `app_user_email_unique` — the email a user signed up with. */
  userEmail: "user_email",
  /**
   * `user_stream_one_live` — the PARTIAL unique index on `user_stream`
   * (`owner_id`, `WHERE status = 'live'`): one live broadcast per person,
   * arbitrated by the database. `DrizzleUserStreamRepository.startLive` is
   * a bare INSERT, so nothing upstream can see in advance whether the owner
   * already holds a `live` row before attempting it. (This once cited
   * `subscriptionMemberTierActive` as the same shape; Phase 1 removed that
   * rule with the table it named.)
   */
  userStreamOneLive: "user_stream_one_live",
  /**
   * `user_subscription_one_active` — at most one active `user_subscription`
   * per (subscriber, owner). Task 5 of "free memberships":
   * `DrizzleUserSubscriptionRepository.approveFreeRequest` is an UPDATE that
   * flips a PENDING free request to `active`, and nothing upstream can see in
   * advance whether the same subscriber already holds a DIFFERENT active row
   * for this owner (a pending free request survives alongside an existing
   * active membership, since they are different rows) — same shape as
   * `userStreamOneLive` above, an INSERT-shaped race turned into a
   * conditional write that can still collide with a partial unique index.
   */
  userSubscriptionOneActive: "user_subscription_one_active",
  /**
   * `community_slug_unique` — a community's URL slug.
   *
   * This is NOT the `communitySlug` rule Phase 1 removed from this object.
   * That one named a constraint on the dropped `creator`-owned `community`
   * table; this one names the constraint on the `app_user`-owned table that
   * replaced it, whose real Postgres name (migration 0035) is
   * `community_slug_unique`. `DrizzleCommunityRepository.create` derives the
   * slug from the submitted name and inserts, so two people naming a
   * community the same thing at the same moment both pass any application-side
   * check — the index is the only arbiter.
   */
  communitySlug: "community_slug",
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
