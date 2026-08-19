import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { appUsers, postMedia } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleMediaRepository } from "../../infrastructure/repositories/drizzle-media.repository";
import { FakeMediaStorageAdapter } from "../../infrastructure/storage/fake-media-storage.adapter";
import type { MediaObject, MediaStoragePort } from "../ports/media-storage.port";
import { UnsupportedImageError } from "../../domain/image";
import { ValidationError } from "../errors";
import { UploadMedia } from "./upload-media";

beforeEach(resetDatabase);

/** Follows `drizzle-media.repository.test.ts`'s `createUser` shape exactly. */
async function createUser(handle: string) {
  const [row] = await db
    .insert(appUsers)
    .values({
      handle,
      email: `${handle}@example.com`,
      whatsappNumber: null,
      passwordHash: "irrelevant-hash",
      displayName: handle,
      bio: null,
    })
    .returning();
  return row!;
}

const fixture = (name: string) =>
  Bun.file(`${import.meta.dir}/../../test-support/fixtures/${name}`).bytes();

/**
 * Every `put` rejects — used to pin the write ORDER in `UploadMedia`, not to
 * simulate a real outage. Never reaches the network: it is a hand-written
 * `MediaStoragePort`, not `S3MediaStorageAdapter`.
 */
class FailingStorage implements MediaStoragePort {
  async put(): Promise<void> {
    throw new Error("simulated storage failure");
  }
  async get(): Promise<MediaObject | null> {
    return null;
  }
  async remove(): Promise<void> {}
}

describe("UploadMedia", () => {
  it("stores both variants and returns the new row's id and dimensions", async () => {
    const owner = await createUser("wildan");
    const storage = new FakeMediaStorageAdapter();
    const media = new DrizzleMediaRepository(db);
    const useCase = new UploadMedia(media, storage);

    const result = await useCase.execute({ ownerId: owner.id, bytes: await fixture("small.png") });

    expect(typeof result.id).toBe("string");
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    expect(await storage.get(result.id, "full")).not.toBe(null);
    expect(await storage.get(result.id, "thumb")).not.toBe(null);
    expect(await media.findById(result.id)).not.toBe(null);
  });

  it("refuses a file over 10 MB without decoding it, and nothing reaches the bucket", async () => {
    const owner = await createUser("wildan");
    const storage = new FakeMediaStorageAdapter();
    const media = new DrizzleMediaRepository(db);
    const useCase = new UploadMedia(media, storage);
    // The LITERAL 10 MB + 1, not `MAX_UPLOAD_BYTES + 1` — a test built from the
    // constant it is checking moves with it and can never redden.
    const oversized = new Uint8Array(10 * 1024 * 1024 + 1);

    const err = await useCase
      .execute({ ownerId: owner.id, bytes: oversized })
      .then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(ValidationError);
    // The wire label the client branches on, as a literal — see
    // `UPLOAD_ERROR_CODE` for why this is a contract rather than a detail.
    expect((err as ValidationError).code).toBe("media_too_large");
    expect(storage.size).toBe(0);
  });

  it("lets an UnsupportedImageError from the decoding pipeline reach the caller", async () => {
    const owner = await createUser("wildan");
    const storage = new FakeMediaStorageAdapter();
    const media = new DrizzleMediaRepository(db);
    const useCase = new UploadMedia(media, storage);

    await expect(
      useCase.execute({ ownerId: owner.id, bytes: await fixture("not-an-image.txt") })
    ).rejects.toBeInstanceOf(UnsupportedImageError);
    // Nothing reached the bucket, and no row was inserted for a failed decode.
    expect(storage.size).toBe(0);
  });

  /**
   * PINS the bytes-before-row order the brief calls load-bearing. If a future
   * refactor swapped `storage.put` and `media.create`, the row would already
   * exist by the time `put` rejects here, and this test would catch it: the
   * row would survive a failed upload, leaving a media id that 404s forever
   * for a real user. Storage-first means the same failure instead leaves, at
   * worst, no trace at all — no row, nothing to 404 on.
   *
   * Verified by deliberately swapping the two calls in `upload-media.ts` and
   * re-running this file: this test went red (a row DID exist after the
   * failure) while the other tests stayed green — see the task report for
   * the exact output.
   */
  it("inserts no row when the storage write fails — pins bytes-before-row", async () => {
    const owner = await createUser("wildan");
    const media = new DrizzleMediaRepository(db);
    const useCase = new UploadMedia(media, new FailingStorage());

    await expect(
      useCase.execute({ ownerId: owner.id, bytes: await fixture("small.png") })
    ).rejects.toThrow("simulated storage failure");

    const rows = await db.select().from(postMedia).where(eq(postMedia.ownerId, owner.id));
    expect(rows).toHaveLength(0);
  });

  /**
   * PINS `byteSize` to the RE-ENCODED full variant's size, not the original
   * upload's — the schema groups `byteSize` with `width`/`height` under "Of
   * the FULL image after re-encoding, not of what was uploaded" (see
   * `db/schema.ts`'s own comment on `postMedia`). `photo-with-gps.jpg` is a
   * large synthetic JPEG that re-encodes to a MUCH smaller WebP (measured:
   * 26036 bytes in, 3490 out), so the two numbers cannot coincide by
   * accident — a `byteSize: input.bytes.byteLength` regression would fail
   * the second assertion below even though every OTHER test in this file
   * stays green against it.
   */
  it("pins byteSize to the re-encoded full variant's size, not the original upload's", async () => {
    const owner = await createUser("wildan");
    const storage = new FakeMediaStorageAdapter();
    const media = new DrizzleMediaRepository(db);
    const useCase = new UploadMedia(media, storage);
    const original = await fixture("photo-with-gps.jpg");

    const result = await useCase.execute({ ownerId: owner.id, bytes: original });

    const row = await media.findById(result.id);
    const stored = await storage.get(result.id, "full");
    expect(row?.byteSize).toBe(stored?.bytes.byteLength);
    expect(row?.byteSize).not.toBe(original.byteLength);
  });
});
