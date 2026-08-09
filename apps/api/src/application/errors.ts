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
