import type { Context, Next } from "hono";
import { UnauthorizedError } from "../application/errors";
import type { UserRecord, UserRepositoryPort } from "../application/ports/user-repository.port";
import type { UserTokenIssuerPort } from "../application/ports/user-token-issuer.port";

export interface UserAuthVariables {
  userId: string;
  validated: unknown;
  validatedParams: unknown;
}

const BEARER_PREFIX = "Bearer ";

/**
 * The shared verification path behind both `requireUserAuth` and
 * `resolveViewerId` below: a Bearer token's signature AND its `sessionEpoch`
 * against the user's CURRENT row (see `requireUserAuth`'s own docstring for
 * why the epoch re-read exists). Returns the live `UserRecord` on success,
 * `null` for every failure mode — no header, a non-Bearer scheme, a bad or
 * expired signature, or a stale epoch — with no distinction between them.
 * One function so the two callers can never drift on what counts as "signed
 * in": `requireUserAuth` turns a `null` into a 401, `resolveViewerId` turns
 * it into an anonymous viewer instead.
 */
async function verifyBearerToken(
  c: Context,
  tokens: UserTokenIssuerPort,
  users: UserRepositoryPort
): Promise<UserRecord | null> {
  const header = c.req.header("Authorization");
  if (!header || !header.startsWith(BEARER_PREFIX)) {
    return null;
  }

  const payload = await tokens.verify(header.slice(BEARER_PREFIX.length));
  if (!payload) {
    return null;
  }

  const user = await users.findById(payload.userId);
  if (!user || user.sessionEpoch !== payload.sessionEpoch) {
    return null;
  }
  return user;
}

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
    const user = await verifyBearerToken(c, tokens, users);
    if (!user) {
      throw new UnauthorizedError("invalid or expired token");
    }
    c.set("userId", user.id);
    await next();
  };
}

/**
 * Task 2's `GET /users/by-handle/:handle` is public, yet renders differently
 * for a signed-in viewer — see `PublicUserProfile.viewerFollows`'s own
 * docstring for why `null` (anonymous) and `false` (signed in, not
 * following) must stay distinguishable. This resolves "who, if anyone, is
 * asking" WITHOUT throwing: a missing, malformed, expired or epoch-stale
 * token all resolve to `null`, exactly as a request with no Authorization
 * header at all would — never a 401 from a route that never required a
 * session in the first place.
 */
export async function resolveViewerId(
  c: Context,
  tokens: UserTokenIssuerPort,
  users: UserRepositoryPort
): Promise<string | null> {
  const user = await verifyBearerToken(c, tokens, users);
  return user?.id ?? null;
}
