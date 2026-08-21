import { describe, expect, it } from "bun:test";
import { sql } from "./client";

/**
 * Phase 5b, Task 3's own index decision — see `schema.ts`'s
 * `user_subscription_status_current_period_end_idx` for the reasoning. Task 1's
 * review flagged that nothing covered `listExpiredActive`'s `(status,
 * current_period_end)` predicate; Task 1 was explicitly a no-migration task, so it
 * deferred both the decision and the migration to Task 3 — the task that actually
 * scans the table every hour via `SweepExpiredMemberships`
 * (`apps/worker/src/scheduled-passes.ts`).
 *
 * ASSERTED AGAINST `pg_indexes`, not against `schema.ts` — same reasoning as
 * `schema-phase5.test.ts`'s equivalent test for Phase 5's own hourly passes: a
 * declaration in the schema that never became a migration is exactly the state this
 * project has shipped before, and only the database can say whether an index exists.
 * These tests run against a freshly migrated per-run database, so they also pin that
 * the migration was actually generated, not merely that the schema was edited.
 *
 * NO EXPLAIN/selectivity test here, unlike `schema-phase5.test.ts`'s bulk-seeded one.
 * `user_subscription` holds zero rows in production today (spec — Phase 5b has not
 * shipped), so there is no realistic backlog to seed a selective plan against yet; the
 * cost this index avoids is a future one. Existence and column order are what a wrong
 * migration — or a silently dropped modifier, which is exactly what cost this project
 * a day once — would get wrong, and that is what this test pins.
 */
describe("the index Task 3's hourly retirement sweep reads through", () => {
  it("indexes listExpiredActive's (status, current_period_end), in that column order", async () => {
    const rows = await sql`
      select indexdef from pg_indexes
      where tablename = 'user_subscription'
        and indexname = 'user_subscription_status_current_period_end_idx'
    `;
    expect(rows.length).toBe(1);
    const def = String(rows[0].indexdef);
    // Not partial. See schema.ts's own docstring for why: this table already carries
    // two load-bearing partial indexes, and a third — purely for speed — mixed into
    // the same list is exactly the kind of place a `.where(...)` has silently vanished
    // before. A plain index needs no such trust.
    expect(def).not.toContain("WHERE");
    // COLUMN ORDER: `status` must lead. The query's predicate on it is an equality
    // (`status = 'active'`), which is what makes the index selective; `current_period_end`
    // trails because the query's predicate on it is a RANGE (`<= now`), and only a
    // trailing column can serve a range once the leading column is fixed. Reversed,
    // the index could not serve the equality filter at all.
    expect(def).toMatch(/\(\s*"?status"?\s*,\s*"?current_period_end"?\s*\)/);
  });
});
