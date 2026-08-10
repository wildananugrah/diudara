import { and, eq, lt, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import { aiUsage } from "../../db/schema";
import type { AiUsageRepositoryPort } from "../../application/ports/ai-usage-repository.port";

export class DrizzleAiUsageRepository implements AiUsageRepositoryPort {
  constructor(private readonly db: DatabaseExecutor) {}

  /**
   * One statement, and the DATABASE decides. `INSERT ... ON CONFLICT
   * (creator_id, usage_date) DO UPDATE SET message_count = message_count + 1
   * WHERE message_count < $limit RETURNING message_count` is the check and
   * the increment together: Postgres locks the conflicting row, re-evaluates
   * the `WHERE` against its CURRENT value (never a snapshot read earlier by
   * this or any other caller), and only then decides whether to write.
   *
   * `rows.length === 0` is the truthful "the cap was already reached" —
   * either there was no conflicting row's WHERE match because it's already
   * at the limit. A concurrent second caller blocked behind this statement's
   * row lock re-runs the SAME predicate against the value THIS call just
   * committed, so two callers racing the last slot can never both win it.
   *
   * Do NOT rewrite this as a `select` to check the count followed by an
   * `update`: two callers would both read the same stale count, both decide
   * "allowed", and both write — the pair together exceed `dailyLimit` even
   * though neither call looked unsafe on its own. This is exactly the class
   * of bug `WebhookEventRepositoryPort.recordIfNew` avoids for the same
   * reason, on the other unique index in this codebase.
   */
  async consumeOne(input: {
    creatorId: string;
    usageDate: string;
    dailyLimit: number;
  }): Promise<{ allowed: boolean; used: number }> {
    const rows = await this.db
      .insert(aiUsage)
      .values({
        creatorId: input.creatorId,
        usageDate: input.usageDate,
        messageCount: 1,
      })
      .onConflictDoUpdate({
        target: [aiUsage.creatorId, aiUsage.usageDate],
        set: { messageCount: sql`${aiUsage.messageCount} + 1` },
        setWhere: lt(aiUsage.messageCount, input.dailyLimit),
      })
      .returning({ messageCount: aiUsage.messageCount });

    if (rows.length > 0) {
      return { allowed: true, used: rows[0].messageCount };
    }

    // The cap was already reached: no row was written by the statement
    // above, so there is nothing to derive `used` from in its result. This
    // read is purely for REPORTING the count after the atomic decision has
    // already been made — the decision itself ("allowed") is already final
    // by the time we get here, so a stale or slightly-later value here
    // cannot let anyone through who should not be.
    const [existing] = await this.db
      .select({ messageCount: aiUsage.messageCount })
      .from(aiUsage)
      .where(and(eq(aiUsage.creatorId, input.creatorId), eq(aiUsage.usageDate, input.usageDate)));

    // The UPSERT above only reaches this branch by losing its ON CONFLICT
    // race — which requires a conflicting row to exist. A missing row here
    // means that invariant broke (the row was deleted between the UPSERT and
    // this read, or something else is wrong), so surface that loudly rather
    // than silently reporting a guessed value.
    if (!existing) {
      throw new Error(
        `ai_usage row for creator=${input.creatorId} date=${input.usageDate} vanished ` +
          "between the guarded UPSERT reporting the cap as reached and this reporting read"
      );
    }

    return { allowed: false, used: existing.messageCount };
  }
}
