# Task 3 report — the image pipeline

## What was built

- `apps/api/src/domain/image.ts` — `processUpload(bytes)`, `ProcessedImage`, `MAX_UPLOAD_BYTES`,
  `UnsupportedImageError`, `FULL_MAX_EDGE` (1600), `THUMB_MAX_EDGE` (600). Implementation matches
  the brief's Step 5 code verbatim, with one deliberate deviation (see "Deviation from the brief"
  below).
- `apps/api/src/domain/image.test.ts` — the brief's Step 3 test file, copied verbatim (7 tests).
- `apps/api/src/test-support/fixtures/`:
  - `photo-with-gps.jpg` — synthetic 2400×1800 JPEG carrying real EXIF including a GPS IFD.
  - `small.png` — 200×150 PNG, smaller than the 600px thumbnail target.
  - `not-an-image.txt` — plain text renamed with a misleading extension.
- `apps/api/package.json` / `bun.lock` — added `sharp@^0.35.3`.
- `scripts/deploy.sh` — added a synchronous sharp-load check after `bun install`, matching the
  brief's Step 7 text, with a comment in the script's own voice explaining why (own native
  dependency, prebuilt binary can fail to load on a given box, same reasoning as the postgres/api
  health polls already in the script).

## sharp version installed

`sharp@0.35.3` (bundles vips 8.18.3, libwebp 1.6.0). Confirmed with:
```
bun -e 'import sharp from "sharp"; console.log(sharp.versions)'
```
which printed a full version object (not undefined/error) — this project's first native dependency
loads correctly on this box.

## How each fixture was generated, and how the EXIF one was verified

All three generated via a throwaway script run with `bun` against the installed `sharp` (deleted
after use; not part of the commit).

**`photo-with-gps.jpg`** — `sharp({ create: {...} }).jpeg().withExif({...})`. First attempt used a
`GPS` key in the `withExif` object, which silently produced NO GPS IFD (sharp's `withExif` only
recognizes `IFD0`..`IFDn` group keys, mapped from `dist/output.cjs`'s own docstring example — GPS
tags belong under `IFD3`, not a key literally named `GPS`). I caught this because I did not trust
sharp's own report that `meta.exif` was "defined" — a defined-but-GPS-less EXIF blob would have
made the guard test in Step 3 pass while proving nothing. I wrote a small manual TIFF/EXIF parser
(walked the byte-order header, IFD0 entries, followed the `0x8825` GPS-IFD-pointer tag) to confirm
an actual GPS sub-IFD exists with real tags. First attempt: no `0x8825` tag in IFD0 at all — GPS
data was not written. Fixed by moving the four GPS tags to `IFD3`; re-parsed and found `0x8825`
present in IFD0, pointing to a GPS IFD containing `GPSLatitudeRef` (0x0001), `GPSLatitude` (0x0002),
`GPSLongitudeRef` (0x0003), `GPSLongitude` (0x0004) — four real Rational/Ascii-typed entries.
Independently corroborated with the system `file` command, which reports:
```
photo-with-gps.jpg: JPEG image data, Exif standard: [TIFF image data, little-endian, ...,
manufacturer=DIUDARA, model=TestCam, ..., GPS-Data], baseline, ..., 2400x1800, components 3
```
— `file`'s own EXIF parser (independent of sharp and of my hand-rolled one) also reports
`GPS-Data`. The coordinates used are fabricated (Jakarta-area lat/long, not a real person's
location): `GPSLatitudeRef=S, GPSLatitude=6/1 10/1 0/1, GPSLongitudeRef=E, GPSLongitude=106/1 49/1
0/1`.

Also ran the brief's own required check:
```
bun -e 'import sharp from "sharp"; sharp("src/test-support/fixtures/photo-with-gps.jpg")
  .metadata().then(m => console.log(m.exif))'
```
→ printed a `<Buffer 45 78 69 66 00 00 ...>` (340 bytes), not `undefined`.

Image is 2400×1800 (larger than the 1600px full-image target) so the "capped at 1600px" resize
test exercises real downscaling, not a no-op.

**`small.png`** — `sharp({ create: { width: 200, height: 150, ... } }).png()`. Verified
`200 150 png` via `sharp(...).metadata()`.

**`not-an-image.txt`** — a short plain-text file with a `.txt` extension, describing itself and
why it exists (sniffing the header, not the filename/Content-Type).

## Red phase output

Stubbed `processUpload` first (`throw new Error("not implemented")`, `MAX_UPLOAD_BYTES = -1`) so
the test file could load, then ran `bun test src/domain/image.test.ts`:

```
 0 pass
 7 fail
 4 expect() calls
Ran 7 tests across 1 file. [1.94s]
```

All 7 failures were on their own assertions, not on import/module resolution:
- The four `processUpload(...)`-calling tests before the two `.rejects` tests failed with
  `error: not implemented` thrown from inside `processUpload` (propagated as an unhandled
  rejection into the `await`, not a test-harness error).
- `"rejects a file whose bytes are not an image..."` failed on
  `toBeInstanceOf(UnsupportedImageError)` — expected the class, got the stub's plain `Error`.
- `"rejects HEIC..."` failed on `toThrow(/JPG, PNG, WebP/)` — expected the pattern, got
  `"not implemented"`.
- `"caps uploads at 10 MB"` failed on `toBe(10 * 1024 * 1024)` — expected `10485760`, got `-1`.

This confirms a genuine red phase: every test failed for its own reason, none from a load/import
error.

## Green phase

After pasting the brief's Step 5 implementation verbatim, first run showed 6 pass / 1 fail — see
"Deviation from the brief" below. After the one wording fix, `bun test src/domain/image.test.ts`:
```
 7 pass
 0 fail
 14 expect() calls
Ran 7 tests across 1 file. [3.15s]
```

## Deviation from the brief

The brief's Step 3 test (verbatim) asserts:
```ts
await expect(processUpload(heic)).rejects.toThrow(/JPG, PNG, WebP/);
```
The brief's Step 5 implementation (verbatim) sets:
```ts
const UNSUPPORTED_MESSAGE = "Format foto tidak didukung. Gunakan JPG, PNG, atau WebP.";
```
These two verbatim blocks contradict each other: `"...JPG, PNG, atau WebP."` does not contain the
contiguous substring `"JPG, PNG, WebP"` (the inserted `"atau "` breaks it), so the regex does not
match and the test fails against the brief's own suggested implementation. Confirmed this by
running it: 6 pass / 1 fail, with the failure showing the mismatch directly (`Expected pattern:
/JPG, PNG, WebP/`, `Received message: "Format foto tidak didukung. Gunakan JPG, PNG, atau WebP."`).

I judged this a wording bug rather than an ambiguity worth stopping the whole task for (unlike the
EXIF-fixture risk called out explicitly in my instructions, which I did stop and verify carefully).
I changed only the message text, keeping it natural Bahasa Indonesia and still naming the three
working formats, to:
```
"Format foto tidak didukung. Format yang didukung: JPG, PNG, WebP."
```
This satisfies the global constraint (names the formats that work) and matches the verbatim test's
regex. No other line of the brief's implementation was changed. Flagging this explicitly in case
the exact original wording ("Gunakan JPG, PNG, atau WebP.") was intended to ship and the test
should have been the one adjusted instead — I did not touch the test since Step 3's test code was
called out as literal/verbatim without a caveat, whereas the message string had no such standalone
call-out.

## Test counts

- Before this task (per my brief's stated baseline): 2065 pass, plus 3 from Task 2's last round's
  covering files → 2068.
- After this task, full suite (`cd apps/api && bun test`): **2075 pass, 0 fail**, 5559 expect()
  calls, 143 files, 223.79s. 2068 + 7 new tests = 2075 — exact match, no other regressions.
- `bun run typecheck` (`tsc --noEmit`) — clean, no output.

## deploy.sh change

Inserted immediately after the existing `bun install` step (before `postgres up`), matching the
brief's Step 7 snippet exactly, with a comment written in the script's existing voice (see the
file's own postgres/api-health-poll comments for the pattern being matched): explains that sharp is
the project's only native dependency, that `bun install` succeeding doesn't guarantee the prebuilt
binary loads on this specific box (libc/arch mismatch), and that this check exists to fail loudly
here — the one place a person running a real redeploy is watching synchronously — rather than at
someone's first photo upload. Verified `bash -n scripts/deploy.sh` (syntax OK) and that the check
itself currently passes on this box (`sharp` loads fine here).

## Commit

`8b1e38f` — `feat(api): validate, re-encode and thumbnail an upload, stripping EXIF`
(8 files changed: `apps/api/package.json`, `bun.lock`, `scripts/deploy.sh`,
`apps/api/src/domain/image.ts`, `apps/api/src/domain/image.test.ts`, and the three fixtures).

`git status` is clean after the commit.

## Things I'm unsure about / worth a second look

1. The message-wording deviation above — I resolved it myself; flagging in case the intent was
   different.
2. `MAX_UPLOAD_BYTES` is exported but not enforced inside `processUpload` itself — per the brief's
   own Step 5 code, the size cap is presumably meant to be checked by the caller (Task 4's upload
   route) before or independently of calling `processUpload`. I did not add enforcement inside
   `processUpload` since the brief's implementation doesn't, and the test only checks the constant's
   value, not that oversized bytes are rejected by this function.
3. `photo-with-gps.jpg`'s "photo" content is a flat synthetic color plane (not a real photograph) —
   fine for these tests (which check format/dimensions/EXIF, not visual content), but noting it in
   case a more photograph-like fixture is wanted later for any visual/perceptual test.

---

## Fix round 1 (review response)

Three findings from the review, all addressed.

**1. (Important) Copy restored.** The coordinator ruled the user-facing Bahasa message is the
binding half of the two-verbatim-blocks contradiction (a Global Constraint), not the test regex,
which was only a sketch — the reviewer independently agreed. Reverted `UNSUPPORTED_MESSAGE` in
`apps/api/src/domain/image.ts` to the brief's original wording:
```
"Format foto tidak didukung. Gunakan JPG, PNG, atau WebP."
```
and loosened the HEIC test's regex in `image.test.ts:102` (was line 60 before the other edits
shifted it) to tolerate the natural sentence:
```ts
await expect(processUpload(heic)).rejects.toThrow(/JPG,\s*PNG,\s*(atau\s+)?WebP/);
```

**2. (Important) Thumb-side `withoutEnlargement` now covered.** Added a new test,
`"does not upscale the thumbnail either"`, that decodes `result.thumb` (not `result.width`/
`result.height`, which are the full image's dimensions) via `sharp(result.thumb).metadata()` and
asserts `200`/`150` — mirroring the fixture's actual size.

Verified red-on-revert the same way the reviewer did: backed up `image.ts`, stripped
`withoutEnlargement: true` from **only** the thumb `resize()` call (left the full-image resize's
`withoutEnlargement: true` untouched), and re-ran:

```
cd apps/api && bun test src/domain/image.test.ts
```
Output:
```
 7 pass
 1 fail
error: expect(received).toBe(expected)
Expected: 200
Received: 600
      at <anonymous> (.../image.test.ts:87:24)
(fail) processUpload > does not upscale the thumbnail either [61.64ms]
```
Exactly the new test failed, and only that one — `small.png` (200x150) got upscaled to 600 on the
long edge with `withoutEnlargement` removed from the thumb path, confirming the new test genuinely
pins that behaviour. Restored the file from the backup, re-ran, back to `8 pass / 0 fail`.

**3. (Minor) GPS guard strengthened.** Added `hasGpsIfdPointer(exif: Buffer): boolean` to
`image.test.ts` — a small hand-rolled TIFF walker (byte-order header → IFD0 entries → looks for
tag `0x8825`, the GPS-IFD pointer) reusing the same logic I used earlier to first diagnose the
`withExif({ GPS: ... })` bug. The guard in `"strips EXIF, including GPS"` now asserts both:
```ts
expect(sourceExif).toBeDefined();
expect(hasGpsIfdPointer(sourceExif!)).toBe(true);
```
so a fixture that carries EXIF but no GPS data (e.g. only Make/Model) can no longer silently pass
the guard.

### Verification

Ran only the covering file, as instructed (not the full 215s suite):
```
cd apps/api && bun test src/domain/image.test.ts
```
Final output:
```
 8 pass
 0 fail
 17 expect() calls
Ran 8 tests across 1 file. [2.97s]
```
`bun run typecheck` (`tsc --noEmit`) — clean, no output.

### Commit

`ca2da15` — `fix(api): restore Bahasa copy, pin thumb no-upscale, strengthen GPS guard (Task 3 fix
round 1)` (2 files changed: `apps/api/src/domain/image.ts`, `apps/api/src/domain/image.test.ts`).

`git status` is clean after the commit — no stray mutations, the temporary revert-and-restore of
`image.ts` used to prove red-on-revert left no trace (restored from a `/tmp` backup, then that
backup was deleted).
