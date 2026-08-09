export interface CreatorRecord {
  id: string;
  name: string;
  whatsappNumber: string | null;
  email: string | null;
  tierPlan: string;
  xenditAccountId: string | null;
  createdAt: Date;
}

/**
 * The ONLY shape that carries the password hash. Returned exclusively by
 * findCredentialsByEmail, which exists so the login use-case can verify a
 * password without widening CreatorRecord — every other method projects a
 * column list that excludes password_hash entirely.
 * Never return this from an HTTP handler.
 */
export interface CreatorCredentials {
  id: string;
  name: string;
  email: string | null;
  passwordHash: string | null;
}

export interface CreatorRepositoryPort {
  create(input: {
    name: string;
    whatsappNumber?: string;
    email?: string;
    passwordHash?: string;
  }): Promise<CreatorRecord>;
  findById(id: string): Promise<CreatorRecord | null>;
  findByEmail(email: string): Promise<CreatorRecord | null>;
  findCredentialsByEmail(email: string): Promise<CreatorCredentials | null>;
  /**
   * Attempts to claim the creator's empty `xendit_account_id` for `accountId`.
   *
   * Returns **true** only when this call was the one that filled it, and false
   * when the column was already set — including by a concurrent caller that
   * checked at the same time. The implementation MUST make that decision in a
   * single conditional UPDATE (`where id = ? and xendit_account_id is null`) and
   * report the affected row count; a `findById` in the use-case is a
   * check-then-act and cannot arbitrate it. Probed before this became
   * conditional: 5 concurrent `POST /payment-account` requests with one bearer
   * token all returned 201, the last writer won nondeterministically, and every
   * request believed it had connected the account.
   *
   * NOT idempotent on purpose: re-writing the same id would be indistinguishable
   * from overwriting a different one, and this column is what routes member
   * money to a creator. Overwriting it silently redirects funds.
   */
  setXenditAccountId(id: string, accountId: string): Promise<boolean>;
}
