import { and, asc, eq, gte, isNull, lt } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import { appUsers, communityEvents, posts } from "../../db/schema";
import type { EventRepositoryPort, EventRow } from "../../application/ports/event-repository.port";

export class DrizzleEventRepository implements EventRepositoryPort {
  constructor(private readonly db: DatabaseExecutor) {}

  /**
   * Leads on `community_event.community_id` — the denormalised column that
   * exists precisely so this is one range scan of
   * `community_event_community_starts_idx` rather than a walk of the
   * community's whole post history looking for the handful that are events.
   *
   * `post.deleted_at IS NULL` rides on the INNER JOIN's side: the post is an
   * event's lifecycle and `community_event` has no delete column of its own.
   * The join is INNER rather than LEFT for the same reason the filter is here
   * at all — an event whose post has vanished is not a row this should be
   * inventing an author for.
   *
   * `asc(startsAt)` matches the index's own ascending declaration, so the
   * order is satisfied by the scan rather than by a sort on top of it — the
   * NULLS-placement lesson `newestFirstOrder()` in the post repository
   * records, avoided here by not descending at all.
   */
  listBetween(communityId: string, from: Date, to: Date): Promise<EventRow[]> {
    return this.db
      .select({
        postId: communityEvents.postId,
        title: communityEvents.title,
        startsAt: communityEvents.startsAt,
        endsAt: communityEvents.endsAt,
        location: communityEvents.location,
        authorHandle: appUsers.handle,
        authorDisplayName: appUsers.displayName,
      })
      .from(communityEvents)
      .innerJoin(posts, eq(posts.id, communityEvents.postId))
      .innerJoin(appUsers, eq(appUsers.id, posts.authorId))
      .where(
        and(
          eq(communityEvents.communityId, communityId),
          // HALF-OPEN: `gte` on the start, `lt` on the end. An event at
          // exactly WIB midnight on the 1st belongs to the month that is
          // starting and to no other; a closed range would list it twice.
          gte(communityEvents.startsAt, from),
          lt(communityEvents.startsAt, to),
          isNull(posts.deletedAt)
        )
      )
      .orderBy(asc(communityEvents.startsAt));
  }
}
