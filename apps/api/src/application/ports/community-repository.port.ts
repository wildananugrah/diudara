export interface CommunityRecord {
  id: string;
  ownerId: string;
  slug: string;
  name: string;
  category: string;
  description: string | null;
  createdAt: Date;
}

/** One card in the browse grid. `memberCount` is computed, not stored. */
export interface CommunityListRow {
  slug: string;
  name: string;
  category: string;
  description: string | null;
  memberCount: number;
}

export interface CommunityMemberRow {
  handle: string;
  displayName: string;
  bio: string | null;
  role: string;
  joinedAt: Date;
}

export interface BrowseCommunitiesQuery {
  /** Already trimmed and clamped by the use-case. Empty means "no search". */
  search: string;
  /** Empty means "every category". */
  category: string;
  limit: number;
}

export interface CommunityRepositoryPort {
  /**
   * Writes the community AND the owner's `community_member` row in one
   * transaction. A community with no members is not a reachable state.
   * Throws the repository's translated uniqueness error if the slug is taken.
   */
  create(input: {
    ownerId: string;
    slug: string;
    name: string;
    category: string;
    description: string | null;
  }): Promise<CommunityRecord>;

  findBySlug(slug: string): Promise<CommunityRecord | null>;

  /**
   * One community by its primary key, in the same full `CommunityRecord`
   * projection `findBySlug` returns; `null` when no such id exists. The
   * moderation rules that let a community's owner delete a post or a comment
   * in it start from a post's `communityId` — an id, never a slug — so they
   * cannot use `findBySlug`.
   */
  findById(id: string): Promise<CommunityRecord | null>;

  browse(query: BrowseCommunitiesQuery): Promise<CommunityListRow[]>;

  memberCountFor(communityId: string): Promise<number>;

  isMember(communityId: string, userId: string): Promise<boolean>;

  /** Idempotent: `false` when the row already existed, `true` when created. */
  join(communityId: string, userId: string): Promise<boolean>;

  /** Idempotent: `false` when there was nothing to remove. */
  leave(communityId: string, userId: string): Promise<boolean>;

  /** Owner first, then newest joiners. The caller clamps `limit`. */
  listMembers(communityId: string, limit: number): Promise<CommunityMemberRow[]>;
}
