# Phase 5: Renewals & Churn — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A member who stops paying is reminded, then loses Telegram access automatically. A
member who renews keeps it without interruption and without a second invite link.

**Architecture:** Two new scheduled passes in the existing `apps/worker`, driven by an
**injected clock**. Reminders and revocations go through Phase 4's **existing outbox**, so they
inherit its bounded retries and idempotency rather than growing a parallel mechanism.
Reminder-once is arbitrated by a unique `(subscription_id, stage)` constraint.

**Tech Stack:** Bun, Hono, PostgreSQL 16, Drizzle, `bun:test`. No new workspace — reuses
`apps/worker` and its `PollLoop`.

## Global Constraints

From `docs/superpowers/specs/2026-08-09-phase5-renewals-churn-design.md` and inherited from
Phases 1-4. Every task's work implicitly includes these:

- **Time is injected, never read from `Date.now()` inside a use-case.** Tests set the clock.
  This is the phase's defining constraint: every prior phase was request-triggered, this one is
  clock-triggered.
- **A missed window is caught up, not replayed.** A job that has not run for three days sends
  the **most advanced** applicable reminder **once**, never one per skipped stage.
- **The grace deadline is stored, not recomputed.** `grace_ends_at` is written when a
  subscription enters `past_due`, so a later timezone or config change cannot retroactively move
  someone's deadline.
- **Renewal timestamps are interpreted in Asia/Jakarta**, in one documented place. Phase 3
  deferred this drift on `next_billing_date`; here it decides whether a paying member loses
  access a day early.
- **Reminder idempotency is arbitrated by the database** — `renewal_reminder` unique on
  `(subscription_id, stage)`. Phase 4's credential leak came from an idempotency claim that was
  true of our table but not of the world; here the claim must be true of the **member's inbox**.
- **Counting is the test.** Assert counts of reminders sent, `activity_log` rows, outbox rows
  and **provider mints** — not final state. Phase 4 shipped a five-credential leak past a test
  that asserted final state only.
- **Concurrency pinned deterministically.** A bare `Promise.all` has produced a false pass
  three times in this project. Force the interleaving, or assert the emitted SQL.
- **`grantAccess` never silently no-ops**; an adapter that cannot gate throws. Invite links are
  **bearer credentials** — never in a log, an error, or any response but the member's
  notification. At most **one live invite link per (member, channel)** may exist at the
  provider, and every link that exists is recorded (spec §4.2, Phase 4).
- **No new invite on renewal.** A member who never left the group must not be re-invited —
  that would mint a second credential.
- Ports-and-adapters; Drizzle only; **generated** migrations only; never edit an applied
  migration (`0000`-`0010`).
- Creator-scoped access, **404 not 403**, for creator-facing routes. System-initiated paths use
  the separate entry point in Task 5 and are **not** creator-scoped.
- `NODE_ENV` **allowlist**: only exactly `development`/`test` may relax a guard; everything else
  including `undefined` throws. Probing an env guard requires `bun --no-env-file` (Bun re-loads
  `apps/api/.env` and silently overrides `env -u`).
- Bun throughout; root `bun run test` and `bun run typecheck` green across four workspaces.
- Tests use `resetDatabase()`; add every new table to its delete list.
- **Before running the suite, check for a bun process.** A concurrent root suite gives ~140
  spurious failures and a running worker steals outbox rows. Distinguish pollution from a flake.

## Facts about the existing code — use these rather than rediscovering them

- `apps/worker/src/poll-loop.ts` exports `PollLoop`, which already guarantees non-overlapping
  passes and wakes immediately on `stop()` for SIGTERM. **Reuse it**; do not write a scheduler.
- Subscription statuses currently in use: `pending`, `active`, `cancelled`, `superseded`.
  **`past_due` and `churned` are new in this phase.**
- `computeNextBillingDate(paidAt, billingCycle)` already exists and is called from
  `drizzle-subscription.repository.ts` — reuse it for advancing a renewed subscription.
- Phase 4's outbox handles `grant_access` and `revoke_access`. This phase adds
  `send_renewal_reminder`. `ProcessOutbox` dispatches by `eventType`; an unregistered type fails
  with a clear error and bounded retries.
- Phase 3's `StartCheckout` rejects a second purchase with **409 when an `active` subscription
  exists for the tier**. It must **not** block a `past_due` member from renewing — this is the
  interaction most likely to be got wrong.

---

### Task 1: `ClockPort` and the Asia/Jakarta boundary

**Files:**
- Create: `apps/api/src/application/ports/clock.port.ts`
- Create: `apps/api/src/infrastructure/clock/system.clock.ts`
- Create: `apps/api/src/infrastructure/clock/fixed.clock.ts`
- Create: `apps/api/src/domain/renewal-schedule.ts`
- Test: `apps/api/src/domain/renewal-schedule.test.ts`
- Test: `apps/api/src/infrastructure/clock/fixed.clock.test.ts`

**Interfaces:**
- `ClockPort` — `now(): Date`
- `SystemClock` (production), `FixedClock` (tests; `set(date)`, `advance(ms)`)
- `renewal-schedule.ts` — pure functions, no imports:
  - `REMINDER_STAGES` — ordered `["pre_3d", "due", "overdue_1d", "overdue_3d", "overdue_7d"]`
  - `dueStageFor(nextBillingDate, now): Stage | null` — the **most advanced** applicable stage,
    which is what makes a missed window a catch-up rather than a replay
  - `computeGraceEndsAt(nextBillingDate)` — due date + 7 days
  - `isPastGrace(graceEndsAt, now)`

**The whole phase's correctness rests on `dueStageFor`.** It must return one stage, not a list.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/domain/renewal-schedule.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import {
  REMINDER_STAGES,
  computeGraceEndsAt,
  dueStageFor,
  isPastGrace,
} from "./renewal-schedule";

/** 2026-03-10 00:00 Asia/Jakarta (UTC+7) === 2026-03-09T17:00:00Z */
const DUE = new Date("2026-03-09T17:00:00.000Z");
const day = (n: number) => new Date(DUE.getTime() + n * 86_400_000);

describe("dueStageFor", () => {
  it("returns null well before the reminder window", () => {
    expect(dueStageFor(DUE, day(-10))).toBeNull();
  });

  it("returns pre_3d three days before the due date", () => {
    expect(dueStageFor(DUE, day(-3))).toBe("pre_3d");
  });

  it("returns due on the due date", () => {
    expect(dueStageFor(DUE, DUE)).toBe("due");
  });

  it("escalates through the overdue stages", () => {
    expect(dueStageFor(DUE, day(1))).toBe("overdue_1d");
    expect(dueStageFor(DUE, day(3))).toBe("overdue_3d");
    expect(dueStageFor(DUE, day(7))).toBe("overdue_7d");
  });

  it("returns the MOST ADVANCED stage after a missed window, not each skipped one", () => {
    // The job was down from before pre_3d until day 4. The member must receive
    // overdue_3d once — not pre_3d, due and overdue_1d in a burst.
    expect(dueStageFor(DUE, day(4))).toBe("overdue_3d");
  });

  it("stays at the final stage past day 7 rather than inventing a new one", () => {
    expect(dueStageFor(DUE, day(30))).toBe("overdue_7d");
  });

  it("does not treat 00:30 Asia/Jakarta on the due date as the previous day", () => {
    // 2026-03-10 00:30 WIB === 2026-03-09T17:30:00Z. Phase 3 deferred this drift;
    // here it decides whether a paying member loses access a day early.
    const justAfterMidnightWib = new Date("2026-03-09T17:30:00.000Z");
    expect(dueStageFor(DUE, justAfterMidnightWib)).toBe("due");
  });

  it("does not treat 23:30 Asia/Jakarta the day before as already due", () => {
    // 2026-03-09 23:30 WIB === 2026-03-09T16:30:00Z, still the 9th locally.
    const lateNightBefore = new Date("2026-03-09T16:30:00.000Z");
    expect(dueStageFor(DUE, lateNightBefore)).toBe("pre_3d");
  });
});

describe("REMINDER_STAGES", () => {
  it("is ordered from earliest to latest", () => {
    expect(REMINDER_STAGES).toEqual(["pre_3d", "due", "overdue_1d", "overdue_3d", "overdue_7d"]);
  });
});

describe("computeGraceEndsAt", () => {
  it("is seven days after the due date", () => {
    expect(computeGraceEndsAt(DUE).toISOString()).toBe(day(7).toISOString());
  });
});

describe("isPastGrace", () => {
  it("is false before and at the deadline, true after", () => {
    const grace = computeGraceEndsAt(DUE);
    expect(isPastGrace(grace, day(6))).toBe(false);
    expect(isPastGrace(grace, grace)).toBe(false);
    expect(isPastGrace(grace, new Date(grace.getTime() + 1))).toBe(true);
  });
});
```

Create `apps/api/src/infrastructure/clock/fixed.clock.test.ts` asserting `set` and `advance`
behave, and that `now()` returns a **copy** so a caller mutating the result cannot move the
clock.

- [ ] **Step 2: Run to verify they fail**

```bash
cd apps/api && bun test src/domain/renewal-schedule.test.ts src/infrastructure/clock
```

Expected: FAIL — neither module exists.

- [ ] **Step 3: Implement**

`ClockPort` is one method; `SystemClock` returns `new Date()`; `FixedClock` holds a mutable
instant. `renewal-schedule.ts` imports nothing.

For the timezone work: convert both instants to an **Asia/Jakarta calendar date** and compare
whole days, rather than subtracting milliseconds — that is what makes the 00:30 and 23:30 cases
come out right. Put the conversion in **one** exported helper with a comment explaining why,
and note that `Intl.DateTimeFormat` with `timeZone: "Asia/Jakarta"` handles it without a
dependency (Indonesia has no DST, but do not rely on that — the helper should be correct
regardless).

- [ ] **Step 4: Verify and commit**

```bash
bun test src/domain/renewal-schedule.test.ts src/infrastructure/clock
cd ../.. && bun run test && bun run typecheck
git add apps/api/src/application/ports/clock.port.ts apps/api/src/infrastructure/clock apps/api/src/domain/renewal-schedule.ts apps/api/src/domain/renewal-schedule.test.ts
git commit -m "feat(renewals): add an injectable clock and the Asia/Jakarta reminder schedule"
```

---

### Task 2: Schema — `past_due`, `grace_ends_at`, `renewal_reminder`

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Modify: `apps/api/src/db/test-helpers.ts`
- Test: `apps/api/src/db/schema-phase5.test.ts`

**Interfaces:**
- `subscriptions.graceEndsAt` — timestamptz, nullable (set on entering `past_due`)
- New `renewalReminders` table — `id`, `subscriptionId`, `stage`, `sentAt`, with a **unique
  `(subscription_id, stage)`**
- `resetDatabase()` clears it, before `subscriptions`

**The unique constraint is the reminder-once mechanism.** It must exist in the **database**, not
only in the Drizzle definition. The test asserts a real violation — Phase 4 proved a mutant can
survive when the test checks the wrong layer.

- [ ] **Steps:** failing test (a second insert for the same `(subscription_id, stage)` raises;
  `graceEndsAt` defaults null) → implement → `bun run db:generate` and `db:migrate` → verify the
  unique index exists in **live Postgres** via `\d renewal_reminder` → root gates green →
  commit `"feat(db): add grace deadline and renewal_reminder table"`.

---

### Task 3: `ProcessRenewals`

**Files:**
- Create: `apps/api/src/application/ports/renewal-reminder-repository.port.ts`
- Create: `apps/api/src/infrastructure/repositories/drizzle-renewal-reminder.repository.ts`
- Create: `apps/api/src/application/use-cases/process-renewals.ts`
- Modify: `apps/api/src/application/ports/subscription-repository.port.ts` +
  `drizzle-subscription.repository.ts` (find-due, mark-past-due)
- Test: `apps/api/src/application/use-cases/process-renewals.test.ts`
- Test: `apps/api/src/infrastructure/repositories/drizzle-renewal-reminder.repository.test.ts`

**Interfaces:**
- `RenewalReminderRepositoryPort.recordIfNew({ subscriptionId, stage })` → `boolean`,
  implemented with `onConflictDoNothing` so the **database** arbitrates
- `findDueForRenewal({ before, limit })` — subscriptions in `active` or `past_due` whose
  `next_billing_date` is inside the reminder window
- `markPastDue(subscriptionId, graceEndsAt)`
- `ProcessRenewals.execute()` — for each due subscription: compute the stage via `dueStageFor`;
  `recordIfNew`; if newly recorded, enqueue a `send_renewal_reminder` outbox row and write an
  `activity_log` entry; transition `active` → `past_due` with `grace_ends_at` on the `due` stage.

**The tests that matter:**
- **Running the pass twice sends one reminder.** Assert counts of `renewal_reminder` rows,
  outbox rows and `activity_log` rows — not final subscription state.
- **A job down for three days sends exactly one reminder**, at the most advanced stage.
- **`grace_ends_at` is written once** and a later pass does not move it.
- An `archived` community gets no reminder, recorded in `activity_log`.
- Two concurrent passes do not double-send — pinned **deterministically**, not with
  `Promise.all`.

Time comes from the injected `ClockPort` in every test.

- [ ] **Steps:** failing tests → implement → mutation-check the `recordIfNew` conflict clause
  (rewrite as select-then-insert; a test must fail **every** run across ≥5 runs) and the
  most-advanced-stage logic → root gates green → commit
  `"feat(renewals): add the renewal reminder pass"`.

---

### Task 4: Reminder delivery through the outbox

**Files:**
- Create: `apps/api/src/application/use-cases/send-renewal-reminder.ts`
- Modify: `apps/api/src/bootstrap.ts` and `apps/worker/src/*` (register the handler)
- Test: `apps/api/src/application/use-cases/send-renewal-reminder.test.ts`

**Interfaces:**
- Handles outbox `eventType: "send_renewal_reminder"`; resolves member, tier and community;
  sends a WhatsApp message via the **notify-capable** provider containing a **fresh checkout
  link** to `/c/:slug`.

**Requirements:**
- The link is built from the same configured base URL Phase 3 uses for
  `success_redirect_url` — do not hardcode a host.
- The message names the community and the amount, in **Indonesian** (this is an Indonesian
  product and every member-facing string so far is Indonesian).
- Notification goes through the **WhatsApp** provider. `TelegramBotAdapter.notify` **throws** —
  routing a reminder there is a bug Phase 4 already guarded against.
- A provider failure retries via the outbox and does **not** delete the `renewal_reminder` row —
  the row means "this stage is claimed", and re-sending on retry is acceptable, while
  re-claiming would let a later pass send the same stage twice. State this in a comment.
- Nothing in the message or any log line may contain an invite link.

- [ ] **Steps:** failing tests → implement → verify a Telegram-only community's reminder still
  reaches the member via WhatsApp → root gates green → commit
  `"feat(renewals): deliver renewal reminders with a fresh checkout link"`.

---

### Task 5: `ProcessChurn` and system-initiated revocation

**Files:**
- Create: `apps/api/src/application/use-cases/process-churn.ts`
- Modify: `apps/api/src/application/use-cases/revoke-channel-access.ts` (add the system entry point)
- Test: `apps/api/src/application/use-cases/process-churn.test.ts`
- Test: `apps/api/src/application/use-cases/revoke-channel-access.test.ts` (extend)

**Interfaces:**
- `RevokeChannelAccessForSystem.execute({ subscriptionId })` — **no `creatorId`, no scoping
  check**, because there is no untrusted caller to authorize (spec §5). Shares the provider
  removal and audit logic with the creator-facing path.
- `ProcessChurn.execute()` — finds `past_due` subscriptions past `grace_ends_at`, marks them
  `churned`, enqueues a `revoke_access` outbox row, writes `activity_log`.

**Requirements:**
- **Do not** satisfy the creator-scoping check by having the worker look up a creator id. Two
  entry points, two honest trust models. Add a comment saying so, because the tempting shortcut
  is what the spec explicitly rejected.
- Running the pass twice churns once and enqueues one revoke row — assert counts.
- A subscription that was paid **on day 5** is `active` by the time churn runs and must be
  **skipped**.
- Revocation reuses Phase 4's outbox path, so a provider failure retries.
- The creator-facing `RevokeChannelAccess` must still 404 for a stranger — assert the existing
  tests still pass, and mutation-check that the system path did not accidentally remove the
  creator-facing scoping.

- [ ] **Steps:** failing tests → implement → mutation-check that removing creator scoping from
  the **creator-facing** path fails a test (proving the two paths did not collapse into one) →
  root gates green → commit `"feat(churn): revoke access automatically past the grace deadline"`.

---

### Task 6: Renewal payment — extend, don't duplicate

**Files:**
- Modify: `apps/api/src/application/use-cases/start-checkout.ts`
- Modify: `apps/api/src/application/use-cases/handle-payment-webhook.ts` and/or
  `drizzle-subscription.repository.ts`
- Test: `apps/api/src/routes/checkout.test.ts` (extend)
- Test: `apps/api/src/application/use-cases/renewal-payment.test.ts`

**This is the task most likely to be got wrong, and its failure modes are the worst.**

**Requirements:**
- Phase 3's "already has an `active` subscription for this tier → 409" must **not** block a
  **`past_due`** member from renewing. Currently it checks only `active`, so verify — do not
  assume — and add a test proving a `past_due` member gets a checkout, not a 409.
- Paying while `past_due` → back to `active`, `next_billing_date` advanced via the existing
  `computeNextBillingDate`, `grace_ends_at` cleared, and **no new invite issued.** Assert **zero
  provider mints** — count links at the provider, the way Phase 4 learned to. A second invite
  would violate the one-live-link invariant.
- Paying **after** `churned`/revocation → a genuinely new grant, which needs
  `unbanChatMember` first. Phase 4 built that path; this is its first real use. Assert the
  adapter received the unban before the invite.
- Reminder rows for the completed period must not block the **next** period's reminders. Decide
  how (scope the stage key to a period, or clear rows on renewal) and **say which** — getting
  this wrong means a renewed member is never reminded again, and the bug would be invisible for
  a full billing cycle.

- [ ] **Steps:** failing tests → implement → root gates green → commit
  `"feat(renewals): let a past-due member renew without a second invite"`.

---

### Task 7: Wire the two passes into the worker

**Files:**
- Modify: `apps/worker/src/main.ts`, `apps/worker/src/worker-bootstrap.ts`
- Test: `apps/worker/src/*.test.ts`

**Requirements:**
- Reuse the existing `PollLoop` — it already guarantees non-overlapping passes and wakes on
  `stop()` for SIGTERM. **Do not write a scheduler.**
- The renewal and churn passes run on a **much longer interval** than the outbox pass (which is
  5s for invite latency). Daily-ish is right for reminders; pick a value, and make it
  configurable with a documented default explaining the reasoning, as `DEFAULT_POLL_INTERVAL_MS`
  does.
- A throwing pass must not kill the process — the rows are still in the database and the next
  pass is their retry. Confirm the existing `onError` handling covers the new passes.
- Log lines carry **ids and counts only** — no payer PII, no invite links. Phase 4 found bound
  SQL parameters reaching the worker's log; the sanitising helper exists, so use it.
- The worker must still start and exit cleanly. Phase 4 found it dying at import on
  `DATABASE_URL` and hanging on SIGTERM — **start the process and confirm both**, don't infer it.

- [ ] **Steps:** failing tests → implement → **run the worker** and confirm startup, one pass of
  each type, and clean SIGTERM exit → root gates green → commit
  `"feat(worker): schedule the renewal and churn passes"`.

---

### Task 8: Carry-forward — test isolation

**Files:** `apps/api/src/db/*`, root config, plus a new `CONTRIBUTING.md`.

Phase 4's ledger: test isolation is per-`DATABASE_URL`. Two concurrent root suites give ~140
spurious failures, and a running worker steals the suite's outbox rows. This phase adds more
worker-touching tests and will hit it harder — three phases have now lost time to
unreproducible failures that were this.

**Fix it:** a per-run schema or database, so a concurrent suite or a running worker cannot
interfere. Then **prove it**: run two suites concurrently and confirm both pass, and run the
suite with the worker running and confirm it passes.

Also write `CONTRIBUTING.md` (none exists) covering: the `.env` setup for all four workspaces,
that `TELEGRAM_WEBHOOK_SECRET` must be `openssl rand -hex 32` (base64 is rejected at boot),
that Telegram channels need the **numeric** chat id, that the worker must be running for
invites to arrive, and the migration hazards already recorded in `apps/api/drizzle/README.md`.

- [ ] **Steps:** implement → prove with two concurrent runs and a worker-running run → commit
  `"test: isolate each test run, and document local setup"`.

---

### Task 9: End-to-end verification and the phase gate

Not a coding task. **Fix whatever it surfaces.**

- [ ] Root `bun run test` and `bun run typecheck` green across four workspaces.
- [ ] Start Postgres, the API, the worker and the web app. Confirm each stays up.
- [ ] With the clock driven forward (inject it, or seed `next_billing_date` in the past —
      **say which**), walk the whole lifecycle and record actual output:
  1. a member pays and is granted access (Phase 4 path still works)
  2. advance to 3 days before renewal → one WhatsApp reminder with a working checkout link
  3. advance to the due date → subscription `past_due`, `grace_ends_at` set
  4. advance through day 1 and 3 → escalating reminders, **one per stage**
  5. **pay on day 5** → back to `active`, `next_billing_date` advanced, **zero new invite
     links minted at the provider**, still in the group
  6. for a second member, let the grace period lapse → `churned`, `revoke_access` enqueued, the
     worker removes them, `banChatMember` called with the recorded id
  7. that member pays again → `unbanChatMember` **then** a fresh invite
- [ ] Run each pass **twice** and confirm counts do not double: reminders, `activity_log`,
      outbox rows.
- [ ] Confirm **no invite link and no payer PII** in any log line from the whole run.
- [ ] Run the full suite **5 times**, no flakes (Task 8 should make this trustworthy).
