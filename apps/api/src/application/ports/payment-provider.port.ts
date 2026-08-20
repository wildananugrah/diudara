export interface CreateInvoiceInput {
  /** Our transaction id. Xendit echoes it back on the webhook. */
  externalId: string;
  amount: number;
  description: string;
  payerName: string;
  payerWhatsappNumber: string;
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

export interface PaymentProviderPort {
  createPaymentAccount(input: CreatePaymentAccountInput): Promise<{ accountId: string }>;

  createInvoice(input: CreateInvoiceInput): Promise<CreateInvoiceResult>;
}
