export interface PasswordResetTokenRecord {
  id: string;
  userId: string;
  /** sha256 hex digest of the token that was sent. NEVER the plaintext — see `domain/reset-token.ts`. */
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

export interface PasswordResetRepositoryPort {
  /**
   * Inserts a fresh token row. `tokenHash` only — this port has no method
   * that takes or returns the plaintext token, which is the whole point:
   * there is no code path by which the plaintext could reach storage even
   * by mistake.
   */
  create(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    /** Hashed, or `null` when the caller had no client IP to hash. */
    requestIpHash: string | null;
  }): Promise<PasswordResetTokenRecord>;

  /** Looks up a token by its hash — the only way in, since no plaintext is ever stored. */
  findByHash(tokenHash: string): Promise<PasswordResetTokenRecord | null>;

  /**
   * How many tokens THIS USER has had issued since `since` — the per-account
   * half of `RequestPasswordReset`'s rate limit. Backed by
   * `password_reset_user_created_idx`.
   */
  countForUserSince(userId: string, since: Date): Promise<number>;

  /**
   * How many tokens have been issued from THIS IP hash since `since` — the
   * per-IP half of the rate limit. Backed by `password_reset_ip_created_idx`.
   */
  countForIpSince(ipHash: string, since: Date): Promise<number>;

  /**
   * Marks exactly this token used, but ONLY if it is still unused — the
   * predicate is IN the UPDATE, not read first, the same conditional-update
   * shape `DrizzleJoinRequestRepository.decide` uses. Returns whether a row
   * was actually changed: `false` means this token was already used (a
   * concurrent completion of the SAME token won the race), which
   * `CompletePasswordReset` treats as the identical invalid-token failure.
   */
  markUsed(id: string): Promise<boolean>;

  /**
   * Marks every OTHER outstanding (unused) token for this user used, and
   * returns how many rows that affected. This is the sweep that makes a
   * completed reset invalidate every reset link still sitting in an inbox,
   * not just the one that was clicked.
   */
  markAllOtherOutstandingUsed(userId: string, exceptId: string): Promise<number>;
}
