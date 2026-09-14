import { describe, expect, it } from "bun:test";
import { ListMyCommunities } from "./list-my-communities";
import type {
  CommunityRepositoryPort,
  MyCommunityRow,
} from "../ports/community-repository.port";

/** In-memory stand-in — see `create-community.test.ts`. */
class FakeCommunityRepository implements CommunityRepositoryPort {
  rows: MyCommunityRow[] = [];
  calls: string[] = [];

  async listJoinedByMember(userId: string): Promise<MyCommunityRow[]> {
    this.calls.push(userId);
    return this.rows;
  }

  async create(): Promise<never> {
    throw new Error("not used in these tests");
  }
  async findBySlug(): Promise<null> {
    throw new Error("not used in these tests");
  }
  async findById(): Promise<null> {
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

describe("ListMyCommunities", () => {
  it("answers with the repository's rows for this viewer", async () => {
    const communities = new FakeCommunityRepository();
    communities.rows = [
      { slug: "kelas-desain", name: "Kelas Desain" },
      { slug: "bimbel-snbt", name: "Bimbel SNBT" },
    ];
    const useCase = new ListMyCommunities(communities);

    const result = await useCase.execute({ viewerId: "user-1" });

    expect(result.communities).toEqual(communities.rows);
    expect(communities.calls).toEqual(["user-1"]);
  });

  it("answers empty for someone in no communities, not an error", async () => {
    const communities = new FakeCommunityRepository();
    const useCase = new ListMyCommunities(communities);

    const result = await useCase.execute({ viewerId: "user-1" });

    expect(result.communities).toEqual([]);
  });
});
