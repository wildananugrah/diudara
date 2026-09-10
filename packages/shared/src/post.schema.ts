import { z } from "zod";

/**
 * The post types Phase 2 ships. `kegiatan` (Phase 3), `materi` and `dokumen`
 * (Phase 4) join this list when the tables behind them exist — the column is
 * `varchar(16)`, so each is a one-line change here and no migration.
 */
export const COMMUNITY_POST_TYPES = ["diskusi", "pengumuman"] as const;

export type CommunityPostType = (typeof COMMUNITY_POST_TYPES)[number];

/** One screen of a thread, matching the roster's cap and for the same reason. */
export const DEFAULT_COMMENT_LIMIT = 50;

/** Shorter than a post: a comment is a reply, not a second post. */
export const MAX_COMMENT_BODY_LENGTH = 2000;

/**
 * `type` DEFAULTS rather than being required, so a member's ordinary "start a
 * discussion" submission need not name it. The route still enforces that only
 * an owner may send `pengumuman` — a default is not an authorisation.
 */
export const createCommunityPostSchema = z.object({
  body: z.string().trim().min(1),
  type: z.enum(COMMUNITY_POST_TYPES).default("diskusi"),
  mediaIds: z.array(z.string().uuid()).optional(),
});

export type CreateCommunityPostInput = z.infer<typeof createCommunityPostSchema>;

export const createCommentSchema = z.object({
  body: z.string().trim().min(1).max(MAX_COMMENT_BODY_LENGTH),
});

export type CreateCommentInput = z.infer<typeof createCommentSchema>;
