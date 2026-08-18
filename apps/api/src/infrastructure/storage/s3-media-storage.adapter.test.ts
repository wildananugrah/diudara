import { describe, expect, it } from "bun:test";
import { S3MediaStorageAdapter } from "./s3-media-storage.adapter";

/**
 * Task 2 review, fix round 2: I1 and I2 were both verified sound as
 * production code, but neither was pinned by a test — reverting either fix
 * left all 211 tests across the five covering files green. These two tests
 * exist so that regression is no longer possible silently.
 *
 * Neither test makes a network call. I1's needs to reach PAST
 * `refuseUnderTest` (I2's own guard, which fires first in every method) to
 * exercise `remove()`'s real delete logic, so it substitutes the private
 * `client` field on an already-constructed instance with a minimal double —
 * TypeScript `private` has no runtime enforcement, so this is reaching into
 * an object this test itself built, not a hack around real encapsulation.
 * `mock.module("bun", ...)` was considered and rejected: "bun" is a builtin
 * relied on throughout this codebase (password hashing, `Bun.file`, etc.),
 * and overriding its exports for the whole test PROCESS risks breaking
 * every other file for the rest of a full-suite run — a mistake much larger
 * than the one this fix is trying to prevent.
 */

const FULL_KEY = "posts/m1/full.webp";
const THUMB_KEY = "posts/m1/thumb.webp";

/** A minimal double for the one `S3Client` surface `remove()` touches. */
function fakeClient(outcomes: Record<string, Error | undefined>) {
  return {
    file(key: string) {
      return {
        async delete() {
          const failure = outcomes[key];
          if (failure) throw failure;
        },
      };
    },
  };
}

function adapterWithFakeClient(outcomes: Record<string, Error | undefined>): S3MediaStorageAdapter {
  const adapter = new S3MediaStorageAdapter({
    accessKeyId: "test",
    secretAccessKey: "test",
    bucket: "test",
    endpoint: "http://127.0.0.1:1",
    region: "test",
  });
  // Substituting the client so `remove()`'s OWN logic runs against a
  // double instead of Bun's real S3Client — see this file's own docstring.
  (adapter as unknown as { client: unknown }).client = fakeClient(outcomes);
  return adapter;
}

/**
 * `remove()` calls `refuseUnderTest("remove")` (I2) before touching
 * `this.client` at all, and `test-env-preload.ts` sets `DIUDARA_BUN_TEST_RUN`
 * unconditionally for the whole suite — so every test in this file must
 * unset it for exactly the duration of the `remove()` call under test, or
 * every assertion below would be exercising the I2 guard instead of I1's
 * delete logic.
 */
async function withoutI2Guard<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.env.DIUDARA_BUN_TEST_RUN;
  delete process.env.DIUDARA_BUN_TEST_RUN;
  try {
    return await fn();
  } finally {
    if (original !== undefined) process.env.DIUDARA_BUN_TEST_RUN = original;
  }
}

describe("S3MediaStorageAdapter.remove() (I1: a real delete failure must not be swallowed)", () => {
  it("throws when a variant's delete genuinely fails", async () => {
    const adapter = adapterWithFakeClient({
      [FULL_KEY]: undefined,
      [THUMB_KEY]: new Error("simulated: expired credentials"),
    });

    await expect(withoutI2Guard(() => adapter.remove("m1"))).rejects.toThrow(
      /failed to delete 1 of 2/
    );
  });

  it("still resolves — without throwing — when both variants delete cleanly, matching the port's idempotency promise", async () => {
    const adapter = adapterWithFakeClient({
      [FULL_KEY]: undefined,
      [THUMB_KEY]: undefined,
    });

    await expect(withoutI2Guard(() => adapter.remove("m1"))).resolves.toBeUndefined();
  });
});

describe("S3MediaStorageAdapter (I2: put/get/remove must refuse to run under a test process)", () => {
  it("throws before touching the network, for all three methods", async () => {
    // Sanity: the guard this test exists to pin is armed by
    // test-env-preload.ts for every test in this suite, unconditionally.
    expect(process.env.DIUDARA_BUN_TEST_RUN).toBeTruthy();

    // A REAL (unsubstituted) client, pointed at a loopback port nothing
    // listens on. If the guard is ever neutered, these calls fall through to
    // an actual connection attempt — instant and local, never a live host —
    // which fails for a DIFFERENT reason than the guard's own message, so
    // this test goes red rather than passing for the wrong reason.
    const adapter = new S3MediaStorageAdapter({
      accessKeyId: "test",
      secretAccessKey: "test",
      bucket: "test",
      endpoint: "http://127.0.0.1:1",
      region: "test",
    });

    await expect(adapter.put("m1", "full", new Uint8Array([1]))).rejects.toThrow(
      /called while running under `bun test`/
    );
    await expect(adapter.get("m1", "full")).rejects.toThrow(
      /called while running under `bun test`/
    );
    await expect(adapter.remove("m1")).rejects.toThrow(
      /called while running under `bun test`/
    );
  });
});
