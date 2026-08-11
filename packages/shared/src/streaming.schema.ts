import { z } from "zod";

/**
 * `POST /communities/:communityId/events` — scheduling a live session
 * (Task 3). `scheduledAt` is optional: the design spec (§4) describes
 * scheduling with "a title and optional time", so a creator can create a
 * session to go live immediately without picking a slot first.
 *
 * `z.coerce.date()` rather than `z.string().datetime()` because the wire
 * value is JSON — there is no native Date — and coercion turns whatever the
 * client sent (an ISO-8601 string, most likely) into an actual `Date` right
 * here, so every layer below the HTTP boundary works with a `Date` and never
 * re-parses a string. An unparseable value fails `z.coerce.date()`'s own
 * validity check with the usual 400, rather than becoming `Invalid Date` and
 * failing confusingly deep inside a repository insert.
 */
export const scheduleLiveSessionSchema = z.object({
  title: z.string().trim().min(1).max(255),
  scheduledAt: z.coerce.date().optional(),
});

export type ScheduleLiveSessionInput = z.infer<typeof scheduleLiveSessionSchema>;
