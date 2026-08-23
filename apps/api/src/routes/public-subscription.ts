import { Hono } from "hono";
import type { AuthVariables } from "../http/auth.middleware";
import type { Dependencies } from "../bootstrap";

/**
 * Public — deliberately NOT behind requireAuth, exactly like
 * routes/public-community.ts. A member lands on this id straight off the
 * redirect the payment provider sends after paying: it travels in a URL, may
 * sit in browser history, and could be shared or guessed at.
 *
 * THE central risk: `/subscription/:id/status` must return ONLY the status
 * string. Not the member's name or WhatsApp number, not the amount, not the
 * tier, not the creator, not the community — nothing that identifies a real
 * person or business. See `GetSubscriptionStatus`'s explicit projection; never
 * spread the subscription record here or in the use-case.
 *
 * IT IS NOW THE ONLY ROUTE IN THIS FILE. `GET /watch/:token` — which turned a
 * `/watch/<token>` link into an HLS URL for the community world's player — went
 * with `ResolveWatchToken` in retire-telegram Task 3, and `GetSubscriptionStatus`
 * stopped minting the link that fed it at the same time.
 */
export function publicSubscriptionRoutes(deps: Pick<Dependencies, "getSubscriptionStatus">) {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.get<"/subscription/:subscriptionId/status">(
    "/subscription/:subscriptionId/status",
    async (c) => {
      const result = await deps.getSubscriptionStatus.execute(
        c.req.param("subscriptionId"),
        Date.now()
      );
      return c.json(result);
    }
  );

  return app;
}
