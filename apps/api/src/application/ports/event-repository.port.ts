/**
 * One scheduled event as the calendar reads it: FLAT, with the author's
 * public fields joined in — the same rule `PostRow` and `CommentRow` follow.
 * The nesting into `{ author: { ... } }` happens in the view mapper, so the
 * shape the wire sees is decided in exactly one place.
 *
 * NO `body`. The calendar shows a title and a time; the description belongs
 * to the page the reader reaches by clicking, which is `GET /users/posts/:id`
 * and already carries it.
 */
export interface EventRow {
  /**
   * The `post` this event hangs on, which is also `community_event`'s primary
   * key. Named `postId` and not `id` because that is what it is, and because
   * the detail link is built from it.
   */
  postId: string;
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  location: string | null;
  authorHandle: string;
  authorDisplayName: string;
}

export interface EventRepositoryPort {
  /**
   * One community's events starting inside `[from, to)`, ASCENDING by
   * `startsAt` — the order the agenda renders in, so no caller re-sorts.
   *
   * Half-open on purpose: `to` is the first instant of the NEXT month, so an
   * event at exactly WIB midnight on the 1st belongs to the month that is
   * starting and to no other. A closed range would put it in both.
   *
   * Excludes events whose post is soft-deleted — the post is the lifecycle
   * (`community_event` has no `deleted_at` of its own), so this filter lands
   * on the joined side.
   *
   * UNPAGINATED, and deliberately. The keyset cursor every feed carries exists
   * because a feed is unbounded; a month is not. If that assumption ever
   * breaks, the calendar grid — which must hold the whole month to render at
   * all — is what has to change, not just this signature.
   */
  listBetween(communityId: string, from: Date, to: Date): Promise<EventRow[]>;
}
