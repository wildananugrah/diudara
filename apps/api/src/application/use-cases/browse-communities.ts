import {
  COMMUNITY_CATEGORIES,
  DEFAULT_COMMUNITY_LIST_LIMIT,
  MAX_COMMUNITY_SEARCH_LENGTH,
  POPULAR_TAGS_LIMIT,
} from "@diudara/shared";
import { ValidationError } from "../errors";
import type {
  CommunityListRow,
  CommunityRepositoryPort,
} from "../ports/community-repository.port";

const CATEGORIES: ReadonlySet<string> = new Set(COMMUNITY_CATEGORIES);

/**
 * `GET /communities` — the browse grid. Public and unauthenticated.
 *
 * **The category is checked against the six rather than passed through.** The
 * column is a `varchar`, so an arbitrary string would reach the WHERE clause
 * and quietly return nothing — a 200 with an empty grid for what is really a
 * malformed request. Rejecting it here means the fake in the tests can prove
 * the repository is never called, and it keeps an unbounded caller-supplied
 * value out of the query in the first place.
 *
 * **The search string is trimmed and clamped here, not in the repository**, so
 * every caller gets the same clamp — the same reasoning that put
 * `MAX_COMMUNITY_SEARCH_LENGTH` in `@diudara/shared` rather than in a route
 * file. The repository still escapes it before it reaches an ILIKE.
 *
 * `limit` is clamped to `DEFAULT_COMMUNITY_LIST_LIMIT` rather than to some
 * larger ceiling: one screen of cards is the whole contract of this endpoint,
 * and a caller asking for 500 is not a caller this phase serves.
 */
export class BrowseCommunities {
  constructor(private readonly communities: CommunityRepositoryPort) {}

  async execute(input: {
    search?: string;
    category?: string;
    limit?: number;
  }): Promise<{ communities: CommunityListRow[]; popularTags: string[] }> {
    const category = input.category ?? "";
    if (category !== "" && !CATEGORIES.has(category)) {
      throw new ValidationError("kategori tidak dikenal");
    }

    const search = (input.search ?? "").trim().slice(0, MAX_COMMUNITY_SEARCH_LENGTH);

    const requested = input.limit ?? DEFAULT_COMMUNITY_LIST_LIMIT;
    const limit =
      Number.isFinite(requested) && requested > 0
        ? Math.min(Math.floor(requested), DEFAULT_COMMUNITY_LIST_LIMIT)
        : DEFAULT_COMMUNITY_LIST_LIMIT;

    const [rows, popularTags] = await Promise.all([
      this.communities.browse({ search, category, limit }),
      this.communities.popularTags(POPULAR_TAGS_LIMIT),
    ]);
    return { communities: rows, popularTags };
  }
}
