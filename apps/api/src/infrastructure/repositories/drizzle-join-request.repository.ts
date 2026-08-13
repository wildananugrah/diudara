import { and, asc, eq, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import { joinRequests, members, membershipTiers } from "../../db/schema";
import type {
  JoinRequestRecord,
  JoinRequestRepositoryPort,
  PendingJoinRequestRow,
} from "../../application/ports/join-request-repository.port";
import { uniqueViolationConstraint } from "./pg-errors";

/** Matches the canonical 8-4-4-4-12 hex form Postgres accepts for `uuid` — see the
 * identical constant in `drizzle-subscription.repository.ts`. A malformed id here
 * must be a MISS, not a driver error: `findById` and `decide` both take an id that
 * can arrive off a URL or a request body. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `join_request.status` as created by `createPending` (the column's own default). */
const PENDING = "pending";

/**
 * The unique index's name — see `join_request_community_member_pending_unique` in
 * `db/schema.ts`. `createPending` catches exactly this constraint's violation and
 * turns it into `null`; any other unique violation is a programming error and is
 * left to propagate.
 */
const PENDING_UNIQUE_CONSTRAINT = "join_request_community_member_pending_unique";

export class DrizzleJoinRequestRepository implements JoinRequestRepositoryPort {
  constructor(private readonly db: DatabaseExecutor) {}

  /**
   * See the port docstring. The unique index — not a preceding `select` — is what
   * decides whether this member already has an open request in this community: two
   * submits in the same instant cannot both see "nothing yet", so only the database
   * arbitrating the INSERT itself closes the race. The loser gets a clean `null`
   * rather than an unhandled `23505` reaching the caller as a 500.
   */
  async createPending(input: {
    communityId: string;
    tierId: string;
    memberId: string;
  }): Promise<JoinRequestRecord | null> {
    try {
      const [row] = await this.db
        .insert(joinRequests)
        .values({
          communityId: input.communityId,
          tierId: input.tierId,
          memberId: input.memberId,
        })
        .returning();
      return row;
    } catch (err) {
      if (uniqueViolationConstraint(err) === PENDING_UNIQUE_CONSTRAINT) {
        return null;
      }
      throw err;
    }
  }

  async findById(id: string): Promise<JoinRequestRecord | null> {
    if (!UUID_PATTERN.test(id)) {
      return null;
    }
    const [row] = await this.db
      .select()
      .from(joinRequests)
      .where(eq(joinRequests.id, id))
      .limit(1);
    return row ?? null;
  }

  /**
   * The owner's dashboard list: every open request in this community, joined with
   * what a human needs to decide on it — the member's name and WhatsApp number, and
   * the tier's name — so the caller needs no second round trip per row.
   */
  async listPendingForCommunity(communityId: string): Promise<PendingJoinRequestRow[]> {
    if (!UUID_PATTERN.test(communityId)) {
      return [];
    }
    return this.db
      .select({
        id: joinRequests.id,
        memberId: joinRequests.memberId,
        // `member.name` is nullable (a WhatsApp-only signup may have none), but the
        // owner's decision screen always needs SOMETHING to show — coalesced here
        // rather than left null so a caller cannot forget to guard it.
        memberName: sql<string>`coalesce(${members.name}, '')`,
        memberWhatsappNumber: members.whatsappNumber,
        tierId: joinRequests.tierId,
        tierName: membershipTiers.name,
        createdAt: joinRequests.createdAt,
      })
      .from(joinRequests)
      .innerJoin(members, eq(joinRequests.memberId, members.id))
      .innerJoin(membershipTiers, eq(joinRequests.tierId, membershipTiers.id))
      .where(and(eq(joinRequests.communityId, communityId), eq(joinRequests.status, PENDING)))
      .orderBy(asc(joinRequests.createdAt));
  }

  /**
   * `status = 'pending'` is IN the UPDATE predicate, not read first. That is what
   * makes this a CONDITIONAL update rather than a read-then-write: two owners
   * clicking approve/reject on the same request at once both reach this method, but
   * only the first affects a row — the predicate has already stopped matching by
   * the time the second's UPDATE runs — so only one may report `true`.
   */
  async decide(input: {
    id: string;
    status: "approved" | "rejected";
    decidedBy: string;
    decidedAt: Date;
  }): Promise<boolean> {
    if (!UUID_PATTERN.test(input.id)) {
      return false;
    }
    const rows = await this.db
      .update(joinRequests)
      .set({ status: input.status, decidedBy: input.decidedBy, decidedAt: input.decidedAt })
      .where(and(eq(joinRequests.id, input.id), eq(joinRequests.status, PENDING)))
      .returning({ id: joinRequests.id });
    return rows.length > 0;
  }
}
