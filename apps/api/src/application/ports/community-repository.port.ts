export interface CommunityRecord {
  id: string;
  ownerId: string;
  slug: string;
  name: string;
  category: string;
  description: string | null;
  createdAt: Date;
  tags: string[];
}

/**
 * One card in the browse grid. `memberCount` is computed, not stored.
 *
 * `trending` and `price` are both computed GLOBALLY, independent of whatever
 * `search`/`category` filter produced this row — see `BrowseCommunitiesQuery`.
 * `trending` means "one of the site's top 3 by recent joins this week," not
 * "top 3 within this filter." `price` is the cheapest ACTIVE tier, or `null`
 * when the community has none (renders "Gratis").
 */
export interface CommunityListRow {
  slug: string;
  name: string;
  category: string;
  description: string | null;
  memberCount: number;
  tags: string[];
  trending: boolean;
  price: { amount: number; billingCycle: string } | null;
  /**
   * `null` unless the community's owner currently has a `live` `user_stream`
   * — at most one, per `user_stream_one_live`'s own partial unique index.
   * Present regardless of that stream's visibility: a live badge is a
   * discovery signal even for a stream a visitor cannot watch yet.
   */
  live: { streamId: string; viewerCount: number } | null;
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
    tags?: string[];
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

  /** Owner-only, full replace — see `updateCommunityTagsSchema`. */
  setTags(communityId: string, tags: string[]): Promise<void>;

  /** The site's most-used tags across every community, most-frequent first. */
  popularTags(limit: number): Promise<string[]>;

  /**
   * Which of these owners currently has a `live` stream, and how many are
   * watching it — see `CommunityListRow.live`'s own docstring for the full
   * reasoning (at most one live row per owner, regardless of visibility).
   * Keyed by owner id so a caller with a single community's `ownerId` reads
   * its own entry with one `.get(id)`, the same shape `cheapestActivePrices`
   * below has for community ids.
   */
  liveByOwner(ownerIds: string[]): Promise<Map<string, { streamId: string; viewerCount: number }>>;

  /** The cheapest ACTIVE tier per community — see `CommunityListRow.price`'s own docstring. */
  cheapestActivePrices(
    communityIds: string[]
  ): Promise<Map<string, { amount: number; billingCycle: string }>>;

  memberCountFor(communityId: string): Promise<number>;

  isMember(communityId: string, userId: string): Promise<boolean>;

  /** Idempotent: `false` when the row already existed, `true` when created. */
  join(communityId: string, userId: string): Promise<boolean>;

  /** Idempotent: `false` when there was nothing to remove. */
  leave(communityId: string, userId: string): Promise<boolean>;

  /** Owner first, then newest joiners. The caller clamps `limit`. */
  listMembers(communityId: string, limit: number): Promise<CommunityMemberRow[]>;
  /**
   * Phase 8b. Whether these two people are members of at least one community
   * in common — the gate on STARTING a direct-message conversation.
   *
   * A single EXISTS rather than two membership lists intersected in the app:
   * the answer is a boolean and the database can stop at the first match.
   */
  sharesCommunityWith(a: string, b: string): Promise<boolean>;
}
