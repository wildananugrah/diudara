import { normalizeEmail } from "../../domain/creator";
import { UnauthorizedError } from "../errors";
import type { PasswordHasherPort } from "../ports/password-hasher.port";
import type { UserRepositoryPort } from "../ports/user-repository.port";
import type { UserTokenIssuerPort } from "../ports/user-token-issuer.port";

/** The shape of a user returned to an HTTP caller — never carries a password hash. */
export interface PublicUser {
  id: string;
  handle: string;
  email: string;
  displayName: string;
}

/** Identical for unknown email and wrong password. */
const GENERIC_FAILURE = "invalid email or password";

/**
 * A valid argon2id hash of an arbitrary throwaway string, hardcoded so no
 * password ever verifies against it. Used ONLY to pay the same hashing cost
 * on the unknown-email path as the real verification path does — otherwise
 * that path returns in <1ms while a wrong-password attempt pays the full
 * argon2id cost (tens of ms), and that latency gap alone answers "does this
 * account exist", defeating the point of throwing the same error message and
 * status for both. It is a fixed literal, not generated via a concrete
 * hasher adapter, so this use-case still depends only on
 * `PasswordHasherPort`. Copied from `AuthenticateCreator` — see that class
 * for the fuller version of this comment.
 */
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=2,p=1$mp2H4MO93kjLmqFmRPSChc1lkd95sGhDurct9QF1r1Y$AsKnl0EP46H06OJkSQAaQdESQGGIAZGMHJ+O+TSirbc";

export class AuthenticateUser {
  constructor(
    private readonly users: UserRepositoryPort,
    private readonly hasher: PasswordHasherPort,
    private readonly tokens: UserTokenIssuerPort
  ) {}

  async execute(input: { email: string; password: string }): Promise<{
    user: PublicUser;
    token: string;
  }> {
    const email = normalizeEmail(input.email);
    // The dedicated credentials lookup is the only path to the hash; the
    // general-purpose findByEmail deliberately does not return it.
    const found = await this.users.findCredentialsByEmail(email);

    // Always pay the same argon2id cost, whether or not an account exists —
    // otherwise the response time itself becomes an oracle for account
    // enumeration, even though the thrown error's message and status are
    // identical across both cases. Unlike creators, every `app_user` row has
    // a password (NOT NULL on `password_hash`), so there is no third,
    // password-less case here.
    const hashToVerify = found?.passwordHash ?? DUMMY_PASSWORD_HASH;
    const verified = await this.hasher.verify(input.password, hashToVerify);

    if (!found || !verified) {
      throw new UnauthorizedError(GENERIC_FAILURE);
    }

    const token = await this.tokens.issue({
      userId: found.id,
      sessionEpoch: found.sessionEpoch,
    });

    const profile = await this.users.findById(found.id);
    if (!profile) {
      // Credentials existed a moment ago; the row cannot have vanished
      // between the two reads in any normal operation. Treated as the same
      // generic failure rather than a 500 — there is nothing else honest to
      // say to the caller.
      throw new UnauthorizedError(GENERIC_FAILURE);
    }

    return {
      user: {
        id: profile.id,
        handle: profile.handle,
        email: profile.email,
        displayName: profile.displayName,
      },
      token,
    };
  }
}
