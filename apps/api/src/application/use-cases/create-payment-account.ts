import { ConflictError, NotFoundError } from "../errors";
import {
  isConnectedPaymentAccount,
  isProvisioningPlaceholder,
} from "../../domain/payment-account";
import type { CreatorRepositoryPort } from "../ports/creator-repository.port";
import type { PaymentProviderPort } from "../ports/payment-provider.port";

/**
 * Connects a creator to a payment-provider sub-account, once and only once.
 *
 * `creator.xendit_account_id` is what routes member money to a creator, and it
 * has no reset path — `StartCheckout` reads it, and this use-case 409s on it
 * forever once it is set. So the ONE thing this must never do is let two callers
 * both believe they filled it.
 *
 * THE ORDER IS THE WHOLE DESIGN, and it changed in Task 7. Phase 3 called the
 * provider and then claimed the row with a conditional UPDATE, which closed the
 * DATABASE race but not the EXTERNAL one: every losing caller had already created
 * a Xendit sub-account by the time it found out it had lost. Measured on this
 * branch — 30 concurrent requests → 30 sub-accounts, 29 orphaned; the same
 * requests sequentially → 1. Xendit MANAGED sub-accounts are KYC entities with no
 * delete endpoint, so those 29 are permanent.
 *
 * Now the row is CLAIMED FIRST with a sentinel (see domain/payment-account.ts),
 * so a loser 409s having called nobody:
 *
 *   1. `findById` — a courtesy, not the guard: it turns the ordinary "already
 *      connected" case into a 409 without an HTTP round trip.
 *   2. `beginXenditAccountProvisioning` — THE GUARD. One conditional UPDATE, and
 *      the only thing that can arbitrate two simultaneous callers.
 *   3. the provider call, reached only by the caller holding the sentinel.
 *   4. `finishXenditAccountProvisioning` — replaces the sentinel with the real id.
 *
 * The cost of the sentinel is that `StartCheckout` now sees a third state on that
 * column and must refuse it (`isConnectedPaymentAccount`), because charging a
 * member against the sentinel would send `for_account_id: "provisioning:..."` to
 * Xendit.
 */
export class CreatePaymentAccount {
  constructor(
    private readonly creators: CreatorRepositoryPort,
    private readonly payments: PaymentProviderPort
  ) {}

  async execute(creatorId: string): Promise<{ xenditAccountId: string }> {
    const creator = await this.creators.findById(creatorId);
    if (!creator) {
      throw new NotFoundError("creator not found");
    }
    if (creator.xenditAccountId !== null) {
      throw this.alreadyClaimed(creator.xenditAccountId);
    }
    if (!creator.email) {
      throw new ConflictError("an email address is required to connect payments");
    }

    if (!(await this.creators.beginXenditAccountProvisioning(creator.id))) {
      // Someone else claimed the column between the read above and here. Nothing
      // has been created at the provider, which is the entire point of doing this
      // before the HTTP call rather than after it. Re-read only to word the 409
      // accurately — an operator seeing "connection in progress" on a row that is
      // stuck knows to look at the sentinel.
      const current = await this.creators.findById(creator.id);
      throw this.alreadyClaimed(current?.xenditAccountId ?? null);
    }

    let accountId: string;
    try {
      ({ accountId } = await this.payments.createPaymentAccount({
        creatorId: creator.id,
        email: creator.email,
        name: creator.name,
      }));
    } catch (err) {
      // Release the claim, or one Xendit timeout wedges this creator forever:
      // there is no operator-facing reset for this column, so the sentinel would
      // 409 every later attempt. The release is predicated on the sentinel, so it
      // cannot disturb a row someone else has since connected.
      //
      // The honest caveat: a failure we cannot distinguish from a timeout may have
      // created the account anyway, and the retry this release enables would then
      // create a second one. That is a sequential, human-paced duplicate an
      // operator can reconcile — not the 29-per-burst the pre-claim order
      // produced — and it is strictly better than an unusable creator account.
      const released = await this.creators.abandonXenditAccountProvisioning(creator.id);
      if (!released) {
        // Ids only. See the orphan log below for why no email or name.
        console.warn(
          `[payments] provisioning claim could not be released for creator=${creator.id} ` +
            "after the provider call failed — the column no longer holds the sentinel, so " +
            "something else wrote it. Inspect creator.xendit_account_id by hand."
        );
      }
      throw err;
    }

    if (!(await this.creators.finishXenditAccountProvisioning(creator.id, accountId))) {
      // Unreachable without hand-edited SQL: this caller holds the sentinel, and
      // nothing else writes over one. Kept because reporting success here would
      // tell the caller that `accountId` is where funds settle when the column
      // names something else.
      //
      // Naming the provider account is the only way an operator can reconcile it
      // against the provider dashboard, and this use-case cannot delete it —
      // Xendit MANAGED sub-accounts are KYC entities with no delete endpoint. Ids
      // only: no email, no name.
      console.warn(
        `[payments] orphaned provider account: the provisioning claim on creator=` +
          `${creator.id} was overwritten while the provider call was in flight; provider ` +
          `account ${accountId} is now unreferenced and must be reconciled by hand`
      );
      throw new ConflictError("payment account already connected");
    }
    return { xenditAccountId: accountId };
  }

  /**
   * One 409, worded from the state the column is actually in. The sentinel and a
   * real id are both "you cannot claim this", but only one of them means a human
   * may need to look.
   */
  private alreadyClaimed(xenditAccountId: string | null): ConflictError {
    if (isProvisioningPlaceholder(xenditAccountId)) {
      return new ConflictError("a payment account connection is already in progress");
    }
    if (isConnectedPaymentAccount(xenditAccountId)) {
      return new ConflictError("payment account already connected");
    }
    // The column was NULL when re-read: the winner released its claim after
    // failing. Retrying is the right advice, and it is a 409 either way.
    return new ConflictError("a payment account connection was just attempted — try again");
  }
}
