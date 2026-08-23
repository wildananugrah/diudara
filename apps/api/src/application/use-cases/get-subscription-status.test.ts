import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "../../db/client";
import { communities, creators, events, members, membershipTiers, subscriptions } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleSubscriptionRepository } from "../../infrastructure/repositories/drizzle-subscription.repository";
import { NotFoundError } from "../errors";
import { GetSubscriptionStatus } from "./get-subscription-status";

beforeEach(resetDatabase);

const NOW = Date.parse("2026-08-11T10:00:00.000Z");

const subscriptionRepository = new DrizzleSubscriptionRepository(db);

let seedCounter = 0;

async function seedCommunity(name = "Rina") {
  seedCounter += 1;
  const [creator] = await db.insert(creators).values({ name }).returning();
  const [community] = await db
    .insert(communities)
    .values({
      creatorId: creator.id,
      name: `Kelas ${name}`,
      slug: `kelas-${name.toLowerCase()}-${seedCounter}`,
    })
    .returning();
  return community;
}

async function seedEvent(communityId: string, status: string) {
  seedCounter += 1;
  const streamKey = `key-${seedCounter}`;
  const [event] = await db
    .insert(events)
    .values({
      communityId,
      title: "Live Q&A",
      streamKey,
      status,
      hlsPlaybackPath: `https://fake-mediamtx.local/live/${streamKey}/index.m3u8`,
    })
    .returning();
  return event!;
}

async function seedSubscription(communityId: string, status: string) {
  seedCounter += 1;
  const [tier] = await db
    .insert(membershipTiers)
    .values({ communityId, name: "Basic", priceAmount: 50000, billingCycle: "monthly" })
    .returning();
  const [member] = await db
    .insert(members)
    .values({ whatsappNumber: `+62813${String(seedCounter).padStart(6, "0")}`, name: "Siti" })
    .returning();
  const [subscription] = await db
    .insert(subscriptions)
    .values({ memberId: member!.id, tierId: tier!.id, status })
    .returning();
  return subscription!;
}

describe("GetSubscriptionStatus — the base contract", () => {
  it("returns just the status", async () => {
    const community = await seedCommunity();
    const subscription = await seedSubscription(community.id, "active");

    const result = await new GetSubscriptionStatus(subscriptionRepository).execute(
      subscription.id,
      NOW
    );

    expect(result).toEqual({ status: "active" });
  });

  it("throws NotFoundError for an unknown subscription id", async () => {
    await expect(
      new GetSubscriptionStatus(subscriptionRepository).execute(
        "00000000-0000-4000-8000-000000000000",
        NOW
      )
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError rather than 500ing for a value that cannot be a uuid", async () => {
    await expect(
      new GetSubscriptionStatus(subscriptionRepository).execute("not-a-uuid", NOW)
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

/**
 * Retire-telegram Task 3 removed `watchUrl` from this endpoint entirely — the
 * screen that rendered it went in Task 1 and the route that redeemed it
 * (`GET /c/watch/:token`) went in Task 3, so it had become a signed credential
 * minted on a public endpoint that nothing could spend. See the class's own
 * docstring.
 *
 * SEVEN TESTS WENT WITH IT, and they were the seven cases that decided WHEN the
 * field appeared (live/scheduled/ended event, active/pending/cancelled
 * subscription, another community's event). None of those questions exists any
 * more. What replaces them is the single stronger claim below: there is no
 * condition under which this endpoint returns anything but `status`.
 *
 * THE SEEDING IS THE POINT. This reproduces the exact state the deleted
 * "mints a watchUrl" test used — an `active` subscription whose community has a
 * `live` event, the one combination that used to produce a token — so a
 * reinstated `watchUrl` branch reddens here rather than passing unnoticed. A test
 * that seeded nothing would pass against a class that still minted links.
 */
describe("GetSubscriptionStatus — there is no watchUrl any more", () => {
  it("returns status ALONE for an active subscription whose community is live", async () => {
    const community = await seedCommunity();
    await seedEvent(community.id, "live");
    const subscription = await seedSubscription(community.id, "active");

    const result = await new GetSubscriptionStatus(subscriptionRepository).execute(
      subscription.id,
      NOW
    );

    // `toEqual` on the WHOLE object, not a `watchUrl === undefined` check: this
    // must fail if the body ever grows any field at all, not only that one.
    expect(result).toEqual({ status: "active" });
    expect(Object.keys(result)).toEqual(["status"]);
  });
});
