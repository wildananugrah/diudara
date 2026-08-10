import { z } from "zod";

/**
 * One tier inside a community draft. Bounds mirror `createTierSchema`
 * (`community.schema.ts`) and the `membership_tier` columns exactly: `name`
 * varchar(128), `price_amount` a Postgres `integer` (never floating point —
 * this is Rupiah, and a fractional Rupiah has no meaning), `billing_cycle` one
 * of the three cycles the rest of the app already knows.
 *
 * A draft tier that fails `createTierSchema` when the creator tries to save it
 * is worse than no draft at all, so these two schemas are kept in lockstep
 * deliberately rather than sharing a definition — the AI's shape and the
 * manual-entry shape are allowed to diverge only if someone changes both on
 * purpose.
 */
export const communityDraftTierSchema = z.object({
  name: z.string().trim().min(1).max(128),
  priceAmount: z.number().int().min(0).max(2_000_000_000),
  billingCycle: z.enum(["monthly", "quarterly", "yearly"]),
});

/**
 * The shape an AI provider MUST produce when it proposes a community draft.
 *
 * `name` and `niche` mirror the `community` table's `name` varchar(255) and
 * `niche` varchar(128) columns exactly (see `createCommunitySchema`). `tiers`
 * is bounded 1-3: zero tiers is not a usable draft, and a paid-community
 * product with more than a handful of tiers stops being a "pick one" decision
 * for a member — the product ceiling the manual create flow was never given
 * either, so the AI is held to the same discipline here rather than being
 * allowed to propose more just because generating more text is free.
 *
 * `description` and `welcomeMessage` have no existing DB column to mirror —
 * Phase 2's `POST /communities` only ever accepts `name`/`niche` — so these two
 * are free text the creator reads and edits before it goes anywhere, bounded
 * generously enough for real prose (a paragraph, a short greeting) but never
 * unbounded, per the phase's "length-bounded before it leaves the adapter"
 * rule for untrusted model output.
 *
 * The port's contract is "parsed data or throw" — this schema IS the parse
 * step. Anything that fails it is malformed output, not a draft.
 */
export const communityDraftSchema = z.object({
  name: z.string().trim().min(1).max(255),
  niche: z.string().trim().min(1).max(128),
  description: z.string().trim().min(1).max(2000),
  welcomeMessage: z.string().trim().min(1).max(1000),
  tiers: z.array(communityDraftTierSchema).min(1).max(3),
});

export type CommunityDraftTier = z.infer<typeof communityDraftTierSchema>;
export type CommunityDraft = z.infer<typeof communityDraftSchema>;
