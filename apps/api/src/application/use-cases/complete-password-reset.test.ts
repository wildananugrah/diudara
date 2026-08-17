import { describe, expect, it } from "bun:test";
import { CompletePasswordReset } from "./complete-password-reset";
import { UnauthorizedError } from "../errors";
import { hashResetToken, mintResetToken } from "../../domain/reset-token";
import type { ClockPort } from "../ports/clock.port";
import type { PasswordHasherPort } from "../ports/password-hasher.port";
import type {
  PasswordResetRepositoryPort,
  PasswordResetTokenRecord,
} from "../ports/password-reset-repository.port";
import type {
  PasswordResetRepositories,
  PasswordResetUnitOfWorkPort,
} from "../ports/password-reset-unit-of-work.port";
import type { UserRecord, UserRepositoryPort } from "../ports/user-repository.port";

function userRecord(overrides: Partial<UserRecord> = {}): UserRecord {
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

/** In-memory `UserRepositoryPort` whose `setPasswordAndBumpEpoch` actually bumps — the property under test. */
function fakeUserRepository(seed: UserRecord[]) {
  const rows = [...seed];
  const hashes = new Map<string, string>();
  const repo: UserRepositoryPort = {
    async create() {
      throw new Error("not used in these tests");
    },
    async findByHandle() {
      throw new Error("not used in these tests");
    },
    async findById(id) {
      return rows.find((r) => r.id === id) ?? null;
    },
    async findByEmail() {
      throw new Error("not used in these tests");
    },
    async findCredentialsByEmail() {
      throw new Error("not used in these tests");
    },
    async updateProfile() {
      throw new Error("not used in these tests");
    },
    async setPasswordAndBumpEpoch(id, passwordHash) {
      const row = rows.find((r) => r.id === id);
      if (!row) return false;
      row.sessionEpoch += 1;
      hashes.set(id, passwordHash);
      return true;
    },
  };
  return { repo, rows, hashes };
}

function fakePasswordResetRepository(seed: PasswordResetTokenRecord[]) {
  const rows = [...seed];
  const repo: PasswordResetRepositoryPort = {
    async create() {
      throw new Error("not used in these tests");
    },
    async findByHash(tokenHash) {
      return rows.find((r) => r.tokenHash === tokenHash) ?? null;
    },
    async countForUserSince() {
      throw new Error("not used in these tests");
    },
    async countForIpSince() {
      throw new Error("not used in these tests");
    },
    async markUsed(id) {
      const row = rows.find((r) => r.id === id);
      if (!row || row.usedAt !== null) return false;
      row.usedAt = new Date();
      return true;
    },
    async markAllOtherOutstandingUsed(userId, exceptId) {
      let affected = 0;
      for (const row of rows) {
        if (row.userId === userId && row.id !== exceptId && row.usedAt === null) {
          row.usedAt = new Date();
          affected += 1;
        }
      }
      return affected;
    },
  };
  return { repo, rows };
}

/**
 * Runs `work` directly against the SAME in-memory fakes — mirrors
 * `FakeJoinRequestUnitOfWork` (decide-join-request.test.ts /
 * request-to-join.test.ts): there is no real transaction to fake, so "the
 * unit of work" here is simply "the two repositories the use-case is
 * allowed to write through inside `run`".
 */
class FakePasswordResetUnitOfWork implements PasswordResetUnitOfWorkPort {
  runCallCount = 0;
  constructor(private readonly repositories: PasswordResetRepositories) {}
  async run<T>(work: (repositories: PasswordResetRepositories) => Promise<T>): Promise<T> {
    this.runCallCount += 1;
    return work(this.repositories);
  }
}

const fakeHasher: PasswordHasherPort = {
  async hash(plain) {
    return `hashed:${plain}`;
  },
  async verify(plain, hash) {
    return hash === `hashed:${plain}`;
  },
};

/** Tracks calls to `hash()` — used to prove the invalid-token paths never pay the argon2id cost. */
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

const NOW = new Date("2026-08-17T10:00:00.000Z");
const fixedClock: ClockPort = { now: () => new Date(NOW.getTime()) };

function tokenRecord(overrides: Partial<PasswordResetTokenRecord> = {}): PasswordResetTokenRecord {
  const { tokenHash } = mintResetToken();
  return {
    id: "token-1",
    userId: "user-1",
    tokenHash,
    expiresAt: new Date(NOW.getTime() + 30 * 60 * 1000),
    usedAt: null,
    createdAt: new Date(NOW.getTime() - 1000),
    ...overrides,
  };
}

function harness(options: {
  users?: UserRecord[];
  tokens?: PasswordResetTokenRecord[];
  clock?: ClockPort;
  hasher?: PasswordHasherPort;
} = {}) {
  const { repo: users, rows: userRows, hashes } = fakeUserRepository(options.users ?? [userRecord()]);
  const { repo: passwordResets, rows: tokenRows } = fakePasswordResetRepository(options.tokens ?? []);
  const unitOfWork = new FakePasswordResetUnitOfWork({ passwordResets, users });
  const useCase = new CompletePasswordReset(
    passwordResets,
    options.hasher ?? fakeHasher,
    unitOfWork,
    options.clock ?? fixedClock
  );
  return { useCase, userRows, tokenRows, hashes, unitOfWork };
}

describe("CompletePasswordReset", () => {
  it("sets the password, bumps the epoch by exactly one, and marks the token used", async () => {
    const { token, tokenHash } = mintResetToken();
    const { useCase, userRows, tokenRows, hashes } = harness({
      tokens: [tokenRecord({ id: "token-1", userId: "user-1", tokenHash })],
    });

    const result = await useCase.execute({ token, newPassword: "brand-new-password" });

    expect(result).toEqual({ ok: true });
    expect(userRows[0].sessionEpoch).toBe(1);
    expect(hashes.get("user-1")).toBe("hashed:brand-new-password");
    expect(tokenRows[0].usedAt).not.toBeNull();
  });

  it("marks a SECOND outstanding token for the same user used too", async () => {
    const { token, tokenHash } = mintResetToken();
    const other = mintResetToken();
    const { useCase, tokenRows } = harness({
      tokens: [
        tokenRecord({ id: "token-1", userId: "user-1", tokenHash }),
        tokenRecord({ id: "token-2", userId: "user-1", tokenHash: other.tokenHash }),
      ],
    });

    await useCase.execute({ token, newPassword: "brand-new-password" });

    const second = tokenRows.find((r) => r.id === "token-2");
    expect(second?.usedAt).not.toBeNull();
  });

  it("never touches another user's outstanding token", async () => {
    const { token, tokenHash } = mintResetToken();
    const otherUsersToken = mintResetToken();
    const { useCase, tokenRows } = harness({
      users: [userRecord({ id: "user-1" }), userRecord({ id: "user-2", handle: "someoneelse", email: "b@example.com" })],
      tokens: [
        tokenRecord({ id: "token-1", userId: "user-1", tokenHash }),
        tokenRecord({ id: "token-2", userId: "user-2", tokenHash: otherUsersToken.tokenHash }),
      ],
    });

    await useCase.execute({ token, newPassword: "brand-new-password" });

    const other = tokenRows.find((r) => r.id === "token-2");
    expect(other?.usedAt).toBeNull();
  });

  it("runs everything through the unit of work exactly once", async () => {
    const { token, tokenHash } = mintResetToken();
    const { useCase, unitOfWork } = harness({
      tokens: [tokenRecord({ id: "token-1", userId: "user-1", tokenHash })],
    });

    await useCase.execute({ token, newPassword: "brand-new-password" });

    expect(unitOfWork.runCallCount).toBe(1);
  });

  it("refuses an UNKNOWN token with a generic 401", async () => {
    const { useCase } = harness({ tokens: [] });

    await expect(useCase.execute({ token: "not-a-real-token", newPassword: "x".repeat(10) })).rejects.toBeInstanceOf(
      UnauthorizedError
    );
  });

  it("refuses an EXPIRED token with the SAME generic 401", async () => {
    const { token, tokenHash } = mintResetToken();
    const { useCase } = harness({
      tokens: [tokenRecord({ id: "token-1", userId: "user-1", tokenHash, expiresAt: new Date(NOW.getTime() - 1) })],
    });

    await expect(useCase.execute({ token, newPassword: "x".repeat(10) })).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("refuses an ALREADY-USED token with the SAME generic 401", async () => {
    const { token, tokenHash } = mintResetToken();
    const { useCase } = harness({
      tokens: [tokenRecord({ id: "token-1", userId: "user-1", tokenHash, usedAt: new Date(NOW.getTime() - 1000) })],
    });

    await expect(useCase.execute({ token, newPassword: "x".repeat(10) })).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("all three refusals (missing, expired, used) throw the IDENTICAL error message", async () => {
    const { token: expiredToken, tokenHash: expiredHash } = mintResetToken();
    const { token: usedToken, tokenHash: usedHash } = mintResetToken();
    const { useCase } = harness({
      tokens: [
        tokenRecord({ id: "t1", userId: "user-1", tokenHash: expiredHash, expiresAt: new Date(NOW.getTime() - 1) }),
        tokenRecord({ id: "t2", userId: "user-1", tokenHash: usedHash, usedAt: new Date(NOW.getTime() - 1) }),
      ],
    });

    const messages: string[] = [];
    for (const t of ["unknown-token", expiredToken, usedToken]) {
      try {
        await useCase.execute({ token: t, newPassword: "x".repeat(10) });
      } catch (err) {
        messages.push(err instanceof Error ? err.message : String(err));
      }
    }

    expect(messages).toHaveLength(3);
    expect(new Set(messages).size).toBe(1);
  });

  it("does not change the password or epoch when the token is invalid", async () => {
    const { useCase, userRows } = harness({ tokens: [] });

    await expect(useCase.execute({ token: "garbage", newPassword: "x".repeat(10) })).rejects.toThrow();

    expect(userRows[0].sessionEpoch).toBe(0);
  });

  it("is not fooled by a valid-looking hex string that was never minted", async () => {
    const { useCase } = harness({ tokens: [] });

    await expect(
      useCase.execute({ token: "a".repeat(64), newPassword: "x".repeat(10) })
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("hashes by sha256 to look the token up — a caller cannot present the hash itself as the token", async () => {
    const { token, tokenHash } = mintResetToken();
    const { useCase } = harness({
      tokens: [tokenRecord({ id: "token-1", userId: "user-1", tokenHash })],
    });

    // Presenting the STORED HASH as if it were the token must not verify —
    // hashResetToken(tokenHash) is a different value from tokenHash itself.
    await expect(
      useCase.execute({ token: tokenHash, newPassword: "x".repeat(10) })
    ).rejects.toBeInstanceOf(UnauthorizedError);

    // The real token still works afterwards.
    const result = await useCase.execute({ token, newPassword: "x".repeat(10) });
    expect(result).toEqual({ ok: true });
  });

  it("hashResetToken sanity: the fixture's tokenHash really is hashResetToken(token)", () => {
    const { token, tokenHash } = mintResetToken();
    expect(tokenHash).toBe(hashResetToken(token));
  });

  /**
   * Review finding (minor): deleting the `usedAt` pre-check (leaving only
   * `record === null` and the expiry check) survives every OTHER test green
   * — `markUsed`'s own conditional UPDATE still refuses a used token and
   * still throws the identical 401. What that mutation would reopen is a
   * TIMING oracle: a used token would then pay the ~argon2id hash cost
   * before failing, while an unknown or expired token still fails
   * instantly. This pins the real property — no invalid path, of any of
   * the three kinds, ever reaches the hasher — rather than only the
   * observable status/message, which the mutation leaves untouched.
   */
  it("never hashes the new password for a missing, expired, or already-used token", async () => {
    const { token: expiredToken, tokenHash: expiredHash } = mintResetToken();
    const { token: usedToken, tokenHash: usedHash } = mintResetToken();
    const { hasher, callCount } = fakeHasherWithCallCount();
    const { useCase } = harness({
      tokens: [
        tokenRecord({ id: "t1", userId: "user-1", tokenHash: expiredHash, expiresAt: new Date(NOW.getTime() - 1) }),
        tokenRecord({ id: "t2", userId: "user-1", tokenHash: usedHash, usedAt: new Date(NOW.getTime() - 1) }),
      ],
      hasher,
    });

    for (const t of ["unknown-token", expiredToken, usedToken]) {
      await expect(useCase.execute({ token: t, newPassword: "x".repeat(10) })).rejects.toBeInstanceOf(
        UnauthorizedError
      );
    }

    expect(callCount()).toBe(0);
  });
});
