import { sign, verify } from "hono/jwt";
import type {
  TokenIssuerPort,
  TokenPayload,
} from "../../application/ports/token-issuer.port";

const ALGORITHM = "HS256";
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export class HonoJwtTokenIssuer implements TokenIssuerPort {
  constructor(
    private readonly secret: string,
    private readonly ttlSeconds: number = DEFAULT_TTL_SECONDS
  ) {}

  async issue(payload: TokenPayload): Promise<string> {
    const exp = Math.floor(Date.now() / 1000) + this.ttlSeconds;
    return sign({ creatorId: payload.creatorId, exp }, this.secret, ALGORITHM);
  }

  async verify(token: string): Promise<TokenPayload | null> {
    try {
      // hono/jwt throws on bad signature, expiry, or malformed input —
      // and requires the algorithm to be passed explicitly.
      const decoded = await verify(token, this.secret, ALGORITHM);
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
