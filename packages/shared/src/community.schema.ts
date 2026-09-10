import { z } from "zod";

/**
 * The six categories the design reference defines, and the only values a
 * community may carry. Exact strings, including the ampersands and the
 * Indonesian spelling — the browse page's category chips render these
 * verbatim, so a change here is a change to the UI.
 */
export const COMMUNITY_CATEGORIES = [
  "Bimbel & Ujian",
  "Coaching Bisnis",
  "Kajian & Rohani",
  "Edukasi Finansial",
  "Skill Digital",
  "Kreator & Media",
] as const;

export type CommunityCategory = (typeof COMMUNITY_CATEGORIES)[number];

/** Matches `community.name`'s column width. */
export const MAX_COMMUNITY_NAME_LENGTH = 120;
/** Matches `community.description`'s column width, and `app_user.bio`'s. */
export const MAX_COMMUNITY_DESCRIPTION_LENGTH = 300;
/** Same clamp as the people search, and for the same reason: the query groups over a table. */
export const MAX_COMMUNITY_SEARCH_LENGTH = 100;
/** One screen of cards. */
export const DEFAULT_COMMUNITY_LIST_LIMIT = 24;
/** The same cap the follow lists use, so a roster truncates the way a follower list does. */
export const DEFAULT_COMMUNITY_MEMBER_LIMIT = 50;

/**
 * The create payload. `name` is trimmed before length-checking so a padded
 * submission cannot slug differently from what the user sees, and the maxima
 * mirror the columns exactly — a payload that passes here can always be stored.
 */
export const createCommunitySchema = z.object({
  name: z.string().trim().min(3).max(MAX_COMMUNITY_NAME_LENGTH),
  category: z.enum(COMMUNITY_CATEGORIES),
  description: z.string().trim().max(MAX_COMMUNITY_DESCRIPTION_LENGTH).optional(),
});

export type CreateCommunityInput = z.infer<typeof createCommunitySchema>;
