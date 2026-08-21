/**
 * What became of a membership reminder this pass claimed.
 *
 * `claimed` is the value the INSERT itself writes, and it is deliberately the
 * default rather than a state the code sets: the claim is taken before anything is
 * sent, so a row still saying `claimed` after a pass has finished means the process
 * died between claiming and delivering, or that every channel threw.
 */
export const MEMBERSHIP_REMINDER_CLAIMED = "claimed";
/** At least one channel took the message. Which ones is in `channels`. */
export const MEMBERSHIP_REMINDER_SENT = "sent";
/**
 * THE DELIBERATE SKIP: no channel could deliver at all — email is disabled on this
 * box (see `selectEmailProvider`, which returns `null` rather than a pretend adapter)
 * and the member has no `app_user.whatsapp_number`, which is nullable because signup
 * offers a number and never requires one.
 *
 * Recorded rather than passed over in silence, for the reason `process-renewals.ts`
 * gives for its own skip: *"the member was never told" is the failure mode of this
 * whole phase, so the one case where it is intentional has to be visible in the audit
 * trail.* A pass that silently reached nobody looks exactly like a pass that reached
 * everybody; this value is what tells them apart.
 *
 * IT IS ALSO THE ONE OUTCOME THAT CAN BE RE-CLAIMED, and that is not a convenience —
 * it is what stops the record of a problem from becoming the problem. This state is
 * reachable ONLY through the box: `app_user.email` is `NOT NULL UNIQUE`, so every
 * member has an email address, and "no channel at all" therefore means this deployment
 * has no email provider configured. That gets fixed; a member who was never told does
 * not. See `claim`.
 */
export const MEMBERSHIP_REMINDER_NO_CHANNEL = "no_channel";

export const MEMBERSHIP_REMINDER_OUTCOMES = [
  MEMBERSHIP_REMINDER_CLAIMED,
  MEMBERSHIP_REMINDER_SENT,
  MEMBERSHIP_REMINDER_NO_CHANNEL,
] as const;

export type MembershipReminderOutcome = (typeof MEMBERSHIP_REMINDER_OUTCOMES)[number];

/** One row of `membership_reminder`, for the tests and operators that read it back. */
export interface MembershipReminderRow {
  id: string;
  userSubscriptionId: string;
  outcome: string;
  channels: string | null;
  claimedAt: Date;
}

/**
 * The remind-once mechanism, expressed as a port.
 *
 * `membership_reminder` IS A LOCK FIRST (see its definition in db/schema.ts), and
 * that is why there is deliberately no `hasBeenReminded` here. A caller that could
 * ask would ask, and "read, decide, send, insert" is a TOCTOU under READ COMMITTED —
 * two overlapping passes both read "not yet" and both message the same member about
 * the same membership. Phase 4 measured the identical shape as two live invite links
 * for one paying member; `RenewalReminderRepositoryPort` records it for the old
 * world's reminders, and Phase 5b has now landed on "the database must arbitrate" in
 * four separate tasks.
 *
 * So the only way to find out whether a membership has already been claimed is to
 * CLAIM IT, and the database is what answers. Implementations MUST arbitrate with the
 * unique `membership_reminder_subscription_unique` index — `onConflictDoNothing`
 * naming that target — and must never precede the insert with a select.
 */
export interface MembershipReminderRepositoryPort {
  /**
   * Claims the right to remind this membership.
   *
   * `true` means this caller holds the claim and is the one that must send; `false`
   * means somebody already has, and this caller must send nothing. A conflict is
   * ABSORBED rather than raised: a second pass has to be able to carry on with the
   * rest of its batch, not abort and leave everybody behind it unreminded.
   *
   * A MEMBERSHIP WHOSE ONLY RECORD IS A `no_channel` SKIP IS CLAIMABLE AGAIN, and
   * nothing else is. Review fix round 1, I1: with every existing row treated as
   * permanent, a worker that ran for one hour without email configuration burned the
   * reminder for every in-window member who had no WhatsApp number — the skip row
   * blocked re-claiming, and fixing the configuration the next morning repaired
   * nothing. A skip records a broken BOX, not a member who cannot be reached, so it
   * has to expire when the box is repaired. A `sent` row, and a `claimed` one (a pass
   * that died between claiming and delivering, or whose audit write failed after a
   * successful send), must NEVER be re-claimed: one is a member already reminded and
   * the other is a member who may have been.
   *
   * Implementations MUST make that distinction IN THE STATEMENT — `ON CONFLICT ... DO
   * UPDATE ... WHERE outcome = 'no_channel' ... RETURNING`, whose predicate Postgres
   * evaluates against the locked current row — and must never precede the write with a
   * select. Reading the outcome first and deciding in application code is the same
   * TOCTOU this port's docstring exists to forbid, merely one level up.
   *
   * Throws only for a real problem — a subscription that does not exist, an
   * unreachable database.
   */
  claim(userSubscriptionId: string): Promise<boolean>;
  /**
   * Writes what became of a claim this caller already holds. Called AFTER the send
   * attempt, never before: the row exists from the moment of the claim, so this only
   * ever moves it off the `claimed` default.
   *
   * `false` when there is no such row, which can only mean the claim was never taken
   * or has since been released.
   */
  recordOutcome(input: {
    userSubscriptionId: string;
    outcome: MembershipReminderOutcome;
    channels: string | null;
  }): Promise<boolean>;
  /**
   * Gives the claim back, so a later pass may take it again.
   *
   * CALLED IN EXACTLY ONE PLACE — see `RemindExpiringMembership`'s class docstring —
   * when every channel that was available THREW, so the member was told nothing at
   * all. It is emphatically NOT called when one channel succeeded and another failed:
   * releasing then would let the next hourly pass re-send over the channel that
   * already worked, which is the double-send the unique index exists to prevent.
   */
  release(userSubscriptionId: string): Promise<boolean>;
  /** The claim row, or `null`. For tests and operators; no production path reads it. */
  findBySubscriptionId(userSubscriptionId: string): Promise<MembershipReminderRow | null>;
}
