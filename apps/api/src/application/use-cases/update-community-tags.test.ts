import { describe, expect, it } from "bun:test";
import { UpdateCommunityTags } from "./update-community-tags";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import type { CommunityRecord, CommunityRepositoryPort } from "../ports/community-repository.port";

const OWNER_ID = "owner-1";
const OTHER_ID = "someone-else";

const community: CommunityRecord = {
  id: "community-1",
  ownerId: OWNER_ID,
  slug: "kelas-desain",
  name: "Kelas Desain",
  category: "Skill Digital",
  description: null,
  createdAt: new Date("2026-02-01T00:00:00Z"),
  tags: ["lama"],
};

/** In-memory stand-in — see `create-community.test.ts`. */
class FakeCommunityRepository implements CommunityRepositoryPort {
  setTagsCalls: Array<{ communityId: string; tags: string[] }> = [];

  async findBySlug(slug: string): Promise<CommunityRecord | null> {
    return slug === community.slug ? community : null;
  }
  async setTags(communityId: string, tags: string[]): Promise<void> {
    this.setTagsCalls.push({ communityId, tags });
  }
  async create(): Promise<never> {
    throw new Error("not used in these tests");
  }
  async findById(): Promise<CommunityRecord | null> {
    throw new Error("not used in these tests");
  }
  async browse(): Promise<never> {
    throw new Error("not used in these tests");
  }
  async popularTags(): Promise<never> {
    throw new Error("not used in these tests");
  }
  async liveByOwner(): Promise<never> {
    throw new Error("not used in these tests");
  }
  async cheapestActivePrices(): Promise<never> {
    throw new Error("not used in these tests");
  }
  async memberCountFor(): Promise<never> {
    throw new Error("not used in these tests");
  }
  async isMember(): Promise<never> {
    throw new Error("not used in these tests");
  }
  async join(): Promise<never> {
    throw new Error("not used in these tests");
  }
  async leave(): Promise<never> {
    throw new Error("not used in these tests");
  }
  async listMembers(): Promise<never> {
    throw new Error("not used in these tests");
  }
  async sharesCommunityWith() {
    return false;
  }
}

function subject() {
  const communities = new FakeCommunityRepository();
  return { communities, useCase: new UpdateCommunityTags(communities) };
}

describe("UpdateCommunityTags", () => {
  it("the owner may replace the tags, normalised", async () => {
    const { communities, useCase } = subject();

    const result = await useCase.execute({
      slug: "kelas-desain",
      viewerId: OWNER_ID,
      tags: ["  #Baru  ", "Baru"],
    });

    expect(result.tags).toEqual(["baru"]);
    expect(communities.setTagsCalls).toEqual([{ communityId: "community-1", tags: ["baru"] }]);
  });

  it("a non-owner is refused with ForbiddenError, and nothing is written", async () => {
    const { communities, useCase } = subject();

    await expect(
      useCase.execute({ slug: "kelas-desain", viewerId: OTHER_ID, tags: ["baru"] })
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(communities.setTagsCalls.length).toBe(0);
  });

  it("an unknown slug is 404", async () => {
    const { useCase } = subject();

    await expect(
      useCase.execute({ slug: "tidak-ada", viewerId: OWNER_ID, tags: ["baru"] })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("invalid tags are refused WITHOUT writing", async () => {
    const { communities, useCase } = subject();

    await expect(
      useCase.execute({
        slug: "kelas-desain",
        viewerId: OWNER_ID,
        tags: ["a", "b", "c", "d", "e", "f"],
      })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(communities.setTagsCalls.length).toBe(0);
  });
});
