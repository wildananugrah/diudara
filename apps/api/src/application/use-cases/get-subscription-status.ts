import { mintWatchToken, WATCH_TOKEN_TTL_MS } from "../../domain/watch-token";
import { NotFoundError } from "../errors";
import type { EventRepositoryPort } from "../ports/event-repository.port";
import type { SubscriptionRepositoryPort } from "../ports/subscription-repository.port";

/**
 * The one subscription status entitled to a watch link — same constant, same
 * value, and the same reasoning as `AuthoriseStream`'s own `ENTITLED_STATUS`
 * (deliberately narrower than the grace-period-inclusive statuses channel
 * gating uses elsewhere). Duplicated rather than imported: neither file
 * depends on the other, and the two independent copies are exactly what
 * keeps a change to one from silently loosening the other.
 */
const ENTITLED_STATUS = "active";

export interface SubscriptionStatus {
  status: string;
  /**
   * `/watch/<token>` — present ONLY when the subscription is `active` AND
   * its community has a `live` event right now; omitted (never `null`,
   * never `""`) otherwise, so the byte-for-byte "leaks nothing but the
   * status" contract this endpoint already promised keeps holding for every
   * subscription that has nothing to watch.
   *
   * Freshly minted on every call, per the design spec (§5.2): "Replay access
   * re-mints a token on each visit to the status page." That is free to do
   * because a watch token is a stateless HMAC (`domain/watch-token.ts`) —
   * re-minting creates no provider-side artifact to leave dangling, unlike
   * Phase 4's Telegram invite link.
   */
  watchUrl?: string;
}

/**
 * Backs the public, unauthenticated `GET /c/subscription/:subscriptionId/status`
 * route. A member lands here straight off the redirect Xendit sends after
 * paying, so the id travels in a URL that may sit in browser history or be
 * shared — it must be treated as guessable.
 *
 * Returns ONLY the status string, plus `watchUrl` under the narrow condition
 * above. Never the member's name or WhatsApp number, the amount, the tier,
 * the creator, the community id, or anything else — see
 * routes/public-subscription.ts for the full rationale. `watchUrl` itself
 * carries nothing more sensitive than a stateless, time-limited token
 * already scoped to exactly this subscription and event — the same token a
 * cancelled subscription's own read authorisation refuses on the very next
 * segment request (`AuthoriseStream`), so minting one here confers no access
 * this member does not already have.
 */
export class GetSubscriptionStatus {
  constructor(
    private readonly subscriptions: SubscriptionRepositoryPort,
    private readonly events: EventRepositoryPort,
    /**
     * `undefined` exactly when streaming is not configured on this box
     * (`STREAM_TOKEN_SECRET` absent) — mirrors `AuthoriseStream`'s own
     * gating in `bootstrap.ts`. A member simply never sees a `watchUrl`
     * on a box with streaming disabled, the same way the creator's
     * streaming UI stays hidden.
     */
    private readonly config: { streamTokenSecret: string | undefined }
  ) {}

  async execute(subscriptionId: string, now: number): Promise<SubscriptionStatus> {
    const entitlement = await this.subscriptions.findByIdWithCommunity(subscriptionId);
    if (!entitlement) {
      throw new NotFoundError("subscription not found");
    }
    const { subscription, communityId } = entitlement;

    // Explicit projection, never a spread: `subscription` gains columns in
    // later phases (Phase 5 added retry counts and churn state per that
    // task's brief) and none of those may leak through this endpoint by
    // default.
    const result: SubscriptionStatus = { status: subscription.status };

    // No point even asking whether the community is live if this member
    // could never be authorised to watch anyway — `AuthoriseStream` demands
    // the SAME `ENTITLED_STATUS` on every read, so minting a token for a
    // pending/past_due/cancelled/churned subscription would only hand back a
    // link that 403s on the first segment request.
    if (this.config.streamTokenSecret && subscription.status === ENTITLED_STATUS) {
      const liveEvent = await this.events.findLiveByCommunityId(communityId);
      if (liveEvent) {
        const token = mintWatchToken({
          subscriptionId: subscription.id,
          eventId: liveEvent.id,
          now,
          ttlMs: WATCH_TOKEN_TTL_MS,
          secret: this.config.streamTokenSecret,
        });
        result.watchUrl = `/watch/${token}`;
      }
    }

    return result;
  }
}
