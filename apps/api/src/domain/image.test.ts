import { describe, expect, it } from "bun:test";
import sharp from "sharp";
import { processUpload, UnsupportedImageError, MAX_UPLOAD_BYTES } from "./image";

const fixture = (name: string) => Bun.file(`${import.meta.dir}/../test-support/fixtures/${name}`).bytes();

describe("processUpload", () => {
  it("produces a WebP full image capped at 1600px on the long edge", async () => {
    const result = await processUpload(await fixture("photo-with-gps.jpg"));

    const meta = await sharp(result.full).metadata();
    expect(meta.format).toBe("webp");
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1600);
    expect(result.width).toBe(meta.width!);
    expect(result.height).toBe(meta.height!);
  });

  it("produces a 600px WebP thumbnail", async () => {
    const result = await processUpload(await fixture("photo-with-gps.jpg"));

    const meta = await sharp(result.thumb).metadata();
    expect(meta.format).toBe("webp");
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(600);
  });

  /**
   * Not a size optimisation. A phone photo carries GPS coordinates, and
   * publishing one with its metadata publishes where the person was standing.
   * Spec §9. Asserted on real bytes because a mock cannot prove it.
   */
  it("strips EXIF, including GPS", async () => {
    const source = await fixture("photo-with-gps.jpg");
    // GUARD: the fixture must actually carry EXIF, or this test proves nothing.
    expect((await sharp(source).metadata()).exif).toBeDefined();

    const result = await processUpload(source);

    expect((await sharp(result.full).metadata()).exif).toBeUndefined();
    expect((await sharp(result.thumb).metadata()).exif).toBeUndefined();
  });

  it("does not upscale an image smaller than the target", async () => {
    const result = await processUpload(await fixture("small.png"));

    expect(result.width).toBe(200);
    expect(result.height).toBe(150);
  });

  it("rejects a file whose bytes are not an image, whatever it is called", async () => {
    await expect(processUpload(await fixture("not-an-image.txt"))).rejects.toBeInstanceOf(
      UnsupportedImageError
    );
  });

  it("rejects HEIC with copy that names the formats that DO work", async () => {
    // HEIC's ftyp box, enough for the decoder to identify and refuse it.
    const heic = new Uint8Array([
      0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
    ]);
    await expect(processUpload(heic)).rejects.toThrow(/JPG, PNG, WebP/);
  });

  it("caps uploads at 10 MB", () => {
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
  });
});
