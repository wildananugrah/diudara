import { Hono } from "hono";
import {
  createTierSchema,
  updateTierSchema,
  type CreateTierInput,
  type UpdateTierInput,
} from "@diudara/shared";
import { z } from "zod";
import { uuidParam, validate, validateParams } from "../http/validate";
import { requireAuth, type AuthVariables } from "../http/auth.middleware";
import type { Dependencies } from "../bootstrap";

export function tierRoutes(
  deps: Pick<Dependencies, "tokenIssuer" | "defineTier" | "listTiers" | "updateTier">
) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", requireAuth(deps.tokenIssuer));
  // `:communityId` comes from the parent mount path, so it is in scope for every
  // route in this sub-app and can be checked once here. `:tierId` belongs to a
  // single route, so it is validated on that route (a `use("*")` middleware
  // cannot see it — see validateParams' comment).
  app.use("*", validateParams(z.object({ communityId: uuidParam })));

  app.post("/", validate(createTierSchema), async (c) => {
    const input = c.get("validated") as CreateTierInput;
    const created = await deps.defineTier.execute({
      communityId: c.req.param("communityId")!,
      creatorId: c.get("creatorId"),
      ...input,
    });
    return c.json(created, 201);
  });

  app.get("/", async (c) => {
    const tiers = await deps.listTiers.execute({
      communityId: c.req.param("communityId")!,
      creatorId: c.get("creatorId"),
    });
    return c.json(tiers);
  });

  app.patch<"/:tierId">(
    "/:tierId",
    validateParams(z.object({ tierId: uuidParam })),
    validate(updateTierSchema),
    async (c) => {
      const patch = c.get("validated") as UpdateTierInput;
      const updated = await deps.updateTier.execute({
        communityId: c.req.param("communityId")!,
        creatorId: c.get("creatorId"),
        tierId: c.req.param("tierId")!,
        patch,
      });
      return c.json(updated);
    }
  );

  return app;
}
