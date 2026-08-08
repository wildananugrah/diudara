import { Hono } from "hono";
import type { AuthVariables } from "../http/auth.middleware";
import type { Dependencies } from "../bootstrap";

/** Public — deliberately NOT behind requireAuth. */
export function publicCommunityRoutes(deps: Pick<Dependencies, "getPublicCommunity">) {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.get<"/:slug">("/:slug", async (c) => {
    return c.json(await deps.getPublicCommunity.execute(c.req.param("slug")));
  });

  return app;
}
