import { UnauthorizedError } from "../errors";
import { hashResetToken } from "../../domain/reset-token";
import type { ClockPort } from "../ports/clock.port";
import type { PasswordHasherPort } from "../ports/password-hasher.port";
import type { PasswordResetRepositoryPort } from "../ports/password-reset-repository.port";
import type { PasswordResetUnitOfWorkPort } from "../ports/password-reset-unit-of-work.port";

/** Identical for a missing, expired, or already-used token — see the class docstring. */
const INVALID_TOKEN_MESSAGE = "invalid or expired reset link";

/**
 * `POST /users/password-reset/complete`.
 *
 * Refuses a missing, expired, or already-used token with the SAME message
 * and status (401, mirroring `AuthenticateUser`'s `GENERIC_FAILURE`
 * treatment of "unknown email" and "wrong password" as one outcome): a
 * reset token functions as a bearer credential here, and telling the three
 * cases apart would tell a caller holding a stale or guessed token which of
 * the three is true, which is more than a stranger with a URL is entitled
 * to learn.
 *
 * THREE WRITES, ONE TRANSACTION, via `PasswordResetUnitOfWorkPort`:
 *
 *   1. Mark THIS token used.
 *   2. Mark EVERY OTHER outstanding token for this user used — so a reset
 *      invalidates every link still sitting in an inbox, not just the one
 *      that was clicked.
 *   3. `setPasswordAndBumpEpoch` — the epoch bump is what ends every
 *      existing session (see `requireUserAuth`'s own docstring). Without
 *      it in the SAME transaction as the password write, a crash between
 *      the two would leave a changed password with the old sessions still
 *      live, or a bumped epoch with the old password still valid.
 *
 * The LOOKUP happens OUTSIDE the transaction, against the pooled
 * repository — the same split `HandlePaymentWebhook` uses (see
 * `bootstrap.ts`'s own comment on that use-case): a read has nothing to
 * roll back. The race this leaves open — two completions of the SAME token
 * arriving together — is closed by `markUsed`'s own conditional UPDATE
 * (`usedAt IS NULL` in the predicate, not read first), which is why this
 * class does not re-read the token a second time inside the transaction.
 *
 * The new password is hashed BEFORE the transaction opens, deliberately:
 * argon2id costs tens of milliseconds, and a transaction should hold the
 * database connection for as short a window as possible, not for however
 * long hashing happens to take.
 */
export class CompletePasswordReset {
  constructor(
    private readonly passwordResets: PasswordResetRepositoryPort,
    private readonly hasher: PasswordHasherPort,
    private readonly unitOfWork: PasswordResetUnitOfWorkPort,
    private readonly clock: ClockPort
  ) {}

  async execute(input: { token: string; newPassword: string }): Promise<{ ok: true }> {
    const tokenHash = hashResetToken(input.token);
    const record = await this.passwordResets.findByHash(tokenHash);

    const now = this.clock.now();
    if (record === null || record.usedAt !== null || record.expiresAt.getTime() <= now.getTime()) {
      throw new UnauthorizedError(INVALID_TOKEN_MESSAGE);
    }

    const passwordHash = await this.hasher.hash(input.newPassword);

    await this.unitOfWork.run(async (repositories) => {
      const marked = await repositories.passwordResets.markUsed(record.id);
      if (!marked) {
        // Lost a race with a concurrent completion of the SAME token — see
        // the class docstring. Treated as the identical invalid-token
        // failure, not a different one: the caller cannot tell "this token
        // was already used a moment ago by someone else" from "this token
        // never existed", and should not be able to.
        throw new UnauthorizedError(INVALID_TOKEN_MESSAGE);
      }
      await repositories.passwordResets.markAllOtherOutstandingUsed(record.userId, record.id);
      await repositories.users.setPasswordAndBumpEpoch(record.userId, passwordHash);
    });

    return { ok: true };
  }
}
