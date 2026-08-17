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
 *   3. An account exists but is over the per-account rate limit.
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
 * NO PER-IP LIMIT ANYMORE — Task 5 review finding F4. The original design
 * capped requests per hashed IP too, read from `X-Forwarded-For`. Measured:
 * 30 requests with a rotated header all sailed past a cap of 10, because
 * `X-Forwarded-For`'s leftmost entry is CLIENT-SUPPLIED and this repository
 * has no committed nginx configuration for the general API surface that
 * proves anything ever overwrites it (`infra/nginx/live-hls.conf.template`
 * is a fragment scoped to `/live/`, `/whip/` and `/webhooks/mediamtx/` only
 * — see its own header comment: the real `/users/...` proxy lives in "the
 * real public HTTPS server block", outside this repository, unverified). A
 * limit keyed on a value the caller can set to anything is not a limit; it
 * is decoration. Dropping it also closes review finding F6 for free: the
 * shared per-IP counter was itself an oracle (only a REAL account's request
 * can ever produce a row, so an attacker could read whether some OTHER
 * email exists by watching their OWN IP's counter climb only on hits) —
 * with no per-IP limit left to consult, there is no shared counter to read.
 * `requestIpHash` is still captured and stored (see `routes/users.ts`'s
 * `clientIp`, which now reads the LAST `X-Forwarded-For` entry rather than
 * the first, and is pinned by its own test) — for forensic/audit value if
 * this box's proxy is ever verified trustworthy, never to gate a decision.
 *
 * NO USER (case 1) still returns before any database write. The SEND
 * (case 2) is deliberately NOT awaited — see `send`'s own docstring for why
 * that closes review finding F1 (measured: an awaited real provider call
 * made the "found and sent" branch ~290x slower than the "no such user"
 * branch) without going through the outbox the way every OTHER external
 * send in this codebase does.
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
    // Recorded regardless of trust — see the class docstring's F4 note. Never
    // read back to gate a decision.
    const ipHash = input.ip !== null ? hashRequestIp(input.ip) : null;

    const overUserLimit = (await this.passwordResets.countForUserSince(user.id, windowStart)) >= MAX_REQUESTS_PER_USER;
    if (overUserLimit) {
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
    // NOT AWAITED — review finding F1. The mint-and-store above already
    // happened (a fast local INSERT, and the thing the rate limit actually
    // reads), so nothing about it depends on `send` finishing before this
    // method returns. `send` never throws (see its own docstring), so a
    // fire-and-forget call here cannot produce an unhandled rejection.
    //
    // WHY NOT THE OUTBOX, even though every other external send in this
    // codebase (`SendRenewalReminder`, `NotifyJoinRequest`) goes through it:
    // the outbox persists its payload as a `jsonb` column, readable by any
    // ordinary `SELECT` on that table for however long the row is queued.
    // The one thing this whole feature is built never to do is let a
    // database read yield a working reset link (see `PasswordResetTokenRecord`'s
    // own docstring and the drizzle repository's plaintext test) — an
    // outbox row carrying this token would violate that the moment it was
    // enqueued, not merely if the table were ever compromised. `GrantChannelAccess`
    // sets the precedent for the alternative already: mint the CREDENTIAL at
    // delivery time, and let the outbox carry only ids. Applying that here
    // would mean minting a SECOND, real token in the worker and leaving this
    // one an inert, never-sent decoy — doubling every row this table gets for
    // no correctness gain over simply not awaiting the send. Fire-and-forget,
    // entirely in this process, gets the SAME measured outcome (the HTTP
    // response no longer depends on provider latency) without either cost.
    // This process is a persistent Bun server (see `infra/docker-compose.yml`),
    // not a request-scoped serverless runtime, so a promise kept alive past
    // the point its handler returned keeps running normally.
    void this.send(channel, user, link);

    // Case 2.
    return { ok: true };
  }

  /**
   * Never allowed to throw — not just because a provider outage must not
   * turn a real account's reset request into a 500 while a nonexistent
   * email's request stays a 200, but because `execute` above does not await
   * this call at all: an unhandled rejection from a fire-and-forget promise
   * would crash nothing in THIS method, but would still be the wrong way to
   * learn about a real delivery failure. Logged instead, so an operator can
   * still see one.
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
