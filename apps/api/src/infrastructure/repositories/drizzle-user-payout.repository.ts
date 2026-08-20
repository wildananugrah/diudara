import { and, eq, isNull } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import { appUsers } from "../../db/schema";
import { XENDIT_ACCOUNT_PROVISIONING } from "../../domain/payment-account";
import type {
  UserPayoutAccount,
  UserPayoutRepositoryPort,
} from "../../application/ports/user-payout-repository.port";

/**
 * The three columns the payout flow needs, and nothing else — no password hash,
 * no handle, no bio. Listing them explicitly means the hash is never fetched in
 * the first place, the same rule `DrizzleUserRepository`'s own column lists
 * follow.
 */
const payoutColumns = {
  id: appUsers.id,
  email: appUsers.email,
  displayName: appUsers.displayName,
  xenditAccountId: appUsers.xenditAccountId,
} as const;

/**
 * `app_user.xendit_account_id`, claimed first and filled second.
 *
 * Every write below is ONE conditional UPDATE whose WHERE clause names the state
 * the column must already be in, and the affected row count is the answer. That
 * is the whole design: a read followed by a write is a check-then-act, and a
 * check-then-act cannot arbitrate two simultaneous callers — the creator flow
 * proved it at 30 concurrent requests, which produced 30 Xendit sub-accounts and
 * orphaned 29 of them permanently (MANAGED sub-accounts are KYC entities with no
 * delete endpoint). See `domain/payment-account.ts` and
 * `CreatorRepositoryPort`'s docstrings for the full account.
 *
 * Deliberately its own class over `app_user` rather than three more methods on
 * `DrizzleUserRepository`: this is the only place the payout column is read or
 * written, and `UserRecord` — which is projected into HTTP responses — stays
 * free of a provider account id.
 */
export class DrizzleUserPayoutRepository implements UserPayoutRepositoryPort {
  constructor(private readonly db: DatabaseExecutor) {}

  async findPayoutAccount(userId: string): Promise<UserPayoutAccount | null> {
    const [row] = await this.db
      .select(payoutColumns)
      .from(appUsers)
      .where(eq(appUsers.id, userId))
      .limit(1);
    return row ?? null;
  }

  /** Claims an EMPTY column. `is null` is what makes it exclusive. */
  async beginXenditAccountProvisioning(userId: string): Promise<boolean> {
    const rows = await this.db
      .update(appUsers)
      .set({ xenditAccountId: XENDIT_ACCOUNT_PROVISIONING })
      .where(and(eq(appUsers.id, userId), isNull(appUsers.xenditAccountId)))
      .returning({ id: appUsers.id });
    return rows.length > 0;
  }

  /** Predicated on the sentinel, so it can only ever replace OUR claim. */
  async finishXenditAccountProvisioning(userId: string, accountId: string): Promise<boolean> {
    const rows = await this.db
      .update(appUsers)
      .set({ xenditAccountId: accountId })
      .where(
        and(eq(appUsers.id, userId), eq(appUsers.xenditAccountId, XENDIT_ACCOUNT_PROVISIONING))
      )
      .returning({ id: appUsers.id });
    return rows.length > 0;
  }

  /** Same predicate as `finish`, so it can only ever release OUR claim. */
  async abandonXenditAccountProvisioning(userId: string): Promise<boolean> {
    const rows = await this.db
      .update(appUsers)
      .set({ xenditAccountId: null })
      .where(
        and(eq(appUsers.id, userId), eq(appUsers.xenditAccountId, XENDIT_ACCOUNT_PROVISIONING))
      )
      .returning({ id: appUsers.id });
    return rows.length > 0;
  }
}
