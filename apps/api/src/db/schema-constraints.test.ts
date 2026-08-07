import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "./client";
import {
  creators,
  communities,
  membershipTiers,
  members,
  subscriptions,
  transactions,
  events,
} from "./schema";
import { resetDatabase } from "./test-helpers";

beforeEach(resetDatabase);

/**
 * Runs `fn` and returns whatever it threw, or null if it succeeded.
 *
 * Drizzle's query builder is a thenable rather than a real Promise, so
 * `expect(builder).rejects.toThrow()` does not drive it to completion and the
 * assertion passes vacuously. Awaiting inside a real async function does.
 */
async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
}

/**
 * Flattens an Error's `cause` chain into one string. Drizzle wraps driver
 * failures in a DrizzleQueryError whose own message is just the failed SQL; the
 * Postgres constraint name lives on the wrapped cause.
 */
function messageChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(" | ");
}

async function seedCommunity() {
  const [creator] = await db
    .insert(creators)
    .values({ name: "Rina", whatsappNumber: `+628${Date.now().toString().slice(-9)}` })
    .returning();
  const [community] = await db
    .insert(communities)
    .values({ creatorId: creator.id, name: "Kelas Rina" })
    .returning();
  return { creator, community };
}

describe("creator.email uniqueness (login identity)", () => {
  it("rejects a second creator with the same email", async () => {
    await db
      .insert(creators)
      .values({ name: "Andi", whatsappNumber: "+6281444444444", email: "duplicate@example.com" });

    const error = await captureError(() =>
      db
        .insert(creators)
        .values({ name: "Bayu", whatsappNumber: "+6281555555555", email: "duplicate@example.com" }),
    );

    expect(error).toBeInstanceOf(Error);
    expect(messageChain(error)).toMatch(/creator_email_unique|duplicate key/i);
    expect(await db.select().from(creators)).toHaveLength(1);
  });

  it("still allows many creators with no email (WhatsApp-only signup)", async () => {
    await db.insert(creators).values({ name: "Cici", whatsappNumber: "+6281666666666" });
    await db.insert(creators).values({ name: "Dodi", whatsappNumber: "+6281777777777" });

    const rows = await db.select().from(creators);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.email === null)).toBe(true);
  });

  it("makes findByEmail deterministic: one email resolves to exactly one row", async () => {
    const [only] = await db
      .insert(creators)
      .values({ name: "Eka", whatsappNumber: "+6281888888888", email: "eka@example.com" })
      .returning();

    const matches = await db.select().from(creators);
    expect(matches.filter((row) => row.email === "eka@example.com")).toEqual([only]);
  });
});

describe("event.stream_key uniqueness (spec 7 security token)", () => {
  it("rejects two events sharing a stream key", async () => {
    const { community } = await seedCommunity();

    await db
      .insert(events)
      .values({ communityId: community.id, title: "Sesi A", streamKey: "sk_shared_secret" });

    const error = await captureError(() =>
      db
        .insert(events)
        .values({ communityId: community.id, title: "Sesi B", streamKey: "sk_shared_secret" }),
    );

    expect(error).toBeInstanceOf(Error);
    expect(messageChain(error)).toMatch(/event_stream_key_unique|duplicate key/i);
    expect(await db.select().from(events)).toHaveLength(1);
  });

  it("still allows many events with no stream key yet (unscheduled sessions)", async () => {
    const { community } = await seedCommunity();

    await db.insert(events).values({ communityId: community.id, title: "Sesi C" });
    await db.insert(events).values({ communityId: community.id, title: "Sesi D" });

    const rows = await db.select().from(events);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.streamKey === null)).toBe(true);
  });
});

describe("subscription and transaction creation timestamps", () => {
  it("stamps created_at/updated_at even while paidAt and startedAt are still null", async () => {
    const { community } = await seedCommunity();
    const [tier] = await db
      .insert(membershipTiers)
      .values({
        communityId: community.id,
        name: "Basic",
        priceAmount: 50000,
        billingCycle: "monthly",
      })
      .returning();
    const [member] = await db
      .insert(members)
      .values({ whatsappNumber: "+6281999999999" })
      .returning();

    const [subscription] = await db
      .insert(subscriptions)
      .values({ memberId: member.id, tierId: tier.id })
      .returning();

    const [transaction] = await db
      .insert(transactions)
      .values({ subscriptionId: subscription.id, amount: 50000, paymentMethod: "qris" })
      .returning();

    // The pending/failed states that make paidAt and startedAt useless for
    // revenue-over-time (spec 2) and churn timing (spec 8.3).
    expect(subscription.status).toBe("pending");
    expect(subscription.startedAt).toBeNull();
    expect(transaction.status).toBe("pending");
    expect(transaction.paidAt).toBeNull();

    for (const stamp of [
      subscription.createdAt,
      subscription.updatedAt,
      transaction.createdAt,
      transaction.updatedAt,
    ]) {
      expect(stamp).toBeInstanceOf(Date);
      expect(Number.isNaN(stamp.getTime())).toBe(false);
    }
  });
});
