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

/**
 * Task 4's claim table. A claim table's entire value is its unique index: the claim
 * is an INSERT that either succeeds (you claimed it) or violates (somebody else
 * did). A missing — or merely non-unique — index silently turns "claim before send"
 * into "send twice", and NOTHING FAILS.
 *
 * Read out of `pg_indexes` rather than out of `schema.ts` for the reason the test
 * above gives: a declaration that never became a migration is a state this project
 * has shipped, and only the database can say whether an index exists. This project
 * has also lost a day to drizzle emitting a modifier nobody asked for, so the
 * definition is checked for what it must NOT contain as well.
 */
describe("the index that makes Task 4's reminder claim a claim", () => {
  it("holds membership_reminder.user_subscription_id UNIQUE", async () => {
    const rows = await sql`
      select indexdef from pg_indexes
      where tablename = 'membership_reminder'
        and indexname = 'membership_reminder_subscription_unique'
    `;
    expect(rows.length).toBe(1);
    const def = String(rows[0].indexdef);
    // UNIQUE is the whole mechanism. A plain index here would let a second pass
    // insert a second claim and send a second reminder, in silence.
    expect(def).toContain("CREATE UNIQUE INDEX");
    expect(def).toMatch(/\(\s*"?user_subscription_id"?\s*\)/);
    // TOTAL, not partial. Every membership is claimed at most once, ever — there is
    // no legitimate second send, because a member who buys again gets a NEW
    // `user_subscription` row with a new id. A stray `WHERE` here would be exactly
    // the silently-dropped-or-added modifier this project has paid for before.
    expect(def).not.toContain("WHERE");
  });

  it("REFUSES a second claim row for the same membership at the database level", async () => {
    // The index is only worth having if Postgres actually enforces it, and the one
    // way to know is to try. Inserted with raw SQL rather than through the
    // repository, so this test fails if the repository's conflict clause is what is
    // doing the work rather than the constraint.
    const [subscriber] = await sql`
      insert into app_user (handle, email, password_hash, display_name)
      values ('claimsub', 'claimsub@example.com', 'x', 'Sub') returning id
    `;
    const [owner] = await sql`
      insert into app_user (handle, email, password_hash, display_name)
      values ('claimown', 'claimown@example.com', 'x', 'Own') returning id
    `;
    const [tier] = await sql`
      insert into user_tier (owner_id, name, price_amount, billing_cycle)
      values (${owner.id}, 'Anggota', 50000, 'monthly') returning id
    `;
    const [subscription] = await sql`
      insert into user_subscription (subscriber_id, tier_id, owner_id, status)
      values (${subscriber.id}, ${tier.id}, ${owner.id}, 'active') returning id
    `;

    await sql`insert into membership_reminder (user_subscription_id) values (${subscription.id})`;

    let raised: unknown = null;
    try {
      await sql`insert into membership_reminder (user_subscription_id) values (${subscription.id})`;
    } catch (err) {
      raised = err;
    }
    expect(raised).not.toBe(null);
    // The CONSTRAINT'S OWN NAME, so a version that exists only in `schema.ts` fails
    // this suite — the same assertion `schema-phase5.test.ts` makes of
    // `renewal_reminder`.
    const violation = raised as { constraint_name?: string; cause?: { constraint_name?: string } };
    expect(violation.constraint_name ?? violation.cause?.constraint_name).toBe(
      "membership_reminder_subscription_unique"
    );
  });
});
