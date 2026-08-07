export interface TokenPayload {
  creatorId: string;
}

export interface TokenIssuerPort {
  issue(payload: TokenPayload): Promise<string>;
  /** Returns null for any invalid token: bad signature, expired, or malformed. */
  verify(token: string): Promise<TokenPayload | null>;
}
