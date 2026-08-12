import { Hono } from "hono";
import type { AuthVariables } from "../http/auth.middleware";
import type { Dependencies } from "../bootstrap";

/**
 * The ONE body every refusal from `GET /watch/:token` returns, whatever the
 * reason — malformed token, expired token, wrong event, wrong community, an
 * inactive subscription, or streaming not configured at all on this box.
 * Same rule, same reasoning as `mediamtx-webhooks.ts`'s `REFUSED_BODY`:
 * `ResolveWatchToken` already collapses every one of those into
 * `{ allowed: false }`, and this constant is what stops the ROUTE from
 * reintroducing a distinction the use-case deliberately erased. The
 * frontend (`WatchPage.tsx`) renders this as the single Indonesian message
 * "tautan sudah tidak berlaku" regardless of which branch produced it —
 * never the raw `error` string, so even a future edit to this message
 * cannot start leaking a reason through the UI.
 */
const WATCH_REFUSED_BODY = { error: "watch link is no longer valid" } as const;

/**
 * Public — deliberately NOT behind requireAuth, exactly like
 * routes/public-community.ts. A member lands on this id straight off the
 * redirect the payment provider sends after paying: it travels in a URL, may
 * sit in browser history, and could be shared or guessed at.
 *
 * THE central risk: `/subscription/:id/status` must return ONLY the status
 * string, plus the narrow `watchUrl` exception `GetSubscriptionStatus`
 * documents. Not the member's name or WhatsApp number, not the amount, not
 * the tier, not the creator, not the community — nothing that identifies a
 * real person or business. See GetSubscriptionStatus's explicit projection;
 * never spread the subscription record here or in the use-case.
 */
export function publicSubscriptionRoutes(
  deps: Pick<Dependencies, "getSubscriptionStatus" | "resolveWatchToken">
) {
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

  /**
   * `GET /watch/:token` — what `WatchPage.tsx` calls to turn a bare
   * `/watch/<token>` URL (minted by `GetSubscriptionStatus`, or delivered by
   * `NotifyStreamLive`'s WhatsApp message) into the HLS URL `hls.js` should
   * actually load. See `ResolveWatchToken`'s own docstring for the full
   * security reasoning — this route only translates its result into HTTP.
   *
   * Streaming disabled on this box (`deps.resolveWatchToken` undefined,
   * mirroring `authoriseStream`'s own undefined-ness) refuses with the
   * SAME body as every other refusal — a member on a box with streaming
   * off should see "the link is not valid", not a different error that
   * would tell them the feature exists but is off.
   */
  app.get<"/watch/:token">("/watch/:token", async (c) => {
    if (!deps.resolveWatchToken) {
      return c.json(WATCH_REFUSED_BODY, 403);
    }

    const result = await deps.resolveWatchToken.execute({
      token: c.req.param("token"),
      now: Date.now(),
    });

    if (!result.allowed) {
      return c.json(WATCH_REFUSED_BODY, 403);
    }
    return c.json({ hlsUrl: result.hlsUrl });
  });

  return app;
}
