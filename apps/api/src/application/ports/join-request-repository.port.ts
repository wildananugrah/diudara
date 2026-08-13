export interface JoinRequestRecord {
  id: string;
  communityId: string;
  tierId: string;
  memberId: string;
  status: string;
  createdAt: Date;
  decidedAt: Date | null;
  decidedBy: string | null;
}

/**
 * One row of the owner's pending-requests list: the request itself plus what a
 * human needs to decide on it, resolved in one read rather than three round
 * trips per row.
 */
export interface PendingJoinRequestRow {
  id: string;
  memberId: string;
  /**
   * `member.name`, verbatim — including null. A WhatsApp-only signup may have none.
   *
   * Deliberately NOT coalesced to `''` here: this is a repository, one layer below
   * anyone who knows what the string is FOR. A WhatsApp message built from an empty
   * string reads as a broken sentence with a doubled space and no error anywhere;
   * a dashboard table cell might reasonably render "(tanpa nama)" instead. Each
   * caller that knows its medium chooses its own honest placeholder — reporting
   * `null` here is what lets it.
   */
  memberName: string | null;
  memberWhatsappNumber: string;
  tierId: string;
  tierName: string;
  createdAt: Date;
}

/**
 * FREE-community membership requests: a member asks to join, the owner
 * approves or rejects. See `join_request_community_member_pending_unique` in
 * `db/schema.ts` for why the database, not a read-then-write, is what
 * arbitrates one open request per (community, member).
 */
export interface JoinRequestRepositoryPort {
  /**
   * Returns null when a pending request already exists — the unique index refused
   * it — WITHOUT aborting an enclosing transaction. Implementations must arbitrate
   * with `ON CONFLICT ... DO NOTHING` (or equivalent), never a bare INSERT caught
   * for a unique-violation error: a caught `23505` is clean on its own, but Postgres
   * has already aborted the transaction by the time the catch runs, so anything this
   * method's caller does afterwards IN THE SAME TRANSACTION — as `RequestToJoin`
   * does, via `JoinRequestUnitOfWorkPort` — would fail with "current transaction is
   * aborted" instead of proceeding normally.
   */
  createPending(input: {
    communityId: string;
    tierId: string;
    memberId: string;
  }): Promise<JoinRequestRecord | null>;
  findById(id: string): Promise<JoinRequestRecord | null>;
  listPendingForCommunity(communityId: string): Promise<PendingJoinRequestRow[]>;
  /** Returns false when the row was already decided — the caller turns that into 409. */
  decide(input: {
    id: string;
    status: "approved" | "rejected";
    decidedBy: string;
    decidedAt: Date;
  }): Promise<boolean>;
}
