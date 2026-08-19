# Task 3 fix round 1 — scoped re-review

Reviewed diff: `review-8b1e38f..ca2da15.diff` (commit `ca2da15`), against
`task-3-review.md`'s three findings and `task-3-report.md`'s fix-round writeup.

Method: `bun test src/domain/image.test.ts` only, per instructions. Two live
mutations applied and reverted with `git checkout --`; `git status` confirmed
clean before and after. One additional check done via a standalone script in
the scratchpad (not touching the repo) to independently reason through the
GPS-guard logic.

## Finding 1 (Important) — Bahasa copy — ADDRESSED

`image.ts:8`: `UNSUPPORTED_MESSAGE` is now exactly
`"Format foto tidak didukung. Gunakan JPG, PNG, atau WebP."` — matches the
review's ruling verbatim.

`image.test.ts:66`: regex changed to `/JPG,\s*PNG,\s*(atau\s+)?WebP/`. Checked
both halves:
- It matches the new message (verified by inspection: `JPG,` + space + `PNG,`
  + space + `atau ` + `WebP`).
- It is not loosened into uselessness — it still requires all three format
  names (`JPG`, `PNG`, `WebP`) to appear in order, just tolerating the
  optional "atau" and flexible whitespace between the contiguous and natural
  phrasings. The guarantee that the message names the supported formats is
  preserved.

## Finding 2 (Important) — thumbnail `withoutEnlargement` untested — ADDRESSED

New test `"does not upscale the thumbnail either"` decodes `result.thumb` via
`sharp(...).metadata()` and asserts `width`/`height` equal 200/150 (the
`small.png` fixture's real size), independent of the full-image dimensions
already asserted elsewhere.

Verified by mutation myself: stripped `withoutEnlargement: true` from only
the thumb `.resize()` call in `image.ts` (full-image resize left untouched),
ran `bun test src/domain/image.test.ts`:

```
7 pass
1 fail
(fail) processUpload > does not upscale the thumbnail either [55.12ms]
Expected: 200
Received: 600
```

Exactly the named test reddens; all 7 others (including the full-image
no-upscale test) stay green, confirming the bug is isolated to the thumb path
and independently confirming the implementer's reported 200×150 → 600
upscale. Mutation reverted with `git checkout --`.

## Finding 3 (Minor) — EXIF guard checks "has GPS", not just "has EXIF" — ADDRESSED

The guard now calls `hasGpsIfdPointer(sourceExif!)` and asserts `true`. That
function walks the TIFF/IFD0 structure and returns `true` only if it finds an
IFD0 entry with tag `0x8825` (the GPS-IFD pointer); otherwise `false`.

Verified by construction, not just reading: wrote a standalone script
(`/tmp/.../scratchpad/verify_gps_guard.ts`, not part of the repo) that
copies the exact `hasGpsIfdPointer` function and feeds it two synthetic
minimal TIFF/EXIF blobs — one with a single Make (`0x010F`) tag and no GPS
pointer, one with a GPS pointer (`0x8825`) tag. Result:

```
no-GPS EXIF -> hasGpsIfdPointer: false (expect false)
with-GPS EXIF -> hasGpsIfdPointer: true (expect true)
```

So a fixture regenerated with non-GPS EXIF (e.g. only Make/Model) would make
`hasGpsIfdPointer` return `false`, and `expect(...).toBe(true)` would fail —
the guard can no longer be silently disarmed by such a regeneration.

## Also checked

- **Production diff scope**: `image.ts` changes are exactly the message
  constant (one line) and a shrunk comment above it (removal of a stale
  multi-line comment, replaced with a one-line comment). No other logic,
  resize, or format-check lines changed — confirmed by reading the full diff
  hunk. In scope for a copy fix, nothing extraneous.
- **No new breakage**: full `image.test.ts` run at baseline (before any
  mutation) is 8 pass / 0 fail / 17 expect() calls, all green.
- **Literal-value assertions**: the new/changed tests assert literal values
  (`200`, `150`, `0x8825`) rather than importing and re-asserting the
  production constants they're meant to pin down. No constant-echoing found.
- **Tree hygiene**: `git status --short` is empty; `git status` reports
  "nothing to commit, working tree clean" after all mutation testing.

## Verdict

All three findings ADDRESSED. No new breakage found. Tree left clean.
