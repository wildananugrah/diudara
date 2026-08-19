# Task 3 review — the image pipeline

## Verdicts

**Spec compliance: ✅**

The shipped code implements every required interface (`processUpload`, `ProcessedImage`,
`MAX_UPLOAD_BYTES`, `UnsupportedImageError`), the 1600px/600px resize targets, real
header-sniffing (structurally guaranteed — `processUpload` takes only `bytes`, no
filename/content-type param exists to trust), EXIF stripping on both outputs, and a deploy-time
sharp-load check that genuinely fails the deploy. Behavior matches the brief. The gaps found below
are test-coverage/copy quality issues, not behavioral non-compliance — the underlying
`withoutEnlargement: true` is present on both the full and thumb pipelines in the actual code, it
is just not fully pinned by a test.

**Task quality: findings** (Important x2, Minor x1) — not a clean approval.

## Method

All mutations below were made in `apps/api/src/domain/image.ts`, run against
`bun test src/domain/image.test.ts` only (never the full suite, per instructions), then reverted
with `git checkout --` and diffed against `git show HEAD:...` to confirm byte-identical restoration.
`git status --porcelain` was empty at the end.

## Findings

### 1. Copy question (Important) — independent verdict: the ruling is correct

I judged this myself before reading the reasoning given: **"Gunakan JPG, PNG, atau WebP."** is the
better sentence. It's an instruction — it tells the reader what to do next, which is what an error
message next to an upload button should do. The implementer's replacement, **"Format yang
didukung: JPG, PNG, WebP,"** repeats *didukung* twice across two consecutive sentences ("tidak
didukung... yang didukung"), which reads as a restatement of the problem, not a next step, and the
juxtaposed repetition is genuinely clunky in Indonesian, not just in translation. Indonesian list
convention also expects "atau" before the final item in a spoken/natural list; a bare
comma-separated run without it reads like a spec-sheet label, which is exactly the register this
message is trying to avoid.

I agree with the ruling: the message should revert to `"Format foto tidak didukung. Gunakan JPG,
PNG, atau WebP."`, and the regex in `image.test.ts` line 60 should be loosened to tolerate it —
e.g. `/JPG,\s*PNG,\s*(atau\s+)?WebP/` matches both the natural and the contiguous phrasing. This is
not yet done in the current tree; it needs to land in the fix round. Classified Important because
the project's own stated Global Constraint (user-facing Bahasa quality) is what's at stake, even
though nothing is functionally broken.

Files: `apps/api/src/domain/image.ts:13`, `apps/api/src/domain/image.test.ts:60`.

### 2. Thumbnail's `withoutEnlargement` is completely untested (Important)

Verified by mutation: removing `withoutEnlargement: true` from the **thumb** resize call only
(leaving the full pipeline's intact) — `bun test src/domain/image.test.ts` still reports **7 pass,
0 fail**. Nothing reddens.

Root cause: the "does not upscale an image smaller than the target" test (brief's Step 3, copied
verbatim) only asserts `result.width`/`result.height`, which reflect the **full** image only —
`ProcessedImage` doesn't expose thumb dimensions and no test decodes `result.thumb` for the
`small.png` fixture. Separately, the "produces a 600px WebP thumbnail" test only exercises
`photo-with-gps.jpg` (2400×1800, already larger than 600px), so it can never distinguish "capped
at 600" from "upscaled up to 600." A regression that upscales small images only in the thumb path
would ship silently.

This gap is inherited verbatim from the brief's own Step 3 test, not introduced by the implementer
— they copied the test as instructed. Still an active, currently-shipped coverage hole worth
closing in the fix round (e.g. decode `result.thumb` for the `small.png` case and assert it stays
≤200×150 too).

Contrast: removing `withoutEnlargement` from the **full** pipeline alone does correctly redden
"does not upscale an image smaller than the target" (`Expected: 200, Received: 1600`) — that half
of the behavior is properly pinned.

### 3. EXIF-strip guard checks "has EXIF," not "has GPS specifically" (Minor)

The guard (`image.test.ts:33-34`) is:
```ts
expect((await sharp(source).metadata()).exif).toBeDefined();
```
This proves the fixture carries *some* EXIF blob, not that it carries GPS specifically. If someone
regenerated `photo-with-gps.jpg` later with camera-model/orientation EXIF but no GPS IFD, this
guard would still pass, silently defeating the test's own stated purpose ("A phone photo carries
GPS coordinates... Spec §9").

Low practical risk today for two reasons: (a) I independently verified — via a hand-written
TIFF/IFD parser, not sharp, not `file`, not the implementer's own script — that the **committed**
fixture genuinely carries a GPS IFD pointer (tag `0x8825`) resolving to 4 real GPS entries
(`GPSLatitudeRef`, `GPSLatitude`, `GPSLongitudeRef`, `GPSLongitude`) at the byte level; and (b) the
implementation strips EXIF unconditionally (`processUpload` never calls `.withMetadata()`), so
there's no code path where generic EXIF gets stripped while GPS specifically survives — sharp
doesn't support that selectivity. This is inherited from the brief, minor, and does not block
approval, but worth tightening if the fixture is ever regenerated.

## What I verified and found solid (no finding)

- **EXIF-strip test is real, not a mock.** Confirmed the committed `photo-with-gps.jpg` carries a
  genuine GPS sub-IFD via an independent from-scratch parser (not sharp): IFD0 tag `0x8825` →
  offset 232 → GPS IFD with 4 entries. Corroborated by `file`, which independently reports
  `GPS-Data`.
- **Mutation: add `.withMetadata()` to the full pipeline** → `strips EXIF, including GPS` reddens
  on `result.full` (`Received: <Buffer 45 78 69 66 ...>` instead of `undefined`).
- **Mutation: add `.withMetadata()` to the thumb pipeline only** (full reverted) → the same test
  reddens on `result.thumb` independently. The strip is pinned on **both** outputs.
- **Format validation reads the actual bytes, not client metadata.** `processUpload(bytes:
  Uint8Array)` has no filename/Content-Type parameter at all — there is no value in scope an
  implementation could trust instead of sniffing. The `not-an-image.txt` fixture is genuine plain
  text (verified its contents), and confirmed sharp throws on it (caught, converted to
  `UnsupportedImageError`).
- **HEIC rejection path**: confirmed by direct execution that sharp identifies the truncated `ftyp`
  box as `heif` and throws (`Invalid input: ... File size too small`), which the `catch` converts
  to `UnsupportedImageError` with the default message — exercises the real rejection path, not a
  format-set lookup coincidence.
- **`scripts/deploy.sh` sharp check genuinely fails the deploy.** Confirmed `bun -e
  'import("sharp")...'` returns exit 0 when sharp loads and (by testing with a nonexistent package)
  exit 1 on an unresolvable import, i.e. `bun -e` does wait for the async import before exiting —
  it does not race past the pending promise. Then did the real test: temporarily renamed both
  installed native `sharp-linux*.node` binaries so sharp's own native-loader throws inside the
  dynamic import ("Could not load the "sharp" module using the linux-x64 runtime"); the deploy.sh
  check's exact command block correctly went down the `if !` branch, i.e. would print "sharp failed
  to load... Deploy stopped." and `exit 1`. Restored the binaries and confirmed `sharp.versions`
  loads again afterward. `set -euo pipefail` interaction is fine here because the check is already
  explicitly gated with `if ! (...); then ... exit 1; fi` — the subshell's failure is caught by the
  `if`, not left to trip `set -e` accidentally (and even if it did, `set -e` would abort the whole
  script, which is the desired failure mode anyway).
- **Resize bounds.** `Math.max(width,height) <= 1600` / `<= 600` are asserted as literal numbers
  (not against `FULL_MAX_EDGE`/`THUMB_MAX_EDGE`), matching the "assert literals, not the constant
  under test" requirement. `MAX_UPLOAD_BYTES` is asserted against the literal `10 * 1024 * 1024`,
  same pattern. Full-image no-upscale path is properly pinned (see mutation above; thumb path is
  not — Finding 2).
- **`sharp` is genuinely the only new dependency.** `apps/api/package.json` diff is exactly one
  added line (`"sharp": "^0.35.3"`). `bun.lock` diff adds only `sharp` itself, its `@img/sharp-*`
  platform packages, its declared deps (`detect-libc`, `semver`, `@img/colour`), and one further
  transitive hop: `@emnapi/runtime` (dep of the wasm32 optional platform package) pulls in `tslib`.
  Traced and confirmed that chain in the lockfile diff itself — nothing unrelated was added.
- **`MAX_UPLOAD_BYTES` not enforced inside `processUpload`.** Matches the brief's own Step 5 code
  verbatim — not a Task 3 defect, just a note (already flagged by the implementer) that Task 4's
  upload route needs to actually enforce the cap before or around calling `processUpload`.

## Tree state

`git status --porcelain` is empty. Every mutation (`.withMetadata()` on full; `.withMetadata()` on
thumb; `withoutEnlargement` removed from full; `withoutEnlargement` removed from thumb) was
reverted with `git checkout -- apps/api/src/domain/image.ts` and diffed byte-identical against
`git show HEAD:apps/api/src/domain/image.ts` before moving to the next mutation. The temporarily
renamed sharp native binaries were restored and re-verified loadable.
