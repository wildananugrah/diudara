import { normalizeEmail } from "../../domain/creator";
import { UnauthorizedError } from "../errors";
import type { CreatorRepositoryPort } from "../ports/creator-repository.port";
import type { PasswordHasherPort } from "../ports/password-hasher.port";
import type { TokenIssuerPort } from "../ports/token-issuer.port";
import type { PublicCreator } from "./register-creator";

/** Identical for unknown email, wrong password, and password-less accounts. */
const GENERIC_FAILURE = "invalid email or password";

/**
 * A valid argon2id hash of an arbitrary throwaway string, hardcoded so no
 * password ever verifies against it. Used ONLY to pay the same hashing cost
 * on the unknown-email / no-password-set paths as the real verification
 * path does — otherwise those paths return in <1ms while a wrong-password
 * attempt pays the full argon2id cost (tens of ms), and that latency gap
 * alone answers "does this account exist / does it have a password",
 * defeating the point of throwing the same error message and status for
 * both. It is a fixed literal, not generated via a concrete hasher
 * adapter, so this use-case still depends only on PasswordHasherPort.
 */
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=2,p=1$mp2H4MO93kjLmqFmRPSChc1lkd95sGhDurct9QF1r1Y$AsKnl0EP46H06OJkSQAaQdESQGGIAZGMHJ+O+TSirbc";

export class AuthenticateCreator {
  constructor(
    private readonly creators: CreatorRepositoryPort,
    private readonly hasher: PasswordHasherPort,
    private readonly tokens: TokenIssuerPort
  ) {}

  async execute(input: { email: string; password: string }): Promise<{
    creator: PublicCreator;
    token: string;
  }> {
    const email = normalizeEmail(input.email);
    // The dedicated credentials lookup is the only path to the hash; the
    // general-purpose findByEmail deliberately does not return it.
    const found = await this.creators.findCredentialsByEmail(email);

    // Always pay the same argon2id cost, whether or not an account exists
    // or has a password set — otherwise the response time itself becomes
    // an oracle for account enumeration, even though the thrown error's
    // message and status are identical across all three cases.
    const hashToVerify = found?.passwordHash ?? DUMMY_PASSWORD_HASH;
    const verified = await this.hasher.verify(input.password, hashToVerify);

    if (!found || !found.passwordHash || !verified) {
      throw new UnauthorizedError(GENERIC_FAILURE);
    }

    const token = await this.tokens.issue({ creatorId: found.id });

    return {
      creator: { id: found.id, name: found.name, email: found.email },
      token,
    };
  }
}
