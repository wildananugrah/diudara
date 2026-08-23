# Phase 8 — Retire Telegram Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the old Telegram-and-communities world, leaving the new user-scoped one alone.

**Architecture:** The old world is a closed island — no foreign key points into it from any new-world table — so almost all of this is deletion. Three files serve **both** worlds and get surgery instead: the Xendit webhook, the stream authoriser, and `activity_log`'s writers. The tables themselves stay, and `schema.ts` is untouched, which is the mechanism that keeps them.

**Tech Stack:** Bun 1.3.14, Hono, drizzle-orm, Postgres, React 19 + Vite, `bun test`.

**Spec:** `docs/superpowers/specs/2026-08-23-retire-telegram-design.md`

## Global Constraints

- **`schema.ts` is UNTOUCHED this phase.** Drizzle diffs it against its snapshot; removing the old table definitions makes the next `db:generate` emit the drops we deliberately deferred. **After every task, `bun run db:generate` must produce NO migration** — that is the proof nothing dropped a table by accident.
- **`isMemberOf` must not change** — `apps/api/src/application/use-cases/is-member-of.ts` is byte-identical to its Phase 5a form and pinned by an `EXPLAIN` test.
- **The four new-world flows must keep working**: compose and read a gated post; buy a membership; go live and watch; every remaining worker pass.
- **A falling test count is NOT the signal.** Tests disappear with the code they cover. The signals are: typecheck green in all four workspaces, no import resolving into a deleted module, `db:generate` silent, and the new-world flows passing.
- **Prove each seam from the diff, not the suite.** A behaviour with no test moves silently; Phase 7 established that reading the diff is the only way to catch it.
- All surviving user-facing copy is **Bahasa Indonesia**; `NotFoundError` messages are English.
- **Both guard tests live in `apps/web/src/test/`** — that directory holds **three** files; run the directory, not two by name.
- **Never a DOM node on either side of an assertion that can fail** — it has OOM-killed this machine.
- **Delete the guard your test names, and confirm that test fails.** Phase 7 produced eight tests that passed for the wrong reason, all the same shape: the setup made an *earlier, correct* guard fire.
- **NEVER background the api suite.** FOREGROUND, `timeout: 500000`. A backgrounded run does not wake a subagent — it parks and stalls the phase, which has happened to nine agents.
- Never run a dev server, bind a port, or drive a browser.

## What survives — the list to check yourself against

**API routes kept (7 mounts):** `/health`, `/auth`, `/payment-account`, `/streams`, `/users` (×3: users, posts, media), `/webhooks` (Xendit — **shared**), `/webhooks/mediamtx` (**shared**).

**API routes deleted (13 mounts):** `/ai`, `/c` (×2), `/communities` (×2), `/communities/:communityId/channels`, `/.../events`, `/.../join-requests`, `/.../members`, `/.../tiers`, `/streaming`.

**Web pages kept from `src/pages/`:** `LandingPage`, `NotFoundPage`. **Deleted:** `CheckoutPage`, `StatusPage`, `RequestStatusPage`, `WatchPage`.

**Worker passes kept:** `processOutbox`, `processMembershipReminder`, `processMembershipSweep`, `processStalePendingSweep`, `processOrphanSweep`, `processUserStreamSweep`. **Deleted:** `processRenewals`, `processChurn`.

---

### Task 1: The dashboard SPA

**Files:**
- Delete: all of `apps/web/src/dashboard/`
- Delete: `apps/web/src/pages/{CheckoutPage,StatusPage,RequestStatusPage,WatchPage}.tsx` and their tests
- Modify: `apps/web/src/App.tsx`, `apps/web/src/api.ts`
- Test: `apps/web/src/App.test.tsx`

**Interfaces:**
- Produces: an `App.tsx` whose only routes are the new world's, plus `/` and the not-found fallback.

**`LandingPage` and `NotFoundPage` STAY.** The landing page is the app's front door and carries the new app's entry points (parent spec §10). Deleting `src/pages/` wholesale takes both — delete the four files by name.

- [ ] **Step 1: Write the failing test**

```tsx
test("the old dashboard routes are gone — /dashboard falls through to not-found", async () => {
  renderAt("/dashboard");
  expect((await screen.findByTestId("not-found")).textContent).toContain("Halaman tidak ditemukan");
});

test("the landing page still renders at /", async () => {
  renderAt("/");
  expect(document.body.textContent).toContain("DIUDARA");
});
```

The second test is the one that matters: it fails loudly if the deletion takes `LandingPage` with it.

- [ ] **Step 2: Run, watch it fail**

Run: `cd apps/web && bun test App.test.tsx`
Expected: FAIL — `/dashboard` still renders the old shell.

- [ ] **Step 3: Delete, and unwire**

`git rm -r apps/web/src/dashboard` and the four named page files. Remove their routes and imports from `App.tsx`, and any old-world function from `api.ts` that no surviving file calls.

- [ ] **Step 4: Run the web suite and typecheck**

Run: `cd apps/web && bun test && bunx tsc --noEmit`
The count will fall by hundreds. That is expected — the signal is **zero failures and no dangling import**.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore(web): delete the creator dashboard"
```

---

### Task 2: Telegram and channels

**Files:**
- Delete: `apps/api/src/infrastructure/messaging/telegram-bot.adapter.ts`, `telegram-webhook-payload.ts`
- Delete: `apps/api/src/routes/{channels,join-requests}.ts`
- Delete: use cases `grant-channel-access`, `revoke-channel-access`, `manage-channels`, `record-channel-join`, `decide-join-request`, `notify-join-request`
- Delete: ports `channel-repository`, `channel-membership-repository`, `join-request-repository`, `join-request-unit-of-work`; and their drizzle repositories
- Modify: `apps/api/src/app.ts`, `apps/api/src/bootstrap.ts`, `apps/api/src/bootstrap.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a container with no channel or join-request dependencies.

**The outbox handlers go with them.** `notify_join_request` is registered against `ProcessOutbox`; removing the use case without removing its registration leaves a handler that throws on a row nothing writes any more.

- [ ] **Step 1: Write the failing test**

```ts
test("the container wires no channel or join-request dependency", () => {
  const deps = Object.keys(buildContainer(fakeEnv()));
  expect(deps.filter((k) => /channel|joinRequest/i.test(k))).toEqual([]);
});

test("ProcessOutbox registers no notify_join_request handler", () => {
  expect(Object.keys(outboxHandlers())).not.toContain("notify_join_request");
});
```

- [ ] **Step 2: Run, watch fail. Step 3: delete and unwire. Step 4: run the api suite FOREGROUND, `timeout: 500000`**

- [ ] **Step 5: Confirm `db:generate` is silent, then commit**

```bash
cd apps/api && bun run db:generate   # must print no new migration
git add -A && git commit -m "chore(api): delete the Telegram and channel machinery"
```

---

### Task 3: The old streaming stack

**Files:**
- Delete: use cases `schedule-live-session`, `notify-stream-live`, `handle-stream-lifecycle`, `resolve-watch-token`
- Delete: `apps/api/src/domain/watch-token.ts`, `apps/api/src/routes/{events,streaming}.ts`
- Delete: `drizzle-event.repository.ts`, `drizzle-stream-lifecycle.unit-of-work.ts`, `event-repository.port.ts`, `stream-lifecycle-unit-of-work.port.ts`
- Modify: `apps/api/src/app.ts`, `bootstrap.ts`, `routes/mediamtx-webhooks.ts`

**Interfaces:**
- Consumes: `parseStreamPath` and `EndUserStream` (Phase 7) — both stay.
- Produces: a lifecycle route that serves only the user world.

**`authorise-stream.ts` is NOT this task's** — it is Task 6. Here you remove the old world's *callers*; the authoriser's own `live/` branch comes out at the seam, with its own review.

The lifecycle route currently dispatches: `world === "user"` → `EndUserStream`, and **both** `null` and `world === "community"` → `handleStreamLifecycle`. With the community handler gone, decide what an unparseable key does and **pin it with a named test** — silently succeeding on a path that no longer resolves is how a broken hook looks healthy.

- [ ] **Step 1: Write the failing tests**

```ts
test("a community lifecycle hook is now refused, not silently handled", async () => {
  const res = await post("/webhooks/mediamtx/lifecycle", { hook: "offline", streamKey: "live/abc" });
  expect(res.status).toBe(404);
});

test("a user lifecycle hook still ends the stream", async () => { /* unchanged behaviour */ });
```

- [ ] **Step 2: Run, watch fail. Step 3: delete and unwire. Step 4: api suite FOREGROUND. Step 5: `db:generate` silent, commit**

```bash
git add -A && git commit -m "chore(api): delete the community streaming stack"
```

---

### Task 4: The old API — communities, tiers, members, money, courses, analytics, AI

**Files:**
- Delete these route files, verified to exist and to be exactly the old-world ones — **11 of the 20**:
  `ai.ts`, `analytics.ts`, `communities.ts`, `events.ts`, `memberships.ts`, `public-community.ts`,
  `public-subscription.ts`, `streaming.ts`, `tiers.ts` (plus `channels.ts` and `join-requests.ts`,
  already gone in Task 2).
  **The nine that survive**: `auth.ts`, `health.ts`, `media.ts`, `mediamtx-webhooks.ts`,
  `payment-account.ts`, `posts.ts`, `streams.ts`, `users.ts`, `webhooks.ts`.
  There is **no `checkout.ts`** — the community checkout lives in the `StartCheckout` use case, reached
  through `public-subscription.ts`; delete the use case, not a route that does not exist.
- Delete: their use cases, ports and drizzle repositories
- Delete: `apps/api/src/application/use-cases/{process-renewals,process-churn}.ts`
- Modify: `apps/api/src/app.ts`, `bootstrap.ts`, `bootstrap.test.ts`, `apps/worker/src/main.ts`, `apps/worker/src/scheduled-passes.ts`

**Interfaces:**
- Produces: `app.ts` with exactly the **seven** surviving mounts; a worker with **six** passes.

This is the biggest deletion and the least subtle. Work outside-in: routes, then use cases, then repositories, then ports, letting the typechecker name what is now unreachable.

- [ ] **Step 1: Write the failing tests**

```ts
test("exactly the surviving routes are mounted", () => {
  expect(mountedPaths().sort()).toEqual(
    ["/auth", "/health", "/payment-account", "/streams", "/users", "/webhooks", "/webhooks/mediamtx"]
  );
});

test("the worker runs exactly the surviving passes", () => {
  expect(passNames().sort()).toEqual([
    "membershipReminder", "membershipSweep", "orphanSweep",
    "outbox", "stalePendingSweep", "userStreamSweep",
  ]);
});
```

Both assert **exact sets**, not absences — a `not.toContain` check passes while something unexpected survives.

- [ ] **Step 2: Run, watch fail. Step 3: delete outside-in. Step 4: api + worker suites, FOREGROUND. Step 5: `db:generate` silent, commit**

```bash
git add -A && git commit -m "chore(api,worker): delete the community-scoped API and its passes"
```

---

### Task 5: Seam one — the Xendit webhook

**Files:**
- Modify: `apps/api/src/application/use-cases/handle-payment-webhook.ts` (664 lines)
- Modify: `apps/api/src/domain/user-payment.ts` (`routeInvoiceExternalId`)
- Test: their test files

**Interfaces:**
- Consumes: `USER_SUBSCRIPTION_EXTERNAL_ID_PREFIX = "usub_"`.
- Produces: a webhook serving one kind of subscription, and still ignoring everything else.

**This is the money path, and the rule survives its own second world.** With one kind left, the temptation is to treat "unrecognised prefix" as "must be the surviving kind". **That would activate a membership against a payment for something else.** The outcomes stay: **user**, and **ignored**.

Amount verification and replay idempotency must not move. `webhook_event` **stays** — it is shared and it is what makes a replay safe.

- [ ] **Step 1: Write the failing tests**

```ts
test("an UNRECOGNISED external_id is ignored, never treated as a user subscription", async () => {
  await handle({ external_id: "sub_123", status: "PAID", paid_amount: 50000 });
  expect(await countActivations()).toBe(0);
});

test("a usub_ invoice still activates exactly once on a replay", async () => { /* … */ });

test("a tampered amount is still refused", async () => { /* … */ });
```

- [ ] **Step 2: Run, watch fail. Step 3: remove the community branch only**

- [ ] **Step 4: Mutate and verify**

Make the unrecognised branch fall through to the user path and confirm the first test reddens. **If it does not, stop** — that is the defect this task exists to avoid.

- [ ] **Step 5: api suite FOREGROUND, `db:generate` silent, commit**

```bash
git add -A && git commit -m "refactor(api): the webhook serves one world, and still ignores the rest"
```

---

### Task 6: Seam two — the stream authoriser

**Files:**
- Modify: `apps/api/src/application/use-cases/authorise-stream.ts` (626 lines)
- Test: `authorise-stream.test.ts`

**Interfaces:**
- Consumes: `parseStreamPath(path) -> { world, key } | null`.
- Produces: an authoriser with one namespace.

**This file authorises every publish and every read.** Remove `live/` and `authoriseReadByEventId`, leaving `u/` alone in the allow-list.

**The allow-list stays an allow-list.** Phase 7 built it so an unrecognised prefix *refuses* rather than falling through, and its docstring records a real defect where a looser parser authorised a publish to a path the adapter never constructs. Collapsing to "anything that parses is a user stream" reopens exactly that.

- [ ] **Step 1: Write the failing tests**

```ts
test("live/<key> is no longer a namespace — refused, not resolved", () => {
  expect(parseStreamPath("live/abc")).toBeNull();
});

test("an unknown namespace is still refused, never assumed to be the surviving one", () => {
  expect(parseStreamPath("foo/abc")).toBeNull();
});

test("a bare key with no namespace is refused", () => {
  expect(parseStreamPath("abc")).toBeNull();
});
```

- [ ] **Step 2: Run, watch fail. Step 3: remove the community branch**

- [ ] **Step 4: Mutate and verify**

Make `parseStreamPath` return `{ world: "user", key }` for any two-segment path and confirm the second and third tests redden. Then confirm every Phase 7 user-world test still passes untouched.

- [ ] **Step 5: api suite FOREGROUND, `db:generate` silent, commit**

```bash
git add -A && git commit -m "refactor(api): one namespace, still an allow-list"
```

---

### Task 7: Seam three, and the two deferred cleanups

**Files:**
- Modify: `apps/api/src/application/use-cases/handle-payment-webhook.ts` (its `activity_log` writes)
- Rename: `PostEditUnitOfWorkPort` → `PostWriteUnitOfWorkPort`, its adapter, its tests and both call sites
- Modify: `apps/api/src/domain/user-watch-token.ts` (drop the duplication note now `watch-token.ts` is gone)

**`activity_log` itself is untouched** — the table stays this phase, so only its old-world writers go. Whether the new world should keep writing it belongs to the follow-up that drops the tables.

**The rename is why this is a task and not a footnote.** Phase 6 deferred it explicitly: `CreatePost` uses a port named `Edit`, and the fix "should be its own reviewable commit rather than buried in a fix diff at the tail of a phase." This is that commit.

**The HMAC duplication resolves by subtraction.** ~15 lines were carried deliberately so the module being deleted was never coupled to the one being built. `watch-token.ts` went in Task 3; now the docstring that explains the duplication is describing a world that no longer exists.

- [ ] **Step 1: Rename, mechanically**

The typechecker is the test: `bunx tsc --noEmit` must be green in all four workspaces, and **no test may reference the old name**.

- [ ] **Step 2: Fix the stale docstrings, naming what is now true**

- [ ] **Step 3: api suite FOREGROUND, `db:generate` silent, commit**

```bash
git add -A && git commit -m "refactor(api): a port named for what it does, and a duplication that is now just code"
```

---

### Task 8: The four flows, end to end

**Files:**
- Create: `apps/api/src/test/new-world-smoke.test.ts`

**Nothing was added this phase, so nothing new is under test — that is exactly the risk.** A deletion phase can leave every remaining test passing while a *flow* is broken at a seam nobody exercised end to end.

- [ ] **Step 1: Write the tests**

```ts
test("FLOW: a gated post reaches a member and not a stranger", async () => { /* … */ });
test("FLOW: a membership can be bought and activates on its webhook", async () => { /* … */ });
test("FLOW: a creator goes live, a member watches, the stream ends", async () => { /* … */ });
test("FLOW: every surviving worker pass runs without throwing", async () => { /* … */ });
```

Each walks the real use cases against the real database, as the existing route tests do.

- [ ] **Step 2: Run. They should PASS immediately** — that is the point; they are a net, not a red-green cycle. If one fails, a seam is broken and that is the finding.

- [ ] **Step 3: Mutate each seam and confirm the matching flow reddens.** A smoke test that passes against a broken seam is worse than none.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "test(api): the four flows the deletion could have broken"
```

---

### Task 9: The gate checklist

**Files:**
- Create: `docs/superpowers/sdd/2026-08-23-retire-telegram/gate-checklist.md`

Written by the controller, run by the owner. What no suite here can prove:

- [ ] The deployed app serves `/` and the new world; `/dashboard` is gone rather than broken.
- [ ] A real Xendit webhook for a **user** subscription still activates it.
- [ ] Streaming still works after `live/` was removed from the authoriser.
- [ ] The worker starts and its six passes run.
- [ ] **`bun run db:generate` on the deploy box produces no migration** — the tables are still there and still match.

---

## Self-Review

**Spec coverage.** §4's four groups → Tasks 1–4. §5.1 → Task 5. §5.2 → Task 6. §5.3 → Task 7. §6's two cleanups → Task 7. §7's order → the task order. §8's evidence → Global Constraints plus Task 8. §9 out of scope → respected: no table is dropped, `schema.ts` is untouched, no `creator` row is migrated.

**Type consistency.** `parseStreamPath` (Task 6) keeps the Phase 7 signature. `PostEditUnitOfWorkPort` → `PostWriteUnitOfWorkPort` is named identically in Task 7's rename and nowhere else. The surviving route list in Task 4's test matches the "What survives" table above, and the pass list matches it too.

**A note on the shape of this plan.** Every other phase's tasks *added* behaviour, so their tests could fail first and pass after. Most of these tasks delete, so their tests assert an **absence** — which is why Tasks 4 and 6 assert exact sets rather than `not.toContain`, and why Task 8 exists at all.
