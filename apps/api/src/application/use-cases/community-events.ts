import { NotFoundError } from "../errors";
import { wibMonthRange } from "../../domain/wib-month";
import type { ClockPort } from "../ports/clock.port";
import type { CommunityRepositoryPort } from "../ports/community-repository.port";
import type { EventRepositoryPort, EventRow } from "../ports/event-repository.port";

/**
 * One event as the calendar's wire sees it. Nested HERE, the one place this
 * projection is assembled, exactly as `toPostView` and `toCommentView` are.
 *
 * `endsAt` and `location` are explicitly `null` rather than omitted, so the
 * key set is stable — the reasoning `PostView` already records.
 */
export interface CommunityEventView {
  /** The post the event hangs on. The detail link is built from it. */
  postId: string;
  title: string;
  /** ISO-8601. */
  startsAt: string;
  /** ISO-8601, or null on an event with no stated end. */
  endsAt: string | null;
  location: string | null;
  author: { handle: string; displayName: string };
}

export interface CommunityEventsPage {
  /**
   * Ascending by `startsAt` — the repository's order, not re-sorted here.
   * NO cursor: this is one WIB month of one community, and the calendar grid
   * must hold all of it to render at all.
   */
  events: CommunityEventView[];
}

function toEventView(row: EventRow): CommunityEventView {
  return {
    postId: row.postId,
    title: row.title,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt === null ? null : row.endsAt.toISOString(),
    location: row.location,
    author: { handle: row.authorHandle, displayName: row.authorDisplayName },
  };
}

/**
 * One community's calendar month — the **Kegiatan** tab's grid and the agenda
 * below it, from a single fetch. Two fetches for one month's data would be two
 * chances to disagree on screen.
 *
 * `month` is a WIB month (`YYYY-MM`); absent or malformed means the WIB month
 * containing the clock's now. `wibMonthRange` owns both rules and the reason
 * they are not UTC.
 *
 * The slug resolves FIRST and an unknown one is a `NotFoundError` before any
 * event query runs — the same ordering `ListCommunityFeed` and
 * `CreateCommunityPost` keep, so a response never confirms which slugs exist
 * by how long it took or what it queried.
 *
 * Reading is OPEN: no viewer id, no membership check. Phase 1's model is that
 * every community is open-join with one unconditional click, so a wall in
 * front of the calendar stops nobody while making a community impossible to
 * evaluate before joining.
 */
export class ListCommunityEvents {
  constructor(
    private readonly communities: CommunityRepositoryPort,
    private readonly events: EventRepositoryPort,
    private readonly clock: ClockPort
  ) {}

  async execute(input: { slug: string; month?: string }): Promise<CommunityEventsPage> {
    const community = await this.communities.findBySlug(input.slug);
    if (community === null) throw new NotFoundError("komunitas tidak ditemukan");

    const { from, to } = wibMonthRange(input.month, this.clock.now());
    const rows = await this.events.listBetween(community.id, from, to);
    return { events: rows.map(toEventView) };
  }
}
