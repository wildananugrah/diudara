import { describe, expect, it } from "bun:test";
import { UpdateUserProfile } from "./update-user-profile";
import { NotFoundError } from "../errors";
import type { UserRecord, UserRepositoryPort } from "../ports/user-repository.port";

function record(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: "user-1",
    handle: "wildan",
    email: "wildan@example.com",
    whatsappNumber: null,
    displayName: "Wildan",
    bio: "Building DIUDARA",
    sessionEpoch: 0,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

/**
 * Mirrors `DrizzleUserRepository.updateProfile`'s own undefined-vs-null
 * distinction, rather than a naive `{ ...row, ...patch }` merge that would
 * treat an absent key the same as one explicitly set to `undefined`.
 */
function fakeRepository(rows: UserRecord[]): UserRepositoryPort {
  return {
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
    async updateProfile(id, patch) {
      const row = rows.find((r) => r.id === id);
      if (!row) return null;
      if (patch.displayName !== undefined) row.displayName = patch.displayName;
      if (patch.bio !== undefined) row.bio = patch.bio;
      if (patch.whatsappNumber !== undefined) row.whatsappNumber = patch.whatsappNumber;
      return row;
    },
    async setPasswordAndBumpEpoch() {
      throw new Error("not used in these tests");
    },
    async searchPublic() {
      throw new Error("not used in these tests");
    },
    async newestPublic() {
      throw new Error("not used in these tests");
    },
    async mostFollowedPublic() {
      throw new Error("not used in these tests");
    },
  };
}

describe("UpdateUserProfile", () => {
  it("updates displayName and returns the own-profile projection", async () => {
    const useCase = new UpdateUserProfile(fakeRepository([record()]));
    const result = await useCase.execute({ userId: "user-1", patch: { displayName: "Wildan A." } });

    expect(result.displayName).toBe("Wildan A.");
    expect(Object.keys(result).sort()).toEqual([
      "bio",
      "createdAt",
      "displayName",
      "email",
      "handle",
      "whatsappNumber",
    ]);
  });

  it("an explicit null bio clears it", async () => {
    const rows = [record({ bio: "old bio" })];
    const useCase = new UpdateUserProfile(fakeRepository(rows));
    const result = await useCase.execute({ userId: "user-1", patch: { bio: null } });
    expect(result.bio).toBeNull();
  });

  it("an absent bio leaves the existing value alone", async () => {
    const rows = [record({ bio: "old bio" })];
    const useCase = new UpdateUserProfile(fakeRepository(rows));
    const result = await useCase.execute({ userId: "user-1", patch: { displayName: "New Name" } });
    expect(result.bio).toBe("old bio");
  });

  it("404s for a user id that does not exist", async () => {
    const useCase = new UpdateUserProfile(fakeRepository([]));
    await expect(
      useCase.execute({ userId: "ghost", patch: { displayName: "X" } })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  /**
   * Item 1 of the whole-branch review: `whatsappNumber` had a write (signup)
   * and a read (`GET /users/me`) but no update path at all, which made spec
   * §8's "a wrong address costs them one reset channel and nothing else"
   * false — a mistyped number could never be fixed. Same round-trip/clear/
   * absent trio `bio` already has, immediately above.
   */
  it("sets a whatsappNumber that was previously null — the round-trip", async () => {
    const rows = [record({ whatsappNumber: null })];
    const useCase = new UpdateUserProfile(fakeRepository(rows));
    const result = await useCase.execute({
      userId: "user-1",
      patch: { whatsappNumber: "+6281234567890" },
    });
    expect(result.whatsappNumber).toBe("+6281234567890");
  });

  it("an explicit null whatsappNumber clears it", async () => {
    const rows = [record({ whatsappNumber: "+6281234567890" })];
    const useCase = new UpdateUserProfile(fakeRepository(rows));
    const result = await useCase.execute({ userId: "user-1", patch: { whatsappNumber: null } });
    expect(result.whatsappNumber).toBeNull();
  });

  it("an absent whatsappNumber leaves the existing value alone", async () => {
    const rows = [record({ whatsappNumber: "+6281234567890" })];
    const useCase = new UpdateUserProfile(fakeRepository(rows));
    const result = await useCase.execute({ userId: "user-1", patch: { displayName: "New Name" } });
    expect(result.whatsappNumber).toBe("+6281234567890");
  });
});
