import { UnsupportedOperationError } from "../../application/errors";
import type {
  GrantAccessInput,
  MessagingCapabilities,
  MessagingProviderPort,
  NotifyInput,
  RevokeAccessInput,
} from "../../application/ports/messaging-provider.port";

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

const DEFAULT_BASE_URL = "https://api.fonnte.com";

/** Same reasoning as the Telegram adapter: the worker must not hang on a send. */
const REQUEST_TIMEOUT_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * !!! UNVERIFIED AGAINST THE LIVE FONNTE API !!!
 *
 * Written from Fonnte's published documentation with no account, so the request
 * format (form-encoded `target`/`message`, the bare `Authorization: <token>`
 * header) and the response shape are ASSUMPTIONS. The tests beside this file
 * prove the PORT CONTRACT — above all that gating THROWS rather than no-ops —
 * they do NOT prove a message reaches anyone's phone. Exercise it against a real
 * device before a member's invite depends on it, then delete this warning.
 *
 * WHY NOTIFY ONLY (spec §2.1, and do not "fix" this):
 * WhatsApp cannot gate group access. Meta's official Groups API has
 * `DELETE /participants` but NO `POST /participants`, and caps a group at 8
 * participants against a product targeting 50–2,000. Unofficial gateways can add
 * participants, but they do it by driving a real logged-in WhatsApp account — the
 * CREATOR's — which risks a ban of the account their whole community lives in.
 * So this provider reports `canGateAccess: false` and THROWS on both gating
 * methods. A silent no-op would be the worst failure mode in this phase: a paying
 * member appears granted and is not.
 *
 * SECRET HANDLING: no error message interpolates the request, the headers, or the
 * response body — the token authenticates every send, and Fonnte echoes back an
 * offending token in `detail` on some failures.
 */
export class FonnteWhatsAppAdapter implements MessagingProviderPort {
  readonly platform = "whatsapp";

  private readonly apiToken: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;

  constructor(config: { apiToken: string; baseUrl?: string; fetchFn?: FetchFn }) {
    this.apiToken = config.apiToken;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchFn = config.fetchFn ?? ((url, init) => fetch(url, init));
  }

  capabilities(): MessagingCapabilities {
    return { canGateAccess: false };
  }

  async grantAccess(_input: GrantAccessInput): Promise<{ inviteLink: string }> {
    throw this.gatingUnsupported("grant access");
  }

  async revokeAccess(_input: RevokeAccessInput): Promise<void> {
    throw this.gatingUnsupported("revoke access");
  }

  /** The one thing WhatsApp is uncontroversially good at here. */
  async notify(input: NotifyInput): Promise<void> {
    const response = await this.fetchFn(`${this.baseUrl}/send`, {
      method: "POST",
      headers: {
        // Fonnte takes the raw token, with no "Bearer " prefix.
        Authorization: this.apiToken,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      // Form-encoded, as every example in Fonnte's documentation is. The number
      // and the message body stay OUT of the URL: URLs reach HTTP client logs and
      // proxy access logs, and the message carries the member's invite link — a
      // bearer credential that must never appear in a log line.
      body: new URLSearchParams({
        target: this.requireTarget(input.toWhatsappNumber),
        message: input.message,
      }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(
        `fonnte notify failed with status ${response.status} (no request or response ` +
          "detail is included on purpose: the API token authenticates every send)"
      );
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new Error(
        "fonnte notify returned a 200 whose body is not JSON — most likely a proxy or " +
          "error page rather than the API"
      );
    }

    this.requireAccepted(parsed);
  }

  /**
   * Fonnte answers a rejected send with HTTP 200 and `status: false` (and returns
   * an ARRAY of booleans when several targets were addressed). Anything we do not
   * recognise as an acceptance must throw: a send that silently failed means a
   * member who paid is never told, and — because the worker would mark the outbox
   * row sent — nothing would ever notice.
   */
  private requireAccepted(body: unknown): void {
    const status = isRecord(body) ? body.status : undefined;
    const accepted =
      status === true ||
      (Array.isArray(status) && status.length > 0 && status.every((one) => one === true));

    if (!accepted) {
      throw new Error(
        'fonnte notify was not accepted: the response carries no usable "status" (expected ' +
          "true, or an array of true). The provider description is deliberately not repeated " +
          "here — see the SECRET HANDLING note in fonnte-whatsapp.adapter.ts"
      );
    }
  }

  /**
   * We store E.164 (`+6281234567890`); every Fonnte example is digits only
   * (`6281234567890`). Stripping the punctuation is an ASSUMPTION about a provider
   * this adapter has never spoken to — flagged by the UNVERIFIED warning above —
   * but it is the documented form, and an empty result means we were handed
   * something that is not a phone number at all.
   */
  private requireTarget(whatsappNumber: string): string {
    const digits = whatsappNumber.replace(/[^0-9]/g, "");
    if (digits.length === 0) {
      throw new Error(
        "fonnte notify needs a phone number to send to, and the value given contains no " +
          "digits. The number itself is not repeated here: it is a member's PII."
      );
    }
    return digits;
  }

  private gatingUnsupported(operation: string): UnsupportedOperationError {
    return new UnsupportedOperationError(
      `whatsapp cannot ${operation}: this provider is notification-only. Meta's official ` +
        "Groups API has no POST /participants and caps a group at 8 participants, and an " +
        "unofficial gateway would drive — and risk a ban of — the CREATOR's own WhatsApp " +
        "account. See the WHY NOTIFY ONLY note in fonnte-whatsapp.adapter.ts."
    );
  }
}
