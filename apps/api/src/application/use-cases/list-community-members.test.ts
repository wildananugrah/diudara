import { describe, expect, it } from "bun:test";
import { ListCommunityMembers } from "./list-community-members";
import { NotFoundError } from "../errors";
import type {
  CommunityMemberRow,
  CommunityRecord,
  CommunityRepositoryPort,
} from "../ports/community-repository.port";

const community: CommunityRecord = {
  id: "community-1",
  ownerId: "owner-1",
  slug: "kelas-desain",
  name: "Kelas Desain",
  category: "Skill Digital",
  description: null,
  createdAt: new Date("2026-02-01T00:00:00Z"),
};

function member(handle: string): CommunityMemberRow {
  return {
    handle,
    displayName: handle,
    bio: null,
    role: "member",
    joinedAt: new Date("2026-02-02T00:00:00Z"),
  };
}

/** In-memory stand-in — see `create-community.test.ts`. */
class FakeCommunityRepository implements CommunityRepositoryPort {
  rows: CommunityMemberRow[] = [];

  constructor(private readonly communities: CommunityRecord[]) {}

  async create(): Promise<never> {
    throw new Error("not used in these tests");
  }
  async findBySlug(slug: string): Promise<CommunityRecord | null> {
    return this.communities.find((c) => c.slug === slug) ?? null;
  }
  async findById(id: string): Promise<CommunityRecord | null> {
    return this.communities.find((c) => c.id === id) ?? null;
  }
  async browse(): Promise<never> {
    throw new Error("not used in these tests");
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
  async listMembers(_communityId: string, limit: number): Promise<CommunityMemberRow[]> {
    return this.rows.slice(0, limit);
  }
}

function subject() {
  const communities = new FakeCommunityRepository([community]);
  return { communities, useCase: new ListCommunityMembers(communities) };
}

describe("ListCommunityMembers", () => {
  it("answers 404 for a slug nobody holds", async () => {
    const { useCase } = subject();

    await expect(
      useCase.execute({ slug: "tidak-ada", limit: undefined })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("reports capped when the page came back exactly full", async () => {
    const { communities, useCase } = subject();
    communities.rows = [member("a"), member("b"), member("c")];

    const result = await useCase.execute({ slug: "kelas-desain", limit: 3 });

    expect(result.members.length).toBe(3);
    expect(result.capped).toBe(true);
  });

  it("reports not capped when fewer rows came back than were asked for", async () => {
    const { communities, useCase } = subject();
    communities.rows = [member("a"), member("b")];

    const result = await useCase.execute({ slug: "kelas-desain", limit: 3 });

    expect(result.members.length).toBe(2);
    expect(result.capped).toBe(false);
  });
});
