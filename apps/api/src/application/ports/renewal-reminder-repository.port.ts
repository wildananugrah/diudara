import type { ReminderStage } from "../../domain/renewal-schedule";

/**
 * The reminder-once mechanism, expressed as a port.
 *
 * `renewal_reminder` IS A LOCK, NOT A LOG (see its definition in db/schema.ts), and
 * this is its only method for a reason: there is deliberately no `hasBeenSent`. A
 * caller that could ask would ask, and "read, decide, send, insert" is a TOCTOU under
 * READ COMMITTED — two overlapping passes both read "not yet" and both message the
 * member about the same overdue payment. Phase 4 measured the same shape as two live
 * invite links for one paying member.
 *
 * So the only way to find out whether a stage has been claimed is to CLAIM IT, and the
 * database is what answers. Implementations MUST arbitrate with the unique
 * `(subscription_id, stage)` index — `onConflictDoNothing` — and must never precede
 * the insert with a select.
 */
export interface RenewalReminderRepositoryPort {
  /**
   * Claims the right to send this subscription's reminder for this stage.
   *
   * `true` means this caller claimed it and is the one that must send; `false` means
   * somebody already has, and this caller must send nothing. A conflict is ABSORBED
   * rather than raised: a second pass has to be able to carry on with the rest of its
   * batch, not abort and leave everybody behind it unreminded.
   *
   * Throws only for a real problem — a subscription that does not exist, an
   * unreachable database.
   */
  recordIfNew(input: { subscriptionId: string; stage: ReminderStage }): Promise<boolean>;
}
