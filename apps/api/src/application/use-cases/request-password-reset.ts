import { createHash } from "node:crypto";
import { normalizeEmail } from "../../domain/creator";
import { hashResetToken, mintResetToken, RESET_TOKEN_TTL_MS } from "../../domain/reset-token";
import type { ClockPort } from "../ports/clock.port";
import type { EmailProviderPort } from "../ports/email-provider.port";
import type { MessagingProviderPort } from "../ports/messaging-provider.port";
import type { PasswordResetRepositoryPort } from "../ports/password-reset-repository.port";
import type { UserRecord, UserRepositoryPort } from "../ports/user-repository.port";

/** The ONLY shape this use-case ever returns. See the class docstring. */
export interface RequestPasswordResetResult {
  ok: true;
}

/** The rate-limit window: "the last hour", per the spec. */
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
/** Refuse a user's own requests past this count within the window. */
const MAX_REQUESTS_PER_USER = 3;
/** Refuse requests from one IP past this count within the window, across every account. */
const MAX_REQUESTS_PER_IP = 10;

/**
 * `POST /users/password-reset/request`.
 *
 * THE SHAPE IS DICTATED BY ENUMERATION SAFETY, not stylistic preference —
 * mirrors `RegisterUser`'s own docstring on the same subject, and closes the
 * SAME class of hole Task 2's review found there (a duplicate-email branch
 * that answered differently from a fresh one, turning signup into a "does
 * this email exist" oracle with zero setup).
 *
 * FOUR paths reach the end of `execute`, and every one of them returns the
 * identical `{ ok: true }` with nothing else observable in the response:
 *
 *   1. No account has this email.
 *   2. An account exists, has a channel, and a link was sent.
 *   3. An account exists but is over the per-account or per-IP rate limit.
 *   4. An account exists but has NO available channel (no email provider
 *      configured on this box AND no WhatsApp number on file).
 *
 * Case 4 is the subtle one. A "you have no reset channel" error would ITSELF
 * be an oracle, because only a REAL account can lack a channel — a made-up
 * email can never reach this branch at all, so any response that looks
 * different here immediately confirms the email exists. The refusal a human
 * should see for that case ("we couldn't reach you — add a WhatsApp number
 * or contact support") belongs to the WEB layer, driven by what channels an
 * AUTHENTICATED account's own profile shows it has — never to this
 * endpoint's response, which has no way to prove the caller who typed the
 * email is the account's owner.
 *
 * NO USER (case 1) returns immediately, before any database write and
 * before any external call — cheaper, not more expensive, than every other
 * case. That is a real, if narrow, timing signal this class does not close:
 * closing it fully would mean never awaiting the send inline (deferring it
 * through the outbox, the way every OTHER external send in this codebase
 * works), which the spec's own numbered steps do not ask for here — Task 5
 * asks for the same synchronous-send shape `RegisterUser`'s duplicate-email
 * notice uses. Rate limiting keeps this from being useful at scale even
 * though it is not literally zero; see the task report for the full
 * reasoning.
 */
export class RequestPasswordReset {
  constructor(
    private readonly users: UserRepositoryPort,
    private readonly passwordResets: PasswordResetRepositoryPort,
    /** `null` means email is disabled on this box — see `selectEmailProvider`. */
    private readonly email: EmailProviderPort | null,
    /** How the member is reached over WhatsApp. Never `null` — see `Dependencies.messaging`. */
    private readonly notifier: MessagingProviderPort,
    private readonly clock: ClockPort,
    private readonly config: { appBaseUrl: string }
  ) {}

  async execute(input: { email: string; ip: string | null }): Promise<RequestPasswordResetResult> {
    const email = normalizeEmail(input.email);
    const user = await this.users.findByEmail(email);
    if (!user) {
      // Case 1. Nothing written, nothing sent — see the class docstring for
      // why this is the ONE case that does not pay the rate-limit reads.
      return { ok: true };
    }

    const now = this.clock.now();
    const windowStart = new Date(now.getTime() - RATE_LIMIT_WINDOW_MS);
    const ipHash = input.ip !== null ? hashRequestIp(input.ip) : null;

    const overUserLimit = (await this.passwordResets.countForUserSince(user.id, windowStart)) >= MAX_REQUESTS_PER_USER;
    const overIpLimit =
      ipHash !== null && (await this.passwordResets.countForIpSince(ipHash, windowStart)) >= MAX_REQUESTS_PER_IP;
    if (overUserLimit || overIpLimit) {
      // Case 3. A distinct rate-limit message would itself be an oracle —
      // see the class docstring.
      return { ok: true };
    }

    const channel = chooseChannel(this.email, user);
    if (channel === null) {
      // Case 4 — see the class docstring for why this is silent rather than
      // an error.
      return { ok: true };
    }

    const { token, tokenHash } = mintResetToken();
    await this.passwordResets.create({
      userId: user.id,
      tokenHash,
      expiresAt: new Date(now.getTime() + RESET_TOKEN_TTL_MS),
      requestIpHash: ipHash,
    });

    const link = `${this.config.appBaseUrl}/reset/${token}`;
    await this.send(channel, user, link);

    // Case 2.
    return { ok: true };
  }

  /**
   * Never allowed to throw out of `execute` — a provider outage must not
   * turn a real account's reset request into a 500 while a nonexistent
   * email's request stays a 200. Logged, not silently dropped, so an
   * operator can still see a real delivery failure.
   */
  private async send(channel: "email" | "whatsapp", user: UserRecord, link: string): Promise<void> {
    try {
      if (channel === "email") {
        // `this.email` is non-null whenever `chooseChannel` picks "email" —
        // see that function.
        await (this.email as EmailProviderPort).send({
          to: user.email,
          subject: "Atur ulang kata sandi DIUDARA",
          body: buildMessage(link),
        });
        return;
      }
      // `user.whatsappNumber` is non-null whenever `chooseChannel` picks
      // "whatsapp" — see that function.
      await this.notifier.notify({
        toWhatsappNumber: user.whatsappNumber as string,
        message: buildMessage(link),
      });
    } catch (err) {
      console.warn(
        `[password-reset] failed to deliver a reset link over ${channel} for user=${user.id}: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

/**
 * Email first, then WhatsApp, then nothing — exactly the order the spec
 * gives in Task 5's numbered steps. WhatsApp needs only a number on file:
 * messaging itself is never unconfigured in a running process — see
 * `Dependencies.messaging`'s own docstring — so there is no third input to
 * check here the way there is for email.
 */
function chooseChannel(email: EmailProviderPort | null, user: UserRecord): "email" | "whatsapp" | null {
  if (email !== null) return "email";
  if (user.whatsappNumber !== null) return "whatsapp";
  return null;
}

/** sha256 hex of the caller's IP, so the rate-limit table never stores a raw address. */
function hashRequestIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex");
}

/** The one message a member receives, over whichever channel was chosen. In Indonesian. */
function buildMessage(link: string): string {
  return (
    "Kami menerima permintaan untuk mengatur ulang kata sandi akun DIUDARA Anda. " +
    "Klik tautan berikut untuk melanjutkan (berlaku 30 menit):\n\n" +
    `${link}\n\n` +
    "Jika Anda tidak meminta ini, abaikan pesan ini — kata sandi Anda tidak akan berubah."
  );
}
