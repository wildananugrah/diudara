import { sign, verify } from "hono/jwt";
import type {
  UserTokenIssuerPort,
  UserTokenPayload,
} from "../../application/ports/user-token-issuer.port";

const ALGORITHM = "HS256";
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

/**
 * Token type discriminator, stamped on issue and REQUIRED on verify.
 *
 * It existed because two issuers shared the SAME `JWT_SECRET`: this one and
 * the creator `HonoJwtTokenIssuer`, which stamped `"creator"`, and this claim
 * was the entire thing separating the two sessions. Retire-telegram Task 7's
 * fix round deleted that issuer with the creator login it served, so there is
 * one audience left — AND THE CLAIM STAYS, for the rule it encodes rather
 * than for the sibling that is gone: every issuer sharing a secret must stamp
 * its own `typ`, and every verifier must require its own. What it says now is
 * "this secret may sign more than sessions; only a session is accepted here".
 * `user-auth.middleware.test.ts` still proves it, forging the other shape.
 */
const TOKEN_TYPE = "user";

/**
 * The one token issuer this process has. It was written to mirror the creator
 * `HonoJwtTokenIssuer` field for field, differing in `typ: "user"` and in
 * carrying a `sessionEpoch` claim that issuer had no equivalent of — a
 * creator session had no password-reset-driven revocation mechanism, a user
 * session does (see `UserTokenPayload`'s own docstring). Retire-telegram
 * Task 7's fix round deleted the class this mirrored; the shape is unchanged.
 */
export class HonoJwtUserTokenIssuer implements UserTokenIssuerPort {
  constructor(
    private readonly secret: string,
    private readonly ttlSeconds: number = DEFAULT_TTL_SECONDS
  ) {}

  async issue(payload: UserTokenPayload): Promise<string> {
    const exp = Math.floor(Date.now() / 1000) + this.ttlSeconds;
    return sign(
      {
        userId: payload.userId,
        sessionEpoch: payload.sessionEpoch,
        typ: TOKEN_TYPE,
        exp,
      },
      this.secret,
      ALGORITHM
    );
  }

  async verify(token: string): Promise<UserTokenPayload | null> {
    try {
      // hono/jwt throws on bad signature, expiry, or malformed input —
      // and requires the algorithm to be passed explicitly.
      const decoded = await verify(token, this.secret, ALGORITHM);

      // hono/jwt only checks `exp` when the claim is PRESENT. A token with the
      // right signature and no `exp` therefore verifies and grants access
      // forever, with no way to revoke it short of rotating the secret. Treat a
      // missing expiry as invalid rather than as "never expires".
      if (typeof decoded.exp !== "number") {
        return null;
      }

      if (decoded.typ !== TOKEN_TYPE) {
        return null;
      }

      const userId = decoded.userId;
      const sessionEpoch = decoded.sessionEpoch;
      if (typeof userId !== "string" || typeof sessionEpoch !== "number") {
        return null;
      }
      return { userId, sessionEpoch };
    } catch {
      return null;
    }
  }
}
