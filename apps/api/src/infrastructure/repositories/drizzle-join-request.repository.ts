import { and, asc, eq, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import { joinRequests, members, membershipTiers } from "../../db/schema";
import type {
  JoinRequestRecord,
  JoinRequestRepositoryPort,
  PendingJoinRequestRow,
} from "../../application/ports/join-request-repository.port";

/** Matches the canonical 8-4-4-4-12 hex form Postgres accepts for `uuid` — see the
 * identical constant in `drizzle-subscription.repository.ts`. A malformed id here
 * must be a MISS, not a driver error: `findById` and `decide` both take an id that
 * can arrive off a URL or a request body. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `join_request.status` as created by `createPending` (the column's own default). */
const PENDING = "pending";

export class DrizzleJoinRequestRepository implements JoinRequestRepositoryPort {
  constructor(private readonly db: DatabaseExecutor) {}

  /**
   * See the port docstring. The unique index — not a preceding `select` — is what
   * decides whether this member already has an open request in this community: two
   * submits in the same instant cannot both see "nothing yet", so only the database
   * arbitrating the INSERT itself closes the race.
   *
   * `ON CONFLICT ... DO NOTHING`, deliberately NOT a bare INSERT wrapped in a
   * try/catch for `23505`. A unique violation ABORTS THE ENCLOSING TRANSACTION in
   * Postgres — every statement after it fails with "current transaction is aborted,
   * commands ignored until end of transaction block" until a ROLLBACK — so catching
   * the error here only produces a clean `null` when this call happens to be the
   * LAST statement of its transaction. `RequestToJoin` calls this from inside
   * `JoinRequestUnitOfWorkPort.run`, where it is NOT the last statement (the caller
   * goes on to check the result and, on success, enqueue an outbox row): a
   * try/catch here would return `null` as promised and then poison every statement
   * that followed, including a future `activityLog` write or a "look up the
   * existing request instead of 409ing" read. `ON CONFLICT DO NOTHING` never raises
   * the error in the first place — the loser's INSERT is simply a no-op,
   * `RETURNING` yields no row, and `null` is genuinely clean, transaction intact.
   *
   * `target` + `where` are given explicitly, matching
   * `join_request_community_member_pending_unique`'s own partial predicate exactly.
   * Postgres only infers a PARTIAL unique index as the arbiter when the `ON
   * CONFLICT` clause's `WHERE` matches the index's `WHERE`, so BOTH must be kept in
   * step with the index in `db/schema.ts` if either ever changes.
   *
   * Two failure modes, and only one of them is loud — which is why both arguments
   * stay. Give a `target` whose predicate does NOT match the index and Postgres
   * refuses the statement outright with `42P10`, "no unique or exclusion constraint
   * matching the ON CONFLICT specification"; that mistake cannot ship. But drop the
   * `target` AND the `where` together, and a bare `ON CONFLICT DO NOTHING` is
   * perfectly legal: it silently swallows a conflict on ANY constraint of this table,
   * so a future column with its own unique index would start returning `null` here as
   * though a duplicate pending request had been refused. Verified against a real
   * Postgres rather than assumed. There is no error to catch in that case, and no
   * test would necessarily notice.
   */
  async createPending(input: {
    communityId: string;
    tierId: string;
    memberId: string;
  }): Promise<JoinRequestRecord | null> {
    const [row] = await this.db
      .insert(joinRequests)
      .values({
        communityId: input.communityId,
        tierId: input.tierId,
        memberId: input.memberId,
      })
      .onConflictDoNothing({
        target: [joinRequests.communityId, joinRequests.memberId],
        where: sql`${joinRequests.status} = 'pending'`,
      })
      .returning();
    return row ?? null;
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
        // Reported verbatim, including null — see `PendingJoinRequestRow.memberName`
        // for why this repository does not choose a placeholder.
        memberName: members.name,
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
