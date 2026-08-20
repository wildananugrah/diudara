import { describe, expect, it, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db, sql as pgClient } from "../../db/client";
import { appUsers } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { FixedClock } from "../../infrastructure/clock/fixed.clock";
import { DrizzleUserTierRepository } from "../../infrastructure/repositories/drizzle-user-tier.repository";
import { DrizzleUserSubscriptionRepository } from "../../infrastructure/repositories/drizzle-user-subscription.repository";
import { IsMemberOf } from "./is-member-of";

beforeEach(resetDatabase);

/** Placed deliberately in the middle of a subscription's real period, never on a boundary. */
const NOW = new Date("2026-08-18T12:00:00.000Z");
const PAST_PERIOD_END = new Date("2026-08-01T00:00:00.000Z"); // before NOW
const FUTURE_PERIOD_END = new Date("2026-09-18T00:00:00.000Z"); // after NOW

const subs = new DrizzleUserSubscriptionRepository(db);
const tiers = new DrizzleUserTierRepository(db);

function buildUseCase(now: Date = NOW) {
  return new IsMemberOf(subs, new FixedClock(now));
}

let seedCounter = 0;

/** Follows `drizzle-user-subscription.repository.test.ts`'s `createUser` shape exactly. */
async function createUser(handle: string) {
  seedCounter += 1;
  const [row] = await db
    .insert(appUsers)
    .values({
      handle: `${handle}${seedCounter}`,
      email: `${handle}${seedCounter}@example.com`,
      whatsappNumber: null,
      passwordHash: "irrelevant-hash",
      displayName: handle,
      bio: null,
    })
    .returning();
  return row!;
}

/** A subscriber with an ACTIVE subscription to owner, its period ending at `periodEnd`. */
async function seedActiveSubscription(subscriberId: string, ownerId: string, periodEnd: Date) {
  const tier = await tiers.create({
    ownerId,
    name: "Anggota",
    priceAmount: 50_000,
    billingCycle: "monthly",
  });
  const created = await subs.create({ subscriberId, tierId: tier.id, ownerId });
  await subs.activate(created.id, periodEnd);
  return created;
}

describe("IsMemberOf", () => {
  it("is true for an active subscription whose period has not ended", async () => {
    const alice = await createUser("alice"); // owner
    const bob = await createUser("bob"); // subscriber
    await seedActiveSubscription(bob.id, alice.id, FUTURE_PERIOD_END);

    const result = await buildUseCase().execute(bob.id, alice.id);

    expect(result).toBe(true);
  });

  /**
   * THE case this whole use-case exists to get right. §9 of the spec: 5a has no
   * renewal pass, so nothing ever moves a subscription out of `active` when its
   * period ends. A status-only check would read this row as a member forever.
   */
  it("is false for an active subscription whose current_period_end has passed", async () => {
    const alice = await createUser("alice");
    const bob = await createUser("bob");
    await seedActiveSubscription(bob.id, alice.id, PAST_PERIOD_END);

    const result = await buildUseCase().execute(bob.id, alice.id);

    expect(result).toBe(false);
  });

  it("is false for a pending subscription", async () => {
    const alice = await createUser("alice");
    const bob = await createUser("bob");
    const tier = await tiers.create({
      ownerId: alice.id,
      name: "Anggota",
      priceAmount: 50_000,
      billingCycle: "monthly",
    });
    // Created but never activated.
    await subs.create({ subscriberId: bob.id, tierId: tier.id, ownerId: alice.id });

    const result = await buildUseCase().execute(bob.id, alice.id);

    expect(result).toBe(false);
  });

  it("is false for a cancelled subscription, even with a future period end", async () => {
    const alice = await createUser("alice");
    const bob = await createUser("bob");
    const created = await seedActiveSubscription(bob.id, alice.id, FUTURE_PERIOD_END);
    await subs.cancel(created.id);

    const result = await buildUseCase().execute(bob.id, alice.id);

    expect(result).toBe(false);
  });

  it("is false for an unrelated pair — an active subscription to someone else", async () => {
    const alice = await createUser("alice");
    const bob = await createUser("bob");
    const carol = await createUser("carol");
    await seedActiveSubscription(bob.id, alice.id, FUTURE_PERIOD_END);

    const result = await buildUseCase().execute(bob.id, carol.id);

    expect(result).toBe(false);
  });

  it("is false when the viewer and owner are the same person", async () => {
    const alice = await createUser("alice");

    const result = await buildUseCase().execute(alice.id, alice.id);

    expect(result).toBe(false);
  });
});

/**
 * Task 2's partial unique index — `user_subscription_one_active` on
 * (subscriber_id, owner_id) WHERE status = 'active' — is what makes this a
 * single index hit rather than a join through the tier (see `ownerId`'s own
 * docstring in `db/schema.ts`). `IsMemberOf` reaches it through
 * `DrizzleUserSubscriptionRepository.findActiveFor`, which is `async` and
 * executes immediately, so there is no builder to call `.toSQL()` on from
 * outside it. This test therefore issues the IDENTICAL query
 * `findActiveFor` builds — same table, same three `eq()`s, same `limit(1)` —
 * so the `EXPLAIN` below is proof about the real query shape, not a
 * hand-wave. Follows the same two-layer discipline as
 * `drizzle-post.repository.test.ts`'s "the indexes post reads go through":
 * a REAL `EXPLAIN` on a REALISTICALLY sized table, `analyze`d, with
 * `enable_seqscan` left alone.
 */
describe("the query isMemberOf issues", () => {
  it("plans a select on (subscriber_id, owner_id, active) WITHOUT a sequential scan", async () => {
    // 200 users; the first 50 are owners, each with one tier. Every user
    // subscribes to every OTHER owner (skipping the self pair), giving
    // 200 * 50 - 50 = 9,950 rows — large enough that the planner's choice is
    // a real one, not a tiny-table freebie either way.
    await db.execute(sql`
      insert into app_user (handle, email, whatsapp_number, password_hash, display_name, bio)
      select 'bulkmember' || g, 'bulkmember' || g || '@example.com', null, 'x', 'Bulk Member ' || g, null
      from generate_series(1, 200) g
    `);
    await db.execute(sql`
      insert into user_tier (owner_id, name, price_amount, billing_cycle)
      select u.id, 'Anggota', 50000, 'monthly'
      from app_user u
      where u.handle like 'bulkmember%'
        and replace(u.handle, 'bulkmember', '')::int <= 50
    `);
    await db.execute(sql`
      insert into user_subscription (subscriber_id, tier_id, owner_id, status, current_period_end)
      select s.id, o.tier_id, o.id,
             case when (s.idx + o.idx) % 25 = 0 then 'active' else 'cancelled' end,
             case when (s.idx + o.idx) % 25 = 0 then timestamptz '2026-09-18 00:00:00+00' else null end
      from (
        select id, replace(handle, 'bulkmember', '')::int as idx
        from app_user where handle like 'bulkmember%'
      ) s
      join (
        select u.id, replace(u.handle, 'bulkmember', '')::int as idx, t.id as tier_id
        from app_user u
        join user_tier t on t.owner_id = u.id
        where u.handle like 'bulkmember%'
      ) o on o.id <> s.id
    `);
    await db.execute(sql`analyze user_subscription`);
    await db.execute(sql`analyze app_user`);
    await db.execute(sql`analyze user_tier`);

    const [subscriber] = await db.execute<{ id: string }>(
      sql`select id from app_user where handle = 'bulkmember50'`
    );
    const [owner] = await db.execute<{ id: string }>(
      sql`select id from app_user where handle = 'bulkmember1'`
    );

    // The EXACT query `DrizzleUserSubscriptionRepository.findActiveFor`
    // issues — see that method for the source this mirrors.
    const plan = await pgClient.unsafe<{ "QUERY PLAN": string }[]>(
      `explain select * from user_subscription
       where subscriber_id = $1 and owner_id = $2 and status = 'active'
       limit 1`,
      [subscriber!.id, owner!.id]
    );
    const planText = plan.map((row) => row["QUERY PLAN"]).join("\n");

    expect(planText).not.toContain("Seq Scan on user_subscription");
    expect(planText).toContain("user_subscription_one_active");
  });
});
