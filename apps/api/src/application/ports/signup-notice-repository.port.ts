/**
 * The rate-limit ledger for `RegisterUser`'s existing-email signup notice —
 * review finding F3. See `signupNotices` in `db/schema.ts` for why this is a
 * table of its own rather than a shared budget with `password_reset_token`.
 */
export interface SignupNoticeRepositoryPort {
  /** How many notices have been sent to this account since `since` — backed by `signup_notice_user_created_idx`. */
  countForUserSince(userId: string, since: Date): Promise<number>;
  /** Records that a notice attempt for this account happened NOW — called before the send, regardless of its outcome. */
  record(userId: string): Promise<void>;
}
