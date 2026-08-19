import { describe, expect, it } from "bun:test";
import sharp from "sharp";
import {
  processUpload,
  ImageRejectedError,
  ImageTooManyPixelsError,
  UnsupportedImageError,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_PIXELS,
} from "./image";

const fixture = (name: string) => Bun.file(`${import.meta.dir}/../test-support/fixtures/${name}`).bytes();

/**
 * Walks the TIFF structure inside an EXIF blob (the same bytes `sharp`'s
 * `metadata().exif` returns) far enough to tell whether IFD0 carries tag
 * 0x8825 — the GPS-IFD pointer. `metadata().exif` being merely *defined*
 * does not prove GPS data exists: an EXIF blob with only e.g. Make/Model
 * would pass a "toBeDefined()" guard while making the strip-GPS assertion
 * below meaningless. This is what actually confirms the fixture carries GPS.
 */
function hasGpsIfdPointer(exif: Buffer): boolean {
  const tiffStart = 6; // skip the leading "Exif\0\0"
  const little = String.fromCharCode(exif[tiffStart]!, exif[tiffStart + 1]!) === "II";
  const u16 = (off: number) => (little ? exif.readUInt16LE(off) : exif.readUInt16BE(off));
  const u32 = (off: number) => (little ? exif.readUInt32LE(off) : exif.readUInt32BE(off));

  const ifd0Offset = tiffStart + u32(tiffStart + 4);
  const entryCount = u16(ifd0Offset);
  for (let i = 0; i < entryCount; i++) {
    const entryOffset = ifd0Offset + 2 + i * 12;
    if (u16(entryOffset) === 0x8825) return true;
  }
  return false;
}

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
    // GUARD: the fixture must actually carry GPS data (not just SOME EXIF —
    // e.g. Make/Model alone would satisfy a bare toBeDefined() and leave
    // this test proving nothing about the GPS-stripping behaviour it names).
    const sourceExif = (await sharp(source).metadata()).exif;
    expect(sourceExif).toBeDefined();
    expect(hasGpsIfdPointer(sourceExif!)).toBe(true);

    const result = await processUpload(source);

    expect((await sharp(result.full).metadata()).exif).toBeUndefined();
    expect((await sharp(result.thumb).metadata()).exif).toBeUndefined();
  });

  it("does not upscale an image smaller than the target", async () => {
    const result = await processUpload(await fixture("small.png"));

    expect(result.width).toBe(200);
    expect(result.height).toBe(150);
  });

  /**
   * `result.width`/`result.height` above are the FULL image's dimensions —
   * they say nothing about the thumb. Decoding the thumb bytes directly is
   * what actually pins withoutEnlargement on the thumbnail's own resize
   * call; without this, a regression that upscales every small thumbnail
   * would ship silently.
   */
  it("does not upscale the thumbnail either", async () => {
    const result = await processUpload(await fixture("small.png"));

    const meta = await sharp(result.thumb).metadata();
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(150);
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
    await expect(processUpload(heic)).rejects.toThrow(/JPG,\s*PNG,\s*(atau\s+)?WebP/);
  });

  it("caps uploads at 10 MB", () => {
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
  });

  it("caps uploads at 40 megapixels", () => {
    expect(MAX_UPLOAD_PIXELS).toBe(40_000_000);
  });

  /**
   * **A real 5.5 KB file that decodes to 45 MEGAPIXELS.** Final whole-branch
   * review, Important 1: `MAX_UPLOAD_BYTES` bounds the wire, not the bitmap, so
   * before this bound a 446 KB PNG made the API allocate 1.41 GB and any
   * signed-up account could OOM-kill the single API process on demand.
   *
   * The fixture is REAL bytes, not a mock, for the same reason the EXIF test
   * is: the thing under test is what sharp does with a header, and a mock would
   * prove nothing about it. 9000x5000 = 45,000,000 pixels, just over the bound.
   */
  it("rejects an image with more pixels than the bound, however few bytes it is", async () => {
    const bomb = await fixture("oversized-dimensions.png");
    expect(bomb.byteLength).toBeLessThan(64 * 1024);

    await expect(processUpload(bomb)).rejects.toBeInstanceOf(ImageTooManyPixelsError);
  });

  it("says what is wrong with an over-size image, in Bahasa, naming the limit", async () => {
    await expect(processUpload(await fixture("oversized-dimensions.png"))).rejects.toThrow(
      /40 megapiksel/
    );
  });

  /** Both refusals travel with a machine-readable code — the client BRANCHES on it. */
  it("carries a distinct code for each of the two refusals", async () => {
    const tooBig = await processUpload(await fixture("oversized-dimensions.png")).catch(
      (err: unknown) => err
    );
    const notAnImage = await processUpload(await fixture("not-an-image.txt")).catch(
      (err: unknown) => err
    );

    expect((tooBig as ImageRejectedError).code).toBe("media_too_many_pixels");
    expect((notAnImage as ImageRejectedError).code).toBe("media_unsupported_format");
  });

  it("accepts an image just under the pixel bound", async () => {
    const wide = await sharp({
      create: { width: 8000, height: 4000, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();

    const result = await processUpload(new Uint8Array(wide));

    expect(result.width).toBe(1600);
    expect(result.height).toBe(800);
  });
});
