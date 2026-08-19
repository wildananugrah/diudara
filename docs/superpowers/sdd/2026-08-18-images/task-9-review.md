# Task 9 review: `PostCard`'s media slot

Reviewed against: `task-9-brief.md`, `task-9-report.md`,
`review-f5f4dc8..8651b68.diff`, spec `docs/superpowers/specs/2026-08-18-images-design.md`
(§4, §5/§5.1, §7, §9, §12 — the brief cites "§7/§12" but §7 is "The composer";
the material actually binding on `PostCard`'s render is scattered across §3
line 31 ("`PostCard` gains a media slot. It is not redesigned."), §4
(width/height reserve space), §5.1 (thumbnails, proxy not redirect), and §12
(no alt text)). Verified by running the suite and by mutation; tree left
clean (`git status --short` empty in `apps/web` and at repo root after every
mutation was reverted).

## Verdict 1: Spec compliance — ✅

- **Thumbnails only.** `src={mediaThumbUrl(image.id)}` → `/users/media/:id/thumb`.
  The full-size route is never referenced. Mutated `src` to the full-size URL
  (stripped `/thumb`) — reddens `renders one image from the THUMBNAIL
  endpoint, never the full-size one` plus the three/five-image src tests (4
  tests total). Reverted.
- **`width`/`height` from the media entry**, not measured. Mutated both to a
  constant `100` — reddens `sets width and height attributes from EACH
  entry's own size…`. Reverted.
- **`alt=""` unconditionally**, never derived from `post.body`. Mutated to
  `alt={post.body}` — reddens `gives every image alt="" …`. Reverted.
- **One, three, five images** each have a dedicated test asserting the full,
  ordered `src` list. Two and four are covered structurally by the CSS's
  `[data-count]` selectors but have no dedicated component test — acceptable,
  since the component's per-image rendering logic is count-independent (the
  `.map`) and the count-dependent part is pure CSS, which is explicitly
  unverified by design (owner gates in a browser).
- **`PostCard` gains a media slot, not a redesign** — confirmed by diff: the
  only non-additive change to `PostCard.tsx` is the import line; everything
  else in the existing render (header, body, owner actions) is untouched.

## Verdict 2: Task quality — approved, with one Important finding

### Findings

- **Important — production risk from unconditional `post.media.length`,
  real and specific to this deploy** (see worked answer below). Not a defect
  in this task's own code or tests, and the implementer's choice not to
  weaken `PostCard` or the type contract for the *test* suite is correct.
  But the same throw-on-missing-media that only ever surfaced as a fixture
  bug in tests **is reachable from a real, bounded, deploy-time window** in
  production, with no error boundary anywhere in the app to contain it.
  Recommend a runtime-only guard at the render boundary (see below) — this
  does not weaken `PostView.media`'s type contract, since TypeScript is
  erased at runtime and the reader can lie regardless of what the type says.

- **Minor — spec citation drift.** The component comment cites "spec §5,
  §9" and the test `describe` block cites "spec §7/§12"; §7 is the composer,
  not the feed. Harmless (comments, not behavior) but worth a follow-up
  correction so a future reader doesn't go looking for feed-rendering rules
  in the composer section.

- **Minor — no dedicated 2- and 4-image component test.** CSS-only
  difference at those counts, so low risk, but the brief's own bullet list
  ("one, three and five") implicitly leaves 2/4 to the CSS's honesty
  disclosure rather than to a test; consistent with how the task was scoped,
  not a gap the implementer introduced.

Everything else checked out clean:
- `ProfilePage.test.tsx` fix is a pure fixture fix — two lines each adding
  `media: []` to hand-built `PostView`-shaped mocks, no assertion touched,
  confirmed by reading the exact diff hunk.
- Tests assert literal strings (`"/users/media/m1/thumb"`, `"800"`, `""`,
  `"3"`) — `PostCard.test.tsx` does not import `mediaThumbUrl` or any other
  constant under test, so no test can pass by checking a value against
  itself.
- `no-hanging-dom-assertions.test.ts` passes (2/2); the 8 new tests use
  `container.querySelectorAll("img")` only to call `.getAttribute(...)` or
  `.length` — no DOM node is ever the operand of `expect()`.
- CSS read for obvious breakage: `.user-page { max-width: 36rem }` genuinely
  has no `@media` wrapper (confirmed directly), so the "no breakpoints
  needed" claim holds; the 5-image grid's column spans sum correctly (2×3 +
  3×2 = 6 = 6), no fixed pixel widths that could overflow the 36rem
  container, `overflow: hidden` on the wrapper clips corners rather than
  content. Appearance itself is unverified, as disclosed, and correctly left
  to the owner.
- `bun test` (whole suite): 744 pass / 0 fail, matches the report.
  `bun run typecheck`: clean.

## The production-risk question, worked

**Is there a real path where `media` is missing from a genuine server
response reaching `PostCard`?** Yes — one concrete, deploy-shaped path, not
a hypothetical.

1. `PostView.media` and the API's `toPostView`/`media` field were added in
   this same feature branch (`f62ec77`, "feat(api): posts carry media").
   `main` (the currently-deployed production code, confirmed by reading
   `git show main:apps/api/.../post-views.ts`) has **no `media` field at
   all** on `PostView` — the whole images feature, frontend and backend
   together, ships as one `git pull --ff-only origin main` when this branch
   merges.
2. `scripts/deploy.sh`'s order is: `db migrate` → `build web` → **copy the
   new web dist into nginx's serving directory (lines 115-119)** →
   **then** `pm2 startOrReload` the API (line 122) → poll `/health` for up
   to 60s (`seq 1 30`, 2s sleep) before declaring success.
3. Static files are served by nginx directly, with no gate on the API's
   readiness — the moment `cp -r apps/web/dist/* "$WEB_DIST_TARGET/"`
   finishes, every browser that loads or refreshes the page gets the *new*
   bundle, which reads `post.media.length` unconditionally.
4. The API process serving `/users/feed` and `/:handle/posts` at that exact
   moment is still the **old**, pre-media code (pm2 hasn't reloaded it yet),
   which returns `PostView` JSON with no `media` key.
5. `apiClient.ts`'s `apiFetch`/`publicGet` do `(await res.json()) as T` —
   there is no runtime validation anywhere in this file (confirmed: no zod,
   no shape check). The `media: MediaView[]` "required, never absent"
   guarantee is a compile-time fiction against a live server that hasn't
   caught up yet; nothing enforces it at the wire.
6. `PostCard` throws inside React's render (`TypeError: undefined is not an
   object (evaluating 'post.media.length')`). There is **no error boundary
   anywhere in this app** (confirmed: no `ErrorBoundary`/`componentDidCatch`
   in `apps/web/src`). An uncaught render exception with no boundary above
   it unmounts the whole React tree — a white screen, not a degraded post.

So the window is real, its lower bound is however long `pm2 startOrReload`
takes to swap the process (typically sub-second) but its *observed* upper
bound is up to the full 60s health-poll timeout on a slow box, and it
affects **every visitor loading or refreshing `/beranda` or any profile
page** during that window — not a corner case, the feed's two main entry
points. `prepend`/`replace` in `PostFeed.tsx` are also exposed the same way:
they're fed directly from `createPost`/`editPost`'s typed-but-unvalidated
return value, so a post created in the same window is pushed straight into
state with no `media` key and hits the same throw on the very next render.

This is different in kind from the `ProfilePage.test.tsx` fixture bug: that
was a hand-written test double drifting out of sync with a contract nothing
enforces at compile time either — a authoring mistake with no real-world
analogue. This is a genuine client/server version-skew window that the
deploy script's own ordering creates, for a field being introduced in this
exact deploy.

**Conclusion: `post.media?.length` (or reading via `(post.media ??
[]).map(...)`) is cheap insurance that is justified here**, specifically at
this render boundary, precisely because the type system's guarantee cannot
reach across a deploy's process-restart window and nothing else in this
codebase (no error boundary, no response validation) catches the fall. This
does not conflict with the implementer's decision to fix — not paper over —
the `ProfilePage.test.tsx` fixtures; those two things are orthogonal. A
tighter fix would also reorder `deploy.sh` to reload the API before swapping
the web dist (removing the "new web / old api" combination entirely, though
not the mirror-image "old web / new api" case, which is harmless since old
code simply ignores an extra field) — but that is a deploy-script change,
out of this task's file list, and the render-boundary guard is the cheaper,
narrower fix that belongs in this diff.

## Tree state

`git status --short` clean in `apps/web` and at the repo root after every
mutation was reverted (`git checkout --` after each). `bun test` (744/0) and
`bun run typecheck` (clean) both re-confirmed at the end.
