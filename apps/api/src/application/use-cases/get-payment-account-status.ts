import { NotFoundError } from "../errors";
import {
  isConnectedPaymentAccount,
  isProvisioningPlaceholder,
} from "../../domain/payment-account";
import type { CreatorRepositoryPort } from "../ports/creator-repository.port";

/** `GET /payment-account`'s response — never the raw Xendit account id, only its state. */
export interface PaymentAccountStatus {
  /** True only when `creator.xendit_account_id` names an account money can settle into. */
  connected: boolean;
  /** True while a `POST /payment-account` from this or another device is in flight. */
  provisioning: boolean;
}

/**
 * `GET /payment-account` — whether the AUTHENTICATED creator has connected
 * payments.
 *
 * Closes a gap `POST /payment-account` left open: `creator.xendit_account_id`
 * never reached a client, so the dashboard recorded what each BROWSER had
 * observed in `localStorage` (see apps/web's `paymentAccount.ts`) — a creator
 * who connected on a laptop still looked unconnected on their phone. This
 * reads the column the two states above were always derived from
 * (`isConnectedPaymentAccount` / `isProvisioningPlaceholder`, the same
 * predicates `StartCheckout` and `CreatePaymentAccount` use), so the answer is
 * the server's truth rather than one device's memory.
 *
 * Read-only, on purpose: this is what makes it safe to call on every page
 * load, unlike `POST /payment-account`, which provisions a Xendit KYC entity
 * with no delete endpoint. Never probe the POST route to find this out.
 */
export class GetPaymentAccountStatus {
  constructor(private readonly creators: CreatorRepositoryPort) {}

  async execute(creatorId: string): Promise<PaymentAccountStatus> {
    const creator = await this.creators.findById(creatorId);
    if (!creator) {
      throw new NotFoundError("creator not found");
    }
    return {
      connected: isConnectedPaymentAccount(creator.xenditAccountId),
      provisioning: isProvisioningPlaceholder(creator.xenditAccountId),
    };
  }
}
