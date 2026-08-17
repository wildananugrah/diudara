import type { Context, Next } from "hono";
import { UnauthorizedError } from "../application/errors";
import type { UserRepositoryPort } from "../application/ports/user-repository.port";
import type { UserTokenIssuerPort } from "../application/ports/user-token-issuer.port";

export interface UserAuthVariables {
  userId: string;
  validated: unknown;
  validatedParams: unknown;
}

const BEARER_PREFIX = "Bearer ";

/**
 * Mirrors `requireAuth` (creator sessions), with one addition: it RE-READS
 * the user and compares `sessionEpoch` against the value the token was
 * issued with.
 *
 * That comparison is the entire mechanism by which "a password reset ends
 * all sessions" works. A JWT is stateless and cannot otherwise be revoked
 * short of rotating `JWT_SECRET` (which would log out every user, not just
 * the one who reset). `setPasswordAndBumpEpoch` (Task 5) increments
 * `session_epoch` on a completed reset; any token issued before that bump
 * carries the OLD epoch and is rejected here, even though its signature is
 * still perfectly valid. Skipping this check would make that promise a lie
 * with nothing to signal it — every token would keep verifying forever.
 */
export function requireUserAuth(tokens: UserTokenIssuerPort, users: UserRepositoryPort) {
  return async (c: Context, next: Next) => {
    const header = c.req.header("Authorization");
    if (!header || !header.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedError("missing bearer token");
    }

    const payload = await tokens.verify(header.slice(BEARER_PREFIX.length));
    if (!payload) {
      throw new UnauthorizedError("invalid or expired token");
    }

    const user = await users.findById(payload.userId);
    if (!user || user.sessionEpoch !== payload.sessionEpoch) {
      throw new UnauthorizedError("invalid or expired token");
    }

    c.set("userId", user.id);
    await next();
  };
}
