import { describe, expect, it } from "bun:test";
import { AuthenticateCreator } from "./authenticate-creator";
import { UnauthorizedError } from "../errors";
import type {
  CreatorCredentials,
  CreatorRepositoryPort,
} from "../ports/creator-repository.port";
import type { PasswordHasherPort } from "../ports/password-hasher.port";
import type { TokenIssuerPort, TokenPayload } from "../ports/token-issuer.port";

function credentials(overrides: Partial<CreatorCredentials> = {}): CreatorCredentials {
  return {
    id: "creator-1",
    name: "Budi",
    email: "budi@example.com",
    passwordHash: "hashed:supersecret123",
    ...overrides,
  };
}

function fakeRepository(seed: CreatorCredentials[]) {
  const repository: CreatorRepositoryPort = {
    async create() {
      throw new Error("not used in these tests");
    },
    async findById() {
      throw new Error("not used in these tests");
    },
    async findByEmail() {
      throw new Error("not used in these tests");
    },
    async findCredentialsByEmail(email) {
      return seed.find((r) => r.email === email) ?? null;
    },
    async beginXenditAccountProvisioning() {
      throw new Error("not used in these tests");
    },
    async finishXenditAccountProvisioning() {
      throw new Error("not used in these tests");
    },
    async abandonXenditAccountProvisioning() {
      throw new Error("not used in these tests");
    },
  };
  return repository;
}

const fakeHasher: PasswordHasherPort = {
  async hash(plain) {
    return `hashed:${plain}`;
  },
  async verify(plain, hash) {
    return hash === `hashed:${plain}`;
  },
};

/**
 * A hasher that counts `verify` calls, so a test can assert the use-case
 * pays the same hashing cost on every rejection path rather than
 * short-circuiting before ever hashing — a message/status comparison alone
 * cannot catch a timing side-channel.
 */
function fakeHasherWithCallCount(): { hasher: PasswordHasherPort; callCount: () => number } {
  let verifyCalls = 0;
  const hasher: PasswordHasherPort = {
    async hash(plain) {
      return `hashed:${plain}`;
    },
    async verify(plain, hash) {
      verifyCalls++;
      return hash === `hashed:${plain}`;
    },
  };
  return { hasher, callCount: () => verifyCalls };
}

const fakeIssuer: TokenIssuerPort = {
  async issue(payload) {
    return `token-for-${payload.creatorId}`;
  },
  async verify(token): Promise<TokenPayload | null> {
    const id = token.replace("token-for-", "");
    return id ? { creatorId: id } : null;
  },
};

describe("AuthenticateCreator", () => {
  it("returns a token for correct credentials", async () => {
    const useCase = new AuthenticateCreator(fakeRepository([credentials()]), fakeHasher, fakeIssuer);

    const result = await useCase.execute({
      email: "budi@example.com",
      password: "supersecret123",
    });

    expect(result.token).toBe("token-for-creator-1");
    expect(result.creator.id).toBe("creator-1");
  });

  it("rejects a wrong password", async () => {
    const useCase = new AuthenticateCreator(fakeRepository([credentials()]), fakeHasher, fakeIssuer);

    await expect(
      useCase.execute({ email: "budi@example.com", password: "wrong-password" })
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rejects an unknown email with the same error as a wrong password", async () => {
    const useCase = new AuthenticateCreator(fakeRepository([credentials()]), fakeHasher, fakeIssuer);

    const unknown = await useCase
      .execute({ email: "nobody@example.com", password: "supersecret123" })
      .catch((e) => e);
    const wrongPassword = await useCase
      .execute({ email: "budi@example.com", password: "wrong-password" })
      .catch((e) => e);

    // No account enumeration: both paths must be indistinguishable to the caller.
    expect(unknown).toBeInstanceOf(UnauthorizedError);
    expect(unknown.message).toBe(wrongPassword.message);
    expect(unknown.status).toBe(wrongPassword.status);
  });

  it("rejects an account that has no password set", async () => {
    const useCase = new AuthenticateCreator(
      fakeRepository([credentials({ passwordHash: null })]),
      fakeHasher,
      fakeIssuer
    );

    await expect(
      useCase.execute({ email: "budi@example.com", password: "supersecret123" })
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  // Guards against a timing side channel: throwing before ever calling
  // hasher.verify() makes the unknown-email path measurably faster than the
  // wrong-password path (which does call it), even though both throw an
  // identical error. This test fails against the pre-fix implementation,
  // which returns with zero verify() calls for an unknown email.
  it("calls hasher.verify on an unknown email, paying the same cost as a wrong password", async () => {
    const { hasher, callCount } = fakeHasherWithCallCount();
    const useCase = new AuthenticateCreator(fakeRepository([credentials()]), hasher, fakeIssuer);

    await useCase
      .execute({ email: "nobody@example.com", password: "supersecret123" })
      .catch(() => {});

    expect(callCount()).toBe(1);
  });

  // Same leak, second flavor: a password-less (e.g. WhatsApp-only) account
  // must not be distinguishable-by-timing from a wrong password either.
  it("calls hasher.verify for an account with no password set, paying the same cost as a wrong password", async () => {
    const { hasher, callCount } = fakeHasherWithCallCount();
    const useCase = new AuthenticateCreator(
      fakeRepository([credentials({ passwordHash: null })]),
      hasher,
      fakeIssuer
    );

    await useCase.execute({ email: "budi@example.com", password: "supersecret123" }).catch(() => {});

    expect(callCount()).toBe(1);
  });

  it("never returns the password hash", async () => {
    const useCase = new AuthenticateCreator(fakeRepository([credentials()]), fakeHasher, fakeIssuer);

    const result = await useCase.execute({
      email: "budi@example.com",
      password: "supersecret123",
    });

    expect("passwordHash" in result.creator).toBe(false);
  });
});
