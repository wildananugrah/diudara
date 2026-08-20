# Phase 5a — the final fix wave

- Worktree `/home/wildandev/repo/diudara/.worktrees/memberships`, branch `feat/memberships`.
- Base for this wave: `9c740ba`. **One commit: `07ee7ae`.**
- Scope: the final whole-branch review's I1, I2, M1, M2, and the `ArrivalLatch` measurement.
  Every other Minor (M3–M9) left alone, as instructed.

## Result

| suite | before | after |
|---|---|---|
| `apps/api` | 2395 pass / 0 fail | **2410 pass / 0 fail** (287 s, 154 files) |
| `apps/web` | 814 pass / 0 fail | **823 pass / 0 fail** (19 s, 47 files) |
| `packages/shared` | 85 / 0 | 85 / 0 |
| `apps/worker` | 52 / 0 | 52 / 0 |
| `bun run typecheck` (all four) | exit 0 | exit 0 |

`apps/web/src/test/no-raw-server-errors.test.ts` and
`apps/web/src/test/no-hanging-dom-assertions.test.ts` are inside that green web run. No DOM node
appears on either side of any assertion added here — the new panel is asserted through
`element.textContent` and through `queryAll*(...).length`, both strings and numbers.

`git status --short` and `git diff --stat` are **both empty** at `07ee7ae`, after every mutant below
was reverted with `git checkout --`.

---

## I1 — a lapsed member was offered the tier, then refused it, in a loop that cannot end

### What the honest answer is, and where it now lives

The two use cases still disagree, deliberately: `IsMemberOf` is period-aware, and
`StartUserSubscription`'s refusal at `start-user-subscription.ts` is status-only. **The guard was not
narrowed** — Task 8's re-review established why, and that reasoning is now written into the guard
itself so the next reader does not have to find the ledger. What changed is the *answer*.

`is-member-of.ts` gained one name for the three states 5a can actually be in:

```ts
export type MembershipStanding = "member" | "lapsed" | "none";
export function membershipStanding(active: UserSubscriptionRow | null, now: Date): MembershipStanding
```

- `member` — `active` and still inside its paid period. The only value that grants access.
- `lapsed` — a row exists and blocks a fresh purchase, but grants nothing.
- `none` — nothing here; the offer is genuinely buyable.

It is a **pure function over the row `findActiveFor` already returns**, so:

- `IsMemberOf.execute` is now defined as `describe(...) === "member"` — the two cannot drift apart;
- `IsMemberOf.describe` gives the profile all three answers on the **same single indexed read**;
- `StartUserSubscription` reads it on the row it has **already fetched** — no second query, and no
  second copy of `current_period_end > now` to go stale.

An `active` row with a `null` `current_period_end` counts as **lapsed**. It is unreachable today
(`activate(id, periodEnd)` is the only writer of that status and always sets one), but if it happened
the row would grant nothing while still blocking a purchase — which is what lapsed means. Calling it
`member` would be the one answer that is definitely false.

### The two sentences, and how they differ

Both are 409, both create nothing, both are Bahasa.

**Already an active member** (unchanged):

> Anda sudah menjadi anggota aktif kreator ini. Membayar lagi tidak menambah masa aktif — jika Anda
> belum bisa melihat kontennya, hubungi kreator tersebut.

**Membership has ended** (new):

> Keanggotaan Anda untuk kreator ini sudah berakhir, dan perpanjangan belum tersedia — jadi
> keanggotaan baru pun belum bisa dibeli. Hubungi kreator tersebut jika Anda masih memerlukan akses.

The difference in substance, not only in wording:

| | already active | lapsed |
|---|---|---|
| what it says happened | you hold this membership now | your membership has ended |
| what it says about buying | paying again adds nothing | a new membership cannot be bought either |
| what it tells you to do | contact the creator if you cannot see the content | contact the creator if you still need access |
| retry advice | none | none — and none is possible, so none is offered |

The lapsed sentence names the 5a limitation (`perpanjangan belum tersedia`) rather than implying a
purchase that does not exist. Neither contains "coba lagi" or "Muat ulang"; the third test below
asserts that on the lapsed one directly.

### The button no longer appears at all

Making the refusal truthful fixes the sentence at the end of the loop. It does not stop a lapsed
member being *offered* the purchase, which is the other half of the finding's headline. So the server
now tells the profile which kind of "not a member" it is looking at:

- `MembershipView` (API `tier-views.ts`, and its mirror in web `apiClient.ts`) gains
  **`viewerMembershipEnded: boolean`** — a third key, and the projection stays closed at exactly
  those three.
- `toMembershipView(rows, standing)` takes the **standing**, not two booleans, and derives both. The
  contradictory pair (`viewerIsMember: true` *and* `viewerMembershipEnded: true`) is therefore
  unrepresentable rather than merely unlikely.
- `false`, never `null`, for an anonymous visitor — same construction and same reasoning as
  `viewerIsMember`: it is a claim about the caller, and `GetUserProfile` short-circuits to `"none"`
  before the database for `viewerId === null`.
- No extra query. `GetUserProfile` calls `describe` where it called `execute`.
- `MembershipOffer.tsx` renders, instead of the offer:

  > Keanggotaan Anda di @{handle} sudah berakhir. Perpanjangan belum tersedia untuk saat ini.

  No button, not even a disabled one — a disabled control still says "this is a thing you could do",
  and it is not. The branch sits **before** the empty-tiers return, for the same reason the member
  branch does. `ProfilePage` passes `profile.membership?.viewerMembershipEnded ?? false`; `false` is
  the safe default here in the *opposite* direction from `viewerIsMember` — an API that predates the
  field must not hide every creator's offer from every signed-in visitor.

**No endpoint was invented.** There is no "Perpanjang" button, because there is nothing behind one.

### The retry advice is gone from this path (and M1 with it)

`describeSubscribeFailure`'s docstring said "409 for five different refusals" and that "every one of
them means *not now, and pressing again changes nothing*". There are **seven** (the seventh being
this wave's lapsed/active split), the enumeration is now written out one per line, and the claim was
false for the transient "Pembayaran Anda sedang disiapkan… coba lagi" — the only one a retry fixes.

Old copy: *"…atau Anda masih punya keanggotaan atau tagihan yang aktif. **Muat ulang halaman ini
untuk melihat penawaran terbaru.**"*

New copy:

> Keanggotaan ini belum bisa dibeli sekarang — tingkatannya mungkin sudah ditutup, kreatornya belum
> siap menerima pembayaran, pembayaran sebelumnya masih diproses, atau keanggotaan Anda sudah
> berakhir dan perpanjangan belum tersedia. Muat ulang halaman ini untuk melihat keadaan terbaru.

It promises no *penawaran* — no fresh offer — and does not tell anyone to press again. It cannot say
"pressing again changes nothing" either, because that is false for the seventh. Reloading is still
named, but now for what it actually does: the profile carries `viewerMembershipEnded`, so the page a
lapsed member comes back to says their membership ended instead of re-rendering the button. **The
loop is closed by the profile; the sentence simply stops re-opening it.**

### The two comments that asserted the opposite

Both corrected, and both now say what was measured rather than what was assumed:

- `apps/web/src/user/MembershipOffer.tsx` — the paragraph claiming a lapsed member "simply sees the
  offer again" and that "the tier they are shown is a fresh purchase, **which is what actually
  exists**".
- `apps/web/src/user/apiClient.ts` — the matching paragraph on `MembershipView`.

Also brought in line, since they carried the same belief: the API-side `MembershipView` docstring
(`tier-views.ts`), `PublicUserProfile.membership` (`get-user-profile.ts`), the header of
`MembershipOffer.test.tsx`'s member block, and the two "the offer is right there to buy again"
comments in `get-user-profile.test.ts` and `routes/users.test.ts`.

### The pin, and the mutation that proves it

`start-user-subscription.test.ts` → **"StartUserSubscription — a LAPSED membership is refused with
the truth"**, five tests, both sentences declared as literals in the test:

1. a lapsed member gets the ENDED sentence, and nothing is claimed, charged or created;
2. a member whose period has not run out gets a **different** sentence;
3. **the pin the brief asked for** — both messages captured in one test, `expect(forLapsed).not.toBe(forLive)`,
   plus `not.toContain("coba lagi")` and `not.toContain("Muat ulang")`;
4. the boundary: a period ending exactly `now` has ended (`>`, not `>=`);
5. a `null` period end is treated as ended.

**Mutant — collapse the two branches back into the single already-active message.** Applied to
`start-user-subscription.ts`, everything else untouched:

```
27 pass / 4 fail
(fail) tells a lapsed member their membership ENDED and that renewal is not available
(fail) the lapsed sentence and the already-active sentence are not the same sentence
(fail) the BOUNDARY: a period ending exactly now has ended
(fail) an `active` row with NO period end is treated as ended
```

Reverted, tree byte-identical.

**Mutant — `viewerMembershipEnded: false` always** in `toMembershipView`:

```
22 pass / 3 fail
(fail) toMembershipView > a LAPSED standing is not a member, and is not the same as a stranger
(fail) GetUserProfile > is FALSE for a lapsed membership — status is still active, the period is not
(fail) GetUserProfile > distinguishes a stranger from a lapsed member — both are non-members, only one may buy
```

**Mutant — delete the `viewerMembershipEnded` branch from `MembershipOffer.tsx`:**

```
54 pass / 3 fail
(fail) MembershipOffer > says the membership ended and that renewal is not available, with no way to buy
(fail) MembershipOffer > still says so when the creator has withdrawn every tier
(fail) ProfilePage > tells somebody whose membership ended that it ended, instead of offering the button
```

**Mutant — restore the old 409 copy** in `errorCopy.ts`:

```
32 pass / 2 fail
(fail) describeSubscribeFailure > answers a 409 with a remedy that is not 'try again'
(fail) describeSubscribeFailure > promises no fresh offer, and does not tell the buyer to press the button again
```

Through HTTP, against the real database, `routes/users.test.ts` also pins the whole divergence in one
test: a subscription activated with a 2020 period end → `POST /subscribe` answers the ENDED sentence,
a `findById` guard asserts the row really is `status='active'` with a 2020 period (so it cannot pass
for the wrong reason), and the profile read in the same test answers
`viewerIsMember: false, viewerMembershipEnded: true`. **The two sides now agree on the same database
in the same run.**

---

## I2 — one failed statement wedged a buyer out permanently, and called it temporary

### The change

`openInvoice` is gone; the `try` now opens immediately after the claim and closes after the successful
`attachGatewayReference`:

```
claimPending  →  [ createTransaction  →  createInvoice  →  attachGatewayReference ]  →  return
                   ^                                                            ^
                   └────────────── one try, one catch: releaseClaim ────────────┘
```

`releaseClaim(subscriptionId)` replaces the old inline handler and adds one thing the old one did not
have: **it cannot throw over the original error.** The old code did `await this.subscriptions.cancel(...)`
unguarded inside a catch, so a `cancel` that lost its own connection would have replaced the real
reason for the failure with its own — the buyer wedged *and* nobody able to see why. It now swallows a
failed release into the same `console.warn` (ids only, never the payer's details) and lets the caller
rethrow the original.

The residue is the one round 2 already accepted: a `cancelled` row and a possibly-orphaned invoice
whose transaction carries no gateway reference, which `settleUserSubscription` fails **closed** on.
That is written into the code beside the `try`, together with why `findPendingCheckout` cannot see the
wedged row (it requires a non-null invoice url — correctly, since that predicate is what stops a
failed provider call blocking the buyer).

### Failure-injection evidence, at each statement

**Use-case level** (`start-user-subscription.test.ts` → "every statement between the claim and the
invoice reference releases it"). A helper makes one named repository method reject **once** with
`simulated connection reset during <method>`; the second call runs the real method, so the test can
assert the retry *succeeds* rather than only that the first attempt failed.

| statement | injected | first attempt | claim after | retry |
|---|---|---|---|---|
| `createTransaction` | one rejection | throws `simulated connection reset during createTransaction` | `cancelled`; **0 invoices at the provider** | **201-equivalent**, fresh pending row, 1 transaction |
| `createInvoice` | `payments.failNextInvoice` | throws `createInvoice failed` | `cancelled` | succeeds; 1 invoice, 2 transactions |
| `attachGatewayReference` | one rejection | throws `simulated connection reset during attachGatewayReference`; **1 invoice already open at the provider**; transaction keeps `gatewayReferenceId: null` | `cancelled` | succeeds on `fake-inv-2`, new transaction carries a reference |

Plus two more: **"NONE of the three leaves the buyer stuck on the transient refusal"** asserts the
second attempt is not the `"Pembayaran Anda sedang disiapkan…"` string (the measured symptom, stated
directly), and **"a release that itself fails does not replace the original error, and warns"** stubs
`cancel` to throw and asserts the original error still propagates and exactly one warning is logged.

**Route level, real database, real HTTP** (`routes/users.test.ts`, `it.each` over the two database
statements). The failure is injected on a `DrizzleUserSubscriptionRepository` instance the test wires
into the production `StartUserSubscription` behind the real route — **no file under `src` is
modified**. For each of `createTransaction` and `attachGatewayReference`:

```
attempt 1  →  500
attempt 2  →  201, with an invoiceUrl
              user_subscription rows: ["cancelled", "pending"]
attempt 3  →  201, the SAME invoiceUrl        (findPendingCheckout can see it again)
```

Against the review's measurement — `attempt 1 → 500`, `attempts 2 and 3 → 409 "Tunggu sebentar, lalu
coba lagi"`, `findPendingCheckout → null` forever — all three lines are now different.

### The mutation that proves it

**Mutant — narrow the release back to round 2's scope** (release only when the provider call was what
failed), production file otherwise untouched:

```
use-case:  27 pass / 4 fail
  (fail) createTransaction: the claim is released, and the retry succeeds
  (fail) attachGatewayReference: the claim is released, and the retry succeeds
  (fail) NONE of the three leaves the buyer stuck on the transient refusal
  (fail) a release that itself fails does not replace the original error, and warns

route:    144 pass / 2 fail
  (fail) a dropped createTransaction releases the claim, and the very next attempt succeeds
  (fail) a dropped attachGatewayReference releases the claim, and the very next attempt succeeds
```

Reverted; `git status --short` empty.

---

## M1 — `errorCopy.ts` enumerated five 409s

Covered under I1 above: the docstring now enumerates **seven**, one per line, marks (7) as
**the only one where pressing the button again works**, and the copy no longer claims either "pressing
again changes nothing" or "reload for the latest offer". `errorCopy.test.ts`'s own header was
rewritten with it — it said "four".

---

## M2 — the gate checklist's cleanup SQL could not run

**Old order, reproduced against a migrated database:**

```
[gate-cleanup] old order -> 23503 on user_transaction_user_subscription_id_user_subscription_id_fk
```

Exactly as the review said: `user_transaction.user_subscription_id` is `ON DELETE no action`
(migration `0025`), and every buyer in step 4 has a transaction, so the first statement aborted and
nothing was cleaned up at all.

**Corrected block, as it now stands in `docs/superpowers/sdd/2026-08-20-memberships-5a/gate-checklist.md`:**

```sql
DELETE FROM user_transaction
WHERE user_subscription_id IN (
  SELECT id FROM user_subscription
  WHERE subscriber_id IN (SELECT id FROM app_user WHERE handle LIKE 'uji_%')
     OR owner_id IN (SELECT id FROM app_user WHERE handle LIKE 'uji_%')
);
DELETE FROM user_subscription
WHERE subscriber_id IN (SELECT id FROM app_user WHERE handle LIKE 'uji_%')
   OR owner_id IN (SELECT id FROM app_user WHERE handle LIKE 'uji_%');
DELETE FROM user_tier WHERE owner_id IN (SELECT id FROM app_user WHERE handle LIKE 'uji_%');
DELETE FROM app_user WHERE handle LIKE 'uji_%';
```

Two changes, not one. The transactions go first, **and** both `subscriber_id` and `owner_id` are
matched rather than only the buyer: a subscription is a row about *two* `uji_%` accounts, and one
still pointing at a `uji_%` owner would have blocked the last statement on
`user_subscription_owner_id_app_user_id_fk`. The document explains both, and says the block was
verified.

**Proof it runs.** A temporary test file under `apps/api/src` (so it inherited the per-run isolated
database and the migrations), which **read the SQL block out of the markdown file itself** rather than
retyping it — 4 statements parsed — seeded exactly what step 4 leaves behind (`uji_kreator`,
`uji_pembeli`, a bystander `wildan`, a tier, an active subscription, a paid transaction with an
invoice url) and executed them in order:

```
[gate-cleanup] old order -> 23503 on user_transaction_user_subscription_id_user_subscription_id_fk
[gate-cleanup] 4 statements read from the checklist
 3 pass / 0 fail
```

The three: the old order fails with `23503`; the document's block runs to completion leaving
`user_transaction`, `user_subscription` and `user_tier` empty and **only the non-`uji_` account
standing**; and running it twice on an already-clean database is a no-op. The temporary file was
deleted afterwards — `git status --short` is empty.

---

## The `ArrivalLatch` measurement

**Comment-only, in test files. No number changed, and no production behaviour touched** —
`subscription.markPastDue` itself was not opened at all.

Both comments state the same three things: that the method is a **conditional UPDATE, not
index-arbitrated**, and therefore structurally the shape F1 proved four contenders cannot arbitrate;
what was measured; and why it nevertheless holds here.

- `apps/api/src/infrastructure/repositories/drizzle-join-request.repository.test.ts` —
  `"lets exactly ONE of several concurrent deciders win"`:
  `decide()` is `UPDATE … WHERE id = ? AND status = 'pending'`. Under F1's own read-then-act mutant,
  **red 5 runs out of 5** at four contenders; mutant reverted byte-identical.
- `apps/api/src/infrastructure/repositories/drizzle-subscription.repository.test.ts` —
  `"lets exactly ONE of several concurrent passes make the transition"`:
  `markPastDue` is a conditional UPDATE **on the live renewal money path**, which is why the review
  would not leave it on an assumption. Under the same mutant, **red 3 runs out of 3** at four
  contenders; reverted byte-identical.

Both close with the reason the number holds and the warning against generalising it, in the shape
Task 3's payout latch uses:

> WHY IT HOLDS HERE AND NOT THERE: in this call path every contender's SELECT issues before any
> UPDATE returns, so all four genuinely observe `pending` / `active`. That is a property of the
> surrounding awaits, not of the number — do not read "four is enough" as a general rule, and do not
> lower it here.

**Not done, and deliberately:** `drizzle-renewal-reminder.repository.test.ts:130-136`'s comment, which
the review also flagged as claiming a mechanism ("all five reads happen before any write") that F1
disproved. It was not in this wave's instructions, its number is 5 rather than 4, and it is on the
review's ship list. It is worth the same sentence in 5b or a tidy-up.

---

## Files changed

**API (production)** — `application/use-cases/is-member-of.ts`, `tier-views.ts`,
`get-user-profile.ts`, `start-user-subscription.ts`, `bootstrap.ts`.
**API (tests)** — `is-member-of` callers in `tier-views.test.ts`, `get-user-profile.test.ts`,
`start-user-subscription.test.ts`, `routes/users.test.ts`, `bootstrap.test.ts`, plus the two latch
comments.
**Web (production)** — `user/apiClient.ts`, `user/MembershipOffer.tsx`, `user/ProfilePage.tsx`,
`user/errorCopy.ts`.
**Web (tests)** — `MembershipOffer.test.tsx`, `ProfilePage.test.tsx`, `apiClient.test.ts`,
`errorCopy.test.ts`.
**Docs** — `docs/superpowers/sdd/2026-08-20-memberships-5a/gate-checklist.md`.

No migration. No change to `community`, `membership_tier`, `member`, `subscription`, `transaction` or
`creator`, and nothing under `/dashboard/*`. All new user-facing copy is Bahasa Indonesia; no
`NotFoundError` message was touched, so all 63 remain English. Every new test asserts literal values,
never the constants it checks — both refusal sentences and the transient one are re-declared as
literals in the test files.

## Tree state

`git status --short` — empty. `git diff --stat` — empty. Every mutant listed above was reverted with
`git checkout --` and the covering suites re-run green afterwards (273 pass / 0 fail across the six
api files, 823 pass / 0 fail across all of web). `.superpowers/` is gitignored and was not force-added;
this file is the only thing added to it.
