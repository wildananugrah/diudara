import { z } from "zod";

/**
 * One turn of the community-creation co-builder chat. The conversation is
 * NOT persisted server-side (see `CoBuilderChat`'s own docstring) — the
 * client holds the whole transcript and resends it every turn, so this is
 * also the wire shape for a single message in that transcript.
 */
export const coBuilderMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(2000),
});

/**
 * `POST /communities/co-builder/chat`'s body. Capped at 30 messages —
 * there is no persisted per-user rate limit (a deliberate corner cut, see
 * the use-case's own docstring), so this cap is what actually bounds a
 * single conversation's cost against the OpenRouter key.
 */
export const coBuilderChatRequestSchema = z.object({
  messages: z.array(coBuilderMessageSchema).min(1).max(30),
});

export type CoBuilderMessage = z.infer<typeof coBuilderMessageSchema>;
export type CoBuilderChatRequest = z.infer<typeof coBuilderChatRequestSchema>;
