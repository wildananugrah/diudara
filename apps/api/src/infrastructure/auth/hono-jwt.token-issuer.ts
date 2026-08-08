import { sign, verify } from "hono/jwt";
import type {
  TokenIssuerPort,
  TokenPayload,
} from "../../application/ports/token-issuer.port";

const ALGORITHM = "HS256";
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

/**
 * Token type discriminator. Phase 3 signs member checkout links and payment
 * webhook tokens with the SAME JWT_SECRET; without this claim, any of those
 * that happened to carry a `creatorId`-shaped field would verify here and be
 * accepted as a creator session. Every issuer sharing the secret must stamp its
 * own `typ`, and every verifier must require its own.
 */
const TOKEN_TYPE = "creator";

export class HonoJwtTokenIssuer implements TokenIssuerPort {
  constructor(
    private readonly secret: string,
    private readonly ttlSeconds: number = DEFAULT_TTL_SECONDS
  ) {}

  async issue(payload: TokenPayload): Promise<string> {
    const exp = Math.floor(Date.now() / 1000) + this.ttlSeconds;
    return sign(
      { creatorId: payload.creatorId, typ: TOKEN_TYPE, exp },
      this.secret,
      ALGORITHM
    );
  }

  async verify(token: string): Promise<TokenPayload | null> {
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

      const creatorId = decoded.creatorId;
      if (typeof creatorId !== "string") {
        return null;
      }
      return { creatorId };
    } catch {
      return null;
    }
  }
}
