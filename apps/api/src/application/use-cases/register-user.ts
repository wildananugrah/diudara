import { normalizeEmail } from "../../domain/creator";
import { isValidHandle, normalizeHandle } from "../../domain/handle";
import { UniqueRule, UniqueViolationError, ValidationError } from "../errors";
import type { ClockPort } from "../ports/clock.port";
import type { EmailProviderPort } from "../ports/email-provider.port";
import type { MessagingProviderPort } from "../ports/messaging-provider.port";
import type { PasswordHasherPort } from "../ports/password-hasher.port";
import type { SignupNoticeRepositoryPort } from "../ports/signup-notice-repository.port";
import type { UserRecord, UserRepositoryPort } from "../ports/user-repository.port";

/** The rate-limit window for the existing-email notice: "the last hour", mirroring the reset endpoint's own window. */
const SIGNUP_NOTICE_WINDOW_MS = 60 * 60 * 1000;
/**
 * Review finding F3: 25 signup attempts against one address used to deliver
 * 25 messages, all 201 — an unrate-limited amplifier. Capped at the SAME
 * number `RequestPasswordReset` uses for its own per-account limit, in a
 * SEPARATE ledger (`signup_notice`, not `password_reset_token`) so
 * exhausting this cap cannot also block the real owner's own resets — see
 * `signupNotices` in `db/schema.ts`.
 */
const MAX_SIGNUP_NOTICES_PER_HOUR = 3;

/**
 * Told to the EXISTING account's owner, over whichever channel they have,
 * when someone signs up against their email. Copy fixed by the spec —
 * Task 5. Lives here, not in a route or a template file, for the same
 * reason `STAGE_HEADLINE_ID` lives inside `send-renewal-reminder.ts`: it is
 * the entire member-visible surface of this notice, so there is exactly one
 * place to check what it does and does not say.
 */
export const EXISTING_EMAIL_SIGNUP_NOTICE =
  "Seseorang mencoba mendaftar dengan alamat email ini. Jika itu Anda, silakan masuk atau " +
  "pulihkan sandi Anda.";

/**
 * `POST /users/signup`. Returns `{ ok: true }` and NOTHING else — no user,
 * no token. Signup does not log you in.
 *
 * That shape is forced by enumeration safety, not stylistic preference. A
 * duplicate EMAIL must be indistinguishable from a fresh signup: identical
 * status, identical body, identical shape. If this returned a session on
 * success, the duplicate-email branch would have to either reveal the email
 * is taken (an oracle) or return a session for an account the caller does
 * not own (a takeover). Returning nothing is the only shape where "answer
 * identically" is also safe. The web layer sends the caller to the login
 * page afterwards.
 *
 * A duplicate HANDLE is the opposite case and DOES throw `ConflictError`
 * (409). A handle is public by design — anyone can browse `/@wildan` — so
 * saying one is taken leaks nothing that browsing the site does not. Do not
 * "fix" this asymmetry into matching the email path: that would just be a
 * confusing error for a legitimate collision, and it would still let a
 * caller who cares about timing distinguish the two paths (see below).
 *
 * THE HANDLE CHECK RUNS FIRST, BEFORE THE EMAIL CHECK — this order is
 * load-bearing, not incidental. An earlier version checked email first and
 * returned early on a hit, so `create()` (and its handle-uniqueness check)
 * only ran when the email was free. A taken handle then 409'd ONLY when the
 * email was ALSO free, and silently answered `{ ok: true }` when the email
 * was already registered — turning "is this handle taken" (intentionally
 * public) into "does this EMAIL have an account" (the one thing this class
 * exists to hide), discoverable with nothing but one known handle and a
 * guessed email. Checking the handle first closes that: a taken handle
 * 409s regardless of what the email check would have found, because the
 * email check never runs at all in that case.
 *
 * The password is hashed UNCONDITIONALLY between the two checks — after the
 * handle check (a taken handle is disclosed outright via its own 409
 * message, so there is nothing to hide there and no reason to pay for a
 * hash first) but before the duplicate-email check and every path beyond
 * it. That is for the same reason `AuthenticateCreator`/`AuthenticateUser`
 * pay the argon2id cost on every rejection path: skipping the hash on the
 * duplicate-email branch would make it measurably faster than a fresh
 * signup, and that timing gap is itself an oracle even though the response
 * body is identical.
 *
 * THE EXISTING-EMAIL NOTICE'S SEND IS NOT AWAITED — Task 5 review finding
 * F2. Step 6 originally `await`ed `notifyExistingOwner`, which reintroduced
 * exactly the timing gap the paragraph above exists to prevent, in the
 * OTHER direction: measured with a 200ms provider, a fresh signup answered
 * in ~65ms and a duplicate-email signup in ~296ms — worse than the reset
 * endpoint's own version of this bug (F1), because signup has no rate limit
 * at all to blunt it. The actual network call inside `notifyExistingOwner`
 * is now fired without an `await`, for the identical reasoning
 * `RequestPasswordReset.execute` documents for its own `send` call: it
 * never throws, so a fire-and-forget call cannot produce an unhandled
 * rejection, and this process is a persistent Bun server where a promise
 * kept alive past its caller's return completes normally. The RATE-LIMIT
 * check and ledger write (see `MAX_SIGNUP_NOTICES_PER_HOUR`) stay AWAITED —
 * they are fast local reads/writes, not the network call, and awaiting them
 * is what keeps a burst of concurrent signups from all seeing the same
 * stale count and all sailing past the cap together.
 */
export class RegisterUser {
  constructor(
    private readonly users: UserRepositoryPort,
    private readonly hasher: PasswordHasherPort,
    /**
     * Task 5's addition: `null` means email is disabled on this box — see
     * `selectEmailProvider`. Used ONLY on the duplicate-email path, to tell
     * the EXISTING account's owner someone tried to sign up with their
     * address — never on the fresh-signup path, which has nobody to tell.
     */
    private readonly email: EmailProviderPort | null,
    /** How the existing owner is reached over WhatsApp when email is unavailable. Never `null` — see `Dependencies.messaging`. */
    private readonly notifier: MessagingProviderPort,
    /** Review finding F3's rate-limit ledger for this notice — see `MAX_SIGNUP_NOTICES_PER_HOUR`. */
    private readonly signupNotices: SignupNoticeRepositoryPort,
    private readonly clock: ClockPort
  ) {}

  async execute(input: {
    handle: string;
    email: string;
    password: string;
    displayName: string;
    whatsappNumber?: string;
  }): Promise<{ ok: true }> {
    const handle = normalizeHandle(input.handle);
    if (!isValidHandle(handle)) {
      throw new ValidationError(
        "handle must be 3-30 lowercase letters, digits or underscores"
      );
    }
    const email = normalizeEmail(input.email);

    // MUST run before the email check below — see the class docstring for
    // why the order is load-bearing rather than arbitrary.
    if (await this.users.findByHandle(handle)) {
      throw new UniqueViolationError(UniqueRule.userHandle, "handle is already taken");
    }

    // Paid for on every remaining path, including the ones that end in
    // `{ ok: true }` without ever inserting a row — see the class docstring.
    const passwordHash = await this.hasher.hash(input.password);

    const existing = await this.users.findByEmail(email);
    if (existing) {
      // Task 5: the silent duplicate becomes HONEST rather than merely
      // quiet — the account's owner learns someone tried, while the caller
      // who typed the email learns nothing (the HTTP response below is
      // unaffected either way — see the class docstring).
      await this.maybeNotifyExistingOwner(existing);
      return { ok: true };
    }

    try {
      await this.users.create({
        handle,
        email,
        whatsappNumber: input.whatsappNumber ?? null,
        passwordHash,
        displayName: input.displayName,
      });
    } catch (err) {
      if (err instanceof UniqueViolationError && err.rule === UniqueRule.userEmail) {
        // Lost a race with a concurrent signup for the same email: the
        // pre-check above passed, another request's INSERT landed first.
        // Same enumeration-safety rule applies — answer identically, and
        // notify the owner exactly as the pre-check branch above does. The
        // record has to be re-read: the row `create()` collided with is not
        // the one this call's own (failed) attempt produced.
        const owner = await this.users.findByEmail(email);
        if (owner) {
          await this.maybeNotifyExistingOwner(owner);
        }
        return { ok: true };
      }
      // A userHandle violation here means a concurrent signup claimed the
      // SAME handle between our pre-check above and this INSERT — the
      // pre-check is not atomic with the write, so the unique index is
      // still the real arbiter. It is already a `UniqueViolationError`,
      // which extends `ConflictError` — rethrown as-is (409), and anything
      // else (a bug, an unrelated DB error) rethrown untouched too.
      throw err;
    }

    return { ok: true };
  }

  /**
   * The rate-limit gate in front of `notifyExistingOwner` — review finding
   * F3. AWAITED by `execute` (unlike the send itself): both the count read
   * and the ledger write are fast, local, and are what makes the cap
   * accurate under a burst of concurrent signups against the same address,
   * the same reason `RequestPasswordReset`'s own rate-limit check is
   * awaited rather than deferred.
   *
   * The ledger entry is written BEFORE the send is even attempted,
   * regardless of whether it will succeed — it caps ATTEMPTS, not
   * successful deliveries, the same accounting `RequestPasswordReset` uses
   * for its own token rows.
   */
  private async maybeNotifyExistingOwner(existing: UserRecord): Promise<void> {
    const since = new Date(this.clock.now().getTime() - SIGNUP_NOTICE_WINDOW_MS);
    const count = await this.signupNotices.countForUserSince(existing.id, since);
    if (count >= MAX_SIGNUP_NOTICES_PER_HOUR) {
      // Capped. Silent, like every other refusal in this class and in
      // `RequestPasswordReset` — the caller's response is unaffected either
      // way, so there is nothing to leak by staying quiet here too.
      return;
    }
    await this.signupNotices.record(existing.id);
    // NOT awaited — see the class docstring's F2 note. `.catch(...)` here
    // too, not just `notifyExistingOwner`'s own internal try/catch — review
    // finding NF4, same reasoning as `RequestPasswordReset.send`'s own call
    // site: this makes "cannot produce an unhandled rejection" true
    // regardless of what `notifyExistingOwner`'s body does internally,
    // rather than depending on it staying exactly as written.
    void this.notifyExistingOwner(existing).catch((err) => {
      console.warn(
        `[register-user] notifyExistingOwner() itself rejected — this should be unreachable ` +
          `given its own try/catch; treat this as that guard having been removed or narrowed. ` +
          `user=${existing.id}: ${err instanceof Error ? err.message : String(err)}`
      );
    });
  }

  /**
   * Email first, then WhatsApp, then nothing — same order and reasoning as
   * `RequestPasswordReset`'s own `chooseChannel` (duplicated rather than
   * shared — see that function's docstring for why this codebase accepts
   * that for two call sites with different contracts).
   *
   * Never allowed to throw — not just because a provider outage on this
   * notice must not turn a duplicate-email signup into a 500 while a fresh
   * signup stays a 201, but because `maybeNotifyExistingOwner` does not
   * await this call at all: an unhandled rejection here would crash
   * nothing, but would still be the wrong way to learn about a real
   * delivery failure. Logged instead, so an operator can still see one.
   */
  private async notifyExistingOwner(existing: UserRecord): Promise<void> {
    try {
      if (this.email !== null) {
        await this.email.send({
          to: existing.email,
          subject: "Percobaan pendaftaran dengan email Anda",
          body: EXISTING_EMAIL_SIGNUP_NOTICE,
        });
        return;
      }
      if (existing.whatsappNumber !== null) {
        await this.notifier.notify({
          toWhatsappNumber: existing.whatsappNumber,
          message: EXISTING_EMAIL_SIGNUP_NOTICE,
        });
        return;
      }
      // No channel at all — silent, exactly like `RequestPasswordReset`'s
      // own case 4. Nothing to notify with, and nothing to leak either way.
    } catch (err) {
      console.warn(
        `[register-user] failed to deliver the existing-email signup notice for user=` +
          `${existing.id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
