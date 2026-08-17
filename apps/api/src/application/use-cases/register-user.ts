import { normalizeEmail } from "../../domain/creator";
import { isValidHandle, normalizeHandle } from "../../domain/handle";
import { UniqueRule, UniqueViolationError, ValidationError } from "../errors";
import type { EmailProviderPort } from "../ports/email-provider.port";
import type { MessagingProviderPort } from "../ports/messaging-provider.port";
import type { PasswordHasherPort } from "../ports/password-hasher.port";
import type { UserRecord, UserRepositoryPort } from "../ports/user-repository.port";

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
    private readonly notifier: MessagingProviderPort
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
      await this.notifyExistingOwner(existing);
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
          await this.notifyExistingOwner(owner);
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
   * Email first, then WhatsApp, then nothing — same order and reasoning as
   * `RequestPasswordReset`'s own `chooseChannel` (duplicated rather than
   * shared — see that function's docstring for why this codebase accepts
   * that for two call sites with different contracts).
   *
   * Never allowed to throw: a provider outage on this notice must not turn
   * a duplicate-email signup into a 500 while a fresh signup stays a 201 —
   * the exact timing/status oracle enumeration safety exists to close.
   * Logged, not silently dropped, so an operator can still see a real
   * delivery failure.
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
