import type {
  CreateInvoiceInput,
  CreateInvoiceResult,
  PaymentProviderPort,
} from "../../application/ports/payment-provider.port";

/**
 * In-memory payment provider for tests and local development.
 * Records every call so tests can assert that invoices are charged to the
 * CREATOR's account and never to a platform account.
 */
export class FakePaymentAdapter implements PaymentProviderPort {
  readonly invoices: CreateInvoiceInput[] = [];
  readonly accounts: { creatorId: string; accountId: string }[] = [];
  failNextInvoice = false;

  async createPaymentAccount(input: {
    creatorId: string;
    email: string;
    name: string;
  }): Promise<{ accountId: string }> {
    const accountId = `fake-acct-${this.accounts.length + 1}-${input.creatorId}`;
    this.accounts.push({ creatorId: input.creatorId, accountId });
    return { accountId };
  }

  async createInvoice(input: CreateInvoiceInput): Promise<CreateInvoiceResult> {
    if (this.failNextInvoice) {
      this.failNextInvoice = false;
      throw new Error("fake payment provider: createInvoice failed");
    }
    this.invoices.push(input);
    const invoiceId = `fake-inv-${this.invoices.length}`;
    return { invoiceId, invoiceUrl: `https://fake-checkout.local/${invoiceId}` };
  }
}
