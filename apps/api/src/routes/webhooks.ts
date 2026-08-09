import { Hono } from "hono";
import { UnauthorizedError, ValidationError } from "../application/errors";
import { verifyCallbackToken } from "../infrastructure/webhooks/webhook-token";
import { parseXenditInvoiceCallback } from "../infrastructure/payments/xendit-webhook-payload";
import type { Dependencies } from "../bootstrap";

/**
 * Public BY DESIGN — Xendit cannot present a creator bearer token, so this route
 * is deliberately not behind `requireAuth`. It is authenticated instead by the
 * static `X-CALLBACK-TOKEN` header, verified in constant time before anything
 * else happens.
 *
 * Do not mount anything else under `/webhooks` that is not token-verified, and
 * do not "fix" this by adding `requireAuth` — that would silently stop every
 * real payment from being credited.
 */
export function webhookRoutes(
  deps: Pick<Dependencies, "handlePaymentWebhook" | "xenditCallbackToken">
) {
  const app = new Hono();

  app.post("/xendit", async (c) => {
    // FIRST, before the body is even read: an unauthenticated caller must not be
    // able to reach the parser, the database, or the logs.
    if (!verifyCallbackToken(c.req.header("X-CALLBACK-TOKEN"), deps.xenditCallbackToken)) {
      throw new UnauthorizedError("invalid callback token");
    }

    // `c.req.json()` throws a SyntaxError on a malformed body, which would reach
    // the unhandled-error path as a 500. A body we cannot parse is a bad request.
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new ValidationError("webhook body is not valid json");
    }

    const event = parseXenditInvoiceCallback(body);
    await deps.handlePaymentWebhook.execute({ ...event, payload: body });

    // Deliberately says nothing about what happened. Xendit only needs a 2xx to
    // stop retrying, and this response is readable by anyone holding the token.
    return c.json({ received: true });
  });

  return app;
}
