import { Hono } from "hono";
import { requireAuth, type AuthVariables } from "../http/auth.middleware";
import type { Dependencies } from "../bootstrap";

export function paymentAccountRoutes(
  deps: Pick<
    Dependencies,
    "tokenIssuer" | "createPaymentAccount" | "getPaymentAccountStatus"
  >
) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", requireAuth(deps.tokenIssuer));

  // Read-only, unlike the POST below: safe to call on every page load. See
  // GetPaymentAccountStatus for why this exists — the dashboard used to infer
  // "connected" from localStorage, which is per-browser rather than true.
  app.get("/", async (c) => {
    const status = await deps.getPaymentAccountStatus.execute(c.get("creatorId"));
    return c.json(status);
  });

  app.post("/", async (c) => {
    const result = await deps.createPaymentAccount.execute(c.get("creatorId"));
    return c.json(result, 201);
  });

  return app;
}
