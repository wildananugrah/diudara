# Task 9 re-review 1: fix round 1 (`PostCard`'s media slot)

Reviewed against: `.superpowers/sdd/2026-08-18-images/review-8651b68..81e6074.diff`
(only the `apps/web` changes; the two `.gitignore`/scratch-directory commits
are controller housekeeping, out of scope), `task-9-review.md`,
`task-9-report.md`, and the spec's actual section headings in
`docs/superpowers/specs/2026-08-18-images-design.md`. Verified by running the
suite, typecheck, and mutation; tree left clean (`git status --short` empty
after every mutation was reverted with `git checkout --`).

## I1 (Important) — version-skew white screen: ADDRESSED

- `PostCard.tsx` now assigns `const media = post.media ?? [];` once, right
  after the clock (`PostCard.tsx:55`), and every subsequent read in the
  render (`media.length > 0`, `data-count={media.length}`, `media.map(...)`)
  uses that local, guarded binding — there is exactly one remaining `post.media`
  read in the file (the assignment itself), confirmed by
  `grep -n "post\.media" apps/web/src/user/PostCard.tsx`. No unguarded second
  read slipped through (e.g. no later `.map` still reading `post.media`
  directly) — the guard covers every use.
- Mutated the guard: `const media = post.media ?? [];` → `const media =
  post.media;`, ran `bun test src/user/PostCard.test.tsx`. Result: **22 pass,
  1 fail** — the failing test is exactly the named one, `PostCard — the media
  slot (Task 9, spec §3, §4, §5.1, §12) > renders without throwing when
  \`media\` is missing from the response entirely (version-skew deploy
  window)`, failing with `TypeError: undefined is not an object (evaluating
  'media.length')` thrown inside React's render, before `renderCard` returns
  a container — no DOM node appears anywhere in the failure output. Reverted
  with `git checkout -- apps/web/src/user/PostCard.tsx`; confirmed restored.
- `PostView.media` in `apiClient.ts:810` is still declared as required,
  non-optional (`media: MediaView[];`), unchanged by this fix. The guard is a
  render-boundary runtime safeguard only; the type was not weakened.
  **One loose end, not part of either named finding but adjacent to I1's own
  "must not become a licence for the type to lie" concern:** the field's
  docstring (`apiClient.ts:802-808`) still reads "neither of them writing
  \`?? []\` over a field the server always sends" — that sentence is now
  false of `PostCard`, which *does* write `?? []` over it as of this fix.
  Not a defect in the guard itself, just a stale comment worth a follow-up
  correction so a future reader doesn't take it as still true.
- Full suite: `bun test` → 745 pass, 0 fail, 1728 expect() calls, 45 files,
  ~19s (matches the report). `bun run typecheck` → clean, no output.
- `no-hanging-dom-assertions.test.ts` → 2 pass, 0 fail. The new test itself
  only calls `.length` on `container.querySelectorAll(...)` results — no DOM
  node ever reaches `expect()`.

**Verdict: ADDRESSED.** Named test reddens on exactly the right mutation,
every read of `post.media` is guarded, the type contract is untouched, and
nothing regressed.

## Minor — spec citation drift: NOT ADDRESSED (new citations still wrong)

The fix round replaced "§7/§9" and "§7/§12" with "§5.1: delivery proxies,
thumbnails named as Phase 4's job; the media slot itself is §3" (component
comment, `PostCard.tsx:76-77`) and `(Task 9, spec §3, §4, §5.1, §12)` (test
`describe` name). §7 is no longer cited anywhere, which fixes the original
complaint. But checking the new citations against the spec's actual
headings (`docs/superpowers/specs/2026-08-18-images-design.md`) shows two of
them are themselves wrong, not just different:

- `grep -n "media slot\|Phase 4's job\|PostCard"` on the spec shows:
  - Line 31, `` - **`PostCard` gains a media slot.** It is not
    redesigned.`` — this sentence lives in **§2 "What the parent specs
    already settle"** (§2 spans lines 26-37; §3 "Decisions taken during
    brainstorming" starts at line 37). Grepping §3's own text (lines 37-59)
    for "media slot" or "PostCard" returns nothing. So "the media slot
    itself is §3" is factually wrong — it should be §2.
  - Line 34, `` - **Thumbnails are Phase 4's job**, named explicitly in
    §8's table.`` — also in §2, not §5.1. §5.1 ("Why delivery proxies
    rather than redirects") does correctly cover the *proxy* claim in the
    same comment, but "thumbnails named as Phase 4's job" specifically is a
    §2 sentence, misattributed to §5.1 by the comment's phrasing.
  - §4 ("The model" — `width`/`height` columns, "lets `PostCard` reserve
    space and not reflow the feed") and §12 ("Honest limitations" — "No alt
    text... deliberately not smuggled into this one") are both correctly
    cited, unchanged from before and confirmed against the spec text.

So this round traded one wrong citation (§7) for a mix of correct (§4, §12,
the "delivery proxies" half of §5.1) and still-wrong (§3 for the media slot;
"thumbnails ... Phase 4's job" attributed to §5.1) citations. The correct
citation for both the media slot and "thumbnails are Phase 4's job" is §2,
which appears nowhere in the fixed comment or the describe block.

**Verdict: NOT ADDRESSED.** The drift away from §7 is real, but the
replacement citations were not checked against the spec's actual section
boundaries and two of them (§3 for the media slot, §5.1 for "thumbnails
named as Phase 4's job") are incorrect — §2 is the citation both need. This
is comment-only, not a behavior defect.

## Nothing else regressed

- Thumbnails still used in the feed: `src={mediaThumbUrl(image.id)}` →
  `/users/media/:id/thumb`; no full-size route reference anywhere in the
  file (`PostCard.tsx:101`).
- `width`/`height` still set from the media entry, not measured
  (`PostCard.tsx:107-108`), correctly cited to §4.
- `alt=""` unchanged, unconditional, correctly cited to §12
  (`PostCard.tsx:115`).
- Full web suite green (745/0), typecheck clean, `no-hanging-dom-assertions`
  guard green — all reconfirmed directly, not just taken from the report.

## Tree state

`git status --short` clean before, during (only the one deliberate mutation,
immediately reverted), and after this re-review. No file left modified.
