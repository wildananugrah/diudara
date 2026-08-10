/**
 * The per-creator daily spend cap on the AI co-builder.
 *
 * Every chat turn costs real money at the upstream provider, so this is the
 * ONLY thing standing between a creator (or a bug, or an attacker with a
 * stolen session) and an unbounded bill. `ai_usage` (Task 1) carries a real
 * UNIQUE index on `(creator_id, usage_date)` for exactly this reason: it lets
 * the check-and-increment be ONE statement that the database arbitrates,
 * rather than an application-level read-then-write.
 *
 * Implementations MUST NOT read the current count and then decide whether to
 * write — two callers racing the same creator's same day would both read a
 * count one below the limit, both decide "allowed", and both write, so the
 * pair together exceed the cap even though each call looked safe on its own.
 * The single-statement upsert closes that window: the database only ever
 * lets one write per row proceed at a time, and each write re-checks the cap
 * against the row's CURRENT value, never a stale snapshot read earlier.
 */
export interface AiUsageRepositoryPort {
  /**
   * Atomically checks the cap and, if there is room, records one more
   * message for `creatorId` on `usageDate`.
   *
   * @param usageDate The UTC calendar day to charge this call against,
   *   supplied by the caller as a `date`. The repository does not compute
   *   "today" from a wall clock — that would make the cap untestable and
   *   would tie this port to a particular notion of "now".
   * @param dailyLimit How many messages `creatorId` may send on
   *   `usageDate` before further calls are refused.
   * @returns `allowed: true` and the new `used` count when this call was
   *   under the cap and got counted; `allowed: false` and the count already
   *   on record (unchanged by this call) when the cap was already reached.
   */
  consumeOne(input: {
    creatorId: string;
    usageDate: string;
    dailyLimit: number;
  }): Promise<{ allowed: boolean; used: number }>;
}
