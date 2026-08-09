import { ConflictError, NotFoundError } from "../errors";
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
 * The `findById` check below is a courtesy, not the guard: it turns the ordinary
 * "already connected" case into a 409 without an HTTP round trip to the
 * provider. The GUARD is `setXenditAccountId`'s conditional UPDATE, which is the
 * only thing that can arbitrate two simultaneous callers — the same TOCTOU shape
 * Phase 2 fixed for duplicate creator emails, and the one
 * `findOrCreateByWhatsappNumber` handles with an atomic upsert. Probed before
 * this returned a boolean: 5 concurrent requests with one bearer token all
 * returned 201, and which provider account ended up in the column was
 * nondeterministic.
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
    if (creator.xenditAccountId) {
      throw new ConflictError("payment account already connected");
    }
    if (!creator.email) {
      throw new ConflictError("an email address is required to connect payments");
    }

    const { accountId } = await this.payments.createPaymentAccount({
      creatorId: creator.id,
      email: creator.email,
      name: creator.name,
    });

    const claimed = await this.creators.setXenditAccountId(creator.id, accountId);
    if (!claimed) {
      // Someone else filled the column between our read and our write. Reporting
      // success here would tell this caller that `accountId` is the account
      // funds settle into, when the column names a different one.
      //
      // The provider account we just created is now unreferenced. Naming it is
      // the only way an operator can reconcile it against the provider
      // dashboard, and this use-case cannot delete it — Xendit MANAGED
      // sub-accounts are KYC entities with no delete endpoint. Ids only: no
      // email, no name. See DONE_WITH_CONCERNS in the final fix report — closing
      // this window entirely means claiming the row BEFORE the provider call,
      // which needs a provisioning state this phase does not have.
      console.warn(
        `[payments] orphaned provider account: a concurrent request already ` +
          `connected creator=${creator.id}; provider account ${accountId} is now ` +
          `unreferenced and must be reconciled by hand`
      );
      throw new ConflictError("payment account already connected");
    }
    return { xenditAccountId: accountId };
  }
}
