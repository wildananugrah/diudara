import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "../../db/client";
import { appUsers } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { UniqueRule, UniqueViolationError } from "../../application/errors";
import { ArrivalLatch } from "../../test-support/arrival-latch";
import { DrizzleUserRepository } from "./drizzle-user.repository";
import { DrizzleFollowRepository } from "./drizzle-follow.repository";

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

  // This is the method Task 3 puts behind an UNAUTHENTICATED public-profile
  // endpoint, so a hash leaking into UserRecord here is reachable by anyone
  // who knows a handle — not merely a layering slip. TypeScript's structural
  // typing accepts an extra passwordHash property silently (a Drizzle row
  // returned as-is structurally satisfies UserRecord even with one), so only
  // a runtime key check catches a `.select(userColumns)` regressing to a
  // bare `.select()`.
  it("never exposes passwordHash", async () => {
    const created = await repo.create(seedInput({ handle: "nohashhandle" }));
    const found = await repo.findByHandle("nohashhandle");
    expect("passwordHash" in (found as object)).toBe(false);
    expect(found?.id).toBe(created.id);
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

  // Same rationale as findByHandle above — same silent-structural-typing hole.
  it("never exposes passwordHash", async () => {
    const created = await repo.create(seedInput());
    const found = await repo.findById(created.id);
    expect("passwordHash" in (found as object)).toBe(false);
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

  // Same rationale as findByHandle/findById above — same silent-structural-typing hole,
  // this time on `.returning(userColumns)` regressing to a bare `.returning()`.
  it("never exposes passwordHash", async () => {
    const created = await repo.create(seedInput());
    const updated = await repo.updateProfile(created.id, { bio: "Halo" });
    expect("passwordHash" in (updated as object)).toBe(false);
  });

  /**
   * Whole-branch review item 1: `whatsappNumber` had no update path at all —
   * signup could set it once, and nothing could ever change or add it after.
   * The same round-trip/clear/independence trio the bio tests above already
   * cover, against the real database.
   */
  it("sets a previously-null whatsappNumber", async () => {
    const created = await repo.create(seedInput());
    expect(created.whatsappNumber).toBeNull();

    const updated = await repo.updateProfile(created.id, { whatsappNumber: "+6281234567890" });

    expect(updated?.whatsappNumber).toBe("+6281234567890");
  });

  it("clears a whatsappNumber to null", async () => {
    const created = await repo.create(seedInput());
    await repo.updateProfile(created.id, { whatsappNumber: "+6281234567890" });

    const cleared = await repo.updateProfile(created.id, { whatsappNumber: null });

    expect(cleared?.whatsappNumber).toBeNull();
  });

  it("updates whatsappNumber independently of bio and displayName", async () => {
    const created = await repo.create(seedInput());

    const updated = await repo.updateProfile(created.id, { whatsappNumber: "+6281234567890" });

    expect(updated?.whatsappNumber).toBe("+6281234567890");
    expect(updated?.bio).toBeNull();
    expect(updated?.displayName).toBe(created.displayName);
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

/** Asserts the returned row carries ONLY the three `FollowListRow` fields — same discipline `drizzle-follow.repository.test.ts` uses, and the same one Task 2's review found a mutated `select()` slip past `tsc --noEmit` on. */
function expectPublicRowShape(row: unknown): void {
  expect(Object.keys(row as object).sort()).toEqual(["bio", "displayName", "handle"]);
  expect("id" in (row as object)).toBe(false);
  expect("email" in (row as object)).toBe(false);
}

describe("DrizzleUserRepository.searchPublic", () => {
  it("matches a handle prefix, case-insensitively", async () => {
    await repo.create(seedInput({ handle: "wildana", displayName: "Someone Else" }));
    const target = await repo.create(seedInput({ handle: "wildanto", displayName: "Wildanto" }));
    await repo.create(seedInput({ handle: "budi", displayName: "Budi" }));

    const rows = await repo.searchPublic("WILDANT", 10);

    expect(rows.map((r) => r.handle)).toEqual([target.handle]);
  });

  it("matches a display-name prefix, case-insensitively", async () => {
    const target = await repo.create(seedInput({ handle: "userx", displayName: "Rina Wijaya" }));
    await repo.create(seedInput({ handle: "usery", displayName: "Somebody Else" }));

    const rows = await repo.searchPublic("rina wij", 10);

    expect(rows.map((r) => r.handle)).toEqual([target.handle]);
  });

  it("returns only handle, displayName and bio — never id or email", async () => {
    await repo.create(seedInput({ handle: "keycheck", displayName: "Key Check" }));

    const rows = await repo.searchPublic("keycheck", 10);

    expect(rows).toHaveLength(1);
    expectPublicRowShape(rows[0]);
  });

  it("respects the limit", async () => {
    await Promise.all(
      Array.from({ length: 5 }, (_unused, i) =>
        repo.create(seedInput({ handle: `caplimit${i}`, displayName: `Cap Limit ${i}` }))
      )
    );

    const rows = await repo.searchPublic("caplimit", 2);

    expect(rows).toHaveLength(2);
  });

  it("returns [] when nothing matches", async () => {
    expect(await repo.searchPublic("nosuchprefixatall", 10)).toEqual([]);
  });

  // Same clamp contract as FollowRepositoryPort.listFollowers — Task 1 found
  // Drizzle silently drops a negative LIMIT clause rather than erroring.
  it("clamps a non-positive limit to zero rows rather than passing it through", async () => {
    await repo.create(seedInput({ handle: "clamplimit", displayName: "Clamp Limit" }));

    expect(await repo.searchPublic("clamplimit", -1)).toEqual([]);
    expect(await repo.searchPublic("clamplimit", 0)).toEqual([]);
  });
});

/**
 * THE GUARANTEE THIS TEST HOLDS: search can never be used to test whether an
 * email address is registered. Phase 1 measured a 215ms timing side-channel
 * on signup/password-reset and closed it to 1.75ms specifically so neither
 * flow could answer that question; a search box that matched `email` would
 * undo all of that in one line, since handles/display names are already
 * public (`/@handle`) and email is not. Named after the guarantee, not the
 * mechanism ("does not search the email column"), so the next person to
 * "improve" search sees immediately why this exists.
 */
describe("the guarantee: search can never confirm whether an email address is registered", () => {
  it("returns zero rows for a registered user's exact email, and for its local part", async () => {
    await repo.create(
      seedInput({ handle: "secretive", displayName: "Secretive User", email: "rahasia@example.com" })
    );

    expect(await repo.searchPublic("rahasia@example.com", 10)).toEqual([]);
    expect(await repo.searchPublic("rahasia", 10)).toEqual([]);
  });
});

describe("DrizzleUserRepository.newestPublic", () => {
  it("orders by created_at descending", async () => {
    const first = await repo.create(seedInput({ handle: "newest1", displayName: "First" }));
    const second = await repo.create(seedInput({ handle: "newest2", displayName: "Second" }));

    const rows = await repo.newestPublic(10);
    const handles = rows.map((r) => r.handle);

    expect(handles.indexOf(second.handle)).toBeLessThan(handles.indexOf(first.handle));
  });

  it("returns only handle, displayName and bio — never id or email", async () => {
    await repo.create(seedInput({ handle: "newestkeys", displayName: "Newest Keys" }));

    const rows = await repo.newestPublic(10);

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expectPublicRowShape(row);
    }
  });

  it("respects the limit", async () => {
    await Promise.all(
      Array.from({ length: 5 }, (_unused, i) =>
        repo.create(seedInput({ handle: `newestcap${i}`, displayName: `Newest Cap ${i}` }))
      )
    );

    const rows = await repo.newestPublic(2);

    expect(rows).toHaveLength(2);
  });

  it("clamps a non-positive limit to zero rows rather than passing it through", async () => {
    await repo.create(seedInput({ handle: "newestclamp", displayName: "Newest Clamp" }));

    expect(await repo.newestPublic(-1)).toEqual([]);
    expect(await repo.newestPublic(0)).toEqual([]);
  });
});

describe("DrizzleUserRepository.mostFollowedPublic", () => {
  it("orders by follower count descending, and users with zero followers come last", async () => {
    const popular = await repo.create(seedInput({ handle: "popular", displayName: "Popular" }));
    const middling = await repo.create(seedInput({ handle: "middling", displayName: "Middling" }));
    const lonely = await repo.create(seedInput({ handle: "lonely", displayName: "Lonely" }));
    const followerA = await repo.create(seedInput({ handle: "followera", displayName: "Follower A" }));
    const followerB = await repo.create(seedInput({ handle: "followerb", displayName: "Follower B" }));

    // Follow edges seeded through the real follow repository — the same
    // `follow_followee_created_idx` `mostFollowedPublic` counts through.
    const followRepo = new DrizzleFollowRepository(db);
    await followRepo.follow(followerA.id, popular.id);
    await followRepo.follow(followerB.id, popular.id);
    await followRepo.follow(followerA.id, middling.id);
    // lonely, followerA and followerB all have zero followers of their own.

    const rows = await repo.mostFollowedPublic(10);
    const handles = rows.map((r) => r.handle);

    expect(handles.indexOf(popular.handle)).toBeLessThan(handles.indexOf(middling.handle));
    expect(handles.indexOf(middling.handle)).toBeLessThan(handles.indexOf(lonely.handle));
    expect(handles.indexOf(middling.handle)).toBeLessThan(handles.indexOf(followerA.handle));
  });

  it("returns only handle, displayName and bio — never id or email", async () => {
    await repo.create(seedInput({ handle: "mostfollowedkeys", displayName: "Most Followed Keys" }));

    const rows = await repo.mostFollowedPublic(10);

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expectPublicRowShape(row);
    }
  });

  it("respects the limit", async () => {
    await Promise.all(
      Array.from({ length: 5 }, (_unused, i) =>
        repo.create(seedInput({ handle: `mostfollowedcap${i}`, displayName: `Most Followed Cap ${i}` }))
      )
    );

    const rows = await repo.mostFollowedPublic(2);

    expect(rows).toHaveLength(2);
  });

  it("clamps a non-positive limit to zero rows rather than passing it through", async () => {
    await repo.create(seedInput({ handle: "mostfollowedclamp", displayName: "Most Followed Clamp" }));

    expect(await repo.mostFollowedPublic(-1)).toEqual([]);
    expect(await repo.mostFollowedPublic(0)).toEqual([]);
  });
});
