import { normalizeEmail } from "../../domain/creator";
import { isValidHandle, normalizeHandle } from "../../domain/handle";
import { UniqueRule, UniqueViolationError, ValidationError } from "../errors";
import type { PasswordHasherPort } from "../ports/password-hasher.port";
import type { UserRepositoryPort } from "../ports/user-repository.port";

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
 * The password is hashed UNCONDITIONALLY, before the duplicate-email check
 * runs, for the same reason `AuthenticateCreator`/`AuthenticateUser` pay the
 * argon2id cost on every rejection path: skipping the hash on the
 * duplicate-email branch would make it measurably faster than a fresh
 * signup, and that timing gap is itself an oracle even though the response
 * body is identical.
 */
export class RegisterUser {
  constructor(
    private readonly users: UserRepositoryPort,
    private readonly hasher: PasswordHasherPort
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

    // Paid for on every path, including the ones that end in `{ ok: true }`
    // without ever inserting a row — see the class docstring.
    const passwordHash = await this.hasher.hash(input.password);

    if (await this.users.findByEmail(email)) {
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
        // Same enumeration-safety rule applies — answer identically.
        return { ok: true };
      }
      // A userHandle violation is already a `UniqueViolationError`, which
      // extends `ConflictError` — rethrown as-is (409), and anything else
      // (a bug, an unrelated DB error) rethrown untouched too.
      throw err;
    }

    return { ok: true };
  }
}
