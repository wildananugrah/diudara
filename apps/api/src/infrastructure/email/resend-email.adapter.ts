import type { EmailProviderPort, SendEmailInput } from "../../application/ports/email-provider.port";

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

const DEFAULT_BASE_URL = "https://api.resend.com";

/**
 * Bare `fetch` has no timeout, so a hung Resend response would hold a
 * password-reset (or, later, any other transactional email) request open
 * indefinitely. Same value and reasoning as `XenditPaymentAdapter`'s.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * !!! UNVERIFIED AGAINST THE LIVE RESEND API !!!
 *
 * Written from Resend's published documentation without an account, so the
 * request shape and error handling are ASSUMPTIONS. The tests beside this
 * file prove the port contract and the secret-handling rule below — they do
 * NOT prove this reaches a real inbox. Exercise it against a real Resend
 * account before a password reset depends on it, then delete this warning.
 *
 * PLAIN TEXT ONLY, deliberately: HTML mail is a rendering and deliverability
 * project of its own (see `SendEmailInput.body`), and every message this
 * adapter sends today is two sentences.
 *
 * SECRET HANDLING: `RESEND_API_KEY` is a bearer credential sent on every
 * request as `Authorization: Bearer <key>`. No thrown error interpolates the
 * request, the headers, or the response body — same rule, and the same
 * reason, as `XenditPaymentAdapter.readJson`: Phase 2 found a credential
 * reaching a log this way once already.
 */
export class ResendEmailAdapter implements EmailProviderPort {
  private readonly apiKey: string;
  private readonly from: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;

  constructor(config: { apiKey: string; from: string; baseUrl?: string; fetchFn?: FetchFn }) {
    this.apiKey = config.apiKey;
    this.from = config.from;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchFn = config.fetchFn ?? ((url, init) => fetch(url, init));
  }

  async send(input: SendEmailInput): Promise<void> {
    const response = await this.fetchFn(`${this.baseUrl}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.from,
        to: input.to,
        subject: input.subject,
        text: input.body,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(
        `resend send failed with status ${response.status} (no request or response body is ` +
          "included on purpose: the API key authenticates every send)"
      );
    }
  }
}
