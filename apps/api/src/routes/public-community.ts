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

  // Explicit generic — without it, an untyped Context inside validate()
  // pollutes Hono's path-param inference on this multi-handler route (Phase 2's
  // known trap; the fix is always the generic, never a cast or `!`).
  app.post<"/:slug/checkout">("/:slug/checkout", validate(startCheckoutSchema), async (c) => {
    const input = c.get("validated") as StartCheckoutInput;
    const result = await deps.startCheckout.execute({ slug: c.req.param("slug"), ...input });
    return c.json(result, 201);
  });

  return app;
}
