import { eq } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import { membershipReminders } from "../../db/schema";
import type {
  MembershipReminderOutcome,
  MembershipReminderRepositoryPort,
  MembershipReminderRow,
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
   * ONE statement: `INSERT ... ON CONFLICT DO NOTHING ... RETURNING`.
   *
   * THE DATABASE ARBITRATES, and the shape is the whole implementation. `RETURNING`
   * yields a row only when the insert actually happened, so "was I first?" is answered
   * by the same statement that makes it true — there is no window between deciding and
   * claiming for a second pass to slip into.
   *
   * Written as a select-then-insert instead, every sequential test in this file still
   * passes (the reads are ordered, so the second caller sees the first caller's row)
   * and the bug only appears when two passes overlap: both read "not yet", both send,
   * and one member is told twice that their membership is ending. That is why the test
   * beside this file forces five callers to arrive at this method together before any
   * of them writes, rather than trusting the scheduler to produce the interleaving.
   *
   * The conflict target is named explicitly rather than left as a bare
   * `onConflictDoNothing()`. A bare clause swallows EVERY unique violation, so if this
   * table ever gains a second unique index a genuine conflict on it would be reported
   * here as "already claimed" — a reminder silently never sent, which is the exact
   * failure this whole pass exists to prevent.
   */
  async claim(userSubscriptionId: string): Promise<boolean> {
    const inserted = await this.db
      .insert(membershipReminders)
      .values({ userSubscriptionId })
      .onConflictDoNothing({ target: membershipReminders.userSubscriptionId })
      .returning({ id: membershipReminders.id });
    return inserted.length > 0;
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
