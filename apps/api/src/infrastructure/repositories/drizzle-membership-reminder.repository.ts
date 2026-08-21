import { eq, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import { membershipReminders } from "../../db/schema";
import {
  MEMBERSHIP_REMINDER_CLAIMED,
  MEMBERSHIP_REMINDER_NO_CHANNEL,
  type MembershipReminderOutcome,
  type MembershipReminderRepositoryPort,
  type MembershipReminderRow,
} from "../../application/ports/membership-reminder-repository.port";

/** Drizzle hands `varchar` back as `string`; the port's row type is narrower than nothing. */
function toRow(row: typeof membershipReminders.$inferSelect): MembershipReminderRow {
  return {
    id: row.id,
    userSubscriptionId: row.userSubscriptionId,
    outcome: row.outcome,
    channels: row.channels,
    claimedAt: row.claimedAt,
  };
}

export class DrizzleMembershipReminderRepository implements MembershipReminderRepositoryPort {
  /**
   * `DatabaseExecutor`, like every other repository here, so the same class works
   * against the pool and against an open transaction handle.
   */
  constructor(private readonly db: DatabaseExecutor) {}

  /**
   * ONE statement: `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE ... RETURNING`.
   *
   * THE DATABASE ARBITRATES, and the shape is the whole implementation. `RETURNING`
   * yields a row only when this statement actually claimed something, so "was I the
   * one?" is answered by the same statement that makes it true — there is no window
   * between deciding and claiming for a second pass to slip into.
   *
   * Written as a select-then-insert instead, every sequential test in this file still
   * passes (the reads are ordered, so the second caller sees the first caller's row)
   * and the bug only appears when two passes overlap: both read "not yet", both send,
   * and one member is told twice that their membership is ending. That is why the test
   * beside this file forces five callers to arrive at this method together before any
   * of them writes — AND WARMS THE CONNECTION POOL FIRST, without which the driver
   * serialises them and the broken version passes; see that test for the measurement.
   *
   * ==================================================================
   * WHY `DO UPDATE ... WHERE outcome = 'no_channel'` AND NOT `DO NOTHING`
   *
   * Review fix round 1, I1. `DO NOTHING` made EVERY existing row permanent, including
   * a row that records a skip — and a skip is not a member's property, it is the
   * BOX's. `app_user.email` is `NOT NULL UNIQUE`, so a member always has an email
   * address; the only way `RemindExpiringMembership` can find no channel at all is
   * `selectEmailProvider` having returned `null`, i.e. this deployment has no email
   * provider configured. That is a condition somebody fixes.
   *
   * Under `DO NOTHING`, a worker running for one hour without email configuration
   * permanently burned the reminder for every in-window member without a WhatsApp
   * number: the row said `no_channel`, the unique index forbade re-claiming it, and
   * fixing the configuration the next morning repaired nothing. Those members were
   * simply never told, which is the precise failure spec §6 exists to prevent.
   *
   * So a `no_channel` row is RE-CLAIMABLE and everything else is not. The predicate
   * lives in the DO UPDATE's own `WHERE`, evaluated by Postgres against the locked,
   * current version of the conflicting row — so it stays the database's decision under
   * concurrency, not a read this class performs and then acts on. A row that says
   * `sent` (a member who was actually reminded) or `claimed` (a pass that died between
   * claiming and delivering, or whose audit write failed after a successful send)
   * fails the predicate, updates nothing, returns nothing, and is never sent twice.
   * ==================================================================
   *
   * The conflict target is named explicitly rather than left implicit. It keeps the
   * arbitration narrow: if this table ever gains a second unique index, a genuine
   * conflict on it must raise, never be absorbed as "already claimed".
   */
  async claim(userSubscriptionId: string): Promise<boolean> {
    const claimed = await this.db
      .insert(membershipReminders)
      .values({ userSubscriptionId })
      .onConflictDoUpdate({
        target: membershipReminders.userSubscriptionId,
        // Back to a fresh, undelivered claim — including `claimedAt`, so the row says
        // when the claim that matters was taken rather than when the box was broken.
        set: {
          outcome: MEMBERSHIP_REMINDER_CLAIMED,
          channels: null,
          claimedAt: new Date(),
        },
        // ONLY a skip may be re-claimed. Qualified with the table name because
        // `EXCLUDED` is also in scope here, and an unqualified `outcome` would read
        // the row this statement is proposing — which is always 'claimed', making the
        // predicate trivially true and every reminder re-sendable.
        setWhere: sql`${membershipReminders.outcome} = ${MEMBERSHIP_REMINDER_NO_CHANNEL}`,
      })
      .returning({ id: membershipReminders.id });
    return claimed.length > 0;
  }

  /**
   * Moves an existing claim off its `claimed` default. Never an upsert: a row that is
   * not there was never claimed by this caller, and inserting one here would record an
   * outcome for a send nobody had the right to make.
   */
  async recordOutcome(input: {
    userSubscriptionId: string;
    outcome: MembershipReminderOutcome;
    channels: string | null;
  }): Promise<boolean> {
    const updated = await this.db
      .update(membershipReminders)
      .set({ outcome: input.outcome, channels: input.channels })
      .where(eq(membershipReminders.userSubscriptionId, input.userSubscriptionId))
      .returning({ id: membershipReminders.id });
    return updated.length > 0;
  }

  /** See the port docstring for the ONE situation in which this may be called. */
  async release(userSubscriptionId: string): Promise<boolean> {
    const deleted = await this.db
      .delete(membershipReminders)
      .where(eq(membershipReminders.userSubscriptionId, userSubscriptionId))
      .returning({ id: membershipReminders.id });
    return deleted.length > 0;
  }

  async findBySubscriptionId(userSubscriptionId: string): Promise<MembershipReminderRow | null> {
    const [row] = await this.db
      .select()
      .from(membershipReminders)
      .where(eq(membershipReminders.userSubscriptionId, userSubscriptionId))
      .limit(1);
    return row ? toRow(row) : null;
  }
}
