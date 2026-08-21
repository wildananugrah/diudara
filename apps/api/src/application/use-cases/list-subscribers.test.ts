import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "../../db/client";
import { appUsers } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { FixedClock } from "../../infrastructure/clock/fixed.clock";
import { DrizzleUserTierRepository } from "../../infrastructure/repositories/drizzle-user-tier.repository";
import { DrizzleUserSubscriptionRepository } from "../../infrastructure/repositories/drizzle-user-subscription.repository";
import { ListSubscribers } from "./list-subscribers";

beforeEach(resetDatabase);

/** Placed deliberately in the middle of a subscription's real period, never on a boundary. */
const NOW = new Date("2026-08-21T12:00:00.000Z");
const FUTURE_PERIOD_END = new Date("2026-09-21T00:00:00.000Z"); // after NOW
const PAST_PERIOD_END = new Date("2026-08-01T00:00:00.000Z"); // before NOW

const subs = new DrizzleUserSubscriptionRepository(db);
const tiers = new DrizzleUserTierRepository(db);

function buildUseCase(now: Date = NOW) {
  return new ListSubscribers(subs, new FixedClock(now));
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
      whatsappNumber: `+62811${String(seedCounter).padStart(7, "0")}`,
      passwordHash: "irrelevant-hash",
      displayName: handle,
      bio: null,
    })
    .returning();
  return row!;
}

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

describe("ListSubscribers", () => {
  it("returns a currently active subscriber with the CLOSED wire projection: handle, displayName, since — nothing else", async () => {
    const alice = await createUser("alice"); // owner
    const bob = await createUser("bob"); // subscriber
    await seedActiveSubscription(bob.id, alice.id, FUTURE_PERIOD_END);

    const result = await buildUseCase().execute(alice.id);

    expect(result.subscribers.length).toBe(1);
    // Object.keys, not a spot-check — see the port's own `SubscriberRow`
    // docstring for why a spot-check is the exact failure mode this guards.
    expect(Object.keys(result.subscribers[0]!).sort()).toEqual([
      "displayName",
      "handle",
      "since",
    ]);
    expect(result.subscribers[0]).toEqual({
      handle: bob.handle,
      displayName: bob.displayName,
      since: expect.any(String),
    });
    // ISO on the wire, never a raw Date — JSON has no date type.
    expect(new Date(result.subscribers[0]!.since).toISOString()).toBe(
      result.subscribers[0]!.since
    );
  });

  /**
   * THE case this whole use-case exists to get right, mirroring
   * `is-member-of.test.ts`'s own "THE case" test for `IsMemberOf`. §9's
   * honest limitation: nothing in 5a's own flow retires a lapsed row by
   * itself outside the sweep, so a status-only filter would list this
   * person forever.
   */
  it("excludes a subscriber whose current_period_end has already passed — a past subscriber, not a current one", async () => {
    const alice = await createUser("alice");
    const bob = await createUser("bob");
    await seedActiveSubscription(bob.id, alice.id, PAST_PERIOD_END);

    const result = await buildUseCase().execute(alice.id);

    expect(result.subscribers).toEqual([]);
  });

  it("excludes a pending subscription — never activated", async () => {
    const alice = await createUser("alice");
    const bob = await createUser("bob");
    const tier = await tiers.create({
      ownerId: alice.id,
      name: "Anggota",
      priceAmount: 50_000,
      billingCycle: "monthly",
    });
    await subs.create({ subscriberId: bob.id, tierId: tier.id, ownerId: alice.id });

    const result = await buildUseCase().execute(alice.id);

    expect(result.subscribers).toEqual([]);
  });

  it("returns an empty list, not an error, for an owner with no subscribers at all", async () => {
    const alice = await createUser("alice");

    const result = await buildUseCase().execute(alice.id);

    expect(result.subscribers).toEqual([]);
  });

  it("OWNER-ONLY: never returns another owner's subscribers when asked for THIS owner's id", async () => {
    const alice = await createUser("alice");
    const rina = await createUser("rina");
    const bob = await createUser("bob");
    // bob subscribes to rina, not alice.
    await seedActiveSubscription(bob.id, rina.id, FUTURE_PERIOD_END);

    const aliceResult = await buildUseCase().execute(alice.id);
    const rinaResult = await buildUseCase().execute(rina.id);

    expect(aliceResult.subscribers).toEqual([]);
    expect(rinaResult.subscribers.map((s) => s.handle)).toEqual([bob.handle]);
  });
});
