import { S3Client } from "bun";
import type { DocumentStoragePort } from "../../application/ports/document-storage.port";

/**
 * Documents in an S3-compatible bucket — Biznet Gio NEO Object Storage, or any
 * other. A sibling of `S3MediaStorageAdapter`, sharing its configuration shape
 * and its network guard, under its own key prefix.
 *
 * **`documents/${id}` — the id alone, never the filename.** A key built from
 * user-supplied text is how a `../` in a name becomes a path traversal in a
 * bucket, and it is why `community_document.name` is display text only.
 *
 * Bytes are written AS UPLOADED. Unlike the media adapter there is no
 * transcoding step, so `put` is told nothing about the type and the delivery
 * route reads it off the row instead.
 */
export class S3DocumentStorageAdapter implements DocumentStoragePort {
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

  private key(id: string): string {
    return `documents/${id}`;
  }

  /**
   * Verbatim from `S3MediaStorageAdapter`, and for the reason its own
   * docstring gives at length: several bootstrap and route test blocks
   * configure `S3_*` with a placeholder endpoint purely to get past the
   * block-boot guard while testing some unrelated provider, and a route under
   * test calling through here would make a real, slow, DNS-dependent outbound
   * call from the suite.
   *
   * A METHOD guard, not a constructor guard, so the selection tests that
   * legitimately construct this class to assert `instanceof` keep working
   * without an opt-in flag.
   */
  private refuseUnderTest(method: "put" | "get" | "remove"): void {
    if (process.env.DIUDARA_BUN_TEST_RUN) {
      throw new Error(
        `S3DocumentStorageAdapter.${method}() was called while running under \`bun test\`. This ` +
          "would make a REAL outbound network call to a bucket, which this codebase forbids " +
          "absolutely (hard constraint: no network calls in tests, ever). If a route or " +
          "use-case under test needs document storage, its Dependencies must carry a " +
          "FakeDocumentStorageAdapter, not one built by bootstrap()'s real selection."
      );
    }
  }

  async put(id: string, bytes: Uint8Array): Promise<void> {
    this.refuseUnderTest("put");
    await this.client.write(this.key(id), bytes);
  }

  async get(id: string): Promise<Uint8Array | null> {
    this.refuseUnderTest("get");
    const file = this.client.file(this.key(id));
    if (!(await file.exists())) return null;
    return new Uint8Array(await file.arrayBuffer());
  }

  /**
   * ONE object, so no `allSettled` fan-out — but the same rule the media
   * adapter's `remove` records applies: no blanket `.catch(() => {})`. S3
   * DELETE is idempotent by protocol, so an absent key already answers
   * success; swallowing here would hide expired credentials, a 403 or a
   * partition, and leave bytes in the bucket forever with nothing saying so.
   */
  async remove(id: string): Promise<void> {
    this.refuseUnderTest("remove");
    await this.client.file(this.key(id)).delete();
  }
}
