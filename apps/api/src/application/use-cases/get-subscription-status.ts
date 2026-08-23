import { NotFoundError } from "../errors";
import type { SubscriptionRepositoryPort } from "../ports/subscription-repository.port";

export interface SubscriptionStatus {
  status: string;
}

/**
 * Backs the public, unauthenticated `GET /c/subscription/:subscriptionId/status`
 * route. A member lands here straight off the redirect Xendit sends after
 * paying, so the id travels in a URL that may sit in browser history or be
 * shared — it must be treated as guessable.
 *
 * Returns ONLY the status string. Never the member's name or WhatsApp number,
 * the amount, the tier, the creator, the community id, or anything else — see
 * routes/public-subscription.ts for the full rationale.
 *
 * IT USED TO RETURN A `watchUrl` TOO, and retire-telegram Task 3 removed it
 * along with the rest of the community streaming stack. That field was a
 * `/watch/<token>` link, freshly minted here on every call, that a member's
 * browser exchanged for an HLS URL at `GET /c/watch/:token`. Task 1 deleted the
 * screen that rendered it (`WatchPage.tsx`) and Task 3 deleted the route that
 * resolved it, so what remained was a signed credential handed out on a public,
 * unauthenticated endpoint that nothing could redeem. Minting one is not free of
 * consequence just because nothing reads it: `watch-token.ts` signs with
 * `STREAM_TOKEN_SECRET`, the SAME secret the surviving user world's authoriser
 * verifies against, and a token nobody can spend is still a token nobody
 * intended to issue.
 *
 * Removing it also took this class's last two dependencies on the old world —
 * `EventRepositoryPort` (it looked up the community's live event) and
 * `domain/watch-token.ts` (it minted the token). This class now needs neither,
 * and neither does the composition root to build it.
 */
export class GetSubscriptionStatus {
  constructor(private readonly subscriptions: SubscriptionRepositoryPort) {}

  /**
   * `now` is accepted and unused. It stayed when `watchUrl` went, deliberately:
   * every caller already passes `Date.now()`, the signature is a public contract
   * with a route and with this class's tests, and Task 4 deletes the whole class.
   * Churning the signature to drop one argument would touch more files than it
   * would clean up.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async execute(subscriptionId: string, now: number): Promise<SubscriptionStatus> {
    const entitlement = await this.subscriptions.findByIdWithCommunity(subscriptionId);
    if (!entitlement) {
      throw new NotFoundError("subscription not found");
    }
    const { subscription } = entitlement;

    // Explicit projection, never a spread: `subscription` gains columns in
    // later phases (Phase 5 added retry counts and churn state per that
    // task's brief) and none of those may leak through this endpoint by
    // default.
    return { status: subscription.status };
  }
}
