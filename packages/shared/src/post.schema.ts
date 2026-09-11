import { z } from "zod";

/**
 * The post types shipped so far. `materi` and `dokumen` (Phase 4) join this
 * list when the tables behind them exist — the column is `varchar(16)`, so
 * each is a one-line change here and no migration. `kegiatan` joined in Phase
 * 3, when `community_event` gave it a date to carry.
 */
export const COMMUNITY_POST_TYPES = ["diskusi", "pengumuman", "kegiatan"] as const;

export type CommunityPostType = (typeof COMMUNITY_POST_TYPES)[number];

/** The type whose extra fields live in `community_event`. */
export const EVENT_POST_TYPE = "kegiatan";

export const MAX_EVENT_TITLE_LENGTH = 160;
export const MAX_EVENT_LOCATION_LENGTH = 200;

/**
 * An ISO-8601 instant, as a string, validated by `Date` rather than by a
 * regex. `z.string().datetime()` refuses the offset forms a browser's own
 * `toISOString()` never produces but a hand-built payload does, and a regex
 * accepts `2026-02-31`. This asks the only question that matters: does it
 * parse to a real instant.
 */
const isoInstant = z
  .string()
  .refine((value) => !Number.isNaN(new Date(value).getTime()), "tanggal tidak valid");

/**
 * The when-and-where of a `kegiatan`. Required on that type and forbidden on
 * every other — see `createCommunityPostSchema`'s refinement, which is where
 * both halves of that rule live.
 */
export const eventInputSchema = z
  .object({
    title: z.string().trim().min(1).max(MAX_EVENT_TITLE_LENGTH),
    startsAt: isoInstant,
    endsAt: isoInstant.optional(),
    location: z.string().trim().min(1).max(MAX_EVENT_LOCATION_LENGTH).optional(),
  })
  // Mirrors the `community_event_ends_after_starts` CHECK. The CHECK is the
  // guarantee; this is what turns a violation into a Bahasa field error
  // instead of a 500 from a constraint the client cannot read. `>` in both
  // places: a zero-length event is a data-entry slip.
  .refine(
    (event) =>
      event.endsAt === undefined ||
      new Date(event.endsAt).getTime() > new Date(event.startsAt).getTime(),
    { message: "waktu selesai harus setelah waktu mulai", path: ["endsAt"] }
  );

export type EventInput = z.infer<typeof eventInputSchema>;

/** One screen of a thread, matching the roster's cap and for the same reason. */
export const DEFAULT_COMMENT_LIMIT = 50;

/** Shorter than a post: a comment is a reply, not a second post. */
export const MAX_COMMENT_BODY_LENGTH = 2000;

/**
 * `type` DEFAULTS rather than being required, so a member's ordinary "start a
 * discussion" submission need not name it. The route still enforces that only
 * an owner may send `pengumuman` — a default is not an authorisation.
 */
/**
 * The FIELDS, still a plain `ZodObject` and therefore still `.extend()`-able.
 *
 * `routes/communities.ts` extends this to add a `.max()` on `mediaIds` built
 * from the running process's `MAX_POST_IMAGES` — a runtime env var, not a
 * shared constant, which is why the cap cannot live here. A `.superRefine()`
 * applied at this point would return a `ZodEffects` and that extend would stop
 * existing: 402 API tests said so the first time Phase 3 tried it.
 */
export const createCommunityPostFields = z.object({
  body: z.string().trim().min(1),
  type: z.enum(COMMUNITY_POST_TYPES).default("diskusi"),
  mediaIds: z.array(z.string().uuid()).optional(),
  event: eventInputSchema.optional(),
});

/**
 * The event rule, as a refinement any extension of
 * `createCommunityPostFields` can re-apply — so the route's
 * `maxPostImages`-capped variant enforces exactly this rule rather than its
 * own copy of it.
 *
 * BOTH halves matter, and they are one function so neither can be dropped
 * without the other becoming visibly half a rule. Without the first, an event
 * with no date reaches the calendar and has no cell to sit in — the failure
 * Phase 2 named when it refused to render `kegiatan` early. Without the
 * second, a `diskusi` carrying event fields writes a `community_event` row the
 * feed card then renders on a discussion.
 */
export function refineCommunityPostEvent(
  input: { type: string; event?: unknown },
  ctx: z.RefinementCtx
): void {
  const isEvent = input.type === EVENT_POST_TYPE;
  if (isEvent && input.event === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["event"],
      message: "kegiatan harus punya jadwal",
    });
  }
  if (!isEvent && input.event !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["event"],
      message: "hanya kegiatan yang boleh punya jadwal",
    });
  }
}

export const createCommunityPostSchema =
  createCommunityPostFields.superRefine(refineCommunityPostEvent);

export type CreateCommunityPostInput = z.infer<typeof createCommunityPostSchema>;

export const createCommentSchema = z.object({
  body: z.string().trim().min(1).max(MAX_COMMENT_BODY_LENGTH),
});

export type CreateCommentInput = z.infer<typeof createCommentSchema>;
