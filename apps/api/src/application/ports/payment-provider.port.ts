export interface CreateInvoiceInput {
  /** Our transaction id. Xendit echoes it back on the webhook. */
  externalId: string;
  amount: number;
  description: string;
  payerName: string;
  /**
   * OPTIONAL, and absent means "this payer has no number on file" — never an
   * empty string.
   *
   * The community checkout always has one (`startCheckoutSchema` requires it),
   * but `app_user.whatsapp_number` is NULLABLE: signup validates the number
   * with that same regex and then marks it `.optional()`, so a person can hold
   * a personal account, and buy a membership, with an email alone.
   *
   * `""` was the first shape `StartUserSubscription` sent and it was wrong
   * (Phase 5a fix round 1, F1): an empty string is a VALUE that still has to
   * pass the provider's own format validation, and it is a shape nothing in
   * this repository had ever sent. Omitting the field is the documented way to
   * say we do not have one, so the adapter omits `customer.mobile_number`
   * rather than sending it empty.
   */
  payerWhatsappNumber?: string;
  /**
   * The CREATOR's payment-provider account id. Funds settle here, never in a
   * platform account — this is what keeps DIUDARA outside PJP licensing.
   * Required, never optional: there is no valid "charge the platform" case.
   */
  forAccountId: string;
  /**
   * Where the provider sends the payer's BROWSER after a successful payment —
   * our own confirmation page, `<APP_BASE_URL>/c/<slug>/status/<subscriptionId>`.
   *
   * Required, not optional. Task 9 built and tested that page and nothing ever
   * reached it: `CheckoutPage` assigns `window.location.href = invoiceUrl` and
   * discards the `subscriptionId`, no route links to it, and no
   * `success_redirect_url` was sent — so a member who paid was left on the
   * provider's own receipt with no way back into the product. An optional field
   * here would let that happen again silently; a required one makes it a compile
   * error.
   */
  successRedirectUrl: string;
}

export interface CreateInvoiceResult {
  invoiceId: string;
  invoiceUrl: string;
}

export interface CreatePaymentAccountInput {
  /**
   * THE OWNER'S ID — `creator.id` OR `app_user.id`. The name is historical, from
   * when creators were the only owner that could be paid, and it is now wrong:
   * Phase 5a's `ConnectUserPayout` passes an `app_user.id` through this field for
   * a user selling a membership on their own profile.
   *
   * Not renamed on purpose. `creator.xendit_account_id` and everything
   * /dashboard/* reads are frozen, and a rename would edit
   * `create-payment-account.ts` to no functional end. Naming the two owners here
   * is the honest alternative — the field's name was previously its only
   * documentation, and that documentation was false.
   *
   * INERT AT THE PROVIDER, but not unused. `XenditPaymentAdapter` never sends it
   * — only `email` and `public_profile.business_name` cross the wire — while
   * `FakePaymentAdapter` interpolates it into the `fake-acct-N-<id>` ids that
   * every development box and every test then stores in a real column. So it
   * does reach the database, just never Xendit.
   *
   * NEVER JOIN THIS TO `creator`. A lookup keyed on it will silently return
   * nothing for half the owners that pass through here, and "no rows" is exactly
   * the shape a missing creator has.
   */
  creatorId: string;
  /** Becomes the provider account's own email. `app_user.email` is NOT NULL; `creator.email` is not. */
  email: string;
  /** Sent as the sub-account's `public_profile.business_name`. */
  name: string;
}

export interface ExpireInvoiceInput {
  /**
   * The provider's own id for the invoice — `CreateInvoiceResult.invoiceId`, stored
   * as `user_transaction.gateway_reference_id`. NOT the invoice URL: that is the
   * payer-facing page, it must never be logged, and the provider does not accept it
   * as an identifier.
   */
  invoiceId: string;
  /**
   * The CREATOR's provider account — the same `for-user-id` the invoice was created
   * under. Required, never optional: the invoice belongs to that sub-account, and a
   * cancellation sent without it addresses the platform account, where the invoice
   * does not exist. See `CreateInvoiceInput.forAccountId`.
   */
  forAccountId: string;
}

export interface PaymentProviderPort {
  createPaymentAccount(input: CreatePaymentAccountInput): Promise<{ accountId: string }>;

  createInvoice(input: CreateInvoiceInput): Promise<CreateInvoiceResult>;

  /**
   * Kills an invoice at the provider so it can no longer be paid — the third
   * operation this port has ever had, added by the final whole-branch review's I-1.
   *
   * **WHY IT EXISTS.** `SweepStalePendingCheckouts` frees an abandoned checkout's
   * `user_subscription_one_pending` slot after two hours, so the buyer's next tap
   * mints a fresh invoice. Xendit's default invoice lifetime is 24 hours, and before
   * this method nothing cancelled the first one: for the remaining ~22 hours the
   * abandoned link (sitting in the buyer's WhatsApp — spec §7's own example) and the
   * new one were BOTH payable. Paying both is a duplicate charge; the webhook detects
   * it, grants no second membership and logs that a refund is likely owed, and this
   * product has no refund path. So the invoice is cancelled when the row is retired.
   *
   * Returns nothing: there is no useful answer beyond "it did not throw". A failure
   * IS thrown, and `SweepStalePendingCheckouts.cancelInvoiceFor` is where the
   * decision about what that costs is written down — the row is already free by
   * then, so a failure is counted and logged rather than retried.
   *
   * ONLY ever called for an invoice whose subscription this process has just moved
   * OFF `pending`. Never for one that may have been paid.
   */
  expireInvoice(input: ExpireInvoiceInput): Promise<void>;
}
