# Phase 5a — scoped re-review of the final fix wave

- Worktree `/home/wildandev/repo/diudara/.worktrees/memberships`, branch `feat/memberships`.
- Scope: `review-9c740ba..07ee7ae.diff` — one commit, `07ee7ae`, 21 files, 1180 insertions / 195 deletions.
- Inputs read in full before anything was run: `final-review.md`, `final-fix-report.md`, spec §8/§9.

## Verdict

| finding | verdict |
|---|---|
| **I1** — a lapsed member offered the tier, then refused it, in a loop that could not end | **ADDRESSED** |
| **I2** — one failed statement wedged a buyer out permanently, and called it temporary | **ADDRESSED** |
| **M1** — `errorCopy.ts` enumerated five 409s | **ADDRESSED** (there are seven; I counted them) |
| **M2** — the gate checklist's cleanup SQL could not run | **ADDRESSED** (executed, read out of the markdown) |
| `ArrivalLatch` comments | **Comment-only, confirmed.** `markPastDue`'s behaviour is unchanged |

**The purchase guard was left alone.** No new breakage found.

### Baseline re-established on this machine, at `07ee7ae`

| suite | result |
|---|---|
| `apps/api` | **2410 pass / 0 fail** (296 s, 154 files) |
| `apps/web` | **823 pass / 0 fail** (20 s, 47 files) |
| `packages/shared` | 85 / 0 |
| `apps/worker` | 52 / 0 |
| `bun run typecheck` (four workspaces) | exit 0 |
| `no-raw-server-errors` + `no-hanging-dom-assertions` | 9 / 0, run again on their own |

---

## I1 — ADDRESSED

### The claim that matters: is the contradictory state unrepresentable?

**By construction of the single producer — yes. By the type — no.** Both halves measured, not read.

**The type does not forbid it.** `MembershipView` is an interface with two independent `boolean`
fields. I compiled a hand-built literal against it:

```ts
// apps/api/src/__zz_probe.ts (temporary)
export const contradictory: MembershipView = {
  tiers: [], viewerIsMember: true, viewerMembershipEnded: true,
};
```

`bun run typecheck` → **exit 0**, all four workspaces. So the fixer's phrase "unrepresentable rather
than merely unlikely" is true of the *production path*, not of the type. The probe file was deleted;
`git status --short` empty afterwards.

**The production path genuinely cannot produce it.**

- `toMembershipView` is the **only** producer of a `MembershipView` anywhere in `apps/api/src` —
  production *and* tests. Grepped both ways (`grep -rn "MembershipView"` and
  `grep -rn "toMembershipView"`): every construction site is that function or a call to it. No test
  hand-builds one, which is what would have made this a convention rather than a fact.
- Its second parameter is `MembershipStanding`, a three-value union with **no default**. Both booleans
  are derived in the same return expression, so both-true would require
  `standing === "member" && standing === "lapsed"`. The union forbids it.
- `GetUserProfile` computes the standing **once**, as one element of one `Promise.all`, from one
  `IsMemberOf.describe` call on one indexed read (`findActiveFor`). **There is no partial-failure
  path**: if `describe` rejects, the whole `Promise.all` rejects and no profile is returned at all.
  The two booleans are never computed independently, so they cannot half-fail into disagreement.
- The anonymous short-circuit is `Promise.resolve<MembershipStanding>("none")` — one value, projecting
  as `false`/`false`, so even the branch that never touches the database goes through the same union.

**On the wire and in the browser it is representable, and handled.** `apps/web`'s own
`MembershipView` declares two independent booleans and validates nothing, so a hand-built response, a
proxy, or a skewed deploy can carry both `true`. `MembershipOffer` orders its branches
`viewerIsMember` first (`MembershipOffer.tsx:130`, then `:150`), so both-true renders the member
panel and **no button** — the loop still cannot form. `apiClient.ts`'s "Never both `true`" is
correctly written as a statement about what the API projects, not as a client-side invariant.

**So: stronger than "the tests don't do it", weaker than "the type makes it impossible."** The union
type does the work *inside* the sole producer; the interface at the boundary would accept the pair.

### Mutation — collapse the two sentences into one

Applied to `start-user-subscription.ts` (the ternary replaced by the single already-active message),
nothing else touched:

```
bun test src/application/use-cases/start-user-subscription.test.ts   →  27 pass / 4 fail
  (fail) a LAPSED membership is refused with the truth > tells a lapsed member their membership ENDED and that renewal is not available
  (fail) a LAPSED membership is refused with the truth > the lapsed sentence and the already-active sentence are not the same sentence
  (fail) a LAPSED membership is refused with the truth > the BOUNDARY: a period ending exactly now has ended — `>` , not `>=`
  (fail) a LAPSED membership is refused with the truth > an `active` row with NO period end is treated as ended, never as a live membership

bun test src/routes/users.test.ts                                    →  145 pass / 1 fail
  (fail) POST /users/:handle/subscribe (Task 6) > a LAPSED member is refused with a sentence about their membership ENDING, not about being active
```

The route-level pin reddens too, against the real database — the fixer's report only listed the
use-case level for this mutant, so the HTTP pin is an extra, and it holds. Reverted; tree clean.

### Mutation — `viewerMembershipEnded: false` always

```
bun test tier-views.test.ts get-user-profile.test.ts   →  22 pass / 3 fail
  (fail) toMembershipView > a LAPSED standing is not a member, and is not the same as a stranger
  (fail) GetUserProfile.execute — viewerIsMember (Task 10) > is FALSE for a lapsed membership — status is still active, the period is not
  (fail) GetUserProfile.execute — viewerIsMember (Task 10) > distinguishes a stranger from a lapsed member — both are non-members, only one may buy
```

Exactly the three the fixer reported. Reverted.

### Mutation — delete the lapsed branch from `MembershipOffer.tsx`

```
bun test MembershipOffer.test.tsx ProfilePage.test.tsx  →  54 pass / 3 fail
  (fail) MembershipOffer — somebody whose membership has ENDED > says the membership ended and that renewal is not available, with no way to buy
  (fail) MembershipOffer — somebody whose membership has ENDED > still says so when the creator has withdrawn every tier
  (fail) ProfilePage — the membership offer (Task 10) > tells somebody whose membership ended that it ended, instead of offering the button
```

Exactly the three reported. Reverted.

### The offer does not render, and no retry advice remains on that path

Read directly at `MembershipOffer.tsx:150-163`: the ended branch returns a `<section>` with one
`<p data-testid="membership-ended">` and **nothing else** — no button, not even a disabled one, and
the branch sits *before* the `tiers.length === 0` return (so a creator who withdrew every tier still
owes the news) and *after* `isOwnHandle` (so your own profile still renders nothing). The named test
asserts `screen.queryAllByRole("button").length === 0` and
`queryAllByTestId("membership-tier-tier-1").length === 0` — counts, no DOM node in any assertion.

Retry advice on that path: **none.** The ended panel calls nothing in `errorCopy.ts`. The 409's own
sentence contains neither "coba lagi" nor "Muat ulang" (pinned by name in the third lapsed test).
`describeSubscribeFailure`'s copy — reachable only from a page that predates the field — still names
a reload, but for what it now does: the reloaded profile carries `viewerMembershipEnded` and renders
the ended panel, so the loop terminates. That termination is pinned end to end in
`routes/users.test.ts`, where the same run asserts the 409 sentence, `status='active'` with a 2020
period on the stored row, and `viewerIsMember: false, viewerMembershipEnded: true` on the profile.

### The purchase guard was NOT narrowed

Confirmed three ways.

1. `start-user-subscription.ts:184` still reads
   `const existing = await this.subscriptions.findActiveFor(input.subscriberId, owner.id)` and
   `if (existing)` refuses **unconditionally**. `membershipStanding(...)` appears only *inside* the
   `throw`, choosing between two sentences.
2. The non-comment diff of that file over `9c740ba..07ee7ae` shows the guard's condition unchanged;
   the only change at that site is `"…"` becoming `standing === "member" ? "…" : "…"`.
3. `findActiveFor` / `activeMembershipQuery`
   (`drizzle-user-subscription.repository.ts:151-171`) is untouched by the diff and is still
   `status = 'active'` with no `current_period_end` predicate.

`IsMemberOf.execute`'s semantics are also byte-for-byte preserved: old
`!active || currentPeriodEnd === null → false; else currentPeriodEnd > now` is exactly
`membershipStanding(...) === "member"`. Phase 6's gate did not move.

`bootstrap.ts` passes the **same `SystemClock` instance** (`const clock` at `:1869`) that
`IsMemberOf` at `:1885` reads, so the two cannot disagree about the instant.

---

## I2 — ADDRESSED

### Independent failure injection at each statement

Not the fixer's tests — my own temporary file, deleted afterwards, driving the **real HTTP route
against the real (isolated, migrated) database**, injecting one rejection into a
`DrizzleUserSubscriptionRepository` instance (and, for the provider, into the `FakePaymentAdapter`)
wired behind the production `StartUserSubscription`. No file under `src` was modified.

| injected at | attempt 1 | claim after | attempt 2 | rows | `findPendingCheckout` | attempt 3 |
|---|---|---|---|---|---|---|
| `claimPending` | 500 | nothing claimed | **201** | `["pending"]` | found | same invoice |
| `createTransaction` | 500 | released → `cancelled` | **201** | `["cancelled","pending"]` | found | same invoice |
| `createInvoice` | 500 | released → `cancelled` | **201** | `["cancelled","pending"]` | — | — |
| `attachGatewayReference` | 500 | released → `cancelled` | **201** | `["cancelled","pending"]` | found | same invoice |

Every attempt 2 was asserted `not.toBe(TRANSIENT)` against the literal
`"Pembayaran Anda sedang disiapkan. Tunggu sebentar, lalu coba lagi — …"` and asserted to carry a
string `invoiceUrl`; attempt 3 was asserted to hand back the *same* url, which is what
`findPendingCheckout → null forever` meant it could not. `4 pass / 0 fail`.

At `attachGatewayReference` the provider ends with **2 invoices** and the first has no gateway
reference in our records — the residue round 2 already accepted, and the same class as the review's
own M5 (`settleUserSubscription` fails closed on it). Strictly better than a buyer who can never pay.

`claimPending` sits *outside* the `try`, correctly: there is no claim to release, and the injection
confirms nothing is left behind. The one gap it cannot close is the ledger's existing carried item —
an INSERT that commits and then loses its connection before returning leaves a pending row whose id
we never learned. Unchanged by this wave, still 5b's.

### My injections are load-bearing

Re-narrowed the release to round 2's scope (release only when the provider call was what failed) and
re-ran my own file:

```
[inject:claimPending]            attempt1=500 attempt2=201    (pass — nothing to release)
[inject:createTransaction]       attempt1=500 attempt2=409 "Pembayaran Anda sedang disiapkan…"  (FAIL)
[inject:attachGatewayReference]  attempt1=500 attempt2=409 "Pembayaran Anda sedang disiapkan…"  (FAIL)
[inject:createInvoice]           attempt1=500 attempt2=409                                       (FAIL)
1 pass / 3 fail
```

That reproduces the final review's measurement exactly — attempt 1 a 500, attempt 2 the transient
409 that can never come true.

### Mutation — narrow the release back to round 2's scope

Structural, not message-sniffing: `createTransaction` moved out of the `try`, the `try` closed around
`payments.createInvoice` alone, `attachGatewayReference` and the `return` moved after it.

```
bun test src/application/use-cases/start-user-subscription.test.ts   →  27 pass / 4 fail
  (fail) every statement between the claim and the invoice reference releases it > createTransaction: the claim is released, and the retry succeeds
  (fail) …                                                                      > attachGatewayReference: the claim is released, and the retry succeeds
  (fail) …                                                                      > NONE of the three leaves the buyer stuck on the transient refusal
  (fail) …                                                                      > a release that itself fails does not replace the original error, and warns

bun test src/routes/users.test.ts                                    →  144 pass / 2 fail
  (fail) POST /users/:handle/subscribe (Task 6) > a dropped createTransaction releases the claim, and the very next attempt succeeds
  (fail) POST /users/:handle/subscribe (Task 6) > a dropped attachGatewayReference releases the claim, and the very next attempt succeeds
```

**4 + 2, exactly as the fixer reported.** Reverted; tree byte-identical.

### The swallowed-release path

`releaseClaim` (`:404-419`) wraps only `this.subscriptions.cancel(...)` in a bare `try`/`catch {}`
and falls through to the same `console.warn` whether `cancel` returned `null` or threw. The caller's
`catch (err) { await this.releaseClaim(...); throw err; }` rethrows the **original**. The old code
awaited `cancel` unguarded inside the catch, so a failing `cancel` replaced the real reason — that is
now closed, and it is one of the four tests that redden under the narrowing mutant. The warning
carries ids only, never the payer's details.

---

## M1 — ADDRESSED. There are seven, and I counted them

`grep -n "ConflictError(" start-user-subscription.ts` gives six call sites, one of which (`:205`) is
a ternary emitting two distinct sentences:

| # | line | refusal |
|---|---|---|
| 1 | `:124` | subscribing to yourself |
| 2 | `:141` | the tier is deactivated |
| 3 | `:162` | the creator's payout account is not connected |
| 4 | `:205` (then) | already holds a LIVE membership |
| 5 | `:205` (else) | membership has ENDED, no renewal in 5a |
| 6 | `:370` | a pending checkout is open against a DIFFERENT tier |
| 7 | `:376` | a pending checkout is being prepared — **the transient one** |

Seven. The route (`routes/users.ts:503-524`) adds no 409 of its own — its other failure modes are
503, 400 and 401 — so `StartUserSubscription` is the complete source. The docstring enumerates all
seven one per line and marks (7) as "**the only one where pressing the button again works**".

Mutation — restore the old 409 copy:

```
bun test src/user/errorCopy.test.ts  →  25 pass / 2 fail
  (fail) describeSubscribeFailure > answers a 409 with a remedy that is not 'try again'
  (fail) describeSubscribeFailure > promises no fresh offer, and does not tell the buyer to press the button again
```

Both named failures match the fixer's report. Both tests assert literals — the full sentence, and
`.includes(...)` against string constants. Reverted.

---

## M2 — ADDRESSED. I executed the SQL myself, read out of the markdown

Temporary test file under `apps/api/src` (so it inherited the per-run isolated database and the
migrations), which parsed the fenced ```sql block that follows the `## Cleanup` heading in
`docs/superpowers/sdd/2026-08-20-memberships-5a/gate-checklist.md` — **no statement retyped** — and
seeded what step 4 leaves behind (`uji_kreator`, `uji_pembeli`, a bystander `wildan`, a tier, an
active subscription, a paid transaction with an invoice url):

```
[gate] old order -> 23503 user_transaction_user_subscription_id_user_subscription_id_fk
[gate] 4 statements read from the checklist
[gate] survivors: ["wildan"]
[gate] second pass clean
3 pass / 0 fail
```

- the **old** order (subscriptions before transactions) aborts with `23503` on
  `user_transaction_user_subscription_id_user_subscription_id_fk`, and nothing is cleaned up;
- the **document's** block runs to completion, leaving `user_transaction`, `user_subscription` and
  `user_tier` empty and only the non-`uji_` account standing;
- running it **twice** on an already-clean database is a no-op.

The document's second change — matching both `subscriber_id` and `owner_id` rather than only the
buyer — is correct and defensive: a subscription is a row about two accounts, and one still pointing
at a `uji_%` owner would block the last statement on `user_subscription_owner_id_app_user_id_fk`.
The temporary file was deleted.

---

## The `ArrivalLatch` comments — comment-only, confirmed

`git diff 9c740ba..07ee7ae` touches exactly two repository files, and **both are `.test.ts`**:

- `drizzle-join-request.repository.test.ts` — 22 added lines, all inside one `/** … */` above
  `it("lets exactly ONE of several concurrent deciders win")`.
- `drizzle-subscription.repository.test.ts` — 21 added lines, same shape, above
  `it("lets exactly ONE of several concurrent passes make the transition")`.

Zero deletions in either. No number changed — the diff contains no `ArrivalLatch(` line at all, added
or removed. **`drizzle-subscription.repository.ts` — the production file carrying `markPastDue`, on
the live renewal money path — is not in the diff.** Its behaviour cannot have changed. Both comments
close with the required sentence: "do not read 'four is enough' as a general rule, and do not lower
it here."

Not done, and correctly flagged as deliberate by the fixer: the same sentence for
`drizzle-renewal-reminder.repository.test.ts:130-136`, which the review put on the ship list.

---

## New breakage — none found

Every production file in the diff was read at its non-comment level:

- **`is-member-of.ts`** — `execute` is semantically identical to before
  (`!active || currentPeriodEnd === null → false; else > now` ≡ `membershipStanding(...) === "member"`).
  Phase 6's gate did not move. The self-check (`viewerId === ownerId → "none"`) moved from `execute`
  into `describe`, which `execute` now calls, so it still runs on both paths.
- **`get-user-profile.ts`** — one `Promise.all` element changed from `execute`/`false` to
  `describe`/`"none"`. Still one indexed read for a signed-in caller, still zero for an anonymous one.
- **`tier-views.ts`, `MembershipOffer.tsx`, `ProfilePage.tsx`, `apiClient.ts`** — purely additive.
- **`bootstrap.ts`** — four lines, passing the existing `clock` local. `bootstrap.test.ts`'s
  composition-root contract updated to match, and it is green.
- **`errorCopy.ts`** — only the 409 sentence; `describeRequestFailure` and every other branch
  untouched.

Checks that could have gone wrong and did not:

- **A buyer mid-checkout is not told their membership ended.** `findActiveFor` is `status='active'`
  only, so a `pending` row returns `null` → standing `"none"` → the offer still renders.
- **An `active` row with a null period end** is unreachable (`activate(id, periodEnd)` is the only
  writer of that status and always sets one) and is classified `lapsed`, which is the safe answer —
  pinned by name.
- **The wire projection is still closed**: `routes/users.test.ts` pins
  `Object.keys(body.membership).sort()` to exactly `["tiers","viewerIsMember","viewerMembershipEnded"]`.
- **`/dashboard/*` and its tables untouched.** No migration. No file under `dashboard/`. Every
  occurrence of `communities`/`membershipTiers`/`members`/`subscriptions`/`transactions`/`creators`
  in an added line is a local test variable or a `user*`-scoped identifier — checked line by line.
- **Copy rules hold.** Every new user-facing string is Bahasa; the only English added is an internal
  `Error` message and a `console.warn`, both developer-facing and both matching existing convention.
  No `NotFoundError` was touched by the diff, and all of them in `apps/api/src` remain English.
- **Tests assert literals**: both refusal sentences and the transient one are re-declared as string
  literals in the test files rather than imported.
- **Both guard tests green**, run on their own as well as inside the suite: `no-raw-server-errors`
  and `no-hanging-dom-assertions`, 9 / 0. No assertion added by this wave puts a DOM node on either
  side — the new panel is read through `element.textContent` and `queryAll*(...).length`.

### Two observations, neither blocking, neither new to this wave

- A lapsed member now sees **no tier list at all** on that creator's profile, not just no button.
  That is the honest answer in 5a (every tier from that owner is refused by the same guard), but it
  does mean a lapsed member can no longer see what the creator sells. Worth a line in 5b's renewal
  work.
- Widening the release means an `attachGatewayReference` failure now leaves an orphaned live invoice
  at the provider *and* lets the buyer open a second one. That is the review's own M5 class, which
  round 2 accepted explicitly, and it is unreachable today because the payer never receives the first
  url. It should bind 5b's pending-checkout cleanup alongside the abandoned-cart case.

---

## Tree state

`git status --short` — **empty**. `git diff --stat` — **empty**. HEAD is `07ee7ae`.

Every mutation above was reverted with `git checkout --` and confirmed. The three temporary files I
created (`apps/api/src/__zz_probe.ts`, `apps/api/src/__zz_rereview_injection.test.ts`,
`apps/api/src/__zz_rereview_gate_sql.test.ts`) were deleted. `.superpowers/` is gitignored and was
not force-added; this file is the only thing added to it.
