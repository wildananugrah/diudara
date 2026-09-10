import type { CommunityRecord } from "../ports/community-repository.port";

/**
 * What every community-shaped response carries. `CreateCommunity` and
 * `GetCommunity` both answer with this, so it lives in its own module rather
 * than in whichever of the two happened to be written first — the same
 * arrangement `viewer-follow-state.ts` uses for the type two follow
 * use-cases share.
 */
export interface CommunityDetail {
  slug: string;
  name: string;
  category: string;
  description: string | null;
  memberCount: number;
  ownerHandle: string;
  ownerDisplayName: string;
  /**
   * `null` for a signed-out viewer, `boolean` for a signed-in one. **The two
   * are not interchangeable**: the join button reads "Masuk untuk gabung" for
   * `null` and "Gabung" for `false`, so collapsing the first into the second
   * would invite an anonymous visitor to tap a button that cannot work.
   */
  viewerIsMember: boolean | null;
  viewerIsOwner: boolean;
  createdAt: Date;
}

/**
 * Assembles the response from the pieces each caller has already fetched.
 * Takes them as arguments rather than fetching anything itself: `Create`
 * knows the counts without asking (it just wrote them), and `Get` reads them
 * from the repository.
 *
 * Note `community.id` and `community.ownerId` are dropped here — no internal
 * id crosses this boundary, the same discipline the repositories' public
 * column projections keep.
 */
export function toCommunityDetail(input: {
  community: CommunityRecord;
  memberCount: number;
  ownerHandle: string;
  ownerDisplayName: string;
  viewerIsMember: boolean | null;
  viewerIsOwner: boolean;
}): CommunityDetail {
  return {
    slug: input.community.slug,
    name: input.community.name,
    category: input.community.category,
    description: input.community.description,
    memberCount: input.memberCount,
    ownerHandle: input.ownerHandle,
    ownerDisplayName: input.ownerDisplayName,
    viewerIsMember: input.viewerIsMember,
    viewerIsOwner: input.viewerIsOwner,
    createdAt: input.community.createdAt,
  };
}
