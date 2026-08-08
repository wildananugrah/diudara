import { Hono } from "hono";
import { connectChannelSchema, type ConnectChannelInput } from "@diudara/shared";
import { z } from "zod";
import { uuidParam, validate, validateParams } from "../http/validate";
import { requireAuth, type AuthVariables } from "../http/auth.middleware";
import type { Dependencies } from "../bootstrap";

export function channelRoutes(
  deps: Pick<Dependencies, "tokenIssuer" | "connectChannel" | "listChannels">
) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", requireAuth(deps.tokenIssuer));
  app.use("*", validateParams(z.object({ communityId: uuidParam })));

  app.post("/", validate(connectChannelSchema), async (c) => {
    const input = c.get("validated") as ConnectChannelInput;
    const created = await deps.connectChannel.execute({
      communityId: c.req.param("communityId")!,
      creatorId: c.get("creatorId"),
      ...input,
    });
    return c.json(created, 201);
  });

  app.get("/", async (c) => {
    const list = await deps.listChannels.execute({
      communityId: c.req.param("communityId")!,
      creatorId: c.get("creatorId"),
    });
    return c.json(list);
  });

  return app;
}
