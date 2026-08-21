import { beforeEach, describe, expect, it } from "bun:test";
import { db } from "../../db/client";
import { appUsers } from "../../db/schema";
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
    const subscriptionId = await seedSubscription();
    const contenders = 5;
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
