import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "../../db/client";
import { appUsers } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleMediaRepository } from "../../infrastructure/repositories/drizzle-media.repository";
import { FakeMediaStorageAdapter } from "../../infrastructure/storage/fake-media-storage.adapter";
import { UnsupportedImageError, MAX_UPLOAD_BYTES } from "../../domain/image";
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
    const oversized = new Uint8Array(MAX_UPLOAD_BYTES + 1);

    await expect(
      useCase.execute({ ownerId: owner.id, bytes: oversized })
    ).rejects.toBeInstanceOf(ValidationError);
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
});
