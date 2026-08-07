import { describe, expect, it } from "bun:test";
import { RegisterCreator } from "./register-creator";
import { ConflictError } from "../errors";
import type { CreatorRecord, CreatorRepositoryPort } from "../ports/creator-repository.port";
import type { PasswordHasherPort } from "../ports/password-hasher.port";
import type { TokenIssuerPort, TokenPayload } from "../ports/token-issuer.port";

// Stores the hash alongside the record so the fake can serve
// findCredentialsByEmail, while `rows` stays free of it — mirroring the real
// repository, where only the dedicated lookup returns the hash.
function fakeRepository(seed: CreatorRecord[] = []) {
  const rows = [...seed];
  const hashes = new Map<string, string | null>();

  const repository: CreatorRepositoryPort = {
    async create(input) {
      const row: CreatorRecord = {
        id: `creator-${rows.length + 1}`,
        name: input.name,
        whatsappNumber: input.whatsappNumber ?? null,
        email: input.email ?? null,
        tierPlan: "starter",
        createdAt: new Date(),
      };
      rows.push(row);
      hashes.set(row.id, input.passwordHash ?? null);
      return row;
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
      return {
        id: row.id,
        name: row.name,
        email: row.email,
        passwordHash: hashes.get(row.id) ?? null,
      };
    },
  };
  return { repository, rows, hashes };
}

const fakeHasher: PasswordHasherPort = {
  async hash(plain) {
    return `hashed:${plain}`;
  },
  async verify(plain, hash) {
    return hash === `hashed:${plain}`;
  },
};

const fakeIssuer: TokenIssuerPort = {
  async issue(payload) {
    return `token-for-${payload.creatorId}`;
  },
  async verify(token): Promise<TokenPayload | null> {
    const id = token.replace("token-for-", "");
    return id ? { creatorId: id } : null;
  },
};

describe("RegisterCreator", () => {
  it("creates a creator with a hashed password and returns a token", async () => {
    const { repository, rows, hashes } = fakeRepository();
    const useCase = new RegisterCreator(repository, fakeHasher, fakeIssuer);

    const result = await useCase.execute({
      name: "Budi",
      email: "budi@example.com",
      password: "supersecret123",
    });

    expect(result.creator.email).toBe("budi@example.com");
    expect(result.token).toBe("token-for-creator-1");
    // The plaintext was hashed before it reached the repository.
    expect(hashes.get(rows[0].id)).toBe("hashed:supersecret123");
  });

  it("never returns the password hash to the caller", async () => {
    const { repository } = fakeRepository();
    const useCase = new RegisterCreator(repository, fakeHasher, fakeIssuer);

    const result = await useCase.execute({
      name: "Budi",
      email: "budi@example.com",
      password: "supersecret123",
    });

    expect(JSON.stringify(result.creator)).not.toContain("hashed:");
    expect("passwordHash" in result.creator).toBe(false);
  });

  it("normalizes the email before storing it", async () => {
    const { repository, rows } = fakeRepository();
    const useCase = new RegisterCreator(repository, fakeHasher, fakeIssuer);

    await useCase.execute({
      name: "Budi",
      email: "  BUDI@Example.COM ",
      password: "supersecret123",
    });

    expect(rows[0].email).toBe("budi@example.com");
  });

  it("rejects an email that is already registered", async () => {
    const { repository } = fakeRepository([
      {
        id: "existing",
        name: "Someone",
        whatsappNumber: null,
        email: "budi@example.com",
        tierPlan: "starter",
        createdAt: new Date(),
      },
    ]);
    const useCase = new RegisterCreator(repository, fakeHasher, fakeIssuer);

    await expect(
      useCase.execute({ name: "Budi", email: "BUDI@example.com", password: "supersecret123" })
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
