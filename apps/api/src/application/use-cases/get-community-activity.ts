import { describeActivityEvent, type ActivitySeverity } from "../../domain/activity-feed";
import { encodeKeysetCursor, type KeysetCursor } from "../../domain/keyset-cursor";
import { NotFoundError } from "../errors";
import type { AnalyticsRepositoryPort } from "../ports/analytics-repository.port";

/**
 * One entry as the dashboard receives it.
 *
 * NOTE WHAT IS NOT HERE: the row's raw `metadata`. It carries ids and amounts by
 * construction today — every writer's comment says so — but shipping a jsonb blob
 * to a browser means whatever a future writer adds to that column is published
 * without anybody deciding to. Everything a creator needs from it is already in
 * `label`, decided by `describeActivityEvent`. The member's WhatsApp number is not
 * here for the same reason, more sharply: it is personal data, and this screen is
 * open all day.
 */
export interface ActivityFeedEntry {
  id: string;
  /**
   * The raw type, kept alongside the label so Task 7 can group or icon by it
   * without parsing Indonesian prose. Safe to expose: every value is on the
   * allowlist, so no diagnostic type name can appear here.
   */
  eventType: string;
  label: string;
  severity: ActivitySeverity;
  memberId: string | null;
  memberName: string | null;
  /** ISO 8601. The UI formats it; the API does not guess at a timezone. */
  createdAt: string;
}

export interface ActivityFeedPage {
  entries: ActivityFeedEntry[];
  /**
   * The `?before=` value for the next page, or `null` when this is the last one.
   *
   * `null` rather than a cursor that would return nothing: a "load more" button
   * that fetches an empty page is a bug a creator sees. Derived by asking the
   * repository for ONE MORE ROW than the page needs — cheaper than a `count(*)`
   * over the history, and it cannot disagree with the rows actually returned.
   */
  nextCursor: string | null;
}

/** What the route may ask for. Clamped and validated at the edge, not here. */
export interface ActivityFeedRequest {
  communityId: string;
  creatorId: string;
  limit: number;
  before?: KeysetCursor;
}

/**
 * The creator's activity feed.
 *
 * It does two things the repository deliberately does not: it turns rows into
 * Indonesian labels (via the pure domain module, so the labels are testable
 * without a database) and it decides whether a next page exists.
 */
export class GetCommunityActivity {
  constructor(private readonly analytics: AnalyticsRepositoryPort) {}

  async execute(input: ActivityFeedRequest): Promise<ActivityFeedPage> {
    // ONE MORE THAN ASKED FOR. Its presence is what says "there is a next page";
    // it is then dropped, so the extra row is never rendered.
    const rows = await this.analytics.listActivityForCreator(input.communityId, input.creatorId, {
      limit: input.limit + 1,
      ...(input.before === undefined ? {} : { before: input.before }),
    });

    if (rows === null) {
      // `null` is "not your community" — never an empty feed. Same message as every
      // other creator-scoped route, so nothing distinguishes it from "no such id".
      throw new NotFoundError("community not found");
    }

    const hasMore = rows.length > input.limit;
    const pageRows = hasMore ? rows.slice(0, input.limit) : rows;

    const entries: ActivityFeedEntry[] = [];
    for (const row of pageRows) {
      const described = describeActivityEvent(row.eventType, row.metadata);
      // Unreachable while the SQL filters on the same allowlist, and kept anyway:
      // this is the second of two independent places the allowlist is enforced, so
      // a diagnostic would have to get past both to reach a creator. Dropping the
      // row rather than labelling it "unknown event" is the safe direction.
      if (described === null) continue;
      entries.push({
        id: row.id,
        eventType: row.eventType,
        label: described.label,
        severity: described.severity,
        memberId: row.memberId,
        memberName: row.memberName,
        createdAt: row.createdAt.toISOString(),
      });
    }

    // Anchored on the last row of the WINDOW, not the last entry kept: if the
    // allowlist ever dropped a trailing row, a cursor built from the last KEPT entry
    // would hand that row back on the next page for ever.
    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && last !== undefined
        ? encodeKeysetCursor({ timestamp: last.createdAt, id: last.id })
        : null;

    return { entries, nextCursor };
  }
}
