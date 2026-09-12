import { describe, expect, it } from "bun:test";
import {
  DEFAULT_COMMUNITY_LIST_LIMIT,
  MAX_COMMUNITY_SEARCH_LENGTH,
  POPULAR_TAGS_LIMIT,
} from "@diudara/shared";
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
  popularTagsCalls = 0;
  lastPopularTagsLimit: number | null = null;
  popular: string[] = [];

  async create(): Promise<never> {
    throw new Error("not used in these tests");
  }
  async findBySlug(): Promise<null> {
    throw new Error("not used in these tests");
  }
  async findById(): Promise<null> {
    throw new Error("not used in these tests");
  }
  async browse(query: BrowseCommunitiesQuery): Promise<CommunityListRow[]> {
    this.browseCalls += 1;
    this.lastQuery = query;
    return this.rows;
  }
  async setTags(): Promise<never> {
    throw new Error("not used in these tests");
  }
  async popularTags(limit: number): Promise<string[]> {
    this.popularTagsCalls += 1;
    this.lastPopularTagsLimit = limit;
    return this.popular;
  }
  async liveByOwner(): Promise<never> {
    throw new Error("not used in these tests");
  }
  async cheapestActivePrices(): Promise<never> {
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
  async listMembers(): Promise<never> {
    throw new Error("not used in these tests");
  }
  /** Phase 8b. Not reached by these tests — direct messages have their own suite. */
  async sharesCommunityWith() {
    return false;
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

  it("answers with the site's popular tags alongside the communities, at the shared cap", async () => {
    const { communities, useCase } = subject();
    communities.popular = ["desain", "bisnis"];

    const result = await useCase.execute({ search: "", category: "", limit: undefined });

    expect(result.popularTags).toEqual(["desain", "bisnis"]);
    expect(communities.lastPopularTagsLimit).toBe(POPULAR_TAGS_LIMIT);
  });
});
