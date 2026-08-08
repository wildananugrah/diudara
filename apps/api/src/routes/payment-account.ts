import { Hono } from "hono";
import { requireAuth, type AuthVariables } from "../http/auth.middleware";
import type { Dependencies } from "../bootstrap";

export function paymentAccountRoutes(
  deps: Pick<Dependencies, "tokenIssuer" | "createPaymentAccount">
) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", requireAuth(deps.tokenIssuer));

  app.post("/", async (c) => {
    const result = await deps.createPaymentAccount.execute(c.get("creatorId"));
    return c.json(result, 201);
  });

  return app;
}
