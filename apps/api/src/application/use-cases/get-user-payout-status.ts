import { NotFoundError } from "../errors";
import {
  isConnectedPaymentAccount,
  isProvisioningPlaceholder,
} from "../../domain/payment-account";
import type { UserPayoutRepositoryPort } from "../ports/user-payout-repository.port";

/** `GET /users/me/payout`'s answer — never the raw account id, only its state. */
export interface UserPayoutStatus {
  /** True only when `app_user.xendit_account_id` names an account money can settle into. */
  connected: boolean;
  /** True while a connect attempt from this or another device holds the claim. */
  provisioning: boolean;
}

/**
 * THE ONLY WAY THIS COLUMN IS EVER INTERPRETED. Both the reader below and
 * `ConnectUserPayout` go through here, so neither can drift into the truthiness
 * check that the sentinel makes wrong: `Boolean("provisioning:in-progress")` is
 * `true`, and a caller that believed it would hand
 * `for_account_id: "provisioning:in-progress"` to Xendit — charging a subscriber
 * against an account that does not exist. The predicates are
 * `domain/payment-account.ts`'s, shared with the creator flow rather than
 * re-implemented.
 */
export function payoutStatusOf(xenditAccountId: string | null): UserPayoutStatus {
  return {
    connected: isConnectedPaymentAccount(xenditAccountId),
    provisioning: isProvisioningPlaceholder(xenditAccountId),
  };
}

/**
 * `GET /users/me/payout` — whether the authenticated user can be paid yet.
 *
 * Read-only, and that is the point: it is safe to call on every page load,
 * unlike `ConnectUserPayout`, which provisions a KYC entity at the provider that
 * has no delete endpoint. Never probe the POST route to find this out.
 *
 * Separate from `ConnectUserPayout` rather than a second method on it, because
 * it must keep working on a box with NO payment provider configured: that box
 * has no `ConnectUserPayout` to construct at all (see `bootstrap.ts`), and Task
 * 4's publish screen still has to be able to ask, and be told, that this user is
 * not connected. The creator flow separates `GetPaymentAccountStatus` from
 * `CreatePaymentAccount` for exactly the same reason.
 */
export class GetUserPayoutStatus {
  constructor(private readonly users: UserPayoutRepositoryPort) {}

  async execute(userId: string): Promise<UserPayoutStatus> {
    const user = await this.users.findPayoutAccount(userId);
    if (!user) {
      throw new NotFoundError("user not found");
    }
    return payoutStatusOf(user.xenditAccountId);
  }
}
