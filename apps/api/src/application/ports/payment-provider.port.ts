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
