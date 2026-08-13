import { z } from "zod";

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be lowercase alphanumeric words separated by single hyphens");

/**
 * `access_mode` is a plain `varchar(16)` with no database CHECK constraint
 * (see `apps/api/src/db/schema.ts`) — exactly like `status` below — so the
 * allowlist has to live here, at the edge, the same reason
 * `RENEWABLE_STATUSES` exists for `subscription.status`. `z.enum`, not a bare
 * string: an unrecognised value must be rejected at the HTTP boundary, not
 * silently accepted and written to a column nothing else validates.
 */
const accessMode = z.enum(["paid", "request"]);

export const createCommunitySchema = z.object({
  name: z.string().trim().min(1).max(255),
  niche: z.string().trim().max(128).optional(),
  accessMode: accessMode.optional(),
});

export const updateCommunitySchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    niche: z.string().trim().max(128).optional(),
    slug: slug.optional(),
    status: z.enum(["active", "paused", "archived"]).optional(),
    accessMode: accessMode.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "at least one field is required" });

export const createTierSchema = z.object({
  name: z.string().trim().min(1).max(128),
  priceAmount: z.number().int().min(0).max(2_000_000_000),
  billingCycle: z.enum(["monthly", "quarterly", "yearly"]),
});

export const updateTierSchema = z
  .object({
    name: z.string().trim().min(1).max(128).optional(),
    priceAmount: z.number().int().min(0).max(2_000_000_000).optional(),
    billingCycle: z.enum(["monthly", "quarterly", "yearly"]).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "at least one field is required" });

/**
 * A Telegram `chat_id` as an INTEGER, which is what every inbound update carries.
 *
 * Groups, supergroups and channels have negative ids (`-1001234567890`); the sign is
 * not required here because a private chat id is positive and rejecting one on sign
 * alone would be a confusing message for a real mistake.
 */
const TELEGRAM_NUMERIC_CHAT_ID = /^-?[0-9]{1,20}$/;

/**
 * The message a creator sees. It has to say what to do, because `@username` is the
 * form they will naturally reach for — it is what they see in the Telegram client, and
 * it WORKS for the outbound half.
 */
export const TELEGRAM_NUMERIC_CHAT_ID_REQUIRED =
  "telegram requires the group's NUMERIC chat id (for example -1001234567890), not an " +
  "@username or an invite URL. Add the bot to the group and use the numeric id from " +
  "getChat or a group-info bot — an @username connects and even grants successfully, " +
  "but inbound Telegram updates carry the numeric id, so joins could never be matched " +
  "back to this channel and access could never be revoked.";

export const connectChannelSchema = z
  .object({
    platform: z.enum(["whatsapp", "telegram"]),
    externalGroupId: z.string().trim().min(1).max(255),
  })
  /**
   * WHY TELEGRAM IS CONSTRAINED HERE, tightening an endpoint that used to accept any
   * 1–255 string.
   *
   * Telegram accepts `@channelusername` as a `chat_id`, so a channel connected that way
   * grants access perfectly: `createChatInviteLink` works and the member gets a link
   * that works. The failure is entirely on the INBOUND side. The `chat_member` update
   * that tells us a member joined carries `chat.id` as a NUMBER, and
   * `recordPlatformMemberIdByInviteLink` requires the membership to belong to the chat
   * the update came from — a defence-in-depth match added because the write decides who
   * `banChatMember` later targets. `@kelasbudi` never equals `-1001234567890`, so the
   * match misses, the update is dropped as `unknown_invite_link`, and
   * `external_member_id` stays NULL.
   *
   * Measured: stored `@kelasbudi`, update with `-1001234567890` -> `unknown_invite_link`,
   * no id recorded. Every revocation for that community then reports
   * `no_provider_member_id_recorded` FOREVER — and that log line is documented as
   * ordinary Phase 4 noise, so nobody would ever notice. A community whose members can
   * be granted access but never removed, silently, is the phase's headline feature
   * quietly disabled.
   *
   * Normalising was the alternative and is not available: resolving `@username` to a
   * numeric id needs a `getChat` call, which belongs to the adapter and cannot be made
   * from a shared validation schema. Constraining at the door is the honest fix, and it
   * is checked HERE rather than in the adapter so the creator is told at connect time
   * — when they can still go and find the right id — instead of by a silent gap
   * discovered when they first try to remove someone.
   *
   * WhatsApp is deliberately untouched: its group ids are `120363...@g.us`, and
   * `canGateAccess` is false there, so no inbound matching depends on the format.
   */
  .superRefine((value, ctx) => {
    if (value.platform === "telegram" && !TELEGRAM_NUMERIC_CHAT_ID.test(value.externalGroupId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["externalGroupId"],
        message: TELEGRAM_NUMERIC_CHAT_ID_REQUIRED,
      });
    }
  });

export const startCheckoutSchema = z.object({
  tierId: z.string().uuid(),
  payerName: z.string().trim().min(1).max(255),
  // Indonesian numbers, tolerant of leading 0 or +62. Normalisation is a
  // later concern; this only rejects obvious junk.
  payerWhatsappNumber: z.string().trim().min(8).max(20).regex(/^[+0-9][0-9]{7,19}$/),
});

/**
 * `POST /c/:slug/join-request` — a free community's version of
 * `startCheckoutSchema`, mirrored FIELD FOR FIELD (including the WhatsApp
 * regex's tolerance for a leading 0 or +62) so the two forms validate
 * identically. A member never sees which one their community uses until they
 * submit; the two schemas disagreeing about what counts as a valid name or
 * number would be a difference with no reason behind it.
 */
export const joinRequestSchema = z.object({
  tierId: z.string().uuid(),
  payerName: z.string().trim().min(1).max(255),
  payerWhatsappNumber: z.string().trim().min(8).max(20).regex(/^[+0-9][0-9]{7,19}$/),
});

export type CreateCommunityInput = z.infer<typeof createCommunitySchema>;
export type UpdateCommunityInput = z.infer<typeof updateCommunitySchema>;
export type CreateTierInput = z.infer<typeof createTierSchema>;
export type UpdateTierInput = z.infer<typeof updateTierSchema>;
export type ConnectChannelInput = z.infer<typeof connectChannelSchema>;
export type StartCheckoutInput = z.infer<typeof startCheckoutSchema>;
export type JoinRequestInput = z.infer<typeof joinRequestSchema>;
