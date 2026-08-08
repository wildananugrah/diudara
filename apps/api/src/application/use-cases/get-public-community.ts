import { NotFoundError } from "../errors";
import type { CommunityRepositoryPort } from "../ports/community-repository.port";
import type { MembershipTierRepositoryPort } from "../ports/membership-tier-repository.port";

export interface PublicTier {
  id: string;
  name: string;
  priceAmount: number;
  billingCycle: string;
}

export interface PublicCommunity {
  id: string;
  name: string;
  niche: string | null;
  slug: string;
  /**
   * False for a `paused` community. The page still renders — see
   * `VISIBLE_STATUSES` below — but the frontend must show a
   * "temporarily not accepting new members" state instead of the tier picker,
   * and StartCheckout (Task 6) must reject with 409.
   *
   * Deliberately NOT the raw `status`: buyers have no business knowing the
   * platform's internal status vocabulary, and a status added later (say
   * `suspended`) must not become part of the public contract by accident.
   */
  acceptingNewMembers: boolean;
  tiers: PublicTier[];
}

/**
 * Statuses a visitor is allowed to see, per spec §9.1 (ruled 2026-08-09):
 *
 *   active   — page renders, checkout works.
 *   paused   — page RENDERS, with acceptingNewMembers false; checkout rejected.
 *              A creator pausing for a holiday keeps every checkout link they
 *              have already broadcast into WhatsApp working, instead of telling
 *              prospects the community does not exist.
 *   archived — 404. Gone as far as the public is concerned.
 *
 * An allowlist rather than `status !== "archived"`: `community.status` is a free
 * varchar in the schema, so a value nobody anticipated must fail closed (404)
 * rather than publish a community by default.
 *
 * Exported so StartCheckout (Task 6) can reuse the exact same set when it
 * re-checks status server-side, rather than maintaining a second allowlist
 * that could silently drift out of sync with this one.
 */
export const VISIBLE_STATUSES = new Set(["active", "paused"]);

export class GetPublicCommunity {
  constructor(
    private readonly communities: CommunityRepositoryPort,
    private readonly tiers: MembershipTierRepositoryPort
  ) {}

  async execute(slug: string): Promise<PublicCommunity> {
    const community = await this.communities.findBySlug(slug);
    if (!community || !VISIBLE_STATUSES.has(community.status)) {
      throw new NotFoundError("community not found");
    }

    const all = await this.tiers.listByCommunity(community.id);

    // Explicit projection: never spread the record. Buyers must not see
    // creatorId, and later columns added to `community` must not leak by default.
    return {
      id: community.id,
      name: community.name,
      niche: community.niche,
      slug: community.slug,
      acceptingNewMembers: community.status === "active",
      tiers: all
        .filter((t) => t.isActive)
        .map((t) => ({
          id: t.id,
          name: t.name,
          priceAmount: t.priceAmount,
          billingCycle: t.billingCycle,
        })),
    };
  }
}
