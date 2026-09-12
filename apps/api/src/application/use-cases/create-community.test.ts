import { describe, expect, it } from "bun:test";
import { CreateCommunity } from "./create-community";
import { ConflictError, UniqueRule, UniqueViolationError, ValidationError } from "../errors";
import type { UserRecord, UserRepositoryPort } from "../ports/user-repository.port";
import type {
  CommunityRecord,
  CommunityRepositoryPort,
} from "../ports/community-repository.port";

function record(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: "user-1",
    handle: "wildan",
    email: "wildan@example.com",
    whatsappNumber: null,
    displayName: "Wildan",
    bio: null,
    sessionEpoch: 0,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function fakeUserRepository(rows: UserRecord[]): UserRepositoryPort {
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

/**
 * In-memory stand-in for `CommunityRepositoryPort`. It does NOT re-implement
 * `DrizzleCommunityRepository`'s guarantees — the transaction, the unique
 * index, the ON CONFLICT idempotency are proven against a real Postgres in
 * `drizzle-community.repository.test.ts`. This exists to prove `CreateCommunity`
 * calls the port correctly, and above all that it does NOT call it at all when
 * a precondition fails: `createCalls` is what those tests assert on.
 */
class FakeCommunityRepository implements CommunityRepositoryPort {
  createCalls = 0;
  /** Set to a slug to make `create` raise the uniqueness error the index would. */
  takenSlug: string | null = null;

  async create(input: {
    ownerId: string;
    slug: string;
    name: string;
    category: string;
    description: string | null;
    tags?: string[];
  }): Promise<CommunityRecord> {
    this.createCalls += 1;
    if (this.takenSlug === input.slug) {
      throw new UniqueViolationError(UniqueRule.communitySlug, "slug taken");
    }
    return {
      id: "community-1",
      ownerId: input.ownerId,
      slug: input.slug,
      name: input.name,
      category: input.category,
      description: input.description,
      createdAt: new Date("2026-02-01T00:00:00Z"),
      tags: input.tags ?? [],
    };
  }

  async findBySlug(): Promise<CommunityRecord | null> {
    throw new Error("not used in these tests");
  }
  async findById(): Promise<CommunityRecord | null> {
    throw new Error("not used in these tests");
  }
  async browse(): Promise<never> {
    throw new Error("not used in these tests");
  }
  async setTags(): Promise<never> {
    throw new Error("not used in these tests");
  }
  async popularTags(): Promise<never> {
    throw new Error("not used in these tests");
  }
  async liveByOwner() {
    return new Map();
  }
  async cheapestActivePrices() {
    return new Map();
  }
  async memberCountFor(): Promise<number> {
    throw new Error("not used in these tests");
  }
  async isMember(): Promise<boolean> {
    throw new Error("not used in these tests");
  }
  async join(): Promise<boolean> {
    throw new Error("not used in these tests");
  }
  async leave(): Promise<boolean> {
    throw new Error("not used in these tests");
  }
  async listMembers(): Promise<never> {
    throw new Error("not used in these tests");
  }
  /** Phase 8b. Not reached by these tests — direct messages have their own suite. */
  async sharesCommunityWith() {
    return false;
  }
}

function subject(communities = new FakeCommunityRepository()) {
  return {
    communities,
    useCase: new CreateCommunity(fakeUserRepository([record()]), communities),
  };
}

describe("CreateCommunity", () => {
  it("derives the slug from the name and answers with the detail", async () => {
    const { useCase } = subject();

    const detail = await useCase.execute({
      ownerId: "user-1",
      name: "Bimbel Matematika Pak Andi",
      category: "Bimbel & Ujian",
      description: null,
    });

    expect(detail.slug).toBe("bimbel-matematika-pak-andi");
    expect(detail.name).toBe("Bimbel Matematika Pak Andi");
    expect(detail.ownerHandle).toBe("wildan");
    expect(detail.ownerDisplayName).toBe("Wildan");
  });

  it("makes the owner a member of their own community", async () => {
    const { useCase } = subject();

    const detail = await useCase.execute({
      ownerId: "user-1",
      name: "Kelas Desain",
      category: "Skill Digital",
      description: null,
    });

    expect(detail.memberCount).toBe(1);
    expect(detail.viewerIsMember).toBe(true);
    expect(detail.viewerIsOwner).toBe(true);
    // A brand-new community has no tiers yet and (per this fake) no live
    // stream — computed the same way `GetCommunity` computes it, not
    // hardcoded, so an owner who happens to already be live elsewhere would
    // still show correctly the moment this use case starts asking for real.
    expect(detail.live).toBeNull();
    expect(detail.price).toBeNull();
  });

  it("normalises and passes tags through to the repository", async () => {
    const { useCase } = subject();

    const detail = await useCase.execute({
      ownerId: "user-1",
      name: "Kelas Desain",
      category: "Skill Digital",
      description: null,
      tags: ["  #Desain  ", "Desain", "UI"],
    });

    expect(detail.tags).toEqual(["desain", "ui"]);
  });

  it("defaults to no tags when none are given", async () => {
    const { useCase } = subject();

    const detail = await useCase.execute({
      ownerId: "user-1",
      name: "Kelas Desain",
      category: "Skill Digital",
      description: null,
    });

    expect(detail.tags).toEqual([]);
  });

  it("refuses more tags than the cap WITHOUT reaching the repository", async () => {
    const { communities, useCase } = subject();

    await expect(
      useCase.execute({
        ownerId: "user-1",
        name: "Kelas Desain",
        category: "Skill Digital",
        description: null,
        tags: ["a", "b", "c", "d", "e", "f"],
      })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(communities.createCalls).toBe(0);
  });

  it("refuses a name with nothing sluggable WITHOUT reaching the repository", async () => {
    const { communities, useCase } = subject();

    await expect(
      useCase.execute({
        ownerId: "user-1",
        name: "!!! ???",
        category: "Skill Digital",
        description: null,
      })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(communities.createCalls).toBe(0);
  });

  it("refuses a reserved slug WITHOUT reaching the repository", async () => {
    const { communities, useCase } = subject();

    await expect(
      useCase.execute({
        ownerId: "user-1",
        name: "Baru",
        category: "Skill Digital",
        description: null,
      })
    ).rejects.toBeInstanceOf(ConflictError);
    expect(communities.createCalls).toBe(0);
  });

  it("surfaces a slug the index has already given away as a conflict", async () => {
    const communities = new FakeCommunityRepository();
    communities.takenSlug = "kelas-desain";
    const { useCase } = subject(communities);

    await expect(
      useCase.execute({
        ownerId: "user-1",
        name: "Kelas Desain",
        category: "Skill Digital",
        description: null,
      })
    ).rejects.toBeInstanceOf(ConflictError);
    expect(communities.createCalls).toBe(1);
  });
});
