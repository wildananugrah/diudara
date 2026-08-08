import type {
  CreateInvoiceInput,
  CreateInvoiceResult,
  PaymentProviderPort,
} from "../../application/ports/payment-provider.port";

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

const DEFAULT_BASE_URL = "https://api.xendit.co";

/**
 * !!! UNVERIFIED AGAINST THE LIVE XENDIT API !!!
 *
 * Written from Xendit's published documentation without an account, so request
 * shapes and error handling are ASSUMPTIONS. The tests below prove the port
 * contract and the split-payment headers — they do NOT prove this works against
 * Xendit. Exercise it against a real sandbox before accepting any real payment,
 * then delete this warning.
 *
 * The two headers are what keep DIUDARA outside PJP licensing:
 *   for-user-id      -> the creator's sub-account; funds settle THERE
 *   with-split-rule  -> routes only DIUDARA's fee to the master account
 * A split rule is created in the Xendit dashboard, so its id is configuration.
 */
export class XenditPaymentAdapter implements PaymentProviderPort {
  private readonly secretKey: string;
  private readonly splitRuleId: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;

  constructor(config: {
    secretKey: string;
    splitRuleId: string;
    baseUrl?: string;
    fetchFn?: FetchFn;
  }) {
    this.secretKey = config.secretKey;
    this.splitRuleId = config.splitRuleId;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchFn = config.fetchFn ?? ((url, init) => fetch(url, init));
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.secretKey}:`).toString("base64")}`;
  }

  async createPaymentAccount(input: {
    creatorId: string;
    email: string;
    name: string;
  }): Promise<{ accountId: string }> {
    const response = await this.fetchFn(`${this.baseUrl}/v2/accounts`, {
      method: "POST",
      headers: {
        Authorization: this.authHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: input.email,
        type: "MANAGED",
        public_profile: { business_name: input.name },
      }),
    });

    const body = await this.readJson(response, "createPaymentAccount");
    return { accountId: String(body.id) };
  }

  async createInvoice(input: CreateInvoiceInput): Promise<CreateInvoiceResult> {
    const response = await this.fetchFn(`${this.baseUrl}/v2/invoices`, {
      method: "POST",
      headers: {
        Authorization: this.authHeader(),
        "Content-Type": "application/json",
        "for-user-id": input.forAccountId,
        "with-split-rule": this.splitRuleId,
      },
      body: JSON.stringify({
        external_id: input.externalId,
        amount: input.amount,
        description: input.description,
        customer: {
          given_names: input.payerName,
          mobile_number: input.payerWhatsappNumber,
        },
      }),
    });

    const body = await this.readJson(response, "createInvoice");
    return { invoiceId: String(body.id), invoiceUrl: String(body.invoice_url) };
  }

  /**
   * Never include the request (which carries the Authorization header) or the
   * raw response body in the thrown message — Phase 2 found credentials
   * reaching logs exactly this way.
   */
  private async readJson(
    response: Response,
    operation: string
  ): Promise<Record<string, unknown>> {
    if (!response.ok) {
      throw new Error(`xendit ${operation} failed with status ${response.status}`);
    }
    return (await response.json()) as Record<string, unknown>;
  }
}
