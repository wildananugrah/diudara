import { Hono } from "hono";
import { requireAuth, type AuthVariables } from "../http/auth.middleware";
import { ServiceUnavailableError } from "../application/errors";
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
    // `undefined` EXACTLY when this box has no payment provider at all — see
    // `createPaymentAccount`'s own docstring on `Dependencies`. Same 503, not
    // a 500: this box is fine, there is just nothing to connect a creator's
    // account to (`routes/ai.ts`'s `sendAiMessage` guard is the model this
    // mirrors).
    if (!deps.createPaymentAccount) {
      throw new ServiceUnavailableError("pembayaran belum dikonfigurasi di server ini.");
    }
    const result = await deps.createPaymentAccount.execute(c.get("creatorId"));
    return c.json(result, 201);
  });

  return app;
}
