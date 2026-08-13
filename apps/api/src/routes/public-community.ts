import { Hono } from "hono";
import {
  joinRequestSchema,
  startCheckoutSchema,
  type JoinRequestInput,
  type StartCheckoutInput,
} from "@diudara/shared";
import { validate } from "../http/validate";
import type { AuthVariables } from "../http/auth.middleware";
import type { Dependencies } from "../bootstrap";

/** Public — deliberately NOT behind requireAuth. */
export function publicCommunityRoutes(
  deps: Pick<
    Dependencies,
    "getPublicCommunity" | "startCheckout" | "requestToJoin" | "getJoinRequestStatus"
  >
) {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.get<"/:slug">("/:slug", async (c) => {
    return c.json(await deps.getPublicCommunity.execute(c.req.param("slug")));
  });

  // `POST /c/:slug/join-request` — the free-community counterpart to
  // `/c/:slug/checkout`. Unlike checkout, this is ALWAYS registered: whether
  // a given community accepts a free join is a per-community setting
  // (`accessMode`), not a per-deployment one, so `RequestToJoin` itself is
  // what refuses — with 404 — a `paid` community or one where `accessMode`
  // is anything else. There is no environment condition under which this
  // route should not exist.
  app.post<"/:slug/join-request">(
    "/:slug/join-request",
    validate(joinRequestSchema),
    async (c) => {
      const input = c.get("validated") as JoinRequestInput;
      const result = await deps.requestToJoin.execute({ slug: c.req.param("slug"), ...input });
      return c.json(result, 201);
    }
  );

  // `GET /c/:slug/request/:joinRequestId` — where a member lands right after
  // submitting a request. See `GetJoinRequestStatus`'s own docstring for why
  // the response is deliberately narrow: status, the community's slug, and a
  // subscription id once approved — never a name or a WhatsApp number.
  app.get<"/:slug/request/:joinRequestId">("/:slug/request/:joinRequestId", async (c) => {
    const result = await deps.getJoinRequestStatus.execute(
      c.req.param("slug"),
      c.req.param("joinRequestId")
    );
    return c.json(result);
  });

  // `undefined` EXACTLY when this box has no payment provider at all — see
  // `startCheckout`'s own docstring on `Dependencies`. The route is not
  // REGISTERED at all in that case (rather than registered and answering
  // 503/500), so a request to it 404s through Hono's ordinary not-found path —
  // the same as any other path this app never mounted. Bound to a local
  // `const` so TypeScript narrows it to `StartCheckout` (not
  // `StartCheckout | undefined`) inside the closure below.
  const startCheckout = deps.startCheckout;
  if (startCheckout) {
    // Explicit generic — without it, an untyped Context inside validate()
    // pollutes Hono's path-param inference on this multi-handler route (Phase 2's
    // known trap; the fix is always the generic, never a cast or `!`).
    app.post<"/:slug/checkout">("/:slug/checkout", validate(startCheckoutSchema), async (c) => {
      const input = c.get("validated") as StartCheckoutInput;
      const result = await startCheckout.execute({ slug: c.req.param("slug"), ...input });
      return c.json(result, 201);
    });
  }

  return app;
}
