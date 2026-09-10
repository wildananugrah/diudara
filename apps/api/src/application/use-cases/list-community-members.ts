import { DEFAULT_COMMUNITY_MEMBER_LIMIT } from "@diudara/shared";
import { NotFoundError } from "../errors";
import type {
  CommunityMemberRow,
  CommunityRepositoryPort,
} from "../ports/community-repository.port";

/**
 * `GET /communities/:slug/members` — the roster. Public and unauthenticated;
 * rows are already the public `handle`/`displayName`/`bio` projection the
 * repository selects, so there is nothing wider here for a spread to leak.
 *
 * **`capped` is the honest-truncation flag** the follow lists already
 * render: true when the page came back exactly full, which is the only
 * evidence available that more rows exist without paying for a second count.
 * It can be a false positive when the roster is exactly `limit` long — that
 * is the same trade `FollowListPage` makes, and saying "and more" once too
 * often is better than a page that silently stops at 50 while the header
 * reads 78.
 */
export class ListCommunityMembers {
  constructor(private readonly communities: CommunityRepositoryPort) {}

  async execute(input: {
    slug: string;
    limit?: number;
  }): Promise<{ members: CommunityMemberRow[]; capped: boolean }> {
    const community = await this.communities.findBySlug(input.slug);
    if (!community) {
      throw new NotFoundError("community not found");
    }

    const requested = input.limit ?? DEFAULT_COMMUNITY_MEMBER_LIMIT;
    const limit =
      Number.isFinite(requested) && requested > 0
        ? Math.min(Math.floor(requested), DEFAULT_COMMUNITY_MEMBER_LIMIT)
        : DEFAULT_COMMUNITY_MEMBER_LIMIT;

    const members = await this.communities.listMembers(community.id, limit);
    return { members, capped: members.length === limit };
  }
}
