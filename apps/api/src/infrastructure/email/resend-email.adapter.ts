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
 * VERIFIED against the live Resend API on 2026-08-25: a message sent through
 * THIS adapter — constructed as `bootstrap.ts` constructs it, not a mock —
 * arrived in a real inbox, from a verified sending domain. Until then the
 * file had been written from Resend's published documentation without an
 * account, and its request shape and error handling were assumptions.
 *
 * `apps/api/scripts/verify-resend.ts` is that check, kept rather than thrown
 * away so it can be re-run whenever the request shape, the sending domain, or
 * Resend's API changes. Run it after any edit to `send` below.
 *
 * The tests beside this file still prove ONLY the port contract and the
 * secret-handling rule below. They never touch the network, so they cannot
 * notice Resend changing its API, and a green suite here is not evidence that
 * mail is being delivered.
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
