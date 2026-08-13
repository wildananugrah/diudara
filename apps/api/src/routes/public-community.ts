import { Hono } from "hono";
import { startCheckoutSchema, type StartCheckoutInput } from "@diudara/shared";
import { validate } from "../http/validate";
import type { AuthVariables } from "../http/auth.middleware";
import type { Dependencies } from "../bootstrap";

/** Public — deliberately NOT behind requireAuth. */
export function publicCommunityRoutes(
  deps: Pick<Dependencies, "getPublicCommunity" | "startCheckout">
) {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.get<"/:slug">("/:slug", async (c) => {
    return c.json(await deps.getPublicCommunity.execute(c.req.param("slug")));
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
