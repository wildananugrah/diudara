import { describe, expect, it } from "bun:test";
import { GetUserProfile } from "./get-user-profile";
import { NotFoundError } from "../errors";
import type { UserRecord, UserRepositoryPort } from "../ports/user-repository.port";

function record(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: "user-1",
    handle: "wildan",
    email: "wildan@example.com",
    whatsappNumber: "+6281234567890",
    displayName: "Wildan",
    bio: "Building DIUDARA",
    sessionEpoch: 0,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function fakeRepository(rows: UserRecord[]): UserRepositoryPort {
  return {
    async create() {
      throw new Error("not used in these tests");
    },
    async findByHandle(handle) {
      return rows.find((r) => r.handle === handle) ?? null;
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
    async setPasswordAndBumpEpoch() {
      throw new Error("not used in these tests");
    },
  };
}

describe("GetUserProfile.execute (public, by handle)", () => {
  it("returns EXACTLY handle/displayName/bio/createdAt — no email, whatsappNumber, id or sessionEpoch", async () => {
    const useCase = new GetUserProfile(fakeRepository([record()]));
    const profile = await useCase.execute("wildan");

    expect(Object.keys(profile).sort()).toEqual(["bio", "createdAt", "displayName", "handle"]);
    expect(profile).toEqual({
      handle: "wildan",
      displayName: "Wildan",
      bio: "Building DIUDARA",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
  });

  it("normalises a leading @ before looking the handle up", async () => {
    const useCase = new GetUserProfile(fakeRepository([record()]));
    const profile = await useCase.execute("@wildan");
    expect(profile.handle).toBe("wildan");
  });

  it("404s for an unknown handle", async () => {
    const useCase = new GetUserProfile(fakeRepository([]));
    await expect(useCase.execute("nobody")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("bio: null projects as null, not omitted or undefined", async () => {
    const useCase = new GetUserProfile(fakeRepository([record({ bio: null })]));
    const profile = await useCase.execute("wildan");
    expect(profile.bio).toBeNull();
    expect("bio" in profile).toBe(true);
  });
});

describe("GetUserProfile.executeOwn (authenticated, by id)", () => {
  it("returns the public fields PLUS email and whatsappNumber", async () => {
    const useCase = new GetUserProfile(fakeRepository([record()]));
    const profile = await useCase.executeOwn("user-1");

    expect(Object.keys(profile).sort()).toEqual([
      "bio",
      "createdAt",
      "displayName",
      "email",
      "handle",
      "whatsappNumber",
    ]);
    expect(profile.email).toBe("wildan@example.com");
    expect(profile.whatsappNumber).toBe("+6281234567890");
  });

  it("404s for an id that does not exist", async () => {
    const useCase = new GetUserProfile(fakeRepository([]));
    await expect(useCase.executeOwn("ghost")).rejects.toBeInstanceOf(NotFoundError);
  });
});
