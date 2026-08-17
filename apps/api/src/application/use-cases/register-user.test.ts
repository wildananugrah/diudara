import { describe, expect, it } from "bun:test";
import { RegisterUser } from "./register-user";
import { ConflictError, UniqueRule, UniqueViolationError, ValidationError } from "../errors";
import type { UserRecord, UserRepositoryPort } from "../ports/user-repository.port";
import type { PasswordHasherPort } from "../ports/password-hasher.port";

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

/**
 * A fake that mirrors `DrizzleUserRepository.create`'s behaviour: it raises
 * `UniqueViolationError` on a colliding handle OR email, exactly like the
 * real unique index does, rather than silently allowing two rows for one
 * logical handle/email.
 */
function fakeRepository(seed: UserRecord[] = []) {
  const rows = [...seed];
  const hashes = new Map<string, string>();

  const repository: UserRepositoryPort = {
    async create(input) {
      if (rows.some((r) => r.handle === input.handle)) {
        throw new UniqueViolationError(UniqueRule.userHandle, "handle is already taken");
      }
      if (rows.some((r) => r.email === input.email)) {
        throw new UniqueViolationError(UniqueRule.userEmail, "email is already registered");
      }
      const row: UserRecord = {
        id: `user-${rows.length + 1}`,
        handle: input.handle,
        email: input.email,
        whatsappNumber: input.whatsappNumber,
        displayName: input.displayName,
        bio: null,
        sessionEpoch: 0,
        createdAt: new Date(),
      };
      rows.push(row);
      hashes.set(row.id, input.passwordHash);
      return row;
    },
    async findByHandle(handle) {
      return rows.find((r) => r.handle === handle) ?? null;
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
      return { id: row.id, passwordHash: hashes.get(row.id) as string, sessionEpoch: row.sessionEpoch };
    },
    async updateProfile() {
      throw new Error("not used in these tests");
    },
    async setPasswordAndBumpEpoch() {
      throw new Error("not used in these tests");
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

function fakeHasherWithCallCount(): { hasher: PasswordHasherPort; callCount: () => number } {
  let hashCalls = 0;
  const hasher: PasswordHasherPort = {
    async hash(plain) {
      hashCalls++;
      return `hashed:${plain}`;
    },
    async verify(plain, hash) {
      return hash === `hashed:${plain}`;
    },
  };
  return { hasher, callCount: () => hashCalls };
}

const VALID = {
  handle: "wildan",
  email: "wildan@example.com",
  password: "supersecret123",
  displayName: "Wildan",
};

describe("RegisterUser", () => {
  it("creates a user with a hashed password", async () => {
    const { repository, rows, hashes } = fakeRepository();
    const useCase = new RegisterUser(repository, fakeHasher);

    const result = await useCase.execute(VALID);

    expect(result).toEqual({ ok: true });
    expect(rows).toHaveLength(1);
    expect(rows[0].handle).toBe("wildan");
    expect(rows[0].displayName).toBe("Wildan");
    expect(hashes.get(rows[0].id)).toBe("hashed:supersecret123");
  });

  it("passes displayName through to the repository unchanged", async () => {
    const { repository, rows } = fakeRepository();
    const useCase = new RegisterUser(repository, fakeHasher);

    await useCase.execute({ ...VALID, displayName: "Wildan Anugrah" });

    expect(rows[0].displayName).toBe("Wildan Anugrah");
  });

  it("passes a provided whatsappNumber through to the repository unchanged", async () => {
    const { repository, rows } = fakeRepository();
    const useCase = new RegisterUser(repository, fakeHasher);

    await useCase.execute({ ...VALID, whatsappNumber: "+6281234567890" });

    expect(rows[0].whatsappNumber).toBe("+6281234567890");
  });

  it("stores whatsappNumber as null when none is provided", async () => {
    const { repository, rows } = fakeRepository();
    const useCase = new RegisterUser(repository, fakeHasher);

    await useCase.execute(VALID);

    expect(rows[0].whatsappNumber).toBeNull();
  });

  it("normalises the handle before storing it, stripping a leading @ and lowercasing", async () => {
    const { repository, rows } = fakeRepository();
    const useCase = new RegisterUser(repository, fakeHasher);

    await useCase.execute({ ...VALID, handle: "  @Wildan  " });

    expect(rows[0].handle).toBe("wildan");
  });

  it("normalises the email before storing it", async () => {
    const { repository, rows } = fakeRepository();
    const useCase = new RegisterUser(repository, fakeHasher);

    await useCase.execute({ ...VALID, email: "  Wildan@Example.COM " });

    expect(rows[0].email).toBe("wildan@example.com");
  });

  it("rejects a handle that fails domain validation after normalisation", async () => {
    const { repository } = fakeRepository();
    const useCase = new RegisterUser(repository, fakeHasher);

    await expect(useCase.execute({ ...VALID, handle: "ab" })).rejects.toBeInstanceOf(
      ValidationError
    );
  });

  it("THE CENTRAL GUARANTEE: '@Wildan' and 'wildan' collide as the same handle", async () => {
    const { repository, rows } = fakeRepository();
    const useCase = new RegisterUser(repository, fakeHasher);

    await useCase.execute({ ...VALID, handle: "@Wildan", email: "first@example.com" });
    await expect(
      useCase.execute({ ...VALID, handle: "wildan", email: "second@example.com" })
    ).rejects.toBeInstanceOf(ConflictError);

    // Exactly one row exists for the logical identity, not two.
    expect(rows).toHaveLength(1);
  });

  it("rejects a duplicate handle with ConflictError (409) — handles are public, this is safe to reveal", async () => {
    const { repository } = fakeRepository([record({ handle: "wildan", email: "someone@example.com" })]);
    const useCase = new RegisterUser(repository, fakeHasher);

    await expect(
      useCase.execute({ ...VALID, handle: "wildan", email: "new@example.com" })
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("REGRESSION (critical): a taken handle 409s even when the email in the same request is ALSO already registered", async () => {
    // The bug this pins: an earlier version checked email BEFORE handle and
    // returned `{ ok: true }` on a hit, so `create()` — and with it the
    // handle-uniqueness check — never ran when the email was already
    // registered. A taken handle then 409'd ONLY when paired with a FREE
    // email, and silently answered success when paired with a REGISTERED
    // one. Since handles are public, that turned "is this handle taken"
    // into "does this email have an account" — the exact oracle this class
    // exists to prevent — discoverable with one known handle and a guessed
    // email, no setup required. Every OTHER duplicate-email test in this
    // file pairs it with a FREE handle, which is precisely the one
    // combination that already answered identically; this is the one
    // combination that didn't.
    const { repository, rows } = fakeRepository([
      record({ handle: "taken", email: "registered@example.com" }),
    ]);
    const useCase = new RegisterUser(repository, fakeHasher);

    await expect(
      useCase.execute({ ...VALID, handle: "taken", email: "registered@example.com" })
    ).rejects.toBeInstanceOf(ConflictError);

    // No second row, and the existing one is untouched.
    expect(rows).toHaveLength(1);
  });

  it("returns success-shaped output for a duplicate email, rather than throwing — enumeration safety", async () => {
    const { repository, rows } = fakeRepository([
      record({ handle: "existing", email: "wildan@example.com" }),
    ]);
    const useCase = new RegisterUser(repository, fakeHasher);

    const result = await useCase.execute({ ...VALID, handle: "newhandle" });

    expect(result).toEqual({ ok: true });
    // No new row was created for the duplicate email.
    expect(rows).toHaveLength(1);
  });

  it("returns the identical shape for a fresh signup and a duplicate email", async () => {
    const { repository } = fakeRepository([
      record({ handle: "existing", email: "wildan@example.com" }),
    ]);
    const useCase = new RegisterUser(repository, fakeHasher);

    const fresh = await useCase.execute({ ...VALID, handle: "freshone", email: "fresh@example.com" });
    const duplicate = await useCase.execute({ ...VALID, handle: "anotherone" });

    expect(fresh).toEqual(duplicate);
  });

  it("hashes the password even on the duplicate-email path, so response time is not an oracle", async () => {
    const { hasher, callCount } = fakeHasherWithCallCount();
    const { repository } = fakeRepository([
      record({ handle: "existing", email: "wildan@example.com" }),
    ]);
    const useCase = new RegisterUser(repository, hasher);

    await useCase.execute(VALID);

    expect(callCount()).toBe(1);
  });

  it("still answers { ok: true } when a race loses to a concurrent signup with the same email", async () => {
    // The pre-check (`findByEmail`) can pass for two concurrent callers; the
    // database's unique index is the real arbiter. This drives the use-case
    // through the `create()`-throws-UniqueViolationError(userEmail) branch
    // directly, rather than the pre-check branch above.
    const { repository, rows } = fakeRepository();
    const originalCreate = repository.create.bind(repository);
    repository.create = async (input) => {
      if (input.email === "racer@example.com") {
        throw new UniqueViolationError(UniqueRule.userEmail, "email is already registered");
      }
      return originalCreate(input);
    };
    const useCase = new RegisterUser(repository, fakeHasher);

    const result = await useCase.execute({ ...VALID, email: "racer@example.com" });

    expect(result).toEqual({ ok: true });
    expect(rows).toHaveLength(0);
  });
});
