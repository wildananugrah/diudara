import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "../../db/client";
import { appUsers } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { UniqueRule, UniqueViolationError } from "../../application/errors";
import { ArrivalLatch } from "../../test-support/arrival-latch";
import { DrizzleUserRepository } from "./drizzle-user.repository";

beforeEach(resetDatabase);

const repo = new DrizzleUserRepository(db);

let seedCounter = 0;

/** A minimal valid signup input, with a fresh handle/email each call. */
function seedInput(overrides: Partial<Parameters<DrizzleUserRepository["create"]>[0]> = {}) {
  seedCounter += 1;
  return {
    handle: `wildan${seedCounter}`,
    email: `wildan${seedCounter}@example.com`,
    whatsappNumber: null,
    passwordHash: "$argon2id$fake",
    displayName: "Wildan",
    ...overrides,
  };
}

describe("DrizzleUserRepository.create", () => {
  it("creates a user and returns a record without passwordHash", async () => {
    const input = seedInput();

    const created = await repo.create(input);

    expect(created.handle).toBe(input.handle);
    expect(created.email).toBe(input.email);
    expect(created.displayName).toBe(input.displayName);
    expect(created.whatsappNumber).toBeNull();
    expect(created.bio).toBeNull();
    expect(created.sessionEpoch).toBe(0);
    expect(created.id).toBeTruthy();
    expect(created.createdAt).toBeInstanceOf(Date);
    expect("passwordHash" in created).toBe(false);
  });

  it("rejects a second create with the same handle, naming the handle", async () => {
    const first = seedInput();
    await repo.create(first);

    const second = seedInput({ handle: first.handle });

    await expect(repo.create(second)).rejects.toThrow(UniqueViolationError);
    try {
      await repo.create(second);
      throw new Error("expected create to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(UniqueViolationError);
      expect((err as UniqueViolationError).rule).toBe(UniqueRule.userHandle);
    }
  });

  it("rejects a second create with the same email, naming the email", async () => {
    const first = seedInput();
    await repo.create(first);

    const second = seedInput({ email: first.email });

    try {
      await repo.create(second);
      throw new Error("expected create to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(UniqueViolationError);
      expect((err as UniqueViolationError).rule).toBe(UniqueRule.userEmail);
    }
  });

  it("never leaks the raw driver error (which carries the bound password hash) on a unique violation", async () => {
    const first = seedInput();
    await repo.create(first);
    const second = seedInput({ handle: first.handle, passwordHash: "$argon2id$SECRET_HASH" });

    let caught: unknown;
    try {
      await repo.create(second);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(UniqueViolationError);
    expect(JSON.stringify(caught)).not.toContain("SECRET_HASH");
    expect(String((caught as Error).message)).not.toContain("SECRET_HASH");
  });

  it("lets exactly ONE of several concurrent creates for the same handle win", async () => {
    const handle = "racehandle";
    const latch = new ArrivalLatch(4);

    const outcomes = await Promise.allSettled(
      Array.from({ length: 4 }, async (_unused, index) => {
        await latch.arriveAndWait();
        return repo.create(
          seedInput({ handle, email: `race${index}-${seedCounter}@example.com` })
        );
      })
    );

    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(3);
    for (const outcome of rejected) {
      const reason = (outcome as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(UniqueViolationError);
      expect((reason as UniqueViolationError).rule).toBe(UniqueRule.userHandle);
    }

    // The unique index arbitrated, not a prior read: exactly one row exists.
    const rows = await db.select().from(appUsers);
    expect(rows.filter((row) => row.handle === handle)).toHaveLength(1);
  });
});

describe("DrizzleUserRepository.findByHandle", () => {
  it("is exact-match on the normalised value", async () => {
    const input = seedInput({ handle: "exacthandle" });
    const created = await repo.create(input);

    expect((await repo.findByHandle("exacthandle"))?.id).toBe(created.id);
    expect(await repo.findByHandle("Exacthandle")).toBeNull();
    expect(await repo.findByHandle("exacthandl")).toBeNull();
  });

  it("returns null when no user has that handle", async () => {
    expect(await repo.findByHandle("nosuchhandle")).toBeNull();
  });
});

describe("DrizzleUserRepository.findById", () => {
  it("returns the record for a known id", async () => {
    const created = await repo.create(seedInput());
    expect((await repo.findById(created.id))?.handle).toBe(created.handle);
  });

  it("returns null for an unknown id", async () => {
    expect(await repo.findById("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});

describe("DrizzleUserRepository.findByEmail / findCredentialsByEmail", () => {
  it("findCredentialsByEmail returns the hash; findByEmail never does", async () => {
    const input = seedInput({ passwordHash: "$argon2id$realhash" });
    const created = await repo.create(input);

    const byEmail = await repo.findByEmail(input.email);
    const credentials = await repo.findCredentialsByEmail(input.email);

    expect(byEmail?.id).toBe(created.id);
    expect("passwordHash" in (byEmail as object)).toBe(false);

    expect(credentials?.id).toBe(created.id);
    expect(credentials?.passwordHash).toBe("$argon2id$realhash");
    expect(credentials?.sessionEpoch).toBe(0);
  });

  it("both return null for an unknown email", async () => {
    expect(await repo.findByEmail("nobody@example.com")).toBeNull();
    expect(await repo.findCredentialsByEmail("nobody@example.com")).toBeNull();
  });
});

describe("DrizzleUserRepository.updateProfile", () => {
  it("sets a bio", async () => {
    const created = await repo.create(seedInput());

    const updated = await repo.updateProfile(created.id, { bio: "Halo dunia" });

    expect(updated?.bio).toBe("Halo dunia");
  });

  it("clears a bio to null", async () => {
    const created = await repo.create(seedInput());
    await repo.updateProfile(created.id, { bio: "Halo dunia" });

    const cleared = await repo.updateProfile(created.id, { bio: null });

    expect(cleared?.bio).toBeNull();
  });

  it("updates displayName independently of bio", async () => {
    const created = await repo.create(seedInput());

    const updated = await repo.updateProfile(created.id, { displayName: "Wildan Baru" });

    expect(updated?.displayName).toBe("Wildan Baru");
    expect(updated?.bio).toBeNull();
  });

  it("returns null for an unknown id", async () => {
    expect(
      await repo.updateProfile("00000000-0000-0000-0000-000000000000", { bio: "x" })
    ).toBeNull();
  });
});

describe("DrizzleUserRepository.setPasswordAndBumpEpoch", () => {
  it("increments session_epoch by exactly one", async () => {
    const created = await repo.create(seedInput());
    expect(created.sessionEpoch).toBe(0);

    const first = await repo.setPasswordAndBumpEpoch(created.id, "$argon2id$new1");
    const afterFirst = await repo.findById(created.id);

    expect(first).toBe(true);
    expect(afterFirst?.sessionEpoch).toBe(1);

    const second = await repo.setPasswordAndBumpEpoch(created.id, "$argon2id$new2");
    const afterSecond = await repo.findById(created.id);

    expect(second).toBe(true);
    expect(afterSecond?.sessionEpoch).toBe(2);

    const credentials = await repo.findCredentialsByEmail(
      (await repo.findById(created.id))!.email
    );
    expect(credentials?.passwordHash).toBe("$argon2id$new2");
    expect(credentials?.sessionEpoch).toBe(2);
  });

  it("returns false for an unknown id", async () => {
    expect(
      await repo.setPasswordAndBumpEpoch("00000000-0000-0000-0000-000000000000", "$argon2id$x")
    ).toBe(false);
  });
});
