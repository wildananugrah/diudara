import type {
  CreateInvoiceInput,
  CreateInvoiceResult,
  ExpireInvoiceInput,
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
  /**
   * Every invoice this adapter was asked to KILL, in order — the stale-pending
   * sweep's half of the port (final whole-branch review, I-1). Recorded rather than
   * counted, because "which invoice, and against which sub-account" is exactly what
   * a caller that got the routing wrong would still get past a counter.
   */
  readonly expiredInvoices: ExpireInvoiceInput[] = [];
  /**
   * Makes the next `expireInvoice` throw. One-shot, exactly like `failNextInvoice`:
   * it exists so `SweepStalePendingCheckouts`'s provider-failure path — the row is
   * already free, the invoice is not, count it and keep going — can be exercised
   * without a real provider.
   */
  failNextInvoiceExpiry = false;

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

  async expireInvoice(input: ExpireInvoiceInput): Promise<void> {
    if (this.failNextInvoiceExpiry) {
      this.failNextInvoiceExpiry = false;
      throw new Error("fake payment provider: expireInvoice failed");
    }
    this.expiredInvoices.push(input);
  }
}
