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

/** One tag, trimmed and without its leading "#" — the UI adds that back when rendering. */
export const MAX_COMMUNITY_TAG_LENGTH = 24;
/** Per community. */
export const MAX_COMMUNITY_TAGS = 5;
/** The "Tag populer" panel's size. */
export const POPULAR_TAGS_LIMIT = 8;

/**
 * One tag: trimmed, lowercased, and its leading "#" stripped if present — so
 * "#Desain", "Desain " and "desain" all normalise to the one string that is
 * actually stored and compared.
 */
const communityTagSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((tag) => tag.replace(/^#/, ""))
  .pipe(z.string().min(1).max(MAX_COMMUNITY_TAG_LENGTH));

/**
 * The full tags list for a create or an edit. The per-tag length and the
 * per-community count are both REJECTED, not silently truncated — the same
 * discipline `createCommunitySchema`'s own maxima keep. Duplicates, in
 * contrast, are collapsed rather than rejected: `["Desain", "desain"]` is a
 * user submitting the same tag twice, not a tag list two long.
 */
export const communityTagsSchema = z
  .array(communityTagSchema)
  .max(MAX_COMMUNITY_TAGS)
  .transform((tags) => Array.from(new Set(tags)));

/**
 * The create payload. `name` is trimmed before length-checking so a padded
 * submission cannot slug differently from what the user sees, and the maxima
 * mirror the columns exactly — a payload that passes here can always be stored.
 */
export const createCommunitySchema = z.object({
  name: z.string().trim().min(3).max(MAX_COMMUNITY_NAME_LENGTH),
  category: z.enum(COMMUNITY_CATEGORIES),
  description: z.string().trim().max(MAX_COMMUNITY_DESCRIPTION_LENGTH).optional(),
  tags: communityTagsSchema.optional(),
});

export type CreateCommunityInput = z.infer<typeof createCommunitySchema>;

/** `PATCH /communities/:slug/tags` — a full replace, not a merge. */
export const updateCommunityTagsSchema = z.object({
  tags: communityTagsSchema,
});
