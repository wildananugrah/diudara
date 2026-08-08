import { Hono } from "hono";
import {
  createCommunitySchema,
  updateCommunitySchema,
  type CreateCommunityInput,
  type UpdateCommunityInput,
} from "@diudara/shared";
import { z } from "zod";
import { uuidParam, validate, validateParams } from "../http/validate";
import { requireAuth, type AuthVariables } from "../http/auth.middleware";
import type { Dependencies } from "../bootstrap";

export function communityRoutes(
  deps: Pick<
    Dependencies,
    "tokenIssuer" | "createCommunity" | "listCommunities" | "updateCommunity"
  >
) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", requireAuth(deps.tokenIssuer));

  app.post("/", validate(createCommunitySchema), async (c) => {
    const input = c.get("validated") as CreateCommunityInput;
    const created = await deps.createCommunity.execute({
      creatorId: c.get("creatorId"),
      ...input,
    });
    return c.json(created, 201);
  });

  app.get("/", async (c) => {
    return c.json(await deps.listCommunities.execute(c.get("creatorId")));
  });

  const idParams = z.object({ id: uuidParam });

  app.patch<"/:id">("/:id", validateParams(idParams), validate(updateCommunitySchema), async (c) => {
    const patch = c.get("validated") as UpdateCommunityInput;
    const updated = await deps.updateCommunity.execute({
      communityId: c.req.param("id"),
      creatorId: c.get("creatorId"),
      patch,
    });
    return c.json(updated);
  });

  return app;
}
