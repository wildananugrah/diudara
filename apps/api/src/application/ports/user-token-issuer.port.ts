/**
 * The user session token's payload. Carries `sessionEpoch` alongside
 * `userId` so `requireUserAuth` can compare it against the CURRENT value on
 * the user's row: a completed password reset bumps that column, and a token
 * issued before the bump must stop working even though its signature is
 * still perfectly valid. See `DrizzleUserRepository.setPasswordAndBumpEpoch`
 * for the write side and `user-auth.middleware.ts` for the read side.
 */
export interface UserTokenPayload {
  userId: string;
  sessionEpoch: number;
}

export interface UserTokenIssuerPort {
  issue(payload: UserTokenPayload): Promise<string>;
  /** Returns null for any invalid token: bad signature, expired, or malformed. */
  verify(token: string): Promise<UserTokenPayload | null>;
}
