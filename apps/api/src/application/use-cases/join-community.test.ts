import { describe, expect, it } from "bun:test";
import { JoinCommunity } from "./join-community";
import { ConflictError, NotFoundError } from "../errors";
import type {
  CommunityRecord,
  CommunityRepositoryPort,
} from "../ports/community-repository.port";
import { NotifyOf } from "./notify";

/**
 * A real `NotifyOf` over an in-memory repository, so these tests exercise the
 * hook rather than stubbing it away — including the rule that a notification
 * failure must NOT fail the action.
 */
function silentNotifier(): NotifyOf {
  return new NotifyOf({
    async create() {},
    async listFor() {
      return [];
    },
    async unreadCountFor() {
      return 0;
    },
    async markAllRead() {},
  });
}

const community: CommunityRecord = {
  id: "community-1",
  ownerId: "owner-1",
  slug: "kelas-desain",
  name: "Kelas Desain",
  category: "Skill Digital",
  description: null,
  createdAt: new Date("2026-02-01T00:00:00Z"),
  tags: [],
};

/**
 * In-memory stand-in — see `create-community.test.ts`. `writeCalls` counts
 * `join` and `leave` together, which is what the owner-leave test asserts is
 * never incremented: the refusal has to happen in the use-case, before the
 * port, exactly as `FollowUser` refuses a self-follow.
 */
class FakeCommunityRepository implements CommunityRepositoryPort {
  writeCalls = 0;
  members = new Set<string>(["owner-1"]);

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
  async memberCountFor(): Promise<number> {
    return this.members.size;
  }
  async isMember(_communityId: string, userId: string): Promise<boolean> {
    return this.members.has(userId);
  }
  async join(_communityId: string, userId: string): Promise<boolean> {
    this.writeCalls += 1;
    if (this.members.has(userId)) {
      return false;
    }
    this.members.add(userId);
    return true;
  }
  async leave(_communityId: string, userId: string): Promise<boolean> {
    this.writeCalls += 1;
    return this.members.delete(userId);
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
  return { communities, useCase: new JoinCommunity(communities, silentNotifier()) };
}

describe("JoinCommunity", () => {
  it("joining twice answers the same resulting state and writes one row", async () => {
    const { communities, useCase } = subject();

    expect(await useCase.execute({ userId: "rina-1", slug: "kelas-desain", action: "join" })).toEqual(
      { member: true }
    );
    expect(await useCase.execute({ userId: "rina-1", slug: "kelas-desain", action: "join" })).toEqual(
      { member: true }
    );
    expect(communities.members.size).toBe(2);
  });

  it("leaving twice answers the same resulting state", async () => {
    const { useCase } = subject();
    await useCase.execute({ userId: "rina-1", slug: "kelas-desain", action: "join" });

    expect(
      await useCase.execute({ userId: "rina-1", slug: "kelas-desain", action: "leave" })
    ).toEqual({ member: false });
    expect(
      await useCase.execute({ userId: "rina-1", slug: "kelas-desain", action: "leave" })
    ).toEqual({ member: false });
  });

  it("refuses to let the owner leave their own community, WITHOUT reaching the repository", async () => {
    const { communities, useCase } = subject();

    await expect(
      useCase.execute({ userId: "owner-1", slug: "kelas-desain", action: "leave" })
    ).rejects.toBeInstanceOf(ConflictError);
    expect(communities.writeCalls).toBe(0);
    expect(communities.members.has("owner-1")).toBe(true);
  });

  it("answers 404 for a slug nobody holds", async () => {
    const { communities, useCase } = subject();

    await expect(
      useCase.execute({ userId: "rina-1", slug: "tidak-ada", action: "join" })
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(communities.writeCalls).toBe(0);
  });
});
