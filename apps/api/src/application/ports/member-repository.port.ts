export interface MemberRecord {
  id: string;
  whatsappNumber: string;
  name: string | null;
  joinedAt: Date;
}

/**
 * `member.whatsapp_number` is UNIQUE. `findOrCreateByWhatsappNumber` must
 * resolve to exactly one row per number under concurrency — two checkouts
 * from the same phone landing at the same instant is a real case (a buyer
 * double-tapping "pay"), not a hypothetical. Implementations must arbitrate
 * with the database constraint (`onConflictDoNothing`/`onConflictDoUpdate` +
 * re-select), never a check-then-insert pre-check — Phase 2 shipped two
 * TOCTOU 500s (duplicate email, slug collision) from exactly that shape.
 */
export interface MemberRepositoryPort {
  findOrCreateByWhatsappNumber(input: {
    whatsappNumber: string;
    name: string;
  }): Promise<MemberRecord>;
  /**
   * Resolves a member id — recorded on a subscription — back to the row that
   * carries the WhatsApp number every notification is addressed to.
   *
   * Unscoped by creator, deliberately: the caller is the outbox worker, which has
   * no authenticated creator at all, and a member may belong to several
   * creators' communities. It is never reachable from an authenticated route.
   * A value that cannot be a uuid is a MISS, not a driver error.
   */
  findById(id: string): Promise<MemberRecord | null>;
}
