import { encodeKeysetCursor, type KeysetCursor } from "../../domain/keyset-cursor";
import { NotFoundError } from "../errors";
import type {
  AnalyticsRepositoryPort,
  MemberRosterRow,
} from "../ports/analytics-repository.port";

/**
 * One page of the member roster.
 *
 * The rows go out AS THEY ARE, `whatsappNumber` included — this is the screen a
 * creator manages people from, and they need to be able to reach them. That is also
 * the whole reason the endpoint behind it is authenticated and creator-scoped with no
 * exceptions: it is a list of members' personal data (Indonesia's UU PDP 27/2022
 * applies), and it must never be logged.
 */
export interface MemberRosterPage {
  members: MemberRosterEntry[];
  /** The `?before=` value for the next page, or `null` on the last one. */
  nextCursor: string | null;
}

/** A roster row on the wire: as stored, with `joinedAt` as an ISO instant. */
export interface MemberRosterEntry extends Omit<MemberRosterRow, "joinedAt"> {
  joinedAt: string;
}

export interface MemberRosterRequest {
  communityId: string;
  creatorId: string;
  limit: number;
  before?: KeysetCursor;
}

export class ListCommunityMembers {
  constructor(private readonly analytics: AnalyticsRepositoryPort) {}

  async execute(input: MemberRosterRequest): Promise<MemberRosterPage> {
    // One more than asked for, so "is there a next page" is answered by the rows
    // themselves rather than by a second `count(*)` over the roster.
    const rows = await this.analytics.listMembersForCreator(input.communityId, input.creatorId, {
      limit: input.limit + 1,
      ...(input.before === undefined ? {} : { before: input.before }),
    });

    if (rows === null) {
      throw new NotFoundError("community not found");
    }

    const hasMore = rows.length > input.limit;
    const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
    const last = pageRows[pageRows.length - 1];

    return {
      members: pageRows.map((row) => ({ ...row, joinedAt: row.joinedAt.toISOString() })),
      nextCursor:
        hasMore && last !== undefined
          ? // The SUBSCRIPTION id, not the member id: a member holding two tiers
            // appears twice, so the member id is not unique enough to anchor a page
            // boundary on. See `MemberRosterRow`.
            encodeKeysetCursor({ timestamp: last.joinedAt, id: last.subscriptionId })
          : null,
    };
  }
}
