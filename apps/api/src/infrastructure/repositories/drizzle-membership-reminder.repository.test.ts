import { beforeEach, describe, expect, it } from "bun:test";
import { db, sql } from "../../db/client";
import { appUsers, membershipReminders } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { ArrivalLatch } from "../../test-support/arrival-latch";
import { DrizzleMembershipReminderRepository } from "./drizzle-membership-reminder.repository";
import { DrizzleUserSubscriptionRepository } from "./drizzle-user-subscription.repository";
import { DrizzleUserTierRepository } from "./drizzle-user-tier.repository";

beforeEach(resetDatabase);

const reminders = new DrizzleMembershipReminderRepository(db);
const subs = new DrizzleUserSubscriptionRepository(db);
const tiers = new DrizzleUserTierRepository(db);

let seedCounter = 0;

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

/** One membership to claim a reminder for. */
async function seedSubscription(): Promise<string> {
  const alice = await createUser("alice");
  const bob = await createUser("bob");
  const tier = await tiers.create({
    ownerId: alice.id,
    name: "Anggota",
    priceAmount: 50_000,
    billingCycle: "monthly",
  });
  const created = await subs.create({ subscriberId: bob.id, tierId: tier.id, ownerId: alice.id });
  return created.id;
}

describe("DrizzleMembershipReminderRepository.claim", () => {
  it("claims an unreminded membership", async () => {
    const subscriptionId = await seedSubscription();
    expect(await reminders.claim(subscriptionId)).toBe(true);
  });

  it("refuses a SECOND claim on the same membership, and absorbs the conflict", async () => {
    const subscriptionId = await seedSubscription();
    expect(await reminders.claim(subscriptionId)).toBe(true);
    // `false`, never a thrown 23505: a second pass has to be able to carry on with
    // the rest of its batch rather than abort and leave everybody behind it
    // unreminded.
    expect(await reminders.claim(subscriptionId)).toBe(false);
  });

  it("gives EXACTLY ONE of five simultaneous claimants the right to send", async () => {
    // The claim is the whole mechanism, and a sequential test cannot fail on it: the
    // reads are ordered, so a select-then-insert implementation passes every test
    // above. Five callers are forced to arrive at `claim` together, so the ONLY thing
    // that can arbitrate is the unique index in Postgres.
    //
    // WARMING THE POOL IS PART OF THE TEST, NOT SETUP NOISE — measured, and it is the
    // difference between this test proving something and proving nothing.
    // `ArrivalLatch` guarantees five callers are at the same LINE, and that is all it
    // can guarantee: postgres.js establishes connections lazily, so on a cold pool
    // four of the five callers' first statements simply QUEUE behind the one live
    // connection, the five requests serialise inside the driver, and every caller
    // reads the previous caller's committed row. Against a deliberately broken
    // select-then-insert `claim`, the cold version of this test passed — 1 winner, 4
    // losers, no error — while the warmed version below produced 1 winner and FOUR
    // THROWN unique violations. That is the whole point of the `Promise.all` here:
    // it rejects on any of them, so a `claim` that does not name the conflict target
    // fails this test rather than quietly reminding a member twice.
    //
    // FIVE is the measured number that holds, and it holds at 10, 25 and 50 too — the
    // count is part of the assertion (Task 1's lesson, where four contenders proved
    // far too few against a conditional UPDATE), and here it is the WARM-UP rather
    // than the count that the property depends on.
    const subscriptionId = await seedSubscription();
    const contenders = 5;
    await Promise.all(Array.from({ length: contenders }, () => sql`select 1`));
    const latch = new ArrivalLatch(contenders);

    const outcomes = await Promise.all(
      Array.from({ length: contenders }, async () => {
        await latch.arriveAndWait();
        return reminders.claim(subscriptionId);
      })
    );

    expect(latch.arrived).toBe(contenders);
    expect(outcomes.filter((won) => won).length).toBe(1);
    expect(outcomes.filter((won) => !won).length).toBe(4);
    // And exactly one row exists, so "one winner" is not merely one return value.
    expect(await reminders.findBySubscriptionId(subscriptionId)).not.toBe(null);
  });

  it("RE-CLAIMS a membership that was skipped for want of a channel", async () => {
    // Review fix round 1, I1. A `no_channel` row records a deployment with no email
    // provider, not a member who cannot be reached — `app_user.email` is
    // `NOT NULL UNIQUE`, so every member has an address. Under a plain
    // `DO NOTHING` this row was permanent, and a worker that ran for one hour without
    // email configuration burned the reminder for every in-window member without a
    // WhatsApp number, for ever.
    const subscriptionId = await seedSubscription();
    expect(await reminders.claim(subscriptionId)).toBe(true);
    await reminders.recordOutcome({
      userSubscriptionId: subscriptionId,
      outcome: "no_channel",
      channels: null,
    });

    expect(await reminders.claim(subscriptionId)).toBe(true);
    // Re-claimed IN PLACE — still one row per membership, back to an undelivered
    // claim, so a second skip cannot accumulate a second record either.
    const row = await reminders.findBySubscriptionId(subscriptionId);
    expect(row?.outcome).toBe("claimed");
    expect(row?.channels).toBe(null);
    expect(await db.select().from(membershipReminders)).toHaveLength(1);
  });

  it("NEVER re-claims a membership that was actually reminded", async () => {
    // The other half, and the one that must not be broken while fixing the first: a
    // member who WAS told is told once, for ever.
    const subscriptionId = await seedSubscription();
    await reminders.claim(subscriptionId);
    await reminders.recordOutcome({
      userSubscriptionId: subscriptionId,
      outcome: "sent",
      channels: "email",
    });

    expect(await reminders.claim(subscriptionId)).toBe(false);
    // And the refusal did not quietly rewrite the record of the send.
    const row = await reminders.findBySubscriptionId(subscriptionId);
    expect(row?.outcome).toBe("sent");
    expect(row?.channels).toBe("email");
  });

  it("NEVER re-claims a membership still sitting at 'claimed'", async () => {
    // `claimed` after a pass has finished means a process died between claiming and
    // delivering, or an audit write failed AFTER a successful send. Neither can be
    // told apart from the other, and one of them is a member who already has the
    // message — so the ambiguous case fails closed.
    const subscriptionId = await seedSubscription();
    expect(await reminders.claim(subscriptionId)).toBe(true);
    expect(await reminders.claim(subscriptionId)).toBe(false);
  });

  it("gives EXACTLY ONE of five simultaneous claimants a SKIPPED membership too", async () => {
    // Re-claiming must not open a second door into the double-send. Five passes race
    // for the same `no_channel` row, warmed pool and all (see the test above for why
    // the warm-up is load-bearing): Postgres evaluates the DO UPDATE's `WHERE` against
    // the locked current row, so the first to win flips it to `claimed` and the other
    // four find the predicate false.
    const subscriptionId = await seedSubscription();
    await reminders.claim(subscriptionId);
    await reminders.recordOutcome({
      userSubscriptionId: subscriptionId,
      outcome: "no_channel",
      channels: null,
    });
    const contenders = 5;
    await Promise.all(Array.from({ length: contenders }, () => sql`select 1`));
    const latch = new ArrivalLatch(contenders);

    const outcomes = await Promise.all(
      Array.from({ length: contenders }, async () => {
        await latch.arriveAndWait();
        return reminders.claim(subscriptionId);
      })
    );

    expect(latch.arrived).toBe(contenders);
    expect(outcomes.filter((won) => won).length).toBe(1);
    expect(await db.select().from(membershipReminders)).toHaveLength(1);
  });

  it("leaves two DIFFERENT memberships each claimable", async () => {
    const first = await seedSubscription();
    const second = await seedSubscription();
    expect(await reminders.claim(first)).toBe(true);
    expect(await reminders.claim(second)).toBe(true);
  });
});

describe("DrizzleMembershipReminderRepository.recordOutcome", () => {
  it("starts a fresh claim at 'claimed' with no channels, so a crash mid-send is legible", async () => {
    const subscriptionId = await seedSubscription();
    await reminders.claim(subscriptionId);
    const row = await reminders.findBySubscriptionId(subscriptionId);
    expect(row?.outcome).toBe("claimed");
    expect(row?.channels).toBe(null);
  });

  it("records what the pass actually reached", async () => {
    const subscriptionId = await seedSubscription();
    await reminders.claim(subscriptionId);
    expect(
      await reminders.recordOutcome({
        userSubscriptionId: subscriptionId,
        outcome: "sent",
        channels: "email,whatsapp",
      })
    ).toBe(true);
    const row = await reminders.findBySubscriptionId(subscriptionId);
    expect(row?.outcome).toBe("sent");
    expect(row?.channels).toBe("email,whatsapp");
  });

  it("records the DELIBERATE SKIP, so a pass that reached nobody does not look like one that reached everybody", async () => {
    const subscriptionId = await seedSubscription();
    await reminders.claim(subscriptionId);
    await reminders.recordOutcome({
      userSubscriptionId: subscriptionId,
      outcome: "no_channel",
      channels: null,
    });
    const row = await reminders.findBySubscriptionId(subscriptionId);
    expect(row?.outcome).toBe("no_channel");
    expect(row?.channels).toBe(null);
  });

  it("is false for a membership nobody has claimed", async () => {
    const subscriptionId = await seedSubscription();
    expect(
      await reminders.recordOutcome({
        userSubscriptionId: subscriptionId,
        outcome: "sent",
        channels: "email",
      })
    ).toBe(false);
  });
});

describe("DrizzleMembershipReminderRepository.release", () => {
  it("gives the claim back, so a later pass may take it again", async () => {
    const subscriptionId = await seedSubscription();
    await reminders.claim(subscriptionId);
    expect(await reminders.release(subscriptionId)).toBe(true);
    expect(await reminders.findBySubscriptionId(subscriptionId)).toBe(null);
    expect(await reminders.claim(subscriptionId)).toBe(true);
  });

  it("is false when there is no claim to give back", async () => {
    const subscriptionId = await seedSubscription();
    expect(await reminders.release(subscriptionId)).toBe(false);
  });
});
