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
   * False for a `paused` community, AND for a `paid` community on a box with
   * no payment provider at all. The page still renders — see
   * `VISIBLE_STATUSES` below — but the frontend must show a
   * "temporarily not accepting new members" state instead of the tier picker,
   * and StartCheckout (Task 6) must reject with 409.
   *
   * Deliberately NOT the raw `status`: buyers have no business knowing the
   * platform's internal status vocabulary, and a status added later (say
   * `suspended`) must not become part of the public contract by accident.
   * That indirection is exactly what let the payments-disabled case be folded
   * in here without changing the public contract at all.
   */
  acceptingNewMembers: boolean;
  /**
   * `"paid"` or `"request"`, verbatim off `community.accessMode` — see that
   * field's own docstring on `CommunityRecord` for why it is plain `string`
   * rather than a literal union. The frontend (`CheckoutPage`) reads this to
   * decide whether to render a purchase form or a join-request form; the API
   * re-checks the same value server-side in `RequestToJoin` rather than
   * trusting whatever this response said.
   */
  accessMode: string;
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

/** `community.access_mode` value whose join path is a purchase. */
const PAID_ACCESS_MODE = "paid";

export interface GetPublicCommunityOptions {
  /**
   * False EXACTLY when `bootstrap()` selected no payment provider — the same
   * signal `CreateCommunity`/`UpdateCommunity` already take, threaded the same
   * way, and ultimately the same `payments !== null` that decides whether
   * `POST /c/:slug/checkout` is registered at all.
   *
   * Defaults to `true` so every existing caller and test is unaffected.
   */
  paymentsEnabled?: boolean;
}

export class GetPublicCommunity {
  private readonly paymentsEnabled: boolean;

  constructor(
    private readonly communities: CommunityRepositoryPort,
    private readonly tiers: MembershipTierRepositoryPort,
    options: GetPublicCommunityOptions = {}
  ) {
    this.paymentsEnabled = options.paymentsEnabled ?? true;
  }

  async execute(slug: string): Promise<PublicCommunity> {
    const community = await this.communities.findBySlug(slug);
    if (!community || !VISIBLE_STATUSES.has(community.status)) {
      throw new NotFoundError("community not found");
    }

    const all = await this.tiers.listByCommunity(community.id);

    // A `paid` community on a box with no payment provider has NO JOIN PATH AT
    // ALL (design spec §2). `POST /c/:slug/checkout` is not registered there, so
    // it answers Hono's plain-text `404 Not Found` — which the checkout page
    // surfaced to a member as raw English `checkout failed (404)`, AFTER showing
    // them a price and a buy button. Reporting `acceptingNewMembers: false`
    // makes the page render the "not accepting new members right now" state the
    // spec asks for, reusing the copy `paused` already has rather than inventing
    // a second one.
    //
    // NOT scoped to `request` communities as an exception bolted on elsewhere:
    // the condition is "this community's join path exists on this box", and for
    // a request-mode community it always does — `POST /c/:slug/join-request` is
    // registered unconditionally, precisely because whether a free join is
    // accepted is a per-community decision, not a per-deployment one.
    const joinPathExists = community.accessMode !== PAID_ACCESS_MODE || this.paymentsEnabled;

    // Explicit projection: never spread the record. Buyers must not see
    // creatorId, and later columns added to `community` must not leak by default.
    return {
      id: community.id,
      name: community.name,
      niche: community.niche,
      slug: community.slug,
      acceptingNewMembers: community.status === "active" && joinPathExists,
      accessMode: community.accessMode,
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
