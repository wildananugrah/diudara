import { normalizeEmail } from "../../domain/creator";
import { UnauthorizedError } from "../errors";
import type { CreatorRepositoryPort } from "../ports/creator-repository.port";
import type { PasswordHasherPort } from "../ports/password-hasher.port";
import type { TokenIssuerPort } from "../ports/token-issuer.port";
import type { PublicCreator } from "./register-creator";

/** Identical for unknown email, wrong password, and password-less accounts. */
const GENERIC_FAILURE = "invalid email or password";

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

    if (!found || !found.passwordHash) {
      throw new UnauthorizedError(GENERIC_FAILURE);
    }

    if (!(await this.hasher.verify(input.password, found.passwordHash))) {
      throw new UnauthorizedError(GENERIC_FAILURE);
    }

    const token = await this.tokens.issue({ creatorId: found.id });

    return {
      creator: { id: found.id, name: found.name, email: found.email },
      token,
    };
  }
}
