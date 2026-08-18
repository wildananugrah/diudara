import sharp from "sharp";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const FULL_MAX_EDGE = 1600;
export const THUMB_MAX_EDGE = 600;

/**
 * Bahasa, and it NAMES the formats that work — "format tidak didukung" alone
 * leaves the person guessing. Phrased as "JPG, PNG, WebP" (no "atau" between
 * the last two) so the list reads as one contiguous run of supported
 * formats — that's also what the test at image.test.ts asserts on.
 */
const UNSUPPORTED_MESSAGE = "Format foto tidak didukung. Format yang didukung: JPG, PNG, WebP.";

export class UnsupportedImageError extends Error {
  constructor(message = UNSUPPORTED_MESSAGE) {
    super(message);
    this.name = "UnsupportedImageError";
  }
}

export interface ProcessedImage {
  full: Uint8Array;
  thumb: Uint8Array;
  width: number;
  height: number;
}

const ACCEPTED = new Set(["jpeg", "png", "webp"]);

/**
 * Validate, re-encode, and derive a thumbnail.
 *
 * The FILE'S OWN HEADER decides its type — sharp reads the bytes — so a client
 * lying in `Content-Type` changes nothing. `withoutEnlargement` is what keeps a
 * small image small rather than blurring it up to the target, and the metadata
 * strip is a privacy behaviour, not a size one (spec §9).
 */
export async function processUpload(bytes: Uint8Array): Promise<ProcessedImage> {
  let format: string | undefined;
  try {
    format = (await sharp(bytes).metadata()).format;
  } catch {
    throw new UnsupportedImageError();
  }
  if (format === undefined || !ACCEPTED.has(format)) throw new UnsupportedImageError();

  // No `.withMetadata()` anywhere here: sharp drops EXIF unless asked to keep
  // it, and asking is precisely what must never happen.
  const fullImage = sharp(bytes).resize({
    width: FULL_MAX_EDGE,
    height: FULL_MAX_EDGE,
    fit: "inside",
    withoutEnlargement: true,
  });
  const full = await fullImage.webp({ quality: 82 }).toBuffer();
  const meta = await sharp(full).metadata();
  const thumb = await sharp(bytes)
    .resize({
      width: THUMB_MAX_EDGE,
      height: THUMB_MAX_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 75 })
    .toBuffer();

  return {
    full: new Uint8Array(full),
    thumb: new Uint8Array(thumb),
    width: meta.width!,
    height: meta.height!,
  };
}
