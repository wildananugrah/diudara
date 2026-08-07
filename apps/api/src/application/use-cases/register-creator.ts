import { normalizeEmail } from "../../domain/creator";
import { ConflictError } from "../errors";
import type { CreatorRepositoryPort } from "../ports/creator-repository.port";
import type { PasswordHasherPort } from "../ports/password-hasher.port";
import type { TokenIssuerPort } from "../ports/token-issuer.port";

export interface PublicCreator {
  id: string;
  name: string;
  email: string | null;
}

export class RegisterCreator {
  constructor(
    private readonly creators: CreatorRepositoryPort,
    private readonly hasher: PasswordHasherPort,
    private readonly tokens: TokenIssuerPort
  ) {}

  async execute(input: { name: string; email: string; password: string }): Promise<{
    creator: PublicCreator;
    token: string;
  }> {
    const email = normalizeEmail(input.email);

    if (await this.creators.findByEmail(email)) {
      throw new ConflictError("email is already registered");
    }

    const passwordHash = await this.hasher.hash(input.password);
    const created = await this.creators.create({ name: input.name, email, passwordHash });
    const token = await this.tokens.issue({ creatorId: created.id });

    return {
      creator: { id: created.id, name: created.name, email: created.email },
      token,
    };
  }
}
