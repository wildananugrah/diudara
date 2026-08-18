import { S3Client } from "bun";
import type { MediaObject, MediaStoragePort } from "../../application/ports/media-storage.port";

/**
 * !!! UNVERIFIED AGAINST A LIVE BUCKET !!!
 *
 * Written against Bun's own `S3Client` documentation with no Biznet Gio NEO
 * credentials anywhere in this repository's history to test one against —
 * see the task-2 report for what "deliberately thin" bought instead: a class
 * short enough to read for correctness, three calls straight through to
 * `Bun.S3Client`/`S3File` with no logic of its own to get wrong. Exercise it
 * against a real bucket (Task 4's upload pipeline is the first real caller)
 * before trusting a creator's photo to it, then delete this warning.
 *
 * Biznet Gio NEO Object Storage, or any S3-compatible bucket. Bun ships the
 * client, so this adds no dependency.
 *
 * The key layout lives HERE and nowhere else. Nothing outside this file knows
 * that media is stored as `posts/<id>/full.webp` — the port takes an id and a
 * variant — which is what makes a bucket URL structurally unable to escape into
 * a response (spec §5.1).
 */
export class S3MediaStorageAdapter implements MediaStoragePort {
  private readonly client: S3Client;

  constructor(config: {
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    endpoint: string;
    region: string;
  }) {
    this.client = new S3Client(config);
  }

  private key(id: string, variant: "full" | "thumb"): string {
    return `posts/${id}/${variant}.webp`;
  }

  /**
   * Task 2 review, I2: several `bootstrap.test.ts`/`routes/*.test.ts` blocks
   * fully configure `S3_*` with a placeholder endpoint purely to get PAST
   * `selectMediaStorage`'s block-boot guard while testing some UNRELATED
   * provider's own path (payments/email/AI/streaming disabled) — none of
   * them mean to reach a real bucket, and today none of them call a method
   * on the adapter they incidentally construct. Task 4 adds media routes;
   * once one of those routes runs against an app built from one of those
   * blocks, calling through here would make a REAL, slow, DNS-dependent
   * outbound network call from the test suite — exactly what hard
   * constraint 1 (no network calls in tests, ever) rules out.
   *
   * This is a METHOD guard, not a constructor guard, on purpose: the
   * bootstrap-selection tests that legitimately construct a real
   * `S3MediaStorageAdapter` to prove `selectMediaStorage` picks this class
   * (`bootstrap.test.ts`'s own `selectMediaStorage`/"media storage
   * selection" blocks) only ever check `instanceof` — they never call a
   * method — so gating construction itself would have forced an opt-in flag
   * onto tests that have no reason to know this guard exists. Gating the
   * three I/O methods instead makes the ACTUAL hazard (a socket opening)
   * structurally impossible everywhere, with zero changes required to any
   * existing test file: the call throws synchronously, before `S3Client` is
   * ever asked to do anything, so there is no DNS lookup, no timeout, and no
   * flakiness to blame on the network — only an immediate, actionable error
   * pointing whoever added the new route test at exactly what happened.
   *
   * `DIUDARA_BUN_TEST_RUN` is set unconditionally, once, by
   * `test-env-preload.ts` — the one place that runs before every test file
   * in this workspace — and no test ever touches that name, so it survives
   * even the blocks above that override `NODE_ENV` to simulate production.
   */
  private refuseUnderTest(method: "put" | "get" | "remove"): void {
    if (process.env.DIUDARA_BUN_TEST_RUN) {
      throw new Error(
        `S3MediaStorageAdapter.${method}() was called while running under \`bun test\`. This ` +
          "would make a REAL outbound network call to a bucket, which this codebase forbids " +
          "absolutely (hard constraint: no network calls in tests, ever). If a route or " +
          "use-case under test needs media storage, its Dependencies must carry a " +
          "FakeMediaStorageAdapter, not one built by bootstrap()'s real selection — see " +
          "test-env-preload.ts's own docstring on DIUDARA_BUN_TEST_RUN for the tests this " +
          "guard exists to protect."
      );
    }
  }

  async put(id: string, variant: "full" | "thumb", bytes: Uint8Array): Promise<void> {
    this.refuseUnderTest("put");
    await this.client.write(this.key(id, variant), bytes, { type: "image/webp" });
  }

  async get(id: string, variant: "full" | "thumb"): Promise<MediaObject | null> {
    this.refuseUnderTest("get");
    const file = this.client.file(this.key(id, variant));
    if (!(await file.exists())) return null;
    return { bytes: new Uint8Array(await file.arrayBuffer()), contentType: "image/webp" };
  }

  async remove(id: string): Promise<void> {
    this.refuseUnderTest("remove");
    // Both variants. S3 DELETE is idempotent BY PROTOCOL — AWS's S3 (and
    // every S3-compatible store, Biznet Gio NEO included) answers success for
    // a DELETE against a key that never existed, so there is no "object
    // already gone" case to swallow here; the port's own idempotency promise
    // (see its docstring) falls out of that protocol behaviour for free.
    //
    // A blanket `.catch(() => {})` used to sit here instead. It was never
    // protecting the absent-object case above — it was hiding every OTHER
    // failure identically: expired credentials, a 403, a network partition.
    // Bytes left behind by a failed delete stayed in the bucket forever with
    // nothing anywhere saying so (Task 2 review, I1). `allSettled` so one
    // variant failing never stops the other from being attempted; a real
    // failure is now thrown as an `AggregateError`, not swallowed.
    const results = await Promise.allSettled([
      this.client.file(this.key(id, "full")).delete(),
      this.client.file(this.key(id, "thumb")).delete(),
    ]);
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        `S3MediaStorageAdapter.remove(${id}) failed to delete ${failures.length} of 2 variant(s)`
      );
    }
  }
}
