import { verifyWatchToken } from "../../domain/watch-token";
import type { EventRepositoryPort } from "../ports/event-repository.port";
import type { SubscriptionRepositoryPort } from "../ports/subscription-repository.port";

/**
 * The one subscription status entitled to watch — the SAME constant, value
 * and reasoning as `AuthoriseStream`'s own `ENTITLED_STATUS`. Duplicated
 * rather than imported, for the same reason `GetSubscriptionStatus`'s copy
 * is: neither file depends on the other, so a change to one cannot silently
 * loosen the other.
 */
const ENTITLED_STATUS = "active";

export type ResolveWatchTokenResult = { allowed: true; hlsUrl: string } | { allowed: false };

/**
 * Backs the public, unauthenticated `GET /c/watch/:token` route — the ONE
 * thing standing between a bare `/watch/<token>` URL (what
 * `GetSubscriptionStatus` mints and what `NotifyStreamLive`'s WhatsApp
 * message sends) and the actual HLS URL the browser's `hls.js` needs to
 * start pulling segments from.
 *
 * DELIBERATELY THE SAME SECURITY DECISION AS `AuthoriseStream`'s `read`
 * branch — signature valid, not expired, names THIS event, and the
 * subscription is STILL active in THIS event's community, re-checked live,
 * never cached — because both gate the exact same resource for the exact
 * same reason. It is a SEPARATE class rather than a shared one because the
 * two are triggered from different places with different inputs
 * (MediaMTX's `path`+`query` vs. a bare `token` in a URL) and answer
 * different questions (a boolean vs. a URL to hand back) — see
 * `AuthoriseStream`'s own docstring for why this project already accepts
 * this kind of short, well-documented duplication (e.g. `UUID_PATTERN` in
 * the Drizzle repositories) over a shared helper that would blur two
 * call sites with different contracts.
 *
 * ONE DELIBERATE DIFFERENCE from `AuthoriseStream`: this class does NOT
 * refuse merely because `event.status` is no longer `live`. A member who
 * is already watching when the creator stops publishing must keep this
 * resolved (MediaMTX's own read authorisation does not gate on event
 * status either — see that class's docstring) so `hls.js` can reach the
 * point of discovering, on its own, that the stream has ended (design spec
 * §8: "the player shows that the session ended"). Refusing here instead
 * would make an ended stream indistinguishable, to the member, from a dead
 * link — which is the ONE distinction this whole feature exists to draw.
 *
 * EVERY refusal — malformed/unsigned/expired token, unknown event, wrong
 * event, wrong community, inactive subscription — returns the identical
 * `{ allowed: false }`. The route turns that into the ONE generic 403 body,
 * never a reason: see `routes/public-subscription.ts`.
 */
export class ResolveWatchToken {
  constructor(
    private readonly events: EventRepositoryPort,
    private readonly subscriptions: SubscriptionRepositoryPort,
    private readonly config: { streamTokenSecret: string }
  ) {}

  async execute(input: { token: string; now: number }): Promise<ResolveWatchTokenResult> {
    const claims = verifyWatchToken({
      token: input.token,
      now: input.now,
      secret: this.config.streamTokenSecret,
    });
    if (!claims) {
      return { allowed: false };
    }

    // `findById` is the second sanctioned unscoped lookup on this port —
    // there is no authenticated creator here, only the eventId the token's
    // own signature names. See `EventRepositoryPort.findById`'s docstring.
    const event = await this.events.findById(claims.eventId);
    if (!event || !event.hlsPlaybackPath) {
      return { allowed: false };
    }

    // THE ENTITLEMENT RE-CHECK. Read fresh, on every single request — never
    // cached, never trusted from the token, exactly as `AuthoriseStream`
    // insists. A member who churns between minting and this resolve must
    // not get a usable URL back, even though the signature itself is fine.
    const entitlement = await this.subscriptions.findByIdWithCommunity(claims.subscriptionId);
    if (!entitlement) {
      return { allowed: false };
    }
    if (entitlement.subscription.status !== ENTITLED_STATUS) {
      return { allowed: false };
    }
    if (entitlement.communityId !== event.communityId) {
      return { allowed: false };
    }

    return { allowed: true, hlsUrl: event.hlsPlaybackPath };
  }
}
