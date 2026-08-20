# Task 10 fix round 1 — re-review

Scope: `a5e788d..6a4a0b9` (`feat: a profile says whether the viewer is already a member (Task 10 fix round 1)`),
against the spec's §6 requirement that an already-active member sees they are a member, not a buy button,
and §9's honest-limitation rule that a lapsed subscription (`status='active'`, `current_period_end` in the
past) must read as "not a member."

## Verdict: ADDRESSED

All four required checks passed, verified independently (not by re-reading the implementer's report),
by applying the named regressions to source and confirming the named tests — and only those tests —
redden, then reverting every mutation.

## 1. The lapsed case

`IsMemberOf.execute`'s period comparison (`apps/api/src/application/use-cases/is-member-of.ts:54`,
`return active.currentPeriodEnd.getTime() > this.clock.now().getTime();`) really does gate the answer.
Mutated to `return true;` and ran:

- `apps/api/src/application/use-cases/get-user-profile.test.ts` — **1 fail**, exactly:
  `GetUserProfile.execute — viewerIsMember (Task 10) > is FALSE for a lapsed membership — status is still
  active, the period is not`
- `apps/api/src/routes/users.test.ts` — **1 fail**, exactly:
  `GET /users/by-handle/:handle — viewerIsMember (Task 10) > is FALSE for a LAPSED membership — the row is
  still 'active', its period is not`

Both match the implementer's own claim exactly — no other test in either file moved. Reverted with
`git checkout --`.

The HTTP test seeds the subscription directly through `DrizzleUserSubscriptionRepository` (never through a
fake Xendit invoice — correct, since what activates a subscription in production is the webhook, not this
endpoint), and it guards the fixture before trusting it:

```ts
const stored = await new DrizzleUserSubscriptionRepository(db).findById(subscription.id);
expect(stored?.status).toBe("active");
expect(stored?.currentPeriodEnd?.toISOString()).toBe(PAST.toISOString());
```

So the test cannot pass because a repository silently expired the row instead of `IsMemberOf` doing its
job — it genuinely proves the period comparison, not an artifact of the seed.

## 2. The projection stayed CLOSED

Mutated `toTierView` to add `ownerId` to each tier: reddened the exact-array assertions in
`tier-views.test.ts`, `get-user-profile.test.ts` ("EXACTLY id/name/priceAmount/billingCycle... never
ownerId") — **4 fails**, all `toEqual`/sorted-array comparisons, none loosened to `toContain`. Reverted.

Mutated `toMembershipView` to add a third key (`tierCount`) to the `MembershipView` object itself:
reddened at all three levels —
- `tier-views.test.ts`: `carries viewerIsMember through, both ways, and adds nothing else to the projection`
- `get-user-profile.test.ts`: the top-level `Object.keys(profile).sort()` exact match, and the
  `{ tiers: [], viewerIsMember: false }` exact-object match
- `routes/users.test.ts`: `membership itself is CLOSED — exactly tiers and viewerIsMember, nothing else`
  (`Object.keys(body.membership).sort()`)

**4 fails total**, all exact-key/exact-object assertions (`toEqual` on a sorted key array or the whole
literal object) — none use `toContain` or a partial match. The existing `{ tiers: [] }` assertions in
`get-user-profile.test.ts` and `routes/users.test.ts` were genuinely updated to
`{ tiers: [], viewerIsMember: false }`, not loosened. Reverted; `git status` clean after each mutation.

## 3. Signed-out is `false`, never `null` or absent

Confirmed by code, not just test names:

- `apps/http/user-auth.middleware.ts`'s `resolveViewerId` collapses every failure mode — no header,
  non-Bearer scheme, bad/expired signature, stale epoch — to `null`, with no distinction (docstring at
  line ~19-23). It never throws.
- `GetUserProfile.execute` (`get-user-profile.ts:561`):
  `viewerId === null ? Promise.resolve(false) : this.membership.execute(viewerId, user.id)` — the
  anonymous branch resolves `false` **without calling `IsMemberOf` or touching the database at all**. This
  is a genuine short-circuit, not a same-cost call that happens to answer `false`.
- HTTP-level tests cover no token, a garbage token (`headers: authed("garbage")`, asserted `200` with
  `viewerIsMember: false`, never `401`), and — via the same `resolveViewerId` code path — an expired
  token, since both degrade identically to `null`.
- `MembershipOffer.tsx`'s member panel is gated on `viewerIsMember && signedIn`, where `signedIn` reads
  the browser's own local session (`isUserSignedIn()`), not the server's claim. The web test "never claims
  a membership for a visitor with no session" hands the component `viewerIsMember={true}` with no local
  session and asserts the Masuk link renders instead — passing in the full suite run below.

## 4. `IsMemberOf` is genuinely on the request path

`routes/users.ts`'s `GET /users/by-handle/:handle` calls `deps.getUserProfile.execute(handle, viewerId)`,
and `GetUserProfile` calls `this.membership.execute(viewerId, user.id)` where `this.membership` is the
`IsMemberOf` instance injected as the fourth constructor argument — not a re-derived subscription query
written locally.

`bootstrap.ts`: `isMemberOf = new IsMemberOf(userSubscriptionRepository, clock)` (line ~1885) is
constructed unconditionally, above and outside the `payments ? ... : undefined` block that gates
`startCheckout`/`startUserSubscription`. A profile read does not require a payment provider to be
configured.

## Also checked

- **Member branch before the empty-tier return**: `MembershipOffer.tsx` checks
  `if (viewerIsMember && signedIn) { ...member panel... }` strictly before `if (tiers.length === 0) return
  null;`. A dedicated test ("still says so when the creator has withdrawn every tier") and the
  implementer's mutation N7 both cover this; confirmed present and passing.
- **No new breakage, web**: full `apps/web` suite — **814 pass, 0 fail**, 47 files, 20.13 s. Matches the
  report's claimed count exactly.
- **No new breakage, api**: full `apps/api` suite — **2395 pass, 0 fail**, 154 files, 296.33 s. Matches
  the report's claimed count exactly. Console noise from `[gating]`/`[churn]`/`[renewals]` lines is other
  suites' own expected-failure-path logging (fake messaging/payment providers deliberately erroring),
  not test failures.
- **Hazard guards green**: `src/test/no-hanging-dom-assertions.test.ts` and
  `src/test/no-raw-server-errors.test.ts` — 9 pass, 0 fail together.
- **Bahasa copy**: "Anda sudah menjadi anggota @{handle}." — plain Bahasa, no raw server text.
- **Error-path tests assert `textContent` in both directions**: unchanged from Task 10's original round;
  still true (verified in the diff, no error-path logic touched by this round beyond the new member
  branch, which has its own dedicated assertions rather than reusing the error-path ones).
- **Tests assert literal values, not the constants they check**: the Bahasa string
  "Anda sudah menjadi anggota" is a literal in every test file, never imported from the component; date
  fixtures (`FUTURE`/`PAST`) are inputs to the scenario, not the value under assertion.

## Tree state

`git status` clean before, during (after each mutation reverted via `git checkout --`), and after this
review. No files added, no `.superpowers/` changes force-added.
