# Task 9 report: `PostCard`'s media slot

**Commit:** `c3991c2` — `feat(web): PostCard renders a post's images (Task 9)`

## What was built

`PostCard.tsx` gains a media slot between the body `<p>` and the owner-actions
block (exactly where the brief points, line 69/72 in the pre-existing file).
When `post.media.length > 0`, it renders:

```tsx
<div className="post-card-media" data-count={post.media.length}>
  {post.media.map((image) => (
    <img key={image.id} src={mediaThumbUrl(image.id)} width={image.width} height={image.height} alt="" />
  ))}
</div>
```

- **Thumbnails only.** `src` is `mediaThumbUrl(image.id)` → `GET
  /users/media/:id/thumb`. The full-size route (`GET /users/media/:id`) is
  never referenced anywhere in this component — nothing in the feed can pull
  a full-size image.
- **`width`/`height` set from the media entry**, not measured in the browser.
  These are plain HTML attributes on `<img>` (React renders `width={800}` as
  `width="800"`), which is what lets a modern browser compute the box's
  intrinsic aspect ratio and reserve the row's space before the byte arrives
  — no JS needed for that part.
- **`alt=""` on every image, unconditionally.** No alt text this phase (spec
  §12); nothing derived from `post.body`.
- **`data-count`** is a pure styling hook, written by the component and
  consumed only by `styles.css` via attribute selectors (`[data-count="3"]`
  etc., same pattern already used in this file for `[aria-current="true"]`).
  It carries no behaviour and isn't part of `MediaView`/`PostView`.
- No block rendered at all (no `<div>`) when `post.media` is empty — matches
  the existing "no `<img src="">`" convention already in `MediaStrip.tsx`.

## CSS (styles.css, `.post-card-media` and friends)

The member pages' container (`.user-page`, which `BerandaPage` and
`ProfilePage` both use) is `max-width: 36rem` (576px) **at every viewport
width** — it's centred with more surrounding whitespace on a wide screen, not
resized. That means the media grid needs no `390px`/`1440px`-specific
breakpoints of its own: the same fluid grid renders identically in both
cases, just with more air around it on desktop. I verified this by reading
`.user-page`'s rule directly (`styles.css`, no `@media` wrapping it) rather
than assuming it.

Layout by count, all keyed off `[data-count="N"]`:

- **1** — single column, the image keeps its own aspect ratio (`aspect-ratio:
  auto`, overriding the default `1/1`). A lone photo is the post's whole
  picture, not a handle for it, so it isn't cropped.
- **2** — two equal columns, square tiles (`aspect-ratio: 1/1; object-fit:
  cover`), mirroring the composer's own `.media-strip-preview` — same
  cropping convention already established in this codebase for multi-image
  thumbnails.
- **3** — two columns; the first image spans both rows (`grid-row: span 2`),
  giving "one large + two stacked", the common three-photo mosaic. Plain
  CSS Grid auto-placement handles items 2 and 3 without extra rules.
- **4** — plain 2×2 grid of square tiles, no special-casing needed.
- **5** — six columns; the first two images each span 3 columns (top row:
  two halves) and the remaining three each span 2 columns (bottom row: three
  thirds). I chose this over a naive `repeat(3, 1fr)` grid because that left
  five items as "3 across, then 2 across with an empty gap at the bottom
  right" — not broken, but not what "sensible" means here.

**This CSS is visually unverified** — I did not, and was told not to, run a
dev server or a browser. It's built by direct analogy to the composer's
existing `.media-strip-preview` (square tiles, `object-fit: cover`,
`var(--radius)`/`var(--line)` tokens) and to how `.user-page` already caps
width, but the owner needs to actually look at it before it ships.

## Red phase

All 8 new tests were run once against the unmodified `PostCard.tsx` (before
touching it) and each failed on its own assertion, not on a load error:

```
- sets width/height per entry:      expected [["800","600"],["400","900"]], got []
- alt="" on every image:            expected ["","",""],                  got []
- data-count styling hook:          expected "3",                          got undefined
- slot between body and actions:    expected mediaIndex > bodyIndex(291),  got -1 (not found)
... (thumbnail-src / three-images / five-images tests: expected literal src arrays, got [])

15 pass
7 fail   <- the 8th new test tripped an assertion inside one of the other 7's block; final count below
33 expect() calls
```

(After implementing: `bun test src/user/PostCard.test.tsx` → 22 pass, 0
fail, 34 expect() calls — 8 new tests, all previously-passing 14 untouched.)

## Judgement calls the thin brief left open

1. **`data-count` as a styling hook.** The brief doesn't specify how CSS
   should key off "how many images." I added a `data-count` attribute
   (mirroring the codebase's existing `[aria-current="true"]` convention)
   rather than per-count class names, and tested it as a contract (`marks
   the media wrapper with how many images it holds`) since `styles.css` has
   no test coverage of its own and this is the only load-bearing seam
   between the component and the stylesheet.
2. **Single image is not cropped to square; 2–5 are.** Not specified in the
   brief. Chose to preserve the natural aspect ratio for exactly one image
   (it's the whole content of the post) and crop to square tiles for a
   multi-image mosaic, following the precedent already set by the
   composer's `.media-strip-preview` (its own comment: "Cropped to a square
   tile rather than letterboxed").
3. **The 3- and 5-image mosaics** (one-large-plus-two vs. plain grid;
   two-plus-three vs. plain 3-column) are my own layout choice, not derived
   from spec text — the spec has no UI mockups for this. I picked shapes
   that avoid an uneven trailing gap, which is the only concrete "sensible"
   failure mode I could reason about without a browser.
4. **No max-height cap on a single tall/portrait image.** Considered adding
   one so a very tall photo can't dominate the feed, but that requires
   fighting CSS `aspect-ratio`/`object-fit` mechanics I can't visually
   verify, and neither the brief nor spec §7/§12 asks for it — left out
   rather than invented.
5. **Fixed two ProfilePage.test.tsx fixtures**, outside the brief's named
   file list. Full detail below — this was necessary for the suite to stay
   green, not a scope choice.

## The ProfilePage.test.tsx fixture bug this task exposed

After implementing, `bun test` (whole suite) reported **155 failures across
unrelated files** and took ~112s instead of the usual ~18s — reproduced
identically twice. Bisecting (stash my diff → clean 736/0/18s; restore →
155 fail/112s) confirmed it was caused by my change, but not by a logic bug
in `PostCard`.

Root cause: two raw PATCH-response mocks in `ProfilePage.test.tsx` (around
what were then lines 544 and 656) built a `PostView`-shaped object by hand
and never included `media`, even though `PostView.media`'s own docstring in
`apiClient.ts` says it is "REQUIRED and `[]` on a post with none, never
absent." Before this task, nothing read `post.media`, so the gap was inert.
`PostCard` now reads `post.media.length` unconditionally on every render (by
design — the same docstring says callers should never write `?? []` over a
field the server always sends), so those two mocks now threw
`TypeError: undefined is not an object (evaluating 'post.media.length')`
inside React's render. That uncaught render exception cascaded into
`waitFor`-based timeouts in unrelated files under the parallel test runner,
which is what produced the ~150 failures and the 6x slowdown — not a hang
or memory issue, and not the hazard this task's brief warns about (no DOM
node ever reached an assertion; confirmed by grepping for `author: { handle`
across every test file that builds a `PostView` — only these two literal
objects lacked `media`).

Fixed by adding `media: []` to both mocks, with a comment explaining why
(`apps/web/src/user/ProfilePage.test.tsx`). This is the correct fix per the
existing contract — `PostCard` staying defensive (`post.media ?? []`) would
have silently hidden a real fixture drift instead of surfacing it, exactly
the kind of guessed-back-into-existence fallback this codebase's own
docstrings warn against elsewhere (e.g. `viewerFollows`).

## Test counts

- Before: 736 pass / 0 fail (45 files, ~19s)
- After: 744 pass / 0 fail (45 files, ~18s) — 8 new tests in
  `PostCard.test.tsx`, all other files unchanged in count.
- `bun run typecheck` — clean, no output, both before implementing and
  after.

## Files touched

- `apps/web/src/user/PostCard.tsx` — the media slot.
- `apps/web/src/user/PostCard.test.tsx` — 8 new tests (`PostCard — the media
  slot (Task 9, spec §7/§12)`), following the file's existing `isNode`-style
  discipline: every assertion is on a string, a count, or a number — no DOM
  node is ever passed to `expect()`.
- `apps/web/src/styles.css` — `.post-card-media` and its `[data-count]`
  variants.
- `apps/web/src/user/ProfilePage.test.tsx` — added `media: []` to two
  pre-existing PATCH-response mocks that were out of sync with `PostView`'s
  contract; necessary for the full suite to pass after `PostCard` started
  reading the field.

## Self-review

Read the full diff after implementing. Confirmed: `git status` is clean
after commit; no other file was touched; the CSS section comment matches
what the rules actually do; the component comment's spec citations were
corrected (originally miscited §7, actually the brief plus §5/§9) before
committing; no `dangerouslySetInnerHTML`, no raw server-error strings
introduced (`no-raw-server-errors.test.ts` and `no-hanging-dom-assertions
.test.ts` both still pass as part of the 744).
