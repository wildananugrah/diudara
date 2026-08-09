import type { DatabaseExecutor } from "../../db/client";
import { renewalReminders } from "../../db/schema";
import type { RenewalReminderRepositoryPort } from "../../application/ports/renewal-reminder-repository.port";
import type { ReminderStage } from "../../domain/renewal-schedule";

export class DrizzleRenewalReminderRepository implements RenewalReminderRepositoryPort {
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
   * Written as a select-then-insert instead, every sequential test still passes (the
   * reads are ordered, so the second caller sees the first caller's row) and the bug
   * only appears when two passes overlap: both read "not yet", both send, and one
   * member gets two WhatsApp messages about one overdue payment. That is why
   * drizzle-renewal-reminder.repository.test.ts forces five callers to arrive at this
   * method together before any of them writes, rather than trusting the scheduler to
   * produce the interleaving.
   *
   * The conflict target is named explicitly rather than left as a bare
   * `onConflictDoNothing()`. A bare clause swallows EVERY unique violation, so if this
   * table ever gains a second unique index a genuine conflict on it would be reported
   * here as "already claimed" — a reminder silently never sent.
   */
  async recordIfNew(input: {
    subscriptionId: string;
    stage: ReminderStage;
  }): Promise<boolean> {
    const inserted = await this.db
      .insert(renewalReminders)
      .values({ subscriptionId: input.subscriptionId, stage: input.stage })
      .onConflictDoNothing({
        target: [renewalReminders.subscriptionId, renewalReminders.stage],
      })
      .returning({ id: renewalReminders.id });
    return inserted.length > 0;
  }
}
