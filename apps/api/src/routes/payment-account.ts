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
  //
  // `available` is a property of the SERVER, not of the creator, which is why it
  // is composed here rather than inside `GetPaymentAccountStatus` — that use case
  // reads one creator's column and has no business knowing about `bootstrap()`.
  // It is the exact same `deps.createPaymentAccount !== undefined` the POST below
  // turns into a 503, so the two can never disagree.
  //
  // Without it, `connected: false, provisioning: false` is ambiguous: it means
  // both "this server takes payments and you have not connected yet" and "this
  // server has no payment provider at all". The dashboard needs to tell those
  // apart — the first is fixable by pressing a button, the second is not, and
  // offering a paid community on the second is a form that can only ever 409.
  app.get("/", async (c) => {
    const status = await deps.getPaymentAccountStatus.execute(c.get("creatorId"));
    return c.json({ ...status, available: deps.createPaymentAccount !== undefined });
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
