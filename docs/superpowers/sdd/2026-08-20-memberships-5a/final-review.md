# Phase 5a — final whole-branch review

- Branch `feat/memberships` @ `9c740ba`, base `f3aef8a`. 25 commits, 67 files, 25,823 insertions.
- Spec: `docs/superpowers/specs/2026-08-20-memberships-5a-design.md` (binding).
- Ledger read in full before anything else; nothing already ruled is re-litigated below except where
  the ruling's *stated reason* turned out not to hold.

## Verdict

**Findings must be fixed first — two Important, both cheap.** Neither takes or loses money on its own;
both are states this phase reaches by design and answers wrongly. Everything the per-task reviews
proved, I re-proved by independent measurement rather than by reading their reports, and all of it
held. The money paths themselves are sound: I could not construct a route where a person becomes a
member without paying, and the only "charged and given nothing" outcomes are the two the ledger
already ruled on and one narrow race that inherits them.

### Baseline re-established from scratch on this machine

| suite | result |
|---|---|
| `apps/api` | **2395 pass / 0 fail** (289 s, 154 files) |
| `apps/web` | **814 pass / 0 fail** (21 s, 47 files) |
| `packages/shared` | 85 pass / 0 fail |
| `apps/worker` | 52 pass / 0 fail |
| `bun run typecheck` (all four workspaces) | exit 0 |

`apps/web/src/test/no-raw-server-errors.test.ts` and
`apps/web/src/test/no-hanging-dom-assertions.test.ts` are both inside that green web run. The first is
a recursive scan of `src/user`, so it picked up every file this phase added without being edited —
and it is what caught my own `FollowButton` mutant below, independently of the tests.

---

## Findings

### I1 — Important. A lapsed member is offered the tier by the profile and told the opposite by the buy button.

`apps/api/src/application/use-cases/start-user-subscription.ts:167-173`
`apps/web/src/user/MembershipOffer.tsx:62-66` · `apps/web/src/user/apiClient.ts` (`MembershipView` doc)

Two use-cases ask "is this person a member" and get **different answers by design**:

- `IsMemberOf` — `status = 'active'` **AND** `current_period_end > now()`. Drives the profile's
  `viewerIsMember`.
- `StartUserSubscription`'s refusal at line 167 — `findActiveFor`, which is **status-only** by the
  Task 8 ruling (`drizzle-user-subscription.repository.ts:151-171`).

§9 says every 5a membership lapses after one period and nothing renews it. So **one billing cycle after
any purchase**, the row is `status='active'` with a past `current_period_end`, and the two answers
diverge permanently. Measured end to end against a real database:

```
profile.membership.viewerIsMember  →  false        (the offer, and a "Jadi anggota" button)
POST /users/wildan/subscribe       →  409
  "Anda sudah menjadi anggota aktif kreator ini. Membayar lagi tidak menambah masa aktif —
   jika Anda belum bisa melihat kontennya, hubungi kreator tersebut."
```

The web then wraps it in `describeSubscribeFailure`, whose advice is *"Muat ulang halaman ini untuk
melihat penawaran terbaru."* Reloading re-renders the same button. That is precisely the
"loop that cannot terminate" `describeUploadFailure`'s own rewrite exists to forbid, and it will happen
to **100 % of paying members**, not to an edge case.

Two comments assert the opposite of the measured behaviour and must be corrected with the code:
`MembershipOffer.tsx:64-66` ("that person simply sees the offer again … the tier they are shown is a
fresh purchase, **which is what actually exists**") and the matching paragraph on `MembershipView` in
`apiClient.ts`. The ledger's Task 10 ruling records the same belief ("a lapsed member correctly sees
the offer again") and stops one step short of asking what happens when they act on it.

**The obvious fix is the dangerous one.** Do **not** narrow the line-167 refusal to
"active *and* in-period": the Task 8 re-review already established that letting a lapsed-but-`active`
row past that guard puts the purchase on a collision course with `user_subscription_one_active` at
activation time — i.e. it converts a broken button into *charged and not activated*. The fix belongs in
the answer, not the guard: have the profile tell a lapsed member their membership has ended and that
renewal arrives in 5b (the server already knows — it computed `viewerIsMember` from the very row it is
about to refuse), or at minimum make the 409's own sentence true. ~10 lines, no logic change.

### I2 — Important. One failed statement between the claim and the invoice reference locks a buyer out of a creator permanently, and tells them it is temporary.

`apps/api/src/application/use-cases/start-user-subscription.ts:190-257` (claim → `createTransaction` →
`openInvoice` → `attachGatewayReference`), release path at `:328-346`

The round-2 ruling — "a failed provider call must give the claim back" — is implemented **only around
the provider call**. `createTransaction` (`:206`) and `attachGatewayReference` (`:239`) sit outside
that `try`, and both write to the database. Any transient failure there throws with the pending row
still held, and nothing in 5a clears one.

The resulting state is worse than "stuck", because it is invisible to the reuse path:
`findPendingCheckout` requires `gateway_invoice_url IS NOT NULL` (correctly — that predicate is what
stops a failed provider call blocking the buyer), so the row exists for `claimPending` and does not
exist for `resolveExistingCheckout`. Every later attempt falls into the *transient* branch.

Measured on the real HTTP route with one simulated connection reset on `attachGatewayReference` and no
change to any production logic:

```
attempt 1  500  {"error":"internal server error"}     (invoices opened at the provider: 1)
attempt 2  409  "Pembayaran Anda sedang disiapkan. Tunggu sebentar, lalu coba lagi — …"
attempt 3  409  (identical)
findPendingCheckout(buyer, owner) → null              (forever)
```

The ledger carries "a crash between claim and release leaves a pending row nobody clears" to 5b. This is
the same wedge **without a crash** — a single dropped statement — and the message tells the buyer to wait
and retry, which can never work. A creator loses that buyer for good.

Cheapest fix: widen the existing release so it covers everything from `claimPending` to the successful
`attachGatewayReference`, not just `payments.createInvoice`. That is consistent with the round-2 ruling
(the residue is a cancelled row and a possibly-orphaned invoice, which that ruling already accepted) and
is about six lines. A reclaim-stale-pending path in `resolveExistingCheckout` would also work but needs a
time window, and the ledger was right to be wary of inventing one.

### M1 — Minor. `errorCopy.ts` enumerates five 409s; there are six, and the one it omits is the only one a retry fixes.

`apps/web/src/user/errorCopy.ts:158-163` vs `start-user-subscription.ts:117,134,155,169,299,305`

The missing sixth is the transient "Pembayaran Anda sedang disiapkan … coba lagi". The docstring's
reasoning — "every one of them means *not now, and pressing again changes nothing*" — is false for it,
and the sentence the function returns replaces "try again in a moment" with "reload the page". Compounds
I2, where that same 409 is permanent rather than transient.

### M2 — Minor. The gate checklist's cleanup SQL cannot run.

`docs/superpowers/sdd/2026-08-20-memberships-5a/gate-checklist.md`, "Cleanup"

`DELETE FROM user_subscription …` runs first, but `user_transaction.user_subscription_id` is a foreign
key with `ON DELETE no action` (migration `0025`), and every buyer in step 4 has a transaction. The first
statement fails with `23503`. Add `DELETE FROM user_transaction WHERE user_subscription_id IN (…)` ahead
of it. This is a document the owner runs by hand immediately after moving real money, so it is worth the
one line.

### M3 — Minor. The webhook activates without ever looking at the subscription's own status.

`apps/api/src/application/use-cases/handle-payment-webhook.ts:317-388`

The transaction's status is re-read inside the unit of work and gated three ways; the *subscription's*
is not. A `cancelled` subscription whose transaction is still `pending` **with** a gateway reference
would be activated. I could not reach that state — `cancel()` is called only where the reference is
still NULL (`openInvoice`) or the transaction has just been marked paid (the duplicate-active branch) —
so this is an unguarded invariant rather than a live bug. Worth one predicate, given that everything
else on this path fails closed.

### M4 — Minor. A subscribe landing inside the webhook's activation transaction can still mint a second invoice.

`start-user-subscription.ts:167` → `:190`

Between the `findActiveFor` read and the `claimPending` INSERT, the pair's row can flip
`pending → active`. When it does, the pending slot is free, the active read already returned `null`, and
a second invoice opens for a pair that is now a member. Paying it lands in the webhook's duplicate-active
branch: transaction settled, duplicate cancelled, "a refund is likely owed" — charged twice, member once.
Bounded by the duration of the activation transaction, and unreachable outside it (once the winner
commits, line 167 refuses unconditionally). Task 7's ruling analysed the *webhook-side* version of this
race; this is the checkout-side one and is not on the record. Same residue class, same accepted cost.

### M5 — Minor. A provider timeout that actually created the invoice leaves a live payable invoice whose transaction can never be verified.

`start-user-subscription.ts:328-346`

`createInvoice` is bounded by `AbortSignal.timeout`, so "failed" and "succeeded slowly" are
indistinguishable. On the failure path the claim is released and the transaction keeps
`gateway_reference_id = NULL`. If that invoice were ever paid, `settleUserSubscription` fails closed at
`:204` — a 400 on every delivery, permanently: **money taken, membership never granted.** Not reachable
today because the payer never receives the URL (the response threw, and the adapter sends no
`customer.email`, so Xendit has no one to mail it to). The identical caveat is written up for
`ConnectUserPayout`; it deserves the same sentence here.

### M6 — Minor (deferred item, re-cited). `MembershipSettings` fabricates a `ready` tier list.

`apps/web/src/user/MembershipSettings.tsx:326-330` — **the ledger's line reference (339-343) is stale**;
that range is now `setError`. Both halves of the deferral are real: a create that resolves before the
list load loses the new tier when the late response overwrites it (and the owner, seeing it gone, may
publish it twice — nothing makes a tier unique by name, as the comment at `:331` concedes), and a create
after a failed list load clears the error and shows a one-item list as though it were the whole offer.

### M7 — Minor (deferred item, confirmed). `PayoutState` tests `!available` before `connected`.

`apps/web/src/user/MembershipSettings.tsx:173-180`

A connected creator on a box whose provider was de-configured is told payments are unavailable while
`connected` at `:98` keeps the tier editor open — and `tierEditorUnavailableReason:232` has the same
ordering. Requires removing `XENDIT_*` from a box that already has connected users.

### M8 — Minor (deferred item, measured). `FollowButton.test.tsx:233` is blind, and backstopped twice.

Mutating `FollowButton.tsx:125` to append `err.message` — the exact violation the test names — left
`"never surfaces the server's own error text"` **green**. Two siblings in the same file
(`textContent).toBe(...)`, at `:209` and `:244`) reddened, and `no-raw-server-errors.test.ts` catches
the mutant independently. So the class is closed; only this one assertion is decorative. Fix is one
line: `expect(screen.getByRole("alert").textContent).not.toContain("user not found")` — a string on
both sides, no DOM node in the assertion.

### M9 — Minor. `claimPending` is now reachable inside a transaction.

`drizzle-user-subscription.repository.ts:60-63` documents "NOT SAFE INSIDE AN ENCLOSING TRANSACTION"
(a unique violation aborts the surrounding transaction, so its recovery SELECT would fail too). Since
Task 7, `DrizzlePaymentActivationUnitOfWork` constructs this repository against `tx` and hands the whole
port to the webhook. Nothing calls `claimPending` there today. The caveat is now one autocomplete away
from being violated inside the money path.

---

## Triage of the deferred list

| item | verdict |
|---|---|
| `FollowButton.test.tsx:233` blind | **Ship.** Measured blind (M8), but the same mutant is killed by two siblings *and* by the codebase-wide guard. One-line follow-up. |
| `MembershipSettings` fabricated `ready` list | **Ship.** Minor; no money path. Re-cite as `:326-330` (M6). |
| `PayoutState` branch order | **Ship.** Minor; needs a provider de-configured under connected users (M7). |
| Four `ArrivalLatch(4)` tests — evidence or habit? | **Answered; ship.** See below. |
| Task 4's missing non-UUID `:tierId` test | **Ship.** The route mounts `validateParams(z.object({ tierId: uuidParam }))`, so the 400 is structural, not incidental, and `http/validate.test.ts` covers the middleware. |
| Task 5's `toMembershipView` trusting its repository | **Ship.** The scoping it trusts is pinned independently at two layers (repository test and the cross-owner route test), and `toMembershipView` re-filtering would be a second definition of "active". |

### The `ArrivalLatch(4)` question, answered by measurement

**The premise of the deferral is wrong.** Not all four guard unique indexes:

- `drizzle-user.repository.test.ts:96` — unique index on `handle`, INSERT arbitrated.
- `drizzle-follow.repository.test.ts:369` — unique index + `ON CONFLICT DO NOTHING`.
- `drizzle-join-request.repository.test.ts:146` — unique index + `ON CONFLICT DO NOTHING`.
- `drizzle-join-request.repository.test.ts:206` — **a conditional UPDATE.** `decide()` is
  `UPDATE … WHERE id = ? AND status = 'pending'` — structurally identical to
  `beginXenditAccountProvisioning`, the shape F1 proved 4 contenders cannot arbitrate.
- (`drizzle-renewal-reminder.repository.test.ts:136` uses **5**, not 4, and is `recordIfNew`.)
- Not on the list but the same shape: `drizzle-subscription.repository.test.ts:1154` guards
  `markPastDue`, also a conditional UPDATE — and it is on the live renewal money path.

So I measured the two that could have had F1's blind spot, applying F1's own mutant (read-then-act
replacing the conditional UPDATE), production code otherwise untouched:

| test | contenders | result under the mutant |
|---|---|---|
| `join-request.decide` — "lets exactly ONE of several concurrent deciders win" | 4 | **red 5 / 5 runs** |
| `subscription.markPastDue` — "lets exactly ONE of several concurrent passes make the transition" | 4 | **red 3 / 3 runs** |

Both mutants reverted; `git checkout --` confirmed byte-identical.

**Verdict: the numbers are adequate, but the reasoning recorded for them is not.** They are not adequate
"because a unique index arbitrates at any sample size" — two of them are not index-arbitrated at all.
They happen to be adequate because in these two call paths every contender's SELECT issues before any
UPDATE returns, which is exactly what did *not* happen in `beginXenditAccountProvisioning`. That is a
property of the surrounding awaits, not something a reader can assume. **Nothing needs fixing before
merge.** What is worth doing, in 5b or in a tidy-up, is putting the measurement next to the two
conditional-UPDATE tests the way Task 3's fix round put it next to the payout one — including the
sentence "do not lower this number" — so the next person is not left to re-derive it. And
`drizzle-renewal-reminder.repository.test.ts:130-136`'s comment claims the latch means "all five reads
happen before any write"; that is the assumption F1 disproved, and it should be restated as measurement
rather than mechanism.

---

## Can anyone be charged without becoming a member, or become a member without paying?

**Become a member without paying: no.** Followed end to end, and verified rather than assumed:

- `status = 'active'` is written by exactly one statement in the codebase
  (`drizzle-user-subscription.repository.ts:121`), reached by exactly one caller
  (`handle-payment-webhook.ts:386`) — grepped, not inferred.
- Reaching it requires, in order: an `external_id` matching `usub_<uuid>` (`routeInvoiceExternalId`,
  before any database access); our own transaction row; a non-NULL `gateway_reference_id` matching the
  delivered `body.id` (fails **closed** on NULL); `input.amount === transaction.amount` compared against
  our record and never the other way; a fresh `webhook_event.provider_event_id`; `status === "PAID"`
  compared exactly; and a transaction still `pending` on a re-read **inside** the unit of work.
- Steps 3 and 4 share one transaction, so the replay claim cannot commit without the activation it
  authorises. `user_subscription_one_active` is the arbiter for a genuine race and the loser rolls back
  with its event id unspent.
- The amount is read server-side from the tier; `subscribeSchema` accepts `tierId` and nothing else, and
  the buyer is `c.get("userId")` from the session.
- The composite FK `user_subscription_tier_owner_fk` makes a subscription whose owner disagrees with its
  tier's owner unrepresentable, so no one can be activated against somebody else's payout account.

**Charged without becoming a member: only along paths already on the record, plus M4.**

1. The webhook's duplicate-active branch (`handle-payment-webhook.ts:365-379`) — transaction settled,
   duplicate subscription cancelled, "a refund is likely owed", 5a has no refund path. Its *entry
   condition* now has one route nobody had written down: **M4**, a subscribe that lands inside the
   activation transaction. Narrow, bounded, self-limiting.
2. The provider-timeout residue **M5** — a live invoice whose transaction can never be verified. Not
   reachable today because the payer never receives the URL.
3. Not a charge but the mirror of one: **I2**, where a buyer is permanently unable to pay at all, and
   the expiry gap (below), where they are handed a dead payment page. Both are "the creator cannot be
   paid" rather than "the buyer was".

### Do the two known gaps compound? Yes, and one of them needs no failure at all.

The ledger asks whether a stale `pending` row plus an unreissuable invoice can leave a buyer permanently
unable to purchase from a creator, and whether that is reachable without a crash. **Both, and by two
independent routes:**

- **Without a crash, without a failure:** the ordinary abandoned cart. Subscribe, close the page, come
  back after ~24 h. The pending row and its invoice url are still there, so `resolveExistingCheckout`
  hands back the *same* invoice — now expired at Xendit — with a 201 and a dead payment page. Nothing in
  5a can mint a fresh one. This is the single most likely real-world money loss in the phase: it is not
  an interleaving, it is what abandoning a checkout does. The ruling accepting it was right on the
  alternatives (a double charge or refusing anyone who wandered off is worse), and the gate checklist
  names it — but it should bind 5b's pending-checkout cleanup as non-optional, and it argues, as §9 does,
  that 5b follows 5a closely rather than after Phase 6.
- **Without a crash, with one failed statement:** **I2**, measured above — and there the buyer is told
  the state is temporary.

---

## What I re-proved rather than took on trust

- **The community webhook body is byte-identical.** `git show f3aef8a:…` old lines 117-378 against new
  403-664: `diff` reports no difference across 262 lines. And **zero deleted lines anywhere in the
  production file** — `diff` of old 1-116 against new 1-402 yields no `<` lines at all.
- **`/dashboard/*` data is untouched.** Every added production line was grepped for `communities`,
  `membershipTiers`, `members`, `subscriptions`, `transactions`, `creators` outside the `user*`
  identifiers: every hit is a prose comment. Migrations `0024`-`0028` are five pure additions (two new
  tables, one nullable column on `app_user`, one nullable column on `user_transaction`, one partial
  unique index) — no `ALTER` and no index on any dashboard table.
- **The account id cannot leak onto the wire.** `DrizzleUserRepository` has no bare `.select()`
  (`grep` confirms — every call passes an explicit column map), `DrizzleUserPayoutRepository` lists four
  columns, and `toOwnProfile` builds a literal. The new column is invisible to every profile projection.
- **The closed projections hold on every read path.** `GET /users/by-handle/:handle` pins
  `Object.keys(body).sort()` against a literal eight-key array including `membership`; `membership` is
  pinned to exactly `["tiers","viewerIsMember"]`; a tier to exactly
  `["billingCycle","id","name","priceAmount"]`; the subscribe response to exactly four keys. The follow
  and explore rows keep their own four-key projection and never gained `membership`. `post-views.ts` is
  not in the diff at all.
- **`bootstrap.ts`'s dependency-graph change is inert.** `SystemClock` moved earlier in the function; it
  is stateless (`now() { return new Date() }`) and every other consumer is constructed below it. The
  unit of work gained two tx-bound repositories and the webhook gained a pooled one; the community
  transaction boundary is unchanged, and the two paths share no rows and no locks.
- **The sentinel is never truthiness-checked.** Every read of `app_user.xendit_account_id` goes through
  `isConnectedPaymentAccount` / `isProvisioningPlaceholder` / `payoutStatusOf`
  (`start-user-subscription.ts:151`, `manage-user-tiers.ts:78`, `connect-user-payout.ts:59`,
  `get-user-payout-status.ts:26-31`). No `if (x.xenditAccountId)` anywhere.
- **Copy rules hold.** All 63 `NotFoundError` call sites in `apps/api/src` are English, including the
  four new ones in `start-user-subscription.ts` and the two in `manage-user-tiers.ts`. Every new
  `ValidationError`/`ConflictError` carries Bahasa. The two lowercase-initial strings
  (`"koneksi pembayaran bentrok…"`, `"pembayaran belum dikonfigurasi di server ini."`) match the
  pre-existing `routes/payment-account.ts:42` verbatim — deliberate mirroring, not drift.
- **Tests assert literals.** The sentinel and the `usub_` prefix are re-declared as literals in
  `users.test.ts` and `start-user-subscription.test.ts` rather than imported.

## Drift across eleven implementers

Less than the scale would predict. Naming is consistent (`user*` prefix throughout, `Own`/`Public`
projection split mirrored on both sides of the wire), the error taxonomy is uniform, and the money
comments are unusually accurate — every "measured" claim I spot-checked was reproducible. The seams that
do show are all *comment* seams rather than code seams, and all three are about the same thing: what
happens after a period ends. `MembershipOffer.tsx:62-66` and the `MembershipView` docstring both assert
a lapsed member can re-buy (I1); `errorCopy.ts:158` miscounts the refusals it was written against (M1);
`drizzle-renewal-reminder.repository.test.ts:130-136` states a latch property that F1 disproved. Two
shared helpers (`isOwnHandle`, `billingCycleLabel`) were extracted rather than copied, which is the drift
that did *not* happen.

## Tree state

`git status --short` is empty and `git diff --stat` is empty at `9c740ba`. Every mutation above
(`drizzle-join-request.repository.ts`, `drizzle-subscription.repository.ts`, `FollowButton.tsx`) was
reverted with `git checkout --` and confirmed; the two temporary test files I used for the I1 and I2
measurements were deleted. Nothing was added to `.superpowers/` beyond this file, which is gitignored.
