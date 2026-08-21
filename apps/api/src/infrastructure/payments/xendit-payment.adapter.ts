import type {
  CreateInvoiceInput,
  CreateInvoiceResult,
  ExpireInvoiceInput,
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
        // `mobile_number` is included ONLY when we actually have one. Spread
        // rather than `mobile_number: input.payerWhatsappNumber ?? undefined`,
        // so the omission is a decision this code states rather than a side
        // effect of `JSON.stringify` dropping undefined values — see
        // `CreateInvoiceInput.payerWhatsappNumber`.
        customer: {
          given_names: input.payerName,
          ...(input.payerWhatsappNumber === undefined || input.payerWhatsappNumber.length === 0
            ? {}
            : { mobile_number: input.payerWhatsappNumber }),
        },
        // Sends the payer's browser back to OUR confirmation page after paying.
        // Without it the member is stranded on Xendit's receipt — see
        // CreateInvoiceInput.successRedirectUrl.
        success_redirect_url: input.successRedirectUrl,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const body = await this.readJson(response, "createInvoice");
    return {
      invoiceId: this.requireString(body, "id", "createInvoice"),
      invoiceUrl: this.requireUrl(body, "invoice_url", "createInvoice"),
    };
  }

  /**
   * Kills an invoice so it can no longer be paid — the port's own docstring has
   * the money reasoning; this is the wire shape.
   *
   * `POST /invoices/{id}/expire!` — the bang is part of Xendit's documented path,
   * not a typo. It carries **`for-user-id` and no split rule**: the invoice was
   * created against the creator's sub-account, so a cancellation without that
   * header addresses the platform account, where the invoice does not exist and the
   * provider answers "not found" — a silent success for the caller, and an abandoned
   * invoice left payable. `with-split-rule` is about how a PAYMENT is divided and
   * has nothing to say about cancelling one.
   *
   * The id goes into the PATH, encoded: `expireInvoice` is called with a value read
   * out of `user_transaction.gateway_reference_id`, and while that value came from
   * this adapter, a stored `../accounts` would otherwise address a different
   * endpoint entirely. Empty is refused before the request rather than POSTing to
   * the collection endpoint.
   *
   * Returns nothing and reads no body: the only useful answer is "it did not throw".
   * A non-2xx THROWS through `readJson`, and the caller
   * (`SweepStalePendingCheckouts.cancelInvoiceFor`) has already freed the row by
   * then, so it counts and logs the failure rather than retrying — swallowing it
   * here would report a double-charge window as closed while it is open.
   */
  async expireInvoice(input: ExpireInvoiceInput): Promise<void> {
    if (input.invoiceId.length === 0) {
      throw new Error(
        "xendit expireInvoice was given an empty invoice id. Refusing to send it: " +
          "the request would address the invoice COLLECTION rather than one invoice."
      );
    }
    const response = await this.fetchFn(
      `${this.baseUrl}/invoices/${encodeURIComponent(input.invoiceId)}/expire!`,
      {
        method: "POST",
        headers: {
          Authorization: this.authHeader(),
          "Content-Type": "application/json",
          "for-user-id": input.forAccountId,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
    await this.readJson(response, "expireInvoice");
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

  /**
   * `requireString`, plus a scheme check, for a field that ends up in
   * `window.location.href`.
   *
   * `CheckoutPage` assigns the returned `invoiceUrl` straight to
   * `window.location.href`. The source is our own API, so the risk is low — but
   * "low" rests entirely on this adapter, and a `javascript:` or `data:` value in
   * an unrecognised response body would be a stored redirect straight into script
   * execution on our own origin. Asserting the scheme here costs one comparison
   * and means the browser-facing code does not have to trust the provider.
   *
   * `http://` is allowed because local development points the adapter at a stub.
   */
  private requireUrl(
    body: Record<string, unknown>,
    key: string,
    operation: string
  ): string {
    const value = this.requireString(body, key, operation);
    if (!value.startsWith("https://") && !value.startsWith("http://")) {
      throw new Error(
        `xendit ${operation} returned a "${key}" that is not an http(s) URL. ` +
          "It would be assigned to window.location.href, so a javascript: or data: " +
          "value would execute on our own origin. Refusing it."
      );
    }
    return value;
  }
}
