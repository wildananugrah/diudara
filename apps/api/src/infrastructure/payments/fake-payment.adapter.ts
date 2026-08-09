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
  /**
   * Makes the next `createPaymentAccount` throw. Exists so a test can exercise
   * `CreatePaymentAccount`'s release-the-claim path: since Task 7 the creator's
   * row is claimed with a sentinel BEFORE this call, so a provider failure that
   * did not release the claim would wedge the creator permanently.
   */
  failNextPaymentAccount = false;

  async createPaymentAccount(input: {
    creatorId: string;
    email: string;
    name: string;
  }): Promise<{ accountId: string }> {
    if (this.failNextPaymentAccount) {
      this.failNextPaymentAccount = false;
      throw new Error("fake payment provider: createPaymentAccount failed");
    }
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
