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

export interface PaymentProviderPort {
  createPaymentAccount(input: {
    creatorId: string;
    email: string;
    name: string;
  }): Promise<{ accountId: string }>;

  createInvoice(input: CreateInvoiceInput): Promise<CreateInvoiceResult>;
}
