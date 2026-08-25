# Free Memberships Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A creator can offer a free membership tier, and grants it by approving a request.

**Architecture:** A new `user_subscription.kind` column (`'paid' | 'free'`) makes a
never-expiring membership explicit instead of overloading a NULL `current_period_end`.
Free vs paid is derived from `price_amount === 0`. Requesting reuses the `pending` row and
the partial unique index that already exist; approval is a conditional UPDATE.

**Tech Stack:** Bun 1.3.14, Hono, drizzle-orm + Postgres, React 19 + Vite, `bun test`.

**Spec:** `docs/superpowers/specs/2026-08-25-free-memberships-design.md`

## Global Constraints

- **Never overload `current_period_end`.** A paid row with `null` must keep reading
  `lapsed`. Only `kind = 'free'` grants a membership with no expiry. Spec §3.
- **`membershipStanding` stays the ONE definition.** No second copy of the comparison.
- **The database arbitrates.** Partial unique indexes, conditional UPDATEs, `ON CONFLICT`
  — never read-then-write.
- **Closed wire projections.** Every projection test asserts
  `Object.keys(view).sort()` against a literal array.
- **Indonesian UI copy**, matching surrounding surfaces.
- **No raw server errors reach the browser** — the two web guard tests in
  `apps/web/src/test/` already enforce this.
- **Migrations are generated, never hand-written:** `cd apps/api && bun run db:generate`,
  then read the SQL it produced before committing it.
- **Standing rule from prior phases:** after writing a test, delete the guard your test
  names and confirm that test — not a neighbour — fails.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/db/schema.ts` | `user_subscription.kind` column |
| `apps/api/drizzle/00XX_*.sql` | generated migration |
| `apps/api/src/application/ports/user-subscription-repository.port.ts` | `kind` on `UserSubscriptionRow`; three new methods |
| `apps/api/src/application/use-cases/is-member-of.ts` | `membershipStanding` gains the free disjunct |
| `apps/api/src/infrastructure/repositories/drizzle-user-subscription.repository.ts` | the SQL read sites and the new writes |
| `apps/api/src/application/use-cases/manage-user-tiers.ts` | price `0` allowed; payout checks conditional |
| `apps/api/src/application/use-cases/start-user-subscription.ts` | nullable provider; the free branch |
| `apps/api/src/application/use-cases/membership-requests.ts` | **new** — list / approve / reject |
| `apps/api/src/routes/users.ts` | three owner routes |
| `apps/api/src/domain/handle.ts` | `membership-requests` reserved |
| `apps/api/src/bootstrap.ts` | `StartUserSubscription` built unconditionally |
| `apps/web/src/user/SettingsPage.tsx` | requests queue; price `0` in the tier form |
| `apps/web/src/user/MembershipOffer.tsx` | free tier CTA and pending state |
| `apps/web/src/user/PostCard.tsx` | the lock CTA that is currently a no-op |

---

### Task 1: The `kind` column and the one predicate

**Files:**
- Modify: `apps/api/src/db/schema.ts` (`userSubscriptions`)
- Create: `apps/api/drizzle/00XX_*.sql` (generated)
- Modify: `apps/api/src/application/ports/user-subscription-repository.port.ts:2-10`
- Modify: `apps/api/src/application/use-cases/is-member-of.ts`
- Test: `apps/api/src/application/use-cases/is-member-of.test.ts`

**Interfaces:**
- Produces: `UserSubscriptionRow.kind: string`; `membershipStanding(active, now)` unchanged
  in signature, changed in behaviour.

- [ ] **Step 1: Write the failing tests**

```ts
// is-member-of.test.ts — add to the existing membershipStanding describe
const PAID = { id: "s1", subscriberId: "u1", tierId: "t1", ownerId: "o1",
  status: "active", kind: "paid", createdAt: new Date(0) };

it("a free membership is a member with no period at all", () => {
  expect(membershipStanding({ ...PAID, kind: "free", currentPeriodEnd: null }, new Date())).toBe("member");
});

it("a PAID row with no period is still lapsed — the bug guard survives", () => {
  expect(membershipStanding({ ...PAID, currentPeriodEnd: null }, new Date())).toBe("lapsed");
});

it("a paid row whose period has passed is lapsed", () => {
  const now = new Date("2026-08-25T00:00:00Z");
  expect(membershipStanding({ ...PAID, currentPeriodEnd: new Date("2026-08-24T00:00:00Z") }, now)).toBe("lapsed");
});

it("a free row is a member even with a period in the past — kind wins", () => {
  const now = new Date("2026-08-25T00:00:00Z");
  expect(membershipStanding({ ...PAID, kind: "free", currentPeriodEnd: new Date("2026-01-01T00:00:00Z") }, now)).toBe("member");
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && bun test src/application/use-cases/is-member-of.test.ts`
Expected: FAIL — `kind` is not a property, and the free cases answer `lapsed`.

- [ ] **Step 3: Add the column**

```ts
// schema.ts, inside userSubscriptions' column block, after `status`:
    // 'paid' | 'free'. VARCHAR, not an enum — same reasoning as `status` above
    // and `post.visibility`: a later value needs no migration. The DEFAULT makes
    // this migration additive and leaves every existing row paid, which is what
    // every existing row is.
    kind: varchar("kind", { length: 16 }).notNull().default("paid"),
```

- [ ] **Step 4: Generate and READ the migration**

Run: `cd apps/api && bun run db:generate`
Then open the generated `drizzle/00XX_*.sql` and confirm it is exactly one
`ALTER TABLE "user_subscription" ADD COLUMN "kind" varchar(16) DEFAULT 'paid' NOT NULL;`
and drops nothing. A generated migration that touches another table is a signal the
schema drifted — stop and report rather than committing it.

- [ ] **Step 5: Widen the row type and the predicate**

```ts
// user-subscription-repository.port.ts
export interface UserSubscriptionRow {
  id: string;
  subscriberId: string;
  tierId: string;
  ownerId: string;
  status: string;
  /** 'paid' | 'free'. See spec §3: this is what keeps a NULL period reading as a bug. */
  kind: string;
  currentPeriodEnd: Date | null;
  createdAt: Date;
}
```

```ts
// is-member-of.ts
export function membershipStanding(
  active: UserSubscriptionRow | null,
  now: Date
): MembershipStanding {
  if (!active) return "none";
  // A free membership has no period by design (spec §3). Checked BEFORE the null
  // test below, which is the guard that keeps a PAID row's null reading as lapsed.
  if (active.kind === "free") return "member";
  if (active.currentPeriodEnd === null) return "lapsed";
  return active.currentPeriodEnd.getTime() > now.getTime() ? "member" : "lapsed";
}
```

Update the docstring above it: the `null` case is no longer unreachable-and-therefore-a-bug
for free rows; it is the normal shape of a free membership, and `kind` is what tells them
apart.

- [ ] **Step 6: Run the tests, then the whole api suite**

Run: `cd apps/api && bun test`
Expected: PASS. Type errors in the repository (which does not yet select `kind`) must be
fixed by selecting it — not by casting.

- [ ] **Step 7: Mutation-check the guard**

Delete `if (active.kind === "free") return "member";` and confirm the two free tests fail.
Restore it, then swap the two lines so the null test runs first and confirm the
"free with a past period" test fails. Both must bite.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(api): user_subscription.kind, and a free membership that never expires"
```

---

### Task 2: Every SQL site that compares `current_period_end`

**Files:**
- Modify: `apps/api/src/infrastructure/repositories/drizzle-user-subscription.repository.ts`
  (`findActiveFor` ~line 433, `listActiveOwnersAmong` ~line 462, `listActiveSubscribers` ~line 425)
- Test: `apps/api/src/infrastructure/repositories/drizzle-user-subscription.repository.test.ts`

**Interfaces:**
- Consumes: `kind` from Task 1.
- Produces: no signature change; three queries change meaning.

**THIS IS THE TASK THAT CAN LEAK PHOTOS.** `listActiveOwnersAmong` is Phase 6's bulk
paywall read: it decides, for a page of feed posts, which authors the viewer is a member
of. A wrong disjunct here serves every gated photo of every creator to everyone.

- [ ] **Step 1: Write the failing tests — each with its paid control**

```ts
it("listActiveOwnersAmong includes an owner the viewer joined for free", async () => {
  // free row: status active, kind free, currentPeriodEnd NULL
  const owners = await repo.listActiveOwnersAmong(subscriberId, [ownerId], new Date());
  expect(owners).toEqual([ownerId]);
});

it("listActiveOwnersAmong STILL excludes a paid owner whose period has passed", async () => {
  // paid row: status active, kind paid, currentPeriodEnd yesterday
  const owners = await repo.listActiveOwnersAmong(subscriberId, [ownerId], new Date());
  expect(owners).toEqual([]);
});

it("findActiveFor returns the free row, and reports kind", async () => {
  const row = await repo.findActiveFor(subscriberId, ownerId);
  expect(row?.kind).toBe("free");
});

it("listActiveSubscribers includes a free member", async () => {
  const rows = await repo.listActiveSubscribers(ownerId, new Date());
  expect(rows.map((r) => r.handle)).toEqual(["andi"]);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && bun test src/infrastructure/repositories/drizzle-user-subscription.repository.test.ts`
Expected: the three free cases FAIL (the free row is filtered out); the paid-lapsed
control PASSES already — it is there to catch the fix going too far, so confirm it is
green BEFORE the change and green AFTER.

- [ ] **Step 3: Add the disjunct to all three**

```ts
// the shared shape, applied in findActiveFor, listActiveOwnersAmong and listActiveSubscribers
and(
  eq(userSubscriptions.status, "active"),
  or(
    eq(userSubscriptions.kind, "free"),
    gt(userSubscriptions.currentPeriodEnd, now)
  )
)
```

Import `or` from `drizzle-orm`. Select `kind` in every query that builds a
`UserSubscriptionRow`, or the type from Task 1 will not be satisfied.

- [ ] **Step 4: Prove the sweep and the reminder ignore free rows**

The expiry sweep is `status='active' AND current_period_end <= now`, and the reminder is
`current_period_end` between two instants. In SQL, `NULL <= now` is `NULL`, never true —
so a free row is already skipped by both. **Assert it rather than assume it:**

```ts
it("the expiry sweep leaves a free membership alone", async () => {
  const expired = await repo.listExpiredActive(new Date(), 100);
  expect(expired.map((r) => r.id)).toEqual([]);   // with only a free row present
});

it("a free member is never reminded that their membership is expiring", async () => {
  const due = await repo.listExpiringActive({ from: new Date(), to: farFuture, limit: 100 });
  expect(due.map((r) => r.id)).toEqual([]);
});
```

- [ ] **Step 5: Run the whole api suite**

Run: `cd apps/api && bun test`
Expected: PASS, including every Phase 6 media-gating test.

- [ ] **Step 6: Mutation-check the leak**

In `listActiveOwnersAmong`, replace the `or(...)` with `eq(userSubscriptions.kind, "free")`
alone — dropping the period check. Confirm the paid-lapsed control test goes RED. If it
stays green, the control is not testing what it claims and must be fixed before moving on.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(api): free memberships pass the paywall; lapsed paid ones still do not"
```

---

### Task 3: A free tier needs no payout account

**Files:**
- Modify: `apps/api/src/application/use-cases/manage-user-tiers.ts:61-80`
- Test: `apps/api/src/application/use-cases/manage-user-tiers.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it("creates a free tier with no payout account connected", async () => {
  const tier = await manageTiers.create({ ownerId, name: "Gratis", priceAmount: 0, billingCycle: "monthly" });
  expect(tier.priceAmount).toBe(0);
});

it("still refuses a PAID tier with no payout account", async () => {
  await expect(
    manageTiers.create({ ownerId, name: "Pendukung", priceAmount: 50000, billingCycle: "monthly" })
  ).rejects.toThrow();
});

it("refuses a negative price", async () => {
  await expect(
    manageTiers.create({ ownerId, name: "Salah", priceAmount: -1, billingCycle: "monthly" })
  ).rejects.toThrow();
});
```

- [ ] **Step 2: Run and watch fail**

Run: `cd apps/api && bun test src/application/use-cases/manage-user-tiers.test.ts`
Expected: the free-tier test FAILS with the "price must be positive" refusal.

- [ ] **Step 3: Make the guards price-aware**

```ts
    if (!Number.isInteger(input.priceAmount) || input.priceAmount < 0) {
      throw new ValidationError("price must be a whole number of rupiah, zero or more");
    }

    // A FREE tier skips both payout checks: no money moves, so there is nothing
    // for a payout account to receive. A paid tier still needs a CONNECTED one —
    // a membership whose money has nowhere to go is the thing this guarded.
    if (input.priceAmount > 0) {
      const payout = await this.payouts.findPayoutAccount(input.ownerId);
      if (!payout) { /* unchanged refusal */ }
      if (!isConnectedPaymentAccount(payout.xenditAccountId)) { /* unchanged refusal */ }
    }
```

- [ ] **Step 4: Run tests** — Run: `cd apps/api && bun test src/application/use-cases/manage-user-tiers.test.ts` — Expected: PASS.

- [ ] **Step 5: Mutation-check** — change `> 0` to `>= 0` and confirm the free-tier test fails; change `< 0` back to `<= 0` and confirm it fails too.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(api): a tier priced at zero needs no payout account"
```

---

### Task 4: Requesting a free membership

**Files:**
- Modify: `apps/api/src/application/use-cases/start-user-subscription.ts`
- Modify: `apps/api/src/bootstrap.ts` (~line 1567)
- Modify: `apps/api/src/application/ports/user-subscription-repository.port.ts` (`create` gains `kind`)
- Modify: `apps/api/src/infrastructure/repositories/drizzle-user-subscription.repository.ts` (`create`)
- Test: `apps/api/src/application/use-cases/start-user-subscription.test.ts`

**Interfaces:**
- Consumes: `kind` (Task 1), free tiers (Task 3).
- Produces: `create({ subscriberId, tierId, ownerId, kind })`.

**The blocker this removes (spec §5.2):** `bootstrap.ts` builds this use case as
`payments ? new StartUserSubscription(...) : undefined`, so the subscribe route **503s on
a payments-disabled box regardless of tier price**.

- [ ] **Step 1: Write the failing tests**

```ts
it("requesting a FREE tier creates a pending row with kind 'free' and no invoice", async () => {
  const result = await startSubscription.execute({ subscriberId, handle: "rina", tierId: freeTierId });
  expect(result.paymentUrl).toBeUndefined();
  const row = await repo.findById(result.subscriptionId);
  expect([row!.status, row!.kind]).toEqual(["pending", "free"]);
});

it("requesting a free tier works with NO payment provider at all", async () => {
  const useCase = new StartUserSubscription(/* ...deps... */, null);
  const result = await useCase.execute({ subscriberId, handle: "rina", tierId: freeTierId });
  expect(result.paymentUrl).toBeUndefined();
});

it("a PAID tier with no payment provider is refused, not silently freed", async () => {
  const useCase = new StartUserSubscription(/* ...deps... */, null);
  await expect(
    useCase.execute({ subscriberId, handle: "rina", tierId: paidTierId })
  ).rejects.toThrow();
});

// Spec §9 — the case the spec forbids lying about.
it("tells a LAPSED paid member their membership ended, rather than 'you are already a member'", async () => {
  // an active-but-expired paid row exists for (subscriber, owner)
  await expect(
    startSubscription.execute({ subscriberId, handle: "rina", tierId: freeTierId })
  ).rejects.toThrow(/berakhir/);   // "ended", not "already a member"
});
```

- [ ] **Step 2: Run and watch fail** — Run: `cd apps/api && bun test src/application/use-cases/start-user-subscription.test.ts` — Expected: FAIL, constructor rejects `null`.

- [ ] **Step 3: Make the provider optional and branch on price**

```ts
  constructor(
    /* ...unchanged deps... */
    private readonly payments: PaymentProviderPort | null,
  ) {}
```

After the existing guards resolve the tier, branch:

```ts
    // Free is decided by the PRICE, not by a second flag that could disagree
    // with it (spec §2.4).
    if (tier.priceAmount === 0) {
      const pending = await this.subscriptions.create({
        subscriberId, tierId: tier.id, ownerId: owner.id, kind: "free",
      });
      // No invoice, no transaction row, no provider call: nothing is owed.
      return { subscriptionId: pending.id };
    }

    if (this.payments === null) {
      throw new ServiceUnavailableError(
        "pembayaran belum tersedia di server ini"
      );
    }
```

Word the lapsed refusal truthfully — it must say the previous membership has ended and
cannot currently be replaced, and must NOT say "you are already an active member".

- [ ] **Step 4: Build it unconditionally in bootstrap**

```ts
  // No longer gated on `payments`: a FREE tier needs no provider, and gating the
  // whole use case made POST /users/:handle/subscribe 503 on a payments-disabled
  // box regardless of price. The use case refuses a PAID tier itself when
  // `payments` is null — the decision moved from boot to the tier.
  const startUserSubscription = new StartUserSubscription(/* ...deps... */, payments);
```

Follow the `undefined`-when-null comment chain in `bootstrap.ts` and update every
docstring that claims this field is `undefined` exactly when `payments` is `null`.

- [ ] **Step 5: Run the whole api suite** — Run: `cd apps/api && bun test` — Expected: PASS. Route tests asserting a 503 on a payments-disabled box must now assert it for a PAID tier specifically.

- [ ] **Step 6: Mutation-check** — make the free branch fall through to the paid path and confirm the "no payment provider at all" test fails.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(api): request a free membership, with or without a payment provider"
```

---

### Task 5: The owner's queue — list, approve, reject

**Files:**
- Create: `apps/api/src/application/use-cases/membership-requests.ts`
- Create: `apps/api/src/application/use-cases/membership-requests.test.ts`
- Modify: `apps/api/src/application/ports/user-subscription-repository.port.ts`
- Modify: `apps/api/src/infrastructure/repositories/drizzle-user-subscription.repository.ts`
- Modify: `apps/api/src/routes/users.ts`, `apps/api/src/domain/handle.ts`, `apps/api/src/bootstrap.ts`
- Test: `apps/api/src/routes/users.test.ts`, `apps/api/src/app.test.ts`

**Interfaces:**
- Consumes: `kind` (Task 1), the pending row `StartUserSubscription` writes (Task 4).
- Produces, on `UserSubscriptionRepositoryPort`: `listPendingRequests(ownerId):
  Promise<PendingRequestRow[]>`, `approveFreeRequest(id: string, ownerId: string):
  Promise<UserSubscriptionRow | null>`, `rejectRequest(id: string, ownerId: string):
  Promise<boolean>`.
- Produces, on the `MembershipRequests` use case (what routes and tests call):
  `list(ownerId)`, `approve({ ownerId, requestId })`, `reject({ ownerId, requestId })`.
  The two shapes differ on purpose — the repository takes positional ids, the use case
  takes a named object, matching each layer's existing convention in this codebase.

- [ ] **Step 1: Write the failing tests**

```ts
it("approving a pending free request activates it with no period", async () => {
  const row = await requests.approve({ ownerId, requestId });
  expect([row.status, row.kind, row.currentPeriodEnd]).toEqual(["active", "free", null]);
});

it("a second approval of the same request changes nothing", async () => {
  await requests.approve({ ownerId, requestId });
  await expect(requests.approve({ ownerId, requestId })).rejects.toThrow();
});

it("CONCURRENT approvals produce exactly one active row", async () => {
  const results = await Promise.allSettled([
    requests.approve({ ownerId, requestId }),
    requests.approve({ ownerId, requestId }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
});

it("cannot approve someone who already has an active membership", async () => {
  // an active row already exists for (subscriber, owner)
  await expect(requests.approve({ ownerId, requestId })).rejects.toThrow();
  // and it must be a conflict, not a raw database error reaching the caller
});

it("another owner cannot approve a request that is not theirs", async () => {
  await expect(requests.approve({ ownerId: strangerId, requestId })).rejects.toThrow();
});

it("rejecting deletes the row, so the same person may ask again", async () => {
  await requests.reject({ ownerId, requestId });
  expect(await repo.findById(requestId)).toBeNull();
});
```

- [ ] **Step 2: Run and watch fail** — Run: `cd apps/api && bun test src/application/use-cases/membership-requests.test.ts` — Expected: FAIL, module does not exist.

- [ ] **Step 3: Repository writes — conditional, never read-then-write**

```ts
  async approveFreeRequest(id: string, ownerId: string): Promise<UserSubscriptionRow | null> {
    // The WHERE carries the whole rule: this row, this owner, still pending.
    // Two approvals race to one winner and the loser updates zero rows —
    // no read, no gap between checking and writing.
    const [row] = await this.db
      .update(userSubscriptions)
      .set({ status: "active", currentPeriodEnd: null })
      .where(and(
        eq(userSubscriptions.id, id),
        eq(userSubscriptions.ownerId, ownerId),
        eq(userSubscriptions.status, "pending"),
        eq(userSubscriptions.kind, "free"),
      ))
      .returning();
    return row ?? null;
  }
```

`user_subscription_one_active` will reject an approval for somebody who already holds an
active membership. Catch that constraint violation at the use-case boundary and turn it
into a `ConflictError` — a raw driver error must never reach the route.

- [ ] **Step 4: Routes**

```ts
  app.get<"/me/membership-requests">("/me/membership-requests", requireAuth, async (c) =>
    c.json(await deps.membershipRequests.list(c.get("userId"))));

  app.post<"/me/membership-requests/:id/approve">("/me/membership-requests/:id/approve",
    requireAuth, validateParams(requestIdParams), async (c) => {
      const { id } = c.get("validatedParams") as { id: string };
      const row = await deps.membershipRequests.approve({ ownerId: c.get("userId"), requestId: id });
      return c.json(row, 200);
    });

  app.post<"/me/membership-requests/:id/reject">("/me/membership-requests/:id/reject",
    requireAuth, validateParams(requestIdParams), async (c) => {
      const { id } = c.get("validatedParams") as { id: string };
      await deps.membershipRequests.reject({ ownerId: c.get("userId"), requestId: id });
      return c.json({ ok: true }, 200);
    });
```

with, beside the other param schemas in this file:

```ts
const requestIdParams = z.object({ id: uuidParam });
```

Registered with the other STATIC `me/*` routes, before `/:handle`. A malformed `:id` is a
400 from `validateParams`, never a raw uuid-syntax 500 from the driver — the same rule
`routes/posts.ts` and `routes/media.ts` already follow.

The use case throws `NotFoundError` when the row is missing or belongs to someone else —
the same answer for both, so an owner cannot probe which request ids exist. This mirrors
the media routes' "gated and absent look identical from outside".

- [ ] **Step 5: Reserve the handle and register the routes**

Add `"membership-requests"` to `RESERVED_HANDLES` in `apps/api/src/domain/handle.ts`, and
add the three routes to `app.test.ts`'s expected route list. Both guard tests fail
otherwise, which is how you will know you got the paths right.

- [ ] **Step 6: Run the whole api suite** — Run: `cd apps/api && bun test` — Expected: PASS.

- [ ] **Step 7: Mutation-check** — remove `eq(userSubscriptions.status, "pending")` from the WHERE and confirm the double-approval and concurrency tests fail.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(api): an owner approves or rejects a free membership request"
```

---

### Task 6: Telling the profile a request is pending

**Files:**
- Modify: the profile projection that builds `PublicUserProfile.membership`
- Test: its projection test (the closed-shape assertion)

- [ ] **Step 1: Write the failing tests**

```ts
it("reports viewerRequestPending for a viewer whose free request is awaiting approval", async () => {
  expect(view.membership.viewerRequestPending).toBe(true);
});

it("the membership block is exactly these keys", () => {
  expect(Object.keys(view.membership).sort()).toEqual(
    ["tiers", "viewerIsMember", "viewerMembershipEnded", "viewerRequestPending"]
  );
});

it("is false for a signed-out viewer, who cannot have requested anything", async () => {
  expect(view.membership.viewerRequestPending).toBe(false);
});
```

- [ ] **Step 2: Run and watch fail** — Expected: the closed-shape test fails naming the missing key.

- [ ] **Step 3: Add the field** — additive only. The two existing booleans keep their
meaning and their names; spec §6 explains why replacing them with an enum is the wrong
call during a deploy-skew window.

- [ ] **Step 4: Run tests** — Run: `cd apps/api && bun test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(api): the profile reports a pending membership request"
```

---

### Task 7: Settings — free tiers and the requests queue

**Files:**
- Modify: `apps/web/src/user/SettingsPage.tsx`, `apps/web/src/user/apiClient.ts`
- Test: `apps/web/src/user/SettingsPage.test.tsx`

- [ ] **Step 1: Write the failing tests**

```ts
const REQUESTS = [{ id: "req-1", handle: "andi", displayName: "Andi", tierName: "Gratis" }];

it("lists a pending request with the requester's handle", async () => {
  setUserSession("jwt-abc", USER);
  global.fetch = mock(async (url: string) =>
    url === "/users/me/membership-requests" ? jsonResponse(REQUESTS) : jsonResponse(OWN_PROFILE)
  ) as unknown as typeof fetch;

  renderSettings();

  expect(await screen.findByText("@andi")).toBeTruthy();
});

it("approves a request and removes it from the list", async () => {
  setUserSession("jwt-abc", USER);
  const calls: Array<{ url: string; method: string | undefined }> = [];
  let remaining = REQUESTS;
  global.fetch = mock(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method });
    if (url === "/users/me/membership-requests") return jsonResponse(remaining);
    if (url.endsWith("/approve")) { remaining = []; return jsonResponse({ ok: true }); }
    return jsonResponse(OWN_PROFILE);
  }) as unknown as typeof fetch;

  renderSettings();
  fireEvent.click(await screen.findByRole("button", { name: "Setujui" }));

  await waitFor(() => expect(screen.queryByText("@andi")).toBeNull());
  expect(calls.some((c) => c.url === "/users/me/membership-requests/req-1/approve" && c.method === "POST")).toBe(true);
});

it("rejects a request and removes it from the list", async () => {
  // Same shape as the approve test above, with "Tolak" and /reject. Written out
  // rather than shared: these are two different endpoints and a helper that
  // takes the verb as a parameter would pass with either one wired to both.
});

it("says so plainly when there are no pending requests", async () => {
  setUserSession("jwt-abc", USER);
  global.fetch = mock(async (url: string) =>
    url === "/users/me/membership-requests" ? jsonResponse([]) : jsonResponse(OWN_PROFILE)
  ) as unknown as typeof fetch;

  renderSettings();

  expect(await screen.findByText("Belum ada permintaan.")).toBeTruthy();
});

it("lets a creator with no payout account create a free tier", async () => {
  setUserSession("jwt-abc", USER);
  const posted: unknown[] = [];
  global.fetch = mock(async (url: string, init?: RequestInit) => {
    if (url === "/users/me/tiers" && init?.method === "POST") {
      posted.push(JSON.parse(init.body as string));
      return jsonResponse({ id: "t-1", name: "Gratis", priceAmount: 0, billingCycle: "monthly", isActive: true }, 201);
    }
    if (url === "/users/me/membership-requests") return jsonResponse([]);
    return jsonResponse({ ...OWN_PROFILE, payout: { connected: false, available: false } });
  }) as unknown as typeof fetch;

  renderSettings();
  fireEvent.change(await screen.findByLabelText("Nama tingkatan"), { target: { value: "Gratis" } });
  fireEvent.change(screen.getByLabelText("Harga"), { target: { value: "0" } });
  fireEvent.click(screen.getByRole("button", { name: "Buat tingkatan" }));

  await waitFor(() => expect(posted.length).toBe(1));
  expect((posted[0] as { priceAmount: number }).priceAmount).toBe(0);
});
```

Field labels above are the ones the form must carry; if the existing form uses different
Indonesian labels, keep the form's and change these — do not add a second label.

- [ ] **Step 2: Run and watch fail** — Run: `cd apps/web && bun test src/user/SettingsPage.test.tsx`

- [ ] **Step 3: Implement.** Copy in Indonesian: heading **"Permintaan keanggotaan"**,
empty state **"Belum ada permintaan."**, buttons **"Setujui"** and **"Tolak"**. A tier
priced `0` displays as **"Gratis"**, not "Rp 0".

- [ ] **Step 4: Run tests, then the whole web suite and the guards**

Run: `cd apps/web && bun test && bun test src/test`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(web): create a free tier, and act on membership requests"
```

---

### Task 8: The profile offer, and the lock CTA that goes nowhere

**Files:**
- Modify: `apps/web/src/user/MembershipOffer.tsx`, `apps/web/src/user/PostCard.tsx`
- Test: `apps/web/src/user/MembershipOffer.test.tsx`, `apps/web/src/user/PostCard.test.tsx`

- [ ] **Step 1: Write the failing tests**

```ts
const FREE_TIER = { id: "t-free", name: "Gratis", priceAmount: 0, billingCycle: "monthly" };
const PAID_TIER = { id: "t-paid", name: "Pendukung", priceAmount: 50000, billingCycle: "monthly" };

it("offers 'Minta jadi anggota' for a free tier", () => {
  render(<MembershipOffer handle="rina" tiers={[FREE_TIER]} viewerIsMember={false}
    viewerMembershipEnded={false} viewerRequestPending={false} />, { wrapper: Router });

  expect(screen.getByRole("button", { name: "Minta jadi anggota" })).toBeTruthy();
});

it("shows 'Menunggu persetujuan' once a request is pending, and offers no button", () => {
  render(<MembershipOffer handle="rina" tiers={[FREE_TIER]} viewerIsMember={false}
    viewerMembershipEnded={false} viewerRequestPending={true} />, { wrapper: Router });

  expect(screen.getByText("Menunggu persetujuan")).toBeTruthy();
  // The ABSENCE is the point: a second request would be refused by
  // user_subscription_one_pending, so the UI must not invite one.
  expect(screen.queryByRole("button", { name: "Minta jadi anggota" })).toBeNull();
});

it("shows the paid CTA unchanged for a priced tier", () => {
  render(<MembershipOffer handle="rina" tiers={[PAID_TIER]} viewerIsMember={false}
    viewerMembershipEnded={false} viewerRequestPending={false} />, { wrapper: Router });

  expect(screen.getByText("Rp50.000")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Minta jadi anggota" })).toBeNull();
});
```

```ts
// PostCard — the reported bug. `post` is the existing fixture in this file with
// `locked: true` and `lockedMediaCount: 1`.
it("the lock CTA scrolls to the offer when the offer is on this page", () => {
  const scrolled: string[] = [];
  const offer = document.createElement("div");
  offer.id = "membership-offer";
  offer.scrollIntoView = () => scrolled.push("membership-offer");
  document.body.appendChild(offer);

  render(<PostCard post={lockedPost} />, { wrapper: Router });
  fireEvent.click(screen.getByRole("button", { name: "Jadi anggota untuk melihat" }));

  expect(scrolled).toEqual(["membership-offer"]);
});

it("the lock CTA still links to the profile when the offer is not on this page", () => {
  render(<PostCard post={lockedPost} />, { wrapper: Router });

  // No #membership-offer in the document: the feed, not a profile.
  const cta = screen.getByRole("link", { name: "Jadi anggota untuk melihat" });
  expect(cta.getAttribute("href")).toBe("/@rina");
});

it("does not promise membership when the author offers no tier at all", () => {
  render(<PostCard post={{ ...lockedPost, author: { ...lockedPost.author, offersMembership: false } }} />,
    { wrapper: Router });

  expect(screen.getByText("1 foto khusus anggota")).toBeTruthy();
  expect(screen.queryByText("Jadi anggota untuk melihat")).toBeNull();
});
```

**The third test needs a field that does not exist yet.** `PostView.author` carries no
"does this person offer membership" flag, and `PostCard` cannot ask the network. Adding
`offersMembership: boolean` to the author projection is part of THIS task — including its
closed-shape assertion — or the test cannot be written. If that turns out to cost more
than the task is worth, the honest fallback is to drop this third test and the behaviour
with it, and say so, rather than shipping a CTA that lies on a profile with no tiers.

- [ ] **Step 2: Run and watch fail** — Run: `cd apps/web && bun test src/user/MembershipOffer.test.tsx src/user/PostCard.test.tsx`

- [ ] **Step 3: Implement.** The lock CTA is currently
`<Link to={"/@" + post.author.handle} className="post-card-locked-link">`, which is a
no-op when the reader is already on that profile — the reported bug. When the offer is
present on the page, scroll to it; otherwise keep the link. When the author offers no
tier, state that the photos are for members WITHOUT offering a door that does not exist.

- [ ] **Step 4: Run the whole web suite and the guards**

Run: `cd apps/web && bun test && bun test src/test`

- [ ] **Step 5: Typecheck both workspaces**

Run: `cd apps/api && bunx tsc --noEmit; cd ../web && bunx tsc --noEmit`
Check the EXIT CODE, not the last line of output — piping through `tail` or `head`
returns the pipe's status and has already hidden a real failure once in this project.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(web): request a free membership, and a lock CTA that goes somewhere"
```

---

## Manual gate (a human, on real hardware)

Nothing below can be proven by this suite.

1. Create a **free** tier with no payout account connected. It should save.
2. From a second account, open that profile and press **"Minta jadi anggota"**.
   The button becomes **"Menunggu persetujuan"**.
3. As the owner, open Settings → **Permintaan keanggotaan**, press **Setujui**.
4. As the second account, reload the profile: the gated post's photo now **loads**.
   This is the whole feature — a gated photo reaching a member who paid nothing.
5. Sign out entirely and open the same photo URL directly. It must still 404.
6. Confirm a **paid** tier still refuses to be created without a payout account.
