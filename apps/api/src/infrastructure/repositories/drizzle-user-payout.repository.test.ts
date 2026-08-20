import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { appUsers } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { ArrivalLatch } from "../../test-support/arrival-latch";
import { DrizzleUserRepository } from "./drizzle-user.repository";
import { DrizzleUserPayoutRepository } from "./drizzle-user-payout.repository";

beforeEach(resetDatabase);

const users = new DrizzleUserRepository(db);
const repo = new DrizzleUserPayoutRepository(db);

/**
 * The sentinel as a LITERAL, on purpose. This is the one assertion in the suite
 * that pins what actually lands in the column, so comparing it against the
 * constant the implementation imports would compare the code with itself.
 */
const SENTINEL = "provisioning:in-progress";

let seedCounter = 0;

async function seedUser(overrides: { displayName?: string; email?: string } = {}) {
  seedCounter += 1;
  return users.create({
    handle: `payout${seedCounter}`,
    email: overrides.email ?? `payout${seedCounter}@example.com`,
    whatsappNumber: null,
    passwordHash: "$argon2id$fake",
    displayName: overrides.displayName ?? "Wildan",
  });
}

/** Reads the column straight from the table — never through the repository under test. */
async function columnOf(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ xenditAccountId: appUsers.xenditAccountId })
    .from(appUsers)
    .where(eq(appUsers.id, userId));
  return row?.xenditAccountId ?? null;
}

describe("DrizzleUserPayoutRepository.findPayoutAccount", () => {
  it("returns the identity the provider call needs, with an empty column for a fresh user", async () => {
    const created = await seedUser({ displayName: "Rina Kusuma", email: "rina@example.com" });

    expect(await repo.findPayoutAccount(created.id)).toEqual({
      id: created.id,
      email: "rina@example.com",
      displayName: "Rina Kusuma",
      xenditAccountId: null,
    });
  });

  it("returns null for a user that does not exist", async () => {
    expect(await repo.findPayoutAccount("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("never returns the password hash", async () => {
    const created = await seedUser();

    const found = await repo.findPayoutAccount(created.id);

    expect(JSON.stringify(found)).not.toContain("argon2id");
  });
});

describe("DrizzleUserPayoutRepository.beginXenditAccountProvisioning", () => {
  it("writes the sentinel and reports that it was this call that filled it", async () => {
    const created = await seedUser();

    expect(await repo.beginXenditAccountProvisioning(created.id)).toBe(true);
    expect(await columnOf(created.id)).toBe(SENTINEL);
  });

  it("refuses a column that already holds a sentinel", async () => {
    const created = await seedUser();
    await repo.beginXenditAccountProvisioning(created.id);

    expect(await repo.beginXenditAccountProvisioning(created.id)).toBe(false);
    expect(await columnOf(created.id)).toBe(SENTINEL);
  });

  it("refuses a column that already holds a real account id, and leaves it alone", async () => {
    const created = await seedUser();
    await repo.beginXenditAccountProvisioning(created.id);
    await repo.finishXenditAccountProvisioning(created.id, "xnd-acct-real");

    expect(await repo.beginXenditAccountProvisioning(created.id)).toBe(false);
    expect(await columnOf(created.id)).toBe("xnd-acct-real");
  });

  it("returns false for a user that does not exist", async () => {
    expect(
      await repo.beginXenditAccountProvisioning("00000000-0000-0000-0000-000000000000")
    ).toBe(false);
  });

  it("claims only the user it was asked about", async () => {
    const mine = await seedUser();
    const stranger = await seedUser();

    await repo.beginXenditAccountProvisioning(mine.id);

    expect(await columnOf(stranger.id)).toBeNull();
  });

  /**
   * THE ARBITRATION ITSELF, against a real database rather than an in-memory
   * fake: the conditional UPDATE — not any read before it — is what decides who
   * claims the row. The latch holds all four callers until every one of them has
   * arrived, so they genuinely contend (see `ArrivalLatch` for the three false
   * passes a bare `Promise.all` produced in this project).
   *
   * If more than one call could return true, the use-case above it would call the
   * provider more than once, and each losing call would leave a permanently
   * orphaned Xendit MANAGED sub-account: they are KYC entities with no delete
   * endpoint.
   */
  it("lets exactly ONE of several concurrent claims win", async () => {
    const created = await seedUser();
    const latch = new ArrivalLatch(4);

    const results = await Promise.all(
      Array.from({ length: 4 }, async () => {
        await latch.arriveAndWait();
        return repo.beginXenditAccountProvisioning(created.id);
      })
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(latch.arrived).toBe(4);
    expect(await columnOf(created.id)).toBe(SENTINEL);
  });
});

describe("DrizzleUserPayoutRepository.finishXenditAccountProvisioning", () => {
  it("replaces this caller's sentinel with the real id", async () => {
    const created = await seedUser();
    await repo.beginXenditAccountProvisioning(created.id);

    expect(await repo.finishXenditAccountProvisioning(created.id, "xnd-acct-1")).toBe(true);
    expect(await columnOf(created.id)).toBe("xnd-acct-1");
  });

  it("refuses an unclaimed column rather than filling it unconditionally", async () => {
    // An unconditional UPDATE here would let a caller that never held the claim
    // redirect this user's money to an account they never connected.
    const created = await seedUser();

    expect(await repo.finishXenditAccountProvisioning(created.id, "xnd-acct-1")).toBe(false);
    expect(await columnOf(created.id)).toBeNull();
  });

  it("refuses a column that already holds someone else's real id", async () => {
    const created = await seedUser();
    await repo.beginXenditAccountProvisioning(created.id);
    await repo.finishXenditAccountProvisioning(created.id, "xnd-acct-first");

    expect(await repo.finishXenditAccountProvisioning(created.id, "xnd-acct-second")).toBe(
      false
    );
    expect(await columnOf(created.id)).toBe("xnd-acct-first");
  });
});

describe("DrizzleUserPayoutRepository.abandonXenditAccountProvisioning", () => {
  it("releases this caller's sentinel back to NULL so a retry can claim it", async () => {
    const created = await seedUser();
    await repo.beginXenditAccountProvisioning(created.id);

    expect(await repo.abandonXenditAccountProvisioning(created.id)).toBe(true);
    expect(await columnOf(created.id)).toBeNull();
    expect(await repo.beginXenditAccountProvisioning(created.id)).toBe(true);
  });

  it("never clears a column that holds a REAL account id", async () => {
    // A release predicated on anything looser than the sentinel would disconnect
    // a user who is already taking money.
    const created = await seedUser();
    await repo.beginXenditAccountProvisioning(created.id);
    await repo.finishXenditAccountProvisioning(created.id, "xnd-acct-real");

    expect(await repo.abandonXenditAccountProvisioning(created.id)).toBe(false);
    expect(await columnOf(created.id)).toBe("xnd-acct-real");
  });
});
