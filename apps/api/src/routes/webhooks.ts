import { Hono } from "hono";
import { UnauthorizedError, ValidationError } from "../application/errors";
import { verifyCallbackToken } from "../infrastructure/webhooks/webhook-token";
import { parseXenditInvoiceCallback } from "../infrastructure/payments/xendit-webhook-payload";
import { parseTelegramChatMemberJoin } from "../infrastructure/messaging/telegram-webhook-payload";
import type { Dependencies } from "../bootstrap";

/**
 * The `channel.platform` value a Telegram update belongs to. A literal rather
 * than something read off the body: the route is Telegram-specific, and taking a
 * platform name from an untrusted payload would let a caller choose which
 * adapter's records it writes.
 */
const TELEGRAM_PLATFORM = "telegram";

/**
 * Public BY DESIGN — neither Xendit nor Telegram can present a creator bearer
 * token, so these routes are deliberately not behind `requireAuth`. Both are
 * authenticated instead by a static header secret, verified in CONSTANT TIME
 * before anything else happens: `X-CALLBACK-TOKEN` for Xendit,
 * `X-Telegram-Bot-Api-Secret-Token` for Telegram.
 *
 * Do not mount anything else under `/webhooks` that is not token-verified, and
 * do not "fix" either route by adding `requireAuth` — that would silently stop
 * every real payment from being credited, and stop every member's platform id
 * from being recorded.
 */
export function webhookRoutes(
  deps: Pick<
    Dependencies,
    | "handlePaymentWebhook"
    | "xenditCallbackToken"
    | "recordChannelJoin"
    | "telegramWebhookSecret"
  >
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

  /**
   * Telegram's `chat_member` updates: how a member's Telegram USER ID gets
   * recorded, which is the only thing that makes `RevokeChannelAccess` able to ban
   * anybody (`banChatMember` addresses a user id, and Phase 4 grants access with an
   * invite link precisely because it has none).
   *
   * WHY A WEBHOOK RATHER THAN A `getUpdates` POLL IN THE WORKER
   *
   *   - `getUpdates` and `setWebhook` are MUTUALLY EXCLUSIVE at Telegram. Choosing
   *     one now avoids a configuration trap where installing a webhook later
   *     silently stops a poller, or vice versa.
   *   - A poll needs the `offset` persisted, or a restart either re-processes a
   *     window of updates or skips one. That is new state, a new table or column,
   *     and a new class of bug. A webhook has none: Telegram owns the retry.
   *   - `apps/worker`'s loop exists to drain the outbox. Adding an unrelated
   *     inbound concern to it means one failure mode can starve the other, and the
   *     worker would need `TELEGRAM_BOT_TOKEN` for reading as well as sending.
   *   - This repository already has a token-verified inbound webhook to follow —
   *     `/xendit` above — and Telegram authenticates the same way, with a static
   *     header secret. That let the constant-time comparison, the NODE_ENV
   *     allowlist and the "check the token before touching the body" ordering be
   *     REUSED rather than reinvented.
   *   - It is deterministically testable through `app.request()`, with no HTTP
   *     mocking of Telegram at all.
   *
   * The cost, stated plainly: a webhook needs a public HTTPS URL, so exercising
   * this locally needs a tunnel (`cloudflared tunnel`, `ngrok http 3000`) and a
   * `setWebhook` call carrying `secret_token`. A poll would have worked with
   * neither. That is a development-convenience cost paid once, against a
   * correctness and state cost that would be paid forever.
   *
   * Public BY DESIGN and authenticated by `X-Telegram-Bot-Api-Secret-Token`, which
   * `setWebhook`'s `secret_token` parameter installs. Never put it behind
   * `requireAuth`: Telegram has no bearer token.
   */
  app.post("/telegram", async (c) => {
    // FIRST, exactly as for Xendit: an unauthenticated caller must not reach the
    // parser, the database, or the logs. A forged `chat_member` update writes an
    // attacker-chosen `external_member_id`, which is the id `banChatMember` is
    // later aimed at — so forging one turns a creator's revocation into "remove
    // somebody else from my group".
    if (
      !verifyCallbackToken(
        c.req.header("X-Telegram-Bot-Api-Secret-Token"),
        deps.telegramWebhookSecret
      )
    ) {
      throw new UnauthorizedError("invalid webhook secret");
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new ValidationError("webhook body is not valid json");
    }

    // `null` for every update that is not a join we can act on — a message, a
    // departure, a join with no invite link. A 2xx and nothing else: Telegram
    // redelivers anything it did not get a 2xx for, and none of those becomes
    // valid on a retry.
    const join = parseTelegramChatMemberJoin(body);
    if (join !== null) {
      await deps.recordChannelJoin.execute({
        platform: TELEGRAM_PLATFORM,
        externalGroupId: join.chatId,
        externalMemberId: join.externalMemberId,
        inviteLink: join.inviteLink,
      });
    }

    // Says nothing about what happened, for the same reason as `/xendit` — and one
    // more here: the request carried an invite link, and an outcome in the body
    // would tell whoever sent it whether that link is one of ours.
    return c.json({ received: true });
  });

  return app;
}
