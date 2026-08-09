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
 * Returns ONLY the status string. Never the member's name or WhatsApp
 * number, the amount, the tier, the creator, or the community — see
 * routes/public-subscription.ts for the full rationale.
 */
export class GetSubscriptionStatus {
  constructor(private readonly subscriptions: SubscriptionRepositoryPort) {}

  async execute(subscriptionId: string): Promise<SubscriptionStatus> {
    const subscription = await this.subscriptions.findById(subscriptionId);
    if (!subscription) {
      throw new NotFoundError("subscription not found");
    }

    // Explicit projection, never a spread: `subscription` gains columns in
    // later phases (Phase 5 adds retry counts and churn state per the task
    // brief) and none of those may leak through this endpoint by default.
    return { status: subscription.status };
  }
}
