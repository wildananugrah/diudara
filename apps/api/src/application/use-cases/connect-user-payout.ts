import { ConflictError, NotFoundError } from "../errors";
import { isConnectedPaymentAccount } from "../../domain/payment-account";
import type { UserPayoutRepositoryPort } from "../ports/user-payout-repository.port";
import type { PaymentProviderPort } from "../ports/payment-provider.port";
import { payoutStatusOf, type UserPayoutStatus } from "./get-user-payout-status";

/**
 * Connects ONE app_user to a payment-provider sub-account, once and only once.
 *
 * Nothing in Phase 5a can take money until this has run: a tier cannot be
 * published without it, and an invoice has nowhere to settle. It is also the
 * step with a permanent external side effect, so THE ORDER IS THE WHOLE DESIGN,
 * and it is not the order you would write by hand.
 *
 * The creator flow measured what the obvious order costs. With only two states
 * on the column — NULL and an id — the only way to claim the row was to already
 * HAVE the id, so the provider had to be called first: 30 concurrent requests
 * produced 30 Xendit sub-accounts, 29 of them unreferenced; the same 30 requests
 * sequentially produced 1. A Xendit MANAGED sub-account is a KYC entity with no
 * delete endpoint, so all 29 are permanent. The third state — the sentinel in
 * `domain/payment-account.ts`, shared with that flow and never re-invented here
 * — is what lets the claim happen BEFORE the HTTP call:
 *
 *   1. `findPayoutAccount` — a courtesy, not the guard: it answers the ordinary
 *      "already connected" case without an HTTP round trip.
 *   2. `beginXenditAccountProvisioning` — THE GUARD. One conditional UPDATE, and
 *      the only thing that can arbitrate two simultaneous callers.
 *   3. the provider call, reached ONLY by the caller holding the sentinel.
 *   4. `finishXenditAccountProvisioning` — replaces the sentinel with the real id.
 *
 * IDEMPOTENT, unlike the creator flow's 409. Connecting is a button a user will
 * press twice on a slow connection, and both `/users/me/payout` verbs answer with
 * the same two booleans, so a second press is not an error — it is the current
 * state. What it must never be is a second sub-account, which is what steps 1-4
 * above guarantee it cannot be.
 *
 * A caller that loses the claim is told what the column actually says
 * (`provisioning`, or `connected` if the winner has already finished) having
 * called nobody. That is the entire value of claiming before the HTTP call.
 *
 * The cost of the sentinel, here as there, is that every reader of this column
 * now faces a third state and must refuse it — `payoutStatusOf`, not a
 * truthiness check.
 *
 * `creator.xendit_account_id` is untouched by all of this. An app_user is a
 * different owner; this is a parallel flow, not a generalisation of that one.
 */
export class ConnectUserPayout {
  constructor(
    private readonly users: UserPayoutRepositoryPort,
    private readonly payments: PaymentProviderPort
  ) {}

  async execute(userId: string): Promise<UserPayoutStatus> {
    const user = await this.users.findPayoutAccount(userId);
    if (!user) {
      throw new NotFoundError("user not found");
    }
    if (isConnectedPaymentAccount(user.xenditAccountId)) {
      // Already connected: the idempotent answer, and no provider call. The
      // predicate, not `!== null` — the sentinel must fall through to the claim
      // below, which will refuse it, rather than be reported as connected.
      return payoutStatusOf(user.xenditAccountId);
    }

    if (!(await this.users.beginXenditAccountProvisioning(userId))) {
      // Someone else holds the column: either the sentinel (a connect is in
      // flight elsewhere) or a real id (it finished between the read above and
      // here). Nothing has been created at the provider, which is the entire
      // point of doing this before the HTTP call rather than after it. Re-read so
      // the caller is told the truth rather than this call's stale copy.
      const current = await this.users.findPayoutAccount(userId);
      return payoutStatusOf(current?.xenditAccountId ?? null);
    }

    let accountId: string;
    try {
      ({ accountId } = await this.payments.createPaymentAccount({
        // An app_user id in a field called `creatorId`. The name is historical
        // and NOT a claim that this is a creator — see
        // `CreatePaymentAccountInput`, which now documents that this field is the
        // OWNER's id (`creator.id` or `app_user.id`) and must never be joined to
        // `creator`. Renaming it would edit the frozen creator flow to no
        // functional end.
        creatorId: user.id,
        email: user.email,
        name: user.displayName,
      }));
    } catch (err) {
      // Release the claim, or one provider timeout wedges this user forever:
      // there is no operator-facing reset for this column, so the sentinel would
      // make every later attempt a no-op that reports `provisioning` for good.
      // The release is predicated on the sentinel, so it cannot disturb a row
      // someone else has since connected.
      //
      // The honest caveat, unchanged from the creator flow: a failure we cannot
      // distinguish from a timeout may have created the account anyway, and the
      // retry this release enables would then create a second one. That is a
      // sequential, human-paced duplicate an operator can reconcile — not the
      // 29-per-burst the pre-claim order produced.
      const released = await this.users.abandonXenditAccountProvisioning(userId);
      if (!released) {
        // Ids only. See the orphan log below for why no email and no name.
        console.warn(
          `[payments] provisioning claim could not be released for user=${userId} ` +
            "after the provider call failed — the column no longer holds the sentinel, so " +
            "something else wrote it. Inspect app_user.xendit_account_id by hand."
        );
      }
      throw err;
    }

    if (!(await this.users.finishXenditAccountProvisioning(userId, accountId))) {
      // Unreachable without hand-edited SQL: this caller holds the sentinel, and
      // nothing else writes over one. It is NOT folded into the idempotent path
      // above, because an account really was created here and is now unreferenced
      // — answering `connected: true` would bury a permanent orphan under a
      // success. Naming the provider account is the only way an operator can
      // reconcile it against the provider dashboard, and nothing can delete it:
      // MANAGED sub-accounts are KYC entities with no delete endpoint. Ids only:
      // no email, no display name.
      console.warn(
        `[payments] orphaned provider account: the provisioning claim on user=${userId} ` +
          `was overwritten while the provider call was in flight; provider account ` +
          `${accountId} is now unreferenced and must be reconciled by hand`
      );
      throw new ConflictError("koneksi pembayaran bentrok — hubungi dukungan DIUDARA.");
    }

    return { connected: true, provisioning: false };
  }
}
