import { describe, expect, it } from "bun:test";
import { DEFAULT_COMMUNITY_LIST_LIMIT, MAX_COMMUNITY_SEARCH_LENGTH } from "@diudara/shared";
import { BrowseCommunities } from "./browse-communities";
import { ValidationError } from "../errors";
import type {
  BrowseCommunitiesQuery,
  CommunityListRow,
  CommunityRepositoryPort,
} from "../ports/community-repository.port";

/**
 * In-memory stand-in — see `create-community.test.ts`. This one RECORDS the
 * query it was handed: every test here is about what the use-case does to the
 * caller's input before the repository sees it, so `lastQuery` is the
 * assertion target and `browseCalls` proves a rejected category never got
 * that far.
 */
class FakeCommunityRepository implements CommunityRepositoryPort {
  browseCalls = 0;
  lastQuery: BrowseCommunitiesQuery | null = null;
  rows: CommunityListRow[] = [];

  async create(): Promise<never> {
    throw new Error("not used in these tests");
  }
  async findBySlug(): Promise<null> {
    throw new Error("not used in these tests");
  }
  async browse(query: BrowseCommunitiesQuery): Promise<CommunityListRow[]> {
    this.browseCalls += 1;
    this.lastQuery = query;
    return this.rows;
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
}

function subject() {
  const communities = new FakeCommunityRepository();
  return { communities, useCase: new BrowseCommunities(communities) };
}

describe("BrowseCommunities", () => {
  it("trims and clamps the search string before the repository sees it", async () => {
    const { communities, useCase } = subject();

    await useCase.execute({
      search: `   ${"a".repeat(MAX_COMMUNITY_SEARCH_LENGTH + 40)}   `,
      category: "",
      limit: undefined,
    });

    expect(communities.lastQuery?.search.length).toBe(MAX_COMMUNITY_SEARCH_LENGTH);
  });

  it("refuses a category outside the six WITHOUT reaching the repository", async () => {
    const { communities, useCase } = subject();

    await expect(
      useCase.execute({ search: "", category: "Olahraga", limit: undefined })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(communities.browseCalls).toBe(0);
  });

  it("passes an empty category through as 'every category'", async () => {
    const { communities, useCase } = subject();

    await useCase.execute({ search: "", category: undefined, limit: undefined });

    expect(communities.lastQuery?.category).toBe("");
  });

  it("defaults the limit, and clamps a caller asking for more", async () => {
    const { communities, useCase } = subject();

    await useCase.execute({ search: "", category: "", limit: undefined });
    expect(communities.lastQuery?.limit).toBe(DEFAULT_COMMUNITY_LIST_LIMIT);

    await useCase.execute({ search: "", category: "", limit: 500 });
    expect(communities.lastQuery?.limit).toBe(DEFAULT_COMMUNITY_LIST_LIMIT);
  });
});
