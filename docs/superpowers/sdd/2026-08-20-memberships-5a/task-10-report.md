# Task 10 — the profile offer and "Jadi anggota" (implementer report)

**Status: complete, with one requirement I could not meet inside `apps/web` and did not fake.**
Read §4 before the rest: *"an already-active member sees that they are a member"* has **no data on the
wire** in 5a, and the honest options need a decision that is yours, not mine.

- **Commit:** `a5e788d` — `feat(web): the membership offer on a profile, and "Jadi anggota" (Task 10)`
- **Base:** `58649aa`
- **Suite:** 779 → **808 pass, 0 fail** (20.3 s, 47 files). `bun run typecheck` clean. Working tree clean.

---

## 1. What was built

| File | |
|---|---|
| `apps/web/src/user/MembershipOffer.tsx` | **new** — the offer and the button |
| `apps/web/src/user/MembershipOffer.test.tsx` | **new** — 13 tests |
| `apps/web/src/user/tierCopy.ts` | **new** — `billingCycleLabel`, shared with Pengaturan's editor |
| `apps/web/src/user/apiClient.ts` | `TierView`, `MembershipView`, `PublicUserProfile.membership`, `startSubscription`, `isOwnHandle` |
| `apps/web/src/user/errorCopy.ts` | `describeSubscribeFailure` |
| `apps/web/src/user/ProfilePage.tsx` | mounts the offer under the counts |
| `apps/web/src/user/FollowButton.tsx` | own-profile check now goes through the shared `isOwnHandle` |
| `apps/web/src/user/MembershipSettings.tsx` | imports the shared `billingCycleLabel` instead of its own copy |
| `apps/web/src/styles.css` | `.membership-offer` / `.membership-tier` |
| tests in `ProfilePage.test.tsx` (+3), `apiClient.test.ts` (+8), `errorCopy.test.ts` (+5) | |

The component takes exactly `{ handle, tiers }` and decides **for itself** whether to render at all —
the same division `FollowButton` uses, and for the same reason: the API deliberately emits no
self-signal, so a screen that trusted the payload alone would offer an action the server answers 409 to.

## 2. The red phase

Stubs first (`MembershipOffer` returning `null`, `startSubscription` rejecting, `isOwnHandle` returning
`false`, `describeSubscribeFailure` returning `""`), so every file LOADED and each test failed on its own
assertion. `bun test src/user/MembershipOffer.test.tsx src/user/errorCopy.test.ts`:

```
 25 pass
 14 fail
 80 expect() calls
Ran 39 tests across 2 files. [1092.00ms]
```

The ten component failures, by name:

```
(fail) what a creator is selling > shows every active tier with its price the way an Indonesian reads rupiah
(fail) what a creator is selling > passes an unknown billing cycle through instead of hiding it
(fail) a signed-out visitor goes to Masuk > offers Masuk instead of the buy button, and reaches Masuk carrying the profile to return to
(fail) pressing Jadi anggota > POSTs the chosen tier to /users/:handle/subscribe and follows the invoice url
(fail) pressing Jadi anggota > sends ONE request for a double tap, and says what it is doing while it waits
(fail) your own profile never offers you your own membership > offers that same tier to a different signed-in viewer
(fail) a failure is a Bahasa sentence > says the purchase could not be started, in Bahasa, for a 500
(fail) a failure is a Bahasa sentence > tells a 409 to reload the profile rather than to try again
(fail) a failure is a Bahasa sentence > says Bahasa for a dropped connection too, never the browser's 'Failed to fetch'
(fail) a failure is a Bahasa sentence > sends a buyer whose session expired mid-purchase to Masuk, carrying the profile to return to
```

plus the four `describeSubscribeFailure` cases (`Received: ""` against each literal).

**Three tests passed against the stub, and that is inherent, not an oversight:** the two "renders nothing
at all" cases and the own-profile case assert *absence*, which a component rendering `null` satisfies. Each
is paired with a **presence control** in the same describe block (the ones that failed above), and the
mutation sweep in §6 shows both directions redden.

**Disclosure:** I ran the red phase on those two files only. The `ProfilePage` (+3) and `apiClient` (+8)
additions were written in the same batch but first executed after the implementation landed, so their
falsifiability is evidenced by the mutation sweep (M2, M5, M8, M10, M11, M12) rather than by a red run.

## 3. How a signed-out visitor is routed

They never get a button. The row renders `<Link to="/masuk" state={{ from: "/@handle" }}>Masuk untuk jadi
anggota</Link>` — the shape `FollowButton` already uses for "Masuk untuk mengikuti", and the `from` state
`LoginPage` already reads, so signing in returns them to the profile they were standing on instead of
dropping them on Beranda.

The test clicks the link with `fetch` mocked to a recorder and asserts **`calls.length === 0`**: spec §6
says buying is signed-in only, and this is routed *before* any request, never after a 401.

The other half of the same rule is the **401 mid-purchase** (a token that expired while the page was
open): `apiRequest` has already cleared the session by the time the `catch` runs, so the component
navigates to `/masuk` with the same `from` state instead of printing a sentence — the call `FollowButton`
makes for the same status, to the same place.

## 4. What an existing member sees — **the one requirement I could not meet, and why**

> "Someone who already has an active membership sees that they are a member, not a buy button."

**Nothing on the wire says who is a member.** I checked all four places it could come from:

- `GET /users/by-handle/:handle` — `membership` is closed to `{ tiers: [{ id, name, priceAmount,
  billingCycle }] }` (Task 5's own brief: *"The projection is closed"*), and `users.test.ts:368` pins
  `Object.keys(body).sort()`. **No viewer-specific field.**
- `IsMemberOf` (Task 8) exists and is correct — and is **wired to no route**. `grep -rn "isMemberOf"
  apps/api/src/routes` is empty; Phase 6 is its first caller.
- There is **no endpoint** that lists a viewer's own subscriptions (`GET /users/me/tiers` is the owner's
  management view).
- After paying, Xendit returns the buyer to this same profile (`StartUserSubscription.profileUrl`), so the
  screen that most needs to know is the one that cannot.

Your brief says **"Work in `apps/web`"**, and the server is built and reviewed. Meeting this requirement
means widening the API (`MembershipView` + a fourth dependency on `GetUserProfile` + `bootstrap` + the
pinned wire-shape tests), which is outside that instruction — so I did not do it, and I did not fake it
either. **A `viewerIsMember` field the server never sends would have been dead code no test could redden.**

**What a member gets today instead:** the buy button, a 409 from `StartUserSubscription` — which **never
charges them**, the refusal is before any invoice — and `describeSubscribeFailure`'s sentence, which names
an existing membership as *one* of the reasons rather than claiming to have identified it. This is
recorded in `MembershipOffer`'s own docstring so the gap is visible from the code, not only from here.

**If you want it closed, the smallest honest change is server-side** and I can do it on your word:
`membership: { tiers, viewerIsMember }`, filled by the `IsMemberOf` that already exists, `false` for a
signed-out viewer. That is ~15 lines plus the three pinned assertions in `users.test.ts` — and it is what
Phase 6 will need anyway. Note it also decides §9's honesty question for you: `IsMemberOf` already
requires `current_period_end > now()`, so a **lapsed** member reads as `false` and sees the offer again,
which is right — 5a has no renewal endpoint, and I built no renew affordance.

## 5. Keeping DOM nodes out of failing assertions

No node is on either side of an assertion that can fail, in any file I touched.

- Absence is always a **count**: `document.querySelectorAll(".membership-offer").length`,
  `screen.queryAllByRole("button", …).length`, `screen.queryAllByText(…).length`.
- "Nothing at all" is asserted as **`document.body.textContent` → `""`** — a string, not a node, and
  stronger than any per-element count.
- Every content assertion reads `.textContent` off an element the query already found, so the value in the
  diff is a string.
- `expect(screen.getByRole(…)).toBeTruthy()` appears only where `getByRole` **throws** when absent, so the
  matcher can never receive a node and fail — the codebase's existing convention.
- I ran no mutation that could put a node in a diff.
- `src/test/no-hanging-dom-assertions.test.ts` and `src/test/no-raw-server-errors.test.ts` are green.

One live scare worth recording: the first full-suite run **exceeded 120 s and was auto-backgrounded**,
with `bun test` at 469 MB RSS and climbing on a machine with no swap. I killed it at once. **It was not a
hanging assertion** — it was `App.test.tsx` crashing inside `<ProfilePage>` (§7's `membership` read) and
poisoning the files that ran after it. Split runs finished in 3–11 s each and named the real cause.

## 6. Mutation sweep (after the commit)

Twelve mutants, each applied to source only, `bun test src/user src/test`, then reverted. **All twelve
caught:**

| | mutant | result |
|---|---|---|
| M1 | the alert prints `(err as Error).message` instead of `errorCopy` | 4 fail (3 of them in `MembershipOffer.test.tsx` alone — verified separately) |
| M2 | `isOwnHandle` always `false` | 11 fail |
| M3 | an empty offer renders the box anyway | 3 fail |
| M4 | a signed-out visitor gets the buy button | 1 fail |
| M5 | every button buys `tiers[0]` | 1 fail |
| M6 | the invoice url is never followed | 2 fail |
| M7 | the 409 falls through to "Coba lagi" | 2 fail |
| M8 | asymmetric handle comparison (only one side normalised) | 3 fail |
| M9 | the 401 shows a sentence instead of routing to Masuk | 1 fail |
| M10 | `ProfilePage` never mounts the offer | 1 fail |
| M11 | `startSubscription` sends no tier | 2 fail |
| M12 | `profile.membership.tiers` read without tolerance | 36 fail |

M1 is the one your brief singled out. **It reddens from the component tests alone**, not only from the
`no-raw-server-errors` guard: every error-path test asserts the alert's `textContent` in both directions
(contains my Bahasa sentence, does **not** contain the server's), including the 409 whose wire text is
itself Bahasa — the most tempting place in the app to print what the server sent.

## 7. Judgement calls the thin brief left open

1. **`membership?.tiers ?? []` in `ProfilePage`, despite the field being required.** Not a state branch —
   absent and empty mean the same thing, "no offer". It is the blast radius: a bare read **throws during
   render**, and measured against `App.test.tsx`'s own minimal profile fixtures that blanked the *entire*
   page (name, bio, counts, feed) for a missing offer. A rolling deploy that ships the web before the API
   is exactly that response, and `toMembershipView`'s docstring records the white screen Phase 4 shipped
   from this shape. A dedicated regression test pins it; M12 shows it reddens.
2. **`isOwnHandle` moved into `apiClient` and `FollowButton` refactored onto it.** Two screens must now
   vanish on your own profile for the same reason. `FollowButton`'s own docstring records an
   asymmetric-`.toLowerCase()` bug that survived every test; a second copy in `MembershipOffer` is how
   that comes back. This touches a file outside the brief's list — deliberate, and M8 covers it.
3. **`billingCycleLabel` moved to `tierCopy.ts`,** shared with `MembershipSettings`. Same reasoning: the
   editor and the offer render the *same rows*, and two copies drifting apart is a defect no test notices.
   Output identical; Task 9's tests are untouched and green.
4. **`describeSubscribeFailure` added to `errorCopy.ts`.** `describeRequestFailure` answers every 4xx
   "Permintaan tidak dapat diproses. **Coba lagi.**" — wrong here, because this route's 409 covers *five*
   refusals a retry cannot fix (self-purchase, withdrawn tier, creator not payout-ready, active
   membership, live pending invoice) and carries **no `code`** to branch on. So the copy names what a
   person can *do* — reload the profile, which re-reads `membership.tiers` — rather than guessing which of
   the five it was. That is `describeUploadFailure`'s own recorded ruling: vague is honest, confidently
   wrong is not.
5. **Where the offer sits:** under the follower/following counts, above the feed. It is part of who this
   person is, not part of what they posted.
6. **Copy.** Heading "Keanggotaan"; the button is spec §6's exact "Jadi anggota"; the intro is
   *"Dukung @handle dengan menjadi anggota berbayar."* — deliberately promising **no** perks, because in
   5a a membership grants nothing yet (Phase 6 is what gates content) and §9 says to stay honest.
7. **Per-tier accessible names.** Visible text stays "Jadi anggota"; `aria-label` is `Jadi anggota —
   {tier.name}` (and `Menyiapkan pembayaran — {name}` while in flight). Three identical "Jadi anggota"
   buttons tell a screen-reader user nothing about which membership they are buying.
8. **The button stays disabled after a successful redirect,** and is only re-enabled in the `catch`. The
   browser is leaving for the provider; re-enabling during that gap invites a second tap. The server
   survives one either way (`resolveExistingCheckout` hands back the same invoice) — that is the backstop,
   not the plan.
9. **`window.location.href`, not the router.** The invoice is off-app. Same call `CheckoutPage` makes; the
   test records assignments rather than silencing them.
10. **No renew affordance, no "was a member" state** — §9. There is no endpoint behind either.
11. **`FollowButton.test.tsx:233`** — the blind exact-string negative the review flagged — is **left
    alone**. `progress.md` defers it to the final review, and I touched `FollowButton.tsx` only for the
    `isOwnHandle` refactor.

## 8. Verification

```
bun test          → 808 pass, 0 fail, 1883 expect() calls, 47 files, 20.30s
bun run typecheck → clean
git status        → clean
```

---

# Fix round 1 — `viewerIsMember` (scope widened to the API)

**Commit:** `6a4a0b9` — `feat: a profile says whether the viewer is already a member (Task 10 fix round 1)`.
Base `a5e788d`. §4's gap above is closed; everything else in this report stands.

## The projection's new shape

`GET /users/by-handle/:handle` → `membership` is now **exactly two keys**:

```json
"membership": { "tiers": [ { "id": "...", "name": "...", "priceAmount": 50000, "billingCycle": "monthly" } ],
                "viewerIsMember": false }
```

Closed, and **updated deliberately rather than loosened**. Three pinned assertions moved with it —
`routes/users.test.ts`'s top-level `Object.keys(body).sort()` test and the two `toEqual({ tiers: [] })`
assertions — and `membership` gained a closed-projection assertion of its own
(`Object.keys(body.membership).sort() → ["tiers", "viewerIsMember"]`), which Task 5 had only for a *tier*.
The per-tier projection is untouched: still `billingCycle/id/name/priceAmount`.

Nothing else was added. `viewerIsMember` is the first field on this public endpoint that is about the
**caller** rather than the creator being viewed, and `MembershipView`'s docstring now says so, naming the
neighbours it must not grow (a period end, a tier id, a subscription id would each be a new disclosure).

**It is `IsMemberOf`, not a re-derivation of it.** `GetUserProfile` takes the use-case as its fourth
dependency rather than reaching for a subscription repository, because the half a copy would lose is
`current_period_end > now`. `bootstrap` constructs it unconditionally — it does not depend on a payment
provider — which meant moving `clock` and `userSubscriptionRepository` above `getUserProfile`; both are
still single instances, and their other consumers are further down and unaffected.

## What a signed-out visitor gets: `false`, never `null`, and no query at all

The anonymous branch **short-circuits**: `viewerId === null` resolves `false` without asking the database.
This route is public and most of its traffic has no session.

This deliberately disagrees with its neighbour `viewerFollows`, which is tri-state on the very same
payload, and the reasoning is written into both `MembershipView` docstrings:

- `viewerFollows` **drives a toggle** whose three values are three different controls (a link to Masuk,
  "Ikuti", "Mengikuti"). Collapsing `null` to `false` there offers an anonymous visitor a button that
  cannot work — the exact defect that field's docstring exists to prevent.
- `viewerIsMember` **gates a claim the page makes about the caller** — "Anda sudah menjadi anggota". For
  somebody the server cannot identify, the only safe answer is *no*. A tri-state would invite a client to
  write `!== false` and tell a stranger they hold somebody's membership.

Nothing is lost: the web already knows whether it has a session, and renders "Masuk untuk jadi anggota"
from its own token, never from this field. Pinned in three places — an anonymous request while a live
membership for somebody else exists in the table, a garbage bearer token (200 and `false`, never a 401),
and a client-side test that a signed-out browser handed `true` still shows the Masuk link.

## The lapsed subscription, and its mutation evidence

§9: 5a has no renewal pass, so **nothing ever moves a subscription out of `active` when its period ends**
— a row sits at `status = 'active'` with `current_period_end` in the past, forever. A status-only check
would call that person a member for life and never offer them the membership again.

Pinned at **both levels**:

- `get-user-profile.test.ts` — the real `IsMemberOf` over a fake repository and a `FixedClock`, with the
  period end placed before "now". The unit fake deliberately constructs the **real** use-case rather than
  a stub, so this file cannot agree that somebody is a member while `IsMemberOf` disagrees.
- `routes/users.test.ts` — through HTTP, against a real database: a seeded `active` subscription with
  `current_period_end` in 2020, read back with the member's own bearer token. It also **guards the
  fixture** (`status === "active"`, `currentPeriodEnd === PAST`) so the test cannot pass for the wrong
  reason if a repository ever started expiring rows.

Mutation: `IsMemberOf`'s period comparison replaced by `return true` — i.e. the "simplified to a status
check" regression — with the run restricted to the files this round added:

```
(fail) GET /users/by-handle/:handle — viewerIsMember (Task 10) > is FALSE for a LAPSED membership — the row is still 'active', its period is not
(fail) GetUserProfile.execute — viewerIsMember (Task 10) > is FALSE for a lapsed membership — status is still active, the period is not
```

Eight mutants in total, **all caught**:

| | mutant | result |
|---|---|---|
| N1 | `IsMemberOf` drops the period check (status only) | 2 fail — the two lapsed tests above |
| N2 | `viewerIsMember` hard-coded `false` | 2 fail |
| N3 | anonymous answered `null` instead of `false` | 8 fail |
| N4 | `viewerIsMember` dropped from the projection | 13 fail |
| N5 | the web ignores `viewerIsMember` | 3 fail |
| N6 | the web claims membership for a signed-out visitor | 1 fail |
| N7 | the member panel shadowed by the empty-tier check | 1 fail |
| N8 | `ProfilePage` defaults the flag to `true` on deploy skew | 1 fail |

## What a member now sees

"Anda sudah menjadi anggota @handle", and **no button** — including when the creator has since withdrawn
every tier, which is why the member branch is checked *before* the empty-tier return: `PATCH
/users/me/tiers/:id` deactivates and never deletes, precisely so an existing subscription keeps
resolving, and that person is still a member (N7 pins it).

Own-profile still renders **nothing at all**, member flag or not. **No renew affordance anywhere** — a
lapsed member reads `false` and is offered the tier again, a fresh purchase, which is the only thing 5a
has an endpoint for.

Error paths are unchanged and still assert the alert's `textContent` in **both** directions. No DOM node
reaches any assertion that can fail; absence is a count or `document.body.textContent === ""`.

## Test counts and state

| | before | after |
|---|---|---|
| `apps/api` | 2381 pass (Task 8 left 2380, +1 from `b574236`) | **2395 pass / 0 fail**, 154 files, 288 s |
| `apps/web` | 808 pass | **814 pass / 0 fail**, 47 files, 20.2 s |

+14 API tests (2 `tier-views`, 5 `get-user-profile`, 7 `routes/users`), +6 web tests. Both `bun run
typecheck` runs clean. **`git status` is clean**; every mutation above was reverted with `git checkout`
and re-verified.
