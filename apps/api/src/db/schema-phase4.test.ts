import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "./client";
import { channels, channelMemberships, communities, creators, members, outbox } from "./schema";
import { resetDatabase } from "./test-helpers";

beforeEach(resetDatabase);

async function seed() {
  const [creator] = await db
    .insert(creators)
    .values({ name: "Budi", email: `b-${Date.now()}@example.com` })
    .returning();
  const [community] = await db
    .insert(communities)
    .values({ creatorId: creator.id, name: "Kelas", slug: `kelas-${Date.now()}` })
    .returning();
  const [channel] = await db
    .insert(channels)
    .values({ communityId: community.id, platform: "telegram", externalGroupId: "-100123" })
    .returning();
  const [member] = await db
    .insert(members)
    .values({ whatsappNumber: `+628${Date.now()}`.slice(0, 15), name: "Siti" })
    .returning();
  return { channel, member };
}

describe("phase 4 schema", () => {
  it("defaults an outbox row to pending with no attempts", async () => {
    const [row] = await db
      .insert(outbox)
      .values({ eventType: "grant_access", payload: { subscriptionId: "s1" } })
      .returning();
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.lastError).toBeNull();
  });

  it("rejects a second membership for the same member and channel", async () => {
    const { channel, member } = await seed();
    await db
      .insert(channelMemberships)
      .values({ memberId: member.id, channelId: channel.id });

    let failed = false;
    try {
      await db
        .insert(channelMemberships)
        .values({ memberId: member.id, channelId: channel.id });
    } catch {
      failed = true;
    }

    // This constraint IS the grant-idempotency mechanism. If it is not in the
    // database, a retried outbox row issues a second invite link.
    expect(failed).toBe(true);
    expect((await db.select().from(channelMemberships)).length).toBe(1);
  });

  it("defaults a membership to active", async () => {
    const { channel, member } = await seed();
    const [row] = await db
      .insert(channelMemberships)
      .values({ memberId: member.id, channelId: channel.id })
      .returning();
    expect(row.status).toBe("active");
    expect(row.revokedAt).toBeNull();
  });
});
