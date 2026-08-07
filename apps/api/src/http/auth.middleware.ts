import type { Context, Next } from "hono";
import { UnauthorizedError } from "../application/errors";
import type { TokenIssuerPort } from "../application/ports/token-issuer.port";

export interface AuthVariables {
  creatorId: string;
  validated: unknown;
}

const BEARER_PREFIX = "Bearer ";

export function requireAuth(tokens: TokenIssuerPort) {
  return async (c: Context, next: Next) => {
    const header = c.req.header("Authorization");
    if (!header || !header.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedError("missing bearer token");
    }

    const payload = await tokens.verify(header.slice(BEARER_PREFIX.length));
    if (!payload) {
      throw new UnauthorizedError("invalid or expired token");
    }

    c.set("creatorId", payload.creatorId);
    await next();
  };
}
