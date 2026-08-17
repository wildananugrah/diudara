import { sign, verify } from "hono/jwt";
import type {
  UserTokenIssuerPort,
  UserTokenPayload,
} from "../../application/ports/user-token-issuer.port";

const ALGORITHM = "HS256";
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

/**
 * Token type discriminator. Mirrors `HonoJwtTokenIssuer`'s `TOKEN_TYPE`
 * exactly, but stamped `"user"` instead of `"creator"` — the two token
 * issuers share the SAME `JWT_SECRET`, and this claim is the entire thing
 * separating a creator's session from a user's. Every issuer sharing the
 * secret must stamp its own `typ`, and every verifier must require its own.
 */
const TOKEN_TYPE = "user";

/**
 * Mirrors `HonoJwtTokenIssuer` field for field, with `typ: "user"` and a
 * `sessionEpoch` claim `HonoJwtTokenIssuer` has no equivalent of — a creator
 * session has no password-reset-driven revocation mechanism today, a user
 * session does (see `UserTokenPayload`'s own docstring).
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
