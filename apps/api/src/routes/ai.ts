import { Hono } from "hono";
import { z } from "zod";
import { ServiceUnavailableError } from "../application/errors";
import { validate } from "../http/validate";
import { requireAuth, type AuthVariables } from "../http/auth.middleware";
import type { Dependencies } from "../bootstrap";

/**
 * Bound on one chat message's length, mirroring the discipline
 * `MAX_REPLY_LENGTH` (`openrouter-ai.adapter.ts`) applies to the MODEL's
 * output, applied here to the CREATOR's input: an unbounded message would be
 * forwarded to the provider (and stored) with no ceiling, and a very large
 * one costs real money at the provider for no product benefit — a chat turn
 * is not a document upload. Generous enough for real prose, same judgement
 * call as the reply-side bound.
 */
const MAX_MESSAGE_LENGTH = 4000;

const sendMessageSchema = z.object({
  conversationId: z.string().uuid().nullable().optional(),
  content: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
});

/**
 * The AI co-builder chat endpoint (Phase 7). Everything here is behind
 * `requireAuth`, including `GET /status`: a conversation is a
 * business-sensitive transcript, and even though the enabled/disabled flag
 * itself reveals nothing about any specific conversation, authenticating it
 * anyway keeps every route under `/ai` consistent with the rest of the
 * dashboard's API surface rather than carving out one public exception.
 */
export function aiRoutes(deps: Pick<Dependencies, "tokenIssuer" | "sendAiMessage">) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", requireAuth(deps.tokenIssuer));

  /**
   * HOW A DISABLED FEATURE IS SURFACED (see `selectAiProvider` in
   * bootstrap.ts): `deps.sendAiMessage` is `undefined` exactly when no AI
   * provider was configured and `NODE_ENV` is outside
   * `RELAXED_NODE_ENVS` — production with no `OPENROUTER_API_KEY`/
   * `OPENROUTER_MODEL` set, deliberately NOT a boot failure (unlike
   * payments/messaging). The dashboard is expected to call this once (e.g.
   * on load) and hide the chat screen entirely rather than ever reach
   * `POST /ai/messages` on a disabled box — plan Task 7: "the nav entry is
   * hidden rather than linking to a screen that always errors".
   */
  app.get("/status", async (c) => {
    return c.json({ enabled: deps.sendAiMessage !== undefined });
  });

  app.post("/messages", validate(sendMessageSchema), async (c) => {
    if (!deps.sendAiMessage) {
      // Reachable only if a caller ignores GET /status (or the feature was
      // disabled after the dashboard last checked it) — a 503, not a 500:
      // this box is fine, the feature just is not configured on it. Indonesian
      // copy: this message is meant to be shown to a creator (see
      // CoBuilderPage.tsx's "provider" error banner), not just logged.
      throw new ServiceUnavailableError("AI co-builder belum dikonfigurasi di server ini.");
    }

    const input = c.get("validated") as { conversationId?: string | null; content: string };
    const result = await deps.sendAiMessage.execute({
      creatorId: c.get("creatorId"),
      conversationId: input.conversationId ?? null,
      content: input.content,
    });
    return c.json(result);
  });

  return app;
}
