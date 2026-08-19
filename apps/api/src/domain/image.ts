import sharp, { type Metadata } from "sharp";
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_PIXELS,
  UPLOAD_ERROR_CODE,
  type UploadErrorCode,
} from "@diudara/shared";

// Re-exported, not redeclared. Both were local constants here until the final
// whole-branch review moved them into `packages/shared` — see
// `media.schema.ts`'s own docstring for why a second copy in `apps/web` was
// not the benign duplication it was argued to be.
export { MAX_UPLOAD_BYTES, MAX_UPLOAD_PIXELS };
export const FULL_MAX_EDGE = 1600;
export const THUMB_MAX_EDGE = 600;

/** Bahasa, and it NAMES the formats that work — "format tidak didukung" alone leaves the person guessing. */
const UNSUPPORTED_MESSAGE = "Format foto tidak didukung. Gunakan JPG, PNG, atau WebP.";

/**
 * Bahasa, and it names the LIMIT and the remedy — "foto terlalu besar" alone
 * would be indistinguishable from the byte cap, which is the one thing the
 * person has already satisfied when they see this.
 */
const TOO_MANY_PIXELS_MESSAGE =
  `Resolusi foto terlalu besar (maksimal ${MAX_UPLOAD_PIXELS / 1_000_000} megapiksel). ` +
  `Perkecil ukuran foto lalu unggah ulang.`;

/**
 * **The base of every refusal `processUpload` can raise, carrying the
 * machine-readable `code` the client branches on.**
 *
 * NOT an `AppError`: this is a domain rule, and the decision that a refusal is
 * an HTTP 400 belongs to `routes/media.ts` — which is also the only layer that
 * knows the response shape the code travels in. The route reads `code` off this
 * base rather than testing for each subclass, so a fifth refusal added here
 * reaches the wire without the route changing at all. That matters because the
 * inference the client USED to make ("any 400 from this route is an unsupported
 * format") broke precisely when a fourth refusal appeared.
 */
export abstract class ImageRejectedError extends Error {
  constructor(message: string, readonly code: UploadErrorCode) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnsupportedImageError extends ImageRejectedError {
  constructor(message = UNSUPPORTED_MESSAGE) {
    super(message, UPLOAD_ERROR_CODE.unsupportedFormat);
  }
}

/**
 * The decoded bitmap would be larger than `MAX_UPLOAD_PIXELS`. Distinct from
 * the byte cap in `UploadMedia` — and it has to be, because the file that
 * triggers this is typically TINY (the measured case: 446 KB of PNG, 1.41 GB of
 * RSS). See `MAX_UPLOAD_PIXELS` for the measurements.
 */
export class ImageTooManyPixelsError extends ImageRejectedError {
  constructor(message = TOO_MANY_PIXELS_MESSAGE) {
    super(message, UPLOAD_ERROR_CODE.tooManyPixels);
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
  let meta: Metadata;
  try {
    meta = await sharp(bytes).metadata();
  } catch {
    throw new UnsupportedImageError();
  }
  const format = meta.format;
  if (format === undefined || !ACCEPTED.has(format)) throw new UnsupportedImageError();

  // THE PIXEL BOUND, AND IT HAS TO BE HERE — before any `.toBuffer()`, on the
  // header read that already runs. `metadata()` parses the header only; the
  // allocation this refuses happens on the FIRST decode, so refusing here costs
  // the file's own bytes and nothing more. Final whole-branch review, Important
  // 1: measured, a 446 KB 12000x12000 PNG took the API to 1.41 GB of RSS and
  // was ACCEPTED, because the only bound in the system was on the wire size.
  //
  // `width`/`height` being absent is not "no pixels" — it is a header this
  // decoder could not read, which the format check above should already have
  // caught, so treat it as unsupported rather than waving it through.
  const { width, height } = meta;
  if (width === undefined || height === undefined) throw new UnsupportedImageError();
  if (width * height > MAX_UPLOAD_PIXELS) throw new ImageTooManyPixelsError();

  // `limitInputPixels` is BELT AND BRACES, not the bound — the check above is,
  // and it is the one that produces a sentence a person can act on. This second
  // layer only matters if a header ever disagrees with the pixels behind it:
  // sharp's own default ceiling is 268 MP, which at the measured ~9.8 MB of RSS
  // per megapixel is ~2.6 GB, so leaving it at the default would mean the
  // fallback was no bound at all.
  const source = () => sharp(bytes, { limitInputPixels: MAX_UPLOAD_PIXELS });

  // No `.withMetadata()` anywhere here: sharp drops EXIF unless asked to keep
  // it, and asking is precisely what must never happen.
  const fullImage = source().resize({
    width: FULL_MAX_EDGE,
    height: FULL_MAX_EDGE,
    fit: "inside",
    withoutEnlargement: true,
  });
  const full = await fullImage.webp({ quality: 82 }).toBuffer();
  const fullMeta = await sharp(full).metadata();
  const thumb = await source()
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
    width: fullMeta.width!,
    height: fullMeta.height!,
  };
}
