import { describe, expect, it } from "bun:test";
import { GetCommunity } from "./get-community";
import { NotFoundError } from "../errors";
import type { UserRecord, UserRepositoryPort } from "../ports/user-repository.port";
import type {
  CommunityRecord,
  CommunityRepositoryPort,
} from "../ports/community-repository.port";

function record(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: "owner-1",
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

const community: CommunityRecord = {
  id: "community-1",
  ownerId: "owner-1",
  slug: "kelas-desain",
  name: "Kelas Desain",
  category: "Skill Digital",
  description: null,
  createdAt: new Date("2026-02-01T00:00:00Z"),
  tags: ["desain", "ui"],
};

/**
 * In-memory stand-in — see `create-community.test.ts` for why these fakes do
 * not re-implement the adapter's guarantees. `isMemberCalls` is asserted on
 * so a signed-out read is proven never to ask a membership question it has
 * no id to answer.
 */
class FakeCommunityRepository implements CommunityRepositoryPort {
  isMemberCalls = 0;
  members = new Set<string>();
  live = new Map<string, { streamId: string; viewerCount: number }>();
  prices = new Map<string, { amount: number; billingCycle: string }>();
  liveByOwnerCalls: string[][] = [];
  cheapestActivePricesCalls: string[][] = [];

  constructor(private readonly rows: CommunityRecord[]) {}

  async create(): Promise<CommunityRecord> {
    throw new Error("not used in these tests");
  }
  async findBySlug(slug: string): Promise<CommunityRecord | null> {
    return this.rows.find((r) => r.slug === slug) ?? null;
  }
  async findById(id: string): Promise<CommunityRecord | null> {
    return this.rows.find((r) => r.id === id) ?? null;
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
  async liveByOwner(ownerIds: string[]) {
    this.liveByOwnerCalls.push(ownerIds);
    return new Map(ownerIds.filter((id) => this.live.has(id)).map((id) => [id, this.live.get(id)!]));
  }
  async cheapestActivePrices(communityIds: string[]) {
    this.cheapestActivePricesCalls.push(communityIds);
    return new Map(
      communityIds.filter((id) => this.prices.has(id)).map((id) => [id, this.prices.get(id)!])
    );
  }
  async memberCountFor(): Promise<number> {
    return this.members.size;
  }
  async isMember(_communityId: string, userId: string): Promise<boolean> {
    this.isMemberCalls += 1;
    return this.members.has(userId);
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

function subject() {
  const communities = new FakeCommunityRepository([community]);
  communities.members.add("owner-1");
  return {
    communities,
    useCase: new GetCommunity(fakeUserRepository([record()]), communities),
  };
}

describe("GetCommunity", () => {
  it("answers 404 for a slug nobody holds", async () => {
    const { useCase } = subject();

    await expect(useCase.execute({ slug: "tidak-ada", viewerId: null })).rejects.toBeInstanceOf(
      NotFoundError
    );
  });

  it("reports viewerIsMember as null for a signed-out viewer, never false", async () => {
    const { communities, useCase } = subject();

    const detail = await useCase.execute({ slug: "kelas-desain", viewerId: null });

    expect(detail.viewerIsMember).toBe(null);
    expect(detail.viewerIsOwner).toBe(false);
    expect(communities.isMemberCalls).toBe(0);
  });

  it("reports viewerIsMember as false for a signed-in non-member", async () => {
    const { useCase } = subject();

    const detail = await useCase.execute({ slug: "kelas-desain", viewerId: "stranger-1" });

    expect(detail.viewerIsMember).toBe(false);
    expect(detail.viewerIsOwner).toBe(false);
  });

  it("carries the community's tags", async () => {
    const { useCase } = subject();

    const detail = await useCase.execute({ slug: "kelas-desain", viewerId: null });

    expect(detail.tags).toEqual(["desain", "ui"]);
  });

  it("carries the owner's live status and the cheapest active price, keyed by this one community", async () => {
    const { communities, useCase } = subject();
    communities.live.set("owner-1", { streamId: "stream-1", viewerCount: 42 });
    communities.prices.set("community-1", { amount: 50_000, billingCycle: "monthly" });

    const detail = await useCase.execute({ slug: "kelas-desain", viewerId: null });

    expect(detail.live).toEqual({ streamId: "stream-1", viewerCount: 42 });
    expect(detail.price).toEqual({ amount: 50_000, billingCycle: "monthly" });
    expect(communities.liveByOwnerCalls).toEqual([["owner-1"]]);
    expect(communities.cheapestActivePricesCalls).toEqual([["community-1"]]);
  });

  it("reports null live and null price when there is neither", async () => {
    const { useCase } = subject();

    const detail = await useCase.execute({ slug: "kelas-desain", viewerId: null });

    expect(detail.live).toBeNull();
    expect(detail.price).toBeNull();
  });

  it("reports the owner as owner and as a member", async () => {
    const { useCase } = subject();

    const detail = await useCase.execute({ slug: "kelas-desain", viewerId: "owner-1" });

    expect(detail.viewerIsOwner).toBe(true);
    expect(detail.viewerIsMember).toBe(true);
    expect(detail.ownerHandle).toBe("wildan");
    expect(detail.memberCount).toBe(1);
  });
});
