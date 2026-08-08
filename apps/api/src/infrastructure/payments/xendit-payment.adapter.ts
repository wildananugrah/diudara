import type {
  CreateInvoiceInput,
  CreateInvoiceResult,
  PaymentProviderPort,
} from "../../application/ports/payment-provider.port";

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

const DEFAULT_BASE_URL = "https://api.xendit.co";

/**
 * Bare `fetch` has no timeout, so a hung Xendit response would hold a checkout
 * request open indefinitely once StartCheckout (Task 6) calls this. 30s is
 * generous for an invoice creation and still well inside any sane reverse-proxy
 * or load-balancer idle timeout, so the failure surfaces here — with an error we
 * control — rather than as a dropped connection somewhere upstream.
 */
const REQUEST_TIMEOUT_MS = 30_000;

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
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const body = await this.readJson(response, "createPaymentAccount");
    return { accountId: this.requireString(body, "id", "createPaymentAccount") };
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
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const body = await this.readJson(response, "createInvoice");
    return {
      invoiceId: this.requireString(body, "id", "createInvoice"),
      invoiceUrl: this.requireString(body, "invoice_url", "createInvoice"),
    };
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

  /**
   * Reads a field this adapter cannot function without, refusing anything that
   * is not a non-empty string.
   *
   * `String(body.id)` on an unrecognised 200 produced the literal string
   * "undefined" and reported SUCCESS: a 200 with an empty body yielded
   * `{"invoiceId":"undefined","invoiceUrl":"undefined"}`. The buyer would be
   * redirected to the URL "undefined", and Task 7 would store "undefined" as
   * the gateway reference for every such invoice, so they would all collide.
   *
   * This is precisely the failure the UNVERIFIED warning at the top of this
   * file predicts — the real response nesting the invoice under a different
   * key. For an adapter acknowledged as guesswork, failing loudly on a shape it
   * does not recognise is the only safe behaviour.
   *
   * The message names the field and nothing else: no request, no headers, no
   * response body, so the secret key cannot reach a log through here.
   */
  private requireString(
    body: Record<string, unknown>,
    key: string,
    operation: string
  ): string {
    const value = body[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `xendit ${operation} returned a response with no usable "${key}" ` +
          "(expected a non-empty string). The response shape does not match what " +
          "this adapter assumes — see the UNVERIFIED warning in " +
          "xendit-payment.adapter.ts."
      );
    }
    return value;
  }
}
