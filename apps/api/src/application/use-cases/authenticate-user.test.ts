import { describe, expect, it } from "bun:test";
import { AuthenticateUser } from "./authenticate-user";
import { UnauthorizedError } from "../errors";
import type { UserCredentials, UserRecord, UserRepositoryPort } from "../ports/user-repository.port";
import type { PasswordHasherPort } from "../ports/password-hasher.port";
import type { UserTokenIssuerPort, UserTokenPayload } from "../ports/user-token-issuer.port";

function record(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: "user-1",
    handle: "wildan",
    email: "wildan@example.com",
    whatsappNumber: null,
    displayName: "Wildan",
    bio: null,
    sessionEpoch: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

function fakeRepository(rows: UserRecord[], credentials: UserCredentials[]) {
  const repository: UserRepositoryPort = {
    async create() {
      throw new Error("not used in these tests");
    },
    async findByHandle() {
      throw new Error("not used in these tests");
    },
    async findById(id) {
      return rows.find((r) => r.id === id) ?? null;
    },
    async findByEmail(email) {
      return rows.find((r) => r.email === email) ?? null;
    },
    async findCredentialsByEmail(email) {
      const row = rows.find((r) => r.email === email);
      if (!row) return null;
      return credentials.find((c) => c.id === row.id) ?? null;
    },
    async updateProfile() {
      throw new Error("not used in these tests");
    },
    async setPasswordAndBumpEpoch() {
      throw new Error("not used in these tests");
    },
  };
  return repository;
}

function seeded(overrides: Partial<UserRecord & UserCredentials> = {}) {
  const row = record(overrides);
  const credentials: UserCredentials = {
    id: row.id,
    passwordHash: overrides.passwordHash ?? "hashed:supersecret123",
    sessionEpoch: row.sessionEpoch,
  };
  return fakeRepository([row], [credentials]);
}

const fakeHasher: PasswordHasherPort = {
  async hash(plain) {
    return `hashed:${plain}`;
  },
  async verify(plain, hash) {
    return hash === `hashed:${plain}`;
  },
};

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

const fakeIssuer: UserTokenIssuerPort = {
  async issue(payload) {
    return `token-for-${payload.userId}-epoch-${payload.sessionEpoch}`;
  },
  async verify(token): Promise<UserTokenPayload | null> {
    const match = token.match(/^token-for-(.+)-epoch-(\d+)$/);
    return match ? { userId: match[1], sessionEpoch: Number(match[2]) } : null;
  },
};

describe("AuthenticateUser", () => {
  it("returns a token and public profile for correct credentials", async () => {
    const useCase = new AuthenticateUser(seeded(), fakeHasher, fakeIssuer);

    const result = await useCase.execute({
      email: "wildan@example.com",
      password: "supersecret123",
    });

    expect(result.token).toBe("token-for-user-1-epoch-0");
    expect(result.user.id).toBe("user-1");
    expect(result.user.handle).toBe("wildan");
  });

  it("issues a token carrying the user's current sessionEpoch", async () => {
    const useCase = new AuthenticateUser(seeded({ sessionEpoch: 4 }), fakeHasher, fakeIssuer);

    const result = await useCase.execute({
      email: "wildan@example.com",
      password: "supersecret123",
    });

    expect(result.token).toBe("token-for-user-1-epoch-4");
  });

  it("rejects a wrong password", async () => {
    const useCase = new AuthenticateUser(seeded(), fakeHasher, fakeIssuer);

    await expect(
      useCase.execute({ email: "wildan@example.com", password: "wrong-password" })
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("gives the identical error for an unknown email and a wrong password", async () => {
    const useCase = new AuthenticateUser(seeded(), fakeHasher, fakeIssuer);

    const unknown = await useCase
      .execute({ email: "nobody@example.com", password: "supersecret123" })
      .catch((e) => e);
    const wrongPassword = await useCase
      .execute({ email: "wildan@example.com", password: "wrong-password" })
      .catch((e) => e);

    expect(unknown).toBeInstanceOf(UnauthorizedError);
    expect(unknown.message).toBe(wrongPassword.message);
    expect(unknown.status).toBe(wrongPassword.status);
  });

  it("calls hasher.verify on an unknown email, paying the same cost as a wrong password", async () => {
    const { hasher, callCount } = fakeHasherWithCallCount();
    const useCase = new AuthenticateUser(seeded(), hasher, fakeIssuer);

    await useCase
      .execute({ email: "nobody@example.com", password: "supersecret123" })
      .catch(() => {});

    expect(callCount()).toBe(1);
  });

  it("never returns the password hash", async () => {
    const useCase = new AuthenticateUser(seeded(), fakeHasher, fakeIssuer);

    const result = await useCase.execute({
      email: "wildan@example.com",
      password: "supersecret123",
    });

    expect("passwordHash" in result.user).toBe(false);
    expect(JSON.stringify(result.user)).not.toContain("hashed:");
  });

  it("accepts a differently-cased email", async () => {
    const useCase = new AuthenticateUser(seeded(), fakeHasher, fakeIssuer);

    const result = await useCase.execute({
      email: "WILDAN@Example.COM",
      password: "supersecret123",
    });

    expect(result.user.id).toBe("user-1");
  });
});
