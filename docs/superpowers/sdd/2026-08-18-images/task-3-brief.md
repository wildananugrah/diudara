## Task 3: The image pipeline

**Files:**
- Create: `apps/api/src/domain/image.ts`
- Test: `apps/api/src/domain/image.test.ts`
- Create: `apps/api/src/test-support/fixtures/` (three real image files, see Step 2)
- Modify: `apps/api/package.json` (add `sharp`)
- Modify: `scripts/deploy.sh`

**Interfaces:**
- Consumes: nothing.
- Produces: `processUpload(bytes: Uint8Array): Promise<ProcessedImage>`, `ProcessedImage`, `MAX_UPLOAD_BYTES`, `UnsupportedImageError`.

- [ ] **Step 1: Add sharp**

Run: `cd apps/api && bun add sharp`

This is **the project's first native dependency.** Confirm it loaded: `bun -e 'import sharp from "sharp"; console.log(sharp.versions)'`.

- [ ] **Step 2: Create the fixtures**

Three real files in `apps/api/src/test-support/fixtures/`, generated once and committed:

- `photo-with-gps.jpg` — a JPEG carrying EXIF GPS tags. Generate with sharp's `withExif`, or take any photo with location on. **The test in Step 3 is meaningless without real EXIF in this file**, so verify it: `bun -e 'import sharp from "sharp"; sharp("...").metadata().then(m => console.log(m.exif))'` must print a buffer.
- `small.png` — 200×150, smaller than the thumbnail target, for the no-upscale test.
- `not-an-image.txt` — a text file renamed. For the header-sniffing test.

- [ ] **Step 3: Write the failing tests**

```ts
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
```

- [ ] **Step 4: Run them, watch them fail on their own assertions**

Run: `cd apps/api && bun test src/domain/image.test.ts`
Expected: `processUpload` missing. Stub it first (throwing), re-run, confirm each test fails on its assertion rather than on the import.

- [ ] **Step 5: Implement**

```ts
import sharp from "sharp";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const FULL_MAX_EDGE = 1600;
export const THUMB_MAX_EDGE = 600;

/** Bahasa, and it NAMES the formats that work — "format tidak didukung" alone leaves the person guessing. */
const UNSUPPORTED_MESSAGE = "Format foto tidak didukung. Gunakan JPG, PNG, atau WebP.";

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
```

- [ ] **Step 6: Run them and confirm green**

- [ ] **Step 7: Make the deploy fail loudly rather than at the first upload**

In `scripts/deploy.sh`, after the install step, add a check that sharp actually loads on the box:

```bash
echo "==> verifying sharp (the only native dependency)"
if ! (cd apps/api && bun -e 'import("sharp").then(s => s.default.versions)') >/dev/null 2>&1; then
  echo "sharp failed to load — images cannot be processed on this box. Deploy stopped." >&2
  exit 1
fi
```

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/domain/image.ts apps/api/src/domain/image.test.ts apps/api/src/test-support/fixtures apps/api/package.json bun.lock scripts/deploy.sh
git commit -m "feat(api): validate, re-encode and thumbnail an upload, stripping EXIF"
```

---

