# Memberships 5b Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A membership becomes something a person can keep — an expired one retires so they can buy again, they are reminded before it ends, and an abandoned checkout stops trapping them.

**Architecture:** A new terminal `expired` status frees the `user_subscription_one_active` slot; retirement happens **lazily inside the purchase transaction** and again in a worker pass. Reminders reuse the existing claim-before-send discipline and go out on email plus WhatsApp. `isMemberOf` and Phase 6's gate do not change.

**Tech Stack:** Bun 1.3.14, Hono, drizzle-orm + drizzle-kit, React 19, `bun test`, the existing Resend and Fonnte adapters.

**Spec:** `docs/superpowers/specs/2026-08-21-memberships-5b-design.md` — read it before Task 1. This plan argues from it and does not restate its reasoning.

## Global Constraints

- **`isMemberOf` MUST NOT CHANGE.** Its semantics, its query and its index usage are Phase 6's foundation, already reviewed and mutation-pinned. If a task seems to require changing it, stop and report.
- **`/dashboard/*` and every table it reads are UNTOUCHABLE**: `community`, `membership_tier`, `member`, `subscription`, `transaction`, `creator`. Note `process-renewals.ts` and `process-churn.ts` are theirs — read them as models, never edit them.
- **All user-facing copy is Bahasa Indonesia.** `NotFoundError` messages are English at every call site — absolute; `ValidationError`/`ConflictError` carry Bahasa.
- **A skip is recorded, never silent.** From `process-renewals.ts`: *"the member was never told" is the failure mode of this whole phase, so the one case where it is intentional has to be visible in the audit trail.*
- **`src/test/no-raw-server-errors.test.ts` and `apps/web/src/test/no-hanging-dom-assertions.test.ts` must stay green**, and never put a DOM node on either side of an assertion that can fail — it serialises the element's whole object graph and has taken this machine down once. A render crash can also look like a hang.
- **Concurrency tests: the contender count is part of the assertion.** Four proved far too few against a conditional UPDATE in 5a; whatever number you use must be measured and recorded beside it.
- **Tests assert literal values**, never the constant they check.
- **TDD.** Write the test, watch it fail *for its own reason*. A file that fails to LOAD is not a red phase — stub first.
- **The Bash tool auto-backgrounds anything past 120 seconds and a backgrounded run never wakes you.** The api suite is ~300 s: pass `timeout: 400000`. Run it once before committing.
- **Commit before mutation-testing.**
- **Never run a dev server, bind a port, or drive a browser.** The owner runs the gate (Task 8).

---

## Task 1: The `expired` status and retirement in the repository

**Files:**
- Modify: `apps/api/src/db/schema.ts` (the `userSubscriptions` status comment only)
- Modify: `apps/api/src/application/ports/user-subscription-repository.port.ts`
- Modify: `apps/api/src/infrastructure/repositories/drizzle-user-subscription.repository.ts`
- Test: `apps/api/src/infrastructure/repositories/drizzle-user-subscription.repository.test.ts`

**Interfaces:**
- Consumes: `userSubscriptions` (5a), `DatabaseExecutor`.
- Produces: `retireExpired(subscriberId, ownerId, now): Promise<boolean>` and `listExpiredActive(now, limit): Promise<UserSubscriptionRow[]>`.

**No migration.** `status` is a varchar precisely so a new value needs none — the comment on it records that reasoning for `past_due`/`churned`, and `expired` is the same case. Update the comment; do not add a migration.

- [ ] **Step 1: Write the failing tests**

```ts
it("retires an ACTIVE subscription whose period has passed, and frees the active slot", async () => {
  const { subscriberId, ownerId } = await seedActiveSubscription({ periodEnd: PAST });

  expect(await subs.retireExpired(subscriberId, ownerId, NOW)).toBe(true);

  // The whole point: the partial unique index no longer holds the slot.
  const fresh = await subs.create({ subscriberId, tierId, ownerId });
  await subs.activate(fresh.id, FUTURE);
  expect((await subs.findActiveFor(subscriberId, ownerId))?.id).toBe(fresh.id);
});

it("does NOT retire a subscription whose period is still running", async () => {
  const { subscriberId, ownerId } = await seedActiveSubscription({ periodEnd: FUTURE });
  expect(await subs.retireExpired(subscriberId, ownerId, NOW)).toBe(false);
  expect(await subs.findActiveFor(subscriberId, ownerId)).not.toBe(null);
});

it("lists expired active subscriptions for the sweep, and excludes live ones", async () => {
  // Seed one expired, one live. Assert only the expired id comes back.
});
```

`PAST`, `NOW` and `FUTURE` are literal dates in the test — not derived from the implementation.

- [ ] **Step 2: Run them, watch them fail for their own reasons**

A missing method is a load failure, not a red phase. Stub `retireExpired` and `listExpiredActive` to throw, re-run, and confirm each test fails on its own assertion.

- [ ] **Step 3: Implement**

`retireExpired` is a **conditional UPDATE** — `set status = 'expired' where subscriber_id = … and owner_id = … and status = 'active' and current_period_end <= now`, returning whether a row moved. Do not read-then-write: 5a established three times that the database must arbitrate.

- [ ] **Step 4: Run the covering file, then the api suite once (`timeout: 400000`), then commit**

---

## Task 2: Lazy retirement inside the purchase transaction

**Files:**
- Modify: `apps/api/src/application/use-cases/start-user-subscription.ts`
- Test: `apps/api/src/application/use-cases/start-user-subscription.test.ts`, `apps/api/src/routes/users.test.ts`

**Interfaces:**
- Consumes: `retireExpired` (Task 1).
- Produces: no new exports; a behaviour change to the purchase path.

**Read `start-user-subscription.ts` in full first.** Its refusal at the `findActiveFor` guard, its `claimPending` call and the `try` spanning claim → transaction → invoice → attach are all load-bearing and were each fixed under review. You are adding to that path, not rearranging it.

- [ ] **Step 1: Write the failing tests**

```ts
it("a member whose period has ENDED can buy again, in one request", async () => {
  const { subscriberId, ownerId, tierId } = await seedActiveSubscription({ periodEnd: PAST });

  const result = await startUserSubscription.execute({ subscriberId, handle, tierId });

  expect(result.invoiceUrl).toBeTruthy();
  // The old row retired, a new pending one claimed — not two active rows.
  expect(await subs.findActiveFor(subscriberId, ownerId)).toBe(null);
});

it("a member whose period is STILL RUNNING is still refused, in Bahasa", async () => {
  const { subscriberId, handle, tierId } = await seedActiveSubscription({ periodEnd: FUTURE });

  await expect(startUserSubscription.execute({ subscriberId, handle, tierId }))
    .rejects.toThrow(/sudah menjadi anggota aktif/);
});
```

- [ ] **Step 2: Write the concurrency test — this is the one that matters**

Two simultaneous purchases by a member whose row has just expired must produce **one** pending claim and one invoice, not two. Use the `ArrivalLatch` helper the payout tests use.

**Pick the contender count by measurement, not habit.** 5a's F1 found that four contenders let a broken implementation win often enough to look correct, and the repository race there needed 30. Run your mutant at several counts, use one that reddens reliably, and **record the measurement in a comment beside the number** with "do not lower this".

- [ ] **Step 3: Run, watch fail, implement**

Retire inside the same transaction as the pending claim, before it. A retirement that commits separately from the claim can leave a member with neither an active membership nor a pending checkout.

- [ ] **Step 4: Mutation-check before committing**

Remove the lazy retirement and confirm the "can buy again" test reddens. Move it outside the claim's transaction and confirm the concurrency test reddens. Restore both.

- [ ] **Step 5: Run the api suite once, then commit**

---

## Task 3: The retirement sweep

**Files:**
- Modify: `apps/worker/src/scheduled-passes.ts`, `apps/worker/src/main.ts`
- Test: `apps/worker/src/scheduled-passes.test.ts`

**Interfaces:**
- Consumes: `listExpiredActive`, `retireExpired` (Task 1).
- Produces: a pass in the shape of `SweepOrphanMedia`, with a `format…PassLine` helper.

**Read `SweepOrphanMedia` in that file first** — Phase 4's orphan sweep is the closest model, including how it survives a per-row failure and how its log line reads.

- [ ] **Step 1: Write the failing tests**

Expired-active rows are retired; live ones are untouched however old; **one row's failure does not abort the pass**, and the failure is visible in the log line. The boundary is tested in both directions — a row one second past its period is retired, one second before is not.

- [ ] **Step 2: Run, watch fail, implement, then run the worker suite and commit**

---

## Task 4: Reminders

**Files:**
- Create: `apps/api/src/application/use-cases/remind-expiring-membership.ts`
- Create: `apps/api/src/application/ports/membership-reminder-repository.port.ts`
- Create: `apps/api/src/infrastructure/repositories/drizzle-membership-reminder.repository.ts`
- Modify: `apps/api/src/db/schema.ts`, `apps/worker/src/scheduled-passes.ts`, `apps/worker/src/main.ts`, `apps/api/src/bootstrap.ts`
- Test: alongside each.

**Interfaces:**
- Consumes: `EmailProviderPort.send`, `MessagingProviderPort.notify`, `UserSubscriptionRepositoryPort`.
- Produces: `RemindExpiringMembership`, and a claim table so a reminder is sent once.

**Read `apps/api/src/application/ports/renewal-reminder-repository.port.ts` before designing the claim.** Its docstring explains why the only way to learn whether a reminder was already claimed is to *claim it* — a read-then-send races itself, and this is the same problem.

- [ ] **Step 1: Write the failing tests**

The four that carry this task:

```ts
it("sends to EMAIL always, and to WhatsApp as well when the member has a number", async () => { /* ... */ });

it("sends to email only when the member has no WhatsApp number", async () => {
  // app_user.whatsapp_number is nullable — signup offers it and never requires it.
});

it("RECORDS a skip when neither channel can deliver, rather than passing over it silently", async () => {
  // Both adapters are optional at boot. "the member was never told" is the failure
  // mode this pass exists to prevent, so the intentional case must be visible.
});

it("claims before sending, so a pass that runs twice reminds once", async () => {
  // Two passes over the same subscription produce exactly one send per channel.
});
```

- [ ] **Step 2: Run, watch fail, implement**

Claim first, then send. A send failure on one channel must not prevent the other, and must not lose the claim in a way that reminds twice on the next pass — decide which way that falls and say so in the report.

- [ ] **Step 3: Run the api and worker suites, then commit**

---

## Task 5: Pending-checkout cleanup

**Files:**
- Modify: `apps/api/src/application/ports/user-subscription-repository.port.ts`, `apps/api/src/infrastructure/repositories/drizzle-user-subscription.repository.ts`, `apps/worker/src/scheduled-passes.ts`, `apps/worker/src/main.ts`
- Test: alongside each.

**Interfaces:**
- Produces: `listStalePending(cutoff, limit)`, `expireStalePending(id)`, and a pass.

This closes what 5a's final review called the phase's most likely real-world money loss, and **it needs no failure at all to reach**: an abandoned cart returned to a day later is handed back the same now-expired invoice with a dead payment page, permanently.

- [ ] **Step 1: Write the failing tests**

```ts
it("expires a pending subscription older than the window, freeing the pending slot", async () => {
  // After expiry, a fresh purchase mints a NEW invoice rather than handing back the dead one.
  // That last assertion is the point of the task — assert the new invoice url differs.
});

it("leaves a pending subscription INSIDE the window alone — somebody is mid-payment", async () => { /* ... */ });
```

**Test the boundary in both directions.** A test with only clearly-stale rows passes against a window of any length, including one so short it cancels purchases in progress.

- [ ] **Step 2: Run, watch fail, implement**

The window must be **longer than a person's checkout and shorter than an invoice's life at the provider**. Name it as a constant with that reasoning in a comment.

- [ ] **Step 3: Run the api and worker suites, then commit**

---

## Task 6: The subscriber list

**Files:**
- Modify: `apps/api/src/application/ports/user-subscription-repository.port.ts`, `apps/api/src/infrastructure/repositories/drizzle-user-subscription.repository.ts`, `apps/api/src/routes/users.ts`, `apps/web/src/user/apiClient.ts`, `apps/web/src/user/SettingsPage.tsx` or the membership section
- Test: alongside each.

**Interfaces:**
- Produces: `GET /users/me/subscribers` → `{ subscribers: [{ handle, displayName, since }] }`.

- [ ] **Step 1: Write the failing tests**

**The projection is closed and the endpoint is owner-only.** Never an email, never a `whatsapp_number`, never a payout id, never a subscriber's memberships to anyone else. Assert the keys with `Object.keys(...).sort()`, not a spot-check. A test must prove another signed-in user cannot read your subscriber list.

Only **currently active** subscribers appear — an expired one is a past subscriber, and §4's retirement means those rows now exist.

- [ ] **Step 2: Run, watch fail, implement**

`subscribers` is a new literal segment under `/users/me/`, whose first segment is `me` — already unregisterable at two characters — so **it needs no reserved handle.** Run the route-derived guard before and after mounting and confirm it stays green.

- [ ] **Step 3: Run both suites and typecheck, then commit**

---

## Task 7: `whatsapp_number` reaching join-request notifications

**Files:**
- Modify: `apps/api/src/application/use-cases/notify-join-request.ts`
- Test: `apps/api/src/application/use-cases/notify-join-request.test.ts`

Parent spec §7. A community owner receives no notification when somebody asks to join, because `creator.whatsapp_number` exists and is unreachable. The fix reads the owner's number from `app_user`, where Phase 1 already built the field and made it editable.

**This is unrelated to memberships.** It is here because §8 assigned it to Phase 5 and it is small.

- [ ] **Step 1: Write the failing tests**

An owner with a number is notified; an owner without one is **skipped with a record**, not silently passed over; and the existing behaviour for everything else is unchanged.

- [ ] **Step 2: Run, watch fail, implement**

**`/dashboard/*`'s tables are untouchable** — you are reading `app_user`, not changing `creator`. If the wiring seems to require touching the community-scoped tables, stop and report.

- [ ] **Step 3: Run the api suite once, then commit**

---

## Task 8: The gate — for the project owner

**Do not run this.** It binds ports and moves real money.

Write `docs/superpowers/sdd/2026-08-21-memberships-5b/gate-checklist.md`, ordered so the unproven things come first:

- **A membership that lapses and is bought again** — the phase's whole point, and the first time that path has ever run end to end.
- **A reminder actually arriving**, by email and by WhatsApp, against real adapters.
- **An abandoned checkout returned to after the window** — a fresh invoice, not the dead one.
- That **5a's behaviours still hold**: one invoice per double-tap, the webhook still activating, community checkout untouched.

---

## Self-Review

**Spec coverage:** §4 → Tasks 1, 2, 3. §5 is a removal, nothing to build. §6 → Task 4. §7 → Task 5. §8 → Task 6. §9 → Task 7. §10 is a guarantee, enforced by the Global Constraint that `isMemberOf` must not change. §11's three testing requirements are carried into Tasks 2, 4 and 5 respectively.

**Type consistency:** `retireExpired` and `listExpiredActive` (Task 1) are consumed unchanged in Tasks 2 and 3. `listStalePending`/`expireStalePending` (Task 5) are used only there. The wire shape `{ handle, displayName, since }` appears only in Task 6.

**Known gap, deliberate and stated:** Tasks 3, 6 and 7 carry test *names* and rules rather than full bodies — 3 and 7 because they follow mechanically from patterns named in the task, 6 because its markup does not exist yet. Every task that touches money or concurrency (1, 2, 4, 5) carries real code. Phase 4 and 5a both found their thinnest briefs needed the most fix rounds; expect the same.
