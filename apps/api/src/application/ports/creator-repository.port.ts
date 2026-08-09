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
   * Claims the creator's EMPTY `xendit_account_id` by writing
   * `XENDIT_ACCOUNT_PROVISIONING` into it, before any provider call happens.
   *
   * Returns **true** only when this call was the one that filled it, and false
   * when the column already held anything — a real account id, or another
   * caller's sentinel. The implementation MUST make that decision in a single
   * conditional UPDATE (`where id = ? and xendit_account_id is null`) and report
   * the affected row count; a `findById` in the use-case is a check-then-act and
   * cannot arbitrate it. Probed before the column became conditional at all: 5
   * concurrent `POST /payment-account` requests with one bearer token returned
   * 201 five times and the last writer won nondeterministically.
   *
   * The reason the CLAIM is separate from the write of the real id is the
   * external side effect. With only "set it once you have the id", every
   * concurrent caller had to create a provider sub-account before it could find
   * out it had lost — 30 concurrent requests produced 30 Xendit sub-accounts, 29
   * of them permanently orphaned (there is no delete endpoint for MANAGED
   * accounts). Claiming first means a loser returns 409 having called nobody.
   */
  beginXenditAccountProvisioning(id: string): Promise<boolean>;
  /**
   * Replaces this caller's sentinel with the real account id, in one conditional
   * UPDATE predicated on the column still holding
   * `XENDIT_ACCOUNT_PROVISIONING`.
   *
   * Returns false when it does not — which, since only the sentinel holder ever
   * writes here, means someone edited the column by hand. The caller must then
   * report the account it created as orphaned rather than claim success: an
   * unconditional write would silently redirect a creator's funds to an account
   * they never connected.
   */
  finishXenditAccountProvisioning(id: string, accountId: string): Promise<boolean>;
  /**
   * Releases this caller's sentinel back to NULL, predicated on the column still
   * holding it.
   *
   * Called when the provider call FAILS. Without it a single Xendit timeout would
   * wedge the creator forever: the sentinel would keep every later attempt from
   * claiming the row, and there is no operator-facing reset path for this column.
   * Concurrency is not reopened by it — a losing caller never gets far enough to
   * release anything, because it never held the sentinel.
   */
  abandonXenditAccountProvisioning(id: string): Promise<boolean>;
}
